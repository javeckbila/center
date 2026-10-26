// Frame-deferred callbacks driven by a step trigger.
// Client.scheduleTask (and everything in CT built on it, like Gui.open and
// Client.currentGui.set/close) never runs its callbacks on this build/client,
// so center schedules its own work here instead.
const log = require("./log");

const queue = [];

// Runs fn after `frames` rendered frames (default 1), on the render thread.
function defer(fn, frames) {
  // typeof guard: in CT's Rhino (opt 9) `undefined > 0` evaluates to true.
  queue.push({ fn, wait: typeof frames === "number" && frames > 0 ? frames : 1 });
}

register("step", () => {
  if (!queue.length) return;
  const due = [];
  for (let i = queue.length - 1; i >= 0; i--) {
    if (--queue[i].wait <= 0) due.unshift(queue.splice(i, 1)[0]);
  }
  due.forEach(item => {
    try { item.fn(); } catch (error) { log.error("deferred task", error); }
  });
}).setFps(60);

module.exports = { defer };
