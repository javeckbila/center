// Persistent config shared by the menu and every registered module.
// Layout: { features: { [id]: { enabled, bind, values: { [key]: value } } } }
const MODULE = "center";
// Outside modules so /ct delete and reinstalling Center preserve user data.
const FILE = "./config/ChatTriggers/center/config.json";
let dirty = false;

function read() {
  try {
    const migrate = !FileLib.exists(FILE);
    const raw = migrate ? FileLib.read(MODULE, "config.json") : FileLib.read(FILE);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Save a valid legacy config immediately, without waiting for a setting edit.
    if (migrate && raw) dirty = true;
    return parsed;
  } catch (error) {
    console.warn(`[center] ${FILE} is unreadable, using defaults: ${error}`);
    return {};
  }
}

const data = read();
if (!data.features || typeof data.features !== "object") data.features = {};

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
    FileLib.write(FILE, JSON.stringify(data, null, 2), true);
  } catch (error) {
    dirty = true;
    console.error(`[center] Could not save ${FILE}: ${error}`);
  }
}

flush();

module.exports = { MODULE, entry, markDirty, flush };
