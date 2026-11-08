/**
 * CalendarManager - Manages mowing calendar events in the web UI.
 * Communicates with master_controller via:
 *   - /scheduler/set_calendar  (publish, std_msgs/String with JSON)
 *   - /scheduler/calendar      (subscribe, std_msgs/String with JSON)
 *   - /scheduler/status        (subscribe, std_msgs/String)
 *   - /scheduler/set_enabled   (publish, std_msgs/Bool: the one automation switch)
 *   - /scheduler/enabled       (subscribe, std_msgs/Bool, latched)
 *   - /scheduler/report        (subscribe, std_msgs/String, JSON: state as codes)
 *   - /scheduler/clear_issues  (publish, std_msgs/Bool)
 *   - /scheduler/set_window    (publish, std_msgs/String, JSON: the allowed time;
 *                               the state comes back in report.window_setting)
 */

function calT(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
// short day names, Monday = 0 (the robot's days_of_week)
function calDay(d) { return (d >= 0 && d <= 6) ? calT('calmgr.day.' + d) : '?'; }

class CalendarManager {
    constructor(ros, programsInstance) {
        this.ros = ros;
        this.programs = programsInstance;
        this.events = [];       // current calendar events array
        this.editingId = null;  // null = new event, string = editing existing

        // ROS topics
        this.calendarPub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/set_calendar',
            messageType: 'std_msgs/String'
        });
        this.calendarSub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/calendar',
            messageType: 'std_msgs/String'
        });
        this.statusSub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/status',
            messageType: 'std_msgs/String'
        });
        this.nextRunSub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/next_run',
            messageType: 'std_msgs/String'
        });
        this.inhibitPub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/inhibit',
            messageType: 'std_msgs/Bool'
        });
        this.inhibitStatusSub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/inhibit_status',
            messageType: 'std_msgs/Bool'
        });

        this.enabledPub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/set_enabled',
            messageType: 'std_msgs/Bool'
        });
        this.enabledSub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/enabled',
            messageType: 'std_msgs/Bool'
        });
        this.reportSub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/report',
            messageType: 'std_msgs/String'
        });
        this.clearIssuesPub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/clear_issues',
            messageType: 'std_msgs/Bool'
        });

        this.windowPub = new ROSLIB.Topic({
            ros: ros,
            name: '/scheduler/set_window',
            messageType: 'std_msgs/String'
        });

        this.calendarPub.advertise();
        this.inhibitPub.advertise();
        this.windowPub.advertise();
        this.enabledPub.advertise();
        this.clearIssuesPub.advertise();

        // Subscribe to current calendar from master_controller
        this.calendarSub.subscribe((msg) => {
            try {
                this.events = JSON.parse(msg.data);
            } catch (e) {
                this.events = [];
            }
            this.render();
        });

        // Subscribe to scheduler status (raw line: tooltip only once the
        // report tells the same thing as a sentence)
        this.statusSub.subscribe((msg) => {
            this._status = msg.data || '';
            this._paintState();
        });

        // The switch shows what the robot says, never just the click.
        this.enabledSub.subscribe((msg) => {
            this._enabled = !!msg.data;
            const el = document.getElementById('chk_scheduler_enabled');
            if (el) el.checked = this._enabled;
            this._paintState();
        });

        this.reportSub.subscribe((msg) => {
            try {
                this._report = JSON.parse(msg.data);
                this._reportAt = Date.now();
            } catch (e) {
                this._report = null;
            }
            this._paintState();
            this._paintIssues();
            this._paintWindow();
            this.render();
        });

        // Subscribe to next-run info
        this.nextRunSub.subscribe((msg) => {
            this._nextRun = msg.data || '';
            this._paintNext();
        });

        // language switch: redraw what this module wrote
        if (window.VTI18n) {
            VTI18n.onChange(() => {
                this.render();
                this._paintState();
                this._paintIssues();
                this._paintNext();
                this._paintWindow();
                const sel = this.selProgram;
                if (sel && sel.options.length === 1 && sel.options[0].value === '') {
                    sel.options[0].textContent = calT('calmgr.no_programs');
                }
            });
        }

        // Subscribe to inhibit status (reflect, don't echo back)
        this.inhibitStatusSub.subscribe((msg) => {
            const el = document.getElementById('chk_scheduler_inhibit');
            if (el) {
                this._inhibitFromRos = true;
                el.checked = !!msg.data;
                this._inhibitFromRos = false;
            }
            this._held = !!msg.data;
            this._paintState();
        });

        // DOM references
        this.containerEl = document.getElementById('div_calendar_events');
        this.formEl = document.getElementById('div_calendar_form');
        this.btnAdd = document.getElementById('btn_calendar_add');
        this.btnSave = document.getElementById('btn_cal_save');
        this.btnCancel = document.getElementById('btn_cal_cancel');
        this.selProgram = document.getElementById('sel_cal_program');
        this.inputHour = document.getElementById('input_cal_hour');
        this.inputMinute = document.getElementById('input_cal_minute');
        this.selRecurrence = document.getElementById('sel_cal_recurrence');
        this.divDays = document.getElementById('div_cal_days');
        this.divDate = document.getElementById('div_cal_date');
        this.inputDate = document.getElementById('input_cal_date');
        this.divDom = document.getElementById('div_cal_dom');
        this.inputDom = document.getElementById('input_cal_dom');
        this.divMonth = document.getElementById('div_cal_month');
        this.inputMonth = document.getElementById('input_cal_month');

        this._initUI();
        this._paintWindow();
    }

    _initUI() {
        // Add event button
        this.btnAdd.addEventListener('click', () => this._showForm(null));

        // Save / Cancel
        this.btnSave.addEventListener('click', () => this._saveEvent());
        this.btnCancel.addEventListener('click', () => this._hideForm());

        this.inputHour.addEventListener('input', () => this._checkWindowHint());
        this.inputMinute.addEventListener('input', () => this._checkWindowHint());

        // Recurrence change shows/hides fields
        this.selRecurrence.addEventListener('change', () => this._updateFormFields());

        // Day buttons toggle
        this.divDays.querySelectorAll('button[data-day]').forEach(btn => {
            btn.addEventListener('click', () => {
                const active = btn.dataset.active === 'true';
                this._setDayBtnActive(btn, !active);
            });
        });

        // The one automation switch. The state comes back on /scheduler/enabled;
        // until then the click must not look like a fact.
        const enabledEl = document.getElementById('chk_scheduler_enabled');
        if (enabledEl) {
            enabledEl.addEventListener('change', () => {
                const want = enabledEl.checked;
                enabledEl.checked = !!this._enabled;
                this.enabledPub.publish(new ROSLIB.Message({ data: want }));
            });
        }

        this._initWindow();

        // Inhibit toggle -> publish to master_controller
        const inhibitEl = document.getElementById('chk_scheduler_inhibit');
        if (inhibitEl) {
            inhibitEl.addEventListener('change', () => {
                if (this._inhibitFromRos) return;  // skip ROS-driven updates
                this.inhibitPub.publish(new ROSLIB.Message({ data: inhibitEl.checked }));
            });
        }
    }

    /* The allowed mowing time. Like the automation switch: the card shows what
       the robot reports (report.window_setting), a click is not a fact. Times
       being edited stay until they are saved and come back from the robot. */
    _initWindow() {
        const chk = document.getElementById('chk_window_enabled');
        const inputs = this._windowInputs();
        const save = document.getElementById('btn_window_save');
        if (!chk || !inputs || !save) return;
        // T21 A2: the switch sits in a box of its own (40 px on touch) that toggles it, like
        // every other switch of the panel; the "Limit" label keeps its own text (data-i18n)
        if (!chk.parentNode.classList.contains('vt-switch-hit')) {
            const hit = document.createElement('label');
            hit.className = 'vt-switch-hit';
            hit.htmlFor = chk.id;
            chk.parentNode.insertBefore(hit, chk);
            hit.appendChild(chk);
        }
        chk.addEventListener('change', () => {
            const set = this._report && this._report.window_setting;
            const want = chk.checked;
            chk.checked = !!(set && set.enabled);
            this.windowPub.publish(new ROSLIB.Message({ data: JSON.stringify({ enabled: want }) }));
        });
        inputs.forEach((el) => el.addEventListener('input', () => {
            this._windowDirty = true;
            this._paintWindow();
        }));
        save.addEventListener('click', () => {
            const start = this._windowRead(inputs.slice(0, 2));
            const end = this._windowRead(inputs.slice(2));
            if (this._windowProblem(start, end, null)) return;
            this.windowPub.publish(new ROSLIB.Message({ data: JSON.stringify({ start: start, end: end }) }));
        });
    }

    /* Hour and minute apart, as in the event form: 24 h on every phone (a
       native time input shows AM/PM under an English locale). */
    _windowInputs() {
        const els = ['start_h', 'start_m', 'end_h', 'end_m']
            .map((n) => document.getElementById('input_window_' + n));
        return els.every(Boolean) ? els : null;
    }

    /* [hour input, minute input] -> "HH:MM", '' when it is not a time */
    _windowRead(pair) {
        const [h, m] = pair.map((el) => String(el.value).trim());
        if (!/^\d{1,2}$/.test(h) || !/^\d{1,2}$/.test(m)) return '';
        if (Number(h) > 23 || Number(m) > 59) return '';
        return h.padStart(2, '0') + ':' + m.padStart(2, '0');
    }

    _windowWrite(pair, hm) {
        const parts = hm.split(':');
        pair[0].value = parts[0];
        pair[1].value = parts[1];
    }

    /* Why these times cannot be saved (blocking), or a warning about them:
       {code, min?, warn?}. set gives the shortest window that can start. */
    _windowProblem(start, end, set) {
        if (!/^\d\d:\d\d$/.test(start || '') || !/^\d\d:\d\d$/.test(end || '')) return { code: 'invalid' };
        if (start === end) return { code: 'equal' };
        const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
        const length = (mins(end) - mins(start) + 1440) % 1440;
        if (set && length < set.min_left_min) {
            return { code: 'short', min: Math.round(set.min_left_min), warn: true };
        }
        return null;
    }

    _windowSentence(set) {
        if (!set.enabled) return calT('calmgr.window.off');
        const key = set.start < set.end ? 'calmgr.window.on' : 'calmgr.window.on_night';
        return calT(key, { start: set.start, end: set.end });
    }

    _paintWindow() {
        const chk = document.getElementById('chk_window_enabled');
        const inputs = this._windowInputs();
        const save = document.getElementById('btn_window_save');
        const line = document.getElementById('span_window_state');
        const msg = document.getElementById('div_window_msg');
        if (!chk || !inputs || !save || !line || !msg) return;
        const set = this._report && this._report.window_setting;
        chk.disabled = !set;
        inputs.forEach((el) => { el.disabled = !set; });
        if (!set) {
            // no report yet, or a master_controller without the setting
            line.textContent = calT('calmgr.window.wait');
            save.disabled = true;
            msg.style.display = 'none';
            return;
        }
        chk.checked = !!set.enabled;
        const card = document.getElementById('card_mow_window');
        if (card) card.dataset.limit = set.enabled ? 'on' : 'off';
        const startPair = inputs.slice(0, 2);
        const endPair = inputs.slice(2);
        if (this._windowDirty && this._windowRead(startPair) === set.start
            && this._windowRead(endPair) === set.end) {
            this._windowDirty = false;
        }
        if (!this._windowDirty) {
            this._windowWrite(startPair, set.start);
            this._windowWrite(endPair, set.end);
        }
        line.textContent = this._windowSentence(set);
        const problem = this._windowProblem(this._windowRead(startPair), this._windowRead(endPair), set)
            || (set.error ? { code: set.error } : null);
        save.disabled = !this._windowDirty || !!(problem && !problem.warn);
        msg.textContent = problem ? calT('calmgr.window.' + problem.code, problem) : '';
        msg.style.display = problem ? '' : 'none';
        msg.dataset.state = (problem && !problem.warn) ? 'err' : 'warn';
        // An open event form judges its time by the window that applies now.
        const applied = JSON.stringify(this._report.window);
        if (applied !== this._windowApplied) {
            this._windowApplied = applied;
            if (this.formEl && this.formEl.style.display !== 'none') this._checkWindowHint();
        }
    }

    /* One unambiguous state in the card head, with a tone, and one sentence
       under it. Both come from /scheduler/report (codes, translated here); the
       raw master_controller line stays as the tooltip. */
    _paintNext() {
        const el = document.getElementById('span_scheduler_next');
        if (el) {
            const rep = this._report;
            let v = this._nextRun || '';
            if (rep) {
                // the same words as the Plan section ("today 23:15", "Tue, 11/10 08:00")
                const m = rep.next && /^\d+-(\d+)-(\d+)T(.+)$/.exec(rep.next.at);
                const at = (window.VTAutonomy && VTAutonomy.when) ? VTAutonomy.when(rep.next && rep.next.at)
                    : (m ? `${Number(m[2])}. ${Number(m[1])}. ${m[3]}` : '');
                v = (rep.enabled && m) ? `${rep.next.program} · ${at}` : '';
            }
            el.textContent = (v && v !== 'None') ? calT('calmgr.next', {when: v}) : '';
        }
    }

    /* tag + tone per report code; a blocked robot must never read as "Active" */
    _codeLook(code) {
        if (code === 'off') return ['auto_off', 'off'];
        if (code === 'held') return ['held', 'warn'];
        if (code === 'mowing' || code === 'starting' || code === 'loading_map') return ['mowing', 'info'];
        if (code === 'init' || code === 'boot_grace' || code === 'wait_programs'
            || code === 'wait_mission') return ['starting', 'off'];
        if (code === 'blocked_stopped' || code === 'blocked_terminal') return ['needs_reset', 'err'];
        if (code === 'run_off_dock' || code === 'off_dock_stuck') return ['off_dock', 'err'];
        if (code === 'off_dock') return ['off_dock', 'warn'];
        if (code === 'sleep_prepare' || code === 'sleep_cut') return ['sleeping', 'off'];
        if (code === 'not_in_dock') return ['off_dock', 'warn'];
        if (/^blocked_/.test(code)) return ['busy', 'warn'];
        if (code === 'waiting_slot') return ['active', 'ok'];
        if (/^waiting_/.test(code)) return ['waiting', 'info'];
        // the agent mode and the hard limits: it waits, nothing is wrong (AUTONOMY.md §6)
        if (/^limit_/.test(code) || code === 'agent_no_advice' || code === 'agent_skip'
            || code === 'agent_wait_window' || code === 'agent_blocked') return ['waiting', 'info'];
        return ['active', 'ok'];
    }

    /* T21 A2: the state tag of the card and the right panel. _codeLook stays as it is
       (the answer "could it start now" reads it); here "Scheduled" only for a start that
       is planned, the codes that fall through it get their own word, an unknown one a
       neutral word (its sentence and the raw line say the rest) */
    _stateLook(rep) {
        const code = rep && rep.code;
        const look = this._codeLook(code);
        if (look[0] !== 'active') return look;
        // the master says a countdown in the sentence, the code stays (waiting_slot …)
        const said = (rep.sentence && rep.sentence.code) || '';
        if (said === 'sleep_countdown') return ['falling', 'warn'];
        if (said === 'hw_reset_countdown') return ['hw_reset', 'warn'];
        if (code === 'waiting_slot') return (rep.next && rep.enabled !== false) ? look : ['none', 'off'];
        if (code === 'no_schedule') return ['none', 'off'];
        if (code === 'outside_window') return ['outside', 'info'];
        if (code === 'no_mow') return ['no_mow', 'off'];
        if (code === 'intent_wait') return ['waiting', 'info'];
        if (code === 'agent_advice_done' || code === 'intent_timeout') return ['not_starting', 'off'];
        if (code === 'sleep_countdown') return ['falling', 'warn'];
        if (code === 'hw_reset_countdown') return ['hw_reset', 'warn'];
        return ['unknown', 'off'];
    }

    _sentence(rep) {
        const said = rep.sentence || {};   // machine form of the top sentence
        const d = Object.assign({}, rep.detail || {}, said.vars || {});
        // a wait's seconds left when the report was made: it may be half a minute old
        if (d.left_s !== undefined) {
            d.left_s = Math.max(0, d.left_s - (Date.now() - (this._reportAt || Date.now())) / 1000);
            d.min = Math.ceil(d.left_s / 60);
        }
        if (d.program === undefined) d.program = (rep.run && rep.run.program) || '';
        // the agent mode's times are local ISO, its "why" a code: in words
        if (window.VTAutonomy && VTAutonomy.when) {
            ['at', 'until'].forEach((k) => {
                if (typeof d[k] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(d[k])) d[k] = VTAutonomy.when(d[k]);
            });
            if (typeof d.why === 'string' && VTAutonomy.whyCode) d.why = VTAutonomy.whyCode(d.why, d);
        }
        if ((said.code === 'sleep_countdown' || said.code === 'hw_reset_countdown') && window.VTAutonomy && VTAutonomy.planLine) {
            const line = VTAutonomy.planLine();
            if (line) return line;
        }
        const key = 'calmgr.code.' + (said.code || rep.code);
        let text = calT(key, d);
        if (text === key) return rep.status || '';
        // a value the robot did not send: never a raw {placeholder}
        if (/\{\w+\}/.test(text)) text = text.replace(/\s*\{\w+\}/g, '').replace(/\s+([.,:;—–])/g, '$1');
        const run = rep.run;
        if (run && run.checkpoint && rep.code !== 'mowing') {
            const cp = /^failed: on_path-(.+)-(\d+)-(\d+)$/.exec(run.checkpoint);
            if (cp) {
                return text + ' ' + calT('calmgr.resume_at', {zone: cp[1], path: Number(cp[2]) + 1});
            }
        }
        return text;
    }

    _paintState() {
        const el = document.getElementById('span_scheduler_state');
        const card = document.getElementById('card_calendar');
        const line = document.getElementById('span_scheduler_status');
        if (!el) return;
        const st = String(this._status || '');
        const rep = this._report;
        let label = '—', tone = 'off', sentence = st;
        if (rep) {
            const look = this._stateLook(rep);
            label = calT('calmgr.state.' + look[0]);
            tone = look[1];
            sentence = this._sentence(rep);
        } else if (this._enabled === false) {
            label = calT('calmgr.state.auto_off');
            sentence = calT('calmgr.code.off');
        } else if (st) {
            // an older master_controller without the report: its line says what it does
            label = calT('calmgr.state.unknown');
        }
        el.textContent = label;
        el.dataset.state = tone;
        el.title = st ? calT('calmgr.state.tip', {status: st}) : '';
        // Why it does not sleep is quiet information, in the tooltip of the line.
        const block = rep && rep.sleep && rep.sleep.block;
        if (line) {
            line.textContent = sentence;
            line.title = block ? calT('calmgr.why_awake', {why: this._awakeWhy(block)}) : '';
        }
        if (card) {
            if (tone === 'off') { delete card.dataset.state; } else { card.dataset.state = tone; }
        }
        this._paintNext();
    }

    /* report.sleep.block is a code; a reason not translated yet stays readable. */
    _awakeWhy(block) {
        const code = String(block).split(':')[0];
        const key = 'calmgr.awake.' + code;
        const text = calT(key);
        return text === key ? String(block).replace(/_/g, ' ') : text;
    }

    /* What went wrong and is not visible any more: stays until cleared. */
    _paintIssues() {
        const box = document.getElementById('div_scheduler_issues');
        if (!box) return;
        const issues = (this._report && this._report.issues) || [];
        if (!issues.length) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        let html = '';
        issues.slice().reverse().forEach((i) => {
            const d = Object.assign({program: i.program || ''}, i.detail || {});
            if (d.slot) d.slot = String(d.slot).replace('T', ' ');
            const key = 'calmgr.issue.' + i.code;
            if (/^map:/.test(d.reason || '')) {
                const code = d.reason.slice(4);
                const why = (typeof vtT === 'function') ? vtT('mapview.prog.mapgate.' + code, {program: d.program, site: ''}) : code;
                d.reason = why === 'mapview.prog.mapgate.' + code ? code : why;
            }
            const byReason = 'calmgr.issue.reason.' + d.reason;   // the reason says more than the code
            let text = calT(byReason, d);
            if (text === byReason) text = calT(key, d);
            if (text === key) text = i.code + ' ' + (i.program || '');
            const why = d.blocked_by ? calT('calmgr.code.' + d.blocked_by) : '';
            html += `<div class="vt-cal-issue" title="${this._escHtml(why)}">${this._escHtml(text)}</div>`;
        });
        html += `<button class="btn btn-sm btn-outline-secondary" type="button" id="btn_scheduler_issues_clear">${calT('calmgr.issues_clear')}</button>`;
        box.innerHTML = html;
        box.style.display = '';
        document.getElementById('btn_scheduler_issues_clear').addEventListener('click', () => {
            this.clearIssuesPub.publish(new ROSLIB.Message({ data: true }));
        });
    }

    // ---- rendering ----

    render() {
        if (!this.containerEl) return;
        if (!this.events || this.events.length === 0) {
            this.containerEl.innerHTML = '<div class="vt-empty">' + calT('calmgr.empty') + '</div>';
            return;
        }
        // Program names of the active map (null = list not received yet)
        const all = (this.programs && this.programs.allPrograms) ? this.programs.allPrograms() : [];
        const known = all.length ? new Set(all.map(p => p.name)) : null;
        const knownAt = new Set(all.map(p => p.site + '|||' + p.name));
        let html = '';
        this.events.forEach((ev) => {
            const enabled = ev.enabled !== false;
            const opacity = enabled ? '1' : '0.5';
            const recLabel = this._recurrenceLabel(ev);
            const timeStr = ev.start_time || '??:??';
            // U1: one row look (vt_panel.css .vt-cal-row); disabled = dimmed
            const missing = known && !(ev.site ? knownAt.has(ev.site + '|||' + ev.program_name)
                                               : known.has(ev.program_name));
            const outside = !!(this._report && (this._report.outside_window || []).includes(ev.id));
            // T21 A2: switch (the whole box toggles, 40 px on touch) · name over time + days · Edit, Delete
            const name = this._escHtml(ev.program_name);
            const tip = this._escHtml(calT('calmgr.a2.toggle', {program: ev.program_name})).replace(/"/g, '&quot;');
            html += `<div class="vt-cal-row${enabled ? '' : ' is-off'}${(missing || outside) ? ' has-miss' : ''}">`;
            html += `<label class="form-check form-switch vt-cal-sw" title="${tip}"><input class="form-check-input cal-toggle" type="checkbox" data-id="${ev.id}" aria-label="${tip}" ${enabled ? 'checked' : ''}></label>`;
            html += `<div class="vt-cal-main"><span class="vt-cal-name">${name}${ev.site ? ' <small class="vt-cal-site">' + this._escHtml(ev.site) + '</small>' : ''}</span>`;
            html += `<span class="vt-cal-when"><span class="vt-cal-time">${timeStr}</span><span class="vt-cal-rec">${recLabel}</span>`;
            if (missing) html += `<span class="vt-cal-miss" title="${calT('calmgr.missing_tip')}">${calT('calmgr.missing')}</span>`;
            if (outside) html += `<span class="vt-cal-miss" title="${calT('calmgr.outside_tip', this._report.window || {})}">${calT('calmgr.outside')}</span>`;
            html += `</span></div>`;
            html += `<button class="btn btn-sm btn-outline-info cal-edit" type="button" data-id="${ev.id}">${calT('common.edit')}</button>`;
            html += `<button class="btn btn-sm btn-outline-danger cal-del" type="button" data-id="${ev.id}">${calT('calmgr.del')}</button>`;
            html += `</div>`;
        });
        this.containerEl.innerHTML = html;

        // Bind event listeners
        this.containerEl.querySelectorAll('.cal-toggle').forEach(chk => {
            chk.addEventListener('change', (e) => this._toggleEvent(e.target.dataset.id, e.target.checked));
        });
        this.containerEl.querySelectorAll('.cal-edit').forEach(btn => {
            btn.addEventListener('click', (e) => this._showForm(e.target.dataset.id));
        });
        this.containerEl.querySelectorAll('.cal-del').forEach(btn => {
            btn.addEventListener('click', (e) => this._deleteEvent(e.target.dataset.id));
        });
    }

    _recurrenceLabel(ev) {
        switch (ev.recurrence) {
            case 'none': return calT('calmgr.rec.once', {date: ev.start_date || '?'});
            case 'daily': return calT('calmgr.rec.daily');
            case 'weekly':
                if (ev.days_of_week && ev.days_of_week.length) {
                    return ev.days_of_week.map(d => calDay(d)).join(', ');
                }
                return calT('calmgr.rec.weekly');
            case 'monthly': return calT('calmgr.rec.monthly', {day: ev.day_of_month || '?'});
            case 'yearly': return calT('calmgr.rec.yearly', {day: ev.day_of_month || '?', month: ev.month || '?'});
            default: return ev.recurrence || '?';
        }
    }

    // ---- form show/hide ----

    _showForm(eventId) {
        this.editingId = eventId;
        this._populateProgramSelect();

        if (eventId) {
            const ev = this.events.find(e => e.id === eventId);
            if (!ev) return;
            this.selProgram.value = this._eventValue(ev);
            const hm = (ev.start_time || '08:00').split(':');
            this.inputHour.value = parseInt(hm[0], 10);
            this.inputMinute.value = (hm[1] || '00').padStart(2, '0');
            this.selRecurrence.value = ev.recurrence || 'weekly';
            this._updateFormFields();
            // Populate days
            this.divDays.querySelectorAll('button[data-day]').forEach(btn => {
                const d = parseInt(btn.dataset.day, 10);
                this._setDayBtnActive(btn, (ev.days_of_week || []).includes(d));
            });
            this.inputDate.value = ev.start_date || '';
            this.inputDom.value = ev.day_of_month || 1;
            this.inputMonth.value = ev.month || 1;
        } else {
            // New event defaults
            this.inputHour.value = 8;
            this.inputMinute.value = '00';
            this.selRecurrence.value = 'weekly';
            this._updateFormFields();
            this.divDays.querySelectorAll('button[data-day]').forEach(btn => this._setDayBtnActive(btn, false));
            this.inputDate.value = this._localDate();
            this.inputDom.value = 1;
            this.inputMonth.value = 1;
        }

        this.formEl.style.display = 'block';
    }

    _hideForm() {
        this.formEl.style.display = 'none';
        this.editingId = null;
        this._formHint('');
    }

    _formHint(text) {
        const el = document.getElementById('div_cal_hint');
        if (!el) return;
        el.textContent = text;
        el.style.display = text ? '' : 'none';
    }

    /* A time the allowed window never contains: say it before it is saved. */
    _checkWindowHint() {
        const w = this._report && this._report.window;
        if (!w) { this._formHint(''); return; }
        const h = Math.max(0, Math.min(23, parseInt(this.inputHour.value, 10) || 0));
        const m = Math.max(0, Math.min(59, parseInt(this.inputMinute.value, 10) || 0));
        const t = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        const inside = (w.start <= w.end) ? (t >= w.start && t <= w.end)
            : (t >= w.start || t <= w.end);
        this._formHint(inside ? '' : calT('calmgr.outside_tip', w));
    }

    /* The robot's calendar is local time; toISOString() is the UTC date. */
    _localDate() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
            + '-' + String(d.getDate()).padStart(2, '0');
    }

    _updateFormFields() {
        const rec = this.selRecurrence.value;
        this.divDays.style.display = (rec === 'weekly') ? '' : 'none';
        this.divDate.style.display = (rec === 'none') ? '' : 'none';
        this.divDom.style.display = (rec === 'monthly' || rec === 'yearly') ? '' : 'none';
        this.divMonth.style.display = (rec === 'yearly') ? '' : 'none';
    }

    _populateProgramSelect() {
        // Build options from the loaded programs list
        // (vitulus-field#46: of every map, the slot keeps which map it means)
        let options = '';
        if (this.programs && this.programs.allPrograms) {
            this.programs.allPrograms().forEach(p => {
                const name = p.name || '';
                const value = p.site ? p.site + '|||' + name : name;
                const label = p.site ? name + ' (' + p.site + ')' : name;
                options += `<option value="${this._escHtml(value)}">${this._escHtml(label)}</option>`;
            });
        }
        this.selProgram.innerHTML = options || '<option value="">' + calT('calmgr.no_programs') + '</option>';
    }

    // Option of an event. An event from before maps were named in it takes the
    // first option of that program name.
    _eventValue(ev) {
        if (ev.site) return ev.site + '|||' + ev.program_name;
        const hit = Array.from(this.selProgram.options).find(
            o => o.value === ev.program_name || o.value.endsWith('|||' + ev.program_name));
        return hit ? hit.value : ev.program_name;
    }

    // ---- CRUD ----

    _saveEvent() {
        const hour = Math.max(0, Math.min(23, parseInt(this.inputHour.value, 10) || 0));
        const minute = Math.max(0, Math.min(59, parseInt(this.inputMinute.value, 10) || 0));
        const start_time = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
        const picked = this.selProgram.value;
        if (!picked) return;
        const cut = picked.indexOf('|||');
        const program_name = cut < 0 ? picked : picked.slice(cut + 3);
        const site = cut < 0 ? '' : picked.slice(0, cut);

        const recurrence = this.selRecurrence.value;
        let ev = {
            id: this.editingId || this._uuid(),
            program_name: program_name,
            site: site,
            enabled: true,
            recurrence: recurrence,
            start_time: start_time
        };

        // Recurrence-specific fields
        if (recurrence === 'none') {
            ev.start_date = this.inputDate.value || this._localDate();
        }
        if (recurrence === 'weekly') {
            const days = [];
            this.divDays.querySelectorAll('button[data-day]').forEach(btn => {
                if (btn.dataset.active === 'true') days.push(parseInt(btn.dataset.day, 10));
            });
            if (!days.length) {
                // Weekly without a day never runs: not a calendar entry.
                this._formHint(calT('calmgr.no_days'));
                return;
            }
            ev.days_of_week = days;
        }
        if (recurrence === 'monthly' || recurrence === 'yearly') {
            ev.day_of_month = Math.max(1, Math.min(31, parseInt(this.inputDom.value, 10) || 1));
        }
        if (recurrence === 'yearly') {
            ev.month = Math.max(1, Math.min(12, parseInt(this.inputMonth.value, 10) || 1));
        }

        // Update or add
        if (this.editingId) {
            const idx = this.events.findIndex(e => e.id === this.editingId);
            if (idx >= 0) {
                ev.enabled = this.events[idx].enabled;
                if (this._moved(this.events[idx], ev) && !this._runOpen()) { ev.id = this._uuid(); }
                this.events[idx] = ev;
            }
        } else {
            this.events.push(ev);
        }

        this._publish();
        this._hideForm();
        this.render();
    }

    /* The master marks a slot used per id and date: an event moved to later today under
       its old id counts as already run and the next start falls a week away. A moved
       event is a new slot, so it gets a new id. Not while a run is open: the master
       ends a run whose event is gone. */
    _moved(a, b) {
        return ['start_time', 'recurrence', 'start_date', 'day_of_month', 'month'].some(k => (a[k] || '') !== (b[k] || ''))
            || JSON.stringify(a.days_of_week || []) !== JSON.stringify(b.days_of_week || []);
    }

    _runOpen() {
        return !!(this._report && this._report.run);
    }

    /* "Run today anyway": the same as deleting the entry and adding it again.
       false = refused, a run is open. */
    releaseSlot(id) {
        if (this._runOpen()) return false;
        const ev = this.events.find(e => e.id === id);
        if (!ev) return false;
        ev.id = this._uuid();
        this._publish();
        this.render();
        return true;
    }

    _deleteEvent(id) {
        this.events = this.events.filter(e => e.id !== id);
        this._publish();
        this.render();
    }

    _toggleEvent(id, enabled) {
        const ev = this.events.find(e => e.id === id);
        if (ev) {
            ev.enabled = enabled;
            this._publish();
        }
    }

    _publish() {
        const msg = new ROSLIB.Message({ data: JSON.stringify(this.events) });
        this.calendarPub.publish(msg);
    }

    // ---- helpers ----

    _setDayBtnActive(btn, active) {
        btn.dataset.active = active ? 'true' : 'false';
        btn.classList.toggle('vt-on', !!active);   // look: vt_panel.css .vt-days
    }

    _uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    _escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
}
