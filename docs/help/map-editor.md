---
id: map-editor
title: Map editor
group: Robot
order: 55
icon: la-pencil
summary: Waypoints, paths, obstacles, barriers and mowing zones of the active map.
ui: [editor]
related: [mapping, programs, routes]
keywords: [editor, zone, zones, waypoint, path, obstacle, barrier, free, geofence, polygon, cut height, rpm, spacing]
---
# Map editor

**Map › Map › Edit map** (✎ next to the active map) opens the editor: the map from above, the
tools in a grid, lists of what exists. The robot stays drivable while you edit. **Close editor**
or **✕** returns to the Map panel.

## Tools

| Tool | How |
|---|---|
| **Pan** | drag and zoom the map |
| **Waypoint** | click to place, type a name and a heading (0–359.5°, an orange arrow), **Save**. Click an existing dot to select it, then move or delete it |
| **Path** | click points, then **Finish** |
| **Obstacle (area)** | at least 3 points, **Finish** — the robot will not drive there |
| **Free (clear area)** | marks an area as drivable (removes a false obstacle) |
| **Barrier (line)** | a virtual line the robot must not cross; width 0.02–2 m (default 0.10) |
| **Delete** | click an edit to remove it |
| **Geofence** | click the perimeter, then **Send proposal** — see below |

**Show** switches the editor layers on and off: waypoints, paths, edits, zones. Saved edits
update the map and the zone paths within a few seconds.

## Waypoints DOCK and UNDOCK

DOCK and UNDOCK are ordinary named waypoints — you can move them here like any other. Their
meaning is described in [Dock and undock](dock.md#the-points). The easiest exact way to set them
is still to drive the robot there and press **Update** in **Map › Dock**.

## Zones (what to mow)

1. **Zones › New zone**, draw the polygon on the map.
2. Set **Name**, **Cut height** (mm, 20–65, default 45), **RPM** (600–4000, default 3300),
   *Paths around obstacles* (2), *Coverage angle* (160°), *Path spacing* (0.2 m) and *Simplify*
   (0.1 m).
3. **Save** — the planner computes the mowing paths and confirms; the status shows when it is
   done.

Zones regenerate automatically after map edits. A [program](programs.md) then lists which zones
to mow.

## Geofence

A geofence is a hard boundary for the agent's missions. The editor only **proposes** one: the
proposal is saved unsigned, and a person must sign it on the robot (command line) before it
becomes the active fence. A ring that crosses unmapped space is rejected; the minimum area is
4 m². A geofence is used only when the owner decides so.
