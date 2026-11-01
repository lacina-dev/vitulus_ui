#!/usr/bin/env node
/*
 * The calendar card speaks in the codes master_controller reports:
 *   - every status code / issue code the node can produce has a sentence in en + cs
 *     with the same placeholders;
 *   - a robot that needs a person never reads as green "Active";
 *   - the checkpoint is shown as zone + path (1-based), the date form stays local;
 *   - the allowed mowing time: what is refused, what only warns, the sentences.
 *
 *     node tools/test_calendar_report.node.js [path/to/master_controller]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
const candidates = [process.argv[2],
    path.resolve(ROOT, '..', 'vitulus_planner', 'nodes', 'master_controller'),
    path.resolve(ROOT, '..', '..', '..', '..', 'vitulus_planner', '.claude', 'worktrees',
        'cal-core', 'nodes', 'master_controller')].filter(Boolean);
const master = candidates.find((p) => fs.existsSync(p));

let fails = 0;
function check(name, ok, detail) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || detail === undefined ? '' : ' ' + detail));
    if (!ok) fails += 1;
}

function dict(file) {
    const box = { window: { VT_I18N: {} } };
    box.window.VTI18n = { add() {}, register() {} };
    const src = fs.readFileSync(path.join(JS, 'i18n', file), 'utf8');
    const map = {};
    src.replace(/^\s*"((?:calmgr|prog)\.[^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm, (m, k, v) => {
        map[k] = JSON.parse('"' + v + '"');
        return m;
    });
    return map;
}
const en = dict('en.js');
const cs = dict('cs.js');

// --- the node's codes -------------------------------------------------------
const py = fs.readFileSync(master, 'utf8');
const codes = new Set();
py.replace(/_set_status\([^)]*?'([a-z_]+)'/gs, (m, c) => { codes.add(c); return m; });
['battery', 'weather', 'temp', 'critical', 'gps', 'rejected'].forEach((r) => codes.add('waiting_' + r));
['stopped', 'terminal', 'mission', 'mission_unknown', 'dock', 'manual', 'agent'].forEach((r) => codes.add('blocked_' + r));
const issues = new Set();
py.replace(/_issue\('([a-z_]+)'/g, (m, c) => { issues.add(c); return m; });
py.replace(/_give_up\(run, '([a-z_]+)'/g, (m, c) => { issues.add(c); return m; });
check('found the codes', codes.size > 15 && issues.size > 5, `${codes.size}/${issues.size}`);

function holes(s) { return (s.match(/\{\w+\}/g) || []).sort().join(); }
codes.forEach((c) => {
    if (c === 'blocked_' || c === 'waiting_') return;
    const k = 'calmgr.code.' + c;
    check(k, !!en[k] && !!cs[k] && holes(en[k]) === holes(cs[k]));
});
issues.forEach((c) => {
    const k = 'calmgr.issue.' + c;
    check(k, !!en[k] && !!cs[k] && holes(en[k]) === holes(cs[k]));
});

// --- the card logic ---------------------------------------------------------
const sandbox = { window: {}, document: { getElementById: () => null }, console, setTimeout };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(JS, 'calendar_manager.js'), 'utf8')
    + '\nthis.CalendarManager = CalendarManager; this.calT = calT;', sandbox);
const proto = sandbox.CalendarManager.prototype;
['blocked_stopped', 'blocked_terminal', 'run_off_dock'].forEach((c) => {
    check(c + ' is red', proto._codeLook(c)[1] === 'err', proto._codeLook(c));
});
['blocked_mission', 'blocked_mux_hold', 'blocked_agent', 'blocked_manual', 'blocked_dock', 'not_in_dock', 'held'].forEach((c) => {
    check(c + ' is not green', proto._codeLook(c)[1] === 'warn', proto._codeLook(c));
});
check('off is grey', proto._codeLook('off')[0] === 'auto_off');
sandbox.VTI18n = sandbox.window.VTI18n = { t: (k, v) => (en[k] || k).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] !== undefined ? v[n] : m)) };
const text = proto._sentence.call(proto, {
    code: 'waiting_weather', detail: { program: 'Mow', left_s: 300 }, status: '',
    run: { program: 'Mow', checkpoint: 'failed: on_path-Zone-a-2-347' },
});
check('sentence + resume point', text === 'Waiting for dry weather (5 min), then Mow. Continues at Zone-a, path 3.', text);

// --- the allowed mowing time -------------------------------------------------
const set = { enabled: true, start: '07:00', end: '21:00', min_left_min: 30 };
['on', 'on_night', 'off', 'equal', 'invalid', 'short', 'wait'].forEach((c) => {
    const k = 'calmgr.window.' + c;
    check(k, !!en[k] && !!cs[k] && holes(en[k]) === holes(cs[k]));
});
check('window setting reported by the node', /'window_setting':/.test(py) && /\/scheduler\/set_window/.test(py));
check('equal refused', proto._windowProblem('08:00', '08:00', set).code === 'equal');
check('empty refused', proto._windowProblem('', '21:00', set).code === 'invalid');
check('normal window fine', proto._windowProblem('07:00', '21:00', set) === null);
check('over midnight fine', proto._windowProblem('22:00', '05:00', set) === null);
check('too short only warns', proto._windowProblem('23:50', '00:10', set).warn === true);
check('exactly the minimum is fine', proto._windowProblem('23:45', '00:15', set) === null);
const pair = (h, m) => [{ value: h }, { value: m }];
check('read pads', proto._windowRead(pair('7', '5')) === '07:05');
check('read refuses 24:00', proto._windowRead(pair('24', '00')) === '');
check('read refuses minute 60', proto._windowRead(pair('7', '60')) === '');
check('read refuses empty', proto._windowRead(pair('', '00')) === '');
check('sentence', proto._windowSentence(set).includes('07:00–21:00'));
check('sentence over midnight', proto._windowSentence({ enabled: true, start: '22:00', end: '05:00' }).includes('midnight'));
check('sentence off', proto._windowSentence({ enabled: false, start: '07:00', end: '21:00' }) === en['calmgr.window.off']);

console.log(fails ? `${fails} FAILED` : 'OK');
process.exit(fails ? 1 : 0);
