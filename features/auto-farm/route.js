// Route data lives alongside feature settings, but is not a menu setting.
// Each point belongs to one server/save and dimension; numbering is 1-based.
const MAX_POINTS = 256;
const finite = n => typeof n === "number" && isFinite(n);

function validPoint(p) {
  return !!p && finite(p.x) && finite(p.y) && finite(p.z) &&
    Math.abs(p.x) <= 30000000 && Math.abs(p.z) <= 30000000 && Math.abs(p.y) <= 2048;
}

function validRoute(saved) {
  return !!saved && Array.isArray(saved.points) && saved.points.length <= MAX_POINTS &&
    saved.points.every(validPoint) && (saved.points.length ? typeof saved.context === "string" && saved.context.length > 0 :
      saved.context === null || typeof saved.context === "string");
}

function createRoute(saved, save) {
  let context = null;
  let points = [];
  if (validRoute(saved)) {
    context = saved.context;
    points = saved.points.map(p => ({ x: p.x, y: p.y, z: p.z }));
  }
  const snapshot = () => ({ context, points: points.map(p => ({ x: p.x, y: p.y, z: p.z })) });
  function add(point, world) {
    if (!world || !validPoint(point)) return "Join a world before adding waypoints.";
    if (points.length && world !== context) return "This route belongs to another world or dimension. Use /af clear first.";
    if (points.length >= MAX_POINTS) return "Route limit reached (" + MAX_POINTS + " waypoints).";
    if (points.some(p => Math.sqrt((p.x - point.x) ** 2 + (p.y - point.y) ** 2 + (p.z - point.z) ** 2) < 0.5)) {
      return "That position is already a waypoint; move at least half a block away.";
    }
    context = world;
    points.push({ x: point.x, y: point.y, z: point.z });
    save(snapshot());
    return null;
  }
  function remove(value) {
    if (!points.length) return "No waypoints to remove.";
    const number = value === undefined ? points.length : Number(value);
    if ((value !== undefined && !/^[1-9][0-9]*$/.test(String(value))) || !Number.isInteger(number) || number < 1 || number > points.length) {
      return "Choose a waypoint from 1 to " + points.length + ".";
    }
    points.splice(number - 1, 1);
    if (!points.length) context = null;
    save(snapshot());
    return null;
  }
  function clear() { points = []; context = null; save(snapshot()); }
  function replace(saved) {
    if (!validRoute(saved)) return "This config contains an invalid waypoint route.";
    context = saved.context;
    points = saved.points.map(p => ({ x: p.x, y: p.y, z: p.z }));
    save(snapshot());
    return null;
  }
  return { snapshot, add, remove, clear, replace };
}

module.exports = { createRoute, validRoute, MAX_POINTS };
