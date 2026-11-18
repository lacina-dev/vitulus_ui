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

    def until_not(self, pattern, ms=14000):
        """The line lets go of the pattern within ms."""
        return bool(self.wait(lambda: not re.search(pattern, self.line() or ''), ms))

    def wait(self, fn, ms=8000):
        """Reads until fn() is truthy or ms have passed and returns the last value: a page slowed by the
        machine's load gets its time to repaint, a quick one is not kept waiting. For what is EXPECTED to
        appear; a check that something does NOT happen keeps its fixed pause."""
        end = dt.datetime.now() + dt.timedelta(milliseconds=ms)
        while True:
            v = fn()
            if v or dt.datetime.now() >= end:
                return v
            self.pg.wait_for_timeout(100)

    def wait_text(self, sel, needle, ms=8000):
        """The element's text once it holds needle (or what it holds after ms)."""
        self.wait(lambda: needle in (self.text(sel) or ''), ms)
        return self.text(sel)

    def tick(self, ms=1100):
        self.pg.wait_for_timeout(ms)

    def open(self, sec=None):
        self.pg.evaluate("""(sec)=>{ VTAutonomy.open(sec||'now', false); }""", sec)
        self.pg.wait_for_timeout(350)

    def click(self, sel):
        self.pg.evaluate('(s)=>document.querySelector(s).click()', sel)
        self.pg.wait_for_timeout(150)

    def open_limits(self):
        """T21 A1: Rules and hard limits fold while not in force; open them like the owner would."""
        self.pg.evaluate("()=>{const d=document.getElementById('auto_mode_limits'); if(d&&!d.open){d.querySelector('summary').click();}}")
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
    p.wait(lambda: re.search(r'\d+ s', p.text('#span_scheduler_status') or ''))
    top = p.text('#span_scheduler_status')
    check('S3 top sentence: when, how long, wake', re.search(r'\d+ s', top) and re.search(r'\d+ h \d+ min', top), top)
    # a phone's row is short: the seconds and the wake, the rest is in the panel
    want = r'\d+ s' if p.pg.viewport_size['width'] < 600 else r'\d+ h \d+ min'
    p.wait(lambda: re.search(want, p.line() or '') and p.pg.query_selector('#btn_notice_action'))
    line = p.line()
    check('S3 line above the map: the plan + Cancel', re.search(want, line or '') and p.pg.query_selector('#btn_notice_action'), line)
    check('S3 countdown box on the page', p.pg.evaluate("!document.getElementById('auto_countdown').hidden"))
    check('S3 right panel chip', p.wait(lambda: re.search(r'\d+ s', p.text('.rp-auto-chip') or '')), p.text('.rp-auto-chip'))
    check('S3 right panel Cancel', p.wait(lambda: p.pg.query_selector('#btn_rp_sleep_cancel') is not None))
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
    p.wait(lambda: p.sent('/scheduler/sleep_cancel'))
    check('S4 cancel sent', len(p.sent('/scheduler/sleep_cancel')) == 1, p.sent('/scheduler/sleep_cancel'))
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pub('/scheduler/report', report(now, sleep={'checks': checks(ui=('off', 'ignored', {'n': 1}), reason=('wait', 'countdown_cancelled', {'left_s': 1800})),
                                                  'block': 'countdown_cancelled'}))
    p.tick()
    until = (dt.datetime.now() + dt.timedelta(seconds=1800)).strftime('%H:')
    check('S4 sentence: until when', until in (p.wait_text('#auto_sleep_plan', until) or ''), p.text('#auto_sleep_plan'))
    # the line above the map is a queue with its own pace (and a slow machine): wait for the text, not 200 ms
    check('S4 line: cancelled until when', p.until(re.escape(until)), p.line())
    check('S4 no Cancel left', p.wait(lambda: p.pg.query_selector('#btn_notice_action') is None))
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-cancelled.png'))

    # S5 Sleep now: 5 minutes says the limit, the value and where
    p.pub('/scheduler/report', report(now))
    p.pg.fill('#input_auto_sleep_min', '5')
    tx = p.wait_text('#auto_sleep_preview', 'sleep_min_s')
    check('S5 refused before sending: limit, value, where', '16' in tx and '5' in tx and 'sleep_min_s' in tx, tx)
    p.click('#btn_auto_sleep_timed')
    p.click('#btn_auto_sleep_timed')
    check('S5 not sent', not p.sent('/scheduler/sleep_now'))
    p.pg.fill('#input_auto_sleep_min', '16')
    p.wait(lambda: re.search(r'\d+:\d\d', p.text('#auto_sleep_preview') or ''))
    tx = p.text('#auto_sleep_preview')
    check('S5 preview', re.search(r'\d+:\d\d', tx), tx)
    p.click('#btn_auto_sleep_timed')
    p.click('#btn_auto_sleep_timed')
    got = p.sent('/scheduler/sleep_now')
    check('S5 sent as typed', len(got) == 1 and json.loads(got[0]['data']) == {'mode': 'timed', 'ms': 960000}, got)
    p.pub('/scheduler/command_result', {'cmd': 'sleep_now', 'ok': False, 'code': 'login:pts/0'})
    tx = p.wait_text('#auto_sleep_msg', 'pts/0')
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
    p.wait(lambda: re.search('nepotvrd|confirm', p.text('#auto_sleep_msg') or ''))
    check('S6 failure shown', 'nepotvrd' in (p.text('#auto_sleep_msg') or '') or 'confirm' in (p.text('#auto_sleep_msg') or ''), p.text('#auto_sleep_msg'))
    p.wait(lambda: len(p.line() or '') > 5)
    check('S6 line shows it', p.line() and len(p.line()) > 5, p.line())

    # S7 a start inside the sleep: it asks
    near = now + dt.timedelta(minutes=50)
    p.pub('/scheduler/report', report(now, next={'program': 'Bigger', 'at': iso(near)}))
    p.pg.fill('#input_auto_sleep_min', '120')
    check('S7 preview warns', p.wait(lambda: p.pg.evaluate("document.getElementById('auto_sleep_preview').dataset.state") == 'warn'), p.text('#auto_sleep_preview'))
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
    check('S11 STOP takes the line', p.until('STOP'), p.line())
    check('S11 STOP is marked', p.pg.evaluate("document.getElementById('span_status_info').dataset.level") == '0')
    p.raw('/nextion/log_info', {'data': 'Set speed: 0.5'})
    p.pg.wait_for_timeout(3000)
    check('S11 a routine line does not push it off', 'STOP' in (p.line() or ''), p.line())
    p.raw('/mower_smach/status', {'data': 'Ready'})
    p.pub('/scheduler/report', report(now, code='no_schedule'))
    check('S11 STOP goes when it is over', p.until_not('STOP'), p.line())
    p.pub('/mower/link', {'state': 'ok'})
    p.pub('/mower/link', {'state': 'silent', 'silent_s': 6})
    p.pg.wait_for_timeout(5500)

    # S12 raw sleep: says the number, needs a second press
    p.raw('/pm/power_status', pm())
    check('S12 the 715 is explained', '715' in (p.wait_text('#auto_raw_state', '715') or ''), p.text('#auto_raw_state'))
    n = len(p.sent('/pm/set_robot_sleep'))
    p.click('#btn_sleep_timed')
    tx = p.text('#auto_raw_state')
    check('S12 raw asks with the number', '715' in tx and len(p.sent('/pm/set_robot_sleep')) == n, tx)
    p.click('#btn_auto_raw_go')
    check('S12 then it goes', len(p.sent('/pm/set_robot_sleep')) == n + 1)
    p.raw('/pm/power_status', pm(True))
    p.tick()
    p.pg.fill('#input_auto_sleep_min', '60')
    check('S12 Sleep now knows of a raw sleep', p.wait(lambda: p.pg.evaluate("document.getElementById('auto_sleep_preview').dataset.state") == 'warn'), p.text('#auto_sleep_preview'))
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
    # T8 dávka V (T37): the device state INVALID (silent board) in words — the right panel's Mower
    # chip and the header icon, not the board's last state (WAIT) nor "disabled"; the Auto chip says why
    cs = label.endswith('cs')
    icon = {k: 'ON' for k in 'fan_int fan_ext imu lidar d435'.split()}
    icon.update(supply='ONLINE', batt='FULL_CHARGE', temp_int='OK', temp_ext='OK', mot_lf='DISABLED', mot_rf='DISABLED',
                mot_lr='DISABLED', mot_rr='DISABLED', mower='INVALID', gnss_nav='3DFIX', gnss='3DFIX', wifi='MEDIUM', t265='',
                header={'stamp': {'secs': 0, 'nsecs': 0}, 'frame_id': '', 'seq': 0})
    p.raw('/mower/status', {'header': {'stamp': {'secs': 0, 'nsecs': 0}, 'frame_id': '', 'seq': 0}, 'status': 'WAIT', 'moto_dir': 'L',
                            'moto_rpm': 0, 'setpoint_rpm': 0, 'current_height': 45, 'max_height': 70, 'temp': 21})
    p.raw('/device_state_pub/icon_status', icon)
    silent = 'Neodpovídá' if cs else 'Silent'
    chip = p.wait(lambda: (p.text('#rp_mower_chip') or '') == silent and p.text('#rp_mower_chip'))
    check('silent board: the Mower chip says so, not its last state (WAIT)', chip == silent, chip)
    check('… red', p.pg.evaluate("document.getElementById('rp_mower_chip').dataset.state") == 'err')
    ht = p.wait(lambda: (p.pg.evaluate("(document.querySelector('.sh-ico[data-ico=mower]')||{}).title||''") or '').find('neodpovídá' if cs else 'not answering') >= 0
                and p.pg.evaluate("document.querySelector('.sh-ico[data-ico=mower]').title"))
    check('… the header icon says "not answering", not "disabled"', bool(ht), ht)
    auto = p.text('.rp-auto-chip')
    check('… the Auto chip says the mower is silent, not just "Mower"', ('mlčí' if cs else 'silent') in (auto or '').lower(), auto)
    # V-b: in the dock the last word is usually OFF: the section stays visible while the board is silent
    ms = {'header': {'stamp': {'secs': 0, 'nsecs': 0}, 'frame_id': '', 'seq': 0}, 'status': 'OFF', 'moto_dir': 'L',
          'moto_rpm': 0, 'setpoint_rpm': 0, 'current_height': 45, 'max_height': 70, 'temp': 21}
    p.raw('/mower/status', ms)
    vis = p.wait(lambda: p.pg.evaluate("(()=>{const c=document.getElementById('rp_mower_chip');const s=c&&c.closest('.rp-sec');"
                                       "return !!(s&&s.style.display!=='none'&&c.textContent===%s)})()" % json.dumps(silent)))
    check('V-b: silent board after OFF (in the dock): the Mower section shows "%s"' % silent, vis)
    # V-b: the stop stays as before dávka V: a last RUN (0 rpm) of a silent board can be stopped, not started
    ms['status'] = 'RUN'
    p.raw('/mower/status', ms)
    stop = p.wait(lambda: p.pg.evaluate("(()=>{const b=document.getElementById('rp_mower_blade_key');return !!(b&&!b.disabled&&b.textContent==='■')})()"))
    check('V-b: … a last RUN with 0 rpm can still be stopped (■ enabled)', stop)
    check('… and no start offered', p.pg.evaluate("(()=>{const b=document.getElementById('rp_mower_blade_start');return !b||b.style.display==='none'||b.disabled})()"))
    ms['status'] = 'WAIT'
    p.raw('/mower/status', ms)
    icon['mower'] = 'ON'
    p.raw('/device_state_pub/icon_status', icon)
    # V-c: the board answers = the link says so too (its "silent" alone keeps the section silent)
    p.pub('/mower/link', {'state': 'ok', 'banner': None})
    chip = p.wait(lambda: (p.text('#rp_mower_chip') or '') == ('Čeká' if cs else 'Waiting') and p.text('#rp_mower_chip'))
    check('… it answers again: its state in words (WAIT -> %s)' % ('Čeká' if cs else 'Waiting'), chip == ('Čeká' if cs else 'Waiting'), chip)
    # V-d: back from a silence the START waits for a NEW /mower/status: the link said READY (before the
    # silence), the link turns ok a moment before the first status -> no start yet; a fresh READY -> start
    p.pub('/mower/link', {'state': 'silent', 'banner': 'silent', 'status': 'READY', 'silent_s': 40, 'rpm': 0, 'height': 45, 'temp': 21})
    p.tick(600)
    p.pub('/mower/link', {'state': 'ok', 'banner': None})
    p.tick(1200)
    offered = "(()=>{const b=document.getElementById('rp_mower_blade_start');return !!(b&&b.style.display!=='none'&&!b.disabled)})()"
    check('V-d: back from silence, code READY only from before / the link: no blade start offered', not p.pg.evaluate(offered))
    ms['status'] = 'READY'
    p.raw('/mower/status', ms)
    check('V-d: … a NEW /mower/status READY: the start is offered again', bool(p.wait(lambda: p.pg.evaluate(offered))))
    ms['status'] = 'WAIT'
    p.raw('/mower/status', ms)
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


def fresh_silent(p, shots, label):
    """V-c: a fresh page while the mower board is ALREADY silent: no /mower/status ever comes, /mower/link
    says "silent" (node_mower LinkView) and the device icon INVALID. Before any data: no template "RUN"."""
    cs = label.endswith('cs')
    st = p.pg.evaluate("""(()=>{const c=document.getElementById('rp_mower_chip');const s=c&&c.closest('.rp-sec');
        const cells=[...document.querySelectorAll('#right_panel .rp-cell-v')].map(e=>e.textContent);
        return {chip:c?c.textContent:null,tip:c?(c.title||''):null,shown:!!(s&&s.style.display!=='none'),cells:cells,
                key:(document.getElementById('rp_mower_blade_key')||{}).title||''}})()""")
    check('V-c fresh page, no data yet: the Mower section stays hidden, no template "RUN" / "0 °C"',
          not st['shown'] and 'RUN' not in (st['chip'] or '') + st['tip'] + st['key'] and not any('0 °C' == c or '0 mm' == c for c in st['cells']), st)
    icon = {k: 'ON' for k in 'fan_int fan_ext imu lidar d435'.split()}
    icon.update(supply='ONLINE', batt='FULL_CHARGE', temp_int='OK', temp_ext='OK', mot_lf='DISABLED', mot_rf='DISABLED',
                mot_lr='DISABLED', mot_rr='DISABLED', mower='INVALID', gnss_nav='3DFIX', gnss='3DFIX', wifi='MEDIUM', t265='',
                header={'stamp': {'secs': 0, 'nsecs': 0}, 'frame_id': '', 'seq': 0})
    p.raw('/device_state_pub/icon_status', icon)
    p.tick(600)
    shown = p.pg.evaluate("(()=>{const c=document.getElementById('rp_mower_chip');const s=c&&c.closest('.rp-sec');return !!(s&&s.style.display!=='none')})()")
    check('V-c: the icon INVALID alone (no state ever received) does not invent a Mower section', not shown)
    p.pub('/mower/link', {'state': 'silent', 'banner': 'silent', 'status': 'OFF', 'silent_s': 2086.9, 'rpm': 1200, 'height': 80,
                          'temp': 10.8, 'setpoint': 2000, 'bat_out': False, 'mission': {}})
    silent = 'Neodpovídá' if cs else 'Silent'
    ok = p.wait(lambda: p.pg.evaluate("(()=>{const c=document.getElementById('rp_mower_chip');const s=c&&c.closest('.rp-sec');"
                                      "return !!(s&&s.style.display!=='none'&&c.textContent===%s&&c.dataset.state==='err')})()" % json.dumps(silent)))
    check('V-c: /mower/link "silent" after a fresh load shows the Mower section: "%s", red' % silent, ok)
    v = p.pg.evaluate("""(()=>{const cells=[...document.querySelectorAll('#right_panel .rp-cell-v')].map(e=>e.textContent);
        const sb=document.getElementById('rp_mower_blade_start'),bk=document.getElementById('rp_mower_blade_key');
        return {cells:cells,start:!sb||sb.style.display==='none'||sb.disabled,stop:bk?bk.textContent:'',tip:bk?bk.title:''}})()""")
    check('V-c: … last known values from the link (80 mm, 11 °C), last OFF = blade stands (not 1200 rpm), no start',
          '80 mm' in v['cells'] and '11 °C' in v['cells'] and not any('1200' in c for c in v['cells']) and v['start'] and v['stop'] != '■'
          and 'RUN' not in v['tip'], v)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-vc-fresh-silent.png'))


AGENT_SCHEMA = {
    'agent_fallback_calendar': ('bool', '', None, None, True), 'limits_in_calendar': ('bool', '', None, None, False),
    'limit_rain_h': ('float', 'h', 0, 48, 3.0), 'limit_temp_min_c': ('float', 'C', -10, 25, 5.0),
    'limit_zone_gap_days': ('float', 'd', 0, 14, 2.0)}


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
         'limits': {'window': {'enabled': True, 'start': '07:00', 'end': '21:00', 'min_left_min': 30.0},
                    'day_start': '07:00', 'day_end': '21:00', 'rain_h': 3.0, 'temp_min_c': 5.0, 'zone_gap_days': 2.0,
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
    p.open_limits()
    check('M0 nothing sent to set_mode on load', not p.sent('/scheduler/set_mode'), p.sent('/scheduler/set_mode'))
    check('M0 old latched answer not shown', not p.text('#auto_mode_msg'), p.text('#auto_mode_msg'))
    sel = p.pg.evaluate("[...document.querySelectorAll('#auto_mode_choice .vt-auto-choice')].map(b=>[b.dataset.mode,b.getAttribute('aria-checked'),b.disabled])")
    check('M1 the robot\'s mode is selected', sel == [['calendar', 'true', False], ['agent', 'false', False]], sel)
    check('M1 head says calendar', ('Kalendář' if cs else 'Calendar') in (p.text('#auto_tok_mode') or ''), p.text('#auto_tok_mode'))
    order = p.pg.evaluate("[...document.querySelectorAll('[data-auto-group=agent] .vt-auto-set')].map(r=>r.dataset.key)")
    check('M1 limits in their order', order == ['agent_fallback_calendar', 'limits_in_calendar',
                                                'limit_rain_h', 'limit_temp_min_c', 'limit_zone_gap_days'], order)
    # one window (owner 2026-11-08): no start hours of the agent, the window of Plan in one line
    check('M1 no start hours of the agent', p.pg.locator('#auto_in_limit_day_start, #auto_in_limit_day_end').count() == 0)
    win = p.text('#auto_mode_window') or ''
    check('M1 window line: off, for the agent too', p.pg.locator('#auto_mode_window').is_visible()
          and ('vypnuto' if cs else 'off') in win and 'agent' in win and '{' not in win, win)
    check('M1 window line above the limits', p.pg.evaluate(
        "document.getElementById('auto_mode_window').nextElementSibling === document.querySelector('[data-auto-group=agent]')"))
    on = report(now)
    on['window_setting'] = dict(on['window_setting'], enabled=True, start='06:30', end='20:15')
    p.pub('/scheduler/report', on)
    win = p.text('#auto_mode_window') or ''
    check('M1 window line: on with its times', '06:30–20:15' in win and ('zapnuto' if cs else '(on)') in win
          and ('platí i pro agenta' if cs else 'applies to the agent too') in win, win)
    if shots:
        p.pg.evaluate("document.getElementById('auto_mode_limits_h').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-mode-limits.png'))
    on['window_setting'] = dict(on['window_setting'], start='22:00', end='05:00')
    p.pub('/scheduler/report', on)
    win = p.text('#auto_mode_window') or ''
    check('M1 window line: over midnight said', '22:00–05:00' in win and ('půlnoc' if cs else 'midnight') in win, win)
    n = len(p.pg.evaluate('__fake.sent'))
    p.click('#btn_auto_mode_window')
    p.wait(lambda: p.pg.evaluate("document.getElementById('auto_sec_plan').open"))
    p.pg.wait_for_timeout(700)      # the scroll to the card settles
    check('M1 window › opens Plan at the card, nothing sent', len(p.pg.evaluate('__fake.sent')) == n
          and p.pg.evaluate("document.getElementById('auto_sec_plan').open")
          and p.pg.evaluate("(()=>{const r=document.getElementById('card_mow_window').getBoundingClientRect();"
                            "return r.top >= 0 && r.bottom <= innerHeight;})()"))
    check('M1 window › has a name', bool(p.pg.evaluate("document.getElementById('btn_auto_mode_window').getAttribute('aria-label')")))
    p.pub('/scheduler/report', report(now))
    p.open('mode')
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
    # T22 (N6): the advice's reason as a code in the page's language; the dock permit's code
    # (dock_why) in words, an old text (above) as it was
    adv_c = dict(adv, reason='Bigger: nejdéle 5.5 d (interval 4.0 d); nedosečeno: A, B', reason_code='mow',
                 reason_vars={'program': 'Bigger', 'items': [{'code': 'oldest', 'days': 5.5, 'interval': 4.0},
                                                            {'code': 'unfinished', 'zones': ['A', 'B']}]})
    p.pub('/scheduler/mode', mode_view('agent', advice=adv_c, last_decision=dec, dock_why='not_owner'))
    why_t = p.text('#auto_mode_advice .vt-auto-dec-why') or ''
    check('T22 advice reason in the page language', 'Bigger' in why_t
          and ('nedosečeno: A, B' if cs else 'unfinished: A, B') in why_t and ('5,5' if cs else '5.5') in why_t, why_t)
    check('T22 no Czech words of the agent in an en page', cs or 'nedosečeno' not in why_t, why_t)
    dock_tip = p.pg.evaluate("(document.querySelector('#auto_mode_attn .vt-attn-txt')||{}).title")
    check('T22 dock_why code in words', dock_tip == p.pg.evaluate("VTI18n.t('auto.check.permit.not_owner')")
          and 'not_owner' not in dock_tip, dock_tip)
    p.pub('/scheduler/mode', mode_view('agent', advice=adv, last_decision=dec))
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
    # the night limit is the allowed window: its times, in words, also too little of it left
    night = {'start': '07:00', 'end': '21:00', 'cause': 'outside_window', 'min_left_min': 30.0}
    d = dict({'program': 'Bigger', 'why': 'limit:limit_night'}, **night)
    p.pub('/scheduler/report', report(now, code='agent_blocked', detail=d, sentence={'code': 'agent_blocked', 'vars': d}))
    top = p.text('#span_scheduler_status') or ''
    check('M4 agent_blocked by the night: the window in words', '07:00–21:00' in top and ('povolený čas' if cs else 'allowed mowing time') in top
          and '{' not in top and 'limit_' not in top, top)
    d = dict(d, cause='too_little_left')
    p.pub('/scheduler/report', report(now, code='agent_blocked', detail=d, sentence={'code': 'agent_blocked', 'vars': d}))
    top = p.text('#span_scheduler_status') or ''
    check('M4 too little of the window left: said with the minutes', '30' in top and '07:00–21:00' in top and '{' not in top, top)
    p.pub('/scheduler/mode', mode_view('agent', dock_permitted=True, dock_why=None,
                                       limit_now={'code': 'limit_night', 'vars': night, 'program': 'Bigger'}))
    notes = p.text('#auto_mode_notes') or ''
    check('M4 night limit now: the window', '07:00–21:00' in notes and '{' not in notes, notes)
    p.pub('/scheduler/journal', {'entries': [
        {'t': iso(now) + ':00', 'kind': 'advice', 'code': 'waiting', 'program': 'Bigger',
         'vars': dict({'why': 'limit:limit_night', 'id': 'a1'}, **night)},
        {'t': iso(now) + ':00', 'kind': 'waited', 'code': 'limit_night', 'program': 'Bigger', 'vars': night}]})
    p.open('history')
    j = p.text('#auto_journal') or ''
    check('M5 night limit in the journal: the window in words', j.count('07:00–21:00') == 2 and 'limit_' not in j and '{' not in j, j)
    p.open('mode')
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
    p.open_limits()
    n_set = len(p.sent('/scheduler/set_settings'))
    p.pg.fill('#auto_in_limit_rain_h', '99')
    p.pg.dispatch_event('#auto_in_limit_rain_h', 'change')
    p.wait(lambda: p.text('[data-key=limit_rain_h] .vt-auto-msg'))
    check('M6 out of range: not sent, said', len(p.sent('/scheduler/set_settings')) == n_set and p.text('[data-key=limit_rain_h] .vt-auto-msg'),
          p.text('[data-key=limit_rain_h] .vt-auto-msg'))
    p.pg.fill('#auto_in_limit_rain_h', '4')
    p.pg.dispatch_event('#auto_in_limit_rain_h', 'change')
    p.wait(lambda: len(p.sent('/scheduler/set_settings')) > n_set)
    got = p.sent('/scheduler/set_settings')
    body = json.loads(got[-1]['data']) if got else {}
    check('M6 a limit saved', body.get('values') == {'limit_rain_h': 4.0}, got[-1:] if got else got)
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
           'received': iso(frm) + ':00', 'state': 'pending', 'fresh': True,
           # T22: a long reason as a code (cs is longer): it must wrap, not cut
           'reason_code': 'mow', 'reason_vars': {'program': 'Bigger', 'items': [
               {'code': 'no_record', 'zones': ['Front lawn', 'Back lawn', 'Orchard']},
               {'code': 'oldest', 'days': 12.3, 'interval': 4.2},
               {'code': 'unfinished', 'zones': ['Front lawn', 'Orchard']},
               {'code': 'heavy', 'zones': ['Back lawn']}]}}
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
        p.pg.evaluate("document.getElementById('auto_mode_limits_h').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-mode-limits-off.png'))


def start_checks(**over):
    """report.checks (Could it start now?) as master_controller sends them; over: key=(state, code, vars)."""
    base = [('automation', 'ok', 'on'), ('hold', 'ok', 'clear'), ('dock', 'ok', 'in_dock'), ('mission', 'ok', 'ready'),
            ('battery', 'ok', 'ok'), ('rain', 'ok', 'dry'), ('gnss', 'unknown', 'not_checked'), ('mower', 'ok', 'ok'),
            ('temperature', 'ok', 'ok'), ('window', 'off', 'off'), ('programs', 'ok', 'ok'), ('map', 'ok', 'ok')]
    out = []
    for k, st, c in base:
        v = {}
        if k in over:
            st, c, v = over[k]
        out.append({'key': k, 'state': st, 'code': c, 'vars': v})
    return out


def a1_story(p, shots, label):
    """T21 A1: the answer in the top card, the start list folded, the limits fold. Display only: nothing sent."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    p.pub('/scheduler/sleep_countdown', {'active': False})    # layout() leaves a countdown running
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/report', report(now, checks=start_checks()))
    p.open('now')
    n0 = len(p.pg.evaluate('__fake.sent'))
    vis = lambda sel: p.pg.evaluate("(s)=>{const e=document.querySelector(s);return !!(e&&e.offsetParent&&!e.hidden)}", sel)
    check('A1 answer: who decides', vis('#btn_auto_ans_mode') and ('Rozhoduje kalendář' if cs else 'Calendar decides') in p.text('#btn_auto_ans_mode'),
          p.text('#btn_auto_ans_mode'))
    check('A1 answer: could start now', vis('#btn_auto_ans_now') and ('Teď by mohl vyjet' if cs else 'Could start now') in p.text('#btn_auto_ans_now')
          and p.pg.evaluate("document.getElementById('btn_auto_ans_now').dataset.state") == 'ok', p.text('#btn_auto_ans_now'))
    check('A1 answer sits under Next, in the top card', p.pg.evaluate(
        "document.getElementById('auto_answer').previousElementSibling.contains(document.getElementById('span_scheduler_next'))"))
    rows = p.pg.evaluate("[...document.querySelectorAll('#auto_checks .vt-auto-check')].map(r=>[r.classList.contains('vt-auto-okline'),r.textContent])")
    check('A1 all fine: one folded line with the counts', len(rows) == 1 and rows[0][0] and '11' in rows[0][1] and '1.' in rows[0][1], rows)
    p.click('#btn_auto_checks_all')
    n_all = p.pg.evaluate("document.querySelectorAll('#auto_checks .vt-auto-check:not(.vt-auto-okline)').length")
    check('A1 Show all lists every condition', n_all == 12, n_all)
    check('A1 Show all remembered', p.pg.evaluate("localStorage.getItem('vitulus_auto_checks_all')") == '1')
    p.click('#btn_auto_checks_all')
    check('A1 folded again', p.pg.evaluate("document.querySelectorAll('#auto_checks .vt-auto-check:not(.vt-auto-okline)').length") == 0)
    # rain waits, the battery blocks: red, the first one named, +1, both lines on top
    p.pub('/scheduler/report', report(now, code='waiting_weather', checks=start_checks(
        rain=('wait', 'recent_rain', {'left_s': 1500}), battery=('block', 'low', {}))))
    ans = p.text('#btn_auto_ans_now') or ''
    check('A1 blocked: red, named, +1', p.pg.evaluate("document.getElementById('btn_auto_ans_now').dataset.state") == 'err'
          and '+1' in ans and ('Baterie' if cs else 'Battery') in ans, ans)
    st = p.pg.evaluate("[...document.querySelectorAll('#auto_checks .vt-auto-check')].map(r=>r.dataset.state)")
    check('A1 problems first, the rest folded', st == ['err', 'warn', 'ok'], st)
    if shots:
        p.pg.evaluate("document.getElementById('ui_drawer_body').scrollTop=0")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-a1-answer.png'))
    p.pub('/scheduler/report', report(now, code='mowing', checks=start_checks(mission=('block', 'busy', {}))))
    check('A1 mowing: no "won\'t start" next to it', not vis('#btn_auto_ans_now'))
    # last decision: quiet in the calendar mode without one, shown for the agent
    p.pub('/scheduler/report', report(now, checks=start_checks()))
    check('A1 calendar, no decision: Last decision hidden', not vis('#auto_mode_last'))
    p.pub('/scheduler/mode', mode_view('agent'))
    check('A1 agent: Agent decides', ('Rozhoduje agent' if cs else 'Agent decides') in (p.text('#btn_auto_ans_mode') or ''))
    check('A1 agent: Last decision shown', vis('#auto_mode_last'))
    check('A1 limits head: in force for the agent', ('platí' if cs else 'in force') in (p.text('#auto_tok_limits') or ''), p.text('#auto_tok_limits'))
    p.pub('/scheduler/mode', mode_view('calendar'))
    check('A1 limits head: not in force for the calendar', ('teď neplatí' if cs else 'not in force') in (p.text('#auto_tok_limits') or ''))
    p.click('#auto_mode_limits > summary')
    check('A1 limits fold closes, remembered', not p.pg.evaluate("document.getElementById('auto_mode_limits').open")
          and p.pg.evaluate("localStorage.getItem('vitulus_auto_sec_limits')") == '0')
    p.click('#auto_mode_limits > summary')
    p.click('#btn_auto_ans_mode')
    check('A1 answer › opens Who decides', p.wait(lambda: p.pg.evaluate("document.getElementById('auto_sec_mode').open")))
    p.click('#btn_auto_ans_now')
    check('A1 answer › opens Now', p.wait(lambda: p.pg.evaluate("document.getElementById('auto_sec_now').open")))
    check('A1 nothing sent by any of it', len(p.pg.evaluate('__fake.sent')) == n0, p.pg.evaluate('__fake.sent')[n0:])
    # green only when nothing holds a start by the robot's own rules (master _start_blocker, the
    # hard limit in force, the report's code); the head of Now says the same
    cold = {'code': 'limit_cold', 'vars': {'temp': 2.8, 'min_c': 5.0}, 'program': 'Bigger'}
    rain = {'code': 'limit_rain', 'vars': {'hours_since_rain': 1.0, 'need_h': 3.0}, 'program': 'Bigger'}
    adv_now = {'id': 'a1', 'action': 'mow', 'program': 'Bigger', 'from': iso(now - dt.timedelta(minutes=5)) + ':00',
               'to': iso(now + dt.timedelta(hours=2)) + ':00', 'until': None, 'reason': 'dry', 'confidence': 0.8,
               'state': 'pending', 'fresh': True}
    truth = [
        ('agent + cold', report(now, code='agent_blocked', detail={'program': 'Bigger', 'why': 'limit:limit_cold'}, checks=start_checks()),
         mode_view('agent', limits_apply=True, limit_now=cold), 'warn', 'zima' if cs else 'cold'),
        ('automation off', report(now, code='off', enabled=False, checks=start_checks(automation=('off', 'off', {}))),
         mode_view('calendar', automation=False), '', 'Automatika' if cs else 'Automation'),
        ('agent limit rain', report(now, code='agent_blocked', detail={'program': 'Bigger', 'why': 'limit:limit_rain'}, checks=start_checks()),
         mode_view('agent', limit_now=rain), 'warn', 'déšť' if cs else 'rain'),
        ('agent skip', report(now, code='agent_skip', checks=start_checks()), mode_view('agent', dock_permitted=True), '',
         'nesekat' if cs else 'no mowing'),
        ('agent no advice, dock locked', report(now, code='agent_no_advice', checks=start_checks()), mode_view('agent'), '',
         'radu agenta' if cs else 'advice'),
        ('agent advice, dock locked', report(now, checks=start_checks()), mode_view('agent', advice=adv_now), 'warn',
         'Povolení doku' if cs else 'Dock permit'),
        ('agent done, dock locked', report(now, code='agent_advice_done', checks=start_checks()),
         mode_view('agent', advice=dict(adv_now, state='used')), '', 'nevyjíždí' if cs else 'Not starting'),
        ('intent timeout', report(now, code='intent_timeout', checks=start_checks()), mode_view('agent', dock_permitted=True), '',
         'nevyjíždí' if cs else 'Not starting'),
        ('sleep countdown', report(now, sentence={'code': 'sleep_countdown', 'vars': {'left_s': 60}}, checks=start_checks()),
         mode_view('calendar'), 'warn', 'Usíná' if cs else 'sleep'),
        ('unknown code', report(now, code='something_new', sentence={'code': 'something_new', 'vars': {}}, checks=start_checks()),
         mode_view('calendar'), '', 'nevyjíždí' if cs else 'Not starting'),
        ('calendar + limit rain', report(now, code='limit_rain', checks=start_checks()), mode_view('calendar', limits_apply=True, limit_now=rain),
         'warn', 'déšť' if cs else 'rain'),
        # T21 A6 (#40): the answer says what holds it in words — was "Programs", now "Nothing planned"
        ('no schedule', report(now, code='no_schedule', checks=start_checks(programs=('off', 'no_schedule', {}))), mode_view('calendar'), '',
         'Teď nevyjede: Nic v plánu' if cs else "Won't start now: Nothing planned"),
        ('sleep prepare', report(now, code='sleep_prepare', state='PREPARE_SLEEP', checks=start_checks()), mode_view('calendar'), '', ''),
    ]
    for name, rep_, mv, tone, word in truth:
        p.pub('/scheduler/mode', mv)
        p.pub('/scheduler/report', rep_)
        r = p.pg.evaluate("""()=>{const b=document.getElementById('btn_auto_ans_now');
            return {vis:!!(b&&b.offsetParent&&!b.hidden), st:b.dataset.state||'', tx:b.textContent,
                    head:document.getElementById('auto_sec_now').dataset.state, tok:document.getElementById('auto_tok_now').textContent,
                    rows:[...document.querySelectorAll('#auto_checks .vt-auto-check:not(.vt-auto-okline)')].map(x=>x.dataset.state+':'+x.textContent)}}""")
        check('A1 truth: %s is not green' % name, r['vis'] and r['st'] == tone and r['head'] != 'ok' and word in r['tx'], r)
        if name == 'no schedule':
            # automation / programs off hold a start: shown on top, not folded as "not checked"
            check('A1 no schedule: Programs off on top of the list', r['rows'][:1] and r['rows'][0].startswith('off:'), r['rows'])
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/report', report(now, checks=start_checks()))
    # the calendar standing in for the agent (no advice) needs no dock permit (D37): ready is ready
    p.pub('/scheduler/mode', mode_view('agent', fallback=True))
    p.pub('/scheduler/report', report(now, checks=start_checks()))
    tx = p.text('#btn_auto_ans_now') or ''
    check('A1 agent, calendar stands in, dock locked: no "waits for dock permit"',
          ('Povolení doku' if cs else 'Dock permit') not in tx and p.pg.evaluate("document.getElementById('btn_auto_ans_now').dataset.state") == 'ok', tx)
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/report', report(now, checks=start_checks()))
    check('A1 back to ready: green again, head too', p.pg.evaluate("document.getElementById('btn_auto_ans_now').dataset.state") == 'ok'
          and p.pg.evaluate("document.getElementById('auto_sec_now').dataset.state") == 'ok')
    p.click('#btn_auto_checks_all')
    ex = p.pg.evaluate("(()=>{const r=document.querySelector('#auto_checks .vt-auto-okline');return r?[r.querySelectorAll('.vt-sdot').length,r.textContent.trim()]:null})()")
    check('A1 Show all: no empty dotted line, just the toggle', ex and ex[0] == 0 and ex[1] == ('Jen problémy' if cs else 'Problems only'), ex)
    p.click('#btn_auto_checks_all')
    if not cs:
        days = p.pg.evaluate("[...document.querySelectorAll('.vt-auto-tl-day')].map(e=>e.textContent)")
        check('A1 English days with the month name, not 11/10', not any(re.search(r'\d+/\d+', d) for d in days), days)


def a1_fit(p, shots, label):
    """The top card and Now on this screen: answer buttons whole, touch size, no sideways scroll."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('agent'))
    p.pub('/scheduler/report', report(now, code='waiting_weather', checks=start_checks(
        rain=('wait', 'recent_rain', {'left_s': 1500}), battery=('block', 'low', {}), temperature=('wait', 'cold', {}))))
    if p.pg.evaluate("localStorage.getItem('vitulus_auto_sec_limits')") is None:
        p.pub('/scheduler/mode', mode_view('calendar'))
        check(label + ' A1 limits folded by default while not in force', not p.pg.evaluate("document.getElementById('auto_mode_limits').open"))
        p.pub('/scheduler/mode', mode_view('agent'))
        check(label + ' A1 limits open by themselves while in force', p.wait(lambda: p.pg.evaluate("document.getElementById('auto_mode_limits').open")))
        check(label + ' A1 that is not remembered as a choice', p.pg.evaluate("localStorage.getItem('vitulus_auto_sec_limits')") is None)
    p.open('now')
    p.pg.evaluate("document.getElementById('ui_drawer_body').scrollTop=0")
    p.pg.wait_for_timeout(200)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const els=q('#auto_answer button, #btn_auto_checks_all, #auto_mode_limits > summary');
        const small=els.map(e=>{const b=e.getBoundingClientRect();return [e.id||e.tagName,Math.round(b.width),Math.round(b.height)]}).filter(x=>x[2]<40);
        const out=q('#auto_answer *, #auto_checks *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        const over=q('#auto_answer *').filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.id||e.className);
        return {w:document.documentElement.scrollWidth, small, out, over, coarse:matchMedia('(pointer: coarse)').matches}}""")
    check(label + ' A1: no sideways scroll', r['w'] <= vw + 1 and not r['out'], r)
    check(label + ' A1: answer text whole', not r['over'], r['over'])
    if r['coarse']:
        check(label + ' A1: touch targets >= 40 px', not r['small'], r['small'])
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-a1-fit.png'))


def a2_timeline(today):
    """/scheduler/timeline like the robot's: today a sleep and a start, then a long sleep to day 6."""
    d = lambda n, h, m: iso(dt.datetime.combine(today + dt.timedelta(days=n), dt.time(h, m)))
    return {'sleeps': [{'from': d(0, 8, 0), 'to': d(0, 23, 3), 'reason': 'next_slot'},
                       {'from': d(1, 2, 0), 'to': d(6, 23, 3), 'reason': 'next_slot'}],
            'starts': [{'program': 'Bigger', 'state': 'planned', 't': d(0, 23, 15)},
                       {'program': 'Bigger', 'state': 'planned', 't': d(6, 23, 15)}]}


A2_CAL = [{'id': 'ev1', 'program_name': 'Bigger', 'site': 'Garden', 'enabled': True, 'recurrence': 'weekly',
           'start_time': '23:15', 'days_of_week': [5, 6]}]


def a2_story(p, shots, label):
    """T21 A2: order Now → Plan → Who decides, nothing said twice, timeline of the days that matter. Display only."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    awake = checks(ssh=('block', 'logins', {'who': ['pts/0']}), ui=('block', 'clients', {'n': 2}))
    p.pub('/scheduler/report', report(now, checks=start_checks(), sleep={'checks': awake, 'block': 'login:pts/0'}))
    p.pub('/scheduler/calendar', A2_CAL)
    p.pub('/scheduler/timeline', a2_timeline(now.date()))
    p.open('plan')
    p.open('sleep')
    p.tick()
    n0 = len(p.pg.evaluate('__fake.sent'))
    order = p.pg.evaluate("[...document.querySelectorAll('#div_menu_autonomy > details')].map(d=>d.id)")
    check('A2 order: Now, Plan, Who decides', order[:3] == ['auto_sec_now', 'auto_sec_plan', 'auto_sec_mode'], order)
    check('A2 order: Now right under the top card', p.pg.evaluate(
        "document.getElementById('card_calendar').nextElementSibling.id") == 'auto_sec_now')
    # the next start once: the top card; no tile, no time token in Plan
    nxt = p.text('#span_scheduler_next') or ''
    hm = report(now)['next']['at'][11:16]
    check('A2 next start in the top card', hm in nxt, nxt)
    check('A2 Plan: no number tiles', p.pg.evaluate("document.getElementById('auto_nums_plan').children.length") == 0)
    check('A2 Plan head: no second next start', hm not in (p.text('#auto_tok_plan') or ''), p.text('#auto_tok_plan'))
    on = report(now, checks=start_checks(), sleep={'checks': awake, 'block': 'login:pts/0'})
    on['window_setting'] = dict(on['window_setting'], enabled=True, start='07:00', end='21:00')
    p.pub('/scheduler/report', on)
    check('A2 Plan head: the allowed time when it limits', '07:00–21:00' in (p.text('#auto_tok_plan') or ''), p.text('#auto_tok_plan'))
    p.pub('/scheduler/report', report(now, checks=start_checks(), sleep={'checks': awake, 'block': 'login:pts/0'}))
    p.tick()
    # what keeps it awake: short by name in the top card, whole in Sleep, not in Now
    hero = p.text('#auto_sleep_plan') or ''
    full = p.pg.evaluate("VTAutonomy._checkText({key:'ssh', state:'block', code:'logins', vars:{who:['pts/0']}})")
    check('A2 top card: sleep line short, holders by name', ('Webové UI' if cs else 'Web UI') in hero and full not in hero
          and re.search(r'\d+ h', hero), hero)
    check('A2 top card: the whole sentence in its tooltip', full in (p.pg.evaluate("document.getElementById('auto_sleep_plan').title") or ''))
    check('A2 why not sleeping: in Sleep, not in Now', p.pg.evaluate(
        "!!document.querySelector('#auto_sec_sleep #auto_sleep_checks') && !document.querySelector('#auto_sec_now #auto_sleep_checks')"))
    lst, sec2 = p.text('#auto_sleep_checks') or '', p.text('#auto_sleep_plan2') or ''
    check('A2 Sleep: holders in the list, not again in the sentence', full in lst and full not in sec2 and sec2, [sec2, lst])
    check('A2 Sleep list: no › to the section it is in', p.pg.evaluate("document.querySelectorAll('#auto_sleep_checks .vt-auto-go').length") == 0)
    p.click('#btn_auto_sleep_more')
    check('A2 top card sleep line › opens Sleep', p.wait(lambda: p.pg.evaluate("document.getElementById('auto_sec_sleep').open")))
    # timeline: tracks only for the days something happens on, an hour scale, sleep folded
    tl = p.pg.evaluate("""()=>({rows:[...document.querySelectorAll('#auto_timeline .vt-auto-tl-row:not(.vt-auto-tl-scale)')].map(r=>r.querySelector('.vt-auto-tl-day').textContent),
        gaps:[...document.querySelectorAll('#auto_timeline .vt-auto-tl-gap')].map(g=>[g.dataset.kind,g.textContent]),
        hours:[...document.querySelectorAll('#auto_timeline .vt-auto-tl-hour')].map(h=>h.textContent),
        now:document.querySelectorAll('#auto_timeline .vt-auto-tl-now').length,
        sleep:document.querySelectorAll('#auto_timeline .vt-auto-tl-sleep').length})""")
    check('A2 timeline: 3 days with something, 4 asleep days in one line', len(tl['rows']) == 3 and len(tl['gaps']) == 1
          and tl['gaps'][0][0] == 'sleep' and ('spí' if cs else 'asleep') in tl['gaps'][0][1], tl)
    check('A2 timeline: hour scale 0–24', tl['hours'] == ['0', '6', '12', '18', '24'], tl['hours'])
    check('A2 timeline: now on today, sleeps drawn', tl['now'] == 1 and tl['sleep'] >= 3, tl)
    one = iso(dt.datetime.combine(now.date() + dt.timedelta(days=3), dt.time(9, 0)))
    p.pub('/scheduler/timeline', {'sleeps': [], 'starts': [{'program': 'Bigger', 'state': 'planned', 't': one}]})
    tl = p.pg.evaluate("""()=>({rows:document.querySelectorAll('#auto_timeline .vt-auto-tl-row:not(.vt-auto-tl-scale)').length,
        gaps:[...document.querySelectorAll('#auto_timeline .vt-auto-tl-gap')].map(g=>g.dataset.kind)})""")
    check('A2 timeline: empty days folded around the one start', tl['rows'] == 1 and tl['gaps'] == ['empty', 'empty'], tl)
    p.pub('/scheduler/timeline', a2_timeline(now.date()))
    # words: the state tag, the head tokens
    check('A2 state tag says scheduled', (p.text('#span_scheduler_state') or '') == ('Naplánováno' if cs else 'Scheduled'), p.text('#span_scheduler_state'))
    check('A2 Who decides head: by the plan', ('Podle plánu' if cs else 'By the plan') in (p.text('#auto_tok_mode') or ''), p.text('#auto_tok_mode'))
    check('A2 Weather head: what rain does', ('Déšť zastaví vše' if cs else 'Rain stops all') in (p.text('#auto_tok_rain') or ''), p.text('#auto_tok_rain'))
    check('A2 Weather head without radar data: says so', ('Radar bez dat' if cs else 'No radar data') in (p.text('#auto_tok_rain') or '')
          and ('Nic naplánováno' if cs else 'Nothing planned') not in (p.text('#auto_tok_rain') or ''), p.text('#auto_tok_rain'))
    # "Scheduled" only for a planned start; the codes that fell through to it get their own word (card and right panel)
    tags = [('no_schedule', {}, 'Nic v plánu' if cs else 'Nothing planned'),
            ('waiting_slot', {'next': None}, 'Nic v plánu' if cs else 'Nothing planned'),
            ('outside_window', {}, 'Mimo okno' if cs else 'Outside window'),
            ('no_mow', {}, 'Nesekat' if cs else 'No mowing'),
            ('agent_advice_done', {}, 'Nevyjíždí' if cs else 'Not starting'),
            ('intent_timeout', {}, 'Nevyjíždí' if cs else 'Not starting'),
            ('intent_wait', {}, 'Čeká' if cs else 'Waiting'),
            ('something_new', {}, 'Jiný stav' if cs else 'Other state'),
            ('waiting_slot', {'said': 'sleep_countdown'}, 'Usíná' if cs else 'Falling asleep'),
            ('waiting_slot', {'said': 'hw_reset_countdown'}, 'Tvrdý restart' if cs else 'Hardware reset')]
    for code, over, want in tags:
        over = dict(over)
        said = over.pop('said', code)
        p.pub('/scheduler/report', report(now, code=code, sentence={'code': said, 'vars': {'left_s': 50}}, checks=start_checks(), **over))
        tag, chip = p.text('#span_scheduler_state') or '', p.text('.rp-auto-chip') or ''
        check('A2 state tag for %s/%s: %s, not Scheduled' % (code, said, want), tag == want
              and (want in chip or said != code), [tag, chip])
    p.pub('/scheduler/report', report(now, checks=start_checks(), sleep={'checks': awake, 'block': 'login:pts/0'}))
    # the agent waits for the dock: the box says it with its way; the same last decision is not repeated
    frm, to = now - dt.timedelta(minutes=5), now + dt.timedelta(hours=3)
    adv = {'id': 'a1', 'action': 'mow', 'program': 'Bigger', 'from': iso(frm) + ':00', 'to': iso(to) + ':00', 'until': None,
           'reason': 'dry', 'confidence': 0.8, 'state': 'pending', 'fresh': True}
    p.pub('/scheduler/report', report(now, code='waiting_dock', detail={'program': 'Bigger'}, checks=start_checks(),
                                      sentence={'code': 'waiting_dock', 'vars': {'program': 'Bigger'}}))
    p.pub('/scheduler/mode', mode_view('agent', advice=adv, last_decision={
        't': iso(now) + ':00', 'kind': 'advice', 'code': 'waiting', 'program': 'Bigger', 'source': 'agent', 'vars': {'why': 'dock:waiting_dock'}}))
    vis = lambda sel: p.pg.evaluate("(s)=>{const e=document.querySelector(s);return !!(e&&e.offsetParent&&!e.hidden)}", sel)
    p.open('mode')
    check('A2 dock: the box says it', vis('#auto_mode_attn'))
    check('A2 dock: Last decision not repeated under it', not vis('#auto_mode_last'))
    p.pub('/scheduler/mode', mode_view('agent', dock_permitted=True, dock_why=None, last_decision={
        't': iso(now) + ':00', 'kind': 'waited', 'code': 'limit_rain', 'program': 'Bigger', 'source': 'calendar',
        'vars': {'hours_since_rain': 1.5, 'need_h': 3.0}}))
    p.pub('/scheduler/report', report(now, checks=start_checks()))
    check('A2 another decision: shown', vis('#auto_mode_last') and not vis('#auto_mode_attn'))
    p.pub('/scheduler/mode', mode_view('calendar'))
    check('A2 nothing sent by any of it', len(p.pg.evaluate('__fake.sent')) == n0, p.pg.evaluate('__fake.sent')[n0:])
    # Who decides on a first visit: folded for the calendar, open while the agent decides
    ctx = p.pg.context
    q = P(ctx, p.pg.url)
    q.pg.evaluate("localStorage.removeItem('vitulus_auto_sec_mode')")
    q.pg.close()
    q = P(ctx, p.pg.url)
    q.pub('/scheduler/settings', agent_settings())
    q.pub('/scheduler/report', report(now, checks=start_checks()))
    q.pub('/scheduler/mode', mode_view('calendar'))
    q.tick(400)
    check('A2 Who decides folded on a first visit (calendar)', not q.pg.evaluate("document.getElementById('auto_sec_mode').open"))
    q.pub('/scheduler/mode', mode_view('agent'))
    q.tick(400)
    check('A2 Who decides opens by itself for the agent', q.pg.evaluate("document.getElementById('auto_sec_mode').open")
          and q.pg.evaluate("localStorage.getItem('vitulus_auto_sec_mode')") is None)
    q.click('#auto_sec_mode > summary')
    q.tick(300)
    check('A2 the owner\'s fold is remembered', q.pg.evaluate("localStorage.getItem('vitulus_auto_sec_mode')") == '0')
    q.pub('/scheduler/mode', mode_view('calendar'))
    q.pub('/scheduler/mode', mode_view('agent'))
    check('A2 after that it stays as the owner left it', not q.pg.evaluate("document.getElementById('auto_sec_mode').open"))
    q.pg.close()
    errs = [e for e in p.errors if 'erases' not in e]
    check('A2 no page errors', not errs, errs[:3])


def a2_fit(p, shots, label):
    """The calendar row, the switches and the heads on this screen: touch size, one switch size, nothing cut."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    awake = checks(ssh=('block', 'logins', {'who': ['pts/0', 'pts/2']}), ui=('block', 'clients', {'n': 2}))
    p.pub('/scheduler/report', report(now, checks=start_checks(), sleep={'checks': awake, 'block': 'login:pts/0'}))
    p.pub('/scheduler/calendar', A2_CAL + [dict(A2_CAL[0], id='ev2', program_name='Front lawn by the long hedge', site='',
                                                enabled=False, start_time='09:00', days_of_week=[0, 1, 2, 3, 4])])
    p.pub('/scheduler/timeline', a2_timeline(now.date()))
    p.open('sleep')
    p.open('plan')
    p.pg.evaluate("document.getElementById('div_calendar_events').scrollIntoView({block: 'center'})")
    p.pg.wait_for_timeout(200)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const box=e=>{const b=e.getBoundingClientRect();return [e.id||e.className||e.tagName,Math.round(b.width),Math.round(b.height)]};
        const hits=q('#div_calendar_events .vt-cal-sw, #div_calendar_events .cal-edit, #div_calendar_events .cal-del, #card_mow_window .vt-switch-hit, #btn_auto_sleep_more').map(box);
        const lim=document.getElementById('chk_window_enabled').getBoundingClientRect(), cal=document.querySelector('#div_calendar_events .cal-toggle').getBoundingClientRect();
        const set=q('#auto_sec_sleep .vt-auto-set-c .form-check-input')[0];
        const sb=set?set.getBoundingClientRect():null;
        const cut=q('#auto_tok_mode .vt-pill, #auto_tok_rain .vt-pill, #auto_tok_plan .vt-pill, #auto_tok_now .vt-pill').filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent);
        const out=q('#div_menu_autonomy *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        const over=q('#div_calendar_events *, #auto_timeline *, #card_calendar *').filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>e.id||e.className);
        return {w:document.documentElement.scrollWidth, coarse:matchMedia('(pointer: coarse)').matches, hits,
                lim:[Math.round(lim.width),Math.round(lim.height)], cal:[Math.round(cal.width),Math.round(cal.height)],
                set:sb?[Math.round(sb.width),Math.round(sb.height)]:null, cut, out, over}}""")
    check(label + ' A2: no sideways scroll', r['w'] <= vw + 1 and not r['out'], r['out'])
    check(label + ' A2: calendar row, timeline, top card: nothing cut', not r['over'], r['over'])
    check(label + ' A2: head tokens whole', not r['cut'], r['cut'])
    check(label + ' A2: Limit and calendar switches the size of a setting switch', r['lim'] == r['cal'] == (r['set'] or r['cal']) and r['lim'][0] >= 40, r)
    if r['coarse']:
        check(label + ' A2: touch targets >= 40 px (calendar switch, Edit, Delete, Limit, sleep line)',
              all(h[2] >= 40 for h in r['hits']) and len(r['hits']) >= 6, r['hits'])
    # T8 dávka IV (T4 backlog): a setting row's foot — the hidden Reset (value = default) leaves
    # no empty strip, a shown one is a finger's size on touch, and showing it moves nothing
    ft = p.pg.evaluate("""()=>[...document.querySelectorAll('#div_menu_autonomy .vt-auto-set-f')].filter(e=>e.offsetParent).map(f=>{
        const b=f.querySelector('.vt-auto-reset'), fb=f.getBoundingClientRect(), bb=b?b.getBoundingClientRect():null;
        const tops=new Set([...f.children].map(c=>c.getBoundingClientRect()).filter(c=>c.width>0).map(c=>Math.round((c.top+c.bottom)/2/12)));
        return {h:Math.round(fb.height), lines:Math.max(1,tops.size), shown:!!b&&b.style.visibility!=='hidden',
                bh:bb?Math.round(bb.height):0, k:(f.parentNode.dataset||{}).key||''}})""")
    check(label + ' A2: setting feet found', len(ft) >= 3, ft)
    tall = [f for f in ft if f['lines'] == 1 and f['h'] > 26]
    check(label + ' A2: a one-line setting foot keeps its 22-px line (no empty strip for a hidden Reset)', not tall, tall[:4])
    if r['coarse']:
        small = [f for f in ft if f['shown'] and f['bh'] < 40]
        check(label + ' A2: a shown Reset is >= 40 px on touch', not small, small[:4])
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-a2-calendar.png'))
        p.pg.evaluate("document.getElementById('auto_timeline').scrollIntoView({block: 'center'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-a2-timeline.png'))


def a3_journal(now):
    """41 entries over three days, oldest first as master_controller sends them; three problems among them."""
    out = []
    base = now - dt.timedelta(days=2, hours=3)

    def add(mins, kind, code, program='Bigger', **v):
        out.append({'t': (base + dt.timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M:%S'), 'kind': kind, 'code': code,
                    'program': program, 'vars': v})
    for i in range(30):
        add(i * 2, 'settings', 'changed', '', by='owner', values={'sleep_ignore_ui': bool(i % 2)})
    add(100, 'started', 'started', slot='x')
    add(130, 'waited', 'weather', left_s=1800)
    add(140, 'waited', 'gps', left_s=60)
    add(170, 'finished', 'run_failed', reason='critical')
    add(1500, 'started', 'started')
    add(1560, 'finished', 'stopped', reason='stopped:user_stop')
    add(1600, 'settings', 'changed', '', by='agent', values={'wake_before_min': 8.0})
    add(1700, 'slept', 'timed', '', by='auto', ms=3600000)
    add(1760, 'woke', 'timed', '', late_s=4)
    add(2900, 'missed', 'slot_missed')
    add(2950, 'mode', 'agent', '', by='owner')
    return out


def a3_story(p, shots, label):
    """T21 A3: Run next says what it does (taps and message unchanged); History in pages, filters, plain endings. Display only."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    nxt = now + dt.timedelta(hours=5)
    p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(nxt)}))
    p.open('plan')
    vis = lambda s: p.pg.evaluate("(s)=>{const e=document.querySelector(s);return !!(e&&e.offsetParent)}", s)
    n0 = len(p.pg.evaluate('__fake.sent'))

    # Run next: its own row with the program, and what it does
    lab = p.text('#btn_auto_runnext') or ''
    check('A3 Run next names the program', 'Bigger' in lab and lab == ('Spustit Bigger teď' if cs else 'Start Bigger now'), lab)
    check('A3 Run next on its own row under the plan changes', p.pg.evaluate(
        "(()=>{const b=document.getElementById('btn_auto_runnext'), r=document.getElementById('auto_runnext'), s=document.getElementById('btn_auto_skip');"
        "return r.contains(b) && document.getElementById('auto_plan_actions').contains(r) && r.getBoundingClientRect().top >= s.getBoundingClientRect().bottom - 1})()"))
    what = p.text('#auto_runnext_what') or ''
    check('A3 Run next says what it does: program, its time, hard limits',
          'Bigger' in what and nxt.strftime('%H:%M') in what and ('tvrdé limity' if cs else 'hard limits') in what, what)
    check('A3 Run next looks different from Skip', p.pg.evaluate(
        "getComputedStyle(document.getElementById('btn_auto_runnext')).backgroundColor !== getComputedStyle(document.getElementById('btn_auto_skip')).backgroundColor"))
    # held: the robot's own gate in words, tone like the top card
    p.pub('/scheduler/report', report(now, checks=start_checks(dock=('block', 'not_in_dock', {})), next={'program': 'Bigger', 'at': iso(nxt)}))
    what = p.text('#auto_runnext_what') or ''
    check('A3 Run next held: says the check, red', ('Není v doku' if cs else 'Not in the dock') in what
          and p.pg.evaluate("document.getElementById('auto_runnext_what').dataset.state") == 'err', what)
    p.pub('/scheduler/report', report(now, checks=start_checks(automation=('off', 'off', {})), next={'program': 'Bigger', 'at': iso(nxt)}))
    check('A3 Run next held by automation off: neutral', not p.pg.evaluate("document.getElementById('auto_runnext_what').dataset.state"),
          p.text('#auto_runnext_what'))
    p.pub('/scheduler/report', report(now, state='MOWING', code='mowing', checks=start_checks(), next={'program': 'Bigger', 'at': iso(nxt)},
                                      run={'program': 'Front', 'slot': None, 'started': True}))
    what = p.text('#auto_runnext_what') or ''
    check('A3 Run next while mowing: says so', 'Front' in what and ('už běží' if cs else 'already under way') in what, what)
    # an open run that waits (battery): not "under way", it waits and nothing more starts
    p.pub('/scheduler/report', report(now, code='waiting_battery', checks=start_checks(battery=('wait', 'low', {'pct': 31, 'need': 40})),
                                      next={'program': 'Bigger', 'at': iso(nxt)}, run={'program': 'Front', 'slot': None, 'started': True}))
    what = p.text('#auto_runnext_what') or ''
    check('A3 Run next with a waiting run: waits, why, nothing more starts', 'Front' in what and ('čeká' if cs else 'waits') in what
          and ('Baterie' if cs else 'Battery') in what and ('už běží' if cs else 'under way') not in what, what)
    # the robot's own gate beyond the checks: a countdown, a hardware reset, asleep (master _start_blocker)
    for over, want in ((dict(sentence={'code': 'sleep_countdown', 'vars': {'left_s': 60}}), 'Usíná' if cs else 'Falling asleep'),
                       (dict(sentence={'code': 'hw_reset_countdown', 'vars': {'left_s': 60}}), 'tvrdý restart' if cs else 'hardware reset'),
                       (dict(state='PREPARE_SLEEP', code='sleep_prepare', sentence={'code': 'sleep_prepare', 'vars': {}}), 'Spí' if cs else 'Asleep')):
        p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(nxt)}, **over))
        what = p.text('#auto_runnext_what') or ''
        check('A3 Run next refused while %s: says so, amber' % want, want in what and ('odmítl' if cs else 'refused') in what
              and p.pg.evaluate("document.getElementById('auto_runnext_what').dataset.state") == 'warn', what)
    p.pub('/scheduler/report', report(now, checks=start_checks(), next=None))
    check('A3 Run next with nothing planned: disabled, says so', p.pg.evaluate("document.getElementById('btn_auto_runnext').disabled")
          and p.text('#auto_runnext_what') == ('Není naplánované nic, co by šlo přesunout.' if cs else 'Nothing planned to bring forward.'),
          p.text('#auto_runnext_what'))
    # the two taps and the message: as before
    p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(nxt)}))
    again = p.pg.evaluate("VTI18n.t('auto.tap_again')")
    k = len(p.sent('/scheduler/run_next'))
    p.click('#btn_auto_runnext')
    check('A3 Run next first tap: nothing sent, asks again', len(p.sent('/scheduler/run_next')) == k
          and p.text('#btn_auto_runnext') == again and p.pg.evaluate("!!document.getElementById('btn_auto_runnext').dataset.armed"))
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-a3-runnext-armed.png'))
    p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(nxt)}))
    check('A3 Run next armed: a report does not undo the second tap', p.text('#btn_auto_runnext') == again)
    p.click('#btn_auto_runnext')
    got = p.sent('/scheduler/run_next')
    check('A3 Run next second tap: one message, the same as before', len(got) == k + 1 and got[-1] == {'data': True}, got[k:])
    check('A3 Run next label back with the program', 'Bigger' in (p.text('#btn_auto_runnext') or ''), p.text('#btn_auto_runnext'))
    p.click('#btn_auto_runnext')
    p.pg.wait_for_timeout(4300)
    check('A3 Run next one tap times out: label back, nothing sent', len(p.sent('/scheduler/run_next')) == k + 1
          and 'Bigger' in (p.text('#btn_auto_runnext') or '') and not p.pg.evaluate("document.getElementById('btn_auto_runnext').dataset.armed"))
    n1 = len(p.pg.evaluate('__fake.sent'))
    check('A3 Run next: nothing else sent', n1 == n0 + 1, p.pg.evaluate('__fake.sent')[n0:])

    # History: a page, a line per day, Show older
    p.pg.evaluate("try{localStorage.removeItem('vitulus_auto_jfilter')}catch(e){}")
    p.click('.vt-auto-fbtn[data-f="all"]')
    p.pub('/scheduler/journal', {'entries': a3_journal(now)})
    p.open('history')
    rows = lambda: p.pg.evaluate("[...document.querySelectorAll('#auto_journal .vt-act')].map(e=>[e.dataset.state, e.querySelector('.vt-act-txt').textContent, e.querySelector('.vt-act-time').textContent])")
    r = rows()
    check('A3 History: the newest 15', len(r) == 15, len(r))
    check('A3 History: the row says the time, the day is a line', all(re.match(r'^\d\d:\d\d$', x[2]) for x in r)
          and p.pg.evaluate("document.querySelectorAll('#auto_journal .vt-auto-jday').length") >= 2, [x[2] for x in r])
    more = p.text('#btn_auto_journal_more') or ''
    check('A3 History: Show older says how many', '26' in more, more)
    p.click('#btn_auto_journal_more')
    check('A3 History: Show older adds 25', len(rows()) == 40 and vis('#btn_auto_journal_more'), len(rows()))
    p.click('#btn_auto_journal_more')
    check('A3 History: then the rest, and no more button', len(rows()) == 41 and not vis('#btn_auto_journal_more'), len(rows()))
    # problems: a filter with its count, endings in words
    chip = p.text('.vt-auto-fbtn[data-f="problems"]') or ''
    check('A3 History: Problems with its count', chip.endswith('3'), chip)
    p.click('.vt-auto-fbtn[data-f="problems"]')
    r = rows()
    check('A3 History: Problems only problems', len(r) == 3 and set(x[0] for x in r) == {'err', 'warn'}, r)
    failed = [x for x in r if ('vzdán' if cs else 'gave up') in x[1]]
    check('A3 History: a failed run is not "finished" and is red', len(failed) == 1 and failed[0][0] == 'err'
          and ('dokončen' if cs else 'finished') not in failed[0][1], r)
    check('A3 History: the filter is remembered', p.pg.evaluate("localStorage.getItem('vitulus_auto_jfilter')") == 'problems')
    p.click('.vt-auto-fbtn[data-f="mow"]')
    r = rows()
    txt = ' '.join(x[1] for x in r)
    stop = [x for x in r if ('ručně' if cs else 'by hand') in x[1]]
    check('A3 History: Mowing — stopped by hand, said so, not green', len(stop) == 1 and stop[0][0] == 'off', r)
    check('A3 History: Mowing — why it waited', ('dešti' if cs else 'rain') in txt and ('GPS') in txt and '{' not in txt, txt)
    check('A3 History: Mowing — no settings in it', ('Změnil' if cs else 'changed') not in txt, txt)
    p.click('.vt-auto-fbtn[data-f="decide"]')
    r = rows()
    txt = ' '.join(x[1] for x in r)
    check('A3 History: a new filter starts at the first page', len(r) == 15 and vis('#btn_auto_journal_more'), len(r))
    check('A3 History: Decisions — what changed and who', ('Změnil jsi: Ignorovat otevřené UI' if cs else 'You changed: Ignore open UI') in txt
          and ('Agent změnil: Probudit se před programem → 8' if cs else 'The agent changed: Wake before a program → 8') in txt, txt[:300])
    # how it ended and why it waited, by vars.reason / vars.reject; who switched; going home at the permit's end
    p.click('.vt-auto-fbtn[data-f="all"]')
    ts = lambda m: (now - dt.timedelta(minutes=m)).strftime('%Y-%m-%dT%H:%M:%S')
    J = [('waited', 'weather', {'reject': 'rain', 'left_s': 1800}), ('waited', 'weather', {'left_s': 1800}),
         ('finished', 'run_failed', {'reason': 'temp_sensor'}), ('finished', 'run_failed', {'reason': 'critical'}),
         ('finished', 'run_rejected', {'reason': 'dock:intent_timeout'}), ('dock_permit', 'homeward', {'window': 'x', 'left_s': 300}),
         ('dock_permit', 'homeward_cancel', {}), ('mode', 'agent', {'by': 'owner'})]
    p.pub('/scheduler/journal', {'entries': [{'t': ts(60 - i), 'kind': k, 'code': c, 'program': '' if k == 'mode' else 'Bigger', 'vars': v}
                                             for i, (k, c, v) in enumerate(J)]})
    r = [x[1] for x in rows()][::-1]     # oldest first, as J
    want = (['nevyjel', 'přerušen kvůli dešti', 'ukončen: porucha teplotního čidla', 'vzdán po opakovaných chybách',
             'nepotvrdil výjezd agenta', 'nejvýš 5 min', 'seče dál', 'Přepnul jsi: rozhoduje agent'] if cs else
            ['did not leave', 'stopped for rain', 'ended: the mower\'s temperature sensor', 'gave up after repeated errors',
             'did not confirm the agent\'s exit', 'at most 5 min', 'mows on', 'You switched: the agent decides'])
    check('A3 History: endings and waits by their reason, who switched, going home', len(r) == len(want)
          and all(w in x for w, x in zip(want, r)) and not any('{' in x for x in r), list(zip(want, r)))
    check('A3 History: a refused start is not "stopped"', ('přerušen' if cs else 'stopped for') not in r[0], r[0])
    check('A3 History: nothing sent', len(p.pg.evaluate('__fake.sent')) == n1, p.pg.evaluate('__fake.sent')[n1:])
    if shots:
        p.pg.evaluate("document.getElementById('auto_sec_history').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-a3-history.png'))
    p.click('.vt-auto-fbtn[data-f="all"]')
    errs = [e for e in p.errors if 'erases' not in e]
    check('A3 no page errors', not errs, errs[:3])


def a3_fit(p, shots, label):
    """Run next and History on this screen: touch size, compact rows on a phone, nothing cut, no sideways scroll."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/report', report(now, checks=start_checks(dock=('block', 'not_in_dock', {})),
                                      next={'program': 'Front lawn by the long hedge', 'at': iso(now + dt.timedelta(hours=5))}))
    p.pub('/scheduler/journal', {'entries': a3_journal(now)})
    p.open('plan')
    p.open('history')
    p.pg.evaluate("document.getElementById('auto_sec_history').scrollIntoView({block: 'start'})")
    p.pg.wait_for_timeout(200)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const h=e=>Math.round(e.getBoundingClientRect().height);
        const out=q('#div_menu_autonomy *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        const over=q('#auto_runnext, #auto_runnext *, #auto_journal_filter *, #auto_journal *').filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>e.id||e.className);
        const f=document.getElementById('auto_journal_filter').getBoundingClientRect();
        const chips=q('.vt-auto-fbtn').map(e=>{const b=e.getBoundingClientRect();return [e.dataset.f,Math.round(b.height),b.right<=f.right+1&&b.left>=f.left-1]});
        const one=q('#auto_journal .vt-act').map(h);
        return {w:document.documentElement.scrollWidth, coarse:matchMedia('(pointer: coarse)').matches, out, over, chips,
                run:h(document.getElementById('btn_auto_runnext')), more:h(document.getElementById('btn_auto_journal_more')), rowMin:Math.min(...one)}}""")
    check(label + ' A3: no sideways scroll', r['w'] <= vw + 1 and not r['out'], r['out'])
    check(label + ' A3: Run next, filters, journal: nothing cut', not r['over'], r['over'])
    check(label + ' A3: filters whole inside their row', all(c[2] for c in r['chips']) and len(r['chips']) == 5, r['chips'])
    if r['coarse']:
        check(label + ' A3: touch targets >= 40 px (Run next, filters, Show older)', r['run'] >= 40 and r['more'] >= 40
              and all(c[1] >= 40 for c in r['chips']), r)
    else:
        check(label + ' A3: filters 32 px with a mouse', all(c[1] >= 32 for c in r['chips']), r['chips'])
    if vw < 600:
        check(label + ' A3: compact journal rows on a phone', r['rowMin'] <= 32, r['rowMin'])
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-a3-history-fit.png'))
        p.pg.evaluate("document.getElementById('auto_runnext').scrollIntoView({block: 'center'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-a3-runnext.png'))


def a4_story(p, shots, label):
    """T21 A4: woke on time / later / earlier, the planned wake in the tile, a burst of settings in one row,
    Skip names its start, words in the setting footers, no empty message line. Display only."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    awake = checks(ssh=('block', 'logins', {'who': ['pts/0']}), ui=('block', 'clients', {'n': 2}))
    nxt = now + dt.timedelta(hours=7)
    p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(nxt)},
                                      sleep={'checks': awake, 'block': 'login:pts/0', 'next_wake': None}))
    p.open('plan')
    p.open('sleep')
    p.open('history')
    p.tick()
    n0 = len(p.pg.evaluate('__fake.sent'))
    p.pg.evaluate("try{localStorage.removeItem('vitulus_auto_jfilter')}catch(e){}")
    p.click('.vt-auto-fbtn[data-f="all"]')

    # woke: on time, later, earlier
    ts = lambda s: (now - dt.timedelta(seconds=s)).strftime('%Y-%m-%dT%H:%M:%S')
    J = [{'t': ts(9000), 'kind': 'woke', 'code': 'timed', 'program': '', 'vars': {'late_s': 4}},
         {'t': ts(8000), 'kind': 'woke', 'code': 'timed', 'program': '', 'vars': {'late_s': 430969}},
         {'t': ts(7000), 'kind': 'woke', 'code': 'timed', 'program': '', 'vars': {'late_s': -40966}},
         # one change alone, then a burst of four by you (each within 90 s), then the agent right after
         {'t': ts(4000), 'kind': 'settings', 'code': 'changed', 'program': '', 'vars': {'by': 'owner', 'values': {'wake_before_min': 8.0}}},
         {'t': ts(3000), 'kind': 'settings', 'code': 'changed', 'program': '', 'vars': {'by': 'owner', 'values': {'sleep_ignore_ssh': True}}},
         {'t': ts(2999), 'kind': 'settings', 'code': 'changed', 'program': '', 'vars': {'by': 'owner', 'values': {'sleep_ignore_ui': True}}},
         {'t': ts(2986), 'kind': 'settings', 'code': 'changed', 'program': '', 'vars': {'by': 'owner', 'values': {'sleep_ignore_ssh': False}}},
         {'t': ts(2930), 'kind': 'settings', 'code': 'changed', 'program': '', 'vars': {'by': 'owner', 'values': {'sleep_ignore_ui': False}}},
         {'t': ts(2920), 'kind': 'settings', 'code': 'changed', 'program': '', 'vars': {'by': 'agent', 'values': {'wake_before_min': 12.0}}}]
    p.pub('/scheduler/journal', {'entries': J})
    r = p.pg.evaluate("[...document.querySelectorAll('#auto_journal .vt-act .vt-act-txt')].map(e=>e.textContent)")[::-1]
    check('A4 History: woke on time / later (in days) / earlier', len(r) >= 3
          and ('včas' if cs else 'on time') in r[0] and ('5 dní později' if cs else '5 days later') in r[1]
          and ('11 h 23 min dřív' if cs else '11 h 23 min earlier') in r[2], r[:3])
    check('A4 History: a burst of settings is one row, where each ended, how many', len(r) == 6
          and '×4' in r[4] and ('Ignorovat přihlášení → vypnuto' if cs else 'Ignore logins → off') in r[4]
          and ('Ignorovat otevřené UI → vypnuto' if cs else 'Ignore open UI → off') in r[4], r)
    check('A4 History: a lone change and another person\'s change stay rows of their own', '×' not in r[3] and '×' not in r[5]
          and ('Agent změnil' if cs else 'The agent changed') in r[5], r[3:])
    # a newer value never hides behind an older row: Skip next on, another entry, then Skip next off in a burst of five keys
    S = lambda s, **v: {'t': ts(s), 'kind': 'settings', 'code': 'changed', 'program': '', 'vars': {'by': 'owner', 'values': v}}
    J2 = [S(900, skip_next=True), {'t': ts(800), 'kind': 'mode', 'code': 'agent', 'program': '', 'vars': {'by': 'owner'}},
          S(700, wake_before_min=8.0, sleep_ignore_ssh=True), S(690, sleep_ignore_ui=True, idle_sleep_threshold_min=30.0),
          S(680, catchup_max_h=2.0), S(670, skip_next=None),
          {'t': ts(600), 'kind': 'woke', 'code': 'timed', 'program': '', 'vars': {'late_s': 129600}},
          {'t': ts(500), 'kind': 'woke', 'code': 'timed', 'program': '', 'vars': {'late_s': 400 * 86400}}]
    p.pub('/scheduler/journal', {'entries': J2})
    txt = lambda: p.pg.evaluate("[...document.querySelectorAll('#auto_journal .vt-act .vt-act-txt')].map(e=>e.textContent)")[::-1]
    r = txt()
    burst = [x for x in r if '×4' in x]
    off = ('Přeskočit další → vypnuto' if cs else 'Skip next → off')
    check('A4 History: the newer Skip next value leads the burst row, no "+N"', len(burst) == 1
          and burst[0].split(': ', 1)[1].startswith(off) and '+' not in burst[0]
          and all(w in burst[0] for w in (('Probudit se před programem', 'Ignorovat přihlášení', 'Ignorovat otevřené UI') if cs
                                         else ('Wake before a program', 'Ignore logins', 'Ignore open UI'))), r)
    p.click('.vt-auto-fbtn[data-f="decide"]')
    check('A4 History: the burst is the same row in Decisions', [x for x in txt() if '×4' in x] == burst, txt())
    p.click('.vt-auto-fbtn[data-f="all"]')
    check('A4 History: woke a day and a half later, past a year capped', ('1 den 12 h později' if cs else '1 day 12 h later') in r[-2]
          and ('víc než rok později' if cs else 'more than a year later') in r[-1], r[-2:])

    # the tile: the plan's wake before it sleeps, the robot's own wake once it has one
    tile = p.pg.evaluate("[...document.querySelectorAll('#auto_nums_sleep .vt-auto-num')][0].textContent")
    m = re.search(r'≈ ([^()]*?\d\d:\d\d)', tile or '')
    full = p.pg.evaluate("document.getElementById('auto_sleep_plan').title") or ''
    check('A4 Sleep tile: the planned wake, not a dash', m is not None and m.group(1) in full and ('plán' if cs else 'plan') in tile, [tile, full])
    wk = now + dt.timedelta(hours=3)
    p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(nxt)},
                                      sleep={'checks': awake, 'block': 'login:pts/0', 'next_wake': iso(wk)}))
    tile = p.pg.evaluate("[...document.querySelectorAll('#auto_nums_sleep .vt-auto-num')][0].textContent")
    check('A4 Sleep tile: the robot\'s wake when it has one', wk.strftime('%H:%M') in tile and '≈' not in tile, tile)
    foot = p.pg.evaluate("[...document.querySelectorAll('#auto_sec_sleep .vt-auto-set-f')].map(e=>e.textContent).join(' | ')")
    check('A4 setting footers say on / off in words', ('Výchozí zapnuto' if cs else 'Default on') in foot
          and not re.search(r'\b(ON|OFF)\b', foot), foot[:300])

    # Skip next names its start; nothing on a second line once skipped
    sk = p.pg.evaluate("(()=>{const b=document.getElementById('btn_auto_skip'), s=b.querySelector('.vt-auto-btn-s');return [b.querySelector('.vt-auto-btn-t').textContent, s?s.textContent:'']})()")
    check('A4 Skip next says which start', 'Bigger' in sk[1] and nxt.strftime('%H:%M') in sk[1], sk)
    p.pub('/scheduler/settings', dict(agent_settings(), values=dict(agent_settings()['values'], skip_next=True)))
    sk = p.pg.evaluate("(()=>{const b=document.getElementById('btn_auto_skip'), s=b.querySelector('.vt-auto-btn-s');return [b.querySelector('.vt-auto-btn-t').textContent, s?s.textContent:'']})()")
    check('A4 Skip undone: the button says undo, the start is in the line above', sk[1] == ''
          and sk[0] == p.pg.evaluate("VTI18n.t('auto.plan.unskip')"), sk)
    p.pub('/scheduler/settings', agent_settings())
    check('A4 no empty message line under the plan steps', p.pg.evaluate(
        "(()=>{const m=document.getElementById('auto_plan_msg');return !m.textContent && m.getBoundingClientRect().height===0})()"))
    check('A4 nothing sent', len(p.pg.evaluate('__fake.sent')) == n0, p.pg.evaluate('__fake.sent')[n0:])
    if shots:
        p.pg.evaluate("document.getElementById('auto_sec_history').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-a4-history.png'))
    errs = [e for e in p.errors if 'erases' not in e]
    check('A4 no page errors', not errs, errs[:3])


def a4_fit(p, shots, label):
    """One button height, equal Skip / No mowing, filters in one row, the sentence's reserved height on this screen."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(now + dt.timedelta(hours=7))},
                                      sleep={'checks': checks(ssh=('block', 'logins', {'who': ['pts/0']})), 'block': 'login:pts/0'}))
    p.pub('/scheduler/calendar', A2_CAL)
    p.pub('/scheduler/journal', {'entries': a3_journal(now)})
    p.open('now')
    p.open('plan')
    p.open('history')
    p.pg.wait_for_timeout(200)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const box=e=>{const b=e.getBoundingClientRect();return [e.id||e.className,Math.round(b.width),Math.round(b.height)]};
        const btns=q('#btn_auto_ans_mode, #btn_auto_ans_now, #btn_auto_checks_all, #btn_auto_sleep_more, #auto_checks .vt-auto-go, #div_calendar_events .vt-cal-row .btn, .vt-auto-fbtn, #btn_auto_journal_more, #btn_auto_skip, #btn_auto_nomow').map(box);
        const s=document.getElementById('btn_auto_skip').getBoundingClientRect(), n=document.getElementById('btn_auto_nomow').getBoundingClientRect();
        const tops=q('.vt-auto-fbtn').map(e=>Math.round(e.getBoundingClientRect().top));
        const sen=document.querySelector('.vt-auto-sentence'), cs=getComputedStyle(sen);
        const out=q('#div_menu_autonomy *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        const over=q('#auto_plan_actions *, #auto_journal_filter *, #card_calendar *').filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>e.id||e.className);
        return {w:document.documentElement.scrollWidth, coarse:matchMedia('(pointer: coarse)').matches, btns,
                skipW:Math.round(s.width), noW:Math.round(n.width), rows:new Set(tops).size,
                minH:parseFloat(cs.minHeight), lh:parseFloat(cs.fontSize)*1.35, out, over}}""")
    floor = 40 if r['coarse'] else 36
    check(label + ' A4: no sideways scroll', r['w'] <= vw + 1 and not r['out'], r['out'])
    check(label + ' A4: plan steps, filters, top card: nothing cut', not r['over'], r['over'])
    check(label + ' A4: buttons >= %d px (answers, Show all, ›, sleep line, Edit/Delete, filters, Show older, Skip)' % floor,
          all(b[2] >= floor for b in r['btns']) and len(r['btns']) >= 10, [b for b in r['btns'] if b[2] < floor] or len(r['btns']))
    check(label + ' A4: Skip next and No mowing today equally wide', abs(r['skipW'] - r['noW']) <= 1, [r['skipW'], r['noW']])
    check(label + ' A4: history filters in one row', r['rows'] == 1, r['rows'])
    if vw >= 576:
        check(label + ' A4: the sentence reserves one line in the wider panel', r['minH'] <= r['lh'] + 1, [r['minH'], r['lh']])
    if shots:
        p.pg.evaluate("document.getElementById('card_calendar').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-a4-top.png'))
        p.pg.evaluate("document.getElementById('auto_plan_actions').scrollIntoView({block: 'center'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-a4-plan.png'))



def a5_story(p, shots, label):
    """T21 A5: no connection said, why nothing is planned (every calendar entry off), a past decision muted,
    no tiles repeating the setting rows, nothing rewritten while nothing changes. Display only."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    off = [dict(A2_CAL[0], enabled=False)]
    p.pub('/scheduler/calendar', off)
    p.pub('/scheduler/report', report(now, code='no_schedule', next=None,
                                      checks=start_checks(programs=('off', 'no_schedule', {}))))
    p.pub('/scheduler/timeline', {'starts': [], 'sleeps': []})
    p.open('now')
    p.open('plan')
    n0 = len(p.pg.evaluate('__fake.sent'))
    say = ('položka kalendáře Bigger 23:15 je vypnutá' if cs else 'the calendar entry Bigger 23:15 is switched off')
    chk = p.text('#auto_checks') or ''
    check('A5 nothing planned says why: the only entry is off', say in chk, chk)
    fix = p.pg.evaluate("""(()=>{const r=[...document.querySelectorAll('#auto_checks .vt-auto-check')].find(e=>/Bigger/.test(e.textContent));
        const b=r&&r.querySelector('.vt-auto-go');return b?b.title:null})()""")
    check('A5 its › opens Plan (the calendar), not Programs', fix == p.pg.evaluate("VTI18n.t('auto.fix.plan')"), fix)
    check('A5 Plan head: Calendar off', ('Kalendář vypnutý' if cs else 'Calendar off') in (p.text('#auto_tok_plan') or ''), p.text('#auto_tok_plan'))
    st = p.text('#auto_plan_state') or ''
    check('A5 Plan says switch it on to plan it again', 'Bigger 23:15' in st and ('Zapni' if cs else 'Switch it on') in st, st)
    row = p.pg.evaluate("""(()=>{const r=document.querySelector('#div_calendar_events .vt-cal-row');
        return [getComputedStyle(r).opacity, getComputedStyle(r.querySelector('.vt-cal-name')).opacity,
                (r.querySelector('.vt-cal-offtag')||{}).textContent||'', getComputedStyle(r.querySelector('.cal-edit')).opacity,
                getComputedStyle(r.querySelector('.vt-cal-offtag')).opacity]})()""")
    check('A5 calendar row off: says Off (not dimmed), Edit/Delete not dimmed, name dimmed', row[0] == '1' and float(row[1]) < 1
          and row[2] == ('Vypnuto' if cs else 'Off') and row[3] == '1' and row[4] == '1', row)
    p.pub('/scheduler/mode', mode_view('agent'))
    check('A5 in the agent mode the switched-off calendar is not the reason', say not in (p.text('#auto_checks') or ''), p.text('#auto_checks'))
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/calendar', A2_CAL)
    check('A5 an entry on: not said', say not in (p.text('#auto_checks') or '')
          and ('Kalendář vypnutý' if cs else 'Calendar off') not in (p.text('#auto_tok_plan') or ''), p.text('#auto_checks'))
    check('A5 calendar row on: no Off', p.pg.evaluate("document.querySelectorAll('#div_calendar_events .vt-cal-offtag').length") == 0)

    # a decision whose time is over: muted, "over at"
    past = {'t': iso(now - dt.timedelta(hours=4)) + ':00', 'kind': 'advice', 'code': 'skip', 'program': '', 'source': 'agent',
            'vars': {'until': iso(now - dt.timedelta(hours=1)) + ':00'}}
    p.pub('/scheduler/mode', mode_view('calendar', last_decision=past))
    p.open('mode')
    lst = p.text('#auto_mode_last') or ''
    check('A5 a past decision says it is over, muted', p.pg.evaluate("document.getElementById('auto_mode_last').dataset.past") == '1'
          and ('skončilo' if cs else 'over at') in lst, lst)
    fut = dict(past, vars={'until': iso(now + dt.timedelta(hours=2)) + ':00'})
    p.pub('/scheduler/mode', mode_view('calendar', last_decision=fut))
    check('A5 a decision still in force: not "over"', not p.pg.evaluate("document.getElementById('auto_mode_last').dataset.past")
          and ('skončilo' if cs else 'over at') not in (p.text('#auto_mode_last') or ''), p.text('#auto_mode_last'))

    # tiles: only live numbers
    p.pub('/scheduler/report', report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(now + dt.timedelta(hours=5))}))
    nt = p.pg.evaluate("['rain','battery','recovery','sleep'].map(s=>document.getElementById('auto_nums_'+s).children.length)")
    check('A5 no tiles repeating the settings: rain 0, battery 1, faults 2, sleep 2', nt == [0, 1, 2, 2], nt)

    # nothing rewritten while nothing changes (the status, the mode and the radar come every second)
    rain = {'rain_alert': False, 'rain_now': 0, 'time': {'secs': 0, 'nsecs': 0}, 'status_nowcast10m': 'OK',
            'status_nowcast20m': 'OK', 'status_nowcast30m': 'OK'}
    mv = mode_view('calendar', last_decision=fut)
    p.raw('/weather_alert/rain_alert', rain)
    p.pub('/scheduler/mode', mv)
    p.raw('/scheduler/status', {'data': 'Idle'})
    p.tick(600)
    # the top card's sleep line is a clock sentence ("Falls asleep at 21:29 for 4 h 43 min"): it changes for real
    # as time goes (its duration counts down to a fixed wake), and is written only when its text changes; it is
    # left out here. A window that crossed a minute (the page's own clock) is watched again.
    for _try in range(3):
        p.pg.wait_for_function("(()=>{const s=new Date().getSeconds(); return s >= 3 && s <= 50;})()", timeout=70000)
        p.pg.evaluate("""(()=>{window.__mut={}; window.__min=Math.floor(Date.now()/60000); const ids=['card_calendar','auto_radar','auto_mode_last'];
            const sl=document.getElementById('auto_sleep_plan');
            window.__mo=new MutationObserver(l=>l.forEach(m=>{const e=m.target.nodeType===1?m.target:m.target.parentElement;
                if (sl && sl.contains(e) && e !== sl) { return; }
                const k=ids.find(i=>document.getElementById(i).contains(e))||'?'; __mut[k]=(__mut[k]||0)+1;
                (__mut._what=__mut._what||[]).push([e.id||e.className, m.type, m.attributeName]);}));
            ids.forEach(i=>__mo.observe(document.getElementById(i),{subtree:true,childList:true,characterData:true,attributes:true}));})()""")
        for _ in range(4):
            p.raw('/weather_alert/rain_alert', rain)
            p.pub('/scheduler/mode', mv)
            p.raw('/scheduler/status', {'data': 'Idle'})
            p.tick(500)
        mut = p.pg.evaluate("(()=>{__mo.disconnect(); __mut._crossed = Math.floor(Date.now()/60000) !== __min; return __mut})()")
        if not mut.pop('_crossed'):
            break
    what = mut.pop('_what', None)
    check('A5 idle: the top card, the radar and the last decision are not rewritten', not mut, [mut, what])

    # no connection: said after 3 s, since when; muted; back = gone
    p.pg.evaluate("document.dispatchEvent(new Event('rosdisconnected'))")
    p.tick(1000)
    check('A5 a short drop does not flash the banner', p.pg.evaluate("!document.getElementById('auto_stale') || document.getElementById('auto_stale').hidden"))
    p.tick(2600)
    sb = p.text('#auto_stale') or ''
    check('A5 no connection: the top card says since when', p.pg.evaluate("!document.getElementById('auto_stale').hidden")
          and ('Bez spojení s robotem od' if cs else 'No connection to the robot since') in sb and re.search(r'\d\d:\d\d', sb), sb)
    check('A5 no connection: the sections read as not current', p.pg.evaluate(
        "document.getElementById('div_menu_autonomy').dataset.stale === '1' && parseFloat(getComputedStyle(document.getElementById('auto_sec_plan')).opacity) < 1"))
    if shots:
        p.pg.evaluate("document.getElementById('card_calendar').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(250)
        p.pg.screenshot(path=os.path.join(shots, label + '-a5-stale.png'))
    p.pg.evaluate("document.dispatchEvent(new Event('rosconnected'))")
    p.tick(200)
    check('A5 connection back: banner gone, not muted', p.pg.evaluate(
        "document.getElementById('auto_stale').hidden && !document.getElementById('div_menu_autonomy').dataset.stale"))
    check('A5 nothing sent', len(p.pg.evaluate('__fake.sent')) == n0, p.pg.evaluate('__fake.sent')[n0:])
    errs = [e for e in p.errors if 'erases' not in e]
    check('A5 no page errors', not errs, errs[:3])


def a5_fit(p, shots, label):
    """The no-connection line and a switched-off calendar row on this screen: whole, wrapped, no sideways scroll."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/calendar', [dict(A2_CAL[0], enabled=False, program_name='Front lawn by the long hedge')])
    p.pub('/scheduler/report', report(now, code='no_schedule', next=None, checks=start_checks(programs=('off', 'no_schedule', {}))))
    p.open('now')
    p.open('plan')
    p.pg.evaluate("document.dispatchEvent(new Event('rosdisconnected'))")
    p.tick(3400)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const out=q('#div_menu_autonomy *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        const over=q('#auto_stale, #div_calendar_events *, #auto_checks *, #auto_plan_state').filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>e.id||e.className);
        const s=document.getElementById('auto_stale').getBoundingClientRect();
        return {w:document.documentElement.scrollWidth, out, over, sh:Math.round(s.height), tag:q('.vt-cal-offtag').length}}""")
    check(label + ' A5: no sideways scroll', r['w'] <= vw + 1 and not r['out'], r['out'])
    check(label + ' A5: no-connection line, calendar row, checks: nothing cut', not r['over'] and r['sh'] > 0 and r['tag'] == 1, r)
    if shots:
        p.pg.evaluate("document.getElementById('card_calendar').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(200)
        p.pg.screenshot(path=os.path.join(shots, label + '-a5-fit-top.png'))
        p.pg.evaluate("document.getElementById('div_calendar_events').scrollIntoView({block: 'center'})")
        p.pg.wait_for_timeout(200)
        p.pg.screenshot(path=os.path.join(shots, label + '-a5-fit-cal.png'))
    p.pg.evaluate("document.dispatchEvent(new Event('rosconnected'))")
    p.tick(200)



def a6_story(p, shots, label):
    """T21 A6: what holds a start in words, Plan's head follows the mode, nothing in the panel rewritten while
    nothing changes, Fold all, the open section's head stays at the top. Display only."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/calendar', [dict(A2_CAL[0], enabled=False)])
    rep0 = report(now, code='no_schedule', next=None, checks=start_checks(programs=('off', 'no_schedule', {})))
    p.pub('/scheduler/report', rep0)
    p.open('now')
    p.open('plan')
    n0 = len(p.pg.evaluate('__fake.sent'))
    ans = p.text('#btn_auto_ans_now') or ''
    check('A6 the answer says "Nothing planned", not "Programs"', ('Nic v plánu' if cs else 'Nothing planned') in ans
          and ('Programy' if cs else 'Programs') not in ans, ans)
    check('A6 the Now head too', ('Nic v plánu' if cs else 'Nothing planned') in (p.text('#auto_tok_now') or ''), p.text('#auto_tok_now'))
    off = 'Kalendář vypnutý' if cs else 'Calendar off'
    check('A6 Plan head: Calendar off in the calendar mode', off in (p.text('#auto_tok_plan') or ''), p.text('#auto_tok_plan'))
    p.pub('/scheduler/mode', mode_view('agent'))       # the mode alone, no new report
    check('A6 Plan head follows the mode at once (agent: not Calendar off)', off not in (p.text('#auto_tok_plan') or ''), p.text('#auto_tok_plan'))
    p.pub('/scheduler/mode', mode_view('calendar'))
    # the switched-off entry changes (another name and time, then two of them): Now says the new one, at once
    p.pub('/scheduler/calendar', [dict(A2_CAL[0], enabled=False, program_name='Zeta-other', start_time='06:45')])
    chk = p.text('#auto_checks') or ''
    check('A6 Now follows the switched-off entry it names', 'Zeta-other 06:45' in chk and 'Bigger' not in chk, chk)
    p.pub('/scheduler/calendar', [dict(A2_CAL[0], enabled=False), dict(A2_CAL[0], id='ev9', enabled=False, program_name='Zeta-other')])
    chk = p.text('#auto_checks') or ''
    check('A6 two switched off: Now says all of them', ('všechny položky kalendáře (2)' if cs else 'all 2 calendar entries') in chk, chk)
    p.pub('/scheduler/calendar', A2_CAL)

    # idle: the same report, mode, radar and status again and again rewrite nothing in the panel
    # (the two sleep sentences say clock times and change for real: their text is left out)
    rep1 = report(now, checks=start_checks(), next={'program': 'Bigger', 'at': iso(now + dt.timedelta(hours=5))})
    rain = {'rain_alert': False, 'rain_now': 0, 'time': {'secs': 0, 'nsecs': 0}, 'status_nowcast10m': 'OK',
            'status_nowcast20m': 'OK', 'status_nowcast30m': 'OK'}
    mv = mode_view('calendar')
    for o in ('mode', 'plan', 'rain', 'battery', 'sleep', 'recovery', 'history'):
        p.open(o)
    send = lambda: (p.pub('/scheduler/report', rep1), p.pub('/scheduler/mode', mv), p.raw('/weather_alert/rain_alert', rain),
                    p.raw('/scheduler/status', {'data': 'Idle'}))
    send()
    p.tick(800)
    for _try in range(3):
        p.pg.wait_for_function("(()=>{const s=new Date().getSeconds(); return s >= 3 && s <= 50;})()", timeout=70000)
        send()          # the page takes in the new minute (the timeline's "now" mark) before the watch starts
        p.tick(500)
        p.pg.evaluate("""(()=>{window.__m=[]; window.__min=Math.floor(Date.now()/60000);
            const skip=['auto_sleep_plan','auto_sleep_plan2'].map(i=>document.getElementById(i)).filter(Boolean);
            window.__mo=new MutationObserver(l=>l.forEach(m=>{const e=m.target.nodeType===1?m.target:m.target.parentElement;
                if (skip.some(x=>x.contains(e)&&(e!==x||m.type==='childList'))) { return; }
                let id='?'; for (let x=e; x; x=x.parentElement) { if (x.id) { id=x.id; break; } }
                __m.push(id+':'+m.type+(m.attributeName?'.'+m.attributeName:''));}));
            __mo.observe(document.getElementById('div_menu_autonomy'),{subtree:true,childList:true,characterData:true,attributes:true});})()""")
        for _ in range(3):
            send()
            p.tick(400)
        r = p.pg.evaluate("(()=>{__mo.disconnect(); return [__m, Math.floor(Date.now()/60000) !== __min]})()")
        if not r[1]:
            break
    check('A6 idle: nothing in the panel rewritten by the same report, mode, radar, status', not r[0], sorted(set(r[0]))[:12])

    # Fold all: shown from 3 open sections, folds them all (remembered)
    vis = p.pg.evaluate("!document.getElementById('auto_foldall').hidden")
    fb = p.text('#btn_auto_fold_all') or ''
    check('A6 Fold all shown with many open, says how many', vis and re.search(r'\d', fb) and ('Sbalit vše' if cs else 'Fold all') in fb, fb)
    # the open section's head stays at the top while its body scrolls under it
    st = p.pg.evaluate("""(()=>{const b=document.getElementById('ui_drawer_body'), s=document.getElementById('auto_sec_plan');
        const body=s.querySelector('.drawer-sec-body'); b.scrollTop += body.getBoundingClientRect().top - b.getBoundingClientRect().top + 120;
        const h=s.querySelector('summary').getBoundingClientRect(), bt=b.getBoundingClientRect().top;
        const bg=getComputedStyle(s.querySelector('summary')).backgroundColor;
        return [Math.round(h.top - bt), bg, Math.round(s.getBoundingClientRect().top - bt)]})()""")
    # the section's own top has scrolled out of sight, its head stays at the top edge of the panel (its padding)
    check('A6 the open section\'s head stays at the top, not see-through', st[2] < -50 and 0 <= st[0] <= 12
          and st[1] not in ('rgba(0, 0, 0, 0)', 'transparent'), st)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-a6-sticky.png'))
    p.click('#btn_auto_fold_all')
    left = p.pg.evaluate("[...document.querySelectorAll('#div_menu_autonomy details.vt-auto-sec')].filter(d=>d.open).length")
    ls = p.pg.evaluate("['now','plan','history'].map(i=>localStorage.getItem('vitulus_auto_sec_'+i))")
    check('A6 Fold all folds every section, remembered, then hides', left == 0 and ls == ['0', '0', '0']
          and p.pg.evaluate("document.getElementById('auto_foldall').hidden"), [left, ls])
    p.open('now')
    p.open('plan')
    check('A6 nothing sent', len(p.pg.evaluate('__fake.sent')) == n0, p.pg.evaluate('__fake.sent')[n0:])
    errs = [e for e in p.errors if 'erases' not in e]
    check('A6 no page errors', not errs, errs[:3])


def a6_fit(p, shots, label):
    """Fold all and the sticky heads on this screen: touch size, nothing cut, no sideways scroll."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/report', report(now, code='no_schedule', next=None, checks=start_checks(programs=('off', 'no_schedule', {}))))
    for o in ('now', 'plan', 'sleep', 'history'):
        p.open(o)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const out=q('#div_menu_autonomy *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        const over=q('#card_calendar *, #auto_tok_now *').filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>e.id||e.className);
        const f=document.getElementById('btn_auto_fold_all').getBoundingClientRect();
        return {w:document.documentElement.scrollWidth, coarse:matchMedia('(pointer: coarse)').matches, out, over, fh:Math.round(f.height)}}""")
    check(label + ' A6: no sideways scroll', r['w'] <= vw + 1 and not r['out'], r['out'])
    check(label + ' A6: top card and Now head whole', not r['over'], r['over'])
    check(label + ' A6: Fold all >= %d px' % (40 if r['coarse'] else 36), r['fh'] >= (40 if r['coarse'] else 36), r)
    if shots:
        p.pg.evaluate("document.getElementById('card_calendar').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(200)
        p.pg.screenshot(path=os.path.join(shots, label + '-a6-top.png'))
    p.click('#btn_auto_fold_all')
    p.open('now')
    p.open('plan')


def a7_rules(**over):
    """GET /agent/api/watch as webchat._api_watch builds it: one rule that would leave the dock."""
    r = {'id': 12, 'state': 'active', 'why': None, 'when': 'baterie (%) nad 50', 'action': 'provedu dock.undock', 'moves': True,
         'mode': 'poll', 'every_s': 60.0, 'window': None, 'until': None, 'fired': 0, 'last_fired': None, 'repeat': 'once',
         'last_blocked': None, 'last': 'zatím ne', 'owner_text': 'Hlídej baterii: až bude nad 50 %, vyjeď z doku.'}
    r.update(over)
    return r


A7_NO_WORD = {'ts': 1794842887.5, 'kind': 'dock', 'mission': None, 'why': 'robot je v doku a výjezd jsi pro tohle hlídání nepovolil'}


def a7_watch(p, rules, **over):
    d = {'ok': True, 'rules': rules, 'shadow_motion': False}
    d.update(over)
    # no agent behind the test: the panel's own question (every 30 s) would answer "agent down" over what the test says
    p.pg.evaluate('(d)=>{VTWatchRules.refresh=()=>false; VTWatchRules._set(d)}', d)
    p.pg.wait_for_timeout(120)


def a7_story(p, shots, label):
    """T21 A7: the agent's watches in the top card (a rule waiting for the owner's word by its number), the Watching
    card in the owner's words, no › where there is nothing to do, the owner's own choice not in amber, the sleep
    timing note once, an old agent decision not shown while the calendar decides. Display only."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    cs = label.endswith('cs')
    p.pub('/scheduler/sleep_countdown', {'active': False})
    p.pg.evaluate("VTAutonomy._state.countdown = {active: false}")
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/calendar', [dict(A2_CAL[0], enabled=False)])
    # the robot as it stood on 2026-11-16: in the dock, just booted, the only calendar entry off
    boot = report(now, code='boot_grace', next=None, detail={'left_s': 173}, sentence={'code': 'boot_grace', 'vars': {'left_s': 173}},
                  checks=start_checks(mission=('wait', 'boot_grace', {'left_s': 173}), programs=('off', 'no_schedule', {}),
                                      rain=('wait', 'recent_rain', {'min': 20})))
    p.pub('/scheduler/report', boot)
    p.open('now')
    p.open('plan')
    vis = lambda sel: p.pg.evaluate("(s)=>{const e=document.querySelector(s);return !!(e&&!e.hidden&&e.offsetParent)}", sel)
    chip = lambda: p.pg.evaluate("""(()=>{const b=document.getElementById('btn_auto_ans_watch');
        return {vis:!!(b&&!b.hidden&&b.offsetParent), text:b?b.textContent:'', state:b?(b.dataset.state||''):'', tip:b?b.title:''}})()""")

    # 1 the agent's watches in the top card
    check('A7 the Watching block shares what it read', p.pg.evaluate("!!(window.VTWatchRules&&VTWatchRules._set&&VTWatchRules.waits)"))
    r2 = p.pg.evaluate("[VTWatchRules.refresh(30000), VTWatchRules.refresh(30000)]")
    check('A7 the agent is asked at most once per interval', r2[1] is False, r2)
    p.pg.wait_for_timeout(400)
    a7_watch(p, [])
    check('A7 nothing watched: no chip', not chip()['vis'], chip())
    p.pg.evaluate("VTWatchRules._set({error: 'agent'})")
    check('A7 the agent silent: no chip', not chip()['vis'], chip())
    a7_watch(p, [a7_rules(), a7_rules(id=13, moves=False, action='řeknu ti', owner_text='Když vypadne kamera, řekni mi.')])
    c = chip()
    check('A7 two watches: "Agent watches: 2", quiet tone', c['vis'] and (('Agent hlídá: 2' if cs else 'Agent watches: 2') in c['text'])
          and c['state'] == '', c)
    check('A7 … the rules in the owner\'s words in the tooltip', 'Hlídej baterii' in c['tip'] and '#13' in c['tip'], c['tip'])
    a7_watch(p, [a7_rules(state='paused', why='STOP')])
    check('A7 only paused watches: no chip', not chip()['vis'], chip())
    a7_watch(p, [a7_rules(last_blocked=A7_NO_WORD), a7_rules(id=13, moves=False)])
    c = chip()
    check('A7 a watch waiting for the owner\'s word: by its number, amber', c['vis'] and c['state'] == 'warn'
          and (('Hlídání #12 čeká na tvoje slovo' if cs else 'Watch #12 waits for your word') in c['text']), c)
    check('A7 … the sentence to write is in its tooltip', 'u hlídání 12 povol výjezd z doku' in c['tip'], c['tip'])
    a7_watch(p, [a7_rules(last_blocked=dict(A7_NO_WORD, why='robot je v doku'))])
    check('A7 blocked by the dock for another reason: not "waits for your word"', chip()['state'] == '' and chip()['vis'], chip())
    a7_watch(p, [a7_rules(needs_undock_word=True)])
    check('A7 the core\'s own flag (needs_undock_word) is believed', chip()['state'] == 'warn', chip())
    a7_watch(p, [a7_rules(needs_undock_word=False, last_blocked=A7_NO_WORD)])
    check('A7 … and its "no" too', chip()['state'] == '', chip())

    # 2 + 3 the card: the owner's words first, how the agent reads it, what it waits for
    a7_watch(p, [a7_rules(last_blocked=A7_NO_WORD)])
    n0 = len(p.pg.evaluate('__fake.sent'))
    # the Agent panel opens its own socket; the fake keeps talking to the robot's one
    p.pg.evaluate("(()=>{const ros=__fake.sock; Object.defineProperty(__fake,'sock',{get:()=>ros,set:()=>{},configurable:true});})()")
    posts = []
    on_req = lambda rq: posts.append(rq.url) if rq.method != 'GET' else None
    p.pg.on('request', on_req)
    p.click('#btn_auto_ans_watch')
    p.pg.wait_for_timeout(500)
    where = p.pg.evaluate("""(()=>{const b=VTWatchRules.box(), d=b&&b.closest('details'), pn=document.getElementById('vagent_panel');
        return {box:!!b, panel:VAgent.isVisible(), tab:pn&&pn.getAttribute('data-tab'), open:!!(d&&d.open)}})()""")
    check('A7 the chip opens Watching in the Agent panel (its tab, the block unfolded)', where['box'] and where['panel']
          and where['tab'] == 'work' and where['open'], where)
    p.click('#btn_auto_ans_watch')
    p.pg.wait_for_timeout(300)
    check('A7 … a second tap keeps it open (opens, never toggles)', p.pg.evaluate('VAgent.isVisible()'))
    # no agent behind this test: the panel shows "agent down" over its blocks; lift it to see the card as with the agent up
    p.pg.evaluate("""(()=>{const b=document.getElementById('vagent_blocks'), d=document.getElementById('vagent_down');
        if(b){b.classList.remove('vagent-hidden');} if(d){d.style.display='none';}})()""")
    check('A7 … and sends nothing', len(p.pg.evaluate('__fake.sent')) == n0 and not posts, posts)
    p.pg.remove_listener('request', on_req)
    # the block asked the agent when it opened; there is none in this test: its answer again
    a7_watch(p, [a7_rules(last_blocked=A7_NO_WORD)])
    card = p.pg.evaluate("""(()=>{const c=document.querySelector('.vwr-card'); if(!c) return null;
        const q=s=>{const e=c.querySelector(s);return e?e.textContent:''}; const b=c.getBoundingClientRect();
        const kids=[...c.children].map(e=>e.className);
        return {cls:c.className, state:q('.vwr-state'), said:q('.vwr-said'), reads:q('.vwr-sub.vwr-main'), ask:q('.vwr-ask'), kids,
                vis:!!c.offsetParent, w:Math.round(b.width), right:Math.round(b.right), open:!!(c.closest('details')||{open:true}).open,
                tone:getComputedStyle(c.querySelector('.vwr-state')).color}})()""")
    check('A7 card: drawn in the open block', bool(card) and card['vis'] and card['open'], card)
    if card:
        check('A7 card: "waits for you", not "running"', card['state'] == ('čeká na tebe' if cs else 'waits for you')
              and 'waits' in card['cls'], card)
        check('A7 card: says what to write, with the rule\'s number', 'u hlídání 12 povol výjezd z doku' in card['ask'], card['ask'])
        check('A7 card: the owner\'s own words first', 'Hlídej baterii: až bude nad 50 %, vyjeď z doku.' in card['said']
              and card['kids'].index('vwr-said') < card['kids'].index('vwr-sub vwr-main'), card)
        check('A7 card: how the agent reads it below', 'baterie (%) nad 50' in card['reads']
              and (('Agent tomu rozumí' if cs else 'The agent reads it as') in card['reads']), card['reads'])
        check('A7 card: inside the screen', card['right'] <= p.pg.viewport_size['width'] + 1, card)
        if shots:
            p.pg.evaluate("document.querySelector('.vwr-card').scrollIntoView({block: 'center'})")
            p.pg.wait_for_timeout(200)
            p.pg.screenshot(path=os.path.join(shots, label + '-a7-watch-card.png'))
    a7_watch(p, [a7_rules(owner_text='', last_blocked=dict(A7_NO_WORD, why='robot je v doku'))])
    plain = p.pg.evaluate("""(()=>{const c=document.querySelector('.vwr-card'); if(!c) return null;
        return {state:c.querySelector('.vwr-state').textContent, ask:!!c.querySelector('.vwr-ask'), said:!!c.querySelector('.vwr-said'),
                main:(c.querySelector('.vwr-main')||{}).textContent||''}})()""")
    check('A7 card without the owner\'s text and not waiting: as before', bool(plain) and not plain['ask'] and not plain['said']
          and 'baterie (%) nad 50' in plain['main'] and plain['state'] == ('běží' if cs else 'running'), plain)
    # T8 V-g/V-h in the browser: a rule that never fired says so in one phrase; hours with the language's decimal mark
    a7_watch(p, [a7_rules(needs_undock_word=False)])
    nf = p.wait(lambda: p.pg.evaluate("(()=>{const c=document.querySelector('.vwr-card');return c?c.textContent:''})()"), 4000) or ''
    check('V-h a rule that never fired: "%s", not "last fired never"' % ('zatím nezasáhlo' if cs else 'has not fired yet'),
          ('zatím nezasáhlo' if cs else 'has not fired yet') in nf and not re.search(r'naposled zatím ne|last fired never', nf), nf)
    a7_watch(p, [a7_rules(needs_undock_word=False, fired=1, last_fired=dt.datetime.now().timestamp() - 7200)])
    p.wait(lambda: re.search(r'2[.,]0 h', p.pg.evaluate("(()=>{const c=document.querySelector('.vwr-card');return c?c.textContent:''})()") or ''), 4000)
    fh = p.pg.evaluate("(()=>{const c=document.querySelector('.vwr-card');return c?c.textContent:''})()") or ''
    check('V-h a rule that fired two hours ago: "%s"' % ('naposled před 2,0 h' if cs else 'last fired 2.0 h ago'),
          ('naposled před 2,0 h' if cs else 'last fired 2.0 h ago') in fh, fh)
    a7_watch(p, [a7_rules(last_blocked=A7_NO_WORD)])
    p.pg.evaluate("VAgent.close()")
    p.pg.wait_for_timeout(200)
    p.open('now')       # back to Autonomy
    check('A7 back in Autonomy', p.wait(lambda: vis('#auto_checks')), p.pg.evaluate("window.map_menu&&map_menu.current_submenu"))
    p.pg.wait_for_timeout(300)

    # 4 no › where nothing can be done
    rows = p.pg.evaluate("""[...document.querySelectorAll('#auto_checks .vt-auto-check')].map(r=>[r.textContent, !!r.querySelector('.vt-auto-go')])""")
    bootrow = [r for r in rows if ('Právě nastartoval' if cs else 'Just started') in r[0]]
    rainrow = [r for r in rows if r[1] and r not in bootrow]
    check('A7 just booted: the line has no ›', len(bootrow) == 1 and not bootrow[0][1], rows)
    check('A7 … the other holds keep theirs', len(rainrow) >= 2, rows)

    # 5 the owner's own choice is not amber
    tone = lambda: p.pg.evaluate("""(()=>{const e=document.getElementById('auto_plan_state'), m=document.createElement('span');
        m.style.color='var(--vt-muted)'; e.appendChild(m); const mc=getComputedStyle(m).color; m.remove();
        m.style.color='var(--vt-warn)'; e.appendChild(m); const wc=getComputedStyle(m).color; m.remove();
        return {state:e.dataset.state||'', color:getComputedStyle(e).color, muted:mc, warn:wc, text:e.textContent}})()""")
    tn = tone()
    check('A7 Plan: a switched-off calendar is said plainly (not amber)', tn['state'] == 'off' and tn['color'] == tn['muted']
          and 'Bigger 23:15' in tn['text'], tn)
    p.pub('/scheduler/settings', dict(agent_settings(), values=dict(agent_settings()['values'], no_mow_until=now.strftime('%Y-%m-%d'))))
    p.wait(lambda: tone()['state'] == '')      # the settings repaint in their own time on a loaded machine
    tn = tone()
    check('A7 … a no-mow day keeps the amber', tn['state'] == '' and tn['color'] == tn['warn'], tn)
    p.pub('/scheduler/settings', agent_settings())

    # 6 where the sleep timing is set: once
    p.open('advanced')
    lim = p.text('#auto_limits') or ''
    check('A7 sleep timing: the place is said once, not under every row', lim.count('master_controller.yaml') == 1
          and p.pg.evaluate("document.querySelectorAll('#auto_limits .vt-auto-limit small').length") == 1, lim)
    check('A7 … the hardware limit keeps its own note, every value stays', p.pg.evaluate("VTI18n.t('auto.limits.where.hw')") in lim
          and p.pg.evaluate("document.querySelectorAll('#auto_limits .vt-auto-limit-v').length") == 8, lim)

    # 7 an old agent decision while the calendar decides
    old = {'t': iso(now - dt.timedelta(days=8)) + ':00', 'kind': 'advice', 'code': 'skip', 'program': '', 'source': 'agent',
           'vars': {'until': iso(now - dt.timedelta(hours=25)) + ':00', 'reason': 'zima: 2.3 °C (pod 5 °C)'}}
    p.pub('/scheduler/mode', mode_view('calendar', last_decision=old))
    p.open('mode')
    check('A7 calendar decides: an agent decision over for more than a day is not shown', not vis('#auto_mode_last'), p.text('#auto_mode_last'))
    recent = dict(old, vars=dict(old['vars'], until=iso(now - dt.timedelta(hours=23)) + ':00'))
    p.pub('/scheduler/mode', mode_view('calendar', last_decision=recent))
    check('A7 … one over for less than a day still is (muted)', vis('#auto_mode_last')
          and p.pg.evaluate("document.getElementById('auto_mode_last').dataset.past") == '1', p.text('#auto_mode_last'))
    p.pub('/scheduler/mode', mode_view('agent', last_decision=old, dock_permitted=True))
    check('A7 … and while the agent decides its last decision stays', vis('#auto_mode_last'), p.text('#auto_mode_last'))
    # 8 the silent mower board: how long NOW, what to do, the way to Hardware reset
    since = now - dt.timedelta(minutes=33)
    issue = {'code': 'mower_link_idle', 'level': 'error', 'program': '', 't': iso(since + dt.timedelta(minutes=2)),
             'detail': {'in_dock': True, 'repeat': 0, 'silent_s': 151, 'since': iso(since)}}
    link = {'banner': 'silent', 'state': 'silent', 'silent_s': 33 * 60 + 5, 'status': 'OFF', 'rpm': 0, 'bat_out': False,
            'mission': {'armed': False, 'failed': False, 'phase': None, 'recoveries': 0, 'why': None}}
    p.pub('/mower/link', dict(link, banner='recovering', state='recovering', silent_s=0))
    p.pub('/scheduler/report', dict(boot, issues=[issue]))
    al = p.wait_text('#auto_alert', since.strftime('%H:%M'))
    check('A7 board silent, the link not saying so: the time of the report (3 min), since when', re.search(r'\b3\s*min', al or '')
          and since.strftime('%H:%M') in al, al)
    p.pub('/mower/link', link)
    p.wait(lambda: re.search(r'\b3[34]\s*min', p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    check('A7 … still silent: the time runs with the link (33 min, not the frozen 3)', re.search(r'\b3[34]\s*min', al or '')
          and not re.search(r'\b3\s*min', al or ''), al)
    check('A7 … and says what to do', ('Pomůže vypnout a zapnout robota' if cs else 'Switching the robot off and on helps') in (al or ''), al)
    cal = p.text('#div_scheduler_issues') or ''
    check('A7 … the calendar card says the same time', re.search(r'\b3[34]\s*min', cal), cal)
    n1 = len(p.pg.evaluate('__fake.sent'))
    p.click('#btn_auto_alert_hw')
    p.pg.wait_for_timeout(400)
    check('A7 Hardware reset ›: opens Sleep at the block, sends nothing', p.pg.evaluate("document.getElementById('auto_sec_sleep').open")
          and vis('#auto_hw') and len(p.pg.evaluate('__fake.sent')) == n1, p.pg.evaluate('__fake.sent.slice(-2)'))
    if shots:
        p.pg.evaluate("document.getElementById('card_calendar').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(200)
        p.pg.screenshot(path=os.path.join(shots, label + '-a7-silent.png'))
    fit = p.pg.evaluate("""(()=>{const b=document.getElementById('auto_alert'), r=b.getBoundingClientRect();
        const cut=[...b.querySelectorAll('*')].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>e.className);
        return {right:Math.round(r.right), cut, btn:Math.round(document.getElementById('btn_auto_alert_hw').getBoundingClientRect().height),
                txt:Math.round(b.querySelector('.vt-attn-txt').getBoundingClientRect().width)}})()""")
    check('A7 … the notice fits: inside the screen, nothing cut', fit['right'] <= p.pg.viewport_size['width'] + 1 and not fit['cut'], fit)
    check('A7 … its sentence keeps a readable width beside the two links (>= 180 px)', fit['txt'] >= 180, fit)
    # A8: the link's own count starts again with its node: still the time since it began
    # A9: "since" has no zone: counted from it only once the robot's clock is known from its log
    p.pg.evaluate("delete VTAutonomy._state.clockShift")
    p.pub('/mower/link', dict(link, silent_s=40))
    p.wait(lambda: re.search(r'\b3\s*min', p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    check('A9 the link counting from its restart, the clocks not compared yet: the report\'s 3 min, no guess', re.search(r'\b3\s*min', al or ''), al)
    ep = dt.datetime.now()
    p.pub('/status_logger/history', [{'seq': 7, 't': ep.timestamp(), 'iso': ep.strftime('%Y-%m-%dT%H:%M:%S'), 'msg': 'Executing goal.'}])
    p.wait(lambda: re.search(r'\b3[34]\s*min', p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    check('A8 the link counting from its restart: still 33 min since it began', re.search(r'\b3[34]\s*min', al or ''), al)
    check('A9 … the clock came from one line of the robot\'s log (same zone: 0)', p.pg.evaluate("VTAutonomy._state.clockShift") == 0)
    # A9: a phone two hours behind the robot reads "since" two hours late: still 33 min
    p.pg.evaluate("VTAutonomy._state.clockShift = 2 * 3600e3")
    ahead = dict(issue, detail=dict(issue['detail'], since=iso(since + dt.timedelta(hours=2)), silent_s=152))
    p.pub('/scheduler/report', dict(boot, issues=[ahead]))
    p.wait(lambda: re.search(r'\b3[34]\s*min', p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    check('A9 … the robot two hours ahead of this phone: 33 min, not hours off', re.search(r'\b3[34]\s*min', al or '') and not re.search(r'\d\s*h\b', al or ''), al)
    p.pg.evaluate("VTAutonomy._state.clockShift = 0")
    wrong = dict(issue, detail=dict(issue['detail'], since=iso(since + dt.timedelta(hours=2)), silent_s=153))
    p.pub('/scheduler/report', dict(boot, issues=[wrong]))
    p.wait(lambda: re.search(r'\b3\s*min', p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    check('A9 … a "since" later than now is not counted from: the report\'s 3 min', re.search(r'\b3\s*min', al or ''), al)
    nosince = dict(issue, detail={'in_dock': True, 'repeat': 0, 'silent_s': 151})
    p.pub('/scheduler/report', dict(boot, issues=[nosince]))
    p.wait(lambda: '{' not in (p.text('#auto_alert') or '{') and since.strftime('%H:%M') not in (p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    check('A9 no "since" at all: a whole sentence, no {at}, no empty brackets', re.search(r'\b3\s*min', al or '') and not re.search(r'\{|\(\s*[;)]', al or ''), al)
    p.pub('/scheduler/report', dict(boot, issues=[issue]))
    p.wait(lambda: re.search(r'\b3[34]\s*min', p.text('#auto_alert') or ''))
    # A8: off the dock the Hardware reset block refuses: no link to it, the advice stays
    p.pub('/scheduler/report', dict(boot, issues=[dict(issue, detail=dict(issue['detail'], in_dock=False))]))
    al = p.wait_text('#auto_alert', 'nebude sekat' if cs else 'will not mow')
    check('A8 off the dock: no Hardware reset ›, the advice stays', not p.pg.evaluate("!!document.getElementById('btn_auto_alert_hw')")
          and ('Pomůže vypnout a zapnout robota' if cs else 'Switching the robot off and on helps') in (al or ''), al)
    p.pub('/scheduler/report', dict(boot, issues=[issue]))
    p.wait(lambda: p.pg.evaluate("!!document.getElementById('btn_auto_alert_hw')"))
    # A8: the board answers again, the issue still listed: grey, in the past, nothing to do
    p.pub('/mower/link', dict(link, banner='', state='ok', silent_s=0))
    al = p.wait_text('#auto_alert', 'už odpovídá' if cs else 'answers again')
    over = p.pg.evaluate("""(()=>{const b=document.getElementById('auto_alert');
        return {state:b.dataset.state, hw:!!document.getElementById('btn_auto_alert_hw'), lab:b.querySelector('.vt-attn-lab').textContent,
                hist:b.querySelectorAll('.vt-auto-alert-go').length}})()""")
    check('A8 the board answers again: "was silent since HH:MM, answers again"', (('mlčela od ' if cs else 'was silent since ') + since.strftime('%H:%M')) in (al or '')
          and not re.search(r'neodpovídá|has not answered|\d\s*min|vypnout a zapnout|off and on', al or ''), al)
    check('A8 … grey, labelled as over, no Hardware reset ›, History stays (A11: and Clear beside it)', over['state'] == 'off' and not over['hw']
          and over['hist'] == 2 and over['lab'] == ('Vyřešeno' if cs else 'Over'), over)
    cal = p.wait_text('#div_scheduler_issues', 'už odpovídá' if cs else 'answers again')
    check('A8 … the calendar card says the same', ('už odpovídá' if cs else 'answers again') in (cal or ''), cal)
    # A11 (seen live 2026-11-17): what is over lights nothing; from when to when and how long; put away here
    rp = p.pg.evaluate("(()=>{const c=document.querySelector('.rp-auto-chip');return c?[c.textContent,c.dataset.state]:null})()")
    check('A11 over: the right panel does not say "Attention" in red', bool(rp) and rp[1] != 'err' and rp[0] != p.pg.evaluate("VTI18n.t('auto.alert.label')"), rp)
    p.open('history')
    hh = p.pg.evaluate("[document.getElementById('auto_sec_history').dataset.state, document.getElementById('auto_tok_history').textContent]")
    check('A11 over: the History head is not red and counts nothing "to see"', hh[0] == 'off' and not re.search(r'k vidění|to see', hh[1]), hh)
    back_at = since + dt.timedelta(minutes=30)
    p.pub('/scheduler/journal', {'entries': [
        {'t': iso(since + dt.timedelta(minutes=2)) + ':41', 'kind': 'waited', 'code': 'mower_link_idle', 'program': '', 'vars': dict(issue['detail'])},
        {'t': iso(back_at) + ':09', 'kind': 'waited', 'code': 'mower_link_back', 'program': '', 'vars': {}}]})
    want = ('od %s do %s (30 min)' if cs else 'from %s to %s (30 min)') % (since.strftime('%H:%M'), back_at.strftime('%H:%M'))
    norm = lambda sel: (p.text(sel) or '').replace('\xa0', ' ')
    p.wait(lambda: want in norm('#auto_alert'))
    al = norm('#auto_alert')
    check('A11 over: from when to when and how long, one sentence', want in al and ('už odpovídá' if cs else 'answers again') in al, al)
    check('A692 … the length does not break apart (no-break space)', '30\xa0min' in (p.text('#auto_alert') or ''), repr(p.text('#auto_alert')))
    p.wait(lambda: '30 min' in norm('#auto_journal'))
    jl = norm('#auto_journal')
    check('A11 History: the return says how long the board was silent', ('se zase ozvala (mlčela 30 min)' if cs else 'answers again (it was silent for 30 min)') in jl, jl[:200])
    fn = p.pg.evaluate("(()=>{const b=[...document.querySelectorAll('.vt-auto-fbtn')].find(x=>x.dataset.f==='problems'), n=b&&b.querySelector('.vt-auto-fn'); return n?[n.hidden, n.textContent]:null})()")
    check('A692 History: a silence with its return is not counted on the Problems filter', bool(fn) and (fn[0] or fn[1] in ('', '0')), fn)
    calc = p.pg.evaluate("(()=>{const e=document.querySelector('#div_scheduler_issues .vt-cal-issue'), m=document.createElement('span'); if(!e) return null; m.style.color='var(--vt-muted)'; e.appendChild(m); const mc=getComputedStyle(m).color; m.remove(); return [e.className, getComputedStyle(e).color, mc]})()")
    check('A692 the calendar card says what is over in the quiet tone', bool(calc) and 'vt-cal-issue-over' in calc[0] and calc[1] == calc[2], calc)
    row = p.pg.evaluate("""(()=>{const b=document.getElementById('auto_alert'); const g=[...b.querySelectorAll('.vt-auto-alert-go')].map(e=>Math.round(e.getBoundingClientRect().top));
        return {tops:g, txt:Math.round(b.querySelector('.vt-attn-txt').getBoundingClientRect().width), right:Math.round(b.getBoundingClientRect().right)}})()""")
    check('A692 History and Clear stand together on one line, the sentence keeps its width', len(set(row['tops'])) == 1 and row['txt'] >= 180
          and row['right'] <= p.pg.viewport_size['width'] + 1, row)
    # A692: a live fault listed BEFORE the one that is over: the box is the live one's (label, text, red)
    live_first = [{'code': 'run_failed', 'level': 'error', 'program': 'Bigger', 't': iso(now), 'detail': {'reason': 'critical'}}, issue]
    p.pub('/scheduler/report', dict(boot, issues=live_first))
    p.wait(lambda: 'Bigger' in (p.text('#auto_alert') or ''))
    mix = p.pg.evaluate("(()=>{const b=document.getElementById('auto_alert');return {state:b.dataset.state, lab:b.querySelector('.vt-attn-lab').textContent, text:b.querySelector('.vt-attn-txt').textContent, clr:!!document.getElementById('btn_auto_alert_clear')}})()")
    check('A692 a live fault + one that is over: the box carries the live one (label, text, red), no Clear', mix['state'] == 'err' and 'Bigger' in mix['text']
          and mix['lab'] == p.pg.evaluate("VTI18n.t('auto.alert.label')") and not mix['clr'], mix)
    # A692: the first silence is over (its return is in the journal), a second one lasts: one "to see", not two
    second = dict(issue, t=iso(now), detail=dict(issue['detail'], since=iso(now - dt.timedelta(minutes=2)), silent_s=120))
    p.pub('/mower/link', dict(link, silent_s=120))
    p.pub('/scheduler/report', dict(boot, issues=[issue, second]))
    p.wait(lambda: re.search(r'[12] (k vidění|to see)', p.text('#auto_tok_history') or ''))
    hh = p.text('#auto_tok_history') or ''
    check('A692 an old silence that ended + one that lasts: the History head counts one', re.search(r'\b1 (k vidění|to see)', hh), hh)
    p.pub('/mower/link', dict(link, banner='', state='ok', silent_s=0))
    p.pub('/scheduler/report', dict(boot, issues=[issue]))
    p.wait(lambda: want in norm('#auto_alert'))
    # A692: the page claims "answers again" only on what it knows: an "ok" that is minutes old, a lost robot
    p.pub('/scheduler/journal', {'entries': []})
    p.wait(lambda: ('už odpovídá' if cs else 'answers again') in norm('#auto_alert'))
    p.pg.evaluate("VTAutonomy._state.linkAt = Date.now() - 600e3")
    p.wait(lambda: p.pg.evaluate("document.getElementById('auto_alert').dataset.state") != 'off', 6000)
    old = p.pg.evaluate("(()=>{const b=document.getElementById('auto_alert'), c=document.querySelector('.rp-auto-chip');return {state:b.dataset.state, lab:b.querySelector('.vt-attn-lab').textContent, text:b.querySelector('.vt-attn-txt').textContent, clr:!!document.getElementById('btn_auto_alert_clear'), chip:c&&c.dataset.state, hist:document.getElementById('auto_sec_history').dataset.state}})()")
    check('A692 the last "ok" is 10 min old: not "answers again", not grey, no Clear; it says it has no fresh word', old['state'] == 'err'
          and not re.search(r'už odpovídá|answers again', old['text']) and not old['clr'] and p.pg.evaluate("VTI18n.t('auto.a11.link_unknown')") in old['text']
          and old['lab'] == p.pg.evaluate("VTI18n.t('auto.alert.label')"), old)
    check('A692 … the right panel\'s chip and the History head are lit again', old['chip'] == 'err' and old['hist'] == 'err', old)
    p.pub('/mower/link', dict(link, banner='', state='ok', silent_s=0))
    p.wait(lambda: p.pg.evaluate("document.getElementById('auto_alert').dataset.state") == 'off')
    p.pg.evaluate("document.dispatchEvent(new Event('rosdisconnected'))")
    p.pg.wait_for_timeout(400)
    gone = p.pg.evaluate("(()=>{const b=document.getElementById('auto_alert');return {state:b.dataset.state, text:b.querySelector('.vt-attn-txt').textContent, clr:!!document.getElementById('btn_auto_alert_clear')}})()")
    check('A692 the page lost the robot: at once not "answers again", no Clear', gone['state'] == 'err' and not re.search(r'už odpovídá|answers again', gone['text']) and not gone['clr'], gone)
    p.pg.evaluate("document.dispatchEvent(new Event('rosconnected'))")
    p.pub('/mower/link', dict(link, banner='', state='ok', silent_s=0))
    p.wait(lambda: p.pg.evaluate("document.getElementById('auto_alert').dataset.state") == 'off')
    p.pub('/scheduler/journal', {'entries': [
        {'t': iso(since + dt.timedelta(minutes=2)) + ':41', 'kind': 'waited', 'code': 'mower_link_idle', 'program': '', 'vars': dict(issue['detail'])},
        {'t': iso(back_at) + ':09', 'kind': 'waited', 'code': 'mower_link_back', 'program': '', 'vars': {}}]})
    p.wait(lambda: want in norm('#auto_alert'))
    clr = p.pg.evaluate("""(()=>{const cm=window.calendarManager, b=document.getElementById('btn_auto_alert_clear'); if(!b) return null;
        const real=cm.clearIssuesPub.publish; let n=0; cm.clearIssuesPub.publish=function(){n++}; b.click(); cm.clearIssuesPub.publish=real;
        return {n, text:b.textContent, h:Math.round(b.getBoundingClientRect().height)}})()""")
    check('A11 over: Clear right in the notice asks the robot to clear its issues (once, on the tap)', bool(clr) and clr['n'] == 1
          and clr['text'] == p.pg.evaluate("VTI18n.t('calmgr.issues_clear')"), clr)
    if shots:
        p.pg.evaluate("document.getElementById('card_calendar').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(200)
        p.pg.screenshot(path=os.path.join(shots, label + '-a8-back.png'))
    # A12 (check A698): the old notice has its return in History and the board goes silent AGAIN; the robot
    # lists the new silence only after 2-3 min. The box must show the live fault at once: red, in the present,
    # the board's own count, no "answers again", no Clear; the chip and the History head with it
    p.pub('/mower/link', dict(link, silent_s=40))
    p.wait(lambda: p.pg.evaluate("document.getElementById('auto_alert').dataset.state") != 'off', 4000)
    again = p.pg.evaluate("""(()=>{const b=document.getElementById('auto_alert'), c=document.querySelector('.rp-auto-chip'), k=document.querySelector('#div_scheduler_issues .vt-cal-issue');
        return {state:b.dataset.state, lab:b.querySelector('.vt-attn-lab').textContent, text:b.querySelector('.vt-attn-txt').textContent.replace(/\u00a0/g,' '),
                clr:!!document.getElementById('btn_auto_alert_clear'), chip:c&&c.dataset.state, hist:document.getElementById('auto_sec_history').dataset.state,
                hw:!!document.getElementById('btn_auto_alert_hw'), cal:k?[k.className, k.textContent.replace(/\u00a0/g,' ')]:null}})()""")
    check('V-i silent again in the dock: the way to Hardware reset is there at once (the board is silent now)', again['hw'], again)
    check('A12 silent again with the return in History: the box is the live fault at once (red, "again", the board\'s 40 s), no "answers again", no Clear',
          again['state'] == 'err' and again['lab'] == p.pg.evaluate("VTI18n.t('auto.alert.label')") and not again['clr']
          and re.search(r'(znovu neodpovídá|answering again) \([45]\d s\)', again['text'])
          and not re.search(r'už odpovídá|answers again|mlčela|was silent|\{', again['text']), again)
    check('A12 … the right panel\'s chip and the History head are red, the calendar card says the same sentence, not in the quiet tone',
          again['chip'] == 'err' and again['hist'] == 'err' and bool(again['cal']) and 'vt-cal-issue-over' not in again['cal'][0]
          and re.search(r'znovu neodpovídá|answering again', again['cal'][1]), again)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-a12-again.png'))
    # V-h (check A727): the same while the robot restores the board during a mission, or gave up (recovering / failed):
    # the box says the live state, red / amber, no "answers again", no Clear, no Hardware reset link
    for st_, word in (('recovering', 'obnovuje' if cs else 'restoring'), ('failed', 'domů' if cs else 'home')):
        p.pub('/mower/link', dict(link, banner=st_, state='silent' if st_ == 'failed' else st_, silent_s=0))
        p.wait(lambda: word in (p.text('#auto_alert') or ''), 4000)
        rf = p.pg.evaluate("""(()=>{const b=document.getElementById('auto_alert'), c=document.querySelector('.rp-auto-chip');
            return {state:b.dataset.state, lab:b.querySelector('.vt-attn-lab').textContent, text:b.querySelector('.vt-attn-txt').textContent.replace(/\u00a0/g,' '),
                    clr:!!document.getElementById('btn_auto_alert_clear'), hw:!!document.getElementById('btn_auto_alert_hw'), chip:c&&c.dataset.state,
                    hist:document.getElementById('auto_sec_history').dataset.state}})()""")
        check('V-h the link says "%s" with the old notice\'s return in History: the box is the live state, no "answers again", no Clear, no Hardware reset' % st_,
              rf['state'] == 'err' and word in rf['text'] and re.search(r'znovu|again', rf['text']) and not rf['clr'] and not rf['hw']
              and rf['lab'] == p.pg.evaluate("VTI18n.t('auto.alert.label')") and not re.search(r'už odpovídá|answers again|mlčela|was silent|\{', rf['text'])
              and rf['chip'] in ('warn', 'err') and rf['hist'] == 'err', rf)
    # … and once the robot lists the new silence, that one carries the fault; the old one is over again (one "to see")
    newer = dict(issue, t=iso(now), detail=dict(issue['detail'], since=iso(now - dt.timedelta(minutes=2)), silent_s=120))
    p.pub('/mower/link', dict(link, silent_s=125))
    p.pub('/scheduler/report', dict(boot, issues=[issue, newer]))
    p.wait(lambda: re.search(r'\b1 (k vidění|to see)', p.text('#auto_tok_history') or ''), 4000)
    al2 = (p.text('#auto_alert') or '').replace('\xa0', ' ')
    check('A12 … the robot lists the new silence: the box says that one ("has not answered for 2 min"), History counts one',
          re.search(r'\b1 (k vidění|to see)', p.text('#auto_tok_history') or '') and re.search(r'\b[23] min', al2)
          and not re.search(r'znovu neodpovídá|answering again|už odpovídá|answers again', al2), [al2, p.text('#auto_tok_history')])
    p.pub('/mower/link', dict(link, banner='', state='ok', silent_s=0))
    p.pub('/scheduler/report', dict(boot, issues=[issue]))
    p.wait(lambda: want in norm('#auto_alert'))
    check('A12 … the board answers: grey and "answers again" back, Clear offered', p.pg.evaluate("document.getElementById('auto_alert').dataset.state") == 'off'
          and p.pg.evaluate("!!document.getElementById('btn_auto_alert_clear')"), norm('#auto_alert'))
    p.pub('/scheduler/journal', {'entries': []})
    p.pub('/mower/link', link)
    p.wait(lambda: re.search(r'\b3[34]\s*min', p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    rp = p.pg.evaluate("(()=>{const c=document.querySelector('.rp-auto-chip');return c?[c.textContent,c.dataset.state]:null})()")
    check('A11 silent again: no Clear in the notice, the right panel is red again', not p.pg.evaluate("!!document.getElementById('btn_auto_alert_clear')")
          and bool(rp) and rp[1] == 'err', rp)
    # A8 (seen live): the board's banner follows a language switch, not only the next change of the link
    p.lang('en' if cs else 'cs')
    other = [p.text('#auto_link'), p.pg.evaluate("VTI18n.t('auto.link.silent')")]
    p.lang('cs' if cs else 'en')
    back_ = [p.text('#auto_link'), p.pg.evaluate("VTI18n.t('auto.link.silent')")]
    check('A8 the silent-board banner follows the language', other[0] == other[1] and back_[0] == back_[1] and other[0] != back_[0], [other, back_])
    # A9 (T8): the notice over the map too (it stayed in the language it was said in)
    p.lang('en' if cs else 'cs')
    n_other = [p.line() or '', p.pg.evaluate("VTI18n.t('auto.link.silent')")]
    p.lang('cs' if cs else 'en')
    n_back = [p.line() or '', p.pg.evaluate("VTI18n.t('auto.link.silent')")]
    check('A9 the notice over the map follows the language', n_other[1] in n_other[0] and n_back[1] in n_back[0] and n_other[1] != n_back[1], [n_other, n_back])
    p.wait(lambda: re.search(r'\b3[34]\s*min', p.text('#auto_alert') or ''))
    al = p.text('#auto_alert')
    check('A8 … silent again: red and present again', re.search(r'\b3[34]\s*min', al or '')
          and p.pg.evaluate("document.getElementById('auto_alert').dataset.state") == 'err', al)
    p.pub('/mower/link', dict(link, banner='', state='ok', silent_s=0))
    p.pub('/scheduler/report', boot)
    # A8: the exact sentence comes from the agent (undock_word); without it the page composes it as before
    a7_watch(p, [a7_rules(needs_undock_word=True, undock_word='u hlídání 12 povol výjezd z doku TEST')])
    wt = p.pg.evaluate("""(()=>{const c=document.querySelector('.vwr-card .vwr-ask'), b=document.getElementById('btn_auto_ans_watch');
        return {ask:c?c.textContent:'', tip:b?b.title:''}})()""")
    check('A8 the permit sentence is the agent\'s own (card and chip tooltip)', 'u hlídání 12 povol výjezd z doku TEST' in wt['ask']
          and 'u hlídání 12 povol výjezd z doku TEST' in wt['tip'], wt)
    a7_watch(p, [a7_rules(needs_undock_word=True)])
    wt = p.pg.evaluate("(()=>{const c=document.querySelector('.vwr-card .vwr-ask');return c?c.textContent:''})()")
    check('A8 … an older agent without it: composed as before', 'u hlídání 12 povol výjezd z doku' in wt and 'TEST' not in wt, wt)
    a7_watch(p, [a7_rules(last_blocked=A7_NO_WORD)])
    p.pub('/scheduler/mode', mode_view('calendar'))
    check('A7 nothing published by the whole story', len(p.pg.evaluate('__fake.sent')) == n0, p.pg.evaluate('__fake.sent.slice(-3)'))
    errs = [e for e in p.errors if 'erases' not in e]
    check('A7 no page errors', not errs, errs[:3])


def a7_fit(p, shots, label):
    """The watch chip beside the two answers and the timing note on this screen: touch size, nothing cut, no sideways scroll."""
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/calendar', [dict(A2_CAL[0], enabled=False)])
    p.pub('/scheduler/report', report(now, code='boot_grace', next=None, detail={'left_s': 173},
                                      sentence={'code': 'boot_grace', 'vars': {'left_s': 173}},
                                      checks=start_checks(mission=('wait', 'boot_grace', {'left_s': 173}), programs=('off', 'no_schedule', {}))))
    a7_watch(p, [a7_rules(last_blocked=A7_NO_WORD)])
    for o in ('now', 'plan', 'advanced'):
        p.open(o)
    vw = p.pg.viewport_size['width']
    r = p.pg.evaluate("""()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
        const out=q('#div_menu_autonomy *').filter(e=>{const b=e.getBoundingClientRect();return b.width&&(b.right>innerWidth+1||b.left<-1)}).map(e=>e.id||e.className);
        const over=q('#card_calendar *, #auto_limits *, #auto_plan_state').filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible').map(e=>e.id||e.className);
        const b=document.getElementById('btn_auto_ans_watch').getBoundingClientRect(), m=document.getElementById('btn_auto_ans_mode').getBoundingClientRect();
        return {w:document.documentElement.scrollWidth, coarse:matchMedia('(pointer: coarse)').matches, out, over,
                h:Math.round(b.height), mh:Math.round(m.height), bw:Math.round(b.width), vis:!!document.getElementById('btn_auto_ans_watch').offsetParent}}""")
    # A8: a switch keeps its look and takes a finger: a tap 9 px above or below its edge still hits it
    sw = p.pg.evaluate("""()=>{const out=[]; for (const e of document.querySelectorAll('#div_menu_autonomy input.form-check-input[type=checkbox]')) {
        if(!e.offsetParent||(e.checkVisibility&&!e.checkVisibility())) continue;   // not in a folded section
        e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(), x=b.left+b.width/2;
        const hit=(y)=>{const h=document.elementFromPoint(x,y); return h===e||(!!h&&h.tagName==='LABEL'&&(h.control===e||h.contains(e)))};
        out.push([e.id||e.className, Math.round(b.width), Math.round(b.height), hit(b.top-9), hit(b.bottom+9), hit(b.top+b.height/2)]);}
        return out}""")
    check(label + ' A8: the switches look as before (44×24)', len(sw) >= 4 and all(x[1] == 44 and x[2] == 24 for x in sw), [x for x in sw if x[1:3] != [44, 24]] or len(sw))
    if r['coarse']:
        check(label + ' A8: on touch each takes a finger 44 px high (a tap 9 px over its edge toggles it)', all(x[3] and x[4] and x[5] for x in sw),
              [x for x in sw if not (x[3] and x[4] and x[5])])
    floor = 40 if r['coarse'] else 36
    check(label + ' A7: no sideways scroll', r['w'] <= vw + 1 and not r['out'], r['out'])
    check(label + ' A7: top card, timing list, Plan line: nothing cut', not r['over'], r['over'])
    check(label + ' A7: the watch chip >= %d px, as high as the other answers' % floor, r['vis'] and r['h'] >= floor and r['bw'] > 0, r)
    if shots:
        p.pg.evaluate("document.getElementById('card_calendar').scrollIntoView({block: 'start'})")
        p.pg.wait_for_timeout(200)
        p.pg.screenshot(path=os.path.join(shots, label + '-a7-top.png'))
        p.pg.evaluate("document.getElementById('auto_limits').scrollIntoView({block: 'center'})")
        p.pg.wait_for_timeout(200)
        p.pg.screenshot(path=os.path.join(shots, label + '-a7-limits.png'))
    a7_watch(p, [])
    p.pub('/scheduler/calendar', A2_CAL)


LANG_SWEEP_JS = r"""(from)=>{
  const D=window.VT_I18N_DICT, A=D[from], B=D[from==='en'?'cs':'en'];
  const other=new Set(Object.values(B).map(v=>String(v).trim()));
  const only=new Map();
  for (const k in A) { const v=String(A[k]).trim();
    if (v.length<4 || /\{\w+\}/.test(v) || !(k in B) || String(B[k]).trim()===v || other.has(v) || !/[A-Za-zÀ-ž]{3}/.test(v)) continue;
    if (!only.has(v)) only.set(v,k); }
  const out=[], seen=new Set();
  const where=(e)=>{const p=[]; for(let x=e; x&&x!==document.body&&p.length<4; x=x.parentElement){p.push(x.id?('#'+x.id):(x.tagName.toLowerCase()+(x.className&&typeof x.className==='string'?'.'+x.className.trim().split(/\s+/)[0]:'')));} return p.reverse().join(' > ')};
  /* a box put away with the hidden attribute is painted again when it is shown (its old text is not on the page);
     #span_menu_program_status is the robot's own state word (/mower_smach/status), shown as sent */
  const skip=(e)=>!!(e.closest&&(e.closest('[hidden]')||e.closest('#span_menu_program_status')));
  const hit=(txt,e,how)=>{const v=String(txt||'').trim(); if(!only.has(v)||skip(e)) return; const sig=how+'|'+v+'|'+where(e); if(seen.has(sig)) return; seen.add(sig); out.push([only.get(v), v.slice(0,60), how, where(e)]);};
  const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n=w.nextNode(); n; n=w.nextNode()) { const e=n.parentElement; if(!e||/^(SCRIPT|STYLE|TEMPLATE)$/.test(e.tagName)) continue; hit(n.nodeValue,e,'text'); }
  for (const e of document.body.querySelectorAll('[title],[aria-label],[placeholder]')) { for (const a of ['title','aria-label','placeholder']) { if(e.hasAttribute(a)) hit(e.getAttribute(a),e,a); } }
  return out; }"""


def lang_sweep(p, shots, label):
    """V-f: after a language switch nothing on the page stays in the language it was built in. Every text node,
    title, aria-label and placeholder that equals an i18n value of the OLD language (one that reads differently in
    the new one) is a text composed once that does not follow the language. Both directions."""
    cs = label.endswith('cs')
    now = dt.datetime.now().replace(second=0, microsecond=0)
    here, there = ('cs', 'en') if cs else ('en', 'cs')
    p.pub('/scheduler/settings', agent_settings())
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.pub('/scheduler/calendar', A2_CAL)
    p.pub('/scheduler/report', report(now, checks=start_checks(), sleep={'checks': checks(ssh=('block', 'logins', {'who': ['pts/0']})), 'block': 'login:pts/0'}))
    p.pub('/scheduler/journal', {'entries': a3_journal(now)})
    p.pub('/mower/link', {'banner': 'silent', 'state': 'silent', 'silent_s': 300, 'status': 'OFF', 'rpm': 0, 'bat_out': False,
                          'mission': {'armed': False, 'failed': False, 'phase': None, 'recoveries': 0, 'why': None}})
    for o in ('now', 'plan', 'mode', 'rain', 'battery', 'sleep', 'recovery', 'history', 'advanced'):
        p.open(o)
    # the link down: its sticky notice (map_view.js ConnStatus) is on the page while the language changes
    p.pg.evaluate("document.dispatchEvent(new Event('rosdisconnected'))")
    p.pg.wait_for_timeout(3500)
    p.lang(here)
    p.pg.wait_for_timeout(600)
    p.lang(there)
    p.pg.wait_for_timeout(1500)
    left = p.pg.evaluate(LANG_SWEEP_JS, here)
    if shots and left:
        json.dump(left, open(os.path.join(shots, label + '-lang-left.json'), 'w'), ensure_ascii=False, indent=0)
    check(label + ' V-f: after %s → %s nothing stays in %s' % (here, there, here), not left, left[:12])
    p.lang(here)
    p.pg.wait_for_timeout(1500)
    back = p.pg.evaluate(LANG_SWEEP_JS, there)
    if shots and back:
        json.dump(back, open(os.path.join(shots, label + '-lang-back.json'), 'w'), ensure_ascii=False, indent=0)
    check(label + ' V-f: … and back (%s → %s) nothing stays in %s' % (there, here, there), not back, back[:12])
    p.pg.evaluate("document.dispatchEvent(new Event('rosconnected'))")
    p.pub('/mower/link', {'banner': '', 'state': 'ok', 'silent_s': 0})
    return left, back


def agent_slot(p, label):
    """T8 dávka IV: the agent's pills (a dock pill, a finding, a STOP latch) beside a LONG notice: inside
    their slot, never over the right panel or its handle, the notice and the compass rose not under them,
    the STOP latch readable (not "STO…")."""
    bp = p.pg.evaluate("""async ()=>{const u=document.getElementById('vagent_unlocked'), st=document.getElementById('vagent_strip'), pa=document.getElementById('vagent_panic'), b=document.getElementById('vagent_bars');
        const ln=document.getElementById('span_status_info');
        if(!u||!st||!ln) return null;
        const was=[u.innerHTML,u.style.display,st.innerHTML,st.className,st.style.display,pa&&pa.innerHTML,pa&&pa.style.display,ln.textContent];
        u.innerHTML='<span class="vs-lab">DOCK OPEN</span><span class="vs-txt">until 09:00 · 8:20:24</span><button type="button" class="vs-btn">Lock again</button>'; u.style.display='';
        st.innerHTML='<span class="vs-lab">Finding</span><span class="vs-txt">16 to read</span>'; st.className='va-finding'; st.style.display='';
        if(pa){pa.innerHTML='<span class="vs-txt">STOP IS LATCHED by robert — the agent will not act until you release it.</span><button type="button" class="vs-btn">Release STOP</button>'; pa.style.display='';}
        const tn=[...ln.childNodes].find(n=>n.nodeType===3); if(tn){tn.textContent='No connection to the robot · reconnecting… ';} else {ln.insertBefore(document.createTextNode('No connection to the robot · reconnecting… '),ln.firstChild);}
        window.dispatchEvent(new Event('resize')); await new Promise(r=>setTimeout(r,600));
        const R=e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom].map(Math.round)};
        const rp=document.getElementById('right_panel'), ro=document.getElementById('vt_utm_rose'), hd=document.getElementById('rp_handle');
        const vis=e=>!!(e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).display!=='none');
        const pt=pa&&pa.querySelector('.vs-txt');
        const o={bars:R(b), u:R(u), st:R(st), pa:pa?R(pa):null, btn:R(u.querySelector('.vs-btn')), rp:vis(rp)?R(rp):null, hd:vis(hd)?R(hd):null,
                 rose:vis(ro)?R(ro):null, line:vis(ln)?R(ln):null, paCut:pt?(pt.scrollHeight<=pt.clientHeight+1&&pt.scrollWidth>pt.clientWidth+1):false,
                 paW:pt?Math.round(pt.getBoundingClientRect().width):0};
        [u.innerHTML,u.style.display,st.innerHTML,st.className,st.style.display]=was; if(pa){pa.innerHTML=was[5];pa.style.display=was[6];}
        if(tn){tn.textContent=was[7];}
        window.dispatchEvent(new Event('resize'));
        return o}""")
    if not bp:
        return
    ov = lambda a, c: bool(a and c and not (a[2] <= c[0] or a[0] >= c[2] or a[3] <= c[1] or a[1] >= c[3]))
    pills = [x for x in (bp['u'], bp['st'], bp['pa']) if x]
    check(label + ' the agent pills stay inside their slot (Lock again too)',
          all(x[2] <= bp['bars'][2] + 1 for x in pills + [bp['btn']]) and bp['btn'][2] <= bp['u'][2] + 1, bp)
    if bp['rp']:
        check(label + ' … never over the right panel or its handle', not any(ov(x, bp['rp']) or ov(x, bp['hd']) for x in pills), bp)
    if bp['line']:
        check(label + ' … and a long notice line is not under them', not any(ov(x, bp['line']) for x in pills), bp)
    if bp['pa']:
        check(label + ' … the STOP latch keeps its words (not cut to "STO…")', bp['paW'] >= 100, bp)
    if bp['rose']:
        check(label + ' … and the compass rose stands under them', bp['rose'][1] >= bp['bars'][3], bp)


def vh_dock_note(p, shots, label):
    """T8 V-h: while the calendar decides, Who decides says the dock in one sentence, from what the Agent panel read
    (the same as the bar over the map): locked / open until HH:MM / N of M exits left / scheduled; nothing unknown."""
    cs = label.endswith('cs')
    p.pub('/scheduler/mode', mode_view('calendar'))
    p.open('mode')
    def dock(v):
        p.pg.evaluate("""(v)=>{window.VAgent=window.VAgent||{}; const real=VAgent.dock||{}; window.__dockWas=window.__dockWas||VAgent.dock;
            VAgent.dock=Object.assign({}, real, {view:()=>v, hm:(s)=>{const d=new Date(s*1000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}});
            document.dispatchEvent(new CustomEvent('vagent:dock'))}""", v)
        p.pg.wait_for_timeout(250)
        return (p.text('#auto_mode_notes') or '').replace('\xa0', ' ')
    to = dt.datetime.now().replace(hour=23, minute=40, second=0, microsecond=0)
    hm = to.strftime('%H:%M')
    tx = dock({'kind': 'locked', 'active': None, 'next': None})
    check(label + ' V-h calendar decides, dock locked: one sentence says the agent will not drive out, calendar runs do not ask',
          ('Dok je zamčený: agent s robotem nevyjede' if cs else 'The dock is locked: the agent will not drive the robot out') in tx
          and ('z kalendáře se na dok neptají' if cs else 'Calendar runs do not ask') in tx, tx)
    tx = dock({'kind': 'open', 'active': {'to': to.timestamp(), 'exits': 0, 'max_exits': 0}, 'next': None})
    check(label + ' V-h … open until HH:MM', (('Dok je povolený do %s:' if cs else 'The dock is open until %s:') % hm) in tx and '{' not in tx, tx)
    tx = dock({'kind': 'ending', 'active': {'to': to.timestamp(), 'exits': 1, 'max_exits': 3}, 'next': None})
    check(label + ' V-h … with the exits left (2 of 3)', (('do %s, zbývá 2 z 3 výjezdů' if cs else 'until %s, 2 of 3 exits left') % hm) in tx, tx)
    fit = p.pg.evaluate("""(()=>{const n=document.getElementById('auto_mode_notes'), b=document.getElementById('btn_auto_mode_dock_note'); const r=n.getBoundingClientRect();
        return {cut:n.scrollWidth>n.clientWidth+1, right:Math.round(r.right), vw:innerWidth, link:!!b, hs:document.scrollingElement.scrollWidth>innerWidth+1}})()""")
    check(label + ' V-h … the sentence wraps inside the panel, the way to the dock permit is there, no sideways scroll',
          not fit['cut'] and fit['right'] <= fit['vw'] + 1 and fit['link'] and not fit['hs'], fit)
    if shots:
        p.pg.evaluate("document.getElementById('auto_mode_notes').scrollIntoView({block:'center'})")
        p.pg.wait_for_timeout(150)
        p.pg.screenshot(path=os.path.join(shots, label + '-vh-dock-note.png'))
    chip = p.pg.evaluate("(()=>{const b=document.getElementById('btn_auto_ans_dock');const r=b.getBoundingClientRect();return {vis:!b.hidden&&r.height>0,text:b.textContent,state:b.dataset.state||'',tip:b.title,h:Math.round(r.height),right:Math.round(r.right),vw:innerWidth}})()")
    check(label + ' V-h the top card carries the dock chip (open until, exits left), the sentence is its tooltip, inside the card',
          chip['vis'] and (('do %s · zbývá 2 z 3' if cs else 'until %s · 2 of 3') % hm) in chip['text'] and chip['state'] == 'info'
          and ('zbývá 2 z 3 výjezdů' if cs else '2 of 3 exits left') in chip['tip'] and chip['right'] <= chip['vw'] and chip['h'] >= 32, chip)
    tx = dock({'kind': 'scheduled', 'active': None, 'next': {'from': to.timestamp(), 'to': to.timestamp() + 600}})
    check(label + ' V-h … locked with a window scheduled', (('naplánované od %s' if cs else 'scheduled from %s') % hm) in tx, tx)
    tx = dock({'kind': 'waiting_clock', 'active': None, 'next': None})
    wc = p.pg.evaluate("(()=>{const b=document.getElementById('btn_auto_ans_dock');return [b.hidden,b.textContent,b.dataset.state||'']})()")
    check(label + ' V-i … permitted, waiting for a GPS-checked time: said so, not "locked … until you allow it"',
          ('Dok je povolený, ale okno čeká na čas ověřený proti GPS' if cs else 'The dock is permitted, but its window waits for a GPS-checked time') in tx
          and not re.search(r'zamčený|nepovolíš|is locked|until you allow', tx) and not wc[0] and wc[2] == 'warn'
          and wc[1] == ('Dok povolený · čeká na čas z GPS' if cs else 'Dock permitted · waiting for GPS time'), [tx, wc])
    tx = dock({'kind': 'exits_used', 'active': None, 'next': None})
    check(label + ' V-h … exits used up', ('vyčerpané' if cs else 'used up') in tx, tx)
    tx = dock({'kind': 'unknown', 'active': None, 'next': None})
    check(label + ' V-h … state unknown (agent down): nothing claimed about the dock, no chip', not re.search(r'[Dd]ok |[Dd]ock', tx)
          and p.pg.evaluate("document.getElementById('btn_auto_ans_dock').hidden"), tx)
    tx = dock({'kind': 'locked', 'active': None, 'next': None})
    lk = p.pg.evaluate("(()=>{const b=document.getElementById('btn_auto_ans_dock');return [b.hidden,b.textContent,b.dataset.state||'']})()")
    check(label + ' V-h … locked: the chip says so in the neutral tone (the owner\'s choice)', not lk[0] and lk[1] == ('Dok zamčený' if cs else 'Dock locked') and lk[2] == '', lk)
    p.pg.evaluate("(()=>{ if(window.__dockWas!==undefined){VAgent.dock=window.__dockWas;} delete window.__dockWas; document.dispatchEvent(new CustomEvent('vagent:dock')) })()")
    # V-i: a wait reported without its seconds: the notice over the map has no "{min}" (with them: the minutes).
    # Only after the full story (the fit-only screens still hold a sleep notice in the line, which goes first)
    if label not in ('desk-cs', 'phone-en'):
        return
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pub('/scheduler/report', report(now))
    p.pg.wait_for_timeout(200)
    p.pub('/scheduler/report', report(now, code='waiting_weather', detail={'program': 'Bigger'}))
    shown = p.until(r'Bigger', 14000)
    ln = p.line() or ''
    # (a sleep notice may hold the line on a loaded machine: then only "no {placeholder} on screen" can be said)
    check(label + ' V-i a rain wait without left_s: the notice has no "{min}"' + ('' if shown else ' (line held by another notice)'), '{' not in ln, ln)
    p.pub('/scheduler/report', report(now))
    p.pg.wait_for_timeout(200)
    p.pub('/scheduler/report', report(now, code='waiting_weather', detail={'program': 'Bigger', 'left_s': 1500}))
    p.until(r'25 min', 6000)
    ln = p.line() or ''
    check(label + ' V-i … and with left_s it says the minutes (25 min)', '25 min' in ln and '{' not in ln, ln)
    p.pub('/scheduler/report', report(now))


def vh_sheet_pills(p, shots, label):
    """T8 V-h (seen live on a phone, the Agent sheet open): over an open sheet the map hollow is low. The pills
    (dock open + a finding) stand beside the map's buttons, cover none of them, nor STOP; Lock stays in reach above
    the sheet; the finding is one line; the agent's plan card steps back while the sheet is open."""
    if p.pg.viewport_size['width'] > 500:
        return
    p.open('now')
    r = p.pg.evaluate("""async ()=>{const u=document.getElementById('vagent_unlocked'), st=document.getElementById('vagent_strip'), b=document.getElementById('vagent_bars');
        if(!u||!st||!b) return null;
        const was=[u.innerHTML,u.style.display,st.innerHTML,st.className,st.style.display];
        u.innerHTML='<span class="vs-lab">DOK POVOLEN</span><span class="vs-txt">do 06:00 · 3:55:40</span><button type="button" class="vs-btn">Zamknout</button>'; u.style.display='';
        st.innerHTML='<span class="vs-lab">NÁLEZ</span><span class="vs-txt">13 nepřečtených nálezů k přečtení</span>'; st.className='va-finding'; st.style.display='';
        let card=document.getElementById('vt_aplan_card'), made=false, cwas=card?card.style.display:null;
        if(!card){card=document.createElement('div'); card.id='vt_aplan_card'; card.className='vt-aplan-card'; card.innerHTML='<div class="vt-aplan-head">◆ Plán agenta</div><div class="vt-aplan-sub">Testovací jízda</div><div class="vt-aplan-btns"><button class="btn btn-sm vt-aplan-btn">Ukázat</button></div>'; document.body.appendChild(card); made=true;}
        card.style.display='';
        window.dispatchEvent(new Event('resize')); await new Promise(r=>setTimeout(r,700));
        const vis=e=>!!(e&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);
        const R=e=>vis(e)?[e.getBoundingClientRect().left,e.getBoundingClientRect().top,e.getBoundingClientRect().right,e.getBoundingClientRect().bottom].map(Math.round):null;
        const g=id=>document.getElementById(id), btn=u.querySelector('.vs-btn'), q=btn.getBoundingClientRect(), hit=document.elementFromPoint(q.left+q.width/2,q.top+q.height/2);
        const dr=g('ui_drawer');
        const o={cls:document.body.className, u:R(u), st:R(st), btn:R(btn), btnHit:hit===btn, rose:R(g('vt_utm_rose')), fab:R(g('vt_lyr_fab')), meas:R(g('vt_meas_btn')),
                 stop:R(g('vt_stop_big')), card:R(card), sheet:R(dr), stH:Math.round(st.getBoundingClientRect().height), stTitle:st.title||'',
                 hs:document.scrollingElement.scrollWidth>innerWidth+1, vw:innerWidth};
        return {o, was, made, cwas}}""")
    if not r:
        check(label + ' V-h the agent pills exist on the page', False, 'no #vagent_bars')
        return
    o = r['o']
    ov = lambda a, c: bool(a and c and not (a[2] <= c[0] or a[0] >= c[2] or a[3] <= c[1] or a[1] >= c[3]))
    pills = [x for x in (o['u'], o['st']) if x]
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-vh-sheet-pills.png'))
    check(label + ' V-h sheet open: the pills cover no map button (compass, layers, measure) and not STOP',
          len(pills) == 2 and not any(ov(x, c) for x in pills for c in (o['rose'], o['fab'], o['meas'], o['stop'])), o)
    check(label + ' V-h … Lock is whole above the sheet, on the screen and under the finger (>= 40 px)',
          bool(o['btn']) and o['btnHit'] and o['btn'][2] <= o['vw'] and (not o['sheet'] or o['btn'][3] <= o['sheet'][1] + 1) and o['btn'][3] - o['btn'][1] >= 40, o)
    check(label + ' V-h … the finding is one line, both pills end above the sheet, no sideways scroll',
          o['stH'] <= 32 and all((not o['sheet']) or x[3] <= o['sheet'][1] + 1 for x in pills) and not o['hs'], o)
    check(label + ' V-h … the agent\'s plan card steps back while the sheet is open', o['card'] is None and 'vt-sheet-low' in o['cls'], o)
    back = p.pg.evaluate("""async (r)=>{const mm=window.map_menu; try{ if(mm&&mm.close_drawer) mm.close_drawer(); }catch(e){}
        window.dispatchEvent(new Event('resize')); await new Promise(x=>setTimeout(x,700));
        const card=document.getElementById('vt_aplan_card'), u=document.getElementById('vagent_unlocked'), st=document.getElementById('vagent_strip');
        const vis=e=>!!(e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().height>0);
        const out={card:vis(card), low:document.body.classList.contains('vt-sheet-low')};
        [u.innerHTML,u.style.display,st.innerHTML,st.className,st.style.display]=r.was;
        if(r.made){card.remove();} else {card.style.display=r.cwas;}
        window.dispatchEvent(new Event('resize')); return out}""", r)
    check(label + ' V-h … and is back once the sheet is closed', back['card'] and not back['low'], back)


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
        const rp=document.getElementById('right_panel'), rr=rp&&rp.getBoundingClientRect();
        const rpOn=!!(rp&&rr.width>0&&getComputedStyle(rp).display!=='none'&&!rp.classList.contains('compact'));
        return {l:r.left,r:r.right,t:r.top,h:r.height,lw:r.width,bh:b.height,bw:b.width,hit:hit&&hit.id,w:document.documentElement.scrollWidth,
                rpOn:rpOn, rpL:rpOn?rr.left:null}}""")
    check(label + ' line inside the screen', r['l'] >= 0 and r['r'] <= vw + 1 and r['t'] >= 0, r)
    check(label + ' Cancel reachable, nothing over it', r['hit'] == 'btn_notice_action', r)
    # T8 dávka IV (T4 backlog): at 768 px with the right panel open the line was ~24 px wide
    if r['rpOn'] and vw >= 600:
        check(label + ' right panel open: the line has room (>= 100 px) and ends left of the panel',
              r['lw'] >= 100 and r['r'] <= r['rpL'] + 1, r)
    # T8 dávka IV: the agent's "FINDING 16 to read" pill covered the measure button under the
    # layers button (phone); a long count is put in the strip here, the frame lays out again
    pl = p.pg.evaluate("""async ()=>{const st=document.getElementById('vagent_strip'), m=document.getElementById('vt_meas_btn'), f=document.getElementById('vt_lyr_fab');
        if(!st||!m||!f||m.hidden||!f.getBoundingClientRect().width) return null;
        const was=[st.innerHTML, st.className, st.style.display];
        st.innerHTML='<span class="vs-lab">Finding</span><span class="vs-txt">1234 to read, a long strip text</span>'; st.className='va-finding'; st.style.display='';
        window.dispatchEvent(new Event('resize')); await new Promise(r=>setTimeout(r,400));
        const a=st.getBoundingClientRect(), b=m.getBoundingClientRect();
        const hit=!(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom);
        [st.innerHTML, st.className, st.style.display]=was; window.dispatchEvent(new Event('resize'));
        return {hit, s:[a.left,a.top,a.right,a.bottom].map(Math.round), m:[b.left,b.top,b.right,b.bottom].map(Math.round)}}""")
    if pl is not None:
        check(label + ' the agent pill does not cover the measure button', not pl['hit'], pl)
    # T8 dávka IV (audit, 768 px with the left panel open): the dock-open pill stood out of its
    # ~130-px hollow over the right panel's head, and two-line pills covered the compass rose
    if vw >= 600:
        agent_slot(p, label)
        # review: right panel open, left closed (hollow 560 px): a 380-px dock pill covered a long notice
        p.pg.evaluate("(()=>{const b=document.getElementById('btn_ui_drawer_close');if(b&&document.getElementById('ui_drawer').classList.contains('open'))b.click()})()")
        p.pg.wait_for_timeout(500)
        agent_slot(p, label + ' left closed')
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
            q = P(ctx, url)            # V-c: a second, fresh page (its own fake rosbridge, nothing latched)
            q.lang(lang)
            fresh_silent(q, a.shots, label)
            q.pg.close()
            mode_story(p, a.shots, label)
            mode_fit(p, a.shots, label)
            layout(p, a.shots, label)
            a1_story(p, a.shots, label)
            a1_fit(p, a.shots, label)
            a2_story(p, a.shots, label)
            a2_fit(p, a.shots, label)
            a3_story(p, a.shots, label)
            a3_fit(p, a.shots, label)
            a4_story(p, a.shots, label)
            a4_fit(p, a.shots, label)
            a5_story(p, a.shots, label)
            a5_fit(p, a.shots, label)
            a6_story(p, a.shots, label)
            a6_fit(p, a.shots, label)
            a7_story(p, a.shots, label)
            a7_fit(p, a.shots, label)
            vh_dock_note(p, a.shots, label)
            vh_sheet_pills(p, a.shots, label)
            lang_sweep(p, a.shots, label)
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
            a1_fit(p, a.shots, label)
            a2_fit(p, a.shots, label)
            a3_fit(p, a.shots, label)
            a4_fit(p, a.shots, label)
            a5_fit(p, a.shots, label)
            a6_fit(p, a.shots, label)
            a7_fit(p, a.shots, label)
            vh_dock_note(p, a.shots, label)
            vh_sheet_pills(p, a.shots, label)
            layout(p, a.shots, label)   # D10: at 768 px too (the line takes the narrow hollow, vt_header.css)
            ctx.close()
        b.close()
    srv.shutdown()
    print('%s of %d checks' % ('%d FAILED' % len(FAILS) if FAILS else 'all ok', COUNT[0]))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
