#!/usr/bin/env python3
"""The Autonomy page in real Chrome against a fake rosbridge: nothing reaches a robot.

The page is served from this tree on a private port. WebSocket is replaced before the
page runs: the fake answers subscribe, advertise, call_service (rosapi) and writes down
every publish, so a test says "the master reports this" and reads what the page sent.
Tonight's sequence of 2026-11-01 runs as one story (S1..), then the phone. Who decides
(calendar | agent, AUTONOMY.md §6) is mode_story (M0..) and mode_fit on every screen.

    python3 tools/test_autonomy_ui.py [--shots DIR]

Needs python3-playwright + Google Chrome.
"""
import argparse
import datetime as dt
import functools
import http.server
import json
import os
import re
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, 'nodes', 'templates')
FAILS = []
COUNT = [0]


def check(name, ok, detail=''):
    COUNT[0] += 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:400]), flush=True)
    if not ok:
        FAILS.append(name)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] == '/':
            self.path = '/index.html'
        super().do_GET()

    def log_message(self, *a):
        pass


FAKE = r"""
(() => {
  const F = window.__fake = { sent: [], subs: {}, latched: {}, sock: null, cmd: {}, adv: {} };
  const PARAMS = { sleep_wait_before_standby_s: 180, sleep_min_off_s: 120, sleep_min_s: 900, sleep_timer_drift: 0.005,
                   sleep_countdown_s: 60, sleep_fail_cooldown_s: 1800, boot_grace_period_s: 300, check_interval_s: 30,
                   sleep_max_segment_h: 12 };
  class WS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob'; F.sock = this;
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 20);
    }
    addEventListener() {}
    close() { this.readyState = 3; }
    deliver(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.op === 'subscribe') {
        F.subs[m.topic] = 1;
        if (m.topic in F.latched) { setTimeout(() => this.deliver({ op: 'publish', topic: m.topic, msg: F.latched[m.topic] }), 5); }
      } else if (m.op === 'publish') {
        F.sent.push({ topic: m.topic, msg: m.msg, t: Date.now() });
      } else if (m.op === 'call_service') {
        let v = {};
        if (m.service === '/rosapi/get_param') {
          const k = m.args.name.split('/').pop();
          v = { value: JSON.stringify(k in PARAMS ? PARAMS[k] : null) };
        } else if (m.service === '/rosapi/get_time') {
          v = { time: { secs: Math.floor(Date.now() / 1000), nsecs: 0 } };
        }
        setTimeout(() => this.deliver({ op: 'service_response', id: m.id, service: m.service, values: v, result: true }), 5);
      }
    }
  }
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
  F.pub = (topic, msg, latch) => {
    if (latch !== false) { F.latched[topic] = msg; }
    if (F.sock && F.sock.readyState === 1) { F.sock.deliver({ op: 'publish', topic, msg }); }
  };
  F.json = (topic, o) => F.pub(topic, { data: JSON.stringify(o) });
  F.of = (topic) => F.sent.filter((x) => x.topic === topic);
})();
"""


def pm(armed=False):
    """A whole Power_status: map_view.js reads all of it."""
    m = {k: 0.0 for k in ('input_voltage input_current input_power battery_voltage battery_current battery_power '
                          'battery_charge_current battery_charge_power battery_discharge_current battery_discharge_power '
                          'out19_voltage out19_current out19_power temp_setpoint temp2_setpoint temp temp2').split()}
    m.update({k: 0 for k in ('battery_capacity charge_current_setpoint_run charge_current_setpoint_standby '
                             'precharge_current_setpoint_run precharge_current_setpoint_standby fan_rpm fan2_rpm '
                             'standby_timeout').split()})
    m.update({k: '' for k in 'version charger_status supply_status module_status debug_info'.split()})
    m.update({k: False for k in 'charge_switch discharge_switch bat_out_switch motor_out_switch out19v_switch enable19v_switch'.split()})
    m.update(header={'stamp': {'secs': 0, 'nsecs': 0}, 'frame_id': '', 'seq': 0}, sleep_status=armed, sleep_charged_status=False,
             sleep_time_interval=42924000, sleep_wait_standby=180000, sleep_wait_charged=120000)
    return m


def iso(d):
    return d.strftime('%Y-%m-%dT%H:%M')


SCHEMA_KEYS = {
    'sleep_enabled': ('bool', 'sleep'), 'sleep_ignore_ssh': ('bool', 'sleep'), 'sleep_ignore_ui': ('bool', 'sleep'),
    'sleep_after_run': ('bool', 'sleep'), 'idle_sleep_threshold_min': ('float', 'sleep'),
    'wake_before_min': ('float', 'sleep'), 'catchup_max_h': ('float', 'plan')}


def settings(**over):
    values = {'sleep_enabled': True, 'sleep_ignore_ssh': False, 'sleep_ignore_ui': False, 'sleep_after_run': True,
              'idle_sleep_threshold_min': 20.0, 'wake_before_min': 12.0, 'catchup_max_h': 4.0, 'skip_next': None,
              'no_mow_until': None, 'stay_awake_until': None, 'rain_mode': 'always'}
    values.update(over)
    schema = {k: {'type': v[0], 'min': 0, 'max': 1000, 'unit': '', 'group': v[1], 'advanced': False, 'locked': False,
                  'needs_restart': False} for k, v in SCHEMA_KEYS.items()}
    return {'version': 1, 'values': values, 'defaults': dict(values), 'schema': schema}


def checks(**over):
    base = [('enabled', 'ok', 'on', {}), ('hold', 'ok', 'clear', {}), ('dock', 'ok', 'in_dock', {}), ('mission', 'ok', 'free', {}),
            ('manual', 'ok', 'free', {}), ('agent', 'ok', 'free', {}), ('ssh', 'ok', 'none', {}), ('ui', 'ok', 'none', {}),
            ('boot', 'ok', 'done', {}), ('stay_awake', 'ok', 'none', {}), ('reason', 'ok', 'none', {})]
    out = []
    for k, st, c, v in base:
        if k in over:
            st, c, v = over[k]
        out.append({'key': k, 'state': st, 'code': c, 'vars': v})
    return out


def report(now, **over):
    r = {'enabled': True, 'held': False, 'state': 'IDLE', 'code': 'waiting_slot', 'detail': {'program': 'Bigger'}, 'status': 'Idle',
         'battery': 100, 'next': {'program': 'Bigger', 'at': iso(now + dt.timedelta(days=6, hours=23))}, 'pending': [], 'issues': [],
         'outside_window': [], 'window': None, 'window_setting': {'enabled': False, 'start': '07:00', 'end': '21:00', 'stored': True,
                                                                   'min_left_min': 30.0, 'error': None},
         'limits': {'resumes': 12, 'critical': 3}, 'weather': None, 'run': None, 'sentence': {'code': 'waiting_slot', 'vars': {}},
         'checks': [], 'rain_would_refuse': None, 'ignore_rain_once': False, 'reject': None,
         'sleep': {'state': 'IDLE', 'mode': None, 'sleep_ms': 0, 'result': None, 'block': None, 'checks': checks(), 'last_wake':
                   {'mode': 'timed', 'planned_epoch': 1793500000, 'actual_epoch': 1793500010, 'late_s': 10}, 'next_wake': None, 'countdown': None}}
    sleep = over.pop('sleep', None)
    r.update(over)
    if sleep:
        r['sleep'].update(sleep)
    return r


class P(object):
    def __init__(self, ctx, url):
        self.pg = ctx.new_page()
        self.errors = []
        self.pg.on('pageerror', lambda e: self.errors.append(str(e)))
        self.pg.add_init_script(FAKE)
        self.pg.goto(url, wait_until='domcontentloaded')
        self.pg.wait_for_function('window.VTAutonomy && VTAutonomy._state.ros && window.calendarManager', timeout=30000)
        self.pg.wait_for_timeout(600)

    def pub(self, topic, o):
        self.pg.evaluate('([t,o])=>__fake.json(t,o)', [topic, o])
        self.pg.wait_for_timeout(120)

    def raw(self, topic, msg):
        self.pg.evaluate('([t,m])=>__fake.pub(t,m)', [topic, msg])
        self.pg.wait_for_timeout(120)

    def text(self, sel):
        return self.pg.evaluate('(s)=>{const e=document.querySelector(s);return e?e.textContent:null}', sel)

    def sent(self, topic):
        return self.pg.evaluate('(t)=>__fake.of(t).map(x=>x.msg)', topic)

    def line(self):
        return self.text('#span_status_info')

    def until(self, pattern, ms=14000):
        """The queue takes its time: the line gets there within ms."""
        end = dt.datetime.now() + dt.timedelta(milliseconds=ms)
        while dt.datetime.now() < end:
            if re.search(pattern, self.line() or ''):
                return True
            self.pg.wait_for_timeout(200)
        return False

    def tick(self, ms=1100):
        self.pg.wait_for_timeout(ms)

    def open(self, sec=None):
        self.pg.evaluate("""(sec)=>{ VTAutonomy.open(sec||'now', false); }""", sec)
        self.pg.wait_for_timeout(350)

    def click(self, sel):
        self.pg.evaluate('(s)=>document.querySelector(s).click()', sel)
        self.pg.wait_for_timeout(150)

    def lang(self, l):
        self.pg.evaluate('(l)=>VTI18n.set?VTI18n.set(l):VTI18n.setLang(l)', l)
        self.pg.wait_for_timeout(300)


def story(p, shots, label):
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', settings())
    ui_block = checks(ui=('block', 'clients', {'n': 1}))
    p.pub('/scheduler/report', report(now, sleep={'checks': ui_block, 'block': 'ui:1'}))
    p.pub('/scheduler/calendar', [{'id': 'ev1', 'program_name': 'Bigger', 'site': '', 'enabled': True, 'recurrence': 'weekly',
                                   'start_time': '21:30', 'days_of_week': [6]}])
    p.open('sleep')
    p.tick()

    # S1 the plan is said before anything happens
    line = p.text('#auto_sleep_plan')
    check('S1 hero says what holds it and what it would do', 'h' in line and p.pg.evaluate("!document.getElementById('auto_sleep_plan').hidden"), line)
    check('S1 last wake is a time, not an object', 'object' not in (p.text('#auto_nums_sleep') or ''), p.text('#auto_nums_sleep'))
    check('S1 Sleep now min from the data', p.pg.evaluate("document.getElementById('input_auto_sleep_min').min") == '16')
    check('S1 limits shown', '15 min' in (p.text('#auto_limits') or ''), p.text('#auto_limits'))

    # S2 switching on an ignore asks first, with the numbers
    p.click('#auto_in_sleep_ignore_ui')
    warn = p.text('#auto_ignore_warn')
    check('S2 warning instead of saving', p.pg.evaluate("!document.getElementById('auto_ignore_warn').hidden") and re.search(r'\d+ h \d+ min', warn), warn)
    check('S2 nothing sent yet', not p.sent('/scheduler/set_settings'))
    check('S2 switch stays off', not p.pg.evaluate("document.getElementById('auto_in_sleep_ignore_ui').checked"))
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-ignore.png'))
    p.click('#btn_auto_ignore_yes')
    got = p.sent('/scheduler/set_settings')
    check('S2 confirmed: sent', len(got) == 1 and json.loads(got[0]['data'])['values'] == {'sleep_ignore_ui': True}, got)
    req = json.loads(got[0]['data'])['req']
    p.pub('/scheduler/settings_result', {'req': req, 'ok': True, 'rejected': {}})
    p.pub('/scheduler/settings', settings(sleep_ignore_ui=True))

    # S3 the countdown: everywhere at once, with Cancel
    p.pub('/scheduler/report', report(now, sentence={'code': 'sleep_countdown', 'vars': {'left_s': 60}},
                                      sleep={'checks': checks(ui=('off', 'ignored', {'n': 1})), 'block': 'countdown', 'countdown': 60}))
    p.pub('/scheduler/sleep_countdown', {'active': True, 'left_s': 60, 'phase': 'announce', 'mode': 'timed', 'reason': 'auto',
                                         'who': {'ssh': [], 'ui': 1}})
    p.tick()
    top = p.text('#span_scheduler_status')
    line = p.line()
    check('S3 top sentence: when, how long, wake', re.search(r'\d+ s', top) and re.search(r'\d+ h \d+ min', top), top)
    # a phone's row is short: the seconds and the wake, the rest is in the panel
    want = r'\d+ s' if p.pg.viewport_size['width'] < 600 else r'\d+ h \d+ min'
    check('S3 line above the map: the plan + Cancel', re.search(want, line or '') and p.pg.query_selector('#btn_notice_action'), line)
    check('S3 countdown box on the page', p.pg.evaluate("!document.getElementById('auto_countdown').hidden"))
    check('S3 right panel chip', re.search(r'\d+ s', p.text('.rp-auto-chip') or ''), p.text('.rp-auto-chip'))
    check('S3 right panel Cancel', p.pg.query_selector('#btn_rp_sleep_cancel') is not None)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-countdown.png'))
    # Sleep now cannot be dropped silently during a countdown
    p.pg.fill('#input_auto_sleep_min', '60')
    p.click('#btn_auto_sleep_timed')
    p.click('#btn_auto_sleep_timed')
    check('S3 Sleep now in a countdown: not sent, says why', not p.sent('/scheduler/sleep_now') and p.text('#auto_sleep_msg'), p.text('#auto_sleep_msg'))

    # S4 Cancel from the line above the map; the time it holds is stated
    box = p.pg.query_selector('#btn_notice_action').bounding_box()
    check('S4 Cancel on the line is clickable', box is not None and box['x'] + box['width'] <= p.pg.viewport_size['width'], box)
    p.pg.evaluate("document.getElementById('btn_notice_action').scrollIntoView()")
    p.pg.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    p.pg.wait_for_timeout(200)
    check('S4 cancel sent', len(p.sent('/scheduler/sleep_cancel')) == 1, p.sent('/scheduler/sleep_cancel'))
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pub('/scheduler/report', report(now, sleep={'checks': checks(ui=('off', 'ignored', {'n': 1}), reason=('wait', 'countdown_cancelled', {'left_s': 1800})),
                                                  'block': 'countdown_cancelled'}))
    p.tick()
    until = (dt.datetime.now() + dt.timedelta(seconds=1800)).strftime('%H:')
    check('S4 sentence: until when', until in (p.text('#auto_sleep_plan') or ''), p.text('#auto_sleep_plan'))
    check('S4 line: cancelled until when', until in (p.line() or ''), p.line())
    check('S4 no Cancel left', p.pg.query_selector('#btn_notice_action') is None)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-cancelled.png'))

    # S5 Sleep now: 5 minutes says the limit, the value and where
    p.pub('/scheduler/report', report(now))
    p.pg.fill('#input_auto_sleep_min', '5')
    p.pg.wait_for_timeout(150)
    tx = p.text('#auto_sleep_preview')
    check('S5 refused before sending: limit, value, where', '16' in tx and '5' in tx and 'sleep_min_s' in tx, tx)
    p.click('#btn_auto_sleep_timed')
    p.click('#btn_auto_sleep_timed')
    check('S5 not sent', not p.sent('/scheduler/sleep_now'))
    p.pg.fill('#input_auto_sleep_min', '16')
    p.pg.wait_for_timeout(150)
    tx = p.text('#auto_sleep_preview')
    check('S5 preview', re.search(r'\d+:\d\d', tx), tx)
    p.click('#btn_auto_sleep_timed')
    p.click('#btn_auto_sleep_timed')
    got = p.sent('/scheduler/sleep_now')
    check('S5 sent as typed', len(got) == 1 and json.loads(got[0]['data']) == {'mode': 'timed', 'ms': 960000}, got)
    p.pub('/scheduler/command_result', {'cmd': 'sleep_now', 'ok': False, 'code': 'login:pts/0'})
    tx = p.text('#auto_sleep_msg')
    check('S5 refusal in words: who and what to do', 'pts/0' in tx and '_' not in tx.split('pts')[0], tx)
    # a latched answer of long ago is not news
    p.pg.evaluate("document.getElementById('auto_sleep_msg').textContent=''")
    p.pub('/scheduler/command_result', {'cmd': 'sleep_now', 'ok': False, 'code': 'too_short'})
    check('S5 old answer ignored', not p.text('#auto_sleep_msg'), p.text('#auto_sleep_msg'))

    # S6 a failure after "accepted" is reported
    p.click('#btn_auto_sleep_timed')
    p.click('#btn_auto_sleep_timed')
    p.pub('/scheduler/command_result', {'cmd': 'sleep_now', 'ok': True, 'code': 'sleeping'})
    p.pub('/scheduler/report', report(now, state='PREPARE_SLEEP', code='sleep_prepare', sleep={'state': 'ARM', 'mode': 'timed', 'sleep_ms': 955200,
                                                                                               'next_wake': iso(now + dt.timedelta(minutes=16))}))
    p.tick()
    p.pg.wait_for_selector('#btn_notice_action', timeout=9000)
    check('S6 sequence: the line says it, with Cancel', p.pg.query_selector('#btn_notice_action') is not None, p.line())
    p.pub('/scheduler/report', report(now, sleep={'state': 'IDLE', 'result': 'pm_no_ack', 'block': 'pm_no_ack',
                                                  'checks': checks(reason=('wait', 'pm_no_ack', {'left_s': 1790}))}))
    p.tick()
    check('S6 failure shown', 'nepotvrd' in (p.text('#auto_sleep_msg') or '') or 'confirm' in (p.text('#auto_sleep_msg') or ''), p.text('#auto_sleep_msg'))
    check('S6 line shows it', p.line() and len(p.line()) > 5, p.line())

    # S7 a start inside the sleep: it asks
    near = now + dt.timedelta(minutes=50)
    p.pub('/scheduler/report', report(now, next={'program': 'Bigger', 'at': iso(near)}))
    p.pg.fill('#input_auto_sleep_min', '120')
    p.pg.wait_for_timeout(150)
    check('S7 preview warns', p.pg.evaluate("document.getElementById('auto_sleep_preview').dataset.state") == 'warn', p.text('#auto_sleep_preview'))
    n = len(p.sent('/scheduler/sleep_now'))
    p.click('#btn_auto_sleep_timed')
    check('S7 first tap offers the choice', p.pg.evaluate("!document.getElementById('auto_sleep_choice').hidden"))
    check('S7 nothing sent yet', len(p.sent('/scheduler/sleep_now')) == n)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-choice.png'))
    p.click('#btn_auto_sleep_skip')
    got = p.sent('/scheduler/set_settings')
    body = json.loads(got[-1]['data'])
    check('S7 skip goes first', body['values'] == {'skip_next': True}, body)
    check('S7 sleep waits for the skip', len(p.sent('/scheduler/sleep_now')) == n)
    p.pub('/scheduler/settings_result', {'req': body['req'], 'ok': True, 'rejected': {}})
    check('S7 then the sleep', len(p.sent('/scheduler/sleep_now')) == n + 1)
    p.pub('/scheduler/command_result', {'cmd': 'sleep_now', 'ok': False, 'code': 'busy:mission'})

    # S8 a start used up today: said, and one tap
    used = now + dt.timedelta(hours=1)
    if used.date() == now.date():
        p.pub('/scheduler/report', report(now))
        p.pub('/scheduler/timeline', {'starts': [{'t': iso(used), 'program': 'Bigger', 'site': None, 'event_id': 'ev1', 'state': 'skip', 'reason': 'already_run'}], 'sleeps': []})
        p.open('plan')
        tx = p.text('#auto_used')
        check('S8 used slot explained, next start named', 'Bigger' in tx and used.strftime('%H:%M') in tx, tx)
        p.click('.vt-auto-used-run')
        got = p.sent('/scheduler/set_calendar')
        ev = json.loads(got[-1]['data'])[0]
        check('S8 same entry under a new id', ev['id'] != 'ev1' and ev['start_time'] == '21:30', ev)
        p.pub('/scheduler/calendar', json.loads(got[-1]['data']))
        p.pub('/scheduler/timeline', {'starts': [], 'sleeps': []})
    else:
        print('skip S8: an hour from now is tomorrow')

    # S9 moving an entry gives a new id, not during a run
    p.pub('/scheduler/calendar', [{'id': 'ev2', 'program_name': 'Bigger', 'site': '', 'enabled': True, 'recurrence': 'daily', 'start_time': '08:00'}])
    moved = p.pg.evaluate("""()=>{const c=calendarManager; const a={start_time:'08:00',recurrence:'daily'}, b={start_time:'09:00',recurrence:'daily'};
        return [c._moved(a,b), c._moved(a,Object.assign({},a)), c._moved({days_of_week:[1]},{days_of_week:[2]})];}""")
    check('S9 moved?', moved == [True, False, True], moved)
    p.pub('/scheduler/report', report(now, run={'program': 'Bigger', 'slot': None, 'started': True}))
    check('S9 open run: not released', p.pg.evaluate("calendarManager.releaseSlot('ev2')") is False)
    p.pub('/scheduler/report', report(now))

    # S10 state changes on the line, plain language, no repeats
    p.pub('/scheduler/report', report(now, code='waiting_gps', detail={'program': 'Bigger', 'left_s': 300}, run={'program': 'Bigger', 'slot': None}))
    check('S10 waiting for RTK', p.until('RTK'), p.line())
    p.pub('/scheduler/report', report(now))
    p.pub('/scheduler/journal', {'entries': []})
    p.pub('/scheduler/journal', {'entries': [{'t': iso(now), 'kind': 'finished', 'code': 'succeeded', 'program': 'Bigger', 'vars': {}}]})
    check('S10 finished', p.until('Bigger'), p.line())

    # S11 the robot's own lines still get through, the dock's first of all, in the UI language
    p.raw('/nextion/log_info', {'data': 'Waiting for dock cmd'})
    check('S11 dock line shown and translated', p.until('(?i)dok|dock'), p.line())
    p.raw('/mower_smach/status', {'data': 'Ready'})
    p.raw('/mower_smach/status', {'data': 'Stopped'})
    p.tick()
    check('S11 STOP takes the line', 'STOP' in (p.line() or ''), p.line())
    check('S11 STOP is marked', p.pg.evaluate("document.getElementById('span_status_info').dataset.level") == '0')
    p.raw('/nextion/log_info', {'data': 'Set speed: 0.5'})
    p.pg.wait_for_timeout(3000)
    check('S11 a routine line does not push it off', 'STOP' in (p.line() or ''), p.line())
    p.raw('/mower_smach/status', {'data': 'Ready'})
    p.pub('/scheduler/report', report(now, code='no_schedule'))
    p.tick()
    check('S11 STOP goes when it is over', 'STOP' not in (p.line() or ''), p.line())
    p.pub('/mower/link', {'state': 'ok'})
    p.pub('/mower/link', {'state': 'silent', 'silent_s': 6})
    p.pg.wait_for_timeout(5500)

    # S12 raw sleep: says the number, needs a second press
    p.raw('/pm/power_status', pm())
    p.tick()
    check('S12 the 715 is explained', '715' in (p.text('#auto_raw_state') or ''), p.text('#auto_raw_state'))
    n = len(p.sent('/pm/set_robot_sleep'))
    p.click('#btn_sleep_timed')
    tx = p.text('#auto_raw_state')
    check('S12 raw asks with the number', '715' in tx and len(p.sent('/pm/set_robot_sleep')) == n, tx)
    p.click('#btn_auto_raw_go')
    check('S12 then it goes', len(p.sent('/pm/set_robot_sleep')) == n + 1)
    p.raw('/pm/power_status', pm(True))
    p.tick()
    p.pg.fill('#input_auto_sleep_min', '60')
    p.pg.wait_for_timeout(150)
    check('S12 Sleep now knows of a raw sleep', p.pg.evaluate("document.getElementById('auto_sleep_preview').dataset.state") == 'warn', p.text('#auto_sleep_preview'))
    p.raw('/pm/power_status', pm())

    # ros3d's marker client on the fake's empty service answer, not the page
    errs = [e for e in p.errors if 'erases' not in e]
    check('no page errors', not errs, errs[:3])


def hw_story(p, shots, label):
    """Hard reset against a fake PM: the fake answers with what the page last wrote."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pub('/scheduler/report', report(now))
    p.raw('/mower_smach/status', {'data': 'Ready'})
    p.pub('/scheduler/settings', settings())
    p.open('sleep')
    def pmsg(w=180000, t=42924000, armed=False, online='ONLINE'):
        m = pm(armed)
        m.update(sleep_wait_standby=w, sleep_time_interval=t, supply_status=online)
        p.raw('/pm/power_status', m)
    # the guards
    pmsg(online='OFFLINE')
    p.click('#auto_hw .vt-hw-go')
    tx = p.text('#auto_hw .vt-hw-state')
    check('H1 refused off the charger, in words', 'hw.' not in tx and len(tx) > 10 and not p.pg.evaluate("!document.querySelector('#auto_hw .vt-hw-confirm').hidden"), tx)
    pmsg()
    p.pub('/scheduler/report', report(now, sleep={'checks': checks(dock=('block', 'off_dock', {}))}))
    p.click('#auto_hw .vt-hw-go')
    check('H1 refused off the dock', not p.pg.evaluate("!document.querySelector('#auto_hw .vt-hw-confirm').hidden"), p.text('#auto_hw .vt-hw-state'))
    p.pub('/scheduler/report', report(now))
    pmsg()
    # the confirm says it all
    p.click('#auto_hw .vt-hw-go')
    tx = p.text('#auto_hw .vt-hw-confirm')
    check('H2 confirm: 60 s, page, Claude, hard cut', '60' in tx and 'Claude' in tx and p.pg.evaluate("!document.querySelector('#auto_hw .vt-hw-confirm').hidden"), tx)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-hw.png'))
    check('H2 nothing sent yet', not p.sent('/pm/set_sleep_wait_before_standby'))
    n0 = len(p.sent('/pm/set_robot_sleep'))
    p.click('#auto_hw .vt-hw-yes')
    p.tick(1200)
    wait = p.sent('/pm/set_sleep_wait_before_standby')
    tm = p.sent('/pm/set_sleep_time')
    check('H3 W then T = W + 60 s', wait and wait[-1]['data'] == 20000 and tm[-1]['data'] == 80000, [wait, tm])
    check('H3 no arm before the read-back', len(p.sent('/pm/set_robot_sleep')) == n0)
    pmsg(20000, 80000)
    p.tick(1200)
    pmsg(20000, 80000)
    p.tick(1200)
    check('H3 armed after the read-back', len(p.sent('/pm/set_robot_sleep')) == n0 + 1 and p.sent('/pm/set_robot_sleep')[-1]['data'] is True)
    pmsg(20000, 80000, True)
    p.tick(1200)
    pmsg(20000, 80000, True)
    tx = p.text('#auto_hw .vt-hw-state')
    check('H4 countdown', re.search(r'\d+ s', tx), tx)
    check('H4 on the line with Cancel', p.until(r'\d+ s', 8000) and p.pg.query_selector('#btn_notice_action') is not None, p.line())
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-hw-count.png'))
    # Cancel with read-back
    p.click('#auto_hw .vt-hw-cancel')
    p.tick(1200)
    last = p.sent('/pm/set_robot_sleep')[-1]
    check('H5 cancel sent', last['data'] is False, last)
    pmsg(20000, 80000, False)
    p.tick(1200)
    pmsg(20000, 80000, False)
    p.tick(1200)
    check('H5 said', len(p.text('#auto_hw .vt-hw-state')) > 5, p.text('#auto_hw .vt-hw-state'))
    p.tick(3200)
    w = p.sent('/pm/set_sleep_wait_before_standby')[-1]['data']
    check('H5 W put back', w == 180000, w)
    pmsg()
    p.tick(1200)
    # the other control and the way through a real cut
    check('H6 also in Settings > Power', p.pg.query_selector('#auto_hw2 .vt-hw-go') is not None)
    p.pg.evaluate("localStorage.setItem('vitulus_hw_reset', JSON.stringify({n:60,w0:180000,t0:42924000,cut:Date.now()-90000,back:Date.now()-20000}))")
    p.pg.evaluate("VTAutonomy._state.hw = null")
    pmsg(20000, 80000)
    p.tick(1300)
    pmsg(20000, 80000)
    p.tick(1300)
    check('H6 after the reconnect it says what happened', re.search(r'(?i)restart|reset', p.text('#auto_hw .vt-hw-state') or '') is not None, p.text('#auto_hw .vt-hw-state'))
    check('no page errors in the hard reset', not [e for e in p.errors if 'erases' not in e], p.errors[:3])


def link_story(p, shots, label):
    """/mower/link: the banner on the page, in the right panel, above the map; the reset."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pub('/scheduler/report', report(now))
    p.open('now')
    p.pub('/mower/link', {'state': 'ok', 'banner': None})
    check('no banner while it answers', p.pg.locator('#auto_link').is_hidden())
    p.pub('/mower/link', {'state': 'silent', 'banner': 'silent', 'silent_s': 9})
    p.tick()
    text = p.text('#auto_link')
    check('banner on the page', p.pg.locator('#auto_link').is_visible() and len(text) > 10, text)
    check('in the right panel', p.pg.locator('.rp-auto-link').text_content() == text)
    check('above the map', p.until(re.escape(text[:20])), p.line())
    p.pub('/mower/link', {'state': 'ok', 'banner': None})
    p.tick()
    check('gone when it answers', p.pg.locator('#auto_link').is_hidden())
    p.pub('/scheduler/report', report(now, sentence={'code': 'hw_reset_countdown', 'vars': {'left_s': 60}}))
    p.pub('/scheduler/sleep_countdown', {'active': True, 'left_s': 60, 'phase': 'announce', 'mode': 'timed',
                                         'reason': 'hw_reset', 'who': {'ssh': [], 'ui': 1}})
    p.tick()
    word = 'restart' if label.endswith('cs') else 'reset'
    box = p.text('#auto_countdown')
    check('the countdown says reset', word in box.lower(), box)
    check('with Cancel', p.pg.locator('#auto_countdown button').count() > 0, box)
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pub('/scheduler/report', report(now))


AGENT_SCHEMA = {
    'agent_fallback_calendar': ('bool', '', None, None, True), 'limits_in_calendar': ('bool', '', None, None, False),
    'limit_rain_h': ('float', 'h', 0, 48, 3.0), 'limit_temp_min_c': ('float', 'C', -10, 25, 5.0),
    'limit_zone_gap_days': ('float', 'd', 0, 14, 2.0), 'limit_day_start': ('time', '', None, None, '08:00'),
    'limit_day_end': ('time', '', None, None, '20:00')}


def agent_settings():
    """settings() + the agent group, keys sorted as master_controller sends them."""
    s = settings()
    for k, (typ, unit, lo, hi, v) in AGENT_SCHEMA.items():
        s['values'][k] = s['defaults'][k] = v
        s['schema'][k] = {'type': typ, 'min': lo, 'max': hi, 'unit': unit, 'group': 'agent', 'advanced': False,
                          'locked': False, 'needs_restart': False}
    s['schema'] = dict(sorted(s['schema'].items()))
    return s


def mode_view(mode='calendar', **over):
    """/scheduler/mode as master_controller._mode_view builds it."""
    v = {'mode': mode, 'dock_permitted': None if mode == 'calendar' else False,
         'dock_why': None if mode == 'calendar' else 'majitel dok nepovolil', 'state': 'IDLE', 'automation': True,
         'held': False, 'fallback': True, 'limits_apply': mode == 'agent', 'changed': None, 'advice': None,
         'last_decision': None, 'limit_now': None,
         'limits': {'day_start': '08:00', 'day_end': '20:00', 'rain_h': 3.0, 'temp_min_c': 5.0, 'zone_gap_days': 2.0,
                    'in_calendar': False},
         'weather': {'hours_since_rain': 30.0, 'rain_last_h': 0.0, 'temp_now': 12.0}, 'last_mow': {}}
    v.update(over)
    return v


def mode_story(p, shots, label):
    """Who decides: the switch sends only on a press; the agent's advice, the last decision, the dock (D36)."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    # a latched answer to somebody's press long ago comes first: it says nothing
    p.pub('/scheduler/command_result', {'cmd': 'set_mode', 'ok': True, 'code': 'changed'})
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/report', report(now))
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.open('mode')
    check('M0 nothing sent to set_mode on load', not p.sent('/scheduler/set_mode'), p.sent('/scheduler/set_mode'))
    check('M0 old latched answer not shown', not p.text('#auto_mode_msg'), p.text('#auto_mode_msg'))
    sel = p.pg.evaluate("[...document.querySelectorAll('#auto_mode_choice .vt-auto-choice')].map(b=>[b.dataset.mode,b.getAttribute('aria-checked'),b.disabled])")
    check('M1 the robot\'s mode is selected', sel == [['calendar', 'true', False], ['agent', 'false', False]], sel)
    check('M1 head says calendar', ('Kalendář' if cs else 'Calendar') in (p.text('#auto_tok_mode') or ''), p.text('#auto_tok_mode'))
    order = p.pg.evaluate("[...document.querySelectorAll('[data-auto-group=agent] .vt-auto-set')].map(r=>r.dataset.key)")
    check('M1 limits in their order', order == ['agent_fallback_calendar', 'limits_in_calendar', 'limit_day_start', 'limit_day_end',
                                                'limit_rain_h', 'limit_temp_min_c', 'limit_zone_gap_days'], order)
    check('M1 a time is 24 h text', p.pg.evaluate("document.getElementById('auto_in_limit_day_start').value") == '08:00')
    check('M1 °C next to the temperature', '°C' in (p.text('[data-key=limit_temp_min_c] .vt-auto-unit') or ''))
    # a press of the selected mode sends nothing
    p.click('#btn_auto_mode_calendar')
    check('M2 same mode: nothing sent', not p.sent('/scheduler/set_mode'))
    p.click('#btn_auto_mode_agent')
    got = p.sent('/scheduler/set_mode')
    check('M2 agent: one message, by the owner', len(got) == 1 and json.loads(got[0]['data']) == {'mode': 'agent', 'by': 'owner'}, got)
    check('M2 buttons wait for the answer', p.pg.evaluate("document.getElementById('btn_auto_mode_calendar').disabled"))
    p.click('#btn_auto_mode_agent')
    check('M2 no second message while waiting', len(p.sent('/scheduler/set_mode')) == 1)
    p.pub('/scheduler/command_result', {'cmd': 'set_mode', 'ok': True, 'code': 'changed'})
    p.pub('/scheduler/mode', mode_view('agent'))
    msg = p.text('#auto_mode_msg') or ''
    check('M2 answer said', 'Agent' in msg, msg)
    check('M2 agent selected', p.pg.evaluate("document.getElementById('btn_auto_mode_agent').getAttribute('aria-checked')") == 'true')
    check('M2 dock locked said quietly', ('zamčený' if cs else 'locked') in (p.text('#auto_mode_notes') or ''), p.text('#auto_mode_notes'))
    check('M2 no attention box without an advice', p.pg.locator('#auto_mode_attn').is_hidden())

    # D36: a mow advice in its window, the dock locked
    frm, to = now - dt.timedelta(minutes=5), now + dt.timedelta(hours=3)
    adv = {'id': 'a1', 'action': 'mow', 'program': 'Bigger', 'from': iso(frm) + ':00', 'to': iso(to) + ':00', 'until': None,
           'expires': iso(to) + ':00', 'reason': 'Dry for two days, the grass grows fast.', 'confidence': 0.8, 'by': 'agent',
           'received': iso(frm) + ':00', 'state': 'pending', 'fresh': True}
    dec = {'t': iso(now) + ':00', 'kind': 'advice', 'code': 'waiting', 'program': 'Bigger', 'source': 'agent',
           'vars': {'id': 'a1', 'why': 'dock:waiting_dock', 'dock': 'majitel dok nepovolil'}}
    p.pub('/scheduler/report', report(now, code='waiting_dock', detail={'program': 'Bigger', 'at': iso(to) + ':00'},
                                      sentence={'code': 'waiting_dock', 'vars': {'program': 'Bigger', 'at': iso(to) + ':00'}}))
    p.pub('/scheduler/mode', mode_view('agent', advice=adv, last_decision=dec))
    attn = p.text('#auto_mode_attn') or ''
    check('M3 waiting for the dock: said with the program', p.pg.locator('#auto_mode_attn').is_visible() and 'Bigger' in attn
          and ('povolení doku' if cs else 'dock permission') in attn, attn)
    check('M3 the way to the dock lock', p.pg.locator('#btn_auto_mode_dock').is_visible())
    check('M3 head token amber', p.pg.evaluate("document.getElementById('auto_sec_mode').dataset.state") == 'warn')
    top = p.text('#span_scheduler_status') or ''
    check('M3 top sentence in words', 'Bigger' in top and 'calmgr' not in top and ('dok' if cs else 'dock') in top.lower(), top)
    adv_t = p.text('#auto_mode_advice') or ''
    check('M3 advice: what, reason, confidence', 'Bigger' in adv_t and 'Dry for two days' in adv_t and '80' in adv_t, adv_t)
    last = p.text('#auto_mode_last') or ''
    check('M3 last decision: what and why in words', 'Bigger' in last and '_' not in last and ('doku' if cs else 'dock') in last, last)
    if shots:
        p.pg.evaluate("document.getElementById('auto_sec_mode').scrollIntoView()")
        p.pg.screenshot(path=os.path.join(shots, label + '-mode-dock.png'))
    # the press of the dock link goes to the Agent panel, nothing is sent. The real Agent
    # panel opens its own sockets, which would take the fake's place: a stand-in button.
    p.pg.evaluate("""()=>{const a=document.getElementById('btn_agent')||document.body.appendChild(document.createElement('button'));
        const b=a.cloneNode(false); b.id='btn_agent'; b.onclick=null; b.addEventListener('click',()=>{b.dataset.hit='1'}); a.replaceWith(b);}""")
    n = len(p.pg.evaluate('__fake.sent'))
    p.click('#btn_auto_mode_dock')
    check('M3 dock link: to the Agent panel, nothing sent', len(p.pg.evaluate('__fake.sent')) == n
          and p.pg.evaluate("document.getElementById('btn_agent').dataset.hit") == '1')
    p.open('mode')

    # a limit holds the next start; the journal says it in words
    p.pub('/scheduler/report', report(now, code='limit_rain', detail={'program': 'Bigger', 'hours_since_rain': 1.5, 'need_h': 3.0},
                                      sentence={'code': 'limit_rain', 'vars': {'program': 'Bigger', 'hours_since_rain': 1.5, 'need_h': 3.0}}))
    p.pub('/scheduler/mode', mode_view('agent', dock_permitted=True, dock_why=None,
                                       limit_now={'code': 'limit_rain', 'vars': {'hours_since_rain': 1.5, 'need_h': 3.0}, 'program': 'Bigger'},
                                       last_decision={'t': iso(now) + ':00', 'kind': 'waited', 'code': 'limit_rain', 'program': 'Bigger',
                                                      'source': 'calendar', 'vars': {'hours_since_rain': 1.5, 'need_h': 3.0}}))
    notes = p.text('#auto_mode_notes') or ''
    check('M4 limit now: the numbers', '1.5' in notes and '3' in notes, notes)
    check('M4 dock open said', ('odemčený' if cs else 'unlocked') in notes, notes)
    check('M4 no dock box', p.pg.locator('#auto_mode_attn').is_hidden())
    last = p.text('#auto_mode_last') or ''
    check('M4 limit decision in words', '1.5' in last and 'limit_' not in last, last)
    top = p.text('#span_scheduler_status') or ''
    check('M4 top sentence', '1.5' in top and 'calmgr' not in top, top)
    # agent_blocked by a limit (master _agent_idle): with its numbers, and from an older
    # master without them - then the limit's name, never a {placeholder}
    for detail, want in (({'hours_since_rain': 1.5, 'need_h': 3.0}, '1.5'), ({}, 'déšť' if cs else 'rain')):
        d = dict({'program': 'Bigger', 'why': 'limit:limit_rain'}, **detail)
        p.pub('/scheduler/report', report(now, code='agent_blocked', detail=d, sentence={'code': 'agent_blocked', 'vars': d}))
        top = p.text('#span_scheduler_status') or ''
        check('M4 agent_blocked by rain %s: in words' % ('with numbers' if detail else 'without numbers'),
              want in top and '{' not in top and 'limit_' not in top, top)
    p.pub('/scheduler/journal', {'entries': [
        {'t': iso(now) + ':00', 'kind': 'mode', 'code': 'agent', 'program': '', 'vars': {'by': 'owner'}},
        {'t': iso(now) + ':00', 'kind': 'advice', 'code': 'rejected', 'program': 'X', 'vars': {'why': 'not_on_map'}},
        {'t': iso(now) + ':00', 'kind': 'skipped', 'code': 'limit_zone_gap', 'program': 'Bigger',
         'vars': {'zone': 'Front', 'days': 0.5, 'need_days': 2.0}}]})
    p.open('history')
    j = p.text('#auto_journal') or ''
    check('M5 journal of the agent in words', 'Front' in j and '_' not in j and ('mapě' if cs else 'map') in j, j)

    # a limit in the agent group is saved like any setting
    p.open('mode')
    n_set = len(p.sent('/scheduler/set_settings'))
    p.pg.fill('#auto_in_limit_day_start', '25:00')
    p.pg.dispatch_event('#auto_in_limit_day_start', 'change')
    p.pg.wait_for_timeout(150)
    check('M6 no time of day: not sent, said', len(p.sent('/scheduler/set_settings')) == n_set and p.text('[data-key=limit_day_start] .vt-auto-msg'),
          p.text('[data-key=limit_day_start] .vt-auto-msg'))
    p.pg.fill('#auto_in_limit_day_start', '9.00')
    p.pg.dispatch_event('#auto_in_limit_day_start', 'change')
    p.pg.wait_for_timeout(150)
    got = p.sent('/scheduler/set_settings')
    body = json.loads(got[-1]['data']) if got else {}
    check('M6 a limit saved', body.get('values') == {'limit_day_start': '09:00'}, got[-1:] if got else got)
    p.pub('/scheduler/settings_result', {'req': body.get('req'), 'ok': True, 'rejected': {}})
    # back to the calendar, an old master without the topic
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/report', report(now))


def mode_fit(p, shots, label):
    """The section on this screen: no sideways scroll, finger-size targets on touch, nothing cut."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    frm, to = now - dt.timedelta(minutes=5), now + dt.timedelta(hours=3)
    adv = {'id': 'a1', 'action': 'mow', 'program': 'Bigger', 'from': iso(frm) + ':00', 'to': iso(to) + ':00', 'until': None,
           'expires': iso(to) + ':00', 'reason': 'Dry for two days, the grass grows fast.', 'confidence': 0.8, 'by': 'agent',
           'received': iso(frm) + ':00', 'state': 'pending', 'fresh': True}
    p.pub('/scheduler/report', report(now, code='waiting_dock', detail={'program': 'Bigger'},
                                      sentence={'code': 'waiting_dock', 'vars': {'program': 'Bigger'}}))
    p.pub('/scheduler/mode', mode_view('agent', advice=adv, last_decision={
        't': iso(now) + ':00', 'kind': 'advice', 'code': 'waiting', 'program': 'Bigger', 'source': 'agent',
        'vars': {'why': 'dock:waiting_dock'}}))
    p.open('mode')
    p.pg.evaluate("document.getElementById('auto_sec_mode').scrollIntoView()")
    p.pg.wait_for_timeout(200)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const sec=document.getElementById('auto_sec_mode');
        /* cut only with … and the whole text in the title */
        const over=[...sec.querySelectorAll('*')].filter(e=>e.offsetParent&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible'
              &&!e.classList.contains('vt-auto-toks')&&!(getComputedStyle(e).textOverflow==='ellipsis'&&e.title===e.textContent)).map(e=>e.id||e.className);
        /* a switch is the box around it (a label for it) */
        const small=q('#auto_sec_mode button, #auto_sec_mode input, #auto_sec_mode summary').map(e=>e.type==='checkbox'&&e.closest('label')?e.closest('label'):e).map(e=>{const b=e.getBoundingClientRect();
              return [e.id||e.className||e.tagName, Math.round(b.width), Math.round(b.height)]}).filter(x=>x[2]<40);
        const cut=[...document.querySelectorAll('#auto_tok_mode .vt-pill')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent);
        const out=q('#auto_sec_mode *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        return {w:document.documentElement.scrollWidth, sec:sec.scrollWidth-sec.clientWidth, coarse:matchMedia('(pointer: coarse)').matches,
                small, over, out, cut}}""")
    check(label + ' mode: no sideways scroll', r['w'] <= vw + 1 and r['sec'] <= 1 and not r['out'], r)
    check(label + ' mode: nothing cut (… + title allowed)', not r['over'], r['over'])
    check(label + ' mode: head tokens whole', not r['cut'], r['cut'])
    if r['coarse']:
        check(label + ' mode: touch targets >= 40 px', not r['small'], r['small'])
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-mode.png'))


def layout(p, shots, label):
    """The line, its button and the right panel on this screen."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', settings(sleep_ignore_ui=True, sleep_ignore_ssh=True))
    p.pub('/scheduler/report', report(now, sentence={'code': 'sleep_countdown', 'vars': {'left_s': 60}},
                                      sleep={'checks': checks(ui=('off', 'ignored', {'n': 1})), 'block': 'countdown', 'countdown': 60}))
    p.pub('/scheduler/sleep_countdown', {'active': True, 'left_s': 60, 'phase': 'announce', 'mode': 'timed', 'reason': 'auto', 'who': {'ssh': ['pts/0'], 'ui': 1}})
    p.pg.wait_for_selector('#btn_notice_action', timeout=15000)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const r=document.getElementById('span_status_info').getBoundingClientRect(),
        b=document.getElementById('btn_notice_action').getBoundingClientRect();
        const hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
        return {l:r.left,r:r.right,t:r.top,h:r.height,bh:b.height,bw:b.width,hit:hit&&hit.id,w:document.documentElement.scrollWidth}}""")
    check(label + ' line inside the screen', r['l'] >= 0 and r['r'] <= vw + 1 and r['t'] >= 0, r)
    check(label + ' Cancel reachable, nothing over it', r['hit'] == 'btn_notice_action', r)
    if vw < 600:
        check(label + ' Cancel big enough for a finger', r['bh'] >= 36, r)
    check(label + ' no sideways scroll', r['w'] <= vw + 1, r)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-layout.png'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', default='')
    a = ap.parse_args()
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=TPL))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/' % srv.server_port
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=False,
                               args=['--headless=new', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
        for lang, vp, phone, label in (('cs', (1440, 900), False, 'desk-cs'), ('en', (390, 844), True, 'phone-en')):
            print('--- %s' % label, flush=True)
            ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone, service_workers='block',
                                locale='cs-CZ' if lang == 'cs' else 'en-US', timezone_id='Europe/Prague')
            p = P(ctx, url)
            p.lang(lang)
            story(p, a.shots, label)
            hw_story(p, a.shots, label)
            link_story(p, a.shots, label)
            mode_story(p, a.shots, label)
            mode_fit(p, a.shots, label)
            layout(p, a.shots, label)
            ctx.close()
        # the other language on the other screen: only that it fits
        for lang, vp, phone, label in (('cs', (390, 844), True, 'phone-cs'), ('en', (1440, 900), False, 'desk-en'),
                                       ('cs', (360, 740), True, 'small-cs'), ('cs', (768, 1024), True, 'tablet-cs')):
            print('--- %s' % label, flush=True)
            ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone, service_workers='block',
                                timezone_id='Europe/Prague')
            p = P(ctx, url)
            p.lang(lang)
            mode_fit(p, a.shots, label)
            if label != 'tablet-cs':    # the line above the map at 768 px: not this panel's (see the report)
                layout(p, a.shots, label)
            ctx.close()
        b.close()
    srv.shutdown()
    print('%s of %d checks' % ('%d FAILED' % len(FAILS) if FAILS else 'all ok', COUNT[0]))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
