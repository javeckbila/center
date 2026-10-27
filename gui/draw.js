// Immediate-mode drawing helpers on top of GuiGraphicsExtractor (ctx).
// Rounded shapes are rasterised in physical pixels (pose scaled by 1/guiScale)
// so corners stay smooth at every GUI scale.
const S = { ctx: null, font: null, scale: 2, alpha: 1, poses: 0, scissors: 0 };
const arcs = new Map();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function font() {
  if (!S.font) S.font = Renderer.getFontRenderer();
  return S.font;
}

// extraScale: any pose scale the caller applies on top of the GUI scale.
function begin(ctx, extraScale) {
  S.ctx = ctx;
  S.alpha = 1;
  S.poses = 0;
  S.scissors = 0;
  let scale = 2;
  try { scale = Number(Renderer.screen.getScale()) || 2; } catch (error) { scale = 2; }
  S.scale = scale * (extraScale || 1);
}

// Pops anything left on the stacks (e.g. after an exception mid-frame).
function end() {
  while (S.scissors > 0) { S.ctx.disableScissor(); S.scissors--; }
  while (S.poses > 0) { S.ctx.pose().popMatrix(); S.poses--; }
  S.alpha = 1;
}

function setAlpha(a) { S.alpha = clamp(a, 0, 1); }

function pushPose() { S.ctx.pose().pushMatrix(); S.poses++; return S.ctx.pose(); }
function popPose() { if (S.poses > 0) { S.ctx.pose().popMatrix(); S.poses--; } }

function pushScissor(x0, y0, x1, y1) {
  S.ctx.enableScissor(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
  S.scissors++;
}
function popScissor() { if (S.scissors > 0) { S.ctx.disableScissor(); S.scissors--; } }

// ARGB number -> signed int for Java, with alpha multiplied by a and the global alpha.
function col(c, a) {
  const alpha = clamp(Math.round(((c >>> 24) & 0xFF) * (a == null ? 1 : a) * S.alpha), 0, 255);
  return ((alpha << 24) | (c & 0xFFFFFF)) | 0;
}

function mix(a, b, t) {
  t = clamp(t, 0, 1);
  const ch = shift => {
    const x = (a >>> shift) & 0xFF;
    const y = (b >>> shift) & 0xFF;
    return Math.round(x + (y - x) * t);
  };
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

function rect(x, y, w, h, c, a) {
  if (w <= 0 || h <= 0) return;
  const color = col(c, a);
  if ((color >>> 24) === 0) return;
  S.ctx.fill(Math.round(x), Math.round(y), Math.round(x + w), Math.round(y + h), color);
}

// Row spans for a quarter circle of radius R px, grouped by equal inset.
function arc(R) {
  let rows = arcs.get(R);
  if (rows) return rows;
  rows = [];
  for (let i = 0; i < R; i++) {
    const dy = R - i - 0.5;
    const inset = Math.round(R - Math.sqrt(R * R - dy * dy));
    const last = rows[rows.length - 1];
    if (last && last[2] === inset) last[1] = i + 1;
    else rows.push([i, i + 1, inset]);
  }
  arcs.set(R, rows);
  return rows;
}

function fillRoundPx(X, Y, W, H, R, color) {
  const ctx = S.ctx;
  R = Math.max(0, Math.min(R, Math.floor(W / 2), Math.floor(H / 2)));
  if (R === 0) { ctx.fill(X, Y, X + W, Y + H, color); return; }
  if (H - 2 * R > 0) ctx.fill(X, Y + R, X + W, Y + H - R, color);
  const rows = arc(R);
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    ctx.fill(X + r[2], Y + r[0], X + W - r[2], Y + r[1], color);
    ctx.fill(X + r[2], Y + H - r[1], X + W - r[2], Y + H - r[0], color);
  }
}

function toPx(x, y, w, h) {
  const s = S.scale;
  const X = Math.round(x * s);
  const Y = Math.round(y * s);
  return [X, Y, Math.round((x + w) * s) - X, Math.round((y + h) * s) - Y];
}

function inDevice(fn) {
  const p = pushPose();
  p.scale(1 / S.scale, 1 / S.scale);
  try { fn(); } finally { popPose(); }
}

function rrect(x, y, w, h, r, c, a) {
  const color = col(c, a);
  if ((color >>> 24) === 0 || w <= 0 || h <= 0) return;
  const px = toPx(x, y, w, h);
  if (px[2] <= 0 || px[3] <= 0) return;
  inDevice(() => fillRoundPx(px[0], px[1], px[2], px[3], Math.round(r * S.scale), color));
}

// Rounded rectangle with a 1 physical-pixel border.
function panel(x, y, w, h, r, bg, border, a) {
  const bgc = col(bg, a);
  const bc = col(border, a);
  const px = toPx(x, y, w, h);
  if (px[2] <= 2 || px[3] <= 2) return;
  const R = Math.round(r * S.scale);
  inDevice(() => {
    if ((bc >>> 24) !== 0) fillRoundPx(px[0], px[1], px[2], px[3], R, bc);
    if ((bgc >>> 24) !== 0) fillRoundPx(px[0] + 1, px[1] + 1, px[2] - 2, px[3] - 2, Math.max(0, R - 1), bgc);
  });
}

function text(str, x, y, c, a, shadow) {
  if (str == null || str === "") return;
  if ((a == null ? 1 : a) * S.alpha < 0.1) return; // near-zero alpha text may render opaque
  S.ctx.text(font(), String(str), Math.round(x), Math.round(y), col(c, a), !!shadow);
}

// 16x16 item icon; decorations = stack count, durability bar and cooldown, as in inventories.
function item(stack, x, y, decorations) {
  if (stack == null || stack.isEmpty()) return;
  const ix = Math.round(x);
  const iy = Math.round(y);
  S.ctx.item(stack, ix, iy);
  if (decorations !== false) S.ctx.itemDecorations(font(), stack, ix, iy);
}

function width(str) { return str == null ? 0 : font().width(String(str)); }

function truncate(str, maxW) {
  str = String(str);
  if (width(str) <= maxW) return str;
  if (maxW <= width("...")) return "";
  return String(font().plainSubstrByWidth(str, Math.max(0, Math.floor(maxW - width("..."))))) + "...";
}

// Keeps the end of the string visible (for text inputs).
function tail(str, maxW) {
  str = String(str);
  while (str.length && width(str) > maxW) str = str.slice(1);
  return str;
}

function wrap(str, maxW) {
  const lines = [];
  String(str).split("\n").forEach(paragraph => {
    let line = "";
    paragraph.split(" ").forEach(word => {
      const next = line ? line + " " + word : word;
      if (line && width(next) > maxW) { lines.push(line); line = word; } else line = next;
    });
    lines.push(line);
  });
  return lines;
}

// Pixel glyphs in GUI units: chevrons are 5x3 (up/down) or 3x5 (left/right).
const GLYPHS = {
  down: [[0, 0], [4, 0], [1, 1], [3, 1], [2, 2]],
  up: [[2, 0], [1, 1], [3, 1], [0, 2], [4, 2]],
  right: [[0, 0], [1, 1], [2, 2], [1, 3], [0, 4]],
  left: [[2, 0], [1, 1], [0, 2], [1, 3], [2, 4]],
  cross: [[0, 0], [4, 0], [1, 1], [3, 1], [2, 2], [1, 3], [3, 3], [0, 4], [4, 4]],
};

function glyph(nameOf, x, y, c, a) {
  const color = col(c, a);
  if ((color >>> 24) === 0) return;
  const gx = Math.round(x);
  const gy = Math.round(y);
  GLYPHS[nameOf].forEach(p => S.ctx.fill(gx + p[0], gy + p[1], gx + p[0] + 1, gy + p[1] + 1, color));
}

function magnifier(x, y, c, bg) {
  rrect(x, y, 6, 6, 3, c);
  rrect(x + 1, y + 1, 4, 4, 2, bg);
  rect(x + 5, y + 5, 1, 1, c);
  rect(x + 6, y + 6, 1, 1, c);
}

module.exports = {
  begin, end, setAlpha, pushPose, popPose, pushScissor, popScissor,
  col, mix, rect, rrect, panel, text, item, width, truncate, tail, wrap, glyph, magnifier,
};
