// Main menu. Immediate-mode: every frame draws the UI and records clickable
// regions; mouse/key callbacks act on the regions from the last frame.
const theme = require("./theme");
const draw = require("./draw");
const registry = require("../core/registry");
const store = require("../core/store");
const keys = require("../core/keys");
const iface = require("../core/interface");
const log = require("../core/log");
const show = require("./show");
const hudEditor = require("./hud-editor");
const hud = require("../core/hud");

const System = Java.type("java.lang.System");
const now = () => System.nanoTime() / 1e9;
let Cursors = null;
try { Cursors = Java.type("com.mojang.blaze3d.platform.cursor.CursorTypes"); } catch (error) { Cursors = null; }

const VERSION = (() => {
  try { return String(JSON.parse(FileLib.read(store.MODULE, "metadata.json")).version || ""); } catch (error) { return ""; }
})();

const ALL = "__all";
const SETTINGS = "__settings";
const HEADER = 28;
const CARD_HEAD = 36;
const ROW = 22;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

const state = {
  page: ALL,
  search: "",
  focus: null, // { kind: "search" } | { kind: "text", id, key } | { kind: "bind", ref, set }
  scroll: 0,
  scrollTarget: 0,
  maxScroll: 0,
  expanded: {},
  drag: null,
  openedAt: 0,
  last: 0,
  dt: 0,
  caretT: 0,
  regions: [],
  lastError: 0,
  openKeyHeld: false, // the menu key is still held from the press that opened the menu
};
const anims = new Map();
let ui = null; // per-frame context

// ---------- frame helpers ----------

function anim(key, target, speed) {
  const prev = anims.get(key);
  if (!ui.animations || prev === undefined) { anims.set(key, target); return target; }
  let v = prev + (target - prev) * (1 - Math.exp(-(speed || 16) * state.dt));
  if (Math.abs(target - v) < 0.002) v = target;
  anims.set(key, v);
  return v;
}

function inClip(clip, mx, my) {
  return !clip || (mx >= clip.x0 && mx < clip.x1 && my >= clip.y0 && my < clip.y1);
}

// Coordinates are in drawing space; ui.oy converts to screen space (scroll).
function hovering(x, y, w, h) {
  const sy = y + ui.oy;
  return inClip(ui.clip, ui.mx, ui.my) && ui.mx >= x && ui.mx < x + w && ui.my >= sy && ui.my < sy + h;
}

function region(x, y, w, h, onClick, cursor) {
  ui.regions.push({ x, y: y + ui.oy, w, h, clip: ui.clip, onClick });
  const hov = hovering(x, y, w, h);
  if (hov) ui.cursor = cursor || "hand";
  return hov;
}

function pushClip(x, y, w, h) {
  const sy = y + ui.oy;
  const parent = ui.clip;
  const clip = { x0: x, y0: sy, x1: x + w, y1: sy + h };
  if (parent) {
    clip.x0 = Math.max(clip.x0, parent.x0); clip.y0 = Math.max(clip.y0, parent.y0);
    clip.x1 = Math.min(clip.x1, parent.x1); clip.y1 = Math.min(clip.y1, parent.y1);
  }
  ui.clips.push(parent);
  ui.clip = clip;
  draw.pushScissor(x, y, x + w, y + h); // scissor is transformed by the pose, so drawing space is correct
}

function popClip() {
  ui.clip = ui.clips.pop() || null;
  draw.popScissor();
}

function resetScroll() { state.scroll = 0; state.scrollTarget = 0; }

function isFocus(kind, a, b) {
  const f = state.focus;
  if (!f || f.kind !== kind) return false;
  if (kind === "text") return f.id === a && f.key === b;
  if (kind === "bind") return f.ref === a;
  return true;
}

function caret(x, y) {
  if (Math.floor((ui.t - state.caretT) * 2) % 2 === 0) draw.rect(x, y, 1, 9, theme.text);
}

function setSearch(value) {
  state.search = value;
  if (value && state.page === SETTINGS) state.page = ALL;
  resetScroll();
}

function selectPage(id) {
  state.page = id;
  state.search = "";
  resetScroll();
}

const setScreen = show.setScreen;
function close() { if (Client.currentGui.get() === gui) setScreen(null); }
function editHud() { hudEditor.open("menu", gui); }

function visibleFeatures() {
  const q = state.search.trim().toLowerCase();
  let list = registry.all();
  if (q) return list.filter(f => (f.name + " " + f.description + " " + f.category).toLowerCase().indexOf(q) >= 0);
  if (state.page !== ALL) list = list.filter(f => f.category === state.page);
  return list;
}

function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

// ---------- controls ----------

function toggleSwitch(x, y, w, h, t, hover) {
  const off = hover ? theme.trackHi : theme.track;
  draw.rrect(x, y, w, h, h / 2, draw.mix(off, ui.accent, t));
  const d = h - 4;
  draw.rrect(x + 2 + (w - 4 - d) * t, y + 2, d, d, d / 2, theme.knob);
}

function label(str, description, x, y, maxW) {
  const shown = draw.truncate(str, Math.max(0, maxW));
  draw.text(shown, x, y + 7, theme.textDim);
  if (description && hovering(x, y, draw.width(shown) + 4, ROW)) ui.tooltip = description;
}

function button(txt, right, y, onClick) {
  const bw = draw.width(txt) + 18;
  const bx = right - bw;
  const hov = region(bx, y + 4, bw, 14, onClick);
  draw.panel(bx, y + 4, bw, 14, 4, hov ? theme.surfaceHi : theme.input, hov ? theme.borderHi : theme.border);
  draw.text(txt, bx + 9, y + 7, hov ? theme.text : theme.textDim);
  return bw;
}

// ref: unique id for capture state; set(code) stores the new key (-1 = none).
function keybindBox(ref, code, right, y, set) {
  const capturing = isFocus("bind", ref);
  const txt = capturing ? "Press a key" : keys.name(code);
  const bw = Math.max(58, draw.width(txt) + 16);
  const bx = right - bw;
  const hov = region(bx, y + 4, bw, 14, btn => {
    if (btn === 1) set(keys.NONE);
    else state.focus = { kind: "bind", ref, set };
  });
  const bg = capturing ? draw.mix(theme.input, ui.accent, 0.14) : theme.input;
  draw.panel(bx, y + 4, bw, 14, 4, bg, capturing ? ui.accent : hov ? theme.borderHi : theme.border);
  const color = capturing ? theme.text : code >= 0 ? theme.text : theme.textMute;
  draw.text(txt, bx + (bw - draw.width(txt)) / 2, y + 7, color);
  return bw;
}

function formatValue(s, v) {
  if (typeof s.format === "function") { try { return String(s.format(v)); } catch (error) { /* fall through */ } }
  return v.toFixed(registry.decimals(s.step)) + (s.unit || "");
}

function sliderValue(s, tx, tw, mx) { return s.min + clamp((mx - tx) / tw, 0, 1) * (s.max - s.min); }

function cycle(f, s, dir) {
  const i = s.options.indexOf(f.get(s.key));
  f.set(s.key, s.options[(i + dir + s.options.length) % s.options.length]);
}

function isVisible(f, s) {
  if (typeof s.visible !== "function") return true;
  try { return !!s.visible.call(f, f); } catch (error) { f.fail(error); return true; }
}

function rowsFor(f) {
  const rows = [];
  f.settings.forEach(s => { if (isVisible(f, s)) rows.push({ kind: "setting", s }); });
  if (f.hud) rows.push({ kind: "hud" });
  if (f.toggleable) rows.push({ kind: "bind" });
  if (f.settings.some(s => s.type !== "button")) rows.push({ kind: "reset" });
  return rows;
}

function drawRow(f, row, x, y, w) {
  const rowKey = row.kind === "setting" ? row.s.key || row.s.name : row.kind;
  const ha = anim(`row:${f.id}:${rowKey}`, hovering(x + 4, y, w - 8, ROW) ? 1 : 0, 22);
  if (ha > 0.01) draw.rrect(x + 4, y, w - 8, ROW, 4, theme.rowHover, ha);
  const rowBg = draw.mix(theme.surface, theme.rowHover, ha);
  const lx = x + 12;
  const right = x + w - 12;

  if (row.kind === "bind") {
    const bw = keybindBox(`${f.id}:__bind`, f.bind, right, y, code => f.setBind(code));
    label("Toggle key", "Toggles this module in-game. Right-click the key to clear it.", lx, y, right - bw - 8 - lx);
    return;
  }
  if (row.kind === "hud") {
    const custom = hud.isCustom(f.hud);
    const bw = button("Edit", right, y, btn => {
      if (btn === 1) hud.reset(f.hud);
      else editHud();
    });
    const desc = "Opens the HUD editor: drag it anywhere, scroll to scale. Right-click Edit to reset the position.";
    label(custom ? "Position  \u00B7  custom" : "Position", desc, lx, y, right - bw - 8 - lx);
    return;
  }
  if (row.kind === "reset") {
    const bw = button("Reset", right, y, () => f.reset());
    label("Defaults", "Restore every setting of this module to its default.", lx, y, right - bw - 8 - lx);
    return;
  }

  const s = row.s;
  const id = `${f.id}:${s.key || s.name}`;
  switch (s.type) {
    case "toggle": {
      const v = f.get(s.key);
      const hov = region(x + 4, y, w - 8, ROW, () => f.set(s.key, !f.get(s.key)));
      toggleSwitch(right - 20, y + 5.5, 20, 11, anim(`tg:${id}`, v ? 1 : 0, 18), hov);
      label(s.name, s.description, lx, y, right - 28 - lx);
      break;
    }
    case "slider": {
      const tw = Math.min(110, Math.floor(w * 0.36));
      const tx = right - tw;
      const cy = y + ROW / 2;
      const dragging = !!(state.drag && state.drag.id === id);
      if (dragging) f.set(s.key, sliderValue(s, tx, tw, ui.mx));
      const value = f.get(s.key);
      const hov = region(tx - 5, y + 3, tw + 10, ROW - 6, (btn, mx) => {
        state.drag = { id };
        f.set(s.key, sliderValue(s, tx, tw, mx));
      });
      const t = anim(`sl:${id}`, (value - s.min) / (s.max - s.min), dragging ? 40 : 20);
      draw.rrect(tx, cy - 1.5, tw, 3, 1.5, hov || dragging ? theme.trackHi : theme.track);
      draw.rrect(tx, cy - 1.5, tw * t, 3, 1.5, ui.accent);
      const kd = hov || dragging ? 9 : 8;
      draw.rrect(tx + tw * t - kd / 2, cy - kd / 2, kd, kd, kd / 2, theme.knob);
      const vs = formatValue(s, value);
      const vw = draw.width(vs);
      draw.text(vs, tx - 9 - vw, y + 7, theme.text);
      label(s.name, s.description, lx, y, tx - 9 - vw - 8 - lx);
      break;
    }
    case "select": {
      if (s._maxW == null) s._maxW = Math.max.apply(null, s.options.map(o => draw.width(String(o))));
      const bw = Math.max(64, s._maxW + 30);
      const bx = right - bw;
      const hov = region(bx, y + 4, bw, 14, (btn, mx) => cycle(f, s, btn === 1 || mx < bx + bw / 2 ? -1 : 1));
      const leftHot = hov && ui.mx < bx + bw / 2;
      draw.panel(bx, y + 4, bw, 14, 4, theme.input, hov ? theme.borderHi : theme.border);
      draw.glyph("left", bx + 6, y + 9, leftHot ? theme.text : theme.textMute);
      draw.glyph("right", bx + bw - 9, y + 9, hov && !leftHot ? theme.text : theme.textMute);
      const shown = draw.truncate(String(f.get(s.key)), bw - 26);
      draw.text(shown, bx + (bw - draw.width(shown)) / 2, y + 7, theme.text);
      label(s.name, s.description, lx, y, bx - 8 - lx);
      break;
    }
    case "text": {
      const bw = Math.min(130, Math.floor(w * 0.45));
      const bx = right - bw;
      const focused = isFocus("text", f.id, s.key);
      const hov = region(bx, y + 4, bw, 14, () => {
        state.focus = { kind: "text", id: f.id, key: s.key };
        state.caretT = ui.t;
      }, "text");
      draw.panel(bx, y + 4, bw, 14, 4, theme.input, focused ? ui.accent : hov ? theme.borderHi : theme.border);
      const value = f.get(s.key);
      if (value) {
        const shown = draw.tail(value, bw - 13);
        draw.text(shown, bx + 6, y + 7, theme.text);
        if (focused) caret(bx + 6 + draw.width(shown), y + 6);
      } else {
        if (focused) caret(bx + 6, y + 6);
        draw.text(draw.truncate(s.placeholder || "", bw - 14), bx + (focused ? 9 : 6), y + 7, theme.textMute);
      }
      label(s.name, s.description, lx, y, bx - 8 - lx);
      break;
    }
    case "keybind": {
      const bw = keybindBox(id, f.get(s.key), right, y, code => f.set(s.key, code));
      label(s.name, s.description, lx, y, right - bw - 8 - lx);
      break;
    }
    case "color": {
      const size = 10;
      const gap = 5;
      const n = s.options.length;
      const sx = right - (n * size + (n - 1) * gap);
      s.options.forEach((c, i) => {
        const cx = sx + i * (size + gap);
        const cy = y + 6;
        const selected = f.get(s.key) === c;
        const hov = region(cx - 2, cy - 2, size + 4, size + 4, () => f.set(s.key, c));
        if (hov && s.labels && s.labels[i]) ui.tooltip = s.labels[i];
        if (selected) draw.panel(cx - 2, cy - 2, size + 4, size + 4, 4, rowBg, theme.text);
        else if (hov) draw.panel(cx - 2, cy - 2, size + 4, size + 4, 4, rowBg, theme.borderHi);
        draw.rrect(cx, cy, size, size, 3, c);
      });
      label(s.name, s.description, lx, y, sx - 10 - lx);
      break;
    }
    case "button": {
      const bw = button(s.text || "Run", right, y, () => {
        try { s.action.call(f, f); } catch (error) { f.fail(error); }
      });
      label(s.name, s.description, lx, y, right - bw - 8 - lx);
      break;
    }
  }
}

// ---------- sections ----------

function drawHeader(X, Y, W) {
  draw.rrect(X + 12, Y + 9, 10, 10, 3, ui.accent);
  draw.rrect(X + 15, Y + 12, 4, 4, 1, theme.bg);
  draw.text("Center", X + 28, Y + 10, theme.text);
  if (VERSION) draw.text("v" + VERSION, X + 28 + draw.width("Center") + 6, Y + 10, theme.textMute);

  const cx = X + W - 8 - 16;
  const cy = Y + 6;
  const ch = region(cx, cy, 16, 16, () => close());
  draw.rrect(cx, cy, 16, 16, 4, theme.surfaceHi, anim("close", ch ? 1 : 0, 20));
  draw.glyph("cross", cx + 6, cy + 6, ch ? theme.text : theme.textMute);

  const sw = Math.min(140, Math.floor(W * 0.34));
  searchBox(cx - 6 - sw, cy, sw, 16);

  // HUD editor shortcut
  const label_ = "Edit HUD";
  const bw = draw.width(label_) + 16;
  const bx = cx - 6 - sw - 6 - bw;
  const hov = region(bx, cy, bw, 16, () => editHud());
  if (hov) ui.tooltip = "Move HUD modules anywhere on screen.";
  draw.panel(bx, cy, bw, 16, 4, hov ? theme.surfaceHi : theme.input, hov ? theme.borderHi : theme.border);
  draw.text(label_, bx + 8, cy + 4, hov ? theme.text : theme.textDim);
}

function searchBox(x, y, w, h) {
  const focused = isFocus("search");
  const hov = region(x, y, w, h, () => { state.focus = { kind: "search" }; state.caretT = ui.t; }, "text");
  const b = anim("search", focused ? 2 : hov ? 1 : 0, 18);
  const border = b > 1 ? draw.mix(theme.borderHi, ui.accent, b - 1) : draw.mix(theme.border, theme.borderHi, b);
  draw.panel(x, y, w, h, 4, theme.input, border);
  draw.magnifier(x + 6, y + 5, focused ? theme.textDim : theme.textMute, theme.input);
  const tx = x + 18;
  if (state.search) {
    const shown = draw.tail(state.search, w - 18 - 18);
    draw.text(shown, tx, y + 4, theme.text);
    if (focused) caret(tx + draw.width(shown), y + 3);
    const clearX = x + w - 14;
    const hc = region(clearX - 3, y + 2, 11, 12, () => { setSearch(""); state.focus = { kind: "search" }; });
    draw.glyph("cross", clearX, y + 6, hc ? theme.text : theme.textMute);
  } else {
    if (focused) caret(tx, y + 3);
    draw.text("Search", tx + (focused ? 3 : 0), y + 4, theme.textMute);
  }
}

function sideItem(id, text, count, x, y, w) {
  const selected = (state.search && state.page !== SETTINGS ? ALL : state.page) === id;
  const hov = region(x, y, w, 18, () => selectPage(id));
  const sa = anim(`side:s:${id}`, selected ? 1 : 0, 18);
  const ha = anim(`side:h:${id}`, hov && !selected ? 1 : 0, 22);
  if (ha > 0.01) draw.rrect(x, y, w, 18, 4, theme.surfaceHi, ha);
  if (sa > 0.01) {
    draw.rrect(x, y, w, 18, 4, draw.mix(theme.surface, ui.accent, 0.12), sa);
    draw.rrect(x, y + 5, 2, 8, 1, ui.accent, sa);
  }
  const countText = count == null ? "" : String(count);
  const cw = countText ? draw.width(countText) + 8 : 0;
  const room = w - 16 - cw;
  if (draw.width(text) > room && id === ALL) text = "All";
  draw.text(draw.truncate(text, room), x + 9, y + 5, draw.mix(theme.textDim, theme.text, Math.max(sa, ha)));
  if (countText) draw.text(countText, x + w - 8 - draw.width(countText), y + 5, selected ? theme.textDim : theme.textMute);
}

function drawSidebar(X, Y, W, H) {
  const list = registry.all();
  let y = Y + 8;
  sideItem(ALL, "All modules", list.length, X + 6, y, W - 12);
  y += 20;
  registry.categories().forEach(c => {
    if (y + 18 > Y + H - 34) return; // keep clear of the Settings item
    sideItem(c, c, list.filter(f => f.category === c).length, X + 6, y, W - 12);
    y += 20;
  });
  draw.rect(X + 12, Y + H - 33, W - 24, 1, theme.border);
  sideItem(SETTINGS, "Settings", null, X + 6, Y + H - 26, W - 12);
}

function categoryChip(text, x, y) {
  const w = draw.width(text) + 8;
  draw.rrect(x, y, w, 11, 3, theme.chip);
  draw.text(text, x + 4, y + 2, theme.textMute);
  return w;
}

function featureCard(f, x, y, w, showCategory) {
  const open = !!state.expanded[f.id];
  const e = anim(`exp:${f.id}`, open ? 1 : 0, 16);
  const rows = rowsFor(f);
  const bodyH = rows.length * ROW + 10;
  const h = CARD_HEAD + bodyH * e;
  const headHover = hovering(x, y, w, CARD_HEAD);
  const hv = anim(`hov:${f.id}`, headHover ? 1 : 0, 22);
  const on = anim(`on:${f.id}`, f.isEnabled() ? 1 : 0, 16);

  const border = draw.mix(draw.mix(theme.border, theme.borderHi, hv), ui.accent, on * 0.45);
  draw.panel(x, y, w, h, 5, theme.surface, border);
  if (hv > 0.01) draw.rrect(x + 3, y + 3, w - 6, CARD_HEAD - 6, 4, theme.rowHover, hv);

  region(x, y, w, CARD_HEAD, btn => {
    if (btn === 1 && f.toggleable) f.toggle("gui");
    else state.expanded[f.id] = !state.expanded[f.id];
  });

  const sx = x + w - 12 - 22;
  const textW = sx - 22 - (x + 12);
  const name = draw.truncate(f.name, textW);
  draw.text(name, x + 12, y + 8, theme.text);
  if (showCategory) {
    const chipX = x + 12 + draw.width(name) + 6;
    if (chipX + draw.width(f.category) + 8 < sx - 22) categoryChip(f.category, chipX, y + 6);
  }
  if (f.description) draw.text(draw.truncate(f.description, textW), x + 12, y + 20, theme.textMute);

  draw.glyph(open ? "up" : "down", sx - 16, y + 17, draw.mix(theme.textMute, theme.textDim, hv));
  if (f.toggleable) {
    const sh = region(sx - 4, y + 8, 30, 20, () => f.toggle("gui"));
    toggleSwitch(sx, y + 12, 22, 12, on, sh);
  }

  if (e > 0.002) {
    const bodyY = y + CARD_HEAD;
    pushClip(x, bodyY, w, h - CARD_HEAD);
    draw.rect(x + 10, bodyY, w - 20, 1, theme.border);
    let ry = bodyY + 5;
    rows.forEach(row => { drawRow(f, row, x, ry, w); ry += ROW; });
    popClip();
  }
  return h;
}

function settingsCard(f, x, y, w) {
  const rows = rowsFor(f);
  const h = 34 + 5 + rows.length * ROW + 5;
  draw.panel(x, y, w, h, 5, theme.surface, theme.border);
  draw.text(f.name, x + 12, y + 8, theme.text);
  draw.text(draw.truncate(f.description, w - 24), x + 12, y + 20, theme.textMute);
  draw.rect(x + 10, y + 34, w - 20, 1, theme.border);
  let ry = y + 39;
  rows.forEach(row => { drawRow(f, row, x, ry, w); ry += ROW; });
  return h;
}

function aboutCard(x, y, w) {
  const list = registry.all();
  const enabled = list.filter(f => f.isEnabled()).length;
  const lines = [
    `${plural(list.length, "module")} registered, ${enabled} enabled.`,
    `Open with /center or ${keys.name(iface.get("openKey"))}.`,
    "Add modules in center/features, or from another module with require(\"center\").defineFeature.",
  ];
  const wrapped = [];
  lines.forEach(l => draw.wrap(l, w - 24).forEach(p => wrapped.push(p)));
  const h = 34 + 6 + wrapped.length * 11 + 4;
  draw.panel(x, y, w, h, 5, theme.surface, theme.border);
  draw.text("About", x + 12, y + 8, theme.text);
  draw.text(VERSION ? `Center ${VERSION}` : "Center", x + 12, y + 20, theme.textMute);
  draw.rect(x + 10, y + 34, w - 20, 1, theme.border);
  wrapped.forEach((l, i) => draw.text(l, x + 12, y + 41 + i * 11, theme.textDim));
  return h;
}

function drawContent(X, Y, W, H) {
  const pad = 12;
  const q = state.search.trim();
  if (state.page !== ALL && state.page !== SETTINGS && registry.categories().indexOf(state.page) < 0) state.page = ALL;
  const settingsPage = state.page === SETTINGS && !q;
  const items = settingsPage ? [] : visibleFeatures();

  const title = settingsPage ? "Settings" : q ? `Results for "${q}"` : state.page === ALL ? "All modules" : state.page;
  const sub = settingsPage ? "" : `${plural(items.length, "module")}  \u00B7  ${items.filter(f => f.isEnabled()).length} on`;
  const subW = draw.width(sub);
  draw.text(draw.truncate(title, W - pad * 2 - subW - 10), X + pad, Y + 11, theme.text);
  if (sub) draw.text(sub, X + W - pad - subW, Y + 11, theme.textMute);

  const listTop = Y + 28;
  const viewH = H - 28 - 6;
  const listX = X + pad;
  const listW = W - pad * 2 - 4;

  state.scrollTarget = clamp(state.scrollTarget, 0, state.maxScroll);
  state.scroll = ui.animations ? state.scroll + (state.scrollTarget - state.scroll) * (1 - Math.exp(-18 * state.dt)) : state.scrollTarget;
  if (Math.abs(state.scroll - state.scrollTarget) < 0.05) state.scroll = state.scrollTarget;

  pushClip(X + 1, listTop, W - 2, viewH);
  draw.pushPose().translate(0, -state.scroll);
  ui.oy = -state.scroll;
  let y = listTop + 2;
  if (settingsPage) {
    y += settingsCard(iface, listX, y, listW) + 6;
    y += aboutCard(listX, y, listW) + 6;
  } else if (!items.length) {
    const msg = q ? "No modules match your search." : "No modules in this category yet.";
    draw.text(msg, X + (W - draw.width(msg)) / 2, listTop + 40, theme.textDim);
    const hint = q ? "Try a shorter or different name." : "Modules register with defineFeature().";
    draw.text(hint, X + (W - draw.width(hint)) / 2, listTop + 53, theme.textMute);
  } else {
    const showCategory = !!q || state.page === ALL;
    items.forEach(f => { y += featureCard(f, listX, y, listW, showCategory) + 6; });
  }
  draw.popPose();
  ui.oy = 0;
  popClip();

  state.maxScroll = Math.max(0, y - 6 + 4 - listTop - viewH);
  if (state.maxScroll > 0) {
    const th = Math.max(18, viewH * viewH / (viewH + state.maxScroll));
    const ty = listTop + (viewH - th) * clamp(state.scroll / state.maxScroll, 0, 1);
    draw.rrect(X + W - 7, ty, 3, th, 1.5, theme.scrollbar);
  }
}

function drawTooltip(sw, sh) {
  try { ui.ctx.nextStratum(); } catch (error) { /* older builds: draw in place */ }
  const lines = draw.wrap(ui.tooltip, 180);
  const w = Math.max.apply(null, lines.map(l => draw.width(l))) + 12;
  const h = lines.length * 10 + 8;
  let x = ui.mx + 10;
  let y = ui.my + 12;
  if (x + w > sw - 4) x = ui.mx - w - 6;
  if (y + h > sh - 4) y = ui.my - h - 6;
  draw.panel(x, y, w, h, 4, theme.tooltip, theme.borderHi);
  lines.forEach((l, i) => draw.text(l, x + 6, y + 5 + i * 10, theme.textDim));
}

function render(ctx, mx, my) {
  if (state.openKeyHeld && !Keyboard.isKeyDown(iface.get("openKey"))) state.openKeyHeld = false;
  const t = now();
  state.dt = state.last ? clamp(t - state.last, 0, 0.1) : 0;
  state.last = t;
  ui = {
    ctx, mx, my, t, oy: 0, clip: null, clips: [], regions: [], cursor: null, tooltip: null,
    accent: iface.get("accent"), animations: iface.get("animations"),
  };
  draw.begin(ctx);
  try {
    const sw = ctx.guiWidth();
    const sh = ctx.guiHeight();
    const open = ui.animations ? easeOutCubic(clamp((t - state.openedAt) / 0.16, 0, 1)) : 1;
    if (iface.get("dim")) draw.rect(0, 0, sw, sh, 0xFF000000, 0.45 * open);

    const W = Math.min(460, sw - 16);
    const H = Math.min(300, sh - 16);
    const X = Math.floor((sw - W) / 2);
    const Y = Math.floor((sh - H) / 2);
    const p = draw.pushPose();
    if (open < 1) {
      const k = 0.96 + 0.04 * open;
      p.translate(X + W / 2, Y + H / 2);
      p.scale(k, k);
      p.translate(-(X + W / 2), -(Y + H / 2));
    }
    draw.setAlpha(open);
    draw.panel(X, Y, W, H, 6, theme.bg, theme.border);
    const SB = W < 380 ? 86 : 106;
    drawHeader(X, Y, W);
    draw.rect(X + 1, Y + HEADER - 1, W - 2, 1, theme.border);
    draw.rect(X + SB - 1, Y + HEADER, 1, H - HEADER - 1, theme.border);
    drawSidebar(X, Y + HEADER, SB, H - HEADER);
    drawContent(X + SB, Y + HEADER, W - SB, H - HEADER);
    draw.setAlpha(1);
    draw.popPose();

    if (ui.tooltip) drawTooltip(sw, sh);
    if (ui.cursor && Cursors) {
      try { ctx.requestCursor(ui.cursor === "text" ? Cursors.IBEAM : Cursors.POINTING_HAND); } catch (error) { Cursors = null; }
    }
  } finally {
    draw.end();
    state.regions = ui.regions;
  }
}

// ---------- input ----------

function onClick(mx, my, btn) {
  state.focus = null; // handlers re-focus as needed
  for (let i = state.regions.length - 1; i >= 0; i--) {
    const r = state.regions[i];
    if (!r.onClick || !inClip(r.clip, mx, my)) continue;
    if (mx < r.x || mx >= r.x + r.w || my < r.y || my >= r.y + r.h) continue;
    r.onClick(btn, mx, my);
    return;
  }
}

function fieldFor(focus) {
  if (focus.kind === "search") return { get: () => state.search, set: setSearch, max: 40 };
  const f = registry.get(focus.id);
  const s = f && f.setting(focus.key);
  if (!s) return null;
  return { get: () => f.get(s.key), set: v => f.set(s.key, v), max: s.maxLength };
}

function editText(focus, ch, code) {
  const field = fieldFor(focus);
  if (!field) { state.focus = null; return; }
  const ctrl = Keyboard.isCtrlKeyDown();
  let v = String(field.get());
  if (code === Keyboard.KEY_BACKSPACE) v = ctrl ? v.replace(/\S*\s*$/, "") : v.slice(0, -1);
  else if (code === Keyboard.KEY_ENTER || code === Keyboard.KEY_NUMPADENTER) { state.focus = null; return; }
  else if (ctrl && code === Keyboard.KEY_V) v += String(Client.paste() || "").replace(/[\u0000-\u001f\u007f\u00a7]/g, "");
  else if (ctrl) return;
  else {
    const c = keys.typedChar(ch, code);
    if (!c) return;
    v += c;
  }
  field.set(v.slice(0, field.max));
  state.caretT = now();
}

function onKey(ch, code) {
  const focus = state.focus;
  if (code === Keyboard.KEY_ESCAPE) {
    // CT's own Esc handling (Gui.onClose) goes through Client.scheduleTask,
    // which never runs here, so Esc is handled directly.
    if (focus) state.focus = null;
    else close();
    return;
  }
  if (focus && focus.kind === "bind") {
    state.focus = null;
    focus.set(code === Keyboard.KEY_BACKSPACE || code === Keyboard.KEY_DELETE ? keys.NONE : code);
    return;
  }
  if (focus) { editText(focus, ch, code); return; }
  const openKey = iface.get("openKey");
  if (openKey >= 0 && code === openKey) {
    // Key repeat from the press that opened the menu must not close it again.
    if (state.openKeyHeld) return;
    // The poller would otherwise see this press once the menu is gone and reopen it.
    keys.consume(openKey);
    close();
    return;
  }
  // Typing anywhere starts a search.
  const c = Keyboard.isCtrlKeyDown() ? null : keys.typedChar(ch, code);
  if (c && c !== " ") {
    state.focus = { kind: "search" };
    state.caretT = now();
    setSearch((state.search + c).slice(0, 40));
  }
}

function guard(name, fn) {
  return function () {
    try { return fn.apply(null, arguments); } catch (error) {
      const t = Date.now();
      if (t - state.lastError > 2000) {
        state.lastError = t;
        log.error(`menu ${name}`, error);
      }
    }
  };
}

let firstFrame = false;
const gui = new Gui();
gui.setDoesPauseGame(false);
gui.registerDraw(guard("draw", (ctx, mx, my) => {
  if (firstFrame) {
    firstFrame = false;
    log.log(`first frame: ctx=${ctx ? ctx.getClass().getSimpleName() : ctx} size=${ctx && ctx.guiWidth()}x${ctx && ctx.guiHeight()} scale=${Renderer.screen.getScale()}`);
  }
  render(ctx, mx, my);
}));
gui.registerClicked(guard("click", (mx, my, btn) => onClick(mx, my, btn)));
gui.registerMouseReleased(guard("release", () => { state.drag = null; }));
gui.registerScrolled(guard("scroll", (mx, my, delta) => {
  state.scrollTarget = clamp(state.scrollTarget - delta * 30, 0, state.maxScroll);
}));
gui.registerKeyTyped(guard("key", (ch, code) => onKey(ch, code)));
gui.registerOpened(guard("open", () => {
  log.log("menu opened");
  firstFrame = true;
  state.openedAt = now();
  const openKey = iface.get("openKey");
  state.openKeyHeld = openKey >= 0 && Keyboard.isKeyDown(openKey);
  state.last = 0;
  state.focus = null;
  state.drag = null;
}));
gui.registerClosed(guard("close", () => {
  state.focus = null;
  state.drag = null;
  store.flush();
}));

function open(source) { show.openWhenFree(gui, "menu", source); }
function isOpen() { return Client.currentGui.get() === gui; }

module.exports = { open, isOpen, _test: { state, render, onClick, onKey, gui } };
