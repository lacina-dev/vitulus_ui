#!/usr/bin/env node
/*
 * Map › Terrain (T31): the pure part of vt_terrain_panel.js.
 *
 *     node tools/test_terrain_panel.node.js
 *
 * - the terrain node's DiagnosticStatus -> state, numbers, warnings;
 * - alive / not running from the times (node 5 s period, recorder > 10 s silent);
 * - /terrain_recorder/state (contract t31-teren-ui-kontrakt.md v1) -> recording /
 *   waiting / paused / off / no site / not running, the gate reason in words, area,
 *   last write on the robot's clock, candidates, imports, backups, export error;
 * - which buttons are offered in which state; error codes in words;
 * - the node's ~config -> read-only rows, changed values marked;
 * - safety by reading the source: the only publish is the recorder command of the
 *   contract, no /cmd_vel, no mower topics, no ~set, no HTTP write; delete and
 *   replace send the recorder's token only from the confirmation;
 * - every key exists in en.js and cs.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const P = require(path.join(JS, 'vt_terrain_panel.js'));
let fails = 0, n = 0;
function ok(c, what, detail) { n++; if (c) { console.log('ok   ' + what); } else { fails++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); } }

function diagMsg(level, message, kv) {
    return { level, message, name: '/traversability_local: traversability', hardware_id: 'd435',
             values: Object.keys(kv).map((k) => ({ key: k, value: String(kv[k]) })) };
}
const KV = { cpu_process_pct: '23.40', features_ms_avg: '11.20', integrate_ms_avg: '4.1', cloud_hz: '14.80', features_hz: '1.9',
             tf_failures: '0', exempt_zones_active: '1', exempt_zones_missing_tf: '0', epoch: '3', epoch_events: '3',
             epoch_last_reason: 'gps jump', settling: '0', frames: '74', node_latency_ms_p95: '38.0' };

// ---- the terrain node
const T0 = 1000000;
let d = P.diag(diagMsg(0, 'ok', KV));
ok(d && d.level === 0 && d.kv.cpu_process_pct === '23.40', 'diag parses level, message, key values');
let v = P.nodeView(d, T0 + 2000, T0, T0 + 1000);
ok(v.state === 'ok', 'node ok', v.state);
ok(v.facts.cpu === 23.4 && v.facts.ms === 11.2 && v.facts.hz === 14.8 && v.facts.tf === 0 && v.facts.zones === 1 && v.facts.epoch === 3, 'node numbers', v.facts);
ok(v.facts.epochReason === 'gps jump' && v.facts.settling === false, 'node epoch reason + settling');
v = P.nodeView(P.diag(diagMsg(1, 'TF failures, CPU over budget, something new', Object.assign({}, KV, { tf_failures: '4' }))), T0 + 2000, T0, T0 + 1000);
ok(v.state === 'warn' && v.warns.length === 3 && v.warns[0].key === 'tf' && v.warns[1].key === 'cpu_budget' && v.warns[2].key === 'other' && v.warns[2].raw === 'something new', 'node warnings mapped, unknown said generally (raw kept for the tooltip)', v.warns);
ok(P.nodeView(P.diag(diagMsg(2, 'x', KV)), T0 + 1, T0, T0).state === 'err', 'node level 2 = error');
ok(P.nodeView(P.diag(diagMsg(0, 'ok', Object.assign({}, KV, { cpu_process_pct: '-1.00' }))), T0 + 1, T0, T0).facts.cpu === null, 'CPU -1 (unknown) shows as none');
ok(P.nodeView(null, T0 + 3000, T0, 0).state === 'wait', 'just subscribed: waiting');
ok(P.nodeView(null, T0 + 18000, T0, 0).state === 'down', 'silent 18 s: not running');
ok(P.nodeView(d, T0 + 30000, T0, T0 + 1000).state === 'down', 'last report 29 s old: not running');
ok(P.nodeView(d, T0 + 16000, T0, T0 + 1000).state === 'ok', 'last report 15 s old (3 periods): still running');
ok(P.nodeView(d, T0, 0, 0).state === 'wait', 'not subscribed: waiting, never "off"');
ok(P.diag(null) === null && P.diag({}).kv && P.nodeWarns('ok').length === 0, 'diag / warnings of nothing');

// ---- the gate reasons (contract §1)
const G = (r) => P.gateWhy(r);
ok(G('ok').key === 'ok' && G('no data').key === 'no_data' && G('').key === 'no_data', 'gate ok / no data');
ok(G('fix class 3').key === 'fix' && G('fix class 3').v.n === '3', 'gate fix class');
ok(G('hAcc 45 mm').key === 'hacc' && G('hAcc 45 mm').v.cm === '4.5' && G('hAcc 20 mm').v.cm === '2', 'gate hAcc in cm');
ok(G('owner dock').key === 'docked', 'gate "owner dock" = in the dock');
ok(G('owner lidar_relock_fallback_mode').key === 'owner_lidar' && G('owner wheel_odom').key === 'owner_odom' && G('owner xyz').key === 'owner_other' && G('owner xyz').raw === 'owner xyz', 'other owners by kind, never the raw name in the text');
['no navpvt', 'navpvt stale', 'no loc_status', 'loc_status stale', 'gps not good', 'heading not ok', 'anchor frozen'].forEach((r) => {
    ok(G(r).key !== 'other', 'gate "' + r + '" has words');
});
ok(G('cosmic rays').key === 'other' && G('cosmic rays').raw === 'cosmic rays' && !G('cosmic rays').v.text, 'unknown gate reason said generally (raw only for the tooltip)');

// ---- the recorder state (contract §1 example)
const now = T0 + 2000;
function state(over) {
    return Object.assign({
        v: 1, stamp: 1794170000.0, running: true, enabled: true, paused: false, mode: 'recording', site: '10_2026',
        gate: { open: true, reason: 'ok', open_for_s: 30 }, subscribed: true,
        map: { area_m2: 307.2, tiles: 6, known_cells: 122874, last_fused: 1794168766.4, last_fused_age_s: 1234, last_write: 1794169700.0, session: 3 },
        export: { version: 41, stamp: 1794168800, dir: 'terrain_mosaic', ok: true, error: null },
        nogo_candidates: [{ id: 'c3f2a1', kind: 'step', area_m2: 0.42, cells: 168, centroid: [4.43, 0.71], polygon: [[4, 0.3], [4.9, 0.3], [4.9, 1.1], [4, 1.1]] },
                          { id: 'c9', kind: 'slope', polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] }, { id: 'bad' }, null, { centroid: ['a', 2] }],
        imports: [{ name: 'bigger_2026-11-08', path: 'terrain_import/bigger_2026-11-08' }, { nope: 1 }],
        backups: [{ name: '20261108-231500', area_m2: 307.2 }],
        last_cmd: { id: 'ui-17', cmd: 'enable', ok: true, error: null, result: {} },
    }, over || {});
}
let r = P.recView(state(), now, T0, T0 + 1000);
ok(r.state === 'on' && r.enabled && r.gate.open, 'recording = on, gate open', r);
ok(r.area === 307.2 && r.tiles === 6 && r.site === '10_2026' && r.writeAge === 300, 'area, tiles, site, last write on the robot clock', [r.area, r.tiles, r.writeAge]);
ok(r.cands.length === 2 && r.cands[0].kind === 'step' && r.cands[0].x === 4.43 && r.cands[0].poly.length === 4 && r.cands[1].kind === 'slope', 'candidates: centroid, polygon, broken dropped', r.cands);
ok(r.cands[1].x === 1 && r.cands[1].y === 1, 'candidate without centroid: centre of its polygon');
ok(r.imports.length === 1 && r.imports[0].name === 'bigger_2026-11-08' && r.backups.length === 1, 'imports and backups');
r = P.recView(state({ mode: 'waiting', gate: { open: false, reason: 'owner dock' } }), now, T0, T0 + 1000);
ok(r.state === 'on' && !r.gate.open && r.gate.why.key === 'docked', 'waiting = on, gate closed in the dock');
ok(P.recView(state({ mode: 'off', enabled: false }), now, T0, T0 + 1000).state === 'off', 'off');
ok(P.recView(state({ mode: 'paused', paused: true }), now, T0, T0 + 1000).state === 'paused', 'paused');
ok(P.recView(state({ mode: 'no_site', site: null }), now, T0, T0 + 1000).state === 'nosite', 'no site');
ok(P.recView(state({ running: false }), now, T0, T0 + 1000).state === 'down', 'running false = not running');
ok(P.recView(state(), T0 + 12000, T0, T0 + 1000).state === 'down', 'no state for 11 s = not running');
ok(P.recView(state(), T0 + 9000, T0, T0 + 1000).state === 'on', 'state 8 s old: still running');
ok(P.recView(state({ export: { ok: false, error: 'disk full' } }), now, T0, T0 + 1000).exportErr === 'disk full', 'export error kept');
ok(P.recView(state({ map: { area_m2: 0, last_write: null } }), now, T0, T0 + 1000).writeAge === null, 'never written');
const many = state({ nogo_candidates: Array.from({ length: 80 }, (_, i) => ({ id: 'c' + i, kind: 'step', centroid: [i, 0] })) });
r = P.recView(many, now, T0, T0 + 1000);
ok(r.cands.length === 50 && r.candsMore === 30, 'at most 50 candidates listed, the rest counted');

// ---- buttons by state
const A = (s) => P.recActions(P.recView(s, now, T0, T0 + 1000));
let a = A(state());
ok(a.toggle && a.pause && a.rebuild && a.clear, 'recording: everything');
a = A(state({ mode: 'off', enabled: false }));
ok(a.toggle && !a.pause && a.clear && a.rebuild, 'off: no pause, delete/rebuild still possible');
ok(A(state({ mode: 'paused', paused: true })).pause, 'paused: resume');
a = A(state({ mode: 'no_site', site: null }));
ok(a.toggle && !a.clear && !a.rebuild, 'no site: only on/off');
a = A(state({ running: false }));
ok(!a.toggle && !a.pause && !a.rebuild && !a.clear, 'not running: nothing can be sent');
a = P.recActions(P.recView(null, now, T0, 0));
ok(!a.toggle && !a.clear, 'waiting for the first state: nothing can be sent');
ok(P.errKey('bad_token') === 'tpan.err.bad_token' && P.errKey('not_available') === 'tpan.err.not_available' && P.errKey('unknown_import') === 'tpan.err.unknown_import' && P.errKey('bad_mode') === 'tpan.err.bad_mode' && P.errKey('bad_source') === 'tpan.err.bad_source' && P.errKey('bad_mosaic: no json') === 'tpan.err.bad_mosaic' && P.errKey('internal: x') === '' && P.errKey('busy') === '', 'error codes of the backend (terrainfuse._command)');
ok(P.heavy('import', { mode: 'merge' }) && P.heavy('delete_map', { confirm: 'k' }) && !P.heavy('delete_map', null) && !P.heavy('pause'), 'import and delete with a token wait long');
ok(P.CONTRACT.rec.heavyMs >= 60000, 'long commands wait at least 60 s');

// ---- config rows
const rows = P.configRows({ values: { step_crit: 0.1, res: 0.05 }, defaults: { step_crit: 0.08, res: 0.05 }, ranges: { step_crit: [0.02, 0.3], res: [0.02, 0.2] } });
ok(rows.length === 2 && rows[0].key === 'res' && !rows[0].changed && rows[1].changed && rows[1].def === 0.08 && rows[1].min === 0.02, 'config rows sorted, changed marked', rows);
ok(P.configRows(null).length === 0 && P.configRows({}).length === 0, 'config rows of nothing');

// ---- formats
ok(P.ago(10).key === 'now' && P.ago(300).key === 'min' && P.ago(300).v.n === 5 && P.ago(7200).key === 'h' && P.ago(3 * 86400).key === 'd', 'ago');
ok(P.ago(null) === null && P.ago(-5).key === 'now', 'ago of nothing / clock skew');
ok(P.fmtArea(412.37) === '412' && P.fmtArea(12.34) === '12.3' && P.fmtArea(null) === null, 'area format');
ok(P.fmtParam(0.59999999999999998) === '0.6' && P.fmtParam(0.00020000000000000001) === '0.0002' && P.fmtParam(30) === '30' && P.fmtParam(0.074999999999999997) === '0.075' && P.fmtParam(null) === '–', 'parameter format (robot ~config values)');
ok(P.fmtNum(11.2, 1) === '11.2' && P.fmtNum(3, 1) === '3' && P.fmtNum(null, 1) === '–', 'number format');

// ---- safety, from the source
const src = fs.readFileSync(path.join(JS, 'vt_terrain_panel.js'), 'utf8');
const pubs = (src.match(/\.publish\(/g) || []).length;
ok(pubs === 1, 'exactly one publish in the module', pubs);
ok(/S\.recPub\.publish\(/.test(src) && /name: CONTRACT\.rec\.cmd,/.test(src), 'the one publish is /terrain_recorder/cmd of the contract');
ok(P.CONTRACT.rec.cmd === '/terrain_recorder/cmd' && P.CONTRACT.rec.state === '/terrain_recorder/state' && P.CONTRACT.rec.result === '/terrain_recorder/cmd_result', 'contract topics');
ok(/CONTRACT\.rec\.cmds\.indexOf\(cmd\) < 0/.test(src), 'only commands of the contract leave');
ok(P.CONTRACT.rec.cmds.slice().sort().join(',') === 'delete_map,disable,enable,import,list,pause,rebuild_export,resume', 'contract: its eight commands', P.CONTRACT.rec.cmds);
ok(!/cmd_vel|mower|\/set['"]|~set|\.advertise\(|callService|ROSLIB\.Service/.test(src), 'no motion, mower, ~set, service or advertise');
ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(src), 'no HTTP from the module');
ok((src.match(/confirm: f\.token/g) || []).length === 1 && (src.match(/base\.confirm = f\.token/g) || []).length === 1, 'tokens are sent only from flowYes (the confirmation)');
ok(/if \(act === 'flow-yes'\) \{ flowYes\(\)/.test(src) && !/flowYes\(\);?\s*\}\s*\/\/ auto/.test(src), 'flowYes only by its button');
ok(/run\('delete_map', null, '', function/.test(src), 'delete step 1 asks for a token only (no confirm field)');
ok(!/source: 'bag'/.test(src), 'import from a bag is not offered (v1: not_available)');

// ---- no technical words in what the owner reads (owner 2026-11-08)
{
    const w = {};
    const c2 = vm.createContext({ window: w });
    ['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), c2));
    ['en', 'cs'].forEach((l) => {
        const bad = Object.entries(w.VT_I18N_DICT[l]).filter(([k, x]) => k.startsWith('tpan.') &&
            /\bTF\b|VITULUS_|terrain_backup|epoch|epoch|Epocha|mračn|cloud|budget|rozpočet|třída fixu|fix class|GNSS|navpvt|loc_status|owner/i.test(x));
        ok(bad.length === 0, l + ': no technical words in tpan texts', bad);
    });
}

// ---- i18n: every tpan.* key the module names exists in en and cs
const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const en = win.VT_I18N_DICT.en, cs = win.VT_I18N_DICT.cs;
const used = new Set((src.match(/'tpan\.[a-z0-9_.]+'/g) || []).map((s) => s.slice(1, -1)).filter((k) => !/\.$/.test(k)));
const pre = { 'tpan.rec.st.': ['on', 'off', 'paused', 'nosite', 'waiting', 'down', 'noros', 'wait'],
              'tpan.rec.main.': ['on', 'on_gate', 'off', 'paused', 'nosite', 'down', 'noros', 'wait'],
              'tpan.node.st.': ['ok', 'warn', 'err', 'down', 'noros', 'wait'], 'tpan.node.main.': ['ok', 'warn', 'err', 'down', 'noros', 'wait'],
              'tpan.sum.': ['on', 'off', 'paused', 'nosite', 'down', 'noros', 'wait', 'gate'],
              'tpan.gate.': ['ok', 'no_data', 'no_navpvt', 'navpvt_stale', 'no_loc', 'loc_stale', 'gps_bad', 'heading', 'anchor', 'docked', 'fix', 'hacc', 'owner_lidar', 'owner_odom', 'owner_other', 'other'],
              'tpan.node.w.': ['no_clouds', 'tf', 'stale', 'int_budget', 'feat_budget', 'lat_budget', 'cpu_budget', 'other'],
              'tpan.confirm.import.': ['merge', 'replace'], 'tpan.confirm.yes.': ['clear', 'merge', 'replace'],
              'tpan.imp.mode.': ['merge', 'replace'], 'tpan.imp.hint.': ['merge', 'replace'],
              'tpan.lyr.st.': ['off', 'wait', 'ok', 'stale', 'nodata', 'noros', 'paused', 'notf'],
              'tpan.cand.kind.': ['step', 'slope', 'drop', 'other'], 'tpan.ago.': ['now', 'min', 'h', 'd'],
              'tpan.view.': ['cost', 'reason', 'height', 'cost_tip', 'reason_tip', 'height_tip'],
              'tpan.err.': ['bad_token', 'not_available', 'no_site', 'unknown_cmd', 'unknown_import', 'bad_mode', 'bad_source', 'bad_mosaic', 'no_token'],
              'tpan.f.': ['gate', 'area', 'write', 'site', 'cpu', 'ms', 'hz', 'tf', 'zone', 'epoch'].reduce((x, k) => x.concat([k, k + '_tip']), []) };
Object.keys(pre).forEach((p) => pre[p].forEach((k) => used.add(p + k)));
const missEn = [...used].filter((k) => !(k in en));
const missCs = [...used].filter((k) => !(k in cs));
ok(missEn.length === 0, 'every tpan key in en.js (' + used.size + ')', missEn);
ok(missCs.length === 0, 'every tpan key in cs.js', missCs);
const unused = Object.keys(en).filter((k) => k.startsWith('tpan.') && !used.has(k) && !/^tpan\.(msg\.done\.|confirm\.backup\.)/.test(k));
ok(unused.length === 0, 'no tpan key left over in en.js', unused);
['no navpvt', 'navpvt stale', 'fix class 2', 'hAcc 50 mm', 'no loc_status', 'loc_status stale', 'owner dock', 'owner lidar', 'gps not good',
 'heading not ok', 'anchor frozen', 'ok', 'no data'].forEach((x) => {
    const k = 'tpan.gate.' + P.gateWhy(x).key;
    ok(k in en && k in cs, 'gate "' + x + '" -> ' + k + ' (en + cs)');
});
['tmos.layer', 'tmos.st.ok', 'trav.r.step', 'trav.layer', 'tmos.pick', 'tmos.recorder'].forEach((k) => ok(k in en && k in cs, 'borrowed key of the layers exists: ' + k));

console.log((fails ? fails + ' FAILED' : 'all ok') + ' of ' + n);
process.exit(fails ? 1 : 0);
