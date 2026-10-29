// Recovery policy, independent of Minecraft so timings and cancellation can be tested.
const SMALL = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ";
const ASCII = "abcdefghijklmnopqrstuvwyz";
function fold(value) {
  return String(value || "").replace(/§[0-9a-fk-orx]/gi, "").split("").map(c => {
    const i = SMALL.indexOf(c);
    return i >= 0 ? ASCII[i] : c;
  }).join("").toLowerCase().replace(/[^a-z0-9]/g, "");
}
const addressKey = value => String(value || "").trim().toLowerCase().replace(/:25565$/, "");
function backend(brand) {
  const hit = String(brand || "").match(/->\s*(\S+)\s*$/);
  return hit ? hit[1].replace(/[-_]?\d+$/, "").toLowerCase() : "";
}
function findMode(items, mode) {
  const want = fold(mode);
  if (!want) return null;
  for (const field of ["name", "lore"]) {
    const hit = items.find(item => fold(item[field]).indexOf(want) >= 0);
    if (hit) return hit.slot;
  }
  return null;
}

function createReconnect(deps) {
  let target = null, phase = "idle", next = 0, attempts = 0, modeAttempts = 0;
  let healthySince = null, readySince = null, lastOnline = false, held = false, menuId = null;
  let message = "Waiting for server", lastMessage = "";
  function status(text) {
    message = text;
    if (text !== lastMessage) { lastMessage = text; deps.report(text); }
  }
  function pause() { held = true; deps.pause(); }
  function resetMode() { readySince = null; modeAttempts = 0; menuId = null; }
  function cancel(reason) {
    if (held) deps.cancel();
    held = false; target = null; phase = "idle"; next = 0; attempts = 0;
    healthySince = null; lastOnline = false; resetMode();
    status(reason || "Waiting for server");
  }
  function matches(s) { return s.online && addressKey(s.address) === addressKey(deps.setting("server")); }
  function lost() {
    const s = deps.read();
    if (matches(s)) target = s.server;
    if (!target) return;
    pause();
    healthySince = null; lastOnline = false; resetMode();
    phase = "transition"; next = deps.now() + 5000;
    status("Connection interrupted; keeping automation paused");
  }
  function modeRetry(s, reason) {
    if (menuId !== null && s.menu && s.menu.id === menuId) deps.closeMenu();
    menuId = null;
    phase = "lobby";
    next = deps.now() + Math.min(30000, 2000 * Math.pow(2, Math.min(modeAttempts, 4)));
    status(reason + "; retrying mode selection");
  }
  function online(s, now) {
    target = s.server;
    if (!lastOnline) { resetMode(); phase = "restoring"; next = now + 2000; pause(); }
    lastOnline = true;
    if (healthySince === null) healthySince = now;
    if (now - healthySince >= 60000) attempts = 0;
    const current = backend(s.brand);
    const want = fold(deps.setting("backend")) || (fold(deps.setting("mode")) === "genblock" ? "gblock" : fold(deps.setting("mode")));
    if (current && fold(current) === want) {
      if (phase === "watching") return;
      if (readySince === null) readySince = now;
      status("In " + deps.setting("mode") + "; waiting for the world");
      if (now - readySince >= 3000 && s.screen === "none") {
        phase = "watching"; resetMode();
        held = false; deps.resume();
        status("Connected to " + deps.setting("mode"));
      }
      return;
    }
    readySince = null;
    if (phase === "watching") { pause(); phase = "restoring"; next = now + 2000; }
    if (!/^(lobby|hub)$/.test(current)) {
      status(current ? "Waiting for " + deps.setting("mode") + " (currently " + current + ")" : "Waiting for server mode information");
      return;
    }
    if (phase === "menu") {
      if (s.menu) {
        if (menuId === null) menuId = s.menu.id;
        if (s.menu.id !== menuId) { modeRetry(s, "Selector changed"); return; }
        const slot = findMode(s.menu.items, deps.setting("mode"));
        if (slot !== null) {
          // Set the phase first: even a re-entrant screen event cannot click twice.
          phase = "transfer"; next = now + 25000;
          deps.clickMode(slot);
          status("Selected " + deps.setting("mode") + "; waiting for transfer");
          return;
        }
      }
      if (now >= next) modeRetry(s, "Mode selector unavailable");
      return;
    }
    if (phase === "transfer") {
      if (now >= next) modeRetry(s, "Mode transfer timed out");
      return;
    }
    if (now < next || s.screen !== "none") return;
    // INKMC places the selector in hotbar slot 1. Wait until the item arrives.
    if (!s.selectorReady) { status("Waiting for the lobby selector"); return; }
    modeAttempts++;
    phase = "menu"; menuId = null; next = now + 10000;
    deps.openSelector();
    status("Opening mode selector");
  }
  function step() {
    const s = deps.read(), now = deps.now();
    if (s.online) {
      if (!matches(s)) { if (target || held) cancel("Other server; reconnect canceled"); return; }
      online(s, now);
      return;
    }
    if (!target) return;
    lastOnline = false; healthySince = null; readySince = null;
    if (s.screen === "disconnected") {
      pause();
      if (phase !== "waiting") {
        phase = "waiting";
        const delay = Math.min(60000, deps.setting("delay") * 1000 * Math.pow(2, Math.min(attempts, 6)));
        next = now + delay;
        status("Disconnected; reconnecting in " + Math.ceil(delay / 1000) + "s");
      }
      if (now >= next) {
        phase = "connecting"; attempts++;
        status("Reconnecting (attempt " + attempts + ")");
        deps.connect(target);
      }
      return;
    }
    if (s.screen === "connecting" || s.screen === "loading") { pause(); return; }
    if (s.screen === "none" && phase === "transition" && now < next) return;
    cancel("Reconnect canceled");
  }
  return { step, lost, cancel, isRecovering: () => held,
    state: () => ({ phase, next, attempts, message }) };
}
module.exports = { createReconnect, fold, backend, findMode, addressKey };
