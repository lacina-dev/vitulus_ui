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
  `localStorage`. On a phone it starts as ONE row (map · battery · ▾) so it
  never covers half of the map; ▾ expands it, ▴ folds it back.
* **Status header** — the robot status icon strip (WiFi/GPS/IMU/lidar/camera/
  mower/motors/temps/supply/battery) plus a read-only host system monitor
  (CPU/MEM/DISK/NET) served by this package's own webnode.
* **Left drawer** — Marker, Map (incl. Mapping v3 session controls from
  `vitulus_mapping`), Programs, Settings, the map editor and the **agent
  panel**: a chat UI for the robot's on-board assistant with jobs, approvals
  and incidents (plain HTTP to the agent web bridge; the red STOP is answered
  by deterministic code, never by a model). Every panel has the same anatomy
  (see *Design system* below); on a phone the drawer is a bottom sheet so the
  map stays visible above it, ⤢ or the grip makes it full screen.
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

### Application frame (U1 kolo 5)

`assets/js/vt_frame.js` + the "frame" section of `vt_panel.css` hold the
layout of the whole app: top bar (navbar + menu band + notice band), bottom
bar, the left panel and the map between them. Top bar, left column and bottom
bar form one "C" open towards the map; the right status panel (hangs from the
top bar), the log (rises from the bottom bar) and the joystick (stands on the
bottom bar at the right edge) are protrusions of that C, and the large camera
takes the C's hollow while the map moves into the right panel (Camera Off / S /
L, **Alt+C**). Modes: `vt-m-dock` (PC: the panel is a
docked column and the map canvas narrows), `vt-m-overlay` (landscape phone /
small tablet: column over the map), `vt-m-sheet` (phone: bottom sheet). The
panel can be hidden completely (◧ in the menu band, **Alt+P**, ✕); the log
is hidden / small / full and never covers the bars, the panel, the right panel
or the notices. Full matrix: `docs/UI_LAYOUT.md`.

### Design system (U1, 2026-10)

One look for every panel, defined in two files loaded by `index.html`:

* `assets/css/vt_tokens.css` — the tokens: surfaces, text, accent/brand and
  state colours, state tints, radii (panel 12 px, card 10 px, control 7 px,
  tag 3 px), spacing, sizes (drawer width 480 px, phone sheet 60 % height,
  touch 40 px), fonts.
* `assets/css/vt_panel.css` — the panel anatomy, loaded last:
  **head** = title · meta/status (`#ui_drawer_meta`) · panel actions
  (`#ui_drawer_actions`) · ⤢ · ✕; **tabs** = one row of pills that scrolls
  sideways; **body** = `details` sections and cards; **foot**
  (`#ui_drawer_foot`) = the panel's primary action(s), per panel and per active
  tab: Marker → Send goal / Cancel navigation, Map › Path and Map › Point →
  Cancel navi, Programs → New program, Calendar → + Add event, Map editor →
  Close editor. State is a soft tint of
  the whole card plus a toned border — never a coloured stripe on the left.
  A panel lends its meta/foot elements to the shared head/foot through
  `MapMenu._drawer_chrome()` (moved with their ids, returned on hand-over);
  the agent panel puts its dot/age and ▤ ⌧ STOP into the same slots.
* `assets/js/vt_ui.js` — tab-strip edge fade + keeps the active tab in view;
  the phone bottom sheet: drag the grip/header up = full screen, down = back
  to the sheet, far down = close; with the soft keyboard open
  (`visualViewport`) the sheet is lifted onto it and the focused field
  scrolled into view.
* Panel bodies use `.vt-stack` / `.vt-card` (`data-state` = ok/warn/err/off
  tint) / `.vt-kv` / `.vt-field` / `.vt-reading`; JS reports a switch's state
  with `vtSetState(el, state)` (map_view.js), never with an inline border.

The audit that led to it: `docs/UI_AUDIT_2026-10.md`.
* `assets/css/vt_field.css` (U2) — the field dashboard's touch on the same
  palette: a tone is three variables (`--vt-st`, `--vt-st-glow`,
  `--vt-st-edge`) set by `data-state` = ok/warn/err/info/off/brand; cards get a
  radial wash from the top-left corner, a toned border and a status dot with a
  halo; plus `.vt-pill` (label with a dot), `.vt-attn` ("Needs you", also the
  look of the agent strip), `.vt-acts > .vt-act` (activity rows), `.vt-empty`,
  `.vt-skel`, `.vt-big`. Comparison and rules: `docs/UI_FIELD_STYLE.md`.
* **Joystick** — `assets/js/vt_joy.js` + `assets/css/vt_joy.css`: one
  component for touch, mouse and keyboard (W A S D / arrows, Shift = half,
  only with the keyboard switch on and never while typing). Dead zone 12 %,
  expo curve, axial snap, acceleration cap, haptics, one pointer owns the
  stick (multitouch-safe); release / cancel / blur / hidden tab / rosbridge
  close stop it, it sends three zeros and then stays silent — it never
  publishes while idle, not even on page load. The status line shows the
  speed mode (follows `/navi_manager/speed`; opening the page no longer
  publishes MEDIUM) and the motor state. The IMU tab uses the same component,
  rotate-only.
* **`?mock`** (`assets/js/vt_mock.js`) — open `/?mock` and the page still
  reads the robot (subscribe) but every other rosbridge op (publish,
  advertise, service call, action goal) and every non-GET HTTP request is
  swallowed and shown in a badge (`window.VTMock.sent`). Use it for every
  test that touches a control.

* **Needs you** (`assets/js/vt_needs.js`, `assets/js/vt_hub.js`) — a bell in
  the navbar and a drawer panel that lists what waits for a human: the
  robot agent's approvals and the field kit's "Needs you", read through the
  read-only proxy `GET /field/api/*` (webnode → vitulus-dash on loopback
  :8790). Deciding stays where the guards are (Agent › Work, the Support
  dashboard).

* **Agent › Activity** (`assets/js/vt_activity.js`) — one timeline of the
  field kit's events (`/field/api/activity`, "now" from
  `/field/api/activity/current`) and the agent's jobs and findings
  (`/agent/api/v2/jobs`), filters All / Agent / Support / Problems. Read only.

* **Support + Help** (`assets/js/vt_support.js`) — the last button of the
  menu band opens Support: Issues (open issues, stage of the fix loop, whose
  turn), Releases (kit version, what waits for a retest), Signal (both robots,
  phone notifications) and Help (the list of help topics). Read only
  (`/field/api/issues`, `/field/api/home`), polled only while the panel is
  open.

* **Help = documentation** (`docs/help/*.md`, `assets/js/vt_help.js`,
  `vt_help_md.js`, `assets/css/vt_help.css`) — one Markdown file per topic
  (robot and UI: safety, dock, localization, mapping, programs, agent, support,
  troubleshooting, every panel and tab), served read-only by the webnode at
  `/help/docs.json` and drawn in a pane on the right edge of the frame (a sheet
  on a phone). Opened by the small "?" in every panel head (topic of the panel
  **and** its open tab), "?" in the navbar, the right panel's Navi head, the
  log toolbar and Support › Help; with search and links between topics.
  **Every change of the UI or the robot updates the topic in the same commit**
  — `docs/help/README.md`, check `node tools/test_help_docs.node.js`.

* **Links agent ↔ field** (`assets/js/vt_links.js`) — "Ask the agent"
  on issue and Needs-you cards puts a draft into the agent chat (never sends
  it), "Timeline" shows Agent › Activity for one issue, Activity rows open the
  issue / finding / job they are about. Read only.

* **Deciding from the robot UI** (I5, kit 0.9.38) — Support cards in Needs you
  offer Done, a card option without motion, Hide 24 h, Remind, Accept / Dismiss a
  finding (two clicks, signed with the author's name). The browser posts
  `POST /field/act/<action>` same-origin; webnode gets a single-use token from the
  dashboard (`POST /api/ui/token`, loopback, the kit's `ui-proxy.key`) bound to the
  action, the card and the exact body, then the dashboard runs its own endpoint with a
  receipt. Audit: `~/.vitulus/ui_actions.jsonl`, `GET /field/ui_actions`, Agent ›
  Activity. Switch: rosparam `~field_writes` (default true).

Plan for one UI with the field dashboard and the agent:
`docs/UI_INTEGRATION_PLAN.md`.

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
mkdir -p ~/catkin_ws/src/vitulus && cd ~/catkin_ws/src/vitulus
git clone https://github.com/lacina-dev/vitulus_ui.git
cd ~/catkin_ws && catkin_make && source devel/setup.bash
roslaunch vitulus_ui vitulus_ui.launch
```

Then open `http://<robot>:7779/`. On the real robot the node is started by the
main launch (`vitulus_start.launch`) as part of `vitulus.service`.

Note: `webnode` serves templates/assets straight from the source tree
(`nodes/templates`). The path (`WEB_ROOT` in `nodes/webnode`) is auto-detected —
next to the node file first, then via `rospkg` — so the checkout may live in any
workspace. Editing `index.html` requires a node restart (Flask caches the
template); JS/CSS assets are revalidated by the browser on every reload
(`Cache-Control: no-cache`).

### Deploying a UI change (restart the web node cleanly)

```bash
tools/restart_webnode          # live node on :7779; prints old -> new pid
```

The node runs under roslaunch with `respawn="true"`, so it only has to stop:
the script sends **SIGINT**, the node's handler shuts the HTTP server down and
exits 0, roslaunch logs `process has finished cleanly` (INFO) and starts it
again after 5 s; the script waits until the new process answers on the port.
Do **not** use `kill -9`: roslaunch then logs `process has died … exit code -9`
at ERROR level and the agent's log watcher files it as a finding on every
deploy. `rosnode kill /webnode` does not work either — it stops rospy, but the
HTTP server thread keeps the process alive. (Agent side, not done here: the
v2 log watcher could additionally ignore a `process has died` of `webnode-*`
that is followed by a `started with pid` within ~10 s — a respawned web node
is not a fault.)

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
