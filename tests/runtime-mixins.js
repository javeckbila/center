// Reproduce CT's null callbacks after /ct load, with either or both hooks absent.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": got " + a + ", expected " + b); }
var missing = String(java.lang.System.getProperty("center.test.missingHooks", "both"));
var w = require("center/tests/mock-world").createMockWorld({});
var messages = [];
var attached = 0;
var Client = { getMinecraft: () => w.game, isInGui: () => w.gui };
var ChatLib = { chat: text => messages.push(String(text)) };
var Java = { type: name => name === "java.lang.System" ? java.lang.System : w.typeByName[name] };
function At(options) { this.options = options; }
function Local(options) { this.options = options; }
function Mixin(target) { this.target = target; }
// Farm Hitboxes' shape hooks are also new injectors after /ct load.
Mixin.prototype.modifyReturnValue = function () { return null; };
Mixin.prototype.modifyArgs = function () {
  var isMouse = this.target.indexOf("MouseHandler") >= 0;
  if (missing === "both" || (missing === "mouse" && isMouse) || (missing === "camera" && !isMouse)) return null;
  return { attach: fn => attached++ };
};
var liveView;

test("adapter loads when " + missing + " hooks require restart, without attaching a partial pair", function () {
  liveView = require("center/core/automation-view");
  eq(typeof liveView.start, "function"); eq(typeof liveView.stop, "function");
  eq(attached, 0); eq(w.game.options.pauseOnLostFocus, true);
});

test("automation retains the user's view and restores focus preference before restart", function () {
  w.game.options.setCameraType("front");
  liveView.start();
  eq(w.game.options.getCameraType(), "front"); eq(w.game.options.pauseOnLostFocus, false);
  eq(messages.length, 1);
  eq(messages[0].indexOf("Restart Minecraft") >= 0, true);
  // A manual view change in fallback mode belongs to the user.
  w.game.options.setCameraType("first");
  liveView.stop(); liveView.stop();
  eq(w.game.options.getCameraType(), "first"); eq(w.game.options.pauseOnLostFocus, true);
});

test("the restart reminder appears once and an existing false focus setting is preserved", function () {
  w.game.options.pauseOnLostFocus = false;
  liveView.start(); liveView.stop();
  eq(messages.length, 1); eq(w.game.options.pauseOnLostFocus, false);
  eq(w.game.options.getCameraType(), "first");
});

print(passed + " tests passed");
