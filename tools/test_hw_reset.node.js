#!/usr/bin/env node
/*
 * The hard reset (vt_hw_reset.js) on a fake power module and a fake clock. The PM keeps W and
 * T and answers with them; a test can make it silent, or write T behind our back.
 *
 *     node tools/test_hw_reset.node.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const ctx = vm.createContext({ globalThis: {} });
ctx.window = ctx.globalThis;
vm.runInContext(fs.readFileSync(path.join(JS, 'vt_hw_reset.js'), 'utf8'), ctx);
const H = ctx.window.VTHwReset;
let fails = 0, n = 0;
function eq(name, got, want) {
    n += 1;
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { fails += 1; console.log('FAIL ' + name + ': ' + g + ' != ' + w); }
}
function rig() {
    const r = { t: 1e6, pm: { w_ms: 180000, t_ms: 42924000, armed: false, fresh: true }, deaf: false, log: [], rec: null, busy: null, link: true };
    r.h = H.make({
        now: () => r.t,
        store: (x) => { r.rec = x; },
        send: (what, v) => {
            r.log.push(v === undefined ? what : what + ':' + v);
            if (r.deaf) { return; }
            if (what === 'wait') { r.pm.w_ms = v; }
            if (what === 'time') { r.pm.t_ms = v; }
            if (what === 'arm') { r.pm.armed = true; }
            if (what === 'disarm') { r.pm.armed = false; }
        },
    });
    r.run = (s) => { for (let i = 0; i < s; i += 1) { r.h.tick({ pm: Object.assign({}, r.pm), busy: r.busy, link: r.link }); r.t += 1000; } };
    return r;
}
// the whole way
let r = rig();
r.h.start(60, r.pm);
r.run(1);
eq('W and T go first, no arm yet', r.log, ['wait:20000', 'time:80000']);
eq('values', [r.pm.w_ms, r.pm.t_ms], [20000, 80000]);
r.run(2);
eq('armed after the read-back', [r.h.state.phase, r.log[2]], ['armed', 'arm']);
eq('record kept', [r.rec.n, r.rec.w0, r.rec.t0], [60, 180000, 42924000]);
r.run(10);
eq('counting', r.h.left_s() > 5 && r.h.left_s() < 15, true);
r.link = false; r.pm.fresh = false;
r.run(15);
eq('power off', r.h.state.phase, 'gone');
r.t += 120000;
r.run(1);
r.link = true; r.pm = { w_ms: 20000, t_ms: 80000, armed: false, fresh: true };
r.run(3);
eq('reported', r.h.state.result, 'back');
eq('away about 2 min', r.h.state.away_s >= 120 && r.h.state.away_s < 140, true);
eq('W and T restored', [r.pm.w_ms, r.pm.t_ms], [180000, 42924000]);
r.run(1);
eq('finished, record gone', [r.h.state.phase, r.rec], ['idle', null]);

// no read-back: never armed
r = rig(); r.deaf = true;
r.h.start(60, r.pm);
r.run(25);
eq('no read-back: no arm', r.log.includes('arm'), false);
eq('no read-back: said', r.h.state.result, 'no_readback');

// a master sequence appears before the arm
r = rig(); r.h.start(60, r.pm); r.busy = 'sequence'; r.run(3);
eq('blocked before the arm', [r.h.state.result, r.log.includes('arm')], ['blocked:sequence', false]);
eq('W put back', r.pm.w_ms, 180000);

// T rewritten between the read-back and the arm
r = rig(); r.h.start(60, r.pm); r.run(1); r.pm.t_ms = 42924000; r.h.state.phase = 'arm'; r.run(3);
eq('T changed: no arm', r.log.includes('arm'), false);

// Cancel with read-back
r = rig(); r.h.start(60, r.pm); r.run(3); r.h.cancel(); r.run(1);
eq('disarm sent', r.log.includes('disarm'), true);
r.run(2);
eq('confirmed by the flag', [r.pm.armed, r.h.state.result], [false, 'cancelled']);
r.run(3);
eq('W back after a cancel', r.pm.w_ms, 180000);

// Cancel not confirmed
r = rig(); r.h.start(60, r.pm); r.run(3); r.deaf = true; r.h.cancel(); r.run(20);
eq('cancel unconfirmed is said', r.h.state.result, 'cancel_unconfirmed');

// a master sequence appears while armed
r = rig(); r.h.start(60, r.pm); r.run(4); r.busy = 'mission'; r.run(3);
eq('busy while armed: cancelled', [r.pm.armed, r.h.state.result], [false, 'blocked:mission']);

// no cut happened
r = rig(); r.h.start(60, r.pm); r.run(35);
eq('still here after the cut time', r.h.state.result, 'no_cut');

// a page that opens later
r = rig();
r.h.resume({ n: 60, w0: 180000, t0: 42924000, cut: r.t - 100000, back: r.t - 40000 });
r.pm = { w_ms: 20000, t_ms: 80000, armed: false, fresh: true };
r.run(3);
eq('new page reports and restores', [r.h.state.result, r.pm.w_ms], ['back', 180000]);
r = rig();
r.h.resume({ n: 60, w0: 1, t0: 1, cut: 0, back: r.t - 4000000 });
eq('an old record is dropped', r.h.state.phase, 'idle');

console.log(fails ? fails + ' of ' + n + ' failed' : 'OK — ' + n + ' hard reset checks');
process.exit(fails ? 1 : 0);
