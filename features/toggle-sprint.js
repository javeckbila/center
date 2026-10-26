// Example module without settings: keeps the sprint key held.
const { defineFeature } = require("../core/registry");

let holding = false;
const sprintKey = () => Client.getMinecraft().options.keySprint;

function release() {
  if (!holding) return;
  holding = false;
  const key = sprintKey();
  if (!key.isDown()) return;
  key.setDown(false);
  // In "Sprint: Toggle" mode setDown(false) is ignored; a press toggles it off.
  if (key.isDown()) key.setDown(true);
}

module.exports = defineFeature({
  id: "toggle-sprint",
  name: "Toggle Sprint",
  category: "Movement",
  description: "Keeps the sprint key held while enabled.",
  setup(f) {
    f.on("tick", () => {
      if (!World.isLoaded()) return;
      const key = sprintKey();
      if (!key.isDown()) key.setDown(true);
      holding = true;
    });
  },
  onDisable: release,
});
