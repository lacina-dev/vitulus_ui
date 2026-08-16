// mapedits.js — WP-D2 interactive map editor tools for vitulus_ui.
//
// Adds, on top of the existing in-view planner editor (mapeditor.js overlay +
// map_edit.js zone/polygon flows), a toolbar in #div_map_detail that drives:
//   - Waypoint tool     -> /navi_manager/save_waypoint_at + /remove_point
//   - Obstacle / Free   -> /mapping_manager/save_edit  (polygon draw, reused)
//   - Wall              -> /mapping_manager/save_edit  (polyline draw, width_m)
//   - Delete edit       -> /mapping_manager/remove_edit (click hit-test)
//   - Clear all edits   -> /mapping_manager/remove_edit "*"
//   - Zones / Polygons  -> reveal the existing map_edit.js tabs (unchanged)
//   - Exit editor
//
// The mapping_manager EDITS topic layer is deliberately isolated in the
// EditMaskLayer class below (the ONLY place that knows the save_edit/remove_edit
// /edit_list JSON schema), so a backend schema delta is a one-place fix.
//
// Rendering: edit_list is drawn into the mapeditor overlay's second THREE
// renderer (global window.THREE, same one PolygonEditor uses), at renderOrder =
// MapLayerOrder.EDITS (15) — registered in the layer-ordering contract in
// map_view.js. The AUTHORITATIVE persistent view of edits is the served
// site_map itself (mapping_manager composites edits into the raster server-side,
// so a saved edit shows in the normal map view too); this overlay is the live
// interactive editing aid, visible while the editor is open.
window.MapEdits = (function () {
    'use strict';

    var T = window.THREE;
    function EDITS_ORDER() {
        return (window.MapLayerOrder && typeof window.MapLayerOrder.EDITS === 'number')
            ? window.MapLayerOrder.EDITS : 15;
    }
    function rosOf() { return (window.ros && window.ros.ros) || null; }
    function sharedPolygon() { return window.Planner3D && window.Planner3D._lastEditor; }

    // =====================================================================
    // EDITS topic layer (isolated) — mapping_manager save_edit / remove_edit /
    // edit_list. Renders the latched edit_list into the overlay scene and
    // provides 2D hit-testing for the delete tool.
    // =====================================================================
    class EditMaskLayer {
        constructor(ros, overlay) {
            this.ros = ros;
            this.overlay = overlay;
            this.edits = [];                 // [{name, kind, width_m, points:[[x,y]...]}]

            this.group = new T.Group();
            this.group.position.z = 0.08;    // above PolygonEditor fill/edges in the overlay scene
            this.group.visible = true;
            // Attach to overlayGroup (NOT threeScene directly): overlayGroup is
            // shown in enterTopDown / hidden in exitTopDown, so the edit overlay
            // hides with the rest of the editor geometry and never lingers on the
            // final cleared frame drawn over the live map.
            overlay.overlayGroup.add(this.group);

            this.COL = {
                obstacle: new T.Color('#ff4d4d'),
                free:     new T.Color('#37c837'),
                wall:     new T.Color('#e0a030'),
            };

            this.pub_save = new ROSLIB.Topic({ ros: ros, name: '/mapping_manager/save_edit', messageType: 'std_msgs/String' });
            this.pub_remove = new ROSLIB.Topic({ ros: ros, name: '/mapping_manager/remove_edit', messageType: 'std_msgs/String' });
            this.pub_save.advertise();
            this.pub_remove.advertise();

            var self = this;
            this.sub_list = new ROSLIB.Topic({ ros: ros, name: '/mapping_manager/edit_list', messageType: 'std_msgs/String' });
            this.sub_list.subscribe(function (msg) {
                try {
                    var arr = JSON.parse(msg.data);
                    self.edits = Array.isArray(arr) ? arr : [];
                } catch (e) { self.edits = []; }
                self._render();
                if (self.onListChange) self.onListChange(self.edits);
            });
        }

        saveEdit(spec) {
            // spec: {name?, kind, points:[[x,y]...], width_m?}
            var payload = { kind: spec.kind, points: spec.points };
            if (spec.name) payload.name = spec.name;
            if (spec.kind === 'wall') payload.width_m = (spec.width_m != null) ? spec.width_m : 0.10;
            this.pub_save.publish(new ROSLIB.Message({ data: JSON.stringify(payload) }));
        }
        removeEdit(name) { this.pub_remove.publish(new ROSLIB.Message({ data: name })); }
        clearAll() { this.pub_remove.publish(new ROSLIB.Message({ data: '*' })); }

        // ---- hit test (map/ros coords) -> edit name or null ----
        hitTest(world, tol) {
            for (var i = this.edits.length - 1; i >= 0; i--) {
                var e = this.edits[i], pts = e.points || [];
                if (e.kind === 'wall') {
                    var w = (e.width_m || 0.10) / 2 + (tol || 0);
                    for (var s = 0; s < pts.length - 1; s++) {
                        if (_distToSeg(world, pts[s], pts[s + 1]) <= w) return e.name;
                    }
                } else {
                    if (pts.length >= 3 && _pointInPoly(world, pts)) return e.name;
                    // also allow grabbing near an edge for thin/degenerate polys
                    for (var k = 0; k < pts.length; k++) {
                        var a = pts[k], b = pts[(k + 1) % pts.length];
                        if (_distToSeg(world, a, b) <= (tol || 0)) return e.name;
                    }
                }
            }
            return null;
        }

        _clearGroup() {
            while (this.group.children.length) {
                var c = this.group.children.pop();
                if (c.geometry) c.geometry.dispose();
            }
        }
        _render() {
            this._clearGroup();
            var order = EDITS_ORDER();
            for (var i = 0; i < this.edits.length; i++) {
                var e = this.edits[i], pts = e.points || [];
                var col = this.COL[e.kind] || this.COL.obstacle;
                if (e.kind === 'wall') {
                    this._addRibbon(pts, e.width_m || 0.10, col, order);
                } else {
                    this._addPolygon(pts, col, order);
                }
            }
            if (this.overlay) this.overlay.markDirty();
        }
        _addPolygon(pts, col, order) {
            if (pts.length < 2) return;
            // translucent fill
            if (pts.length >= 3) {
                var shape = new T.Shape();
                shape.moveTo(pts[0][0], pts[0][1]);
                for (var i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
                shape.closePath();
                var fill = new T.Mesh(new T.ShapeGeometry(shape),
                    new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.25, side: T.DoubleSide, depthTest: false, depthWrite: false }));
                fill.renderOrder = order;
                this.group.add(fill);
            }
            // outline (closed loop)
            var seg = [];
            for (var k = 0; k < pts.length; k++) {
                var a = pts[k], b = pts[(k + 1) % pts.length];
                seg.push(a[0], a[1], 0, b[0], b[1], 0);
            }
            var lg = new T.BufferGeometry();
            lg.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
            var line = new T.LineSegments(lg, new T.LineBasicMaterial({ color: col, depthTest: false }));
            line.renderOrder = order + 0.1;
            this.group.add(line);
        }
        _addRibbon(pts, width, col, order) {
            if (pts.length < 2) return;
            var hw = Math.max(0.02, width) / 2, pos = [], idx = [];
            for (var k = 0; k < pts.length; k++) {
                var prev = pts[Math.max(0, k - 1)], next = pts[Math.min(pts.length - 1, k + 1)];
                var tx = next[0] - prev[0], ty = next[1] - prev[1];
                var len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
                var nx = -ty, ny = tx;
                pos.push(pts[k][0] + nx * hw, pts[k][1] + ny * hw, 0);
                pos.push(pts[k][0] - nx * hw, pts[k][1] - ny * hw, 0);
            }
            for (var s = 0; s < pts.length - 1; s++) { var a = s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
            var geo = new T.BufferGeometry();
            geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
            geo.setIndex(idx);
            var mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, side: T.DoubleSide, depthTest: false, depthWrite: false }));
            mesh.renderOrder = order;
            this.group.add(mesh);
        }
        destroy() {
            try { this.sub_list.unsubscribe(); } catch (e) {}
            try { this._clearGroup(); if (this.group.parent) this.group.parent.remove(this.group); } catch (e) {}
        }
    }

    // ---- 2D geometry helpers (map coords) ----
    function _distToSeg(p, a, b) {
        var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        if (l2 === 0) return Math.hypot(p.x - a[0], p.y - a[1]);
        var t = ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
    }
    function _pointInPoly(p, pts) {
        var inside = false, n = pts.length;
        for (var i = 0, j = n - 1; i < n; j = i++) {
            var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
            var intersect = ((yi > p.y) !== (yj > p.y)) &&
                (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // =====================================================================
    // Controller: toolbar + tool state machine.
    // =====================================================================
    var _ov = null;          // Ros3dEditOverlay
    var _layer = null;       // EditMaskLayer
    var _mapObjLayer = null; // MapObjectsLayer (V3: waypoint/path overlay groups)
    var _tool = 'off';
    var _built = false;
    var _wpN = 1;            // wp_<n> suggestion counter
    var _pathN = 1;          // path_<n> suggestion counter
    var _pendingMoveName = null;
    var _clickState = null;  // raw click detector
    var _wpNames = [];       // known waypoint names (from map_point_str_list)

    // waypoint topics (navi_manager) — kept next to the tool that uses them.
    var _pub_wp_at = null, _pub_wp_remove = null, _sub_wp_list = null;
    var _pub_path_at = null;      // V2: manual path draw -> /navi_manager/save_path_at
    var _pub_path_remove = null;  // PATH MGMT: delete path -> /navi_manager/remove_path

    // V3: overlay-group visibility toggles, persisted in localStorage (default ON).
    var SHOW_KEYS = { waypoints: 'vitulus_editor_show_waypoints', paths: 'vitulus_editor_show_paths',
                      edits: 'vitulus_editor_show_edits', zones: 'vitulus_editor_show_zones' };
    var _show = { waypoints: true, paths: true, edits: true, zones: true };
    function _loadShow() {
        for (var k in SHOW_KEYS) {
            try { var v = localStorage.getItem(SHOW_KEYS[k]); if (v !== null) _show[k] = (v === '1'); } catch (e) {}
        }
    }
    function _saveShow(k) { try { localStorage.setItem(SHOW_KEYS[k], _show[k] ? '1' : '0'); } catch (e) {} }

    // PATH MGMT: per-path hidden-set persistence (JSON array of names).
    var HIDDEN_PATHS_KEY = 'vitulus_editor_hidden_paths';
    function _loadHiddenPaths() {
        try {
            var v = localStorage.getItem(HIDDEN_PATHS_KEY);
            var arr = v ? JSON.parse(v) : [];
            return new Set(Array.isArray(arr) ? arr : []);
        } catch (e) { return new Set(); }
    }
    function _saveHiddenPaths(set) {
        try { localStorage.setItem(HIDDEN_PATHS_KEY, JSON.stringify(Array.from(set))); } catch (e) {}
    }

    function _ensureWpTopics(ros) {
        if (_pub_wp_at) return;
        _pub_wp_at = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/save_waypoint_at', messageType: 'std_msgs/String' });
        _pub_wp_remove = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/remove_point', messageType: 'std_msgs/String' });
        _pub_path_at = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/save_path_at', messageType: 'std_msgs/String' });
        _pub_path_remove = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/remove_path', messageType: 'std_msgs/String' });
        _pub_wp_at.advertise();
        _pub_wp_remove.advertise();
        _pub_path_at.advertise();
        _pub_path_remove.advertise();
        _sub_wp_list = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/map_point_str_list', messageType: 'vitulus_msgs/StringList' });
        _sub_wp_list.subscribe(function (msg) {
            _wpNames = (msg && msg.string_list) ? msg.string_list.slice() : [];
            _renderWpList();
        });
    }

    // =====================================================================
    // V3: MapObjectsLayer — renders /navi_manager/map_objects (latched JSON of
    // waypoints + paths in MAP frame) into the overlay scene as two toggleable
    // groups (waypoint dots+labels, path polylines). Also provides waypoint
    // hit-testing so the waypoint tool can select an existing dot for move/delete.
    // =====================================================================
    class MapObjectsLayer {
        constructor(ros, overlay) {
            this.ros = ros;
            this.overlay = overlay;
            this.waypoints = [];   // [{name,x,y,yaw}]
            this.paths = [];       // [{name, points:[[x,y]...]}]

            this.wpGroup = new T.Group();   this.wpGroup.position.z = 0.14;
            this.pathGroup = new T.Group(); this.pathGroup.position.z = 0.11;
            overlay.overlayGroup.add(this.wpGroup);
            overlay.overlayGroup.add(this.pathGroup);

            this.COL_WP = new T.Color('#20c0ff');
            this.COL_PATH = new T.Color('#00d0a0');

            // PATH MGMT: per-path visibility hidden-set (names), persisted as a JSON
            // array in localStorage. Independent of the global "Paths" chip, which
            // toggles pathGroup.visible for the whole group.
            this.hiddenPaths = _loadHiddenPaths();

            var self = this;
            this.sub = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/map_objects', messageType: 'std_msgs/String' });
            this.sub.subscribe(function (msg) {
                try {
                    var d = JSON.parse(msg.data);
                    self.waypoints = Array.isArray(d.waypoints) ? d.waypoints : [];
                    self.paths = Array.isArray(d.paths) ? d.paths : [];
                } catch (e) { self.waypoints = []; self.paths = []; }
                self._render();
                if (self.onChange) self.onChange();
            });
        }
        setWaypointsVisible(v) { this.wpGroup.visible = !!v; if (this.overlay) this.overlay.markDirty(); }
        setPathsVisible(v) { this.pathGroup.visible = !!v; if (this.overlay) this.overlay.markDirty(); }

        // PATH MGMT: per-path visibility.
        isPathHidden(name) { return this.hiddenPaths.has(name); }
        setPathHidden(name, hidden) {
            if (hidden) this.hiddenPaths.add(name); else this.hiddenPaths.delete(name);
            _saveHiddenPaths(this.hiddenPaths);
            this._render();
        }
        // PATH MGMT: hit test against path polylines (map/ros coords) -> path or null.
        hitTestPath(world, tol) {
            for (var i = this.paths.length - 1; i >= 0; i--) {
                var pth = this.paths[i], pts = pth.points || [];
                for (var s = 0; s < pts.length - 1; s++) {
                    if (_distToSeg(world, pts[s], pts[s + 1]) <= (tol || 0.3)) return pth;
                }
            }
            return null;
        }

        hitTestWaypoint(world, tol) {
            var best = null, bestD = (tol || 0.4);
            for (var i = 0; i < this.waypoints.length; i++) {
                var w = this.waypoints[i];
                var d = Math.hypot(world.x - w.x, world.y - w.y);
                if (d <= bestD) { bestD = d; best = w; }
            }
            return best;
        }

        _clearGroup(g) {
            while (g.children.length) {
                var c = g.children.pop();
                if (c.geometry) c.geometry.dispose();
                if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
            }
        }
        _render() {
            this._clearGroup(this.wpGroup);
            this._clearGroup(this.pathGroup);
            var order = EDITS_ORDER() + 2;
            // paths — thin polylines (skip per-path hidden names)
            for (var p = 0; p < this.paths.length; p++) {
                if (this.hiddenPaths.has(this.paths[p].name)) continue;
                var pts = this.paths[p].points || [];
                if (pts.length < 2) continue;
                var seg = [];
                for (var s = 0; s < pts.length - 1; s++) seg.push(pts[s][0], pts[s][1], 0, pts[s + 1][0], pts[s + 1][1], 0);
                var lg = new T.BufferGeometry();
                lg.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
                var line = new T.LineSegments(lg, new T.LineBasicMaterial({ color: this.COL_PATH, depthTest: false }));
                line.renderOrder = order;
                this.pathGroup.add(line);
            }
            // waypoints — small dot + heading tick + text label
            for (var i = 0; i < this.waypoints.length; i++) {
                var w = this.waypoints[i];
                var r = 0.18;
                var dot = new T.Mesh(new T.CircleGeometry(r, 16),
                    new T.MeshBasicMaterial({ color: this.COL_WP, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
                dot.position.set(w.x, w.y, 0);
                dot.renderOrder = order + 1;
                this.wpGroup.add(dot);
                // heading tick
                if (typeof w.yaw === 'number') {
                    // 2026-08-16: tick -> ARROW (with a head) so the stored
                    // heading is actually readable on the map
                    var hL = r * 2.6, hA = r * 0.9;
                    var hx = w.x + Math.cos(w.yaw) * hL, hy = w.y + Math.sin(w.yaw) * hL;
                    var b1 = w.yaw + Math.PI * 0.82, b2 = w.yaw - Math.PI * 0.82;
                    var hg = new T.BufferGeometry();
                    hg.setAttribute('position', new T.Float32BufferAttribute([
                        w.x, w.y, 0, hx, hy, 0,
                        hx, hy, 0, hx + Math.cos(b1) * hA, hy + Math.sin(b1) * hA, 0,
                        hx, hy, 0, hx + Math.cos(b2) * hA, hy + Math.sin(b2) * hA, 0], 3));
                    var hl = new T.LineSegments(hg, new T.LineBasicMaterial({ color: this.COL_WP, depthTest: false }));
                    hl.renderOrder = order + 1;
                    this.wpGroup.add(hl);
                }
                var label = this._makeLabel(w.name || '', w.x + r * 1.6, w.y + r * 1.6, order + 2);
                if (label) this.wpGroup.add(label);
            }
            if (this.overlay) this.overlay.markDirty();
        }
        _makeLabel(text, x, y, order) {
            try {
                var cv = document.createElement('canvas');
                var ctx = cv.getContext('2d');
                var fs = 40; ctx.font = fs + 'px sans-serif';
                var w = Math.max(8, ctx.measureText(text).width);
                cv.width = w + 12; cv.height = fs + 12;
                ctx = cv.getContext('2d');
                ctx.font = fs + 'px sans-serif'; ctx.textBaseline = 'top';
                ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cv.width, cv.height);
                ctx.fillStyle = '#20c0ff'; ctx.fillText(text, 6, 6);
                var tex = new T.CanvasTexture(cv);
                tex.needsUpdate = true;
                var mat = new T.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
                var spr = new T.Sprite(mat);
                var sc = 0.012;   // metres per pixel
                spr.scale.set(cv.width * sc, cv.height * sc, 1);
                spr.position.set(x + cv.width * sc / 2, y, 0);
                spr.renderOrder = order;
                return spr;
            } catch (e) { return null; }
        }
        destroy() {
            try { this.sub.unsubscribe(); } catch (e) {}
            try { this._clearGroup(this.wpGroup); if (this.wpGroup.parent) this.wpGroup.parent.remove(this.wpGroup); } catch (e) {}
            try { this._clearGroup(this.pathGroup); if (this.pathGroup.parent) this.pathGroup.parent.remove(this.pathGroup); } catch (e) {}
        }
    }

    // ---- public lifecycle (called from mapeditor.js Controller) ----
    function onEnter(overlay) {
        _ov = overlay;
        var ros = rosOf();
        if (!ros) { console.warn('[mapedits] no ros connection yet'); }
        if (ros && !_layer) {
            _layer = new EditMaskLayer(ros, overlay);
            _layer.onListChange = function () { _renderEditList(); };
        } else if (_layer) {
            // overlay may have been rebuilt — re-attach the render group
            try { if (_layer.group.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_layer.group); } catch (e) {}
        }
        // V3: map-objects overlay (waypoint dots + path polylines).
        if (ros && !_mapObjLayer) {
            _mapObjLayer = new MapObjectsLayer(ros, overlay);
            _mapObjLayer.onChange = function () { _renderPathList(); };
        } else if (_mapObjLayer) {
            try {
                if (_mapObjLayer.wpGroup.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_mapObjLayer.wpGroup);
                if (_mapObjLayer.pathGroup.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_mapObjLayer.pathGroup);
            } catch (e) {}
        }
        if (ros) _ensureWpTopics(ros);
        _loadShow();
        _buildToolbar();
        _installClickDetector();
        _renderEditList();
        _renderWpList();
        _renderPathList();
        _applyAllShow();
        _setTool('off');
    }
    function onExit() {
        _teardownTool();
        _setToolButtonsActive('off');
        _hideWpInput();
        // V3: the Zones chip toggles LIVE-scene program/zone markers; restore them
        // so closing the editor never leaves the normal map view with zones hidden.
        // (The waypoint/path overlay groups live under overlayGroup, which the
        // overlay hides on exitTopDown, so they need no explicit restore.)
        _applyZonesVisible(true);
    }

    // ---- toolbar UI ----
    function _panel() { return document.getElementById('div_map_detail'); }

    // TOOLS: 4-per-row icon grid. Each entry: state machine tool id + emoji +
    // label + idle bootstrap variant (swapped to solid btn-primary when
    // active). 'off' == pan (pan/zoom passes through to the live map).
    // V4: UI labels clarified. The backend edit "kind" values stay
    // obstacle/free/wall (see _finishEditsDraw) for backend compat — only the
    // visible label/hint text changes here. V2 adds the 'path' tool (manual path
    // drawing that lands in the same collection as robot-recorded paths).
    var TOOLS = [
        { tool: 'off',           ico: '🖐️', label: 'Pan',            idle: 'btn-outline-light' },
        { tool: 'waypoint',      ico: '📍',       label: 'Waypoint',       idle: 'btn-outline-info' },
        { tool: 'path',          ico: '🛤️', label: 'Path',           idle: 'btn-outline-primary' },
        { tool: 'edit_obstacle', ico: '⬛',             label: 'Obstacle (area)',idle: 'btn-outline-danger' },
        { tool: 'edit_free',     ico: '⬜',             label: 'Free (clear area)', idle: 'btn-outline-success' },
        { tool: 'edit_wall',     ico: '〰️',       label: 'Barrier (line)', idle: 'btn-outline-warning' },
        { tool: 'edit_delete',   ico: '🗑️', label: 'Delete',         idle: 'btn-outline-secondary' },
    ];

    function _buildToolbar() {
        if (_built) { _refreshDisabled(); return; }
        var tools = document.getElementById('mapedit_tools');
        var ctx = document.getElementById('mapedit_context');
        if (!tools || !ctx) { _built = false; return; }   // panel not (yet) redesigned

        // B. TOOLS — icon grid.
        var gh = '<div class="text-uppercase fw-bold" style="font-size:11px;letter-spacing:.5px;color:var(--bs-gray-400);margin-bottom:6px;">Tools</div><div class="met-grid">';
        for (var i = 0; i < TOOLS.length; i++) {
            var t = TOOLS[i];
            gh += '<button type="button" class="btn met-tool ' + t.idle + '" data-tool="' + t.tool + '" data-idle="' + t.idle + '">' +
                  '<span class="met-ico">' + t.ico + '</span><span>' + t.label + '</span></button>';
        }
        gh += '</div>';
        // V3: "Show:" row of toggle chips for the editor overlay groups.
        gh += _showRowHtml();
        tools.innerHTML = gh;

        // C. ACTIVE TOOL CONTEXT — one box showing only what the tool needs.
        ctx.innerHTML =
            '<div class="text-uppercase fw-bold" style="font-size:11px;letter-spacing:.5px;color:var(--bs-gray-400);margin-bottom:4px;">Tool context</div>' +
            '<div style="border:1px solid var(--bs-secondary);border-radius:5px;padding:8px;background:rgba(0,0,0,.2);">' +
            '  <div id="mapedit_hint" style="font-size:12.5px;color:var(--bs-info);min-height:18px;"></div>' +
            '  <div id="mapedit_wall_wrap" style="display:none;margin-top:8px;">' +
            '    <span style="font-size:12px;display:block;margin-bottom:2px;">Barrier width</span>' +
            '    <div class="input-group input-group-sm" style="width:130px;"><input class="form-control" id="mapedit_wall_w" type="number" min="0.02" max="2" step="0.05" value="0.10"><span class="input-group-text">m</span></div>' +
            '  </div>' +
            '  <div id="mapedit_path_wrap" style="display:none;margin-top:8px;">' +
            '    <span style="font-size:12px;display:block;margin-bottom:2px;">Path name</span>' +
            '    <input class="form-control form-control-sm" id="mapedit_path_name" type="text" value="" style="width:180px;">' +
            '  </div>' +
            '  <div id="mapedit_wp_form" style="margin-top:8px;"></div>' +
            '  <div id="mapedit_path_sel" style="margin-top:8px;"></div>' +
            '  <div id="mapedit_ctx_actions" class="d-flex" style="gap:6px;margin-top:8px;">' +
            '    <button class="btn btn-success btn-sm flex-fill" id="mapedit_finish" type="button" style="display:none;">Finish</button>' +
            '    <button class="btn btn-warning btn-sm flex-fill" id="mapedit_cancel" type="button" style="display:none;">Cancel</button>' +
            '  </div>' +
            '</div>';

        // tool buttons
        tools.querySelectorAll('[data-tool]').forEach(function (b) {
            b.addEventListener('click', function () {
                var m = b.getAttribute('data-tool');
                if (m === 'off') { _setTool('off'); return; }
                if (_tool === m) _setTool('off'); else _setTool(m);
            });
        });
        // V3: Show chips.
        _wireShowChips(tools);
        // finish / cancel (edits draw)
        ctx.querySelector('#mapedit_finish').addEventListener('click', _finishEditsDraw);
        ctx.querySelector('#mapedit_cancel').addEventListener('click', function () { _setTool('off'); });

        // Edity mapy section: Clear-all (double-click confirm) lives here, not in
        // the tool grid.
        var editctl = document.getElementById('mapedit_editctl');
        if (editctl) {
            editctl.innerHTML = '<button class="btn btn-outline-danger btn-sm" id="mapedit_clear_all" type="button">Clear all</button>';
            _wireClearAll(editctl.querySelector('#mapedit_clear_all'));
        }

        _built = true;
        _refreshDisabled();
    }

    // ---- V3: "Show:" toggle chips ----
    var SHOW_CHIPS = [
        { k: 'waypoints', label: 'Waypoints' },
        { k: 'paths',     label: 'Paths' },
        { k: 'edits',     label: 'Edits' },
        { k: 'zones',     label: 'Zones' },
    ];
    function _showRowHtml() {
        var h = '<div id="mapedit_show_row" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;">' +
                '<span style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--bs-gray-400);">Show:</span>';
        for (var i = 0; i < SHOW_CHIPS.length; i++) {
            var c = SHOW_CHIPS[i];
            var on = _show[c.k] !== false;
            h += '<button type="button" class="btn btn-sm mapedit-show-chip ' + (on ? 'btn-info' : 'btn-outline-secondary') +
                 '" data-show="' + c.k + '" style="min-height:28px;padding:2px 10px;font-size:12px;">' + c.label + '</button>';
        }
        h += '</div>';
        return h;
    }
    function _wireShowChips(root) {
        if (!root) return;
        root.querySelectorAll('.mapedit-show-chip').forEach(function (b) {
            b.addEventListener('click', function () {
                var k = b.getAttribute('data-show');
                _show[k] = !_show[k];
                _saveShow(k);
                _applyShow(k);
                b.className = 'btn btn-sm mapedit-show-chip ' + (_show[k] ? 'btn-info' : 'btn-outline-secondary');
                b.style.minHeight = '28px'; b.style.padding = '2px 10px'; b.style.fontSize = '12px';
            });
        });
    }
    function _applyAllShow() { for (var k in SHOW_KEYS) _applyShow(k); }
    function _applyShow(k) {
        if (k === 'waypoints') { if (_mapObjLayer) _mapObjLayer.setWaypointsVisible(_show.waypoints); }
        else if (k === 'paths') { if (_mapObjLayer) _mapObjLayer.setPathsVisible(_show.paths); }
        else if (k === 'edits') { if (_layer) { _layer.group.visible = !!_show.edits; if (_ov) _ov.markDirty(); } }
        else if (k === 'zones') { _applyZonesVisible(_show.zones); }
    }
    // Zones: toggle the EXISTING program/zone MarkerArray geometry in the live
    // 3D scene (exposed by map_view.js as window.__program_markers_client) rather
    // than re-rendering. MarkerArrayClient keeps its rendered markers in .markers.
    function _applyZonesVisible(vis) {
        var c = window.__program_markers_client;
        if (!c || !c.markers) return;
        try {
            Object.keys(c.markers).forEach(function (key) {
                var m = c.markers[key];
                if (m) m.visible = !!vis;
            });
        } catch (e) {}
    }

    function _showEditTab(which) {
        // Activate the existing bootstrap tab pane authored in index.html.
        var href = (which === 'poly') ? '#tab-edit-poly' : '#tab-edit-zone';
        var link = document.querySelector('a[href="' + href + '"]');
        try {
            if (link && window.bootstrap && window.bootstrap.Tab) {
                window.bootstrap.Tab.getOrCreateInstance(link).show();
            } else if (link) { link.click(); }
        } catch (e) { if (link) link.click(); }
        _setHint(which === 'poly'
            ? 'Use "New polygon" below to draw a free/obstacle polygon (planner).'
            : 'Use "New zone" below to draw a mowing zone (planner).');
    }

    // Double-click-to-confirm (NEVER window.confirm — it blocks the event loop).
    function _wireClearAll(btn) {
        if (!btn) return;
        var armed = false, timer = null;
        var orig = btn.textContent;
        function disarm() { armed = false; btn.textContent = orig; btn.classList.remove('btn-danger'); btn.classList.add('btn-outline-danger'); if (timer) { clearTimeout(timer); timer = null; } }
        btn.addEventListener('click', function () {
            if (!armed) {
                armed = true; btn.textContent = 'Sure?'; btn.classList.remove('btn-outline-danger'); btn.classList.add('btn-danger');
                timer = setTimeout(disarm, 2500);
            } else {
                disarm();
                if (_layer) _layer.clearAll();
                _setHint('All edits cleared.');
            }
        });
    }

    function _setHint(t) { var h = document.getElementById('mapedit_hint'); if (h) h.textContent = t || ''; }
    function _refreshDisabled() {
        // Obstacle/Free/Wall/Delete/Clear need the edits backend; if the shared
        // polygon isn't ready (planner not inited) the draw tools still function
        // once map_edit.js has run — nothing hard-disabled here, but hint.
    }

    // ---- tool state machine ----
    function _setToolButtonsActive(mode) {
        var tools = document.getElementById('mapedit_tools'); if (!tools) return;
        tools.querySelectorAll('[data-tool]').forEach(function (b) {
            var idle = b.getAttribute('data-idle') || 'btn-outline-secondary';
            b.className = (b.getAttribute('data-tool') === mode)
                ? 'btn met-tool btn-primary active'
                : 'btn met-tool ' + idle;
        });
        var isDraw = (mode === 'edit_obstacle' || mode === 'edit_free' || mode === 'edit_wall' || mode === 'path');
        var fin = document.getElementById('mapedit_finish'), can = document.getElementById('mapedit_cancel');
        if (fin) fin.style.display = isDraw ? '' : 'none';
        if (can) can.style.display = isDraw ? '' : 'none';
        var ww = document.getElementById('mapedit_wall_wrap');
        if (ww) ww.style.display = (mode === 'edit_wall') ? '' : 'none';
        var pw = document.getElementById('mapedit_path_wrap');
        if (pw) pw.style.display = (mode === 'path') ? '' : 'none';
    }

    function _teardownTool() {
        // detach + clear the shared polygon if we were drawing edits
        var P = sharedPolygon();
        if (P) { P.openLine = false; }   // zones/polygons draw closed again
        if (P && P.attached && _ov) {
            try { _ov.scene.removeChild(P); } catch (e) {}
            _clearPolygon(P);
        }
        _pendingMoveName = null;
        _hideWpInput();
        _hidePathSel();
    }

    function _clearPolygon(P) {
        try {
            P.pointContainer.children = [];
            P.lineContainer.children = [];
            P.fillShape.graphics._instructions = [];
            P.fillShape.graphics._oldInstructions = [];
        } catch (e) {}
    }

    function _setTool(mode) {
        _teardownTool();
        _tool = mode || 'off';
        if (_ov && _ov.setToolMode) _ov.setToolMode(_tool);
        _setToolButtonsActive(_tool);

        if (_tool === 'edit_obstacle' || _tool === 'edit_free' || _tool === 'edit_wall' || _tool === 'path') {
            var P = sharedPolygon();
            if (!P) { _setHint('Editor not ready — open the map editor and try again.'); _setTool('off'); return; }
            _clearPolygon(P);
            // path + barrier are open polylines - no closing edge, no fill
            P.openLine = (_tool === 'path' || _tool === 'edit_wall');
            try { _ov.scene.addChild(P); } catch (e) {}   // grabs the mouse via setDrawing(true)
            if (_tool === 'path') {
                var pn = document.getElementById('mapedit_path_name');
                if (pn && !pn.value.trim()) pn.value = 'path_' + _pathN;
                _setHint('Click path points on the map, then Finish. Or click an existing path to edit/delete it. Paths appear in the Paths section.');
            } else {
                _setHint(_tool === 'edit_wall'
                    ? 'Barrier = a virtual line the robot must not cross (fence / keep-out). Click points; set the width; Finish.'
                    : (_tool === 'edit_obstacle'
                        ? 'Obstacle = a polygon area of a real object. Click at least 3 points, then Finish.'
                        : 'Free = clears mapped obstacles / marks the area as drivable. Click at least 3 points, then Finish.'));
            }
        } else if (_tool === 'waypoint') {
            _renderWpList();
            _setHint('Click the map to place a waypoint. Existing ones are in the Waypoints section (Move / Delete).');
        } else if (_tool === 'edit_delete') {
            _setHint('Click an edit (obstacle / free / wall) to delete it.');
        } else {
            _setHint('Pick a tool above. 🖐️ Pan = drag and zoom the map.');
        }
    }

    function _finishEditsDraw() {
        if (_tool === 'path') { _finishPathDraw(); return; }
        var P = sharedPolygon();
        if (!P) { _setTool('off'); return; }
        var pts = [];
        var ch = P.pointContainer.children || [];
        for (var i = 0; i < ch.length; i++) pts.push([ch[i].x, -ch[i].y]); // store y=-rosY -> map y
        var kind = (_tool === 'edit_obstacle') ? 'obstacle' : (_tool === 'edit_free') ? 'free' : 'wall';
        var minPts = (kind === 'wall') ? 2 : 3;
        if (pts.length < minPts) { _setHint('Need at least ' + minPts + ' points for: ' + kind + '.'); return; }
        var spec = { kind: kind, points: pts };
        if (kind === 'wall') {
            var wi = document.getElementById('mapedit_wall_w');
            spec.width_m = wi ? (parseFloat(wi.value) || 0.10) : 0.10;
        }
        if (_layer) _layer.saveEdit(spec);
        _setHint('Saved (' + kind + ', ' + pts.length + ' pts). Map + zone paths update in a few seconds.');
        _setTool('off');
    }

    // V2: finish the manually drawn path — same vertex extraction as the edit
    // draw, published to /navi_manager/save_path_at so it lands in the SAME
    // running_map_data.paths collection as robot-recorded paths (Path tab).
    function _finishPathDraw() {
        var P = sharedPolygon();
        if (!P) { _setTool('off'); return; }
        var pts = [];
        var ch = P.pointContainer.children || [];
        for (var i = 0; i < ch.length; i++) pts.push([ch[i].x, -ch[i].y]); // ros y -> map y
        if (pts.length < 2) { _setHint('Need at least 2 points for a path.'); return; }
        var pn = document.getElementById('mapedit_path_name');
        var name = (pn && pn.value ? pn.value : '').trim() || ('path_' + _pathN);
        if (!_pub_path_at) { _setHint('Path publisher not ready.'); return; }
        _pub_path_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: name, points: pts }) }));
        _pathN++;
        _setHint('Saved path "' + name + '" (' + pts.length + ' points). It appears in the Path tab.');
        _setTool('off');
    }

    // ---- raw click detector (waypoint / edit_delete) ----
    function _installClickDetector() {
        if (_clickState || !_ov || !_ov.canvas) return;
        var cv = _ov.canvas, st = { down: false, x: 0, y: 0, moved: false, mod: false };
        _clickState = st;
        cv.addEventListener('mousedown', function (ev) {
            st.down = true; st.moved = false; st.x = ev.clientX; st.y = ev.clientY;
            st.mod = ev.ctrlKey || ev.altKey || ev.shiftKey || ev.button !== 0;
            // PATH MGMT: snapshot the shared-polygon vertex count BEFORE this click
            // so the path-tool mouseup can tell a fresh first click (0 pts -> select
            // an existing path) from a mid-draw click (leave the added point).
            var P = sharedPolygon();
            st.pathPre = (P && P.pointContainer) ? (P.pointContainer.children || []).length : 0;
        });
        window.addEventListener('mousemove', function (ev) {
            if (!st.down) return;
            if (Math.hypot(ev.clientX - st.x, ev.clientY - st.y) > 5) st.moved = true;
        });
        window.addEventListener('mouseup', function (ev) {
            if (!st.down) return; st.down = false;
            if (st.moved || st.mod) return;
            var m = _ov.getToolMode ? _ov.getToolMode() : 'off';
            if (m !== 'waypoint' && m !== 'edit_delete' && m !== 'path') return;
            var w = _ov.screenToWorld(ev.clientX, ev.clientY);
            if (m === 'waypoint') _onWaypointClick(w, ev.clientX, ev.clientY);
            else if (m === 'edit_delete') _onDeleteClick(w);
            else _onPathToolClick(w, st.pathPre);   // path tool select-on-map
        });
    }

    function _onDeleteClick(world) {
        if (!_layer) return;
        var tol = _ov.worldTol ? _ov.worldTol(10) : 0.3;
        var name = _layer.hitTest(world, tol);
        if (name) { _layer.removeEdit(name); _setHint('Deleted edit "' + name + '".'); }
        else _setHint('No edit under the cursor.');
    }

    // =====================================================================
    // PATH MGMT — select-on-map, per-path list, edit (pre-seed), delete.
    // =====================================================================

    // Path tool click. attachInteraction has (on this same click) already added a
    // vertex to the shared polygon; we run AFTER it. On the FIRST click of a fresh
    // draw (preCount === 0) we hit-test existing paths: a hit selects that path
    // (undoing the stray vertex); empty space starts a normal new draw. Mid-draw
    // clicks (preCount > 0) are left untouched so drawing works as before.
    function _onPathToolClick(world, preCount) {
        if (preCount !== 0) return;             // mid-draw: keep adding points
        if (!_mapObjLayer) { _hidePathSel(); return; }
        var hit = _mapObjLayer.hitTestPath(world, 0.3);   // ~0.3 m world threshold
        if (hit) {
            var P = sharedPolygon();
            if (P) _clearPolygon(P);            // remove the vertex we just placed
            _selectPath(hit);
        } else {
            _hidePathSel();                     // starting a new path: clear stale box
        }
    }

    // A map-selected path — offer Edit (pre-seed the draw) / Delete / Cancel in the
    // tool context box (same interaction language as waypoint selection).
    function _selectPath(path) {
        var host = document.getElementById('mapedit_path_sel');
        if (!host) return;
        var np = (path.points || []).length;
        host.innerHTML =
            '<div style="border-top:1px dashed var(--bs-secondary);padding-top:8px;">' +
            '<div style="font-size:12px;margin-bottom:6px;">Selected path: <b class="text-info">' + _escapeHtml(path.name || '') + '</b> <span style="color:var(--bs-gray-500);">(' + np + ' pts)</span></div>' +
            '<div class="d-flex" style="gap:6px;">' +
            '  <button class="btn btn-outline-info btn-sm flex-fill" id="mapedit_path_sel_edit" type="button">Edit</button>' +
            '  <button class="btn btn-outline-danger btn-sm flex-fill" id="mapedit_path_sel_del" type="button">Delete</button>' +
            '  <button class="btn btn-warning btn-sm flex-fill" id="mapedit_path_sel_cancel" type="button">Cancel</button>' +
            '</div></div>';
        host.querySelector('#mapedit_path_sel_edit').addEventListener('click', function () {
            _hidePathSel();
            _editPath(path);
        });
        _wireRowDelete(host.querySelector('#mapedit_path_sel_del'), path.name, function () {
            _removePath(path.name);
            _hidePathSel();
            _setHint('Deleted path "' + path.name + '".');
        });
        host.querySelector('#mapedit_path_sel_cancel').addEventListener('click', function () {
            _hidePathSel();
            _setHint('Click path points on the map, then Finish. Or click an existing path to edit/delete it.');
        });
        _setHint('Path "' + (path.name || '') + '" selected — Edit to modify its points, or Delete.');
    }
    function _hidePathSel() {
        var host = document.getElementById('mapedit_path_sel');
        if (host) host.innerHTML = '';
    }

    // Edit a path: enter the 'path' tool pre-seeded with the path's existing
    // vertices, name input prefilled with the SAME name so Finish -> save_path_at
    // REPLACES it. PolygonEditor stores vertices as {x: rosX, y: -rosY}; assigning
    // pointContainer.children triggers its _redraw (draggable verts, click adds).
    function _editPath(path) {
        _setTool('path');                       // attaches + clears the shared polygon
        var P = sharedPolygon();
        if (!P) { _setHint('Editor not ready — open the map editor and try again.'); return; }
        var pts = path.points || [];
        var seed = [];
        for (var i = 0; i < pts.length; i++) seed.push({ x: pts[i][0], y: -pts[i][1] });
        P.pointContainer.children = seed;       // setter -> _redraw()
        var pn = document.getElementById('mapedit_path_name');
        if (pn) pn.value = path.name || '';
        _setHint('Editing path "' + (path.name || '') + '" (' + seed.length + ' pts). Drag vertices, click to add points, then Finish to replace. Cancel leaves it unchanged.');
    }

    function _removePath(name) {
        if (_pub_path_remove) _pub_path_remove.publish(new ROSLIB.Message({ data: name }));
    }

    // Double-click-to-confirm delete wiring for a single button (NEVER
    // window.confirm). onConfirm fires on the second click within the window.
    function _wireRowDelete(btn, name, onConfirm) {
        if (!btn) return;
        var armed = false, timer = null;
        var orig = btn.textContent;
        var solid = 'btn-danger', outline = 'btn-outline-danger';
        function disarm() { armed = false; btn.textContent = orig; btn.classList.remove(solid); btn.classList.add(outline); if (timer) { clearTimeout(timer); timer = null; } }
        btn.addEventListener('click', function () {
            if (!armed) {
                armed = true; btn.textContent = 'Confirm'; btn.classList.remove(outline); btn.classList.add(solid);
                timer = setTimeout(disarm, 2500);
            } else {
                disarm();
                onConfirm();
            }
        });
    }

    // Paths list lives in the collapsible "Paths" section — rendered from the
    // latest map_objects.paths. Per row: name (ellipsis), point count, 👁
    // visibility toggle (per-path), Edit, Delete (double-click confirm).
    function _renderPathList() {
        var pl = document.getElementById('mapedit_path_list');
        if (!pl) return;
        var paths = (_mapObjLayer && _mapObjLayer.paths) ? _mapObjLayer.paths : [];
        if (!paths.length) { pl.innerHTML = '<div style="font-size:12px;color:var(--bs-gray-500);">No paths yet.</div>'; return; }
        var html = '';
        for (var i = 0; i < paths.length; i++) {
            var pth = paths[i];
            var name = pth.name || '';
            var np = (pth.points || []).length;
            var hidden = _mapObjLayer.isPathHidden(name);
            html += '<div class="d-flex align-items-center" style="border-bottom:1px solid #3a3f44;padding:4px 2px;font-size:12px;">' +
                '<span class="text-truncate" style="flex:1 1 auto;min-width:0;color:' + (hidden ? 'var(--bs-gray-500)' : '#00d0a0') + ';" title="' + _escapeAttr(name) + '">' + _escapeHtml(name || '(unnamed)') + '</span>' +
                '<span style="width:44px;text-align:right;color:var(--bs-gray-500);">' + np + ' pts</span>' +
                '<div class="btn-group btn-group-sm" style="margin-left:6px;">' +
                '<button class="btn btn-outline-secondary mapedit-path-vis" data-n="' + _escapeAttr(name) + '" type="button" title="Show / hide this path" style="opacity:' + (hidden ? '0.5' : '1') + ';">' + (hidden ? '🚫' : '👁') + '</button>' +
                '<button class="btn btn-outline-info mapedit-path-edit" data-n="' + _escapeAttr(name) + '" type="button">Edit</button>' +
                '<button class="btn btn-outline-danger mapedit-path-del" data-n="' + _escapeAttr(name) + '" type="button">Delete</button>' +
                '</div></div>';
        }
        pl.innerHTML = html;
        // visibility toggle
        pl.querySelectorAll('.mapedit-path-vis').forEach(function (b) {
            b.addEventListener('click', function () {
                var n = b.getAttribute('data-n');
                if (!_mapObjLayer) return;
                _mapObjLayer.setPathHidden(n, !_mapObjLayer.isPathHidden(n));
                _renderPathList();   // refresh icon/dimmed state
            });
        });
        // edit -> pre-seed the path tool
        pl.querySelectorAll('.mapedit-path-edit').forEach(function (b) {
            b.addEventListener('click', function () {
                var n = b.getAttribute('data-n');
                var pth = _findPath(n);
                if (pth) _editPath(pth);
            });
        });
        // delete -> double-click confirm
        pl.querySelectorAll('.mapedit-path-del').forEach(function (b) {
            var n = b.getAttribute('data-n');
            _wireRowDelete(b, n, function () {
                _removePath(n);
                _setHint('Deleted path "' + n + '".');
            });
        });
    }
    function _findPath(name) {
        var paths = (_mapObjLayer && _mapObjLayer.paths) ? _mapObjLayer.paths : [];
        for (var i = 0; i < paths.length; i++) if ((paths[i].name || '') === name) return paths[i];
        return null;
    }

    // ---- waypoint placement: floating name + yaw slider (simpler than a drag
    //      gesture; yaw chosen from a 0..359° slider) ----
    function _onWaypointClick(world, clientX, clientY) {
        // A move is already armed (from the list, or a prior dot-select): this
        // click sets the NEW pose for that waypoint.
        if (_pendingMoveName) {
            var mv = _pendingMoveName;
            _showWpInput(mv, true, function (finalName, yawDeg) {
                var yaw = (yawDeg || 0) * Math.PI / 180;
                _publishWaypointAt(finalName, world.x, world.y, yaw);
                _pendingMoveName = null;
                _setHint('Moved waypoint "' + finalName + '".');
            }, world, _wpYawDeg(mv));
            return;
        }
        // V3: clicking ON an existing waypoint dot selects it for Move / Delete
        // (we now have real coordinates from /navi_manager/map_objects).
        if (_mapObjLayer) {
            var tol = _ov.worldTol ? _ov.worldTol(16) : 0.4;
            var hit = _mapObjLayer.hitTestWaypoint(world, tol);
            if (hit) { _selectWaypoint(hit); return; }
        }
        // Otherwise place a NEW waypoint at the clicked spot.
        var name = 'wp_' + _wpN;
        _showWpInput(name, false, function (finalName, yawDeg) {
            var yaw = (yawDeg || 0) * Math.PI / 180;
            _publishWaypointAt(finalName, world.x, world.y, yaw);
            _wpN++;
            _setHint('Saved waypoint "' + finalName + '".');
        }, world, 0);
    }

    // V3: a dot-selected waypoint — offer Move (click the map) / Delete, and keep
    // the Waypoints list flow untouched.
    function _selectWaypoint(wp) {
        _pendingMoveName = wp.name;
        var host = document.getElementById('mapedit_wp_form');
        if (host) {
            host.innerHTML =
                '<div style="border-top:1px dashed var(--bs-secondary);padding-top:8px;">' +
                '<div style="font-size:12px;margin-bottom:6px;">Selected waypoint: <b class="text-info">' + _escapeHtml(wp.name) + '</b></div>' +
                '<div class="d-flex" style="gap:6px;">' +
                '  <button class="btn btn-outline-danger btn-sm flex-fill" id="mapedit_wp_sel_del" type="button">Delete</button>' +
                '  <button class="btn btn-warning btn-sm flex-fill" id="mapedit_wp_sel_cancel" type="button">Cancel</button>' +
                '</div></div>';
            host.querySelector('#mapedit_wp_sel_del').addEventListener('click', function () {
                if (_pub_wp_remove) _pub_wp_remove.publish(new ROSLIB.Message({ data: wp.name }));
                _pendingMoveName = null; _hideWpInput();
                _setHint('Deleted waypoint "' + wp.name + '".');
            });
            host.querySelector('#mapedit_wp_sel_cancel').addEventListener('click', function () {
                _pendingMoveName = null; _hideWpInput();
            });
        }
        _setHint('Waypoint "' + wp.name + '" selected — click the map to move it, or use Delete.');
    }

    function _publishWaypointAt(name, x, y, yaw) {
        if (!_pub_wp_at) return;
        _pub_wp_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: name, x: x, y: y, yaw: yaw }) }));
    }

    var _wpInput = null;
    // Waypoint name + heading form. Renders INTO the KONTEXT box (#mapedit_wp_form)
    // instead of a floating popup, so all controls stay inside the panel.
    // ---- yaw preview arrow (2026-08-16, user request): a live orange arrow
    // at the waypoint position that rotates with the Heading controls, so the
    // rotation is VISIBLE on the map and can be set precisely. ----
    var _yawPreview = null;
    function _showYawPreview(x, y, yawRad) {
        _hideYawPreview();
        if (!_mapObjLayer || !_mapObjLayer.wpGroup) return;
        var L = 0.9, ah = 0.26;
        var hx = Math.cos(yawRad), hy = Math.sin(yawRad);
        var tipx = x + hx * L, tipy = y + hy * L;
        var a1 = yawRad + Math.PI * 0.82, a2 = yawRad - Math.PI * 0.82;
        var g = new T.Group();
        var mat = new T.LineBasicMaterial({ color: 0xffb400, depthTest: false });
        var sg = new T.BufferGeometry();
        sg.setAttribute('position', new T.Float32BufferAttribute(
            [x, y, 0, tipx, tipy, 0,
             tipx, tipy, 0, tipx + Math.cos(a1) * ah, tipy + Math.sin(a1) * ah, 0,
             tipx, tipy, 0, tipx + Math.cos(a2) * ah, tipy + Math.sin(a2) * ah, 0], 3));
        var seg = new T.LineSegments(sg, mat);
        seg.renderOrder = 60;
        g.add(seg);
        g.position.z = 0.16;
        _mapObjLayer.wpGroup.add(g);
        _yawPreview = g;
        if (_mapObjLayer.overlay) _mapObjLayer.overlay.markDirty();
    }
    function _hideYawPreview() {
        if (_yawPreview && _yawPreview.parent) _yawPreview.parent.remove(_yawPreview);
        _yawPreview = null;
        if (_mapObjLayer && _mapObjLayer.overlay) _mapObjLayer.overlay.markDirty();
    }
    // current yaw (deg) of a known waypoint — so Move PREFILLS the existing
    // heading instead of silently resetting it to 0 (old behaviour).
    function _wpYawDeg(name) {
        if (_mapObjLayer) {
            for (var i = 0; i < _mapObjLayer.waypoints.length; i++) {
                var w = _mapObjLayer.waypoints[i];
                if (w.name === name && typeof w.yaw === 'number') {
                    var d = w.yaw * 180 / Math.PI;
                    return ((d % 360) + 360) % 360;
                }
            }
        }
        return 0;
    }

    function _showWpInput(name, lockName, onSave, pos, initYawDeg) {
        _hideWpInput();
        var host = document.getElementById('mapedit_wp_form');
        if (!host) return;
        var y0 = (typeof initYawDeg === 'number' && isFinite(initYawDeg))
            ? Math.round(initYawDeg * 2) / 2 : 0;
        host.innerHTML =
            '<div style="border-top:1px dashed var(--bs-secondary);padding-top:8px;">' +
            '<div style="font-size:12px;margin-bottom:2px;">Waypoint name</div>' +
            '<input class="form-control form-control-sm" id="mapedit_wp_name" type="text" value="' + _escapeAttr(name) + '"' + (lockName ? ' readonly' : '') + '>' +
            '<div style="font-size:12px;margin:8px 0 2px;display:flex;align-items:center;gap:6px;">Heading' +
            ' <input id="mapedit_wp_yawn" class="form-control form-control-sm" type="number" min="0" max="359.5" step="0.5" value="' + y0 + '" style="width:78px;padding:1px 6px;">°' +
            ' <span style="opacity:.65;font-size:11px;">(arrow on the map)</span></div>' +
            '<input id="mapedit_wp_yaw" type="range" min="0" max="359.5" step="0.5" value="' + y0 + '" style="width:100%;">' +
            '<div class="d-flex" style="gap:6px;margin-top:8px;">' +
            '  <button class="btn btn-success btn-sm flex-fill" id="mapedit_wp_save" type="button">Save</button>' +
            '  <button class="btn btn-warning btn-sm flex-fill" id="mapedit_wp_cancel" type="button">Cancel</button>' +
            '</div></div>';
        _wpInput = host;
        var yaw = host.querySelector('#mapedit_wp_yaw');
        var yawn = host.querySelector('#mapedit_wp_yawn');
        function refresh(fromNumber) {
            var v = parseFloat(fromNumber ? yawn.value : yaw.value);
            if (!isFinite(v)) v = 0;
            v = ((v % 360) + 360) % 360;
            if (fromNumber) yaw.value = v; else yawn.value = v;
            if (pos) _showYawPreview(pos.x, pos.y, v * Math.PI / 180);
        }
        yaw.addEventListener('input', function () { refresh(false); });
        yawn.addEventListener('input', function () { refresh(true); });
        if (pos) _showYawPreview(pos.x, pos.y, y0 * Math.PI / 180);
        host.querySelector('#mapedit_wp_save').addEventListener('click', function () {
            var nm = (host.querySelector('#mapedit_wp_name').value || '').trim();
            if (!nm) { host.querySelector('#mapedit_wp_name').focus(); return; }
            var v = parseFloat(yawn.value);
            _hideWpInput();
            onSave(nm, isFinite(v) ? ((v % 360) + 360) % 360 : 0);
        });
        host.querySelector('#mapedit_wp_cancel').addEventListener('click', function () { _hideWpInput(); _pendingMoveName = null; });
        var nmEl = host.querySelector('#mapedit_wp_name');
        if (!lockName) { nmEl.focus(); nmEl.select(); }
    }
    function _hideWpInput() {
        _hideYawPreview();
        var host = document.getElementById('mapedit_wp_form');
        if (host) host.innerHTML = '';
        _wpInput = null;
    }

    // Waypoint list lives in the collapsible "Waypointy" section — always
    // rendered (not gated on the active tool) so it can be browsed/managed any
    // time. "Move" activates the waypoint tool then arms a move.
    function _renderWpList() {
        var wl = document.getElementById('mapedit_wp_list');
        if (!wl) return;
        if (!_wpNames.length) { wl.innerHTML = '<div style="font-size:12px;color:var(--bs-gray-500);">No waypoints yet.</div>'; return; }
        var html = '';
        for (var i = 0; i < _wpNames.length; i++) {
            var n = _wpNames[i];
            html += '<div class="d-flex align-items-center" style="border-bottom:1px solid #3a3f44;padding:4px 2px;font-size:12px;">' +
                '<span class="text-info text-truncate" style="flex:1 1 auto;min-width:0;" title="' + _escapeAttr(n) + '">' + _escapeHtml(n) + '</span>' +
                '<div class="btn-group btn-group-sm" style="margin-left:6px;">' +
                '<button class="btn btn-outline-info mapedit-wp-move" data-n="' + _escapeAttr(n) + '" type="button">Move</button>' +
                '<button class="btn btn-outline-danger mapedit-wp-del" data-n="' + _escapeAttr(n) + '" type="button">Delete</button>' +
                '</div></div>';
        }
        wl.innerHTML = html;
        wl.querySelectorAll('.mapedit-wp-move').forEach(function (b) {
            b.addEventListener('click', function () {
                if (_tool !== 'waypoint') _setTool('waypoint');
                _pendingMoveName = b.getAttribute('data-n');
                _setHint('Click the map to move "' + _pendingMoveName + '" to a new spot.');
            });
        });
        wl.querySelectorAll('.mapedit-wp-del').forEach(function (b) {
            b.addEventListener('click', function () {
                var n = b.getAttribute('data-n');
                if (_pub_wp_remove) _pub_wp_remove.publish(new ROSLIB.Message({ data: n }));
                _setHint('Deleted waypoint "' + n + '".');
            });
        });
    }

    // Edits list lives in the collapsible "Edity mapy" section — per-item delete
    // (publishes remove_edit); Clear-all is the double-click button in the same
    // section. Refreshed whenever the latched edit_list changes (onListChange).
    function _renderEditList() {
        var el = document.getElementById('mapedit_edit_list');
        if (!el) return;
        var edits = (_layer && _layer.edits) ? _layer.edits : [];
        if (!edits.length) { el.innerHTML = '<div style="font-size:12px;color:var(--bs-gray-500);">No edits yet.</div>'; return; }
        var LBL = { obstacle: 'Obstacle (area)', free: 'Free', wall: 'Barrier' };
        var html = '';
        for (var i = 0; i < edits.length; i++) {
            var e = edits[i];
            var kind = LBL[e.kind] || e.kind || '';
            var np = (e.points || []).length;
            html += '<div class="d-flex align-items-center" style="border-bottom:1px solid #3a3f44;padding:4px 2px;font-size:12px;">' +
                '<span class="text-truncate" style="flex:1 1 auto;min-width:0;" title="' + _escapeAttr(e.name || '') + '">' + _escapeHtml(e.name || '(unnamed)') + '</span>' +
                '<span class="text-light" style="width:70px;">' + _escapeHtml(kind) + '</span>' +
                '<span style="width:44px;text-align:right;color:var(--bs-gray-500);">' + np + ' pts</span>' +
                '<button class="btn btn-outline-danger btn-sm mapedit-edit-del" data-n="' + _escapeAttr(e.name || '') + '" type="button" style="margin-left:6px;">Delete</button>' +
                '</div>';
        }
        el.innerHTML = html;
        el.querySelectorAll('.mapedit-edit-del').forEach(function (b) {
            b.addEventListener('click', function () {
                var n = b.getAttribute('data-n');
                if (_layer) _layer.removeEdit(n);
                _setHint('Deleted edit "' + n + '".');
            });
        });
    }

    function _escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function _escapeAttr(s) { return String(s).replace(/["&<>]/g, function (c) { return { '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

    return {
        onEnter: onEnter,
        onExit: onExit,
        setTool: _setTool,
        // exposed for diagnostics/tests
        _layer: function () { return _layer; },
        EditMaskLayer: EditMaskLayer,
    };
})();
