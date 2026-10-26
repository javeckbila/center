// Walk-home controller. When the player is pushed off the start position the
// miner pauses and this steers back with ordinary movement keys (it never
// teleports, sets velocity or jumps). Same floor only, small detours allowed.
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
  if (!p.onGround()) {
    keys.release();
    rec.settled = 0;
    if (time - rec.lastProgress > AIRBORNE_TIMEOUT) return { failure: "Cannot reach the starting floor" };
    return { status: "Returning: waiting to land" };
  }
  if (Math.abs(p.getY() - anchor.y) > FLOOR_TOLERANCE) return { failure: "Starting floor is no longer reachable on foot" };

  if (distance <= HOME_RADIUS) {
    keys.release();
    const drift = hypot(p.getX() - rec.previousX, p.getZ() - rec.previousZ);
    rec.previousX = p.getX();
    rec.previousZ = p.getZ();
    rec.settled = drift < SETTLE_DRIFT ? rec.settled + 1 : 0;
    return rec.settled >= SETTLE_TICKS ? { done: true } : { status: "Returning: settling at start" };
  }

  rec.settled = 0;
  if (distance < rec.bestDistance - 0.025) {
    rec.bestDistance = distance;
    rec.lastProgress = time;
  }
  if (time - rec.lastProgress > STALL_TIMEOUT) return { failure: "Return path is blocked" };

  const position = { x: p.getX(), z: p.getZ() };
  const goal = { x: anchor.x, z: anchor.z };
  const canWalk = (from, to) => world.walkable(game, from, to, anchor.y);
  if (!rec.route || time >= rec.nextPlan) {
    rec.route = canWalk(position, goal) ? [goal] : findRoute(position, goal, canWalk);
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
