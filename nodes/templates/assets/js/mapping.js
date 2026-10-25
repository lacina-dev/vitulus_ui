// MappingV3 — Map tab section: "mapping with known poses" pipeline control.
// Start/stop the per-garden mapping session (mapping_manager spawns the
// roslaunch), watch the insertion gate (RTK-gated), and pull terrain DEM /
// obstacle raster previews. All robot topics live under /mapping/*; the
// manager under /mapping_manager/*.
// =========================================================================
// AERIAL TILE OFFSET — pure helpers (unit-tested by
// tools/test_tile_offsets.node.js; kept OUTSIDE the class so the harness can
// slice them out of this file verbatim, the same seam the other harnesses use).
// -------------------------------------------------------------------------
// WHY: ortho/satellite imagery is never perfectly georeferenced — it usually
// sits a little off the real world. The user nudges the AERIAL TILE LAYER in
// the UI until it lines up optically with the obstacles on the occupancy map.
// The nudge is stored ON THE ROBOT (webnode /api/tile_offsets ->
// ~/.vitulus/ui/tile_offsets.json) so it is shared across browsers, and it is
// keyed by (map name, tile layer id) — every map and every MapProxy layer
// carries its own correction.
//
// SHAPE : {"<map>": {"<layer>": {dx, dy}}} — mirrors the robot store 1:1.
// UNITS : METRES in the /map frame; dx = +map x, dy = +map y.
// SAFETY: an unknown map, an unknown layer, a NaN or an out-of-range value all
//         resolve to a ZERO offset. The aerial layer therefore degrades to
//         "no offset" and can never be broken by a bad/garbled entry.
const TILE_OFFSET_MAX_M = 50.0;

// Resolve the stored offset for (map, layer). ALWAYS returns {dx, dy} numbers.
function tileOffsetGet(offsets, mapName, layer) {
    const zero = {dx: 0, dy: 0};
    if (!offsets || typeof offsets !== 'object') { return zero; }
    if (!mapName || !layer) { return zero; }
    const layers = offsets[mapName];
    if (!layers || typeof layers !== 'object') { return zero; }
    const off = layers[layer];
    if (!off || typeof off !== 'object') { return zero; }
    const dx = Number(off.dx), dy = Number(off.dy);
    if (!isFinite(dx) || !isFinite(dy)) { return zero; }
    if (Math.abs(dx) > TILE_OFFSET_MAX_M || Math.abs(dy) > TILE_OFFSET_MAX_M) {
        return zero;
    }
    return {dx: dx, dy: dy};
}

// Clamp one axis to the stored range and round to mm (0.1 mm, really).
function tileOffsetClamp(v) {
    const n = Number(v);
    if (!isFinite(n)) { return 0; }
    const c = Math.max(-TILE_OFFSET_MAX_M, Math.min(TILE_OFFSET_MAX_M, n));
    return Math.round(c * 10000) / 10000;
}

// Add a nudge (metres) to an existing offset, clamped. Bad input reads as 0.
function tileOffsetNudge(cur, dxStep, dyStep) {
    const c = tileOffsetGet({m: {l: cur}}, 'm', 'l');
    const sx = Number(dxStep), sy = Number(dyStep);
    return {
        dx: tileOffsetClamp(c.dx + (isFinite(sx) ? sx : 0)),
        dy: tileOffsetClamp(c.dy + (isFinite(sy) ? sy : 0)),
    };
}

// Store an offset in the mirror. A zero offset REMOVES the entry (and the map
// key once it holds no layers), matching what the robot store does.
function tileOffsetPut(offsets, mapName, layer, off) {
    const out = (offsets && typeof offsets === 'object') ? offsets : {};
    if (!mapName || !layer) { return out; }
    const dx = tileOffsetClamp(off && off.dx);
    const dy = tileOffsetClamp(off && off.dy);
    if (dx === 0 && dy === 0) {
        if (out[mapName]) {
            delete out[mapName][layer];
            if (!Object.keys(out[mapName]).length) { delete out[mapName]; }
        }
        return out;
    }
    if (!out[mapName] || typeof out[mapName] !== 'object') { out[mapName] = {}; }
    out[mapName][layer] = {dx: dx, dy: dy};
    return out;
}

// Human-readable readout for the UI (English, metres, 2 decimals).
function tileOffsetFormat(off) {
    const o = tileOffsetGet({m: {l: off}}, 'm', 'l');
    return 'dx ' + o.dx.toFixed(2) + ' m / dy ' + o.dy.toFixed(2) + ' m';
}

// i18n (docs/I18N.md): keys 'mapping.*'. Distinct global names — this is a
// classic script, a top-level `t` would collide with other modules.
function mapT(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
function mapTn(k, n, v) { return window.VTI18n ? VTI18n.tn(k, n, v) : k; }
function mapTag(el, k, attr) { if (el && window.VTI18n) { VTI18n.tag(el, k, attr); } }

class MappingV3 {
    constructor(ros, tfClient, viewer3d) {
        this.ros = ros;
        // i18n: status lines drawn through _say() re-render on a language switch
        this._sayEls = new Set();
        this._lastManagerMsg = null;
        this._lastGateMsg = null;
        this._lastDemMsg = null;
        this._lastDirectMsg = null;
        this._lastPresets = null;
        this._relabel = [];   // [fn] re-run on a language switch (double-click buttons)

        // vitulus_ui INSERTION-ORDER HARDENING (belt + braces alongside the
        // renderer.sortObjects=true fix in map_view.js): create the AERIAL and
        // TERRAIN groups EAGERLY here — empty, and BEFORE the site_map / live
        // obstacle occupancy groups are added below — chiefly so the lazily-
        // created AERIAL group (the true bottom layer) can never land last and
        // cover everything if a build ever reverts to insertion-order transparent
        // rendering (sortObjects false). In the ACTIVE regime sortObjects is on,
        // so paint order is decided by mesh.renderOrder from the MapLayerOrder
        // contract regardless of insertion order — that is what now lifts the
        // opt-in terrain plane (renderOrder 12) ABOVE the maps. _r3d() only needs
        // the ROS3D global, and the _ensure* methods are idempotent, so this is
        // safe this early.
        this.viewer3d = viewer3d;
        this._r3dCache = null;
        this.aerial_group = null;
        this.terrain_group = null;
        try {
            this._ensureAerialGroup();
            this._ensureTerrainGroup();
        } catch (e) { /* 3D not ready — groups build lazily as before */ }

        this.input_site = document.getElementById("mapv3_input_site");
        this.datalist = document.getElementById("mapv3_sites");
        this.btn_start = document.getElementById("mapv3_btn_start");
        this.btn_stop = document.getElementById("mapv3_btn_stop");
        this.btn_serve = document.getElementById("mapv3_btn_serve");   // removed 2026-08-09 (serve lives in the Maps list) — kept null-safe
        this.el_serving = document.getElementById("mapv3_serving_status");
        // 2026-08-09 session controls: Reset map (wipe in-progress raster,
        // keep mapping) + Discard (end session WITHOUT saving)
        this.btn_reset_map = document.getElementById("mapv3_btn_reset_map");
        this.btn_discard = document.getElementById("mapv3_btn_discard");
        this.btn_mode_rtk = document.getElementById("mapv3_btn_mode_rtk");
        this.btn_mode_force = document.getElementById("mapv3_btn_mode_force");
        this.btn_mode_off = document.getElementById("mapv3_btn_mode_off");
        this.btn_raster = document.getElementById("mapv3_btn_raster");
        this.btn_save = document.getElementById("mapv3_btn_save");
        this.btn_compare = document.getElementById("mapv3_btn_compare");
        this.el_run = document.getElementById("mapv3_run_status");
        this.el_gate = document.getElementById("mapv3_gate_status");
        this.el_dem = document.getElementById("mapv3_dem_status");
        this.el_proj = document.getElementById("mapv3_proj_status");
        // obstacle classification (band) controls
        this.in_band_min = document.getElementById("mapv3_band_min");
        this.in_band_max = document.getElementById("mapv3_band_max");
        this.in_min_evidence = document.getElementById("mapv3_min_evidence");
        this.in_min_cluster = document.getElementById("mapv3_min_cluster");
        this.btn_apply_band = document.getElementById("mapv3_btn_apply_band");
        // the "what Apply does" tooltip, shown once a session is running
        // (setActionsEnabled swaps in a "why disabled" tooltip while idle)
        this._applyBandTitle = () => mapT('mapping.band.apply_tip');
        this.el_band_status = document.getElementById("mapv3_band_status");
        this.band_edited = false;   // don't clobber user typing with live status
        // per-source range caps (item 3/4): lidar + depth max range, fed to
        // /mapping/set_ranges, prefilled from gate_status. Same session-gating
        // and edit-guard pattern as the band controls.
        this.in_lidar_max = document.getElementById("mapv3_lidar_max");
        this.in_depth_max = document.getElementById("mapv3_depth_max");
        this.btn_apply_ranges = document.getElementById("mapv3_btn_apply_ranges");
        this._applyRangesTitle = () => mapT('mapping.ranges.apply_tip');
        this.el_ranges_status = document.getElementById("mapv3_ranges_status");
        this.ranges_edited = false;

        // Direct 2D raster mapper — new node, fed by /mapping/direct_status,
        // configured via /mapping/set_direct (partial dicts OK). Three source
        // rows (enable checkbox + range cap) plus min-hits and the no-hit-free
        // toggle, applied together as ONE set_direct JSON. Values are
        // populated from direct_status.settings only ONCE, on first arrival
        // (see handleDirectStatus) — unlike the band/ranges edit-guard above,
        // this stream arrives at ~1.5 Hz so a live re-sync would fight with
        // in-progress typing; there is no ongoing risk once populated once.
        this.chk_direct_use_lidar = document.getElementById("mapv3_direct_use_lidar");
        this.in_direct_lidar_range = document.getElementById("mapv3_direct_lidar_range");
        this.chk_direct_free_no_hit = document.getElementById("mapv3_direct_free_no_hit");
        this.chk_direct_use_cam_obstacle = document.getElementById("mapv3_direct_use_cam_obstacle");
        this.in_direct_obstacle_range = document.getElementById("mapv3_direct_obstacle_range");
        this.chk_direct_use_cam_free = document.getElementById("mapv3_direct_use_cam_free");
        this.in_direct_free_range = document.getElementById("mapv3_direct_free_range");
        this.in_direct_min_hits = document.getElementById("mapv3_direct_min_hits");
        this.btn_apply_direct = document.getElementById("mapv3_btn_apply_direct");
        this.el_direct_status = document.getElementById("mapv3_direct_status");
        // 2026-08-09 live-tuning rebuild: sliders publish debounced PARTIAL
        // set_direct dicts on input; controls re-sync from direct_status
        // whenever the user has not touched them for a few seconds (replaces
        // the old one-time prefill — keeps multiple browsers consistent and
        // reflects preset loads immediately).
        this.in_direct_obs_hmin = document.getElementById("mapv3_direct_obs_hmin");
        this.in_direct_obs_hmax = document.getElementById("mapv3_direct_obs_hmax");
        this.in_direct_min_cluster = document.getElementById("mapv3_direct_min_cluster");
        this.in_direct_cluster_radius = document.getElementById("mapv3_direct_cluster_radius");
        this.in_direct_lidar_min_int = document.getElementById("mapv3_direct_lidar_min_int");
        this.in_direct_hit_inc = document.getElementById("mapv3_direct_hit_inc");
        this.in_direct_miss_dec = document.getElementById("mapv3_direct_miss_dec");
        this.in_direct_lidar_free_dec = document.getElementById("mapv3_direct_lidar_free_dec");
        this.in_direct_occ_erode = document.getElementById("mapv3_direct_occ_erode");
        this.in_direct_occ_thresh = document.getElementById("mapv3_direct_occ_thresh");
        this.in_direct_free_thresh = document.getElementById("mapv3_direct_free_thresh");
        this.sel_direct_preset = document.getElementById("mapv3_direct_preset");
        this.btn_direct_preset_load = document.getElementById("mapv3_direct_preset_load");
        this.in_direct_preset_name = document.getElementById("mapv3_direct_preset_name");
        this.btn_direct_preset_save = document.getElementById("mapv3_direct_preset_save");
        this.btn_direct_preset_del = document.getElementById("mapv3_direct_preset_del");
        this._directSettingsSeen = false;   // first-status sync happened
        this._directLastTouch = 0;          // last user interaction (ms epoch)
        this._directPending = null;         // accumulated partial for debounce
        this._directDebounce = null;        // debounce timer
        this._directPresetSig = '';         // preset <select> rebuild guard
        // vitulus-field#23: Load/Save/Delete need direct_raster (session
        // only) — keep their titles to restore them when a session runs
        this._directPresetTitles = [this.btn_direct_preset_load,
            this.btn_direct_preset_save, this.btn_direct_preset_del]
            .map((b) => (b ? b.title : ''));
        // ...in the current language when the markup tags them (data-i18n-title)
        this._presetTitle = (i) => {
            const b = this._directPresetTitles && [this.btn_direct_preset_load,
                this.btn_direct_preset_save, this.btn_direct_preset_del][i];
            const k = b && b.getAttribute('data-i18n-title');
            return k ? mapT(k) : this._directPresetTitles[i];
        };
        // slider spec: [input, key, decimals, unit] — value echo span is
        // the input id + "_val"; shared by wiring, sync and applyDirect.
        this._directSliders = [
            [this.in_direct_lidar_range, 'lidar_max_range_m', 1, ' m'],
            [this.in_direct_obstacle_range, 'obstacle_max_range_m', 1, ' m'],
            [this.in_direct_free_range, 'free_max_range_m', 1, ' m'],
            [this.in_direct_obs_hmin, 'cam_obstacle_min_h', 2, ' m'],
            [this.in_direct_obs_hmax, 'cam_obstacle_max_h', 2, ' m'],
            [this.in_direct_min_cluster, 'cam_min_cluster_pts', 0, ' pts'],
            [this.in_direct_cluster_radius, 'cam_cluster_radius_m', 2, ' m'],
            [this.in_direct_lidar_min_int, 'lidar_min_intensity', 0, ''],
            [this.in_direct_min_hits, 'min_hits', 0, ''],
            [this.in_direct_hit_inc, 'hit_inc', 2, ''],
            [this.in_direct_miss_dec, 'miss_dec', 2, ''],
            [this.in_direct_lidar_free_dec, 'lidar_free_dec', 2, ''],
            [this.in_direct_occ_erode, 'occ_erode_factor', 2, ''],
            [this.in_direct_occ_thresh, 'occ_thresh', 2, ''],
            [this.in_direct_free_thresh, 'free_thresh', 2, ''],
        ];
        this._directChecks = [
            [this.chk_direct_use_lidar, 'use_lidar'],
            [this.chk_direct_use_cam_obstacle, 'use_cam_obstacle'],
            [this.chk_direct_use_cam_free, 'use_cam_free'],
            [this.chk_direct_free_no_hit, 'lidar_free_no_hit'],
        ];

        this.el_sites = document.getElementById("mapv3_sites_row");

        // Saved / live mapping-v3 occupancy grids in the MAIN 3D view — the
        // ground layer under the planner routes / zones / robot pose. Both are
        // nav_msgs/OccupancyGrid (100=obstacle, 0=free, -1=unknown) rendered by
        // the SAME ROS3D.OccupancyGridClient pipeline the base map uses; the
        // free/obstacle/unknown colours come from the getColor() branch in
        // map_view.js keyed on the `color` identifier below (NOT a real colour).

        // (1) SAVED site_map — latched persistent ground layer served by
        //     mapping_manager (Serve button). Blue identifier {0,100,255} =>
        //     free light grey-green, obstacles solid RED, unknown transparent.
        this.site_group = new THREE.Object3D();
        viewer3d.scene.add(this.site_group);
        this.site_client = new ROS3D.OccupancyGridClient({
            ros: ros,
            tfClient: tfClient,
            rootObject: this.site_group,
            continuous: true,
            compression: 'cbor',
            topic: '/mapping_manager/site_map',
            color: {r: 0, g: 100, b: 255},
            opacity: 0.9,
            offsetPose: new ROSLIB.Pose({
                position: new ROSLIB.Vector3({x: 0, y: 0, z: 0.01}),  // SITE band
                orientation: new ROSLIB.Quaternion({x: 0, y: 0, z: 0, w: 1})
            })
        });

        // (1b) RASTER PREVIEW — per-raster management. A RAW raster (no human
        //      edits composited) latched on /mapping_manager/raster_preview by
        //      mapping_manager when a raster row's Preview button is toggled, so
        //      a stored raster version can be compared side-by-side against the
        //      currently-served site_map. Same OccupancyGridClient pipeline; the
        //      distinct BLUE identifier {40,140,255} selects the blue-tinted
        //      PREVIEW branch in map_view.js getColor() so it reads clearly apart
        //      from the served map's red obstacles. An empty grid clears it.
        //      renderOrder PREVIEW (11) sits between SITE (10) and TERRAIN (12).
        this.preview_group = new THREE.Object3D();
        viewer3d.scene.add(this.preview_group);
        this.preview_client = new ROS3D.OccupancyGridClient({
            ros: ros,
            tfClient: tfClient,
            rootObject: this.preview_group,
            continuous: true,
            compression: 'cbor',
            topic: '/mapping_manager/raster_preview',
            color: {r: 40, g: 140, b: 255},
            opacity: 0.85,
            offsetPose: new ROSLIB.Pose({
                position: new ROSLIB.Vector3({x: 0, y: 0, z: 0.011}),  // PREVIEW
                orientation: new ROSLIB.Quaternion({x: 0, y: 0, z: 0, w: 1})
            })
        });

        // (2) LIVE obstacle_map — RETIRED 2026-07-19: octomap/band mapping
        //     retired, the direct mapper is the mapper. The band raster
        //     /mapping/obstacle_map (orange LIVE layer, auto-regenerated by
        //     band_projector) is gone; the DIRECT teal→black layer (2b) is the
        //     live map now. We deliberately DO NOT create the OccupancyGridClient
        //     (no dead /mapping/obstacle_map subscription) nor the scene group.
        //     grid_group/grid_client are nulled so the (now hidden) Live
        //     checkbox wiring and the opacity registration below skip cleanly.
        this.grid_group = null;
        this.grid_client = null;

        // (2b) DIRECT raster mapper — the new direct 2D raster mapper's live
        //      grid, built straight from sensor rays (lidar hits/no-hit-free +
        //      camera obstacle/free) — independent of the octomap+DEM pipeline
        //      that feeds (2) above. Teal identifier {0,180,180} selects the
        //      DIRECT branch in map_view.js getColor(), distinct from LIVE
        //      (orange), SITE (red) and PREVIEW (blue). renderOrder DIRECT
        //      (21) sits just above LIVE (20).
        this.direct_group = new THREE.Object3D();
        viewer3d.scene.add(this.direct_group);
        this.direct_client = new ROS3D.OccupancyGridClient({
            ros: ros,
            tfClient: tfClient,
            rootObject: this.direct_group,
            continuous: true,
            compression: 'cbor',
            topic: '/mapping/direct_map',
            color: {r: 0, g: 180, b: 180},
            opacity: 0.85,
            offsetPose: new ROSLIB.Pose({
                position: new ROSLIB.Vector3({x: 0, y: 0, z: 0.021}),  // DIRECT band
                orientation: new ROSLIB.Quaternion({x: 0, y: 0, z: 0, w: 1})
            })
        });

        // vitulus_ui: register all three occupancy grids with the global
        // opacity manager (defined in map_view.js) so the "Maps opacity" /
        // "Unknown opacity" sliders in the "3D view layers" group drive them
        // alongside the base /navi_manager/map grid and the local costmap.
        // The rain radar and aerial tiles keep their own independent opacity
        // sliders.
        try {
            if (typeof MapLayerOpacity !== 'undefined') {
                var _ord = (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder : null;
                MapLayerOpacity.registerClient(this.site_client,
                    _ord ? _ord.SITE : 10);
                MapLayerOpacity.registerClient(this.preview_client,
                    _ord ? _ord.PREVIEW : 11);
                // LIVE obstacle_map retired 2026-07-19 (grid_client is null) —
                // nothing to register; the DIRECT layer carries the live map.
                MapLayerOpacity.registerClient(this.direct_client,
                    _ord ? _ord.DIRECT : 21);
            }
        } catch (e) { /* opacity manager optional */ }

        // (3) TERRAIN elevation — a textured plane in the 3D view, laid flat at
        //     z~0 UNDER the occupancy layers. We do NOT try to push
        //     grid_map_msgs/GridMap through rosbridge (no ROS3D renderer, heavy
        //     nested float message); instead we reuse the TURBO-coloured
        //     terrain_png that is ALREADY streamed as a latched CompressedImage
        //     and drape it as a map-frame plane. The DEM world bounds
        //     (min/max x,y in map metres) arrive alongside the PNG:
        //       - saved sites: mapping_manager /preview_info .terrain_bounds
        //       - live session: trajectory_dem /dem_status .terrain_bounds
        //     The scene fixed frame is /map, so a plane placed at those world
        //     coords lines up with the occupancy grids (map->map is identity).
        //     IMPORTANT: the terrain plane MUST be built with the SAME THREE
        //     module instance that owns the renderer/scene (ROS3D bundles its
        //     own private copy of THREE, distinct from the global window.THREE
        //     that three.js sets). Feeding a window.THREE Mesh/Geometry/Material
        //     to ROS3D's WebGLRenderer makes renderer.render() throw inside the
        //     rAF draw() loop; ROS3D schedules the next frame AFTER render(), so
        //     one throw kills the loop for good -> the whole 3D view freezes and
        //     stops responding (the bug this layer originally shipped with).
        //     We therefore harvest ROS3D's THREE constructors from the live
        //     scene (see _r3d()) and build the plane with those, never window.THREE.
        // this.viewer3d / this._r3dCache / this.terrain_group are already set up
        // eagerly at the top of the constructor (insertion-order hardening) —
        // do NOT reset them here or the eagerly-created terrain group would be
        // orphaned and re-created last. Only initialise the terrain-content vars.
        this.terrain_mesh = null;
        this.terrain_png = null;      // last-seen data: URI
        this.terrain_img = null;      // decoded <img> for the current PNG
        this.terrain_bounds = null;   // last-seen {min_x,min_y,max_x,max_y}

        // Layer toggles authored in map_view.html (survive index rebuild):
        //   #mapv3_chk_site => saved site_map, #mapv3_chk_live => live grid,
        //   #mapv3_chk_terrain => terrain elevation plane.
        this.el_site_status = document.getElementById("mapv3_site_status");
        this.chk_site = document.getElementById("mapv3_chk_site");
        this.chk_live = document.getElementById("mapv3_chk_live");
        this.chk_terrain = document.getElementById("mapv3_chk_terrain");
        // per-raster mgmt: the raw-raster preview visibility toggle in the top
        // layer strip (default ON — the per-row Preview button drives WHAT is
        // shown; this only hides/shows the layer as a whole). The layer stays
        // empty until a row's Preview is toggled, so having it visible by
        // default is harmless.
        this.chk_preview = document.getElementById("mapv3_chk_preview");
        // Direct raster mapper layer toggle — persisted like aerial/rain
        // (_layerPref/_saveLayerPref below), unlike the plain session-scoped
        // site/live/preview/terrain toggles above which don't survive reload.
        this.chk_direct = document.getElementById("mapv3_chk_direct");
        if (this.chk_site) {
            // persisted like direct/aerial/rain (settings-persistence pass);
            // default = the markup default (checked)
            this.chk_site.checked = this._layerPref('vitulus_layer_site', this.chk_site.checked);
            this.site_group.visible = this.chk_site.checked;
            this.chk_site.addEventListener('change', () => {
                this._saveLayerPref('vitulus_layer_site', this.chk_site.checked);
                this.site_group.visible = this.chk_site.checked;
            });
        }
        if (this.chk_preview) {
            this.chk_preview.checked = this._layerPref('vitulus_layer_preview', this.chk_preview.checked);
            this.preview_group.visible = this.chk_preview.checked;
            this.chk_preview.addEventListener('change', () => {
                this._saveLayerPref('vitulus_layer_preview', this.chk_preview.checked);
                this.preview_group.visible = this.chk_preview.checked;
            });
        }
        // LIVE obstacle_map layer retired 2026-07-19 — the checkbox is hidden in
        // the UI and grid_group is null, so there is nothing to wire. Guard so
        // this is inert whether or not the (hidden) element is present.
        if (this.chk_live && this.grid_group) {
            this.grid_group.visible = this.chk_live.checked;
            this.chk_live.addEventListener('change', () => {
                this.grid_group.visible = this.chk_live.checked;
            });
        }
        if (this.chk_terrain) {
            // The group may not exist yet (built on first terrain data). Just
            // remember the desired visibility; applyTerrainVisible() syncs it
            // whenever the group appears. Toggling NEVER builds/blocks anything.
            this.chk_terrain.checked = this._layerPref('vitulus_layer_terrain', this.chk_terrain.checked);
            this.terrain_visible = this.chk_terrain.checked;
            this.applyTerrainVisible();
            this.chk_terrain.addEventListener('change', () => {
                this._saveLayerPref('vitulus_layer_terrain', this.chk_terrain.checked);
                this.terrain_visible = this.chk_terrain.checked;
                this.applyTerrainVisible();
            });
        }
        if (this.chk_direct) {
            // TASK-style persistence (like aerial/rain): default ON, but
            // respect a stored preference across reloads.
            this.chk_direct.checked = this._layerPref('vitulus_layer_direct', true);
            this.direct_group.visible = this.chk_direct.checked;
            this.chk_direct.addEventListener('change', () => {
                this._saveLayerPref('vitulus_layer_direct', this.chk_direct.checked);
                this.direct_group.visible = this.chk_direct.checked;
            });
        }

        // (4) AERIAL tiles — MapProxy XYZ satellite/OSM tiles draped as textured
        //     planes under everything (see the AerialTiles methods below). Lazy:
        //     nothing is fetched until the checkbox is first ticked.
        this._initAerial();

        // (5) RAIN RADAR — the ČHMÚ radar composite draped as the TOP-most
        //     layer, floated a few metres above the garden (see the Rain
        //     methods below). Lazy: the /weather_alert/rain_img subscription is
        //     only created when the checkbox is first ticked.
        this._initRain();

        this.running = false;

        const pub = (name) => {
            const t = new ROSLIB.Topic({
                ros: ros, name: name, messageType: 'std_msgs/String'
            });
            t.advertise();
            return t;
        };
        this.pub_start = pub('/mapping_manager/start');
        this.pub_stop = pub('/mapping_manager/stop');
        this.pub_remove = pub('/mapping_manager/remove_site');
        this.pub_mode = pub('/mapping/gate_mode');
        this.pub_regen = pub('/mapping/regenerate');
        this.pub_save = pub('/mapping/save');
        this.pub_compare = pub('/mapping/compare');
        this.pub_show = pub('/mapping_manager/show_site');
        this.pub_clear = pub('/mapping/clear');
        this.pub_serve = pub('/mapping_manager/serve_site');
        // per-raster mgmt: preview a raw raster / delete a raster
        this.pub_preview_raster = pub('/mapping_manager/preview_raster');
        this.pub_remove_raster = pub('/mapping_manager/remove_raster');
        // COMBINED (2026-09-13): layer include/exclude + manual rebuild
        this.pub_layer_enable = pub('/mapping_manager/layer_enable');
        this.pub_rebuild_combined = pub('/mapping_manager/rebuild_combined');
        this.pub_set_band = pub('/mapping/set_band');
        this.pub_set_ranges = pub('/mapping/set_ranges');
        this.pub_set_direct = pub('/mapping/set_direct');
        this.pub_direct_preset = pub('/mapping/direct_preset');
        this.pub_reset_direct = pub('/mapping/reset_direct');

        const sub = (name, type, cb) => {
            const t = new ROSLIB.Topic({ros: ros, name: name, messageType: type});
            t.subscribe(cb);
            return t;
        };
        sub('/mapping_manager/status', 'std_msgs/String',
            (m) => this.handleManager(m));
        sub('/mapping/gate_status', 'std_msgs/String',
            (m) => this.handleGate(m));
        sub('/mapping/dem_status', 'std_msgs/String',
            (m) => this.handleDem(m));
        // projector_status RETIRED 2026-07-19: octomap/band mapping retired,
        // the direct mapper is the mapper. /mapping/projector_status was the
        // band regen/raster status (drove the hidden band + Actions status
        // lines); no longer subscribed. handleProjector() is left defined but
        // dead. The direct mapper reports its own status via direct_status.
        sub('/mapping/direct_status', 'std_msgs/String',
            (m) => this.handleDirectStatus(m));
        // vitulus-field#23: the preset list also comes from mapping_manager
        // (always running, latched) so it is filled outside a session too
        sub('/mapping_manager/direct_presets', 'std_msgs/String', (m) => {
            let d;
            try { d = JSON.parse(m.data); } catch (e) { return; }
            this._fillDirectPresets(d && d.presets);
        });

        // Terrain elevation as a 3D plane (see terrain_group above). rosbridge
        // delivers CompressedImage.data as base64. The PNG and the world bounds
        // arrive on separate topics, so we cache the newest of each and rebuild
        // the plane whenever both are present. Two sources feed the same layer:
        //   live session : /mapping/terrain_png  +  /mapping/dem_status bounds
        //   saved site   : /mapping_manager/terrain_png + /preview_info bounds
        const setTerrainPng = (m) => {
            // rosbridge delivers CompressedImage.data as base64. Decode the PNG
            // to an <img> exactly ONCE per new message (async, off the render
            // path); rebuildTerrain() then just reuses the cached decoded image.
            const uri = 'data:image/png;base64,' + m.data;
            if (uri === this.terrain_png && this.terrain_img) {
                this.rebuildTerrain();   // same png, only (maybe) bounds changed
                return;
            }
            this.terrain_png = uri;
            const img = new Image();
            img.onload = () => {
                // ignore a stale decode if a newer png arrived meanwhile
                if (this.terrain_png !== uri) { return; }
                this.terrain_img = img;
                this.rebuildTerrain();
            };
            img.onerror = () => {
                if (this.terrain_png === uri) { this.terrain_img = null; }
                console.error('[mappingv3] terrain PNG decode failed');
            };
            img.src = uri;
        };
        sub('/mapping/terrain_png', 'sensor_msgs/CompressedImage', setTerrainPng);
        sub('/mapping_manager/terrain_png', 'sensor_msgs/CompressedImage',
            setTerrainPng);
        // bounds for the SAVED-site terrain plane
        sub('/mapping_manager/preview_info', 'std_msgs/String', (m) => {
            let p;
            try { p = JSON.parse(m.data); } catch (e) { return; }
            if (!p.terrain) {
                // shown site has no terrain -> clear the plane
                this.clearTerrain();
                return;
            }
            if (p.terrain_bounds) {
                this.terrain_bounds = p.terrain_bounds;
                this.rebuildTerrain();
            }
        });

        this.btn_start.addEventListener('click', () => {
            const site = this.input_site.value.trim();
            if (!site) { this.input_site.focus(); return; }
            this.pub_start.publish(new ROSLIB.Message({data: site}));
            this._say(this.el_run, () => mapT('mapping.run.starting', {site: site}));
        });
        this.btn_stop.addEventListener('click', () => {
            this.pub_stop.publish(new ROSLIB.Message({data: ''}));
            this._say(this.el_run, () => mapT('mapping.run.stopping'));
        });
        // 2026-08-09 session controls: Reset map + Discard, both behind the
        // same double-click-confirm pattern the delete buttons use.
        this._wireDoubleClickDelete(this.btn_reset_map, () => {
            this.pub_reset_direct.publish(new ROSLIB.Message({data: ''}));
            this._say(this.el_run, () => mapT('mapping.run.erased'));
            // the Sensing layer's "already seen" swath belongs to the wiped raster
            if (this.sensing) { this.sensing.clearCoverage(); }
        }, () => mapT('mapping.btn.reset_map'));
        this._wireDoubleClickDelete(this.btn_discard, () => {
            this.pub_stop.publish(new ROSLIB.Message({data: 'discard'}));
            this._say(this.el_run, () => mapT('mapping.run.discarding'));
        }, () => mapT('mapping.btn.discard'));

        // WP-D2: "Edit map" entry — opens the in-view map editor (mapeditor.js
        // detail panel) keeping the SERVED site_map as the base. Created
        // dynamically to avoid an index.html rebuild; 2026-08-09: anchored in
        // the Maps header (next to the serving status) instead of the removed
        // session-row Serve button. Disabled until a site is being served (the
        // editor needs a served map to draw edits/waypoints against); enabled
        // in handleManager() when s.serving is set.
        // 2026-08-16: Robot marker appearance (frame/fill colour + fill
        // opacity) — persisted to localStorage; map_view.js RobotVisualization
        // applies the stored values in its periodic sweep.
        (function () {
            var frame = document.getElementById('mapv3_robot_frame');
            var fill = document.getElementById('mapv3_robot_fill');
            var fop = document.getElementById('mapv3_robot_fill_op');
            var fopv = document.getElementById('mapv3_robot_fill_op_val');
            function ls(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
            if (frame) {
                frame.value = ls('vitulus_robot_frame_color', '#ffffff');
                frame.addEventListener('input', function () {
                    try { localStorage.setItem('vitulus_robot_frame_color', frame.value); } catch (e) {}
                });
            }
            if (fill) {
                fill.value = ls('vitulus_robot_fill_color', '#ffffff');
                fill.addEventListener('input', function () {
                    try { localStorage.setItem('vitulus_robot_fill_color', fill.value); } catch (e) {}
                });
            }
            if (fop) {
                fop.value = ls('vitulus_robot_fill_opacity', '0.35');
                if (fopv) fopv.textContent = Math.round(parseFloat(fop.value) * 100) + '%';
                fop.addEventListener('input', function () {
                    if (fopv) fopv.textContent = Math.round(parseFloat(fop.value) * 100) + '%';
                    try { localStorage.setItem('vitulus_robot_fill_opacity', fop.value); } catch (e) {}
                });
            }
        })();
        // 2026-08-16: Clear costmaps — the live obstacle memory accumulates
        // while driving and confused the user as an 'undeletable map'.
        const btnCc = document.getElementById('mapv3_btn_clear_costmaps');
        if (btnCc) {
            const svcClear = new ROSLIB.Service({
                ros: ros, name: '/move_base_flex/clear_costmaps',
                serviceType: 'std_srvs/Empty'
            });
            btnCc.addEventListener('click', () => {
                btnCc.disabled = true;
                svcClear.callService(new ROSLIB.ServiceRequest({}), () => {
                    btnCc.disabled = false;
                    this._say(this.el_site_status, () => mapT('mapping.site.costmaps_cleared'));
                }, () => { btnCc.disabled = false; });
            });
        }
        // 2026-08-16: Deactivate — factory-fresh test state (serve 'none')
        const btnDeact = document.getElementById('mapv3_btn_deactivate');
        this._wireDoubleClickDelete(btnDeact, () => {
            this.pub_serve.publish(new ROSLIB.Message({data: 'none'}));
            if (this.el_serving) {
                this.el_serving.hidden = false;
                this._say(this.el_serving, () => mapT('mapping.serving.deactivating'));
                vtTone(this.el_serving, '');
            }
        }, () => mapT('mapping.btn.deactivate'));
        // 2026-08-16: the JS-created "Edit map" button in the Saved maps header
        // is GONE — it duplicated the header Edit button (both open the same
        // editor; the header toggle now passes keepBase:true itself).
        // the middle mode button is 'Fused' now (relabel here to avoid an
        // index.html rebuild; fused = map from the fused pose, the default)
        mapTag(this.btn_mode_force, 'mapping.mode.fused');
        mapTag(this.btn_mode_force, 'mapping.mode.fused_tip', 'title');
        mapTag(this.btn_mode_rtk, 'mapping.mode.rtk_tip', 'title');
        this.btn_mode_rtk.addEventListener('click', () => this.setMode('rtk'));
        this.btn_mode_force.addEventListener('click', () => this.setMode('fused'));
        this.btn_mode_off.addEventListener('click', () => this.setMode('off'));
        this.btn_raster.addEventListener('click', () => {
            this._say(this.el_proj, () => mapT('mapping.proj.regenerating'));
            this.pub_regen.publish(new ROSLIB.Message({data: ''}));
        });
        this.btn_save.addEventListener('click', () => {
            this._say(this.el_proj, () => mapT('mapping.proj.saving'));
            this.pub_save.publish(new ROSLIB.Message({data: ''}));
        });
        this.btn_compare.addEventListener('click', () => {
            this._say(this.el_proj, () => mapT('mapping.proj.comparing'));
            this.pub_compare.publish(new ROSLIB.Message({data: ''}));
        });

        // Obstacle classification (band) — apply live tuning to band_projector.
        // Mark inputs as user-edited so incoming projector_status doesn't
        // overwrite half-typed values; they re-sync after Apply.
        [this.in_band_min, this.in_band_max, this.in_min_evidence,
         this.in_min_cluster].forEach((el) => {
            if (el) el.addEventListener('input', () => { this.band_edited = true; });
        });
        if (this.btn_apply_band) {
            this.btn_apply_band.addEventListener('click', () => this.applyBand());
        }

        // Range caps — same edit-guard + apply pattern as the band controls.
        [this.in_lidar_max, this.in_depth_max].forEach((el) => {
            if (el) el.addEventListener('input', () => { this.ranges_edited = true; });
        });
        if (this.btn_apply_ranges) {
            this.btn_apply_ranges.addEventListener('click', () => this.applyRanges());
        }

        // Direct mapper — LIVE controls (2026-08-09). Sliders publish a
        // debounced partial set_direct on input; checkboxes publish
        // immediately on change. The control set is independent of session
        // Start/Stop so it stays enabled regardless of setActionsEnabled()
        // (with no session there is just nobody listening — the pending
        // timeout in _liveDirectSend reports that honestly).
        this._directSliders.forEach(([el, key, dec, unit]) => {
            if (!el) return;
            el.addEventListener('input', () => {
                this._directLastTouch = Date.now();
                this._setDirectValLabel(el, dec, unit);
                let v = parseFloat(el.value);
                const partial = {};
                partial[key] = (dec === 0) ? Math.round(v) : v;
                // keep the height window valid while dragging: backend
                // rejects min >= max as one atomic dict, so drag the other
                // edge along instead of publishing a doomed pair
                if (key === 'cam_obstacle_min_h' && this.in_direct_obs_hmax) {
                    const hmax = parseFloat(this.in_direct_obs_hmax.value);
                    if (v >= hmax) {
                        const nv = Math.min(v + 0.05, 2.5);
                        this.in_direct_obs_hmax.value = nv;
                        this._setDirectValLabel(this.in_direct_obs_hmax, 2, ' m');
                        partial['cam_obstacle_max_h'] = nv;
                    }
                }
                if (key === 'cam_obstacle_max_h' && this.in_direct_obs_hmin) {
                    const hmin = parseFloat(this.in_direct_obs_hmin.value);
                    if (v <= hmin) {
                        const nv = Math.max(v - 0.05, 0);
                        this.in_direct_obs_hmin.value = nv;
                        this._setDirectValLabel(this.in_direct_obs_hmin, 2, ' m');
                        partial['cam_obstacle_min_h'] = nv;
                    }
                }
                this._liveDirectSend(partial);
            });
        });
        this._directChecks.forEach(([el, key]) => {
            if (!el) return;
            el.addEventListener('change', () => {
                this._directLastTouch = Date.now();
                const partial = {};
                partial[key] = !!el.checked;
                this._liveDirectSend(partial);
            });
        });
        if (this.btn_apply_direct) {
            this.btn_apply_direct.addEventListener('click', () => this.applyDirect());
        }
        // environment presets: applied/saved/deleted SERVER-side by
        // direct_raster (topic /mapping/direct_preset); the select is
        // populated by _fillDirectPresets from direct_status.presets and
        // /mapping_manager/direct_presets.
        if (this.btn_direct_preset_load) {
            this.btn_direct_preset_load.addEventListener('click', () => {
                const name = this.sel_direct_preset && this.sel_direct_preset.value;
                if (!name) return;
                this.pub_direct_preset.publish(new ROSLIB.Message(
                    {data: JSON.stringify({action: 'apply', name: name})}));
                // let the echoed settings re-sync the sliders right away
                this._directLastTouch = 0;
                this._markDirectPending();
            });
        }
        if (this.btn_direct_preset_save) {
            this.btn_direct_preset_save.addEventListener('click', () => {
                let name = this.in_direct_preset_name
                    ? this.in_direct_preset_name.value.trim() : '';
                if (!name && this.sel_direct_preset) {
                    name = this.sel_direct_preset.value;   // overwrite selected
                }
                if (!name) {
                    if (this.el_direct_status) {
                        this._say(this.el_direct_status, () => mapT('mapping.preset.need_name'));
                        vtTone(this.el_direct_status, 'warn');
                    }
                    return;
                }
                this.pub_direct_preset.publish(new ROSLIB.Message(
                    {data: JSON.stringify({action: 'save', name: name})}));
                this._markDirectPending();
            });
        }
        if (this.btn_direct_preset_del) {
            this.btn_direct_preset_del.addEventListener('click', () => {
                const name = this.sel_direct_preset && this.sel_direct_preset.value;
                if (!name) return;
                this.pub_direct_preset.publish(new ROSLIB.Message(
                    {data: JSON.stringify({action: 'delete', name: name})}));
                this._markDirectPending();
            });
        }

        // Clear 3D — reset the octomap archive after a localization
        // correction shifted older data (created dynamically, like the
        // caption, to avoid an index.html rebuild)
        this.btn_clear = document.createElement('button');
        this.btn_clear.className = 'btn btn-outline-danger';
        this.btn_clear.type = 'button';
        this.btn_clear.textContent = mapT('mapping.clear3d');
        this.btn_clear.title = mapT('mapping.clear3d_tip');
        mapTag(this.btn_clear, 'mapping.clear3d');
        mapTag(this.btn_clear, 'mapping.clear3d_tip', 'title');
        this.btn_clear.disabled = true;
        this.btn_raster.parentNode.appendChild(this.btn_clear);
        this.btn_clear.addEventListener('click', () => {
            if (confirm(mapT('mapping.clear3d_confirm'))) {
                this.pub_clear.publish(new ROSLIB.Message({data: ''}));
            }
        });

        // i18n: a language switch re-renders what this module drew itself
        if (window.VTI18n) { VTI18n.onChange(() => this._onLang()); }
    }

    // ---- i18n ---------------------------------------------------------------
    // Draw a status line from a render fn and remember the fn, so a language
    // switch can draw it again (the fn closes over the data it shows).
    _say(el, fn, html) {
        if (!el) { return; }
        const s = fn();
        if (html) { el.innerHTML = s; } else { el.textContent = s; }
        el._mapSay = fn;
        el._mapSayHtml = !!html;
        this._sayEls.add(el);
    }

    _onLang() {
        this._sayEls.forEach((el) => {
            if (!el._mapSay) { return; }
            try {
                const s = el._mapSay();
                if (el._mapSayHtml) { el.innerHTML = s; } else { el.textContent = s; }
            } catch (e) { /* keep the old text */ }
        });
        this._relabel.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
        if (this._lastPresets) {
            this._directPresetSig = '';
            this._fillDirectPresets(this._lastPresets);
        }
        // the data handlers draw the rest (sites list, tooltips, gate, DEM)
        try {
            if (this._lastManagerMsg) {
                this._lastSitesSig = null;
                this.handleManager(this._lastManagerMsg);
            }
            if (this._lastGateMsg) { this.handleGate(this._lastGateMsg); }
            if (this._lastDemMsg) { this._renderDem(this._lastDemMsg); }
            if (this._lastDirectMsg && !this._direct_apply_pending) {
                this.handleDirectStatus(this._lastDirectMsg);
            }
        } catch (e) { console.error('[mappingv3] language re-render failed:', e); }
    }

    setMode(mode) {
        this.pub_mode.publish(new ROSLIB.Message({data: mode}));
    }

    // =====================================================================
    // AERIAL TILES layer — MapProxy XYZ tiles draped in the /map frame.
    // ---------------------------------------------------------------------
    // MapProxy runs on the robot at :8082 and serves EPSG:3857 XYZ tiles:
    //   satellite : http://<host>:8082/wmts/gm_layer/gm_grid/{z}/{x}/{y}.png
    //   osm       : http://<host>:8082/wmts/osm_demo/webmercator/{z}/{x}/{y}.png
    // (WMTS with GLOBAL_MERCATOR grid, origin upper-left => standard slippy XYZ,
    //  y NOT flipped. CORS: Access-Control-Allow-Origin:* so crossOrigin works.)
    //
    // GEOREF: the /map frame is anchored to the served site datum (fetched from
    // webnode /api/datum): map origin = (utm_e, utm_n) in UTM 33N, map rotated
    // by yaw_rad vs UTM grid north. UTM grid north is itself turned from TRUE
    // north by the grid convergence (vitulus-field#32: 2.01 deg at the west edge
    // of zone 33, 0.07 deg near 15 E), and the tiles below are laid out in
    // true east/north metres — so the group carries -(yaw_rad - convergence),
    // the map's rotation vs TRUE north (_mapTrueYaw), and inside it each tile
    // plane is positioned by a LOCAL flat-earth conversion around the datum's
    // origin_lat/origin_lon (sub-cm over ~100 m). For a map point the true
    // east/north offset from the origin is R(+trueYaw)*(x,y); convert to lat/lon
    // via metres-per-degree at the origin, then to XYZ tiles. Each tile's
    // geographic bounds convert back the same way (inverse), giving an
    // axis-aligned plane in the group's (pre-rotation) frame.
    //
    // Every step is try/catch-wrapped and images load async with crossOrigin;
    // a bad tile skips itself and NEVER touches the ROS3D render loop.
    // vitulus_ui TASK3 — per-layer checkbox persistence. Aerial basemap and rain
    // radar now DEFAULT ON, but a user's explicit toggle is remembered across
    // reloads. '1'/'0' stored per key; absent => use the supplied default (ON).
    _layerPref(key, dflt) {
        try {
            var v = localStorage.getItem(key);
            if (v === '1') { return true; }
            if (v === '0') { return false; }
        } catch (e) { /* localStorage unavailable — fall through to default */ }
        return dflt;
    }
    _saveLayerPref(key, on) {
        try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* ignore */ }
    }
    // Settings-persistence pass 2026-08-15 — generic string prefs + control
    // restore/wire helpers, same storage convention as _layerPref (absent key
    // => keep the markup default). Purely client-side view settings only.
    _strPref(key, dflt) {
        try {
            var v = localStorage.getItem(key);
            if (v !== null) { return v; }
        } catch (e) { /* localStorage unavailable */ }
        return dflt;
    }
    _saveStrPref(key, val) {
        try { localStorage.setItem(key, String(val)); } catch (e) { /* ignore */ }
    }
    // Restore a <select> from storage (only if the stored value is a real
    // option) and save every later change.
    _persistSelect(el, key) {
        if (!el) return;
        var v = this._strPref(key, null);
        if (v !== null) {
            for (var i = 0; i < el.options.length; i++) {
                if (el.options[i].value === v) { el.value = v; break; }
            }
        }
        el.addEventListener('change', () => { this._saveStrPref(key, el.value); });
    }
    // Restore a range/number input from storage (clamped to min/max) and save
    // every later input.
    _persistRange(el, key) {
        if (!el) return;
        var v = parseFloat(this._strPref(key, ''));
        if (isFinite(v)) {
            var mn = parseFloat(el.min), mx = parseFloat(el.max);
            if (isFinite(mn)) v = Math.max(mn, v);
            if (isFinite(mx)) v = Math.min(mx, v);
            el.value = String(v);
        }
        el.addEventListener('input', () => { this._saveStrPref(key, el.value); });
    }

    _initAerial() {
        // NB: aerial_group is created EAGERLY in the constructor (insertion-order
        // hardening); do NOT null it here or we'd orphan that group and a fresh
        // lazy one would insert last again. Preserve it if already present.
        if (typeof this.aerial_group === 'undefined') { this.aerial_group = null; }
        this.aerial_datum = null;      // cached /api/datum result
        this.aerial_meshes = [];       // current tile meshes
        this.aerial_token = 0;         // bumps to cancel stale async builds
        this.aerial_area_m = 100;      // square side around map origin (metres)
        this.AERIAL_TILE_CAP = 400;    // hard cap on tiles per rebuild

        this.chk_aerial = document.getElementById('mapv3_chk_aerial');
        this.sel_aerial_src = document.getElementById('mapv3_aerial_src');
        this.sel_aerial_zoom = document.getElementById('mapv3_aerial_zoom');
        this.sel_aerial_area = document.getElementById('mapv3_aerial_area');
        this.in_aerial_opacity = document.getElementById('mapv3_aerial_opacity');
        this.el_aerial_status = document.getElementById('mapv3_aerial_status');

        // MapProxy host: same machine that serves this page, port 8082.
        this.aerial_host = window.location.hostname + ':8082';

        // Persist source/zoom/area/opacity across reloads (restore BEFORE the
        // boot-time rebuildAerial below so the first build uses them).
        this._persistSelect(this.sel_aerial_src, 'vitulus_aerial_src');
        this._persistSelect(this.sel_aerial_zoom, 'vitulus_aerial_zoom');
        this._persistSelect(this.sel_aerial_area, 'vitulus_aerial_area');
        this._persistRange(this.in_aerial_opacity, 'vitulus_aerial_opacity');

        if (this.chk_aerial) {
            this.chk_aerial.addEventListener('change', () => {
                this._saveLayerPref('vitulus_layer_aerial', this.chk_aerial.checked);
                if (this.chk_aerial.checked) {
                    // 2026-08-16 field fix: re-ticking the layer must RE-FETCH
                    // the datum — the cache made a toggle useless after a new
                    // site's datum was captured mid-session (only a full page
                    // reload realigned the tiles).
                    this.aerial_datum = null;
                    this.rebuildAerial();
                } else if (this.aerial_group) {
                    this.aerial_group.visible = false;
                }
            });
            // TASK3: DEFAULT ON (respect a stored preference if the user has
            // toggled before). Applying it here takes the SAME path as a manual
            // early tick — rebuildAerial() fetches /api/datum itself and is
            // token-guarded, so a boot-time call before the datum has arrived
            // behaves exactly like ticking the box the moment the page loads.
            this.chk_aerial.checked = this._layerPref('vitulus_layer_aerial', true);
            if (this.chk_aerial.checked) { this.rebuildAerial(); }
            // 2026-08-16 boot-retry (field): the boot-time build can bail while
            // the 3D viewer / datum are still coming up and was never retried —
            // after a page reload the tiles only appeared once something (a
            // zoom change) forced a rebuild. Retry until one build lands.
            let _bootTries = 0;
            const _bootTimer = setInterval(() => {
                if (this._aerialBuiltOnce || !this.chk_aerial.checked
                        || ++_bootTries > 5) {
                    clearInterval(_bootTimer);
                    return;
                }
                this.aerial_datum = null;
                this.rebuildAerial();
            }, 3000);
        }
        [this.sel_aerial_src, this.sel_aerial_zoom, this.sel_aerial_area].forEach((el) => {
            if (el) el.addEventListener('change', () => {
                if (this.chk_aerial && this.chk_aerial.checked) this.rebuildAerial();
            });
        });
        if (this.in_aerial_opacity) {
            this.in_aerial_opacity.addEventListener('input', () => {
                this._applyAerialOpacity();
            });
        }

        // --- per-map / per-layer tile OFFSET (persisted ON THE ROBOT) -------
        this.tile_offsets = {};       // mirror of the robot store
        this.tile_offset_map = '';    // active map name, resolved by the robot
        this._tileOffsetPost = null;  // debounce timer for the POST
        this._initTileOffsetControl();
        this._loadTileOffsets();
        // Switching the tile SOURCE switches the offset key too: show and apply
        // that layer's own correction immediately (the rebuild is already wired
        // above; this only refreshes the offset side).
        if (this.sel_aerial_src) {
            this.sel_aerial_src.addEventListener('change', () => {
                this._updateTileOffsetReadout();
                this._applyAerialOffset();
            });
        }
    }

    // =====================================================================
    // AERIAL TILE OFFSET — state, rendering and the drawer control.
    // ---------------------------------------------------------------------
    // Applied as a pure TRANSLATION of `aerial_group` (the MapProxy tile
    // planes) in the /map frame. Nothing else moves: the occupancy grids, the
    // costmaps, the robot model and the lidar overlays keep their own poses.
    // Every step is guarded — a failure degrades to "no offset", never to a
    // broken map view.
    // =====================================================================

    // Tile layer id the offset is keyed on ('sat' | 'cuzk' | 'osm').
    _aerialLayerId() {
        return (this.sel_aerial_src && this.sel_aerial_src.value) || 'sat';
    }

    _currentTileOffset() {
        return tileOffsetGet(this.tile_offsets, this.tile_offset_map,
                             this._aerialLayerId());
    }

    // THE render hook: translate the aerial tile group. `position` sits outside
    // the group's own -yaw rotation, so it is a plain /map-frame shift.
    _applyAerialOffset() {
        try {
            const g = this.aerial_group;
            if (!g || !g.position) { return; }
            const o = this._currentTileOffset();
            g.position.x = o.dx;
            g.position.y = o.dy;
        } catch (e) { /* an offset must never break the 3D view */ }
    }

    // `fn` renders the text (re-run on a language switch); '' clears it
    _tileOffsetStatus(fn, warn) {
        if (!this.el_tile_off_status) { return; }
        this._say(this.el_tile_off_status, (typeof fn === 'function') ? fn : () => (fn || ''));
        vtTone(this.el_tile_off_status, warn ? 'warn' : '');
    }

    _updateTileOffsetReadout() {
        const o = this._currentTileOffset();
        if (this.el_tile_off_val) {
            this.el_tile_off_val.textContent = tileOffsetFormat(o);
        }
        if (this.el_tile_off_scope) {
            this.el_tile_off_scope.textContent =
                (this.tile_offset_map || '—') + ' / ' + this._aerialLayerId();
        }
        const zero = (o.dx === 0 && o.dy === 0);
        if (this.btn_tile_off_reset) { this.btn_tile_off_reset.disabled = zero; }
        if (this.btn_tile_off_reset_all) {
            const layers = this.tile_offsets && this.tile_offset_map
                ? this.tile_offsets[this.tile_offset_map] : null;
            this.btn_tile_off_reset_all.disabled =
                !(layers && Object.keys(layers).length);
        }
    }

    // Fetch the robot-side store. Called on init and whenever the served map
    // changes; a failure leaves the layer unshifted.
    async _loadTileOffsets() {
        try {
            const r = await fetch('/api/tile_offsets', { cache: 'no-store' });
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            const j = await r.json();
            this.tile_offsets = (j && j.offsets && typeof j.offsets === 'object')
                                ? j.offsets : {};
            this.tile_offset_map = (j && typeof j.active_map === 'string')
                                   ? j.active_map : '';
            this._tileOffsetStatus('');
        } catch (e) {
            console.warn('[mappingv3] tile offsets unavailable:', e);
            if (!this.tile_offsets) { this.tile_offsets = {}; }
            this._tileOffsetStatus(() => mapT('mapping.offset.unavailable'), true);
        }
        this._updateTileOffsetReadout();
        this._applyAerialOffset();
    }

    // One nudge click / keypress: optimistic move now, debounced POST after.
    _nudgeTileOffset(dxStep, dyStep) {
        if (!this.tile_offset_map) {
            this._tileOffsetStatus(() => mapT('mapping.offset.no_map'), true);
            return;
        }
        const layer = this._aerialLayerId();
        const next = tileOffsetNudge(this._currentTileOffset(), dxStep, dyStep);
        this.tile_offsets = tileOffsetPut(this.tile_offsets,
                                          this.tile_offset_map, layer, next);
        this._applyAerialOffset();
        this._updateTileOffsetReadout();
        this._queueTileOffsetPost(layer, next);
    }

    _queueTileOffsetPost(layer, off) {
        if (this._tileOffsetPost) { clearTimeout(this._tileOffsetPost); }
        const map = this.tile_offset_map;
        this._tileOffsetStatus(() => mapT('mapping.offset.saving'));
        this._tileOffsetPost = setTimeout(() => {
            this._tileOffsetPost = null;
            fetch('/api/tile_offsets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ map: map, layer: layer,
                                       dx: off.dx, dy: off.dy }),
            }).then((r) => r.json()).then((j) => {
                if (!j || j.ok !== true) {
                    const err = (j && j.error) || null;
                    this._tileOffsetStatus(() => mapT('mapping.offset.save_failed',
                        {error: err || mapT('common.unknown')}), true);
                } else {
                    this._tileOffsetStatus(() => mapT('mapping.offset.saved'));
                }
            }).catch(() => {
                this._tileOffsetStatus(() => mapT('mapping.offset.save_unreachable'), true);
            });
        }, 400);
    }

    // allLayers=false -> reset the current tile layer; true -> the whole map.
    _resetTileOffset(allLayers) {
        const map = this.tile_offset_map;
        if (!map) { return; }
        if (this._tileOffsetPost) {
            clearTimeout(this._tileOffsetPost);
            this._tileOffsetPost = null;
        }
        const layer = this._aerialLayerId();
        if (allLayers) {
            if (this.tile_offsets) { delete this.tile_offsets[map]; }
        } else {
            this.tile_offsets = tileOffsetPut(this.tile_offsets, map, layer,
                                              { dx: 0, dy: 0 });
        }
        this._applyAerialOffset();
        this._updateTileOffsetReadout();
        this._tileOffsetStatus(() => mapT('mapping.offset.resetting'));
        const body = allLayers ? { map: map } : { map: map, layer: layer };
        fetch('/api/tile_offsets/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then((r) => r.json()).then((j) => {
            if (!j || j.ok !== true) {
                const err = (j && j.error) || null;
                this._tileOffsetStatus(() => mapT('mapping.offset.reset_failed',
                    {error: err || mapT('common.unknown')}), true);
            } else {
                this._tileOffsetStatus(() => mapT(allLayers
                    ? 'mapping.offset.reset_all_done' : 'mapping.offset.reset_done'));
            }
        }).catch(() => {
            this._tileOffsetStatus(() => mapT('mapping.offset.reset_unreachable'), true);
        });
    }

    _initTileOffsetControl() {
        this.el_tile_off_box = document.getElementById('mapv3_aerial_offset');
        this.el_tile_off_val = document.getElementById('mapv3_aerial_offset_val');
        this.el_tile_off_scope = document.getElementById('mapv3_aerial_offset_scope');
        this.el_tile_off_status = document.getElementById('mapv3_aerial_offset_status');
        this.sel_tile_off_step = document.getElementById('mapv3_aerial_offset_step');
        this.btn_tile_off_reset = document.getElementById('mapv3_aerial_offset_reset');
        this.btn_tile_off_reset_all = document.getElementById('mapv3_aerial_offset_reset_all');
        if (!this.el_tile_off_box) { return; }   // markup absent: state-only

        // step selector persists client-side like the other aerial selects
        this._persistSelect(this.sel_tile_off_step, 'vitulus_aerial_offset_step');

        const step = (coarse) => {
            let s = this.sel_tile_off_step
                ? parseFloat(this.sel_tile_off_step.value) : 0.1;
            if (!(s > 0)) { s = 0.1; }
            return coarse ? s * 5 : s;      // shift = coarse
        };
        // Buttons are labelled by the direction the IMAGERY moves on screen:
        // North/South = +/- map y, East/West = +/- map x.
        const DIRS = {
            mapv3_aerial_offset_up:    [0, 1],
            mapv3_aerial_offset_down:  [0, -1],
            mapv3_aerial_offset_left:  [-1, 0],
            mapv3_aerial_offset_right: [1, 0],
        };
        Object.keys(DIRS).forEach((id) => {
            const b = document.getElementById(id);
            if (!b) { return; }
            const [ux, uy] = DIRS[id];
            b.addEventListener('click', (ev) => {
                const s = step(ev && ev.shiftKey);
                this._nudgeTileOffset(ux * s, uy * s);
            });
        });
        if (this.btn_tile_off_reset) {
            this.btn_tile_off_reset.addEventListener('click',
                () => this._resetTileOffset(false));
        }
        if (this.btn_tile_off_reset_all) {
            this.btn_tile_off_reset_all.addEventListener('click',
                () => this._resetTileOffset(true));
        }
        // Keyboard nudge while the control has focus (arrow keys, shift=coarse).
        this.el_tile_off_box.addEventListener('keydown', (ev) => {
            const K = {
                ArrowUp: [0, 1], ArrowDown: [0, -1],
                ArrowLeft: [-1, 0], ArrowRight: [1, 0],
            };
            const d = K[ev.key];
            if (!d) { return; }
            ev.preventDefault();
            const s = step(ev.shiftKey);
            this._nudgeTileOffset(d[0] * s, d[1] * s);
        });
    }

    _aerialSources() {
        // discovered from MapProxy demo/WMTS: gm_layer = Google satellite,
        // osm_demo = OSM streets. Both EPSG:3857 XYZ (origin ul, y not flipped).
        return {
            sat: { layer: 'gm_layer', grid: 'gm_grid', label: 'satellite' },
            cuzk: { layer: 'cuzk_layer', grid: 'gm_grid', label: 'ČÚZK orto' },
            osm: { layer: 'osm_demo', grid: 'webmercator', label: 'OSM' },
        };
    }

    // the source's name for the status line ('satellite' is a word, the rest names)
    _aerialLabel(key, src) {
        return (src && src.layer === 'gm_layer') ? mapT('mapping.aerial.src_sat') : src.label;
    }

    _aerialTileUrl(src, z, x, y) {
        return 'http://' + this.aerial_host + '/wmts/' + src.layer + '/' +
               src.grid + '/' + z + '/' + x + '/' + y + '.png';
    }

    _applyAerialOpacity() {
        if (!this.in_aerial_opacity) return;
        const op = parseFloat(this.in_aerial_opacity.value);
        if (!(op >= 0 && op <= 1)) return;
        this.aerial_meshes.forEach((m) => {
            try { if (m.material) { m.material.opacity = op; } } catch (e) {}
        });
    }

    _ensureAerialGroup() {
        if (this.aerial_group) { return this.aerial_group; }
        const T = this._r3d();
        if (!T || !this.viewer3d || !this.viewer3d.scene) { return null; }
        this.aerial_group = new T.Object3D();
        // BOTTOM layer of the whole scene: z + renderOrder from the explicit
        // layer-ordering contract (MapLayerOrder in map_view.js). Sits under the
        // terrain (-0.02) and every occupancy grid. renderOrder is what actually
        // guarantees it paints first now that the grids are transparent — z alone
        // is a near-tie the transparent sort can't be trusted to resolve.
        this.aerial_group.position.z =
            (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder.Z_AERIAL : -0.05;
        this.viewer3d.scene.add(this.aerial_group);
        // Per-map/per-layer alignment nudge (robot-persisted). Applied as a
        // translation of THIS group only — see _applyAerialOffset.
        this._applyAerialOffset();
        return this.aerial_group;
    }

    _disposeAerialMeshes() {
        const group = this.aerial_group;
        this.aerial_meshes.forEach((m) => {
            try {
                if (group) group.remove(m);
                m.geometry && m.geometry.dispose();
                if (m.material) {
                    m.material.map && m.material.map.dispose();
                    m.material.dispose();
                }
            } catch (e) { /* best-effort */ }
        });
        this.aerial_meshes = [];
    }

    // metres-per-degree of latitude / longitude at a given latitude (WGS84).
    _metersPerDeg(latDeg) {
        const phi = latDeg * Math.PI / 180.0;
        const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) +
                     1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
        const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) +
                     0.118 * Math.cos(5 * phi);
        return { mLat, mLon };
    }

    // The map's rotation vs TRUE north (rad, CCW) from the site datum:
    // yaw_rad is the rotation vs UTM GRID north, and grid north differs from
    // true north by the grid convergence  gamma = atan(tan(lon - lon0) * sin(lat))
    // (lon0 = central meridian of the zone). On the robot the map frame is
    // true-north ENU, so this is ~0 and yaw_rad ~= gamma (#32).
    _mapTrueYaw(d) {
        const yaw = d.yaw_rad || 0.0;
        if (d.origin_lat == null || d.origin_lon == null) { return yaw; }
        const zone = d.utm_zone || 33;
        const lon0 = zone * 6 - 183;
        const phi = d.origin_lat * Math.PI / 180.0;
        const dl = (d.origin_lon - lon0) * Math.PI / 180.0;
        const gamma = Math.atan(Math.tan(dl) * Math.sin(phi));
        return yaw - gamma;
    }

    // WGS84 lon/lat -> slippy XYZ tile coords (fractional) at zoom z.
    _lonLatToTile(lon, lat, z) {
        const n = Math.pow(2, z);
        const x = (lon + 180) / 360 * n;
        const latR = lat * Math.PI / 180.0;
        const y = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
        return { x, y };
    }

    // slippy tile (integer x,y at zoom z) -> WGS84 lon/lat of its NW corner.
    _tileToLonLat(x, y, z) {
        const n = Math.pow(2, z);
        const lon = x / n * 360 - 180;
        const latR = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
        return { lon, lat: latR * 180 / Math.PI };
    }

    // Current 3D view expressed in MAP metres: the look-at centre and the
    // half-width/half-height the camera frames on the ground plane, plus the
    // canvas pixel height (for the screen-resolution zoom match). Returns null
    // if the camera can't be read (stub viewer) so callers fall back to the
    // legacy fixed-area coverage. Near-ortho top-down: visible half-height =
    // distance*tan(fov/2), half-width = that*aspect.
    _aerialViewParams() {
        const cam = this.viewer3d && this.viewer3d.camera;
        const ctrl = this.viewer3d && this.viewer3d.cameraControls;
        if (!cam || !ctrl || !ctrl.center || !cam.position) { return null; }
        let dist;
        try { dist = cam.position.distanceTo(ctrl.center); }
        catch (e) { return null; }
        if (!(dist > 0)) { return null; }
        const fovDeg = cam.fov > 0 ? cam.fov : 40;
        const t = Math.tan((fovDeg * Math.PI / 180.0) / 2.0);
        const aspect = cam.aspect > 0 ? cam.aspect : 1.0;
        if (!(t > 0)) { return null; }
        const halfH = dist * t;
        const halfW = halfH * aspect;
        let heightPx = 0;
        try {
            const dom = this.viewer3d.renderer && this.viewer3d.renderer.domElement;
            heightPx = (dom && (dom.clientHeight || dom.height)) || 0;
        } catch (e) { /* stub */ }
        if (!(heightPx > 0)) {
            const mv = document.getElementById('map_view');
            heightPx = (mv && mv.clientHeight) || 800;
        }
        return { cx: ctrl.center.x, cy: ctrl.center.y, halfW, halfH, heightPx };
    }

    // Debounced camera-follow: after the view stops moving, refit the aerial
    // basemap to the current viewport (and adaptive zoom). rebuildAerial()
    // itself skips the work if the covering tile set is unchanged, so panning
    // within the same tiles is free.
    _scheduleAerialFollow() {
        if (!(this.chk_aerial && this.chk_aerial.checked)) { return; }
        if (this._aerialFollowTimer) { clearTimeout(this._aerialFollowTimer); }
        this._aerialFollowTimer = setTimeout(() => {
            this._aerialFollowTimer = null;
            if (this.chk_aerial && this.chk_aerial.checked) { this.rebuildAerial(); }
        }, 220);
    }

    // Build (or rebuild) the aerial tile planes. Async, cancellable, fully
    // guarded. Fetches the datum first, then covers the CURRENT viewport with
    // tiles at a zoom matched to the on-screen resolution (never finer than the
    // configured detail cap) — so standard zoom stays crisp and only dolling
    // out past the default limit steps down to coarser world-scale tiles.
    async rebuildAerial() {
        // status(fn, warn): fn renders the text (re-run on a language switch)
        const status = (fn, warn) => {
            if (this.el_aerial_status) {
                this._say(this.el_aerial_status, fn);
                vtTone(this.el_aerial_status, warn ? 'warn' : '');
            }
        };
        const token = ++this.aerial_token;
        try {
            // (1) datum — cache once; refetch only if we don't have it.
            if (!this.aerial_datum) {
                status(() => mapT('mapping.aerial.loading_datum'));
                const resp = await fetch('/api/datum', { cache: 'no-store' });
                const dj = resp.ok ? await resp.json() : null;
                // ok:false = no served site right now (normal while recording a
                // new map) — say so, do not cache, try again next time.
                if (!dj || dj.ok === false) {
                    status(() => mapT('mapping.aerial.no_datum'), true);
                    return;
                }
                this.aerial_datum = dj;
            }
            if (token !== this.aerial_token) { return; }
            const d = this.aerial_datum;
            if (d.origin_lat == null || d.origin_lon == null) {
                status(() => mapT('mapping.datum_no_origin'), true);
                return;
            }

            const T = this._r3d();
            const group = this._ensureAerialGroup();
            if (!T || !group) { status(() => mapT('mapping.not_ready_3d'), true); return; }

            // group carries the -trueYaw rotation: map = R(-trueYaw)*(true
            // east/north offset), so a plane laid out in true-north metres
            // inside the group ends up in the map frame. Rotation about +z.
            const yaw = this._mapTrueYaw(d);
            group.rotation.z = -yaw;
            group.visible = true;
            // re-assert the alignment offset on every rebuild (the group is
            // reused, but a source/map switch changes which offset applies).
            this._applyAerialOffset();
            this._aerialBuiltOnce = true;   // boot-retry: a build got this far

            const srcKey = this.sel_aerial_src ? this.sel_aerial_src.value : 'sat';
            const src = this._aerialSources()[srcKey] || this._aerialSources().sat;
            // The configured zoom is the DETAIL CAP: the most detailed level we
            // ever use. gm_grid now has 22 levels (max z21 — Google z20, CUZK
            // 12.5cm ortofoto); the OSM webmercator grid still tops out at z19,
            // so the cap is clamped per-source (src.maxz), not globally.
            const srcMaxZ = (src.grid === 'gm_grid') ? 21 : 19;
            let zCap = this.sel_aerial_zoom ?
                    parseInt(this.sel_aerial_zoom.value, 10) : 19;
            if (!(zCap >= 0)) { zCap = 19; }
            zCap = Math.max(0, Math.min(srcMaxZ, zCap));

            const { mLat, mLon } = this._metersPerDeg(d.origin_lat);
            const cornerLonLat = (e, n) => ({
                lon: d.origin_lon + e / mLon,
                lat: d.origin_lat + n / mLat,
            });

            // (2) COVERAGE — follow the current viewport. Take the 4 view corners
            // (map metres, +margin), rotate map->true east/north (R(+trueYaw)),
            // and cover their bounding box. Fall back to a square of the manual
            // area around the origin if the camera can't be read (stub viewer).
            const yaw2 = yaw;
            const cyaw = Math.cos(yaw2), syaw = Math.sin(yaw2);
            const vp = this._aerialViewParams();
            let enCorners;
            if (vp) {
                const M = 1.25;   // reach a little past the frame edges
                const hw = vp.halfW * M, hh = vp.halfH * M;
                enCorners = [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].map(
                    ([dx, dy]) => {
                        const mx = vp.cx + dx, my = vp.cy + dy;
                        return [cyaw * mx - syaw * my, syaw * mx + cyaw * my];
                    });
            } else {
                let area = this.sel_aerial_area ?
                    parseInt(this.sel_aerial_area.value, 10) : this.aerial_area_m;
                if (!(area > 0)) { area = this.aerial_area_m; }
                this.aerial_area_m = area;
                const h = area / 2.0;
                enCorners = [[-h, -h], [h, -h], [-h, h], [h, h]];
            }

            const tileRangeAt = (zoom) => {
                let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                enCorners.forEach(([e, n]) => {
                    const ll = cornerLonLat(e, n);
                    const t = this._lonLatToTile(ll.lon, ll.lat, zoom);
                    x0 = Math.min(x0, Math.floor(t.x));
                    x1 = Math.max(x1, Math.floor(t.x));
                    y0 = Math.min(y0, Math.floor(t.y));
                    y1 = Math.max(y1, Math.floor(t.y));
                });
                const count = (x1 - x0 + 1) * (y1 - y0 + 1);
                return { tx0: x0, tx1: x1, ty0: y0, ty1: y1, count };
            };

            // (3) ADAPTIVE ZOOM — pick the finest level whose tile resolution is
            // still no coarser than the on-screen resolution, but never exceed
            // the configured detail cap. At the default/standard zoom this lands
            // on the cap (crisp detail); only when dollying out past the default
            // limit does it step DOWN to coarser world-scale tiles.
            let z = zCap;
            if (vp && vp.heightPx > 0) {
                const screenRes = (2.0 * vp.halfH) / vp.heightPx;   // map m / px
                const phi = d.origin_lat * Math.PI / 180.0;
                const mercZ0 = 156543.03392 * Math.max(0.05, Math.cos(phi));
                let zAdaptive = Math.ceil(
                    Math.log2(mercZ0 / Math.max(1e-6, screenRes)));
                if (!isFinite(zAdaptive)) { zAdaptive = zCap; }
                z = Math.max(0, Math.min(zCap, zAdaptive));
            }

            // (4) tile-count guard: auto-clamp zoom DOWN until it fits the cap.
            const CAP = this.AERIAL_TILE_CAP;
            let range = tileRangeAt(z);
            while (range.count > CAP && z > 0) {
                z -= 1;
                range = tileRangeAt(z);
            }
            const { tx0, tx1, ty0, ty1 } = range;
            const nTiles = range.count;
            if (!(nTiles > 0) || nTiles > CAP) {
                status(() => mapT('mapping.aerial.too_many', {n: nTiles, z: z}), true);
                return;
            }

            // (4b) skip the (re)build entirely if the covering tile set is
            // unchanged — makes panning within the same tiles and re-enabling
            // the layer free. Source or zoom change invalidates the signature.
            const sig = srcKey + '@' + z + ':' + tx0 + ',' + tx1 + ',' +
                        ty0 + ',' + ty1;
            if (sig === this._aerialSig && this.aerial_meshes.length > 0) {
                const nMesh = this.aerial_meshes.length;
                status(() => mapT('mapping.aerial.tiles_same',
                    {n: nMesh, z: z, src: this._aerialLabel(srcKey, src)}));
                return;
            }
            this._aerialSig = sig;

            // (4) build fresh meshes off-screen, swap in after ready.
            const newMeshes = [];
            const opacity = this.in_aerial_opacity ?
                            parseFloat(this.in_aerial_opacity.value) : 1.0;
            // convert a lon/lat back to true east/north metres (inverse of above).
            const lonLatToXY = (lon, lat) => ({
                x: (lon - d.origin_lon) * mLon,
                y: (lat - d.origin_lat) * mLat,
            });

            let built = 0;
            for (let tx = tx0; tx <= tx1; tx++) {
                for (let ty = ty0; ty <= ty1; ty++) {
                    // tile geographic bounds -> map-aligned metres
                    const nw = this._tileToLonLat(tx, ty, z);
                    const se = this._tileToLonLat(tx + 1, ty + 1, z);
                    const pNW = lonLatToXY(nw.lon, nw.lat);
                    const pSE = lonLatToXY(se.lon, se.lat);
                    const w = pSE.x - pNW.x;         // +east
                    const h = pNW.y - pSE.y;         // +north (nw.lat > se.lat)
                    if (!(w > 0) || !(h > 0)) { continue; }
                    const cx = (pNW.x + pSE.x) / 2;
                    const cy = (pNW.y + pSE.y) / 2;
                    const url = this._aerialTileUrl(src, z, tx, ty);
                    const mesh = this._buildTileMesh(T, url, cx, cy, w, h,
                                                     opacity, token);
                    if (mesh) { newMeshes.push(mesh); group.add(mesh); built++; }
                }
            }
            if (token !== this.aerial_token) {
                // superseded mid-build: drop what we just added
                newMeshes.forEach((m) => {
                    try { group.remove(m); m.geometry && m.geometry.dispose();
                          if (m.material) { m.material.map && m.material.map.dispose();
                                            m.material.dispose(); } } catch (e) {}
                });
                return;
            }
            this._disposeAerialMeshes();
            this.aerial_meshes = newMeshes;
            status(() => mapT((z < zCap) ? 'mapping.aerial.tiles_out' : 'mapping.aerial.tiles',
                {n: built, z: z, cap: zCap, src: this._aerialLabel(srcKey, src)}));
        } catch (e) {
            console.error('[mappingv3] rebuildAerial failed:', e);
            status(() => mapT('mapping.aerial.failed'), true);
        }
    }

    // Build one textured plane for a tile. The texture loads async: the mesh is
    // created immediately with an empty texture and the image is painted in on
    // load, so nothing blocks. Returns the mesh (or null on failure).
    _buildTileMesh(T, url, cx, cy, w, h, opacity, token) {
        try {
            // start with a 1x1 transparent texture; fill on image load.
            const tex = new T.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
            tex.needsUpdate = true;
            const geo = new T.Geometry(w, h);       // PlaneBufferGeometry
            const mat = new T.Material({
                map: tex, transparent: true, opacity: opacity, depthWrite: false,
            });
            if (T.DoubleSide !== undefined) { mat.side = T.DoubleSide; }
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(cx, cy, 0);
            // BOTTOM of the paint order (see MapLayerOrder). depthWrite already
            // false above; renderOrder pins it under every transparent grid.
            mesh.renderOrder =
                (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder.AERIAL : -100;

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    if (token !== this.aerial_token) { return; }  // stale
                    const MAX = 256;
                    const iw = Math.min(MAX, img.naturalWidth || 256);
                    const ih = Math.min(MAX, img.naturalHeight || 256);
                    const cv = document.createElement('canvas');
                    cv.width = iw; cv.height = ih;
                    const ctx = cv.getContext('2d');
                    if (!ctx) { return; }
                    ctx.drawImage(img, 0, 0, iw, ih);
                    const rgba = new Uint8Array(
                        ctx.getImageData(0, 0, iw, ih).data.buffer);
                    const ntex = new T.DataTexture(rgba, iw, ih);
                    ntex.flipY = true;   // canvas row0=top -> +y (north)
                    ntex.needsUpdate = true;
                    const old = mat.map;
                    mat.map = ntex;
                    mat.needsUpdate = true;
                    try { old && old.dispose(); } catch (e) {}
                } catch (e) {
                    console.error('[mappingv3] aerial tile paint failed:', e);
                }
            };
            img.onerror = () => { /* missing tile: leave transparent */ };
            img.src = url;
            return mesh;
        } catch (e) {
            console.error('[mappingv3] _buildTileMesh failed:', e);
            return null;
        }
    }

    // =====================================================================
    // RAIN RADAR layer — the ČHMÚ radar echo draped ABOVE everything.
    // ---------------------------------------------------------------------
    // SOURCE: weather_alert node publishes /weather_alert/rain_img — a CLEAN
    // rain-only sensor_msgs/Image (rgba8, 512x512, latched). It is a square
    // crop of the ČHMÚ "pseudocappi2km" radar composite (Mercator/EPSG:3857)
    // centred on the robot's configured lat/lon, containing ONLY the radar
    // echo: NO OSM basemap, NO status/frame annotations, NO position marker.
    // Alpha=255 (palette colour) on rain pixels, alpha=0 (transparent black)
    // everywhere else. rosbridge delivers Image.data as base64 RGBA bytes.
    // We passthrough those bytes directly — NO palette keying at all (the old
    // map_img path had to chroma-key, which caught the deepskyblue zone/marker
    // annotations and tinted the whole 3D map blue; that is gone now).
    //
    // GEOREF: the companion latched JSON topic /weather_alert/rain_meta carries
    // the exact crop extent — {center_lat, center_lon, half_km, size_px,
    // km_per_px, frame_warning_km}. The frame spans 2*half_km km centred on
    // (center_lat, center_lon), so we no longer re-derive ČHMÚ constants in JS
    // (a config change on the robot — frame_warning / location — now flows
    // through automatically). While waiting for the first meta message we fall
    // back to the historical constant half_km ≈ 31.95 km (frame_warning=20).
    // The plane is centred on the garden by placing the radar centre in map
    // metres via the SAME /api/datum chain the aerial tiles use (flat-earth
    // around the datum origin, inside a group carrying the -yaw rotation).
    // NOTE: the ČHMÚ scale is ~0.88 km/px, so alignment accuracy is inherently
    // ± a few hundred metres at garden scale — fine for "is it raining over me
    // / nearby". We show only the central disc (radius select).
    _initRain() {
        this.rain_group = null;        // ROS3D THREE.Object3D, built lazily
        this.rain_mesh = null;
        this.rain_datum = null;        // cached /api/datum
        this.rain_msg = null;          // last-seen rgba8 Image message
        this.rain_meta = null;         // last-seen /weather_alert/rain_meta JSON
        this.rain_sub = null;          // rosbridge rain_img subscription (lazy)
        this.rain_meta_sub = null;     // rosbridge rain_meta subscription (lazy)
        this.rain_token = 0;           // bumps to cancel stale async builds

        // Fallback half-extent (km) used only until the first rain_meta arrives.
        // Matches chmi.py with frame_warning=20 at 50 °N (half_km ≈ 31.95 km).
        this.RAIN_FALLBACK_HALF_KM = 31.951;

        this.chk_rain = document.getElementById('mapv3_chk_rain');
        this.sel_rain_area = document.getElementById('mapv3_rain_area');
        this.sel_rain_z = document.getElementById('mapv3_rain_z');
        this.in_rain_opacity = document.getElementById('mapv3_rain_opacity');
        this.el_rain_status = document.getElementById('mapv3_rain_status');
        this.btn_rain_fit = document.getElementById('mapv3_btn_rain_fit');

        if (this.btn_rain_fit) {
            this.btn_rain_fit.addEventListener('click', () => this.fitRainFrame());
        }

        // Persist area/float-height/opacity across reloads (restore BEFORE the
        // boot-time rebuildRain below so the first build uses them).
        this._persistSelect(this.sel_rain_area, 'vitulus_rain_area');
        this._persistSelect(this.sel_rain_z, 'vitulus_rain_z');
        this._persistRange(this.in_rain_opacity, 'vitulus_rain_opacity');

        if (this.chk_rain) {
            this.chk_rain.addEventListener('change', () => {
                this._saveLayerPref('vitulus_layer_rain', this.chk_rain.checked);
                if (this.chk_rain.checked) {
                    this._ensureRainSub();
                    this.rebuildRain();
                } else if (this.rain_group) {
                    this.rain_group.visible = false;
                }
                // Rain overview toggles the wide zoom-out limit AND the aerial
                // coverage extent (so the MapProxy basemap covers the whole rain
                // frame). Re-apply both whenever rain is switched on/off.
                this._applyZoomLimit();
                if (this.chk_aerial && this.chk_aerial.checked) { this.rebuildAerial(); }
            });
        }
        // Grow the camera far-plane as the user dollies out while the rain
        // overview is on (keeps the whole frame un-clipped without hurting
        // depth precision when zoomed in). No-op / removed when rain is off.
        this._defaultFar = null;
        try {
            if (this.viewer3d && this.viewer3d.cameraControls &&
                this.viewer3d.cameraControls.addEventListener) {
                this.viewer3d.cameraControls.addEventListener('change', () => {
                    this._onCamChange();          // grow far-plane (rain on)
                    this._scheduleAerialFollow();  // refit basemap to viewport
                    this._updateBeacon();          // far-zoom "you are here" pin
                });
            }
        } catch (e) { /* stub viewer / no controls */ }
        [this.sel_rain_area, this.sel_rain_z].forEach((el) => {
            if (el) el.addEventListener('change', () => {
                if (this.chk_rain && this.chk_rain.checked) this.rebuildRain();
            });
        });
        if (this.in_rain_opacity) {
            this.in_rain_opacity.addEventListener('input', () => {
                this._applyRainOpacity();
            });
        }

        // TASK3: rain radar DEFAULT ON (respect a stored preference). Take the
        // SAME path as a manual tick — subscribe, (re)build, open the wide
        // zoom-out limit and extend the aerial coverage to the frame. rebuildRain
        // no-ops until the first /weather_alert/rain_img arrives (its subscription
        // callback rebuilds then), so an early boot-time call is safe. Area/float/
        // opacity keep their configured defaults; the camera stays at the normal
        // garden zoom (the beacon only appears once the user dollies right out).
        if (this.chk_rain) {
            this.chk_rain.checked = this._layerPref('vitulus_layer_rain', true);
            if (this.chk_rain.checked) {
                this._ensureRainSub();
                this.rebuildRain();
                this._applyZoomLimit();
                if (this.chk_aerial && this.chk_aerial.checked) { this.rebuildAerial(); }
            }
        }
    }

    // Subscribe to the clean rain-only Image + its geo-meta exactly once (on
    // first tick). Each new frame caches the message and, if the layer is on,
    // rebuilds the plane. rain_meta is latched, so we get the current extent
    // immediately on subscribe.
    _ensureRainSub() {
        if (this.rain_sub) { return; }
        try {
            this.rain_sub = new ROSLIB.Topic({
                ros: this.ros,
                name: '/weather_alert/rain_img',
                messageType: 'sensor_msgs/Image',
            });
            this.rain_sub.subscribe((m) => {
                this.rain_msg = m;
                if (this.chk_rain && this.chk_rain.checked) { this.rebuildRain(); }
            });
            this.rain_meta_sub = new ROSLIB.Topic({
                ros: this.ros,
                name: '/weather_alert/rain_meta',
                messageType: 'std_msgs/String',
            });
            this.rain_meta_sub.subscribe((m) => {
                const prevHalfKm = this._rainHalfKm();
                try { this.rain_meta = JSON.parse(m.data); }
                catch (e) { return; }
                if (this.chk_rain && this.chk_rain.checked && this.rain_msg) {
                    this.rebuildRain();
                }
                // A changed frame extent moves both the zoom-out limit and the
                // aerial coverage; re-apply them if the authoritative half_km
                // differs from what we had (first meta, or a config change).
                if (this.chk_rain && this.chk_rain.checked &&
                    Math.abs(this._rainHalfKm() - prevHalfKm) > 1e-6) {
                    this._applyZoomLimit();
                    if (this.chk_aerial && this.chk_aerial.checked) { this.rebuildAerial(); }
                }
            });
        } catch (e) {
            console.error('[mappingv3] rain subscribe failed:', e);
        }
    }

    _applyRainOpacity() {
        if (!this.in_rain_opacity || !this.rain_mesh) return;
        const op = parseFloat(this.in_rain_opacity.value);
        if (!(op >= 0 && op <= 1)) return;
        try { if (this.rain_mesh.material) this.rain_mesh.material.opacity = op; }
        catch (e) {}
    }

    _ensureRainGroup() {
        if (this.rain_group) { return this.rain_group; }
        const T = this._r3d();
        if (!T || !this.viewer3d || !this.viewer3d.scene) { return null; }
        this.rain_group = new T.Object3D();   // carries -yaw, like aerial
        this.viewer3d.scene.add(this.rain_group);
        return this.rain_group;
    }

    _disposeRainMesh() {
        if (!this.rain_mesh) { return; }
        if (this.rain_group) { this.rain_group.remove(this.rain_mesh); }
        try {
            this.rain_mesh.geometry && this.rain_mesh.geometry.dispose();
            const m = this.rain_mesh.material;
            if (m) { m.map && m.map.dispose(); m.dispose(); }
        } catch (e) {}
        this.rain_mesh = null;
    }

    // half-extent of the ČHMÚ crop in km. Prefer the value the node publishes
    // on /weather_alert/rain_meta (authoritative, mirrors chmi.py exactly);
    // fall back to the historical constant until the first meta arrives.
    _rainHalfKm() {
        if (this.rain_meta && this.rain_meta.half_km > 0) {
            return this.rain_meta.half_km;
        }
        return this.RAIN_FALLBACK_HALF_KM;
    }

    // Full side length (metres) of the ČHMÚ rain frame = 2*half_km. This is the
    // extent both the zoom-out limit and the aerial basemap must cover so the
    // whole rain map is framable with a basemap under it.
    _rainFrameSideM() {
        return 2.0 * this._rainHalfKm() * 1000.0;
    }

    // Camera-to-center distance (top-down, near-ortho perspective cam) needed to
    // fit a square of side `sideM` in BOTH viewport axes, with a small margin.
    // Uses the live fov/aspect so it stays correct across resizes and the
    // narrow map-view fov set in map_view.js (updateCam).
    _distanceToFrame(sideM) {
        const cam = this.viewer3d && this.viewer3d.camera;
        if (!cam) { return sideM; }
        const fovDeg = cam.fov > 0 ? cam.fov : 40;
        const t = Math.tan((fovDeg * Math.PI / 180.0) / 2.0);
        const aspect = cam.aspect > 0 ? cam.aspect : 1.0;
        if (!(t > 0)) { return sideM; }
        // visible full-height = 2*d*t ; full-width = that*aspect. Fit the tighter
        // axis: portrait (aspect<1) is width-limited, landscape height-limited.
        const d = (sideM / (2.0 * t)) * Math.max(1.0, 1.0 / aspect);
        return d * 1.1;   // 10 % margin so the frame isn't flush to the edges
    }

    // Apply (rain on) or clear (rain off) the wide zoom-out limit. When rain is
    // ON the camera may dolly out far enough to frame the whole ČHMÚ rain map;
    // when OFF we restore the original far-plane (6000) and drop the distance
    // clamp, so the maximum zoom-out is exactly what it was before this feature.
    _applyZoomLimit() {
        const cam = this.viewer3d && this.viewer3d.camera;
        const ctrl = this.viewer3d && this.viewer3d.cameraControls;
        if (!cam) { return; }
        if (this._defaultFar == null) { this._defaultFar = cam.far; }   // 6000
        const rainOn = !!(this.chk_rain && this.chk_rain.checked);
        if (!rainOn) {
            // Restore original limits — behaviour unchanged from before.
            if (ctrl) { ctrl.maxDistance = Infinity; }
            // If we're still parked at a rain-scale zoom-out, the restored
            // 6000 far-plane would clip everything to black. Pull the camera
            // back inside it so turning rain off never leaves a blank view.
            if (ctrl && ctrl.center && cam.position) {
                try {
                    const off = cam.position.clone().sub(ctrl.center);
                    const d = off.length();
                    const maxSane = this._defaultFar * 0.7;
                    if (d > maxSane && d > 0) {
                        off.multiplyScalar(maxSane / d);
                        cam.position.copy(ctrl.center).add(off);
                    }
                } catch (e) { /* stub cam */ }
            }
            if (cam.far !== this._defaultFar) {
                cam.far = this._defaultFar;
                if (cam.updateProjectionMatrix) { cam.updateProjectionMatrix(); }
            }
            return;
        }
        // Rain on: allow zooming out until the full frame fits, and grow the
        // far-plane to match the current camera height (see _onCamChange).
        if (ctrl) { ctrl.maxDistance = this._distanceToFrame(this._rainFrameSideM()); }
        this._onCamChange();
    }

    // Keep the far-plane just beyond the current camera distance WHILE the rain
    // overview is on, so the (very distant) ground/basemap/rain planes stay
    // un-clipped when fully zoomed out — yet far stays near the 6000 default
    // when zoomed in, preserving depth precision for the garden-scale layers.
    _onCamChange() {
        if (!(this.chk_rain && this.chk_rain.checked)) { return; }
        const cam = this.viewer3d && this.viewer3d.camera;
        const ctrl = this.viewer3d && this.viewer3d.cameraControls;
        if (!cam || !ctrl || !ctrl.center) { return; }
        if (this._defaultFar == null) { this._defaultFar = cam.far; }
        let dist;
        try { dist = cam.position.distanceTo(ctrl.center); }
        catch (e) { return; }
        if (!(dist > 0)) { return; }
        const want = Math.max(this._defaultFar, dist * 1.4 + 1000.0);
        // Only re-upload the projection matrix on a meaningful change.
        if (Math.abs(want - cam.far) > Math.max(50.0, cam.far * 0.02)) {
            cam.far = want;
            if (cam.updateProjectionMatrix) { cam.updateProjectionMatrix(); }
        }
    }

    // One-shot "fit the whole rain map": centre on the rain frame (= datum
    // origin) and set the camera distance so the entire ČHMÚ frame is in view.
    // Bound to the 'fit' button next to the rain controls so the wide overview
    // is one click away instead of ~200 wheel notches. No-op unless rain is on
    // (the zoom-out limit only opens up then).
    fitRainFrame() {
        if (!(this.chk_rain && this.chk_rain.checked)) { return; }
        const cam = this.viewer3d && this.viewer3d.camera;
        const ctrl = this.viewer3d && this.viewer3d.cameraControls;
        if (!cam || !ctrl || !ctrl.center || !cam.position) { return; }
        // make sure the limit/far are opened for the frame before we move there.
        this._applyZoomLimit();
        const dist = this._distanceToFrame(this._rainFrameSideM());
        // keep the current view direction, just recentre on the frame and set
        // the distance. update() re-derives orientation from position/center.
        const off = cam.position.clone().sub(ctrl.center);
        ctrl.center.x = 0.0; ctrl.center.y = 0.0;
        let d0 = off.length();
        if (!(d0 > 0)) { off.set(0, 0, 1); d0 = 1; }
        off.multiplyScalar(dist / d0);
        cam.position.copy(ctrl.center).add(off);
        this._onCamChange();
        if (cam.updateProjectionMatrix) { cam.updateProjectionMatrix(); }
        this._scheduleAerialFollow();
        this._updateBeacon();
    }

    // vitulus_ui TASK2 — FAR-ZOOM LOCATION BEACON ("you are here").
    // When the camera dollies right out (district / whole-rain-frame ~64 km scale)
    // the garden shrinks to a few pixels and its position on the aerial / rain
    // overlay becomes ambiguous. This drops a bright, screen-size-CONSTANT map
    // pin at the /map origin (0,0) = the datum / garden centre = the rain-frame
    // centre — the single most meaningful "here" point — so the place is always
    // unmistakable at wide zoom, and invisible during normal garden-scale work.
    //
    // It is a camera-facing THREE.Sprite built with ROS3D's BUNDLED THREE
    // (ROS3D.THREE — NOT window.THREE; a foreign THREE instance in the ROS3D
    // scene kills the render loop). This bundled THREE is an older build whose
    // SpriteMaterial has NO sizeAttenuation, so we keep the pin a constant pixel
    // size by rescaling it from the live view each camera change (see below).
    // renderOrder = MapLayerOrder.BEACON (1000) + depthTest off => always drawn
    // on top, even over the rain overlay (renderOrder 999).
    _beaconTexture(RT) {
        // Draw the pin once onto a canvas: a saturated RED disc with a white
        // ring + centre dot and a dark outline — high-contrast over both the
        // green/brown aerial imagery AND the blue/cyan/magenta rain radar (red is
        // absent from the radar palette), reading unambiguously as a location
        // marker. Built with ROS3D's THREE.Texture so it belongs to the scene's
        // GL context.
        var S = 128;
        var cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        var g = cv.getContext('2d');
        var cx = S / 2, cy = S / 2;
        g.clearRect(0, 0, S, S);
        // dark outline halo
        g.beginPath(); g.arc(cx, cy, 60, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fill();
        // red disc
        g.beginPath(); g.arc(cx, cy, 54, 0, Math.PI * 2);
        g.fillStyle = '#ff2b2b'; g.fill();
        // white ring
        g.beginPath(); g.arc(cx, cy, 38, 0, Math.PI * 2);
        g.lineWidth = 9; g.strokeStyle = '#ffffff'; g.stroke();
        // white centre dot ("you are here")
        g.beginPath(); g.arc(cx, cy, 12, 0, Math.PI * 2);
        g.fillStyle = '#ffffff'; g.fill();
        var tex = new RT.Texture(cv);
        tex.needsUpdate = true;
        return tex;
    }

    _ensureBeacon() {
        if (this.beacon) { return this.beacon; }
        // Must use the SAME THREE that owns the renderer/scene.
        var RT = (typeof ROS3D !== 'undefined' && ROS3D.THREE) ? ROS3D.THREE : null;
        if (!RT || !RT.Sprite || !RT.SpriteMaterial || !RT.Texture) { return null; }
        if (!this.viewer3d || !this.viewer3d.scene) { return null; }
        try {
            var mat = new RT.SpriteMaterial({ map: this._beaconTexture(RT) });
            mat.transparent = true;
            mat.depthTest = false;
            mat.depthWrite = false;
            mat.opacity = 0.0;                 // faded out until zoomed far
            var spr = new RT.Sprite(mat);
            spr.position.set(0, 0, 0);          // /map origin = garden/datum
            spr.renderOrder = (typeof MapLayerOrder !== 'undefined' &&
                               typeof MapLayerOrder.BEACON === 'number')
                              ? MapLayerOrder.BEACON : 1000;
            spr.visible = false;
            this.viewer3d.scene.add(spr);
            this.beacon = spr;
            return spr;
        } catch (e) {
            console.error('[mappingv3] beacon build failed:', e);
            return null;
        }
    }

    // Update beacon visibility + screen-constant size from the current view.
    // Threshold is expressed in VISIBLE ground extent (metres), not raw camera
    // distance, because the map-view uses a very narrow fov (updateCam) so the
    // default top-down camera already sits ~1000 m up while framing only the
    // garden. We show the pin once the visible half-height exceeds ~400 m (i.e.
    // full frame > ~800 m, several times the garden's ~150-200 m extent) — well
    // clear of normal work, always on at district/rain (~64 km) scale — and fade
    // it in over a band so it never pops. Called from the camera-change hook
    // (no new timer/interval).
    _updateBeacon() {
        var vp = this._aerialViewParams();     // {cx,cy,halfW,halfH,heightPx}
        if (!vp) { return; }
        var spr = this._ensureBeacon();
        if (!spr) { return; }
        var SHOW = 400.0;                      // metres (visible half-height)
        var lo = SHOW * 0.8, hi = SHOW * 1.2;  // fade band 320..480 m
        var op = (vp.halfH - lo) / (hi - lo);
        op = Math.max(0.0, Math.min(1.0, op));
        spr.visible = op > 0.02;
        if (spr.material) { spr.material.opacity = op; }
        if (!spr.visible) { return; }
        // Screen-CONSTANT size: 2*halfH metres of ground map to heightPx pixels,
        // so metres-per-pixel = 2*halfH/heightPx. Size the sprite (world units)
        // to a fixed on-screen diameter regardless of zoom.
        var PIN_PX = 34.0;                      // on-screen pin diameter (px)
        var hpx = vp.heightPx > 0 ? vp.heightPx : 800;
        var worldSize = PIN_PX * (2.0 * vp.halfH / hpx);
        if (worldSize > 0 && isFinite(worldSize)) {
            spr.scale.set(worldSize, worldSize, 1);
        }
    }

    // Build / update the rain plane from the cached Image message + datum.
    // Async-safe, cancellable, fully try/catch-wrapped so a bad frame can never
    // take down the ROS3D render loop.
    async rebuildRain() {
        // status(fn, warn): fn renders the text (re-run on a language switch)
        const status = (fn, warn) => {
            if (this.el_rain_status) {
                this._say(this.el_rain_status, fn);
                vtTone(this.el_rain_status, warn ? 'warn' : '');
            }
        };
        const token = ++this.rain_token;
        try {
            if (!this.rain_msg) { status(() => mapT('mapping.rain.waiting')); return; }
            // datum — cache once.
            if (!this.rain_datum) {
                status(() => mapT('mapping.aerial.loading_datum'));
                const resp = await fetch('/api/datum', { cache: 'no-store' });
                const dj = resp.ok ? await resp.json() : null;
                if (!dj || dj.ok === false) { status(() => mapT('mapping.rain.no_datum'), true); return; }
                this.rain_datum = dj;
            }
            if (token !== this.rain_token) { return; }
            const d = this.rain_datum;
            if (d.origin_lat == null || d.origin_lon == null) {
                status(() => mapT('mapping.datum_no_origin'), true); return;
            }

            const T = this._r3d();
            const group = this._ensureRainGroup();
            if (!T || !group) { status(() => mapT('mapping.not_ready_3d'), true); return; }

            const m = this.rain_msg;
            const W = m.width | 0, H = m.height | 0;
            if (!(W > 0) || !(H > 0)) { status(() => mapT('mapping.rain.bad_frame'), true); return; }

            // Decode base64 rgba8 -> RGBA passthrough + radius clip. No palette
            // keying: the node already delivers a clean rain-only image with
            // alpha=0 off the echo. Runs off the render path.
            const rgba = this._rainDecode(m, W, H);
            if (!rgba) { status(() => mapT('mapping.rain.decode_failed'), true); return; }

            // Geometry: the full frame spans 2*halfKm km. Centre it on the
            // radar centre expressed in map metres. The radar centre is the
            // config lat/lon; we approximate it by the datum origin (garden)
            // — see the header note. side in metres:
            const halfKm = this._rainHalfKm();
            const sideM = 2.0 * halfKm * 1000.0;

            // group carries -trueYaw so a true-north plane lands in the map frame.
            group.rotation.z = -this._mapTrueYaw(d);
            group.visible = true;

            // radar centre in map-aligned metres. If the ČHMÚ config centre
            // differed from the datum origin we'd offset here; they coincide
            // (garden), so centre = (0,0) in the datum's local frame.
            const cx = 0.0, cy = 0.0;
            const z = this.sel_rain_z ? parseFloat(this.sel_rain_z.value) : 5.0;

            const tex = new T.DataTexture(rgba, W, H);
            tex.flipY = true;   // canvas/data row 0 = top(north) -> +y
            tex.needsUpdate = true;
            const geo = new T.Geometry(sideM, sideM);   // PlaneBufferGeometry
            const opacity = this.in_rain_opacity ?
                parseFloat(this.in_rain_opacity.value) : 0.5;
            const mat = new T.Material({
                map: tex, transparent: true, opacity: opacity, depthWrite: false,
            });
            if (T.DoubleSide !== undefined) { mat.side = T.DoubleSide; }
            // depthTest off => always drawn on top of the lower layers.
            try { mat.depthTest = false; } catch (e) {}
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(cx, cy, z);
            // topmost of the whole scene (layer-ordering contract)
            mesh.renderOrder =
                (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder.RAIN : 999;

            if (token !== this.rain_token) {
                try { geo.dispose(); tex.dispose(); mat.dispose(); } catch (e) {}
                return;
            }
            this._disposeRainMesh();
            this.rain_mesh = mesh;
            group.add(mesh);

            const areaM = this.sel_rain_area ?
                parseInt(this.sel_rain_area.value, 10) : 32000;
            const full = (areaM >= halfKm * 1000.0 * 0.9);
            const frameKm = (2 * halfKm).toFixed(0);
            status(() => mapT('mapping.rain.status', {
                frame: frameKm,
                shown: full ? mapT('mapping.rain.full_frame') : ('r≈' + (areaM / 1000) + ' km'),
                z: z}));
        } catch (e) {
            console.error('[mappingv3] rebuildRain failed:', e);
            status(() => mapT('mapping.rain.failed'), true);
        }
    }

    // Decode a raw rgba8 Image message to an RGBA Uint8Array of the same size.
    // The node already delivers a clean rain-only image (alpha=255 on echo,
    // alpha=0 elsewhere), so this is a straight passthrough — NO palette keying
    // at all. We only additionally clip to the selected radius disc around the
    // centre so far-off regions don't clutter the garden view.
    _rainDecode(m, W, H) {
        try {
            // base64 -> bytes (rgba8, length = W*H*4)
            const bin = atob(m.data);
            const n = bin.length;
            const src = new Uint8Array(n);
            for (let i = 0; i < n; i++) { src[i] = bin.charCodeAt(i); }
            if (src.length < W * H * 4) { return null; }

            const out = new Uint8Array(W * H * 4);

            // radius clip: keep only pixels within the selected radius of the
            // centre. km-per-px of the frame = (2*halfKm)/W.
            const halfKm = this._rainHalfKm();
            const frameHalfM = halfKm * 1000.0;
            const kmPerPx = (2.0 * halfKm) / W;
            const areaM = this.sel_rain_area ?
                parseInt(this.sel_rain_area.value, 10) : 32000;

            // FULL-FRAME mode: when the selected radius reaches (near) the frame
            // half-extent, show the ENTIRE ČHMÚ square — every rain pixel,
            // corners included. This is what "show the whole rain map" needs; the
            // disc clip below is only for the smaller declutter radii. The 0.9
            // factor means the top dropdown option counts as full even before the
            // HTML relabel (old "full ~32 km" = 30 km ≈ 0.94·halfKm) is live.
            if (areaM >= frameHalfM * 0.9) {
                out.set(src.subarray(0, W * H * 4));
                return out;
            }

            const rPx = (areaM / 1000.0) / kmPerPx;   // radius in px
            const rPx2 = rPx * rPx;
            const ccx = W / 2, ccy = H / 2;

            for (let y = 0; y < H; y++) {
                const dy = y - ccy;
                for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4;
                    out[i]     = src[i];
                    out[i + 1] = src[i + 1];
                    out[i + 2] = src[i + 2];
                    // passthrough alpha, but force-transparent outside the disc
                    const dx = x - ccx;
                    out[i + 3] = (dx * dx + dy * dy <= rPx2) ? src[i + 3] : 0;
                }
            }
            return out;
        } catch (e) {
            console.error('[mappingv3] _rainDecode failed:', e);
            return null;
        }
    }

    // Harvest ROS3D's PRIVATE THREE constructors from the live scene. ROS3D
    // bundles its own copy of THREE (distinct object identity from the global
    // window.THREE), and its WebGLRenderer only accepts objects built from that
    // same copy. We reach the classes we need by building one throwaway ROS3D
    // OccupancyGrid (a THREE.Mesh subclass that internally makes a
    // PlaneBufferGeometry + DataTexture + MeshBasicMaterial with ROS3D's THREE)
    // and reading the constructors off the resulting instance. Cached; returns
    // null if unavailable (e.g. ROS3D missing) so callers can no-op safely.
    _r3d() {
        if (this._r3dCache) { return this._r3dCache; }
        try {
            const OG = (typeof ROS3D !== 'undefined') && ROS3D.OccupancyGrid;
            if (!OG) { return null; }
            const probe = new OG({ message: { info: {
                width: 1, height: 1, resolution: 1,
                origin: { position: { x: 0, y: 0, z: 0 },
                          orientation: { x: 0, y: 0, z: 0, w: 1 } }
            }, data: [0] } });
            // walk the prototype chain: probe -> OccupancyGrid.prototype ->
            // Mesh.prototype -> Object3D.prototype (each .constructor is set).
            const meshProto = Object.getPrototypeOf(Object.getPrototypeOf(probe));
            const Mesh = meshProto.constructor;                    // THREE.Mesh
            const Object3D = Object.getPrototypeOf(meshProto).constructor; // THREE.Object3D
            const Geometry = probe.geometry.constructor;   // PlaneBufferGeometry
            const Material = probe.material.constructor;    // MeshBasicMaterial
            const DataTexture = probe.texture.constructor;  // DataTexture
            const NearestFilter = probe.texture.minFilter;  // enum value
            const DoubleSide = probe.material.side;          // ROS3D sets DoubleSide
            // clean up the GPU-less probe
            try { probe.dispose && probe.dispose(); } catch (e) {}
            this._r3dCache = { Mesh, Object3D, Geometry, Material,
                               DataTexture, NearestFilter, DoubleSide };
            return this._r3dCache;
        } catch (e) {
            console.error('[mappingv3] could not harvest ROS3D THREE:', e);
            return null;
        }
    }

    _ensureTerrainGroup() {
        if (this.terrain_group) { return this.terrain_group; }
        const T = this._r3d();
        if (!T || !this.viewer3d || !this.viewer3d.scene) { return null; }
        this.terrain_group = new T.Object3D();
        // Layer-ordering contract: terrain is an OPT-IN elevation plane painted
        // ABOVE the flat maps/costmaps (renderOrder MapLayerOrder.TERRAIN=12 on
        // the mesh below). It keeps its tiny z=-0.02 bias only for historical
        // reasons — paint order is decided purely by renderOrder because the
        // whole flat stack is transparent + depthWrite=false, so z is inert.
        this.terrain_group.position.z =
            (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder.Z_TERRAIN : -0.02;
        this.viewer3d.scene.add(this.terrain_group);
        this.applyTerrainVisible();
        return this.terrain_group;
    }

    applyTerrainVisible() {
        if (this.terrain_group) {
            this.terrain_group.visible = !!this.terrain_visible;
        }
    }

    _disposeTerrainMesh() {
        if (!this.terrain_mesh) { return; }
        if (this.terrain_group) { this.terrain_group.remove(this.terrain_mesh); }
        try {
            this.terrain_mesh.geometry && this.terrain_mesh.geometry.dispose();
            const m = this.terrain_mesh.material;
            if (m) { m.map && m.map.dispose(); m.dispose(); }
        } catch (e) { /* best-effort */ }
        this.terrain_mesh = null;
    }

    // Build / update the terrain elevation plane from the cached decoded PNG +
    // bounds. No-op (shows nothing, never blocks) until BOTH the decoded image
    // and the world bounds are known. Fully wrapped in try/catch so a bad frame
    // can never take down the ROS3D render loop. The plane is sized to the DEM
    // bbox in map metres and centred on it; the scene fixed frame is /map so
    // those coords are absolute and line up with the occupancy grids.
    rebuildTerrain() {
        try {
            if (!this.terrain_img || !this.terrain_bounds) { return; }
            const b = this.terrain_bounds;
            const w = b.max_x - b.min_x;
            const h = b.max_y - b.min_y;
            if (!(w > 0) || !(h > 0)) { return; }

            const T = this._r3d();
            const group = this._ensureTerrainGroup();
            if (!T || !group) { return; }

            // Rasterise the decoded PNG to RGBA pixels via a canvas, capping the
            // canvas at MAX px per side so a pathological image can never spin
            // up a huge buffer. Terrain PNGs are tiny (~90x190) in practice.
            const MAX = 1024;
            const iw = Math.max(1, Math.min(MAX, this.terrain_img.naturalWidth  || 1));
            const ih = Math.max(1, Math.min(MAX, this.terrain_img.naturalHeight || 1));
            const cv = document.createElement('canvas');
            cv.width = iw; cv.height = ih;
            const ctx = cv.getContext('2d');
            if (!ctx) { return; }
            ctx.drawImage(this.terrain_img, 0, 0, iw, ih);
            const rgba = new Uint8Array(ctx.getImageData(0, 0, iw, ih).data.buffer);

            const tex = new T.DataTexture(rgba, iw, ih);   // RGBA default
            // dem_to_png(_orient(elev)) => image row 0 = MAX y. Canvas/DataTexture
            // put row 0 at the TOP of the image; flipY=true maps top -> +y so the
            // plane's north edge is +y, matching the occupancy grids.
            tex.flipY = true;
            tex.minFilter = T.NearestFilter;
            tex.magFilter = T.NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;

            const geo = new T.Geometry(w, h);             // PlaneBufferGeometry
            // FLAT plane (no z-elevation geometry — height is encoded as colour).
            // transparent + depthWrite=false is REQUIRED by the layer-ordering
            // contract: the whole flat map stack overlaps in a near-identical
            // z-band and relies on renderOrder (not depth) to sort. opacity 0.85
            // is the terrain layer's own fixed setting (it has no separate opacity
            // slider — the "Maps opacity" control deliberately governs only the
            // occupancy grids), so the maps below stay faintly visible through it.
            const mat = new T.Material({
                map: tex, transparent: true, opacity: 0.85, depthWrite: false
            });
            if (T.DoubleSide !== undefined) { mat.side = T.DoubleSide; }
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set((b.min_x + b.max_x) / 2,
                              (b.min_y + b.max_y) / 2, 0);
            // Layer-ordering contract: opt-in terrain painted ABOVE the flat
            // maps/costmaps (was below); still under EDITS/LIVE. See MapLayerOrder.
            mesh.renderOrder =
                (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder.TERRAIN : 12;

            // swap in the new mesh, dispose the old one only after the new is ready
            this._disposeTerrainMesh();
            this.terrain_mesh = mesh;
            group.add(mesh);
        } catch (e) {
            console.error('[mappingv3] rebuildTerrain failed:', e);
        }
    }

    clearTerrain() {
        this.terrain_bounds = null;
        this._disposeTerrainMesh();
    }

    applyBand() {
        const bmin = parseFloat(this.in_band_min.value);
        const bmax = parseFloat(this.in_band_max.value);
        const ev = parseInt(this.in_min_evidence.value, 10);
        const cl = parseInt(this.in_min_cluster.value, 10);
        if (!(bmin >= 0 && bmax <= 2.0 && bmin < bmax)) {
            this._say(this.el_band_status, () => mapT('mapping.band.invalid_band'));
            vtTone(this.el_band_status, 'err');
            return;
        }
        if (!(ev >= 1 && ev <= 20 && cl >= 1 && cl <= 20)) {
            this._say(this.el_band_status, () => mapT('mapping.band.invalid_counts'));
            vtTone(this.el_band_status, 'err');
            return;
        }
        const payload = {band_min: bmin, band_max: bmax,
                         min_evidence: ev, min_cluster_cells: cl};
        this.pub_set_band.publish(new ROSLIB.Message({data: JSON.stringify(payload)}));
        this.band_edited = false;   // let projector_status re-sync the applied values
        this._say(this.el_band_status, () => mapT('mapping.applying'));
        vtTone(this.el_band_status, '');
    }

    applyRanges() {
        const lidar = parseFloat(this.in_lidar_max.value);
        const depth = parseFloat(this.in_depth_max.value);
        const ok = (v) => (v >= 0.5 && v <= 20.0);
        if (!ok(lidar) || !ok(depth)) {
            this._say(this.el_ranges_status, () => mapT('mapping.ranges.invalid'));
            vtTone(this.el_ranges_status, 'err');
            return;
        }
        const payload = {lidar_max_m: lidar, depth_max_m: depth};
        this.pub_set_ranges.publish(
            new ROSLIB.Message({data: JSON.stringify(payload)}));
        this.ranges_edited = false;   // let gate_status re-sync applied values
        this._say(this.el_ranges_status, () => mapT('mapping.applying'));
        vtTone(this.el_ranges_status, '');
    }

    // ---- Direct mapper LIVE control helpers (2026-08-09) -------------------
    _setDirectValLabel(el, dec, unit) {
        const span = document.getElementById(el.id + '_val');
        if (!span) return;
        const v = parseFloat(el.value);
        span.textContent = (dec === 0 ? String(Math.round(v)) : v.toFixed(dec))
            + (unit === ' pts' ? mapT('mapping.unit.pts') : (unit || ''));
    }

    // honest feedback shared by every publish path: the settings are applied
    // by the SESSION node — with no mapping session running there is nobody
    // to hear the publish, so a pending mark with a timeout reports that.
    _markDirectPending() {
        if (this.el_direct_status) {
            this._say(this.el_direct_status, () => mapT('mapping.applying'));
            vtTone(this.el_direct_status, '');
        }
        this._direct_apply_pending = Date.now();
        setTimeout(() => {
            if (this._direct_apply_pending) {
                this._direct_apply_pending = null;
                if (this.el_direct_status) {
                    this._say(this.el_direct_status, () => mapT('mapping.direct.no_reply'));
                    vtTone(this.el_direct_status, 'warn');
                }
            }
        }, 3000);
    }

    // accumulate partial dicts and publish ONE set_direct after 300 ms of
    // slider silence (a drag emits dozens of input events)
    _liveDirectSend(partial) {
        this._directPending = Object.assign(this._directPending || {}, partial);
        if (this._directDebounce) clearTimeout(this._directDebounce);
        this._directDebounce = setTimeout(() => {
            const payload = this._directPending;
            this._directPending = null;
            this._directDebounce = null;
            if (!payload) return;
            this.pub_set_direct.publish(
                new ROSLIB.Message({data: JSON.stringify(payload)}));
            this._markDirectPending();
        }, 300);
    }

    // "Send all" — one full-set set_direct; normally redundant (sliders apply
    // live) but useful to force-sync a fresh session to what the UI shows.
    applyDirect() {
        const payload = {};
        this._directChecks.forEach(([el, key]) => {
            if (el) payload[key] = !!el.checked;
        });
        this._directSliders.forEach(([el, key, dec]) => {
            if (!el) return;
            const v = parseFloat(el.value);
            if (!isNaN(v)) payload[key] = (dec === 0) ? Math.round(v) : v;
        });
        this.pub_set_direct.publish(
            new ROSLIB.Message({data: JSON.stringify(payload)}));
        this._markDirectPending();
    }

    setActionsEnabled(on) {
        [this.btn_mode_rtk, this.btn_mode_force, this.btn_mode_off,
         this.btn_raster, this.btn_save, this.btn_compare, this.btn_clear,
         this.btn_apply_band, this.btn_apply_ranges,
         this.btn_reset_map, this.btn_discard]
            .forEach((b) => { if (b) b.disabled = !on; });
        this.btn_stop.disabled = !on;
        // 2026-08-09: while a session runs, Start is OFF — end the session
        // first (Stop & save / Discard); switching sites mid-run by Start was
        // an implicit stop+save, too much magic for one button.
        this.btn_start.disabled = on;
        // Obstacle-classification Apply requires the mapping pipeline running:
        // /mapping/set_band is subscribed by band_projector, which only exists
        // during a session. Say so instead of leaving a dead greyed button —
        // swap the tooltip and add a hint to the band status line when idle.
        if (this.btn_apply_band) {
            this.btn_apply_band.title = on
                ? this._applyBandTitle()
                : mapT('mapping.band.needs_session_tip');
        }
        if (this.el_band_status && !on && !this.band_edited) {
            this._say(this.el_band_status, () => mapT('mapping.band.needs_session'));
            vtTone(this.el_band_status, '');
        }
        // Range caps require the insertion_gate running (subscribes to
        // /mapping/set_ranges), same as the band Apply.
        if (this.btn_apply_ranges) {
            this.btn_apply_ranges.title = on
                ? this._applyRangesTitle()
                : mapT('mapping.ranges.needs_session_tip');
        }
        if (this.el_ranges_status && !on && !this.ranges_edited) {
            this._say(this.el_ranges_status, () => mapT('mapping.ranges.needs_session'));
            vtTone(this.el_ranges_status, '');
        }
        // vitulus-field#23: the preset list is visible any time, but Load /
        // Save / Delete are served by direct_raster, which only runs in a
        // session.
        [this.btn_direct_preset_load, this.btn_direct_preset_save,
         this.btn_direct_preset_del].forEach((b, i) => {
            if (!b) return;
            b.disabled = !on;
            b.title = on ? this._presetTitle(i)
                : mapT('mapping.preset.needs_session_tip');
        });
    }

    // Remove the Direct layer's current mesh (same teardown the client does
    // itself before building the next grid); the next session's first
    // /mapping/direct_map message re-adds one into the kept sceneNode.
    _clearDirectGrid() {
        const c = this.direct_client;
        if (!c || !c.currentGrid) return;
        try {
            if (c.sceneNode) c.sceneNode.remove(c.currentGrid);
            c.currentGrid.dispose();
        } catch (e) { /* best effort */ }
        c.currentGrid = null;
        c._lastMsg = null;   // MapLayerOpacity must not rebuild it from cache
    }

    handleManager(msg) {
        let s;
        try { s = JSON.parse(msg.data); } catch (e) { return; }
        this._lastManagerMsg = msg;
        // 2026-09-20: the direct_raster node dies with the session and never
        // publishes a clearing grid, so a tab open during recording kept the
        // last live Direct grid forever — drawn ABOVE the Saved layer (black
        // obstacles + white wash) it hid the served map and made the layer
        // toggles look dead. Drop it on the running -> not-running edge.
        if (this.running && !s.running) this._clearDirectGrid();
        this.running = s.running;
        // Sensing layer (MapSensing below): default ON only while recording
        if (this.sensing) { this.sensing.onSession(s); }
        this.setActionsEnabled(s.running);
        // 2026-08-16: ACTIVATING a different map switches the datum — the
        // aerial tiles must re-georeference (third refresh trigger, next to
        // the layer-toggle and the mid-session datum-capture edge).
        const servSite = s.serving ? s.serving.site : null;
        // 2026-09-20: tell the rest of the UI when a DIFFERENT site gets served
        // (Programs panel: drop the shown program's markers — they belong to
        // the previous site). Compared against the last NON-NULL site: serving
        // nothing for a while (serve stop/start, manager restart) and then the
        // same site again must not clear anything, possibly mid-mission.
        if (servSite) {
            const prevSite = this._lastServedSite;
            this._lastServedSite = servSite;
            if (prevSite && prevSite !== servSite) {
                try {
                    document.dispatchEvent(new CustomEvent('vitulus:served-site-changed',
                        {detail: {site: servSite, prev: prevSite}}));
                } catch (e) { /* CustomEvent unavailable */ }
            }
        }
        if (this._aerialServSite === undefined) {
            this._aerialServSite = servSite;
        } else if (servSite !== this._aerialServSite) {
            this._aerialServSite = servSite;
            this.aerial_datum = null;
            // a different map = a different offset key: re-read the robot store
            // (it also re-applies the offset to the group).
            if (this.tile_offsets !== undefined) { this._loadTileOffsets(); }
            if (this.chk_aerial && this.chk_aerial.checked) this.rebuildAerial();
        }
        // 2026-08-16 UI redo: stavový přehled nahoře — JAKÁ mapa se nahrává
        const hdr = document.getElementById('mapv3_hdr_session');
        if (hdr) {
            if (s.running) {
                const hSite = s.site, hMin = Math.floor((s.uptime_s || 0) / 60);
                this._say(hdr, () => mapT('mapping.hdr.recording', {site: hSite, min: hMin}), true);
                vtTone(hdr, 'ok');
                // 2026-08-16 field fix: the Direct layer is THE live view of
                // the map being recorded — with the toggle persisted in
                // localStorage a long-forgotten uncheck made a healthy
                // recording look like 'I have no map'. Force it on while a
                // session runs (the user can still uncheck it afterwards —
                // this fires only on the not-running -> running edge).
                if (!this._directLayerForced && this.chk_direct
                        && !this.chk_direct.checked) {
                    this.chk_direct.checked = true;
                    this.chk_direct.dispatchEvent(new Event('change'));
                }
                this._directLayerForced = true;
            } else {
                this._say(hdr, () => mapT('mapping.hdr.idle'));
                vtTone(hdr, '');
                this._directLayerForced = false;
            }
            // 2026-10-25: the line speaks only while a recording runs — idle,
            // "No map recording" was a permanent line of nothing (the map card
            // carries the RECORDING chip when there is one)
            hdr.hidden = !s.running;
        }
        if (this.el_serving) {
            // 2026-10-25: a normally served map is already named in the header
            // ("Active map: …") — repeating "active: …" next to Saved maps was
            // noise; the line speaks only for none / failed / (de)activating
            this.el_serving.hidden = !s.serve_error && !!s.serving;
            if (s.serve_error) {
                // REPORT 2(b): show WHY a serve was rejected instead of the UI
                // silently staying on the old map. Cleared on the next success.
                const err = s.serve_error;
                this._say(this.el_serving, () => mapT('mapping.serving.failed', {error: err}));
                vtTone(this.el_serving, 'err');
            } else if (s.serving) {
                const sv = s.serving;
                this._say(this.el_serving, () => mapT('mapping.serving.active',
                    {site: sv.site, raster: sv.raster}));
                vtTone(this.el_serving, '');
            } else {
                this._say(this.el_serving, () => mapT('mapping.serving.none'));
                vtTone(this.el_serving, '');
            }
        }
        // vitulus_ui: mirror the served site/raster into the map-edit panel header
        // (small hook — piggybacks this existing status handler, no new sub).
        var _mds = document.getElementById('map_detail_site');
        if (_mds) _mds.textContent = s.serving ? (s.serving.site + ' / ' + s.serving.raster) : '—';
        // vitulus-field#46: the active map's name for the Programs panel
        // (map_view.js) — a new program belongs to it. '' = no map is active.
        window.vitulusServedSite = (s.serving && s.serving.site) ? s.serving.site : '';
        // vitulus_ui R2 (2026-07-18) + R3 (2026-07-19): the served site raster IS
        // the displayed base map, so every registered active-map display (Map-tab
        // header + the mini status-bar panel over the 3D view) shows
        // "site (raster)"; the legacy navi map name (stamped as data-legacy by
        // map_view.js / map_edit.js) is relegated to the tooltip. When nothing is
        // served, data-site is cleared and each display falls back to the legacy
        // name. The shared renderer reconciles both, order-independently, for
        // every id in window.ACTIVE_MAP_NAME_ELS.
        var _siteVal = s.serving ? (s.serving.site + ' (' + s.serving.raster + ')') : '';
        (window.ACTIVE_MAP_NAME_ELS || ['active_map_name']).forEach(function (id) {
            var _el = document.getElementById(id);
            if (_el) {
                _el.setAttribute('data-site', _siteVal);
                _el.setAttribute('data-mapping',
                                 (s.running && s.site) ? s.site : '');
            }
        });
        if (window.renderActiveMapName) window.renderActiveMapName();
        // WP-D2: enable "Edit map" only while a site is served (editor draws
        // against the served map). Tooltip reflects the current state.
        // vitulus-field#44: the JS-created button this used to target is gone
        // (2026-08-16), so the guard was dead — it now drives the header
        // toggle. An already open editor keeps the button enabled: it is also
        // the way back out of the editor.
        const btnEditMap = document.getElementById('btn_map_detail_toggle');
        if (btnEditMap) {
            const serving = !!s.serving;
            btnEditMap.disabled = !serving && !btnEditMap.classList.contains('active');
            btnEditMap.title = serving
                ? mapT('mapping.edit_tip', {site: s.serving.site, raster: s.serving.raster})
                : mapT('mapping.edit_tip_none');
        }
        // saved-map layer status (the latched site_map rendered in the 3D view)
        if (this.el_site_status) {
            if (s.serving) {
                const sv = s.serving;
                this._say(this.el_site_status, () => mapT('mapping.site.active_3d',
                    {site: sv.site, raster: sv.raster}));
            } else {
                this._say(this.el_site_status, () => mapT('mapping.site.none'));
            }
        }
        if (s.running) {
            const up = Math.floor(s.uptime_s / 60), rSite = s.site;
            this._say(this.el_run, () => mapT('mapping.run.recording', {site: rSite, min: up}));
            vtTone(this.el_run, 'ok');
        } else {
            this._say(this.el_run, () => mapT('mapping.run.idle'));
            vtTone(this.el_run, '');
            this._say(this.el_gate, () => '—');
            vtTone(this.el_gate, '');
        }
        // sites list: datalist for the input + chips with stats
        // vitulus_ui: layout-jitter fix (sibling of the dock.js dock-tab fix,
        // 2026-07-18) — /mapping_manager/status is a continuous subscription
        // that previously rebuilt this chip row from scratch on every single
        // message even when the site list hadn't changed, which is wasted
        // work and a needless reflow source. Skip the rebuild when the data
        // driving it is unchanged.
        // per-raster mgmt: the signature now also folds in `previewing` (so the
        // active-preview row highlight / ✓ badge updates) — raster_list itself is
        // already inside JSON.stringify(s.sites), so a new/removed raster or a
        // changed cell count re-renders the expanded panel without rebuilding
        // every tick. Client-side expand/collapse state is NOT in the signature:
        // it is preserved across rebuilds (this._expandedSites) and drives a
        // direct re-render on toggle.
        const sitesSig = JSON.stringify(s.sites || []) + '|' +
            (s.serving ? s.serving.site + '/' + s.serving.raster : '') + '|' +
            (s.previewing ? s.previewing.site + '/' + s.previewing.raster : '') + '|' +
            (s.running ? s.site : '');
        if (this._lastSitesSig === sitesSig) {
            return;
        }
        this._lastSitesSig = sitesSig;
        this._lastStatus = s;
        this.renderSitesRow(s);
    }

    // per-raster mgmt: unix-seconds -> "MM-DD HH:MM" for raster rows.
    _fmtRasterDate(mtime) {
        try {
            const d = new Date(mtime * 1000);
            const p = (n) => (n < 10 ? '0' + n : '' + n);
            return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
                   p(d.getHours()) + ':' + p(d.getMinutes());
        } catch (e) { return '—'; }
    }

    // Render the Maps chip row + (per-raster mgmt) the expandable per-site raster
    // panel. Called from handleManager (on a real data change) and directly on an
    // expand/collapse toggle. Rebuilds via createElement so per-raster listeners
    // attach cleanly; expanded/collapsed state lives in this._expandedSites and
    // survives rebuilds.
    renderSitesRow(s) {
        if (!this._expandedSites) { this._expandedSites = new Set(); }
        this.datalist.innerHTML = '';
        this.el_sites.innerHTML = '';
        (s.sites || []).forEach((site) => {
            const o = document.createElement('option');
            o.value = site.name;
            this.datalist.appendChild(o);
            this.el_sites.appendChild(this._buildMapCard(s, site));
        });
    }

    // ---- map library helpers (2026-09-13 redesign, map_library.css) -------
    _mlEl(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (html !== undefined) { e.innerHTML = html; }
        return e;
    }
    _mlChip(kind, text, blink) {
        return this._mlEl('span', 'ml-chip ' + kind,
            (blink ? '<span class="ml-blink"></span>' : '') + text);
    }
    _mlBtn(cls, html, title, onClick) {
        const b = this._mlEl('button', 'ml-btn ' + cls, html);
        b.type = 'button';
        b.title = title || '';
        if (onClick) {
            b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(ev); });
        }
        return b;
    }
    _mlNum(n) {
        const loc = (window.VTI18n && VTI18n.lang() === 'cs') ? 'cs-CZ' : 'en-US';
        return (n === null || n === undefined) ? '—' : Number(n).toLocaleString(loc);
    }
    _mlDate(mtime) {
        try {
            const d = new Date(mtime * 1000);
            // 'mapping.months' = twelve short month names, space separated
            const mon = mapT('mapping.months').split(' ')[d.getMonth()] || '';
            const p = (n) => (n < 10 ? '0' + n : '' + n);
            return mapT('mapping.date', {d: d.getDate(), mon: mon, y: d.getFullYear(),
                time: p(d.getHours()) + ':' + p(d.getMinutes())});
        } catch (e) { return '—'; }
    }
    _mlEsc(t) {
        return String(t).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    }
    _mlActivate(ref) {
        this.input_site.value = ref.split('/')[0];
        this.pub_serve.publish(new ROSLIB.Message({data: ref}));
        if (this.el_serving) {
            this.el_serving.hidden = false;
            this._say(this.el_serving, () => mapT('mapping.serving.activating', {ref: ref}));
            vtTone(this.el_serving, '');
        }
    }

    // One card per map: header (name, state chips, Activate, delete) and, when
    // expanded, the COMBINED map row + the mapping sessions as LAYERS.
    // State language: green left edge/chip = active (served), orange =
    // recording, dimmed = no session yet.
    _buildMapCard(s, site) {
        const recording = !!(s.running && s.site === site.name);
        const served = !!(s.serving && s.serving.site === site.name);
        const servable = site.rasters > 0;
        const expanded = this._expandedSites.has(site.name);
        const card = this._mlEl('div', 'ml-card' + (served ? ' is-active' : '') +
            (recording ? ' is-rec' : '') + (!servable && !recording ? ' is-empty' : ''));

        const head = this._mlEl('div', 'ml-head');
        head.title = expanded ? mapT('common.collapse') : mapT('mapping.card.expand_tip');
        head.appendChild(this._mlEl('span', 'ml-caret', expanded ? '▾' : '▸'));
        head.appendChild(this._mlEl('i', 'fa fa-tree ml-ico'));
        const name = this._mlEl('span', 'ml-name', this._mlEsc(site.name));
        name.title = site.name;
        head.appendChild(name);
        if (served) { head.appendChild(this._mlChip('ok', mapT('mapping.chip.active'))); }
        if (recording) { head.appendChild(this._mlChip('rec', mapT('mapping.chip.recording'), true)); }
        if (!servable && !recording) { head.appendChild(this._mlChip('muted', mapT('mapping.chip.no_session'))); }
        const n = site.rasters || 0;
        const area = (site.dem_m2 !== undefined) ? site.dem_m2 + ' m²' : (site.dem_kb ? site.dem_kb + ' kB' : '');
        // vitulus-field#46: programs belong to their map and are deleted with it
        const progs = site.programs || [];
        const progsText = mapTn('mapping.n_programs', progs.length);
        const meta = this._mlEl('span', 'ml-meta',
            (area ? area + ' · ' : '') + mapTn('mapping.n_sessions', n) +
            (progs.length ? ' · ' + progsText : ''));
        if (progs.length) { meta.title = mapT('mapping.card.programs_tip', {list: progs.join(', ')}); }
        head.appendChild(meta);

        const actions = this._mlEl('div', 'ml-actions');
        const servingCombined = served && site.combined && s.serving.raster === site.combined.name;
        const act = this._mlBtn('go' + (servingCombined ? ' is-on' : ''),
            servingCombined ? '<i class="fa fa-check"></i> ' + mapT('mapping.btn.active') : mapT('mapping.btn.activate'),
            servable
                ? (servingCombined ? mapT('mapping.card.active_tip')
                   : mapT('mapping.card.activate_tip'))
                : mapT('mapping.card.no_session_tip'),
            () => this._mlActivate(site.name));
        act.disabled = !servable || servingCombined;
        actions.appendChild(act);
        const del = this._mlBtn('del icon', '<i class="fa fa-trash"></i>', '');
        if (recording || served) {
            del.disabled = true;
            del.title = recording ? mapT('mapping.card.del_recording') : mapT('mapping.card.del_active');
        } else {
            del.title = progs.length
                ? mapTn('mapping.card.del_with_programs_tip', progs.length, {list: progs.join(', ')})
                : mapT('mapping.card.del_tip');
            this._wireDoubleClickDelete(del,
                () => this.pub_remove.publish(new ROSLIB.Message({data: site.name})),
                '<i class="fa fa-trash"></i>',
                progs.length ? mapTn('mapping.card.del_with_programs', progs.length) : '');
        }
        actions.appendChild(del);
        head.appendChild(actions);
        head.addEventListener('click', () => {
            this.input_site.value = site.name;
            this.pub_show.publish(new ROSLIB.Message({data: site.name}));
            if (this._expandedSites.has(site.name)) {
                this._expandedSites.delete(site.name);
            } else {
                this._expandedSites.add(site.name);
            }
            if (this._lastStatus) { this.renderSitesRow(this._lastStatus); }
        });
        card.appendChild(head);
        if (expanded) { card.appendChild(this._buildLayersBody(s, site)); }
        return card;
    }

    // Card body: the COMBINED map (primary, cyan) first, then LAYERS = the
    // mapping sessions (newest first) with an include switch, Preview,
    // Activate and Delete. Active = green dot + chip; excluded = dimmed +
    // struck through; previewed = blue outline (matches the 3D overlay).
    _buildLayersBody(s, site) {
        const body = this._mlEl('div', 'ml-body');
        const list = site.raster_list || [];
        const c = site.combined || null;
        const servingR = (s.serving && s.serving.site === site.name) ? s.serving.raster : null;
        const previewR = (s.previewing && s.previewing.site === site.name) ? s.previewing.raster : null;
        const ref = (r) => site.name + '/' + r;

        const mkRow = (opts) => {
            const row = this._mlEl('div', 'ml-row' + (opts.primary ? ' primary' : '') +
                (opts.active ? ' is-active' : '') + (opts.preview ? ' is-preview' : '') +
                (opts.off ? ' is-off' : ''));
            // line 1: state dot + title + chips; line 2: id/counts + actions.
            // Two fixed lines instead of one wrapping line: the narrow Map
            // panel (~330 px) never squeezes the title into "16 Au…".
            const line1 = this._mlEl('div', 'ml-line1');
            line1.appendChild(this._mlEl('span', 'ml-dot'));
            line1.appendChild(this._mlEl('span', 'ml-title', opts.title));
            (opts.chips || []).forEach((ch) => line1.appendChild(ch));
            if (opts.tip) { line1.title = opts.tip; }
            row.appendChild(line1);
            const foot = this._mlEl('div', 'ml-foot');
            foot.appendChild(this._mlEl('div', 'ml-sub', opts.sub));
            const acts = this._mlEl('div', 'ml-actions');
            (opts.actions || []).forEach((a) => acts.appendChild(a));
            foot.appendChild(acts);
            row.appendChild(foot);
            return row;
        };
        const eyeBtn = (r, isPreview, what) => this._mlBtn('eye icon' + (isPreview ? ' is-on' : ''),
            '<i class="fa fa-' + (isPreview ? 'eye' : 'eye-slash') + '"></i>',
            isPreview ? mapT('mapping.layer.hide_preview') : mapT('mapping.layer.preview_tip.' + what),
            () => this.pub_preview_raster.publish(new ROSLIB.Message({data: isPreview ? '' : ref(r)})));
        const goBtn = (r, isServed, what) => {
            const b = this._mlBtn('go' + (isServed ? ' is-on' : ''),
                isServed ? '<i class="fa fa-check"></i> ' + mapT('mapping.btn.active') : mapT('mapping.btn.activate'),
                isServed ? mapT('mapping.layer.is_active.' + what) : mapT('mapping.layer.make_active.' + what),
                () => this._mlActivate(ref(r)));
            b.disabled = isServed;
            return b;
        };

        if (c) {
            const isServed = (c.name === servingR);
            const nSrc = (c.sources || []).length;
            const nEx = (c.excluded || []).length;
            const chips = [];
            if (isServed) { chips.push(this._mlChip('ok', mapT('mapping.chip.active'))); }
            else if (servingR) { chips.push(this._mlChip('warn', mapT('mapping.chip.not_active'))); }
            if (nEx) { chips.push(this._mlChip('warn', mapTn('mapping.chip.n_excluded', nEx))); }
            const rebuild = this._mlBtn('icon', '<i class="fa fa-refresh"></i>',
                c.built ? mapT('mapping.combined.rebuild_tip_built', {built: c.built})
                        : mapT('mapping.combined.rebuild_tip'),
                () => this.pub_rebuild_combined.publish(new ROSLIB.Message({data: site.name})));
            body.appendChild(mkRow({
                primary: true, active: isServed, preview: c.name === previewR,
                title: '<i class="fa fa-clone vt-mr1 vt-accent"></i>' + mapT('mapping.combined.title'),
                chips: chips,
                sub: mapTn('mapping.n_sessions', nSrc) + ' · ' + mapT('mapping.cells',
                     {obst: this._mlNum(c.cells_obstacle), free: this._mlNum(c.cells_free)}),
                tip: c.built ? mapT('mapping.combined.tip_built', {built: c.built})
                             : mapT('mapping.combined.tip'),
                actions: [eyeBtn(c.name, c.name === previewR, 'combined'),
                          goBtn(c.name, isServed, 'combined'), rebuild],
            }));
        }

        const sec = this._mlEl('div', 'ml-sec', '<i class="fa fa-bars vt-dim"></i> ' + mapT('mapping.layers.title'));
        const nOn = list.filter((r) => r.enabled !== false).length;
        sec.appendChild(this._mlEl('span', 'ml-sec-state',
            list.length ? ((c || nOn < list.length) ? mapT('mapping.layers.included', {on: nOn, n: list.length}) : mapT('mapping.layers.sessions')) : ''));
        body.appendChild(sec);
        if (!list.length) {
            body.appendChild(this._mlEl('div', 'ml-empty', mapT('mapping.layers.empty')));
            return body;
        }
        list.forEach((r) => {
            const enabled = (r.enabled !== false);
            const isServed = (r.name === servingR);
            const chips = [];
            if (isServed) { chips.push(this._mlChip('ok', mapT('mapping.chip.active'))); }
            if (isServed && c) { chips.push(this._mlChip('warn', mapT('mapping.chip.single'))); }
            if (!enabled) { chips.push(this._mlChip('muted', mapT('mapping.chip.excluded'))); }
            const actions = [];
            // the include switch stays even without a combined map: a site
            // whose sessions are all excluded has none, and the switch is the
            // only way back (vitulus-field#47)
            {
                const sw = this._mlEl('label', 'ml-switch');
                sw.title = enabled ? mapT('mapping.layer.included_tip')
                                   : mapT('mapping.layer.excluded_tip');
                const inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.checked = enabled;
                inp.addEventListener('change', () => {
                    this.pub_layer_enable.publish(new ROSLIB.Message(
                        {data: ref(r.name) + ':' + (inp.checked ? 'on' : 'off')}));
                });
                sw.appendChild(inp);
                sw.appendChild(this._mlEl('span', 'ml-track'));
                sw.addEventListener('click', (ev) => ev.stopPropagation());
                actions.push(sw);
            }
            actions.push(eyeBtn(r.name, r.name === previewR, 'session'));
            actions.push(goBtn(r.name, isServed, 'session_alone'));
            const del = this._mlBtn('del icon', '<i class="fa fa-trash"></i>', '');
            if (isServed) {
                del.disabled = true;
                del.title = mapT('mapping.layer.del_active');
            } else {
                del.title = mapT('mapping.layer.del_tip');
                this._wireDoubleClickDelete(del,
                    () => this.pub_remove_raster.publish(new ROSLIB.Message({data: ref(r.name)})),
                    '<i class="fa fa-trash"></i>');
            }
            actions.push(del);
            body.appendChild(mkRow({
                active: isServed, preview: r.name === previewR, off: !enabled,
                title: this._mlDate(r.mtime), chips: chips,
                sub: mapT('mapping.cells', {obst: this._mlNum(r.cells_obstacle), free: this._mlNum(r.cells_free)}),
                tip: mapT(enabled ? 'mapping.layer.tip' : 'mapping.layer.tip_excluded', {name: r.name}),
                actions: actions,
            }));
        });
        if (c && servingR && servingR !== c.name) {
            body.appendChild(this._mlEl('div', 'ml-hint',
                '<i class="fa fa-exclamation-triangle"></i> ' + mapT('mapping.layers.single_hint')));
        }
        return body;
    }

    // Double-click-confirm on a delete button (never window.confirm): first
    // click arms + relabels "Confirm?" for 3 s; a second click within the window
    // fires onConfirm. `restoreHtml` is the button's normal inner HTML;
    // `armedLabel` (plain text) replaces "Sure?" when the delete takes more
    // with it than the button says. `restoreHtml` may be a function (i18n:
    // the label in the current language; re-drawn on a language switch).
    _wireDoubleClickDelete(btn, onConfirm, restoreHtml, armedLabel) {
        if (!btn) { return; }
        let armed = false, timer = null;
        const restore = (typeof restoreHtml === 'function') ? restoreHtml : () => restoreHtml;
        if (typeof restoreHtml === 'function') {
            btn.innerHTML = restore();
            this._relabel.push(() => { if (!armed) { btn.innerHTML = restore(); } });
        }
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!armed) {
                armed = true;
                btn.classList.add('btn-danger');
                // compact label + let the button grow past its normal fixed
                // width so the armed state never clips (field report 19.7.)
                btn.classList.add('vt-armed');      // width:auto + nowrap (vt_panel.css)
                btn.innerHTML = '<span class="vt-fs-xs"></span>';
                btn.firstChild.textContent = mapT('mapping.sure');
                if (armedLabel) { btn.firstChild.textContent = armedLabel; }
                timer = setTimeout(() => {
                    armed = false;
                    btn.classList.remove('btn-danger');
                    btn.innerHTML = restore(); btn.classList.remove('vt-armed');
                }, 3000);
                return;
            }
            if (timer) { clearTimeout(timer); }
            armed = false;
            // 2026-08-10 fix: restore the button after CONFIRM too — the
            // delete buttons masked this because renderSitesRow rebuilds
            // their DOM, but the static session buttons (Reset map /
            // Discard) stayed stuck on a red "Sure?" forever.
            btn.classList.remove('btn-danger');
            btn.innerHTML = restore();
            btn.classList.remove('vt-armed');
            onConfirm();
        });
    }

    handleGate(msg) {
        if (!this.running) return;
        let g;
        try { g = JSON.parse(msg.data); } catch (e) { return; }
        this._lastGateMsg = msg;

        // 2026-08-16 field fix: when a FRESH site's datum gets captured
        // mid-session (start without RTK, fix arrives outside), the aerial
        // tiles were placed from the stale/dangling datum until a full page
        // reload. Auto-refresh the tiles on the capture edge.
        if (g.datum_captured && !this._aerialDatumCaptured) {
            this._aerialDatumCaptured = true;
            this.aerial_datum = null;
            if (this.chk_aerial && this.chk_aerial.checked) this.rebuildAerial();
        } else if (!g.datum_captured) {
            this._aerialDatumCaptured = false;
        }

        // range caps: prefill inputs (unless user is mid-edit) and show applied
        if (g.lidar_max_m !== undefined && g.depth_max_m !== undefined) {
            if (!this.ranges_edited && this.in_lidar_max) {
                this.in_lidar_max.value = g.lidar_max_m;
                this.in_depth_max.value = g.depth_max_m;
            }
            if (this.el_ranges_status) {
                const lidOff = (g.lidar_enabled === false);
                const lidM = g.lidar_max_m, depM = g.depth_max_m, zc = g.z_corr_mode;
                this._say(this.el_ranges_status, () => {
                    const lid = lidOff ? mapT('mapping.ranges.lidar_off')
                        : mapT('mapping.ranges.lidar', {m: lidM});
                    return mapT('mapping.ranges.status', {lidar: lid, depth: depM}) +
                        (zc ? ' | z-corr: ' + zc : '');
                });
                vtTone(this.el_ranges_status, '');
            }
        }

        const c = g.counters || {};
        let io_in = 0, io_out = 0;
        Object.keys(c).forEach((k) => { io_in += c[k].in; io_out += c[k].out; });
        const detail = [];
        if (g.pose_src) detail.push('pose:' + g.pose_src);
        if (g.rtk_fixed !== undefined) detail.push(g.rtk_fixed ? 'RTK✓' : mapT('mapping.gate.no_rtk'));
        if (g.heading_rtk === false) detail.push(mapT('mapping.gate.hdg_no_fix'));
        if (g.hacc_mm !== undefined) detail.push('hAcc ' + Math.round(g.hacc_mm) + 'mm');
        if (g.heading_diff_deg !== undefined) detail.push('Δhdg ' + g.heading_diff_deg + '°');
        if (g.z_source) detail.push('z:' + g.z_source);
        if (g.map_corrections) detail.push(mapT('mapping.gate.corrections', {n: g.map_corrections}));
        detail.push(mapT('mapping.gate.clouds', {out: io_out, in: io_in}));
        if (g.pass) {
            this._say(this.el_gate, () => mapT('mapping.gate.open',
                {mode: g.mode, detail: detail.join(', ')}));
            vtTone(this.el_gate, 'ok');
        } else {
            this._say(this.el_gate, () => mapT('mapping.gate.closed',
                {mode: g.mode, reasons: (g.reasons || []).join(', '), detail: detail.join(', ')}));
            vtTone(this.el_gate, g.mode === 'off' ? '' : 'warn');
        }
    }

    handleDem(msg) {
        let d;
        try { d = JSON.parse(msg.data); } catch (e) { return; }
        // live terrain plane bounds (grows as the DEM grows while mapping)
        if (d.terrain_bounds) {
            this.terrain_bounds = d.terrain_bounds;
            this.rebuildTerrain();
        }
        this._lastDemMsg = d;
        this._renderDem(d);
    }

    _renderDem(d) {
        const zr = d.z_range ? (', z ' + d.z_range[0] + '…' + d.z_range[1] + ' m') : '';
        this._say(this.el_dem, () => mapT('mapping.dem.status', {area: d.area_traj_m2, n: d.samples}) + zr +
            (d.gps_alt_ok ? '' : mapT('mapping.dem.no_alt')) +
            (d.dz_skips ? mapT('mapping.dem.dz_skips', {n: d.dz_skips}) : ''));
        vtTone(this.el_dem, d.gps_alt_ok ? '' : 'warn');
    }

    handleProjector(msg) {
        let p;
        try { p = JSON.parse(msg.data); } catch (e) { return; }

        // obstacle classification: prefill the inputs (unless the user is
        // mid-edit) and always show the currently-applied values
        if (p.band_min !== undefined && p.band_max !== undefined) {
            if (!this.band_edited && this.in_band_min) {
                this.in_band_min.value = p.band_min;
                this.in_band_max.value = p.band_max;
                if (p.min_evidence !== undefined)
                    this.in_min_evidence.value = p.min_evidence;
                if (p.min_cluster_cells !== undefined)
                    this.in_min_cluster.value = p.min_cluster_cells;
            }
            if (this.el_band_status) {
                this._say(this.el_band_status, () => mapT('mapping.band.status',
                    {min: p.band_min, max: p.band_max, ev: p.min_evidence, cl: p.min_cluster_cells}));
                vtTone(this.el_band_status, '');
            }
        }

        this._say(this.el_proj, () => {
            let txt = mapT('mapping.proj.voxels', {state: p.state, n: (p.octomap_points || 0).toLocaleString((window.VTI18n ? VTI18n.lang() : undefined))});
            if (p.cells_obstacle !== undefined) {
                txt += mapT('mapping.proj.raster', {obst: p.cells_obstacle, free: p.cells_free, s: p.took_s});
            }
            if (p.iou_obstacles !== undefined && p.iou_obstacles !== null) {
                txt += ' | IoU vs rtabmap ' + Math.round(p.iou_obstacles * 100) + '%';
            }
            if (p.error) txt += ' | ' + p.error;
            return txt;
        });
        vtTone(this.el_proj, p.state === 'error' ? 'err' : '');
    }

    // environment preset <select>: rebuild only when the name list
    // changes (signature guard), keeping the current selection. Fed by
    // direct_status.presets (session) and /mapping_manager/direct_presets
    // (always) — same list, so the guard keeps them from fighting.
    _fillDirectPresets(presets) {
        if (!this.sel_direct_preset || !Array.isArray(presets)) return;
        this._lastPresets = presets;
        const sig = presets.map(
            (p) => p.name + (p.builtin ? '*' : '')).join('|');
        if (sig === this._directPresetSig) return;
        this._directPresetSig = sig;
        const cur = this.sel_direct_preset.value;
        this.sel_direct_preset.innerHTML = '';
        presets.forEach((p) => {
            const o = document.createElement('option');
            o.value = p.name;
            o.textContent = p.builtin ? p.name : mapT('mapping.preset.custom', {name: p.name});
            this.sel_direct_preset.appendChild(o);
        });
        if (cur && presets.some((p) => p.name === cur)) {
            this.sel_direct_preset.value = cur;
        } else {
            // settings-persistence: first fill (or vanished selection)
            // -> re-select the preset remembered from the last session.
            // Selection only — nothing is applied/published here.
            const remembered = this._strPref('vitulus_direct_preset_sel', '');
            if (remembered && presets.some((p) => p.name === remembered)) {
                this.sel_direct_preset.value = remembered;
            }
        }
        if (!this._directPresetSelWired) {
            this._directPresetSelWired = true;
            this.sel_direct_preset.addEventListener('change', () => {
                this._saveStrPref('vitulus_direct_preset_sel',
                    this.sel_direct_preset.value);
            });
        }
    }

    // Direct 2D raster mapper status — /mapping/direct_status, latched,
    // ~1.5 Hz: {enabled, pass, reasons[], counters{lidar,cam_obstacle,
    // cam_free:{in,throttled,gate_closed,passed}}, settings{...},
    // grid{occ_cells,free_cells,observed_cells,shape,res,obstacle_frames,
    // free_frames}}.
    handleDirectStatus(msg) {
        let s;
        try { s = JSON.parse(msg.data); } catch (e) { return; }
        this._lastDirectMsg = msg;
        // Sensing layer: live mapper ranges / sources / gate (MapSensing below)
        if (this.sensing) { this.sensing.onDirect(s); }

        // a status arriving while an Apply is pending = the session node
        // received + echoed the settings -> show a clear applied tick
        if (this._direct_apply_pending) {
            this._direct_apply_pending = null;
            this._direct_applied_until = Date.now() + 4000;
        }

        // Re-sync the live controls from the backend's echoed settings —
        // immediately on the first status, then continuously WHENEVER the
        // user has not touched the controls for 3 s (keeps multiple open
        // browsers consistent and reflects preset loads / other clients
        // without fighting an in-progress drag; a rejected value visibly
        // snaps back to the backend truth).
        const touchedRecently = (Date.now() - this._directLastTouch) < 3000;
        if (s.settings && (!this._directSettingsSeen || !touchedRecently)) {
            this._directSettingsSeen = true;
            const st = s.settings;
            this._directChecks.forEach(([el, key]) => {
                if (el && st[key] !== undefined) el.checked = !!st[key];
            });
            this._directSliders.forEach(([el, key, dec, unit]) => {
                if (el && st[key] !== undefined) {
                    el.value = st[key];
                    this._setDirectValLabel(el, dec, unit);
                }
            });
        }

        this._fillDirectPresets(s.presets);

        if (!this.el_direct_status) return;
        const g = s.grid || {};
        const c = s.counters || {};
        const passed = (k) => (c[k] && c[k].passed !== undefined) ? c[k].passed : '—';
        let txt = mapT('mapping.direct.status', {
            state: s.enabled ? mapT('common.enabled') : mapT('common.disabled'),
            gate: s.pass === false ? mapT('mapping.direct.gate_closed') : '',
            occ: (g.occ_cells !== undefined ? g.occ_cells : '—'),
            free: (g.free_cells !== undefined ? g.free_cells : '—'),
            lidar: passed('lidar'), obst: passed('cam_obstacle'), cfree: passed('cam_free')});
        if (s.reasons && s.reasons.length) {
            txt += ' — ' + s.reasons.join(', ');
        }
        const applied = this._direct_applied_until &&
            Date.now() < this._direct_applied_until;
        this._say(this.el_direct_status, () =>
            (applied ? mapT('mapping.direct.applied') + ' \u00b7 ' : '') + txt);
        vtTone(this.el_direct_status, applied ? 'ok'
            : ((s.reasons && s.reasons.length) ? 'warn' : ''));
    }
}

// vitulus_ui 2026-07-18 — Map tab collapsible <details.map-sec> open-state
// persistence. Each section carries data-mapsec="<name>"; the open/closed
// state is remembered across reloads under localStorage key
// 'vitulus_maptab_<name>'. Sections default to COLLAPSED (their markup omits
// the `open` attribute); a stored '1' re-opens them. Fully self-contained and
// independent of the ROS map view.
(function initMapTabSections() {
    // Wire one group of collapsible <details> to localStorage under a key
    // prefix. `attr` names the data-* attribute carrying the section id.
    function wireGroup(selector, attr, prefix) {
        var secs = document.querySelectorAll(selector);
        for (var i = 0; i < secs.length; i++) {
            (function (d) {
                var name = d.getAttribute(attr) || '';
                if (!name) { return; }
                var key = prefix + name;
                try {
                    var v = localStorage.getItem(key);
                    if (v === '1') { d.open = true; }
                    else if (v === '0') { d.open = false; }
                } catch (e) { /* localStorage unavailable */ }
                d.addEventListener('toggle', function () {
                    try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (e) { /* ignore */ }
                });
            })(secs[i]);
        }
    }
    function wire() {
        // Map tab (Phase 1)
        wireGroup('#tab-map details.map-sec', 'data-mapsec', 'vitulus_maptab_');
        // Phase 2 drawer panels (Path / Point / Dock / Rain / Loc)
        wireGroup('details.drawer-sec', 'data-drawersec', 'vitulus_drawer_');
        // Map-editor panel sections (2026-08-15 settings-persistence pass)
        wireGroup('#div_map_detail details.mapedit-sec', 'data-editsec', 'vitulus_editsec_');
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();


// ===========================================================================
// SENSING LAYER (2026-10-18, owner: "while mapping, show the area in which
// the lidar and the camera are collecting free space / obstacles")
// ---------------------------------------------------------------------------
// A map layer ("Sensing", Layers row, #mapv3_chk_sensing) drawn flat on the
// ground around the robot:
//   * LIDAR (violet) — the live scan polygon exactly as the Direct mapper
//     (vitulus_mapping/nodes/direct_raster, cb_scan) ingests it: a beam that
//     HIT something inside the mapper's cap is drawn to the hit (stronger
//     fill + outline = what is being hit); a no-return / beyond-cap beam is a
//     free ray to the cap (faint fill, faint arc at the cap); a beam the mapper
//     ignores (range_min, weak return, filter-rejected NaN) leaves a gap.
//   * CAMERA (yellow) — the D435 view cone from the camera mount: the
//     horizontal FOV of the image the depth cloud is built from
//     (rtabmap rgb camera_info_out, aligned depth) × the mapper's camera range
//     (obstacle_max_range_m / free_max_range_m, never beyond the
//     depth2cloud_wide max_depth 4.0 m).
//   * COVERED (faint union of both) — while a recording runs and the mapper's
//     insertion gate is open, every footprint is painted into one 512×512 px
//     canvas at 0.2 m/px (~100 m square, 1 MB, re-centred when the robot
//     leaves it): what has already been observed in this session. Cleared on
//     a new recording and on Reset map.
// Ranges are the CONFIGURED mapper values (what the map actually ingests,
// not the raw sensor max): /mapping/direct_status settings while a session
// runs, the mapping_v3.yaml defaults otherwise. Sensor poses come from TF
// (base_scan, d435_link via the shared map TF client); until TF arrives the
// URDF mounts below stand in (composed with base_link).
// Cost: the scan is subscribed ONLY while the layer is on and the page is
// visible, throttled by rosbridge to 5 Hz (queue 1), downsampled to 360
// beams, drawn into pre-allocated buffers (no per-frame allocation); the
// coverage texture re-uploads at most once a second. Default: ON while a
// recording runs (switched on at its start, off at its end), OFF otherwise.
// ROS3D bundles its own THREE (r89-era API): everything is built from
// ROS3D.THREE (see the _r3d() note in MappingV3) — a window.THREE object
// would kill the render loop.
// ===========================================================================
const SENSING_CFG = {
    scanTopic: '/rplidar/scan_filtered',        // direct_raster ~lidar_scan_topic
    camInfoTopic: '/rtabmap/rgb/camera_info_out', // intrinsics of the depth cloud
    lidarFrame: 'base_scan',
    camFrame: 'd435_link',
    // mapping_v3.yaml direct_raster defaults (live values from direct_status)
    lidarMaxRange: 8.0,          // lidar_max_range_m
    lidarFreeNoHit: true,        // lidar_free_no_hit
    camObstacleRange: 2.8,       // obstacle_max_range_m
    camFreeRange: 2.8,           // free_max_range_m
    camCloudMax: 4.0,            // depth2cloud_wide max_depth (hard ceiling)
    // half-FOV left/right of the optical axis (rad) for K 640×480 fx 616.78
    // cx 326.22: atan(cx/fx), atan((w-cx)/fx) — 54.9° in total
    camHalfLeft: 0.4866,
    camHalfRight: 0.4706,
    // URDF mounts (tf base_link->base_scan / ->d435_link, 2026-10-18), used
    // only until the sensor frames arrive over TF
    lidarMount: {x: 0.062, y: 0.0, yaw: -Math.PI / 2},
    camMount: {x: 0.212, y: 0.042, yaw: 0.0},
    maxBeams: 360,
    throttleMs: 200,             // ~5 Hz
    coverRes: 0.2,               // m per coverage pixel
    coverPx: 512,
    z: 0.03,                     // drawn flat just above the ground layers
    colLidar: 0xb388ff, colCam: 0xffd23f,
    cssLidar: '#b388ff', cssCam: '#ffd23f',
};

// Per-beam classification with the SAME rules as direct_raster.cb_scan:
//   1 hit  : finite, range_min <= r <= cap (and >= the live intensity gate)
//   2 free : no-return (inf / NaN with intensity 0 / >= range_max) or a
//            finite return beyond the cap -> free ray to the cap, only when
//            lidar_free_no_hit
//   0      : everything else — the mapper skips it (unknown), so we do too.
// rosbridge sends inf/NaN as null; the intensity tells them apart as in the
// mapper (NaN + intensity > 0 = filter-rejected real return = unknown).
// Downsampled to <= maxBeams. Returns {a, r, k, n} (angle, drawn range, kind).
function sensingClassifyBeams(scan, cap, freeNoHit, minInt, maxBeams) {
    const R = (scan && scan.ranges) || [];
    const n = R.length;
    const I = (scan.intensities && scan.intensities.length === n) ? scan.intensities : null;
    const step = Math.max(1, Math.ceil(n / Math.max(1, maxBeams || n)));
    const m = Math.ceil(n / step);
    const a = new Float32Array(m), r = new Float32Array(m), k = new Uint8Array(m);
    const rmin = Number(scan.range_min) || 0;
    const rmax = (Number(scan.range_max) > 0) ? Number(scan.range_max) : Infinity;
    const a0 = Number(scan.angle_min) || 0, inc = Number(scan.angle_increment) || 0;
    for (let i = 0, j = 0; i < n; i += step, j++) {
        const v = R[i];
        const fin = (typeof v === 'number') && isFinite(v);
        const inten = I ? Number(I[i]) : null;
        a[j] = a0 + i * inc;
        let kind = 0, rr = 0;
        const weak = minInt > 0 && I !== null && !(inten >= minInt);
        if (fin && v >= rmin && v <= cap && !weak) {
            kind = 1; rr = v;
        } else if (freeNoHit) {
            const beyond = fin && v > cap;
            const noret = (fin && v >= rmax) || v === Infinity ||
                (!fin && v !== -Infinity && (I === null || !(inten > 0)));
            if (beyond || noret) { kind = 2; rr = cap; }
        }
        k[j] = kind; r[j] = rr;
    }
    return {a: a, r: r, k: k, n: m};
}

// 2-D part of a TF rotation (rows x,y of the matrix, columns x,y) — keeps a
// flipped (upside-down) mount correct, not just the yaw.
function sensingRot2(q) {
    const x = q.x || 0, y = q.y || 0, z = q.z || 0, w = (q.w === undefined) ? 1 : q.w;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z),
            2 * (x * y + w * z), 1 - 2 * (x * x + z * z)];
}

class MapSensing {
    constructor(ros, tfClient, viewer3d, mapping) {
        this.ros = ros;
        this.tf = tfClient;
        this.viewer3d = viewer3d;
        this.mapping = mapping || null;
        this.cfg = SENSING_CFG;
        // live mapper settings (direct_status), defaults until a session runs
        this.st = {
            use_lidar: true, lidar_max_range_m: this.cfg.lidarMaxRange,
            lidar_free_no_hit: this.cfg.lidarFreeNoHit, lidar_min_intensity: 0,
            use_cam_obstacle: true, obstacle_max_range_m: this.cfg.camObstacleRange,
            use_cam_free: true, free_max_range_m: this.cfg.camFreeRange,
        };
        this.running = null;        // recording state (null = not known yet)
        this.gatePass = null;       // direct_status.pass (null = no session)
        this.camHalfL = this.cfg.camHalfLeft;
        this.camHalfR = this.cfg.camHalfRight;
        this.tfBase = null; this.tfLidar = null; this.tfCam = null;
        this._tfSubscribed = false;
        this._scanSub = null; this._scanCb = (m) => this._onScan(m);
        this._lastScanAt = 0; this._lastScanRx = 0;
        this._coverDirty = false; this._coverUploadAt = 0; this._coverDrawAt = 0;
        this._camCounters = null; this._camStaleAt = 0; this._camLive = true;
        this.T = (typeof ROS3D !== 'undefined' && ROS3D.THREE) ? ROS3D.THREE : null;

        this.chk = this._ensureCheckbox();
        if (this.chk) {
            this.chk.checked = false;
            this.chk.addEventListener('change', () => this._sync());
        }
        document.addEventListener('visibilitychange', () => this._sync());
        // a scan stream that stops (lidar down, rosbridge gone) must not leave
        // a frozen footprint on the map
        setInterval(() => {
            if (this.group && this.group.visible && this._lastScanRx &&
                    Date.now() - this._lastScanRx > 2500) {
                this._setLidarVisible(false);
            }
        }, 1000);

        if (this.mapping) {
            this.mapping.sensing = this;
            // replay what MappingV3 already received before we existed
            const parse = (m) => { try { return m ? JSON.parse(m.data) : null; } catch (e) { return null; } };
            const sm = parse(this.mapping._lastManagerMsg);
            if (sm) { this.onSession(sm); }
            const sd = parse(this.mapping._lastDirectMsg);
            if (sd) { this.onDirect(sd); }
        }
    }

    // The checkbox is authored in index.html; a page served from an older
    // (Jinja-cached) index.html gets the same markup built here.
    _ensureCheckbox() {
        let chk = document.getElementById('mapv3_chk_sensing');
        if (chk) { return chk; }
        const row = document.querySelector('.map-layers-row');
        if (!row) { return null; }
        const div = document.createElement('div');
        div.className = 'form-check form-check-inline';
        div.setAttribute('data-i18n-title', 'mapt.layer.sensing_tip');
        div.innerHTML = '<input class="form-check-input" type="checkbox" id="mapv3_chk_sensing">' +
            '<label class="form-check-label vt-fs-sm" for="mapv3_chk_sensing">' +
            '<span data-i18n="mapt.layer.sensing">Sensing</span> ' +
            '<span class="vt-sw-b388ff">&#9632;</span><span class="vt-sw-ffd23f">&#9632;</span></label>';
        row.appendChild(div);
        if (window.VTI18n && VTI18n.apply) { VTI18n.apply(div); }
        return document.getElementById('mapv3_chk_sensing');
    }

    // ---- inputs from MappingV3 ---------------------------------------------
    onSession(s) {
        const run = !!(s && s.running);
        const prev = this.running;
        this.running = run;
        if (!this.chk) { return; }
        if (prev === null) {
            this.chk.checked = run;               // first status: default by state
            if (run) { this.clearCoverage(); }
        } else if (!prev && run) {
            this.clearCoverage();                 // a new recording = a new swath
            this.chk.checked = true;
        } else if (prev && !run) {
            this.chk.checked = false;
            this.gatePass = null;
        } else {
            return;
        }
        this._sync();
    }

    onDirect(d) {
        if (!d) { return; }
        if (d.settings && typeof d.settings === 'object') {
            Object.keys(this.st).forEach((k) => {
                if (d.settings[k] !== undefined && d.settings[k] !== null) { this.st[k] = d.settings[k]; }
            });
        }
        this.gatePass = (d.pass === undefined) ? null : d.pass;
        // camera liveness: the mapper counts incoming camera clouds; a count
        // that does not move for 5 s = the camera branch delivers nothing
        const c = d.counters || {};
        const sig = JSON.stringify([(c.cam_obstacle || {}).in, (c.cam_free || {}).in]);
        if (sig !== this._camCounters) { this._camCounters = sig; this._camStaleAt = Date.now(); this._camLive = true; }
        else if (Date.now() - this._camStaleAt > 5000) { this._camLive = false; }
    }

    clearCoverage() {
        if (!this.coverCtx) { this._coverCentre = null; return; }
        this.coverCtx.clearRect(0, 0, this.cfg.coverPx, this.cfg.coverPx);
        this._coverCentre = null;
        this._coverDirty = true;
        this._uploadCover(true);
    }

    // ---- subscriptions -------------------------------------------------------
    _wanted() {
        return !!(this.chk && this.chk.checked && !document.hidden && this.T &&
                  this.viewer3d && this.viewer3d.scene);
    }

    _sync() {
        const want = this._wanted();
        if (want) {
            this._ensureScene();
            this._ensureTf();
            this._ensureCamInfo();
            if (!this._scanSub) {
                this._scanSub = new ROSLIB.Topic({
                    ros: this.ros, name: this.cfg.scanTopic,
                    messageType: 'sensor_msgs/LaserScan',
                    throttle_rate: this.cfg.throttleMs, queue_length: 1,
                });
                this._scanSub.subscribe(this._scanCb);
            }
        } else if (this._scanSub) {
            try { this._scanSub.unsubscribe(this._scanCb); } catch (e) { /* ignore */ }
            this._scanSub = null;
        }
        if (this.group) { this.group.visible = !!(this.chk && this.chk.checked); }
        if (!want) { this._lastScanRx = 0; }
    }

    _ensureTf() {
        if (this._tfSubscribed || !this.tf) { return; }
        this._tfSubscribed = true;
        this.tf.subscribe('base_link', (t) => { this.tfBase = t; });
        this.tf.subscribe(this.cfg.lidarFrame, (t) => { this.tfLidar = t; });
        this.tf.subscribe(this.cfg.camFrame, (t) => { this.tfCam = t; });
    }

    _ensureCamInfo() {
        if (this._camInfoAsked) { return; }
        this._camInfoAsked = true;
        const t = new ROSLIB.Topic({ros: this.ros, name: this.cfg.camInfoTopic,
                                    messageType: 'sensor_msgs/CameraInfo'});
        const cb = (m) => {
            try { t.unsubscribe(cb); } catch (e) { /* ignore */ }
            const K = m && (m.K || m.k), w = m && m.width;
            if (K && K[0] > 0 && w > 0) {
                this.camHalfL = Math.atan(K[2] / K[0]);
                this.camHalfR = Math.atan((w - K[2]) / K[0]);
            }
        };
        t.subscribe(cb);
    }

    // ---- scene -----------------------------------------------------------------
    _ensureScene() {
        if (this.group || !this.T) { return; }
        const T = this.T, C = this.cfg;
        const ord = (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder : {};
        const live = (ord.SENSING !== undefined) ? ord.SENSING : 25;
        const under = (ord.SENSING_COVER !== undefined) ? ord.SENSING_COVER : 22;
        this.group = new T.Object3D();
        const mkMat = (col, op, line) => {
            const o = {color: col, transparent: true, opacity: op, depthWrite: false};
            const mat = line ? new T.LineBasicMaterial(o) : new T.MeshBasicMaterial(o);
            if (!line) { mat.side = T.DoubleSide; }
            return mat;
        };
        const mk = (nVerts, mat, line) => {
            const g = new T.BufferGeometry();
            const attr = new T.BufferAttribute(new Float32Array(nVerts * 3), 3);
            // the bundled THREE is r89-era (addAttribute / setDynamic)
            if (attr.setUsage && T.DynamicDrawUsage !== undefined) { attr.setUsage(T.DynamicDrawUsage); }
            else if (attr.setDynamic) { attr.setDynamic(true); }
            if (g.setAttribute) { g.setAttribute('position', attr); } else { g.addAttribute('position', attr); }
            g.setDrawRange(0, 0);
            const o = line ? new T.LineSegments(g, mat) : new T.Mesh(g, mat);
            o.frustumCulled = false;
            o.renderOrder = live;
            this.group.add(o);
            return o;
        };
        const NB = C.maxBeams + 2, ARC = 40;
        this.lidarHit = mk(NB * 3, mkMat(C.colLidar, 0.3), false);
        this.lidarFree = mk(NB * 3, mkMat(C.colLidar, 0.1), false);
        this.lidarEdge = mk(NB * 2, mkMat(C.colLidar, 0.9, true), true);
        this.lidarCap = mk(NB * 2, mkMat(C.colLidar, 0.3, true), true);
        this.camFill = mk(ARC * 3, mkMat(C.colCam, 0.2), false);
        this.camEdge = mk((ARC + 4) * 2 * 2, mkMat(C.colCam, 0.8, true), true);
        this._camMats = [this.camFill.material, this.camEdge.material];

        // accumulated coverage: one canvas texture on a plane in the map frame
        const px = C.coverPx;
        const cv = document.createElement('canvas');
        cv.width = px; cv.height = px;
        this.coverCanvas = cv;
        this.coverCtx = cv.getContext('2d');
        this.coverTex = new T.CanvasTexture(cv);
        this.coverTex.magFilter = T.NearestFilter;
        this.coverTex.generateMipmaps = false;
        this.coverTex.minFilter = T.LinearFilter;
        const side = px * C.coverRes;
        const pm = new T.MeshBasicMaterial({map: this.coverTex, transparent: true,
                                            opacity: 0.16, depthWrite: false});
        pm.side = T.DoubleSide;
        this.coverMesh = new T.Mesh(new (T.PlaneBufferGeometry || T.PlaneGeometry)(side, side), pm);
        this.coverMesh.renderOrder = under;
        this.coverMesh.position.z = C.z - 0.01;
        this.coverMesh.visible = false;
        this.coverMesh.frustumCulled = false;
        this.group.add(this.coverMesh);
        this._coverCentre = null;
        this.viewer3d.scene.add(this.group);
    }

    _setLidarVisible(v) {
        [this.lidarHit, this.lidarFree, this.lidarEdge, this.lidarCap]
            .forEach((o) => { if (o) { o.visible = v; } });
    }

    // sensor pose in the map frame: TF of the sensor frame, else base_link ∘ mount
    _pose(tfSensor, mount) {
        if (tfSensor && tfSensor.translation) {
            return {x: tfSensor.translation.x, y: tfSensor.translation.y,
                    R: sensingRot2(tfSensor.rotation || {})};
        }
        const b = this.tfBase;
        if (!b || !b.translation) { return null; }
        const Rb = sensingRot2(b.rotation || {});
        const yb = Math.atan2(Rb[2], Rb[0]);
        const c = Math.cos(yb + mount.yaw), s = Math.sin(yb + mount.yaw);
        return {x: b.translation.x + Rb[0] * mount.x + Rb[1] * mount.y,
                y: b.translation.y + Rb[2] * mount.x + Rb[3] * mount.y,
                R: [c, -s, s, c]};
    }

    // ---- per scan (<= 5 Hz) ----------------------------------------------------
    _onScan(msg) {
        const now = Date.now();
        this._lastScanRx = now;
        if (!this._wanted() || !this.group) { return; }
        if (now - this._lastScanAt < this.cfg.throttleMs * 0.9) { return; }
        this._lastScanAt = now;
        const C = this.cfg, st = this.st, z = C.z;
        const lp = this._pose(this.tfLidar, C.lidarMount);
        const cp = this._pose(this.tfCam, C.camMount);

        // --- lidar fan
        let runs = [];
        if (st.use_lidar !== false && lp) {
            const cap = Math.max(0.1, Number(st.lidar_max_range_m) || C.lidarMaxRange);
            const B = sensingClassifyBeams(msg, cap, st.lidar_free_no_hit !== false,
                                           Number(st.lidar_min_intensity) || 0, C.maxBeams);
            const R = lp.R, ox = lp.x, oy = lp.y;
            const ex = new Float32Array(B.n), ey = new Float32Array(B.n);
            for (let j = 0; j < B.n; j++) {
                const lx = B.r[j] * Math.cos(B.a[j]), ly = B.r[j] * Math.sin(B.a[j]);
                ex[j] = ox + R[0] * lx + R[1] * ly;
                ey[j] = oy + R[2] * lx + R[3] * ly;
            }
            const H = this.lidarHit.geometry.attributes.position.array;
            const F = this.lidarFree.geometry.attributes.position.array;
            const E = this.lidarEdge.geometry.attributes.position.array;
            const P = this.lidarCap.geometry.attributes.position.array;
            let nh = 0, nf = 0, ne = 0, np = 0;
            const inc = Math.abs(Number(msg.angle_increment) || 0);
            const span = B.n > 1 ? Math.abs(B.a[B.n - 1] - B.a[0]) : 0;
            const step = B.n > 1 ? span / (B.n - 1) : 0;
            const wrap = B.n > 2 && span + step * 1.5 >= 2 * Math.PI - 1e-3 && inc > 0;
            const pairs = wrap ? B.n : B.n - 1;
            let run = null;
            for (let j = 0; j < pairs; j++) {
                const i2 = (j + 1) % B.n;
                const k1 = B.k[j], k2 = B.k[i2];
                if (!k1 || !k2) { if (run) { runs.push(run); run = null; } continue; }
                const both = (k1 === 1 && k2 === 1);
                const A = both ? H : F;
                let o = both ? nh : nf;
                A[o++] = ox; A[o++] = oy; A[o++] = z;
                A[o++] = ex[j]; A[o++] = ey[j]; A[o++] = z;
                A[o++] = ex[i2]; A[o++] = ey[i2]; A[o++] = z;
                if (both) { nh = o; } else { nf = o; }
                if (both) {
                    E[ne++] = ex[j]; E[ne++] = ey[j]; E[ne++] = z;
                    E[ne++] = ex[i2]; E[ne++] = ey[i2]; E[ne++] = z;
                } else if (k1 === 2 && k2 === 2) {
                    P[np++] = ex[j]; P[np++] = ey[j]; P[np++] = z;
                    P[np++] = ex[i2]; P[np++] = ey[i2]; P[np++] = z;
                }
                if (!run) { run = [ex[j], ey[j]]; }
                run.push(ex[i2], ey[i2]);
            }
            if (run) { runs.push(run); }
            this._commit(this.lidarHit, nh / 3);
            this._commit(this.lidarFree, nf / 3);
            this._commit(this.lidarEdge, ne / 3);
            this._commit(this.lidarCap, np / 3);
            this._setLidarVisible(true);
            this._lidarOrigin = [ox, oy];
        } else {
            this._setLidarVisible(false);
        }

        // --- camera cone
        let cone = null;
        const useObs = st.use_cam_obstacle !== false, useFree = st.use_cam_free !== false;
        const rObs = useObs ? Math.min(C.camCloudMax, Number(st.obstacle_max_range_m) || 0) : 0;
        const rFree = useFree ? Math.min(C.camCloudMax, Number(st.free_max_range_m) || 0) : 0;
        const rc = Math.max(rObs, rFree);
        if (cp && rc > 0) {
            const yaw = Math.atan2(cp.R[2], cp.R[0]);
            const a0 = yaw - this.camHalfR, a1 = yaw + this.camHalfL, NA = 39;
            const Fv = this.camFill.geometry.attributes.position.array;
            const Ev = this.camEdge.geometry.attributes.position.array;
            let nf = 0, ne = 0;
            const arc = (rad) => {
                const pts = [];
                for (let i = 0; i <= NA; i++) {
                    const a = a0 + (a1 - a0) * i / NA;
                    pts.push(cp.x + rad * Math.cos(a), cp.y + rad * Math.sin(a));
                }
                return pts;
            };
            const outer = arc(rc);
            for (let i = 0; i < NA; i++) {
                Fv[nf++] = cp.x; Fv[nf++] = cp.y; Fv[nf++] = z;
                Fv[nf++] = outer[2 * i]; Fv[nf++] = outer[2 * i + 1]; Fv[nf++] = z;
                Fv[nf++] = outer[2 * i + 2]; Fv[nf++] = outer[2 * i + 3]; Fv[nf++] = z;
            }
            const seg = (x1, y1, x2, y2) => {
                Ev[ne++] = x1; Ev[ne++] = y1; Ev[ne++] = z;
                Ev[ne++] = x2; Ev[ne++] = y2; Ev[ne++] = z;
            };
            seg(cp.x, cp.y, outer[0], outer[1]);
            seg(cp.x, cp.y, outer[2 * NA], outer[2 * NA + 1]);
            for (let i = 0; i < NA; i++) { seg(outer[2 * i], outer[2 * i + 1], outer[2 * i + 2], outer[2 * i + 3]); }
            // obstacle and ground ranges differ -> the shorter one as an inner arc
            const rIn = Math.min(rObs || rc, rFree || rc);
            if (rIn > 0 && rIn < rc - 0.05) {
                const inner = arc(rIn);
                for (let i = 0; i < NA; i += 2) { seg(inner[2 * i], inner[2 * i + 1], inner[2 * i + 2], inner[2 * i + 3]); }
            }
            this._commit(this.camFill, nf / 3);
            this._commit(this.camEdge, ne / 3);
            this.camFill.visible = this.camEdge.visible = true;
            // during a session a camera branch that delivers nothing is dimmed
            const dim = (this.running && this.gatePass !== null && !this._camLive) ? 0.35 : 1;
            this.camFill.material.opacity = 0.2 * dim;
            this.camEdge.material.opacity = 0.8 * dim;
            cone = {x: cp.x, y: cp.y, pts: outer, live: dim === 1};
        } else if (this.camFill) {
            this.camFill.visible = this.camEdge.visible = false;
        }

        // --- coverage (recording + mapper gate open only)
        if (this.running && this.gatePass !== false && (runs.length || cone)) {
            if (now - this._coverDrawAt >= 400) {
                this._coverDrawAt = now;
                this._paintCover(lp, runs, cone);
            }
        }
        this._uploadCover(false);
    }

    _commit(obj, nVerts) {
        const g = obj.geometry;
        g.setDrawRange(0, nVerts);
        g.attributes.position.needsUpdate = true;
    }

    _paintCover(lp, runs, cone) {
        const C = this.cfg, px = C.coverPx, res = C.coverRes, ctx = this.coverCtx;
        if (!ctx) { return; }
        const rx = lp ? lp.x : (cone ? cone.x : 0), ry = lp ? lp.y : (cone ? cone.y : 0);
        const half = px * res / 2, margin = C.lidarMaxRange + 2;
        if (!this._coverCentre) {
            this._coverCentre = [Math.round(rx / res) * res, Math.round(ry / res) * res];
        } else if (Math.abs(rx - this._coverCentre[0]) > half - margin ||
                   Math.abs(ry - this._coverCentre[1]) > half - margin) {
            // re-centre on the robot, keeping what overlaps
            const nc = [Math.round(rx / res) * res, Math.round(ry / res) * res];
            const dx = Math.round((this._coverCentre[0] - nc[0]) / res);
            const dy = Math.round((nc[1] - this._coverCentre[1]) / res);
            const tmp = document.createElement('canvas');
            tmp.width = px; tmp.height = px;
            tmp.getContext('2d').drawImage(this.coverCanvas, 0, 0);
            ctx.clearRect(0, 0, px, px);
            ctx.drawImage(tmp, dx, dy);
            this._coverCentre = nc;
        }
        const c0 = this._coverCentre;
        const X = (x) => (x - c0[0]) / res + px / 2;
        const Y = (y) => px / 2 - (y - c0[1]) / res;
        if (lp) {
            ctx.fillStyle = C.cssLidar;
            runs.forEach((pts) => {
                ctx.beginPath();
                ctx.moveTo(X(lp.x), Y(lp.y));
                for (let i = 0; i < pts.length; i += 2) { ctx.lineTo(X(pts[i]), Y(pts[i + 1])); }
                ctx.closePath();
                ctx.fill();
            });
        }
        if (cone && cone.live) {
            ctx.fillStyle = C.cssCam;
            ctx.beginPath();
            ctx.moveTo(X(cone.x), Y(cone.y));
            for (let i = 0; i < cone.pts.length; i += 2) { ctx.lineTo(X(cone.pts[i]), Y(cone.pts[i + 1])); }
            ctx.closePath();
            ctx.fill();
        }
        this._coverDirty = true;
    }

    _uploadCover(force) {
        if (!this.coverMesh) { return; }
        const now = Date.now();
        if (this._coverCentre) {
            this.coverMesh.position.x = this._coverCentre[0];
            this.coverMesh.position.y = this._coverCentre[1];
            this.coverMesh.visible = true;
        } else {
            this.coverMesh.visible = false;
        }
        if (this._coverDirty && (force || now - this._coverUploadAt >= 1000)) {
            this._coverUploadAt = now;
            this._coverDirty = false;
            this.coverTex.needsUpdate = true;
        }
    }
}
