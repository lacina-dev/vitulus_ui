#!/usr/bin/env python3
"""Zooming the map view in to the limit keeps the map on screen (owner 2026-11-08: "zoomed in more, the map
disappears"). Real Chrome, nothing reaches a robot.

Cause: the map view camera looks down from `distance` with a fixed near plane of 20 m, so below 20 m the
near plane cut the whole ground away — background map, robot maps, zones, plan — and a reload restored that
blank pose. Now the near plane follows the zoom and the zoom-in stops at MAP_MIN_DISTANCE (map_view.js,
ros3d.js OrbitControls nearMax).

The page is served from this tree; rosbridge is a fake WebSocket that answers the TF republisher (identity
map) and sends a robot map (/navi_manager/map) covering x >= 0 only, /api/datum a public point (park
Ladronka, Praha). MapProxy (:8082) is a solid-colour tile per source, or the real MapProxy at MAPPROXY_URL
(e.g. a local kartoza/mapproxy container) when set. It checks, desktop 1440 (wheel) and phone 360 (touch,
controls API), for the background maps sat, cuzk, esri, cenia_1950s and none:
  - zoomed in to the limit: the camera stops at the limit, the near plane stays in front of the ground;
  - the left half of the view (background only) shows the background map (none: the empty viewer), the
    right half the robot map — never the empty viewer;
  - the usual zoom (1000 m) keeps the old near plane of 20 m;
  - a stored close pose (10 m) is restored with the map visible;
  - zooming sends nothing (no HTTP write, no rosbridge publish / service call but the TF republisher;
    the link probe of vt_link.js, a /rosapi/get_param read, is not counted).

    python3 tools/test_map_zoom_ui.py [--root TREE] [--shots DIR]

Needs python3-playwright + Google Chrome + Pillow.
"""
import argparse
import functools
import http.server
import io
import json
import os
import re
import sys
import threading
import urllib.request

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = []
COUNT = [0]
LAT, LON = 50.0838, 14.3758      # park Ladronka (public point), never the garden
SOURCES = ('sat', 'cuzk', 'esri', 'cenia_1950s', 'none')
BG = (0x1e, 0x2f, 0x38)          # viewer background (map_view.js Viewer3D)
TILE_RGB = {'sat': (40, 150, 60), 'cuzk': (170, 140, 60), 'esri': (60, 110, 170), 'cenia_1950s': (150, 150, 150)}


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


def catalog():
    repo = os.environ.get('MAPPROXY_REPO', '')
    p = os.path.join(repo, 'mapproxy_configuration', 'ui_sources.json')
    if repo and os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            j = json.load(f)
    else:
        def base(i, layer, fmt, mz, en):
            return {'id': i, 'kind': 'base', 'group': 'photo', 'layer': layer, 'grid': 'gm_grid', 'format': fmt,
                    'max_zoom': mz, 'name': {'en': en, 'cs': en}}
        j = {'version': 1, 'default_base': 'sat', 'sources': [
            base('sat', 'gm_layer', 'png', 21, 'Satellite (Google)'),
            base('cuzk', 'cuzk_ortho_layer', 'jpeg', 20, 'Orthophoto CUZK'),
            base('esri', 'esri_layer', 'jpeg', 18, 'World Imagery (Esri)'),
            base('cenia_1950s', 'cenia_1950s_layer', 'jpeg', 18, 'Orthophoto 1950s (CENIA)')]}
    j['ok'] = True
    return j


# fake rosbridge: TF republisher (identity map/base_link), a robot map on x >= 0, everything else silent
FAKE = r"""
(() => {
  const F = window.__fake = { sent: [], ops: {}, sock: null };
  const grid = () => {
    const w = 200, h = 200, data = new Array(w * h);
    for (let i = 0; i < w * h; i++) { data[i] = ((i % w) + Math.floor(i / w)) % 2 ? 100 : 0; }
    return { header: { frame_id: 'map', stamp: { secs: 0, nsecs: 0 }, seq: 0 },
             info: { width: w, height: h, resolution: 0.05, map_load_time: { secs: 0, nsecs: 0 },
                     origin: { position: { x: 0, y: -5, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
             data: data };
  };
  const tfArray = (frames) => ({ transforms: frames.map((f) => ({
      header: { frame_id: 'map', stamp: { secs: 0, nsecs: 0 }, seq: 0 }, child_frame_id: f,
      transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } })) });
  class WS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob'; F.sock = this; this.frames = [];
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 20);
    }
    addEventListener() {}
    close() { this.readyState = 3; }
    deliver(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    send(raw) {
      const m = JSON.parse(raw);
      F.ops[m.op] = (F.ops[m.op] || 0) + 1;
      if (m.op === 'call_service') {
        // the link probe of vt_link.js (a read: /rosapi/get_param of /use_sim_time, id vt_link:N)
        // is not a write; every other service call still counts
        const probe = m.service === '/rosapi/get_param' && String(m.id).indexOf('vt_link:') === 0 &&
                      m.args && m.args.name === '/use_sim_time';
        if (probe) { F.probes = (F.probes || 0) + 1; } else { F.sent.push(m.service); }
        let v = {};
        if (m.service === '/republish_tfs') {
          this.frames = (m.args && m.args.source_frames) || [];
          v = { topic_name: '/tf_repub_fake' };
        } else if (m.service === '/rosapi/get_param') {
          v = { value: 'null' };
        }
        setTimeout(() => this.deliver({ op: 'service_response', id: m.id, service: m.service, values: v, result: true }), 5);
      } else if (m.op === 'subscribe') {
        if (m.topic === '/tf_repub_fake') {
          clearInterval(this.tfT);
          this.tfT = setInterval(() => this.deliver({ op: 'publish', topic: m.topic, msg: tfArray(this.frames) }), 200);
        } else if (m.topic === '/navi_manager/map') {
          setTimeout(() => this.deliver({ op: 'publish', topic: m.topic, msg: grid() }), 300);
        }
      } else if (m.op === 'publish') {
        F.sent.push('publish ' + m.topic);
      }
    }
  }
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
"""

TILES = {}


def tile_png(src):
    if src not in TILES:
        b = io.BytesIO()
        Image.new('RGB', (256, 256), TILE_RGB.get(src, (200, 60, 200))).save(b, 'PNG')
        TILES[src] = b.getvalue()
    return TILES[src]


def tile_route(cat, mp_url):
    by_layer = {s['layer']: s['id'] for s in cat['sources']}
    cors = {'Access-Control-Allow-Origin': '*'}

    def route(r):
        if r.request.method != 'GET':
            return r.abort()
        m = re.search(r'/wmts/([^/]+)/', r.request.url)
        if mp_url:
            path = r.request.url.split(':8082', 1)[1]
            try:
                with urllib.request.urlopen(mp_url.rstrip('/') + path, timeout=30) as resp:
                    return r.fulfill(status=resp.status, body=resp.read(), headers=dict(cors, **{
                        'Content-Type': resp.headers.get('Content-Type', 'image/png')}))
            except urllib.error.HTTPError as e:
                return r.fulfill(status=e.code, body=b'', headers=cors)
            except Exception:
                return r.fulfill(status=502, body=b'', headers=cors)
        return r.fulfill(status=200, content_type='image/png', headers=cors,
                         body=tile_png(by_layer.get(m.group(1) if m else '', '')))
    return route


STATE = r"""() => { const v = window.__ros3d_map, c = v.camera, k = v.cameraControls;
  return { dist: c.position.distanceTo(k.center), near: c.near, far: c.far, min: k.minDistance }; }"""


def mean(im, box):
    """mean colour of a box + its spread (a photo has texture, the empty viewer none)"""
    px = list(im.crop(box).getdata())
    m = [sum(p[i] for p in px) / len(px) for i in range(3)]
    sd = max((sum((p[i] - m[i]) ** 2 for p in px) / len(px)) ** 0.5 for i in range(3))
    return tuple(round(v, 1) for v in m) + (round(sd, 1),)


def is_bg(c):
    """the empty viewer: its exact colour, flat"""
    return all(abs(c[i] - BG[i]) < 6 for i in range(3)) and c[3] < 4


class Page(object):
    def __init__(self, ctx, url, cat, mp_url, phone):
        self.pg = ctx.new_page()
        self.phone = phone
        self.errors = []
        self.writes = []
        self.pg.on('pageerror', lambda e: None if "setting 'erases'" in str(e) else self.errors.append(str(e)))
        self.pg.on('request', lambda r: self.writes.append(r.method + ' ' + r.url) if r.method not in ('GET', 'HEAD') else None)
        self.pg.add_init_script(FAKE)
        self.pg.add_init_script('try{localStorage.setItem("vitulus_lang","en")}catch(e){}')
        self.pg.route('**/api/map_sources', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(cat)))
        self.pg.route('**/api/datum', lambda r: r.fulfill(status=200, content_type='application/json',
                                                          body=json.dumps({'ok': True, 'origin_lat': LAT, 'origin_lon': LON})))
        self.pg.route('**/api/ui_settings', lambda r: r.fulfill(status=200, content_type='application/json',
                                                               body=json.dumps({'ok': True, 'settings': {'lang': 'en'}})))
        self.pg.route(re.compile(r'^http://127\.0\.0\.1:8082/.*'), tile_route(cat, mp_url))
        self.url = url
        self.load()

    def load(self, reload=False):
        if reload:   # the same URL again would only be a hash change, not a load
            self.pg.reload(wait_until='domcontentloaded')
        else:
            self.pg.goto(self.url + '#map', wait_until='domcontentloaded')
        self.pg.wait_for_function('window.mapping_v3 && window.__ros3d_map && window.VTI18n', timeout=30000)
        self.pg.wait_for_timeout(2500)

    def ev(self, js, arg=None):
        return self.pg.evaluate(js, arg)

    def canvas(self):
        return self.ev("()=>{const r=document.querySelector('#map_view canvas').getBoundingClientRect();"
                       "return {x:r.x,y:r.y,w:r.width,h:r.height}}")

    def source(self, src):
        self.ev("""(src) => { const M = window.mapping_v3, chk = M.chk_aerial, sel = M.sel_aerial_src;
            if (src === 'none') { if (chk.checked) { chk.checked = false; chk.dispatchEvent(new Event('change')); } return; }
            if (!chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
            sel.value = src; sel.dispatchEvent(new Event('change')); }""", src)

    def camera(self, dist):
        self.ev("""(d) => { const v = window.__ros3d_map, c = v.camera, k = v.cameraControls;
            k.center.set(0, 0, 0); c.position.set(0, 0, d); k.update(); }""", dist)

    def zoom_in_max(self):
        """Zoom in until the distance stops changing (max 120 steps); returns the distances."""
        b = self.canvas()
        cx, cy = b['x'] + b['w'] / 2, b['y'] + b['h'] / 2
        seen = []
        for _ in range(120):
            if self.phone:   # touch device: pinch = the controls' dolly (OrbitControls.zoomOut moves closer)
                self.ev("() => { const k = window.__ros3d_map.cameraControls; k.zoomOut(Math.pow(0.95, 4)); k.update(); }")
            else:            # wheel up moves closer (inverted wheel, ros3d onMouseWheel)
                self.pg.mouse.move(cx, cy)
                for _ in range(4):
                    self.pg.mouse.wheel(0, -120)
            self.pg.wait_for_timeout(40)
            d = self.ev(STATE)['dist']
            if seen and abs(seen[-1] - d) < 1e-6:
                break
            seen.append(d)
        return seen

    def halves(self, shot=None):
        """mean colour of the left (background only) and right (robot map) half around the centre"""
        b = self.canvas()
        self.pg.wait_for_timeout(2500)
        png = self.pg.screenshot(clip={'x': b['x'], 'y': b['y'], 'width': b['w'], 'height': b['h']})
        if shot:
            with open(shot, 'wb') as f:
                f.write(png)
        im = Image.open(io.BytesIO(png)).convert('RGB')
        w, h = im.size
        cx, cy = w // 2, h // 2
        dx, dy = max(8, w // 10), max(8, h // 12)
        return mean(im, (cx - 3 * dx, cy - dy, cx - dx, cy + dy)), mean(im, (cx + dx, cy - dy, cx + 3 * dx, cy + dy))


def story(p, label, shots, mp_url):
    st = p.ev(STATE)
    check('%s: usual zoom keeps the near plane of 20 m' % label, abs(st['near'] - 20) < 1e-6 and st['dist'] > 80, st)
    sent0 = len(p.ev('window.__fake.sent'))
    writes0 = len(p.writes)
    for src in SOURCES:
        p.source(src)
        p.camera(120)
        p.pg.wait_for_timeout(1500 if not mp_url else 4000)
        seen = p.zoom_in_max()
        st = p.ev(STATE)
        check('%s/%s: zoom-in stops at the limit (%.2f m)' % (label, src, st['dist']),
              len(seen) < 120 and st['dist'] >= st['min'] - 1e-6 and st['dist'] < 6, (len(seen), st))
        check('%s/%s: near plane in front of the ground (near %.3f < dist %.2f)' % (label, src, st['near'], st['dist']),
              st['near'] < st['dist'] * 0.5, st)
        if mp_url:
            p.pg.wait_for_timeout(6000)
        left, right = p.halves(os.path.join(shots, '%s_%s_max.png' % (label, src)) if shots else None)
        if src == 'none':
            check('%s/%s: no background map: empty viewer left' % (label, src), is_bg(left), left)
        else:
            check('%s/%s: background map stays visible at the limit' % (label, src), not is_bg(left), left)
            if not mp_url:
                want = TILE_RGB[src]
                check('%s/%s: it is that source\'s tile' % (label, src),
                      all(abs(left[i] - want[i]) < 40 for i in range(3)), (left, want))
        check('%s/%s: robot map stays visible at the limit' % (label, src),
              not is_bg(right) and max(abs(right[i] - left[i]) for i in range(3)) > 8, (left, right))
    sent = p.ev('window.__fake.sent')[sent0:]
    check('%s: zooming sent nothing to the robot (no publish / service but the TF republisher)' % label,
          all(x == '/republish_tfs' for x in sent), sent[:5])
    check('%s: zooming made no HTTP write' % label, len(p.writes) == writes0, p.writes[writes0:writes0 + 5])
    # a stored close pose comes back with the map visible (old code: blank below 20 m)
    p.source('sat')
    p.pg.add_init_script("""try { localStorage.setItem('vitulus_cam_map', JSON.stringify({p: [1, 0, 10], c: [0, 0, 0]})); } catch (e) {}""")
    p.load(reload=True)
    st = p.ev(STATE)
    left, right = p.halves(os.path.join(shots, '%s_restored.png' % label) if shots else None)
    check('%s: stored 10 m pose restored, near %.2f < dist %.2f' % (label, st['near'], st['dist']),
          8 < st['dist'] < 12 and st['near'] < st['dist'] * 0.5, st)
    check('%s: restored close pose shows background + robot map' % label, not is_bg(left) and not is_bg(right), (left, right))
    check('%s: no page errors' % label, not p.errors, p.errors[:3])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=os.path.dirname(HERE), help='vitulus_ui tree to serve (default: this one)')
    ap.add_argument('--shots', default='')
    a = ap.parse_args()
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
    mp_url = os.environ.get('MAPPROXY_URL', '')
    tpl = os.path.join(os.path.abspath(a.root), 'nodes', 'templates')
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=tpl))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/' % srv.server_port
    cat = catalog()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=False,
                               args=['--headless=new', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
        try:
            for vp, phone, label in (((1440, 900), False, 'desk1440'), ((360, 740), True, 'phone360')):
                print('--- %s' % label, flush=True)
                ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone,
                                    device_scale_factor=2 if phone else 1, service_workers='block')
                p = Page(ctx, url, cat, mp_url, phone)
                story(p, label, a.shots, mp_url)
                ctx.close()
        finally:
            b.close()
            srv.shutdown()
    print('\n%d checks, %d failed' % (COUNT[0], len(FAILS)))
    if FAILS:
        print('FAILED: ' + ', '.join(FAILS))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
