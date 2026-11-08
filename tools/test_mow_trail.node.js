#!/usr/bin/env node
/*
 * The Mow load layer without a browser and without ROS.
 *
 *     node tools/test_mow_trail.node.js
 *
 * vt_mow_trail.js runs on stubs. Checks: colour scales, width by state, colours
 * of unknown values and of a blade metric with the blade off, one card for a row,
 * nearest row, declutter of icons, the store, incremental ribbon (a new row writes
 * only its quad, a break makes no quad, a U-turn does not twist), wire of 26 and
 * of 18 columns, the plan / heading metrics, the Position card, the lines of
 * positions (cut on BRK and NONE), en + cs for all keys, no publisher but the
 * request topic.
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
class Scene extends Obj { remove(o) { this.children = this.children.filter((c) => c !== o); } }
Geo.prototype.dispose = function () { this.disposed = true; };
const THREE = { BufferAttribute: Attr, BufferGeometry: Geo, Object3D: Obj, Mesh, LineSegments: Mesh, ShaderMaterial: class { constructor(o) { Object.assign(this, o); } }, DoubleSide: 2,
    Vector3: class { constructor(x, y, z) { this.set(x, y, z); } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } } };

const window = { VT_NO_AUTOSTART: true };
const sandbox = { window, console, Math, JSON, Date, Int32Array, Float32Array, Uint8Array, Uint16Array, String, Number, Array, Object, parseInt };
vm.runInNewContext(src, sandbox);
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
check('small GPS disagreement is first', M.colorOf('gpslidar', 4, pal), [0, 0, 0]);
check('big one is last', M.colorOf('gpslidar', 90, pal), [200, 200, 200]);
check('wheels agree in RTK fix', M.colorOf('gpswheel', 4, pal), [0, 0, 0]);
check('typical torque is low on the scale', M.colorOf('torque', 700, pal)[0] <= 50, true);
check('torque legend in Nm', M.METRICS.torque.label(1700), '17 Nm');
check('receiver accuracy is no metric', 'accuracy' in M.METRICS, false);
check('RPM: a held setpoint is the first step', M.colorOf('rpm', 1, pal), [0, 0, 0]);
check('overshoot too', M.colorOf('rpm', -14, pal), [0, 0, 0]);
near('a 7 rpm dip is already step 3', M.colorOf('rpm', 7, pal)[0], 100, 1e-6);
check('a 1 Hz base stays first', M.colorOf('rtcm', 9, pal), [0, 0, 0]);
check('the rpm legend is in rpm', M.METRICS.rpm.label(7), '−7 rpm');
check('the lidar legend is in cm', M.METRICS.gpslidar.label(35), '35 cm');
check('no fix-class metric left', 'gnss' in M.METRICS, false);
M.METRIC_KEYS.forEach((k) => check('metric ' + k + ' exists', !!M.METRICS[k], true));

// state
const S = M.STATES, deck = 0.29;
check('cutting is the deck', M.styleOf(S.indexOf('cutting'), deck).w, deck);
check('transit is thin', M.styleOf(S.indexOf('transit'), deck).w, 0.07);
check('blocked has its colour', M.styleOf(S.indexOf('blocked'), deck).color, 'blocked');
check('rule has its colour', M.styleOf(S.indexOf('rule'), deck).color, 'rule');
const N = M.NONE;
const row = (x, y, load, state, extra) => [x * 100, y * 100, load, 200, 3400, 210, state, 0, 30, 25, 4, 2, 14, 3, 55, 710, 12, 4, N, N, N, N, N, N, N, N].map((v, i) => (extra && i in extra ? extra[i] : v));
check('wire stride', M.STRIDE, 26);
let rows = Int32Array.from(row(0, 0, 20, S.indexOf('transit')));
check('load with the blade off is neutral', M.rowColor(rows, 0, 'load', pal, M.styleOf(S.indexOf('transit'), deck)), pal.off);
check('speed with the blade off keeps its scale', M.rowColor(rows, 0, 'speed', pal, M.styleOf(S.indexOf('transit'), deck)), M.colorOf('speed', 30, pal));
rows = Int32Array.from(row(0, 0, M.NONE, S.indexOf('cutting')));
check('unknown is unknown', M.rowColor(rows, 0, 'load', pal, M.styleOf(0, deck)), pal.none);
rows = Int32Array.from(row(0, 0, 50, S.indexOf('spinup'), { 11: M.NONE }));
check('rpm dip in a spin-up is neutral', M.rowColor(rows, 0, 'rpm', pal, M.styleOf(S.indexOf('spinup'), deck)), pal.off);
rows = Int32Array.from(row(0, 0, 50, S.indexOf('cutting'), { 13: M.NONE, 16: M.NONE, 17: M.NONE }));
check('an old run has no lidar check', M.rowColor(rows, 0, 'gpslidar', pal, M.styleOf(0, deck)), pal.none);
check('...no wheel check', M.rowColor(rows, 0, 'gpswheel', pal, M.styleOf(0, deck)), pal.none);
check('...but torque', M.rowColor(rows, 0, 'torque', pal, M.styleOf(0, deck)) === pal.none, false);
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
const facts = { lidar_m: 0.12, jump_m: 0.04, cno: 41.2, prres: 0.8, wheel_max: 2.6, num_sv: 19, pdop: 1.78, rtcm_rate: 5.5, rtcm_age: 0.3, state: 'cutting', load: 0.31, amps: 0.48, rpm: 3380, setpoint: 3400, temp: 21.3, height: 60, speed: 0.3, cmd: 0.3, wheel: 2.2, roll: 1.2, pitch: -3.1, fix: 4, hacc: 0.014, owner: 'gps', batt_v: 22.4, batt_pct: 67, power: 120, program: 'P', zone: 'Z', path: '3/9', chunk: 12 };
const cg = M.cardGroups(facts);
check('card groups', cg.map((g) => g.k), ['pose', 'blade', 'drive', 'place', 'power', 'job']);
check('few lines', cg.reduce((n, g) => n + g.rows.length, 0) <= 19, true);
check('rtcm and satellites in the card', cg.find((g) => g.k === 'place').rows.map((r) => r[1]), ['mowl.fix.4 · 1.4 cm', '19 · pDOP 1.78', '12 cm', '4 cm', '41.2 dB · 0.8 m', '5.5/s · 0.3 s']);
check('owner in the position group', cg[0].rows, [['owner', 'gps']]);
check('only what is known', M.cardGroups({ state: 'transit', temp: 20 }).map((g) => g.k), ['blade']);
check('summary lines', M.summaryRows({ time_mow_s: 600, time_transit_s: 60, stops: 2, mean_load: 0.14, peak_load: 0.42, peak_temp: 90.7, energy_wh: 73.2 }).length, 6);
check('torque total', M.summaryRows({ wheel_mean: 7.4, wheel_peak: 31.8 }), [['torque', '7.4 / 31.8 Nm']]);
check('gps totals', M.summaryRows({ lidar_med: 12, lidar_p95: 40, jump_med: 4, jump_p95: 14 }), [['gpslidar', '12 / 40 cm'], ['gpswheel', '4 / 14 cm']]);
check('totals with RTCM', M.summaryRows({ rtk_frac: 0.99, rtcm_rate: 5.5, rtcm_gaps: 2 }), [['rtk', '99 %'], ['rtcm', '5.5/s · 2 ×']]);
check('plan and heading totals', M.summaryRows({ xte_med: 4, xte_p95: 13, gps_xte_med: 6, gps_xte_p95: 21, head_med: 15, head_p95: 62 }), [['pathdev', '4 / 13 cm'], ['gpspath', '6 / 21 cm'], ['headerr', '1.5 / 6.2°']]);
check('duration', [M.duration(90), M.duration(3700)], ['2 min', '1 h 2 min']);

// store
const st = new M.Store();
check('push', st.push(flat, 0), 4);
check('skip overlapping rows', st.push(flat, 3), 1);
check('rows', st.n, 5);
const narrow = new M.Store();
narrow.push(M.widen([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 11), 0);
check('a message of 11 columns widens', [narrow.n, narrow.rows[0], narrow.rows[10], narrow.rows[11], narrow.rows[17]], [1, 1, 11, M.NONE, M.NONE]);
// a robot not updated yet: 18 columns, the new ones are unknown and nothing breaks
const old18 = [].concat([100, 200, 20, 200, 3400, 210, 0, 5, 30, 25, 4, 2, 14, 3, 55, 710, 12, 4], [110, 200, 20, 200, 3400, 210, 0, 6, 30, 25, 4, 2, 14, 3, 55, 710, 12, 4]);
const w18 = M.widen(old18, 18);
check('18 columns widen to 26', w18.length, 52);
check('...keeping the old ones', [w18[26], w18[26 + 17]], [110, 4]);
check('...and the new are NONE', w18.slice(18, 26).every((v) => v === M.NONE), true);
check('26 columns stay as they are', M.widen(w18, 26), w18);
const st18 = new M.Store();
st18.push(w18, 0);
const f18 = M.rowFacts(st18.rows, 1, 1000);
check('old row: no plan, gps, lidar, heading', [f18.xte_m, f18.path_x, f18.gps_x, f18.lidar_y, f18.head_err_deg], [null, null, null, null, null]);
check('old row: position card has nothing to show', M.cardGroups(f18).some((g) => g.k === 'pose'), false);
check('old row: pathdev is unknown', M.rowColor(st18.rows, 1, 'pathdev', pal, M.styleOf(0, deck)), pal.none);
check('old row: no line', M.polySegments(st18.rows, 0, 2, M.LINES.gps.x, M.LINES.gps.y, false, {}), []);
// the new columns from the wire
const r26 = Int32Array.from(row(1, 2, 20, 0, { 18: -12, 19: 112, 20: 200, 21: 95, 22: 230, 23: 101, 24: 205, 25: -37 }));
const f26 = M.rowFacts(r26, 0, 0);
check('wire facts', [f26.x, f26.y, f26.xte_m, f26.path_x, f26.path_y, f26.gps_x, f26.gps_y, f26.lidar_x, f26.lidar_y, f26.head_err_deg], [1, 2, -0.12, 1.12, 2, 0.95, 2.3, 1.01, 2.05, -3.7]);
check('pathdev by size: -12 cm is 12', M.rowColor(r26, 0, 'pathdev', pal, M.styleOf(0, deck)), M.colorOf('pathdev', 12, pal));
check('pathdev in transit keeps its scale', M.rowColor(r26, 0, 'pathdev', pal, M.styleOf(S.indexOf('transit'), deck)), M.colorOf('pathdev', 12, pal));
check('headerr by size', M.rowColor(r26, 0, 'headerr', pal, M.styleOf(0, deck)), M.colorOf('headerr', 37, pal));
check('pathdev stops', M.METRICS.pathdev.stops, [3, 6, 10, 20, 35]);
check('headerr stops', M.METRICS.headerr.stops, [10, 20, 40, 80, 150]);
check('headerr legend in degrees', M.METRICS.headerr.label(150), '15°');
check('pathdev legend in cm', M.METRICS.pathdev.label(35), '35 cm');
check('off_path is the last event, old indexes stay', [M.EVENTS.indexOf('off_path'), M.EVENTS.indexOf('gps_jump')], [17, 16]);
// hover card: from the wire only
const hv = M.cardGroups(f26).find((g) => g.k === 'pose');
check('hover: pose vs plan and the heading difference', [hv.table.map((x) => x[0]), hv.table.find((x) => x[0] === 'fusion')[1], hv.rows.map((x) => x[1])], [['plan', 'fusion'], '−12', ['Δ −3.7°']]);
// tap card: the detail of the robot
const det = { x: 1, y: 2, yaw: 90, path_x: 1.12, path_y: 2, path_yaw: 90, xte_m: -0.12, gps_x: 0.95, gps_y: 2.3, gps_head: 92.5, head_acc: 0.8,
    lidar_x: null, lidar_y: null, gps_xte_m: 0.05, gps_along_m: 0.3, gps_across_m: 0.05, head_err_deg: -2.5, owner: 'gps', track: 'gps_owns', state: 'cutting' };
const pg = M.cardGroups(det);
check('position is the first group', pg[0].k, 'pose');
check('position table', pg[0].table, [['plan', '0', '0 / −12'], ['fusion', '−12', '0 / 0'], ['gps', '+5', '+30 / +5']]);
check('position lines', pg[0].rows, [['heading', '90.0° / 92.5° ±0.8° · Δ −2.5°'], ['owner', 'gps'], ['track', 'gps_owns']]);
check('owner left the GNSS group', pg.some((g) => g.k === 'place'), false);
check('lidar from x, y and yaw when the robot sent no along / across', M.poseFacts({ x: 0, y: 0, yaw: 0, lidar_x: 0.1, lidar_y: -0.2 }).table, [['lidar', null, '+10 / −20']]);
check('heading difference from yaw when not sent', M.poseFacts({ yaw: 179, gps_head: -179 }).rows[0][1], '179.0° / -179.0° · Δ −2.0°');
check('nothing known, nothing shown', M.poseFacts({}).table.length + M.poseFacts({}).rows.filter((x) => x[1] != null).length, 0);
near('robot frame: ahead', M.inRobot(0, 1, 90)[0], 1, 1e-9);
near('robot frame: left', M.inRobot(-1, 0, 90)[1], 1, 1e-9);
// lines of positions: cut on BRK and on NONE, the plan also on a jump
const BRKS = M.BRK;
const lrows = Int32Array.from([].concat(
    row(0, 0, 0, 0, { 21: 0, 22: 10 }), row(1, 0, 0, 0, { 21: 100, 22: 10 }), row(2, 0, 0, 0, { 21: 200, 22: 10 }),
    row(3, 0, 0, 0), row(4, 0, 0, 0, { 21: 400, 22: 10 }), row(5, 0, 0, 0, { 21: 500, 22: 10 }),
    row(6, 0, 0, BRKS, { 21: 600, 22: 10 }), row(7, 0, 0, 0, { 21: 700, 22: 10 })));
const segs = M.polySegments(lrows, 0, 8, M.LINES.gps.x, M.LINES.gps.y, false, {});
check('gps line: 0-1-2, NONE, 4-5, BRK, 6-7', segs.length / 6, 4);
check('first segment with its distance', segs.slice(0, 6), [0, 0.1, 0, 1, 0.1, 1]);
check('distance goes on along the line', segs.slice(6, 12), [1, 0.1, 1, 2, 0.1, 2]);
check('after NONE the distance starts anew', segs.slice(12, 18), [4, 0.1, 0, 5, 0.1, 1]);
check('after BRK too', segs.slice(18, 24), [6, 0.1, 0, 7, 0.1, 1]);
const lst = {};
const inc = M.polySegments(lrows, 0, 5, M.LINES.gps.x, M.LINES.gps.y, false, lst).concat(M.polySegments(lrows, 5, 8, M.LINES.gps.x, M.LINES.gps.y, false, lst));
check('live: two appends draw the same', inc, segs);
const prow = Int32Array.from([].concat(row(0, 0, 0, 0, { 19: 0, 20: 0 }), row(0.1, 0, 0, 0, { 19: 10, 20: 0 }), row(0.2, 0, 0, 0, { 19: 300, 20: 0 })));
check('plan: a new path is no line', M.polySegments(prow, 0, 3, M.LINES.plan.x, M.LINES.plan.y, true, {}).length / 6, 1);
check('gps: the same jump is drawn, it is the news', M.polySegments(prow, 0, 3, M.LINES.plan.x, M.LINES.plan.y, false, {}).length / 6, 2);
// the line geometry: append uploads only the new range, grows by doubling
const lscene = new Scene();
const L = new M.Line(THREE, lscene, [255, 0, 0], true);
check('line in the scene, hidden', [lscene.children.length, L.mesh.visible], [1, false]);
L.append(segs.slice(0, 12));
check('two segments drawn', L.mesh.geometry.draw, [0, 4]);
L.pos.needsUpdate = false; L.pos.updateRange.count = -1;
L.append(segs.slice(12, 18));
check('append uploads one segment', [L.pos.updateRange.offset, L.pos.updateRange.count, L.d.array[4], L.d.array[5]], [12, 6, 0, 1]);
const many = [];
for (let i = 0; i < 5000; i++) many.push(i, 0, i, i + 1, 0, i + 1);
L.append(many);
check('grows: one mesh in the scene, old data kept', [lscene.children.length, L.cap >= 5003, L.pos.array[12], L.mesh.geometry.draw[1]], [1, true, 4, 5003 * 2]);
L.clear();
check('clear', L.mesh.geometry.draw, [0, 0]);
check('dashed plan', [L.uniforms.uDash.value > 0, new M.Line(THREE, lscene, [0, 0, 0], false).uniforms.uDash.value], [true, 0]);
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
const keys = ['layer', 'layer_tip', 'show', 'run', 'run.now', 'run.last', 'events', 'no_data', 'close', 'lines', 'lines_tip'];
M.LINE_KEYS.forEach((k) => keys.push('line.' + k));
['plan', 'fusion', 'gps', 'lidar', 'col_plan', 'col_fusion'].forEach((k) => keys.push('pose.' + k));
M.METRIC_KEYS.forEach((k) => keys.push('metric.' + k));
S.forEach((k) => keys.push('state.' + k));
M.EVENTS.forEach((k) => keys.push('ev.' + k));
['0', '1', '2', '3', '4'].forEach((k) => keys.push('fix.' + k));
M.METRIC_KEYS.filter((k) => M.METRICS[k].note).forEach((k) => keys.push('note.' + k));
['cut', 'spin', 'transit', 'rule', 'blocked'].forEach((k) => keys.push('style.' + k));
['pose', 'blade', 'drive', 'place', 'power', 'job'].forEach((k) => keys.push('grp.' + k));
['load', 'rpm', 'temp', 'height', 'speed', 'wheel', 'slope', 'fix', 'sats', 'gpslidar', 'gpswheel', 'cno', 'rtcm', 'owner', 'heading', 'track', 'battery', 'power', 'program', 'zone', 'path'].forEach((k) => keys.push('f.' + k));
['mow', 'transit', 'stops', 'load', 'peak_temp', 'energy', 'rtk', 'rtcm', 'torque', 'gpslidar', 'gpswheel', 'pathdev', 'gpspath', 'headerr'].forEach((k) => keys.push('sum.' + k));
['gps', 'dock', 'dr', 'relock', 'tracker', 'rtabmap', 'legacy', 'other'].forEach((k) => keys.push('owner.' + k));
['gps_owns', 'ok', 'aligned', 'settling', 'standstill', 'engage_delay', 'rtabmap_owns', 'poor_match', 'degenerate', 'corr_too_big', 'recover_slew', 'map_stale_overlap',
    'map_stale_prior', 'relock', 'relock_probe', 'relock_failed', 'no_scan', 'no_tf', 'few_rays', 'no_map', 'few_points_in_map', 'singular', 'other'].forEach((k) => keys.push('track.' + k));
['en', 'cs'].forEach((l) => keys.forEach((k) => check(l + ' has mowl.' + k, typeof D[l]['mowl.' + k], 'string')));
// owner and tracker state in the UI language, an unknown word stays raw
window.VTI18n = sandbox.VTI18n = { t: (k) => D.cs[k] || k };
check('owner and track translated', M.poseFacts({ owner: 'dr', track: 'corr_too_big' }).rows.slice(1), [['owner', D.cs['mowl.owner.dr']], ['track', 'lidar nesouhlasí']]);
check('an unknown state stays raw', M.poseFacts({ track: 'brand_new' }).rows[2], ['track', 'brand_new']);
delete window.VTI18n; delete sandbox.VTI18n;

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
['1', '2', '3', '4', '5', 'off', 'none', 'blocked', 'hot', 'rule', 'ev-1', 'ev-2', 'ev-3', 'plan', 'gps', 'lidar', 'fusion'].forEach((n) => check('token ' + n, css.includes('--vt-mow-' + n + ':'), true));

console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' checks passed');
process.exit(failed ? 1 : 0);
