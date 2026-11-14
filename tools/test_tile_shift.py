#!/usr/bin/env python3
"""Measuring a background map against the ČÚZK orthophoto (nodes/tile_shift.py + the
webnode route POST /api/tile_offsets/measure, T17 M13).

    python3 tools/test_tile_shift.py

An INVENTED scene (random roofs and roads, no garden data, no network): the "reference"
tiles are cut from it, the "source" tiles from the same scene moved by a known shift,
with other brightness and its own noise (another camera). Checks:
  - the measurement returns the shift it was given to +/-0.1 m (several shifts, both
    levels), with the right signs (east/north of the reference);
  - the gate refuses a flat area ("flat"), two unrelated pictures ("weak"), levels that
    disagree ("disagree"), and lets the good case through;
  - the route (a small Flask app with the real register(), when Flask is installed):
    validation (400), another map (409), the reference itself / a drawn map / an
    unknown key (422), no datum (503), tiles that fail (502), a second measurement
    while one runs (409 busy), a slow MapProxy (504 at the time limit, the lock freed
    after), the proposal = the map's ČÚZK offset minus the measured shift turned into
    the map frame, a proposal over the bound refused ("range"), nothing stored;
  - the meta of the store: clean_meta / stamp (measured stays measured after a nudge,
    old records without meta read as before), and webnode uses exactly these.
"""
import io
import math
import os
import sys
import threading
import time

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'nodes'))
import tile_shift as ts  # noqa: E402

FAILS = []


def ok(label, cond, info=''):
    print(('ok   ' if cond else 'FAIL ') + label + ('' if cond or info == '' else ' — ' + str(info)), flush=True)
    if not cond:
        FAILS.append(label)


LAT, LON = 50.0838, 14.3758          # park Ladronka (a public point), never the garden
SRC = {'id': 'sat', 'kind': 'base', 'group': 'photo', 'layer': 'src_layer', 'grid': 'gm_grid', 'format': 'png', 'max_zoom': 21}
REF = {'id': 'cuzk', 'kind': 'base', 'group': 'photo', 'layer': 'ref_layer', 'grid': 'gm_grid', 'format': 'png', 'max_zoom': 20}
MAPSRC = {'id': 'gmap', 'kind': 'base', 'group': 'map', 'layer': 'map_layer', 'grid': 'gm_grid', 'format': 'png',
          'offset_key': 'sat', 'max_zoom': 21}
OSM = {'id': 'osm', 'kind': 'base', 'group': 'map', 'layer': 'osm_layer', 'grid': 'gm_grid', 'format': 'png', 'max_zoom': 19}
W_TILES = 16                          # the world: 16 x 16 z20 tiles around the point
fx20, fy20 = ts.tile_xy(LAT, LON, 20)
WX, WY = (int(fx20) // 2) * 2 - W_TILES // 2, (int(fy20) // 2) * 2 - W_TILES // 2


def scene(seed, n=900):
    """Roofs and roads: random grey rectangles on a mottled ground."""
    rng = np.random.RandomState(seed)
    size = W_TILES * 256
    a = ndimage.gaussian_filter(rng.rand(size, size) * 60, 6) * 6 + 90
    for _ in range(n):
        x, y = rng.randint(0, size - 80, 2)
        w, h = rng.randint(12, 80, 2)
        a[y:y + h, x:x + w] = rng.randint(30, 230)
    return a


def camera(a, seed, gain=0.8, bias=25.0, noise=6.0):
    """The same ground through another camera: other contrast, its own grain."""
    rng = np.random.RandomState(seed)
    return np.clip(a * gain + bias + rng.randn(*a.shape) * noise, 0, 255)


def png(a):
    b = io.BytesIO()
    Image.fromarray(np.asarray(a, np.uint8)).save(b, 'PNG')
    return b.getvalue()


def world_fetch(worlds, counter=None, delay=0.0, fail=None):
    """fetch() over {layer: z20 world array or {zoom: array}}; z19 = the z20 world halved."""
    cache = {}

    def level(layer, z):
        k = (layer, z)
        if k not in cache:
            w = worlds[layer]
            f = 2 ** (20 - z)
            if isinstance(w, dict):
                cache[k] = w[z]              # given per level, already at its size
            else:
                cache[k] = w if f == 1 else w.reshape(w.shape[0] // f, f, w.shape[1] // f, f).mean(axis=(1, 3))
        return cache[k]

    def fetch(layer, grid, fmt, z, x, y):
        if counter is not None:
            counter.append((layer, z, x, y))
        if delay:
            time.sleep(delay)
        if fail and fail(layer, z, x, y):
            raise IOError('HTTP Error 500')
        f = 2 ** (20 - z)
        a = level(layer, z)
        px, py = (x * f - WX) * 256 // f, (y * f - WY) * 256 // f
        t = a[py:py + 256, px:px + 256]
        if t.shape != (256, 256):
            raise IOError('tile outside the test world: %s z%d %d/%d' % (layer, z, x, y))
        return png(t)
    return fetch


G20 = ts.gsd(LAT, 20)
BASE = scene(1)
REF_W = camera(BASE, 2, 1.0, 0.0, 4.0)


def shifted(east_m, north_m, seed=3):
    """The scene as the source shows it: the picture lies east_m / north_m of the reference."""
    return camera(ndimage.shift(BASE, (-north_m / G20, east_m / G20), order=1, mode='nearest'), seed)


# ---- 1. the measurement returns the given shift ---------------------------------
print('the measurement returns the shift it was given')
for east, north in ((0.0, 0.95), (1.07, -0.51), (0.0, 0.0), (-3.4, 2.2)):
    n = []
    r = ts.measure(world_fetch({'src_layer': shifted(east, north), 'ref_layer': REF_W}, n), SRC, REF, LAT, LON)
    err = math.hypot(r['east'] - east, r['north'] - north)
    ok('shift %+.2f E %+.2f N -> %+.2f / %+.2f (to 0.1 m), gate open' % (east, north, r['east'], r['north']),
       err <= 0.1 and r['ok'] and r['reason'] == '', r)
    ok('  both levels agree to 0.1 m, clear peaks (snr %.0f)' % r['snr'],
       r['agree_m'] is not None and r['agree_m'] <= 0.1 and r['snr'] >= 2 * ts.SNR_MIN, r)
ok('the plan: z20 6x6 with windows, checked at z19 5x5; %d tiles' % len(n),
   ts.plan_for(SRC, REF) == ((20, 6, True), (19, 5, False)) and len(n) == 2 * (36 + 25) and r['tiles'] == len(n), len(n))
ok('a source one level coarser is read one level above its own (Bing z19 at z20)',
   ts.plan_for({'max_zoom': 19}, REF)[0][0] == 20 and ts.plan_for({'max_zoom': 18}, REF) == ((19, 6, True), (18, 5, False)))

# detail only in one corner of the area (a garden: lawn, the houses at the edge)
corner = np.full_like(BASE, 120.0)
q = 256 * 6
corner[q:q + 900, q:q + 900] = BASE[q:q + 900, q:q + 900]
lawn_a = ndimage.gaussian_filter(np.random.RandomState(7).rand(*BASE.shape) * 255, 3) * 4
lawn_b = ndimage.gaussian_filter(np.random.RandomState(8).rand(*BASE.shape) * 255, 3) * 4
src_c = camera(ndimage.shift(corner, (-0.95 / G20, 0.0), order=1, mode='nearest') + lawn_a - lawn_a.mean(), 4)
ref_c = camera(corner + lawn_b - lawn_b.mean(), 5, 1.0, 0.0, 4.0)
r = ts.measure(world_fetch({'src_layer': src_c, 'ref_layer': ref_c}), SRC, REF, LAT, LON)
ok('houses in one corner, different lawn elsewhere: still 0.95 m north (%.2f / %.2f, snr %.0f)' % (r['east'], r['north'], r['snr']),
   math.hypot(r['east'], r['north'] - 0.95) <= 0.1 and r['ok'], r)

# ---- 2. the gate -------------------------------------------------------------------
print('\nthe gate')
flat = np.full_like(BASE, 128.0)
haze = camera(flat, 9, 1, 0, 2.0)            # a field in fog: grain, no shapes
r = ts.measure(world_fetch({'src_layer': haze, 'ref_layer': camera(flat, 10, 1, 0, 2.0)}), SRC, REF, LAT, LON)
ok('an area without contrast: refused as "flat"', not r['ok'] and r['reason'] == 'flat', r)
r = ts.measure(world_fetch({'src_layer': haze, 'ref_layer': REF_W}), SRC, REF, LAT, LON)
ok('a source without contrast over a real orthophoto: refused as "flat"', not r['ok'] and r['reason'] == 'flat', r)
# MapProxy's filling for tiles it could not get: one plain colour
white = np.full_like(BASE, 255.0)
for label, worlds in (('every tile plain white', {'src_layer': white, 'ref_layer': white}),
                      ('the source plain white over a real orthophoto', {'src_layer': white, 'ref_layer': REF_W}),
                      ('the orthophoto plain grey', {'src_layer': shifted(0, 0.95), 'ref_layer': flat})):
    try:
        r = ts.measure(world_fetch(worlds), SRC, REF, LAT, LON)
        ok('%s: "blank", not "flat"' % label, False, r)
    except ts.MeasureError as e:
        ok('%s: an error "blank" (empty tiles), not "too little detail"' % label, e.reason == 'blank', (e.reason, e.detail))
some = shifted(0.0, 0.95).copy()
fx_, fy_ = ts.tile_xy(LAT, LON, 20)
bx, by = (int(fx_) - 3 - WX) * 256, (int(fy_) - 3 - WY) * 256      # the top-left 2 x 2 tiles of the z20 area
some[by:by + 512, bx:bx + 512] = 255.0
r = ts.measure(world_fetch({'src_layer': some, 'ref_layer': REF_W}), SRC, REF, LAT, LON)
ok('a few empty tiles (4 of 36) are tolerated, the rest still reads 0.95 m north',
   r['ok'] and math.hypot(r['east'], r['north'] - 0.95) <= 0.1, r)

# the shift differs inside the area: said as spread_m, the clearest part wins
print('\nthe spread inside the area')
r = ts.measure(world_fetch({'src_layer': shifted(0.0, 0.95), 'ref_layer': REF_W}), SRC, REF, LAT, LON)
ok('one shift everywhere: all 17 readings clear, spread %.2f m (under 0.1)' % r['spread_m'],
   r['windows'] == 17 and r['spread_m'] < 0.1, (r['windows'], r['spread_m']))
two = shifted(0.0, 0.95).copy()
east_half = shifted(-0.7, 1.45, seed=11)
mid = (int(fx_) - WX) * 256
two[:, mid:] = east_half[:, mid:]
r = ts.measure(world_fetch({'src_layer': two, 'ref_layer': REF_W}), SRC, REF, LAT, LON)
d = math.hypot(0.7, 0.5)
ok('west half 0.00 / 0.95, east half -0.70 / 1.45: spread %.2f m (the true difference %.2f), %d clear readings'
   % (r['spread_m'], d, r['windows']), r['windows'] >= 2 and abs(r['spread_m'] - d) <= 0.15, r)
ok('  the returned shift is one of the two real ones, not a mix',
   min(math.hypot(r['east'], r['north'] - 0.95), math.hypot(r['east'] + 0.7, r['north'] - 1.45)) <= 0.1, (r['east'], r['north']))
r = ts.measure(world_fetch({'src_layer': camera(scene(77), 6), 'ref_layer': REF_W}), SRC, REF, LAT, LON)
ok('two unrelated pictures: refused as "weak" (snr %.1f < %g)' % (r['snr'], ts.SNR_MIN), not r['ok'] and r['reason'] == 'weak', r)
half = lambda a: a.reshape(a.shape[0] // 2, 2, a.shape[1] // 2, 2).mean(axis=(1, 3))
r = ts.measure(world_fetch({'src_layer': {20: shifted(0.0, 0.95), 19: half(shifted(0.6, 0.2))}, 'ref_layer': REF_W}),
               SRC, REF, LAT, LON)
ok('levels 0.96 m apart: refused as "disagree" (%.2f m > %g)' % (r['agree_m'] or 0, ts.AGREE_MAX_M),
   not r['ok'] and r['reason'] == 'disagree' and r['agree_m'] > ts.AGREE_MAX_M, r)
r = ts.measure(world_fetch({'src_layer': {20: shifted(0.0, 0.95), 19: half(shifted(0.15, 0.95))}, 'ref_layer': REF_W}),
               SRC, REF, LAT, LON)
ok('levels 0.15 m apart: accepted', r['ok'] and 0.05 < r['agree_m'] <= ts.AGREE_MAX_M, r)
ok('judge: far (over %g m) refused' % ts.SHIFT_MAX_M,
   ts.judge([{'east': 25.0, 'north': 0, 'snr': 40, 'detail': 20}, {'east': 25.0, 'north': 0.1, 'snr': 40, 'detail': 20}])[1] == 'far')
ok('judge: one level only is never enough', ts.judge([{'east': 0, 'north': 0, 'snr': 40, 'detail': 20}])[0] is False)
try:
    ts.measure(world_fetch({'src_layer': shifted(0, 0), 'ref_layer': REF_W}), SRC, REF, LAT, LON, deadline=time.time() - 1)
    ok('a passed deadline stops the tiles', False)
except ts.MeasureError as e:
    ok('a passed deadline stops the tiles ("timeout")', e.reason == 'timeout')
try:
    ts.measure(world_fetch({'src_layer': shifted(0, 0), 'ref_layer': REF_W}, fail=lambda l, z, x, y: l == 'src_layer'),
               SRC, REF, LAT, LON)
    ok('a failing tile is an error, not a guess', False)
except ts.MeasureError as e:
    ok('a failing tile is an error, not a guess ("tiles")', e.reason == 'tiles', e.detail)

# ---- 3. frames ---------------------------------------------------------------------
print('\nframes')
dx, dy = ts.to_map_frame(0.0, 1.0, 0.0)
ok('north-up map: north = +map y', abs(dx) < 1e-9 and abs(dy - 1) < 1e-9)
yaw = 0.4
dx, dy = ts.to_map_frame(-0.73, -0.71, yaw)
e, n_ = math.cos(yaw) * dx - math.sin(yaw) * dy, math.sin(yaw) * dx + math.cos(yaw) * dy
ok('a turned map: R(-yaw), the same turn as tileAlignShift in mapping.js', abs(e + 0.73) < 1e-9 and abs(n_ + 0.71) < 1e-9)
src_js = open(os.path.join(HERE, '..', 'nodes', 'templates', 'assets', 'js', 'mapping.js')).read()
ok('  (mapping.js: dx = c*e + s*n, dy = -s*e + c*n)', 'return { dx: c * e + s * n, dy: -s * e + c * n };' in src_js)
D = {'origin_lat': 50.0, 'origin_lon': 15.0, 'yaw_rad': 0.0, 'utm_zone': 33}
ok('true yaw: on the central meridian = the datum yaw; east of it the grid is turned',
   abs(ts.true_yaw(D)) < 1e-12 and ts.true_yaw(dict(D, origin_lon=16.0)) < -0.01)
la, lo = ts.map_point_latlon(D, 100.0, 200.0)
ok('a map point as lat/lon: 200 m north, 100 m east', abs((la - 50.0) * 111320 - 200) < 0.5 and
   abs((lo - 15.0) * 111320 * math.cos(math.radians(50)) - 100) < 0.5, (la, lo))

# ---- 4. the store's meta -------------------------------------------------------------
print('\nhow an offset came to be (meta)')
OFF = {'A': {'sat': {'dx': 1.2, 'dy': -0.2}, 'bing': {'dx': -0.4, 'dy': 0.47}}}
ok('a store without meta (before M13) reads as before: no meta', ts.clean_meta(None, OFF) == {})
m = ts.clean_meta({'A': {'sat': {'src': 'measured', 'ts': 1794700000, 'adj': True, 'junk': 1},
                         'bing': {'src': 'manual', 'ts': 1794700001},
                         'gone': {'src': 'manual', 'ts': 5}, 'zero': {'src': 'measured', 'ts': 7},
                         'bad': {'src': 'guess'}, 'x': 3}, 'B': 'nope', 7: {}}, OFF)
ok('clean_meta keeps known shapes only', m == {'A': {'sat': {'src': 'measured', 'ts': 1794700000, 'adj': True},
                                                    'bing': {'src': 'manual', 'ts': 1794700001},
                                                    'zero': {'src': 'measured', 'ts': 7}}}, m)
ok('  a measured zero offset keeps its record, a manual record without an offset goes', 'zero' in m['A'] and 'gone' not in m['A'])
ok('stamp: the measure button', ts.stamp(None, 'measured', 100.9) == {'src': 'measured', 'ts': 100})
ok('stamp: a nudge of a measured offset stays measured, marked adjusted, date kept',
   ts.stamp({'src': 'measured', 'ts': 100}, None, 200) == {'src': 'measured', 'ts': 100, 'adj': True})
ok('stamp: a nudge of anything else is manual, dated now',
   ts.stamp(None, None, 200) == {'src': 'manual', 'ts': 200} and ts.stamp({'src': 'manual', 'ts': 1}, None, 200)['ts'] == 200)
ok('stamp: an explicit "manual" demotes a measured offset', ts.stamp({'src': 'measured', 'ts': 100}, 'manual', 200)['src'] == 'manual')
web = open(os.path.join(HERE, '..', 'nodes', 'webnode')).read()
ok('webnode: the store keeps "offsets" as it was and adds "meta" through these functions',
   'tile_shift.clean_meta(doc.get(\'meta\'), clean)' in web and 'tile_shift.stamp(mlayers.get(layer), source, time.time())' in web
   and "doc = {'version': 1, 'ts': int(time.time()), 'offsets': offsets}" in web and "'meta': meta," in web)
ok('webnode: the route is the one tested here, with the store, the bound and no write',
   'tile_shift.register(app, {' in web and "'offsets': _tile_offsets_load_all," in web and "'max_m': TILE_OFFSET_MAX_M," in web)
reg = open(os.path.join(HERE, '..', 'nodes', 'tile_shift.py')).read()
reg = reg[reg.index('def register('):]
ok('the route never writes (no open for writing, no save, no os.replace)',
   "open(" not in reg and 'save' not in reg.replace('saves it', '') and 'replace(' not in reg)

# ---- 5. the route --------------------------------------------------------------------
print('\nPOST /api/tile_offsets/measure')
try:
    from flask import Flask
except ImportError:
    Flask = None
    print('skip (Flask not installed)')
if Flask:
    def make(worlds, datum=D, offsets=None, timeout=None, delay=0.0, fail=None, gate=None, sources=None):
        app = Flask('t')
        calls = []
        base = world_fetch(worlds, calls, delay, fail)

        def fetch(*a):
            if gate is not None:
                gate.wait(10)
            return base(*a)
        ts.register(app, {
            'active_map': lambda: 'A',
            'datum': lambda: datum,
            'center': lambda d: (LAT, LON),
            'catalog': lambda: sources if sources is not None else [SRC, REF, MAPSRC, OSM],
            'offsets': lambda: (offsets or {}, {}),
            'fetch': fetch,
            'max_m': 50.0,
            'timeout_s': timeout,
        })
        return app.test_client(), calls

    GOOD = {'src_layer': shifted(0.0, 0.95), 'ref_layer': REF_W}
    c, calls = make(GOOD, offsets={'A': {'cuzk': {'dx': 0.7, 'dy': 0.0}, 'sat': {'dx': 1.43, 'dy': -0.24}}})
    for label, body in (('no body', None), ('a list', [1]), ('no map', {'layer': 'sat'}), ('no layer', {'map': 'A'}),
                        ('a number as layer', {'map': 'A', 'layer': 5}), ('an oversized map', {'map': 'x' * 201, 'layer': 'sat'})):
        r = c.post('/api/tile_offsets/measure', json=body) if body is not None else c.post('/api/tile_offsets/measure')
        ok('400 on %s' % label, r.status_code == 400 and r.get_json()['reason'] == 'bad_request', r.status_code)
    for label, body, code, reason in (('another map than the one shown', {'map': 'B', 'layer': 'sat'}, 409, 'not_active'),
                                      ('the reference itself', {'map': 'A', 'layer': 'cuzk'}, 422, 'reference'),
                                      ('a drawn map', {'map': 'A', 'layer': 'osm'}, 422, 'not_photo'),
                                      ('an unknown key', {'map': 'A', 'layer': 'nope'}, 422, 'unknown_layer')):
        r = c.post('/api/tile_offsets/measure', json=body)
        ok('%d "%s" on %s' % (code, reason, label), r.status_code == code and r.get_json()['reason'] == reason and
           r.get_json()['ok'] is False, r.get_json())
    ok('none of these fetched a tile', calls == [])
    r = c.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    j = r.get_json()
    ok('a good measurement: 200, reliable, 0.95 m north', r.status_code == 200 and j['ok'] and j['reliable'] and j['reason'] == '' and
       abs(j['measured']['north'] - 0.95) <= 0.1 and abs(j['measured']['east']) <= 0.1, j)
    ok('  proposal = the map\'s ČÚZK offset minus the shift: 0.70 / -0.95 (as stored for the garden by hand)',
       j['proposed'] and abs(j['proposed']['dx'] - 0.70) <= 0.1 and abs(j['proposed']['dy'] + 0.95) <= 0.1, j['proposed'])
    ok('  it says what is stored now, the reference offset, the levels, the quality and the gate\'s limits',
       j['stored'] == {'dx': 1.43, 'dy': -0.24, 'src': 'manual'} and j['reference_offset'] == {'dx': 0.7, 'dy': 0.0} and
       [l['z'] for l in j['levels']] == [20, 19] and j['quality']['snr'] > ts.SNR_MIN and
       j['quality']['agree_max_m'] == ts.AGREE_MAX_M and j['source'] == 'sat' and j['reference'] == 'cuzk' and j['tiles'] == 122, j)
    ok('  and the spread: %d clear readings inside the area, the farthest %.2f m from the result'
       % (j['quality']['windows'], j['quality']['spread_m']), j['quality']['windows'] == 17 and 0 <= j['quality']['spread_m'] < 0.1, j['quality'])
    c2, _ = make({'src_layer': white, 'ref_layer': REF_W})
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('502 "blank" when MapProxy fills the tiles with a plain colour', r.status_code == 502 and r.get_json()['reason'] == 'blank', r.get_json())
    c2, _ = make(GOOD, datum=dict(D, yaw_rad=math.pi / 2))
    j2 = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'}).get_json()
    ok('  a map turned by 90°: north of ČÚZK = +map x, the proposal is -0.95 / 0', j2['proposed'] and
       abs(j2['proposed']['dx'] + 0.95) <= 0.1 and abs(j2['proposed']['dy']) <= 0.1, j2['proposed'])
    c2, _ = make(GOOD, sources=[SRC, REF, dict(MAPSRC, id='sat_hybrid', group='photo')])
    j2 = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'}).get_json()
    ok('  the key "sat" measures the Google photo itself', j2['source'] == 'sat')
    c2, _ = make(GOOD, offsets={'A': {'cuzk': {'dx': 49.9, 'dy': 0.0}}})
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    j2 = r.get_json()
    c3, _ = make({'src_layer': shifted(-0.5, 0.0), 'ref_layer': REF_W}, offsets={'A': {'cuzk': {'dx': 49.9, 'dy': 0.0}}})
    j3 = c3.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'}).get_json()
    ok('a proposal over +/-50 m is refused ("range"), one inside is offered',
       j2['proposed'] is not None and j3['ok'] and j3['reliable'] is False and j3['reason'] == 'range' and j3['proposed'] is None, (j2, j3))
    c2, _ = make({'src_layer': camera(scene(77), 6), 'ref_layer': REF_W})
    j2 = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'}).get_json()
    ok('an unreliable measurement: 200, not reliable, the reason, nothing proposed',
       j2['ok'] and j2['reliable'] is False and j2['reason'] == 'weak' and j2['proposed'] is None, j2)
    c2, _ = make(GOOD, datum=None)
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('503 "no_datum" without a datum', r.status_code == 503 and r.get_json()['reason'] == 'no_datum')
    c2, _ = make(GOOD, sources=[SRC])
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('503 "no_catalog" without the ČÚZK orthophoto', r.status_code == 503 and r.get_json()['reason'] == 'no_catalog')
    c2, _ = make(GOOD, fail=lambda l, z, x, y: l == 'ref_layer')
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('502 "tiles" when MapProxy fails', r.status_code == 502 and r.get_json()['reason'] == 'tiles', r.get_json())
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('  and the next one runs again (the lock is free)', r.get_json()['reason'] == 'tiles')

    # two at once: the second is refused, the first finishes
    gate = threading.Event()
    c2, calls = make(GOOD, gate=gate)
    out = {}
    th = threading.Thread(target=lambda: out.update(r=c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})))
    th.start()
    t0 = time.time()
    while not calls and time.time() - t0 < 20:
        time.sleep(0.02)
    t1 = time.time()
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('a second measurement while one runs: 409 "busy" at once', bool(calls) and r.status_code == 409 and
       r.get_json()['reason'] == 'busy' and time.time() - t1 < 2, (r.get_json(), time.time() - t1))
    gate.set()
    th.join(30)
    ok('  the first one finishes with its result', 'r' in out and out['r'].status_code == 200 and out['r'].get_json()['reliable'])
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('  and a third one after it runs', r.status_code == 200)

    # the time limit
    c2, calls = make(GOOD, timeout=1.0, delay=0.15)
    t0 = time.time()
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    took = time.time() - t0
    ok('a slow MapProxy: 504 "timeout" at the limit (%.1f s for a 1 s limit)' % took,
       r.status_code == 504 and r.get_json()['reason'] == 'timeout' and took < 3.0, (r.status_code, took))
    n_at = len(calls)
    time.sleep(0.6)
    ok('  the worker stopped asking for tiles (%d of 122 asked)' % len(calls), len(calls) == n_at and n_at < 122)
    r = c2.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
    ok('  and the lock is free again (not "busy")', r.get_json()['reason'] != 'busy', r.get_json())

# ---- 6. the store routes of webnode (sliced verbatim, a temporary HOME) -------------------
print('\nthe store: /api/tile_offsets with meta (webnode source, temporary HOME)')
if Flask:
    import json
    import shutil
    import tempfile
    import textwrap
    from flask import jsonify, request
    home = tempfile.mkdtemp(prefix='tile_offsets_test_')
    old_home = os.environ.get('HOME')
    os.environ['HOME'] = home
    try:
        a0 = web.index("        TILE_OFFSETS_DIR = os.path.expanduser('~/.vitulus/ui')")
        a1 = web.index('        # POST /api/tile_offsets/measure {map, layer} (T17 M13)')
        code = textwrap.dedent(web[a0:a1])

        class Ros(object):
            @staticmethod
            def logwarn(*a):
                pass
        app = Flask('store')
        env = {'os': os, 'json': json, 'time': time, 'threading': threading, 'rospy': Ros, 'app': app,
               'jsonify': jsonify, 'request': request, 'tile_shift': ts, 'SITE_DATUM_PATH': os.path.join(home, 'none.yaml')}
        exec(compile(code, 'webnode[tile_offsets]', 'exec'), env)
        path = os.path.join(home, '.vitulus', 'ui', 'tile_offsets.json')
        ok('the slice writes under the temporary HOME only', env['TILE_OFFSETS_PATH'] == path, env['TILE_OFFSETS_PATH'])
        os.makedirs(os.path.dirname(path))
        # the file as it is on the robot today (version 1, no meta)
        LEG = {'offsets': {'10_2026': {'bing': {'dx': -0.4, 'dy': 0.47}, 'cuzk': {'dx': 0.7, 'dy': 0.0}, 'sat': {'dx': 1.43, 'dy': -0.24}},
                           'Nmap': {'cuzk': {'dx': 0.9, 'dy': 1.2}, 'sat': {'dx': 1.2, 'dy': -0.2}}}, 'ts': 1794688777, 'version': 1}
        with open(path, 'w') as fh:
            json.dump(LEG, fh)
        c = app.test_client()
        j = c.get('/api/tile_offsets').get_json()
        ok('a file from before M13 reads as before: the same offsets, no meta', j['ok'] and j['offsets'] == LEG['offsets'] and j['meta'] == {}, j)
        P = lambda body, url='/api/tile_offsets': c.post(url, json=body)
        r = P({'map': '10_2026', 'layer': 'sat', 'dx': 0.70, 'dy': -0.95, 'source': 'measured'})
        j = r.get_json()
        ok('the director\'s re-save of 10_2026/sat as measured: 200, offsets {dx, dy} only, meta measured + date',
           r.status_code == 200 and j['offsets']['10_2026']['sat'] == {'dx': 0.7, 'dy': -0.95} and
           j['meta'] == {'10_2026': {'sat': {'src': 'measured', 'ts': j['meta']['10_2026']['sat']['ts']}}} and
           abs(j['meta']['10_2026']['sat']['ts'] - time.time()) < 5, j)
        ok('  nothing else moved (Nmap, bing, cuzk as stored)', j['offsets']['Nmap'] == LEG['offsets']['Nmap'] and
           j['offsets']['10_2026']['bing'] == {'dx': -0.4, 'dy': 0.47} and j['offsets']['10_2026']['cuzk'] == {'dx': 0.7, 'dy': 0.0})
        doc = json.load(open(path))
        ok('  the file: version 1, offsets in the old shape, meta beside', doc['version'] == 1 and
           doc['offsets']['10_2026']['sat'] == {'dx': 0.7, 'dy': -0.95} and doc['meta']['10_2026']['sat']['src'] == 'measured', doc)
        ts0 = j['meta']['10_2026']['sat']['ts']
        j = P({'map': '10_2026', 'layer': 'sat', 'dx': 0.75, 'dy': -0.95}).get_json()
        ok('a nudge (no source) of a measured offset: still measured, adjusted, date kept',
           j['meta']['10_2026']['sat'] == {'src': 'measured', 'ts': ts0, 'adj': True} and j['offsets']['10_2026']['sat']['dx'] == 0.75, j['meta'])
        j = P({'map': 'Nmap', 'layer': 'sat', 'dx': 1.3, 'dy': -0.2}).get_json()
        ok('a nudge of a hand-set offset: manual + date', j['meta']['Nmap']['sat']['src'] == 'manual' and 'adj' not in j['meta']['Nmap']['sat'] and
           j['offsets']['Nmap']['sat'] == {'dx': 1.3, 'dy': -0.2}, j['meta'])
        j = P({'map': 'Nmap', 'layer': 'sat', 'dx': 0, 'dy': 0}).get_json()
        ok('a manual zero removes the offset and its record', 'sat' not in j['offsets']['Nmap'] and 'Nmap' not in j['meta'], j)
        j = P({'map': 'Z', 'layer': 'bing', 'dx': 0, 'dy': 0, 'source': 'measured'}).get_json()
        ok('a measured zero keeps its record (no offset entry)', 'Z' not in j['offsets'] and j['meta']['Z']['bing']['src'] == 'measured', j)
        j = c.get('/api/tile_offsets').get_json()
        ok('  and it survives a re-read of the file', j['meta'].get('Z', {}).get('bing', {}).get('src') == 'measured')
        r = P({'map': 'Z', 'layer': 'bing', 'dx': 1, 'dy': 0, 'source': 'guess'})
        ok('an unknown source: 400, nothing written', r.status_code == 400 and 'Z' not in c.get('/api/tile_offsets').get_json()['offsets'])
        r = P({'map': 'Z', 'layer': 'bing', 'dx': 51, 'dy': 0, 'source': 'measured'})
        ok('a measured offset over +/-50 m: 400', r.status_code == 400)
        j = P({'map': '10_2026', 'layer': 'sat'}, '/api/tile_offsets/reset').get_json()
        ok('reset of a layer drops the offset and the record', 'sat' not in j['offsets']['10_2026'] and '10_2026' not in j['meta'], j)
        j = P({'map': 'Z'}, '/api/tile_offsets/reset').get_json()
        ok('reset of a map drops its records', 'Z' not in j['meta'] and 'Z' not in j['offsets'])
        with open(path, 'w') as fh:
            json.dump({'version': 1, 'offsets': LEG['offsets'], 'meta': {'10_2026': {'sat': 'x', 'ghost': {'src': 'manual'}}, 'Q': 7}}, fh)
        j = c.get('/api/tile_offsets').get_json()
        ok('a garbled meta never breaks the offsets', j['ok'] and j['offsets'] == LEG['offsets'] and j['meta'] == {}, j['meta'])
    finally:
        if old_home is None:
            os.environ.pop('HOME', None)
        else:
            os.environ['HOME'] = old_home
        shutil.rmtree(home, ignore_errors=True)

# ---- 7. a robot without numpy / scipy / PIL ----------------------------------------------
print('\nwithout numpy, scipy and PIL (another interpreter with the three blocked)')
if Flask:
    import subprocess
    CHILD = r'''
import importlib.abc, json, os, sys, tempfile, textwrap, threading, time
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split('.')[0] in ('numpy', 'scipy', 'PIL'):
            raise ImportError('blocked for the test: ' + name)
sys.meta_path.insert(0, Block())
os.environ['HOME'] = tempfile.mkdtemp(prefix='tile_nolibs_')
nodes = sys.argv[1]
sys.path.insert(0, nodes)
import tile_shift
out = {'import': True, 'loaded': [m for m in ('numpy', 'scipy', 'PIL') if m in sys.modules]}
web = open(os.path.join(nodes, 'webnode')).read()
out['top_import'] = '\nimport tile_shift\n' in web
a0 = web.index("        TILE_OFFSETS_DIR = os.path.expanduser('~/.vitulus/ui')")
a1 = web.index('        # POST /api/tile_offsets/measure {map, layer} (T17 M13)')
from flask import Flask, jsonify, request
class Ros(object):
    @staticmethod
    def logwarn(*a): pass
app = Flask('nolibs')
env = {'os': os, 'json': json, 'time': time, 'threading': threading, 'rospy': Ros, 'app': app, 'jsonify': jsonify,
       'request': request, 'tile_shift': tile_shift, 'SITE_DATUM_PATH': '/nonexistent'}
exec(compile(textwrap.dedent(web[a0:a1]), 'webnode[tile_offsets]', 'exec'), env)
calls = []
tile_shift.register(app, {'active_map': lambda: 'A', 'datum': lambda: {'origin_lat': 50.0, 'origin_lon': 15.0},
    'center': lambda d: None,
    'catalog': lambda: [{'id': 'sat', 'kind': 'base', 'group': 'photo', 'layer': 's'}, {'id': 'cuzk', 'kind': 'base', 'group': 'photo', 'layer': 'r'}],
    'offsets': env['_tile_offsets_load_all'], 'fetch': lambda *a: calls.append(a) or b'', 'max_m': 50.0})
c = app.test_client()
r = c.post('/api/tile_offsets', json={'map': 'A', 'layer': 'sat', 'dx': 0.7, 'dy': -0.95, 'source': 'measured'})
out['store'] = [r.status_code, r.get_json().get('meta', {}).get('A', {}).get('sat', {}).get('src'), c.get('/api/tile_offsets').get_json()['offsets']]
r = c.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
out['measure'] = [r.status_code, r.get_json().get('reason'), r.get_json().get('error')]
r = c.post('/api/tile_offsets/measure', json={'map': 'A', 'layer': 'sat'})
out['again'] = r.get_json().get('reason')
out['fetched'] = len(calls)
out['center'] = tile_shift.raster_center('/nonexistent.yaml')
print(json.dumps(out))
'''
    pr = subprocess.run([sys.executable, '-c', CHILD, os.path.join(HERE, '..', 'nodes')], stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, universal_newlines=True, timeout=120)
    try:
        o = json.loads(pr.stdout.strip().splitlines()[-1])
    except Exception:
        o = {}
    ok('tile_shift imports, webnode imports it at the top, none of the three is loaded',
       o.get('import') is True and o.get('top_import') is True and o.get('loaded') == [], pr.stderr[-600:] or o)
    ok('the store routes work without them (offsets, meta "measured")',
       o.get('store') == [200, 'measured', {'A': {'sat': {'dx': 0.7, 'dy': -0.95}}}], o.get('store'))
    ok('the measurement answers 503 "no_libs" naming the packages, asks for no tile, stays free for the next call',
       (o.get('measure') or [0])[0] == 503 and o['measure'][1] == 'no_libs' and 'python3-scipy' in (o['measure'][2] or '') and
       o.get('again') == 'no_libs' and o.get('fetched') == 0 and o.get('center') is None, o)
    pkg = open(os.path.join(HERE, '..', 'package.xml')).read()
    ok('package.xml names them (rosdep keys python3-numpy, python3-scipy, python3-pil)',
       all('<exec_depend>%s</exec_depend>' % k in pkg for k in ('python3-numpy', 'python3-scipy', 'python3-pil')))
lib_src = open(os.path.join(HERE, '..', 'nodes', 'tile_shift.py')).read()
ok('tile_shift.py has no top-level import of numpy, scipy or PIL',
   not any(l.startswith(('import numpy', 'from PIL', 'from scipy', 'import scipy', 'import PIL')) for l in lib_src.splitlines()))

print('')
if FAILS:
    print('FAILED (%d):' % len(FAILS))
    for f in FAILS:
        print('  - ' + f)
    sys.exit(1)
print('all checks passed')
