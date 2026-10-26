// Auto miner core tests under CT's bundled Rhino (run by center\tests\run.ps1).
// Each scenario drives a fresh miner instance against the mock world.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": got " + a + ", expected " + b); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

var GEO = require("center/features/auto-miner/geometry");
var NAVI = require("center/features/auto-miner/navigation");
var MINER = require("center/features/auto-miner/miner");
var MOCK = require("center/tests/mock-world");

// Deterministic uniform [0, 1) source (LCG) so random target picks are reproducible.
// Plain modular arithmetic: CT's Rhino (opt 9) returns signed results from `>>> 0`.
function seeded(seed) {
  var s = seed % 4294967296;
  return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

// Whole floor layer of the area (x/z -1..2 around a player at 0.5, 0.5) as cobblestone.
function fillTopLayer(h) {
  for (var x = -1; x <= 2; x++) for (var z = -1; z <= 2; z++) h.w.blocks.set(x + ",63," + z, h.w.cobble);
}
function distinct(list) { return new Set(list).size; }

function harness(options) {
  options = options || {};
  var w = MOCK.createMockWorld(options);
  var halts = [];
  var starts = 0;
  var miner = MINER.createMiner({
    T: w.T,
    game: function () { return w.game; },
    now: function () { return w.clock; },
    inGui: function () { return w.gui; },
    glide: function () { return 1; },
    randomness: function () { return options.randomness || 0; },
    random: seeded(options.seed || 1),
    onStart: function () { starts++; },
    onHalt: function (reason, opts) { halts.push({ reason: reason, refused: !!opts.refused }); },
  });
  w.packetSink = function (packet, event) { miner.onPacketSent(packet, event); };
  var h = {
    w: w, game: w.game, miner: miner, halts: halts, opts: w.game.options,
    starts: function () { return starts; },
    s: function () { return miner.state(); },
    // Arms the miner and runs the arming ticks; returns whether mining started.
    begin: function () {
      miner.start();
      for (var i = 0; i < MINER.ARM_TICKS && miner.state().phase === "arming"; i++) miner.tick();
      return miner.state().running;
    },
    step: function () { w.advance(); miner.frame(); },
    cycle: function () {
      for (var f = 0; f < 4; f++) h.step();
      w.updateHit();
      miner.tick();
      w.checkAttack();
      if (options.simulateMining) w.vanillaMining();
      if (options.simulateWalking) w.vanillaWalking();
    },
    run: function (n, until) { for (var i = 0; i < n && !(until && until()); i++) h.cycle(); },
    floor: function (x0, x1, z0, z1) {
      for (var x = x0; x <= x1; x++) for (var z = z0; z <= z1; z++) w.blocks.set(x + ",63," + z, w.stone);
    },
  };
  return h;
}

// ---------- pure helpers ----------

test("mining area covers four layers around positive and negative positions", function () {
  [[0.5, 64, 0.5], [-15.8, -12, -21.3]].forEach(function (c) {
    var region = GEO.cube(c[0], c[1], c[2]);
    eq(region.blocks.length, 64);
    eq(new Set(region.blocks.map(function (p) { return p.x + "," + p.y + "," + p.z; })).size, 64);
    var floorY = Math.floor(c[1] - 0.01);
    eq(region.supportY, floorY);
    eq(region.topY, floorY + 3);
    eq(new Set(region.blocks.map(function (p) { return p.x; })).size, 4);
    eq(new Set(region.blocks.map(function (p) { return p.z; })).size, 4);
    for (var y = floorY; y <= floorY + 3; y++) {
      eq(region.blocks.filter(function (p) { return p.y === y; }).length, 16, "full layer at " + y);
    }
  });
});

test("all footprint support blocks are preserved, neighbours are eligible", function () {
  var box = { minX: 0.7, maxX: 1.3, minZ: 0.7, maxZ: 1.3 };
  [0, 1].forEach(function (x) { [0, 1].forEach(function (z) { ok(GEO.supportsFeet({ x: x, y: 63, z: z }, 63, box)); }); });
  eq(GEO.supportsFeet({ x: 2, y: 63, z: 0 }, 63, box), false);
});

test("tool timing handles instant, slow, unbreakable and missing progress", function () {
  eq(GEO.miningTicks(0.2), 5);
  eq(GEO.miningTicks(2), 1);
  eq(GEO.miningTicks(0), Infinity);
  eq(GEO.miningTicks(undefined), Infinity, "undefined progress (Rhino undefined > 0 quirk)");
});

test("pre-glide lead scales with ping and only starts near the final ticks", function () {
  eq(GEO.leadTicks(0), 1);
  eq(GEO.leadTicks(120), 3);
  eq(GEO.leadTicks(1000), 6);
  eq(GEO.glideWeight(0, 0.2, 120), 0);
  eq(GEO.glideWeight(6, 0.2, 0), 0);
  ok(GEO.glideWeight(6, 0.2, 120) > 0);
  eq(GEO.glideWeight(8, 0.2, 0), 1);
  eq(GEO.glideWeight(8, undefined, 0), 0);
});

test("spring follows the shortest yaw arc and keeps velocity across a retarget", function () {
  var axis = { value: 179, velocity: 20 };
  GEO.spring(axis, axis.value + GEO.wrap(-179 - axis.value), 1 / 120, 12, 155, 700);
  ok(axis.value > 179);
  var before = axis.velocity;
  GEO.spring(axis, 140, 1 / 240, 12, 155, 700);
  ok(Math.abs(axis.velocity - before) <= 700 / 240 + 1e-8);
});

test("return navigation detours around a blocked tile and rejects a blocked goal", function () {
  var clear = function (from, to) { return !(Math.floor(to.x) === 1 && Math.floor(to.z) === 0); };
  var route = NAVI.findRoute({ x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 }, clear);
  ok(route && route.some(function (p) { return Math.floor(p.z) !== 0; }));
  eq(NAVI.findRoute({ x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 }, function () { return false; }), null);
  eq(NAVI.steering(0, 1, 0).join(), "keyUp");
  eq(NAVI.steering(1, 0, 0).join(), "keyRight");
});

// ---------- lifecycle ----------

test("start arms, waits for open screens, then begins; stop is idempotent", function () {
  var h = harness();
  h.w.gui = true;
  ok(h.miner.start(), "armed");
  ok(!h.miner.start(), "second start ignored");
  for (var i = 0; i < 5; i++) h.miner.tick();
  eq(h.s().phase, "arming", "waits while a screen is open");
  eq(h.s().status, "Starts when this screen closes");
  eq(h.opts.pauseOnLostFocus, true, "nothing changed while arming");
  h.w.gui = false;
  h.miner.tick();
  eq(h.s().phase, "arming", "needs consecutive screen-free ticks");
  h.miner.tick();
  ok(h.s().running, "running");
  eq(h.starts(), 1);
  eq(h.opts.pauseOnLostFocus, false, "pause-on-focus-loss disabled while running");
  ok(h.miner.stop("Off"));
  ok(!h.miner.stop("Off"), "second stop is a no-op");
  eq(h.opts.pauseOnLostFocus, true, "restored");
  eq(h.halts.length, 0, "user stops do not report a halt");
});

test("start refuses without a pickaxe, with movement held, or with attack held", function () {
  [["pickaxe", "Hold a pickaxe"], ["move", "Stand still"], ["attack", "Release your attack key"]].forEach(function (c) {
    var h = harness();
    if (c[0] === "pickaxe") h.w.hasPickaxe = false;
    if (c[0] === "move") h.opts.keyUp.down = true;
    if (c[0] === "attack") h.opts.keyAttack.down = true;
    ok(!h.begin(), c[0] + ": not started");
    eq(h.s().phase, "off");
    eq(h.halts.length, 1);
    ok(h.halts[0].refused && h.halts[0].reason.indexOf(c[1]) === 0, c[0] + ": " + h.halts[0].reason);
    eq(h.opts.pauseOnLostFocus, true, "settings untouched");
  });
});

test("idle glide stays finite and keeps moving without targets", function () {
  var h = harness();
  ok(h.begin());
  h.run(60);
  var previous = h.w.player.yaw;
  h.run(10);
  ok(h.w.player.yaw !== previous, "camera drifts");
  eq(h.opts.keyAttack.down, false);
  eq(h.s().status, "Waiting for reachable blocks");
});

// ---------- starting a break ----------

test("native startup mines when vanilla ignores the held attack key", function () {
  var h = harness({ simulateMining: true, requirePress: true });
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  h.run(100, function () { return h.w.completed.length > 0; });
  eq(h.w.completed.length, 1);
  eq(h.w.nativeStarts.length, 1);
  eq(h.s().startResult, "accepted");
});

test("a rejected native start retries no faster than twice per second", function () {
  var h = harness({ simulateMining: true, requirePress: true, ignoreNativeStarts: 1 });
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  h.run(100, function () { return h.w.completed.length > 0; });
  eq(h.w.completed.length, 1);
  eq(h.w.nativeStarts.length, 2);
  ok(h.w.nativeStarts[1].time - h.w.nativeStarts[0].time >= 0.5);
});

test("a permanently rejected start is reported and stop leaves no input held", function () {
  var h = harness({ rejectNativeStarts: true });
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  h.run(30, function () { return h.opts.keyAttack.down; });
  eq(h.s().status, "Mining start rejected");
  eq(h.s().activity, "rejected");
  h.miner.stop("Off");
  eq(h.opts.keyAttack.down, false);
});

test("an uncaptured mouse is grabbed; diagnostics survive the stopping screen", function () {
  var h = harness({ simulateMining: true, requirePress: true, mouseGrabbed: false });
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  h.run(100, function () { return h.w.completed.length > 0; });
  eq(h.w.completed.length, 1);
  eq(h.w.grabs, 1);
  eq(h.w.aborts.length, 0);
  h.w.gui = true;
  h.miner.onScreenOpened();
  h.w.grabbed = false;
  eq(h.halts[0].reason, "Screen opened");
  ok(h.s().lastInput.indexOf("mouse grabbed=true") >= 0, h.s().lastInput);
});

test("background mining never grabs another application's mouse", function () {
  var h = harness({ simulateMining: true });
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  h.w.focused = false;
  h.run(100, function () { return h.w.completed.length > 0; });
  eq(h.w.completed.length, 1);
  eq(h.w.grabs, 0);
});

// ---------- targeting ----------

test("every supported material is mined at floor, feet, head and overhead height", function () {
  ["cobble", "iron", "deepslateIron", "diamond", "deepslateDiamond", "debris"].forEach(function (material) {
    [63, 64, 65, 66].forEach(function (y) {
      var h = harness({ simulateMining: true });
      var id = "0," + y + ",1";
      h.w.blocks.set("0,63,0", h.w[material]);
      h.w.blocks.set(id, h.w[material]);
      ok(h.begin());
      h.run(200, function () { return h.w.completed.length > 0; });
      eq(h.w.completed.length, 1, material + " at " + y);
      eq(h.w.completed[0].id, id);
      eq(h.w.blocks.get("0,63,0"), h.w[material], "support kept");
    });
  });
});

test("air, other materials and targets outside the cube are ignored", function () {
  var h = harness({ simulateMining: true });
  h.w.blocks.set("0,64,1", h.w.stone);
  h.w.blocks.set("0,67,1", h.w.diamond);
  h.w.blocks.set("0,62,1", h.w.iron);
  h.w.blocks.set("3,65,0", h.w.debris);
  ok(h.begin());
  h.run(100);
  eq(h.s().target, null);
  eq(h.w.completed.length, 0);
  eq(h.opts.keyAttack.down, false);
});

test("mines selected cobblestone, preserves support, and uses current tool timing", function () {
  var h = harness();
  h.w.blocks.set("0,63,0", h.w.cobble);
  h.w.blocks.set("0,63,1", h.w.cobble);
  h.w.blocks.set("1,63,0", h.w.stone);
  ok(h.begin());
  h.run(80);
  eq(h.opts.keyAttack.down, true);
  eq(h.s().expectedTicks, 5);
  h.w.progress = 0.5;
  h.cycle();
  eq(h.s().expectedTicks, 2);
  h.w.blocks.delete("0,63,1");
  h.cycle();
  eq(h.opts.keyAttack.down, false);
  ok(h.w.blocks.has("0,63,0"), "support block kept");
});

test("stop releases owned attack and aborts vanilla block destruction", function () {
  var h = harness();
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  h.run(40, function () { return h.opts.keyAttack.down; });
  eq(h.opts.keyAttack.down, true);
  h.miner.stop("Off");
  eq(h.opts.keyAttack.down, false);
  ok(h.game.stops > 0);
});

test("a replacement block is skipped on the next frame without a timeout", function () {
  var h = harness();
  h.w.blocks.set("0,63,1", h.w.cobble);
  h.w.blocks.set("1,63,1", h.w.cobble);
  ok(h.begin());
  h.run(30, function () { return h.opts.keyAttack.down; });
  var previous = h.s().target;
  h.w.blocks.set(previous, h.w.stone);
  h.step();
  ok(h.s().target && h.s().target !== previous, "retargeted");
});

test("a newly occluded target is replaced in the same tick", function () {
  var h = harness();
  h.w.blocks.set("0,63,0", h.w.stone);
  h.w.blocks.set("0,65,2", h.w.cobble);
  ok(h.begin());
  h.cycle();
  eq(h.s().target, "0,65,2");
  h.w.blocks.set("0,65,1", h.w.stone);
  h.w.blocks.set("1,65,1", h.w.cobble);
  h.miner.tick();
  eq(h.s().target, "1,65,1");
});

test("the completion packet hands off before the delayed replacement arrives", function () {
  var h = harness({ simulateMining: true, replacementDelay: 0.6 });
  h.w.blocks.set("0,63,1", h.w.cobble);
  h.w.blocks.set("1,63,1", h.w.cobble);
  ok(h.begin());
  h.run(120, function () { return h.w.completed.length > 0; });
  eq(h.w.completed.length, 1);
  var old = h.w.completed[0].id;
  eq(h.w.blocks.get(old), h.w.cobble, "server replacement still delayed");
  h.step();
  ok(h.s().target && h.s().target !== old, "handed off");
  eq(h.w.aborts.filter(function (id) { return id === old; }).length, 0, "completed break never aborted");
});

test("the camera leads toward the successor during the final ticks of a break", function () {
  var h = harness({ simulateMining: true, progress: 0.1, ping: 200 });
  h.w.blocks.set("0,63,1", h.w.cobble);
  h.w.blocks.set("1,63,1", h.w.cobble);
  ok(h.begin());
  var preGlided = false;
  h.run(120, function () {
    var s = h.s();
    if (s.target === "0,63,1" && s.started && s.weight > 0 && s.yaw < -2) preGlided = true;
    return h.w.completed.length > 0;
  });
  ok(preGlided, "camera turned toward the next block before the current one completed");
  eq(h.w.completed[0].id, "0,63,1");
  eq(h.w.aborts.filter(function (id) { return id === "0,63,1"; }).length, 0);
});

test("eight consecutive blocks are mined quickly with a single native start", function () {
  var h = harness({ simulateMining: true, requirePress: true });
  for (var x = -1; x <= 1; x++) for (var z = -1; z <= 1; z++) h.w.blocks.set(x + ",63," + z, h.w.cobble);
  ok(h.begin());
  h.run(500, function () { return h.w.completed.length >= 8; });
  eq(h.w.completed.length, 8);
  for (var i = 1; i < h.w.completed.length; i++) {
    var gap = h.w.completed[i].time - h.w.completed[i - 1].time;
    ok(gap < 2.5, "gap of " + gap.toFixed(2) + " s before block " + (i + 1));
  }
  eq(h.w.aborts.length, 0, "pre-glide never aborted an unfinished block");
  eq(h.w.nativeStarts.length, 1, "does not restart every block or bypass the inter-block cooldown");
  eq(h.w.blocks.get("0,63,0"), h.w.cobble, "support block kept");
  h.step(); // the last completion is counted on the frame after its STOP packet
  eq(h.s().cleared, 8);
});

// ---------- regenerating blocks / randomness ----------

function mineRegenerating(options, count) {
  var h = harness(Object.assign({ simulateMining: true, regenDelay: 3 }, options));
  fillTopLayer(h);
  ok(h.begin());
  h.run(3000, function () { return h.w.completed.length >= count; });
  eq(h.w.completed.length, count, "mined " + count + " blocks");
  return h.w.completed.map(function (c) { return c.id; });
}

test("regenerating cobblestone is spread over the area instead of looping the closest five", function () {
  // Five blocks in front, six behind. Regeneration takes about as long as mining
  // the front five, which made the old nearest-turn choice loop over them forever.
  var FRONT = ["-1,63,2", "0,63,2", "1,63,2", "0,63,1", "1,63,1"];
  var BEHIND = ["-1,63,-1", "0,63,-1", "1,63,-1", "2,63,-1", "-1,63,0", "2,63,0"];
  var h = harness({ simulateMining: true, progress: 0.5, regenDelay: 1.5, randomness: 0 });
  FRONT.concat(BEHIND).forEach(function (id) { h.w.blocks.set(id, h.w.cobble); });
  ok(h.begin());
  h.run(3000, function () { return h.w.completed.length >= 30; });
  var order = h.w.completed.map(function (c) { return c.id; });
  eq(distinct(order.slice(0, 11)), 11, "every block before any repeat: " + order.slice(0, 11).join(" "));
  ok(order.filter(function (id) { return BEHIND.indexOf(id) >= 0; }).length >= 12, "blocks behind are mined too");
});

test("a fully regenerating layer is covered without short repeats", function () {
  // 15 eligible blocks (16 minus the support block); each regenerates 3 s after it is mined.
  var order = mineRegenerating({ randomness: 0 }, 30);
  ok(distinct(order.slice(0, 15)) >= 13, "first 15 picks cover the area: " + order.slice(0, 15).join(" "));
  ok(distinct(order) >= 14, "30 picks reach almost every block: " + distinct(order));
  for (var i = 5; i < order.length; i++) {
    ok(order.slice(i - 5, i).indexOf(order[i]) < 0, "block " + order[i] + " repeated within 5 picks at " + i);
  }
  ok(order.indexOf("0,63,0") < 0, "support block never mined");
});

test("randomness varies the order between runs and still avoids recently mined blocks", function () {
  var a = mineRegenerating({ randomness: 1, seed: 7 }, 20);
  var b = mineRegenerating({ randomness: 1, seed: 99 }, 20);
  ok(a.join() !== b.join(), "different seeds give different orders");
  [a, b].forEach(function (order) {
    ok(distinct(order.slice(0, 15)) >= 12, "spread: " + order.slice(0, 15).join(" "));
    for (var i = 3; i < order.length; i++) ok(order.slice(i - 3, i).indexOf(order[i]) < 0, "no immediate repeats");
  });
  eq(mineRegenerating({ randomness: 0 }, 12).join(), mineRegenerating({ randomness: 0, seed: 5 }, 12).join(),
    "randomness 0 is deterministic");
});

test("the planned successor is kept while valid, so random picks do not flicker", function () {
  var h = harness({ simulateMining: true, regenDelay: 3, randomness: 1, seed: 3 });
  fillTopLayer(h);
  ok(h.begin());
  var seen = {};
  h.run(400, function () {
    var s = h.s();
    if (s.target && s.next) {
      seen[s.target] = seen[s.target] || {};
      seen[s.target][s.next] = true;
    }
    return h.w.completed.length >= 12;
  });
  Object.keys(seen).forEach(function (t) {
    ok(Object.keys(seen[t]).length === 1, "successor of " + t + " changed: " + Object.keys(seen[t]).join(" "));
  });
  eq(h.w.aborts.length, 0, "no aborted breaks");
});

// ---------- stopping ----------

test("manual movement stops immediately without moving the player", function () {
  var h = harness();
  ok(h.begin());
  h.opts.keyUp.down = true;
  h.cycle();
  ok(h.halts.length === 1 && h.halts[0].reason.indexOf("Manual input") === 0, "halted for manual input");
  eq(h.w.player.x, 0.5); eq(h.w.player.y, 64); eq(h.w.player.z, 0.5);
});

test("screens, tool removal and world unload all stop safely", function () {
  ["gui", "tool", "unload"].forEach(function (condition) {
    var h = harness();
    ok(h.begin());
    if (condition === "gui") { h.w.gui = true; h.miner.onScreenOpened(); }
    if (condition === "tool") h.w.hasPickaxe = false;
    if (condition === "unload") h.miner.stop("World unloaded");
    h.cycle();
    eq(h.opts.keyAttack.down, false, condition);
    eq(h.s().phase, "off", condition);
    var angle = h.w.player.yaw;
    h.cycle();
    eq(h.w.player.yaw, angle, condition + ": camera released");
  });
});

test("alt-tab keeps mining and restores pause-on-focus-loss when stopped", function () {
  var h = harness({ simulateMining: true });
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  eq(h.opts.pauseOnLostFocus, false);
  h.w.focused = false;
  h.run(80, function () { return h.w.completed.length > 0; });
  ok(h.w.completed.length > 0);
  ok(h.s().running);
  h.miner.stop("Off");
  eq(h.opts.pauseOnLostFocus, true);
});

// ---------- walking home ----------

test("a push pauses mining, walks back to the start, and resumes", function () {
  var h = harness({ simulateWalking: true });
  h.floor(-2, 2, -2, 2);
  h.w.blocks.set("0,63,1", h.w.cobble);
  ok(h.begin());
  h.cycle();
  h.w.player.x = 1.6; h.w.player.z = 1.1;
  h.cycle();
  eq(h.s().returning, true);
  eq(h.s().activity, "returning");
  eq(h.opts.keyAttack.down, false);
  ok(h.w.player.x !== 0.5, "does not teleport");
  h.run(150, function () { return !h.s().returning; });
  eq(h.s().returning, false);
  ok(h.s().running);
  ok(Math.sqrt(Math.pow(h.w.player.x - 0.5, 2) + Math.pow(h.w.player.z - 0.5, 2)) <= 0.06);
  eq(h.s().homeX, 0.5); eq(h.s().homeZ, 0.5);
  h.run(60);
  eq(h.opts.keyAttack.down, true, "mining resumed");
});

test("stopping while returning releases movement and restores the focus setting", function () {
  var h = harness();
  h.floor(-1, 2, -1, 2);
  ok(h.begin());
  h.w.player.x = 1.2;
  h.cycle();
  ok(["keyUp", "keyDown", "keyLeft", "keyRight"].some(function (k) { return h.opts[k].down; }), "walking");
  h.miner.stop("Off");
  ["keyUp", "keyDown", "keyLeft", "keyRight", "keyShift"].forEach(function (k) { eq(h.opts[k].down, false, k); });
  eq(h.opts.pauseOnLostFocus, true);
});

test("the walk home detours around a wall without crossing it", function () {
  var h = harness({ simulateWalking: true });
  h.floor(-1, 4, -3, 3);
  h.w.blocks.set("1,64,0", h.w.stone);
  h.w.blocks.set("1,65,0", h.w.stone);
  ok(h.begin());
  h.w.player.x = 2.5;
  var detoured = false;
  h.run(250, function () {
    if (Math.abs(h.w.player.z - 0.5) > 0.4) detoured = true;
    return h.s().phase === "running" && !h.s().returning && h.w.player.x < 2;
  });
  ok(detoured, "went around");
  ok(h.s().running);
  eq(h.s().returning, false);
  ok(Math.sqrt(Math.pow(h.w.player.x - 0.5, 2) + Math.pow(h.w.player.z - 0.5, 2)) <= 0.06);
});

test("the walk home waits instead of crossing missing ground", function () {
  var h = harness({ simulateWalking: true });
  h.w.blocks.set("0,63,0", h.w.stone);
  h.w.blocks.set("2,63,0", h.w.stone);
  ok(h.begin());
  h.w.player.x = 2.5;
  h.run(20);
  eq(h.s().returning, true);
  eq(h.w.player.x, 2.5); eq(h.w.player.z, 0.5);
  ok(h.s().status.indexOf("waiting for a clear path") >= 0, h.s().status);
  eq(h.opts.keyAttack.down, false);
});

test("being pushed too far stops the miner with a reason", function () {
  var h = harness();
  ok(h.begin());
  h.w.player.x = 20;
  h.cycle();
  eq(h.s().phase, "off");
  eq(h.halts[0].reason, "Too far from the starting spot to walk back");
});

print(passed + " tests passed");
