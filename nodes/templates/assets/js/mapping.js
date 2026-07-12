// MappingV3 — Map tab section: "mapping with known poses" pipeline control.
// Start/stop the per-garden mapping session (mapping_manager spawns the
// roslaunch), watch the insertion gate (RTK-gated), and pull terrain DEM /
// obstacle raster previews. All robot topics live under /mapping/*; the
// manager under /mapping_manager/*.
class MappingV3 {
    constructor(ros, tfClient, viewer3d) {
        this.ros = ros;

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
                position: new ROSLIB.Vector3({x: 0, y: 0, z: 0.015}),
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
                position: new ROSLIB.Vector3({x: 0, y: 0, z: 0.02}),
                orientation: new ROSLIB.Quaternion({x: 0, y: 0, z: 0, w: 1})
            })
        });

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
        this.viewer3d = viewer3d;
        this._r3dCache = null;    // lazily-harvested ROS3D THREE constructors
        this.terrain_group = null;   // ROS3D THREE.Object3D, created lazily
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
        if (this.chk_site) {
            this.site_group.visible = this.chk_site.checked;
            this.chk_site.addEventListener('change', () => {
                this.site_group.visible = this.chk_site.checked;
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
        this.pub_set_band = pub('/mapping/set_band');
        this.pub_set_ranges = pub('/mapping/set_ranges');

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
    _initAerial() {
        this.aerial_group = null;      // ROS3D THREE.Object3D, built lazily
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
                if (this.chk_aerial.checked) {
                    this.rebuildAerial();
                } else if (this.aerial_group) {
                    this.aerial_group.visible = false;
                }
            });
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
        // sit under everything (terrain at 0.005, site_map at 0.015)
        this.aerial_group.position.z = -0.01;
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

    // Build (or rebuild) the aerial tile planes. Async, cancellable, fully
    // guarded. Fetches the datum first, then covers a square area around the
    // map origin with tiles at the selected zoom.
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
            // MapProxy's gm_grid / webmercator grids only go up to z19; clamp so
            // an out-of-range request can't produce a wall of TileOutOfRange 400s.
            let z = this.sel_aerial_zoom ?
                    parseInt(this.sel_aerial_zoom.value, 10) : 19;
            if (!(z >= 0)) { z = 19; }
            z = Math.max(0, Math.min(19, z));

            // (2) coverage area — user-selectable square side (metres) around
            // the map origin. Falls back to the built-in default if the
            // control isn't present.
            let area = this.sel_aerial_area ?
                       parseInt(this.sel_aerial_area.value, 10) : this.aerial_area_m;
            if (!(area > 0)) { area = this.aerial_area_m; }
            this.aerial_area_m = area;

            // area corners in UTM-aligned metres (east=+x, north=+y) around
            // the datum origin -> lon/lat -> tile range covering the square.
            const { mLat, mLon } = this._metersPerDeg(d.origin_lat);
            const cornerLonLat = (e, n) => ({
                lon: d.origin_lon + e / mLon,
                lat: d.origin_lat + n / mLat,
            });
            // computes the tile range (and count) covering the square area at
            // a given zoom; used both for the real build and for probing zoom
            // levels down when guarding against a tile-count explosion.
            const tileRangeAt = (zoom) => {
                const half = area / 2.0;
                let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                [[-half, -half], [half, -half], [-half, half], [half, half]]
                    .forEach(([e, n]) => {
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

            // (3) tile-count guard: bigger area + high zoom can explode the
            // tile count. Auto-clamp zoom DOWN (coarser tiles) until the
            // rebuild fits under the cap, reflecting the clamp in the UI so
            // it's never silently a wall of requests.
            const CAP = this.AERIAL_TILE_CAP;
            let range = tileRangeAt(z);
            let clamped = false;
            while (range.count > CAP && z > 0) {
                z -= 1;
                clamped = true;
                range = tileRangeAt(z);
            }
            const { tx0, tx1, ty0, ty1 } = range;
            const nTiles = range.count;
            if (!(nTiles > 0) || nTiles > CAP) {
                status('tile range unreasonable (' + nTiles + ') even at z' + z +
                       ' — reduce area', true);
                return;
            }
            if (clamped && this.sel_aerial_zoom) {
                // reflect the auto-clamped zoom back into the dropdown so the
                // UI never silently disagrees with what was actually built.
                this.sel_aerial_zoom.value = String(z);
            }

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
            const clampNote = clamped ? ' (zoom auto-clamped, cap ' + CAP + ')' : '';
            status('tiles: ' + built + ' @ z' + z + ' — ' + src.label +
                   ', ' + this.aerial_area_m + ' m area' + clampNote, clamped);
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

        if (this.chk_rain) {
            this.chk_rain.addEventListener('change', () => {
                if (this.chk_rain.checked) {
                    this._ensureRainSub();
                    this.rebuildRain();
                } else if (this.rain_group) {
                    this.rain_group.visible = false;
                }
            });
        }
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
                try { this.rain_meta = JSON.parse(m.data); }
                catch (e) { return; }
                if (this.chk_rain && this.chk_rain.checked && this.rain_msg) {
                    this.rebuildRain();
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
            mesh.renderOrder = 999;   // topmost

            if (token !== this.rain_token) {
                try { geo.dispose(); tex.dispose(); mat.dispose(); } catch (e) {}
                return;
            }
            this._disposeRainMesh();
            this.rain_mesh = mesh;
            group.add(mesh);

            const rkm = this.sel_rain_area ?
                (parseInt(this.sel_rain_area.value, 10) / 1000) : (halfKm);
            status('radar: ' + (2 * halfKm).toFixed(0) + ' km frame, showing r≈' +
                   rkm + ' km, float ' + z + ' m — updates ~5 min');
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
            const kmPerPx = (2.0 * halfKm) / W;
            const areaM = this.sel_rain_area ?
                parseInt(this.sel_rain_area.value, 10) : 32000;
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
        this.terrain_group.position.z = 0.005;   // just below site_map (0.015)
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
            const mat = new T.Material({
                map: tex, transparent: true, opacity: 0.85, depthWrite: false
            });
            if (T.DoubleSide !== undefined) { mat.side = T.DoubleSide; }
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set((b.min_x + b.max_x) / 2,
                              (b.min_y + b.max_y) / 2, 0);

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
            // REPORT 2(c): the chip body previews (show_site) as before, and a
            // dedicated Serve button actually publishes serve_site for that site
            // (the previous handler only ever called show_site, so a chip could
            // never switch the served map). Serve is only offered when the site
            // has a raster; without one the manager would reject it (and now
            // reports why), so we grey it out and hint Snapshot/Stop instead.
            const servable = site.rasters > 0;
            const served = s.serving && s.serving.site === site.name;
            col.innerHTML =
                '<div class="input-group input-group-sm">' +
                '<button class="btn btn-primary mapv3-show" type="button" style="text-align:left;">' +
                '<span class="text-info"><i class="fa fa-tree text-info" style="margin-right:3px;"></i>' +
                site.name + (active ? ' ●' : '') + (served ? ' ✓' : '') + '</span>' +
                '<span style="font-size:11px;color:var(--bs-gray-500);margin-left:6px;">' +
                info + '</span></button>' +
                '<button class="btn ' + (servable ? 'btn-success' : 'btn-secondary') +
                ' mapv3-serve" type="button" title="' +
                (servable ? 'Serve this site\'s newest raster (localization + costmaps)' :
                 'No raster yet — press Snapshot while mapping, or it is saved on Stop') +
                '"' + (servable ? '' : ' disabled') + '>Serve</button>' +
                '<button class="btn btn-primary mapv3-del" type="button" style="width:40px;">' +
                '<i class="fa fa-remove text-danger"></i></button></div>';
            col.querySelector('.mapv3-show').addEventListener('click', () => {
                this.input_site.value = site.name;
                // show this site's saved map in the previews
                this.pub_show.publish(new ROSLIB.Message({data: site.name}));
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
            col.querySelector('.mapv3-del').addEventListener('click', () => {
                if (confirm('Remove mapping site "' + site.name +
                            '" (DEM, 3D archive, rasters)?')) {
                    this.pub_remove.publish(new ROSLIB.Message({data: site.name}));
                }
            });
            this.el_sites.appendChild(col);
        });
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
}
