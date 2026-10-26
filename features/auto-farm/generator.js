// Incremental crop graph scan and interior lane planner. Every edge is cardinal,
// reversible and checked for the player's full collision box by the reader.
const MAX_CELLS = 32768;
const MAX_GENERATED_POINTS = 65536;
const WAYPOINT_BUDGET = 15;
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

// Search position + incoming heading. A plain tile BFS treats every shortest
// staircase as equal to a long straight run. Minimize turns first, then length;
// retain every checked grid edge rather than smoothing through walls/crop gaps.
function createPathSearch(start, goal, neighbors) {
  const heap = [], best = new Map(), discovered = new Set();
  let done = !start, path = null;
  const stateKey = n => cropTileKey(n.tile) + "/" + n.direction;
  const before = (a, b) => a.turns < b.turns || a.turns === b.turns &&
    (a.estimate < b.estimate || a.estimate === b.estimate && a.steps < b.steps);
  function push(n) {
    let i = heap.length; heap.push(n);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!before(n, heap[parent])) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = n;
  }
  function pop() {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++;
        if (!before(heap[child], last)) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  }
  function add(tile, direction, turns, steps, parent) {
    const n = { tile, direction, turns, steps, parent, estimate: steps + Math.abs(tile.x - goal.x) + Math.abs(tile.z - goal.z) };
    const id = stateKey(n), old = best.get(id);
    if (old && (old.turns < turns || old.turns === turns && old.steps <= steps)) return;
    best.set(id, n); discovered.add(cropTileKey(tile)); push(n);
  }
  if (start) add(start, -1, 0, 0, null);
  function step(budget, milliseconds) {
    const deadline = milliseconds ? Date.now() + milliseconds : Infinity;
    for (let work = 0; work < (budget || 64) && !done && Date.now() < deadline; work++) {
      if (!heap.length || discovered.size > MAX_CELLS) { done = true; break; }
      const n = pop();
      if (best.get(stateKey(n)) !== n) continue;
      if (cropTileKey(n.tile) === cropTileKey(goal) && Math.abs(n.tile.y - goal.y) < 0.1) {
        path = []; let at = n;
        while (at) { path.push(at.tile); at = at.parent; }
        path.reverse(); done = true; break;
      }
      neighbors(n.tile).forEach(tile => {
        const direction = DIRECTIONS.findIndex(d => tile.x - n.tile.x === d[0] && tile.z - n.tile.z === d[1]);
        if (direction < 0) return;
        add(tile, direction, n.turns + (n.direction >= 0 && n.direction !== direction ? 1 : 0), n.steps + 1, n);
      });
    }
    return { done, path };
  }
  return { step };
}

function createGenerator(reader, context) {
  const seed = reader.seed;
  const nodes = new Map(), columns = new Map(), queue = [], interior = new Set();
  let cursor = 0, phase = "scan", error = null, result = null;
  let current = null, walk = [], search = null, targets = [], targetIndex = 0;
  let component = [], componentSet = new Set(), bestComponent = [], bestProximity = Infinity;
  const componentVisited = new Set();
  let interiorSeeds = [], interiorCursor = 0, minimumRun = 2;
  let fieldMinX = Infinity, fieldMaxX = -Infinity, fieldMinZ = Infinity, fieldMaxZ = -Infinity;
  let passLimit = 6;
  if (!seed) { phase = "failed"; error = "Stand on a supported crop with clear headroom before generating."; }
  else addNode(seed);

  function fail(message) { error = message; phase = "failed"; }
  function addNode(tile) {
    fieldMinX = Math.min(fieldMinX, tile.x); fieldMaxX = Math.max(fieldMaxX, tile.x);
    fieldMinZ = Math.min(fieldMinZ, tile.z); fieldMaxZ = Math.max(fieldMaxZ, tile.z);
    nodes.set(cropTileKey(tile), { tile, edges: [] }); queue.push(tile);
    const column = tile.x + "," + tile.z;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(tile);
  }
  function beginSearch() {
    search = createPathSearch(nodes.get(current).tile, nodes.get(targets[targetIndex]).tile,
      tile => nodes.get(cropTileKey(tile)).edges.filter(id => componentSet.has(id)).map(id => nodes.get(id).tile));
    phase = "search";
  }
  function planLanes() {
    targets = []; walk = [];
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
    let longest = 0, longestRow = null;
    coordinates.forEach(coordinate => {
      const row = rows.get(coordinate);
      row.sort((a, b) => nodes.get(a).tile[along] - nodes.get(b).tile[along]);
      const span = nodes.get(row[row.length - 1]).tile[along] - nodes.get(row[0]).tile[along];
      if (span > longest) { longest = span; longestRow = coordinate; }
    });
    const usefulRows = coordinates.filter(coordinate => {
      const row = rows.get(coordinate);
      const span = nodes.get(row[row.length - 1]).tile[along] - nodes.get(row[0]).tile[along];
      return span >= Math.max(minimumRun, longest * 0.6);
    });
    if (!usefulRows.length) return fail("No useful farming passes: need a crop-only run of at least " + minimumRun +
      " blocks with sweep clearance (" + nodes.size + " crops scanned). Previous route kept.");
    const passes = Math.min(passLimit, usefulRows.length);
    passLimit = passes;
    // Six long harvesting passes give about twelve turns on an open plot.
    // Retry fewer passes when essential bends exceed the waypoint budget.
    for (let i = 0; i < passes; i++) {
      const row = rows.get(passes === 1 ? longestRow : usefulRows[Math.round(i * (usefulRows.length - 1) / (passes - 1))]);
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
    if (points.length > WAYPOINT_BUDGET) {
      if (passLimit > 1) { passLimit--; planLanes(); return; }
      return fail("Cannot connect these crops safely within " + WAYPOINT_BUDGET + " waypoints. Previous route kept.");
    }
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
          const fieldSpan = Math.max(fieldMaxX - fieldMinX, fieldMaxZ - fieldMinZ);
          minimumRun = Math.min(8, Math.max(2, Math.ceil((fieldSpan - SWEEP_MARGIN * 2) * 0.5)));
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
          if (!interior.size) { fail("No room for sweeping: need at least two crop rows of clearance from every border, aisle and wall."); break; }
          interiorSeeds = Array.from(interior); component = []; cursor = 0; phase = "component"; continue;
        }
        const a = queue[cursor++]; let room = true;
        for (let dx = -SWEEP_MARGIN; dx <= SWEEP_MARGIN && room; dx++) for (let dz = -SWEEP_MARGIN; dz <= SWEEP_MARGIN && room; dz++) {
          const nearby = columns.get((a.x + dx) + "," + (a.z + dz));
          room = !!nearby && nearby.some(b => Math.abs(b.y - a.y) <= SWEEP_MARGIN + 0.01);
        }
        if (room) {
          interior.add(cropTileKey(a));
        }
      } else if (phase === "component") {
        if (cursor < component.length) {
          nodes.get(component[cursor++]).edges.forEach(id => {
            if (interior.has(id) && !componentVisited.has(id)) { componentVisited.add(id); component.push(id); }
          });
        } else if (component.length) {
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, proximity = Infinity;
          component.forEach(id => {
            const t = nodes.get(id).tile;
            minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x); minZ = Math.min(minZ, t.z); maxZ = Math.max(maxZ, t.z);
            proximity = Math.min(proximity, (t.x - seed.x) ** 2 + (t.z - seed.z) ** 2 + (t.y - seed.y) ** 2);
          });
          if (Math.max(maxX - minX, maxZ - minZ) >= minimumRun &&
              (component.length > bestComponent.length || component.length === bestComponent.length && proximity < bestProximity)) {
            bestComponent = component; bestProximity = proximity;
          }
          component = []; cursor = 0;
        } else if (interiorCursor < interiorSeeds.length) {
          const id = interiorSeeds[interiorCursor++];
          if (!componentVisited.has(id)) { componentVisited.add(id); component.push(id); }
        } else {
          if (!bestComponent.length) { fail("Only tiny sweep-clear patches found among " + nodes.size +
            " crop tiles; need a farming pass at least " + minimumRun + " blocks long. Previous route kept."); break; }
          component = bestComponent; componentSet = new Set(component); planLanes();
        }
      } else if (phase === "search") {
        const found = search.step(1);
        if (found.done) {
          if (!found.path) { fail("Unable to close a crop-only loop."); break; }
          search = { path: found.path.slice(1), cursor: 0 }; phase = "bridge";
        }
      } else if (phase === "bridge") {
        if (search.cursor < search.path.length) {
          const tile = search.path[search.cursor++]; current = cropTileKey(tile); walk.push(tile);
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
  const destination = { x: Math.floor(goal.x), cy: Math.floor(goal.y + 0.1), z: Math.floor(goal.z), y: goal.y };
  const search = createPathSearch(reader.seed, destination, a => {
    const adjacent = [];
    DIRECTIONS.forEach(d => {
      for (let dy = -1; dy <= 1; dy++) {
        const b = reader.tile(a.x + d[0], a.cy + dy, a.z + d[1]);
        if (b && reader.edge(a, b)) adjacent.push(b);
      }
    });
    return adjacent;
  });
  function step(budget, milliseconds) {
    const state = search.step(budget, milliseconds);
    if (reader.unloaded()) return { done: true, path: null };
    return { done: state.done, path: state.path ? compress(state.path) : null };
  }
  return { step };
}

module.exports = { createGenerator, createJoin, createPathSearch, compress, MAX_CELLS, MAX_GENERATED_POINTS, WAYPOINT_BUDGET };
