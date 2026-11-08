#!/usr/bin/env node
/*
 * The line above the map (vt_notice.js) on a fake clock: priorities, how long a line
 * stays, dedupe, the sticky countdown, the burst of latched lines, the old timer bug.
 *
 *     node tools/test_notice.node.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const ctx = vm.createContext({ globalThis: {} });
ctx.window = ctx.globalThis;
vm.runInContext(fs.readFileSync(path.join(JS, 'vt_notice.js'), 'utf8'), ctx);
const Make = ctx.window.VTNoticeMake;
let fails = 0, n = 0;
function eq(name, got, want) {
    n += 1;
    if (got !== want) { fails += 1; console.log('FAIL ' + name + ': ' + JSON.stringify(got) + ' != ' + JSON.stringify(want)); }
}
function rig() {
    const r = { t: 1000, timers: [], shown: null, log: [] };
    let id = 0;
    r.q = Make({
        now: () => r.t,
        later: (fn, ms) => { const h = ++id; r.timers.push({ h, at: r.t + ms, fn }); return h; },
        stop: (h) => { r.timers = r.timers.filter((x) => x.h !== h); },
        paint: (it) => { r.shown = it ? it.text : null; r.log.push(r.shown); },
    });
    r.run = (ms) => {
        const end = r.t + ms;
        for (;;) {
            r.timers.sort((a, b) => a.at - b.at);
            const x = r.timers[0];
            if (!x || x.at > end) { break; }
            r.timers.shift();
            r.t = x.at;
            x.fn();
        }
        r.t = end;
    };
    return r;
}
let r = rig();
r.q.robot('Waiting for dock cmd');
eq('a line shows', r.shown, 'Waiting for dock cmd');
r.run(9000);
eq('still there at 9 s', r.shown, 'Waiting for dock cmd');
r.run(1500);
eq('gone after 10 s', r.shown, null);

// the old bug: an older timer took a newer line away
r = rig();
r.q.robot('one');
r.run(9500);
r.q.robot('two');
r.run(1000);
eq('line two survives the timer of line one', r.shown, 'two');

// a burst of routine lines is shown one by one, nothing skipped within the queue
r = rig();
['a', 'b', 'c', 'd'].forEach((x) => r.q.robot(x));
eq('first first', r.shown, 'a');
r.run(2600); eq('second after min', r.shown, 'b');
r.run(2600); eq('third', r.shown, 'c');
r.run(2600); eq('fourth', r.shown, 'd');

// the queue is short: oldest routine goes
r = rig();
['a', 'b', 'c', 'd', 'e', 'f', 'g'].forEach((x) => r.q.robot(x));
eq('short queue', r.q._queue().length, 4);

// STOP first, at once, over a routine line and over a sleep countdown
r = rig();
r.q.robot('routine');
r.q.say({ key: 'stop', text: 'STOP', level: 0, sticky: true });
eq('STOP at once', r.shown, 'STOP');
r.q.robot('later routine');
r.run(60000);
eq('STOP stays', r.shown, 'STOP');
r.q.clear('stop');
eq('what waited comes after', r.shown !== 'STOP', true);

// a robot STOP line classified without help
r = rig();
r.q.robot('mower line');
r.q.robot('[SAFETY] bumper hit');
eq('robot error first', r.shown, '[SAFETY] bumper hit');

// countdown: sticky, updates in place, routine lines wait, they are not lost
r = rig();
r.q.say({ key: 'sleep', text: 'Usne za 60 s', level: 1, sticky: true, action: { text: 'x' } });
r.q.robot('Waiting for dock cmd');
for (let s = 59; s > 40; s -= 1) { r.run(1000); r.q.say({ key: 'sleep', text: 'Usne za ' + s + ' s', level: 1, sticky: true, action: { text: 'x' } }); }
eq('routine waits behind the countdown', r.shown, 'Usne za 41 s');
r.q.clear('sleep');
eq('the dock line comes after it', r.shown, 'Waiting for dock cmd');

// an equal one gets its turn and the countdown returns
r = rig();
r.q.say({ key: 'sleep', text: 'count', level: 1, sticky: true });
r.run(6000);
r.q.say({ key: 'w', text: 'rtk', level: 1 });
eq('equal gets its turn', r.shown, 'rtk');
r.run(6000);
eq('countdown returns', r.shown, 'count');

// dedupe
r = rig();
r.q.say({ key: 'k', text: 'same', level: 2 });
r.run(9000); eq('gone', r.shown, null);
r.q.say({ key: 'k', text: 'same', level: 2 });
eq('no repeat within 30 s', r.shown, null);
r.run(31000);
r.q.say({ key: 'k', text: 'same', level: 2 });
eq('again later', r.shown, 'same');
r = rig();
r.q.robot('x'); r.run(100); r.q.robot('x');
eq('same line once', r.log.filter((t) => t === 'x').length, 1);

// the burst after connecting: last line only, briefly
r = rig();
r.q.connected();
['old 1', 'old 2', 'Waiting for dock cmd'].forEach((x) => r.q.robot(x));
eq('nothing during the burst', r.shown, null);
r.run(2100);
eq('last of the burst', r.shown, 'Waiting for dock cmd');
r.run(6100);
eq('gone soon', r.shown, null);

// the master's diary stays in the log
r = rig();
r.q.robot('[Master] Calendar updated (1 events)');
eq('diary not on the line', r.shown, null);

// lost link: sticky, level 0, cleared by its key only
r = rig();
r.q.say({ key: 'conn', text: 'Spojení ztraceno', level: 0, sticky: true, conn: true });
r.run(120000);
eq('outage stays', r.shown, 'Spojení ztraceno');
r.q.clear('conn');
eq('and ends', r.shown, null);

// T25: a lost link right after a STOP shows at once (urgent), not after the STOP line's 6 s
r = rig();
r.q.robot('STOP pressed');
eq('stop line', r.shown, 'STOP pressed');
r.run(300);
r.q.say({ key: 'conn', text: 'Spojení ztraceno', level: 0, sticky: true, conn: true });
eq('without urgent it waits', r.shown, 'STOP pressed');
r.q.clear('conn');
r = rig();
r.q.robot('STOP pressed');
r.run(300);
r.q.say({ key: 'conn', text: 'Spojení ztraceno', level: 0, sticky: true, conn: true, urgent: true });
eq('urgent outage at once', r.shown, 'Spojení ztraceno');
r.q.say({ key: 'conn', text: 'Spojení ztraceno · STOP čeká', level: 0, sticky: true, conn: true, urgent: true });
eq('urgent text update', r.shown, 'Spojení ztraceno · STOP čeká');
r.q.say({ key: 'cd', text: 'countdown', level: 1, sticky: true });
r.run(60000);
eq('urgent outage stays', r.shown, 'Spojení ztraceno · STOP čeká');
r = rig();
r.q.say({ key: 'cd', text: 'countdown', level: 0, sticky: true });
r.q.say({ key: 'conn', text: 'lost', level: 0, sticky: true, conn: true, urgent: true });
eq('urgent over a sticky', r.shown, 'lost');
r.q.clear('conn');
eq('the sticky comes back', r.shown, 'countdown');

console.log(fails ? fails + ' of ' + n + ' failed' : 'OK — ' + n + ' notice checks');
process.exit(fails ? 1 : 0);
