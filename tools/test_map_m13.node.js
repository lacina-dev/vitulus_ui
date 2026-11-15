#!/usr/bin/env node
/*
 * T17 batch M13: the alignment offset measured against the ČÚZK orthophoto.
 *     node tools/test_map_m13.node.js
 *   - a MEASURED offset is absolute: "Align Google to ČÚZK" (tileAlignShift,
 *     browser option vitulus_align_etrs89) is not added to it — in the map
 *     (base and overlays), in the zone pictures (vt_map_thumbs.js goes through
 *     the same _alignShift) — while maps without a measurement look exactly as
 *     before (option on/off x no record / set by hand / measured);
 *   - the option stays and says when it has no effect (Map › Display and the
 *     layers panel);
 *   - a measured offset tried on (before Save) is shown without the option's
 *     shift, "Show before" shows the stored state again, nothing is stored
 *     until Save, Save goes through POST /api/tile_offsets {source: measured};
 *   - a nudge keeps a measured offset measured (marked adjusted), a nudge of
 *     anything else is "manual"; a reset drops the record;
 *   - the measured shift in words; the i18n keys en + cs.
 * The code under test is sliced out of mapping.js verbatim (the seam of
 * tools/test_tile_offsets.node.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
const SRC = fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8');
let fails = 0;
function check(name, ok, info) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + (typeof info === 'string' ? info : JSON.stringify(info))));
    if (!ok) { fails++; }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
function sliceAt(start) {
    let depth = 0;
    const open = SRC.indexOf('{', start);
    for (let j = open; j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; } else if (SRC[j] === '}') { depth--; if (!depth) { return SRC.slice(start, j + 1); } }
    }
    throw new Error('braces');
}
function fn(name) {
    const i = SRC.indexOf('function ' + name + '(');
    if (i < 0) { throw new Error(name + ' not in mapping.js'); }
    return sliceAt(i);
}
function method(name) {
    const i = SRC.indexOf('\n    ' + name + '(');
    if (i < 0) { throw new Error('method ' + name + ' not in mapping.js'); }
    return sliceAt(i + 1);
}
const cLine = /const ALIGN_ETRS89_EN = \{ e: (-?[0-9.]+), n: (-?[0-9.]+) \};/.exec(SRC);
const posts = [];
const H = new Function('posts',
    'const TILE_OFFSET_MAX_M = 50.0;\n' + cLine[0] + '\n' +
    ['tileOffsetGet', 'tileOffsetClamp', 'tileOffsetNudge', 'tileOffsetPut', 'tileOffsetFormat', 'tileOffsetMeta',
     'tileOffsetMeasured', 'tileShiftParts', 'tileAlignShift'].map(fn).join('\n') + '\n' +
    'function mapT(k) { return k; }\n' +
    'const M = {\n' + ['_aerialLayerId', '_alignShift', '_alignIneffective', '_currentTileOffset', '_applyAerialOffset',
                       '_georefChanged', '_mapTrueYaw', '_nudgeTileOffset', '_resetTileOffset', '_measureClose'].map(method).join(',\n') + '\n};\n' +
    'return { M, tileOffsetMeta, tileOffsetMeasured, tileShiftParts, tileAlignShift };')(posts);

// the robot's store as it is on the owner's robot today (M13 not deployed) and
// as it will be after the director re-saves 10_2026/sat as measured
const LEGACY = {
    '10_2026': { sat: { dx: 1.43, dy: -0.24 }, bing: { dx: -0.4, dy: 0.47 }, cuzk: { dx: 0.7, dy: 0 } },
    'Nmap': { sat: { dx: 1.2, dy: -0.2 }, cuzk: { dx: 0.9, dy: 1.2 } },
};
const MEASURED = JSON.parse(JSON.stringify(LEGACY));
MEASURED['10_2026'].sat = { dx: 0.7, dy: -0.95 };
const META = { '10_2026': { sat: { src: 'measured', ts: 1794700000 }, bing: { src: 'measured', ts: 1794700000 } } };

function ctx(store, meta, map, layer, alignOn) {
    const c = Object.assign({}, H.M, {
        tile_offsets: JSON.parse(JSON.stringify(store)), tile_offsets_meta: JSON.parse(JSON.stringify(meta || {})),
        tile_offset_map: map, sel_aerial_src: { value: layer }, _alignEtrs: alignOn,
        aerial_datum: { yaw_rad: 0 },     // north-up, no origin: true yaw 0
        aerial_group: { position: { x: 0, y: 0, z: -0.3 } },
        ov_layers: { ruian: { group: { position: { x: 0, y: 0 } }, src: { offset_key: 'cuzk' } },
                     glabels: { group: { position: { x: 0, y: 0 } }, src: { offset_key: 'sat' } } },
        _measPreview: null, el_meas_res: { hidden: false }, el_tile_off_val: null,
        _updateAlignNote() {}, _updateTileOffsetReadout() {}, _tileOffsetStatus() {},
        _queueTileOffsetPost(layer_, off) { posts.push({ layer: layer_, off: off }); },
    });
    return c;
}
function shown(c) { c._applyAerialOffset(); return [c.aerial_group.position.x, c.aerial_group.position.y]; }
const at = (p, x, y) => near(p[0], x) && near(p[1], y);

// ---- the six combinations (option on/off x none / by hand / measured) -----------
let p;
p = shown(ctx({}, {}, 'New', 'sat', false));
check('option off, no record: no shift (as before)', at(p, 0, 0), p);
p = shown(ctx({}, {}, 'New', 'sat', true));
check('option on, no record: the estimate -0.73 / -0.71 (as before)', at(p, -0.73, -0.71), p);
p = shown(ctx(LEGACY, {}, 'Nmap', 'sat', false));
check('option off, set by hand (Nmap 1.2 / -0.2): the stored offset (as before)', at(p, 1.2, -0.2), p);
p = shown(ctx(LEGACY, {}, 'Nmap', 'sat', true));
check('option on, set by hand (Nmap): stored + estimate = 0.47 / -0.91 (as before: tuned with the option on)', at(p, 0.47, -0.91), p);
p = shown(ctx(LEGACY, {}, '10_2026', 'sat', true));
check('option on, 10_2026 as stored today (1.43 / -0.24, by hand): 0.70 / -0.95 (as before)', at(p, 0.70, -0.95), p);
p = shown(ctx(MEASURED, META, '10_2026', 'sat', true));
check('option on, measured (10_2026 0.70 / -0.95): the stored offset alone, nothing added', at(p, 0.70, -0.95), p);
p = shown(ctx(MEASURED, META, '10_2026', 'sat', false));
check('option off, measured: the same picture in every browser', at(p, 0.70, -0.95), p);
p = shown(ctx(MEASURED, META, 'Nmap', 'sat', true));
check('a measurement of one map leaves another map alone (Nmap still stored + estimate)', at(p, 0.47, -0.91), p);
p = shown(ctx(MEASURED, { '10_2026': { sat: { src: 'manual', ts: 5 } } }, '10_2026', 'sat', true));
check('a record marked "manual" gets the estimate like a record without meta', at(p, 0.70 - 0.73, -0.95 - 0.71), p);
p = shown(ctx({}, { 'Z': { sat: { src: 'measured', ts: 5 } } }, 'Z', 'sat', true));
check('a measured ZERO offset (meta, no entry): no shift even with the option on', at(p, 0, 0), p);
p = shown(ctx(MEASURED, META, '10_2026', 'bing', true));
check('Bing never gets the estimate (measured or not)', at(p, -0.4, 0.47) && at(shown(ctx(LEGACY, {}, '10_2026', 'bing', true)), -0.4, 0.47), p);
let c = ctx(MEASURED, META, '10_2026', 'cuzk', true);
c._applyAerialOffset();
check('overlays: Google-group overlay of a measured map without the estimate, ČÚZK overlays by their own offset',
      at([c.ov_layers.glabels.group.position.x, c.ov_layers.glabels.group.position.y], 0.70, -0.95) &&
      at([c.ov_layers.ruian.group.position.x, c.ov_layers.ruian.group.position.y], 0.7, 0));
c = ctx(LEGACY, {}, 'Nmap', 'cuzk', true);
c._applyAerialOffset();
check('overlays: Google-group overlay of a hand-set map keeps stored + estimate',
      at([c.ov_layers.glabels.group.position.x, c.ov_layers.glabels.group.position.y], 0.47, -0.91));
check('_alignIneffective: only the measured key of the shown map',
      ctx(MEASURED, META, '10_2026', 'sat', true)._alignIneffective('sat') === true &&
      ctx(MEASURED, META, 'Nmap', 'sat', true)._alignIneffective('sat') === false &&
      ctx(LEGACY, {}, '10_2026', 'sat', true)._alignIneffective('sat') === false &&
      ctx(MEASURED, META, '', 'sat', true)._alignIneffective('sat') === false);
// the zone pictures (vt_map_thumbs.js) take the same two calls
const thumbs = fs.readFileSync(path.join(JS, 'vt_map_thumbs.js'), 'utf8');
check('vt_map_thumbs.js: offset = _currentTileOffset() + _alignShift(_aerialLayerId()) of mapping.js (no own rule)',
      /off = m\._currentTileOffset\(\) \|\| off;/.test(thumbs) && /var a = m\._alignShift\(m\._aerialLayerId\(\)\);/.test(thumbs) &&
      !/ALIGN_ETRS89|tileAlignShift|vitulus_align_etrs89/.test(thumbs));
c = ctx(MEASURED, META, '10_2026', 'sat', true);
let o = c._currentTileOffset(), a = c._alignShift(c._aerialLayerId());
check('  so a zone picture of a measured map is drawn at 0.70 / -0.95 with the option on', at([o.dx + a.dx, o.dy + a.dy], 0.70, -0.95));
c = ctx(LEGACY, {}, 'Nmap', 'sat', true);
o = c._currentTileOffset(); a = c._alignShift(c._aerialLayerId());
check('  and one of a hand-set map at stored + estimate', at([o.dx + a.dx, o.dy + a.dy], 0.47, -0.91));
check('the option itself is unchanged: off by default, browser only, the same constant',
      /this\._layerPref\('vitulus_align_etrs89', false\)/.test(SRC) && cLine[1] === '-0.73' && cLine[2] === '-0.71' &&
      near(H.tileAlignShift(true, 'sat', 0).dx, -0.73) && H.tileAlignShift(false, 'sat', 0).dx === 0);

// ---- the option says when it has no effect ------------------------------------------
check('Map › Display: a note under the option, shown by _alignIneffective("sat")',
      /id="mapv3_align_etrs_note"/.test(SRC) && /mapT\('mapping\.m13\.align_off'\)/.test(SRC) &&
      /const off = this\._alignIneffective\('sat'\);\s*note\.hidden = !off;/.test(SRC));
const layers = fs.readFileSync(path.join(JS, 'vt_map_layers.js'), 'utf8');
check('layers panel: the switch stays, its state slot and hint say "no effect here"',
      /ovRow\('align', 'mapv3_align_etrs'/.test(layers) && /M13\._alignIneffective\('sat'\)/.test(layers) &&
      /t\('maplyr\.m13\.align_off'\)/.test(layers) && /'maplyr\.m13\.align_off_hint' : 'maplyr\.m9\.align_hint'/.test(layers));

// ---- trying a measured offset on -------------------------------------------------------
c = ctx(LEGACY, {}, '10_2026', 'sat', true);
c._measPreview = { map: '10_2026', layer: 'sat', dx: 0.70, dy: -0.97, on: true };
p = shown(c);
check('a measured offset tried on: shown alone (0.70 / -0.97), the option adds nothing', at(p, 0.70, -0.97), p);
c._measPreview.on = false;
p = shown(c);
check('"Show before": the stored state again (1.43 / -0.24 + estimate)', at(p, 0.70, -0.95), p);
check('  the store mirror is untouched by the trial', c.tile_offsets['10_2026'].sat.dx === 1.43 && !c.tile_offsets_meta['10_2026']);
c._measPreview.on = true;
c.sel_aerial_src.value = 'bing';
p = shown(c);
check('a trial of one layer does not move another', at(p, -0.4, 0.47), p);
c.sel_aerial_src.value = 'sat';
c._measureClose();
p = [c.aerial_group.position.x, c.aerial_group.position.y];
check('Cancel: back to the stored state, the result hidden', c._measPreview === null && at(p, 0.70, -0.95) && c.el_meas_res.hidden === true, p);
const save = method('_measureSave'), start = method('_measureStart');
check('Save: POST /api/tile_offsets with source "measured" (the usual store route)',
      /fetch\('\/api\/tile_offsets', \{/.test(save) && /dx: p\.dx, dy: p\.dy, source: 'measured'/.test(save));
check('measuring itself stores nothing: one POST to /api/tile_offsets/measure with {map, layer}',
      /fetch\('\/api\/tile_offsets\/measure'/.test(start) && /body: JSON\.stringify\(\{ map: map, layer: layer \}\)/.test(start) &&
      !/fetch\('\/api\/tile_offsets',/.test(start) && !/fetch\('\/api\/tile_offsets',/.test(method('_measureShow')));
check('an answer that is not JSON (a robot older than the page: 404 page) is "no_route", not "robot unreachable"',
      /r\.json\(\)\.catch\(\(\) => \(/.test(start) && /reason: \(r\.status === 404 \|\| r\.status === 405\) \? 'no_route' : 'other'/.test(start));
const show = method('_measureShow');
check('the result says how much the shift differs around the map (quality.windows / spread_m), no "within" promise',
      /q\.windows/.test(show) && /q\.spread_m/.test(show) && /mapT\('mapping\.m13\.spread', \{ n: nwin, spread: this\._measM\(spread\) \}\)/.test(show) &&
      /mapT\('mapping\.m13\.spread_one'\)/.test(show) && !/after:/.test(show));
check('reasons of their own: empty tiles, missing libraries, an old robot',
      /blank: \(\) => mapT\('mapping\.m13\.why_blank'\)/.test(show) && /no_libs: \(\) => mapT\('mapping\.m13\.why_no_libs'\)/.test(show) &&
      /no_route: \(\) => mapT\('mapping\.m13\.why_no_route'\)/.test(show));
// T17 M14: the button is switched off through _updateMeasureButton (also aria-busy), the map / datum
// condition moved from _measurable to _measBlock (the button then stays, off, with the reason);
// behaviour: tools/test_map_m14.node.js
check('one measurement at a time in the page, the button disabled meanwhile',
      /if \(this\._measBusy \|\| !this\._measurable\(\)\) \{ return; \}/.test(start) && /this\._updateMeasureButton\(\);/.test(start) &&
      /this\.btn_meas\.disabled = !!this\._measBusy \|\| !!block;/.test(method('_updateMeasureButton')));
const can = method('_measSource');
check('the button is hidden for ČÚZK\'s own group and drawn maps; without a map it is off (M14)',
      /key !== 'cuzk'/.test(can) && /baseIsPhoto\(src\)/.test(can) && /if \(!this\.tile_offset_map\) \{ return 'no_map'; \}/.test(method('_measBlock')) &&
      /this\.btn_meas\.hidden = !src;/.test(method('_updateMeasureButton')));

// ---- nudging and resetting ---------------------------------------------------------------
c = ctx(MEASURED, META, '10_2026', 'sat', true);
posts.length = 0;
c._nudgeTileOffset(0.1, 0);
check('a nudge of a measured offset: stays measured (absolute), marked adjusted, date kept',
      near(c.tile_offsets['10_2026'].sat.dx, 0.8) && c.tile_offsets_meta['10_2026'].sat.src === 'measured' &&
      c.tile_offsets_meta['10_2026'].sat.adj === true && c.tile_offsets_meta['10_2026'].sat.ts === 1794700000 &&
      at(shown(c), 0.8, -0.95) && posts.length === 1);
c = ctx(LEGACY, {}, 'Nmap', 'sat', true);
c._nudgeTileOffset(0, 0.1);
check('a nudge of a hand-set offset: manual, the estimate still added (no jump)',
      c.tile_offsets_meta.Nmap.sat.src === 'manual' && at(shown(c), 0.47, -0.81));
c = ctx(LEGACY, {}, '10_2026', 'sat', true);
c._measPreview = { map: '10_2026', layer: 'sat', dx: 0.70, dy: -0.97, on: true };
c._nudgeTileOffset(0.1, 0);
check('a nudge during a trial ends the trial and starts from the STORED offset',
      c._measPreview === null && near(c.tile_offsets['10_2026'].sat.dx, 1.53) && c.tile_offsets_meta['10_2026'].sat.src === 'manual');
global.fetch = () => ({ then() { return { then() { return { catch() {} }; } }; } });
c = ctx(MEASURED, META, '10_2026', 'sat', true);
c._resetTileOffset(false);
check('Reset layer drops the offset and its "measured" record: the option applies again',
      !c.tile_offsets['10_2026'].sat && !c.tile_offsets_meta['10_2026'].sat && c.tile_offsets_meta['10_2026'].bing &&
      at(shown(c), -0.73, -0.71));
c = ctx(MEASURED, META, '10_2026', 'sat', true);
c._resetTileOffset(true);
check('Reset all drops every record of the map', !c.tile_offsets['10_2026'] && !c.tile_offsets_meta['10_2026']);

// ---- meta helpers, words ------------------------------------------------------------------
check('tileOffsetMeta: junk reads as "no record"', H.tileOffsetMeta(null, 'a', 'b') === null && H.tileOffsetMeta({ a: { b: { src: 'guess' } } }, 'a', 'b') === null &&
      H.tileOffsetMeta({ a: 5 }, 'a', 'b') === null && H.tileOffsetMeasured({ a: { b: { src: 'measured' } } }, 'a', 'b') === true &&
      H.tileOffsetMeasured({ a: { b: { src: 'manual' } } }, 'a', 'b') === false);
const parts = (e, n) => H.tileShiftParts(e, n).map((x) => x.m.toFixed(2) + x.dir).join(' ');
check('words: Google 0.97 m north', parts(0.0, 0.97) === '0.97n', parts(0.0, 0.97));
check('words: Bing 1.04 m east and 0.53 m south (the larger part first)', parts(1.04, -0.53) === '1.04e 0.53s', parts(1.04, -0.53));
check('words: west / south, under 5 cm left out, nothing = on ČÚZK', parts(-0.2, -0.61) === '0.61s 0.20w' && parts(0.04, 0.3) === '0.30n' &&
      parts(0.02, -0.03) === '' && parts(NaN, 0.5) === '0.50n');

// ---- i18n ------------------------------------------------------------------------------------
function dict(file) {
    const s = fs.readFileSync(path.join(JS, 'i18n', file), 'utf8');
    const out = {};
    const re = /^\s*"((?:mapping|maplyr)\.m13\.[a-z_0-9.]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm;
    let m;
    while ((m = re.exec(s))) { out[m[1]] = m[2]; }
    return out;
}
const en = dict('en.js'), cs = dict('cs.js');
const used = Array.from(new Set((SRC + layers).match(/'(?:mapping|maplyr)\.m13\.[a-z_0-9.]+'/g) || [])).map((k) => k.slice(1, -1));
const ph = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join(',');
check('i18n: ' + Object.keys(en).length + ' M13 keys, en + cs, the same placeholders',
      Object.keys(en).length >= 44 && Object.keys(en).every((k) => cs[k] !== undefined && ph(en[k]) === ph(cs[k])) &&
      Object.keys(cs).every((k) => en[k] !== undefined));
check('i18n: every M13 key used in the code exists, every key is used',
      used.every((k) => en[k] !== undefined) && Object.keys(en).every((k) => used.indexOf(k) >= 0),
      used.filter((k) => en[k] === undefined).concat(Object.keys(en).filter((k) => used.indexOf(k) < 0)));
check('i18n: the option\'s hint says it is an estimate and that a measured map does not get it (en + cs)',
      (() => {
          const g = (f, k) => new RegExp('"' + k.replace(/\./g, '\\.') + '": "([^"]*)"').exec(fs.readFileSync(path.join(JS, 'i18n', f), 'utf8'))[1];
          return /estimate/.test(g('en.js', 'mapping.m9.align_hint')) && /measured offset no longer gets/.test(g('en.js', 'mapping.m9.align_hint')) &&
                 /odhad/.test(g('cs.js', 'mapping.m9.align_hint')) && /změřeným posunem/.test(g('cs.js', 'mapping.m9.align_hint'));
      })());
check('i18n: no promise of exactness ("already exact", "after saving within")',
      !/already exact|už přesný/.test(Object.values(en).concat(Object.values(cs)).join(' ')) &&
      !/\{after\}/.test(en['mapping.m13.ba'] + cs['mapping.m13.ba']) && /compromise/.test(en['mapping.m13.spread']) && /kompromis/.test(cs['mapping.m13.spread']));
const css = fs.readFileSync(path.join(ROOT, 'nodes', 'templates', 'assets', 'css', 'vt_map_layers.css'), 'utf8');
check('touch: the measure buttons are 40 px high on a phone',
      /@media \(pointer: coarse\) \{\s*\.vt-meas-btn \{ min-height: 40px;/.test(css));

console.log(fails ? '\nFAILED ' + fails : '\nall checks passed');
process.exit(fails ? 1 : 0);
