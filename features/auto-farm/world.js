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
        return { blocked: true, jump: false, safe: false };
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

  return { selectHoe, terrain };
}

module.exports = { createWorld };
