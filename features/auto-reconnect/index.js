const registry = require("../../core/registry");
const log = require("../../core/log");
const { createReconnect } = require("./controller");

// Load before other automations so lifecycle events release their controls first.
const AUTOMATIONS = ["anti-afk", "auto-farm", "auto-miner"];
const paused = new Set();
let recovery = null, types = null;

function mcTypes() {
  if (!types) types = {
    ConnectScreen: Java.type("net.minecraft.client.gui.screens.ConnectScreen"),
    DisconnectedScreen: Java.type("net.minecraft.client.gui.screens.DisconnectedScreen"),
    ServerAddress: Java.type("net.minecraft.client.multiplayer.resolver.ServerAddress"),
    TitleScreen: Java.type("net.minecraft.client.gui.screens.TitleScreen"),
    MultiplayerScreen: Java.type("net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen"),
    InteractionHand: Java.type("net.minecraft.world.InteractionHand"),
    DataComponents: Java.type("net.minecraft.core.component.DataComponents"),
  };
  return types;
}
function screenKind(screen) {
  if (!screen) return "none";
  const name = String(screen.getClass().getSimpleName());
  if (name === "DisconnectedScreen" || screen instanceof mcTypes().DisconnectedScreen) return "disconnected";
  if (name === "ConnectScreen") return "connecting";
  if (/ReceivingLevel|ProgressScreen|Loading|Reconfig/.test(name)) return "loading";
  return "other";
}
function readSnapshot() {
  const game = Client.getMinecraft(), screen = Client.currentGui.get();
  const player = game.player, server = game.getCurrentServer();
  const loaded = World.isLoaded() && player != null && game.level != null;
  const result = { online: !!loaded, server, address: server ? String(server.ip) : "",
    screen: screenKind(screen), brand: "", selectorReady: false, menu: null };
  if (!loaded || !server) return result;
  const connection = game.getConnection();
  result.brand = connection ? String(connection.serverBrand() || "") : "";
  const inv = player.getInventory(), menu = player.containerMenu;
  result.selectorReady = !inv.getItem(0).isEmpty();
  if (menu && menu !== player.inventoryMenu) {
    result.menu = { id: Number(menu.containerId), items: [] };
    const loreType = mcTypes().DataComponents.LORE;
    for (let i = 0; i < menu.slots.size(); i++) {
      const slot = menu.slots.get(i);
      // Never click a similarly named item in the player's own inventory.
      if (slot.container === inv) continue;
      const stack = slot.getItem();
      if (stack.isEmpty()) continue;
      const lore = stack.get(loreType);
      result.menu.items.push({ slot: i, name: String(stack.getHoverName().getString()),
        lore: lore ? Array.from(lore.lines()).map(line => String(line.getString())).join(" ") : "" });
    }
  }
  return result;
}
function pauseAutomations() {
  AUTOMATIONS.forEach(id => {
    const item = registry.get(id);
    if (item && item.isEnabled()) { paused.add(item); item.suspend(); }
  });
}
function finishAutomations(resume) {
  const items = Array.from(paused);
  paused.clear();
  items.forEach(item => {
    if (resume) item.resume();
    else if (item.isSuspended()) item.setEnabled(false, "reconnect-canceled");
  });
}

const feature = registry.defineFeature({
  id: "auto-reconnect", name: "Auto Reconnect", category: "Automation",
  description: "Reconnect to INKMC after a connection loss, select your mode and resume enabled automation. Premium account: no /login command.",
  settings: [
    { type: "text", key: "server", name: "Server address", default: "inkmc.pl", maxLength: 160 },
    { type: "text", key: "mode", name: "Mode name", default: "GenBlock", maxLength: 40,
      description: "Matches the mode selector item name or lore, including small-cap text." },
    { type: "text", key: "backend", name: "Mode server", default: "Gblock", maxLength: 40,
      description: "Server name reported by INKMC, without its number. GenBlock uses Gblock." },
    { type: "slider", key: "delay", name: "Retry delay", min: 5, max: 60, step: 1, default: 10, unit: "s",
      description: "Failed attempts back off up to 60 seconds." },
  ],
  setup(f) {
    recovery = createReconnect({
      now: () => Date.now(), setting: key => f.get(key), read: readSnapshot,
      pause: pauseAutomations, resume: () => finishAutomations(true), cancel: () => finishAutomations(false),
      report: text => log.log("reconnect: " + text),
      connect: server => {
        const t = mcTypes(), game = Client.getMinecraft();
        // CT's Client.connect uses its broken scheduleTask queue on this build.
        // step runs on the game/render thread, including outside a world.
        // Cancel must return to the server list, not to a failure screen that
        // would immediately schedule another retry.
        const parent = new t.MultiplayerScreen(new t.TitleScreen());
        t.ConnectScreen.startConnecting(parent, game,
          t.ServerAddress.parseString(String(server.ip)), server, false, null);
      },
      openSelector: () => {
        const game = Client.getMinecraft();
        game.player.getInventory().setSelectedSlot(0);
        game.gameMode.useItem(game.player, mcTypes().InteractionHand.MAIN_HAND);
      },
      clickMode: slot => Player.getContainer().click(slot, false, "LEFT"),
      closeMenu: () => Client.getMinecraft().player.closeContainer(),
    });
    f.on("step", () => recovery.step()).setFps(5);
    ["worldUnload", "serverDisconnect"].forEach(event =>
      f.on(event, () => recovery.lost()).setPriority(Priority.HIGHEST));
    f.on("guiOpened", screen => {
      if (screenKind(screen) === "disconnected") recovery.lost();
    }).setPriority(Priority.HIGHEST);
    f.on("postGuiRender", (ctx, mx, my, screen) => {
      const state = recovery.state();
      if (state.phase !== "waiting" || screenKind(screen) !== "disconnected") return;
      const seconds = Math.max(0, Math.ceil((state.next - Date.now()) / 1000));
      Renderer.drawStringWithShadow(ctx, "&bCenter: reconnecting in " + seconds + "s &7(back cancels)",
        8, ctx.guiHeight() - 20, Renderer.WHITE);
    });
    registry.onToggle((other, on) => {
      if (on && f.isEnabled() && recovery.isRecovering() && AUTOMATIONS.indexOf(other.id) >= 0) {
        paused.add(other); other.suspend();
      }
    });
  },
  onEnable() {
    mcTypes();
    recovery.cancel("Watching for " + this.get("server"));
    recovery.step();
  },
  onDisable() { if (recovery) recovery.cancel("Auto reconnect off"); },
  onChange() { if (recovery) recovery.cancel("Reconnect settings changed"); },
});
module.exports = feature;
