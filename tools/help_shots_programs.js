/* help_shots_programs.js — init script for tools/help_shots.py: the Programs pictures
 * (shot-programs, shot-program-settings) from invented programs with the zone pictures
 * over a background map of a PUBLIC place (park Ladronka, Prague) — never the robot's garden.
 *
 *   python3 -m http.server -d nodes/templates 7862 &      # the UI of this worktree
 *   # + a local MapProxy on 127.0.0.1:8082 (docker-mapproxy, see docs/help/README.md)
 *   tools/help_shots.py --url http://127.0.0.1:7862 --init-script tools/help_shots_programs.js \
 *       --aerial-public --only shot-programs,shot-program-settings
 *
 * WebSocket is replaced before the page runs (the same fake rosbridge as
 * tools/help_shots_autonomy.js): it answers subscribe from the latched messages
 * below and swallows everything else. GET /api/datum is answered in the page
 * with the public point; help_shots.py --aerial-public checks that before it
 * lets the background map stay on. Background: Orthophoto ČÚZK (open data).
 */
(() => {
  // park Ladronka (Prague 6): a public place, not where any robot lives
  const LAT = 50.0817, LON = 14.35;
  const lon0 = 33 * 6 - 183;
  const yaw = Math.atan(Math.tan((LON - lon0) * Math.PI / 180) * Math.sin(LAT * Math.PI / 180));
  const DATUM = { ok: true, available: true, origin_lat: LAT, origin_lon: LON, yaw_rad: yaw, utm_zone: 33, utm_epsg: 32633,
                  utm_e: 453495.6, utm_n: 5547916.9, alt: 200, public_test_point: 'Ladronka' };
  const _fetch = window.fetch.bind(window);
  window.fetch = (u, o) => (String(u).split('?')[0].endsWith('/api/datum')
    ? Promise.resolve(new Response(JSON.stringify(DATUM), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : _fetch(u, o));
  try {
    localStorage.setItem('vitulus_layer_aerial', '1');
    localStorage.setItem('vitulus_aerial_src', 'cuzk');
  } catch (e) { /* private window */ }

  const P = (x, y) => ({ x, y, z: 0 });
  const zone = (name, ring, cut, rpm) => ({ header: { frame_id: 'map' }, name, area: 0, length: 0, cut_height: cut, rpm,
    type: 'mow', border_paths: 1, coverage_angle: 0, paths_distance: 0.45, simplify: 0.1,
    polygon: { header: { frame_id: 'map' }, polygon: { points: ring.map(([x, y]) => P(x, y)) } }, paths: [] });
  const area = (r) => Math.round(Math.abs(r.reduce((a, [x, y], i) => { const [u, v] = r[(i + 1) % r.length]; return a + x * v - u * y; }, 0)) / 2);
  const Z = [
    zone('front_lawn', [[-30, -40], [25, -40], [25, -8], [-30, -8]], 50, 3000),
    zone('back_lawn', [[-30, -4], [25, -4], [28, 30], [-26, 34]], 55, 3000),
    zone('meadow_edge', [[30, -30], [55, -26], [52, 12], [32, 8]], 70, 2800),
    zone('orchard', [[-60, -20], [-36, -24], [-34, 6], [-58, 10]], 60, 2900),
  ];
  Z.forEach((z) => { z.area = area(z.polygon.polygon.points.map((p) => [p.x, p.y])); z.length = Math.round(z.area / 0.45); });
  const prog = (name, zl, extra) => Object.assign({ header: { frame_id: 'map' }, name, map_name: 'PARK', last_result: '',
    area: zl.reduce((a, z) => a + z.area, 0), length: zl.reduce((a, z) => a + z.length, 0), last_duration_minutes: 0,
    zone_list: zl, rpm: 0, cut_height: 0, speed: 'mid', override_zone: false }, extra || {});
  const programs = { program_list: [
    prog('front_lawn', [Z[0]], { last_result: 'succeeded', last_duration_minutes: 74 }),
    prog('whole_garden', [Z[0], Z[1]], { last_result: 'failed: on_path-back_lawn-2-40', last_duration_minutes: 96,
                                         override_zone: true, cut_height: 45, rpm: 3200 }),
    prog('meadow_edge', [Z[2]], {}),
    prog('orchard', [Z[3]], { last_result: 'failed: on_planner', last_duration_minutes: 1 }),
  ] };
  const latched = {
    '/web_plan/program_list': programs,
    '/web_plan/zone_list': { zone_list: Z },
    '/navi_manager/active_map': { data: 'PARK' },
    '/mower_smach/status': { data: 'Ready' },
    '/mower_smach/active_program': { data: ' ' },
  };
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; this.binaryType = 'blob';
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 20); }
    addEventListener() {}
    close() { this.readyState = 3; }
    deliver(o) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
    send(raw) {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.op === 'subscribe' && m.topic in latched) {
        setTimeout(() => this.deliver({ op: 'publish', topic: m.topic, msg: latched[m.topic] }), 30);
      } else if (m.op === 'call_service') {
        setTimeout(() => this.deliver({ op: 'service_response', id: m.id, service: m.service, values: {}, result: false }), 5);
      }
    }
  }
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
