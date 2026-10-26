// Perspective lifecycle and input isolation under CT's bundled Rhino.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": got " + a + ", expected " + b); }
function ok(value, msg) { if (!value) throw new Error(msg || "expected truthy"); }
var PERSPECTIVE = require("center/core/perspective");
function harness(type, pause) {
  var w = require("center/tests/mock-world").createMockWorld({});
  w.game.options.cameraType = type || "first";
  if (pause !== undefined) w.game.options.pauseOnLostFocus = pause;
  var view = PERSPECTIVE.createPerspective({ game: () => w.game, inGui: () => w.gui, thirdPerson: "back" });
  return { w, view, options: w.game.options, rotation: () => view.rotation(w.game.player) };
}

test("starts from the player's angles, orbits independently, and clamps pitch", function () {
  var h = harness(); h.w.player.setYRot(35); h.w.player.setXRot(20);
  h.view.start(); eq(h.rotation().yaw, 35); eq(h.rotation().pitch, 20);
  eq(h.options.cameraType, "back"); eq(h.options.pauseOnLostFocus, false);
  ok(h.view.turn(100, -100)); eq(h.rotation().yaw, 50); eq(h.rotation().pitch, 5);
  h.w.player.setYRot(-150); h.w.player.setXRot(85);
  eq(h.rotation().yaw, 50); eq(h.rotation().pitch, 5);
  h.view.turn(7200, 2000); eq(h.rotation().yaw, 50); eq(h.rotation().pitch, 90);
  h.view.turn(0, -2000); eq(h.rotation().pitch, -90);
  eq(h.w.player.getYRot(), -150); eq(h.w.player.getXRot(), 85);
});

test("restores every original perspective and focus preference; stop is idempotent", function () {
  ["first", "back", "front"].forEach(type => [true, false].forEach(pause => {
    var h = harness(type, pause); h.view.start(); h.view.start(); h.view.stop(); h.view.stop();
    eq(h.options.cameraType, type); eq(h.options.pauseOnLostFocus, pause);
    eq(h.view.turn(50, 50), false); eq(h.rotation(), null);
  }));
});

test("F5 cannot exit perspective during automation; another entity's camera is untouched", function () {
  var h = harness(); h.view.start(); h.options.setCameraType("front");
  eq(h.view.rotation({}), null); eq(h.options.cameraType, "front");
  ok(h.rotation()); eq(h.options.cameraType, "back");
  h.view.stop(); eq(h.options.cameraType, "first");
});

test("alt-tab keeps perspective active; screens, player replacement and world loss release it", function () {
  ["gui", "player", "level"].forEach(reason => {
    var h = harness(); h.view.start(); h.w.focused = false;
    ok(h.view.turn(30, 10)); eq(h.w.game.isPaused(), false);
    if (reason === "gui") h.w.gui = true;
    else h.w.game[reason] = null;
    eq(h.view.turn(100, 100), false);
    eq(h.options.cameraType, "first"); eq(h.options.pauseOnLostFocus, true);
  });
});

test("a failed camera change restores pause and leaves no mouse interception", function () {
  var h = harness(); var set = h.options.setCameraType;
  h.options.setCameraType = function (value) { if (value === "back") throw new Error("camera unavailable"); set.call(this, value); };
  var threw = false;
  try { h.view.start(); } catch (error) { threw = true; }
  ok(threw); eq(h.options.pauseOnLostFocus, true); eq(h.options.cameraType, "first");
  eq(h.view.turn(50, 50), false);
});

print(passed + " tests passed");
