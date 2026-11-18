#!/usr/bin/env node
/*
 * T17 batch M17 (2026-11-17):
 *     node tools/test_map_m17.node.js
 *   1. the order of the page's requests to rosbridge (map_view.js vtStartOrder): safety first,
 *      the rest after the TF topic in batches, settings' advertise lazily — against the real
 *      list of what the page sends (tools/fixtures_start_ops.json); nothing lost, nothing twice,
 *      an advertise always before its publish, a publish / service call never held;
 *   2. the TF request right after a reconnect (was +500 ms), asked once more without an answer;
 *   3. the robot's colours by events (no 700 ms timer);
 *   4. the scale's poll rests when nothing changes, stops in a hidden tab;
 *   5. the pill's note mark and the 4 s threshold.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TPL = path.join(ROOT, 'nodes', 'templates');
const JS = path.join(TPL, 'assets', 'js');
const rd = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"])\/\/ .*$/gm, '$1');
let fails = 0, count = 0;
function check(name, ok, info) {
    count++;
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + (typeof info === 'string' ? info : JSON.stringify(info))));
    if (!ok) { fails++; }
}
function sliceAt(src, start) {
    let depth = 0;
    const open = src.indexOf('{', start);
    for (let j = open; j < src.length; j++) {
        if (src[j] === '{') { depth++; } else if (src[j] === '}') { depth--; if (!depth) { return src.slice(start, j + 1); } }
    }
    throw new Error('braces');
}
function fn(name, src) {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) { throw new Error(name + ' not found'); }
    return sliceAt(src, i);
}
const mv = rd(JS, 'map_view.js');
const FIX = JSON.parse(rd(ROOT, 'tools', 'fixtures_start_ops.json')).ops;

// ---- 1. the order ------------------------------------------------------------
const orderSrc = mv.slice(mv.indexOf('var VT_ORDER_BATCH'), mv.indexOf('class ROS {'));
function mkOrder() {
    let now = 0, timers = [], tid = 0;
    const sent = [], handlers = {}, refused = [];
    const Ros = function () { this.socket = null; };
    Ros.prototype.callOnConnection = function (m) { sent.push({ t: now, m }); };
    const ros = new Ros();
    ros.on = (ev, f) => { (handlers[ev] = handlers[ev] || []).push(f); };
    const later = (f, ms) => { timers.push({ id: ++tid, at: now + ms, f }); return tid; };
    const unlater = (id) => { timers = timers.filter((x) => x.id !== id); };
    const api = new Function('ros', 'o', orderSrc + '\nreturn { order: vtStartOrder(ros, o), cls: vtOrderClass, BATCH: VT_ORDER_BATCH, GAP: VT_ORDER_GAP_MS, HOLD: VT_ORDER_HOLD_MS };')(
        ros, { now: () => now, later, unlater });
    const run = (until) => {
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            if (!timers.length || timers[0].at > until) { break; }
            const x = timers.shift(); now = x.at; x.f();
        }
        now = until;
    };
    // the next timer fires `late` ms after it was due (a busy page)
    const fireLate = (late) => { timers.sort((a, b) => a.at - b.at); const x = timers.shift(); now = x.at + late; x.f(); };
    return { ros, sent, refused, api, run, fireLate, at: () => now, timers: () => timers.length,
        connect() { ros.socket = { readyState: 1 }; (handlers.connection || []).forEach((f) => f()); },
        close() { ros.socket = null; (handlers.close || []).forEach((f) => f()); },
        send(op, topic, extra) { return ros.callOnConnection(Object.assign({ op, topic, id: op + ':' + topic }, extra || {})); },
        names: (f) => sent.filter((x) => !f || f(x)).map((x) => x.m.op + ' ' + (x.m.topic || x.m.service)) };
}
const key = (x) => x.m.op + ' ' + x.m.topic;
{
    const K = mkOrder(), cls = K.api.cls;
    const advs = FIX.filter((x) => x[0] === 'advertise').map((x) => x[1]), subs = FIX.filter((x) => x[0] === 'subscribe').map((x) => x[1]);
    check('fixture: what the page sends at its start (' + advs.length + ' advertise, ' + subs.length + ' subscribe)', advs.length > 100 && subs.length > 100);
    const by = (list, op, c) => list.filter((t) => cls(op, t) === c);
    const A = by(advs, 'advertise', 'A'), B = by(advs, 'advertise', 'B'), D = by(advs, 'advertise', 'D');
    console.log('     advertise: A (at once) ' + A.length + ' · B (ahead, in batches) ' + B.length + ' · D (last) ' + D.length +
        ' | subscribe: A ' + by(subs, 'subscribe', 'A').length + ' · B ' + by(subs, 'subscribe', 'B').length + ' · C ' + by(subs, 'subscribe', 'C').length);
    check('order: no lazy advertise any more (review of M17: rosbridge keeps a new publisher\'s first messages 1 s only)', !/VT_ORDER_LAZY|lazy\[/.test(orderSrc) && !('lazy_waiting' in K.api.order.stats()));
    // the stops of vt_link.js (the link guard's own list) are safety here
    const link = rd(JS, 'vt_link.js');
    const stopBool = [...sliceAt(link, link.indexOf('var STOP_BOOL = ')).matchAll(/'(\/[a-z_\/]+)':/g)].map((m) => m[1]);
    check('order: every STOP topic of vt_link.js (STOP_BOOL, ' + stopBool.length + ') is advertised at once', stopBool.length >= 5 && stopBool.every((t) => cls('advertise', t) === 'A'), stopBool.filter((t) => cls('advertise', t) !== 'A'));
    check('order: every cancel and every cmd_vel too (also ones nobody listed)', ['/move_base_flex/exe_path/cancel', '/move_base_flex/move_base/cancel', '/move_base/cancel', '/smach_goal/cancel', '/teleop/cmd_vel', '/cmd_vel', '/joy/cmd_vel'].every((t) => cls('advertise', t) === 'A'));
    check('order: motors, torque, blade, power switch, sleep', ['/base/motor_power', '/set_motor_switch', '/pm/set_motor_switch', '/base/set_torque', '/mower/set_power', '/mower/set_motor_on', '/mower/set_cmd', '/pm/set_bat_out_switch', '/pm/set_robot_sleep'].every((t) => A.includes(t)));
    check('order: the CANCEL of a sleep is safety — /pm/set_sleep_until_charged (vt_autonomy.js sends false) and /scheduler/sleep_cancel are advertised at once',
        cls('advertise', '/pm/set_sleep_until_charged') === 'A' && cls('advertise', '/scheduler/sleep_cancel') === 'A' && A.includes('/pm/set_sleep_until_charged') &&
        /pub\('\/pm\/set_sleep_until_charged', 'std_msgs\/Bool', false\)/.test(rd(JS, 'vt_autonomy.js')));
    // class D: only what is no command at all
    const g0 = {}; new Function('window', 'globalThis', rd(JS, 'vt_link.js'))(g0, g0);
    const kindOf = g0.VTLink.kind;
    check('order: put off (D, ' + D.length + ') is only read-only plumbing — exactly what vt_link.js calls plumbing; nothing it calls an action, a stop, a drive or a query',
        D.length >= 2 && D.length <= 4 && D.every((t) => kindOf({ op: 'publish', topic: t, msg: { data: true } }) === 'plumbing'), D.map((t) => [t, kindOf({ op: 'publish', topic: t, msg: { data: true } })]));
    check('order (M19 + A762): at once goes only what stops, switches off or cancels (' + A.length + '); the main commands right behind the TF topic (' + by(advs, 'advertise', 'Q').length + '); every other command is put off behind the subscriptions (' + by(advs, 'advertise', 'P').length + ') and advertised on demand; plumbing last (' + D.length + ')',
        A.length >= 15 && A.length <= 25 && by(advs, 'advertise', 'Q').length >= 15 && by(advs, 'advertise', 'Q').length <= 25 && A.length + by(advs, 'advertise', 'Q').length + by(advs, 'advertise', 'P').length + D.length === advs.length && advs.every((t) => kindOf({ op: 'publish', topic: t, msg: { data: true } }) !== 'plumbing' || cls('advertise', t) === 'D'), [A.length, D.length]);
    check('order (M19): everything vt_link.js itself calls a stop is at once: its STOP_BOOL topics with their stopping value, every cancel, a zero cmd_vel',
        stopBool.every((t) => cls('advertise', t) === 'A') && ['/smach_goal/cancel', '/move_base_flex/exe_path/cancel', '/teleop/cmd_vel'].every((t) => cls('advertise', t) === 'A') &&
        kindOf({ op: 'publish', topic: '/mower_smach/stop', msg: { data: true } }) === 'stop' && kindOf({ op: 'publish', topic: '/smach_goal/cancel', msg: {} }) === 'stop');
    check('order (M19): settings, saving and managing are put off (advertised by themselves after the subscriptions, on demand at once): scheduler, power module, maps / paths / programs, dock manager, mapping',
        ['/scheduler/set_mode', '/scheduler/set_window', '/scheduler/set_calendar', '/scheduler/set_settings', '/scheduler/ignore_rain_once', '/scheduler/clear_issues',
         '/pm/set_sleep_time', '/pm/set_sleep_wait_before_standby', '/pm/set_charge_current_running', '/pm/set_temp_setpoint', '/pm/set_standby_timeout_discharging',
         '/navi_manager/save_map', '/navi_manager/save_path', '/navi_manager/save_path_point', '/navi_manager/save_waypoint', '/navi_manager/load_map', '/navi_manager/load_map_rtabmap', '/navi_manager/remove_map',
         '/navi_manager/remove_point', '/navi_manager/remove_path', '/navi_manager/new_map', '/web_plan/program_new', '/web_plan/program_remove', '/dock_manager/enable_map', '/dock_manager/save_dock_program',
         '/mapping_manager/remove_site', '/mapping/save', '/mapping/set_band'].every((t) => cls('advertise', t) === 'P' && advs.includes(t)));
    const MAIN_N = 20;
    const MAIN = ['/navi_manager/goal_point', '/navi_manager/interactive_marker_goal', '/navi_manager/execute_path', '/navi_manager/start_new_autopath', '/navi_manager/speed',
        '/dock_detector/dock', '/dock_detector/undock', '/dock_detector/intensity/dock', '/dock_detector/intensity/undock', '/undock_intensity', '/dock_smach/start_docking',
        '/web_plan/program_select', '/web_plan/program_select_resume', '/mower_smach/reset', '/scheduler/run_next', '/scheduler/set_enabled',
        '/mower/set_cut_height', '/mower/set_motor_rpm', '/mower/set_motor_dir', '/mapping_manager/start'];
    check('order (A762): the main commands (' + MAIN.length + ') — go and navigation, dock / undock, program select / start, mower, mapping start, scheduler on / off — are the priority group, each really advertised by the page',
        MAIN.every((t) => cls('advertise', t) === 'Q' && advs.includes(t)) && by(advs, 'advertise', 'Q').length === MAIN.length, MAIN.filter((t) => cls('advertise', t) !== 'Q' || !advs.includes(t)));
    check('order (A762): motors, blade and mower power are not in it only because they are stops (at once)', ['/base/motor_power', '/mower/set_motor_on', '/mower/set_power', '/mapping_manager/stop'].every((t) => cls('advertise', t) === 'A'));
    check('order (M19): rare commands stay put off (on demand): apply a localisation estimate, set the dock pose', cls('advertise', '/gloc/apply') === 'P' && cls('advertise', '/nav_tf/set_dock_pose') === 'P');
    check('order (M19): a topic nobody listed is put off like any command; a new stop / cancel / cmd_vel goes at once', cls('advertise', '/some/new_command') === 'P' && cls('advertise', '/some/new/stop') === 'A' && cls('advertise', '/x/cancel') === 'A' && cls('advertise', '/some/cmd_vel') === 'A' && cls('advertise', '/mapping_manager/stop') === 'A');
    check('order: states of motors / STOP / mux / mower / dock / power and the TF topic are subscribed at once',
        ['/base/motor_power_state', '/cmd_vel_mux/active', '/mower_smach/status', '/mower_smach/busy', '/mower_smach/stop', '/mower/status', '/mower/link', '/mower/set_motor_on', '/dock_smach/dock_status',
         '/dock_manager/is_in_dock_confirmed', '/pm/power_status', '/device_state_pub/icon_status', '/move_base_flex/exe_path/status', '/tf2_web_republisher/tf_repub_7'].every((t) => cls('subscribe', t) === 'A') &&
        ['/base/motor_power_state', '/mower_smach/status', '/dock_smach/dock_status'].every((t) => subs.includes(t)));
    check('order: the first picture (base map, footprint, localisation) leads the batches; the scan, clouds, logs are the rest', ['/navi_manager/map', '/move_base_flex/local_costmap/footprint', '/nav_tf/loc_status'].every((t) => cls('subscribe', t) === 'B') &&
        ['/scan', '/ground_cloud', '/obstacles_cloud', '/rosout_agg', '/scheduler/journal'].every((t) => cls('subscribe', t) === 'C'));

    // the page's start replayed: the burst of vt_ros_share.js on connection, then the page's queued calls with the TF request
    K.connect();
    FIX.forEach((x) => {
        if (x[0] === 'advertise' || x[0] === 'subscribe') { K.send(x[0], x[1]); }
        else if (x[0] === 'call_service') { K.ros.callOnConnection({ op: 'call_service', service: x[1] }); }
        else if (x[0] === 'publish') { K.send('publish', x[1]); }
    });
    const first = K.sent.slice();
    const idx = (f) => first.findIndex(f) + 1;
    const iTf = idx((x) => x.m.service === '/republish_tfs');
    check('start: the TF request is the ' + iTf + 'th request on the wire (was the 249th of 255)', iTf > 0 && iTf <= 150, iTf);
    const nAS = first.filter((x) => x.m.op === 'advertise' || x.m.op === 'subscribe').length;
    check('start: before the position is on its way only class A is on the wire, plus the advertise the page\'s own first publishes took out on demand (' + nAS + ' advertise + subscribe, was 227)', nAS <= 40 &&
        first.filter((x) => x.m.op === 'advertise' || x.m.op === 'subscribe').every((x) => cls(x.m.op, x.m.topic) === 'A' || ['/web_plan/reload', '/dock_manager/send_programs'].includes(x.m.topic)), nAS);
    const before = (t) => FIX.findIndex((x) => x[1] === t && x[0] !== 'publish') + 1;
    const lateNow = ['/base/motor_power', '/pm/set_motor_switch', '/mower_smach/stop', '/dock_smach/stop', '/smach_goal/cancel', '/move_base_flex/exe_path/cancel', '/mower/set_motor_on',
        '/base/motor_power_state', '/cmd_vel_mux/active', '/mower_smach/status', '/dock_smach/dock_status', '/mower/status', '/pm/set_sleep_until_charged', '/scheduler/sleep_cancel'].filter((t) => idx((x) => x.m.topic === t && x.m.op !== 'publish') > before(t));
    check('start: no STOP / motor / sleep-cancel advertise and no motor / STOP state is later in the line than it was', lateNow.length === 0, lateNow.map((t) => [t, before(t), idx((x) => x.m.topic === t)]));
    console.log('     place in the line, was → is: /base/motor_power ' + before('/base/motor_power') + ' → ' + idx((x) => x.m.topic === '/base/motor_power') +
        ' · /mower_smach/stop ' + before('/mower_smach/stop') + ' → ' + idx((x) => x.m.topic === '/mower_smach/stop' && x.m.op === 'advertise') +
        ' · /dock_smach/stop ' + before('/dock_smach/stop') + ' → ' + idx((x) => x.m.topic === '/dock_smach/stop') +
        ' · /pm/set_sleep_until_charged ' + before('/pm/set_sleep_until_charged') + ' → ' + idx((x) => x.m.topic === '/pm/set_sleep_until_charged') +
        ' · /base/motor_power_state ' + before('/base/motor_power_state') + ' → ' + idx((x) => x.m.topic === '/base/motor_power_state') +
        ' · /dock_smach/dock_status ' + before('/dock_smach/dock_status') + ' → ' + idx((x) => x.m.topic === '/dock_smach/dock_status'));
    check('start: publishes and service calls passed at once, in their order (the page\'s own "send again" topics are class A: never kept back)', JSON.stringify(first.filter((x) => x.m.op === 'publish' || x.m.op === 'call_service').map((x) => x.m.topic || x.m.service)) ===
        JSON.stringify(FIX.filter((x) => x[0] === 'publish' || x[0] === 'call_service').map((x) => x[1])));
    ['/web_plan/reload', '/dock_manager/send_programs'].forEach((t) => {
        const ia = first.findIndex((x) => x.m.op === 'advertise' && x.m.topic === t), ip = first.findIndex((x) => x.m.op === 'publish' && x.m.topic === t);
        check('start: ' + t + ' — advertised before its first publish, as before M17', ia >= 0 && ip > ia, [ia, ip]);
    });
    // M19: the order on the wire — stops' advertise, then the TF request, the other advertisements only after the TF topic
    {
        const stopsAdv = first.map((x, i) => [i + 1, x]).filter(([i, x]) => x.m.op === 'advertise' && cls('advertise', x.m.topic) === 'A');
        check('order on the wire (M19): every stop advertise (' + stopsAdv.length + ') goes out before the TF request (#' + iTf + ')', stopsAdv.length >= 15 && stopsAdv.every(([i]) => i < iTf), stopsAdv.filter(([i]) => i >= iTf).map(([i, x]) => x.m.topic));
        const others = first.filter((x) => x.m.op === 'advertise' && cls('advertise', x.m.topic) !== 'A').map((x) => x.m.topic);
        check('order on the wire (M19): no other advertise before the TF topic is subscribed — but the two the page itself published on at once (on demand)', others.sort().join() === '/dock_manager/send_programs,/web_plan/reload', others);
    }
    // nothing more goes while the TF answer is not there …
    K.run(1000);
    check('start: while the TF answer is on its way nothing else is put in rosbridge\'s queue', K.sent.length === first.length);
    // … the answer comes: the TF topic is subscribed at once and the rest starts, in batches
    const n0 = K.sent.length, t0 = K.at();
    K.send('subscribe', '/tf2_web_republisher/tf_repub_3');
    check('start: the TF topic\'s subscribe goes at once', K.sent.length === n0 + 1 && K.sent[n0].m.topic === '/tf2_web_republisher/tf_repub_3');
    K.run(t0 + 1);
    check('start: then the first batch (' + K.api.BATCH + ')', K.sent.length === n0 + 1 + K.api.BATCH, K.sent.length - n0);
    K.run(t0 + K.api.GAP - 1); const nb = K.sent.length; K.run(t0 + K.api.GAP + 1);
    check('start: … one batch per ' + K.api.GAP + ' ms', nb === n0 + 1 + K.api.BATCH && K.sent.length === n0 + 1 + 2 * K.api.BATCH);
    // a safety request in the middle of it: at once
    const n1 = K.sent.length; K.send('subscribe', '/tf2_web_republisher/tf_repub_4');
    check('start: a safety request that comes while the batches run goes at once', K.sent.length === n1 + 1);
    K.run(t0 + 60000);
    const rest = K.sent.slice(n0 + 1).filter((x) => !/tf_repub/.test(x.m.topic || ''));
    const order = rest.map((x) => ({ Q: '0', B: '1', C: '3' }[cls(x.m.op, x.m.topic)] || '4')).join('');
    check('start (A762): behind the TF topic the main commands\' advertise (0), the first picture (1), the rest of the subscriptions (3), then the put-off advertisements (4)', /^0+1+3+4+$/.test(order), order.replace(/(.)\1+/g, (m, c) => c + '×' + m.length + ' '));
    const tOf = (f) => { const r = rest.filter(f); return r.length ? r[r.length - 1].t - t0 : null; };
    const tB = 0, tC = tOf((x) => x.m.op === 'subscribe'), tEnd = rest[rest.length - 1].t - t0;
    console.log('     after the TF topic: last subscribe ' + tC + ' ms · last advertise of all (D) ' + tEnd + ' ms (timers on time)');
    const isQ = (x) => cls('advertise', x.m.topic) === 'Q';
    const qT = rest.filter((x) => x.m.op === 'advertise' && isQ(x)).map((x) => x.t - t0);
    check('start (A762): all the main commands are advertised ' + Math.max(...qT) + ' ms after the TF topic\'s subscribe (≤ 450 ms), before any other subscription', qT.length === MAIN_N && Math.max(...qT) <= 450 && order.indexOf('1') === qT.length, [qT.length, Math.max(...qT)]);
    const advT = rest.filter((x) => x.m.op === 'advertise' && !isQ(x)).map((x) => x.t - t0), perAdv = {}; rest.filter((x) => x.m.op === 'advertise' && !isQ(x)).forEach((x) => { perAdv[x.t] = (perAdv[x.t] || 0) + 1; });
    check('start (M19): the subscriptions are out ' + tC + ' ms after the TF topic (never more than ' + K.api.BATCH + ' per ' + K.api.GAP + ' ms); the put-off advertisements start 1 s after the last of them and go 2 per ' + K.api.GAP + ' ms, all out by themselves after ' + tEnd + ' ms',
        tC <= 2500 && advT[0] >= tC + 1000 && Math.max(...Object.values(perAdv)) <= 2 && tEnd <= 12000 &&
        (() => { const per = {}; rest.forEach((x) => { per[x.t] = (per[x.t] || 0) + 1; }); return Math.max(...Object.values(per)) <= K.api.BATCH; })(), [tC, advT[0], tEnd]);
    // nothing lost, nothing twice — EVERY advertise and subscribe of the page
    const wire = K.sent.filter((x) => x.m.op === 'advertise' || x.m.op === 'subscribe').map(key);
    const want = FIX.filter((x) => x[0] === 'subscribe' || x[0] === 'advertise').map((x) => x[0] + ' ' + x[1]);
    const missing = want.filter((k) => !wire.includes(k)), twice = wire.filter((k, i) => wire.indexOf(k) !== i);
    check('start: every subscribe and EVERY advertise of the page went out exactly once, with no use needed (' + want.length + ')', missing.length === 0 && twice.length === 0, { missing: missing.slice(0, 5), twice: twice.slice(0, 5) });
    const stt = K.api.order.stats();
    check('start: nothing is left waiting, no timer runs', stt.waiting === 0 && K.timers() === 0, stt);
    console.log('     on the wire in the first moments: ' + first.length + ' requests (was ' + FIX.length + '); advertise + subscribe in all: ' + wire.length + ' (as before: ' + want.length + ')');

    // later life
    const n2 = K.sent.length; K.send('subscribe', '/some/layer');
    check('later: a single subscribe on a quiet link goes at once (a layer switched on is not slowed)', K.sent.length === n2 + 1);
    const n3 = K.sent.length; K.send('publish', '/scheduler/set_calendar', { msg: { data: 'x' } });
    check('later: a command on a topic advertised long ago goes at once, alone', K.sent.length === n3 + 1 && key(K.sent[n3]) === 'publish /scheduler/set_calendar');
    // a reconnect: everything again (vt_ros_share.js)
    K.close(); K.connect();
    const n4 = K.sent.length;
    FIX.forEach((x) => { if (x[0] === 'advertise' || x[0] === 'subscribe') { K.send(x[0], x[1]); } });
    const again = K.sent.slice(n4).map(key);
    check('reconnect: the stops and the states again at once, the rest waits for the TF topic', again.includes('advertise /base/motor_power') && again.includes('subscribe /base/motor_power_state') && again.includes('advertise /pm/set_sleep_until_charged') && again.includes('advertise /dock_smach/stop') &&
        !again.includes('advertise /dock_detector/dock') && !again.includes('advertise /scheduler/set_calendar') && !again.includes('subscribe /scan') && !again.includes('advertise /interactive_marker/feedback'), again.length);
    // the TF answer never comes: the hold runs out
    K.run(K.at() + K.api.HOLD - 10); const n5 = K.sent.length; K.run(K.at() + 20);
    check('reconnect: no TF answer → the rest starts after ' + K.api.HOLD + ' ms anyway', n5 === K.sent.length - K.api.BATCH && n5 === n4 + again.length, [n4 + again.length, n5, K.sent.length]);
    K.run(K.at() + 30000);
    const w2 = K.sent.slice(n4).filter((x) => x.m.op === 'advertise' || x.m.op === 'subscribe').map(key);
    check('reconnect: … and again everything goes out once', want.every((k) => w2.includes(k)) && w2.length === want.length, [w2.length, want.length]);
    // the link drops in the middle: what waits is forgotten (it is sent again on the next connection)
    K.close(); K.connect(); FIX.forEach((x) => { if (x[0] === 'subscribe') { K.send(x[0], x[1]); } });
    K.close(); const n6 = K.sent.length; K.run(K.at() + 10000);
    check('close: what waited is forgotten, no timer left', K.sent.length === n6 && K.timers() === 0 && K.api.order.stats().waiting === 0);
}
{
    // ---- no queue of commands, nothing refused, nothing kept: a publish always passes at the press (review A668) ----
    const K = mkOrder();
    check('commands: this function keeps no publish back and refuses none (no queue, no timer for a publish, no wait)', !/pubHeld|PUB_WAIT|releasePub|putOff|onRefuse|READY_MS/.test(orderSrc));
    K.connect();
    const cmds = ['/dock_detector/undock', '/navi_manager/goal_point', '/navi_manager/save_map', '/scheduler/set_calendar', '/vitulus_rosbag/d435/record', '/gloc/compute', '/mapping_manager/start', '/base/motor_power', '/mower_smach/stop', '/pm/set_sleep_until_charged'];
    cmds.forEach((t) => K.send('advertise', t)); K.send('advertise', '/interactive_marker/feedback');
    K.send('subscribe', '/scan');
    check('commands (M19): at the connection only the stops\' advertise is on the wire; the other commands\' advertise waits',
        K.names().join() === ['/base/motor_power', '/mower_smach/stop', '/pm/set_sleep_until_charged'].map((t) => 'advertise ' + t).join());
    let n = K.sent.length;
    K.run(300);
    // STOPs first: at once, alone
    K.send('publish', '/mower_smach/stop', { msg: { data: true } }); K.send('publish', '/pm/set_sleep_until_charged', { msg: { data: false } }); K.send('publish', '/base/motor_power', { msg: { data: false } }); K.send('publish', '/teleop/cmd_vel', { msg: {} });
    check('commands: a STOP, the sleep cancel, motors off, a cmd_vel in the first ms → at once, alone (their advertise went first)', K.sent.length === n + 4 && K.sent.slice(n).every((x) => x.m.op === 'publish' && x.t === 300));
    // a command whose advertise still waits: advertise on demand, then the command, both NOW
    const acts = ['/dock_detector/undock', '/navi_manager/goal_point', '/navi_manager/save_map', '/scheduler/set_calendar', '/vitulus_rosbag/d435/record', '/gloc/compute', '/mapping_manager/start'];
    n = K.sent.length; acts.forEach((t) => K.send('publish', t, { msg: { data: true } }));
    const pairs = acts.every((t, i) => key(K.sent[n + 2 * i]) === 'advertise ' + t && key(K.sent[n + 2 * i + 1]) === 'publish ' + t);
    check('commands (M19): a command pressed before its topic is advertised → its advertise goes out on demand and the command right behind it, both at the moment of the press, nothing in between, nothing kept',
        K.sent.length === n + 2 * acts.length && pairs && K.sent.slice(n).every((x) => x.t === 300) && K.timers() === 1 /* only the hold */, [K.sent.length - n, K.timers()]);
    n = K.sent.length; acts.forEach((t) => K.send('publish', t, { msg: { data: true } }));
    check('commands: the next command on the same topic goes alone (advertised once)', K.sent.length === n + acts.length && K.sent.slice(n).every((x) => x.m.op === 'publish'));
    // plumbing published while its advertise waits: the advertise goes ahead, both at once
    n = K.sent.length; K.send('publish', '/interactive_marker/feedback', { msg: {} });
    check('plumbing: a publish whose (put-off) advertise still waits → the advertise, then the publish, at once', K.sent.length === n + 2 && key(K.sent[n]) === 'advertise /interactive_marker/feedback' && K.sent[n + 1].m.op === 'publish' && K.sent[n + 1].t === 300);
    K.run(60000);
    check('commands: what was advertised on demand is not advertised again by the batches', acts.every((t) => K.sent.filter((x) => key(x) === 'advertise ' + t).length === 1));
    // a topic the page advertises only at the click, long after the start: straight through, as before M17
    K.send('subscribe', '/tf2_web_republisher/tf_repub_1'); K.run(120000);
    n = K.sent.length; K.send('advertise', '/vt_terrain/some_cmd'); K.send('publish', '/vt_terrain/some_cmd', { msg: {} });
    check('commands: a topic advertised at the click long after the start is not held (advertise, publish at once — as before M17)', K.sent.length === n + 2 && K.sent.slice(n).map((x) => x.m.op).join() === 'advertise,publish' && K.sent[n + 1].t === 120000);
}
{
    // ---- with the real link guard (vt_link.js) behind it, as on the page: the race with a STOP, a late command ----
    const mkBoth = () => {
        let now = 100000, timers = [], tid = 0;
        const wire = [], handlers = {}, drops = [], refused = [];
        const g = {};
        new Function('window', 'globalThis', rd(JS, 'vt_link.js'))(g, g);
        const later = (f, ms) => { timers.push({ id: ++tid, at: now + ms, f }); return tid; };
        const unlater = (id) => { timers = timers.filter((x) => x.id !== id); };
        const every = (f, ms) => { const id = ++tid; (function a() { timers.push({ id, at: now + ms, f: () => { f(); a(); } }); }()); return id; };
        const Ros = function () { this.socket = null; this.isConnected = false; };
        Ros.prototype.callOnConnection = function (m) { this.sendEncodedMessage(JSON.stringify(m)); };
        const ros = new Ros();
        ros.on = (ev, f) => { (handlers[ev] = handlers[ev] || []).push(f); };
        ros.once = ros.on; ros.off = () => {}; ros.emit = (ev, a) => (handlers[ev] || []).forEach((f) => f(a));
        new Function('ros', 'o', orderSrc + '\nreturn vtStartOrder(ros, o);')(ros, { now: () => now, later, unlater });
        g.VTLink.install(ros, { now: () => now, later, every, onDrop: (i) => drops.push({ t: now, i }) });
        let rx = null;
        const run = (until) => { for (;;) { timers.sort((a, b) => a.at - b.at); if (!timers.length || timers[0].at > until) { break; } const x = timers.shift(); now = x.at; x.f(); } now = until; };
        const K = { ros, wire, drops, refused, run, at: () => now,
            connect() { const sk = { readyState: 1, send: (e) => { wire.push({ t: now, m: JSON.parse(e) }); }, addEventListener: (t, f) => { rx = f; }, removeEventListener() {}, close() {} };
                ros.socket = sk; ros.isConnected = true; ros.emit('connection'); },
            close() { ros.socket = null; ros.isConnected = false; ros.emit('close'); },
            frame() { if (rx) { rx(); } },
            frames(until) { while (now < until) { run(Math.min(until, now + 50)); K.frame(); } },
            send(op, topic, msg) { return ros.callOnConnection({ op, topic, id: op + ':' + topic, msg }); },
            pubs: (t0) => wire.filter((x) => x.m.op === 'publish').map((x) => (x.t - t0) + ' ' + x.m.topic) };
        return K;
    };
    const ACTIONS = ['/dock_detector/undock', '/dock_detector/dock', '/navi_manager/goal_point', '/web_plan/program_select', '/scheduler/run_next', '/dock_smach/start_docking', '/mapping_manager/start', '/navi_manager/save_map', '/vitulus_rosbag/d435/record'];
    const STOPS = [['/dock_smach/stop', { data: true }], ['/mower_smach/stop', { data: true }], ['/base/motor_power', { data: false }]];
    // the reviewer's scenario: Undock 300 ms after the connection, the big STOP at 500 ms
    ACTIONS.forEach((act) => {
        const K = mkBoth(); K.connect(); const t0 = K.at();
        ACTIONS.concat(STOPS.map((x) => x[0])).forEach((t) => K.send('advertise', t));
        K.frames(t0 + 300); K.send('publish', act, { data: true });
        K.frames(t0 + 500); STOPS.forEach((x) => K.send('publish', x[0], x[1]));
        K.frames(t0 + 10000);
        const p = K.pubs(t0), iStop = p.findIndex((x) => / \/dock_smach\/stop$/.test(x)), after = p.slice(iStop).filter((x) => x.endsWith(' ' + act));
        check('race with STOP: ' + act + ' pressed at 300 ms, STOP at 500 ms → nothing of the command goes out after the STOP (it went at the press, or not at all)',
            iStop >= 0 && after.length === 0 && p.filter((x) => x.endsWith(' ' + act)).every((x) => x === '300 ' + act) && STOPS.every((x) => p.includes('500 ' + x[0])), p);
    });
    // M19, after a reconnect: STOP in the first ms and a command ahead of its advertise, with the real link guard
    {
        const K = mkBoth(); K.connect(); const t0 = K.at();
        const all = ACTIONS.concat(STOPS.map((x) => x[0]));
        all.forEach((t) => K.send('advertise', t)); K.frames(t0 + 1500);
        K.close(); K.run(t0 + 3000); K.connect(); const t1 = K.at();
        all.forEach((t) => K.send('advertise', t));                 // vt_ros_share.js: everything again on the new socket
        STOPS.forEach((x) => K.send('publish', x[0], x[1]));         // STOP in the first ms of the new connection
        K.frames(t1 + 200); K.send('publish', '/dock_detector/undock', { data: true });
        K.frames(t1 + 9000);
        const w = K.wire.filter((x) => x.t >= t1).map((x) => (x.t - t1) + ' ' + x.m.op + ' ' + x.m.topic);
        check('reconnect (M19): the stops\' advertise and a STOP pressed in the first ms go out at 0 ms, the STOP after its advertise', STOPS.every((x) => w.indexOf('0 advertise ' + x[0]) >= 0 && w.indexOf('0 publish ' + x[0]) > w.indexOf('0 advertise ' + x[0])), w.slice(0, 8));
        const ia = w.indexOf('200 advertise /dock_detector/undock');
        check('reconnect (M19): a command 200 ms after the reconnect, its topic not advertised yet → advertise on demand and the command right behind it, both at 200 ms (through the link guard)', ia >= 0 && w[ia + 1] === '200 publish /dock_detector/undock' && w.filter((x) => / advertise \/dock_detector\/undock$/.test(x)).length === 1, w.filter((x) => /undock/.test(x)));
    }
    // a late command: the age counts from the press (the link guard gets it at the press)
    {
        const K = mkBoth(); K.connect(); const t0 = K.at();
        K.send('advertise', '/dock_detector/undock'); K.frames(t0 + 300); const tp = K.at();
        K.send('publish', '/dock_detector/undock', { data: true });
        K.frames(tp + 100); K.run(tp + 2300); K.frame(); K.run(tp + 6000);
        const p = K.pubs(tp);
        check('late command: press, the network silent from 0.1 s to 2.3 s after it → the command went at the press (0 ms) or not at all; nothing goes out 2.3 s later', p.every((x) => x === '0 /dock_detector/undock'), p);
    }
    {
        const K = mkBoth(); K.connect(); const t0 = K.at();
        K.send('advertise', '/dock_detector/undock'); K.frames(t0 + 300); const tp = K.at();
        K.send('publish', '/dock_detector/undock', { data: true });
        K.frames(tp + 1400); K.close(); K.run(tp + 3300); K.connect(); K.send('advertise', '/dock_detector/undock'); K.frames(tp + 9000);
        const p = K.pubs(tp);
        check('late command: the link closes 1.4 s after the press, a new one 3.3 s after it → nothing of the command goes out on the new link', p.every((x) => x === '0 /dock_detector/undock'), p);
    }
    {
        // pressed in silence right after the connection: the link guard's own rule decides (told, never late)
        const K = mkBoth(); K.connect(); const t0 = K.at();
        K.send('advertise', '/dock_detector/undock'); K.frames(t0 + 300); K.run(t0 + 3000);     // 2.7 s without a frame
        const tp = K.at(); K.send('publish', '/dock_detector/undock', { data: true }); K.run(tp + 8000);
        const late = K.pubs(tp).filter((x) => +x.split(' ')[0] > 1000);
        check('late command: pressed on a silent link → never sent later than 1 s after the press (the link guard\'s rule, counted from the press)', late.length === 0, K.pubs(tp));
    }
}
{
    // edges
    const K = mkOrder();
    K.send('publish', '/interactive_marker/feedback');                         // plumbing published while the link is down (vt_link.js decides what happens to it)
    check('edge: a publish while the link is down passes to the link guard at once', K.names().join() === 'publish /interactive_marker/feedback');
    K.connect();
    K.send('advertise', '/interactive_marker/feedback'); K.send('advertise', '/tf2_web_republisher/goal');
    const w = K.names((x) => x.m.op === 'advertise');
    check('edge: published while the link was down → on connection its advertise goes at once (ahead of what the link guard kept, as before M17)', w.join() === 'advertise /interactive_marker/feedback', w);
    // unsubscribe of what has not gone out
    K.send('subscribe', '/scan'); const n2 = K.sent.length; K.send('unsubscribe', '/scan', { id: 'subscribe:/scan' });
    K.send('subscribe', '/tf2_web_republisher/tf_repub_1'); K.run(60000);
    check('edge: unsubscribe of a subscribe still waiting → neither goes', !K.names().includes('subscribe /scan') && !K.names().includes('unsubscribe /scan') && K.sent.length === n2 + 2);
    K.send('unsubscribe', '/base/motor_power_state', { id: 'x' });
    check('edge: any other unsubscribe passes', K.names().includes('unsubscribe /base/motor_power_state'));
    const n3 = K.sent.length; K.send('publish', '/teleop/cmd_vel'); K.ros.callOnConnection({ op: 'call_service', service: '/rosapi/get_time' }); K.send('publish', '/never/advertised');
    check('edge: a publish nobody advertised and a service call just pass', K.sent.length === n3 + 3);
    // a busy page fires timers late: the batches catch up, never the whole burst at once
    {
        const L = mkOrder(); L.connect();
        for (let i = 0; i < 200; i++) { L.send('subscribe', '/late/t' + i); }
        L.send('subscribe', '/tf2_web_republisher/tf_repub_1');
        L.fireLate(0); const b1 = L.sent.length - 1;
        L.fireLate(0); const b2 = L.sent.length - 1 - b1;
        L.fireLate(450); const b3 = L.sent.length - 1 - b1 - b2;          // 600 ms after the last batch
        L.fireLate(5000); const b4 = L.sent.length - 1 - b1 - b2 - b3;    // 5 s late
        check('batches: on time ' + L.api.BATCH + ' each; a timer 450 ms late → 4 batches\' worth at once; however late, never more than 4 (the pace holds, rosbridge never gets the burst)',
            b1 === L.api.BATCH && b2 === L.api.BATCH && b3 === 4 * L.api.BATCH && b4 === 4 * L.api.BATCH, [b1, b2, b3, b4]);
    }
    // before the first connection nothing of B / C leaks into the link guard's queue
    const Q = mkOrder(); Q.send('subscribe', '/scan'); Q.send('advertise', '/tf2_web_republisher/goal'); Q.send('subscribe', '/base/motor_power_state'); Q.run(30000);
    check('edge: with the link down only safety is handed on (the link guard keeps it for the connection); the rest waits here', Q.names().join() === 'subscribe /base/motor_power_state');
    Q.connect(); Q.run(Q.at() + Q.api.HOLD + 5000);
    check('edge: … and goes after the connection', Q.names().includes('subscribe /scan') && Q.names().includes('advertise /tf2_web_republisher/goal'));
}
check('order: installed on the page\'s main link, before anything is sent; a failure to install never stops the page', /try \{\s*this\.order = vtStartOrder\(this\.ros\);/.test(mv) && /\} catch \(e\) \{ console\.warn\('\[ROS\] start order not installed:', e\); \}/.test(mv) &&
    mv.indexOf('this.order = vtStartOrder(this.ros') < mv.indexOf("this.ros.on('connection', function() {"));
check('order: vt_link.js and vt_ros_share.js are not touched by it (it stands at Ros.callOnConnection)', /ros\.callOnConnection = function \(m\)/.test(orderSrc) && !/sendEncodedMessage = /.test(orderSrc));

// ---- 2. TF after a reconnect ---------------------------------------------------
{
    const cls = sliceAt(mv, mv.indexOf('class TfClient {'));
    let now = 0, timers = [], tid = 0, calls = [], answer = true;
    const st = (f, ms) => { timers.push({ id: ++tid, at: now + ms, f }); return tid; };
    const ct = (id) => { timers = timers.filter((x) => x.id !== id); };
    const run = (until) => { for (;;) { timers.sort((a, b) => a.at - b.at); if (!timers.length || timers[0].at > until) { break; } const x = timers.shift(); now = x.at; x.f(); } now = until; };
    const V = function () { this.copy = () => {}; };
    const ev = {};
    function FakeTF(o) { this.ros = o.ros; this.frameInfos = {}; this.currentTopic = false;
        this.serviceClient = { callService: (req, cb) => { const n = calls.push({ at: now }); if (answer) { st(() => cb({ topic_name: '/tf_repub_' + n }), 300); } } }; }
    FakeTF.prototype.updateGoal = function () { this.serviceClient.callService({}, this.processResponse.bind(this)); };
    FakeTF.prototype.processResponse = function (r) { this.currentTopic = { name: r.topic_name, unsubscribe() {} }; };
    FakeTF.prototype.processTFArray = function () {};
    const C = new Function('THREE', 'ROSLIB', 'document', 'setTimeout', 'clearTimeout', 'Date', 'console', cls + '\nreturn TfClient;')(
        { Vector3: V, Quaternion: V }, { TFClient: FakeTF }, { addEventListener: (t, f) => { ev[t] = f; } }, st, ct, { now: () => now }, { warn() {}, log() {} });
    const c = new C({ ros: { isConnected: true } }, { camera: { position: {}, rotation: {} }, cameraControls: { center: {} } });
    c.tfClientMap.frameInfos.base_link = { cbs: [], transform: {} };
    const beat = () => st(function b() { c.tfClientMap.processTFArray({ transforms: [{ child_frame_id: 'base_link' }] }); st(b, 500); }, 400);
    run(10000);
    ev.rosdisconnected(); run(12000);
    const n0 = calls.length; ev.rosconnected();
    check('reconnect: the TF request goes out at once (was 500 ms later)', calls.length === n0 + 1 && calls[n0].at === now);
    beat(); run(now + 30000);
    check('reconnect: answered → not asked again', calls.length === n0 + 1, calls.length - n0);
    // the service is not there yet (robot restarting): the call is lost without an answer
    timers = []; answer = false; ev.rosdisconnected(); run(now + 2000);
    const n1 = calls.length, t1 = now; ev.rosconnected(); run(t1 + 3900);
    const a1 = calls.length; answer = true; run(t1 + 4100);
    check('reconnect: no answer in 4 s → asked once more', a1 === n1 + 1 && calls.length === n1 + 2, [n1, a1, calls.length]);
    check('reconnect: no 500 ms wait left in the handler', !/\}, 500\);/.test(sliceAt(cls, cls.indexOf("document.addEventListener('rosconnected'"))));
}

// ---- 3. the robot's colours ----------------------------------------------------
{
    const rv = sliceAt(mv, mv.indexOf('class RobotVisualization {'));
    check('colours: no timer in the robot\'s drawing (was a 700 ms interval for ever)', !/setInterval\(/.test(strip(rv)) && !/setTimeout\(/.test(strip(rv)));
    const subs = []; let docIn = null, colourSets = 0;
    const prefs = { vitulus_robot_frame_color: '#ff0000', vitulus_robot_fill_color: '#00ff00', vitulus_robot_fill_opacity: '0.5' };
    let reads = 0;
    const mesh = () => ({ isMesh: true, material: { color: { set(c) { this.v = c; colourSets++; } } } });
    const line = () => ({ isLine: true, material: { color: { set(c) { this.v = c; } }, transparent: false } });
    const Obj = function () { this.kids = []; this.add = (o) => this.kids.push(o); this.traverse = (f) => { f(this); this.kids.forEach(f); }; };
    const Poly = function (o) { this.rosTopic = { subscribe: (f) => subs.push(f) }; o.rootObject.add(this); this.kids = []; };
    Poly.prototype.subscribe = function () { this.rosTopic = { subscribe: (f) => subs.push(f) }; };
    const RV = new Function('THREE', 'ROS3D', 'uiPrefGet', 'document', rv + '\nreturn RobotVisualization;')(
        { Object3D: Obj }, { Polygon: Poly }, (k, d) => { reads++; return prefs[k] || d; }, { addEventListener: (t, f) => { if (t === 'input') { docIn = f; } } });
    const scene = new Obj();
    const r = new RV({}, {}, { scene });
    check('colours: joined to the footprint\'s topic (after the polygon\'s own handler), applied once at the start', subs.length === 1 && typeof r.applyColours === 'function');
    const m1 = mesh(), l1 = line(); r.group.kids.push(m1, l1);
    const reads0 = reads; subs[0]({}); subs[0]({}); subs[0]({});
    check('colours: every footprint message colours the rebuilt meshes (fill, opacity, outline above the fill)', m1.material.color.v === '#00ff00' && m1.material.opacity === 0.5 && l1.material.color.v === '#ff0000' && l1.material.transparent === true && l1.renderOrder === 56 && m1.renderOrder === 55);
    check('colours: … without reading the stored colours again per message', reads === reads0, reads - reads0);
    prefs.vitulus_robot_fill_color = '#0000ff'; docIn({ target: { id: 'mapv3_robot_fill' } });
    check('colours: a change in Map > Display shows at once', m1.material.color.v === '#0000ff');
    const cs = colourSets; docIn({ target: { id: 'mapv3_aerial_opacity' } });
    check('colours: other inputs cost nothing', colourSets === cs);
    r.robotPolygon.subscribe();
    check('colours: a polygon that subscribes anew (new topic object) is joined again', subs.length === 2);
}

// ---- 4. the scale's poll -------------------------------------------------------
{
    const sc = rd(JS, 'vt_map_scale.js');
    let now = 0, timers = [], tid = 0, looks = 0, riderSays = false;
    const st = (f, ms) => { timers.push({ id: ++tid, at: now + ms, f }); return tid; };
    const ct = (id) => { timers = timers.filter((x) => x.id !== id); };
    const run = (until) => { for (;;) { timers.sort((a, b) => a.at - b.at); if (!timers.length || timers[0].at > until) { break; } const x = timers.shift(); now = x.at; x.f(); } now = until; };
    const doc = { hidden: false };
    const S = new Function('update', 'document', 'setTimeout', 'clearTimeout',
        'var POLL_MS = 250, SLOW_MS = 1000, QUIET_LOOKS = 8, timer = null;\n' + sc.slice(sc.indexOf('    var riders = [], moved = false'), sc.indexOf('    function init() {')) + '\nreturn { tick: tick, wake: wake, riders: riders, timer: function () { return timer; } };')(
        () => { looks++; }, doc, st, ct);
    S.riders.push(() => riderSays);
    S.wake(); run(1);
    const per = (ms) => { const a = looks; run(now + ms); return looks - a; };
    riderSays = true;
    check('poll: while something moves — 4 looks a second', per(10000) === 40);
    riderSays = false; per(2000);
    const slow = per(10000);
    check('poll: nothing changes for 2 s → 1 look a second (was 4 for ever)', slow === 10, slow);
    S.wake(); const fast = per(1000);
    check('poll: a touch of the page (pointer, wheel, key, resize) → quick again at once', fast >= 3, fast);
    per(5000); riderSays = true; per(1500); const back = per(2000);
    check('poll: a change seen at a slow look (the robot moved) → quick again', back === 8, back);
    riderSays = false; doc.hidden = true; per(3000); const hid = per(60000);
    check('poll: hidden tab → no look and NO timer at all', hid === 0 && timers.length === 0 && S.timer() === null, [hid, timers.length]);
    doc.hidden = false; S.wake(); const vis = per(1000);
    check('poll: the tab shows again → it starts again', vis >= 3, vis);
    check('poll: one timeout chain, woken by events; no interval', !/setInterval\(/.test(strip(sc)) && /\['pointerdown', 'wheel', 'touchstart', 'keydown'\]\.forEach/.test(sc) && /document\.addEventListener\('visibilitychange', wake\)/.test(sc) && /passive: true/.test(sc));
    const robot = strip(rd(JS, 'vt_map_robot.js'));
    check('poll: the pill says whether it saw a change (view, robot\'s position, its state)', /function update\(\) \{ changed = false; look\(\); return changed; \}/.test(robot) && /if \(sigIn !== lastIn\) \{ changed = true; \}/.test(robot));
}

// ---- 5. the note mark, 4 s -----------------------------------------------------
{
    const robot = strip(rd(JS, 'vt_map_robot.js')), css = rd(TPL, 'assets', 'css', 'vt_map_layers.css');
    const R = require(path.join(JS, 'vt_map_robot.js')), M = require(path.join(JS, 'vt_map_measure.js'));
    check('note: data-state keeps the position\'s state (stale stays stale); the note has its own mark', /el\.setAttribute\('data-state', st\)/.test(robot) && /el\.setAttribute\('data-note', '1'\)/.test(robot) &&
        /\.vt-map-robot\[data-note\] \.vt-map-robot-a \{ display: none; \}/.test(css) && !/data-state="none"\] \.vt-map-robot-a/.test(css) && /el\.hasAttribute\('data-note'\)\) \{ return; \}/.test(robot));
    check('stale: 4 s (twice the 2.0 s gaps measured on a busy robot; was 3 s), the same in measuring', R.STALE_MS === 4000 && R.poseState({ x: 0, y: 0 }, 0, 3900, true) === 'live' && R.poseState({ x: 0, y: 0 }, 0, 4100, true) === 'stale' &&
        M.tfStale({ _vtPoseAt: 0, ros: { isConnected: true } }, 3900) === false && M.tfStale({ _vtPoseAt: 0, ros: { isConnected: true } }, 4100) === true);
    const flat = (x) => x.replace(/\s+/g, ' ');
    check('help en + cs say 4 s', /about 4 s without it/.test(flat(rd(ROOT, 'docs', 'help', 'mapping.md'))) && /déle než asi 4 s/.test(flat(rd(ROOT, 'docs', 'help', 'cs', 'mapping.md'))));
}

// ---- 6. phone audit: the group Robot leads the overlays -----------------------
{
    const L = strip(rd(JS, 'vt_map_layers.js'));
    const iRobot = L.indexOf("data-lyr-robot>' + esc(t('trav.grp'))"), iTrav = L.indexOf("ovRow('trav'"), iMos = L.indexOf("ovRow('tmosaic'"), iLines = L.indexOf("t('maplyr.grp.lines')"), iTer = L.indexOf("t('maplyr.grp.terrain')"), iW = L.indexOf("t('maplyr.grp.weather')");
    check('layers: the group Robot (its own layers, live traversability, mowed terrain) comes first among the overlays, then lines, terrain, weather',
        iRobot > 0 && iRobot < iTrav && iTrav < iMos && iMos < iLines && iLines < iTer && iTer < iW, [iRobot, iTrav, iMos, iLines, iTer, iW]);
    const flat = (x) => x.replace(/\s+/g, ' ');
    check('help en + cs say so', /Under \*Robot\*, first among the overlays/.test(flat(rd(ROOT, 'docs', 'help', 'mapping.md'))) && /Pod \*Robot\*, hned na začátku překryvů/.test(flat(rd(ROOT, 'docs', 'help', 'cs', 'mapping.md'))));
}

console.log(fails ? '\n' + fails + ' of ' + count + ' FAILED' : '\nall ' + count + ' checks passed');
process.exit(fails ? 1 : 0);
