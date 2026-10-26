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
  if (sector < 0 && sector > -4) keys.push("keyRight");
  if (sector > 0 && sector < 4) keys.push("keyLeft");
  return keys;
}

function travel(keys, yaw) {
  const forward = (keys.indexOf("keyUp") >= 0 ? 1 : 0) - (keys.indexOf("keyDown") >= 0 ? 1 : 0);
  const right = (keys.indexOf("keyRight") >= 0 ? 1 : 0) - (keys.indexOf("keyLeft") >= 0 ? 1 : 0);
  const radians = yaw * Math.PI / 180;
  const x = -Math.sin(radians) * forward + Math.cos(radians) * right;
  const z = Math.cos(radians) * forward + Math.sin(radians) * right;
  const size = length(x, z) || 1;
  return { x: x / size, z: z / size };
}

module.exports = { clamp, length, wrap, bearing, approach, steering, travel };
