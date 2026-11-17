#!/usr/bin/env node
/*
 * T17 batch M15 (2026-11-16):
 *     node tools/test_map_m15.node.js
 *   1. "robot is out of view" pointer (vt_map_robot.js): the pure part
 *      (in view / edge point / behind the camera / distance text / TF pose /
 *      recentre), no timer and no traffic of its own, rides the scale's poll;
 *   2. the scale's poll carries riders (onTick), not while the page is hidden,
 *      a failing rider never stops the scale, still ONE timer;
 *   3. the robot's own layers in the layers panel (group Robot): rows mirror
 *      the Map tab's checkboxes, colour swatches, hint as a tooltip only for
 *      layers on by default, no empty box under a row;
 *   4. measuring From robot: when the robot's position may be added;
 *   5. the measuring module's 1 s check lives only while measuring;
 *   6. i18n en + cs, help en + cs, CSS.
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
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-6);
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

const html = rd(TPL, 'index.html');
const layersSrc = rd(JS, 'vt_map_layers.js'), layers = strip(layersSrc);
const robotSrc = rd(JS, 'vt_map_robot.js'), robot = strip(robotSrc);
const scaleSrc = rd(JS, 'vt_map_scale.js'), scale = strip(scaleSrc);
const measSrc = rd(JS, 'vt_map_measure.js'), meas = strip(measSrc);
const css = rd(TPL, 'assets', 'css', 'vt_map_layers.css');

// ---- 1. the pointer ---------------------------------------------------------
const R = require(path.join(JS, 'vt_map_robot.js'));
check('pointer: loaded by vt_map_layers.js, index.html unchanged', !html.includes('vt_map_robot.js') && layers.includes("sc.src = '/assets/js/vt_map_robot.js'") && /loadRobot\(\);/.test(layers));
['fetch(', 'XMLHttpRequest', 'WebSocket', 'ROSLIB', '.publish(', 'callService', 'sendBeacon', 'advertise', '.subscribe('].forEach((w) => check('pointer sends nothing: no ' + w, !robot.includes(w)));
check('pointer: no timer and no animation loop of its own', !/setInterval|setTimeout|requestAnimationFrame/.test(robot));
check('pointer: rides the scale\'s poll, and without it does nothing', /S\.onTick\(update\)/.test(robot) && /if \(!S \|\| !S\.onTick\) \{ return; \}/.test(robot));
check('pointer: nothing moved since the last look → ends before any DOM or style work',
    (() => { const u = strip(fn('look', robotSrc)); return /if \(!dirty && sigIn === lastIn\) \{ return; \}/.test(u) && u.indexOf('sigIn === lastIn') < u.indexOf('getBoundingClientRect') &&
        u.indexOf('sigIn === lastIn') < u.indexOf('getComputedStyle') && u.indexOf('sigIn === lastIn') < u.indexOf('updateMatrixWorld') && u.indexOf('sigIn === lastIn') < u.indexOf('obstacles()'); })());
check('pointer: place and arrow written only when they change', /if \(sigOut !== lastOut\)/.test(robot) && /if \(txt\.textContent !== lab\)/.test(robot));
check('pointer: arrow keys on it never drive (vt_joy.js)', /el\.addEventListener\('keydown'[^\n]*Arrow[^\n]*stopPropagation/.test(robot));
check('pointer: the tap moves only this browser\'s camera, Follow untouched', /recenter\(V\.camera\.position, V\.cameraControls\.center, p\)/.test(robot) && !/btn_follow|follow_target|uiPref/.test(robot));
check('pointer: never over a panel or a card (elementsFromPoint), hidden with the camera large or a small map',
    /covered\(e\.x, e\.y\)/.test(robot) && /vt-cam-large/.test(robot) && /MIN_MAP_W/.test(robot));

const free = { l: 0, t: 100, r: 1400, b: 860 };
check('in view: a point well inside the free part', R.inView(700, 400, free, []) === true);
check('in view: outside each edge is out', !R.inView(-5, 400, free) && !R.inView(1405, 400, free) && !R.inView(700, 90, free) && !R.inView(700, 870, free));
check('in view: within ' + R.IN_PAD + ' px of an edge counts as out (half the robot hidden)', !R.inView(free.l + R.IN_PAD - 1, 400, free) && R.inView(free.l + R.IN_PAD, 400, free));
check('in view: under the right panel is out, beside it is in', !R.inView(1300, 200, free, [{ l: 1204, t: 100, r: 1400, b: 450 }]) && R.inView(1300, 600, free, [{ l: 1204, t: 100, r: 1400, b: 450 }]));

const rect = { l: 100, t: 100, r: 500, b: 300 };   // middle 300, 200
let e = R.edgePoint(2300, 200, rect);
check('edge: straight right → right edge, arrow 0°', e && near(e.x, 500) && near(e.y, 200) && near(e.deg, 0));
e = R.edgePoint(300, -5000, rect);
check('edge: straight up → top edge, arrow −90°', e && near(e.x, 300) && near(e.y, 100) && near(e.deg, -90));
e = R.edgePoint(-700, 1200, rect);
check('edge: down-left → on the border, on the line from the middle', e && (near(e.x, 100) || near(e.y, 300)) && e.x >= 100 - 1e-6 && e.y <= 300 + 1e-6 &&
    near((e.x - 300) * (1200 - 200), (e.y - 200) * (-700 - 300), 1e-3) && e.deg > 90 && e.deg < 180, e);
e = R.edgePoint(320, 210, rect);
check('edge: a point inside the rectangle keeps its place', e && near(e.x, 320) && near(e.y, 210));
check('edge: no rectangle (too small a map) or its very middle → nothing', R.edgePoint(900, 0, { l: 300, t: 100, r: 200, b: 300 }) === null && R.edgePoint(300, 200, rect) === null && R.edgePoint(NaN, 1, rect) === null);
let bad = 0;
for (let a = 0; a < 360; a += 7) {
    const x = 300 + 5000 * Math.cos(a * Math.PI / 180), y = 200 + 5000 * Math.sin(a * Math.PI / 180), p = R.edgePoint(x, y, rect);
    const on = p && p.x >= 100 - 1e-6 && p.x <= 500 + 1e-6 && p.y >= 100 - 1e-6 && p.y <= 300 + 1e-6 &&
        (near(p.x, 100) || near(p.x, 500) || near(p.y, 100) || near(p.y, 300));
    const d = p ? ((p.deg - a + 540) % 360) - 180 : 99;
    if (!on || Math.abs(d) > 1e-6) { bad++; }
}
check('edge: every direction lands on the border with the arrow that way', bad === 0, bad);

const cv = { l: 10, t: 20, w: 1000, h: 500 };
let s = R.ndcToPx({ x: 0, y: 0, z: 0.5 }, cv);
check('screen: the middle of the canvas', s && near(s.x, 510) && near(s.y, 270));
s = R.ndcToPx({ x: 1, y: 1, z: 0.5 }, cv);
check('screen: +x right, +y up', s && near(s.x, 1010) && near(s.y, 20));
s = R.ndcToPx({ x: 0.2, y: -0.1, z: 1.2 }, cv);
check('screen: behind the camera → mirrored and far out (direction stays right)', s && s.x < cv.l - 1000 && s.y < cv.t - 1000);
check('screen: bad numbers → nothing', R.ndcToPx({ x: NaN, y: 0, z: 0 }, cv) === null && R.ndcToPx(null, cv) === null);

check('distance en: 4.2 m, 37 m, 1.25 km, 12.3 km', R.fmtDist(4.23, 'en') === '4.2 m' && R.fmtDist(37.4, 'en') === '37 m' && R.fmtDist(1250, 'en') === '1.25 km' && R.fmtDist(12340, 'en') === '12.3 km');
check('distance cs: decimal comma, no-break space', R.fmtDist(4.23, 'cs') === '4,2 m' && R.fmtDist(1250, 'cs') === '1,25 km');
check('distance: nothing for a bad number', R.fmtDist(NaN, 'en') === '' && R.fmtDist(-1, 'en') === '');

const tfc = { frameInfos: { base_link: { transform: { translation: { x: 3.5, y: -2, z: 0.1 } } } } };
check('pose: from the TF client\'s last transform', JSON.stringify(R.tfPose(tfc)) === JSON.stringify({ x: 3.5, y: -2, z: 0.1 }));
check('pose: unknown until the first transform (no pill at the map origin)', R.tfPose({ frameInfos: { base_link: { cbs: [] } } }) === null && R.tfPose({ frameInfos: {} }) === null && R.tfPose(null) === null &&
    R.tfPose({ frameInfos: { base_link: { transform: { translation: { x: NaN, y: 0 } } } } }) === null);
const cam = { x: 10, y: 20, z: 300 }, ctr = { x: 10, y: 21, z: 0 };
R.recenter(cam, ctr, { x: -4, y: 7 });
check('recentre: target on the robot, the camera shifted by the same step (zoom, tilt, rotation stay)', ctr.x === -4 && ctr.y === 7 && ctr.z === 0 && cam.x === -4 && cam.y === 6 && cam.z === 300);

// ---- 1b. review of M15: the camera moved and no picture drawn yet; an old / no position; what stands on the map
check('pointer: the camera\'s matrices are brought up to date before the projection', robot.indexOf('cam.updateMatrixWorld();') > 0 &&
    robot.indexOf('cam.updateMatrixWorld();') < robot.indexOf('cam.matrixWorldInverse.getInverse(cam.matrixWorld);') &&
    robot.indexOf('cam.matrixWorldInverse.getInverse(cam.matrixWorld);') < robot.indexOf('.project(cam)'));
{
    // the module's DOM part in a small fake page. The fake camera projects with the matrices of the
    // last DRAWN picture (matrixWorldInverse) — exactly what THREE does — and nothing draws here.
    const mkEl = (id) => {
        const a = {}, e = { id: id || '', hidden: false, style: {}, title: '', _kids: [], offsetWidth: 110, offsetHeight: 40, textContent: '', _on: {},
            hasAttribute(k) { return k in a; }, removeAttribute(k) { delete a[k]; }, setAttribute(k, v) { a[k] = String(v); }, getAttribute(k) { return k in a ? a[k] : null }, addEventListener(t, f) { e._on[t] = f; },
            contains(x) { return e._kids.indexOf(x) >= 0; }, getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; } };
        Object.defineProperty(e, 'innerHTML', { set() { e._kids = [mkEl(), mkEl()]; e.firstChild = e._kids[0]; e.lastChild = e._kids[1]; } });
        return e;
    };
    const els = { map_view: mkEl('map_view') };
    let clock = 100000, riders = [], made = null;
    const cam = { position: { x: -60, y: -80, z: 1000 }, rotation: { z: 0 }, fov: 1.4, matrixWorld: { v: null },
        matrixWorldInverse: { v: { x: -60, y: -80 }, getInverse(m) { this.v = m.v; } }, updateMatrixWorld() { this.matrixWorld.v = { x: this.position.x, y: this.position.y }; } };
    class V3 { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } project(c) { this.x = (this.x - c.matrixWorldInverse.v.x) / 20; this.y = (this.y - c.matrixWorldInverse.v.y) / 20; this.z = 0.5; return this; } }
    const canvas = { getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }; } };
    const tfc = { ros: { isConnected: true }, frameInfos: { base_link: { transform: { translation: { x: -30, y: -40, z: 0 } } } }, _vtPoseAt: clock };
    const win = { innerWidth: 1000, innerHeight: 800, addEventListener() {}, ROS3D: { THREE: { Vector3: V3 } }, __tf_client_map: tfc,
        viewer: { viewer: { camera: cam, cameraControls: { center: { x: -60, y: -80, z: 0 }, dispatchEvent() {} }, renderer: { domElement: canvas } } },
        VTMapScale: { onTick(f) { riders.push(f); } }, VTI18n: { t: (k, v) => k + (v && v.d ? ' ' + v.d : ''), lang: () => 'en', onChange() {} } };
    const doc = { hidden: false, readyState: 'complete', getElementById: (id) => els[id] || null, createElement() { made = mkEl('vt_map_robot'); return made; },
        body: { classList: { contains: () => false }, appendChild() {} }, documentElement: {}, addEventListener() {}, elementsFromPoint: () => [] };
    new Function('window', 'document', 'getComputedStyle', 'MutationObserver', 'Date', 'module', robotSrc)(
        win, doc, () => ({ getPropertyValue: () => '' }), function () { this.observe = () => {}; }, { now: () => clock }, undefined);
    const tick = () => { clock += 250; tfc._vtPoseAt = live ? clock : tfc._vtPoseAt; riders.forEach((f) => f()); };
    let live = true;
    const deg = () => +(/rotate\((-?\d+)deg\)/.exec(made._kids[0].style.transform || '') || [0, NaN])[1];
    check('pointer (fake page): rides the scale\'s poll', riders.length === 1);
    // the picture was drawn with the view at (−60, −80): the robot (−30, −40) lies up-right of it, off the map
    tick();
    const d0 = made ? deg() : NaN;
    check('pointer (fake page): robot to the north-east → pill shown, arrow up-right', made && !made.hidden && d0 < 0 && d0 > -90, d0);
    // now the view jumps to (0, 0) and NO picture is drawn before the next tick: the robot is to the south-west
    cam.position.x = 0; cam.position.y = 0; win.viewer.viewer.cameraControls.center.x = 0; win.viewer.viewer.cameraControls.center.y = 0;
    tick();
    const d1 = deg();
    check('pointer: a tick right after the camera moved (no picture drawn yet) points the NEW way (south-west), not the old one', !made.hidden && d1 > 90 && d1 < 180, d1);
    check('pointer: … and stands on the left / bottom side of the map', parseFloat(made.style.left) < 500 && parseFloat(made.style.top) > 400, [made.style.left, made.style.top]);
    tick();
    check('pointer: … and stays right on the following ticks', deg() === d1 && !made.hidden);
    // the tap: the view goes onto the robot; again no picture is drawn before the tick
    made._on.click();
    check('pointer: the tap puts the view on the robot', win.viewer.viewer.cameraControls.center.x === -30 && cam.position.y === -40);
    tick();
    check('pointer: after the tap the pill is gone (robot in the middle), also with no picture drawn in between', made.hidden === true);
    // away again, then the position stops coming
    cam.position.x = 50; win.viewer.viewer.cameraControls.center.x = 50; tick();
    check('pointer: live position → the distance, state live', !made.hidden && made.getAttribute('data-state') === 'live' && /^maprobot\.label /.test(made._kids[1].textContent), made._kids[1].textContent);
    live = false;
    for (let i = 0; i < 15; i++) { tick(); }          // 3.75 s of silence: still live
    const before = made.getAttribute('data-state');
    for (let i = 0; i < 3; i++) { tick(); }           // 4.5 s
    check('pointer: no transform for 4 s (M17: was 3 s, too close to the 2 s gaps of a busy robot) → grey "last known position", no distance passed off as current', before === 'live' && made.getAttribute('data-state') === 'stale' &&
        made._kids[1].textContent === 'maprobot.stale' && /^maprobot\.stale_tip/.test(made.title) && !made.hidden, [before, made.getAttribute('data-state'), made._kids[1].textContent]);
    live = true; tick();
    check('pointer: the position comes again → live again', made.getAttribute('data-state') === 'live');
    tfc.ros.isConnected = false; tick();
    check('pointer: the link down → last known position at once', made.getAttribute('data-state') === 'stale');
    tfc.ros.isConnected = true; delete tfc.frameInfos.base_link.transform; tick(); clock += 40000; tick();
    check('pointer: no position, the link up for 40 s → nothing yet (M16: counted from the link, not from the page)', made.hidden === true);
    clock += 6000; tick();
    check('pointer: no position at all (link up > 45 s) → a note without an arrow, the tap does nothing', !made.hidden && made.getAttribute('data-state') === 'none' && made.hasAttribute('data-note') && made._kids[1].textContent === 'maprobot.unknown' &&
        (() => { const c = cam.position.x; made._on.click(); return cam.position.x === c; })());
}
check('pose state: live / stale after 4 s / stale with the link down / none; an older page (no time noted) counts as live',
    R.poseState({ x: 1, y: 1 }, 1000, 4900, true) === 'live' && R.poseState({ x: 1, y: 1 }, 1000, 5100, true) === 'stale' && R.poseState({ x: 1, y: 1 }, 1000, 1100, false) === 'stale' &&
    R.poseState(null, 1000, 1100, true) === 'none' && R.poseState({ x: 1, y: 1 }, undefined, 9e9, true) === 'live' && R.STALE_MS === 4000);
check('pointer: no position is said only 45 s after the LINK came up (M16; not from the page\'s start), never with the link down', /upSince = up \? \(upSince \|\| now\) : 0;/.test(robot) && /st === 'none' && \(!upSince \|\| now - upSince < UNKNOWN_MS\)/.test(robot) && R.UNKNOWN_MS === 45000);
{
    const rc = { l: 60, t: 100, r: 340, b: 760 }, w = 112, h = 40;
    const ov = (e, o) => e.x - w / 2 < o.r && e.x + w / 2 > o.l && e.y - h / 2 < o.b && e.y + h / 2 > o.t;
    const ovg = (e, o) => ov(e, { l: o.l - R.GAP + 0.01, t: o.t - R.GAP + 0.01, r: o.r + R.GAP - 0.01, b: o.b + R.GAP - 0.01 });
    const bar = { l: 6, t: 690, r: 384, b: 782 };                    // the rain bar across the bottom of a phone map
    let e = R.placeClear(200, 5000, rc, w, h, [bar]);
    check('clear: robot to the south, the rain bar at the bottom → the pill stands above the bar, arrow still down', e && !ov(e, bar) && e.y + h / 2 <= bar.t - R.GAP && near(e.deg, 90), e);
    // live run on the phone: robot to the south-west, the rain bar over the bottom-left → the pill went to the RIGHT half
    const bar2 = { l: 6, t: 681, r: 247, b: 727 }, rc2 = { l: 70, t: 232, r: 326, b: 760 };
    e = R.placeClear(198 - 3000, 496 + 4000, rc2, w, h, [bar2]);
    check('clear: robot to the south-west, the rain bar at the bottom-left → the pill steps over the bar and stays on the robot\'s (left) side', e && !ovg(e, bar2) && e.x < 198 && e.y + h / 2 <= bar2.t - R.GAP + 0.01, e);
    check('clear: with nothing in the way it is the plain edge point', JSON.stringify(R.placeClear(200, 5000, rc, w, h, [])) === JSON.stringify(R.edgePoint(200, 5000, rc)));
    const rose = { l: 12, t: 110, r: 82, b: 190 }, fab = { l: 12, t: 200, r: 60, b: 248 };
    e = R.placeClear(70, -5000, { l: 64, t: 100, r: 1100, b: 800 }, w, h, [rose, fab]);
    check('clear: robot to the north above the compass rose → not on the rose nor on the layers button', e && !ov(e, rose) && !ov(e, fab), e);
    const handle = { l: 1186, t: 104, r: 1204, b: 150 };
    e = R.placeClear(630 + 10000, 450 - 5707, { l: 64, t: 100, r: 1196, b: 800 }, w, h, [handle]);
    check('clear: robot to the east at the right panel\'s handle → the pill keeps ' + R.GAP + ' px off it, still at the right edge', e && !ovg(e, handle) && e.x > 1000, e);
    check('clear: no free place → no pill', R.placeClear(200, 5000, { l: 100, t: 100, r: 300, b: 300 }, w, h, [{ l: 0, t: 0, r: 400, b: 400 }]) === null);
    let badc = 0;
    for (let a = 0; a < 360; a += 5) {
        const p = R.placeClear(200 + 9000 * Math.cos(a * Math.PI / 180), 430 + 9000 * Math.sin(a * Math.PI / 180), rc, w, h, [bar, { l: 0, t: 90, r: 70, b: 180 }]);
        if (p && (ov(p, bar) || ov(p, { l: 0, t: 90, r: 70, b: 180 }))) { badc++; }
    }
    check('clear: in no direction does the pill stand on an obstacle', badc === 0, badc);
    check('clear: the rain bar, the rose, the buttons, the scale, the credits and the right panel\'s handle are stepped around',
        ['mapv3_precip_badge', 'vt_utm_rose', 'vt_lyr_fab', 'vt_meas_btn', 'vt_map_scale', 'mapv3_attr', 'rp_handle'].every((id) => new RegExp("var OBSTACLES = \\[[^\\]]*'" + id + "'").test(robot)) &&
        /id = 'mapv3_precip_badge'/.test(rd(JS, 'mapping.js')) && /handle\.id = 'rp_handle'/.test(rd(JS, 'right_dock.js')) && /placeClear\(s\.x, s\.y, rect, w, h, obstacles\(\)\)/.test(robot));
}

// ---- 1c. the TF watchdog of map_view.js (a loaded robot answers the TF request late)
{
    const mv = rd(JS, 'map_view.js');
    const cls = sliceAt(mv, mv.indexOf('class TfClient {'));
    let now = 0, timers = [], tid = 0;
    const warns = [];
    const st = (f, ms) => { timers.push({ id: ++tid, at: now + ms, f }); return tid; };
    const ct = (id) => { timers = timers.filter((x) => x.id !== id); };
    const run = (until) => {
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            if (!timers.length || timers[0].at > until) { break; }
            const x = timers.shift(); now = x.at; x.f();
        }
        now = until;
    };
    const V = function () { this.copy = () => {}; };
    let calls, topics, answerDelay;
    function FakeTF(o) {
        this.ros = o.ros; this.frameInfos = {}; this.currentTopic = false; this.angularThres = 2; this.transThres = 2;
        this.serviceClient = { callService: (req, cb) => { const n = calls.push({ at: now, frames: req.source_frames.slice() }); st(() => cb({ topic_name: '/tf_repub_' + n }), answerDelay(n)); } };
    }
    FakeTF.prototype.updateGoal = function () { this.serviceClient.callService({ source_frames: Object.keys(this.frameInfos) }, this.processResponse.bind(this)); };
    FakeTF.prototype.processResponse = function (r) { if (this.currentTopic) { topics.push('-' + this.currentTopic); } this.currentTopic = r.topic_name; topics.push('+' + r.topic_name); };
    FakeTF.prototype.processTFArray = function () {};
    const mk = () => {
        now = 0; timers = []; calls = []; topics = []; warns.length = 0;
        const C = new Function('THREE', 'ROSLIB', 'document', 'setTimeout', 'clearTimeout', 'Date', 'console', cls + '\nreturn TfClient;')(
            { Vector3: V, Quaternion: V }, { TFClient: FakeTF }, { addEventListener() {} }, st, ct, { now: () => now }, { warn: (m) => warns.push(m), log() {} });
        const c = new C({ ros: { isConnected: true } }, { camera: { position: {}, rotation: {} }, cameraControls: { center: {} } });
        ['base_link', 'odom'].forEach((f) => { c.tfClientMap.frameInfos[f] = { cbs: [] }; });
        return c;
    };
    // (a) the robot answers after 7 s: the page's own request, nothing else until the answer, ONE topic
    answerDelay = () => 7000;
    let c = mk();
    c.tfClientMap.updateGoal();                       // roslib's own first request (page load)
    run(6900);
    check('TF watchdog: while the first request is unanswered (7 s) nothing is asked again', calls.length === 1, calls);
    run(7100);
    check('TF watchdog: its answer subscribes one topic', topics.join(' ') === '+/tf_repub_1');
    run(11000);                                       // the first transforms come 4 s after the answer
    check('TF watchdog: right after the answer the new topic gets a moment (no second request 3 s after it)', calls.length === 1, calls);
    c.tfClientMap.frameInfos.base_link.transform = {}; c.tfClientMap.frameInfos.odom.transform = {};
    st(function beat() { c.tfClientMap.processTFArray({ transforms: [{ child_frame_id: 'base_link' }] }); st(beat, 500); }, 0);      // the stream is live
    run(120000);
    check('TF watchdog: transforms come and the stream is live → done: one request, one topic, no warning', calls.length === 1 && topics.length === 1 && !warns.length, { calls: calls.length, topics, warns });
    // (b) answers out of order: an older request's answer never switches the subscription
    answerDelay = (n) => (n === 1 ? 9000 : 1000);
    c = mk();
    c.tfClientMap.updateGoal();                       // request 1 (answer after 9 s)
    run(500); c.tfClientMap.frameInfos.d435 = { cbs: [] }; c.tfClientMap.updateGoal();   // roslib: a frame subscribed later → request 2 (answer at 1.5 s)
    run(1600); c.tfClientMap.frameInfos.base_link.transform = {}; c.tfClientMap.frameInfos.odom.transform = {}; c.tfClientMap.frameInfos.d435.transform = {};
    st(function beat() { c.tfClientMap.processTFArray({ transforms: [{ child_frame_id: 'base_link' }] }); st(beat, 500); }, 0);
    run(9500);
    check('TF watchdog: a late answer to an OLDER request does not switch the subscription (the newest request names every frame)',
        topics.join(' ') === '+/tf_repub_2' && calls[1].frames.length === 3, topics);
    // (c) the transforms never come (first TFArray missed …): it keeps asking, with growing gaps up to 30 s, never more often
    answerDelay = () => 3000;
    c = mk();
    c.tfClientMap.updateGoal();
    run(600000);
    const gaps = calls.slice(1).map((x, i) => x.at - calls[i].at);
    check('TF watchdog: robot position missing → it does not give up (10 min: > 5 requests, was 5 and then nothing until a reload)', calls.length > 10 && !warns.some((w) => /giving up/.test(w)), calls.length);
    check('TF watchdog: first look after 5 s, gaps grow, at least 5 s apart and one per ~30 s in the long run', calls[1].at >= 5000 && Math.min(...gaps) >= 5000 && gaps[gaps.length - 1] === 30000 && Math.max(...gaps) <= 30000, gaps.slice(0, 8));
    check('TF watchdog: each answer replaces the one subscribed topic (the old one is let go)', topics.filter((x) => x[0] === '+').length - topics.filter((x) => x[0] === '-').length === 1);
    // … and once they come it stops
    c.tfClientMap.frameInfos.base_link.transform = {}; c.tfClientMap.frameInfos.odom.transform = {};
    st(function beat() { c.tfClientMap.processTFArray({ transforms: [{ child_frame_id: 'base_link' }] }); st(beat, 500); }, 0);
    const nBefore = calls.length; run(now + 120000);
    check('TF watchdog: … and stops once the transforms come', calls.length <= nBefore + 1, [nBefore, calls.length]);
    // (d) only a frame that does not exist in TF is missing: bounded as before
    answerDelay = () => 500;
    c = mk();
    c.tfClientMap.frameInfos.base_link.transform = {};
    st(function beat() { c.tfClientMap.processTFArray({ transforms: [{ child_frame_id: 'base_link' }] }); st(beat, 500); }, 0);
    c.tfClientMap.updateGoal();
    run(1200000);
    check('TF watchdog: only another frame missing (one that does not exist) → stops after 5 re-requests with a warning, no endless topics',
        calls.length === 6 && warns.filter((w) => /giving up after 5/.test(w)).length === 1, { calls: calls.length, warns: warns.slice(-1) });
    // (e) not connected: nothing is sent
    c = mk(); c.tfClientMap.ros.isConnected = false; run(300000);
    check('TF watchdog: without the link nothing is asked', calls.length === 0);
    check('map_view: the time of the robot\'s last transform is noted for the pill and for measuring', /tf_client\.tfClientMap\._vtPoseAt = Date\.now\(\);\s*tf_client\.follow_robot_set/.test(mv));
}

// ---- 2. the scale's poll carries riders -------------------------------------
check('scale: still ONE timer — a timeout chain now (M17), no interval', !/setInterval\(/.test(scale) && (scale.match(/timer = setTimeout\(tick, /g) || []).length === 3);
{
    const calls = [];
    const T = new Function('update', 'document', 'setTimeout', 'var riders = [], moved = false, quiet = 0, slow = false, timer = null, QUIET_LOOKS = 8, SLOW_MS = 1000, POLL_MS = 250;\n' + fn('tick', scaleSrc) + '\nreturn { tick: tick, riders: riders };');
    const doc = { hidden: false };
    const t = T(() => calls.push('scale'), doc, () => 1);
    t.riders.push(() => calls.push('a'), () => { throw new Error('x'); }, () => calls.push('c'));
    t.tick();
    check('scale tick: the scale first, then every rider; a failing rider stops nothing', calls.join(',') === 'scale,a,c', calls);
    calls.length = 0; doc.hidden = true; t.tick();
    check('scale tick: nothing at all while the page is hidden', calls.join(',') === '', calls);
}
check('scale: onTick takes a function once', /api\.onTick = function \(fn\) \{ if \(typeof fn === 'function' && riders\.indexOf\(fn\) < 0\) \{ riders\.push\(fn\); \} \};/.test(scale));

// ---- 3. the robot's layers in the panel -------------------------------------
{
    const rowsSrc = /var ROBOT_ROWS = \[[\s\S]*?\n    \];/.exec(layersSrc);
    check('layers: ROBOT_ROWS found', !!rowsSrc);
    const L = new Function('$', 't', 'esc', 'newTag', rowsSrc[0] + '\n' + fn('ovRow', layersSrc) + '\n' + fn('robotRows', layersSrc) + '\n' + fn('robotHtml', layersSrc) +
        '\nreturn { ROBOT_ROWS: ROBOT_ROWS, ovRow: ovRow, robotRows: robotRows, robotHtml: robotHtml };');
    const escF = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    let have = { mapv3_chk_base: 1, mapv3_chk_site: 1, mapv3_chk_sensing: 1 };
    const m = L((id) => have[id] ? {} : null, (k) => k, escF, () => '');
    const ids = m.ROBOT_ROWS.map((r) => r[1]);
    check('layers: the rows mirror checkboxes that exist in index.html', ids.length === 3 && ids.every((id) => html.includes('id="' + id + '"')), ids);
    check('layers: … which the modules listen to with "change" (set through setChk → fire)', /chk\.addEventListener\('change'/.test(rd(JS, 'map_view.js')) && /this\.chk_site\.addEventListener\('change'/.test(rd(JS, 'mapping.js')) && /this\.chk\.addEventListener\('change'/.test(rd(JS, 'mapping.js')));
    const h = m.robotHtml();
    check('layers: three switch rows, each the mirror of its checkbox', (h.match(/role="switch"/g) || []).length === 3 && ids.every((id) => h.includes('data-lyr-chk="' + id + '"')));
    check('layers: swatches in the Map tab\'s colours (cyan, red, violet + yellow)', ['vt-sw-00e5e5', 'vt-sw-ff4d4d', 'vt-sw-b388ff', 'vt-sw-ffd23f'].every((c) => h.includes('vt-lyr-swatch ' + c)) && (h.match(/vt-lyr-swatch/g) || []).length === 4);
    const cssAll = rd(TPL, 'assets', 'css', 'vt_panel.css');
    check('layers: … classes that exist', ['vt-sw-00e5e5', 'vt-sw-ff4d4d', 'vt-sw-b388ff', 'vt-sw-ffd23f'].every((c) => cssAll.includes('.' + c + ' {')));
    const rows = h.split('<div class="vt-lyr-ov"').slice(1);
    check('layers: layers on by default keep their hint as a tooltip only; Sensing shows its colour key', rows.length === 3 &&
        /title="maplyr\.m15\.base_hint"/.test(rows[0]) && !rows[0].includes('vt-lyr-hint') && !rows[1].includes('vt-lyr-hint') &&
        rows[2].includes('<div class="vt-lyr-hint">maplyr.m15.sense_hint</div>'));
    check('layers: a row with nothing under it shows no empty box', /x\.hidden = !v \|\| !x\.firstChild;/.test(layers) && /<div class="vt-lyr-ovx" hidden><\/div>/.test(rows[0]));
    have = { mapv3_chk_base: 1 };
    check('layers: a page without a checkbox gets no row for it', (L((id) => have[id] ? {} : null, (k) => k, escF, () => '').robotHtml().match(/role="switch"/g) || []).length === 1);
    have = {};
    check('layers: no checkbox → nothing', L(() => null, (k) => k, escF, () => '').robotHtml() === '');
    check('layers: the old call (no options) is unchanged: hint shown, no swatch', (() => { const o = m.ovRow('kn', 'mapv3_ov_kn', 'Cadastre', 'hint', '<i></i>'); return o.includes('<div class="vt-lyr-hint">hint</div>') && !o.includes('vt-lyr-swatch') && o.includes('<i></i>'); })());
    const iHead = layers.indexOf("data-lyr-robot>' + esc(t('trav.grp'))"), iTrav = layers.indexOf("ovRow('trav'"), iWeather = layers.indexOf("t('maplyr.grp.weather')");
    check('layers: they lead the group Robot (one heading, before the terrain layers and Weather)', iHead > 0 && iHead < iTrav && iTrav < iWeather &&
        /if \(!robot\) \{ h\.push\('<div class="vt-lyr-grp-h">' \+ esc\(t\('trav\.grp'\)\)/.test(layers) && /if \(!robot && !\$\('mapv3_chk_trav'\)\)/.test(layers));
    check('layers: the panel is rebuilt when the set of rows changes', /robotRows\(\)\.map\(function \(r\) \{ return r\[0\]; \}\)\.join\(','\)/.test(fn('structSig', layersSrc)));
}

// ---- 4. measuring from the robot --------------------------------------------
const M = require(path.join(JS, 'vt_map_measure.js'));
const P = { x: 1, y: 2 };
check('from robot: allowed with a known position', M.robotState(P, [], false).ok === true && M.robotState(P, [{ x: 5, y: 5 }], false).ok === true);
check('from robot: not while the position is unknown', M.robotState(null, [], false).why === 'nopose' && M.robotState({ x: NaN, y: 0 }, [], false).why === 'nopose');
check('from robot: not while taps are blocked (Marker panel, editor)', M.robotState(P, [], true).why === 'blocked');
check('from robot: not past the limit of points', M.robotState(P, new Array(M.MAX_POINTS).fill({ x: 9, y: 9 }), false).why === 'full');
check('from robot: not twice in a row on the same spot, again once the robot moved', M.robotState(P, [{ x: 1.001, y: 2 }], false).why === 'same' && M.robotState(P, [{ x: 1.2, y: 2 }], false).ok);
check('from robot: not from an old position (no transform for 4 s, or the link down); an older page without the time counts as fresh',
    M.robotState(P, [], false, true).why === 'stale' && M.tfStale({ _vtPoseAt: 1000, ros: { isConnected: true } }, 5100) === true && M.tfStale({ _vtPoseAt: 1000, ros: { isConnected: true } }, 4900) === false &&
    M.tfStale({ _vtPoseAt: 1000, ros: { isConnected: false } }, 1100) === true && M.tfStale({ ros: { isConnected: true } }, 9e9) === false &&
    /robotState\(robotXY\(\), S\.pts, !!why, robotStale\(\)\)/.test(meas) && /robotState\(p, S\.pts, !!blocked\(\), robotStale\(\)\)/.test(meas));
check('from robot: the position is the TF client\'s last transform (read only)', JSON.stringify(M.tfXY(tfc)) === JSON.stringify({ x: 3.5, y: -2 }) && M.tfXY({ frameInfos: {} }) === null);
check('from robot: the button is in the card, re-checked when pressed', /data-meas-robot/.test(meas) && /el\.hasAttribute\('data-meas-robot'\)\) \{ addRobot\(\); \}/.test(meas) &&
    /rs = robotState\(p, S\.pts, !!blocked\(\), robotStale\(\)\);\s*if \(!S\.on \|\| !rs\.ok\) \{ S\.note = rs\.why; S\.noteUntil = Date\.now\(\) \+ 4000; card\(\); return; \}/.test(meas));
check('from robot: off = greyed but still answering a tap (no tooltip on a phone): the reason shows in the card for 4 s, and as its tooltip',
    /rb\.setAttribute\('aria-disabled', String\(!rs\.ok\)\); rb\.classList\.toggle\('is-off', !rs\.ok\);/.test(meas) && !/rb\.disabled/.test(meas) &&
    /note \? t\('measure\.m15\.rb\.' \+ note\)/.test(meas) && /sub\.classList\.toggle\('is-warn', !!why \|\| !!note\)/.test(meas) && /\.vt-meas-act\.is-off \{ opacity: 0\.45; \}/.test(css) && /t\('measure\.m15\.rb\.' \+ \(rs\.ok \? 'tip' : rs\.why\)\)/.test(meas));
['fetch(', 'XMLHttpRequest', 'WebSocket', 'ROSLIB', '.publish(', 'callService', '.subscribe('].forEach((w) => check('measuring still sends nothing: no ' + w, !meas.includes(w)));

// ---- 5. the 1 s check only while measuring ----------------------------------
check('measuring: no check running while it is off', !/setInterval\(function \(\) \{ if \(S\.on\)/.test(meas) &&
    /if \(S\.on && !S\.watch\) \{ S\.watch = setInterval\(function \(\) \{ if \(!document\.hidden\) \{ card\(\); \} \}, 1000\); \}/.test(meas) && /if \(!S\.on && S\.watch\) \{ clearInterval\(S\.watch\); S\.watch = null; \}/.test(meas));
{
    // setOn() as written, with stubs: the timer starts once, stops with measuring
    const timers = []; let cleared = 0;
    const S = { on: false, pts: [{}], btn: { setAttribute() {} }, card: { hidden: true }, watch: null };
    const setOn = new Function('S', 'build', 'wire', 'redraw', 'place', 'card', 'setInterval', 'clearInterval', fn('setOn', measSrc) + '\nreturn setOn;')(
        S, () => {}, () => {}, () => {}, () => {}, () => {}, (f, ms) => { timers.push(ms); return 7; }, () => { cleared++; });
    setOn(true); setOn(true);
    const one = timers.length === 1 && timers[0] === 1000 && S.watch === 7;
    setOn(false);
    check('measuring: one 1 s check while on, cleared when it ends (points gone too)', one && cleared === 1 && S.watch === null && S.pts.length === 0, { timers, cleared });
    setOn(false);
    check('measuring: ending twice clears once', cleared === 1);
}

// ---- 6. i18n, help, CSS -----------------------------------------------------
const vm = require('vm');
const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(rd(JS, 'i18n', l + '.js'), ctx));
const D = win.VT_I18N_DICT;
const keys = new Set();
[robotSrc, measSrc, layersSrc].forEach((src) => { let m; const re = /t\('((?:maprobot|measure\.m15|maplyr\.m15)\.[a-z0-9_.]+)'/g; while ((m = re.exec(src))) { keys.add(m[1]); } });
['base', 'site', 'sense'].forEach((k) => { keys.add('maplyr.m15.' + k); keys.add('maplyr.m15.' + k + '_hint'); });
['tip', 'nopose', 'full', 'same', 'blocked', 'stale'].forEach((k) => keys.add('measure.m15.rb.' + k));
[...keys].filter((k) => k.endsWith('.')).forEach((k) => keys.delete(k));
const miss = [...keys].filter((k) => !(k in D.en) || !(k in D.cs));
check('M15 keys in en + cs (' + keys.size + ')', keys.size >= 14 && !miss.length, miss.join(', '));
const ph = (x) => (String(x).match(/\{[a-z]+\}/g) || []).sort().join(',');
check('same placeholders en / cs', [...keys].every((k) => ph(D.en[k]) === ph(D.cs[k])));
check('cs is Czech (differs from en) but for the pill "Robot {d}"', [...keys].filter((k) => k !== 'maprobot.label').every((k) => D.en[k] !== D.cs[k]));
check('the pill and its tooltip carry the distance', ph(D.en['maprobot.label']) === '{d}' && ph(D.cs['maprobot.tip']) === '{d}');
const flat = (x) => x.replace(/\s+/g, ' ');
const hen = flat(rd(ROOT, 'docs', 'help', 'mapping.md')), hcs = flat(rd(ROOT, 'docs', 'help', 'cs', 'mapping.md'));
check('help en: Robot out of view, From robot, the robot\'s layers', /### Robot out of view/.test(hen) && /\*\*From robot\*\*/.test(hen) && /\*\*Navigation map\*\*/.test(hen) && /\*\*What the robot sees now\*\*/.test(hen));
check('help cs: Robot mimo obraz, Od robota, vrstvy robota', /### Robot mimo obraz/.test(hcs) && /\*\*Od robota\*\*/.test(hcs) && /\*\*Navigační mapa\*\*/.test(hcs) && /\*\*Co robot právě vidí\*\*/.test(hcs));
check('help names the layers as the UI does', hen.includes(D.en['maplyr.m15.site']) && hcs.includes(D.cs['maplyr.m15.site']) && hcs.includes(D.cs['measure.m15.robot']));
const pill = /\.vt-map-robot \{[^}]*\}/.exec(css);
check('css: the pill is a 40 px touch target, fixed, under the layers button (z-index 4 < 5), tokens only', !!pill && /min-height: var\(--vt-touch, 40px\)/.test(pill[0]) && /position: fixed; z-index: 4;/.test(pill[0]) &&
    /white-space: nowrap/.test(pill[0]) && !/#[0-9a-f]{3,6}\b/i.test(pill[0]) && /\.vt-lyr-fab \{\s*position: fixed; z-index: 5;/.test(css));
check('css: an old / unknown position looks different (muted, dashed; no arrow without a position)', /\.vt-map-robot\[data-state="stale"\], \.vt-map-robot\[data-state="none"\] \{ color: var\(--vt-muted\); border-style: dashed; \}/.test(css) &&
    /\.vt-map-robot\[data-note\] \.vt-map-robot-a \{ display: none; \}/.test(css));
check('css: hidden pill is gone; From robot keeps its whole text', /\.vt-map-robot\[hidden\] \{ display: none; \}/.test(css) && /\.vt-meas-act\.vt-meas-robot \{ flex: 0 0 auto; \}/.test(css));

console.log(fails ? '\n' + fails + ' of ' + count + ' FAILED' : '\nall ' + count + ' checks passed');
process.exit(fails ? 1 : 0);
