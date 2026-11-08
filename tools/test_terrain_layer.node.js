#!/usr/bin/env node
/*
 * Map layer "Terrain (T10)" (assets/js/vt_terrain_layer.js, T29):
 *     node tools/test_terrain_layer.node.js
 *   - loaded by vt_map_layers.js (no index.html change), not by index.html;
 *   - sends nothing but subscribe / unsubscribe: no publish, service, HTTP write;
 *     the topic throttled (500 ms, queue 1), every listener off when unticked
 *     (roslib sends rosbridge the unsubscribe only then);
 *   - colours: 0 faint green, 1-49 green → yellow-green, 50-99 yellow → orange,
 *     100 red, -1 / others clear; other grids keep map_view.js getColor;
 *   - states: wait → nodata after NODATA_MS, ok, stale, nodata after a long gap;
 *   - costmap_reframe takes ~in / ~out with the old topics as defaults;
 *   - contract /traversability/ui v1 (t10-ui-kontrakt.md): parse (bad input ->
 *     null), reason colours (codes 0–7, 2 by cost), height colours, the PNG row
 *     order, the window and the zones into the map frame through map <- odom,
 *     no map -> not drawn ('notf'), the fallback grid only while the topic is
 *     silent (source), the views a source offers;
 *   - i18n keys in en + cs with the same placeholders.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const TPL = path.join(ROOT, 'nodes', 'templates');
const JS = path.join(TPL, 'assets', 'js');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !info ? '' : ' — ' + info)); if (!ok) { fails++; } }

const src = fs.readFileSync(path.join(JS, 'vt_terrain_layer.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
const layers = fs.readFileSync(path.join(JS, 'vt_map_layers.js'), 'utf8');
check('loaded by vt_map_layers.js, index.html unchanged', !html.includes('vt_terrain_layer.js') && layers.includes("sc.src = '/assets/js/vt_terrain_layer.js'"));
['fetch(', 'XMLHttpRequest', '.publish(', 'callService', 'sendBeacon', 'advertise'].forEach((w) => check('sends nothing: no ' + w, !code.includes(w)));
check('throttled topic, queue 1', /throttle_rate: THROTTLE_MS/.test(code) && /queue_length: 1/.test(code));
check('unticked: all listeners off (rosTopic.unsubscribe() without a callback)', /S\.client\.rosTopic\.unsubscribe\(\)/.test(code));
check('other grids keep their colours (wrapper calls the original)', /return orig\.call\(this, index, row, col, value\)/.test(code) && /this\.color\.vtTrav/.test(code));

const V = require(path.join(JS, 'vt_terrain_layer.js'));
check('throttle 500 ms, topic re-framed to map', V.THROTTLE_MS === 500 && V.TOPIC === '/traversability/local_costmap_map_framed');
const c = V.costColor;
check('0 = faint green', c(0)[1] > c(0)[0] && c(0)[3] < 128);
check('100 = red, strong', c(100)[0] > 200 && c(100)[1] < 80 && c(100)[3] > 200);
check('50..99 = yellow → orange (green falls)', c(50)[0] === 255 && c(99)[0] === 255 && c(99)[1] < c(50)[1]);
check('1..49 green family, not red', c(1)[1] > c(1)[0] && c(49)[1] >= c(49)[0] - 10);
check('unknown and out of range clear', c(-1)[3] === 0 && c(101)[3] === 0 && c(undefined)[3] === 0);
const S = V.state;
check('state: off / wait / nodata / ok / stale', S(1000, 0, 0) === 'off' && S(2000, 1000, 0) === 'wait' && S(1000 + V.NODATA_MS + 1, 1000, 0) === 'nodata' &&
      S(5000, 1000, 4500) === 'ok' && S(5000 + V.STALE_MS + 1, 1000, 5000) === 'stale' && S(5000 + V.NODATA_MS + 1, 1000, 5000) === 'nodata');

// ---- contract /traversability/ui
check('contract topic, throttled the same', V.TOPIC_UI === '/traversability/ui' && /name: TOPIC_UI, messageType: 'std_msgs\/String',\s*throttle_rate: THROTTLE_MS, queue_length: 1/.test(src));
const b64 = 'AAAA';
const good = { v: 1, stamp: 1, frame: 'odom', resolution: 0.05, width: 4, height: 2, origin: [10, 20],
               map: { frame: 'map', x: 1, y: 2, yaw: Math.PI / 2 }, reason: b64, cost: b64,
               zones: [[[10, 20], [11, 20], [11, 21]], [[0, 0]], 'x'] };
const p = V.parse(JSON.stringify(good));
check('parse: a good message', p && p.w === 4 && p.h === 2 && p.res === 0.05 && p.ox === 10 && p.map.yaw === Math.PI / 2 && p.elevation === null);
check('parse: only real polygons (>= 3 points) kept as zones', p && p.zones.length === 1);
check('parse: wrong version / missing PNG / bad size / garbage -> null',
      V.parse(JSON.stringify(Object.assign({}, good, { v: 2 }))) === null && V.parse(JSON.stringify(Object.assign({}, good, { cost: '' }))) === null &&
      V.parse(JSON.stringify(Object.assign({}, good, { width: 0 }))) === null && V.parse('{oops') === null && V.parse(null) === null);
const near = (a, b) => Math.abs(a - b) < 1e-9;
const pl = V.placement(p);
// window centre in odom (10.1, 20.05) turned by 90° and moved by (1, 2): (1 - 20.05, 2 + 10.1)
check('placement: the window centre into map through map <- odom', pl && near(pl.cx, 1 - 20.05) && near(pl.cy, 2 + 10.1) && near(pl.w, 0.2) && near(pl.h, 0.1) && near(pl.yaw, Math.PI / 2), JSON.stringify(pl));
const z = V.zonesToMap(p);
check('zones into map the same way', z.length === 1 && near(z[0][0][0], 1 - 20) && near(z[0][0][1], 2 + 10));
const pn = V.parse(JSON.stringify(Object.assign({}, good, { map: null })));
check('no map <- odom: no placement, state notf', V.placement(pn) === null && V.state(5000, 1000, 4900, pn) === 'notf');
check('reason colours: 0 clear, 1 faint green, 3 violet, 4 blue, 5 red, 6 grey-violet, 7 grey',
      V.reasonColor(0, 0)[3] === 0 && V.reasonColor(1, 0)[1] > V.reasonColor(1, 0)[0] && V.reasonColor(1, 0)[3] < 128 &&
      V.reasonColor(3, 100)[2] > V.reasonColor(3, 100)[1] && V.reasonColor(4, 100)[2] === 255 && V.reasonColor(5, 100)[0] > 200 &&
      V.reasonColor(7, 50)[0] === V.reasonColor(7, 50)[1] && V.reasonColor(9, 0)[3] === 0);
check('reason 2 runs yellow → orange with its cost', V.reasonColor(2, 99)[1] < V.reasonColor(2, 50)[1]);
check('cost 255 (unknown in the contract) clear', V.costColor(255)[3] === 0);
check('height: 0 unknown clear, below blue, above brown, saturates', V.heightColor(0)[3] === 0 && V.heightColor(128 - 15)[2] > V.heightColor(128 - 15)[0] &&
      V.heightColor(128 + 15)[0] > V.heightColor(128 + 15)[2] && JSON.stringify(V.heightColor(1)) === JSON.stringify(V.heightColor(128 - 15)));
const src2 = { reason: Uint8Array.from([1, 3]), cost: Uint8Array.from([0, 100]), elevation: null };
const rgba = V.colorize('reason', src2, 2);
check('colorize: one RGBA per cell in order, a view without data -> null',
      rgba && rgba.length === 8 && rgba[0] === 76 && rgba[4] === 156 && V.colorize('height', src2, 2) === null && !!V.colorize('cost', src2, 2));
check('source: ui first, the grid after FALLBACK_MS of silence, back to ui when it speaks',
      V.source(1000, 1000, 0) === 'ui' && V.source(1000 + V.FALLBACK_MS + 1, 1000, 0) === 'grid' &&
      V.source(9000, 1000, 8500) === 'ui' && V.source(8500 + V.FALLBACK_MS + 1, 1000, 8500) === 'grid' && V.source(5, 0, 0) === '');
check('the fallback grid is subscribed only while the contract topic is silent', /gridWanted\(source\(Date\.now\(\), S\.onAt, S\.uiRx\) === 'grid'\)/.test(src));
check('panel: views a source offers (grid = cost only)', /views = S\.src === 'grid' \? \{ reason: false, cost: true, height: false \}/.test(src));

check('hotfix 2: a silent subscription gets a SECOND one next to it (no unsubscribe first), 15 s → 30 s → 60 s, the one that delivers stays',
      V.RESUB_MS === 15000 && V.OVERLAP_MS >= 10000 && /S\.uiOld\.push\(S\.uiSub\);[\s\S]{0,80}S\.uiSub = uiTopic\(\)/.test(src) &&
      /S\.uiWait = Math\.min\(RESUB_MAX_MS, S\.uiWait \* 2\)/.test(src) && /if \(raw && raw === S\.lastRaw\) \{ return; \}/.test(src) &&
      !/S\.uiSub\.unsubscribe\(\);\s*\n\s*S\.uiSub = new ROSLIB\.Topic/.test(src));
const relay = fs.readFileSync(path.join(ROOT, 'nodes', 'costmap_reframe'), 'utf8');
check('costmap_reframe: ~in / ~out, defaults as before', /get_param\('~out', '\/local_costmap_map_framed'\)/.test(relay) &&
      /get_param\('~in', '\/move_base_flex\/local_costmap\/costmap_slow'\)/.test(relay));

const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = win.VT_I18N_DICT;
const keys = new Set([...src.matchAll(/t\('(trav\.[a-z_.]+)'/g), ...layers.matchAll(/t\('(trav\.[a-z_.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
['off', 'wait', 'ok', 'stale', 'nodata', 'noros', 'paused'].forEach((s) => keys.add('trav.st.' + s));
['nodata', 'stale', 'noros', 'notf'].forEach((s) => keys.add('trav.why.' + s));
['notf'].forEach((s) => keys.add('trav.st.' + s));
['reason', 'cost', 'height'].forEach((m) => keys.add('trav.mode.' + m));
Object.values(V.REASON_KEYS).forEach((k) => keys.add('trav.r.' + k));
const miss = [...keys].filter((k) => !(k in D.en) || !(k in D.cs));
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
check('trav.* keys in en + cs (' + keys.size + ')', !miss.length, miss.join(', '));
check('same placeholders en / cs', [...keys].every((k) => !(k in D.en) || ph(D.en[k]) === ph(D.cs[k])));
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
