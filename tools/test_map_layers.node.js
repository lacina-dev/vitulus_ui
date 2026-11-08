#!/usr/bin/env node
/*
 * The layers button on the map (assets/js/vt_map_layers.js, T17 M5):
 *     node tools/test_map_layers.node.js
 * Checks without a browser:
 *   - index.html loads the module and its stylesheet;
 *   - the module sends nothing (no fetch / XHR / WebSocket / ROSLIB / topic)
 *     and only drives the Map tab controls (#mapv3_…), which stay the one
 *     place of truth;
 *   - every i18n key it names exists in en.js and cs.js, with the same
 *     {placeholders};
 *   - names split into name + provider for every base of the shipped catalog
 *     (docker-mapproxy ui_sources.json, MAPPROXY_REPO first) and a date never
 *     breaks at its hyphen;
 *   - "new" marks: the 14 sources of batch M1 (docker-mapproxy 5b6240f) are
 *     not new, later ones (Wayback, CENIA, relief x10/x20, aspect, DMP) are,
 *     and nothing is new until the catalog came from the robot;
 *   - the editor is recognised without map_menu.editor_holds() (it arms the
 *     editor's "close twice" guard);
 *   - weather overlays of the catalog (precip) go under Weather.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const TPL = path.join(ROOT, 'nodes', 'templates');
const JS = path.join(TPL, 'assets', 'js');
let fails = 0;
function check(name, ok, info) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !info ? '' : ' — ' + info));
    if (!ok) { fails++; }
}

const src = fs.readFileSync(path.join(JS, 'vt_map_layers.js'), 'utf8');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
check('index.html loads vt_map_layers.js', html.includes('<script src="/assets/js/vt_map_layers.js"></script>'));
check('index.html loads vt_map_layers.css', html.includes('href="assets/css/vt_map_layers.css"'));
check('the stylesheet exists', fs.existsSync(path.join(TPL, 'assets', 'css', 'vt_map_layers.css')));

const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
['fetch(', 'XMLHttpRequest', 'WebSocket', 'ROSLIB', '.publish(', 'callService', 'sendBeacon'].forEach((w) => {
    check('sends nothing: no ' + w, !code.includes(w));
});
check('does not call map_menu.editor_holds() (side effects)', !code.includes('editor_holds'));
check('recognises the editor by MapEditor.controller().active', code.includes('MapEditor.controller().active'));
check('arrows of the map picker stop propagating (never reach the keyboard driving)', /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/.test(code));
const joy = fs.readFileSync(path.join(JS, 'vt_joy.js'), 'utf8');
check('vt_joy.js: a keydown some widget used or a radio / tab widget never starts driving',
      /e\.defaultPrevented \|\| navWidget\(e\.target\)/.test(joy) && /radiogroup/.test(joy));
check('vt_joy.js: keyup is not filtered (a released key always stops)',
      !/keyup[\s\S]{0,200}(defaultPrevented|navWidget)/.test(joy));
check('precip (T20) counts as weather', /o\.id === 'precip'/.test(code));
const ids = (code.match(/\$\('([a-z0-9_]+)/g) || []).map((m) => m.slice(3));
const foreign = ids.filter((id) => !/^(mapv3_|vt_lyr_|vt_utm_rose$|btn_map$|mapedit_sec_layers$)/.test(id));
check('only Map tab controls (#mapv3_…) and its own elements', !foreign.length, foreign.join(', '));

// i18n
const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = win.VT_I18N_DICT;
const keys = new Set([...code.matchAll(/(?<![\w.])t\('([a-z0-9_]+\.[a-z0-9_.]*[a-z0-9_])'/g)].map((m) => m[1]));
['kn', 'ruian', 'contours', 'hillshade', 'relief_x10', 'relief_x20', 'slope', 'aspect', 'surface_relief', 'rain']
    .forEach((id) => keys.add('maplyr.hint.' + id));
['n', 'e', 's', 'w'].forEach((d) => keys.add('maplyr.m8.asp.' + d));      // M8-6: the wheel's letters
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
const missEn = [...keys].filter((k) => !(k in D.en));
const missCs = [...keys].filter((k) => !(k in D.cs));
const badPh = [...keys].filter((k) => k in D.en && k in D.cs && ph(D.en[k]) !== ph(D.cs[k]));
check('every key in en.js (' + keys.size + ')', !missEn.length, missEn.join(', '));
check('every key in cs.js', !missCs.length, missCs.join(', '));
check('same placeholders en / cs', !badPh.length, badPh.join(', '));

// the module's pure helpers, in a tiny fake DOM
function load(store, catalog) {
    const els = {};
    const fakeEl = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, appendChild() {}, querySelector() { return null; },
        querySelectorAll() { return []; }, hidden: false });
    const document = {
        readyState: 'complete', body: fakeEl(), documentElement: fakeEl(),
        getElementById: (id) => els[id] || null,
        createElement: () => fakeEl(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    };
    els.mapv3_aerial_src = { value: 'cuzk' };
    const w = {
        document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
        mapping_v3: { map_sources: catalog }, addEventListener() {}, innerWidth: 1000, innerHeight: 800,
    };
    w.window = w;
    vm.runInContext(fs.readFileSync(path.join(JS, 'vt_map_sources.js'), 'utf8'), vm.createContext(w));
    w.VTMapSources = w.window.VTMapSources;
    const c2 = vm.createContext(Object.assign(w, { getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame() {},
        MutationObserver: function () { this.observe = () => {}; }, setInterval: () => 0, clearInterval() {}, CustomEvent: function () {}, Event: function () {} }));
    vm.runInContext(src, c2);
    return w;
}

const candidates = [process.env.MAPPROXY_REPO, path.join(ROOT, '..', 'docker-mapproxy'), path.join(ROOT, '..', '..', 'docker-mapproxy'),
                    path.join(ROOT, '..', '..', '..', 'catkin_ws', 'src', 'docker-mapproxy'), '/home/vitulus/catkin_ws/src/docker-mapproxy']
    .filter(Boolean).map((p) => path.join(p, 'mapproxy_configuration', 'ui_sources.json'));
const catFile = candidates.find((f) => fs.existsSync(f));
const MS = require(path.join(JS, 'vt_map_sources.js'));
const cat = catFile ? MS.normalize(JSON.parse(fs.readFileSync(catFile, 'utf8'))) : MS.fallback();
console.log('catalog: ' + (catFile || 'built-in fallback') + ' (' + cat.bases.length + ' bases, ' + cat.overlays.length + ' overlays)');

const w = load({}, cat);
const L = w.window.VTMapLayers;
check('module loads and exposes VTMapLayers', !!L);
const sp = L._splitName;
check('"Satellite (Google)" -> name + provider', JSON.stringify(sp('Satellite (Google)')) === JSON.stringify(['Satellite', 'Google']));
check('a name without provider stays whole', JSON.stringify(sp('Orthophoto ČÚZK')) === JSON.stringify(['Orthophoto ČÚZK', '']));
check('a date keeps its hyphen together', sp('Esri archive 2025-04 (Wayback)')[0] === 'Esri archive 2025‑04');
const emptyNames = [];
cat.bases.concat(cat.overlays).forEach((s) => ['en', 'cs'].forEach((l) => { if (!sp(MS.label(s, l))[0].trim()) { emptyNames.push(s.id + '/' + l); } }));
check('every catalog source has a name to show (en, cs)', !emptyNames.length, emptyNames.join(', '));
if (cat.byId.cenia_1950s) { check('the 1950s orthophoto is a photo base', cat.byId.cenia_1950s.group === 'photo'); }

const fresh = L._newIds(cat);
const M1 = ['sat', 'sat_hybrid', 'cuzk', 'esri', 'bing', 'gmap', 'ztm', 'otm', 'osm', 'kn', 'ruian', 'contours', 'hillshade', 'slope'];
check('the 14 sources of batch M1 are not new', M1.every((id) => !fresh.includes(id)), fresh.filter((id) => M1.includes(id)).join(','));
const LATER = ['esri_wb_2025_04', 'esri_wb_2023_06', 'esri_wb_2022_04', 'cenia_1950s', 'relief_x10', 'relief_x20', 'aspect', 'surface_relief']
    .filter((id) => cat.byId[id]);
check('later sources are new (' + LATER.length + ')', LATER.every((id) => fresh.includes(id)), LATER.filter((id) => !fresh.includes(id)).join(','));
check('the chosen base is not new', !fresh.includes('cuzk'));
if (cat.fromCatalog && cat.bases.length > 3) { check('a source added later is new', fresh.length > 0, fresh.join(',')); }
const w2 = load({}, MS.fallback());
check('nothing is new before the catalog came', w2.window.VTMapLayers._newIds(MS.fallback()).length === 0);
const w3 = load({ vitulus_layers_seen: JSON.stringify(cat.bases.concat(cat.overlays).map((s) => s.id)) }, cat);
check('nothing is new once all were seen', w3.window.VTMapLayers._newIds(cat).length === 0);

// ---- T17 M8: thumbnails, background state, aspect legend, rain time line
const tp = L._thumbPlan;
const p = tp(14.35, 50.0817, 17, 32, 0.5);   // public test point (park Ladronka)
check('M8-3 thumbnail: the tile under the point (z17)', p && p.z === 17 && p.x === 70760 && p.y === 44406, JSON.stringify(p));
check('M8-3 thumbnail: half-size tile, position inside the tile', p && p.bg === 128 && p.px <= 0 && p.px >= 32 - 128 && p.py <= 0 && p.py >= 32 - 128);
const mid = tp((70760.5 / 131072) * 360 - 180, 50.0817, 17, 32, 0.5);
check('M8-3 thumbnail: a point mid-tile sits in the middle of the box', mid && Math.abs(mid.px - (16 - 64)) <= 1, JSON.stringify(mid));
check('M8-3 thumbnail: no plan for a bad point', tp(NaN, 50, 17, 34, 0.5) === null && tp(14, 89, 17, 34, 0.5) === null);
check('M8-3 thumbnail: the tile URL comes from mapping.js (same URL, same cache as the map)', /M\._aerialTileUrl\(src, p\.z, p\.x, p\.y\)/.test(code));
check('M8-3 thumbnail: a CSS background (no fetch, nothing new to the robot)', /backgroundImage = 'url\("/.test(code));
check('M8-3 thumbnail: 32 px = the inside of the 34 px box (1 px border)', /THUMB_PX = 32/.test(code));
check('M8-3 thumbnail: the zoom never above the source\'s max', /Math\.min\(THUMB_Z, src\.max_zoom/.test(code));
check('M8-5 background state read from mapping.js _baseLoad (event vt:map-tiles)', code.includes('_baseLoad') && code.includes("'vt:map-tiles'"));
const mapping = fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8');
check('M8-5 mapping.js publishes the state (no other change of the tile code)', /this\._baseLoad = \{ n: n, k: k, f: f, state: lsig \}/.test(mapping) && /new CustomEvent\('vt:map-tiles'/.test(mapping));
check('M8-6 aspect legend: 8 colours from north clockwise', Array.isArray(L.ASPECT_STOPS) && L.ASPECT_STOPS.length === 8 && L.ASPECT_STOPS.every((c) => /^#[0-9a-f]{6}$/.test(c)));
check('M8-2 the one rain time line (#mapv3_precip) moves in and back home', code.includes("$('mapv3_precip')") && /function tlDetach/.test(code) && /tlDetach\(\);\s*bodyEl\.innerHTML/.test(code));
check('M8-2 the labels under the slider are fitted again after a move (_fixTicks)', /function tlRefit/.test(code) && /P\._fixTicks\(\)/.test(code));
check('M8-2 closing the panel puts the time line back', /isOpen = false;\s*tlDetach\(\);/.test(code));
check('M8-2 a slot only for a catalog overlay with a time line', /o\.timeline \? '<div class="vt-lyr-tl" data-lyr-tl="/.test(code));

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
