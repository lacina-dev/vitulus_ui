/* vt_map_robot.js — "the robot is out of view" pointer on the map (T17 M15, 2026-11-16).
 *
 * The map can be panned and zoomed anywhere (and a reload restores that
 * view), so the robot is often not on screen — and nothing said so: the map
 * looked the same as with the robot simply not drawn. Now, while the robot's
 * position is known and lies outside the free part of the map (off the
 * screen, under the left panel, the bars or the right panel), a small pill
 * stands at the edge of the map in the robot's direction: an arrow, "Robot"
 * and how far it is from the middle of the view. A tap moves the view onto
 * the robot once (zoom and rotation stay; the Follow mode is not touched).
 * With the robot in view there is no pill. A position that stopped coming
 * (no transform for STALE_MS, the link down) is not passed off as current:
 * the pill turns grey and says "last known position"; with no position at
 * all for a while a grey note says so instead of an arrow.
 * The pill keeps clear of what stands on the map (the compass rose, the
 * buttons, the rain bar, the scale, the credits, the right panel's handle)
 * and is not shown over a panel or a card.
 *
 * Cost: no timer and no subscription of its own. The position is the
 * map -> base_link transform the page's TF client already holds
 * (window.__tf_client_map, map_view.js); the check rides on the scale bar's
 * poll (VTMapScale.onTick, 4x a second while the page is visible) and, with
 * nothing moved since the last one, ends after one projection and a compare.
 * The DOM is written only when the pill's place, arrow or text changes.
 *
 * Safety: pure UI. No ROS, no HTTP, nothing goes to the robot; the tap moves
 * the camera of this browser only.
 *
 * Loaded by vt_map_layers.js (no index.html change). The pure part is tested
 * in node: tools/test_map_m15.node.js. i18n: maprobot.* (block "// M15").
 * ROS3D bundles its own THREE (r89): ROS3D.THREE, never window.THREE.
 */
(function (root) {
    'use strict';

    var MIN_MAP_W = 220;        // a smaller map (the swapped mini picture) gets no pill
    var IN_PAD = 10;            // the robot this close to the edge of the free part counts as out
    var ARROW_STEP = 5;         // degrees: the arrow turns in steps (fewer DOM writes)
    var STALE_MS = 3000;        // no base_link transform for this long: the position is old (the stream ticks at 20 Hz)
    var UNKNOWN_MS = 45000;     // no position at all this long after the page came up: say so (the first pose takes 15-40 s on a busy robot)
    var GAP = 6;                // px kept free around what stands on the map

    // ---- pure ------------------------------------------------------------

    // Is the screen point (x, y) inside the free part of the map? free =
    // {l, t, r, b} (CSS px), holes = rectangles of things standing over the
    // map inside it (the right panel).
    function inView(x, y, free, holes) {
        if (!(x >= free.l + IN_PAD && x <= free.r - IN_PAD && y >= free.t + IN_PAD && y <= free.b - IN_PAD)) { return false; }
        for (var i = 0; holes && i < holes.length; i++) {
            var h = holes[i];
            if (x >= h.l && x <= h.r && y >= h.t && y <= h.b) { return false; }
        }
        return true;
    }

    // Where on the border of rect {l, t, r, b} the line from its middle
    // towards (x, y) leaves it, and the direction (degrees, 0 = to the right,
    // 90 = down the screen). null: no rectangle, or the point is its middle.
    function edgePoint(x, y, rect) {
        if (!rect || !(rect.r > rect.l) || !(rect.b > rect.t) || !isFinite(x) || !isFinite(y)) { return null; }
        var cx = (rect.l + rect.r) / 2, cy = (rect.t + rect.b) / 2, dx = x - cx, dy = y - cy;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) { return null; }
        var kx = Math.abs(dx) < 1e-9 ? Infinity : (dx > 0 ? rect.r - cx : cx - rect.l) / Math.abs(dx);
        var ky = Math.abs(dy) < 1e-9 ? Infinity : (dy > 0 ? rect.b - cy : cy - rect.t) / Math.abs(dy);
        var k = Math.min(kx, ky, 1);          // a point inside the rectangle keeps its place
        var side = k >= 1 ? '' : (kx <= ky ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'b' : 't'));
        return { x: cx + dx * k, y: cy + dy * k, deg: Math.atan2(dy, dx) * 180 / Math.PI, side: side };
    }

    function hits(x, y, w, h, o) {
        return x - w / 2 < o.r + GAP && x + w / 2 > o.l - GAP && y - h / 2 < o.b + GAP && y + h / 2 > o.t - GAP;
    }
    // The pill (w x h, its middle on the border of rect towards (x, y)) must
    // not stand on any of obs ({l, t, r, b}: the rose, the rain bar …): it
    // steps inside past what it hits, a few times; the arrow keeps pointing
    // at (x, y). null: no free place — then no pill.
    function placeClear(x, y, rect, w, h, obs) {
        var r = { l: rect.l, t: rect.t, r: rect.r, b: rect.b };
        for (var n = 0; n < 6; n++) {
            var e = edgePoint(x, y, r);
            if (!e) { return null; }
            var hit = null;
            for (var i = 0; obs && i < obs.length && !hit; i++) { if (hits(e.x, e.y, w, h, obs[i])) { hit = obs[i]; } }
            if (!hit) { return e; }
            // the pill steps inside past what it hit — up / down or sideways,
            // whichever is the shorter step (a bar across the bottom is stepped
            // over, not walked around to the other side of the map)
            var cx = (r.l + r.r) / 2, cy = (r.t + r.b) / 2;
            var vert = e.y >= cy ? { k: 'b', v: hit.t - GAP - h / 2, d: e.y - (hit.t - GAP - h / 2) }
                                 : { k: 't', v: hit.b + GAP + h / 2, d: (hit.b + GAP + h / 2) - e.y };
            var hor = e.x >= cx ? { k: 'r', v: hit.l - GAP - w / 2, d: e.x - (hit.l - GAP - w / 2) }
                                : { k: 'l', v: hit.r + GAP + w / 2, d: (hit.r + GAP + w / 2) - e.x };
            var m = vert.d <= hor.d ? vert : hor;
            r[m.k] = m.v + ((m.k === 'b' || m.k === 'r') ? -0.5 : 0.5);
        }
        return null;
    }

    // How old is the robot's position? at = when its transform last came
    // (ms, map_view.js notes it; undefined on an older page = not known, taken
    // as fresh), linkUp = false when the link to the robot is down.
    // -> 'none' (no position), 'stale', 'live'
    function poseState(pose, at, now, linkUp) {
        if (!pose) { return 'none'; }
        if (linkUp === false) { return 'stale'; }
        if (typeof at === 'number' && isFinite(at) && now - at > STALE_MS) { return 'stale'; }
        return 'live';
    }

    // normalised device coordinates (x, y in -1..1, z > 1 = behind the camera)
    // -> CSS px on the canvas rectangle {l, t, w, h}. A point behind the
    // camera is mirrored, so its direction on the screen stays right.
    function ndcToPx(n, cv) {
        if (!n || !cv || !isFinite(n.x) || !isFinite(n.y)) { return null; }
        var sx = n.x, sy = n.y;
        if (n.z > 1) { sx = -sx * 1e3; sy = -sy * 1e3; }
        return { x: cv.l + (sx + 1) / 2 * cv.w, y: cv.t + (1 - sy) / 2 * cv.h };
    }

    // "4.2 m", "37 m", "1.25 km" (decimal comma in cs; U+00A0 before the unit)
    function fmtDist(m, lang) {
        if (!(m >= 0) || !isFinite(m)) { return ''; }
        var s, u = 'm';
        if (m >= 1000) { s = (m / 1000).toFixed(m >= 10000 ? 1 : 2); u = 'km'; }
        else if (m >= 10) { s = String(Math.round(m)); }
        else { s = m.toFixed(1); }
        return (lang === 'cs' ? s.replace('.', ',') : s) + ' ' + u;
    }

    // the map -> base_link transform as the TF client last got it
    function tfPose(tfc) {
        var f = tfc && tfc.frameInfos && tfc.frameInfos.base_link;
        var tr = f && f.transform && f.transform.translation;
        return (tr && isFinite(tr.x) && isFinite(tr.y)) ? { x: +tr.x, y: +tr.y, z: isFinite(tr.z) ? +tr.z : 0 } : null;
    }

    // the view moved onto p: camera and its target shift by the same step,
    // so zoom, tilt and rotation stay
    function recenter(camPos, center, p) {
        var dx = p.x - center.x, dy = p.y - center.y;
        camPos.x += dx; camPos.y += dy;
        center.x = p.x; center.y = p.y;
        return { dx: dx, dy: dy };
    }

    var api = { inView: inView, edgePoint: edgePoint, placeClear: placeClear, poseState: poseState, ndcToPx: ndcToPx, fmtDist: fmtDist,
                tfPose: tfPose, recenter: recenter, IN_PAD: IN_PAD, STALE_MS: STALE_MS, UNKNOWN_MS: UNKNOWN_MS, GAP: GAP };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (typeof document === 'undefined') { if (root) { root.VTMapRobot = api; } return; }

    // ---- DOM -------------------------------------------------------------

    function t(k, v) { return root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function lang() { return (root.VTI18n && root.VTI18n.lang && root.VTI18n.lang()) || 'en'; }
    function cssPx(cs, k, d) { var v = parseFloat(cs.getPropertyValue(k)); return isFinite(v) ? v : d; }

    var ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
        '<path d="M4 12h13M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var el = null, arrow = null, txt = null, vec = null;
    var lastIn = '', lastOut = '', dirty = true, hooked = false, t0 = Date.now();
    // what stands ON the map inside #map_view or beside it (covered() sees
    // only what lies over the map from outside)
    var OBSTACLES = ['vt_utm_rose', 'vt_lyr_fab', 'vt_meas_btn', 'vt_map_scale', 'mapv3_attr', 'mapv3_precip_badge', 'rp_handle', 'right_panel'];
    function obstacles() {
        var out = [];
        for (var i = 0; i < OBSTACLES.length; i++) {
            var e = document.getElementById(OBSTACLES[i]);
            if (!e || e.hidden || !e.offsetWidth || !e.offsetHeight) { continue; }
            var r = e.getBoundingClientRect();
            out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
        }
        return out;
    }
    function linkUp() {
        try { var c = root.__tf_client_map; return !!(c && c.ros && c.ros.isConnected); } catch (e) { return true; }
    }

    function viewer() {
        var V = root.viewer && root.viewer.viewer;
        return (V && V.camera && V.cameraControls) ? V : null;
    }

    function build() {
        el = document.createElement('button');
        el.type = 'button';
        el.id = 'vt_map_robot';
        el.className = 'vt-map-robot';
        el.hidden = true;
        el.innerHTML = '<span class="vt-map-robot-a">' + ARROW + '</span><span class="vt-map-robot-t vt-tnum"></span>';
        arrow = el.firstChild;
        txt = el.lastChild;
        el.addEventListener('click', go);
        // its arrow keys never reach the keyboard driving (vt_joy.js on window)
        el.addEventListener('keydown', function (e) { if (/^Arrow/.test(e.key)) { e.stopPropagation(); } });
        document.body.appendChild(el);
    }

    function hide() {
        if (el && !el.hidden) { el.hidden = true; }
        lastOut = '';
    }

    // the tap: the view goes onto the robot, once
    function go() {
        var V = viewer(), p = tfPose(root.__tf_client_map);
        if (!V || !p) { return; }
        recenter(V.camera.position, V.cameraControls.center, p);
        // tell the camera's listeners (the stored view of map_view.js)
        try { V.cameraControls.dispatchEvent({ type: 'change' }); } catch (e) { /* controls without events */ }
        dirty = true;
        hide();
    }

    // something stands over the place (a panel, a card, a sheet)? Then no pill there.
    function covered(x, y) {
        if (!document.elementsFromPoint) { return false; }
        var list = document.elementsFromPoint(x, y), host = document.getElementById('map_view');
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (e === el || el.contains(e)) { continue; }
            return !(host && (e === host || host.contains(e)));
        }
        return false;
    }

    function update() {
        var V = viewer(), T = root.ROS3D && root.ROS3D.THREE;
        if (!V || !T) { hide(); return; }
        var tfc = root.__tf_client_map, p = tfPose(tfc), now = Date.now();
        var cv = V.renderer && V.renderer.domElement;
        if (!cv) { hide(); return; }
        var st = poseState(p, tfc && tfc._vtPoseAt, now, linkUp());
        // no position at all: said only after a while (the page is still coming up)
        if (st === 'none' && now - t0 < UNKNOWN_MS) { hide(); return; }
        var cam = V.camera, c = V.cameraControls.center, cp = cam.position;
        // nothing moved since the last look: done (the usual case)
        var sigIn = st + '|' + (p ? p.x.toFixed(2) + ',' + p.y.toFixed(2) : '-') + '|' + cp.x.toFixed(2) + ',' + cp.y.toFixed(2) + ',' + cp.z.toFixed(2) + '|' +
            c.x.toFixed(2) + ',' + c.y.toFixed(2) + '|' + cam.rotation.z.toFixed(3) + '|' + window.innerWidth + 'x' + window.innerHeight;
        if (!dirty && sigIn === lastIn) { return; }
        lastIn = sigIn;
        dirty = false;
        if (!el) { build(); }
        var cr = cv.getBoundingClientRect();
        if (cr.width < MIN_MAP_W || cr.height < 120 || document.body.classList.contains('vt-cam-large')) { hide(); return; }
        // the free part of the map: between the frame's edges (vt_frame.js)
        var cs = getComputedStyle(document.documentElement), W = window.innerWidth, H = window.innerHeight;
        var ftop = cssPx(cs, '--vt-frame-top', 72), fbot = cssPx(cs, '--vt-frame-bottom', 44);
        var cleft = cssPx(cs, '--vt-frame-cleft', 0), rpw = cssPx(cs, '--vt-frame-rp-w', 0), rpb = cssPx(cs, '--vt-frame-rp-b', 0);
        var free = { l: Math.max(cleft, cr.left), t: Math.max(ftop, cr.top), r: Math.min(W, cr.right), b: Math.min(H - fbot, cr.bottom) };
        var s = null;
        if (p) {
            // the camera's matrices are those of the last DRAWN picture: a tick
            // between a move of the camera (the tap here, Follow on every
            // transform) and the next picture would point the old way and then
            // keep it (the signature above already holds the new view). So the
            // matrices are brought up to the camera's present place first.
            cam.updateMatrixWorld();
            cam.matrixWorldInverse.getInverse(cam.matrixWorld);
            vec = vec || new T.Vector3();
            vec.set(p.x, p.y, p.z).project(cam);
            s = ndcToPx(vec, { l: cr.left, t: cr.top, w: cr.width, h: cr.height });
            if (!s) { hide(); return; }
            var holes = (rpw > 0 && rpb > free.t) ? [{ l: W - rpw, t: free.t, r: W, b: rpb }] : [];
            if (inView(s.x, s.y, free, holes)) { hide(); return; }
        }
        // the pill: text first (its size decides where it fits)
        var L = lang(), dist = p ? fmtDist(Math.hypot(p.x - c.x, p.y - c.y), L) : '';
        var lab = st === 'none' ? t('maprobot.unknown') : (st === 'stale' ? t('maprobot.stale') : t('maprobot.label', { d: dist }));
        var tip = st === 'none' ? t('maprobot.unknown_tip') : (st === 'stale' ? t('maprobot.stale_tip', { d: dist }) : t('maprobot.tip', { d: dist }));
        if (txt.textContent !== lab) { txt.textContent = lab; }
        if (el.title !== tip) { el.title = tip; el.setAttribute('aria-label', tip); }
        if (el.getAttribute('data-state') !== st) { el.setAttribute('data-state', st); }
        var wasHidden = el.hidden;
        if (wasHidden) { el.style.visibility = 'hidden'; el.hidden = false; }
        var w = el.offsetWidth || 110, h = el.offsetHeight || 40;
        // it stands clear of the notices (top) and of the frame's edges; what
        // stands on the map is stepped around (placeClear)
        var nb = cssPx(cs, '--vt-frame-notice-b', 0);
        var rect = { l: free.l + 8 + w / 2, t: Math.max(free.t, nb) + 8 + h / 2, r: free.r - 8 - w / 2, b: free.b - 8 - h / 2 };
        // no position: no direction either — the note stands at the bottom, in the middle
        var e = p ? placeClear(s.x, s.y, rect, w, h, obstacles())
            : placeClear((rect.l + rect.r) / 2, rect.b + 1000, rect, w, h, obstacles());
        if (!e || covered(e.x, e.y)) { el.style.visibility = ''; hide(); return; }
        var deg = Math.round(e.deg / ARROW_STEP) * ARROW_STEP;
        var sigOut = Math.round(e.x) + ',' + Math.round(e.y) + ',' + deg;
        if (sigOut !== lastOut) {
            lastOut = sigOut;
            el.style.left = Math.round(e.x - w / 2) + 'px';
            el.style.top = Math.round(e.y - h / 2) + 'px';
            arrow.style.transform = 'rotate(' + deg + 'deg)';
        }
        if (wasHidden) { el.style.visibility = ''; }
    }

    function init() {
        if (!document.getElementById('map_view')) { return; }
        var S = root.VTMapScale;
        if (!S || !S.onTick) { return; }      // an older scale module: no pointer (never a timer of its own)
        if (hooked) { return; }
        hooked = true;
        S.onTick(update);
        var mark = function () { dirty = true; };
        // the frame moves its edges through CSS variables on <html> and modes on <body>
        try {
            var mo = new MutationObserver(mark);
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
            mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        } catch (e) { /* old browser: the next camera or robot move places it */ }
        window.addEventListener('resize', mark);
        if (root.VTI18n && root.VTI18n.onChange) { root.VTI18n.onChange(function () { dirty = true; if (txt) { txt.textContent = ''; } }); }
    }

    api.update = function () { dirty = true; update(); };
    root.VTMapRobot = api;
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})(typeof window !== 'undefined' ? window : this);
