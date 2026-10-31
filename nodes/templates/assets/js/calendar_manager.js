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

        this.calendarPub.advertise();
        this.inhibitPub.advertise();
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
            } catch (e) {
                this._report = null;
            }
            this._paintState();
            this._paintIssues();
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

        // Inhibit toggle -> publish to master_controller
        const inhibitEl = document.getElementById('chk_scheduler_inhibit');
        if (inhibitEl) {
            inhibitEl.addEventListener('change', () => {
                if (this._inhibitFromRos) return;  // skip ROS-driven updates
                this.inhibitPub.publish(new ROSLIB.Message({ data: inhibitEl.checked }));
            });
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
                // "2026-06-10T08:00" -> "10. 6. 08:00": local time of the robot
                const m = rep.next && /^\d+-(\d+)-(\d+)T(.+)$/.exec(rep.next.at);
                v = (rep.enabled && m)
                    ? `${rep.next.program} ${Number(m[2])}. ${Number(m[1])}. ${m[3]}` : '';
            }
            el.textContent = (v && v !== 'None') ? calT('calmgr.next', {when: v}) : '';
        }
    }

    /* tag + tone per report code; a blocked robot must never read as "Active" */
    _codeLook(code) {
        if (code === 'off') return ['auto_off', 'off'];
        if (code === 'held') return ['held', 'warn'];
        if (code === 'mowing' || code === 'starting') return ['mowing', 'info'];
        if (code === 'init' || code === 'boot_grace' || code === 'wait_programs'
            || code === 'wait_mission') return ['starting', 'off'];
        if (code === 'blocked_stopped' || code === 'blocked_terminal') return ['needs_reset', 'err'];
        if (code === 'run_off_dock' || code === 'off_dock_stuck') return ['off_dock', 'err'];
        if (code === 'off_dock') return ['off_dock', 'warn'];
        if (code === 'sleep_prepare' || code === 'sleep_cut') return ['sleeping', 'off'];
        if (code === 'not_in_dock') return ['off_dock', 'warn'];
        if (/^blocked_/.test(code)) return ['busy', 'warn'];
        if (/^waiting_(battery|weather|temp|gps|critical|rejected)$/.test(code)) return ['waiting', 'info'];
        return ['active', 'ok'];
    }

    _sentence(rep) {
        const d = Object.assign({}, rep.detail || {});
        if (d.left_s !== undefined) d.min = Math.ceil(d.left_s / 60);
        if (d.program === undefined) d.program = (rep.run && rep.run.program) || '';
        const key = 'calmgr.code.' + rep.code;
        const text = calT(key, d);
        if (text === key) return rep.status || '';
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
            const look = this._codeLook(rep.code);
            label = calT('calmgr.state.' + look[0]);
            tone = look[1];
            sentence = this._sentence(rep);
        } else if (this._enabled === false) {
            label = calT('calmgr.state.auto_off');
            sentence = calT('calmgr.code.off');
        } else if (st) {
            // an older master_controller without the report
            label = calT('calmgr.state.active');
            tone = 'ok';
        }
        el.textContent = label;
        el.dataset.state = tone;
        el.title = st ? calT('calmgr.state.tip', {status: st}) : '';
        // Why it does not sleep is quiet information, in the tooltip of the line.
        const block = rep && rep.sleep && rep.sleep.block;
        if (line) {
            line.textContent = sentence;
            line.title = block ? calT('calmgr.why_awake', {why: block}) : '';
        }
        if (card) {
            if (tone === 'off') { delete card.dataset.state; } else { card.dataset.state = tone; }
        }
        this._paintNext();
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
            let text = calT(key, d);
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
        const pl = this.programs && this.programs.program_list_msg && this.programs.program_list_msg.program_list;
        const known = (pl && pl.length) ? new Set(pl.map(p => p.name)) : null;
        let html = '';
        this.events.forEach((ev) => {
            const enabled = ev.enabled !== false;
            const opacity = enabled ? '1' : '0.5';
            const recLabel = this._recurrenceLabel(ev);
            const timeStr = ev.start_time || '??:??';
            // U1: one row look (vt_panel.css .vt-cal-row); disabled = dimmed
            const missing = known && !known.has(ev.program_name);
            const outside = !!(this._report && (this._report.outside_window || []).includes(ev.id));
            html += `<div class="vt-cal-row${enabled ? '' : ' is-off'}${(missing || outside) ? ' has-miss' : ''}">`;
            html += `<div class="form-check form-switch"><input class="form-check-input cal-toggle" type="checkbox" data-id="${ev.id}" ${enabled ? 'checked' : ''}></div>`;
            html += `<span class="vt-cal-name">${this._escHtml(ev.program_name)}</span>`;
            if (missing) html += `<span class="vt-cal-miss" title="${calT('calmgr.missing_tip')}">${calT('calmgr.missing')}</span>`;
            if (outside) html += `<span class="vt-cal-miss" title="${calT('calmgr.outside_tip', this._report.window || {})}">${calT('calmgr.outside')}</span>`;
            html += `<span class="vt-cal-time">${timeStr}</span>`;
            html += `<span class="vt-cal-rec">${recLabel}</span>`;
            html += `<button class="btn btn-sm btn-outline-info cal-edit" data-id="${ev.id}">${calT('common.edit')}</button>`;
            html += `<button class="btn btn-sm btn-outline-danger cal-del" data-id="${ev.id}">${calT('calmgr.del')}</button>`;
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
            this.selProgram.value = ev.program_name;
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
        let options = '';
        if (this.programs && this.programs.program_list_msg && this.programs.program_list_msg.program_list) {
            this.programs.program_list_msg.program_list.forEach(p => {
                const name = p.name || '';
                options += `<option value="${this._escHtml(name)}">${this._escHtml(name)}</option>`;
            });
        }
        this.selProgram.innerHTML = options || '<option value="">' + calT('calmgr.no_programs') + '</option>';
    }

    // ---- CRUD ----

    _saveEvent() {
        const hour = Math.max(0, Math.min(23, parseInt(this.inputHour.value, 10) || 0));
        const minute = Math.max(0, Math.min(59, parseInt(this.inputMinute.value, 10) || 0));
        const start_time = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
        const program_name = this.selProgram.value;
        if (!program_name) return;

        const recurrence = this.selRecurrence.value;
        let ev = {
            id: this.editingId || this._uuid(),
            program_name: program_name,
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
                this.events[idx] = ev;
            }
        } else {
            this.events.push(ev);
        }

        this._publish();
        this._hideForm();
        this.render();
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
