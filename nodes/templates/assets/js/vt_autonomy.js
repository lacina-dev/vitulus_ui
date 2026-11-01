/* vt_autonomy.js — the Autonomy panel: what the robot does on its own and why.
 *
 * Contract: vitulus_planner docs/AUTONOMY.md. The panel draws what master_controller
 * reports and never decides anything itself:
 *   in   /scheduler/report (checks, sleep.checks, rain_would_refuse), /scheduler/timeline,
 *        /scheduler/journal,
 *        /scheduler/settings, /scheduler/settings_result, /scheduler/command_result,
 *        /scheduler/sleep_countdown, /scheduler/calendar, /weather_alert/rain_alert
 *   out  /scheduler/set_settings, /scheduler/sleep_now, /scheduler/sleep_cancel,
 *        /scheduler/ignore_rain_once, /scheduler/run_next
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
    var IN_SECTION = { rain_after_min: 1, rain_forecast_min: 1, rain_retry_h: 1, temp_wait_h: 1,
                       temp_spike_wait_min: 1, error_retry_max: 1, resume_max: 1, run_max_age_h: 1,
                       off_dock_wait_min: 1 };
    var SECTIONS = ['now', 'plan', 'rain', 'battery', 'sleep', 'recovery', 'history', 'advanced'];
    var OPEN_DEFAULT = { now: 1, plan: 1 };
    var CHECK_TONE = { ok: 'ok', wait: 'warn', block: 'err', off: 'off', unknown: 'off' };
    var RAIN_MODES = ['always', 'calendar', 'ignore'];
    var RAIN_CODES = { rain: 1, recent_rain: 1, forecast: 1, rain_stale: 1 };

    /* where a check is fixed: an Autonomy section or another panel */
    var FIX = {
        automation: 'hero', hold: 'hero', dock: 'dock', mission: 'programs', battery: 'sec:battery',
        rain: 'sec:rain', gnss: 'loc', temperature: 'power', window: 'sec:plan', programs: 'programs',
        map: 'map', enabled: 'sec:sleep', manual: 'hero', agent: 'agent', ssh: 'sec:sleep', ui: 'sec:sleep',
        boot: null, stay_awake: 'sec:sleep', reason: 'sec:sleep'
    };

    var S = {
        ros: null, report: null, settings: null, rain: null, pubs: {}, rows: {}, shape: '',
        pending: {}, countdown: null, cdTimer: null, cdAt: 0, reqN: 0, lastRun: null,
        filter: 'all'
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

    /* Ours before it goes out; the master checks again. {code, vars} or null */
    function validate(k, v) {
        var sc = schema(k) || {};
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
        var code = String(reason).split(':')[0];
        return first(['auto.why.' + code], vars || {}) || String(reason).replace(/_/g, ' ');
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
            var w = el('span', 'form-check form-switch', ctl);
            r.input = el('input', 'form-check-input', w);
            r.input.type = 'checkbox';
            r.input.addEventListener('change', function () { saveKey(k, r.input.checked); });
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
            if (numeric) {
                r.input.inputMode = sc.type === 'int' ? 'numeric' : 'decimal';
                if (sc.min !== undefined) { r.input.min = sc.min; }
                if (sc.max !== undefined) { r.input.max = sc.max; }
                r.input.step = sc.step || (sc.type === 'int' ? 1 : 'any');
            }
            r.input.addEventListener('change', function () {
                saveKey(k, numeric ? Number(r.input.value) : r.input.value);
            });
            if (sc.unit) { el('span', 'vt-auto-unit', ctl, sc.unit); }
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
        Object.keys(sch).forEach(function (k) {
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
    function checkText(c) {
        var v = checkVars(c);
        return first(['auto.check.' + c.key + '.' + c.code,
                      'calmgr.code.' + c.code,
                      'auto.check.' + c.key + '.state.' + c.state,
                      'auto.check.state.' + c.state], Object.assign({ what: t('auto.check.key.' + c.key) }, v));
    }
    function paintChecks(box, list, quietOk) {
        clear(box);
        var n = { ok: 0, wait: 0, block: 0 };
        var rank = { block: 0, wait: 1 };
        var order = function (c) { return c.state in rank ? rank[c.state] : 2; };
        (list || []).slice().sort(function (a, b) { return order(a) - order(b); }).forEach(function (c) {
            if (n[c.state] !== undefined) { n[c.state] += 1; }
            if (quietOk && c.state === 'ok') { return; }
            var r = el('div', 'vt-auto-check', box);
            r.dataset.state = CHECK_TONE[c.state] || 'off';
            el('span', 'vt-sdot', r);
            el('span', 'vt-auto-check-t', r, checkText(c));
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
    }
    /* A step that moves the robot or changes today's plan takes two taps. */
    function twoTap(b, key, fn) {
        b.addEventListener('click', function () {
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
            el('small', 'vt-auto-set-h', nb, t('auto.sleepnow.hint'));
            var l2 = el('div', 'vt-auto-line', nb);
            S.sleepMin = el('input', 'form-control form-control-sm vt-auto-in', l2);
            S.sleepMin.type = 'number'; S.sleepMin.min = 5; S.sleepMin.max = 720; S.sleepMin.value = 60; S.sleepMin.inputMode = 'numeric';
            S.sleepMin.id = 'input_auto_sleep_min';
            S.sleepMin.setAttribute('aria-label', t('auto.sleepnow.min'));
            el('span', 'vt-auto-unit', l2, 'min');
            var tb = el('button', 'btn btn-sm btn-outline-warning', l2, t('auto.sleepnow.timed'));
            tb.type = 'button'; tb.id = 'btn_auto_sleep_timed';
            var cb = el('button', 'btn btn-sm btn-outline-warning', l2, t('auto.sleepnow.charged'));
            cb.type = 'button'; cb.id = 'btn_auto_sleep_charged';
            S.sleepMsg = el('div', 'vt-auto-msg vt-auto-msg-w', nb);
            S.sleepBtns = [tb, cb];
            twoTap(tb, 'auto.sleepnow.timed', function () {
                var m = Number(S.sleepMin.value);
                if (!(m >= 5 && m <= 720)) { msgOf({ msg: S.sleepMsg }, 'err', t('auto.why.range', { min: 5, max: 720, unit: 'min' })); return; }
                pubJson('/scheduler/sleep_now', { mode: 'timed', ms: Math.round(m * 60000) });
                msgOf({ msg: S.sleepMsg }, 'saving', t('auto.msg.saving'));
            });
            twoTap(cb, 'auto.sleepnow.charged', function () {
                pubJson('/scheduler/sleep_now', { mode: 'charged', ms: 0 });
                msgOf({ msg: S.sleepMsg }, 'saving', t('auto.msg.saving'));
            });
        }
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
            { k: t('auto.num.last_wake'), v: sl && sl.last_wake ? String(sl.last_wake).replace('T', ' ').slice(0, 16) : '—' },
            { k: t('auto.num.idle'), v: withUnit(num('idle_sleep_threshold_min'), 'min') }
        ]);
        if (S.stayState) {
            var active = stay && (parseIso(stay) || 0) > new Date();
            S.stayState.textContent = active ? t('auto.stay.until', { when: when(stay) }) : '';
            S.stayOff.style.display = active ? '' : 'none';
            S.stayGo.disabled = !S.settings;
        }
        if (S.sleepBtns) { S.sleepBtns.forEach(function (b) { b.disabled = !S.settings; }); }
    }
    function paintCountdown() {
        var box = $('auto_countdown'), c = S.countdown;
        if (!box) { return; }
        if (!c || !c.active) { box.hidden = true; clearInterval(S.cdTimer); S.cdTimer = null; return; }
        var left = Math.max(0, Math.round(c.left_s - (Date.now() - S.cdAt) / 1000));
        if (!box.firstChild) {
            el('span', 'vt-attn-lab', box, t('auto.cd.label'));
            S.cdTxt = el('span', 'vt-attn-txt', box);
            var b = el('button', 'btn btn-sm btn-warning', box, t('auto.cd.cancel'));
            b.type = 'button'; b.id = 'btn_auto_sleep_cancel';
            b.addEventListener('click', function () { pub('/scheduler/sleep_cancel', 'std_msgs/Bool', true); });
        }
        var who = c.who || {}, n = (who.ssh || []).length + (who.ui || 0);
        /* sequence: the shutdown is under way; it can be cancelled until the point of no
           return, then the topic says active: false */
        S.cdTxt.textContent = c.phase === 'sequence' ? t('auto.cd.sequence')
            : t(n ? 'auto.cd.text_who' : 'auto.cd.text', { s: left, n: n });
        box.hidden = false;
    }
    function onCountdown(c) {
        S.countdown = c; S.cdAt = Date.now();
        paintCountdown(); paintSleep();
        if (c && c.active && !S.cdTimer) { S.cdTimer = setInterval(paintCountdown, 1000); }
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
        if (!r || !S.sleepMsg) { return; }
        var sink = r.cmd === 'run_next' ? S.planMsg : S.sleepMsg;
        msgOf({ msg: sink }, r.ok ? 'ok' : 'err', r.ok ? t(r.code === 'due' ? 'auto.msg.run_due' : 'auto.msg.sent')
            : t('auto.msg.cmd_refused', { why: commandWhy(r.code) }));
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
                    sleep: ['slept', 'woke'], settings: ['settings'] };
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
            li.dataset.state = j.kind === 'missed' ? 'warn' : (j.kind === 'finished' ? 'ok' : (j.kind === 'started' ? 'info' : 'off'));
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
        var txt = first(['calmgr.issue.' + i.code], d) || i.code;
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
        paintNow(); paintPlan(); paintRain(); paintBattery(); paintSleep();
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
            if (d) { word = pad(d.getHours()) + ':' + pad(d.getMinutes()); }
        }
        RP.chip.textContent = word;
        RP.chip.dataset.state = tone;
        RP.chip.title = (cm && cm._sentence ? cm._sentence(rep) : '') || word;
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
    function init(ros) {
        S.ros = ros;
        setupSections();
        // advertised early: the first message after an advertise can get lost
        [['/scheduler/set_settings', 'std_msgs/String'], ['/scheduler/sleep_now', 'std_msgs/String'],
         ['/scheduler/sleep_cancel', 'std_msgs/Bool'], ['/scheduler/ignore_rain_once', 'std_msgs/Bool'],
         ['/scheduler/run_next', 'std_msgs/Bool']].forEach(function (x) {
            S.pubs[x[0]] = new ROSLIB.Topic({ ros: ros, name: x[0], messageType: x[1] });
            S.pubs[x[0]].advertise();
        });
        buildRainMode(); buildPlanActions(); buildSleep(); buildFilter();
        subJson('/scheduler/report', function (r) { S.report = r; paintAll(); paintSettings(); afterReport(); });
        subJson('/scheduler/timeline', function (o) { S.timeline = o; paintTimeline(); });
        subJson('/scheduler/journal', function (o) { S.journal = o.entries || []; paintHistory(); });
        subJson('/scheduler/settings', function (o) { S.settings = o; paintSettings(); paintAll(); });
        subJson('/scheduler/settings_result', onResult);
        subJson('/scheduler/command_result', onCommand);
        subJson('/scheduler/sleep_countdown', onCountdown);
        sub('/weather_alert/rain_alert', 'weather_alert/RainAlert', function (m) { S.rain = m; paintRain(); paintRight(); });
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
                S.shape = ''; ['auto_plan_actions', 'auto_journal_filter', 'auto_stay', 'auto_sleep_now'].forEach(function (id) {
                    var b = $(id);
                    if (b) { clear(b); delete b.dataset.built; }
                });
                if (S.planMsg) { S.planMsg.remove(); }
                var cd = $('auto_countdown'); clear(cd);
                buildPlanActions(); buildSleep(); buildFilter();
                paintSettings(); paintAll(); paintCountdown();
            });
        }
        paintSettings(); paintAll();
    }

    window.VTAutonomy = { init: init, runGate: runGate, open: openSec, rightSection: rightSection,
                          _state: S, _checkText: checkText, _validate: validate };
}());
