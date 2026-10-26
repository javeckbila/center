const { createPerspective } = require("./perspective");
const hooks = require("../mixins");
const log = require("./log");
const CameraType = Java.type("net.minecraft.client.CameraType");
const view = createPerspective({
  game: () => Client.getMinecraft(), inGui: () => Client.isInGui(),
  thirdPerson: CameraType.THIRD_PERSON_BACK,
});

function failed(error) {
  try { view.stop(); } catch (restoreError) { log.error("Restoring automation perspective", restoreError); }
  log.error("Automation perspective", error);
}

hooks.mouseTurn.attach((mouse, args) => {
  try {
    if (!view.turn(Number(args.get(0)), Number(args.get(1)))) return;
    args.set(0, new java.lang.Double(0));
    args.set(1, new java.lang.Double(0));
  } catch (error) { failed(error); }
});

hooks.cameraRotation.attach((camera, args) => {
  try {
    const angles = view.rotation(camera.entity());
    if (!angles) return;
    args.set(0, new java.lang.Float(angles.yaw));
    args.set(1, new java.lang.Float(angles.pitch));
  } catch (error) { failed(error); }
});

module.exports = view;
