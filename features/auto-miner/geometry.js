// Pure math for the auto miner: angles, the mining area, camera spring and
// mining-time estimates. No Minecraft or CT access, so it is unit-tested directly.

const MAX_LEAD_TICKS = 6;

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const wrap = n => ((n + 180) % 360 + 360) % 360 - 180;
const hypot = (a, b) => Math.sqrt(a * a + b * b);
// typeof first: CT's Rhino (opt 9) evaluates `undefined > 0` as true.
const positive = n => typeof n === "number" && isFinite(n) && n > 0;

// Yaw/pitch (degrees, Minecraft convention) from an eye position to a point.
function angles(eye, point) {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  return {
    yaw: Math.atan2(-dx, dz) * 180 / Math.PI,
    pitch: -Math.atan2(dy, hypot(dx, dz)) * 180 / Math.PI,
  };
}

// Broad phase: every block whose unit box intersects the eye's reach sphere.
// Visibility and distance to the actual ray hit are checked in world.js.
function reachBlocks(eye, range) {
  const blocks = [];
  for (let x = Math.floor(eye.x - range); x <= Math.floor(eye.x + range); x++) {
    for (let y = Math.floor(eye.y - range); y <= Math.floor(eye.y + range); y++) {
      for (let z = Math.floor(eye.z - range); z <= Math.floor(eye.z + range); z++) {
        const dx = eye.x - clamp(eye.x, x, x + 1);
        const dy = eye.y - clamp(eye.y, y, y + 1);
        const dz = eye.z - clamp(eye.z, z, z + 1);
        if (dx * dx + dy * dy + dz * dz <= range * range) blocks.push({ x, y, z });
      }
    }
  }
  return blocks;
}

// True for floor blocks under the player's collision box (never mined).
function supportsFeet(pos, supportY, box) {
  return pos.y === supportY && pos.x + 1 > box.minX + 0.001 && pos.x < box.maxX - 0.001 &&
    pos.z + 1 > box.minZ + 0.001 && pos.z < box.maxZ - 0.001;
}

// Velocity-preserving camera easing. Brake before reaching the goal instead of
// clipping a spring's force (which loses damping on large turns and overshoots).
// Fixed substeps keep acceleration and braking consistent across frame rates.
function spring(axis, goal, dt, response, speed, acceleration) {
  let remaining = clamp(dt, 0, 0.1);
  while (remaining > 0) {
    const step = Math.min(remaining, 1 / 240);
    const error = goal - axis.value;
    const limit = Math.min(speed, Math.sqrt(2 * acceleration * Math.abs(error)) * 0.8);
    const desiredVelocity = clamp(error * response, -limit, limit);
    axis.velocity += clamp(desiredVelocity - axis.velocity, -acceleration * step, acceleration * step);
    axis.value += axis.velocity * step;
    remaining -= step;
  }
  return axis.value;
}

// Game ticks to break a block from its per-tick destroy progress.
function miningTicks(progress) {
  return positive(progress) ? Math.max(1, Math.ceil(1 / progress)) : Infinity;
}

// Tab ping is a round trip: one-way latency in 50 ms ticks, plus the final tick.
function leadTicks(pingMs) {
  return clamp(Math.ceil((positive(pingMs) ? pingMs : 0) / 100) + 1, 1, MAX_LEAD_TICKS);
}

// 0..1 blend toward the next target during the last leadTicks() of a break.
function glideWeight(stage, progressPerTick, pingMs) {
  if (typeof stage !== "number" || stage < 0 || !positive(progressPerTick)) return 0;
  const remaining = Math.max(1, Math.ceil((1 - stage / 10) / progressPerTick - 0.00001));
  const lead = leadTicks(pingMs);
  return clamp((lead + 1 - remaining) / lead, 0, 1);
}

module.exports = {
  clamp, wrap, hypot, angles, reachBlocks, supportsFeet, spring, miningTicks, leadTicks, glideWeight,
};
