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
   The <img> nodes are MOVED, never recreated: map_view.js swaps their `src`
   by id.  D8 (2026-11-08, audit H1): each <img> sits hidden in a .sh-ico box
   that draws a line icon in the colour of its state (read from the file
   name); the state is also in words (tooltip, aria-label) and warning /
   fault add a corner dot.  The groups except the weather are one button
   (#btn_status_card) that opens the status card (#sh_status_card: every icon,
   its name and state in words, how old the data is).  On a phone held
   upright the row is a summary: one icon per group + "All OK" / "2 warnings".
   No link to the robot or no icon_status for 10 s = the icons are only the
   last known state: grey, "no live data" over them, "since …" in the tips.

   System monitor (#system_monitor_header): CPU · RAM · ↓ ↑ of the robot's
   computer in FIXED slots — Roboto tabular figures, a percentage in a 3ch
   slot + "%", a network value in a 3ch slot + its unit in a 2.9em box, so
   the block keeps ONE width whatever the numbers do; how much of it shows
   (↓ ↑, ↓ only, the chip) is measured against the room in the header row
   (D8, audit H2: fitMonitor).  Values are smoothed (EMA ~6 s) and the network unit has a
   hysteresis (up at 1000, down under 900).  Colours warn only when it is
   needed: CPU by its 30-s AVERAGE (≥ 90 % amber, ≥ 97 % red), RAM / disk
   by their value (≥ 90 / ≥ 97 %), never by a momentary spike.
   When the row has no room the block becomes a chip (#btn_sys_chip, one icon
   in the worst colour); a click on either opens the card (#sh_sys_card) with
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
    function tn(k, n) { return window.VTI18n && VTI18n.tn ? VTI18n.tn(k, n, {n: n}) : k; }
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

    /* D8 (audit H1): line pictograms instead of the blurry 15-20 px Nextion
       PNGs. The <img> stays (hidden) inside its .sh-ico box: map_view.js
       still swaps its `src` by id (the robot's icon_status, 2 Hz) and this
       file reads the state from that file name — green / orange / red /
       grey, battery level + CHARGE. The box draws a 24-unit line icon in
       currentColor; the colour is the tone, and the state is also said in
       words (tooltip, aria-label, the status card) and, for warning / fault,
       by a dot in the corner (hollow = warning, full = fault), so the meaning
       does not hang on the colour alone. */
    var G = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
    var GE = '</g></svg>';
    var CHIP = '<rect x="14.5" y="14.5" width="7" height="7" rx="1.2" stroke-width="1.7"/>' +
               '<path d="M16.8 12.6v1.6M19.2 12.6v1.6M12.6 16.8h1.6M12.6 19.2h1.6" stroke-width="1.5"/>';
    var THERMO = '<path d="M7 13.6V5a2.5 2.5 0 0 1 5 0v8.6a4.3 4.3 0 1 1-5 0z"/><path d="M9.5 9v7.2"/>';
    var BLADE = '<ellipse cx="12" cy="6.3" rx="2.7" ry="3.9" stroke-width="1.8"/>';
    var FAN = BLADE + '<g transform="rotate(120 12 12)">' + BLADE + '</g><g transform="rotate(240 12 12)">' + BLADE + '</g>' +
              '<circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/>';
    var SVG = {
        wifi: '<path d="M2.6 9.2a13.6 13.6 0 0 1 18.8 0"/><path d="M5.9 12.7a8.9 8.9 0 0 1 12.2 0"/>' +
              '<path d="M9.2 16.2a4.3 4.3 0 0 1 5.6 0"/><circle cx="12" cy="19.6" r="1.4" fill="currentColor" stroke="none"/>',
        gps: '<path d="M12 21.2s-6.6-6-6.6-11.1a6.6 6.6 0 0 1 13.2 0c0 5.1-6.6 11.1-6.6 11.1z"/><circle cx="12" cy="10.1" r="2.3"/>',
        gps_nav: '<circle cx="12" cy="12" r="9"/><path d="M15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z" fill="currentColor" stroke-width="1.4"/>',
        imu: '<path d="M12 12.6V3.6M12 12.6l-7.6 4.6M12 12.6l7.6 4.6"/><path d="M9.6 5.8L12 3.4l2.4 2.4" stroke-width="1.7"/>' +
             '<circle cx="12" cy="12.6" r="1.9" fill="currentColor" stroke="none"/>',
        /* the lidar: the sensor, its beam and the scanned circle */
        lidar: '<circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="12" r="8.8" stroke-dasharray="2.3 2.7" stroke-width="1.7"/>' +
               '<path d="M13.9 10.1l4.9-4.9"/>',
        camera: '<path d="M4.2 7.8h2.9l1.7-2.5h6.4l1.7 2.5h2.9a1.2 1.2 0 0 1 1.2 1.2v9.2a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 18.2V9a1.2 1.2 0 0 1 1.2-1.2z"/>' +
                '<circle cx="12" cy="13.3" r="3.4"/>',
        /* the mower: its two-blade rotor over the grass */
        mower: '<path d="M2.8 7.5h18.4" stroke-width="2.2"/><circle cx="12" cy="7.5" r="2.3" fill="currentColor" stroke="none"/>' +
               '<path d="M5.2 20.6c0-2.6.6-4.4 1.9-5.8M9.6 20.6c0-3.1.4-5.2 1.3-7M14.4 20.6c.2-2.7-.3-4.8-1.3-6.4M18.8 20.6c.1-2.4-.5-4.2-1.8-5.5" stroke-width="1.7"/>',
        temp: THERMO + '<path d="M15 6.5h4.5M15 10.2h3M15 13.9h4.5" stroke-width="1.7"/>',
        temp_pcb: '<g transform="translate(-2.5 -1.2)">' + THERMO + '</g>' + CHIP,
        fan: FAN,
        fan_pcb: '<g transform="translate(-2.2 -2.2) scale(.8)">' + FAN + '</g>' + CHIP,
        supply: '<path d="M9 3v5M15 3v5"/><path d="M6.4 8h11.2v3.2a5.6 5.6 0 0 1-11.2 0z"/><path d="M12 16.8v4.4"/>'
    };
    /* the robot from above, front up: the wheel of this motor is filled */
    var WHEELS = {fl: [3, 4.5], fr: [17.8, 4.5], rl: [3, 14], rr: [17.8, 14]};
    function motorSvg(which) {
        var s = '<rect x="7.5" y="3.5" width="9" height="17" rx="2.2" stroke-width="1.7"/>';
        Object.keys(WHEELS).forEach(function (k) {
            var p = WHEELS[k];
            s += k === which
                ? '<rect x="' + p[0] + '" y="' + p[1] + '" width="3.2" height="5.5" rx="1" fill="currentColor" stroke="none"/>'
                : '<rect x="' + (p[0] + 0.5) + '" y="' + (p[1] + 0.5) + '" width="2.2" height="4.5" rx=".8" stroke-width="1.2" opacity=".5"/>';
        });
        return G + s + GE;
    }
    /* the battery: 0-4 bars = the level the robot reports; a flash while it
       charges (knocked out of the bars by an outline in the frame colour) */
    function battSvg(st) {
        var s = '<rect x="2" y="6.5" width="17.6" height="11" rx="2.2"/><path d="M21.8 10.2v3.6"/>';
        for (var i = 0; i < Math.max(0, st.lvl); i++) {
            s += '<rect x="' + (4.3 + i * 3.6) + '" y="9" width="2.6" height="6" rx=".5" fill="currentColor" stroke="none"/>';
        }
        if (st.chg) {
            s += '<path d="M12.6 4.2L8.4 12.6h3.6l-1.3 7.2 5-9.3h-3.7z" fill="currentColor" stroke="var(--vt-frame-bg, #282b30)" stroke-width="1.6"/>';
        }
        return G + s + GE;
    }
    var KIND = {
        ico_wifi: {svg: 'wifi', st: 'wifi'}, ico_gps: {svg: 'gps', st: 'gnss'},
        ico_gps_nav: {svg: 'gps_nav', st: 'gnss'}, ico_imu: {svg: 'imu', st: 'onoff'},
        ico_lidar: {svg: 'lidar', st: 'onoff'}, ico_camera: {svg: 'camera', st: 'onoff'},
        ico_mower: {svg: 'mower', st: 'mower'},
        ico_fl_motor: {motor: 'fl', st: 'heat'}, ico_fr_motor: {motor: 'fr', st: 'heat'},
        ico_rl_motor: {motor: 'rl', st: 'heat'}, ico_rr_motor: {motor: 'rr', st: 'heat'},
        ico_temp_pcb: {svg: 'temp_pcb', st: 'heat'}, ico_fan_pcb: {svg: 'fan_pcb', st: 'fan'},
        ico_temp: {svg: 'temp', st: 'heat'}, ico_fan: {svg: 'fan', st: 'fan'},
        ico_supply: {svg: 'supply', st: 'supply'}, ico_batt: {batt: true, st: 'batt'}
    };
    var LVL = {full: 4, '34': 3, half: 2, '14': 1, empty: 0, disabled: -1};
    var BATT_K = ['status.d8.st.batt.l0', 'status.d8.st.batt.l1', 'status.d8.st.batt.l2',
                  'status.d8.st.batt.l3', 'status.d8.st.batt.l4'];
    /* the state from the file name map_view.js set (the same rules the PNGs
       had: the four colours live in the file names, UI_FIELD_STYLE §8) */
    function stateOf(img) {
        var s = (img.getAttribute('src') || '').toLowerCase();
        var m = /batt(charge)?_(full|34|half|14|empty|disabled)\./.exec(s);
        if (m) {
            var lvl = LVL[m[2]];
            return {tone: lvl < 0 ? 'off' : (lvl === 0 ? 'err' : (lvl === 1 ? 'warn' : 'ok')),
                    lvl: lvl, chg: !!m[1] && lvl >= 0};
        }
        if (/_red\./.test(s)) { return {tone: 'err'}; }
        if (/_orange\./.test(s)) { return {tone: 'warn'}; }
        if (/_green\./.test(s)) { return {tone: 'ok'}; }
        return {tone: 'off'};
    }
    /* the state in words: status.d8.st.<kind>.<tone>, the battery by level */
    function stateWords(id, st) {
        var k = KIND[id];
        if (!k) { return ''; }
        if (k.batt) {
            if (st.lvl < 0) { return tr('status.d8.st.batt.off'); }
            var w = tr(BATT_K[st.lvl] || BATT_K[0]);
            return st.chg ? tr('status.d8.st.batt.chg', {level: w}) : w;
        }
        return tr('status.d8.st.' + k.st + '.' + st.tone);
    }

    var boxes = {};           // id -> {box, img, st, key}
    var btn = null;           // the button over the non-weather groups (opens the card)
    function wrapIcon(img, id) {
        var box = document.createElement('span');
        box.className = 'sh-ico';
        box.dataset.ico = id.replace(/^ico_/, '');
        box.setAttribute('role', 'img');
        img.parentNode.insertBefore(box, img);
        box.appendChild(img);                  // the same node: map_view.js keeps swapping its src
        var k = KIND[id];
        if (k.motor) { box.insertAdjacentHTML('afterbegin', motorSvg(k.motor)); }
        else if (k.svg) { box.insertAdjacentHTML('afterbegin', G + SVG[k.svg] + GE); }
        boxes[id] = {box: box, img: img, st: null, key: ''};
        return box;
    }

    function groupIcons() {
        var strip = $('status_div');
        if (!strip || strip.dataset.grouped === '1') { return; }
        strip.classList.add('sh-strip');
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'btn_status_card';
        btn.className = 'sh-open';
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.setAttribute('aria-expanded', 'false');
        GROUPS.forEach(function (g) {
            var box = document.createElement('span');
            box.className = 'sh-group';
            box.setAttribute('data-group', g.id);
            if (g.id === 'weather') {          // the cloud keeps its own click (rain radar)
                box.title = tr(g.title);
                tag(box, g.title, 'title');
            }
            g.icons.forEach(function (id) {
                var img = $(id);
                if (!img) { return; }              // a missing icon is not fatal
                box.appendChild(img);              // move, keep the same node
                if (img.tagName === 'IMG' && KIND[id]) { wrapIcon(img, id); }
            });
            if (!box.childNodes.length) { return; }
            if (g.id === 'weather') { strip.appendChild(box); } else { btn.appendChild(box); }
        });
        // phone upright: the summary in words; anywhere: the "no live data" mark
        var sum = document.createElement('span');
        sum.className = 'sh-sum';
        btn.appendChild(sum);
        var stale = document.createElement('span');
        stale.className = 'sh-stale-tag';
        btn.appendChild(stale);
        strip.appendChild(btn);
        btn.addEventListener('click', function (e) { e.stopPropagation(); toggleStatus(); });
        strip.dataset.grouped = '1';
        watchIcons(strip);
        watchLink();
        pickReps();
    }

    /* the worst icon of a group = its representative on a narrow header */
    var RANK = {err: 4, warn: 3, ok: 2, off: 1};
    function rank(el) {
        if (el.id === 'ico_rain') { return 9; }      // the weather group has one icon
        var id = el.classList.contains('sh-ico') && el.querySelector('img') ? el.querySelector('img').id : el.id;
        var b = boxes[id];
        return b && b.st ? RANK[b.st.tone] : 1;
    }
    function rainTone() {
        var w = $('ico_rain_warn'), d = $('ico_rain_danger'), o = $('ico_rain_ok');
        var shown = function (e) { return e && e.style.display !== 'none'; };
        return shown(d) ? 'err' : (shown(w) ? 'warn' : (shown(o) ? 'ok' : 'off'));
    }

    /* freshness: the robot sends icon_status twice a second and map_view.js
       sets every src on each message (a mutation even when it is the same
       file). No message for STALE_MS, or no link to the robot = the icons are
       the LAST KNOWN state: they go grey with "no live data" over them. */
    var STALE_MS = 10000;
    var lastData = 0, link = 'connecting', wasStale = null;
    function isStale() { return link !== 'connected' || !lastData || Date.now() - lastData > STALE_MS; }
    function clock(t) { return t ? new Date(t).toLocaleTimeString(window.VTI18n ? VTI18n.lang() : undefined) : ''; }
    function watchLink() {
        var c = $('conn_status');
        if (c && c.getAttribute('data-state')) { link = c.getAttribute('data-state'); }
        var set = function (s) { return function () { link = s; paintIcons(); }; };
        document.addEventListener('rosconnected', set('connected'));
        document.addEventListener('rosconnecting', set('connecting'));
        document.addEventListener('rosdisconnected', set('disconnected'));
        setInterval(function () { if (isStale() !== wasStale) { paintIcons(); } }, 1000);
    }

    function paintIcons() {
        var strip = $('status_div');
        if (!strip || !btn) { return; }
        var stale = isStale();
        var since = clock(lastData);
        var nWarn = 0, nErr = 0;
        Object.keys(boxes).forEach(function (id) {
            var b = boxes[id], st = stateOf(b.img);
            var name = tr(TITLES[id] || id), words = stateWords(id, st);
            var tip = !lastData ? tr('status.d8.tip_never', {name: name})
                : (stale ? tr('status.d8.tip_stale', {name: name, state: words, time: since})
                         : tr('status.d8.tip', {name: name, state: words}));
            var key = st.tone + '|' + st.lvl + '|' + st.chg + '|' + tip;
            b.st = st;
            if (st.tone === 'warn') { nWarn++; }
            if (st.tone === 'err') { nErr++; }
            if (key === b.key) { return; }        // redraw on change only (2 Hz)
            b.key = key;
            b.box.dataset.tone = st.tone;
            if (KIND[id].batt) {
                var old = b.box.querySelector('svg');
                if (old) { old.remove(); }
                b.box.insertAdjacentHTML('afterbegin', battSvg(st));
            }
            b.box.title = tip;
            b.box.setAttribute('aria-label', tip);
        });
        var rt = rainTone();
        strip.classList.toggle('sh-stale', stale);
        strip.classList.toggle('sh-calm', !stale && !nWarn && !nErr && rt !== 'warn' && rt !== 'err');
        // the summary (phone upright) and the button's own name
        var sumK, sumTone;
        if (stale) { sumK = tr('status.d8.sum.stale'); sumTone = 'off'; }
        else if (nErr) { sumK = tn('status.d8.sum.err', nErr); sumTone = 'err'; }
        else if (nWarn) { sumK = tn('status.d8.sum.warn', nWarn); sumTone = 'warn'; }
        else { sumK = tr('status.d8.sum.ok'); sumTone = 'ok'; }
        var sum = btn.querySelector('.sh-sum');
        if (sum.textContent !== sumK) { sum.textContent = sumK; }
        sum.dataset.tone = sumTone;
        var tag2 = btn.querySelector('.sh-stale-tag'), stTxt = tr('status.d8.stale');
        if (tag2.textContent !== stTxt) { tag2.textContent = stTxt; }
        var bl = tr('status.d8.open', {summary: sumK});
        if (btn.title !== bl) { btn.title = bl; btn.setAttribute('aria-label', bl); }
        wasStale = stale;
        pickReps();
        if (status && !status.hidden) { fillStatus(); }
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
        new MutationObserver(function (list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].target.tagName === 'IMG') { lastData = Date.now(); break; }
            }
            if (t) { return; }
            t = setTimeout(function () { t = null; paintIcons(); }, 120);
        }).observe(strip, {attributes: true, attributeFilter: ['src', 'style'], subtree: true});
        paintIcons();
    }

    /* ------------------------------------------------ the status card
       A click on the icons (or on the summary on a phone): every icon with its
       name and its state in words, grouped like the strip, and how old the
       data is. Read only — it only shows what the page already has. */
    var status = null, statusFrom = null;
    function buildStatus() {
        if (status) { return status; }
        status = el('div', 'sh-card sh-status-card');
        status.id = 'sh_status_card';
        status.setAttribute('role', 'dialog');
        status.hidden = true;
        status.addEventListener('click', function (e) { e.stopPropagation(); });
        document.body.appendChild(status);
        document.addEventListener('click', function (e) {
            if (!status.hidden && !status.contains(e.target)) { closeStatus(); }
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeStatus(); } });
        window.addEventListener('resize', function () { if (!status.hidden) { placeStatus(); } });
        return status;
    }
    function fillStatus() {
        var c = status, stale = isStale();
        c.textContent = '';
        c.classList.toggle('is-stale', stale);
        var h = el('div', 'sh-card-h');
        var t = el('span', 'sh-card-t', tr('status.d8.card.title'));
        h.appendChild(t);
        var age = el('span', 'sh-card-age', stale ? tr('status.d8.stale') : tr('status.d8.updated', {time: clock(lastData)}));
        if (stale) { age.dataset.tone = 'off'; }
        h.appendChild(age);
        var x = el('button', 'sh-card-x', '×');
        x.type = 'button';
        x.title = tr('common.close');
        x.setAttribute('aria-label', tr('common.close'));
        x.addEventListener('click', function (e) { e.stopPropagation(); closeStatus(); });
        h.appendChild(x);
        c.appendChild(h);
        if (stale) {
            c.appendChild(el('div', 'sh-card-note sh-st-note',
                lastData ? tr('status.d8.card.stale', {time: clock(lastData)}) : tr('status.d8.card.never')));
        }
        var list = el('div', 'sh-st-list');
        // the weather first, as in the strip
        var rt = rainTone();
        var rk = {ok: 'status.d8.rain.ok', warn: 'status.d8.rain.warn', err: 'status.d8.rain.err'}[rt] || 'status.d8.rain.off';
        list.appendChild(el('div', 'sh-st-g', tr('status.group.weather')));
        var rr = el('div', 'sh-st-row');
        var ri = el('span', 'sh-st-i');
        var rsvg = document.querySelector('#ico_rain svg:not([style*="none"])') || document.querySelector('#ico_rain_ok');
        if (rsvg) { ri.appendChild(rsvg.cloneNode(true)).removeAttribute('id'); ri.firstChild.style.display = ''; }
        ri.dataset.tone = rt;
        rr.appendChild(ri);
        rr.appendChild(el('span', 'sh-st-n', tr('status.group.weather')));
        var rs = el('span', 'sh-st-s', tr(rk));
        rs.dataset.tone = rt;
        rr.appendChild(rs);
        list.appendChild(rr);
        GROUPS.forEach(function (g) {
            if (g.id === 'weather') { return; }
            list.appendChild(el('div', 'sh-st-g', tr(g.title)));
            g.icons.forEach(function (id) {
                var b = boxes[id];
                if (!b) { return; }
                var st = b.st || stateOf(b.img);
                var row = el('div', 'sh-st-row');
                var ic = el('span', 'sh-st-i');
                var sv = b.box.querySelector('svg');
                if (sv) { ic.appendChild(sv.cloneNode(true)); }
                ic.dataset.tone = st.tone;
                row.appendChild(ic);
                row.appendChild(el('span', 'sh-st-n', tr(TITLES[id] || id)));
                var s = el('span', 'sh-st-s', stateWords(id, st));
                s.dataset.tone = st.tone;
                row.appendChild(s);
                list.appendChild(row);
            });
        });
        c.appendChild(list);
        c.appendChild(el('div', 'sh-card-note', tr('status.d8.card.help')));
    }
    function toggleStatus() {
        buildStatus();
        if (!status.hidden) { closeStatus(); return; }
        if (window.VTHeader && window.VTHeader.closeMenu) { window.VTHeader.closeMenu(); }
        closeCard();
        statusFrom = btn;
        fillStatus();
        status.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        placeStatus();
    }
    function closeStatus() {
        if (!status || status.hidden) { return; }
        status.hidden = true;
        if (btn) { btn.setAttribute('aria-expanded', 'false'); }
    }
    function placeStatus() {
        if (!statusFrom) { return; }
        var r = statusFrom.getBoundingClientRect();
        var w = status.offsetWidth || 300;
        var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
        status.style.left = Math.round(left) + 'px';
        status.style.top = Math.round(r.bottom + 4) + 'px';
        status.style.maxHeight = Math.max(160, window.innerHeight - r.bottom - 12) + 'px';
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
        closeStatus();
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
        fitMonitor();
    }

    /* D8 (audit H2): the system block shows as much as the header row has
       room for — measured, not guessed from the window width: CPU · RAM · ↓ ↑,
       then CPU · RAM · ↓ (body.sh-sys-rx), then the chip (body.sh-sys-chip).
       Its natural width is constant (fixed slots), so the choice changes only
       with the layout (resize, language, a header button arriving), never
       with a number. */
    function setBodyCls(c, on) { var b = document.body; if (b.classList.contains(c) !== !!on) { b.classList.toggle(c, !!on); } }
    function fitMonitor() {
        var body = document.body, row = document.querySelector('#div_menu .vt-hdr-row');
        if (!monitor || !row || !body || !body.classList.contains('vt-h-pc')) { return; }
        var cs = getComputedStyle(row);
        var avail = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        Array.prototype.forEach.call(row.children, function (c) {
            if (c === monitor || c === chip || c.classList.contains('vt-hdr-fill')) { return; }
            var s = getComputedStyle(c);
            if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed') { return; }
            avail -= c.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight);
        });
        // the natural widths, every slot shown (no paint happens in between)
        var wasRx = body.classList.contains('sh-sys-rx'), wasChip = body.classList.contains('sh-sys-chip');
        body.classList.remove('sh-sys-rx', 'sh-sys-chip');
        var full = monitor.getBoundingClientRect().width;
        var tx = monitor.querySelector('.sh-net-tx');
        var txw = tx ? tx.getBoundingClientRect().width + 4 : 0;      // + the gap in .sh-netbox
        if (wasRx) { body.classList.add('sh-sys-rx'); }
        if (wasChip) { body.classList.add('sh-sys-chip'); }
        var GAP = 12;                                                  // air before the divider
        var v = avail >= full + GAP ? 'full' : (avail >= full - txw + GAP ? 'rx' : 'chip');
        setBodyCls('sh-sys-rx', v === 'rx');
        setBodyCls('sh-sys-chip', v === 'chip');
    }
    var fitT = null;
    function refit() { if (fitT) { clearTimeout(fitT); } fitT = setTimeout(function () { fitT = null; fitMonitor(); }, 80); }
    function watchRow() {
        var row = document.querySelector('#div_menu .vt-hdr-row');
        if (row && window.MutationObserver) { new MutationObserver(refit).observe(row, {childList: true}); }
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(refit); }
        setTimeout(refit, 1500);
        setTimeout(refit, 6000);           // the ? and the bell arrive late (other modules)
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
        closeCard: function () { closeCard(); closeStatus(); },
        reps: pickReps,
        fit: fitMonitor
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { relayout(); pollSystem(); watchRow(); });
    } else { relayout(); pollSystem(); watchRow(); }
    window.addEventListener('resize', onResize);
    if (window.VTI18n) { VTI18n.onChange(function () { paint(); paintIcons(); refit(); }); }
    /* Widget styling lives in assets/css/status_header.css. */
})();
