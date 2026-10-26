// Movable HUD elements. A feature opts in with `hud: { size, render, ... }` in
// defineFeature(); its position is edited in the HUD editor (/center hud).
//
// Positions are stored relative to the nearest screen anchor (left/center/right,
// top/middle/bottom), chosen automatically when the element is dropped:
//   x = ax * (screenW - w) + dx      (ax, ay in {0, 0.5, 1}; dx, dy in GUI units)
// so an element dropped near the right edge stays at the same distance from the
// right edge when the window size, GUI scale or the element's own width changes.
const store = require("./store");
const draw = require("../gui/draw");
const theme = require("../gui/theme");

const ANCHORS = [0, 0.5, 1];
const DEFAULT_POS = { ax: 0, ay: 0, dx: 6, dy: 6 };
const elements = [];
let editor = null; // the editor screen; elements are drawn by it while it is open

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// typeof first: CT's Rhino (opt 9) evaluates `undefined > 0` as true.
const positive = v => typeof v === "number" && isFinite(v) && v > 0;
const finite = v => typeof v === "number" && isFinite(v);
const round2 = v => Math.round(v * 100) / 100;

function validPos(p) {
  return !!p && typeof p === "object" && ANCHORS.indexOf(p.ax) >= 0 && ANCHORS.indexOf(p.ay) >= 0 && finite(p.dx) && finite(p.dy);
}

function guiScale() {
  try { return Number(Renderer.screen.getScale()) || 2; } catch (error) { return 2; }
}

// Snap to physical pixels so rounded shapes and text stay crisp.
function toPixel(v) {
  const s = guiScale();
  return Math.round(v * s) / s;
}

function attach(feature, opts) {
  if (!opts || typeof opts.size !== "function" || typeof opts.render !== "function") {
    throw new Error(`${feature.id}: hud needs size(feature) and render(feature, size) functions`);
  }
  const el = {
    feature,
    name: opts.name || feature.name,
    size: opts.size,
    render: opts.render,
    scaleKey: typeof opts.scaleKey === "string" ? opts.scaleKey : null,
    default: validPos(opts.default) ? Object.assign({}, opts.default) : Object.assign({}, DEFAULT_POS),
  };
  elements.push(el);
  feature.on("renderOverlay", ctx => {
    if (isEditing()) return;
    const box = layout(el, ctx.guiWidth(), ctx.guiHeight(), false);
    if (box) drawElement(el, ctx, box);
  });
  return el;
}

function scaleOf(el) {
  const v = el.scaleKey ? el.feature.get(el.scaleKey) : 1;
  return positive(v) ? v : 1;
}

function getPos(el) {
  const p = store.entry(el.feature.id).hud;
  return validPos(p) ? p : el.default;
}

function isCustom(el) { return validPos(store.entry(el.feature.id).hud); }

const pickAnchor = (center, screen) => (center < screen / 3 ? 0 : center > (screen * 2) / 3 ? 1 : 0.5);

// Converts an absolute top-left position into the stored anchor form.
function toAnchor(x, y, w, h, sw, sh) {
  const ax = pickAnchor(x + w / 2, sw);
  const ay = pickAnchor(y + h / 2, sh);
  return { ax, ay, dx: round2(x - ax * (sw - w)), dy: round2(y - ay * (sh - h)) };
}

function setPos(el, x, y, w, h, sw, sh) {
  store.entry(el.feature.id).hud = toAnchor(x, y, w, h, sw, sh);
  store.markDirty();
}

function reset(el) {
  const entry = store.entry(el.feature.id);
  if (!entry.hud) return;
  delete entry.hud;
  store.markDirty();
}

// Screen-space box of an element, or null if it has nothing to draw.
// preview: let the feature measure its editor preview, with a placeholder for
// elements that still have no content. This never enables the feature.
function layout(el, sw, sh, preview) {
  const scale = scaleOf(el);
  let size = el.size(el.feature, preview === true);
  let empty = false;
  if (!size || !positive(size.w) || !positive(size.h)) {
    if (!preview) return null;
    size = { w: draw.width(el.name) + 16, h: 18 };
    empty = true;
  }
  const w = size.w * scale;
  const h = size.h * scale;
  const p = getPos(el);
  const x = toPixel(clamp(p.ax * (sw - w) + p.dx, 0, Math.max(0, sw - w)));
  const y = toPixel(clamp(p.ay * (sh - h) + p.dy, 0, Math.max(0, sh - h)));
  return { x, y, w, h, scale, size, empty };
}

// Draws an element at its box. The element renders at (0, 0) in its own units.
function drawElement(el, ctx, box) {
  draw.begin(ctx, box.scale);
  try {
    const p = draw.pushPose();
    p.translate(box.x, box.y);
    p.scale(box.scale, box.scale);
    if (box.empty) {
      draw.rrect(0, 0, box.size.w, box.size.h, 4, theme.hudBg);
      draw.text(el.name, 8, 5, theme.textMute);
    } else {
      el.render(el.feature, box.size);
    }
  } finally {
    draw.end();
  }
}

function setEditor(screen) { editor = screen; }
function isEditing() { return editor != null && Client.currentGui.get() === editor; }

module.exports = {
  attach, elements: () => elements.slice(), get: id => elements.find(e => e.feature.id === id) || null,
  layout, drawElement, getPos, setPos, reset, isCustom, toAnchor, scaleOf, setEditor, isEditing,
};
