// Minecraft queries used by the miner: ray casts, visibility, reach, tool and
// walkability checks. `T` holds the Minecraft classes (resolved by the feature
// with Java.type, replaced by mocks in tests), so this file has no CT globals.
const { clamp } = require("./geometry");

// Points just inside each face, so clip() enters the block instead of stopping on its boundary.
const FACE_SAMPLES = [
  [0.5, 0.97, 0.5], [0.03, 0.5, 0.5], [0.97, 0.5, 0.5], [0.5, 0.5, 0.03], [0.5, 0.5, 0.97], [0.5, 0.03, 0.5],
];
const WALK_SAMPLE = 0.15; // blocks between collision samples along a walk segment

function createWorld(T) {
  const blockPos = (x, y, z) => new T.BlockPos(x, y, z);

  const targetBlocks = [
    T.Blocks.COBBLESTONE, T.Blocks.IRON_ORE, T.Blocks.DEEPSLATE_IRON_ORE,
    T.Blocks.DIAMOND_ORE, T.Blocks.DEEPSLATE_DIAMOND_ORE, T.Blocks.ANCIENT_DEBRIS,
    T.Blocks.GLAZED_TERRACOTTA.purple(), T.Blocks.GLAZED_TERRACOTTA.red(), T.Blocks.GLAZED_TERRACOTTA.lime(),
  ];
  function isTarget(game, pos) {
    const state = game.level.getBlockState(pos);
    return targetBlocks.some(block => state.is(block));
  }

  function cast(game, end) {
    const hit = game.level.clip(new T.ClipContext(game.player.getEyePosition(), end, T.ClipBlock.OUTLINE, T.ClipFluid.NONE, game.player));
    if (hit.getType() === T.HitType.BLOCK && playerBlocksRay(game, hit.getLocation())) return null;
    return hit;
  }

  function otherPlayers(game) {
    const self = String(game.player.getUUID());
    return Array.from(game.level.players()).filter(p => String(p.getUUID()) !== self && p.isAlive() && !p.isSpectator());
  }

  // Block-only level.clip ignores entities. Include the eye being inside a
  // player, which AABB.clip alone does not reliably report as an entry hit.
  function playerBlocksRay(game, end) {
    const eye = game.player.getEyePosition();
    return otherPlayers(game).some(p => {
      const box = p.getBoundingBox().inflate(0.1);
      return box.contains(eye) || box.clip(eye, end).isPresent();
    });
  }

  function occupied(game, spot) {
    const p = game.player;
    const box = spot ? p.getBoundingBox().move(spot.x - p.getX(), spot.y - p.getY(), spot.z - p.getZ()) : p.getBoundingBox();
    return otherPlayers(game).some(other => box.intersects(other.getBoundingBox()));
  }

  // Escape players already sharing our box, but do not walk into a third
  // player. Ground, walls and fluids are still checked over the whole path.
  function sidestep(game, anchor) {
    const p = game.player;
    const from = { x: p.getX(), z: p.getZ() };
    const box = p.getBoundingBox();
    const others = otherPlayers(game).filter(other => !box.intersects(other.getBoundingBox()));
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const spot = { x: anchor.x + d[0], y: anchor.y, z: anchor.z + d[1] };
      if (occupied(game, spot) || !walkable(game, from, spot, anchor.y)) continue;
      let clear = true;
      for (let i = 1; i <= 8 && clear; i++) {
        const step = box.move((spot.x - from.x) * i / 8, 0, (spot.z - from.z) * i / 8);
        if (others.some(other => step.intersects(other.getBoundingBox()))) clear = false;
      }
      if (clear) return spot;
    }
    return null;
  }

  const hits = (hit, pos) => !!hit && hit.getType() === T.HitType.BLOCK && hit.getBlockPos().equals(pos);

  function inReach(game, hit) {
    const range = game.player.blockInteractionRange();
    return game.player.getEyePosition().distanceToSqr(hit.getLocation()) <= range * range;
  }

  // A point on a face of `pos` that the eye can see and reach, or null.
  function visiblePoint(game, pos) {
    // Include the closest surface point: an edge can be in reach even when all
    // face centres are outside it.
    const eye = game.player.getEyePosition();
    const closest = [clamp(eye.x - pos.getX(), 0.001, 0.999),
      clamp(eye.y - pos.getY(), 0.001, 0.999), clamp(eye.z - pos.getZ(), 0.001, 0.999)];
    for (const s of FACE_SAMPLES.concat([closest])) {
      const point = { x: pos.getX() + s[0], y: pos.getY() + s[1], z: pos.getZ() + s[2] };
      const hit = cast(game, new T.Vec3(point.x, point.y, point.z));
      if (hits(hit, pos) && inReach(game, hit)) return point;
    }
    return null;
  }

  // Block ray for a hypothetical camera direction, limited to interaction range.
  function rayAt(game, look) {
    const yr = look.yaw * Math.PI / 180;
    const pr = look.pitch * Math.PI / 180;
    const direction = new T.Vec3(-Math.sin(yr) * Math.cos(pr), -Math.sin(pr), Math.cos(yr) * Math.cos(pr));
    return cast(game, game.player.getEyePosition().add(direction.scale(game.player.blockInteractionRange())));
  }

  const cameraRay = game => rayAt(game, { yaw: game.player.getYRot(), pitch: game.player.getXRot() });

  // A pickaxe with more than one durability left (the last point is never spent).
  function usablePickaxe(stack) {
    return !stack.isEmpty() && stack.is(T.ItemTags.PICKAXES) &&
      (!stack.isDamageableItem() || stack.getMaxDamage() - stack.getDamageValue() > 1);
  }

  const holdsPickaxe = player => usablePickaxe(player.getMainHandItem());

  function selectPickaxe(player) {
    if (holdsPickaxe(player)) return true;
    const inventory = player.getInventory();
    for (let slot = 0; slot < 9; slot++) {
      if (!usablePickaxe(inventory.getItem(slot))) continue;
      inventory.setSelectedSlot(slot);
      return true;
    }
    return false;
  }

  // Whether the player can walk from `from` to `to` (x/z) on the floor at floorY:
  // no collisions, ground under the whole box, and no fluids on the way.
  function walkable(game, from, to, floorY) {
    const p = game.player;
    const box = p.getBoundingBox();
    const length = Math.sqrt((to.x - from.x) * (to.x - from.x) + (to.z - from.z) * (to.z - from.z));
    const samples = Math.max(1, Math.ceil(length / WALK_SAMPLE));
    for (let i = 0; i <= samples; i++) {
      const x = from.x + (to.x - from.x) * i / samples;
      const z = from.z + (to.z - from.z) * i / samples;
      const shifted = box.move(x - p.getX(), floorY - p.getY(), z - p.getZ());
      if (!game.level.noCollision(p, shifted) || game.level.noCollision(p, shifted.move(0, -0.12, 0))) return false;
      for (const y of [floorY - 0.1, floorY + 0.1]) {
        if (!game.level.getBlockState(blockPos(Math.floor(x), Math.floor(y), Math.floor(z))).getFluidState().isEmpty()) return false;
      }
    }
    return true;
  }

  // A short, one-block ascent: clear takeoff/headroom and a supported landing.
  // Check the full box at the apex, including the extra height above the ledge.
  function jumpable(game, from, to, floorY, landingY) {
    const p = game.player;
    const rise = landingY - floorY;
    if (rise <= 0.15 || rise > 1.1 || Math.sqrt((to.x - from.x) ** 2 + (to.z - from.z) ** 2) > 1.4) return false;
    if (!walkable(game, to, to, landingY)) return false;
    const box = p.getBoundingBox();
    const apex = floorY + 1.25;
    for (let i = 0; i <= 10; i++) {
      const lifted = box.move(from.x - p.getX(), floorY + 1.25 * i / 10 - p.getY(), from.z - p.getZ());
      const across = box.move(from.x + (to.x - from.x) * i / 10 - p.getX(), apex - p.getY(),
        from.z + (to.z - from.z) * i / 10 - p.getZ());
      if (!game.level.noCollision(p, lifted) || !game.level.noCollision(p, across)) return false;
    }
    return true;
  }

  // Tab-list latency of the local player in ms (0 when unknown).
  function latency(game) {
    const connection = game.getConnection();
    const info = connection ? connection.getPlayerInfo(game.player.getUUID()) : null;
    return info ? clamp(info.getLatency(), 0, 2000) : 0;
  }

  return { blockPos, isTarget, cast, hits, inReach, visiblePoint, rayAt, cameraRay, holdsPickaxe, selectPickaxe, walkable, latency,
    occupied, sidestep, jumpable };
}

module.exports = { createWorld };
