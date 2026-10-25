/* status_header.js — the robot status icons (#status_div) and the system
   monitor of the header (owner 2026-10-25, header variant A "three zones",
   docs/UI_LAYOUT.md "Navbar").

   Status icons (the green pictograms: weather / sensors / drive / thermal /
   power) are grouped here and live in the header right after the logo — on
   every layout except the phone held upright, where they keep their own row
   of the top frame (#row_icons).  They start at a FIXED x (the logo zone has
   a fixed width, vt_header.css), so nothing in the header moves them.  On a
   narrow window (body.vt-h-sum, vt_header.js) each group shows ONE icon, the
   worst of the group (red > orange > green > grey), marked .sh-rep here.
   The <img> nodes are MOVED, never recreated: dashboard.js swaps their `src`
   by bare id.

   System monitor (#system_monitor_header): CPU · RAM · ↓ ↑ of the robot's
   computer in FIXED slots — Roboto tabular figures, a percentage in a 3ch
   slot + "%", a network value in a 3ch slot + its unit in a 2.9em box, so
   the block keeps ONE width whatever the numbers do (266 px, 186 px with ↓
   only).  Values are smoothed (EMA ~6 s) and the network unit has a
   hysteresis (up at 1000, down under 900).  Colours warn only when it is
   needed: CPU by its 30-s AVERAGE (≥ 90 % amber, ≥ 97 % red), RAM / disk
   by their value (≥ 90 / ≥ 97 %), never by a momentary spike.
   On a narrower window the block becomes a chip (#btn_sys_chip, one icon in
   the worst colour); a click on either opens the card (#sh_sys_card) with
   rings CPU · RAM · DISK, the network and a link to Settings › Diag.  On a
   phone the same numbers are in the ⋯ menu (vt_header.js mounts
   VTSys.section()).  Data: the robot's own webnode, GET /api/system, every
   2 s; read only. */
(function () {
    'use strict';
    if (window.__status_header_wired) { return; }   // never double-wire
    window.__status_header_wired = true;
    var SHEET_MAX_W = 576;    // phone upright: the icons keep their own row
    function tr(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tag(e, k, attr) { if (window.VTI18n) { VTI18n.tag(e, k, attr); } }
    function $(id) { return document.getElementById(id); }
    var marker = null;        // remembers the original spot in #row_icons

    /* ------------------------------------------------ icons: the place */
    function toHeader() {
        var strip = $('status_div'), brand = document.querySelector('#div_menu .vt-brand');
        if (!strip || !brand || !brand.parentNode) { return; }
        if (!marker) {
            marker = document.createElement('span');
            marker.id = 'status_div_home';
            marker.style.display = 'none';
            strip.parentNode.insertBefore(marker, strip);
        }
        if (strip.parentNode !== brand.parentNode) { brand.parentNode.insertBefore(strip, brand.nextSibling); }
        strip.classList.add('in-header');
    }
    function toMap() {
        var strip = $('status_div');
        if (!strip || !strip.classList.contains('in-header')) { return; }
        if (marker && marker.parentNode) { marker.parentNode.insertBefore(strip, marker); }
        strip.classList.remove('in-header');
    }

    /* ------------------------------------------------ icons: the groups */
    var GROUPS = [
        {id: 'weather', title: 'status.group.weather', icons: ['ico_rain']},
        {id: 'sense', title: 'status.group.sense',
         icons: ['ico_wifi', 'ico_gps', 'ico_gps_nav', 'ico_imu', 'ico_lidar', 'ico_camera']},
        {id: 'drive', title: 'status.group.drive',
         icons: ['ico_fl_motor', 'ico_fr_motor', 'ico_rl_motor', 'ico_rr_motor', 'ico_mower']},
        {id: 'therm', title: 'status.group.therm',
         icons: ['ico_temp_pcb', 'ico_fan_pcb', 'ico_temp', 'ico_fan']},
        {id: 'power', title: 'status.group.power',
         icons: ['ico_supply', 'ico_batt']}
    ];
    var TITLES = {
        ico_wifi: 'status.ico.wifi', ico_gps: 'status.ico.gps', ico_gps_nav: 'status.ico.gps_nav',
        ico_imu: 'status.ico.imu', ico_lidar: 'status.ico.lidar', ico_camera: 'status.ico.camera',
        ico_mower: 'status.ico.mower', ico_fl_motor: 'status.ico.fl_motor',
        ico_fr_motor: 'status.ico.fr_motor', ico_rl_motor: 'status.ico.rl_motor',
        ico_rr_motor: 'status.ico.rr_motor', ico_temp_pcb: 'status.ico.temp_pcb',
        ico_fan_pcb: 'status.ico.fan_pcb', ico_temp: 'status.ico.temp',
        ico_fan: 'status.ico.fan', ico_supply: 'status.ico.supply',
        ico_batt: 'status.ico.batt'
    };

    function groupIcons() {
        var strip = $('status_div');
        if (!strip || strip.dataset.grouped === '1') { return; }
        strip.classList.add('sh-strip');
        GROUPS.forEach(function (g) {
            var box = document.createElement('span');
            box.className = 'sh-group';
            box.setAttribute('data-group', g.id);
            box.title = tr(g.title);
            tag(box, g.title, 'title');
            g.icons.forEach(function (id) {
                var img = $(id);
                if (!img) { return; }              // a missing icon is not fatal
                if (!img.title && TITLES[id]) { img.title = tr(TITLES[id]); tag(img, TITLES[id], 'title'); }
                box.appendChild(img);              // move, keep the same node
            });
            if (box.childNodes.length) { strip.appendChild(box); }
        });
        strip.dataset.grouped = '1';
        watchIcons(strip);
        pickReps();
    }

    /* the worst icon of a group = its representative on a narrow header */
    function rank(el) {
        if (el.id === 'ico_rain') { return 9; }      // the weather group has one icon
        var s = (el.getAttribute('src') || '').toLowerCase();
        if (/_red|_empty/.test(s)) { return 4; }
        if (/_orange|_14\./.test(s)) { return 3; }
        if (/_green|_full|_34|_half/.test(s)) { return 2; }
        return 1;                                   // grey / disabled = no data or off
    }
    function pickReps() {
        var strip = $('status_div');
        if (!strip) { return; }
        strip.querySelectorAll('.sh-group').forEach(function (g) {
            var best = null, br = -1;
            Array.prototype.forEach.call(g.children, function (c) {
                var r = rank(c);
                if (r > br) { br = r; best = c; }
            });
            Array.prototype.forEach.call(g.children, function (c) {
                if (c.classList.contains('sh-rep') !== (c === best)) { c.classList.toggle('sh-rep', c === best); }
            });
            g.dataset.tone = br >= 4 ? 'err' : (br === 3 ? 'warn' : (br === 2 ? 'ok' : 'off'));
        });
    }
    function watchIcons(strip) {
        if (!window.MutationObserver) { return; }
        var t = null;
        new MutationObserver(function () {
            if (t) { return; }
            t = setTimeout(function () { t = null; pickReps(); }, 120);
        }).observe(strip, {attributes: true, attributeFilter: ['src'], subtree: true});
    }

    /* ------------------------------------------------ system monitor */
    var TAU = 6;               // s — the smoothing of CPU and the network
    var AVG_S = 30;            // s — the CPU colour follows this average
    var BASE = [1, 1e3, 1e6, 1e9], UNITS = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
    var S = {
        ok: false, t: 0, cpu: null, cpuAvg: null, mem: null, disk: null, rx: null, tx: null,
        unit: {rx: 1, tx: 1}, hist: [], raw: null, freeTxt: '–', load: null
    };

    function tone(v, warn, err) {
        if (typeof v !== 'number' || !isFinite(v)) { return 'off'; }
        return v >= err ? 'err' : (v >= warn ? 'warn' : 'ok');
    }
    function worst(list) {
        var o = ['err', 'warn', 'ok'];
        for (var i = 0; i < o.length; i++) { if (list.indexOf(o[i]) >= 0) { return o[i]; } }
        return 'off';
    }
    function ema(prev, v, dt) {
        if (typeof v !== 'number' || !isFinite(v)) { return prev; }
        if (typeof prev !== 'number' || !isFinite(prev)) { return v; }
        var a = 1 - Math.exp(-Math.max(0.2, dt) / TAU);
        return prev + a * (v - prev);
    }
    /* value in a 3-character slot + a unit with hysteresis: up at 1000 of the
       unit, down under 0.9 of it (so 950 B/s ↔ 1.0 kB/s does not flicker) */
    function fmtRate(k, v) {
        if (typeof v !== 'number' || !isFinite(v)) { return ['–', '']; }
        var u = S.unit[k];
        while (u < BASE.length - 1 && v >= 1000 * BASE[u]) { u++; }
        while (u > 0 && v < 0.9 * BASE[u]) { u--; }
        S.unit[k] = u;
        var x = v / BASE[u];
        return [x < 10 ? x.toFixed(1) : String(Math.min(999, Math.round(x))), UNITS[u]];
    }
    function fmtPct(v) { return (typeof v === 'number' && isFinite(v)) ? String(Math.round(Math.max(0, Math.min(100, v)))) : '–'; }
    function fmtBytes(v) {
        if (typeof v !== 'number' || !isFinite(v)) { return '–'; }
        var u = 0, units = ['B', 'kB', 'MB', 'GB', 'TB'];
        while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
        return (v >= 100 || u === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[u];
    }

    function el(tagName, cls, txt) {
        var e = document.createElement(tagName);
        if (cls) { e.className = cls; }
        if (txt != null) { e.textContent = txt; }
        return e;
    }
    /* one metric in fixed slots: <small>CPU</small><n3>88</n3><u>%</u> */
    function pctItem(key, label, labelKey) {
        var s = el('span', 'sh-i');
        s.dataset.metric = key;
        var sm = el('small', null, labelKey ? tr(labelKey) : label);
        if (labelKey) { tag(sm, labelKey); }
        s.appendChild(sm);
        var n = el('span', 'sh-n3', '–');
        n.dataset.sh = key;
        s.appendChild(n);
        s.appendChild(el('u', 'sh-pc', '%'));
        return s;
    }
    function netItem(k) {
        var s = el('span', 'sh-i sh-net-' + k);
        s.appendChild(el('span', 'sh-arr ' + k, k === 'rx' ? '↓' : '↑'));
        var n = el('span', 'sh-n3', '–');
        n.dataset.sh = k;
        s.appendChild(n);
        var u = el('u', 'sh-unit', '');
        u.dataset.sh = k + 'U';
        s.appendChild(u);
        return s;
    }
    var CHIP_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1.6"/><path d="M6 1.3v2.2M10 1.3v2.2M6 12.5v2.2M10 12.5v2.2M1.3 6h2.2M1.3 10h2.2M12.5 6h2.2M12.5 10h2.2"/></g><rect x="6.3" y="6.3" width="3.4" height="3.4" fill="currentColor"/></svg>';

    var monitor = null, chip = null, card = null;
    function buildMonitor() {
        var row = document.querySelector('#div_menu .vt-hdr-row');
        if (!row) { return null; }
        if (!monitor) {
            monitor = el('button', 'sh-sys is-offline');
            monitor.type = 'button';
            monitor.id = 'system_monitor_header';
            monitor.setAttribute('aria-haspopup', 'dialog');
            monitor.setAttribute('aria-expanded', 'false');
            monitor.appendChild(pctItem('cpu', 'CPU'));
            monitor.appendChild(pctItem('mem', 'RAM', 'status.sys.mem'));
            var net = el('span', 'sh-netbox');
            net.appendChild(netItem('rx'));
            net.appendChild(netItem('tx'));
            monitor.appendChild(net);
            monitor.addEventListener('click', function (e) { e.stopPropagation(); toggleCard(monitor); });
            chip = el('button', 'vt-hdr-tb sh-chip');
            chip.type = 'button';
            chip.id = 'btn_sys_chip';
            chip.setAttribute('aria-haspopup', 'dialog');
            chip.setAttribute('aria-expanded', 'false');
            chip.innerHTML = CHIP_SVG;
            chip.addEventListener('click', function (e) { e.stopPropagation(); toggleCard(chip); });
            card = buildCard('sh_sys_card');
            card.hidden = true;
            document.body.appendChild(card);
            document.addEventListener('click', function (e) {
                if (!card.hidden && !card.contains(e.target)) { closeCard(); }
            });
            document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeCard(); } });
            window.addEventListener('resize', function () { if (!card.hidden) { placeCard(); } });
        }
        if (monitor.parentNode !== row) { row.appendChild(monitor); }
        if (chip.parentNode !== row) { row.appendChild(chip); }
        return monitor;
    }

    /* the card (also the ⋯ menu's system section on a phone) */
    function ring(key, labelKey, label) {
        var s = el('span', 'sh-rg');
        var i = el('i', 'sh-ring');
        i.dataset.ring = key;
        var b = el('b');
        var n = el('span', 'sh-n3', '–');
        n.dataset.sh = key === 'cpu' ? 'cpu' : key;
        b.appendChild(n);
        i.appendChild(b);
        s.appendChild(i);
        var sm = el('small', null, labelKey ? tr(labelKey) : label);
        if (labelKey) { tag(sm, labelKey); }
        s.appendChild(sm);
        return s;
    }
    function buildCard(id) {
        var c = el('div', 'sh-card');
        if (id) { c.id = id; c.setAttribute('role', 'dialog'); }
        var h = el('div', 'sh-card-h');
        var ht = el('span', 'sh-card-t', tr('status.sys.card.title'));
        tag(ht, 'status.sys.card.title');
        h.appendChild(ht);
        var age = el('span', 'sh-card-age', '');
        age.dataset.sh = 'age';
        h.appendChild(age);
        c.appendChild(h);
        var rings = el('div', 'sh-rings');
        rings.appendChild(ring('cpu', null, 'CPU'));
        rings.appendChild(ring('mem', 'status.sys.mem', 'RAM'));
        rings.appendChild(ring('disk', 'status.sys.disk', 'DISK'));
        c.appendChild(rings);
        var nl = el('div', 'sh-netl');
        var nk = el('small', null, tr('status.sys.net'));
        tag(nk, 'status.sys.net');
        nl.appendChild(nk);
        nl.appendChild(netItem('rx'));
        nl.appendChild(netItem('tx'));
        c.appendChild(nl);
        var note = el('div', 'sh-card-note', '');
        note.dataset.sh = 'note';
        c.appendChild(note);
        var a = el('button', 'sh-card-link', tr('status.sys.card.diag'));
        a.type = 'button';
        tag(a, 'status.sys.card.diag');
        a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeCard(); openDiag(); });
        c.appendChild(a);
        return c;
    }
    function openDiag() {
        if (window.VTHeader && window.VTHeader.closeMenu) { window.VTHeader.closeMenu(); }
        var drawer = $('ui_drawer');
        var cfg = $('div_menu_config');
        var shown = cfg && cfg.style.display !== 'none' && drawer && drawer.classList.contains('open');
        var b = $('btn_settings');
        if (!shown && b) { b.click(); }
        setTimeout(function () {
            var t = document.querySelector('a[href="#tab_diag"]');
            if (t) { t.click(); }
        }, 80);
    }
    var cardFrom = null;
    function toggleCard(from) {
        if (!card) { return; }
        if (!card.hidden && cardFrom === from) { closeCard(); return; }
        if (window.VTHeader && window.VTHeader.closeMenu) { window.VTHeader.closeMenu(); }
        cardFrom = from;
        card.hidden = false;
        [monitor, chip].forEach(function (b) { if (b) { b.setAttribute('aria-expanded', b === from ? 'true' : 'false'); } });
        placeCard();
        paint();
    }
    function closeCard() {
        if (!card || card.hidden) { return; }
        card.hidden = true;
        [monitor, chip].forEach(function (b) { if (b) { b.setAttribute('aria-expanded', 'false'); } });
    }
    function placeCard() {
        if (!cardFrom) { return; }
        var r = cardFrom.getBoundingClientRect();
        var w = card.offsetWidth || 248;
        var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
        card.style.left = Math.round(left) + 'px';
        card.style.top = Math.round(r.bottom + 6) + 'px';
    }

    /* ------------------------------------------------ paint */
    function setAll(key, fn) {
        document.querySelectorAll('[data-sh="' + key + '"]').forEach(fn);
    }
    function setText(key, txt) { setAll(key, function (e) { if (e.textContent !== txt) { e.textContent = txt; } }); }
    function paint() {
        var off = !S.ok;
        var cpuT = tone(S.cpuAvg, 90, 97), memT = tone(S.mem, 90, 97), diskT = tone(S.disk, 90, 97);
        setText('cpu', fmtPct(S.cpu));
        setText('mem', fmtPct(S.mem));
        setText('disk', fmtPct(S.disk));
        var rx = fmtRate('rx', S.rx), tx = fmtRate('tx', S.tx);
        setText('rx', rx[0]);
        setText('rxU', rx[1]);
        setText('tx', tx[0]);
        setText('txU', tx[1]);
        document.querySelectorAll('.sh-i[data-metric="cpu"]').forEach(function (e) { e.dataset.st = off ? 'off' : cpuT; });
        document.querySelectorAll('.sh-i[data-metric="mem"]').forEach(function (e) { e.dataset.st = off ? 'off' : memT; });
        document.querySelectorAll('.sh-ring[data-ring]').forEach(function (e) {
            var k = e.dataset.ring;
            var v = k === 'cpu' ? S.cpu : (k === 'mem' ? S.mem : S.disk);
            var tn = off ? 'off' : (k === 'cpu' ? cpuT : (k === 'mem' ? memT : diskT));
            e.style.setProperty('--sh-pct', ((typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : 0) * 3.6) + 'deg');
            e.dataset.state = tn;
        });
        var chipT = off ? 'off' : worst([cpuT, memT, diskT]);
        if (chip) {
            chip.dataset.state = chipT;
            var tip = chipTip();
            if (chip.title !== tip) { chip.title = tip; chip.setAttribute('aria-label', tip); }
        }
        if (monitor) {
            monitor.classList.toggle('is-offline', off);
            var mt = chipTip();
            if (monitor.title !== mt) { monitor.title = mt; monitor.setAttribute('aria-label', mt); }
        }
        setText('age', S.t ? new Date(S.t).toLocaleTimeString(window.VTI18n ? VTI18n.lang() : undefined) : '');
        setText('note', off ? tr('status.sys.offline') :
            tr('status.sys.card.note', {avg: fmtPct(S.cpuAvg), load: S.load == null ? '–' : S.load, free: S.freeTxt}));
        if (window.VTHeader && window.VTHeader.sysTone) { window.VTHeader.sysTone(chipT); }
    }
    function chipTip() {
        if (!S.ok) { return tr('status.sys.offline'); }
        var rx = fmtRateNoHyst(S.rx), tx = fmtRateNoHyst(S.tx);
        return tr('status.sys.chip.tip', {cpu: fmtPct(S.cpu), avg: fmtPct(S.cpuAvg), mem: fmtPct(S.mem),
                                          disk: fmtPct(S.disk), rx: rx, tx: tx});
    }
    function fmtRateNoHyst(v) {
        if (typeof v !== 'number' || !isFinite(v)) { return '–'; }
        var u = 0;
        while (u < BASE.length - 1 && v >= 1000 * BASE[u]) { u++; }
        var x = v / BASE[u];
        return (x < 10 ? x.toFixed(1) : String(Math.round(x))) + ' ' + UNITS[u];
    }

    function take(d) {
        var now = Date.now();
        var dt = S.t ? (now - S.t) / 1000 : 2;
        var cpu = d && d.cpu || {}, mem = d && d.mem || {}, disk = d && d.disk || {}, net = d && d.net || {};
        S.cpu = ema(S.cpu, cpu.percent, dt);
        if (typeof cpu.percent === 'number' && isFinite(cpu.percent)) {
            S.hist.push([now, cpu.percent]);
        }
        while (S.hist.length && now - S.hist[0][0] > AVG_S * 1000) { S.hist.shift(); }
        S.cpuAvg = S.hist.length ? S.hist.reduce(function (a, x) { return a + x[1]; }, 0) / S.hist.length : null;
        S.mem = (typeof mem.percent === 'number') ? mem.percent : null;
        S.disk = (typeof disk.percent === 'number') ? disk.percent : null;
        S.rx = ema(S.rx, net.rx_bytes_s, dt);
        S.tx = ema(S.tx, net.tx_bytes_s, dt);
        S.load = cpu.load_1m == null ? null : cpu.load_1m;
        S.freeTxt = fmtBytes(disk.free_bytes);
        S.t = now;
        S.ok = true;
        paint();
    }

    function pollSystem() {
        buildMonitor();
        // Same-origin: served by the robot's own webnode (:7779), so the
        // monitor works from the shipped UI without the agent bridge (:8088).
        fetch('/api/system', {cache: 'no-store'}).then(function (response) {
            if (!response.ok) { throw new Error('HTTP ' + response.status); }
            return response.json();
        }).then(take).catch(function () {
            S.ok = false;
            paint();
        }).finally(function () {
            window.setTimeout(pollSystem, 2000);
        });
    }

    function relayout() {
        groupIcons();
        buildMonitor();
        if (window.innerWidth >= SHEET_MAX_W) { toHeader(); } else { toMap(); }
    }

    var t = null;
    function onResize() {
        if (t) { clearTimeout(t); }
        t = setTimeout(relayout, 60);
    }

    /* the ⋯ menu (phones) shows the card's content as one of its sections */
    window.VTSys = {
        section: function () { var c = buildCard(null); c.classList.add('sh-card-inline'); paint(); return c; },
        paint: paint,
        closeCard: closeCard,
        reps: pickReps
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { relayout(); pollSystem(); });
    } else { relayout(); pollSystem(); }
    window.addEventListener('resize', onResize);
    if (window.VTI18n) { VTI18n.onChange(function () { paint(); }); }
    /* Widget styling lives in assets/css/status_header.css. */
})();
