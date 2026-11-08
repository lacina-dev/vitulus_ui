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
console.log(fails ? 'FAILED ' + fails : 'OK — Autonomy texts and wiring');
process.exit(fails ? 1 : 0);
