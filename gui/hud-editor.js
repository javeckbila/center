// HUD editor: preview and position every HUD element, including disabled features.
//   drag            move (snaps to screen edges/center and other elements)
//   Shift + drag    move without snapping
//   scroll          change the element's scale (if it has one)
//   right-click     reset to its default position (Delete/Backspace on the selection too)
//   arrow keys      nudge the selected element 1px (Shift: 10px)
//   Esc / Enter     done (returns to the menu if opened from it)
const theme = require("./theme");
const draw = require("./draw");
const show = require("./show");
const hud = require("../core/hud");
const store = require("../core/store");
const iface = require("../core/interface");
const log = require("../core/log");

let Cursors = null;
try { Cursors = Java.type("com.mojang.blaze3d.platform.cursor.CursorTypes"); } catch (error) { Cursors = null; }

const SNAP = 4; // GUI units
const HINTS = [
  "Drag to move  \u00B7  Scroll to scale  \u00B7  Right-click to reset",
  "Shift: no snapping  \u00B7  Arrows: nudge  \u00B7  Esc: done",
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const state = {
  drag: null,     // { el, gx, gy } grab offset inside the element
  selected: null, // feature id
  boxes: [],      // [{ el, box }] from the last frame, in draw order
  buttons: [],    // [{ x, y, w, h, onClick }]
  sw: 0,
  sh: 0,
  returnTo: null,
  lastError: 0,
};

const visible = () => hud.elements();
const inBox = (b, mx, my) => mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function topmostAt(mx, my) {
  for (let i = state.boxes.length - 1; i >= 0; i--) if (inBox(state.boxes[i].box, mx, my)) return state.boxes[i];
  return null;
}

// Snaps one axis: lines of the moving element (start, middle, end) to targets.
function snapAxis(pos, size, targets) {
  let best = null;
  [0, size / 2, size].forEach(offset => {
    targets.forEach(t => {
      const d = t - (pos + offset);
      if (Math.abs(d) <= SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    });
  });
  return best;
}

function targetsFor(axis, size, others) {
  const out = [0, size / 2, size];
  others.forEach(b => {
    const p = axis === "x" ? b.x : b.y;
    const s = axis === "x" ? b.w : b.h;
    out.push(p, p + s / 2, p + s);
  });
  return out;
}

// Moves the dragged element to follow the mouse; returns snap guides to draw.
function dragTo(mx, my, sw, sh) {
  const el = state.drag.el;
  const box = hud.layout(el, sw, sh, true);
  let x = clamp(mx - state.drag.gx, 0, Math.max(0, sw - box.w));
  let y = clamp(my - state.drag.gy, 0, Math.max(0, sh - box.h));
  const guides = [];
  if (!Keyboard.isShiftKeyDown()) {
    const others = state.boxes.filter(b => b.el !== el).map(b => b.box);
    const sx = snapAxis(x, box.w, targetsFor("x", sw, others));
    const sy = snapAxis(y, box.h, targetsFor("y", sh, others));
    if (sx) { x = clamp(x + sx.d, 0, Math.max(0, sw - box.w)); guides.push({ axis: "x", at: sx.at }); }
    if (sy) { y = clamp(y + sy.d, 0, Math.max(0, sh - box.h)); guides.push({ axis: "y", at: sy.at }); }
  }
  hud.setPos(el, x, y, box.w, box.h, sw, sh);
  return guides;
}

function outline(b, c, a) {
  draw.rect(b.x - 1, b.y - 1, b.w + 2, 1, c, a);
  draw.rect(b.x - 1, b.y + b.h, b.w + 2, 1, c, a);
  draw.rect(b.x - 1, b.y, 1, b.h, c, a);
  draw.rect(b.x + b.w, b.y, 1, b.h, c, a);
}

function nameChip(el, b, accent, sw) {
  const scale = el.scaleKey ? `  ${hud.scaleOf(el)}x` : "";
  const txt = el.name + scale;
  const w = draw.width(txt) + 8;
  const x = clamp(b.x, 0, Math.max(0, sw - w));
  const y = b.y - 13 >= 0 ? b.y - 13 : b.y + b.h + 2;
  draw.rrect(x, y, w, 11, 3, theme.bg, 0.92);
  draw.text(el.name, x + 4, y + 2, theme.text);
  if (scale) draw.text(scale, x + 4 + draw.width(el.name), y + 2, accent);
}

function button(txt, x, y, onClick, mx, my, primary, accent) {
  const w = draw.width(txt) + 16;
  const b = { x, y, w, h: 14, onClick };
  const hov = inBox(b, mx, my);
  const bg = primary ? draw.mix(accent, 0xFFFFFFFF, hov ? 0.12 : 0) : hov ? theme.surfaceHi : theme.input;
  draw.panel(x, y, w, 14, 4, bg, primary ? accent : hov ? theme.borderHi : theme.border);
  draw.text(txt, x + 8, y + 3, primary ? 0xFFFFFFFF : hov ? theme.text : theme.textDim);
  state.buttons.push(b);
  return hov;
}

function resetAll() { hud.elements().forEach(el => hud.reset(el)); }

function drawToolbar(mx, my, sw, sh, accent, count) {
  const lines = count ? HINTS : ["No HUD modules are available.", "Installed HUD modules appear here automatically."];
  const w = Math.max.apply(null, lines.map(l => draw.width(l))) + 24;
  const h = 8 + 10 + 4 + lines.length * 10 + 6 + 14 + 8;
  const x = Math.floor((sw - w) / 2);
  // Keep the toolbar off the elements so they stay grabbable.
  const spots = [0.5, 0.25, 0.75, 0.08, 0.92].map(f => Math.floor(clamp(sh * f - h / 2, 2, sh - h - 2)));
  const y = spots.find(sy => !state.boxes.some(b => overlaps({ x, y: sy, w, h }, b.box))) || spots[0];
  draw.panel(x, y, w, h, 6, theme.bg, theme.border, 0.96);
  draw.rrect(x + 12, y + 9, 8, 8, 2, accent);
  draw.text("HUD editor", x + 25, y + 9, theme.text);
  lines.forEach((l, i) => draw.text(l, x + 12, y + 22 + i * 10, theme.textMute));
  const by = y + h - 8 - 14;
  let hov = false;
  const doneW = draw.width("Done") + 16;
  hov = button("Done", x + w - 12 - doneW, by, finish, mx, my, true, accent) || hov;
  if (count) hov = button("Reset all", x + w - 12 - doneW - 6 - (draw.width("Reset all") + 16), by, resetAll, mx, my, false, accent) || hov;
  return hov;
}

function render(ctx, mx, my) {
  const sw = ctx.guiWidth();
  const sh = ctx.guiHeight();
  state.sw = sw;
  state.sh = sh;
  state.buttons = [];
  const accent = iface.get("accent");
  const els = visible();

  let guides = [];
  if (state.drag && els.indexOf(state.drag.el) < 0) state.drag = null;
  if (state.drag) guides = dragTo(mx, my, sw, sh);

  draw.begin(ctx);
  try {
    draw.rect(0, 0, sw, sh, 0xFF000000, 0.35);
    // Faint center lines as a reference.
    draw.rect(Math.floor(sw / 2), 0, 1, sh, 0xFFFFFFFF, 0.06);
    draw.rect(0, Math.floor(sh / 2), sw, 1, 0xFFFFFFFF, 0.06);
  } finally { draw.end(); }

  state.boxes = [];
  els.forEach(el => {
    const box = hud.layout(el, sw, sh, true);
    if (!box) return;
    try { hud.drawElement(el, ctx, box); } catch (error) { el.feature.fail(error); }
    state.boxes.push({ el, box });
  });

  draw.begin(ctx);
  try {
    const hovered = state.drag ? null : topmostAt(mx, my);
    state.boxes.forEach(({ el, box }) => {
      const active = (state.drag && state.drag.el === el) || state.selected === el.feature.id;
      const hot = active || (hovered && hovered.el === el);
      outline(box, hot ? accent : 0xFFFFFFFF, hot ? 1 : 0.25);
      if (hot) nameChip(el, box, accent, sw);
    });
    guides.forEach(g => {
      if (g.axis === "x") draw.rect(clamp(Math.round(g.at), 0, sw - 1), 0, 1, sh, accent, 0.8);
      else draw.rect(0, clamp(Math.round(g.at), 0, sh - 1), sw, 1, accent, 0.8);
    });
    const overButton = state.drag ? false : drawToolbar(mx, my, sw, sh, accent, state.boxes.length);
    if (Cursors) {
      try {
        if (overButton) ctx.requestCursor(Cursors.POINTING_HAND);
        else if (state.drag || topmostAt(mx, my)) ctx.requestCursor(Cursors.RESIZE_ALL);
      } catch (error) { Cursors = null; }
    }
  } finally { draw.end(); }
}

// ---------- input ----------

function onClick(mx, my, btn) {
  const b = state.buttons.find(x => inBox(x, mx, my));
  if (b) { if (btn === 0) b.onClick(); return; }
  const hit = topmostAt(mx, my);
  if (!hit) { state.selected = null; return; }
  state.selected = hit.el.feature.id;
  if (btn === 1) { hud.reset(hit.el); return; }
  if (btn === 0) state.drag = { el: hit.el, gx: mx - hit.box.x, gy: my - hit.box.y };
}

function selectedBox() { return state.boxes.find(b => b.el.feature.id === state.selected) || null; }

function onScroll(mx, my, delta) {
  const hit = topmostAt(mx, my) || selectedBox();
  if (!hit || !hit.el.scaleKey || !delta) return;
  const f = hit.el.feature;
  const s = f.setting(hit.el.scaleKey);
  const step = s && s.step ? s.step : 0.1;
  f.set(hit.el.scaleKey, hud.scaleOf(hit.el) + (delta > 0 ? step : -step));
  state.selected = f.id;
}

function finish() {
  state.drag = null;
  const back = state.returnTo;
  state.returnTo = null;
  show.setScreen(back || null);
}

function onKey(ch, code) {
  if (code === Keyboard.KEY_ESCAPE || code === Keyboard.KEY_ENTER || code === Keyboard.KEY_NUMPADENTER) { finish(); return; }
  const sel = selectedBox();
  if (!sel || state.drag) return;
  if (code === Keyboard.KEY_DELETE || code === Keyboard.KEY_BACKSPACE) { hud.reset(sel.el); return; }
  const n = Keyboard.isShiftKeyDown() ? 10 : 1;
  const d = { [Keyboard.KEY_LEFT]: [-n, 0], [Keyboard.KEY_RIGHT]: [n, 0], [Keyboard.KEY_UP]: [0, -n], [Keyboard.KEY_DOWN]: [0, n] }[code];
  if (!d) return;
  const b = sel.box;
  const x = clamp(b.x + d[0], 0, Math.max(0, state.sw - b.w));
  const y = clamp(b.y + d[1], 0, Math.max(0, state.sh - b.h));
  hud.setPos(sel.el, x, y, b.w, b.h, state.sw, state.sh);
}

function guard(name, fn) {
  return function () {
    try { return fn.apply(null, arguments); } catch (error) {
      const t = Date.now();
      if (t - state.lastError > 2000) { state.lastError = t; log.error(`hud editor ${name}`, error); }
    }
  };
}

const gui = new Gui();
gui.setDoesPauseGame(false);
gui.registerDraw(guard("draw", (ctx, mx, my) => render(ctx, mx, my)));
gui.registerClicked(guard("click", (mx, my, btn) => onClick(mx, my, btn)));
gui.registerMouseReleased(guard("release", () => { state.drag = null; }));
gui.registerScrolled(guard("scroll", (mx, my, delta) => onScroll(mx, my, delta)));
gui.registerKeyTyped(guard("key", (ch, code) => onKey(ch, code)));
gui.registerOpened(guard("open", () => { state.drag = null; state.boxes = []; }));
gui.registerClosed(guard("close", () => { state.drag = null; store.flush(); }));
hud.setEditor(gui);

// returnTo: screen to show when done (the menu), or null to return to the game.
function open(source, returnTo) {
  state.selected = null;
  state.returnTo = returnTo || null;
  if (returnTo) show.setScreen(gui); // already inside a screen; switch immediately
  else show.openWhenFree(gui, "hud editor", source);
}
function isOpen() { return Client.currentGui.get() === gui; }

module.exports = { open, isOpen, _test: { state, render, onClick, onKey, onScroll, gui } };
