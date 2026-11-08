#!/usr/bin/env node
/*
 * The map objects of the UI, without a browser and without ROS.
 *
 *     node tools/test_map_objects.node.js
 *
 * map_objects.js runs as it is on a stub of ROSLIB that records what goes out;
 * nothing touches a robot. Checks:
 *   - geometry: area, length, perimeter,
 *   - snap: a vertex beats an edge, tolerance, open and closed sets, nothing near,
 *   - trace: one sample per step, bad positions dropped, simplify keeps corners,
 *   - labels: overlap is dropped by priority, or moves to the next free place (D7),
 *   - rules: active, scheduled, expired, temporary,
 *   - fields: lists, datetime-local round trip, speed and cut height limits,
 *   - search and type filter, only the changed meaning is sent,
 *   - undo of a delete: history undo while it is the newest step, save otherwise,
 *   - protected names in any case, or by the object's flag,
 *   - client: ops carry req and actor owner, a result reaches its callback once,
 *     an answer that never comes times out, a silent server stays not live,
 *     a superseded zone_check is dropped,
 *   - trace by driving, the source: no publisher and no command in that code,
 *   - no delete without the protected check, no window.confirm in the editor.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');

const sent = [];
const subs = {};
class Topic {
    constructor(o) { this.name = o.name; }
    subscribe(f) { subs[this.name] = f; }
    advertise() {}
    publish(m) { sent.push({ topic: this.name, data: JSON.parse(m.data) }); }
}
const timers = [];
const sandbox = {
    window: {}, console, Date, Math, JSON, isFinite, parseFloat, parseInt, String, Number, Array, Object,
    ROSLIB: { Topic, Message: class { constructor(d) { Object.assign(this, d); } } },
    setTimeout: (f) => { timers.push(f); return timers.length; },
    clearTimeout: (i) => { timers[i - 1] = null; },
};
vm.runInNewContext(fs.readFileSync(path.join(JS, 'map_objects.js'), 'utf8'), sandbox);
const MO = sandbox.window.VTMapObjects;

let failed = 0;
function check(label, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want), ok = g === w;
    if (!ok) { failed++; }
    console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : '  got ' + g + ' want ' + w));
}
function feed(topic, obj) { subs[topic]({ data: JSON.stringify(obj) }); }

// ---- geometry
const SQ = [[0, 0], [4, 0], [4, 3], [0, 3]];
check('area', MO.polyArea(SQ), 12);
check('open length', MO.lineLength(SQ), 11);
check('perimeter closes the ring', MO.perimeter(SQ), 14);
check('a two point line has no closing edge', MO.perimeter([[0, 0], [3, 4]]), 5);

// ---- snap
const set = [{ pts: SQ, closed: true }];
check('near a vertex', MO.snapPoint({ x: 4.1, y: 0.1 }, set, 0.3), { x: 4, y: 0, kind: 'vertex' });
check('near an edge', MO.snapPoint({ x: 2, y: 0.1 }, set, 0.3), { x: 2, y: 0, kind: 'edge' });
check('the vertex wins over a nearer edge', MO.snapPoint({ x: 3.8, y: 0.01 }, set, 0.3).kind, 'vertex');
check('nothing within the tolerance', MO.snapPoint({ x: 2, y: 1.5 }, set, 0.3), null);
check('closing edge of a ring', MO.snapPoint({ x: 0.1, y: 1.5 }, set, 0.3), { x: 0, y: 1.5, kind: 'edge' });
check('an open line has none', MO.snapPoint({ x: 0.1, y: 1.5 }, [{ pts: SQ, closed: false }], 0.3), null);
check('a single point set', MO.snapPoint({ x: 1, y: 1 }, [{ pts: [[1.1, 1]], closed: false }], 0.3).kind, 'vertex');

// ---- trace
const tr = new MO.TraceSampler(0.2);
check('first position taken', tr.add(0, 0), true);
check('closer than a step dropped', tr.add(0.1, 0), false);
check('a step away taken', tr.add(0.25, 0), true);
check('no position, no point', tr.add(NaN, 1), false);
const bent = [[0, 0], [1, 0.01], [2, 0], [3, 0.01], [4, 0], [4, 1], [4, 2]];
check('simplify keeps the corner and the ends', MO.simplify(bent, 0.05), [[0, 0], [4, 0], [4, 2]]);
check('two points stay', MO.simplify([[0, 0], [1, 1]], 0.05), [[0, 0], [1, 1]]);

// ---- labels
const L = (x, prio, n) => ({ x, y: 0, w: 40, h: 14, prio, n });
check('overlap: the rule stays', MO.declutter([L(0, 5, 'path'), L(10, 0, 'rule'), L(100, 5, 'far')], 2).map((k) => k.n), ['rule', 'far']);
// D7: a label with other places to try moves instead of disappearing
const C = (x, prio, n, cand) => Object.assign(L(x, prio, n), { cand });
check('taken spot: the next place is used',
    MO.declutter([L(0, 0, 'zone'), C(5, 3, 'point', [[0, 0], [0, -18], [0, 18]])], 2).map((k) => [k.n, k.dx, k.dy]),
    [['zone', 0, 0], ['point', 0, -18]]);
check('all places taken: dropped',
    MO.declutter([L(0, 0, 'a'), C(0, 3, 'b', [[0, 0], [10, 0]])], 2).map((k) => k.n), ['a']);
check('a dot blocks a label, it moves off it',
    MO.declutter([C(0, 1, 'zone', [[0, 0], [0, 20]])], 2, [{ x: 0, y: 0, w: 16, h: 16 }]).map((k) => [k.n, k.dy]), [['zone', 20]]);
check('no places given: as before',
    MO.declutter([L(0, 5, 'path'), L(10, 0, 'rule')], 2, []).map((k) => [k.n, k.dx, k.dy]), [['rule', 0, 0]]);

// ---- rules
check('plain rule', MO.ruleState({ active: true }, 100), { state: 'active', temporary: false });
check('not yet', MO.ruleState({ valid_from: 200, active: false }, 100), { state: 'scheduled', temporary: true });
check('running window', MO.ruleState({ valid_from: 50, valid_until: 200, active: true }, 100), { state: 'active', temporary: true });
check('over', MO.ruleState({ valid_until: 50, active: false }, 100), { state: 'expired', temporary: true });

// ---- fields
check('list: trimmed, no doubles', MO.parseList(' a, b ,A,, c'), ['a', 'b', 'c']);
check('local time round trip', MO.fromLocalInput(MO.toLocalInput(1800000000)), 1800000000);
check('empty time', [MO.toLocalInput(null), MO.fromLocalInput('')], ['', null]);
check('speed limits', [MO.clampSpeed(9), MO.clampSpeed(0), MO.clampSpeed('x')], [0.4, 0.05, 0.2]);
check('cut height 20-80, 0 stays', [MO.clampCut(90), MO.clampCut(5), MO.clampCut(0), MO.clampCut('72')], [80, 20, 0, 72]);

// ---- search
const row = { type: 'nogo', name: 'Bazén', note: 'hluboko', aliases: ['pool'], tags: ['voda'], category: '' };
check('by alias', MO.matches(row, 'POOL', 'all'), true);
check('by note and tag', MO.matches(row, 'voda hluboko', 'all'), true);
check('all words must match', MO.matches(row, 'voda strom', 'all'), false);
check('other type', MO.matches(row, '', 'slow'), false);

// ---- meaning: only what changed
const a = { note: 'x', aliases: [], tags: [], valid_from: null, valid_until: null, props: { speed_mps: 0.2 } };
check('nothing', MO.metaChanges(a, JSON.parse(JSON.stringify(a))), {});
check('note and one prop', MO.metaChanges(a, Object.assign({}, a, { note: 'y', props: { speed_mps: 0.3 } })),
      { note: 'y', props: { speed_mps: 0.3 } });

// ---- undo of a delete
const hist = { entries: [{ op: 'save', id: 'o_2' }, { op: 'delete', id: 'o_1' }] };
check('newest step: undo', MO.undoPlan(hist, 'o_1'), 'undo');
check('something came after: save', MO.undoPlan({ entries: hist.entries.concat({ op: 'save', id: 'o_3' }) }, 'o_1'), 'save');
check('no history: save', MO.undoPlan(null, 'o_1'), 'save');

// ---- planner notes
const N = (p, z, c) => ({ program: p, zone: z, code: c, text_en: z + ' skipped', text_cs: z + ' vynechána' });
const nr = MO.mergeNotes([N('A', 'Z1', 'zone_under_rule')], [N('A', 'Z1', 'zone_under_rule'), N('A', 'Z2', 'zone_under_rule')]);
check('notes: nothing twice', nr.map((n) => n.zone), ['Z1', 'Z2']);
check('notes: the same zone in another program stays', MO.mergeNotes(nr, [N('B', 'Z1', 'zone_under_rule')]).length, 3);
check('notes: no list is no change', MO.mergeNotes(nr, undefined).length, 2);
check('notes: in the language of the UI', MO.notesText([N('A', 'Z1', 'x')], 'cs'), 'Z1 vynechána');
check('notes: several programs name theirs', MO.notesText([N('A', 'Z1', 'x'), N('B', 'Z2', 'x')], 'en'), 'A: Z1 skipped · B: Z2 skipped');

// ---- protected
['DOCK', 'UNDOCK', 'DOCKED', 'docked', 'Dock'].forEach((n) => check('protected ' + n, MO.isProtected(null, n), true));
check('a normal name is not', MO.isProtected({ protected: false }, 'Dock 2'), false);
check('the server flag counts', MO.isProtected({ protected: true }, 'X'), true);

// ---- client
check('silent server: not live', MO.live(), false);
let answered = null;
check('no connection: an op answers, it does not throw', (MO.op({ op: 'undo' }, (r) => { answered = r; }), answered.timeout), true);
MO.start({});
check('still not live until objects come', MO.live(), false);
feed('/map_objects/objects', { site: 's', seq: 4, objects: [{ id: 'o_1', family: 'place', type: 'nogo', name: 'B' }, { id: 'o_2', family: 'zone', name: 'Z' }] });
check('live', MO.live(), true);
check('find', MO.find('zone', 'Z').id, 'o_2');
check('places only', MO.places().map((o) => o.id), ['o_1']);
let got = [];
MO.op({ op: 'delete', id: 'o_1' }, (r) => got.push(r.ok));
const out = sent[sent.length - 1];
check('op goes to its topic', out.topic, '/map_objects/op');
check('actor is the owner, req is set', [out.data.actor, !!out.data.req], ['owner', true]);
feed('/map_objects/result', { req: 'somebody else', ok: false });
check('a foreign result is ignored', got, []);
feed('/map_objects/result', { req: out.data.req, ok: true });
feed('/map_objects/result', { req: out.data.req, ok: true });
check('a result reaches its callback once', got, [true]);
let late = null;
MO.op({ op: 'undo' }, (r) => { late = r; });
timers.forEach((f, i) => { if (f) { f(); timers[i] = null; } });
check('no answer: a timeout, not silence', late.timeout, true);
let zc = [];
MO.zoneCheck([[0, 0]], {}, 'a', (r) => zc.push('first'));
const r1 = sent[sent.length - 1].data.req;
MO.zoneCheck([[1, 1]], {}, 'a', (r) => zc.push('second'));
const r2 = sent[sent.length - 1].data.req;
feed('/web_plan/zone_check_result', { req: r1, ok: true });
check('an older zone_check is dropped', zc, []);
feed('/web_plan/zone_check_result', { req: r2, ok: true, cancelled: true });
check('a cancelled one is dropped', zc, []);
MO.zoneCheck([[2, 2]], {}, 'a', (r) => zc.push('third'));
feed('/web_plan/zone_check_result', { req: sent[sent.length - 1].data.req, ok: true });
check('the newest is taken', zc, ['third']);

// ---- source rules
const ME = fs.readFileSync(path.join(JS, 'mapedits.js'), 'utf8');
const from = ME.indexOf('// ---- trace by driving'), to = ME.indexOf('function _paintTrace', from);
const traceCode = ME.slice(from, to);
check('trace code found', from > 0 && to > from, true);
check('trace publishes nothing', /publish|advertise|MO\.op|cmd_vel|ROSLIB/.test(traceCode), false);
check('MapTrace sampler publishes nothing', /publish/.test(sandbox.window.VTMapObjects.TraceSampler.toString()), false);
const del = ME.slice(ME.indexOf('function _deleteSel('), ME.indexOf('function _clearAll('));
check('delete asks about protected points first', del.indexOf('isProtected') > 0 && del.indexOf('isProtected') < del.indexOf('op: \'delete\''), true);
['mapedits.js', 'mapedit_ui.js', 'mapedit_layers.js', 'map_objects.js', 'vt_map_rules.js', 'vt_planner_settings.js'].forEach((f) => {
    check(f + ': no window.confirm', /window\.confirm\(|[^.]\bconfirm\(/.test(fs.readFileSync(path.join(JS, f), 'utf8')), false);
});

if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('all checks passed');
