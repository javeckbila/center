// center: one menu to toggle and configure modules.
// Open with /center or Right Shift (configurable on the Settings page).
const registry = require("./core/registry");
const store = require("./core/store");
const iface = require("./core/interface");
const keys = require("./core/keys");
const log = require("./core/log");
const { defer } = require("./core/defer");
const screen = require("./gui/screen");
const hudEditor = require("./gui/hud-editor");
require("./gui/notify");
require("./features/index");

const PREFIX = "&8[&bcenter&8]&r ";
const say = text => ChatLib.chat(PREFIX + text);

const screenName = s => { try { return String(s.getClass().getName()); } catch (error) { return String(s); } };

// ---- key polling: menu key + per-module toggle keys ----
// (CT's KeyBind constructor is unreliable on this build, so keys are polled.)
const previous = new Map();
register("step", () => {
  try {
    const current = Client.currentGui.get();
    const ready = current == null && World.isLoaded();
    const binds = [];
    const openKey = iface.get("openKey");
    if (openKey >= 0) binds.push({ code: openKey, fire: () => screen.open("key") });
    registry.all().forEach(f => {
      if (f.toggleable && f.bind >= 0) binds.push({ code: f.bind, fire: () => f.toggle("key") });
    });
    const down = new Map();
    binds.forEach(b => { if (!down.has(b.code)) down.set(b.code, Keyboard.isKeyDown(b.code)); });
    // A press a screen already handled (the menu key closing the menu) is not a new press.
    down.forEach((isDown, code) => { if (keys.isConsumed(code, isDown)) previous.set(code, true); });
    // Fire on the press edge only, and never while a screen (chat, inventory...) is open.
    binds.forEach(b => {
      if (!down.get(b.code) || previous.get(b.code)) return;
      if (ready) b.fire();
      else if (b.code === openKey && !screen.isOpen()) {
        log.log(`menu key ${keys.name(openKey)} ignored: ${current == null ? "no world loaded" : "screen open: " + screenName(current)}`);
      }
    });
    previous.clear();
    down.forEach((v, k) => previous.set(k, v));
  } catch (error) {
    log.error("key polling", error);
  }
}).setFps(60);

// ---- persistence ----
register("step", () => store.flush()).setDelay(5);
register("gameUnload", () => {
  registry.shutdown();
  store.flush();
});

// ---- command ----
const findFeature = query => {
  const q = String(query || "").toLowerCase();
  return registry.all().find(f => f.id.toLowerCase() === q || f.name.toLowerCase().replace(/\s+/g, "") === q.replace(/\s+/g, "")) || null;
};

register("command", (sub, ...rest) => {
  const action = (sub || "").toLowerCase();
  if (!action) return screen.open("command");
  if (action === "hud" || action === "edit") return hudEditor.open("command");
  if (action === "list") {
    const list = registry.all();
    if (!list.length) return say("&7No modules registered.");
    say(`&7Modules (${list.length}):`);
    list.forEach(f => ChatLib.chat(`  ${f.isEnabled() ? "&a\u25CF" : "&8\u25CF"} &f${f.name} &8(${f.id})`));
    return;
  }
  if (action === "toggle" || action === "on" || action === "off") {
    const f = findFeature(rest.join(" "));
    if (!f) return say(`&cUnknown module. &7Try /center list`);
    if (!f.toggleable) return say(`&c${f.name} cannot be toggled.`);
    const on = f.setEnabled(action === "toggle" ? !f.isEnabled() : action === "on", "command");
    return say(`&f${f.name} ${on ? "&aenabled" : "&7disabled"}`);
  }
  say("&7/center &8- open menu");
  say("&7/center hud &8- move HUD modules");
  say("&7/center list &8- list modules");
  say("&7/center <toggle|on|off> <module> &8- toggle a module");
})
  .setTabCompletions(args => {
    const subs = ["hud", "list", "toggle", "on", "off"];
    if (args.length <= 1) return subs.filter(s => s.startsWith((args[0] || "").toLowerCase()));
    if (["toggle", "on", "off"].indexOf(String(args[0]).toLowerCase()) >= 0) {
      return registry.all().map(f => f.id).filter(id => id.startsWith((args[1] || "").toLowerCase()));
    }
    return [];
  })
  .setName("center");

log.log(`loaded ${registry.all().length} modules; menu key: ${keys.name(iface.get("openKey"))}`);
defer(() => {
  try { if (World.isLoaded()) say(`&7Loaded. Open with &f/center&7 or &f${keys.name(iface.get("openKey"))}&7.`); } catch (error) { log.error("load message", error); }
});

// Public API for other modules: const center = require("center");
module.exports = {
  defineFeature: registry.defineFeature,
  getFeature: registry.get,
  features: registry.all,
  open: screen.open,
  editHud: hudEditor.open,
};
