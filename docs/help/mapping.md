---
id: mapping
title: Maps and mapping
group: Robot
order: 50
icon: la-map
summary: Record a new map, extend one, activate it, layers and the combined map.
ui: [map, map/map]
related: [map-editor, routes, localization, dock, lidar]
keywords: [map, site, record, recording, extend, remap, activate, deactivate, layers, combined, aerial, background map, cadastre, parcels, contour lines, relief, slope, buildings, house numbers, satellite, orthophoto, Esri, Bing, Google, overlay, precipitation, rain radar, radar mosaic, nowcast, terrain, session, save, sensing, lidar, camera, coverage, field of view, layers button, Wayback, CENIA, historical orthophoto, 1950s]
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
(*active*, *recording*, *no session*), its area, the number of sessions and programs. A line
under the active map speaks only when there is something to say: a recording that runs, an
activation that failed or is under way, or no active map at all.

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
> Ending the recording **while docked** automatically creates the *DOCKED* point (the robot's pose
> in the dock), which seeds the localization in the dock. If the site has no DOCK or UNDOCK yet,
> they are created with it where the back-out ends; move them in **Map › Dock** or the map editor
> ([Dock and undock](dock.md#the-points)). If the session never had
> stable RTK, the robot's log warns *captured NO georef datum… remap with good GPS*.

While recording:

- **Erase & keep recording** — wipes what was recorded so far, keeps recording (click twice).
- **Discard (no save)** — ends the recording and throws it away, nothing of it is saved; the
  robot goes back to a saved map (click twice).
- **Mapping profile** — what this place is mapped with, see below.
- *Localization while recording* — how the robot localizes during this recording.

## Mapping profile

One named set for mapping, chosen in the **Recording** section of the Map tab: what the camera counts
as an obstacle, the lidar for mapping, and how evidence adds up in the map. **Lawn short**, **Lawn
tall**, **Paved yard**, **Bushes / edge** and **Default** are built in, your own go next to them.

**Every place keeps its own.** The name on the right says for which place the profile is shown.
Serve another map and its profile comes with it, the camera too (within a second or so), with or
without a recording; a new map starts as a copy of what was in use. Without a served map the
values are kept for the next recording. Navigation does not depend on any of it.

- The panel only chooses and shows: **Camera**, **Lidar** and **Evidence** say what the profile
  holds, **Set** takes you to [Settings › Camera](camera.md#obstacle-detection) and
  [Settings › Lidar](lidar.md#lidar-in-mapping). The evidence model is right below in the panel.
- **A change is kept at once** for this place, recording or not, and applies at once during a
  recording. The panel then shows *edited* with their number and a dot at the part that differs.
- **Save to profile** writes the changes into the profile, for every place that uses it. **Save
  as…** makes a new one. **Back to profile** drops the changes of this place.
- Saving into a built-in profile keeps your version next to it (a dot in the list); **Restore
  default** brings its values back. **Delete profile** removes your own; places that used it keep
  their values.
- Switching the profile with changes open asks first: they would be dropped.
- If the camera detection does not run, the panel says so and it gets the values when it starts.
  If it refuses them, the panel says why and it keeps running on the previous ones.

What the camera card says is what lands in the map: the mapper does not filter the camera's points
a second time. Maps made before this keep what they had: their settings were converted into a
profile, and what differs from it shows as *edited*.

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
active map), **Direct** (black, the live recording), **Preview** (blue), **Elevation** (height: blue low,
red high), **Background** (the background map, see below), **Rain** (the ČHMÚ radar of the weather
service; the map from several radars is the **Precipitation (mosaic)** overlay, see below). The
background map and the overlays are quickest to change with the [layers button on the map](#the-layers-button-on-the-map).

**Sensing** shows what the robot is observing right now, drawn flat on the ground around it.
It switches on by itself when a recording starts and off when it ends (tick it by hand any time):

- **Violet = lidar.** The live scan: stronger fill up to the obstacle each beam hits (with a
  violet outline along it), a faint fill where nothing was hit — that is free space up to the
  lidar range of the mapping profile, marked by a faint arc. Gaps are beams the map ignores.
- **Yellow = camera.** The view cone of the depth camera: about 55° wide, up to the mapper's
  camera range of the mapping profile. During a recording a dimmed cone means the camera
  delivers nothing to the map right now.
- **Faint fill = already observed** in this recording (only while the mapper takes data in).
  Places without it have not been seen yet — drive there to fill the map. It starts empty with
  each recording and after **Erase & keep recording**.

The ranges are the ones the map really takes in (the mapping profile of this place), not the
sensors' maximum, recording or not.

### The layers button on the map

The square button with the layers icon (rounded corners, like the compass) under the compass in the top-left corner of the map opens
**Map layers** — on a phone as a sheet over the bottom of the map (the map stays visible above it,
the STOP, the bottom bar and the joystick stay free), on a wider screen as a card beside the button.
One tap opens it, a second one picks the map:

- **Background map** — the photos and the maps in their two groups, each tile with its name and
  the provider under it and a small picture of that map around the middle of your view (about 50 m
  across; until it loads, or when it cannot, a drawn icon), so you can compare the photos before you
  pick one; **None** takes the background away. The chosen one is framed, its name is
  also in the card's header. **Opacity** under the tiles is the same slider as in Display (layers).
  When the background does not load, an orange line under the heading says so (*not loading —
  MapProxy unreachable or the robot without internet?*, or *2 of 6 tiles did not load*) and the
  button turns orange; the map tries again by itself. While a Google map is chosen, the switch
  **Align Google to ČÚZK** under the opacity moves it about 1 m onto ČÚZK (see Display below).
- **Overlays** — *Lines and labels* (cadastre, buildings and house numbers, contour lines) and
  *Terrain* (shaded relief, relief ×10 and ×20, slope, aspect, trees and buildings), and
  under *Weather* the **Rain radar** and **Precipitation (mosaic)** (one map from several radars;
  while it is on, its time line with the nowcast, ▶, *Now*, the legend and *Whole area* are right in
  its row — the same control that otherwise sits in Map › Display (layers), see below; while this
  card is open it is here, not there). A switch turns each on; while it is on the row shows its opacity,
  a line on what it shows and its tile state (*z19 · 3/12*); **Slope** also has its colour scale
  in degrees, from *flat* (grey, under 3°) over yellow (5–10°) and orange (10–20°) to *steep* (brown,
  over 30°), **Aspect** a colour wheel with N, E, S, W (the colour of a
  slope facing that way: north yellow-green, east blue, south purple, west orange).
- Sources added since you last opened the card carry an orange **new** tag and the button an
  orange dot, until you close the card.
- **More settings in Map › Display ›** opens the rest (Detail, alignment, the rain radar's area);
  in the map editor it opens the editor's Layers.

It is the same setting as the Map panel and the editor's Layers: whatever you change in one place
shows in the others at once, and the browser remembers it. Tap outside the card, ✕ or Esc closes it.

### Traversability (live)

**Traversability (live)** (layers card under *Robot*, also a tick in the Map tab's layers row; off by
default, remembered) shows what the robot's terrain node sees right now: a 6 × 6 m window around
the robot in 5 cm cells, about twice a second, flat on the ground under the robot and the paths;
where the camera has not looked yet there is nothing. Three views, the same as for the mowed area
below (the choice is remembered; the legend under them says what the colours mean):

- **Traversability** — from free to not passable.
- **Reason** — why a place is hard or not passable (higher cost, step, too steep, obstacle, a drop
  seen only from one place, dock zone); the dock zone itself is outlined in white.
- **Height** — the ground against the robot (±15 cm); only when the terrain node sends it (its
  parameter `ui_elevation`), otherwise the button is greyed out.

It has its own opacity. The data come only while the layer is on and the page is shown (at most twice
a second, a few kB each). Until the terrain node's detailed topic `/traversability/ui` is there, the
layer falls back to its plain costmap — traversability only, the row says so. The row says *live*,
*waiting…*, *old data* (nothing new for a few seconds, drawn faded), *no map position* (the robot does
not know where the odometry sits in the map: not drawn) or *no data* — then the terrain node does not
run or the camera gives no picture.
### Mowed area terrain

**Mowed area terrain** (layers card under *Robot*, also a tick in the Map tab's layers row; off by
default, remembered) shows the terrain of the whole area the robot mowed, put together afterwards
from its mowing recordings in 5 cm cells — the same as the live window of the layer above, but for
all of it at once. Three views: **Traversability** (green free, yellow → red harder, dark red not
passable), **Reason** (the same colours as the live layer: step, too steep, obstacle, drop seen once,
dock zone) and **Height** (blue lowest, brown highest; the legend says how many centimetres apart).
It has its own opacity; the line under it names the map, how much of the area is known and what share
is not passable. A site can have more maps: a map of one day's mowing (a still picture of that day) and
the robot's own lasting terrain map, which grows while it records and is looked for in a new version every
minute (a new version replaces the picture without blinking). Shown is the map you picked in the list above
the legend (remembered); without a choice the robot's lasting map, else the newest. *No map* means none was
made for this site yet. The layer only reads the map from the robot (a few hundred kB once when shown).

### Scale bar

In the bottom-left corner, just above the credits line, a small bar shows the scale: its length on
the ground is the distance written over it (a round number: 50 cm, 2 m, 20 m, 1 km …). It follows
every zoom — wheel, pinch, the zoom buttons, the map editor. It is measured at the middle of the view;
the map is seen almost straight from above, so it holds across the whole picture. With the rain
overlay on, the time label of the radar sits just above the bar.

### Measuring

The ruler button under the layers button measures on the map. Tap it, then tap (or click) points on
the map: the card beside the button shows the length of the line through them, and from three points
also the **area** they enclose and the length **round** (the closed shape) — e.g. how big a part of the
lawn is or how far the fence runs. Dragging and pinching still move the map (only a tap without
dragging adds a point). **Undo** removes the last point, **Clear** all, **×** or Esc ends measuring.
Distances are on the ground in the map's own metres. While the Marker panel or the map editor is open
measuring takes no taps (a tap there places the goal marker or edits) and the card says so. Measuring
sends nothing to the robot.

### Lidar range and Camera range

**Sensing** is what the sensors see now. **Lidar range** and **Camera range** are two layers with
the limits: how far each sensor sees and how far the robot really uses it. They work all the time,
with or without a recording, each has its own tick and the browser remembers it.

![The map with both range layers around the robot and the card with the numbers](img/shot-ranges.webp "Lidar range (violet) and Camera range (yellow)")

**Navigation / Mapping** at the top of the card chooses what the layers show: what the robot uses
while driving, or the mapping profile of this place. A profile change or a slider in Settings ›
Camera / Lidar shows here as soon as the robot has it.

- **Dashed** — what the sensor sees (lidar 16 m, camera the raw depth view up to the driver's cut).
- **Bright edge** — the limit of the chosen view, from where it starts to where it ends; the camera
  has its view angle in the middle. The numbers stand on the edges; when something else than the
  setting of that view limits it, the label names it (*navigation 3.0 m · the costmap*). A label
  that would cover another one hides, the card has them all.
- **Short dashes in the camera's view** — where it starts to see the ground: it does not see the
  ground right in front of the robot.
- **Red sector** — the lidar has something right next to it there (closer than 0.4 m in almost
  every scan, it needs about 30 s), for example the walls of the dock.

The card shows the real values with the camera's height window. When a value is lower than what is
set, it says who cut it, for example *5.0 m: the driver (set 6.0 m)*. The lidar's settings are in
[Settings › Lidar](lidar.md), the camera's in [Settings › Camera](camera.md); both have **Show the
range on the map**.

**Agent's plan** (amber ◆) shows what the agent plans for its running mission — points, routes and
areas it drew into the map; it appears and disappears by itself, see
[Vitulus agent › The agent's plan on the map](agent.md#the-agents-plan-on-the-map).

**Display (layers)** sets their opacity, the robot marker colours, the **background map** under
the map, its **Detail** and an alignment nudge (saved on the robot for each map and tile source; the ČÚZK
sources share one, the Google ones another), the rain radar, and shows the terrain (DEM) status.
Above the nudge, **Align Google to ČÚZK (about 1 m)** (off by default, remembered in the browser)
moves Google's satellite, hybrid and map 0.73 m west and 0.71 m south: Google's pictures sit about
1 m north-east of ČÚZK's (ČÚZK uses ETRS89, Google today's WGS84; measured at three places in
Prague). The robot's map does not move, the nudge stays as saved; the layers card has the same
switch under the background's opacity while a Google map is chosen.
The background maps come in two groups: **aerial and satellite photos** (Google satellite, Google
satellite with names, ČÚZK orthophoto, Esri, Bing, three older Esri releases — *Esri archive
2025-04, 2023-06, 2022-04 (Wayback)*, the date is the release, the photo over your place can be older —
and the *Orthophoto 1950s (CENIA)*, black-and-white aerial photos from the 1950s, up to z18) and **maps** (Google map, ČÚZK topographic map,
OpenTopoMap, OpenStreetMap). Each photo source has its own date and its own sharpness — when one is
old or blurry over the garden, try another. **Detail** *Auto* (the default) loads the finest level
each source has — Google and the ČÚZK orthophoto z20 (Google's z21 holds no more detail, so it is
not loaded) — and closer up only magnifies it
smoothly. Zooming in stops at about 20 cm along the longer side of the screen; the background map and the robot's maps
stay on screen all the way. On a phone the background map stops one level coarser (Google z20, ČÚZK z19) and so
loads fewer tiles. On a slow connection
pick a lower cap (z17–z21): fewer tiles, a softer picture. The tiles always cover what you see.
After a move or a zoom the previous picture stays until the new tiles are in, and a coarser one
fills the gaps meanwhile, so the map does not go blank; a view you saw a moment ago comes back at
once. The status line says it in words — the source, then *finest detail*, *zoomed out, coarser
picture* or *loading 12 of 48 tiles…* (the zoom level in brackets for the curious) — and says when some did
not load — then MapProxy on the robot is not reachable or has no picture there (without internet
it has only what it stored before; the plain white tile it sends then is not drawn). Once the
network, the connection to the robot or MapProxy's internet is back, the map loads its tiles again
by itself: a few missing tiles get one quick try after 3 s; after that, and after a bigger outage, it tries again after 15 s, 30 s and then every minute until all of them came (a tile that does not answer counts as missing once no tile came for 20 s; a slow MapProxy is waited for). A phone uses a lower tile limit than a computer to spare its
memory; with overlays on it gives the background map at most half of it (far out the map then
shows a coarser level and its line says *coarser picture: too many tiles*) and draws the overlays a level coarser
(relief and slope two), so all of them fit. A computer does the same with the overlays when zoomed
far out (from a view about 300 m high): they come a level coarser (relief and slope two), the
background map keeps its detail, so the view loads in a fraction of the time.

**Dim the robot's map over the background** (under the background map's opacity, off by default;
also in Settings › App › Display):
while a background map is shown, the free space of the robot's map is only a light tint and the
unknown cells around it are transparent, so you see the lawn itself, not a grey-green sheet. A light
ring stays around every obstacle, so the red (or black) obstacles read on any picture. Unticked, the
map keeps its full fill. Without a background map, with its opacity turned almost down, or when no
tile of it loaded, the fill is always full.

**Overlays** are transparent layers, each with its own tick box and opacity, with or without the
background map: **Cadastre** (parcel boundaries, light lines), **Buildings, house numbers** (ČÚZK
RÚIAN: building outlines and house numbers) and **Contour lines** are drawn on top of the robot's
maps. **Shaded relief** and **Slope** (both from the ČÚZK
terrain model DMR 5G; slope yellow → orange → red = steeper, handy for banks and ditches) shade the
background map and the robot's map without covering them, inside the garden too: flat ground stays
as it is, slopes get darker or tinted (never below about a third of the brightness, even in a deep
shadow at full opacity), and the obstacles, the lines, zones, paths and the
robot stay on top. Without a background map they are laid over the map as a plain see-through tone.
Cadastre, buildings and contour lines show only close up — the row says *zoom in* until they do.
While an overlay loads its row counts the tiles (*z19 · 3/12*); *not loaded* or *2 missing* means
MapProxy did not deliver them. All layers share one tile limit, the background map first: an overlay that does not fit
says *tile limit*, a background map drawn coarser than asked says so in its status line. The small
line in the bottom-left corner of the map credits the sources on screen (tap it for the whole
text): ČÚZK sources are open data, OpenTopoMap is CC-BY-SA; Google, Esri and Bing are the
companies' own imagery. **Clear costmaps** forgets the obstacles the robot currently remembers — it does not
change any saved map.

**Precipitation (mosaic)** is one rain map put together from several weather radars — the Czech
ČHMÚ composite, the European EUMETNET OPERA network and RainViewer — by the robot's own
precipitation service (it runs on the robot next to MapProxy, port 8097). Tick it and a time line
opens under the row: the time of the picture on the map and what it is (*newest radar*, *radar
−25 min*, or *nowcast +20 min*, a short forecast drawn in the info colour), how old the newest radar
picture is, a slider over the last two hours plus the nowcast (the striped part right of *now*),
**▶** to play it, **Now** to jump back to the newest picture (the layer then follows the new ones by
itself), the colour legend in mm/h (rain, and snow where the radar knows it), the sources of the
picture with links, and **Whole area** to zoom out over the whole region around the garden. The
time is also written in the map's bottom-left corner. Light rain is see-through, heavy rain solid;
where no radar measures, the map stays empty (that is not "dry"). *Data N min old* means the radars
have not sent a new picture for a while; *service not responding* means the precipitation service on
the robot is not running — the **Rain** layer from the weather service is separate and keeps
working. The map is meant for this robot's own use: RainViewer's terms allow personal use only.

> [!NOTE]
> A map layer that does not show is not necessarily missing — reload the page first. More in
> [Troubleshooting › The map is not visible](troubleshooting.md#the-map-is-not-visible).
