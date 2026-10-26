// Key names and typed-character helpers.
// CT's Gui reports key presses only (keyCode + char derived from the GLFW key),
// so shifted symbols are mapped here using the US layout.
const NONE = -1;

let KeySym = null;
try {
  KeySym = Java.type("com.mojang.blaze3d.platform.InputConstants$Type").KEYSYM;
} catch (error) {
  KeySym = null;
}

const names = new Map();

function name(code) {
  if (typeof code !== "number" || code < 0) return "None";
  if (names.has(code)) return names.get(code);
  let label = null;
  try { if (KeySym) label = String(KeySym.getOrCreate(code).getDisplayName().getString()); } catch (error) { label = null; }
  if (!label) {
    try { label = Keyboard.getKeyName(code); } catch (error) { label = null; }
  }
  label = label ? String(label) : `Key ${code}`;
  if (label.length === 1) label = label.toUpperCase();
  names.set(code, label);
  return label;
}

const SHIFTED = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~",
};

// Returns the printable character for a key press, or null.
function typedChar(ch, code) {
  if (code >= 320 && code <= 329) return String(code - 320); // keypad digits
  const c = ch == null ? "" : String(ch);
  if (code < 32 || code > 96 || c.length !== 1) return null;
  if (Keyboard.isShiftKeyDown() && SHIFTED[c]) return SHIFTED[c];
  return c;
}

// Keys a screen has already handled (e.g. the menu key that closed the menu).
// The key poller ignores them until they are released, so the same press does
// not also count as a fresh in-game press once the screen is gone.
const consumed = new Set();

function consume(code) { if (typeof code === "number" && code >= 0) consumed.add(code); }

// For the poller: true while `code` is a consumed press that is still held.
function isConsumed(code, down) {
  if (!consumed.has(code)) return false;
  if (!down) consumed.delete(code);
  return true;
}

module.exports = { NONE, name, typedChar, consume, isConsumed };
