#!/usr/bin/env python3
"""The goal marker is placed only by a tap / click in the Marker panel (T22). Real Chrome, nothing reaches
a robot.

/navi_manager/new_interactive_marker makes navi_manager (re)create the goal marker at that point (heading
reset); "Send goal" (/navi_manager/interactive_marker_goal) then drives to it. It used to go out on every
touchstart / mousedown on the map — a pinch sent ~3 messages and moved the goal marker to where the
gesture began, in any panel. Now (map_view.js InteractiveMarkers.attach_tap) only a tap / click without
dragging, with the left button / one finger, while the Marker panel is open.

The page is served from this tree; rosbridge is a fake WebSocket that answers the TF republisher (identity
map) and records every publish. It checks, desktop 1440 (mouse) and phone 360 (real touch events, CDP):
  - pan, pinch (phone), wheel (desktop), in no panel and in the Marker panel: no marker publish;
  - a click / tap with the Map panel open or no panel: no marker publish;
  - a click / tap in the Marker panel, then Send goal: new_interactive_marker at the pressed point
    (the ray of the press hits z=0 there), then interactive_marker_goal "interactiveGoal";
  - a fake interactive marker server (like navi_man: new marker at the point, heading 0) answers:
    the Heading slider's angle survives pan / zoom up to Send goal, and a new marker is turned to the
    slider (T22c), so the goal navi_man sends (model: last new marker / feedback pose) is what is seen;
    heading 0 sends no feedback; only the left mouse button places the marker;
  - with --master TREE the same goal entry on that tree gives the same messages in the same order
    (a touch tap there sends the same pose twice — ROS3D notifies touchstart twice; here once).

    python3 tools/test_marker_tap_ui.py [--root TREE] [--master TREE]

Needs python3-playwright + Google Chrome.
"""
import argparse
import functools
import http.server
import json
import math
import os
import re
import sys
import threading

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = []
COUNT = [0]
LAT, LON = 50.0838, 14.3758      # park Ladronka (public point), never the garden
NEW = '/navi_manager/new_interactive_marker'
GOAL = '/navi_manager/interactive_marker_goal'
FEEDBACK = '/interactive_marker/feedback'


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


# fake rosbridge: TF republisher (identity map/base_link); records every publish with its message
FAKE = r"""
(() => {
  const F = window.__fake = { pubs: [], calls: [] };
  // interactive marker server like navi_man.callback_new_interactive_marker: 'webgui_marker' at the
  // point, heading 0, a free box control + the rotate_z control the Heading slider turns
  const q0 = { x: 0, y: 0, z: 0, w: 1 }, hdr = { frame_id: 'map', stamp: { secs: 0, nsecs: 0 }, seq: 0 };
  const imMarker = (pos) => ({ header: hdr, pose: { position: { x: pos.x, y: pos.y, z: 0 }, orientation: q0 },
    name: 'webgui_marker', description: 'Marker for webUI', scale: 1, menu_entries: [],
    controls: [
      { name: '', orientation: q0, orientation_mode: 0, interaction_mode: 0, always_visible: true,
        markers: [{ header: { frame_id: '', stamp: { secs: 0, nsecs: 0 }, seq: 0 }, ns: '', id: 0, type: 0, action: 0,
          pose: { position: { x: 0, y: 0, z: 0 }, orientation: q0 }, scale: { x: 0.6, y: 0.6, z: 0.6 },
          color: { r: 0.05, g: 1, b: 0, a: 0.8 }, lifetime: { secs: 0, nsecs: 0 }, frame_locked: false, points: [],
          colors: [], text: '', mesh_resource: '', mesh_use_embedded_materials: false }],
        independent_marker_orientation: false, description: '' },
      { name: 'rotate_z', orientation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 }, orientation_mode: 0,
        interaction_mode: 5, always_visible: false, markers: [], independent_marker_orientation: false,
        description: '' }] });
  let imSeq = 0;
  F.eraseMarker = () => F.imws && F.imws.deliver({ op: 'publish', topic: '/interactive_marker/tunneled/update',
    msg: { server_id: 'fake', seq_num: ++imSeq, type: 1, markers: [], poses: [], erases: ['webgui_marker'] } });
  const tfArray = (frames) => ({ transforms: frames.map((f) => ({
      header: { frame_id: 'map', stamp: { secs: 0, nsecs: 0 }, seq: 0 }, child_frame_id: f,
      transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } })) });
  class WS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob'; this.frames = [];
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 20);
    }
    addEventListener() {}
    close() { this.readyState = 3; }
    deliver(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.op === 'call_service') {
        F.calls.push(m.service);
        let v = {};
        if (m.service === '/republish_tfs') {
          this.frames = (m.args && m.args.source_frames) || [];
          v = { topic_name: '/tf_repub_fake' };
        } else if (m.service === '/rosapi/get_param') {
          v = { value: 'null' };
        } else if (m.service === '/interactive_marker/tunneled/get_init') {
          v = { msg: { server_id: 'fake', seq_num: 0, markers: [], poses: [], erases: [] } };
        }
        setTimeout(() => this.deliver({ op: 'service_response', id: m.id, service: m.service, values: v, result: true }), 5);
      } else if (m.op === 'subscribe') {
        if (m.topic === '/interactive_marker/tunneled/update') { F.imws = this; }
        if (m.topic === '/tf_repub_fake') {
          clearInterval(this.tfT);
          this.tfT = setInterval(() => this.deliver({ op: 'publish', topic: m.topic, msg: tfArray(this.frames) }), 200);
        }
      } else if (m.op === 'publish') {
        F.pubs.push({ topic: m.topic, msg: m.msg });
        if (m.topic === '/navi_manager/new_interactive_marker') {   // the server answers with the new marker
          const pos = m.msg.position;
          setTimeout(() => this.deliver({ op: 'publish', topic: '/interactive_marker/tunneled/update',
            msg: { server_id: 'fake', seq_num: ++imSeq, type: 1, markers: [imMarker(pos)], poses: [], erases: [] } }), F.imDelay || 60);
        }
      }
    }
  }
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
"""


def summary(pubs, topics=(NEW, GOAL)):
    """the marker messages, poses rounded to mm"""
    out = []
    for p in pubs:
        if p['topic'] not in topics:
            continue
        m = p['msg']
        if p['topic'] == NEW:
            out.append((NEW, round(m['position']['x'], 3), round(m['position']['y'], 3), m['position']['z'],
                        tuple(m['orientation'][k] for k in 'xyzw')))
        else:
            out.append((GOAL, m.get('data')))
    return out


def at_press(seq, want):
    """poses as 'at the pressed point' (the camera differs between runs, the meaning must not)"""
    return [(s[0], 'at press' if abs(s[1] - want[0]) < 0.01 and abs(s[2] - want[1]) < 0.01 else (s[1], s[2]),
             s[3], s[4]) if s[0] == NEW else s for s in seq]


def yaw(q):
    return math.atan2(2 * (q['w'] * q['z'] + q['x'] * q['y']), 1 - 2 * (q['y'] ** 2 + q['z'] ** 2))


def navi(pubs):
    """navi_man model: the marker pose = the last new marker (heading 0) or the last feedback pose
    (interactiveMarkerFeedback); Send goal -> that pose (x, y, yaw)"""
    pose, goals = None, []
    for p in pubs:
        if p['topic'] == NEW:
            pose = (p['msg']['position']['x'], p['msg']['position']['y'], 0.0)
        elif p['topic'] == FEEDBACK and pose is not None:
            m = p['msg']['pose']
            pose = (m['position']['x'], m['position']['y'], yaw(m['orientation']))
        elif p['topic'] == GOAL:
            goals.append(pose)
    return goals


def same_goal(g, want, heading):
    return len(g) == 1 and g[0] is not None and abs(g[0][0] - want[0]) < 0.01 and abs(g[0][1] - want[1]) < 0.01 \
        and abs(g[0][2] - heading) < 0.01


def dedup(seq):
    return [s for i, s in enumerate(seq) if i == 0 or s != seq[i - 1]]


class Page(object):
    def __init__(self, ctx, url, phone):
        self.pg = ctx.new_page()
        self.phone = phone
        self.errors = []
        self.writes = []
        self.pg.on('pageerror', lambda e: None if "setting 'erases'" in str(e) else self.errors.append(str(e)))
        self.pg.on('request', lambda r: self.writes.append(r.method + ' ' + r.url) if r.method not in ('GET', 'HEAD') else None)
        self.pg.add_init_script(FAKE)
        self.pg.add_init_script('try{localStorage.setItem("vitulus_lang","en")}catch(e){}')
        self.pg.route('**/api/map_sources', lambda r: r.fulfill(status=200, content_type='application/json',
                                                                body=json.dumps({'ok': True, 'version': 1, 'sources': []})))
        self.pg.route('**/api/datum', lambda r: r.fulfill(status=200, content_type='application/json',
                                                          body=json.dumps({'ok': True, 'origin_lat': LAT, 'origin_lon': LON})))
        self.pg.route('**/api/ui_settings', lambda r: r.fulfill(status=200, content_type='application/json',
                                                               body=json.dumps({'ok': True, 'settings': {'lang': 'en'}})))
        self.pg.route(re.compile(r'^http://127\.0\.0\.1:8082/.*'), lambda r: r.abort())
        self.pg.route(re.compile(r'^https?://(?!127\.0\.0\.1).*'), lambda r: r.abort())   # nothing leaves the box
        self.pg.goto(url + '#map', wait_until='domcontentloaded')
        self.pg.wait_for_function('window.mapping_v3 && window.__ros3d_map && window.VTI18n && window.map_menu',
                                  timeout=30000)
        self.pg.wait_for_timeout(2500)
        self.cdp = self.pg.context.new_cdp_session(self.pg) if phone else None

    def ev(self, js, arg=None):
        return self.pg.evaluate(js, arg)

    def pubs(self):
        return self.ev('window.__fake.pubs.slice()')

    def camera(self):
        self.ev("""() => { const v = window.__ros3d_map, c = v.camera, k = v.cameraControls;
            k.center.set(0, 0, 0); c.position.set(0, 0, 60); k.update(); }""")
        self.pg.wait_for_timeout(100)

    def spot(self, fx, fy):
        """a point of the map canvas (fractions of it) that is really the canvas (not a panel over it)"""
        return self.ev("""([fx, fy]) => { const cv = document.querySelector('#map_view canvas'),
                r = cv.getBoundingClientRect(), x = r.x + r.width * fx, y = r.y + r.height * fy;
            return { x: x, y: y, hit: document.elementFromPoint(x, y) === cv }; }""", [fx, fy])

    def expected(self, x, y):
        """where the ray through client point x, y meets z = 0 (the marker the press asks for)"""
        return self.ev("""([x, y]) => { const v = window.__ros3d_map, cv = document.querySelector('#map_view canvas'),
                r = cv.getBoundingClientRect();
            const ndc = new THREE.Vector2((x - r.left) / cv.clientWidth * 2 - 1, -(y - r.top) / cv.clientHeight * 2 + 1);
            const P = new THREE.Matrix4().fromArray(v.camera.projectionMatrix.elements).invert();
            const W = new THREE.Matrix4().fromArray(v.camera.matrixWorld.elements);
            const o = new THREE.Vector3().setFromMatrixPosition(W);
            const d = new THREE.Vector3(ndc.x, ndc.y, 0.5).applyMatrix4(P).applyMatrix4(W).sub(o).normalize();
            const t = -o.z / d.z;
            return [o.x + t * d.x, o.y + t * d.y]; }""", [x, y])

    def panel(self, name):
        """open a drawer panel by its menu button id (marker / map), or close the drawer (none)"""
        self.ev("""(n) => { const m = window.map_menu;
            if (n === 'none') { m.close_drawer(); return; }
            if (m.current_submenu !== n) document.getElementById(n === 'marker' ? 'btn_marker' : 'btn_map').click(); }""", name)
        self.pg.wait_for_timeout(300)
        return self.ev('window.map_menu.current_submenu')

    def heading(self, v):
        self.ev("""(v) => { const r = document.getElementById('range_marker_orientation'); r.value = String(v);
                         r.dispatchEvent(new Event('input')); }""", v)
        self.pg.wait_for_timeout(250)

    def send_goal(self):
        self.ev("() => document.getElementById('btn_marker_send_goal').click()")
        self.pg.wait_for_timeout(300)

    def has_marker(self):
        return self.ev("() => !!window.__ros3d_map.scene.getObjectByName('webgui_marker')")

    # gestures -----------------------------------------------------------------------------------
    def touch(self, kind, pts):
        self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [
            {'x': x, 'y': y, 'id': i, 'radiusX': 1, 'radiusY': 1, 'force': 1} for i, (x, y) in pts]})

    def tap(self, x, y):
        if self.phone:
            self.touch('touchStart', [(0, (x, y))])
            self.pg.wait_for_timeout(60)
            self.touch('touchEnd', [])
        else:
            self.pg.mouse.move(x, y)
            self.pg.mouse.down()
            self.pg.wait_for_timeout(60)
            self.pg.mouse.up()
        self.pg.wait_for_timeout(250)

    def pan(self, x, y, dx=80, dy=40):
        if self.phone:
            self.touch('touchStart', [(0, (x, y))])
            for i in range(1, 11):
                self.touch('touchMove', [(0, (x + dx * i / 10, y + dy * i / 10))])
                self.pg.wait_for_timeout(16)
            self.touch('touchEnd', [])
        else:
            self.pg.mouse.move(x, y)
            self.pg.mouse.down()
            for i in range(1, 11):
                self.pg.mouse.move(x + dx * i / 10, y + dy * i / 10)
                self.pg.wait_for_timeout(16)
            self.pg.mouse.up()
        self.pg.wait_for_timeout(250)

    def pinch(self, x, y, staggered=False):
        """two fingers apart (zoom); staggered = 2nd finger lands later, 1st lifts first"""
        if staggered:
            self.touch('touchStart', [(0, (x - 20, y))])
            self.pg.wait_for_timeout(30)
        self.touch('touchStart', [(0, (x - 20, y)), (1, (x + 20, y))])
        for i in range(1, 11):
            self.touch('touchMove', [(0, (x - 20 - 6 * i, y)), (1, (x + 20 + 6 * i, y))])
            self.pg.wait_for_timeout(16)
        if staggered:
            self.touch('touchEnd', [(1, (x + 80, y))])
            self.pg.wait_for_timeout(30)
        self.touch('touchEnd', [])
        self.pg.wait_for_timeout(250)

    def wheel(self, x, y):
        self.pg.mouse.move(x, y)
        for _ in range(4):
            self.pg.mouse.wheel(0, -120)
            self.pg.wait_for_timeout(30)
        self.pg.wait_for_timeout(250)


def goal_entry(p):
    """Marker panel open, click / tap a spot, Send goal; returns (messages, expected x/y)"""
    p.panel('marker')
    p.camera()
    # a marker an older tree put there during the gestures would catch the tap: remove it (server erase)
    p.ev('() => window.__fake.eraseMarker()')
    p.pg.wait_for_timeout(200)
    s = p.spot(0.5, 0.3)
    want = p.expected(s['x'], s['y'])
    n0 = len(p.pubs())
    p.tap(s['x'], s['y'])
    p.ev("() => document.getElementById('btn_marker_send_goal').click()")
    p.pg.wait_for_timeout(300)
    return summary(p.pubs()[n0:]), want, s['hit']


def story(p, label):
    # turning the heading with no marker yet (none placed): no page error, nothing sent but the slider
    n0 = len(p.pubs())
    p.heading(1.5)
    p.heading(0)
    check('%s: Heading with no marker sends nothing' % label, not [x for x in p.pubs()[n0:]
                                                                    if x['topic'] in (NEW, GOAL, FEEDBACK)])
    s = p.spot(0.5, 0.3)
    check('%s: test point is the map canvas' % label, s['hit'], s)
    x, y = s['x'], s['y']
    gestures = [('pan', lambda: p.pan(x, y))]
    if p.phone:
        gestures += [('pinch', lambda: p.pinch(x, y)), ('staggered pinch', lambda: p.pinch(x, y, True))]
    else:
        gestures += [('wheel', lambda: p.wheel(x, y))]
    counts = {}
    for mode in ('none', 'map', 'marker'):
        got = p.panel(mode)
        check('%s: panel %s open' % (label, mode), got == mode, got)
        for name, fn in gestures:
            p.camera()
            n0 = len(p.pubs())
            fn()
            new = summary(p.pubs()[n0:])
            counts['%s/%s' % (mode, name)] = len(new)
            check('%s: %s in panel %s sends no marker message' % (label, name, mode), not new, new)
        if mode != 'marker':
            p.camera()
            n0 = len(p.pubs())
            p.tap(x, y)
            new = summary(p.pubs()[n0:])
            counts['%s/tap' % mode] = len(new)
            check('%s: %s in panel %s sends no marker message' % (label, 'tap' if p.phone else 'click', mode), not new, new)
    seq, want, hit = goal_entry(p)
    check('%s: goal point is the map canvas' % label, hit)
    ok = (len(seq) == 2 and seq[0][0] == NEW and seq[1] == (GOAL, 'interactiveGoal')
          and abs(seq[0][1] - want[0]) < 0.01 and abs(seq[0][2] - want[1]) < 0.01
          and seq[0][3] == 0 and seq[0][4] == (0, 0, 0, 1))
    check('%s: goal entry = new marker at the pressed point (%.2f, %.2f), then the goal' % (label, want[0], want[1]),
          ok, seq)
    # a second tap moves it (no stale gesture state)
    p.camera()
    s2 = p.spot(0.4, 0.25)
    want2 = p.expected(s2['x'], s2['y'])
    n0 = len(p.pubs())
    p.tap(s2['x'], s2['y'])
    new = summary(p.pubs()[n0:])
    check('%s: next tap moves the marker' % label,
          len(new) == 1 and abs(new[0][1] - want2[0]) < 0.01 and abs(new[0][2] - want2[1]) < 0.01, new)
    p.pg.wait_for_timeout(300)
    check('%s: the fake marker server put the marker on the map' % label, p.has_marker())
    # heading 0 + a new marker: nothing more than before (no feedback)
    check('%s: heading 0: a new marker sends no feedback' % label,
          not [x for x in p.pubs()[n0:] if x['topic'] == FEEDBACK])
    # the heading set on the slider survives pan / zoom up to Send goal
    n0 = len(p.pubs())
    p.heading(1.2)
    s3 = p.spot(0.45, 0.4)
    p.pan(s3['x'], s3['y'])
    if p.phone:
        p.pinch(s3['x'], s3['y'])
    else:
        p.wheel(s3['x'], s3['y'])
    p.send_goal()
    g = navi(p.pubs())[-1:]   # the marker of the 2nd tap is older than n0
    check('%s: Heading 1.2 + pan / zoom -> goal at the marker, heading 1.2 (%s)' % (label, g),
          same_goal(g, want2, 1.2), g)
    # a new marker keeps the slider's heading (navi_man makes it with 0): what is seen is what is sent
    p.camera()
    s4 = p.spot(0.6, 0.22)
    want4 = p.expected(s4['x'], s4['y'])
    n0 = len(p.pubs())
    p.tap(s4['x'], s4['y'])
    p.pg.wait_for_timeout(500)
    fb = [x for x in p.pubs()[n0:] if x['topic'] == FEEDBACK]
    check('%s: new marker turned to the slider (feedback heading %s)' % (
        label, [round(yaw(x['msg']['pose']['orientation']), 3) for x in fb]),
        len(fb) == 1 and abs(yaw(fb[0]['msg']['pose']['orientation']) - 1.2) < 0.01, fb[:2])
    p.send_goal()
    g = navi(p.pubs()[n0:])
    check('%s: Send goal after a new marker -> new point, heading 1.2 (%s)' % (label, g), same_goal(g, want4, 1.2), g)
    # two quick taps: the second marker gets the heading too
    s5, s6 = p.spot(0.35, 0.2), p.spot(0.65, 0.3)
    want6 = p.expected(s6['x'], s6['y'])
    n0 = len(p.pubs())
    p.tap(s5['x'], s5['y'])
    p.tap(s6['x'], s6['y'])
    p.pg.wait_for_timeout(500)
    p.send_goal()
    g = navi(p.pubs()[n0:])
    check('%s: two quick taps -> the 2nd point, heading 1.2 (%s)' % (label, g), same_goal(g, want6, 1.2), g)
    # the slider moved while the new marker is on its way: the old marker is left alone, the new one gets it
    p.ev('() => { window.__fake.imDelay = 600; }')
    s7 = p.spot(0.4, 0.3)
    want7 = p.expected(s7['x'], s7['y'])
    n0 = len(p.pubs())
    p.tap(s7['x'], s7['y'])
    p.heading(0.8)
    early = [x for x in p.pubs()[n0:] if x['topic'] == FEEDBACK]
    p.pg.wait_for_timeout(900)
    p.ev('() => { window.__fake.imDelay = 0; }')
    fb = [x for x in p.pubs()[n0:] if x['topic'] == FEEDBACK]
    p.send_goal()
    g = navi(p.pubs()[n0:])
    check('%s: slider during the wait does not turn the old marker' % label, not early, early[:1])
    check('%s: ...the new marker gets the angle: goal at the new point, heading 0.8 (%s)' % (label, g),
          len(fb) == 1 and same_goal(g, want7, 0.8), (len(fb), g))
    p.heading(0)
    # only the left mouse button places the marker
    if not p.phone:
        for btn in ('right', 'middle'):
            n0 = len(p.pubs())
            p.pg.mouse.click(s4['x'], s4['y'], button=btn)
            p.pg.wait_for_timeout(300)
            new = summary(p.pubs()[n0:])
            check('%s: %s click places no marker' % (label, btn), not new, new)
        n0 = len(p.pubs())
        p.pg.mouse.click(s4['x'], s4['y'], button='left')
        p.pg.wait_for_timeout(300)
        check('%s: left click places it' % label, len(summary(p.pubs()[n0:])) == 1)
    check('%s: no page errors' % label, not p.errors, p.errors[:3])
    check('%s: no HTTP write' % label, not p.writes, p.writes[:3])
    return at_press(seq, want), counts


def run_tree(b, root, label_root, master_mode=False):
    tpl = os.path.join(os.path.abspath(root), 'nodes', 'templates')
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=tpl))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/' % srv.server_port
    res = {}
    try:
        for vp, phone, label in (((1440, 900), False, 'desk1440'), ((360, 740), True, 'phone360')):
            ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone,
                                device_scale_factor=2 if phone else 1, service_workers='block')
            p = Page(ctx, url, phone)
            if master_mode:
                # baseline only: what the old tree sends for the same goal entry and for gestures
                # (gestures away from the goal point: an old tree places a marker where they begin)
                s = p.spot(0.5, 0.4)
                counts = {}
                for mode in ('none', 'marker'):
                    p.panel(mode)
                    p.camera()
                    n0 = len(p.pubs())
                    (p.pinch if phone else p.pan)(s['x'], s['y'])
                    counts['%s/%s' % (mode, 'pinch' if phone else 'pan')] = len(summary(p.pubs()[n0:]))
                seq, want, hit = goal_entry(p)
                res[label] = (at_press(seq, want), counts)
            else:
                print('--- %s %s' % (label_root, label), flush=True)
                res[label] = story(p, label)
            ctx.close()
    finally:
        srv.shutdown()
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=os.path.dirname(HERE), help='vitulus_ui tree to serve (default: this one)')
    ap.add_argument('--master', default='', help='old tree to compare the goal entry with')
    a = ap.parse_args()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=False,
                               args=['--headless=new', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
        try:
            new = run_tree(b, a.root, 'tree')
            if a.master:
                old = run_tree(b, a.master, 'master', master_mode=True)
                print('--- compare with master', flush=True)
                for label in new:
                    nseq, ncounts = new[label]
                    oseq, ocounts = old[label]
                    print('     %s master gestures: %s, goal entry: %s' % (label, ocounts, oseq), flush=True)
                    print('     %s tree   gestures: %s, goal entry: %s' % (label, ncounts, nseq), flush=True)
                    check('%s: goal entry = master (same messages, same order%s)' % (
                        label, '; master repeats the touch pose' if dedup(oseq) != oseq else ''),
                        dedup(oseq) == nseq, (oseq, nseq))
        finally:
            b.close()
    print('\n%d checks, %d failed' % (COUNT[0], len(FAILS)))
    if FAILS:
        print('FAILED: ' + ', '.join(FAILS))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
