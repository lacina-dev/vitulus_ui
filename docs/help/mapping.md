---
id: mapping
title: Maps and mapping
group: Robot
order: 50
icon: la-map
summary: Record a new map, extend one, activate it, layers and the combined map.
ui: [map, map/map]
related: [map-editor, routes, localization, dock]
keywords: [map, site, record, recording, extend, remap, activate, deactivate, layers, combined, aerial, terrain, session, save]
---
# Maps and mapping

A **map** (a *site*) is one garden: the terrain the robot recorded, plus everything you add to
it — waypoints (DOCK, UNDOCK, …), paths, zones, map edits and the programs. The robot navigates
and mows only on the **active** map. Everything is stored in metres in real-world (UTM)
coordinates, so a map stays aligned with GPS and the aerial photo.

![A garden map from above with numbered parts: the dock, the points, zones with mowing paths, an obstacle area, a barrier, a saved path, the robot, the terrain and a wall](img/site.svg "What one map holds")

1. **The dock**.
2. The **DOCK** (orange) and **UNDOCK** (green) points in front of it
   ([Dock](dock.md#the-points)).
3. **Zones** — the areas to mow; the planner fills them with mowing paths (the stripes)
   ([Map editor › Zones](map-editor.md#zones-what-to-mow)).
4. An **obstacle area** — the robot never drives there (a flower bed, a pond).
5. A **barrier** — a line the robot must not cross.
6. A saved **path** ([Paths](routes.md#paths)).
7. **The robot** (orange) where it is now.
8. **The terrain** the robot recorded — where it can drive (Base layer).
9. A **wall** or a hedge the lidar saw (Saved layer, red).

## Which map is active

![Map › Map with numbered markers](img/shot-map-tab.webp "1 the active map · 2 Edit map · 3 Deactivate · 4 the active map's card · 5 Activate another map · 6 delete a map · 7 layers on the map · 8 Map recording · 9 Display (layers)")

**Map › Map** shows *Active map: name* at the top, and one card per saved map with chips
(*active*, *recording*, *no session*), its area, the number of sessions and programs.

Click a card to show that map in the 3D view and open its layers (below).

- **Activate** — the robot localizes and navigates on this map from now on.
- **Edit map** (next to the active map) — opens the [map editor](map-editor.md). Only with an
  active map.
- **Deactivate** — leaves *no* map active (a "factory-fresh" test; survives restarts). Click
  twice. Activate or Save & finish ends it.
- 🗑 — deletes the whole map with all its sessions and programs. Click twice. The active map
  and a map being recorded cannot be deleted.

## Record a new map

```flow
Name | a new name = a new map
Start recording | drive the garden slowly
Cover it | edges, around obstacles, the dock
ok: Save & finish | best while docked
Active | the new map is active at once
```

![The Map recording section with numbered markers](img/shot-map-recording.webp "1 name · 2 Start recording · 3 Save & finish · 4 Erase & keep recording · 5 Discard (no save)")

1. **Map › Map › Map recording**: type a **name** (letters, digits, `_` and `-`; with any other
   character the robot does not start the recording).
2. Press **Start recording** and drive the robot over the whole area (joystick, slow speed).
   Drive along the edges and around obstacles; good RTK makes the map land in the right place.
3. Finish in the dock and press **Save & finish**. The map is saved and becomes **active**.

> [!TIP]
> Ending the recording **while docked** automatically creates the *docked* point (the robot's pose
> in the dock), which seeds the localization in the dock. The DOCK and UNDOCK points are set
> separately in **Map › Dock** ([Dock and undock](dock.md#the-points)). If the session never had
> stable RTK, the robot's log warns *captured NO georef datum… remap with good GPS*.

While recording:

- **Erase & keep recording** — wipes what was recorded so far, keeps recording (click twice).
- **Discard (no save)** — ends the recording and throws it away, nothing of it is saved; the
  robot goes back to a saved map (click twice).
- **Environment preset** and *Advanced sensing tuning* — obstacle detection settings, live; only
  while recording.
- *Localization while recording* — how the robot localizes during this recording.

## Extend a map

Start a recording with the **existing name** of the map (pick it from the list under the name
field). That map becomes active while you record, so the robot localizes on what it already knows,
and the new session is added as a new **layer**. Where sessions overlap, the newer one wins.

## Sessions, layers and the combined map

Open a map's card to see the **combined map** (👁 preview, **Activate**, ↻ rebuild) and its
**layers** — one per recording session, named by its date, newest first:

- the switch includes / excludes the session from the **combined map**,
- 👁 previews it (blue, changes nothing),
- **Activate** uses this one session alone (a warning then says the combined map is not used),
- 🗑 (click twice) removes it; the session that is active cannot be deleted.

The **combined map** merges all included sessions by their GPS positions. It is rebuilt
automatically after Save & finish, a layer delete or a switch; ↻ rebuilds it by hand.

## What you see on the map (layers)

Tick the layers under the map list: **Base** (cyan, the navigation map), **Saved** (red, the
active map), **Direct** (black, the live recording), **Preview** (blue), **Terrain** (height: blue low,
red high), **Aerial** (satellite photo), **Rain** (radar).

**Display (layers)** sets their opacity, the robot marker colours, the aerial photo source
(satellite / ČÚZK / OSM), zoom and an alignment nudge (saved on the robot for each map and tile
source), the rain radar, and shows the terrain (DEM) status. **Clear costmaps** forgets the obstacles the robot currently remembers — it does not
change any saved map.

> [!NOTE]
> A map layer that does not show is not necessarily missing — reload the page first. More in
> [Troubleshooting › The map is not visible](troubleshooting.md#the-map-is-not-visible).
