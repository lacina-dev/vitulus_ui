---
id: map-editor
title: Map editor
group: Robot
order: 55
icon: la-pencil
summary: Select, reshape and name the waypoints, paths, obstacles, barriers and mowing zones of the active map.
ui: [editor]
related: [mapping, programs, routes]
keywords: [editor, zone, zones, waypoint, path, obstacle, barrier, free, geofence, polygon, shape, vertex, point, select, undo, rename, cut height, rpm, spacing]
---
# Map editor

**Map › Map › Edit map** (✎ next to the active map) opens the editor: the map from above, the
tools in a grid, lists of what exists (**Map edits**, **Waypoints**, **Paths**, **Zones**). The
robot stays drivable with the joystick while you edit. The expand button widens the editor; **Close editor** or **✕**
returns to the Map panel.

![The map editor with numbered markers](img/shot-editor.webp "1 tools · 2 Show (layers of the editor) · 3 the selected object and what the chosen tool needs · 4 lists: edits, waypoints, paths, zones · 5 Close editor · 6 the map you draw on")

## Tools

| Tool | How |
|---|---|
| **Select** | tap an object on the map or in its list. Drag moves the map, pinch or the wheel zooms |
| **Waypoint** | tap to place, type a name and a heading (0–359.5°, an orange arrow), **Save** |
| **Path** | tap points, then **Finish** |
| **Zone** | a new mowing zone, see [Zones](#zones-what-to-mow) |
| **Obstacle (area)** | at least 3 points, **Finish** — the robot will not drive there |
| **Free area (clear)** | marks an area as drivable (removes a false obstacle) |
| **Barrier (line)** | a virtual line the robot must not cross; width 0.02–2 m (default 0.10) |
| **Delete** | tap an edit (obstacle, free area, barrier) and it is gone at once, without a question |
| **Geofence** | click the perimeter, then **Send proposal** — see below |

**Show** switches the editor layers on and off: waypoints, paths, edits, zones. A hidden layer
cannot be selected on the map. Saved edits update the map and the zone paths within a few seconds.

While you draw, **Undo** takes back the last point. The points behave as described below.

On a phone the panel shrinks to the essentials while you work on the map. The **^** button at its
top right brings back the tools, lists and details.

## Select and reshape

Tap anything you can see: a zone, obstacle, free area, barrier, path or waypoint. It is selected
on the map and in its list at the same time, and the card in the panel shows its name, size and
actions. A pick from a list also brings the object into view. Where objects overlap, tap again to
go to the next one.

The points of the selected object appear at once:

| To | Do |
|---|---|
| move a point | drag it |
| add a point | tap a white dot on an edge, or drag it to where the point belongs |
| delete a point | tap the point (it turns yellow), then **Delete point**. With a mouse also Shift+click or the Delete key |
| move a waypoint | drag it, and set the **Heading** in the card |
| change the width of a barrier | **Barrier width** in the card |

Nothing reaches the robot until you press **Save**, which appears with the first change. **Undo**
goes back step by step (Ctrl+Z with a keyboard), **Cancel** returns to the saved shape. While a
change is open, other objects and tools wait until you save or cancel. Closing the editor with a
change asks for a second press and then discards it.

An outline that crosses itself cannot be saved. A polygon keeps at least 3 points, a line 2.
The card's **Delete** removes the whole object: press it twice.

## Names

Every object has a name: obstacle, free area, barrier, waypoint, path and zone. A new object gets
one automatically (**Obstacle 1**, **Free area 2**, **Waypoint 1**…), and you can type your own
before saving. The ✎ pencil in the card of the selected object renames it later, the same way
for every type.

- A name must be unique within its type, up to 60 characters. Spaces and accents are fine.
- A renamed zone stays in its programs. It cannot be renamed while a mission that uses it is running.
- **DOCK**, **UNDOCK** and **docked** keep their names.
- The agent knows objects by these names, so a good name (*Pool*, *Fence by the neighbours*) is
  what you and the agent will both use.

## Waypoints DOCK and UNDOCK

DOCK and UNDOCK are ordinary named waypoints — you can move them here like any other. Their
meaning is described in [Dock and undock](dock.md#the-points). The easiest exact way to set them
is still to drive the robot there and press **Update** in **Map › Dock**.

## Zones (what to mow)

1. The **Zone** tool (or **Zones › New zone**), tap the polygon on the map. The first, blue point
   is where mowing starts.
2. Set **Name** and, in **Mowing settings**: **Cut height** (mm, 20–65, default 45), **RPM** (600–4000, default 3300),
   *Paths around obstacles* (2), *Coverage angle* (160°), *Path spacing* (0.2 m) and *Simplify*
   (0.1 m).
3. **Finish** — the planner computes the mowing paths and confirms; the status shows when it is
   done.

An existing zone is selected like any other object, and its mowing paths are shown. **Mowing
settings** are in the card. The card says which programs use the zone.

Saving a new shape recomputes the mowing paths and updates every [program](programs.md) that uses
the zone, so the programs keep working. The planner refuses the save, and keeps the old zone, when
a running program uses the zone, when the programs of the map are still loading, or when the new
shape leaves no mowing path. The card shows the reason and your change stays open.

Zones regenerate automatically after map edits. A [program](programs.md) then lists which zones
to mow.

## Geofence

A geofence is a hard boundary for the agent's missions. The editor only **proposes** one: the
proposal is saved unsigned, and a person must sign it on the robot (command line) before it
becomes the active fence. A ring that crosses unmapped space is rejected; the minimum area is
4 m². A geofence is used only when the owner decides so.
