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

## Which map is active

**Map › Map** shows *Active map: name* at the top, and one card per saved map with chips
(*active*, *recording*, *no session*), its area, the number of sessions and programs.

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

1. **Map › Map › Map recording**: type a **name** (letters, digits, `_` and `-`).
2. Press **Start recording** and drive the robot over the whole area (joystick, slow speed).
   Drive along the edges and around obstacles; good RTK makes the map land in the right place.
3. Finish in the dock and press **Save & finish**. The map is saved and becomes **active**.

> [!TIP]
> Ending the recording **while docked** automatically creates the *docked* point and ties the dock
> to the map — the dock and undock then work without further setup. If the session never had
> stable RTK, the log warns *captured NO georef datum… remap with good GPS*.

While recording:

- **Erase & keep recording** — wipes what was recorded so far, keeps recording (click twice).
- **Discard (no save)** — ends the recording and throws it away; the active map stays as it was
  (click twice).
- **Environment preset** and *Advanced sensing tuning* — obstacle detection settings, live; only
  while recording.
- *Localization while recording* — how the robot localizes during this recording.

## Extend a map

Start a recording with the **existing name** of the map. The robot shows the current map while
you drive, and the new session is added as a new **layer**. Where sessions overlap, the newer one
wins.

## Sessions, layers and the combined map

Open a map's card to see its **layers** — one per recording session, newest first:

- the switch includes / excludes the session from the **combined map**,
- 👁 previews it (blue, changes nothing),
- **Activate** uses this one session alone (a warning then says the combined map is not used),
- **Delete** (click twice) removes it.

The **combined map** merges all included sessions by their GPS positions. It is rebuilt
automatically after Save & finish, a layer delete or a switch; there is also a manual rebuild.

## What you see on the map (layers)

Tick the layers under the map list: **Base** (cyan, the navigation map), **Saved** (red, the
active map), **Direct** (the live recording), **Preview** (blue), **Terrain** (height: blue low,
red high), **Aerial** (satellite photo), **Rain** (radar).

**Display (layers)** sets their opacity, the robot marker colours, the aerial photo source
(satellite / ČÚZK / OSM), zoom and an alignment nudge (saved per map), the rain radar and the
terrain. **Clear costmaps** forgets the obstacles the robot currently remembers — it does not
change any saved map.

> [!NOTE]
> A map layer that does not show is not necessarily missing — reload the page first. More in
> [Troubleshooting › The map is not visible](troubleshooting.md#the-map-is-not-visible).
