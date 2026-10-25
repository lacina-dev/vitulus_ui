/* vt_joy.js — the on-screen joystick + keyboard drive of the robot UI.
 *
 * One component for touch, mouse and keyboard; ROS-agnostic: it only calls
 * opts.onCommand(lin, ang) — map_view.js turns that into /teleop/cmd_vel (the
 * human input of cmd_vel_mux), imu_calibration.js into a rotate-only command.
 *
 * Two shapes:
 *  - plain (IMU calibration, #joy_view_imu): status line + pad + readout;
 *  - DECK (the map's #joy_view, opts.deck): ONE round control, the RING
 *    (owner 2026-10-25, variant C2 "the whole ring"), in the foot of the
 *    right column (vt_frame.js); on a phone held upright a band (a short
 *    text left, the ring right):
 *
 *          Slow ·  Mid  · Fast              the robot's modes outside the segments (lit = reported)
 *        ▰▰▰▰▰▰▰ over the upper 2/3   [?]   7 speed segments: click / drag along /
 *           ( 0.25 m/s     )                wheel / arrows / + − keys
 *           ( SPEED · SLOW )                the capsule: the level and the mode
 *      (−)      ( pad )      (+)            the stick; its edge = the state; − / + on the seams
 *           [⚙]        [⌨]                  the lower 1/3: Motors / Keys (icons; colour = state)
 *
 *   the mode and the motors only ever show what the ROBOT reports
 *   (setSpeedKey / setMotors); a level of another mode / a motor click
 *   blinks until the robot echoes it (4 s, then it falls back to the
 *   reported state). A level inside the reported mode only changes the
 *   stick's cap (no message). Motors are never switched on by the page.
 *   The ring's geometry is built for its real size (CSS --vt-ring-d: 184 px
 *   on a PC, 150 px on a phone) and rebuilt when that changes.
 *
 * Feel (numbers in the constants below):
 *  - radial dead zone 10 %, then an expo curve (60 % cubic): fine control
 *    near the centre, full speed (of the active level's cap) at the rim;
 *  - axis lock: within ±9° of an axis the command is pure straight or pure
 *    rotate-on-the-spot (the locked axis lights up in the direction's colour);
 *  - acceleration cap (1.6 m/s², 6 rad/s²; slowing down 3× faster);
 *  - release = a short decay, not a hard jump: the first command after the
 *    release is 35 % of the last one, the next one (≤ 50 ms later) is ZERO,
 *    then two more zeros and silence; the knob springs back (CSS);
 *  - the pad's edge is the state: green = free, amber = a program / docking /
 *    the gamepad / the agent has the robot (stick locked, the reason is
 *    shown, "Take over" unlocks it on purpose), grey = drive motors off
 *    (stick locked) or unknown;
 *  - the command, playful (deck): the outer arc = speed (top = forward,
 *    cyan → green with strength; bottom = back, orange), the inner arc =
 *    turn (violet, to the turning side), width and length by the command,
 *    a glow; a coloured light under the knob in the driving direction, a
 *    halo round the knob, the arrows ▲▼◀▶ light up, a ripple on press;
 *    motors not on = the colours are dimmed;
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
    var MODES = ['slow', 'moderate', 'fast'];
    var LS_LEVEL = 'vitulus_joy_speed_level';
    var LS_INTRO = 'vitulus_joy_intro_seen';
    /* the ring (deck): colours of the command (the mock-up the owner chose) */
    var C_FWD0 = [13, 202, 240], C_FWD1 = [67, 213, 139];   // forward: cyan → green
    var C_BACK = '#ffab45', C_TURN = '#b18cff';             // back: orange, turn: violet
    var C_SLOW = [13, 202, 240], C_FAST = [255, 171, 69];   // speed: cool → warm
    var TRAVEL = 0.6;                                       // knob travel (× the pad radius)
    var DEG = Math.PI / 180;
    var uidN = 0;

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
    /* the ring's geometry: screen angles in radians (0 = right, clockwise) */
    function pol(cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    function fx(p) { return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }
    function rArc(cx, cy, r, a0, a1) {
        var large = (a1 - a0) > Math.PI ? 1 : 0;
        return 'M' + fx(pol(cx, cy, r, a0)) + ' A' + r.toFixed(2) + ' ' + r.toFixed(2) + ' 0 ' + large + ' 1 ' + fx(pol(cx, cy, r, a1));
    }
    function rSector(cx, cy, r0, r1, a0, a1) {
        var L = (a1 - a0) > Math.PI ? 1 : 0;
        return 'M' + fx(pol(cx, cy, r1, a0)) + ' A' + r1 + ' ' + r1 + ' 0 ' + L + ' 1 ' + fx(pol(cx, cy, r1, a1)) +
               ' L' + fx(pol(cx, cy, r0, a1)) + ' A' + r0 + ' ' + r0 + ' 0 ' + L + ' 0 ' + fx(pol(cx, cy, r0, a0)) + ' Z';
    }
    function mix(c0, c1, f) {
        f = clamp(f, 0, 1);
        return 'rgb(' + c0.map(function (v, k) { return Math.round(v + (c1[k] - v) * f); }).join(',') + ')';
    }
    function reducedMotion() {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }
    function coarsePointer() {
        try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
    }
    /* the drive motor (gear + bolt) and the keyboard: the same glyphs as the
       right panel's motor chip (right_dock.js), 16 × 16 */
    var ICON_MOT = '<path d="M8 3.2 9 1.5h-2l1 1.7Zm0 9.6-1 1.7h2l-1-1.7ZM3.2 8l-1.7-1v2l1.7-1Zm9.6 0 1.7 1v-2l-1.7 1ZM4.6 4.6 3.1 3.8l-.7.7.8 1.5 1.4-1.4Zm6.8 6.8 1.5.8.7-.7-.8-1.5-1.4 1.4Zm0-6.8 1.4 1.4.8-1.5-.7-.7-1.5.8ZM4.6 11.4l-1.4-1.4-.8 1.5.7.7 1.5-.8Z" fill="currentColor"/><circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.4 5.6 6.9 8.3h1.3l-.6 2.1 1.6-2.8H7.9l.5-2Z" fill="currentColor"/>';
    var ICON_KB = '<rect x="1" y="4" width="14" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.2 6.3h1.4M6.2 6.3h1.4M9.2 6.3h1.4M12.2 6.3h.8M3.2 8.6h1.4M6.2 8.6h3.8M11.2 8.6h1.8M4.2 10.8h7.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>';

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
        var hint, takeBtn, side, sideTip, ringBox, intro, introOk, preview = null;
        var svg = null, knob = null, arcLin = null, arcAng = null;
        var ring = null;                    // deck: the ring's SVG parts (buildRing)
        var padBox = root;
        if (deck) {
            /* phone upright: a short text left of the ring (CSS shows it) */
            side = el('div', 'vt-joy-side', root);
            var stt = el('div', 'vt-joy-side-t', side);
            tagI(stt, 'joy.d.intro.title');
            sideTip = el('div', 'vt-joy-side-tip', side);
            tagI(sideTip, 'joy.d.side');
            ringBox = el('div', 'vt-joy-ringbox', root);
            padBox = ringBox;
            /* the hint line: only what the ring cannot show (another owner,
               the DS4 pad, stale data); the same text = the pad's tooltip */
            hint = el('div', 'vt-joy-hint', root);
            hint.setAttribute('role', 'status');
            hint.setAttribute('aria-live', 'polite');
            hint.hidden = true;
            /* right_dock.js mirrors the motors' data-state (ok / warn / off) */
            chipMotors = el('span', 'vt-joy-motors', root);
            chipMotors.hidden = true;
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
            intro.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
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
        if (!deck) {
            /* the drawing: ticks, chevrons, the cap ring, the command arcs */
            svg = sv('svg', {'class': 'vt-joy-svg', viewBox: '-50 -50 100 100', 'aria-hidden': 'true'}, pad);
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
            arcLin = sv('path', {'class': 'vt-joy-arc vt-joy-arc-lin', d: ''}, svg);
            arcAng = sv('path', {'class': 'vt-joy-arc vt-joy-arc-ang', d: ''}, svg);
            knob = el('div', 'vt-joy-knob', pad);
        }
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

        /* ================================================== the RING (deck) */
        /* its diameter: CSS --vt-ring-d (vt_joy.css / vt_panel.css) */
        function ringSize() {
            var v = 0;
            try { v = parseFloat(getComputedStyle(root).getPropertyValue('--vt-ring-d')); } catch (e) { v = 0; }
            return (v > 80 && v < 400) ? Math.round(v) : 184;
        }
        function heat(i) {
            var f = levels.length > 1 ? i / (levels.length - 1) : 0;
            f = f * f * (3 - 2 * f);
            return mix(C_SLOW, C_FAST, f);
        }
        function ctl(parent, cls, k, labelKey) {
            var g = sv('g', {'class': cls, 'data-k': k, tabindex: 0, role: 'button', focusable: 'true'}, parent);
            if (labelKey) { g.setAttribute('aria-label', tr(labelKey)); }
            g.vtTitle = sv('title', {}, g);
            g.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
            return g;
        }
        function onActivate(g, fn) {
            g.addEventListener('click', function (e) { e.preventDefault(); fn(); });
            g.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) { fn(); } }
            });
        }
        function setTitle(g, t) { if (g.vtTitle.textContent !== t) { g.vtTitle.textContent = t; } }
        function buildRing(force) {
            var D = ringSize(), coarse = coarsePointer();
            if (ring && !force && ring.D === D && ring.coarse === coarse) { return; }
            var fk = null;
            if (ring && document.activeElement && ring.svg.contains(document.activeElement)) {
                fk = document.activeElement.getAttribute('data-k');
            }
            if (ring) { ring.svg.parentNode.removeChild(ring.svg); }
            uidN += 1;
            var u = 'vtr' + uidN + '_';
            var W = D + 8, H = D + 8, x0 = W / 2, y0 = H / 2, Rr = D / 2 - 2;
            var padR = Rr * 0.56, knobR = padR * 0.34, ringR = Rr - 16;   // the labels fit inside the bezel
            var g = {D: D, coarse: coarse, W: W, cx: x0, cy: y0, R: Rr, padR: padR, knobR: knobR, ringR: ringR};
            var s = sv('svg', {'class': 'vt-ring', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'group'});
            s.setAttribute('aria-label', tr('joy.d.ring'));
            g.svg = s;
            var defs = sv('defs', {}, s);
            var bz = sv('radialGradient', {id: u + 'bz', cx: '50%', cy: '38%', r: '62%'}, defs);
            sv('stop', {offset: '0', 'stop-color': '#3a444d'}, bz); sv('stop', {offset: '.7', 'stop-color': '#262e35'}, bz); sv('stop', {offset: '1', 'stop-color': '#1b2126'}, bz);
            var gl = sv('filter', {id: u + 'gl', x: '-30%', y: '-30%', width: '160%', height: '160%'}, defs);
            sv('feGaussianBlur', {stdDeviation: 2.2, result: 'b'}, gl);
            var fm = sv('feMerge', {}, gl); sv('feMergeNode', {'in': 'b'}, fm); sv('feMergeNode', {'in': 'SourceGraphic'}, fm);
            var gs = sv('radialGradient', {id: u + 'gs', cx: '50%', cy: '0%', r: '100%'}, defs);
            sv('stop', {offset: '0', 'stop-color': '#ffffff', 'stop-opacity': '.18'}, gs); sv('stop', {offset: '1', 'stop-color': '#ffffff', 'stop-opacity': '0'}, gs);
            var kg = sv('radialGradient', {id: u + 'kg', cx: '40%', cy: '35%'}, defs);
            sv('stop', {offset: '0', 'stop-color': '#5d6870'}, kg); sv('stop', {offset: '1', 'stop-color': '#3a434a'}, kg);
            var cp = sv('clipPath', {id: u + 'pc'}, defs); sv('circle', {cx: x0, cy: y0, r: padR * 0.82}, cp);
            var spg = sv('radialGradient', {id: u + 'sp'}, defs);
            g.sp0 = sv('stop', {offset: '0', 'stop-color': '#0dcaf0', 'stop-opacity': '0'}, spg);
            g.sp1 = sv('stop', {offset: '1', 'stop-color': '#0dcaf0', 'stop-opacity': '0'}, spg);
            var glow = 'url(#' + u + 'gl)';
            /* the bezel (lunette) with a soft light from above */
            sv('circle', {cx: x0, cy: y0 + 2, r: Rr, fill: '#0008', filter: glow, 'class': 'vt-ring-shadow'}, s);
            sv('circle', {cx: x0, cy: y0, r: Rr, fill: 'url(#' + u + 'bz)', 'class': 'vt-ring-bezel'}, s);
            sv('circle', {cx: x0, cy: y0, r: Rr - 1.5, fill: 'url(#' + u + 'gs)', 'pointer-events': 'none'}, s);
            /* the pad: its edge = the state (CSS --vt-ring by data-tone) */
            sv('circle', {'class': 'vt-ring-padbg', cx: x0, cy: y0, r: padR}, s);
            sv('circle', {'class': 'vt-ring-edge', cx: x0, cy: y0, r: padR - 1}, s);
            sv('circle', {'class': 'vt-ring-padin', cx: x0, cy: y0, r: padR * 0.82}, s);
            g.axV = sv('line', {'class': 'vt-ring-ax', x1: x0, y1: y0 - padR * 0.78, x2: x0, y2: y0 + padR * 0.78, filter: glow}, s);
            g.axH = sv('line', {'class': 'vt-ring-ax', x1: x0 - padR * 0.78, y1: y0, x2: x0 + padR * 0.78, y2: y0, filter: glow}, s);
            g.spot = sv('circle', {cx: x0, cy: y0, r: padR * 0.75, fill: 'url(#' + u + 'sp)', 'clip-path': 'url(#' + u + 'pc)', 'pointer-events': 'none'}, s);
            g.arcSp = sv('path', {'class': 'vt-ring-cmd', filter: glow}, s);
            g.arcTu = sv('path', {'class': 'vt-ring-cmd', filter: glow, stroke: C_TURN}, s);
            g.arr = {};
            [['▲', 0, -1, 'f'], ['▼', 0, 1, 'b'], ['◀', -1, 0, 'l'], ['▶', 1, 0, 'r']].forEach(function (a) {
                if (turnOnly && (a[3] === 'f' || a[3] === 'b')) { return; }
                var t = sv('text', {'class': 'vt-ring-arrow', x: x0 + a[1] * padR * 0.72, y: y0 + a[2] * padR * 0.72 + 3.5, 'text-anchor': 'middle'}, s);
                t.textContent = a[0];
                g.arr[a[3]] = t;
            });
            g.halo = sv('circle', {'class': 'vt-ring-halo', cx: x0, cy: y0, r: knobR + 3, filter: glow}, s);
            g.knob = sv('circle', {'class': 'vt-ring-knob', cx: x0, cy: y0, r: knobR, fill: 'url(#' + u + 'kg)'}, s);
            g.ripples = sv('g', {'pointer-events': 'none'}, s);

            /* ---- the speed ring (owner 2026-10-25, variant C2 "the whole
               ring"): the upper ~2/3 of the circle = 7 thick segments, lit up
               to the level (cool → warm), the level itself full and glowing;
               click a segment or drag along the ring (preview, picked on
               release), the wheel, the arrows while it has the focus */
            var A0 = 150 * DEG, A1 = 390 * DEG, span = A1 - A0, NL = levels.length;
            var thick = 12, gap = 2.2 * DEG;
            g.segA = function (k) { return A0 + span * (k + 0.5) / NL; };
            var spd = sv('g', {'class': 'vt-ring-spd', 'data-k': 'spd', tabindex: 0, role: 'slider', focusable: 'true',
                               'aria-valuemin': '1', 'aria-valuemax': String(NL)}, s);
            spd.setAttribute('aria-label', tr('joy.d.speed'));
            g.spd = spd;
            g.spdTitle = sv('title', {}, spd);
            sv('path', {'class': 'vt-ring-fr', d: rSector(x0, y0, ringR - thick / 2 - 2.5, ringR + thick / 2 + 2.5, A0 - 1 * DEG, A1 + 1 * DEG)}, spd);
            g.segs = [];
            for (var i = 0; i < NL; i++) {
                var b0 = A0 + span * i / NL + gap / 2, b1 = A0 + span * (i + 1) / NL - gap / 2;
                g.segs.push(sv('path', {'class': 'vt-ring-seg', d: rSector(x0, y0, ringR - thick / 2, ringR + thick / 2, b0, b1)}, spd));
            }
            g.glow = glow;
            var hit = sv('path', {'class': 'vt-ring-hit', d: rArc(x0, y0, ringR, A0, A1)}, spd);
            hit.style.strokeWidth = (thick + 10) + 'px';
            g.levelAt = function (ev) {
                var b = s.getBoundingClientRect(), k = W / (b.width || W);
                var x = (ev.clientX - b.left) * k - x0, y = (ev.clientY - b.top) * k - y0;
                var an = Math.atan2(y, x);
                while (an < A0 - 30 * DEG) { an += 2 * Math.PI; }
                return clamp(Math.floor((an - A0) / span * NL), 0, NL - 1);
            };
            /* the modes outside the segments: Slow · Mid · Fast (lit = the robot's) */
            g.lbls = {};
            MODES.forEach(function (m, mi) {
                var ix = [];
                levels.forEach(function (lv, j) { if (lv.mode === m) { ix.push(j); } });
                if (!ix.length) { return; }
                var am = A0 + span * ((ix[0] + ix[ix.length - 1] + 1) / 2 - 0.5) / NL;
                var id = u + 'mp' + mi;
                sv('path', {id: id, d: rArc(x0, y0, ringR + thick / 2 + 2, am - 25 * DEG, am + 25 * DEG), fill: 'none'}, defs);
                var t = sv('text', {'class': 'vt-ring-lbl', 'data-mode': m, 'text-anchor': 'middle'}, s);
                var tp = sv('textPath', {href: '#' + id, startOffset: '50%'}, t);
                tp.textContent = tr('joy.d.mode.' + m);
                t.vtTitle = sv('title', {}, t);
                t.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
                t.addEventListener('click', function () { chooseLevel(defaultLevel(m)); });
                g.lbls[m] = t;
            });
            /* − / + round buttons */
            var stepBtn = function (k, a, sym, labelKey) {
                var b = ctl(s, 'vt-ring-btn', k, labelKey);
                var p = pol(x0, y0, ringR, a);
                sv('circle', {'class': 'vt-ring-fr', cx: p[0], cy: p[1], r: 12.5}, b);
                sv('circle', {'class': 'vt-ring-btnbg', cx: p[0], cy: p[1], r: 10}, b);
                var path = sym === '+' ? 'M-4 0h8M0 -4v8' : 'M-4 0h8';
                sv('path', {'class': 'vt-ring-btnsym', d: path, transform: 'translate(' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + ')'}, b);
                return b;
            };
            /* on the seams between the segments and the bottom sectors */
            g.minus = stepBtn('minus', A0 - 6 * DEG, '−', 'joy.d.slower');
            g.plus = stepBtn('plus', A1 + 6 * DEG, '+', 'joy.d.faster');
            onActivate(g.minus, function () { stepLevel(-1); });
            onActivate(g.plus, function () { stepLevel(1); });
            /* the gap at the bottom: Motors (right), Keys (left; not on touch) */
            var c0 = A1 + 16 * DEG - 2 * Math.PI, c1 = A0 - 16 * DEG, mid = (c0 + c1) / 2;
            var sector = function (k, sa0, sa1, icon, labelKey) {
                var b = ctl(s, 'vt-ring-sect', k, labelKey);
                var d = rSector(x0, y0, padR + 3, Rr, sa0, sa1);
                sv('path', {'class': 'vt-ring-fr', d: d}, b);
                sv('path', {'class': 'vt-ring-sectbg', d: d}, b);
                var am = (sa0 + sa1) / 2, rm = (padR + Rr) / 2 + 1, lp = pol(x0, y0, rm, am);
                /* owner 2026-10-25: icons only — the colour is the state, the
                   words are in aria-label / the tooltip and the "?" card */
                var isz = D >= 170 ? 18 : 16;
                var ic = sv('svg', {'class': 'vt-ring-ico', x: (lp[0] - isz / 2).toFixed(2), y: (lp[1] - isz / 2).toFixed(2), width: isz, height: isz, viewBox: '0 0 16 16'}, b);
                ic.innerHTML = icon;
                return b;
            };
            if (coarse) {
                g.mot = sector('mot', c0, c1, ICON_MOT, null);
                g.kb = null;
            } else {
                g.mot = sector('mot', c0, mid - 1.5 * DEG, ICON_MOT, null);
                g.kb = sector('kb', mid + 1.5 * DEG, c1, ICON_KB, 'joy.kb.lbl');
                onActivate(g.kb, function () {
                    api.setKeyboard(!keyboardOn);
                    if (opts.onKeyboard) { opts.onKeyboard(keyboardOn); }
                });
            }
            onActivate(g.mot, function () {
                if (!opts.onMotors || motors === null) { return; }   // unknown: nothing to toggle
                var wantOn = !motors;
                if (!wantOn) { hardStop(); }
                motorPend = wantOn; motorPendT = Date.now();
                opts.onMotors(wantOn);
                paintStatus();
            });
            /* the capsule above the pad: "0.25 m/s · SPEED · SLOW" */
            var capH = 22;
            g.capY = y0 - padR - 14;
            g.cap = sv('rect', {'class': 'vt-ring-cap', x: x0 - 32, y: g.capY, width: 64, height: capH, rx: capH / 2}, s);
            g.capV = sv('text', {'class': 'vt-ring-capv', x: x0, y: g.capY + 10.5, 'text-anchor': 'middle'}, s);
            g.capU = sv('text', {'class': 'vt-ring-capu', x: x0, y: g.capY + 18.5, 'text-anchor': 'middle'}, s);
            /* ? in the corner: the card "Driving by hand" */
            g.help = ctl(s, 'vt-ring-btn vt-ring-q', 'help', 'joy.d.help.tip');
            var qx = x0 + Rr - 7, qy = y0 - Rr + 7;
            sv('circle', {'class': 'vt-ring-fr', cx: qx, cy: qy, r: 10.5}, g.help);
            sv('circle', {'class': 'vt-ring-qbg', cx: qx, cy: qy, r: 8}, g.help);
            var qt = sv('text', {'class': 'vt-ring-qt', x: qx, y: qy + 3.6, 'text-anchor': 'middle'}, g.help);
            qt.textContent = '?';
            setTitle(g.help, tr('joy.d.help.tip'));
            onActivate(g.help, function () { intro.hidden = !intro.hidden; if (!intro.hidden) { introOk.focus(); } });

            /* ---- slider input: drag / click (preview, picked on release),
               the wheel, the keys while it has the focus */
            var barPid = null;
            hit.addEventListener('pointerdown', function (e) {
                e.stopPropagation();
                if (barPid !== null) { return; }
                if (e.pointerType === 'mouse' && e.button !== 0) { return; }
                e.preventDefault();
                barPid = e.pointerId;
                try { hit.setPointerCapture(barPid); } catch (err) { /* old browser */ }
                preview = g.levelAt(e);
                paintStatus();
            });
            hit.addEventListener('pointermove', function (e) {
                if (e.pointerId !== barPid) { return; }
                var p = g.levelAt(e);
                if (p !== preview) { preview = p; buzz(3); paintStatus(); }
            });
            var barEnd = function (e) {
                if (e.pointerId !== barPid) { return; }
                barPid = null;
                var p = preview;
                preview = null;
                if (e.type === 'pointerup' && p !== null) { chooseLevel(p); } else { paintStatus(); }
            };
            hit.addEventListener('pointerup', barEnd);
            hit.addEventListener('pointercancel', barEnd);
            hit.addEventListener('lostpointercapture', function (e) { if (e.pointerId === barPid) { barPid = null; preview = null; paintStatus(); } });
            var wheelAt = 0;
            spd.addEventListener('wheel', function (e) {
                e.preventDefault();
                var now = Date.now();
                if (now - wheelAt < 180 || !e.deltaY) { return; }   // one notch = one step
                wheelAt = now;
                stepLevel(e.deltaY < 0 ? 1 : -1);
            }, {passive: false});
            spd.addEventListener('keydown', function (e) {
                var d = {ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 1, PageDown: -1}[e.key];
                if (e.key === 'Home') { d = -99; } else if (e.key === 'End') { d = 99; }
                var n = /^[1-9]$/.test(e.key) ? parseInt(e.key, 10) : 0;
                if (!d && !(n && n <= levels.length)) { return; }
                e.preventDefault();
                e.stopPropagation();            // the slider's arrows never drive
                if (n) { chooseLevel(n - 1); } else { stepLevel(d); }
            });

            ringBox.insertBefore(s, pad);
            ringBox.style.width = W + 'px';
            ringBox.style.height = H + 'px';
            pad.style.left = (x0 - padR).toFixed(1) + 'px';
            pad.style.top = (y0 - padR).toFixed(1) + 'px';
            pad.style.width = pad.style.height = (2 * padR).toFixed(1) + 'px';
            ring = g;
            ringStatic();
            ringFx();
            if (fk) { var f = s.querySelector('[data-k="' + fk + '"]'); if (f) { f.focus({preventScroll: true}); } }
        }
        /* speed, modes, buttons, capsule — what changes with the state */
        function ringStatic() {
            var g = ring;
            if (!g) { return; }
            var shown = preview !== null ? preview : level;
            g.segs.forEach(function (p, i) {
                var on = i <= shown;
                p.setAttribute('fill', on ? heat(i) : '#343e46');
                p.setAttribute('fill-opacity', on ? (i === shown ? 1 : 0.78) : 1);
                if (i === shown) { p.setAttribute('filter', g.glow); } else { p.removeAttribute('filter'); }
                p.classList.toggle('want', want !== null && i === want && i !== shown);
            });
            g.spd.classList.toggle('pend', want !== null);
            var showMode = preview !== null ? levels[preview].mode : speedKey;
            var mtxt = showMode ? tr('joy.d.mode.' + showMode) : '?';
            Object.keys(g.lbls).forEach(function (m) {
                var t = g.lbls[m];
                t.classList.toggle('on', speedKey === m);
                t.classList.toggle('pend', want !== null && levels[want].mode === m && speedKey !== m);
                var tp = t.firstChild, word = tr('joy.d.mode.' + m);
                if (tp.textContent !== word) { tp.textContent = word; }
                var tt = tr('joy.d.band.tip', {mode: word, v: navSpeed(m).toFixed(2)});
                if (t.vtTitle.textContent !== tt) { t.vtTitle.textContent = tt; }
            });
            var lv = levels[shown];
            var vtxt = lv.lin.toFixed(2) + ' m/s';
            g.spd.setAttribute('aria-valuenow', String(shown + 1));
            g.spd.setAttribute('aria-valuetext', vtxt + ', ' + mtxt);
            var bt = tr('joy.d.bar.tip', {v: vtxt, a: lv.ang.toFixed(1), mode: mtxt});
            if (g.spdTitle.textContent !== bt) { g.spdTitle.textContent = bt; }
            var cur = want !== null ? want : level;
            [[g.minus, cur <= 0], [g.plus, cur >= levels.length - 1]].forEach(function (x) {
                x[0].classList.toggle('dis', x[1]);
                x[0].setAttribute('aria-disabled', x[1] ? 'true' : 'false');
            });
            /* the capsule: value + "SPEED · MODE", as wide as its text */
            if (g.capV.textContent !== vtxt) { g.capV.textContent = vtxt; }
            var ut = (tr('joy.d.speed') + ' · ' + mtxt).toUpperCase();
            if (g.capU.textContent !== ut) { g.capU.textContent = ut; }
            var tw = 0;
            try { tw = Math.max(g.capV.getComputedTextLength(), g.capU.getComputedTextLength()); } catch (e) { tw = 0; }
            if (!tw) { tw = ut.length * 4.9; }
            var cw = Math.min(g.padR * 2 + 16, Math.max(56, tw + 16));
            g.cap.setAttribute('x', (g.cx - cw / 2).toFixed(2));
            g.cap.setAttribute('width', cw.toFixed(2));
            g.cap.setAttribute('stroke', heat(shown));
            /* keys */
            if (g.kb) {
                g.kb.classList.toggle('on', keyboardOn);
                g.kb.setAttribute('aria-pressed', keyboardOn ? 'true' : 'false');
                g.kb.setAttribute('aria-label', tr('joy.kb.lbl') + ' ' + tr(keyboardOn ? 'joy.mot.on' : 'joy.mot.off'));
                setTitle(g.kb, tr('joy.d.kb.tip'));
            }
            /* motors: the robot's state; a click blinks until the echo */
            var mk = motors === true ? 'on' : (motors === false ? 'off' : 'unknown');
            g.mot.setAttribute('data-state', mk);
            g.mot.classList.toggle('pend', motorPend !== null && motorPend !== motors);
            g.mot.setAttribute('aria-pressed', motors === true ? 'true' : 'false');
            g.mot.setAttribute('aria-disabled', motors === null ? 'true' : 'false');
            var ml = tr('joy.d.mot.' + mk);
            g.mot.setAttribute('aria-label', ml);
            setTitle(g.mot, tr(motors === true ? 'joy.motors.off_tip' : (motors === false ? 'joy.motors.on_tip' : 'joy.motors.unknown_tip')));
        }
        /* the command, drawn: knob, light, halo, arcs, arrows, axis lock */
        function ringFx() {
            var g = ring;
            if (!g) { return; }
            var dim = motors === true ? 1 : 0.45;
            var mag = Math.min(1, Math.hypot(nx, ny));
            var fl = speedLin > 0 ? clamp(Math.abs(oLin) / speedLin, 0, 1) : 0;
            var fa = speedAng > 0 ? clamp(Math.abs(oAng) / speedAng, 0, 1) : 0;
            var fwd = mix(C_FWD0, C_FWD1, Math.max(fl, Math.max(0, ny)));
            var dirCol = ny < -0.02 ? C_BACK : (Math.abs(nx) > Math.abs(ny) ? C_TURN : fwd);
            var T = g.padR * TRAVEL;
            var tf = 'translate(' + (nx * T).toFixed(1) + 'px,' + (-ny * T).toFixed(1) + 'px)';
            g.knob.style.transform = tf;
            g.halo.style.transform = tf;
            g.halo.setAttribute('stroke', dirCol);
            g.halo.setAttribute('r', (g.knobR + 3 + mag * 4).toFixed(2));
            g.halo.setAttribute('opacity', ((mag > 0.02 ? 0.35 + mag * 0.65 : 0) * dim).toFixed(3));
            g.spot.setAttribute('cx', (g.cx + nx * T).toFixed(1));
            g.spot.setAttribute('cy', (g.cy - ny * T).toFixed(1));
            g.sp0.setAttribute('stop-color', dirCol);
            g.sp1.setAttribute('stop-color', dirCol);
            g.sp0.setAttribute('stop-opacity', (mag * 0.55 * dim).toFixed(3));
            /* outer arc = speed: top forward, bottom back */
            var c = oLin < 0 ? 90 * DEG : -90 * DEG, w = fl * 80 * DEG;
            g.arcSp.setAttribute('stroke', oLin < 0 ? C_BACK : fwd);
            g.arcSp.setAttribute('stroke-width', (3 + fl * 4).toFixed(2));
            g.arcSp.setAttribute('opacity', dim);
            g.arcSp.setAttribute('d', fl > 0.005 ? rArc(g.cx, g.cy, g.padR * 0.92, c - w, c + w) : '');
            /* inner arc = turn, from the top to the turning side (right = −z) */
            var t0 = -90 * DEG, t1 = t0 + (oAng < 0 ? 1 : -1) * fa * 90 * DEG;
            g.arcTu.setAttribute('stroke-width', (2.5 + fa * 3).toFixed(2));
            g.arcTu.setAttribute('opacity', dim);
            g.arcTu.setAttribute('d', fa > 0.005 ? rArc(g.cx, g.cy, g.padR * 0.74, Math.min(t0, t1), Math.max(t0, t1)) : '');
            /* the arrows light up in the direction's colour */
            var lit = {f: Math.max(0, ny), b: Math.max(0, -ny), r: Math.max(0, nx), l: Math.max(0, -nx)};
            Object.keys(g.arr).forEach(function (k) {
                var v = lit[k], on = v > 0.05;
                g.arr[k].setAttribute('fill', on ? (k === 'f' ? fwd : (k === 'b' ? C_BACK : C_TURN)) : '#6f7a83');
                g.arr[k].setAttribute('opacity', on ? ((0.5 + v * 0.5) * (motors === true ? 1 : 0.7)).toFixed(3) : 1);
            });
            /* the locked axis lights up in the direction's colour */
            var lk = held() ? lastLock : '';
            g.axV.setAttribute('stroke', ny < 0 ? C_BACK : fwd);
            g.axV.setAttribute('opacity', lk === 'v' ? (0.95 * dim).toFixed(3) : 0);
            g.axH.setAttribute('stroke', C_TURN);
            g.axH.setAttribute('opacity', lk === 'h' ? (0.95 * dim).toFixed(3) : 0);
        }
        function ripple(e) {
            var g = ring;
            if (!g || reducedMotion()) { return; }
            var b = g.svg.getBoundingClientRect(), k = g.W / (b.width || g.W);
            var rp = sv('circle', {'class': 'vt-ring-ripple', cx: ((e.clientX - b.left) * k).toFixed(1), cy: ((e.clientY - b.top) * k).toFixed(1), r: 6,
                                   stroke: lockReason() ? '#9fb0ba' : (motors === true ? '#7ff0c0' : '#9fb0ba')}, g.ripples);
            setTimeout(function () { if (rp.parentNode) { rp.parentNode.removeChild(rp); } }, 600);
        }

        function paintStatus() {
            var now = Date.now();
            if (speedPend && now - speedPendT > PENDING_MS) { speedPend = null; }
            if (motorPend !== null && now - motorPendT > PENDING_MS) { motorPend = null; }
            var ms = motors === true ? 'ok' : (motors === false ? 'warn' : 'off');
            chipMotors.setAttribute('data-state', ms);
            root.classList.toggle('vt-joy-nomotors', motors === false);
            root.classList.toggle('vt-joy-dim', motors !== true);
            root.setAttribute('data-tone', tone());
            var lr = lockReason();
            root.classList.toggle('vt-joy-locked', !!lr);
            // the word in the pad only when someone else holds the robot; a
            // grey edge already says "motors off" (owner: colour, not text)
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
            /* the line shows only what the ring cannot (stale data, DS4,
               another owner); motors and "free" stay in the pad's tooltip */
            var rare = !!(staleNote || lr === 'ds4' || lr === 'owner' || (owner && takeover));
            var shown = rare ? h : '';
            if (hint.textContent !== shown) { hint.textContent = shown; }
            hint.hidden = !rare;
            sideTip.hidden = rare;              // phone band: the hint takes the tip's place
            if (pad.title !== h) { pad.title = h; }
            hint.setAttribute('data-tone', tone());
            takeBtn.hidden = lr !== 'owner';
            if (want !== null && now - wantT > PENDING_MS) { want = null; }
            ringStatic();
            ringFx();
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
        /* a person picked level i (arc, − / +, keys) */
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
            if (deck) { ringFx(); return; }
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
            if (knob) {
                var kx = nx * R, ky = -ny * R;
                knob.style.transform = 'translate(' + kx.toFixed(1) + 'px,' + ky.toFixed(1) + 'px)';
            }
            pad.style.setProperty('--vt-joy-mag', r.toFixed(3));
            var active = held();
            root.setAttribute('data-state', active ? (motors === false ? 'warn' : 'info') : 'off');
            root.classList.toggle('vt-joy-live', active && r > DEAD);
            root.classList.toggle('vt-joy-held', pid !== null);
            var lk = active ? lastLock : '';
            root.classList.toggle('vt-joy-lock-v', lk === 'v');
            root.classList.toggle('vt-joy-lock-h', lk === 'h');
            pad.setAttribute('aria-valuetext', active ? tr('joy.value', {lin: oLin.toFixed(2), ang: oAng.toFixed(2)}) : tr('joy.stopped'));
            if (deck) { ringFx(); }
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
            if (deck) { R = Math.max(10, b.width / 2 * TRAVEL); }
            else { R = Math.max(10, b.width / 2 - knob.offsetWidth / 2 - 2); }
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
            if (deck) { ripple(e); }
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

        /* ---- keyboard: the same command path */
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

        /* ---- anything that takes the hand away stops the robot at once */
        window.addEventListener('blur', function () { if (phase !== 'idle' || held()) { hardStop(); } });
        document.addEventListener('visibilitychange', function () { if (document.hidden) { hardStop(); } });
        window.addEventListener('pagehide', function () { hardStop(); });

        /* ---- deck controls */
        if (deck) {
            introOk.addEventListener('click', function () {
                intro.hidden = true; introSeen = true;
                try { localStorage.setItem(LS_INTRO, '1'); } catch (e) { /* ignore */ }
            });
            takeBtn.addEventListener('click', function () {
                takeover = true;
                buzz(10);
                paintStatus(); paintStick();
            });
            buildRing(true);
            /* the ring's size follows the frame (PC 184 px, phone 150 px) */
            var sizeT = null;
            window.addEventListener('resize', function () {
                if (sizeT) { clearTimeout(sizeT); }
                sizeT = setTimeout(function () { sizeT = null; buildRing(false); }, 80);
            });
            setInterval(function () {
                buildRing(false);
                if (want !== null || motorPend !== null || (!introSeen && intro.hidden)) { paintStatus(); }
            }, 1000);
        }

        paintStatus(); paintRead(); paintStick();
        if (window.VTI18n) { VTI18n.onChange(function () { if (deck) { buildRing(true); } paintStatus(); paintStick(); }); }

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
                         speedKey: speedKey, level: level, want: want, capLin: speedLin, capAng: speedAng, owner: owner, takeover: takeover, keyboard: keyboardOn,
                         ring: ring ? ring.D : 0 };
            }
        };
        function computeTargetOrKeys() { if (pid !== null) { computeTarget(); } else { fromKeys(); } }
        return api;
    }

    window.VTJoy = { create: create, _curve: curve, _shape: shape,
                     _const: { DEAD: DEAD, EXPO: EXPO, AXIS_DEG: AXIS_DEG, RATE_MS: RATE_MS,
                               STALE_MS: STALE_MS, DECAY: DECAY, STOP_REPEAT: STOP_REPEAT } };
})();
