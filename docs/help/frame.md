---
id: frame
title: The screen (frame, panels, log, joystick)
group: Using the UI
order: 100
icon: la-columns
summary: The C frame — left panel, top and bottom bar, right panel, log, joystick, camera and its overlays, phone vs PC.
ui: [frame, log#log, drive#drive-by-hand-joystick, camera#camera]
related: [start, status-icons, settings]
keywords: [frame, layout, panel, hide, full screen, expand, sheet, bottom bar, right panel, log, joystick, keyboard, wasd, camera, follow, phone, mobile, desktop, shortcut, alt+p, esc, overlay, lidar, depth, obstacles, free, point cloud, opacity]
---
# The screen

The UI is one frame in the shape of a **C** around the map: the top band (navbar, agent strip,
menu band), the left panel and the bottom bar are one surface. The right panel, the log and the
joystick grow out of the same frame.

![The C frame of the UI](img/frame.svg)

## The left panel

The menu band opens one tool at a time in the left panel: **Marker**, **Settings**, **Map**,
**Programs**, **Agent**, **Support**. The open one is lit.

| Do | PC | Phone |
|---|---|---|
| hide / show the panel | **Panel** in the menu band, **Alt+P**, **Esc** (hide), **✕** | **Panel**, **✕**, drag the sheet down |
| full screen | **⤢** in the head | drag the sheet up / tap its grip |
| help for it | **?** in the head | **?** in the head |

A hidden panel leaves a thin spine on the left edge — click it to bring the panel back. The UI
remembers which panel was open (also across a reload).

**PC** (≥ 1024 px wide): the panel is a column, the map narrows next to it. **Tablet / phone on
its side**: the column lies over the map. **Phone upright** (< 576 px): the panel is a sheet from
the bottom (60 % of the height). On a phone (upright or on its side) a compact head puts
**?** / ⤢ / ✕ (in the Agent panel also its STOP) at the end of the tab row; upright the title moves into the grip row.

**Tabs that do not fit** (a narrow panel, a phone, longer Czech labels) stay in one row that
scrolls sideways: a **‹** / **›** at the edge shows there are more — click it, turn the mouse wheel
over the row or swipe it with a finger. The tab you pick (and the open one, whenever the panel
opens) slides fully into view; with the keyboard **←** / **→** move between tabs.

![The UI on a phone held upright, no panel open, with numbered markers](img/shot-phone.webp "Phone, no panel: 1 Needs you · 2 menu band · 3 status icons · 4 map · 5 right panel (one row, ▾ unfolds it) · 6 STOP · 7 Joystick, Follow, Log") ![The UI on a phone with the Map panel open as a sheet from the bottom, with numbered markers](img/shot-phone-sheet.webp "Phone, Map panel open: 1 title (drag the grip) · 2 tabs · 3 ? help · 4 ⤢ full screen · 5 ✕ close")

## The bottom bar

![The bottom bar: the red STOP on the left, then Joystick, Follow and Log](img/shot-bottom-bar.webp "The bottom bar on a PC, left to right: STOP · Joystick · Follow · Log")

**STOP** · **Joystick** · **Follow** · **Log** (on a phone with a free gap in the middle for the
system gesture). **STOP** is always bottom left, never moves and never shrinks
([Safety](safety.md#stop)). **Follow** makes the map view follow the robot.

## The right panel

Hangs from the top band on the right edge:

- **Controls** — speed Slow / Mid / Fast, keyboard driving, the battery and **Dock / Undock /
  Stop** ([Dock and undock](dock.md)).
- **Navi** — the localization state ([what the chips mean](localization.md#read-the-state-right-panel--navi)).
- **Camera** — see below.

Each section folds by its title. On a phone (upright or on its side) the right panel is a
collapsed row (map, pose, GNSS, battery, camera, ▾) — ▾ unfolds it.

![The Controls section of the right panel with numbered markers](img/shot-controls.webp "Controls: 1 speed Slow / Mid / Fast · 2 keyboard driving · 3 battery · 4 Dock · 5 Undock · 6 Stop (of the dock sequence)") ![The Navi section of the right panel with numbered markers](img/shot-navi.webp "Navi: 1 who owns the pose · 2 heading source · 3 odometry chips · 4 GNSS fix · 5 satellites · 6 position accuracy · 7 heading accuracy — explained in Localization")

## Camera

![The Camera section of the right panel with the overlays menu open, numbered markers](img/shot-camera-layers.webp "1 Off / S / L · 2 the layers button · 3 Lidar · 4 Obstacles · 5 Free · 6 Depth · 7 Opacity")

The switch **Off / S / L** in the head of the Camera section: **S** = a small live picture in the
right panel, **L** = the camera fills the map area and the map moves into the right panel's slot
(click the small map to go back). **Alt+C** switches S ↔ L. The stream runs only while the camera
is on screen. On a phone the camera button in the collapsed row switches the large camera on and
off.

### Camera overlays

The layers button in the top right corner of the camera picture (S and L) opens the overlays.
Each one is a switch; any mix can be on:

- **Lidar** (azure) — the lidar scan: a line of points where the lidar beam hits something at
  the lidar's height.
- **Obstacles** (red) — what the depth camera's obstacle detection sees as an obstacle (this is
  what the robot plans around).
- **Free** (green) — ground the same detection sees as free and drivable.
- **Depth** — the depth camera's distance picture over the image: red = near, yellow / green =
  middle, blue = far (about 5 m); no colour = no depth there (sky, glare, too far).

![A schematic camera picture with the overlays: lidar points, obstacle points, free ground points, and the depth colours](img/camera-overlays.svg "Schematic: 1 lidar points where the beam hits the wall, the post and the box · 2 obstacles (the box) · 3 free ground · 4 depth: red near → yellow → green → blue far · 5 no colour = no depth (sky)")

**Opacity** sets how strongly all overlays cover the picture. Points nearer to the robot are drawn
bigger. The choice is remembered in this browser.

The robot itself puts the points into the picture (node `camera_overlay` in `vitulus_ui`): it uses
the camera's calibration and the position of each sensor at the moment it measured, so a point
sits on the thing it measured even while the robot turns — like the camera view in RViz. It works
only while a layer is on and the camera is shown; with every layer off it does nothing.

- **A layer is on but nothing shows** — no data right now (an empty obstacle list is normal on an
  open lawn; the lidar shows only where the beam hits something within the picture), or the
  overlay service is not running yet (it starts with the robot's software).
- **Points slightly off the edges of things** — a few pixels is normal (sensor mounting
  tolerance); a large, constant shift means the sensor positions in the robot model need a
  calibration. Measured 18. 10. 2026 (robot in the dock): lidar points sit about 10 px left of
  edges 3–4 m away, within a few pixels at 1 m — not yet enough to change the robot model; a
  check outdoors in front of a wall / posts decides it (tool `tools/overlay_extrinsics.py`).
- **Depth colour vs lidar at distance** — the depth camera reads a little too far the farther it
  looks: about +1 cm at 1 m, +5 cm at 2 m, +18 cm at 4 m (stereo calibration of the camera, not
  the robot model). The lidar distance is the right one; the camera's on-chip calibration
  (RealSense self-calibration / tare) fixes the depth.

## Drive by hand (joystick)

**Joystick** in the bottom bar shows the stick in the bottom right of the map (on a phone it stays
above an open sheet).

![The web joystick with numbered markers: speed mode, motor state, the stick and the speed readout](img/shot-joystick.webp "1 speed mode · 2 drive motors (here OFF — nothing moves) · 3 the stick · 4 the speed it sends")

- Push to drive: forward / back = speed, sideways = turn. Near the centre it is fine, at the rim
  full speed (of Slow / Mid / Fast). **Let go = stop.**
- It shows the speed mode and whether the drive motors are on — **with motors OFF nothing
  moves** (switch them on in Settings › Motors).
- Keyboard: tick the box next to the keyboard icon in the right panel's **Controls**, then
  **W A S D** or the arrows, **Shift** = half speed. Never while typing in a field.

> [!WARNING]
> Pushing the joystick takes over from the software: it **cancels** the navigation goal, docking
> and a running program, and after you let go the robot stays. Only the DS4 gamepad ranks higher
> ([Safety](safety.md#the-gamepad-ds4-and-the-joystick-beat-the-software)).

## Log

![The log expanded over the map, with its toolbar and numbered markers](img/shot-log.webp "The expanded log: 1 Changes · 2 ROS · 3 Live · 4 Clear · 5 ▼ Collapse · 6 ? help")

**Log** in the bottom bar shows the log as a strip above the bar. **▲** (expand) makes it fill
the map area, **▼** (collapse) shrinks it back; **Log** again hides it. The joystick always stays
above the small log.

The full log has a toolbar:

- **Changes** — the useful robot events: a green dot = something got better, orange = a warning,
  red = a fault; connection changes and agent reports.
- **ROS** — the raw robot console with level filters, a node filter and text search.
- **Live** pauses / resumes autoscroll, **Clear** empties the log in this browser only.

## Keyboard shortcuts (PC)

| Key | Does |
|---|---|
| **Alt+P** | show / hide the left panel |
| **Esc** | close the help; hide the left panel (not while typing, a dialog or the full log is open) |
| **Alt+C** | camera small ↔ large |
| **W A S D**, arrows | drive (with the keyboard box ticked in the right panel), **Shift** = half speed |
