/* vt_link.js — the rosbridge link guard: a STOP is never lost silently (T25, 2026-11-08).
 *
 * Why: roslib decides "connected" from its own flag (Ros.isConnected), set by the
 * socket's open / close events. A half-open link (Wi-Fi gone, rosbridge frozen) sends
 * no close event: the old heartbeat called socket.close(), the socket sat in CLOSING
 * for ~40 s (the browser waits for the closing handshake), isConnected stayed true and
 * every publish went into WebSocket.send() of a CLOSING socket — dropped without an
 * error. A STOP pressed then was lost; ros.connect() also did nothing until the old
 * socket was finally CLOSED, so the reconnect took ~23-245 s.
 *
 * What this does (one guard per ROSLIB.Ros: map_view.js ROS, imu_calibration.js ROS):
 *  - "up" = ros.socket.readyState === OPEN (and roslib saw the open), never the flag;
 *  - every outgoing op passes Ros.sendEncodedMessage (roslib's one door) — replaced:
 *      STOP (see isStop) while up: sent at once, then confirmed by a probe (a rosapi
 *        service call on the same socket; rosbridge handles one client's ops in order,
 *        so its answer means the STOP was handled). Not confirmed = still pending;
 *      STOP while not up: kept (one per topic, the newest) and sent once right after
 *        the next connection (after the re-advertise), then confirmed the same way.
 *        A STOP of the program / dock / motors / blade / navigation waits as long as
 *        the page is open (a late STOP only stops; a dropped one lets it run); only a
 *        zero cmd_vel (the stick let go) is dropped after ZERO_KEEP_MS;
 *      a drive command (non-zero cmd_vel): sent only while up AND something arrived
 *        within DRIVE_FRESH_MS (robot, full UI subscription set ~250 frames/s,
 *        2.6 MB/s over Wi-Fi: 99.9 % of gaps < 0.64 s, but stalls of 1.5-6 s happen
 *        a few times a minute — measured 2026-11-08); else
 *        dropped — never replayed later. While driving the guard probes so a quiet
 *        but healthy link stays "fresh";
 *      any other publish / call_service (an ACTION, see kind()) while up: at once only
 *        when a frame arrived within ACT_DIRECT_MS; else it waits for the robot's next
 *        frame (a probe asks for one) and goes out then; none within ACT_WAIT_MS: not
 *        sent, the page is told (onDrop with stale: true), a service call gets a failed
 *        answer (T8: an "open" socket of a lost network keeps what is written to it and
 *        the robot would run it when the network is back). A STOP drops what waits;
 *      a 'halt' (stop_autopath, scheduler inhibit): sent whenever the socket is open;
 *      any other publish / call_service while not up: queued, sent on the next
 *        connection only if it is at most CMD_KEEP_MS old (a "motors ON", Undock,
 *        Go or a map delete must not go out seconds later) — else dropped, a dropped
 *        service call gets a failed answer, the page is told (onDrop). Read-only
 *        plumbing (TF republisher, rosapi, interactive markers) and what the page sends
 *        in its first BOOT_MS (start-up) stay queued as in roslib. subscribe / advertise /
 *        unsubscribe / unadvertise are always queued;
 *  - liveness: silence (no frame) >= PROBE_AFTER_MS -> probe; a probe without an answer
 *    and without any frame for PROBE_DEAD_MS (a STOP's probe: STOP_DEAD_MS) -> the link
 *    is dead: the socket is dropped at once (handlers detached, roslib told "closed"
 *    -> 'close' event, isConnected false, ros.socket null so connect() opens a NEW
 *    socket now). A connect attempt that hangs is dropped the same way after 4 s, then
 *    4 s again, then 8 s, then 12 s (CONNECT_MS; back to 4 s after a connection).
 *    Half-open is found ~8 s after the last frame (2.5 s after an unconfirmed STOP) —
 *    longer than the Wi-Fi stalls above, so a stall does not cost a reconnect (which
 *    re-subscribes 2.6 MB/s of topics).
 *
 *   var g = VTLink.install(ros, { onStop(ev, info), onDead(reason), onDrop(info) })
 *   g.up() · g.fresh() · g.pending() · g.stats() · g.kill(reason)
 *   VTLink.isStop(msg) · VTLink.isDrive(msg) · VTLink.kind(msg)   (msg = a rosbridge op object)
 */
(function (root) {
    'use strict';

    var OPEN = 1, CONNECTING = 0;
    var TICK_MS = 250;
    var PROBE_AFTER_MS = 1500;   // silence before an active check
    var PROBE_DEAD_MS = 6500;    // a heartbeat probe: no answer, no frame -> dead (~8 s of silence)
    var STOP_DEAD_MS = 2500;     // a STOP's probe: no answer, no frame -> dead (a false drop only costs a
                                 // reconnect and a second copy of the STOP; waiting longer delays the STOP)
    var STOP_STUCK_MS = 10000;   // a STOP's probe unanswered although frames arrive -> reconnect
    // a hanging connect attempt is dropped after this; longer only after two failures in a row
    var CONNECT_MS = [4000, 4000, 8000, 12000];
    var BOOT_MS = 3000;          // what the page sends in its first 3 s waits for the first connection
    var ZERO_KEEP_MS = 10000;    // a zero cmd_vel waiting for the link longer than this is dropped
    var CMD_KEEP_MS = 2000;      // another command waiting for the link longer than this is dropped
    var DRIVE_FRESH_MS = 2000;   // drive only when a frame arrived this recently
    var DRIVE_PROBE_MS = 1000;   // while driving: probe after this much silence
    var ACT_DIRECT_MS = 300;     // an action goes out at once only when a frame arrived this recently
    var ACT_WAIT_MS = 2000;      // else it waits this long for the robot's next frame (a probe asks for one)

    var CANCEL = /^\/(move_base_flex\/[a-z_]+|move_base|smach_goal)\/cancel$/;
    var STOP_BOOL = {
        '/mower_smach/stop': true,       // stop the mowing program
        '/dock_smach/stop': true,        // stop docking / undocking
        '/mower/set_motor_on': false,    // blade off
        '/base/motor_power': false,      // traction motors off
        '/pm/set_motor_switch': false    // power-module motor switch open
    };
    // Only stop or forbid something, a late one does no harm: sent whenever the socket is open,
    // never held back by a silent link. Unlike the STOPs above they are not kept and repeated.
    //   /navi_manager/stop_autopath  navi_man forgets the path being recorded (any value)
    //   /scheduler/inhibit true      master_controller: no scheduled run until allowed again
    // NOT here, on purpose (they stay actions): /mapping_manager/stop (ends the session, SAVES a
    // raster and switches the served map; payload "discard" throws the session away),
    // /scheduler/sleep_cancel (keeps the robot awake: a late one cancels a later sleep),
    // service /stop_motor (stops the lidar: the robot is blind to obstacles after it).
    var HALT_ANY = { '/navi_manager/stop_autopath': 1 };
    var HALT_BOOL = { '/scheduler/inhibit': true };
    var CMD_VEL = /(^|\/)cmd_vel$/;
    // read-only plumbing: asks the robot to SEND data, never changes it
    var PLUMBING = /^\/(republish_tfs$|tf2_web_republisher\/|rosapi\/|interactive_marker\/)/;
    var ALWAYS_Q = { subscribe: 1, unsubscribe: 1, advertise: 1, unadvertise: 1 };
    // publishes that only ask a node to send its data again (the page sends them by itself)
    var QUERY = /^\/(web_plan\/(reload|republish)|dock_manager\/send_programs|navi_manager\/publish_(path|point))$/;

    function zeroTwist(m) {
        var l = m && m.linear, a = m && m.angular;
        if (!l || !a) { return false; }
        return !(+l.x || +l.y || +l.z || +a.x || +a.y || +a.z);
    }
    // m = a rosbridge op ({op: 'publish', topic, msg})
    function isStop(m) {
        if (!m || m.op !== 'publish' || typeof m.topic !== 'string') { return false; }
        if (CANCEL.test(m.topic)) { return true; }
        if (Object.prototype.hasOwnProperty.call(STOP_BOOL, m.topic)) {
            return !!(m.msg && m.msg.data === STOP_BOOL[m.topic]);
        }
        return CMD_VEL.test(m.topic) && zeroTwist(m.msg);
    }
    function isHalt(m) {
        if (!m || m.op !== 'publish' || typeof m.topic !== 'string') { return false; }
        if (Object.prototype.hasOwnProperty.call(HALT_ANY, m.topic)) { return true; }
        return Object.prototype.hasOwnProperty.call(HALT_BOOL, m.topic) && !!(m.msg && m.msg.data === HALT_BOOL[m.topic]);
    }
    function isDrive(m) {
        return !!(m && m.op === 'publish' && typeof m.topic === 'string' && CMD_VEL.test(m.topic) &&
                  m.msg && m.msg.linear && !zeroTwist(m.msg));
    }
    function isZero(topic) { return CMD_VEL.test(topic); }
    // a command that must not go out late (publish / call_service, not plumbing)
    function isCommand(m) {
        if (!m) { return false; }
        if (m.op === 'publish') { return !PLUMBING.test(m.topic || ''); }
        if (m.op === 'call_service') { return !PLUMBING.test(m.service || ''); }
        return false;
    }

    // What a rosbridge op is for the link guard (T8, 2026-11-16):
    //   'stop'     only stops or switches off (isStop): always sent, kept, confirmed;
    //   'halt'     only stops or forbids, not urgent (isHalt): sent whenever the socket is open;
    //   'drive'    a non-zero cmd_vel: only on a fresh link, never later;
    //   'plumbing' / 'query'  asks the robot to SEND data: never changes it;
    //   'action'   EVERYTHING else that is published or called — motors ON, blade, Undock /
    //              Dock, Go, a program, a setting, a save: only on a fresh link, never later.
    //   'other'    subscribe / advertise / …
    // A topic or service nobody listed is an action: a new command is safe by default.
    // tools/test_vt_link.node.js holds the list of what the page sends and fails on a new name.
    function kind(m) {
        if (!m) { return 'other'; }
        if (m.op === 'publish') {
            if (isStop(m)) { return 'stop'; }
            if (isHalt(m)) { return 'halt'; }
            if (isDrive(m)) { return 'drive'; }
            if (PLUMBING.test(m.topic || '')) { return 'plumbing'; }
            return QUERY.test(m.topic || '') ? 'query' : 'action';
        }
        if (m.op === 'call_service') { return PLUMBING.test(m.service || '') ? 'plumbing' : 'action'; }
        return 'other';
    }

    function install(ros, o) {
        o = o || {};
        if (ros.__vtLink) { return ros.__vtLink; }
        var now = o.now || function () { return Date.now(); };
        var later = o.later || function (fn, ms) { return setTimeout(fn, ms); };
        var every = o.every || function (fn, ms) { return setInterval(fn, ms); };
        var g = {};
        var pending = [];            // STOPs: {topic, enc, seq, sock, t}
        var queue = [];              // the rest while down: {enc, m, t, cmd}
        var held = [];               // actions waiting for the robot's next frame: {enc, m, t}
        var heldTimer = false;
        var seq = 0, probeN = 0;
        var probe = null;            // {id, t, seq, sock, stop, fn}
        var probeSoon = false;
        var lastRx = now(), connStart = now(), rxSock = null;
        var everUp = false, connIdx = 0, lastDrive = -1e9, connSock = null, t0 = now();
        var st = { sent: 0, queued: 0, resent: 0, acked: 0, dropped_drive: 0, stale_drive: 0,
                   stale_cmd: 0, held_cmd: 0, expired: 0, dropped_cmd: 0, kills: 0, probes: 0, last_kill: '' };

        function emitStop(ev, info) { try { if (o.onStop) { o.onStop(ev, info || {}); } } catch (e) { /* UI only */ } }
        function emitDrop(info) { try { if (o.onDrop) { o.onDrop(info); } } catch (e) { /* UI only */ } }
        function sock() { return ros.socket; }
        function up() {
            var s = sock();
            return !!(s && s.readyState === OPEN && ros.isConnected);
        }
        function fresh() { return up() && now() - lastRx <= DRIVE_FRESH_MS; }
        function rawSend(enc) { sock().send(enc); }
        function onRx() { lastRx = now(); if (held.length) { releaseHeld(); } }
        // T8: the actions that waited for a sign of life. A frame came: the robot hears us now,
        // they go out in the order they were pressed (one older than ACT_WAIT_MS is refused).
        function releaseHeld() {
            var h = held, t = now();
            held = [];
            h.forEach(function (q) {
                if (up() && t - q.t <= ACT_WAIT_MS) { rawSend(q.enc); } else { refuse(q.m); }
            });
        }
        function refuse(m) {
            st.stale_cmd++;
            failCall(m);
            emitDrop({ n: 1, what: [m.topic || m.service || m.op], stale: true });
        }
        function refuseHeld() {
            var h = held;
            held = [];
            h.forEach(function (q) { refuse(q.m); });
        }
        function hold(enc, m) {
            st.held_cmd++;
            held.push({ enc: enc, m: m, t: now() });
            sendProbe(false);
            if (heldTimer) { return; }
            heldTimer = true;
            (function wait() {
                later(function () {
                    var t = now();
                    var old = held.filter(function (q) { return t - q.t >= ACT_WAIT_MS; });
                    held = held.filter(function (q) { return t - q.t < ACT_WAIT_MS; });
                    old.forEach(function (q) { refuse(q.m); });
                    if (held.length) { wait(); } else { heldTimer = false; }
                }, held.length ? Math.max(1, ACT_WAIT_MS - (now() - held[0].t)) : ACT_WAIT_MS);
            }());
        }
        function watch() {
            var s = sock();
            if (!s || s === rxSock || !s.addEventListener) { return; }
            if (rxSock && rxSock.removeEventListener) { rxSock.removeEventListener('message', onRx); }
            rxSock = s;
            s.addEventListener('message', onRx);
        }

        // drop the socket now: the dying one can no longer reach the client, roslib
        // hears "closed" (isConnected false, 'close' -> resubscribe queue, reconnect)
        function kill(reason) {
            var s = sock();
            if (!s) { return; }
            st.kills++; st.last_kill = reason;
            var oc = s.onclose;
            s.onopen = null; s.onclose = null; s.onerror = null; s.onmessage = null;
            if (s.removeEventListener) { s.removeEventListener('message', onRx); }
            if (rxSock === s) { rxSock = null; }
            try { s.close(); } catch (e) { /* already closing */ }
            ros.socket = null;
            dropProbe();
            refuseHeld();
            try { if (o.onDead) { o.onDead(reason); } } catch (e) { /* UI only */ }
            if (typeof oc === 'function') {
                try { oc.call(s, { type: 'close', code: 4000, reason: 'vt_link: ' + reason, wasClean: false }); } catch (e) { /* listeners */ }
            } else if (ros.isConnected) {
                ros.isConnected = false;
                ros.emit('close', { type: 'close', code: 4000, reason: 'vt_link: ' + reason });
            }
        }

        function dropProbe() {
            if (probe && probe.fn) { try { ros.off(probe.id, probe.fn); } catch (e) { /* gone */ } }
            probe = null;
        }
        function sendProbe(forStop) {
            if (!up()) { return; }
            // one in flight; its answer asks again for STOPs sent after it
            if (probe) { if (forStop) { probe.stop = true; } return; }
            var id = 'vt_link:' + (++probeN);
            var p = { id: id, t: now(), seq: seq, sock: sock(), stop: !!forStop };
            p.fn = function () {
                if (probe !== p) { return; }
                lastRx = now();
                probe = null;
                if (held.length) { releaseHeld(); }
                var n0 = pending.length;
                pending = pending.filter(function (q) { return !(q.sock === p.sock && q.seq <= p.seq); });
                if (pending.length < n0) {
                    st.acked += n0 - pending.length;
                    emitStop('acked', { n: n0 - pending.length, left: pending.length });
                }
                if (pending.some(function (q) { return q.sock === sock(); })) { sendProbe(true); }
            };
            probe = p;
            st.probes++;
            ros.once(id, p.fn);
            rawSend(JSON.stringify({ op: 'call_service', id: id, service: '/rosapi/get_param',
                                     args: { name: '/use_sim_time', 'default': 'false' } }));
        }

        // only a zero cmd_vel goes stale; the other STOPs wait while the page is open
        function expire() {
            var t = now(), n0 = pending.length, s = sock();
            pending = pending.filter(function (q) {
                return (q.sock && q.sock === s) || !isZero(q.topic) || t - q.t < ZERO_KEEP_MS;
            });
            if (pending.length < n0) {
                st.expired += n0 - pending.length;
                emitStop('expired', { n: n0 - pending.length, left: pending.length });
            }
        }

        // a service call that was not sent gets a failed answer (its caller must not wait)
        function failCall(m) {
            if (!(m && m.op === 'call_service' && m.id)) { return; }
            var id = m.id;
            later(function () {
                try { ros.emit(id, { op: 'service_response', id: id, result: false, values: 'vt_link: no connection to the robot, not sent' }); } catch (e) { /* caller gone */ }
            }, 0);
        }

        // the commands queued while down that are too old now: dropped, told
        function expireQueue() {
            if (!queue.length) { return; }
            var t = now(), gone = [];
            queue = queue.filter(function (q) {
                if (q.cmd && t - q.t > CMD_KEEP_MS) { gone.push(q); return false; }
                return true;
            });
            if (!gone.length) { return; }
            st.dropped_cmd += gone.length;
            gone.forEach(function (q) { failCall(q.m); });
            emitDrop({ n: gone.length, what: gone.map(function (q) { return q.m ? (q.m.topic || q.m.service || q.m.op) : '?'; }) });
        }

        function stop(topic, enc) {
            // an action still waiting for the robot (motors ON pressed a moment ago) must not
            // come out after this STOP
            if (held.length) { refuseHeld(); }
            seq++;
            pending = pending.filter(function (q) { return q.topic !== topic; });
            var q = { topic: topic, enc: enc, seq: seq, sock: null, t: now() };
            pending.push(q);
            if (up()) {
                q.sock = sock();
                rawSend(enc);
                st.sent++;
                // one probe for a burst (the big STOP publishes 6 topics in one go)
                if (!probeSoon) {
                    probeSoon = true;
                    later(function () { probeSoon = false; sendProbe(true); }, 0);
                }
                return;
            }
            st.queued++;
            emitStop('queued', { topic: topic, n: pending.length });
        }

        // after a (re)connect, once the connection's own handlers (re-advertise) ran:
        // what was queued (still young enough), then every unconfirmed STOP once more
        function flush() {
            if (!up()) { return; }
            expireQueue();
            var q0 = queue;
            queue = [];
            q0.forEach(function (q) { rawSend(q.enc); });
            expire();
            var s = sock(), n = 0;
            pending.forEach(function (q) {
                if (q.sock === s) { return; }
                q.seq = ++seq;
                q.sock = s;
                rawSend(q.enc);
                n++;
            });
            if (n) {
                st.resent += n;
                emitStop('resent', { n: n });
                sendProbe(true);
            }
        }

        function parse(enc) {
            if (typeof enc !== 'string') { return null; }
            if (enc.lastIndexOf('{"op":"publish"', 0) !== 0 && enc.lastIndexOf('{"op":"call_service"', 0) !== 0) {
                // other ops: only the op name matters
                var mm = /^\{"op":"([a-z_]+)"/.exec(enc);
                return mm ? { op: mm[1] } : null;
            }
            try { return JSON.parse(enc); } catch (e) { return null; }
        }

        ros.sendEncodedMessage = function (enc) {
            var m = parse(enc);
            var s = sock();
            // a socket on its way out that roslib still calls connected: drop it now
            if (s && ros.isConnected && s.readyState !== OPEN && s.readyState !== CONNECTING) { kill('socket closing'); }
            if (m && isStop(m)) { stop(m.topic, enc); return; }
            if (m && isDrive(m)) {
                if (!up()) { st.dropped_drive++; return; }
                lastDrive = now();
                if (now() - lastRx > DRIVE_FRESH_MS) {
                    // nothing heard for a while: do not drive blind, ask the link
                    st.stale_drive++;
                    sendProbe(false);
                    return;
                }
                rawSend(enc);
                return;
            }
            if (up()) {
                // T8: the socket says "open" for seconds after the network is gone (the guard
                // itself needs ~8 s to call it dead). What is written to it then stays in TCP
                // and the robot would carry it out when the network comes back: motors ON, an
                // Undock, a Go, a program start seconds or minutes late. So an action goes out
                // only while the robot's data is arriving (as a drive command does); else it
                // is refused NOW, told (onDrop, stale: true) and never sent later. The probe
                // makes a quiet but healthy link fresh for the next press.
                // Even 2 s was a gap (a press 1 s into an outage went out and came 5 s late):
                // an action goes out at once only when a frame arrived within ACT_DIRECT_MS
                // (the page's subscriptions bring ~250 frames/s, so normally at once); else
                // it waits for the robot's next frame — a probe asks for one — and goes out
                // then, one round trip late; no frame within ACT_WAIT_MS = refused, told.
                // While something waits, later actions wait behind it (their order holds).
                if (m && kind(m) === 'action' && (held.length || now() - lastRx > ACT_DIRECT_MS)) {
                    hold(enc, m);
                    return;
                }
                rawSend(enc);
                return;
            }
            st.queued++;
            // the page's own start-up (first BOOT_MS) waits for the first connection as in
            // roslib; anything later — a button pressed while the first connection does not
            // come — is a command like any other (R1: motors ON 17 s before the first
            // connection must not go out then)
            var boot = !everUp && now() - t0 < BOOT_MS;
            queue.push({ enc: enc, m: m, t: now(), cmd: !!(!boot && m && !ALWAYS_Q[m.op] && isCommand(m)) });
        };

        ros.on('connection', function () {
            lastRx = now();
            everUp = true;
            connIdx = 0;
            dropProbe();
            watch();
            later(flush, 0);
        });
        ros.on('close', function () { dropProbe(); refuseHeld(); connStart = now(); });

        every(function () {
            var t = now(), s = sock();
            if (pending.length) { expire(); }
            if (queue.length && !up()) { expireQueue(); }
            if (!s) { connStart = t; return; }
            if (s !== connSock) { connSock = s; connStart = t; }     // a new attempt: its own clock
            if (s.readyState === CONNECTING || (s.readyState === OPEN && !ros.isConnected)) {
                if (t - connStart >= CONNECT_MS[connIdx]) {
                    connIdx = Math.min(connIdx + 1, CONNECT_MS.length - 1);
                    kill('connect timeout');
                }
                return;
            }
            connStart = t;
            if (s.readyState !== OPEN) {
                if (ros.isConnected) { kill('socket closing'); }
                return;
            }
            watch();
            var silence = t - lastRx;
            if (!probe) {
                var driving = t - lastDrive < 2 * DRIVE_PROBE_MS;
                if (silence >= PROBE_AFTER_MS || (driving && silence >= DRIVE_PROBE_MS)) { sendProbe(false); }
                return;
            }
            var age = t - probe.t, dead = probe.stop ? STOP_DEAD_MS : PROBE_DEAD_MS;
            if (age >= dead && lastRx <= probe.t) { kill(probe.stop ? 'stop not confirmed' : 'heartbeat'); return; }
            if (probe.stop && age >= STOP_STUCK_MS) { kill('stop stuck'); return; }
            if (!probe.stop && age >= PROBE_DEAD_MS) {
                // frames arrive but the probe got no answer: ask again
                dropProbe();
            }
        }, TICK_MS);

        g.up = up;
        g.fresh = fresh;
        g.kill = kill;
        g.pending = function () { return pending.map(function (q) { return { topic: q.topic, sent: !!q.sock, age_ms: now() - q.t }; }); };
        // the STOPs a person waits for (a zero cmd_vel is not one of them)
        g.waiting = function () { return pending.filter(function (q) { return !isZero(q.topic); }).length; };
        g.stats = function () {
            var r = {};
            Object.keys(st).forEach(function (k) { r[k] = st[k]; });
            r.pending = pending.length;
            r.queue = queue.length;
            r.held = held.length;
            r.probe = probe ? { age_ms: now() - probe.t, stop: probe.stop } : null;
            r.silence_ms = now() - lastRx;
            r.connect_ms = CONNECT_MS[connIdx];
            return r;
        };
        ros.__vtLink = g;
        return g;
    }

    root.VTLink = {
        install: install, isStop: isStop, isHalt: isHalt, isDrive: isDrive, isCommand: isCommand, kind: kind,
        T: { TICK_MS: TICK_MS, PROBE_AFTER_MS: PROBE_AFTER_MS, PROBE_DEAD_MS: PROBE_DEAD_MS,
             STOP_DEAD_MS: STOP_DEAD_MS, STOP_STUCK_MS: STOP_STUCK_MS, CONNECT_MS: CONNECT_MS,
             ZERO_KEEP_MS: ZERO_KEEP_MS, CMD_KEEP_MS: CMD_KEEP_MS, DRIVE_FRESH_MS: DRIVE_FRESH_MS,
             ACT_DIRECT_MS: ACT_DIRECT_MS, ACT_WAIT_MS: ACT_WAIT_MS }
    };
}(typeof window !== 'undefined' ? window : globalThis));
