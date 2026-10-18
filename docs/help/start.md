---
id: start
title: Vitulus in five minutes
group: Start here
order: 10
icon: la-compass
summary: What the robot is, what is where on the screen and the usual day.
ui: [support/help]
related: [safety, frame, troubleshooting]
keywords: [overview, start, beginner, screen, intro]
---
# Vitulus in five minutes

Vitulus is an autonomous lawn mower. It lives in a **dock** (a charging station it reverses into),
finds its position with **RTK GPS**, the lidar and its wheels, drives on a **map** of your garden and
mows **zones** of that map by **programs** that a **calendar** starts. This screen is its web UI —
the same page on a PC, a tablet and a phone.

![The C frame of the UI](img/frame.svg)

1. **Navbar** — the status icons (green = OK, orange = warning, red = fault, grey = no data,
   see [Status icons](status-icons.md)), **?** = this help, the bell = **Needs you**.
2. **Menu band** — opens one tool at a time in the left panel: Panel (show / hide), Marker,
   Settings, Map, Programs, Agent, Support.
3. **Left panel** — the open tool. Its head has a small **?** that opens the help for that panel
   and the tab you are on.
4. **Map** — the robot (orange), its path, the map layers.
5. **Right panel** — speed, Dock / Undock, the localization state and the camera.
6. **Log** — what the robot did and said ([more](frame.md#log)).
7. **Joystick** — drive by hand ([more](frame.md#drive-by-hand-joystick)).
8. **STOP** — always bottom left. Stops all motion ([Safety](safety.md)).

## The usual day

```flow
ok: Docked | charging, motors off
Undock | out of the dock, waits for RTK
Mow | a program drives the zones
Dock | back by map, then reverses in
ok: Charge | until the next run
```

The calendar starts programs by itself (when automation is on and Hold is off) — see
[Programs and calendar](programs.md). When the robot does not start, it usually *waits* for
something on purpose: [Why the robot waits](waiting.md).

## First steps

1. Look at the status icons: battery, GPS and motors. Grey icons mean the robot's stack is still
   starting or not connected.
2. Open **Map** and check that a map is **active** (its card says *active*). Without an active map
   the robot cannot navigate or mow — [Maps and mapping](mapping.md).
3. Drive the robot out with **Undock** in the right panel — [Dock and undock](dock.md).
4. Try a short drive with the [Marker](routes.md#send-a-goal-with-the-marker) or the joystick.
5. Ask the [Vitulus agent](agent.md) in plain words when you are not sure.

## How to use this help

- **?** in the head of any panel opens the topic of that panel (and of its open tab).
- **?** in the navbar does the same on a PC; on a phone use the **?** in the panel head or
  **Support › Help**.
- Type into **Search help** — it looks in every topic, with or without diacritics.
- Links like [Troubleshooting](troubleshooting.md) jump between topics, **‹** goes back,
  **Esc** or **✕** closes the help. The map and the panel stay usable while help is open.

> [!NOTE]
> This help is also the robot's documentation: every topic is a Markdown file in
> `vitulus_ui/docs/help/` and the UI shows exactly that file. A change of the UI or of the robot
> updates the file in the same commit.
