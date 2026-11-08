#!/usr/bin/env python3
"""The dock permit tile (T18 stage 4-5) in real Chrome against a fake agent: nothing reaches a robot.

The page is served from this tree on a private port; the agent's API (/agent/*) and the
webnode door (/agent-dock/*) are answered by this script (page.route), rosbridge by a fake
WebSocket.  It shows:
  - every state of the window in words (locked, open, ending, homeward, scheduled, waiting
    for the clock, exits used, not accepted, owners file);
  - NOTHING is allowed without the tap on Allow: picking a span, the options, opening the tile,
    the Autonomy link, Needs you and a chat proposal send no write by themselves;
  - Allow sends one window (minutes/to/from, one_exit, lock_on_return, req_id); a lost answer is
    asked again with the SAME req_id; a refusal stays readable in the viewer's language;
  - locking is one tap (current / all / one scheduled window), always;
  - a chat proposal's Allow sends channel chat + confirmed + the proposal's req_id;
  - the Autonomy panel's D36 box opens the tile; phone 360/390 (coarse), 768, 1440, en + cs fit.

    python3 tools/test_dock_permit_ui.py [--shots DIR]

Needs python3-playwright + Google Chrome.
"""
import argparse
import functools
import http.server
import json
import os
import re
import sys
import threading
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_autonomy_ui import FAKE as _FAKE, Handler, TPL, report  # noqa: E402

# The Agent panel opens a second rosbridge connection (agent_blocks.js): deliver to every socket.
FAKE = _FAKE.replace("F.sock = this;", "F.sock = this; (F.socks = F.socks || []).push(this);").replace(
    "if (F.sock && F.sock.readyState === 1) { F.sock.deliver({ op: 'publish', topic, msg }); }",
    "(F.socks || []).forEach((k) => { if (k.readyState === 1) { k.deliver({ op: 'publish', topic, msg }); } });")
assert FAKE.count('F.socks') == 3, 'the fake rosbridge changed'

FAILS = []
COUNT = [0]


def check(name, ok, detail=''):
    COUNT[0] += 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:400]), flush=True)
    if not ok:
        FAILS.append(name)


OWNERS_OK = {'file': '~/.vitulus/dock_permit_owners', 'state': 'ok', 'count': 1, 'signs_as': 'owner'}


def win(now, wid='p1794108289-3', frm=-600, to=3600, max_exits=None, exits=0, lor=False, ch='ui', sched=False):
    return {'id': wid, 'from': now + frm, 'to': now + to, 'remaining_s': max(0, to) if not sched else to - frm,
            'max_exits': max_exits, 'exits': exits,
            'exits_left': None if max_exits is None else max_exits - exits, 'lock_on_return': lor,
            'end_action': 'return', 'by': 'owner', 'channel': ch, 'reason': 'allowed in the panel',
            'created': now + min(frm, 0), 'opened': None if sched else now + frm, 'left_dock': None,
            'scheduled': sched, 'ended': None, 'starts_in_s': max(0, frm)}


def dock_list(kind, now, owners=None, clock_ok=True):
    """GET /api/v2/dock as the agent's web API answers it (webapi.dock_list)."""
    p = {'v': 1, 'stamp': now, 'allowed': False, 'why': 'locked', 'active': None, 'next_window': None,
         'scheduled': [], 'ending_soon': False, 'homeward': None, 'dock': 'in', 'clock_ok': clock_ok,
         'clock_offset_s': 0.2, 'enforced_by': []}
    ok, why = False, 'locked'
    if kind in ('open', 'ending', 'unverified'):
        to = 480 if kind == 'ending' else 4320
        p.update(allowed=True, why='open', active=win(now, to=to, max_exits=1), ending_soon=kind == 'ending')
        ok, why = kind != 'unverified', 'open'
    elif kind == 'exits_used':
        p.update(why='exits_used', active=win(now, max_exits=1, exits=1), dock='out')
    elif kind == 'homeward':
        p.update(homeward={'since': now - 40, 'deadline': now + 260, 'finish_chunk_s': 300,
                           'window': 'p1794108289-3'}, dock='out')
    elif kind in ('scheduled', 'waiting_clock'):
        w = win(now, wid='p1794108300-4', frm=3 * 3600, to=5 * 3600, max_exits=1, sched=True)
        w2 = win(now, wid='p1794108301-5', frm=26 * 3600, to=29 * 3600, lor=True, sched=True)
        p.update(why=kind, next_window=w, scheduled=[w, w2])
        if kind == 'waiting_clock':
            p.update(clock_ok=False)
    return {'ok': True, 'ts': now, 'active': [], 'recent': [], 'locked': not ok, 'permit': p,
            'permit_ok': ok, 'permit_node_ok': bool(p['allowed']), 'permit_why': why,
            'permit_text': None if ok else 'majitel dok nepovolil (žádné otevřené okno povolení)',
            'max_window_s': 43200, 'free_drive_actions': [], 'presets': {},
            'owners_check': owners or OWNERS_OK, 'migration': None}


class Agent(object):
    """The fake agent + webnode door: state, the writes it got, what it answers."""

    def __init__(self):
        self.kind = 'locked'
        self.owners = None
        self.clock_ok = True
        self.posts = []
        self.lose = 0             # the next n writes get no answer (connection dropped)
        self.refuse = None        # the next grant: (status, body)
        self.tasks = []
        self.granted = None
        self.down = False         # the agent's web API is not running (webnode answers 503 on /agent)

    def state(self):
        d = dock_list(self.kind, time.time(), self.owners, self.clock_ok)
        if self.granted and self.kind == 'open':          # what Allow made, as the node keeps it
            w = dict(self.granted, remaining_s=max(0, self.granted['to'] - time.time()))
            d['permit']['active'] = w
        return d

    def handle(self, route):
        req = route.request
        url, method = req.url, req.method
        path = re.sub(r'^https?://[^/]+', '', url).split('?')[0]
        if path.startswith('/agent-dock/'):
            body = {}
            try:
                body = json.loads(req.post_data or '{}')
            except ValueError:
                pass
            self.posts.append((method, path, body, dict(req.headers)))
            if self.lose > 0:
                self.lose -= 1
                return route.abort('connectionreset')
            if path == '/agent-dock/grant':
                if self.refuse:
                    st, b = self.refuse
                    self.refuse = None
                    return route.fulfill(status=st, content_type='application/json', body=json.dumps(b))
                now = time.time()
                frm = body.get('from') or now
                to = body.get('to') or (frm + body.get('minutes', 60) * 60)
                later = body.get('from') is not None
                self.kind = 'scheduled' if later else 'open'
                w = self.granted = win(now, frm=frm - now, to=to - now, max_exits=1 if body.get('one_exit') else None,
                        lor=bool(body.get('lock_on_return')), ch=body.get('channel', 'ui'), sched=later)
                return route.fulfill(status=200, content_type='application/json', body=json.dumps(
                    {'ok': True, 'id': w['id'], 'code': 'scheduled' if later else 'open', 'repeat': False,
                     'req_id': body.get('req_id'), 'window': w, 'channel': body.get('channel', 'ui')}))
            self.kind, self.granted = 'locked', None
            out = {'ok': True, 'code': 'cleared', 'ended': ['p1794108289-3']}
            if self.down:         # S2: the webnode cleared it in the node itself
                out.update(direct=True, agent='agent unreachable')
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(out))
        if path.startswith('/agent/'):
            if self.down:
                return route.fulfill(status=503, content_type='application/json',
                                     body='{"ok": false, "error": "agent bridge unreachable"}')
            if method != 'GET':
                self.posts.append((method, path, {}, {}))
                return route.fulfill(status=200, content_type='application/json', body='{"ok": true}')
            if path == '/agent/api/v2/dock':
                return route.fulfill(status=200, content_type='application/json', body=json.dumps(self.state()))
            if path == '/agent/api/tasks':
                return route.fulfill(status=200, content_type='application/json',
                                     body=json.dumps({'tasks': self.tasks, 'has_more': False}))
            return route.fulfill(status=200, content_type='application/json', body='{"ok": true}')
        if path.startswith('/field/') or path.startswith('/system/'):
            if method != 'GET':
                self.posts.append((method, path, {}, {}))
            return route.fulfill(status=200, content_type='application/json', body='{"ok": true}')
        return route.continue_()

    def writes(self):
        return [(m, p, b) for m, p, b, _h in self.posts]


class Page(object):
    def __init__(self, ctx, url, agent, lang):
        self.a = agent
        self.pg = ctx.new_page()
        self.errors = []
        self.pg.on('pageerror', lambda e: self.errors.append(str(e)))
        self.pg.add_init_script(FAKE)
        self.pg.add_init_script("try{localStorage.setItem('vitulus_lang', %s)}catch(e){}" % json.dumps(lang))
        self.pg.route('**/*', agent.handle)
        self.pg.goto(url, wait_until='domcontentloaded')
        self.pg.wait_for_function('window.VAgent && VAgent.dock && window.VTI18n', timeout=30000)
        self.pg.evaluate('(l)=>VTI18n.set?VTI18n.set(l):VTI18n.setLang(l)', lang)
        self.pg.wait_for_timeout(500)

    def poll(self):
        self.pg.evaluate('VAgent.dock.poll(true)')
        self.pg.wait_for_timeout(350)

    def open_tile(self):
        self.pg.evaluate('VAgent.dock.open()')
        self.pg.wait_for_selector('#dockp_stat', timeout=10000)
        self.pg.wait_for_timeout(400)

    def text(self, sel):
        return self.pg.evaluate('(s)=>{const e=document.querySelector(s);return e?e.innerText:null}', sel)

    def visible(self, sel):
        return self.pg.evaluate('''(s)=>{const e=document.querySelector(s); if(!e) return false;
            const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 &&
            getComputedStyle(e).visibility!=='hidden'}''', sel)

    def click(self, sel):
        self.pg.locator(sel).first.scroll_into_view_if_needed()
        self.pg.locator(sel).first.click()
        self.pg.wait_for_timeout(450)

    def shot(self, shots, name):
        if shots:
            self.pg.screenshot(path=os.path.join(shots, name + '.png'))

    def shot_tile(self, shots, name):
        if shots:
            el = self.pg.locator('#dockp_stat').first
            box = self.pg.evaluate('''()=>{const e=document.querySelector('#dockp_stat');
                const p=e.closest('.vagent-pinned')||e.parentNode; p.scrollIntoView({block:'start'});
                const r=p.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}}''')
            del el
            if box['w'] <= 0 or box['h'] <= 0:
                self.pg.screenshot(path=os.path.join(shots, name + '.png'))
                return
            vp = self.pg.viewport_size
            clip = {'x': max(0, box['x']), 'y': max(0, box['y']), 'width': min(box['w'], vp['width']),
                    'height': max(40, min(box['h'], vp['height'] - max(0, box['y'])))}
            self.pg.screenshot(path=os.path.join(shots, name + '.png'), clip=clip)


def story(p, shots, label):
    a = p.a
    lang_cs = label.endswith('cs')
    # 1) owners file missing, locked: the clear call to create it; the form is there
    a.owners = {'file': '~/.vitulus/dock_permit_owners', 'state': 'missing', 'count': 0, 'signs_as': 'owner'}
    p.poll()
    p.open_tile()
    check('%s no write on load / opening the tile' % label, a.writes() == [], a.writes())
    check('%s locked: pill' % label, (p.text('#dockp_pill') or '') == ('ZAMČENO' if lang_cs else 'LOCKED'), p.text('#dockp_pill'))
    check('%s owners missing: create the file, the line to add' % label,
          p.visible('#dockp_owners') and 'dock_permit_owners' in (p.text('#dockp_owners') or ''), p.text('#dockp_owners'))
    check('%s locked: the form is open by itself' % label, p.visible('#dockp_fbody'))
    p.shot_tile(shots, label + '-1-locked-owners')
    for st in ('empty', 'unreadable', 'mismatch'):
        a.owners = dict(a.owners, state=st)
        p.poll()
        check('%s owners %s: shown' % (label, st), p.visible('#dockp_owners'))
    a.owners = None
    p.poll()
    check('%s owners ok: no banner' % label, not p.visible('#dockp_owners'))

    # 2) pick 2 h + only 1 exit: a summary, still nothing sent
    p.click('#dockp_fbody .dkp-q[data-min="120"]')
    p.click('#chk_dockp_one_exit')
    check('%s summary after the pick' % label, p.visible('#btn_dockp_allow'), p.text('#dockp_sum'))
    check('%s picking + options send nothing' % label, a.writes() == [], a.writes())
    p.shot_tile(shots, label + '-2-summary')
    # 3) the answer gets lost once: the same req_id again
    a.lose = 1
    p.click('#btn_dockp_allow')
    p.pg.wait_for_timeout(1500)
    grants = [w for w in a.writes() if w[1] == '/agent-dock/grant']
    check('%s Allow: one window asked, lost answer asked again with the same req_id' % label,
          len(grants) == 2 and grants[0][2].get('req_id') and grants[0][2]['req_id'] == grants[1][2]['req_id'], grants)
    g = grants[-1][2] if grants else {}
    check('%s the window: 120 min, one exit, no by/token from the page' % label,
          g.get('minutes') == 120 and g.get('one_exit') is True and 'by' not in g and 'channel' not in g, g)
    hdr = a.posts[-1][3] if a.posts else {}
    check('%s the door: JSON + X-Vitulus-UI' % label, hdr.get('x-vitulus-ui') == '1', hdr)
    p.pg.wait_for_timeout(400)
    check('%s open: pill + until' % label, (p.text('#dockp_pill') or '') in ('POVOLENO', 'OPEN')
          and re.search(r'\d\d:\d\d', p.text('#dockp_main') or ''), (p.text('#dockp_pill'), p.text('#dockp_main')))
    check('%s open: the bar over the map' % label, p.visible('#vagent_unlocked'), p.text('#vagent_unlocked'))
    p.shot_tile(shots, label + '-3-open')
    p.shot(shots, label + '-3-open-page')
    # 4) lock now: one tap, revoke/current
    n = len(a.writes())
    p.click('#btn_dockp_lock')
    w = a.writes()[n:]
    check('%s lock now: one tap → revoke/current' % label,
          len(w) == 1 and w[0][1] == '/agent-dock/revoke/current' and w[0][2].get('req_id'), w)
    check('%s locked again' % label, (p.text('#dockp_pill') or '') in ('ZAMČENO', 'LOCKED'))
    check('%s bar gone' % label, not p.visible('#vagent_unlocked'))

    # 5) ending soon / homeward / exits used / not accepted
    for kind, pill in (('ending', ('BRZY KONČÍ', 'ENDS SOON')), ('homeward', ('JEDE DOMŮ', 'GOING HOME')),
                       ('exits_used', ('VÝJEZDY VYČERPÁNY', 'EXITS USED')), ('unverified', ('NEUZNÁNO', 'NOT ACCEPTED'))):
        a.kind = kind
        p.poll()
        check('%s %s: pill' % (label, kind), (p.text('#dockp_pill') or '') in pill, p.text('#dockp_pill'))
        if kind in ('ending', 'homeward'):
            check('%s %s: says what happens at the end' % (label, kind), p.visible('.dkp-attn[data-state="warn"]'))
            check('%s %s: bar' % (label, kind), p.visible('#vagent_unlocked'), p.text('#vagent_unlocked'))
        p.shot_tile(shots, '%s-5-%s' % (label, kind))
    check('%s states send nothing' % label, len(a.writes()) == n + 1, a.writes()[n:])

    # 6) scheduled windows: the list, × cancels one, lock everything
    a.kind = 'scheduled'
    p.poll()
    check('%s scheduled: pill + list' % label, (p.text('#dockp_pill') or '') in ('NAPLÁNOVÁNO', 'SCHEDULED')
          and p.pg.locator('.dkp-sched-r').count() == 2)
    p.shot_tile(shots, label + '-6-scheduled')
    n = len(a.writes())
    p.click('.dkp-sched-r .dkp-x')
    w = a.writes()[n:]
    check('%s × cancels that window' % label, len(w) == 1 and w[0][1] == '/agent-dock/revoke/p1794108300-4', w)
    a.kind = 'scheduled'
    p.poll()
    n = len(a.writes())
    p.click('#btn_dockp_lock_all')
    w = a.writes()[n:]
    check('%s lock everything → revoke/all' % label, len(w) == 1 and w[0][1] == '/agent-dock/revoke/all', w)

    # 7) no reliable clock: only from now
    a.kind, a.clock_ok = 'waiting_clock', False
    p.poll()
    check('%s waiting for the clock: pill' % label, (p.text('#dockp_pill') or '') in ('ČEKÁ NA ČAS', 'WAITS FOR TIME'))
    if not p.visible('#dockp_fbody'):
        p.click('#btn_dockp_change')
    p.click('#btn_dockp_custom')
    dis = p.pg.evaluate("document.getElementById('chk_dockp_later').disabled")
    check('%s no GPS clock: Start later off, note shown' % label, dis and p.visible('#dockp_clocknote'))
    p.shot_tile(shots, label + '-7-custom-noclock')
    a.kind, a.clock_ok = 'locked', True
    p.poll()
    # custom from–to tomorrow with a clock
    p.pg.evaluate("""()=>{const l=document.getElementById('chk_dockp_later'); if(!l.checked){l.click();}
        const d=new Date(); d.setDate(d.getDate()+1); d.setHours(14,0,0,0);
        const f=(x)=>x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0')+'T'+String(x.getHours()).padStart(2,'0')+':'+String(x.getMinutes()).padStart(2,'0');
        document.getElementById('inp_dockp_from').value=f(d); d.setHours(17); document.getElementById('inp_dockp_to').value=f(d);}""")
    p.click('#btn_dockp_custom_use')
    check('%s custom span: summary, nothing sent' % label, p.visible('#btn_dockp_allow') and
          len(a.writes()) == n + 1, p.text('#dockp_sum'))
    # 8) a refusal stays, in the viewer's language
    a.refuse = (400, {'ok': False, 'error': 'povolení se nepovedlo: uzel dock_permit odmítl (clock) a later window needs a reliable clock'})
    p.click('#btn_dockp_allow')
    p.pg.wait_for_timeout(500)
    out = p.text('#dockp_out') or ''
    check('%s refusal: readable, translated, the summary stays' % label,
          ('GPS' in out) and p.visible('#btn_dockp_allow'), out)
    p.shot_tile(shots, label + '-8-refused')
    p.click('#btn_dockp_allow')
    grants = [w for w in a.writes() if w[1] == '/agent-dock/grant']
    g = grants[-1][2] if grants else {}
    check('%s custom: from + to in epoch seconds, 3 h' % label,
          isinstance(g.get('from'), int) and isinstance(g.get('to'), int) and g['to'] - g['from'] == 3 * 3600, g)
    check('%s custom: scheduled' % label, (p.text('#dockp_pill') or '') in ('NAPLÁNOVÁNO', 'SCHEDULED'))
    a.kind = 'locked'
    p.poll()
    errs = [e for e in p.errors if 'erases' not in e]     # ros3d markers vs the fake rosbridge (not this tile)
    check('%s page errors' % label, not errs, errs[:3])


def down_story(p, shots, label):
    """N2 + S2: the agent is down — no stale countdown, locking still works."""
    a = p.a
    a.kind = 'open'
    p.poll()
    p.open_tile()
    a.down = True
    p.pg.wait_for_function("(()=>{const e=document.querySelector('#dockp_down');return e&&e.getBoundingClientRect().height>0})()",
                           timeout=40000)
    box = p.text('#dockp_down') or ''
    check('%s agent down: the dock box says unknown, no countdown, lock buttons' % label,
          not re.search(r'\d:\d\d', box) and p.visible('#btn_dockp_down_lock') and p.visible('#btn_dockp_down_lock_all'), box)
    bar = p.text('#vagent_unlocked') or ''
    check('%s agent down: the bar stays, says unknown, Lock works' % label,
          p.visible('#vagent_unlocked') and ('?' in bar) and p.visible('#btn_dockp_bar_lock')
          and not re.search(r'\d:\d\d', bar), bar)
    if shots:
        p.pg.locator('#dockp_down').scroll_into_view_if_needed()
        p.shot(shots, label + '-11-agent-down')
    n = len(a.writes())
    p.click('#btn_dockp_down_lock')
    p.pg.wait_for_timeout(500)
    w = a.writes()[n:]
    out = p.text('#dockp_down_out') or ''
    check('%s agent down: Lock now → revoke/current, the direct result shown' % label,
          len(w) == 1 and w[0][1] == '/agent-dock/revoke/current' and ('uzlu' in out or 'node' in out), (w, out))
    n = len(a.writes())
    p.click('#btn_dockp_down_lock_all')
    w = a.writes()[n:]
    check('%s agent down: Lock everything → revoke/all' % label, len(w) == 1 and w[0][1] == '/agent-dock/revoke/all', w)
    if shots:
        p.shot(shots, label + '-11-agent-down-locked')
    a.down = False
    a.kind = 'locked'
    p.pg.evaluate("document.querySelector('#vagent_down .vagent-retry') && document.querySelector('#vagent_down .vagent-retry').click()")
    p.pg.wait_for_timeout(1500)


def chat_story(p, shots, label):
    a = p.a
    now = time.time()
    prop = {'minutes': 120, 'one_exit': True, 'req_id': 'chat-41-0123456789', 'valid_until': int(now + 900),
            'summary': 'na 2 h od potvrzení, jen 1 výjezd', 'default': False, 'reason': 'chat #41: povol dok na 2 hodiny'}
    a.tasks = [{'id': 41, 'ts': now - 5, 'source': 'web', 'author': 'webui:test', 'text': 'povol dok na 2 hodiny',
                'state': 'done', 'reply': 'Návrh povolení doku: na 2 h od potvrzení, jen 1 výjezd. Potvrď tlačítkem „Povolit" …',
                'reply_ts': now - 4, 'klass': 'oneshot', 'meta': {'dock_permit_proposal': prop}},
               {'id': 42, 'ts': now - 3, 'source': 'web', 'author': 'webui:test', 'text': 'povol dok jen jednou',
                'state': 'done', 'reply': 'Návrh … (vypršel)', 'reply_ts': now - 3, 'klass': 'oneshot',
                'meta': {'dock_permit_proposal': dict(prop, req_id='chat-42-x', valid_until=int(now - 60))}},
               {'id': 43, 'ts': now - 2, 'source': 'agent', 'author': 'agent', 'text': 'Povolení doku',
                'state': 'done', 'reply': 'Okno povolení doku končí v 17:00 …', 'reply_ts': now - 2, 'klass': 'mission',
                'meta': {'event': 'dock_permit_warn', 'dock_permit_seq': 7}}]
    p.pg.evaluate("VAgent.open(); VAgent.activateTab && VAgent.activateTab('chat')")
    p.pg.wait_for_timeout(1500)
    n = len(a.writes())
    btn = p.pg.locator('[data-dockp-req="chat-41-0123456789"]')
    check('%s chat: proposal has Allow' % label, btn.count() == 1)
    check('%s chat: an expired proposal has no button' % label,
          p.pg.locator('[data-dockp-req="chat-42-x"]').count() == 0)
    check('%s chat: the proposal alone sends nothing' % label, len(a.writes()) == n, a.writes()[n:])
    if shots:
        btn.first.scroll_into_view_if_needed()
        p.shot(shots, label + '-9-chat-proposal')
    btn.first.click()
    p.pg.wait_for_timeout(700)
    w = [x for x in a.writes()[n:] if x[1] == '/agent-dock/grant']
    g = w[0][2] if w else {}
    check('%s chat Allow: channel chat, confirmed, the proposal req_id' % label,
          len(w) == 1 and g.get('channel') == 'chat' and g.get('confirmed') is True
          and g.get('req_id') == 'chat-41-0123456789' and g.get('minutes') == 120 and g.get('one_exit') is True, w)
    done = p.pg.evaluate("""()=>{const b=[...document.querySelectorAll('.vagent-dockp .vagent-cap-out')];
        return b.map(x=>x.textContent).join('|')}""")
    check('%s chat: ✓ after the tap' % label, '✓' in done, done)
    a.kind = 'locked'
    p.poll()
    a.tasks = []


def autonomy_story(p, shots, label):
    """Who decides: the quiet dock line carries the link; the D36 box (an advice waits) too."""
    import datetime as dt
    a = p.a
    a.kind = 'open'
    p.poll()
    now = dt.datetime.now().replace(second=0, microsecond=0)
    p.pg.evaluate("VTAutonomy.open('now', false)")
    p.pg.wait_for_function('window.VTAutonomy && VTAutonomy._state && VTAutonomy._state.ros', timeout=30000)
    p.pg.wait_for_timeout(600)
    p.pg.evaluate('([t,o])=>__fake.json(t,o)', ['/scheduler/report', report(now)])
    mode = {'mode': 'agent', 'automation': True, 'held': False, 'fallback': True, 'limits_apply': True,
            'advice': None, 'last_decision': None, 'limit_now': None, 'dock_permitted': True, 'dock_why': None,
            'dock_homeward': None, 'state': 'IDLE', 'changed': None}
    p.pg.evaluate('([t,o])=>__fake.json(t,o)', ['/scheduler/mode', mode])
    p.pg.evaluate("VTAutonomy.open('mode', false)")
    p.pg.wait_for_timeout(600)
    notes = p.text('#auto_mode_notes') or ''
    check('%s autonomy: quiet line says until when + the link' % label,
          re.search(r'\d\d:\d\d', notes) and p.visible('#btn_auto_mode_dock_note'), notes)
    check('%s autonomy: no box without an advice (alert only when needed)' % label, not p.visible('#auto_mode_attn'))
    if shots:
        p.pg.locator('#auto_mode_notes').scroll_into_view_if_needed()
        p.shot(shots, label + '-10-autonomy-note')
    n = len(a.writes())
    p.click('#btn_auto_mode_dock_note')
    p.pg.wait_for_timeout(600)
    check('%s autonomy note link opens the tile, sends nothing' % label,
          p.visible('#dockp_stat') and len(a.writes()) == n, a.writes()[n:])
    # D36: a mow advice in its window, the dock locked → the box with Dock permit ›
    a.kind = 'locked'
    p.poll()
    t0, t1 = now - dt.timedelta(minutes=5), now + dt.timedelta(hours=3)
    adv = {'id': 'ag1', 'action': 'mow', 'program': 'Bigger', 'from': t0.strftime('%Y-%m-%dT%H:%M:%S'),
           'to': t1.strftime('%Y-%m-%dT%H:%M:%S'), 'state': 'pending', 'fresh': True, 'confidence': 0.8,
           'reason': 'dry', 'received': t0.strftime('%Y-%m-%dT%H:%M:%S')}
    p.pg.evaluate('([t,o])=>__fake.json(t,o)', ['/scheduler/mode', dict(mode, advice=adv, dock_permitted=False,
                                                                          dock_why='majitel dok nepovolil')])
    p.pg.evaluate("VTAutonomy.open('mode', false)")
    p.pg.wait_for_timeout(600)
    txt = p.text('#auto_mode_attn') or ''
    check('%s autonomy D36 box: Bigger waits for the dock permit' % label,
          p.visible('#btn_auto_mode_dock') and 'Bigger' in txt, txt)
    if shots:
        p.pg.locator('#auto_mode_attn').scroll_into_view_if_needed()
        p.shot(shots, label + '-10-autonomy-d36')
    n = len(a.writes())
    p.click('#btn_auto_mode_dock')
    p.pg.wait_for_timeout(600)
    check('%s D36 box link opens the tile, sends nothing' % label,
          p.visible('#dockp_stat') and len(a.writes()) == n, a.writes()[n:])
    pubs = p.pg.evaluate("__fake.sent.map(x=>x.topic)")
    # the contract (§8 stage 4): writes go through the agent's web API, never a publish from the browser
    check('%s no publish to /dock_permit/* or /scheduler/* from the browser' % label,
          not [x for x in pubs if x.startswith('/dock_permit') or x.startswith('/scheduler/')], pubs)


def layout(p, shots, label, coarse):
    """Nothing overflows the tile; touch targets on a phone."""
    a = p.a
    for kind in ('locked', 'open', 'scheduled', 'homeward'):
        a.kind = kind
        p.poll()
        p.open_tile()
        if kind == 'locked':
            p.click('#btn_dockp_custom')
        over = p.pg.evaluate("""()=>{const t=document.querySelector('#dockp_stat').closest('.vagent-pinned')||document.querySelector('#dockp_stat');
            const out=[]; const R=t.getBoundingClientRect();
            t.querySelectorAll('*').forEach(e=>{const r=e.getBoundingClientRect(); if(!r.width) return;
              if(r.right>R.right+1.5 || r.left<R.left-1.5) out.push((e.id||e.className||e.tagName)+':'+Math.round(r.right-R.right));});
            return {out:out.slice(0,6), hs: document.documentElement.scrollWidth>document.documentElement.clientWidth+1}}""")
        check('%s %s: nothing sticks out of the tile' % (label, kind), not over['out'], over)
        check('%s %s: no horizontal page scroll' % (label, kind), not over['hs'])
        if coarse:
            small = p.pg.evaluate("""()=>[...document.querySelectorAll('#dockp_stat button, #dockp_form button')]
                .filter(b=>b.offsetParent).map(b=>[b.id||b.textContent.trim().slice(0,12), Math.round(b.getBoundingClientRect().height)])
                .filter(x=>x[1]<40)""")
            check('%s %s: buttons ≥ 40 px on touch' % (label, kind), not small, small)
        p.shot_tile(shots, '%s-L-%s' % (label, kind))
    a.kind = 'locked'


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
        runs = (('cs', (390, 844), True, 'p390-cs', True), ('en', (1440, 900), False, 'd1440-en', True),
                ('en', (390, 844), True, 'p390-en', False), ('cs', (1440, 900), False, 'd1440-cs', False),
                ('cs', (360, 740), True, 'p360-cs', False), ('en', (360, 740), True, 'p360-en', False),
                ('cs', (768, 1024), False, 't768-cs', False), ('en', (768, 1024), False, 't768-en', False))
        for lang, vp, phone, label, full in runs:
            print('--- %s' % label, flush=True)
            ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone,
                                service_workers='block', timezone_id='Europe/Prague',
                                locale='cs-CZ' if lang == 'cs' else 'en-US')
            agent = Agent()
            p = Page(ctx, url, agent, lang)
            if full:
                story(p, a.shots, label)
                chat_story(p, a.shots, label)
                down_story(p, a.shots, label)
                autonomy_story(p, a.shots, label)
            layout(p, a.shots, label, phone)
            other = [w for w in agent.writes() if not w[1].startswith('/agent-dock/')]
            check('%s no other write (agent, field, system)' % label, not other, other)
            ctx.close()
        b.close()
    srv.shutdown()
    print('%s of %d checks' % ('%d FAILED' % len(FAILS) if FAILS else 'all ok', COUNT[0]))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
