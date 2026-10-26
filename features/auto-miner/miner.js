// Auto miner core. Stationary mining of all reachable target blocks with
// smooth camera motion ("ping glide") and a
// walk-home controller when the player is pushed.
//
// Vanilla does the mining: the miner only aims the camera and holds the attack
// binding. The first break of a run is started with the same
// MultiPlayerGameMode.startDestroyBlock call vanilla's startAttack uses (queued
// key clicks are unreliable here). Damage progress, swings, cooldowns and
// packets stay with vanilla.
//
// createMiner(deps) returns an independent instance. deps:
//   T        Minecraft classes (see world.js)
//   game()   the Minecraft instance
//   now()    seconds (monotonic)
//   inGui()  whether a screen is open
//   glide()  camera glide factor, 0.25..2
//   onStart()                 mining began after start()
//   onHalt(reason, { refused, silent })  the miner stopped itself
// Lifecycle: start() arms it; once no screen has been open for ARM_TICKS ticks
// the start checks run and mining begins (or onHalt(refused) explains why not).
const G = require("./geometry");
const recovery = require("./recovery");
const { createWorld } = require("./world");

const MOVEMENT_KEYS = ["keyUp", "keyDown", "keyLeft", "keyRight", "keyJump", "keyShift"];
const ARM_TICKS = 2;          // screen-free ticks before starting (lets chat finish closing)
const SCAN_INTERVAL = 0.05;   // s between scans while no target is selected
const PLAN_INTERVAL = 0.2;    // s between successor plans
const PING_INTERVAL = 1;      // s between latency samples
const START_RETRY = 0.5;      // s between native start attempts
const AIM_TIMEOUT = 0.7;      // s without aim progress before a target is dropped
const STALL_MIN = 0.8;        // s minimum crack-stage watchdog
const STALL_STAGES = 2;       // crack stages without progress before a break counts as stalled
const RETRY_COOLDOWN = 0.15;  // s before an abandoned position is retried
const HOME_DRIFT = 0.06;      // horizontal blocks from home that count as being pushed
const HOME_HEIGHT = 0.1;
const EXIT_MARGIN = 0.88;     // fraction of the in-silhouette path used by pre-glide
const IDLE_PITCH = 68;
const DRIFT_AMOUNT = 0.026;   // blocks of aim-point drift at glide 1
const TICK_SECONDS = 0.05;

const vector = v => ({ x: v.x, y: v.y, z: v.z });
const blockKey = pos => pos.x + "," + pos.y + "," + pos.z;

function createMiner(deps) {
  const T = deps.T;
  const W = createWorld(T);
  const now = deps.now;
  const glide = () => {
    const g = deps.glide();
    return typeof g === "number" && isFinite(g) && g > 0 ? g : 1;
  };

  let phase = "off"; // off | arming | running
  let activity = "off";
  let status = "Off";
  let armTicks = 0;
  let anchor = null;
  let target = null;
  let nextTarget = null;
  const yaw = { value: 0, velocity: 0 };
  const pitch = { value: 0, velocity: 0 };
  let lastFrame = 0;
  let nextScan = 0;
  let nextPing = 0;
  let nextPlan = 0;
  let pingMs = 0;
  let expectedTicks = 0;
  let toolSpeed = 0;
  let progressPerTick = 0;
  let stage = -1;
  let cleared = 0;
  let attackOwned = false;
  let rec = null;
  let focusPauseBefore = null;
  let lastInput = "no mining tick observed";
  const movementOwned = new Set();
  const cooldowns = new Map();
  const minedOrder = new Map();
  const awaitingReset = new Map();
  const startup = { needed: true, lastAttempt: -Infinity, attempts: 0, result: "not attempted" };
  const packets = { start: 0, abort: 0, stop: 0 };

  function setStatus(kind, text) { activity = kind; status = text; }

  // ---------- owned input ----------

  function releaseAttack(game) {
    if (!attackOwned) return;
    attackOwned = false;
    game.options.keyAttack.setDown(false);
    if (game.gameMode) game.gameMode.stopDestroyBlock();
  }

  const movement = {
    release() {
      const options = deps.game().options;
      movementOwned.forEach(name => options[name].setDown(false));
      movementOwned.clear();
    },
    hold(names) {
      movement.release();
      const options = deps.game().options;
      names.forEach(name => { options[name].setDown(true); movementOwned.add(name); });
    },
  };

  // Vanilla's continueAttack requires a grabbed mouse even with attack held. A
  // physical click normally repairs it; never grab while another app is focused.
  function ensureMouseCapture(game) {
    if (game.isWindowActive() && !game.mouseHandler.isMouseGrabbed()) game.mouseHandler.grabMouse();
  }

  function markStarted(time) {
    startup.needed = false;
    if (target.started) return;
    target.started = true;
    target.lastProgress = time;
    if (!target.miningSince) target.miningSince = time;
  }

  function beginMining(game, time) {
    if (!startup.needed || time - startup.lastAttempt < START_RETRY) return;
    startup.lastAttempt = time;
    startup.attempts++;
    const accepted = game.gameMode.startDestroyBlock(target.pos, game.hitResult.getDirection());
    startup.result = accepted ? "accepted" : "rejected";
    if (accepted) game.player.swing(T.InteractionHand.MAIN_HAND);
    if (game.gameMode.isDestroying()) markStarted(time);
  }

  // ---------- run state ----------

  function movementPressed(game) {
    const options = game.options;
    return MOVEMENT_KEYS.some(name => options[name].isDown() && !movementOwned.has(name));
  }

  function canRun(game) {
    if (!game.player || !game.level || !game.gameMode) return false;
    if (deps.inGui() || game.isPaused()) return false;
    const p = game.player;
    return p.isAlive() && !p.isPassenger() && !p.isUsingItem() && !game.gameMode.isSpectator() &&
      !movementPressed(game) && !game.options.keyUse.isDown();
  }

  function displaced(player) {
    return G.hypot(player.getX() - anchor.x, player.getZ() - anchor.z) > HOME_DRIFT ||
      Math.abs(player.getY() - anchor.y) > HOME_HEIGHT;
  }

  function refusalReason(game) {
    if (!canRun(game) || !game.player.onGround()) return "Stand still on solid ground, close screens, and release movement keys first.";
    if (game.options.keyAttack.isDown()) return "Release your attack key first.";
    if (!W.selectPickaxe(game.player)) return "Put a pickaxe with at least 2 durability remaining in your hotbar.";
    return null;
  }

  function start() {
    if (phase !== "off") return false;
    phase = "arming";
    armTicks = 0;
    setStatus("starting", "Starting");
    return true;
  }

  // Releases everything the miner owns. Returns false when it was not active.
  function stop(reason) {
    if (phase === "off") return false;
    phase = "off";
    const game = deps.game();
    releaseAttack(game);
    movement.release();
    target = null;
    nextTarget = null;
    anchor = null;
    rec = null;
    if (focusPauseBefore !== null) {
      game.options.pauseOnLostFocus = focusPauseBefore;
      focusPauseBefore = null;
    }
    setStatus("off", reason || "Off");
    return true;
  }

  function halt(reason, opts) {
    if (stop(reason)) deps.onHalt(reason, opts || {});
  }

  function activate(game) {
    const refusal = refusalReason(game);
    if (refusal) return halt(refusal, { refused: true });
    const p = game.player;
    const time = now();
    anchor = { x: p.getX(), y: p.getY(), z: p.getZ(),
      supportY: Math.floor(p.getY() - 0.01), idleYaw: p.getYRot() };
    yaw.value = p.getYRot(); yaw.velocity = 0;
    pitch.value = p.getXRot(); pitch.velocity = 0;
    target = null;
    nextTarget = null;
    cooldowns.clear();
    minedOrder.clear();
    awaitingReset.clear();
    cleared = 0;
    expectedTicks = 0;
    toolSpeed = 0;
    progressPerTick = 0;
    stage = -1;
    nextPlan = 0;
    nextScan = 0;
    nextPing = 0;
    lastFrame = time;
    rec = null;
    startup.needed = true;
    startup.lastAttempt = -Infinity;
    startup.attempts = 0;
    startup.result = "not attempted";
    packets.start = packets.abort = packets.stop = 0;
    lastInput = "no mining tick observed";
    // Alt-tab must not pause the game mid-run; restored by stop().
    focusPauseBefore = game.options.pauseOnLostFocus;
    game.options.pauseOnLostFocus = false;
    phase = "running";
    setStatus("scanning", "Scanning");
    if (deps.onStart) deps.onStart();
  }

  // ---------- targets ----------
  //
  // Unmined positions first, then least recently mined. Within that group,
  // prefer a short camera turn with a small distance cost. Regenerating nearby
  // blocks cannot starve the rest of the reachable field.

  function findTarget(game, time, excluded) {
    const box = game.player.getBoundingBox();
    const eye = vector(game.player.getEyePosition());
    const candidates = [];
    for (const block of G.reachBlocks(eye, game.player.blockInteractionRange())) {
      if (G.supportsFeet(block, anchor.supportY, box)) continue;
      const id = blockKey(block);
      const pos = W.blockPos(block.x, block.y, block.z);
      const eligible = W.isTarget(game, pos);
      // A completion packet can precede the server's replacement. Wait until
      // that intermediate block is seen; the deadline handles missed updates.
      if (!eligible) awaitingReset.delete(id);
      if (!eligible || id === excluded || (cooldowns.get(id) || 0) > time || (awaitingReset.get(id) || 0) > time) continue;
      const dx = block.x + 0.5 - eye.x;
      const dy = block.y + 0.5 - eye.y;
      const dz = block.z + 0.5 - eye.z;
      const distance = dx * dx + dy * dy + dz * dz;
      const look = G.angles(eye, { x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.5 });
      const turn = G.hypot(G.wrap(look.yaw - yaw.value), look.pitch - pitch.value);
      candidates.push({ pos, id, order: minedOrder.get(id) || 0, score: turn + Math.sqrt(distance) * 4 });
    }
    candidates.sort((a, b) => a.order - b.order || a.score - b.score || a.id.localeCompare(b.id));
    let picked = null;
    for (const candidate of candidates) {
      const point = W.visiblePoint(game, candidate.pos);
      if (point) { picked = { pos: candidate.pos, id: candidate.id, point }; break; }
    }
    if (!picked) return null;
    return {
      pos: picked.pos, point: picked.point, id: picked.id, acquired: time, miningSince: 0, started: false,
      completed: false, lastStage: -1, lastProgress: time, aimError: Infinity, lastAimProgress: time, exitLook: null,
    };
  }

  function selectTarget(game, time) {
    // Rescan at handoff: the completed break may have exposed another block.
    target = findTarget(game, time, null);
    nextTarget = null;
    nextPlan = 0;
    stage = -1;
    if (target) setStatus("gliding", "Gliding");
    else setStatus("waiting", "Waiting for reachable blocks");
    nextScan = time + SCAN_INTERVAL;
  }

  function retireTarget(game, time, completed) {
    if (target) {
      if (completed) {
        cleared++;
        minedOrder.set(target.id, cleared);
        if (W.isTarget(game, target.pos)) awaitingReset.set(target.id, time + 2 + pingMs / 1000);
      }
      cooldowns.set(target.id, time + (completed ? Math.max(0.05, pingMs / 1000 + 0.05) : RETRY_COOLDOWN));
    }
    releaseAttack(game);
    selectTarget(game, time);
  }

  function refreshTarget(game, time, checkVisibility) {
    if (target && (target.completed || !W.isTarget(game, target.pos))) {
      retireTarget(game, time, target.completed || target.miningSince > 0);
    }
    if (!target && time >= nextScan) selectTarget(game, time);
    if (!target || !checkVisibility) return;
    const point = W.visiblePoint(game, target.pos);
    if (!point) {
      // A replacement block can hide the old face; drop it instead of staring at it.
      retireTarget(game, time, false);
      return;
    }
    if (point.x !== target.point.x || point.y !== target.point.y || point.z !== target.point.z) nextPlan = 0;
    target.point = point;
  }

  // Furthest look along from -> to that still hits the current target, so the
  // camera can lead toward the successor without leaving the block (which would
  // abort the break). Samples the path, then bisects the edge.
  function safeLook(game, from, to) {
    const dy = G.wrap(to.yaw - from.yaw);
    const dp = to.pitch - from.pitch;
    const onTarget = t => W.hits(W.rayAt(game, { yaw: from.yaw + dy * t, pitch: from.pitch + dp * t }), target.pos);
    let low = 0;
    let high = 1;
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      if (!onTarget(t)) { high = t; break; }
      low = t;
    }
    if (low < 1) {
      for (let i = 0; i < 6; i++) {
        const t = (low + high) / 2;
        if (onTarget(t)) low = t;
        else high = t;
      }
    }
    const t = low * EXIT_MARGIN;
    return { yaw: from.yaw + dy * t, pitch: from.pitch + dp * t };
  }

  function planNext(game, time) {
    if (!target || time < nextPlan) return;
    nextPlan = time + PLAN_INTERVAL;
    nextTarget = findTarget(game, time, target.id);
    const eye = vector(game.player.getEyePosition());
    target.exitLook = nextTarget ? safeLook(game, G.angles(eye, target.point), G.angles(eye, nextTarget.point)) : null;
  }

  function updatePing(game, time) {
    if (time < nextPing) return;
    nextPing = time + PING_INTERVAL;
    const measured = W.latency(game);
    pingMs = pingMs === 0 ? measured : pingMs * 0.65 + measured * 0.35;
  }

  // ---------- walk home ----------

  function beginReturn(game, time) {
    releaseAttack(game);
    target = null;
    nextTarget = null;
    startup.needed = true;
    startup.lastAttempt = -Infinity;
    rec = recovery.begin(game.player, time);
    setStatus("returning", "Returning to start");
  }

  function walkHome(game, time) {
    if (!rec) beginReturn(game, time);
    const result = recovery.update(game, time, anchor, rec, movement, W);
    if (result.failure) return halt(result.failure);
    if (result.done) {
      rec = null;
      nextScan = 0;
      lastFrame = time;
      setStatus("scanning", "Scanning");
      return;
    }
    setStatus("returning", result.status);
  }

  // ---------- per tick: targets, attack, watchdogs ----------

  function runTick(game) {
    if (!canRun(game)) return halt("Manual input, screen, or player state changed");
    if (!W.holdsPickaxe(game.player)) {
      releaseAttack(game);
      if (!W.selectPickaxe(game.player)) return halt("No usable pickaxe in hotbar");
      startup.needed = true;
      startup.lastAttempt = -Infinity;
      if (target) { target.started = false; target.lastStage = -1; target.lastProgress = now(); }
    }
    const time = now();
    if (rec || displaced(game.player) || !game.player.onGround()) return walkHome(game, time);
    updatePing(game, time);
    refreshTarget(game, time, true);
    if (!target) return releaseAttack(game);

    const blockState = game.level.getBlockState(target.pos);
    toolSpeed = game.player.getDestroySpeed(blockState);
    progressPerTick = blockState.getDestroyProgress(game.player, game.level, target.pos);
    expectedTicks = G.miningTicks(progressPerTick);
    if (!isFinite(expectedTicks)) return retireTarget(game, time, false);

    if (attackOwned && game.gameMode.isDestroying()) markStarted(time);
    stage = target.started ? game.gameMode.getDestroyStage() : -1;
    if (stage > target.lastStage) { target.lastStage = stage; target.lastProgress = time; }
    // Only real cracking feeds the watchdog, not merely holding attack.
    const stallLimit = Math.max(STALL_MIN, STALL_STAGES * expectedTicks * TICK_SECONDS / 10 + pingMs / 1000);
    if (target.started && time - target.lastProgress > stallLimit) return retireTarget(game, time, false);

    planNext(game, time);
    const desired = G.angles(vector(game.player.getEyePosition()), target.point);
    const error = Math.abs(G.wrap(desired.yaw - yaw.value)) + Math.abs(desired.pitch - pitch.value);
    if (error < target.aimError - 0.2) { target.aimError = error; target.lastAimProgress = time; }

    // Both the real crosshair and a fresh camera ray must hit the selected block.
    // Vanilla advances destroy progress once per tick; calling
    // continueDestroyBlock here would double-count.
    if (W.hits(game.hitResult, target.pos) && W.hits(W.cameraRay(game), target.pos) && W.inReach(game, game.hitResult)) {
      ensureMouseCapture(game);
      game.options.keyAttack.setDown(true);
      attackOwned = true;
      beginMining(game, time);
      if (target.completed || !W.isTarget(game, target.pos)) {
        // An instant break must not leave attack held over its replacement.
        releaseAttack(game);
        return;
      }
      target.lastAimProgress = time;
      if (!target.started) {
        if (startup.result === "rejected") setStatus("rejected", "Mining start rejected");
        else setStatus("starting", "Starting mining");
      } else if (target.exitLook && G.glideWeight(stage, progressPerTick, pingMs) > 0) setStatus("mining", "Pre-gliding");
      else setStatus("mining", "Mining");
    } else {
      releaseAttack(game);
      if (time - target.lastAimProgress > AIM_TIMEOUT) return retireTarget(game, time, false);
      setStatus("gliding", "Gliding");
    }
  }

  function tick() {
    if (phase === "off") return;
    const game = deps.game();
    if (phase === "arming") {
      if (deps.inGui() || !game.player || !game.level) {
        armTicks = 0;
        setStatus("starting", "Starts when this screen closes");
        return;
      }
      if (++armTicks >= ARM_TICKS) activate(game);
      return;
    }
    runTick(game);
    // Kept after stopping: typing /am debug opens chat, which stops the miner.
    if (phase === "running") {
      lastInput = "destroying=" + game.gameMode.isDestroying() + " | stage=" + stage +
        " | attack=" + game.options.keyAttack.isDown() + " | mouse grabbed=" + game.mouseHandler.isMouseGrabbed() +
        " | focused=" + game.isWindowActive();
    }
  }

  // ---------- per frame: camera ----------

  function frame() {
    if (phase !== "running") return;
    const game = deps.game();
    if (!canRun(game)) return halt("Manual input, screen, or player state changed");
    if (!W.holdsPickaxe(game.player)) releaseAttack(game);
    const time = now();
    if (!rec && (displaced(game.player) || !game.player.onGround())) beginReturn(game, time);
    if (rec) {
      // Steering depends on the current yaw; keep the camera still until home.
      lastFrame = time;
      return;
    }
    // A STOP_DESTROY_BLOCK packet is enough to hand off, even before the server's
    // replacement block arrives.
    refreshTarget(game, time, false);
    stage = target && target.started ? game.gameMode.getDestroyStage() : -1;
    const dt = G.clamp(time - lastFrame, 0, 0.1);
    lastFrame = time;
    const g = glide();
    const eye = vector(game.player.getEyePosition());
    let look;
    if (target) {
      // Slow drift across the chosen face; spring velocity carries across retargets.
      const amount = DRIFT_AMOUNT * g;
      const point = {
        x: G.clamp(target.point.x + amount * Math.sin(time * 1.73), target.pos.getX() + 0.01, target.pos.getX() + 0.99),
        y: G.clamp(target.point.y + amount * 0.35 * Math.sin(time * 1.19 + 1.2), target.pos.getY() + 0.01, target.pos.getY() + 0.99),
        z: G.clamp(target.point.z + amount * Math.cos(time * 1.41), target.pos.getZ() + 0.01, target.pos.getZ() + 0.99),
      };
      look = G.angles(eye, point);
      if (target.started && target.exitLook) {
        // Ping glide: lead toward the successor during the final ticks of the break.
        const weight = G.glideWeight(stage, progressPerTick, pingMs);
        look.yaw += G.wrap(target.exitLook.yaw - look.yaw) * weight;
        look.pitch += (target.exitLook.pitch - look.pitch) * weight;
      }
    } else {
      look = {
        yaw: anchor.idleYaw + 1.1 * g * Math.sin(time * 0.71),
        pitch: IDLE_PITCH + 0.7 * g * Math.sin(time * 0.93 + 1),
      };
    }
    const response = G.clamp(13 - pingMs / 180 + (expectedTicks > 0 && expectedTicks <= 3 ? 2 : 0), 7, 15);
    const speed = 155 / g;
    G.spring(yaw, yaw.value + G.wrap(look.yaw - yaw.value), dt, response, speed, 700);
    G.spring(pitch, G.clamp(look.pitch, -89.5, 89.5), dt, response, speed, 600);
    pitch.value = G.clamp(pitch.value, -89.5, 89.5);
    if (target && attackOwned && target.started && !W.hits(W.rayAt(game, { yaw: yaw.value, pitch: pitch.value }), target.pos)) {
      // Never let the spring overshoot off a block that is still breaking.
      const safe = safeLook(game, G.angles(eye, target.point), { yaw: yaw.value, pitch: pitch.value });
      yaw.value += G.wrap(safe.yaw - yaw.value);
      pitch.value = safe.pitch;
      yaw.velocity *= 0.5;
      pitch.velocity *= 0.5;
    }
    game.player.setYRot(yaw.value);
    game.player.setXRot(pitch.value);
    // Release between ticks if drift or a transition leaves the target's silhouette.
    if (attackOwned && (!target || !W.hits(W.cameraRay(game), target.pos))) releaseAttack(game);
  }

  // ---------- events ----------

  // Read-only observer of vanilla's ServerboundPlayerActionPacket. No world access here.
  function onPacketSent(packet, event) {
    if (phase !== "running" || !target || (event && event.isCancelled())) return;
    if (!packet.getPos().equals(target.pos)) return;
    const action = packet.getAction();
    if (action === T.PlayerAction.START_DESTROY_BLOCK) {
      packets.start++;
      startup.needed = false;
      target.started = true;
      target.miningSince = now();
      target.lastProgress = now();
      target.lastStage = -1;
    } else if (action === T.PlayerAction.STOP_DESTROY_BLOCK) {
      packets.stop++;
      target.completed = true;
    } else if (action === T.PlayerAction.ABORT_DESTROY_BLOCK) {
      packets.abort++;
      startup.needed = true;
      target.started = false;
      target.lastStage = -1;
      stage = -1;
    }
  }

  function onScreenOpened() {
    if (phase === "running") halt("Screen opened");
  }

  // ---------- inspection ----------

  function state() {
    return {
      phase, running: phase === "running", activity, status, stage,
      returning: rec !== null,
      homeX: anchor ? anchor.x : null,
      homeZ: anchor ? anchor.z : null,
      target: target ? target.id : null,
      next: nextTarget ? nextTarget.id : null,
      started: target ? target.started : false,
      weight: G.glideWeight(stage, progressPerTick, pingMs),
      yaw: yaw.value, pitch: pitch.value,
      pingMs, leadTicks: G.leadTicks(pingMs), expectedTicks, toolSpeed, cleared,
      startAttempts: startup.attempts, startResult: startup.result,
      packets: { start: packets.start, abort: packets.abort, stop: packets.stop },
      lastInput,
    };
  }

  return { start, stop, tick, frame, onPacketSent, onScreenOpened, state };
}

module.exports = { createMiner, ARM_TICKS };
