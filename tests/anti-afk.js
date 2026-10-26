// CT Rhino checks for real action pulses and lifecycle cleanup.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": got " + a + ", expected " + b); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }
var AFK = require("center/features/anti-afk/controller");

function harness() {
  var h = { loaded: true, gui: false, alive: true, grounded: true, sleeping: false, riding: false, spectator: false,
    using: false, swings: 0, starts: 0, stops: 0, hits: 0,
    settings: { interval: 4, rotate: true, turnAngle: 20, move: true, jump: true, crouch: true, attack: true } };
  var options = { pauseOnLostFocus: true };
  ["Up", "Down", "Left", "Right", "Jump", "Shift", "Attack", "Use"].forEach(function (k) {
    options["key" + k] = { down: false, toggle: false, isDown() { return this.down; },
      setDown(v) { this.down = this.toggle ? (v ? !this.down : this.down) : v; } };
  });
  var p = { yaw: 0, getYRot() { return this.yaw; }, getXRot() { return 0; }, setYRot(v) { this.yaw = v; },
    isAlive: () => h.alive, onGround: () => h.grounded, isSleeping: () => h.sleeping,
    isPassenger: () => h.riding, isUsingItem: () => h.using, swing() { h.swings++; } };
  h.game = { player: p, level: {}, options, hitResult: null, gameMode: {
    isSpectator: () => h.spectator, attack(player, entity) { eq(player, p); eq(entity, "target"); h.hits++; },
    startDestroyBlock(pos, face) { eq(pos, "block"); eq(face, "face"); h.starts++; },
    stopDestroyBlock() { h.stops++; },
  } };
  h.opts = options; h.player = p;
  h.ctrl = AFK.createAntiAfk({ game: () => h.game, loaded: () => h.loaded, inGui: () => h.gui,
    setting: key => h.settings[key], T: { HitType: { ENTITY: "entity", BLOCK: "block" }, InteractionHand: { MAIN_HAND: "main" } } });
  h.ticks = function (n) { for (var i = 0; i < n; i++) h.ctrl.tick(); };
  h.hit = function (kind) { h.game.hitResult = { getType: () => kind, getEntity: () => "target", getBlockPos: () => "block", getDirection: () => "face" }; };
  h.ctrl.start();
  return h;
}

test("waits four seconds, pulses every action, then reverses on the next interval", function () {
  var h = harness();
  h.ticks(79); eq(h.swings, 0); eq(h.player.yaw, 0); eq(h.opts.pauseOnLostFocus, false);
  h.ticks(1); eq(h.swings, 1); eq(h.opts.keyLeft.down, true); eq(h.player.yaw, 2.5);
  h.ticks(4); eq(h.opts.keyLeft.down, false);
  h.ticks(1); eq(h.opts.keyJump.down, true);
  h.ticks(1); eq(h.opts.keyJump.down, false);
  h.ticks(3); eq(h.player.yaw, 20);
  h.ticks(1); eq(h.opts.keyShift.down, true);
  h.ticks(6); eq(h.opts.keyShift.down, false);
  h.ticks(63); eq(h.swings, 1, "no early second attack");
  h.ticks(1); eq(h.swings, 2); eq(h.opts.keyRight.down, true);
  h.ticks(19); eq(h.player.yaw, 0, "alternating yaw does not spin forever");
  h.ctrl.stop(); eq(h.opts.pauseOnLostFocus, true);
});

test("performs one entity attack or block tap, then aborts block cracking on the next tick", function () {
  var h = harness(); h.hit("entity"); h.ticks(80);
  eq(h.hits, 1); eq(h.swings, 1); eq(h.starts, 0); eq(h.opts.keyAttack.down, false);
  h.ctrl.stop(); h.ctrl.start(); h.hit("block"); h.ticks(80);
  eq(h.starts, 1); eq(h.stops, 0);
  h.ticks(1); eq(h.stops, 1); h.ticks(20); eq(h.starts, 1);
});

test("every action can be disabled independently", function () {
  ["rotate", "move", "jump", "crouch", "attack"].forEach(function (enabled) {
    var h = harness();
    ["rotate", "move", "jump", "crouch", "attack"].forEach(k => h.settings[k] = k === enabled);
    var seen = {};
    for (var i = 0; i < 100; i++) {
      h.ticks(1);
      ["Left", "Right", "Jump", "Shift"].forEach(k => { if (h.opts["key" + k].down) seen[k] = true; });
    }
    eq(h.player.yaw !== 0, enabled === "rotate");
    eq(!!seen.Left, enabled === "move"); eq(!!seen.Jump, enabled === "jump");
    eq(!!seen.Shift, enabled === "crouch"); eq(h.swings > 0, enabled === "attack");
  });
});

test("screens release inputs and restore focus settings, then wait a full interval after closing", function () {
  var h = harness(); h.ticks(80); h.gui = true; h.ticks(1);
  eq(h.opts.keyLeft.down, false); eq(h.opts.pauseOnLostFocus, true);
  h.ticks(100); eq(h.swings, 1);
  h.gui = false; h.ticks(79); eq(h.swings, 1); h.ticks(1); eq(h.swings, 2);
});

test("manual movement and attack pause automation without releasing the user's binding", function () {
  var h = harness(); h.ticks(80); h.opts.keyUp.down = true; h.ticks(1);
  eq(h.opts.keyLeft.down, false); eq(h.opts.keyUp.down, true); eq(h.opts.pauseOnLostFocus, true);
  h.ticks(100); eq(h.swings, 1);
  h.opts.keyUp.down = false; h.opts.keyAttack.down = true; h.ticks(100);
  eq(h.opts.keyAttack.down, true); eq(h.swings, 1);
  h.opts.keyAttack.down = false; h.ticks(80); eq(h.swings, 2);
});

test("toggle crouch releases on time and when stopped in the middle of a crouch", function () {
  var h = harness(); h.opts.keyShift.toggle = true; h.ticks(90);
  eq(h.opts.keyShift.down, true); h.ticks(6); eq(h.opts.keyShift.down, false);
  h.ticks(74); eq(h.opts.keyShift.down, true); h.ctrl.stop(); eq(h.opts.keyShift.down, false);
});

test("unload and session replacement clean up the original bindings even with no player", function () {
  var h = harness(); h.hit("block"); h.ticks(80);
  h.game.player = null; h.game.level = null; h.loaded = false; h.ctrl.stop(); h.ctrl.stop(); h.ticks(1);
  eq(h.opts.keyLeft.down, false); eq(h.stops, 1); eq(h.opts.pauseOnLostFocus, true);
  h = harness(); h.ticks(80); h.game.level = {}; h.ticks(1);
  eq(h.opts.keyLeft.down, false); eq(h.opts.pauseOnLostFocus, true);
  h.ticks(79); eq(h.swings, 1); h.ticks(1); eq(h.swings, 2);
});

test("death, sleeping, riding, spectator mode and item use suspend every action", function () {
  ["alive", "sleeping", "riding", "spectator", "using"].forEach(function (flag) {
    var h = harness(); h.ticks(80); h[flag] = flag !== "alive"; h.ticks(100);
    eq(h.swings, 1, flag); eq(h.opts.keyLeft.down, false); eq(h.opts.pauseOnLostFocus, true);
  });
});

test("airborne pulses never press movement or jump and preserve a false focus preference", function () {
  var h = harness(); h.opts.pauseOnLostFocus = false; h.grounded = false;
  for (var i = 0; i < 100; i++) { h.ticks(1); eq(h.opts.keyLeft.down, false); eq(h.opts.keyJump.down, false); }
  h.ctrl.stop(); eq(h.opts.pauseOnLostFocus, false);
});

print(passed + " tests passed");
