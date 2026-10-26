// Persistence and migration regression tests under CT's bundled Rhino.
var passed = 0;
function test(name, fn) { fn(); print("PASS " + name); passed++; }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": got " + a + ", expected " + b); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

var external = "./config/ChatTriggers/center/config.json";
var legacy = "center/config.json";
var source = String(readFile(environment["user.dir"] + "/center/core/store.js"));
var config = { features: {
  "auto-farm": { values: { pitch: 37 }, route: { points: [{ x: 5, y: 64, z: 3 }] },
    profiles: { wheat: { points: [{ x: 5, y: 64, z: 3 }] } } },
  "info-hud": { bind: 75, hud: { ax: 0, dx: 50 }, values: { scale: 2 } },
} };
var original = JSON.stringify(config);

function harness(files) {
  var h = { files: files || {}, writes: 0, logs: [], failWrite: false, failRead: false };
  h.load = function () {
    var mod = { exports: {} };
    var io = {
      exists: function (path) { return h.files.hasOwnProperty(path); },
      read: function (path, file) {
        if (h.failRead) throw new Error("read failed");
        var key = arguments.length === 1 ? path : path + "/" + file;
        return h.files.hasOwnProperty(key) ? h.files[key] : null;
      },
      write: function (path, content, recursive) {
        eq(arguments.length, 3, "path write overload");
        eq(path, external, "only writes outside module");
        eq(recursive, true, "creates missing parents");
        if (h.failWrite) throw new Error("write failed");
        h.files[path] = content;
        h.writes++;
      },
    };
    var log = { warn: function (m) { h.logs.push(m); }, error: function (m) { h.logs.push(m); } };
    new Function("FileLib", "console", "module", source)(io, log, mod);
    return mod.exports;
  };
  return h;
}

test("legacy settings, HUDs, routes and named configs migrate immediately and survive reinstall", function () {
  var h = harness(); h.files[legacy] = original;
  h.load();
  eq(h.writes, 1, "migration saves during load");
  eq(JSON.stringify(JSON.parse(h.files[external])), original, "all config data preserved");
  eq(h.files[legacy], original, "legacy backup unchanged");
  delete h.files[legacy]; // Module removed, then installed again.
  var store = h.load();
  eq(store.entry("auto-farm").values.pitch, 37);
  eq(store.entry("info-hud").hud.dx, 50);
  store.entry("auto-farm").values.pitch = 42;
  store.markDirty(); store.flush();
  eq(h.load().entry("auto-farm").values.pitch, 42, "new edits survive reload");
  ok(!h.files.hasOwnProperty(legacy), "does not recreate module-local config");
});

test("external config takes priority over a stale legacy backup", function () {
  var h = harness(); h.files[legacy] = original;
  h.files[external] = '{"features":{"auto-farm":{"values":{"pitch":61}}}}';
  eq(h.load().entry("auto-farm").values.pitch, 61);
  eq(h.writes, 0, "existing config is not migrated over");
});

test("fresh installs create only the external file when settings change", function () {
  var h = harness(), store = h.load();
  eq(h.writes, 0);
  store.entry("interface").bind = 344;
  store.markDirty(); store.flush(); store.flush();
  eq(h.writes, 1, "only saves dirty data");
  eq(h.load().entry("interface").bind, 344);
  ok(!h.files.hasOwnProperty(legacy));
});

test("failed migration writes retain the loaded settings and retry on flush", function () {
  var h = harness(); h.files[legacy] = original; h.failWrite = true;
  var store = h.load();
  eq(store.entry("auto-farm").values.pitch, 37);
  eq(h.writes, 0); ok(h.logs.length > 0, "failure reported");
  h.failWrite = false; store.flush();
  eq(h.writes, 1); eq(h.load().entry("auto-farm").values.pitch, 37);
});

test("malformed legacy configs do not get copied to the external file", function () {
  ["{bad json", "null", "42", "[]"].forEach(function (raw) {
    var h = harness(); h.files[legacy] = raw;
    var store = h.load();
    eq(h.writes, 0); eq(h.files[legacy], raw);
    ok(store.entry("interface").values);
  });
});

test("an unreadable external config does not resurrect stale legacy settings", function () {
  var h = harness(); h.files[legacy] = original; h.files[external] = "{bad json";
  eq(h.load().entry("auto-farm").values.pitch, undefined);
  eq(h.files[external], "{bad json"); eq(h.writes, 0);
  ok(h.logs.length > 0, "read error reported");
  h.files[external] = null; // FileLib.read also returns null for I/O errors.
  eq(h.load().entry("auto-farm").values.pitch, undefined);
  eq(h.writes, 0, "a present but unreadable file is never migrated over");
  h.failRead = true;
  ok(h.load().entry("interface").values, "I/O errors do not prevent loading");
  eq(h.writes, 0);
});

print("\n" + passed + " store tests passed");
