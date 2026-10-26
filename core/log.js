// Logs to the CT console and to the game log (latest.log) so problems are
// visible even when /ct console is not open.
const Out = Java.type("java.lang.System");

function log(message) {
  const line = `[center] ${message}`;
  try { console.log(line); } catch (error) { /* console unavailable */ }
  try { Out.out.println(line); } catch (error) { /* stdout unavailable */ }
}

function error(message, err) {
  // Note: CT's Rhino crashes on template literals nested inside template literals.
  let line = "[center] " + message;
  if (err) line += ": " + err + (err.stack ? "\n" + err.stack : "");
  try { console.error(line); } catch (e) { /* console unavailable */ }
  try { Out.out.println(line); } catch (e) { /* stdout unavailable */ }
}

module.exports = { log, error };
