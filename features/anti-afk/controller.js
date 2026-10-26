// Tick-driven input pulses. Keep the original bindings so cleanup also works
// after Minecraft has cleared its player/level during a disconnect.
function createAntiAfk(deps) {
  const owned = new Set();
  const manualKeys = ["keyUp", "keyDown", "keyLeft", "keyRight", "keyJump", "keyShift", "keyAttack", "keyUse"];
  let session = null, wait = 0, phase = -1, direction = 1;
  let mining = false;

  function write(binding, down) {
    if (binding.isDown() === down) return;
    binding.setDown(down);
    // Crouch/attack can be ToggleKeyMappings. A release alone is ignored.
    if (!down && binding.isDown()) binding.setDown(true);
  }

  function release() {
    let error = null;
    owned.forEach(binding => {
      try { write(binding, false); } catch (e) { error = e; }
    });
    owned.clear();
    if (mining) {
      mining = false;
      try { session.game.gameMode.stopDestroyBlock(); } catch (e) { error = e; }
    }
    if (error) throw error;
  }

  function reset() {
    try { release(); }
    finally {
      if (session) session.options.pauseOnLostFocus = session.pauseOnLostFocus;
      session = null;
      phase = -1;
      wait = Math.round(deps.setting("interval") * 20);
    }
  }

  function input(name, down) {
    const binding = session.options[name];
    if (down) {
      if (binding.isDown() && !owned.has(binding)) return;
      owned.add(binding);
      write(binding, true);
    } else if (owned.has(binding)) {
      write(binding, false);
      owned.delete(binding);
    }
  }

  function attack(game) {
    // One native attack, rather than a queued key click (unreliable in CT).
    // This happens before this tick's rotation, against the visible crosshair.
    const hit = game.hitResult;
    if (hit && hit.getType() === deps.T.HitType.ENTITY) game.gameMode.attack(game.player, hit.getEntity());
    else if (hit && hit.getType() === deps.T.HitType.BLOCK) {
      mining = true;
      game.gameMode.startDestroyBlock(hit.getBlockPos(), hit.getDirection());
    }
    game.player.swing(deps.T.InteractionHand.MAIN_HAND);
  }

  function tick() {
    const game = deps.game();
    if (!deps.loaded() || !game || !game.player || !game.level || !game.gameMode) { reset(); return; }
    if (session && (session.game !== game || session.player !== game.player || session.level !== game.level)) {
      reset();
      return;
    }
    const p = game.player;
    if (deps.inGui() || !p.isAlive() || p.isPassenger() || p.isSleeping() || game.gameMode.isSpectator() || p.isUsingItem()) {
      reset();
      return;
    }
    if (manualKeys.some(name => game.options[name].isDown() && !owned.has(game.options[name]))) {
      reset();
      return;
    }
    if (!session) {
      session = { game, player: p, level: game.level, options: game.options, pauseOnLostFocus: game.options.pauseOnLostFocus };
      game.options.pauseOnLostFocus = false;
    }
    if (phase < 0) {
      if (--wait > 0) return;
      phase = 0;
    }
    if (phase === 0 && deps.setting("attack")) attack(game);
    if (phase === 1 && mining) { game.gameMode.stopDestroyBlock(); mining = false; }
    if (deps.setting("rotate") && phase < 8) p.setYRot(p.getYRot() + direction * deps.setting("turnAngle") / 8);
    input(direction > 0 ? "keyLeft" : "keyRight", deps.setting("move") && phase < 4 && p.onGround());
    input("keyJump", deps.setting("jump") && phase === 5 && p.onGround());
    input("keyShift", deps.setting("crouch") && phase >= 10 && phase < 16);
    if (++phase >= 20) {
      release();
      direction = -direction;
      phase = -1;
      wait = Math.max(1, Math.round(deps.setting("interval") * 20) - 19);
    }
  }

  function start() { reset(); direction = 1; }
  return { start, tick, stop: reset };
}

module.exports = { createAntiAfk };
