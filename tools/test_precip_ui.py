#!/usr/bin/env python3
"""The precipitation mosaic layer (T20 E2) in real Chrome against a fake precip service: nothing reaches a robot.

The page is served from this tree on a private port; rosbridge is a fake WebSocket, /api/datum a public
point (Praha centre), /api/map_sources the docker-mapproxy catalog (MAPPROXY_REPO, else a built-in
entry), MapProxy (:8082) an empty tile and the precip-mosaic service (:8097) is answered by this script:
index.json with 2 h of observations + 1 h of nowcast relative to now, legend.json, and tiles with a
rain blob that moves from frame to frame. It shows:
  - off by default; ticking Precipitation (mosaic) shows the time line, starts at the newest radar
    picture, draws its tiles straight from the service with the frame signature (?v=);
  - the slider picks past frames and nowcast (marked), the map badge and the credits follow;
  - Play steps through the frames, Pause stops, Now goes back to the newest picture;
  - legend from legend.json (rain + snow bins), credits of the frame with links;
  - an old newest picture says so, a service that does not answer says so (warn), and the page keeps
    working; a source with an error is named;
  - unticked: the time line stops (no more requests), the badge goes;
  - every request to the service is a GET, the precipitation steps send nothing else anywhere;
  - the old Rain layer (weather_alert rain_img) is still there, unchanged;
  - phone 390/360 (touch), desktop 1440/1920, en + cs: no horizontal scroll, nothing sticks out of
    the card, touch targets >= 40 px, no console errors;
  - T40: after ticking the layer (a real click in Map › Display on a 1366x768 notebook, a tap in the layers
    panel then closed on a 390x844 phone) the play bar is on the map with ▶ and Whole area in sight, covering
    no map control; it says "no rain within 150 km" (index rain_nearby); ▶ there zooms out from the garden
    view and plays, ❚❚ pauses, unticking the layer returns the garden view and hides the bar.

    python3 tools/test_precip_ui.py [--shots DIR]

Needs python3-playwright + Google Chrome + Pillow.
"""
import argparse
import functools
import http.server
import io
import json
import math
import os
import re
import sys
import threading
import time

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_autonomy_ui import FAKE, Handler, TPL  # noqa: E402

FAILS = []
COUNT = [0]
LAT, LON = 50.08, 14.42      # public point (Praha centre), never the garden


def check(name, ok, detail=''):
    COUNT[0] += 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:400]), flush=True)
    if not ok:
        FAILS.append(name)


def catalog():
    repo = os.environ.get('MAPPROXY_REPO', '')
    p = os.path.join(repo, 'mapproxy_configuration', 'ui_sources.json')
    if repo and os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            j = json.load(f)
    else:
        j = {'version': 1, 'default_base': 'osm', 'sources': [
            {'id': 'osm', 'kind': 'base', 'group': 'map', 'layer': 'osm_demo', 'grid': 'webmercator', 'format': 'png',
             'name': {'en': 'OpenStreetMap', 'cs': 'OpenStreetMap'}, 'max_zoom': 19},
            {'id': 'precip', 'kind': 'overlay', 'layer': 'precip_mosaic', 'grid': 'gm_grid', 'format': 'png',
             'name': {'en': 'Precipitation (mosaic)', 'cs': 'Srážky (mozaika)'}, 'min_zoom': 3, 'max_zoom': 8,
             'default_opacity': 0.7, 'layer_order': 'over', 'timeline': {'port': 8097},
             'attribution': '© EUMETNET OPERA (CC BY 4.0), © ČHMÚ, Weather data by RainViewer'}]}
    j['ok'] = True
    return j


LEGEND = {'unit': 'mm/h', 'dry_below_mmh': 0.1,
          'rain': [{'min_mmh': a, 'max_mmh': b, 'rgba': c} for a, b, c in (
              (0.1, 0.2, [160, 230, 255, 150]), (0.2, 0.5, [110, 205, 250, 190]), (0.5, 1.0, [60, 170, 245, 225]),
              (1.0, 2.0, [25, 120, 230, 235]), (2.0, 3.0, [10, 80, 200, 240]), (3.0, 5.0, [0, 165, 80, 240]),
              (5.0, 8.0, [90, 205, 40, 240]), (8.0, 12.0, [230, 230, 0, 245]), (12.0, 20.0, [255, 180, 0, 245]),
              (20.0, 30.0, [255, 110, 0, 250]), (30.0, 50.0, [235, 30, 30, 250]), (50.0, 80.0, [180, 0, 60, 250]),
              (80.0, 120.0, [210, 0, 210, 255]), (120.0, None, [255, 255, 255, 255]))],
          'snow': [{'min_mmh': 0.1, 'max_mmh': 1.0, 'rgba': [235, 235, 255, 150]},
                   {'min_mmh': 1.0, 'max_mmh': None, 'rgba': [90, 20, 170, 250]}],
          'mixed': [], 'nodata_rgba': [128, 128, 128, 70]}


class Svc(object):
    """The fake precip-mosaic service: state the test changes on the fly."""

    def __init__(self):
        self.down = False
        self.age_min = 3          # newest observation this old
        self.opera_error = None
        self.shift = 0            # the service's clock ahead of this machine's (s)
        # T40: rain around the area (index.rain_nearby): dry
        self.rain = {'frame': None, 'radius_km': 150, 'covered_fraction': 0.9, 'raining_fraction': 0.0,
                     'max_mmh': 0.0, 'nearest_rain_km': None}
        self.reqs = []            # (method, path)
        self.gone = None          # T40b: tiles of this frame id answer 404 (it left the service's window)
        self.hang = None          # T40b: the first tile of this frame id never answers (held until release())
        self.held = []
        self.netfail = False      # T40c: tiles fail with a network error (the index still answers)
        self.refreshing = False   # T40d: the index carries an old time line, a new one is being built
        self.lock = threading.Lock()

    def index(self):
        now = int(time.time()) + self.shift
        latest = (now - self.age_min * 60) // 300 * 300
        frames = []
        for k in range(-24, 7):
            e = latest + k * 300
            fid = time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime(e))
            kind = 'nowcast' if k > 0 else 'obs'
            srcs = ['chmi'] if kind == 'nowcast' else ['chmi', 'opera', 'rainviewer']
            att = {'chmi': '© ČHMÚ (opendata.chmi.cz)', 'opera': '© EUMETNET OPERA (CC BY 4.0)',
                   'rainviewer': 'Weather data by RainViewer'}
            frames.append({'id': fid, 'kind': kind, 'time': fid, 'epoch': e,
                           'run_time': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime(latest)) if kind == 'nowcast' else None,
                           'stale': False, 'sources': [{'id': s, 'time': fid, 'age_s': 0, 'kind': kind} for s in srcs],
                           'attribution': [att[s] for s in srcs],
                           'tiles': '/tiles/%s/{z}/{x}/{y}.png?v=sv%x' % (fid, (e // 300 * 7 + (k > 0)) % 0xfffff)})
        return {'version': 1, 'rain_nearby': self.rain, 'refreshing': self.refreshing,
                'timeline_age_s': 3 * 3600 if self.refreshing else 20, 'generated': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime(now)), 'mode':
                {'world': None, 'area': {'radius_km': 150.0, 'zoom': [3, 8]}}, 'slot_s': 300,
                'latest': frames[24]['id'], 'frames': frames, 'legend': '/legend.json',
                'sources': [
                    {'id': 'rainviewer', 'name': 'RainViewer', 'attribution': 'Weather data by RainViewer',
                     'attribution_url': 'https://www.rainviewer.com/', 'last_error': None, 'redistributable': False},
                    {'id': 'opera', 'name': 'EUMETNET OPERA', 'attribution': '© EUMETNET OPERA (CC BY 4.0)',
                     'attribution_url': 'https://eumetnet.github.io/openradardata-documentation/',
                     'last_error': self.opera_error, 'redistributable': True},
                    {'id': 'chmi', 'name': 'ČHMÚ radar', 'attribution': '© ČHMÚ (opendata.chmi.cz)',
                     'attribution_url': 'https://opendata.chmi.cz/meteorology/weather/radar/', 'last_error': None,
                     'redistributable': True}]}

    @staticmethod
    @functools.lru_cache(maxsize=4096)
    def tile(fid, z, x, y):
        # (cached: the playback preload asks every frame's tiles; on a loaded robot drawing each one
        # again in this single route thread made the fake service the bottleneck, T40b)
        """A rain blob that moves with the frame time (so the frames differ on the map)."""
        m = re.match(r'(\d+)-(\d+)-(\d+)T(\d+):(\d+)Z', fid)
        k = (int(m.group(4)) * 60 + int(m.group(5))) // 5 if m else 0
        im = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        cx, cy = 40 + (k * 13) % 180, 128 + int(40 * math.sin(k / 3.0))
        for r, c in ((70, (110, 205, 250, 190)), (48, (25, 120, 230, 235)), (30, (90, 205, 40, 240)), (14, (255, 110, 0, 250))):
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=c)
        b = io.BytesIO()
        im.save(b, 'PNG')
        return b.getvalue()

    def route(self, route):
        req = route.request
        path = req.url.split('8097', 1)[1]
        with self.lock:
            self.reqs.append((req.method, path))
        if req.method != 'GET':
            return route.fulfill(status=405, body='')
        if self.down:
            return route.fulfill(status=503, content_type='application/json', body='{"error":"down"}',
                                 headers={'Access-Control-Allow-Origin': '*'})
        p = path.split('?')[0]
        cors = {'Access-Control-Allow-Origin': '*'}
        if p == '/index.json':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(self.index()), headers=cors)
        if p == '/legend.json':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(LEGEND), headers=cors)
        m = re.match(r'^/tiles/([^/]+)/(\d+)/(\d+)/(\d+)\.png$', p)
        if m and self.netfail:
            return route.abort('failed')
        if m and self.gone and m.group(1) == self.gone:
            return route.fulfill(status=404, body='', headers=cors)
        if m and self.hang and m.group(1) == self.hang and not self.held:
            self.held.append(route)
            return None
        if m:
            return route.fulfill(status=200, content_type='image/png', headers=cors,
                                 body=self.tile(m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))))
        return route.fulfill(status=404, body='')


EMPTY_PNG = None


def empty_png():
    global EMPTY_PNG
    if EMPTY_PNG is None:
        b = io.BytesIO()
        Image.new('RGBA', (256, 256), (0, 0, 0, 0)).save(b, 'PNG')
        EMPTY_PNG = b.getvalue()
    return EMPTY_PNG


class P(object):
    def __init__(self, ctx, url, svc, lang):
        self.svc = svc
        self.pg = ctx.new_page()
        self.errors = []
        self.methods = []
        # ros3d's interactive-marker client throws on the fake rosbridge's empty get_init answer; the
        # same on master without this layer (2026-11-08), not this test's business
        self.pg.on('pageerror', lambda e: None if "setting 'erases'" in str(e) else self.errors.append(str(e)))
        self.pg.on('console', lambda m: self.errors.append('console: ' + m.text) if m.type == 'error' and '8082' not in m.text
                   and 'Failed to load resource' not in m.text else None)
        self.pg.on('request', lambda r: self.methods.append((r.method, r.url)))
        self.pg.add_init_script(FAKE)
        self.pg.add_init_script('try{localStorage.setItem("vitulus_lang",%s)}catch(e){}' % json.dumps(lang))
        cat = catalog()
        self.pg.route('**/api/map_sources', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(cat)))
        self.pg.route('**/api/datum', lambda r: r.fulfill(status=200, content_type='application/json',
                                                          body=json.dumps({'ok': True, 'origin_lat': LAT, 'origin_lon': LON})))
        self.pg.route('**/api/ui_settings', lambda r: r.fulfill(status=200, content_type='application/json',
                                                               body=json.dumps({'ok': True, 'settings': {'lang': lang}})))
        self.pg.route(re.compile(r'^http://127\.0\.0\.1:8082/.*'),
                      lambda r: r.fulfill(status=200, content_type='image/png', body=empty_png(),
                                          headers={'Access-Control-Allow-Origin': '*'}))
        self.pg.route(re.compile(r'^http://127\.0\.0\.1:8097/.*'), svc.route)
        self.pg.goto(url, wait_until='domcontentloaded')
        self.pg.wait_for_function('window.mapping_v3 && window.VTI18n', timeout=30000)
        self.pg.wait_for_timeout(1500)
        self.pg.evaluate('(l)=>VTI18n.setLang?VTI18n.setLang(l):VTI18n.set(l)', lang)
        self.pg.wait_for_timeout(300)

    def ev(self, js, arg=None):
        return self.pg.evaluate(js, arg)

    def text(self, sel):
        return self.ev('(s)=>{const e=document.querySelector(s);return e?e.textContent:null}', sel)

    def open_layers(self):
        self.ev("""()=>{ const m=document.getElementById('div_menu_map');
                   if (!m || getComputedStyle(m).display==='none') document.getElementById('btn_map').click(); }""")
        self.pg.wait_for_timeout(400)
        self.ev("""()=>{ const a=document.querySelector('a[href="#tab-map"]'); if (a) a.click();
                   const d=document.querySelector('details[data-mapsec=layers]'); d.open=true; }""")
        self.pg.wait_for_timeout(300)

    def until(self, js, ms=8000, arg=None):
        end = time.time() + ms / 1000.0
        while time.time() < end:
            if self.ev(js, arg):
                return True
            self.pg.wait_for_timeout(150)
        return False

    def release(self):
        for r in self.svc.held:
            try:
                r.fulfill(status=200, content_type='image/png', body=empty_png(), headers={'Access-Control-Allow-Origin': '*'})
            except Exception:
                pass
        self.svc.held = []

    def tiles(self):
        with self.svc.lock:
            return [p for m, p in self.svc.reqs if p.startswith('/tiles/')]


def story(p, shots, label, cs):
    svc = p.svc
    p.open_layers()
    check('catalog row Precipitation (mosaic) is there', p.ev("!!document.getElementById('mapv3_ov_precip')"))
    check('off by default, time line hidden, nothing asked',
          p.ev("!document.getElementById('mapv3_ov_precip').checked && document.getElementById('mapv3_precip').hidden")
          and not svc.reqs, svc.reqs[:3])
    check('the old Rain layer is still there', p.ev("!!document.getElementById('mapv3_chk_rain') && !!document.getElementById('mapv3_rain_opacity')"))
    rain_before = p.ev("document.getElementById('mapv3_chk_rain').checked")
    non_get0 = len([1 for m, u in p.methods if m not in ('GET', 'HEAD')])

    p.ev("()=>{const c=document.getElementById('mapv3_ov_precip'); c.click();}")
    ok = p.until("()=>{const r=document.getElementById('mapv3_precip_range');return r && +r.max===30}", 10000)
    check('ticked: time line with 31 frames (25 radar + 6 nowcast)', ok, p.ev("document.getElementById('mapv3_precip').outerHTML.slice(0,300)"))
    check('starts at the newest radar picture', p.ev("+document.getElementById('mapv3_precip_range').value") == 24,
          p.ev("document.getElementById('mapv3_precip_range').value"))
    kind = p.text('.vt-precip-kind')
    check('kind says newest radar', kind == ('nejnovější radar' if cs else 'newest radar'), kind)
    st = p.text('.vt-precip-state')
    check('state: updated N min ago', re.search(r'před \d+ min' if cs else r'updated \d+ min ago', st or ''), st)
    check('time HH:MM', re.match(r'^\d\d:\d\d$', p.text('.vt-precip-time') or ''), p.text('.vt-precip-time'))
    check('legend: 14 rain bins + 2 snow bins',
          p.until("document.querySelectorAll('.vt-precip-lrow.is-rain .vt-precip-bin').length===14 && document.querySelectorAll('.vt-precip-lrow.is-snow .vt-precip-bin').length===2"))
    check('legend numbers 0.1 … 50 + unit', (p.text('.vt-precip-marks') or '').replace(',', '.').startswith('0.1'), p.text('.vt-precip-marks'))
    attr = p.text('.vt-precip-attr') or ''
    check('credits of the frame: ČHMÚ, OPERA, RainViewer', all(s in attr for s in ('ČHMÚ', 'OPERA', 'RainViewer')), attr)
    check('credits linked (https, new tab)', p.ev("[...document.querySelectorAll('.vt-precip-attr a')].every(a=>a.href.startsWith('https://')&&a.target==='_blank'&&/noopener/.test(a.rel))")
          and p.ev("document.querySelectorAll('.vt-precip-attr a').length") == 3)
    latest = p.ev("mapping_v3._precip.frame()")
    got = False
    end = time.time() + 15
    while time.time() < end and not got:
        got = any(t.startswith('/tiles/%s/' % latest['id']) and ('?v=' + latest['v']) in t for t in p.tiles())
        p.pg.wait_for_timeout(200)
    check('tiles of the newest frame straight from the service, with ?v=', got, p.tiles()[:4])
    check('?v= is the service\'s signature from frames[].tiles', latest['v'].startswith('sv'), latest)
    zs = set(int(t.split('/')[3]) for t in p.tiles())
    check('tile zooms within the catalog range z3-z8', zs and min(zs) >= 3 and max(zs) <= 8, zs)
    check('map badge shows the time', p.until("(()=>{const b=document.getElementById('mapv3_precip_badge');return b&&!b.hidden&&/\\d\\d:\\d\\d/.test(b.textContent)})()"),
          p.text('#mapv3_precip_badge'))
    check('Now is off while it follows the newest picture', p.ev("document.getElementById('mapv3_precip_now').disabled"))
    d0 = p.ev("(()=>{const v=mapping_v3.viewer3d;return v.camera.position.distanceTo(v.cameraControls.center)})()")
    p.ev("document.getElementById('mapv3_precip_fit').click()")
    p.pg.wait_for_timeout(600)
    d1 = p.ev("(()=>{const v=mapping_v3.viewer3d;return v.camera.position.distanceTo(v.cameraControls.center)})()")
    check('Whole area zooms out to the ~300 km area (camera far enough, far plane grown)',
          d1 > 100000 and p.ev("mapping_v3.viewer3d.camera.far") > d1, (d0, d1))
    if shots:
        p.pg.wait_for_timeout(2500)
        p.pg.screenshot(path=os.path.join(shots, label + '-area.png'))
    mattr = p.text('#mapv3_attr') or ''
    check('map credit line follows the frame', 'ČHMÚ (opendata' in mattr, mattr)
    if shots:
        p.ev("document.getElementById('mapv3_precip').scrollIntoView({block:'center'})")
        p.pg.wait_for_timeout(400)
        p.pg.screenshot(path=os.path.join(shots, label + '-latest.png'))

    # nowcast on the slider
    p.ev("()=>{const r=document.getElementById('mapv3_precip_range'); r.value='28'; r.dispatchEvent(new Event('input',{bubbles:true}));}")
    p.pg.wait_for_timeout(300)
    kind = p.text('.vt-precip-kind')
    check('slider to a nowcast frame: marked as nowcast +20 min',
          kind and re.search(r'předpověď \+20' if cs else r'nowcast \+20', kind.replace('\u00a0', ' ')) and
          p.ev("document.querySelector('.vt-precip-kind').classList.contains('is-nowcast')"), kind)
    check('map badge marked nowcast', p.until("document.getElementById('mapv3_precip_badge').classList.contains('is-nowcast')"),
          p.text('#mapv3_precip_badge'))
    nc = p.ev("mapping_v3._precip.frame()")
    end = time.time() + 10
    got = False
    while time.time() < end and not got:
        got = any(t.startswith('/tiles/%s/' % nc['id']) for t in p.tiles())
        p.pg.wait_for_timeout(200)
    check('nowcast tiles asked', got)
    check('nowcast credits: ČHMÚ only', (p.text('.vt-precip-attr') or '').strip() == '© ČHMÚ (opendata.chmi.cz)', p.text('.vt-precip-attr'))
    check('nowcast part of the track is drawn', p.ev("parseFloat(getComputedStyle(document.querySelector('.vt-precip-seg-nc')).width)>10"))
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-nowcast.png'))

    # play / pause / now
    p.ev("()=>{const r=document.getElementById('mapv3_precip_range'); r.value='5'; r.dispatchEvent(new Event('input',{bubbles:true}));}")
    p.pg.wait_for_timeout(200)
    p.ev("document.getElementById('mapv3_precip_play').click()")
    check('Play: pressed, label Pause', p.ev("document.getElementById('mapv3_precip_play').getAttribute('aria-pressed')") == 'true')
    # (check A682: under load 37 the preload before the first step ate the 9 s: wait for the
    # preload wait to end — a state, not a time — then the same 9 s for two steps)
    p.until("!mapping_v3._precip._warm", 30000)
    moved = p.until("+document.getElementById('mapv3_precip_range').value>=7", 9000)
    check('Play steps through the frames', moved, p.ev("document.getElementById('mapv3_precip_range').value"))
    p.ev("document.getElementById('mapv3_precip_play').click()")
    v1 = p.ev("+document.getElementById('mapv3_precip_range').value")
    p.pg.wait_for_timeout(2000)
    check('Pause stops', p.ev("+document.getElementById('mapv3_precip_range').value") == v1 and
          p.ev("document.getElementById('mapv3_precip_play').getAttribute('aria-pressed')") == 'false')
    p.ev("document.getElementById('mapv3_precip_now').click()")
    p.pg.wait_for_timeout(200)
    check('Now: back to the newest radar picture', p.ev("+document.getElementById('mapv3_precip_range').value") == 24)

    # old data, failing source, outage
    svc.age_min = 41
    svc.opera_error = 'HTTP 503 from S3'
    p.ev("mapping_v3._precip._fetch()")
    check('old newest picture: data N min old (warn)',
          p.until("document.querySelector('.vt-precip-state').classList.contains('vt-tone-warn')") and
          re.search(r'stará \d+ min' if cs else r'\d+ min old', p.text('.vt-precip-state') or ''), p.text('.vt-precip-state'))
    check('failing source named', 'OPERA' in (p.text('.vt-precip-fail') or '') and p.ev("!document.querySelector('.vt-precip-fail').hidden"),
          p.text('.vt-precip-fail'))
    svc.age_min, svc.opera_error = 3, None
    svc.shift = 3 * 3600          # the service's clock 3 h ahead of the browser's
    p.ev("mapping_v3._precip._fetch()")
    check('data age from the service clock, not the browser\'s', p.until(
        "/(před [3-8] min|updated [3-8] min ago)/.test(document.querySelector('.vt-precip-state').textContent)"),
        p.text('.vt-precip-state'))
    svc.shift = 0
    svc.down = True
    p.ev("mapping_v3._precip._fetch()")
    check('service down: says so (warn)', p.until("document.querySelector('.vt-precip-state').classList.contains('vt-tone-warn') && mapping_v3._precip.failed")
          and (p.text('.vt-precip-state') or '') == ('služba neodpovídá' if cs else 'service not responding'), p.text('.vt-precip-state'))
    check('service down: map badge warns', p.until("document.getElementById('mapv3_precip_badge').classList.contains('is-warn')"))
    svc.down = False
    p.ev("mapping_v3._precip._fetch()")
    check('service back: ok again', p.until("!document.querySelector('.vt-precip-state').classList.contains('vt-tone-warn')"), p.text('.vt-precip-state'))
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-back.png'))

    # off
    p.ev("document.getElementById('mapv3_ov_precip').click()")
    p.pg.wait_for_timeout(500)
    n0 = len(svc.reqs)
    check('unticked: time line hidden, timer stopped, badge gone',
          p.ev("document.getElementById('mapv3_precip').hidden && !mapping_v3._precip._poll && !mapping_v3._precip._play && document.getElementById('mapv3_precip_badge').hidden"))
    p.pg.wait_for_timeout(1500)
    check('unticked: nothing more asked', len(svc.reqs) == n0, svc.reqs[n0:])
    check('every request to the service is a GET', all(m == 'GET' for m, _ in svc.reqs), [x for x in svc.reqs if x[0] != 'GET'])
    non_get = [(m, u) for m, u in p.methods if m not in ('GET', 'HEAD')]
    check('the precipitation steps sent nothing else', len(non_get) == non_get0, non_get[non_get0:])
    check('Rain layer tick unchanged', p.ev("document.getElementById('mapv3_chk_rain').checked") == rain_before)
    check('no page errors', not p.errors, p.errors[:3])


BAR_JS = r"""() => {
  const b = document.getElementById('mapv3_precip_badge');
  if (!b || b.hidden) { return { shown: false }; }
  const r = b.getBoundingClientRect();
  const inView = (e) => { const q = e.getBoundingClientRect(); return q.width > 0 && q.top >= 0 && q.bottom <= innerHeight && q.left >= 0 && q.right <= innerWidth; };
  const hit = (e) => { const q = e.getBoundingClientRect(); const t = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2); return !!t && (t === e || e.contains(t)); };
  const play = document.getElementById('mapv3_precip_bplay'), fit = document.getElementById('mapv3_precip_bfit');
  // other controls on the map the bar must not cover (layers / measure buttons, labels column …)
  const host = document.getElementById('map_view');
  const covered = [...document.querySelectorAll('button, a, [role=button]')].filter(e => !b.contains(e) && e.offsetParent && host.contains(e))
      .filter(e => { const q = e.getBoundingClientRect(); return q.width && q.height && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top; })
      .map(e => e.id || e.className);
  const coarse = matchMedia('(pointer: coarse)').matches;
  return { shown: true, playIn: inView(play), playHit: hit(play), fitIn: inView(fit), fitHit: hit(fit),
           small: [play, fit].map(e => e.getBoundingClientRect()).filter(q => q.height < (coarse ? 40 : 28)).length,
           text: b.textContent, sub: (b.querySelector('.vt-map-precip-sub') || {}).textContent, covered,
           hs: document.scrollingElement.scrollWidth > innerWidth + 1, box: [r.x | 0, r.y | 0, r.width | 0, r.height | 0] };
}"""

DIST_JS = "(()=>{const v=mapping_v3.viewer3d;return v.camera.position.distanceTo(v.cameraControls.center)})()"

# T40b: what the precipitation layer costs the page — calls of its timer step (_tick, 10/s while playing),
# of the play bar redraw, of the preload pump and of the map rebuild, counted per window
COUNT_JS = r"""() => {
  if (window.__pc) { return; }
  const c = window.__pc = { tick: 0, bar: 0, pump: 0, rebuild: 0 };
  const wrap = (o, k, n) => { const f = o[k]; o[k] = function () { c[n]++; return f.apply(this, arguments); }; };
  wrap(VTPrecip.Timeline.prototype, '_tick', 'tick');
  wrap(VTPrecip.Preload.prototype, '_pump', 'pump');
  wrap(mapping_v3, '_precipBadge', 'bar');
  wrap(mapping_v3, 'rebuildAerial', 'rebuild');
}"""


def costs(p, ms):
    p.ev(COUNT_JS)
    p.ev("()=>{for (const k in window.__pc) window.__pc[k]=0;}")
    p.pg.wait_for_timeout(ms)
    return p.ev("({...window.__pc})")


def bar(p, shots, label, cs, phone):
    """T40 check: after ticking the layer the play bar is on the map, in sight without scrolling, not covering
    the map's buttons; it says whether it rains; ▶ from the garden view zooms out, unticking returns."""
    svc = p.svc
    off = costs(p, 5000)
    check(label + ': layer off: no precipitation timer, bar or preload work (5 s)',
          off['tick'] == 0 and off['bar'] == 0 and off['pump'] == 0, off)
    if phone:
        p.ev("()=>{window.VTMapLayers.open()}")
        p.pg.wait_for_timeout(600)
        p.pg.locator('#vt_lyr_panel [data-lyr-chk=mapv3_ov_precip]').tap()
        p.pg.wait_for_timeout(600)
        p.ev("()=>{window.VTMapLayers.close()}")
    else:
        p.open_layers()
        p.pg.click('#mapv3_ov_precip', no_wait_after=True)          # a real click: Playwright scrolls to the row like a user
    ok = p.until("(()=>{const b=document.getElementById('mapv3_precip_badge');return b&&!b.hidden&&/\\d\\d:\\d\\d/.test(b.textContent)})()", 12000)
    r = p.ev(BAR_JS)
    check(label + ': play bar on the map after ticking', ok and r.get('shown'), r)
    check(label + ': ▶ and Whole area in sight without scrolling, not covered',
          r.get('playIn') and r.get('playHit') and r.get('fitIn') and r.get('fitHit'), r)
    check(label + ': bar covers no map control', not r.get('covered'), r.get('covered'))
    check(label + ': bar touch targets', not r.get('small'), r)
    check(label + ': no horizontal scroll', not r.get('hs'), r)
    want = 'V okolí (asi 150 km) teď neprší' if cs else 'No rain around now (about 150 km)'
    check(label + ': says it does not rain around (bar + card)',
          p.until("(w)=>{const s=document.querySelector('.vt-map-precip-sub');const c=document.querySelector('.vt-precip-rain');return s&&c&&(s.textContent===w||/zblízka|close/i.test(s.textContent))&&c.textContent===w}", 8000, want),
          (p.text('.vt-map-precip-sub'), p.text('.vt-precip-rain')))
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-bar.png'))
    d0 = p.ev(DIST_JS)
    small = p.ev("mapping_v3._precipView().small")
    tricky = label == 'bar-nb-en'
    late = label == 'bar-nb-cs'
    netfail = label == 'bar-phone-cs'
    if label == 'bar-nb-cs':
        # T40d: the nowcast brings rain close to the garden at +30 min: the line says when
        svc.rain = dict(svc.rain, outlook=[{'min': 15, 'near_km': 60, 'covered': 0.9}, {'min': 30, 'near_km': 15, 'covered': 0.9}])
        p.ev("mapping_v3._precip._fetch()")
        # +30 slot, the newest picture 3-8 min old: "asi za 20/25 min" from now, the area around (not "u zahrady")
        check(label + ': nowcast: "může déšť dojít do okolí zahrady asi za 20–25 min" (from now) in the card',
              p.until("(()=>{const c=document.querySelector('.vt-precip-rain');return c&&/do okolí zahrady asi za (20|25) min/.test(c.textContent)})()", 8000),
              p.text('.vt-precip-rain'))
        svc.rain = {k: v for k, v in svc.rain.items() if k != 'outlook'}
    if label == 'bar-nb-en':
        # T40d: after an idle spell the index carries an old time line: "updating…", asked again in seconds
        svc.refreshing = True
        n_idx = len([1 for m, q in svc.reqs if q.startswith('/index.json')])
        p.ev("mapping_v3._precip._fetch()")
        check(label + ': old time line being rebuilt: "updating…", no stale warning',
              p.until("(()=>{const s=document.querySelector('.vt-precip-state');return s&&s.textContent==='updating…'&&!s.classList.contains('vt-tone-warn')})()", 8000),
              p.text('.vt-precip-state'))
        svc.refreshing = False
        check(label + ': … and a new index within seconds (not after the minute poll)',
              p.until("(n)=>false", 6000) or len([1 for m, q in svc.reqs if q.startswith('/index.json')]) >= n_idx + 2,
              len([1 for m, q in svc.reqs if q.startswith('/index.json')]) - n_idx)
        check(label + ': … then the normal state again',
              p.until("(()=>{const s=document.querySelector('.vt-precip-state');return s&&s.textContent!=='updating…'})()", 8000), p.text('.vt-precip-state'))
    if late:
        # T40c: the radar 13 min late (fresh index): ▶ still starts at −2 h (no frame left out)
        svc.age_min = 13
        p.ev("mapping_v3._precip._fetch()")
        p.until("(()=>{const P=mapping_v3._precip;return P.index()&&P.status().age>=12*60})()", 8000)
    if netfail:
        svc.netfail = True
    if tricky:
        # T40b: the oldest frame has left the service's window (404) and one tile of frame 4 never answers
        ids = p.ev("mapping_v3._precip.index().frames.map(f=>f.id)")
        svc.gone, svc.hang = ids[0], ids[4]
        n0 = len(p.tiles())
    if phone:
        p.pg.locator('#mapv3_precip_bplay').tap()
    else:
        p.pg.click('#mapv3_precip_bplay', no_wait_after=True)
    check(label + ': ▶ on the map plays', p.until("mapping_v3._precip.playing", 3000))
    if late:
        check(label + ': radar 13 min late: ▶ starts at the oldest frame (−2 h), none left out',
              p.ev("mapping_v3._precip.liveFrom()") == 0 and
              p.until("+document.getElementById('mapv3_precip_range').value===0", 3000),
              (p.ev("mapping_v3._precip.liveFrom()"), p.ev("document.getElementById('mapv3_precip_range').value")))
    if netfail:
        want_r = 'některé obrázky se nenačítají, zkouším znovu' if cs else 'some pictures do not load, trying again'
        ok_r = p.until("(w)=>{const s=document.querySelector('.vt-map-precip-sub');return s&&s.textContent===w && mapping_v3._precip.playing && !mapping_v3._precip.failed}", 20000, want_r)
        if shots:
            p.pg.screenshot(path=os.path.join(shots, label + '-retry.png'))
        check(label + ': tiles fail, the service answers: the bar says it tries again (playing, no "not responding")',
              ok_r, (p.text('.vt-map-precip-sub'), p.text('.vt-precip-state')))
        svc.netfail = False
        check(label + ': network back: the playback goes on by itself',
              p.until("+document.getElementById('mapv3_precip_range').value>=2", 45000),
              (p.ev("document.getElementById('mapv3_precip_range').value"), p.text('.vt-map-precip-sub')))
    if small:
        check(label + ': ▶ from the garden view zooms out, the bar offers Back',
              p.until("(d)=>{const v=mapping_v3.viewer3d;return v.camera.position.distanceTo(v.cameraControls.center)>d*20 && !!mapping_v3._precipBack}", 4000, d0)
              # (the bar is redrawn at most 5x a second since T40c: its label within a moment)
              and p.until("(w)=>document.getElementById('mapv3_precip_bfit').textContent===w", 2000, 'Zpět' if cs else 'Back'),
              (d0, p.ev(DIST_JS), p.text('#mapv3_precip_bfit')))
    check(label + ': plays from −2 h onwards', p.until("+document.getElementById('mapv3_precip_range').value>=2", 15000),
          p.ev("document.getElementById('mapv3_precip_range').value"))
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-bar-playing.png'))
    if tricky:
        moved = p.until("+document.getElementById('mapv3_precip_range').value>=8", 45000)
        gone_reqs = len([t for t in p.tiles()[n0:] if t.startswith('/tiles/%s/' % svc.gone)])
        st = p.text('.vt-precip-state') or ''
        check(label + ': a frame gone from the service is asked at most once per preload slot (any zoom)', gone_reqs <= 3, gone_reqs)
        check(label + ': one tile without an answer does not stop the playback (no "not responding")',
              moved and p.ev("mapping_v3._precip.playing && !mapping_v3._precip.failed"),
              (p.ev("document.getElementById('mapv3_precip_range').value"), st))
        svc.gone = svc.hang = None
        p.release()
    # T40d (check A653): the bar keeps its width while it plays (time, kind, rain words change)
    ws = []
    for _ in range(8):
        ws.append(p.ev("Math.round(document.getElementById('mapv3_precip_badge').getBoundingClientRect().width)"))
        p.pg.wait_for_timeout(700)
    check(label + ': the bar keeps its width while it plays (spread <= 2 px)', max(ws) - min(ws) <= 2, ws)
    on = costs(p, 10000)
    print('     costs while playing, 10 s: %s' % on, flush=True)
    # the bar is redrawn at most 5x a second (T40c: 50 in 10 s + a little for direct redraws)
    check(label + ': playing costs a bounded amount (10 s: timer <= 110, bar <= 55, rebuilds <= 40)',
          on['tick'] <= 110 and on['bar'] <= 55 and on['rebuild'] <= 40, on)
    if phone:
        p.pg.locator('#mapv3_precip_bplay').tap()
    else:
        p.pg.click('#mapv3_precip_bplay', no_wait_after=True)
    check(label + ': ❚❚ on the map pauses', p.until("!mapping_v3._precip.playing", 3000))
    # unticking the layer returns the garden view
    p.ev("()=>{const c=document.getElementById('mapv3_ov_precip'); c.click();}")
    p.pg.wait_for_timeout(600)
    if small:
        d2 = p.ev(DIST_JS)
        check(label + ': layer off: back to the view before the zoom-out', abs(d2 - d0) < max(1.0, d0 * 0.01), (d0, d2))
    check(label + ': layer off: bar gone', p.ev("document.getElementById('mapv3_precip_badge').hidden"))
    after = costs(p, 5000)
    check(label + ': layer off again: no precipitation work left (5 s)', after['tick'] == 0 and after['bar'] == 0 and after['pump'] == 0, after)
    check(label + ': no page errors', not p.errors, p.errors[:3])
    check(label + ': every request to the service is a GET', all(m == 'GET' for m, _ in svc.reqs))


FIT_JS = r"""() => {
  const card = document.getElementById('mapv3_precip');
  const cb = card.getBoundingClientRect();
  const out = [...card.querySelectorAll('*')].filter(e => { const b = e.getBoundingClientRect();
      return b.width && (b.right > cb.right + 1 || b.left < cb.left - 1); }).map(e => e.className || e.tagName);
  const cut = [...card.querySelectorAll('span,div,a,button')].filter(e => e.children.length === 0 && e.textContent.trim()
      && e.scrollWidth > e.clientWidth + 1 && !(getComputedStyle(e).textOverflow === 'ellipsis' && e.title))
      .map(e => (e.className || e.tagName) + ':' + e.textContent.slice(0, 30));
  // the page, and every scroll box that holds the card (the drawer body), must not scroll sideways
  const hs = document.scrollingElement.scrollWidth > innerWidth + 1;
  const dh = [];
  for (let e = card.parentElement; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (/(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1) { dh.push(e.id || e.className); }
  }
  // touch: >= 40 px (the shared .btn sizes of a desktop drawer are smaller, like the Rain layer's Fit)
  const min = matchMedia('(pointer: coarse)').matches ? 40 : 28;
  const small = ['mapv3_precip_play', 'mapv3_precip_now', 'mapv3_precip_fit', 'mapv3_precip_range'].map(id => {
      const b = document.getElementById(id).getBoundingClientRect(); return [id, Math.round(b.width), Math.round(b.height)]; })
      .filter(x => x[2] < min || x[1] < min);
  const badge = document.getElementById('mapv3_precip_badge');
  const bb = badge && !badge.hidden ? badge.getBoundingClientRect() : null;
  const tk = [...card.querySelectorAll('.vt-precip-ticks span')].filter(e => !e.hidden && e.textContent).map(e => e.getBoundingClientRect())
      .sort((a, b) => a.left - b.left);
  const touch = tk.some((b, i) => i && b.left < tk[i - 1].right + 1);
  return { out, cut, hs, dh, small, touch, cardW: Math.round(cb.width), badgeOut: bb ? (bb.right > innerWidth || bb.left < 0) : null };
}"""


def fit(p, shots, label):
    p.open_layers()
    p.ev("()=>{const c=document.getElementById('mapv3_ov_precip'); if(!c.checked) c.click();}")
    p.until("()=>{const r=document.getElementById('mapv3_precip_range');return r && +r.max===30}", 10000)
    p.until("document.querySelectorAll('.vt-precip-bin').length>0")
    # a nowcast frame: the longest texts in the head
    p.ev("()=>{const r=document.getElementById('mapv3_precip_range'); r.value='30'; r.dispatchEvent(new Event('input',{bubbles:true}));}")
    p.pg.wait_for_timeout(500)
    p.ev("document.getElementById('mapv3_precip').scrollIntoView({block:'center'})")
    p.pg.wait_for_timeout(400)
    r = p.ev(FIT_JS)
    check(label + ': nothing sticks out of the card', not r['out'], r['out'][:5])
    check(label + ': no text cut without … + tooltip', not r['cut'], r['cut'][:5])
    check(label + ': no horizontal scroll (page / drawer)', not r['hs'] and not r['dh'], r)
    check(label + ': touch targets >= 40 px (phone) / 28 px (desktop)', not r['small'], r['small'])
    check(label + ': labels under the slider do not touch', not r['touch'], r)
    check(label + ': map badge inside the screen', r['badgeOut'] in (False, None), r)
    check(label + ': no page errors', not p.errors, p.errors[:3])
    if shots:
        p.pg.screenshot(path=os.path.join(shots, label + '-fit.png'))


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
        try:
            for lang, vp, phone, label in (('en', (1440, 900), False, 'desk-en'), ('cs', (390, 844), True, 'phone-cs')):
                print('--- story %s' % label, flush=True)
                ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone,
                                    service_workers='block', timezone_id='Europe/Prague')
                p = P(ctx, url, Svc(), lang)
                story(p, a.shots, label, lang == 'cs')
                ctx.close()
            # T40 check: the play bar on the map (a notebook 1366x768, a phone), en + cs
            for lang, vp, phone, label in (('en', (1366, 768), False, 'bar-nb-en'), ('cs', (1366, 768), False, 'bar-nb-cs'),
                                           ('cs', (390, 844), True, 'bar-phone-cs'), ('en', (390, 844), True, 'bar-phone-en')):
                print('--- bar %s' % label, flush=True)
                ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone,
                                    service_workers='block', timezone_id='Europe/Prague')
                p = P(ctx, url, Svc(), lang)
                bar(p, a.shots, label, lang == 'cs', phone)
                ctx.close()
            for lang, vp, phone, label in (('en', (390, 844), True, 'phone-en'), ('cs', (360, 740), True, 'small-cs'),
                                           ('cs', (844, 390), True, 'land-cs'), ('cs', (1440, 900), False, 'desk-cs'),
                                           ('en', (1920, 1080), False, 'wide-en')):
                print('--- fit %s' % label, flush=True)
                ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone,
                                    service_workers='block', timezone_id='Europe/Prague')
                p = P(ctx, url, Svc(), lang)
                fit(p, a.shots, label)
                ctx.close()
        finally:
            b.close()
            srv.shutdown()
    print('%s of %d checks' % ('%d FAILED' % len(FAILS) if FAILS else 'all ok', COUNT[0]))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
