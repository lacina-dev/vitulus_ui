"""How far a background map sits from the ČÚZK orthophoto, measured on tiles.

Used by webnode (POST /api/tile_offsets/measure, T17 M13). The pictures of
Google, Bing … are placed a little off the ČÚZK orthophoto and the shift
differs by place (the owner's garden: Google 0.95 m north, Bing 1.1 m east and
0.5 m south; Prague: other values). This module takes the same tiles of both
sources around one point from the robot's own MapProxy (read only, a few dozen
tiles, mostly cached), turns them into edge pictures and finds the shift by
phase correlation at two zoom levels (the plan and the gate are below).

No ROS, no Flask: `fetch(layer, grid, fmt, z, x, y) -> bytes` is passed in, so
tools/test_tile_shift.py runs it on made-up tiles.

SIGNS: `east`/`north` (metres, true east / true north) say where the SOURCE's
picture lies relative to the reference: north +0.95 = "Google lies 0.95 m north
of ČÚZK". The offset that puts the source onto the reference is the opposite.
"""
import io
import math
import time
from concurrent.futures import ThreadPoolExecutor

# numpy, PIL and scipy are loaded on the first measurement (_libs), never at
# import: webnode imports this module at start for the store's meta and the
# route, and the whole UI must start on a robot without python3-scipy. There
# the route answers 503 "no_libs".
np = Image = ndimage = None

TILE_PX = 256
EARTH_GSD0 = 156543.03392804097          # m per px at zoom 0 on the equator

# The plan (set from real tiles, tmp/ui-t17b/*.txt): the shift is read at the
# finer level on LOCAL_N x LOCAL_N tiles (z20: about 150 m around the middle of
# the map) and checked one level coarser on WIDE_N x WIDE_N tiles (z19: about
# 240 m). Gardens are mostly lawn and trees, which look different in every
# picture: only a part of the local area holds roofs, roads and walls (a 100 m
# area in the middle of the owner's map read 0.6 m wrong, 30 m west of it
# right). So the local level is read on the whole area AND on 16 half-size
# windows inside it, and the clearest of them counts. It must agree with the
# wide level. About 120 tiles per source pair, mostly from MapProxy's cache.
ZOOM_MAX = 20
LOCAL_N = 6
WIDE_N = 5
SUB_FRAC = 0.5          # size of a local window (of the local area)
SUB_STEPS = 4           # windows per axis
FETCH_THREADS = 4       # tiles asked at once (MapProxy answers from its cache)

# the gate
SNR_MIN = 18.0          # peak of the correlation over its noise (real pairs
                        # 20-45, a drawn map or lawn only 6-13)
AGREE_MAX_M = 0.30      # the two levels must agree this well
FLAT_MIN = 4.0          # mean edge strength below this = nothing to compare
                        # (photos 12-30, a drawn map 2, a blank tile 0)
SHIFT_MAX_M = 20.0      # a larger shift is not something this window can see
BLANK_RANGE = 2         # a tile whose grey levels span no more = one plain colour


class MeasureError(Exception):
    """A measurement that could not run. `reason` is a short stable code."""

    def __init__(self, reason, detail=''):
        Exception.__init__(self, detail or reason)
        self.reason = reason
        self.detail = detail or reason


def _libs():
    """Load the picture libraries once; MeasureError('no_libs') without them."""
    global np, Image, ndimage
    if ndimage is not None:
        return
    try:
        import numpy
        from PIL import Image as pil_image
        from scipy import ndimage as sp_ndimage
    except Exception as exc:
        raise MeasureError('no_libs', 'python3-numpy, python3-scipy and python3-pil are needed: %s' % exc)
    np, Image, ndimage = numpy, pil_image, sp_ndimage


def gsd(lat, z):
    """Metres per tile pixel at this latitude and zoom (web mercator)."""
    return EARTH_GSD0 * math.cos(math.radians(lat)) / (2 ** z)


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def edges(grey):
    """Edge strength of a grey picture: the two sources differ in colour,
    season and light, their edges (roofs, roads, walls) do not."""
    _libs()
    a = ndimage.gaussian_filter(np.asarray(grey, float), 1.5)
    return np.hypot(ndimage.sobel(a, 0), ndimage.sobel(a, 1))


def phase_corr(a, b):
    """Shift of picture `a` against `b` in pixels: (dx right, dy down, snr).
    snr = the peak of the correlation over its standard deviation."""
    _libs()
    h, w = a.shape
    win = np.outer(np.hanning(h), np.hanning(w))
    fa = np.fft.fft2((a - a.mean()) * win)
    fb = np.fft.fft2((b - b.mean()) * win)
    r = fa * np.conj(fb)
    r /= np.abs(r) + 1e-9
    # low-pass the cross-power spectrum: the fine grain of two different
    # cameras never matches, the shapes do
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    r *= np.exp(-(fx ** 2 + fy ** 2) / (2 * 0.08 ** 2))
    c = np.fft.fftshift(np.real(np.fft.ifft2(r)))
    iy, ix = np.unravel_index(np.argmax(c), c.shape)

    def sub(v, i, n):
        if 0 < i < n - 1:
            den = v[0] - 2 * v[1] + v[2]
            if den != 0:
                return float((v[0] - v[2]) / (2 * den))
        return 0.0

    dy = iy - h // 2 + sub(c[iy - 1:iy + 2, ix], iy, h)
    dx = ix - w // 2 + sub(c[iy, ix - 1:ix + 2], ix, w)
    sd = float(np.std(c))
    snr = float(c[iy, ix]) / sd if sd > 1e-12 else 0.0
    if not (math.isfinite(dx) and math.isfinite(dy) and math.isfinite(snr)):
        return 0.0, 0.0, 0.0
    return float(dx), float(dy), snr


def _one(ea, eb, metres_per_px):
    dx, dy, snr = phase_corr(ea, eb)
    return {'east': dx * metres_per_px, 'north': -dy * metres_per_px, 'snr': snr,
            'detail': float(min(ea.mean(), eb.mean()))}


def measure_images(src_grey, ref_grey, metres_per_px, windows=False):
    """One level: where the source's picture lies against the reference.
    -> {east, north, snr, detail} (metres; detail = the weaker picture's mean
    edge strength). windows=True also tries the half-size windows inside the
    picture and returns the clearest reading (see the plan above), with
      windows  = how many of the readings (whole area + windows) are clear
                 (snr >= SNR_MIN), and
      spread_m = how far the farthest clear reading lies from the returned
                 one: the shift is not the same all over the area (roofs lean
                 differently in each picture, the photos are stitched), so
                 this is how much the answer depends on the place.
    WHY the clearest reading and not the median of the clear ones: on the
    owner's map (hand-checked: Google 0.00 E / 0.95 N, Bing 1.10 E / 0.47 S)
    the clearest reads 0.00 / 0.97 and 1.04 / -0.53 (2 and 8 cm off), the
    median -0.35 / 1.15 and 1.06 / -0.56 (40 and 10 cm off)."""
    ea, eb = edges(src_grey), edges(ref_grey)
    best = _one(ea, eb, metres_per_px)
    detail_all = best['detail']
    if windows:
        got = [best]
        h, w = ea.shape
        sh, sw = int(h * SUB_FRAC), int(w * SUB_FRAC)
        for iy in range(SUB_STEPS):
            for ix in range(SUB_STEPS):
                y = (h - sh) * iy // (SUB_STEPS - 1)
                x = (w - sw) * ix // (SUB_STEPS - 1)
                m = _one(ea[y:y + sh, x:x + sw], eb[y:y + sh, x:x + sw], metres_per_px)
                got.append(m)
                if m['snr'] > best['snr']:
                    best = m
        clear = [m for m in got if m['snr'] >= SNR_MIN]
        best = dict(best)
        best['windows'] = len(clear)
        best['spread_m'] = max([math.hypot(m['east'] - best['east'], m['north'] - best['north'])
                                for m in clear] or [0.0])
    best['detail_all'] = detail_all
    return best


def mosaic(fetch, src, z, lat, lon, n, deadline=None):
    """n x n tiles of one catalog source around the point, as a grey array.
    Over a quarter of the tiles one plain colour = MapProxy's filling for
    tiles it could not get (robot without internet): MeasureError('blank')."""
    _libs()
    fx, fy = tile_xy(lat, lon, z)
    x0 = int(fx) - n // 2
    y0 = int(fy) - n // 2

    def one(ij):
        i, j = ij
        if deadline is not None and time.time() > deadline:
            raise MeasureError('timeout', 'the tiles took too long')
        try:
            data = fetch(src['layer'], src.get('grid') or 'gm_grid',
                         src.get('format') or 'png', z, x0 + i, y0 + j)
            t = Image.open(io.BytesIO(data)).convert('RGB').convert('L')
        except MeasureError:
            raise
        except Exception as exc:
            raise MeasureError('tiles', '%s z%d: %s' % (src.get('id') or src['layer'], z, exc))
        if t.size != (TILE_PX, TILE_PX):
            t = t.resize((TILE_PX, TILE_PX))
        return i, j, t

    im = Image.new('L', (TILE_PX * n, TILE_PX * n))
    cells = [(i, j) for i in range(n) for j in range(n)]
    blank = 0
    pool = ThreadPoolExecutor(max_workers=FETCH_THREADS)
    try:
        for i, j, t in pool.map(one, cells):
            lo, hi = t.getextrema()
            if hi - lo <= BLANK_RANGE:
                blank += 1
            im.paste(t, (TILE_PX * i, TILE_PX * j))
    finally:
        pool.shutdown(wait=True)
    if blank * 4 > n * n:
        raise MeasureError('blank', '%s z%d: %d of %d tiles are empty' % (src.get('id') or src['layer'], z, blank, n * n))
    return np.asarray(im, float)


def judge(levels):
    """The gate. levels = [local, wide] ({east, north, snr, detail}).
    -> (ok, reason, agree_m). Reasons: flat (nothing to compare), weak (no
    clear peak), disagree (the two levels differ), far."""
    if not levels:
        return False, 'weak', None
    agree = None
    if len(levels) > 1:
        agree = max(math.hypot(l['east'] - levels[0]['east'], l['north'] - levels[0]['north'])
                    for l in levels[1:])
    if min(l.get('detail_all', l['detail']) for l in levels) < FLAT_MIN:
        return False, 'flat', agree
    if min(l['snr'] for l in levels) < SNR_MIN:
        return False, 'weak', agree
    if agree is None or agree > AGREE_MAX_M:
        return False, 'disagree', agree
    if math.hypot(levels[0]['east'], levels[0]['north']) > SHIFT_MAX_M:
        return False, 'far', agree
    return True, '', agree


def plan_for(src, ref):
    """((zoom, tiles per side, windows), …) for this pair: the finer level is
    at most one above the source's own finest (MapProxy magnifies one level
    cleanly; Bing's z19 read at z20) and never above the reference's."""
    def mz(s, d):
        try:
            return int(s.get('max_zoom') or d)
        except (TypeError, ValueError):
            return d
    hi = max(2, min(ZOOM_MAX, mz(src, ZOOM_MAX) + 1, mz(ref, ZOOM_MAX)))
    return ((hi, LOCAL_N, True), (hi - 1, WIDE_N, False))


def measure(fetch, src, ref, lat, lon, plan=None, deadline=None):
    """Source against reference around (lat, lon).
    -> {east, north, snr, agree_m, spread_m, windows, ok, reason,
        levels:[local, wide], tiles}"""
    _libs()
    levels = []
    tiles = 0
    for z, n, windows in (plan or plan_for(src, ref)):
        a = mosaic(fetch, src, z, lat, lon, n, deadline)
        b = mosaic(fetch, ref, z, lat, lon, n, deadline)
        tiles += 2 * n * n
        m = measure_images(a, b, gsd(lat, z), windows)
        m['z'] = z
        m['n'] = n
        levels.append(m)
    ok, reason, agree = judge(levels)
    return {
        'east': levels[0]['east'],
        'north': levels[0]['north'],
        'snr': min(l['snr'] for l in levels),
        'agree_m': agree,
        'spread_m': levels[0].get('spread_m', 0.0),
        'windows': levels[0].get('windows', 0),
        'ok': ok,
        'reason': reason,
        'levels': levels,
        'tiles': tiles,
    }


def to_map_frame(east, north, yaw):
    """True east/north (m) -> the map frame (dx = +map x, dy = +map y); yaw =
    the map's rotation against true north (rad). Same turn as the UI's tile
    groups: R(-yaw) * (east, north)."""
    y = yaw if (isinstance(yaw, (int, float)) and math.isfinite(yaw)) else 0.0
    c, s = math.cos(y), math.sin(y)
    return c * east + s * north, -s * east + c * north


def true_yaw(datum):
    """The map's rotation against TRUE north: the datum's yaw is against UTM
    grid north, the grid is turned by the meridian convergence (the same
    formula as mapping.js _mapTrueYaw)."""
    yaw = float(datum.get('yaw_rad') or 0.0)
    lat, lon = datum.get('origin_lat'), datum.get('origin_lon')
    if lat is None or lon is None:
        return yaw
    zone = int(datum.get('utm_zone') or 33)
    lon0 = zone * 6 - 183
    gamma = math.atan(math.tan(math.radians(float(lon) - lon0)) * math.sin(math.radians(float(lat))))
    return yaw - gamma


def map_point_latlon(datum, x, y):
    """A point of the map frame (m from the datum origin) as lat/lon. A flat
    approximation: good to centimetres over a garden, and the measurement only
    needs "about the middle of the map"."""
    lat0, lon0 = float(datum['origin_lat']), float(datum['origin_lon'])
    t = true_yaw(datum)
    c, s = math.cos(t), math.sin(t)
    east, north = c * x - s * y, s * x + c * y
    lat = lat0 + north / 111320.0
    lon = lon0 + east / (111320.0 * math.cos(math.radians(lat0)))
    return lat, lon


def raster_center(yaml_path):
    """Middle of a served map raster (ROS map yaml + its pgm) in the map frame
    (m) or None."""
    try:
        origin = res = image = None
        with open(yaml_path, 'r') as fh:
            import yaml
            d = yaml.safe_load(fh) or {}
        origin, res, image = d.get('origin'), float(d.get('resolution')), d.get('image')
        import os
        _libs()
        path = image if os.path.isabs(image) else os.path.join(os.path.dirname(yaml_path), image)
        with Image.open(path) as im:
            w, h = im.size
        x, y = float(origin[0]) + w * res / 2.0, float(origin[1]) + h * res / 2.0
        if not (math.isfinite(x) and math.isfinite(y)):
            return None
        return x, y
    except Exception:
        return None


# ---------------------------------------------------------------------------
# How a stored offset came to be (tile_offsets.json "meta", T17 M13)
# ---------------------------------------------------------------------------
# {"<map>": {"<layer>": {"src": "measured" | "manual", "ts": <unix s>,
#                        "adj": true}}}
# beside "offsets" (which keeps its {dx, dy} shape: old pages and tools read it
# as before). A layer without meta = set by hand before M13. "measured" = the
# offset is ABSOLUTE (measured against ČÚZK): the browser option "Align Google
# to ČÚZK" is not added to it. "adj" = nudged by hand after the measurement
# (still absolute). A measured offset may be exactly zero: then the layer has
# meta and no entry in "offsets".
META_SOURCES = ('manual', 'measured')


def clean_meta(raw, offsets):
    """Sanitise the stored meta: only known shapes, and a "manual" record only
    for a layer that has an offset."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for map_name, layers in raw.items():
        if not isinstance(map_name, str) or not isinstance(layers, dict):
            continue
        cl = {}
        for layer, m in layers.items():
            if not isinstance(layer, str) or not isinstance(m, dict):
                continue
            src = m.get('src')
            if src not in META_SOURCES:
                continue
            has = isinstance(offsets, dict) and layer in (offsets.get(map_name) or {})
            if src != 'measured' and not has:
                continue
            e = {'src': src}
            ts = m.get('ts')
            if isinstance(ts, (int, float)) and not isinstance(ts, bool) and 0 < ts < 1e11:
                e['ts'] = int(ts)
            if src == 'measured' and m.get('adj') is True:
                e['adj'] = True
            cl[layer] = e
        if cl:
            out[map_name] = cl
    return out


def stamp(prev, source, now):
    """Meta of an offset being written. source: 'measured' (the measure
    button), 'manual', or None = a nudge: a measured offset stays measured
    (absolute) and is marked adjusted, anything else is manual."""
    if source == 'measured':
        return {'src': 'measured', 'ts': int(now)}
    if source is None and isinstance(prev, dict) and prev.get('src') == 'measured':
        e = {'src': 'measured', 'adj': True}
        if 'ts' in prev:
            e['ts'] = prev['ts']
        return e
    return {'src': 'manual', 'ts': int(now)}


# ---------------------------------------------------------------------------
# POST /api/tile_offsets/measure
# ---------------------------------------------------------------------------
REF_ID = 'cuzk'
MEASURE_TIMEOUT_S = 20.0


def pick_source(sources, key):
    """The catalog source to measure for an offset key: the base with that id,
    else the first photo base sharing the key."""
    bases = [s for s in sources if isinstance(s, dict) and s.get('kind') == 'base' and s.get('layer')]
    for s in bases:
        if s.get('id') == key:
            return s
    for s in bases:
        if s.get('offset_key') == key and s.get('group') == 'photo':
            return s
    return None


def register(app, deps):
    """Add the route to a Flask app. deps (all callables but the numbers):
         active_map() -> str            name of the served map
         datum() -> dict | None         origin_lat, origin_lon, yaw_rad, utm_zone
         center(datum) -> (lat, lon) | None   middle of the served map
         catalog() -> [source, …]       ui_sources.json "sources"
         offsets() -> (offsets, meta)   the store
         fetch(layer, grid, fmt, z, x, y) -> bytes
         max_m                          bound of a stored offset per axis
         timeout_s                      (optional) whole measurement
         log(msg)                       (optional)
    The result is never stored here: the page saves it through POST
    /api/tile_offsets {source: "measured"} after the user confirms."""
    import threading
    from flask import jsonify, request

    busy = threading.Lock()
    timeout_s = float(deps.get('timeout_s') or MEASURE_TIMEOUT_S)
    max_m = float(deps.get('max_m') or 50.0)
    log = deps.get('log') or (lambda msg: None)

    def fail(status, reason, detail=''):
        return jsonify({'ok': False, 'reason': reason, 'error': detail or reason}), status

    @app.route('/api/tile_offsets/measure', methods=['POST'])
    def api_tile_offsets_measure():
        p = request.get_json(silent=True)
        if not isinstance(p, dict):
            return fail(400, 'bad_request', 'body must be a JSON object')
        map_name, key = p.get('map'), p.get('layer')
        if not isinstance(map_name, str) or not map_name.strip() or len(map_name) > 200:
            return fail(400, 'bad_request', 'missing or oversized "map"')
        if not isinstance(key, str) or not key.strip() or len(key) > 100:
            return fail(400, 'bad_request', 'missing or oversized "layer"')
        map_name, key = map_name.strip(), key.strip()
        try:
            if map_name != deps['active_map']():
                return fail(409, 'not_active', 'only the map being shown can be measured')
            sources = deps['catalog']() or []
            ref = pick_source(sources, REF_ID)
            if not ref:
                return fail(503, 'no_catalog', 'the map catalog has no ČÚZK orthophoto')
            ref_key = ref.get('offset_key') or ref.get('id')
            if key == ref_key:
                return fail(422, 'reference', 'this layer is the reference itself')
            src = pick_source(sources, key)
            if not src:
                return fail(422, 'unknown_layer', 'no background map with this alignment key')
            if src.get('group') != 'photo':
                return fail(422, 'not_photo', 'only photo maps can be compared with the orthophoto')
            datum = deps['datum']()
            if not datum or datum.get('origin_lat') is None or datum.get('origin_lon') is None:
                return fail(503, 'no_datum', 'the map has no place on the ground yet')
            _libs()         # before anything is fetched: 503 "no_libs" on a robot without them
            c = deps['center'](datum) if deps.get('center') else None
            lat, lon = c if c else (float(datum['origin_lat']), float(datum['origin_lon']))
        except MeasureError as exc:
            log('tile_offsets measure: %s' % exc.detail)
            return fail(503, exc.reason, exc.detail)
        except Exception as exc:
            log('tile_offsets measure: %s' % exc)
            return fail(500, 'error', str(exc))
        if not busy.acquire(False):
            return fail(409, 'busy', 'another measurement is running')
        t0 = time.time()
        box = {}

        def work():
            try:
                box['res'] = measure(deps['fetch'], src, ref, lat, lon, deadline=t0 + timeout_s)
            except MeasureError as exc:
                box['err'] = exc
            except Exception as exc:        # never leave the lock taken
                box['err'] = MeasureError('error', str(exc))
            finally:
                busy.release()

        th = threading.Thread(target=work, name='tile_measure')
        th.daemon = True
        th.start()
        th.join(timeout_s + 1.0)
        if th.is_alive():
            # the worker stops by itself at its deadline (checked before
            # every tile) and frees the lock then
            return fail(504, 'timeout', 'the measurement took over %d s' % timeout_s)
        if 'err' in box:
            e = box['err']
            log('tile_offsets measure %s/%s: %s (%s)' % (map_name, key, e.reason, e.detail))
            return fail({'timeout': 504, 'tiles': 502, 'blank': 502, 'no_libs': 503}.get(e.reason, 500), e.reason, e.detail)
        r = box['res']
        try:
            offsets, meta = deps['offsets']()
        except Exception:
            offsets, meta = {}, {}
        layers = offsets.get(map_name) or {}

        def off(k):
            o = layers.get(k) or {}
            return {'dx': float(o.get('dx', 0.0)), 'dy': float(o.get('dy', 0.0))}

        mdx, mdy = to_map_frame(r['east'], r['north'], true_yaw(datum))
        ro = off(ref_key)
        prop = {'dx': round(ro['dx'] - mdx, 2), 'dy': round(ro['dy'] - mdy, 2)}
        reliable, reason = r['ok'], r['reason']
        if reliable and (abs(prop['dx']) > max_m or abs(prop['dy']) > max_m):
            reliable, reason = False, 'range'
        cur = off(key)
        cur['src'] = ((meta.get(map_name) or {}).get(key) or {}).get('src') or \
            ('manual' if key in layers else None)
        return jsonify({
            'ok': True, 'map': map_name, 'layer': key, 'source': src.get('id'),
            'reference': ref.get('id'),
            'center': {'lat': round(lat, 7), 'lon': round(lon, 7)},
            'measured': {'east': round(r['east'], 2), 'north': round(r['north'], 2),
                         'dist': round(math.hypot(r['east'], r['north']), 2)},
            'reliable': bool(reliable), 'reason': reason,
            'quality': {'snr': round(r['snr'], 1),
                        'agree_m': None if r['agree_m'] is None else round(r['agree_m'], 2),
                        # clear readings inside the area and how far the
                        # farthest lies from the one returned
                        'windows': int(r.get('windows') or 0),
                        'spread_m': round(float(r.get('spread_m') or 0.0), 2),
                        'snr_min': SNR_MIN, 'agree_max_m': AGREE_MAX_M},
            'levels': [{'z': l['z'], 'n': l['n'], 'east': round(l['east'], 2),
                        'north': round(l['north'], 2), 'snr': round(l['snr'], 1)}
                       for l in r['levels']],
            'reference_offset': ro, 'stored': cur,
            'proposed': prop if reliable else None,
            'tiles': r['tiles'], 'took_s': round(time.time() - t0, 1),
        })

    return api_tile_offsets_measure
