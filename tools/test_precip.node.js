#!/usr/bin/env node
/*
 * Precipitation mosaic time line (vt_precip.js, T20 E2) — the pure part:
 * index.json of the precip-mosaic service -> frames (observations + nowcast),
 * the frame to show after new data, data state (ok / stale / down), tile URLs
 * with the frame signature, legend bins and the credits of one frame.
 *
 *     node tools/test_precip.node.js
 *
 * The index below has the shape vitulus_precip serves (recorded 2026-11-08 on
 * a public point, shortened). The DOM part is checked in Chrome by
 * tools/test_precip_ui.py.
 */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js', 'vt_precip.js'));

const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(66) + (cond ? 'ok' : 'FAIL'));
}

const T0 = 1794129300;   // 2026-11-08T09:15Z
function fr(i, kind, srcs, extra) {
    const e = T0 + i * 300;
    const id = new Date(e * 1000).toISOString().slice(0, 16) + 'Z';
    return Object.assign({ id: id, kind: kind, time: id, epoch: e, run_time: kind === 'nowcast' ? '2026-11-08T09:25Z' : null,
                           stale: false, sources: srcs.map((s) => ({ id: s, time: id, age_s: 0, kind: kind })),
                           attribution: srcs.map((s) => ({ chmi: '© ČHMÚ (opendata.chmi.cz)', opera: '© EUMETNET OPERA (CC BY 4.0)',
                                                           rainviewer: 'Weather data by RainViewer' })[s]),
                           tiles: '/tiles/' + id + '/{z}/{x}/{y}.png' }, extra || {});
}
const INDEX = {
    version: 1, generated: '2026-11-08T09:27Z', mode: { world: null, area: { radius_km: 150.0, zoom: [3, 8] } },
    slot_s: 300, latest: '2026-11-08T09:25Z', legend: '/legend.json',
    // out of order on purpose + one bad id
    frames: [fr(1, 'obs', ['chmi', 'opera', 'rainviewer']), fr(0, 'obs', ['chmi', 'opera']), fr(2, 'obs', ['chmi', 'rainviewer']),
             fr(3, 'nowcast', ['chmi']), fr(4, 'nowcast', ['chmi']), { id: '../etc', kind: 'obs', epoch: T0 }],
    sources: [
        { id: 'rainviewer', name: 'RainViewer', attribution: 'Weather data by RainViewer', attribution_url: 'https://www.rainviewer.com/', last_error: null },
        { id: 'opera', name: 'EUMETNET OPERA', attribution: '© EUMETNET OPERA (CC BY 4.0)', attribution_url: 'https://eumetnet.github.io/openradardata-documentation/', last_error: 'HTTP 503' },
        { id: 'chmi', name: 'ČHMÚ radar', attribution: '© ČHMÚ (opendata.chmi.cz)', attribution_url: 'javascript:alert(1)', last_error: null },
    ],
};
const LEGEND = { unit: 'mm/h', dry_below_mmh: 0.1,
    rain: [[0.1, 0.2], [0.2, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 5], [5, 8], [8, 12], [12, 20], [20, 30], [30, 50], [50, 80], [80, 120], [120, null]]
        .map((b, i) => ({ min_mmh: b[0], max_mmh: b[1], rgba: [i * 10, 100, 200, 150] })),
    snow: [{ min_mmh: 0.1, max_mmh: 1, rgba: [235, 235, 255, 150] }, { min_mmh: 1, max_mmh: null, rgba: [90, 20, 170, 250] }],
    mixed: [], nodata_rgba: [128, 128, 128, 70] };

console.log('precipitation time line (node harness)');

console.log('\nindex');
const idx = P.parseIndex(INDEX);
ok('frames parsed, bad id dropped', idx && idx.frames.length === 5);
ok('frames sorted by time', idx.frames.every((f, i) => !i || f.epoch > idx.frames[i - 1].epoch));
ok('kinds obs / nowcast', idx.frames.map((f) => f.kind).join() === 'obs,obs,obs,nowcast,nowcast');
ok('newest observation = index 2', idx.latestIdx === 2 && idx.latestEpoch === T0 + 600);
ok('area 150 km -> whole-area view 300 km', idx.sideKm === 300);
ok('not an index -> null', P.parseIndex({ foo: 1 }) === null && P.parseIndex(null) === null);
ok('world mode (no area) -> 600 km view', P.parseIndex({ frames: [], mode: { world: { max_zoom: 4 }, area: null } }).sideKm === 600);
ok('only https source pages are linked', idx.byId.chmi.url === '' && idx.byId.rainviewer.url === 'https://www.rainviewer.com/');

console.log('\nframe signature (?v=)');
const a = P.parseIndex(INDEX).frames[2];
const moreSrc = JSON.parse(JSON.stringify(INDEX));
moreSrc.frames[2].sources.push({ id: 'opera', time: moreSrc.frames[2].id, age_s: 0, kind: 'obs' });
ok('same content -> same signature', P.parseIndex(INDEX).frames[2].v === a.v);
ok('a late source changes it', P.parseIndex(moreSrc).frames[2].v !== a.v);
const newRun = JSON.parse(JSON.stringify(INDEX));
newRun.frames[3].run_time = '2026-11-08T09:30Z';
ok('a new nowcast run changes it', P.parseIndex(newRun).frames[3].v !== idx.frames[3].v);
const turned = JSON.parse(JSON.stringify(INDEX));
turned.frames[3].kind = 'obs'; turned.frames[3].run_time = null;
ok('a nowcast slot turned observation changes it', P.parseIndex(turned).frames[3].v !== idx.frames[3].v);

console.log('\nservice signature + service clock (T20 E2 review)');
const withV = JSON.parse(JSON.stringify(INDEX));
withV.frames[2].tiles = '/tiles/' + withV.frames[2].id + '/{z}/{x}/{y}.png?v=e53ebb0c33';
const iv = P.parseIndex(withV);
ok('v taken from frames[].tiles of the index', iv.frames[2].v === 'e53ebb0c33');
ok('without ?v= in tiles: own signature as fallback', iv.frames[1].v === idx.frames[1].v && iv.frames[1].v.length > 0);
ok('vOf ignores junk', P.vOf('/t/{z}.png?v=<x>') === '' && P.vOf(null) === '');
ok('generated parsed (service clock)', idx.generatedEpoch === T0 + 720);
const fetched = 1e12;
ok('service now = generated + time since the index came',
   P.serviceNow(idx, fetched, fetched + 90000) === T0 + 720 + 90);
ok('this device clock 3 h wrong: age still from the service',
   P.state(idx, false, P.serviceNow(idx, fetched, fetched + 60000)).age === 180);
ok('older service without generated: device clock', P.serviceNow(P.parseIndex({ frames: [] }), fetched, 5000) === 5);
ok('full ISO generated also parses', P.parseIndex({ frames: [], generated: '2026-11-08T09:27:30Z' }).generatedEpoch === T0 + 750);

console.log('\nURLs');
ok('service base from the page host + catalog port', P.base('10.0.0.5', { port: 8097 }) === 'http://10.0.0.5:8097');
ok('bad port -> 8097', P.base('h', { port: 99999 }) === 'http://h:8097' && P.base('h', null) === 'http://h:8097');
const f2 = idx.frames[2];
ok('tile URL with frame id and signature',
   P.tileUrl('http://h:8097', f2, 7, 69, 43) === 'http://h:8097/tiles/2026-11-08T09:25Z/7/69/43.png?v=' + f2.v);

console.log('\nwhich frame after new data');
ok('following now -> newest observation', P.pick(idx, '2026-11-08T09:15Z', true) === 2);
ok('a chosen frame stays', P.pick(idx, '2026-11-08T09:20Z', false) === 1);
ok('a chosen frame that is gone -> nearest in time', P.pick(idx, '2026-11-08T08:00Z', false, T0 + 290) === 1);
ok('nothing chosen -> newest observation', P.pick(idx, null, false) === 2);
ok('no frames -> -1', P.pick(P.parseIndex({ frames: [] }), null, true) === -1);
ok('nowcast only -> the last frame', P.pick(P.parseIndex({ frames: [fr(3, 'nowcast', ['chmi'])] }), null, true) === 0);

console.log('\ndata state');
ok('fresh: ok + age', P.state(idx, false, T0 + 600 + 240).state === 'ok' && P.state(idx, false, T0 + 840).age === 240);
ok('older than 20 min: stale', P.state(idx, false, T0 + 600 + 21 * 60).state === 'stale');
const st = JSON.parse(JSON.stringify(INDEX)); st.frames[2].stale = true;
ok('newest marked stale by the service: stale', P.state(P.parseIndex(st), false, T0 + 700).state === 'stale');
ok('request failed: down (even with old data)', P.state(idx, true, T0).state === 'down');
ok('nothing yet: loading', P.state(null, false, T0).state === 'loading');
ok('no observation: empty', P.state(P.parseIndex({ frames: [fr(3, 'nowcast', ['chmi'])] }), false, T0).state === 'empty');
ok('minutes from the newest observation', P.relMin(idx, idx.frames[0]) === -10 && P.relMin(idx, idx.frames[4]) === 10);
ok('relative text: −2 h, +20 min', P.relText(-120) === '−2 h' && P.relText(20) === '+20 min');

console.log('\nlegend + credits');
const L = P.legend(LEGEND);
ok('rain and snow bins', L.rain.length === 14 && L.snow.length === 2);
ok('legend colour is opaque (map alpha not used)', L.rain[0].css === 'rgb(0,100,200)');
ok('open last bin keeps max null', L.rain[13].max === null);
ok('marks at 0.1 1 5 20 50 mm/h', L.marks.map((m) => m.v).join() === '0.1,1,5,20,50');
ok('marks positioned by bin', L.marks[0].pos === 0 && Math.abs(L.marks[1].pos - 3 / 14) < 1e-9);
ok('bad legend -> empty, no throw', P.legend(null).rain.length === 0);
const cr = P.credits(idx, idx.frames[0]);
ok('credits of the frame (only its sources)', cr.map((c) => c.text).join('|') === '© ČHMÚ (opendata.chmi.cz)|© EUMETNET OPERA (CC BY 4.0)');
ok('credit linked to the source page', cr[1].url.indexOf('https://eumetnet') === 0 && cr[0].url === '');
ok('nowcast frame credits ČHMÚ only', P.credits(idx, idx.frames[4]).length === 1);
ok('failing sources listed by name', P.failing(idx).join() === 'EUMETNET OPERA');

console.log('');
if (failures.length) {
    console.log(failures.length + ' check(s) FAILED');
    process.exit(1);
}
console.log('all checks passed');
