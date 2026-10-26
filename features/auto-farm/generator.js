// Incremental crop graph scan and interior lane planner. Every edge is cardinal,
// reversible and checked for the player's full collision box by the reader.
// Work is time-sliced: each step() call runs until its work or time budget.
const MAX_CELLS = 32768;
const MAX_GENERATED_POINTS = 65536;
const WAYPOINT_BUDGET = 15;
const SWEEP_MARGIN = 2;
const MAX_PASSES = 6;
// Target distance between neighbouring farming passes. Each pass sweeps at
// least one row to each side, so three rows apart leaves no unswept row.
const LANE_SPACING = 3;
const DIRECTIONS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const DY_ORDER = [0, -1, 1];
const point = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
const heading = (dx, dz) => dz === 1 && dx === 0 ? 0 : dx === 1 && dz === 0 ? 1 : dz === -1 && dx === 0 ? 2 : dx === -1 && dz === 0 ? 3 : -1;

// Collision-free numeric keys relative to an origin tile. A connected bed of
// MAX_CELLS tiles cannot leave this range, and the product stays below 2^53.
function keys(origin) {
  const ox = origin.x - 40000, oz = origin.z - 40000, oy = origin.cy - 8192;
  const column = (x, z) => (x - ox) * 80000 + (z - oz);
  return { column, tile: (x, cy, z) => column(x, z) * 16384 + (cy - oy) };
}

function compress(walk) {
  const out = [];
  for (let i = 0; i < walk.length; i++) {
    if (i > 0 && i < walk.length - 1) {
      const a = walk[i - 1], p = walk[i], b = walk[i + 1];
      // The controller probes terrain along the whole run and jumps locally.
      // A height change on a straight run does not need another waypoint.
      if (p.x - a.x === b.x - p.x && p.z - a.z === b.z - p.z) continue;
    }
    out.push(point(walk[i]));
  }
  return out;
}

// Search position + incoming heading. A plain tile BFS treats every shortest
// staircase as equal to a long straight run. Minimize turns first, then length;
// retain every checked grid edge rather than smoothing through walls/crop gaps.
// `key(tile)` must uniquely identify a tile; defaults to coordinates.
function createPathSearch(start, goal, neighbors, key) {
  if (!key && start) { const k = keys(start); key = t => k.tile(t.x, t.cy, t.z); }
  const heap = [], best = new Map(), discovered = new Set();
  let done = !start, path = null;
  const goalKey = start ? key(goal) : null;
  const before = (a, b) => a.turns < b.turns || a.turns === b.turns &&
    (a.estimate < b.estimate || a.estimate === b.estimate && a.steps < b.steps);
  function push(n) {
    let i = heap.length; heap.push(n);
    while (i > 0) {
      const parent = (i - 1) >> 1;
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
  function add(tile, tileKey, direction, turns, steps, parent) {
    const id = tileKey * 5 + direction + 1, old = best.get(id);
    if (old && (old.turns < turns || old.turns === turns && old.steps <= steps)) return;
    const n = { tile, key: tileKey, direction, turns, steps, parent,
      estimate: steps + Math.abs(tile.x - goal.x) + Math.abs(tile.z - goal.z) };
    best.set(id, n); discovered.add(tileKey); push(n);
  }
  if (start) add(start, key(start), -1, 0, 0, null);
  function step(budget, milliseconds) {
    const limit = budget || 64, deadline = milliseconds ? Date.now() + milliseconds : Infinity;
    let used = 0;
    while (used < limit && !done && Date.now() < deadline) {
      used++;
      if (!heap.length || discovered.size > MAX_CELLS) { done = true; break; }
      const n = pop();
      if (best.get(n.key * 5 + n.direction + 1) !== n) continue;
      if (n.key === goalKey && Math.abs(n.tile.y - goal.y) < 0.1) {
        path = []; let at = n;
        while (at) { path.push(at.tile); at = at.parent; }
        path.reverse(); done = true; break;
      }
      const adjacent = neighbors(n.tile);
      for (let i = 0; i < adjacent.length; i++) {
        const tile = adjacent[i], direction = heading(tile.x - n.tile.x, tile.z - n.tile.z);
        if (direction < 0) continue;
        add(tile, key(tile), direction, n.turns + (n.direction >= 0 && n.direction !== direction ? 1 : 0), n.steps + 1, n);
      }
    }
    return { done, path, used };
  }
  return { step };
}

// Crop-graph neighbours of a reader tile. At most one supported crop tile can
// exist among cy-1, cy and cy+1 in a column (a crop is never another crop's
// floor, and a floor above a lower crop blocks its headroom).
function adjacentTiles(reader, a, out) {
  for (let d = 0; d < 4; d++) {
    const x = a.x + DIRECTIONS[d][0], z = a.z + DIRECTIONS[d][1];
    for (let i = 0; i < 3; i++) {
      const b = reader.tile(x, a.cy + DY_ORDER[i], z);
      if (!b) continue;
      if (reader.edge(a, b)) out.push(b);
      break;
    }
  }
  return out;
}

function createGenerator(reader, context) {
  const seed = reader.seed;
  const key = seed ? keys(seed) : null;
  const nodes = new Map(), list = [], columns = new Map();
  let cursor = 0, phase = "scan", error = null, result = null;
  let interiorCount = 0, minimumRun = 2, passLimit = MAX_PASSES;
  let fieldMinX = Infinity, fieldMaxX = -Infinity, fieldMinZ = Infinity, fieldMaxZ = -Infinity;
  let component = [], componentCursor = 0, componentId = 0, bestComponent = [], bestProximity = Infinity;
  let targets = [], leg = 0, walk = [], search = null;
  const paths = new Map();
  if (!seed) fail("Stand on a supported crop with clear headroom before generating.");
  else addNode(seed);

  function fail(message) { error = message; phase = "failed"; }
  function addNode(tile) {
    fieldMinX = Math.min(fieldMinX, tile.x); fieldMaxX = Math.max(fieldMaxX, tile.x);
    fieldMinZ = Math.min(fieldMinZ, tile.z); fieldMaxZ = Math.max(fieldMaxZ, tile.z);
    const node = { x: tile.x, cy: tile.cy, z: tile.z, y: tile.y, key: key.tile(tile.x, tile.cy, tile.z),
      edges: [], interior: false, component: 0, inner: null };
    nodes.set(node.key, node); list.push(node);
    const column = key.column(tile.x, tile.z);
    const stack = columns.get(column);
    if (stack) stack.push(node); else columns.set(column, [node]);
    return node;
  }
  const chosen = n => n.component === componentId;
  const innerEdges = n => n.inner || (n.inner = n.edges.filter(chosen));

  function planLanes() {
    targets = []; walk = []; leg = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    component.forEach(n => {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
    });
    const alongZ = maxZ - minZ >= maxX - minX;
    const across = alongZ ? "x" : "z", along = alongZ ? "z" : "x";
    const rows = new Map();
    component.forEach(n => {
      const row = rows.get(n[across]);
      if (row) row.push(n); else rows.set(n[across], [n]);
    });
    const coordinates = Array.from(rows.keys()).sort((a, b) => a - b);
    const span = c => { const row = rows.get(c); return row[row.length - 1][along] - row[0][along]; };
    // A row without holes needs no detour bends.
    const solid = c => rows.get(c).length === span(c) + 1;
    let longest = 0, longestRow = null;
    coordinates.forEach(c => {
      rows.get(c).sort((a, b) => a[along] - b[along]);
      if (longestRow === null || span(c) > longest || span(c) === longest && solid(c) && !solid(longestRow)) { longest = span(c); longestRow = c; }
    });
    // Every row with a real farming run can host a pass, including the short
    // arm of an L-shaped or stepped bed; stubs below minimumRun cannot.
    const usefulRows = coordinates.filter(c => span(c) >= minimumRun);
    if (!usefulRows.length) return fail("No useful farming passes: need a crop-only run of at least " + minimumRun +
      " blocks with sweep clearance (" + nodes.size + " crops scanned). Previous route kept.");
    // Enough passes to sweep every useful row (interval cover, so separate
    // arms each get their own passes), rounded to an even count so the loop
    // closes along the near headland instead of crossing the bed. Narrow beds
    // no longer zigzag through every adjacent row.
    let wanted = 0, covered = -Infinity;
    usefulRows.forEach(c => { if (c > covered) { wanted++; covered = c + LANE_SPACING - 1; } });
    wanted = Math.max(2, wanted + wanted % 2);
    const passes = Math.min(passLimit, usefulRows.length, wanted);
    passLimit = passes;
    const lanes = [];
    if (passes === 1) lanes.push(longestRow);
    else {
      // Choose passes from the outermost useful rows inward, minimizing the
      // sum of squared gaps (even spacing by coordinate, never bunching).
      // The crop-only search minimizes bends, so a pass through a hole tends
      // to shift onto a neighbouring row for its whole length. Such rows are
      // used only when no hole-free row can fill a much larger gap.
      const n = usefulRows.length, HOLE = 40;
      const extra = j => solid(usefulRows[j]) ? 0 : HOLE;
      let cost = usefulRows.map((c, j) => j === 0 ? extra(0) : Infinity);
      const from = [];
      for (let i = 1; i < passes; i++) {
        const next = [], back = [];
        for (let j = 0; j < n; j++) { next.push(Infinity); back.push(-1); }
        for (let j = i; j < n; j++) for (let k = i - 1; k < j; k++) {
          if (cost[k] === Infinity) continue;
          const g = usefulRows[j] - usefulRows[k], value = cost[k] + g * g + extra(j);
          if (value < next[j]) { next[j] = value; back[j] = k; }
        }
        from.push(back); cost = next;
      }
      for (let i = passes - 1, j = n - 1; i >= 0; j = i > 0 ? from[i - 1][j] : -1, i--) lanes.unshift(usefulRows[j]);
    }
    // Enter each pass from the end nearest the previous pass's exit. On a
    // rectangle this alternates; on stepped beds it avoids walking back
    // along a long pass to reach a short one.
    const gap = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) + Math.abs(a.y - b.y);
    lanes.forEach((lane, i) => {
      const row = rows.get(lane), first = row[0], last = row[row.length - 1];
      const exit = targets[targets.length - 1];
      const ends = i === 0 || gap(exit, first) <= gap(exit, last) ? [first, last] : [last, first];
      ends.forEach(n => { if (!targets.length || targets[targets.length - 1] !== n) targets.push(n); });
    });
    if (targets.length < 2) return fail("Not enough interior crop space for a sweep-safe loop.");
    targets.push(targets[0]);
    walk.push(targets[0]); leg = 1; search = null; phase = "search";
  }
  function finish() {
    // Keep the implicit closing edge, without a duplicate start point.
    if (walk.length > 1 && walk[walk.length - 1] === walk[0]) walk.pop();
    const points = compress(walk);
    if (points.length > 2) {
      const a = points[points.length - 2], b = points[points.length - 1], c = points[0];
      if ((a.x === b.x && b.x === c.x && (b.z - a.z) * (c.z - b.z) > 0) ||
          (a.z === b.z && b.z === c.z && (b.x - a.x) * (c.x - b.x) > 0)) points.pop();
    }
    if (points.length > WAYPOINT_BUDGET) {
      // Retry fewer passes when essential bends exceed the waypoint budget.
      if (passLimit > 1) { passLimit--; planLanes(); return; }
      return fail("Cannot connect these crops safely within " + WAYPOINT_BUDGET + " waypoints. Previous route kept.");
    }
    result = { context, crop: reader.crop, points };
    phase = "done";
  }
  function scanOne() {
    if (cursor === list.length) {
      if (nodes.size < 2) return fail("Need at least two connected, walkable crop tiles.");
      const fieldSpan = Math.max(fieldMaxX - fieldMinX, fieldMaxZ - fieldMinZ);
      minimumRun = Math.min(8, Math.max(2, Math.ceil((fieldSpan - SWEEP_MARGIN * 2) * 0.5)));
      cursor = 0; phase = "inset"; return;
    }
    const a = list[cursor++], adjacent = adjacentTiles(reader, a, []);
    for (let i = 0; i < adjacent.length; i++) {
      const b = adjacent[i];
      let node = nodes.get(key.tile(b.x, b.cy, b.z));
      if (!node) {
        if (nodes.size >= MAX_CELLS) return fail("Crop bed exceeds " + MAX_CELLS + " tiles. Use a smaller connected bed; previous route kept.");
        node = addNode(b);
      }
      a.edges.push(node);
    }
  }
  function insetOne() {
    if (cursor === list.length) {
      if (!interiorCount) return fail("No room for sweeping: need at least two crop rows of clearance from every border, aisle and wall.");
      cursor = 0; phase = "component"; return;
    }
    const a = list[cursor++];
    for (let dx = -SWEEP_MARGIN; dx <= SWEEP_MARGIN; dx++) for (let dz = -SWEEP_MARGIN; dz <= SWEEP_MARGIN; dz++) {
      const nearby = columns.get(key.column(a.x + dx, a.z + dz));
      if (!nearby) return;
      let level = false;
      for (let i = 0; i < nearby.length && !level; i++) level = Math.abs(nearby[i].y - a.y) <= SWEEP_MARGIN + 0.01;
      if (!level) return;
    }
    a.interior = true; interiorCount++;
  }
  function componentOne() {
    if (componentCursor < component.length) {
      const edges = component[componentCursor++].edges;
      for (let i = 0; i < edges.length; i++) {
        const b = edges[i];
        if (b.interior && !b.component) { b.component = componentId; component.push(b); }
      }
      return;
    }
    if (component.length) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, proximity = Infinity;
      component.forEach(t => {
        minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x); minZ = Math.min(minZ, t.z); maxZ = Math.max(maxZ, t.z);
        proximity = Math.min(proximity, (t.x - seed.x) ** 2 + (t.z - seed.z) ** 2 + (t.y - seed.y) ** 2);
      });
      if (Math.max(maxX - minX, maxZ - minZ) >= minimumRun &&
          (component.length > bestComponent.length || component.length === bestComponent.length && proximity < bestProximity)) {
        bestComponent = component; bestProximity = proximity;
      }
      component = []; componentCursor = 0;
      return;
    }
    while (cursor < list.length && (!list[cursor].interior || list[cursor].component)) cursor++;
    if (cursor < list.length) {
      const n = list[cursor++]; n.component = ++componentId; component.push(n);
      return;
    }
    if (!bestComponent.length) return fail("Only tiny sweep-clear patches found among " + nodes.size +
      " crop tiles; need a farming pass at least " + minimumRun + " blocks long. Previous route kept.");
    component = bestComponent; componentId = component[0].component; planLanes();
  }
  // Returns the work consumed so long searches share the slice budget.
  function searchSome(limit, deadline) {
    const from = targets[leg - 1], to = targets[leg], id = from.key + ">" + to.key;
    let found = paths.get(id), used = 1;
    if (!found) {
      if (!search) search = createPathSearch(from, to, innerEdges, n => n.key);
      const state = search.step(limit, deadline === Infinity ? 0 : Math.max(1, deadline - Date.now()));
      used = Math.max(1, state.used);
      if (!state.done) return used;
      search = null;
      if (!state.path) { fail("Unable to close a crop-only loop."); return used; }
      found = state.path; paths.set(id, found);
    }
    for (let i = 1; i < found.length; i++) walk.push(found[i]);
    if (++leg === targets.length) finish();
    return used;
  }
  function step(budget, milliseconds) {
    const limit = budget || 64, deadline = milliseconds ? Date.now() + milliseconds : Infinity;
    let work = 0;
    while (work < limit && phase !== "done" && phase !== "failed" && Date.now() < deadline) {
      if (reader.unloaded()) { fail("Crop bed reaches unloaded chunks. Load the whole bed and generate again; previous route kept."); break; }
      if (phase === "search") { work += searchSome(limit - work, deadline); continue; }
      work++;
      if (phase === "scan") scanOne();
      else if (phase === "inset") insetOne();
      else componentOne();
    }
    // Overall planning progress after the scan: inset, regions, then legs.
    let progress = phase === "done" ? 1 : 0;
    if (phase === "inset") progress = 0.3 * cursor / list.length;
    else if (phase === "component") progress = 0.3 + 0.2 * cursor / list.length;
    else if (phase === "search") progress = 0.5 + 0.5 * (leg - 1) / Math.max(1, targets.length - 1);
    return { phase, error, result, count: nodes.size, interior: component.length, progress };
  }
  return { step };
}

// Join a saved loop through the crop graph, without a straight shortcut
// through a wall. This search is also stepped by the arming tick.
function createJoin(reader, goal) {
  const destination = { x: Math.floor(goal.x), cy: Math.floor(goal.y + 0.1), z: Math.floor(goal.z), y: goal.y };
  const search = createPathSearch(reader.seed, destination, a => adjacentTiles(reader, a, []));
  function step(budget, milliseconds) {
    const state = search.step(budget, milliseconds);
    if (reader.unloaded()) return { done: true, path: null };
    return { done: state.done, path: state.path ? compress(state.path) : null };
  }
  return { step };
}

module.exports = { createGenerator, createJoin, createPathSearch, compress, MAX_CELLS, MAX_GENERATED_POINTS, WAYPOINT_BUDGET };
