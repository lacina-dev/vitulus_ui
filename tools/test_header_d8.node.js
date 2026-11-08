#!/usr/bin/env node
/*
 * D8 header (2026-11-08, audit H1 / H2): the status line icons, the status
 * card, stale data and the measured system block.
 *
 *     node tools/test_header_d8.node.js
 *
 * 1) every icon file map_view.js sets on a header icon (icon_data) maps to a
 *    tone and to state words that exist in en.js and cs.js — the line icon
 *    never shows a state it cannot name;
 * 2) status_header.js only READS: no ROS, no write request — its one request
 *    is GET /api/system (the card and the icons only show what the page has);
 * 3) stale data is marked: the link events and the 10-s freshness are wired,
 *    the "no live data" keys exist;
 *    H8-2: the summary says "No warnings", never "all OK", and counts a grey
 *    GNSS / IMU / drive motor / battery as no data ("No warnings · 2 no data");
 * 4) H2: the system block is measured (fitMonitor), not cut by fixed widths.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TPL = path.join(__dirname, '..', 'nodes', 'templates');
const read = (f) => fs.readFileSync(path.join(TPL, f), 'utf8');
let fails = 0;
function ok(cond, what) { if (cond) { console.log('ok   ' + what); } else { fails++; console.log('FAIL ' + what); } }

const SH = read('assets/js/status_header.js');
const dict = {};
for (const lang of ['en', 'cs']) {
    const ctx = {window: {}};
    vm.createContext(ctx);
    vm.runInContext(read('assets/js/i18n/' + lang + '.js'), ctx);
    dict[lang] = ctx.window.VT_I18N_DICT[lang];
}

// ---- 1) the icon section in a sandbox (pure code, no DOM)
const a = SH.indexOf('    var G = '), b = SH.indexOf('    var boxes = {};');
// the summary uses the real en / cs texts (plural forms by Intl.PluralRules, as VTI18n.tn)
let LANG = 'en';
const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m0, k) => (v && k in v ? v[k] : m0));
ok(a > 0 && b > a, 'icon section found in status_header.js');
const used = new Set();
const ctx = {
    tr: (k, v) => { used.add(k); return LANG === 'key' ? k : fill(dict[LANG][k], v); },
    tn: (k, n) => { const c = new Intl.PluralRules(LANG === 'key' ? 'en' : LANG).select(n); const d = dict[LANG === 'key' ? 'en' : LANG];
                    used.add(k + '.other'); return fill(d[k + '.' + c] || d[k + '.other'], {n: n}); }
};
LANG = 'key';
vm.createContext(ctx);
vm.runInContext(SH.slice(a, b) + '\nthis.summarize = summarize; this.stateOf = stateOf; this.stateWords = stateWords; this.KIND = KIND;' +
                'this.motorSvg = motorSvg; this.battSvg = battSvg; this.SVG = SVG;', ctx);
const img = (src) => ({getAttribute: () => src});

// the files map_view.js IconStatus.icon_data sets on the HEADER icons (not *_conf)
const MV = read('assets/js/map_view.js');
const re = /this\.(ico_[a-z_]+)\.src = "([^"]+)"/g;
let m, n = 0;
const seen = {};
while ((m = re.exec(MV))) {
    const id = m[1], src = m[2];
    if (/_conf$/.test(id) || !ctx.KIND[id]) { continue; }
    n++;
    const st = ctx.stateOf(img(src));
    (seen[id] = seen[id] || new Set()).add(st.tone);
    if (!['ok', 'warn', 'err', 'off'].includes(st.tone)) { ok(false, id + ' ' + src + ' -> tone ' + st.tone); }
    ctx.stateWords(id, st);
}
ok(n >= 60, 'map_view.js sets ' + n + ' header icon files (all parsed)');
ok(Object.keys(ctx.KIND).every((id) => seen[id]), 'every header icon has states in map_view.js: ' + Object.keys(ctx.KIND).filter((id) => !seen[id]).join(',') + ' missing');
// examples with the meaning we promise in the help
const T = (src) => ctx.stateOf(img(src));
ok(T('/assets/img/robot_icons/Nextion_ico_gps_green.png').tone === 'ok', 'gps green = ok');
ok(T('/assets/img/robot_icons/Nextion_ico_motorRR_orange.png').tone === 'warn', 'motor orange = warn');
ok(T('/assets/img/robot_icons/Nextion_ico_mower_red.png').tone === 'err', 'mower red = err');
ok(T('/assets/img/robot_icons/Nextion_ico_wifi_grey.png').tone === 'off', 'wifi grey = off');
const bc = T('/assets/img/robot_icons/Nextion_ico_battCHARGE_half.png');
ok(bc.tone === 'ok' && bc.lvl === 2 && bc.chg === true, 'battery CHARGE half = ok, 2 bars, charging');
ok(T('/assets/img/robot_icons/Nextion_ico_batt_14.png').tone === 'warn', 'battery 1/4 = warn');
ok(T('/assets/img/robot_icons/Nextion_ico_batt_empty.png').tone === 'err', 'battery empty = err');
ok(T('/assets/img/robot_icons/Nextion_ico_batt_disabled.png').tone === 'off', 'battery disabled = off');
ok(T('').tone === 'off', 'no src = off');
// every state word the icons can show exists in en and cs
for (const id of Object.keys(ctx.KIND)) {
    for (const tone of ['ok', 'warn', 'err', 'off']) { ctx.stateWords(id, {tone: tone, lvl: tone === 'off' ? -1 : 2, chg: true}); }
}
for (let l = 0; l <= 4; l++) { ctx.stateWords('ico_batt', {tone: 'ok', lvl: l, chg: false}); }
const miss = {en: [], cs: []};
used.forEach((k) => { for (const lang of ['en', 'cs']) { if (!(k in dict[lang])) { miss[lang].push(k); } } });
ok(!miss.en.length, 'state words in en.js (' + used.size + ' keys) ' + miss.en.join(', '));
ok(!miss.cs.length, 'state words in cs.js ' + miss.cs.join(', '));
// the pictures: 24-unit line icons in currentColor, one per kind, the motor shows its wheel
const svgs = Object.keys(ctx.SVG).map((k) => ctx.SVG[k]).concat(['fl', 'fr', 'rl', 'rr'].map((w) => ctx.motorSvg(w)));
ok(svgs.every((s) => !/#[0-9a-f]{3,6}/i.test(s.replace(/var\(--vt-frame-bg, #282b30\)/g, ''))), 'icons use currentColor, no hard-coded colour');
ok(new Set(['fl', 'fr', 'rl', 'rr'].map((w) => ctx.motorSvg(w))).size === 4, 'each motor icon fills a different wheel');
ok(new Set([0, 1, 2, 3, 4].map((l) => ctx.battSvg({lvl: l}))).size === 5, 'battery icon shows 5 different levels');
ok(/<path d="M12.6 4.2/.test(ctx.battSvg({lvl: 2, chg: true})) && !/<path d="M12.6 4.2/.test(ctx.battSvg({lvl: 2, chg: false})), 'charging flash only while charging');

// ---- H8-2: the summary in words (real texts)
const ALL_OK = Object.keys(ctx.KIND).map((id) => ({id: id, tone: 'ok'}));
const withT = (ch) => ALL_OK.map((x) => ({id: x.id, tone: ch[x.id] || x.tone}));
const SUMS = [
    ['all green', {}, 'No warnings', 'Bez varování', 'ok'],
    ['lidar, camera, mower, fans off = normal', {ico_lidar: 'off', ico_camera: 'off', ico_mower: 'off', ico_fan: 'off', ico_fan_pcb: 'off'}, 'No warnings', 'Bez varování', 'ok'],
    ['2 motors DISABLED + IMU OFF + GNSS no data', {ico_fl_motor: 'off', ico_fr_motor: 'off', ico_imu: 'off', ico_gps: 'off'}, 'No warnings · 4 no data', 'Bez varování · 4 bez dat', 'off'],
    ['battery no data', {ico_batt: 'off'}, 'No warnings · 1 no data', 'Bez varování · 1 bez dat', 'off'],
    ['1 warning + GNSS-nav no data', {ico_rr_motor: 'warn', ico_gps_nav: 'off'}, '1 warning · 1 no data', '1 varování · 1 bez dat', 'warn'],
    ['2 warnings', {ico_rr_motor: 'warn', ico_batt: 'warn'}, '2 warnings', '2 varování', 'warn'],
    ['fault wins over warnings', {ico_mower: 'err', ico_batt: 'warn'}, '1 fault', '1 porucha', 'err'],
    ['3 faults', {ico_mower: 'err', ico_supply: 'err', ico_fl_motor: 'err'}, '3 faults', '3 poruchy', 'err'],
];
for (const [what, ch, en, cs, tone] of SUMS) {
    LANG = 'en'; const e = ctx.summarize(withT(ch), false);
    LANG = 'cs'; const c = ctx.summarize(withT(ch), false);
    ok(e.text === en && c.text === cs && e.tone === tone, 'summary: ' + what + ' -> "' + e.text + '" / "' + c.text + '" (' + e.tone + ')');
}
LANG = 'en';
ok(ctx.summarize(withT({ico_mower: 'err'}), true).text === 'No live data', 'summary: stale wins over everything');
ok(!/all ok|vše ok/i.test(dict.en['status.d8.sum.ok'] + dict.cs['status.d8.sum.ok']), 'summary never claims "all OK"');
LANG = 'key';

// ---- 2) read only
const code = SH.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/ROSLIB|\.publish\(|callService|advertise|sendBeacon|XMLHttpRequest|WebSocket/.test(code), 'status_header.js: no ROS, no beacon / XHR / socket');
const fetches = code.match(/fetch\([^)]*\)/g) || [];
ok(fetches.length === 1 && /fetch\('\/api\/system', \{cache: 'no-store'\}\)/.test(fetches[0]), 'status_header.js: one request, GET /api/system — ' + fetches.join(' | '));
ok(!/method\s*:/.test(code), 'status_header.js: no request method other than GET');

// ---- 3) stale data
ok(/'rosdisconnected'/.test(code) && /'rosconnected'/.test(code) && /'rosconnecting'/.test(code), 'link events wired (connected / connecting / disconnected)');
ok(/STALE_MS = 10000/.test(code) && /lastData = Date\.now\(\)/.test(code), 'freshness: icon_status older than 10 s = stale');
for (const k of ['status.d8.stale', 'status.d8.sum.stale', 'status.d8.tip_stale', 'status.d8.tip_never', 'status.d8.card.stale', 'status.d8.card.never']) {
    ok(k in dict.en && k in dict.cs, 'stale text ' + k + ' (en + cs)');
}
const CSS = read('assets/css/status_header.css');
ok(/\.sh-strip\.sh-stale \.sh-ico \{[^}]*opacity/.test(CSS) && /\.sh-strip\.sh-stale \.sh-stale-tag \{/.test(CSS), 'stale icons are greyed and labelled (CSS)');

// ---- 4) H2: measured system block
const HC = read('assets/css/vt_header.css');
ok(!/vt-h-w1600[^{]*system_monitor_header|vt-h-w1366[^{]*system_monitor_header/.test(HC), 'vt_header.css: no window-width rules for the system block');
ok(/body\.sh-sys-rx[^{]*\.sh-net-tx \{ display: none; \}/.test(HC) && /body\.sh-sys-chip[^{]*#btn_sys_chip \{ display: inline-grid; \}/.test(HC), 'vt_header.css: sh-sys-rx / sh-sys-chip');
ok(/#system_monitor_header\.sh-sys \{[^}]*width: auto;/.test(CSS), 'status_header.css: the block keeps its natural width');
ok(/function fitMonitor\(\)/.test(code) && /setBodyCls\('sh-sys-chip'/.test(code), 'status_header.js: fitMonitor chooses ↓ ↑ / ↓ / chip');

console.log(fails ? 'FAILED ' + fails : 'OK — D8 header checks passed');
process.exit(fails ? 1 : 0);
