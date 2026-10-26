// Persistent config shared by the menu and every registered module.
// Layout: { features: { [id]: { enabled, bind, values: { [key]: value } } } }
const MODULE = "center";
const FILE = "config.json";

function read() {
  try {
    const raw = FileLib.read(MODULE, FILE);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn(`[center] ${FILE} is unreadable, using defaults: ${error}`);
    return {};
  }
}

const data = read();
if (!data.features || typeof data.features !== "object") data.features = {};
let dirty = false;

function entry(id) {
  let item = data.features[id];
  if (!item || typeof item !== "object") item = data.features[id] = {};
  if (!item.values || typeof item.values !== "object") item.values = {};
  return item;
}

function markDirty() { dirty = true; }

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    FileLib.write(MODULE, FILE, JSON.stringify(data, null, 2), true);
  } catch (error) {
    dirty = true;
    console.error(`[center] Could not save ${FILE}: ${error}`);
  }
}

module.exports = { MODULE, entry, markDirty, flush };
