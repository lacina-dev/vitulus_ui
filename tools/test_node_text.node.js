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
    // T8 III: the rest of the common lines (one per format string; vitulus_planner node_planner, program_map, master_controller, sleep_manager)
    ['plan', 'Zone ZONA_A removed.', ['ZONA_A']],
    ['plan', "Zone 'ZONA_A' NOT saved: no map is active — activate or record a map first.", ['ZONA_A']],
    ['plan', "Zone 'ZONA_A' NOT removed: no map is active.", ['ZONA_A']],
    ['plan', "Zone 'ZONA_A' NOT saved: the programs of the active map are not loaded yet — try again in a moment.", ['ZONA_A']],
    ['plan', "Zone 'ZONA_A' NOT saved: program 'Front lawn' is running on it — stop it first.", ['ZONA_A', 'Front lawn']],
    ['plan', "Zone 'ZONA_A' NOT saved: cut height 90 mm is outside 20-80 mm.", ['ZONA_A', '90', '20-80 mm']],
    ['plan', "Zone 'ZONA_A' NOT saved: mowing paths could not be generated — the zone is too small or lies outside the map.", ['ZONA_A']],
    ['plan', "Zone 'ZONA_A' NOT saved: this shape leaves no mowing path — it is too small or lies outside the free space of the map.", ['ZONA_A']],
    ['plan', 'Zone split done: ZONA_A, ZONA_A 2.', ['ZONA_A, ZONA_A 2']],
    ['plan', 'Zone merge done: Před domem.', ['Před domem']],
    ['plan', 'Zone duplicate done: ZONA_A copy.', ['ZONA_A copy']],
    ['plan', 'Map NOT assembled: no map is active — activate or record a map first.', []],
    ['plan', "Polygon 'Strom u plotu' NOT saved: no map is active — activate or record a map first.", ['Strom u plotu']],
    ['plan', "Polygon 'Strom u plotu' NOT removed: no map is active — activate or record a map first.", ['Strom u plotu']],
    ['plan', "Program 'Front lawn' NOT saved: the programs of the active map are not loaded yet — try again in a moment.", ['Front lawn']],
    ['plan', "Program 'Front lawn' NOT removed: the programs of the active map are not loaded yet — try again in a moment.", ['Front lawn']],
    ['plan', "Program 'Front lawn' NOT saved: cut height 90 mm is outside 20-80 mm.", ['Front lawn', '90', '20-80 mm']],
    ['plan', "Program 'Front lawn' NOT saved: no map is active — activate a map first (a program belongs to the map it is created on).", ['Front lawn']],
    ['plan', "Program 'Front lawn': loading map 'Zahrada' before the undock.", ['Front lawn', 'Zahrada']],
    ['plan', "Programs not loaded: zones or datum of map 'Zahrada' are not ready", ['Zahrada']],
    ['plan', "Programs not loaded: the program list of map 'Zahrada' could not be saved to its site bundle", ['Zahrada']],
    ['plan', '[Master] Front lawn moved: slot of 2026-11-15 is free again.', ['Front lawn', '2026-11-15']],
    ['plan', '[Master] Window set: 08:00-20:00.', ['08:00', '20:00']],
    ['plan', '[Master] Window set: off.', []],
    ['plan', '[Master] Front lawn is already finished.', ['Front lawn']],
    ['plan', '[Master] Resuming program: Front lawn (battery)', ['Front lawn']],
    ['plan', '[Master] Starting scheduled program: Front lawn (slot)', ['Front lawn']],
    ['plan', '[Master] Following the program that is out: Front lawn', ['Front lawn']],
    ['plan', '[Master] Mission of Front lawn was lost.', ['Front lawn']],
    ['plan', '[Master] Program did not start (see the planner log).', []],
    ['plan', '[Master] Dock permit homeward cancelled: mowing on.', []],
    ['plan', '[Master] Dock permit ended with the robot out: finishing this path (max 120 s), then home.', ['120']],
    ['plan', '[Master] Dock permit: the path did not end in time, home now.', []],
    ['plan', '[Master] Terminal error in the dock. Resetting SMACH, the run retries.', []],
    ['plan', '[Master] Mower temperature sensor fault: run given up.', []],
    ['plan', "[Master] A person took the mower's power away: no resume.", []],
    ['plan', '[Master] Front lawn refused (dock_locked), retry 2/3.', ['Front lawn', 'dock_locked', '2', '3']],
    ['plan', '[Master] Recovery: charge, then resume.', []],
    ['plan', '[Master] PM confirms the cancel.', []],
    ['plan', '[Master] Unfinished sleep of a previous run: cancelled.', []],
    ['plan', '[Master] Awake after sleep (+3 min against plan).', ['+3']],
    ['plan', '[Master] Awake after sleep (-12 min against plan).', ['-12']],
    ['plan', '[Master] Sleep (night) for 30m.', ['30']],
    ['plan', '[Master] Sleep (timed, 16.0 min).', ['16.0']],
    ['plan', '[Sleep] PM armed, shutting the OS down.', []],
    ['plan', '[Sleep] PM did not confirm the cancel.', []],
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
 // T8 II: a planner line no rule knows is shown as sent. T8 III: the two samples that stood here (a zone's cut
 // height refusal, "[Master] Sleep (night) for 30m.") are translated now and moved to SAMPLES; here stand lines
 // that stay as sent on purpose — their reason is a sentence or a dump of its own
 ['plan', 'Zone split refused: the line does not cross the zone.'], ['plan', '[Master] Staying awake: ui:1.'],
 ['plan', "Program 'Front lawn' not started: the map is not ready."], ['plan', 'Chain: Front lawn waits for Back lawn'],
 ['plan', "[Master] Settings changed by owner: window_end, window_start."], ['plan', "Zone 'A:B' removed: maybe."],
 ['plan', '[Master] Front: lawn is already finished.'], ['plan', '[Master] Front: lawn moved: slot of 2026-11-15 is free again.'],
 ['plan', '[Master] Mission of Front: lawn was lost.'], ['plan', '[Master] Front: lawn refused (dock_locked), retry 2/3.'],
 ['plan', 'Initialized'], ['plan', 'Připraveno'], ['plan', '']].forEach(([kind, line]) => {
    check('unknown ' + kind + ' "' + line + '" unchanged (cs)', cs.VTI18n.node(kind, line) === line, cs.VTI18n.node(kind, line));
    check('unknown ' + kind + ' "' + line + '" unchanged (en)', en.VTI18n.node(kind, line) === line, en.VTI18n.node(kind, line));
});
// T8 III: "Program" before the name where Czech needs a noun; reason codes in brackets in words, unknown ones as sent
const csl = (l) => cs.VTI18n.node('plan', l);
check('cs: Program before the name (moved / finished / refused)', /^Program Front lawn přesunut/.test(csl('[Master] Front lawn moved: slot of 2026-11-15 is free again.')) &&
      /^Program Front lawn je už hotový/.test(csl('[Master] Front lawn is already finished.')) && /^Program Front lawn odmítnut/.test(csl('[Master] Front lawn refused (dock_locked), retry 2/3.')));
check('cs: reason codes translated (battery, night, timed)', /\(baterie\)/.test(csl('[Master] Resuming program: Front lawn (battery)')) &&
      /\(noc\)/.test(csl('[Master] Sleep (night) for 30m.')) && /\(časovač,/.test(csl('[Master] Sleep (timed, 16.0 min).')));
check('cs: unknown reason code stays as sent', /\(xyz_code\)/.test(csl('[Master] Starting scheduled program: Front lawn (xyz_code)')));
check('en: reason codes stay as sent', /\(battery\)/.test(en.VTI18n.node('plan', '[Master] Resuming program: Front lawn (battery)')));
// a code word inside a line gets its key (manual / force); units glued to the number in Czech
check('cs: manual → ručně', /\(ručně\)/.test(cs.VTI18n.node('gloc', 'APPLIED (manual) -> /t (1.00, 2.00, 3.0deg)')));
check('cs: force → vynuceně', /\(vynuceně\)/.test(cs.VTI18n.node('gloc', 'APPLIED (force) -> /t (1.00, 2.00, 3.0deg)')));
check('en: manual stays manual', /\(manual\)/.test(en.VTI18n.node('gloc', 'APPLIED (manual) -> /t (1.00, 2.00, 3.0deg)')));
check('cs: no breaking space before %', /45\u00a0%/.test(cs.VTI18n.node('gloc', 'ok 1.23s margin 45%')) &&
      /1\.23\u00a0s/.test(cs.VTI18n.node('gloc', 'ok 1.23s margin 45%')), cs.VTI18n.node('gloc', 'ok 1.23s margin 45%'));
check('null line → empty', cs.VTI18n.node('gloc', null) === '');
// T8 III: a planner refusal keeps its gender in Czech (zone: NEULOŽENA, polygon / program: NEULOŽEN), a zone
// operation is named, the non-breaking space stands before the unit
check('cs: polygon NOT saved → NEULOŽEN', /Polygon S NEULOŽEN:/.test(cs.VTI18n.node('plan', "Polygon 'S' NOT saved: no map is active — activate or record a map first.")));
check('cs: program NOT removed → NEODSTRANĚN', /Program P NEODSTRANĚN:/.test(cs.VTI18n.node('plan', "Program 'P' NOT removed: the programs of the active map are not loaded yet — try again in a moment.")));
check('cs: zone split named', /^Rozdělení zóny hotovo: A, B\.$/.test(cs.VTI18n.node('plan', 'Zone split done: A, B.')), cs.VTI18n.node('plan', 'Zone split done: A, B.'));
check('en: zone merge named', /^Zone merge done: A\.$/.test(en.VTI18n.node('plan', 'Zone merge done: A.')), en.VTI18n.node('plan', 'Zone merge done: A.'));
check('cs: window with a dash', cs.VTI18n.node('plan', '[Master] Window set: 08:00-20:00.') === 'Okno sekání nastaveno: 08:00–20:00.', cs.VTI18n.node('plan', '[Master] Window set: 08:00-20:00.'));
check('cs: unit after a non-breaking space', /90\u00a0mm/.test(cs.VTI18n.node('plan', "Zone 'Z' NOT saved: cut height 90 mm is outside 20-80 mm.")));
// T8 III: a line over 500 characters is never a node's fixed line — as sent, and at once (the controller of
// batch II measured 7 s on a pathological one)
(() => {
    const known = 'Planner data saved.';
    const long1 = "Zone '" + "a' NOT saved: program '".repeat(400) + "x";
    const long2 = '[Master] ' + '(x) refused ('.repeat(4000) + 'y';
    const long3 = "Zone '" + 'Z'.repeat(520) + "' NOT removed: no map is active.";
    const t0 = Date.now();
    [long1, long2, long3].forEach((l, i) => {
        check('long line ' + (i + 1) + ' (' + l.length + ' chars) unchanged (cs)', cs.VTI18n.node('plan', l) === l);
        check('long line ' + (i + 1) + ' unchanged (en)', en.VTI18n.node('plan', l) === l);
    });
    const ms = Date.now() - t0;
    check('long lines cost no time', ms < 200, ms + ' ms');
    const edge = "Zone '" + 'Z'.repeat(500 - 38) + "' NOT removed: no map is active.";
    check('a 500-character line is still translated', edge.length === 500 && cs.VTI18n.node('plan', edge) !== edge, String(edge.length));
    check('a short line still translated after them', cs.VTI18n.node('plan', known) !== known);
    // the worst line that still fits: every pattern runs over it
    const worst = ("Zone '" + "' NOT saved: program '".repeat(22)).slice(0, 500);
    const t1 = Date.now();
    for (let i = 0; i < 200; i++) { cs.VTI18n.node('plan', worst); }
    const per = (Date.now() - t1) / 200;
    check('the worst 500-character line is quick', per < 5, per.toFixed(2) + ' ms a line');
})();
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
