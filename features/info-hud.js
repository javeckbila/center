// Example module: compact info panel, movable in the HUD editor (/center hud).
const { defineFeature } = require("../core/registry");
const store = require("../core/store");
const draw = require("../gui/draw");
const theme = require("../gui/theme");

const ID = "info-hud";
const PAD = 5;
const GAP = 8;
const LINE = 10;

function lines(f) {
  const out = [];
  if (f.get("coords")) out.push(["XYZ", `${Math.floor(Player.getX())} ${Math.floor(Player.getY())} ${Math.floor(Player.getZ())}`]);
  if (f.get("facing")) out.push(["Facing", String(Player.facing())]);
  if (f.get("fps")) out.push(["FPS", String(Client.getFPS())]);
  if (f.get("ping") && !Server.isSingleplayer()) {
    const ping = Server.getPing();
    out.push(["Ping", ping >= 0 ? `${ping} ms` : "n/a"]);
  }
  return out;
}

// Layout in unscaled HUD units; null = nothing to draw.
function measure(f) {
  if (!World.isLoaded()) return null;
  const rows = lines(f);
  if (!rows.length) return null;
  const labelW = Math.max.apply(null, rows.map(r => draw.width(r[0])));
  const valueW = Math.max.apply(null, rows.map(r => draw.width(r[1])));
  return { rows, labelW, w: PAD * 2 + labelW + GAP + valueW, h: PAD * 2 + rows.length * LINE - 2 };
}

function render(f, size) {
  const background = f.get("background");
  if (background) draw.rrect(0, 0, size.w, size.h, 4, theme.hudBg);
  size.rows.forEach((r, i) => {
    const ty = PAD + i * LINE;
    draw.text(r[0], PAD, ty, f.get("labelColor"), 1, !background);
    draw.text(r[1], PAD + size.labelW + GAP, ty, theme.text, 1, !background);
  });
}

// Older versions stored a fixed corner; turn it into a free position once.
(function migrateCorner() {
  const entry = store.entry(ID);
  const corner = entry.values.corner;
  if (typeof corner !== "string") return;
  delete entry.values.corner;
  if (!entry.hud && corner !== "Top left") { // top left is the default position
    const right = corner.indexOf("right") >= 0;
    const bottom = corner.indexOf("Bottom") === 0;
    entry.hud = { ax: right ? 1 : 0, ay: bottom ? 1 : 0, dx: right ? -6 : 6, dy: bottom ? -6 : 6 };
  }
  store.markDirty();
})();

module.exports = defineFeature({
  id: ID,
  name: "Info HUD",
  category: "Render",
  description: "Coordinates, facing, FPS and ping. Drag it anywhere with /center hud.",
  settings: [
    { type: "toggle", key: "coords", name: "Coordinates", default: true },
    { type: "toggle", key: "facing", name: "Facing", default: true },
    { type: "toggle", key: "fps", name: "FPS", default: true },
    { type: "toggle", key: "ping", name: "Ping", default: false, description: "Latency reported by the server. Hidden in singleplayer." },
    { type: "slider", key: "scale", name: "Scale", min: 0.5, max: 2, step: 0.25, default: 1, unit: "x" },
    { type: "toggle", key: "background", name: "Background", default: true },
    {
      type: "color", key: "labelColor", name: "Label color",
      options: theme.ACCENTS.map(a => a.color), labels: theme.ACCENTS.map(a => a.name), default: theme.ACCENTS[0].color,
    },
  ],
  hud: { size: measure, render, scaleKey: "scale", default: { ax: 0, ay: 0, dx: 6, dy: 6 } },
});
