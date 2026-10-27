// Inventory preview widget: the 27 main inventory slots, with optional hotbar
// and armor/offhand rows. Movable and scalable in the HUD editor (/center hud).
const { defineFeature } = require("../core/registry");
const iface = require("../core/interface");
const draw = require("../gui/draw");
const theme = require("../gui/theme");

const ID = "inventory-hud";
const PAD = 4;
const CELL = 18;      // slot pitch, as in vanilla inventories
const COLS = 9;
const GAP = 4;        // between slot groups, as in the vanilla inventory screen
const HEADER = 12;
const FLASH_MS = 1200;
const GAIN = 0xFF3ECF8E;
const LOSS = 0xFFF2685E;
// net.minecraft.world.entity.player.Inventory indices: 0-8 hotbar, 9-35 main,
// 36-39 feet/legs/chest/head, 40 offhand. [slot, column] for the equipment row.
const EQUIPMENT = [[39, 0], [38, 1], [37, 2], [36, 3], [40, 8]];
const TRACKED = 41;
const VANILLA = { bg: 0xFFC6C6C6, edge: 0xFF000000, slot: 0xFF8B8B8B, dark: 0xFF373737, light: 0xFFFFFFFF, text: 0xFF404040 };

const seen = [];         // slot -> { item, count } from the last tick
const flashes = new Map(); // slot -> { at, color }
let trackedPlayer = null;
let samples;             // preview stacks outside a world (undefined = not built yet)

let containerClass = null;
try { containerClass = Java.type("net.minecraft.client.gui.screens.inventory.AbstractContainerScreen"); } catch (error) { containerClass = null; }

function localPlayer() {
  if (!World.isLoaded()) return null;
  const mc = Client.getMinecraft();
  return mc ? mc.player : null;
}

const isEmpty = stack => stack == null || stack.isEmpty();

function containerOpen() {
  const screen = Client.currentGui.get();
  return screen != null && containerClass != null && screen instanceof containerClass;
}

// Records every slot each tick and starts a fading tint where something changed.
// Changes made in container screens, or on the first look at a (new) player
// after joining/respawning, are taken silently.
function track(f) {
  const player = localPlayer();
  if (!player) { reset(); return; }
  const inventory = player.getInventory();
  const silent = player !== trackedPlayer || containerOpen() || !f.get("highlight");
  trackedPlayer = player;
  const t = Date.now();
  for (let slot = 0; slot < TRACKED; slot++) {
    const stack = inventory.getItem(slot);
    const item = isEmpty(stack) ? null : stack.getItem();
    const count = item ? stack.getCount() : 0;
    const prev = seen[slot];
    if (prev && !silent && (prev.item !== item || prev.count !== count)) {
      let color;
      if (!item) color = LOSS;
      else if (!prev.item) color = GAIN;
      else if (prev.item === item) color = count > prev.count ? GAIN : LOSS;
      else color = iface.get("accent"); // swapped for a different item
      flashes.set(slot, { at: t, color });
    }
    if (prev) { prev.item = item; prev.count = count; } else seen[slot] = { item, count };
  }
}

function reset() {
  seen.length = 0;
  flashes.clear();
  trackedPlayer = null;
}

// A plausible inventory for the HUD editor when there is no player to read.
function sampleStacks() {
  if (samples !== undefined) return samples;
  samples = null;
  try {
    const items = Java.type("net.minecraft.world.item.Items");
    const Stack = Java.type("net.minecraft.world.item.ItemStack");
    const make = (item, count, damage) => {
      const stack = new Stack(item, count || 1);
      if (damage) stack.setDamageValue(damage);
      return stack;
    };
    samples = {
      0: make(items.DIAMOND_SWORD), 1: make(items.DIAMOND_PICKAXE, 1, 1100), 2: make(items.BOW, 1, 120),
      3: make(items.WATER_BUCKET), 4: make(items.COOKED_BEEF, 23), 5: make(items.ENDER_PEARL, 9),
      7: make(items.TORCH, 48), 8: make(items.COBBLESTONE, 64),
      9: make(items.COBBLESTONE, 64), 10: make(items.COBBLESTONE, 64), 11: make(items.OAK_LOG, 32),
      13: make(items.IRON_INGOT, 27), 14: make(items.REDSTONE, 41), 18: make(items.ARROW, 64),
      20: make(items.WHEAT, 12), 22: make(items.GOLDEN_CARROT, 30), 27: make(items.DIRT, 64),
      28: make(items.DIRT, 17),
      36: make(items.DIAMOND_BOOTS), 37: make(items.IRON_LEGGINGS, 1, 60), 38: make(items.DIAMOND_CHESTPLATE),
      39: make(items.IRON_HELMET), 40: make(items.SHIELD),
    };
  } catch (error) {
    samples = null; // still previews as an empty grid
  }
  return samples;
}

function visibleInGame(f) {
  if (f.get("hideInScreens") && containerOpen()) return false;
  const key = f.get("holdKey");
  // Only outside screens, so typing that key in chat never flashes the HUD.
  if (key >= 0 && !(Client.currentGui.get() == null && Keyboard.isKeyDown(key))) return false;
  return true;
}

// Layout in unscaled HUD units; null = nothing to draw.
// preview (HUD editor): ignore visibility rules and fall back to sample items.
function measure(f, preview) {
  if (!preview && !visibleInGame(f)) return null;
  const player = localPlayer();
  if (!player && !preview) return null;
  const inventory = player ? player.getInventory() : null;
  const sample = player ? null : sampleStacks();
  const stackAt = slot => (inventory ? inventory.getItem(slot) : (sample && sample[slot]) || null);

  const cells = [];
  const add = (slot, col, y) => cells.push({ slot, x: PAD + col * CELL, y, stack: stackAt(slot) });
  const header = f.get("header");
  let y = PAD + (header ? HEADER : 0);
  if (f.get("equipment")) {
    EQUIPMENT.forEach(e => add(e[0], e[1], y));
    y += CELL + GAP;
  }
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < COLS; col++) add(9 + row * COLS + col, col, y);
    y += CELL;
  }
  const hotbar = f.get("hotbar");
  if (hotbar) {
    y += GAP;
    for (let col = 0; col < COLS; col++) add(col, col, y);
    y += CELL;
  }
  let free = 0;
  for (let slot = 0; slot < 36; slot++) if (isEmpty(stackAt(slot))) free++;
  return {
    cells, free, header,
    selected: hotbar ? (inventory ? inventory.getSelectedSlot() : 0) : -1,
    w: PAD * 2 + COLS * CELL,
    h: y + PAD,
  };
}

function vanillaSlot(x, y) {
  draw.rect(x, y, 17, 1, VANILLA.dark);
  draw.rect(x, y + 1, 1, 16, VANILLA.dark);
  draw.rect(x + 1, y + 17, 17, 1, VANILLA.light);
  draw.rect(x + 17, y + 1, 1, 16, VANILLA.light);
  draw.rect(x + 1, y + 1, 16, 16, VANILLA.slot);
}

// Fading tint for a recent change; 0 when none.
function flashAlpha(slot, t) {
  const flash = flashes.get(slot);
  if (!flash) return 0;
  const k = 1 - (t - flash.at) / FLASH_MS;
  if (k <= 0) { flashes.delete(slot); return 0; }
  return k;
}

function render(f, size) {
  const style = f.get("style");
  const vanilla = style === "Vanilla";
  const background = f.get("background");
  const accent = iface.get("accent");
  const t = Date.now();

  if (background) {
    if (vanilla) draw.panel(0, 0, size.w, size.h, 3, VANILLA.bg, VANILLA.edge);
    else draw.rrect(0, 0, size.w, size.h, 4, theme.hudBg);
  }

  if (size.header) {
    // Vanilla's grey panel uses dark text; everything else matches the other HUDs.
    const grey = vanilla && background;
    const free = size.free === 0 ? "Full" : `${size.free} free`;
    const freeColor = size.free === 0 ? LOSS : grey ? VANILLA.text : theme.textDim;
    draw.text("Inventory", PAD + 1, PAD + 1, grey ? VANILLA.text : theme.text, 1, !background);
    draw.text(free, size.w - PAD - 1 - draw.width(free), PAD + 1, freeColor, 1, !background);
  }

  size.cells.forEach(c => {
    const selected = c.slot === size.selected;
    if (vanilla) {
      vanillaSlot(c.x, c.y);
      if (selected) draw.rect(c.x + 1, c.y + 1, 16, 16, 0xFFFFFFFF, 0.45);
    } else if (style === "Modern") {
      if (selected) {
        draw.rrect(c.x, c.y, CELL, CELL, 3, accent);
        draw.rrect(c.x + 1, c.y + 1, 16, 16, 2, theme.chip);
      } else {
        draw.rrect(c.x + 0.5, c.y + 0.5, CELL - 1, CELL - 1, 2, theme.chip, background ? 0.9 : 0.7);
      }
    } else if (selected) {
      draw.rrect(c.x + 1, c.y + 1, 16, 16, 2, accent, 0.35);
    }
    const k = flashAlpha(c.slot, t);
    if (k > 0) draw.rrect(c.x + 1, c.y + 1, 16, 16, 2, flashes.get(c.slot).color, 0.6 * k);
    if (!isEmpty(c.stack)) draw.item(c.stack, c.x + 1, c.y + 1);
  });
}

module.exports = defineFeature({
  id: ID,
  name: "Inventory HUD",
  category: "Render",
  description: "Shows your inventory on screen. Drag it anywhere with /center hud.",
  settings: [
    { type: "toggle", key: "hotbar", name: "Hotbar row", default: false, description: "Adds the hotbar below the inventory, with the selected slot highlighted." },
    { type: "toggle", key: "equipment", name: "Armor and offhand", default: false, description: "Adds your armor and offhand item above the inventory." },
    { type: "toggle", key: "header", name: "Free slots", default: true, description: "Title with the number of empty slots in your inventory and hotbar." },
    { type: "toggle", key: "highlight", name: "Highlight changes", default: true, description: "Briefly tints slots that gain (green) or lose (red) items." },
    { type: "toggle", key: "hideInScreens", name: "Hide in inventories", default: true, description: "Hidden while an inventory or container screen is open." },
    {
      type: "keybind", key: "holdKey", name: "Hold to show", default: -1,
      description: "When set, the HUD only appears while this key is held. Right-click to clear.",
    },
    { type: "select", key: "style", name: "Slot style", options: ["Modern", "Vanilla", "None"], default: "Modern" },
    { type: "slider", key: "scale", name: "Scale", min: 0.5, max: 2, step: 0.25, default: 1, unit: "x" },
    { type: "toggle", key: "background", name: "Background", default: true },
  ],
  setup(f) {
    f.on("tick", () => track(f));
    f.on("worldUnload", reset);
  },
  onDisable: reset,
  hud: { size: measure, render, scaleKey: "scale", default: { ax: 1, ay: 1, dx: -6, dy: -6 } },
});

module.exports._test = { track, reset, flashes, measure };
