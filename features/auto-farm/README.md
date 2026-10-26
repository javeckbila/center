# Auto Farm

Stand on the crop bed and run `/af generate` (or **Generate crop route** in
the Auto Farm settings). It detects the crop under your feet and scans its
connected, loaded bed, including adjacent terraces one block up or down.
Put a usable hoe in your hotbar, then `/af start`. Starting selects the closest
waypoint in three dimensions and continues the saved order from there.

Generated loops use up to six long interior passes, typically **10–15 waypoints
on a large open bed**. Connections use cardinal neighbors with full player-box
clearance, solid support and jump headroom;
water, bare aisles, different crops, tall walls, low ceilings and deeper drops
cannot become connectors. The closing leg returns through the same checked
crop graph, including detours around obstacles. Straight runs keep only their
endpoints, including runs crossing one-block terraces; the controller handles
those jumps along the run. Detours prefer fewer turns over slightly shorter
zigzags. **Newly generated loops never exceed 15 waypoints.** If obstacle bends
exceed the budget, the planner retries fewer passes, keeping every required
turn. If even one pass cannot form a safe compact loop, generation fails and
keeps the previous route. Rows shorter than 60% of the longest available row
are excluded. A one-pass fallback uses the longest row, never the first edge
stub. Passes must span at least eight blocks on a large scanned bed (scaled
down for small beds, with a minimum of two). Irregular beds can require
retracing crop tiles.

Every tile along the saved loop has a **two-row crop buffer in all horizontal
directions**, including turns and the return leg. Border rows, narrow aisles
and crop tiles immediately beside walls are excluded. The planner checks all
interior regions and uses the largest one with useful farming span; distance
from the player breaks ties. A tiny pocket beside the player cannot hide the
main bed. Beds narrower than
five crop tiles, or regions joined only by a narrow neck, may lack room for
the sweep. Lane spacing favors long runs and a small waypoint list; six passes
do not guarantee harvesting every planted tile of a very wide farm per lap.

Scanning and route construction run in small main-thread tick slices (up to
64 work items or about 6 ms per slice). Up to 32,768 reachable crop tiles are
supported; older larger saved routes remain readable. A scan touching unloaded chunks or
exceeding the limit fails instead of saving an incomplete loop. Failed or
canceled generation keeps your previous route. `/af status` shows progress;
`/af stop` cancels. Generating does not move the player or start farming.

Generated-route startup finds a crop-only approach to the closest waypoint,
so an intervening wall cannot become a straight shortcut. Start on the same
connected crop bed. Corners use tighter arrival checks and momentum braking
to keep the player inside narrow rows. The actual direction is checked again
between movement ticks, and generated routes only attack the detected crop.
Generation checks the world as scanned; later obstacles still pause farming.
Crop coverage describes planted tiles when scanning, not guaranteed regrowth:
harvested crops must regrow or be replanted by the server/player for continuous
yield. The module does not automate planting.

Manual routes remain available with `/af add` (up to 256 points). Keep every
manual segment, including the closing leg, directly walkable; automatic wall
detours and crop-only validation apply to generated routes. Generated loops
cannot be edited point by point because removing a corner could create an
unchecked shortcut. Regenerate, or clear the route to record a manual one.

| Command | Action |
| --- | --- |
| `/af generate` | Generate a checked loop for the crop bed under your feet. |
| `/af add` | Append your current position. |
| `/af remove` | Remove the last waypoint. |
| `/af remove 2` | Remove waypoint 2 and renumber the remaining points. |
| `/af clear` | Clear the route. |
| `/af` or `/af toggle` | Toggle farming. |
| `/af start` / `/af stop` | Explicitly start / stop. |
| `/af status` / `/af list` | Show state / route coordinates. |
| `/af help` | Show command help. |
| `/af save wheat` | Save the current waypoints and farming settings as `wheat`; repeat to update it. |
| `/af load wheat` | Restore that config with farming stopped. |
| `/af configs` | List saved config names. |
| `/af delete wheat` | Delete that saved config, keeping the current route. |

`/auto-farm` and `/autofarm` are aliases. In **/center → Automation → Auto Farm**,
configure the downward **Look pitch** (default 20°), sweep width, sweep time,
sprint, waypoint chams, HUD and toggle key. Move or scale the HUD with
`/center hud`. Waypoints appear as translucent numbered boxes through walls;
the next waypoint is gold. Markers within 256 blocks remain visible while
farming is off. **Sweep time** defaults to **0.5 seconds from one side to the
other** (one second for a complete back-and-forth). Existing full-cycle timing
settings are converted automatically to these units.

The sweep stays centered on each route segment. Movement compensates for the
camera angle, slows out of sprint near endpoints, and recognizes waypoints
crossed between ticks so it can continue into the next segment. Laps count
when returning to the starting waypoint, including when starting mid-route.

Approaching a lower crop layer automatically increases the downward pitch to
aim above its soil within interaction reach. It eases back to **Look pitch**
after descending or leaving the edge; the horizontal sweep continues normally.
This follows the existing one-block drop limit.

Named configs also have **Config name**, **Save config**, **Load config**, and
**Saved configs** controls in the Auto Farm settings. Names allow 1-32 letters,
numbers, underscores or hyphens; up to 32 configs are saved. Each snapshot
keeps its route's server/save and dimension. Loading never starts the macro.
Toggle keys and HUD position remain your shared Auto Farm preferences.

Routes and settings are stored in the user's uncommitted `config.json`.
Changes to settings and named saves are written immediately and survive reloads.
Routes are bound to their server or singleplayer save and dimension. Clear
the route before recording in a different world. Farming always loads off.
Server rubber-banding near the route rejoins the appropriate segment and
resets the progress check. A correction never counts as walking through a
waypoint. This also works on the initial approach to the loop. Corrections
must remain within 3 horizontal blocks and 2 vertical blocks of a route leg
or the initial approach; displacement farther away stops farming.

Unloaded chunks, water, riding, item use and a paused game release the macro's
inputs and wait until farming can resume. No movement on clear ground retries
the waypoint after a short rest instead of disabling the macro during server
lag. A wall or low ceiling gets 15 seconds to clear; prolonged loss of ground
support also stops farming. Client freezes do not consume these recovery
deadlines. Starting while airborne or holding keys waits for landing/release.
The HUD and `/af status` show the reason while waiting.

Opening a screen remains an immediate manual stop. Changing worlds, death,
spectator mode, lava, losing all usable hoes, unsafe drops and persistent
impassable obstacles stop farming and release its inputs. Auto Farm and Auto
Miner cannot control the player simultaneously.

While running, Auto Farm switches to third-person perspective and disables
pause on lost focus. Mouse movement orbits the view without changing the
farmer's aim or steering. Stopping restores both previous options. This is
shared with Auto Miner and requires a full Minecraft restart after installing
the camera/mouse mixins; `/ct load` alone cannot install them.

The controller uses vanilla attack and automatically selects a usable
hotbar hoe, switching to a spare before its final durability point. It restores
the previous hotbar slot when stopped. Crops are harvested using ordinary
block attacks; planting is not automated.
