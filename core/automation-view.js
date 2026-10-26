const { createPerspective } = require("./perspective");
const hooks = require("../mixins");
const log = require("./log");
const CameraType = Java.type("net.minecraft.client.CameraType");
// CT returns null when a new injector is registered after startup. Neither
// half of freelook may run until both hooks have been installed by a restart.
const ready = hooks.mouseTurn != null && hooks.cameraRotation != null;
const view = createPerspective({
  game: () => Client.getMinecraft(), inGui: () => Client.isInGui(),
  thirdPerson: ready ? CameraType.THIRD_PERSON_BACK : null,
});
let warned = false;

function failed(error) {
  try { view.stop(); } catch (restoreError) { log.error("Restoring automation perspective", restoreError); }
  log.error("Automation perspective", error);
}

if (ready) {
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
} else {
  log.log("Automation perspective needs a full Minecraft restart; using the normal view until then.");
}

module.exports = {
  start() {
    view.start();
    if (!ready && !warned) {
      warned = true;
      ChatLib.chat("&8[&bcenter&8]&r &eRestart Minecraft to enable automation perspective. Using your normal view for now.");
    }
  },
  stop: view.stop,
};
