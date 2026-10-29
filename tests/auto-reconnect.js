// Uses CT's Rhino, with a fake clock and connection/menu boundaries.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": " + a + " != " + b); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }
var REC = require("center/features/auto-reconnect/controller");
function harness() {
  var h = { time: 1000, connects: [], opens: 0, clicks: [], resumes: 0, cancels: 0, pauses: 0, closes: 0,
    settings: { server: "inkmc.pl", mode: "GenBlock", backend: "Gblock", delay: 10 },
    view: { online: true, address: "inkmc.pl:25565", server: { ip: "inkmc.pl" }, screen: "none",
      brand: "INKMC.pl × PROXY_01 -> Gblock0", selectorReady: true, menu: null } };
  h.ctrl = REC.createReconnect({ now: () => h.time, setting: k => h.settings[k], read: () => h.view,
    pause: () => h.pauses++, resume: () => h.resumes++, cancel: () => h.cancels++,
    report: () => {}, connect: server => { h.connects.push(server); h.view.screen = "connecting"; },
    openSelector: () => h.opens++, clickMode: slot => h.clicks.push(slot), closeMenu: () => h.closes++ });
  h.step = function (ms) { h.time += ms || 0; h.ctrl.step(); };
  h.ready = function () { h.step(); h.step(3000); eq(h.ctrl.state().phase, "watching"); };
  h.drop = function () { h.ctrl.lost(); h.view.online = false; h.view.screen = "disconnected"; h.step(); };
  return h;
}
test("recognizes numbered backends and styled mode lore", function () {
  eq(REC.backend("INKMC.pl × PROXY_01 -> Lobby-03"), "lobby");
  eq(REC.backend("INKMC.pl × PROXY_01 -> Gblock0"), "gblock");
  eq(REC.backend("vanilla"), "");
  eq(REC.fold("§aɢᴇɴʙʟᴏᴄᴋ"), "genblock");
  eq(REC.findMode([{ slot: 12, name: "", lore: "§6Tryb: ɢᴇɴʙʟᴏᴄᴋ" }], "GenBlock"), 12);
  eq(REC.findMode([{ slot: 3, name: "Other", lore: "" }], "GenBlock"), null);
  eq(REC.findMode([{ slot: 3, name: "Other" }], ""), null);
});
test("retries outside a world with exponential backoff capped at sixty seconds", function () {
  var h = harness(); h.ready(); h.drop();
  [10000, 20000, 40000, 60000, 60000].forEach(function (delay, i) {
    eq(h.ctrl.state().next - h.time, delay);
    h.step(delay - 1); eq(h.connects.length, i);
    h.step(1); eq(h.connects.length, i + 1);
    eq(h.connects[i], h.view.server, "reuse original server data and premium session");
    h.step(1000); eq(h.connects.length, i + 1, "no duplicate in-flight connection");
    h.view.screen = "disconnected"; h.step();
  });
});
test("premium recovery selects the mode by lore and waits for a confirmed loaded mode", function () {
  var h = harness(); h.ready(); h.drop(); h.step(10000);
  h.view.online = true; h.view.screen = "none"; h.view.brand = "INKMC.pl -> Limbo";
  h.step(); eq(h.opens, 0); eq(h.resumes, 1);
  h.view.brand = "INKMC.pl -> Lobby-03"; h.step(2000); eq(h.opens, 1);
  h.view.screen = "other";
  h.view.menu = { id: 7, items: [{ slot: 13, name: "", lore: "Tryb: ɢᴇɴʙʟᴏᴄᴋ" }] };
  h.step(200); eq(h.clicks.join(","), "13");
  h.step(1000); eq(h.clicks.length, 1, "one click per transfer attempt");
  h.view.menu = null; h.view.screen = "loading"; h.ctrl.lost(); h.view.online = false; h.step();
  h.view.online = true; h.view.screen = "none"; h.view.brand = "INKMC.pl -> Gblock0";
  h.step(); h.step(2999); eq(h.resumes, 1);
  h.step(1); eq(h.resumes, 2); eq(h.ctrl.isRecovering(), false);
});
test("unknown/wrong backend never resumes automation", function () {
  var h = harness(); h.ready(); h.drop();
  h.view.online = true; h.view.screen = "none"; h.view.brand = "vanilla"; h.step(10000);
  h.step(120000); eq(h.resumes, 1); eq(h.opens, 0);
  h.view.brand = "INKMC.pl -> BoxPvP0"; h.step(60000); eq(h.resumes, 1); eq(h.opens, 0);
});
test("a mode-server restart into the lobby pauses and selects again without reconnecting", function () {
  var h = harness(); h.ready();
  h.view.brand = "INKMC.pl -> Lobby-01"; h.step();
  ok(h.ctrl.isRecovering()); h.step(2000); eq(h.opens, 1); eq(h.connects.length, 0);
});
test("missing menu and transfer timeout retry without click spam", function () {
  var h = harness(); h.view.brand = "INKMC.pl -> Lobby-03"; h.step(); h.step(2000);
  eq(h.opens, 1); h.step(10000); h.step(4000); eq(h.opens, 2);
  h.view.menu = { id: 2, items: [{ slot: 9, name: "GenBlock" }] }; h.view.screen = "other";
  h.step(); eq(h.clicks.length, 1);
  h.step(24999); eq(h.clicks.length, 1);
  h.step(1); eq(h.closes, 1);
  h.view.menu = null; h.view.screen = "none"; h.step(8000); eq(h.opens, 3);
});
test("unrelated screens and empty selector slots are left alone", function () {
  var h = harness(); h.view.brand = "INKMC.pl -> Lobby-03"; h.view.selectorReady = false;
  h.step(); h.step(30000); eq(h.opens, 0);
  h.view.selectorReady = true; h.view.screen = "other"; h.step(30000); eq(h.opens, 0);
  h.view.screen = "none"; h.step(); eq(h.opens, 1);
});
test("manual disconnect/back cancels recovery and never reconnects later", function () {
  var h = harness(); h.ready(); h.drop();
  h.view.screen = "other"; h.step(); eq(h.cancels, 1); eq(h.ctrl.isRecovering(), false);
  h.view.screen = "disconnected"; h.step(120000); eq(h.connects.length, 0);
});
test("an intentional leave is not mistaken for a network loss", function () {
  var h = harness(); h.ready(); h.ctrl.lost(); h.view.online = false; h.view.screen = "none";
  h.step(4999); eq(h.cancels, 0); h.view.screen = "other"; h.step(1); eq(h.cancels, 1);
  h.step(60000); eq(h.connects.length, 0);
});
test("joining another server cancels and does not run mode selection there", function () {
  var h = harness(); h.ready(); h.drop(); h.view.online = true; h.view.address = "elsewhere.net";
  h.view.screen = "none"; h.step(); eq(h.cancels, 1); h.step(60000); eq(h.opens, 0);
});
test("healthy minute resets backoff but a brief join does not", function () {
  var h = harness(); h.ready(); h.drop(); h.step(10000);
  h.view.online = true; h.view.screen = "none"; h.step(); h.step(3000); h.drop();
  eq(h.ctrl.state().next - h.time, 20000);
  h.step(20000); h.view.online = true; h.view.screen = "none"; h.step(); h.step(60000); h.drop();
  eq(h.ctrl.state().next - h.time, 10000);
});
test("cancel during a pending attempt drops the target and suspension", function () {
  var h = harness(); h.ready(); h.drop(); h.ctrl.cancel("Disabled"); h.step(60000);
  eq(h.connects.length, 0); eq(h.cancels, 1);
});
print(passed + " reconnect tests passed");
