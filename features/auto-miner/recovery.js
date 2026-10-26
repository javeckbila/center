// Walk-home controller. When the player is pushed off the start position the
// miner pauses and this steers back with ordinary movement keys (it never
// teleports or sets velocity). Supports jumping up one block. Sidesteps and
// their return use the direct segment only; ordinary push recovery may detour.
const { hypot } = require("./geometry");
const { steering, findRoute } = require("./navigation");

const MAX_DISTANCE = 12;     // blocks; farther away stops the miner
const MAX_HEIGHT = 3;        // blocks of vertical displacement tolerated while airborne
const FLOOR_TOLERANCE = 0.15;
const HOME_RADIUS = 0.06;    // release movement inside this horizontal distance
const SETTLE_DRIFT = 0.012;  // per-tick drift that counts as standing still
const SETTLE_TICKS = 3;
const AIRBORNE_TIMEOUT = 4;  // s
const STALL_TIMEOUT = 8;     // s without getting closer
const REPLAN_INTERVAL = 0.5; // s
const SNEAK_DISTANCE = 0.8;
const WAYPOINT_REACHED = 0.15;
const BRAKE_DISTANCE = 0.18;

function begin(player, time) {
  return {
    route: null, nextPlan: 0, lastProgress: time, bestDistance: Infinity,
    previousX: player.getX(), previousZ: player.getZ(), settled: 0,
  };
}

// One tick of the controller. `keys` = { hold(names), release() } for movement
// keys; `world` provides walkable(). Returns { status } while walking,
// { done: true } once settled at home, or { failure: reason } to stop.
function update(game, time, anchor, rec, keys, world) {
  const p = game.player;
  const distance = hypot(p.getX() - anchor.x, p.getZ() - anchor.z);
  if (distance > MAX_DISTANCE || Math.abs(p.getY() - anchor.y) > MAX_HEIGHT) {
    return { failure: "Too far from the starting spot to walk back" };
  }
  if (distance < rec.bestDistance - 0.025) {
    rec.bestDistance = distance;
    rec.lastProgress = time;
  }
  if (rec.jump) {
    if (!p.onGround()) rec.jump.airborne = true;
    if (p.onGround() && (rec.jump.airborne || time - rec.jump.since > 0.5)) {
      rec.jump = null;
      rec.route = null;
    } else {
      if (time - rec.jump.since > AIRBORNE_TIMEOUT) return { failure: "Cannot land on the starting floor" };
      const pressed = distance > HOME_RADIUS ? steering(anchor.x - p.getX(), anchor.z - p.getZ(), p.getYRot()) : [];
      if (!rec.jump.airborne) pressed.push("keyJump");
      keys.hold(pressed);
      return { status: "Returning: jumping to starting floor" };
    }
  }
  if (!p.onGround()) {
    keys.release();
    rec.settled = 0;
    if (time - rec.lastProgress > AIRBORNE_TIMEOUT) return { failure: "Cannot reach the starting floor" };
    return { status: "Returning: waiting to land" };
  }
  const rise = anchor.y - p.getY();
  if (rise < -FLOOR_TOLERANCE || rise > 1.1) return { failure: "Starting floor is more than one jump away" };
  if (time - rec.lastProgress > STALL_TIMEOUT) return { failure: "Return path is blocked" };

  if (distance <= HOME_RADIUS && Math.abs(rise) <= FLOOR_TOLERANCE) {
    keys.release();
    const drift = hypot(p.getX() - rec.previousX, p.getZ() - rec.previousZ);
    rec.previousX = p.getX();
    rec.previousZ = p.getZ();
    rec.settled = drift < SETTLE_DRIFT ? rec.settled + 1 : 0;
    return rec.settled >= SETTLE_TICKS ? { done: true } : { status: "Returning: settling at start" };
  }

  rec.settled = 0;

  const position = { x: p.getX(), z: p.getZ() };
  let goal = { x: anchor.x, z: anchor.z };
  let floorY = anchor.y;
  if (rise > FLOOR_TOLERANCE) {
    if (distance <= 1.4) {
      keys.release();
      if (!world.jumpable(game, position, goal, p.getY(), anchor.y)) return { status: "Returning: waiting for jump clearance" };
      rec.jump = { since: time, airborne: false };
      keys.hold(steering(goal.x - position.x, goal.z - position.z, p.getYRot()).concat(["keyJump"]));
      return { status: "Returning: jumping to starting floor" };
    }
    // Walk along the lower floor until close enough to jump onto home.
    goal = { x: anchor.x + (position.x - anchor.x) / distance * 1.05,
      z: anchor.z + (position.z - anchor.z) / distance * 1.05 };
    floorY = p.getY();
  }
  const canWalk = (from, to) => world.walkable(game, from, to, floorY);
  if (!rec.route || time >= rec.nextPlan) {
    rec.route = canWalk(position, goal) ? [goal] : (rec.directOnly ? null : findRoute(position, goal, canWalk));
    rec.nextPlan = time + REPLAN_INTERVAL;
  }
  if (!rec.route) {
    keys.release();
    return { status: "Returning: waiting for a clear path" };
  }
  while (rec.route.length > 1 && hypot(rec.route[0].x - position.x, rec.route[0].z - position.z) < WAYPOINT_REACHED) rec.route.shift();
  const waypoint = rec.route[0];
  if (!canWalk(position, waypoint)) {
    keys.release();
    rec.route = null;
    return { status: "Returning: replanning" };
  }

  const waypointDistance = hypot(waypoint.x - position.x, waypoint.z - position.z);
  const pressed = steering(waypoint.x - position.x, waypoint.z - position.z, p.getYRot());
  if (distance < SNEAK_DISTANCE || waypointDistance < 0.4) pressed.push("keyShift");
  // Release early and let ground friction brake onto the saved spot.
  const approachSpeed = ((position.x - rec.previousX) * (goal.x - position.x) +
    (position.z - rec.previousZ) * (goal.z - position.z)) / Math.max(distance, 0.001);
  rec.previousX = position.x;
  rec.previousZ = position.z;
  keys.hold(distance < BRAKE_DISTANCE && approachSpeed > distance * 0.55 ? [] : pressed);
  return { status: "Returning to start (" + distance.toFixed(2) + "m)" };
}

module.exports = { begin, update };
