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
        this.el_band_status = document.getElementById("mapv3_band_status");
        this.band_edited = false;   // don't clobber user typing with live status
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

    setActionsEnabled(on) {
        [this.btn_mode_rtk, this.btn_mode_force, this.btn_mode_off,
         this.btn_raster, this.btn_save, this.btn_compare, this.btn_clear,
         this.btn_apply_band]
            .forEach((b) => { if (b) b.disabled = !on; });
        this.btn_stop.disabled = !on;
    }

    handleManager(msg) {
        let s;
        try { s = JSON.parse(msg.data); } catch (e) { return; }
        this.running = s.running;
        this.setActionsEnabled(s.running);
        if (this.el_serving) {
            if (s.serving) {
                this.el_serving.textContent = 'serving: ' + s.serving.site +
                    '/' + s.serving.raster;
            } else {
                this.el_serving.textContent = 'serving: —';
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
            col.innerHTML =
                '<div class="input-group input-group-sm">' +
                '<button class="btn btn-primary" type="button" style="text-align:left;">' +
                '<span class="text-info"><i class="fa fa-tree text-info" style="margin-right:3px;"></i>' +
                site.name + (active ? ' ●' : '') + '</span>' +
                '<span style="font-size:11px;color:var(--bs-gray-500);margin-left:6px;">' +
                info + '</span></button>' +
                '<button class="btn btn-primary mapv3-del" type="button" style="width:40px;">' +
                '<i class="fa fa-remove text-danger"></i></button></div>';
            col.querySelector('button').addEventListener('click', () => {
                this.input_site.value = site.name;
                // show this site's saved map in the previews
                this.pub_show.publish(new ROSLIB.Message({data: site.name}));
            });
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
