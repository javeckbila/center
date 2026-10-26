// Extends the shared Minecraft mock with tools, save/dimension identity,
// collision boxes, simple jump physics and native gizmo submissions.
const { createMockWorld } = require("./mock-world");

function createFarmWorld(options) {
  const w = createMockWorld(options || {});
  const p = w.player, game = w.game, inventory = p.getInventory();
  const Box = p.getBoundingBox().constructor;
  Box.prototype.deflate = function (x, y, z) {
    return new Box(this.minX + x, this.minY + y, this.minZ + z, this.maxX - x, this.maxY - y, this.maxZ - z);
  };
  w.T.AABB = Box;
  w.T.ClipBlock.COLLIDER = 2;
  const OriginalClip = w.T.ClipContext;
  w.T.ClipContext = class extends OriginalClip {
    constructor(start, end, block, fluid, entity) { super(start, end); this.block = block; }
  };
  w.typeByName["net.minecraft.world.level.ClipContext"] = w.T.ClipContext;
  // Crops participate in outline picks but never in walking/floor collision.
  w.crops = new Map();
  const floorClip = game.level.clip;
  game.level.clip = function (context) {
    const floor = floorClip(context);
    if (context.block === w.T.ClipBlock.COLLIDER || !w.crops.size) return floor;
    const start = context.start, end = context.end;
    const distance = Math.sqrt(start.distanceToSqr(end));
    const limit = floor.getType() === w.T.HitType.BLOCK ? Math.sqrt(start.distanceToSqr(floor.getLocation())) : distance;
    for (let d = 0; d <= limit; d += 0.02) {
      const t = d / distance;
      const point = new w.T.Vec3(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t, start.z + (end.z - start.z) * t);
      const x = Math.floor(point.x), y = Math.floor(point.y), z = Math.floor(point.z);
      if (!w.crops.has(x + "," + y + "," + z) || point.y > y + 0.875) continue;
      return { getType: () => w.T.HitType.BLOCK, getBlockPos: () => new w.T.BlockPos(x, y, z), getLocation: () => point, getDirection: () => "UP" };
    }
    return floor;
  };
  w.T.ItemTags.HOES = 2;
  const oldStack = w.stack;
  w.stack = function (pickaxe, remaining) {
    const stack = oldStack(pickaxe, remaining);
    stack.is = tag => pickaxe && tag === 1;
    return stack;
  };
  w.hoe = function (remaining) {
    const stack = oldStack(true, remaining === undefined ? 90 : remaining);
    stack.is = tag => tag === 2;
    return stack;
  };
  w.hotbar[4] = w.hoe();
  inventory.getSelectedSlot = () => w.selectedSlot;
  w.water = w.lava = false;
  p.isInWater = () => w.water;
  p.isInLava = () => w.lava;
  w.motion = { x: 0, y: 0, z: 0 };
  p.getDeltaMovement = () => w.motion;
  w.sprinting = false;
  p.isSprinting = () => w.sprinting;
  p.setSprinting = value => { w.sprinting = value; };
  w.dimension = "minecraft:overworld";
  game.level.dimension = () => ({ identifier: () => w.dimension });
  w.loadedChunks = true;
  game.level.hasChunk = () => w.loadedChunks;
  game.getSingleplayerServer = () => null;
  game.getCurrentServer = () => ({ ip: "example.test" });
  w.T.LevelResource = { ROOT: "root" };
  w.gizmos = [];
  w.collections = 0;
  w.throwGizmo = false;
  game.levelRenderer = {
    collectPerFrameRenderThreadGizmos() { w.collections++; return { close() { w.collections--; } }; },
  };
  function gizmo(kind, args) {
    if (w.throwGizmo) throw new Error("gizmo failed");
    const entry = { kind, args, top: false };
    w.gizmos.push(entry);
    return { setAlwaysOnTop() { entry.top = true; } };
  }
  w.T.Gizmos = {
    cuboid(box, style) { return gizmo("box", [box, style]); },
    billboardText(text, pos, style) { return gizmo("text", [text, pos, style]); },
  };
  w.T.GizmoStyle = { strokeAndFill(stroke, width, fill) { return { stroke, width, fill }; } };
  w.T.TextStyle = { forColorAndCentered(color) { return { withScale(scale) { return { color, scale }; } }; } };
  const extra = {
    AABB: "net.minecraft.world.phys.AABB", LevelResource: "net.minecraft.world.level.storage.LevelResource",
    Gizmos: "net.minecraft.gizmos.Gizmos", GizmoStyle: "net.minecraft.gizmos.GizmoStyle", TextStyle: "net.minecraft.gizmos.TextGizmo$Style",
  };
  Object.keys(extra).forEach(key => { w.typeByName[extra[key]] = w.T[key]; });

  w.floor = function () {
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 14; z++) w.blocks.set(x + ",63," + z, w.stone);
  };
  w.walkFarm = function () {
    const opts = game.options;
    const forward = Number(opts.keyUp.down) - Number(opts.keyDown.down);
    // Verified against KeyboardInput + Entity.getInputVector: left is +X.
    const left = Number(opts.keyLeft.down) - Number(opts.keyRight.down);
    const radians = p.yaw * Math.PI / 180;
    const speed = (opts.keySprint.down ? 0.28 : 0.215) / Math.max(1, Math.sqrt(forward * forward + left * left));
    const drag = w.grounded ? 0.55 : 0.91;
    const dx = w.motion.x * drag + (-Math.sin(radians) * forward + Math.cos(radians) * left) * speed * (1 - drag);
    const dz = w.motion.z * drag + (Math.cos(radians) * forward + Math.sin(radians) * left) * speed * (1 - drag);
    if (w.grounded && opts.keyJump.down) { w.motion.y = 0.42; w.grounded = false; }
    let dy = w.motion.y;
    if (game.level.noCollision(p, p.getBoundingBox().move(dx, 0, dz))) { p.x += dx; p.z += dz; }
    const pieces = Math.max(1, Math.ceil(Math.abs(dy) / 0.01));
    w.grounded = false;
    for (let i = 0; i < pieces; i++) {
      if (game.level.noCollision(p, p.getBoundingBox().move(0, dy / pieces, 0))) p.y += dy / pieces;
      else { w.grounded = dy < 0; w.motion.y = 0; break; }
    }
    if (dy === 0) w.grounded = !game.level.noCollision(p, p.getBoundingBox().move(0, -0.01, 0));
    w.motion = { x: dx, y: w.grounded ? 0 : (w.motion.y - 0.08) * 0.98, z: dz };
  };
  return w;
}

module.exports = { createFarmWorld };
