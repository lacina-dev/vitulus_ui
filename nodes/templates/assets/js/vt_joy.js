/* vt_joy.js — the on-screen joystick + keyboard drive of the robot UI.
 *
 * One component for touch, mouse and keyboard; ROS-agnostic: it only calls
 * opts.onCommand(lin, ang) — map_view.js turns that into /teleop/cmd_vel (the
 * human input of cmd_vel_mux), imu_calibration.js into a rotate-only command.
 *
 * Two shapes:
 *  - plain (IMU calibration, #joy_view_imu): status line + pad + readout;
 *  - DECK (owner 2026-10-18, the map's #joy_view, opts.deck): one band as
 *    wide as the top bar, standing on the bottom bar (vt_frame.js / vt_panel.css):
 *
 *   ┌ state · lin/ang · hint ┬ keyboard ┬ motors ┬ speed ┬ STOP ┬ (pad) ┐
 *   │ FREE  +0.32 −0.40      │ ⌨ [W]    │ ON|OFF │ S M F │  ■   │  ( ) │
 *   └────────────────────────┴ [A][S][D]┴────────┴───────┴──────┴──────┘
 *
 *   the speed and motor controls are FUNCTIONAL (opts.onSpeed / onMotors)
 *   and only ever show what the ROBOT reports (setSpeedKey / setMotors);
 *   a click shows "pending" until the robot echoes it (4 s, then it falls
 *   back to the reported state). Motors are never switched on by the page.
 *
 * Feel (numbers in the constants below):
 *  - radial dead zone 10 %, then an expo curve (60 % cubic): fine control
 *    near the centre, full speed (of the active Slow / Mid / Fast cap) at the rim;
 *  - axis lock: within ±9° of an axis the command is pure straight or pure
 *    rotate-on-the-spot (the locked axis lights up);
 *  - acceleration cap (1.6 m/s², 6 rad/s²; slowing down 3× faster);
 *  - release = a short decay, not a hard jump: the first command after the
 *    release is 35 % of the last one, the next one (≤ 50 ms later) is ZERO,
 *    then two more zeros and silence; the knob springs back (CSS);
 *  - the rim ring is the active speed cap, coloured by state: green = free,
 *    amber = a program / docking / the gamepad / the agent has the robot
 *    (stick locked, the reason is shown, "Take over" unlocks it on purpose),
 *    grey = drive motors off (stick locked, hint) or unknown;
 *  - two arcs show the current command: the outer one the speed (top =
 *    forward, bottom = back), the inner one the turn (to the turning side);
 *  - haptics (navigator.vibrate): leaving the dead zone, the rim, an axis lock,
 *    the release.
 * Safety:
 *  - fixed rate 20 Hz while held, silent while idle (never a zero on load);
 *  - watchdog: a tick that comes > 250 ms late (frozen / throttled tab)
 *    means the command is stale → zeros at once, the stick lets go;
 *  - ONE pointer owns the stick (pointer capture); other fingers ignored;
 *  - pointercancel, lost capture, window blur, hidden tab, a closed rosbridge
 *    (release()), a lock (motors off, owner) → zeros AT ONCE (no decay);
 *  - keyboard (W A S D / arrows, Shift = half) only while the keyboard switch
 *    is on and the focus is not in a text field; the on-screen keycaps are
 *    hold-to-drive buttons (touch) through the same path.
 *
 * window.VTJoy.create(el, opts) → { setSpeed(lin, ang, label), setSpeedKey(k),
 *   setMotors(on|null), setOwner(key|null, text), setKeyboard(on), release(),
 *   state() }
 * opts: { onCommand(lin, ang), turnOnly, speedLin, speedAng, label,
 *         deck, onSpeed(key), onMotors(on), onStop(), onKeyboard(on) }
 */
(function () {
    'use strict';

    var DEAD = 0.10;          // radial dead zone (fraction of the radius)
    var EXPO = 0.60;          // 0 = linear, 1 = cubic
    var AXIS_DEG = 9;         // axis lock: ± degrees around straight / turn
    var RATE_MS = 50;         // command period while active (20 Hz)
    var STALE_MS = 250;       // watchdog: a later tick = stale command → stop
    var ACC_LIN = 1.6;        // m/s² — max change of the linear command
    var ACC_ANG = 6.0;        // rad/s² — max change of the angular command
    var DECAY = 0.35;         // first command after a release (× the last one)
    var STOP_REPEAT = 3;      // zeros sent after a stop
    var PENDING_MS = 4000;    // a speed / motor click waits this long for the echo
    var AXIS_SIN = Math.sin(AXIS_DEG * Math.PI / 180);

    function tr(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tagI(e, k, attr) { if (window.VTI18n) { VTI18n.tag(e, k, attr); } else if (!attr) { e.textContent = k; } }
    /* speed words the callers pass (map_view.js: SLOW / MID / FAST,
       imu_calibration.js: TURN) → their key; anything else is shown as is */
    var SPEED_KEYS = { SLOW: 'joy.speed.slow', MID: 'joy.speed.mid', FAST: 'joy.speed.fast', TURN: 'joy.speed.turn' };
    function speedText(label) { return SPEED_KEYS[label] ? tr(SPEED_KEYS[label]) : label; }

    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function curve(r) {       // 0..1 -> 0..1 after the dead zone
        if (r <= DEAD) { return 0; }
        var t = (r - DEAD) / (1 - DEAD);
        return (1 - EXPO) * t + EXPO * t * t * t;
    }
    /* stick (-1..1, y up) -> {m, x, y, lock}: the shaped command direction */
    function shape(nx, ny) {
        var r = Math.min(1, Math.hypot(nx, ny));
        var m = curve(r);
        if (m <= 0) { return {m: 0, x: 0, y: 0, lock: ''}; }
        var ux = nx / r, uy = ny / r, lock = '';
        if (Math.abs(ux) < AXIS_SIN) { ux = 0; uy = uy < 0 ? -1 : 1; lock = 'v'; }        // straight
        else if (Math.abs(uy) < AXIS_SIN) { uy = 0; ux = ux < 0 ? -1 : 1; lock = 'h'; }   // on the spot
        return {m: m, x: ux * m, y: uy * m, lock: lock};
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
    var SVGNS = 'http://www.w3.org/2000/svg';
    function sv(tag, attrs, parent) {
        var e = document.createElementNS(SVGNS, tag);
        Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
        if (parent) { parent.appendChild(e); }
        return e;
    }
    /* arc on a circle of radius r, angles in degrees (0 = up, clockwise) */
    function arcPath(r, a0, a1) {
        if (Math.abs(a1 - a0) < 0.5) { return ''; }
        var p = function (a) {
            var rad = a * Math.PI / 180;
            return (r * Math.sin(rad)).toFixed(2) + ' ' + (-r * Math.cos(rad)).toFixed(2);
        };
        var large = Math.abs(a1 - a0) > 180 ? 1 : 0;
        var sweep = a1 > a0 ? 1 : 0;
        return 'M ' + p(a0) + ' A ' + r + ' ' + r + ' 0 ' + large + ' ' + sweep + ' ' + p(a1);
    }

    function create(root, opts) {
        opts = opts || {};
        var onCommand = opts.onCommand || function () {};
        var deck = !!opts.deck;
        var speedLin = 0.4, speedAng = 1.3, speedLabel = 'MID';
        var speedKey = null, speedPend = null, speedPendT = 0;
        var motors = null;                  // true / false / null = unknown
        var motorPend = null, motorPendT = 0;
        var owner = null, ownerText = '', takeover = false;
        var keyboardOn = false;
        var turnOnly = !!opts.turnOnly;     // IMU calibration: rotate on the spot only
        if (opts.speedLin !== undefined) { speedLin = opts.speedLin; }
        if (opts.speedAng !== undefined) { speedAng = opts.speedAng; }
        if (opts.label) { speedLabel = opts.label; }

        /* ---- DOM (built once; every slot exists from the start) */
        root.classList.add('vt-joy');
        root.classList.toggle('vt-joy-turn', turnOnly);
        root.classList.toggle('vt-joy-deck', deck);
        root.setAttribute('data-state', 'off');
        root.innerHTML = '';

        var head, chipSpeed, chipMotors, read, readLin, readAng, kbHint;
        var stateChip, hint, takeBtn, kbToggle, caps = {}, motOn, motOff, spdBtns = {}, capTxt, stopBtn;
        var padBox = root;
        if (deck) {
            /* info: state chip · the live command · the hint / lock reason */
            var info = el('div', 'vt-joy-sec vt-joy-info', root);
            var row1 = el('div', 'vt-joy-row', info);
            stateChip = el('span', 'vt-joy-chip vt-joy-state', row1);
            read = el('span', 'vt-joy-read', row1);
            readLin = el('span', 'vt-joy-num', read);
            readAng = el('span', 'vt-joy-num', read);
            var row2 = el('div', 'vt-joy-row vt-joy-hintrow', info);
            hint = el('span', 'vt-joy-hint', row2);
            hint.setAttribute('role', 'status');
            hint.setAttribute('aria-live', 'polite');
            takeBtn = el('button', 'vt-joy-btn vt-joy-take', row2);
            takeBtn.type = 'button';
            tagI(takeBtn, 'joy.take');
            tagI(takeBtn, 'joy.take.tip', 'title');
            takeBtn.hidden = true;

            /* keyboard: switch + the WASD legend (hold-to-drive keycaps) */
            var kb = el('div', 'vt-joy-sec vt-joy-kbd', root);
            var kbCap = el('div', 'vt-joy-cap', kb);
            kbToggle = el('button', 'vt-joy-kbsw', kbCap);
            kbToggle.type = 'button';
            kbToggle.setAttribute('aria-pressed', 'false');
            kbToggle.innerHTML = '<span class="vt-joy-kbdot" aria-hidden="true"></span><span class="vt-joy-kblbl"></span>';
            tagI(kbToggle.querySelector('.vt-joy-kblbl'), 'joy.kb.lbl');
            tagI(kbToggle, 'joy.kb.tip', 'title');
            var pad4 = el('div', 'vt-joy-keys', kb);
            [['f', 'W', '▲', 'joy.key.f'], ['l', 'A', '◀', 'joy.key.l'], ['b', 'S', '▼', 'joy.key.b'], ['r', 'D', '▶', 'joy.key.r']].forEach(function (d) {
                var c = el('button', 'vt-joy-key vt-joy-key-' + d[0], pad4);
                c.type = 'button';
                c.innerHTML = '<b>' + d[1] + '</b><i aria-hidden="true">' + d[2] + '</i>';
                tagI(c, d[3], 'aria-label');
                tagI(c, d[3], 'title');
                caps[d[0]] = c;
            });

            /* motors: ON | OFF — reflects /base/motor_power_state */
            var mot = el('div', 'vt-joy-sec vt-joy-mot', root);
            var motCap = el('div', 'vt-joy-cap', mot);
            chipMotors = el('span', 'vt-joy-motors', motCap);      // right_dock.js mirrors its data-state
            tagI(el('span', 'vt-joy-caplbl', motCap), 'joy.motors.lbl');
            var motSeg = el('div', 'vt-joy-seg', mot);
            motOn = el('button', 'vt-joy-opt vt-joy-mot-on', motSeg);
            motOff = el('button', 'vt-joy-opt vt-joy-mot-off', motSeg);
            motOn.type = motOff.type = 'button';
            tagI(motOn, 'joy.motors.btn_on');
            tagI(motOff, 'joy.motors.btn_off');
            tagI(motOn, 'joy.motors.on_tip', 'title');
            tagI(motOff, 'joy.motors.off_tip', 'title');

            /* speed: Slow | Mid | Fast — reflects /navi_manager/speed */
            var spd = el('div', 'vt-joy-sec vt-joy-spd', root);
            var spdCap = el('div', 'vt-joy-cap', spd);
            tagI(el('span', 'vt-joy-caplbl', spdCap), 'joy.speed.lbl');
            capTxt = el('span', 'vt-joy-captxt', spdCap);
            var spdSeg = el('div', 'vt-joy-seg', spd);
            [['slow', 'joy.speed.slow'], ['moderate', 'joy.speed.mid'], ['fast', 'joy.speed.fast']].forEach(function (d) {
                var b = el('button', 'vt-joy-opt', spdSeg);
                b.type = 'button';
                b.dataset.speed = d[0];
                tagI(b, d[1]);
                tagI(b, 'joy.speed.tip', 'title');
                spdBtns[d[0]] = b;
            });

            /* STOP: the same full stop as the bottom bar */
            stopBtn = el('button', 'vt-joy-stop', root);
            stopBtn.type = 'button';
            stopBtn.innerHTML = '<span class="vt-joy-stopico" aria-hidden="true"></span><span class="vt-joy-stoplbl"></span>';
            tagI(stopBtn.querySelector('.vt-joy-stoplbl'), 'joy.stop');
            tagI(stopBtn, 'joy.stop.tip', 'title');

            padBox = el('div', 'vt-joy-sec vt-joy-padbox', root);
        } else {
            head = el('div', 'vt-joy-head', root);
            chipSpeed = el('span', 'vt-joy-chip vt-joy-speed', head);
            chipMotors = el('span', 'vt-joy-chip vt-joy-motors', head);
        }
        var pad = el('div', 'vt-joy-pad', padBox);
        pad.setAttribute('role', 'slider');
        pad.setAttribute('aria-label', tr('joy.pad'));
        pad.setAttribute('aria-valuetext', tr('joy.stopped'));
        if (window.VTI18n) { VTI18n.tag(pad, 'joy.pad', 'aria-label'); }
        /* the drawing: ticks, chevrons, the cap ring, the command arcs */
        var svg = sv('svg', {'class': 'vt-joy-svg', viewBox: '-50 -50 100 100', 'aria-hidden': 'true'}, pad);
        sv('circle', {'class': 'vt-joy-track', r: 46}, svg);
        var ticks = sv('g', {'class': 'vt-joy-ticks'}, svg);
        for (var a = 0; a < 360; a += 30) {
            var big = a % 90 === 0, rad = a * Math.PI / 180, r0 = big ? 37 : 40;
            sv('line', {x1: (r0 * Math.sin(rad)).toFixed(2), y1: (-r0 * Math.cos(rad)).toFixed(2),
                        x2: (43 * Math.sin(rad)).toFixed(2), y2: (-43 * Math.cos(rad)).toFixed(2),
                        'class': big ? 'big' : ''}, ticks);
        }
        var axV = sv('line', {'class': 'vt-joy-ax vt-joy-ax-v', x1: 0, y1: -34, x2: 0, y2: 34}, svg);
        var axH = sv('line', {'class': 'vt-joy-ax vt-joy-ax-h', x1: -34, y1: 0, x2: 34, y2: 0}, svg);
        var chev = sv('g', {'class': 'vt-joy-chev'}, svg);
        ['M -4 -30 L 0 -34 L 4 -30', 'M -4 30 L 0 34 L 4 30', 'M -30 -4 L -34 0 L -30 4', 'M 30 -4 L 34 0 L 30 4'].forEach(function (d, i) {
            if (turnOnly && i < 2) { return; }
            sv('path', {d: d}, chev);
        });
        sv('circle', {'class': 'vt-joy-dz', r: (DEAD * 34).toFixed(2)}, svg);
        var ring = sv('circle', {'class': 'vt-joy-ring', r: 46}, svg);
        var arcLin = sv('path', {'class': 'vt-joy-arc vt-joy-arc-lin', d: ''}, svg);
        var arcAng = sv('path', {'class': 'vt-joy-arc vt-joy-arc-ang', d: ''}, svg);
        var knob = el('div', 'vt-joy-knob', pad);
        var lockEl = el('div', 'vt-joy-lockmsg', pad);
        if (!deck) {
            read = el('div', 'vt-joy-read', root);
            readLin = el('span', 'vt-joy-num', read);
            readAng = el('span', 'vt-joy-num', read);
            kbHint = el('span', 'vt-joy-kb', read);
            kbHint.textContent = tr('joy.kb');
            if (window.VTI18n) { VTI18n.tag(kbHint, 'joy.kb'); }
        }
        ring.setAttribute('aria-hidden', 'true');
        void ring; void axV; void axH;

        /* ---- state */
        var pid = null;                     // the pointer that owns the stick
        var cx = 0, cy = 0, R = 1;          // pad centre + usable radius (px)
        var nx = 0, ny = 0;                 // normalised stick (-1..1), y up
        var tLin = 0, tAng = 0;             // target command
        var oLin = 0, oAng = 0;             // output after the rate limit
        var timer = null, phase = 'idle', zerosLeft = 0, lastT = 0;
        var wasOut = false, wasRim = false, rimAt = 0, lastLock = '';
        var keys = {}, capKeys = {}, shiftHeld = false, staleNote = false;

        /* why the stick may not drive right now ('' = it may) */
        function lockReason() {
            if (motors === false) { return 'motors'; }
            if (owner === 'ds4') { return 'ds4'; }
            if (owner && !takeover) { return 'owner'; }
            return '';
        }
        function tone() {
            if (motors === false) { return 'off'; }
            if (owner && !(takeover && owner !== 'ds4')) { return 'warn'; }
            if (motors === null) { return 'off'; }
            return 'ok';
        }
        function keyActive() {
            return !!(capKeys.f || capKeys.b || capKeys.l || capKeys.r ||
                      (keyboardOn && (keys.f || keys.b || keys.l || keys.r)));
        }
        function held() { return pid !== null || keyActive(); }

        function paintStatus() {
            var now = Date.now();
            if (speedPend && now - speedPendT > PENDING_MS) { speedPend = null; }
            if (motorPend !== null && now - motorPendT > PENDING_MS) { motorPend = null; }
            var ms = motors === true ? 'ok' : (motors === false ? 'warn' : 'off');
            chipMotors.setAttribute('data-state', ms);
            root.classList.toggle('vt-joy-nomotors', motors === false);
            root.setAttribute('data-tone', tone());
            var lr = lockReason();
            root.classList.toggle('vt-joy-locked', !!lr);
            lockEl.textContent = lr === 'motors' ? tr('joy.lock.motors_short') : (lr ? tr('joy.lock.owner_short') : '');
            if (!deck) {
                chipSpeed.textContent = speedText(speedLabel);
                chipMotors.textContent = motors === true ? tr('joy.motors.on') : (motors === false ? tr('joy.motors.off') : tr('joy.motors.unknown'));
                kbHint.hidden = !keyboardOn;
                return;
            }
            chipMotors.textContent = '';
            chipMotors.title = motors === true ? tr('joy.motors.on') : (motors === false ? tr('joy.motors.off') : tr('joy.motors.unknown'));
            /* state chip + hint */
            var t = tone(), st;
            if (lr === 'motors') { st = 'joy.st.motors'; }
            else if (lr) { st = 'joy.st.owned'; }
            else if (owner && takeover) { st = 'joy.st.takeover'; }
            else if (motors === null) { st = 'joy.st.unknown'; }
            else { st = held() ? 'joy.st.driving' : 'joy.st.free'; }
            stateChip.textContent = tr(st);
            stateChip.setAttribute('data-state', t === 'ok' ? 'ok' : (t === 'warn' ? 'warn' : 'off'));
            var h;
            if (staleNote) { h = tr('joy.hint.stale'); }
            else if (lr === 'motors') { h = tr('joy.hint.motors'); }
            else if (lr === 'ds4') { h = tr('joy.hint.ds4'); }
            else if (lr === 'owner') { h = tr('joy.hint.owner', {who: ownerText}); }
            else if (owner && takeover) { h = tr('joy.hint.takeover', {who: ownerText}); }
            else if (motors === null) { h = tr('joy.hint.unknown'); }
            else { h = tr(keyboardOn ? 'joy.hint.free_kb' : 'joy.hint.free'); }
            if (hint.textContent !== h) { hint.textContent = h; }
            takeBtn.hidden = lr !== 'owner';
            /* keyboard */
            kbToggle.classList.toggle('on', keyboardOn);
            kbToggle.setAttribute('aria-pressed', keyboardOn ? 'true' : 'false');
            ['f', 'b', 'l', 'r'].forEach(function (k) {
                caps[k].classList.toggle('down', !!(capKeys[k] || (keyboardOn && keys[k])));
                caps[k].disabled = !!lr;
            });
            /* motors: the robot's state; a click shows pending until the echo */
            var shown = motors;
            motOn.classList.toggle('sel', shown === true);
            motOff.classList.toggle('sel', shown === false);
            motOn.classList.toggle('pend', motorPend === true && shown !== true);
            motOff.classList.toggle('pend', motorPend === false && shown !== false);
            motOn.setAttribute('aria-pressed', shown === true ? 'true' : 'false');
            motOff.setAttribute('aria-pressed', shown === false ? 'true' : 'false');
            /* speed */
            Object.keys(spdBtns).forEach(function (k) {
                spdBtns[k].classList.toggle('sel', speedKey === k);
                spdBtns[k].classList.toggle('pend', speedPend === k && speedKey !== k);
                spdBtns[k].setAttribute('aria-pressed', speedKey === k ? 'true' : 'false');
            });
            capTxt.textContent = tr('joy.speed.cap', {v: speedLin.toFixed(2)});
        }
        function paintRead() {
            readLin.textContent = (oLin >= 0 ? '+' : '−') + Math.abs(oLin).toFixed(2) + ' m/s';
            readAng.textContent = (oAng >= 0 ? '+' : '−') + Math.abs(oAng).toFixed(2) + ' rad/s';
            /* the command arcs: speed on the outer ring (top = forward,
               bottom = back), turn on the inner one (to the turning side) */
            var fl = speedLin > 0 ? clamp(Math.abs(oLin) / speedLin, 0, 1) : 0;
            var fa = speedAng > 0 ? clamp(Math.abs(oAng) / speedAng, 0, 1) : 0;
            var c = oLin < 0 ? 180 : 0, w = fl * 80;
            arcLin.setAttribute('d', fl > 0.005 ? arcPath(46, c - w, c + w) : '');
            var turnDeg = fa * 90 * (oAng < 0 ? 1 : -1);       // right (−z) = clockwise
            arcAng.setAttribute('d', fa > 0.005 ? arcPath(40, 0, turnDeg) : '');
        }
        function paintStick() {
            var r = Math.min(1, Math.hypot(nx, ny));
            var kx = nx * R, ky = -ny * R;
            knob.style.transform = 'translate(' + kx.toFixed(1) + 'px,' + ky.toFixed(1) + 'px)';
            pad.style.setProperty('--vt-joy-mag', r.toFixed(3));
            var active = held();
            root.setAttribute('data-state', active ? (motors === false ? 'warn' : 'info') : 'off');
            root.classList.toggle('vt-joy-live', active && r > DEAD);
            root.classList.toggle('vt-joy-held', pid !== null);
            var lk = active ? lastLock : '';
            root.classList.toggle('vt-joy-lock-v', lk === 'v');
            root.classList.toggle('vt-joy-lock-h', lk === 'h');
            pad.setAttribute('aria-valuetext', active ? tr('joy.value', {lin: oLin.toFixed(2), ang: oAng.toFixed(2)}) : tr('joy.stopped'));
        }

        /* stick -> target command */
        function computeTarget() {
            var s = shape(nx, ny);
            tLin = s.y * speedLin;
            tAng = -s.x * speedAng;                                            // right = clockwise = −z
            var r = Math.min(1, Math.hypot(nx, ny));
            var out = r > DEAD;
            if (out && !wasOut) { buzz(8); }
            if (s.lock && s.lock !== lastLock) { buzz(4); }
            lastLock = s.lock;
            var rim = r > 0.97;
            var now = Date.now();
            if (rim && !wasRim && now - rimAt > 400) { buzz(14); rimAt = now; }
            wasOut = out; wasRim = rim;
        }

        /* ---- the command loop: idle → drive → (decay) → zero × 3 → idle */
        function send(l, a) { onCommand(l, a); paintRead(); }
        function tick() {
            var now = Date.now();
            if (phase === 'drive') {
                if (lastT && now - lastT > STALE_MS) {        // watchdog: stale
                    staleNote = true;
                    setTimeout(function () { staleNote = false; paintStatus(); }, 4000);
                    hardStop();
                    return;
                }
                var dt = lastT ? (now - lastT) / 1000 : RATE_MS / 1000;
                lastT = now;
                /* slowing down is allowed 3× faster than speeding up */
                var aL = ACC_LIN * dt * (Math.abs(tLin) < Math.abs(oLin) ? 3 : 1);
                var aA = ACC_ANG * dt * (Math.abs(tAng) < Math.abs(oAng) ? 3 : 1);
                oLin += clamp(tLin - oLin, -aL, aL);
                oAng += clamp(tAng - oAng, -aA, aA);
                if (Math.abs(oLin) < 1e-3) { oLin = 0; }
                if (Math.abs(oAng) < 1e-3) { oAng = 0; }
                send(oLin, oAng);
                return;
            }
            lastT = now;
            if (phase === 'decay') {
                oLin *= DECAY; oAng *= DECAY;
                if (Math.abs(oLin) < 0.01) { oLin = 0; }
                if (Math.abs(oAng) < 0.03) { oAng = 0; }
                send(oLin, oAng);
                phase = 'zero'; zerosLeft = STOP_REPEAT;
                return;
            }
            if (phase === 'zero') {
                oLin = 0; oAng = 0;
                send(0, 0);
                zerosLeft -= 1;
                if (zerosLeft <= 0) {
                    phase = 'idle';
                    if (timer) { clearInterval(timer); timer = null; }
                    paintStatus();
                }
            }
        }
        function restartTimer() {
            if (timer) { clearInterval(timer); }
            timer = setInterval(tick, RATE_MS);
        }
        function engage() {
            if (lockReason()) { return false; }
            staleNote = false;
            if (phase !== 'drive') { phase = 'drive'; lastT = 0; tick(); restartTimer(); }
            paintStatus();
            return true;
        }
        function resetStick() {
            pid = null; nx = 0; ny = 0; keys = {}; capKeys = {};
            wasOut = false; wasRim = false; lastLock = '';
            tLin = 0; tAng = 0;
        }
        /* a hand let go: short decay, zero within one period */
        function softRelease() {
            resetStick();
            paintStick();
            if (phase === 'drive') { phase = 'decay'; tick(); restartTimer(); }
            paintStatus();
        }
        /* anything else: zeros at once */
        function hardStop() {
            resetStick();
            paintStick();
            if (phase !== 'idle') { phase = 'zero'; zerosLeft = STOP_REPEAT; tick(); if (phase !== 'idle') { restartTimer(); } }
            paintStatus();
        }

        /* ---- pointer (touch, pen, mouse) */
        function measure() {
            var b = pad.getBoundingClientRect();
            cx = b.left + b.width / 2; cy = b.top + b.height / 2;
            R = Math.max(10, b.width / 2 - knob.offsetWidth / 2 - 2);
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
        function nudgeLock() {
            root.classList.remove('vt-joy-nudge');
            void root.offsetWidth;
            root.classList.add('vt-joy-nudge');
            buzz([10, 40, 10]);
        }
        pad.addEventListener('pointerdown', function (e) {
            if (pid !== null) { return; }                 // a second finger: ignored
            if (e.pointerType === 'mouse' && e.button !== 0) { return; }
            e.preventDefault();
            if (lockReason()) { nudgeLock(); return; }
            keys = {}; capKeys = {};                      // the stick wins over the keys
            pid = e.pointerId;
            try { pad.setPointerCapture(pid); } catch (err) { /* old browser */ }
            measure();
            track(e);
            engage();
        });
        pad.addEventListener('pointermove', function (e) {
            if (e.pointerId !== pid) { return; }
            e.preventDefault();
            if (e.pointerType === 'mouse' && e.buttons === 0) { end(e); return; }   // missed mouseup
            track(e);
        });
        function end(e) {
            if (e.pointerId !== pid) { return; }
            if (wasOut) { buzz(5); }
            softRelease();
        }
        function cancel(e) {
            if (e.pointerId !== pid) { return; }
            hardStop();
        }
        pad.addEventListener('pointerup', end);
        pad.addEventListener('pointercancel', cancel);
        pad.addEventListener('lostpointercapture', function (e) { if (e.pointerId === pid) { softRelease(); } });
        pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        /* ---- keyboard + keycaps: the same command path */
        var KEYMAP = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
        function fromKeys() {
            var k = shiftHeld ? 0.5 : 1;
            var f = (capKeys.f || (keyboardOn && keys.f)) ? 1 : 0, b = (capKeys.b || (keyboardOn && keys.b)) ? 1 : 0;
            var l = (capKeys.l || (keyboardOn && keys.l)) ? 1 : 0, r = (capKeys.r || (keyboardOn && keys.r)) ? 1 : 0;
            ny = (f - b) * k;
            nx = turnOnly ? 0 : 0;
            nx = (r - l) * k;
            if (turnOnly) { ny = 0; }
            /* keys are digital: full deflection = full speed, skip the curve */
            tLin = ny * speedLin;
            tAng = -nx * speedAng;
            lastLock = (nx === 0 && ny !== 0) ? 'v' : ((ny === 0 && nx !== 0) ? 'h' : '');
            paintStick();
        }
        window.addEventListener('keydown', function (e) {
            var k = KEYMAP[e.code];
            if (!k || !keyboardOn || pid !== null || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) { return; }
            e.preventDefault();
            if (lockReason()) { if (!e.repeat) { nudgeLock(); } return; }
            shiftHeld = e.shiftKey;
            if (!keys[k]) { keys[k] = true; fromKeys(); engage(); paintStatus(); }
        });
        window.addEventListener('keyup', function (e) {
            var k = KEYMAP[e.code];
            if (!k || !keys[k]) { return; }
            keys[k] = false;
            shiftHeld = e.shiftKey;
            if (keyActive()) { fromKeys(); paintStatus(); } else { softRelease(); }
        });
        Object.keys(caps).forEach(function (k) {
            var c = caps[k], cid = null;
            c.addEventListener('pointerdown', function (e) {
                if (cid !== null || pid !== null) { return; }
                if (e.pointerType === 'mouse' && e.button !== 0) { return; }
                e.preventDefault();
                if (lockReason()) { nudgeLock(); return; }
                cid = e.pointerId;
                try { c.setPointerCapture(cid); } catch (err) { /* old browser */ }
                capKeys[k] = true; shiftHeld = false;
                fromKeys(); engage(); paintStatus();
            });
            var up = function (e) {
                if (e.pointerId !== cid) { return; }
                cid = null;
                if (!capKeys[k]) { return; }
                capKeys[k] = false;
                if (e.type === 'pointercancel') { hardStop(); return; }
                if (keyActive()) { fromKeys(); paintStatus(); } else { softRelease(); }
            };
            c.addEventListener('pointerup', up);
            c.addEventListener('pointercancel', up);
            c.addEventListener('lostpointercapture', up);
            c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
            c.addEventListener('click', function (e) { e.preventDefault(); });   // no keyboard "click" drive
        });

        /* ---- anything that takes the hand away stops the robot at once */
        window.addEventListener('blur', function () { if (phase !== 'idle' || held()) { hardStop(); } });
        document.addEventListener('visibilitychange', function () { if (document.hidden) { hardStop(); } });
        window.addEventListener('pagehide', function () { hardStop(); });

        /* ---- deck controls */
        if (deck) {
            kbToggle.addEventListener('click', function () {
                api.setKeyboard(!keyboardOn);
                if (opts.onKeyboard) { opts.onKeyboard(keyboardOn); }
            });
            motOn.addEventListener('click', function () {
                if (motors === true || !opts.onMotors) { return; }
                motorPend = true; motorPendT = Date.now();
                opts.onMotors(true);
                paintStatus();
            });
            motOff.addEventListener('click', function () {
                if (!opts.onMotors) { return; }
                hardStop();
                motorPend = false; motorPendT = Date.now();
                opts.onMotors(false);
                paintStatus();
            });
            Object.keys(spdBtns).forEach(function (k) {
                spdBtns[k].addEventListener('click', function () {
                    if (!opts.onSpeed || speedKey === k) { return; }
                    speedPend = k; speedPendT = Date.now();
                    opts.onSpeed(k);
                    paintStatus();
                });
            });
            stopBtn.addEventListener('click', function () {
                hardStop();
                if (opts.onStop) { opts.onStop(); }
            });
            takeBtn.addEventListener('click', function () {
                takeover = true;
                buzz(10);
                paintStatus(); paintStick();
            });
            setInterval(function () { if (speedPend || motorPend !== null) { paintStatus(); } }, 1000);
        }

        paintStatus(); paintRead(); paintStick();
        if (window.VTI18n) { VTI18n.onChange(function () { paintStatus(); paintStick(); }); }

        var api = {
            setSpeed: function (lin, ang, label) {
                if (lin > 0) { speedLin = lin; }
                if (ang > 0) { speedAng = ang; }
                if (label) { speedLabel = label; }
                if (held()) { computeTargetOrKeys(); }
                paintStatus();
            },
            /* the robot's speed mode: 'slow' | 'moderate' | 'fast' */
            setSpeedKey: function (k) {
                speedKey = k || null;
                if (speedPend === k) { speedPend = null; }
                paintStatus();
            },
            setMotors: function (on) {
                motors = (on === true || on === false) ? on : null;
                if (motorPend === motors) { motorPend = null; }
                if (lockReason() && phase === 'drive') { hardStop(); }
                paintStatus(); paintStick();
            },
            /* who else has the robot: null = nobody; key 'program' | 'dock' |
               'undock' | 'ds4' | 'agent' + a readable text for the hint */
            setOwner: function (key, text) {
                key = key || null;
                if (key !== owner) { takeover = false; }
                owner = key;
                ownerText = text || '';
                if (lockReason() && phase === 'drive') { hardStop(); }
                paintStatus(); paintStick();
            },
            setKeyboard: function (on) {
                keyboardOn = !!on;
                if (!on) { keys = {}; if (!keyActive() && pid === null && phase === 'drive') { softRelease(); } }
                paintStatus();
            },
            release: hardStop,
            state: function () {
                return { active: held(), lin: oLin, ang: oAng, nx: nx, ny: ny, sending: !!timer,
                         phase: phase, lock: lockReason(), tone: tone(), motors: motors,
                         speedKey: speedKey, owner: owner, takeover: takeover, keyboard: keyboardOn };
            }
        };
        function computeTargetOrKeys() { if (pid !== null) { computeTarget(); } else { fromKeys(); } }
        return api;
    }

    window.VTJoy = { create: create, _curve: curve, _shape: shape,
                     _const: { DEAD: DEAD, EXPO: EXPO, AXIS_DEG: AXIS_DEG, RATE_MS: RATE_MS,
                               STALE_MS: STALE_MS, DECAY: DECAY, STOP_REPEAT: STOP_REPEAT } };
})();
