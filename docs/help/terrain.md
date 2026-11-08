---
id: terrain
title: Terrain
group: Robot
order: 55
icon: la-area-chart
summary: The terrain node live, the persistent terrain map (on, pause, rebuild, delete), terrain layers and no-go candidates.
related: [mapping, map-editor, localization]
keywords: [terrain, traversability, mowed area terrain, import, backup, terrain node, persistent map, terrain map, terrain recorder, gate, RTK, step, slope, obstacle, no-go, candidates, mosaic, mowed areas, delete map, rebuild, pause, height, reason]
---
# Terrain

**Map › Terrain** (a section of the Map tab, under *Map recording*) shows what the robot knows about
the ground and lets you control the **persistent terrain map**. Nothing here moves the robot or the
blade. The `?` in the section head opens this page.

The section asks the robot only while it is open and the Map panel is shown.

## Persistent terrain map

While the robot drives with a good position, the terrain recorder adds what the terrain node sees to
a map of the whole place that stays (heights, steps, slopes, how often a spot was seen). It also makes
the picture for the layer *Mowed area terrain*. The card says:

- the state in its head: **on** (the map is being built), **gate closed** (switched on, but nothing is
  added now), **paused**, **off**, **no map** (no served map to build into) or **not running** (the
  recorder does not answer: it runs only when the persistent terrain map is installed and allowed on the
  robot);
- **Gate** — the map is added to only while the position is good enough: RTK fix, localisation from
  GPS, a settled heading. When the gate is *closed*, the line under the state says why (for example
  *no RTK fix*, *the robot is in the dock*). A closed gate is normal in the dock;
- **Area** of the stored map, **Last write**, the **Place** (served map) it belongs to.

Buttons:

- **Build the map** (switch) — on or off. The robot remembers the choice; after installing it is off.
  Switching off keeps what is stored.
- **Pause / Resume** — stop adding for a while without switching off (until *Resume* or a restart of the
  recorder).
- **Rebuild from a run…** — puts a terrain mosaic made from a mowing run into the map. Pick the mosaic
  the robot has prepared (**Refresh list** asks it again) and how:
  - **Add to the map** — only places the map does not know yet are filled; asks once, then adds;
  - **Replace the map** — the current map goes to a backup and the mosaic takes its place; the robot
    asks once more and only the second button **Replace the map** does it.

  Everything imported counts as seen once, never as a no-go. Building straight from the recording of
  a run is not in this version yet.
- **Delete the map…** — the first press deletes nothing: the robot says what would go (place, area,
  tiles) and that it moves the map to a backup on the robot. Only the second button
  **Delete the map** deletes it; the map then starts empty. The question closes by itself after a
  minute, or with **Cancel**.
- **Make the picture again** — shown only when the picture for the layer could not be made.

Each button sends one command to the recorder and shows its answer under the buttons; a long one
(import, delete) says *Working on it…* until it is done — it can take a minute, and the recorder is
quiet meanwhile. *Has not answered yet* means nothing is known to have changed; a late answer still
shows. Look at the state before trying again.

## Terrain node

The terrain node looks at the ground 6 × 6 m around the robot from the camera. The card shows whether
it runs (it reports every 5 s) and:

- **Processor** it uses, **Computation** time of one picture, **Camera frames** per second;
- **Unplaced frames** in the last 5 s (pictures it could not place, because it did not know in time
  where the robot was);
- **Dock zone** — *applied* when the node knows where the dock is (*dock position unknown* otherwise);
  in it the ground is never marked not passable;
- **Position jumps** — how many times the robot's position jumped (it found itself again); *settling*
  means the node waits a moment before it trusts the ground again.

Warnings of the node (no picture from the camera, computing falls behind…) are listed under the
numbers.
**Parameters (read only)** shows the node's settings as it uses them now; values changed from the
default are blue. They are not changed here.

## On the map

Quick switches for the terrain layers, the same ones as in the layers button on the map
(see [Maps and mapping](mapping.md#the-layers-button-on-the-map)):

- **Traversability (live)** — the terrain node's window around the robot, about twice a second;
- **Mowed area terrain** — the terrain map of the whole mowed area (the persistent map's picture, chosen
  first, or a mosaic made from the mowing runs).

Each layer has its own **Opacity** (the shared *Maps opacity* in Map › Display still applies on top of
the live one). When the robot has more terrain maps (its persistent map, mosaics of single mowings),
**Which terrain map** picks the one *Mowed area terrain* shows; with one map its name is shown. **View** (for the layers that are on): *Traversability*
(green free → orange harder → red not passable), *Reason* (step, slope, obstacle, drop seen once, dock
zone) or *Height* (only when the layer has it). The legend under it belongs to the view.
**All layers…** opens the layers button's card.

## No-go candidates

Places the persistent map found not passable (step or too steep), with their size and where they are
(x, y in the map). **Show on map** moves the map to the place and rings it for a
few seconds.

They are only to look at for now: approving a candidate as a no-go area comes later, and nothing is
written from this list.
