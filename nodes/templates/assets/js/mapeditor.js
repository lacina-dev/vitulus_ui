// mapeditor.js — integrate the planner polygon/zone editor INTO the map view's
// 3D scene (the one with the robot), instead of a separate page.
//
// Problem: the map view renders with ros3d, whose bundled THREE is a different
// instance from the global three.js. Adding global-THREE meshes straight into
// the ros3d scene throws in the renderer ("getUniforms" — materials/programs are
// per-renderer). So instead we draw the editor in a SECOND, transparent
// three.js renderer layered exactly over the ros3d canvas, with a camera that
// MIRRORS the ros3d camera every frame. The map (+robot) shows through from
// below; the editor geometry sits on top, pixel-aligned, because both use the
// same camera. No THREE mixing.
//
// The overlay exposes the same interface that Planner3D.Viewer does, so
// Planner3D.PolygonEditor + Planner3D.attachInteraction are reused unchanged.

window.MapEditor = (function () {
    'use strict';
    var T = window.THREE;

    // A Planner3D.Viewer-compatible adapter backed by the map view's ros3d viewer.
    class Ros3dEditOverlay {
        constructor(ros3dViewer, container) {
            this.r3d = ros3dViewer;                 // ROS3D.Viewer instance
            this.container = container;             // positioned (relative) parent of the ros3d canvas
            this.r3dCanvas = ros3dViewer.renderer.domElement;

            this.renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
            this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            this.renderer.setClearColor(0x000000, 0);   // fully transparent
            this.canvas = this.renderer.domElement;
            this.canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;' +
                'pointer-events:none;z-index:5;';
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
            container.appendChild(this.canvas);

            // The actual THREE scene we render. `this.scene` (below) is a thin
            // ros2d-style compatibility wrapper that map_edit.js drives via
            // addChild/removeChild — mirroring Planner3D.Viewer, so the planner
            // logic runs unchanged against this overlay.
            this.threeScene = new T.Scene();
            this.overlayGroup = new T.Group();   // PolygonEditor attaches here
            this.pathGroup = new T.Group();       // PathLayer attaches here
            this.threeScene.add(this.overlayGroup, this.pathGroup);

            var self0 = this;
            this.scene = {
                addChild: function (obj) { if (obj && obj._attach) obj._attach(self0); },
                removeChild: function (obj) { if (obj && obj._detach) obj._detach(self0); },
                scaleX: 1, scaleY: 1,
            };
            // gridClient stand-in: map_edit.js does
            // `gridClient.rootObject.addChild(coveragePath)` to attach the path.
            this.rootObject = {
                addChild: function (obj) { if (obj && obj._attach) obj._attach(self0); },
            };
            this.bounds = null;            // gridClient.bounds (unused here)
            this._changeCbs = [];          // gridClient.on('change') store (never emitted)

            this._planeZ0 = new T.Plane(new T.Vector3(0, 0, 1), 0);
            this._hit = new T.Vector3();
            this._pmInv = new T.Matrix4();
            this._origin = new T.Vector3();
            this._dir = new T.Vector3();
            this._ray = new T.Ray();

            this.onZoom = null;
            this.editing = false;                   // when true, overlay grabs the mouse + drives the camera

            // WP-D2 tool-mode framework. Generalises the old setDrawing(bool)
            // grab-gate into a named tool mode so the toolbar (mapedits.js) can
            // route clicks to the right handler. Modes:
            //   'off'          — idle: pointer events pass through to the live map
            //   'zone'         — zone polygon draw (map_edit.js, shared PolygonEditor)
            //   'polygon'      — free/obstacle polygon draw (map_edit.js)
            //   'edit_obstacle'|'edit_free'|'edit_wall' — mapping_manager edits draw
            //   'waypoint'     — place/move waypoints (navi_manager)
            //   'edit_delete'  — click-to-remove an edit
            // Pointer capture (canvas.pointerEvents='auto') is ON whenever a tool
            // other than 'off' is active OR the shared PolygonEditor is attached
            // (legacy setDrawing path), so both the polygon flows and the raw-click
            // tools work. onMapClick(worldX, worldY) is the raw-click hook used by
            // the waypoint / edit_delete tools (mapedits.js installs its own
            // click detector on this.canvas; this hook is provided for symmetry).
            this.toolMode = 'off';
            this._drawing = false;
            this.onMapClick = null;

            this._resize();
            var self = this;
            // Render the overlay scene with the ros3d camera ITSELF — a camera is
            // just matrices (no shaders/programs), so the global-THREE renderer
            // can use the ros3d-THREE camera, which guarantees pixel-perfect
            // alignment with the map without copying matrices.
            //
            // The loop only runs WHILE editing: otherwise this would be a second
            // 60fps GL context permanently stacked over the map view's ros3d one,
            // which (with the IMU viewer too) saturated the robot's GPU. It is
            // started in enterTopDown() and stopped in exitTopDown().
            this._raf = null;
            this._loop = function () {
                self._raf = requestAnimationFrame(self._loop);
                self.renderer.render(self.threeScene, self.r3d.camera);
            };
            window.addEventListener('resize', function () { self._resize(); });
        }

        get camera() { return this.r3d.camera; }

        _resize() {
            var w = this.r3dCanvas.clientWidth || this.r3dCanvas.width;
            var h = this.r3dCanvas.clientHeight || this.r3dCanvas.height;
            if (w > 0 && h > 0) this.renderer.setSize(w, h, false);
        }

        markDirty() { /* overlay renders every frame while editing; nothing to do */ }

        _startLoop() { if (this._raf == null) this._loop(); }
        _stopLoop() {
            if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
            // Render one transparent frame (editor geometry is hidden by now) so
            // the last drawn polygon doesn't linger on the canvas over the map.
            try { this.renderer.clear(); this.renderer.render(this.threeScene, this.r3d.camera); } catch (e) {}
        }

        // gridClient.on('change', cb) compatibility. We never emit it (the map is
        // drawn by map_view's own OccupancyGrid, not by us), so framing on map
        // load is handled by the controller via enterTopDown() instead.
        on(evt, cb) { if (evt === 'change') this._changeCbs.push(cb); }

        // pixels-per-metre near the view centre (for constant-size vertices/tolerances)
        pxPerM() {
            var a = this.screenToWorld(0, 0);
            var r = this.canvas.getBoundingClientRect();
            var b = this.screenToWorld(0 + 0, 0 + 50); // 50px down from top-left-ish
            // use centre instead for stability
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var p1 = this.screenToWorld(cx, cy);
            var p2 = this.screenToWorld(cx, cy + 50);
            var d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            return d > 1e-6 ? 50 / d : 50;
        }
        worldTol(px) { return px / this.pxPerM(); }

        // Screen → world (ROS metres). We build the pick ray from the ros3d
        // camera's matrices directly (computing the inverse projection ourselves,
        // because the ros3d camera doesn't keep a projectionMatrixInverse field
        // for global-THREE's unproject) and intersect z=0.
        screenToWorld(clientX, clientY) {
            var cam = this.r3d.camera;
            var r = this.canvas.getBoundingClientRect();
            var nx = ((clientX - r.left) / r.width) * 2 - 1;
            var ny = -(((clientY - r.top) / r.height) * 2 - 1);
            this._pmInv.copy(cam.projectionMatrix).invert();
            this._origin.setFromMatrixPosition(cam.matrixWorld);
            this._dir.set(nx, ny, 0.5).applyMatrix4(this._pmInv).applyMatrix4(cam.matrixWorld)
                .sub(this._origin).normalize();
            this._ray.set(this._origin, this._dir);
            var hit = this._ray.intersectPlane(this._planeZ0, this._hit);
            if (!hit) return { x: 0, y: 0 };
            return { x: hit.x, y: hit.y };
        }

        // Pan/zoom while editing go through the live ros3d OrbitControls (we keep
        // them running — only the tilt/rotation is locked), so the camera behaves
        // exactly like the rest of the app and stays consistent with the overlay.
        panByPixels(dxPx, dyPx) {
            var cc = this.r3d.cameraControls, cam = this.r3d.camera;
            if (!cc) return;
            // Convert the pixel drag to a WORLD delta via screenToWorld, so the
            // pan follows the cursor regardless of the camera's orientation (the
            // near-ortho top-down view's screen axes are not the world x/y axes,
            // which is why a naive dx→x / dy→y mapping looked swapped).
            var r = this.canvas.getBoundingClientRect();
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var a = this.screenToWorld(cx, cy);
            var b = this.screenToWorld(cx + dxPx, cy + dyPx);
            var ddx = a.x - b.x, ddy = a.y - b.y;
            cc.center.x += ddx; cc.center.y += ddy;
            cam.position.x += ddx; cam.position.y += ddy;
            cc.update(); cam.updateMatrixWorld(true);
        }
        zoomAt(factor, clientX, clientY) {
            var cc = this.r3d.cameraControls;
            if (cc) {
                // factor > 1 == zoom out (see attachInteraction's wheel handler).
                if (factor > 1) { cc.zoomOut(); } else { cc.zoomIn(); }
                cc.update();
            }
            if (this.onZoom) this.onZoom();
        }

        // ---- top-down edit camera mode -------------------------------------
        // Centre the live OrbitControls view on the map, framed from (near)
        // straight above, and LOCK the tilt/rotation — but keep the controls
        // running so the user can still ZOOM (wheel) and PAN (middle-drag). The
        // overlay renders with this same live camera, so editor geometry stays
        // aligned at any zoom. The view is the app's normal near-orthographic one
        // (we do NOT swap projection), just locked looking down.
        enterTopDown(cx, cy, spanM) {
            var cam = this.r3d.camera, cc = this.r3d.cameraControls;
            spanM = spanM || 60;
            if (cx == null) cx = cc ? cc.center.x : cam.position.x;
            if (cy == null) cy = cc ? cc.center.y : cam.position.y;
            this._saved = {
                pos: cam.position.clone(), up: cam.up.clone(),
                center: cc ? cc.center.clone() : null, scale: cc ? cc.scale : 1,
                rotL: cc ? cc.rotateLeft : null, rotR: cc ? cc.rotateRight : null,
                rotU: cc ? cc.rotateUp : null, rotD: cc ? cc.rotateDown : null,
            };
            if (cc) {
                var fov = (cam.fov || 40) * Math.PI / 180;
                var H = Math.max(8, (spanM * 0.5) / Math.tan(fov / 2) * 1.15);
                cc.center.set(cx, cy, 0);
                cam.position.set(cx, cy, H);
                cc.scale = 1; cc.thetaDelta = 0; cc.phiDelta = 0;
                // Re-map the rotation handlers to PAN: ros3d's left-drag calls
                // rotateLeft/rotateUp with an angle ∝ pixel delta (pixelsPerRound
                // = 1800). We lock the tilt and instead pan the map by that delta,
                // so a left-drag moves the map (zoom via wheel still works).
                var self = this, K = 1800 / (2 * Math.PI);
                cc.rotateLeft = function (a) { self.panByPixels(a * K, 0); };
                cc.rotateRight = function (a) { self.panByPixels(-a * K, 0); };
                cc.rotateUp = function (a) { self.panByPixels(0, a * K); };
                cc.rotateDown = function (a) { self.panByPixels(0, -a * K); };
                cc.update(); cam.updateMatrixWorld(true);
            }
            this.editing = true;
            this.overlayGroup.visible = true;
            this.pathGroup.visible = true;
            // Idle: pointer events pass through to the map, so the robot stays
            // drivable / orbit-zoomable. The overlay only grabs the mouse while a
            // tool is active (setToolMode) or a polygon/zone is open (setDrawing).
            this.toolMode = 'off';
            this._drawing = false;
            this._applyPointerEvents();
            this._startLoop();
        }

        // Capture the mouse only while a shape is open for editing. Kept for
        // PolygonEditor compatibility (it calls setDrawing(true/false) on
        // attach/detach); pointer capture is now the OR of this flag and the
        // active tool mode, computed in _applyPointerEvents().
        setDrawing(on) {
            this._drawing = !!on;
            this._applyPointerEvents();
        }

        // WP-D2: select the active tool mode (see the toolMode doc above).
        setToolMode(mode) {
            this.toolMode = mode || 'off';
            this._applyPointerEvents();
        }
        getToolMode() { return this.toolMode || 'off'; }

        _applyPointerEvents() {
            var active = this._drawing || (this.toolMode && this.toolMode !== 'off');
            this.canvas.style.pointerEvents = (this.editing && active) ? 'auto' : 'none';
        }
        exitTopDown() {
            var cam = this.r3d.camera, cc = this.r3d.cameraControls;
            if (this._saved) {
                var s = this._saved;
                if (cc) {
                    // Restore rotation (unlock tilt) + the previous view.
                    if (s.rotL) cc.rotateLeft = s.rotL;
                    if (s.rotR) cc.rotateRight = s.rotR;
                    if (s.rotU) cc.rotateUp = s.rotU;
                    if (s.rotD) cc.rotateDown = s.rotD;
                    if (s.center) cc.center.copy(s.center);
                    cc.scale = 1; cc.thetaDelta = 0; cc.phiDelta = 0;
                }
                cam.position.copy(s.pos); cam.up.copy(s.up);
                if (cc) { cc.update(); }
                cam.updateMatrixWorld(true);
            }
            this.editing = false;
            this.toolMode = 'off';
            this._drawing = false;
            this.canvas.style.pointerEvents = 'none';
            // Hide the editor geometry and stop the loop so nothing is drawn over
            // the live map view while not editing.
            this.overlayGroup.visible = false;
            this.pathGroup.visible = false;
            this._stopLoop();
        }
    }

    // ----------------------------------------------------------------------
    // Integration controller: wires the in-view editor. It builds the overlay
    // over map_view's 3D scene, runs the planner logic (window.initPlanner)
    // against it, and toggles a top-down "edit map" mode from a button in the
    // map menu. The editor panel (relocated planner controls) lives in
    // #div_menu_mapedit; the actual editing happens on the live 3D map.
    var _ctrl = null;

    function Controller() {
        this.overlay = null;
        this.active = false;
        this.plannerInited = false;
        this._mapInfo = null;       // {cx, cy, span} from /web_plan/map_show
        this._mapSub = null;
    }
    Controller.prototype.ensureOverlay = function () {
        if (this.overlay) return this.overlay;
        var r3d = window.__ros3d_map;
        var container = document.getElementById('map_view');
        if (!r3d || !container) return null;
        this.overlay = new Ros3dEditOverlay(r3d, container);
        window.__map_overlay = this.overlay;
        return this.overlay;
    };
    // Learn the planner map's centre/size so we can frame it top-down. This is
    // the same placement ros3d's OccupancyGrid uses (centre = w*res/2 + origin).
    Controller.prototype.subscribeMapInfo = function () {
        if (this._mapSub || !window.ros || !window.ros.ros) return;
        var self = this;
        // We only need the map header (origin/size) for framing — grab ONE message
        // then unsubscribe so we don't keep pulling the (large) grid over the wire.
        this._mapSub = new ROSLIB.Topic({
            ros: window.ros.ros, name: '/web_plan/map_show',
            messageType: 'nav_msgs/OccupancyGrid',
            throttle_rate: 1000, queue_length: 1, compression: 'cbor',
        });
        this._mapSub.subscribe(function (msg) {
            var info = msg && msg.info; if (!info || !info.origin) return;
            var res = info.resolution, w = info.width, h = info.height;
            var ox = info.origin.position.x, oy = info.origin.position.y;
            self._mapInfo = {
                cx: w * res / 2 + ox, cy: h * res / 2 + oy,
                span: Math.max(w * res, h * res) * 1.1,
            };
            try { self._mapSub.unsubscribe(); } catch (e) {}
            // If we're already in edit mode and the camera hasn't been moved by the
            // user yet, recentre on the real map now that we know where it is.
            if (self.active && self.overlay && !self._userMovedCam) {
                self.overlay.enterTopDown(self._mapInfo.cx, self._mapInfo.cy, self._mapInfo.span);
            }
        });
    };
    Controller.prototype.enter = function (opts) {
        opts = opts || {};
        var ov = this.ensureOverlay(); if (!ov) return;
        if (!this.plannerInited && typeof window.initPlanner === 'function') {
            try {
                window.initPlanner({ ros: (window.ros && window.ros.ros) || null, overlay: ov });
                this.plannerInited = true;
            } catch (e) { console.error('[mapeditor] initPlanner failed', e); }
        }
        // Show the planner map underneath (switch the occupancy-grid source).
        // WP-D2: the mapping-tab "Edit map" entry passes {keepBase:true} so the
        // SERVED site_map (drawn by mapping.js) stays as the base instead of the
        // planner map — the edits/waypoint tools work in map-frame metres either
        // way, but keeping the served map avoids a jarring base swap.
        if (!opts.keepBase) {
            try { if (window.map_menu && window.map_menu.show_planner_map) window.map_menu.show_planner_map(); } catch (e) {}
        }
        var info = this._mapInfo;
        if (info) ov.enterTopDown(info.cx, info.cy, info.span);
        else ov.enterTopDown(null, null, 60);
        this.active = true;
        // WP-D2: build/refresh the edit toolbar (waypoints + mapping_manager
        // edits) inside the detail panel and start its topic layer.
        try {
            if (window.MapEdits && window.MapEdits.onEnter) window.MapEdits.onEnter(ov);
        } catch (e) { console.error('[mapeditor] MapEdits.onEnter failed', e); }
    };
    Controller.prototype.exit = function () {
        // WP-D2: tear down any active edit tool first (detach the shared polygon,
        // remove floating inputs) so nothing lingers grabbing the mouse.
        try { if (window.MapEdits && window.MapEdits.onExit) window.MapEdits.onExit(); } catch (e) {}
        if (this.overlay) this.overlay.exitTopDown();
        this.active = false;
    };

    function controller() { if (!_ctrl) _ctrl = new Controller(); return _ctrl; }

    // While editing, the Map menu becomes a left sidebar (~480px) so the live 3D
    // map (robot, the zones being edited) stays visible to the right and the area
    // beside/below it passes pointer events through to the map.
    // The map editor lives in a SEPARATE narrow panel (#div_map_detail) that
    // sticks to the left under the menu and is hidden by default. It is toggled
    // by the edit icon (#btn_map_detail_toggle) next to the active-map name in
    // the Map menu, so the live 3D map stays visible to the right while editing.
    function _detailPanel() { return document.getElementById('div_map_detail'); }
    function _toggleBtn() { return document.getElementById('btn_map_detail_toggle'); }

    // Size the detail panel so it spans from just under the menu (its natural
    // flow top) down to just above the bottom button row, and scrolls inside if
    // its content is taller. Recomputed on show + window resize.
    function _sizeDetail() {
        var p = _detailPanel();
        if (!p || getComputedStyle(p).display === 'none') return;
        var top = p.getBoundingClientRect().top;
        var avail = window.innerHeight - top - 54;   // 54px clearance for the bottom button bar
        p.style.maxHeight = Math.max(140, avail) + 'px';
        p.style.overflowY = 'auto';
    }
    function showDetail(opts) {
        var c = controller();
        // Phase 1: the editor is a drawer panel. Hide the sibling menu panels and
        // open the drawer with the editor chrome (sizing is owned by the drawer).
        try {
            if (window.map_menu && window.map_menu.open_drawer_editor) window.map_menu.open_drawer_editor();
        } catch (e) {}
        var d = _detailPanel(); if (d) d.style.display = 'block';
        var t = _toggleBtn(); if (t) t.classList.add('active');
        if (!c.active) c.enter(opts);   // top-down camera + base map + overlay
    }
    function hideDetail() {
        var c = controller();
        var d = _detailPanel(); if (d) d.style.display = 'none';
        var t = _toggleBtn(); if (t) t.classList.remove('active');
        if (c.active) c.exit();
    }
    // The Map-menu "Edit map" toggle: leaving the editor returns to the Map panel
    // it was launched from (keeps the drawer open).
    function toggleDetail() {
        if (controller().active) {
            hideDetail();
            try {
                if (window.map_menu && window.map_menu.show_map_panel) window.map_menu.show_map_panel();
            } catch (e) {}
        } else {
            showDetail();
        }
    }
    // The editor's own ✕ (header / footer): close the whole drawer.
    function closeFromEditor() {
        if (window.map_menu && window.map_menu.close_drawer) window.map_menu.close_drawer();
        else hideDetail();
    }

    // Wire the edit icon + close button. Call once after the map view is up.
    function wire() {
        var c = controller();
        c.subscribeMapInfo();
        var t = _toggleBtn();
        var x = document.getElementById('btn_map_detail_close');
        var xf = document.getElementById('btn_map_detail_close_footer');   // sticky footer "Zavřít editor"
        if (t) t.addEventListener('click', function (e) { e.preventDefault(); toggleDetail(); });
        if (x) x.addEventListener('click', function (e) { e.preventDefault(); closeFromEditor(); });
        if (xf) xf.addEventListener('click', function (e) { e.preventDefault(); closeFromEditor(); });
    }

    // Called by map_view's hide_all_submenu_divs() when switching to another menu
    // (marker/settings/programs/...) — leave the map editor cleanly. (Closing the
    // Map menu itself does NOT close the detail panel; it is independent.)
    function exitIfActive() { hideDetail(); }

    return {
        Ros3dEditOverlay: Ros3dEditOverlay,
        wire: wire,
        controller: controller,
        exitIfActive: exitIfActive,
        // WP-D2: entry used by the mapping-tab "Edit map" button — opens the
        // detail panel keeping the served site_map as the base.
        showDetail: showDetail,
        hideDetail: hideDetail,
    };
})();
