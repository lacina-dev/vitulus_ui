#!/usr/bin/env node
/*
 * ?mock must never write to the robot (owner 2026-10-25, after an agent STOP
 * latch was investigated): the STOP (ROS publishes), the agent's HTTP API
 * (/agent/api/* — its STOP, chat commands, approvals), the dock door
 * (/agent-dock/*) and the field door (/field/act/*) only log + count.
 *
 *     node tools/test_mock_writes.node.js
 *
 * 1) vt_mock.js runs in a sandbox (no browser, nothing is pressed): every
 *    non-GET fetch / XHR / beacon and every rosbridge publish is swallowed and
 *    recorded; GET still goes out; VTMock.blocks() says so to callers.
 * 2) the second lock is in place where the important writes start:
 *    agent_chat.js api() and dockWrite(), vt_field_view.js send() ask
 *    VTMock.blocks() BEFORE their fetch; the big STOP (vt_frame.js stopNow)
 *    sends no HTTP at all (it presses #btn_stop_all = ROS publishes only).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const read = f => fs.readFileSync(path.join(JS, f), 'latin1');
let fails = 0;
function ok(cond, what) { if (cond) { console.log('ok   ' + what); } else { fails++; console.log('FAIL ' + what); } }

function sandbox(search) {
    const out = [];
    function WebSocket() {}
    WebSocket.prototype.send = function (d) { out.push(['ws', d]); };
    function XMLHttpRequest() {}
    XMLHttpRequest.prototype.open = function (m, u) { this.m = m; this.u = u; };
    XMLHttpRequest.prototype.send = function () { out.push(['xhr', this.m + ' ' + this.u]); };
    const win = {
        location: {search: search},
        fetch: (u, init) => { out.push(['fetch', ((init && init.method) || 'GET') + ' ' + u]); return Promise.resolve({ok: true}); },
        dispatchEvent: () => true,
        addEventListener: () => {}
    };
    const ctx = {
        window: win, location: win.location, WebSocket, XMLHttpRequest, URLSearchParams,
        navigator: {sendBeacon: (u) => { out.push(['beacon', u]); return true; }},
        document: {body: null, addEventListener: () => {}, documentElement: {classList: {add: () => {}}},
                   createElement: () => ({})},
        CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
        console: {info: () => {}, log: () => {}, error: () => {}},
        Date, JSON, String, Promise, Error, Object
    };
    win.WebSocket = WebSocket; win.XMLHttpRequest = XMLHttpRequest;
    vm.createContext(ctx);
    vm.runInContext(read('vt_mock.js'), ctx);
    return {ctx, win, out};
}

(async function () {
    // ---- 1) the sandbox, ?mock on
    const s = sandbox('?mock');
    const W = s.win;
    ok(W.VTMock.on === true, 'VTMock.on with ?mock');
    for (const u of ['/agent/api/stop', '/agent/api/task', '/agent-dock/release', '/field/act/approve', '/system/restart']) {
        let rejected = false;
        await W.fetch(u, {method: 'POST', body: '{}'}).catch(() => { rejected = true; });
        ok(rejected && !s.out.some(o => o[0] === 'fetch' && o[1].indexOf(u) >= 0), 'fetch POST ' + u + ' blocked, nothing sent');
    }
    await W.fetch('/api/system');
    ok(s.out.some(o => o[1] === 'GET /api/system'), 'fetch GET still goes out');
    const x = new s.ctx.XMLHttpRequest(); x.open('POST', '/agent/api/stop'); x.send('{}');
    ok(!s.out.some(o => o[0] === 'xhr'), 'XHR POST blocked');
    ok(s.ctx.navigator.sendBeacon('/field/act/x') === false && !s.out.some(o => o[0] === 'beacon'), 'sendBeacon blocked');
    const ws = new s.ctx.WebSocket();
    ws.send(JSON.stringify({op: 'publish', topic: '/base/motor_power', msg: {data: false}}));
    ws.send(JSON.stringify({op: 'subscribe', topic: '/odom'}));
    ok(!s.out.some(o => o[0] === 'ws' && o[1].indexOf('publish') >= 0), 'rosbridge publish (the STOP path) swallowed');
    ok(s.out.some(o => o[0] === 'ws' && o[1].indexOf('subscribe') >= 0), 'rosbridge subscribe still goes out');
    ok(W.VTMock.blocks('POST', '/agent/api/stop') === true && W.VTMock.blocks('GET', '/agent/api/state') === false,
       'VTMock.blocks(): POST yes, GET no');
    ok(W.VTMock.sent.some(r => /\/agent\/api\/stop/.test(r.topic)), 'blocked writes are recorded (badge / VTMock.sent)');

    // ---- without ?mock nothing is blocked
    const n = sandbox('');
    ok(n.win.VTMock.on === false && n.win.VTMock.blocks('POST', '/agent/api/stop') === false, 'no ?mock: blocks() = false');

    // ---- 2) the second lock sits before the writes
    function body(src, sig) {
        const i = src.indexOf(sig);
        if (i < 0) { return ''; }
        let d = 0;
        for (let j = src.indexOf('{', i); j < src.length; j++) {
            if (src[j] === '{') { d++; } else if (src[j] === '}') { d--; if (!d) { return src.slice(i, j + 1); } }
        }
        return '';
    }
    function guardFirst(src, sig, file) {
        const b = body(src, sig);
        const g = b.indexOf('VTMock.blocks('), f = b.indexOf('fetch(');
        ok(b && g >= 0 && f > g, file + ' ' + sig.trim() + ': VTMock.blocks() before fetch()');
    }
    const chat = read('agent_chat.js');
    guardFirst(chat, 'function api(path, opts)', 'agent_chat.js');
    guardFirst(chat, 'function dockWrite(path, body)', 'agent_chat.js');
    guardFirst(read('vt_field_view.js'), 'function send(action, payload, shown, box, msgEl, key)', 'vt_field_view.js');
    const stop = body(read('vt_frame.js'), 'function stopNow()');
    ok(stop && !/fetch\(|api\(|XMLHttpRequest|sendBeacon/.test(stop) && /btn_stop_all/.test(stop),
       'vt_frame.js stopNow(): presses #btn_stop_all, no HTTP');

    console.log(fails ? 'FAILED ' + fails : 'OK — ?mock sends no write');
    process.exit(fails ? 1 : 0);
})();
