// mapedits.js — WP-D2 interactive map editor tools for vitulus_ui.
//
// Adds, on top of the existing in-view planner editor (mapeditor.js overlay +
// map_edit.js zone/polygon flows), the tool bar over the map and the inspector:
//   - Select            -> pick any visible object on the map or in the list;
//                          the inspector holds its name, meaning, rules, status
//                          and actions, the same anatomy for every type
//   - Meaning           -> /map_objects/op (place, landmark, nogo, slow, noblade,
//                          corridor; docs/MAP_OBJECTS.md in vitulus_mapping)
//   - Map fixes         -> /mapping_manager/save_edit (obstacle, free, barrier)
//   - Waypoint, Path    -> /navi_manager/save_waypoint_at, save_path_at
//   - Zone              -> map_edit.js zone flow (form, confirmation)
//   - Measure, Trace by driving, snap: nothing here commands the robot
//   - Delete            -> at once, with an undo toast, on the selection
//
// map_objects_server may not be running: the owners' lists stay the source of
// what exists, the server adds ids, meaning, history and the new types. Without
// it the editor is what it was and a delete is undone by saving the object back.
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

    var T = window.THREE, MO = window.VTMapObjects, Panel = window.MapEditPanel;

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
            spr.userData.label = { w: cv.width, h: cv.height, x: x, y: y, extent: extent || 0, prio: 3 };
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
                    if (lb) { lb.userData.label.prio = 4; this.group.add(lb); }
                }
            }
            _rescaleLabels(true);
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
                      edits: 'vitulus_editor_show_edits', zones: 'vitulus_editor_show_zones',
                      places: 'vitulus_editor_show_places', coverage: 'vitulus_editor_show_coverage',
                      gnss: 'vitulus_editor_show_gnss', slope: 'vitulus_editor_show_slope',
                      grass: 'vitulus_editor_show_grass' };
    var _show = { waypoints: true, paths: true, edits: true, zones: true, places: true,
                  coverage: false, gnss: false, slope: false, grass: false };
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
            _renderList();
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
                if (plb) { plb.userData.label.prio = 5; this.pathGroup.add(plb); }
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
                if (label) {
                    label.userData.label.beside = true;
                    label.userData.label.prio = MO.isProtectedName(w.name) ? 1 : 3;
                    this.wpGroup.add(label);
                }
            }
            _rescaleLabels(true);
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
                if (lb) { lb.userData.label.prio = 1; this.group.add(lb); }
            }
            _rescaleLabels(true);
        }
    }
    var _zoneLayer = null;
    var _ml = null;          // MapEditLayers.Layers: objects with meaning, world layers, snap ring

    // Map metres <-> screen pixels (y down) around the view centre. The editor
    // looks straight down, so this is exact for any turn of the camera.
    function _screenAxes(pxm) {
        var r = _ov.canvas.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var o = _ov.screenToWorld(cx, cy), a = _ov.screenToWorld(cx + 100, cy), b = _ov.screenToWorld(cx, cy + 100);
        var ex = [(a.x - o.x) / 100, (a.y - o.y) / 100], ey = [(b.x - o.x) / 100, (b.y - o.y) / 100];
        var det = ex[0] * ey[1] - ey[0] * ex[1];
        if (!r.width || !isFinite(det) || Math.abs(det) < 1e-12) {   // no canvas yet: north up
            o = { x: 0, y: 0 }; ex = [1 / pxm, 0]; ey = [0, -1 / pxm]; det = -1 / (pxm * pxm);
        }
        return {
            toScreen: function (x, y) {
                var dx = x - o.x, dy = y - o.y;
                return [(dx * ey[1] - dy * ey[0]) / det, (ex[0] * dy - ex[1] * dx) / det];
            },
            toWorld: function (sx, sy) { return [o.x + ex[0] * sx + ey[0] * sy, o.y + ex[1] * sx + ey[1] * sy]; },
        };
    }

    // Constant size on screen for what lives in map metres. Runs each overlay
    // frame, does its work only when the zoom changed.
    // D7 (E2): labels never cover each other, and keep off the dots of points.
    // A point's name tries the four corners beside its dot, then above and
    // below; an area's name its centre, then above, below, beside and aslant
    // while still inside. A name with no free place left is hidden (rules and
    // zones win, paths last) - but the name of a rule or a zone is never hidden
    // because of a dot: where it has to, it lies over it, as before D7.
    var _lastPxm = 0;
    function _rescaleLabels(force) {
        if (!_ov) return;
        var pxm = _ov.pxPerM();
        if (!force && Math.abs(pxm - _lastPxm) < _lastPxm * 0.004) return;
        _lastPxm = pxm;
        var groups = [_layer && _layer.group, _zoneLayer && _zoneLayer.group,
                      _mapObjLayer && _mapObjLayer.wpGroup, _mapObjLayer && _mapObjLayer.pathGroup,
                      _ml && _ml.group, _ml && _ml.sugg];
        var labels = [], dots = [];
        var wpScale = Math.max(1, WP_MIN_PX / (WP_R * pxm));
        var S = _screenAxes(pxm);
        var dotPx = WP_R * 1.28 * wpScale * pxm, offPx = WP_R * 1.6 * wpScale * pxm;
        groups.forEach(function (g) {
            if (!g) return;
            var shown = g.visible !== false;
            g.children.forEach(function (o) {
                if (o.userData.wp) {
                    o.scale.set(wpScale, wpScale, 1);
                    if (shown && o.visible !== false) {
                        var d = S.toScreen(o.position.x, o.position.y);
                        dots.push({ x: d[0], y: d[1], w: 2 * dotPx, h: 2 * dotPx });
                    }
                    return;
                }
                var l = o.userData.label;
                if (!l) return;
                var sw = l.w * LABEL_PX / pxm, sh = l.h * LABEL_PX / pxm;
                o.scale.set(sw, sh, 1);
                var w = l.w * LABEL_PX, h = l.h * LABEL_PX, c = S.toScreen(l.x, l.y), cand;
                if (l.beside) {
                    var side = offPx + w / 2, up = offPx + h / 2 + 2;
                    cand = [[side, -offPx], [side, offPx], [-side, -offPx], [-side, offPx], [0, -up], [0, up]];
                } else {
                    // an area: its middle, then around it while it stays inside
                    var room = l.extent * pxm, dy = h + 4, dx = w / 2 + 8;
                    cand = [[0, 0]];
                    if (room >= 3 * h) cand.push([0, -dy], [0, dy]);
                    if (room >= 2 * w + 16) cand.push([-dx, 0], [dx, 0], [-dx, -dy], [dx, -dy], [-dx, dy], [dx, dy]);
                }
                var p0 = S.toWorld(c[0] + cand[0][0], c[1] + cand[0][1]);
                o.position.set(p0[0], p0[1], 0);
                o.visible = !l.extent || l.extent * pxm >= LABEL_MIN_PX;
                if (o.visible && shown) {
                    // the name of a rule or a zone is never hidden because of a dot
                    labels.push({ x: c[0], y: c[1], w: w, h: h, prio: l.prio, order: labels.length, spr: o, cand: cand,
                                  over: !l.beside && l.prio <= 1 });
                }
            });
        });
        // Fewer words and no overlap: rules and zones first, paths last.
        var kept = MO.declutter(labels, 2, dots);
        labels.forEach(function (it) { it.spr.visible = false; });
        kept.forEach(function (it) {
            var p = S.toWorld(it.x + it.dx, it.y + it.dy);
            it.spr.position.set(p[0], p[1], 0);
            it.spr.visible = true;
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
            _layer.onListChange = function () { _renderList(); _onData(); };
        } else if (_layer) {
            // overlay may have been rebuilt — re-attach the render group
            try { if (_layer.group.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_layer.group); } catch (e) {}
        }
        // V3: map-objects overlay (waypoint dots + path polylines).
        if (ros && !_mapObjLayer) {
            _mapObjLayer = new MapObjectsLayer(ros, overlay);
            _mapObjLayer.onChange = function () { _renderList(); _onData(); };
        } else if (_mapObjLayer) {
            try {
                if (_mapObjLayer.wpGroup.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_mapObjLayer.wpGroup);
                if (_mapObjLayer.pathGroup.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_mapObjLayer.pathGroup);
            } catch (e) {}
        }
        if (!_zoneLayer) _zoneLayer = new ZoneLayer(overlay);
        else if (_zoneLayer.group.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_zoneLayer.group);
        if (!_ml) {
            _ml = new MapEditLayers.Layers(overlay, {
                makeLabel: _makeLabel, order: EDITS_ORDER,
                rescale: function () { _rescaleLabels(true); },
            });
        } else _ml.attach(overlay);
        if (ros) {
            MO.start(ros);
            _ensureWpTopics(ros);
            // advertised up front: a publish right after advertise can be lost
            Object.keys(RENAME_TOPIC).forEach(_renameTopic);
        }
        _loadShow();
        _buildToolbar();
        _showBar(true);
        _zoneData();
        _onObjects('objects');
        _onObjects('history');
        _onObjects('suggestions');
        _renderList();
        _applyAllShow();
        _setTool('off');
        _rescaleLabels(true);
        // D7 (E1): a phone opens on the compact sheet - the tools and the
        // inspector, the map above it; ^ brings the lists. The map was framed
        // for the taller sheet: shift it by half of what the sheet gave back.
        var d = document.getElementById('ui_drawer');
        if (d && window.innerWidth < 576) {
            var top0 = d.offsetTop;
            _compact(true);
            var gain = d.offsetTop - top0;
            if (gain > 0) { try { overlay.panByPixels(0, gain / 2); } catch (e) {} }
        }
    }
    function onExit() {
        _teardownTool();
        _deselect();
        _tool = 'off';
        _setToolButtonsActive('off');
        _hideWpInput();
        _compact(false);
        _showBar(false);
        ['coverage', 'gnss', 'slope', 'grass'].forEach(_dropWorld);
        Panel.hideToast();
        if (window.VTMapRules) VTMapRules.refresh();
        // V3: the Zones chip toggles LIVE-scene program/zone markers; restore them
        // so closing the editor never leaves the normal map view with zones hidden.
        // (The overlay layers live under overlayGroup, which the overlay hides
        // on exitTopDown, so they need no explicit restore.)
        _applyZonesVisible(true);
    }

    // ---- toolbar UI ----
    function _panel() { return document.getElementById('div_map_detail'); }

    // TOOLS: the bar over the map holds Select, three groups, Measure, undo and
    // redo, Layers, History and an overflow. 'off' == select: tap an object, drag
    // and pinch move the map. The backend edit "kind" values stay
    // obstacle/free/wall (see _finishEditsDraw). Colours by data-type in
    // vt_mapedit.css. "Map fixes" and "Meaning" are apart on purpose: the first
    // corrects what the map shows, the second says what a place is.
    var TOOL_GROUPS = [
        { key: 'meaning', ico: 'la-tag', label: 'medits.group.meaning', tools: [
            { tool: 'obj_place',    type: 'place',    label: 'medits.tool.place' },
            { tool: 'obj_landmark', type: 'landmark', label: 'medits.tool.landmark' },
            { tool: 'obj_nogo',     type: 'nogo',     label: 'medits.tool.nogo' },
            { tool: 'obj_slow',     type: 'slow',     label: 'medits.tool.slow' },
            { tool: 'obj_noblade',  type: 'noblade',  label: 'medits.tool.noblade' },
            { tool: 'obj_corridor', type: 'corridor', label: 'medits.tool.corridor' },
        ] },
        { key: 'fix', ico: 'la-wrench', label: 'medits.group.fix', tools: [
            { tool: 'edit_obstacle', type: 'obstacle', label: 'medits.tool.obstacle' },
            { tool: 'edit_free',     type: 'free',     label: 'medits.tool.free' },
            { tool: 'edit_wall',     type: 'wall',     label: 'medits.tool.wall' },
        ] },
        { key: 'objects', ico: 'la-map-o', label: 'medits.group.objects', tools: [
            { tool: 'waypoint', type: 'waypoint', label: 'medits.tool.waypoint' },
            { tool: 'path',     type: 'path',     label: 'medits.tool.path' },
            { tool: 'zone',     type: 'zone',     label: 'medits.tool.zone' },
        ] },
    ];
    var PLACE_TOOL = { obj_place: 'place', obj_landmark: 'landmark', obj_nogo: 'nogo',
                       obj_slow: 'slow', obj_noblade: 'noblade', obj_corridor: 'corridor' };

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

        // B. TOOLS — the bar over the map.
        function tipAttrs(k) {
            return ' data-i18n-title="' + k + '" data-i18n-aria-label="' + k + '" title="' + _escapeAttr(t(k)) + '" aria-label="' + _escapeAttr(t(k)) + '"';
        }
        function btn(ico, k, attrs) {
            return '<button type="button" class="mapedit-bar-btn"' + (attrs || '') + tipAttrs(k) + '><i class="la ' + ico + '"></i></button>';
        }
        function flyTool(tl) {
            return '<button type="button" class="met-tool" data-tool="' + tl.tool + '"' + (tl.type ? ' data-type="' + tl.type + '"' : '') + '>' +
                   '<i class="la ' + (tl.type ? MO.TYPES[tl.type].ico : tl.ico) + '"></i><span' + _ti(tl.label) + '</span></button>';
        }
        var gh = '<div class="mapedit-bar-row mapedit-bar-tools">' + btn('la-mouse-pointer', 'medits.tool.select', ' data-tool="off"');
        TOOL_GROUPS.forEach(function (g) {
            gh += '<div class="mapedit-bar-group"><button type="button" class="mapedit-bar-btn" data-group="' + g.key + '"' + tipAttrs(g.label) + '>' +
                  '<i class="la ' + g.ico + '"></i><span' + _ti(g.label) + '</span></button>' +
                  '<div class="mapedit-fly" data-fly="' + g.key + '">' + g.tools.map(flyTool).join('') + '</div></div>';
        });
        gh += btn('la-compass', 'medits.tool.measure', ' data-tool="measure"') + '<span class="mapedit-bar-sep"></span>' +
              btn('la-undo', 'medits.g_undo', ' id="mapedit_gundo" disabled') + btn('la-repeat', 'medits.g_redo', ' id="mapedit_gredo" disabled') +
              '<span class="mapedit-bar-sep"></span>' +
              btn('la-clone', 'editor.layers', ' data-goto="mapedit_sec_layers"') + btn('la-history', 'editor.history', ' data-goto="mapedit_sec_history"') +
              '<div class="mapedit-bar-group">' + btn('la-ellipsis-h', 'medits.more', ' data-group="more"') +
              '<div class="mapedit-fly" data-fly="more">' +
              // D7: in the panel (phone, narrow map) Layers and History move in here
              '<button type="button" class="met-tool met-panel-only" data-goto="mapedit_sec_layers"><i class="la la-clone"></i><span' + _ti('editor.layers') + '</span></button>' +
              '<button type="button" class="met-tool met-panel-only" data-goto="mapedit_sec_history"><i class="la la-history"></i><span' + _ti('editor.history') + '</span></button>' +
              flyTool({ tool: 'geofence', ico: 'la-shield', label: 'medits.tool.geofence' }) +
              '<button type="button" class="met-tool" id="mapedit_clear_all"><i class="la la-trash"></i><span' + _ti('medits.clear_all') + '</span></button>' +
              '</div></div></div>' +
              '<div class="mapedit-bar-row" id="mapedit_status" hidden><span id="mapedit_live"></span>' +
              btn('la-magnet', 'medits.snap', ' id="mapedit_snap"') +
              btn('la-location-arrow', 'medits.trace.start', ' id="mapedit_trace"') + '</div>';
        var bar = document.createElement('div');
        bar.id = 'mapedit_bar';
        bar.innerHTML = gh;
        tools.appendChild(bar);

        // C. ACTIVE TOOL CONTEXT — one box showing only what the tool needs.
        ctx.innerHTML =
            '<div class="text-uppercase fw-bold vt-fs-xs vt-ls vt-muted vt-mb1"' + _ti('medits.inspector') + '</div>' +
            '<div class="vt-box mapedit-ctx-box">' +
            '  <button class="btn btn-outline-secondary" id="mapedit_expand" type="button" data-i18n-title="medits.expand_lists" data-i18n-aria-label="medits.expand_lists" title="' + _escapeAttr(t('medits.expand_lists')) + '" aria-label="' + _escapeAttr(t('medits.expand_lists')) + '"><i class="la la-angle-up"></i><span class="mapedit-expand-t"' + _ti('medits.expand_short') + '</span></button>' +
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
        bar.querySelectorAll('[data-tool]').forEach(function (b) {
            b.addEventListener('click', function () {
                var m = b.getAttribute('data-tool');
                _closeFly();
                if (_dirty()) { _setHint('medits.sel.save_first'); return; }
                if (m === 'off') { _setTool('off'); return; }
                if (_tool === m) _setTool('off'); else _setTool(m);
            });
        });
        bar.querySelectorAll('[data-group]').forEach(function (b) {
            b.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var f = bar.querySelector('[data-fly="' + b.getAttribute('data-group') + '"]'), was = f.classList.contains('open');
                _closeFly();
                f.classList.toggle('open', !was);
            });
        });
        document.addEventListener('click', function (ev) { if (!ev.target.closest('.mapedit-bar-group')) _closeFly(); });
        bar.querySelector('#mapedit_gundo').addEventListener('click', function () { _history('undo'); });
        bar.querySelector('#mapedit_gredo').addEventListener('click', function () { _history('redo'); });
        bar.querySelector('#mapedit_clear_all').addEventListener('click', function () { _closeFly(); _clearAll(); });
        bar.querySelector('#mapedit_snap').addEventListener('click', _toggleSnap);
        bar.querySelector('#mapedit_trace').addEventListener('click', function () { if (_trace) _traceStop(true); else _traceStart(); });
        bar.querySelectorAll('[data-goto]').forEach(function (b) {
            b.addEventListener('click', function () { _closeFly(); _reveal(b.getAttribute('data-goto')); });
        });
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
                _zoneCheckSoon();
            });
        }
        // geofence: offline export of the clicked ring
        var gfx = ctx.querySelector('#mapedit_gf_export');
        if (gfx) gfx.addEventListener('click', _gfExport);

        _wireLists();
        document.addEventListener('keydown', _onKey);
        Panel.init({
            rowHtml: rowHtml, markRows: _markRows,
            togglePath: function (n) {
                if (!_mapObjLayer) return;
                _mapObjLayer.setPathHidden(n, !_mapObjLayer.isPathHidden(n));
                _renderList();
            },
            layerOn: _layerOn, setLayer: _setLayer,
            layerMsg: function (k) { return _worldMsg[k] || null; },
            suggestion: _suggestion, frameSuggestion: _frameSuggestion,
            onSuggestions: function (open) { if (_ml) _ml.setSuggestions(open); },
        });
        MO.onChange(_onObjects);
        window.addEventListener('resize', function () { if (_ov && _ov.editing) _showBar(true); });
        // the right panel opening or folding changes the room for the bar
        var rp = document.getElementById('right_panel'), rpW = -1;
        if (rp && window.ResizeObserver) {
            new ResizeObserver(function () {
                if (rp.offsetWidth === rpW) return;
                rpW = rp.offsetWidth;
                if (_ov && _ov.editing) _showBar(true);
            }).observe(rp);
        }
        // a list with more rows than it shows fades at the bottom (E3)
        var ol = document.getElementById('mapedit_obj_list');
        if (ol) ol.addEventListener('scroll', _listFade, { passive: true });

        _built = true;
        _refreshDisabled();
    }

    function _closeFly() {
        document.querySelectorAll('.mapedit-fly.open').forEach(function (f) { f.classList.remove('open'); });
    }
    // Open a section of the panel from the bar. A phone leaves the compact sheet.
    function _reveal(id) {
        var d = document.getElementById(id);
        if (!d) return;
        _compact(false);
        d.open = true;
        if (d.scrollIntoView) d.scrollIntoView({ block: 'nearest' });
    }
    function _listFade() {
        var l = document.getElementById('mapedit_obj_list');
        if (l) l.classList.toggle('vt-more-below', l.scrollHeight - l.scrollTop - l.clientHeight > 2);
    }
    // The bar floats over the map when it fits there in one row, with words or
    // as icons only. Otherwise it is one row of icons at the top of the panel:
    // always on a phone, and on a tablet or a phone on its side, where the map
    // between the panel and the right panel is narrow (D7, E1). Its two one-row
    // widths are measured once per language (the words change them).
    var _barW = null;
    function _barMode(bar) {
        if (window.innerWidth < 576) return 'panel';
        var tools = bar.querySelector('.mapedit-bar-tools');
        if (!tools) return 'float';
        if (!_barW) {
            var home = bar.parentNode, next = bar.nextSibling, cls = bar.className;
            document.body.appendChild(bar);
            bar.classList.remove('in-panel', 'icons');
            bar.classList.add('on', 'mapedit-measure');
            var full = tools.offsetWidth;
            bar.classList.add('icons');
            _barW = { full: full, icons: tools.offsetWidth };
            bar.className = cls;
            if (home && home !== document.body) home.insertBefore(bar, next);
        }
        // the room as vt_mapedit.css places it: right of the compass, 22 px off the right panel
        var d = document.getElementById('ui_drawer'), rp = document.getElementById('right_panel');
        var left = (d && d.classList.contains('open') && !d.classList.contains('full')) ? d.offsetLeft + d.offsetWidth : 0;
        var rpw = (rp && rp.offsetWidth) ? Math.max(0, window.innerWidth - rp.getBoundingClientRect().left) : 0;
        var free = window.innerWidth - left - rpw - 98;
        return free >= _barW.full ? 'float' : (free >= _barW.icons ? 'icons' : 'panel');
    }
    function _showBar(on) {
        var bar = document.getElementById('mapedit_bar'), host = document.getElementById('mapedit_tools');
        if (!bar || !host) return;
        var mode = on ? _barMode(bar) : (window.innerWidth < 576 ? 'panel' : 'float');
        var want = mode === 'panel' ? host : document.body;
        if (bar.parentNode !== want) want.appendChild(bar);
        bar.classList.toggle('in-panel', mode === 'panel');
        host.classList.toggle('mapedit-tools-on', mode === 'panel' && !!on);   // sticks to the top of the panel
        bar.classList.toggle('icons', mode === 'icons');
        bar.classList.toggle('on', !!on);
        var h = (on && mode !== 'panel') ? bar.offsetHeight + 8 : 0;
        if (h !== _barH) {
            _barH = h;
            document.documentElement.style.setProperty('--mapedit-bar-h', h + 'px');
        }
    }
    var _barH = -1;

    // ---- layers panel
    var _worldSub = {}, _worldMsg = {};
    var BRIDGED = { terrain: 'mapv3_chk_terrain', aerial: 'mapv3_chk_aerial', mow_load: 'mapv3_chk_mowload' };   // layers of the Map tab
    function _layerOn(k) {
        if (BRIDGED[k]) { var c = document.getElementById(BRIDGED[k]); return !!(c && c.checked); }
        return _show[k] !== false;
    }
    function _setLayer(k, on) {
        if (BRIDGED[k]) {
            var c = document.getElementById(BRIDGED[k]);
            if (c) { c.checked = !!on; c.dispatchEvent(new Event('change')); }
            return;
        }
        _show[k] = !!on;
        _saveShow(k);
        _applyShow(k);
    }
    function _dropWorld(k) {
        var sub = _worldSub[k];
        if (sub) { try { sub.unsubscribe(); } catch (e) {} }
        delete _worldSub[k];
        delete _worldMsg[k];
        if (_ml) _ml.dropWorld(k);
    }
    function _applyWorld(k) {
        if (!_show[k] || !(_ov && _ov.editing)) { _dropWorld(k); return; }
        if (_worldSub[k]) return;
        _worldSub[k] = MO.subscribeLayer(k, function (m) {
            _worldMsg[k] = m;
            if (_ml) _ml.setWorld(k, m);
            Panel.setLegend(k);
        });
    }
    function _applyAllShow() { for (var k in SHOW_KEYS) _applyShow(k); }
    function _applyShow(k) {
        if (k === 'waypoints') { if (_mapObjLayer) _mapObjLayer.setWaypointsVisible(_show.waypoints); }
        else if (k === 'paths') { if (_mapObjLayer) _mapObjLayer.setPathsVisible(_show.paths); }
        else if (k === 'edits') { if (_layer) { _layer.group.visible = !!_show.edits; if (_ov) _ov.markDirty(); } }
        else if (k === 'places') { if (_ml) _ml.group.visible = !!_show.places; }
        else if (k === 'zones') {
            _applyZonesVisible(_show.zones);
            if (_zoneLayer) { _zoneLayer.group.visible = !!_show.zones; if (_ov) _ov.markDirty(); }
        } else _applyWorld(k);
        _rescaleLabels(true);
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

    // the hint is a key (+ vars, or a function giving them); kept so a
    // language switch can re-draw it
    var _hintK = null, _hintV = null;
    function _setHint(k, v) {
        _hintK = k || null; _hintV = v || null;
        var h = document.getElementById('mapedit_hint');
        if (h) h.textContent = k ? t(k, (typeof v === 'function') ? v() : v) : '';
    }
    // A short code from a robot node, in words; the planner's own text as it comes.
    function _reason(r) {
        if (r.timeout) return t('medits.sel.no_answer');
        var c = String(r.code || r.reason || ''), i = c.indexOf(':');
        var k = 'medits.reason.' + (i < 0 ? c : c.slice(0, i));
        var s = t(k, { detail: i < 0 ? '' : c.slice(i + 1) });
        return s !== k ? s : (r.reason || c || t('medits.reason.failed'));
    }
    function _sayReason(r) { var x = _reason(r); _setHint('medits.hint.raw', { text: x }); }
    function _warnings(r) {
        (r.warnings || []).forEach(function (w) {
            var i = String(w).indexOf(':'), c = i < 0 ? w : w.slice(0, i), k = 'medits.warn.' + c;
            var s = t(k, { detail: i < 0 ? '' : String(w).slice(i + 1) });
            if (s !== k) Panel.toast(s);
        });
    }
    function _refreshDisabled() {
        // Obstacle/Free/Wall/Delete/Clear need the edits backend; if the shared
        // polygon isn't ready (planner not inited) the draw tools still function
        // once map_edit.js has run — nothing hard-disabled here, but hint.
    }

    // ---- tool state machine ----
    function _setToolButtonsActive(mode) {
        var bar = document.getElementById('mapedit_bar'); if (!bar) return;
        bar.querySelectorAll('[data-tool]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-tool') === mode);
        });
        bar.querySelectorAll('[data-group]').forEach(function (b) {
            var f = bar.querySelector('[data-fly="' + b.getAttribute('data-group') + '"]');
            b.classList.toggle('has-tool', !!f.querySelector('[data-tool="' + mode + '"]'));
        });
        var gw = document.getElementById('mapedit_gf_wrap');
        if (gw) gw.style.display = (mode === 'geofence') ? '' : 'none';
        var ww = document.getElementById('mapedit_wall_wrap');
        if (ww) ww.style.display = (mode === 'edit_wall') ? '' : 'none';
        var en = document.getElementById('mapedit_edit_name_wrap');
        if (en) en.style.display = (EDIT_KIND[mode] || (PLACE_TOOL[mode] && mode !== 'obj_landmark')) ? '' : 'none';
        var pw = document.getElementById('mapedit_path_wrap');
        if (pw) pw.style.display = (mode === 'path') ? '' : 'none';
        _refreshActions();
    }

    function _isDraw(mode) {
        return mode === 'edit_obstacle' || mode === 'edit_free' || mode === 'edit_wall'
            || mode === 'path' || mode === 'geofence' || mode === 'zone' || mode === 'measure' || mode === 'zone_split'
            || (!!PLACE_TOOL[mode] && mode !== 'obj_landmark');
    }
    function _isOpenTool(mode) {
        return mode === 'path' || mode === 'edit_wall' || mode === 'obj_corridor' || mode === 'measure' || mode === 'zone_split';
    }
    // Undo / Delete point / Save or Finish / Cancel: one place for a new shape
    // and for an existing one. Save and Cancel appear with the first change.
    function _refreshActions() {
        var fin = document.getElementById('mapedit_finish'), can = document.getElementById('mapedit_cancel');
        if (!fin || !can) return;
        var draw = _isDraw(_tool), dirty = _dirty(), saving = !!(_draft && _draft.saving) || _drawSaving;
        fin.style.display = ((draw && _tool !== 'measure') || dirty) ? '' : 'none';
        can.style.display = (draw || dirty) ? '' : 'none';
        fin.disabled = saving;
        can.disabled = saving;
        // Finish means "save" everywhere except the geofence, where it means
        // "send this ring to the agent as a PROPOSAL". Say so on the button, so
        // nobody reads it as "apply the fence".
        _tag(fin, saving ? 'common.saving' : (dirty ? 'common.save'
            : (_tool === 'geofence' ? 'medits.gf.send' : (_tool === 'zone_split' ? 'medits.split' : 'medits.finish'))));
        var P = sharedPolygon();
        var hasShape = draw || (!!_draft && _draft.kind !== 'waypoint');
        var row = document.getElementById('mapedit_shape_tools');
        if (row) row.style.setProperty('display', hasShape ? 'flex' : 'none', 'important');
        var un = document.getElementById('mapedit_undo'), dv = document.getElementById('mapedit_del_vertex');
        if (un) un.disabled = !(P && P.canUndo());
        if (dv) dv.disabled = !(P && P.selected >= 0 && P.pointContainer.children.length > (P.minPoints || 0));
        var st = document.getElementById('mapedit_status');
        if (st) st.hidden = !(draw || !!_draft);
        // a phone while drawing: the readout row alone, the tool row comes back
        // with Finish or Cancel (vt_mapedit.css, compact sheet only)
        var bar = document.getElementById('mapedit_bar');
        if (bar) bar.classList.toggle('drawing', draw);
        var tr = document.getElementById('mapedit_trace');
        if (tr) tr.style.display = (draw && _tool !== 'zone_split') ? '' : 'none';
        _paintLive();
        _showBar(!!(_ov && _ov.editing));
    }
    // Length and area of what is being drawn, as it is drawn.
    function _paintLive() {
        var el = document.getElementById('mapedit_live');
        if (!el) return;
        var pts = _curPts(), P = sharedPolygon(), txt = '';
        if (pts.length >= 2 && (_isDraw(_tool) || _draft)) {
            var len = MO.lineLength(pts).toFixed(2);
            if (_tool === 'measure') txt = pts.length > 2
                ? t('medits.live.measure', { m: len, a: MO.polyArea(pts).toFixed(2) }) : t('medits.live.line', { m: len });
            else if (P && P.openLine) txt = t('medits.live.line', { m: len });
            else if (pts.length > 2) txt = t('medits.live.area', { a: MO.polyArea(pts).toFixed(2), m: MO.perimeter(pts).toFixed(2) });
        }
        if (_trace) txt = (txt ? txt + ' · ' : '') + t('medits.trace.on');
        el.textContent = txt;
    }
    function _removeSelectedVertex() {
        var P = sharedPolygon();
        if (P && P.selected >= 0) P.remPoint(P.selected);
    }
    function _onKey(ev) {
        if (!_ov || !_ov.editing) return;
        var el = ev.target, tag = el && el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        var P = sharedPolygon(), key = ev.key;
        var mod = ev.ctrlKey || ev.metaKey;
        if (mod && (key === 'z' || key === 'Z' || key === 'y' || key === 'Y')) {
            ev.preventDefault();
            if (ev.shiftKey || key === 'y' || key === 'Y') _history('redo');
            else if (P && P.attached && P.canUndo()) P.undo();      // the open shape first
            else _history('undo');
        } else if (key === 'Delete' || key === 'Backspace') {
            ev.preventDefault();
            if (P && P.attached && P.selected >= 0) _removeSelectedVertex();
            else if (_sel && !_dirty()) _deleteSel(_sel);
        } else if (key === 'Escape') {
            // vt_frame.js takes Esc first: it is STOP everywhere, here too.
            if (_wpInput) _hideWpInput();
            else if (P && P.attached && P.selected >= 0) P.select(-1);
            else if (_draft && _dirty() && !_draft.saving) _revertShape();
            else if (_tool !== 'off') _setTool('off');
            else if (_sel && !_dirty()) _deselect();
        }
    }
    function _history(which) {
        if (_dirty()) { _setHint('medits.sel.save_first'); return; }
        var h = MO.state.history;
        if (!h || !(which === 'undo' ? h.can_undo : h.can_redo)) return;
        MO.op({ op: which }, function (r) { if (!r.ok) _sayReason(r); });
    }
    function _toggleSnap() {
        _snapOn = !_snapOn;
        try { localStorage.setItem(SNAP_KEY, _snapOn ? '1' : '0'); } catch (e) {}
        _paintSnap();
    }
    function _paintSnap() {
        var b = document.getElementById('mapedit_snap');
        if (b) { b.classList.toggle('active', _snapOn); b.setAttribute('aria-pressed', _snapOn ? 'true' : 'false'); }
    }

    // ---- snap to the vertices and edges of what is on the map. Alt or the bar's
    // magnet turns it off. The dragged vertex and the stored copy of the selected
    // object do not count.
    var SNAP_KEY = 'vitulus_editor_snap';
    var _snapOn = (function () { try { return localStorage.getItem(SNAP_KEY) !== '0'; } catch (e) { return true; } })();
    function _snapSets(skip) {
        var sets = [], own = _curPts();
        if (skip >= 0) own.splice(skip, 1);
        sets.push({ pts: own, closed: false });
        function isSel(kind, name) { return !!_sel && _sel.kind === kind && _sel.name === name; }
        if (_mapObjLayer && _show.waypoints) _mapObjLayer.waypoints.forEach(function (w) {
            if (!isSel('waypoint', w.name)) sets.push({ pts: [[w.x, w.y]], closed: false });
        });
        if (_mapObjLayer && _show.paths) _mapObjLayer.paths.forEach(function (x) {
            if (!isSel('path', x.name) && !_mapObjLayer.isPathHidden(x.name)) sets.push({ pts: x.points || [], closed: false });
        });
        if (_layer && _show.edits) _layer.edits.forEach(function (e) {
            if (!isSel('edit', e.name)) sets.push({ pts: e.points || [], closed: e.kind !== 'wall' });
        });
        if (_zoneLayer && _show.zones) _zoneLayer.zones.forEach(function (z) {
            if (!isSel('zone', z.name)) sets.push({ pts: z.points, closed: true });
        });
        if (_show.places) MO.places().forEach(function (o) {
            if (!isSel('place', o.name)) sets.push({ pts: o.points || [], closed: o.geometry === 'area' });
        });
        return sets;
    }
    function _snapHit(world, ev, skip) {
        if (!_ov || !_snapOn || (ev && ev.altKey) || !(_isDraw(_tool) || _draft)) return null;
        return MO.snapPoint(world, _snapSets(skip), _ov.worldTol(ev && ev.pointerType === 'mouse' ? 10 : 16));
    }
    function snap(world, ev, skip) {
        var hit = _snapHit(world, ev, skip);
        if (_ml) _ml.showSnap(hit, _ov ? _ov.worldTol(9) : 0.2);
        return hit ? { x: hit.x, y: hit.y } : world;
    }
    function onHover(world, ev) { if (_isDraw(_tool)) snap(world, ev, -1); }
    function onDragEnd() { if (_ml) _ml.showSnap(null); }

    // ---- trace by driving: the robot's position, as it is driven by a person or
    // by anything else, goes into the open draft. It records and nothing more.
    var _trace = null, TRACE_STEP_M = 0.2, TRACE_SIMPLIFY_M = 0.05;
    function _traceStart() {
        var P = sharedPolygon(), tf = window.__tf_client_map;
        if (!P || !P.attached || !tf) { _setHint('medits.trace.no_pose'); return; }
        P.checkpoint();     // one Undo takes the whole trace back
        var tr = { sampler: new MO.TraceSampler(TRACE_STEP_M), first: P.pointContainer.children.length, fn: null };
        tr.fn = function (x) {
            if (_trace !== tr || !P.attached || !x || !x.translation) return;
            if (tr.sampler.add(x.translation.x, x.translation.y)) P.appendPoint({ x: x.translation.x, y: x.translation.y });
        };
        _trace = tr;
        tf.subscribe('base_link', tr.fn);
        _paintTrace();
        _setHint('medits.trace.hint');
    }
    function _traceStop(keep) {
        var tr = _trace, P = sharedPolygon();
        if (!tr) return;
        _trace = null;
        try { window.__tf_client_map.unsubscribe('base_link', tr.fn); } catch (e) {}
        if (keep && P && P.attached && tr.sampler.pts.length > 2) {
            var pts = _curPts().slice(0, tr.first).concat(MO.simplify(tr.sampler.pts, TRACE_SIMPLIFY_M));
            P.setPoints(pts, true);  // the checkpoint of the start stays the way back
        }
        _paintTrace();
        if (keep) _setHint('medits.trace.done', { n: _curPts().length });
    }
    function _paintTrace() {
        var b = document.getElementById('mapedit_trace');
        if (!b) return;
        var k = _trace ? 'medits.trace.stop' : 'medits.trace.start';
        b.classList.toggle('active', !!_trace);
        VTI18n.tag(b, k, 'title');
        VTI18n.tag(b, k, 'aria-label');
        _paintLive();
    }

    function _teardownTool() {
        // detach + clear the shared polygon if we were drawing edits
        var P = sharedPolygon();
        _closeArmed = 0;
        if (_tool === 'zone' && window.mapEditZoneApi) window.mapEditZoneApi.close();
        if (P) { P.openLine = false; P.showMids = false; P.minPoints = 0; P.onChange = null; }
        _traceStop(false);
        if (_ml) { _ml.showSnap(null); _ml.setPreview(null); }
        if (P && P.attached && _ov) {
            try { _ov.scene.removeChild(P); } catch (e) {}
            _clearPolygon(P);
        }
        _hideWpInput();
        _gfStopTicker();
        _drawSaving = false;
        _zoneCheckClear();
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
        if (PLACE_TOOL[mode] && !MO.live()) { _setHint('medits.obj.offline'); return; }
        var splitOf = (mode === 'zone_split' && _sel) ? _sel.name : null;
        _deselect();
        _teardownTool();
        _tool = mode || 'off';
        _splitZone = splitOf;
        if (_ov && _ov.setToolMode) _ov.setToolMode(_tool);
        _setToolButtonsActive(_tool);
        if (_tool !== 'off') _compact(true);

        if (_isDraw(_tool)) {
            var P = sharedPolygon();
            if (!P) { _setHint('medits.hint.not_ready'); _setTool('off'); return; }
            _clearPolygon(P);
            // path + barrier are open polylines - no closing edge, no fill
            P.openLine = _isOpenTool(_tool);
            P.showMids = true;
            P.onChange = _onDrawChange;
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
            } else if (_tool === 'measure') {
                _setHint('medits.hint.measure');
            } else if (_tool === 'zone_split') {
                _setHint('medits.hint.split', { name: _splitZone });
            } else if (_tool === 'path') {
                var pn = document.getElementById('mapedit_path_name');
                if (pn) pn.value = nextName('path', _names('path'));
                _setHint('medits.hint.path');
            } else if (PLACE_TOOL[_tool]) {
                var pl = document.getElementById('mapedit_edit_name');
                if (pl) pl.value = nextName(PLACE_TOOL[_tool], _names('place'));
                _setHint('medits.hint.obj.' + PLACE_TOOL[_tool]);
            } else {
                var nm = document.getElementById('mapedit_edit_name');
                if (nm) nm.value = nextName(EDIT_KIND[_tool], _names('edit'));
                _setHint(_tool === 'edit_wall'
                    ? 'medits.hint.wall'
                    : (_tool === 'edit_obstacle' ? 'medits.hint.obstacle' : 'medits.hint.free'));
            }
        } else if (_tool === 'waypoint') {
            _setHint('medits.hint.waypoint');
        } else if (_tool === 'obj_landmark') {
            _setHint('medits.hint.obj.landmark');
        } else {
            _setHint('medits.hint.pick');
        }
        _paintSnap();
        _refreshActions();
        if (_tool !== 'off') _ctxIntoView(true);
    }
    // Tablet or phone on its side: the panel may be scrolled away from the
    // inspector. Bring it up under the tool bar. The compact sheet of a phone
    // shows it anyway, a panel that shows it stays. endFirst: when it is taller
    // than the room, its end with Finish comes first (a tool), else its head.
    function _ctxIntoView(endFirst) {
        if (window.innerWidth < 576) return;
        var c = document.getElementById('mapedit_context'), body = document.getElementById('ui_drawer_body');
        var bar = document.getElementById('mapedit_bar');
        if (!c || !body) return;
        var rc = c.getBoundingClientRect(), rb = body.getBoundingClientRect();
        var host = document.getElementById('mapedit_tools');
        var top = rb.top + (bar && bar.classList.contains('in-panel') && host ? host.offsetHeight : 0);
        if (rc.top >= top && rc.bottom <= rb.bottom) return;
        body.scrollTop += (endFirst && rc.height > rb.bottom - top) ? rc.bottom - rb.bottom + 4 : rc.top - top - 8;
    }
    var _drawSaving = false, _splitZone = null;
    function _onDrawChange() {
        _refreshActions();
        if (_tool === 'zone') _zoneCheckSoon();
    }

    // A new object of the server: the drawing stays until the server took it,
    // a refusal (a no-go over the dock) must not cost the shape.
    function _saveNew(type, name, pts, then) {
        var tt = MO.TYPES[type];
        var obj = { family: 'place', type: type, name: name, geometry: tt.geometry, points: pts, source: 'owner', props: {} };
        if (type === 'slow') obj.props.speed_mps = MO.SPEED_DEF;
        if (type === 'corridor') { obj.props.width_m = MO.CORRIDOR_W; obj.props.connects = []; }
        _drawSaving = true;
        _refreshActions();
        MO.op({ op: 'save', object: obj }, function (r) {
            _drawSaving = false;
            if (!r.ok) { _sayReason(r); _refreshActions(); return; }
            _warnings(r);
            if (then) then();
            _setTool('off');
            _select('place', name, { awaited: true });
            _setHint('medits.sel.saved', { name: name });
        });
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
        if (_tool === 'zone_split') { _finishSplit(); return; }
        var P = sharedPolygon();
        if (!P) { _setTool('off'); return; }
        var pts = _curPts();
        if (PLACE_TOOL[_tool]) { _finishPlace(pts); return; }
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
    function _finishPlace(pts) {
        var type = PLACE_TOOL[_tool], line = type === 'corridor', minPts = line ? 2 : 3;
        if (pts.length < minPts) { _setHint('medits.hint.need_pts.any', { n: minPts }); return; }
        if (!line && _crosses(pts)) { _setHint('medits.shape.crosses'); return; }
        if (!line && MO.polyArea(pts) < MO.MIN_AREA) { _setHint('medits.shape.too_small'); return; }
        var ne = document.getElementById('mapedit_edit_name');
        var name = (ne && ne.value ? ne.value : '').trim() || nextName(type, _names('place'));
        var bad = nameProblem(name, _names('place'));
        if (bad) { _setHint('medits.name.err.' + bad, { name: name }); return; }
        _saveNew(type, name, pts);
    }
    function _finishSplit() {
        var pts = _curPts(), name = _splitZone;
        if (pts.length !== 2) { _setHint('medits.hint.split', { name: name }); return; }
        _drawSaving = true;
        _refreshActions();
        MO.zoneOp({ op: 'split', name: name, line: pts }, function (r) {
            _drawSaving = false;
            if (!r.ok) { _sayReason(r); _refreshActions(); return; }
            _setTool('off');
            _select('zone', name, { awaited: true });
            _setHint('medits.zone.split_done', { name: name, other: (r.names || []).join(', ') });
        });
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
        if (_tool === 'obj_landmark') {
            if (_drawSaving) return true;
            _saveNew('landmark', nextName('landmark', _names('place')), [[world.x, world.y]]);
            return true;
        }
        if (_tool === 'zone_split' && _curPts().length >= 2) return true;
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

    // =====================================================================
    // SELECTION — the one place for an object: tap it on the map or pick it from
    // its list (both stay in step), the card in the context box gives its name,
    // shape, settings and Delete. The shape opens right away; nothing is written
    // to the robot before Save, and Save and Cancel appear with the first change.
    // kind: 'zone' | 'edit' | 'path' | 'waypoint' | 'place'.
    // =====================================================================
    var _sel = null;     // {kind, name}
    var _draft = null;   // {kind, name, id, orig:[[x,y]..], width, yaw, widthNow, yawNow, meta, metaOrig, formDirty, saving, timer}
    var SAVE_TIMEOUT_MS = 15000;   // an edit re-serves the whole raster
    var SAME_M = 0.005;  // zone points travel as float32
    // Results and lists are separate topics: the list with the new or renamed
    // object may come just after the result. It is not "gone" until this passes.
    var AWAIT_MS = 4000;

    function _objOf(sel) {
        if (!sel) return null;
        var list = sel.kind === 'zone' ? (_zoneLayer ? _zoneLayer.zones : [])
            : sel.kind === 'place' ? MO.places()
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
            || _metaDirty(d) || !_samePts(_curPts(), d.orig);
    }
    function _isOpen(kind, o) {
        return kind === 'path' || kind === 'waypoint' || (kind === 'edit' && o.kind === 'wall')
            || (kind === 'place' && o.geometry !== 'area');
    }
    function _isPoint(kind, o) { return kind === 'waypoint' || (kind === 'place' && o.geometry === 'point'); }
    function _typeOf(kind, o) { return kind === 'edit' ? (o.kind || 'obstacle') : (kind === 'place' ? o.type : kind); }

    // ---- what an object means. Lives on the server's object; the draft holds a
    // copy so the same Save and Cancel cover shape and meaning.
    function _metaFrom(type, m) {
        m = m || {};
        var p = m.props || {}, props = {};
        if (type === 'place' || type === 'landmark') props.category = p.category || '';
        if (type === 'slow') props.speed_mps = p.speed_mps != null ? p.speed_mps : MO.SPEED_DEF;
        if (type === 'corridor') {
            props.width_m = p.width_m != null ? p.width_m : MO.CORRIDOR_W;
            props.connects = (p.connects || []).slice();
        }
        return { note: m.note || '', aliases: (m.aliases || []).slice(), tags: (m.tags || []).slice(),
                 valid_from: m.valid_from != null ? m.valid_from : null,
                 valid_until: m.valid_until != null ? m.valid_until : null, props: props };
    }
    function _metaObj(kind, name) { return kind === 'place' ? MO.find('place', name) : MO.find(kind, name); }
    function _metaDirty(d) { return JSON.stringify(d.meta) !== d.metaOrig; }

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
    // Headings for a reshaped path. A recorded path carries the robot's real
    // heading per pose, which the drawn line cannot give back. Those stay, except
    // where the line changed: a pose moved or added, and the neighbours of such a
    // pose, take the direction of their segment (save_path_at's rule for a drawn
    // path: towards the next point, the last pose along its segment).
    function pathYaws(orig, yaws, pts) {
        var EPS = 1e-6, at = [], from = 0, i, k;
        for (i = 0; i < pts.length; i++) {
            at[i] = -1;
            for (k = from; k < orig.length; k++) {
                if (Math.abs(orig[k][0] - pts[i][0]) < EPS && Math.abs(orig[k][1] - pts[i][1]) < EPS) {
                    at[i] = k; from = k + 1;
                    break;
                }
            }
        }
        function dir(a, b) { return (a[0] === b[0] && a[1] === b[1]) ? null : Math.atan2(b[1] - a[1], b[0] - a[0]); }
        var out = [], n = pts.length;
        for (i = 0; i < n; i++) {
            var same = at[i] >= 0 && (i === 0 || at[i - 1] === at[i] - 1) && (i === n - 1 || at[i + 1] === at[i] + 1);
            if (same) { out.push(yaws[at[i]]); continue; }
            var y = i < n - 1 ? dir(pts[i], pts[i + 1]) : null;
            if (y === null && i > 0) y = dir(pts[i - 1], pts[i]);
            out.push(y !== null ? y : (i > 0 ? out[i - 1] : 0));
        }
        return out;
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
        if (_show.places) {
            MO.places().forEach(function (o) {
                var op = o.points || [];
                if (o.geometry === 'point') {
                    if (op.length && Math.hypot(world.x - op[0][0], world.y - op[0][1]) <= tol) out.push({ kind: 'place', name: o.name, rank: 0, size: 0 });
                } else if (o.geometry === 'line') {
                    var hw = ((o.props && o.props.width_m) || MO.CORRIDOR_W) / 2 + tol;
                    for (var c = 0; c + 1 < op.length; c++) {
                        if (_distToSeg(world, op[c], op[c + 1]) <= hw) { out.push({ kind: 'place', name: o.name, rank: 1, size: 0 }); break; }
                    }
                } else ring('place', o.name, op, 2);
            });
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
        if (body && window.innerWidth < 576) body.scrollTop = 0;
        else if (!(opts && opts.frame)) _ctxIntoView(false);   // a pick from the list keeps the list where it is
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
        var kind = _sel.kind, pts = _ptsOf(kind, o), point = _isPoint(kind, o);
        _clearPolygon(P);
        P.openLine = _isOpen(kind, o);
        P.showMids = !point;
        P.minPoints = point ? 1 : (P.openLine ? 2 : 3);
        // a rule keeps its hatch while selected: the handles say it is selected
        if (P.fillMesh) P.fillMesh.material.opacity = kind === 'place' ? 0.06 : 0.28;
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
                   yaws: o.yaws ? o.yaws.slice() : null, type: _typeOf(kind, o),
                   editKind: o.kind, formDirty: false, saving: false, timer: null };
        var mo = _metaObj(kind, o.name);
        _draft.id = mo ? mo.id : null;
        _draft.meta = _metaFrom(_draft.type, mo);
        _draft.metaOrig = JSON.stringify(_draft.meta);
        if (kind === 'waypoint') _showYawPreview(o.x, o.y, o.yaw || 0);
    }
    function _endShape() {
        var P = sharedPolygon(), d = _draft;
        _draft = null;
        _closeArmed = 0;
        if (d && d.timer) clearTimeout(d.timer);
        if (P) { P.onChange = null; P.openLine = false; P.showMids = false; P.minPoints = 0; }
        if (d && d.kind === 'zone') { window.mapEditZoneApi.close(); _zoneCheckClear(); }
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
        if (d.kind === 'path' && !(d.yaws && d.yaws.length === d.orig.length)) return 'medits.shape.no_yaws';
        var closed = d.kind === 'zone' || (d.kind === 'edit' && d.editKind !== 'wall')
            || (d.kind === 'place' && MO.TYPES[d.type].geometry === 'area');
        if (closed && _crosses(pts)) return 'medits.shape.crosses';
        if (d.kind === 'place' && closed && MO.polyArea(pts) < MO.MIN_AREA) return 'medits.shape.too_small';
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
        if (d.kind === 'zone') _zoneCheckSoon();
    }

    function _saveShape() {
        var d = _draft;
        if (!d || d.saving) return;
        var bad = _shapeProblem();
        if (bad) { _setHint(bad); return; }
        var pts = _curPts();
        var shapeSame = _samePts(pts, d.orig) && d.widthNow === d.width && d.yawNow === d.yaw && !d.formDirty;
        var changes = _metaDirty(d) ? MO.metaChanges(JSON.parse(d.metaOrig), d.meta) : null;
        d.saving = true;
        function answered(r) {
            if (_draft !== d) return;
            if (r.ok) { _warnings(r); return; }
            d.saving = false;
            if (d.timer) { clearTimeout(d.timer); d.timer = null; }
            _sayReason(r);
            _refreshActions();
        }
        if (d.kind === 'place') {
            var up = Object.assign({ op: 'update', id: d.id }, changes || {});
            if (!_samePts(pts, d.orig)) up.points = pts;
            MO.op(up, answered);
        } else if (changes && d.id) {
            MO.op(Object.assign({ op: 'update', id: d.id }, changes), answered);
        }
        if (d.kind === 'zone' && !shapeSame) {
            window.mapEditZoneApi.save();   // answers through onZoneResult
            _refreshActions();
            return;
        }
        d.target = pts;
        d.metaTarget = changes ? JSON.stringify(d.meta) : null;
        if (!shapeSame) {
            if (d.kind === 'edit') {
                _layer.saveEdit({ kind: d.editKind, name: d.name, points: pts, width_m: d.widthNow });
            } else if (d.kind === 'path') {
                d.targetYaws = pathYaws(d.orig, d.yaws, pts);
                _pub_path_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: d.name, points: pts, yaws: d.targetYaws }) }));
            } else if (d.kind === 'waypoint') {
                _publishWaypointAt(d.name, pts[0][0], pts[0][1], d.yawNow || 0);
            }
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
        if (d.metaTarget && JSON.stringify(_metaFrom(d.type, _metaObj(d.kind, d.name))) !== d.metaTarget) return false;
        if (d.kind === 'edit' && d.editKind === 'wall' && o.width_m !== d.widthNow) return false;
        if (d.kind === 'waypoint' && _angleOff(o.yaw || 0, d.yawNow || 0) > 0.01) return false;
        if (d.kind === 'path' && d.targetYaws) {
            var ny = o.yaws || [];
            if (ny.length !== d.targetYaws.length) return false;
            for (var i = 0; i < ny.length; i++) if (_angleOff(ny[i], d.targetYaws[i]) > 1e-6) return false;
        }
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
        if (d && !d.saving && !_dirty() && (!_samePts(_ptsOf(d.kind, o), d.orig)
                || JSON.stringify(_metaFrom(d.type, _metaObj(d.kind, d.name))) !== d.metaOrig)) _reopenShape();
        _paintSelStats();
    }
    function _zoneData() {
        var api = window.mapEditZoneApi;
        if (!_zoneLayer || !api) return;
        _zoneLayer.set(api.list());
        _renderList();
        _onData();
        _markRows();
    }

    // The server's lists changed.
    function _onObjects(what) {
        if (!_ov || !_ov.editing) return;
        if (what === 'objects') {
            if (_ml) _ml.setPlaces(MO.places(), Date.now() / 1000);
            _renderList();
            if (_draft && !_draft.id) {   // the id arrived after the card opened
                var m = _metaObj(_draft.kind, _draft.name);
                if (m) { _draft.id = m.id; if (!_dirty()) _reopenShape(); }
            }
            _onData();
        } else if (what === 'history') {
            var h = MO.state.history || {}, u = document.getElementById('mapedit_gundo'), r = document.getElementById('mapedit_gredo');
            if (u) u.disabled = !h.can_undo;
            if (r) r.disabled = !h.can_redo;
            Panel.renderHistory();
        } else if (what === 'suggestions') Panel.renderSuggestions();
    }

    // ---- the one list: everything of the map, meaning first
    function _rows() {
        var rows = [], now = Date.now() / 1000;
        function add(kind, type, name, meta, dim) {
            var m = _metaObj(kind, name), rs = m && MO.TEMPORARY[type] ? MO.ruleState(m, now) : null;
            rows.push({ kind: kind, type: type, name: name, meta: meta, dim: !!dim,
                        note: m ? m.note : '', aliases: m ? m.aliases : [], tags: m ? m.tags : [],
                        category: (m && m.props && m.props.category) || '',
                        state: rs ? rs.state : null, temporary: !!(rs && rs.temporary) });
        }
        function size(pts, line) { return (line ? MO.lineLength(pts).toFixed(1) + ' m' : MO.polyArea(pts).toFixed(1) + ' m²'); }
        MO.places().forEach(function (o) {
            add('place', o.type, o.name, o.geometry === 'point' ? '' : size(o.points || [], o.geometry === 'line'));
        });
        if (_zoneLayer) _zoneLayer.zones.forEach(function (z) { add('zone', 'zone', z.name, z.area + ' m²'); });
        ((_layer && _layer.edits) || []).forEach(function (e) {
            add('edit', e.kind || 'obstacle', e.name || '', size(e.points || [], e.kind === 'wall'));
        });
        _wpNames.slice().sort(function (a, b) { return MO.isProtectedName(b) - MO.isProtectedName(a); })
            .forEach(function (n) { add('waypoint', 'waypoint', n, ''); });
        ((_mapObjLayer && _mapObjLayer.paths) || []).forEach(function (x) {
            add('path', 'path', x.name || '', size(x.points || [], true), _mapObjLayer.isPathHidden(x.name));
        });
        return rows;
    }
    var _listQueued = false;
    function _renderList() {
        if (_listQueued) return;
        _listQueued = true;
        (window.requestAnimationFrame || setTimeout)(function () {
            _listQueued = false;
            if (_built) { Panel.renderList(_rows()); _listFade(); }
        });
    }

    // ---- zone preview before saving: what the planner would really mow
    var _zcTimer = null, ZC_DEBOUNCE_MS = 900;
    function _zoneCheckClear() {
        if (_zcTimer) { clearTimeout(_zcTimer); _zcTimer = null; }
        var el = document.getElementById('mapedit_zcheck');
        if (el) el.innerHTML = '';
        if (_ml) _ml.setPreview(null);
    }
    function _zoneCheckSoon() {
        var mine = _tool === 'zone' || (_draft && _draft.kind === 'zone' && _dirty() && !_draft.saving);
        if (_zcTimer) { clearTimeout(_zcTimer); _zcTimer = null; }
        if (!mine) { _zoneCheckClear(); return; }
        _zcTimer = setTimeout(function () {
            _zcTimer = null;
            var pts = _curPts();
            if (pts.length < 3 || _crosses(pts)) return;
            MO.zoneCheck(pts, window.mapEditZoneApi.settings(), _draft ? _draft.name : '', _zoneChecked);
        }, ZC_DEBOUNCE_MS);
    }
    function _zoneChecked(r) {
        var el = document.getElementById('mapedit_zcheck');
        if (!el || r.timeout) return;
        function num(k, v) { return '<div><b>' + _escapeHtml(v) + '</b><span class="vt-muted">' + _escapeHtml(t(k)) + '</span></div>'; }
        var h = '<div class="mapedit-zc-nums">' +
            num('medits.zc.mowable', Number(r.mowable_m2 || 0).toFixed(1) + ' m²') +
            num('medits.zc.unreachable', Number(r.unreachable_m2 || 0).toFixed(1) + ' m²') +
            num('medits.zc.length', Number(r.length_m || 0).toFixed(0) + ' m') +
            num('medits.zc.minutes', Number(r.minutes || 0).toFixed(0) + ' min') + '</div>';
        (r.problems || []).forEach(function (x) {
            var k = 'medits.zc.' + x.code, s = t(k), name = x.params && x.params.name;
            h += '<div class="' + (x.severity === 'error' ? 'text-danger' : 'text-warning') + '">' +
                 _escapeHtml((s !== k ? s : x.code) + (name ? ' (' + name + ')' : '')) + '</div>';
        });
        el.innerHTML = h;
        if (_ml) _ml.setPreview(r.preview);
    }
    // What a mission really uses when a program overrides the zone.
    function _zoneEffective(name) {
        var m = MO.find('zone', name), list = m && m.props && m.props.effective;
        if (Array.isArray(list)) return list;
        var pg = window.programs, all = (pg && pg.program_list_msg && pg.program_list_msg.program_list) || [];
        return all.filter(function (p) {
            return p.override_zone && (p.zone_list || []).some(function (z) { return z.name === name; });
        }).map(function (p) { return { program: p.name, cut_height: p.cut_height, rpm: p.rpm }; });
    }
    function _paintEffective(name) {
        var el = document.getElementById('mapedit_zone_effective');
        if (!el) return;
        el.textContent = (name ? _zoneEffective(name) : []).map(function (e) {
            return t('medits.sel.effective', { program: e.program, cut: e.cut_height, rpm: e.rpm });
        }).join(' ');
    }

    // ---- the inspector: head, status, meaning, rules, status details, actions —
    // the same order for every type. A section that has nothing to set says so.
    function _kindKey(sel, o) { return 'medits.kind.' + _typeOf(sel.kind, o); }
    function _zonePrograms(name) {
        var pg = window.programs, all = (pg && pg.program_list_msg && pg.program_list_msg.program_list) || [];
        return all.filter(function (p) {
            return (p.zone_list || []).some(function (z) { return z.name === name; });
        }).map(function (p) { return p.name; });
    }
    function _inspOpen(k, def) {
        try { var v = localStorage.getItem('vitulus_editsec_insp_' + k); return v === null ? def : v === '1'; } catch (e) { return def; }
    }
    function _insp(k, def, titleKey, body) {
        return '<details class="mapedit-insp" data-insp="' + k + '"' + (_inspOpen(k, def) ? ' open' : '') + '><summary' + _ti(titleKey) + '</summary>' +
               '<div class="mapedit-insp-body">' + body + '</div></details>';
    }
    function _field(k, control) { return '<label class="mapedit-f"><span' + _ti(k) + '</span>' + control + '</label>'; }
    function _input(f, type, val, extra, off) {
        return '<input class="form-control form-control-sm" data-f="' + f + '" type="' + type + '" value="' + _escapeAttr(val == null ? '' : val) + '"' +
               (extra || '') + (off ? ' disabled' : '') + '>';
    }
    function _when(ts) { return ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
    function _pillsHtml(type, m, locked) {
        var h = '';
        function pill(k, st) { h += '<span class="vt-pill"' + (st ? ' data-state="' + st + '"' : '') + _ti(k) + '</span>'; }
        if (m && (MO.TEMPORARY[type])) {
            var rs = MO.ruleState(m, Date.now() / 1000);
            pill('medits.state.' + rs.state, rs.state === 'active' ? 'ok' : 'off');
            if (rs.temporary) pill('medits.state.temporary', 'info');
        }
        if (locked) pill('medits.state.protected', 'brand');
        if (m && m.source && m.source !== 'owner') pill('medits.actor.' + (m.source === 'agent' || m.source === 'robot' ? m.source : 'unknown'));
        return h;
    }
    function _rulesHtml(type, d, off) {
        var p = (d && d.meta.props) || {}, m = (d && d.meta) || {}, h = '';
        if (type === 'zone') return '<div id="mapedit_sel_zone"></div>';
        if (type === 'slow') {
            h += _field('medits.f.speed', '<div class="input-group input-group-sm vt-w-md">' + _input('speed_mps', 'number', p.speed_mps,
                 ' min="' + MO.SPEED_MIN + '" max="' + MO.SPEED_MAX + '" step="0.05"', off) + '<span class="input-group-text">m/s</span></div>');
        }
        if (type === 'place' || type === 'landmark') h += _field('medits.f.category', _input('category', 'text', p.category, ' maxlength="40"', off));
        if (type === 'corridor') {
            h += _field('medits.f.width', '<div class="input-group input-group-sm vt-w-md">' + _input('width_m', 'number', p.width_m, ' min="0.2" max="5" step="0.1"', off) + '<span class="input-group-text">m</span></div>');
            h += _field('medits.f.connects', _input('connects', 'text', (p.connects || []).join(', '), '', off));
        }
        if (MO.TEMPORARY[type]) {
            h += '<div class="mapedit-f-row">' +
                 _field('medits.f.valid_from', _input('valid_from', 'datetime-local', MO.toLocalInput(m.valid_from), '', off)) +
                 _field('medits.f.valid_until', _input('valid_until', 'datetime-local', MO.toLocalInput(m.valid_until), '', off)) + '</div>' +
                 '<div class="vt-fs-xs vt-muted"' + _ti('medits.f.valid_hint') + '</div>';
        }
        return h || '<div class="vt-fs-xs vt-muted"' + _ti('medits.rules.none') + '</div>';
    }
    function _parkZoneForm() {
        var f = document.getElementById('div_zone_template'), slot = document.getElementById('mapedit_zone_slot');
        if (f && slot && f.parentNode !== slot) slot.appendChild(f);
    }
    function _renderSel() {
        var host = document.getElementById('mapedit_sel');
        if (!host) return;
        if (_renaming && _renaming.kind === (_sel && _sel.kind)) return;
        _parkZoneForm();
        var o = _objOf(_sel);
        if (!o) { host.innerHTML = ''; _paintEffective(null); return; }
        var s = _sel, type = _typeOf(s.kind, o), tt = MO.TYPES[type] || {}, m = _metaObj(s.kind, s.name), d = _draft;
        var locked = MO.isProtected(m, s.name);
        var off = !(d && d.id);        // meaning lives on the server
        var h = '<div class="mapedit-sel-head">' +
            '<i class="la ' + (tt.ico || 'la-square') + '" data-type="' + _escapeAttr(type) + '"></i>' +
            '<div class="vt-grow1 vt-min0">' +
            '<div class="mapedit-sel-kind vt-muted"' + _ti(_kindKey(s, o)) + '</div>' +
            '<div class="mapedit-sel-name text-truncate" title="' + _escapeAttr(s.name) + '">' + _escapeHtml(s.name) + '</div>' +
            '</div>' +
            (locked ? '' : '<button class="btn btn-outline-info mapedit-sel-ren" id="mapedit_sel_rename" type="button" data-i18n-title="common.rename" data-i18n-aria-label="common.rename" title="' + _escapeAttr(t('common.rename')) + '" aria-label="' + _escapeAttr(t('common.rename')) + '"><i class="la la-pencil"></i></button>') +
            '<button class="btn btn-outline-secondary mapedit-sel-x" id="mapedit_sel_close" type="button" data-i18n-aria-label="common.close" aria-label="' + _escapeAttr(t('common.close')) + '"><i class="la la-times"></i></button>' +
            '</div>' +
            '<div class="mapedit-pills">' + _pillsHtml(type, m, locked) + '</div>' +
            '<div id="mapedit_sel_stats" class="vt-fs-sm vt-muted vt-minh-line"></div>' +
            '<div id="mapedit_sel_warn" class="vt-fs-sm text-warning"></div>';
        if (type === 'wall') {
            h += '<div class="vt-mt2"><span class="vt-fs-sm vt-block vt-mb1"' + _ti('medits.wall_width') + '</span>' +
                 '<div class="input-group input-group-sm vt-w-md"><input class="form-control" id="mapedit_sel_width" type="number" min="0.02" max="2" step="0.05" value="' + ((d && d.widthNow) || o.width_m || 0.10) + '"><span class="input-group-text">m</span></div></div>';
        }
        if (s.kind === 'waypoint') {
            var yDeg = (d && typeof d.yawNow === 'number') ? ((d.yawNow * 180 / Math.PI) % 360 + 360) % 360 : _wpYawDeg(s.name);
            var y0 = Math.round(yDeg * 2) / 2;
            h += '<div class="vt-fs-sm vt-mt2 vt-mb1 vt-flex vt-aic vt-gap6"><span' + _ti('medits.heading') + '</span>' +
                 ' <input id="mapedit_sel_yawn" class="form-control form-control-sm vt-w-sm vt-pad-s" type="number" min="0" max="359.5" step="0.5" value="' + y0 + '">°</div>' +
                 '<input id="mapedit_sel_yaw" type="range" min="0" max="359.5" step="0.5" value="' + y0 + '" class="vt-w100">';
        }
        var dm = (d && d.meta) || _metaFrom(type, m);
        var more = _insp('meaning', true, 'medits.sec.meaning',
            (off ? '<div class="vt-fs-xs vt-muted vt-mb1"' + _ti('medits.obj.offline') + '</div>' : '') +
            _field('medits.f.note', '<textarea class="form-control form-control-sm" data-f="note" rows="2" maxlength="500"' + (off ? ' disabled' : '') + '>' + _escapeHtml(dm.note) + '</textarea>') +
            _field('medits.f.aliases', _input('aliases', 'text', dm.aliases.join(', '), '', off)) +
            _field('medits.f.tags', _input('tags', 'text', dm.tags.join(', '), '', off)));
        more += _insp('rules', true, 'medits.sec.rules', _rulesHtml(type, d, off));
        var status = '';
        if (s.kind === 'zone') {
            var used = _zonePrograms(s.name);
            status += '<div class="vt-fs-xs vt-muted">' + _escapeHtml(used.length
                    ? t('medits.sel.zone_used', { list: used.join(', ') })
                    : t('medits.sel.zone_unused')) + '</div>';
            status += '<div class="vt-fs-xs vt-muted"' + _ti('medits.sel.zone_start') + '</div>';
        }
        if (m) status += '<div class="vt-fs-xs vt-muted">' + _escapeHtml(t('medits.sel.dates', { created: _when(m.created), updated: _when(m.updated) })) + '</div>';
        status += '<div class="vt-fs-xs vt-muted vt-mt1"' + _ti(_isPoint(s.kind, o) ? 'medits.sel.how_wp' : 'medits.sel.how') + '</div>';
        more += _insp('status', false, 'medits.sec.status', status);
        var acts = '<button class="btn btn-outline-info btn-sm" id="mapedit_sel_dup" type="button"' + _ti('medits.duplicate') + '</button>';
        if (s.kind === 'path') acts += '<button class="btn btn-outline-info btn-sm" id="mapedit_sel_addpt" type="button"' + _ti('medits.add_robot_point') + '</button>';
        if (s.kind === 'zone') acts += '<button class="btn btn-outline-info btn-sm" id="mapedit_sel_split" type="button"' + _ti('medits.split') + '</button>';
        if (!locked) acts += '<button class="btn btn-outline-danger btn-sm" id="mapedit_sel_del" type="button"' + _ti('common.delete') + '</button>';
        var others = s.kind === 'zone' ? _names('zone').filter(function (n) { return n !== s.name; }) : [];
        if (others.length) {
            acts += '<div class="mapedit-merge"><select class="form-select form-select-sm" id="mapedit_sel_merge" aria-label="' + _escapeAttr(t('medits.merge_with')) + '">' +
                    others.map(function (n) { return '<option>' + _escapeHtml(n) + '</option>'; }).join('') + '</select>' +
                    '<button class="btn btn-outline-info btn-sm" id="mapedit_sel_merge_go" type="button"' + _ti('medits.merge') + '</button></div>';
        }
        more += '<div class="mapedit-actions">' + acts + '</div>';
        h += '<div class="mapedit-sel-more">' + more + '</div>';
        host.innerHTML = '<div class="mapedit-sel">' + h + '</div>';
        var zs = host.querySelector('#mapedit_sel_zone');
        if (zs) { zs.appendChild(document.getElementById('div_zone_template')); _paintEffective(s.name); } else _paintEffective(null);
        host.querySelectorAll('details.mapedit-insp').forEach(function (x) {
            x.addEventListener('toggle', function () {
                try { localStorage.setItem('vitulus_editsec_insp_' + x.getAttribute('data-insp'), x.open ? '1' : '0'); } catch (e) {}
            });
        });
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
        host.querySelectorAll('[data-f]').forEach(function (el) { el.addEventListener('input', _metaInput); });
        function on(id, fn) { var b = host.querySelector(id); if (b) b.addEventListener('click', fn); }
        function clean(fn) { return function () { if (_dirty()) { _setHint('medits.sel.save_first'); return; } fn(); }; }
        on('#mapedit_sel_del', clean(function () { _deleteSel(s); }));
        on('#mapedit_sel_dup', clean(function () { _duplicateSel(s); }));
        on('#mapedit_sel_addpt', clean(function () { if (window.map_menu) map_menu.add_path_point(s.name); _setHint('medits.hint.path_point'); }));
        on('#mapedit_sel_split', clean(function () { _setTool('zone_split'); }));
        on('#mapedit_sel_merge_go', clean(function () { _mergeSel(s, host.querySelector('#mapedit_sel_merge').value); }));
        _paintSelStats();
        _setHint(_isPoint(s.kind, o) ? 'medits.sel.how_short_wp' : 'medits.sel.how_short');
    }
    function _metaInput(ev) {
        var d = _draft, el = ev.target, f = el.getAttribute('data-f');
        if (!d) return;
        var m = d.meta, p = m.props;
        if (f === 'note') m.note = el.value;
        else if (f === 'aliases') m.aliases = MO.parseList(el.value);
        else if (f === 'tags') m.tags = MO.parseList(el.value);
        else if (f === 'category') p.category = el.value.trim();
        else if (f === 'speed_mps') p.speed_mps = MO.clampSpeed(el.value);
        else if (f === 'width_m') { var w = parseFloat(el.value); if (isFinite(w) && w > 0) p.width_m = w; }
        else if (f === 'connects') p.connects = MO.parseList(el.value);
        else if (f === 'valid_from') m.valid_from = MO.fromLocalInput(el.value);
        else if (f === 'valid_until') m.valid_until = MO.fromLocalInput(el.value);
        _refreshActions();
    }
    function _paintSelStats() {
        var el = document.getElementById('mapedit_sel_stats');
        if (!el || !_sel) return;
        var pts = _draft ? _curPts() : [], txt = '';
        if (pts.length === 1) {
            txt = 'x ' + pts[0][0].toFixed(2) + ' · y ' + pts[0][1].toFixed(2) + ' m';
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

    // ---- delete: at once, with the way back in a toast. Protected points have
    // no delete, whatever the way here was.
    function _snapshot(s) {
        var o = _objOf(s);
        if (!o) return null;
        if (s.kind === 'zone') return window.mapEditZoneApi.raw(s.name);
        return JSON.parse(JSON.stringify(o));
    }
    function _restore(s, snap) {
        if (s.kind === 'zone') window.mapEditZoneApi.restore(snap);
        else if (s.kind === 'edit') _layer.saveEdit({ kind: snap.kind, name: snap.name, points: snap.points, width_m: snap.width_m });
        else if (s.kind === 'path') _pub_path_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: snap.name, points: snap.points, yaws: snap.yaws }) }));
        else _publishWaypointAt(snap.name, snap.x, snap.y, snap.yaw || 0);
    }
    function _deleted(name, undo) {
        Panel.toast(t('medits.sel.deleted', { name: name }), undo);
        _setHint('medits.sel.deleted', { name: name });
    }
    function _deleteSel(s) {
        var m = _metaObj(s.kind, s.name);
        if (MO.isProtected(m, s.name)) { _setHint('medits.sel.reserved'); return; }
        var snap = _snapshot(s), full = m ? JSON.parse(JSON.stringify(m)) : null;
        _closeSel();
        _renderSel();
        _markRows();
        _refreshActions();
        if (m && MO.live()) {
            MO.op({ op: 'delete', id: m.id }, function (r) {
                if (!r.ok) { _sayReason(r); return; }
                _deleted(s.name, function () {
                    var redoIt = function (x) { if (!x.ok) _sayReason(x); };
                    if (MO.undoPlan(MO.state.history, m.id) === 'undo') MO.op({ op: 'undo' }, redoIt);
                    else MO.op({ op: 'save', object: full }, redoIt);
                });
            });
            return;
        }
        if (s.kind === 'zone') window.mapEditZoneApi.remove(s.name);
        else if (s.kind === 'edit') _layer.removeEdit(s.name);
        else if (s.kind === 'path') _removePath(s.name);
        else if (_pub_wp_remove) _pub_wp_remove.publish(new ROSLIB.Message({ data: s.name }));
        _deleted(s.name, snap ? function () { _restore(s, snap); } : null);
    }
    // All edits of the map, one undo step.
    function _clearAll() {
        var edits = ((_layer && _layer.edits) || []).slice();
        if (!edits.length) { _setHint('medits.no_edits'); return; }
        if (_dirty()) { _setHint('medits.sel.save_first'); return; }
        var ops = edits.map(function (e) { var m = MO.find('edit', e.name); return m ? { op: 'delete', id: m.id } : null; });
        var msg = tn('medits.hint.cleared', edits.length);
        if (MO.live() && ops.every(Boolean)) {
            MO.op({ op: 'group', ops: ops }, function (r) {
                if (!r.ok) { _sayReason(r); return; }
                Panel.toast(msg, function () { MO.op({ op: 'undo' }, function (x) { if (!x.ok) _sayReason(x); }); });
            });
            return;
        }
        _layer.clearAll();
        Panel.toast(msg, function () {
            edits.forEach(function (e) { _layer.saveEdit({ kind: e.kind, name: e.name, points: e.points, width_m: e.width_m }); });
        });
    }
    // A copy one metre aside, under a new name. Zones by the planner: their
    // settings and programs are its business.
    function _duplicateSel(s) {
        var o = _objOf(s);
        if (!o) return;
        if (s.kind === 'zone') {
            MO.zoneOp({ op: 'duplicate', name: s.name }, function (r) {
                if (!r.ok) { _sayReason(r); return; }
                var n = (r.names || [])[0];
                if (n) _select('zone', n, { awaited: true });
            });
            return;
        }
        var fam = s.kind === 'place' ? 'place' : s.kind;
        var name = nextName(s.kind === 'place' ? o.type : (s.kind === 'edit' ? (o.kind || 'obstacle') : s.kind), _names(fam));
        var pts = _ptsOf(s.kind, o).map(function (p) { return [p[0] + 1, p[1] + 1]; });
        if (s.kind === 'place') {
            var c = JSON.parse(JSON.stringify(o));
            delete c.id; c.name = name; c.points = pts;
            MO.op({ op: 'save', object: c }, function (r) {
                if (!r.ok) { _sayReason(r); return; }
                _select('place', name, { awaited: true });
            });
            return;
        }
        if (s.kind === 'edit') _layer.saveEdit({ kind: o.kind, name: name, points: pts, width_m: o.width_m });
        else if (s.kind === 'path') _pub_path_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: name, points: pts, yaws: o.yaws }) }));
        else _publishWaypointAt(name, pts[0][0], pts[0][1], o.yaw || 0);
        _select(s.kind, name, { awaited: true });
    }
    function _mergeSel(s, other) {
        MO.zoneOp({ op: 'merge', names: [s.name, other] }, function (r) {
            if (!r.ok) { _sayReason(r); return; }
            _setHint('medits.zone.merged', { name: s.name, other: other });
        });
    }
    function _suggestion(id, action) {
        var sg = (MO.state.suggestions || []).filter(function (x) { return x.id === id; })[0];
        if (!sg) return;
        var msg = { op: 'suggestion', id: id, action: action };
        if (action === 'accept') {
            var mark = sg.kind === 'landmark';
            msg.as = { type: mark ? 'landmark' : 'obstacle',
                       name: mark ? nextName('landmark', _names('place')) : nextName('obstacle', _names('edit')) };
        }
        MO.op(msg, function (r) { if (!r.ok) _sayReason(r); });
    }
    function _frameSuggestion(id) {
        var sg = (MO.state.suggestions || []).filter(function (x) { return x.id === id; })[0];
        if (!sg || !_ov || !sg.points || !sg.points.length) return;
        var c = _center(sg.points);
        _ov.frameBox(c[0] - 4, c[1] - 4, c[0] + 4, c[1] + 4);
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
            if (on) {
                var sec = r.closest('details'), list = r.parentNode;
                if (sec) sec.open = true;
                if (r.offsetTop < list.scrollTop || r.offsetTop + r.offsetHeight > list.scrollTop + list.clientHeight) {
                    list.scrollTop = r.offsetTop - 40;
                }
            }
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
    // Leaving the editor with unsaved work takes a second press, whichever way
    // out it is. Calls right after the first belong to the same press: one
    // click can pass through two ways out (the frame's panel toggle does).
    var _closeArmed = 0;
    var CLOSE_SAME_PRESS_MS = 300, CLOSE_AGAIN_MS = 4000;
    function _unsaved() {
        return _dirty() || !!_wpInput || (_isDraw(_tool) && _tool !== 'measure' && _tool !== 'zone_split' && _curPts().length > 0);
    }
    function holdClose() {
        if (!_unsaved()) return false;
        var since = Date.now() - _closeArmed;
        if (since < CLOSE_SAME_PRESS_MS) return true;
        if (since < CLOSE_AGAIN_MS) return false;
        _closeArmed = Date.now();
        _compact(true);
        var body = document.getElementById('ui_drawer_body');
        if (body) body.scrollTop = 0;
        _setHint('medits.sel.close_again');
        return true;
    }

    function _removePath(name) {
        if (_pub_path_remove) _pub_path_remove.publish(new ROSLIB.Message({ data: name }));
    }

    // ---- waypoint placement: floating name + yaw slider (simpler than a drag
    //      gesture; yaw chosen from a 0..359° slider) ----
    function _newWaypoint(world) {
        world = snap(world, null, -1);
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
        if (kind === 'place') return MO.places().map(function (o) { return o.name; });
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
        _renamed(res.kind, res.from, res.to);
    }
    function _renamed(kind, from, to) {
        if (kind === 'path' && _mapObjLayer && _mapObjLayer.isPathHidden(from)) {
            _mapObjLayer.setPathHidden(from, false);
            _mapObjLayer.setPathHidden(to, true);
        }
        if (_sel && _sel.kind === kind && _sel.name === from) {
            _sel.name = to;
            _sel.awaited = Date.now() + AWAIT_MS;
            if (_draft) _draft.name = to;
            if (kind === 'zone' && window.mapEditZoneApi) window.mapEditZoneApi.setName(to);
        }
        _renameDone();
        _markRows();
        _setHint('medits.hint.renamed', { from: from, to: to });
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
        if (r.kind === 'place') {
            var obj = MO.find('place', r.from);
            if (!obj) { _renameSay('medits.name.err.not_found'); return; }
            r.to = to;
            r.row.querySelector('.mapedit-ren-save').disabled = true;
            MO.op({ op: 'update', id: obj.id, name: to }, function (res) {
                if (_renaming !== r) return;
                if (res.ok) { _renamed('place', r.from, to); return; }
                var known = ['exists', 'reserved', 'empty', 'too_long', 'bad_chars'].indexOf(res.reason) >= 0;
                _renameSay(res.timeout ? 'medits.name.err.timeout' : 'medits.name.err.' + (known ? res.reason : 'failed'), { name: to });
            });
            return;
        }
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
        _layer = {edits: [{name: 'Hedge corner', kind: 'obstacle', points: [[0, 0], [1, 0], [1, 1]]},
                          {name: 'Gate', kind: 'wall', points: [[0, 0], [1, 0]]}], group: {}};
        _mapObjLayer = {paths: [{name: 'Kolem_vina', points: []},
                                {name: 'Back lawn', points: []}],
                        isPathHidden: function (n) { return n === 'Back lawn'; }};
        _wpNames = ['DOCK', 'UNDOCK', 'DOCKED'];
        try {
            _loadShow(); _buildToolbar(); Panel.renderList(_rows());
        } finally { _layer = keepL; _mapObjLayer = keepM; _wpNames = keepW; }
        return true;
    }

    // Language switch: data-i18n parts follow by themselves; re-draw the rest.
    function _onLang() {
        _barW = null;   // the words of the bar changed its width: measure after they are in
        if (!_built) return;
        setTimeout(function () { if (_ov && _ov.editing) _showBar(true); }, 0);
        Panel.onLang();
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
        snap: snap,
        onHover: onHover,
        onDragEnd: onDragEnd,
        onZoneData: _zoneData,
        onZoneResult: onZoneResult,
        holdClose: holdClose,
        // exposed for diagnostics/tests
        _layer: function () { return _layer; },
        _state: function () {
            var P = sharedPolygon();
            return { tool: _tool, sel: _sel, dirty: _dirty(), saving: !!(_draft && _draft.saving),
                     pts: _curPts(), yaws: _draft ? _draft.yaws : null, selected: P ? P.selected : -1, canUndo: !!(P && P.canUndo()),
                     zones: _zoneLayer ? _zoneLayer.zones.map(function (z) { return z.name; }) : [],
                     hint: (document.getElementById('mapedit_hint') || {}).textContent };
        },
        EditMaskLayer: EditMaskLayer,
    };
})();
