#!/usr/bin/env node
/*
 * Map layer "Mowed area terrain" (assets/js/vt_terrain_mosaic.js, T30):
 *     node tools/test_terrain_mosaic.node.js
 *   - loaded by vt_map_layers.js (no index.html change);
 *   - only GETs of /api/terrain_mosaic[/<file>]: no POST, no ROS, no WebSocket;
 *   - 16-bit grey PNG decoding (an invented raster, every filter type 0–4):
 *     exactly the values written, row 0 = top; PNG chunk parsing;
 *   - height colours (0 = unknown = clear, low blue, high brown), robust range;
 *   - placement in the map frame (min corner, size, turn about the corner);
 *   - i18n keys in en + cs with the same placeholders.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const TPL = path.join(ROOT, 'nodes', 'templates');
const JS = path.join(TPL, 'assets', 'js');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !info ? '' : ' — ' + info)); if (!ok) { fails++; } }
const src = fs.readFileSync(path.join(JS, 'vt_terrain_mosaic.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
const layers = fs.readFileSync(path.join(JS, 'vt_map_layers.js'), 'utf8');
check('loaded by vt_map_layers.js, index.html unchanged', !html.includes('vt_terrain_mosaic.js') && layers.includes("sc.src = '/assets/js/vt_terrain_mosaic.js'"));
['ROSLIB', 'WebSocket', '.publish(', 'callService', 'sendBeacon', "method: 'POST'", 'XMLHttpRequest'].forEach((w) => check('reads only: no ' + w, !code.includes(w)));
check('GETs only the mosaic routes', (code.match(/fetch\(/g) || []).length === 2 && code.includes("fetch('/api/terrain_mosaic'") && code.includes("'/api/terrain_mosaic/' + encodeURIComponent(name)"));

const M = require(path.join(JS, 'vt_terrain_mosaic.js'));
// an invented 16-bit grey raster, 7 x 5, rows with filter types 0..4 (encoded here)
const W = 7, H = 5, vals = [];
for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) { vals.push(y === 2 && x === 3 ? 0 : 1 + x * 1000 + y * 37 + (x * y) % 13); } }
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
const stride = W * 2, raw = Buffer.alloc((stride + 1) * H);
let prev = Buffer.alloc(stride);
for (let y = 0; y < H; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < W; x++) { cur[2 * x] = vals[y * W + x] >> 8; cur[2 * x + 1] = vals[y * W + x] & 255; }
    const f = y % 5; raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
        const a = i >= 2 ? cur[i - 2] : 0, b = prev[i], c = i >= 2 ? prev[i - 2] : 0;
        const pr = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1) : paeth(a, b, c);
        raw[y * (stride + 1) + 1 + i] = (cur[i] - pr) & 255;
    }
    prev = cur;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);   // CRC not checked here
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 16; ihdr[9] = 0; ihdr[12] = 0;
const z = zlib.deflateSync(raw);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z.subarray(0, 10)), chunk('IDAT', z.subarray(10)), chunk('IEND', Buffer.alloc(0))]);
const c = M.pngChunks(new Uint8Array(png));
check('PNG chunks: size, 16-bit grey, IDATs joined', c && c.w === W && c.h === H && c.depth === 16 && c.color === 0 && c.idat.length === z.length);
check('not a PNG -> null', M.pngChunks(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])) === null);
const dec = M.unfilterGray16(new Uint8Array(zlib.inflateSync(Buffer.from(c.idat))), W, H);
check('16-bit values exactly back, every filter type 0–4', dec.length === vals.length && vals.every((v, i) => dec[i] === v),
      JSON.stringify(Array.from(dec).slice(0, 8)));
const rg = M.heightRange(dec);
check('height range ignores unknown (0)', rg && rg.lo >= 1 && rg.hi <= 6250);
check('height colours: unknown clear, low blue, high brown', M.heightColor(0, 1, 100)[3] === 0 && M.heightColor(1, 1, 100)[2] > M.heightColor(1, 1, 100)[0] &&
      M.heightColor(100, 1, 100)[0] > M.heightColor(100, 1, 100)[2]);
const near = (a, b) => Math.abs(a - b) < 1e-9;
const pl = M.placement({ resolution: 0.05, width: 400, height: 600, yaw: 0, origin_x: -6, origin_y: -26 });
check('placement: min corner + half size', pl && near(pl.cx, 4) && near(pl.cy, -11) && near(pl.w, 20) && near(pl.h, 30));
const pt = M.placement({ resolution: 1, width: 2, height: 0 + 4, yaw: Math.PI / 2, origin_x: 0, origin_y: 0 });
check('placement: turned about the min corner', pt && near(pt.cx, -2) && near(pt.cy, 1));
check('placement: bad georeference -> null', M.placement({ resolution: 0, width: 1, height: 1 }) === null && M.placement(null) === null);
check('reason colours as the live layer (0 clear, 5 red)', M.reasonColor(0)[3] === 0 && M.reasonColor(5)[0] > 200 && M.reasonColor(42)[3] === 0);

// T31: several maps of a site (one mowing, the recorder's lasting map): the chosen one if still there, else the newest
const L2 = [{ name: 'teren_site' }, { name: 'teren_day' }];
check('T31 choose: remembered map, else the newest (first), none -> null',
      M.choose(L2, 'teren_day') === L2[1] && M.choose(L2, 'gone') === L2[0] && M.choose(L2, null) === L2[0] && M.choose([], 'x') === null);
const L3 = [{ name: 'teren_day', mtime: 9 }, { name: 'teren_site', source: 'terrain_recorder', version: 41, area_m2: 300, generated_unix: 77, mtime: 5 }];
check('T31 default: the recorder export over a newer offline mosaic; a remembered choice still wins',
      M.choose(L3, null) === L3[1] && M.choose(L3, 'teren_day') === L3[0]);
check('T31 an empty recorder export (area 0, after delete_map) is not the default',
      M.choose([{ name: 'd', mtime: 9 }, { name: 'r', source: 'terrain_recorder', area_m2: 0, version: 1 }], null).name === 'd');
check('T31 PNG cache keyed by the export version (else stamp, else the JSON time), URL ?v= too',
      M.version(L3[1]) === 'v41@77' && M.version({ version: 1, stamp: 7 }) === 'v1@7' && M.version({ version: 1, mtime: 8 }) === 'v1@8' && M.version({ mtime: 3 }) === 't3' &&
      src.includes("key = name + '|' + kind + '|' + ver") && src.includes("'?v=' + encodeURIComponent(ver)"));
check('T31 a failing list (HTTP 500) is an error, not "no map"; a new export redraws quietly', /if \(!r\.ok\) \{ throw new Error/.test(src) && /draw\(true\)/.test(src) &&
      /if \(!\(quiet && S\.state === 'ok'\)\) \{ setState\('loading'\); \}/.test(src));
check('T31 while shown the list is looked at every minute (a new export redraws)', /setInterval\(function \(\) \{ if \(!document\.hidden\) \{ loadList\(false\); \} \}, 60000\)/.test(src));
check('T31 the choice is remembered and the panel picks through VTTerrainMosaic.pick', src.includes("LS_PICK = 'vitulus_layer_tmosaic_pick'") && layers.includes('VTTerrainMosaic.pick(sel.value)'));
const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = win.VT_I18N_DICT;
const keys = new Set([...src.matchAll(/t\('(tmos\.[a-z_.]+)'/g), ...layers.matchAll(/t\('(tmos\.[a-z_.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
['off', 'loading', 'ok', 'nomap', 'error'].forEach((s) => keys.add('tmos.st.' + s));
['nomap', 'error'].forEach((s) => keys.add('tmos.why.' + s));
['cost', 'reason', 'height'].forEach((s) => keys.add('tmos.mode.' + s));
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
const miss = [...keys].filter((k) => !(k in D.en) || !(k in D.cs));
check('tmos.* keys in en + cs (' + keys.size + ')', !miss.length, miss.join(', '));
check('same placeholders en / cs', [...keys].every((k) => !(k in D.en) || ph(D.en[k]) === ph(D.cs[k])));
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
