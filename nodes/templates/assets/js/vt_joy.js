/* vt_joy.js — the on-screen joystick + keyboard drive of the robot UI.
 *
 * One component for touch, mouse and keyboard; ROS-agnostic: it only calls
 * opts.onCommand(lin, ang) — map_view.js turns that into /teleop/cmd_vel (the
 * human input of cmd_vel_mux), imu_calibration.js into a rotate-only command.
 *
 * Two shapes:
 *  - plain (IMU calibration, #joy_view_imu): status line + pad + readout;
 *  - DECK (the map's #joy_view, opts.deck): the width of the right panel's
 *    column (vt_frame.js); on a phone held upright a band (controls left,
 *    pad right). owner 2026-10-25: every control says what it is:
 *
 *   ┌──────────────────────────────┐
 *   │ SPEED 0.40 m/s            ?  │  the stick's top speed (low window: + mode chip)
 *   │ [−] ▂▃▄▅▆▇█ [+]              │  7 levels (LEVELS), click / drag / wheel /
 *   │   slow | mid | fast          │  arrows / + − keys; bands = the modes, lit = robot's
 *   │          ( pad )             │  ring = cap + state
 *   │ [⌨ Keys]     [⚙ Motors OFF]  │  labelled buttons
 *   │ hint: what to do now         │
 *   └──────────────────────────────┘  + a first-use card ("?" brings it back)
 *
 *   the mode and the motors only ever show what the ROBOT reports
 *   (setSpeedKey / setMotors); a level of another mode / a motor click
 *   blinks until the robot echoes it (4 s, then it falls back to the
 *   reported state). A level inside the reported mode only changes the
 *   stick's cap (no message). Motors are never switched on by the page.
 *
 * Feel (numbers in the constants below):
 *  - radial dead zone 10 %, then an expo curve (60 % cubic): fine control
 *    near the centre, full speed (of the active level's cap) at the rim;
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
 *  - keyboard (W A S D / arrows, Shift = half, + / − = speed level) only while the keyboard switch
 *    is on and the focus is not in a text field.
 *
 * window.VTJoy.create(el, opts) → { setSpeed(lin, ang, label), setSpeedKey(k),
 *   setMotors(on|null), setOwner(key|null, text), setKeyboard(on), release(),
 *   state() }
 * opts: { onCommand(lin, ang), turnOnly, speedLin, speedAng, label,
 *         deck, levels, onSpeed(modeKey), onMotors(on), onStop(), onKeyboard(on) }
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
    /* the deck's speed levels (map_view.js passes the same table): lin =
       the stick's top speed (m/s, forward and back), ang = its top turn
       (rad/s), mode = the robot's speed mode the level belongs to, def =
       the level of that mode when the robot switches mode by itself. The
       top level of each mode = the mode's navigation speed (vitulus_navi
       navi_man: TEB max_vel_x 0.25 / 0.4 / 0.75 m/s). */
    var LEVELS = [
        {lin: 0.10, ang: 0.4, mode: 'slow'},
        {lin: 0.18, ang: 0.5, mode: 'slow'},
        {lin: 0.25, ang: 0.6, mode: 'slow', def: true},
        {lin: 0.32, ang: 1.0, mode: 'moderate'},
        {lin: 0.40, ang: 1.3, mode: 'moderate', def: true},
        {lin: 0.55, ang: 1.4, mode: 'fast'},
        {lin: 0.75, ang: 1.5, mode: 'fast', def: true}
    ];
    var LS_LEVEL = 'vitulus_joy_speed_level';
    var LS_INTRO = 'vitulus_joy_intro_seen';

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
        /* deck: the speed LEVELS (fine steps of the stick's top speed), each
           inside one of the robot's speed modes (/navi_manager/speed is only
           SLOW / MEDIUM / FAST — navigation drives at the mode's speed). The
           level whose mode the robot reports is the stick's cap; a level of
           another mode asks the robot for that mode first (blinks until the
           echo). The chosen level is remembered in this browser. */
        var levels = (opts.levels && opts.levels.length) ? opts.levels : LEVELS;
        var level = defaultLevel('moderate'), want = null, wantT = 0;
        var storedLevel = null;
        try {
            var sl = parseInt(localStorage.getItem(LS_LEVEL), 10);
            if (sl >= 0 && sl < levels.length) { storedLevel = sl; level = sl; }
        } catch (e) { /* no storage: the default */ }
        var introSeen = false;
        try { introSeen = localStorage.getItem(LS_INTRO) === '1'; } catch (e) { introSeen = true; }
        function defaultLevel(mode) {
            for (var i = 0; i < levels.length; i++) { if (levels[i].mode === mode && levels[i].def) { return i; } }
            for (var j = levels.length - 1; j >= 0; j--) { if (levels[j].mode === mode) { return j; } }
            return 0;
        }
        if (deck) { speedLin = levels[level].lin; speedAng = levels[level].ang; }

        /* ---- DOM (built once; every slot exists from the start) */
        root.classList.add('vt-joy');
        root.classList.toggle('vt-joy-turn', turnOnly);
        root.classList.toggle('vt-joy-deck', deck);
        root.setAttribute('data-state', 'off');
        root.innerHTML = '';

        var head, chipSpeed, chipMotors, read, readLin, readAng, kbHint;
        var hint, takeBtn, kbToggle, caps = {}, motOn, motOff;
        var spdBox, spdVal, spdMode, spdBar, spdMinus, spdPlus, spdSegs = [], spdBands = {};
        var helpBtn, intro, introOk, preview = null;
        var padBox = root;
        if (deck) {
            /* owner 2026-10-25: the speed must be SEEN to be switchable — a
               labelled row above the pad (name · m/s · mode, − [bars] +, the
               Slow / Mid / Fast bands under the bars) instead of three big
               arcs of the rim; motors and keys = labelled buttons under the
               pad; one hint line; a first-use card ("?" shows it again) */
            spdBox = el('div', 'vt-joy-spdbox', root);
            var sh = el('div', 'vt-joy-spdhead', spdBox);
            var shl = el('span', 'vt-joy-spdname', sh);
            tagI(shl, 'joy.d.speed');
            spdVal = el('span', 'vt-joy-spdval', sh);
            spdMode = el('span', 'vt-joy-spdmode', sh);
            helpBtn = el('button', 'vt-joy-helpbtn', sh);
            helpBtn.type = 'button';
            helpBtn.textContent = '?';
            tagI(helpBtn, 'joy.d.help.tip', 'title');
            tagI(helpBtn, 'joy.d.help.tip', 'aria-label');
            var sr = el('div', 'vt-joy-spdrow', spdBox);
            spdMinus = el('button', 'vt-joy-spdstep', sr);
            spdMinus.type = 'button';
            spdMinus.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
            tagI(spdMinus, 'joy.d.slower', 'title');
            tagI(spdMinus, 'joy.d.slower', 'aria-label');
            spdBar = el('div', 'vt-joy-spdbar', sr);
            spdBar.setAttribute('role', 'slider');
            spdBar.setAttribute('tabindex', '0');
            spdBar.setAttribute('aria-valuemin', '1');
            spdBar.setAttribute('aria-valuemax', String(levels.length));
            tagI(spdBar, 'joy.d.speed', 'aria-label');
            levels.forEach(function (lv, i) {
                var seg = el('span', 'vt-joy-seg', spdBar);
                seg.setAttribute('data-mode', lv.mode);
                /* rising bars: the taller, the faster (height ∝ m/s) */
                seg.style.setProperty('--h', Math.round(30 + 70 * lv.lin / levels[levels.length - 1].lin) + '%');
                spdSegs.push(seg);
            });
            spdPlus = el('button', 'vt-joy-spdstep', sr);
            spdPlus.type = 'button';
            spdPlus.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7M6 2.5v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
            tagI(spdPlus, 'joy.d.faster', 'title');
            tagI(spdPlus, 'joy.d.faster', 'aria-label');
            var bands = el('div', 'vt-joy-spdbands', spdBox);
            ['slow', 'moderate', 'fast'].forEach(function (m) {
                var n = levels.filter(function (lv) { return lv.mode === m; }).length;
                if (!n) { return; }
                var b = el('span', 'vt-joy-mband', bands);
                b.setAttribute('data-mode', m);
                b.style.flexGrow = String(n);
                tagI(b, 'joy.d.mode.' + m);
                b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
                spdBands[m] = b;
            });
            padBox = el('div', 'vt-joy-padbox', root);
            var ctl = el('div', 'vt-joy-ctlrow', root);
            kbToggle = el('button', 'vt-joy-kbsw vt-joy-ctl', ctl);
            kbToggle.type = 'button';
            kbToggle.setAttribute('aria-pressed', 'false');
            kbToggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="4" width="14" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.2 6.3h1.4M6.2 6.3h1.4M9.2 6.3h1.4M12.2 6.3h.8M3.2 8.6h1.4M6.2 8.6h3.8M11.2 8.6h1.8M4.2 10.8h7.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span class="vt-joy-ctllbl vt-joy-kblbl"></span>';
            tagI(kbToggle.querySelector('.vt-joy-kblbl'), 'joy.kb.lbl');
            tagI(kbToggle, 'joy.d.kb.tip', 'title');
            motOn = el('button', 'vt-joy-motbtn vt-joy-ctl', ctl);   // one toggle: ON <-> OFF
            motOn.type = 'button';
            /* a drive motor: a gear with a bolt, then "Motors ON / OFF" */
            motOn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2 9 1.5h-2l1 1.7Zm0 9.6-1 1.7h2l-1-1.7ZM3.2 8l-1.7-1v2l1.7-1Zm9.6 0 1.7 1v-2l-1.7 1ZM4.6 4.6 3.1 3.8l-.7.7.8 1.5 1.4-1.4Zm6.8 6.8 1.5.8.7-.7-.8-1.5-1.4 1.4Zm0-6.8 1.4 1.4.8-1.5-.7-.7-1.5.8ZM4.6 11.4l-1.4-1.4-.8 1.5.7.7 1.5-.8Z" fill="currentColor"/><circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.4 5.6 6.9 8.3h1.3l-.6 2.1 1.6-2.8H7.9l.5-2Z" fill="currentColor"/></svg>';
            chipMotors = el('span', 'vt-joy-motors', motOn);    // right_dock.js mirrors its data-state
            motOff = el('span', 'vt-joy-ctllbl vt-joy-motlbl', motOn);
            /* the hint line: what to do now (the same text = the pad's tooltip) */
            hint = el('div', 'vt-joy-hint', root);
            hint.setAttribute('role', 'status');
            hint.setAttribute('aria-live', 'polite');
            /* the first-use card (over the deck; "?" brings it back) */
            intro = el('div', 'vt-joy-intro', root);
            intro.hidden = true;
            intro.setAttribute('role', 'dialog');
            var it = el('div', 'vt-joy-intro-t', intro);
            tagI(it, 'joy.d.intro.title');
            var ol = el('ol', 'vt-joy-intro-l', intro);
            ['mot', 'speed', 'stick', 'keys', 'stop'].forEach(function (k) {
                var li = el('li', k === 'keys' ? 'vt-joy-intro-kb' : '', ol);
                tagI(li, 'joy.d.intro.' + k);
            });
            introOk = el('button', 'vt-joy-intro-ok', intro);
            introOk.type = 'button';
            tagI(introOk, 'joy.d.intro.ok');
            [motOn, kbToggle, helpBtn, spdMinus, spdPlus, spdBar, intro].forEach(function (b) { b.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); });
            /* detached: the command readout is the arcs + aria-valuetext here */
            readLin = el('span'); readAng = el('span');
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
        sv('line', {'class': 'vt-joy-ax vt-joy-ax-v', x1: 0, y1: -34, x2: 0, y2: 34}, svg);
        sv('line', {'class': 'vt-joy-ax vt-joy-ax-h', x1: -34, y1: 0, x2: 34, y2: 0}, svg);
        var chev = sv('g', {'class': 'vt-joy-chev'}, svg);
        ['M -4 -30 L 0 -34 L 4 -30', 'M -4 30 L 0 34 L 4 30', 'M -30 -4 L -34 0 L -30 4', 'M 30 -4 L 34 0 L 30 4'].forEach(function (d, i) {
            if (turnOnly && i < 2) { return; }
            sv('path', {d: d}, chev);
        });
        sv('circle', {'class': 'vt-joy-dz', r: (DEAD * 34).toFixed(2)}, svg);
        sv('circle', {'class': 'vt-joy-ring', r: 46}, svg);
        var arcLin = sv('path', {'class': 'vt-joy-arc vt-joy-arc-lin', d: ''}, svg);
        var arcAng = sv('path', {'class': 'vt-joy-arc vt-joy-arc-ang', d: ''}, svg);
        var knob = el('div', 'vt-joy-knob', pad);
        var lockEl = el('div', 'vt-joy-lockmsg', pad);
        if (deck) {
            takeBtn = el('button', 'vt-joy-take', pad);
            takeBtn.type = 'button';
            tagI(takeBtn, 'joy.take');
            tagI(takeBtn, 'joy.take.tip', 'title');
            takeBtn.hidden = true;
            /* the take-over button must not start a drag on the pad */
            takeBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        }
        if (!deck) {
            read = el('div', 'vt-joy-read', root);
            readLin = el('span', 'vt-joy-num', read);
            readAng = el('span', 'vt-joy-num', read);
            kbHint = el('span', 'vt-joy-kb', read);
            kbHint.textContent = tr('joy.kb');
            if (window.VTI18n) { VTI18n.tag(kbHint, 'joy.kb'); }
        }

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
            // the word in the pad only when someone else holds the robot; a
            // grey ring already says "motors off" (owner: colour, not text)
            lockEl.textContent = (lr && lr !== 'motors') ? tr('joy.lock.owner_short') : '';
            if (!deck) {
                chipSpeed.textContent = speedText(speedLabel);
                chipMotors.textContent = motors === true ? tr('joy.motors.on') : (motors === false ? tr('joy.motors.off') : tr('joy.motors.unknown'));
                kbHint.hidden = !keyboardOn;
                return;
            }
            var h;
            if (staleNote) { h = tr('joy.hint.stale'); }
            else if (lr === 'motors') { h = tr('joy.d.hint.motors'); }
            else if (lr === 'ds4') { h = tr('joy.hint.ds4'); }
            else if (lr === 'owner') { h = tr('joy.hint.owner', {who: ownerText}); }
            else if (owner && takeover) { h = tr('joy.hint.takeover', {who: ownerText}); }
            else if (motors === null) { h = tr('joy.hint.unknown'); }
            else { h = tr(keyboardOn ? 'joy.d.hint.free_kb' : 'joy.d.hint.free'); }
            if (hint.textContent !== h) { hint.textContent = h; }
            if (pad.title !== h) { pad.title = h; }
            hint.setAttribute('data-tone', tone());
            takeBtn.hidden = lr !== 'owner';
            /* keyboard */
            kbToggle.classList.toggle('on', keyboardOn);
            kbToggle.setAttribute('aria-pressed', keyboardOn ? 'true' : 'false');
            /* motors: ONE toggle showing the robot's state; a click blinks
               until the robot echoes it */
            var mk = motors === true ? 'on' : (motors === false ? 'off' : 'unknown');
            motOn.setAttribute('data-state', mk);
            motOn.classList.toggle('pend', motorPend !== null && motorPend !== motors);
            motOn.setAttribute('aria-pressed', motors === true ? 'true' : 'false');
            var ml = tr('joy.d.mot.' + mk);
            if (motOff.textContent !== ml) { motOff.textContent = ml; }
            var mt = tr(motors === true ? 'joy.motors.off_tip' : (motors === false ? 'joy.motors.on_tip' : 'joy.motors.unknown_tip'));
            if (motOn.title !== mt) { motOn.title = mt; }
            /* speed: the level the stick drives with; a wanted level of
               another mode blinks until the robot reports that mode */
            if (want !== null && now - wantT > PENDING_MS) { want = null; }
            var lv = levels[level];
            var vtxt = lv.lin.toFixed(2) + ' m/s';
            if (spdVal.textContent !== vtxt) { spdVal.textContent = vtxt; }
            var shownMode = speedKey || null;
            var mtxt = shownMode ? tr('joy.d.mode.' + shownMode) : '?';
            if (spdMode.textContent !== mtxt) { spdMode.textContent = mtxt; }
            spdMode.setAttribute('data-mode', shownMode || 'unknown');
            spdBox.classList.toggle('pend', want !== null);
            spdSegs.forEach(function (seg, i) {
                seg.classList.toggle('on', i <= level);
                seg.classList.toggle('cur', i === level);
                seg.classList.toggle('want', want !== null && i === want);
                seg.classList.toggle('pre', preview !== null && i === preview);
            });
            Object.keys(spdBands).forEach(function (m) {
                spdBands[m].classList.toggle('sel', speedKey === m);
                spdBands[m].classList.toggle('pend', want !== null && levels[want].mode === m && speedKey !== m);
                var navv = navSpeed(m);
                var bt = tr('joy.d.band.tip', {mode: tr('joy.d.mode.' + m), v: navv.toFixed(2)});
                if (spdBands[m].title !== bt) { spdBands[m].title = bt; }
            });
            spdBar.setAttribute('aria-valuenow', String(level + 1));
            spdBar.setAttribute('aria-valuetext', vtxt + ', ' + mtxt);
            var bt2 = tr('joy.d.bar.tip', {v: vtxt, a: lv.ang.toFixed(1), mode: mtxt});
            if (spdBar.title !== bt2) { spdBar.title = bt2; }
            spdMinus.disabled = (want !== null ? want : level) <= 0;
            spdPlus.disabled = (want !== null ? want : level) >= levels.length - 1;
            /* first use: the card, once the deck is on screen */
            if (!introSeen && intro.hidden && root.offsetWidth > 0) { intro.hidden = false; }
        }
        function navSpeed(m) {   // the mode's navigation speed = its top level
            var v = 0;
            levels.forEach(function (lv) { if (lv.mode === m && lv.lin > v) { v = lv.lin; } });
            return v;
        }
        /* the stick drives with level i (no robot message) */
        function applyLevel(i) {
            level = i;
            speedLin = levels[i].lin; speedAng = levels[i].ang;
            if (held()) { computeTargetOrKeys(); }
        }
        /* a person picked level i (bar, − / +, keys) */
        function chooseLevel(i) {
            i = clamp(i, 0, levels.length - 1);
            var m = levels[i].mode;
            try { localStorage.setItem(LS_LEVEL, String(i)); } catch (e) { /* ignore */ }
            storedLevel = i;
            if (speedKey === m) {               // the same mode: only the stick's cap
                want = null;
                if (i !== level) { applyLevel(i); buzz(6); }
            } else {                            // another mode: ask the robot, wait for its echo
                want = i; wantT = Date.now();
                if (opts.onSpeed) { opts.onSpeed(m); }
            }
            paintStatus();
        }
        function stepLevel(d) { chooseLevel((want !== null ? want : level) + d); }
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
            nx = (r - l) * k;
            if (turnOnly) { ny = 0; }
            /* keys are digital: full deflection = full speed, skip the curve */
            tLin = ny * speedLin;
            tAng = -nx * speedAng;
            lastLock = (nx === 0 && ny !== 0) ? 'v' : ((ny === 0 && nx !== 0) ? 'h' : '');
            paintStick();
        }
        var SPEEDKEYS = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Slash: -1 };
        window.addEventListener('keydown', function (e) {
            /* deck: + / − change the speed while the keyboard drives */
            if (deck && keyboardOn && SPEEDKEYS[e.code] && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                if (!e.repeat) { stepLevel(SPEEDKEYS[e.code]); }
                return;
            }
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
                if (!opts.onMotors || motors === null) { return; }   // unknown: nothing to toggle
                var want = !motors;
                if (!want) { hardStop(); }
                motorPend = want; motorPendT = Date.now();
                opts.onMotors(want);
                paintStatus();
            });
            /* speed: − / +, the bars (tap / click / drag along them, the
               wheel), the keys when the bar has the focus */
            spdMinus.addEventListener('click', function () { stepLevel(-1); });
            spdPlus.addEventListener('click', function () { stepLevel(1); });
            var barPid = null;
            var segAt = function (x) {
                var b = spdBar.getBoundingClientRect();
                return clamp(Math.floor((x - b.left) / b.width * levels.length), 0, levels.length - 1);
            };
            spdBar.addEventListener('pointerdown', function (e) {
                if (barPid !== null) { return; }
                if (e.pointerType === 'mouse' && e.button !== 0) { return; }
                e.preventDefault();
                barPid = e.pointerId;
                try { spdBar.setPointerCapture(barPid); } catch (err) { /* old browser */ }
                preview = segAt(e.clientX);
                paintStatus();
            });
            spdBar.addEventListener('pointermove', function (e) {
                if (e.pointerId !== barPid) { return; }
                var p = segAt(e.clientX);
                if (p !== preview) { preview = p; paintStatus(); }
            });
            var barEnd = function (e) {
                if (e.pointerId !== barPid) { return; }
                barPid = null;
                var p = preview;
                preview = null;
                if (e.type === 'pointerup' && p !== null) { chooseLevel(p); } else { paintStatus(); }
            };
            spdBar.addEventListener('pointerup', barEnd);
            spdBar.addEventListener('pointercancel', barEnd);
            spdBar.addEventListener('lostpointercapture', function (e) { if (e.pointerId === barPid) { barPid = null; preview = null; paintStatus(); } });
            var wheelAt = 0;
            spdBar.addEventListener('wheel', function (e) {
                e.preventDefault();
                var now = Date.now();
                if (now - wheelAt < 180 || !e.deltaY) { return; }   // one notch = one step
                wheelAt = now;
                stepLevel(e.deltaY < 0 ? 1 : -1);
            }, {passive: false});
            spdBar.addEventListener('keydown', function (e) {
                var d = {ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 1, PageDown: -1}[e.key];
                if (e.key === 'Home') { d = -99; } else if (e.key === 'End') { d = 99; }
                var n = /^[1-9]$/.test(e.key) ? parseInt(e.key, 10) : 0;
                if (!d && !(n && n <= levels.length)) { return; }
                e.preventDefault();
                e.stopPropagation();            // the bar's arrows never drive
                if (n) { chooseLevel(n - 1); } else { stepLevel(d); }
            });
            /* a mode's name under the bars = that mode at its own speed */
            Object.keys(spdBands).forEach(function (m) {
                spdBands[m].addEventListener('click', function () { chooseLevel(defaultLevel(m)); });
            });
            helpBtn.addEventListener('click', function () { intro.hidden = !intro.hidden; if (!intro.hidden) { introOk.focus(); } });
            introOk.addEventListener('click', function () {
                intro.hidden = true; introSeen = true;
                try { localStorage.setItem(LS_INTRO, '1'); } catch (e) { /* ignore */ }
            });
            takeBtn.addEventListener('click', function () {
                takeover = true;
                buzz(10);
                paintStatus(); paintStick();
            });
            setInterval(function () { if (want !== null || motorPend !== null || (!introSeen && intro.hidden)) { paintStatus(); } }, 1000);
        }

        paintStatus(); paintRead(); paintStick();
        if (window.VTI18n) { VTI18n.onChange(function () { paintStatus(); paintStick(); }); }

        var api = {
            setSpeed: function (lin, ang, label) {
                /* the deck's cap is its level (setSpeedKey); others take the numbers */
                if (lin > 0 && !deck) { speedLin = lin; }
                if (ang > 0 && !deck) { speedAng = ang; }
                if (label) { speedLabel = label; }
                if (held()) { computeTargetOrKeys(); }
                paintStatus();
            },
            /* the robot's speed mode: 'slow' | 'moderate' | 'fast' */
            setSpeedKey: function (k) {
                speedKey = k || null;
                if (speedPend === k) { speedPend = null; }
                if (deck && speedKey) {
                    if (want !== null && levels[want].mode === speedKey) { applyLevel(want); want = null; }
                    else if (levels[level].mode !== speedKey) {
                        /* the robot is in another mode (a program, another
                           browser, the restart): the remembered level when it
                           is of this mode, else the mode's own level */
                        applyLevel(storedLevel !== null && levels[storedLevel].mode === speedKey ? storedLevel : defaultLevel(speedKey));
                    }
                }
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
                         speedKey: speedKey, level: level, want: want, capLin: speedLin, capAng: speedAng, owner: owner, takeover: takeover, keyboard: keyboardOn };
            }
        };
        function computeTargetOrKeys() { if (pid !== null) { computeTarget(); } else { fromKeys(); } }
        return api;
    }

    window.VTJoy = { create: create, _curve: curve, _shape: shape,
                     _const: { DEAD: DEAD, EXPO: EXPO, AXIS_DEG: AXIS_DEG, RATE_MS: RATE_MS,
                               STALE_MS: STALE_MS, DECAY: DECAY, STOP_REPEAT: STOP_REPEAT } };
})();
