// Runs under CT's bundled Rhino (ES6, opt 9) with mocked CT globals:
//   powershell -File center\tests\run.ps1
// Note: module-level const/let names must not match any global (CT's or the
// mocks below): Rhino throws "redeclaration of var" when they do.
// Exercises registry, persistence, key polling and the menu's click/key handling
// by rendering frames into a mock GuiGraphicsExtractor.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": got " + a + ", expected " + b); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

// ---------- CT mocks ----------
var files = { "center/metadata.json": String(readFile(environment["user.dir"] + "/center/metadata.json")) };
var FileLib = {
  read: function (m, f) { var k = m + "/" + f; return files.hasOwnProperty(k) ? files[k] : null; },
  write: function (m, f, c) { files[m + "/" + f] = c; },
};
var triggers = [];
function register(type, fn) {
  var t = {
    type: String(type).toLowerCase(), fn: fn, registered: true, name: null,
    register: function () { this.registered = true; return this; },
    unregister: function () { this.registered = false; return this; },
  };
  ["setFps", "setDelay", "setTabCompletions", "setCriteria", "setPriority", "setAliases", "setFilteredClass"].forEach(function (m) {
    t[m] = function () { return t; };
  });
  t.setName = function (n) { t.name = n; return t; };
  triggers.push(t);
  return t;
}
function fire(type) {
  var args = Array.prototype.slice.call(arguments, 1);
  triggers.filter(function (t) { return t.type === type && t.registered; }).forEach(function (t) { t.fn.apply(null, args); });
}
function fireCommand(name) {
  var args = Array.prototype.slice.call(arguments, 1);
  var cmd = triggers.filter(function (t) { return t.type === "command" && t.name === name; })[0];
  if (!cmd) throw new Error("no command " + name);
  cmd.fn.apply(null, args);
}
var Priority = { HIGHEST: 0, HIGH: 1, NORMAL: 2, LOW: 3, LOWEST: 4 };
var tasks = [];
var currentScreen = null;
var pasted = "";
var Client = {
  scheduleTask: function (a, b) { tasks.push(typeof a === "function" ? a : b); },
  currentGui: { get: function () { return currentScreen; }, close: function () { var s = currentScreen; currentScreen = null; if (s && s._cb.closed) s._cb.closed(s); } },
  getMinecraft: function () { return mc; },
  isInGui: function () { return currentScreen != null; },
  getFPS: function () { return 144; },
  paste: function () { return pasted; },
};
function runTasks() { var t = tasks; tasks = []; t.forEach(function (fn) { fn(); }); }
// center defers work through its own step trigger (CT's scheduleTask is broken in-game).
function frames(n) { for (var i = 0; i < (n || 3); i++) fire("step"); }
var sprint = { down: false, isDown: function () { return this.down; }, setDown: function (v) { this.down = v; } };
// Minecraft: the auto miner's mock world, plus what the other features use.
var MOCKW = require("center/tests/mock-farm-world").createFarmWorld({});
MOCKW.packetSink = function (packet, event) { fire("packetsent", packet, event); };
var mc = MOCKW.game;
mc.options.keySprint = sprint;
mc.gui = { setScreen: function (s) { var prev = currentScreen; currentScreen = s; if (prev && prev !== s && prev._cb && prev._cb.closed) prev._cb.closed(prev); if (s && s._cb && s._cb.opened) s._cb.opened(s); } };
var keysDown = {};
var shift = false, ctrl = false;
var Keyboard = {
  KEY_NONE: -1, KEY_ESCAPE: 256, KEY_ENTER: 257, KEY_NUMPADENTER: 335, KEY_BACKSPACE: 259, KEY_DELETE: 261,
  KEY_RSHIFT: 344, KEY_LSHIFT: 340, KEY_A: 65, KEY_V: 86, KEY_K: 75,
  KEY_RIGHT: 262, KEY_LEFT: 263, KEY_DOWN: 264, KEY_UP: 265,
  isKeyDown: function (c) { return !!keysDown[c]; },
  isShiftKeyDown: function () { return shift; },
  isCtrlKeyDown: function () { return ctrl; },
  getKeyName: function (c) { return c >= 32 && c <= 96 ? String.fromCharCode(c) : null; },
};
var font = { // ~average MC glyph advance
  width: function (s) { return String(s).length * 5; },
  plainSubstrByWidth: function (s, w) { return String(s).slice(0, Math.floor(w / 5)); },
};
var Renderer = { getFontRenderer: function () { return font; }, screen: { getScale: function () { return 2; } } };
var worldLoaded = true;
var World = { isLoaded: function () { return worldLoaded; } };
var Player = { getX: function () { return 1.5; }, getY: function () { return 64; }, getZ: function () { return -3.2; }, facing: function () { return "North"; } };
var Server = { isSingleplayer: function () { return true; }, getPing: function () { return 20; } };
var chat = [];
var ChatLib = { chat: function (m) { chat.push(String(m)); } };
var logged = [];
var console = {
  log: function (m) { logged.push(String(m)); }, warn: function (m) { logged.push(String(m)); },
  error: function (m) { logged.push("ERROR " + m); },
};
var Java = {
  type: function (name) {
    if (name === "java.lang.System") return java.lang.System;
    if (name.indexOf("CursorTypes") >= 0) return { IBEAM: "ibeam", POINTING_HAND: "hand" };
    if (MOCKW.typeByName[name]) return MOCKW.typeByName[name];
    throw new Error("class not found " + name);
  },
};
// Dynamic mixins are installed at game startup; exercise their attached live
// callbacks here with vanilla-shaped argument bags.
var mixinDefinitions = [];
function At(options) { this.options = options; }
function Mixin(target) { this.target = target; }
Mixin.prototype.modifyArgs = function (options) {
  var hook = { target: this.target, options: options, attach: function (fn) { this.fn = fn; } };
  mixinDefinitions.push(hook);
  return hook;
};
function invokeViewHook(name, receiver, a, b) {
  var values = [a, b];
  require("center/mixins")[name].fn(receiver, {
    get: function (i) { return values[i]; }, set: function (i, v) { values[i] = Number(v); },
  });
  return values;
}
function Gui() { this._cb = {}; this._open = false; }
["Draw", "Clicked", "MouseReleased", "Scrolled", "KeyTyped", "Opened", "Closed", "MouseDragged"].forEach(function (n) {
  Gui.prototype["register" + n] = function (fn) { this._cb[n.charAt(0).toLowerCase() + n.slice(1)] = fn; return this; };
});
Gui.prototype.setDoesPauseGame = function () { return this; };
Gui.prototype.open = function () { currentScreen = this; if (this._cb.opened) this._cb.opened(this); };
Gui.prototype.isOpen = function () { return currentScreen === this; };

// Mock GuiGraphicsExtractor: validates int arguments and balanced stacks.
function makeCtx(w, h) {
  var c = { fills: 0, texts: [], depth: 0, scissor: 0, bad: [], cursor: null, translates: [] };
  var isInt = function (v) { return typeof v === "number" && v === (v | 0); };
  var pose = {
    pushMatrix: function () { c.depth++; return pose; },
    popMatrix: function () { c.depth--; if (c.depth < 0) c.bad.push("pose underflow"); return pose; },
    translate: function (x, y) { c.translates.push([x, y]); return pose; }, scale: function () { return pose; },
  };
  c.ctx = {
    guiWidth: function () { return w; }, guiHeight: function () { return h; }, pose: function () { return pose; },
    fill: function (a, b, x, y, col) { if (![a, b, x, y, col].every(isInt)) c.bad.push("fill " + [a, b, x, y, col]); c.fills++; },
    text: function (f, s, x, y, col, sh) { if (![x, y, col].every(isInt) || typeof s !== "string") c.bad.push("text " + s); c.texts.push({ s: s, x: x, y: y }); },
    enableScissor: function (a, b, x, y) { if (![a, b, x, y].every(isInt)) c.bad.push("scissor"); c.scissor++; },
    disableScissor: function () { c.scissor--; },
    nextStratum: function () {}, requestCursor: function (k) { c.cursor = k; },
  };
  return c;
}

// ---------- load module ----------
// Old config with a fixed corner, to check it migrates to a free position.
// The auto miner was saved as enabled and must still load disabled; the MVP
// module's settings file must be adopted.
files["center/config.json"] = JSON.stringify({ features: {
  "info-hud": { values: { corner: "Bottom right" } },
  "auto-miner": { enabled: true, values: {} },
  "auto-farm": { enabled: true, values: { sweepPeriod: 1 } },
} });
files["auto-miner/settings.json"] = JSON.stringify({ glide: 1.5, hud: false });
var center = require("center/index");
var R = require("center/core/registry");
var ST = require("center/core/store");
var IF = require("center/core/interface");
var SC = require("center/gui/screen");
var HE = require("center/gui/hud-editor");
var HUD = require("center/core/hud");
var T = SC._test;
var E = HE._test;
var infoHud = R.get("info-hud");
var sprintF = R.get("toggle-sprint");
IF.set("animations", false); // deterministic frames

var frame = null;
function render(mx, my) {
  frame = makeCtx(480, 270);
  T.render(frame.ctx, mx == null ? -1 : mx, my == null ? -1 : my);
  if (frame.bad.length) throw new Error("bad draw calls: " + frame.bad.slice(0, 3).join(" | "));
  eq(frame.depth, 0, "pose stack balanced");
  eq(frame.scissor, 0, "scissor stack balanced");
  return frame;
}
function findText(s) {
  var hit = frame.texts.filter(function (t) { return t.s === s; })[0];
  if (!hit) throw new Error("text not drawn: " + s + " (drawn: " + frame.texts.map(function (t) { return t.s; }).join(", ") + ")");
  return hit;
}
function hasText(s) { return frame.texts.some(function (t) { return t.s === s; }); }
function click(x, y, btn) { T.onClick(x, y, btn || 0); render(x, y); }
function key(code, ch) { T.onKey(ch == null ? String.fromCharCode(code).toLowerCase() : ch, code); render(); }

// Geometry (480x270): window 460x254 at (10,8), sidebar 106, content x 116, cards x 128 w 326.
var CARD_X = 128, CARD_W = 326, RIGHT = CARD_X + CARD_W - 12;
// List text is drawn in scrolled space; convert to screen space.
function cardY(name) { return findText(name).y - 8 - T.state.scroll; }
function rowY(labelText) { return findText(labelText).y - 7 - T.state.scroll; }

// ---------- tests ----------
test("module loads with interface + example modules and a /center command", function () {
  ok(center.defineFeature && center.open, "public API exported");
  ok(R.get("center") && infoHud && sprintF && R.get("auto-miner"), "features registered");
  eq(R.all().length, 4, "interface group is hidden");
  ok(triggers.some(function (t) { return t.type === "command" && t.name === "center"; }), "/center registered");
  ok(triggers.some(function (t) { return t.type === "command" && t.name === "auto-miner"; }), "/auto-miner registered");
  eq(R.categories().join(","), "Automation,Movement,Render");
});

test("legacy corner setting migrates to a free HUD position", function () {
  var el = HUD.get("info-hud");
  ok(el && infoHud.hud === el, "info hud registered as a HUD element");
  var p = HUD.getPos(el);
  eq(p.ax, 1); eq(p.ay, 1); eq(p.dx, -6); eq(p.dy, -6);
  eq(ST.entry("info-hud").values.corner, undefined, "corner value dropped");
  ok(!infoHud.setting("corner"), "no corner setting anymore");
  HUD.reset(el);
  ok(!HUD.isCustom(el), "reset back to default");
});

test("menu renders with balanced pose/scissor stacks and integer draw args", function () {
  SC.open(); frames();
  ok(T.gui.isOpen(), "gui opened");
  render(200, 100);
  ok(hasText("Center") && hasText("All modules") && hasText("Info HUD") && hasText("Toggle Sprint") && hasText("Settings"));
  ok(frame.fills > 50, "drew shapes");
});

test("switch click toggles a module and its triggers", function () {
  var overlay = triggers.filter(function (t) { return t.type === "renderoverlay" && t.fn && infoHud.triggers.indexOf(t) >= 0; })[0];
  ok(overlay && !overlay.registered, "hud trigger starts unregistered");
  var y = cardY("Info HUD");
  click(CARD_X + CARD_W - 12 - 11, y + 18);
  ok(infoHud.isEnabled(), "enabled by switch");
  ok(overlay.registered, "trigger registered on enable");
  click(CARD_X + 40, y + 10, 1); // right-click header toggles too
  ok(!infoHud.isEnabled(), "right-click toggles off");
  ok(!overlay.registered, "trigger unregistered on disable");
});

test("clicking a card expands its settings; rows are interactive", function () {
  click(findText("Render").x + 2, findText("Render").y + 2);
  var y = cardY("Info HUD");
  click(CARD_X + 40, y + 10);
  ok(T.state.expanded["info-hud"], "expanded");
  ok(hasText("Coordinates") && hasText("Scale") && hasText("Toggle key") && hasText("Defaults"), "rows drawn");

  click(CARD_X + 30, rowY("Coordinates") + 11);
  eq(infoHud.get("coords"), false, "toggle row flips value");

  var sy = rowY("Scale") + 11;
  click(RIGHT, sy);
  eq(infoHud.get("scale"), 2, "slider click at track end = max");
  T.onClick(RIGHT - 110, sy, 0); // start drag at track start
  render(RIGHT - 55, sy);       // drag to the middle
  eq(infoHud.get("scale"), 1.25, "drag snaps to step");
  T.gui._cb.mouseReleased(0, 0, 0);
  render(RIGHT, sy);
  eq(infoHud.get("scale"), 1.25, "release stops dragging");

  T.gui._cb.scrolled(0, 0, -10); // scroll so the last rows are inside the viewport
  render();
  ok(T.state.scroll > 0, "list scrolled");
  var cy = rowY("Label color") + 11;
  click(RIGHT - 5, cy); // last swatch
  eq(infoHud.get("labelColor"), require("center/gui/theme").ACCENTS[5].color, "swatch selects color");

  click(RIGHT - 5, rowY("Position") + 11);
  ok(HE._test.gui.isOpen(), "Edit opens the HUD editor");
  HE._test.onKey("\u0100", Keyboard.KEY_ESCAPE);
  ok(T.gui.isOpen(), "Esc in the editor returns to the menu");
  render();
});

test("keybind capture, clear, and reset to defaults", function () {
  var ky = rowY("Toggle key") + 11;
  click(RIGHT - 10, ky);
  ok(T.state.focus && T.state.focus.kind === "bind", "capturing");
  ok(hasText("Press a key"), "capture label shown");
  key(Keyboard.KEY_K);
  eq(infoHud.bind, 75, "bound to K");
  ok(hasText("K"), "key name shown");
  click(RIGHT - 10, rowY("Toggle key") + 11, 1);
  eq(infoHud.bind, -1, "right-click clears");
  infoHud.setBind(75);

  click(RIGHT - 10, rowY("Defaults") + 11);
  eq(infoHud.get("coords"), true, "reset restores default");
  eq(infoHud.get("scale"), 1, "reset restores slider");
});

test("typing searches, backspace edits, categories filter", function () {
  click(findText("All modules").x + 2, findText("All modules").y + 2);
  key(83, "s"); key(80, "p"); key(82, "r");
  eq(T.state.search, "spr", "typing focuses search");
  ok(hasText("Toggle Sprint") && !hasText("Info HUD"), "results filtered");
  key(Keyboard.KEY_BACKSPACE, "\u0103");
  eq(T.state.search, "sp");
  ctrl = true; key(Keyboard.KEY_BACKSPACE, "\u0103"); ctrl = false;
  eq(T.state.search, "", "ctrl+backspace clears word");
  T.state.focus = null;

  click(findText("Render").x + 2, findText("Render").y + 2);
  eq(T.state.page, "Render");
  ok(hasText("Info HUD") && !hasText("Toggle Sprint"), "category filter");
  click(findText("All modules").x + 2, findText("All modules").y + 2);
});

test("settings page edits the interface group", function () {
  click(findText("Settings").x + 2, findText("Settings").y + 2);
  eq(T.state.page, "__settings");
  ok(hasText("Interface") && hasText("About") && hasText("Menu key"), "settings page drawn");
  click(CARD_X + 30, rowY("Dim background") + 11);
  eq(IF.get("dim"), false, "interface toggle works");
  click(RIGHT - 10, rowY("Menu key") + 11);
  key(Keyboard.KEY_DELETE, "\u0105");
  eq(IF.get("openKey"), -1, "delete clears menu key");
  IF.set("openKey", Keyboard.KEY_RSHIFT);
  IF.set("dim", true);
});

test("open key closes the menu; tooltips and cursor appear on hover", function () {
  click(findText("Render").x + 2, findText("Render").y + 2);
  var t = findText("Ping");
  render(t.x + 2, t.y + 2 - T.state.scroll);
  ok(hasText("Latency reported by the server."), "tooltip drawn for description");
  render(CARD_X + CARD_W - 20, cardY("Info HUD") + 18);
  eq(frame.cursor, "hand", "pointer cursor over the switch");
  key(Keyboard.KEY_RSHIFT, "\u0158");
  ok(!T.gui.isOpen(), "open key closes menu");
  SC.open(); frames(); ok(T.gui.isOpen(), "reopened");
  key(Keyboard.KEY_ESCAPE, "\u0100");
  ok(!T.gui.isOpen(), "escape closes menu directly");
});

test("open key closes the menu without the key poller reopening it", function () {
  SC.open(); frames();
  ok(T.gui.isOpen(), "menu open");
  keysDown[344] = true;            // physical press: the screen gets the key event first...
  key(Keyboard.KEY_RSHIFT, "\u0158");
  ok(!T.gui.isOpen(), "closed by the menu key");
  frames(5);                       // ...then the poller sees the same press with no screen open
  ok(!T.gui.isOpen(), "not reopened while the key is held");
  keysDown[344] = false; frames(2);
  ok(!T.gui.isOpen(), "still closed after release");
  keysDown[344] = true; frames(3); keysDown[344] = false; frames(3);
  ok(T.gui.isOpen(), "a new press opens it");

  keysDown[344] = true;            // key repeat of a press made before opening is ignored
  SC._test.gui._cb.opened(SC._test.gui);
  key(Keyboard.KEY_RSHIFT, "\u0158");
  ok(T.gui.isOpen(), "repeat of the opening press does not close it");
  keysDown[344] = false; render();
  key(Keyboard.KEY_RSHIFT, "\u0158");
  ok(!T.gui.isOpen(), "a fresh press closes it");
  frames(3);
});

test("settings and binds persist to config.json", function () {
  ST.markDirty(); ST.flush();
  var saved = JSON.parse(files["center/config.json"]);
  eq(saved.features["info-hud"].bind, 75);
  eq(saved.features["info-hud"].values.corner, undefined, "legacy corner removed");
  eq(saved.features["center"].values.openKey, 344);
});

test("toggle keys fire on press edge only, never with a screen open", function () {
  var before = infoHud.isEnabled();
  keysDown[75] = true; fire("step"); fire("step");
  eq(infoHud.isEnabled(), !before, "one toggle per press");
  keysDown[75] = false; fire("step");
  currentScreen = {}; keysDown[75] = true; fire("step");
  eq(infoHud.isEnabled(), !before, "ignored while a screen is open");
  currentScreen = null; keysDown[75] = false; fire("step");
  keysDown[344] = true; fire("step"); keysDown[344] = false; frames();
  ok(T.gui.isOpen(), "menu key opens menu");
  Client.currentGui.close();
});

test("enabled state restores on load; failing hooks and triggers are contained", function () {
  ST.entry("restore-test").enabled = true;
  var f = R.defineFeature({ id: "restore-test", name: "Restore", onEnable: function () { this.started = true; } });
  ok(!f.isEnabled(), "not enabled synchronously");
  frames();
  ok(f.isEnabled() && f.started, "restored next tick");

  var bad = R.defineFeature({ id: "bad", onEnable: function () { throw new Error("boom"); } });
  bad.setEnabled(true);
  ok(!bad.isEnabled(), "failed onEnable leaves it off");
  var t = bad.on("tick", function () { throw new Error("tick boom"); });
  bad.hooks.enable = null; bad.setEnabled(true);
  bad.lastError = 0;
  t.fn(1); // must not throw
  ok(logged.some(function (l) { return l.indexOf("tick boom") >= 0; }), "error logged");

  var threw = false;
  try { R.defineFeature({ id: "bad" }); } catch (e) { threw = true; }
  ok(threw, "duplicate ids rejected");
  threw = false;
  try { R.defineFeature({ id: "x", settings: [{ type: "slider", key: "s", min: 1, max: 1 }] }); } catch (e) { threw = true; }
  ok(threw, "invalid slider rejected");
});

test("toggle sprint holds and releases the sprint key", function () {
  sprintF.setEnabled(true);
  fire("tick", 1);
  ok(sprint.down, "held while enabled");
  sprintF.setEnabled(false);
  ok(!sprint.down, "released on disable");
});

test("info hud draws without leaking stacks", function () {
  infoHud.setEnabled(true);
  frame = makeCtx(480, 270);
  fire("renderoverlay", frame.ctx);
  eq(frame.depth, 0); eq(frame.bad.length, 0);
  ok(frame.texts.some(function (t) { return t.s === "XYZ"; }) && frame.texts.some(function (t) { return t.s === "1 64 -4"; }), "hud lines drawn");
});

test("/center waits for the chat screen to close, never uses Client.scheduleTask", function () {
  var chatScreen = { _cb: {} };
  currentScreen = chatScreen;
  SC.open("command");
  frames(3);
  eq(currentScreen, chatScreen, "does not replace chat while it is open");
  currentScreen = null; // chat closes after the command runs
  frames(3);
  ok(T.gui.isOpen(), "menu opens once chat is gone");
  Client.currentGui.close();
  eq(tasks.length, 0, "no work queued on CT's scheduleTask");
});

test("settings without optional fields get sane defaults (Rhino undefined > 0 bug)", function () {
  var f = R.defineFeature({ id: "defaults-test", settings: [
    { type: "slider", key: "a", min: 0, max: 5 },
    { type: "slider", key: "b", min: 0, max: 100 },
    { type: "text", key: "t" },
  ] });
  eq(f.setting("a").step, 0.1); eq(f.setting("b").step, 1); eq(f.setting("t").maxLength, 64);
  eq(f.set("a", 2.345), 2.3, "snaps to default step");
});

// ---------- HUD editor ----------
var edFrame = null;
function edRender(mx, my, w, h) {
  edFrame = makeCtx(w || 480, h || 270);
  E.render(edFrame.ctx, mx == null ? -1 : mx, my == null ? -1 : my);
  if (edFrame.bad.length) throw new Error("bad draw calls: " + edFrame.bad.slice(0, 3).join(" | "));
  eq(edFrame.depth, 0, "pose stack balanced");
  eq(edFrame.scissor, 0, "scissor stack balanced");
  return edFrame;
}
function hudBox() { var b = E.state.boxes.filter(function (x) { return x.el.feature.id === "info-hud"; })[0]; return b && b.box; }
function dragHud(fromX, fromY, toX, toY) {
  edRender(fromX, fromY);
  E.onClick(fromX, fromY, 0);
  edRender(toX, toY);
  E.gui._cb.mouseReleased(toX, toY, 0);
  edRender(toX, toY);
}

test("hud editor opens from /center hud and takes over HUD drawing", function () {
  infoHud.setEnabled(true);
  infoHud.set("scale", 1);
  // Keep the other preview clear of the Info HUD interaction scenarios.
  var amHud = HUD.get("auto-miner");
  var amBox = HUD.layout(amHud, 480, 270, true);
  HUD.setPos(amHud, 350, 195, amBox.w, amBox.h, 480, 270);
  fireCommand("center", "hud");
  frames();
  ok(E.gui.isOpen(), "editor opened");
  var overlay = makeCtx(480, 270);
  fire("renderoverlay", overlay.ctx);
  ok(!overlay.texts.some(function (t) { return t.s === "XYZ"; }), "overlay skipped while editing");
  edRender();
  ok(edFrame.texts.some(function (t) { return t.s === "XYZ"; }), "editor draws the element");
  ok(edFrame.texts.some(function (t) { return t.s === "HUD editor"; }) && edFrame.texts.some(function (t) { return t.s === "Done"; }), "toolbar drawn");
  var b = hudBox();
  eq(b.x, 6); eq(b.y, 6); eq(b.w, 83); eq(b.h, 38);
});

test("dragging moves the element; position is anchored to the nearest edge", function () {
  shift = true;
  dragHud(10, 10, 304, 154);
  shift = false;
  var b = hudBox();
  eq(b.x, 300); eq(b.y, 150);
  var p = HUD.getPos(infoHud.hud);
  eq(p.ax, 1, "right third anchors right"); eq(p.dx, -97);
  eq(p.ay, 0.5, "middle third anchors middle"); eq(p.dy, 34);
  edRender(-1, -1, 640, 360);
  eq(hudBox().x, 640 - 83 - 97, "keeps the distance from the right edge on a bigger screen");
  edRender();
  var overlay = makeCtx(480, 270);
  E.gui._cb.closed(); var saved = currentScreen; currentScreen = null;
  fire("renderoverlay", overlay.ctx);
  ok(overlay.translates.some(function (t) { return t[0] === 300 && t[1] === 150; }), "in-game HUD drawn at the new position");
  currentScreen = saved;
});

test("dragging snaps to edges and the screen center unless Shift is held", function () {
  var b = hudBox();
  dragHud(b.x + 5, b.y + 5, 3 + 5, b.y + 5);
  eq(hudBox().x, 0, "snaps to the left edge");
  ok(edFrame.fills > 0);
  b = hudBox();
  dragHud(b.x + 5, b.y + 5, 200.5 + 5, b.y + 5);
  eq(hudBox().x + hudBox().w / 2, 240, "snaps its center to the screen center");
  shift = true;
  b = hudBox();
  dragHud(b.x + 5, b.y + 5, 3 + 5, b.y + 5);
  shift = false;
  eq(hudBox().x, 3, "shift disables snapping");
});

test("scroll scales, arrows nudge, right-click resets", function () {
  var b = hudBox();
  E.onScroll(b.x + 2, b.y + 2, 1); edRender();
  eq(infoHud.get("scale"), 1.25, "scroll up grows");
  eq(hudBox().w, 83 * 1.25);
  E.onScroll(b.x + 2, b.y + 2, -1); edRender();
  eq(infoHud.get("scale"), 1, "scroll down shrinks");

  E.onClick(hudBox().x + 2, hudBox().y + 2, 0); E.gui._cb.mouseReleased(0, 0, 0); edRender();
  var x0 = hudBox().x, y0 = hudBox().y;
  E.onKey("", Keyboard.KEY_RIGHT); edRender();
  eq(hudBox().x, x0 + 1, "right arrow nudges 1px");
  shift = true; E.onKey("", Keyboard.KEY_DOWN); shift = false; edRender();
  eq(hudBox().y, y0 + 10, "shift+down nudges 10px");

  E.onClick(hudBox().x + 2, hudBox().y + 2, 1); edRender();
  ok(!HUD.isCustom(infoHud.hud), "right-click resets");
  eq(hudBox().x, 6); eq(hudBox().y, 6);
});

test("positions persist; Done returns to the game", function () {
  dragHud(10, 10, 54, 104);
  ST.flush();
  var saved = JSON.parse(files["center/config.json"]).features["info-hud"].hud;
  ok(saved && saved.ax === 0 && saved.dx === 50, "saved to config.json");
  edRender();
  var done = edFrame.texts.filter(function (t) { return t.s === "Done"; })[0];
  E.onClick(done.x + 2, done.y + 2, 0);
  eq(currentScreen, null, "back in game");
});

test("menu header 'Edit HUD' opens the editor and Done goes back to the menu", function () {
  SC.open(); frames();
  render();
  var btn = findText("Edit HUD");
  click(btn.x + 2, btn.y + 2);
  ok(E.gui.isOpen(), "editor opened from menu");
  edRender();
  var done = edFrame.texts.filter(function (t) { return t.s === "Done"; })[0];
  E.onClick(done.x + 2, done.y + 2, 0);
  ok(T.gui.isOpen(), "back in the menu");
  Client.currentGui.close();
});

test("disabled HUD modules can be previewed and moved without enabling them", function () {
  infoHud.setEnabled(false);
  HUD.reset(infoHud.hud);
  HE.open(); frames();
  edRender();
  ok(hudBox(), "disabled info HUD has an editable box");
  ok(edFrame.texts.some(function (t) { return t.s === "XYZ"; }), "actual HUD content is previewed");
  shift = true;
  dragHud(10, 10, 304, 154);
  shift = false;
  eq(hudBox().x, 300); eq(hudBox().y, 150);
  ok(!infoHud.isEnabled(), "dragging does not enable the feature");
  E.onKey("\u0100", Keyboard.KEY_ESCAPE);
  eq(currentScreen, null);
  ST.flush();
  ok(JSON.parse(files["center/config.json"]).features["info-hud"].hud, "disabled HUD position saved");
  var overlay = makeCtx(480, 270);
  fire("renderoverlay", overlay.ctx);
  ok(!overlay.texts.some(function (t) { return t.s === "XYZ"; }), "preview disappears outside the editor");
});

test("auto miner HUD previews and edits while disabled with Show HUD off", function () {
  var am = R.get("auto-miner");
  ok(!am.isEnabled() && !am.get("showHud"), "starts disabled with HUD hidden");
  var startsBefore = MOCKW.nativeStarts.length;
  var oldScale = am.get("scale");
  HE.open(); frames();
  edRender();
  var entry = E.state.boxes.filter(function (b) { return b.el.feature === am; })[0];
  ok(entry && !entry.box.empty, "full miner HUD instead of a placeholder");
  ok(edFrame.texts.some(function (t) { return t.s === "Off"; }), "miner status drawn");
  ok(edFrame.texts.some(function (t) { return t.s === "Cleared"; }), "details drawn");
  shift = true;
  dragHud(entry.box.x + 2, entry.box.y + 2, 202, 42);
  shift = false;
  entry = E.state.boxes.filter(function (b) { return b.el.feature === am; })[0];
  eq(entry.box.x, 200); eq(entry.box.y, 40);
  E.onScroll(202, 42, 1); edRender();
  eq(am.get("scale"), oldScale + 0.25, "disabled preview scales");
  var scaledX = E.state.boxes.filter(function (b) { return b.el.feature === am; })[0].box.x;
  E.onKey("", Keyboard.KEY_RIGHT); edRender();
  entry = E.state.boxes.filter(function (b) { return b.el.feature === am; })[0];
  eq(entry.box.x, scaledX + 1, "disabled preview nudges");
  frames(); ticks(3);
  ok(!am.isEnabled() && !am.get("showHud"), "feature and HUD visibility stay unchanged");
  eq(MOCKW.nativeStarts.length, startsBefore, "preview never starts mining");
  eq(mc.options.keyAttack.down, false);
  E.onKey("", Keyboard.KEY_ESCAPE);
  eq(currentScreen, null);
  eq(ST.entry("auto-miner").hud.ax, 0.5, "edited position retained");
  ok(!overlayTexts().some(function (s) { return s === "Auto Miner"; }), "miner HUD hidden after editor closes");
  am.set("scale", oldScale);
});

test("HUD editor previews auto miner outside a world and uses placeholders for empty HUDs", function () {
  worldLoaded = false;
  HE.open(); frames();
  edRender();
  var am = R.get("auto-miner");
  var entry = E.state.boxes.filter(function (b) { return b.el.feature === am; })[0];
  ok(entry && !entry.box.empty, "miner preview requires no world");
  ok(hudBox().empty, "empty info HUD still has a movable placeholder");
  ok(!am.isEnabled() && !infoHud.isEnabled(), "preview leaves features off");
  E.onKey("", Keyboard.KEY_ESCAPE);
  worldLoaded = true;
});

test("small screens still lay out", function () {  SC.open(); frames();
  frame = makeCtx(320, 200);
  T.render(frame.ctx, 10, 10);
  eq(frame.depth, 0); eq(frame.scissor, 0); eq(frame.bad.length, 0);
  Client.currentGui.close();
});

// ---------- Auto Miner feature ----------
var miner = R.get("auto-miner");
function chatHas(s) { return chat.some(function (m) { return m.indexOf(s) >= 0; }); }
function ticks(n) { for (var i = 0; i < n; i++) fire("tick", i); }
function overlayTexts() {
  var c = makeCtx(480, 270);
  fire("renderoverlay", c.ctx);
  eq(c.depth, 0, "pose stack balanced"); eq(c.scissor, 0, "scissor stack balanced"); eq(c.bad.length, 0, "draw args");
  return c.texts.map(function (t) { return t.s; });
}

test("auto miner always loads disabled and adopts the MVP module's settings", function () {
  frames();
  ok(!miner.isEnabled(), "saved enabled state is ignored (persistEnabled: false)");
  eq(miner.category, "Automation");
  eq(miner.get("glide"), 1.5, "glide migrated");
  eq(miner.get("showHud"), false, "hud flag migrated");
  ok(miner.hud && HUD.get("auto-miner") === miner.hud, "movable HUD element");
});

test("/am from chat arms, starts once chat closes, and draws its HUD", function () {
  miner.set("showHud", true);
  chat.length = 0;
  var chatScreen = { _cb: {} };
  currentScreen = chatScreen;
  fireCommand("auto-miner");
  ok(miner.isEnabled(), "enabled by /am");
  ticks(5);
  ok(!chatHas("On."), "waits while chat is open");
  ok(overlayTexts().indexOf("Starts when this screen closes") >= 0, "HUD explains the wait");
  currentScreen = null;
  ticks(2);
  ok(chatHas("On. Mining reachable cobblestone, iron ore, diamond ore, ancient debris, and purple, red or lime glazed terracotta"), "started");
  eq(mc.options.pauseOnLostFocus, false, "focus pause disabled while running");
  eq(mc.options.getCameraType(), "back", "third person while running");
  ticks(1); // first scan: nothing to mine in the mock world yet
  var texts = overlayTexts();
  ok(texts.indexOf("Auto Miner") >= 0 && texts.indexOf("Waiting for reachable blocks") >= 0, "HUD drawn: " + texts.join(", "));
  ok(texts.indexOf("Cleared") >= 0, "details shown");
});

test("physical mouse controls the perspective without turning the miner or its target ray", function () {
  var yaw = mc.player.getYRot(), pitch = mc.player.getXRot();
  MOCKW.updateHit(); var hit = mc.hitResult;
  var angles = invokeViewHook("cameraRotation", { entity: () => mc.player }, 50, 40);
  var delta = invokeViewHook("mouseTurn", {}, 120, -40);
  eq(delta[0], 0); eq(delta[1], 0);
  var turned = invokeViewHook("cameraRotation", { entity: () => mc.player }, 50, 40);
  ok(Math.abs(turned[0] - angles[0] - 18) < 0.001);
  ok(Math.abs(turned[1] - angles[1] + 6) < 0.001);
  eq(mc.player.getYRot(), yaw); eq(mc.player.getXRot(), pitch); eq(mc.hitResult, hit);
  frames();
  var afterAutomation = invokeViewHook("cameraRotation", { entity: () => mc.player }, -99, -99);
  eq(afterAutomation[0], turned[0], "automation cannot drag the orbit view");
  eq(afterAutomation[1], turned[1]);
});

test("opening chat stops the miner; /am typed in that chat does not restart it", function () {
  chat.length = 0;
  var chatScreen = { _cb: {} };
  currentScreen = chatScreen;
  fire("guiopened", chatScreen);
  ok(chatHas("Stopped: Screen opened."), "reason announced");
  eq(mc.options.pauseOnLostFocus, true, "focus pause restored immediately");
  eq(mc.options.getCameraType(), "first", "view restored immediately");
  var normal = invokeViewHook("mouseTurn", {}, 12, 5);
  eq(normal[0], 12); eq(normal[1], 5);
  frames();
  ok(!miner.isEnabled(), "feature switched off on the next frame");
  fireCommand("auto-miner");
  fireCommand("auto-miner", "stop");
  frames();
  ok(!miner.isEnabled(), "toggle in the same chat means off, not restart");
  ok(!chatHas("Not running."), "no redundant message");
  currentScreen = null;
});

test("/am stop releases input; start is refused without a pickaxe; unload restores settings", function () {
  MOCKW.blocks.set("0,63,1", MOCKW.cobble);
  chat.length = 0;
  fireCommand("auto-miner", "start");
  ticks(2);
  ok(chatHas("On."), "running");
  fireCommand("auto-miner", "start");
  ok(chatHas("Already running."));
  fireCommand("auto-miner", "stop");
  ok(!miner.isEnabled() && chatHas("Stopped."), "stopped by command");
  eq(mc.options.keyAttack.down, false);
  eq(mc.options.pauseOnLostFocus, true);

  chat.length = 0;
  MOCKW.hasPickaxe = false;
  fireCommand("auto-miner", "start");
  ticks(2);
  ok(chatHas("Put a pickaxe"), "refusal explained");
  frames();
  ok(!miner.isEnabled(), "refused start switches the feature off");
  MOCKW.hasPickaxe = true;

  miner.setEnabled(true, "gui");
  ticks(2);
  eq(mc.options.pauseOnLostFocus, false);
  fire("gameunload");
  eq(mc.options.pauseOnLostFocus, true, "registry shutdown releases the miner");
  miner.setEnabled(false, "api");
  MOCKW.blocks.delete("0,63,1");
});

test("/am status, debug and glide", function () {
  chat.length = 0;
  fireCommand("auto-miner", "status");
  ok(chatHas("ticks/block"), "status line");
  fireCommand("auto-miner", "debug");
  ok(chatHas("native starts="), "debug line");
  fireCommand("auto-miner", "glide", "5");
  ok(chatHas("Usage: /am glide"), "out of range rejected");
  eq(miner.get("glide"), 1.5);
  fireCommand("auto-miner", "glide", "0.5");
  eq(miner.get("glide"), 0.5);
  fireCommand("auto-miner", "hud");
  eq(miner.get("showHud"), false);
  fireCommand("auto-miner", "hud");
  ok(!miner.isEnabled());
});

test("menu lists Auto Miner under Automation with its settings", function () {
  SC.open(); frames();
  render();
  click(findText("Automation").x + 2, findText("Automation").y + 2);
  eq(T.state.page, "Automation");
  ok(hasText("Auto Miner") && !hasText("Info HUD"), "category filter");
  click(CARD_X + 40, cardY("Auto Miner") + 10);
  ok(hasText("Glide") && hasText("Show HUD") && hasText("Diagnostics") && hasText("Toggle key"), "settings rows");
  ok(!hasText("Randomness") && miner.setting("randomness") === null, "randomness setting removed");
  Client.currentGui.close();
});

// ---------- Auto Farm integration ----------
var farmFeature = R.get("auto-farm");
test("auto farm loads disabled, uses center settings and saves waypoint commands", function () {
  frames();
  ok(farmFeature && !farmFeature.isEnabled());
  eq(farmFeature.get("pitch"), 20); eq(farmFeature.category, "Automation");
  eq(farmFeature.get("sweepTime"), 0.5, "old full period converted to side-to-side time");
  eq(ST.entry("auto-farm").values.sweepPeriod, undefined, "obsolete setting migrated");
  fireCommand("auto-farm", "clear");
  mc.player.x = 0.5; mc.player.y = 64; mc.player.z = 0.5;
  fireCommand("auto-farm", "add");
  mc.player.z = 4.5; fireCommand("auto-farm", "add");
  mc.player.z = 8.5; fireCommand("auto-farm", "add");
  var saved = JSON.parse(files["center/config.json"]).features["auto-farm"].route;
  eq(saved.points.length, 3); ok(saved.context.indexOf("example.test") >= 0);
  fireCommand("auto-farm", "remove", "2");
  eq(ST.entry("auto-farm").route.points[1].z, 8.5, "numbered remove renumbers");
  fireCommand("auto-farm", "remove"); eq(ST.entry("auto-farm").route.points.length, 1, "remove defaults to last");
  fireCommand("auto-farm", "remove", "0"); eq(ST.entry("auto-farm").route.points.length, 1, "invalid index rejected");
  fireCommand("auto-farm", "add");
  fireCommand("auto-farm", "status"); fireCommand("auto-farm", "list"); fireCommand("auto-farm", "help");
  ok(chatHas("/af remove [number]"), "command help available");
});

test("saved chams render while disabled, honor visibility and hide in another dimension", function () {
  MOCKW.gizmos.length = 0;
  fire("prerenderworld"); eq(MOCKW.gizmos.length, 4); eq(MOCKW.collections, 0);
  farmFeature.set("showWaypoints", false); fire("prerenderworld"); eq(MOCKW.gizmos.length, 4);
  farmFeature.set("showWaypoints", true);
  MOCKW.dimension = "minecraft:the_nether"; fire("prerenderworld"); eq(MOCKW.gizmos.length, 4);
  MOCKW.dimension = "minecraft:overworld";
});

test("Auto Farm saves settings immediately and named configs restore routes without starting farming", function () {
  farmFeature.set("pitch", 37);
  eq(JSON.parse(files["center/config.json"]).features["auto-farm"].values.pitch, 37, "setting saved immediately");
  fireCommand("auto-farm", "save", "wheat");
  var disk = JSON.parse(files["center/config.json"]).features["auto-farm"];
  eq(disk.profiles.length, 1); eq(disk.profiles[0].name, "wheat");
  eq(disk.profiles[0].route.points.length, 2); eq(disk.profiles[0].values.pitch, 37);
  fireCommand("auto-farm", "clear"); farmFeature.set("pitch", 10);
  farmFeature.setEnabled(true);
  fireCommand("auto-farm", "load", "wheat");
  ok(!farmFeature.isEnabled(), "loading disables automation");
  eq(farmFeature.get("pitch"), 37); eq(ST.entry("auto-farm").route.points.length, 2);
  fireCommand("auto-farm", "configs"); ok(chatHas("Saved configs: &fwheat"));
  fireCommand("auto-farm", "delete", "wheat"); eq(ST.entry("auto-farm").profiles.length, 0);
  eq(ST.entry("auto-farm").route.points.length, 2, "deleting a save preserves the working route");
  farmFeature.set("pitch", 20);
});

test("auto farm waits for chat, stops on screens, and never fights Auto Miner", function () {
  MOCKW.floor(); mc.player.z = 0.5;
  var chatScreen = { _cb: {} };
  currentScreen = chatScreen;
  fireCommand("auto-farm", "start");
  ticks(2); ok(farmFeature.isEnabled()); eq(MOCKW.selectedSlot, 0, "waits for chat");
  currentScreen = null;
  ticks(2); eq(MOCKW.selectedSlot, 4, "hoe equipped"); eq(mc.options.keyAttack.down, true);
  eq(mc.options.pauseOnLostFocus, false, "farming keeps running without focus");
  eq(mc.options.getCameraType(), "back");
  var yaw = mc.player.getYRot(), pitch = mc.player.getXRot();
  eq(invokeViewHook("mouseTurn", {}, 70, 30)[0], 0);
  eq(mc.player.getYRot(), yaw); eq(mc.player.getXRot(), pitch);
  currentScreen = chatScreen; fire("guiopened", chatScreen);
  eq(mc.options.keyAttack.down, false, "release is immediate");
  eq(mc.options.pauseOnLostFocus, true); eq(mc.options.getCameraType(), "first");
  frames(); ok(!farmFeature.isEnabled());
  fireCommand("auto-farm"); frames(); ok(!farmFeature.isEnabled(), "same stopping chat does not toggle back on");
  currentScreen = null;
  miner.setEnabled(true); farmFeature.setEnabled(true); ok(!miner.isEnabled(), "farm disables miner");
  ticks(2); ok(farmFeature.isEnabled());
  miner.setEnabled(true); ok(!farmFeature.isEnabled(), "miner disables farm");
  eq(mc.options.keyAttack.down, false); miner.setEnabled(false);
  eq(mc.options.getCameraType(), "first"); eq(mc.options.pauseOnLostFocus, true, "switching automations preserves the original options");
});

test("auto farm HUD previews while disabled and shutdown/unload release all inputs", function () {
  farmFeature.set("showHud", false);
  HE.open(); frames(); edRender();
  ok(E.state.boxes.some(b => b.el.feature === farmFeature && !b.box.empty), "disabled HUD preview");
  ok(edFrame.texts.some(t => t.s === "Auto Farm"));
  E.onKey("", Keyboard.KEY_ESCAPE);
  farmFeature.set("showHud", true);
  farmFeature.setEnabled(true); ticks(2);
  ok(overlayTexts().indexOf("Auto Farm") >= 0);
  fire("worldunload"); frames(); ok(!farmFeature.isEnabled());
  eq(mc.options.getCameraType(), "first"); eq(mc.options.pauseOnLostFocus, true);
  ["Up", "Down", "Left", "Right", "Attack", "Jump", "Sprint"].forEach(k => eq(mc.options["key" + k].down, false));
  farmFeature.setEnabled(true); ticks(2); fire("gameunload");
  eq(mc.options.keyAttack.down, false); eq(mc.options.keyUp.down, false);
  eq(mc.options.getCameraType(), "first"); eq(mc.options.pauseOnLostFocus, true);
  farmFeature.setEnabled(false);
});

test("Auto Farm menu exposes a working pitch slider and the sweep controls", function () {
  SC.open(); frames(); render();
  click(findText("Automation").x + 2, findText("Automation").y + 2);
  click(CARD_X + 40, cardY("Auto Farm") + 10);
  ok(hasText("Look pitch") && hasText("Sweep width") && hasText("Sweep time"));
  click(RIGHT, rowY("Look pitch") + 11);
  eq(farmFeature.get("pitch"), 90, "pitch slider is connected to feature settings");
  farmFeature.set("pitch", 20);
  Client.currentGui.close();
});

test("crop generation commands keep the old route on failure, cancellation and world change, then persist a completed loop", function () {
  var before = JSON.stringify(ST.entry("auto-farm").route);
  currentScreen = null; mc.player.x = 0.5; mc.player.y = 64; mc.player.z = 0.5;
  MOCKW.grounded = true; MOCKW.crops.clear();
  fireCommand("auto-farm", "generate"); ticks(2);
  eq(JSON.stringify(ST.entry("auto-farm").route), before, "failed generation preserves route");
  for (var x = 0; x < 5; x++) for (var z = 0; z < 8; z++) MOCKW.crops.set(x + ",64," + z, MOCKW.wheat);
  fireCommand("auto-farm", "generate"); fireCommand("auto-farm", "stop"); ticks(20);
  eq(JSON.stringify(ST.entry("auto-farm").route), before, "cancel does not replace route");
  fireCommand("auto-farm", "generate"); MOCKW.dimension = "minecraft:the_nether"; ticks(2);
  MOCKW.dimension = "minecraft:overworld";
  eq(JSON.stringify(ST.entry("auto-farm").route), before, "dimension change preserves route");
  fireCommand("auto-farm", "generate"); ticks(200);
  var generatedRoute = ST.entry("auto-farm").route;
  eq(generatedRoute.crop, "minecraft:wheat"); ok(generatedRoute.points.length >= 2);
  ok(!farmFeature.isEnabled(), "generation does not start the macro");
  eq(JSON.parse(files["center/config.json"]).features["auto-farm"].route.crop, "minecraft:wheat", "saved to disk");
  fireCommand("auto-farm", "save", "generated"); fireCommand("auto-farm", "clear");
  fireCommand("auto-farm", "load", "generated");
  eq(ST.entry("auto-farm").route.crop, "minecraft:wheat", "profile restores generated-route validation");
});

print(passed + " tests passed");
