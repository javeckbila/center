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
var FARM_WORLD = require("center/features/auto-farm/world");
var PROFILES = require("center/features/auto-farm/profiles");
var GENERATOR = require("center/features/auto-farm/generator");

function harness(points) {
  var w = MOCKF.createFarmWorld({});
  w.floor();
  var settings = { pitch: 20, sweepWidth: 45, sweepTime: 0.5, sprint: true };
  var saved = { context: "farm", points: points || [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 6.5 }] };
  var halts = [];
  var starts = 0;
  var currentContext = "farm";
  var nativeHits = [];
  w.game.gameMode.startDestroyBlock = function (pos) { nativeHits.push(pos); return true; };
  var farmer = FARM.createFarmer({
    view: require("center/core/perspective").createPerspective({
      game: () => w.game, inGui: () => w.gui, thirdPerson: "back",
    }),
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

function lowerPlot(h, edge) {
  for (var x = -8; x <= 8; x++) for (var z = edge; z <= 14; z++) {
    h.w.blocks.delete(x + ",63," + z);
    h.w.blocks.set(x + ",62," + z, h.w.stone);
    h.w.crops.set(x + ",63," + z, true);
  }
}

test("saved configs survive reload and snapshots do not change with the working route", function () {
  var disk = null;
  var profiles = PROFILES.createProfiles(null, saved => { disk = JSON.parse(JSON.stringify(saved)); });
  var route = { context: "farm", points: [{ x: 1, y: 64, z: 1 }, { x: 5, y: 63, z: 5 }] };
  var values = { pitch: 25, sweepTime: 0.5, sprint: false };
  eq(profiles.save("Wheat", route, values), null);
  route.points[0].x = 99; values.pitch = 90;
  profiles = PROFILES.createProfiles(disk, saved => { disk = saved; });
  var loaded = profiles.load("WHEAT");
  eq(loaded.route.points[0].x, 1); eq(loaded.values.pitch, 25);
  loaded.route.points[0].x = 33; eq(profiles.load("wheat").route.points[0].x, 1);
  var working = ROUTE.createRoute(null, () => {});
  eq(working.replace(profiles.load("wheat").route), null); eq(working.snapshot().points[1].y, 63);
  eq(working.replace({ context: "farm", points: [{ x: NaN }] }) !== null, true);
  eq(working.snapshot().points.length, 2, "invalid load leaves working route intact");
  eq(profiles.remove("wheat"), null); eq(profiles.names().length, 0);
});

test("config names, limits and corrupted saves are handled without affecting existing saves", function () {
  var profiles = PROFILES.createProfiles([{ name: "broken", route: {}, values: {} }], () => {});
  var route = { context: null, points: [] };
  [undefined, "", "has spaces", "../route"].forEach(name => ok(profiles.save(name, route, {})));
  for (var i = 0; i < 32; i++) eq(profiles.save("farm_" + i, route, { pitch: i }), null);
  ok(profiles.save("extra", route, {}));
  eq(profiles.save("FARM_0", route, { pitch: 45 }), null, "existing names can be overwritten");
  eq(profiles.load("farm_0").values.pitch, 45); eq(profiles.names().length, 32);
  eq(profiles.load("missing"), null); ok(profiles.remove("missing"));
});

test("lower-layer aiming detects the floor beneath crop outlines within reach", function () {
  var h = harness(); lowerPlot(h, 2);
  var world = FARM_WORLD.createWorld(h.w.T);
  var pitch = world.lowerLayerPitch(h.w.game, 0, 20);
  ok(pitch > 30 && pitch < 45, "aim lowered toward the next layer: " + pitch);
  h.w.player.pitch = 20; h.w.updateHit();
  ok(h.w.game.hitResult.getType() !== h.w.T.HitType.BLOCK, "normal pitch passes over lower crops");
  h.w.player.pitch = pitch; h.w.updateHit();
  eq(h.w.game.hitResult.getType(), h.w.T.HitType.BLOCK);
  eq(h.w.game.hitResult.getBlockPos().getY(), 63, "aim hits the crop rather than air or soil");
  eq(world.lowerLayerPitch(h.w.game, 0, 60), 60, "keeps a steeper configured pitch");
});

test("flat terrain, small surface offsets, voids and unloaded terrain keep normal pitch", function () {
  var h = harness(); var world = FARM_WORLD.createWorld(h.w.T);
  eq(world.lowerLayerPitch(h.w.game, 0, 20), 20);
  h.w.player.y = 64.0625;
  eq(world.lowerLayerPitch(h.w.game, 0, 20), 20, "small floor offsets ignored");
  h.w.player.y = 64; lowerPlot(h, 2); h.w.loadedChunks = false;
  eq(world.lowerLayerPitch(h.w.game, 0, 20), 20);
  h.w.loadedChunks = true;
  for (var x = -8; x <= 8; x++) for (var z = 2; z <= 14; z++) h.w.blocks.delete(x + ",62," + z);
  eq(world.lowerLayerPitch(h.w.game, 0, 20), 20, "void does not invent a target floor");
});

test("pitch lowers before stepping off a layer and eases back after landing", function () {
  var h = harness([{ x: 0.5, y: 63, z: 6.5 }, { x: 0.5, y: 64, z: 0.5 }]);
  lowerPlot(h, 2); h.settings.sweepWidth = 10; h.w.player.pitch = 20;
  ok(h.begin());
  var aimedBeforeDrop = false, landed = false, previousPitch = h.w.player.pitch;
  for (var i = 0; i < 35 && h.farmer.state().running; i++) {
    h.cycle(true);
    ok(Math.abs(h.w.player.pitch - previousPitch) <= 4.51, "pitch transition stays smooth");
    previousPitch = h.w.player.pitch;
    if (h.w.player.y > 63.99 && h.w.player.pitch > 30) aimedBeforeDrop = true;
    if (h.w.player.y < 63.02 && h.w.grounded) { landed = true; break; }
  }
  ok(h.farmer.state().running, h.halts.join(", "));
  ok(aimedBeforeDrop, "look lowered before the descent"); ok(landed, "landed on the lower layer");
  h.run(20, false);
  ok(Math.abs(h.w.player.pitch - 20) < 0.01, "returns to normal pitch after landing");
});

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

test("steering uses vanilla left/right keys at each cardinal yaw", function () {
  // Independent expected keys, rather than comparing two copies of the same
  // transform. Vanilla positive local X comes from keyLeft, not keyRight.
  eq(GEO.steering(1, 0, 0).join(","), "keyLeft", "east while facing south");
  eq(GEO.steering(-1, 0, 0).join(","), "keyRight", "west while facing south");
  eq(GEO.steering(0, 1, 90).join(","), "keyLeft", "south while facing west");
  eq(GEO.steering(1, 0, 180).join(","), "keyRight", "east while facing north");
  eq(GEO.steering(0, 1, -90).join(","), "keyRight", "south while facing east");
  var w = MOCKF.createFarmWorld({}); w.floor();
  w.game.options.keyRight.down = true;
  w.walkFarm();
  ok(w.player.x < 0.5, "right actually moves west at yaw 0");
});

test("start waits for chat, selects a hotbar hoe, and restores the old slot on stop", function () {
  var h = harness(); h.w.gui = true;
  ok(!h.begin()); eq(h.w.selectedSlot, 0);
  h.w.gui = false; h.farmer.tick(); ok(h.farmer.state().running); eq(h.w.selectedSlot, 4);
  h.cycle(); ok(h.w.game.options.keyAttack.down);
  h.farmer.stop(); released(h); eq(h.w.selectedSlot, 0);
  eq(h.farmer.stop(), false, "idempotent stop");
});

test("farming continues after alt-tab and restores an existing front view and focus preference", function () {
  var h = harness(); h.w.game.options.setCameraType("front");
  ok(h.begin()); eq(h.w.game.options.getCameraType(), "back");
  eq(h.w.game.options.pauseOnLostFocus, false);
  h.w.focused = false; h.run(80, true);
  ok(h.farmer.state().running); ok(h.w.player.z > 0.5, "keeps following the route in the background");
  h.farmer.stop(); released(h);
  eq(h.w.game.options.getCameraType(), "front"); eq(h.w.game.options.pauseOnLostFocus, true);
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
    ok(Math.abs(GEO.wrap(h.w.player.yaw - previousYaw)) <= 15, "bounded camera speed");
    previousYaw = h.w.player.yaw;
  }
  ok(min < -30 && max > 30, "sweeps left and right: " + min + ", " + max);
  ok(Math.abs(h.w.player.pitch - 35) < 0.01);
});

test("default sweep reaches opposite sides half a second apart without amplitude clipping", function () {
  var h = harness([{ x: 0.5, y: 64, z: 10.5 }, { x: 0.5, y: 64, z: 0.5 }]);
  ok(h.begin());
  var samples = {};
  for (var i = 1; i <= 100; i++) {
    h.w.advance(); h.farmer.frame();
    if (i === 20 || i === 40 || i === 60 || i === 80 || i === 100) samples[i] = h.w.player.yaw;
  }
  ok(samples[20] > 40, "first right peak at 0.25s");
  ok(Math.abs(samples[40]) < 0.01, "center at 0.5s");
  ok(samples[60] < -44, "left peak at 0.75s, half a second later");
  ok(Math.abs(samples[80]) < 0.01, "center at 1s");
  ok(samples[100] > 44, "next right peak at 1.25s");
});

test("camera does not chase a reversing point bearing near the endpoint", function () {
  var h = harness([{ x: 0.5, y: 64, z: 6.5 }, { x: 0.5, y: 64, z: 0.5 }]);
  ok(h.begin());
  for (var i = 0; i < 120; i++) {
    // Cross back and forth within 5cm of the point without running arrival
    // ticks. The camera must retain the north/south leg's sweep center.
    h.w.player.x = 0.5 + Math.sin(i) * 0.05;
    h.w.player.z = 6.5 + Math.cos(i) * 0.05;
    h.w.advance(); h.farmer.frame();
    ok(Math.abs(h.w.player.yaw) <= 45.01, "stable leg heading near waypoint");
  }
});

test("arrival catches a waypoint crossed between ticks and brakes sprint on approach", function () {
  var h = harness([{ x: 0.5, y: 64, z: 3.5 }, { x: 0.5, y: 64, z: 8.5 }]);
  ok(h.begin());
  h.w.player.z = 2.7; h.w.sprinting = true; h.cycle();
  eq(h.w.sprinting, false, "vanilla sprint latch canceled near point");
  eq(h.w.game.options.keySprint.down, false);
  eq(h.farmer.state().target, 0);
  h.w.player.z = 4.3; h.cycle();
  eq(h.farmer.state().target, 1, "crossed waypoint recognized without circling back");
});

test("tight diagonal routes keep completing with momentum and different frame rates", function () {
  [30, 60, 144].forEach(fps => {
    var h = harness([
      { x: 0.27, y: 64, z: 0.83 },
      { x: -3.79, y: 64, z: 7.47 },
      { x: 3.53, y: 64, z: 4.19 },
      { x: 1.18, y: 64, z: -1.26 },
    ]);
    h.settings.sweepWidth = 80;
    h.settings.sweepTime = 0.25;
    ok(h.begin());
    var nextFrame = h.w.clock, nextTick = h.w.clock;
    for (var elapsed = 0; elapsed < 35 && h.farmer.state().running; elapsed += 1 / fps) {
      nextFrame += 1 / fps; h.w.clock = nextFrame; h.farmer.frame();
      while (nextTick + 0.05 <= nextFrame + 0.000001 && h.farmer.state().running) {
        nextTick += 0.05; h.farmer.tick(); h.w.walkFarm();
      }
    }
    ok(h.farmer.state().running, fps + " fps: " + h.halts.join(", "));
    ok(h.farmer.state().laps >= 3, "multiple loops at " + fps + " fps");
  });
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

test("a tall wall or low ceiling pauses input and only stops if it persists", function () {
  ["wall", "ceiling"].forEach(kind => {
    var h = harness([{ x: 0.5, y: 64, z: 6.5 }, { x: 0.5, y: 64, z: -6.5 }]); h.w.player.z = 1.3;
    h.w.blocks.set("0,64,2", h.w.stone);
    h.w.blocks.set(kind === "wall" ? "0,65,2" : "0,66,1", h.w.stone);
    ok(h.begin()); h.cycle();
    ok(h.farmer.state().running); eq(h.halts.length, 0); released(h);
    h.run(310, false);
    eq(h.farmer.state().phase, "off"); ok(h.halts[0].indexOf("ceiling") >= 0); released(h);
  });
});

test("an edge stops safely; unloaded chunks wait for loading without a deadline", function () {
  var h = harness();
  for (var x = -8; x <= 8; x++) for (var z = 1; z <= 14; z++) h.w.blocks.delete(x + ",63," + z);
  h.w.player.z = 0.85; ok(h.begin()); h.run(3, true);
  eq(h.farmer.state().phase, "off"); released(h);
  h = harness(); ok(h.begin()); h.w.loadedChunks = false; h.cycle();
  ok(h.farmer.state().running); eq(h.halts.length, 0); released(h);
  var yaw = h.w.player.yaw;
  h.run(100, false); released(h); eq(h.w.player.yaw, yaw, "no camera takeover while waiting");
  h.w.loadedChunks = true; h.cycle(true);
  ok(h.farmer.state().running); ok(h.w.game.options.keyAttack.down);
  h.w.loadedChunks = false; h.run(610, false);
  ok(h.farmer.state().running); eq(h.halts.length, 0); released(h);
  h.w.loadedChunks = true; h.cycle(); ok(h.w.game.options.keyAttack.down);
});

test("no movement on clear terrain retries instead of treating lag as an impossible route", function () {
  var h = harness(); ok(h.begin()); h.run(305, false);
  ok(h.farmer.state().running); eq(h.halts.length, 0); released(h);
  ok(h.farmer.state().status.indexOf("retrying") >= 0);
  h.run(1200, false); ok(h.farmer.state().running, "even a prolonged stall stays enabled");
  h.run(150, true); ok(h.farmer.state().running); ok(h.farmer.state().laps >= 1, "server recovery resumes the loop");
});

test("repeated large and small server rollbacks resume toward the waypoint", function () {
  var h = harness([{ x: 0.5, y: 64, z: 12.5 }, { x: 0.5, y: 64, z: 0.5 }]);
  ok(h.begin());
  for (var i = 0; i < 3; i++) {
    h.run(36, true);
    ok(h.w.player.z > 7.5, "moved far enough for a large rollback");
    h.w.player.x = 0.5; h.w.player.z = 0.5; h.w.motion = { x: 0, y: 0, z: 0 };
    h.cycle();
    ok(h.farmer.state().running, h.halts.join(", ")); eq(h.farmer.state().target, 0);
    eq(h.farmer.state().laps, 0, "rollback is not waypoint progress");
  }
  h.run(20, true);
  h.w.player.z -= 0.5; h.cycle();
  h.run(200, true);
  eq(h.halts.length, 0); ok(h.farmer.state().laps >= 1, "loop completes after lag clears");
});

test("a rollback across a corner rejoins the earlier leg without skipping a waypoint", function () {
  var h = harness([{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 8.5 }, { x: 6.5, y: 64, z: 8.5 }]);
  ok(h.begin());
  for (var i = 0; i < 100 && h.farmer.state().target !== 2; i++) h.cycle(true);
  eq(h.farmer.state().target, 2);
  h.w.player.x = 0.5; h.w.player.z = 1.5; h.w.motion = { x: 0, y: 0, z: 0 };
  h.cycle();
  eq(h.farmer.state().target, 1, "returns to the missed corner"); eq(h.farmer.state().laps, 0);
  h.run(240, true); ok(h.farmer.state().running, h.halts.join(", "));
  ok(h.farmer.state().laps >= 1);
});

test("rollbacks on the initial approach work even away from the saved loop", function () {
  var h = harness([{ x: 0.5, y: 64, z: 12.5 }, { x: 6.5, y: 64, z: 12.5 }]);
  ok(h.begin()); h.run(36, true);
  h.w.player.x = 0.5; h.w.player.z = 0.5; h.w.motion = { x: 0, y: 0, z: 0 };
  h.cycle(); ok(h.farmer.state().running, h.halts.join(", ")); eq(h.farmer.state().target, 0);
  h.run(240, true); ok(h.farmer.state().laps >= 1);
});

test("a position correction crossing the goal does not count as walking through it", function () {
  var h = harness([{ x: 0.5, y: 64, z: 3.5 }, { x: 0.5, y: 64, z: 12.5 }]);
  ok(h.begin()); h.cycle();
  h.w.player.z = 8.5; h.cycle();
  ok(h.farmer.state().running); eq(h.farmer.state().target, 0); eq(h.farmer.state().laps, 0);
});

test("temporary collision, water, item use, riding and pause release input then resume", function () {
  ["wall", "water", "item", "riding", "pause"].forEach(kind => {
    var h = harness([{ x: 0.5, y: 64, z: 6.5 }, { x: 0.5, y: 64, z: -6.5 }]);
    h.w.player.z = 1.3; ok(h.begin()); h.cycle();
    if (kind === "wall") { h.w.blocks.set("0,64,2", h.w.stone); h.w.blocks.set("0,65,2", h.w.stone); }
    if (kind === "water") h.w.water = true;
    if (kind === "item") h.w.player.isUsingItem = () => true;
    if (kind === "riding") h.w.player.isPassenger = () => true;
    if (kind === "pause") h.w.game.isPaused = () => true;
    h.cycle(); h.run(kind === "wall" ? 100 : 610, false); released(h); eq(h.w.selectedSlot, 4, "hoe stays selected while waiting");
    ok(h.farmer.state().running, kind); eq(h.halts.length, 0);
    h.w.blocks.delete("0,64,2"); h.w.blocks.delete("0,65,2"); h.w.water = false;
    h.w.player.isUsingItem = h.w.player.isPassenger = h.w.game.isPaused = () => false;
    h.run(150, true); ok(h.farmer.state().running, kind + ": " + h.halts.join(", "));
    ok(h.farmer.state().laps >= 1, kind + " resumes");
    h.farmer.stop(); released(h); eq(h.w.selectedSlot, 0);
  });
});

test("long client stalls do not consume recovery timeouts", function () {
  var h = harness(); ok(h.begin()); h.cycle();
  h.w.loadedChunks = false; h.cycle(); released(h);
  h.w.clock += 120; h.farmer.tick();
  ok(h.farmer.state().running); eq(h.halts.length, 0); released(h);
  h.w.loadedChunks = true; h.run(150, true); ok(h.farmer.state().laps >= 1);
});

test("starting in midair or with manual keys held waits without taking input", function () {
  var h = harness(); h.w.grounded = false; ok(!h.begin());
  eq(h.farmer.state().phase, "arming"); released(h);
  h.w.grounded = true; h.w.game.options.keyUp.down = true; h.farmer.tick();
  eq(h.farmer.state().phase, "arming"); eq(h.w.game.options.keyUp.down, true);
  h.w.game.options.keyUp.down = false; h.farmer.tick();
  ok(h.farmer.state().running); eq(h.halts.length, 0);
});

test("temporary loss of ground recovers; persistent loss, world changes and manual stop release waits", function () {
  var h = harness(); ok(h.begin()); h.cycle(); h.w.grounded = false;
  h.run(40, false); ok(h.farmer.state().running); released(h);
  h.w.grounded = true; h.run(150, true); ok(h.farmer.state().laps >= 1);
  h.w.grounded = false; h.run(340, false);
  eq(h.farmer.state().phase, "off"); released(h);
  ["world", "stop"].forEach(kind => {
    h = harness(); ok(h.begin()); h.w.loadedChunks = false; h.cycle(); released(h);
    if (kind === "world") { h.context("other"); h.cycle(); } else h.farmer.stop();
    eq(h.farmer.state().phase, "off"); released(h); eq(h.w.selectedSlot, 0);
  });
});

test("displacement away from the route, lava, death and context changes still release inputs", function () {
  ["teleport", "lava", "death", "dimension", "player"].forEach(kind => {
    var h;
    h = harness(); ok(h.begin()); h.cycle();
    if (kind === "teleport") h.w.player.x += 10;
    if (kind === "lava") h.w.lava = true;
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

function plant(w, x, cy, z, crop) {
  w.blocks.set(x + "," + (cy - 1) + "," + z, w.farmland);
  w.crops.set(x + "," + cy + "," + z, crop || w.wheat);
}
function generate(w) {
  var reader = FARM_WORLD.createWorld(w.T).survey(w.game);
  var job = GENERATOR.createGenerator(reader, "farm"), state;
  for (var i = 0; i < 100000; i++) {
    state = job.step(32);
    if (state.result || state.error) return state;
  }
  throw new Error("generation did not finish");
}
function checkLoop(w, result, expected) {
  ok(result.result, result.error);
  var saved = result.result, reader = FARM_WORLD.createWorld(w.T).survey(w.game), seen = new Set();
  saved.points.forEach((a, i) => {
    var b = saved.points[(i + 1) % saved.points.length];
    var dx = b.x - a.x, dz = b.z - a.z, distance = Math.abs(dx) + Math.abs(dz);
    ok(dx === 0 || dz === 0, "no diagonal corner cutting");
    ok(distance >= 1, "nonzero long legs including closure");
    var last = reader.tile(Math.floor(a.x), Math.floor(a.y + 0.1), Math.floor(a.z));
    ok(last, "starts on crop"); seen.add(last.x + "," + last.cy + "," + last.z);
    for (var n = 1; n <= distance; n++) {
      var next = null;
      for (var dy = -1; dy <= 1 && !next; dy++) {
        var candidate = reader.tile(Math.floor(a.x + dx / distance * n), last.cy + dy, Math.floor(a.z + dz / distance * n));
        if (candidate && reader.edge(last, candidate)) next = candidate;
      }
      ok(next, "every point between waypoints has the detected crop");
      ok(reader.edge(last, next), "full collision clearance, including the closing leg");
      seen.add(next.x + "," + next.cy + "," + next.z); last = next;
      for (var sx = -2; sx <= 2; sx++) for (var sz = -2; sz <= 2; sz++) {
        var room = false;
        for (var sy = -2; sy <= 2; sy++) if (reader.tile(next.x + sx, next.cy + sy, next.z + sz)) room = true;
        ok(room, "two crop rows of sweep clearance throughout every leg");
      }
    }
  });
  if (expected !== undefined) eq(result.count, expected, "scans the connected crop bed");
}

test("generator routes inside an irregular terraced bed and closes through crops around walls", function () {
  var w = MOCKF.createFarmWorld({});
  for (var x = 0; x < 20; x++) for (var z = 0; z < 30; z++) {
    if (x === 9 && z === 6) continue; // pillar with enough room to detour inside
    plant(w, x, z < 15 ? 64 : 65, z);
  }
  for (var y = 63; y <= 67; y++) w.blocks.set("9," + y + ",6", w.stone);
  plant(w, -1, 64, 0, w.carrots); // different crop must never enter the graph
  w.player.y = 63.9375;
  var result = generate(w);
  checkLoop(w, result, 599);
  eq(result.result.crop, "minecraft:wheat");
  ok(result.result.points.some(p => p.y === 64.9375), "upper terrace included");
});

test("generator rejects blocked headroom, deep drops and disconnected crops", function () {
  var w = MOCKF.createFarmWorld({}); w.player.y = 63.9375;
  for (var x = 0; x < 7; x++) for (var z = 0; z < 7; z++) plant(w, x, 64, z);
  plant(w, 0, 66, 7); // two-block jump
  plant(w, 10, 64, 0); // no crop connector
  var result = generate(w); checkLoop(w, result, 49);
  for (var x = 0; x < 7; x++) for (var z = 0; z < 7; z++) if (x || z) w.blocks.set(x + ",65," + z, w.stone);
  result = generate(w); ok(result.error && !result.result, "cannot walk through a low ceiling");
  w.crops.clear(); result = generate(w); ok(result.error && !result.result, "not standing on a crop");
});

test("large generation is incremental, bounded, and preserves generated routes in saved configs", function () {
  var w = MOCKF.createFarmWorld({}); w.player.y = 63.9375;
  for (var x = 0; x < 40; x++) for (var z = 0; z < 50; z++) plant(w, x, 64, z);
  var job = GENERATOR.createGenerator(FARM_WORLD.createWorld(w.T).survey(w.game), "farm");
  var first = job.step(16); eq(first.phase, "scan"); ok(first.count < 80, "bounded first tick");
  var state;
  for (var i = 0; i < 10000; i++) { state = job.step(64); if (state.result || state.error) break; }
  checkLoop(w, state, 2000);
  ok(state.result.points.length >= 10 && state.result.points.length <= 15, "large open plot uses about twelve waypoints: " + state.result.points.length);
  ok(state.result.points.some((p, i) => GEO.length(p.x - state.result.points[(i + 1) % state.result.points.length].x,
    p.z - state.result.points[(i + 1) % state.result.points.length].z) > 30), "keeps full-length farming passes");
  var disk, route = ROUTE.createRoute(null, value => { disk = value; });
  eq(route.replace(state.result), null); eq(disk.crop, "minecraft:wheat");
  route = ROUTE.createRoute(disk, () => {}); eq(route.snapshot().crop, disk.crop);
  ok(route.remove(), "manual edits cannot create unchecked shortcuts");
  var profiles = PROFILES.createProfiles(null, () => {});
  eq(profiles.save("large", route.snapshot(), {}), null); eq(profiles.load("large").route.crop, disk.crop);
  w.loadedChunks = false; ok(generate(w).error, "unloaded plots are not silently truncated");
});

test("start chooses the closest waypoint with height included and retains cyclic order", function () {
  var h = harness([{ x: 0.5, y: 70, z: 0.5 }, { x: 0.5, y: 64, z: 6.5 }, { x: 4.5, y: 64, z: 6.5 }]);
  h.w.player.z = 6; ok(h.begin()); eq(h.farmer.state().target, 1);
  h.cycle(); eq(h.farmer.state().target, 2); eq(h.farmer.state().laps, 0, "joining near the end is not a lap");
});

test("generated routes repeatedly farm interior lanes and one-block terraces without cutting corners", function () {
  var h = harness([]); h.w.blocks.clear(); h.w.player.y = 63.9375;
  for (var x = 0; x < 8; x++) for (var z = 0; z < 12; z++) plant(h.w, x, z < 6 ? 64 : 65, z);
  h.w.player.x = 2.5; h.w.player.z = 2.5;
  var result = generate(h.w); checkLoop(h.w, result, 96);
  Object.assign(h.saved, result.result);
  h.begin();
  var jumped = false;
  for (var i = 0; i < 3000 && h.farmer.state().phase !== "off" && h.farmer.state().laps < 2; i++) {
    h.cycle(true); jumped = jumped || h.w.game.options.keyJump.down;
    var p = h.w.player;
    ok(p.x >= 2.15 && p.x <= 5.85 && p.z >= 2.15 && p.z <= 9.85, "player retains sweep margin at " + p.x + "," + p.z);
  }
  ok(h.farmer.state().running, h.halts.join(", "));
  ok(jumped, "anticipates terrace jumps");
  ok(h.farmer.state().laps >= 2, "closes the loop repeatedly: " + h.farmer.state().status);
  h.farmer.stop(); released(h);
});

test("crop-only startup detours to the closest waypoint rather than walking through a divider", function () {
  var h = harness([]); h.w.blocks.clear(); h.w.player.y = 63.9375;
  for (var z = 0; z < 7; z++) { plant(h.w, 0, 64, z); plant(h.w, 2, 64, z); }
  plant(h.w, 1, 64, 6);
  for (var z = 0; z < 6; z++) for (var y = 63; y <= 66; y++) h.w.blocks.set("1," + y + "," + z, h.w.stone);
  h.saved.crop = "minecraft:wheat";
  h.saved.points = [{ x: 2.5, y: 63.9375, z: 0.5 }, { x: 2.5, y: 63.9375, z: 6.5 }];
  h.begin();
  for (var i = 0; i < 150 && !h.farmer.state().running; i++) h.cycle();
  ok(h.farmer.state().running, h.halts.join(", ")); eq(h.farmer.state().target, 0);
  h.run(15, true);
  ok(h.w.player.z > 1.5 && h.w.player.x < 1, "approach follows crops toward the far-end crossing");
});

test("generated farming attacks crops and releases attack on walls even between ticks", function () {
  var h = harness([]); h.w.blocks.clear(); h.w.player.y = 63.9375;
  for (var x = 0; x < 7; x++) for (var z = 0; z < 12; z++) plant(h.w, x, 64, z);
  Object.assign(h.saved, generate(h.w).result); h.begin(); h.cycle();
  h.w.game.hitResult = {
    getType: () => h.w.T.HitType.BLOCK, getBlockPos: () => new h.w.T.BlockPos(0, 64, 1), getDirection: () => "UP",
  };
  h.cycle(); ok(h.w.game.options.keyAttack.down); eq(h.nativeHits.length, 1);
  h.w.crops.delete("0,64,1"); h.w.blocks.set("0,64,1", h.w.stone);
  h.w.advance(); h.farmer.frame(); eq(h.w.game.options.keyAttack.down, false, "wall is never attacked");
  h.farmer.stop(); released(h);
});

print(passed + " tests passed");
