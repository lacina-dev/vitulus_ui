/* vt_hw_reset.js — hard reset: everything but the power module off for N seconds.
 * No DOM, no ROS: tools/test_hw_reset.node.js runs it on a fake power module.
 *
 * The master has no such command, so this drives the power module directly, the way
 * sleep_manager.py does it. Firmware (powermodulev3_1 main.cpp check_sleep): W and T both
 * count from the arm, 19 V goes at W and comes back at T, so T = W + N, and the values must
 * be in the PM before the arm: they are read back through /pm/power_status first. W and T
 * stay in EEPROM, so they are put back when it is over. The NUC is off then: the page that
 * started it does that after it reconnects (the record is in localStorage). If no page
 * does, W stays 20 s until the master's next sleep writes its own, it always does.
 *
 * The master does not know of any of this. A sleep sequence of its own could rewrite T in
 * the moment between the read-back and the arm: the caller's busy() is asked up to the
 * arm and after it, anything there stops this. While armed the master starts nothing
 * (_pm_armed), and it adopts no flag it did not set.
 *
 * tick(inp) once a second, inp = { pm: { w_ms, t_ms, armed, fresh, online }, busy: code|null, link: bool }.
 */
(function (root) {
    'use strict';
    var W_MS = 20000, RETRY_MS = 3000, TRIES = 5, CUT_GRACE_MS = 10000, RECORD = 'vitulus_hw_reset', KEEP_MS = 3600000;
    var N_MIN = 30, N_MAX = 3600, N_DEFAULT = 60;

    function make(env) {
        var now = env.now, send = env.send, store = env.store;   // send: 'wait'|'time'|'arm'|'disarm', value
        var s = { phase: 'idle', result: null, n: 0, w0: 0, t0: 0, t: 0, tries: 0, next: 0, armedAt: 0, rec: null, cut: 0 };

        function reset(phase) { s.phase = phase; s.tries = 0; s.next = 0; }
        function due() {
            if (now() < s.next) { return false; }
            s.next = now() + RETRY_MS;
            s.tries += 1;
            return true;
        }
        function done(result) { s.result = result; s.at = now(); }
        function finish(result) {
            done(result);
            if (s.w0 || s.t0) { reset('restore'); } else { idle(); }
        }
        function idle() { reset('idle'); s.rec = null; store(null); }

        function start(n, pm) {
            s.n = n; s.w0 = pm.w_ms; s.t0 = pm.t_ms; s.t = W_MS + n * 1000; s.result = null;
            reset('params');
        }
        function cancel() {
            if (s.phase === 'params') { finish('cancelled'); return; }
            if (s.phase === 'arm' || s.phase === 'armed') { reset('cancelling'); }
        }
        function tick(inp) {
            var pm = inp.pm || {}, t = now();
            switch (s.phase) {
            case 'params':
                if (inp.busy) { finish('blocked:' + inp.busy); return; }
                if (pm.fresh && pm.w_ms === W_MS && pm.t_ms === s.t) { reset('arm'); tick(inp); return; }
                if (s.tries >= TRIES && t >= s.next) { finish('no_readback'); return; }
                if (due() && pm.fresh) { send('wait', W_MS); send('time', s.t); }
                return;
            case 'arm':
                if (pm.fresh && s.tries && pm.armed) {
                    s.armedAt = t;
                    s.rec = { n: s.n, w0: s.w0, t0: s.t0, cut: t + W_MS, back: t + s.t };
                    store(s.rec);
                    reset('armed');
                    return;
                }
                if (inp.busy) { reset('cancelling'); s.why = 'blocked:' + inp.busy; return; }
                /* read back once more: nobody wrote since */
                if (!pm.fresh || pm.w_ms !== W_MS || pm.t_ms !== s.t) { reset('cancelling'); s.why = 'no_readback'; return; }
                if (s.tries >= TRIES && t >= s.next) { reset('cancelling'); s.why = 'no_ack'; return; }
                if (due()) { send('arm'); }
                return;
            case 'armed':
                if (t < s.rec.cut) {
                    if (inp.busy) { reset('cancelling'); s.why = 'blocked:' + inp.busy; return; }
                    if (pm.fresh && !pm.armed) { finish('lost'); }
                    return;
                }
                if (!inp.link) { s.phase = 'gone'; s.cut = t; return; }
                /* past the cut and still talking: it did not happen */
                if (pm.fresh && t >= s.rec.cut + CUT_GRACE_MS) { reset('cancelling'); s.why = 'no_cut'; }
                return;
            case 'cancelling':
                if (pm.fresh && s.tries && !pm.armed) { var w = s.why || 'cancelled'; s.why = null; finish(w); return; }
                if (s.tries >= TRIES && t >= s.next) { s.why = null; done('cancel_unconfirmed'); idle(); return; }
                if (due()) { send('disarm'); }
                return;
            case 'gone':
                if (!inp.link || !pm.fresh) { return; }
                if (pm.armed) {         // a page reloaded before the cut
                    if (t < s.rec.cut) { s.phase = 'armed'; }
                    return;
                }
                s.w0 = s.rec.w0; s.t0 = s.rec.t0;
                s.away_s = s.cut && s.rec ? Math.round((t - s.cut) / 1000) : null;
                finish('back');
                return;
            case 'restore':
                if (!pm.fresh) { return; }
                if (pm.w_ms === s.w0 && pm.t_ms === s.t0) { s.w0 = s.t0 = 0; idle(); return; }
                if (s.tries >= TRIES && t >= s.next) { s.w0 = s.t0 = 0; idle(); return; }
                if (due()) { send('wait', s.w0); send('time', s.t0); }
                return;
            default:
                return;
            }
        }
        /* a page that opens after a reset it started */
        function resume(rec) {
            if (!rec || now() - rec.back > KEEP_MS) { store(null); return; }
            s.rec = rec; s.n = rec.n; s.w0 = 0; s.t0 = 0;
            s.phase = 'gone';
        }
        return { state: s, start: start, cancel: cancel, tick: tick, resume: resume,
                 left_s: function () { return s.rec ? Math.max(0, (s.rec.cut - now()) / 1000) : null; },
                 clearResult: function () { s.result = null; } };
    }

    root.VTHwReset = { make: make, W_MS: W_MS, N_MIN: N_MIN, N_MAX: N_MAX, N_DEFAULT: N_DEFAULT, RECORD: RECORD };
}(typeof window !== 'undefined' ? window : globalThis));
