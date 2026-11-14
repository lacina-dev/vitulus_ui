#!/usr/bin/env node
/*
 * MapProxy tile layers, the pure part (vt_map_tiles.js, T17 M3):
 *
 *     node tools/test_map_tiles.node.js
 *
 * Checks the tile maths the "no blank frame" rebuild relies on (overlap of
 * tiles of different zooms, ancestors, the tiles under a stand-in, centre-
 * first order), the per-device budgets (a phone gets less) and the texture
 * cache: references, LRU eviction of unused textures, the idle and the hard
 * limit, dispose called exactly once per evicted texture; the Detail cap
 * ("auto" = the source's finest level on every device, M12) and the level
 * the background map aims at (baseWant: a 2x screen loads the finer level
 * later); the
 * offline fill (plain white tile), the cache-busting URL and the outage
 * bookkeeping that reloads the tiles once the network / robot is back.
 * Also checks that mapping.js uses the module and that the detail select in
 * index.html defaults to "auto" with the manual caps kept (M3-1) and has no
 * area select any more (M5-4).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const TPL = path.join(__dirname, '..', 'nodes', 'templates');
const MT = require(path.join(TPL, 'assets', 'js', 'vt_map_tiles.js'));

const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(66) + (cond ? 'ok' : 'FAIL'));
}

console.log('map tiles (node harness)');

console.log('\ntile maths');
ok('same tile overlaps itself', MT.overlaps({ z: 19, x: 10, y: 20 }, { z: 19, x: 10, y: 20 }));
ok('neighbours do not overlap', !MT.overlaps({ z: 19, x: 10, y: 20 }, { z: 19, x: 11, y: 20 }));
ok('child overlaps its parent', MT.overlaps({ z: 20, x: 21, y: 41 }, { z: 19, x: 10, y: 20 }));
ok('child of a neighbour does not', !MT.overlaps({ z: 20, x: 22, y: 41 }, { z: 19, x: 10, y: 20 }));
ok('z21 tile inside a z17 tile', MT.overlaps({ z: 17, x: 3, y: 5 }, { z: 21, x: 3 * 16 + 15, y: 5 * 16 }));
const an = MT.ancestor({ z: 21, x: 1131477, y: 709821 }, 2);
ok('ancestor two levels up', an.z === 19 && an.x === 282869 && an.y === 177455);
const R = { tx0: 100, tx1: 103, ty0: 200, ty1: 203 };
const u1 = MT.under({ z: 18, x: 50, y: 100 }, 19, R);
ok('coarser stand-in covers 2x2 of the finer set', u1 && u1.x0 === 100 && u1.x1 === 101 && u1.y0 === 200 && u1.y1 === 201);
const u2 = MT.under({ z: 20, x: 205, y: 401 }, 19, R);
ok('finer stand-in lies under one tile of the set', u2 && u2.x0 === 102 && u2.x1 === 102 && u2.y0 === 200 && u2.y1 === 200);
ok('stand-in off the coverage: none under it', MT.under({ z: 19, x: 90, y: 200 }, 19, R) === null);
const u3 = MT.under({ z: 17, x: 25, y: 50 }, 19, R);
ok('stand-in larger than the set is clipped to it', u3 && u3.x0 === 100 && u3.x1 === 103 && u3.y0 === 200 && u3.y1 === 203);
const ord = MT.orderByDistance({ tx0: 0, tx1: 2, ty0: 0, ty1: 2 }, 1.5, 1.5);
ok('centre tile loads first', ord.length === 9 && ord[0][0] === 1 && ord[0][1] === 1);
ok('corners load last', ord.slice(5).every((p) => p[0] !== 1 && p[1] !== 1));

console.log('\nbudgets');
const desk = MT.budgets({ coarse: false }), phone = MT.budgets({ coarse: true });
ok('desktop keeps 600 tiles / background 400', desk.tileBudget === 600 && desk.baseCap === 400);
ok('phone gets fewer tiles', phone.tileBudget < desk.tileBudget && phone.baseCap < desk.baseCap);
ok('phone background cap within its budget', phone.baseCap <= phone.tileBudget);
ok('phone textures stay under 100 MB', phone.hardBytes <= 100 * MT.MB);
ok('phone budget fits its hard limit', phone.tileBudget * MT.texBytes(256, 256, true) <= phone.hardBytes);
ok('desktop budget fits its hard limit', desk.tileBudget * MT.texBytes(256, 256, true) <= desk.hardBytes);
ok('256 px tile with mipmaps ~0.35 MB', Math.abs(MT.texBytes(256, 256, true) - 349525) < 2);
ok('texture without mipmaps', MT.texBytes(256, 256, false) === 262144);

console.log('\ndetail (zoom cap)');
ok('auto on a desktop = the source max (Google z21)', MT.zoomCap(21, 'auto', { coarse: false }) === 21);
ok('auto on a desktop = the source max (ČÚZK z20)', MT.zoomCap(20, 'auto', { coarse: false }) === 20);
// T17 M12 (was: a phone one level less, Google z20 / ČÚZK z19): the cap is the
// source's finest level on every device, the phone saves tiles in baseWant
ok('auto on a phone = the source max too (Google z21 without native_zoom)', MT.zoomCap(21, 'auto', { coarse: true }) === 21);
ok('auto on a phone = the source max too (ČÚZK z20)', MT.zoomCap(20, 'auto', { coarse: true }) === 20);
ok('empty choice counts as auto', MT.zoomCap(21, '', { coarse: true }) === 21 && MT.zoomCap(21, null) === 21);
ok('manual cap is the same on every device', MT.zoomCap(21, '19', { coarse: true }) === 19 && MT.zoomCap(21, '19', { coarse: false }) === 19);
ok('manual cap never above the source max', MT.zoomCap(17, '21', { coarse: false }) === 17);
ok('nonsense choice falls back to the source max', MT.zoomCap(19, 'x', { coarse: false }) === 19);

console.log('\nbackground map level for a view (M12)');
ok('1x screen: the next finer level, as before (ceil)', MT.baseWant(19.01, 1) === 20 && MT.baseWant(19, 1) === 19 && MT.baseWant(18.99, 1) === 19);
ok('2x screen: the finer level only past half a level', MT.baseWant(19.49, 2) === 19 && MT.baseWant(19.51, 2) === 20);
ok('2x screen: a tile pixel never above 1.42 device px', [17.2, 18.5, 18.51, 19.49, 19.999, 20.3].every((z) => Math.pow(2, z - MT.baseWant(z, 2)) <= 1.42));
ok('1.5x screen: almost no slack', MT.baseWant(19.05, 1.5) === 19 && MT.baseWant(19.2, 1.5) === 20);
ok('a pixel ratio above 2 counts as 2, nonsense as 1', MT.baseWant(19.4, 3) === 19 && MT.baseWant(19.4, 0) === 20 && MT.baseWant(19.4) === 20);
ok('never below 0, no view stays no view', MT.baseWant(-3, 2) === 0 && MT.baseWant(Infinity, 2) === Infinity);

console.log('\nphone with overlays');
const PH = { coarse: true }, DK = { coarse: false };
ok('phone + overlays: the map gets half the budget', MT.baseShare(240, PH, 5) === 120 && MT.baseShare(240, PH, 1) === 120);
ok('phone without overlays: the whole budget', MT.baseShare(240, PH, 0) === 240);
ok('desktop: the whole budget with overlays', MT.baseShare(600, DK, 5) === 600);
const line = { layer_order: 'over' }, tone = { layer_order: 'under' };
ok('phone DPR 2: line overlay aims one level coarser (CSS px)', MT.overlayWant(20, line, PH, 2) === 19);
ok('phone DPR 2: tone overlay one more level coarser', MT.overlayWant(20, tone, PH, 2) === 18);
ok('phone DPR 1: line overlay as the view, tone one coarser', MT.overlayWant(20, line, PH, 1) === 20 && MT.overlayWant(20, tone, PH, 1) === 19);
ok('desktop: overlays aim at the view (unchanged)', MT.overlayWant(20, line, DK, 2) === 20 && MT.overlayWant(20, tone, DK, 1) === 20);
ok('no view (stub camera): unchanged', MT.overlayWant(Infinity, tone, PH, 2) === Infinity);
// the 300 m view on 390x844 DPR 2 (measured): map z20 153 / z19 45, overlays z19 45 / z18 15
const fitPhone = (() => { let b = 240; const cap = Math.min(160, MT.baseShare(b, PH, 5));
    const mapTiles = 153 <= cap ? 153 : 45; b -= mapTiles; b -= 3 * 45 + 2 * 15; return b >= 0; })();
ok('300 m view on a phone: map + five overlays fit the budget', fitPhone);

console.log('\nstand-ins across sources (M3-A)');
const dk = '50.08,14.35,0';
const SAT = { id: 'sat', offset_key: 'sat' }, HYB = { id: 'sat_hybrid', offset_key: 'sat' },
      CUZK = { id: 'cuzk', offset_key: 'cuzk' }, ZTM = { id: 'ztm', offset_key: 'cuzk' };
ok('same alignment group keeps the planes (sat -> hybrid)', MT.layerKey(dk, SAT) === MT.layerKey(dk, HYB));
ok('same alignment group keeps the planes (cuzk -> ztm)', MT.layerKey(dk, CUZK) === MT.layerKey(dk, ZTM));
ok('another alignment group starts empty (sat -> cuzk)', MT.layerKey(dk, SAT) !== MT.layerKey(dk, CUZK));
ok('another datum starts empty', MT.layerKey(dk, SAT) !== MT.layerKey('50.09,14.35,0', SAT));
ok('source without offset_key keys by its id', MT.layerKey(dk, { id: 'esri' }) === dk + '|esri');

console.log('\noffline fill');
const white = new Uint8ClampedArray(256 * 256 * 4).fill(255);
ok('plain white tile is the offline fill', MT.isBlankWhite(white));
const photo = white.slice(); photo[4 * 1000 + 1] = 254;
ok('one non-white pixel = a picture', !MT.isBlankWhite(photo));
const clear = white.slice(); for (let i = 3; i < clear.length; i += 4) { clear[i] = 0; }
ok('transparent overlay tile is not the fill', !MT.isBlankWhite(clear));
ok('empty data is not the fill', !MT.isBlankWhite(new Uint8ClampedArray(0)) && !MT.isBlankWhite(null));
ok('bust appends ?r=', MT.withBust('http://h:8082/wmts/l/g/19/1/2.png', 123) === 'http://h:8082/wmts/l/g/19/1/2.png?r=123');
ok('bust after an existing query uses &', MT.withBust('http://h/x.png?a=1', 5) === 'http://h/x.png?a=1&r=5');
ok('no token = url unchanged', MT.withBust('http://h/x.png', 0) === 'http://h/x.png');
ok('withoutBust strips only the r parameter', MT.withoutBust('http://h/x.png?r=123') === 'http://h/x.png' &&
   MT.withoutBust('http://h/x.png?a=1&r=5') === 'http://h/x.png?a=1' && MT.withoutBust('http://h/x.png') === 'http://h/x.png');
ok('withoutBust strips a repeated bust too', MT.withoutBust('http://h/x.png?r=1&r=2') === 'http://h/x.png' &&
   MT.withoutBust('http://h/x.png?r=1&a=2') === 'http://h/x.png?a=2');
ok('withoutBust undoes withBust', MT.withoutBust(MT.withBust('http://h/y.png', 99)) === 'http://h/y.png');
const O = new MT.Outage({ minGapMs: 20000 });
ok('no outage: recovery does nothing', O.recovered(1000) === false);
O.mark(2000); O.mark(3000);
ok('outage remembers when it began', O.down && O.since === 2000);
ok('first recovery reloads', O.recovered(5000) === true && !O.down);
ok('second recovery without a new outage does nothing', O.recovered(6000) === false);
O.mark(7000);
ok('recovery too soon after a reload waits', O.recovered(10000) === false && O.pending && O.down);
ok('it says how long to wait', O.retryIn(10000) === 15000);
ok('after the gap it reloads', O.recovered(25001) === true && !O.pending);

console.log('\ntexture cache');
const disposed = [];
const C = new MT.TexCache({ idleBytes: 250, hardBytes: 500, dispose: (t) => disposed.push(t) });
C.put('a', 'A', 100); C.put('b', 'B', 100); C.put('c', 'C', 100);
ok('new textures are unused', C.stats().idleBytes === 300 && C.bytes === 300);
ok('acquire takes a reference', C.acquire('a').refs === 1 && C.idle === 200);
C.put('d', 'D', 100);
C.trim();
ok('over the idle limit the oldest unused goes', !C.has('b') && C.has('a') && disposed.join() === 'B');
C.get('c');                       // c is now the most recently used
C.put('e', 'E', 100);
C.trim();
ok('LRU order follows use', !C.has('d') && C.has('c') && disposed.join() === 'B,D');
C.release('a');
ok('release makes it unused again', C.map.get('a').refs === 0 && C.idle === 300);
C.release('a');
ok('extra release is ignored', C.map.get('a').refs === 0 && C.idle === 300);
['a', 'c', 'e'].forEach((k) => C.acquire(k));
C.put('f', 'F', 100); C.put('g', 'G', 100); C.acquire('f'); C.acquire('g');
const over = C.trim();
ok('textures in use are never evicted', ['a', 'c', 'e', 'f', 'g'].every((k) => C.has(k)));
ok('trim reports when used textures alone exceed the hard limit', over === false && C.bytes === 500);
C.put('h', 'H', 100);
ok('a new unused texture over the hard limit is evicted', C.trim() === false && !C.has('h'));
C.acquire('a'); C.put('i', 'I', 100); C.acquire('i');
ok('used textures over the hard limit: trim says so', C.trim() === true);
const before = disposed.length;
C.put('i', 'I', 100);
ok('putting the same texture again changes nothing', disposed.length === before && C.map.get('i').refs === 1);
C.clear();
ok('clear disposes everything once', C.map.size === 0 && C.bytes === 0 && C.idle === 0 &&
   new Set(disposed).size === disposed.length);

console.log('\nwiring');
const mapping = fs.readFileSync(path.join(TPL, 'assets', 'js', 'mapping.js'), 'utf8');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
ok('index.html loads vt_map_tiles.js before mapping.js',
   html.indexOf('vt_map_tiles.js') > 0 && html.indexOf('vt_map_tiles.js') < html.indexOf('/mapping.js'));
ok('mapping.js uses the shared texture cache', /new VTMapTiles\.TexCache/.test(mapping));
ok('mapping.js takes the detail cap from VTMapTiles.zoomCap', /VTMapTiles\.zoomCap\(/.test(mapping));
ok('M3-A: base stand-ins keyed by alignment, other sources dropped',
   /VTMapTiles\.layerKey\(/.test(mapping) && /f\.src !== set\.src\.id/.test(mapping));
ok('M3-B: reconnect reloads only suspects (failed / white tiles)',
   /_tileSuspect/.test(mapping) && !/addEventListener\('offline'/.test(mapping) && !/'rosdisconnected'/.test(mapping) &&
   /_tileOutage\('error', url\)/.test(mapping) && /_tileOutage\('white', url\)/.test(mapping) &&
   /if \(!this\._tileSuspect\.size\) \{ return; \}/.test(mapping));
ok('N1: every texture release keeps the idle limit', /_texRelease\(url\) \{\s*this\._texCache\(\)\.release\(url\);\s*this\._texTrimSoon\(\);/.test(mapping) &&
   (mapping.match(/\.release\(/g) || []).length === 2);
ok('mapping.js shares the phone budget (baseShare, overlayWant)',
   /VTMapTiles\.baseShare\(/.test(mapping) && /VTMapTiles\.overlayWant\(/.test(mapping));
ok('mapping.js aims the background map with baseWant, overlays keep zAdaptive',
   /VTMapTiles\.baseWant\(zExact,/.test(mapping) && /plan\(src, CAP, zBase\)/.test(mapping) &&
   /VTMapTiles\.overlayWant\(zAdaptive, o,/.test(mapping));
ok('mapping.js skips the white fill and reloads after an outage',
   /VTMapTiles\.isBlankWhite\(/.test(mapping) && /addEventListener\('online'/.test(mapping) &&
   /'rosconnected'/.test(mapping) && /VTMapTiles\.withBust\(/.test(mapping));
ok('mapping.js no longer disposes textures per plane', !/material\.map && m\.material\.map\.dispose/.test(mapping));
const zsel = (html.match(/<select[^>]*id="mapv3_aerial_zoom"[\s\S]*?<\/select>/) || [''])[0];
ok('detail defaults to auto', /<option value="auto" selected/.test(zsel));
ok('manual caps z17 … z21 kept', ['17', '18', '19', '20', '21'].every((z) => zsel.indexOf('value="' + z + '"') > 0));
ok('no area select in the panel (coverage follows the view)', html.indexOf('id="mapv3_aerial_area"') < 0);

// T17 M11: the first retry of a partial failure after 3 s, otherwise 15 / 30 / 60 s as before
ok('retry: full failure 15 s → 30 s → 60 s → 60 s (unchanged)', MT.retryDelay(0, false) === 15000 && MT.retryDelay(15000, false) === 30000 &&
   MT.retryDelay(30000, false) === 60000 && MT.retryDelay(60000, false) === 60000);
ok('retry: partial failure first after 3 s, then 15 s on', MT.retryDelay(0, true) === 3000 && MT.retryDelay(3000, true) === 15000 && MT.retryDelay(15000, true) === 30000);
ok('M11: only the quick try asks past the 10 s no-hammering window, within its own rebuild (behaviour: tools/test_tile_retry.node.js)',
   /this\._tileRetryAt && fAt <= this\._tileRetryAt && Date\.now\(\) - this\._tileRetryAt < 1500/.test(mapping) && /if \(this\._tileRetryFast\) \{ this\._tileRetryAt = Date\.now\(\); \}/.test(mapping));
ok('M11: a hung tile fails once no tile came for TILE_TIMEOUT_MS (behaviour: tools/test_tile_retry.node.js)', MT.TILE_TIMEOUT_MS === 20000 && /VTMapTiles\.TILE_TIMEOUT_MS \|\| 20000/.test(mapping) && /this\._tileProgressAt \|\| 0/.test(mapping));
ok('mapping.js: partial = some tiles came and at most a quarter failed for real (timed-out tiles not counted)', /this\._tileRetrySoon\(set\.loaded > 0 && \(set\.failed - hung\) \* 4 <= set\.total, bad\)/.test(mapping));

console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ': ' + failures.join('; ') : 'OK — all checks passed'));
process.exit(failures.length ? 1 : 0);
