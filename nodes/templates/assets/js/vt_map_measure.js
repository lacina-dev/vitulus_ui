/* vt_map_measure.js — measuring on the map (T17 M10, 2026-11-08).
 *
 * A round ruler button under the layers button in the map's top-left corner.
 * On: each tap / click on the map (without dragging, one finger) adds a
 * point; the card beside the button shows the length of the line through
 * the points and, from three points on, the area they enclose (closed
 * polygon). Undo removes the last point, Clear all of them, × or Esc ends.
 * Points and lines are drawn flat on the ground, above everything else.
 *
 * Distances are in the map frame, which is metric (ENU, metres), so they hold
 * for the ground as the map shows it; the area by the shoelace formula.
 *
 * Safety: pure UI. No ROS, no HTTP, nothing goes to the robot. It listens to
 * the same camera-control events as the goal marker (map_view.js T22
 * attach_tap) and is OFF while the Marker panel is open (a tap there places
 * the goal marker) and while the map editor is open (a tap there edits) —
 * so a measuring tap never does anything else.
 *
 * Loaded by vt_map_layers.js (no index.html change). The pure part is tested
 * in node: tools/test_map_measure.node.js. i18n: measure.* (block "// M10").
 * ROS3D bundles its own THREE (r89): ROS3D.THREE, never window.THREE.
 */
(function (root) {
    'use strict';

    var SLOP_MOUSE = 5, SLOP_TOUCH = 10;   // CSS px a tap may wander (as the goal marker)
    var MAX_POINTS = 64;

    // ---- pure ------------------------------------------------------------
    // where a ray hits the ground (z = 0), or null
    function rayToGround(o, d) {
        if (!o || !d || !(Math.abs(d.z) > 1e-9)) { return null; }
        var t = -o.z / d.z;
        if (!(t > 0) || !isFinite(t)) { return null; }
        return { x: o.x + t * d.x, y: o.y + t * d.y };
    }
    function pathLength(pts) {
        var s = 0;
        for (var i = 1; i < pts.length; i++) { s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); }
        return s;
    }
    // area of the closed polygon (shoelace), 0 under three points
    function polygonArea(pts) {
        if (pts.length < 3) { return 0; }
        var a = 0;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) { a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y); }
        return Math.abs(a) / 2;
    }
    function num(v, dec, lang) {
        var s = v.toFixed(dec);
        return lang === 'cs' ? s.replace('.', ',') : s;
    }
    // "0.45 m", "12.4 m", "1.25 km" (cs: decimal comma); U+00A0 before the unit
    function fmtLen(m, lang) {
        if (!(m >= 0)) { return '—'; }
        if (m >= 1000) { return num(m / 1000, 2, lang) + ' km'; }
        return num(m, m < 10 ? 2 : 1, lang) + ' m';
    }
    // "35 m²", "4.5 m²", "1.25 ha" (10 000 m² and more)
    function fmtArea(a, lang) {
        if (!(a >= 0)) { return '—'; }
        if (a >= 10000) { return num(a / 10000, 2, lang) + ' ha'; }
        return num(a, a < 10 ? 1 : 0, lang) + ' m²';
    }

    var api = { rayToGround: rayToGround, pathLength: pathLength, polygonArea: polygonArea,
                fmtLen: fmtLen, fmtArea: fmtArea, MAX_POINTS: MAX_POINTS };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (typeof document === 'undefined') { if (root) { root.VTMapMeasure = api; } return; }

    // ---- browser -----------------------------------------------------------
    function t(k, v) { return root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function lang() { return (root.VTI18n && root.VTI18n.lang && root.VTI18n.lang()) || 'en'; }
    function $(id) { return document.getElementById(id); }
    function viewer3d() { return (root.viewer && root.viewer.viewer) || null; }
    function markerOpen() { return typeof root.map_menu !== 'undefined' && !!root.map_menu && root.map_menu.current_submenu === 'marker'; }
    function editorOpen() {
        try { return !!(root.MapEditor && MapEditor.controller && MapEditor.controller().active); } catch (e) { return false; }
    }
    function panelOpen() { var p = $('vt_lyr_panel'); return !!(p && !p.hidden); }
    // why measuring cannot take taps now ('' = it can)
    function blocked() { return markerOpen() ? 'marker' : (editorOpen() ? 'editor' : ''); }

    var ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
        '<path d="M3 15.5 15.5 3 21 8.5 8.5 21Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
        '<path d="m7 12 2 2M10 9l1.5 1.5M13 6l2 2M8.5 13.5l.01.01" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

    var S = { on: false, pts: [], btn: null, card: null, group: null, line: null, fill: null, dots: null, wired: false };

    function build() {
        if (S.btn) { return; }
        var b = document.createElement('button');
        b.type = 'button'; b.id = 'vt_meas_btn'; b.className = 'vt-lyr-fab vt-meas-btn';
        b.setAttribute('aria-pressed', 'false');
        b.innerHTML = ICON;
        b.addEventListener('click', function () { setOn(!S.on); });
        // a toggle: its arrow keys never reach the keyboard driving (vt_joy.js on window)
        b.addEventListener('keydown', function (e) { if (/^Arrow/.test(e.key)) { e.stopPropagation(); } });
        document.body.appendChild(b);
        S.btn = b;
        var c = document.createElement('div');
        c.id = 'vt_meas_card'; c.className = 'vt-meas-card'; c.hidden = true;
        c.setAttribute('role', 'region');
        c.innerHTML = '<div class="vt-meas-head"><span class="vt-meas-title" data-meas-title></span>' +
            '<button type="button" class="vt-lyr-iconbtn" data-meas-close>&times;</button></div>' +
            '<div class="vt-meas-len vt-tnum" data-meas-len aria-live="polite"></div>' +
            '<div class="vt-meas-sub vt-tnum" data-meas-sub></div>' +
            '<div class="vt-meas-acts"><button type="button" class="vt-meas-act" data-meas-undo></button>' +
            '<button type="button" class="vt-meas-act" data-meas-clear></button></div>';
        document.body.appendChild(c);
        S.card = c;
        c.addEventListener('click', function (e) {
            var el = e.target.closest('button');
            if (!el) { return; }
            if (el.hasAttribute('data-meas-close')) { setOn(false); }
            else if (el.hasAttribute('data-meas-undo')) { S.pts.pop(); redraw(); }
            else if (el.hasAttribute('data-meas-clear')) { S.pts = []; redraw(); }
        });
        // keys in the card never reach the keyboard driving (vt_joy.js on window)
        c.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { setOn(false); }
            e.stopPropagation();
        });
        document.addEventListener('keydown', function (e) {
            if (S.on && e.key === 'Escape') { setOn(false); }
        });
        labels();
    }
    function labels() {
        if (!S.btn) { return; }
        S.btn.title = t('measure.btn_tip');
        S.btn.setAttribute('aria-label', t('measure.btn'));
        S.card.setAttribute('aria-label', t('measure.title'));
        S.card.querySelector('[data-meas-title]').textContent = t('measure.title');
        var x = S.card.querySelector('[data-meas-close]');
        x.title = t('measure.end'); x.setAttribute('aria-label', t('measure.end'));
        S.card.querySelector('[data-meas-undo]').textContent = t('measure.undo');
        S.card.querySelector('[data-meas-clear]').textContent = t('measure.clear');
        redraw();
    }

    function setOn(on) {
        build();
        S.on = !!on;
        S.btn.setAttribute('aria-pressed', String(S.on));
        S.card.hidden = !S.on;
        if (!S.on) { S.pts = []; }
        wire();
        redraw();
        place();
    }

    // ---- taps (the same rules as the goal marker: no drag, one finger, left button)
    function wire() {
        var V = viewer3d(), ctl = V && V.cameraControls;
        if (S.wired || !ctl || !ctl.addEventListener) { return; }
        S.wired = true;
        var g = null;
        function pt(ev) {
            var d = ev.domEvent || {};
            var q = (d.touches && d.touches.length) ? d.touches[0] : ((d.changedTouches && d.changedTouches.length) ? d.changedTouches[0] : d);
            return (q && typeof q.clientX === 'number') ? { x: q.clientX, y: q.clientY } : null;
        }
        function nTouch(ev) { var d = ev.domEvent || {}; return (d.touches && typeof d.touches.length === 'number') ? d.touches.length : 0; }
        function far(a, p) {
            if (!a || !p || a.x0 === null) { return false; }
            var s = a.touch ? SLOP_TOUCH : SLOP_MOUSE;
            return Math.abs(p.x - a.x0) > s || Math.abs(p.y - a.y0) > s;
        }
        function down(ev) {
            if (!S.on) { g = null; return; }
            var touch = ev.type === 'touchstart';
            if (touch && g && g.touch && nTouch(ev) > 1) { g.multi = true; return; }
            if (ev.type === 'mousedown' && ev.domEvent && ev.domEvent.button !== 0) { g = null; return; }
            var p = pt(ev);
            g = { ray: (ev.mouseRay && ev.mouseRay.clone) ? ev.mouseRay.clone() : null, x0: p ? p.x : null, y0: p ? p.y : null,
                  touch: touch, multi: touch && nTouch(ev) > 1, moved: false,
                  panel: panelOpen() || (S.pressPanel && Date.now() - S.pressAt < 800) };
        }
        function move(ev) {
            if (!g) { return; }
            if (ev.type === 'touchmove' && nTouch(ev) > 1) { g.multi = true; }
            if (far(g, pt(ev))) { g.moved = true; }
        }
        function up(ev) {
            if (!g) { return; }
            var a = g;
            if (nTouch(ev) > 0) { a.multi = true; return; }
            g = null;
            // a tap that closed the layers panel (it closes on the press) adds nothing
            if (!S.on || a.multi || a.moved || far(a, pt(ev)) || !a.ray || blocked() || a.panel || panelOpen()) { card(); return; }
            var p = rayToGround(a.ray.origin, a.ray.direction);
            if (!p || S.pts.length >= MAX_POINTS) { return; }
            S.pts.push(p);
            redraw();
        }
        // the layers panel closes on the press (document, capture) before the
        // map sees it: note whether it was open, on window in the capture phase (earlier)
        window.addEventListener('pointerdown', function () { S.pressPanel = panelOpen(); S.pressAt = Date.now(); }, true);
        ctl.addEventListener('mousedown', down);
        ctl.addEventListener('touchstart', down);
        ctl.addEventListener('mousemove', move);
        ctl.addEventListener('touchmove', move);
        ctl.addEventListener('mouseup', up);
        ctl.addEventListener('touchend', up);
        ctl.addEventListener('touchcancel', function () { g = null; });
    }

    // ---- 3D: the line (closed from three points on), a faint area fill, the points
    function redraw() { card(); draw3d(); }
    function card() {
        if (S.card) {
            var L = lang(), n = S.pts.length, why = S.on ? blocked() : '';
            var len = S.card.querySelector('[data-meas-len]'), sub = S.card.querySelector('[data-meas-sub]');
            len.textContent = n >= 2 ? fmtLen(pathLength(S.pts), L) : (n === 1 ? fmtLen(0, L) : '');
            sub.textContent = why ? t('measure.blocked.' + why)
                : n === 0 ? t('measure.hint_first')
                : n === 1 ? t('measure.hint_next')
                : n === 2 ? t('measure.pts', { n: n })
                : t('measure.pts_area', { n: n, area: fmtArea(polygonArea(S.pts), L),
                                          round: fmtLen(pathLength(S.pts.concat([S.pts[0]])), L) });
            sub.classList.toggle('is-warn', !!why);
            S.card.querySelector('[data-meas-undo]').disabled = n === 0;
            S.card.querySelector('[data-meas-clear]').disabled = n === 0;
        }
    }
    function draw3d() {
        var V = viewer3d(), T = root.ROS3D && ROS3D.THREE;
        if (!V || !T) { return; }
        if (!S.group) { S.group = new T.Object3D(); S.group.renderOrder = 60; V.scene.add(S.group); }
        S.group.children.slice().forEach(function (o) { S.group.remove(o); if (o.geometry) { o.geometry.dispose(); } if (o.material) { o.material.dispose(); } });
        S.group.visible = S.on && S.pts.length > 0;
        if (!S.group.visible) { return; }
        var Z = 0.03, ORDER = 60, COL = 0x0dcaf0;
        var mat = function (M, o) { return new M(Object.assign({ transparent: true, depthWrite: false, depthTest: false }, o)); };
        if (S.pts.length >= 3) {
            var shp = new T.Shape(S.pts.map(function (p) { return new T.Vector2(p.x, p.y); }));
            var f = new T.Mesh(new T.ShapeGeometry(shp), mat(T.MeshBasicMaterial, { color: COL, opacity: 0.12, side: T.DoubleSide }));
            f.position.z = Z - 0.005; f.renderOrder = ORDER; f.frustumCulled = false; S.group.add(f);
            // the closing side, fainter
            var gc = new T.Geometry();
            gc.vertices.push(new T.Vector3(S.pts[S.pts.length - 1].x, S.pts[S.pts.length - 1].y, Z), new T.Vector3(S.pts[0].x, S.pts[0].y, Z));
            var lc = new T.Line(gc, mat(T.LineBasicMaterial, { color: COL, opacity: 0.45 }));
            lc.renderOrder = ORDER + 1; lc.frustumCulled = false; S.group.add(lc);
        }
        if (S.pts.length >= 2) {
            var gl = new T.Geometry();
            S.pts.forEach(function (p) { gl.vertices.push(new T.Vector3(p.x, p.y, Z)); });
            var l = new T.Line(gl, mat(T.LineBasicMaterial, { color: COL, opacity: 1 }));
            l.renderOrder = ORDER + 2; l.frustumCulled = false; S.group.add(l);
        }
        var gp = new T.Geometry();
        S.pts.forEach(function (p) { gp.vertices.push(new T.Vector3(p.x, p.y, Z)); });
        var dots = new T.Points(gp, mat(T.PointsMaterial, { color: 0xffffff, size: 11, sizeAttenuation: false, map: dotTexture(T), alphaTest: 0.3 }));
        dots.renderOrder = ORDER + 3; dots.frustumCulled = false; S.group.add(dots);
    }

    // T17 M11: round points (a PointsMaterial draws squares): a small disc
    // with a dark rim, made once
    function dotTexture(T) {
        if (S.dotTex) { return S.dotTex; }
        var cv = document.createElement('canvas'); cv.width = cv.height = 32;
        var cx = cv.getContext('2d');
        cx.beginPath(); cx.arc(16, 16, 14, 0, Math.PI * 2); cx.fillStyle = '#1c2329'; cx.fill();
        cx.beginPath(); cx.arc(16, 16, 10, 0, Math.PI * 2); cx.fillStyle = '#ffffff'; cx.fill();
        S.dotTex = new T.Texture(cv); S.dotTex.needsUpdate = true;
        return S.dotTex;
    }

    // ---- place: under the layers button (same column), the card beside it
    function place() {
        if (!S.btn) { return; }
        var fab = $('vt_lyr_fab');
        var show = !!fab && !fab.hidden && getComputedStyle(fab).display !== 'none';
        if (S.btn.hidden === show) { S.btn.hidden = !show; }
        if (!show) { if (S.on) { setOn(false); } return; }
        var r = fab.getBoundingClientRect();
        var top = Math.round(r.bottom + 8);
        if (S.btn.style.top !== top + 'px') { S.btn.style.top = top + 'px'; }
        if (S.btn.style.left !== Math.round(r.left) + 'px') { S.btn.style.left = Math.round(r.left) + 'px'; }
        if (S.card && !S.card.hidden) {
            var left = Math.round(r.right + 8), W = window.innerWidth, st = S.card.style;
            // never over the bottom bar, the scale bar, the rain time label or
            // the credits (M10 check): the card ends above the highest of them
            var floor = chromeTop() - 6, ftop = cssVar('--vt-frame-top', 72) + 6;
            if (W < 576) {
                // phone: a strip over the bottom of the map, the map above it stays free for the taps
                st.left = '6px'; st.right = '6px'; st.width = 'auto'; st.top = 'auto';
                st.bottom = Math.round(window.innerHeight - floor) + 'px';
                st.maxHeight = Math.max(120, Math.round(floor - ftop)) + 'px';
            } else {
                st.left = left + 'px'; st.right = 'auto'; st.bottom = 'auto';
                st.width = Math.max(180, Math.min(300, W - left - 8)) + 'px';
                st.maxHeight = Math.max(120, Math.round(floor - ftop)) + 'px';
                var h = S.card.offsetHeight || 150;
                st.top = Math.round(Math.max(ftop, Math.min(top, floor - h))) + 'px';
            }
        }
    }
    function cssVar(k, d) {
        var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(k));
        return isFinite(v) ? v : d;
    }
    // the top of what sits at the bottom of the map: the bottom bar and,
    // above it, the scale bar, the rain time label, the credits chip
    function chromeTop() {
        var y = window.innerHeight - cssVar('--vt-frame-bottom', 44);
        ['div_bottom_menu', 'vt_map_scale', 'mapv3_precip_badge', 'mapv3_attr'].forEach(function (id) {
            var e = $(id);
            if (!e || e.hidden || !e.offsetParent && getComputedStyle(e).position !== 'fixed') { return; }
            var rc = e.getBoundingClientRect();
            if (rc.height > 0 && rc.top > window.innerHeight * 0.4) { y = Math.min(y, rc.top); }
        });
        return y;
    }

    function init() {
        if (!$('map_view')) { return; }
        build();
        var hook = setInterval(function () {
            var fab = $('vt_lyr_fab');
            if (!fab) { return; }
            clearInterval(hook);
            place();
            try {
                var mo = new MutationObserver(place);
                mo.observe(fab, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
                mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            } catch (e) { setInterval(place, 1000); }
        }, 300);
        window.addEventListener('resize', place);
        // the Marker panel / the editor may open while measuring: say why taps do nothing
        setInterval(function () { if (S.on) { card(); } }, 1000);
        if (root.VTI18n && root.VTI18n.onChange) { root.VTI18n.onChange(labels); }
    }

    api.setOn = setOn;
    api._S = S;
    root.VTMapMeasure = api;
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})(typeof window !== 'undefined' ? window : this);
