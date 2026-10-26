// Small bottom-right popups when a module is toggled with its key.
const theme = require("./theme");
const draw = require("./draw");
const registry = require("../core/registry");
const iface = require("../core/interface");

const System = Java.type("java.lang.System");
const now = () => System.nanoTime() / 1e9;
const LIFE = 2.2;
const items = [];
let lastError = 0;

registry.onToggle((feature, enabled, source) => {
  if (source !== "key" || !iface.get("notifications")) return;
  items.push({ name: feature.name, enabled, born: now() });
  while (items.length > 4) items.shift();
});

function render(ctx) {
  const t = now();
  while (items.length && t - items[0].born > LIFE) items.shift();
  if (!items.length) return;
  const animate = iface.get("animations");
  const accent = iface.get("accent");
  draw.begin(ctx);
  try {
    const sw = ctx.guiWidth();
    let y = ctx.guiHeight() - 10;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const age = t - item.born;
      const appear = animate ? 1 - Math.pow(1 - Math.min(1, age / 0.18), 3) : 1;
      const alpha = Math.min(appear, Math.min(1, (LIFE - age) / 0.35));
      const status = item.enabled ? "Enabled" : "Disabled";
      const w = 22 + draw.width(item.name) + 12 + draw.width(status) + 10;
      const h = 20;
      const x = sw - 10 - w + (1 - appear) * 16;
      y -= h;
      draw.setAlpha(alpha);
      draw.panel(x, y, w, h, 5, theme.bg, theme.border);
      draw.rrect(x + 9, y + 7, 6, 6, 3, item.enabled ? accent : theme.textMute);
      draw.text(item.name, x + 22, y + 6, theme.text);
      draw.text(status, x + w - 10 - draw.width(status), y + 6, item.enabled ? accent : theme.textDim);
      y -= 4;
    }
  } finally {
    draw.end();
  }
}

register("renderOverlay", ctx => {
  try { render(ctx); } catch (error) {
    if (Date.now() - lastError > 2000) { lastError = Date.now(); console.error(`[center] notifications: ${error}`); }
  }
});
