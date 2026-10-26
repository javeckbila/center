// Tick-driven automation with frame-smoothed camera motion. No CT globals:
// game, route, settings, clock and lifecycle notifications are injected.
const G = require("./geometry");
const { createWorld } = require("./world");

const INPUTS = ["keyUp", "keyDown", "keyLeft", "keyRight", "keyJump", "keySprint", "keyAttack"];
const ARRIVAL = 0.6;
const BRAKE_DISTANCE = 2;
const STUCK_SECONDS = 4;

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

  function release() {
    // Keep the original bindings: player/level may already be null on unload.
    let error = null;
    owned.forEach(binding => { try { writeBinding(binding, false); } catch (e) { error = e; } });
    owned.clear();
    try { if (activeGame && activeGame.gameMode) activeGame.gameMode.stopDestroyBlock(); } catch (e) { error = e; }
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
    status = "Starts when this screen closes";
    return true;
  }

  function activate(game, now) {
    const saved = deps.route();
    if (saved.points.length < 2) return halt("Add at least two waypoints with /af add.");
    if (saved.context !== deps.context()) return halt("This route belongs to another world or dimension.");
    if (!game.player.onGround()) return halt("Stand on the ground before starting.");
    if (INPUTS.filter(name => name !== "keySprint").concat(["keyUse", "keyShift"]).some(name => game.options[name].isDown())) {
      return halt("Release movement, attack and use keys before starting.");
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
    legHeading = heading;
    setLegHeading({ x: game.player.getX(), z: game.player.getZ() });
    bestDistance = Infinity;
    lastProgress = lastFrame = now;
    lastJump = -Infinity;
    airborneSince = null;
    previous = null;
    phase = "running";
    status = "Waypoint 1 / " + route.points.length;
    if (deps.onStart) deps.onStart();
  }

  function invalid(game) {
    if (!game || !game.player || !game.level || !game.gameMode) return "World unavailable.";
    if (!game.player.isAlive()) return "Player died.";
    if (game.player.isPassenger() || game.player.isUsingItem() || game.gameMode.isSpectator()) return "Player cannot farm right now.";
    if (game.player.isInWater() || game.player.isInLava()) return "Entered water or lava.";
    if (game.isPaused()) return "Game paused.";
    return null;
  }

  function setLegHeading(from) {
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
    const game = deps.game(), now = deps.now();
    if (phase === "arming" && deps.inGui()) return;
    if (phase === "running" && deps.inGui()) return halt("Screen opened.");
    const problem = invalid(game);
    if (problem) return halt(problem);
    if (phase === "arming") { activate(game, now); return; }
    if (game.player !== activePlayer || game.level !== activeLevel) return halt("World changed.");
    if (deps.context() !== route.context) return halt("World or dimension changed.");
    const p = game.player;
    const position = { x: p.getX(), y: p.getY(), z: p.getZ() };
    if (previous && (G.length(position.x - previous.x, position.z - previous.z) > 6 || Math.abs(position.y - previous.y) > 4)) {
      return halt("Player teleported.");
    }
    const lastPosition = previous;
    previous = position;
    if (!W.selectHoe(p)) return halt("No usable hoe left in the hotbar.");
    hoeSlot = inventory.getSelectedSlot();
    if (p.onGround()) airborneSince = null;
    else {
      if (airborneSince === null) airborneSince = now;
      if (now - airborneSince > 1.5) return halt("Lost ground support.");
    }

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
    } else if (now - lastProgress >= STUCK_SECONDS) {
      return halt("Cannot reach waypoint " + (target + 1) + ". Check the route for obstacles.");
    }
    status = "Waypoint " + (target + 1) + " / " + route.points.length + " | Laps " + laps;
    const direction = move(game, false);
    jumpHeld = false;
    if (p.onGround()) {
      const terrain = W.terrain(game, direction);
      if (!terrain.safe) return halt("Unsafe drop or unloaded terrain ahead.");
      if (terrain.blocked && !terrain.jump) return halt("Wall or low ceiling ahead. Adjust your waypoints.");
      jumpHeld = terrain.jump && now - lastJump > 0.45;
      if (jumpHeld) { lastJump = now; setInput(game, "keyJump", true); }
    }
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
    if (phase !== "running" || !route) return;
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
    p.setXRot(p.getXRot() + G.clamp(deps.setting("pitch") - p.getXRot(), -90 * dt, 90 * dt));
    move(game, jumpHeld);
  }

  function onScreenOpened() { if (phase === "running") halt("Screen opened."); }
  const state = () => ({ phase, running: phase === "running", status, target: phase === "running" ? target : -1, laps });
  return { start, stop, tick, frame, onScreenOpened, state };
}

module.exports = { createFarmer };
