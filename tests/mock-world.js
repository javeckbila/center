// Mock Minecraft world for the auto miner tests: blocks, ray casts, collisions,
// a local player, and a simplified vanilla mining/walking simulation.
// createMockWorld(options) -> { T, game, ... }. T stands in for the Minecraft
// classes the feature resolves with Java.type (see TYPE_NAMES).
//
// options: ping, progress, requirePress (vanilla only mines after a native
// start), ignoreNativeStarts (n), rejectNativeStarts, mouseGrabbed,
// replacementDelay (s before a mined block turns into stone), regenDelay (s
// before a mined block turns back into cobblestone).

function fail(msg) { throw new Error(msg); }

var TYPE_NAMES = {
  BlockPos: "net.minecraft.core.BlockPos",
  Vec3: "net.minecraft.world.phys.Vec3",
  ClipContext: "net.minecraft.world.level.ClipContext",
  ClipBlock: "net.minecraft.world.level.ClipContext$Block",
  ClipFluid: "net.minecraft.world.level.ClipContext$Fluid",
  HitType: "net.minecraft.world.phys.HitResult$Type",
  Blocks: "net.minecraft.world.level.block.Blocks",
  ItemTags: "net.minecraft.tags.ItemTags",
  PlayerActionPacket: "net.minecraft.network.protocol.game.ServerboundPlayerActionPacket",
  PlayerAction: "net.minecraft.network.protocol.game.ServerboundPlayerActionPacket$Action",
  InteractionHand: "net.minecraft.world.InteractionHand",
};

class Pos {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  getX() { return this.x; }
  getY() { return this.y; }
  getZ() { return this.z; }
  equals(p) { return !!p && this.x === p.x && this.y === p.y && this.z === p.z; }
}
class Vec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  add(v) { return new Vec(this.x + v.x, this.y + v.y, this.z + v.z); }
  scale(n) { return new Vec(this.x * n, this.y * n, this.z * n); }
  distanceToSqr(v) { var dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
}
class Clip { constructor(start, end) { this.start = start; this.end = end; } }
class Box {
  constructor(minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX = minX; this.minY = minY; this.minZ = minZ; this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
  }
  move(dx, dy, dz) { return new Box(this.minX + dx, this.minY + dy, this.minZ + dz, this.maxX + dx, this.maxY + dy, this.maxZ + dz); }
}
class ActionPacket {
  constructor(action, pos) { this.action = action; this.pos = pos; }
  getPos() { return this.pos; }
  getAction() { return this.action; }
}

var blockId = function (p) { return p.x + "," + p.y + "," + p.z; };

function binding() {
  return { down: false, isDown: function () { return this.down; }, setDown: function (b) { this.down = !!b; } };
}

function createMockWorld(options) {
  options = options || {};
  var w = {
    clock: 1, gui: false, focused: true, grabbed: options.mouseGrabbed !== false, grabs: 0, grounded: true,
    hasPickaxe: true, progress: options.progress || 0.2, latency: options.ping === undefined ? 120 : options.ping,
    blocks: new Map(), cobble: { name: "cobblestone" }, stone: { name: "stone" },
    iron: { name: "iron_ore" }, deepslateIron: { name: "deepslate_iron_ore" },
    diamond: { name: "diamond_ore" }, deepslateDiamond: { name: "deepslate_diamond_ore" },
    debris: { name: "ancient_debris" },
    completed: [], packets: [], aborts: [], nativeStarts: [],
    // Receives every ServerboundPlayerActionPacket "sent" by the simulated client.
    packetSink: function () {},
  };
  var targetBlocks = [w.cobble, w.iron, w.deepslateIron, w.diamond, w.deepslateDiamond, w.debris];
  var BLOCK = { name: "BLOCK" };
  var MISS = { name: "MISS" };
  var actions = { START_DESTROY_BLOCK: { name: "START" }, STOP_DESTROY_BLOCK: { name: "STOP" }, ABORT_DESTROY_BLOCK: { name: "ABORT" } };
  var pending = [];
  var mining = null;
  var destroyDelay = 0;
  var attackPrimed = !options.requirePress;
  var ignoredNativeStarts = options.ignoreNativeStarts || 0;

  var opts = { pauseOnLostFocus: true };
  ["Up", "Down", "Left", "Right", "Jump", "Shift", "Use", "Attack", "Sprint"].forEach(function (k) { opts["key" + k] = binding(); });

  var player = {
    x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 68,
    getX: function () { return this.x; }, getY: function () { return this.y; }, getZ: function () { return this.z; },
    getYRot: function () { return this.yaw; }, getXRot: function () { return this.pitch; },
    setYRot: function (n) { if (!isFinite(n)) fail("non-finite yaw"); this.yaw = n; },
    setXRot: function (n) { if (!isFinite(n)) fail("non-finite pitch"); this.pitch = n; },
    getEyePosition: function () { return new Vec(this.x, this.y + 1.62, this.z); },
    getViewVector: function () {
      var yr = this.yaw * Math.PI / 180, pr = this.pitch * Math.PI / 180;
      return new Vec(-Math.sin(yr) * Math.cos(pr), -Math.sin(pr), Math.cos(yr) * Math.cos(pr));
    },
    blockInteractionRange: function () { return 4.5; },
    getBoundingBox: function () { return new Box(this.x - 0.3, this.y, this.z - 0.3, this.x + 0.3, this.y + 1.8, this.z + 0.3); },
    getMainHandItem: function () {
      return {
        isEmpty: function () { return false; }, is: function () { return w.hasPickaxe; },
        isDamageableItem: function () { return true; }, getMaxDamage: function () { return 100; }, getDamageValue: function () { return 10; },
      };
    },
    getDestroySpeed: function () { return 8; }, getUUID: function () { return "uuid"; },
    swing: function () {},
    isAlive: function () { return true; }, isPassenger: function () { return false; },
    onGround: function () { return w.grounded; }, isUsingItem: function () { return false; },
  };

  var level = {
    getBlockState: function (p) {
      return {
        is: function (b) { return w.blocks.get(blockId(p)) === b; },
        getDestroyProgress: function () { return w.progress; },
        getFluidState: function () { return { isEmpty: function () { return true; } }; },
      };
    },
    noCollision: function (p, box) {
      for (var x = Math.floor(box.minX + 0.00001); x < Math.ceil(box.maxX - 0.00001); x++) {
        for (var y = Math.floor(box.minY + 0.00001); y < Math.ceil(box.maxY - 0.00001); y++) {
          for (var z = Math.floor(box.minZ + 0.00001); z < Math.ceil(box.maxZ - 0.00001); z++) {
            if (w.blocks.has(x + "," + y + "," + z)) return false;
          }
        }
      }
      return true;
    },
    clip: function (c) {
      var start = c.start, end = c.end;
      var len = Math.sqrt(start.distanceToSqr(end));
      for (var i = 0; i <= Math.ceil(len / 0.02); i++) {
        var t = Math.min(1, i * 0.02 / len);
        var location = new Vec(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t, start.z + (end.z - start.z) * t);
        var p = new Pos(Math.floor(location.x), Math.floor(location.y), Math.floor(location.z));
        if (w.blocks.has(blockId(p))) {
          return (function (pos, loc) {
            return {
              getType: function () { return BLOCK; }, getBlockPos: function () { return pos; },
              getLocation: function () { return loc; }, getDirection: function () { return "UP"; },
            };
          })(p, location);
        }
      }
      return { getType: function () { return MISS; } };
    },
  };

  function emit(action, pos) {
    w.packets.push({ action: action, pos: pos, time: w.clock });
    if (action === actions.ABORT_DESTROY_BLOCK) w.aborts.push(blockId(pos));
    w.packetSink(new ActionPacket(action, pos), { isCancelled: function () { return false; } });
  }

  var game = {
    player: player, level: level, options: opts, hitResult: null, stops: 0,
    mouseHandler: {
      isMouseGrabbed: function () { return w.grabbed; },
      grabMouse: function () { if (w.focused) { w.grabbed = true; w.grabs++; } },
    },
    gameMode: {
      isSpectator: function () { return false; },
      isDestroying: function () { return mining !== null; },
      getDestroyStage: function () { return mining && mining.progress > 0 ? Math.floor(mining.progress * 10) : -1; },
      startDestroyBlock: function (pos, direction) {
        if (targetBlocks.indexOf(w.blocks.get(blockId(pos))) < 0) fail("native start on a non-target block " + blockId(pos));
        if (blockId(pos) !== blockId(game.hitResult.getBlockPos())) fail("native start must match the crosshair");
        if (direction !== "UP") fail("unexpected face " + direction);
        w.nativeStarts.push({ pos: pos, time: w.clock });
        if (ignoredNativeStarts > 0) { ignoredNativeStarts--; return false; }
        if (options.rejectNativeStarts) return false;
        attackPrimed = true;
        mining = { pos: pos, progress: 0 };
        emit(actions.START_DESTROY_BLOCK, pos);
        return true;
      },
      stopDestroyBlock: function () {
        game.stops++;
        if (mining) { emit(actions.ABORT_DESTROY_BLOCK, mining.pos); mining = null; }
      },
    },
    isWindowActive: function () { return w.focused; },
    isPaused: function () { return !w.focused && opts.pauseOnLostFocus; },
    getConnection: function () { return { getPlayerInfo: function () { return { getLatency: function () { return w.latency; } }; } }; },
  };

  w.game = game;
  w.player = player;
  w.actions = actions;
  w.T = {
    BlockPos: Pos, Vec3: Vec, ClipContext: Clip, ClipBlock: { OUTLINE: 1 }, ClipFluid: { NONE: 1 },
    HitType: { BLOCK: BLOCK }, Blocks: {
      COBBLESTONE: w.cobble, IRON_ORE: w.iron, DEEPSLATE_IRON_ORE: w.deepslateIron,
      DIAMOND_ORE: w.diamond, DEEPSLATE_DIAMOND_ORE: w.deepslateDiamond, ANCIENT_DEBRIS: w.debris,
    }, ItemTags: { PICKAXES: 1 },
    PlayerActionPacket: ActionPacket, PlayerAction: actions, InteractionHand: { MAIN_HAND: "MAIN_HAND" },
  };
  w.typeByName = {};
  Object.keys(TYPE_NAMES).forEach(function (k) { w.typeByName[TYPE_NAMES[k]] = w.T[k]; });
  w.emit = emit;

  // Advances time by one 80 fps frame and applies delayed server replacements.
  w.advance = function () {
    w.clock += 0.0125;
    for (var i = pending.length - 1; i >= 0; i--) {
      if (pending[i].time <= w.clock) { w.blocks.set(pending[i].id, pending[i].block); pending.splice(i, 1); }
    }
  };

  // What vanilla's crosshair sees this tick.
  w.updateHit = function () {
    var eye = player.getEyePosition();
    game.hitResult = level.clip(new Clip(eye, eye.add(player.getViewVector().scale(4.5))));
  };

  // Invariants that must hold whenever the miner holds attack.
  w.checkAttack = function () {
    if (!opts.keyAttack.down) return;
    if (game.hitResult.getType() !== BLOCK) fail("attack held while looking at air");
    var id = blockId(game.hitResult.getBlockPos());
    if (targetBlocks.indexOf(w.blocks.get(id)) < 0) fail("attack held on a non-target block " + id);
    if (id === "0,63,0") fail("attack held on the support block");
  };

  // Simplified MultiPlayerGameMode.continueDestroyBlock for one tick.
  w.vanillaMining = function () {
    if (!attackPrimed) return;
    if (!w.grabbed || !opts.keyAttack.down || !game.hitResult || game.hitResult.getType() !== BLOCK) {
      if (mining) { emit(actions.ABORT_DESTROY_BLOCK, mining.pos); mining = null; }
      return;
    }
    if (destroyDelay > 0) { destroyDelay--; return; }
    var pos = game.hitResult.getBlockPos();
    if (!mining || !mining.pos.equals(pos)) {
      if (mining) emit(actions.ABORT_DESTROY_BLOCK, mining.pos);
      mining = { pos: pos, progress: 0 };
      emit(actions.START_DESTROY_BLOCK, pos);
      if (w.progress < 1) return;
    }
    mining.progress += w.progress;
    if (mining.progress < 1 - 1e-8) return;
    mining = null;
    destroyDelay = 5;
    w.completed.push({ id: blockId(pos), time: w.clock });
    emit(actions.STOP_DESTROY_BLOCK, pos);
    if (options.replacementDelay) pending.push({ id: blockId(pos), time: w.clock + options.replacementDelay, block: w.stone });
    else w.blocks.set(blockId(pos), w.stone);
    // Server-side regeneration: the replacement turns back into cobblestone.
    if (options.regenDelay) pending.push({ id: blockId(pos), time: w.clock + options.regenDelay, block: w.cobble });
  };

  // Simplified player movement from the held movement keys for one tick.
  w.vanillaWalking = function () {
    var forward = Number(opts.keyUp.down) - Number(opts.keyDown.down);
    var right = Number(opts.keyRight.down) - Number(opts.keyLeft.down);
    var radians = player.yaw * Math.PI / 180;
    var scale = (opts.keyShift.down ? 0.063 : 0.215) / Math.max(1, Math.sqrt(forward * forward + right * right));
    var dx = (-Math.sin(radians) * forward + Math.cos(radians) * right) * scale;
    var dz = (Math.cos(radians) * forward + Math.sin(radians) * right) * scale;
    if (level.noCollision(player, player.getBoundingBox().move(dx, 0, dz))) { player.x += dx; player.z += dz; }
  };

  return w;
}

module.exports = { createMockWorld: createMockWorld, TYPE_NAMES: TYPE_NAMES };
