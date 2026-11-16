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

/* ------------------------------------------------------------ T8: every command of the page has its class */
// What the page publishes and calls (from the sources and from a load of the page, 2026-11-16).
//   stop: only stops / switches off with that value -> always sent, kept, confirmed
//   drive: a non-zero cmd_vel   query / plumbing: asks the robot to send data
//   action: moves the robot, switches something on, changes or saves something
// A NEW name in the sources fails this test until it is put into one of the lists: decide
// whether it only stops (then it also belongs to STOP_BOOL / CANCEL in vt_link.js, else a STOP
// pressed on a bad link is refused) or acts. vt_link.js treats every unlisted name as an action.
const CMD = {
    stop: [   // [topic, the message that stops]
        ['/mower_smach/stop', { data: true }], ['/dock_smach/stop', { data: true }], ['/mower/set_motor_on', { data: false }],
        ['/base/motor_power', { data: false }], ['/pm/set_motor_switch', { data: false }],
        ['/move_base_flex/exe_path/cancel', {}], ['/smach_goal/cancel', {}],
        ['/teleop/cmd_vel', { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } }],
        ['/cmd_vel', { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } }],
    ],
    // the same topics with the other value switch something ON: actions
    stop_other: [['/mower_smach/stop', { data: false }], ['/dock_smach/stop', { data: false }], ['/mower/set_motor_on', { data: true }],
                 ['/base/motor_power', { data: true }], ['/pm/set_motor_switch', { data: true }]],
    drive: ['/teleop/cmd_vel', '/cmd_vel'],
    query: ['/web_plan/reload', '/web_plan/republish', '/dock_manager/send_programs', '/navi_manager/publish_path', '/navi_manager/publish_point'],
    plumbing: ['/tf2_web_republisher/cancel', '/tf2_web_republisher/goal', '/interactive_marker/feedback'],
    plumbing_svc: ['/republish_tfs', '/rosapi/get_param', '/rosapi/get_time', '/interactive_marker/tunneled/get_init'],
    action_svc: ['/rtabmap/set_mode_localization', '/rtabmap/set_mode_mapping', '/start_motor', '/stop_motor',
                 '/move_base_flex/clear_costmaps', '/laser_filter_scan_rplidar/intensity/set_parameters'],
    action: [
        '/base/set_torque', '/bno085/reset_calibration', '/bno085/restart', '/bno085/run_calibration',
        '/camera_calib/cmd', '/camera_overlay/source', '/depth_obstacles/set', '/dock_detector/dock',
        '/dock_detector/intensity/dock', '/dock_detector/intensity/undock', '/dock_detector/mapping',
        '/dock_detector/new_map', '/dock_detector/undock', '/dock_manager/enable_intensity',
        '/dock_manager/enable_map', '/dock_manager/save_dock_program', '/dock_manager/save_undock_program',
        '/dock_smach/start_docking', '/gloc/apply', '/gloc/compute', '/map_objects/op', '/mapping/clear',
        '/mapping/compare', '/mapping/gate_mode', '/mapping/regenerate', '/mapping/reset_direct', '/mapping/save',
        '/mapping/set_band', '/mapping/set_ranges', '/mapping_manager/layer_enable',
        '/mapping_manager/preview_raster', '/mapping_manager/profile_cmd', '/mapping_manager/rebuild_combined',
        '/mapping_manager/remove_edit', '/mapping_manager/remove_raster', '/mapping_manager/remove_site',
        '/mapping_manager/save_edit', '/mapping_manager/serve_site', '/mapping_manager/show_site',
        '/mapping_manager/start', '/mapping_manager/stop', '/mower/pref/set_cut_height', '/mower/pref/set_motor_rpm',
        '/mower/set_calibrate', '/mower/set_cmd', '/mower/set_cut_height', '/mower/set_home', '/mower/set_motor_dir',
        '/mower/set_motor_rpm', '/mower/set_power', '/mower_smach/reset', '/nav_tf/set_dock_pose',
        '/navi_manager/execute_path', '/navi_manager/goal_point', '/navi_manager/interactive_marker_goal',
        '/navi_manager/load_map', '/navi_manager/load_map_rtabmap', '/navi_manager/new_interactive_marker',
        '/navi_manager/new_map', '/navi_manager/remove_map', '/navi_manager/remove_path',
        '/navi_manager/remove_point', '/navi_manager/rtabmap_settings_set', '/navi_manager/save_map',
        '/navi_manager/save_path', '/navi_manager/save_path_at', '/navi_manager/save_path_point',
        '/navi_manager/save_waypoint', '/navi_manager/save_waypoint_at', '/navi_manager/show_map',
        '/navi_manager/speed', '/navi_manager/start_new_autopath', '/navi_manager/stop_autopath',
        '/pm/set_bat_out_switch', '/pm/set_charge_current_running', '/pm/set_charge_current_standby',
        '/pm/set_precharge_current_running', '/pm/set_precharge_current_standby', '/pm/set_robot_sleep',
        '/pm/set_sleep_time', '/pm/set_sleep_until_charged', '/pm/set_sleep_wait_before_standby',
        '/pm/set_sleep_wait_charged_offset', '/pm/set_standby_timeout_discharging', '/pm/set_temp2_setpoint',
        '/pm/set_temp_setpoint', '/scheduler/clear_issues', '/scheduler/ignore_rain_once', '/scheduler/inhibit',
        '/scheduler/run_next', '/scheduler/set_calendar', '/scheduler/set_enabled', '/scheduler/set_mode',
        '/scheduler/set_settings', '/scheduler/set_window', '/scheduler/sleep_cancel', '/scheduler/sleep_now',
        '/set_motor_switch', '/undock_intensity', '/vitulus_rosbag/d435/record', '/vitulus_rosbag/d435/set_fps',
        '/vitulus_rosbag/gnss/record', '/web_plan/assemble_map', '/web_plan/program_new', '/web_plan/program_remove',
        '/web_plan/program_select', '/web_plan/program_select_resume', '/web_plan/program_to_show_marker',
        '/web_plan/remove_polygon', '/web_plan/remove_zone', '/web_plan/run_path_show', '/web_plan/save_polygon',
        '/web_plan/save_zone', '/web_plan/selected_zone', '/web_plan/zone_check', '/web_plan/zone_op',
    ],
};
{
    const V = world().V, K = V.kind;
    const pub = (topic, msg) => ({ op: 'publish', topic, msg: msg || { data: true } });
    CMD.stop.forEach(([t, m]) => ok('kind stop: ' + t, K(pub(t, m)) === 'stop', K(pub(t, m))));
    CMD.stop_other.forEach(([t, m]) => ok('kind action (switches on): ' + t, K(pub(t, m)) === 'action', K(pub(t, m))));
    CMD.drive.forEach((t) => ok('kind drive: ' + t, K(pub(t, { linear: { x: 0.2, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } })) === 'drive'));
    CMD.query.forEach((t) => ok('kind query: ' + t, K(pub(t)) === 'query', K(pub(t))));
    CMD.plumbing.forEach((t) => ok('kind plumbing: ' + t, K(pub(t, {})) === 'plumbing', K(pub(t, {}))));
    CMD.plumbing_svc.forEach((s) => ok('kind plumbing: ' + s, K({ op: 'call_service', service: s }) === 'plumbing'));
    CMD.action_svc.forEach((s) => ok('kind action: ' + s, K({ op: 'call_service', service: s }) === 'action'));
    const wrong = CMD.action.filter((t) => K(pub(t)) !== 'action' || K(pub(t, { data: false })) !== 'action' || K(pub(t, {})) !== 'action');
    ok('kind action: all ' + CMD.action.length + ' listed topics, whatever the value', !wrong.length, wrong);
    ok('kind: a name nobody listed is an action', K(pub('/some/new_thing')) === 'action' && K({ op: 'call_service', service: '/some/new_srv' }) === 'action');
    ok('kind: subscribe / advertise are not commands', K({ op: 'subscribe', topic: '/base/motor_power' }) === 'other' && K({ op: 'advertise', topic: '/base/motor_power' }) === 'other');

    // the sources: every topic that is published / advertised and every service must be listed above
    const known = new Set([].concat(CMD.stop.map((x) => x[0]), CMD.drive, CMD.query, CMD.plumbing, CMD.plumbing_svc, CMD.action_svc, CMD.action));
    const SKIP = /(_bak|\.bak|\.min\.js$)|^(three|ros3d|ros2d|roslib|jquery|easeljs|eventemitter2|nipplejs|pgmjs|mjpegcanvas|vt_mock|vt_link|vt_ros_share)/;
    const found = {};
    const abs = (nm) => (nm[0] === '/' ? nm : '/' + nm);
    const note = (nm, f) => { (found[abs(nm)] = found[abs(nm)] || []).push(f); };
    fs.readdirSync(JS).filter((f) => /\.js$/.test(f) && !SKIP.test(f)).forEach((f) => {
        const s = fs.readFileSync(path.join(JS, f), 'utf8');
        let m;
        // X = new ROSLIB.Topic({ ... name: 'N' ... }) with X.publish( / X.advertise( in the file
        const reT = /([\w.$]+)\s*=\s*new ROSLIB\.Topic\(\{([\s\S]{0,300}?)\}\)/g;
        while ((m = reT.exec(s))) {
            const nm = /name\s*:\s*['"]([^'"]+)['"]/.exec(m[2]);
            const v = m[1].replace(/[.$]/g, '\\$&');
            if (nm && new RegExp(v + '\\.(publish|advertise)\\(').test(s)) { note(nm[1], f); }
        }
        // helpers: pub('/name', ...), publish('/name' ...
        const reH = /\b(?:pub|publish|_pub|send|call|svc)\w*\(\s*(?:ros\s*,\s*)?['"](\/[A-Za-z0-9_\/]+)['"]/g;
        while ((m = reH.exec(s))) { note(m[1], f); }
        // services
        const reS = /ROSLIB\.Service\(\{[^}]*?name\s*:\s*['"]([^'"]+)['"]/g;
        while ((m = reS.exec(s))) { note(m[1], f); }
    });
    const names = Object.keys(found);
    const unlisted = names.filter((n) => !known.has(n)).map((n) => n + ' (' + found[n][0] + ')');
    ok('sources: the scan still finds the commands (' + names.length + ' names)', names.length >= 100, names.length);
    ok('sources: every published topic / service has its class in CMD', !unlisted.length, unlisted);
}

/* ------------------------------------------------------------ T8: no action on a silent link */
// what the page wrote into the socket (a lost network keeps it in TCP and may still deliver it)
function wrote(s, topic) { return s.sent.map((d) => JSON.parse(d)).filter((m) => m.op === 'publish' && (!topic || m.topic === topic)); }
{
    const W = world(); connected(W);
    const s = W.sock(), T = (name, type) => new W.R.Topic({ ros: W.ros, name, messageType: type });
    const undock = T('/dock_detector/undock', 'std_msgs/Bool'), go = T('/navi_manager/goal_point', 'std_msgs/String');
    const reload = T('/web_plan/reload', 'std_msgs/Bool');
    const srv = new W.R.Service({ ros: W.ros, name: '/rtabmap/set_mode_mapping', serviceType: 'std_srvs/Empty' });
    undock.advertise(); go.advertise(); reload.advertise(); W.top.power.advertise(); W.top.blade.advertise();
    s.toClient({ op: 'publish', topic: '/mower_smach/busy', msg: { data: false } }); W.run(10);
    // data arriving: everything goes out as before
    W.top.power.publish({ data: true }); undock.publish({ data: true });
    ok('fresh: motors ON and Undock sent', wrote(s, '/base/motor_power').length === 1 && wrote(s, '/dock_detector/undock').length === 1);
    // the network goes away: the socket stays "open", nothing arrives, nothing is answered
    s.alive = false;
    const tried = [];
    [500, 1000, 1500, 1900, 2100, 3000, 5000, 7000].forEach((at, i, a) => {
        W.run(at - (i ? a[i - 1] : 0));
        const n0 = wrote(s, '/navi_manager/goal_point').length;
        go.publish({ data: 'P' + at });
        tried.push([at, wrote(s, '/navi_manager/goal_point').length - n0, W.g.up()]);
    });
    console.log('     Go pressed N ms after the last frame -> [ms, sent, link still "up"]: ' + JSON.stringify(tried));
    ok('silent link: a Go within 2 s of the last frame is sent', tried.filter((x) => x[0] <= 2000).every((x) => x[1] === 1), tried);
    ok('silent link: a Go later than 2 s is NOT sent although the link is still "up"', tried.filter((x) => x[0] > 2000 && x[2]).length >= 3 &&
        tried.filter((x) => x[0] > 2000).every((x) => x[1] === 0), tried);
}
{
    const W = world(); connected(W);
    const s = W.sock(), T = (name, type) => new W.R.Topic({ ros: W.ros, name, messageType: type });
    const undock = T('/dock_detector/undock', 'std_msgs/Bool'), reload = T('/web_plan/reload', 'std_msgs/Bool');
    const prog = T('/web_plan/program_select', 'std_msgs/String');
    const srv = new W.R.Service({ ros: W.ros, name: '/rtabmap/set_mode_mapping', serviceType: 'std_srvs/Empty' });
    undock.advertise(); reload.advertise(); prog.advertise(); W.top.power.advertise(); W.top.blade.advertise();
    s.alive = false; W.run(3000);
    ok('silent 3 s: the link still counts as up', W.g.up() && !W.g.fresh());
    const n0 = s.sent.length; W.ev.length = 0;
    let answer = null;
    W.top.power.publish({ data: true }); W.top.blade.publish({ data: true }); undock.publish({ data: true }); prog.publish({ data: 'A' });
    W.top.speed.publish({ data: '0.5' });
    srv.callService(new W.R.ServiceRequest({}), () => { answer = 'ok'; }, (e) => { answer = 'failed: ' + e; });
    W.run(20);
    const sent = s.sent.slice(n0).map((d) => JSON.parse(d)).filter((m) => m.op === 'publish' || (m.op === 'call_service' && !/^vt_link:/.test(m.id || '')));
    ok('silent 3 s: motors ON, blade ON, Undock, program, speed, a service call: none sent', sent.length === 0, sent.map((m) => m.topic || m.service));
    const drops = W.ev.filter((e) => e[0] === 'drop');
    ok('silent 3 s: the page is told at once, once per command, marked stale', drops.length === 6 && drops.every((e) => e[1].stale === true && e[1].n === 1), drops);
    ok('silent 3 s: the service caller gets a failed answer', /^failed/.test(String(answer)), answer);
    ok('silent 3 s: counted', W.g.stats().stale_cmd === 6 && W.g.stats().queue === 0, W.g.stats());
    // what only asks for data, and everything that stops, still goes out
    reload.publish({ data: true });
    ok('silent 3 s: a reload request (query) is sent', wrote(s, '/web_plan/reload').length === 1);
    W.STOP();
    ok('silent 3 s: the big STOP goes out, every topic', W.STOPS.map((t) => wrote(s, t).length).join() === '1,1,1,1,1,1', W.STOPS.map((t) => wrote(s, t).length));
    W.top.vel.publish(W.twist(0));
    ok('silent 3 s: the zero of the stick goes out', wrote(s, '/teleop/cmd_vel').length === 1);
    W.top.vel.publish(W.twist(0.3));
    ok('silent 3 s: a drive command does not', wrote(s, '/teleop/cmd_vel').length === 1);
    // the guard calls the link dead, the page reconnects: nothing refused comes out later
    W.run(9000);
    ok('then: the guard dropped the silent link', W.g.stats().kills >= 1, W.g.stats());
    W.reconnect(); connected(W); W.run(3000);
    const s2 = W.sock();
    const late = W.pubs(s2).filter((m) => ['/base/motor_power', '/mower/set_motor_on', '/dock_detector/undock', '/web_plan/program_select', '/navi_manager/speed'].indexOf(m.topic) >= 0 &&
        !(m.topic === '/base/motor_power' && m.msg.data === false) && !(m.topic === '/mower/set_motor_on' && m.msg.data === false));
    ok('after the reconnect: none of the refused commands is sent', late.length === 0 && !s2.got.some((m) => m.service === '/rtabmap/set_mode_mapping'), late);
    ok('after the reconnect: the STOPs are sent again (not confirmed before)', W.stopCount(s2).every((n) => n === 1), W.stopCount(s2));
    // back on a live link a press works again
    s2.toClient({ op: 'publish', topic: '/mower_smach/busy', msg: { data: false } }); W.run(10);
    undock.publish({ data: true });
    ok('live again: Undock is sent', W.pubs(s2, '/dock_detector/undock').length === 1);
}
{
    // a quiet but healthy link (nothing subscribed talks): the heartbeat keeps it fresh
    const W = world(); connected(W);
    const s = W.sock(), go = new W.R.Topic({ ros: W.ros, name: '/navi_manager/goal_point', messageType: 'std_msgs/String' });
    go.advertise(); W.run(20000);
    go.publish({ data: 'P' });
    ok('quiet healthy link (20 s without topic data): a Go is sent', W.pubs(s, '/navi_manager/goal_point').length === 1 && W.g.stats().kills === 0, W.g.stats());
}

console.log((fails ? 'FAIL' : 'OK') + ' — ' + (n - fails) + '/' + n + ' checks' + (SHARE ? ' (with vt_ros_share.js)' : ''));
process.exit(fails ? 1 : 0);
