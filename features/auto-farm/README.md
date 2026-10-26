# Auto Farm

Add at least two waypoints while standing on your farm, put a hoe in your
hotbar, then start Auto Farm. It visits points in order and closes the loop
from the last point back to the first. Keep each segment directly walkable;
the controller anticipates one-block obstacles with jump clearance, but does
not find detours around walls.

| Command | Action |
| --- | --- |
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
crossed between ticks so it can continue into the next segment.

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
Opening a screen, changing worlds, losing all usable hoes, becoming stuck,
or encountering unsafe ground stops farming and releases its inputs. Auto
Farm and Auto Miner cannot control the player simultaneously.

The controller holds vanilla attack and automatically selects a usable
hotbar hoe, switching to a spare before its final durability point. It restores
the previous hotbar slot when stopped. Crops are harvested using ordinary
block attacks; planting is not automated.
