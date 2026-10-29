# Center

Open `/center` or press Right Shift to configure the built-in features.

## Auto Reconnect

Enable **Auto Reconnect** under **Automation**, or use
`/center on auto-reconnect`. Its switch and settings persist across reloads.
Defaults target **inkmc.pl / GenBlock**; the mode-server name is **Gblock**.
It uses your existing premium Minecraft session and never sends `/login`.

On connection loss, retries start after 10 seconds and back off to 60 seconds.
After joining, Center waits for the lobby selector, matches the mode by its
name or lore, clicks once, and waits for the server to confirm the selected
mode. Failed menu opens/transfers are retried. Returning to the lobby after a
mode restart also triggers mode selection.

Anti AFK, Auto Miner and Auto Farm keep their enabled switches during
recovery. Their inputs are released while offline, in limbo or in the lobby;
they resume only after the chosen mode is loaded. Turning a feature off
during recovery keeps it off. Existing tool/route checks still apply when
mining or farming resumes; Auto Reconnect does not teleport you to a farm.

Leaving the disconnect screen or canceling connection attempts cancels the
recovery and stops paused automation. Deliberately disconnecting does not
reconnect you. Other servers and singleplayer are left alone.

Run `/ct load` to apply this update; no new mixins or game restart are required.
Automation switches still start off on a full module reload/game restart;
their reconnect preservation applies within the current loaded session.

## Anti AFK

Enable **Anti AFK** under **Automation**, or use `/center toggle anti-afk`.
By default, every four seconds it turns slightly, takes a brief side step,
jumps, crouches, and taps attack at the crosshair. Turns and side steps
alternate directions. Set the interval (2–30 seconds), turn angle, and each
action separately in the menu. Attack can hit entities or break blocks.

Screens and manual controls pause the actions; closing the screen or releasing
the controls starts a fresh interval. While active it disables pause on lost
focus, then restores your preference when paused or stopped. Switching between
Anti AFK, Auto Miner and Auto Farm stops the previous automation. Anti AFK stops
on disconnect/world unload unless Auto Reconnect is managing recovery. It
always loads disabled after a module reload or game restart.
Use `/center off anti-afk` or its assigned toggle key to stop it.
Reload with `/ct load` to add the feature; this change adds no mixins.

## Inventory HUD

Enable **Inventory HUD** under **Render** to see your 27 main inventory slots
on screen, with stack counts and durability bars. By default it sits in the
bottom-right corner; drag or scale it with `/center hud`. Optional rows add the
hotbar (selected slot highlighted) and your armor and offhand. The title shows
how many of the 36 inventory and hotbar slots are empty, or **Full**.

Slots that gain items briefly turn green, slots that lose items turn red, and
a slot swapped for a different item uses the accent color. Changes made while
an inventory or container is open are not highlighted, and by default the HUD
is hidden there. Set **Hold to show** to a key to display it only while that
key is held. Slot style can be Modern, Vanilla or None.
Reload with `/ct load` to add the feature; this change adds no mixins.

## Automation perspective

Once Auto Miner or Auto Farm actually starts, Center switches to rear third
person and disables pause on lost focus. Move the mouse to orbit around the
player. This view has independent yaw and pitch: it does not change the
automation's aim, block targeting, or movement direction. Vanilla sensitivity,
mouse inversion, smooth camera, and third-person wall collision still apply.

Stopping automation, opening a screen, leaving the world, or unloading Center
restores your previous perspective and pause-on-lost-focus preference. Failed
starts and waiting for the startup screen to close leave those options alone.
F5 stays in rear third person while automation owns the view.

**Restart Minecraft after installing this version or changing `mixins.js`.**
`/ct load` can reload ordinary code, but cannot install these camera/mouse hooks
into an already running game.
If loaded before that restart, Center and its automations remain available
with your normal view. A reminder appears on the first automation start;
pause on lost focus is still disabled for the run and restored on stop.

Personal settings, HUD positions, routes, and named farm configs are stored in
`config/ChatTriggers/center/config.json`, relative to the Minecraft game folder.
This is outside `modules`, so deleting or reinstalling Center preserves them.
On the first load after updating, Center automatically copies the old
`modules/center/config.json` here if the new file does not already exist.
The old file is kept as a backup; future changes save only to the new location.
Run `/ct load` after updating to migrate before deleting the module.
See [Auto Farm](features/auto-farm/README.md) for waypoint and config commands.

## Auto Miner

Turns accelerate and brake smoothly, with a steady aim while breaking each
block. Purple, red and lime glazed terracotta use faster turns automatically,
as do other blocks that the held tool can break instantly. The **Glide** setting
still controls overall turn speed: higher is slower, lower is faster.
Latency affects the lead toward the next slow block, not camera turn speed.
Mining progress and cooldowns remain controlled by Minecraft.

Reload with `/ct load` to apply the mining changes; no new mixins are needed.

### Player avoidance

Auto Miner skips aim points blocked by another player and releases attack if
someone steps into its mining ray. When a player overlaps you, it walks one
block in a clear direction and resumes mining there. It returns to the original
starting position if that player follows into you, after the area clears for
one second, or when the eight-second sidestep timer expires. Walls, unsafe ground and
occupied destinations prevent a sidestep; normal walk-home safety checks apply.
Sidesteps and their return follow the direct path without long detours. A
blocked path waits, and outward movement is bounded near the one-block target.
Recovery can jump back onto a starting spot one block higher when there is
headroom and a clear landing.
The original starting floor is preserved while mining from the temporary spot.
Reload with `/ct load` to apply this update.

## Checks

From the ChatTriggers modules folder, run:

```powershell
powershell -File center/tests/run.ps1
```

The suites use CT's bundled Rhino with mocked Minecraft/CT APIs. They cover
automation behavior and perspective lifecycle/input isolation; visual camera
behavior must also be checked in Minecraft after restarting.
