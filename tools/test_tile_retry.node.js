#!/usr/bin/env node
/*
 * Automatic retry of failed map tiles — BEHAVIOUR (mapping.js, T17 M11):
 *     node tools/test_tile_retry.node.js
 * The retry methods are sliced out of mapping.js verbatim (_tileRetrySoon,
 * _tileRetryAllOk) and run against a virtual clock: every retry rebuilds the
 * layers and a tile that keeps failing fails again. Counts the requests per
 * failing tile:
 *   - one tile failing for good in TWO layers: <= 5 requests in 90 s
 *     (a quick try after 3 s once, then 15 s, 30 s …; it used to loop every 3 s);
 *   - a tile lost once: back after the 3 s try;
 *   - a full outage (nothing loads): 15 s, 30 s, 60 s — no quick try;
 *   - waits start over only when every layer loaded completely.
 * And the hung-tile timeout of _texFetch against a fake slow MapProxy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js', 'mapping.js'), 'utf8');
const MT = require(path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js', 'vt_map_tiles.js'));
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !info ? '' : ' — ' + info)); if (!ok) { fails++; } }
function sliceMethod(name) {
    const start = SRC.indexOf('\n    ' + name + '(') + 1;
    if (start <= 0) { throw new Error(name + ' missing'); }
    let depth = 0;
    for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; } else if (SRC[j] === '}') { depth--; if (!depth) { return SRC.slice(start, j + 1); } }
    }
    throw new Error('braces');
}
// virtual clock + timers
function sim(layersSpec, secs) {
    let now = 0; const timers = [];
    const env = {
        Date: { now: () => now },
        setTimeout: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return t; },
        clearTimeout: (t) => { if (t) { t.live = false; } },
        VTMapTiles: MT,
    };
    const M = new Function('Date', 'setTimeout', 'clearTimeout', 'VTMapTiles',
        'return {' + sliceMethod('_tileRetrySoon') + ',\n' + sliceMethod('_tileRetryAllOk') + '};')(env.Date, env.setTimeout, env.clearTimeout, env.VTMapTiles);
    const req = {}; let rebuilds = 0;
    M._tileLayers = new Set();
    M._tilesWanted = () => true;
    // a layer: total tiles, the failing ones (fail always, or the first n times)
    const layers = layersSpec.map((s) => ({ s, L: { cur: null } }));
    layers.forEach((l) => M._tileLayers.add(l.L));
    function build() {
        layers.forEach(({ s, L }) => {
            let failed = 0; const tiles = new Map();
            for (let i = 0; i < s.total; i++) {
                const url = s.name + '/' + i; const bad = s.bad.indexOf(i) >= 0;
                if (bad || s.all) { req[url] = (req[url] || 0) + 1; }
                const f = (s.all || bad) && (s.failTimes === undefined || req[url] <= s.failTimes);
                tiles.set(String(i), { url, state: f ? 'err' : 'ok' });
                if (f) { failed++; }
            }
            L.cur = { total: s.total, loaded: s.total - failed, failed, tiles };
        });
        layers.forEach(({ L }) => {     // each layer's set settles (report)
            const set = L.cur;
            if (set.failed > 0) {
                const bad = []; set.tiles.forEach((t) => { if (t.state === 'err') { bad.push(t.url); } });
                M._tileRetrySoon(set.loaded > 0 && set.failed * 4 <= set.total, bad);
            } else { M._tileRetryAllOk(); }
        });
    }
    M.rebuildAerial = () => { rebuilds++; build(); };
    build();
    const tries = [];
    while (now <= secs * 1000) {
        const due = timers.filter((t) => t.live && t.at <= now);
        due.forEach((t) => { t.live = false; tries.push(now / 1000); t.fn(); });
        now += 100;
    }
    return { req, rebuilds, tries };
}

const two = sim([{ name: 'base', total: 12, bad: [3] }, { name: 'slope', total: 12, bad: [5] }], 90);
check('two layers, one tile failing for good in each: <= 5 requests per tile in 90 s',
      two.req['base/3'] <= 5 && two.req['slope/5'] <= 5, JSON.stringify(two.req) + ' tries ' + two.tries.join(','));
check('… with the quick try at 3 s first, then 15 s and 30 s', two.tries[0] === 3 && two.tries[1] === 18 && two.tries[2] === 48, two.tries.join(','));
const once = sim([{ name: 'base', total: 12, bad: [3], failTimes: 1 }], 30);
check('a tile lost once: one quick try after 3 s brings it', once.tries.length === 1 && once.tries[0] === 3 && once.req['base/3'] === 2, once.tries.join(','));
const out = sim([{ name: 'base', total: 12, bad: [], all: true }], 120);
check('full outage: no quick try, 15 s, 30 s, 60 s', out.tries.slice(0, 3).join(',') === '15,45,105', out.tries.join(','));
const mix = sim([{ name: 'base', total: 12, bad: [3], failTimes: 2 }, { name: 'slope', total: 12, bad: [5] }], 90);
check('one layer recovers, the other keeps failing: waits keep growing (not reset by the half that loaded)',
      mix.req['slope/5'] <= 5, JSON.stringify(mix.req) + ' tries ' + mix.tries.join(','));

// The hung-tile timeout (_texFetch, sliced verbatim): a fake slow MapProxy
// answers 6 requests at a time (the browser's per-host limit), each after
// `delay` s; the rest wait in the browser queue. A tile only waiting in the
// queue must not time out; a tile that never answers is let go 20 s after
// the last answer, and is no outage.
function fetchSim(n, delay, stuck) {
    let now = 0; const timers = [];
    const setT = (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return t; };
    const clearT = (t) => { if (t) { t.live = false; } };
    const queue = []; let active = 0; const done = {};
    function pump() {
        while (active < 6 && queue.length) {
            const img = queue.shift();
            if (img.dead) { continue; }
            active++;
            if (img.stuck) { continue; }         // holds its connection, never answers
            setT(() => { active--; if (!img.dead && img.onload) { img.onload(); } pump(); }, delay * 1000);
        }
    }
    class FakeImage {
        set src(u) { if (!u) { this.dead = true; if (this.stuck) { active--; pump(); } return; } this.url = u; this.stuck = u.indexOf(stuck) === 0; queue.push(this); pump(); }
        get naturalWidth() { return 256; }
        get naturalHeight() { return 256; }
    }
    const store = new Map();
    let outages = 0;
    const M = new Function('Date', 'setTimeout', 'clearTimeout', 'VTMapTiles', 'Image', 'console',
        'return {' + sliceMethod('_texFetch') + '};')({ now: () => now }, setT, clearT, MT, FakeImage, console);
    Object.assign(M, {
        _texFailedAt: new Map(), _texLoads: new Map(), _tileSuspect: new Set(),
        _texCache: () => ({ has: (u) => store.has(u), acquire: () => {}, put: (u, t) => store.set(u, t) }),
        _r3d: () => ({}), _tileTexture: () => ({ generateMipmaps: false }), _texTrim: () => {},
        _tileIsWhite: () => false, _tileOutage: () => { outages++; }, _tileRecovered: () => {},
    });
    for (let i = 0; i < n; i++) {
        const url = (i === 0 && stuck ? stuck : 'base') + '/' + i;
        M._texFetch(url, false, (ok) => { done[url] = { ok, at: now / 1000 }; });
    }
    while (timers.length && now < 300000) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers.shift();
        if (!t.live) { continue; }
        now = t.at; t.fn();
    }
    const vals = Object.keys(done).map((k) => done[k]);
    return { done, outages, timedOut: vals.filter((v) => !v.ok).length, last: Math.max.apply(null, vals.filter((v) => v.ok).map((v) => v.at)), hung: M._tileHung };
}
const slow = fetchSim(173, 1.5, null);
check('slow MapProxy (173 tiles, 6 at a time, 1.5 s each ≈ 44 s): no tile times out in the queue',
      slow.timedOut === 0 && Object.keys(slow.done).length === 173, 'timed out ' + slow.timedOut + ' last ' + slow.last);
const st = fetchSim(40, 0.5, 'gm');
check('a tile that never answers is let go 20 s after the last other tile came, as a timeout, not an outage',
      !st.done['gm/0'].ok && Math.abs(st.done['gm/0'].at - (st.last + 20)) < 0.2 && st.outages === 0 && st.hung && st.hung.has('gm/0'),
      JSON.stringify(st.done['gm/0']) + ' last ' + st.last + ' outages ' + st.outages);
check('mapping.js: timed-out tiles do not count as an outage in the retry mode',
      /this\._tileRetrySoon\(set\.loaded > 0 && \(set\.failed - hung\) \* 4 <= set\.total, bad\)/.test(SRC));
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
