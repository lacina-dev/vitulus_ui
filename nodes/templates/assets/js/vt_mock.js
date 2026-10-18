/* vt_mock.js — "?mock" dry-run mode of the robot UI (U2, 2026-10).
 *
 * Open the page as  /?mock  (or ?mock=1) and NOTHING the page does can reach
 * the robot: the UI still connects to rosbridge and READS (subscribe /
 * unsubscribe go through, so the map, state and camera are live), but every
 * other rosbridge op (publish, advertise, call_service, send_action_goal, …)
 * is swallowed here and only shown in a small badge, and every non-GET HTTP
 * request (fetch / XHR / sendBeacon) is refused. Used to test the joystick,
 * buttons and layouts on the real robot without moving it.
 *
 * The filter sits on WebSocket.prototype.send — the one door every roslib
 * message (topics, services, actions, params) leaves through — so it does not
 * depend on how a panel builds its messages. Loaded right after roslib.js and
 * before any page script opens a connection.
 *
 * window.VTMock = { on, sent: [...last 200 blocked messages], last(topic) }
 */
(function () {
    'use strict';
    var on = false;
    try { on = new URLSearchParams(location.search).has('mock'); } catch (e) { on = false; }
    window.VTMock = { on: on, sent: [], last: function () { return null; } };
    if (!on) { return; }

    var ALLOW = { subscribe: 1, unsubscribe: 1 };
    /* read-only plumbing that only asks the robot to SEND data: the TF
       stream (tf2_web_republisher action goal) and the interactive-marker /
       rosapi lookups. Nothing here moves or changes the robot. */
    var READ_ONLY = /^\/(tf2_web_republisher\/|interactive_marker\/tunneled\/get_init$|rosapi\/)/;
    function readOnly(m) {
        var t = m.topic || m.service || '';
        return (m.op === 'advertise' || m.op === 'publish' || m.op === 'unadvertise' || m.op === 'call_service')
            && READ_ONLY.test(t);
    }
    var sent = window.VTMock.sent;
    var lastBy = {};
    var badge = null, badgeTxt = null, count = 0;

    function fmt(m) {
        var t = m.topic || m.service || m.action || m.name || '';
        var s = m.op + (t ? ' ' + t : '');
        var msg = m.msg;
        if (msg && msg.linear && msg.angular) {
            s += '  lin ' + (+msg.linear.x).toFixed(2) + '  ang ' + (+msg.angular.z).toFixed(2);
        } else if (msg && typeof msg === 'object' && 'data' in msg) {
            s += '  ' + JSON.stringify(msg.data).slice(0, 40);
        }
        return s;
    }
    function show(m) {
        count++;
        if (!badge && document.body) {
            badge = document.createElement('div');
            badge.className = 'vt-mock-badge';
            badge.setAttribute('role', 'status');
            badge.innerHTML = '<b>MOCK</b><span></span>';
            badgeTxt = badge.lastChild;
            document.body.appendChild(badge);
        }
        if (badgeTxt) { badgeTxt.textContent = count + ' blocked · ' + fmt(m); }
        if (badge) { var bb = badge.firstChild; if (bb) { bb.textContent = 'MOCK ' + count; } badge.title = count + ' blocked · ' + fmt(m); }
    }
    function record(m) {
        m = m || {};
        var t = m.topic || m.service || m.action || '';
        var rec = { t: Date.now(), op: m.op, topic: t, msg: m.msg || m.args || null };
        sent.push(rec);
        if (sent.length > 200) { sent.shift(); }
        if (t) { lastBy[t] = rec; }
        show(m);
        try { window.dispatchEvent(new CustomEvent('vt-mock', { detail: rec })); } catch (e) { /* old browser */ }
    }
    window.VTMock.last = function (topic) { return lastBy[topic] || null; };

    /* 1) rosbridge: every message leaves through WebSocket.send */
    var wsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
        var m = null;
        if (typeof data === 'string') {
            try { m = JSON.parse(data); } catch (e) { m = null; }
        }
        if (m && m.op && (ALLOW[m.op] || readOnly(m))) { return wsSend.call(this, data); }
        record(m || { op: 'binary' });          // anything else: swallowed
    };

    /* 2) HTTP: only GET/HEAD leave the page */
    function safeMethod(x) { x = String(x || 'GET').toUpperCase(); return x === 'GET' || x === 'HEAD'; }
    if (window.fetch) {
        var f = window.fetch;
        window.fetch = function (input, init) {
            var method = (init && init.method) || (input && input.method) || 'GET';
            if (!safeMethod(method)) {
                record({ op: 'http ' + String(method).toUpperCase(), topic: String((input && input.url) || input) });
                return Promise.reject(new Error('VTMock: ' + method + ' blocked'));
            }
            return f.apply(this, arguments);
        };
    }
    var xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__vtBlocked = !safeMethod(method);
        this.__vtWhat = String(method).toUpperCase() + ' ' + url;
        return xOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        if (this.__vtBlocked) { record({ op: 'http', topic: this.__vtWhat }); return; }
        return xSend.apply(this, arguments);
    };
    if (navigator.sendBeacon) {
        navigator.sendBeacon = function (url) { record({ op: 'http beacon', topic: String(url) }); return false; };
    }
    document.documentElement.classList.add('vt-mock');
})();
