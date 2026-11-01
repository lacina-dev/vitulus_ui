#!/usr/bin/env node
/*
 * The Mow load layer without a browser and without ROS.
 *
 *     node tools/test_mow_trail.node.js
 *
 * vt_mow_trail.js runs on stubs. Checks: colour scales, width by state, colours
 * of unknown values and of a blade metric with the blade off, one card for a row,
 * nearest row, declutter of icons, the store, incremental ribbon (a new row writes
 * only its quad, a break makes no quad, a U-turn does not twist), en + cs for all
 * keys, no publisher but the request topic.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const src = fs.readFileSync(path.join(JS, 'vt_mow_trail.js'), 'utf8');

class Attr {
    constructor(array, size) { this.array = array; this.itemSize = size; this.updateRange = { offset: 0, count: -1 }; this.needsUpdate = false; }
    setDynamic() { return this; }
}
class Geo { constructor() { this.a = {}; } addAttribute(n, x) { this.a[n] = x; } setIndex(i) { this.index = i; } setDrawRange(s, c) { this.draw = [s, c]; } }
class Obj { constructor() { this.children = []; } add(o) { this.children.push(o); } }
class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
const THREE = { BufferAttribute: Attr, BufferGeometry: Geo, Object3D: Obj, Mesh, ShaderMaterial: class { constructor(o) { Object.assign(this, o); } }, DoubleSide: 2 };

const window = { VT_NO_AUTOSTART: true };
vm.runInNewContext(src, { window, console, Math, JSON, Date, Int32Array, Float32Array, Uint8Array, Uint16Array, String, Number, Array, Object, parseInt });
const M = window.VTMowTrail;

let failed = 0, passed = 0;
function check(label, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { passed++; return; }
    failed++;
    console.log('FAIL ' + label + '\n   got  ' + g + '\n   want ' + w);
}
function near(label, got, want, tol) { check(label, Math.abs(got - want) <= (tol || 1e-6), true); }

const pal = { ramp: [[0, 0, 0], [50, 50, 50], [100, 100, 100], [150, 150, 150], [200, 200, 200]], off: [1, 2, 3], none: [4, 5, 6], blocked: [7, 7, 7], hot: [8, 8, 8], rule: [9, 9, 9] };

// colours
check('hex', M.hex(' #ff0080 '), [255, 0, 128]);
check('bad hex is grey', M.hex('nonsense'), [136, 136, 136]);
check('below the scale', M.colorOf('load', 5, pal), [0, 0, 0]);
check('above the scale', M.colorOf('load', 99, pal), [200, 200, 200]);
check('between stops', M.colorOf('load', 16, pal), [25, 25, 25]);
check('RTK fix is the first step of Accuracy', M.colorOf('accuracy', 14, pal), [0, 0, 0]);
near('float is a step away', M.colorOf('accuracy', 27, pal)[0], 50 + (100 - 50) * 2 / 25, 1e-6);
check('5 m without corrections is off the scale', M.colorOf('accuracy', 4941, pal), [200, 200, 200]);
check('RPM: a held setpoint is the first step', M.colorOf('rpm', 1, pal), [0, 0, 0]);
check('overshoot too', M.colorOf('rpm', -14, pal), [0, 0, 0]);
near('a 7 rpm dip is already step 3', M.colorOf('rpm', 7, pal)[0], 100, 1e-6);
check('a 1 Hz base stays first', M.colorOf('rtcm', 9, pal), [0, 0, 0]);
check('the rpm legend is in rpm', M.METRICS.rpm.label(7), '−7 rpm');
check('the accuracy legend is in cm', M.METRICS.accuracy.label(15), '1.5 cm');
check('no fix-class metric left', 'gnss' in M.METRICS, false);
M.METRIC_KEYS.forEach((k) => check('metric ' + k + ' exists', !!M.METRICS[k], true));

// state
const S = M.STATES, deck = 0.29;
check('cutting is the deck', M.styleOf(S.indexOf('cutting'), deck).w, deck);
check('transit is thin', M.styleOf(S.indexOf('transit'), deck).w, 0.07);
check('blocked has its colour', M.styleOf(S.indexOf('blocked'), deck).color, 'blocked');
check('rule has its colour', M.styleOf(S.indexOf('rule'), deck).color, 'rule');
const row = (x, y, load, state, extra) => [x * 100, y * 100, load, 200, 3400, 210, state, 0, 30, 25, 4, 2, 14, 3, 55].map((v, i) => (extra && i in extra ? extra[i] : v));
let rows = Int32Array.from(row(0, 0, 20, S.indexOf('transit')));
check('load with the blade off is neutral', M.rowColor(rows, 0, 'load', pal, M.styleOf(S.indexOf('transit'), deck)), pal.off);
check('speed with the blade off keeps its scale', M.rowColor(rows, 0, 'speed', pal, M.styleOf(S.indexOf('transit'), deck)), M.colorOf('speed', 30, pal));
rows = Int32Array.from(row(0, 0, M.NONE, S.indexOf('cutting')));
check('unknown is unknown', M.rowColor(rows, 0, 'load', pal, M.styleOf(0, deck)), pal.none);
rows = Int32Array.from(row(0, 0, 50, S.indexOf('spinup'), { 11: M.NONE }));
check('rpm dip in a spin-up is neutral', M.rowColor(rows, 0, 'rpm', pal, M.styleOf(S.indexOf('spinup'), deck)), pal.off);
rows = Int32Array.from(row(0, 0, 50, S.indexOf('cutting'), { 12: M.NONE, 13: M.NONE }));
check('an old run has no accuracy', M.rowColor(rows, 0, 'accuracy', pal, M.styleOf(0, deck)), pal.none);
check('...and no rtcm', M.rowColor(rows, 0, 'rtcm', pal, M.styleOf(0, deck)), pal.none);

// picking
const flat = [].concat(row(0, 0, 10, 0), row(1, 0, 20, 0), row(2, 0, 30, 0), row(1, 0.05, 40, 0));
check('nearest, the newest pass wins', M.nearest(Int32Array.from(flat), 4, 1.0, 0.03, 0.3), 3);
check('nothing near', M.nearest(Int32Array.from(flat), 4, 9, 9, 0.3), -1);

// scale of the view
near('metres per pixel', M.metresPerPx({ position: { x: 0, y: 0, z: 100 }, fov: 40 }, { x: 0, y: 0, z: 0 }, 1000), 2 * 100 * Math.tan(20 * Math.PI / 180) / 1000, 1e-9);

// icons
const ev = [{ x: 0.1, y: 0.1, k: 11 }, { x: 0.2, y: 0.2, k: 0 }, { x: 5, y: 5, k: 7 }];
check('the worst stays in a cell', M.declutter(ev, 1).map((e) => e.k).sort(), [0, 7]);
check('close in, all show', M.declutter(ev, 0.01).length, 3);

// card
const facts = { num_sv: 19, pdop: 1.78, rtcm_rate: 5.5, rtcm_age: 0.3, state: 'cutting', load: 0.31, amps: 0.48, rpm: 3380, setpoint: 3400, temp: 21.3, height: 60, speed: 0.3, cmd: 0.3, wheel: 2.2, roll: 1.2, pitch: -3.1, fix: 4, hacc: 0.014, owner: 'gps', batt_v: 22.4, batt_pct: 67, power: 120, program: 'P', zone: 'Z', path: '3/9', chunk: 12 };
const cg = M.cardGroups(facts);
check('card groups', cg.map((g) => g.k), ['blade', 'drive', 'place', 'power', 'job']);
check('few lines', cg.reduce((n, g) => n + g.rows.length, 0) <= 16, true);
check('rtcm and satellites in the card', cg.find((g) => g.k === 'place').rows.map((r) => r[1]), ['mowl.fix.4 · 1.4 cm', '19 · pDOP 1.78', '5.5/s · 0.3 s', 'gps']);
check('only what is known', M.cardGroups({ state: 'transit', temp: 20 }).map((g) => g.k), ['blade']);
check('summary lines', M.summaryRows({ time_mow_s: 600, time_transit_s: 60, stops: 2, mean_load: 0.14, peak_load: 0.42, peak_temp: 90.7, energy_wh: 73.2 }).length, 6);
check('totals with RTCM', M.summaryRows({ rtk_frac: 0.99, rtcm_rate: 5.5, rtcm_gaps: 2 }), [['rtk', '99 %'], ['rtcm', '5.5/s · 2 ×']]);
check('duration', [M.duration(90), M.duration(3700)], ['2 min', '1 h 2 min']);

// store
const st = new M.Store();
check('push', st.push(flat, 0), 4);
check('skip overlapping rows', st.push(flat, 3), 1);
check('rows', st.n, 5);
const narrow = new M.Store();
narrow.push(M.widen([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 11), 0);
check('a message of 11 columns widens', [narrow.n, narrow.rows[0], narrow.rows[10], narrow.rows[11], narrow.rows[14]], [1, 1, 11, M.NONE, M.NONE]);
st.addEvents([1, 100, 200, 3]);
check('event', [st.events[0].x, st.events[0].k], [1, 3]);
const big = new M.Store();
for (let i = 0; i < 300; i++) big.push(flat, 0);
check('grows', [big.n, big.rows[(1200 - 1) * M.STRIDE]], [1200, 100]);

// ribbon
const scene = new Obj();
const r = new M.Ribbon(THREE, scene);
const col = [10, 20, 30];
r.quad(0, 0, 1, 0, 0.145, col, col, false);
r.quad(1, 0, 2, 0, 0.145, col, col, true);
r.flush();
const c = r.chunks[0];
check('quads drawn', c.g.draw, [0, 12]);
check('upload only the new vertices', [c.pos.updateRange.offset, c.pos.updateRange.count], [0, 24]);
c.pos.updateRange.count = c.nrm.updateRange.count = c.col.updateRange.count = -1;   // the renderer uploaded
r.quad(2, 0, 3, 0, 0.145, col, col, true);
r.flush();
check('second round uploads one quad', [c.pos.updateRange.offset, c.pos.updateRange.count], [8 * 3, 12]);
check('colours of that quad', Array.from(c.col.array.slice(24, 27)), [10, 20, 30]);
c.pos.updateRange.count = -1;
c.pos.needsUpdate = false;
r.flush();
r.quad(3, 0, 4, 0, 0.145, col, col, true);
r.flush();
r.quad(4, 0, 5, 0, 0.145, col, col, true);
r.flush();
check('two rounds before a frame: both in the range', [c.pos.updateRange.offset, c.pos.updateRange.count], [12 * 3, 8 * 3]);
c.pos.updateRange.count = -1;
c.pos.needsUpdate = false;
r.flush();
check('nothing new, nothing uploaded', [c.pos.needsUpdate, c.pos.updateRange.count], [false, -1]);
// a bend shares the edge, a U-turn does not twist
r.clear();
r.quad(0, 0, 1, 0, 0.1, col, col, false);
r.quad(1, 0, 1, 1, 0.1, col, col, true);
check('no shared edge at 90 degrees: own normal', Array.from(c.nrm.array.slice(8, 10)), [-1, 0]);
r.clear();
r.quad(0, 0, 1, 0, 0.1, col, col, false);
r.quad(1, 0, 2, 0.5, 0.1, col, col, true);
check('a bend keeps the previous edge', Array.from(c.nrm.array.slice(8, 10)), [-0, 1].map((v) => v));
r.quad(2, 0.5, 2.1, 0.5, 0.2, col, col, true);
check('another width starts its own edge', Array.from(c.nrm.array.slice(16, 18)), [-0, 1].map((v) => v));
r.quad(0, 0, 0, 0, 0.1, col, col, true);
check('a zero step makes no quad', r.seg, 3);
for (let i = 0; i < M.CHUNK + 3; i++) r.quad(i, 0, i + 1, 0, 0.1, col, col, true);
r.flush();
check('a second chunk', r.chunks.length, 2);

// i18n, every key the code can ask
const dict = {};
const ctx = vm.createContext({ window: { VT_I18N_DICT: dict } });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = ctx.window.VT_I18N_DICT;
const keys = ['layer', 'layer_tip', 'show', 'run', 'run.now', 'run.last', 'events', 'no_data', 'close'];
M.METRIC_KEYS.forEach((k) => keys.push('metric.' + k));
S.forEach((k) => keys.push('state.' + k));
M.EVENTS.forEach((k) => keys.push('ev.' + k));
['0', '1', '2', '3', '4'].forEach((k) => keys.push('fix.' + k));
['cut', 'spin', 'transit', 'rule', 'blocked'].forEach((k) => keys.push('style.' + k));
['blade', 'drive', 'place', 'power', 'job'].forEach((k) => keys.push('grp.' + k));
['load', 'rpm', 'temp', 'height', 'speed', 'wheel', 'slope', 'fix', 'sats', 'rtcm', 'owner', 'battery', 'power', 'program', 'zone', 'path'].forEach((k) => keys.push('f.' + k));
['mow', 'transit', 'stops', 'load', 'peak_temp', 'energy', 'rtk', 'rtcm'].forEach((k) => keys.push('sum.' + k));
['en', 'cs'].forEach((l) => keys.forEach((k) => check(l + ' has mowl.' + k, typeof D[l]['mowl.' + k], 'string')));

// RTCM rate of the right panel, from map_view.js
const mv = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
const body = /static rtcmRate\(o\) (\{[\s\S]*?\n    \})/.exec(mv)[1];
const rtcmRate = new Function('o', body);
check('base rate ok', rtcmRate({ role: 'position', rtcm: { rate: 5.5 } }), { txt: '5.5/s', tone: 'ok', rate: 5.5 });
check('base rate thin', rtcmRate({ role: 'position', rtcm: { rate: 1.2 } }).tone, 'warn');
check('base silent', rtcmRate({ role: 'position', rtcm: { rate: 0 } }).tone, 'err');
check('moving base has its own limit', rtcmRate({ role: 'heading', rtcm: { rate: 8 } }).tone, 'warn');
check('no data', rtcmRate({ role: 'position' }).tone, 'muted');
['en', 'cs'].forEach((l) => ['gnssrx.r.rtcm', 'gnssrx.r.rtcm_tip'].forEach((k) => check(l + ' ' + k, typeof D[l][k], 'string')));

// safety of the source
check('the only topic it publishes on', (src.match(/\.publish\(/g) || []).length, 1);
check('it asks through the request topic', src.includes("topic('/map_objects/mow_trail/request')"), true);
check('no robot command', /set_motor|cmd_vel|mower_smach\/stop/.test(src), false);
const css = fs.readFileSync(path.join(JS, '..', 'css', 'vt_tokens.css'), 'utf8');
['1', '2', '3', '4', '5', 'off', 'none', 'blocked', 'hot', 'rule', 'ev-1', 'ev-2', 'ev-3'].forEach((n) => check('token ' + n, css.includes('--vt-mow-' + n + ':'), true));

console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' checks passed');
process.exit(failed ? 1 : 0);
