// Auto Farm integration: center owns settings, toggle key, HUD and lifecycle;
// the farmer owns the camera, hotbar selection and all synthetic input.
const registry = require("../../core/registry");
const store = require("../../core/store");
const log = require("../../core/log");
const iface = require("../../core/interface");
const { defer } = require("../../core/defer");
const draw = require("../../gui/draw");
const theme = require("../../gui/theme");
const { createRoute } = require("./route");
const { createFarmer } = require("./farmer");
const { renderRoute } = require("./render");

const ID = "auto-farm";
const PREFIX = "&8[&bAuto Farm&8]&r ";
const SUBCOMMANDS = ["add", "remove", "clear", "start", "stop", "toggle", "status", "list", "help"];
const Clock = Java.type("java.lang.System");
const say = text => ChatLib.chat(PREFIX + text);
const route = createRoute(store.entry(ID).route, saved => {
  store.entry(ID).route = saved;
  store.markDirty();
  store.flush();
});
let farmer = null, types = null, unavailable = null, haltScreen = null;
let renderErrorAt = -Infinity;

function minecraftTypes() {
  const type = name => Java.type(name);
  return {
    AABB: type("net.minecraft.world.phys.AABB"),
    Vec3: type("net.minecraft.world.phys.Vec3"),
    ItemTags: type("net.minecraft.tags.ItemTags"),
    HitType: type("net.minecraft.world.phys.HitResult$Type"),
    InteractionHand: type("net.minecraft.world.InteractionHand"),
    LevelResource: type("net.minecraft.world.level.storage.LevelResource"),
    Gizmos: type("net.minecraft.gizmos.Gizmos"),
    GizmoStyle: type("net.minecraft.gizmos.GizmoStyle"),
    TextStyle: type("net.minecraft.gizmos.TextGizmo$Style"),
  };
}

function context() {
  if (!types || !World.isLoaded()) return null;
  const game = Client.getMinecraft();
  if (!game.level || !game.player) return null;
  const local = game.getSingleplayerServer();
  const server = game.getCurrentServer();
  const world = local ? "save:" + String(local.getWorldPath(types.LevelResource.ROOT).toAbsolutePath().normalize()) :
    server ? "server:" + String(server.ip).toLowerCase() : null;
  return world ? world + "|" + String(game.level.dimension().identifier()) : null;
}

function disableSoon(f) {
  defer(() => {
    if (f.isEnabled() && farmer && farmer.state().phase === "off") f.setEnabled(false, ID);
  });
}

function halted(f, reason) {
  say("&eStopped: " + reason);
  disableSoon(f);
}

function guard(f, where, fn) {
  return function () {
    try { return fn.apply(null, arguments); } catch (error) {
      log.error("Auto Farm " + where, error);
      try { if (farmer) farmer.stop("Internal error"); } catch (cleanup) { log.error("Auto Farm cleanup", cleanup); }
      say("&cStopped: internal error (see /ct console).");
      disableSoon(f);
    }
  };
}

function stopForEdit(f) {
  if (f.isEnabled()) f.setEnabled(false, "command");
}

function command(f, sub, value, extra) {
  const action = String(sub || "toggle").toLowerCase();
  if (!farmer && action !== "help") return say("&cUnavailable: " + unavailable + " (see /ct console).");
  if (extra !== undefined || (value !== undefined && action !== "remove")) return say("&eUse /af help for commands.");
  const saved = route.snapshot();
  switch (action) {
    case "add": {
      const world = context();
      if (!world) return say("&eJoin a world before adding waypoints.");
      const p = Client.getMinecraft().player;
      const error = route.add({ x: p.getX(), y: p.getY(), z: p.getZ() }, world);
      if (error) return say("&e" + error);
      stopForEdit(f);
      return say("&aAdded waypoint " + route.snapshot().points.length + ".");
    }
    case "remove": {
      const number = value === undefined ? saved.points.length : Number(value);
      const error = route.remove(value);
      if (error) return say("&e" + error);
      stopForEdit(f);
      return say("&7Removed waypoint " + number + "; remaining waypoints renumbered.");
    }
    case "clear":
      stopForEdit(f);
      route.clear();
      return say("&7Waypoints cleared.");
    case "start":
      if (f.isEnabled()) return say("&eAlready enabled.");
      f.setEnabled(true, "command");
      return;
    case "stop":
      stopForEdit(f);
      return say("&7Stopped.");
    case "toggle":
      if (f.isEnabled()) { stopForEdit(f); return say("&7Stopped."); }
      if (haltScreen != null && Client.currentGui.get() === haltScreen) return;
      f.setEnabled(true, "command");
      return;
    case "status":
      return say("&f" + farmer.state().status + " &7| " + saved.points.length + " waypoints" +
        (saved.points.length && saved.context !== context() ? " (another world or dimension)" : ""));
    case "list":
      if (!saved.points.length) return say("&7No waypoints. Stand at a position and use /af add.");
      say("&7Route order: 1 to " + saved.points.length + ", then back to 1.");
      saved.points.forEach((p, i) => say("&f" + (i + 1) + " &7: " + p.x.toFixed(2) + ", " + p.y.toFixed(2) + ", " + p.z.toFixed(2)));
      return;
    default:
      say("&f/af add &7- add your current position");
      say("&f/af remove [number] &7- remove that waypoint, or the last one");
      say("&f/af clear &7- delete the route");
      say("&f/af [start|stop|toggle|status|list] &7- control Auto Farm");
      say("&7Configure pitch, sweep, markers and toggle key in /center.");
  }
}

function measure(f, preview) {
  if (!farmer || (!preview && (!f.get("showHud") || !World.isLoaded()))) return null;
  const state = farmer.state();
  return { w: Math.max(110, draw.width(state.status) + 10), h: 28, state };
}

module.exports = registry.defineFeature({
  id: ID,
  name: "Auto Farm",
  category: "Automation",
  description: "Loops through /af waypoints with a hotbar hoe, sweeps across crops, and anticipates one-block jumps.",
  persistEnabled: false,
  settings: [
    { type: "slider", key: "pitch", name: "Look pitch", min: 0, max: 90, step: 1, default: 20, unit: "deg",
      description: "Downward camera angle. 0 is level; 90 looks straight down." },
    { type: "slider", key: "sweepWidth", name: "Sweep width", min: 10, max: 80, step: 1, default: 45, unit: "deg",
      description: "How far the camera looks to each side of the route direction." },
    { type: "slider", key: "sweepPeriod", name: "Sweep period", min: 1, max: 6, step: 0.25, default: 2.5, unit: "s",
      description: "Time for a complete left-to-right-and-back camera sweep." },
    { type: "toggle", key: "sprint", name: "Sprint", default: true },
    { type: "toggle", key: "showWaypoints", name: "Waypoint chams", default: true,
      description: "Numbered translucent boxes through walls, visible even while farming is off. Gold marks the next waypoint." },
    { type: "toggle", key: "showHud", name: "Show HUD", default: true },
    { type: "slider", key: "scale", name: "HUD scale", min: 0.5, max: 2, step: 0.25, default: 1, unit: "x", visible: f => f.get("showHud") },
    { type: "button", name: "Waypoint commands", text: "Help", action() { command(this, "help"); } },
  ],
  setup(f) {
    register("command", guard(f, "command", (sub, value, extra) => command(f, sub, value, extra)))
      .setTabCompletions(args => {
        if (args.length <= 1) return SUBCOMMANDS.filter(s => s.startsWith(String(args[0] || "").toLowerCase()));
        if (String(args[0]).toLowerCase() === "remove" && args.length === 2) {
          return route.snapshot().points.map((p, i) => String(i + 1)).filter(s => s.startsWith(String(args[1] || "")));
        }
        return [];
      }).setName("auto-farm").setAliases("af", "autofarm");
    try { types = minecraftTypes(); } catch (error) {
      unavailable = String(error);
      log.error("Auto Farm unavailable", error);
      return;
    }
    farmer = createFarmer({
      T: types, game: () => Client.getMinecraft(), now: () => Clock.nanoTime() / 1e9,
      route: route.snapshot, context, inGui: () => Client.isInGui(), setting: key => f.get(key),
      onStart: () => say("&aOn. Following the waypoint loop. /af stop or your toggle key stops farming."),
      onHalt: reason => halted(f, reason),
    });
    f.on("tick", guard(f, "tick", () => farmer.tick()));
    f.on("step", guard(f, "camera", () => farmer.frame())).setFps(120);
    f.on("guiOpened", guard(f, "screen", screen => {
      const running = farmer.state().running;
      farmer.onScreenOpened();
      if (running) haltScreen = screen;
    }));
    ["worldUnload", "serverDisconnect"].forEach(event => f.on(event, guard(f, event, () => {
      farmer.stop("World unloaded");
      disableSoon(f);
    })));
    // Render the saved route during setup/editing too, while the feature is off.
    register("preRenderWorld", () => {
      try {
        if (!f.get("showWaypoints") || !World.isLoaded()) return;
        const saved = route.snapshot();
        if (!saved.points.length || saved.context !== context()) return;
        renderRoute(types, Client.getMinecraft(), saved, farmer.state().target, iface.get("accent"));
      } catch (error) {
        if (Date.now() - renderErrorAt > 5000) { renderErrorAt = Date.now(); log.error("Auto Farm markers", error); }
      }
    });
    registry.onToggle((other, on) => {
      if (other.id === "auto-miner" && on && f.isEnabled()) f.setEnabled(false, "automation-conflict");
    });
  },
  onEnable() {
    if (!farmer) throw new Error("Auto Farm is unavailable: " + unavailable);
    const miner = registry.get("auto-miner");
    if (miner && miner.isEnabled()) miner.setEnabled(false, "automation-conflict");
    haltScreen = null;
    farmer.start();
  },
  onDisable() { if (farmer) farmer.stop("Off"); },
  hud: {
    size: measure, scaleKey: "scale", default: { ax: 0, ay: 0.5, dx: 6, dy: 65 },
    render(f, size) {
      draw.rrect(0, 0, size.w, size.h, 4, theme.hudBg);
      draw.text("Auto Farm", 5, 5, size.state.running ? iface.get("accent") : theme.text);
      draw.text(size.state.status, 5, 15, theme.textDim);
    },
  },
});
