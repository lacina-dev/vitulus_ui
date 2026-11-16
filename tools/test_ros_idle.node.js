#!/usr/bin/env node
/*
 * T39: what the page asks rosbridge for.
 *  1. vt_ros_idle.js on a fake clock with fake ROSLIB topics: a hidden tab takes
 *     the heavy subscriptions off the server (after HIDE_MS), a visible one puts
 *     them back, a layer / panel that is off is not asked for, listeners stay.
 *  2. static: the high-rate display topics of map_view.js are throttled with a
 *     queue of 1, the heavy ones are registered with VTRosIdle, and nothing of
 *     safety / control is throttled or registered.
 *
 *     node tools/test_ros_idle.node.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TPL = path.join(__dirname, '..', 'nodes', 'templates');
const JS = path.join(TPL, 'assets', 'js');
let fails = 0, n = 0;
function eq(name, got, want) {
    n += 1;
    if (got !== want) { fails += 1; console.log('FAIL ' + name + ': ' + JSON.stringify(got) + ' != ' + JSON.stringify(want)); }
}
function ok(name, v) { eq(name, !!v, true); }

/* ------------------------------------------------------------ 1. the module */
function page(startHidden) {
    const r = { t: 1e6, timers: [], vis: [], hidden: !!startHidden, sent: [] };
    let id = 0;
    const win = {
        document: {
            get hidden() { return r.hidden; },
            addEventListener(ev, fn) { if (ev === 'visibilitychange') { r.vis.push(fn); } }
        },
        setTimeout: (fn, ms) => { const h = ++id; r.timers.push({ h, at: r.t + (ms || 0), fn }); return h; },
        setInterval: (fn, ms) => { const h = ++id; r.timers.push({ h, at: r.t + ms, fn, every: ms }); return h; },
        clearTimeout: (h) => { r.timers = r.timers.filter((x) => x.h !== h); }
    };
    win.window = win;
    const RealDate = Date;
    win.Date = class extends RealDate { static now() { return r.t; } };
    vm.runInContext(fs.readFileSync(path.join(JS, 'vt_ros_idle.js'), 'utf8'), vm.createContext(win));
    r.run = (ms) => {
        const end = r.t + ms;
        for (;;) {
            r.timers.sort((a, b) => a.at - b.at);
            const x = r.timers[0];
            if (!x || x.at > end) { break; }
            r.t = x.at;
            if (x.every) { x.at += x.every; } else { r.timers.shift(); }
            x.fn();
        }
        r.t = end;
    };
    r.setHidden = (h) => { r.hidden = h; r.vis.forEach((fn) => fn()); };
    /* a ROSLIB.Topic as far as this module cares (roslib.js Topic.subscribe / unsubscribe) */
    r.topic = (name) => {
        const t = { name, subscribeId: null, listeners: [], seq: 0 };
        t.subscribe = (cb) => {
            if (typeof cb === 'function') { t.listeners.push(cb); }
            if (t.subscribeId) { return; }
            t.subscribeId = 'subscribe:' + name + ':' + (++t.seq);
            r.sent.push('sub ' + name);
        };
        t.unsubscribe = (cb) => {
            if (cb) { t.listeners = t.listeners.filter((x) => x !== cb); if (t.listeners.length) { return; } }
            if (!t.subscribeId) { return; }
            t.subscribeId = null;
            r.sent.push('unsub ' + name);
        };
        return t;
    };
    r.I = win.VTRosIdle;
    return r;
}
function live(p) { return p.I.state().filter((s) => s.on).map((s) => s.name).join(); }

let p = page();
const scan = p.topic('/scan'), cloud = p.topic('/ground_cloud'), map = p.topic('/navi_manager/map'), diag = p.topic('/diagnostics');
[scan, cloud, map, diag].forEach((t) => t.subscribe(function () {}));
let layerOn = true, cardOpen = false;
p.I.add('scan', () => scan);
p.I.add('ground_cloud', () => cloud);
p.I.add('base_map', () => map, () => layerOn);
p.I.add('diagnostics', () => diag, () => cardOpen);
eq('in front: scan, cloud and map asked, the closed card not', live(p), 'scan,ground_cloud,base_map');
eq('the closed card was taken off at once', p.sent.filter((x) => x === 'unsub /diagnostics').length, 1);
cardOpen = true;
p.run(2100);
eq('card opened: asked within 2 s', live(p), 'scan,ground_cloud,base_map,diagnostics');
layerOn = false;
p.I.sync();
eq('Base layer off: the 2 MB map is not asked for', live(p), 'scan,ground_cloud,diagnostics');
eq('its listeners stay', map.listeners.length, 1);
layerOn = true;
p.I.sync();
eq('Base layer on: asked again', live(p), 'scan,ground_cloud,base_map,diagnostics');
/* a quick switch to another tab costs nothing */
p.sent.length = 0;
p.setHidden(true);
p.run(5000);
eq('hidden 5 s: nothing taken off yet', live(p), 'scan,ground_cloud,base_map,diagnostics');
p.setHidden(false);
p.run(20000);
eq('back within the grace: no message to the server at all', p.sent.length, 0);
/* really in the background */
p.setHidden(true);
p.run(p.I.HIDE_MS + 100);
eq('hidden tab: 0 heavy subscriptions', live(p), '');
eq('hidden tab: one unsubscribe each', p.sent.join(), 'unsub /scan,unsub /ground_cloud,unsub /navi_manager/map,unsub /diagnostics');
p.run(10 * 60000);
eq('hidden 10 min: still none', live(p), '');
eq('hidden 10 min: nothing more sent', p.sent.length, 4);
layerOn = false;                       // switched off elsewhere meanwhile (e.g. another tab's localStorage)
p.setHidden(false);
eq('back: asked at once, the layer that is off stays off', live(p), 'scan,ground_cloud,diagnostics');
eq('back: listeners kept', scan.listeners.length + cloud.listeners.length + diag.listeners.length, 3);
layerOn = true;
p.run(2100);
eq('layer on again', live(p), 'scan,ground_cloud,base_map,diagnostics');
/* what the page unsubscribed itself is never put back */
scan.unsubscribe();
p.setHidden(true); p.run(p.I.HIDE_MS + 100); p.setHidden(false); p.run(5000);
eq('the page\'s own unsubscribe is respected', live(p), 'ground_cloud,base_map,diagnostics');
/* a ROS3D client replaces its rosTopic on subscribe(): the getter follows it */
let cur = p.topic('/x'); cur.subscribe(function () {});
p.I.add('x', () => cur);
p.setHidden(true); p.run(p.I.HIDE_MS + 100);
eq('x off while hidden', cur.subscribeId, null);
cur = p.topic('/x'); cur.subscribe(function () {});          // e.g. the page's reconnect code
p.run(2100);
eq('a topic re-made while hidden is taken off again', cur.subscribeId, null);
p.setHidden(false);
ok('and comes back with the tab', cur.subscribeId);
/* loaded in a background tab: taken off straight away */
const q = page(true);
const bg = q.topic('/scan'); bg.subscribe(function () {});
q.I.add('scan', () => bg);
eq('hidden from the start: off at once', bg.subscribeId, null);
q.setHidden(false);
ok('shown: asked', bg.subscribeId);
q.setHidden(true);
q.run(q.I.HIDE_MS + 2100);
eq('hidden again: off after the grace', bg.subscribeId, null);

/* ------------------------------------------------------------ 2. static */
const mv = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
function topicDef(src, name) {
    /* the options object of `new ROSLIB.Topic({... name: '<name>' ...})` */
    const i = src.search(new RegExp("name\\s*:\\s*['\"]" + name.replace(/[/]/g, '\\/') + "['\"]"));
    if (i < 0) { return null; }
    const a = src.lastIndexOf('{', i), b = src.indexOf('}', i);
    return src.slice(a, b + 1);
}
const THROTTLED = {
    '/base/front_left_wheel_state': 250, '/base/rear_left_wheel_state': 250,
    '/base/front_right_wheel_state': 250, '/base/rear_right_wheel_state': 250,
    '/base/get_torque_set': 250, '/gnss/fix': 500, '/gnss/navpvt': 500, '/gloc/track_status': 400
};
Object.keys(THROTTLED).forEach((name) => {
    const d = topicDef(mv, name);
    ok(name + ' is defined', d);
    const m = d && d.match(/throttle_rate\s*:\s*(\d+)/);
    ok(name + ' has a throttle of 200-500 ms', m && Number(m[1]) >= 200 && Number(m[1]) <= 500);
    if (name !== '/gloc/track_status') { ok(name + ' has queue_length 1', d && /queue_length\s*:\s*1\b/.test(d)); }
});
ok('odometry sources throttled with a queue of 1',
    /\/mobile_base_controller\/odom[\s\S]{0,300}throttle_rate\s*:\s*500,\s*queue_length\s*:\s*1/.test(mv));
/* safety / control: left exactly as they were */
['/base/motor_power_state', '/base/motor_power', '/set_motor_switch', '/base/set_torque'].forEach((name) => {
    const d = topicDef(mv, name);
    ok(name + ' is defined', d);
    ok(name + ' is not throttled', d && !/throttle_rate|queue_length/.test(d));
});
const dock = fs.readFileSync(path.join(JS, 'dock.js'), 'utf8');
ok('dock.js is not touched by the idle module', dock.indexOf('VTRosIdle') < 0);
/* the heavy ones rest with the tab; nothing else is registered */
const reg = [];
[mv, fs.readFileSync(path.join(JS, 'imu_calibration.js'), 'utf8')].forEach((src) => {
    src.replace(/VTRosIdle\.add\('([a-z_]+)'/g, (m, name) => { reg.push(name); return m; });
});
eq('registered with VTRosIdle', reg.sort().join(),
    'base_map,diagnostics,ground_cloud,imu_diagnostics,local_costmap,obstacle_cloud,scan');
ok('the base map rests with its layer switch', /VTRosIdle\.add\('base_map'[\s\S]{0,200}mapv3_chk_base/.test(mv));
ok('the layer switch looks at once', /applyBaseVis\(\);\s*if \(window\.VTRosIdle\) \{ VTRosIdle\.sync\(\); \}/.test(mv));
ok('index.html loads vt_ros_idle.js before map_view.js',
    html.indexOf('/assets/js/vt_ros_idle.js') > 0 && html.indexOf('/assets/js/vt_ros_idle.js') < html.indexOf('/assets/js/map_view.js"'));
/* ros3d.js: the scan, the clouds and the grids already go as cbor with a queue of 1 */
const r3 = fs.readFileSync(path.join(JS, 'ros3d.js'), 'utf8');
['class OccupancyGridClient extends', 'class LaserScan extends', 'class PointCloud2 extends'].forEach((cls) => {
    const i = r3.indexOf(cls), body = r3.slice(i, i + 4000);
    ok(cls.split(' ')[1] + ': queue_length 1 + cbor', /queue_length\s*:\s*1/.test(body) && /compression\s*\|\|\s*'cbor'/.test(body));
});

/* the rosbridge launch caps the malloc arenas (both node variants) */
const launch = fs.readFileSync(path.join(__dirname, '..', 'launch', 'rosbridge_websocket.launch'), 'utf8');
eq('rosbridge nodes with MALLOC_ARENA_MAX=2', (launch.match(/<env name="MALLOC_ARENA_MAX" value="2" \/>/g) || []).length,
    (launch.match(/<node name="rosbridge_websocket"/g) || []).length);

console.log(fails ? ('FAILED ' + fails + ' of ' + n) : ('OK ' + n + ' checks'));
process.exit(fails ? 1 : 0);
