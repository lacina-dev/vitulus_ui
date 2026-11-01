/* vt_map_profile.js — Map › Recording: the mapping profile of this place.
 *
 * A profile is one set for mapping: the camera's mapping detection, the lidar for
 * mapping, the evidence model. Here you choose it and see what it holds; the camera
 * and the lidar are set in Settings › Camera and Settings › Lidar, the evidence
 * model below. Every place keeps its own: changing the served map changes it.
 *
 * mapping_manager keeps it all (vitulus_mapping/profiles.py):
 *   /mapping_manager/profile_state  std_msgs/String JSON, latched
 *   /mapping_manager/profile_cmd    {id, cmd: select | set | reset | save | delete, ...}
 * both through VTSensorLimits (vt_sensor_ranges.js).
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
    function btn(cls, key, fn) {
        var b = el('button', 'btn btn-sm ' + cls, t(key));
        b.type = 'button';
        b.addEventListener('click', fn);
        return b;
    }

    var BUILTIN = { 'Lawn short': 'lawn_short', 'Lawn tall': 'lawn_tall', 'Paved yard': 'paved', 'Bushes / edge': 'bushes', 'Default (yaml)': 'default' };
    /* [key, min, max, step, decimals]: the evidence model, the only values set here */
    var SLIDERS = [['min_hits', 1, 15, 1, 0], ['hit_inc', 0.05, 2, 0.05, 2], ['miss_dec', 0.05, 2, 0.05, 2],
        ['occ_erode', 0, 1, 0.05, 2], ['occ_thresh', 0.1, 3, 0.05, 2], ['free_thresh', -2, -0.05, 0.05, 2]];
    var MAPPER = { occ_erode: 'occ_erode_factor' };
    var HOLD_MS = 2500, SEND_MS = 300;

    var host = null, P = {}, touched = {}, pend = null, timer = 0, msg = null, sig = '', ask = null, naming = false;

    function name(n) {
        var k = BUILTIN[n];
        return k ? t('mapprof.b.' + k) : n;
    }
    function open(tab) { if (window.VTSensorRanges) { VTSensorRanges.open(tab); } }

    /* ---------------------------------------------------------- skeleton */
    function build() {
        if (!host) { return; }
        host.textContent = '';
        P = {};
        sig = '';
        var head = el('div', 'vt-mp-head');
        head.appendChild(el('span', 'vt-mp-title', t('mapprof.title')));
        P.site = el('span', 'vt-mp-site');
        head.appendChild(P.site);
        host.appendChild(head);
        var line = el('div', 'vt-mp-line');
        P.sel = el('select', 'form-select vt-fs-sm');
        P.sel.id = 'mapv3_profile_select';
        P.sel.setAttribute('aria-label', t('mapprof.title'));
        P.sel.addEventListener('change', onSelect);
        line.appendChild(P.sel);
        P.pill = el('span', 'vt-mp-pill');
        line.appendChild(P.pill);
        host.appendChild(line);
        P.ask = el('div', 'vt-mp-ask');
        host.appendChild(P.ask);
        P.rows = el('div', 'vt-mp-rows');
        P.cam = row('mapprof.row.camera', 'tab_camera');
        P.lid = row('mapprof.row.lidar', 'tab_rplidar');
        P.ev = row('mapprof.row.evidence', null);
        host.appendChild(P.rows);
        P.acts = el('div', 'vt-mp-acts');
        P.save = btn('btn-outline-primary', 'mapprof.save', function () { send({ cmd: 'save' }, 'mapprof.saved'); });
        P.saveAs = btn('btn-outline-primary', 'mapprof.save_as', function () { naming = !naming; paint(); if (naming) { P.nameIn.focus(); } });
        P.back = btn('btn-outline-secondary', 'mapprof.back', function () { send({ cmd: 'reset' }, 'mapprof.backed'); });
        P.del = btn('btn-outline-danger', 'mapprof.delete', delAsk);
        [P.save, P.saveAs, P.back, P.del].forEach(function (b) { P.acts.appendChild(b); });
        host.appendChild(P.acts);
        P.nameRow = el('div', 'input-group input-group-sm vt-mp-name');
        P.nameIn = el('input', 'form-control bg-secondary vt-fs-sm');
        P.nameIn.type = 'text';
        P.nameIn.maxLength = 40;
        P.nameIn.placeholder = t('mapprof.name_ph');
        P.nameIn.setAttribute('aria-label', t('mapprof.name_ph'));
        P.nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { saveNamed(); } });
        P.nameRow.appendChild(P.nameIn);
        P.nameRow.appendChild(btn('btn-primary', 'common.save', saveNamed));
        host.appendChild(P.nameRow);
        P.msg = el('div', 'vt-mp-msg');
        P.msg.setAttribute('role', 'status');
        P.msg.setAttribute('aria-live', 'polite');
        host.appendChild(P.msg);
        var det = el('details', 'vt-cam-adv vt-mp-adv');
        det.setAttribute('data-mapsec', 'profile_evidence');
        var LS = 'vitulus_maptab_profile_evidence';
        try { det.open = localStorage.getItem(LS) === '1'; } catch (e) { /* private mode */ }
        det.addEventListener('toggle', function () { try { localStorage.setItem(LS, det.open ? '1' : '0'); } catch (e) { /* ignore */ } });
        det.appendChild(el('summary', 'vt-fs-sm vt-pointer', t('mapt.adv.evid')));
        det.lastChild.title = t('mapt.adv.evid_tip');
        P.sl = {};
        SLIDERS.forEach(function (s) { addSlider(det, s); });
        host.appendChild(det);
        paint();
    }
    function row(key, tab) {
        var r = el('div', 'vt-mp-row');
        var k = el('span', 'vt-mp-k', t(key));
        r.appendChild(k);
        var v = el('span', 'vt-mp-v', '—');
        r.appendChild(v);
        if (tab) {
            var a = el('a', 'vt-mp-go', t('mapprof.set'));
            a.href = '#';
            a.setAttribute('aria-label', t('mapprof.set') + ': ' + t(key));
            a.addEventListener('click', function (e) {
                e.preventDefault();
                open(tab);
                if (tab === 'tab_camera' && window.VTCameraSettings) { VTCameraSettings.profile('wide'); }
            });
            r.appendChild(a);
        }
        P.rows.appendChild(r);
        return { k: k, key: key, v: v };
    }
    function addSlider(parent, s) {
        var key = s[0], mk = MAPPER[key] || key;
        var r = el('div', 'vt-mp-sl');
        var top = el('div', 'vt-mp-sl-top');
        top.title = t('mapt.adv.' + key + '_tip');
        top.appendChild(el('span', 'vt-grow', t('mapt.adv.' + key)));
        var val = el('span', 'vt-dim', '—');
        top.appendChild(val);
        r.appendChild(top);
        var inp = el('input', 'vt-w100');
        inp.type = 'range'; inp.min = s[1]; inp.max = s[2]; inp.step = s[3];
        inp.setAttribute('aria-label', t('mapt.adv.' + key));
        r.appendChild(inp);
        r.appendChild(el('div', 'vt-app-hint', t('mapt.adv.' + key + '_tip')));
        inp.addEventListener('input', function () {
            var v = s[4] === 0 ? Math.round(Number(inp.value)) : Number(inp.value);
            val.textContent = v.toFixed(s[4]);
            touched[mk] = Date.now();
            pend = pend || {};
            pend[mk] = v;
            clearTimeout(timer);
            timer = setTimeout(flush, SEND_MS);
        });
        parent.appendChild(r);
        P.sl[mk] = { inp: inp, val: val, dec: s[4] };
    }

    /* ---------------------------------------------------------- commands */
    function send(obj, okKey) {
        msg = { key: 'mapprof.sending' };
        paint();
        SL().profileCmd(obj, function (l) {
            if (l.ok) { msg = okKey ? { key: okKey, t: Date.now() } : null; }
            else { msg = { key: l.error ? 'mapprof.refused' : 'mapprof.no_answer', args: { why: l.error }, bad: true }; touched = {}; }
            paint();
        });
    }
    function flush() {
        var v = pend;
        pend = null;
        if (v) { send({ cmd: 'set', mapper: v }); }
    }
    function onSelect() {
        var p = SL().profile(), n = P.sel.value;
        if (!p || n === p.active) { ask = null; paint(); return; }
        if (p.modified) { ask = { name: n, what: 'select' }; paint(); return; }
        send({ cmd: 'select', name: n }, 'mapprof.selected');
    }
    function delAsk() {
        var p = SL().profile();
        if (p) { ask = { name: p.active, what: p.builtin ? 'restore' : 'delete' }; paint(); }
    }
    function confirm() {
        var a = ask;
        ask = null;
        if (a.what === 'select') { send({ cmd: 'select', name: a.name }, 'mapprof.selected'); }
        else { send({ cmd: 'delete', name: a.name }, a.what === 'restore' ? 'mapprof.restored' : 'mapprof.deleted'); }
    }
    function saveNamed() {
        var n = P.nameIn.value.trim();
        if (!n) { return; }
        naming = false;
        P.nameIn.value = '';
        send({ cmd: 'save', name: n }, 'mapprof.saved');
    }

    /* ---------------------------------------------------------- render */
    function count(o, keys) { return keys.filter(function (k) { return o && o[k] !== undefined; }).length; }
    function mark(r, n) { r.k.textContent = t(r.key) + (n ? ' •' : ''); }
    function cameraLine(c) {
        var low = Math.max(Number(c.max_ground_height) || 0, Number(c.min_obstacle_height) || 0);
        var reach = [c.range_max, c.max_depth].filter(function (x) { return Number(x) > 0; });
        return t('mapprof.sum.camera', { a: F().num(low, 2), b: Number(c.max_obstacle_height) > 0 ? F().num(Number(c.max_obstacle_height), 2) : '∞',
            r: reach.length ? F().m(Math.min.apply(null, reach.map(Number)), 1) : '—', n: c.min_cluster_size === undefined ? '—' : String(c.min_cluster_size) });
    }
    function lidarLine(m) {
        return m.use_lidar === false ? t('lidarset.sum.off') : t('lidarset.sum.on', { r: F().m(Number(m.lidar_max_range_m), 1),
            free: t(m.lidar_free_no_hit === false ? 'common.off' : 'common.on'), i: F().num(Number(m.lidar_min_intensity), 0) });
    }
    function syncText(p) {
        var c = p.camera_sync || {};
        if (c.state === 'offline') { return { key: 'mapprof.cam.offline' }; }
        if (c.state === 'pending') { return { key: 'mapprof.cam.pending' }; }
        if (c.state === 'refused') {
            var e = (c.errors || [])[0] || {};
            return { key: 'mapprof.cam.refused', args: { why: (e.key ? e.key + ': ' : '') + (e.code || '') }, bad: true };
        }
        return null;
    }
    function paint() {
        if (!host || !P.sel) { return; }
        var p = SL() && SL().profile();
        P.acts.style.display = p ? '' : 'none';
        P.sel.disabled = !p;
        if (!p) {
            P.site.textContent = '';
            P.pill.textContent = '';
            P.msg.textContent = t('mapprof.no_state');
            return;
        }
        P.site.textContent = p.site ? t('mapprof.site', { site: p.site }) : t('mapprof.no_site');
        P.site.title = t('mapprof.site_tip');
        var s = JSON.stringify(p.profiles) + '|' + (I ? I.lang() : '');
        if (s !== sig) {
            sig = s;
            P.sel.textContent = '';
            p.profiles.forEach(function (x) {
                var o = el('option', null, x.builtin ? name(x.name) + (x.custom ? ' •' : '') : t('mapprof.custom', { name: x.name }));
                o.value = x.name;
                P.sel.appendChild(o);
            });
        }
        if (!ask && document.activeElement !== P.sel) { P.sel.value = p.active; }
        P.pill.textContent = p.modified ? t('mapprof.edited', { n: p.modified }) : '';
        P.pill.classList.toggle('vt-mp-pill-on', !!p.modified);
        var ov = p.overrides, cam = p.values.camera, mp = p.values.mapper;
        P.cam.v.textContent = cameraLine(cam);
        mark(P.cam, Object.keys(ov.camera).length + count(ov.mapper, ['use_cam_obstacle', 'use_cam_free']));
        P.lid.v.textContent = lidarLine(mp);
        mark(P.lid, count(ov.mapper, ['use_lidar', 'lidar_max_range_m', 'lidar_free_no_hit', 'lidar_min_intensity', 'lidar_free_dec']));
        P.ev.v.textContent = t('mapprof.sum.evidence', { n: mp.min_hits, h: F().num(Number(mp.hit_inc), 2), o: F().num(Number(mp.occ_thresh), 2) });
        mark(P.ev, count(ov.mapper, ['min_hits', 'hit_inc', 'miss_dec', 'occ_erode_factor', 'occ_thresh', 'free_thresh']));
        var now = Date.now();
        Object.keys(P.sl).forEach(function (k) {
            var c = P.sl[k];
            if (pend && pend[k] !== undefined) { return; }
            if (touched[k] && now - touched[k] < HOLD_MS) { return; }
            delete touched[k];
            if (mp[k] !== undefined) { c.inp.value = mp[k]; c.val.textContent = Number(mp[k]).toFixed(c.dec); }
        });
        P.save.style.display = p.modified ? '' : 'none';
        P.save.textContent = p.builtin && !p.custom ? t('mapprof.save_builtin', { name: name(p.active) }) : t('mapprof.save');
        P.back.style.display = p.modified ? '' : 'none';
        P.del.style.display = p.custom ? '' : 'none';
        P.del.textContent = t(p.builtin ? 'mapprof.restore' : 'mapprof.delete');
        P.nameRow.style.display = naming ? '' : 'none';
        paintAsk(p);
        var m0 = msg && msg.t && now - msg.t > 6000 ? null : msg;
        var m1 = m0 || syncText(p);
        P.msg.textContent = m1 ? t(m1.key, m1.args) : '';
        P.msg.classList.toggle('vt-err-text', !!(m1 && m1.bad));
    }
    function paintAsk(p) {
        P.ask.textContent = '';
        P.ask.style.display = ask ? '' : 'none';
        if (!ask) { return; }
        var key = ask.what === 'select' ? 'mapprof.ask.select' : ask.what === 'restore' ? 'mapprof.ask.restore' : 'mapprof.ask.delete';
        P.ask.appendChild(el('div', 'vt-warn-text vt-fs-sm', t(key, { name: name(ask.name), n: p.modified })));
        var row2 = el('div', 'vt-mp-acts');
        row2.appendChild(btn('btn-outline-warning', 'mapprof.ask.yes', confirm));
        row2.appendChild(btn('btn-outline-secondary', 'common.cancel', function () { ask = null; paint(); }));
        P.ask.appendChild(row2);
    }
    function init() {
        host = document.getElementById('mapv3_profile');
        if (!host || !SL()) { return; }
        build();
        SL().onChange(paint);
        SL().need('profile', false);
        setInterval(function () { if (msg && msg.t) { paint(); } }, 2000);
        if (I && I.onChange) { I.onChange(build); }
    }
    window.VTMapProfile = { name: name };
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 900); }); }
    else { setTimeout(init, 900); }
})();
