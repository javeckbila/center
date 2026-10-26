// Independent view angles and reversible options for one automation run.
// No CT globals: the live adapter and Rhino tests supply the game and view type.
function createPerspective(deps) {
  const perspectiveEnabled = deps.thirdPerson != null;
  let session = null;
  let yaw = 0, pitch = 0;

  function stop() {
    if (!session) return;
    const saved = session;
    session = null; // release interception even if restoring an option throws
    try { if (perspectiveEnabled) saved.options.setCameraType(saved.cameraType); }
    finally { saved.options.pauseOnLostFocus = saved.pauseOnLostFocus; }
  }

  function start() {
    stop();
    const game = deps.game();
    if (!game || !game.player || !game.level) throw new Error("Perspective requires a loaded world.");
    const options = game.options;
    yaw = game.player.getYRot();
    pitch = game.player.getXRot();
    session = { game, player: game.player, level: game.level, options,
      cameraType: perspectiveEnabled ? options.getCameraType() : null, pauseOnLostFocus: options.pauseOnLostFocus };
    try {
      options.pauseOnLostFocus = false;
      if (perspectiveEnabled) options.setCameraType(deps.thirdPerson);
    } catch (error) { stop(); throw error; }
  }

  function active() {
    if (!session) return false;
    const game = deps.game();
    if (game !== session.game || !game || game.player !== session.player || game.level !== session.level || deps.inGui()) {
      stop();
      return false;
    }
    return true;
  }

  // Deltas already include vanilla sensitivity, inversion and smooth-camera
  // settings. Entity.turn normally converts them to degrees with this factor.
  function turn(dx, dy) {
    if (!active() || !perspectiveEnabled) return false;
    yaw = ((yaw + dx * 0.15 + 180) % 360 + 360) % 360 - 180;
    pitch = Math.max(-90, Math.min(90, pitch + dy * 0.15));
    return true;
  }

  function rotation(entity) {
    if (!active() || !perspectiveEnabled || entity !== session.player) return null;
    // Keep the view in rear third person if F5 is pressed during a run.
    if (session.options.getCameraType() !== deps.thirdPerson) session.options.setCameraType(deps.thirdPerson);
    return { yaw, pitch };
  }

  return { start, stop, turn, rotation };
}

module.exports = { createPerspective };
