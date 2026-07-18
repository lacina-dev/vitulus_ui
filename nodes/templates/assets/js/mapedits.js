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
    var _tool = 'off';
    var _built = false;
    var _wpN = 1;            // wp_<n> suggestion counter
    var _pendingMoveName = null;
    var _clickState = null;  // raw click detector
    var _wpNames = [];       // known waypoint names (from map_point_str_list)

    // waypoint topics (navi_manager) — kept next to the tool that uses them.
    var _pub_wp_at = null, _pub_wp_remove = null, _sub_wp_list = null;

    function _ensureWpTopics(ros) {
        if (_pub_wp_at) return;
        _pub_wp_at = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/save_waypoint_at', messageType: 'std_msgs/String' });
        _pub_wp_remove = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/remove_point', messageType: 'std_msgs/String' });
        _pub_wp_at.advertise();
        _pub_wp_remove.advertise();
        _sub_wp_list = new ROSLIB.Topic({ ros: ros, name: '/navi_manager/map_point_str_list', messageType: 'vitulus_msgs/StringList' });
        _sub_wp_list.subscribe(function (msg) {
            _wpNames = (msg && msg.string_list) ? msg.string_list.slice() : [];
            _renderWpList();
        });
    }

    // ---- public lifecycle (called from mapeditor.js Controller) ----
    function onEnter(overlay) {
        _ov = overlay;
        var ros = rosOf();
        if (!ros) { console.warn('[mapedits] no ros connection yet'); }
        if (ros && !_layer) {
            _layer = new EditMaskLayer(ros, overlay);
            _layer.onListChange = function () { /* re-render handled internally */ };
        } else if (_layer) {
            // overlay may have been rebuilt — re-attach the render group
            try { if (_layer.group.parent !== overlay.overlayGroup) overlay.overlayGroup.add(_layer.group); } catch (e) {}
        }
        if (ros) _ensureWpTopics(ros);
        _buildToolbar();
        _installClickDetector();
        _setTool('off');
    }
    function onExit() {
        _teardownTool();
        _setToolButtonsActive('off');
        _hideWpInput();
    }

    // ---- toolbar UI ----
    function _panel() { return document.getElementById('div_map_detail'); }
    function _buildToolbar() {
        if (_built) { _refreshDisabled(); return; }
        var panel = _panel();
        if (!panel) return;
        var bar = document.createElement('div');
        bar.id = 'mapedit_toolbar';
        bar.style.cssText = 'margin-bottom:8px;padding:6px;background:var(--bs-primary);border-radius:4px;';
        bar.innerHTML =
            '<div class="text-uppercase fw-bold" style="font-size:11px;letter-spacing:.5px;margin-bottom:5px;">Map tools</div>' +
            '<div class="d-flex flex-wrap" style="gap:4px;margin-bottom:5px;">' +
            '  <button class="btn btn-sm btn-outline-info" data-tool="waypoint" type="button" style="font-size:11px;">Waypoint</button>' +
            '  <button class="btn btn-sm btn-outline-danger" data-tool="edit_obstacle" type="button" style="font-size:11px;">Obstacle</button>' +
            '  <button class="btn btn-sm btn-outline-success" data-tool="edit_free" type="button" style="font-size:11px;">Free</button>' +
            '  <button class="btn btn-sm btn-outline-warning" data-tool="edit_wall" type="button" style="font-size:11px;">Wall</button>' +
            '  <div class="input-group input-group-sm" style="width:86px;"><input class="form-control" id="mapedit_wall_w" type="number" min="0.02" max="2" step="0.05" value="0.10" title="Wall width (m)"><span class="input-group-text">m</span></div>' +
            '  <button class="btn btn-sm btn-outline-secondary" data-tool="edit_delete" type="button" style="font-size:11px;">Delete edit</button>' +
            '  <button class="btn btn-sm btn-outline-danger" id="mapedit_clear_all" type="button" style="font-size:11px;">Clear all</button>' +
            '</div>' +
            '<div class="d-flex flex-wrap align-items-center" style="gap:4px;">' +
            '  <button class="btn btn-sm btn-primary" data-tab="zone" type="button" style="font-size:11px;">Zones</button>' +
            '  <button class="btn btn-sm btn-primary" data-tab="poly" type="button" style="font-size:11px;">Polygons</button>' +
            '  <button class="btn btn-sm btn-success" id="mapedit_finish" type="button" style="font-size:11px;display:none;">Finish edit</button>' +
            '  <button class="btn btn-sm btn-warning" id="mapedit_cancel" type="button" style="font-size:11px;display:none;">Cancel</button>' +
            '  <button class="btn btn-sm btn-outline-light ms-auto" id="mapedit_exit" type="button" style="font-size:11px;">Exit editor</button>' +
            '</div>' +
            '<div id="mapedit_hint" style="font-size:11px;color:var(--bs-info);min-height:15px;margin-top:5px;"></div>' +
            '<div id="mapedit_wp_list" style="margin-top:4px;"></div>';
        // insert right under the "Map detail" header row (first child)
        var header = panel.firstElementChild;
        if (header && header.nextSibling) panel.insertBefore(bar, header.nextSibling);
        else panel.insertBefore(bar, panel.firstChild);

        // tool buttons
        var btns = bar.querySelectorAll('[data-tool]');
        btns.forEach(function (b) {
            b.addEventListener('click', function () {
                var m = b.getAttribute('data-tool');
                if (_tool === m) _setTool('off'); else _setTool(m);
            });
        });
        // zone/poly tab delegates (existing map_edit.js UI)
        bar.querySelectorAll('[data-tab]').forEach(function (b) {
            b.addEventListener('click', function () {
                _setTool('off');
                _showEditTab(b.getAttribute('data-tab'));
            });
        });
        // finish / cancel (edits draw)
        bar.querySelector('#mapedit_finish').addEventListener('click', _finishEditsDraw);
        bar.querySelector('#mapedit_cancel').addEventListener('click', function () { _setTool('off'); });
        bar.querySelector('#mapedit_exit').addEventListener('click', function () {
            if (window.MapEditor && window.MapEditor.hideDetail) window.MapEditor.hideDetail();
        });
        _wireClearAll(bar.querySelector('#mapedit_clear_all'));
        _built = true;
        _refreshDisabled();
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
                armed = true; btn.textContent = 'Confirm clear'; btn.classList.remove('btn-outline-danger'); btn.classList.add('btn-danger');
                timer = setTimeout(disarm, 2500);
            } else {
                disarm();
                if (_layer) _layer.clearAll();
                _setHint('Cleared all edits.');
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
        var bar = document.getElementById('mapedit_toolbar'); if (!bar) return;
        bar.querySelectorAll('[data-tool]').forEach(function (b) {
            if (b.getAttribute('data-tool') === mode) b.classList.add('active');
            else b.classList.remove('active');
        });
        var fin = document.getElementById('mapedit_finish'), can = document.getElementById('mapedit_cancel');
        var isDraw = (mode === 'edit_obstacle' || mode === 'edit_free' || mode === 'edit_wall');
        if (fin) fin.style.display = isDraw ? '' : 'none';
        if (can) can.style.display = isDraw ? '' : 'none';
    }

    function _teardownTool() {
        // detach + clear the shared polygon if we were drawing edits
        var P = sharedPolygon();
        if (P && P.attached && _ov) {
            try { _ov.scene.removeChild(P); } catch (e) {}
            _clearPolygon(P);
        }
        _pendingMoveName = null;
        _hideWpInput();
        var wl = document.getElementById('mapedit_wp_list'); if (wl) wl.style.display = 'none';
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

        if (_tool === 'edit_obstacle' || _tool === 'edit_free' || _tool === 'edit_wall') {
            var P = sharedPolygon();
            if (!P) { _setHint('Editor not ready — open the map editor once, then retry.'); _setTool('off'); return; }
            _clearPolygon(P);
            try { _ov.scene.addChild(P); } catch (e) {}   // grabs the mouse via setDrawing(true)
            _setHint(_tool === 'edit_wall'
                ? 'Click to add wall points; drag a vertex to adjust. Press "Finish edit" to save the wall.'
                : 'Click to add polygon points; drag a vertex to adjust. Press "Finish edit" to save.');
        } else if (_tool === 'waypoint') {
            var wl = document.getElementById('mapedit_wp_list'); if (wl) wl.style.display = '';
            _renderWpList();
            _setHint('Click the map to place a waypoint. Existing waypoints are listed below (Move / Delete).');
        } else if (_tool === 'edit_delete') {
            _setHint('Click on an edit (obstacle / free / wall) to remove it.');
        } else {
            _setHint('');
        }
    }

    function _finishEditsDraw() {
        var P = sharedPolygon();
        if (!P) { _setTool('off'); return; }
        var pts = [];
        var ch = P.pointContainer.children || [];
        for (var i = 0; i < ch.length; i++) pts.push([ch[i].x, -ch[i].y]); // store y=-rosY -> map y
        var kind = (_tool === 'edit_obstacle') ? 'obstacle' : (_tool === 'edit_free') ? 'free' : 'wall';
        var minPts = (kind === 'wall') ? 2 : 3;
        if (pts.length < minPts) { _setHint('Need at least ' + minPts + ' points for a ' + kind + '.'); return; }
        var spec = { kind: kind, points: pts };
        if (kind === 'wall') {
            var wi = document.getElementById('mapedit_wall_w');
            spec.width_m = wi ? (parseFloat(wi.value) || 0.10) : 0.10;
        }
        if (_layer) _layer.saveEdit(spec);
        _setHint('Saved ' + kind + ' (' + pts.length + ' pts). The served map updates once composited.');
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
        });
        window.addEventListener('mousemove', function (ev) {
            if (!st.down) return;
            if (Math.hypot(ev.clientX - st.x, ev.clientY - st.y) > 5) st.moved = true;
        });
        window.addEventListener('mouseup', function (ev) {
            if (!st.down) return; st.down = false;
            if (st.moved || st.mod) return;
            var m = _ov.getToolMode ? _ov.getToolMode() : 'off';
            if (m !== 'waypoint' && m !== 'edit_delete') return;
            var w = _ov.screenToWorld(ev.clientX, ev.clientY);
            if (m === 'waypoint') _onWaypointClick(w, ev.clientX, ev.clientY);
            else _onDeleteClick(w);
        });
    }

    function _onDeleteClick(world) {
        if (!_layer) return;
        var tol = _ov.worldTol ? _ov.worldTol(10) : 0.3;
        var name = _layer.hitTest(world, tol);
        if (name) { _layer.removeEdit(name); _setHint('Removed edit "' + name + '".'); }
        else _setHint('No edit under the cursor.');
    }

    // ---- waypoint placement: floating name + yaw slider (simpler than a drag
    //      gesture; yaw chosen from a 0..359° slider) ----
    function _onWaypointClick(world, clientX, clientY) {
        var name = _pendingMoveName || ('wp_' + _wpN);
        _showWpInput(clientX, clientY, name, !!_pendingMoveName, function (finalName, yawDeg) {
            var yaw = (yawDeg || 0) * Math.PI / 180;
            _publishWaypointAt(finalName, world.x, world.y, yaw);
            if (!_pendingMoveName) _wpN++;
            _pendingMoveName = null;
            _setHint('Saved waypoint "' + finalName + '".');
        });
    }

    function _publishWaypointAt(name, x, y, yaw) {
        if (!_pub_wp_at) return;
        _pub_wp_at.publish(new ROSLIB.Message({ data: JSON.stringify({ name: name, x: x, y: y, yaw: yaw }) }));
    }

    var _wpInput = null;
    function _showWpInput(clientX, clientY, name, lockName, onSave) {
        _hideWpInput();
        var d = document.createElement('div');
        d.id = 'mapedit_wp_input';
        d.style.cssText = 'position:fixed;z-index:3000;background:var(--bs-gray-900);border:1px solid var(--bs-info);' +
            'border-radius:5px;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,.5);width:210px;';
        var left = Math.min(clientX + 8, window.innerWidth - 220);
        var top = Math.min(clientY + 8, window.innerHeight - 140);
        d.style.left = Math.max(4, left) + 'px';
        d.style.top = Math.max(4, top) + 'px';
        d.innerHTML =
            '<div style="font-size:11px;margin-bottom:4px;">Waypoint name</div>' +
            '<input class="form-control form-control-sm" id="mapedit_wp_name" type="text" value="' + _escapeAttr(name) + '"' + (lockName ? ' readonly' : '') + '>' +
            '<div style="font-size:11px;margin:6px 0 2px;">Heading: <span id="mapedit_wp_yawv">0</span>°</div>' +
            '<input id="mapedit_wp_yaw" type="range" min="0" max="359" step="1" value="0" style="width:100%;">' +
            '<div class="d-flex" style="gap:4px;margin-top:6px;">' +
            '  <button class="btn btn-success btn-sm" id="mapedit_wp_save" type="button" style="font-size:11px;">Save</button>' +
            '  <button class="btn btn-warning btn-sm" id="mapedit_wp_cancel" type="button" style="font-size:11px;">Cancel</button>' +
            '</div>';
        document.body.appendChild(d);
        _wpInput = d;
        var yaw = d.querySelector('#mapedit_wp_yaw'), yawv = d.querySelector('#mapedit_wp_yawv');
        yaw.addEventListener('input', function () { yawv.textContent = yaw.value; });
        d.querySelector('#mapedit_wp_save').addEventListener('click', function () {
            var nm = (d.querySelector('#mapedit_wp_name').value || '').trim();
            if (!nm) { d.querySelector('#mapedit_wp_name').focus(); return; }
            _hideWpInput();
            onSave(nm, parseFloat(yaw.value) || 0);
        });
        d.querySelector('#mapedit_wp_cancel').addEventListener('click', function () { _hideWpInput(); _pendingMoveName = null; });
        var nmEl = d.querySelector('#mapedit_wp_name');
        if (!lockName) { nmEl.focus(); nmEl.select(); }
    }
    function _hideWpInput() { if (_wpInput && _wpInput.parentNode) _wpInput.parentNode.removeChild(_wpInput); _wpInput = null; }

    function _renderWpList() {
        var wl = document.getElementById('mapedit_wp_list');
        if (!wl) return;
        if (_tool !== 'waypoint') { wl.style.display = 'none'; return; }
        wl.style.display = '';
        if (!_wpNames.length) { wl.innerHTML = '<div style="font-size:11px;color:var(--bs-gray-500);">No waypoints yet.</div>'; return; }
        var html = '<div style="font-size:11px;color:var(--bs-gray-500);margin-bottom:2px;">Existing waypoints</div>';
        for (var i = 0; i < _wpNames.length; i++) {
            var n = _wpNames[i];
            html += '<div class="d-flex align-items-center" style="border-bottom:1px solid #3a3f44;padding:2px;font-size:11px;">' +
                '<span class="text-info text-truncate" style="flex:1 1 auto;min-width:0;" title="' + _escapeAttr(n) + '">' + _escapeHtml(n) + '</span>' +
                '<div class="btn-group btn-group-sm" style="margin-left:4px;">' +
                '<button class="btn btn-outline-info mapedit-wp-move" data-n="' + _escapeAttr(n) + '" type="button" style="font-size:10px;padding:0 6px;">Move</button>' +
                '<button class="btn btn-outline-danger mapedit-wp-del" data-n="' + _escapeAttr(n) + '" type="button" style="font-size:10px;padding:0 6px;">Del</button>' +
                '</div></div>';
        }
        wl.innerHTML = html;
        wl.querySelectorAll('.mapedit-wp-move').forEach(function (b) {
            b.addEventListener('click', function () {
                _pendingMoveName = b.getAttribute('data-n');
                _setHint('Click the map to move "' + _pendingMoveName + '" to a new location.');
            });
        });
        wl.querySelectorAll('.mapedit-wp-del').forEach(function (b) {
            b.addEventListener('click', function () {
                var n = b.getAttribute('data-n');
                if (_pub_wp_remove) _pub_wp_remove.publish(new ROSLIB.Message({ data: n }));
                _setHint('Removed waypoint "' + n + '".');
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
