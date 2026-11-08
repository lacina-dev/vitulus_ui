#!/usr/bin/env python3
"""Terrain maps of mowed areas for the UI (nodes/terrain_mosaic.py + the webnode routes, T30).

    python3 tools/test_terrain_mosaic.py

An INVENTED mosaic in a temporary directory (no garden data): list_mosaics reads only
JSONs with a valid georeference and files that exist, newest first; safe_file serves
only plain .png / .json files lying directly in the directory (no ../, no absolute
path, no hidden file, no symlink out, no other extension); the webnode routes call
exactly these (checked in the source) and answer with ETag + no-cache, 304 on a repeat
(a small Flask app with the same calls, when Flask is installed).
"""
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'nodes'))
import terrain_mosaic as tm  # noqa: E402

FAILS = []


def ok(label, cond, info=''):
    print(('ok   ' if cond else 'FAIL ') + label + ('' if cond or not info else ' — ' + str(info)))
    if not cond:
        FAILS.append(label)


PNG = (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x00\x00\x00\x00:~\x9bU'
       b'\x00\x00\x00\nIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82')


def mosaic(d, name, mtime, **over):
    files = {'cost': name + '_cost.png', 'reason': name + '_reason.png', 'missing': name + '_none.png'}
    j = {'frame': 'map', 'resolution': 0.05, 'width': 4, 'height': 3, 'yaw': 0.0, 'origin_x': 1.0, 'origin_y': -2.0,
         'files': files, 'stats': {'area_known_m2': 12.5, 'lethal_pct': 3.0, 'steps': [1, 2, 3]}, 'bags': ['a.bag']}
    j.update(over)
    for k in ('cost', 'reason'):
        with open(os.path.join(d, files[k]), 'wb') as fh:
            fh.write(PNG)
    p = os.path.join(d, name + '.json')
    with open(p, 'w') as fh:
        json.dump(j, fh)
    os.utime(p, (mtime, mtime))


def main():
    root = tempfile.mkdtemp(prefix='t30_')
    try:
        d = os.path.join(root, 'site_x', 'terrain_mosaic')
        os.makedirs(d)
        now = time.time()
        mosaic(d, 'older', now - 100)
        mosaic(d, 'newer', now)
        mosaic(d, 'badgeo', now, resolution=-1)
        with open(os.path.join(d, 'junk.json'), 'w') as fh:
            fh.write('{not json')
        outside = os.path.join(root, 'secret.png')
        with open(outside, 'wb') as fh:
            fh.write(PNG)
        os.symlink(outside, os.path.join(d, 'link.png'))
        with open(os.path.join(d, 'notes.txt'), 'w') as fh:
            fh.write('x')

        ok('mosaic_dir: plain site names only', tm.mosaic_dir('site_x', root) == d and tm.mosaic_dir('../etc', root) == ''
           and tm.mosaic_dir('', root) == '' and tm.mosaic_dir(None, root) == '')
        ms = tm.list_mosaics(d)
        ok('list: valid mosaics only, newest first', [m['name'] for m in ms] == ['newer', 'older'], [m['name'] for m in ms])
        m = ms[0]
        ok('list: georeference keys', m['georef'] == {'frame': 'map', 'resolution': 0.05, 'width': 4, 'height': 3,
                                                       'yaw': 0.0, 'origin_x': 1.0, 'origin_y': -2.0})
        ok('list: a listed file that is missing is left out', set(m['files']) == {'cost', 'reason'}, m['files'])
        ok('list: stats only the short numbers (no long lists)', m['stats'] == {'area_known_m2': 12.5, 'lethal_pct': 3.0})
        mosaic(d, 'teren_site_x', now - 50, source='terrain_recorder', version=41, stamp=123.0)
        ms2 = tm.list_mosaics(d)
        rec = [x for x in ms2 if x['name'] == 'teren_site_x'][0]
        ok('T31: the recorder export passes source / version / stamp', rec['source'] == 'terrain_recorder' and rec['version'] == 41 and rec['stamp'] == 123.0
           and ms2[0]['source'] == '' and ms2[0]['version'] is None)
        mosaic(d, 'teren_noarea', now - 60, source='terrain_recorder', version=2, area_m2=55.5, stats=None, generated_unix=99.0)
        rec2 = [x for x in tm.list_mosaics(d) if x['name'] == 'teren_noarea'][0]
        ok('T31: a recorder export without stats shows its area_m2; generated_unix passes', rec2['stats'].get('area_known_m2') == 55.5
           and rec2['area_m2'] == 55.5 and rec2['generated_unix'] == 99.0)
        ok('list: missing directory -> []', tm.list_mosaics(os.path.join(root, 'nope')) == [] and tm.list_mosaics('') == [])

        ok('safe_file: a file of the directory', tm.safe_file(d, 'newer_cost.png') == os.path.realpath(os.path.join(d, 'newer_cost.png')))
        for bad in ('../secret.png', '..%2Fsecret.png', '/etc/passwd', 'link.png', 'notes.txt', '.hidden.png',
                    'nope.png', '', None, 'a/b.png', 'newer_cost.png/..'):
            ok('safe_file refuses %r' % (bad,), tm.safe_file(d, bad) is None)

        src = open(os.path.join(HERE, '..', 'nodes', 'webnode')).read()
        ok('webnode: routes use mosaic_dir + list_mosaics / safe_file of the served site',
           "@app.route('/api/terrain_mosaic', methods=['GET'])" in src and "@app.route('/api/terrain_mosaic/<name>', methods=['GET'])" in src
           and 'terrain_mosaic.list_mosaics(d)' in src and 'terrain_mosaic.safe_file(d, name)' in src
           and src.count('terrain_mosaic.mosaic_dir(_tile_offsets_active_map())') == 1)
        ok('webnode: no write route for mosaics', "terrain_mosaic', methods=['POST']" not in src and "terrain_mosaic/<name>', methods=['POST']" not in src)

        try:
            from flask import Flask, jsonify, send_file, abort
        except ImportError:
            print('skip Flask client (Flask not installed)')
        else:
            app = Flask('t30')

            @app.route('/api/terrain_mosaic')
            def lst():
                r = jsonify({'ok': True, 'mosaics': tm.list_mosaics(d)})
                r.headers['Cache-Control'] = 'no-cache'
                return r

            @app.route('/api/terrain_mosaic/<name>')
            def one(name):
                path = tm.safe_file(d, name)
                if not path:
                    abort(404)
                r = send_file(path, conditional=True, mimetype='image/png')
                r.headers['Cache-Control'] = 'no-cache'
                return r

            c = app.test_client()
            r = c.get('/api/terrain_mosaic')
            ok('GET list: 200 JSON, no-cache', r.status_code == 200 and r.get_json()['mosaics'][0]['name'] == 'newer'
               and r.headers.get('Cache-Control') == 'no-cache')
            r = c.get('/api/terrain_mosaic/newer_cost.png')
            et = r.headers.get('ETag')
            ok('GET file: 200 PNG with ETag', r.status_code == 200 and r.data[:8] == PNG[:8] and bool(et))
            r2 = c.get('/api/terrain_mosaic/newer_cost.png', headers={'If-None-Match': et})
            ok('GET file again: 304', r2.status_code == 304)
            ok('GET traversal / symlink / other file: 404', all(c.get('/api/terrain_mosaic/' + n).status_code == 404
                                                               for n in ('..%2Fsecret.png', 'link.png', 'notes.txt', 'x.png')))
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print('\n%d failed' % len(FAILS) if FAILS else '\nOK — all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
