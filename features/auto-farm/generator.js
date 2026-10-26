// Incremental crop graph scan and interior lane planner. Every edge is cardinal,
// reversible and checked for the player's full collision box by the reader.
const MAX_CELLS = 32768;
const MAX_GENERATED_POINTS = 65536;
const SWEEP_MARGIN = 2;
const cropTileKey = p => p.x + "," + p.cy + "," + p.z;
const DIRECTIONS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const point = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

function compress(walk) {
  const out = [];
  for (let i = 0; i < walk.length; i++) {
    const p = point(walk[i]);
    if (i > 0 && i < walk.length - 1) {
      const a = walk[i - 1], b = walk[i + 1];
      // The controller probes terrain along the whole run and jumps locally.
      // A height change on a straight run does not need another waypoint.
      if (walk[i].x - a.x === b.x - walk[i].x && walk[i].z - a.z === b.z - walk[i].z) continue;
    }
    out.push(p);
  }
  return out;
}

function createGenerator(reader, context) {
  const seed = reader.seed;
  const nodes = new Map(), columns = new Map(), queue = [], interior = new Set();
  let cursor = 0, phase = "scan", error = null, result = null;
  let current = null, walk = [], search = null, targets = [], targetIndex = 0;
  let nearest = null, nearestDistance = Infinity, component = [], componentSet = new Set();
  if (!seed) { phase = "failed"; error = "Stand on a supported crop with clear headroom before generating."; }
  else addNode(seed);

  function fail(message) { error = message; phase = "failed"; }
  function addNode(tile) {
    nodes.set(cropTileKey(tile), { tile, edges: [] }); queue.push(tile);
    const column = tile.x + "," + tile.z;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(tile);
  }
  function beginSearch() {
    search = { queue: [current], cursor: 0, parents: new Map([[current, null]]), goal: targets[targetIndex] };
    phase = "search";
  }
  function planLanes() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    component.forEach(id => {
      const t = nodes.get(id).tile;
      minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x); minZ = Math.min(minZ, t.z); maxZ = Math.max(maxZ, t.z);
    });
    const alongZ = maxZ - minZ >= maxX - minX;
    const across = alongZ ? "x" : "z", along = alongZ ? "z" : "x";
    const rows = new Map();
    component.forEach(id => {
      const t = nodes.get(id).tile;
      if (!rows.has(t[across])) rows.set(t[across], []);
      rows.get(t[across]).push(id);
    });
    const coordinates = Array.from(rows.keys()).sort((a, b) => a - b);
    const passes = Math.min(6, coordinates.length);
    // Six long harvesting passes give about twelve turns on an open plot.
    // Obstacles may add essential bends; never drop those to meet a count.
    for (let i = 0; i < passes; i++) {
      const row = rows.get(coordinates[passes === 1 ? 0 : Math.round(i * (coordinates.length - 1) / (passes - 1))]);
      row.sort((a, b) => nodes.get(a).tile[along] - nodes.get(b).tile[along]);
      const ends = i % 2 ? [row[row.length - 1], row[0]] : [row[0], row[row.length - 1]];
      ends.forEach(id => { if (!targets.length || targets[targets.length - 1] !== id) targets.push(id); });
    }
    if (targets.length < 2) return fail("Not enough interior crop space for a sweep-safe loop.");
    targets.push(targets[0]);
    current = targets[0]; walk.push(nodes.get(current).tile); targetIndex = 1; beginSearch();
  }
  function finish() {
    // Keep the implicit closing edge, without a duplicate start point.
    if (walk.length > 1 && cropTileKey(walk[walk.length - 1]) === cropTileKey(walk[0])) walk.pop();
    const points = compress(walk);
    if (points.length > 2) {
      const a = points[points.length - 2], b = points[points.length - 1], c = points[0];
      if ((a.x === b.x && b.x === c.x && (b.z - a.z) * (c.z - b.z) > 0) ||
          (a.z === b.z && b.z === c.z && (b.x - a.x) * (c.x - b.x) > 0)) points.pop();
    }
    if (points.length > MAX_GENERATED_POINTS) return fail("Generated route exceeds the waypoint limit.");
    result = { context, crop: reader.crop, points };
    phase = "done";
  }
  function step(budget, milliseconds) {
    const deadline = milliseconds ? Date.now() + milliseconds : Infinity;
    for (let work = 0; work < (budget || 64) && phase !== "done" && phase !== "failed" && Date.now() < deadline; work++) {
      if (reader.unloaded()) { fail("Crop bed reaches unloaded chunks. Load the whole bed and generate again; previous route kept."); break; }
      if (phase === "scan") {
        if (cursor === queue.length) {
          if (nodes.size < 2) { fail("Need at least two connected, walkable crop tiles."); break; }
          cursor = 0; phase = "inset"; continue;
        }
        const a = queue[cursor++], node = nodes.get(cropTileKey(a));
        DIRECTIONS.forEach(d => {
          for (let dy = -1; dy <= 1; dy++) {
            const b = reader.tile(a.x + d[0], a.cy + dy, a.z + d[1]);
            if (!b || !reader.edge(a, b)) continue;
            const id = cropTileKey(b);
            if (!nodes.has(id)) {
              if (nodes.size >= MAX_CELLS) { fail("Crop bed exceeds " + MAX_CELLS + " tiles. Use a smaller connected bed; previous route kept."); return; }
              addNode(b);
            }
            node.edges.push(id);
          }
        });
      } else if (phase === "inset") {
        if (cursor === queue.length) {
          if (!nearest) { fail("No room for sweeping: need at least two crop rows of clearance from every border, aisle and wall."); break; }
          component = [nearest]; componentSet.add(nearest); cursor = 0; phase = "component"; continue;
        }
        const a = queue[cursor++]; let room = true;
        for (let dx = -SWEEP_MARGIN; dx <= SWEEP_MARGIN && room; dx++) for (let dz = -SWEEP_MARGIN; dz <= SWEEP_MARGIN && room; dz++) {
          const nearby = columns.get((a.x + dx) + "," + (a.z + dz));
          room = !!nearby && nearby.some(b => Math.abs(b.y - a.y) <= SWEEP_MARGIN + 0.01);
        }
        if (room) {
          const id = cropTileKey(a); interior.add(id);
          const distance = (a.x - seed.x) ** 2 + (a.z - seed.z) ** 2 + (a.y - seed.y) ** 2;
          if (distance < nearestDistance) { nearestDistance = distance; nearest = id; }
        }
      } else if (phase === "component") {
        if (cursor === component.length) { planLanes(); continue; }
        nodes.get(component[cursor++]).edges.forEach(id => {
          if (interior.has(id) && !componentSet.has(id)) { componentSet.add(id); component.push(id); }
        });
      } else if (phase === "search") {
        if (search.cursor === search.queue.length) { fail("Unable to close a crop-only loop."); break; }
        const id = search.queue[search.cursor++];
        if (id === search.goal) {
          const path = []; let at = id;
          while (search.parents.get(at) !== null) { path.push(at); at = search.parents.get(at); }
          search.path = path.reverse(); search.cursor = 0; phase = "bridge";
        } else nodes.get(id).edges.forEach(next => {
          if (componentSet.has(next) && !search.parents.has(next)) { search.parents.set(next, id); search.queue.push(next); }
        });
      } else if (phase === "bridge") {
        if (search.cursor < search.path.length) {
          current = search.path[search.cursor++]; walk.push(nodes.get(current).tile);
        } else if (++targetIndex === targets.length) finish(); else beginSearch();
      }
    }
    return { phase, error, result, count: nodes.size, interior: component.length };
  }
  return { step };
}

// Join a saved loop through the crop graph, without a straight shortcut
// through a wall. This search is also stepped by the arming tick.
function createJoin(reader, goal) {
  const queue = reader.seed ? [reader.seed] : [], parents = new Map();
  if (reader.seed) parents.set(cropTileKey(reader.seed), null);
  let cursor = 0, done = false, path = null;
  function step(budget, milliseconds) {
    const deadline = milliseconds ? Date.now() + milliseconds : Infinity;
    for (let i = 0; i < (budget || 64) && cursor < queue.length && !done && Date.now() < deadline; i++) {
      const a = queue[cursor++];
      if (Math.abs(a.x + 0.5 - goal.x) < 0.01 && Math.abs(a.z + 0.5 - goal.z) < 0.01 && Math.abs(a.y - goal.y) < 0.1) {
        path = []; let at = a;
        while (at) { path.push(at); at = parents.get(cropTileKey(at)); }
        path = compress(path.reverse()); done = true; break;
      }
      DIRECTIONS.forEach(d => {
        for (let dy = -1; dy <= 1; dy++) {
          const b = reader.tile(a.x + d[0], a.cy + dy, a.z + d[1]);
          if (b && !parents.has(cropTileKey(b)) && reader.edge(a, b)) {
            parents.set(cropTileKey(b), a); queue.push(b);
          }
        }
      });
      if (queue.length > MAX_CELLS || reader.unloaded()) done = true;
    }
    if (cursor === queue.length) done = true;
    return { done, path };
  }
  return { step };
}

module.exports = { createGenerator, createJoin, compress, MAX_CELLS, MAX_GENERATED_POINTS };
