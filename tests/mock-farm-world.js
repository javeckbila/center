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
    const right = Number(opts.keyRight.down) - Number(opts.keyLeft.down);
    const radians = p.yaw * Math.PI / 180;
    const speed = (opts.keySprint.down ? 0.28 : 0.215) / Math.max(1, Math.sqrt(forward * forward + right * right));
    const dx = (-Math.sin(radians) * forward + Math.cos(radians) * right) * speed;
    const dz = (Math.cos(radians) * forward + Math.sin(radians) * right) * speed;
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
