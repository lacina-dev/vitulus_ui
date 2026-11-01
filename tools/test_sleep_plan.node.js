#!/usr/bin/env node
/*
 * vt_sleep_plan.js repeats the arithmetic of master_controller and sleep_manager.py.
 * The numbers here are the master's, worked out from its code (2026-11-01):
 *   plan_timed_ms: floor max(sleep_min_s, W + min_off), segment 12 h, drift 0.5 %.
 * 42924000 ms is what /pm/power_status still showed after tonight: 12 h * 0.995 - 60 s.
 *
 *     node tools/test_sleep_plan.node.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const ctx = vm.createContext({ globalThis: {} });
ctx.window = ctx.globalThis;
vm.runInContext(fs.readFileSync(path.join(JS, 'vt_sleep_plan.js'), 'utf8'), ctx);
const P = ctx.window.VTSleepPlan;
let fails = 0, n = 0;
function eq(name, got, want) {
    n += 1;
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { fails += 1; console.log('FAIL ' + name + ': ' + g + ' != ' + w); }
}
const L = P.limits(null);
const V = { wake_before_min: 12, idle_sleep_threshold_min: 20, sleep_enabled: true, sleep_after_run: true };
const at = (s) => new Date(s).getTime();
const NOW = at('2026-11-01T22:03:00');
const rep = (o) => Object.assign({ enabled: true, held: false, state: 'IDLE', code: 'waiting_slot', run: null,
    window: null, next: { program: 'Bigger', at: '2026-11-08T21:30' },
    sleep: { state: 'IDLE', checks: [] } }, o || {});
const free = [{ key: 'ssh', state: 'off', code: 'ignored', vars: { who: ['pts/0'] } },
              { key: 'ui', state: 'off', code: 'ignored', vars: { n: 1 } }];
const c = (o) => Object.assign({ now: NOW, rep: rep(), values: V, L }, o || {});

// --- limits from the robot, defaults without
eq('defaults flagged', L.from_robot, false);
eq('robot values', P.limits({ sleep_min_s: 600, sleep_max_segment_h: 6 }).seg_s, 21600);
eq('robot flagged', P.limits({ sleep_min_s: 600 }).from_robot, true);

// --- the floor: 15 min is refused, 16 is not
eq('min manual', P.minManualMin(L), 16);
eq('15 min refused', P.pmMs(15 * 60, L), null);
eq('16 min', P.pmMs(16 * 60, L), 955200);
eq('owner 5 min refused', P.manual(5, c({ rep: rep({ next: null }) })).code, 'too_short');
eq('with sleep_min_s 300 the floor is W + off', P.minManualMin(P.limits({ sleep_min_s: 60 })), 6);

// --- tonight's number
eq('12 h segment', P.pmMs(11 * 86400, L), 42984000);
eq('minus the countdown', P.afterCountdownMs(42984000, 60), 42924000);

// --- Sleep now
let r = P.manual(60, c({ countdown: 60 }));
eq('free hour ok', [r.ok, r.capped], [true, false]);
eq('wake counts from the end of the countdown', r.wake, NOW + 60000 + P.afterCountdownMs(3582000, 60));
eq('cut is W after the go', r.cut, NOW + 60000 + 180000);
r = P.manual(60, c({ rep: rep({ next: { program: 'B', at: '2026-11-01T22:40' } }) }));
eq('start inside: capped at the start - lead', [r.ok, r.capped, r.slot.program], [true, true, 'B']);
eq('capped ms', r.ms, Math.floor(25 * 60 * 0.995 * 1000));
r = P.manual(60, c({ rep: rep({ next: { program: 'B', at: '2026-11-01T22:20' } }) }));
eq('start too close', [r.ok, r.code], [false, 'too_short_slot']);
r = P.manual(60, c({ rep: rep({ held: true, next: { program: 'B', at: '2026-11-01T22:20' } }) }));
eq('Hold: no cap', [r.ok, r.capped], [true, false]);
r = P.manual(60, c({ rep: rep({ enabled: false, next: { program: 'B', at: '2026-11-01T22:20' } }) }));
eq('automation off: no cap', [r.ok, r.capped], [true, false]);
r = P.manual(2000, c());
eq('longer than a piece', [r.ok, r.segmented, r.ms], [true, true, 42984000]);

// --- the automatic plan
let p = P.auto(c({ rep: rep({ sleep: { state: 'IDLE', checks: free } }) }));
eq('tonight: sleeps with a countdown', [p.kind, p.countdown_s, p.ignored], ['soon', 60, 2]);
eq('tonight: 12 h piece, wake', p.wake, NOW + 60000 + 42924000);
eq('tonight: time off', Math.round(p.off_s / 60), 712);
p = P.auto(c({ rep: rep({ sleep: { state: 'IDLE', checks: [{ key: 'ui', state: 'block', code: 'clients', vars: { n: 1 } }] } }) }));
eq('a page keeps it awake', [p.kind, p.holds.open.length], ['blocked', 1]);
p = P.auto(c({ rep: rep({ sleep: { state: 'IDLE', checks: [{ key: 'boot', state: 'wait', code: 'boot_grace', vars: { left_s: 240 } }] } }) }));
eq('boot grace is timed: known ahead', [p.kind, p.go], ['soon', NOW + 240000]);
p = P.auto(c({ rep: rep({ sleep: { state: 'IDLE', checks: [{ key: 'reason', state: 'wait', code: 'countdown_cancelled', vars: { left_s: 1800 } }] } }) }));
eq('cancel: until when', p.holds.cancelled_until, NOW + 1800000);
eq('off', P.auto(c({ values: Object.assign({}, V, { sleep_enabled: false }) })).why, 'sleep_off');
eq('automation off', P.auto(c({ rep: rep({ enabled: false }) })).why, 'automation_off');
eq('hold', P.auto(c({ rep: rep({ held: true }) })).why, 'held');
eq('no calendar', P.auto(c({ rep: rep({ next: null }) })).why, 'no_schedule');
eq('open run', P.auto(c({ rep: rep({ run: { program: 'X' } }) })).why, 'run');
eq('start close', P.auto(c({ rep: rep({ next: { program: 'B', at: '2026-11-01T22:20' } }) })).why, 'start_close');
p = P.auto(c({ L: P.limits({ sleep_min_s: 3600 }), rep: rep({ next: { program: 'B', at: '2026-11-01T23:10' } }) }));
eq('too short', [p.why, p.floor_s], ['too_short', 3600]);
p = P.auto(c({ rep: rep({ window: { start: '07:00', end: '21:00' }, next: { program: 'B', at: '2026-11-08T21:30' } }) }));
eq('outside the window: to the opening', [p.why, Math.round((p.wake - NOW) / 60000)], ['window', Math.round(((at('2026-11-02T07:00') - 720000 - NOW) / 60000) * 0.995)]);
p = P.auto(c({ rep: rep({ code: 'x', sleep: { state: 'ARM', mode: 'timed', sleep_ms: 42924000, next_wake: '2026-11-02T09:59', checks: [] } }) }));
eq('sequence: the master\'s own numbers', [p.kind, p.wake, Math.round(p.off_s / 60)], ['sequence', at('2026-11-02T09:59'), 712]);
eq('past return not cancellable', P.auto(c({ rep: rep({ sleep: { state: 'WAIT_CUT', checks: [] } }) })).cancellable, false);
p = P.auto(c({ countdown: { active: true, left_s: 42, phase: 'announce', reason: 'auto', mode: 'timed', who: {} }, cd_at: NOW }));
eq('countdown auto', [p.kind, p.left_s, p.wake], ['countdown', 42, NOW + 42000 - 60000 + 60000 + 42924000]);
p = P.auto(c({ countdown: { active: true, left_s: 30, phase: 'announce', reason: 'manual', mode: 'timed', who: {} }, cd_at: NOW,
               ask: { wake: 123, cut: 45, off_s: 6 } }));
eq('countdown manual: what was asked', [p.wake, p.cut], [123, 45]);

// --- switching on an ignore
const held = rep({ sleep: { state: 'IDLE', checks: [{ key: 'ui', state: 'block', code: 'clients', vars: { n: 1 } }] } });
p = P.ifIgnored({ now: NOW, rep: held, values: V, L }, 'ui');
eq('ignore ui = sleep now', [p.kind, p.people, p.countdown_s], ['soon', 1, 60]);
const both = rep({ sleep: { state: 'IDLE', checks: [{ key: 'ssh', state: 'block', code: 'logins', vars: { who: ['pts/0'] } },
                                                  { key: 'ui', state: 'block', code: 'clients', vars: { n: 1 } }] } });
eq('the other still holds', P.ifIgnored({ now: NOW, rep: both, values: V, L }, 'ui').kind, 'blocked');

// --- the copy against the original, when the planner is next to this checkout
const cp = require('child_process');
const root = path.resolve(__dirname, '..');
const smDir = [path.resolve(root, '..', 'vitulus_planner', 'src'),
    path.resolve(root, '..', '..', '..', '..', 'vitulus_planner', 'src')].find((d) => fs.existsSync(path.join(d, 'node_planner', 'sleep_manager.py')));
if (smDir) {
    const durs = [60, 300, 899, 900, 904, 905, 960, 3600, 43200, 50000, 950400];
    const py = 'import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom node_planner import sleep_manager as s\n'
        + 'c=s.SleepConfig()\nprint(json.dumps([s.plan_timed_ms(d,c) for d in ' + JSON.stringify(durs) + ']))';
    const real = JSON.parse(cp.execFileSync('python3', ['-c', py, smDir]).toString());
    durs.forEach((d, i) => eq('plan_timed_ms(' + d + ')', P.pmMs(d, L), real[i]));
} else { console.log('NOTE sleep_manager.py not found, copy not compared'); }

console.log(fails ? fails + ' of ' + n + ' failed' : 'OK — ' + n + ' sleep plan checks');
process.exit(fails ? 1 : 0);
