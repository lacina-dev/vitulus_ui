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

console.log('\nsources without data (T40, service status no_data)');
const nd = JSON.parse(JSON.stringify(INDEX));
nd.sources[1] = Object.assign(nd.sources[1], { last_error: null, status: 'no_data',
    no_data: { since: '2026-11-08T07:00Z', reason: 'the provider lists no files', next_check: '2026-11-08T09:40Z' } });
const ndi = P.parseIndex(nd);
ok('no_data parsed with since', ndi.byId.opera.noData === true && ndi.byId.opera.noDataSince === T0 - 8100);
ok('no data is not a failure', P.failing(ndi).length === 0);
ok('no data named', P.noData(ndi).length === 1 && P.noData(ndi)[0].name === 'EUMETNET OPERA');
ok('older service (no status): nothing named', P.noData(idx).length === 0);

console.log('\nrain around the garden (T40 check, index.rain_nearby)');
const rIdx = (rn) => P.parseIndex(Object.assign({}, INDEX, { rain_nearby: rn }));
ok('dry: no rain within the radius', P.rainText(rIdx({ radius_km: 150, nearest_rain_km: null, covered_fraction: 0.9 })) === 'mapt.precip.rain_none');
ok('rain far: nearest rain', P.rainText(rIdx({ radius_km: 150, nearest_rain_km: 25, covered_fraction: 0.9 })) === 'mapt.precip.rain_near');
ok('rain close: raining around the garden', P.rainText(rIdx({ radius_km: 150, nearest_rain_km: 5, covered_fraction: 0.9 })) === 'mapt.precip.rain_here');
ok('no radar coverage / older service: nothing said', P.rainText(rIdx({ radius_km: 150, nearest_rain_km: null, covered_fraction: 0.1 })) === '' && P.rainText(idx) === '');

console.log('\nplayback plan + order (T40)');
ok('few tiles: every frame', P.plan(49, 24, 4, 900).length === 49);
const pl = P.plan(49, 24, 25, 900);          // 25 tiles a frame, 900 tiles -> every 2nd
ok('many tiles: a stride, within the limit (+ last)', pl.length <= 36 + 1 && pl.length >= 24, pl.length);
ok('the stride keeps "now" and the last frame', pl.indexOf(24) >= 0 && pl[pl.length - 1] === 48);
ok('ascending, no duplicates', pl.every((v, i) => !i || v > pl[i - 1]));
const ph = P.plan(49, 24, 25, 360);          // a phone
ok('phone: fewer frames, still now + last', ph.length <= 360 / 25 + 2 && ph.indexOf(24) >= 0 && ph[ph.length - 1] === 48, ph);
ok('no frames -> empty plan', P.plan(0, -1, 4, 100).length === 0);
const ep = (sh) => Array.from({ length: 49 }, (_, i) => T0 + (i + sh) * 300);
const pa = P.plan(49, 24, 25, 450, ep(0)), pb = P.plan(49, 24, 25, 450, ep(1));
const fa = new Set(pa.map((i) => ep(0)[i])), fb = pb.map((i) => ep(1)[i]);
ok('stride on the clock: an index one frame later keeps the frames', fb.filter((e) => fa.has(e)).length >= fb.length - 3);
ok('stride on the clock: still now + last', pb.indexOf(24) >= 0 && pb[pb.length - 1] === 48);
const pc = P.plan(46, 22, 15, 240, ep(0).slice(0, 46)), pd = P.plan(49, 24, 15, 240, ep(0));
const fc = new Set(pc.map((i) => ep(0)[i]));
ok('a shorter index (46 frames) keeps the stride: the same frames', pd.map((i) => ep(0)[i]).filter((e) => e <= ep(0)[45] && !fc.has(e)).length <= 2);
const okAll = () => true;
ok('next frame after i', P.nextReady(5, 1, okAll) === 2);
ok('after the last: back to the first (loop)', P.nextReady(5, 4, okAll) === 0);
ok('skips frames not loaded', P.nextReady(6, 1, (j) => j === 4) === 4);
ok('nothing else loaded: -1 (stay)', P.nextReady(5, 2, (j) => j === 2) === -1);
ok('next one still loading: stay (no jump back to the start)', P.nextReady(6, 3, (j) => (j === 4 ? 'pending' : 'ready')) === -1);
ok('a skipped frame is passed over', P.nextReady(6, 3, (j) => (j === 4 ? 'skip' : 'ready')) === 5);
ok('frames ready ahead (skips not counted)', P.leadReady(6, 0, (j) => (j === 3 ? 'pending' : j === 1 ? 'skip' : 'ready')) === 2);

console.log('\nTimeline playback order (no DOM)');
function tl(hooks) {
    const t = new P.Timeline(Object.assign({ mount: null }, hooks || {}));
    t.idx = P.parseIndex(INDEX);            // 3 radar (latest = 2) + 2 nowcast
    t.selId = t.idx.frames[2].id; t.follow = true;
    return t;
}
function step(t, n) {                       // n steps, time moved past each wait
    const seen = [];
    for (let s = 0; s < n; s++) { t._t0 -= 5000; t._warmT -= 60000; t._tick(); seen.push(P.find(t.idx, t.selId)); }
    clearInterval(t._play);
    return seen;
}
let t1 = tl();
t1.play();
clearInterval(t1._play);
ok('▶ from "now": starts at the oldest frame (−10 min here, −2 h live)', P.find(t1.idx, t1.selId) === 0);
const seq = step(t1, 6);                     // the first tick ends the (empty) preload wait
ok('then through now into the nowcast, then loops', seq.join() === '0,1,2,3,4,0');
let t2 = tl();
t2.selId = t2.idx.frames[3].id; t2.follow = false;
t2.play(); clearInterval(t2._play);
ok('▶ on a frame picked by hand goes on from there', P.find(t2.idx, t2.selId) === 3);
let tw = tl();
tw._fetchedMs = Date.now() - 6 * 60000;          // the index came 6 min ago: the oldest frame is gone by now
tw.idx.generatedEpoch = Math.floor(Date.now() / 1000) - 6 * 60;
tw._fetch = () => {};
tw.play(); clearInterval(tw._play);
ok('▶ skips the frame the service may have dropped since the index', P.find(tw.idx, tw.selId) >= 1 && tw._frameIn(0) === 'skip');
// T40b: the window moves with the service's NEWEST observation (+5 min + latency)
let tv = tl();
tv._fetchedMs = Date.now();
tv.idx.generatedEpoch = tv.idx.latestEpoch + 180;           // newest 3 min old: nothing dropped yet
ok('newest 3 min old: every frame live', tv.liveFrom() === 0 && tv.frameLive(tv.idx.frames[0].id));
tv.idx.generatedEpoch = tv.idx.latestEpoch + 420;           // 7 min: a new one may be in, the oldest gone
ok('newest 7 min old: the oldest frame is not asked any more', tv.liveFrom() === 1 && !tv.frameLive(tv.idx.frames[0].id));
tv.markGone(tv.idx.frames[1].id);
ok('a frame 404 said gone: not live, skipped', !tv.frameLive(tv.idx.frames[1].id) && tv._frameIn(1) === 'skip' && tv.liveFrom() === 2);
ok('a frame not in the index: not live', !tv.frameLive('2020-01-01T00:00Z'));
// preload: wait (warm), then only frames that are in
let ls = { k: 0, n: 3, full: false };
const inSet = new Set([0, 2]);
let t3 = tl({ loadState: () => ls, frameReady: (f) => inSet.has(P.find(t3.idx, f.id)) });
t3.play(); clearInterval(t3._play);
t3._t0 -= 5000; t3._tick();
ok('while it preloads: no step (warm)', P.find(t3.idx, t3.selId) === 0 && t3._warm === true);
ls = { k: 3, n: 3, full: false };
const s3 = step(t3, 4);
ok('preloaded: steps only through frames that are in', s3.join() === '0,2,0,2', s3);
let t4 = tl({ loadState: () => ({ k: 2, n: 9, full: false }), frameReady: () => true });
t4.play(); clearInterval(t4._play);
t4._warmT -= 9000; t4._tick();
ok('slow preload: plays what is in after the wait (4 s)', t4._warm === false);
// the loader is behind: the playback waits at the edge, then goes on
const st6 = ['ready', 'ready', 'pending', 'pending', 'pending'];
let t6 = tl({ loadState: () => ({ k: 2, n: 5, full: false }), frameState: (f) => st6[P.find(t6.idx, f.id)] });
t6.play(); clearInterval(t6._play);
const s6 = step(t6, 4);
ok('loader behind: steps to the edge and waits there', s6.join() === '0,1,1,1', s6);
st6[2] = 'ready';
ok('… and goes on once the next frame is in', step(t6, 1).join() === '2');
let calls = 0;
let t5 = tl({ beforePlay: () => { calls++; }, prepare: () => { calls += 10; } });
t5.play(); clearInterval(t5._play);
ok('▶ asks to zoom out (beforePlay) and to preload (prepare)', calls === 11);
t5.pause();
ok('pause stops', !t5.playing && !t5._play);

console.log('\nPreload (blobs, limits, waiters)');
(async () => {
    const asked = [];
    const urls = { a: ['a1', 'a2'], b: ['b1', 'b2'], c: ['c1', 'c2'] };
    let fail = new Set(['b2']);
    const pre = new P.Preload({
        conc: 2, maxBytes: 0,
        get: (u) => { asked.push(u); return fail.has(u) ? Promise.reject(new Error('x')) : Promise.resolve({ size: 1000 }); },
        mkUrl: (b) => 'blob:' + asked.length, revoke: () => {},
    });
    const jobs = (ids) => ids.map((id) => ({ id: id, urls: urls[id] }));
    let woke = 0;
    pre.want('k1', jobs(['a', 'b', 'c']));
    ok('a tile on its way is pending', pre.pending('a1'));
    pre.whenDone('a1', () => { woke++; });
    await new Promise((r) => setTimeout(r, 20));
    ok('every tile asked once', asked.length === 6 && new Set(asked).size === 6, asked);
    ok('waiter woken when it came', woke === 1);
    ok('frames ready (a failed tile counts as done)', pre.frameReady('a') && pre.frameReady('b') && pre.frameReady('c'));
    ok('blob URL of a loaded tile, none for a failed one', pre.url('a1') && pre.url('b2') === null);
    ok('progress k/n', pre.progress().k === 3 && pre.progress().n === 3 && pre.progress().bytes === 5000);
    ok('frame state: ready / skip (not planned)', pre.frameState('a') === 'ready' && pre.frameState('zz') === 'skip');
    pre.want('k2', jobs(['b', 'c']));
    ok('a new view keeps what it needs (nothing asked again)', asked.length === 6 && pre.url('b1') && !pre.url('a1'));
    ok('bytes of dropped tiles freed', pre.progress().bytes === 3000);
    const small = new P.Preload({ conc: 1, maxBytes: 1500, get: () => Promise.resolve({ size: 1000 }), mkUrl: () => 'blob:x' });
    small.want('s', jobs(['a', 'b']));
    await new Promise((r) => setTimeout(r, 20));
    ok('byte limit: stops loading, says full', small.progress().full && small.progress().k === 1, small.progress());
    ok('byte limit: the frames that will not load are skipped', small.frameState('a') === 'ready' && small.frameState('b') === 'skip');
    pre.clear();
    ok('clear: nothing kept', pre.items.size === 0 && pre.progress().n === 0);

    console.log('\nPreload: new versions, frames gone, service down (T40 check)');
    let gate = {};
    let asked2 = [], gone = 0, down = 0;
    const p2 = new P.Preload({
        conc: 4, maxBytes: 0,
        get: (u) => { asked2.push(u); return gate[u] ? gate[u] : Promise.resolve({ size: 10 }); },
        mkUrl: (b) => 'blob:' + Math.random(), revoke: () => {},
        onGone: () => { gone++; }, onDown: () => { down++; },
    });
    p2.want('v1', [{ id: 'n1', v: 'a', urls: ['n1a'] }, { id: 'n2', v: 'a', urls: ['n2a'] }]);
    await new Promise((r) => setTimeout(r, 10));
    ok('two frames in', p2.progress().k === 2);
    let release;
    gate.n1b = new Promise((r) => { release = r; }).then(() => ({ size: 10 }));
    p2.want('v2', [{ id: 'n1', v: 'b', urls: ['n1b'] }, { id: 'n2', v: 'a', urls: ['n2a'] }]);
    await new Promise((r) => setTimeout(r, 10));
    ok('new nowcast run: the old version stays drawable meanwhile', p2.frameReady('n1') && p2.useV('n1') === 'a' && p2.url('n1a'));
    ok('… progress does not fall back', p2.progress().k === 2);
    ok('unchanged frame not asked again', asked2.filter((u) => u === 'n2a').length === 1);
    release();
    await new Promise((r) => setTimeout(r, 10));
    ok('new version in: drawn, the old one dropped', p2.useV('n1') === 'b' && !p2.items.has('n1a'));
    gate.g1 = Promise.reject({ status: 404 });
    gate.g1.catch(() => {});
    p2.want('v3', [{ id: 'g', v: 'a', urls: ['g1'] }, { id: 'n2', v: 'a', urls: ['n2a'] }]);
    await new Promise((r) => setTimeout(r, 10));
    ok('a frame the service no longer has (404): skipped + new index asked', p2.frameState('g') === 'skip' && gone === 1);
    const before = asked2.length;
    gate = { d1: Promise.reject({ net: true }), d2: Promise.reject({ net: true }), d3: Promise.reject({ net: true }) };
    Object.values(gate).forEach((x) => x.catch(() => {}));
    const p3 = new P.Preload({ conc: 1, maxBytes: 0, get: (u) => { asked2.push(u); return gate[u]; }, mkUrl: () => 'b', onDown: () => { down++; } });
    p3.want('d', [{ id: 'd', v: 'a', urls: ['d1', 'd2', 'd3'] }]);
    await new Promise((r) => setTimeout(r, 10));
    ok('service down: one request, then it stops and says so', asked2.length - before === 1 && down === 1 && p3.progress().down);
    ok('… the frame is still to load (not failed)', p3.frameState('d') === 'pending' && !p3.pending('d1'));
    gate = {};
    p3.resume();
    await new Promise((r) => setTimeout(r, 10));
    ok('resume: loads again', p3.frameReady('d'));

    console.log('\nT40b: one late tile, a frame gone on one tile, stride on a phone');
    let lateDown = 0, lateTries = 0;
    const g5 = {};
    const p5 = new P.Preload({ conc: 2, maxBytes: 0, mkUrl: () => 'b', onDown: () => { lateDown++; },
        get: (u) => { if (u === 'l2') { lateTries++; return lateTries === 1 ? Promise.reject({ net: true, timeout: true }) : Promise.resolve({ size: 5 }); }
                      return g5[u] || Promise.resolve({ size: 5 }); } });
    p5.RETRY_MS = 20;
    p5.want('l', [{ id: 'L', v: 'a', urls: ['l1', 'l2', 'l3'] }]);
    await new Promise((r) => setTimeout(r, 10));
    ok('a tile without an answer (20 s): the frame plays on, no "down"', p5.frameState('L') === 'ready' && lateDown === 0 && !p5.progress().down);
    await new Promise((r) => setTimeout(r, 60));
    ok('… and is tried again later in the background', lateTries === 2 && p5.url('l2') === 'b');
    g5.x2 = Promise.reject({ status: 404 }); g5.x2.catch(() => {});
    let goneId = null;
    p5.o.onGone = (id) => { goneId = id; };
    p5.want('x', [{ id: 'X', v: 'a', urls: ['x1', 'x2', 'x3'] }]);
    await new Promise((r) => setTimeout(r, 10));
    ok('one tile 404: the whole frame is gone (skipped), its id reported', p5.frameState('X') === 'skip' && goneId === 'X' && p5.isGone('x2'));
    const phone = P.plan(46, 22, 15, 360, ep(0).slice(0, 46));
    const gaps = phone.slice(1).map((v, i) => v - phone[i]);
    ok('phone (15 tiles a frame, 360): every third frame (15 min), as the help says', gaps.filter((g) => g === 3).length >= gaps.length - 3);
    finish();
})();

function finish() {
console.log('');
if (failures.length) {
    console.log(failures.length + ' check(s) FAILED');
    process.exit(1);
}
console.log('all checks passed');
}
