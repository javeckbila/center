// Native 26.2 gizmos support filled, outlined, through-wall geometry without
// CT's legacy immediate-mode buffer. Submit in preRenderWorld: Minecraft
// finalizes this collector later in the same submitFeatures() call.
function renderRoute(T, game, route, target, accent) {
  const collection = game.levelRenderer.collectPerFrameRenderThreadGizmos();
  try {
    let shown = 0;
    route.points.forEach((point, index) => {
      if (shown >= 512 && index !== target) return;
      const dx = point.x - game.player.getX(), dz = point.z - game.player.getZ();
      if (dx * dx + dz * dz > 256 * 256) return;
      shown++;
      const active = index === target;
      const color = active ? 0xFFFFCF67 : accent;
      const fill = ((color & 0xFFFFFF) | ((active ? 72 : 38) << 24)) | 0;
      const box = new T.AABB(point.x - 0.3, point.y + 0.02, point.z - 0.3, point.x + 0.3, point.y + 1, point.z + 0.3);
      T.Gizmos.cuboid(box, T.GizmoStyle.strokeAndFill(color | 0, active ? 2.5 : 1.5, fill)).setAlwaysOnTop();
      T.Gizmos.billboardText(String(index + 1), new T.Vec3(point.x, point.y + 1.25, point.z),
        T.TextStyle.forColorAndCentered(color | 0).withScale(0.4)).setAlwaysOnTop();
    });
  } finally {
    collection.close();
  }
}

module.exports = { renderRoute };
