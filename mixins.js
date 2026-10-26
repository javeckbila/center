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

module.exports = { mouseTurn, cameraRotation };
