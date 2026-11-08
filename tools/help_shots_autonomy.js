/* help_shots_autonomy.js — init script for tools/help_shots.py: the Autonomy pictures
 * (shot-autonomy, shot-autonomy-mode) from invented, neutral data, not from a robot.
 *
 *   python3 -m http.server -d nodes/templates 7862 &      # or a dev webnode (docs/help/README.md)
 *   tools/help_shots.py --url http://127.0.0.1:7862 --init-script tools/help_shots_autonomy.js \
 *       --only shot-autonomy,shot-autonomy-mode
 *
 * WebSocket is replaced before the page runs (the same fake rosbridge as
 * tools/test_autonomy_ui.py): it answers subscribe from the latched messages
 * below and rosapi calls, and swallows everything else. Nothing leaves the page.
 * The state shown: the agent mode, a mow advice in its window, the dock locked
 * (owner's decision D36: the advice waits for the dock permission).
 */
(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T'
      + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
  const now = new Date(); now.setSeconds(0, 0);
  const at = (min) => iso(new Date(now.getTime() + min * 60000));
  const PROG = 'Front lawn';
  const chk = (key, state, code, vars) => ({ key, state, code, vars: vars || {} });
  const report = {
    enabled: true, held: false, state: 'IDLE', code: 'waiting_dock', detail: { program: PROG }, status: 'Idle',
    battery: 100, next: { program: PROG, at: at(60 * 24) }, pending: [], issues: [], outside_window: [], window: null,
    window_setting: { enabled: true, start: '07:00', end: '21:00', stored: true, min_left_min: 30, error: null },
    limits: { resumes: 12, critical: 3 }, weather: null, run: null,
    sentence: { code: 'waiting_dock', vars: { program: PROG } },
    checks: [chk('automation', 'ok', 'on'), chk('hold', 'ok', 'clear'), chk('dock', 'ok', 'in_dock'), chk('mission', 'ok', 'ready'),
             chk('battery', 'ok', 'ok'), chk('rain', 'ok', 'dry'), chk('gnss', 'off', 'not_checked'), chk('temperature', 'ok', 'ok'),
             chk('window', 'ok', 'open'), chk('programs', 'ok', 'ok'), chk('map', 'ok', 'ok')],
    rain_would_refuse: null, ignore_rain_once: false, reject: null,
    sleep: { state: 'IDLE', mode: null, sleep_ms: 0, result: null, block: 'ui:1', next_wake: null, countdown: null,
             checks: [chk('enabled', 'ok', 'on'), chk('manual', 'ok', 'free'), chk('agent', 'ok', 'free'), chk('ssh', 'ok', 'none'),
                      chk('ui', 'block', 'clients', { n: 1 }), chk('boot', 'ok', 'done'), chk('stay_awake', 'ok', 'none'),
                      chk('reason', 'ok', 'none')] }
  };
  const S = (type, group, unit, min, max) => ({ type, group, unit: unit || '', min: min === undefined ? null : min,
                                                max: max === undefined ? null : max, advanced: false, locked: false, needs_restart: false });
  const values = { agent_fallback_calendar: true, limits_in_calendar: false, limit_day_start: '08:00', limit_day_end: '20:00',
                   limit_rain_h: 3.0, limit_temp_min_c: 5.0, limit_zone_gap_days: 2.0, sleep_enabled: true, rain_mode: 'always',
                   skip_next: null, no_mow_until: null, stay_awake_until: null };
  const settings = { version: 1, values, defaults: Object.assign({}, values), schema: {
    agent_fallback_calendar: S('bool', 'agent'), limits_in_calendar: S('bool', 'agent'),
    limit_day_start: S('time', 'agent'), limit_day_end: S('time', 'agent'), limit_rain_h: S('float', 'agent', 'h', 0, 48),
    limit_temp_min_c: S('float', 'agent', 'C', -10, 25), limit_zone_gap_days: S('float', 'agent', 'd', 0, 14),
    sleep_enabled: S('bool', 'sleep'), rain_mode: Object.assign(S('enum', 'rain'), { options: ['always', 'calendar', 'ignore'] }) } };
  const advice = { id: 'a1', action: 'mow', program: PROG, site: null, from: at(-10), to: at(170), until: null, expires: at(170),
                   reason: 'Dry since yesterday and the front lawn was last mowed 4 days ago.', confidence: 0.8, by: 'agent',
                   received: at(-12), state: 'pending', fresh: true };
  const mode = { mode: 'agent', dock_permitted: false, dock_why: 'the owner has not unlocked the dock', state: 'IDLE',
                 automation: true, held: false, fallback: true, limits_apply: true, changed: { t: at(-60 * 26), by: 'owner' },
                 advice, last_decision: { t: at(-2), kind: 'advice', code: 'waiting', program: PROG, source: 'agent',
                                          vars: { id: 'a1', why: 'dock:waiting_dock', dock: 'the owner has not unlocked the dock' } },
                 limit_now: null, limits: { day_start: '08:00', day_end: '20:00', rain_h: 3, temp_min_c: 5, zone_gap_days: 2, in_calendar: false },
                 weather: { hours_since_rain: 30, rain_last_h: 0, temp_now: 14 }, last_mow: {} };
  report.mode = mode;
  const latched = {
    '/scheduler/report': report, '/scheduler/settings': settings, '/scheduler/mode': mode,
    '/scheduler/journal': { entries: [] },
    '/scheduler/calendar': [{ id: 'ev1', program_name: PROG, site: '', enabled: true, recurrence: 'weekly', start_time: '09:00', days_of_week: [1, 4] }]
  };
  const bools = { '/scheduler/enabled': { data: true }, '/scheduler/inhibit_status': { data: false } };   // std_msgs/Bool
  const PARAMS = { sleep_wait_before_standby_s: 180, sleep_min_off_s: 120, sleep_min_s: 900, sleep_timer_drift: 0.005,
                   sleep_countdown_s: 60, sleep_fail_cooldown_s: 1800, boot_grace_period_s: 300, check_interval_s: 30,
                   sleep_max_segment_h: 12 };
  class WS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob';
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 20);
    }
    addEventListener() {}
    close() { this.readyState = 3; }
    deliver(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    send(raw) {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.op === 'subscribe' && (m.topic in latched || m.topic in bools)) {
        const msg = m.topic in bools ? bools[m.topic] : { data: JSON.stringify(latched[m.topic]) };
        setTimeout(() => this.deliver({ op: 'publish', topic: m.topic, msg }), 5);
      } else if (m.op === 'call_service') {
        let v = {};
        if (m.service === '/rosapi/get_param') {
          const k = String(m.args && m.args.name).split('/').pop();
          v = { value: JSON.stringify(k in PARAMS ? PARAMS[k] : null) };
        } else if (m.service === '/rosapi/get_time') {
          v = { time: { secs: Math.floor(Date.now() / 1000), nsecs: 0 } };
        }
        setTimeout(() => this.deliver({ op: 'service_response', id: m.id, service: m.service, values: v, result: true }), 5);
      }
      // publish, advertise, …: swallowed
    }
  }
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
