#!/usr/bin/env python3
"""T8 V-n: the Agent panel on a narrow phone (<= 480 px: over the whole screen) with a STAND-IN agent - the chat
input and Send are inside the screen on every tab, a message can be written and sent by taps, the panel's close and
the robot's STOP stay in reach; a wider phone / tablet is not forced full. Check A792 found the input 128 px under the
bottom edge. The page is served from this tree, the agent and rosbridge are fakes: nothing reaches a robot.
A848 (touch targets): on a 360 / 390 phone the camera switch, the Map–GPS line, the log keys and every on/off switch
of Autonomy and Map › Dock take a finger (>= 40 x 40 px, measured by elementFromPoint, a label counts), every switch is
one size, and the live log never shows the tail of an entry cut by its top edge (phone and desktop).

    python3 tools/test_agent_phone_ui.py [--shots DIR]
"""
import argparse
import functools
import http.server
import json
import os
import re
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_dock_permit_ui as T          # its fake agent (posts, tickets) and page
from playwright.sync_api import sync_playwright

FAILS, COUNT = [], [0]


def check(name, ok, detail=''):
    COUNT[0] += 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:500]), flush=True)
    if not ok:
        FAILS.append(name)


class Agent(T.Agent):
    def handle(self, route):
        req = route.request
        path = re.sub(r'^https?://[^/]+', '', req.url).split('?')[0]
        if req.method == 'GET' and path == '/agent/api/health':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True}))
        return T.Agent.handle(self, route)


GEO = """(()=>{const g=id=>document.getElementById(id), vis=e=>!!(e&&e.checkVisibility()&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);
  const R=e=>vis(e)?[e.getBoundingClientRect().left,e.getBoundingClientRect().top,e.getBoundingClientRect().right,e.getBoundingClientRect().bottom].map(Math.round):null;
  const hit=e=>{if(!vis(e)) return false; const r=e.getBoundingClientRect(), h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return !!h&&(h===e||e.contains(h))};
  const d=g('ui_drawer'), bar=g('div_bottom_menu');
  return {vw:innerWidth, vh:innerHeight, full:d.classList.contains('full'), drawer:R(d), bar:R(bar), input:R(g('vagent_input')), inputHit:hit(g('vagent_input')),
          send:R(g('vagent_send')), sendHit:hit(g('vagent_send')), stop:R(g('vt_stop_big')), stopHit:hit(g('vt_stop_big')), close:R(g('btn_ui_drawer_close')), closeHit:hit(g('btn_ui_drawer_close')),
          tab:(document.querySelector('.vagent-pane.active')||{dataset:{}}).dataset.pane, hs:document.scrollingElement.scrollWidth>innerWidth+1}})()"""


def inside(r, g):
    """the box is whole inside the screen and above the bottom bar"""
    floor = g['bar'][1] if g['bar'] else g['vh']
    return bool(r) and r[0] >= 0 and r[2] <= g['vw'] and r[1] >= 0 and r[3] <= floor + 1


def run(b, url, lang, vp, label, shots, narrow):
    ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=True, has_touch=True, service_workers='block', timezone_id='Europe/Prague')
    ag = Agent()
    p = T.Page(ctx, url, ag, lang)
    errs = []
    p.pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    p.pg.evaluate("(()=>{try{localStorage.removeItem('vitulus_drawer_full_agent')}catch(e){} VAgent.open(); VAgent.activateTab('chat'); })()")
    p.pg.wait_for_timeout(1800)
    g = p.pg.evaluate(GEO)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-chat.png'))
    if not narrow:
        check(label + ' a wider screen: the panel is not forced over the whole screen; input and Send in sight', not g['full'] and inside(g['input'], g) and g['inputHit'] and g['sendHit'], g)
        ctx.close()
        return
    check(label + ' Chat: the panel is over the whole screen, the input and Send are whole inside it and under the finger',
          g['full'] and inside(g['input'], g) and inside(g['send'], g) and g['inputHit'] and g['sendHit'] and not g['hs'], g)
    check(label + ' … the input row stands at the bottom of the panel (not somewhere in the middle)', bool(g['input']) and bool(g['drawer']) and g['drawer'][3] - g['input'][3] <= 24, g)
    check(label + ' … the robot\'s STOP and the panel\'s close are whole and under the finger', g['stopHit'] and g['closeHit'] and g['close'][2] <= g['vw'], g)
    tabs = p.pg.evaluate("[...document.querySelectorAll('.vagent-pane')].map(x=>x.dataset.pane)")
    for tab in [t for t in tabs if t != 'chat']:
        p.pg.evaluate("(t)=>VAgent.activateTab(t)", tab)
        p.pg.wait_for_timeout(600)
        gt = p.pg.evaluate(GEO)
        sc = p.pg.evaluate("(()=>{const a=document.querySelector('.vagent-pane.active'); if(!a) return null; const r=a.getBoundingClientRect(); return {top:Math.round(r.top), bottom:Math.round(r.bottom), oy:getComputedStyle(a).overflowY, sh:a.scrollHeight, ch:a.clientHeight}})()")
        # the input belongs to Chat: on another tab it may be absent - then the tab's own content must end inside the panel and scroll
        ok = gt['tab'] == tab and not gt['hs'] and gt['stopHit'] and gt['closeHit'] and bool(sc) and sc['bottom'] <= (gt['bar'][1] if gt['bar'] else gt['vh']) + 1 \
            and (sc['sh'] <= sc['ch'] + 1 or sc['oy'] in ('auto', 'scroll')) and (not gt['input'] or (inside(gt['input'], gt) and gt['inputHit']))
        check(label + ' tab %s: its content ends inside the panel and scrolls, nothing under the bottom edge, STOP and close in reach%s'
              % (tab, '' if gt['input'] else ' (no chat input on this tab)'), ok, [gt, sc])
        if shots:
            p.pg.screenshot(path=os.path.join(shots, label + '-' + tab + '.png'))
    p.pg.evaluate("VAgent.activateTab('chat')")
    p.pg.wait_for_timeout(500)
    n0 = len(ag.posts)
    exc = ''
    try:
        p.pg.locator('#vagent_input').tap(timeout=5000)
        p.pg.keyboard.type('ahoj, zkouška V-n')
        typed = p.pg.evaluate("document.getElementById('vagent_input').value")
        p.pg.locator('#vagent_send').tap(timeout=5000)
        p.pg.wait_for_timeout(1500)
    except Exception as e:      # a tap that cannot reach its target is the failure this test is for
        typed, exc = '', repr(e)[:200]
    sent = [(m, pa) for m, pa, _b, _h in ag.posts[n0:]]
    msgs = p.pg.evaluate("(document.getElementById('vagent_msgs')||{innerText:''}).innerText.slice(-300)")
    check(label + ' a message is written and sent by taps (to the stand-in agent), and shows in the chat',
          typed == 'ahoj, zkouška V-n' and any(m == 'POST' for m, _pa in sent) and 'zkouška V-n' in msgs and not exc, [typed, sent, msgs[-80:], exc])
    after = p.pg.evaluate(GEO)
    check(label + ' … after sending the input is still whole inside the screen', inside(after['input'], after) and after['inputHit'], after)
    check(label + ' no page errors', not errs, errs[:3])
    ctx.close()


# the honest finger test: the hit cross through the centre (elementFromPoint; the element, a child, or its label)
TARGETS = r"""(sel)=>[...document.querySelectorAll(sel)].filter(e=>e.checkVisibility()&&e.getBoundingClientRect().width>0).map(e=>{
  if(!e.closest('#right_panel .rp-sec[data-sec=camera]')) e.scrollIntoView({block:'center',inline:'nearest'});
  const b=e.getBoundingClientRect(), cx=b.left+b.width/2, cy=b.top+b.height/2;
  const own=h=>{if(!h) return false; if(h===e||e.contains(h)) return true; const l=h.closest('label'); return !!l&&(l.control===e||l.contains(e))};
  let hx=0, hy=0;
  for(let y=Math.max(0,b.top-30); y<Math.min(innerHeight,b.bottom+30); y++) if(own(document.elementFromPoint(cx,y))) hy++;
  for(let x=Math.max(0,b.left-30); x<Math.min(innerWidth,b.right+30); x++) if(own(document.elementFromPoint(x,cy))) hx++;
  return {id:e.id||e.className.toString().slice(0,24), box:[Math.round(b.width),Math.round(b.height)], hit:[hx,hy]}})"""

LOGCUT = r"""()=>{const c=document.getElementById('div_log_content'); const t=c.getBoundingClientRect().top+c.clientTop;
  const s=[...c.children].find(x=>{const r=x.getBoundingClientRect(); return r.bottom>t+0.5&&getComputedStyle(x).visibility!=='hidden'});
  if(!s) return {lines:c.children.length, shown:null}; const r=s.getBoundingClientRect();
  return {lines:c.children.length, cutPx:r.top<t-0.5?Math.round(r.bottom-t):0, first:(s.textContent||'').slice(0,30),
          toBottom:Math.round(c.scrollHeight-c.scrollTop-c.clientHeight), live:!!(window.log_panel&&log_panel.active.autoscroll)}}"""

HIST = [{'seq': i, 't': 1794100000 + i * 20, 'msg': m} for i, m in enumerate(
    ['Motors: enabled', 'Mower: READY', 'Navigation: goal reached', 'Localization: owner changed from gps to dr after a long outage of the corrections',
     'Dock: docked', 'Power: charging 2.4 A', 'GNSS: RTK FIX', 'Planner: program Front lawn waiting for the mowing window 08:00–20:00', 'Rain: none',
     'Motors: disabled'])]


def small(rows):
    return [r for r in rows if min(r['hit']) < 40]


def run_targets(b, url, lang, vp, label, shots, phone):
    """A848: the touch areas of the backlog targets and the log's top line."""
    ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone, service_workers='block', timezone_id='Europe/Prague')
    ctx.add_init_script("try{localStorage.setItem('vitulus_rightpanel_open','1');localStorage.setItem('vitulus_rightpanel_compact','0');"
                        "localStorage.setItem('vitulus_hud_log','1');localStorage.setItem('vitulus_log_expanded','0')}catch(e){}")
    p = T.Page(ctx, url, Agent(), lang)
    pg = p.pg
    pg.wait_for_timeout(1500)
    pg.evaluate("(h)=>__fake.json('/status_logger/history',h)", HIST)
    pg.wait_for_timeout(800)
    lc = pg.evaluate(LOGCUT)
    check(label + ' A848 the live small log shows no tail of an entry cut by its top edge', lc.get('lines', 0) >= 8 and lc.get('cutPx') == 0 and lc.get('live'), lc)
    if shots:
        pg.locator('#div_log_view').first.screenshot(path=os.path.join(shots, label + '-log-small.png'))
    if phone:
        cam = pg.evaluate(TARGETS, '.rp-cam-opt')
        check(label + ' A848 camera switch Off / S / L: each >= 40 x 40 px under the finger', len(cam) == 3 and not small(cam), cam)
        pg.evaluate("()=>{const h=document.querySelector('#right_panel .rp-sec[data-sec=state] > h5'); if(h&&h.parentElement.classList.contains('folded')) h.click()}")
        pg.wait_for_timeout(500)
        geo = pg.evaluate(TARGETS, '.rp-geo1')
        check(label + ' A848 the Map–GPS line (link to Map › Loc): >= 40 px tall under the finger', len(geo) == 1 and not small(geo), geo)
        lb = pg.evaluate(TARGETS, '#btn_log_expand')
        check(label + ' A848 the small log\'s ▲ (full log) >= 40 x 40 px', len(lb) == 1 and not small(lb), lb)
        pg.evaluate("document.getElementById('btn_log_expand').click()")
        pg.wait_for_timeout(700)
        tb = pg.evaluate(TARGETS, '#div_log_view .log-toolbar button')
        check(label + ' A848 the full log\'s keys (Changes, ROS, Live, Clear, ▼, ?) >= 40 x 40 px', len(tb) >= 6 and not small(tb), tb)
        lc = pg.evaluate(LOGCUT)
        check(label + ' A848 … the full log opens live at its newest line (was 26 px under the edge and Paused) and shows no cut tail at its top',
              lc.get('cutPx') == 0 and lc.get('toBottom', 99) <= 1 and lc.get('live'), lc)
        pg.evaluate("document.getElementById('btn_log_collapse').click()")
        pg.wait_for_timeout(400)
    sws = []
    for opener, tab in (('btn_autonomy', None), ('btn_map', 'tab-dock')):
        pg.evaluate("(i)=>document.getElementById(i).click()", opener)
        pg.wait_for_timeout(1200)
        if tab:
            pg.evaluate("(t)=>{const a=document.querySelector('a[href=\"#'+t+'\"]'); a&&a.click()}", tab)
            pg.wait_for_timeout(700)
        sws += pg.evaluate(TARGETS, '#ui_drawer .form-switch .form-check-input')
        if shots:
            pg.screenshot(path=os.path.join(shots, label + '-' + (tab or opener) + '.png'))
        pg.evaluate("()=>{const b=document.getElementById('btn_ui_drawer_close'); b&&b.click()}")
        pg.wait_for_timeout(500)
    check(label + ' A848 every on/off switch of Autonomy and Map › Dock is one size (the token, 44 x 24)',
          len(sws) >= 4 and len({tuple(r['box']) for r in sws}) == 1, sws)
    if phone:
        check(label + ' A848 … and each switch takes a finger (its row / label >= 40 x 40 px)', not small(sws), sws)
    check(label + ' A848 no page errors', not [e for e in p.errors if 'erases' not in e], p.errors[:3])
    ctx.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', default='')
    a = ap.parse_args()
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(T.Handler, directory=T.TPL))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/' % srv.server_port
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=False,
                               args=['--headless=new', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
        for lang, vp, label, narrow in (('cs', (360, 740), 'small-cs', True), ('en', (390, 844), 'phone-en', True), ('cs', (480, 900), 'edge480-cs', True),
                                        ('cs', (481, 900), 'edge481-cs', False), ('cs', (768, 1024), 'tablet-cs', False)):
            print('--- ' + label, flush=True)
            run(b, url, lang, vp, label, a.shots, narrow)
        for lang, vp, label, phone in (('cs', (360, 740), 'targets-360-cs', True), ('en', (390, 844), 'targets-390-en', True),
                                       ('cs', (1400, 900), 'targets-1400-cs', False)):
            print('--- ' + label, flush=True)
            run_targets(b, url, lang, vp, label, a.shots, phone)
        b.close()
    srv.shutdown()
    print('%s of %d checks' % ('%d FAILED' % len(FAILS) if FAILS else 'all ok', COUNT[0]))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
