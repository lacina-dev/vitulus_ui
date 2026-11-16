#!/usr/bin/env node
/*
 * T17 batch M16 (2026-11-16):
 *     node tools/test_map_m16.node.js
 *   1. TF watchdog (map_view.js): the robot's position goes quiet on a LIVE link after everything
 *      had come → woken (tfStreamCheck), asks again with growing gaps, one topic at a time, stops
 *      when the position comes; nothing runs while all is well;
 *   2. "position unknown" counts from the link coming up;
 *   3. the layers button: no timer, the rose watched by events, once;
 *   4. the pill: a turned map (camera turn only), the map editor, an old position with the robot
 *      in view, arrow keys, the note takes no tap;
 *   5. hidden tab: the open layers panel's and the measuring card's 1 s refresh rest;
 *   i18n en + cs, help en + cs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
const robotSrc = rd(JS, 'vt_map_robot.js'), robot = strip(robotSrc);
const layersSrc = rd(JS, 'vt_map_layers.js'), layers = strip(layersSrc);
const meas = strip(rd(JS, 'vt_map_measure.js'));

// ---- 1. the TF watchdog ------------------------------------------------------
{
    const cls = sliceAt(mv, mv.indexOf('class TfClient {'));
    let now = 0, timers = [], tid = 0, calls = [], topics = [], beatOn = true;
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
    function FakeTF(o) {
        this.ros = o.ros; this.frameInfos = {}; this.currentTopic = false;
        this.serviceClient = { callService: (req, cb) => { const n = calls.push({ at: now }); st(() => cb({ topic_name: '/tf_repub_' + n }), 1000); } };
    }
    FakeTF.prototype.updateGoal = function () { this.serviceClient.callService({}, this.processResponse.bind(this)); };
    FakeTF.prototype.processResponse = function (r) { if (this.currentTopic) { topics.push('-' + this.currentTopic); } this.currentTopic = r.topic_name; topics.push('+' + r.topic_name); };
    FakeTF.prototype.processTFArray = function () {};
    const C = new Function('THREE', 'ROSLIB', 'document', 'setTimeout', 'clearTimeout', 'Date', 'console', cls + '\nreturn TfClient;')(
        { Vector3: V, Quaternion: V }, { TFClient: FakeTF }, { addEventListener() {} }, st, ct, { now: () => now }, { warn: (m) => warns.push(m), log() {} });
    const c = new C({ ros: { isConnected: true } }, { camera: { position: {}, rotation: {} }, cameraControls: { center: {} } });
    ['base_link', 'odom'].forEach((f) => { c.tfClientMap.frameInfos[f] = { cbs: [] }; });
    // the "stream": 2 Hz while on; `others` = transforms come but not the robot's own
    let others = false;
    const beatOnly = () => timers.filter((x) => x.f.name !== 'beat').length;
    st(function beat() { if (beatOn) { c.tfClientMap.processTFArray({ transforms: others ? [{ child_frame_id: 'odom' }] : [{ child_frame_id: '/base_link' }, { child_frame_id: 'odom' }] }); } st(beat, 500); }, 1500);
    // the page as the pill does it: 4 looks a second
    const look = (until) => { let woke = 0; while (now < until) { run(now + 250); if (c.tfStreamCheck()) { woke++; } } return woke; };
    c.tfClientMap.updateGoal();
    run(1200); c.tfClientMap.frameInfos.base_link.transform = {}; c.tfClientMap.frameInfos.odom.transform = {};
    let woke = look(120000);
    check('watchdog: all came → it ends, ONE request, and then nothing of it runs (no timer on a healthy page)', calls.length === 1 && beatOnly() === 0 && woke === 0 && !warns.length, { calls: calls.length, t: beatOnly(), woke });
    // the stream goes silent, the link stays up
    beatOn = false; const n0 = calls.length, t0 = now;
    woke = look(t0 + 9000);
    check('watchdog: 9 s of silence on a live link → not yet (a short gap is not a lost stream)', woke === 0 && calls.length === n0);
    woke = look(t0 + 40000);
    check('watchdog: the position quiet > 10 s on a live link → it wakes and asks again (was: 0 requests in 40 s, silent until a reconnect)', woke >= 1 && calls.length > n0, { woke, calls: calls.length - n0 });
    look(t0 + 300000);
    const g = calls.slice(n0).map((x, i, a) => i ? x.at - a[i - 1].at : 0).slice(1);
    check('watchdog: … with growing gaps, never under 5 s apart, at most one per 30 s in the long run', g.length >= 5 && Math.min(...g) >= 5000 && g[g.length - 1] >= 30000 && g[g.length - 1] <= 36000 && g[0] < g[g.length - 1], g);
    check('watchdog: … one subscribed topic at a time (each answer lets the old one go)', topics.filter((x) => x[0] === '+').length - topics.filter((x) => x[0] === '-').length === 1);
    // it comes back
    beatOn = true; const n1 = calls.length; look(now + 120000);
    check('watchdog: the position comes again → it stops (at most one more request), nothing runs', calls.length <= n1 + 1 && beatOnly() === 0, [n1, calls.length, beatOnly()]);
    const n2 = calls.length, t2 = now; beatOn = false; look(t2 + 30000);
    const first = calls[n2] ? calls[n2].at - t2 : null;
    check('watchdog: a later silence starts with the short gap again (first request ~15 s after the last transform)', first !== null && first >= 10000 && first <= 17000, first);
    beatOn = true; look(now + 60000);
    // transforms come, but not the robot's own
    others = true; const n3 = calls.length; look(now + 60000);
    check('watchdog: other transforms come but the robot\'s own does not → asked again too', calls.length > n3, calls.length - n3);
    others = false; look(now + 60000);
    // the link down: no waking
    c.tfClientMap.ros.isConnected = false; beatOn = false; const n4 = calls.length; woke = look(now + 60000);
    check('watchdog: with the link down it is not woken and nothing is asked', woke === 0 && calls.length === n4);
    check('watchdog: no timer of its own for this — it is woken by the pill\'s look (scale poll)', !/setInterval\(/.test(strip(cls)) && /root\.tf_client\.tfStreamCheck\(\)/.test(robot) &&
        /if \(st === 'stale' && up && root\.tf_client && root\.tf_client\.tfStreamCheck\)/.test(robot));
}

// ---- 2 + 4. the pill in a fake page ------------------------------------------
{
    const mkEl = (id) => {
        const a = {}, e = { id: id || '', hidden: false, style: {}, title: '', _kids: [], offsetWidth: 110, offsetHeight: 40, textContent: '', _on: {},
            setAttribute(k, v) { a[k] = String(v); }, getAttribute(k) { return k in a ? a[k] : null; }, addEventListener(t, f) { e._on[t] = f; },
            contains(x) { return e._kids.indexOf(x) >= 0; }, getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; } };
        Object.defineProperty(e, 'innerHTML', { set() { e._kids = [mkEl(), mkEl()]; e.firstChild = e._kids[0]; e.lastChild = e._kids[1]; } });
        return e;
    };
    const els = { map_view: mkEl('map_view') };
    let clock = 100000, riders = [], made = null, woken = 0, editor = false;
    // the fake camera: straight above; its turn (quaternion.z) rotates the picture by 180° when > 0.5
    const cam = { position: { x: 0, y: 0, z: 1000 }, rotation: { z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, fov: 1.4, matrixWorld: { v: null },
        matrixWorldInverse: { v: { x: 0, y: 0, flip: false }, getInverse(m) { this.v = m.v; } },
        updateMatrixWorld() { this.matrixWorld.v = { x: this.position.x, y: this.position.y, flip: this.quaternion.z > 0.5 }; } };
    class V3 { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
        project(c) { const v = c.matrixWorldInverse.v, k = v.flip ? -1 : 1; this.x = k * (this.x - v.x) / 20; this.y = k * (this.y - v.y) / 20; this.z = 0.5; return this; } }
    const canvas = { getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }; } };
    const tfc = { ros: { isConnected: false }, frameInfos: { base_link: { cbs: [] } }, _vtPoseAt: undefined };
    const win = { innerWidth: 1000, innerHeight: 800, addEventListener() {}, ROS3D: { THREE: { Vector3: V3 } }, __tf_client_map: tfc,
        tf_client: { tfStreamCheck() { woken++; } }, MapEditor: { controller: () => ({ active: editor }) },
        viewer: { viewer: { camera: cam, cameraControls: { center: { x: 0, y: 0, z: 0 }, dispatchEvent() {} }, renderer: { domElement: canvas } } },
        VTMapScale: { onTick(f) { riders.push(f); } }, VTI18n: { t: (k, v) => k + (v && v.d ? ' ' + v.d : ''), lang: () => 'en', onChange() {} } };
    const doc = { hidden: false, readyState: 'complete', getElementById: (id) => els[id] || null, createElement() { made = mkEl('vt_map_robot'); return made; },
        body: { classList: { contains: () => false }, appendChild() {} }, documentElement: {}, addEventListener() {}, elementsFromPoint: () => [] };
    new Function('window', 'document', 'getComputedStyle', 'MutationObserver', 'Date', 'module', robotSrc)(
        win, doc, () => ({ getPropertyValue: () => '' }), function () { this.observe = () => {}; }, { now: () => clock }, undefined);
    let live = false;
    const tick = (n) => { for (let i = 0; i < (n || 1); i++) { clock += 250; if (live) { tfc._vtPoseAt = clock; } riders.forEach((f) => f()); } };
    const shown = () => !!made && !made.hidden;
    const state = () => made && made.getAttribute('data-state');
    const deg = () => +(/rotate\((-?\d+)deg\)/.exec(made._kids[0].style.transform || '') || [0, NaN])[1];
    // the page sits 2 minutes without a link, then the link comes up, still no position
    tick(480);
    check('unknown: 2 min with no link and no position → no note (the frame says "no connection" itself)', !shown());
    tfc.ros.isConnected = true; tick(160);
    check('unknown: 40 s after the link came up → still nothing (counted from the link, not from the page\'s 2 min)', !shown());
    tick(24);
    check('unknown: 46 s after the link came up → "Robot: position unknown"', shown() && state() === 'none' && made._kids[1].textContent === 'maprobot.unknown');
    tfc.ros.isConnected = false; tick(); tfc.ros.isConnected = true; tick(8);
    check('unknown: the link dropped and came back → the 45 s start again', !shown());
    // the position comes: robot 30 m east, 40 m north of the view's middle → off the map (20 m to an edge of the fake picture)
    live = true; tfc.frameInfos.base_link.transform = { translation: { x: 30, y: 40, z: 0 } }; tick();
    const d0 = deg();
    check('turned map: straight view, robot to the north-east → arrow up-right', shown() && state() === 'live' && d0 < 0 && d0 > -90, d0);
    // the map is turned half a circle: ONLY the camera's turn changes (straight above the middle neither the camera nor its target moves)
    cam.quaternion.z = 1; cam.quaternion.w = 0; tick();
    const d1 = deg();
    check('turned map: the view turned by 180° (camera and target in place) → the arrow turns too (down-left), not kept from before', shown() && d1 > 90 && d1 < 180, d1);
    check('turned map: … and the pill stands on the other side', parseFloat(made.style.left) < 500 && parseFloat(made.style.top) > 400, [made.style.left, made.style.top]);
    cam.quaternion.z = 0; cam.quaternion.w = 1; tick();
    check('turned map: back → as before', deg() === d0);
    // keyboard driving: arrow keys on the focused pill never reach vt_joy.js (window); other keys are the browser's
    let stopped = 0; made._on.keydown({ key: 'ArrowUp', stopPropagation() { stopped++; } }); made._on.keydown({ key: 'ArrowLeft', stopPropagation() { stopped++; } });
    let other = 0; made._on.keydown({ key: 'Tab', stopPropagation() { other++; } });
    check('keyboard: arrow keys on the focused pill stop there (never a drive command), Tab passes', stopped === 2 && other === 0);
    // the map editor opens: no pill; closes: back
    editor = true; tick();
    check('editor: open → no pill (every tap there edits, its tools own the edges)', !shown());
    tick(4); check('editor: … stays away while it is open', !shown());
    editor = false; tick();
    check('editor: closed → the pill is back without anything else moving', shown() && deg() === d0);
    // an old position with the robot IN VIEW: the note
    win.viewer.viewer.cameraControls.center.x = 30; win.viewer.viewer.cameraControls.center.y = 40; cam.position.x = 30; cam.position.y = 40; tick();
    check('in view, live → nothing', !shown());
    live = false; tick(11); const w0 = woken;
    check('in view, live for 2.75 s of silence → still nothing, the watchdog not woken', !shown() && w0 === 0);
    tick(3);
    check('in view, the position old (3 s) → grey note "last known position" without an arrow (the robot drawn there is where it WAS)', shown() && state() === 'none' &&
        made._kids[1].textContent === 'maprobot.stale' && /^maprobot\.stale_here_tip/.test(made.title), [state(), made && made._kids[1].textContent, made && made.title]);
    check('… and the TF watchdog is woken on a live link', woken > 0);
    const cx = cam.position.x; made._on.click();
    check('… the note takes no tap', cam.position.x === cx && shown());
    tfc.ros.isConnected = false; const w1 = woken; tick(4);
    check('… with the link down the note stays, the watchdog is left alone', shown() && woken === w1);
    tfc.ros.isConnected = true; live = true; tick();
    check('in view, the position comes again → the note goes', !shown());
    cam.position.x = 0; cam.position.y = 0; win.viewer.viewer.cameraControls.center.x = 0; win.viewer.viewer.cameraControls.center.y = 0; live = false; tick(15);
    check('out of view, old → the grey pill WITH its arrow (as M15)', shown() && state() === 'stale' && deg() === d0);
}
check('pill: the camera\'s turn is in the "nothing moved" signature', /\(\+q\.x \|\| 0\)\.toFixed\(3\)/.test(robot) && /\(\+q\.w \|\| 0\)\.toFixed\(3\)/.test(robot));
check('pill: still no timer, nothing sent', !/setInterval|setTimeout|requestAnimationFrame/.test(robot) && ['fetch(', 'WebSocket', '.publish(', 'callService', '.subscribe('].every((w) => !robot.includes(w)));

// ---- 3. the layers button: events only ---------------------------------------
{
    const init = layers.slice(layers.indexOf('    function init() {'), layers.indexOf('window.VTMapLayers = {'));
    check('layers: init() starts no timer (the 1 s wait for the rose and the 5 s re-check are gone)', !/setInterval\(/.test(init));
    const all = layers.match(/setInterval\(/g) || [];
    check('layers: the only interval left is the open panel\'s 1 s refresh, cleared on close', all.length === 1 && /timer = setInterval\(function \(\) \{ if \(!document\.hidden\) \{ sync\(\); \} \}, 1000\)/.test(layers) && /if \(timer\) \{ clearInterval\(timer\); timer = null; \}/.test(layers));
    // watchRose as written, with stub observers
    const obs = [], lst = [];
    let placed = 0;
    const fab = { hidden: false, getBoundingClientRect: () => ({ top: fabTop }) };
    let fabTop = 208;
    const rose = { style: {}, offsetHeight: 80, getBoundingClientRect: () => ({ bottom: 200 }), contains: () => false };
    const wrap = { contains: (x) => x === rose };
    const RO = function (f) { this.observe = (e) => obs.push(['resize', e, f]); };
    const W = new Function('window', 'ResizeObserver', 'document', 'MutationObserver', '$', 'schedulePlace',
        'var roseSeen = null;\n' + fn('watchRose', layersSrc) + '\nreturn watchRose;')(
        { ResizeObserver: RO }, RO,
        { addEventListener: (t, f) => lst.push([t, f]) }, function (f) { this.observe = (e, o) => obs.push(['style', e, f, o]); },
        (id) => (id === 'vt_lyr_fab' ? fab : null), () => { placed++; });
    W(null);
    check('layers: no rose yet → nothing watched', obs.length === 0 && lst.length === 0);
    W(rose); W(rose); W(rose);
    check('layers: the rose is watched from the first place() that finds it — its style and its size, ONCE', obs.length === 2 && obs.some((o) => o[0] === 'style' && o[1] === rose && o[3].attributeFilter[0] === 'style') && obs.some((o) => o[0] === 'resize' && o[1] === rose), obs.length);
    check('layers: … plus the end of a transition / animation', lst.map((x) => x[0]).sort().join() === 'animationend,transitionend');
    const tr = lst[0][1];
    tr({ target: rose });
    check('layers: a transition ends and the button sits right (rose bottom + 8) → nothing', placed === 0);
    fabTop = 176; tr({ target: wrap });
    check('layers: a transition of something around the rose ends and the button is 32 px off → placed (the old 5 s check, now at once)', placed === 1);
    tr({ target: { contains: () => false } });
    check('layers: a transition elsewhere in the page (hover …) costs nothing', placed === 1);
    check('layers: place() calls it', /watchRose\(rose\);/.test(layers));
}

// ---- 5. hidden tab -----------------------------------------------------------
check('hidden tab: the measuring card\'s 1 s refresh rests', /S\.watch = setInterval\(function \(\) \{ if \(!document\.hidden\) \{ card\(\); \} \}, 1000\)/.test(meas));

// ---- i18n, help --------------------------------------------------------------
const win2 = {};
const ctx = vm.createContext({ window: win2 });
['en', 'cs'].forEach((l) => vm.runInContext(rd(JS, 'i18n', l + '.js'), ctx));
const D = win2.VT_I18N_DICT;
check('i18n: maprobot.stale_here_tip in en + cs, different', !!D.en['maprobot.stale_here_tip'] && !!D.cs['maprobot.stale_here_tip'] && D.en['maprobot.stale_here_tip'] !== D.cs['maprobot.stale_here_tip']);
const flat = (x) => x.replace(/\s+/g, ' ');
const hen = flat(rd(ROOT, 'docs', 'help', 'mapping.md')), hcs = flat(rd(ROOT, 'docs', 'help', 'cs', 'mapping.md'));
check('help en: the note with the robot in view, 45 s after the connection, none in the editor', /with the robot in view the same grey note/.test(hen) && /45 s after the connection came up/.test(hen) && /While the map editor is open there is no pill/.test(hen));
check('help cs: totéž', /když je robot vidět, stojí dole na mapě tatáž šedá poznámka/.test(hcs) && /45 s po navázání spojení/.test(hcs) && /Dokud je otevřený editor mapy, štítek není/.test(hcs));

console.log(fails ? '\n' + fails + ' of ' + count + ' FAILED' : '\nall ' + count + ' checks passed');
process.exit(fails ? 1 : 0);
