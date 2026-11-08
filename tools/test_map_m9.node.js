#!/usr/bin/env node
/*
 * T17 batch M9 (map_audit2.md):
 *     node tools/test_map_m9.node.js
 *   - M9-1 "Align Google to ČÚZK": tileAlignShift (mapping.js, sliced
 *     verbatim) moves only the Google group (offset_key 'sat') by the measured
 *     -0.73 m E / -0.71 m N, turned into the map frame, 0 when off; the render
 *     hook adds it ON TOP of the robot-stored nudge and never stores it; the
 *     option is off by default, browser-only, outside the nudge box (the box
 *     takes the arrow keys), mirrored in the layers panel only for Google;
 *   - M9-2 native_zoom: the catalog field (normalize, ≤ max_zoom, default =
 *     max_zoom), Auto detail stops there on a desktop, a phone keeps
 *     max_zoom - 1 when lower (Google z20 as before, ČÚZK z19), a manual cap
 *     never above it; the shipped catalog gives Google satellite + hybrid 20;
 *   - M9-6 desktop zoomed out (zAdaptive ≤ 18): overlays one level coarser,
 *     tones two; closer up unchanged; the phone rule unchanged;
 *   - M9-5 the status line keys exist en + cs with the same placeholders, the
 *     old technical keys are gone and nothing uses them;
 *   - T20 leftover: the rain time line refits its labels on a size change.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
let fails = 0;
function check(name, ok, info) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !info ? '' : ' — ' + info));
    if (!ok) { fails++; }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const mapping = fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8');
function slice(src, start) {
    let depth = 0;
    const open = src.indexOf('{', start);
    for (let j = open; j < src.length; j++) {
        if (src[j] === '{') { depth++; } else if (src[j] === '}') { depth--; if (!depth) { return src.slice(start, j + 1); } }
    }
    throw new Error('braces');
}

// ---- M9-1
const cLine = /const ALIGN_ETRS89_EN = \{ e: (-?[0-9.]+), n: (-?[0-9.]+) \};/.exec(mapping);
check('M9-1 the measured shift: 0.73 m west, 0.71 m south', cLine && cLine[1] === '-0.73' && cLine[2] === '-0.71');
const tileAlignShift = new Function(cLine[0] + '\n' + slice(mapping, mapping.indexOf('function tileAlignShift(')) + '\nreturn tileAlignShift;')();
const z = tileAlignShift(false, 'sat', 0);
check('M9-1 off: no shift', z.dx === 0 && z.dy === 0);
const c = tileAlignShift(true, 'cuzk', 0);
check('M9-1 on: ČÚZK and other groups never move', c.dx === 0 && c.dy === 0 && tileAlignShift(true, 'osm', 0.3).dx === 0);
const g = tileAlignShift(true, 'sat', 0);
check('M9-1 on, north-up map: Google back by -0.73 / -0.71', near(g.dx, -0.73) && near(g.dy, -0.71), JSON.stringify(g));
const yaw = 0.4, r = tileAlignShift(true, 'sat', yaw);
// the group sits at R(-yaw) * EN: turning the shift back by +yaw gives EN again
const e = Math.cos(yaw) * r.dx - Math.sin(yaw) * r.dy, n = Math.sin(yaw) * r.dx + Math.cos(yaw) * r.dy;
check('M9-1 a turned map: the shift is turned into the map frame', near(e, -0.73) && near(n, -0.71), e + ',' + n);
check('M9-1 a bad yaw counts as 0', near(tileAlignShift(true, 'sat', NaN).dx, -0.73));
check('M9-1 the render hook adds it on top of the stored nudge (base and overlays)',
      /g\.position\.x = o\.dx \+ a\.dx;/.test(mapping) && /st\.group\.position\.x = o\.dx \+ a\.dx;/.test(mapping));
check('M9-1 the stored nudge never includes it (_currentTileOffset unchanged)',
      !/_currentTileOffset\(\) \{[^}]*_alignShift/.test(mapping));
check('M9-1 default off, remembered in the browser only', /this\._layerPref\('vitulus_align_etrs89', false\)/.test(mapping) &&
      !/tile_offsets[^\n]*align/i.test(mapping));
check('M9-1 the tick box sits outside the nudge box (arrow keys)', /box\.parentNode\.insertBefore\(row, box\)/.test(mapping));
const layers = fs.readFileSync(path.join(JS, 'vt_map_layers.js'), 'utf8');
check('M9-1 the layers panel mirrors #mapv3_align_etrs, shown only for a Google base',
      /ovRow\('align', 'mapv3_align_etrs'/.test(layers) && /\(bsrc\.offset_key \|\| bsrc\.id\) === 'sat'/.test(layers));

// ---- M9-2
const MS = require(path.join(JS, 'vt_map_sources.js'));
const MT = require(path.join(JS, 'vt_map_tiles.js'));
const cat = MS.normalize({ sources: [
    { id: 'sat', kind: 'base', layer: 'gm_layer', grid: 'gm_grid', max_zoom: 21, native_zoom: 20 },
    { id: 'cuzk', kind: 'base', layer: 'c', grid: 'gm_grid', max_zoom: 20 },
    { id: 'odd', kind: 'base', layer: 'o', grid: 'gm_grid', max_zoom: 18, native_zoom: 25 }] });
check('M9-2 native_zoom read from the catalog', cat.byId.sat.native_zoom === 20 && cat.byId.sat.max_zoom === 21);
check('M9-2 native_zoom defaults to max_zoom, never above it', cat.byId.cuzk.native_zoom === 20 && cat.byId.odd.native_zoom === 18);
check('M9-2 the built-in fallback knows Google is z20', MS.fallback().byId.sat.native_zoom === 20);
check('M9-2 desktop Auto: Google z20, ČÚZK z20', MT.zoomCap(21, 'auto', { coarse: false }, 20) === 20 && MT.zoomCap(20, 'auto', { coarse: false }, 20) === 20);
check('M9-2 phone Auto: Google z20 (as before), ČÚZK z19', MT.zoomCap(21, 'auto', { coarse: true }, 20) === 20 && MT.zoomCap(20, 'auto', { coarse: true }, 20) === 19);
check('M9-2 a manual cap never above native_zoom', MT.zoomCap(21, '21', { coarse: false }, 20) === 20 && MT.zoomCap(21, '18', { coarse: false }, 20) === 18);
check('M9-2 without native_zoom unchanged', MT.zoomCap(21, 'auto', { coarse: false }) === 21 && MT.zoomCap(21, 'auto', { coarse: true }) === 20);
check('M9-2 mapping.js passes native_zoom to zoomCap', /VTMapTiles\.zoomCap\(src\.max_zoom, zVal,\s*\{[^}]*\}, src\.native_zoom\)/.test(mapping));
const repos = [process.env.MAPPROXY_REPO, path.join(ROOT, '..', 'docker-mapproxy'), path.join(ROOT, '..', '..', 'docker-mapproxy')].filter(Boolean)
    .map((p) => path.join(p, 'mapproxy_configuration', 'ui_sources.json')).filter((f) => fs.existsSync(f));
if (repos.length) {
    const shipped = MS.normalize(JSON.parse(fs.readFileSync(repos[0], 'utf8')));
    const nz = ['sat', 'sat_hybrid'].map((id) => shipped.byId[id] && shipped.byId[id].native_zoom);
    console.log('catalog: ' + repos[0]);
    check('M9-2 shipped catalog: Google satellite + hybrid native z20 (needs docker-mapproxy M9)', nz[0] === 20 && nz[1] === 20, JSON.stringify(nz));
} else { console.log('skip  shipped catalog (set MAPPROXY_REPO)'); }

// ---- M9-6
const line = { layer_order: 'over' }, tone = { layer_order: 'under' }, DK = { coarse: false }, PH = { coarse: true };
check('M9-6 desktop close up (z19+): overlays as the view', MT.overlayWant(19, line, DK, 1) === 19 && MT.overlayWant(20, tone, DK, 1) === 20);
check('M9-6 desktop zoomed out (z18): lines z17, tones z16', MT.overlayWant(18, line, DK, 1) === 17 && MT.overlayWant(18, tone, DK, 1) === 16);
check('M9-6 desktop far out stays ≥ 0', MT.overlayWant(1, tone, DK, 1) === 0);
check('M9-6 phone rule unchanged', MT.overlayWant(18, line, PH, 2) === 17 && MT.overlayWant(18, tone, PH, 2) === 16 && MT.overlayWant(20, line, PH, 1) === 20);

// ---- M9-5 + i18n
const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = win.VT_I18N_DICT;
const keys = [...new Set([...mapping.matchAll(/mapT\('(mapping\.m9\.[a-z_]+)'/g), ...layers.matchAll(/t\('(maplyr\.m9\.[a-z_]+)'/g)].map((m) => m[1]))];
['mapping.m9.st_full', 'mapping.m9.st_out'].forEach((k) => { if (!keys.includes(k)) { keys.push(k); } });
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
check('M9 keys in en + cs (' + keys.length + ')', keys.every((k) => k in D.en && k in D.cs), keys.filter((k) => !(k in D.en && k in D.cs)).join(','));
check('M9 same placeholders en / cs', keys.every((k) => ph(D.en[k]) === ph(D.cs[k])));
const old = ['tiles', 'tiles_same', 'tiles_out', 'tiles_capped', 'tiles_loading', 'tiles_failed', 'tiles_none'].map((k) => 'mapping.aerial.' + k);
check('M9-5 the old technical status keys are gone and unused',
      old.every((k) => !(k in D.en) && !(k in D.cs) && !mapping.includes("'" + k + "'")));
check('M9-5 the status line names the source first', ['st_full', 'st_out', 'st_loading', 'st_failed', 'st_none', 'st_capped']
      .every((k) => D.en['mapping.m9.' + k].startsWith('{src} — ') && D.cs['mapping.m9.' + k].startsWith('{src} — ')));

// ---- T20 leftover
const precip = fs.readFileSync(path.join(JS, 'vt_precip.js'), 'utf8');
check('rain time line: labels refit on a size change (ResizeObserver → _fixTicks)', /new ResizeObserver\(function \(\) \{ self\._fixTicks\(\); \}\)\.observe\(sl\)/.test(precip));

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
