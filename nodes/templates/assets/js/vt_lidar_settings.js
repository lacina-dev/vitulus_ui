/* vt_lidar_settings.js — Settings › Lidar: everything about the 2D lidar.
 *
 *   Lidar        model, firmware, scan mode, rate, motor (seen from the data)
 *   Data flow    the chain /rplidar/scan → scan_ovr → scan_filtered → /scan +
 *                scan_5m: rate of every stage, who reads it (live, from the master)
 *   This scan    counts, distances, distance + strength histograms, top view
 *   Mapping      the only place of use_lidar, lidar_max_range_m, lidar_free_no_hit,
 *                lidar_min_intensity, lidar_free_dec: part of the mapping profile of
 *                this place (/mapping_manager/profile_cmd, always answered, recording
 *                or not; during a recording it reaches direct_raster at once).
 *   Weak-return filter  the one chain value worth changing live (laser_filters
 *                dynamic reconfigure): feeds costmaps and the drive guard, so
 *                narrow limits, a second tap, back to the launch value on restart.
 *
 * Deliberately NOT here: starting / stopping the lidar motor (it would blind the
 * robot), the range filter, the scan mode (those need a restart of the driver).
 * Subscribed only while this tab is on screen, scans throttled to 1 / 3 s.
 */
(function () {
    'use strict';
    var I = window.VTI18n;
    function t(k, v) { return I ? I.t(k, v) : k; }
    function SL() { return window.VTSensorLimits; }
    function F() { return SL().fmt; }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }

    var STAGES = [
        { id: 'raw', topic: '/rplidar/scan', every: 3000 },
        { id: 'ovr', topic: '/rplidar/scan_ovr', every: 1000 },
        { id: 'flt', topic: '/rplidar/scan_filtered', every: 3000 },
        { id: 'scan', topic: '/scan', every: 3000 },
        { id: 's5', topic: '/rplidar/scan_5m', every: 3000 },
    ];
    var STALE_MS = 5000, DIST_BINS = [0, 0.5, 1, 2, 3, 5, 8, 12, 16.01];
    var INT_BINS = [0, 4, 8, 16, 24, 32, 40, 48, 1e9];
    var INT_SAFE = [2, 10], SEND_MS = 300, WAIT_MS = 2500;
    /* who reads a topic: name → label key; safety = stops or steers the robot */
    var NODES = {
        '/drive_primitive': ['drive', 1], '/move_base_flex': ['mbf', 1], '/local_costmap_node': ['local', 1],
        '/lidar_icp_odometry': ['icp', 1], '/dock_detector': ['dock', 1], '/docking_controller': ['dock', 1],
        '/dock/lidar_intensity_dock_filter': ['dock', 0], '/gloc_server': ['gloc', 0], '/lidar_objects': ['objects', 0],
        '/camera_overlay': ['ui', 0], '/camera_calib': ['ui', 0], '/rosbridge_websocket': ['ui', 0],
        '/device_state_pub/device_state_publisher': ['state', 0], '/mapping/direct_raster': ['mapper', 0],
        '/mapping/insertion_gate': ['mapper', 0],
    };
    var HIDE = /^\/(rplidar\/|laser_filter_scan_rplidar)|_\d{4,}_\d{6,}$/;

    var host = null, pane = null, shown = false, built = false, P = {}, armed = 0;
    var rosRef = null, subs = {}, stage = {}, sum = null, lastScan = null, filterLive = null, subParam = null;
    var debounce = 0, pending = null, touched = {}, msg = null, scale = 8, intDraft = null;

    function rosOf() { return (window.ros && window.ros.ros) || null; }

    /* ---------------------------------------------------------- pure */
    function summarize(scan, thr) {
        var R = scan.ranges || [], In = scan.intensities || [], n = R.length;
        var o = { n: n, noReturn: 0, weak: 0, used: 0, near: null, nearA: null, far: null, median: null,
            dist: DIST_BINS.slice(1).map(function () { return 0; }), inten: INT_BINS.slice(1).map(function () { return 0; }) };
        var rmin = Number(scan.range_min) || 0, a0 = Number(scan.angle_min) || 0, inc = Number(scan.angle_increment) || 0, used = [];
        function bin(B, v) { for (var j = 0; j < B.length - 1; j++) { if (v >= B[j] && v < B[j + 1]) { return j; } } return -1; }
        for (var i = 0; i < n; i++) {
            var r = R[i], fin = typeof r === 'number' && isFinite(r), s = Number(In[i]) || 0;
            if (!fin) { o.noReturn++; continue; }
            var b = bin(INT_BINS, s);
            if (b >= 0) { o.inten[b]++; }
            if (s <= thr || r < rmin) { o.weak++; continue; }
            o.used++;
            used.push(r);
            var d = bin(DIST_BINS, r);
            if (d >= 0) { o.dist[d]++; }
            if (o.near === null || r < o.near) { o.near = r; o.nearA = a0 + i * inc; }
            if (o.far === null || r > o.far) { o.far = r; }
        }
        used.sort(function (x, y) { return x - y; });
        if (used.length) { o.median = used[Math.floor(used.length / 2)]; }
        return o;
    }

    /* ---------------------------------------------------------- ROS */
    function onConfig(c) {
        (c.doubles || []).forEach(function (d) { if (d.name === 'lower_threshold') { filterLive = d.value; } });
    }
    function handler(s) {
        return function (m) {
            var now = Date.now(), x = stage[s.id] || {};
            if (now - (x.at || 0) < s.every * 0.8) { return; }
            var seq = m.header && m.header.seq, st = m.header && m.header.stamp;
            var sec = st ? (st.secs + st.nsecs * 1e-9) : now / 1000;
            if (x.seq !== undefined && seq > x.seq && sec > x.sec) { x.hz = (seq - x.seq) / (sec - x.sec); }
            x.seq = seq; x.sec = sec; x.at = now;
            stage[s.id] = x;
            if (s.id === 'ovr') {
                lastScan = m;
                SL().setScanMeta({ range_min: m.range_min, range_max: m.range_max, angle_min: m.angle_min, angle_max: m.angle_max });
            }
        };
    }
    function subscribe(on) {
        var r = rosOf();
        if (on && r && window.ROSLIB) {
            rosRef = r;
            STAGES.forEach(function (s) {
                if (subs[s.id]) { return; }
                var tp = new ROSLIB.Topic({ ros: r, name: s.topic, messageType: 'sensor_msgs/LaserScan', throttle_rate: s.every, queue_length: 1 });
                var cb = handler(s);
                tp.subscribe(cb);
                subs[s.id] = { tp: tp, cb: cb };
            });
            if (!subParam) {
                subParam = new ROSLIB.Topic({ ros: r, name: '/laser_filter_scan_rplidar/intensity/parameter_updates', messageType: 'dynamic_reconfigure/Config', queue_length: 1 });
                subParam.subscribe(onConfig);
            }
        } else if (!on) {
            Object.keys(subs).forEach(function (k) { try { subs[k].tp.unsubscribe(subs[k].cb); } catch (e) { /* ignore */ } });
            subs = {};
            if (subParam) { try { subParam.unsubscribe(onConfig); } catch (e) { /* ignore */ } subParam = null; }
        }
    }

    /* ---------------------------------------------------------- skeleton */
    function card(id, titleKey) {
        var c = el('div', 'vt-card');
        c.setAttribute('data-card', id);
        var head = el('div', 'vt-card-head');
        head.appendChild(el('span', 'vt-card-title', t(titleKey)));
        var end = el('span', 'vt-end');
        head.appendChild(end);
        var body = el('div', 'vt-lid-body');
        c.appendChild(head); c.appendChild(body);
        return { card: c, end: end, body: body };
    }
    function kv(dl, key) {
        dl.appendChild(el('dt', null, t(key)));
        var dd = el('dd', null, '—');
        dl.appendChild(dd);
        return dd;
    }
    function build() {
        if (!host) { return; }
        host.textContent = '';
        P = {};
        var stack = el('div', 'vt-stack');
        P.dev = card('device', 'lidarset.dev.title');
        var dl = el('dl', 'vt-kv');
        P.k = {};
        ['model', 'fw', 'hw', 'serial', 'mode', 'sample', 'rate', 'motor', 'health', 'max'].forEach(function (k) { P.k[k] = kv(dl, 'lidarset.dev.' + k); });
        P.dev.body.appendChild(dl);
        P.devNote = el('div', 'vt-app-hint');
        P.dev.body.appendChild(P.devNote);

        P.flow = card('flow', 'lidarset.flow.title');
        P.stage = {};
        STAGES.forEach(function (s) {
            var r = el('div', 'vt-lid-stage');
            var top = el('div', 'vt-lid-stage-top');
            top.appendChild(el('code', 'vt-lid-topic', s.topic));
            var hz = el('span', 'vt-lid-hz', '—');
            top.appendChild(hz);
            r.appendChild(top);
            var what = el('div', 'vt-app-hint');
            r.appendChild(what);
            var who = el('div', 'vt-lid-who');
            r.appendChild(who);
            P.flow.body.appendChild(r);
            P.stage[s.id] = { hz: hz, what: what, who: who, sig: '' };
        });
        P.flow.body.appendChild(el('div', 'vt-app-hint', t('lidarset.flow.hint')));

        P.scan = card('scan', 'lidarset.scan.title');
        var d2 = el('dl', 'vt-kv vt-kv-2');
        P.s = {};
        ['beams', 'used', 'weak', 'none', 'near', 'median', 'far'].forEach(function (k) { P.s[k] = kv(d2, 'lidarset.scan.' + k); });
        P.scan.body.appendChild(d2);
        P.distBars = bars(P.scan.body, 'lidarset.scan.dist', DIST_BINS.slice(0, -1).map(function (v, i) {
            return i === DIST_BINS.length - 2 ? F().num(v, 0) + '+' : F().num(v, v % 1 ? 1 : 0);
        }));
        P.intBars = bars(P.scan.body, 'lidarset.scan.int', ['0–3', '4–7', '8–15', '16–23', '24–31', '32–39', '40–47', '48+']);
        P.intNote = el('div', 'vt-app-hint');
        P.scan.body.appendChild(P.intNote);
        var view = el('div', 'vt-lid-view');
        P.canvas = el('canvas', 'vt-lid-canvas');
        P.canvas.setAttribute('role', 'img');
        P.canvas.setAttribute('aria-label', t('lidarset.view.aria'));
        view.appendChild(P.canvas);
        var bar = el('div', 'btn-group btn-group-sm vt-seg vt-lid-scale');
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', t('lidarset.view.scale'));
        P.scaleBtns = [3, 8, 16].map(function (v) {
            var b = el('button', 'btn btn-primary', F().m(v, 0));
            b.type = 'button';
            b.addEventListener('click', function () { scale = v; paintScale(); drawView(); });
            bar.appendChild(b);
            return [v, b];
        });
        view.appendChild(bar);
        P.scan.body.appendChild(view);
        P.scan.body.appendChild(el('div', 'vt-app-hint', t('lidarset.view.hint')));
        var acts = el('div', 'vt-lid-actions');
        var show = el('button', 'btn btn-sm btn-outline-info', t('lidarset.view.show'));
        show.type = 'button';
        show.addEventListener('click', function () { if (window.VTSensorRanges) { VTSensorRanges.show('lidar'); } });
        acts.appendChild(show);
        P.scan.body.appendChild(acts);

        P.map = card('mapping', 'lidarset.map.title');
        P.mapMode = el('div', 'vt-app-hint');
        P.map.body.appendChild(P.mapMode);
        var items = el('div', 'vt-app-items');
        P.ctl = {};
        addCheck(items, 'use_lidar');
        addRange(items, 'lidar_max_range_m', 0.5, 16, 0.5, 1, 'm');
        addCheck(items, 'lidar_free_no_hit');
        addRange(items, 'lidar_min_intensity', 0, 60, 1, 0, '');
        addRange(items, 'lidar_free_dec', 0, 1, 0.02, 2, '');
        P.map.body.appendChild(items);
        var ma = el('div', 'vt-lid-actions');
        P.dropPending = el('button', 'btn btn-sm btn-outline-secondary', t('lidarset.map.drop'));
        P.dropPending.type = 'button';
        P.dropPending.addEventListener('click', dropPending);
        ma.appendChild(P.dropPending);
        var onMap = el('button', 'btn btn-sm btn-outline-info', t('lidarset.view.show'));
        onMap.type = 'button';
        onMap.addEventListener('click', function () { if (window.VTSensorRanges) { VTSensorRanges.show('lidar', 'map'); } });
        ma.appendChild(onMap);
        P.map.body.appendChild(ma);
        P.mapMsg = el('div', 'vt-app-hint');
        P.mapMsg.setAttribute('role', 'status');
        P.mapMsg.setAttribute('aria-live', 'polite');
        P.map.body.appendChild(P.mapMsg);

        P.flt = card('filter', 'lidarset.flt.title');
        buildFilter();

        [P.dev, P.flow, P.scan, P.map, P.flt].forEach(function (p) { stack.appendChild(p.card); });
        host.appendChild(stack);
        built = true;
        paintScale();
        update();
    }
    function bars(parent, titleKey, labels) {
        parent.appendChild(el('div', 'vt-label vt-label-gap', t(titleKey)));
        var box = el('div', 'vt-lid-bars');
        var cols = labels.map(function (lab) {
            var c = el('div', 'vt-lid-col');
            var well = el('div', 'vt-lid-well');
            var val = el('span', 'vt-lid-val', '');
            var fill = el('div', 'vt-lid-fill');
            well.appendChild(val);
            well.appendChild(fill);
            c.appendChild(well);
            c.appendChild(el('span', 'vt-lid-tick', lab));
            box.appendChild(c);
            return { fill: fill, val: val, col: c, lab: lab };
        });
        parent.appendChild(box);
        return cols;
    }
    function paintBars(cols, data, dimFn) {
        var max = Math.max.apply(null, data.concat([1]));
        cols.forEach(function (c, i) {
            c.fill.style.height = (data[i] ? Math.max(4, data[i] / max * 100) : 0) + '%';
            c.val.textContent = data[i] ? String(data[i]) : '';
            c.fill.classList.toggle('vt-lid-dim', !!(dimFn && dimFn(i)));
            c.col.title = c.lab + ': ' + data[i];
        });
    }
    function paintScale() {
        P.scaleBtns.forEach(function (x) {
            x[1].classList.toggle('vt-sel', x[0] === scale);
            x[1].setAttribute('aria-pressed', x[0] === scale ? 'true' : 'false');
        });
    }
    function rowHead(box, key) {
        var head = el('div', 'vt-lid-row-head');
        head.appendChild(el('span', 'vt-label vt-grow', t('lidarset.map.' + key)));
        var src = el('span', 'vt-lid-src');
        head.appendChild(src);
        box.appendChild(head);
        return src;
    }
    function addCheck(items, key) {
        var box = el('div', 'vt-lid-row');
        var src = rowHead(box, key);
        var g = el('div', 'btn-group btn-group-sm vt-seg');
        g.setAttribute('role', 'group');
        g.setAttribute('aria-label', t('lidarset.map.' + key));
        var opts = [[true, 'common.on'], [false, 'common.off']].map(function (o) {
            var b = el('button', 'btn btn-primary', t(o[1]));
            b.type = 'button';
            b.addEventListener('click', function () { change(key, o[0]); });
            g.appendChild(b);
            return [o[0], b];
        });
        box.appendChild(g);
        box.appendChild(el('div', 'vt-app-hint', t('lidarset.map.h.' + key)));
        items.appendChild(box);
        P.ctl[key] = { src: src, show: function (v) {
            opts.forEach(function (x) {
                x[1].classList.toggle('vt-sel', x[0] === v);
                x[1].setAttribute('aria-pressed', x[0] === v ? 'true' : 'false');
            });
        }, typing: function () { return false; } };
    }
    function addRange(items, key, min, max, step, dec, unit) {
        var box = el('div', 'vt-lid-row');
        var src = rowHead(box, key);
        var line = el('div', 'vt-lid-range');
        var r = el('input', 'form-range');
        r.type = 'range'; r.min = min; r.max = max; r.step = step;
        r.setAttribute('aria-label', t('lidarset.map.' + key));
        line.appendChild(r);
        var g = el('div', 'input-group input-group-sm vt-lid-num');
        var n = el('input', 'form-control');
        n.type = 'number'; n.min = min; n.max = max; n.step = step; n.inputMode = 'decimal';
        n.setAttribute('aria-label', t('lidarset.map.' + key));
        g.appendChild(n);
        if (unit) { g.appendChild(el('span', 'input-group-text', unit)); }
        line.appendChild(g);
        box.appendChild(line);
        var why = el('div', 'vt-app-hint vt-warn-text');
        box.appendChild(why);
        box.appendChild(el('div', 'vt-app-hint', t('lidarset.map.h.' + key)));
        items.appendChild(box);
        r.addEventListener('input', function () { n.value = Number(r.value).toFixed(dec); change(key, Number(r.value)); });
        n.addEventListener('change', function () {
            var v = parseFloat(String(n.value).replace(',', '.'));
            if (!isFinite(v)) { paintMapping(true); return; }
            v = Math.min(max, Math.max(min, v));
            r.value = v; n.value = v.toFixed(dec);
            change(key, v);
        });
        P.ctl[key] = { src: src, why: why, show: function (v) { r.value = v; if (document.activeElement !== n) { n.value = Number(v).toFixed(dec); } },
            typing: function () { return document.activeElement === n; } };
    }
    function buildFilter() {
        var b = P.flt.body;
        P.flt.end.textContent = t('lidarset.flt.safety');
        P.flt.card.setAttribute('data-state', 'warn');
        b.appendChild(el('div', 'vt-app-hint vt-warn-text', t('lidarset.flt.warn')));
        var d = el('dl', 'vt-kv vt-kv-2');
        P.f = { live: kv(d, 'lidarset.flt.now'), def: kv(d, 'lidarset.flt.launch'), range: kv(d, 'lidarset.flt.range'), masks: kv(d, 'lidarset.flt.masks') };
        b.appendChild(d);
        var line = el('div', 'vt-lid-range vt-lid-row');
        var r = el('input', 'form-range');
        r.type = 'range'; r.min = INT_SAFE[0]; r.max = INT_SAFE[1]; r.step = 1;
        r.setAttribute('aria-label', t('lidarset.flt.now'));
        var val = el('span', 'vt-lid-fval', '—');
        line.appendChild(r); line.appendChild(val);
        b.appendChild(line);
        r.addEventListener('input', function () { intDraft = Number(r.value); armed = 0; paintFilter(); });
        var acts = el('div', 'vt-lid-actions');
        P.fApply = el('button', 'btn btn-sm btn-outline-warning', t('lidarset.flt.apply'));
        P.fApply.type = 'button';
        P.fApply.addEventListener('click', function () {
            if (intDraft === null) { return; }
            if (Date.now() - armed < 4000) { armed = 0; applyFilter(intDraft); }
            else { armed = Date.now(); setTimeout(paintFilter, 4100); }
            paintFilter();
        });
        P.fReset = el('button', 'btn btn-sm btn-outline-secondary', t('lidarset.flt.reset'));
        P.fReset.type = 'button';
        P.fReset.addEventListener('click', function () {
            var lim = SL().limits(), v = lim && lim.lidar.chain.intensity && lim.lidar.chain.intensity.lower;
            if (typeof v === 'number') { intDraft = v; armed = 0; applyFilter(v); }
        });
        acts.appendChild(P.fApply); acts.appendChild(P.fReset);
        b.appendChild(acts);
        P.fRange = r; P.fVal = val;
        P.fMsg = el('div', 'vt-app-hint');
        P.fMsg.setAttribute('role', 'status');
        P.fMsg.setAttribute('aria-live', 'polite');
        b.appendChild(P.fMsg);
        b.appendChild(el('div', 'vt-app-hint', t('lidarset.flt.hint')));
    }

    /* ---------------------------------------------------------- mapping */
    var LIDAR_KEYS = ['use_lidar', 'lidar_max_range_m', 'lidar_free_no_hit', 'lidar_min_intensity', 'lidar_free_dec'];
    function mapperValues() {
        var p = SL().profile();
        return p ? { v: p.values.mapper, ov: p.overrides.mapper, p: p } : { v: {}, ov: {}, p: null };
    }
    function change(key, value) {
        touched[key] = { v: value, at: Date.now() };
        pending = pending || {};
        pending[key] = value;
        clearTimeout(debounce);
        debounce = setTimeout(flush, SEND_MS);
        P.ctl[key].show(value);
    }
    function sent(okKey) {
        return function (l) {
            if (l.ok) { msg = { key: okKey }; }
            else {
                msg = { key: l.error ? 'lidarset.map.refused' : 'lidarset.map.no_echo', args: { why: l.error }, bad: true };
                touched = {};
            }
            paintMapping(!l.ok);
        };
    }
    function flush() {
        var vals = pending;
        pending = null;
        if (!vals) { return; }
        msg = { key: 'lidarset.map.sent' };
        paintMapping();
        SL().profileCmd({ cmd: 'set', mapper: vals }, sent('lidarset.map.saved'));
    }
    function dropPending() {
        touched = {};
        SL().profileCmd({ cmd: 'reset', mapper: LIDAR_KEYS }, sent('lidarset.map.dropped'));
    }
    function srcText(key, m) {
        if (!m.p) { return ''; }
        return t(m.ov[key] !== undefined ? 'lidarset.map.src.changed' : 'lidarset.map.src.profile');
    }
    function paintMapping(force) {
        if (!built) { return; }
        var m = mapperValues(), r = SL().ranges(), now = Date.now();
        var pn = m.p && window.VTMapProfile ? VTMapProfile.name(m.p.active) : '';
        P.mapMode.textContent = !m.p ? t('lidarset.map.loading')
            : m.p.site ? t('lidarset.map.mode_site', { name: pn, site: m.p.site }) : t('lidarset.map.mode_nosite', { name: pn });
        Object.keys(P.ctl).forEach(function (k) {
            var c = P.ctl[k], tt = touched[k];
            if (tt && now - tt.at < WAIT_MS && !force) { c.src.textContent = srcText(k, m); return; }
            delete touched[k];
            if (m.v[k] !== undefined && !c.typing()) { c.show(m.v[k]); }
            c.src.textContent = srcText(k, m);
        });
        P.dropPending.style.display = LIDAR_KEYS.some(function (k) { return m.ov[k] !== undefined; }) ? '' : 'none';
        if (P.ctl.lidar_max_range_m.why) { P.ctl.lidar_max_range_m.why.textContent = F().whyCut(r.lidar.map); }
        var im = r.lidar.intMin;
        P.ctl.lidar_min_intensity.why.textContent = im && im.cut ? t('lidarset.map.int_cut', { v: F().num(im.v, 0), by: F().byText(im.by) }) : '';
        P.mapMsg.textContent = msg ? t(msg.key, msg.args) : '';
        P.mapMsg.classList.toggle('vt-err-text', !!(msg && msg.bad));
    }

    /* ---------------------------------------------------------- filter */
    function liveThreshold() {
        if (typeof filterLive === 'number') { return filterLive; }
        var lim = SL().limits();
        return lim ? lim.lidar.filter.intensity_lower : null;
    }
    function applyFilter(v) {
        var r = rosOf();
        if (!r || !window.ROSLIB) { return; }
        var sv = new ROSLIB.Service({ ros: r, name: '/laser_filter_scan_rplidar/intensity/set_parameters', serviceType: 'dynamic_reconfigure/Reconfigure' });
        var req = new ROSLIB.ServiceRequest({ config: { bools: [], ints: [], strs: [], doubles: [{ name: 'lower_threshold', value: v }], groups: [] } });
        P.fMsg.textContent = t('lidarset.flt.sending');
        sv.callService(req, function (res) {
            var got = ((res.config && res.config.doubles) || []).filter(function (d) { return d.name === 'lower_threshold'; })[0];
            if (got) { filterLive = got.value; }
            intDraft = null;
            P.fMsg.textContent = t('lidarset.flt.done', { v: F().num(filterLive, 0) });
            paintFilter();
        }, function (e) { P.fMsg.textContent = t('lidarset.flt.failed', { why: String(e) }); });
    }
    function paintFilter() {
        if (!built) { return; }
        var lim = SL().limits(), L = lim && lim.lidar, cur = liveThreshold();
        var def = L && L.chain.intensity ? L.chain.intensity.lower : null;
        P.f.live.textContent = typeof cur === 'number' ? F().num(cur, 0) : '—';
        P.f.def.textContent = typeof def === 'number' ? F().num(def, 0) : '—';
        P.f.range.textContent = L && L.filter.range_lower !== null ? F().num(L.filter.range_lower, 2) + '–' + F().m(L.filter.range_upper, 1) : '—';
        P.f.masks.textContent = L ? (L.chain.masks.length ? L.chain.masks.map(function (m) { return m.type; }).join(', ') : t('lidarset.flt.no_masks')) : '—';
        var v = intDraft !== null ? intDraft : cur, have = typeof v === 'number';
        if (have && document.activeElement !== P.fRange) { P.fRange.value = v; }
        P.fVal.textContent = have ? F().num(v, 0) : '—';
        var off = !have || intDraft === null || intDraft === cur;
        P.fApply.disabled = off;
        P.fApply.textContent = t(Date.now() - armed < 4000 ? 'lidarset.flt.confirm' : 'lidarset.flt.apply');
        P.fReset.disabled = !(typeof def === 'number' && typeof cur === 'number' && def !== cur);
    }

    /* ---------------------------------------------------------- render */
    function stageHz(id) {
        var x = stage[id];
        if (!x || Date.now() - x.at > STALE_MS) { return null; }
        return x.hz === undefined ? undefined : x.hz;
    }
    function hzText(v) { return v === null ? t('lidarset.flow.none') : v === undefined ? '…' : t('lidarset.flow.hz', { v: F().num(v, 1) }); }
    function renderDevice() {
        var lim = SL().limits(), L = (lim && lim.lidar) || {}, dv = L.device || {}, dr = L.driver || {};
        var hz = stageHz('raw'), run = typeof hz === 'number' && hz > 1, wait = hz === undefined;
        var known = run || (Date.now() - (shown ? P.shownAt || 0 : 0) > 7000);
        var state = !known || wait ? 'off' : !run ? 'err' : hz < 5 ? 'warn' : 'ok';
        P.dev.card.setAttribute('data-state', state);
        P.dev.end.textContent = state === 'off' ? t('lidarset.dev.wait') : !run ? t('lidarset.dev.no_scan') : t('lidarset.dev.live', { hz: F().num(hz, 1) });
        P.k.model.textContent = dv.model ? 'RPLIDAR ' + dv.model : '—';
        P.k.fw.textContent = dv.firmware || '—';
        P.k.hw.textContent = dv.hardware || '—';
        P.k.serial.textContent = dv.serial || '—';
        P.k.mode.textContent = dv.scan_mode || dr.scan_mode || '—';
        P.k.sample.textContent = dv.sample_khz ? t('lidarset.dev.khz', { v: F().num(dv.sample_khz, 0) }) : '—';
        P.k.rate.textContent = typeof hz === 'number' ? t('lidarset.flow.hz', { v: F().num(hz, 1) }) : (dr.scan_frequency ? t('lidarset.dev.set_hz', { v: F().num(dr.scan_frequency, 1) }) : '—');
        P.k.motor.textContent = t(run ? 'lidarset.dev.motor_run' : known && !wait ? 'lidarset.dev.motor_stop' : 'lidarset.dev.motor_unknown');
        P.k.health.textContent = dv.health ? t('lidarset.dev.h.' + dv.health.toLowerCase()) : '—';
        P.k.max.textContent = dv.max_distance_m ? F().m(dv.max_distance_m, 1) : '—';
        P.devNote.textContent = SL().limitsFailed() ? t('lidarset.dev.no_api') : !dv.model ? t('lidarset.dev.no_log') : t('lidarset.dev.note');
    }
    function renderFlow() {
        var lim = SL().limits(), L = lim && lim.lidar, thr = liveThreshold();
        var what = {
            raw: t('lidarset.flow.w.raw'), ovr: t('lidarset.flow.w.ovr'),
            flt: t('lidarset.flow.w.flt', { v: typeof thr === 'number' ? F().num(thr, 0) : '—',
                a: L ? F().num(L.filter.range_lower, 2) : '—', b: L ? F().num(L.filter.range_upper, 0) : '—' }),
            scan: t('lidarset.flow.w.scan'), s5: t('lidarset.flow.w.s5'),
        };
        STAGES.forEach(function (s) {
            var p = P.stage[s.id], v = stageHz(s.id);
            p.hz.textContent = hzText(v);
            p.hz.classList.toggle('vt-err-text', v === null && shown && Date.now() - P.shownAt > 7000);
            p.what.textContent = what[s.id];
            var list = (L && L.subscribers && L.subscribers[s.topic]) || [];
            var sig = list.join(',');
            if (sig !== p.sig) {
                p.sig = sig;
                p.who.textContent = '';
                var seen = {};
                list.forEach(function (n) {
                    if (HIDE.test(n)) { return; }
                    var d = NODES[n], label = d ? t('lidarset.node.' + d[0]) : n;
                    if (seen[label]) { return; }
                    seen[label] = 1;
                    var chip = el('span', 'vt-lid-chip' + (d && d[1] ? ' vt-lid-safe' : ''), label);
                    if (d && d[1]) {
                        var ic = el('i', 'la la-shield');
                        ic.setAttribute('aria-hidden', 'true');
                        chip.insertBefore(ic, chip.firstChild);
                        chip.title = t('lidarset.flow.safety_tip');
                    }
                    p.who.appendChild(chip);
                });
            }
        });
    }
    function renderScan() {
        var thr = liveThreshold(), s = lastScan && Date.now() - (stage.ovr ? stage.ovr.at : 0) < STALE_MS
            ? summarize(lastScan, typeof thr === 'number' ? thr : 0) : null;
        sum = s;
        P.scan.card.setAttribute('data-state', s ? 'ok' : 'off');
        P.scan.end.textContent = s ? t('lidarset.scan.share', { v: F().num(s.n ? s.used / s.n * 100 : 0, 0) }) : t('lidarset.scan.none_yet');
        var kvs = { beams: s && s.n, used: s && s.used, weak: s && s.weak, none: s && s.noReturn };
        Object.keys(kvs).forEach(function (k) { P.s[k].textContent = s ? String(kvs[k]) : '—'; });
        P.s.near.textContent = s && s.near !== null ? F().m(s.near, 2) : '—';
        P.s.median.textContent = s && s.median !== null ? F().m(s.median, 2) : '—';
        P.s.far.textContent = s && s.far !== null ? F().m(s.far, 2) : '—';
        paintBars(P.distBars, s ? s.dist : P.distBars.map(function () { return 0; }));
        /* the bins at or below the threshold: the filter throws those away */
        var low = typeof thr === 'number' ? thr : 0;
        paintBars(P.intBars, s ? s.inten : P.intBars.map(function () { return 0; }), function (i) { return INT_BINS[i + 1] - 1 <= low; });
        P.intNote.textContent = typeof thr === 'number' ? t('lidarset.scan.int_note', { v: F().num(thr, 0) }) : '';
        drawView();
    }
    function drawView() {
        var c = P.canvas;
        if (!c || !c.clientWidth) { return; }
        var css = c.clientWidth, dpr = Math.min(window.devicePixelRatio || 1, 2), px = Math.round(css * dpr);
        if (c.width !== px) { c.width = c.height = px; }
        var g = c.getContext('2d'), cx = px / 2, cy = px / 2, k = (px / 2 - 8 * dpr) / scale;
        var style = getComputedStyle(host), muted = style.getPropertyValue('--vt-muted') || '#9aa4ad';
        g.clearRect(0, 0, px, px);
        var r = SL().ranges().lidar;
        var rings = [[r.nav, 'rgba(179,136,255,0.9)'], [r.map && r.mapOn ? r.map : null, 'rgba(179,136,255,0.6)'], [r.sensor, 'rgba(179,136,255,0.3)']];
        g.font = (11 * dpr) + 'px sans-serif';
        rings.forEach(function (x) {
            if (!x[0] || x[0].v > scale) { return; }
            g.strokeStyle = x[1];
            g.lineWidth = dpr;
            g.beginPath();
            g.arc(cx, cy, x[0].v * k, 0, 2 * Math.PI);
            g.stroke();
            g.fillStyle = muted;
            g.fillText(F().m(x[0].v), cx + 4 * dpr, cy - x[0].v * k + 13 * dpr);
        });
        var fr = 0.238, re = 0.288, hw = 0.256;   // drive_primitive footprint
        g.fillStyle = 'rgba(255,113,0,0.85)';
        g.fillRect(cx - hw * k, cy - fr * k, 2 * hw * k, (fr + re) * k);
        g.beginPath();                            // the front
        g.moveTo(cx, cy - fr * k - 8 * dpr);
        g.lineTo(cx - 5 * dpr, cy - fr * k - 1);
        g.lineTo(cx + 5 * dpr, cy - fr * k - 1);
        g.fill();
        var m = lastScan;
        if (!m || !sum) { return; }
        var yaw = SL().lidarYaw(), cyaw = Math.cos(yaw), syaw = Math.sin(yaw), a0 = m.angle_min, inc = m.angle_increment;
        var thr = liveThreshold(), R = m.ranges, In = m.intensities || [];
        var sz = Math.max(2, 2 * dpr);
        for (var i = 0; i < R.length; i++) {
            var d = R[i];
            if (typeof d !== 'number' || !isFinite(d)) { continue; }
            var a = a0 + i * inc, lx = d * Math.cos(a), ly = d * Math.sin(a);
            var x = cyaw * lx - syaw * ly, y = syaw * lx + cyaw * ly;      // robot frame
            var weak = typeof thr === 'number' && (Number(In[i]) || 0) <= thr;
            g.fillStyle = weak ? 'rgba(255,183,77,0.9)' : '#b388ff';
            g.fillRect(cx - y * k - sz / 2, cy - x * k - sz / 2, sz, sz);
        }
    }
    function update() {
        if (!built || !shown) { return; }
        renderDevice();
        renderFlow();
        renderScan();
        paintMapping();
        paintFilter();
    }
    function poll() {
        var vis = !!(pane && pane.classList.contains('active') && pane.offsetParent !== null && !document.hidden);
        if (vis !== shown) {
            shown = vis;
            subscribe(vis);
            SL().need('tab', vis);
            if (vis) { P.shownAt = Date.now(); SL().refresh(); }
        }
        if (vis) {
            if (rosOf() && rosOf() !== rosRef) { subscribe(false); subscribe(true); }
            update();
        }
    }
    function init() {
        host = document.getElementById('div_lidar_settings');
        pane = document.getElementById('tab_rplidar');
        if (!host || !pane || !SL()) { return; }
        build();
        var link = document.querySelector('a.nav-link[href="#tab_rplidar"]');
        if (link) { link.addEventListener('shown.bs.tab', poll); }
        setInterval(poll, 1000);
        document.addEventListener('visibilitychange', poll);
        if (I && I.onChange) { I.onChange(function () { build(); }); }
        if (SL().onChange) { SL().onChange(function () { if (shown) { paintMapping(); paintFilter(); } }); }
    }
    window.VTLidarSettings = { summarize: summarize, _stage: function () { return stage; } };
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); }); }
    else { setTimeout(init, 0); }
})();
