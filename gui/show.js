// Screen switching. CT's Gui.open/onClose and Client.currentGui.set/close all
// go through Client.scheduleTask, which never fires on this client, so screens
// are set directly on Minecraft's Gui.
const log = require("../core/log");
const { defer } = require("../core/defer");

function setScreen(s) { Client.getMinecraft().gui.setScreen(s); }

const describe = s => { try { return s == null ? "none" : String(s.getClass().getName()); } catch (error) { return String(s); } };

// Opens `screen` once nothing else (e.g. the chat that ran a command) is open.
function openWhenFree(screen, what, source) {
  log.log(`${what} open requested (${source || "api"}), current screen: ${describe(Client.currentGui.get())}`);
  const attempt = n => {
    const current = Client.currentGui.get();
    if (current != null && current !== screen && n < 30) { defer(() => attempt(n + 1)); return; }
    setScreen(screen);
    defer(() => {
      const now_ = Client.currentGui.get();
      if (now_ !== screen) log.log(`${what} is not the current screen after opening; current: ${describe(now_)}`);
    }, 2);
  };
  defer(() => attempt(0));
}

module.exports = { setScreen, openWhenFree };
