"""terrain_mosaic.py — the terrain maps of mowed areas for the UI (T30, 2026-11-08).

A terrain mosaic is made offline from the mowing recordings (vitulus_traversability
terrain_mosaic) and stored per site:

    ~/.vitulus/mapping_v3/<site>/terrain_mosaic/<name>.json     georeference, legend, stats,
                                                                 "files": {cost, reason, ...}
    ~/.vitulus/mapping_v3/<site>/terrain_mosaic/<name>_*.png    the rasters

The webnode serves them read-only (GET /api/terrain_mosaic, GET
/api/terrain_mosaic/<file>); this module holds the pure part so it can be
tested without ROS (tools/test_terrain_mosaic.py):

  list_mosaics(dir)   the mosaics in a directory, newest first
  safe_file(dir, n)   the path of a file directly in the directory, or None
                      (no path traversal, no hidden files, no symlinks out)
"""
import json
import os
import re

NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(png|json)$')
GEO_KEYS = ('frame', 'resolution', 'width', 'height', 'yaw', 'origin_x', 'origin_y')
MAX_JSON_BYTES = 2 * 1024 * 1024


def mosaic_dir(site, root='~/.vitulus/mapping_v3'):
    """The mosaic directory of a site ('' when the site name is not plain)."""
    if not isinstance(site, str) or not re.match(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$', site):
        return ''
    return os.path.join(os.path.expanduser(root), site, 'terrain_mosaic')


def safe_file(directory, name):
    """Absolute path of `name` inside `directory`, or None when it is not a
    plain .png / .json file that really lies directly in it."""
    if not directory or not isinstance(name, str) or not NAME_RE.match(name) or '..' in name:
        return None
    base = os.path.realpath(directory)
    path = os.path.realpath(os.path.join(base, name))
    if os.path.dirname(path) != base or not os.path.isfile(path):
        return None
    return path


def _georef_ok(j):
    try:
        if not all(k in j for k in GEO_KEYS):
            return False
        if not (float(j['resolution']) > 0 and int(j['width']) > 0 and int(j['height']) > 0):
            return False
        float(j['origin_x']); float(j['origin_y']); float(j['yaw'])
        return isinstance(j.get('files'), dict)
    except (TypeError, ValueError):
        return False


def list_mosaics(directory):
    """The mosaics in `directory`, newest first: [{name, mtime, georef, files,
    stats, legend...}] — only JSONs with a valid georeference whose listed
    files exist in the directory (a file that is missing is left out of
    `files`)."""
    out = []
    if not directory or not os.path.isdir(directory):
        return out
    for fn in sorted(os.listdir(directory)):
        if not fn.endswith('.json'):
            continue
        path = safe_file(directory, fn)
        if not path or os.path.getsize(path) > MAX_JSON_BYTES:
            continue
        try:
            with open(path, 'r') as fh:
                j = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(j, dict) or not _georef_ok(j):
            continue
        files = {}
        for k, v in j['files'].items():
            if isinstance(v, str) and v.endswith('.png') and safe_file(directory, v):
                files[k] = v
        if not files:
            continue
        stats = dict(j.get('stats')) if isinstance(j.get('stats'), dict) else {}
        # the recorder's export has no "stats", its known area is "area_m2"
        if 'area_known_m2' not in stats and isinstance(j.get('area_m2'), (int, float)):
            stats['area_known_m2'] = j['area_m2']
        out.append({
            'name': fn[:-5],
            'json': fn,
            'mtime': os.path.getmtime(path),
            'georef': {k: j[k] for k in GEO_KEYS},
            'files': files,
            'encoding': j.get('encoding') if isinstance(j.get('encoding'), dict) else {},
            'reasons_ui': j.get('reasons_ui') if isinstance(j.get('reasons_ui'), dict) else {},
            'stats': {k: stats[k] for k in ('area_known_m2', 'area_elevation_m2', 'lethal_m2', 'lethal_pct',
                                            'elevation_range_m', 'slope_p50_deg', 'slope_p95_deg', 'track_m',
                                            'drive_min', 'bbox_m') if k in stats},
            'bags': [b for b in j.get('bags', []) if isinstance(b, str)][:20],
            # T31: the terrain_recorder's lasting map ("source": "terrain_recorder",
            # "version" +1 per export, "stamp"); offline mosaics have none of these
            'source': j.get('source') if isinstance(j.get('source'), str) else '',
            'version': j.get('version') if isinstance(j.get('version'), (int, float)) else None,
            'stamp': j.get('stamp') if isinstance(j.get('stamp'), (int, float)) else None,
            'generated_unix': j.get('generated_unix') if isinstance(j.get('generated_unix'), (int, float)) else None,
            'area_m2': j.get('area_m2') if isinstance(j.get('area_m2'), (int, float)) else None,
        })
    out.sort(key=lambda m: m['mtime'], reverse=True)
    return out
