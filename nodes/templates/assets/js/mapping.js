// MappingV3 — Map tab section: "mapping with known poses" pipeline control.
// Start/stop the per-garden mapping session (mapping_manager spawns the
// roslaunch), watch the insertion gate (RTK-gated), and pull terrain DEM /
// obstacle raster previews. All robot topics live under /mapping/*; the
// manager under /mapping_manager/*.
class MappingV3 {
    constructor(ros, tfClient, viewer3d) {
        this.ros = ros;

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
        this.btn_serve = document.getElementById("mapv3_btn_serve");
        this.el_serving = document.getElementById("mapv3_serving_status");
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
        this._applyBandTitle =
            'Apply the obstacle classification settings live and re-raster '
            + '(persisted per site).';
        this.el_band_status = document.getElementById("mapv3_band_status");
        this.band_edited = false;   // don't clobber user typing with live status
        // per-source range caps (item 3/4): lidar + depth max range, fed to
        // /mapping/set_ranges, prefilled from gate_status. Same session-gating
        // and edit-guard pattern as the band controls.
        this.in_lidar_max = document.getElementById("mapv3_lidar_max");
        this.in_depth_max = document.getElementById("mapv3_depth_max");
        this.btn_apply_ranges = document.getElementById("mapv3_btn_apply_ranges");
        this._applyRangesTitle =
            'Apply the per-source range caps live (dropped before insertion, '
            + 'persisted per site).';
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
        this._directSettingsSeen = false;   // guards the one-time prefill

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

        // (2) LIVE obstacle_map — the ground-relative band raster
        //     (auto-regenerated every ~10 s by band_projector while a session
        //     runs). Green identifier {0,255,0} => orange = obstacle ABOVE
        //     ground, green = mapped ground, unknown transparent.
        this.grid_group = new THREE.Object3D();
        viewer3d.scene.add(this.grid_group);
        this.grid_client = new ROS3D.OccupancyGridClient({
            ros: ros,
            tfClient: tfClient,
            rootObject: this.grid_group,
            continuous: true,
            compression: 'cbor',
            topic: '/mapping/obstacle_map',
            color: {r: 0, g: 255, b: 0},
            opacity: 0.85,
            offsetPose: new ROSLIB.Pose({
                position: new ROSLIB.Vector3({x: 0, y: 0, z: 0.02}),  // LIVE band
                orientation: new ROSLIB.Quaternion({x: 0, y: 0, z: 0, w: 1})
            })
        });

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
                MapLayerOpacity.registerClient(this.grid_client,
                    _ord ? _ord.LIVE : 20);
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
            this.site_group.visible = this.chk_site.checked;
            this.chk_site.addEventListener('change', () => {
                this.site_group.visible = this.chk_site.checked;
            });
        }
        if (this.chk_preview) {
            this.preview_group.visible = this.chk_preview.checked;
            this.chk_preview.addEventListener('change', () => {
                this.preview_group.visible = this.chk_preview.checked;
            });
        }
        if (this.chk_live) {
            this.grid_group.visible = this.chk_live.checked;
            this.chk_live.addEventListener('change', () => {
                this.grid_group.visible = this.chk_live.checked;
            });
        }
        if (this.chk_terrain) {
            // The group may not exist yet (built on first terrain data). Just
            // remember the desired visibility; applyTerrainVisible() syncs it
            // whenever the group appears. Toggling NEVER builds/blocks anything.
            this.terrain_visible = this.chk_terrain.checked;
            this.applyTerrainVisible();
            this.chk_terrain.addEventListener('change', () => {
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
        this.pub_set_band = pub('/mapping/set_band');
        this.pub_set_ranges = pub('/mapping/set_ranges');
        this.pub_set_direct = pub('/mapping/set_direct');

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
        sub('/mapping/projector_status', 'std_msgs/String',
            (m) => this.handleProjector(m));
        sub('/mapping/direct_status', 'std_msgs/String',
            (m) => this.handleDirectStatus(m));

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
            this.el_run.textContent = 'starting ' + site + '…';
        });
        this.btn_stop.addEventListener('click', () => {
            this.pub_stop.publish(new ROSLIB.Message({data: ''}));
            this.el_run.textContent = 'stopping…';
        });
        if (this.btn_serve) {
            this.btn_serve.addEventListener('click', () => {
                const site = this.input_site.value.trim();
                this.pub_serve.publish(new ROSLIB.Message({data: site}));
                if (this.el_serving) this.el_serving.textContent = 'serving: requesting…';
            });
        }

        // WP-D2: "Edit map" entry — opens the in-view map editor (mapeditor.js
        // detail panel) keeping the SERVED site_map as the base. Created
        // dynamically (like Clear 3D) to avoid an index.html rebuild, and
        // appended next to Serve. Disabled until a site is being served (the
        // editor needs a served map to draw edits/waypoints against); enabled in
        // handleManager() when s.serving is set.
        if (this.btn_serve) {
            this.btn_edit_map = document.createElement('button');
            this.btn_edit_map.className = 'btn btn-info';
            this.btn_edit_map.type = 'button';
            this.btn_edit_map.textContent = 'Edit map';
            this.btn_edit_map.disabled = true;
            this.btn_edit_map.title = 'Serve a site first — the editor draws edits/waypoints on the served map';
            this.btn_serve.parentNode.appendChild(this.btn_edit_map);
            this.btn_edit_map.addEventListener('click', () => {
                try {
                    if (window.MapEditor && window.MapEditor.showDetail) {
                        window.MapEditor.showDetail({keepBase: true});
                    }
                } catch (e) { console.error('[mappingv3] open editor failed', e); }
            });
        }
        // the middle mode button is 'Fused' now (relabel here to avoid an
        // index.html rebuild; fused = map from the fused pose, the default)
        this.btn_mode_force.textContent = 'Fused';
        this.btn_mode_force.title = 'Map from the fused odometry pose (default)';
        this.btn_mode_rtk.title = 'Strict: insert only at RTK FIXED';
        this.btn_mode_rtk.addEventListener('click', () => this.setMode('rtk'));
        this.btn_mode_force.addEventListener('click', () => this.setMode('fused'));
        this.btn_mode_off.addEventListener('click', () => this.setMode('off'));
        this.btn_raster.addEventListener('click', () => {
            this.el_proj.textContent = 'regenerating…';
            this.pub_regen.publish(new ROSLIB.Message({data: ''}));
        });
        this.btn_save.addEventListener('click', () => {
            this.el_proj.textContent = 'saving snapshot…';
            this.pub_save.publish(new ROSLIB.Message({data: ''}));
        });
        this.btn_compare.addEventListener('click', () => {
            this.el_proj.textContent = 'comparing vs rtabmap…';
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

        // Direct mapper — no edit-guard flag needed (settings are only ever
        // prefilled once, on the first direct_status arrival), but the
        // control set is independent of session Start/Stop so it stays
        // enabled regardless of setActionsEnabled().
        if (this.btn_apply_direct) {
            this.btn_apply_direct.addEventListener('click', () => this.applyDirect());
        }

        // Clear 3D — reset the octomap archive after a localization
        // correction shifted older data (created dynamically, like the
        // caption, to avoid an index.html rebuild)
        this.btn_clear = document.createElement('button');
        this.btn_clear.className = 'btn btn-outline-danger';
        this.btn_clear.type = 'button';
        this.btn_clear.textContent = 'Clear 3D';
        this.btn_clear.title = 'Reset the 3D archive (keeps terrain DEM); ' +
            'use after the map shifted due to a localization correction';
        this.btn_clear.disabled = true;
        this.btn_raster.parentNode.appendChild(this.btn_clear);
        this.btn_clear.addEventListener('click', () => {
            if (confirm('Clear the 3D obstacle archive? Terrain DEM is kept; ' +
                        'obstacles rebuild as you drive.')) {
                this.pub_clear.publish(new ROSLIB.Message({data: ''}));
            }
        });
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
    // by yaw_rad vs UTM grid north. We place the whole tile set in a group that
    // carries the -yaw rotation, and inside it position each tile plane by a
    // LOCAL flat-earth conversion around the datum's origin_lat/origin_lon
    // (sub-cm over ~100 m). For a map point the UTM offset from datum is
    // R(+yaw)*(x,y); we express that offset as metres east/north, convert to
    // lat/lon via metres-per-degree at the origin, then to XYZ tiles. Each
    // tile's geographic bounds convert back to map metres the same way (inverse),
    // giving an axis-aligned plane in the group's (pre-yaw) frame.
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

        if (this.chk_aerial) {
            this.chk_aerial.addEventListener('change', () => {
                this._saveLayerPref('vitulus_layer_aerial', this.chk_aerial.checked);
                if (this.chk_aerial.checked) {
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
    }

    _aerialSources() {
        // discovered from MapProxy demo/WMTS: gm_layer = Google satellite,
        // osm_demo = OSM streets. Both EPSG:3857 XYZ (origin ul, y not flipped).
        return {
            sat: { layer: 'gm_layer', grid: 'gm_grid', label: 'satellite' },
            osm: { layer: 'osm_demo', grid: 'webmercator', label: 'OSM' },
        };
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
        const status = (t, warn) => {
            if (this.el_aerial_status) {
                this.el_aerial_status.textContent = t;
                this.el_aerial_status.style.color = warn ? '#ffd43b' : '';
            }
        };
        const token = ++this.aerial_token;
        try {
            // (1) datum — cache once; refetch only if we don't have it.
            if (!this.aerial_datum) {
                status('loading datum…');
                const resp = await fetch('/api/datum', { cache: 'no-store' });
                if (!resp.ok) {
                    status('no site datum served — cannot place tiles', true);
                    return;
                }
                this.aerial_datum = await resp.json();
            }
            if (token !== this.aerial_token) { return; }
            const d = this.aerial_datum;
            if (d.origin_lat == null || d.origin_lon == null) {
                status('datum missing origin_lat/lon', true);
                return;
            }

            const T = this._r3d();
            const group = this._ensureAerialGroup();
            if (!T || !group) { status('3D not ready', true); return; }

            // group carries the -yaw rotation: map = R(-yaw)*(UTM offset), so a
            // plane laid out in UTM-aligned metres inside the group ends up in
            // the map frame. Rotation about +z.
            const yaw = d.yaw_rad || 0.0;
            group.rotation.z = -yaw;
            group.visible = true;

            const srcKey = this.sel_aerial_src ? this.sel_aerial_src.value : 'sat';
            const src = this._aerialSources()[srcKey] || this._aerialSources().sat;
            // The configured zoom is the DETAIL CAP: the most detailed level we
            // ever use. MapProxy's gm_grid / webmercator grids only go up to z19.
            let zCap = this.sel_aerial_zoom ?
                    parseInt(this.sel_aerial_zoom.value, 10) : 19;
            if (!(zCap >= 0)) { zCap = 19; }
            zCap = Math.max(0, Math.min(19, zCap));

            const { mLat, mLon } = this._metersPerDeg(d.origin_lat);
            const cornerLonLat = (e, n) => ({
                lon: d.origin_lon + e / mLon,
                lat: d.origin_lat + n / mLat,
            });

            // (2) COVERAGE — follow the current viewport. Take the 4 view corners
            // (map metres, +margin), rotate map->UTM-aligned east/north (R(+yaw)),
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
                status('tile range unreasonable (' + nTiles + ') even at z' + z +
                       ' — zoom in', true);
                return;
            }

            // (4b) skip the (re)build entirely if the covering tile set is
            // unchanged — makes panning within the same tiles and re-enabling
            // the layer free. Source or zoom change invalidates the signature.
            const sig = srcKey + '@' + z + ':' + tx0 + ',' + tx1 + ',' +
                        ty0 + ',' + ty1;
            if (sig === this._aerialSig && this.aerial_meshes.length > 0) {
                status('tiles: ' + this.aerial_meshes.length + ' @ z' + z +
                       ' — ' + src.label + ' (view unchanged)');
                return;
            }
            this._aerialSig = sig;

            // (4) build fresh meshes off-screen, swap in after ready.
            const newMeshes = [];
            const opacity = this.in_aerial_opacity ?
                            parseFloat(this.in_aerial_opacity.value) : 1.0;
            // convert a lon/lat back to UTM-aligned metres (inverse of above).
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
            const detailNote = (z < zCap) ? ' (zoomed out — z' + z + ' < cap z' +
                               zCap + ')' : '';
            status('tiles: ' + built + ' @ z' + z + ' — ' + src.label +
                   detailNote);
        } catch (e) {
            console.error('[mappingv3] rebuildAerial failed:', e);
            status('aerial build failed (see console)', true);
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
        const status = (t, warn) => {
            if (this.el_rain_status) {
                this.el_rain_status.textContent = t;
                this.el_rain_status.style.color = warn ? '#ffd43b' : '';
            }
        };
        const token = ++this.rain_token;
        try {
            if (!this.rain_msg) { status('waiting for radar frame…'); return; }
            // datum — cache once.
            if (!this.rain_datum) {
                status('loading datum…');
                const resp = await fetch('/api/datum', { cache: 'no-store' });
                if (!resp.ok) { status('no site datum — cannot place radar', true); return; }
                this.rain_datum = await resp.json();
            }
            if (token !== this.rain_token) { return; }
            const d = this.rain_datum;
            if (d.origin_lat == null || d.origin_lon == null) {
                status('datum missing origin_lat/lon', true); return;
            }

            const T = this._r3d();
            const group = this._ensureRainGroup();
            if (!T || !group) { status('3D not ready', true); return; }

            const m = this.rain_msg;
            const W = m.width | 0, H = m.height | 0;
            if (!(W > 0) || !(H > 0)) { status('bad radar frame', true); return; }

            // Decode base64 rgba8 -> RGBA passthrough + radius clip. No palette
            // keying: the node already delivers a clean rain-only image with
            // alpha=0 off the echo. Runs off the render path.
            const rgba = this._rainDecode(m, W, H);
            if (!rgba) { status('radar decode failed', true); return; }

            // Geometry: the full frame spans 2*halfKm km. Centre it on the
            // radar centre expressed in map metres. The radar centre is the
            // config lat/lon; we approximate it by the datum origin (garden)
            // — see the header note. side in metres:
            const halfKm = this._rainHalfKm();
            const sideM = 2.0 * halfKm * 1000.0;

            // group carries -yaw so a UTM-aligned plane lands in the map frame.
            group.rotation.z = -(d.yaw_rad || 0.0);
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
            const shown = (areaM >= halfKm * 1000.0 * 0.9) ?
                'full frame' : ('r≈' + (areaM / 1000) + ' km');
            status('radar: ' + (2 * halfKm).toFixed(0) + ' km frame, showing ' +
                   shown + ', float ' + z + ' m — updates ~5 min');
        } catch (e) {
            console.error('[mappingv3] rebuildRain failed:', e);
            status('rain build failed (see console)', true);
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
            this.el_band_status.textContent =
                'invalid band: need 0 ≤ min < max ≤ 2.0 m';
            this.el_band_status.style.color = '#ff6b6b';
            return;
        }
        if (!(ev >= 1 && ev <= 20 && cl >= 1 && cl <= 20)) {
            this.el_band_status.textContent =
                'invalid: evidence/cluster must be 1..20';
            this.el_band_status.style.color = '#ff6b6b';
            return;
        }
        const payload = {band_min: bmin, band_max: bmax,
                         min_evidence: ev, min_cluster_cells: cl};
        this.pub_set_band.publish(new ROSLIB.Message({data: JSON.stringify(payload)}));
        this.band_edited = false;   // let projector_status re-sync the applied values
        this.el_band_status.textContent = 'applying…';
        this.el_band_status.style.color = '';
    }

    applyRanges() {
        const lidar = parseFloat(this.in_lidar_max.value);
        const depth = parseFloat(this.in_depth_max.value);
        const ok = (v) => (v >= 0.5 && v <= 20.0);
        if (!ok(lidar) || !ok(depth)) {
            this.el_ranges_status.textContent =
                'invalid: each range must be 0.5..20 m';
            this.el_ranges_status.style.color = '#ff6b6b';
            return;
        }
        const payload = {lidar_max_m: lidar, depth_max_m: depth};
        this.pub_set_ranges.publish(
            new ROSLIB.Message({data: JSON.stringify(payload)}));
        this.ranges_edited = false;   // let gate_status re-sync applied values
        this.el_ranges_status.textContent = 'applying…';
        this.el_ranges_status.style.color = '';
    }

    // Direct 2D raster mapper — publish ONE /mapping/set_direct JSON with all
    // current control values (the backend accepts partial dicts too, but we
    // always send the full set here since the form always has a full set of
    // values once direct_status has arrived at least once).
    applyDirect() {
        const lidarR = parseFloat(this.in_direct_lidar_range.value);
        const obsR = parseFloat(this.in_direct_obstacle_range.value);
        const freeR = parseFloat(this.in_direct_free_range.value);
        const minHits = parseInt(this.in_direct_min_hits.value, 10);
        const ok = (v) => (v >= 0.5 && v <= 20.0);
        if (!ok(lidarR) || !ok(obsR) || !ok(freeR)) {
            this.el_direct_status.textContent =
                'invalid: each range must be 0.5..20 m';
            this.el_direct_status.style.color = '#ff6b6b';
            return;
        }
        if (!(minHits >= 1 && minHits <= 50)) {
            this.el_direct_status.textContent =
                'invalid: min hits must be 1..50';
            this.el_direct_status.style.color = '#ff6b6b';
            return;
        }
        const payload = {
            use_lidar: !!(this.chk_direct_use_lidar && this.chk_direct_use_lidar.checked),
            lidar_max_range_m: lidarR,
            lidar_free_no_hit: !!(this.chk_direct_free_no_hit && this.chk_direct_free_no_hit.checked),
            use_cam_obstacle: !!(this.chk_direct_use_cam_obstacle && this.chk_direct_use_cam_obstacle.checked),
            obstacle_max_range_m: obsR,
            use_cam_free: !!(this.chk_direct_use_cam_free && this.chk_direct_use_cam_free.checked),
            free_max_range_m: freeR,
            min_hits: minHits
        };
        this.pub_set_direct.publish(
            new ROSLIB.Message({data: JSON.stringify(payload)}));
        this.el_direct_status.textContent = 'applying…';
        this.el_direct_status.style.color = '';
    }

    setActionsEnabled(on) {
        [this.btn_mode_rtk, this.btn_mode_force, this.btn_mode_off,
         this.btn_raster, this.btn_save, this.btn_compare, this.btn_clear,
         this.btn_apply_band, this.btn_apply_ranges]
            .forEach((b) => { if (b) b.disabled = !on; });
        this.btn_stop.disabled = !on;
        // Obstacle-classification Apply requires the mapping pipeline running:
        // /mapping/set_band is subscribed by band_projector, which only exists
        // during a session. Say so instead of leaving a dead greyed button —
        // swap the tooltip and add a hint to the band status line when idle.
        if (this.btn_apply_band) {
            this.btn_apply_band.title = on
                ? this._applyBandTitle
                : 'Requires a running mapping session — press Start first '
                  + '(the obstacle classifier only exists while mapping runs).';
        }
        if (this.el_band_status && !on && !this.band_edited) {
            this.el_band_status.textContent =
                'Start a mapping session to tune the obstacle band.';
            this.el_band_status.style.color = '';
        }
        // Range caps require the insertion_gate running (subscribes to
        // /mapping/set_ranges), same as the band Apply.
        if (this.btn_apply_ranges) {
            this.btn_apply_ranges.title = on
                ? this._applyRangesTitle
                : 'Requires a running mapping session — press Start first '
                  + '(the insertion gate only exists while mapping runs).';
        }
        if (this.el_ranges_status && !on && !this.ranges_edited) {
            this.el_ranges_status.textContent =
                'Start a mapping session to set sensor range caps.';
            this.el_ranges_status.style.color = '';
        }
    }

    handleManager(msg) {
        let s;
        try { s = JSON.parse(msg.data); } catch (e) { return; }
        this.running = s.running;
        this.setActionsEnabled(s.running);
        if (this.el_serving) {
            if (s.serve_error) {
                // REPORT 2(b): show WHY a serve was rejected instead of the UI
                // silently staying on the old map. Cleared on the next success.
                this.el_serving.textContent = 'serve failed: ' + s.serve_error;
                this.el_serving.style.color = '#ff6b6b';
            } else if (s.serving) {
                this.el_serving.textContent = 'serving: ' + s.serving.site +
                    '/' + s.serving.raster;
                this.el_serving.style.color = '';
            } else {
                this.el_serving.textContent = 'serving: —';
                this.el_serving.style.color = '';
            }
        }
        // vitulus_ui: mirror the served site/raster into the map-edit panel header
        // (small hook — piggybacks this existing status handler, no new sub).
        var _mds = document.getElementById('map_detail_site');
        if (_mds) _mds.textContent = s.serving ? (s.serving.site + ' / ' + s.serving.raster) : '—';
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
            if (_el) _el.setAttribute('data-site', _siteVal);
        });
        if (window.renderActiveMapName) window.renderActiveMapName();
        // WP-D2: enable "Edit map" only while a site is served (editor draws
        // against the served map). Tooltip reflects the current state.
        if (this.btn_edit_map) {
            const serving = !!s.serving;
            this.btn_edit_map.disabled = !serving;
            this.btn_edit_map.title = serving
                ? ('Edit the served map: ' + s.serving.site + '/' + s.serving.raster)
                : 'Serve a site first — the editor draws edits/waypoints on the served map';
        }
        // saved-map layer status (the latched site_map rendered in the 3D view)
        if (this.el_site_status) {
            if (s.serving) {
                this.el_site_status.textContent = 'saved map: ' +
                    s.serving.site + '/' + s.serving.raster + ' (in 3D view)';
            } else {
                this.el_site_status.textContent =
                    'saved map: — (press Serve to load a site into the 3D view)';
            }
        }
        if (s.running) {
            const up = Math.floor(s.uptime_s / 60);
            this.el_run.textContent = '● mapping "' + s.site + '" (' + up + ' min)';
            this.el_run.style.color = '#51cf66';
        } else {
            this.el_run.textContent = 'stopped';
            this.el_run.style.color = '';
            this.el_gate.textContent = '—';
            this.el_gate.style.color = '';
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

            const col = document.createElement('div');
            col.className = 'col-auto';
            col.style.cssText = 'margin-right:6px;margin-bottom:4px;';
            const active = s.running && s.site === site.name;
            const info = (site.dem_m2 !== undefined ? site.dem_m2 + ' m²' :
                          site.dem_kb + ' kB') +
                         ', ' + site.rasters + ' rasters' +
                         (site.has_ot ? ', 3D' : '');
            const servable = site.rasters > 0;
            const served = s.serving && s.serving.site === site.name;
            const expanded = this._expandedSites.has(site.name);
            const caret = expanded ? '▾' : '▸';
            // REPORT 2(c): the chip body previews (show_site) as before, and a
            // dedicated Serve button publishes serve_site for that site. Per-raster
            // mgmt: the chip ALSO toggles the expandable raster panel below.
            col.innerHTML =
                '<div class="input-group input-group-sm">' +
                '<button class="btn btn-primary mapv3-show" type="button" style="text-align:left;" title="Show this site\'s saved map + expand its rasters">' +
                '<span style="color:var(--bs-gray-500);margin-right:3px;">' + caret + '</span>' +
                '<span class="text-info"><i class="fa fa-tree text-info" style="margin-right:3px;"></i>' +
                site.name + (active ? ' ●' : '') + (served ? ' ✓' : '') + '</span>' +
                '<span style="font-size:11px;color:var(--bs-gray-500);margin-left:6px;">' +
                info + '</span></button>' +
                '<button class="btn ' + (servable ? 'btn-success' : 'btn-secondary') +
                ' mapv3-serve" type="button" title="' +
                (servable ? 'Serve this site\'s newest raster (localization + costmaps)' :
                 'No raster yet — press Snapshot while mapping, or it is saved on Stop') +
                '"' + (servable ? '' : ' disabled') + '>Serve</button>' +
                '<button class="btn btn-primary mapv3-del" type="button" style="width:40px;" title="Remove the whole site (DEM, 3D archive, all rasters)">' +
                '<i class="fa fa-remove text-danger"></i></button></div>';
            col.querySelector('.mapv3-show').addEventListener('click', () => {
                this.input_site.value = site.name;
                // preview this site's saved map AND toggle the raster panel
                this.pub_show.publish(new ROSLIB.Message({data: site.name}));
                if (this._expandedSites.has(site.name)) {
                    this._expandedSites.delete(site.name);
                } else {
                    this._expandedSites.add(site.name);
                }
                if (this._lastStatus) { this.renderSitesRow(this._lastStatus); }
            });
            const serveBtn = col.querySelector('.mapv3-serve');
            if (serveBtn && servable) {
                serveBtn.addEventListener('click', () => {
                    this.input_site.value = site.name;
                    this.pub_serve.publish(new ROSLIB.Message({data: site.name}));
                    if (this.el_serving) {
                        this.el_serving.textContent =
                            'serving: requesting ' + site.name + '…';
                        this.el_serving.style.color = '';
                    }
                });
            }
            // whole-site delete keeps the double-click-confirm pattern used for
            // rasters below (no window.confirm — that pattern is being retired).
            this._wireDoubleClickDelete(col.querySelector('.mapv3-del'),
                () => this.pub_remove.publish(new ROSLIB.Message({data: site.name})),
                '<i class="fa fa-remove text-danger"></i>');
            this.el_sites.appendChild(col);

            // per-raster mgmt: expandable raster panel (full-width, wraps below
            // the chip). Rendered only when expanded and the site has rasters.
            if (expanded) {
                this.el_sites.appendChild(
                    this._buildRasterPanel(s, site));
            }
        });
    }

    // Double-click-confirm on a delete button (never window.confirm): first
    // click arms + relabels "Confirm?" for 3 s; a second click within the window
    // fires onConfirm. `restoreHtml` is the button's normal inner HTML.
    _wireDoubleClickDelete(btn, onConfirm, restoreHtml) {
        if (!btn) { return; }
        let armed = false, timer = null;
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!armed) {
                armed = true;
                btn.classList.add('btn-danger');
                btn.innerHTML = '<span style="font-size:11px;">Confirm?</span>';
                timer = setTimeout(() => {
                    armed = false;
                    btn.classList.remove('btn-danger');
                    btn.innerHTML = restoreHtml;
                }, 3000);
                return;
            }
            if (timer) { clearTimeout(timer); }
            armed = false;
            onConfirm();
        });
    }

    // Build the per-site raster panel DOM (per-raster mgmt): one row per raster
    // in site.raster_list — [name | date | free/obst cells | Preview | Serve |
    // Delete], the served raster flagged ✓, the active-preview row highlighted.
    _buildRasterPanel(s, site) {
        const panel = document.createElement('div');
        panel.className = 'col-12';
        panel.style.cssText = 'margin:0 0 6px 14px;padding:4px 6px;border-left:2px solid var(--bs-gray-700);';
        const list = site.raster_list || [];
        if (!list.length) {
            panel.innerHTML =
                '<span style="font-size:11px;color:var(--bs-gray-500);">' +
                'no rasters yet — Snapshot while mapping, or one is saved on Stop</span>';
            return panel;
        }
        const servingR = (s.serving && s.serving.site === site.name)
            ? s.serving.raster : null;
        const previewR = (s.previewing && s.previewing.site === site.name)
            ? s.previewing.raster : null;
        list.forEach((r) => {
            const isServed = (r.name === servingR);
            const isPreview = (r.name === previewR);
            const row = document.createElement('div');
            row.className = 'input-group input-group-sm';
            row.style.cssText = 'margin-bottom:3px;' +
                (isPreview ? 'outline:1px solid #2a8cff;border-radius:3px;' : '');
            const cells = (r.cells_free != null && r.cells_obstacle != null)
                ? (r.cells_free + '/' + r.cells_obstacle + ' cells')
                : '—';
            const label = document.createElement('span');
            label.className = 'input-group-text';
            label.style.cssText = 'flex:1;justify-content:flex-start;font-size:11px;' +
                'padding:2px 6px;text-align:left;overflow:hidden;';
            label.innerHTML =
                '<span class="text-info">' + r.name + (isServed ? ' ✓' : '') + '</span>' +
                '<span style="color:var(--bs-gray-500);margin-left:6px;">' +
                this._fmtRasterDate(r.mtime) + '</span>' +
                '<span style="color:var(--bs-gray-500);margin-left:6px;">' +
                cells + '</span>';
            row.appendChild(label);

            // Preview (toggle) — publishes preview_raster "site/raster" to show,
            // or "" to clear when this row is already the active preview.
            const prevBtn = document.createElement('button');
            prevBtn.type = 'button';
            prevBtn.className = 'btn ' + (isPreview ? 'btn-info' : 'btn-outline-info');
            prevBtn.textContent = isPreview ? 'Previewing' : 'Preview';
            prevBtn.title = 'Show this RAW raster (blue) in the 3D view for A/B ' +
                'comparison vs the served map (no human edits). Click again to clear.';
            prevBtn.addEventListener('click', () => {
                const data = isPreview ? '' : (site.name + '/' + r.name);
                this.pub_preview_raster.publish(new ROSLIB.Message({data: data}));
            });
            row.appendChild(prevBtn);

            // Serve — serve_site "site/raster": THIS sets the default.
            const serveBtn = document.createElement('button');
            serveBtn.type = 'button';
            serveBtn.className = 'btn ' + (isServed ? 'btn-secondary' : 'btn-success');
            serveBtn.textContent = isServed ? 'Served' : 'Serve';
            serveBtn.disabled = isServed;
            serveBtn.title = 'Serve = use for navigation + persists as default';
            if (!isServed) {
                serveBtn.addEventListener('click', () => {
                    this.input_site.value = site.name;
                    this.pub_serve.publish(new ROSLIB.Message(
                        {data: site.name + '/' + r.name}));
                    if (this.el_serving) {
                        this.el_serving.textContent =
                            'serving: requesting ' + site.name + '/' + r.name + '…';
                        this.el_serving.style.color = '';
                    }
                });
            }
            row.appendChild(serveBtn);

            // Delete — double-click-confirm -> remove_raster "site/raster".
            // The served raster cannot be deleted (manager refuses); disable it.
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn btn-outline-danger';
            delBtn.innerHTML = '<i class="fa fa-remove"></i>';
            if (isServed) {
                delBtn.disabled = true;
                delBtn.title = 'Cannot delete the served raster — serve another first';
            } else {
                delBtn.title = 'Delete this raster (double-click to confirm)';
                this._wireDoubleClickDelete(delBtn,
                    () => this.pub_remove_raster.publish(new ROSLIB.Message(
                        {data: site.name + '/' + r.name})),
                    '<i class="fa fa-remove"></i>');
            }
            row.appendChild(delBtn);

            panel.appendChild(row);
        });
        return panel;
    }

    handleGate(msg) {
        if (!this.running) return;
        let g;
        try { g = JSON.parse(msg.data); } catch (e) { return; }

        // range caps: prefill inputs (unless user is mid-edit) and show applied
        if (g.lidar_max_m !== undefined && g.depth_max_m !== undefined) {
            if (!this.ranges_edited && this.in_lidar_max) {
                this.in_lidar_max.value = g.lidar_max_m;
                this.in_depth_max.value = g.depth_max_m;
            }
            if (this.el_ranges_status) {
                const lid = (g.lidar_enabled === false) ? 'lidar OFF' :
                    ('lidar ≤ ' + g.lidar_max_m + ' m');
                this.el_ranges_status.textContent =
                    lid + ', depth ≤ ' + g.depth_max_m + ' m' +
                    (g.z_corr_mode ? ' | z-corr: ' + g.z_corr_mode : '');
                this.el_ranges_status.style.color = '';
            }
        }

        const c = g.counters || {};
        let io_in = 0, io_out = 0;
        Object.keys(c).forEach((k) => { io_in += c[k].in; io_out += c[k].out; });
        const detail = [];
        if (g.pose_src) detail.push('pose:' + g.pose_src);
        if (g.rtk_fixed !== undefined) detail.push(g.rtk_fixed ? 'RTK✓' : 'noRTK');
        if (g.heading_rtk === false) detail.push('⚠ HDG-RX no fix');
        if (g.hacc_mm !== undefined) detail.push('hAcc ' + Math.round(g.hacc_mm) + 'mm');
        if (g.heading_diff_deg !== undefined) detail.push('Δhdg ' + g.heading_diff_deg + '°');
        if (g.z_source) detail.push('z:' + g.z_source);
        if (g.map_corrections) detail.push('⚠ corrections ' + g.map_corrections);
        detail.push('clouds ' + io_out + '/' + io_in);
        if (g.pass) {
            this.el_gate.textContent = 'OPEN ✓ [' + g.mode + '] ' + detail.join(', ');
            this.el_gate.style.color = '#51cf66';
        } else {
            this.el_gate.textContent = 'CLOSED [' + g.mode + '] ' +
                (g.reasons || []).join(', ') + ' — ' + detail.join(', ');
            this.el_gate.style.color = g.mode === 'off' ? '' : '#ffd43b';
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
        const zr = d.z_range ? (', z ' + d.z_range[0] + '…' + d.z_range[1] + ' m') : '';
        this.el_dem.textContent = d.area_traj_m2 + ' m² driven, ' +
            d.samples + ' samples' + zr +
            (d.gps_alt_ok ? '' : ', ⚠ no RTK altitude') +
            (d.dz_skips ? ', ' + d.dz_skips + ' dz-skips' : '');
        this.el_dem.style.color = d.gps_alt_ok ? '' : '#ffd43b';
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
                this.el_band_status.textContent =
                    'obstacle band ' + p.band_min + '–' + p.band_max +
                    ' m above ground, evid ≥ ' + p.min_evidence +
                    ', clust ≥ ' + p.min_cluster_cells;
                this.el_band_status.style.color = '';
            }
        }

        let txt = p.state + ', ' + (p.octomap_points || 0).toLocaleString() + ' voxels';
        if (p.cells_obstacle !== undefined) {
            txt += ' | raster: ' + p.cells_obstacle + ' obstacle, ' +
                   p.cells_free + ' free cells (' + p.took_s + ' s)';
        }
        if (p.iou_obstacles !== undefined && p.iou_obstacles !== null) {
            txt += ' | IoU vs rtabmap ' + Math.round(p.iou_obstacles * 100) + '%';
        }
        if (p.error) txt += ' | ' + p.error;
        this.el_proj.textContent = txt;
        this.el_proj.style.color = p.state === 'error' ? '#ff6b6b' : '';
    }

    // Direct 2D raster mapper status — /mapping/direct_status, latched,
    // ~1.5 Hz: {enabled, pass, reasons[], counters{lidar,cam_obstacle,
    // cam_free:{in,throttled,gate_closed,passed}}, settings{...},
    // grid{occ_cells,free_cells,observed_cells,shape,res,obstacle_frames,
    // free_frames}}.
    handleDirectStatus(msg) {
        let s;
        try { s = JSON.parse(msg.data); } catch (e) { return; }

        // Prefill the Apply controls exactly ONCE, from the first status that
        // carries settings — deliberately NOT the band/ranges edit-guard
        // (re-sync-unless-mid-edit): this stream arrives continuously at
        // ~1.5 Hz, so re-applying it every message would fight with the user
        // mid-edit far more aggressively than the slower gate/projector
        // status streams. After the one-time prefill, only Apply changes
        // what the backend sees; incoming settings are ignored.
        if (s.settings && !this._directSettingsSeen) {
            this._directSettingsSeen = true;
            const st = s.settings;
            if (this.chk_direct_use_lidar && st.use_lidar !== undefined)
                this.chk_direct_use_lidar.checked = !!st.use_lidar;
            if (this.in_direct_lidar_range && st.lidar_max_range_m !== undefined)
                this.in_direct_lidar_range.value = st.lidar_max_range_m;
            if (this.chk_direct_free_no_hit && st.lidar_free_no_hit !== undefined)
                this.chk_direct_free_no_hit.checked = !!st.lidar_free_no_hit;
            if (this.chk_direct_use_cam_obstacle && st.use_cam_obstacle !== undefined)
                this.chk_direct_use_cam_obstacle.checked = !!st.use_cam_obstacle;
            if (this.in_direct_obstacle_range && st.obstacle_max_range_m !== undefined)
                this.in_direct_obstacle_range.value = st.obstacle_max_range_m;
            if (this.chk_direct_use_cam_free && st.use_cam_free !== undefined)
                this.chk_direct_use_cam_free.checked = !!st.use_cam_free;
            if (this.in_direct_free_range && st.free_max_range_m !== undefined)
                this.in_direct_free_range.value = st.free_max_range_m;
            if (this.in_direct_min_hits && st.min_hits !== undefined)
                this.in_direct_min_hits.value = st.min_hits;
        }

        if (!this.el_direct_status) return;
        const g = s.grid || {};
        const c = s.counters || {};
        const passed = (k) => (c[k] && c[k].passed !== undefined) ? c[k].passed : '—';
        let txt = (s.enabled ? 'enabled' : 'disabled') +
            (s.pass === false ? ' | gate CLOSED' : '') +
            ' | occ ' + (g.occ_cells !== undefined ? g.occ_cells : '—') +
            ', free ' + (g.free_cells !== undefined ? g.free_cells : '—') +
            ' cells | lidar ' + passed('lidar') +
            ', cam obst ' + passed('cam_obstacle') +
            ', cam free ' + passed('cam_free') + ' passed';
        if (s.reasons && s.reasons.length) {
            txt += ' — ' + s.reasons.join(', ');
        }
        this.el_direct_status.textContent = txt;
        this.el_direct_status.style.color =
            (s.reasons && s.reasons.length) ? '#ffd43b' : '';
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
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();
