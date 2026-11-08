#!/usr/bin/env node
/*
 * The rosbridge link guard (vt_link.js, T25) with the REAL roslib.js on a fake
 * WebSocket and a fake clock: a STOP is never lost silently — sent at once while
 * the socket is OPEN and confirmed, kept while it is not (CLOSING socket that roslib
 * still calls connected, no socket, connecting) and sent exactly once after the
 * reconnect; half-open found within 5 s; drive commands never replayed.
 *
 *     node tools/test_vt_link.node.js
 *     vitulus-dev env VT_ROS_SHARE=<path to vt_ros_share.js> node tools/test_vt_link.node.js
 *         (the same with the shared subscriptions / advertisements of T8 D11)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const SHARE = process.env.VT_ROS_SHARE || '';

let fails = 0, n = 0;
function ok(name, cond, info) {
    n += 1;
    if (!cond) { fails += 1; console.log('FAIL ' + name + (info !== undefined ? ': ' + JSON.stringify(info) : '')); }
}

/* ------------------------------------------------------------ fake world */
function world() {
    const W = { t: 1000, timers: [], socks: [], tid: 0 };
    W.later = (fn, ms) => { const h = ++W.tid; W.timers.push({ h, at: W.t + (ms || 0), fn }); return h; };
    W.every = (fn, ms) => { const h = ++W.tid; const x = { h, at: W.t + ms, fn, ms, rep: true }; W.timers.push(x); return h; };
    W.run = (ms) => {
        const end = W.t + ms;
        for (;;) {
            W.timers.sort((a, b) => a.at - b.at || a.h - b.h);
            const x = W.timers[0];
            if (!x || x.at > end) { break; }
            W.t = x.at;
            if (x.rep) { x.at += x.ms; } else { W.timers.shift(); }
            x.fn();
        }
        W.t = end;
    };
    // the server side: alive = answers probes; got = what it RECEIVED, per socket
    class FakeWS {
        constructor(url) {
            this.url = url; this.readyState = 0; this.sent = []; this.got = [];
            this.listeners = {}; this.alive = true; this.n = W.socks.length + 1;
            W.socks.push(this);
        }
        addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
        removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] || []).filter((f) => f !== fn); }
        send(d) {
            if (this.readyState === 0) { throw new Error('InvalidStateError: still CONNECTING'); }
            this.sent.push(d);
            if (this.readyState !== 1) { return; }            // CLOSING / CLOSED: the browser drops it, no error
            if (!this.alive) { return; }                       // half-open: it never arrives
            const m = JSON.parse(d);
            this.got.push(m);
            if (m.op === 'call_service') {
                W.later(() => this.toClient({ op: 'service_response', id: m.id, service: m.service, result: true, values: { value: 'false' } }), 5);
            }
        }
        close() { if (this.readyState < 2) { this.readyState = 2; } }   // no close event: half-open
        open() { this.readyState = 1; if (this.onopen) { this.onopen({ type: 'open' }); } }
        toClient(m) {
            if (this.readyState !== 1 || !this.alive) { return; }
            const ev = { data: JSON.stringify(m) };
            (this.listeners.message || []).forEach((f) => f(ev));
            if (this.onmessage) { this.onmessage(ev); }
        }
        finish() { this.readyState = 3; if (this.onclose) { this.onclose({ type: 'close', code: 1006 }); } }
    }
    FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
    const ctx = vm.createContext({ console, JSON, Math, Date, Object, Array, String, Number, Error, setTimeout: W.later, clearTimeout() {}, setInterval: W.every, clearInterval() {} });
    ctx.window = ctx; ctx.global = ctx; ctx.self = ctx; ctx.globalThis = ctx;
    ctx.WebSocket = FakeWS;
    vm.runInContext(fs.readFileSync(path.join(JS, 'roslib.js'), 'utf8'), ctx);
    if (SHARE) { vm.runInContext(fs.readFileSync(SHARE, 'utf8'), ctx); }
    vm.runInContext(fs.readFileSync(path.join(JS, 'vt_link.js'), 'utf8'), ctx);
    W.ctx = ctx;
    W.R = ctx.ROSLIB;
    W.V = ctx.VTLink;
    W.ev = [];
    W.ros = new W.R.Ros({ url: 'ws://robot:9090', groovyCompatibility: false });
    W.g = W.V.install(W.ros, { now: () => W.t, later: W.later, every: W.every,
                               onStop: (e, i) => W.ev.push([e, i]), onDead: (r) => W.ev.push(['dead', r]),
                               onDrop: (i) => W.ev.push(['drop', i]) });
    W.sock = () => W.socks[W.socks.length - 1];
    // what the page has: STOP topics advertised, a drive topic, a speed topic, a subscription
    const T = (name, type) => new W.R.Topic({ ros: W.ros, name, messageType: type });
    W.top = {
        stop: T('/mower_smach/stop', 'std_msgs/Bool'),
        blade: T('/mower/set_motor_on', 'std_msgs/Bool'),
        power: T('/base/motor_power', 'std_msgs/Bool'),
        dock: T('/dock_smach/stop', 'std_msgs/Bool'),
        pm: T('/pm/set_motor_switch', 'std_msgs/Bool'),
        cancel: T('/move_base_flex/exe_path/cancel', 'actionlib_msgs/GoalID'),
        vel: T('/teleop/cmd_vel', 'geometry_msgs/Twist'),
        speed: T('/navi_manager/speed', 'std_msgs/String'),
    };
    W.top.pm.advertise();
    T('/mower_smach/busy', 'std_msgs/Bool').subscribe(() => {});
    // the big STOP (map_view.js btn_stop_all.onclick)
    W.STOP = () => {
        W.top.cancel.publish({});
        W.top.power.publish({ data: false });
        W.top.stop.publish({ data: true });
        W.top.blade.publish({ data: false });
        W.top.dock.publish({ data: true });
        W.top.pm.publish({ data: false });
    };
    W.twist = (x) => ({ linear: { x, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } });
    // ROS class: reconnect on close (map_view.js does it after 1.5 s)
    W.reconnect = () => { W.ros.connect('ws://robot:9090'); };
    W.pubs = (s, topic) => s.got.filter((m) => m.op === 'publish' && (!topic || m.topic === topic));
    W.STOPS = ['/move_base_flex/exe_path/cancel', '/base/motor_power', '/mower_smach/stop', '/mower/set_motor_on', '/dock_smach/stop', '/pm/set_motor_switch'];
    W.stopCount = (s) => W.STOPS.map((t) => W.pubs(s, t).length);
    return W;
}
function connected(W) { W.sock().open(); W.run(50); }

/* ------------------------------------------------------------ 1 classification */
{
    const W = world(), V = W.V;
    ok('stop: mower_smach/stop true', V.isStop({ op: 'publish', topic: '/mower_smach/stop', msg: { data: true } }));
    ok('not stop: mower_smach/stop false', !V.isStop({ op: 'publish', topic: '/mower_smach/stop', msg: { data: false } }));
    ok('stop: blade off', V.isStop({ op: 'publish', topic: '/mower/set_motor_on', msg: { data: false } }));
    ok('not stop: blade on', !V.isStop({ op: 'publish', topic: '/mower/set_motor_on', msg: { data: true } }));
    ok('stop: motors off', V.isStop({ op: 'publish', topic: '/base/motor_power', msg: { data: false } }));
    ok('not stop: motors on', !V.isStop({ op: 'publish', topic: '/base/motor_power', msg: { data: true } }));
    ok('stop: dock stop', V.isStop({ op: 'publish', topic: '/dock_smach/stop', msg: { data: true } }));
    ok('stop: PM switch open', V.isStop({ op: 'publish', topic: '/pm/set_motor_switch', msg: { data: false } }));
    ok('stop: MBF cancel', V.isStop({ op: 'publish', topic: '/move_base_flex/exe_path/cancel', msg: {} }));
    ok('not stop: tf2 cancel', !V.isStop({ op: 'publish', topic: '/tf2_web_republisher/cancel', msg: {} }));
    ok('stop: zero teleop', V.isStop({ op: 'publish', topic: '/teleop/cmd_vel', msg: W.twist(0) }));
    ok('stop: zero cmd_vel', V.isStop({ op: 'publish', topic: '/cmd_vel', msg: W.twist(0) }));
    ok('drive: non-zero', V.isDrive({ op: 'publish', topic: '/teleop/cmd_vel', msg: W.twist(0.3) }) && !V.isStop({ op: 'publish', topic: '/teleop/cmd_vel', msg: W.twist(0.3) }));
    ok('not stop: subscribe', !V.isStop({ op: 'subscribe', topic: '/mower_smach/stop' }));
}

/* ------------------------------------------------------------ 2 STOP on a live link: once, confirmed */
{
    const W = world(); connected(W);
    const s = W.sock();
    W.STOP(); W.run(100);
    ok('live: every STOP topic once', W.stopCount(s).join() === '1,1,1,1,1,1', W.stopCount(s));
    ok('live: confirmed (nothing pending)', W.g.pending().length === 0, W.g.pending());
    ok('live: one probe for the burst', s.got.filter((m) => m.op === 'call_service').length === 1);
    // a later reconnect does not send it again
    s.finish(); W.reconnect(); connected(W); W.run(100);
    ok('live: not re-sent after a later reconnect', W.stopCount(W.sock()).join() === '0,0,0,0,0,0', W.stopCount(W.sock()));
}

/* ------------------------------------------------------------ 3 the review case: CLOSING socket, roslib still "connected" */
{
    const W = world(); connected(W);
    const s1 = W.sock();
    s1.close();                                       // the old heartbeat: close() on a half-open socket -> CLOSING for ~40 s
    ok('closing: roslib still says connected (the trap)', W.ros.isConnected === true);
    ok('closing: guard says down', W.g.up() === false);
    W.STOP();
    ok('closing: socket dropped at once', W.ros.socket === null && W.ros.isConnected === false);
    ok('closing: nothing went into the CLOSING socket', W.pubs(s1).length === 0, s1.sent.length);
    ok('closing: STOP kept (6 topics)', W.g.pending().length === 6, W.g.pending());
    ok('closing: handlers of the dead socket detached', !s1.onclose && !s1.onmessage);
    W.reconnect();
    ok('closing: a NEW socket opened (connect() was a no-op on CLOSING before)', W.socks.length === 2 && W.sock() !== s1);
    connected(W);
    const s2 = W.sock();
    ok('closing: STOP sent exactly once after the reconnect', W.stopCount(s2).join() === '1,1,1,1,1,1', W.stopCount(s2));
    ok('closing: confirmed', W.g.pending().length === 0);
    const adv = s2.got.findIndex((m) => m.op === 'advertise' && m.topic === '/pm/set_motor_switch');
    const pub = s2.got.findIndex((m) => m.op === 'publish' && m.topic === '/pm/set_motor_switch');
    ok('closing: re-advertise goes before the STOP', adv >= 0 && adv < pub, [adv, pub]);
    s1.finish();                                       // the old socket's close event 40 s later: ignored
    ok('closing: late close of the old socket does not touch the new link', W.ros.isConnected === true && W.g.up());
    ok('closing: events queued -> resent -> acked', W.ev.map((e) => e[0]).filter((e) => e !== 'dead' && e !== 'drop').join() ===
       'queued,queued,queued,queued,queued,queued,resent,acked', W.ev.map((e) => e[0]));
}

/* ------------------------------------------------------------ 4 half-open, STOP into a socket that looks OPEN */
{
    const W = world(); connected(W);
    const s1 = W.sock();
    W.run(1000);
    s1.alive = false;                                  // Wi-Fi gone: nothing arrives either way, socket still OPEN
    const t0 = W.t;
    W.STOP();
    ok('half-open: sent (socket looks open)', s1.sent.filter((d) => d.indexOf('"publish"') > 0).length === 6);
    let tDead = null;
    for (let i = 0; i < 200 && tDead === null; i++) { W.run(50); if (W.ros.socket === null) { tDead = W.t - t0; } }
    ok('half-open: dropped <= 2.75 s after the STOP (K1)', tDead !== null && tDead <= 2750, tDead);
    ok('half-open: STOP still pending (not confirmed)', W.g.pending().length === 6);
    W.reconnect(); connected(W);
    ok('half-open: STOP sent exactly once on the new link', W.stopCount(W.sock()).join() === '1,1,1,1,1,1', W.stopCount(W.sock()));
    W.run(100);
    ok('half-open: confirmed', W.g.pending().length === 0);
}

/* ------------------------------------------------------------ 5 half-open without a STOP: heartbeat <= 5 s */
{
    const W = world(); connected(W);
    const s1 = W.sock();
    // frames flowing: no probe, no kill
    for (let i = 0; i < 40; i++) { W.run(100); s1.toClient({ op: 'publish', topic: '/mower_smach/busy', msg: { data: false } }); }
    ok('heartbeat: no probe while frames flow', s1.got.filter((m) => m.op === 'call_service').length === 0);
    // idle but alive: probes answered, never killed
    W.run(20000);
    ok('heartbeat: idle alive link survives 20 s', W.ros.socket === s1 && W.g.up());
    ok('heartbeat: idle link probed (~every 1.5 s)', s1.got.filter((m) => m.op === 'call_service').length >= 8);
    s1.toClient({ op: 'publish', topic: '/mower_smach/busy', msg: { data: false } });
    s1.alive = false;
    const t0 = W.t;
    let tDead = null;
    for (let i = 0; i < 200 && tDead === null; i++) { W.run(50); if (W.ros.socket === null) { tDead = W.t - t0; } }
    ok('heartbeat: half-open found <= 8.5 s after the last frame (R2)', tDead !== null && tDead <= 8500, tDead);
    ok('heartbeat: ... a 6 s stall is survived', tDead !== null && tDead > 6000, tDead);
    ok('heartbeat: roslib told closed', W.ros.isConnected === false);
}

/* ------------------------------------------------------------ 6 slow link: frames arrive, probe late -> no kill */
{
    const W = world(); connected(W);
    const s1 = W.sock();
    s1.send = function (d) { this.sent.push(d); this.got.push(JSON.parse(d)); };   // probes never answered
    for (let i = 0; i < 100; i++) { W.run(200); if (i % 10 === 0) { s1.toClient({ op: 'publish', topic: '/mower_smach/busy', msg: { data: false } }); } }
    ok('slow: a frame every 2 s keeps the link (no kill)', W.ros.socket === s1, W.g.stats());
}

/* ------------------------------------------------------------ 7 STOP while down: kept, once, no roslib double */
{
    const W = world(); connected(W);
    W.sock().finish();                                 // a normal close (rosbridge restart)
    ok('down: roslib knows', W.ros.isConnected === false);
    W.STOP(); W.STOP();                                // pressed twice while down
    W.top.vel.publish(W.twist(0.4));                   // the stick moved while down
    W.top.vel.publish(W.twist(0));                     // ... and released (a zero = a stop)
    W.top.speed.publish({ data: 'SLOW' });             // a command (not a STOP)
    ok('down: one per topic kept (+ the zero)', W.g.pending().length === 7, W.g.pending());
    ok('down: a person waits for 6 STOPs (the zero is not one)', W.g.waiting() === 6);
    W.reconnect();
    W.run(3000);                                       // connecting...
    connected(W);
    const s = W.sock();
    ok('down: each STOP topic exactly once', W.stopCount(s).join() === '1,1,1,1,1,1', W.stopCount(s));
    ok('down: no drive replayed', W.pubs(s, '/teleop/cmd_vel').filter((m) => m.msg.linear.x !== 0).length === 0);
    ok('down: the zero once', W.pubs(s, '/teleop/cmd_vel').length === 1);
    ok('down: a command older than 2 s is NOT sent late (N2)', W.pubs(s, '/navi_manager/speed').length === 0);
    ok('down: ... and the page is told', W.ev.some((e) => e[0] === 'drop'));
    W.run(100);
    ok('down: confirmed', W.g.pending().length === 0);
}

/* ------------------------------------------------------------ 8 connect hangs (dead Wi-Fi): dropped after 4 s */
{
    const W = world(); connected(W);
    W.sock().finish();
    W.reconnect();
    const s = W.sock();                                // never opens
    W.run(3900);
    ok('connect: still waiting at 3.9 s', W.ros.socket === s);
    W.run(400);
    ok('connect: hanging attempt dropped at 4 s', W.ros.socket === null && s.readyState === 2);
    W.reconnect();
    ok('connect: next attempt opens a new socket', W.sock() !== s && W.ros.socket === W.sock());
    const s2 = W.sock();
    W.run(4300);
    ok('connect: the 2nd attempt still 4 s (R3: longer only after two failures)', W.ros.socket === null && s2.readyState === 2);
    W.reconnect(); const s2b = W.sock();
    W.run(7900);
    ok('connect: the 3rd attempt gets 8 s', W.ros.socket === s2b);
    W.run(400);
    ok('connect: ... dropped at 8 s', W.ros.socket === null);
    W.reconnect(); const s3 = W.sock();
    W.run(11900);
    ok('connect: the 4th gets 12 s', W.ros.socket === s3);
    W.run(400);
    ok('connect: ... dropped at 12 s', W.ros.socket === null);
    W.reconnect(); const s4 = W.sock();
    W.run(11900);
    ok('connect: stays at 12 s', W.ros.socket === s4);
    s4.open(); W.run(50);
    W.sock().finish(); W.reconnect(); const s5 = W.sock();
    W.run(4300);
    ok('connect: back to 4 s after a connection', W.ros.socket === null && s5.readyState === 2);
}

/* ------------------------------------------------------------ 9 a waiting STOP never expires while the page is open (N1) */
{
    const W = world(); connected(W);
    W.sock().finish();
    W.top.blade.publish({ data: false });
    W.top.vel.publish(W.twist(0));
    W.run(9000);
    ok('keep: the zero still waits at 9 s', W.g.pending().length === 2);
    W.run(2000);
    ok('keep: the zero of the stick dropped after 10 s', W.g.pending().length === 1 && W.g.pending()[0].topic === '/mower/set_motor_on');
    W.run(600000);
    ok('keep: the blade STOP still waits after 10 min', W.g.waiting() === 1);
    W.reconnect(); connected(W);
    ok('keep: ... and goes out once on the reconnect', W.pubs(W.sock(), '/mower/set_motor_on').length === 1);
    ok('keep: the stale zero is not sent', W.pubs(W.sock(), '/teleop/cmd_vel').length === 0);
}

/* ------------------------------------------------------------ 10 drive and normal traffic on a live link unchanged */
{
    const W = world(); connected(W);
    const s = W.sock();
    for (let i = 0; i < 10; i++) { W.top.vel.publish(W.twist(0.2)); }
    W.top.speed.publish({ data: 'FAST' });
    W.run(10);
    ok('live: drive sent', W.pubs(s, '/teleop/cmd_vel').length === 10);
    ok('live: speed sent', W.pubs(s, '/navi_manager/speed').length === 1);
    ok('live: no probe for drive commands', s.got.filter((m) => m.op === 'call_service').length === 0);
}

/* ------------------------------------------------------------ 11 kill during the reconnect window, twice */
{
    const W = world(); connected(W);
    W.sock().alive = false;
    W.STOP();
    W.run(3000);
    W.reconnect(); W.sock().alive = false; connected(W);    // the new link dies at once too
    ok('twice: resent on the 2nd socket', W.stopCount(W.socks[1]).join() === '0,0,0,0,0,0' && W.socks[1].sent.filter((d) => d.indexOf('"publish"') > 0).length === 6);
    W.run(3000);
    ok('twice: 2nd socket dropped too', W.ros.socket === null);
    W.reconnect(); connected(W);
    ok('twice: delivered once on the 3rd', W.stopCount(W.sock()).join() === '1,1,1,1,1,1', W.stopCount(W.sock()));
    W.run(100);
    ok('twice: confirmed', W.g.pending().length === 0);
}

/* ------------------------------------------------------------ 12 N2: commands while down */
{
    // R1 (deliberate change, kontrola kolo 2): only the page's own start-up (its first
    // 3 s) waits for a late first connection as in roslib; a command pressed later while
    // the first connection still does not come is dropped after 2 s like any other
    const W = world();
    W.top.speed.publish({ data: 'FAST' });             // start-up, t = 0
    W.run(3500);
    connected(W);
    ok('first: the start-up publish goes out on a late first connection', W.pubs(W.sock(), '/navi_manager/speed').length === 1);
    {
        const V = world();                             // the first connection does not come
        V.run(4300);                                   // the hanging first attempt is dropped at 4 s
        V.reconnect();
        V.top.power.publish({ data: true });           // motors ON pressed at ~4.3 s (not start-up)
        V.run(2600);
        ok('first: a command 4 s after start-up, 2.6 s before the first connection, is dropped (R1)', V.ev.some((e) => e[0] === 'drop'));
        connected(V);
        ok('first: ... and NOT sent on the first connection', V.pubs(V.sock(), '/base/motor_power').length === 0);
        V.top.power.publish({ data: true });
        ok('first: once up it goes out at once', V.pubs(V.sock(), '/base/motor_power').length === 1);
        const U = world();
        U.run(4300); U.reconnect();
        U.top.power.publish({ data: true });           // 1.5 s before the first connection
        U.run(1500); connected(U);
        ok('first: a command within 2 s of the first connection still goes out', U.pubs(U.sock(), '/base/motor_power').length === 1);
    }
    // down, back within 2 s: sent
    W.sock().finish();
    W.top.speed.publish({ data: 'SLOW' });
    W.run(1500); W.reconnect(); connected(W);
    ok('n2: back within 2 s: sent', W.pubs(W.sock(), '/navi_manager/speed').length === 1);
    // down, a service call (map delete) + plumbing (TF), back after 3 s
    W.sock().finish();
    const svc = new W.R.Service({ ros: W.ros, name: '/navi_manager/remove_map', serviceType: 'std_srvs/Trigger' });
    let failed = null, okd = null;
    svc.callService({}, (r) => { okd = r; }, (e) => { failed = e; });
    const tf = new W.R.Service({ ros: W.ros, name: '/republish_tfs', serviceType: 'tf2_web_republisher/RepublishTFs' });
    tf.callService({}, () => {}, () => {});
    W.top.speed.publish({ data: 'FAST' });
    W.run(2600);
    ok('n2: the old service call failed back to its caller', failed !== null && okd === null, failed);
    ok('n2: told once', W.ev.filter((e) => e[0] === 'drop').length === 1, W.ev.filter((e) => e[0] === 'drop'));
    W.run(400); W.reconnect(); connected(W);
    const got = W.sock().got;
    ok('n2: map delete NOT sent late', !got.some((m) => m.service === '/navi_manager/remove_map'));
    ok('n2: speed NOT sent late', W.pubs(W.sock(), '/navi_manager/speed').length === 0);
    ok('n2: TF plumbing still sent', got.some((m) => m.service === '/republish_tfs'));
    ok('n2: subscriptions still restored', got.some((m) => m.op === 'subscribe' && m.topic === '/mower_smach/busy'));
}

/* ------------------------------------------------------------ 13 N3: drive only on a fresh link */
{
    const W = world(); connected(W);
    const s = W.sock();
    const send0 = s.send;
    s.send = function (d) { this.sent.push(d); this.got.push(JSON.parse(d)); };   // nothing answered
    W.run(2200);                                       // 2.2 s nothing heard
    s.got.length = 0;
    W.top.vel.publish(W.twist(0.3));
    ok('n3: stale (>2 s nothing heard): drive dropped', W.pubs(s, '/teleop/cmd_vel').length === 0);
    ok('n3: ... and a probe is out', W.g.stats().probe !== null);
    s.send = send0;
    const lastProbe = JSON.parse(s.sent.filter((d) => d.indexOf('"call_service"') > 0).pop());
    s.toClient({ op: 'service_response', id: lastProbe.id, result: true, values: {} });   // the late answer
    W.run(20);
    W.top.vel.publish(W.twist(0.3));
    ok('n3: fresh again after the answer: sent', W.pubs(s, '/teleop/cmd_vel').length === 1);
    // 5 s of stick at 20 Hz on a quiet but healthy link: the guard keeps it fresh
    s.got.length = 0;
    let sent0 = 0;
    for (let i = 0; i < 100; i++) { W.top.vel.publish(W.twist(0.3)); W.run(50); }
    sent0 = W.pubs(s, '/teleop/cmd_vel').length;
    ok('n3: quiet healthy link: >= 95 % of 100 stick commands go out', sent0 >= 95, sent0);
    // the link dies while driving: commands stop within ~1 s
    s.alive = false;
    s.got.length = 0;
    let firstDrop = null;
    const before = s.sent.length;
    for (let i = 0; i < 40; i++) {
        const n0 = s.sent.filter((d) => d.indexOf('cmd_vel') > 0).length;
        W.top.vel.publish(W.twist(0.3)); W.run(50);
        const n1 = s.sent.filter((d) => d.indexOf('cmd_vel') > 0).length;
        if (n1 === n0 && firstDrop === null) { firstDrop = i * 50; }
    }
    ok('n3: dead link: blind driving stops <= 2.05 s', firstDrop !== null && firstDrop <= 2050, firstDrop);
}

console.log((fails ? 'FAIL' : 'OK') + ' — ' + (n - fails) + '/' + n + ' checks' + (SHARE ? ' (with vt_ros_share.js)' : ''));
process.exit(fails ? 1 : 0);
