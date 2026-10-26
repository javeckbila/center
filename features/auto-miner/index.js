// Auto Miner: center feature wrapping the miner core (miner.js).
//
// Toggle it from the menu, its toggle key, or /am. Enabling arms the miner; it
// starts once no screen is open (so it can be enabled from chat or the menu).
// It always loads disabled. Settings, HUD position and the toggle key are
// managed by center; /am remains as a command interface.
const { defineFeature } = require("../../core/registry");
const store = require("../../core/store");
const log = require("../../core/log");
const iface = require("../../core/interface");
const { defer } = require("../../core/defer");
const draw = require("../../gui/draw");
const theme = require("../../gui/theme");
const { createMiner } = require("./miner");
const { AREA_WIDTH, AREA_DEPTH } = require("./geometry");

const ID = "auto-miner";
const LEGACY_MODULE = "auto-miner"; // the standalone MVP module this replaces
const PREFIX = "&8[&bAuto Miner&8]&r ";
const GLIDE_MIN = 0.25;
const GLIDE_MAX = 2;
const SUBCOMMANDS = ["start", "stop", "toggle", "status", "debug", "hud", "glide"];
const Clock = Java.type("java.lang.System");

const say = text => ChatLib.chat(PREFIX + text);

function minecraftTypes() {
  const type = name => Java.type(name);
  return {
    BlockPos: type("net.minecraft.core.BlockPos"),
    Vec3: type("net.minecraft.world.phys.Vec3"),
    ClipContext: type("net.minecraft.world.level.ClipContext"),
    ClipBlock: type("net.minecraft.world.level.ClipContext$Block"),
    ClipFluid: type("net.minecraft.world.level.ClipContext$Fluid"),
    HitType: type("net.minecraft.world.phys.HitResult$Type"),
    Blocks: type("net.minecraft.world.level.block.Blocks"),
    ItemTags: type("net.minecraft.tags.ItemTags"),
    PlayerActionPacket: type("net.minecraft.network.protocol.game.ServerboundPlayerActionPacket"),
    PlayerAction: type("net.minecraft.network.protocol.game.ServerboundPlayerActionPacket$Action"),
    InteractionHand: type("net.minecraft.world.InteractionHand"),
  };
}

// The MVP module kept { glide, hud } in auto-miner/settings.json; adopt them once.
(function migrateLegacySettings() {
  const values = store.entry(ID).values;
  if (values.glide !== undefined || values.showHud !== undefined) return;
  let saved = null;
  try { saved = JSON.parse(FileLib.read(LEGACY_MODULE, "settings.json") || "null"); } catch (error) { saved = null; }
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.glide === "number" && isFinite(saved.glide)) values.glide = saved.glide;
  if (typeof saved.hud === "boolean") values.showHud = saved.hud;
  store.markDirty();
})();

let miner = null;
let unavailable = null;
// The screen whose opening stopped the miner. Typing /am in that chat means
// "toggle off", which already happened, rather than "start again".
let haltScreen = null;

// ---------- lifecycle ----------

// Disabling from inside a trigger callback would unregister the trigger that
// is running, so the feature switch flips on the next frame.
function disableSoon(f) {
  defer(() => {
    if (f.isEnabled() && miner && miner.state().phase === "off") f.setEnabled(false, ID);
  });
}

function onHalt(f, reason, opts) {
  if (opts.refused) say("&e" + reason);
  else if (!opts.silent) say("&eStopped: " + reason + ".");
  disableSoon(f);
}

function stopSilently(f, reason) {
  if (miner && miner.stop(reason)) disableSoon(f);
}

function crash(f, where, error) {
  log.error("Auto Miner " + where, error);
  if (miner && miner.stop("Internal error")) {
    say("&cStopped: internal error (see /ct console).");
    disableSoon(f);
  }
}

const guard = (f, where, fn) => function () {
  try { return fn.apply(null, arguments); } catch (error) { crash(f, where, error); }
};

// ---------- reports ----------

const ticksText = n => (isFinite(n) && n > 0 ? String(n) : "?");

function statusLine() {
  const s = miner.state();
  return "&f" + s.status + " &7| " + ticksText(s.expectedTicks) + " ticks/block | ping " + Math.round(s.pingMs) +
    " ms | lead " + s.leadTicks + " ticks | target " + (s.target || "none") + " | next " + (s.next || "none");
}

function debugLine() {
  const s = miner.state();
  return "&f" + s.status + " &7| native starts=" + s.startAttempts + " (" + s.startResult + ") | START/ABORT/STOP=" +
    s.packets.start + "/" + s.packets.abort + "/" + s.packets.stop + " | last running tick: " + s.lastInput;
}

function requireMiner() {
  if (!miner) say("&cUnavailable: " + unavailable + " (see /ct console).");
  return !!miner;
}

// ---------- command ----------

function command(f, sub, value) {
  const action = String(sub || "toggle").toLowerCase();
  const stoppedByThisScreen = haltScreen != null && Client.currentGui.get() === haltScreen;
  switch (action) {
    case "toggle":
      if (f.isEnabled()) { f.setEnabled(false, "command"); say("&7Stopped."); }
      else if (!stoppedByThisScreen) f.setEnabled(true, "command");
      return;
    case "start":
      if (f.isEnabled()) return say("&eAlready running.");
      f.setEnabled(true, "command");
      return;
    case "stop":
      if (f.isEnabled()) { f.setEnabled(false, "command"); say("&7Stopped."); }
      else if (!stoppedByThisScreen) say("&7Not running.");
      return;
    case "status":
      if (requireMiner()) say(statusLine());
      return;
    case "debug":
      if (requireMiner()) say(debugLine());
      return;
    case "hud":
      f.set("showHud", !f.get("showHud"));
      say("&7HUD: " + (f.get("showHud") ? "shown" : "hidden") + ". Move it with /center hud.");
      return;
    case "glide": {
      const n = Number(value);
      if (value === undefined || !isFinite(n) || n < GLIDE_MIN || n > GLIDE_MAX) {
        return say("&eUsage: /am glide <" + GLIDE_MIN + ".." + GLIDE_MAX + ">  &7(current " + f.get("glide") + ")");
      }
      f.set("glide", n);
      return say("&7Glide: " + f.get("glide"));
    }
    default:
      say("&e/am <" + SUBCOMMANDS.join("|") + ">  &7Settings: /center");
  }
}

// ---------- HUD ----------

const PAD = 5;
const LINE = 10;
const GAP = 8;
const DOT = 6;
const TITLE = "Auto Miner";
const WARN = 0xFFF2A93B;
const ERROR = 0xFFF2685E;

function tone(activity) {
  if (activity === "mining" || activity === "gliding" || activity === "scanning") return iface.get("accent");
  if (activity === "rejected") return ERROR;
  if (activity === "off") return theme.textMute;
  return WARN; // starting, waiting, returning
}

function detailRows(f, s) {
  if (!f.get("hudDetails")) return [];
  return [
    ["Break", isFinite(s.expectedTicks) && s.expectedTicks > 0 ? s.expectedTicks + " ticks" : "-"],
    ["Ping", Math.round(s.pingMs) + " ms"],
    ["Tool speed", s.toolSpeed > 0 ? s.toolSpeed.toFixed(1) : "-"],
    ["Cleared", String(s.cleared)],
  ];
}

function measure(f) {
  if (!miner || !f.get("showHud") || !World.isLoaded()) return null;
  const s = miner.state();
  const rows = detailRows(f, s);
  const labelW = rows.length ? Math.max.apply(null, rows.map(r => draw.width(r[0]))) : 0;
  const valueW = rows.length ? Math.max.apply(null, rows.map(r => draw.width(r[1]))) : 0;
  const contentW = Math.max(DOT + 4 + draw.width(TITLE), draw.width(s.status), rows.length ? labelW + GAP + valueW : 0);
  const h = PAD * 2 + (2 + rows.length) * LINE - 2 + (rows.length ? 3 : 0);
  return { w: PAD * 2 + contentW, h, s, rows, labelW };
}

function render(f, size) {
  draw.rrect(0, 0, size.w, size.h, 4, theme.hudBg);
  draw.rrect(PAD, PAD + 1, DOT, DOT, 3, tone(size.s.activity));
  draw.text(TITLE, PAD + DOT + 4, PAD, theme.text);
  draw.text(size.s.status, PAD, PAD + LINE, theme.textDim);
  let y = PAD + LINE * 2 + 3;
  size.rows.forEach(r => {
    draw.text(r[0], PAD, y, theme.textMute);
    draw.text(r[1], PAD + size.labelW + GAP, y, theme.text);
    y += LINE;
  });
}

// ---------- feature ----------

module.exports = defineFeature({
  id: ID,
  name: "Auto Miner",
  category: "Automation",
  description: "Mines cobblestone, iron ore, diamond ore and ancient debris in a 4x4x4 area around you.",
  persistEnabled: false, // a macro must never resume by itself after a reload
  settings: [
    {
      type: "slider", key: "glide", name: "Glide", min: GLIDE_MIN, max: GLIDE_MAX, step: 0.05, default: 1, unit: "x",
      description: "Camera smoothing. Higher turns slower and drifts wider; lower turns faster.",
    },
    {
      type: "slider", key: "randomness", name: "Randomness", min: 0, max: 1, step: 0.05, default: 0.5,
      format: v => Math.round(v * 100) + "%",
      description: "How freely the next block is picked. 0% always takes the smallest turn; higher spreads mining " +
        "around the area. Recently mined blocks are avoided either way, so regenerating blocks are not looped.",
    },
    { type: "toggle", key: "showHud", name: "Show HUD", default: true },
    {
      type: "toggle", key: "hudDetails", name: "HUD details", default: true,
      description: "Break time, ping, tool speed and blocks cleared.", visible: f => f.get("showHud"),
    },
    { type: "slider", key: "scale", name: "HUD scale", min: 0.5, max: 2, step: 0.25, default: 1, unit: "x", visible: f => f.get("showHud") },
    {
      type: "button", name: "Diagnostics", text: "Print",
      description: "Prints the current status and startup/packet diagnostics to chat (same as /am status and /am debug).",
      action() { if (requireMiner()) { say(statusLine()); say(debugLine()); } },
    },
  ],

  setup(f) {
    // Always available, even while the feature is off.
    register("command", guard(f, "command", (sub, value) => command(f, sub, value)))
      .setTabCompletions(args => (args.length <= 1 ? SUBCOMMANDS.filter(s => s.startsWith(String(args[0] || "").toLowerCase())) : []))
      .setName("auto-miner")
      .setAliases("am", "autominer");

    let T;
    try {
      T = minecraftTypes();
    } catch (error) {
      unavailable = String(error);
      log.error("Auto Miner unavailable", error);
      return;
    }
    miner = createMiner({
      T,
      game: () => Client.getMinecraft(),
      now: () => Clock.nanoTime() / 1e9,
      inGui: () => Client.isInGui(),
      glide: () => f.get("glide"),
      randomness: () => f.get("randomness"),
      onStart: () => say("&aOn. Mining cobblestone, iron ore, diamond ore and ancient debris in the " + AREA_WIDTH + "x" + AREA_DEPTH + "x" + AREA_WIDTH +
        " area around you; your footing is kept."),
      onHalt: (reason, opts) => onHalt(f, reason, opts),
    });

    // Only registered while the feature is enabled (feature.on).
    f.on("tick", guard(f, "tick", () => miner.tick()));
    f.on("step", guard(f, "frame", () => miner.frame())).setFps(240);
    f.on("packetSent", (packet, event) => {
      // Read-only observer: a failure here is logged but does not stop mining.
      try { miner.onPacketSent(packet, event); } catch (error) { log.error("Auto Miner packet observer", error); }
    }).setFilteredClass(T.PlayerActionPacket).setPriority(Priority.LOWEST);
    f.on("guiOpened", guard(f, "screen", screen => {
      const wasRunning = miner.state().running;
      miner.onScreenOpened();
      if (wasRunning && !miner.state().running) haltScreen = screen;
    }));
    f.on("worldUnload", guard(f, "unload", () => stopSilently(f, "World unloaded")));
    f.on("serverDisconnect", guard(f, "disconnect", () => stopSilently(f, "Disconnected")));
  },

  onEnable() {
    if (!miner) throw new Error("Auto Miner is unavailable: " + unavailable);
    haltScreen = null;
    miner.start();
  },

  // Also runs on /ct load and game exit (registry.shutdown): release every
  // owned key and restore pause-on-focus-loss.
  onDisable() {
    if (miner) miner.stop("Off");
  },

  hud: { size: measure, render, scaleKey: "scale", default: { ax: 0, ay: 0.5, dx: 6, dy: 0 } },
});
