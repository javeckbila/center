const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const length = (x, z) => Math.sqrt(x * x + z * z);
const wrap = angle => ((angle + 180) % 360 + 360) % 360 - 180;
const bearing = (dx, dz) => Math.atan2(-dx, dz) * 180 / Math.PI;
const approach = (current, target, step) => current + clamp(wrap(target - current), -step, step);

// Eight vanilla movement directions. Compute again after each camera update,
// so looking across the crops never rotates the intended direction of travel.
function steering(dx, dz, yaw) {
  if (length(dx, dz) < 0.001) return [];
  const relative = wrap(bearing(dx, dz) - yaw);
  const sector = Math.round(relative / 45);
  const keys = [];
  if (Math.abs(sector) <= 1) keys.push("keyUp");
  if (Math.abs(sector) >= 3) keys.push("keyDown");
  // Vanilla's positive strafe impulse is LEFT (KeyboardInput.calculateImpulse).
  // At yaw 0, left moves east (+X), while right moves west (-X).
  if (sector < 0 && sector > -4) keys.push("keyLeft");
  if (sector > 0 && sector < 4) keys.push("keyRight");
  return keys;
}

function travel(keys, yaw) {
  const forward = (keys.indexOf("keyUp") >= 0 ? 1 : 0) - (keys.indexOf("keyDown") >= 0 ? 1 : 0);
  const left = (keys.indexOf("keyLeft") >= 0 ? 1 : 0) - (keys.indexOf("keyRight") >= 0 ? 1 : 0);
  const radians = yaw * Math.PI / 180;
  const x = -Math.sin(radians) * forward + Math.cos(radians) * left;
  const z = Math.cos(radians) * forward + Math.sin(radians) * left;
  const size = length(x, z) || 1;
  return { x: x / size, z: z / size };
}

// Distance from a waypoint to the player's movement during the last tick.
// This recognizes an arrival even if momentum carries the player past it.
function segmentDistance(point, from, to) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const size = dx * dx + dz * dz;
  const t = size < 0.000001 ? 0 : clamp(((point.x - from.x) * dx + (point.z - from.z) * dz) / size, 0, 1);
  return length(point.x - from.x - dx * t, point.z - from.z - dz * t);
}

module.exports = { clamp, length, wrap, bearing, approach, steering, travel, segmentDistance };
