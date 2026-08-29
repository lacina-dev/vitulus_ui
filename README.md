# vitulus_ui

Single-page web user interface for the [Vitulus](https://github.com/lacina-dev/vitulus)
autonomous mower robot. A small Flask node serves one responsive HTML page that
talks to the robot live over rosbridge: a 3D map view with the robot, costmaps,
programs and a built-in map editor, plus status, camera, teleop, mapping
controls and an agent chat panel — all usable from a phone in the garden.

> **Status:** personal robot project. Interfaces, topics and layout change
> without notice; this package is tailored to the Vitulus robot stack and is
> published as a reference, not as a reusable component.

## Features

* **Main 3D map view** (three.js / ros3d): occupancy grid, costmap, robot
  marker, planned paths, live camera projection, aerial-imagery tiles under
  the map (georeferenced via the site datum), top-down or orbit camera.
* **Integrated map editor** — zones, polygons and mowing programs are edited
  directly on the live map (transparent three.js overlay aligned with the
  ros3d camera); the robot stays drivable while editing.
* **Right panel** — motion & dock controls (speed presets, keyboard teleop,
  battery, Dock/Undock/Stop), localization status (Pose/VO/lidar/wheel/RTK
  FIX), active map, small live camera view. Collapsible, state persisted in
  `localStorage`.
* **Status header** — the robot status icon strip (WiFi/GPS/IMU/lidar/camera/
  mower/motors/temps/supply/battery) plus a read-only host system monitor
  (CPU/MEM/DISK/NET) served by this package's own webnode.
* **Left drawer** — Marker, Map (incl. Mapping v3 session controls from
  `vitulus_mapping`), Programs, Settings, and the **agent panel**: a chat UI
  for the robot's on-board assistant with jobs, approvals and incidents
  (plain HTTP to the agent web bridge; the red STOP is answered by
  deterministic code, never by a model).
* **Rosbag manager** — list, download and delete recordings over HTTP.
* **PWA** — web manifest + service worker, installable on a phone
  ("add to home screen"); mobile layout is a first-class target.
* **Robot restart button** — restarts the whole `vitulus.service` from the
  browser (guarded by an explicit sudoers rule, see below).

## Architecture

```
browser (index.html, one page)
  ├── rosbridge websocket :9090   topics/services/TF (roslib, tf2_web_republisher)
  ├── Flask webnode       :7779   page + assets, /api/datum, /api/system, /rosbag/*, /system/*
  ├── web_video_server    :8080   MJPEG camera streams & snapshots
  ├── MapProxy tiles      :8082   aerial XYZ tiles for the 3D aerial layer (optional)
  └── agent web bridge    :8088   agent chat/jobs/approvals/incidents (optional)
```

Everything is addressed via `location.hostname`, so the UI works from any
address the robot is reachable at. There is **no authentication** — anyone who
can reach the ports can control the robot. This matches the trust model of a
robot on a private network; do not expose these ports to the internet.

### Nodes

| Node | Purpose |
|---|---|
| `webnode` | Flask server on `:7779`. Routes: `/` (the single page; `/map_edit`, `/imu_calibration` are legacy aliases), `/manifest.json`, `/sw.js`, `/api/datum` (site georef anchor: UTM origin + yaw of the map frame, read from `~/.vitulus/saves/site_datum.yaml`), `/api/system` (read-only host metrics for the header monitor — CPU/MEM/DISK/NET from `/proc`, see `nodes/system_metrics.py`), `/api/geofence` (GET: what geofence files lie on disk for a site), `/api/geofence/propose` (POST: write an UNSIGNED geofence proposal from a clicked ring — see *Geofence: draw → propose → sign* below), `/rosbag/list|download|delete`, `/system/restart`, `/system/restart_check`. |
| `costmap_reframe` | Republishes the odom-framed local costmap with its origin transformed into the `map` frame, because the bundled ros3d cannot TF-place grids itself. |
| `status_logger` | Caches the transient `/nextion/log_info` status strip into a size-rotated JSONL log and republishes recent history as a latched topic, independent of any browser. |

`launch/vitulus_ui.launch` also starts `rosbridge_server`, `web_video_server`,
`tf2_web_republisher` and the `mapping_manager` node from
[`vitulus_mapping`](https://github.com/lacina-dev/vitulus_mapping).

### Geofence: draw → propose → sign

The map editor's **Geofence** tool lets the owner *click* the test perimeter
instead of driving it. The three steps are deliberately split, and the split is
a safety property, not an accident:

1. **Draw + Finish (browser).** The editor collects the clicked ring in the
   `map` frame and POSTs it same-origin to `POST /api/geofence/propose` on this
   web node (`:7779`) — **no agent, no other service**. The offline
   *Download JSON* button is kept as a fallback (feed the file to
   `tools/geofence_propose propose`).

2. **Propose (robot).** `webnode` hands the ring to the robot-native, propose
   only writer in **`vitulus_navi/src/vitulus_navi/geofence/`** (`propose.py`,
   with verbatim copies of the agent's `geofence.py` → `fence.py` and
   `sitebundle.py`, so the ring digest and file format are identical to the
   agent path). It converts `map` metres → UTM33 via the site datum, **refuses
   any ring whose vertices or edges cross unmapped cells**, runs the same
   `Fence` geometry checks the test supervisor uses, and writes an **UNSIGNED**
   `geofence.proposed.geojson` next to the site bundle
   (`~/.vitulus/mapping_v3/<site>/`). It can never write the active
   `geofence.geojson`.

3. **Sign (human only).** Turning a proposal into the *active* fence is a
   separate, deliberate human act: a person runs
   `tools/geofence_propose sign --site <site> --digest <digest> --by "<name>"`
   (or `/geofence podepsat <digest>` in the agent chat). Only that step writes
   `geofence.geojson`, and only the signed fence is loaded by the supervisor.
   The web node's writer has **no sign function at all**, so no HTTP request to
   `:7779` — and nothing a browser can do — can ever arm a fence
   (`vitulus_claude` AGENT.md §11.1, §11.5).

The propose path needs no agent runtime (port `:8088`); signing is a manual CLI
that likewise never needed the agent process running. All the *other* map edits
(obstacles/free/wall, paths, waypoints) write straight to the robot over ROS
topics (`/mapping_manager/save_edit`, `/navi_manager/save_path_at`,
`/navi_manager/save_waypoint_at`) — only the geofence goes through this
propose-then-sign gate.

### Frontend layout

`nodes/templates/index.html` is the **canonical, hand-maintained** page.
The behaviour lives in `nodes/templates/assets/js/`: `map_view.js` (3D view),
`mapeditor.js` + `map_edit.js` (editor overlay), `mapping.js` (Mapping v3 tab,
aerial layer), `right_dock.js`, `status_header.js`, `agent_chat.js` +
`agent_blocks.js` (agent panel), `dashboard.js`, `dock.js`, `rain_alert.js`,
`app.js` (section switching). Vendored libraries (three.js, ros3d, roslib,
jquery, Bootstrap, …) are committed under `assets/` so the robot serves the UI
with no internet access.

> `tools/build_index.py` (the old generator that assembled `index.html` from
> `map_view.html` + `imu_calibration.html`) is **retired** and refuses to run:
> `index.html` has since been edited directly and rebuilding would revert the
> live UI. The old source templates are kept for history only.

## Requirements

* ROS Noetic on Ubuntu 20.04, Python 3
* `rosbridge_server`, `rosapi`, `web_video_server`, `tf2_web_republisher`
* Python: Flask, PyYAML
* The rest of the Vitulus stack for anything beyond a blank page (the UI is a
  thin client — all data comes from the robot's topics and services)

## Build & run

```bash
cd ~/catkin_ws/src && git clone https://github.com/lacina-dev/vitulus_ui.git
cd ~/catkin_ws && catkin_make && source devel/setup.bash
roslaunch vitulus_ui vitulus_ui.launch
```

Then open `http://<robot>:7779/`. On the real robot the node is started by the
main launch (`vitulus_start.launch`) as part of `vitulus.service`.

Note: `webnode` serves templates/assets from an absolute source-tree path
(`/home/vitulus/catkin_ws/src/vitulus/vitulus_ui/nodes/templates`) — adjust
`WEB_ROOT` in `nodes/webnode` if your checkout lives elsewhere. Editing
`index.html` requires a node restart (Flask caches the template); JS/CSS assets
are picked up on browser reload.

### Restart-robot button (optional)

`POST /system/restart` restarts `vitulus.service` via passwordless sudo. Install
the bundled, narrowly-scoped sudoers rule once (it allows the `vitulus` user to
run exactly `systemctl restart|start|stop|is-enabled vitulus.service`):

```bash
sudo install -o root -g root -m 0440 \
  setup/vitulus-ui-sudoers /etc/sudoers.d/vitulus-ui
sudo visudo -cf /etc/sudoers.d/vitulus-ui   # must print "parsed OK"
```

Without it the endpoint returns HTTP 403 instead of hanging on a password
prompt.

## Screenshots

<!-- TODO: add screenshots (map view, map editor, agent panel, mobile layout)
     once captures without private garden/aerial imagery are prepared. -->

## License

MIT — see [LICENSE](LICENSE).
