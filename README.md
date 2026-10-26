# Center

Open `/center` or press Right Shift to configure the built-in features.

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

Personal settings and routes are stored in the uncommitted `config.json`.
See [Auto Farm](features/auto-farm/README.md) for waypoint and config commands.

## Auto Miner player avoidance

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
