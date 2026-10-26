// Route data lives alongside feature settings, but is not a menu setting.
// Each point belongs to one server/save and dimension; numbering is 1-based.
const MAX_POINTS = 256;
const { MAX_GENERATED_POINTS } = require("./generator");
const generated = saved => typeof saved.crop === "string" && /^minecraft:[a-z0-9_]+$/.test(saved.crop);
const finite = n => typeof n === "number" && isFinite(n);

function validPoint(p) {
  return !!p && finite(p.x) && finite(p.y) && finite(p.z) &&
    Math.abs(p.x) <= 30000000 && Math.abs(p.z) <= 30000000 && Math.abs(p.y) <= 2048;
}

function validRoute(saved) {
  return !!saved && (saved.crop === undefined || generated(saved)) && Array.isArray(saved.points) &&
    saved.points.length <= (generated(saved) ? MAX_GENERATED_POINTS : MAX_POINTS) &&
    saved.points.every(validPoint) && (saved.points.length ? typeof saved.context === "string" && saved.context.length > 0 :
      saved.context === null || typeof saved.context === "string");
}

function createRoute(saved, save) {
  let context = null;
  let points = [];
  let crop = null;
  if (validRoute(saved)) {
    context = saved.context;
    points = saved.points.map(p => ({ x: p.x, y: p.y, z: p.z }));
    crop = saved.crop || null;
  }
  const snapshot = () => {
    const value = { context, points: points.map(p => ({ x: p.x, y: p.y, z: p.z })) };
    if (crop) value.crop = crop;
    return value;
  };
  function add(point, world) {
    if (crop) return "Generated loops cannot be edited by hand. Use /af generate again, or /af clear for a manual route.";
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
    if (crop) return "Generated loops cannot be edited by hand. Regenerate or clear the route first.";
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
  function clear() { points = []; context = null; crop = null; save(snapshot()); }
  function replace(saved) {
    if (!validRoute(saved)) return "This config contains an invalid waypoint route.";
    context = saved.context;
    points = saved.points.map(p => ({ x: p.x, y: p.y, z: p.z }));
    crop = saved.crop || null;
    save(snapshot());
    return null;
  }
  return { snapshot, add, remove, clear, replace };
}

module.exports = { createRoute, validRoute, MAX_POINTS };
