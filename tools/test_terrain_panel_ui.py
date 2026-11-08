#!/usr/bin/env python3
"""Map › Terrain (T31) in real Chrome against a fake rosbridge: nothing reaches a robot.

The page is served from this tree on a private port; WebSocket is the fake of
test_autonomy_ui.py (answers subscribe, writes down every publish) plus a fake
terrain recorder by contract ~/vitulus/predavka/t31-teren-ui-kontrakt.md v1
(latched /terrain_recorder/state, answers on /terrain_recorder/cmd_result and in
state.last_cmd, delete_map / import replace with a token). The story (en, 1440 px):
  - the section sits between Map recording and Display, asks nothing while closed;
  - the terrain node and the recorder report: states, gate reason, numbers;
  - on/off, pause/resume send exactly their command;
  - delete: the first press only asks the recorder for a token (deletes nothing),
    Cancel / Esc send nothing more, the second press sends the token;
  - rebuild from a run: choose the mosaic and how; merge = one question, replace =
    the recorder's token + a question; a long command waits for its result;
  - refusal / bad token / no answer said in words; not running: nothing can be sent;
  - layer switches set the layers' own controls (live Traversability, Mowed area
    terrain), view, their opacity; "Show on map" moves the view to the candidate;
  - the only writes of the whole story are the recorder commands, no HTTP write.
Then every size 360 / 390 / 768 / 1440 in en and cs: no horizontal scroll, nothing
cut or sticking out of the section, touch targets on a phone.

    python3 tools/test_terrain_panel_ui.py [--shots DIR]

Needs python3-playwright + Google Chrome.
"""
import argparse
import functools
import http.server
import json
import os
import sys
import threading
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_autonomy_ui import FAKE, Handler, TPL  # noqa: E402

FAILS = []
COUNT = [0]
REC_CMD = '/terrain_recorder/cmd'
REC_STATE = '/terrain_recorder/state'
REC_RESULT = '/terrain_recorder/cmd_result'
NODE_STATS = '/traversability_local/stats'
NODE_CFG = '/traversability_local/config'

# a fake terrain recorder by the contract: state latched, answers on cmd_result + state.last_cmd
RECORDER = r"""
(() => {
  const F = window.__fake, W = window.WebSocket, orig = W.prototype.send;
  const R = window.__rec = { st: null, silent: false, refuse: '', long: false, delay: 0, tok: 0, v2: true };
  function pubState() { R.st.stamp = Date.now() / 1000; F.json('/terrain_recorder/state', R.st); }
  // v2: the latched state first, without the token (token_sent), then cmd_result with it (the race the UI
  // must survive); v1: cmd_result, then the state with the token
  function answer(c, ok, error, result) {
    const a = { id: c.id, cmd: c.cmd, ok: ok, error: error || null, result: result || {}, running: false };
    if (R.v2 && a.result.confirm_token) {
      R.st.last_cmd = Object.assign({}, a, { result: Object.assign({}, a.result, { confirm_token: null, token_sent: true }) });
      pubState();
      setTimeout(() => F.pub('/terrain_recorder/cmd_result', { data: JSON.stringify(a) }, false), 40);
      return;
    }
    R.st.last_cmd = a;
    F.pub('/terrain_recorder/cmd_result', { data: JSON.stringify(a) }, false);
    pubState();
  }
  function handle(c) {
    const s = R.st, m = s.map;
    if (R.refuse) { return answer(c, false, R.refuse); }
    if (c.cmd === 'enable') { s.enabled = true; s.paused = false; s.mode = 'waiting'; return answer(c, true, null, { enabled: true }); }
    if (c.cmd === 'disable') { s.enabled = false; s.mode = 'off'; return answer(c, true, null, { enabled: false }); }
    if (c.cmd === 'pause') { s.paused = true; s.mode = 'paused'; return answer(c, true, null, { paused: true }); }
    if (c.cmd === 'resume') { s.paused = false; s.mode = 'waiting'; return answer(c, true, null, { paused: false }); }
    if (c.cmd === 'list') { return answer(c, true, null, { imports: s.imports, backups: s.backups }); }
    if (c.cmd === 'rebuild_export') {       // v2: queued; export.running, then a new version
      answer(c, true, null, { queued: true });
      setTimeout(() => { s.export = Object.assign({}, s.export, { running: true }); pubState(); }, 300);
      setTimeout(() => { s.export = { version: (s.export.version || 0) + 1, stamp: Date.now() / 1000, ok: true, error: null, running: false }; pubState(); }, 900);
      return;
    }
    if (c.cmd === 'import' && c.name === 'gone') { return answer(c, false, 'unknown_import'); }
    const needTok = c.cmd === 'delete_map' || (c.cmd === 'import' && c.mode === 'replace');
    if (needTok && !c.confirm) { R.tok++; return answer(c, true, null, { confirm_token: 'tok' + R.tok, expires_s: 60, site: s.site, area_m2: m.area_m2, tiles: m.tiles }); }
    if (needTok && c.confirm !== 'tok' + R.tok) { return answer(c, false, 'bad_token'); }
    const done = () => {
      if (c.cmd === 'delete_map') { s.backups.push({ name: '20261108-231500', area_m2: m.area_m2 }); m.area_m2 = 0; m.tiles = 0; s.nogo_candidates = []; return answer(c, true, null, { backup: '20261108-231500' }); }
      if (c.cmd === 'import') { m.area_m2 += 50; return answer(c, true, null, { imported_cells: 20000, height_offset_m: 0.01, backup: c.mode === 'replace' ? '20261108-232000' : null }); }
      answer(c, false, 'unknown_cmd');
    };
    if (R.long) { s.last_cmd = { id: c.id, cmd: c.cmd, ok: null, running: true }; pubState(); setTimeout(done, 1500); return; }
    // v1 recorder (no "running"): silent while it holds its lock, then the answer
    if (R.delay) { setTimeout(done, R.delay); return; }
    done();
  }
  W.prototype.send = function (raw) {
    orig.call(this, raw);
    let m = null; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || m.op !== 'publish' || m.topic !== '/terrain_recorder/cmd' || !R.st || R.silent) { return; }
    let c = {}; try { c = JSON.parse(m.msg.data); } catch (e) { return; }
    setTimeout(() => handle(c), 30);
  };
  R.set = (s) => { R.st = s; pubState(); };
})();
"""


def check(name, ok, detail=''):
    COUNT[0] += 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:400]), flush=True)
    if not ok:
        FAILS.append(name)


def diag(level=0, message='ok', **over):
    kv = {'cpu_process_pct': '23.40', 'features_ms_avg': '11.20', 'integrate_ms_avg': '4.10', 'cloud_hz': '14.80',
          'features_hz': '1.90', 'tf_failures': '0', 'exempt_zones_active': '0', 'exempt_zones_missing_tf': '0', 'epoch': '3',
          'epoch_events': '3', 'epoch_last_reason': 'gps jump', 'settling': '0', 'frames': '74', 'node_latency_ms_p95': '38.00'}
    kv.update({k: str(v) for k, v in over.items()})
    return {'level': level, 'name': '/traversability_local: traversability', 'message': message, 'hardware_id': 'd435',
            'values': [{'key': k, 'value': v} for k, v in kv.items()]}


CONFIG = {'version': 2, 'seq': 4, 'map_frame': 'odom', 'length': 6.0, 'resolution': 0.05, 'costmap_layer': 'cost',
          'persist': True, 'last': None,
          'values': {'step_crit': 0.1, 'slope_crit_deg': 22.0, 'feature_max_variance': 0.00020000000000000001,
                     'a_very_long_parameter_name_for_the_layout_check': 1.5},
          'defaults': {'step_crit': 0.08, 'slope_crit_deg': 22.0, 'feature_max_variance': 0.00020000000000000001,
                       'a_very_long_parameter_name_for_the_layout_check': 1.5},
          'ranges': {'step_crit': [0.02, 0.3], 'slope_crit_deg': [5, 45], 'feature_max_variance': [0.000001, 1],
                     'a_very_long_parameter_name_for_the_layout_check': [0, 10]}}


def rec_state(**over):
    now = time.time()
    s = {'v': 1, 'stamp': now, 'running': True, 'enabled': True, 'paused': False, 'mode': 'waiting',
         'site': 'demo_garden_with_a_rather_long_name', 'gate': {'open': False, 'reason': 'hAcc 80 mm', 'open_for_s': 0},
         'subscribed': False,
         'map': {'area_m2': 412.37, 'tiles': 9, 'known_cells': 160000, 'last_fused': now - 400, 'last_fused_age_s': 400,
                 'last_write': now - 300, 'session': 2},
         'localisation': {'epoch': 3, 'settling': False, 'corrections': 0},
         'load': {'cpu_pct': 3.6, 'rss_mb': 63.0, 'fuse_ms_avg': 3.9, 'fuse_ms_p95': 7.1},
         'export': {'version': 41, 'stamp': now - 300, 'dir': 'terrain_mosaic', 'ok': True, 'error': None},
         'nogo_candidates': [{'id': 'k1', 'kind': 'step', 'area_m2': 0.42, 'cells': 168, 'centroid': [1.5, -2.0],
                              'polygon': [[1.2, -2.3], [1.8, -2.3], [1.8, -1.7], [1.2, -1.7]]},
                             {'id': 'k2', 'kind': 'slope', 'area_m2': 4.0, 'cells': 1600, 'centroid': [5, 5],
                              'polygon': [[4, 4], [6, 4], [6, 6], [4, 6]]}],
         'imports': [{'name': 'bigger_2026-11-08', 'path': 'terrain_import/bigger_2026-11-08'},
                     {'name': 'smaller_zone_a_rather_long_mosaic_name_2026-11-07', 'path': 'terrain_import/x'}],
         'backups': [{'name': '20261101-101500', 'area_m2': 300.0}],
         'last_cmd': None}
    s.update(over)
    return s


class P(object):
    def __init__(self, ctx, url, lang):
        self.pg = ctx.new_page()
        self.errors = []
        self.reqs = []
        # the fake answers ros3d's interactive-marker get_init with nothing: its
        # "erases" error is the harness's, not the page's
        self.pg.on('pageerror', lambda e: None if "'erases'" in str(e) else self.errors.append(str(e)))
        self.pg.on('request', lambda r: self.reqs.append((r.method, r.url)))
        self.pg.add_init_script(FAKE)
        self.pg.add_init_script(RECORDER)
        # the webnode's list of terrain maps (GET /api/terrain_mosaic): the robot's map + one mowing
        now = time.time()
        mos = {'ok': True, 'site': 'demo', 'ts': int(now), 'mosaics': [
            {'name': 'teren_demo', 'source': 'terrain_recorder', 'area_m2': 412.4, 'version': 41, 'mtime': now - 300,
             'generated_unix': now - 300, 'frame': 'map', 'resolution': 0.05, 'width': 40, 'height': 40, 'yaw': 0,
             'origin_x': 0, 'origin_y': 0, 'files': {'cost_rgba': 'teren_demo_cost_rgba.png', 'reason': 'teren_demo_reason.png'}},
            {'name': 'bigger_2026-11-08', 'mtime': now - 86400, 'frame': 'map', 'resolution': 0.05, 'width': 40, 'height': 40,
             'yaw': 0, 'origin_x': 0, 'origin_y': 0, 'files': {'cost_rgba': 'bigger_cost_rgba.png', 'reason': 'bigger_reason.png'}}]}
        self.pg.route('**/api/terrain_mosaic', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(mos)))
        self.pg.add_init_script('try{localStorage.setItem("vitulus_lang",%r)}catch(e){}' % lang)
        self.pg.goto(url, wait_until='domcontentloaded')
        self.pg.wait_for_function('window.VTTerrainPanel && VTTerrainPanel._S.sec && window.VTI18n && window.mapping_v3', timeout=30000)
        self.pg.wait_for_timeout(1200)
        self.pg.evaluate('(l)=>VTI18n.setLang?VTI18n.setLang(l):VTI18n.set(l)', lang)
        self.pg.wait_for_timeout(300)

    def ev(self, js, arg=None):
        return self.pg.evaluate(js, arg)

    def json(self, topic, o):
        self.ev('([t,o])=>__fake.json(t,o)', [topic, o])

    def raw(self, topic, m):
        self.ev('([t,m])=>__fake.pub(t,m)', [topic, m])

    def rec(self, st):
        self.ev('(s)=>__rec.set(s)', st)

    def text(self, sel):
        return self.ev('(s)=>{const e=document.querySelector(s);return e?e.textContent:null}', sel)

    def shown(self, sel):
        return self.ev('(s)=>{const e=document.querySelector(s);return !!(e&&e.offsetParent&&!e.closest("[hidden]"))}', sel)

    def sent(self, topic):
        return self.ev('(t)=>__fake.of(t).map(x=>x.msg)', topic)

    def cmds(self):
        return [json.loads(m['data']) for m in self.sent(REC_CMD)]

    def names(self):
        return [c['cmd'] for c in self.cmds()]

    def until(self, js, ms=6000, arg=None):
        end = time.time() + ms / 1000.0
        while time.time() < end:
            if self.ev(js, arg):
                return True
            self.pg.wait_for_timeout(120)
        return False

    def msg(self):
        return self.text('[data-tp="rec"] .vt-tp-msg') or ''

    def meta(self, key):
        return self.text('[data-tp="%s"] .vt-tp-meta' % key)

    def open(self):
        self.ev("""()=>{ const m=document.getElementById('div_menu_map');
                   if (!m || getComputedStyle(m).display==='none') document.getElementById('btn_map').click(); }""")
        self.pg.wait_for_timeout(400)
        self.ev("""()=>{ const a=document.querySelector('a[href="#tab-map"]'); if (a) a.click(); }""")
        self.pg.wait_for_timeout(200)
        self.ev("""()=>{ const d=document.getElementById('mapv3_sec_terrain'); if (!d.open) d.querySelector('summary').click(); }""")
        self.pg.wait_for_timeout(1300)      # the panel's 1 s tick subscribes

    def click(self, sel):
        self.pg.locator(sel).first.click()
        self.pg.wait_for_timeout(250)

    def tick(self, ms=1100):
        self.pg.wait_for_timeout(ms)


def story(p, shots):
    # ---- placement and cost while closed
    order = p.ev("""()=>[...document.querySelectorAll('#tab-map > details.map-sec')].map(d=>d.getAttribute('data-mapsec'))""")
    i = order.index('terrain') if 'terrain' in order else -1
    check('section between Map recording and Display', i > 0 and order[i - 1] == 'session' and order[i + 1] == 'layers', order)
    subs0 = p.ev('()=>Object.keys(__fake.subs)')
    check('closed: no terrain topic asked', not any(t in subs0 for t in (NODE_STATS, REC_STATE, NODE_CFG, REC_RESULT)), subs0)
    sent0 = p.ev('()=>__fake.sent.length')
    p.open()
    subs = p.ev('()=>Object.keys(__fake.subs)')
    check('open: node stats, config, recorder state and results subscribed',
          all(t in subs for t in (NODE_STATS, REC_STATE, NODE_CFG, REC_RESULT)), subs)
    check('waiting before the first reports', p.meta('node') == 'asking…' and p.meta('rec') == 'asking…',
          [p.meta('node'), p.meta('rec')])
    check('nothing can be sent before the recorder answers',
          p.ev('()=>["toggle","pause","rebuild","clear"].every(a=>document.querySelector("[data-tp-act="+a+"]").disabled)'))

    # ---- reports
    p.raw(NODE_STATS, diag())
    p.json(NODE_CFG, CONFIG)
    p.rec(rec_state())
    p.tick(400)
    check('node running', p.meta('node') == 'running' and
          p.ev('()=>document.querySelector("[data-tp=node]").getAttribute("data-state")') == 'ok')
    facts = p.ev("""()=>Object.fromEntries([...document.querySelectorAll('[data-tp=node] .vt-tp-fact')].map(f=>[f.querySelector('.vt-tp-fk').getAttribute('data-k'), f.querySelector('.vt-tp-fv').textContent]))""")
    check('node numbers', facts.get('cpu') == '23 %' and facts.get('ms') == '11.2 ms' and facts.get('hz') == '15/s'
          and facts.get('tf') == '0' and facts.get('zone') == 'none' and facts.get('epoch') == '3', facts)
    check('recorder waiting: gate closed with the reason', p.meta('rec') == 'gate closed' and
          'GPS accuracy 8' in (p.text('[data-tp="rec"] .vt-tp-sub') or '') and
          p.text('[data-tp="rec"] .vt-tp-main').startswith('Switched on, but'), [p.text('[data-tp="rec"] .vt-tp-sub'), p.text('[data-tp="rec"] .vt-tp-main')])
    check('a closed gate is info, not a warning', p.ev('()=>document.querySelector("[data-tp=rec]").getAttribute("data-state")') == 'info')
    rf = p.ev("""()=>Object.fromEntries([...document.querySelectorAll('[data-tp=rec] .vt-tp-fact')].map(f=>[f.querySelector('.vt-tp-fk').getAttribute('data-k'), f.querySelector('.vt-tp-fv').textContent]))""")
    check('area, last write, place', rf.get('area') == '412 m²' and rf.get('write') == '5 min ago' and rf.get('gate') == 'closed'
          and rf.get('site', '').startswith('demo_garden'), rf)
    check('summary pill says gate closed', p.text('#mapv3_sec_terrain .vt-tp-summ') == 'gate closed')
    check('two candidates listed', p.ev('()=>document.querySelectorAll(".vt-tp-cand").length') == 2 and p.meta('cands') == 'to review: 2')
    check('candidate line', p.text('.vt-tp-cand .vt-tp-ckind') == 'step' and '1.5' in (p.text('.vt-tp-cand .vt-tp-cmeta') or ''),
          p.text('.vt-tp-cand'))
    p.ev('()=>{const d=document.querySelector(".vt-tp-params"); d.open=true;}')
    p.tick(200)
    check('parameters read only, changed marked, small values kept', p.ev('()=>document.querySelectorAll(".vt-tp-prow").length') == 4 and
          p.ev('()=>document.querySelectorAll(".vt-tp-prow.is-changed").length') == 1 and
          p.ev('()=>!document.querySelector(".vt-tp-params input, .vt-tp-params button")') and
          '0.0002' in p.ev('()=>document.querySelector(".vt-tp-plist").textContent'))
    p.rec(rec_state(mode='recording', gate={'open': True, 'reason': 'ok', 'open_for_s': 40}))
    p.tick(300)
    check('recording', p.meta('rec') == 'on' and p.text('#mapv3_sec_terrain .vt-tp-summ') == 'on' and not p.shown('[data-tp="rec"] .vt-tp-sub'))
    p.rec(rec_state(mode='waiting', gate={'open': False, 'reason': 'owner dock', 'open_for_s': 0}))
    p.tick(300)
    check('in the dock said in words', p.text('[data-tp="rec"] .vt-tp-sub') == 'Gate closed: the robot is in the dock.')
    check('opening the panel sent nothing', p.ev('(n)=>__fake.sent.slice(n).filter(x=>/terrain|traversab/.test(x.topic)).length', sent0) == 0)

    # ---- on / off, pause / resume
    p.click('[data-tp-act="toggle"]')
    check('switch off sends disable', p.until('()=>document.querySelector("[data-tp=rec] .vt-tp-meta").textContent==="off"') and p.names() == ['disable'], p.names())
    check('answer said', p.msg() == 'Building the map is off.', p.msg())
    check('off: pause offered no more, switch unchecked', p.ev('()=>document.querySelector("[data-tp-act=pause]").disabled') and
          p.ev('()=>document.querySelector("[data-tp-act=toggle]").getAttribute("aria-checked")') == 'false')
    p.click('[data-tp-act="toggle"]')
    check('switch on sends enable', p.until('()=>document.querySelector("[data-tp=rec] .vt-tp-meta").textContent==="gate closed"') and p.names()[-1] == 'enable')
    p.click('[data-tp-act="pause"]')
    check('pause sends pause', p.until('()=>document.querySelector("[data-tp=rec] .vt-tp-meta").textContent==="paused"') and p.names()[-1] == 'pause')
    check('paused: the button resumes', p.text('[data-tp-act="pause"]') == 'Resume')
    p.click('[data-tp-act="pause"]')
    check('resume sends resume', p.until('()=>document.querySelector("[data-tp=rec] .vt-tp-meta").textContent==="gate closed"') and p.names()[-1] == 'resume')

    # ---- delete: token, question, second press
    n = len(p.cmds())
    p.click('[data-tp-act="clear"]')
    ok1 = p.until('()=>!document.querySelector(".vt-tp-confirm").hidden')
    c1 = p.cmds()[n:]
    check('delete step 1: asks the recorder for a token only', ok1 and len(c1) == 1 and c1[0]['cmd'] == 'delete_map' and 'confirm' not in c1[0], c1)
    ct = p.text('.vt-tp-ctext') or ''
    check('the question names the place, area and tiles; the backup is said', 'demo_garden' in ct and '412' in ct and '9 tiles' in ct and
          'backup' in (p.text('.vt-tp-cbackup') or '') and 'backups now: 1' in (p.text('.vt-tp-cbackup') or ''), [ct, p.text('.vt-tp-cbackup')])
    if shots:
        pages(p, shots, 'confirm-desk-en')
    p.click('[data-tp-act="flow-no"]')
    check('Cancel closes and sends nothing more', len(p.cmds()) == n + 1 and not p.shown('.vt-tp-confirm'))
    p.click('[data-tp-act="clear"]')
    p.until('()=>!document.querySelector(".vt-tp-confirm").hidden')
    esc0 = p.ev('()=>__fake.sent.length')
    p.pg.keyboard.press('Escape')
    p.tick(200)
    esc1 = p.ev('()=>__fake.sent.length')
    check('Esc closes the question, no recorder command', len(p.cmds()) == n + 2 and not p.shown('.vt-tp-confirm'))
    # Esc is also the robot's STOP everywhere (T8 D11): its publishes are the STOP's
    stop = p.ev('([a,b])=>[...new Set(__fake.sent.slice(a,b).map(x=>x.topic))]', [esc0, esc1])
    check('Esc still stops the robot (global STOP)', '/mower_smach/stop' in stop, stop)
    p.click('[data-tp-act="clear"]')
    p.until('()=>!document.querySelector(".vt-tp-confirm").hidden')
    p.click('[data-tp-act="flow-yes"]')
    check('second press sends the token', p.until('()=>/backup 2026/.test(document.querySelector(".vt-tp-msg").textContent)') and
          p.cmds()[-1] == {'id': p.cmds()[-1]['id'], 'cmd': 'delete_map', 'confirm': 'tok3'}, p.cmds()[-1])
    check('after delete: no candidates, backup said', p.until('()=>document.querySelectorAll(".vt-tp-cand").length===0') and
          p.text('.vt-tp-cempty') == 'No candidates.' and '20261108-231500' in p.msg(), p.msg())
    # an old token
    p.click('[data-tp-act="clear"]')
    p.until('()=>!document.querySelector(".vt-tp-confirm").hidden')
    p.ev('()=>{__rec.tok++}')       # the token the page holds is no longer the recorder's
    p.click('[data-tp-act="flow-yes"]')
    check('an expired token said in words', p.until('()=>/expired/.test(document.querySelector(".vt-tp-msg").textContent)'), p.msg())

    # ---- rebuild from a run: merge
    p.rec(rec_state())
    p.tick(300)
    n = len(p.cmds())
    p.click('[data-tp-act="rebuild"]')
    check('rebuild: the chooser, nothing sent', len(p.cmds()) == n and p.shown('.vt-tp-choose') and
          p.ev('()=>document.querySelector(".vt-tp-sel").options.length') == 2 and
          p.ev('()=>document.querySelector("[data-tp-imode=merge]").getAttribute("aria-checked")') == 'true')
    p.click('[data-tp-act="flow-yes"]')
    check('merge: one question, nothing sent yet', len(p.cmds()) == n and 'Add the mosaic bigger_2026-11-08' in (p.text('.vt-tp-ctext') or ''),
          p.text('.vt-tp-ctext'))
    p.click('[data-tp-act="flow-yes"]')
    c = p.cmds()[-1] if len(p.cmds()) > n else {}
    check('merge sends import mosaic merge', p.until('()=>/Done: 20000 cells/.test(document.querySelector(".vt-tp-msg").textContent)') and
          c.get('cmd') == 'import' and c.get('source') == 'mosaic' and c.get('mode') == 'merge' and c.get('name') == 'bigger_2026-11-08'
          and 'confirm' not in c, c)
    # replace: the other mosaic, a token, a long command
    n = len(p.cmds())
    p.click('[data-tp-act="rebuild"]')
    p.ev('()=>{const s=document.querySelector(".vt-tp-sel"); s.value=s.options[1].value; s.dispatchEvent(new Event("change"))}')
    p.click('[data-tp-imode="replace"]')
    if shots:
        pages(p, shots, 'choose-desk-en')
    p.click('[data-tp-act="flow-yes"]')
    p.until('()=>/Replace the terrain map/.test(document.querySelector(".vt-tp-ctext").textContent)')
    c1 = p.cmds()[n:]
    check('replace step 1: import replace without confirm (token asked)', len(c1) == 1 and c1[0]['mode'] == 'replace' and
          c1[0]['name'].startswith('smaller_zone') and 'confirm' not in c1[0], c1)
    check('replace question with the backup', 'backup' in (p.text('.vt-tp-cbackup') or '') and p.text('[data-tp-act="flow-yes"]') == 'Replace the map')
    p.ev('()=>{__rec.long=true}')
    p.click('[data-tp-act="flow-yes"]')
    check('a long command: working said, buttons wait', p.until('()=>/Working on it/.test(document.querySelector(".vt-tp-msg").textContent)', 3000) and
          p.ev('()=>document.querySelector("[data-tp-act=clear]").disabled'), p.msg())
    check('…then its result', p.until('()=>/Done: 20000/.test(document.querySelector(".vt-tp-msg").textContent)', 5000) and
          p.cmds()[-1].get('confirm') == 'tok%d' % p.ev('()=>__rec.tok'), p.cmds()[-1])
    p.ev('()=>{__rec.long=false}')
    # without "running" (v1: the recorder only answers when done, silent meanwhile): waits, never "not running"
    p.ev('()=>{__rec.delay=2500}')
    p.click('[data-tp-act="rebuild"]')
    p.click('[data-tp-act="flow-yes"]')
    p.click('[data-tp-act="flow-yes"]')
    p.tick(400)
    p.ev('()=>{const S=VTTerrainPanel._S; S.recRx-=30000; VTTerrainPanel.paint()}')
    check('without "running": working said, not "not running" while silent', 'Working on it' in p.msg() and
          p.meta('rec') != 'not running', [p.msg(), p.meta('rec')])
    check('…and the late result taken', p.until('()=>/Done: 20000/.test(document.querySelector(".vt-tp-msg").textContent)', 5000), p.msg())
    # an answer after the panel stopped waiting still shows
    p.ev('()=>{__rec.delay=1800; VTTerrainPanel.CONTRACT.rec.heavyMs=500}')
    p.click('[data-tp-act="rebuild"]')
    p.click('[data-tp-act="flow-yes"]')
    p.click('[data-tp-act="flow-yes"]')
    check('too long: "not answered yet" said', p.until('()=>/not answered yet/.test(document.querySelector(".vt-tp-msg").textContent)', 3000), p.msg())
    check('…and the answer after it still said', p.until('()=>/Done: 20000/.test(document.querySelector(".vt-tp-msg").textContent)', 4000), p.msg())
    p.ev('()=>{__rec.delay=0; VTTerrainPanel.CONTRACT.rec.heavyMs=90000}')
    # a mosaic that is gone: back to the choice
    p.rec(rec_state(imports=[{'name': 'gone', 'path': 'terrain_import/gone'}]))
    p.tick(300)
    p.click('[data-tp-act="rebuild"]')
    p.click('[data-tp-act="flow-yes"]')
    p.click('[data-tp-act="flow-yes"]')
    check('unknown mosaic: said, the choice with Refresh list back', p.until('()=>/no longer on the robot/.test(document.querySelector(".vt-tp-msg").textContent)') and
          p.shown('.vt-tp-choose') and p.shown('[data-tp-act="list"]'), p.msg())
    p.click('[data-tp-act="flow-no"]')
    # v1 recorder: the token also in the latched state
    p.ev('()=>{__rec.v2=false}')
    p.rec(rec_state())
    p.tick(300)
    nn = len(p.cmds())
    p.click('[data-tp-act="clear"]')
    check('v1 recorder: delete question too', p.until('()=>!document.querySelector(".vt-tp-confirm").hidden') and len(p.cmds()) == nn + 1)
    p.click('[data-tp-act="flow-no"]')
    p.ev('()=>{__rec.v2=true}')
    # refresh the list
    p.click('[data-tp-act="rebuild"]')
    p.click('[data-tp-act="list"]')
    check('Refresh list sends list', p.until('()=>/up to date/.test(document.querySelector(".vt-tp-msg").textContent)') and p.names()[-1] == 'list')
    p.click('[data-tp-act="flow-no"]')
    # no mosaics
    p.rec(rec_state(imports=[]))
    p.tick(300)
    p.click('[data-tp-act="rebuild"]')
    check('no mosaic: said, Continue disabled', 'later version' in (p.text('.vt-tp-cbackup') or '') and
          p.ev('()=>document.querySelector("[data-tp-act=flow-yes]").disabled'))
    p.click('[data-tp-act="flow-no"]')
    # export error
    p.rec(rec_state(export={'version': 41, 'ok': False, 'error': 'disk full'}))
    p.tick(300)
    check('export error said in words with a button (detail only as tooltip)', p.shown('.vt-tp-exp') and 'disk full' not in (p.text('.vt-tp-exp') or '')
          and p.ev('()=>document.querySelector(".vt-tp-exp .vt-tp-sub").title') == 'disk full')
    p.click('[data-tp-act="export"]')
    check('rebuild_export queued: "being made"', p.until('()=>/being made/.test(document.querySelector(".vt-tp-msg").textContent)', 2000) and
          p.names()[-1] == 'rebuild_export', p.msg())
    check('…made when the export is done (new version)', p.until('()=>/picture is made again/.test(document.querySelector(".vt-tp-msg").textContent)', 3000), p.msg())

    # ---- refused, no answer
    p.ev('()=>{__rec.refuse="internal: boom"}')
    p.click('[data-tp-act="pause"]')
    check('unknown refusal said generally, code only as tooltip', p.until('()=>/refused the command/.test(document.querySelector(".vt-tp-msg").textContent)') and
          p.ev('()=>document.querySelector(".vt-tp-msg").title') == 'internal: boom', p.msg())
    p.ev('()=>{__rec.refuse=""; __rec.silent=true; VTTerrainPanel.CONTRACT.rec.answerMs=700}')
    p.click('[data-tp-act="pause"]')
    check('buttons wait while a command is out', p.ev('()=>document.querySelector("[data-tp-act=clear]").disabled'))
    check('no answer said', p.until('()=>/not answered yet/.test(document.querySelector(".vt-tp-msg").textContent)', 3000))
    p.ev('()=>{__rec.silent=false; VTTerrainPanel.CONTRACT.rec.answerMs=8000}')

    # ---- other states
    p.rec(rec_state(mode='no_site', site=None))
    p.tick(300)
    check('no site: said, only on/off', p.meta('rec') == 'no map' and not p.ev('()=>document.querySelector("[data-tp-act=toggle]").disabled')
          and p.ev('()=>document.querySelector("[data-tp-act=clear]").disabled'))
    p.rec(rec_state(running=False))
    p.tick(300)
    check('running false: not running, nothing can be sent', p.meta('rec') == 'not running' and
          p.ev('()=>["toggle","pause","rebuild","clear"].every(a=>document.querySelector("[data-tp-act="+a+"]").disabled)') and
          'installed and allowed' in (p.text('[data-tp="rec"] .vt-tp-sub') or ''), p.text('[data-tp="rec"] .vt-tp-sub'))
    p.ev('()=>{const S=VTTerrainPanel._S; S.nodeRx-=60000; S.nodeSubAt-=60000; VTTerrainPanel.paint()}')
    check('silent node: not running + hint', p.meta('node') == 'not running' and 'starts with the robot' in (p.text('[data-tp="node"] .vt-tp-sub') or ''))
    p.raw(NODE_STATS, diag(1, 'TF failures, CPU over budget', tf_failures=4, settling=1, exempt_zones_active=1))
    p.rec(rec_state())
    p.tick(300)
    check('node warning listed, dock zone applied', p.meta('node') == 'running · warning' and
          p.text('[data-tp="node"] .vt-tp-sub') == 'some pictures could not be placed · uses more processor than it should' and
          p.ev('()=>[...document.querySelectorAll("[data-tp=node] .vt-tp-fv")].map(e=>e.textContent).includes("applied")'))

    # ---- layers
    check('both layer switches present', p.ev('()=>!!document.getElementById("mapv3_chk_trav") && !!document.getElementById("mapv3_chk_tmosaic")') and
          not p.ev('()=>document.querySelector("[data-tp-layer=trav]").disabled') and not p.ev('()=>document.querySelector("[data-tp-layer=mosaic]").disabled'))
    p.click('[data-tp-layer="trav"]')
    check('switch ticks the live layer (its own control)', p.ev('()=>document.getElementById("mapv3_chk_trav").checked') and
          p.ev('()=>localStorage.getItem("vitulus_layer_trav")') == '1' and
          p.ev('()=>document.querySelector("[data-tp-layer=trav]").getAttribute("aria-checked")') == 'true')
    check('the live layer subscribes its topic', p.until('()=>"/traversability/ui" in __fake.subs', 3000))
    p.click('[data-tp-layer="mosaic"]')
    check('mosaic switch ticks the mosaic layer', p.ev('()=>document.getElementById("mapv3_chk_tmosaic").checked') and
          p.ev('()=>localStorage.getItem("vitulus_layer_tmosaic")') == '1')
    check('layer names are the layers\' own', p.text('[data-tp-layer="trav"] .vt-tp-ln') == p.ev('()=>VTI18n.t("trav.layer")') and
          p.text('[data-tp-layer="mosaic"] .vt-tp-ln') == p.ev('()=>VTI18n.t("tmos.layer")'))
    check('which terrain map: a choice of two, the robot\'s map first', p.until('()=>{const s=document.querySelector("[data-tp-pick]"); return s && s.offsetParent && s.options.length===2}', 4000) and
          p.ev('()=>document.querySelector("[data-tp-pick]").value') == 'teren_demo' and
          p.ev('()=>document.querySelector("[data-tp-pick]").options[0].textContent').startswith(p.ev('()=>VTI18n.t("tmos.recorder")')))
    p.ev('()=>{const s=document.querySelector("[data-tp-pick]"); s.value="bigger_2026-11-08"; s.dispatchEvent(new Event("change",{bubbles:true}))}')
    p.tick(300)
    check('picking a map goes through the layer (remembered)', p.ev('()=>VTTerrainMosaic.info().mosaic.name') == 'bigger_2026-11-08' and
          p.ev('()=>localStorage.getItem("vitulus_layer_tmosaic_pick")') == 'bigger_2026-11-08')
    p.click('[data-tp-mode="reason"]')
    check('view Reason sets both layers', p.ev('()=>document.getElementById("mapv3_trav_mode").value') == 'reason' and
          p.ev('()=>document.getElementById("mapv3_tmosaic_mode").value') == 'reason')
    check('reason legend with names', p.ev('()=>document.querySelectorAll(".vt-tp-reason").length') == 7)
    p.click('[data-tp-mode="cost"]')
    check('view Traversability', p.ev('()=>document.getElementById("mapv3_trav_mode").value') == 'cost' and
          p.ev('()=>document.querySelector("[data-tp-mode=cost]").getAttribute("aria-pressed")') == 'true' and p.shown('.vt-tp-legend .vt-tp-grad'))
    check('height offered only when sent', p.ev('()=>document.querySelector("[data-tp-mode=height]").disabled'))
    p.ev('()=>{const r=document.querySelector("[data-tp-op=trav]"); r.value="50"; r.dispatchEvent(new Event("input",{bubbles:true}))}')
    check('live opacity = its own (the shared one untouched)', abs(float(p.ev('()=>document.getElementById("mapv3_trav_op").value')) - 0.5) < 1e-6 and
          p.ev('()=>localStorage.getItem("vitulus_layer_trav_op")') == '0.5' and p.ev('()=>document.getElementById("mapv3_maps_opacity").value') == '100')
    p.ev('()=>{const r=document.querySelector("[data-tp-op=trav]"); r.value="100"; r.dispatchEvent(new Event("input",{bubbles:true}))}')
    p.ev('()=>{const r=document.querySelector("[data-tp-op=mosaic]"); r.value="40"; r.dispatchEvent(new Event("input",{bubbles:true}))}')
    check('mosaic opacity = its own', abs(float(p.ev('()=>document.getElementById("mapv3_tmosaic_op").value')) - 0.4) < 1e-6 and
          p.ev('()=>localStorage.getItem("vitulus_layer_tmosaic_op")') == '0.4' and
          p.ev('()=>document.getElementById("mapv3_maps_opacity").value') == '100')
    p.click('[data-tp-layer="trav"]')
    p.click('[data-tp-layer="mosaic"]')
    check('switch both off again', not p.ev('()=>document.getElementById("mapv3_chk_trav").checked || document.getElementById("mapv3_chk_tmosaic").checked'))

    # ---- show on map
    p.click('.vt-tp-cand [data-tp-act="show"]')
    pos = p.ev("""()=>{const V=window.viewer&&viewer.viewer; if(!V) return null; const T=ROS3D.THREE;
        const v=new T.Vector3(1.5,-2,0).project(V.camera); const c=V.renderer.domElement.getBoundingClientRect();
        const d=document.getElementById('ui_drawer').getBoundingClientRect();
        return {x:c.left+(v.x+1)/2*c.width, y:c.top+(1-v.y)/2*c.height, dr:d.right, cw:c.right, ch:c.bottom, ring:!!VTTerrainPanel._S.ring}}""")
    check('show on map: the place is in the free part of the map, ringed', pos and pos['ring'] and pos['x'] > pos['dr'] - 1 and
          pos['x'] < pos['cw'] and 0 < pos['y'] < pos['ch'], pos)

    # ---- writes of the whole story
    topics = p.ev('([n,a,b])=>[...new Set(__fake.sent.slice(n).filter((x,i)=>i+n<a||i+n>=b).map(x=>x.topic))]', [sent0, esc0, esc1])
    check('the only ROS writes are the recorder commands', topics == [REC_CMD], topics)
    allowed = {'enable', 'disable', 'pause', 'resume', 'delete_map', 'import', 'list', 'rebuild_export'}
    check('only commands of the contract', set(p.names()) <= allowed, p.names())
    toks = [c for c in p.cmds() if 'confirm' in c]
    check('tokens sent only three times (delete, old token, replace)', len(toks) == 3, toks)
    # closing the section: no subscription and no command publisher left
    p.ev('()=>{VTTerrainPanel._S.late={}}')     # the unanswered commands of the story no longer waited for
    p.ev('()=>{const d=document.getElementById("mapv3_sec_terrain"); d.open=false;}')
    p.tick(1300)
    check('closed, nothing pending: publisher and subscriptions dropped', p.ev('()=>{const S=VTTerrainPanel._S; return !S.recPub && !S.resSub && !S.recSub && !S.nodeSub}'))
    writes = [r for r in p.reqs if r[0] not in ('GET', 'HEAD') and '/api/ui_settings' not in r[1]]
    check('no HTTP write', not writes, writes)
    check('no page errors', not p.errors, p.errors)
    if shots:
        p.pg.screenshot(path=os.path.join(shots, 'story-desk-en-map.png'))


def pages(p, shots, name):
    """The section as the user scrolls it: viewport shots from its top to its bottom."""
    k = 0
    p.ev("""()=>document.getElementById('mapv3_sec_terrain').scrollIntoView({block:'start'})""")
    while k < 8:
        p.tick(150)
        p.pg.screenshot(path=os.path.join(shots, '%s-%d.png' % (name, k)))
        k += 1
        more = p.ev("""()=>{const s=document.getElementById('mapv3_sec_terrain'), r=s.getBoundingClientRect();
            if (r.bottom <= innerHeight - 40) return false;
            let e=s.parentElement; while (e && !(e.scrollHeight>e.clientHeight+2 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e=e.parentElement;
            if (!e) return false; const before=e.scrollTop; e.scrollTop += Math.max(120, e.clientHeight*0.8); return e.scrollTop!==before;}""")
        if not more:
            break


FIT = """()=>{const sec=document.getElementById('mapv3_sec_terrain'), sr=sec.getBoundingClientRect();
    const q=s=>[...sec.querySelectorAll(s)];
    const vis=e=>e.offsetParent&&!e.closest('[hidden]');
    // an ellipsis is fine when the element carries the whole text as its tooltip
    const over=q('*').filter(e=>vis(e)&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible'&&!e.matches('input,select')&&!(e.title&&getComputedStyle(e).textOverflow==='ellipsis')).map(e=>(e.className||e.tagName)+':'+e.textContent.slice(0,30));
    const out=q('*').filter(e=>vis(e)&&e.getBoundingClientRect().width>0&&(e.getBoundingClientRect().right>sr.right+1||e.getBoundingClientRect().left<sr.left-1)).map(e=>e.className||e.tagName);
    const cut=q('.vt-tp-fv,.vt-tp-meta,.vt-tp-summ').filter(e=>vis(e)&&e.scrollWidth>e.clientWidth+1&&!e.title).map(e=>e.className+':'+e.textContent);
    const btns=q('button,select').filter(vis).map(b=>{const r=b.getBoundingClientRect(); return [b.className, Math.round(r.height), Math.round(r.width)]});
    const dr=document.getElementById('ui_drawer');
    return {w:document.documentElement.scrollWidth, iw:innerWidth, over, out, cut, btns, coarse:matchMedia('(pointer: coarse)').matches,
            dw: dr ? dr.scrollWidth-dr.clientWidth : 0}}"""


def fit(p, shots, label, phone):
    """Full data, every question open in turn, parameters open: everything fits."""
    p.open()
    p.raw(NODE_STATS, diag(1, 'TF failures, latency over budget, integration over budget', tf_failures=12, settling=1, exempt_zones_active=0,
                          exempt_zones_missing_tf=1))
    p.json(NODE_CFG, CONFIG)
    p.rec(rec_state(gate={'open': False, 'reason': 'owner lidar_relock_fallback_mode', 'open_for_s': 0},
                    export={'version': 41, 'ok': False, 'error': 'cannot write terrain_mosaic/teren_demo.json: disk full'}))
    p.tick(400)
    p.ev('()=>{const d=document.querySelector(".vt-tp-params"); d.open=true;}')
    p.click('[data-tp-layer="mosaic"]')           # its map choice is in the layout too
    p.until('()=>{const s=document.querySelector("[data-tp-pick]"); return s && s.offsetParent}', 4000)
    for step, act in (('delete', 'clear'), ('choose', 'rebuild'), ('replace', 'rebuild')):
        p.click('[data-tp-act="%s"]' % act)
        if step == 'replace':
            p.click('[data-tp-imode="replace"]')
            p.click('[data-tp-act="flow-yes"]')
        p.until('()=>!document.querySelector(".vt-tp-confirm").hidden')
        p.tick(200)
        r = p.ev(FIT)
        lab = '%s %s' % (label, step)
        check(lab + ': no horizontal page scroll', r['w'] <= r['iw'], [r['w'], r['iw']])
        check(lab + ': no horizontal scroll in the panel', r['dw'] <= 1, r['dw'])
        check(lab + ': nothing overflows inside the section', not r['over'], r['over'])
        check(lab + ': nothing sticks out of the section', not r['out'], r['out'])
        check(lab + ': no value cut without its tooltip', not r['cut'], r['cut'])
        if phone:
            small = [b for b in r['btns'] if b[1] < 36 and 'vt-tp-help' not in b[0]]
            check(lab + ': touch targets ≥ 36 px (coarse %s)' % r['coarse'], not small, small)
        if shots:
            pages(p, shots, 'fit-%s-%s' % (label, step))
        p.click('[data-tp-act="flow-no"]')
    check(label + ': no page errors', not p.errors, p.errors)
    cm = [c for c in p.cmds() if 'confirm' in c or c['cmd'] not in ('delete_map', 'import')]
    check(label + ': only token requests were sent (nothing deleted or imported)', not cm and
          all('confirm' not in c for c in p.cmds()), p.cmds())


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
        print('--- story desk-en', flush=True)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, service_workers='block', timezone_id='Europe/Prague')
        p = P(ctx, url, 'en')
        story(p, a.shots)
        ctx.close()
        for lang in ('en', 'cs'):
            for w, h, phone in ((360, 740, True), (390, 844, True), (768, 1024, True), (1440, 900, False)):
                label = '%d-%s' % (w, lang)
                print('--- fit %s' % label, flush=True)
                ctx = b.new_context(viewport={'width': w, 'height': h}, is_mobile=phone, has_touch=phone, service_workers='block',
                                    timezone_id='Europe/Prague')
                p = P(ctx, url, lang)
                if lang == 'cs':
                    check(label + ': Czech texts', p.text('#mapv3_sec_terrain .vt-tp-sumt') == 'Terén' and
                          p.text('[data-tp="rec"] .vt-tp-title') == 'Trvalá mapa terénu')
                fit(p, a.shots, label, phone)
                ctx.close()
        b.close()
    srv.shutdown()
    print('%s of %d checks' % ('%d FAILED' % len(FAILS) if FAILS else 'all ok', COUNT[0]))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
