// Farm Hitboxes: crops, mushrooms and other farm plants target as full blocks.
// Only shape queries made for the local player (crosshair ray and block
// highlight) change. Collision, break particles, other entities and the
// integrated server keep vanilla shapes, so movement never desyncs.
const { defineFeature } = require("../core/registry");
const mixinHooks = require("../mixins");

const GROUPS = [
  { key: "crops", name: "Crops", description: "Wheat, carrots, potatoes, beetroots and torchflower crops.",
    blocks: ["CropBlock", "CarrotBlock", "PotatoBlock", "BeetrootBlock", "TorchflowerCropBlock"] },
  { key: "netherWart", name: "Nether wart", description: "Nether wart at every growth stage.", blocks: ["NetherWartBlock"] },
  { key: "mushrooms", name: "Mushrooms", description: "Red and brown mushrooms, plus crimson and warped fungi.",
    blocks: ["MushroomBlock", "NetherFungusBlock"] },
  { key: "cocoa", name: "Cocoa", description: "Cocoa pods. Walking into them still uses the pod's real size.", blocks: ["CocoaBlock"] },
  { key: "sugarCane", name: "Sugar cane", description: "Every sugar cane block.", blocks: ["SugarCaneBlock"] },
  { key: "sweetBerries", name: "Sweet berry bushes", description: "Sweet berry bushes at every growth stage.",
    blocks: ["SweetBerryBushBlock"] },
];

const shapeHooks = mixinHooks.farmShapes || {};
// CT returns null for injectors registered after startup (new in this version).
const needsRestart = GROUPS.some(g => g.blocks.some(b => shapeHooks[b] == null));
const EntityContext = Java.type("net.minecraft.world.phys.shapes.EntityCollisionContext");
const FULL_BLOCK = Java.type("net.minecraft.world.phys.shapes.Shapes").block();
const minecraft = Client.getMinecraft();
let reminded = false;

// Runs inside Block.getShape on any thread, so it must never throw.
function shapeFor(feature, key, original, context) {
  try {
    if (!feature.isEnabled() || feature.get(key) !== true) return original;
    // CollisionContext.empty() is also an EntityCollisionContext, with no entity.
    if (!(context instanceof EntityContext)) return original;
    const player = minecraft.player;
    return player != null && context.getEntity() === player ? FULL_BLOCK : original;
  } catch (error) {
    feature.fail(error);
    return original;
  }
}

module.exports = defineFeature({
  id: "farm-hitboxes",
  name: "Farm Hitboxes",
  category: "World",
  description: "Targets crops, nether wart, mushrooms and fungi as full blocks.",
  settings: GROUPS.map(g => ({ type: "toggle", key: g.key, name: g.name, description: g.description, default: true })),
  setup(f) {
    GROUPS.forEach(g => g.blocks.forEach(block => {
      const hook = shapeHooks[block];
      if (hook) hook.attach((self, original, context) => shapeFor(f, g.key, original, context));
    }));
  },
  onEnable() {
    if (!needsRestart || reminded) return;
    reminded = true;
    ChatLib.chat("&8[&bcenter&8]&r &eRestart Minecraft to enable Farm Hitboxes. Crop hitboxes stay vanilla until then.");
  },
});
