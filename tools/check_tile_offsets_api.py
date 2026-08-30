#!/usr/bin/env python3
"""Live check of the aerial tile-offset routes on the running webnode.

    python3 tools/check_tile_offsets_api.py [--host 127.0.0.1] [--port 7779]

vitulus_ui has NO formal test directory or test framework (the only existing
harnesses are the standalone tools/*.node.js scripts), so this is a plain
stdlib script rather than an invented pytest suite: it drives the real routes
over HTTP against the live node and restores whatever it found on the way in.

Covers: GET shape, POST persists + is visible to a FRESH client session
(the cross-browser contract), per-layer and per-map independence, the +/-50 m
bound, malformed bodies answering 400 (never 500), reset of one layer and
reset of the whole map.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

FAILS = []


def ok(label, cond, detail=''):
    if not cond:
        FAILS.append(label + (' :: ' + detail if detail else ''))
    print('  %-62s %s' % (label, 'ok' if cond else 'FAIL'))


def call(base, path, body=None):
    """Returns (status, parsed json or raw text)."""
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {'Content-Type': 'application/json'} if data else {}
    # A fresh opener per call == a fresh client session: no cookies, no cache.
    req = urllib.request.Request(url, data=data, headers=hdrs,
                                 method='POST' if data is not None else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        status = exc.code
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=7779)
    args = ap.parse_args()
    base = 'http://%s:%d' % (args.host, args.port)

    print('tile-offset API on %s' % base)

    print('\nGET /api/tile_offsets')
    st, j = call(base, '/api/tile_offsets')
    ok('GET is 200', st == 200, str(st))
    ok('GET reports ok', isinstance(j, dict) and j.get('ok') is True, str(j)[:120])
    ok('GET carries an offsets object', isinstance(j.get('offsets'), dict))
    ok('GET carries a ts', isinstance(j.get('ts'), int))
    ok('GET states the bound', j.get('max_m') == 50.0, str(j.get('max_m')))
    ok('GET states the units (metres, map frame)',
       'metre' in str(j.get('units')) and 'map' in str(j.get('units')))
    active = j.get('active_map')
    ok('GET resolves the active map', isinstance(active, str))
    print('    active_map = %r' % active)
    before = j.get('offsets') or {}

    # Work on a scratch map name so a real alignment is never disturbed.
    MAP = '__tileoffset_selftest__'
    ok('scratch map is not already stored', MAP not in before)

    print('\nPOST /api/tile_offsets  (persist)')
    st, j = call(base, '/api/tile_offsets',
                 {'map': MAP, 'layer': 'sat', 'dx': 0.35, 'dy': -0.2})
    ok('POST is 200', st == 200, str(st))
    ok('POST reports ok', j.get('ok') is True, str(j)[:120])
    st, j = call(base, '/api/tile_offsets')
    got = (j.get('offsets') or {}).get(MAP, {}).get('sat')
    ok('a FRESH client session reads back the offset (cross-browser)',
       got == {'dx': 0.35, 'dy': -0.2}, str(got))

    print('\nper-layer / per-map independence')
    call(base, '/api/tile_offsets',
         {'map': MAP, 'layer': 'osm', 'dx': 1.0, 'dy': 2.0})
    st, j = call(base, '/api/tile_offsets')
    layers = (j.get('offsets') or {}).get(MAP, {})
    ok('the two tile layers keep separate offsets',
       layers.get('sat') == {'dx': 0.35, 'dy': -0.2}
       and layers.get('osm') == {'dx': 1.0, 'dy': 2.0}, str(layers))
    call(base, '/api/tile_offsets',
         {'map': MAP + '2', 'layer': 'sat', 'dx': -3.0, 'dy': 0.0})
    st, j = call(base, '/api/tile_offsets')
    ok('a second map keeps its own offset',
       (j.get('offsets') or {}).get(MAP + '2', {}).get('sat') == {'dx': -3.0, 'dy': 0.0})
    ok('the first map is untouched by the second',
       (j.get('offsets') or {}).get(MAP, {}).get('sat') == {'dx': 0.35, 'dy': -0.2})

    print('\nbad input is a clear 400, never a 500')
    for label, body in [
            ('over the +/-50 m bound', {'map': MAP, 'layer': 'sat', 'dx': 51, 'dy': 0}),
            ('non-numeric dx', {'map': MAP, 'layer': 'sat', 'dx': 'left a bit', 'dy': 0}),
            ('missing map', {'layer': 'sat', 'dx': 1, 'dy': 0}),
            ('missing layer', {'map': MAP, 'dx': 1, 'dy': 0}),
            ('body is not an object', ['nope']),
    ]:
        st, j = call(base, '/api/tile_offsets', body)
        ok('400 + error: ' + label,
           st == 400 and isinstance(j, dict) and j.get('ok') is False
           and bool(j.get('error')), '%s %s' % (st, str(j)[:90]))

    print('\nreset')
    st, j = call(base, '/api/tile_offsets/reset', {'map': MAP, 'layer': 'sat'})
    ok('reset one layer is 200/ok', st == 200 and j.get('ok') is True, str(j)[:120])
    st, j = call(base, '/api/tile_offsets')
    layers = (j.get('offsets') or {}).get(MAP, {})
    ok('the reset layer is gone', 'sat' not in layers, str(layers))
    ok('the sibling layer survives', layers.get('osm') == {'dx': 1.0, 'dy': 2.0})
    st, j = call(base, '/api/tile_offsets/reset', {'map': MAP})
    ok('reset whole map is 200/ok', st == 200 and j.get('ok') is True)
    st, j = call(base, '/api/tile_offsets')
    ok('the whole map key is gone', MAP not in (j.get('offsets') or {}))

    # tidy up the second scratch map
    call(base, '/api/tile_offsets/reset', {'map': MAP + '2'})
    st, j = call(base, '/api/tile_offsets')
    after = j.get('offsets') or {}
    ok('the store is back to what we found', after == before,
       'before=%s after=%s' % (before, after))

    print('')
    if FAILS:
        print('FAILED (%d):' % len(FAILS))
        for f in FAILS:
            print('  - ' + f)
        return 1
    print('all checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
