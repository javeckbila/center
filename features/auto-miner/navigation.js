// Pure walking helpers for returning to the start position.
const { hypot } = require("./geometry");

const SEARCH_RADIUS = 12; // blocks from the goal
const MAX_VISITED = 512;
const KEY_THRESHOLD = 0.38; // direction component needed to press a key

// Movement keys that walk along (dx, dz) for a player facing `yaw`.
function steering(dx, dz, yaw) {
  const length = hypot(dx, dz);
  if (length < 0.001) return [];
  const radians = yaw * Math.PI / 180;
  const forward = (-Math.sin(radians) * dx + Math.cos(radians) * dz) / length;
  const right = (Math.cos(radians) * dx + Math.sin(radians) * dz) / length;
  const keys = [];
  if (forward > KEY_THRESHOLD) keys.push("keyUp");
  if (forward < -KEY_THRESHOLD) keys.push("keyDown");
  if (right > KEY_THRESHOLD) keys.push("keyRight");
  if (right < -KEY_THRESHOLD) keys.push("keyLeft");
  return keys;
}

// A* over block centres on the starting floor. canTraverse(from, to) must check
// the player's full collision box and floor support along the whole segment.
// Returns waypoints ending at `goal`, or null when no route exists.
function findRoute(start, goal, canTraverse) {
  const goalX = Math.floor(goal.x);
  const goalZ = Math.floor(goal.z);
  const id = node => node.x + "," + node.z;
  const heuristic = node => Math.abs(node.x - goalX) + Math.abs(node.z - goalZ);
  const initial = { x: Math.floor(start.x), z: Math.floor(start.z), cost: 0, previous: null, point: start };
  const open = [initial];
  const best = new Map([[id(initial), 0]]);
  let visited = 0;
  while (open.length && visited++ < MAX_VISITED) {
    open.sort((a, b) => a.cost + heuristic(a) - b.cost - heuristic(b));
    const node = open.shift();
    if (node.cost !== best.get(id(node))) continue;
    if (node.x === goalX && node.z === goalZ && canTraverse(node.point, goal)) {
      const route = [goal];
      for (let current = node; current.previous; current = current.previous) route.unshift(current.point);
      return route;
    }
    for (const delta of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: node.x + delta[0], z: node.z + delta[1], cost: node.cost + 1, previous: node };
      if (Math.abs(next.x - goalX) > SEARCH_RADIUS || Math.abs(next.z - goalZ) > SEARCH_RADIUS) continue;
      next.point = { x: next.x + 0.5, z: next.z + 0.5 };
      if ((best.get(id(next)) ?? Infinity) <= next.cost || !canTraverse(node.point, next.point)) continue;
      best.set(id(next), next.cost);
      open.push(next);
    }
  }
  return null;
}

module.exports = { steering, findRoute };
