// Tick-driven automation with frame-smoothed camera motion. No CT globals:
// game, route, settings, clock and lifecycle notifications are injected.
const G = require("./geometry");
const { createWorld } = require("./world");

const INPUTS = ["keyUp", "keyDown", "keyLeft", "keyRight", "keyJump", "keySprint", "keyAttack"];
const ARRIVAL = 0.6;
const BRAKE_DISTANCE = 2;
const STUCK_SECONDS = 15;
const NO_PROGRESS = "No movement; retrying the waypoint.";

function createFarmer(deps) {
  const W = createWorld(deps.T);
  const owned = new Map();
  let phase = "off", status = "Off";
  let route = null, target = 0, laps = 0;
  let activeGame = null, activePlayer = null, activeLevel = null;
  let inventory = null, oldSlot = -1, hoeSlot = -1;
  let lastFrame = 0, sweep = 0, sweepWidth = 0, lastJump = -Infinity;
  let bestDistance = Infinity, lastProgress = 0, airborneSince = null, previous = null;
  let jumpHeld = false, heading = 0, legHeading = 0;
  let legStart = null;
  let terrainPitch = 0, lowerAimUntil = 0;
  let suspended = false, waitReason = null, waitSince = 0;
  let lastTick = 0, runTime = 0;

  function writeBinding(binding, down) {
    if (binding.isDown() === down) return;
    binding.setDown(down);
    // Sprint can be a ToggleKeyMapping; releasing it requires a toggle press.
    if (!down && binding.isDown()) binding.setDown(true);
  }

  function setInput(game, name, down) {
    if (down) {
      const binding = game.options[name];
      if (!binding.isDown() || owned.has(name)) owned.set(name, binding);
      writeBinding(binding, true);
    } else if (owned.has(name)) {
      writeBinding(owned.get(name), false);
      owned.delete(name);
    }
  }

  function releaseInputs() {
    let error = null;
    owned.forEach(binding => { try { writeBinding(binding, false); } catch (e) { error = e; } });
    owned.clear();
    try { if (activeGame && activeGame.gameMode) activeGame.gameMode.stopDestroyBlock(); } catch (e) { error = e; }
    jumpHeld = false;
    if (error) throw error;
  }

  function release() {
    // Keep the original bindings: player/level may already be null on unload.
    let error = null;
    try { releaseInputs(); } catch (e) { error = e; }
    try {
      if (inventory && inventory.getSelectedSlot() === hoeSlot && oldSlot >= 0) inventory.setSelectedSlot(oldSlot);
    } catch (e) { error = e; }
    inventory = null;
    activeGame = activePlayer = activeLevel = null;
    if (error) throw error;
  }

  function stop(reason) {
    if (phase === "off") return false;
    phase = "off";
    status = reason || "Off";
    route = null;
    jumpHeld = false;
    release();
    return true;
  }

  function halt(reason) {
    if (stop(reason)) deps.onHalt(reason);
  }

  function start() {
    if (phase !== "off") return false;
    phase = "arming";
    suspended = false;
    waitReason = null;
    runTime = 0;
    lastTick = deps.now();
    status = "Starts when this screen closes";
    return true;
  }

  function activate(game, now) {
    const saved = deps.route();
    if (saved.points.length < 2) return halt("Add at least two waypoints with /af add.");
    if (saved.context !== deps.context()) return halt("This route belongs to another world or dimension.");
    if (!game.player.onGround()) { status = "Waiting to land before starting"; return; }
    if (INPUTS.filter(name => name !== "keySprint").concat(["keyUse", "keyShift"]).some(name => game.options[name].isDown())) {
      status = "Release movement, attack and use keys to start";
      return;
    }
    activeGame = game;
    activePlayer = game.player;
    activeLevel = game.level;
    inventory = game.player.getInventory();
    oldSlot = inventory.getSelectedSlot();
    if (!W.selectHoe(game.player)) return halt("Put a hoe with at least 2 durability remaining in your hotbar.");
    hoeSlot = inventory.getSelectedSlot();
    route = saved;
    target = laps = 0;
    sweep = sweepWidth = 0;
    heading = game.player.getYRot();
    terrainPitch = deps.setting("pitch");
    lowerAimUntil = 0;
    legHeading = heading;
    setLegHeading({ x: game.player.getX(), y: game.player.getY(), z: game.player.getZ() });
    bestDistance = Infinity;
    lastProgress = now;
    lastFrame = deps.now();
    lastJump = -Infinity;
    airborneSince = null;
    previous = { x: game.player.getX(), y: game.player.getY(), z: game.player.getZ() };
    phase = "running";
    status = "Waypoint 1 / " + route.points.length;
    if (deps.onStart) deps.onStart();
  }

  function invalid(game) {
    if (!game || !game.player || !game.level || !game.gameMode) return "World unavailable.";
    if (!game.player.isAlive()) return "Player died.";
    if (game.gameMode.isSpectator()) return "Cannot farm in spectator mode.";
    if (game.player.isInLava()) return "Entered lava.";
    return null;
  }

  // Temporary interruptions release only synthetic input. Keep the route,
  // selected tool and feature enabled so a cleared interruption can resume.
  function wait(reason, now, timeout) {
    if (!suspended) releaseInputs();
    suspended = true;
    if (waitReason !== reason) { waitReason = reason; waitSince = now; }
    status = "Waiting: " + reason;
    if (now - waitSince >= timeout) halt(reason + " Still unable to continue.");
  }

  function resume(now, position) {
    if (!suspended) return;
    suspended = false;
    waitReason = null;
    previous = position;
    bestDistance = Infinity;
    lastProgress = now;
    lastFrame = deps.now();
  }

  // A server correction can rewind across a waypoint/corner. Rejoin the
  // nearest walkable route leg; never count the correction as walking through
  // a waypoint. Prefer the current leg when several segments meet or cross.
  function rejoin(position, now) {
    let leg = -1, nearest = Infinity, start = null;
    function consider(from, i) {
      const to = route.points[i];
      const dx = to.x - from.x, dz = to.z - from.z;
      const size = dx * dx + dz * dz;
      const t = size < 0.000001 ? 0 : G.clamp(((position.x - from.x) * dx + (position.z - from.z) * dz) / size, 0, 1);
      if (Math.abs(position.y - (from.y + (to.y - from.y) * t)) > 2) return;
      const distance = G.segmentDistance(position, from, to);
      if (distance <= 3 && distance < nearest - 0.05) { nearest = distance; leg = i; start = from; }
    }
    // The first approach can begin away from the saved loop itself.
    consider(legStart, target);
    for (let offset = 0; offset < route.points.length; offset++) {
      const i = (target + offset) % route.points.length;
      consider(route.points[(i + route.points.length - 1) % route.points.length], i);
    }
    if (leg < 0) return false;
    target = leg;
    setLegHeading(start);
    bestDistance = Infinity;
    lastProgress = now;
    airborneSince = null;
    return true;
  }

  function setLegHeading(from) {
    legStart = from;
    const goal = route.points[target];
    const dx = goal.x - from.x, dz = goal.z - from.z;
    if (G.length(dx, dz) > 0.001) legHeading = G.bearing(dx, dz);
  }

  function move(game, jumping) {
    const p = game.player, goal = route.points[target];
    const names = G.steering(goal.x - p.getX(), goal.z - p.getZ(), p.getYRot());
    ["keyUp", "keyDown", "keyLeft", "keyRight"].forEach(name => setInput(game, name, names.indexOf(name) >= 0));
    const nearWaypoint = G.length(goal.x - p.getX(), goal.z - p.getZ()) < BRAKE_DISTANCE;
    setInput(game, "keySprint", deps.setting("sprint") && !nearWaypoint && names.indexOf("keyUp") >= 0);
    // Releasing the sprint binding alone does not cancel vanilla's sprint latch.
    if (nearWaypoint && p.isSprinting()) p.setSprinting(false);
    setInput(game, "keyJump", jumping);
    return G.travel(names, p.getYRot());
  }

  function tick() {
    if (phase === "off") return;
    const game = deps.game(), clock = deps.now();
    // A stalled client contributes at most two ticks to watchdogs. The gap
    // itself is not evidence that movement or recovery has failed.
    runTime += G.clamp(clock - lastTick, 0, 0.1);
    lastTick = clock;
    const now = runTime;
    if (phase === "arming" && deps.inGui()) return;
    if (phase === "running" && deps.inGui()) return halt("Screen opened.");
    const problem = invalid(game);
    if (problem) return halt(problem);
    if (phase === "running" && (game.player !== activePlayer || game.level !== activeLevel)) return halt("World changed.");
    if (phase === "running" && deps.context() !== route.context) return halt("World or dimension changed.");
    if (game.isPaused()) return wait("Game paused.", now, Infinity);
    if (game.player.isPassenger()) return wait("Player is riding.", now, Infinity);
    if (game.player.isUsingItem()) return wait("Player is using an item.", now, Infinity);
    if (game.player.isInWater()) return wait("Entered water.", now, Infinity);
    if (phase === "arming" && suspended) resume(now, null);
    if (phase === "arming") { activate(game, now); return; }
    const p = game.player;
    const position = { x: p.getX(), y: p.getY(), z: p.getZ() };
    let corrected = false;
    if (previous) {
      const dx = position.x - previous.x, dz = position.z - previous.z;
      const goal = route.points[target];
      const toward = G.length(goal.x - previous.x, goal.z - previous.z);
      const backwards = toward > ARRIVAL && (dx * (goal.x - previous.x) + dz * (goal.z - previous.z)) / toward < -0.35;
      corrected = G.length(dx, dz) > 6 || Math.abs(position.y - previous.y) > 4 || backwards;
      if (corrected && !rejoin(position, now)) return halt("Displaced too far from the farming route.");
    }
    const lastPosition = corrected || suspended ? null : previous;
    previous = position;
    if (!W.selectHoe(p)) return halt("No usable hoe left in the hotbar.");
    hoeSlot = inventory.getSelectedSlot();
    if (p.onGround()) airborneSince = null;
    else {
      if (airborneSince === null) airborneSince = now;
      if (now - airborneSince > 1.5) return wait("Lost ground support.", now, STUCK_SECONDS);
    }

    if (suspended && waitReason === NO_PROGRESS && !corrected && now - waitSince < 1) return;

    const goal = route.points[target];
    const distance = G.length(goal.x - p.getX(), goal.z - p.getZ());
    const arrivalDistance = lastPosition ? G.segmentDistance(goal, lastPosition, position) : distance;
    if (arrivalDistance <= ARRIVAL && Math.abs(goal.y - p.getY()) <= 0.6) {
      if (target === route.points.length - 1) laps++;
      target = (target + 1) % route.points.length;
      // Keep the camera centered on the route leg, not a bearing which can
      // reverse by 180 degrees as the player passes close to the endpoint.
      setLegHeading(goal);
      bestDistance = Infinity;
      lastProgress = now;
    } else if (distance < bestDistance - 0.1) {
      bestDistance = distance;
      lastProgress = now;
    } else if (!suspended && now - lastProgress >= STUCK_SECONDS) {
      // On clear, loaded ground a lack of movement can be server lag. Retry
      // after a short rest rather than declaring the route impossible.
      return wait(NO_PROGRESS, now, Infinity);
    }
    // Arrival can change the leg. Validate the resulting direction before
    // granting ticks or frames permission to press any movement/attack keys.
    let terrain = null;
    if (p.onGround()) {
      const names = G.steering(route.points[target].x - p.getX(), route.points[target].z - p.getZ(), p.getYRot());
      terrain = W.terrain(game, G.travel(names, p.getYRot()));
      if (terrain.unloaded) return wait("Terrain is still loading.", now, Infinity);
      if (!terrain.safe) return halt("Unsafe drop ahead.");
      if (terrain.blocked && !terrain.jump) return wait("Wall or low ceiling ahead. Adjust your waypoints.", now, STUCK_SECONDS);
    }
    resume(now, position);
    status = "Waypoint " + (target + 1) + " / " + route.points.length + " | Laps " + laps;
    jumpHeld = !!terrain && terrain.jump && now - lastJump > 0.45;
    if (jumpHeld) lastJump = now;
    move(game, jumpHeld);
    const normalPitch = deps.setting("pitch");
    const lowerPitch = W.lowerLayerPitch(game, p.getYRot(), normalPitch);
    if (lowerPitch > normalPitch) {
      terrainPitch = lowerPitch;
      // Hold across brief gaps in the sweep so pitch does not flicker at the lip.
      lowerAimUntil = now + 0.2;
    } else if (now >= lowerAimUntil) terrainPitch = normalPitch;
    // Vanilla handles continued break progress and swings. Prime its first
    // block attack explicitly, as synthetic key clicks are unreliable in CT.
    if (game.isWindowActive() && !game.mouseHandler.isMouseGrabbed()) game.mouseHandler.grabMouse();
    setInput(game, "keyAttack", true);
    const hit = game.hitResult;
    if (hit && hit.getType() === deps.T.HitType.BLOCK && !game.gameMode.isDestroying()) {
      if (game.gameMode.startDestroyBlock(hit.getBlockPos(), hit.getDirection())) p.swing(deps.T.InteractionHand.MAIN_HAND);
    }
  }

  function frame() {
    if (phase !== "running" || !route || suspended) return;
    const game = deps.game();
    if (deps.inGui()) return halt("Screen opened.");
    if (!game || game.player !== activePlayer || game.level !== activeLevel || game.isPaused()) return;
    const now = deps.now();
    const dt = G.clamp(now - lastFrame, 0, 0.1);
    lastFrame = now;
    sweep = (sweep + dt * Math.PI / deps.setting("sweepTime")) % (Math.PI * 2);
    const p = game.player;
    heading = G.approach(heading, legHeading, 240 * dt);
    // Smooth only the amplitude. Filtering/rate-limiting the oscillator itself
    // distorts fast sweeps, so its left/right timing must remain analytic.
    sweepWidth += (deps.setting("sweepWidth") - sweepWidth) * (1 - Math.exp(-dt * 12));
    p.setYRot(heading + Math.sin(sweep) * sweepWidth);
    const pitch = Math.max(deps.setting("pitch"), terrainPitch);
    p.setXRot(p.getXRot() + G.clamp(pitch - p.getXRot(), -90 * dt, 90 * dt));
    move(game, jumpHeld);
  }

  function onScreenOpened() { if (phase === "running") halt("Screen opened."); }
  const state = () => ({ phase, running: phase === "running", status, target: phase === "running" ? target : -1, laps });
  return { start, stop, tick, frame, onScreenOpened, state };
}

module.exports = { createFarmer };
