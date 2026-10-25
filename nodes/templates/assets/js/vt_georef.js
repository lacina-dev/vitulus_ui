/* vt_georef.js — the UTM frame of the map and the map-vs-GPS deviation
 * (vitulus-field#32, owner 2026-10-25: "show the UTM frame, what it is, and
 * the deviation").
 *
 * Source: /nav_tf/georef_status (navi_transform, JSON, latched, 1 Hz):
 *   utm_zone + utm_band + hemisphere, utm_e / utm_n (map origin = datum),
 *   map_yaw_deg (the map's rotation within the UTM grid), convergence_deg
 *   (grid convergence at the origin), manual_yaw_deg (= map_yaw − convergence,
 *   ~0 on a true-north map), dev_m / dev_dx / dev_dy (map vs GPS — the
 *   gps-map-probe dD: GPS fix → UTM → map through the datum, minus the
 *   antenna in map) or null + reason, gps_x/y + ant_x/y (map), owner.
 * Until the robot publishes it (a stack from before this change) the frame
 * part comes from webnode /api/datum (no deviation then).
 *
 * Shows it in four places:
 *   1. left panel › Map › Loc: card "UTM frame" (#loc_utm_card) — zone,
 *      origin, rotation + one human sentence, the live deviation;
 *   2. the map: a small compass rose in the hollow's top-left corner — true
 *      north and UTM grid north on screen (follows the camera), the angle
 *      between them; only while a map with a datum is served;
 *   3. the map: the layer "UTM grid" (Layers row, #mapv3_chk_utmgrid,
 *      remembered) — UTM lines every 10 m (every 100 m stronger) turned into
 *      the map frame, and, when the deviation is above the orange limit, the
 *      GPS position as a ring next to the robot with a dashed line;
 *   4. right panel › Navi expand: the quick number "Map vs GPS" (right_dock.js
 *      reads window.VtGeoref.quick()), click = this card.
 * Colours: ≤ 5 cm green, ≤ 15 cm orange, above red (DEV_OK / DEV_WARN).
 * Cost: one latched 1 Hz String; the rose repaints at 5 Hz only while the
 * page is visible; the grid is rebuilt only when the frame changes.
 * ROS3D bundles its own THREE (r89): everything is built from ROS3D.THREE.
 * i18n: keys 'utm.*' (en.js + cs.js).
 */
(function () {
    'use strict';

    var TOPIC = '/nav_tf/georef_status';
    var DEV_OK = 0.05, DEV_WARN = 0.15;        // m
    var START_X = 20;                           // m: "a start X m from the dock"
    var GRID_STEP = 10, GRID_MAJOR = 100, GRID_HALF = 200;   // m (UTM)
    var LS_GRID = 'vitulus_layer_utmgrid';
    var STALE_MS = 5000;

    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tag(e, k, attr) { if (window.VTI18n) { VTI18n.tag(e, k, attr); } }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function el(tagName, cls, parent) {
        var e = document.createElement(tagName);
        if (cls) { e.className = cls; }
        if (parent) { parent.appendChild(e); }
        return e;
    }
    function num(v) { return (v === null || v === undefined || isNaN(Number(v))) ? null : Number(v); }
    function fmt(v, d) { return v == null ? '—' : Number(v).toFixed(d); }
    function deg(v, d) {
        if (v == null) { return '—'; }
        var s = Number(v).toFixed(d == null ? 3 : d);
        return (Number(s) > 0 ? '+' : '') + s.replace('-', '−') + '°';
    }
    function grp(v) {          // 5540714.687 -> "5 540 714.69"
        if (v == null) { return '—'; }
        var p = Number(v).toFixed(2).split('.');
        return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + p[1];
    }

    var S = {msg: null, rx: 0, datum: null};

    // ---------------------------------------------------------------- model
    /* the frame (zone, origin, rotation) — from the robot, else /api/datum */
    function frame() {
        var m = S.msg && Date.now() - S.rx < STALE_MS ? S.msg : null;
        if (m && m.utm_e != null && m.map_yaw_deg != null) {
            return {zone: m.utm_zone, band: m.utm_band, hemi: m.hemisphere || 'N',
                    e: m.utm_e, n: m.utm_n, yaw: num(m.map_yaw_deg) * Math.PI / 180,
                    conv: num(m.convergence_deg) == null ? null : num(m.convergence_deg) * Math.PI / 180,
                    manual: num(m.manual_yaw_deg), src: 'robot'};
        }
        var d = S.datum;
        if (!d || !d.ok || d.utm_e == null) { return null; }
        var zone = d.utm_zone || 33, conv = null, band = null, hemi = 'N';
        if (d.origin_lat != null && d.origin_lon != null) {
            var lon0 = zone * 6 - 183;
            conv = Math.atan(Math.tan((d.origin_lon - lon0) * Math.PI / 180) *
                             Math.sin(d.origin_lat * Math.PI / 180));
            band = 'CDEFGHJKLMNPQRSTUVWX'[Math.min(19, Math.floor((d.origin_lat + 80) / 8))] || null;
            hemi = d.origin_lat >= 0 ? 'N' : 'S';
        }
        var yaw = Number(d.yaw_rad) || 0;
        return {zone: zone, band: band, hemi: hemi, e: d.utm_e, n: d.utm_n, yaw: yaw, conv: conv,
                manual: conv == null ? null : (yaw - conv) * 180 / Math.PI, src: 'datum'};
    }
    /* the deviation: {m, dx, dy, state, reason} */
    function dev() {
        var m = S.msg && Date.now() - S.rx < STALE_MS ? S.msg : null;
        if (!m) { return {m: null, state: 'off', reason: S.msg ? 'stale' : 'no_status'}; }
        var v = num(m.dev_m);
        if (v == null) { return {m: null, state: 'off', reason: m.reason || 'no_fix', raw: num(m.dev_raw_m)}; }
        return {m: v, dx: num(m.dev_dx), dy: num(m.dev_dy),
                state: v <= DEV_OK ? 'ok' : (v <= DEV_WARN ? 'warn' : 'err'), reason: null};
    }
    function devText(d) {
        return d.m != null ? (d.m * 100).toFixed(1) + ' cm' : '—';
    }
    function reasonText(d) {
        return t('utm.reason.' + (d.reason || 'no_fix'));
    }
    function zoneText(f) {
        if (!f || f.zone == null) { return '—'; }
        return f.zone + (f.band || '') + (f.band ? ' (' + f.zone + f.hemi + ')' : f.hemi);
    }

    // ------------------------------------------------- 1. the Loc card
    var card, rows = {}, sentence, devRow, cardLast = '';
    function buildCard() {
        var tab = document.getElementById('tab-gloc');
        if (!tab) { return false; }
        card = document.getElementById('loc_utm_card');
        if (!card) {
            card = el('div', 'vt-card vt-mb2 vt-utm-card');
            card.id = 'loc_utm_card';
            card.dataset.state = 'off';
            var head = el('div', 'vt-card-head', card);
            var ti = el('span', 'vt-card-title', head);
            ti.textContent = t('utm.title');
            tag(ti, 'utm.title');
            var sub = el('span', 'vt-end', head);
            sub.textContent = t('utm.sub');
            tag(sub, 'utm.sub');
            var dl = el('dl', 'vt-kv vt-utm-kv', card);
            [['zone', 'utm.zone', 'utm.zone_tip'], ['origin', 'utm.origin', 'utm.origin_tip'],
             ['yaw', 'utm.yaw', 'utm.yaw_tip'], ['conv', 'utm.conv', 'utm.conv_tip'],
             ['manual', 'utm.manual', 'utm.manual_tip']].forEach(function (r) {
                var dt = el('dt', null, dl);
                dt.textContent = t(r[1]);
                tag(dt, r[1]);
                dt.title = t(r[2]);
                tag(dt, r[2], 'title');
                rows[r[0]] = el('dd', null, dl);
            });
            sentence = el('div', 'vt-utm-say vt-muted', card);
            devRow = el('div', 'vt-utm-dev', card);
            var dk = el('span', 'vt-utm-dev-k', devRow);
            dk.textContent = t('utm.dev');
            tag(dk, 'utm.dev');
            devRow.title = t('utm.dev_tip', {ok: DEV_OK * 100, warn: DEV_WARN * 100});
            el('b', 'vt-utm-dev-v', devRow);
            el('span', 'vt-utm-dev-why vt-muted', devRow);
        }
        placeCard(tab);
        return true;
    }
    /* right below "Localization detail" (right_dock.js puts that one first) */
    function placeCard(tab) {
        var det = document.getElementById('loc_gnss_card');
        if (det && det.parentNode === tab) {
            if (det.nextSibling !== card) { tab.insertBefore(card, det.nextSibling); }
        } else if (card.parentNode !== tab) {
            tab.insertBefore(card, tab.firstChild);
        }
    }
    function paintCard() {
        if (!card) { if (!buildCard()) { return; } }
        var tab = document.getElementById('tab-gloc');
        if (tab) { placeCard(tab); }
        var f = frame(), d = dev();
        var key = JSON.stringify([f, d, window.VTI18n && VTI18n.lang && VTI18n.lang()]);
        if (key === cardLast) { return; }
        cardLast = key;
        rows.zone.textContent = zoneText(f);
        rows.origin.textContent = f ? 'E ' + grp(f.e) + ' · N ' + grp(f.n) : '—';
        rows.yaw.textContent = f ? deg(f.yaw * 180 / Math.PI) : '—';
        rows.conv.textContent = f && f.conv != null ? deg(f.conv * 180 / Math.PI) : '—';
        rows.manual.textContent = f && f.manual != null ? deg(f.manual) : '—';
        var manualOff = f && f.manual != null && Math.abs(f.manual) > 0.05;
        rows.manual.className = manualOff ? 'vt-tone-warn' : '';
        if (f) {
            var shift = 2 * Math.sin(Math.abs(f.yaw) / 2) * START_X;
            sentence.textContent = (f.conv != null ?
                t('utm.say', {c: deg(f.conv * 180 / Math.PI, 2)}) : t('utm.say_noconv')) + ' ' +
                t('utm.say_shift', {x: START_X, y: shift < 0.1 ? (shift * 100).toFixed(1) + ' cm' : shift.toFixed(2) + ' m'}) +
                (manualOff ? ' ' + t('utm.say_manual', {m: deg(f.manual, 2)}) : '');
        } else {
            sentence.textContent = t('utm.no_frame');
        }
        var v = devRow.querySelector('.vt-utm-dev-v'), why = devRow.querySelector('.vt-utm-dev-why');
        v.textContent = d.m != null ? devText(d) : '—';
        v.className = 'vt-utm-dev-v' + (d.m != null ? ' vt-tone-' + d.state : '');
        why.textContent = d.m != null ?
            (d.dx != null ? 'Δx ' + fmt(d.dx * 100, 1) + ' · Δy ' + fmt(d.dy * 100, 1) + ' cm' : '') :
            reasonText(d) + (d.raw != null ? ' · ' + t('utm.raw', {v: (d.raw * 100).toFixed(1)}) : '');
        card.dataset.state = !f ? 'off' : (d.m != null ? d.state : (manualOff ? 'warn' : 'info'));
    }

    // ------------------------------------------------- 2. the compass rose
    var rose, roseTrue, roseGrid, roseTxt;
    var SVGNS = 'http://www.w3.org/2000/svg';
    function svgEl(n, attrs, parent) {
        var e = document.createElementNS(SVGNS, n);
        Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
        if (parent) { parent.appendChild(e); }
        return e;
    }
    function buildRose() {
        if (rose) { return; }
        rose = el('div', 'vt-utm-rose');
        rose.id = 'vt_utm_rose';
        rose.style.display = 'none';
        var svg = svgEl('svg', {viewBox: '-32 -32 64 64', width: '60', height: '60', 'aria-hidden': 'true'}, rose);
        svgEl('circle', {cx: 0, cy: 0, r: 27, class: 'vt-utm-rose-ring'}, svg);
        [0, 90, 180, 270].forEach(function (a) {
            svgEl('line', {x1: 0, y1: -27, x2: 0, y2: -23, class: 'vt-utm-rose-tick',
                           transform: 'rotate(' + a + ')'}, svg);
        });
        roseGrid = svgEl('g', {class: 'vt-utm-rose-grid'}, svg);
        svgEl('line', {x1: 0, y1: 6, x2: 0, y2: -24}, roseGrid);
        svgEl('text', {x: 0, y: -14, class: 'vt-utm-rose-lbl', 'text-anchor': 'middle'}, roseGrid).textContent = 'G';
        roseTrue = svgEl('g', {class: 'vt-utm-rose-true'}, svg);
        svgEl('path', {d: 'M0 -25 L5 0 L0 -4 L-5 0 Z'}, roseTrue);
        svgEl('path', {d: 'M0 25 L5 0 L0 4 L-5 0 Z', class: 'vt-utm-rose-s'}, roseTrue);
        svgEl('text', {x: 0, y: -27, class: 'vt-utm-rose-n', 'text-anchor': 'middle'}, roseTrue).textContent = 'N';
        roseTxt = el('div', 'vt-utm-rose-t', rose);
        document.body.appendChild(rose);
    }
    function v3() { return window.viewer && window.viewer.viewer; }
    /* screen angle (rad, clockwise from screen-up) of a map-frame direction */
    function screenAngle(V, dx, dy) {
        var T = window.ROS3D && ROS3D.THREE, cam = V && V.camera;
        if (!T || !cam || !V.renderer) { return null; }
        var cc = V.cameraControls && V.cameraControls.center;
        var c = cc ? new T.Vector3(cc.x, cc.y, 0) : new T.Vector3(0, 0, 0);
        var p0 = c.clone().project(cam), p1 = new T.Vector3(c.x + dx, c.y + dy, 0).project(cam);
        var sz = V.renderer.getSize ? V.renderer.getSize() : {width: 1, height: 1};
        var sx = (p1.x - p0.x) * (sz.width || 1), sy = (p1.y - p0.y) * (sz.height || 1);
        if (Math.abs(sx) + Math.abs(sy) < 1e-9) { return null; }
        return Math.atan2(sx, sy);
    }
    function paintRose() {
        buildRose();
        var f = frame();
        var show = !!(f && f.conv != null && !document.hidden && v3() && v3().renderer &&
                      !document.body.classList.contains('vt-cam-large'));
        /* the visible part of the map (the C's hollow) must be tall enough:
           a phone with the sheet open leaves only a strip */
        if (show) {
            var cs = getComputedStyle(document.documentElement);
            var top = parseFloat(cs.getPropertyValue('--vt-frame-top')) || 0;
            var bot = parseFloat(cs.getPropertyValue('--vt-frame-cbottom')) || 0;
            show = window.innerHeight - top - bot >= 150;
        }
        if (!show) { if (rose.style.display !== 'none') { rose.style.display = 'none'; } return; }
        /* true north in map = R(-trueYaw)·(0,1); grid north = R(-yaw)·(0,1) */
        var ty = f.yaw - f.conv;
        var aT = screenAngle(v3(), Math.sin(ty), Math.cos(ty));
        var aG = screenAngle(v3(), Math.sin(f.yaw), Math.cos(f.yaw));
        if (aT == null || aG == null) { rose.style.display = 'none'; return; }
        rose.style.display = '';
        roseTrue.setAttribute('transform', 'rotate(' + (aT * 180 / Math.PI).toFixed(2) + ')');
        roseGrid.setAttribute('transform', 'rotate(' + (aG * 180 / Math.PI).toFixed(2) + ')');
        var txt = 'N→G ' + deg(f.conv * 180 / Math.PI, 2);
        if (roseTxt.textContent !== txt) { roseTxt.textContent = txt; }
        var tip = t('utm.rose_tip', {c: deg(f.conv * 180 / Math.PI, 3)});
        if (rose.title !== tip) { rose.title = tip; }
    }

    // ------------------------------------------- 3. the UTM grid layer
    var chk, grid = null, gridKey = '', gpsMark = null;
    function ensureCheckbox() {
        chk = document.getElementById('mapv3_chk_utmgrid');
        if (!chk) {
            var row = document.querySelector('.map-layers-row');
            if (!row) { return null; }
            var div = el('div', 'form-check form-check-inline', row);
            div.setAttribute('data-i18n-title', 'utm.layer_tip');
            div.title = t('utm.layer_tip');
            div.innerHTML = '<input class="form-check-input" type="checkbox" id="mapv3_chk_utmgrid">' +
                '<label class="form-check-label vt-fs-sm" for="mapv3_chk_utmgrid">' +
                '<span data-i18n="utm.layer">UTM grid</span> <span class="vt-sw-utm">&#9638;</span></label>';
            if (window.VTI18n && VTI18n.apply) { VTI18n.apply(div); }
            chk = document.getElementById('mapv3_chk_utmgrid');
        }
        chk.checked = lsGet(LS_GRID) === '1';
        chk.addEventListener('change', function () { lsSet(LS_GRID, chk.checked ? '1' : '0'); paintGrid(); });
        return chk;
    }
    function utmToMap(f, e, n) {
        var dx = e - f.e, dy = n - f.n, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
        return [c * dx + s * dy, -s * dx + c * dy];
    }
    function lineMesh(T, pts, color, opacity, order) {
        var g = new T.BufferGeometry();
        var a = new T.BufferAttribute(new Float32Array(pts), 3);
        if (g.setAttribute) { g.setAttribute('position', a); } else { g.addAttribute('position', a); }
        /* depthTest off: the occupancy planes sit above z 0 and would hide the
           lines; the paint order is the renderOrder (MapLayerOrder) */
        var m = new T.LineBasicMaterial({color: color, transparent: true, opacity: opacity,
                                         depthWrite: false, depthTest: false});
        var o = new T.LineSegments(g, m);
        o.renderOrder = order;
        o.frustumCulled = false;
        return o;
    }
    var ORDER = function () {
        var o = (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder : {};
        return o.UTMGRID !== undefined ? o.UTMGRID : 24;
    };
    function buildGrid(f) {
        var T = window.ROS3D && ROS3D.THREE, V = v3();
        if (!T || !V || !V.scene) { return; }
        if (grid) { V.scene.remove(grid); grid = null; }
        grid = new T.Object3D();
        var z = 0.025, minor = [], major = [];
        var e0 = Math.floor((f.e - GRID_HALF) / GRID_STEP) * GRID_STEP;
        var n0 = Math.floor((f.n - GRID_HALF) / GRID_STEP) * GRID_STEP;
        var e1 = f.e + GRID_HALF, n1 = f.n + GRID_HALF;
        var push = function (arr, a, b) { arr.push(a[0], a[1], z, b[0], b[1], z); };
        for (var e = e0; e <= e1; e += GRID_STEP) {
            push(Math.round(e) % GRID_MAJOR === 0 ? major : minor,
                 utmToMap(f, e, n0), utmToMap(f, e, n1));
        }
        for (var n = n0; n <= n1; n += GRID_STEP) {
            push(Math.round(n) % GRID_MAJOR === 0 ? major : minor,
                 utmToMap(f, e0, n), utmToMap(f, e1, n));
        }
        grid.add(lineMesh(T, minor, 0xffb74d, 0.6, ORDER()));
        grid.add(lineMesh(T, major, 0xffd180, 1.0, ORDER()));
        V.scene.add(grid);
    }
    function paintGrid() {
        var f = frame();
        var on = !!(chk && chk.checked && f);
        if (on) {
            var k = [f.e, f.n, f.yaw.toFixed(7)].join('|');
            if (k !== gridKey || !grid) { gridKey = k; buildGrid(f); }
        }
        if (grid) { grid.visible = on; }
    }
    /* GPS beside the robot: only when the deviation is above the orange limit */
    function paintGpsMark() {
        var T = window.ROS3D && ROS3D.THREE, V = v3(), m = S.msg, d = dev();
        var show = !!(T && V && V.scene && d.m != null && d.m > DEV_WARN && m &&
                      m.gps_x != null && m.ant_x != null);
        if (!show) { if (gpsMark) { gpsMark.visible = false; } return; }
        if (gpsMark) { V.scene.remove(gpsMark); }
        gpsMark = new T.Object3D();
        var z = 0.06, gx = m.gps_x, gy = m.gps_y, ax = m.ant_x, ay = m.ant_y, ring = [], dash = [];
        var R = 0.2, N = 24;
        for (var i = 0; i < N; i++) {
            var a0 = 2 * Math.PI * i / N, a1 = 2 * Math.PI * (i + 1) / N;
            ring.push(gx + R * Math.cos(a0), gy + R * Math.sin(a0), z, gx + R * Math.cos(a1), gy + R * Math.sin(a1), z);
        }
        ring.push(gx - R * 0.5, gy, z, gx + R * 0.5, gy, z, gx, gy - R * 0.5, z, gx, gy + R * 0.5, z);
        var L = Math.hypot(gx - ax, gy - ay), seg = 0.06;
        for (var s = 0; s < L; s += 2 * seg) {
            var u0 = s / L, u1 = Math.min(L, s + seg) / L;
            dash.push(ax + (gx - ax) * u0, ay + (gy - ay) * u0, z, ax + (gx - ax) * u1, ay + (gy - ay) * u1, z);
        }
        var col = d.state === 'err' ? 0xff5252 : 0xffa726;
        gpsMark.add(lineMesh(T, ring, col, 0.95, 1001));
        if (dash.length) { gpsMark.add(lineMesh(T, dash, col, 0.9, 1001)); }
        V.scene.add(gpsMark);
    }

    // ------------------------------------------- 4. right panel quick number
    function quick() {
        var d = dev();
        return {text: d.m != null ? devText(d) : '—', state: d.state,
                tip: t('utm.dev') + ': ' + (d.m != null ? devText(d) : reasonText(d)),
                why: d.m != null ? '' : reasonText(d)};
    }

    // ---------------------------------------------------------------- wiring
    function onMsg(m) {
        try { S.msg = JSON.parse(m.data); S.rx = Date.now(); } catch (e) { return; }
        paintCard(); paintGrid(); paintGpsMark();
    }
    function fetchDatum() {
        fetch('/api/datum', {cache: 'no-store'}).then(function (r) { return r.json(); })
            .then(function (d) { S.datum = d; paintCard(); paintGrid(); })
            .catch(function () {});
    }
    var subscribed = false;
    function trySubscribe() {
        var r = window.ros && window.ros.ros;
        if (subscribed || !r || typeof ROSLIB === 'undefined') { return; }
        subscribed = true;
        new ROSLIB.Topic({ros: r, name: TOPIC, messageType: 'std_msgs/String', queue_length: 1})
            .subscribe(onMsg);
    }
    function init() {
        buildCard();
        ensureCheckbox();
        fetchDatum();
        setInterval(fetchDatum, 30000);           // a newly served site
        setInterval(function () { trySubscribe(); paintCard(); paintGrid(); }, 1000);
        setInterval(function () { if (!document.hidden) { paintRose(); } }, 200);
        if (window.VTI18n) { VTI18n.onChange(function () { cardLast = ''; paintCard(); }); }
        trySubscribe();
    }
    window.VtGeoref = {quick: quick, frame: frame, dev: dev, DEV_OK: DEV_OK, DEV_WARN: DEV_WARN};
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 900); });
    } else {
        setTimeout(init, 900);
    }
})();
