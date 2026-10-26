// Module registry. Every entry in the menu is a "feature" created with
// defineFeature(). Features own their triggers (feature.on), settings and
// toggle key; the menu only reads and writes through this API.
const store = require("./store");
const log = require("./log");
const { defer } = require("./defer");
const hud = require("./hud");

const TYPES = ["toggle", "slider", "select", "text", "keybind", "color", "button"];
const NONE = -1;
const features = [];
const byId = new Map();
const toggleListeners = [];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// CT's Rhino (opt 9) evaluates `x > 0` as true when x is undefined/NaN, so check the type first.
const positive = v => typeof v === "number" && v > 0;

function decimals(step) {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function snap(s, v) {
  const stepped = s.min + Math.round((clamp(v, s.min, s.max) - s.min) / s.step) * s.step;
  return Number(clamp(stepped, s.min, s.max).toFixed(decimals(s.step)));
}

// Returns a valid value for the setting, falling back to its default.
function validate(s, v) {
  switch (s.type) {
    case "toggle": return typeof v === "boolean" ? v : s.default;
    case "slider": return typeof v === "number" && isFinite(v) ? snap(s, v) : s.default;
    case "select": return s.options.indexOf(v) >= 0 ? v : s.default;
    case "text": return typeof v === "string" ? v.slice(0, s.maxLength) : s.default;
    case "keybind": return typeof v === "number" && Math.floor(v) === v && v >= NONE ? v : s.default;
    case "color": return typeof v === "number" && isFinite(v) ? v : s.default;
    default: return undefined;
  }
}

function normalizeSetting(raw, featureId) {
  if (!raw || TYPES.indexOf(raw.type) < 0) {
    throw new Error(`${featureId}: unknown setting type "${raw && raw.type}" (use ${TYPES.join(", ")})`);
  }
  const s = Object.assign({}, raw);
  s.name = s.name || s.key || "Action";
  if (s.type === "button") {
    if (typeof s.action !== "function") throw new Error(`${featureId}: button "${s.name}" needs an action function`);
    return s;
  }
  if (typeof s.key !== "string" || !s.key) throw new Error(`${featureId}: setting "${s.name}" needs a key`);
  if (s.type === "slider") {
    if (typeof s.min !== "number" || typeof s.max !== "number" || !(s.max > s.min)) {
      throw new Error(`${featureId}: slider "${s.key}" needs numeric min < max`);
    }
    if (!positive(s.step)) s.step = s.max - s.min <= 10 ? 0.1 : 1;
  }
  if (s.type === "select" || s.type === "color") {
    if (!s.options || !s.options.length) throw new Error(`${featureId}: ${s.type} "${s.key}" needs options`);
    s.options = Array.from(s.options);
  }
  if (s.type === "text") s.maxLength = positive(s.maxLength) ? s.maxLength : 64;
  const fallback = {
    toggle: false,
    slider: s.min,
    select: s.options && s.options[0],
    text: "",
    keybind: NONE,
    color: s.options && s.options[0],
  }[s.type];
  s.default = validate(Object.assign({}, s, { default: fallback }), s.default);
  return s;
}

class Feature {
  constructor(def) {
    this.id = def.id;
    this.name = def.name || def.id;
    this.description = def.description || "";
    this.category = def.category || "General";
    this.toggleable = def.toggleable !== false;
    this.hidden = def.hidden === true;
    this.persistEnabled = def.persistEnabled !== false;
    this.hooks = { enable: def.onEnable, disable: def.onDisable, change: def.onChange };
    this.settings = (def.settings || []).map(s => normalizeSetting(s, def.id));
    this.triggers = [];
    this.hud = null;
    this.lastError = 0;
    this.values = {};
    const saved = store.entry(this.id);
    this.settings.forEach(s => {
      if (s.type !== "button") this.values[s.key] = validate(s, saved.values[s.key]);
    });
    const bind = typeof saved.bind === "number" ? saved.bind : def.bind;
    this.bind = typeof bind === "number" && bind >= NONE ? bind : NONE;
    // Non-toggleable groups (like the menu's own settings) are always on.
    this.enabled = !this.toggleable;
  }

  setting(key) { return this.settings.find(s => s.key === key) || null; }

  get(key) { return this.values[key]; }

  set(key, value) {
    const s = this.setting(key);
    if (!s || s.type === "button") throw new Error(`${this.id}: no setting "${key}"`);
    const next = validate(s, value);
    if (next === this.values[key]) return next;
    this.values[key] = next;
    store.entry(this.id).values[key] = next;
    store.markDirty();
    this.call("change", key, next);
    return next;
  }

  reset() {
    this.settings.forEach(s => { if (s.type !== "button") this.set(s.key, s.default); });
  }

  isEnabled() { return this.enabled; }

  // source: "gui" | "key" | "command" | "load" | "api"
  setEnabled(on, source) {
    on = !!on;
    if (!this.toggleable || on === this.enabled) return this.enabled;
    this.enabled = on;
    this.triggers.forEach(t => (on ? t.register() : t.unregister()));
    const ok = this.call(on ? "enable" : "disable");
    if (on && !ok) {
      // A failing onEnable leaves the module off instead of half-running.
      this.enabled = false;
      this.triggers.forEach(t => t.unregister());
    }
    if (this.persistEnabled) {
      store.entry(this.id).enabled = this.enabled;
      store.markDirty();
    }
    const feature = this;
    toggleListeners.forEach(listener => {
      try { listener(feature, feature.enabled, source || "api"); } catch (error) { log.error("toggle listener", error); }
    });
    return this.enabled;
  }

  toggle(source) { return this.setEnabled(!this.enabled, source); }

  setBind(code) {
    this.bind = typeof code === "number" && code >= NONE ? code : NONE;
    store.entry(this.id).bind = this.bind;
    store.markDirty();
  }

  // Registers a CT trigger that only runs while this feature is enabled.
  // Errors are caught so CT does not silently unregister the trigger.
  on(type, fn) {
    const feature = this;
    const trigger = register(type, function () {
      try { return fn.apply(feature, arguments); } catch (error) { feature.fail(error); }
    });
    if (!this.enabled) trigger.unregister();
    this.triggers.push(trigger);
    return trigger;
  }

  call(hook) {
    const fn = this.hooks[hook];
    if (typeof fn !== "function") return true;
    try {
      fn.apply(this, Array.prototype.slice.call(arguments, 1));
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  fail(error) {
    const t = Date.now();
    if (t - this.lastError < 2000) return; // avoid flooding the console from per-frame triggers
    this.lastError = t;
    log.error(this.name, error);
  }
}

function defineFeature(def) {
  if (!def || typeof def.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(def.id)) {
    throw new Error(`defineFeature: invalid id "${def && def.id}"`);
  }
  if (byId.has(def.id)) throw new Error(`defineFeature: duplicate id "${def.id}"`);
  const feature = new Feature(def);
  features.push(feature);
  byId.set(feature.id, feature);
  if (typeof def.setup === "function") {
    try { def.setup(feature); } catch (error) { feature.fail(error); }
  }
  // Movable HUD element (see core/hud.js); positioned in the HUD editor.
  if (def.hud) feature.hud = hud.attach(feature, def.hud);
  // Restore on the next tick so the defining file has finished initialising.
  if (feature.toggleable && feature.persistEnabled && store.entry(feature.id).enabled === true) {
    defer(() => feature.setEnabled(true, "load"));
  }
  return feature;
}

const get = id => byId.get(id) || null;

// Visible features sorted by name.
function all() {
  return features.filter(f => !f.hidden).sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
}

function categories() {
  const seen = [];
  all().forEach(f => { if (seen.indexOf(f.category) < 0) seen.push(f.category); });
  return seen.sort();
}

function onToggle(listener) { toggleListeners.push(listener); }

// Gives enabled features a chance to release keys/state before /ct load or exit.
function shutdown() {
  features.forEach(f => { if (f.toggleable && f.enabled) f.call("disable"); });
}

module.exports = { NONE, defineFeature, get, all, categories, onToggle, shutdown, decimals };
