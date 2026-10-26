// Pure math for the auto miner: angles, the mining area, camera spring and
// mining-time estimates. No Minecraft or CT access, so it is unit-tested directly.

const AREA_WIDTH = 5; // blocks on X and Z
const AREA_DEPTH = 5; // vertical layers around the player
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

// The mining area: an AREA_WIDTH-wide square centred on the player's block.
// The Y layers cover the floor, feet, head,
// and two overhead layers instead of extending entirely below the player.
function cube(x, y, z) {
  const minX = Math.floor(x - (AREA_WIDTH - 1) / 2);
  const minZ = Math.floor(z - (AREA_WIDTH - 1) / 2);
  const supportY = Math.floor(y - 0.01);
  const topY = supportY + AREA_DEPTH - 1;
  const blocks = [];
  for (let depth = 0; depth < AREA_DEPTH; depth++) {
    for (let dx = 0; dx < AREA_WIDTH; dx++) {
      for (let dz = 0; dz < AREA_WIDTH; dz++) blocks.push({ x: minX + dx, y: topY - depth, z: minZ + dz });
    }
  }
  return { blocks, topY, supportY };
}

// True for floor blocks under the player's collision box (never mined).
function supportsFeet(pos, supportY, box) {
  return pos.y === supportY && pos.x + 1 > box.minX + 0.001 && pos.x < box.maxX - 0.001 &&
    pos.z + 1 > box.minZ + 0.001 && pos.z < box.maxZ - 0.001;
}

// Damped spring that keeps velocity across target changes. Fixed substeps make
// acceleration and damping independent of the frame rate.
function spring(axis, goal, dt, response, speed, acceleration) {
  let remaining = clamp(dt, 0, 0.1);
  while (remaining > 0) {
    const step = Math.min(remaining, 1 / 240);
    const force = response * response * (goal - axis.value) - 2 * response * axis.velocity;
    axis.velocity = clamp(axis.velocity + clamp(force, -acceleration, acceleration) * step, -speed, speed);
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
  AREA_WIDTH, AREA_DEPTH, clamp, wrap, hypot, angles, cube, supportsFeet, spring, miningTicks, leadTicks, glideWeight,
};
