// vt_mow_trail.js — the "Mow load" layer: a trail behind the robot. One metric at
// a time gives the colour (Load, Torque, Speed, Slope, Temperature, GPS against lidar, GPS against
// wheels, RTCM, Rpm dip, distance from the plan, heading against GNSS), the state
// gives the width: a full deck stripe while cutting, a thin line in transit.
// Stops and rules are small icons. Everything else is in the card behind a tap.
// Thin lines on top, each on its own switch: the plan (the projection of the
// pose on the active path), GPS and lidar positions, so a lying source shows
// as a line away from the others.
//
// Data: vitulus_mapping/mowtrail.py, docs/MAP_OBJECTS.md section 11. The robot
// sends 26 columns, downsampled (18 before 2026-11-08, widened with NONE); a tap
// asks for the raw row.
//
// Drawn into the ros3d scene, so one geometry serves the map and the editor (the
// editor's overlay canvas is transparent above it). ros3d carries its own THREE
// with the r89 API (addAttribute, setDynamic, one updateRange), not the global one.
//
// GPU: chunks of preallocated buffers, a new row writes one quad and uploads only
// that range. A metric change rewrites the colours once. The width lives in the
// shader, in metres, with a minimum in pixels so a thin line never disappears.
window.VTMowTrail = (function () {
    'use strict';

    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    // ---- format, same as mowtrail.py
    var STRIDE = 26, WHEEL = 15, LIDAR = 16, JUMP = 17, LOAD = 2, AMPS = 3, RPM = 4, TEMP = 5, STATE = 6, TIME = 7, SPEED = 8, SLOPE = 9, FIX = 10, DIP = 11, HACC = 12, AGE = 13, RATE = 14;
    var XTE = 18, PATH_X = 19, PATH_Y = 20, GPS_X = 21, GPS_Y = 22, LIDAR_X = 23, LIDAR_Y = 24, HEAD_ERR = 25;
    var BRK = 16, NONE = -9999;
    var STATES = ['cutting', 'spinup', 'transit', 'blocked', 'overload', 'hot', 'rule', 'hold', 'link_lost'];
    var EVENTS = ['blocked', 'link_lost', 'hot', 'overload', 'rule', 'temp', 'recovery', 'backup', 'detour', 'stall', 'no_progress', 'rewindow', 'hold', 'rtcm_gap', 'fix_down', 'fix_up', 'gps_jump', 'off_path'];
    var GLYPH = { blocked: '✕', link_lost: '?', hot: 'T', overload: '!', rule: '⊘', temp: 'T', recovery: '↻', backup: '↶', detour: '⤴', stall: '■', no_progress: '…', rewindow: '↔', hold: '‖', rtcm_gap: 'R', fix_down: '▼', fix_up: '▲', gps_jump: 'J', off_path: '↯' };
    var EV_TONE = [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 2, 1, 1];   // colour step of an EVENTS index
    var DEFAULT_LIMITS = { trip_a: 1.54, overload_load: 0.85, deck_m: 0.29, temp_warn_c: 60, temp_max_c: 70 };

    // Five colour steps, tokens --vt-mow-1..5 (ColorBrewer RdYlBu: safe for
    // colour-blind eyes, and the light middle stands out on aerial imagery).
    // v in row units. `label` turns a stop into the real value for the legend.
    // Stops from the run of 2026-11-01 (2451 rows at speed, 22 min):
    //   rpm    the PID holds 91 % of it within 2 rpm of the setpoint, 4 % 2-4 below,
    //          3 % 4-7, 1 % 7-12, the rest are real dips, down to 145. So the dip,
    //          not rpm, and fine near 0: 3400 +-3 on any fixed rpm scale is one colour.
    //   torque sum of four wheels: median 7 Nm, p90 13, p95 17, p99 22, turns p90 17.
    //          Each wheel is limited to 20 Nm, so 80 Nm would be all of them at the limit.
    //   GPS    hAcc says 14 mm whatever happens, so it is not a scale. Against lidar
    //          (bag 17 Oct, moving): median 9 cm, p90 36, p99 59. Against wheels over
    //          1 s in RTK fix: median 4 cm, p90 12, p99 31, float up to 190.
    //   RTCM   a 1 Hz base makes the age a saw 0..1 s, 3 s is gnss_status corr_stale.
    var METRICS = {
        load: { col: LOAD, stops: [12, 20, 35, 60, 85], blade: true, label: function (v, lim) { return (v / 100 * lim.trip_a).toFixed(2) + ' A'; } },
        torque: { col: WHEEL, note: true, stops: [600, 800, 1200, 1700, 2500], label: function (v) { return (v / 100) + ' Nm'; } },
        speed: { col: SPEED, stops: [5, 15, 25, 35, 45], label: function (v) { return (v / 100).toFixed(2) + ' m/s'; } },
        slope: { col: SLOPE, stops: [20, 50, 100, 150, 200], label: function (v) { return (v / 10).toFixed(0) + '°'; } },
        temp: { col: TEMP, stops: [300, 400, 500, 600, 700], label: function (v) { return (v / 10).toFixed(0) + ' °C'; } },
        gpslidar: { col: LIDAR, note: true, stops: [5, 10, 20, 35, 60], label: function (v) { return v + ' cm'; } },
        gpswheel: { col: JUMP, note: true, stops: [5, 10, 20, 40, 100], label: function (v) { return v + ' cm'; } },
        rtcm: { col: AGE, stops: [10, 15, 30, 100, 300], label: function (v) { return (v / 10) + ' s'; } },
        rpm: { col: DIP, stops: [2, 4, 7, 12, 100], blade: true, label: function (v) { return '−' + v + ' rpm'; } },
        // signed on the wire, the colour is the size
        pathdev: { col: XTE, abs: true, note: true, stops: [3, 6, 10, 20, 35], label: function (v) { return v + ' cm'; } },
        headerr: { col: HEAD_ERR, abs: true, note: true, stops: [10, 20, 40, 80, 150], label: function (v) { return (v / 10) + '°'; } },
    };
    var METRIC_KEYS = ['load', 'torque', 'speed', 'slope', 'temp', 'gpslidar', 'gpswheel', 'rtcm', 'rpm', 'pathdev', 'headerr'];
    // thin lines over the trail: wire columns, a CSS token, dashed or not
    var LINES = {
        plan: { x: PATH_X, y: PATH_Y, tok: '--vt-mow-plan', def: '#f4f6f8', dash: true, jump: true },
        gps: { x: GPS_X, y: GPS_Y, tok: '--vt-mow-gps', def: '#43d58b' },
        lidar: { x: LIDAR_X, y: LIDAR_Y, tok: '--vt-mow-lidar', def: '#0dcaf0' },
    };
    var LINE_KEYS = ['plan', 'gps', 'lidar'];

    // ---- pure helpers
    function hex(c) {
        var m = /^\s*#([0-9a-f]{6})\s*$/i.exec(c || '');
        if (!m) return [136, 136, 136];
        var n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    // ramp colours and state colours, from the tokens (CSS is the only source)
    function palette() {
        var cs = window.getComputedStyle && document.documentElement ? getComputedStyle(document.documentElement) : null;
        function tok(n, d) { var v = cs && cs.getPropertyValue(n); return hex(v && v.trim() ? v : d); }
        return {
            ramp: [tok('--vt-mow-1', '#2c7bb6'), tok('--vt-mow-2', '#57c4d8'), tok('--vt-mow-3', '#ffef8a'), tok('--vt-mow-4', '#f58a3c'), tok('--vt-mow-5', '#d7191c')],
            off: tok('--vt-mow-off', '#e9edf0'),
            none: tok('--vt-mow-none', '#8a949c'),
            blocked: tok('--vt-mow-blocked', '#ff3fb0'),
            hot: tok('--vt-mow-hot', '#ffffff'),
            rule: tok('--vt-mow-rule', '#b388ff'),
            link: tok('--vt-mow-link', '#ff7100'),
            ev: [tok('--vt-mow-ev-1', '#ff3fb0'), tok('--vt-mow-ev-2', '#ffb000'), tok('--vt-mow-ev-3', '#e9edf0')],
            plan: tok(LINES.plan.tok, LINES.plan.def), gps: tok(LINES.gps.tok, LINES.gps.def), lidar: tok(LINES.lidar.tok, LINES.lidar.def),
            fusion: tok('--vt-mow-fusion', '#ff7100'),
        };
    }
    // colour of a value on a metric's scale, 0..255
    function colorOf(metric, value, pal) {
        var s = METRICS[metric].stops;
        if (value <= s[0]) return pal.ramp[0];
        for (var i = 1; i < s.length; i++) {
            if (value <= s[i]) {
                var u = (value - s[i - 1]) / (s[i] - s[i - 1]), a = pal.ramp[i - 1], b = pal.ramp[i];
                return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
            }
        }
        return pal.ramp[4];
    }
    // state gives width and, for what must not be missed, the colour
    function styleOf(state, deck) {
        switch (STATES[state]) {
        case 'cutting': case 'overload': return { w: deck };
        case 'spinup': return { w: deck * 0.6, spin: true };
        case 'hold': return { w: deck * 0.6 };
        case 'blocked': return { w: deck, color: 'blocked' };
        case 'hot': return { w: deck, color: 'hot' };
        case 'link_lost': return { w: deck, color: 'link' };
        case 'rule': return { w: deck * 0.45, color: 'rule' };
        default: return { w: 0.07, off: true };
        }
    }
    function rowColor(rows, i, metric, pal, st) {
        if (st.color) return pal[st.color];
        var m = METRICS[metric], v = rows[i * STRIDE + m.col];
        if (m.blade && (st.off || st.spin)) return pal.off;
        if (v === NONE) return pal.none;
        return colorOf(metric, m.abs ? Math.abs(v) : v, pal);
    }
    // metres per CSS pixel at the view centre
    function metresPerPx(camera, centre, heightPx) {
        var c = camera.position, dx = c.x - centre.x, dy = c.y - centre.y, dz = c.z - centre.z;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return 2 * dist * Math.tan((camera.fov || 40) * Math.PI / 360) / Math.max(1, heightPx);
    }
    // nearest row to (x, y), m; linear, only on a tap or a throttled hover
    function nearest(rows, n, x, y, maxDist) {
        var best = -1, bestD = maxDist * maxDist * 1e4, cx = x * 100, cy = y * 100;
        for (var i = 0, o = 0; i < n; i++, o += STRIDE) {
            var dx = rows[o] - cx, dy = rows[o + 1] - cy, d = dx * dx + dy * dy;
            if (d <= bestD) { bestD = d; best = i; }   // <=: the newest pass wins
        }
        return best;
    }
    // Icons that fit: worst first, one per screen cell. list = [{x, y, k}]
    function declutter(list, cellM) {
        var seen = {}, out = [];
        var order = list.slice().sort(function (a, b) { return a.k - b.k; });
        for (var i = 0; i < order.length; i++) {
            var e = order[i], key = Math.floor(e.x / cellM) + ':' + Math.floor(e.y / cellM);
            if (seen[key]) continue;
            seen[key] = true;
            out.push(e);
        }
        return out;
    }
    function duration(s) {
        s = Math.max(0, Math.round(s || 0));
        var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
        return h ? h + ' h ' + m + ' min' : m + ' min';
    }
    function clock(unix) {
        var d = new Date(unix * 1000), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function dayTime(unix) {
        var d = new Date(unix * 1000), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function known(v) { return v !== NONE && v != null; }
    // Segments of one line from wire rows [from, to): flat [x1, y1, d1, x2, y2, d2, ...],
    // m, d = distance along the line (for the dash). A break (BRK) or an unknown
    // point cuts the line. `jump`: the plan also cuts where it steps much further
    // than the robot did (a new path, not a move). `st` carries the end over to the
    // next call, so a live message only appends.
    function polySegments(rows, from, to, cx, cy, jump, st) {
        var out = [];
        st = st || {};
        for (var i = from; i < to; i++) {
            var o = i * STRIDE, x = rows[o + cx], y = rows[o + cy];
            var fx = rows[o] / 100, fy = rows[o + 1] / 100;
            if (rows[o + STATE] >= BRK) st.ok = false;
            if (x === NONE || y === NONE) { st.ok = false; st.fx = fx; st.fy = fy; continue; }
            x /= 100; y /= 100;
            if (st.ok) {
                var len = Math.hypot(x - st.x, y - st.y), moved = Math.hypot(fx - st.fx, fy - st.fy);
                if (jump && len > moved + 0.5) st.d = 0;
                else { out.push(st.x, st.y, st.d, x, y, st.d + len); st.d += len; }
            } else st.d = 0;
            st.ok = true; st.x = x; st.y = y; st.fx = fx; st.fy = fy;
        }
        return out;
    }
    // a point of another source in the robot frame: [forward, left], m
    function inRobot(dx, dy, yawDeg) {
        var a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        return [dx * c + dy * s, -dx * s + dy * c];
    }
    function cm(v) { return known(v) ? v / 100 : null; }
    // short lines of a row from the wire; the tap replaces them with the raw row
    function rowFacts(rows, i, start) {
        var o = i * STRIDE;
        return {
            x: rows[o] / 100, y: rows[o + 1] / 100,
            xte_m: cm(rows[o + XTE]), path_x: cm(rows[o + PATH_X]), path_y: cm(rows[o + PATH_Y]),
            gps_x: cm(rows[o + GPS_X]), gps_y: cm(rows[o + GPS_Y]), lidar_x: cm(rows[o + LIDAR_X]), lidar_y: cm(rows[o + LIDAR_Y]),
            head_err_deg: known(rows[o + HEAD_ERR]) ? rows[o + HEAD_ERR] / 10 : null,
            state: STATES[rows[o + STATE] & (BRK - 1)],
            t: (start || 0) + rows[o + TIME] / 10,
            load: known(rows[o + LOAD]) ? rows[o + LOAD] / 100 : null,
            amps: known(rows[o + AMPS]) ? rows[o + AMPS] / 1000 : null,
            rpm: known(rows[o + RPM]) ? rows[o + RPM] : null,
            temp: known(rows[o + TEMP]) ? rows[o + TEMP] / 10 : null,
            speed: known(rows[o + SPEED]) ? rows[o + SPEED] / 100 : null,
            fix: known(rows[o + FIX]) ? rows[o + FIX] : null,
            slope: known(rows[o + SLOPE]) ? rows[o + SLOPE] / 10 : null,
            hacc: known(rows[o + HACC]) ? rows[o + HACC] / 1000 : null,
            rtcm_age: known(rows[o + AGE]) ? rows[o + AGE] / 10 : null,
            rtcm_rate: known(rows[o + RATE]) ? rows[o + RATE] / 10 : null,
            wheel: known(rows[o + WHEEL]) ? rows[o + WHEEL] / 100 : null,
            lidar_m: known(rows[o + LIDAR]) ? rows[o + LIDAR] / 100 : null,
            jump_m: known(rows[o + JUMP]) ? rows[o + JUMP] / 100 : null,
        };
    }
    // groups of the card, only what is known
    function cardGroups(r) {
        var num = function (v, d, u) { return v == null ? null : Number(v).toFixed(d) + (u ? ' ' + u : ''); };
        var pair = function (a, b) { return a == null ? null : (b == null ? a : a + ' / ' + b); };
        var blade = [
            ['load', r.load == null ? null : Math.round(r.load * 100) + ' %' + (r.amps == null ? '' : ' · ' + r.amps.toFixed(2) + ' A')],
            ['rpm', pair(r.rpm == null ? null : String(r.rpm), r.setpoint == null ? null : String(r.setpoint))],
            ['temp', num(r.temp, 1, '°C')],
            ['height', num(r.height, 0, 'mm')],
        ];
        var drive = [
            ['speed', r.speed == null ? null : pair(num(r.speed, 2), num(r.cmd, 2)) + ' m/s'],
            ['wheel', r.wheel == null ? null : num(r.wheel, 1, 'Nm') + (r.wheel_max == null ? '' : ' · ' + r.wheel_max.toFixed(1))],
            ['slope', r.roll != null ? r.roll.toFixed(1) + '° / ' + (r.pitch == null ? '?' : r.pitch.toFixed(1)) + '°' : num(r.slope, 1, '°')],
        ];
        var place = [
            ['fix', r.fix == null ? null : t('mowl.fix.' + r.fix) + (r.hacc == null ? '' : ' · ' + (r.hacc * 100).toFixed(1) + ' cm')],
            ['sats', r.num_sv == null ? null : r.num_sv + (r.pdop == null ? '' : ' · pDOP ' + r.pdop.toFixed(2))],
            ['gpslidar', r.lidar_m == null ? null : Math.round(r.lidar_m * 100) + ' cm'],
            ['gpswheel', r.jump_m == null ? null : Math.round(r.jump_m * 100) + ' cm'],
            ['cno', r.cno == null ? null : r.cno.toFixed(1) + ' dB' + (r.prres == null ? '' : ' · ' + r.prres.toFixed(1) + ' m')],
            ['rtcm', r.rtcm_rate == null ? null : r.rtcm_rate.toFixed(1) + '/s' + (r.rtcm_age == null ? '' : ' · ' + r.rtcm_age.toFixed(1) + ' s')],
        ];
        var power = [['battery', r.batt_v == null ? null : r.batt_v.toFixed(1) + ' V' + (r.batt_pct == null ? '' : ' · ' + r.batt_pct + ' %')], ['power', num(r.power, 0, 'W')]];
        var job = [['program', r.program || null], ['zone', r.zone || null], ['path', r.path ? r.path + (r.chunk == null ? '' : ' · ' + r.chunk) : null]];
        var pose = poseFacts(r);
        return [['pose', pose.rows, pose.table], ['blade', blade], ['drive', drive], ['place', place], ['power', power], ['job', job]].map(function (g) {
            var out = { k: g[0], rows: g[1].filter(function (x) { return x[1] != null; }) };
            if (g[2]) out.table = g[2];
            return out;
        }).filter(function (g) { return g.rows.length || (g.table && g.table.length); });
    }
    // signed cm, a real minus
    function scm(v) {
        if (v == null) return null;
        var n = Math.round(v * 100);
        return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
    }
    // a word of the robot in the UI language; an unknown one stays as it came
    function named(area, v) {
        if (!v) return null;
        var k = 'mowl.' + area + '.' + v, s = t(k);
        return s && s !== k ? s : String(v);
    }
    function sdeg(v) { return v == null ? null : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '°'; }
    // The Position group: where the sources were against the plan and the fused pose.
    // table rows [source, across the plan (cm, + = left), against the pose (forward / left, cm)];
    // a row without any number is left out.
    function poseFacts(r) {
        var rel = function (x, y, along, across) {
            if (along != null && across != null) return scm(along) + ' / ' + scm(across);
            if (x == null || y == null || r.x == null || r.y == null || r.yaw == null) return null;
            var v = inRobot(x - r.x, y - r.y, r.yaw);
            return scm(v[0]) + ' / ' + scm(v[1]);
        };
        var table = [
            ['plan', r.path_x == null ? null : '0', rel(r.path_x, r.path_y)],
            ['fusion', scm(r.xte_m), r.xte_m == null ? null : '0 / 0'],
            ['gps', scm(r.gps_xte_m), rel(r.gps_x, r.gps_y, r.gps_along_m, r.gps_across_m)],
            ['lidar', scm(r.lidar_xte_m), rel(r.lidar_x, r.lidar_y, r.lidar_along_m, r.lidar_across_m)],
        ].filter(function (x) { return x[1] != null || x[2] != null; });
        if (table.length === 1 && table[0][0] === 'plan') table = [];
        var head = null, err = r.head_err_deg;
        if (err == null && r.yaw != null && r.gps_head != null) err = ((r.yaw - r.gps_head + 540) % 360) - 180;
        if (r.yaw != null && r.gps_head != null) {
            head = r.yaw.toFixed(1) + '° / ' + r.gps_head.toFixed(1) + '°' + (r.head_acc == null ? '' : ' ±' + r.head_acc.toFixed(1) + '°') + ' · Δ ' + sdeg(err);
        } else if (err != null) head = 'Δ ' + sdeg(err);
        var rows = [['heading', head], ['owner', named('owner', r.owner)], ['track', named('track', r.track)]];
        return { table: table, rows: rows };
    }
    function summaryRows(s) {
        var out = [];
        if (s.time_mow_s != null) out.push(['mow', duration(s.time_mow_s)]);
        if (s.time_transit_s != null) out.push(['transit', duration(s.time_transit_s)]);
        if (s.stops != null) out.push(['stops', String(s.stops)]);
        if (s.mean_load != null) out.push(['load', Math.round(s.mean_load * 100) + ' / ' + Math.round((s.peak_load || 0) * 100) + ' %']);
        if (s.peak_temp != null) out.push(['peak_temp', s.peak_temp.toFixed(1) + ' °C']);
        if (s.energy_wh != null) out.push(['energy', Math.round(s.energy_wh) + ' Wh']);
        if (s.wheel_mean != null) out.push(['torque', s.wheel_mean.toFixed(1) + ' / ' + s.wheel_peak.toFixed(1) + ' Nm']);
        if (s.rtk_frac != null) out.push(['rtk', Math.round(s.rtk_frac * 100) + ' %' + (s.fix_losses ? ' · ' + s.fix_losses + ' ×' : '')]);
        if (s.lidar_med != null) out.push(['gpslidar', s.lidar_med + ' / ' + s.lidar_p95 + ' cm']);
        if (s.jump_med != null) out.push(['gpswheel', s.jump_med + ' / ' + s.jump_p95 + ' cm']);
        if (s.rtcm_rate != null) out.push(['rtcm', s.rtcm_rate.toFixed(1) + '/s' + (s.rtcm_gaps ? ' · ' + s.rtcm_gaps + ' ×' : '')]);
        if (s.xte_med != null) out.push(['pathdev', s.xte_med + ' / ' + s.xte_p95 + ' cm']);
        if (s.gps_xte_med != null) out.push(['gpspath', s.gps_xte_med + ' / ' + s.gps_xte_p95 + ' cm']);
        if (s.head_med != null) out.push(['headerr', (s.head_med / 10).toFixed(1) + ' / ' + (s.head_p95 / 10).toFixed(1) + '°']);
        return out;
    }

    // ---- trail store: the raw wire rows, growing
    function Store() { this.rows = new Int32Array(STRIDE * 2048); this.n = 0; this.total = 0; this.run = null; this.start = 0; this.events = []; }
    // a message of a narrower format, from a robot not updated yet
    function widen(flat, stride) {
        if (!stride || stride >= STRIDE) return flat || [];
        var n = flat.length / stride, out = new Array(n * STRIDE);
        for (var i = 0; i < n; i++) for (var c = 0; c < STRIDE; c++) out[i * STRIDE + c] = c < stride ? flat[i * stride + c] : NONE;
        return out;
    }
    Store.prototype.reset = function () { this.n = 0; this.total = 0; this.events = []; };
    Store.prototype.push = function (flat, skip) {
        var count = flat.length / STRIDE - skip;
        if (count <= 0) return 0;
        var need = (this.n + count) * STRIDE;
        if (need > this.rows.length) {
            var grown = new Int32Array(Math.max(need, this.rows.length * 2));
            grown.set(this.rows.subarray(0, this.n * STRIDE));
            this.rows = grown;
        }
        this.rows.set(flat.slice ? flat.slice(skip * STRIDE) : flat, this.n * STRIDE);
        this.n += count;
        return count;
    };
    Store.prototype.addEvents = function (flat) {
        for (var i = 0; i + 3 < flat.length; i += 4) this.events.push({ t: flat[i], x: flat[i + 1] / 100, y: flat[i + 2] / 100, k: flat[i + 3] });
    };

    // ---- geometry
    var CHUNK = 8192, MAX_ROWS = 80000, MAX_EVENTS = 800;
    var VS = 'attribute vec2 aN; attribute vec3 aC; uniform float uMin; uniform float uZ;' +
        'varying vec3 vC; varying float vS;' +
        'void main(){ float s = position.z >= 0.0 ? 1.0 : -1.0; float hw = abs(position.z);' +
        ' float m = hw > 0.1 ? uMin * 1.6 : uMin;' +
        ' vec2 p = position.xy + aN * s * max(hw, m); vS = s; vC = aC;' +
        ' gl_Position = projectionMatrix * modelViewMatrix * vec4(p, uZ, 1.0); }';
    // a dark edge reads over grass and over a pale roof alike
    var FS = 'precision mediump float; uniform float uAlpha; varying vec3 vC; varying float vS;' +
        'void main(){ float e = smoothstep(0.72, 0.94, abs(vS)); gl_FragColor = vec4(mix(vC, vC * 0.2, e), uAlpha); }';
    var PVS = 'attribute float aK; uniform float uSize; uniform float uZ; varying float vK;' +
        'void main(){ vK = aK; gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, uZ, 1.0); }';
    var PFS = 'precision mediump float; uniform sampler2D uAtlas; uniform float uN; varying float vK;' +
        'void main(){ vec2 c = (vec2(mod(vK, uN), floor(vK / uN)) + gl_PointCoord) / uN; vec4 t = texture2D(uAtlas, c);' +
        ' if (t.a < 0.05) discard; gl_FragColor = t; }';

    // thin lines: one LineSegments per line, uDash in m (0 = solid), aD = distance along
    var LVS = 'attribute float aD; uniform float uZ; varying float vD;' +
        'void main(){ vD = aD; gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, uZ, 1.0); }';
    var LFS = 'precision mediump float; uniform vec3 uC; uniform float uDash; uniform float uAlpha; varying float vD;' +
        'void main(){ if (uDash > 0.0 && mod(vD, uDash * 2.0) > uDash) discard; gl_FragColor = vec4(uC, uAlpha); }';

    function order() {
        var o = (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder : {};
        return o.MOWLOAD !== undefined ? o.MOWLOAD : 23;
    }

    function Ribbon(T, scene) {
        this.T = T;
        this.root = new T.Object3D();
        scene.add(this.root);
        this.uniforms = { uMin: { value: 0.01 }, uZ: { value: 0.03 }, uAlpha: { value: 0.9 } };
        this.material = new T.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.uniforms, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide });
        this.chunks = [];
        this.index = this._index();
        this.seg = 0;
        this.prev = null;           // end edge of the last quad
        this.onCamera = null;
    }
    Ribbon.prototype._index = function () {
        var idx = new Uint16Array(CHUNK * 6);
        for (var i = 0; i < CHUNK; i++) {
            var a = i * 4, o = i * 6;
            idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2; idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
        }
        return new this.T.BufferAttribute(idx, 1);
    };
    Ribbon.prototype._chunk = function () {
        var T = this.T, g = new T.BufferGeometry(), v = CHUNK * 4;
        var pos = new T.BufferAttribute(new Float32Array(v * 3), 3).setDynamic(true);
        var nrm = new T.BufferAttribute(new Float32Array(v * 2), 2).setDynamic(true);
        var col = new T.BufferAttribute(new Uint8Array(v * 3), 3, true).setDynamic(true);
        g.addAttribute('position', pos);
        g.addAttribute('aN', nrm);
        g.addAttribute('aC', col);
        g.setIndex(this.index);
        g.setDrawRange(0, 0);
        var mesh = new T.Mesh(g, this.material);
        mesh.frustumCulled = false;
        mesh.renderOrder = order();
        var self = this;
        mesh.onBeforeRender = function (r, s, cam) { if (self.onCamera) self.onCamera(cam); };
        this.root.add(mesh);
        return { mesh: mesh, g: g, pos: pos, nrm: nrm, col: col, used: 0, from: -1, dirty: false };
    };
    Ribbon.prototype.clear = function () {
        this.chunks.forEach(function (c) { c.used = 0; c.from = -1; c.dirty = false; c.g.setDrawRange(0, 0); });
        this.seg = 0;
        this.prev = null;
    };
    // a quad from (ax, ay) to (bx, by), ca and cb colours 0..255
    Ribbon.prototype.quad = function (ax, ay, bx, by, hw, ca, cb, joined) {
        var dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-4) return;
        var nx = -dy / len, ny = dx / len, sx = nx, sy = ny;
        // a shared edge keeps the stripe closed on a bend; a turn past 90° starts anew
        if (joined && this.prev && this.prev.hw === hw && this.prev.nx * nx + this.prev.ny * ny > 0) { sx = this.prev.nx; sy = this.prev.ny; }
        var ci = Math.floor(this.seg / CHUNK), s = this.seg % CHUNK;
        if (!this.chunks[ci]) this.chunks[ci] = this._chunk();
        var c = this.chunks[ci], p = c.pos.array, n = c.nrm.array, k = c.col.array, o = s * 4;
        var P = [ax, ay, hw, ax, ay, -hw, bx, by, hw, bx, by, -hw];
        var N = [sx, sy, sx, sy, nx, ny, nx, ny];
        var C = [ca, ca, cb, cb];
        for (var i = 0; i < 12; i++) p[o * 3 + i] = P[i];
        for (var j = 0; j < 8; j++) n[o * 2 + j] = N[j];
        for (var m = 0; m < 4; m++) { var e = C[m], q = (o + m) * 3; k[q] = e[0]; k[q + 1] = e[1]; k[q + 2] = e[2]; }
        // a range still waiting for the renderer stays in, one updateRange per attribute
        if (!c.dirty && (c.from < 0 || c.pos.updateRange.count === -1)) c.from = s;
        c.used = s + 1;
        c.dirty = true;
        this.seg++;
        this.prev = { nx: nx, ny: ny, hw: hw };
    };
    // the range of this round, uploaded by the next frame
    Ribbon.prototype.flush = function () {
        this.chunks.forEach(function (c) {
            if (!c.dirty) return;
            c.dirty = false;
            var a = c.from * 4, count = (c.used - c.from) * 4;
            c.pos.updateRange.offset = a * 3; c.pos.updateRange.count = count * 3; c.pos.needsUpdate = true;
            c.nrm.updateRange.offset = a * 2; c.nrm.updateRange.count = count * 2; c.nrm.needsUpdate = true;
            c.col.updateRange.offset = a * 3; c.col.updateRange.count = count * 3; c.col.needsUpdate = true;
            c.g.setDrawRange(0, c.used * 6);
        });
    };

    function Icons(T, scene) {
        this.T = T;
        var N = 5, SZ = 64, cv = document.createElement('canvas');
        cv.width = cv.height = N * SZ;
        var pal = palette(), c = cv.getContext('2d');
        c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = 'bold 34px sans-serif';
        EVENTS.forEach(function (name, i) {
            var x = (i % N) * SZ + SZ / 2, y = Math.floor(i / N) * SZ + SZ / 2, col = pal.ev[EV_TONE[i]];
            c.beginPath(); c.arc(x, y, 27, 0, 6.3);
            c.fillStyle = 'rgb(' + col.join(',') + ')'; c.fill();
            c.lineWidth = 4; c.strokeStyle = '#14181c'; c.stroke();
            c.fillStyle = '#14181c'; c.fillText(GLYPH[name], x, y + 2);
        });
        var tex = new T.CanvasTexture(cv);
        tex.flipY = false;
        tex.generateMipmaps = false;
        tex.minFilter = T.LinearFilter;
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var mat = new T.ShaderMaterial({ vertexShader: PVS, fragmentShader: PFS, transparent: true, depthTest: false, depthWrite: false,
            uniforms: { uAtlas: { value: tex }, uN: { value: N }, uSize: { value: 18 * dpr }, uZ: { value: 0.04 } } });
        this.pos = new T.BufferAttribute(new Float32Array(MAX_EVENTS * 3), 3).setDynamic(true);
        this.kind = new T.BufferAttribute(new Float32Array(MAX_EVENTS), 1).setDynamic(true);
        this.g = new T.BufferGeometry();
        this.g.addAttribute('position', this.pos);
        this.g.addAttribute('aK', this.kind);
        this.g.setDrawRange(0, 0);
        this.points = new T.Points(this.g, mat);
        this.points.frustumCulled = false;
        this.points.renderOrder = order() + 0.5;
        scene.add(this.points);
    }
    Icons.prototype.set = function (list) {
        var n = Math.min(list.length, MAX_EVENTS);
        for (var i = 0; i < n; i++) {
            this.pos.array[i * 3] = list[i].x; this.pos.array[i * 3 + 1] = list[i].y; this.pos.array[i * 3 + 2] = 0;
            this.kind.array[i] = list[i].k;
        }
        this.pos.needsUpdate = this.kind.needsUpdate = true;
        this.g.setDrawRange(0, n);
    };

    // One line of positions. Preallocated, grows by doubling (a new geometry then),
    // an append uploads only its range.
    function Line(T, scene, rgb, dash) {
        this.T = T;
        this.scene = scene;
        this.uniforms = { uC: { value: new T.Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) }, uDash: { value: dash ? 0.25 : 0 }, uZ: { value: 0.035 }, uAlpha: { value: 0.95 } };
        this.dash = !!dash;
        this.material = new T.ShaderMaterial({ vertexShader: LVS, fragmentShader: LFS, uniforms: this.uniforms, transparent: true, depthTest: false, depthWrite: false });
        this.cap = 0; this.n = 0; this.mesh = null; this.st = {};
        this._alloc(4096);
    }
    Line.prototype._alloc = function (cap) {
        var T = this.T, g = new T.BufferGeometry();
        var pos = new T.BufferAttribute(new Float32Array(cap * 6), 3).setDynamic(true);
        var d = new T.BufferAttribute(new Float32Array(cap * 2), 1).setDynamic(true);
        if (this.mesh) { pos.array.set(this.pos.array.subarray(0, this.n * 6)); d.array.set(this.d.array.subarray(0, this.n * 2)); }
        g.addAttribute('position', pos);
        g.addAttribute('aD', d);
        g.setDrawRange(0, this.n * 2);
        var mesh = new T.LineSegments(g, this.material);
        mesh.frustumCulled = false;
        mesh.renderOrder = order() + 0.3;
        mesh.visible = this.mesh ? this.mesh.visible : false;
        if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
        this.scene.add(mesh);
        this.mesh = mesh; this.pos = pos; this.d = d; this.cap = cap;
    };
    Line.prototype.clear = function () { this.n = 0; this.st = {}; this.mesh.geometry.setDrawRange(0, 0); };
    // seg = polySegments output
    Line.prototype.append = function (seg) {
        var k = seg.length / 6;
        if (!k) return;
        if (this.n + k > this.cap) {
            var cap = this.cap;
            while (cap < this.n + k) cap *= 2;
            this._alloc(cap);
            this.pos.needsUpdate = this.d.needsUpdate = true;     // the whole new buffer
        } else if (!this.pos.needsUpdate) {
            this.pos.updateRange.offset = this.n * 6; this.pos.updateRange.count = k * 6;
            this.d.updateRange.offset = this.n * 2; this.d.updateRange.count = k * 2;
            this.pos.needsUpdate = this.d.needsUpdate = true;
        } else {
            this.pos.updateRange.count = this.d.updateRange.count = -1;   // two appends before a frame
        }
        var p = this.pos.array, d = this.d.array;
        for (var i = 0; i < k; i++) {
            var s = i * 6, o = (this.n + i) * 6, q = (this.n + i) * 2;
            p[o] = seg[s]; p[o + 1] = seg[s + 1]; p[o + 2] = 0; p[o + 3] = seg[s + 3]; p[o + 4] = seg[s + 4]; p[o + 5] = 0;
            d[q] = seg[s + 2]; d[q + 1] = seg[s + 5];
        }
        this.n += k;
        this.mesh.geometry.setDrawRange(0, this.n * 2);
    };

    // Marks at a tapped row: Plan, Fusion, GPS, Lidar as dots, joined to Fusion.
    function Marks(T, scene) {
        this.T = T;
        this.pos = new T.BufferAttribute(new Float32Array(4 * 3), 3).setDynamic(true);
        this.col = new T.BufferAttribute(new Float32Array(4 * 3), 3).setDynamic(true);
        this.g = new T.BufferGeometry();
        this.g.addAttribute('position', this.pos);
        this.g.addAttribute('color', this.col);
        this.lpos = new T.BufferAttribute(new Float32Array(6 * 3), 3).setDynamic(true);
        this.lcol = new T.BufferAttribute(new Float32Array(6 * 3), 3).setDynamic(true);
        this.lg = new T.BufferGeometry();
        this.lg.addAttribute('position', this.lpos);
        this.lg.addAttribute('color', this.lcol);
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        this.points = new T.Points(this.g, new T.PointsMaterial({ size: 9 * dpr, sizeAttenuation: false, vertexColors: T.VertexColors, depthTest: false, depthWrite: false, transparent: true }));
        this.lines = new T.LineSegments(this.lg, new T.LineBasicMaterial({ vertexColors: T.VertexColors, depthTest: false, depthWrite: false, transparent: true }));
        this.root = new T.Object3D();
        this.root.add(this.lines);
        this.root.add(this.points);
        this.points.frustumCulled = this.lines.frustumCulled = false;
        this.points.renderOrder = order() + 0.7;
        this.lines.renderOrder = order() + 0.6;
        this.root.visible = false;
        scene.add(this.root);
    }
    // list = [{x, y, c: [r, g, b] 0..255}], the first is the fused pose
    Marks.prototype.set = function (list) {
        var n = Math.min(4, list.length), z = 0.06;
        if (!n) { this.root.visible = false; return; }
        for (var i = 0; i < n; i++) {
            this.pos.array.set([list[i].x, list[i].y, z], i * 3);
            this.col.array.set(list[i].c.map(function (v) { return v / 255; }), i * 3);
        }
        for (var j = 1; j < n; j++) {
            var o = (j - 1) * 6;
            this.lpos.array.set([list[0].x, list[0].y, z, list[j].x, list[j].y, z], o);
            this.lcol.array.set(list[j].c.concat(list[j].c).map(function (v) { return v / 255; }), o);
        }
        this.g.setDrawRange(0, n);
        this.lg.setDrawRange(0, (n - 1) * 2);
        this.pos.needsUpdate = this.col.needsUpdate = this.lpos.needsUpdate = this.lcol.needsUpdate = true;
        this.root.visible = true;
    };
    Marks.prototype.hide = function () { this.root.visible = false; };

    // ---- the layer
    var LS_ON = 'vitulus_mow_load', LS_METRIC = 'vitulus_mow_metric', LS_EVENTS = 'vitulus_mow_events', LS_LINES = 'vitulus_mow_lines';
    var S = { ros: null, on: false, busy: false, metric: 'load', events: true, lines: { plan: false, gps: false, lidar: false }, lineObj: null, linesDrawn: 0, marks: null, view: 'live', store: new Store(), drawn: 0, limits: DEFAULT_LIMITS, runs: [], active: null, summary: null, subs: [], pub: null, reqN: 0, pastReq: null, detailReq: null, lastAsk: 0, ribbon: null, icons: null, pal: null, mpp: 0, card: null, hoverAt: 0, activeReq: 0 };

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function viewer() { return window.viewer && window.viewer.viewer; }
    function three() { return window.ROS3D && ROS3D.THREE; }

    function ensureScene() {
        var V = viewer(), T = three();
        if (S.ribbon || !V || !V.scene || !T || !V.renderer) return !!S.ribbon;
        S.pal = palette();
        S.ribbon = new Ribbon(T, V.scene);
        S.icons = new Icons(T, V.scene);
        S.lineObj = {};
        LINE_KEYS.forEach(function (k) { S.lineObj[k] = new Line(T, V.scene, S.pal[k], LINES[k].dash); });
        S.marks = new Marks(T, V.scene);
        S.ribbon.onCamera = onCamera;
        bindPointer();
        return true;
    }
    function onCamera(cam) {
        var V = viewer();
        if (!V || !V.cameraControls) return;
        var dom = V.renderer.domElement, mpp = metresPerPx(cam, V.cameraControls.center, dom.clientHeight);
        S.ribbon.uniforms.uMin.value = mpp * 0.9;
        if (S.lineObj) S.lineObj.plan.uniforms.uDash.value = Math.max(0.15, mpp * 6);   // dashes stay a few px long
        if (!S.mpp || Math.abs(mpp / S.mpp - 1) > 0.15) { S.mpp = mpp; paintIcons(); }
    }
    function paintIcons() {
        if (!S.icons) return;
        var show = S.on && S.events;
        S.icons.points.visible = show;
        if (show) S.icons.set(declutter(S.store.events, Math.max(0.05, (S.mpp || 0.02) * 30)));
    }
    function drawFrom(i) {
        var st = S.store, r = S.ribbon, rows = st.rows, deck = S.limits.deck_m;
        for (; i < st.n; i++) {
            var o = i * STRIDE, raw = rows[o + STATE], state = raw & (BRK - 1), brk = raw >= BRK;
            if (i === 0 || brk) continue;
            var style = styleOf(state, deck), cb = rowColor(rows, i, S.metric, S.pal, style);
            var prevStyle = styleOf(rows[o - STRIDE + STATE] & (BRK - 1), deck);
            var ca = prevStyle.w === style.w ? rowColor(rows, i - 1, S.metric, S.pal, prevStyle) : cb;
            var joined = rows[o - STRIDE + STATE] < BRK;
            r.quad(rows[o - STRIDE] / 100, rows[o - STRIDE + 1] / 100, rows[o] / 100, rows[o + 1] / 100, style.w / 2, ca, cb, joined);
        }
        r.flush();
        S.drawn = st.n;
    }
    // the lines that are on, from where they ended; the ones off cost nothing
    function anyLine() { return LINE_KEYS.some(function (k) { return S.lines[k]; }); }
    function drawLines(from) {
        if (!S.lineObj) return;
        var st = S.store;
        if (!anyLine()) return;
        if (from > S.linesDrawn) from = S.linesDrawn;
        LINE_KEYS.forEach(function (k) {
            var L = S.lineObj[k], d = LINES[k];
            if (!S.lines[k]) return;
            if (from === 0) {
                L.clear();
                var c = S.pal[k];
                L.uniforms.uC.value.set(c[0] / 255, c[1] / 255, c[2] / 255);
            }
            L.append(polySegments(st.rows, from, st.n, d.x, d.y, d.jump, L.st));
        });
        S.linesDrawn = st.n;
    }
    function showLines() {
        if (!S.lineObj) return;
        LINE_KEYS.forEach(function (k) { S.lineObj[k].mesh.visible = S.on && S.lines[k]; });
    }
    function redraw() {
        if (!ensureScene()) return;
        S.ribbon.clear();
        S.pal = palette();
        drawFrom(0);
        drawLines(0);
        showLines();
        paintIcons();
    }
    function setVisible() {
        if (S.ribbon) S.ribbon.root.visible = S.on;
        showLines();
        paintIcons();
        if (!S.on) hideCard();
    }

    // ---- ROS, only while the layer is on: the messages are not small
    function topic(name) { return new ROSLIB.Topic({ ros: S.ros, name: name, messageType: 'std_msgs/String', queue_length: 4 }); }
    function listen(name, cb) {
        var tp = topic(name);
        tp.subscribe(function (m) { var d; try { d = JSON.parse(m.data); } catch (e) { return; } cb(d); });
        S.subs.push(tp);
    }
    function subscribe() {
        if (S.subs.length || !S.ros) return;
        S.pub = topic('/map_objects/mow_trail/request');
        S.pub.advertise();
        listen('/map_objects/mow_trail/snapshot', onSnapshot);
        listen('/map_objects/mow_trail', onTrail);
        listen('/map_objects/mow_trail/past', onPast);
        listen('/map_objects/mow_trail/detail', onDetail);
        listen('/map_objects/mow_runs', onRuns);
    }
    function unsubscribe() {
        S.subs.forEach(function (tp) { try { tp.unsubscribe(); } catch (e) { /* gone */ } });
        S.subs = [];
    }
    function ask(payload) {
        if (!S.pub) return null;
        var req = 'mow' + (++S.reqN) + '_' + Date.now();
        S.pub.publish(new ROSLIB.Message({ data: JSON.stringify(Object.assign({ req: req }, payload)) }));
        return req;
    }
    function askSnapshot() {
        var now = Date.now();
        if (now - S.lastAsk < 6000) return;
        S.lastAsk = now;
        ask({ run: 'current' });
    }
    function load(m) {
        var st = S.store;
        st.reset();
        st.run = m.run;
        st.start = m.start || 0;
        if (m.limits) S.limits = m.limits;
        st.push(widen(m.r, m.stride), 0);
        st.addEvents(m.e || []);
        st.total = m.n || st.n;
        redraw();
        renderPanels();
    }
    function onSnapshot(m) {
        if (S.view !== 'live') return;
        if (m.run !== S.store.run || S.store.need || !S.store.total) { S.store.need = false; load(m); }
    }
    function onTrail(m) {
        var st = S.store;
        if (S.view !== 'live') return;
        if (m.run !== st.run) { st.need = true; askSnapshot(); return; }
        if (m.from > st.total || st.n >= MAX_ROWS) { st.need = true; askSnapshot(); return; }
        var skip = st.total - m.from;
        st.push(widen(m.r, m.stride), skip);
        st.total = Math.max(st.total, m.n);
        if (m.e && m.e.length) { st.addEvents(m.e); paintIcons(); }
        if (ensureScene()) { drawFrom(Math.max(1, S.drawn)); drawLines(S.linesDrawn); }
    }
    function onPast(m) {
        if (m.req !== S.pastReq) return;
        if (!m.ok) { S.view = 'live'; S.store.run = null; askSnapshot(); renderPanels(); return; }
        S.summary = m;
        load({ run: m.run, start: m.start, r: m.r, stride: m.stride, e: m.e, n: m.n, limits: m.limits });
    }
    function onRuns(m) {
        S.runs = m.runs || [];
        S.active = m.active;
        if (m.limits) S.limits = m.limits;
        if (S.view === 'live') S.summary = null;
        renderPanels();
    }
    function onDetail(m) {
        if (m.req !== S.detailReq || !m.ok || !S.card) return;
        // the raw row wins, but an unknown in it keeps what the wire knew
        var facts = Object.assign({}, S.card.facts);
        Object.keys(m.row).forEach(function (k) { if (m.row[k] != null || !(k in facts)) facts[k] = m.row[k]; });
        S.card.facts = facts;
        S.card.near = m.row.events || [];
        paintCard();
    }

    // ---- on, off, picks
    function setOn(on) {
        S.on = !!on;
        var chk = document.getElementById('mapv3_chk_mowload');
        if (chk) chk.checked = S.on;
        if (S.on) { S.store.need = true; subscribe(); ensureScene(); } else { unsubscribe(); }
        setVisible();
        renderPanels();
    }
    function autoOn() {
        var pref = lsGet(LS_ON);
        return pref === null ? S.busy : pref === '1';
    }
    function setMetric(k) {
        if (!METRICS[k]) return;
        S.metric = k;
        lsSet(LS_METRIC, k);
        if (S.ribbon) redraw();
        renderPanels();
    }
    function setEvents(on) { S.events = !!on; lsSet(LS_EVENTS, on ? '1' : '0'); paintIcons(); }
    // a line switched on is built once from the whole store, then appended
    function setLine(k, on) {
        if (!LINES[k]) return;
        S.lines[k] = !!on;
        lsSet(LS_LINES, JSON.stringify(S.lines));
        if (S.lineObj) {
            if (on) { S.lineObj[k].clear(); S.lineObj[k].append(polySegments(S.store.rows, 0, S.store.n, LINES[k].x, LINES[k].y, LINES[k].jump, S.lineObj[k].st)); S.linesDrawn = S.store.n; }
            showLines();
        }
    }
    function pickRun(id) {
        hideCard();
        if (!id || id === 'live') {
            S.view = 'live'; S.summary = null; S.store.run = null; S.store.reset();
            if (S.ribbon) redraw();
            // the latched snapshot came once; ask, and a finished run waits in the list
            S.lastAsk = 0; S.pub && askSnapshot();
            var last = S.runs[0];
            if (!S.active && last) { S.view = last.id; S.pastReq = ask({ run: last.id }); }
            renderPanels();
            return;
        }
        S.view = id;
        S.pastReq = ask({ run: id });
        renderPanels();
    }

    // ---- panel: one block, in the map and in the editor
    function legendHtml() {
        var m = METRICS[S.metric], lim = S.limits, pal = S.pal || palette(), css = function (c) { return 'rgb(' + c.map(Math.round).join(',') + ')'; };
        var cells = m.stops.map(function (v, i) { return { c: pal.ramp[i], l: m.label(v, lim) }; });
        var bar = cells.map(function (c) { return '<span class="mow-stop"><i style="background:' + css(c.c) + '"></i><b>' + esc(c.l) + '</b></span>'; }).join('');
        var w = function (cls, k) { return '<span class="mow-state"><i class="' + cls + '"></i>' + esc(t('mowl.style.' + k)) + '</span>'; };
        var note = m.note ? '<div class="mow-note">' + esc(t('mowl.note.' + S.metric)) + '</div>' : '';
        return '<div class="mow-scale">' + bar + '</div>' + note + '<div class="mow-states">' + w('mow-w-full', 'cut') + w('mow-w-mid', 'spin') + w('mow-w-thin', 'transit') + w('mow-w-rule', 'rule') + w('mow-w-blocked', 'blocked') + w('mow-w-link', 'link') + '</div>';
    }
    function summaryHtml() {
        var s = S.summary || (S.runs[0] && (S.view === 'live') ? S.runs[0] : null);
        if (!s) return '<div class="vt-muted">' + esc(t('mowl.no_data')) + '</div>';
        return '<div class="mow-sum">' + summaryRows(s).map(function (r) {
            return '<span><em>' + esc(t('mowl.sum.' + r[0])) + '</em> ' + esc(r[1]) + '</span>';
        }).join('') + '</div>';
    }
    function panelHtml() {
        var opts = METRIC_KEYS.map(function (k) { return '<option value="' + k + '"' + (k === S.metric ? ' selected' : '') + '>' + esc(t('mowl.metric.' + k)) + '</option>'; }).join('');
        var runs = '<option value="live"' + (S.view === 'live' ? ' selected' : '') + '>' + esc(t(S.active ? 'mowl.run.now' : 'mowl.run.last')) + '</option>' + S.runs.filter(function (r) { return r.id !== S.active; }).map(function (r) {
            return '<option value="' + esc(r.id) + '"' + (r.id === S.view ? ' selected' : '') + '>' + esc(dayTime(r.start)) + (r.program ? ' · ' + esc(r.program) : '') + '</option>';
        }).join('');
        return '<div class="mow-row"><label class="mow-field"><span>' + esc(t('mowl.show')) + '</span><select class="form-select form-select-sm" data-mow="metric">' + opts + '</select></label>' +
            '<label class="mow-field"><span>' + esc(t('mowl.run')) + '</span><select class="form-select form-select-sm" data-mow="run">' + runs + '</select></label></div>' +
            legendHtml() +
            '<label class="mow-events"><input class="form-check-input" type="checkbox" data-mow="events"' + (S.events ? ' checked' : '') + '> ' + esc(t('mowl.events')) + '</label>' +
            linesHtml() +
            summaryHtml();
    }
    function linesHtml() {
        var pal = S.pal || palette();
        return '<div class="mow-lines" title="' + esc(t('mowl.lines_tip')) + '"><span>' + esc(t('mowl.lines')) + '</span>' + LINE_KEYS.map(function (k) {
            return '<label class="mow-line"><input class="form-check-input" type="checkbox" data-mow="line" data-line="' + k + '"' + (S.lines[k] ? ' checked' : '') + '>' +
                '<i class="mow-line-' + k + '" style="border-color:rgb(' + pal[k].join(',') + ')"></i>' + esc(t('mowl.line.' + k)) + '</label>';
        }).join('') + '</div>';
    }
    function renderPanels() {
        var nodes = document.querySelectorAll('[data-mow-panel]');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].style.display = S.on ? '' : 'none';
            nodes[i].innerHTML = S.on ? panelHtml() : '';
        }
    }
    function onPanelChange(ev) {
        var el = ev.target, k = el && el.getAttribute && el.getAttribute('data-mow');
        if (!k) return;
        if (k === 'metric') setMetric(el.value);
        else if (k === 'run') pickRun(el.value);
        else if (k === 'events') setEvents(el.checked);
        else if (k === 'line') setLine(el.getAttribute('data-line'), el.checked);
    }

    // ---- tap and hover: a short card
    function cardEl() {
        var el = document.getElementById('mow_card');
        if (el) return el;
        var V = viewer();
        el = document.createElement('div');
        el.id = 'mow_card';
        el.className = 'mow-card';
        el.addEventListener('click', function (e) { if (e.target.closest('[data-mow-close]')) hideCard(); });
        V.renderer.domElement.parentElement.appendChild(el);
        return el;
    }
    function hideCard() {
        S.card = null;
        if (S.marks) S.marks.hide();
        var el = document.getElementById('mow_card');
        if (el) el.style.display = 'none';
    }
    function paintCard() {
        var c = S.card;
        if (!c) return;
        var r = c.facts, el = cardEl();
        var groups = cardGroups(r).map(function (g) {
            return '<div class="mow-grp' + (g.table ? ' mow-grp-wide' : '') + '"><h6>' + esc(t('mowl.grp.' + g.k)) + '</h6>' + poseTable(g.table) + g.rows.map(function (x) {
                return '<div><span>' + esc(t('mowl.f.' + x[0])) + '</span><b>' + esc(x[1]) + '</b></div>';
            }).join('') + '</div>';
        }).join('');
        paintMarks();
        var near = (c.near || []).map(function (e) { return '<div class="mow-ev">' + esc(t('mowl.ev.' + e.kind)) + '</div>'; }).join('');
        el.innerHTML = '<div class="mow-card-head"><b>' + esc(t('mowl.state.' + r.state)) + '</b><span>' + esc(clock(r.t)) + '</span>' +
            (c.pinned ? '<button type="button" class="btn-close btn-close-white" data-mow-close aria-label="' + esc(t('mowl.close')) + '"></button>' : '') + '</div>' + near + '<div class="mow-grps">' + groups + '</div>';
        el.style.display = 'block';
        var host = el.parentElement, W = host.clientWidth, H = host.clientHeight, phone = W < 560;
        if (phone) { el.style.left = '8px'; el.style.right = '8px'; el.style.top = 'auto'; el.style.bottom = '8px'; return; }
        el.style.right = 'auto'; el.style.bottom = 'auto';
        el.style.left = Math.min(c.px + 14, W - el.offsetWidth - 8) + 'px';
        el.style.top = Math.max(8, Math.min(c.py + 14, H - el.offsetHeight - 8)) + 'px';
    }
    function poseTable(rows) {
        if (!rows || !rows.length) return '';
        var pal = S.pal || palette(), dot = function (k) { var c = pal[k === 'fusion' ? 'fusion' : k]; return '<i class="mow-dot" style="background:rgb(' + c.join(',') + ')"></i>'; };
        return '<table class="mow-pose"><thead><tr><th></th><th>' + esc(t('mowl.pose.col_plan')) + '</th><th>' + esc(t('mowl.pose.col_fusion')) + '</th></tr></thead><tbody>' + rows.map(function (x) {
            return '<tr><th>' + dot(x[0]) + esc(t('mowl.pose.' + x[0])) + '</th><td>' + esc(x[1] == null ? '–' : x[1]) + '</td><td>' + esc(x[2] == null ? '–' : x[2]) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    // dots where the sources put the robot at the tapped moment, only on a pinned card
    function paintMarks() {
        if (!S.marks) return;
        var c = S.card, r = c && c.facts;
        if (!c || !c.pinned || r.x == null) { S.marks.hide(); return; }
        var pal = S.pal || palette(), list = [{ x: r.x, y: r.y, c: pal.fusion }];
        [['plan', r.path_x, r.path_y], ['gps', r.gps_x, r.gps_y], ['lidar', r.lidar_x, r.lidar_y]].forEach(function (p) {
            if (p[1] != null && p[2] != null) list.push({ x: p[1], y: p[2], c: pal[p[0]] });
        });
        if (list.length < 2) { S.marks.hide(); return; }
        S.marks.set(list);
    }
    function pick(ev) {
        var V = viewer(), T = three();
        if (!V || !T || !S.on || !S.store.n) return null;
        var dom = V.renderer.domElement, box = dom.getBoundingClientRect();
        var px = ev.clientX - box.left, py = ev.clientY - box.top;
        if (px < 0 || py < 0 || px > box.width || py > box.height) return null;
        var v = new T.Vector3(px / box.width * 2 - 1, 1 - py / box.height * 2, 0.5).unproject(V.camera);
        var o = V.camera.position, dz = v.z - o.z;
        if (Math.abs(dz) < 1e-6) return null;
        var u = -o.z / dz, x = o.x + (v.x - o.x) * u, y = o.y + (v.y - o.y) * u;
        var reach = Math.max(S.limits.deck_m / 2 + 0.05, (S.mpp || 0.02) * 12);
        var i = nearest(S.store.rows, S.store.n, x, y, reach);
        return i < 0 ? null : { i: i, px: px, py: py };
    }
    function tapAt(ev, pinned) {
        var got = pick(ev);
        if (!got) { if (!pinned && S.card && !S.card.pinned) hideCard(); return false; }
        var st = S.store;
        S.card = { facts: rowFacts(st.rows, got.i, st.start), px: got.px, py: got.py, pinned: pinned, near: [] };
        paintCard();
        if (pinned) S.detailReq = ask({ run: S.view === 'live' ? 'current' : S.view, t: st.rows[got.i * STRIDE + TIME] });
        return true;
    }
    // a drawing tool in the editor owns the tap
    function toolActive() {
        var s = window.MapEdits && MapEdits._state && MapEdits._state();
        return !!(s && s.tool && s.tool !== 'off');
    }
    function bindPointer() {
        var V = viewer(), host = V.renderer.domElement.parentElement;
        var down = null;
        // passive, capture, never consumed: the map and the editor keep every gesture
        host.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
        host.addEventListener('pointerup', function (e) {
            if (!down || !S.on) return;
            var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
            down = null;
            if (moved > 8 || toolActive() || (e.target && e.target.closest && e.target.closest('.mow-card'))) return;
            if (!tapAt(e, true) && S.card) hideCard();
        }, { capture: true, passive: true });
        host.addEventListener('pointermove', function (e) {
            if (e.pointerType !== 'mouse' || !S.on || e.buttons || (S.card && S.card.pinned)) return;
            var now = Date.now();
            if (now - S.hoverAt < 120) return;
            S.hoverAt = now;
            tapAt(e, false);
        }, { capture: true, passive: true });
    }

    // ---- start
    function start(ros) {
        S.ros = ros;
        try { var ln = JSON.parse(lsGet(LS_LINES) || '{}'); LINE_KEYS.forEach(function (k) { S.lines[k] = ln[k] === true; }); } catch (e) { /* default off */ }
        var saved = lsGet(LS_METRIC);
        if (saved === 'gnss' || saved === 'accuracy') saved = 'gpslidar';          // the names until 2026-11
        S.metric = METRICS[saved] ? saved : 'load';
        S.events = lsGet(LS_EVENTS) !== '0';
        var chk = document.getElementById('mapv3_chk_mowload');
        if (chk) chk.addEventListener('change', function () { lsSet(LS_ON, chk.checked ? '1' : '0'); setOn(chk.checked); });
        document.addEventListener('change', function (e) {
            if (e.target && e.target.closest && e.target.closest('[data-mow-panel]')) onPanelChange(e);
        });
        // the cheap signal that says "a program runs", always on
        new ROSLIB.Topic({ ros: ros, name: '/mower_smach/busy', messageType: 'std_msgs/Bool' }).subscribe(function (m) {
            S.busy = !!m.data;
            if (lsGet(LS_ON) === null && S.busy !== S.on) setOn(S.busy);
        });
        setOn(autoOn());
        if (window.VTI18n) VTI18n.onChange(renderPanels);
    }
    if (typeof document !== 'undefined' && typeof setInterval === 'function' && !window.VT_NO_AUTOSTART) {
        var tries = setInterval(function () {
            var ros = window.ros && window.ros.ros;
            if (!ros || !window.ROSLIB) return;
            clearInterval(tries);
            start(ros);
        }, 500);
    }

    return {
        STATES: STATES, EVENTS: EVENTS, METRICS: METRICS, METRIC_KEYS: METRIC_KEYS, STRIDE: STRIDE, NONE: NONE, BRK: BRK, CHUNK: CHUNK,
        hex: hex, colorOf: colorOf, styleOf: styleOf, rowColor: rowColor, metresPerPx: metresPerPx, nearest: nearest, declutter: declutter,
        duration: duration, rowFacts: rowFacts, cardGroups: cardGroups, summaryRows: summaryRows, Store: Store, Ribbon: Ribbon, widen: widen,
        LINES: LINES, LINE_KEYS: LINE_KEYS, polySegments: polySegments, poseFacts: poseFacts, inRobot: inRobot, Line: Line,
        panelHost: function () { return '<div data-mow-panel class="mow-panel"></div>'; }, renderPanels: renderPanels,
        _state: S, _start: start, _onTrail: onTrail, _onSnapshot: onSnapshot, _setOn: setOn,
    };
})();
