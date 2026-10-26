// Named route + setting snapshots, persisted by center's shared config store.
const { validRoute } = require("./route");
const LIMIT = 32;
const validName = name => typeof name === "string" && /^[a-z0-9_-]{1,32}$/i.test(name);
const clone = value => JSON.parse(JSON.stringify(value));

function createProfiles(saved, persist) {
  const entries = [];
  if (Array.isArray(saved)) saved.forEach(entry => {
    if (entries.length >= LIMIT || !entry || !validName(entry.name) || !validRoute(entry.route) ||
        !entry.values || typeof entry.values !== "object" || Array.isArray(entry.values)) return;
    const name = entry.name.toLowerCase();
    if (!entries.some(p => p.name === name)) entries.push(clone({ name, route: entry.route, values: entry.values }));
  });
  const find = name => entries.find(p => p.name === String(name || "").toLowerCase());
  const commit = () => persist(clone(entries));
  function save(name, route, values) {
    if (!validName(name)) return "Use a config name of 1-32 letters, numbers, underscores or hyphens.";
    if (!validRoute(route)) return "Cannot save an invalid route.";
    const previous = find(name);
    if (!previous && entries.length >= LIMIT) return "Config limit reached (32). Delete an unused config first.";
    const entry = clone({ name: name.toLowerCase(), route, values });
    if (previous) entries[entries.indexOf(previous)] = entry;
    else entries.push(entry);
    commit();
    return null;
  }
  function load(name) { const entry = find(name); return entry ? clone(entry) : null; }
  function remove(name) {
    const entry = find(name);
    if (!entry) return "Unknown config. Use /af configs to list saved names.";
    entries.splice(entries.indexOf(entry), 1);
    commit();
    return null;
  }
  return { save, load, remove, names: () => entries.map(p => p.name).sort() };
}

module.exports = { createProfiles };
