// vt_mow_trail.js — the "Mow load" layer: a trail behind the robot. One metric at
// a time gives the colour (Load, Speed, Slope, Temperature, Accuracy, RTCM, Rpm dip), the state
// gives the width: a full deck stripe while cutting, a thin line in transit.
// Stops and rules are small icons. Everything else is in the card behind a tap.
//
// Data: vitulus_mapping/mowtrail.py, docs/MAP_OBJECTS.md section 11. The robot
// sends 15 columns, downsampled; a tap asks for the raw row.
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
    var STRIDE = 15, LOAD = 2, AMPS = 3, RPM = 4, TEMP = 5, STATE = 6, TIME = 7, SPEED = 8, SLOPE = 9, FIX = 10, DIP = 11, HACC = 12, AGE = 13, RATE = 14;
    var BRK = 16, NONE = -9999;
    var STATES = ['cutting', 'spinup', 'transit', 'blocked', 'overload', 'hot', 'rule', 'hold'];
    var EVENTS = ['blocked', 'hot', 'overload', 'rule', 'temp', 'recovery', 'backup', 'detour', 'stall', 'no_progress', 'rewindow', 'hold', 'rtcm_gap', 'fix_down', 'fix_up'];
    var GLYPH = { blocked: '✕', hot: 'T', overload: '!', rule: '⊘', temp: 'T', recovery: '↻', backup: '↶', detour: '⤴', stall: '■', no_progress: '…', rewindow: '↔', hold: '‖', rtcm_gap: 'R', fix_down: '▼', fix_up: '▲' };
    var EV_TONE = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 2];   // colour step of an EVENTS index
    var DEFAULT_LIMITS = { trip_a: 1.54, overload_load: 0.85, deck_m: 0.29, temp_warn_c: 60, temp_max_c: 70 };

    // Five colour steps, tokens --vt-mow-1..5 (ColorBrewer RdYlBu: safe for
    // colour-blind eyes, and the light middle stands out on aerial imagery).
    // v in row units. `label` turns a stop into the real value for the legend.
    // Stops from the run of 2026-11-01 (2451 rows at speed, 22 min):
    //   rpm    the PID holds 91 % of it within 2 rpm of the setpoint, 4 % 2-4 below,
    //          3 % 4-7, 1 % 7-12, the rest are real dips, down to 145. So the dip,
    //          not rpm, and fine near 0: 3400 +-3 on any fixed rpm scale is one colour.
    //   hAcc   14 mm in RTK fix (99 % of the run), 27 mm float, so a step at 1.5 and
    //          2.5 cm tells them apart; 5 m without corrections is off the scale.
    //   RTCM   a 1 Hz base makes the age a saw 0..1 s, 3 s is gnss_status corr_stale.
    var METRICS = {
        load: { col: LOAD, stops: [12, 20, 35, 60, 85], blade: true, label: function (v, lim) { return (v / 100 * lim.trip_a).toFixed(2) + ' A'; } },
        speed: { col: SPEED, stops: [5, 15, 25, 35, 45], label: function (v) { return (v / 100).toFixed(2) + ' m/s'; } },
        slope: { col: SLOPE, stops: [20, 50, 100, 150, 200], label: function (v) { return (v / 10).toFixed(0) + '°'; } },
        temp: { col: TEMP, stops: [300, 400, 500, 600, 700], label: function (v) { return (v / 10).toFixed(0) + ' °C'; } },
        accuracy: { col: HACC, stops: [15, 25, 50, 100, 300], label: function (v) { return (v / 10) + ' cm'; } },
        rtcm: { col: AGE, stops: [10, 15, 30, 100, 300], label: function (v) { return (v / 10) + ' s'; } },
        rpm: { col: DIP, stops: [2, 4, 7, 12, 100], blade: true, label: function (v) { return '−' + v + ' rpm'; } },
    };
    var METRIC_KEYS = ['load', 'speed', 'slope', 'temp', 'accuracy', 'rtcm', 'rpm'];

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
            ev: [tok('--vt-mow-ev-1', '#ff3fb0'), tok('--vt-mow-ev-2', '#ffb000'), tok('--vt-mow-ev-3', '#e9edf0')],
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
        case 'rule': return { w: deck * 0.45, color: 'rule' };
        default: return { w: 0.07, off: true };
        }
    }
    function rowColor(rows, i, metric, pal, st) {
        if (st.color) return pal[st.color];
        var m = METRICS[metric], v = rows[i * STRIDE + m.col];
        if (m.blade && (st.off || st.spin)) return pal.off;
        if (v === NONE) return pal.none;
        return colorOf(metric, v, pal);
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
    // short lines of a row from the wire; the tap replaces them with the raw row
    function rowFacts(rows, i, start) {
        var o = i * STRIDE;
        return {
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
            ['wheel', num(r.wheel, 1, 'Nm')],
            ['slope', r.roll != null ? r.roll.toFixed(1) + '° / ' + (r.pitch == null ? '?' : r.pitch.toFixed(1)) + '°' : num(r.slope, 1, '°')],
        ];
        var place = [
            ['fix', r.fix == null ? null : t('mowl.fix.' + r.fix) + (r.hacc == null ? '' : ' · ' + (r.hacc * 100).toFixed(1) + ' cm')],
            ['sats', r.num_sv == null ? null : r.num_sv + (r.pdop == null ? '' : ' · pDOP ' + r.pdop.toFixed(2))],
            ['rtcm', r.rtcm_rate == null ? null : r.rtcm_rate.toFixed(1) + '/s' + (r.rtcm_age == null ? '' : ' · ' + r.rtcm_age.toFixed(1) + ' s')],
            ['owner', r.owner || null],
        ];
        var power = [['battery', r.batt_v == null ? null : r.batt_v.toFixed(1) + ' V' + (r.batt_pct == null ? '' : ' · ' + r.batt_pct + ' %')], ['power', num(r.power, 0, 'W')]];
        var job = [['program', r.program || null], ['zone', r.zone || null], ['path', r.path ? r.path + (r.chunk == null ? '' : ' · ' + r.chunk) : null]];
        return [['blade', blade], ['drive', drive], ['place', place], ['power', power], ['job', job]].map(function (g) {
            return { k: g[0], rows: g[1].filter(function (x) { return x[1] != null; }) };
        }).filter(function (g) { return g.rows.length; });
    }
    function summaryRows(s) {
        var out = [];
        if (s.time_mow_s != null) out.push(['mow', duration(s.time_mow_s)]);
        if (s.time_transit_s != null) out.push(['transit', duration(s.time_transit_s)]);
        if (s.stops != null) out.push(['stops', String(s.stops)]);
        if (s.mean_load != null) out.push(['load', Math.round(s.mean_load * 100) + ' / ' + Math.round((s.peak_load || 0) * 100) + ' %']);
        if (s.peak_temp != null) out.push(['peak_temp', s.peak_temp.toFixed(1) + ' °C']);
        if (s.energy_wh != null) out.push(['energy', Math.round(s.energy_wh) + ' Wh']);
        if (s.rtk_frac != null) out.push(['rtk', Math.round(s.rtk_frac * 100) + ' %']);
        if (s.rtcm_rate != null) out.push(['rtcm', s.rtcm_rate.toFixed(1) + '/s' + (s.rtcm_gaps ? ' · ' + s.rtcm_gaps + ' ×' : '')]);
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
        var N = 4, SZ = 64, cv = document.createElement('canvas');
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

    // ---- the layer
    var LS_ON = 'vitulus_mow_load', LS_METRIC = 'vitulus_mow_metric', LS_EVENTS = 'vitulus_mow_events';
    var S = { ros: null, on: false, busy: false, metric: 'load', events: true, view: 'live', store: new Store(), drawn: 0, limits: DEFAULT_LIMITS, runs: [], active: null, summary: null, subs: [], pub: null, reqN: 0, pastReq: null, detailReq: null, lastAsk: 0, ribbon: null, icons: null, pal: null, mpp: 0, card: null, hoverAt: 0, activeReq: 0 };

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
        S.ribbon.onCamera = onCamera;
        bindPointer();
        return true;
    }
    function onCamera(cam) {
        var V = viewer();
        if (!V || !V.cameraControls) return;
        var dom = V.renderer.domElement, mpp = metresPerPx(cam, V.cameraControls.center, dom.clientHeight);
        S.ribbon.uniforms.uMin.value = mpp * 0.9;
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
    function redraw() {
        if (!ensureScene()) return;
        S.ribbon.clear();
        S.pal = palette();
        drawFrom(0);
        paintIcons();
    }
    function setVisible() {
        if (S.ribbon) S.ribbon.root.visible = S.on;
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
        if (ensureScene()) drawFrom(Math.max(1, S.drawn));
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
        S.card.facts = Object.assign({}, S.card.facts, m.row);
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
        return '<div class="mow-scale">' + bar + '</div><div class="mow-states">' + w('mow-w-full', 'cut') + w('mow-w-mid', 'spin') + w('mow-w-thin', 'transit') + w('mow-w-rule', 'rule') + w('mow-w-blocked', 'blocked') + '</div>';
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
            summaryHtml();
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
        var el = document.getElementById('mow_card');
        if (el) el.style.display = 'none';
    }
    function paintCard() {
        var c = S.card;
        if (!c) return;
        var r = c.facts, el = cardEl();
        var groups = cardGroups(r).map(function (g) {
            return '<div class="mow-grp"><h6>' + esc(t('mowl.grp.' + g.k)) + '</h6>' + g.rows.map(function (x) {
                return '<div><span>' + esc(t('mowl.f.' + x[0])) + '</span><b>' + esc(x[1]) + '</b></div>';
            }).join('') + '</div>';
        }).join('');
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
        var saved = lsGet(LS_METRIC) === 'gnss' ? 'accuracy' : lsGet(LS_METRIC);   // the name until 2026-11
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
        panelHost: function () { return '<div data-mow-panel class="mow-panel"></div>'; }, renderPanels: renderPanels,
        _state: S, _start: start, _onTrail: onTrail, _onSnapshot: onSnapshot, _setOn: setOn,
    };
})();
