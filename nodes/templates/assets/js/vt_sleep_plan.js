/* vt_sleep_plan.js — what master_controller will do about sleeping, worked out from
 * what it publishes. No DOM, no ROS: tools/test_sleep_plan.node.js runs it as it is.
 *
 * The master does not publish its plan (a countdown carries no duration, the limits
 * are yaml parameters), so this file repeats its arithmetic. Keep it equal to:
 *   sleep_manager.py  plan_timed_ms
 *   master_controller _handle_idle, _sleep_until_window, _sleep_now, _execute_sleep,
 *                     _tick_sleep_requests (ms after the countdown)
 * When the master publishes ms, wake_at and its limits, delete the copies here.
 *
 * Times are ms since the epoch, durations in seconds unless the name says ms.
 */
(function (root) {
    'use strict';

    /* yaml defaults of master_controller.yaml, used until rosapi answers */
    var DEFAULTS = { wait_s: 180, off_s: 120, min_s: 900, seg_s: 43200, drift: 0.005,
                     countdown_s: 60, cooldown_s: 1800, boot_s: 300, check_s: 30, from_robot: false };

    /* rosparam of /master_controller -> field of limits */
    var PARAMS = {
        sleep_wait_before_standby_s: 'wait_s', sleep_min_off_s: 'off_s', sleep_min_s: 'min_s',
        sleep_timer_drift: 'drift', sleep_countdown_s: 'countdown_s',
        sleep_fail_cooldown_s: 'cooldown_s', boot_grace_period_s: 'boot_s', check_interval_s: 'check_s'
    };

    function limits(params) {
        var L = {}, k;
        for (k in DEFAULTS) { L[k] = DEFAULTS[k]; }
        if (!params) { return L; }
        Object.keys(PARAMS).forEach(function (p) {
            if (typeof params[p] === 'number') { L[PARAMS[p]] = params[p]; L.from_robot = true; }
        });
        if (typeof params.sleep_max_segment_h === 'number') {
            L.seg_s = params.sleep_max_segment_h * 3600;
            L.from_robot = true;
        }
        return L;
    }

    function floorS(L) { return Math.max(L.min_s, L.wait_s + L.off_s); }

    /* plan_timed_ms: what goes to the power module, or null = refused too_short */
    function pmMs(durS, L) {
        var seg = Math.min(durS, L.seg_s) * (1 - L.drift);
        return seg < floorS(L) ? null : Math.floor(seg * 1000);
    }

    /* the shortest whole number of minutes the master accepts: 15 min is refused,
       the clock margin makes it 14.9 */
    function minManualMin(L) {
        return Math.ceil(floorS(L) / (1 - L.drift) / 60 - 1e-9);
    }
    function maxManualMin(L) { return Math.round(L.seg_s / 60); }

    /* the master's ms after a countdown: _tick_sleep_requests keeps the wake in place */
    function afterCountdownMs(ms, cdS) { return Math.max(ms - Math.round(cdS * 1000), Math.floor(ms / 2)); }

    function leadS(values) {
        return (values && typeof values.wake_before_min === 'number' ? values.wake_before_min : 12) * 60;
    }

    /* The timed sequence from the moment of the command (t0).
       wake counts from the arm, the power goes W after it. */
    function shape(t0, ms, cdS, L) {
        var go = t0 + cdS * 1000;
        var real = cdS > 0 ? afterCountdownMs(ms, cdS) : ms;
        var wake = go + real;
        var cut = go + L.wait_s * 1000;
        return { go: go, cut: cut, wake: wake, ms: real, off_s: Math.max(0, (wake - cut) / 1000) };
    }

    function parseLocal(iso) {
        var d = iso ? new Date(iso) : null;
        return (d && !isNaN(d.getTime())) ? d.getTime() : null;
    }

    /* The next start that _sleep_now caps a sleep at; null = it does not cap */
    function capSlot(rep, now, values) {
        if (!rep || !rep.enabled || rep.held || !rep.next) { return null; }
        var at = parseLocal(rep.next.at);
        if (at === null) { return null; }
        return { at: at, program: rep.next.program, wake: at - leadS(values) * 1000 };
    }

    /* "Sleep now" for that many minutes, before it is sent.
       ctx: { now, rep, values, L, countdown: s of the announcement (0 = none) }
       -> { ok, code, wanted_s, slot, capped, cap: shape, ... } */
    function manual(minutes, ctx) {
        var L = ctx.L, rep = ctx.rep, wanted = minutes * 60;
        var out = { ok: true, code: null, wanted_s: wanted, min_min: minManualMin(L), slot: null,
                    capped: false, segmented: wanted > L.seg_s };
        var slot = capSlot(rep, ctx.now, ctx.values);
        var dur = wanted;
        if (slot) {
            var cap = (slot.wake - ctx.now) / 1000;
            if (cap < wanted) {
                out.slot = slot;
                out.capped = true;
                dur = cap;
            }
        }
        var ms = pmMs(dur, L);
        if (ms === null) {
            out.ok = false;
            out.code = 'too_short';
            /* with a start ahead, the same request without the cap */
            if (out.capped && pmMs(wanted, L) !== null) { out.code = 'too_short_slot'; }
            out.dur_s = dur;
            return out;
        }
        var s = shape(ctx.now, ms, ctx.countdown || 0, L);
        out.cut = s.cut; out.wake = s.wake; out.ms = ms; out.off_s = s.off_s;
        return out;
    }

    /* the same request without the cap: what skipping the start would give */
    function uncapped(minutes, ctx) {
        var ms = pmMs(minutes * 60, ctx.L);
        if (ms === null) { return null; }
        var s = shape(ctx.now, ms, ctx.countdown || 0, ctx.L);
        return { cut: s.cut, wake: s.wake, ms: ms, off_s: s.off_s };
    }

    function hhmm(s) {
        var p = String(s || '').split(':');
        return p.length < 2 ? null : Number(p[0]) * 60 + Number(p[1]);
    }

    function inWindow(now, w) {
        var d = new Date(now), m = d.getHours() * 60 + d.getMinutes();
        var a = hhmm(w.start), b = hhmm(w.end);
        return a <= b ? (m >= a && m <= b) : (m >= a || m <= b);
    }

    function nextOpening(now, w) {
        var d = new Date(now), a = hhmm(w.start);
        var c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(a / 60), a % 60, 0, 0).getTime();
        if (c <= now) {
            var n = new Date(c);
            n.setDate(n.getDate() + 1);
            c = n.getTime();
        }
        return c;
    }

    /* What holds it awake: checks of report.sleep, without the ones that say nothing. */
    function holds(sl, now, reportAt) {
        var age = reportAt ? Math.max(0, (now - reportAt) / 1000) : 0;
        var out = { timed: [], open: [], ready_s: 0, cancelled_until: null, failed: null };
        ((sl && sl.checks) || []).forEach(function (c) {
            if (c.state !== 'block' && c.state !== 'wait') { return; }
            var v = c.vars || {};
            var left = null;
            if (typeof v.left_s === 'number') { left = Math.max(0, v.left_s - age); }
            else if (v.until) {
                var u = parseLocal(v.until);
                if (u !== null) { left = Math.max(0, (u - now) / 1000); }
            }
            if (c.key === 'reason' && c.code === 'countdown_cancelled' && left !== null) {
                out.cancelled_until = now + left * 1000;
            } else if (c.key === 'reason' && left !== null) {
                out.failed = c.code;
            }
            if (left === null) { out.open.push(c); return; }
            out.timed.push(c);
            out.ready_s = Math.max(out.ready_s, left);
        });
        return out;
    }

    /* people the coming sleep will cut, so that the master counts down first */
    function ignored(sl) {
        var who = 0;
        ((sl && sl.checks) || []).forEach(function (c) {
            if ((c.key === 'ssh' || c.key === 'ui') && c.code === 'ignored') {
                who += c.key === 'ui' ? (c.vars.n || 0) : (c.vars.who || []).length;
            }
        });
        return who;
    }

    /* The sleep the idle logic is heading for, at time now. Refusals by name. */
    function idleTarget(rep, values, L, now) {
        var next = rep.next;
        if (!next) { return { none: 'no_schedule' }; }
        var at = parseLocal(next.at);
        if (at === null) { return { none: 'no_schedule' }; }
        var lead = leadS(values);
        var idle = (typeof values.idle_sleep_threshold_min === 'number' ? values.idle_sleep_threshold_min : 20) * 60;
        var want, why = 'slot';
        var w = rep.window;
        if (w && !inWindow(now, w)) {
            want = (nextOpening(now, w) - now) / 1000 - lead;
            why = 'window';
            if (want < idle) { return { none: 'start_close', at: at }; }
        } else {
            if ((at - now) / 1000 <= idle) { return { none: 'start_close', at: at }; }
            want = (at - now) / 1000 - lead;
        }
        return { want_s: want, why: why, program: next.program, at: at };
    }

    /* ctx: { now, rep, values, L, countdown (topic), cd_at, ask (Sleep now under way), report_at }
       -> { kind: 'sequence'|'countdown'|'soon'|'blocked'|'none'|'unknown', ... } */
    function auto(ctx) {
        var rep = ctx.rep, L = ctx.L, now = ctx.now, values = ctx.values || {};
        if (!rep) { return { kind: 'unknown' }; }
        var sl = rep.sleep || {};
        var cd = ctx.countdown;

        /* a sleep under way: its numbers are the master's own */
        if (sl.state && sl.state !== 'IDLE' && sl.state !== 'ABORT') {
            var wake = parseLocal(sl.next_wake);
            return { kind: 'sequence', mode: sl.mode, state: sl.state, wake: wake,
                     off_s: sl.sleep_ms ? Math.max(0, sl.sleep_ms / 1000 - L.wait_s) : null,
                     cancellable: !!(cd && cd.active) || sl.state !== 'WAIT_CUT' };
        }

        var h = holds(sl, now, ctx.report_at);

        if (cd && cd.active && cd.phase !== 'sequence') {
            var t0 = ctx.cd_at || now;
            var left = Math.max(0, cd.left_s - (now - t0) / 1000);
            var out = { kind: 'countdown', source: cd.reason, left_s: left, who: cd.who || {}, mode: cd.mode };
            var start = now + left * 1000;
            if (cd.mode === 'charged') { out.cut = start + L.wait_s * 1000; return out; }
            if (ctx.ask && ctx.ask.wake && cd.reason === 'manual') {
                out.cut = ctx.ask.cut; out.wake = ctx.ask.wake; out.off_s = ctx.ask.off_s;
                return out;
            }
            /* the master took ms when the countdown began */
            var begin = start - L.countdown_s * 1000;
            var idl = idleTarget(rep, values, L, begin);
            var msa = idl.none ? null : pmMs(idl.want_s, L);
            if (msa !== null) {
                var sa = shape(begin, msa, L.countdown_s, L);
                out.cut = sa.cut; out.wake = sa.wake; out.off_s = sa.off_s;
            }
            return out;
        }

        if (!rep.enabled) { return { kind: 'none', why: 'automation_off' }; }
        if (values.sleep_enabled === false) { return { kind: 'none', why: 'sleep_off' }; }
        if (rep.held) { return { kind: 'none', why: 'held' }; }
        if (rep.run) { return { kind: 'none', why: 'run' }; }
        if (rep.state && rep.state !== 'IDLE') { return { kind: 'none', why: 'state' }; }
        if (/^blocked_pm_armed$/.test(rep.code || '')) { return { kind: 'none', why: 'raw' }; }

        var cdS = ignored(sl) > 0 ? L.countdown_s : 0;
        var at0 = now + h.ready_s * 1000;
        var tgt = idleTarget(rep, values, L, at0);
        if (tgt.none) { return { kind: 'none', why: tgt.none, at: tgt.at, holds: h }; }
        var ms = pmMs(tgt.want_s, L);
        if (ms === null) {
            return { kind: 'none', why: 'too_short', at: tgt.at, want_s: tgt.want_s, floor_s: floorS(L), holds: h };
        }
        var s = shape(at0, ms, cdS, L);
        var res = { kind: h.open.length ? 'blocked' : 'soon', why: tgt.why, program: tgt.program, start: tgt.at,
                    go: s.go, cut: s.cut, wake: s.wake, off_s: s.off_s, countdown_s: cdS,
                    holds: h, ignored: ignored(sl), maybe: values.sleep_after_run === false };
        return res;
    }

    /* The sleep that switching on an "ignore" would start, as if nothing else held it. */
    function ifIgnored(ctx, key) {
        var rep = ctx.rep;
        if (!rep || !rep.sleep) { return null; }
        var r = JSON.parse(JSON.stringify(rep));
        var who = 0;
        r.sleep.checks = (r.sleep.checks || []).map(function (c) {
            if (c.key === key && c.state === 'block') {
                who = key === 'ui' ? (c.vars.n || 0) : (c.vars.who || []).length;
                return { key: c.key, state: 'off', code: 'ignored', vars: c.vars };
            }
            return c;
        });
        var p = auto({ now: ctx.now, rep: r, values: ctx.values, L: ctx.L, report_at: ctx.report_at });
        p.people = who;
        return p;
    }

    root.VTSleepPlan = { limits: limits, floorS: floorS, pmMs: pmMs, minManualMin: minManualMin,
                         maxManualMin: maxManualMin, afterCountdownMs: afterCountdownMs, manual: manual,
                         uncapped: uncapped, auto: auto, ifIgnored: ifIgnored, holds: holds, leadS: leadS,
                         DEFAULTS: DEFAULTS };
}(typeof window !== 'undefined' ? window : globalThis));
