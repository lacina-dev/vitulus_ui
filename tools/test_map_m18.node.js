#!/usr/bin/env node
/*
 * T17 batch M18 (2026-11-18) — the robot's first position 10–19 s after the connection:
 *     node tools/test_map_m18.node.js
 *   1. the race, as measured live: three TF requests one after another (0.23 / 3.0 / 6.0 s), the first answer
 *      arrives after the second request went out → the position must come with the FIRST answer (~3 s), not
 *      with the third (12.9 s);
 *   2. what M15 guarded stays: an older answer AFTER a newer one never switches the subscription back;
 *   3. reconnect: an answer to a request of the connection that is gone is never taken; a first connection
 *      attempt that fails does not void the request waiting for the first connection;
 *   4. one request for all the page's frames: modules that ask for their frame seconds later cause no further
 *      request; a frame nobody listed still works as before.
 * The page's own TfClient (map_view.js) is run with a fake clock; nothing reaches a robot.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
const mv = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
const roslib = fs.readFileSync(path.join(JS, 'roslib.js'), 'utf8');
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
const cls = sliceAt(mv, mv.indexOf('class TfClient {'));

// a TF client like roslib's (subscribe as in roslib.js TFClient.prototype.subscribe), answers after delay(n) ms
function mk(delay, opt) {
    opt = opt || {};
    let now = 0, timers = [], tid = 0, n = 0;
    const calls = [], subs = [], ev = {}, pending = [];
    const st = (f, ms) => { timers.push({ id: ++tid, at: now + ms, f }); return tid; };
    const ct = (id) => { timers = timers.filter((x) => x.id !== id); };
    const run = (until) => { for (;;) { timers.sort((a, b) => a.at - b.at); if (!timers.length || timers[0].at > until) { break; } const x = timers.shift(); now = x.at; x.f(); } now = until; };
    const V = function () { this.copy = () => {}; };
    function TF(o) {
        this.ros = o.ros; this.frameInfos = {}; this.currentTopic = false; this.updateDelay = 50; this.republisherUpdateRequested = false;
        this.serviceClient = { callService: (req, cb) => { const k = ++n; calls.push({ at: now, k, frames: req.source_frames.slice() }); const d = delay(k); if (d !== null) { const id = st(() => cb({ topic_name: 't' + k }), d); pending.push(id); } } };
    }
    TF.prototype.updateGoal = function () { this.serviceClient.callService({ source_frames: Object.keys(this.frameInfos) }, this.processResponse.bind(this)); this.republisherUpdateRequested = false; };
    TF.prototype.processResponse = function (r) { if (this.currentTopic) { subs.push([now, '-' + this.currentTopic.name]); } this.currentTopic = { name: r.topic_name, unsubscribe() {} }; subs.push([now, '+' + r.topic_name]); };
    TF.prototype.processTFArray = function (tf) { tf.transforms.forEach((x) => { const i = this.frameInfos[x.child_frame_id]; if (i) { i.transform = {}; i.cbs.forEach((cb) => cb(i.transform)); } }); };
    TF.prototype.subscribe = function (frameID, callback) {
        if (frameID[0] === '/') { frameID = frameID.substring(1); }
        if (!this.frameInfos[frameID]) {
            this.frameInfos[frameID] = { cbs: [] };
            if (!this.republisherUpdateRequested) { st(this.updateGoal.bind(this), this.updateDelay); this.republisherUpdateRequested = true; }
        } else if (this.frameInfos[frameID].transform) { callback(this.frameInfos[frameID].transform); }
        this.frameInfos[frameID].cbs.push(callback);
    };
    const C = new Function('THREE', 'ROSLIB', 'document', 'setTimeout', 'clearTimeout', 'Date', 'console', (opt.src || cls) + '\nreturn TfClient;')(
        { Vector3: V, Quaternion: V }, { TFClient: TF }, { addEventListener: (t, f) => { ev[t] = f; } }, st, ct, { now: () => now }, { warn() {}, log() {} });
    const ros = { isConnected: true };
    const c = new C({ ros }, { camera: { position: {}, rotation: {} }, cameraControls: { center: {} } });
    let pose = null;
    // the republisher's stream on the subscribed topic: every frame it was asked for (all exist here), 10 Hz
    st(function beat() { const t = c.tfClientMap.currentTopic; if (t && ros.isConnected) { const k = +t.name.slice(1); c.tfClientMap.processTFArray({ transforms: calls[k - 1].frames.map((f) => ({ child_frame_id: f })) }); if (pose === null && c.tfClientMap.frameInfos.base_link && c.tfClientMap.frameInfos.base_link.transform) { pose = now; } } st(beat, 100); }, 0);
    return { c, tf: c.tfClientMap, calls, subs, ev, ros, run, st, at: () => now, pose: () => pose, topics: () => subs.map((x) => (x[0] / 1000).toFixed(1) + ' ' + x[1]).join(', ') };
}

// ---- 1. the race --------------------------------------------------------------
check('roslib: TFClient.subscribe asks the republisher again only for a frame it does not hold yet, 50 ms later (what the fake below copies)',
    /if \(!this\.frameInfos\[frameID\]\) \{\s*this\.frameInfos\[frameID\] = \{\s*cbs: \[\]\s*\};\s*if \(!this\.republisherUpdateRequested\) \{\s*setTimeout\(this\.updateGoal\.bind\(this\), this\.updateDelay\);/.test(roslib) && /this\.updateDelay = options\.updateDelay \|\| 50;/.test(roslib));
{
    // as the page was before M18: three requests (a module after another), answers 3.0 / 3.5 / 6.9 s after each request
    const staged = (K) => { [230, 3000, 6040].forEach((t) => K.st(() => K.tf.updateGoal(), t)); K.tf.frameInfos.base_link = { cbs: [] }; };
    const old = cls.replace('if (seq <= self._tfAccepted) { return; }', 'if (seq !== self._tfReqSeq) { return; }');
    check('race: the old rule is what this test replays (the M15 line found and put back for the comparison)', old !== cls);
    const O = mk((k) => [3000, 3500, 6900][k - 1], { src: old }); staged(O); O.run(40000);
    check('race, before M18: three requests 0.23 / 3.0 / 6.0 s, the first answer after the second request → the position came with the THIRD answer, ' + (O.pose() / 1000).toFixed(1) + ' s after the connection (live: 11–19 s)', O.pose() > 12000, O.topics());
    const K = mk((k) => [3000, 3500, 6900][k - 1]); staged(K); K.run(40000);
    check('race, now: the same three requests and answers → the position comes with the FIRST answer, ' + (K.pose() / 1000).toFixed(1) + ' s (≤ 3.5 s)', K.pose() !== null && K.pose() <= 3500, K.topics());
    check('race, now: each later answer takes over in its turn (first, second, third — never back), one topic at a time', K.topics() === '3.2 +t1, 6.5 -t1, 6.5 +t2, 12.9 -t2, 12.9 +t3', K.topics());
    // answers in time (the usual case): unchanged
    const U = mk((k) => [1300, 3500, 6900][k - 1]); staged(U); U.run(40000);
    check('race: when the first answer comes in time nothing changes (position at ' + (U.pose() / 1000).toFixed(1) + ' s)', U.pose() <= 1700 && /^1\.5 \+t1/.test(U.topics()), U.topics());
}

// ---- 2. what M15 guarded -------------------------------------------------------
{
    const K = mk((k) => (k === 1 ? 9000 : 1000));
    K.tf.frameInfos.base_link = { cbs: [] };
    K.st(() => K.tf.updateGoal(), 0); K.st(() => K.tf.updateGoal(), 500); K.run(30000);
    check('M15 stays: the answer to an OLDER request that arrives after a newer one was taken never switches the subscription back', K.topics() === '1.5 +t2', K.topics());
    const L = mk((k) => [4000, 1000, 500][k - 1]);
    L.tf.frameInfos.base_link = { cbs: [] };
    [0, 1000, 2000].forEach((t) => L.st(() => L.tf.updateGoal(), t)); L.run(30000);
    check('M15 stays: answers out of order (2nd at 2.0 s, 3rd at 2.5 s, 1st at 4.0 s) → 2nd, then 3rd; the 1st is ignored', L.topics() === '2.0 +t2, 2.5 -t2, 2.5 +t3', L.topics());
}

// ---- 3. reconnect ---------------------------------------------------------------
{
    // a request of the old connection is answered late, after the link was lost and a new one made
    const K = mk((k) => (k === 1 ? 6000 : 800));
    K.tf.frameInfos.base_link = { cbs: [] };
    K.ev.rosconnected();                                   // the first connection (nothing re-issued)
    K.st(() => K.tf.updateGoal(), 100);
    K.run(2000); K.ros.isConnected = false; K.ev.rosdisconnected();
    K.run(3000); K.ros.isConnected = true; K.ev.rosconnected();      // re-issues the request at once (M17)
    K.run(30000);
    check('reconnect: the new connection asks again at once and takes ITS answer', K.calls.length >= 2 && K.calls[1].at === 3000 && /^3\.8 \+t2/.test(K.topics()), K.topics());
    check('reconnect: the answer to the old connection\'s request (arrives 6.1 s) is never taken — it names a topic of the connection that is gone', !/t1/.test(K.topics()), K.topics());
    check('reconnect: the position is there again ' + ((K.pose() - 3000) / 1000).toFixed(1) + ' s after the new connection', K.pose() !== null && K.pose() - 3000 <= 1200);
}
{
    // the page's first connection attempt fails (the robot still starting): the request waiting for the first connection stays valid
    const K = mk(() => 700);
    K.tf.frameInfos.base_link = { cbs: [] };
    K.ros.isConnected = false;
    K.st(() => K.tf.updateGoal(), 100);                    // waits in the link guard's queue; here: answered 0.7 s later, i.e. after the link is up
    K.ev.rosdisconnected(); K.ev.rosdisconnected();        // two failed attempts
    K.run(500); K.ros.isConnected = true;
    K.run(30000);
    check('reconnect: failed FIRST attempts do not void the request waiting for the first connection (its answer is taken)', /^0\.8 \+t1/.test(K.topics()) && K.calls.length === 1, K.topics());
}
{
    // two losses in a row
    const K = mk((k) => [5000, 5000, 600][k - 1]);
    K.tf.frameInfos.base_link = { cbs: [] };
    K.ev.rosconnected(); K.st(() => K.tf.updateGoal(), 0);
    K.run(1000); K.ros.isConnected = false; K.ev.rosdisconnected(); K.run(1500); K.ros.isConnected = true; K.ev.rosconnected();      // request 2
    K.run(2500); K.ros.isConnected = false; K.ev.rosdisconnected(); K.run(3000); K.ros.isConnected = true; K.ev.rosconnected();      // request 3
    K.run(30000);
    const firstPlus = K.subs.filter((x) => x[1][0] === '+').map((x) => x[1]);
    check('reconnect: after two losses only the answer of the present connection is taken (the two older ones arrive at 5.0 and 6.5 s and are ignored)', firstPlus[0] === '+t3' && !firstPlus.includes('+t1') && !firstPlus.includes('+t2'), K.topics());
}

// ---- 4. one request for all the frames -------------------------------------------
{
    const K = mk(() => 900);
    const got = {};
    K.st(() => K.tf.subscribe('base_link', () => { got.base = got.base || K.at(); }), 0);
    K.st(() => K.tf.subscribe('base_scan', () => { got.scan = got.scan || K.at(); }), 3000);
    K.st(() => K.tf.subscribe('/d435_link', () => { got.cam = got.cam || K.at(); }), 6000);
    K.st(() => K.tf.subscribe('odom', () => {}), 6500);
    K.run(20000);
    check('one request: the modules ask for their frames at 0 / 3 / 6 s → ONE request (was three), 50 ms after the first, naming all the page\'s frames', K.calls.length === 1 && K.calls[0].at === 50 &&
        ['base_link', 'odom', 'base_scan', 'd435_link', 'd435_color_optical_frame'].every((f) => K.calls[0].frames.includes(f)), K.calls);
    check('one request: one TF topic, never switched', K.topics() === '0.9 +t1', K.topics());
    check('one request: a module that asks later gets its frame at once (it is already streaming): lidar at 3.0 s, camera at 6.0 s', got.scan === 3000 && got.cam === 6000 && got.base <= 1100, got);
    // a frame nobody listed: as before M18
    K.st(() => K.tf.subscribe('some_new_frame', () => { got.other = got.other || K.at(); }), 0); K.run(K.at() + 5000);
    check('one request: a frame that is not listed still works as before — one more request with it added, its answer taken', K.calls.length === 2 && K.calls[1].frames.includes('some_new_frame') && /\+t2$/.test(K.topics()) && got.other > 20000, [K.calls.length, K.topics(), got.other]);
    check('one request: the list is the frames the page\'s modules ask for (map_view, mapping, sensor ranges)', /this\._tfFrames = \['base_link', 'odom', 'base_scan', 'd435_link', 'd435_color_optical_frame'\];/.test(mv) &&
        /subscribe\('base_scan'/.test(fs.readFileSync(path.join(JS, 'vt_sensor_ranges.js'), 'utf8')) && /subscribe\('d435_link'/.test(fs.readFileSync(path.join(JS, 'vt_sensor_ranges.js'), 'utf8')) &&
        /camFrame: 'd435_link'/.test(fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8')));
}
{
    // the first frame asked for is not base_link: still one request with everything
    const K = mk(() => 500);
    K.st(() => K.tf.subscribe('odom', () => {}), 0); K.st(() => K.tf.subscribe('base_link', () => {}), 20); K.run(10000);
    check('one request: whichever frame is asked for first, the one request names them all', K.calls.length === 1 && K.calls[0].frames.length === 5, K.calls);
}

console.log(fails ? '\n' + fails + ' of ' + count + ' FAILED' : '\nall ' + count + ' checks passed');
process.exit(fails ? 1 : 0);
