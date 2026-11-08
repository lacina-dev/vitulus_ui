#!/usr/bin/env node
/*
 * Map layer "Terrain (T10)" (assets/js/vt_terrain_layer.js, T29 quick version):
 *     node tools/test_terrain_layer.node.js
 *   - loaded by vt_map_layers.js (no index.html change), not by index.html;
 *   - sends nothing but subscribe / unsubscribe: no publish, service, HTTP write;
 *     the topic throttled (500 ms, queue 1), every listener off when unticked
 *     (roslib sends rosbridge the unsubscribe only then);
 *   - colours: 0 faint green, 1-49 green → yellow-green, 50-99 yellow → orange,
 *     100 red, -1 / others clear; other grids keep map_view.js getColor;
 *   - states: wait → nodata after NODATA_MS, ok, stale, nodata after a long gap;
 *   - costmap_reframe takes ~in / ~out with the old topics as defaults;
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

const relay = fs.readFileSync(path.join(ROOT, 'nodes', 'costmap_reframe'), 'utf8');
check('costmap_reframe: ~in / ~out, defaults as before', /get_param\('~out', '\/local_costmap_map_framed'\)/.test(relay) &&
      /get_param\('~in', '\/move_base_flex\/local_costmap\/costmap_slow'\)/.test(relay));

const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = win.VT_I18N_DICT;
const keys = new Set([...src.matchAll(/t\('(trav\.[a-z_.]+)'/g), ...layers.matchAll(/t\('(trav\.[a-z_.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
['off', 'wait', 'ok', 'stale', 'nodata', 'noros', 'paused'].forEach((s) => keys.add('trav.st.' + s));
['nodata', 'stale', 'noros'].forEach((s) => keys.add('trav.why.' + s));
const miss = [...keys].filter((k) => !(k in D.en) || !(k in D.cs));
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
check('trav.* keys in en + cs (' + keys.size + ')', !miss.length, miss.join(', '));
check('same placeholders en / cs', [...keys].every((k) => !(k in D.en) || ph(D.en[k]) === ph(D.cs[k])));
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
