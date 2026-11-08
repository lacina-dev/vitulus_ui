#!/usr/bin/env node
/*
 * The scale bar on the map (assets/js/vt_map_scale.js, T17 M8-1):
 *     node tools/test_map_scale.node.js
 * Checks without a browser:
 *   - index.html loads the module (after the layers button), its CSS exists;
 *   - the module sends nothing (no fetch / XHR / WebSocket / ROSLIB / topic);
 *   - niceScale: always a round 1-2-5 × 10^n distance, the longest that fits,
 *     1 cm … 50 km, the bar length = distance / metres per pixel;
 *   - metersPerPx from the camera (FOV, distance, canvas height);
 *   - labels in en and cs (cm / m / km, decimal comma in cs, no-break space);
 *   - every i18n key it names exists in en.js and cs.js with the same placeholders;
 *   - the rain time label moves up by the bar's height (vt_panel.css).
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

const src = fs.readFileSync(path.join(JS, 'vt_map_scale.js'), 'utf8');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
const iLayers = html.indexOf('<script src="/assets/js/vt_map_layers.js"></script>');
const iScale = html.indexOf('<script src="/assets/js/vt_map_scale.js"></script>');
check('index.html loads vt_map_scale.js (after vt_map_layers.js)', iScale > 0 && iScale > iLayers);
const css = fs.readFileSync(path.join(TPL, 'assets', 'css', 'vt_map_layers.css'), 'utf8');
check('the bar has its CSS (vt_map_layers.css .vt-map-scale)', /\.vt-map-scale \{/.test(css) && /pointer-events: none/.test(css));
const panelCss = fs.readFileSync(path.join(TPL, 'assets', 'css', 'vt_panel.css'), 'utf8');
check('the rain time label sits above the bar (--vt-map-scale-h)', /\.vt-map-precip \{[^}]*var\(--vt-map-scale-h, 0px\)/.test(panelCss));

const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
['fetch(', 'XMLHttpRequest', 'WebSocket', 'ROSLIB', '.publish(', 'callService', 'sendBeacon', 'localStorage'].forEach((w) => {
    check('sends / stores nothing: no ' + w, !code.includes(w));
});

const S = require(path.join(JS, 'vt_map_scale.js'));
const round = (m) => { const e = Math.pow(10, Math.floor(Math.log10(m) + 1e-9)); const k = Math.round(m / e); return [1, 2, 5].includes(k) && Math.abs(k * e - m) < 1e-9 * Math.max(1, m); };
let bad = [];
for (let mpp = 0.0002; mpp < 2000; mpp *= 1.37) {
    for (const maxPx of [48, 80, 120]) {
        const r = S.niceScale(mpp, maxPx);
        if (!r || !round(r.m)) { bad.push('round ' + mpp + '/' + maxPx + ' ' + JSON.stringify(r)); continue; }
        if (r.m < S.MIN_M || r.m > S.MAX_M) { bad.push('range ' + mpp); continue; }
        if (Math.abs(r.px - r.m / mpp) > 1e-6) { bad.push('px ' + mpp); continue; }
        const inRange = mpp * maxPx >= S.MIN_M && mpp * maxPx <= S.MAX_M * 2;
        // fits, and the next round step would not
        if (inRange && r.px > maxPx + 1e-6) { bad.push('fit ' + mpp + '/' + maxPx + ' ' + r.px); continue; }
        if (inRange && r.m < S.MAX_M) {
            const steps = [1, 2, 5, 10];
            const e = Math.pow(10, Math.floor(Math.log10(r.m) + 1e-9)), k = Math.round(r.m / e);
            const next = steps[steps.indexOf(k) + 1] * e;
            if (next / mpp <= maxPx - 1e-6) { bad.push('longest ' + mpp + '/' + maxPx + ' ' + r.m); }
        }
    }
}
check('niceScale: round 1-2-5 distances, the longest that fits, 1 cm … 50 km', !bad.length, bad.slice(0, 5).join(' | '));
check('niceScale: 0.2 m/px, 100 px → 20 m', JSON.stringify(S.niceScale(0.2, 100)) === JSON.stringify({ m: 20, px: 100 }));
check('niceScale: 30 m/px, 100 px → 2 km', S.niceScale(30, 100).m === 2000);
check('niceScale: very far out stops at 50 km', S.niceScale(5000, 100).m === 50000);
check('niceScale: no scale without numbers', S.niceScale(0, 100) === null && S.niceScale(NaN, 100) === null && S.niceScale(1, 0) === null);
const fov = 1.37, h = 800;
check('metersPerPx: 2·d·tan(fov/2)/h', Math.abs(S.metersPerPx(fov, 1000, h) - 2 * 1000 * Math.tan(fov * Math.PI / 360) / h) < 1e-12);
check('metersPerPx: 0 for a bad camera', S.metersPerPx(0, 10, 100) === 0 && S.metersPerPx(1, -1, 100) === 0);

// i18n
const win = {};
const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
const D = win.VT_I18N_DICT;
const keys = new Set([...code.matchAll(/t\('([a-z0-9_]+\.[a-z0-9_.]*[a-z0-9_])'/g)].map((m) => m[1]));
['mapscale.m', 'mapscale.cm', 'mapscale.km'].forEach((k) => keys.add(k));
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
const missEn = [...keys].filter((k) => !(k in D.en)), missCs = [...keys].filter((k) => !(k in D.cs));
check('every key in en.js (' + keys.size + ')', !missEn.length, missEn.join(', '));
check('every key in cs.js', !missCs.length, missCs.join(', '));
check('same placeholders en / cs', [...keys].every((k) => !(k in D.en) || ph(D.en[k]) === ph(D.cs[k])));
const tr = (l) => (k, v) => D[l][k].replace(/\{(\w+)\}/g, (m, n) => v[n]);
check('labels en: 50 cm, 20 m, 2 km, 1.5 km', S.label(0.5, tr('en'), 'en') === '50 cm' && S.label(20, tr('en'), 'en') === '20 m' &&
      S.label(2000, tr('en'), 'en') === '2 km' && S.label(1500, tr('en'), 'en') === '1.5 km');
check('labels cs: decimal comma, no-break space', S.label(1500, tr('cs'), 'cs') === '1,5 km' && S.label(0.02, tr('cs'), 'cs') === '2 cm');

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
