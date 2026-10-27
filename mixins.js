// Loaded before Minecraft classes. Keep this file free of runtime imports.
// Intercept only physical mouse turning; automation still sets player rotation.
const mouseMixin = new Mixin("net.minecraft.client.MouseHandler");
const mouseTurn = mouseMixin.modifyArgs({
  method: "turnPlayer(D)V",
  at: new At({ value: "INVOKE", target: "Lnet/minecraft/client/player/LocalPlayer;turn(DD)V" }),
  require: 1,
});

// Replace the view angles BEFORE vanilla moves the third-person camera back
// and clips it against walls. Picking continues to use the player's rotation.
const cameraMixin = new Mixin("net.minecraft.client.Camera");
const cameraRotation = cameraMixin.modifyArgs({
  method: "alignWithEntity(F)V",
  at: new At({ value: "INVOKE", target: "Lnet/minecraft/client/Camera;setRotation(FF)V" }),
  require: 1,
});

// Farm Hitboxes: each crop class overrides getShape, so each needs its own hook.
// The CollisionContext parameter lets the callback change only the local
// player's outline/raycast queries; collision passes CollisionContext.empty().
const SHAPE_METHOD = "getShape(Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/world/level/BlockGetter;" +
  "Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/phys/shapes/CollisionContext;)Lnet/minecraft/world/phys/shapes/VoxelShape;";
const farmShape = block => new Mixin(`net.minecraft.world.level.block.${block}`).modifyReturnValue({
  method: SHAPE_METHOD,
  at: new At("RETURN"),
  locals: new Local({ type: "Lnet/minecraft/world/phys/shapes/CollisionContext;", ordinal: 0 }),
});
const farmShapes = {};
["CropBlock", "CarrotBlock", "PotatoBlock", "BeetrootBlock", "TorchflowerCropBlock", "NetherWartBlock",
  "MushroomBlock", "NetherFungusBlock", "CocoaBlock", "SugarCaneBlock", "SweetBerryBushBlock"]
  .forEach(block => { farmShapes[block] = farmShape(block); });

module.exports = { mouseTurn, cameraRotation, farmShapes };
