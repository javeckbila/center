// Behavioral scenarios executed by CT's bundled Rhino, ES6 / optimization 9.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": got " + a + ", expected " + b); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }
var FARM = require("center/features/auto-farm/farmer");
var ROUTE = require("center/features/auto-farm/route");
var GEO = require("center/features/auto-farm/geometry");
var RENDER = require("center/features/auto-farm/render");
var MOCKF = require("center/tests/mock-farm-world");

function harness(points) {
  var w = MOCKF.createFarmWorld({});
  w.floor();
  var settings = { pitch: 20, sweepWidth: 45, sweepPeriod: 2.5, sprint: true };
  var saved = { context: "farm", points: points || [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 6.5 }] };
  var halts = [];
  var starts = 0;
  var currentContext = "farm";
  var nativeHits = [];
  w.game.gameMode.startDestroyBlock = function (pos) { nativeHits.push(pos); return true; };
  var farmer = FARM.createFarmer({
    T: w.T, game: () => w.game, route: () => saved, context: () => currentContext,
    now: () => w.clock, inGui: () => w.gui, setting: key => settings[key],
    onStart: () => starts++, onHalt: reason => halts.push(reason),
  });
  var h = {
    w, farmer, settings, halts, nativeHits, saved,
    context(value) { currentContext = value; },
    begin() { farmer.start(); farmer.tick(); return farmer.state().running; },
    cycle(walk) {
      for (var f = 0; f < 4; f++) { w.advance(); farmer.frame(); }
      farmer.tick();
      if (walk) w.walkFarm();
    },
    run(n, walk) { for (var t = 0; t < n && farmer.state().phase !== "off"; t++) h.cycle(walk); },
  };
  return h;
}

function released(h) {
  ["Up", "Down", "Left", "Right", "Jump", "Sprint", "Attack"].forEach(k => eq(h.w.game.options["key" + k].down, false, k + " released"));
}

test("route appends, removes last or numbered, renumbers and survives reload", function () {
  var saved = null;
  var route = ROUTE.createRoute(null, data => { saved = data; });
  eq(route.add({ x: 1, y: 64, z: 1 }, "farm"), null);
  eq(route.add({ x: 2, y: 64, z: 2 }, "farm"), null);
  eq(route.add({ x: 3, y: 64, z: 3 }, "farm"), null);
  eq(route.remove("2"), null);
  eq(saved.points.length, 2); eq(saved.points[1].x, 3);
  route = ROUTE.createRoute(JSON.parse(JSON.stringify(saved)), data => { saved = data; });
  eq(route.remove(), null); eq(saved.points.length, 1); eq(saved.points[0].x, 1);
  route.clear(); eq(saved.context, null); eq(saved.points.length, 0);
});

test("invalid route edits are rejected without changing saved data", function () {
  var writes = 0;
  var route = ROUTE.createRoute(null, () => writes++);
  route.add({ x: 1, y: 64, z: 1 }, "farm");
  ["0", "-1", "1.5", "1abc", "1e0", "2", ""].forEach(value => ok(route.remove(value)));
  ok(route.add({ x: 1, y: 64, z: 1 }, "farm"), "duplicate rejected");
  ok(route.add({ x: 5, y: 64, z: 5 }, "other"), "world mismatch rejected");
  ok(route.add({ x: NaN, y: 64, z: 5 }, "farm"), "NaN rejected");
  eq(writes, 1);
  var snapshot = route.snapshot(); snapshot.points[0].x = 999;
  eq(route.snapshot().points[0].x, 1, "snapshot is independent");
  eq(ROUTE.createRoute({ context: "farm", points: [{ x: null, y: 64, z: 1 }] }, () => {}).snapshot().points.length, 0);
});

test("route limit is bounded and corrupt saved routes are ignored", function () {
  var route = ROUTE.createRoute(null, () => {});
  for (var i = 0; i < ROUTE.MAX_POINTS; i++) eq(route.add({ x: i, y: 64, z: 0 }, "farm"), null);
  ok(route.add({ x: 999, y: 64, z: 0 }, "farm"));
  eq(route.snapshot().points.length, ROUTE.MAX_POINTS);
  eq(ROUTE.createRoute({ context: "farm", points: "bad" }, () => {}).snapshot().points.length, 0);
});

test("steering advances toward the goal at every yaw including wraparound", function () {
  for (var yaw = -360; yaw < 360; yaw += 7) {
    var keys = GEO.steering(3, -4, yaw), direction = GEO.travel(keys, yaw);
    ok((direction.x * 3 + direction.z * -4) / 5 > 0.92, "within 22.5 degrees of goal at " + yaw);
  }
  eq(Math.round(GEO.approach(179, -179, 1)), 180, "short yaw arc");
});

test("start waits for chat, selects a hotbar hoe, and restores the old slot on stop", function () {
  var h = harness(); h.w.gui = true;
  ok(!h.begin()); eq(h.w.selectedSlot, 0);
  h.w.gui = false; h.farmer.tick(); ok(h.farmer.state().running); eq(h.w.selectedSlot, 4);
  h.cycle(); ok(h.w.game.options.keyAttack.down);
  h.farmer.stop(); released(h); eq(h.w.selectedSlot, 0);
  eq(h.farmer.stop(), false, "idempotent stop");
});

test("missing route, wrong world, no hoe and nearly broken hoes refuse safely", function () {
  var h = harness([]); ok(!h.begin()); ok(h.halts[0].indexOf("two waypoints") >= 0); released(h);
  h = harness(); h.context("other"); ok(!h.begin()); released(h);
  h = harness(); h.w.hotbar[4] = h.w.hoe(1); ok(!h.begin()); eq(h.w.selectedSlot, 0); released(h);
  h = harness(); h.w.game.options.keyUp.down = true; ok(!h.begin());
  eq(h.w.game.options.keyUp.down, true, "refusal leaves manual input untouched");
});

test("farming visits every waypoint, closes the loop and keeps the camera sweeping", function () {
  var h = harness([{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 5.5 }, { x: 5.5, y: 64, z: 5.5 }]);
  ok(h.begin());
  var seen = {}, yaws = [];
  for (var i = 0; i < 260 && h.farmer.state().phase !== "off"; i++) {
    h.cycle(true); seen[h.farmer.state().target] = true; yaws.push(h.w.player.yaw);
  }
  ok(h.farmer.state().running, h.halts.join(", "));
  ok(seen[0] && seen[1] && seen[2], "all waypoints visited");
  ok(h.farmer.state().laps >= 2, "multiple loops completed");
  ok(Math.abs(h.w.player.pitch - 20) < 0.01, "default downward pitch");
  ok(Math.max.apply(null, yaws) - Math.min.apply(null, yaws) > 90, "camera turns along route");
  h.farmer.stop(); released(h);
});

test("pitch setting changes smoothly and the sweep reaches both sides on a straight leg", function () {
  var h = harness([{ x: 0.5, y: 64, z: 10.5 }, { x: 1.5, y: 64, z: 10.5 }]);
  h.settings.pitch = 35; ok(h.begin());
  var min = Infinity, max = -Infinity, previousYaw = h.w.player.yaw;
  for (var i = 0; i < 65; i++) {
    h.cycle(); min = Math.min(min, h.w.player.yaw); max = Math.max(max, h.w.player.yaw);
    ok(Math.abs(GEO.wrap(h.w.player.yaw - previousYaw)) <= 9.01, "bounded camera speed");
    previousYaw = h.w.player.yaw;
  }
  ok(min < -30 && max > 30, "sweeps left and right: " + min + ", " + max);
  ok(Math.abs(h.w.player.pitch - 35) < 0.01);
});

test("jump is requested before colliding with a one-block obstacle", function () {
  var h = harness();
  h.w.blocks.set("0,64,2", h.w.stone);
  ok(h.begin());
  var jumped = false;
  for (var i = 0; i < 25 && !jumped && h.farmer.state().running; i++) {
    h.cycle(false);
    if (h.w.game.options.keyJump.down) {
      jumped = true;
      ok(h.w.player.getBoundingBox().maxZ < 2, "jump precedes contact");
    }
    h.w.walkFarm();
  }
  ok(jumped, h.halts.join(", "));
  h.run(100, true);
  ok(h.farmer.state().running, "continues after landing: " + h.halts.join(", "));
  ok(h.farmer.state().laps >= 1, "passes obstacle and completes the route");
});

test("a tall wall or low ceiling is stopped before movement or attack continues", function () {
  ["wall", "ceiling"].forEach(kind => {
    var h = harness([{ x: 0.5, y: 64, z: 6.5 }, { x: 0.5, y: 64, z: 0.5 }]); h.w.player.z = 1.3;
    h.w.blocks.set("0,64,2", h.w.stone);
    h.w.blocks.set(kind === "wall" ? "0,65,2" : "0,66,1", h.w.stone);
    ok(h.begin()); h.cycle();
    eq(h.farmer.state().phase, "off"); ok(h.halts[0].indexOf("ceiling") >= 0); released(h);
  });
});

test("an edge or unloaded chunk stops instead of walking into it", function () {
  var h = harness();
  for (var x = -8; x <= 8; x++) for (var z = 1; z <= 14; z++) h.w.blocks.delete(x + ",63," + z);
  h.w.player.z = 0.85; ok(h.begin()); h.run(3, true);
  eq(h.farmer.state().phase, "off"); released(h);
  h = harness(); ok(h.begin()); h.w.loadedChunks = false; h.cycle();
  eq(h.farmer.state().phase, "off"); released(h);
});

test("blocked progress, teleport, water, death and context changes release inputs", function () {
  var h = harness(); ok(h.begin()); h.run(95, false);
  ok(h.halts[0].indexOf("Cannot reach") >= 0); released(h);
  ["teleport", "water", "death", "dimension", "player"].forEach(kind => {
    h = harness(); ok(h.begin()); h.cycle();
    if (kind === "teleport") h.w.player.x += 10;
    if (kind === "water") h.w.water = true;
    if (kind === "death") h.w.player.isAlive = () => false;
    if (kind === "dimension") h.context("other");
    if (kind === "player") h.w.game.player = null;
    h.cycle(); eq(h.farmer.state().phase, "off", kind); released(h);
  });
});

test("screen opening halts immediately and arming does not take input", function () {
  var h = harness(); ok(h.begin()); h.cycle();
  h.farmer.onScreenOpened(); eq(h.farmer.state().phase, "off"); released(h);
  h = harness(); h.w.gui = true; h.begin(); h.farmer.onScreenOpened();
  eq(h.farmer.state().phase, "arming"); released(h);
});

test("a worn hoe swaps to a spare, exhaustion stops, and native block attack starts", function () {
  var h = harness(); ok(h.begin()); h.cycle();
  h.w.hotbar[4] = h.w.hoe(1); h.w.hotbar[7] = h.w.hoe(100); h.cycle(); eq(h.w.selectedSlot, 7);
  h.w.game.hitResult = {
    getType: () => h.w.T.HitType.BLOCK, getBlockPos: () => new h.w.T.BlockPos(1, 64, 1), getDirection: () => "UP",
  };
  h.cycle(); eq(h.nativeHits.length, 1, "native startup attack");
  h.w.hotbar[7] = h.w.hoe(1); h.cycle(); eq(h.farmer.state().phase, "off"); released(h);
});

test("toggle sprint input is stable and releases in toggle mode", function () {
  var h = harness();
  var sprint = h.w.game.options.keySprint;
  sprint.setDown = function (down) { if (down) this.down = !this.down; };
  ok(h.begin()); h.run(15, true); ok(sprint.down, "no repeated toggling");
  h.farmer.stop(); released(h);
});

test("markers are numbered, filled, through walls and close their collection on errors", function () {
  var h = harness();
  RENDER.renderRoute(h.w.T, h.w.game, h.saved, 1, 0xFF4C8DFF);
  eq(h.w.collections, 0); eq(h.w.gizmos.length, 4);
  ok(h.w.gizmos.every(g => g.top), "through-wall boxes and labels");
  eq(h.w.gizmos[1].args[0], "1"); eq(h.w.gizmos[3].args[0], "2");
  ok(h.w.gizmos[0].args[1].fill >>> 24 > 0, "translucent fill");
  eq(h.w.gizmos[2].args[1].stroke, 0xFFFFCF67 | 0, "target highlighted");
  h.w.throwGizmo = true;
  try { RENDER.renderRoute(h.w.T, h.w.game, h.saved, -1, 0xFF4C8DFF); } catch (error) {}
  eq(h.w.collections, 0, "collector closed after exception");
});

print(passed + " tests passed");
