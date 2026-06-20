/**
 * CalendarManager - Manages mowing calendar events in the web UI.
 * Communicates with master_controller via:
 *   - /scheduler/set_calendar  (publish, std_msgs/String with JSON)
 *   - /scheduler/calendar      (subscribe, std_msgs/String with JSON)
 *   - /scheduler/status        (subscribe, std_msgs/String)
 */

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

        this.calendarPub.advertise();
        this.inhibitPub.advertise();

        // Subscribe to current calendar from master_controller
        this.calendarSub.subscribe((msg) => {
            try {
                this.events = JSON.parse(msg.data);
            } catch (e) {
                this.events = [];
            }
            this.render();
        });

        // Subscribe to scheduler status
        this.statusSub.subscribe((msg) => {
            const el = document.getElementById('span_scheduler_status');
            if (el) el.textContent = msg.data || '';
        });

        // Subscribe to next-run info
        this.nextRunSub.subscribe((msg) => {
            const el = document.getElementById('span_scheduler_next');
            if (el) {
                const v = msg.data || '';
                el.textContent = (v && v !== 'None') ? ('Next: ' + v) : '';
            }
        });

        // Subscribe to inhibit status (reflect, don't echo back)
        this.inhibitStatusSub.subscribe((msg) => {
            const el = document.getElementById('chk_scheduler_inhibit');
            if (el) {
                this._inhibitFromRos = true;
                el.checked = !!msg.data;
                this._inhibitFromRos = false;
            }
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

        // Recurrence change shows/hides fields
        this.selRecurrence.addEventListener('change', () => this._updateFormFields());

        // Day buttons toggle
        this.divDays.querySelectorAll('button[data-day]').forEach(btn => {
            btn.addEventListener('click', () => {
                const active = btn.dataset.active === 'true';
                this._setDayBtnActive(btn, !active);
            });
        });

        // Inhibit toggle -> publish to master_controller
        const inhibitEl = document.getElementById('chk_scheduler_inhibit');
        if (inhibitEl) {
            inhibitEl.addEventListener('change', () => {
                if (this._inhibitFromRos) return;  // skip ROS-driven updates
                this.inhibitPub.publish(new ROSLIB.Message({ data: inhibitEl.checked }));
            });
        }
    }

    // ---- rendering ----

    render() {
        if (!this.containerEl) return;
        if (!this.events || this.events.length === 0) {
            this.containerEl.innerHTML = '<div style="padding:8px;font-size:12px;color:#9aa0a6;">No calendar events yet.</div>';
            return;
        }
        const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
        let html = '';
        this.events.forEach((ev) => {
            const enabled = ev.enabled !== false;
            const opacity = enabled ? '1' : '0.5';
            const recLabel = this._recurrenceLabel(ev);
            const timeStr = ev.start_time || '??:??';
            html += `<div class="d-flex align-items-center" style="gap:6px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.06);opacity:${opacity};">`;
            html += `<div class="form-check form-switch" style="margin:0;min-width:34px;"><input class="form-check-input cal-toggle" type="checkbox" data-id="${ev.id}" ${enabled ? 'checked' : ''} style="cursor:pointer;"></div>`;
            html += `<span class="text-info" style="font-size:13px;min-width:80px;font-weight:600;">${this._escHtml(ev.program_name)}</span>`;
            html += `<span style="font-size:12px;color:var(--bs-gray-300);min-width:44px;">${timeStr}</span>`;
            html += `<span style="font-size:11px;color:#9aa0a6;flex:1;">${recLabel}</span>`;
            html += `<button class="btn btn-sm btn-outline-info cal-edit" data-id="${ev.id}" style="font-size:10px;padding:1px 7px;">Edit</button>`;
            html += `<button class="btn btn-sm btn-outline-danger cal-del" data-id="${ev.id}" style="font-size:10px;padding:1px 7px;">Del</button>`;
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
        const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
        switch (ev.recurrence) {
            case 'none': return 'Once: ' + (ev.start_date || '?');
            case 'daily': return 'Daily';
            case 'weekly':
                if (ev.days_of_week && ev.days_of_week.length) {
                    return ev.days_of_week.map(d => dayNames[d] || '?').join(', ');
                }
                return 'Weekly';
            case 'monthly': return 'Monthly (day ' + (ev.day_of_month || '?') + ')';
            case 'yearly': return 'Yearly (' + (ev.day_of_month || '?') + '/' + (ev.month || '?') + ')';
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
            this.inputDate.value = new Date().toISOString().split('T')[0];
            this.inputDom.value = 1;
            this.inputMonth.value = 1;
        }

        this.formEl.style.display = 'block';
    }

    _hideForm() {
        this.formEl.style.display = 'none';
        this.editingId = null;
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
        this.selProgram.innerHTML = options || '<option value="">No programs</option>';
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
            ev.start_date = this.inputDate.value || new Date().toISOString().split('T')[0];
        }
        if (recurrence === 'weekly') {
            const days = [];
            this.divDays.querySelectorAll('button[data-day]').forEach(btn => {
                if (btn.dataset.active === 'true') days.push(parseInt(btn.dataset.day, 10));
            });
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
        if (active) {
            btn.style.backgroundColor = 'var(--bs-info)';
            btn.style.color = '#000';
            btn.style.borderColor = 'var(--bs-info)';
        } else {
            btn.style.backgroundColor = '';
            btn.style.color = '';
            btn.style.borderColor = '';
        }
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
