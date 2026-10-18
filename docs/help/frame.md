---
id: frame
title: The screen (frame, panels, log, joystick)
group: Using the UI
order: 100
icon: la-columns
summary: The C frame — left panel, top and bottom bar, right panel, log, joystick, camera, phone vs PC.
ui: [frame, log#log, drive#drive-by-hand-joystick, camera#camera]
related: [start, status-icons, settings]
keywords: [frame, layout, panel, hide, full screen, expand, sheet, bottom bar, right panel, log, joystick, keyboard, wasd, camera, follow, phone, mobile, desktop, shortcut, alt+p, esc]
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
the bottom (60 % of the height); a compact head puts STOP / ⤢ / ✕ at the end of the tab row and
the title in the grip row.

## The bottom bar

**STOP** · **Joystick** · **Follow** · **Log** (on a phone with a free gap in the middle for the
system gesture). **STOP** is always bottom left, never moves and never shrinks
([Safety](safety.md#stop)). **Follow** makes the map view follow the robot.

## The right panel

Hangs from the top band on the right edge:

- **Controls** — speed Slow / Mid / Fast, keyboard driving, the battery and **Dock / Undock /
  Stop** ([Dock and undock](dock.md)).
- **Navi** — the localization state ([what the chips mean](localization.md#read-the-state-right-panel--navi)).
- **Camera** — see below.

Each section folds by its title. On a phone the right panel is a collapsed row (map, pose, GNSS,
battery, camera, ▾) — ▾ unfolds it.

## Camera

The switch **Off / S / L** in the head of the Camera section: **S** = a small live picture in the
right panel, **L** = the camera fills the map area and the map moves into the right panel's slot
(click the small map to go back). **Alt+C** switches S ↔ L. The stream runs only while the camera
is on screen. On a phone the camera button in the collapsed row switches the large camera on and
off.

## Drive by hand (joystick)

**Joystick** in the bottom bar shows the stick in the bottom right of the map (on a phone it stays
above an open sheet).

- Push to drive: forward / back = speed, sideways = turn. Near the centre it is fine, at the rim
  full speed (of Slow / Mid / Fast). **Let go = stop.**
- It shows the speed mode and whether the drive motors are on — **with motors OFF nothing
  moves** (switch them on in Settings › Motors).
- Keyboard: tick *keyboard* in the right panel, then **W A S D** or the arrows, **Shift** = half
  speed. Never while typing in a field.

> [!WARNING]
> Navigation and the gamepad use the same drive input — cancel a running goal before you take
> over ([Safety](safety.md#the-gamepad-ds4-overrides-the-software)).

## Log

**Log** in the bottom bar shows the log as a strip above the bar. **▲ Expand** makes it fill the
map area, **▼ Collapse** shrinks it back; **Log** again hides it. The joystick always stays above
the small log.

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
| **W A S D**, arrows | drive (with *keyboard* ticked in the right panel), **Shift** = half speed |
