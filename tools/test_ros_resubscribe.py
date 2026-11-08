#!/usr/bin/env python3
"""D11 (D10 review): after N rosbridge reconnects every topic is subscribed ONCE.

The page is served from this tree on a private port; WebSocket is replaced by a fake
rosbridge before the page runs (nothing reaches a robot). The fake keeps, per socket
(= one rosbridge connection), the live subscriptions: subscribe adds its id, unsubscribe
removes it. Then the fake drops the link 5x (like a Wi-Fi gap or a rosbridge restart);
after every reconnect each topic must have exactly one live subscription on the new
socket (rosbridge sends one copy of every message per subscription id, so a topic that
is subscribed 6x costs 6x the bandwidth and runs its handlers 6x).

The map section is shown, the page stays in the foreground. Both the page's main link
(map_view.js ROS) and its other ROSLIB.Ros links are counted, each per socket.

    python3 tools/test_ros_resubscribe.py [--reconnects 5]

Needs python3-playwright + Google Chrome.
"""
import argparse
import functools
import http.server
import json
import os
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, 'nodes', 'templates')
FAILS = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]), flush=True)
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
  const F = window.__fake = { socks: [], refuse: 0, mute: false, slowClose: 0, latched: { '/t11/latched': { data: 'cfg' } } };
  class WS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob';
      this.subs = {};      // id -> topic (live subscriptions on this connection)
      this.adv = {};       // id -> topic
      this.ops = {};       // topic -> subscribe ops - unsubscribe ops (repeats of one id count too)
      this.aops = {};      // topic -> advertise ops - unadvertise ops
      this.n = F.socks.length; F.socks.push(this);
      if (F.refuse > 0 && url === F.mainUrl) {      // the server is not there (yet)
        F.refuse--;
        setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1006 }); }, 30);
        return;
      }
      setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen && this.onopen({}); }, 20);
    }
    addEventListener() {}
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;   // a half-open link takes its time to report the close
      setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1000 }); }, F.slowClose || 5);
    }
    drop() {            // the server side goes away
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose && this.onclose({ code: 1006 });
    }
    deliver(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    send(raw) {
      if (this.readyState !== 1) throw new Error('send on a closed socket');
      const m = JSON.parse(raw);
      const t = m.topic;
      if (m.op === 'subscribe') { this.subs[m.id] = t; this.ops[t] = (this.ops[t] || 0) + 1; (this.last = this.last || {})[t] = m;
        // rosbridge hands a latched topic's last message out on EVERY subscribe op (also a repeated id)
        if (t in F.latched) { setTimeout(() => { if (this.readyState === 1) this.deliver({ op: 'publish', topic: t, msg: F.latched[t] }); }, 5); } }
      else if (m.op === 'unsubscribe') { delete this.subs[m.id]; this.ops[t] = (this.ops[t] || 0) - 1; }
      else if (m.op === 'advertise') { this.adv[m.id] = t; this.aops[t] = (this.aops[t] || 0) + 1; }
      else if (m.op === 'unadvertise') { delete this.adv[m.id]; this.aops[t] = (this.aops[t] || 0) - 1; }
      else if (m.op === 'call_service' && !F.mute) {
        setTimeout(() => { if (this.readyState === 1) this.deliver({ op: 'service_response', id: m.id, service: m.service, values: {}, result: false }); }, 5);
      }
    }
  }
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
  // live sockets grouped by url: { url: [{n, perTopic: {topic: count}}] }
  F.report = (what) => {
    const out = {};
    F.socks.filter((s) => s.readyState === 1).forEach((s) => {
      const per = {};
      if (what === 'ops' || what === 'aops') { Object.assign(per, s[what]); Object.keys(per).forEach((t) => { if (!per[t]) delete per[t]; }); }
      else Object.values(s[what || 'subs']).forEach((t) => { per[t] = (per[t] || 0) + 1; });
      (out[s.url] = out[s.url] || []).push({ n: s.n, per });
    });
    return out;
  };
})();
"""


# how the link goes away (cycled through the reconnects)
KINDS = ('drop', 'refused', 'half-open', 'suspend', 'drop')
KINDS_JS = {
    # the server side drops every live link (Wi-Fi gap, rosbridge restart)
    'drop': """() => { ros._reconnect_delay = 200;
        __fake.socks.filter((s) => s.readyState === 1).forEach((s) => s.drop()); }""",
    # dropped, and the first two attempts to come back fail (rosbridge still starting)
    'refused': """() => { ros._reconnect_delay = 200; __fake.refuse = 2;
        __fake.socks.filter((s) => s.readyState === 1).forEach((s) => s.drop()); }""",
    # nothing comes back any more: the heartbeat gives up and closes; the close
    # itself takes 3 s to report (TCP half-open)
    'half-open': """() => { __fake.mute = true; __fake.slowClose = 3000; ros._last_msg_at = 0;
        const s = __fake.socks.find((x) => x.readyState === 1 && x.url === __fake.mainUrl);
        s.deliver = () => {}; }""",
    # the map section hides and shows again before the close is reported
    'suspend': """() => { __fake.slowClose = 400; ros.suspend(); setTimeout(() => ros.resume(), 50); }""",
}


UNITS = r"""
async () => {
  const R = ros.ros, out = {};
  const live = () => __fake.socks.find((s) => s.readyState === 1 && s.url === __fake.mainUrl);
  const count = (t, what) => Object.values(live()[what || 'subs']).filter((x) => x === t).length;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mk = (name, o) => new ROSLIB.Topic(Object.assign({ ros: R, name, messageType: 'std_msgs/String' }, o || {}));
  // 1) two objects, one wire subscription, both get every message, the last one out unsubscribes
  const a = mk('/t11/a'), b = mk('/t11/a'); let na = 0, nb = 0;
  a.subscribe(() => na++); b.subscribe(() => nb++);
  out.shared_ops = live().ops['/t11/a']; out.shared_live = count('/t11/a');
  live().deliver({ op: 'publish', topic: '/t11/a', msg: { data: 'x' } }); await wait(20);
  out.shared_msgs = [na, nb];
  a.unsubscribe(); out.after_a = count('/t11/a');
  b.unsubscribe(); out.after_b = count('/t11/a');
  // 2) subscribe + publish on one object, then unsubscribe: after a reconnect it stays unsubscribed, still advertised
  const c = mk('/t11/c'); c.subscribe(() => {}); c.publish({ data: 'hi' }); c.unsubscribe();
  // 3) the merge: the lower throttle wins while it is there (same id), and goes back after
  const d = mk('/t11/d', { throttle_rate: 1000 }), e = mk('/t11/d', { throttle_rate: 0 });
  d.subscribe(() => {}); const id1 = live().last['/t11/d'].id;
  e.subscribe(() => {}); out.merge_on = [live().last['/t11/d'].throttle_rate, live().last['/t11/d'].id === id1, count('/t11/d')];
  e.unsubscribe(); out.merge_off = [live().last['/t11/d'].throttle_rate, count('/t11/d')];
  // 4) subscribed while the link is down: one op on the next socket
  ros._reconnect_delay = 200; live().drop();
  const f = mk('/t11/f'); f.subscribe(() => {});
  await new Promise((r) => { const iv = setInterval(() => { if (ros.state === 'connected') { clearInterval(iv); r(); } }, 50); });
  await wait(300);
  out.c_after = [count('/t11/c'), Object.values(live().adv).filter((x) => x === '/t11/c').length];
  out.f_ops = live().ops['/t11/f'];
  out.d_after = [count('/t11/d'), live().last['/t11/d'].throttle_rate];
  // 5) a latched topic: a module that subscribes later still gets the value (one live id)
  const la = mk('/t11/latched'), lb = mk('/t11/latched'); let nla = 0, nlb = 0;
  la.subscribe(() => nla++); await wait(60);
  lb.subscribe(() => nlb++); await wait(60);
  out.latched = [nla >= 1, nlb, count('/t11/latched')];
  la.unsubscribe(); lb.unsubscribe();
  d.unsubscribe(); f.unsubscribe(); c.unadvertise();
  out.cleanup = [count('/t11/d'), count('/t11/f'), Object.values(live().adv).filter((x) => x === '/t11/c').length];
  return out;
}
"""


def units(pg, label):
    u = pg.evaluate(UNITS)
    # the later one repeats the SAME id (rosbridge: one entry, a latched value handed out again)
    check('%s: two Topic objects share one live subscription (2nd op = same id)' % label, u['shared_live'] == 1 and u['shared_ops'] == 2, u)
    check('%s: both objects get every message once' % label, u['shared_msgs'] == [1, 1], u)
    check('%s: the wire subscription stays while one object listens' % label, u['after_a'] == 1 and u['after_b'] == 0, u)
    check('%s: lower throttle wins while it is there (same id)' % label, u['merge_on'] == [0, True, 1], u)
    check('%s: throttle goes back when it leaves' % label, u['merge_off'] == [1000, 1], u)
    check('%s: subscribe+publish+unsubscribe: no resubscribe after a reconnect, still advertised' % label, u['c_after'] == [0, 1], u)
    check('%s: subscribed while down: one op on the next socket' % label, u['f_ops'] == 1, u)
    check('%s: merged params survive a reconnect' % label, u['d_after'] == [1, 1000], u)
    check('%s: latched topic: a later subscriber gets the value, still one live id' % label, u['latched'] == [True, 1, 1], u)
    check('%s: last unsubscribe / unadvertise close the wire' % label, u['cleanup'] == [0, 0, 0], u)


def snapshot(pg, what='subs'):
    return pg.evaluate('(w) => __fake.report(w)', what)


def dupes(rep):
    """{url: {topic: count}} of topics with more than one live subscription on one socket."""
    out = {}
    for url, socks in rep.items():
        for s in socks:
            d = {t: c for t, c in s['per'].items() if c > 1}
            if d:
                out.setdefault(url, {}).update(d)
    return out


def topics(rep):
    return {url: sorted(set(t for s in socks for t in s['per'])) for url, socks in rep.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reconnects', type=int, default=5)
    a = ap.parse_args()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=TPL))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/' % srv.server_port
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=False,
                               args=['--headless=new', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
        for label, vp, phone in (('desk', (1440, 900), False), ('phone', (390, 844), True)):
            print('--- %s' % label, flush=True)
            ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, is_mobile=phone, has_touch=phone,
                                service_workers='block')
            ctx.route('**/*', lambda r: r.continue_() if r.request.method in ('GET', 'HEAD') and r.request.url.startswith(url) else r.abort())
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.add_init_script(FAKE)
            pg.goto(url, wait_until='domcontentloaded')
            pg.wait_for_function("window.ros && ros.state === 'connected'", timeout=30000)
            pg.wait_for_timeout(4000)      # late subscribers (timers, lazy panels) are in
            base = snapshot(pg)
            main_url = pg.evaluate('ros._url')
            n0 = len(base.get(main_url, [{}])[0].get('per', {}))
            check('%s: main link up with %d topics' % (label, n0), n0 > 5, base)
            check('%s: no topic twice before any reconnect' % label, not dupes(base), dupes(base))
            t0 = topics(base)
            pg.evaluate('(u) => { __fake.mainUrl = u; }', main_url)
            worst = {}
            for i in range(a.reconnects):
                kind = KINDS[i % len(KINDS)]
                pg.evaluate(KINDS_JS[kind])
                pg.wait_for_function("ros.state !== 'connected'", timeout=30000)
                pg.wait_for_function("ros.state === 'connected'", timeout=40000)
                pg.wait_for_timeout(2500)
                rep = snapshot(pg)
                d = dupes(rep)
                dops = dupes(snapshot(pg, 'ops'))
                for u, per in list(d.items()) + list(dops.items()):
                    for t, c in per.items():
                        worst.setdefault(u, {})[t] = max(c, worst.get(u, {}).get(t, 0))
                lost = {u: sorted(set(ts) - set(topics(rep).get(u, []))) for u, ts in t0.items()}
                lost = {u: v for u, v in lost.items() if v}
                links = len(rep.get(main_url, []))
                tag = '%s: reconnect %d (%s)' % (label, i + 1, kind)
                check(tag + ': one live main link', links == 1, links)
                check(tag + ': every topic one live subscription', not d, d)
                check(tag + ': every topic one subscribe op', not dops, dops)
                check(tag + ': no topic lost', not lost, lost)
                pg.evaluate("() => { __fake.mute = false; __fake.slowClose = 0; __fake.refuse = 0; }")
            adv = dupes(snapshot(pg, 'adv'))
            aops = dupes(snapshot(pg, 'aops'))
            check('%s: every published topic one advertise op' % label, not aops, aops)
            check('%s: no topic advertised twice after %d reconnects' % (label, a.reconnects), not adv, adv)
            if worst:
                print('     worst counts:', json.dumps(worst, sort_keys=True))
            units(pg, label)
            check('%s: no page errors' % label, not errs, errs[:3])
            ctx.close()
        b.close()
    srv.shutdown()
    print('%s (%d failed)' % ('FAILED' if FAILS else 'PASSED', len(FAILS)))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
