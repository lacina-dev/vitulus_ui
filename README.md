# vitulus_ui

Unified single-page web user interface for Vitulus.

This package merges the three separate pages of the original `vitulus_webui`
(map view, planner, IMU calibration) into **one responsive page**, while keeping
the look, feel and responsiveness of the original map view. The original
`vitulus_webui` package is left completely untouched and can still be run.

## How it works

There is a single HTML document (`nodes/templates/index.html`) with two
sections that are switched from the top navbar:

| Section          | Source page (original)   | Renderer | Init function    |
|------------------|--------------------------|----------|------------------|
| Map view (default) | `map_view.html`        | ros3d / three.js | `window.initMapView` |
| Imu calibration  | `imu_calibration.html`   | ros3d / three.js | `window.initImu`     |

### Map editor (integrated into the map view)

The old separate "Planner" page is **merged into the map view**: you edit zones,
polygons and programs directly on the same live 3D map that shows the robot.
There is no separate Planner section any more. The editing is decomposed into the
map view's own menus, in the native menu style:

* **Map editor** — a pencil button (`#btn_mapedit`) in the map menu opens
  `#div_menu_mapedit`, a left **sidebar** (the map stays visible to the right)
  with the active map's editable detail in three sub-tabs:
  * **Zones** — mowing zones (cut height / rpm / coverage params); new / edit /
    remove. Editing draws the zone polygon on the live map.
  * **Polygons** — free / obstacle polygons; new / edit / remove.
  * **Map** — assemble, filters, and the show-layer buttons; plus Save / Load /
    Reload planner data at the top.
  Opening the editor flips the camera **top-down** and switches the map source to
  the planner map. The robot **stays drivable while editing**: the overlay only
  grabs the mouse while a shape is actually open for editing (see
  `setDrawing` / pointer-events gating); otherwise clicks pass through to the map.
* **Programs** — the existing **Programs** menu (`▶` button) gained editing:
  *New program*, an editable name, an *Add zone* dropdown and removable zone
  chips (`×`). Saving publishes `/web_plan/program_new` like the planner did.
  Programs are NOT in the map-editor sidebar — they live in their own menu.

How the drawing works: `mapeditor.js` puts a **transparent three.js overlay**
over the ros3d canvas, rendered with the ros3d camera itself, so editor geometry
is pixel-aligned with the map without mixing the two THREE instances (ros3d
bundles its own copy). `MapEditor.Ros3dEditOverlay` implements the same interface
`Planner3D.Viewer` does, so `map_edit.js`'s zone/polygon/map logic runs unchanged
against it. `map_edit.js`'s initialiser is `window.initPlanner(opts)`: with
`opts = { ros, overlay }` it runs **integrated** (shared rosbridge connection +
overlay, no own canvas, and its own program UI suppressed — the map view owns
programs); with no args it would still run standalone. The Zones/Polygons/Map
control markup is authored directly in `map_view.html` (native menu style); the
list rows are rendered by `map_edit.js` in the same style.

`planner3d.js` (the standalone top-down viewer the planner page used) is still
present and loaded — `PolygonEditor` / `PathLayer` / `attachInteraction` from it
are reused by the overlay. The whole UI shares one renderer family (three.js);
ros2d is no longer loaded.

The rosbridge port is `9090` by default; set `window.__ROSBRIDGE_PORT` before the
map view initialises to point at a different rosbridge (useful for testing against
an isolated backend without touching the live robot).

* The map view is initialised on load; the IMU section is initialised lazily the
  first time it is shown (so its canvas is sized correctly). See `assets/js/app.js`.
* The integrated map editor reuses the **map view's** rosbridge connection
  (`window.ros`); the IMU section keeps its own. Sharing a single connection
  everywhere is a possible future optimisation.
* `imu_calibration.js` is wrapped in an IIFE because it declares classes
  (`ROS`, `Viewer3D`, `ViewerGrid`, `JoyTeleop`) whose names also exist in
  `map_view.js`; the IIFE prevents a "class already declared" collision.

## Running

```
roslaunch vitulus_ui vitulus_ui.launch
```

Serves the UI on **http://<robot>:7779/** (the original `vitulus_webui` uses
7777, so both can coexist on the same machine; they share rosbridge on 9090, so
run only one rosbridge at a time). Old deep links `/imu_calibration` redirect to
that section; `/map_edit` (the former planner page) redirects to the map view,
which now hosts the editor.

### On the robot (started with everything else)

`vitulus_ui` is started by the robot's main launch — `vitulus/launch/vitulus_start.launch`
contains:

```xml
<node pkg="vitulus_ui" type="webnode" name="webnode_ui" output="screen"/>
```

It reuses the rosbridge / web_video_server / tf2_web_republisher / status_logger
that `vitulus_webui` already starts (unique node name, so no clash). So after a
normal `vitulus.service` start the UI is available on :7779 alongside the old one
on :7777.

## Restart the robot from the web (optional)

The navbar has a **⏻ Restart** button that restarts the whole robot service
(`vitulus.service`). For it to work, the `vitulus` user must be allowed to run
the relevant `systemctl` commands without a password. Install the bundled
sudoers rule **once** (as root):

```bash
sudo install -o root -g root -m 0440 \
  /home/vitulus/catkin_ws/src/vitulus/vitulus_ui/setup/vitulus-ui-sudoers \
  /etc/sudoers.d/vitulus-ui
sudo visudo -cf /etc/sudoers.d/vitulus-ui     # must print "... parsed OK"
```

That file grants only:

```
vitulus ALL=(root) NOPASSWD: /usr/bin/systemctl {restart,start,stop,is-enabled} vitulus.service
```

Without it the button (and the `POST /system/restart` endpoint) returns HTTP 403
with a message pointing back here — it never hangs on a password prompt. After
installing, the button asks for confirmation, restarts the service, then polls
and reloads the page automatically once the UI is back up.

**Security:** anyone who can reach :7779 can then restart the robot. This matches
the existing trust model — rosbridge on :9090 already exposes full ROS control on
the same network.

## Editing index.html (canonical, hand-maintained)

`index.html` is now the **canonical source** and is **edited directly**. Edit
`nodes/templates/index.html`, then **restart the vitulus_ui node** (Flask caches
the template in memory) to pick up the change.

> **The old generator `tools/build_index.py` is RETIRED / disabled.** It used to
> assemble `index.html` from `map_view.html` + `imu_calibration.html`, but since
> ~2026-07-17 `index.html` has been hand-edited across ~20 commits (map-editor
> panel redesign, left drawer UI, tool grids, fluid Settings tabs, Map-tab
> consolidation, rain-tab reorder, …). Those edits were never back-ported into
> the source templates, so the templates are ~8 KB stale and rebuilding would
> **revert the live UI**. The script now refuses to run (safety interlock).

The former source templates — `map_view.html`, `map_edit.html`,
`imu_calibration.html` — are **stale build-inputs, kept for history only**. None
of them is served at runtime (all of `/`, `/map_edit`, `/imu_calibration` render
`index.html`). Do **not** try to "resync" `index.html` from them.

Note: editing the linked **JS/CSS assets** (`mapeditor.js`, `map_view.js`,
`map_edit.js`, …) is unaffected — they are served as static files and picked up
on the next browser reload; only editing `index.html` requires a node restart.
