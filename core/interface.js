// The menu's own settings, shown on the "Settings" page.
const { defineFeature } = require("./registry");
const theme = require("../gui/theme");

module.exports = defineFeature({
  id: "center",
  name: "Interface",
  description: "Look and behaviour of this menu.",
  hidden: true,
  toggleable: false,
  settings: [
    {
      type: "color", key: "accent", name: "Accent color",
      options: theme.ACCENTS.map(a => a.color), labels: theme.ACCENTS.map(a => a.name),
      default: theme.ACCENTS[0].color,
    },
    {
      type: "keybind", key: "openKey", name: "Menu key", default: Keyboard.KEY_RSHIFT,
      description: "Opens this menu in-game. Right-click to clear; /center always works.",
    },
    { type: "toggle", key: "animations", name: "Animations", default: true },
    { type: "toggle", key: "dim", name: "Dim background", default: true },
    {
      type: "toggle", key: "notifications", name: "Toggle notifications", default: true,
      description: "Show a small popup when a module is toggled with its key.",
    },
  ],
});
