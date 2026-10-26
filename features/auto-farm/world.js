// All Minecraft queries are isolated here and use Mojang 26.2 names.
const { clamp, length } = require("./geometry");

function createWorld(T) {
  function usableHoe(stack) {
    return !!stack && !stack.isEmpty() && stack.is(T.ItemTags.HOES) &&
      (!stack.isDamageableItem() || stack.getMaxDamage() - stack.getDamageValue() > 1);
  }
  function selectHoe(player) {
    if (usableHoe(player.getMainHandItem())) return true;
    const inventory = player.getInventory();
    for (let slot = 0; slot < 9; slot++) {
      if (!usableHoe(inventory.getItem(slot))) continue;
      inventory.setSelectedSlot(slot);
      return true;
    }
    return false;
  }

  // Check the full player box along the *actual* key direction, including its
  // leading edge. Look 2.5 movement ticks ahead, before horizontalCollision.
  // A raised box must fit at every sample; ceilings/tall walls cannot be jumped.
  function terrain(game, direction) {
    const player = game.player;
    const box = player.getBoundingBox().deflate(0.01, 0, 0.01);
    const motion = player.getDeltaMovement();
    const speed = length(motion.x, motion.z);
    const ahead = clamp(0.35 + speed * 2.5, 0.55, 1.15);
    let blocked = false;
    let raisedClear = game.level.noCollision(player, box.move(0, 1.05, 0));
    let supported = true;
    for (let distance = 0.15; distance <= ahead + 0.01; distance += 0.15) {
      const x = direction.x * distance, z = direction.z * distance;
      const next = box.move(x, 0, z);
      if (!game.level.hasChunk(Math.floor((player.getX() + x) / 16), Math.floor((player.getZ() + z) / 16))) {
        return { blocked: true, jump: false, safe: false, unloaded: true };
      }
      if (!game.level.noCollision(player, next)) blocked = true;
      if (!game.level.noCollision(player, next.move(0, 1.05, 0))) raisedClear = false;
      // Allow a one-block step down after jumping onto an obstacle. A deeper
      // drop (or a hole) has no support in this probe and stops the controller.
      const feet = new T.AABB(next.minX, box.minY - 1.2, next.minZ, next.maxX, box.minY + 0.01, next.maxZ);
      if (game.level.noCollision(player, feet)) supported = false;
    }
    return { blocked, jump: blocked && raisedClear && supported, safe: supported };
  }

  // Probe the collision surface underneath the current horizontal look. Crop
  // outlines have no bearing on floor height, so use COLLIDER rather than
  // OUTLINE. Prefer the farthest reachable crop center on a lower layer.
  function lowerLayerPitch(game, yaw, normalPitch) {
    const player = game.player;
    const eye = player.getEyePosition();
    const range = player.blockInteractionRange();
    const radians = yaw * Math.PI / 180;
    for (let distance = Math.min(3.25, range - 0.75); distance >= 0.75; distance -= 0.5) {
      const x = player.getX() - Math.sin(radians) * distance;
      const z = player.getZ() + Math.cos(radians) * distance;
      if (!game.level.hasChunk(Math.floor(x / 16), Math.floor(z / 16))) continue;
      const hit = game.level.clip(new T.ClipContext(
        new T.Vec3(x, player.getY() + 0.1, z), new T.Vec3(x, player.getY() - 1.25, z),
        T.ClipBlock.COLLIDER, T.ClipFluid.NONE, player));
      if (hit.getType() !== T.HitType.BLOCK) continue;
      const floorY = hit.getLocation().y;
      const drop = player.getY() - floorY;
      if (drop < 0.25 || drop > 1.2) continue;
      // Aim inside a short crop, above the soil, within vanilla interaction reach.
      const cropY = floorY + 0.45;
      const dy = eye.y - cropY;
      if (distance * distance + dy * dy > range * range) continue;
      return Math.max(normalPitch, clamp(Math.atan2(dy, distance) * 180 / Math.PI, 0, 80));
    }
    return normalPitch;
  }

  return { selectHoe, terrain, lowerLayerPitch };
}

module.exports = { createWorld };
