/* vt_agent_plan.js — the map layer "Agent's plan" (owner 2026-10-25: "when it
 * plans anything, looks for a way, it should use it every time and show it in
 * the chat and, when it starts, on the map").
 *
 * Source: a chat row of the agent with meta.ui_plan (vitulus_agent,
 * agent/mapcanvas.py ui_plan_meta), forwarded by agent_chat.js as the event
 * 'vagent:task' — no new topic, no request of its own, publishes nothing:
 *   {mission, sketch, rev, updated, title?, frame: 'map', clear?,
 *    items: [{id, kind: point|line|polygon|arrow|text, points: [[x, y]...],
 *             label, style: sketch|warn|info}]}
 * Coordinates are the map frame (x east, y north, metres) — the same frame the
 * 3D map draws in (TF fixed frame /map).
 *
 * Draws: points (disc + ring), routes, areas (outline + faint fill), arrows
 * (route + head) in amber (warn red, info blue); labels as HTML tags that
 * follow the camera (crisp text at any zoom).  A card in the bottom-left of
 * the map hollow: "Agent's plan · mission #N", Show (moves the view onto the
 * plan) and Clear.  Layer checkbox Map › Layers "Agent's plan" (remembered).
 * A fresh plan (≤ 2 min) brings the map forward: the large camera steps back
 * and the view moves onto the plan once per mission.
 * Goes away: ui_plan.clear / an empty plan, an end-of-mission row of the same
 * mission (operator_done/home/timeout/cancelled, done/failed/cancelled), the
 * Clear button (remembered per mission+revision, so the chat history does not
 * bring it back on reload).  Plans older than 6 h from history are ignored.
 * ROS3D bundles its own THREE (r89): everything is built from ROS3D.THREE.
 * i18n: keys 'aplan.*' (en.js + cs.js).  Help: docs/help/agent.md › agent-plan.
 */
(function () {
    'use strict';

    var LS_LAYER = 'vitulus_layer_agentplan';
    var LS_CLEARED = 'vitulus_agentplan_cleared';
    var MAX_AGE_S = 6 * 3600;
    var FRESH_S = 120;
    var ORDER = 31;                       // above DOCK 30, below the robot 55 and rain 999
    var Z = 0.08;
    var COLORS = {sketch: '#ffb000', warn: '#ff4646', info: '#78c8ff'};
    var END_EVENTS = {operator_done: 1, operator_home: 1, operator_timeout: 1,
                      operator_cancelled: 1, done: 1, failed: 1, cancelled: 1};

    var S = {plan: null, group: null, chk: null, card: null, labels: null, tags: [],
             focused: {}, raf: null};

    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function el(tagName, cls, parent) {
        var e = document.createElement(tagName);
        if (cls) { e.className = cls; }
        if (parent) { parent.appendChild(e); }
        return e;
    }
    function v3() { return window.viewer && window.viewer.viewer; }
    function T() { return window.ROS3D && ROS3D.THREE; }
    function colorOf(style) { return COLORS[style] || COLORS.sketch; }
    function num(v) { return typeof v === 'number' && isFinite(v); }
    function pts(item) {
        return (item.points || []).filter(function (p) { return p && num(p[0]) && num(p[1]); });
    }

    /* ---- cleared plans (per viewer): {mission: rev} */
    function cleared() {
        try { return JSON.parse(lsGet(LS_CLEARED) || '{}') || {}; } catch (e) { return {}; }
    }
    function markCleared(plan) {
        var c = cleared();
        c[String(plan.mission)] = Number(plan.rev || 0);
        var keys = Object.keys(c);
        if (keys.length > 30) { delete c[keys[0]]; }
        lsSet(LS_CLEARED, JSON.stringify(c));
    }

    /* ---- the layer checkbox */
    function ensureCheckbox() {
        if (S.chk) { return S.chk; }
        var chk = document.getElementById('mapv3_chk_agentplan');
        if (!chk) {
            var row = document.querySelector('.map-layers-row');
            if (!row) { return null; }
            var div = el('div', 'form-check form-check-inline', row);
            div.setAttribute('data-i18n-title', 'aplan.layer_tip');
            div.title = t('aplan.layer_tip');
            div.innerHTML = '<input class="form-check-input" type="checkbox" id="mapv3_chk_agentplan">' +
                '<label class="form-check-label vt-fs-sm" for="mapv3_chk_agentplan">' +
                '<span data-i18n="aplan.layer">Agent\'s plan</span> <span class="vt-sw-aplan">&#9670;</span></label>';
            if (window.VTI18n && VTI18n.apply) { VTI18n.apply(div); }
            chk = document.getElementById('mapv3_chk_agentplan');
        }
        chk.checked = lsGet(LS_LAYER) !== '0';
        chk.addEventListener('change', function () {
            lsSet(LS_LAYER, chk.checked ? '1' : '0');
            paintVisibility();
        });
        S.chk = chk;
        return chk;
    }
    function layerOn() { return !S.chk || S.chk.checked; }

    /* ---- 3D drawing */
    function lineObj(Th, arr, color) {
        var g = new Th.BufferGeometry();
        var a = new Th.BufferAttribute(new Float32Array(arr), 3);
        if (g.setAttribute) { g.setAttribute('position', a); } else { g.addAttribute('position', a); }
        var m = new Th.LineBasicMaterial({color: color, transparent: true, opacity: 0.95,
                                          depthWrite: false, depthTest: false});
        var o = new Th.LineSegments(g, m);
        o.renderOrder = ORDER;
        o.frustumCulled = false;
        return o;
    }
    function meshObj(Th, geom, color, opacity) {
        var m = new Th.MeshBasicMaterial({color: color, transparent: true, opacity: opacity,
                                          depthWrite: false, depthTest: false,
                                          side: Th.DoubleSide});
        var o = new Th.Mesh(geom, m);
        o.renderOrder = ORDER;
        o.frustumCulled = false;
        return o;
    }
    function segs(p, closed) {
        var out = [];
        var n = p.length;
        for (var i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
            var a = p[i], b = p[(i + 1) % n];
            out.push(a[0], a[1], Z, b[0], b[1], Z);
        }
        return out;
    }
    function ring(x, y, r, n) {
        var out = [];
        for (var i = 0; i < n; i++) {
            var a0 = 2 * Math.PI * i / n, a1 = 2 * Math.PI * (i + 1) / n;
            out.push(x + r * Math.cos(a0), y + r * Math.sin(a0), Z,
                     x + r * Math.cos(a1), y + r * Math.sin(a1), Z);
        }
        return out;
    }
    function build() {
        var Th = T(), V = v3();
        if (S.group && V && V.scene) { V.scene.remove(S.group); }
        S.group = null;
        if (!Th || !V || !V.scene || !S.plan) { return; }
        var group = new Th.Object3D();
        (S.plan.items || []).forEach(function (item) {
            var p = pts(item), color = colorOf(item.style);
            if (!p.length) { return; }
            if (item.kind === 'point') {
                var disc = meshObj(Th, new Th.CircleGeometry(0.13, 20), color, 0.95);
                disc.position.set(p[0][0], p[0][1], Z);
                group.add(disc);
                group.add(lineObj(Th, ring(p[0][0], p[0][1], 0.24, 28), color));
            } else if (item.kind === 'line' && p.length >= 2) {
                group.add(lineObj(Th, segs(p, false), color));
            } else if (item.kind === 'polygon' && p.length >= 3) {
                group.add(lineObj(Th, segs(p, true), color));
                try {
                    var shape = new Th.Shape(p.map(function (q) { return new Th.Vector2(q[0], q[1]); }));
                    var fill = meshObj(Th, new Th.ShapeGeometry(shape), color, 0.14);
                    fill.position.z = Z - 0.01;
                    group.add(fill);
                } catch (e) { /* the outline is enough */ }
            } else if (item.kind === 'arrow' && p.length >= 2) {
                group.add(lineObj(Th, segs(p, false), color));
                var a = p[p.length - 2], b = p[p.length - 1];
                var ang = Math.atan2(b[1] - a[1], b[0] - a[0]), h = 0.35;
                var head = new Th.Geometry();
                head.vertices.push(new Th.Vector3(b[0], b[1], Z),
                                   new Th.Vector3(b[0] - h * Math.cos(ang - 0.45), b[1] - h * Math.sin(ang - 0.45), Z),
                                   new Th.Vector3(b[0] - h * Math.cos(ang + 0.45), b[1] - h * Math.sin(ang + 0.45), Z));
                head.faces.push(new Th.Face3(0, 1, 2));
                group.add(meshObj(Th, head, color, 0.95));
            }
        });
        group.visible = layerOn();
        V.scene.add(group);
        S.group = group;
    }

    /* ---- labels: HTML tags that follow the camera */
    function labelAnchor(item) {
        var p = pts(item);
        if (!p.length) { return null; }
        if (item.kind === 'polygon') {
            return p.reduce(function (m, q) { return q[1] > m[1] ? q : m; }, p[0]);  // northmost vertex
        }
        if (item.kind === 'arrow' || item.kind === 'line') {
            var mid = p[Math.floor((p.length - 1) / 2)], nxt = p[Math.min(p.length - 1, Math.floor((p.length - 1) / 2) + 1)];
            return [(mid[0] + nxt[0]) / 2, (mid[1] + nxt[1]) / 2];
        }
        return p[0];
    }
    function buildLabels() {
        if (!S.labels) {
            S.labels = el('div', 'vt-aplan-labels', document.body);
            S.labels.setAttribute('aria-hidden', 'true');
        }
        S.labels.innerHTML = '';
        S.tags = [];
        if (!S.plan) { return; }
        (S.plan.items || []).forEach(function (item) {
            var at = labelAnchor(item);
            var text = item.kind === 'text' ? (item.label || '') : ((item.id || '') + (item.label ? ' ' + item.label : ''));
            if (!at || !text) { return; }
            var tagEl = el('span', 'vt-aplan-tag vt-aplan-' + (COLORS[item.style] ? item.style : 'sketch'), S.labels);
            tagEl.textContent = text;
            S.tags.push({el: tagEl, x: at[0], y: at[1], text: item.kind === 'text'});
        });
    }
    function placeLabels() {
        S.raf = null;
        var Th = T(), V = v3();
        if (!S.labels) { return; }
        var on = !!(S.plan && layerOn() && Th && V && V.camera && V.renderer && !document.hidden);
        S.labels.style.display = on ? '' : 'none';
        if (!on) { return; }
        var r = V.renderer.domElement.getBoundingClientRect();
        var v = new Th.Vector3();
        S.tags.forEach(function (tg) {
            v.set(tg.x, tg.y, Z).project(V.camera);
            var x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
            var inside = v.z < 1 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            tg.el.style.display = inside ? '' : 'none';
            if (inside) {
                tg.el.style.transform = 'translate(' + Math.round(x + (tg.text ? -8 : 10)) + 'px,' +
                                        Math.round(y - 10) + 'px)';
            }
        });
    }
    function schedule() { if (!S.raf) { S.raf = requestAnimationFrame(placeLabels); } }

    /* ---- the card in the map hollow */
    function ensureCard() {
        if (S.card) { return S.card; }
        var c = el('div', 'vt-aplan-card', document.body);
        c.id = 'vt_aplan_card';
        c.style.display = 'none';
        var head = el('div', 'vt-aplan-head', c);
        var dot = el('span', 'vt-aplan-dot', head);
        dot.textContent = '◆';
        var title = el('span', 'vt-aplan-title', head);
        title.setAttribute('data-i18n', 'aplan.title');
        title.textContent = t('aplan.title');
        S.cardMission = el('span', 'vt-aplan-mission', head);
        S.cardSub = el('div', 'vt-aplan-sub', c);
        var row = el('div', 'vt-aplan-btns', c);
        var show = el('button', 'btn btn-sm vt-aplan-btn', row);
        show.type = 'button';
        show.setAttribute('data-i18n', 'aplan.show');
        show.setAttribute('data-i18n-title', 'aplan.show_tip');
        show.textContent = t('aplan.show');
        show.title = t('aplan.show_tip');
        show.onclick = function () {
            if (S.chk && !S.chk.checked) { S.chk.checked = true; lsSet(LS_LAYER, '1'); paintVisibility(); }
            bringMap();
            focusPlan(true);
        };
        var clr = el('button', 'btn btn-sm vt-aplan-btn vt-aplan-clear', row);
        clr.type = 'button';
        clr.setAttribute('data-i18n', 'aplan.clear');
        clr.setAttribute('data-i18n-title', 'aplan.clear_tip');
        clr.textContent = t('aplan.clear');
        clr.title = t('aplan.clear_tip');
        clr.onclick = function () { if (S.plan) { markCleared(S.plan); } clearPlan(); };
        S.card = c;
        return c;
    }
    function paintCard() {
        var c = ensureCard();
        if (!S.plan) { c.style.display = 'none'; return; }
        c.style.display = '';
        S.cardMission.textContent = S.plan.mission != null ? t('aplan.mission', {n: S.plan.mission}) : '';
        var bits = [];
        if (S.plan.title) { bits.push(S.plan.title); }
        bits.push(t('aplan.items', {n: (S.plan.items || []).length}));
        if (!layerOn()) { bits.push(t('aplan.hidden')); }
        S.cardSub.textContent = bits.join(' · ');
    }
    function paintVisibility() {
        if (S.group) { S.group.visible = layerOn(); }
        paintCard();
        schedule();
    }

    /* ---- bring the map forward and move the view onto the plan */
    function bringMap() {
        try {
            if (window.VtFrame && VtFrame.camLarge && VtFrame.camLarge()) { VtFrame.camSet(false); }
        } catch (e) { /* layout is a convenience */ }
    }
    function bbox(plan) {
        var b = null;
        (plan.items || []).forEach(function (item) {
            pts(item).forEach(function (p) {
                if (!b) { b = [p[0], p[1], p[0], p[1]]; return; }
                b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]);
                b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
            });
        });
        return b;
    }
    function focusPlan(force) {
        var V = v3(), tc = window.tf_client, b = S.plan && bbox(S.plan);
        if (!V || !V.camera || !V.cameraControls || !b) { return; }
        if (!force && tc && tc.follow_target && tc.follow_target !== 'map') { return; }  // following the robot
        var cam = V.camera, ctr = V.cameraControls.center;
        var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        var dx = cx - ctr.x, dy = cy - ctr.y;
        if (tc && tc.follow_target && tc.follow_target !== 'map' && force) {
            tc.follow_target = 'map';                 // Show = look at the plan, not at the robot
            if (window.status_bar && status_bar.set_follow_text) { status_bar.set_follow_text('mapview.follow.map'); }
        }
        cam.position.x += dx; cam.position.y += dy;
        ctr.x = cx; ctr.y = cy;
        /* zoom out only when the plan does not fit (never zoom in on the owner) */
        try {
            var fov = (cam.fov || 40) * Math.PI / 180, aspect = cam.aspect || 1;
            var off = cam.position.clone().sub(ctr), dist = off.length();
            var need = Math.max((b[3] - b[1]) / 2, (b[2] - b[0]) / 2 / aspect) * 1.35 + 1.0;
            var have = dist * Math.tan(fov / 2);
            if (have > 0 && need > have) {
                off.multiplyScalar(need / have);
                cam.position.copy(ctr).add(off);
            }
        } catch (e) { /* keep the zoom */ }
        if (V.cameraControls.update) { V.cameraControls.update(); }
        if (tc && tc.map_cam_center) {
            tc.map_cam_center.copy(ctr);
            tc.map_cam_position.copy(cam.position);
        }
        schedule();
    }

    /* ---- plan in, plan out */
    function setPlan(plan, fresh) {
        S.plan = plan;
        build();
        buildLabels();
        paintCard();
        schedule();
        var key = String(plan.mission);
        if (fresh && !S.focused[key]) {
            S.focused[key] = true;
            bringMap();
            focusPlan(false);
        }
    }
    function clearPlan() {
        S.plan = null;
        build();
        buildLabels();
        paintCard();
        schedule();
    }
    function sameMission(a, b) { return a != null && b != null && String(a) === String(b); }

    function onTask(ev) {
        var task = ev && ev.detail, meta = task && task.meta;
        if (!meta) { return; }
        var ts = Number(task.reply_ts || task.ts || 0);
        var age = ts ? Date.now() / 1000 - ts : 0;
        var plan = meta.ui_plan;
        if (plan && typeof plan === 'object') {
            if (age > MAX_AGE_S) { return; }
            var mission = plan.mission != null ? plan.mission : meta.mission_job;
            if (plan.clear || !(plan.items && plan.items.length)) {
                if (S.plan && sameMission(S.plan.mission, mission)) { clearPlan(); }
                return;
            }
            var gone = cleared()[String(mission)];
            if (gone !== undefined && Number(plan.rev || 0) <= gone) { return; }
            if (S.plan && sameMission(S.plan.mission, mission) &&
                Number(plan.rev || 0) < Number(S.plan.rev || 0)) { return; }
            var copy = {};
            Object.keys(plan).forEach(function (k) { copy[k] = plan[k]; });
            copy.mission = mission;
            setPlan(copy, age <= FRESH_S);
            return;
        }
        if (S.plan && END_EVENTS[meta.event] && sameMission(S.plan.mission, meta.mission_job)) {
            clearPlan();
        }
    }

    function init() {
        ensureCheckbox();
        ensureCard();
        var hook = setInterval(function () {      // the camera exists after initMapView
            var V = v3();
            if (!S.chk) { ensureCheckbox(); }
            if (V && V.cameraControls && V.cameraControls.addEventListener) {
                V.cameraControls.addEventListener('change', schedule);
                clearInterval(hook);
                if (S.plan && !S.group) { build(); }      // a plan that came before the 3D map
            }
        }, 1000);
        setInterval(function () { if (S.plan) { schedule(); } }, 400);   // robot-follow moves the view too
        window.addEventListener('resize', schedule);
        if (window.VTI18n && VTI18n.onChange) { VTI18n.onChange(paintCard); }
    }
    window.VtAgentPlan = {
        show: function (plan) { setPlan(plan, true); },   // debugging / tests
        clear: clearPlan,
        plan: function () { return S.plan; }
    };
    /* listen at once: the chat history is replayed as soon as the panel loads */
    document.addEventListener('vagent:task', onTask);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 900); });
    } else {
        setTimeout(init, 900);
    }
})();
