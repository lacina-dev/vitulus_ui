// mapedits.js — WP-D2 interactive map editor tools for vitulus_ui.
//
// Adds, on top of the existing in-view planner editor (mapeditor.js overlay +
// map_edit.js zone/polygon flows), a toolbar in #div_map_detail that drives:
//   - Select            -> pick any visible object on the map or in its list;
//                          the selection card holds its name, shape and delete
//   - Waypoint tool     -> /navi_manager/save_waypoint_at + /remove_point
//   - Obstacle / Free   -> /mapping_manager/save_edit  (polygon draw, reused)
//   - Wall              -> /mapping_manager/save_edit  (polyline draw, width_m)
//   - Delete edit       -> /mapping_manager/remove_edit (click hit-test)
//   - Clear all edits   -> /mapping_manager/remove_edit "*"
//   - Zone              -> map_edit.js zone flow (form, confirmation)
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

    // i18n (docs/I18N.md). Static parts of the panel carry data-i18n (VTI18n
    // re-translates them on a switch by itself); what is drawn from data (the
    // lists, the hint, the geofence readout) is re-drawn in _onLang below.
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tn(k, n, v) { return window.VTI18n ? VTI18n.tn(k, n, v) : k; }
    function _tag(el, k) { if (!el) return; if (window.VTI18n) VTI18n.tag(el, k); else el.textContent = k; }
    // an element whose whole text is one key: ' data-i18n="k">Text'
    function _ti(k) { return ' data-i18n="' + k + '">' + _escapeHtml(t(k)); }

    function EDITS_ORDER() {
        return (window.MapLayerOrder && typeof window.MapLayerOrder.EDITS === 'number')
            ? window.MapLayerOrder.EDITS : 15;
    }
    function rosOf() { return (window.ros && window.ros.ros) || null; }
    function sharedPolygon() { return window.Planner3D && window.Planner3D._lastEditor; }

    // Text in the map: constant size on screen (_rescaleLabels). `extent` (m):
    // the label of an object shows once the object is that big on screen.
    var LABEL_FONT = 40, LABEL_PX = 13 / LABEL_FONT, LABEL_MIN_PX = 48;
    function _makeLabel(text, x, y, order, color, extent) {
        try {
            var cv = document.createElement('canvas');
            var ctx = cv.getContext('2d');
            ctx.font = LABEL_FONT + 'px sans-serif';
            var w = Math.max(8, ctx.measureText(text).width);
            cv.width = w + 12; cv.height = LABEL_FONT + 12;
            ctx = cv.getContext('2d');
            ctx.font = LABEL_FONT + 'px sans-serif'; ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cv.width, cv.height);
            ctx.fillStyle = color; ctx.fillText(text, 6, 6);
            var tex = new T.CanvasTexture(cv);
            tex.needsUpdate = true;
            var mat = new T.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
            var spr = new T.Sprite(mat);
            spr.userData.label = { w: cv.width, h: cv.height, x: x, y: y, extent: extent || 0 };
            spr.renderOrder = order;
            return spr;
        } catch (e) { return null; }
    }
    function _disposeTree(o) {
        for (var i = o.children.length - 1; i >= 0; i--) _disposeTree(o.children[i]);
        o.children.length = 0;
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    }
    function _bbox(pts) {
        var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        for (var i = 0; i < pts.length; i++) {
            b.minX = Math.min(b.minX, pts[i][0]); b.maxX = Math.max(b.maxX, pts[i][0]);
            b.minY = Math.min(b.minY, pts[i][1]); b.maxY = Math.max(b.maxY, pts[i][1]);
        }
        return b;
    }
    function _center(pts) { var b = _bbox(pts); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; }
    function _extent(pts) { var b = _bbox(pts); return Math.hypot(b.maxX - b.minX, b.maxY - b.minY); }

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
            _disposeTree(this.group);
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
                if (pts.length && e.name) {
                    var c = _center(pts);
                    var lb = _makeLabel(e.name, c[0], c[1], order + 3, '#ffffff', _extent(pts));
                    if (lb) this.group.add(lb);
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
    var _wpNames = [];       // known waypoint names (from map_point_str_list)
    var _renaming = null;    // {kind, from, to, row, redraw, timer}: the name being changed
    var _renameTopics = {};  // kind -> rename publisher
    var _renameResult = null;

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
    var WP_R = 0.22, WP_MIN_PX = 8;   // waypoint dot: metres, least radius on screen
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

            this.COL_WP = new T.Color('#1030d8');   // 2026-08-16: dark blue (user request)
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

        _clearGroup(g) { _disposeTree(g); }
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
                var mid = pts[Math.floor(pts.length / 2)];
                var plb = _makeLabel(this.paths[p].name || '', mid[0], mid[1], order + 3, '#00d0a0', _extent(pts));
                if (plb) this.pathGroup.add(plb);
            }
            // waypoints — dot + heading arrow + text label, one group each so
            // the size can follow the zoom (_rescaleLabels)
            for (var i = 0; i < this.waypoints.length; i++) {
                var w = this.waypoints[i];
                var r = WP_R;
                var g = new T.Group();
                g.position.set(w.x, w.y, 0);
                g.userData.wp = true;
                // dark-blue dot + thin white halo so it pops on aerial imagery
                // AND on the dark background
                var dot = new T.Mesh(new T.CircleGeometry(r, 20),
                    new T.MeshBasicMaterial({ color: this.COL_WP, depthTest: false, depthWrite: false }));
                dot.renderOrder = order + 1;
                g.add(dot);
                var halo = new T.Mesh(new T.RingGeometry(r, r * 1.28, 24),
                    new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }));
                halo.renderOrder = order + 1;
                g.add(halo);
                if (typeof w.yaw === 'number') {
                    // an arrow with a head: the stored heading must be readable
                    var hL = r * 2.6, hA = r * 0.9;
                    var hx = Math.cos(w.yaw) * hL, hy = Math.sin(w.yaw) * hL;
                    var b1 = w.yaw + Math.PI * 0.82, b2 = w.yaw - Math.PI * 0.82;
                    var hg = new T.BufferGeometry();
                    hg.setAttribute('position', new T.Float32BufferAttribute([
                        0, 0, 0, hx, hy, 0,
                        hx, hy, 0, hx + Math.cos(b1) * hA, hy + Math.sin(b1) * hA, 0,
                        hx, hy, 0, hx + Math.cos(b2) * hA, hy + Math.sin(b2) * hA, 0], 3));
                    var hl = new T.LineSegments(hg, new T.LineBasicMaterial({ color: this.COL_WP, depthTest: false }));
                    hl.renderOrder = order + 1;
                    g.add(hl);
                }
                this.wpGroup.add(g);
                var label = _makeLabel(w.name || '', w.x, w.y, order + 2, '#7f9dff', 0);
                if (label) { label.userData.label.beside = true; this.wpGroup.add(label); }
            }
            if (this.overlay) this.overlay.markDirty();
        }
        destroy() {
            try { this.sub.unsubscribe(); } catch (e) {}
            try { this._clearGroup(this.wpGroup); if (this.wpGroup.parent) this.wpGroup.parent.remove(this.wpGroup); } catch (e) {}
            try { this._clearGroup(this.pathGroup); if (this.pathGroup.parent) this.pathGroup.parent.remove(this.pathGroup); } catch (e) {}
        }
    }

    // =====================================================================
    // Zones: outlines + names from /web_plan/zone_list (map_edit.js owns the
    // subscription, window.mapEditZoneApi hands the list over). The "Zones" chip
    // shows and hides this layer.
    // =====================================================================
    class ZoneLayer {
        constructor(overlay) {
            this.overlay = overlay;
            this.zones = [];                 // [{name, points:[[x,y]...], area}]
            this.group = new T.Group();
            this.group.position.z = 0.06;    // under the edits: zones are the bigger areas
            overlay.overlayGroup.add(this.group);
            this.COL = new T.Color('#0dcaf0');
        }
        set(zones) {
            this.zones = zones;
            _disposeTree(this.group);
            var order = EDITS_ORDER() - 1;
            for (var i = 0; i < zones.length; i++) {
                var pts = zones[i].points;
                if (pts.length < 3) continue;
                var shape = new T.Shape();
                shape.moveTo(pts[0][0], pts[0][1]);
                for (var k = 1; k < pts.length; k++) shape.lineTo(pts[k][0], pts[k][1]);
                shape.closePath();
                var fill = new T.Mesh(new T.ShapeGeometry(shape),
                    new T.MeshBasicMaterial({ color: this.COL, transparent: true, opacity: 0.14, side: T.DoubleSide, depthTest: false, depthWrite: false }));
                fill.renderOrder = order;
                this.group.add(fill);
                var seg = [];
                for (var e = 0; e < pts.length; e++) {
                    var a = pts[e], b = pts[(e + 1) % pts.length];
                    seg.push(a[0], a[1], 0, b[0], b[1], 0);
                }
                var lg = new T.BufferGeometry();
                lg.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
                var line = new T.LineSegments(lg, new T.LineBasicMaterial({ color: this.COL, depthTest: false }));
                line.renderOrder = order + 0.1;
                this.group.add(line);
                var c = _center(pts);
                var lb = _makeLabel(zones[i].name, c[0], c[1], EDITS_ORDER() + 3, '#6fe3ff', _extent(pts));
                if (lb) this.group.add(lb);
            }
            _rescaleLabels(true);
        }
    }
    var _zoneLayer = null;

    // Constant size on screen for what lives in map metres. Runs each overlay
    // frame, does its work only when the zoom changed.
    var _lastPxm = 0;
    function _rescaleLabels(force) {
        if (!_ov) return;
        var pxm = _ov.pxPerM();
        if (!force && Math.abs(pxm - _lastPxm) < _lastPxm * 0.004) return;
        _lastPxm = pxm;
        var groups = [_layer && _layer.group, _zoneLayer && _zoneLayer.group,
                      _mapObjLayer && _mapObjLayer.wpGroup, _mapObjLayer && _mapObjLayer.pathGroup];
        var wpScale = Math.max(1, WP_MIN_PX / (WP_R * pxm));
        groups.forEach(function (g) {
            if (!g) return;
            g.children.forEach(function (o) {
                if (o.userData.wp) { o.scale.set(wpScale, wpScale, 1); return; }
                var l = o.userData.label;
                if (!l) return;
                var sw = l.w * LABEL_PX / pxm, sh = l.h * LABEL_PX / pxm;
                o.scale.set(sw, sh, 1);
                if (l.beside) {
                    var off = WP_R * 1.6 * wpScale;
                    o.position.set(l.x + off + sw / 2, l.y + off, 0);
                } else {
                    o.position.set(l.x, l.y, 0);
                }
                o.visible = !l.extent || l.extent * pxm >= LABEL_MIN_PX;
            });
        });
        var P = sharedPolygon();
        if (P && P.attached) P._updateVertexScale();
    }

    // ---- public lifecycle (called from mapeditor.js Controller) ----
    function onEnter(overlay) {
        _ov = overlay;
        overlay.onFrame = function () { _rescaleLabels(false); };
        var ros = rosOf();
        if (!ros) { console.warn('[mapedits] no ros connection yet'); }
        if (ros && !_layer) {
            _layer = new EditMaskLayer(ros, overlay);
            _layer.onListChange = function () { _renderEditList(); _onData(); };
        } else if (_layer) {
            // overlay may have been rebuilt — re-attach the render group
            try { if (_layer.group.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_layer.group); } catch (e) {}
        }
        // V3: map-objects overlay (waypoint dots + path polylines).
        if (ros && !_mapObjLayer) {
            _mapObjLayer = new MapObjectsLayer(ros, overlay);
            _mapObjLayer.onChange = function () { _renderPathList(); _renderWpList(); _onData(); };
        } else if (_mapObjLayer) {
            try {
                if (_mapObjLayer.wpGroup.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_mapObjLayer.wpGroup);
                if (_mapObjLayer.pathGroup.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_mapObjLayer.pathGroup);
            } catch (e) {}
        }
        if (!_zoneLayer) _zoneLayer = new ZoneLayer(overlay);
        else if (_zoneLayer.group.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_zoneLayer.group);
        if (ros) {
            _ensureWpTopics(ros);
            // advertised up front: a publish right after advertise can be lost
            Object.keys(RENAME_TOPIC).forEach(_renameTopic);
        }
        _loadShow();
        _buildToolbar();
        _zoneData();
        _renderEditList();
        _renderWpList();
        _renderPathList();
        _applyAllShow();
        _setTool('off');
        _rescaleLabels(true);
    }
    function onExit() {
        _teardownTool();
        _deselect();
        _tool = 'off';
        _setToolButtonsActive('off');
        _hideWpInput();
        _compact(false);
        // V3: the Zones chip toggles LIVE-scene program/zone markers; restore them
        // so closing the editor never leaves the normal map view with zones hidden.
        // (The overlay layers live under overlayGroup, which the overlay hides
        // on exitTopDown, so they need no explicit restore.)
        _applyZonesVisible(true);
    }

    // ---- toolbar UI ----
    function _panel() { return document.getElementById('div_map_detail'); }

    // TOOLS: 4-per-row icon grid. Each entry: state machine tool id + emoji +
    // label + idle bootstrap variant (swapped to solid btn-primary when
    // active). 'off' == select: tap an object, drag and pinch move the map.
    // V4: UI labels clarified. The backend edit "kind" values stay
    // obstacle/free/wall (see _finishEditsDraw) for backend compat — only the
    // visible label/hint text changes here. V2 adds the 'path' tool (manual path
    // drawing that lands in the same collection as robot-recorded paths).
    // P5: icons from the app's icon font (line-awesome) instead of emoji; the
    // tile colour lives in CSS (index.html "tool grid") keyed on data-tool, the
    // `idle` class stays for the active/idle swap below.
    var TOOLS = [
        { tool: 'off',           ico: '<i class="la la-mouse-pointer"></i>', label: 'medits.tool.select',           idle: 'btn-outline-light' },
        { tool: 'waypoint',      ico: '<i class="la la-map-marker"></i>',   label: 'medits.tool.waypoint',          idle: 'btn-outline-info' },
        { tool: 'path',          ico: '<i class="la la-road"></i>',         label: 'medits.tool.path',              idle: 'btn-outline-primary' },
        { tool: 'zone',          ico: '<i class="la la-object-group"></i>', label: 'medits.tool.zone',              idle: 'btn-outline-info' },
        { tool: 'edit_obstacle', ico: '<i class="la la-square"></i>',       label: 'medits.tool.obstacle',   idle: 'btn-outline-danger' },
        { tool: 'edit_free',     ico: '<i class="la la-square-o"></i>',     label: 'medits.tool.free', idle: 'btn-outline-success' },
        { tool: 'edit_wall',     ico: '<i class="la la-minus"></i>',        label: 'medits.tool.wall',    idle: 'btn-outline-warning' },
        { tool: 'edit_delete',   ico: '<i class="la la-trash"></i>',        label: 'medits.tool.delete',            idle: 'btn-outline-secondary' },
        { tool: 'geofence',      ico: '<i class="la la-shield"></i>',       label: 'medits.tool.geofence',          idle: 'btn-outline-warning' },
    ];

    // =====================================================================
    // GEOFENCE tool — click the test perimeter instead of driving it.
    //
    // Everything else in this file writes straight to the robot (save_edit,
    // save_waypoint_at, save_path_at). This one deliberately does NOT arm a
    // fence: the geofence is the boundary the test supervisor stops the robot
    // at, and it may only become ACTIVE with the owner's signature
    // (vitulus_claude AGENT.md §11.1). So Finish POSTs the clicked ring to the
    // robot's OWN web node, same-origin (`/api/geofence/propose` on :7779 — no
    // agent needed), which converts map metres -> UTM33 via the site datum,
    // refuses any ring whose vertices or EDGES cross unmapped cells, and writes
    // an UNSIGNED *proposal* file. Turning that proposal into the live fence is
    // a separate, human-only CLI step (`tools/geofence_propose sign
    // --digest <digest>`, or `/geofence podepsat <digest>` in the agent chat) —
    // nothing this page can do arms a fence.
    //
    // The frame text goes through VTI18n (en / cs); a refusal reason from the
    // propose API is data and is shown verbatim inside it.
    var _gfTimer = null;
    var _gfLast = null;         // last submitted ring (for the JSON export)

    // Served site name, taken from the header the mapping status handler already
    // fills ("site / raster") — no new subscription for one string.
    function _servedSite() {
        var el = document.getElementById('map_detail_site');
        var text = (el && el.textContent || '').trim();
        if (!text || text === '—') return '';
        return text.split('/')[0].trim();
    }

    // Shared-polygon vertices as ROS/map metres. PolygonEditor stores y negated
    // (easeljs screen convention), same as _finishEditsDraw does.
    function _gfPoints() {
        var P = sharedPolygon();
        if (!P || !P.pointContainer) return [];
        var ch = P.pointContainer.children || [], pts = [];
        for (var i = 0; i < ch.length; i++) pts.push([ch[i].x, -ch[i].y]);
        return pts;
    }
    function _gfArea(pts) {
        if (pts.length < 3) return 0;
        var total = 0;
        for (var i = 0; i < pts.length; i++) {
            var a = pts[i], b = pts[(i + 1) % pts.length];
            total += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(total / 2);
    }
    function _gfPerimeter(pts) {
        if (pts.length < 2) return 0;
        var total = 0;
        for (var i = 0; i < pts.length; i++) {
            var a = pts[i], b = pts[(i + 1) % pts.length];
            total += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        return total;
    }

    // Live readout while clicking. The preview polygon itself is drawn by the
    // shared PolygonEditor (same as zones/obstacles); this only reports it, on a
    // slow poll rather than a hook, because vertices arrive from three different
    // gestures (click, drag, delete) and one timer covers all of them.
    function _gfTick() {
        var out = document.getElementById('mapedit_gf_live');
        if (!out) return;
        var pts = _gfPoints();
        var area = _gfArea(pts);
        out.innerHTML = pts.length < 3
            ? '<span class="vt-muted">' + _escapeHtml(tn('medits.gf.few_points', pts.length)) + '</span>'
            : ('<b class="text-info">' + _escapeHtml(tn('medits.gf.vertices', pts.length)) + '</b> · <b class="text-info">' +
               area.toFixed(1) + ' m²</b> · ' + _escapeHtml(t('medits.gf.perimeter', { m: _gfPerimeter(pts).toFixed(1) })) +
               (area < 4 ? ' <span class="text-danger">· ' + _escapeHtml(t('medits.gf.below_min')) + '</span>' : ''));
    }
    function _gfStartTicker() { if (!_gfTimer) _gfTimer = setInterval(_gfTick, 250); }
    function _gfStopTicker() { if (_gfTimer) { clearInterval(_gfTimer); _gfTimer = null; } }

    // html: a string, or a function building it (re-run on a language switch)
    var _gfSaid = null;
    function _gfSay(html, cls) {
        _gfSaid = (typeof html === 'function') ? { fn: html, cls: cls } : null;
        var box = document.getElementById('mapedit_gf_out');
        if (box) box.innerHTML = '<div class="' + (cls || '') + ' vt-fs-sm vt-pre">' +
            (typeof html === 'function' ? html() : html) + '</div>';
    }

    function _finishGeofenceDraw() {
        var pts = _gfPoints();
        if (pts.length < 3) { _setHint('medits.gf.need3'); return; }
        var site = (document.getElementById('mapedit_gf_site') || {}).value || '';
        site = site.trim();
        if (!site) { _gfSay(function () { return _escapeHtml(t('medits.gf.no_site')); }, 'text-danger'); return; }
        var by = ((document.getElementById('mapedit_gf_by') || {}).value || '').trim();
        _gfLast = { site: site, points: pts, clicked_by: by || null };
        var nSent = pts.length;
        _gfSay(function () { return _escapeHtml(tn('medits.gf.sending', nSent)); });
        // Same-origin: the robot's own web node (:7779) serves this. No agent.
        fetch('/api/geofence/propose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_gfLast),
        }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || d.ok !== true) {
                var why = (d && (d.error || d.detail)) || null;
                _gfSay(function () {
                    return '<b class="text-danger">' + _escapeHtml(t('medits.gf.rejected')) + '</b>\n' +
                       _escapeHtml(why || t('medits.gf.unknown_error')) +
                       '\n\n' + _escapeHtml(t('medits.gf.rejected_hint'));
                });
                return;
            }
            _gfSay(function () {
                return '<b class="text-success">' + _escapeHtml(t('medits.gf.saved')) + '</b> ' +
                   _escapeHtml(t('medits.gf.not_active')) + '\n' +
                   _escapeHtml(d.summary) + '\ndigest: <b>' + _escapeHtml(d.digest) + '</b>\n' +
                   _escapeHtml(d.path) + '\n\n' +
                   _escapeHtml(t('medits.gf.sign_cli')) + '\n' +
                   '<code>' + _escapeHtml(d.sign_hint) + '</code>\n' +
                   t('medits.gf.sign_chat', { cmd: '<code>/geofence podepsat ' + _escapeHtml(d.digest) + '</code>' });
            });
        }).catch(function (err) {
            _gfSay(function () {
                return '<b class="text-danger">' + _escapeHtml(t('medits.gf.no_answer')) + '</b>\n' + _escapeHtml(String(err)) +
                   '\n' + _escapeHtml(t('medits.gf.no_answer_hint', { btn: t('medits.gf.download') }));
            });
        });
    }

    // Offline cesta: stáhni naklikané body jako JSON. Existuje schválně —
    // návrh plotu nesmí záviset na tom, že zrovna běží agent.
    function _gfExport() {
        var pts = _gfPoints();
        if (pts.length < 3) { _gfSay(function () { return _escapeHtml(t('medits.gf.click3')); }, 'text-danger'); return; }
        var site = ((document.getElementById('mapedit_gf_site') || {}).value || '').trim();
        var by = ((document.getElementById('mapedit_gf_by') || {}).value || '').trim();
        var blob = new Blob([JSON.stringify({
            site: site, frame: 'map', clicked_by: by || null, points: pts,
        }, null, 1)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'geofence_points' + (site ? '_' + site : '') + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        var nDl = pts.length;
        _gfSay(function () {
            return _escapeHtml(tn('medits.gf.downloaded', nDl)) + '\n' +
               _escapeHtml(t('medits.gf.next')) + '  tools/geofence_propose propose --site ' +
               _escapeHtml(site || '<site>') + ' --points <file>';
        });
    }

    function _buildToolbar() {
        if (_built) { _refreshDisabled(); return; }
        var tools = document.getElementById('mapedit_tools');
        var ctx = document.getElementById('mapedit_context');
        if (!tools || !ctx) { _built = false; return; }   // panel not (yet) redesigned

        // B. TOOLS — icon grid.
        var gh = '<div class="text-uppercase fw-bold vt-fs-xs vt-ls vt-muted vt-mb2"' + _ti('medits.tools') + '</div><div class="met-grid">';
        for (var i = 0; i < TOOLS.length; i++) {
            var tl = TOOLS[i];
            gh += '<button type="button" class="btn met-tool ' + tl.idle + '" data-tool="' + tl.tool + '" data-idle="' + tl.idle + '">' +
                  '<span class="met-ico">' + tl.ico + '</span><span' + _ti(tl.label) + '</span></button>';
        }
        gh += '</div>';
        // V3: "Show:" row of toggle chips for the editor overlay groups.
        gh += _showRowHtml();
        tools.innerHTML = gh;

        // C. ACTIVE TOOL CONTEXT — one box showing only what the tool needs.
        ctx.innerHTML =
            '<div class="text-uppercase fw-bold vt-fs-xs vt-ls vt-muted vt-mb1"' + _ti('medits.tool_context') + '</div>' +
            '<div class="vt-box mapedit-ctx-box">' +
            '  <button class="btn btn-outline-secondary" id="mapedit_expand" type="button" data-i18n-title="medits.expand" data-i18n-aria-label="medits.expand" title="' + _escapeAttr(t('medits.expand')) + '" aria-label="' + _escapeAttr(t('medits.expand')) + '"><i class="la la-angle-up"></i></button>' +
            '  <div id="mapedit_sel"></div>' +
            '  <div id="mapedit_zone_slot"></div>' +
            '  <div id="mapedit_hint" class="vt-fs-sm vt-accent vt-minh-line"></div>' +
            '  <div id="mapedit_edit_name_wrap" class="vt-mt2" style="display: none;">' +
            '    <span class="vt-fs-sm vt-block vt-mb1"' + _ti('common.name') + '</span>' +
            '    <input class="form-control form-control-sm vt-w-lg" id="mapedit_edit_name" type="text" maxlength="60" value="">' +
            '  </div>' +
            '  <div id="mapedit_wall_wrap" class="vt-mt2" style="display: none;">' +
            '    <span class="vt-fs-sm vt-block vt-mb1"' + _ti('medits.wall_width') + '</span>' +
            '    <div class="input-group input-group-sm vt-w-md"><input class="form-control" id="mapedit_wall_w" type="number" min="0.02" max="2" step="0.05" value="0.10"><span class="input-group-text">m</span></div>' +
            '  </div>' +
            '  <div id="mapedit_path_wrap" class="vt-mt2" style="display: none;">' +
            '    <span class="vt-fs-sm vt-block vt-mb1"' + _ti('medits.path_name') + '</span>' +
            '    <input class="form-control form-control-sm vt-w-lg" id="mapedit_path_name" type="text" maxlength="60" value="">' +
            '  </div>' +
            '  <div id="mapedit_gf_wrap" class="vt-mt2" style="display: none;">' +
            '    <div id="mapedit_gf_live" class="vt-fs-sm vt-mb2"></div>' +
            '    <div class="d-flex vt-gap6 vt-mb2">' +
            '      <div class="vt-grow1 vt-min0"><span class="vt-fs-sm vt-block vt-mb1"' + _ti('medits.gf.site') + '</span>' +
            '        <input class="form-control form-control-sm" id="mapedit_gf_site" type="text" data-i18n-placeholder="medits.gf.site_ph" placeholder="' + _escapeAttr(t('medits.gf.site_ph')) + '"></div>' +
            '      <div class="vt-grow1 vt-min0"><span class="vt-fs-sm vt-block vt-mb1"' + _ti('medits.gf.by') + '</span>' +
            '        <input class="form-control form-control-sm" id="mapedit_gf_by" type="text" data-i18n-placeholder="medits.gf.by_ph" placeholder="' + _escapeAttr(t('medits.gf.by_ph')) + '"></div>' +
            '    </div>' +
            '    <button class="btn btn-outline-info btn-sm vt-w100" id="mapedit_gf_export" type="button"' + _ti('medits.gf.download') + '</button>' +
            '    <div id="mapedit_gf_out" class="vt-mt2"></div>' +
            '  </div>' +
            '  <div id="mapedit_wp_form" class="vt-mt2"></div>' +
            '  <div class="mapedit-acts"><div id="mapedit_shape_tools" class="d-flex vt-gap6 vt-mt2" style="display: none !important;">' +
            '    <button class="btn btn-outline-info btn-sm flex-fill" id="mapedit_undo" type="button"><i class="la la-undo"></i> <span' + _ti('medits.undo') + '</span></button>' +
            '    <button class="btn btn-outline-danger btn-sm flex-fill" id="mapedit_del_vertex" type="button"' + _ti('medits.delete_point') + '</button>' +
            '  </div>' +
            '  <div id="mapedit_ctx_actions" class="d-flex vt-gap6 vt-mt2">' +
            '    <button class="btn btn-success btn-sm flex-fill" id="mapedit_finish" type="button" style="display: none;"' + _ti('medits.finish') + '</button>' +
            '    <button class="btn btn-warning btn-sm flex-fill" id="mapedit_cancel" type="button" style="display: none;"' + _ti('common.cancel') + '</button>' +
            '  </div></div>' +
            '</div>';

        // tool buttons
        tools.querySelectorAll('[data-tool]').forEach(function (b) {
            b.addEventListener('click', function () {
                var m = b.getAttribute('data-tool');
                if (_dirty()) { _setHint('medits.sel.save_first'); return; }
                if (m === 'off') { _setTool('off'); return; }
                if (_tool === m) _setTool('off'); else _setTool(m);
            });
        });
        // V3: Show chips.
        _wireShowChips(tools);
        // finish / cancel (edits draw)
        ctx.querySelector('#mapedit_finish').addEventListener('click', _finishEditsDraw);
        ctx.querySelector('#mapedit_cancel').addEventListener('click', function () {
            if (_draft) _revertShape(); else _setTool('off');
        });
        ctx.querySelector('#mapedit_undo').addEventListener('click', function () {
            var P = sharedPolygon(); if (P) P.undo();
        });
        ctx.querySelector('#mapedit_del_vertex').addEventListener('click', _removeSelectedVertex);
        ctx.querySelector('#mapedit_expand').addEventListener('click', function () { _compact(false); });
        // The zone form (fields, save status) lives in the context box too.
        var zoneForm = document.getElementById('div_zone_template');
        if (zoneForm) {
            ctx.querySelector('#mapedit_zone_slot').appendChild(zoneForm);
            zoneForm.addEventListener('input', function () {
                if (_draft && _draft.kind === 'zone') { _draft.formDirty = true; _refreshActions(); }
            });
        }
        // geofence: offline export of the clicked ring
        var gfx = ctx.querySelector('#mapedit_gf_export');
        if (gfx) gfx.addEventListener('click', _gfExport);

        // Edity mapy section: Clear-all (double-click confirm) lives here, not in
        // the tool grid.
        _wireLists();
        document.addEventListener('keydown', _onKey);
        var editctl = document.getElementById('mapedit_editctl');
        if (editctl) {
            editctl.innerHTML = '<button class="btn btn-outline-danger btn-sm" id="mapedit_clear_all" type="button"' + _ti('medits.clear_all') + '</button>';
            _wireClearAll(editctl.querySelector('#mapedit_clear_all'));
        }

        _built = true;
        _refreshDisabled();
    }

    // ---- V3: "Show:" toggle chips ----
    var SHOW_CHIPS = [
        { k: 'waypoints', label: 'medits.show.waypoints' },
        { k: 'paths',     label: 'medits.show.paths' },
        { k: 'edits',     label: 'medits.show.edits' },
        { k: 'zones',     label: 'medits.show.zones' },
    ];
    function _showRowHtml() {
        var h = '<div id="mapedit_show_row" class="vt-flex vt-wrap vt-aic vt-gap6 vt-mt2">' +
                '<span class="vt-fs-xs vt-caps vt-ls vt-muted"' + _ti('medits.show') + '</span>';
        for (var i = 0; i < SHOW_CHIPS.length; i++) {
            var c = SHOW_CHIPS[i];
            var on = _show[c.k] !== false;
            h += '<button type="button" class="btn btn-sm mapedit-show-chip ' + (on ? 'btn-info' : 'btn-outline-secondary') +
                 ' vt-chip-btn" data-show="' + c.k + '"' + _ti(c.label) + '</button>';
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
                b.classList.add('vt-chip-btn');   // size: vt_panel.css
            });
        });
    }
    function _applyAllShow() { for (var k in SHOW_KEYS) _applyShow(k); }
    function _applyShow(k) {
        if (k === 'waypoints') { if (_mapObjLayer) _mapObjLayer.setWaypointsVisible(_show.waypoints); }
        else if (k === 'paths') { if (_mapObjLayer) _mapObjLayer.setPathsVisible(_show.paths); }
        else if (k === 'edits') { if (_layer) { _layer.group.visible = !!_show.edits; if (_ov) _ov.markDirty(); } }
        else if (k === 'zones') {
            _applyZonesVisible(_show.zones);
            if (_zoneLayer) { _zoneLayer.group.visible = !!_show.zones; if (_ov) _ov.markDirty(); }
        }
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

    // Double-click-to-confirm (NEVER window.confirm — it blocks the event loop).
    function _wireClearAll(btn) {
        if (!btn) return;
        var armed = false, timer = null;
        function disarm() { armed = false; _tag(btn, 'medits.clear_all'); btn.classList.remove('btn-danger'); btn.classList.add('btn-outline-danger'); if (timer) { clearTimeout(timer); timer = null; } }
        btn.addEventListener('click', function () {
            if (!armed) {
                armed = true; _tag(btn, 'medits.sure'); btn.classList.remove('btn-outline-danger'); btn.classList.add('btn-danger');
                timer = setTimeout(disarm, 2500);
            } else {
                disarm();
                if (_layer) _layer.clearAll();
                _setHint('medits.hint.cleared');
            }
        });
    }

    // the hint is a key (+ vars, or a function giving them); kept so a
    // language switch can re-draw it
    var _hintK = null, _hintV = null;
    function _setHint(k, v) {
        _hintK = k || null; _hintV = v || null;
        var h = document.getElementById('mapedit_hint');
        if (h) h.textContent = k ? t(k, (typeof v === 'function') ? v() : v) : '';
    }
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
        var gw = document.getElementById('mapedit_gf_wrap');
        if (gw) gw.style.display = (mode === 'geofence') ? '' : 'none';
        var ww = document.getElementById('mapedit_wall_wrap');
        if (ww) ww.style.display = (mode === 'edit_wall') ? '' : 'none';
        var en = document.getElementById('mapedit_edit_name_wrap');
        if (en) en.style.display = EDIT_KIND[mode] ? '' : 'none';
        var pw = document.getElementById('mapedit_path_wrap');
        if (pw) pw.style.display = (mode === 'path') ? '' : 'none';
        _refreshActions();
    }

    function _isDraw(mode) {
        return mode === 'edit_obstacle' || mode === 'edit_free' || mode === 'edit_wall'
            || mode === 'path' || mode === 'geofence' || mode === 'zone';
    }
    // Undo / Delete point / Save or Finish / Cancel: one place for a new shape
    // and for an existing one. Save and Cancel appear with the first change.
    function _refreshActions() {
        var fin = document.getElementById('mapedit_finish'), can = document.getElementById('mapedit_cancel');
        if (!fin || !can) return;
        var draw = _isDraw(_tool), dirty = _dirty(), saving = !!(_draft && _draft.saving);
        fin.style.display = (draw || dirty) ? '' : 'none';
        can.style.display = (draw || dirty) ? '' : 'none';
        fin.disabled = saving;
        can.disabled = saving;
        // Finish means "save" everywhere except the geofence, where it means
        // "send this ring to the agent as a PROPOSAL". Say so on the button, so
        // nobody reads it as "apply the fence".
        _tag(fin, saving ? 'common.saving' : (dirty ? 'common.save'
            : (_tool === 'geofence' ? 'medits.gf.send' : 'medits.finish')));
        var P = sharedPolygon();
        var hasShape = draw || (!!_draft && _draft.kind !== 'waypoint');
        var row = document.getElementById('mapedit_shape_tools');
        if (row) row.style.setProperty('display', hasShape ? 'flex' : 'none', 'important');
        var un = document.getElementById('mapedit_undo'), dv = document.getElementById('mapedit_del_vertex');
        if (un) un.disabled = !(P && P.canUndo());
        if (dv) dv.disabled = !(P && P.selected >= 0 && P.pointContainer.children.length > (P.minPoints || 0));
    }
    function _removeSelectedVertex() {
        var P = sharedPolygon();
        if (P && P.selected >= 0) P.remPoint(P.selected);
    }
    function _onKey(ev) {
        if (!_ov || !_ov.editing) return;
        var el = ev.target, tag = el && el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        var P = sharedPolygon();
        if (!P || !P.attached) return;
        if ((ev.key === 'z' || ev.key === 'Z') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); P.undo(); }
        else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); _removeSelectedVertex(); }
    }

    function _teardownTool() {
        // detach + clear the shared polygon if we were drawing edits
        var P = sharedPolygon();
        if (_tool === 'zone' && window.mapEditZoneApi) window.mapEditZoneApi.close();
        if (P) { P.openLine = false; P.showMids = false; P.minPoints = 0; P.onChange = null; }
        if (P && P.attached && _ov) {
            try { _ov.scene.removeChild(P); } catch (e) {}
            _clearPolygon(P);
        }
        _hideWpInput();
        _gfStopTicker();
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
        _deselect();
        _teardownTool();
        _tool = mode || 'off';
        if (_ov && _ov.setToolMode) _ov.setToolMode(_tool);
        _setToolButtonsActive(_tool);
        if (_tool !== 'off') _compact(true);

        if (_isDraw(_tool)) {
            var P = sharedPolygon();
            if (!P) { _setHint('medits.hint.not_ready'); _setTool('off'); return; }
            _clearPolygon(P);
            // path + barrier are open polylines - no closing edge, no fill
            P.openLine = (_tool === 'path' || _tool === 'edit_wall');
            P.showMids = true;
            P.onChange = _refreshActions;
            if (_tool === 'zone') {
                window.mapEditZoneApi.beginNew();
                _setHint('medits.hint.zone');
            } else {
                try { _ov.scene.addChild(P); } catch (e) {}
            }
            if (_tool === 'zone') {
                // the name and fields are in the zone form
            } else if (_tool === 'geofence') {
                // The geofence reuses the shared closed polygon for the preview,
                // so the ring the owner sees is drawn by the same code as every
                // other polygon in this editor — one drawing surface, no second
                // renderer to fall out of sync with the map.
                var gs = document.getElementById('mapedit_gf_site');
                if (gs && !gs.value.trim()) gs.value = _servedSite();
                _gfSay('');
                _gfTick();
                _gfStartTicker();
                _setHint('medits.hint.geofence');
            } else if (_tool === 'path') {
                var pn = document.getElementById('mapedit_path_name');
                if (pn) pn.value = nextName('path', _names('path'));
                _setHint('medits.hint.path');
            } else {
                var nm = document.getElementById('mapedit_edit_name');
                if (nm) nm.value = nextName(EDIT_KIND[_tool], _names('edit'));
                _setHint(_tool === 'edit_wall'
                    ? 'medits.hint.wall'
                    : (_tool === 'edit_obstacle' ? 'medits.hint.obstacle' : 'medits.hint.free'));
            }
        } else if (_tool === 'waypoint') {
            _renderWpList();
            _setHint('medits.hint.waypoint');
        } else if (_tool === 'edit_delete') {
            _setHint('medits.hint.delete');
        } else {
            _setHint('medits.hint.pick');
        }
        _refreshActions();
    }

    function _finishEditsDraw() {
        if (_draft) { _saveShape(); return; }
        if (_tool === 'zone') {
            var zp = _curPts();
            if (zp.length < 3) { _setHint('medits.hint.need_pts.zone', { n: 3 }); return; }
            if (_crosses(zp)) { _setHint('medits.shape.crosses'); return; }
            window.mapEditZoneApi.save();
            return;
        }
        if (_tool === 'path') { _finishPathDraw(); return; }
        if (_tool === 'geofence') { _finishGeofenceDraw(); return; }
        var P = sharedPolygon();
        if (!P) { _setTool('off'); return; }
        var pts = [];
        var ch = P.pointContainer.children || [];
        for (var i = 0; i < ch.length; i++) pts.push([ch[i].x, -ch[i].y]); // store y=-rosY -> map y
        var kind = EDIT_KIND[_tool];
        var minPts = (kind === 'wall') ? 2 : 3;
        if (pts.length < minPts) { _setHint('medits.hint.need_pts.' + kind, { n: minPts }); return; }
        if (kind !== 'wall' && _crosses(pts)) { _setHint('medits.shape.crosses'); return; }
        var ne = document.getElementById('mapedit_edit_name');
        var name = (ne && ne.value ? ne.value : '').trim() || nextName(kind, _names('edit'));
        var bad = nameProblem(name, _names('edit'));
        if (bad) { _setHint('medits.name.err.' + bad, { name: name }); return; }
        var spec = { kind: kind, points: pts, name: name };
        if (kind === 'wall') {
            var wi = document.getElementById('mapedit_wall_w');
            spec.width_m = wi ? (parseFloat(wi.value) || 0.10) : 0.10;
        }
        if (_layer) _layer.saveEdit(spec);
        _setHint('medits.hint.saved.' + kind, { n: pts.length });
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
        if (pts.length < 2) { _setHint('medits.hint.path_need2'); return; }
        var pn = document.getElementById('mapedit_path_name');
        var name = (pn && pn.value ? pn.value : '').trim() || nextName('path', _names('path'));
        var bad = nameProblem(name, _names('path'));
        if (bad) { _setHint('medits.name.err.' + bad, { name: name }); return; }
        if (!_pub_path_at) { _setHint('medits.hint.path_pub'); return; }
        _pub_path_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: name, points: pts }) }));
        _setHint('medits.hint.path_saved', { name: name, n: pts.length });
        _setTool('off');
    }

    // ---- taps on the map (Planner3D.attachInteraction -> map_edit.js) ----
    // true = handled here; false = the open shape takes it as a new point.
    function onMapTap(world, ev) {
        if (_tool === 'off') { _tapSelect(world, ev); return true; }
        var px = _tapPx(ev);
        if (_tool === 'waypoint') {
            var wp = _mapObjLayer && _mapObjLayer.hitTestWaypoint(world, _ov.worldTol(px));
            if (wp) { _setTool('off'); _select('waypoint', wp.name); }
            else _newWaypoint(world);
            return true;
        }
        if (_tool === 'edit_delete') { _onDeleteClick(world); return true; }
        if (_tool === 'path') {
            // The first tap on an existing path selects it instead of starting a new one.
            var P = sharedPolygon();
            var hit = (P && !P.pointContainer.children.length && _mapObjLayer)
                ? _mapObjLayer.hitTestPath(world, _ov.worldTol(px)) : null;
            if (hit) { _setTool('off'); _select('path', hit.name); return true; }
        }
        return false;
    }
    function onVertexTap(i) {
        var P = sharedPolygon();
        if (P) P.select(P.selected === i ? -1 : i);
    }
    function _tapPx(ev) { return (ev && ev.pointerType === 'mouse') ? 12 : 22; }

    function _onDeleteClick(world) {
        if (!_layer) return;
        var tol = _ov.worldTol ? _ov.worldTol(10) : 0.3;
        var name = _layer.hitTest(world, tol);
        if (name) { _layer.removeEdit(name); _setHint('medits.hint.edit_deleted', { name: name }); }
        else _setHint('medits.hint.no_edit');
    }

    // =====================================================================
    // SELECTION — the one place for an object: tap it on the map or pick it from
    // its list (both stay in step), the card in the context box gives its name,
    // shape, settings and Delete. The shape opens right away; nothing is written
    // to the robot before Save, and Save and Cancel appear with the first change.
    // kind: 'zone' | 'edit' | 'path' | 'waypoint'.
    // =====================================================================
    var _sel = null;     // {kind, name}
    var _draft = null;   // {kind, name, orig:[[x,y]..], width, yaw, widthNow, yawNow, formDirty, saving, timer}
    var SAVE_TIMEOUT_MS = 15000;   // an edit re-serves the whole raster
    var SAME_M = 0.005;  // zone points travel as float32
    // Results and lists are separate topics: the list with the new or renamed
    // object may come just after the result. It is not "gone" until this passes.
    var AWAIT_MS = 4000;

    function _objOf(sel) {
        if (!sel) return null;
        var list = sel.kind === 'zone' ? (_zoneLayer ? _zoneLayer.zones : [])
            : sel.kind === 'edit' ? (_layer ? _layer.edits : [])
            : sel.kind === 'path' ? (_mapObjLayer ? _mapObjLayer.paths : [])
            : (_mapObjLayer ? _mapObjLayer.waypoints : []);
        for (var i = 0; i < list.length; i++) if (list[i].name === sel.name) return list[i];
        return null;
    }
    function _ptsOf(kind, o) { return kind === 'waypoint' ? [[o.x, o.y]] : (o.points || []); }
    function _curPts() {
        var P = sharedPolygon(), out = [];
        var ch = (P && P.pointContainer.children) || [];
        for (var i = 0; i < ch.length; i++) out.push([ch[i].x, -ch[i].y]);
        return out;
    }
    function _samePts(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            if (Math.abs(a[i][0] - b[i][0]) > SAME_M || Math.abs(a[i][1] - b[i][1]) > SAME_M) return false;
        }
        return true;
    }
    function _dirty() {
        var d = _draft;
        if (!d) return false;
        return d.saving || d.formDirty || d.widthNow !== d.width || d.yawNow !== d.yaw
            || !_samePts(_curPts(), d.orig);
    }
    function _isOpen(kind, o) { return kind === 'path' || kind === 'waypoint' || (kind === 'edit' && o.kind === 'wall'); }

    // Two edges of a closed ring cross: the planner and the raster mask read
    // such a ring differently than it looks.
    function _crosses(pts) {
        function side(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
        var n = pts.length;
        for (var i = 0; i < n; i++) {
            var a = pts[i], b = pts[(i + 1) % n];
            for (var k = i + 2; k < n; k++) {
                if ((k + 1) % n === i) continue;     // the neighbour of edge i
                var c = pts[k], d = pts[(k + 1) % n];
                if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
            }
        }
        return false;
    }
    function _area(pts) {
        var total = 0;
        for (var i = 0; i < pts.length; i++) {
            var a = pts[i], b = pts[(i + 1) % pts.length];
            total += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(total / 2);
    }
    function _length(pts) {
        var total = 0;
        for (var i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        return total;
    }

    // Objects under a tap: the most specific first. Hidden layers are not hit.
    function _hits(world, px) {
        var tol = _ov.worldTol(px), out = [], i, s;
        var m = _mapObjLayer;
        if (m && _show.waypoints) {
            for (i = 0; i < m.waypoints.length; i++) {
                var w = m.waypoints[i], d = Math.hypot(world.x - w.x, world.y - w.y);
                if (d <= tol) out.push({ kind: 'waypoint', name: w.name, rank: 0, size: d });
            }
        }
        function ring(kind, name, pts, baseRank) {
            var edge = false;
            for (var k = 0; k < pts.length; k++) {
                if (_distToSeg(world, pts[k], pts[(k + 1) % pts.length]) <= tol) { edge = true; break; }
            }
            if (edge) out.push({ kind: kind, name: name, rank: 1, size: _area(pts) });
            else if (pts.length >= 3 && _pointInPoly(world, pts)) out.push({ kind: kind, name: name, rank: baseRank, size: _area(pts) });
        }
        if (m && _show.paths) {
            for (i = 0; i < m.paths.length; i++) {
                var pth = m.paths[i], pp = pth.points || [];
                if (m.isPathHidden(pth.name)) continue;
                for (s = 0; s + 1 < pp.length; s++) {
                    if (_distToSeg(world, pp[s], pp[s + 1]) <= tol) { out.push({ kind: 'path', name: pth.name, rank: 1, size: 0 }); break; }
                }
            }
        }
        if (_layer && _show.edits) {
            for (i = 0; i < _layer.edits.length; i++) {
                var e = _layer.edits[i], ep = e.points || [];
                if (e.kind === 'wall') {
                    var hw = (e.width_m || 0.10) / 2 + tol;
                    for (s = 0; s + 1 < ep.length; s++) {
                        if (_distToSeg(world, ep[s], ep[s + 1]) <= hw) { out.push({ kind: 'edit', name: e.name, rank: 1, size: 0 }); break; }
                    }
                } else ring('edit', e.name, ep, 2);
            }
        }
        if (_zoneLayer && _show.zones) {
            for (i = 0; i < _zoneLayer.zones.length; i++) {
                ring('zone', _zoneLayer.zones[i].name, _zoneLayer.zones[i].points, 3);
            }
        }
        out.sort(function (a, b) { return a.rank - b.rank || a.size - b.size; });
        return out;
    }

    // A repeated tap on overlapping objects walks through them.
    function _tapSelect(world, ev) {
        if (_dirty()) { _setHint('medits.sel.save_first'); return; }
        var hits = _hits(world, _tapPx(ev));
        var P = sharedPolygon();
        if (!hits.length) {
            if (P && P.selected >= 0) P.select(-1); else _deselect();
            return;
        }
        var at = -1;
        for (var i = 0; i < hits.length; i++) {
            if (_sel && hits[i].kind === _sel.kind && hits[i].name === _sel.name) at = i;
        }
        var next = hits[(at + 1) % hits.length];
        _select(next.kind, next.name);
    }

    // opts.frame: bring the object into view (a pick from a list).
    function _select(kind, name, opts) {
        if (_dirty()) { _setHint('medits.sel.save_first'); return false; }
        if (_tool !== 'off') _setTool('off');
        if (_sel && _sel.kind === kind && _sel.name === name) { if (opts && opts.frame) _frameSel(); return true; }
        _closeSel();
        _sel = { kind: kind, name: name, awaited: !!(opts && opts.awaited) ? Date.now() + AWAIT_MS : 0 };
        _beginShape();
        _renderSel();
        _markRows();
        _compact(true);
        if (opts && opts.frame) _frameSel();
        var body = document.getElementById('ui_drawer_body');
        if (body) body.scrollTop = 0;
        return true;
    }
    function _closeSel() {
        _endShape();
        _sel = null;
    }
    function _deselect() {
        if (!_sel) return;
        _closeSel();
        _renderSel();
        _markRows();
        _setHint('medits.hint.pick');
        _refreshActions();
    }
    function _frameSel() {
        var o = _objOf(_sel);
        if (!o || !_ov || !_ov.frameBox) return;
        var b = _bbox(_ptsOf(_sel.kind, o));
        var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
        var half = Math.max(3, (b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2);
        requestAnimationFrame(function () { _ov.frameBox(cx - half, cy - half, cx + half, cy + half); });
    }

    function _beginShape() {
        var P = sharedPolygon(), o = _objOf(_sel);
        if (!P || !o) return;
        var kind = _sel.kind, pts = _ptsOf(kind, o);
        _clearPolygon(P);
        P.openLine = _isOpen(kind, o);
        P.showMids = kind !== 'waypoint';
        P.minPoints = kind === 'waypoint' ? 1 : (P.openLine ? 2 : 3);
        if (kind === 'zone') {
            window.mapEditZoneApi.begin(o.name);    // form + preview of its mowing paths
        } else {
            try { _ov.scene.addChild(P); } catch (e) {}
            P.pointContainer.children = pts.map(function (p) { return { x: p[0], y: -p[1] }; });
        }
        P.resetUndo();
        P.onChange = _onShapeChange;
        _draft = { kind: kind, name: o.name, orig: pts.map(function (p) { return [p[0], p[1]]; }),
                   width: o.width_m, widthNow: o.width_m, yaw: o.yaw, yawNow: o.yaw,
                   editKind: o.kind, formDirty: false, saving: false, timer: null };
        if (kind === 'waypoint') _showYawPreview(o.x, o.y, o.yaw || 0);
    }
    function _endShape() {
        var P = sharedPolygon(), d = _draft;
        _draft = null;
        if (d && d.timer) clearTimeout(d.timer);
        if (P) { P.onChange = null; P.openLine = false; P.showMids = false; P.minPoints = 0; }
        if (d && d.kind === 'zone') window.mapEditZoneApi.close();
        if (P && d) {
            try { _ov.scene.removeChild(P); } catch (e) {}
            _clearPolygon(P);
        }
        _hideYawPreview();
    }
    function _reopenShape() {
        var s = _sel;
        _endShape();
        _sel = s;
        _beginShape();
        _renderSel();
        _refreshActions();
    }
    function _revertShape() { _reopenShape(); }

    function _shapeProblem() {
        var d = _draft, P = sharedPolygon(), pts = _curPts();
        if (pts.length < ((P && P.minPoints) || 0)) return 'medits.shape.too_few';
        var closed = d.kind === 'zone' || (d.kind === 'edit' && d.editKind !== 'wall');
        if (closed && _crosses(pts)) return 'medits.shape.crosses';
        return null;
    }
    function _onShapeChange() {
        var d = _draft;
        if (!d) return;
        _refreshActions();
        _paintSelStats();
        if (d.kind === 'waypoint') {
            var pts = _curPts();
            if (pts.length) _showYawPreview(pts[0][0], pts[0][1], d.yawNow || 0);
        }
    }

    function _saveShape() {
        var d = _draft;
        if (!d || d.saving) return;
        var bad = _shapeProblem();
        if (bad) { _setHint(bad); return; }
        var pts = _curPts();
        d.saving = true;
        if (d.kind === 'zone') {
            window.mapEditZoneApi.save();   // answers through onZoneResult
            _refreshActions();
            return;
        }
        d.target = pts;
        if (d.kind === 'edit') {
            _layer.saveEdit({ kind: d.editKind, name: d.name, points: pts, width_m: d.widthNow });
        } else if (d.kind === 'path') {
            _pub_path_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: d.name, points: pts }) }));
        } else {
            _publishWaypointAt(d.name, pts[0][0], pts[0][1], d.yawNow || 0);
        }
        _setHint('medits.sel.saving', { name: d.name });
        d.timer = setTimeout(function () {
            if (_draft !== d) return;
            d.saving = false; d.timer = null;
            _setHint('medits.sel.no_answer');
            _refreshActions();
        }, SAVE_TIMEOUT_MS);
        _refreshActions();
    }
    function _savedHere() {
        var name = _draft.name;
        _reopenShape();
        _setHint('medits.sel.saved', { name: name });
    }
    // navi_man answers in (-pi, pi], the heading field gives 0..360 degrees
    function _angleOff(a, b) { return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))); }
    // The owner node's list is the confirmation: the object in it has the new shape.
    function _storedAsDraft(d, o) {
        if (!_samePts(_ptsOf(d.kind, o), d.target)) return false;
        if (d.kind === 'edit' && d.editKind === 'wall' && o.width_m !== d.widthNow) return false;
        if (d.kind === 'waypoint' && _angleOff(o.yaw || 0, d.yawNow || 0) > 0.01) return false;
        return true;
    }

    // Zone save, from map_edit.js. ok=false keeps the draft and the form says why.
    function onZoneResult(name, ok, programs) {
        var inTool = _tool === 'zone';
        if (ok && inTool) {
            _setTool('off');
            _select('zone', name, { awaited: true });
            _setHint('medit.zone_saved', { name: name });
            return;
        }
        if (!_draft || _draft.kind !== 'zone') return;
        if (!ok) { _draft.saving = false; _refreshActions(); return; }
        _reopenShape();
        if (programs) _setHint('medits.sel.zone_saved_programs', { name: name, n: programs });
        else _setHint('medits.sel.saved', { name: name });
    }

    // Something in the owners' lists changed.
    function _onData() {
        if (_renaming) return;
        var d = _draft, o = _objOf(_sel);
        if (d && d.saving && d.target && o && _storedAsDraft(d, o)) { _savedHere(); return; }
        if (!_sel) return;
        if (!o) {       // deleted, here or elsewhere
            if (Date.now() >= _sel.awaited) _deselect();
            return;
        }
        if (_sel.awaited) {
            _sel.awaited = 0;
            if (!_draft) _beginShape();
            var hint = _hintK, hintV = _hintV;
            _renderSel();
            _setHint(hint, hintV);
            _markRows();
            _refreshActions();
        }
        if (d && !d.saving && !_dirty() && !_samePts(_ptsOf(d.kind, o), d.orig)) _reopenShape();
        _paintSelStats();
    }
    function _zoneData() {
        var api = window.mapEditZoneApi;
        if (!_zoneLayer || !api) return;
        _zoneLayer.set(api.list());
        _onData();
        _markRows();
    }

    // ---- the selection card ----
    var SEL_ICON = { zone: 'la-object-group', path: 'la-road', waypoint: 'la-map-marker',
                     obstacle: 'la-square', free: 'la-square-o', wall: 'la-minus' };
    function _kindKey(sel, o) {
        if (sel.kind === 'edit') return 'medits.kind.' + (o.kind || 'obstacle');
        return 'medits.kind.' + sel.kind;
    }
    function _zonePrograms(name) {
        var pg = window.programs, all = (pg && pg.program_list_msg && pg.program_list_msg.program_list) || [];
        return all.filter(function (p) {
            return (p.zone_list || []).some(function (z) { return z.name === name; });
        }).map(function (p) { return p.name; });
    }
    function _renderSel() {
        var host = document.getElementById('mapedit_sel');
        if (!host) return;
        if (_renaming && _renaming.kind === (_sel && _sel.kind)) return;
        var o = _objOf(_sel);
        if (!o) { host.innerHTML = ''; return; }
        var s = _sel, ico = SEL_ICON[s.kind === 'edit' ? o.kind : s.kind] || 'la-square';
        var locked = s.kind === 'waypoint' && isReserved(s.name);
        var h = '<div class="mapedit-sel-head">' +
            '<i class="la ' + ico + ' vt-accent"></i>' +
            '<div class="vt-grow1 vt-min0">' +
            '<div class="mapedit-sel-kind vt-muted"' + _ti(_kindKey(s, o)) + '</div>' +
            '<div class="mapedit-sel-name text-truncate" title="' + _escapeAttr(s.name) + '">' + _escapeHtml(s.name) + '</div>' +
            '</div>' +
            (locked ? '' : '<button class="btn btn-outline-info mapedit-sel-ren" id="mapedit_sel_rename" type="button" data-i18n-title="common.rename" data-i18n-aria-label="common.rename" title="' + _escapeAttr(t('common.rename')) + '" aria-label="' + _escapeAttr(t('common.rename')) + '"><i class="la la-pencil"></i></button>') +
            '<button class="btn btn-outline-secondary mapedit-sel-x" id="mapedit_sel_close" type="button" data-i18n-aria-label="common.close" aria-label="' + _escapeAttr(t('common.close')) + '"><i class="la la-times"></i></button>' +
            '</div>' +
            (locked ? '<div class="vt-fs-xs vt-muted vt-mb1"' + _ti('medits.sel.reserved') + '</div>' : '') +
            '<div id="mapedit_sel_stats" class="vt-fs-sm vt-muted vt-minh-line"></div>' +
            '<div id="mapedit_sel_warn" class="vt-fs-sm text-warning"></div>';
        var more = '';
        if (s.kind === 'zone') {
            var used = _zonePrograms(s.name);
            more += '<div class="vt-fs-xs vt-muted vt-mt1">' + _escapeHtml(used.length
                    ? t('medits.sel.zone_used', { list: used.join(', ') })
                    : t('medits.sel.zone_unused')) + '</div>';
            more += '<div class="vt-fs-xs vt-muted"' + _ti('medits.sel.zone_start') + '</div>';
        }
        if (s.kind === 'edit' && o.kind === 'wall') {
            h += '<div class="vt-mt2"><span class="vt-fs-sm vt-block vt-mb1"' + _ti('medits.wall_width') + '</span>' +
                 '<div class="input-group input-group-sm vt-w-md"><input class="form-control" id="mapedit_sel_width" type="number" min="0.02" max="2" step="0.05" value="' + ((_draft && _draft.widthNow) || o.width_m || 0.10) + '"><span class="input-group-text">m</span></div></div>';
        }
        if (s.kind === 'waypoint') {
            var yDeg = (_draft && typeof _draft.yawNow === 'number') ? ((_draft.yawNow * 180 / Math.PI) % 360 + 360) % 360 : _wpYawDeg(s.name);
            var y0 = Math.round(yDeg * 2) / 2;
            h += '<div class="vt-fs-sm vt-mt2 vt-mb1 vt-flex vt-aic vt-gap6"><span' + _ti('medits.heading') + '</span>' +
                 ' <input id="mapedit_sel_yawn" class="form-control form-control-sm vt-w-sm vt-pad-s" type="number" min="0" max="359.5" step="0.5" value="' + y0 + '">°</div>' +
                 '<input id="mapedit_sel_yaw" type="range" min="0" max="359.5" step="0.5" value="' + y0 + '" class="vt-w100">';
        }
        more += '<div class="vt-fs-xs vt-muted vt-mt1"' + _ti(s.kind === 'waypoint' ? 'medits.sel.how_wp' : 'medits.sel.how') + '</div>' +
             '<button class="btn btn-outline-danger btn-sm vt-w100 vt-mt2" id="mapedit_sel_del" type="button"' + _ti('common.delete') + '</button>';
        h += '<div class="mapedit-sel-more">' + more + '</div>';
        host.innerHTML = '<div class="mapedit-sel">' + h + '</div>';
        host.querySelector('#mapedit_sel_close').addEventListener('click', function () {
            if (_dirty()) _setHint('medits.sel.save_first'); else _deselect();
        });
        var rn = host.querySelector('#mapedit_sel_rename');
        if (rn) rn.addEventListener('click', function () {
            if (_dirty()) { _setHint('medits.sel.save_first'); return; }
            startRename(host.querySelector('.mapedit-sel-head'), s.kind, s.name, _renderSel);
        });
        var wi = host.querySelector('#mapedit_sel_width');
        if (wi) wi.addEventListener('input', function () {
            var v = parseFloat(wi.value);
            if (_draft && isFinite(v) && v > 0) { _draft.widthNow = v; _refreshActions(); }
        });
        var yr = host.querySelector('#mapedit_sel_yaw'), yn = host.querySelector('#mapedit_sel_yawn');
        function yawFrom(el, other) {
            var v = parseFloat(el.value);
            if (!isFinite(v) || !_draft) return;
            v = ((v % 360) + 360) % 360;
            other.value = v;
            _draft.yawNow = v * Math.PI / 180;
            _onShapeChange();
        }
        if (yr) yr.addEventListener('input', function () { yawFrom(yr, yn); });
        if (yn) yn.addEventListener('input', function () { yawFrom(yn, yr); });
        _wireRowDelete(host.querySelector('#mapedit_sel_del'), s.name, function () { _deleteSel(s); });
        _paintSelStats();
        _setHint(s.kind === 'waypoint' ? 'medits.sel.how_short_wp' : 'medits.sel.how_short');
    }
    function _paintSelStats() {
        var el = document.getElementById('mapedit_sel_stats');
        if (!el || !_sel) return;
        var pts = _draft ? _curPts() : [], k = _sel.kind, txt = '';
        if (k === 'waypoint') {
            if (pts.length) txt = 'x ' + pts[0][0].toFixed(2) + ' · y ' + pts[0][1].toFixed(2) + ' m';
        } else {
            var open = !!(sharedPolygon() && sharedPolygon().openLine);
            txt = tn('medits.pts', pts.length) + ' · ' + (open
                ? _length(pts).toFixed(1) + ' m' : _area(pts).toFixed(1) + ' m²');
        }
        el.textContent = txt;
        var w = document.getElementById('mapedit_sel_warn');
        if (w) w.textContent = (_draft && _shapeProblem()) ? t(_shapeProblem()) : '';
        var fin = document.getElementById('mapedit_finish');
        if (fin && _draft && !_draft.saving && _shapeProblem()) fin.disabled = true;
    }
    function _deleteSel(s) {
        _closeSel();
        _renderSel();
        _markRows();
        _refreshActions();
        if (s.kind === 'zone') { window.mapEditZoneApi.remove(s.name); _setHint('medits.sel.deleted', { name: s.name }); }
        else if (s.kind === 'edit') { _layer.removeEdit(s.name); _setHint('medits.hint.edit_deleted', { name: s.name }); }
        else if (s.kind === 'path') { _removePath(s.name); _setHint('medits.hint.path_deleted', { name: s.name }); }
        else { if (_pub_wp_remove) _pub_wp_remove.publish(new ROSLIB.Message({ data: s.name })); _setHint('medits.hint.wp_deleted', { name: s.name }); }
    }

    // ---- lists: one row anatomy, a tap selects ----
    function rowHtml(kind, name, inner) {
        return '<div class="mapedit-row vt-sep vt-fs-sm" role="button" tabindex="0" data-kind="' + kind + '" data-n="' + _escapeAttr(name) + '">' + inner + '</div>';
    }
    function _wireLists() {
        var panel = _panel();
        if (!panel || panel._rowsWired) return;
        panel._rowsWired = true;
        function pick(row) { _select(row.getAttribute('data-kind'), row.getAttribute('data-n'), { frame: true }); }
        panel.addEventListener('click', function (ev) {
            var row = ev.target.closest('.mapedit-row');
            if (row && !ev.target.closest('button')) pick(row);
        });
        panel.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            var row = ev.target.closest && ev.target.closest('.mapedit-row');
            if (row && ev.target === row) { ev.preventDefault(); pick(row); }
        });
    }
    function _markRows() {
        var panel = _panel();
        if (!panel) return;
        var rows = panel.querySelectorAll('.mapedit-row');
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var on = !!_sel && r.getAttribute('data-kind') === _sel.kind && r.getAttribute('data-n') === _sel.name;
            r.classList.toggle('sel', on);
            r.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on) { var sec = r.closest('details'); if (sec) sec.open = true; }
        }
    }

    // Phone: while working on the map the bottom sheet shrinks to the context box.
    function _compact(on) {
        var d = document.getElementById('ui_drawer');
        if (!d) return;
        var yes = !!on && window.innerWidth < 576;
        d.classList.toggle('mapedit-compact', yes);
        if (yes) d.classList.add('vt-fit');
        else if (d.classList.contains('editor')) d.classList.remove('vt-fit');
    }
    // Closing the editor with unsaved changes takes a second press.
    var _closeArmed = 0;
    function holdClose() {
        if (!_dirty()) return false;
        var now = Date.now();
        if (now - _closeArmed < 4000) return false;
        _closeArmed = now;
        _setHint('medits.sel.close_again');
        return true;
    }

    function _removePath(name) {
        if (_pub_path_remove) _pub_path_remove.publish(new ROSLIB.Message({ data: name }));
    }

    // Double-click-to-confirm delete wiring for a single button (NEVER
    // window.confirm). onConfirm fires on the second click within the window.
    function _wireRowDelete(btn, name, onConfirm) {
        if (!btn) return;
        var armed = false, timer = null;
        var orig = btn.textContent, origKey = btn.getAttribute('data-i18n');
        var solid = 'btn-danger', outline = 'btn-outline-danger';
        function disarm() {
            armed = false;
            if (origKey) _tag(btn, origKey); else btn.textContent = orig;
            btn.classList.remove(solid); btn.classList.add(outline); if (timer) { clearTimeout(timer); timer = null; }
        }
        btn.addEventListener('click', function () {
            if (!armed) {
                armed = true; _tag(btn, 'common.confirm'); btn.classList.remove(outline); btn.classList.add(solid);
                timer = setTimeout(disarm, 2500);
            } else {
                disarm();
                onConfirm();
            }
        });
    }

    // Paths list lives in the collapsible "Paths" section — rendered from the
    // latest map_objects.paths. A row selects; its eye hides that one path.
    function _renderPathList() {
        var pl = document.getElementById('mapedit_path_list');
        if (!pl) return;
        var paths = (_mapObjLayer && _mapObjLayer.paths) ? _mapObjLayer.paths : [];
        if (!paths.length) { pl.innerHTML = '<div class="vt-fs-sm vt-muted"' + _ti('medits.no_paths') + '</div>'; return; }
        var html = '';
        for (var i = 0; i < paths.length; i++) {
            var pth = paths[i];
            var name = pth.name || '';
            var np = (pth.points || []).length;
            var hidden = _mapObjLayer.isPathHidden(name);
            html += rowHtml('path', name,
                '<span class="text-truncate vt-grow1 vt-min0 ' + (hidden ? 'vt-muted' : 'vt-sw-00d0a0') + '" title="' + _escapeAttr(name) + '">' + _escapeHtml(name || t('medits.unnamed')) + '</span>' +
                '<span class="vt-w-xs vt-tar vt-muted">' + _escapeHtml(tn('medits.pts', np)) + '</span>' +
                '<button class="btn btn-outline-secondary mapedit-path-vis" data-n="' + _escapeAttr(name) + '" type="button" title="' + _escapeAttr(t('medits.path_vis')) + '" aria-label="' + _escapeAttr(t('medits.path_vis')) + '"' + (hidden ? ' data-off="1"' : '') + '>' + (hidden ? '<i class="la la-eye-slash"></i>' : '<i class="la la-eye"></i>') + '</button>');
        }
        pl.innerHTML = html;
        pl.querySelectorAll('.mapedit-path-vis').forEach(function (b) {
            b.addEventListener('click', function () {
                var n = b.getAttribute('data-n');
                if (!_mapObjLayer) return;
                _mapObjLayer.setPathHidden(n, !_mapObjLayer.isPathHidden(n));
                _renderPathList();   // refresh icon/dimmed state
            });
        });
        _markRows();
    }

    // ---- waypoint placement: floating name + yaw slider (simpler than a drag
    //      gesture; yaw chosen from a 0..359° slider) ----
    function _newWaypoint(world) {
        _showWpInput(nextName('waypoint', _names('waypoint')), false, function (finalName, yawDeg) {
            var yaw = (yawDeg || 0) * Math.PI / 180;
            _publishWaypointAt(finalName, world.x, world.y, yaw);
            _setHint('medits.hint.wp_saved', { name: finalName });
        }, world, 0);
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
    // current yaw (deg) of a known waypoint
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
            '<div class="vt-sep-dashed">' +
            '<div class="vt-fs-sm vt-mb1"' + _ti('medits.wp_name') + '</div>' +
            '<input class="form-control form-control-sm" id="mapedit_wp_name" type="text" maxlength="60" value="' + _escapeAttr(name) + '"' + (lockName ? ' readonly' : '') + '>' +
            '<div class="vt-fs-sm vt-mt2 vt-mr0 vt-mb1 vt-ml0 vt-flex vt-aic vt-gap6"><span' + _ti('medits.heading') + '</span>' +
            ' <input id="mapedit_wp_yawn" class="form-control form-control-sm vt-w-sm vt-pad-s" type="number" min="0" max="359.5" step="0.5" value="' + y0 + '">°' +
            ' <span class="vt-dim vt-fs-xs"' + _ti('medits.heading_hint') + '</span></div>' +
            '<input id="mapedit_wp_yaw" type="range" min="0" max="359.5" step="0.5" value="' + y0 + '" class="vt-w100">' +
            '<div class="d-flex vt-gap6 vt-mt2">' +
            '  <button class="btn btn-success btn-sm flex-fill" id="mapedit_wp_save" type="button"' + _ti('common.save') + '</button>' +
            '  <button class="btn btn-warning btn-sm flex-fill" id="mapedit_wp_cancel" type="button"' + _ti('common.cancel') + '</button>' +
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
            var bad = lockName ? null : nameProblem(nm, _names('waypoint'));
            if (bad) { _setHint('medits.name.err.' + bad, { name: nm }); return; }
            var v = parseFloat(yawn.value);
            _hideWpInput();
            onSave(nm, isFinite(v) ? ((v % 360) + 360) % 360 : 0);
        });
        host.querySelector('#mapedit_wp_cancel').addEventListener('click', _hideWpInput);
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
    // rendered (not gated on the active tool). A row selects.
    function _renderWpList() {
        var wl = document.getElementById('mapedit_wp_list');
        if (!wl) return;
        if (!_wpNames.length) { wl.innerHTML = '<div class="vt-fs-sm vt-muted"' + _ti('medits.no_wps') + '</div>'; return; }
        var html = '';
        for (var i = 0; i < _wpNames.length; i++) {
            var n = _wpNames[i];
            html += rowHtml('waypoint', n, '<span class="text-info text-truncate vt-grow1 vt-min0" title="' + _escapeAttr(n) + '">' + _escapeHtml(n) + '</span>');
        }
        wl.innerHTML = html;
        _markRows();
    }

    // Edits list lives in the collapsible "Edity mapy" section; Clear-all is the
    // double-click button in the same section. Refreshed whenever the latched
    // edit_list changes (onListChange). A row selects.
    function _renderEditList() {
        var el = document.getElementById('mapedit_edit_list');
        if (!el) return;
        var edits = (_layer && _layer.edits) ? _layer.edits : [];
        if (!edits.length) { el.innerHTML = '<div class="vt-fs-sm vt-muted"' + _ti('medits.no_edits') + '</div>'; return; }
        var LBL = { obstacle: t('medits.kind.obstacle'), free: t('medits.kind.free'), wall: t('medits.kind.wall') };
        var html = '';
        for (var i = 0; i < edits.length; i++) {
            var e = edits[i];
            var kind = LBL[e.kind] || e.kind || '';
            var np = (e.points || []).length;
            html += rowHtml('edit', e.name || '',
                '<span class="text-truncate vt-grow1 vt-min0" title="' + _escapeAttr(e.name || '') + '">' + _escapeHtml(e.name || t('medits.unnamed')) + '</span>' +
                '<span class="text-light vt-w-sm">' + _escapeHtml(kind) + '</span>' +
                '<span class="vt-w-xs vt-tar vt-muted">' + _escapeHtml(tn('medits.pts', np)) + '</span>');
        }
        el.innerHTML = html;
        _markRows();
    }

    // =====================================================================
    // NAMES — every map object has one. Rules mirror vitulus_mapping/objnames.py;
    // the owner node decides, this only avoids a pointless round trip.
    // =====================================================================
    var EDIT_KIND = { edit_obstacle: 'obstacle', edit_free: 'free', edit_wall: 'wall' };
    var NAME_MAX = 60;
    var RESERVED = ['dock', 'undock', 'docked'];
    var RENAME_TOPIC = { edit: '/mapping_manager/rename_edit', waypoint: '/navi_manager/rename_point',
                         path: '/navi_manager/rename_path', zone: '/web_plan/rename_zone' };
    var RENAME_TIMEOUT_MS = 6000;

    function _fold(s) { return String(s).toLowerCase(); }
    function isReserved(name) { return RESERVED.indexOf(_fold(name)) >= 0; }

    function nameProblem(name, existing, current) {
        if (!name) return 'empty';
        if (name.length > NAME_MAX) return 'too_long';
        if (name === '*' || name.indexOf('|||') >= 0 || /[\x00-\x1f\x7f]/.test(name)) return 'bad_chars';
        if (isReserved(name)) return 'reserved';
        var skip = (current != null) ? _fold(current) : null, f = _fold(name);
        for (var i = 0; i < existing.length; i++) {
            var e = _fold(existing[i]);
            if (e === f && e !== skip) return 'exists';
        }
        return null;
    }

    // Lowest free "<Type> <n>", in the UI language.
    function nextName(kind, existing) {
        var base = t('medits.default.' + kind), n = 1;
        while (nameProblem(base + ' ' + n, existing)) n++;
        return base + ' ' + n;
    }

    function _names(kind) {
        if (kind === 'waypoint') return _wpNames;
        if (kind === 'path') return ((_mapObjLayer && _mapObjLayer.paths) || []).map(function (p) { return p.name || ''; });
        if (kind === 'zone') return window.mapEditZoneNames ? window.mapEditZoneNames() : [];
        return ((_layer && _layer.edits) || []).map(function (e) { return e.name || ''; });
    }

    function _renameDone() {
        var r = _renaming;
        if (!r) return;
        if (r.timer) clearTimeout(r.timer);
        _renaming = null;
        r.redraw();
    }
    function _renameSay(key, v) {
        if (!_renaming) return;
        var r = _renaming, err = r.row.querySelector('.mapedit-ren-err');
        if (r.timer) { clearTimeout(r.timer); r.timer = null; }
        r.to = null;
        r.row.querySelector('.mapedit-ren-save').disabled = false;
        if (err) err.textContent = t(key, v);
    }
    function _onRenameResult(msg) {
        var res;
        try { res = JSON.parse(msg.data); } catch (e) { return; }
        var r = _renaming;
        if (!r || !res || res.kind !== r.kind || res.from !== r.from || res.to !== r.to) return;
        if (!res.ok) { _renameSay('medits.name.err.' + res.code, { name: res.to }); return; }
        if (res.kind === 'path' && _mapObjLayer && _mapObjLayer.isPathHidden(res.from)) {
            _mapObjLayer.setPathHidden(res.from, false);
            _mapObjLayer.setPathHidden(res.to, true);
        }
        if (_sel && _sel.kind === res.kind && _sel.name === res.from) {
            _sel.name = res.to;
            _sel.awaited = Date.now() + AWAIT_MS;
            if (_draft) _draft.name = res.to;
            if (res.kind === 'zone' && window.mapEditZoneApi) window.mapEditZoneApi.setName(res.to);
        }
        _renameDone();
        _markRows();
        _setHint('medits.hint.renamed', { from: res.from, to: res.to });
    }
    function _renameTopic(kind) {
        var ros = rosOf();
        if (!ros) return null;
        if (!_renameResult) {
            _renameResult = new ROSLIB.Topic({ ros: ros, name: '/map_objects/rename_result', messageType: 'std_msgs/String' });
            _renameResult.subscribe(_onRenameResult);
        }
        if (!_renameTopics[kind]) {
            _renameTopics[kind] = new ROSLIB.Topic({ ros: ros, name: RENAME_TOPIC[kind], messageType: 'std_msgs/String' });
            _renameTopics[kind].advertise();
        }
        return _renameTopics[kind];
    }
    function _renameSubmit() {
        var r = _renaming;
        if (!r || r.to) return;
        var to = r.row.querySelector('.mapedit-ren-input').value.trim();
        if (to === r.from) { _renameDone(); return; }
        var bad = nameProblem(to, _names(r.kind), r.from);
        if (bad) { _renameSay('medits.name.err.' + bad, { name: to }); return; }
        var topic = _renameTopic(r.kind);
        if (!topic) { _renameSay('medits.name.err.timeout'); return; }
        r.to = to;
        r.row.querySelector('.mapedit-ren-save').disabled = true;
        r.timer = setTimeout(function () { _renameSay('medits.name.err.timeout'); }, RENAME_TIMEOUT_MS);
        topic.publish(new ROSLIB.Message({ data: JSON.stringify({ from: r.from, to: to }) }));
    }
    // Turn the card's head into a name field. The card stops redrawing until
    // done: the latched lists come again at any moment and would wipe the typing.
    function startRename(row, kind, name, redraw) {
        _renameDone();
        _renaming = { kind: kind, from: name, to: null, row: row, redraw: redraw, timer: null };
        row.innerHTML =
            '<div class="vt-w100"><div class="d-flex align-items-center vt-gap6">' +
            '<input class="form-control form-control-sm mapedit-ren-input vt-grow1 vt-min0" type="text" maxlength="' + NAME_MAX + '" value="' + _escapeAttr(name) + '">' +
            '<button class="btn btn-success btn-sm mapedit-ren-save" type="button"' + _ti('common.save') + '</button>' +
            '<button class="btn btn-warning btn-sm mapedit-ren-cancel" type="button"' + _ti('common.cancel') + '</button>' +
            '</div><div class="mapedit-ren-err vt-fs-xs text-warning" role="alert"></div></div>';
        var input = row.querySelector('.mapedit-ren-input');
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); _renameSubmit(); }
            else if (ev.key === 'Escape') { _renameDone(); }
        });
        row.querySelector('.mapedit-ren-save').addEventListener('click', _renameSubmit);
        row.querySelector('.mapedit-ren-cancel').addEventListener('click', _renameDone);
        input.focus(); input.select();
    }
    function _escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function _escapeAttr(s) { return String(s).replace(/["&<>]/g, function (c) { return { '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

    /* U1 kolo 4 — DEV ONLY: render the editor panel from fake data so its
       look can be checked WITHOUT entering the editor (entering talks to the
       robot: planner reload, topic adverts). Works only with ?mock in the URL;
       creates no ROS objects, publishes nothing. */
    function mockPreview() {
        if (!/[?&]mock\b/.test(location.search)) { return false; }
        var keepL = _layer, keepM = _mapObjLayer, keepW = _wpNames;
        _layer = {edits: [{name: 'Hedge corner', kind: 'obstacle', points: [1, 2, 3, 4]},
                          {name: 'Gate', kind: 'wall', points: [1, 2]}], group: {}};
        _mapObjLayer = {paths: [{name: 'Kolem_vina', points: new Array(42)},
                                {name: 'Back lawn', points: new Array(18)}],
                        isPathHidden: function (n) { return n === 'Back lawn'; }};
        _wpNames = ['DOCK', 'UNDOCK', 'docked'];
        try {
            _loadShow(); _buildToolbar(); _renderEditList(); _renderWpList(); _renderPathList();
        } finally { _layer = keepL; _mapObjLayer = keepM; _wpNames = keepW; }
        return true;
    }

    // Language switch: data-i18n parts follow by themselves; re-draw the rest.
    function _onLang() {
        if (!_built) return;
        _renderEditList(); _renderWpList(); _renderPathList();
        _renderSel();
        if (_hintK) _setHint(_hintK, _hintV);
        if (_gfSaid) _gfSay(_gfSaid.fn, _gfSaid.cls);
        if (_tool === 'geofence') _gfTick();
    }
    if (window.VTI18n) VTI18n.onChange(_onLang);

    return {
        mockPreview: mockPreview,
        onEnter: onEnter,
        onExit: onExit,
        setTool: _setTool,
        nextName: nextName,
        nameProblem: nameProblem,
        rowHtml: rowHtml,
        onMapTap: onMapTap,
        onVertexTap: onVertexTap,
        onMapGesture: function () { _compact(true); },
        onZoneData: _zoneData,
        onZoneResult: onZoneResult,
        holdClose: holdClose,
        // exposed for diagnostics/tests
        _layer: function () { return _layer; },
        _state: function () {
            var P = sharedPolygon();
            return { tool: _tool, sel: _sel, dirty: _dirty(), saving: !!(_draft && _draft.saving),
                     pts: _curPts(), selected: P ? P.selected : -1, canUndo: !!(P && P.canUndo()),
                     zones: _zoneLayer ? _zoneLayer.zones.map(function (z) { return z.name; }) : [],
                     hint: (document.getElementById('mapedit_hint') || {}).textContent };
        },
        EditMaskLayer: EditMaskLayer,
    };
})();
