/* vt_map_scale.js — the scale bar on the map (T17 M8-1, 2026-11-08).
 *
 * A small bar in the map's bottom-left corner, just above the credits chip:
 * its length is a round distance (1, 2 or 5 × 10^n m: 1 cm … 50 km) and the
 * label says it. It follows every zoom (wheel, pinch, the zoom buttons, the
 * editor, a camera restored from the last visit). Before, nothing on the map
 * told how far 40 m of garden is (map_audit2.md 1.6).
 *
 * How: the 3D view looks almost straight down through a very narrow lens
 * (FOV ~1.4°, mapping.js), so one screen pixel at the centre covers
 *     2 · distance · tan(fov / 2) / canvas height
 * metres. Read from the camera 4× a second while the page is visible (the
 * camera has no single "changed" event across ROS3D, the editor and the
 * saved-view restore); the DOM is touched only when the label or the bar
 * length changes. Hidden while the map is the small swapped picture or the
 * camera fills the screen.
 *
 * Pure UI: no ROS, no HTTP, nothing goes to the robot. The pure part
 * (niceScale, label) is tested in node: tools/test_map_scale.node.js.
 * i18n: mapscale.* (en.js + cs.js, block "// M8").
 */
(function (root) {
    'use strict';

    var STEPS = [1, 2, 5];
    var MIN_M = 0.01;           // shortest bar: 1 cm (the camera can come very close, T23)
    var MAX_M = 50000;          // longest: 50 km (the rain radar far out)
    var POLL_MS = 250;
    var MIN_MAP_W = 220;        // a smaller map (the swapped mini picture) shows no bar

    // ---- pure ------------------------------------------------------------

    // The longest round distance whose bar fits in maxPx at mpp metres per
    // CSS pixel. -> {m, px} or null (no sensible scale).
    function niceScale(mpp, maxPx) {
        if (!(mpp > 0) || !isFinite(mpp) || !(maxPx > 0)) { return null; }
        var maxM = mpp * maxPx;
        if (maxM < MIN_M) { return { m: MIN_M, px: MIN_M / mpp }; }
        var e = Math.floor(Math.log(maxM) / Math.LN10), best = null;
        for (var k = e - 1; k <= e; k++) {
            for (var i = 0; i < STEPS.length; i++) {
                var m = STEPS[i] * Math.pow(10, k);
                m = Math.round(m * 1000) / 1000;          // 0.5 not 0.5000000001
                if (m <= maxM + 1e-9 && m >= MIN_M && m <= MAX_M && (!best || m > best)) { best = m; }
            }
        }
        if (!best) { best = Math.min(MAX_M, Math.max(MIN_M, maxM)); }
        return { m: best, px: best / mpp };
    }

    // "50 cm", "20 m", "2 km" (decimal comma in cs; the number and unit never
    // break apart: U+00A0 comes from the i18n strings)
    function label(m, t, lang) {
        t = t || function (k, v) { return v.n + ' ' + k.split('.').pop(); };
        var fmt = function (n) {
            var s = String(Math.round(n * 100) / 100);
            return lang === 'cs' ? s.replace('.', ',') : s;
        };
        if (m < 1) { return t('mapscale.cm', { n: fmt(m * 100) }); }
        if (m >= 1000) { return t('mapscale.km', { n: fmt(m / 1000) }); }
        return t('mapscale.m', { n: fmt(m) });
    }

    // metres per CSS pixel at the centre of a perspective camera looking at
    // `center` from `dist`, the canvas `h` CSS pixels high
    function metersPerPx(fovDeg, dist, h) {
        if (!(fovDeg > 0) || !(dist > 0) || !(h > 0)) { return 0; }
        return 2 * dist * Math.tan(fovDeg * Math.PI / 360) / h;
    }

    var api = { niceScale: niceScale, label: label, metersPerPx: metersPerPx, MIN_M: MIN_M, MAX_M: MAX_M };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (typeof document === 'undefined') { if (root) { root.VTMapScale = api; } return; }

    // ---- DOM -------------------------------------------------------------

    function t(k, v) { return root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function lang() { return (root.VTI18n && root.VTI18n.lang && root.VTI18n.lang()) || 'en'; }

    var el = null, bar = null, txt = null, last = '', timer = null;

    function viewer() {
        var M = root.mapping_v3;
        if (M && M.viewer3d && M.viewer3d.camera) { return M.viewer3d; }
        var V = root.viewer && root.viewer.viewer;
        return (V && V.camera) ? V : null;
    }

    function build(host) {
        el = document.createElement('div');
        el.id = 'vt_map_scale';
        el.className = 'vt-map-scale';
        el.setAttribute('role', 'img');
        el.hidden = true;
        el.innerHTML = '<span class="vt-map-scale-t vt-tnum"></span><span class="vt-map-scale-bar" aria-hidden="true"></span>';
        txt = el.firstChild;
        bar = el.lastChild;
        // after the credits chip: same corner, above it (CSS)
        host.appendChild(el);
    }

    function hide() {
        if (el && !el.hidden) { el.hidden = true; last = ''; host().style.removeProperty('--vt-map-scale-h'); }
    }
    function host() { return document.getElementById('map_view'); }

    function update() {
        if (document.hidden) { return; }
        var h = host();
        if (!h) { return; }
        if (!el) { build(h); }
        var V = viewer();
        var cv = V && V.renderer && V.renderer.domElement;
        var ctl = V && V.cameraControls;
        if (!V || !cv || !ctl || !ctl.center || !V.camera.position) { hide(); return; }
        var w = cv.clientWidth, ch = cv.clientHeight;
        if (w < MIN_MAP_W || ch < 120 || document.body.classList.contains('vt-cam-large')) { hide(); return; }
        var cam = V.camera, c = ctl.center, p = cam.position;
        var dist = Math.sqrt(Math.pow(p.x - c.x, 2) + Math.pow(p.y - c.y, 2) + Math.pow(p.z - c.z, 2));
        var s = niceScale(metersPerPx(cam.fov, dist, ch), Math.max(48, Math.min(120, w * 0.22)));
        if (!s) { hide(); return; }
        var px = Math.max(8, Math.round(s.px));
        var lab = label(s.m, t, lang());
        var sig = lab + '|' + px;
        if (sig !== last) {
            last = sig;
            txt.textContent = lab;
            bar.style.width = px + 'px';
            el.setAttribute('aria-label', t('mapscale.aria', { d: lab }));
        }
        if (el.hidden) {
            el.hidden = false;
            // the rain time label (vt-map-precip) moves up by the bar's height
            h.style.setProperty('--vt-map-scale-h', (el.offsetHeight + 4) + 'px');
        }
    }

    function init() {
        if (!host()) { return; }
        if (!timer) { timer = setInterval(update, POLL_MS); }
        document.addEventListener('visibilitychange', update);
        if (root.VTI18n && root.VTI18n.onChange) { root.VTI18n.onChange(function () { last = ''; update(); }); }
        update();
    }

    api.update = update;
    root.VTMapScale = api;
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})(typeof window !== 'undefined' ? window : this);
