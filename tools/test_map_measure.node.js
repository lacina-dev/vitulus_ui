#!/usr/bin/env node
/*
 * Measuring on the map (assets/js/vt_map_measure.js, T17 M10):
 *     node tools/test_map_measure.node.js
 *   - loaded by vt_map_layers.js (no index.html change);
 *   - sends nothing: no fetch / XHR / WebSocket / ROSLIB / publish / service;
 *   - off while the Marker panel (goal marker taps) or the map editor is open,
 *     the editor asked through MapEditor.controller().active (no side effects);
 *   - a tap = no drag (5 / 10 px), one finger, left button — as the goal marker;
 *   - ray -> ground, path length, polygon area (shoelace), formats en / cs;
 *   - keys in the card never reach the keyboard driving;
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
const src = fs.readFileSync(path.join(JS, 'vt_map_measure.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
const layers = fs.readFileSync(path.join(JS, 'vt_map_layers.js'), 'utf8');
check('loaded by vt_map_layers.js, index.html unchanged', !html.includes('vt_map_measure.js') && layers.includes("sc.src = '/assets/js/vt_map_measure.js'"));
['fetch(', 'XMLHttpRequest', 'WebSocket', 'ROSLIB', '.publish(', 'callService', 'sendBeacon', 'advertise'].forEach((w) => check('sends nothing: no ' + w, !code.includes(w)));
check('off in the Marker panel and in the map editor', /current_submenu === 'marker'/.test(code) && /MapEditor\.controller\(\)\.active/.test(code) && !code.includes('editor_holds'));
check('a tap only: no drag, one finger, left button', /SLOP_MOUSE = 5, SLOP_TOUCH = 10/.test(src) && /button !== 0/.test(code) && /a\.multi \|\| a\.moved/.test(code));
check('keys in the card stop propagating (vt_joy.js)', /c\.addEventListener\('keydown'[\s\S]{0,120}e\.stopPropagation\(\)/.test(code));
check('M10 check: no point while the layers panel is open, nor from the tap that closed it', /panel: panelOpen\(\)/.test(code) && /a\.panel \|\| panelOpen\(\)/.test(code));
check('M10 check: arrow keys on the ruler button never drive', /b\.addEventListener\('keydown'[^\n]*Arrow[^\n]*stopPropagation/.test(code));
check('M10 check: the card ends above the bottom bar, scale bar, rain label and credits', /function chromeTop\(\)/.test(code) &&
      ['div_bottom_menu', 'vt_map_scale', 'mapv3_precip_badge', 'mapv3_attr'].every((id) => code.includes("'" + id + "'")));
const M = require(path.join(JS, 'vt_map_measure.js'));
const near = (a, b) => Math.abs(a - b) < 1e-9;
const g = M.rayToGround({ x: 1, y: 2, z: 10 }, { x: 0.1, y: -0.2, z: -1 });
check('ray -> ground', g && near(g.x, 2) && near(g.y, 0));
check('a ray up or parallel hits nothing', M.rayToGround({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 1 }) === null && M.rayToGround({ x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 0 }) === null);
const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
check('path length 4 + 3 + 4 = 11', near(M.pathLength(sq), 11));
check('area of a 4 × 3 rectangle = 12, either direction', near(M.polygonArea(sq), 12) && near(M.polygonArea(sq.slice().reverse()), 12));
check('no area under three points', M.polygonArea(sq.slice(0, 2)) === 0);
check('formats en', M.fmtLen(0.456, 'en') === '0.46 m' && M.fmtLen(12.44, 'en') === '12.4 m' && M.fmtLen(1250, 'en') === '1.25 km' &&
      M.fmtArea(4.46, 'en') === '4.5 m²' && M.fmtArea(35.4, 'en') === '35 m²' && M.fmtArea(12500, 'en') === '1.25 ha');
check('formats cs: decimal comma', M.fmtLen(12.44, 'cs') === '12,4 m' && M.fmtArea(12500, 'cs') === '1,25 ha');
const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = win.VT_I18N_DICT;
const keys = new Set([...src.matchAll(/t\('(measure\.[a-z_.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
['marker', 'editor'].forEach((k) => keys.add('measure.blocked.' + k));
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
const miss = [...keys].filter((k) => !(k in D.en) || !(k in D.cs));
check('measure.* keys in en + cs (' + keys.size + ')', !miss.length, miss.join(', '));
check('same placeholders en / cs', [...keys].every((k) => !(k in D.en) || ph(D.en[k]) === ph(D.cs[k])));
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
