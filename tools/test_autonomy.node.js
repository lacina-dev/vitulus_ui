#!/usr/bin/env node
/*
 * The Autonomy panel (docs/help/autonomy.md, vitulus_planner docs/AUTONOMY.md):
 *   - every setting of the planner's table has a label and one sentence in en + cs,
 *     every locked limit a label and a reason, every check code a sentence;
 *   - the panel is one menu item wired through map_view / vt_frame / vt_help;
 *   - calendar_manager: waiting_temp_spike is not green, the awake reason is translated;
 *   - no window.confirm in the new code.
 *
 *     node tools/test_autonomy.node.js [path/to/node_planner/autonomy.py]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
let fails = 0;
function check(name, ok, detail) {
    if (!ok) { fails += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' ' + detail)); }
}

const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(read('i18n/' + l + '.js'), ctx));
const en = win.VT_I18N_DICT.en, cs = win.VT_I18N_DICT.cs;
const both = (k) => !!en[k] && !!cs[k];

const pyPath = [process.argv[2],
    path.resolve(ROOT, '..', 'vitulus_planner', 'src', 'node_planner', 'autonomy.py'),
    path.resolve(ROOT, '..', '..', '..', '..', 'vitulus_planner', '.claude', 'worktrees', 'autonomy', 'src', 'node_planner', 'autonomy.py')]
    .filter(Boolean).find((p) => fs.existsSync(p));
const CUSTOM = ['window_enabled', 'window_start', 'window_end', 'skip_next', 'no_mow_until', 'rain_mode', 'stay_awake_until'];
if (pyPath) {
    const py = fs.readFileSync(pyPath, 'utf8');
    const keys = [];
    py.replace(/_f\('([a-z_]+)'/g, (m, k) => { keys.push(k); return m; });
    check('found the settings', keys.length > 20, keys.length);
    keys.filter((k) => !CUSTOM.includes(k)).forEach((k) => {
        check('text of ' + k, both('auto.set.' + k + '.label') && both('auto.set.' + k + '.hint'));
    });
    py.replace(/'key': '([a-z_]+)', 'value'/g, (m, k) => {
        check('label of locked ' + k, both('auto.set.' + k + '.label'));
        return m;
    });
    py.replace(/'locked_why': '([a-z_]+)'/g, (m, w) => { check('why ' + w, both('auto.lock.why.' + w)); return m; });
} else { console.log('NOTE autonomy.py not found, settings not checked'); }

const CHECKS = {
    automation: ['on', 'off'], hold: ['clear', 'held'], dock: ['in_dock', 'not_in_dock', 'off_dock'], mission: ['ready', 'free', 'busy'],
    battery: ['ok', 'waiting_battery', 'unknown'],
    rain: ['dry', 'ignored_mode', 'ignored_once', 'rain', 'recent_rain', 'forecast', 'rain_stale', 'no_data', 'waiting_weather'],
    gnss: ['ok', 'mux_hold', 'waiting_gps', 'not_checked', 'not_checked_live'], temperature: ['ok', 'waiting_temp', 'waiting_temp_spike'],
    window: ['open', 'off', 'outside_window', 'too_little_left'], programs: ['ok', 'wait_programs', 'no_schedule', 'not_on_map'],
    map: ['ok', 'loading_map', 'unknown'], enabled: ['on', 'sleep_off', 'automation_off'], manual: ['free', 'busy'], agent: ['free', 'busy'],
    ssh: ['none', 'logins', 'ignored'], ui: ['none', 'clients', 'ignored'], boot: ['done', 'boot_grace'], stay_awake: ['none', 'until'],
    reason: ['none', 'too_short', 'no_charging', 'charge_no_gain', 'pm_no_status', 'pm_params', 'pm_no_ack', 'pm_lost', 'pm_no_cut', 'pm_cancel_failed', 'countdown_cancelled'],
    // T18: the master's permit line (node why + PermitView no_state/stale/no_owners_*/not_owner)
    permit: ['open', 'exits_used', 'waiting_clock', 'scheduled', 'locked', 'no_file', 'unreadable', 'node_silent',
             'no_state', 'stale', 'no_owners_missing', 'no_owners_empty', 'no_owners_unreadable', 'not_owner'],
};
// T18: the master's journal of the end of a dock permit window (D38)
['homeward', 'homeward_cancel'].forEach((c) => check('journal dock_permit.' + c, both('auto.j.dock_permit.' + c)));
check('journal waited.dock_permit', both('auto.j.waited.dock_permit'));
Object.keys(CHECKS).forEach((k) => {
    check('check name ' + k, both('auto.check.key.' + k));
    CHECKS[k].forEach((c) => check('check ' + k + '.' + c, both('auto.check.' + k + '.' + c)));
});
['ok', 'wait', 'block', 'off', 'unknown'].forEach((s) => check('state ' + s, both('auto.check.state.' + s)));
['blocked_mission', 'blocked_mission_unknown', 'blocked_dock', 'blocked_manual', 'blocked_agent', 'blocked_stopped', 'blocked_terminal']
    .forEach((c) => check('mission ' + c, both('calmgr.code.' + c)));
['unknown', 'locked', 'type', 'range', 'option', 'battery_start_under_return', 'battery_start_under_20', 'battery_resume_under_start', 'window_equal', 'past', 'too_far']
    .forEach((c) => check('reason ' + c, both('auto.why.' + c)));
['always', 'calendar', 'ignore'].forEach((m) => check('rain ' + m, both('auto.rain.mode.' + m) && both('auto.rain.mode.' + m + '.hint')));
['rain', 'recent_rain', 'forecast', 'rain_stale'].forEach((c) => check('run ' + c, both('auto.rainrun.' + c)));

// T28: the heading-nudge lines dock_smach writes (vitulus_dock HeadingNudgeIO) are translated
{
    const src = read('vt_autonomy.js').match(/var LINES = (\[[\s\S]*?\]\]);/);
    check('LINES table found', !!src);
    const LINES = src ? vm.runInNewContext(src[1]) : [];
    const line = (text) => {
        for (const [re, key] of LINES) { const m = re.exec(text); if (m) { return [key, m[1] || '']; } }
        return null;
    };
    [['Heading nudge: driving 1.5 m forward to measure heading (attempt 1/2)', 'nudge_start', '1.5'],
     ['Heading nudge done: 1.48 m', 'nudge_done', '1.48'],
     ['Heading nudge stopped: obstacle ahead 0.41 m', 'nudge_stopped', 'obstacle ahead 0.41 m'],
     ['Heading nudge skipped: dock not behind the robot', 'nudge_skipped', 'dock not behind the robot']]
        .forEach(([text, key, x]) => {
            const got = line(text);
            check('nudge line ' + key, got && got[0] === key && got[1] === x, JSON.stringify(got));
            check('nudge text ' + key, both('auto.line.' + key) && en['auto.line.' + key].includes('{x}')
                  && cs['auto.line.' + key].includes('{x}'));
        });
    // reasons: the known ones are translated (keys + the same placeholders), unknown stays raw
    const wsrc = read('vt_autonomy.js').match(/var NUDGE_WHY = (\[[\s\S]*?\]\]);/);
    check('NUDGE_WHY table found', !!wsrc);
    const WHY = wsrc ? vm.runInNewContext(wsrc[1]) : [];
    const why = (raw) => {
        for (const [re, key, ph] of WHY) { const m = re.exec(raw); if (m) { return [key, ph ? m[1] : null]; } }
        return null;
    };
    [['obstacle ahead 0.41 m', 'obstacle', '0.41'], ['hold', 'hold'], ['mux hold (STOP or a person on the controls)', 'hold'],
     ['human takeover (ds4)', 'takeover'], ['keepalive lost (1.6 s)', 'keepalive'], ['motors off', 'motors_off'],
     ['drive motors off', 'motors_off'], ['no lidar scan', 'lidar'], ['lidar scan 0.7 s stale', 'lidar'],
     ['timeout (25 s)', 'timeout'], ['no progress (0.01 in 3.0 s) - stuck or slipping', 'stuck'],
     ['target crosses nogo Flowerbed', 'nogo', 'Flowerbed'], ['dock not behind the robot', 'dock_not_behind'],
     ['dock direction unknown', 'dock_unknown'], ['heading receiver carrier not FIXED', 'carrier'],
     ['blade not stopped', 'blade'], ['attempts used (2)', 'attempts', '2'], ['distance budget used (2.0 m)', 'budget', '2.0'],
     ['no RTK on both receivers', 'no_rtk'], ['wait over', 'wait_over'], ['heading anchored', 'anchored']]
        .forEach(([raw, key, val]) => {
            const got = why(raw);
            check('nudge why ' + raw, got && got[0] === key && (val === undefined || got[1] === val), JSON.stringify(got));
            const k = 'auto.nudge.why.' + key;
            const phs = (str) => (str.match(/\{[a-z]+\}/g) || []).sort().join();
            check('nudge why text ' + key, both(k) && phs(en[k]) === phs(cs[k]));
        });
    check('nudge why unknown stays raw', why('something new') === null);
}

const html = fs.readFileSync(path.join(ROOT, 'nodes', 'templates', 'index.html'), 'utf8');
['btn_autonomy', 'div_menu_autonomy', 'chk_scheduler_enabled', 'chk_scheduler_inhibit', 'card_mow_window', 'div_calendar_form', 'modal_rain_run']
    .forEach((id) => check('one #' + id, html.split('id="' + id + '"').length === 2));
check('no Calendar tab in Programs', !html.includes('id="tab_calendar"'));
check('calendar inside Autonomy', html.indexOf('div_menu_autonomy') < html.indexOf('id="div_calendar_events"')
    && html.indexOf('id="div_calendar_events"') < html.indexOf('id="div_menu_config"'));
const mv = read('map_view.js');
check('panel restored', /_openPanel === 'autonomy'/.test(mv));
check('Run gated', /VTAutonomy\.runGate/.test(mv));
check('frame', /autonomy: 'btn_autonomy'/.test(read('vt_frame.js')));
check('help', /autonomy: 'div_menu_autonomy'/.test(read('vt_help.js')));
const auto = read('vt_autonomy.js');
check('a manual refusal is report.reject', /S\.report\.reject/.test(auto));
['boot_grace', 'waiting_critical', 'waiting_rejected', 'waiting_gps', 'waiting_battery', 'waiting_weather', 'waiting_temp', 'waiting_temp_spike']
    .forEach((c) => check('mission ' + c, both('auto.check.mission.' + c)));
check('programs no_mow', both('auto.check.programs.no_mow'));
['sleep_countdown', 'no_mow'].forEach((c) => check('sentence ' + c, both('calmgr.code.' + c)));
['no_slot', 'run_open', 'countdown'].forEach((c) => check('why ' + c, both('auto.why.' + c)));
check('no window.confirm', !/\bconfirm\s*\(/.test(auto));

// calendar_manager in a sandbox
const box = { window: { VTI18n: { t: (k, v) => (en[k] || k).replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? v[n] : m)) } }, ROSLIB: {} };
box.VTI18n = box.window.VTI18n;
vm.createContext(box);
vm.runInContext(read('calendar_manager.js') + '\nthis.CM = CalendarManager;', box);
const p = box.CM.prototype;
check('temp spike is not green', p._codeLook('waiting_temp_spike')[1] === 'info');
check('waiting_slot stays green', p._codeLook('waiting_slot')[1] === 'ok');
check('login reason translated', p._awakeWhy('login:robert') === en['calmgr.awake.login']);
check('unknown reason readable', p._awakeWhy('some_new_thing') === 'some new thing');
check('sentence code wins', p._sentence({ code: 'x', detail: {}, sentence: { code: 'held', vars: {} } }) === en['calmgr.code.held']);
check('dock_intent_timeout issue reason translated',
    /calmgr\.issue\.reason\.dock_intent_timeout/.test(JSON.stringify(Object.keys(en))) && both('calmgr.issue.reason.dock_intent_timeout'));

// T22 (N6): the agent's advice reason as a code — every code of mow_advisor has
// a sentence in en + cs with the same placeholders, and the UI turns it into words
const holes = (x) => (x.match(/\{\w+\}/g) || []).sort().join();
const advPath = [process.env.AGENT_REPO && path.join(process.env.AGENT_REPO, 'src', 'vitulus_claude', 'agent', 'mow_advisor.py'),
    path.resolve(ROOT, '..', 'vitulus_agent', 'src', 'vitulus_claude', 'agent', 'mow_advisor.py')]
    .filter(Boolean).find((f) => fs.existsSync(f));
if (advPath) {
    const py = fs.readFileSync(advPath, 'utf8');
    const why = new Set(), items = new Set();
    py.replace(/conf,\s*'([a-z_]+)'/g, (m, c) => { why.add(c); return m; });
    py.replace(/code, wv = '([a-z_]+)'/g, (m, c) => { why.add(c); return m; });
    py.replace(/code, wv = '([a-z_]+)', \{/g, (m, c) => { why.add(c); return m; });
    py.replace(/'reason_code': '([a-z_]+)'/g, (m, c) => { why.add(c); return m; });
    py.replace(/\{'code': '([a-z_]+)'/g, (m, c) => { items.add(c); return m; });
    check('found the advice reason codes', why.size >= 10 && items.size >= 4, [...why, ...items].join());
    why.forEach((c) => check('advice reason ' + c, both('auto.t22.why.' + c)
        && holes(en['auto.t22.why.' + c]) === holes(cs['auto.t22.why.' + c])));
    items.forEach((c) => check('advice item ' + c, both('auto.t22.item.' + c)
        && holes(en['auto.t22.item.' + c]) === holes(cs['auto.t22.item.' + c])));
} else { console.log('NOTE mow_advisor.py not found (AGENT_REPO=…), advice reason codes not checked'); }
['recent', 'due'].forEach((c) => check('advice item ' + c, both('auto.t22.item.' + c)));

function sandbox(lang, file, extra) {
    const dict = lang === 'cs' ? cs : en;
    const tf = (k, v) => (dict[k] || en[k] || k).replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? v[n] : m));
    const w = Object.assign({ VTI18n: { t: tf, lang: () => lang, has: (k) => k in dict, onChange() {} } }, extra || {});
    const sb = { window: w, document: { getElementById: () => null, addEventListener() {} }, setTimeout, setInterval, clearInterval, location: { hash: '' } };
    Object.assign(sb, w);
    vm.createContext(sb);
    vm.runInContext(read(file), sb);
    return w;
}
['en', 'cs'].forEach((l) => {
    const A = sandbox(l, 'vt_autonomy.js').VTAutonomy;
    const r = A.adviceReason('rain_recent', { h: 1.5, need: 3 }, 'pršelo před 1.5 h (limit 3 h)');
    check(l + ': advice reason in the page language', l === 'en' ? /^it rained 1\.5\u00a0h ago/.test(r) : /^pršelo před 1,5\u00a0h/.test(r), r);
    const m = A.adviceReason('mow', { program: 'Front', items: [{ code: 'oldest', days: 5, interval: 4 }, { code: 'unfinished', zones: ['A', 'B'] }] }, 'x');
    check(l + ': mow reason with its items', /^Front: / .test(m) && /A, B/.test(m) && m.indexOf('; ') > 0, m);
    check(l + ': mow without items = its turn', A.adviceReason('mow', { program: 'Front', items: [] }, 'x') === 'Front: ' + (l === 'en' ? en : cs)['auto.t22.item.due']);
    check(l + ': old agent (words only) as before', A.adviceReason(undefined, undefined, 'pršelo') === 'pršelo');
    check(l + ': unknown code = the words', A.adviceReason('brand_new', {}, 'slova') === 'slova');
    check(l + ': dropped vars = the words, no hole', A.adviceReason('rain_recent', {}, 'slova') === 'slova');
    check(l + ': dock_why code in words', A.dockWhy('not_owner') === (l === 'en' ? en : cs)['auto.check.permit.not_owner']);
    check(l + ': dock_why old text as it is', A.dockWhy('majitel dok nepovolil') === 'majitel dok nepovolil');
    check(l + ': dock_why unknown code readable', A.dockWhy('brand_new') === 'brand new');
});

// T22 (T18 Q1): Activity row of an exit the window does not count (calendar / manual Undock)
['en', 'cs'].forEach((l) => {
    const acts = [];
    const hub = { get: (k) => (k === 'ui.actions' ? { data: { actions: acts } } : null) };
    const ACT = sandbox(l, 'vt_activity.js', { VTHub: hub }).VTActivity;
    const row = (ev) => { acts.length = 0; acts.push(Object.assign({ ts: '2026-11-08T23:16:00+0100', action: 'dock-permit', author: 'robot',
        ok: true, ref: 'p1794108289-3', seq: 7, event: 'exit', window: { id: 'p1794108289-3', exits: 0, max_exits: 1 } }, ev));
        return ACT._uiRows()[0]; };
    const d = l === 'en' ? en : cs;
    let r = row({ permitted: true, counted: false, agent: false });
    check(l + ': calendar exit says not counted', r.text === d['activity.permit.exit_cal'].replace('{id}', '#3') && r.state === 'ok', JSON.stringify(r));
    r = row({ permitted: false, counted: false, agent: false });
    check(l + ': calendar exit outside an open window is no warning', r.state === 'ok' && r.text === d['activity.permit.exit_cal'].replace('{id}', '#3'), JSON.stringify(r));
    r = row({ permitted: true, counted: true, agent: true, window: { id: 'p1794108289-3', exits: 1, max_exits: 1 } });
    check(l + ': agent exit counted n/max', r.text === d['activity.permit.exit'].replace('{id}', '#3').replace('{n}', 1).replace('{max}', 1), r.text);
    r = row({ permitted: true });
    check(l + ': old node (no counted) as before', r.text === d['activity.permit.exit'].replace('{id}', '#3').replace('{n}', 0).replace('{max}', 1), r.text);
    r = row({ permitted: false, counted: false, agent: true });
    check(l + ': agent exit without an open window warns', r.state === 'warn' && r.text === d['activity.permit.exit_un'], JSON.stringify(r));
});
console.log(fails ? 'FAILED ' + fails : 'OK — Autonomy texts and wiring');
process.exit(fails ? 1 : 0);
