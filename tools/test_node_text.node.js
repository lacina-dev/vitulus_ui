#!/usr/bin/env node
/*
 * T8 E: the fixed English lines robot nodes send (gloc_server /gloc/status,
 * the rosbag recorders' /vitulus_rosbag/<name>/status; T8 I: the webnode's
 * reasons in the dock rows of Agent › Activity, kind dockui) show in the UI
 * language — VTI18n.node(kind, line) in assets/js/vt_i18n.js.
 *
 *     node tools/test_node_text.node.js
 *
 * Fails when
 *   - a sample line (one per format string of the node: vitulus_navi/nodes/
 *     gloc_server _set_status, vitulus_rosbag/recorder_base.py
 *     _publish_status) is not translated to Czech, keeps a {placeholder}, or
 *     loses one of its numbers / names;
 *   - English changes the meaning (the numbers and names stay);
 *   - an unknown line is not shown unchanged (in both languages);
 *   - a key a rule names is missing in en.js or cs.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
let fails = 0, n = 0;
function check(name, ok, detail) {
    n++;
    if (!ok) { fails++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}

function load(lang) {
    const store = { vitulus_lang: lang };
    const win = {};
    const doc = { readyState: 'complete', documentElement: { setAttribute() {} }, querySelectorAll: () => [],
                  addEventListener() {}, dispatchEvent() {} };
    win.document = doc;
    const ctx = vm.createContext({ window: win, document: doc, console: { debug() {}, error() {} }, Intl, Promise,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
    ['i18n/en.js', 'i18n/cs.js', 'vt_i18n.js'].forEach((f) => {
        vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
    });
    return win;
}

const en = load('en'), cs = load('cs');
check('VTI18n.node exists', typeof cs.VTI18n.node === 'function');
check('the page language is cs', cs.VTI18n.lang() === 'cs' && en.VTI18n.lang() === 'en');

// [kind, a line as the node sends it, the numbers / names that must stay]
const SAMPLES = [
    ['gloc', 'idle (no map yet)', []],
    ['gloc', 'idle', []],
    ['gloc', 'computing...', []],
    ['gloc', 'relocalizing (auto)...', []],
    ['gloc', 'ok 1.23s margin 45%', ['1.23', '45']],
    ['gloc', 'relock rejected: margin 12% < gate 30%', ['12', '30']],
    ['gloc', 'relock rejected: yaw deviates from current heading (mirror alias?)', []],
    ['gloc', 'relock rejected: 3.40m > radius 2.00m', ['3.40', '2.00']],
    ['gloc', 'relock rejected: rms 0.142 > gate 0.080', ['0.142', '0.080']],
    ['gloc', 'relock rejected: rms n/a > gate 0.080', ['n/a', '0.080']],
    ['gloc', 'relock rejected: far 4.68m at margin 41%', ['4.68', '41']],
    ['gloc', 'relock rejected: some new reason', ['some new reason']],
    ['gloc', 'relock probation (12.30, -4.05) 5 ticks / 1.50 m', ['12.30', '-4.05', '5', '1.50']],
    ['gloc', 'relock probation failed — lost', []],
    ['gloc', 'relock probation 2/5 ticks, 0.40/1.50 m', ['2', '5', '0.40', '1.50']],
    ['gloc', 'RELOCK APPLIED (12.30, -4.05) po probaci', ['12.30', '-4.05']],
    ['gloc', 'apply refused: margin 12% < gate 30%', ['12', '30']],
    ['gloc', 'apply refused: candidate yaw deviates > 35 deg from current heading (mirror alias?)', ['35']],
    ['gloc', 'apply refused: no result', ['no result']],
    ['gloc', 'APPLIED (manual) -> /nav_tf/set_map_pose_relock (12.30, -4.05, 91.0deg)',
        ['/nav_tf/set_map_pose_relock', '12.30', '-4.05', '91.0']],
    ['gloc', 'APPLIED (sideways) -> /nav_tf/set_map_pose_relock (1.00, 2.00, 3.0deg)', ['sideways']],
    ['gloc', 'error: map not loaded', ['map not loaded']],
    ['rosbag', 'idle', []],
    ['rosbag', 'recording | fps=5.0 | d435_2026-11-08-20-00-00.bag', ['5.0', 'd435_2026-11-08-20-00-00.bag']],
    ['rosbag', 'recording | fps=unlimited | gnss_2026-11-08-20-00-00.bag', ['gnss_2026-11-08-20-00-00.bag']],
    // T8 I: the webnode's dock door (nodes/webnode _dock_post, _dock_clear_direct) — Agent › Activity
    ['dockui', 'no ui_token', []],
    ['dockui', 'agent unreachable: timed out', []],
    ['dockui', 'direct clear: no answer (agent unreachable: <urlopen error [Errno 111] Connection refused>)', []],
    ['dockui', 'direct: unknown window 7', ['7']],
    // T8 II: the direct path's line when the node refused (the row is ok=false)
    ['dockui', 'locked directly in the node (agent unreachable: timed out)', []],
    // T8 II: the planner's line, Settings › Navi › Planner (vitulus_planner node_planner log_publisher, master_controller log)
    ['plan', 'Planner data saved.', []],
    ['plan', 'Planner map saved.', []],
    ['plan', 'Map name is empty.', []],
    ['plan', 'Running planner data cleaned.', []],
    ['plan', 'Be shure that you have loaded the map with RtabMap.', []],
    ['plan', 'Reloading map from /rtabmap/grid_map', []],
    ['plan', 'No site served yet — planner data unavailable.', []],
    ['plan', 'Planner data NOT loaded (saved data unusable).', []],
    ['plan', "Not loaded!!! It's a new map. Save it in Navi Manager first.", []],
    ['plan', 'Not saved!!! No site served / new map. Save it in Navi Manager first.', []],
    ['plan', 'Not saved!!! No planner workspace (no map is active).', []],
    ['plan', 'Map Assembled.', []],
    ['plan', 'Planner programs loaded', []],
    ['plan', 'Planner data loaded', []],
    ['plan', "Planner data loaded (site 'Zahrada')", ['Zahrada']],
    ['plan', 'Creating outline paths...', []],
    ['plan', 'Creating coverage paths...', []],
    ['plan', 'Polygon obstacle Strom u plotu saved.', ['obstacle', 'Strom u plotu']],
    ['plan', 'Polygon Strom u plotu removed.', ['Strom u plotu']],
    ['plan', "Zone 'ZONA_A' renamed to 'Před domem'.", ['ZONA_A', 'Před domem']],
    ['plan', "Zone 'ZONA_A' update propagated to 2 program(s).", ['ZONA_A', '2']],
    ['plan', "Removed zone 'ZONA_A' from 1 program(s).", ['ZONA_A', '1']],
    ['plan', "Zone 'ZONA_A' NOT saved: internal planner error.", ['ZONA_A']],
    ['plan', "Zone 'ZONA_A' NOT removed: internal planner error.", ['ZONA_A']],
    ['plan', 'Zone ZONA_A selected.', ['ZONA_A']],
    ['plan', 'Zone ZONA_A saved.', ['ZONA_A']],
    ['plan', 'Program selected to run: Front lawn', ['Front lawn']],
    ['plan', 'Program selected to resume: Front lawn', ['Front lawn']],
    ['plan', "Program 'Front lawn' not found on the active map", ['Front lawn']],
    ['plan', "Program 'Front lawn' NOT saved: it has no zones.", ['Front lawn']],
    ['plan', "Program 'Front lawn' NOT deleted: it is running — Stop it first.", ['Front lawn']],
    ['plan', '[Master] Program succeeded.', []],
    ['plan', '[Master] Robot returned to dock.', []],
    ['plan', '[Master] Robot is off the dock: sending it home.', []],
    ['plan', '[Master] Window closed: going home after this path.', []],
    ['plan', '[Master] Automation ON.', []],
    ['plan', '[Master] Automation OFF.', []],
    ['plan', '[Master] Calendar updated (3 events)', ['3']],
];
SAMPLES.forEach(([kind, line, keep]) => {
    const c = cs.VTI18n.node(kind, line), e = en.VTI18n.node(kind, line);
    check(kind + ' cs: "' + line + '" translated', c !== line && c.length > 0, '→ "' + c + '"');
    check(kind + ' cs: "' + line + '" no {placeholder} left', !/\{\w+\}/.test(c), c);
    check(kind + ' en: "' + line + '" no {placeholder} left', !/\{\w+\}/.test(e), e);
    keep.forEach((k) => {
        check(kind + ' cs keeps "' + k + '" of "' + line + '"', c.indexOf(k) >= 0, c);
        check(kind + ' en keeps "' + k + '" of "' + line + '"', e.indexOf(k) >= 0, e);
    });
});
// unknown lines and the other kind's lines stay as sent
[['gloc', 'something the node says one day'], ['rosbag', 'paused | disk full'], ['gloc', ''],
 ['nosuch', 'idle'], ['gloc', 'idle (soon)'],
 // T8 II: a planner line no rule knows (a refusal with its own reason, most [Master] lines) is shown as sent
 ['plan', "Zone 'ZONA_A' NOT saved: cut height 90 mm is outside 20–80 mm."], ['plan', '[Master] Sleep (night) for 30m.'],
 ['plan', 'Initialized'], ['plan', 'Připraveno'], ['plan', '']].forEach(([kind, line]) => {
    check('unknown ' + kind + ' "' + line + '" unchanged (cs)', cs.VTI18n.node(kind, line) === line, cs.VTI18n.node(kind, line));
    check('unknown ' + kind + ' "' + line + '" unchanged (en)', en.VTI18n.node(kind, line) === line, en.VTI18n.node(kind, line));
});
// a code word inside a line gets its key (manual / force); units glued to the number in Czech
check('cs: manual → ručně', /\(ručně\)/.test(cs.VTI18n.node('gloc', 'APPLIED (manual) -> /t (1.00, 2.00, 3.0deg)')));
check('cs: force → vynuceně', /\(vynuceně\)/.test(cs.VTI18n.node('gloc', 'APPLIED (force) -> /t (1.00, 2.00, 3.0deg)')));
check('en: manual stays manual', /\(manual\)/.test(en.VTI18n.node('gloc', 'APPLIED (manual) -> /t (1.00, 2.00, 3.0deg)')));
check('cs: no breaking space before %', /45\u00a0%/.test(cs.VTI18n.node('gloc', 'ok 1.23s margin 45%')) &&
      /1\.23\u00a0s/.test(cs.VTI18n.node('gloc', 'ok 1.23s margin 45%')), cs.VTI18n.node('gloc', 'ok 1.23s margin 45%'));
check('null line → empty', cs.VTI18n.node('gloc', null) === '');
// every key the rules name is in both dictionaries
const src = fs.readFileSync(path.join(JS, 'vt_i18n.js'), 'utf8');
const keys = new Set();
(src.match(/'(node\.[a-z_.]*[a-z_]|gloc\.[a-z_]+)'/g) || []).forEach((q) => keys.add(q.slice(1, -1)));
check('rules name some keys', keys.size >= 20, keys.size);
const D = cs.VT_I18N_DICT;
['node.gloc.how.manual', 'node.gloc.how.force'].forEach((k) => keys.add(k));
keys.forEach((k) => {
    check('en.js has ' + k, k in D.en);
    check('cs.js has ' + k, k in D.cs);
});

console.log((fails ? 'FAILED ' + fails + ' of ' : 'OK — ') + n + ' checks');
process.exit(fails ? 1 : 0);
