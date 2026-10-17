/* vt_joy.js — the on-screen joystick + keyboard drive of the robot UI (U2, 2026-10).
 *
 * One component for touch, mouse and keyboard; ROS-agnostic: it only calls
 * opts.onCommand(lin, ang) — map_view.js turns that into /cmd_vel.
 *
 *   ┌──────────────── #joy_view ────────────────┐
 *   │  [MID] [MOTORS ON]          lin 0.32 m/s  │   status line (fixed slots)
 *   │              ( ring · knob )              │   ang -0.40 rad/s
 *   └───────────────────────────────────────────┘
 *
 * Feel:
 *  - fixed base, the knob follows the finger; radial dead zone (12 %), then an
 *    exponential curve (fine control near the centre, full speed at the rim);
 *  - a small axial snap: pushing (almost) straight does not drift sideways;
 *  - rate-limited output (acceleration cap) so a flick does not jerk the robot;
 *  - haptics (navigator.vibrate, where the browser has it): a tick when the
 *    stick leaves the dead zone, at the rim, and on release.
 * Safety:
 *  - multitouch-safe: ONE pointer owns the stick (pointer capture); other
 *    fingers on the page are ignored, a cancelled / lost pointer stops;
 *  - release, pointercancel, lost capture, window blur, hidden tab and a
 *    closed rosbridge (release()) all stop: zeros are sent 3× and then the
 *    stick goes silent — it never publishes while idle, not even on load;
 *  - keyboard (W A S D / arrows, Shift = half) only while the "keyboard" switch
 *    is on and the focus is not in a text field; key-up / blur = stop.
 *
 * opts: { onCommand(lin, ang), turnOnly, speedLin, speedAng, label }
 * window.VTJoy.create(el, opts) → { setSpeed(lin, ang, label), setMotors(on|null),
 *   setKeyboard(on), release(), state() }
 */
(function () {
    'use strict';

    var DEAD = 0.12;          // radial dead zone (fraction of the radius)
    var EXPO = 0.55;          // 0 = linear, 1 = cubic
    var SNAP = 0.10;          // axial snap (fraction of the deflection)
    var RATE_MS = 50;         // command period while active (20 Hz)
    var ACC_LIN = 1.6;        // m/s² — max change of the linear command
    var ACC_ANG = 6.0;        // rad/s² — max change of the angular command
    var STOP_REPEAT = 3;      // zeros sent after a release

    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function curve(r) {       // 0..1 -> 0..1 after the dead zone
        if (r <= DEAD) { return 0; }
        var t = (r - DEAD) / (1 - DEAD);
        return (1 - EXPO) * t + EXPO * t * t * t;
    }
    function buzz(ms) {
        try { if (navigator.vibrate) { navigator.vibrate(ms); } } catch (e) { /* not allowed */ }
    }
    function isTyping(t) {
        if (!t) { return false; }
        var tag = (t.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
    }
    function el(tag, cls, parent) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (parent) { parent.appendChild(e); }
        return e;
    }

    function create(root, opts) {
        opts = opts || {};
        var onCommand = opts.onCommand || function () {};
        var speedLin = 0.4, speedAng = 1.3, speedLabel = 'MID';
        var motors = null;                  // true / false / null = unknown
        var keyboardOn = false;
        var turnOnly = !!opts.turnOnly;     // IMU calibration: rotate on the spot only
        if (opts.speedLin !== undefined) { speedLin = opts.speedLin; }
        if (opts.speedAng !== undefined) { speedAng = opts.speedAng; }
        if (opts.label) { speedLabel = opts.label; }

        /* ---- DOM (built once; every slot exists from the start) */
        root.classList.add('vt-joy');
        root.classList.toggle('vt-joy-turn', turnOnly);
        root.setAttribute('data-state', 'off');
        root.innerHTML = '';
        var head = el('div', 'vt-joy-head', root);
        var chipSpeed = el('span', 'vt-joy-chip vt-joy-speed', head);
        var chipMotors = el('span', 'vt-joy-chip vt-joy-motors', head);
        var pad = el('div', 'vt-joy-pad', root);
        pad.setAttribute('role', 'slider');
        pad.setAttribute('aria-label', 'Drive joystick');
        pad.setAttribute('aria-valuetext', 'stopped');
        el('div', 'vt-joy-dead', pad);
        var vec = el('div', 'vt-joy-vec', pad);
        var knob = el('div', 'vt-joy-knob', pad);
        var read = el('div', 'vt-joy-read', root);
        var readLin = el('span', 'vt-joy-num', read);
        var readAng = el('span', 'vt-joy-num', read);
        var kbHint = el('span', 'vt-joy-kb', read);
        kbHint.textContent = 'keyboard  W A S D · Shift = half';

        /* ---- state */
        var pid = null;                     // the pointer that owns the stick
        var cx = 0, cy = 0, R = 1;          // pad centre + usable radius (px)
        var nx = 0, ny = 0;                 // normalised stick (-1..1), y up
        var tLin = 0, tAng = 0;             // target command
        var oLin = 0, oAng = 0;             // output after the rate limit
        var timer = null, stopLeft = 0, lastT = 0;
        var wasOut = false, wasRim = false, rimAt = 0;
        var keys = {};

        function paintStatus() {
            chipSpeed.textContent = speedLabel;
            chipMotors.textContent = motors === true ? 'MOTORS ON' : (motors === false ? 'MOTORS OFF' : 'MOTORS ?');
            chipMotors.setAttribute('data-state', motors === true ? 'ok' : (motors === false ? 'warn' : 'off'));
            root.classList.toggle('vt-joy-nomotors', motors === false);
            kbHint.hidden = !keyboardOn;
        }
        function paintRead() {
            readLin.textContent = (oLin >= 0 ? '+' : '−') + Math.abs(oLin).toFixed(2) + ' m/s';
            readAng.textContent = (oAng >= 0 ? '+' : '−') + Math.abs(oAng).toFixed(2) + ' rad/s';
        }
        function paintStick() {
            var r = Math.min(1, Math.hypot(nx, ny));
            var kx = nx * R, ky = -ny * R;
            knob.style.transform = 'translate(' + kx.toFixed(1) + 'px,' + ky.toFixed(1) + 'px)';
            var ang = Math.atan2(nx, ny) * 180 / Math.PI;        // 0 = up, clockwise
            vec.style.transform = 'rotate(' + ang.toFixed(1) + 'deg) scaleY(' + r.toFixed(3) + ')';
            pad.style.setProperty('--vt-joy-mag', r.toFixed(3));
            var active = pid !== null || keyActive();
            root.setAttribute('data-state', active ? (motors === false ? 'warn' : 'info') : 'off');
            root.classList.toggle('vt-joy-live', active && r > DEAD);
            pad.setAttribute('aria-valuetext', active ? ('lin ' + oLin.toFixed(2) + ', ang ' + oAng.toFixed(2)) : 'stopped');
        }

        /* stick -> target command */
        function computeTarget() {
            var r = Math.min(1, Math.hypot(nx, ny));
            var m = curve(r);
            var ux = r > 0 ? nx / r : 0, uy = r > 0 ? ny / r : 0;
            var ax = ux * m, ay = uy * m;
            if (Math.abs(ax) < SNAP * m) { ax = 0; ay = Math.sign(uy) * m; }   // straight ahead / back
            if (Math.abs(ay) < SNAP * m) { ay = 0; ax = Math.sign(ux) * m; }   // turn on the spot
            tLin = ay * speedLin;
            tAng = -ax * speedAng;                                             // right = clockwise = −z
            var out = r > DEAD;
            if (out && !wasOut) { buzz(8); }
            var rim = r > 0.97;
            var now = Date.now();
            if (rim && !wasRim && now - rimAt > 400) { buzz(14); rimAt = now; }
            wasOut = out; wasRim = rim;
        }

        function step() {
            var now = Date.now();
            var dt = lastT ? Math.min(0.2, (now - lastT) / 1000) : RATE_MS / 1000;
            lastT = now;
            var active = pid !== null || keyActive();
            if (!active) { tLin = 0; tAng = 0; }
            var stopNow = !active;
            if (stopNow) {               // a release stops at once, no ramp-down
                oLin = 0; oAng = 0;
            } else {
                /* slowing down is allowed 3× faster than speeding up */
                var aL = ACC_LIN * dt * (Math.abs(tLin) < Math.abs(oLin) ? 3 : 1);
                var aA = ACC_ANG * dt * (Math.abs(tAng) < Math.abs(oAng) ? 3 : 1);
                oLin += clamp(tLin - oLin, -aL, aL);
                oAng += clamp(tAng - oAng, -aA, aA);
                if (Math.abs(oLin) < 1e-3) { oLin = 0; }
                if (Math.abs(oAng) < 1e-3) { oAng = 0; }
            }
            onCommand(oLin, oAng);
            paintRead();
            if (stopNow) {
                stopLeft -= 1;
                if (stopLeft <= 0) { clearInterval(timer); timer = null; lastT = 0; }
            }
        }
        function run() {
            stopLeft = STOP_REPEAT;
            if (!timer) { lastT = 0; step(); timer = setInterval(step, RATE_MS); }
        }
        function stop() {
            pid = null; nx = 0; ny = 0; keys = {};
            wasOut = false; wasRim = false;
            tLin = 0; tAng = 0;
            paintStick();
            if (timer) { stopLeft = STOP_REPEAT; } // the loop sends the zeros, then goes silent
        }

        /* ---- pointer (touch, pen, mouse) */
        function measure() {
            var b = pad.getBoundingClientRect();
            cx = b.left + b.width / 2; cy = b.top + b.height / 2;
            R = Math.max(10, b.width / 2 - knob.offsetWidth / 2);
        }
        function track(e) {
            var dx = (e.clientX - cx) / R, dy = (cy - e.clientY) / R;
            var r = Math.hypot(dx, dy);
            if (r > 1) { dx /= r; dy /= r; }
            if (turnOnly) { dy = 0; }
            nx = dx; ny = dy;
            computeTarget();
            paintStick();
        }
        pad.addEventListener('pointerdown', function (e) {
            if (pid !== null) { return; }                 // a second finger: ignored
            if (e.pointerType === 'mouse' && e.button !== 0) { return; }
            e.preventDefault();
            pid = e.pointerId;
            try { pad.setPointerCapture(pid); } catch (err) { /* old browser */ }
            measure();
            track(e);
            run();
        });
        pad.addEventListener('pointermove', function (e) {
            if (e.pointerId !== pid) { return; }
            e.preventDefault();
            track(e);
        });
        function end(e) {
            if (e.pointerId !== pid) { return; }
            if (wasOut) { buzz(5); }
            stop();
        }
        pad.addEventListener('pointerup', end);
        pad.addEventListener('pointercancel', end);
        pad.addEventListener('lostpointercapture', end);
        pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        /* ---- keyboard: the same command path */
        var KEYMAP = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
        function keyActive() { return keyboardOn && (keys.f || keys.b || keys.l || keys.r); }
        function fromKeys(shift) {
            var k = shift ? 0.5 : 1;
            ny = ((keys.f ? 1 : 0) - (keys.b ? 1 : 0)) * k;
            nx = ((keys.r ? 1 : 0) - (keys.l ? 1 : 0)) * k;
            /* keys are digital: full deflection = full speed, skip the curve */
            tLin = ny * speedLin;
            tAng = -nx * speedAng;
            paintStick();
        }
        window.addEventListener('keydown', function (e) {
            var k = KEYMAP[e.code];
            if (!k || !keyboardOn || pid !== null || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) { return; }
            e.preventDefault();
            if (!keys[k]) { keys[k] = true; fromKeys(e.shiftKey); run(); }
        });
        window.addEventListener('keyup', function (e) {
            var k = KEYMAP[e.code];
            if (!k || !keys[k]) { return; }
            keys[k] = false;
            if (keyActive()) { fromKeys(e.shiftKey); } else { stop(); }
        });

        /* ---- anything that takes the hand away stops the robot */
        window.addEventListener('blur', function () { if (pid !== null || keyActive()) { stop(); } });
        document.addEventListener('visibilitychange', function () { if (document.hidden) { stop(); } });

        paintStatus(); paintRead(); paintStick();

        return {
            setSpeed: function (lin, ang, label) {
                if (lin > 0) { speedLin = lin; }
                if (ang > 0) { speedAng = ang; }
                if (label) { speedLabel = label; }
                paintStatus();
            },
            setMotors: function (on) { motors = (on === true || on === false) ? on : null; paintStatus(); paintStick(); },
            setKeyboard: function (on) { keyboardOn = !!on; if (!on) { keys = {}; stop(); } paintStatus(); },
            release: stop,
            state: function () { return { active: pid !== null || !!keyActive(), lin: oLin, ang: oAng, nx: nx, ny: ny, sending: !!timer }; }
        };
    }

    window.VTJoy = { create: create, _curve: curve };
})();
