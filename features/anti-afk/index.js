const registry = require("../../core/registry");
const { defer } = require("../../core/defer");
const { createAntiAfk } = require("./controller");

let controller = null;

module.exports = registry.defineFeature({
  id: "anti-afk",
  name: "Anti AFK",
  category: "Automation",
  description: "Every few seconds, turn, take a small side step, jump, crouch and tap attack. Pauses while screens or manual controls are in use.",
  persistEnabled: false,
  settings: [
    { type: "slider", key: "interval", name: "Action interval", min: 2, max: 30, step: 1, default: 4, unit: "s" },
    { type: "toggle", key: "rotate", name: "Rotate", default: true },
    { type: "slider", key: "turnAngle", name: "Turn angle", min: 5, max: 90, step: 5, default: 20, unit: "deg", visible: f => f.get("rotate") },
    { type: "toggle", key: "move", name: "Small side steps", default: true,
      description: "Briefly steps left and right on alternating cycles." },
    { type: "toggle", key: "jump", name: "Jump", default: true },
    { type: "toggle", key: "crouch", name: "Crouch", default: true },
    { type: "toggle", key: "attack", name: "Attack", default: true,
      description: "One attack at the crosshair per cycle. Can hit entities or break blocks." },
  ],
  setup(f) {
    controller = createAntiAfk({
      T: {
        HitType: Java.type("net.minecraft.world.phys.HitResult$Type"),
        InteractionHand: Java.type("net.minecraft.world.InteractionHand"),
      },
      game: () => Client.getMinecraft(), loaded: () => World.isLoaded(),
      inGui: () => Client.isInGui(), setting: key => f.get(key),
    });
    const stop = () => {
      try { controller.stop(); }
      finally { defer(() => { if (f.isEnabled()) f.setEnabled(false, "anti-afk-stop"); }); }
    };
    f.on("tick", () => {
      try { controller.tick(); }
      catch (error) { f.fail(error); stop(); }
    });
    f.on("guiOpened", () => controller.stop());
    f.on("worldUnload", stop);
    f.on("serverDisconnect", stop);
    registry.onToggle((other, on) => {
      if (on && ["auto-miner", "auto-farm"].indexOf(other.id) >= 0 && f.isEnabled()) f.setEnabled(false, "automation-conflict");
    });
  },
  onEnable() {
    ["auto-miner", "auto-farm"].forEach(id => {
      const other = registry.get(id);
      if (other && other.isEnabled()) other.setEnabled(false, "automation-conflict");
    });
    controller.start();
  },
  onDisable() { if (controller) controller.stop(); },
  onChange() { if (controller) controller.stop(); },
});
