/* vt_autonomy.js — the Autonomy panel: what the robot does on its own and why.
 *
 * Contract: vitulus_planner docs/AUTONOMY.md. The panel draws what master_controller
 * reports and never decides anything itself:
 *   in   /scheduler/report (checks, sleep.checks, rain_would_refuse), /scheduler/timeline,
 *        /scheduler/journal, /scheduler/mode (who decides: calendar | agent, its advice,
 *        last decision, limits, dock permission; also report.mode),
 *        /scheduler/settings, /scheduler/settings_result, /scheduler/command_result,
 *        /scheduler/sleep_countdown, /scheduler/calendar, /weather_alert/rain_alert,
 *        /pm/power_status, /mower_smach/status + active_program, /mower/link, /map_rules/state;
 *        rosparam /master_controller/sleep_* (the limits, vt_sleep_plan.js does the arithmetic)
 *   out  /scheduler/set_settings, /scheduler/set_mode (only on a press), /scheduler/sleep_now, /scheduler/sleep_cancel,
 *        /scheduler/ignore_rain_once, /scheduler/run_next, /scheduler/set_calendar (through
 *        calendar_manager), /pm/set_robot_sleep and /pm/set_sleep_until_charged (cancel of a raw sleep)
 * The plan of the next sleep is one value (planNow): hero, Sleep section, right panel and the
 * line above the map (vt_notice.js) all say the same. Announcements on that line come from
 * here, from state changes of the topics above; the robot publishes nothing for them.
 * The hero sentence, the two switches, the calendar and the window card stay
 * calendar_manager.js, which works with an old report as well.
 *
 * A setting appears by itself from the schema of /scheduler/settings. It needs
 * only its two sentences in i18n: auto.set.<key>.label and auto.set.<key>.hint.
 * Without them it is left out (a raw key is never shown), tools/test_autonomy.node.js
 * fails on it.
 */
(function () {
    'use strict';

    var t = function (k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; };
    var has = function (k) { return !window.VTI18n || VTI18n.t(k) !== k; };
    /* first key that has a text */
    function first(keys, v) {
        for (var i = 0; i < keys.length; i++) { if (has(keys[i])) { return t(keys[i], v); } }
        return '';
    }
    function $(id) { return document.getElementById(id); }
    function el(tag, cls, parent, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined) { e.textContent = text; }
        if (parent) { parent.appendChild(e); }
        return e;
    }
    function clear(e) { while (e && e.firstChild) { e.removeChild(e.firstChild); } }

    /* settings the panel draws itself; everything else comes from the schema */
    var CUSTOM = { window_enabled: 1, window_start: 1, window_end: 1, skip_next: 1,
                   no_mow_until: 1, rain_mode: 1, stay_awake_until: 1 };
    /* flagged advanced in the schema, but they are what their section is for */
    var IN_SECTION = { idle_sleep_threshold_min: 1, wake_before_min: 1, rain_after_min: 1, rain_forecast_min: 1, rain_retry_h: 1, temp_wait_h: 1,
                       temp_spike_wait_min: 1, error_retry_max: 1, resume_max: 1, run_max_age_h: 1,
                       off_dock_wait_min: 1 };
    var SECTIONS = ['mode', 'now', 'plan', 'rain', 'battery', 'sleep', 'recovery', 'history', 'advanced'];
    var OPEN_DEFAULT = { mode: 1, now: 1, plan: 1 };
    /* who decides (AUTONOMY.md §6); the agent group's rows in this order, the schema comes sorted */
    var MODES = ['calendar', 'agent'];
    var AGENT_ORDER = ['agent_fallback_calendar', 'limits_in_calendar', 'limit_day_start', 'limit_day_end',
                       'limit_rain_h', 'limit_temp_min_c', 'limit_zone_gap_days'];
    var ADVICE_STATES = { pending: 'info', used: 'ok', missed: 'warn', expired: 'off', dropped: 'off' };
    var CHECK_TONE = { ok: 'ok', wait: 'warn', block: 'err', off: 'off', unknown: 'off' };
    var RAIN_MODES = ['always', 'calendar', 'ignore'];
    var RAIN_CODES = { rain: 1, recent_rain: 1, forecast: 1, rain_stale: 1 };

    /* where a check is fixed: an Autonomy section or another panel */
    var FIX = {
        automation: 'hero', hold: 'hero', dock: 'dock', mission: 'programs', battery: 'sec:battery',
        rain: 'sec:rain', gnss: 'loc', mower: 'sec:recovery', temperature: 'power', window: 'sec:plan', programs: 'programs',
        map: 'map', enabled: 'sec:sleep', manual: 'hero', agent: 'agent', ssh: 'sec:sleep', ui: 'sec:sleep',
        boot: null, stay_awake: 'sec:sleep', reason: 'sec:sleep'
    };

    var S = {
        ros: null, report: null, settings: null, rain: null, pubs: {}, rows: {}, shape: '',
        pending: {}, countdown: null, cdTimer: null, cdAt: 0, reqN: 0, lastRun: null,
        filter: 'all', limits: null, params: {}, skew: 0, reportAt: 0, pm: null, smach: '', program: '',
        sleepAsk: null, runAsk: 0, mode: null, modeAsk: null, n: { first: true, code: '', cd: false, seq: false, soon: 0, smach: '', link: '',
                                        rules: '', seen: null }
    };

    /* ------------------------------------------------------------ topics */
    function pub(name, type, data) {
        if (!S.ros) { return; }
        var p = S.pubs[name];
        if (!p) {
            p = S.pubs[name] = new ROSLIB.Topic({ ros: S.ros, name: name, messageType: type });
            p.advertise();
        }
        p.publish(new ROSLIB.Message({ data: data }));
    }
    function pubJson(name, obj) { pub(name, 'std_msgs/String', JSON.stringify(obj)); }
    function sub(name, type, fn) {
        new ROSLIB.Topic({ ros: S.ros, name: name, messageType: type }).subscribe(fn);
    }
    function subJson(name, fn) {
        sub(name, 'std_msgs/String', function (m) {
            var o = null;
            try { o = JSON.parse(m.data); } catch (e) { return; }
            fn(o);
        });
    }

    /* ---------------------------------------------------- time, numbers */
    function lang() { return window.VTI18n ? VTI18n.lang() : undefined; }
    function pad(n) { return String(n).padStart(2, '0'); }
    function parseIso(s) {
        var d = s ? new Date(s) : null;
        return (d && !isNaN(d.getTime())) ? d : null;
    }
    function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    function dayWord(d) {
        var n = Math.round((dayStart(d) - dayStart(new Date())) / 86400000);
        if (n === 0) { return t('auto.day.today'); }
        if (n === 1) { return t('auto.day.tomorrow'); }
        return d.toLocaleDateString(lang(), { weekday: 'short', day: 'numeric', month: 'numeric' });
    }
    function when(iso) {
        var d = parseIso(iso);
        return d ? dayWord(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : '—';
    }
    function isoLocal(d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function today() { return isoLocal(new Date()).slice(0, 10); }
    function withUnit(v, unit) {
        if (v === null || v === undefined || v === '') { return '—'; }
        if (unit === 'C') { return v + ' °C'; }
        if (unit === 'deg') { return v + '°'; }
        return v + (unit ? ' ' + unit : '');
    }

    function fmtDur(sec) {
        var s = Math.round(sec || 0);
        if (s < 60) { return t('auto.dur.s', { s: s }); }
        var m = Math.round(s / 60), h = Math.floor(m / 60);
        return h ? t('auto.dur.hm', { h: h, m: m % 60 }) : t('auto.dur.m', { m: m });
    }
    /* a moment: the time alone today, with the day otherwise */
    function clock(ms) {
        var d = new Date(ms);
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        return dayStart(d) === dayStart(new Date(nowMs())) ? hm : dayWord(d) + ' ' + hm;
    }
    /* the same with its preposition, for "wakes ...": "at 09:50", "tomorrow 09:50" */
    function wakeAt(ms) {
        var d = new Date(ms);
        return dayStart(d) === dayStart(new Date(nowMs())) ? t('auto.at', { t: clock(ms) }) : clock(ms);
    }
    function nowMs() { return Date.now() + (S.skew || 0); }
    function L() { return S.limits || VTSleepPlan.limits(null); }
    function values() { return (S.settings && S.settings.values) || {}; }
    function planCtx() {
        return { now: nowMs(), rep: S.report, values: values(), L: L(), countdown: S.countdown,
                 cd_at: S.cdAt ? S.cdAt + (S.skew || 0) : 0, ask: S.sleepAsk, report_at: S.reportAt ? S.reportAt + (S.skew || 0) : 0 };
    }
    function planNow() { return window.VTSleepPlan ? VTSleepPlan.auto(planCtx()) : { kind: 'unknown' }; }
    function holdsText(p) {
        var h = p.holds;
        return h ? h.open.map(checkText).join(' ') : '';
    }
    function isHwReset(p) {
        if (p.kind === 'countdown') { return p.source === 'hw_reset'; }
        return p.kind === 'sequence' && !!S.report && (S.report.sleep || {}).source === 'hw_reset';
    }
    /* The plan in one sentence, for every place that shows it. */
    function planLine(p) {
        p = p || planNow();
        var v = {};
        if (isHwReset(p)) {
            return p.kind === 'countdown' ? t('auto.sp.hw_reset', { s: Math.ceil(p.left_s) }) : t('auto.sp.hw_reset_cut');
        }
        if (p.cut) { v.at = clock(p.cut); }
        if (p.wake) { v.wake = wakeAt(p.wake); }
        if (p.off_s !== undefined && p.off_s !== null) { v.dur = fmtDur(p.off_s); }
        if (p.kind === 'sequence') {
            return t(p.mode === 'until_charged' ? 'auto.sp.sequence_charged' : (p.wake ? 'auto.sp.sequence' : 'auto.sp.sequence_plain'), v);
        }
        if (p.kind === 'countdown') {
            v.s = Math.ceil(p.left_s);
            if (p.mode === 'charged') { return t('auto.sp.countdown_charged', v); }
            return t(p.wake ? 'auto.sp.countdown' : 'auto.sp.countdown_plain', v);
        }
        var h = p.holds;
        if (h && h.cancelled_until) { return t('auto.sp.cancelled', { until: clock(h.cancelled_until) }); }
        if (h && h.failed) {
            return t('auto.sp.failed', { why: whyText(h.failed), until: clock(nowMs() + h.ready_s * 1000) });
        }
        if (p.kind === 'soon') {
            var txt = t(p.why === 'window' ? 'auto.sp.soon_window' : 'auto.sp.soon', v);
            return p.maybe ? txt + ' ' + t('auto.sp.maybe') : txt;
        }
        if (p.kind === 'blocked') { return t('auto.sp.blocked', Object.assign(v, { why: holdsText(p) })); }
        if (p.kind === 'none') {
            if (p.why === 'sleep_off') { return t('auto.sp.off'); }
            if (p.why === 'no_schedule') { return t('auto.sp.no_schedule'); }
            if (p.why === 'start_close') { return t('auto.sp.start_close', { at: p.at ? clock(p.at) : '—' }); }
            if (p.why === 'too_short') {
                return t('auto.sp.too_short', { dur: fmtDur(p.want_s), limit: fmtDur(p.floor_s) });
            }
        }
        return '';
    }
    function live(p) { return p.kind === 'countdown' || p.kind === 'sequence'; }
    function cancelSleep() {
        if (rawArmed() && !live(planNow())) {
            pub('/pm/set_robot_sleep', 'std_msgs/Bool', false);
            pub('/pm/set_sleep_until_charged', 'std_msgs/Bool', false);
            return;
        }
        S.n.cancelled = true;
        pub('/scheduler/sleep_cancel', 'std_msgs/Bool', true);
    }
    function rawArmed() {
        var sl = S.report && S.report.sleep;
        return !!(S.pm && (S.pm.sleep_status || S.pm.sleep_charged_status)
                  && !(sl && sl.state && sl.state !== 'IDLE'));
    }

    /* ------------------------------------------------- settings access */
    function schema(k) { return S.settings && S.settings.schema ? S.settings.schema[k] : null; }
    function val(k) { return S.settings && S.settings.values ? S.settings.values[k] : undefined; }
    function def(k) { return S.settings && S.settings.defaults ? S.settings.defaults[k] : undefined; }
    function num(k) { var v = val(k); return v === undefined ? null : v; }
    function fmtVal(k, v) {
        var sc = schema(k) || {};
        if (sc.type === 'bool') { return t(v ? 'common.on' : 'common.off'); }
        if (sc.type === 'enum') { return first(['auto.opt.' + k + '.' + v], {}) || String(v); }
        if (v === null || v === undefined || v === '') { return t('auto.none'); }
        return withUnit(v, sc.unit);
    }

    /* "8", "830", "8.30", "08:30" -> "08:30"; null when it is no time of day */
    function hhmm(s) {
        var m = /^\s*(\d{1,2})(?:\s*[:.,h ]?\s*(\d{2}))?\s*$/.exec(String(s || ''));
        if (!m) { return null; }
        var h = Number(m[1]), mi = m[2] === undefined ? 0 : Number(m[2]);
        return h <= 23 && mi <= 59 ? pad(h) + ':' + pad(mi) : null;
    }
    /* Ours before it goes out; the master checks again. {code, vars} or null */
    function validate(k, v) {
        var sc = schema(k) || {};
        if (sc.type === 'time' && !(typeof v === 'string' && /^\d\d:\d\d$/.test(v))) { return { code: 'type' }; }
        if (sc.type === 'int' || sc.type === 'float') {
            if (typeof v !== 'number' || isNaN(v)) { return { code: 'type' }; }
            if ((sc.min !== undefined && v < sc.min) || (sc.max !== undefined && v > sc.max)) {
                return { code: 'range', vars: { min: sc.min, max: sc.max, unit: sc.unit || '' } };
            }
        }
        if (k === 'battery_start_pct') {
            if (v < 20) { return { code: 'battery_start_under_20' }; }
            if (num('battery_return_pct') !== null && v < num('battery_return_pct')) { return { code: 'battery_start_under_return' }; }
        }
        return null;
    }

    /* The master judges a time by the robot's clock; a phone's can be off. The
       browser's clock is the fallback when rosapi does not answer in time. */
    function robotNow(fn) {
        var done = false;
        var once = function (ms) { if (!done) { done = true; fn(ms); } };
        setTimeout(function () { once(Date.now()); }, 1200);
        try {
            new ROSLIB.Service({ ros: S.ros, name: '/rosapi/get_time', serviceType: 'rosapi/GetTime' })
                .callService(new ROSLIB.ServiceRequest({}), function (r) {
                    once(r && r.time && r.time.secs ? r.time.secs * 1000 : Date.now());
                }, function () { once(Date.now()); });
        } catch (e) { once(Date.now()); }
    }

    /* -------------------------------------------------------- saving */
    function msgOf(row, state, text) {
        if (!row || !row.msg) { return; }
        row.msg.textContent = text || '';
        row.msg.dataset.state = state || '';
        clearTimeout(row.msgT);
        if (state === 'ok') { row.msgT = setTimeout(function () { row.msg.textContent = ''; row.msg.dataset.state = ''; }, 5000); }
    }
    function whyText(reason, vars) {
        var str = String(reason), cut = str.indexOf(':');
        var code = cut < 0 ? str : str.slice(0, cut), rest = cut < 0 ? '' : str.slice(cut + 1);
        var v = Object.assign({}, limitVars(), { who: rest, what: rest }, vars || {});
        if (code === 'busy' && has('auto.why.busy.' + rest)) { return t('auto.why.busy.' + rest, v); }
        return first(['auto.why.' + code, 'auto.check.reason.' + code], v) || str.replace(/_/g, ' ');
    }
    /* the numbers a refusal has to name */
    function limitVars() {
        var l = L();
        return { limit: window.VTSleepPlan ? VTSleepPlan.minManualMin(l) : '?', limit_s: l.min_s,
                 cd: l.countdown_s, wait_min: Math.round(l.wait_s / 60), off_min: Math.round(l.off_s / 60) };
    }
    function send(values, reset, keys, sink) {
        var req = 'ui-' + Date.now().toString(36) + '-' + (++S.reqN);
        var body = { req: req, by: 'owner', values: values || {} };
        if (reset) { body.reset = reset; }
        var p = S.pending[req] = { keys: keys, sink: sink };
        sink('saving', t('auto.msg.saving'));
        p.timer = setTimeout(function () {
            delete S.pending[req];
            sink('warn', t('auto.msg.no_answer'));
            paintSettings();
        }, 6000);
        pubJson('/scheduler/set_settings', body);
    }
    function onResult(res) {
        var p = S.pending[res.req];
        if (!p) { return; }
        delete S.pending[res.req];
        clearTimeout(p.timer);
        var rej = res.rejected || {};
        var names = Object.keys(rej);
        if (res.ok === false || names.length) {
            var why = names.map(function (k) { return whyText(rej[k]); }).join(' ') || t('auto.msg.refused_plain');
            p.sink('err', t('auto.msg.refused', { why: why }));
            revert(p.keys);
        } else {
            var mid = p.keys.some(function (k) { return (schema(k) || {}).mid_run === 'next_run'; });
            var running = S.report && (S.report.code === 'mowing');
            p.sink('ok', t(mid && running ? 'auto.msg.saved_next_run' : 'auto.msg.saved'));
        }
        paintSettings();
    }
    function rowOf(k) { return k === 'rain_mode' ? S.rainFoot : S.rows[k]; }
    /* a refused value goes back to what the robot uses, also in a focused field */
    function revert(keys) {
        keys.forEach(function (k) {
            var r = S.rows[k], v = val(k);
            if (r && r.input && r.input.type !== 'checkbox') { r.input.value = (v === null || v === undefined) ? '' : v; }
        });
    }
    function saveKey(k, v) {
        var bad = validate(k, v), row = rowOf(k);
        var sink = function (st, tx) { msgOf(row, st, tx); };
        if (bad) {
            sink('err', t('auto.msg.refused', { why: whyText(bad.code, bad.vars) }));
            revert([k]);
            paintSettings();
            return;
        }
        var o = {}; o[k] = v;
        send(o, null, [k], sink);
    }
    function resetKey(k) {
        var row = rowOf(k);
        send({}, [k], [k], function (st, tx) { msgOf(row, st, tx); });
    }

    /* A sleep check saying nothing any more can start the sleep at once: switching on an
       "ignore" is in effect "sleep now". So it says what would happen, with the numbers,
       and asks. Until then the switch stays off. */
    var IGNORES = { sleep_ignore_ssh: 'ssh', sleep_ignore_ui: 'ui' };
    function askIgnore(k, row) {
        row.input.checked = false;
        var box = $('auto_ignore_warn');
        if (!box) { saveKey(k, true); return; }
        var p = window.VTSleepPlan ? VTSleepPlan.ifIgnored(planCtx(), IGNORES[k]) : null;
        var vars = { cd: L().countdown_s };
        var key = 'auto.ign.none';
        if (p && (p.kind === 'soon' || p.kind === 'blocked')) {
            key = p.kind === 'soon' ? 'auto.ign.now' : 'auto.ign.later';
            vars.dur = fmtDur(p.off_s);
            vars.at = clock(p.cut);
            vars.wake = wakeAt(p.wake);
            vars.why = holdsText(p);
        }
        clear(box);
        el('span', 'vt-attn-txt', box, t(key, vars) + ' ' + t('auto.ign.common'));
        var b = el('div', 'vt-auto-choice-row', box);
        var yes = el('button', 'btn btn-sm btn-warning', b, t('auto.ign.yes'));
        yes.type = 'button'; yes.id = 'btn_auto_ignore_yes';
        var no = el('button', 'btn btn-sm btn-outline-secondary', b, t('common.cancel'));
        no.type = 'button'; no.id = 'btn_auto_ignore_no';
        yes.addEventListener('click', function () { box.hidden = true; saveKey(k, true); });
        no.addEventListener('click', function () { box.hidden = true; });
        box.hidden = false;
        box.scrollIntoView({ block: 'nearest' });
    }

    /* ----------------------------------------------------- setting rows */
    function buildRow(k, box) {
        var sc = schema(k), r = { key: k };
        r.el = el('div', 'vt-auto-set', box);
        r.el.dataset.key = k;
        var txt = el('div', 'vt-auto-set-t', r.el);
        var lab = el('label', 'vt-auto-set-l', txt, t('auto.set.' + k + '.label'));
        var id = 'auto_in_' + k;
        lab.htmlFor = id;
        if (window.VTI18n) { VTI18n.tag(lab, 'auto.set.' + k + '.label'); }
        var hint = el('small', 'vt-auto-set-h', txt, t('auto.set.' + k + '.hint'));
        if (window.VTI18n) { VTI18n.tag(hint, 'auto.set.' + k + '.hint'); }
        var ctl = el('div', 'vt-auto-set-c', r.el);
        if (sc.type === 'bool') {
            var w = el('label', 'form-check form-switch vt-auto-sw', ctl);    // the whole box toggles: 40 px on touch
            w.htmlFor = id;
            r.input = el('input', 'form-check-input', w);
            r.input.type = 'checkbox';
            r.input.addEventListener('change', function () {
                if (IGNORES[k] && r.input.checked) { askIgnore(k, r); return; }
                saveKey(k, r.input.checked);
            });
        } else if (sc.type === 'enum') {
            r.input = el('select', 'form-select form-select-sm', ctl);
            (sc.options || []).forEach(function (o) {
                var op = el('option', null, r.input, first(['auto.opt.' + k + '.' + o]) || String(o));
                op.value = o;
            });
            r.input.addEventListener('change', function () { saveKey(k, r.input.value); });
        } else {
            r.input = el('input', 'form-control form-control-sm vt-auto-in', ctl);
            var numeric = sc.type === 'int' || sc.type === 'float';
            r.input.type = numeric ? 'number' : (sc.type === 'date' ? 'date' : (sc.type === 'datetime' ? 'datetime-local' : 'text'));
            if (sc.type === 'time') {
                /* 24 h like the rest of the UI (a time field follows the browser's 12 h locale);
                   decimal keypad on a phone: 8.30, 8:30, 830 and 8 all mean what they say */
                r.input.inputMode = 'decimal';
                r.input.maxLength = 5;
                r.input.placeholder = 'HH:MM';
                r.input.autocomplete = 'off';
            }
            if (numeric) {
                r.input.inputMode = sc.type === 'int' ? 'numeric' : 'decimal';
                if (sc.min !== undefined) { r.input.min = sc.min; }
                if (sc.max !== undefined) { r.input.max = sc.max; }
                r.input.step = sc.step || (sc.type === 'int' ? 1 : 'any');
            }
            r.input.addEventListener('change', function () {
                var v = numeric ? Number(r.input.value) : (sc.type === 'time' ? hhmm(r.input.value) : r.input.value);
                if (sc.type === 'time' && v) { r.input.value = v; }
                saveKey(k, v);
            });
            if (sc.unit) { el('span', 'vt-auto-unit', ctl, withUnit(0, sc.unit).replace(/^0\s*/, '')); }
        }
        r.input.id = id;
        var foot = el('div', 'vt-auto-set-f', r.el);
        r.defEl = el('span', 'vt-auto-def', foot);
        r.reset = el('button', 'btn btn-link btn-sm vt-auto-reset', foot, t('auto.reset'));
        r.reset.type = 'button';
        if (window.VTI18n) { VTI18n.tag(r.reset, 'auto.reset'); }
        r.reset.addEventListener('click', function () { resetKey(k); });
        r.msg = el('span', 'vt-auto-msg', foot);
        r.msg.setAttribute('aria-live', 'polite');
        if (sc.mid_run === 'next_run') { el('span', 'vt-auto-note', foot, t('auto.next_run_note')); }
        if (sc.needs_restart) { el('span', 'vt-auto-note', foot, t('auto.restart_note')); }
        S.rows[k] = r;
        return r;
    }
    function paintRow(r) {
        var k = r.key, v = val(k), sc = schema(k) || {};
        var busy = Object.keys(S.pending).some(function (q) { return S.pending[q].keys.indexOf(k) >= 0; });
        if (document.activeElement !== r.input || sc.type === 'bool') {
            if (!busy) {
                if (sc.type === 'bool') { r.input.checked = !!v; }
                else { r.input.value = (v === null || v === undefined) ? '' : v; }
            }
        }
        var d = def(k);
        var same = JSON.stringify(v) === JSON.stringify(d);
        r.defEl.textContent = t('auto.default', { v: fmtVal(k, d) });
        r.reset.style.visibility = same ? 'hidden' : '';
    }

    /* Rows are built once per schema; repainting only touches values, so
       nothing jumps and a field being typed in keeps its text. */
    function buildSettings() {
        var sch = S.settings && S.settings.schema;
        if (!sch) { return; }
        var shape = Object.keys(sch).sort().join();
        if (shape === S.shape) { return; }
        S.shape = shape;
        S.rows = {};
        document.querySelectorAll('[data-auto-group]').forEach(clear);
        clear($('auto_adv_list'));
        var rank = function (k) { return AGENT_ORDER.indexOf(k); };
        Object.keys(sch).sort(function (a, b) { return rank(a) - rank(b); }).forEach(function (k) {
            var sc = sch[k];
            if (CUSTOM[k] || sc.locked) { return; }
            if (!has('auto.set.' + k + '.label') || !has('auto.set.' + k + '.hint')) {
                // a raw key is never shown; tools/test_autonomy.node.js catches it
                console.warn('[autonomy] no text for setting', k);
                return;
            }
            var box = (sc.advanced && !IN_SECTION[k]) ? $('auto_adv_list') : document.querySelector('[data-auto-group="' + sc.group + '"]');
            if (box) { buildRow(k, box); }
        });
    }
    function paintLocks() {
        var box = $('auto_locks'), sch = S.settings && S.settings.schema;
        if (!box) { return; }
        clear(box);
        var keys = sch ? Object.keys(sch).filter(function (k) {
            return sch[k].locked && has('auto.set.' + k + '.label');
        }) : [];
        if (!keys.length) { el('p', 'vt-auto-quiet', box, t('auto.lock.none')); return; }
        keys.forEach(function (k) {
            var r = el('div', 'vt-auto-lock', box);
            if (sch[k].source) { r.title = sch[k].source; }
            el('i', 'la la-lock', r);
            var c = el('div', 'vt-auto-lock-t', r);
            el('b', null, c, t('auto.set.' + k + '.label'));
            el('small', null, c, first(['auto.lock.why.' + sch[k].locked_why, 'auto.lock.why.safety_temp']));
            el('span', 'vt-auto-lock-v', r, fmtVal(k, val(k)));
        });
    }
    function paintSettings() {
        buildSettings();
        var keys = Object.keys(S.rows);
        keys.forEach(function (k) { paintRow(S.rows[k]); });
        paintRainMode();
        paintLocks();
        paintQuiet();
        paintLimitsHead();
    }
    /* an old master has no settings: say it once per group instead of empty space */
    function paintQuiet() {
        var missing = !S.settings;
        document.querySelectorAll('[data-auto-group]').forEach(function (b) {
            if (!missing) {
                var q = b.querySelector('.vt-auto-quiet');
                if (q) { q.remove(); }
                return;
            }
            if (b.querySelector('.vt-auto-quiet')) { return; }
            var p = el('p', 'vt-auto-quiet', b);
            p.textContent = t('auto.no_settings');
            if (window.VTI18n) { VTI18n.tag(p, 'auto.no_settings'); }
        });
    }

    /* three-way rain choice */
    function buildRainMode() {
        var box = $('auto_rain_mode');
        if (!box || box.dataset.built) { return; }
        box.dataset.built = '1';
        RAIN_MODES.forEach(function (m) {
            var b = el('button', 'vt-auto-choice', box);
            b.type = 'button';
            b.dataset.mode = m;
            b.setAttribute('role', 'radio');
            var ti = el('b', null, b, t('auto.rain.mode.' + m));
            var hi = el('small', null, b, t('auto.rain.mode.' + m + '.hint'));
            if (window.VTI18n) { VTI18n.tag(ti, 'auto.rain.mode.' + m); VTI18n.tag(hi, 'auto.rain.mode.' + m + '.hint'); }
            b.addEventListener('click', function () {
                if (val('rain_mode') !== m) { saveKey('rain_mode', m); }
            });
        });
        var f = el('div', 'vt-auto-set-f', box.parentNode);
        box.parentNode.insertBefore(f, box.nextSibling);
        S.rainFoot = { defEl: el('span', 'vt-auto-def', f) };
        S.rainFoot.reset = el('button', 'btn btn-link btn-sm vt-auto-reset', f, t('auto.reset'));
        S.rainFoot.reset.type = 'button';
        if (window.VTI18n) { VTI18n.tag(S.rainFoot.reset, 'auto.reset'); }
        S.rainFoot.reset.addEventListener('click', function () { resetKey('rain_mode'); });
        S.rainFoot.msg = el('span', 'vt-auto-msg', f);
    }
    function paintRainMode() {
        var box = $('auto_rain_mode');
        if (!box) { return; }
        var v = val('rain_mode');
        box.querySelectorAll('.vt-auto-choice').forEach(function (b) {
            var on = b.dataset.mode === v;
            b.classList.toggle('vt-sel', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
            b.disabled = !schema('rain_mode');
        });
        if (S.rainFoot) {
            S.rainFoot.defEl.textContent = schema('rain_mode')
                ? t('auto.default', { v: t('auto.rain.mode.' + (def('rain_mode') || 'always')) }) : '';
            S.rainFoot.reset.style.visibility = (schema('rain_mode') && v !== def('rain_mode')) ? '' : 'hidden';
        }
    }

    /* ------------------------------------------- who decides (wave 2) */
    /* /scheduler/mode is the master's view (AUTONOMY.md §6). The two buttons say
       what the robot reports; a press is the only thing that sends. Nothing here
       grants the dock: the owner does that in the Agent panel (D36). */
    function modeView() { return S.mode || null; }
    function hm(iso) { var d = parseIso(iso); return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : '—'; }
    /* the time alone today, with its day otherwise */
    function soon(iso) { var d = parseIso(iso); return d && dayStart(d) === dayStart(new Date(nowMs())) ? hm(iso) : when(iso); }
    /* "today 10:00–14:00", the end with its day only when it is another day */
    function span(from, to) {
        var a = parseIso(from), b = parseIso(to);
        if (!a || !b) { return when(from || to); }
        return when(from) + '–' + (dayStart(a) === dayStart(b) ? hm(to) : when(to));
    }
    function adviceText(a) {
        if (!a || !a.action) { return ''; }
        if (a.action === 'skip') { return t('auto.mode.adv.skip', { until: when(a.until) }); }
        return t('auto.mode.adv.mow', { program: a.program || '', span: span(a.from, a.to) });
    }
    /* the limit with its numbers; without them (an older master) just its name, never a {placeholder} */
    function limitText(code, vars) {
        var full = first(['auto.limit.' + code], vars || {});
        if (full && !/\{\w+\}/.test(full)) { return full; }
        return first(['auto.limit.name.' + code]) || String(code).replace(/^limit_/, '').replace(/_/g, ' ');
    }
    /* a reason code of the agent mode in words: limit:…, dock:…, a check key:code, a refusal */
    function whyCode(code, vars) {
        var str = String(code || ''), cut = str.indexOf(':');
        var head_ = cut < 0 ? '' : str.slice(0, cut), rest = cut < 0 ? str : str.slice(cut + 1);
        if (head_ === 'limit') { return limitText(rest, vars); }
        if (head_ === 'dock') { return t('auto.mode.why.dock'); }
        if (!head_ && has('auto.mode.rej.' + str)) { return t('auto.mode.rej.' + str); }
        if (!head_ && /^limit_/.test(str)) { return limitText(str, vars); }
        return commandWhy(str);
    }
    function modeMsg(state, text) { msgOf({ msg: $('auto_mode_msg') }, state, text); }
    function buildMode() {
        var box = $('auto_mode_choice');
        if (!box || box.dataset.built) { return; }
        box.dataset.built = '1';
        MODES.forEach(function (m) {
            var b = el('button', 'vt-auto-choice', box);
            b.type = 'button';
            b.id = 'btn_auto_mode_' + m;
            b.dataset.mode = m;
            b.setAttribute('role', 'radio');
            var ti = el('b', null, b, t('auto.mode.' + m));
            var hi = el('small', null, b, t('auto.mode.' + m + '.hint'));
            if (window.VTI18n) { VTI18n.tag(ti, 'auto.mode.' + m); VTI18n.tag(hi, 'auto.mode.' + m + '.hint'); }
            b.addEventListener('click', function () { setMode(m); });
        });
    }
    function setMode(m) {
        var mv = modeView();
        if (!mv || mv.mode === m || S.modeAsk || MODES.indexOf(m) < 0) { return; }
        S.modeAsk = { t: Date.now(), mode: m };
        S.modeAsk.timer = setTimeout(function () {
            S.modeAsk = null;
            modeMsg('warn', t('auto.msg.no_answer'));
            paintMode();
        }, 6000);
        modeMsg('saving', t('auto.msg.saving'));
        pubJson('/scheduler/set_mode', { mode: m, by: 'owner' });
        paintMode();
    }
    /* latched: an answer to a press of long ago comes at every page load */
    function onModeResult(r) {
        var ask = S.modeAsk;
        if (!ask || Date.now() - ask.t > 15000) { return; }
        clearTimeout(ask.timer);
        S.modeAsk = null;
        if (r.ok) {
            modeMsg('ok', t(r.code === 'same' ? 'auto.mode.msg.same' : 'auto.mode.msg.changed', { mode: t('auto.mode.' + ask.mode) }));
        } else {
            modeMsg('err', t('auto.mode.msg.refused'));
        }
        paintMode();
    }
    /* what the agent mode does now: one token for the section head */
    function modeState(mv) {
        var code = S.report && S.report.code;
        var adv = mv.advice && mv.advice.fresh ? mv.advice : null;
        if (!mv.automation) { return { k: 'auto.mode.st.auto_off', tone: 'off' }; }
        if (mv.held) { return { k: 'auto.mode.st.held', tone: 'warn' }; }
        if (mv.mode !== 'agent') { return { k: mv.limits_apply ? 'auto.mode.st.cal_limits' : 'auto.mode.st.cal', tone: 'ok' }; }
        if (code === 'waiting_dock') { return { k: 'auto.mode.st.dock', tone: 'warn' }; }
        if (mv.limit_now) {
            return { k: 'auto.mode.st.limit', v: { what: first(['auto.limit.name.' + mv.limit_now.code]) || mv.limit_now.code }, tone: 'info' };
        }
        if (adv && adv.action === 'skip') { return { k: 'auto.mode.st.skip', v: { until: when(adv.until) }, tone: 'info' }; }
        if (adv && adv.state === 'pending') {
            if (mv.dock_permitted === false) { return { k: 'auto.mode.st.dock', tone: 'warn' }; }
            return { k: 'auto.mode.st.mow', v: { program: adv.program || '', at: soon(adv.from) }, tone: 'ok' };
        }
        if (adv) { return { k: 'auto.mode.st.done', tone: 'ok' }; }
        return mv.fallback ? { k: 'auto.mode.st.fallback', tone: 'ok' } : { k: 'auto.mode.st.no_advice', tone: 'info' };
    }
    function note(box, key, vars, state) {
        var p = el('p', 'vt-auto-note-l', box, t(key, vars));
        if (state) { p.dataset.state = state; }
        return p;
    }
    /* D36: a mow advice leaves the dock only with the owner's permission. Said
       where it matters (an advice that wants to go, or will want to), quiet otherwise. */
    function paintDock(mv) {
        var box = $('auto_mode_attn');
        if (!box) { return; }
        var rep = S.report || {}, adv = mv && mv.advice && mv.advice.fresh ? mv.advice : null;
        var key = null, vars = {}, state = 'warn';
        if (mv && mv.mode === 'agent') {
            if (rep.code === 'waiting_dock') {
                if (adv && adv.state === 'pending' && adv.action === 'mow') {
                    key = 'auto.mode.dock.waiting';
                    vars = { program: adv.program || '', to: soon(adv.to) };
                } else {
                    key = 'auto.mode.dock.waiting_run';
                    vars = { program: (rep.detail && rep.detail.program) || (adv && adv.program) || '' };
                }
            } else if (adv && adv.state === 'pending' && adv.action === 'mow' && mv.dock_permitted === false) {
                var ahead = (parseIso(adv.from) || 0) > nowMs();
                key = ahead ? 'auto.mode.dock.ahead' : 'auto.mode.dock.waiting';
                vars = ahead ? { program: adv.program || '', at: soon(adv.from) } : { program: adv.program || '', to: soon(adv.to) };
                state = ahead ? 'info' : 'warn';
            }
        }
        box.hidden = !key;
        if (!key) { return; }
        var sig = key + JSON.stringify(vars) + (mv.dock_why || '');
        if (box.dataset.sig === sig) { return; }
        box.dataset.sig = sig;
        box.dataset.state = state;
        clear(box);
        var tx = el('span', 'vt-attn-txt', box, t(key, vars));
        if (mv.dock_why) { tx.title = mv.dock_why; }   // the lock's own words (Czech, from the agent)
        var b = el('button', 'btn btn-sm ' + (state === 'warn' ? 'btn-outline-warning' : 'btn-outline-info'), box, t('auto.mode.dock.go'));
        b.type = 'button'; b.id = 'btn_auto_mode_dock';
        b.title = t('auto.mode.dock.go_tip');
        el('i', 'la la-angle-right', b);
        b.addEventListener('click', function () { goFix('agent'); });
    }
    function paintAdvice(mv) {
        var box = $('auto_mode_advice');
        if (!box) { return; }
        var a = mv && mv.mode === 'agent' ? mv.advice : null;
        box.hidden = !a;
        clear(box);
        if (!a) { return; }
        el('h6', 'vt-auto-h', box, t(a.fresh ? 'auto.mode.adv.h' : 'auto.mode.adv.h_old'));
        el('div', 'vt-auto-dec-main', box, adviceText(a));
        var meta = el('div', 'vt-auto-dec-meta', box);
        var st = el('span', 'vt-pill', meta, first(['auto.mode.adv.state.' + a.state]) || String(a.state || ''));
        st.dataset.state = ADVICE_STATES[a.state] || 'off';
        if (typeof a.confidence === 'number') { el('span', 'vt-pill', meta, t('auto.mode.adv.conf', { pct: Math.round(a.confidence * 100) })); }
        if (a.received) { el('span', null, meta, when(a.received)); }
        if (a.reason) { el('p', 'vt-auto-dec-why', box, t('auto.mode.adv.reason', { reason: a.reason })); }
    }
    function paintLast(mv) {
        var box = $('auto_mode_last');
        if (!box) { return; }
        clear(box);
        if (!mv) { return; }
        el('h6', 'vt-auto-h', box, t('auto.mode.last.h'));
        var d = mv.last_decision;
        if (!d) { el('p', 'vt-auto-quiet', box, t('auto.mode.last.none')); return; }
        var v = d.vars || {};
        el('div', 'vt-auto-dec-main', box, journalText(d));
        var meta = el('div', 'vt-auto-dec-meta', box);
        el('span', null, meta, when(d.t));
        if (d.source) {
            var s = el('span', 'vt-pill', meta, first(['auto.mode.src.' + d.source]) || d.source);
            s.dataset.state = d.source === 'agent' ? 'info' : '';
        }
        if (typeof v.confidence === 'number') { el('span', 'vt-pill', meta, t('auto.mode.adv.conf', { pct: Math.round(v.confidence * 100) })); }
        var main = box.querySelector('.vt-auto-dec-main').textContent, wv = v.why ? whyCode(v.why, v) : '';
        var why = v.reason ? t('auto.mode.adv.reason', { reason: v.reason })
            : (wv && main.indexOf(wv) < 0 ? t('auto.mode.why', { why: wv }) : '');
        if (why) {
            var p = el('p', 'vt-auto-dec-why', box, why);
            if (v.dock) { p.title = v.dock; }
        }
    }
    function paintMode() {
        var box = $('auto_mode_choice');
        if (!box) { return; }
        var mv = modeView(), ask = S.modeAsk;
        box.querySelectorAll('.vt-auto-choice').forEach(function (b) {
            var on = !!mv && b.dataset.mode === mv.mode;
            b.classList.toggle('vt-sel', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
            b.disabled = !mv || !!ask;
            if (ask && ask.mode === b.dataset.mode) { b.dataset.pending = '1'; } else { delete b.dataset.pending; }
        });
        var notes = $('auto_mode_notes');
        clear(notes);
        if (!mv) {
            /* an old master has neither /scheduler/mode nor report.mode */
            note(notes, S.report ? 'auto.mode.old' : 'auto.mode.wait');
            head('mode', 'off', []);
            paintDock(null); paintAdvice(null); paintLast(null);
            return;
        }
        var st = modeState(mv);
        var toks = [{ text: t('auto.mode.' + mv.mode), state: mv.mode === 'agent' ? 'info' : undefined },
                    { text: t(st.k, st.v), state: st.tone }];
        head('mode', st.tone === 'warn' ? 'warn' : (mv.mode === 'agent' ? 'info' : 'off'), toks);
        $('auto_tok_mode').querySelectorAll('.vt-pill').forEach(function (x) { x.title = x.textContent; });
        if (!mv.automation) { note(notes, 'auto.mode.note.auto_off', null, 'warn'); }
        else if (mv.held) { note(notes, 'auto.mode.note.held', null, 'warn'); }
        if (mv.mode === 'agent') {
            var adv = mv.advice && mv.advice.fresh ? mv.advice : null;
            if (!adv) { note(notes, mv.fallback ? 'auto.mode.note.fallback' : 'auto.mode.note.no_advice'); }
            if (mv.limit_now) { note(notes, 'auto.mode.limit_now', { what: limitText(mv.limit_now.code, mv.limit_now.vars) }); }
            if (mv.dock_permitted === true) { note(notes, 'auto.mode.dock.open'); }
            else if (mv.dock_permitted === false && !(adv && adv.state === 'pending' && adv.action === 'mow')) {
                note(notes, 'auto.mode.dock.locked').title = mv.dock_why || '';
            }
        } else {
            note(notes, mv.limits_apply ? 'auto.mode.note.calendar_limits' : 'auto.mode.note.calendar');
            if (mv.limit_now) { note(notes, 'auto.mode.limit_now', { what: limitText(mv.limit_now.code, mv.limit_now.vars) }); }
        }
        paintDock(mv); paintAdvice(mv); paintLast(mv);
    }
    /* an older master has no agent group: no heading over nothing */
    function paintLimitsHead() {
        var h = $('auto_mode_limits_h'), g = document.querySelector('[data-auto-group="agent"]');
        if (h && g) { h.hidden = !g.firstChild; }
    }

    /* ------------------------------------------------------- checks */
    function goFix(where) {
        if (!where) { return; }
        if (where === 'hero') { var b = $('ui_drawer_body'); if (b) { b.scrollTop = 0; } return; }
        if (where.indexOf('sec:') === 0) { openSec(where.slice(4), true); return; }
        var mm = window.map_menu;
        if (!mm) { return; }
        var tab = function (sel) {
            setTimeout(function () {
                var a = document.querySelector('a[href="' + sel + '"]');
                if (!a) { return; }
                if (window.bootstrap && bootstrap.Tab) { bootstrap.Tab.getOrCreateInstance(a).show(); } else { a.click(); }
            }, 80);
        };
        var showMap = function () { if (mm.current_submenu !== 'map' && mm.btn_map) { mm.btn_map.onclick(); } };
        if (where === 'programs') { if (mm.current_submenu !== 'program') { mm.btn_programs.onclick(); } }
        else if (where === 'map') { showMap(); }
        else if (where === 'dock') { showMap(); tab('#tab-dock'); }
        else if (where === 'loc') { showMap(); tab('#tab-gloc'); }
        else if (where === 'rainmap') { showMap(); tab('#tab-rain'); }
        else if (where === 'power') { if (mm.current_submenu !== 'config') { mm.btn_settings.onclick(); } tab('#tab_power'); }
        else if (where === 'agent') { var a = $('btn_agent'); if (a) { a.click(); } }
    }
    function checkVars(c) {
        var v = Object.assign({}, c.vars || {});
        if (v.left_s !== undefined) { v.min = Math.max(1, Math.ceil(v.left_s / 60)); }
        if (Array.isArray(v.who)) { v.who = v.who.join(', '); }
        if (v.until) { v.until = String(v.until).length === 10 ? dayWord(new Date(v.until + 'T12:00')) : when(v.until); }
        return v;
    }
    /* GPS is only checked when a run starts (code not_checked): say so, with the
       live fix the right panel shows, so "unknown" never sits next to FLOAT */
    function gnssNow() {
        var g = window.gnss_rx, d = g && g.last;
        if (!d || Date.now() - (g.last_at || 0) > 15000 || typeof GnssRx === 'undefined') { return null; }
        var pos = d.rx && d.rx.gnss;
        if (!pos || !pos.alive) { return null; }
        var p = pos.pvt || {}, sv = pos.sat ? pos.sat.used : p.num_sv;
        return { fix: GnssRx.fixText(pos), sv: sv == null ? '—' : sv };
    }
    function checkText(c) {
        var v = checkVars(c);
        if (c.key === 'gnss' && c.code === 'not_checked') {
            var g = gnssNow();
            return g ? t('auto.check.gnss.not_checked_live', g) : t('auto.check.gnss.not_checked');
        }
        return first(['auto.check.' + c.key + '.' + c.code,
                      'calmgr.code.' + c.code,
                      'auto.check.' + c.key + '.state.' + c.state,
                      'auto.check.state.' + c.state], Object.assign({ what: t('auto.check.key.' + c.key) }, v));
    }
    var QUIET_HOLDS = { ssh: 1, ui: 1 };
    function paintChecks(box, list, quietOk) {
        clear(box);
        if (!quietOk) { S.gnssLive = null; }
        var n = { ok: 0, wait: 0, block: 0 };
        var rank = { block: 0, wait: 1 };
        var order = function (c) { return c.state in rank ? rank[c.state] : 2; };
        (list || []).slice().sort(function (a, b) { return order(a) - order(b); }).forEach(function (c) {
            if (n[c.state] !== undefined) { n[c.state] += 1; }
            if (quietOk && c.state === 'ok') { return; }
            var r = el('div', 'vt-auto-check', box);
            r.dataset.state = CHECK_TONE[c.state] || 'off';
            /* someone logged in or watching keeps it awake on purpose: a fact, not a fault */
            if (quietOk && c.state === 'block' && QUIET_HOLDS[c.key]) { r.dataset.state = 'info'; }
            el('span', 'vt-sdot', r);
            var tx = el('span', 'vt-auto-check-t', r, checkText(c));
            if (c.key === 'gnss' && c.code === 'not_checked' && !quietOk) { S.gnssLive = { el: tx, c: c }; }
            var fix = FIX[c.key];
            if (fix && c.state !== 'ok' && c.state !== 'off') {
                var b = el('button', 'vt-auto-go', r);
                b.type = 'button';
                b.title = t('auto.fix.' + fix.replace('sec:', ''));
                b.setAttribute('aria-label', b.title);
                el('i', 'la la-angle-right', b);
                b.addEventListener('click', function () { goFix(fix); });
            }
        });
        return n;
    }
    function paintNow() {
        var rep = S.report, c = $('auto_checks'), sc = $('auto_sleep_checks');
        if (!c) { return; }
        var checks = rep && rep.checks, sleep = rep && rep.sleep;
        var n = { ok: 0, wait: 0, block: 0 };
        if (checks) { n = paintChecks(c, checks, false); }
        else {
            clear(c);
            el('p', 'vt-auto-quiet', c, t(rep ? 'auto.now.old' : 'auto.now.wait'));
        }
        if (sleep && sleep.checks) {
            var sn = paintChecks(sc, sleep.checks, true);
            if (!sn.wait && !sn.block) { clear(sc); el('p', 'vt-auto-quiet', sc, t('auto.now.sleep_free')); }
        } else {
            clear(sc);
            el('p', 'vt-auto-quiet', sc, sleep && sleep.block ? t('calmgr.why_awake', { why: awake(sleep.block) })
                : t(sleep ? 'auto.now.sleep_free' : (rep ? 'auto.now.old' : 'auto.now.wait')));
        }
        var worst = n.block ? 'err' : (n.wait ? 'warn' : (checks ? 'ok' : 'off'));
        var toks = [];
        if (checks) {
            var first_ = checks.filter(function (x) { return x.state === (n.block ? 'block' : 'wait'); })[0];
            toks.push({ state: worst, text: (n.block || n.wait)
                ? t('auto.check.key.' + first_.key) + (n.block + n.wait > 1 ? ' +' + (n.block + n.wait - 1) : '')
                : t('auto.tok.ready') });
        }
        head('now', worst, toks);
    }
    function awake(b) {
        var cm = window.calendarManager;
        return cm && cm._awakeWhy ? cm._awakeWhy(b) : String(b);
    }

    /* section head: tone + tokens */
    function head(id, state, toks) {
        var s = $('auto_sec_' + id), box = $('auto_tok_' + id);
        if (!s || !box) { return; }
        s.dataset.state = state || 'off';
        clear(box);
        (toks || []).forEach(function (k) {
            var p = el('span', 'vt-pill', box, k.text);
            if (k.state) { p.dataset.state = k.state; }
        });
    }
    /* expand = numbers */
    function nums(id, list) {
        var box = $('auto_nums_' + id);
        if (!box) { return; }
        clear(box);
        (list || []).forEach(function (n) {
            var c = el('div', 'vt-auto-num', box);
            el('span', 'vt-auto-num-k', c, n.k);
            var v = el('span', 'vt-auto-num-v', c, n.v);
            if (n.state) { c.dataset.state = n.state; v.dataset.state = n.state; }
        });
    }

    /* ---------------------------------------------------------- plan */
    function paintPlan() {
        var rep = S.report;
        var next = rep && rep.next;
        var skip = val('skip_next'), noMow = val('no_mow_until');
        var toks = [];
        if (rep && !rep.enabled) { toks.push({ text: t('auto.tok.auto_off') }); }
        else if (next) { toks.push({ text: when(next.at), state: 'ok' }); }
        else { toks.push({ text: t('auto.tok.none') }); }
        if (skip) { toks.push({ text: t('auto.tok.skip'), state: 'warn' }); }
        if (noMow && noMow >= today()) { toks.push({ text: t('auto.tok.no_mow'), state: 'warn' }); }
        head('plan', (skip || noMow >= today()) ? 'warn' : (next && rep.enabled ? 'ok' : 'off'), toks);
        var w = rep && rep.window_setting;
        nums('plan', [
            { k: t('auto.num.next'), v: next ? (next.program + ' · ' + when(next.at)) : '—' },
            { k: t('auto.num.window'), v: w ? (w.enabled ? w.start + '–' + w.end : t('common.off')) : '—' },
            { k: t('auto.num.catchup'), v: withUnit(num('catchup_max_h'), 'h') }
        ]);
        paintPlanActions();
        paintTimeline();
        paintUsed();
    }
    /* A start of today that will not run because this entry has already had its day.
       Master marks per id and date. The way out is the same id-less entry: delete + add. */
    function paintUsed() {
        var box = $('auto_used');
        if (!box) { return; }
        var used = ((S.timeline && S.timeline.starts) || []).filter(function (x) {
            return x.reason === 'already_run' && dayStart(new Date(x.t)) === dayStart(new Date(nowMs()));
        });
        clear(box);
        var next = S.report && S.report.next;
        used.forEach(function (x) {
            var r = el('div', 'vt-attn', box);
            r.dataset.state = 'warn';
            var d = parseIso(x.t);
            el('span', 'vt-attn-txt', r, t('auto.used.text', { program: x.program || '', at: pad(d.getHours()) + ':' + pad(d.getMinutes()),
                                                                next: next ? next.program + ' ' + when(next.at) : t('auto.used.no_next') }));
            var b = el('button', 'btn btn-sm btn-warning', r, t('auto.used.run'));
            b.type = 'button'; b.className += ' vt-auto-used-run';
            b.title = t('auto.used.run_tip');
            var open = !!(S.report && S.report.run);
            b.disabled = open;
            if (open) { b.title = t('auto.used.run_open'); }
            b.addEventListener('click', function () {
                var cm = window.calendarManager;
                if (cm && cm.releaseSlot && cm.releaseSlot(x.event_id)) {
                    say('slot_freed', 2, t('auto.n.slot_freed', { program: x.program || '', at: pad(d.getHours()) + ':' + pad(d.getMinutes()) }));
                }
            });
        });
    }
    /* A step that moves the robot or changes today's plan takes two taps. */
    function twoTap(b, key, fn, taker) {
        b.addEventListener('click', function () {
            if (!b.dataset.armed && taker && taker()) { return; }
            if (b.dataset.armed) {
                delete b.dataset.armed;
                clearTimeout(b._t);
                b.textContent = t(key);
                fn();
                return;
            }
            b.dataset.armed = '1';
            b.textContent = t('auto.tap_again');
            b._t = setTimeout(function () { delete b.dataset.armed; b.textContent = t(key); }, 4000);
        });
    }
    function buildPlanActions() {
        var box = $('auto_plan_actions');
        if (!box || box.dataset.built) { return; }
        box.dataset.built = '1';
        var mk = function (id, key) {
            var b = el('button', 'btn btn-sm btn-outline-info', box, t(key));
            b.type = 'button'; b.id = id;
            return b;
        };
        S.btnSkip = mk('btn_auto_skip', 'auto.plan.skip');
        S.btnNoMow = mk('btn_auto_nomow', 'auto.plan.no_mow');
        S.btnRunNext = mk('btn_auto_runnext', 'auto.plan.run_next');
        S.planMsg = el('div', 'vt-auto-msg vt-auto-msg-w', box.parentNode);
        box.parentNode.insertBefore(S.planMsg, box.nextSibling);
        var sink = function (st, tx) { msgOf({ msg: S.planMsg }, st, tx); };
        S.btnSkip.addEventListener('click', function () {
            if (val('skip_next')) { send({ skip_next: null }, null, ['skip_next'], sink); }
            else { send({ skip_next: true }, null, ['skip_next'], sink); }
        });
        S.btnNoMow.addEventListener('click', function () {
            if ((val('no_mow_until') || '') >= today()) { send({ no_mow_until: null }, null, ['no_mow_until'], sink); }
            else { send({ no_mow_until: today() }, null, ['no_mow_until'], sink); }
        });
        twoTap(S.btnRunNext, 'auto.plan.run_next', function () {
            S.runAsk = Date.now();
            pub('/scheduler/run_next', 'std_msgs/Bool', true);
        });
    }
    function paintPlanActions() {
        if (!S.btnSkip) { return; }
        var ready = !!S.settings;
        var skip = val('skip_next'), noMow = val('no_mow_until') || '';
        var noMowOn = noMow >= today();
        var next = S.report && S.report.next;
        S.btnSkip.disabled = !ready || (!next && !skip);
        S.btnSkip.textContent = t(skip ? 'auto.plan.unskip' : 'auto.plan.skip');
        S.btnNoMow.disabled = !ready;
        S.btnNoMow.textContent = t(noMowOn ? 'auto.plan.mow_again' : 'auto.plan.no_mow');
        S.btnRunNext.disabled = !ready || !next;
        if (!S.btnRunNext.dataset.armed) { S.btnRunNext.textContent = t('auto.plan.run_next'); }
        var st = $('auto_plan_state');
        if (st) {
            var parts = [];
            if (skip) { parts.push(t('auto.plan.skipped', { when: when(skip === true ? (next && next.at) : skip) })); }
            if (noMowOn) { parts.push(t('auto.plan.no_mow_until', { day: dayWord(new Date(noMow + 'T12:00')) })); }
            st.textContent = parts.join(' ');
            st.style.display = parts.length ? '' : 'none';
        }
    }
    function paintTimeline() {
        var box = $('auto_timeline'), tl = S.timeline;
        if (!box) { return; }
        clear(box);
        if (!tl || !(tl.starts || tl.sleeps)) { box.style.display = 'none'; return; }
        box.style.display = '';
        var starts = tl.starts || [], sleeps = tl.sleeps || [];
        var base = dayStart(new Date());
        var w = S.report.window;
        var frac = function (hm) { var p = hm.split(':'); return (Number(p[0]) * 60 + Number(p[1])) / 1440; };
        for (var i = 0; i < 7; i++) {
            var from = new Date(base); from.setDate(from.getDate() + i);
            var d0 = from.getTime();
            var to = new Date(d0); to.setDate(to.getDate() + 1);
            var d1 = to.getTime();
            var row = el('div', 'vt-auto-tl-row', box);
            el('span', 'vt-auto-tl-day', row, dayWord(from));
            var track = el('div', 'vt-auto-tl-track', row);
            if (w) {
                var a = frac(w.start), b = frac(w.end);
                var band = function (x, y) {
                    var e = el('span', 'vt-auto-tl-win', track);
                    e.style.left = (x * 100) + '%'; e.style.width = ((y - x) * 100) + '%';
                };
                if (a < b) { band(a, b); } else { band(0, b); band(a, 1); }
            }
            sleeps.forEach(function (s) {
                var f = parseIso(s.from), e = parseIso(s.to);
                if (!f || !e) { return; }
                var x = Math.max(f.getTime(), d0), y = Math.min(e.getTime(), d1);
                if (y <= x) { return; }
                var sp = el('span', 'vt-auto-tl-sleep', track);
                sp.style.left = ((x - d0) / 864000) + '%';
                sp.style.width = ((y - x) / 864000) + '%';
                sp.title = t('auto.tl.sleep', { from: when(s.from), to: when(s.to) });
            });
            var labels = el('div', 'vt-auto-tl-list', row);
            starts.forEach(function (st) {
                var d = parseIso(st.at || st.t);      // a slot moved to the window opening
                if (!d || d.getTime() < d0 || d.getTime() >= d1) { return; }
                var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
                var mark = el('span', 'vt-auto-tl-start', track);
                mark.style.left = ((d.getTime() - d0) / 864000) + '%';
                mark.dataset.st = st.state || 'planned';
                var lab = el('span', 'vt-auto-tl-item', labels, hm + ' ' + (st.program || ''));
                lab.dataset.st = st.state || 'planned';
                var tip = first(['auto.tl.reason.' + st.reason, 'auto.tl.state.' + st.state]);
                if (tip) { lab.title = tip; }
                mark.title = lab.textContent;
            });
        }
    }

    /* ---------------------------------------------------------- rain */
    function radar() {
        var m = S.rain;
        if (!m) { return { state: 'off', key: 'auto.radar.none' }; }
        var at = m.time && m.time.secs ? m.time.secs * 1000 : 0;
        if (at && Date.now() - at > 1800000) { return { state: 'off', key: 'auto.radar.old' }; }
        if (m.rain_alert && m.rain_now > 0) { return { state: 'err', key: 'auto.radar.rain' }; }
        if (m.rain_alert) { return { state: 'warn', key: 'auto.radar.expected' }; }
        return { state: 'ok', key: 'auto.radar.dry' };
    }
    function paintRain() {
        var r = radar(), box = $('auto_radar');
        if (box) {
            box.dataset.state = r.state;
            clear(box);
            el('span', 'vt-sdot', box);
            el('span', null, box, t(r.key));
            if (S.rain) {
                var line = el('span', 'vt-auto-steps', box);
                ['status_nowcast10m', 'status_nowcast20m', 'status_nowcast30m'].forEach(function (f, i) {
                    var s = el('span', 'vt-auto-step', line, '+' + ((i + 1) * 10));
                    s.dataset.s = S.rain[f] || 'UNAVAILABLE';
                    s.title = (S.rain[f] || 'UNAVAILABLE');
                });
            }
        }
        var mode = val('rain_mode');
        var toks = [{ text: t('auto.tok.' + r.key.split('.').pop()), state: r.state }];
        if (mode) { toks.unshift({ text: t('auto.rain.mode.' + mode) }); }
        head('rain', mode === 'ignore' ? 'warn' : r.state, toks);
        nums('rain', [
            { k: t('auto.num.after_rain'), v: withUnit(num('rain_after_min'), 'min') },
            { k: t('auto.num.forecast'), v: withUnit(num('rain_forecast_min'), 'min') },
            { k: t('auto.num.retry'), v: withUnit(num('rain_retry_h'), 'h') }
        ]);
    }

    /* ------------------------------------------------------- battery */
    function paintBattery() {
        var b = S.report && S.report.battery, have = b !== null && b !== undefined;
        var start = num('battery_start_pct');
        var pct = have ? Math.round(b) + ' %' : '—';
        var low = have && start !== null && b < start;
        var toks = [{ text: pct, state: low ? 'warn' : (have ? 'ok' : undefined) }];
        if (start !== null) { toks.push({ text: t('auto.tok.start_at', { pct: start }) }); }
        head('battery', low ? 'warn' : (have ? 'ok' : 'off'), toks);
        nums('battery', [
            { k: t('auto.num.batt_now'), v: pct, state: low ? 'warn' : undefined },
            { k: t('auto.num.batt_start'), v: withUnit(start, '%') },
            { k: t('auto.num.batt_return'), v: withUnit(num('battery_return_pct'), '%') },
            { k: t('auto.num.batt_resume'), v: withUnit(num('battery_resume_pct'), '%') }
        ]);
    }

    /* --------------------------------------------------------- sleep */
    function buildSleep() {
        var box = $('auto_stay');
        if (box && !box.dataset.built) {
            box.dataset.built = '1';
            el('div', 'vt-auto-set-l', box, t('auto.stay.title'));
            el('small', 'vt-auto-set-h', box, t('auto.stay.hint'));
            var line = el('div', 'vt-auto-line', box);
            S.stayN = el('input', 'form-control form-control-sm vt-auto-in', line);
            S.stayN.type = 'number'; S.stayN.min = 1; S.stayN.max = 168; S.stayN.value = 4; S.stayN.inputMode = 'numeric';
            S.stayN.id = 'input_auto_stay';
            S.stayN.setAttribute('aria-label', t('auto.stay.hours'));
            el('span', 'vt-auto-unit', line, 'h');
            S.stayGo = el('button', 'btn btn-sm btn-outline-info', line, t('auto.stay.go'));
            S.stayGo.type = 'button'; S.stayGo.id = 'btn_auto_stay';
            S.stayOff = el('button', 'btn btn-sm btn-outline-secondary', line, t('common.cancel'));
            S.stayOff.type = 'button'; S.stayOff.id = 'btn_auto_stay_off';
            S.stayState = el('div', 'vt-auto-sub', box);
            S.stayMsg = el('div', 'vt-auto-msg vt-auto-msg-w', box);
            var sink = function (st, tx) { msgOf({ msg: S.stayMsg }, st, tx); };
            S.stayGo.addEventListener('click', function () {
                var h = Number(S.stayN.value);
                if (!(h >= 1 && h <= 168)) { sink('err', t('auto.msg.refused', { why: whyText('too_far') })); return; }
                robotNow(function (now) {
                    send({ stay_awake_until: isoLocal(new Date(now + h * 3600000)) }, null, ['stay_awake_until'], sink);
                });
            });
            S.stayOff.addEventListener('click', function () { send({}, ['stay_awake_until'], ['stay_awake_until'], sink); });
        }
        var nb = $('auto_sleep_now');
        if (nb && !nb.dataset.built) {
            nb.dataset.built = '1';
            el('div', 'vt-auto-set-l', nb, t('auto.sleepnow.title'));
            S.sleepHint = el('small', 'vt-auto-set-h', nb);
            var l2 = el('div', 'vt-auto-line', nb);
            S.sleepMin = el('input', 'form-control form-control-sm vt-auto-in', l2);
            S.sleepMin.type = 'number'; S.sleepMin.value = 60; S.sleepMin.inputMode = 'numeric';
            S.sleepMin.id = 'input_auto_sleep_min';
            S.sleepMin.setAttribute('aria-label', t('auto.sleepnow.min'));
            el('span', 'vt-auto-unit', l2, 'min');
            var tb = el('button', 'btn btn-sm btn-outline-warning', l2, t('auto.sleepnow.timed'));
            tb.type = 'button'; tb.id = 'btn_auto_sleep_timed';
            var cb = el('button', 'btn btn-sm btn-outline-warning', l2, t('auto.sleepnow.charged'));
            cb.type = 'button'; cb.id = 'btn_auto_sleep_charged';
            S.sleepPreview = el('p', 'vt-auto-preview', nb);
            S.sleepPreview.id = 'auto_sleep_preview';
            S.sleepChoice = el('div', 'vt-auto-choice-row', nb);
            S.sleepChoice.id = 'auto_sleep_choice';
            S.sleepChoice.hidden = true;
            S.sleepMsg = el('div', 'vt-auto-msg vt-auto-msg-w', nb);
            S.sleepMsg.id = 'auto_sleep_msg';
            S.sleepBtns = [tb, cb];
            S.sleepMin.addEventListener('input', function () { S.sleepChoice.hidden = true; paintManual(); });
            twoTap(tb, 'auto.sleepnow.timed', sleepTimed, function () { return sleepAsks(); });
            twoTap(cb, 'auto.sleepnow.charged', function () {
                if (!sleepFree()) { return; }
                S.sleepAsk = { t: Date.now(), mode: 'charged' };
                pubJson('/scheduler/sleep_now', { mode: 'charged', ms: 0 });
                msgOf({ msg: S.sleepMsg }, 'saving', t('auto.msg.saving'));
            });
        }
    }
    function manualCtx() {
        return { now: nowMs(), rep: S.report, values: values(), L: L(), countdown: L().countdown_s };
    }
    /* A countdown or a sequence is on: the master would drop this request and still say ok. */
    function sleepFree() {
        var p = planNow();
        if (live(p)) { msgOf({ msg: S.sleepMsg }, 'err', t('auto.sleepnow.busy')); return false; }
        if (rawArmed()) { msgOf({ msg: S.sleepMsg }, 'err', t('auto.sleepnow.raw')); return false; }
        return true;
    }
    function sendSleep(minutes, plan) {
        S.sleepChoice.hidden = true;
        S.sleepAsk = { t: Date.now(), mode: 'timed', wake: plan && plan.wake, cut: plan && plan.cut, off_s: plan && plan.off_s, min: minutes };
        pubJson('/scheduler/sleep_now', { mode: 'timed', ms: Math.round(minutes * 60000) });
        msgOf({ msg: S.sleepMsg }, 'saving', t('auto.msg.saving'));
    }
    /* First tap: a start inside the sleep is a choice, not a second tap. true = taken over. */
    function sleepAsks() {
        var m = Number(S.sleepMin.value);
        if (!sleepFree()) { return true; }
        if (!(m >= 1)) { return true; }
        var ctx = manualCtx(), r = VTSleepPlan.manual(m, ctx);
        if (m < r.min_min) { return true; }
        if (!r.capped) { return false; }
        clear(S.sleepChoice);
        if (r.ok) {
            var a = el('button', 'btn btn-sm btn-outline-warning', S.sleepChoice, t('auto.sleepnow.keep', { dur: fmtDur(r.off_s), wake: wakeAt(r.wake) }));
            a.type = 'button'; a.id = 'btn_auto_sleep_keep';
            a.addEventListener('click', function () { sendSleep(m, r); });
        }
        var un = VTSleepPlan.uncapped(m, ctx);
        if (un) {
            var b = el('button', 'btn btn-sm btn-warning', S.sleepChoice, t('auto.sleepnow.skip', { program: r.slot.program, dur: fmtDur(un.off_s), wake: wakeAt(un.wake) }));
            b.type = 'button'; b.id = 'btn_auto_sleep_skip';
            b.addEventListener('click', function () {
                /* _sleep_now caps at the next used slot: with this one skipped the way is free */
                send({ skip_next: true }, null, ['skip_next'], function (st, tx) {
                    msgOf({ msg: S.sleepMsg }, st, tx);
                    if (st === 'ok') { sendSleep(m, un); }
                });
            });
        }
        var c = el('button', 'btn btn-sm btn-outline-secondary', S.sleepChoice, t('common.cancel'));
        c.type = 'button';
        c.addEventListener('click', function () { S.sleepChoice.hidden = true; });
        S.sleepChoice.hidden = false;
        S.sleepChoice.scrollIntoView({ block: 'nearest' });
        return true;
    }
    function sleepTimed() {
        var m = Number(S.sleepMin.value);
        var r = VTSleepPlan.manual(m, manualCtx());
        if (!sleepFree() || !r.ok) { paintManual(); return; }
        sendSleep(m, r);
    }
    /* What the checks of this moment would answer to a person's Sleep now: logins do
       stop it, the UI and the switches do not. */
    var MANUAL_STOPS = { dock: 1, mission: 1, manual: 1, agent: 1, ssh: 1 };
    function manualStops() {
        var sl = S.report && S.report.sleep;
        return ((sl && sl.checks) || []).filter(function (c) { return c.state === 'block' && MANUAL_STOPS[c.key]; });
    }
    function paintManual() {
        if (!S.sleepMin || !window.VTSleepPlan) { return; }
        var l = L(), min = VTSleepPlan.minManualMin(l), max = VTSleepPlan.maxManualMin(l);
        S.sleepMin.min = min; S.sleepMin.max = max;
        S.sleepHint.textContent = t('auto.sleepnow.limits', { min: min, max: max, floor: Math.round(VTSleepPlan.floorS(l) / 60), cd: l.countdown_s });
        var m = Number(S.sleepMin.value), st = '', tx = '';
        var ctx = manualCtx();
        var r = S.report && m >= 1 ? VTSleepPlan.manual(m, ctx) : null;
        if (live(planNow())) { st = 'warn'; tx = t('auto.sleepnow.busy'); }
        else if (rawArmed()) { st = 'warn'; tx = t('auto.sleepnow.raw'); }
        else if (!(m >= 1)) { st = 'err'; tx = t('auto.sleepnow.need_min', { min: min }); }
        else if (m < min) { st = 'err'; tx = t('auto.why.too_short_min', Object.assign(limitVars(), { value: m })); }
        else if (r && r.code === 'too_short_slot') {
            st = 'err';
            tx = t('auto.sleepnow.no_room', { program: r.slot.program, at: clock(r.slot.at), wake: wakeAt(r.slot.wake), dur: fmtDur(Math.max(0, r.dur_s)) });
        } else if (r && r.capped) {
            st = 'warn';
            tx = t('auto.sleepnow.capped', { program: r.slot.program, at: clock(r.slot.at), dur: fmtDur(r.off_s), wake: wakeAt(r.wake) });
        } else if (r && r.ok) {
            tx = t(r.segmented ? 'auto.sleepnow.preview_seg' : 'auto.sleepnow.preview', { at: clock(r.cut), dur: fmtDur(r.off_s), wake: wakeAt(r.wake) });
        }
        var stops = manualStops();
        if (stops.length && !st) {
            st = 'err';
            tx = t('auto.sleepnow.stopped', { why: stops.map(checkText).join(' ') });
            if (stops.some(function (c) { return c.key === 'ssh'; })) { tx += ' ' + t('auto.sleepnow.ssh_fix'); }
        }
        if (S.sleepPreview.textContent !== tx) { S.sleepPreview.textContent = tx; }
        S.sleepPreview.dataset.state = st;
    }
    function paintSleep() {
        var rep = S.report, sl = rep && rep.sleep;
        var on = val('sleep_enabled');
        var stay = val('stay_awake_until');
        var block = sl && sl.block;
        var toks = [];
        if (on === false) { toks.push({ text: t('common.off') }); }
        else if (S.countdown && S.countdown.active) { toks.push({ text: t('auto.tok.falling'), state: 'warn' }); }
        else if (block) { toks.push({ text: t('auto.tok.awake') }); }
        else if (on) { toks.push({ text: t('common.on'), state: 'ok' }); }
        if (sl && sl.next_wake) { toks.push({ text: when(sl.next_wake) }); }
        head('sleep', on === false ? 'off' : (S.countdown && S.countdown.active ? 'warn' : (on ? 'ok' : 'off')), toks);
        nums('sleep', [
            { k: t('auto.num.next_wake'), v: sl && sl.next_wake ? when(sl.next_wake) : '—' },
            { k: t('auto.num.last_wake'), v: sl && sl.last_wake && sl.last_wake.actual_epoch ? clock(sl.last_wake.actual_epoch * 1000) : '—' },
            { k: t('auto.num.idle'), v: withUnit(num('idle_sleep_threshold_min'), 'min') }
        ]);
        if (S.stayState) {
            var active = stay && (parseIso(stay) || 0) > new Date();
            S.stayState.textContent = active ? t('auto.stay.until', { when: when(stay) }) : '';
            S.stayOff.style.display = active ? '' : 'none';
            S.stayGo.disabled = !S.settings;
        }
        if (S.sleepBtns) { S.sleepBtns.forEach(function (b) { b.disabled = !S.settings; }); }
        paintManual();
        paintLimits();
    }
    /* What the robot really uses. A value here that only the yaml sets says so: it is
       shown because refusals name it, and the Autonomy page cannot change it yet. */
    function paintLimits() {
        var box = $('auto_limits');
        if (!box) { return; }
        var l = L();
        var rows = [
            ['min', VTSleepPlan.minManualMin(l) + ' min', 'yaml'],
            ['wait', fmtDur(l.wait_s), 'yaml'],
            ['off', fmtDur(l.off_s), 'hw'],
            ['min_sleep', fmtDur(l.min_s), 'yaml'],
            ['segment', fmtDur(l.seg_s), 'yaml'],
            ['countdown', fmtDur(l.countdown_s), 'yaml'],
            ['cancel', fmtDur(l.cooldown_s), 'yaml'],
            ['boot', fmtDur(l.boot_s), 'yaml']
        ];
        var sig = JSON.stringify(rows) + l.from_robot + lang();
        if (box.dataset.sig === sig) { return; }
        box.dataset.sig = sig;
        clear(box);
        if (!l.from_robot) { el('p', 'vt-auto-quiet', box, t('auto.limits.defaults')); }
        rows.forEach(function (x) {
            var r = el('div', 'vt-auto-limit', box);
            var c = el('div', 'vt-auto-limit-t', r);
            el('span', null, c, t('auto.limits.' + x[0]));
            el('small', null, c, t('auto.limits.where.' + x[2]));
            el('span', 'vt-auto-limit-v', r, x[1]);
        });
    }
    function paintCountdown() {
        var box = $('auto_countdown');
        if (!box) { return; }
        var p = planNow();
        if (!live(p) || p.cancellable === false) { box.hidden = true; return; }
        if (!box.firstChild) {
            el('span', 'vt-attn-lab', box, t('auto.cd.label'));
            S.cdTxt = el('span', 'vt-attn-txt', box);
            var b = el('button', 'btn btn-sm btn-warning', box, t('auto.cd.cancel'));
            b.type = 'button'; b.id = 'btn_auto_sleep_cancel';
            b.addEventListener('click', cancelSleep);
        }
        var c = S.countdown || {}, who = c.who || {}, n = (who.ssh || []).length + (who.ui || 0);
        var tx = planLine(p);
        if (p.kind === 'countdown' && n) { tx += ' ' + t('auto.cd.people', { n: n }); }
        S.cdTxt.textContent = tx;
        box.hidden = false;
    }
    /* Every place that says the plan, and the clock that keeps them true. */
    function paintPlanLine() {
        var p = planNow(), tx = planLine(p);
        ['auto_sleep_plan', 'auto_sleep_plan2'].forEach(function (id) {
            var e = $(id);
            if (!e) { return; }
            var show = !!tx && !(id === 'auto_sleep_plan' && live(p));
            e.hidden = !show;
            if (show && e.textContent !== tx) { e.textContent = tx; }
            e.dataset.state = (p.kind === 'soon' && p.ignored) ? 'warn' : '';
        });
        if (RP && RP.plan) {
            var near = live(p) || (p.kind === 'soon' && p.cut && p.cut - nowMs() < 600000);
            RP.plan.hidden = !near;
            if (near) {
                RP.planTxt.textContent = tx;
                RP.planBtn.style.display = live(p) && p.cancellable !== false ? '' : 'none';
            }
        }
        return p;
    }
    function tick() {
        var p = paintPlanLine();
        /* the live fix in the GPS line follows the receiver, only the text changes */
        var gl = S.gnssLive;
        if (gl && gl.el.isConnected) { var gt = checkText(gl.c); if (gl.el.textContent !== gt) { gl.el.textContent = gt; } }
        paintCountdown();
        paintRight();
        paintRaw();
        tickHw();
        watchSleep(p);
        notices(p);
        var cm = window.calendarManager;
        if (p.kind === 'countdown' && cm && cm._paintState) { cm._paintState(); }
    }
    function onCountdown(c) {
        var was = S.countdown && S.countdown.active;
        S.countdown = c;
        /* left_s comes down with every message, cd_at is the time of the last one */
        S.cdAt = Date.now();
        if (c && c.active && !was) { S.cdFirst = Date.now(); }
        tick(); paintSleep();
    }

    /* ---------------------------------------- what came of a Sleep now */
    function watchSleep(p) {
        var ask = S.sleepAsk;
        if (!ask) { return; }
        if (Date.now() - ask.t > 1800000) { S.sleepAsk = null; return; }
        if (!ask.ok) {
            if (Date.now() - ask.t > 8000) {
                msgOf({ msg: S.sleepMsg }, 'err', t('auto.msg.no_answer_sleep'));
                S.sleepAsk = null;
            }
            return;
        }
        if (live(p)) { ask.seen = true; return; }
        if (!ask.seen && Date.now() - ask.t < 6000) { return; }
        var sl = (S.report && S.report.sleep) || {};
        var why = sl.result && sl.result !== 'cut' ? sl.result : sl.block;
        S.sleepAsk = null;
        if (S.n.cancelled) { msgOf({ msg: S.sleepMsg }, 'ok', t('auto.n.sleep_cancelled_plain')); return; }
        msgOf({ msg: S.sleepMsg }, 'err', t('auto.msg.sleep_failed', { why: why ? whyText(why) : t('auto.msg.refused_plain') }));
    }

    /* ------------------------------------------- the line above the map */
    function say(key, level, text, o) {
        if (window.VTNotice) { VTNotice.say(Object.assign({ key: 'a:' + key, level: level, text: text }, o || {})); }
    }
    function unsay(key) { if (window.VTNotice) { VTNotice.clear('a:' + key); } }
    var CODE_NOTICE = {
        starting: 2, loading_map: 2, waiting_gps: 1, waiting_weather: 1, waiting_temp: 1, waiting_temp_spike: 1,
        waiting_critical: 1, waiting_rejected: 1, waiting_battery: 2, waiting_mower_link: 1, run_off_dock: 1,
        off_dock_stuck: 0, blocked_pm_armed: 1, blocked_mux_hold: 1, held: 2
    };
    function stopLine(rep) {
        var code = rep && rep.code;
        if (code === 'blocked_stopped' || S.smach === 'Stopped') { return 'auto.n.stopped'; }
        if (code === 'blocked_terminal' || S.smach === 'TERMINAL ERROR') { return 'auto.n.terminal'; }
        if (S.smach === 'Critical error') { return 'auto.n.critical'; }
        return null;
    }
    function notices(p) {
        var rep = S.report, n = S.n;
        if (!rep || !window.VTNotice) { return; }
        var cancelAct = { text: t('auto.cd.cancel'), fn: cancelSleep };

        /* STOP-level: stays until it is over */
        var stop = stopLine(rep);
        if (stop !== (n.stop || null)) {
            if (n.stop) { unsay('stop'); }
            n.stop = stop;
        }
        if (stop) { say('stop', 0, t(stop), { sticky: true }); }

        /* the sleep */
        if (live(p)) { unsay('sleep_soon'); }
        if (p.kind === 'countdown' || (p.kind === 'sequence' && p.cancellable)) {
            /* a phone's line is one short row, the whole sentence is in the panel */
            var short = window.innerWidth < 600 && p.kind === 'countdown' && p.wake && p.mode !== 'charged' && !isHwReset(p);
            say('sleep', 1, short ? t('auto.sp.countdown_short', { s: Math.ceil(p.left_s), wake: wakeAt(p.wake) }) : planLine(p),
                { sticky: true, action: cancelAct });
            n.sleeping = true;
        } else if (p.kind === 'sequence') {
            say('sleep', 1, t('auto.n.sleep_cut'), { sticky: true });
            n.sleeping = true;
        } else {
            if (n.sleeping) {
                unsay('sleep');
                n.sleeping = false;
                n.after = Date.now();
            }
            if (n.after) {
                /* the countdown topic and the report come apart: give the reason a moment */
                var h = p.holds || VTSleepPlan.holds(rep.sleep, nowMs(), S.reportAt + S.skew);
                var gaveUp = Date.now() - n.after > 3000;
                if (h.cancelled_until) { say('sleep_off', 1, t('auto.n.sleep_cancelled', { until: clock(h.cancelled_until) })); }
                else if (h.failed) { say('sleep_off', 0, t('auto.n.sleep_failed', { why: whyText(h.failed) })); }
                else if (gaveUp && n.cancelled) { say('sleep_off', 1, t('auto.n.sleep_cancelled_plain')); }
                if (h.cancelled_until || h.failed || gaveUp) { n.after = 0; n.cancelled = false; }
            }
            if (p.kind === 'soon' && !n.first) {
                var left = (p.cut - nowMs()) / 60000;
                /* once per planned wake: 5 minutes ahead when that much is known */
                var mark = Math.round((p.wake || 0) / 300000);
                if (left <= 6 && left > 1.5 && n.soon !== mark) {
                    n.soon = mark;
                    say('sleep_soon', 1, t('auto.n.sleep_soon', { min: Math.ceil(left), dur: fmtDur(p.off_s), wake: wakeAt(p.wake) }));
                }
            }
        }

        /* what the report says changed */
        if (rep.code !== n.code) {
            var was = n.code;
            n.code = rep.code;
            var lvl = CODE_NOTICE[rep.code];
            if (lvl !== undefined && !n.first) {
                var cm = window.calendarManager;
                var key = 'auto.n.code.' + rep.code;
                var d = Object.assign({ program: (rep.run && rep.run.program) || '' }, rep.detail || {});
                if (d.left_s !== undefined) { d.min = Math.max(1, Math.ceil(d.left_s / 60)); }
                var tx = has(key) ? t(key, d) : (cm && cm._sentence ? cm._sentence(rep) : '');
                if (tx) { say(rep.code === 'starting' ? 'run_start' : 'state', lvl, tx); }
            }
            if (was === 'off_dock_stuck') { unsay('state'); }
        }
        n.first = false;
    }
    function onSmach(status) {
        var prev = S.smach;
        S.smach = status;
        if (status === prev || !prev) { return; }
        if (status === 'Undocking') { say('run_start', 2, t('auto.n.code.starting', { program: S.program || '' })); }
        else if (status === 'Returning to dock') { say('return', 2, t('auto.n.returning')); }
        tick();
    }
    function onLink(l) {
        if (!l) { return; }
        var was = S.n.link, banner = l.banner || '';
        S.mowerLink = banner;
        if (banner === was) { return; }
        S.n.link = banner;
        paintLink();
        if (banner) { say('link', banner === 'recovering' ? 1 : 0, t('auto.link.' + banner), { sticky: true }); }
        else if (was) { unsay('link'); say('link_ok', 2, t('auto.n.link_ok')); }
    }
    /* /mower/link's banner: the Autonomy page and the right panel */
    function paintLink() {
        var banner = S.mowerLink, box = $('auto_link');
        if (box) {
            box.hidden = !banner;
            box.textContent = banner ? t('auto.link.' + banner) : '';
            box.dataset.state = banner === 'recovering' ? 'warn' : 'err';
        }
        if (RP) {
            RP.link.hidden = !banner;
            RP.link.textContent = banner ? t('auto.link.' + banner) : '';
            paintRight();
        }
    }
    function onRules(st) {
        var nogo = ((st && st.in) || []).filter(function (x) { return x && x.type === 'nogo'; }).map(function (x) { return x.name; }).join(', ');
        var blade = st && st.blade;
        var nbAll = ((st && st.in) || []).filter(function (x) { return x && x.type === 'noblade'; }).map(function (x) { return x.name; }).join(', ');
        var sig = nogo + '|' + blade + '|' + ((st && st.held_by) || '') + '|' + nbAll;
        if (sig === S.n.rules) { return; }
        S.n.rules = sig;
        if (nogo) { say('rules', 0, t('maprules.in_nogo', { name: nogo })); }
        else if (blade === 'restore_failed') { say('rules', 0, t('maprules.blade_failed')); }
        else if (blade === 'stopped_by_rule') {
            var nb = ((st && st.in) || []).filter(function (x) { return x && x.type === 'noblade'; }).map(function (x) { return x.name; }).join(', ');
            // Outside the zone it mows (zone fence): a normal transit, no notice.
            if (nb || st.held_by !== 'zone') { say('rules', 1, nb ? t('maprules.blade_stopped', { name: nb }) : t('maprules.blade_stopped_any')); }
        }
    }
    /* New entries only; the first message is the past. */
    function onJournal(list) {
        var n = S.n;
        var sig = function (j) { return j.t + j.kind + j.code + (j.program || ''); };
        if (n.seen === null) { n.seen = {}; list.forEach(function (j) { n.seen[sig(j)] = 1; }); return; }
        list.forEach(function (j) {
            if (n.seen[sig(j)]) { return; }
            n.seen[sig(j)] = 1;
            var v = Object.assign({ program: j.program || '' }, j.vars || {});
            if (j.kind === 'finished' && j.code === 'succeeded') { say('done', 2, t('auto.n.done', v)); }
            else if (j.kind === 'finished' && j.code === 'stopped') { say('done', 2, t('auto.n.stopped_run', v)); }
            else if (j.kind === 'finished') { say('done', 0, t('auto.n.failed', Object.assign(v, { why: journalText(j) }))); }
            else if (j.kind === 'skipped') { say('skip', 1, t('auto.n.skipped', Object.assign(v, { why: first(['auto.tl.reason.' + j.code, 'auto.tl.state.' + j.code]) || j.code }))); }
            else if (j.kind === 'missed') { say('skip', 1, t('auto.n.missed', v)); }
            else if (j.kind === 'woke') { say('woke', 2, t('auto.n.woke')); }
            else if (j.code === 'hw_reset_person' || j.code === 'hw_reset_spent') { say('hw_reset', 0, t('calmgr.issue.' + j.code, v)); }
        });
    }
    /* The robot's common lines are English in its code. */
    var LINES = [[/^Waiting for dock cmd$/, 'dock_wait'], [/^Executing program: (.+)$/, 'exec'], [/^Resuming program: (.+)$/, 'resume'],
                 [/^Returning to dock/, 'return'], [/^Turn on mower$/, 'mower_on'], [/^Mower is ready$/, 'mower_ready'],
                 [/^Go to zone begin$/, 'zone'], [/^Loading the map$/, 'map'], [/^Rtabmap is ready$/, 'map_ready'],
                 [/^Mower link lost/, 'link_lost'], [/^No mower status/, 'link_gap'], [/^Blade stopped during mowing/, 'blade_stopped'],
                 [/^Mower link not recovered/, 'link_home'],
                 [/^Both GPS ready$/, 'gps'], [/^Window closed, going home$/, 'window_home'], [/^Reset accepted/, 'reset']];
    function robotLine(text) {
        for (var i = 0; i < LINES.length; i++) {
            var m = LINES[i][0].exec(String(text));
            if (m) { return t('auto.line.' + LINES[i][1], { x: m[1] || '' }); }
        }
        return null;
    }

    /* ------------------------------------------------- hard reset */
    function hwPm() {
        var p = S.pm;
        if (!p) { return {}; }
        return { w_ms: Number(p.sleep_wait_standby), t_ms: Number(p.sleep_time_interval),
                 armed: !!(p.sleep_status || p.sleep_charged_status), online: p.supply_status === 'ONLINE',
                 fresh: S.link !== false && Date.now() - p.at < 5000 };
    }
    /* What stops it, the first one, from the master's report and the mission's status.
       Asked up to the moment of the arm: the master knows nothing of this. */
    function hwGuard(own) {
        var rep = S.report, sl = rep && rep.sleep;
        if (!rep || !sl) { return 'no_report'; }
        var pm = hwPm();
        if (!pm.fresh) { return 'no_pm'; }
        if (!pm.online) { return 'not_online'; }
        if (sl.state && sl.state !== 'IDLE') { return 'sequence'; }
        if (S.countdown && S.countdown.active) { return 'countdown'; }
        if (!own && pm.armed) { return 'raw'; }
        var bad = (sl.checks || []).filter(function (c) {
            return c.state === 'block' && (c.key === 'dock' || c.key === 'mission' || c.key === 'manual' || c.key === 'agent');
        })[0];
        if (bad) { return bad.key; }
        if (rep.state === 'MOWING' || rep.state === 'WAIT_OFF_DOCK' || rep.state === 'PREPARE_SLEEP') { return 'mission'; }
        if (S.smach && S.smach !== 'Ready') { return 'mission'; }
        return null;
    }
    function hwSend(what, v) {
        if (what === 'wait') { pub('/pm/set_sleep_wait_before_standby', 'std_msgs/UInt64', v); }
        else if (what === 'time') { pub('/pm/set_sleep_time', 'std_msgs/UInt64', v); }
        else { pub('/pm/set_robot_sleep', 'std_msgs/Bool', what === 'arm'); }
    }
    function hw() {
        if (!S.hw && window.VTHwReset) {
            S.hw = VTHwReset.make({
                now: function () { return Date.now(); }, send: hwSend,
                store: function (r) {
                    try {
                        if (r) { localStorage.setItem(VTHwReset.RECORD, JSON.stringify(r)); }
                        else { localStorage.removeItem(VTHwReset.RECORD); }
                    } catch (e) { /* private mode: only the report after a reload is lost */ }
                }
            });
            var rec = null;
            try { rec = JSON.parse(localStorage.getItem(VTHwReset.RECORD) || 'null'); } catch (e) { rec = null; }
            S.hw.resume(rec);
        }
        return S.hw;
    }
    function hwN(box) {
        var i = box.querySelector('.vt-hw-n'), n = i ? Number(i.value) : 0;
        return n >= VTHwReset.N_MIN && n <= VTHwReset.N_MAX ? Math.round(n) : null;
    }
    function buildHw() {
        ['auto_hw', 'auto_hw2'].forEach(function (id) {
            var box = $(id);
            if (!box || box.dataset.built || !window.VTHwReset) { return; }
            box.dataset.built = '1';
            el('div', 'vt-auto-set-l', box, t('auto.hw.title'));
            el('small', 'vt-auto-set-h', box, t('auto.hw.hint'));
            var line = el('div', 'vt-auto-line', box);
            var n = el('input', 'form-control form-control-sm vt-auto-in vt-hw-n', line);
            n.type = 'number'; n.min = VTHwReset.N_MIN; n.max = VTHwReset.N_MAX; n.value = VTHwReset.N_DEFAULT;
            n.inputMode = 'numeric'; n.setAttribute('aria-label', t('auto.hw.seconds'));
            el('span', 'vt-auto-unit', line, 's');
            var b = el('button', 'btn btn-sm btn-outline-danger vt-hw-go', line, t('auto.hw.go'));
            b.type = 'button';
            b.addEventListener('click', function () {
                var v = hwN(box), g = hwGuard(false);
                var st = box.querySelector('.vt-hw-state');
                if (v === null) { st.textContent = t('auto.hw.range', { min: VTHwReset.N_MIN, max: VTHwReset.N_MAX }); return; }
                if (g) { st.textContent = t('auto.hw.refused', { why: t('auto.hw.g.' + g) }); return; }
                st.textContent = '';
                var c = box.querySelector('.vt-hw-confirm');
                clear(c);
                el('span', 'vt-attn-txt', c, t('auto.hw.confirm', { n: v }));
                var row = el('div', 'vt-auto-choice-row', c);
                var yes = el('button', 'btn btn-sm btn-danger vt-hw-yes', row, t('auto.hw.yes', { n: v }));
                yes.type = 'button';
                var no = el('button', 'btn btn-sm btn-outline-secondary', row, t('common.cancel'));
                no.type = 'button';
                no.addEventListener('click', function () { c.hidden = true; });
                yes.addEventListener('click', function () {
                    c.hidden = true;
                    var again = hwGuard(false);
                    if (again) { st.textContent = t('auto.hw.refused', { why: t('auto.hw.g.' + again) }); return; }
                    hw().start(v, hwPm());
                    tick();
                });
                c.hidden = false;
                c.scrollIntoView({ block: 'nearest' });
            });
            var c = el('div', 'vt-attn vt-hw-confirm', box);
            c.dataset.state = 'err'; c.hidden = true;
            el('div', 'vt-auto-msg vt-auto-msg-w vt-hw-state', box).setAttribute('aria-live', 'polite');
            var x = el('button', 'btn btn-sm btn-warning vt-hw-cancel', box, t('auto.cd.cancel'));
            x.type = 'button'; x.hidden = true;
            x.addEventListener('click', function () { hw().cancel(); tick(); });
        });
    }
    function hwText(s) {
        var r = s.result;
        if (r) {
            var code = r.split(':')[0], why = r.split(':')[1];
            return t('auto.hw.r.' + code, { away: s.away_s === null || s.away_s === undefined ? '?' : s.away_s, why: why ? t('auto.hw.g.' + why) : '' });
        }
        return '';
    }
    function tickHw() {
        var h = hw();
        if (!h) { return; }
        var s = h.state, phase = s.phase;
        var own = phase === 'params' || phase === 'arm' || phase === 'armed';
        h.tick({ pm: hwPm(), busy: own ? hwGuard(true) : null, link: S.link !== false });
        phase = s.phase;
        var tx = phase === 'idle' || phase === 'restore' ? hwText(s) : '';
        var running = phase === 'params' || phase === 'arm' || phase === 'armed';
        if (phase === 'params' || phase === 'arm') { tx = t('auto.hw.preparing'); }
        if (phase === 'armed') { tx = t('auto.hw.counting', { s: Math.ceil(h.left_s()), n: s.n }); }
        if (phase === 'cancelling') { tx = t('auto.hw.cancelling'); }
        if (phase === 'gone') { tx = t('auto.hw.gone', { n: s.n }); }
        ['auto_hw', 'auto_hw2'].forEach(function (id) {
            var box = $(id);
            if (!box || !box.dataset.built) { return; }
            var st = box.querySelector('.vt-hw-state');
            if (tx && st.textContent !== tx) { st.textContent = tx; }
            box.querySelector('.vt-hw-go').disabled = phase !== 'idle' && phase !== 'restore';
            box.querySelector('.vt-hw-cancel').hidden = !running;
        });
        if (phase === 'armed') {
            say('hw', 0, tx, { sticky: true, action: { text: t('auto.cd.cancel'), fn: function () { h.cancel(); tick(); } } });
        } else if (S.n.hw) { unsay('hw'); }
        S.n.hw = phase === 'armed';
        if (s.result && s.result !== S.n.hwDone) {
            S.n.hwDone = s.result;
            var bad = /^(cancel_unconfirmed|no_cut|no_ack|no_readback|lost)/.test(s.result);
            say('hw_done', bad ? 0 : 1, hwText(s));
        }
    }

    /* ------------------------------------ Settings › Power, raw sleep */
    function rawNow() {
        var s = S.pm;
        return s && s.sleep_time_interval ? Math.round(s.sleep_time_interval / 60000) : null;
    }
    function paintRaw() {
        var box = $('auto_raw_state');
        if (!box || box.dataset.ask) { return; }
        var armed = rawArmed(), kept = rawNow(), tx = '';
        if (armed) {
            if (!S.rawFrom) { S.rawFrom = Date.now(); }
            var w = (S.pm.sleep_wait_standby || 0), cut = S.rawFrom + w, wake = S.rawFrom + (S.pm.sleep_time_interval || 0);
            tx = t(S.pm.sleep_charged_status ? 'auto.raw.armed_charged' : 'auto.raw.armed', { at: clock(cut), wake: wakeAt(wake) });
        } else {
            S.rawFrom = 0;
            if (kept !== null) { tx = t('auto.raw.kept', { min: kept }); }
        }
        if (box.textContent !== tx) { box.textContent = tx; }
    }
    /* Timed in Settings › Power: says the number, then needs a second press. */
    function rawTimed(pm) {
        var box = $('auto_raw_state');
        if (!box) { pm.pub_start_sleep(); return; }
        var typed = parseInt(pm.input_sleep_time_min && pm.input_sleep_time_min.value, 10);
        var min = typed > 0 ? typed : rawNow();
        var l = L(), floor = Math.ceil((l.wait_s + l.off_s) / 60);
        if (window.VTHwReset && S.hw && S.hw.state.phase !== 'idle') { return; }
        box.dataset.ask = '1';
        clear(box);
        var done = function () { delete box.dataset.ask; clear(box); paintRaw(); };
        if (!min || min <= floor - 1 || min * 60 < l.wait_s + l.off_s) {
            el('div', 'vt-tone-warn', box, t('auto.raw.too_short', { min: min || 0, floor: floor }));
            setTimeout(done, 8000);
            return;
        }
        el('div', 'vt-tone-warn', box, t('auto.raw.confirm', { min: min, wake: wakeAt(nowMs() + min * 60000) }));
        var row = el('div', 'vt-auto-choice-row', box);
        var yes = el('button', 'btn btn-sm btn-warning', row, t('auto.raw.go'));
        yes.type = 'button'; yes.id = 'btn_auto_raw_go';
        var no = el('button', 'btn btn-sm btn-outline-secondary', row, t('common.cancel'));
        no.type = 'button';
        no.addEventListener('click', done);
        yes.addEventListener('click', function () {
            done();
            if (typed > 0 && typed !== rawNow()) {
                pm.pub_set_sleep_time(typed);
                setTimeout(function () { pm.pub_start_sleep(); }, 800);    // the value before the flag
            } else { pm.pub_start_sleep(); }
        });
    }

    /* run_next says <check key>:<code>: the same line the checklist shows */
    function commandWhy(code) {
        var m = /^([a-z_]+):(.+)$/.exec(String(code));
        var name = m && has('auto.check.key.' + m[1]) ? m[1] : null;
        if (!name) { return whyText(code); }
        var c = ((S.report && S.report.checks) || []).filter(function (x) { return x.key === name; })[0];
        return c && c.code === m[2] ? checkText(c) : t('auto.check.state.block', { what: t('auto.check.key.' + name) });
    }
    function onCommand(r) {
        if (r && r.cmd === 'set_mode') { onModeResult(r); return; }
        if (!r || !S.sleepMsg) { return; }
        /* latched: the answer to somebody's press long ago comes at every page load */
        if (r.cmd === 'run_next') {
            if (Date.now() - S.runAsk > 15000) { return; }
            S.runAsk = 0;
            msgOf({ msg: S.planMsg }, r.ok ? 'ok' : 'err', r.ok ? t(r.code === 'due' ? 'auto.msg.run_due' : 'auto.msg.sent')
                : t('auto.msg.cmd_refused', { why: commandWhy(r.code) }));
            return;
        }
        var ask = S.sleepAsk;
        if (!ask || ask.ok) { return; }
        if (r.ok) {
            ask.ok = true;
            msgOf({ msg: S.sleepMsg }, 'ok', t(r.code === 'countdown' ? 'auto.msg.sleep_counting' : 'auto.msg.sleep_going', { cd: L().countdown_s }));
            tick();
            return;
        }
        S.sleepAsk = null;
        msgOf({ msg: S.sleepMsg }, 'err', t('auto.msg.cmd_refused', { why: commandWhy(r.code) }));
    }

    /* ------------------------------------------------------ recovery */
    function paintRecovery() {
        var run = S.report && S.report.run, lim = (S.report && S.report.limits) || {};
        var crit = run ? (run.critical || 0) : 0, res = run ? (run.resumes || 0) : 0;
        var bad = run && crit > 0;
        head('recovery', bad ? 'warn' : 'off', run ? [{ text: t('auto.tok.errors', { n: crit, max: lim.critical || '?' }), state: bad ? 'warn' : undefined }]
            : [{ text: t('auto.tok.no_run') }]);
        nums('recovery', [
            { k: t('auto.num.errors'), v: run ? crit + ' / ' + (lim.critical || '?') : '—' },
            { k: t('auto.num.resumes'), v: run ? res + ' / ' + (lim.resumes || '?') : '—' },
            { k: t('auto.num.max_age'), v: withUnit(num('run_max_age_h'), 'h') }
        ]);
    }

    /* ------------------------------------------------------- history */
    var JFILTER = { all: null, runs: ['started', 'finished', 'skipped', 'missed'], waits: ['waited'],
                    agent: ['advice', 'mode'], sleep: ['slept', 'woke'], settings: ['settings'] };
    function buildFilter() {
        var box = $('auto_journal_filter');
        if (!box || box.dataset.built) { return; }
        box.dataset.built = '1';
        Object.keys(JFILTER).forEach(function (f) {
            var b = el('button', 'vt-auto-fbtn', box, t('auto.j.filter.' + f));
            b.type = 'button'; b.dataset.f = f;
            b.addEventListener('click', function () { S.filter = f; paintHistory(); });
        });
    }
    function journalText(j) {
        var v = Object.assign({ program: j.program || '' }, j.vars || {});
        if (v.blocked_by) { v.why = first(['calmgr.code.' + v.blocked_by]) || v.blocked_by; }
        if (Array.isArray(v.keys)) { v.keys = v.keys.join(', '); }
        if (v.ms) { v.dur = fmtDur(v.ms / 1000); }
        if (j.kind === 'advice') {
            if (v.why) { v.why = whyCode(v.why, v); }
            if (v.until) { v.until = when(v.until); }
            v.what = adviceText({ action: v.action, program: j.program, from: v.start, to: v.end, until: (j.vars || {}).until });
        }
        if (/^limit_/.test(j.code)) { v.limit = limitText(j.code, v); }
        return first(['auto.j.' + j.kind + '.' + j.code, 'auto.j.' + j.kind], v)
            || (first(['auto.j.kind.' + j.kind]) || j.kind) + (j.program ? ' ' + j.program : '');
    }
    function paintHistory() {
        var rep = S.report, box = $('auto_journal');
        if (!box) { return; }
        var issues = (rep && rep.issues) || [], list = S.journal;
        var worst = issues.some(function (i) { return i.level === 'err' || i.level === 'error'; }) ? 'err' : (issues.length ? 'warn' : 'off');
        var toks = [];
        if (issues.length) { toks.push({ text: t('auto.tok.issues', { n: issues.length }), state: worst }); }
        if (list && list.length) { toks.push({ text: when(list[list.length - 1].t) }); }
        head('history', worst, toks);
        document.querySelectorAll('.vt-auto-fbtn').forEach(function (b) { b.classList.toggle('vt-sel', b.dataset.f === S.filter); });
        var f = $('auto_journal_filter');
        if (f) { f.style.display = list ? '' : 'none'; }
        clear(box);
        if (!list) { return; }
        var shown = list.slice().reverse().filter(function (j) {
            return !JFILTER[S.filter] || JFILTER[S.filter].indexOf(j.kind) >= 0;
        });
        if (!shown.length) { el('li', 'vt-empty', box, t('auto.j.empty')); return; }
        shown.forEach(function (j) {
            var li = el('li', 'vt-act', box);
            li.dataset.state = j.kind === 'missed' ? 'warn' : (j.kind === 'finished' ? 'ok'
                : (j.kind === 'started' || j.kind === 'advice' || j.kind === 'mode' ? 'info' : 'off'));
            el('span', 'vt-sdot', li);
            el('span', 'vt-act-txt', li, journalText(j));
            el('span', 'vt-act-time', li, when(j.t));
        });
    }
    function paintAlert() {
        var box = $('auto_alert');
        if (!box) { return; }
        var issues = (S.report && S.report.issues) || [];
        var hot = issues.filter(function (i) { return i.level && i.level !== 'info'; });
        var list = hot.length ? hot : [];
        box.hidden = !list.length;
        if (!list.length) { return; }
        var i = list[list.length - 1];
        box.dataset.state = list.some(function (x) { return /^err/.test(x.level); }) ? 'err' : 'warn';
        clear(box);
        el('span', 'vt-attn-lab', box, t('auto.alert.label'));
        var d = Object.assign({ program: i.program || '' }, i.detail || {});
        if (d.slot) { d.slot = String(d.slot).replace('T', ' '); }
        var txt = first(['calmgr.issue.reason.' + d.reason, 'calmgr.issue.' + i.code], d) || i.code;
        el('span', 'vt-attn-txt', box, txt);
        var b = el('button', 'btn btn-sm btn-link vt-auto-alert-go', box, t('auto.alert.more'));
        b.type = 'button';
        b.addEventListener('click', function () { openSec('history', true); });
    }

    /* ------------------------------------------------- panel, sections */
    function secKey(id) { return 'vitulus_auto_sec_' + id; }
    function setupSections() {
        SECTIONS.forEach(function (id) {
            var s = $('auto_sec_' + id);
            if (!s) { return; }
            var v = null;
            try { v = localStorage.getItem(secKey(id)); } catch (e) {}
            s.open = v === null ? !!OPEN_DEFAULT[id] : v === '1';
            s.addEventListener('toggle', function () {
                try { localStorage.setItem(secKey(id), s.open ? '1' : '0'); } catch (e) {}
            });
        });
    }
    function openSec(id, scroll) {
        var mm = window.map_menu;
        if (mm && mm.current_submenu !== 'autonomy' && mm.btn_autonomy) { mm.btn_autonomy.onclick(); }
        var s = $('auto_sec_' + id);
        if (!s) { return; }
        s.open = true;
        if (scroll) { setTimeout(function () { s.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60); }
    }

    function paintAll() {
        paintMode(); paintNow(); paintPlan(); paintRain(); paintBattery(); paintSleep();
        paintRecovery(); paintHistory(); paintAlert(); paintRight();
        var locked = S.settings && S.settings.schema
            ? Object.keys(S.settings.schema).filter(function (k) { return S.settings.schema[k].locked; }).length : 0;
        head('advanced', 'off', locked ? [{ text: t('auto.tok.locked', { n: locked }) }] : []);
    }

    /* Rain would refuse this manual start: ask. true = the dialog took over. */
    function askRain(go, code) {
        var p = $('p_modal_rain_run_why');
        if (p) { p.textContent = t('auto.rainrun.' + (RAIN_CODES[code] ? code : 'rain')); }
        var b = $('btn_modal_rain_run_go');
        if (b) {
            b.onclick = function () {
                window.jQuery('#modal_rain_run').modal('hide');
                pub('/scheduler/ignore_rain_once', 'std_msgs/Bool', true);
                setTimeout(go, 150);    // armed before the program is selected
            };
        }
        window.jQuery('#modal_rain_run').modal('show');
    }
    function runGate(go) {
        var code = S.report && S.report.rain_would_refuse;
        if (!code || !RAIN_CODES[code]) {
            /* report.reject stays from the last refusal: only a new one counts */
            S.lastRun = { go: go, t: Date.now(), was: S.report && S.report.reject };
            return false;
        }
        askRain(go, code);
        return true;
    }
    /* The forecast can change between the look and the start: a refusal that
       comes right after Run opens the same choice. */
    function afterReport() {
        /* report.reject = last refused start, also by hand; run.reject only for calendar runs */
        var r = S.report && S.report.run, last = S.lastRun;
        var c = (S.report && S.report.reject) || (r && r.reject);
        if (last && c && c !== last.was && RAIN_CODES[c] && Date.now() - last.t < 30000) {
            S.lastRun = null;
            askRain(last.go, c);
        }
    }

    /* ---------------------------------------- right panel (status token) */
    var RP = null;
    function rightSection(sec, h, box) {
        RP = { sec: sec, h: h, box: box };
        var w = h.querySelector('.rp-tokens') || h;
        RP.chip = el('span', 'vt-chip vt-chip-sm rp-auto-chip', w);
        RP.chip.dataset.state = 'off';
        RP.cells = el('div', 'rp-cells', box);
        var mk = function (key) {
            var c = el('div', 'rp-cell', RP.cells);
            var k = el('span', 'rp-cell-k', c, t(key));
            if (window.VTI18n) { VTI18n.tag(k, key); }
            return el('span', 'rp-cell-v', c);
        };
        RP.next = mk('auto.num.next_short');
        RP.batt = mk('auto.num.batt_short');
        RP.rain = mk('auto.num.rain_short');
        RP.link = el('div', 'rp-auto-link', box);
        RP.link.hidden = true;
        RP.plan = el('div', 'rp-auto-plan', box);
        RP.plan.hidden = true;
        RP.planTxt = el('span', null, RP.plan);
        RP.planBtn = el('button', 'btn btn-sm btn-warning', RP.plan, t('auto.cd.cancel'));
        RP.planBtn.type = 'button'; RP.planBtn.id = 'btn_rp_sleep_cancel';
        if (window.VTI18n) { VTI18n.tag(RP.planBtn, 'auto.cd.cancel'); }
        RP.planBtn.addEventListener('click', function (e) { e.stopPropagation(); cancelSleep(); });
        setTimeout(paintLink, 0);
        setTimeout(paintRight, 0);     // the report may have come before the panel was built
        return 1;
    }
    function paintRight() {
        var rep = S.report;
        if (!RP || !rep) { return; }
        var cm = window.calendarManager;
        var look = cm && cm._codeLook ? cm._codeLook(rep.code) : ['active', 'ok'];
        var issues = (rep.issues || []).filter(function (i) { return i.level && i.level !== 'info'; });
        var tone = issues.length ? (issues.some(function (i) { return /^err/.test(i.level); }) ? 'err' : 'warn')
            : (look[1] === 'ok' || look[1] === 'off' ? 'off' : look[1]);
        var word = issues.length ? t('auto.alert.label') : t('calmgr.state.' + look[0]);
        if (!issues.length && look[1] === 'ok' && rep.next && rep.enabled) {
            var d = parseIso(rep.next.at);
            if (d) { word = clock(d.getTime()); }
        }
        var pl = planNow();
        if (!issues.length && live(pl)) {
            tone = 'warn';
            word = pl.kind === 'countdown' ? t('auto.tok.sleep_in', { s: Math.ceil(pl.left_s) }) : t('auto.tok.falling');
        }
        if (S.mowerLink) {
            tone = S.mowerLink === 'recovering' ? 'warn' : 'err';
            word = t('auto.tok.link');
        }
        RP.chip.textContent = word;
        RP.chip.dataset.state = tone;
        RP.chip.title = planLine(pl) || (cm && cm._sentence ? cm._sentence(rep) : '') || word;
        if (RP.sec.dataset.tone !== tone) { RP.sec.dataset.tone = tone; }
        RP.next.textContent = rep.next ? when(rep.next.at) : '—';
        RP.batt.textContent = rep.battery !== null && rep.battery !== undefined ? Math.round(rep.battery) + ' %' : '—';
        RP.rain.textContent = t('auto.tok.' + radar().key.split('.').pop());
        var dot = document.getElementById('rp_sum_dot_auto');
        if (dot) {
            dot.dataset.state = tone;
            dot.style.display = issues.length ? '' : 'none';
            dot.title = word;
        }
    }

    /* ---------------------------------------------------------- start */
    /* The master's limits are yaml parameters. Not published: read as rosparam. */
    function readLimits() {
        if (!S.ros || !window.VTSleepPlan) { return; }
        ['sleep_wait_before_standby_s', 'sleep_min_off_s', 'sleep_min_s', 'sleep_timer_drift', 'sleep_countdown_s',
         'sleep_fail_cooldown_s', 'boot_grace_period_s', 'check_interval_s', 'sleep_max_segment_h'].forEach(function (p) {
            try {
                new ROSLIB.Param({ ros: S.ros, name: '/master_controller/' + p }).get(function (v) {
                    S.params[p] = v;
                    S.limits = VTSleepPlan.limits(S.params);
                    paintManual(); paintLimits();
                });
            } catch (e) { /* the defaults stay and say so */ }
        });
        try {
            new ROSLIB.Service({ ros: S.ros, name: '/rosapi/get_time', serviceType: 'rosapi/GetTime' })
                .callService(new ROSLIB.ServiceRequest({}), function (r) {
                    if (r && r.time && r.time.secs) {
                        var skew = r.time.secs * 1000 - Date.now();
                        S.skew = Math.abs(skew) > 30000 ? skew : 0;   // ROS time has no fraction to trust
                    }
                });
        } catch (e) { /* the browser's clock */ }
    }
    function init(ros) {
        S.ros = ros;
        setupSections();
        // advertised early: the first message after an advertise can get lost
        [['/scheduler/set_settings', 'std_msgs/String'], ['/scheduler/sleep_now', 'std_msgs/String'],
         ['/scheduler/sleep_cancel', 'std_msgs/Bool'], ['/scheduler/ignore_rain_once', 'std_msgs/Bool'],
         ['/scheduler/run_next', 'std_msgs/Bool'], ['/scheduler/set_mode', 'std_msgs/String']].forEach(function (x) {
            S.pubs[x[0]] = new ROSLIB.Topic({ ros: ros, name: x[0], messageType: x[1] });
            S.pubs[x[0]].advertise();
        });
        buildRainMode(); buildMode(); buildPlanActions(); buildSleep(); buildFilter(); buildHw();
        readLimits();
        document.addEventListener('rosconnected', function () { S.link = true; readLimits(); });
        document.addEventListener('rosdisconnected', function () { S.link = false; });
        document.addEventListener('rosconnecting', function () { S.link = false; });
        subJson('/scheduler/mode', function (o) { S.mode = o; paintMode(); paintRight(); });
        subJson('/scheduler/report', function (r) { S.report = r; S.reportAt = Date.now(); if (r && r.mode) { S.mode = r.mode; } paintAll(); paintSettings(); afterReport(); tick(); });
        subJson('/scheduler/timeline', function (o) { S.timeline = o; paintTimeline(); paintUsed(); });
        subJson('/scheduler/journal', function (o) { S.journal = o.entries || []; paintHistory(); onJournal(S.journal); });
        subJson('/scheduler/settings', function (o) { S.settings = o; paintSettings(); paintAll(); });
        subJson('/scheduler/settings_result', onResult);
        subJson('/scheduler/command_result', onCommand);
        subJson('/scheduler/sleep_countdown', onCountdown);
        sub('/weather_alert/rain_alert', 'weather_alert/RainAlert', function (m) { S.rain = m; paintRain(); paintRight(); });
        sub('/pm/power_status', 'vitulus_ups/power_status', function (m) {
            S.pm = { sleep_status: m.sleep_status, sleep_charged_status: m.sleep_charged_status, at: Date.now(),
                     sleep_time_interval: m.sleep_time_interval, sleep_wait_standby: m.sleep_wait_standby,
                     supply_status: m.supply_status };
        });
        sub('/mower_smach/status', 'std_msgs/String', function (m) { onSmach(m.data); });
        sub('/mower_smach/active_program', 'std_msgs/String', function (m) { S.program = String(m.data || '').trim(); });
        subJson('/mower/link', onLink);
        subJson('/map_rules/state', onRules);
        setInterval(tick, 1000);
        var a = $('auto_link_radar');
        if (a) { a.addEventListener('click', function (e) { e.preventDefault(); goFix('rainmap'); }); }
        var pl = $('link_programs_plan');
        if (pl) { pl.addEventListener('click', function (e) { e.preventDefault(); openSec('plan', true); }); }
        /* #/autonomy: the link agent cards and messages carry */
        var fromHash = function () { if (/^#\/autonomy\b/.test(location.hash)) { openSec('now', true); } };
        window.addEventListener('hashchange', fromHash);
        setTimeout(fromHash, 800);
        if (window.VTI18n) {
            VTI18n.onChange(function () {
                S.shape = ''; ['auto_mode_choice', 'auto_plan_actions', 'auto_journal_filter', 'auto_stay', 'auto_sleep_now', 'auto_hw', 'auto_hw2'].forEach(function (id) {
                    var b = $(id);
                    if (b) { clear(b); delete b.dataset.built; }
                });
                if (S.planMsg) { S.planMsg.remove(); }
                var cd = $('auto_countdown'); clear(cd);
                buildMode(); buildPlanActions(); buildSleep(); buildFilter(); buildHw();
                var lim = $('auto_limits'); if (lim) { delete lim.dataset.sig; }
                paintSettings(); paintAll(); tick();
            });
        }
        paintSettings(); paintAll();
    }

    window.VTAutonomy = { init: init, runGate: runGate, open: openSec, rightSection: rightSection, planLine: function () {
        return S.report ? planLine() : ''; }, rawTimed: rawTimed, robotLine: robotLine, when: when,
                          whyCode: whyCode, _state: S, _checkText: checkText, _validate: validate };
}());
