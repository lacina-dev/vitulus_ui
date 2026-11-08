#!/usr/bin/env node
/*
 * Map source catalog (vt_map_sources.js) — the list of MapProxy base maps and
 * overlays the Map tab and the map editor offer.
 *
 *     node tools/test_map_sources.node.js
 *     MAPPROXY_REPO=~/vitulus/wt/docker-mapproxy/<task> node tools/test_map_sources.node.js
 *
 * Checks the pure helpers (validation, fallback, mapping of old stored
 * choices, tile URL, credits, base groups) and the shipped catalog: that
 * docker-mapproxy's ui_sources.json is valid and every layer it names exists
 * in mapproxy.yaml. The catalog is looked up in MAPPROXY_REPO first, then
 * docker-mapproxy beside this repo in the catkin workspace (src/ or its
 * parent), then the robot's path. In a git WORKTREE (e.g. ~/vitulus/wt/...)
 * none of the relative paths match: set MAPPROXY_REPO to the docker-mapproxy
 * checkout that belongs to the change, otherwise the catalog part is skipped
 * with a note (the rest still runs).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const MS = require(path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js',
                             'vt_map_sources.js'));

const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(66) + (cond ? 'ok' : 'FAIL'));
}

console.log('map source catalog (node harness)');

console.log('\nfallback');
const fb = MS.fallback();
ok('fallback has the three old bases', fb.bases.map((b) => b.id).join() === 'sat,cuzk,osm');
ok('fallback has no overlays', fb.overlays.length === 0);
ok('fallback default is satellite', fb.default_base === 'sat');
ok('fallback is marked as not from the catalog', fb.fromCatalog === false);

console.log('\nvalidation');
const cat = MS.normalize({
    default_base: 'cuzk',
    sources: [
        { id: 'sat', kind: 'base', layer: 'gm_layer', grid: 'gm_grid', name: { en: 'Sat', cs: 'Satelit' }, max_zoom: 99 },
        { id: 'cuzk', kind: 'base', layer: 'cuzk_layer', grid: 'gm_grid', name: 'Ortho', attribution: '© ČÚZK' },
        { id: 'ztm', kind: 'base', layer: 'cuzk_ztm_layer', grid: 'gm_grid', format: 'jpeg', offset_key: 'cuzk', attribution: '© ČÚZK' },
        { id: 'hs', kind: 'overlay', layer: 'cuzk_hillshade_layer', grid: 'gm_grid', layer_order: 'under' },
        { id: 'kn', kind: 'overlay', layer: 'cuzk_kn_layer', grid: 'gm_grid', min_zoom: 16, max_zoom: 20, layer_order: 'sideways',
          default_opacity: 3, attribution: { en: 'Cadastre © ČÚZK', cs: 'Katastr © ČÚZK' } },
        { id: 'sat', kind: 'base', layer: 'dup', grid: 'gm_grid' },                 // duplicate id
        { id: 'Bad Id', kind: 'base', layer: 'x', grid: 'gm_grid' },                // bad id
        { id: 'evil', kind: 'base', layer: '../../etc', grid: 'gm_grid' },          // bad layer
        null,
    ],
});
ok('valid entries kept, bad / duplicate dropped', Object.keys(cat.byId).join() === 'sat,cuzk,ztm,hs,kn');
ok('bases and overlays split', cat.bases.length === 3 && cat.overlays.length === 2);
ok('layer_order under kept', cat.byId.hs.layer_order === 'under');
ok('unknown layer_order -> over', cat.byId.kn.layer_order === 'over');
ok('max_zoom clamped to z21', cat.byId.sat.max_zoom === 21);
ok('max_zoom default 19', cat.byId.cuzk.max_zoom === 19);
ok('string name becomes en+cs', cat.byId.cuzk.name.en === 'Ortho' && cat.byId.cuzk.name.cs === 'Ortho');
ok('missing name falls back to the id', cat.byId.ztm.name.en === 'ztm');
ok('format jpeg kept, default png', cat.byId.ztm.format === 'jpeg' && cat.byId.sat.format === 'png');
ok('overlay opacity clamped to 0..1', cat.byId.kn.default_opacity === 1);
ok('overlay min_zoom kept', cat.byId.kn.min_zoom === 16);
ok('offset_key defaults to the id', cat.byId.sat.offset_key === 'sat' && cat.byId.ztm.offset_key === 'cuzk');
ok('default_base honoured', cat.default_base === 'cuzk');
ok('no bases at all -> fallback', MS.normalize({ sources: [{ id: 'kn', kind: 'overlay', layer: 'a', grid: 'b' }] }).bases.length === 3);
ok('garbage -> fallback', MS.normalize('nope').fromCatalog === false);

console.log('\noverlay look (T17 M2)');
const lk = MS.normalize({ sources: [
    { id: 'sat', kind: 'base', layer: 'gm_layer', grid: 'gm_grid', blend: 'multiply', halo: true },
    { id: 'hillshade', kind: 'overlay', layer: 'a', grid: 'g', layer_order: 'under' },
    { id: 'slope', kind: 'overlay', layer: 'b', grid: 'g', layer_order: 'under', blend_neutral: 0.5 },
    { id: 'ruian', kind: 'overlay', layer: 'c', grid: 'g', layer_order: 'over' },
    { id: 'kn', kind: 'overlay', layer: 'd', grid: 'g', layer_order: 'over', halo: false },
    { id: 'tone', kind: 'overlay', layer: 'e', grid: 'g', layer_order: 'under', blend: 'normal', recolor: 'red' },
    { id: 'lines', kind: 'overlay', layer: 'f', grid: 'g', recolor: '#00FF00', blend_neutral: [2, -1, 'x'] },
] });
ok('under -> multiply by default', lk.byId.hillshade.blend === 'multiply');
ok('over -> normal by default', lk.byId.ruian.blend === 'normal' && lk.byId.lines.blend === 'normal');
ok('catalog blend wins over layer_order', lk.byId.tone.blend === 'normal');
ok('built-in relief neutral (DMR 5G grey) and gain', lk.byId.hillshade.blend_neutral.join() === '0.72,0.72,0.72' &&
   lk.byId.hillshade.blend_gain === 2 && lk.byId.slope.blend_gain === 1);
ok('catalog neutral wins, a number -> grey', lk.byId.slope.blend_neutral.join() === '0.5,0.5,0.5');
ok('neutral clamped to 0.05..1, junk -> 1', lk.byId.lines.blend_neutral.join() === '1,0.05,1');
ok('RÚIAN recoloured + halo by default', lk.byId.ruian.recolor === '#a8c8ff' && lk.byId.ruian.halo === true);
ok('catalog halo false wins', lk.byId.kn.halo === false);
ok('recolor must be #rrggbb (lower case)', lk.byId.tone.recolor === '' && lk.byId.lines.recolor === '#00ff00');
ok('bases carry no look', lk.byId.sat.blend === undefined && lk.byId.sat.halo === undefined);

console.log('\nbase groups (picker)');
const gcat = MS.normalize({ sources: [
    { id: 'm1', kind: 'base', group: 'map', layer: 'a', grid: 'g' },
    { id: 'p1', kind: 'base', group: 'photo', layer: 'b', grid: 'g' },
    { id: 'x1', kind: 'base', group: 'weird', layer: 'c', grid: 'g' },
    { id: 'p2', kind: 'base', group: 'photo', layer: 'd', grid: 'g' },
    { id: 'o1', kind: 'overlay', group: 'photo', layer: 'e', grid: 'g' },
] });
const gg = MS.baseGroups(gcat);
ok('groups in fixed order photo, map, ungrouped last', gg.map((g) => g.group).join() === 'photo,map,');
ok('catalog order kept inside a group', gg[0].sources.map((b) => b.id).join() === 'p1,p2');
ok('unknown group -> ungrouped', gcat.byId.x1.group === '' && gg[2].sources[0].id === 'x1');
ok('overlays carry no group', gcat.byId.o1.group === '');
ok('catalog without groups = one plain list', MS.baseGroups(cat).length === 1 && MS.baseGroups(cat)[0].group === '');
ok('fallback bases are grouped', MS.baseGroups(fb).map((g) => g.group).join() === 'photo,map');

console.log('\nstored choice -> base');
ok('known id kept', MS.resolveBase(cat, 'ztm') === 'ztm');
ok('old label "satellite" -> sat', MS.resolveBase(cat, 'satellite') === 'sat');
ok('old layer name "cuzk_layer" -> cuzk', MS.resolveBase(cat, 'cuzk_layer') === 'cuzk');
ok('unknown -> default', MS.resolveBase(cat, 'bing') === 'cuzk');
ok('overlay id is not a base -> default', MS.resolveBase(cat, 'kn') === 'cuzk');
ok('nothing stored -> default', MS.resolveBase(cat, null) === 'cuzk');
ok('old "osm" not in this catalog -> default', MS.resolveBase(cat, 'osm') === 'cuzk');

console.log('\nlabels, URLs, credits');
ok('label in cs', MS.label(cat.byId.sat, 'cs') === 'Satelit');
ok('label falls back to en', MS.label(cat.byId.sat, 'de') === 'Sat');
ok('tile URL', MS.tileUrl('h:8082', cat.byId.ztm, 19, 1, 2) === 'http://h:8082/wmts/cuzk_ztm_layer/gm_grid/19/1/2.jpeg');
ok('credits once each, in order', MS.attribution([cat.byId.cuzk, cat.byId.ztm, cat.byId.kn]) === '© ČÚZK · Cadastre © ČÚZK');
ok('no credits -> empty', MS.attribution([cat.byId.sat]) === '');
ok('credits in cs', MS.attribution([cat.byId.cuzk, cat.byId.kn], 'cs') === '© ČÚZK · Katastr © ČÚZK');

console.log('\nshipped catalog (docker-mapproxy in the workspace)');
const ws = path.resolve(__dirname, '..', '..', '..');       // .../src
const candidates = [process.env.MAPPROXY_REPO, path.join(ws, 'docker-mapproxy'), path.join(path.dirname(ws), 'docker-mapproxy'),
                    '/home/vitulus/catkin_ws/src/docker-mapproxy'];
const repo = candidates.find((p) => p && fs.existsSync(path.join(p, 'mapproxy_configuration', 'ui_sources.json')));
if (!repo) {
    console.log('  (skipped: docker-mapproxy/mapproxy_configuration/ui_sources.json not found)');
} else {
    const raw = JSON.parse(fs.readFileSync(path.join(repo, 'mapproxy_configuration', 'ui_sources.json'), 'utf8'));
    const shipped = MS.normalize(raw);
    ok('catalog parses and has bases', shipped.fromCatalog && shipped.bases.length > 0);
    ok('every entry is valid (none dropped)', Object.keys(shipped.byId).length === raw.sources.length);
    ok('the old ids sat / cuzk / osm are still there',
       ['sat', 'cuzk', 'osm'].every((id) => shipped.byId[id] && shipped.byId[id].kind === 'base'));
    ok('every entry has en + cs names', raw.sources.every((s) => s.name && s.name.en && s.name.cs));
    ok('every base has a group (photo / map)', shipped.bases.every((b) => b.group === 'photo' || b.group === 'map'));
    ok('default base exists and is a base', shipped.byId[raw.default_base] && shipped.byId[raw.default_base].kind === 'base');
    ok('every overlay states its layer_order', raw.sources.every((s) => s.kind !== 'overlay' ||
       s.layer_order === 'under' || s.layer_order === 'over'));
    const yml = fs.readFileSync(path.join(repo, 'mapproxy_configuration', 'mapproxy.yaml'), 'utf8');
    raw.sources.forEach((s) => {
        ok('layer ' + s.layer + ' is in mapproxy.yaml',
           new RegExp('-\\s*name:\\s*' + s.layer + '\\s*(#.*)?$', 'm').test(yml));
    });
}

console.log('');
if (failures.length) {
    console.log(failures.length + ' check(s) FAILED');
    process.exit(1);
}
console.log('all checks passed');
