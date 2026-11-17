/* vt_precip.js — the precipitation mosaic layer's time line (T20 E2).
 *
 * The robot's own precip-mosaic service (package vitulus_precip, HTTP on
 * port 8097, one map from several radars: ČHMÚ, DWD, RainViewer, EUMETNET OPERA …)
 * serves XYZ tiles per time frame. The catalog entry of the overlay
 * (ui_sources.json in docker-mapproxy, id "precip") carries
 *     "timeline": {"port": 8097}
 * and mapping.js then draws that overlay straight from the service, frame by
 * frame, instead of MapProxy's "latest" alias (which stays the fallback).
 *
 * Only GET requests, only to the robot itself (same host as this page):
 *   GET /index.json   frames (past observations + nowcast), sources, credits
 *   GET /legend.json  the palette (mm/h bins per precipitation type)
 *   GET /tiles/{frame}/{z}/{x}/{y}.png?v=<frame signature>
 * The ?v= changes when the frame's sources change (a late radar file, a new
 * nowcast run for the same time, a nowcast slot turned observation), so the
 * browser and the texture cache never keep an outdated picture under a
 * frame id; the service ignores it.
 *
 * T40 (playback): ▶ runs from the oldest picture (−2 h) through "now" to the
 * end of the nowcast, in a loop; the tiles of every frame for the view on
 * screen are preloaded first (Preload: blobs, "loading k/n"), so each step
 * paints from memory; a view too close for the radar (< 20 km) says so and
 * ▶ zooms out to the whole area by itself, Back returns to the garden.
 *
 * The first part is pure (no DOM): node test tools/test_precip.node.js.
 * Timeline() builds the controls (slider + play, nowcast marked, legend,
 * credits, state) into a given element and calls back on a frame change.
 */
(function (root) {
    'use strict';

    var PORT = 8097;
    var ID_RE = /^[0-9A-Za-z:+\-]{1,40}$/;
    var STALE_S = 20 * 60;       // newest observation older than this = stale
    var POLL_MS = 60000;         // index.json while the layer is on
    var TIMEOUT_MS = 15000;      // a cold service fetches its sources (~5 s)
    var STEP_MS = 700;           // playback: one frame per step …
    var WAIT_MS = 3000;          // … waiting at most this long for its tiles
    var HOLD_MS = 1500;          // pause on the last frame before the loop
    var NOW_HOLD_MS = 600;       // a short stop on "now" (measured -> nowcast)
    var WARM_MS = 4000;          // T40: Play waits for the preload at most this long (or until 4 frames ahead are in) …
    var LEAD = 4;                // … then steps on, waiting at a frame still on its way (never jumps back)
    var SMALL_VIEW_M = 20000;    // T40: a view narrower than this shows a few radar pixels (~0.6-1 km each)
    var PLAY_MAX_Z = 7;          // T40: the playback draws at most z7 (0.8 km/px at 50° N, the radars ~1 km)
    var LEGEND_MARKS = [0.1, 1, 5, 20, 50];

    function num(v) {
        if (v === null || v === undefined || v === '') { return null; }
        var n = +v;
        return isFinite(n) ? n : null;
    }

    // djb2 -> base36: a short, stable signature of a frame's content
    function hash(s) {
        var h = 5381;
        for (var i = 0; i < s.length; i++) { h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
        return h.toString(36);
    }

    function epochOf(f) {
        var e = num(f.epoch);
        if (e !== null) { return e; }
        var raw = String(f.time || f.id || '');
        // the service writes minutes (2026-11-08T09:30Z); full ISO also works
        var t = Date.parse(/T\d\d:\d\dZ$/.test(raw) ? raw.replace(/Z$/, ':00Z') : raw);
        return isFinite(t) ? t / 1000 : null;
    }

    // T40: index.rain_nearby -> {radius, near (km|null), max, covered} | null
    function rainOf(r) {
        if (!r || typeof r !== 'object') { return null; }
        var rad = num(r.radius_km), cov = num(r.covered_fraction);
        if (rad === null) { return null; }
        // T40d: the nowcast every 15 min (service T40d; [] before)
        var outlook = (Array.isArray(r.outlook) ? r.outlook : []).map(function (o) {
            return { min: num(o && o.min), near: num(o && o.near_km), covered: num(o && o.covered) };
        }).filter(function (o) { return o.min !== null && o.min > 0 && o.covered !== null; })
            .sort(function (a, b) { return a.min - b.min; });
        return { radius: rad, near: num(r.nearest_rain_km), max: num(r.max_mmh), covered: cov === null ? 1 : cov, outlook: outlook };
    }
    // T40d: when the nowcast may bring rain into the area around the garden
    // (or end it there). Honest limits (check A653):
    //  - "close" = within 20 km of the privacy grid cell's centre (up to ~17 km
    //    from the garden): the words say "the area around the garden";
    //  - only up to +60 min (ČHMÚ reaches +60, DWD +105, the extrapolation
    //    weakens) and only from slots the nowcast covers, in a row;
    //  - the nowcast grid is coarser (10 km) than "now" (5 km): ending needs
    //    the slot clearly dry (> 30 km), coming needs it clearly close (<= 20);
    //  - minutes from NOW: the slot's minutes minus the newest picture's age,
    //    5-min steps; <= 0 = "within the next few minutes";
    //  - nothing while the time line is being rebuilt (one index old).
    // '' = nothing to say (no "it will not rain").
    var OUTLOOK_MAX_MIN = 60;
    function rainWhen(r, ageS, refreshing) {
        if (refreshing || !r || !r.outlook || !r.outlook.length) { return ''; }
        var nowClose = r.near !== null && r.near <= 20;
        var fromNow = function (min) { return Math.round((min * 60 - (ageS || 0)) / 300) * 5; };
        for (var i = 0; i < r.outlook.length; i++) {
            var o = r.outlook[i];
            if (o.min > OUTLOOK_MAX_MIN || o.covered < 0.3) { return ''; }
            var m = fromNow(o.min);
            if (!nowClose && o.near !== null && o.near <= 20) {
                return m <= 0 ? tr('mapt.precip.rain_comes_soon') : tr('mapt.precip.rain_comes', { m: m });
            }
            if (nowClose && (o.near === null || o.near > 30)) {
                return m <= 0 ? tr('mapt.precip.rain_stops_soon') : tr('mapt.precip.rain_stops', { m: m });
            }
        }
        return '';
    }
    // ageS: age of the newest picture (s), for the nowcast minutes "from now"
    function rainText(idx, ageS) {
        var r = idx && idx.rain;
        if (!r || r.covered < 0.3) { return ''; }
        // T40b: measured from the centre of the privacy grid cell, up to
        // ~17 km from the garden: rough words, 10 km steps, "close" up to 20
        var w = rainWhen(r, ageS, idx.refreshing), add = function (t) { return w ? t + ' · ' + w : t; };
        if (r.near === null) { return add(tr('mapt.precip.rain_none', { r: Math.round(r.radius) })); }
        if (r.near <= 20) { return add(tr('mapt.precip.rain_here')); }
        return add(tr('mapt.precip.rain_near', { km: Math.round(r.near / 10) * 10 }));
    }

    // ?v=<signature> of a frames[].tiles template
    function vOf(tiles) {
        var m = /[?&]v=([0-9A-Za-z_.\-]{1,40})(?:&|$)/.exec(String(tiles || ''));
        return m ? m[1] : '';
    }

    // the service's time now: its index time + how long ago the index came
    // (measured here, so a wrong clock on this device does not matter);
    // without "generated" (older service) this device's clock
    function serviceNow(idx, fetchedMs, nowMs) {
        if (idx && idx.generatedEpoch !== null && idx.generatedEpoch !== undefined && fetchedMs) {
            return idx.generatedEpoch + Math.max(0, nowMs - fetchedMs) / 1000;
        }
        return nowMs / 1000;
    }

    // index.json -> {frames, latestIdx, latestEpoch, sources, byId, sideKm, generated}
    // frames: {id, kind 'obs'|'nowcast', epoch, stale, attribution[], v}
    // (null = not an index of this service)
    function parseIndex(j) {
        if (!j || typeof j !== 'object' || !Array.isArray(j.frames)) { return null; }
        var frames = [];
        j.frames.forEach(function (f) {
            if (!f || !ID_RE.test(String(f.id || ''))) { return; }
            var e = epochOf(f);
            if (e === null) { return; }
            var kind = f.kind === 'nowcast' ? 'nowcast' : 'obs';
            var srcs = Array.isArray(f.sources) ? f.sources : [];
            var sig = kind + '|' + (f.run_time || '') + '|' + (f.stale ? 's' : '') + '|' +
                srcs.map(function (s) { return (s && s.id) + '@' + (s && s.time) + '@' + (s && s.run_time || ''); }).join(',');
            frames.push({
                id: String(f.id), kind: kind, epoch: e, stale: !!f.stale,
                attribution: (Array.isArray(f.attribution) ? f.attribution : []).map(String).filter(Boolean),
                sources: srcs.map(function (s) { return s && s.id; }).filter(Boolean),
                // the service's own frame signature (?v= in frames[].tiles); our
                // hash of the frame's sources only for an older service without it
                v: vOf(f.tiles) || hash(sig),
            });
        });
        frames.sort(function (a, b) { return a.epoch - b.epoch || (a.kind === 'obs' ? -1 : 1); });
        var latestIdx = -1;
        frames.forEach(function (f, i) { if (f.kind === 'obs') { latestIdx = i; } });
        var sources = (Array.isArray(j.sources) ? j.sources : []).filter(function (s) { return s && s.id; }).map(function (s) {
            return {
                id: String(s.id), name: String(s.name || s.id), attribution: String(s.attribution || ''),
                url: /^https:\/\//.test(String(s.attribution_url || '')) ? String(s.attribution_url) : '',
                error: s.last_error ? String(s.last_error) : '',
                // T40: the source answers but has no data (the service says
                // status "no_data", since when); an older service never does
                noData: s.status === 'no_data',
                noDataSince: (s.no_data && s.no_data.since) ? epochOf({ time: s.no_data.since }) : null,
            };
        });
        var byId = {};
        sources.forEach(function (s) { byId[s.id] = s; });
        var r = j.mode && j.mode.area && num(j.mode.area.radius_km);
        return {
            frames: frames, latestIdx: latestIdx,
            latestEpoch: latestIdx >= 0 ? frames[latestIdx].epoch : null,
            sources: sources, byId: byId,
            // the view that shows the whole area (the "Whole area" button)
            sideKm: r ? Math.min(600, 2 * r) : 600,
            generated: String(j.generated || ''),
            // the service's clock when it wrote the index (data age is measured
            // against it, not against this browser's clock)
            generatedEpoch: epochOf({ time: j.generated }),
            // T40: rain around the area now (service >= T40; null = unknown)
            rain: rainOf(j.rain_nearby),
            // T40d: the service is building a newer time line (after an idle
            // spell this index still carries the old one): ask again soon
            refreshing: !!j.refreshing && (num(j.timeline_age_s) || 0) > 120,
            timelineAge: num(j.timeline_age_s) || 0,
        };
    }

    function base(host, tl) {
        var p = tl && num(tl.port);
        return 'http://' + host + ':' + ((p && p > 0 && p < 65536) ? Math.round(p) : PORT);
    }

    function tileUrl(b, frame, z, x, y) {
        return b + '/tiles/' + frame.id + '/' + z + '/' + x + '/' + y + '.png' + (frame.v ? '?v=' + frame.v : '');
    }

    // where the frame lies: index in idx.frames, -1 = gone
    function find(idx, id) {
        if (!idx || !id) { return -1; }
        for (var i = 0; i < idx.frames.length; i++) { if (idx.frames[i].id === id) { return i; } }
        return -1;
    }

    // the frame to show after a new index: following "now" -> the newest
    // observation; a chosen frame that is gone -> the nearest in time
    function pick(idx, wantId, follow, wantEpoch) {
        if (!idx || !idx.frames.length) { return -1; }
        if (follow || !wantId) { return idx.latestIdx >= 0 ? idx.latestIdx : idx.frames.length - 1; }
        var i = find(idx, wantId);
        if (i >= 0) { return i; }
        var best = 0, bd = Infinity;
        idx.frames.forEach(function (f, k) {
            var d = Math.abs(f.epoch - (wantEpoch || 0));
            if (d < bd) { bd = d; best = k; }
        });
        return best;
    }

    // state of the data: 'loading' | 'down' | 'empty' | 'stale' | 'ok', age of the newest observation (s)
    function state(idx, failed, nowS) {
        if (failed) { return { state: 'down', age: null }; }
        if (!idx) { return { state: 'loading', age: null }; }
        if (idx.latestIdx < 0) { return { state: 'empty', age: null }; }
        var age = Math.max(0, Math.round(nowS - idx.latestEpoch));
        if (idx.refreshing) { return { state: 'updating', age: age }; }
        return { state: (age > STALE_S || idx.frames[idx.latestIdx].stale) ? 'stale' : 'ok', age: age };
    }

    // minutes of a frame relative to the newest observation (nowcast > 0)
    function relMin(idx, f) {
        if (!idx || idx.latestEpoch === null || !f) { return 0; }
        return Math.round((f.epoch - idx.latestEpoch) / 60);
    }

    // legend.json -> {rain: [{min, max, css}], snow: [...], marks: [{v, pos 0-1}], unit}
    function legend(j) {
        var bins = function (list) {
            return (Array.isArray(list) ? list : []).filter(function (b) { return b && Array.isArray(b.rgba) && b.rgba.length === 4; })
                .map(function (b) {
                    var c = b.rgba.map(function (v) { return Math.max(0, Math.min(255, Math.round(+v || 0))); });
                    // the legend shows the colour; the map's own alpha (weak rain is
                    // see-through) would make the light bins disappear on the panel
                    return { min: num(b.min_mmh), max: num(b.max_mmh), css: 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' };
                });
        };
        var rain = bins(j && j.rain), snow = bins(j && j.snow);
        var marks = [];
        rain.forEach(function (b, i) {
            if (LEGEND_MARKS.indexOf(b.min) >= 0) { marks.push({ v: b.min, pos: i / rain.length }); }
        });
        return { rain: rain, snow: snow, marks: marks, unit: String((j && j.unit) || 'mm/h') };
    }

    // the credits of one frame; a source with a https page gets its link
    function credits(idx, f) {
        if (!idx || !f) { return []; }
        return f.attribution.map(function (a) {
            var url = '';
            idx.sources.forEach(function (s) { if (s.attribution === a && s.url) { url = s.url; } });
            return { text: a, url: url };
        });
    }

    // sources that report an error right now (names), for one short line
    function failing(idx) {
        return idx ? idx.sources.filter(function (s) { return s.error; }).map(function (s) { return s.name; }) : [];
    }

    // T40: sources that answer but have nothing (status "no_data" from the
    // service, e.g. OPERA with an empty bucket) -> [{name, since}]
    function noData(idx) {
        return idx ? idx.sources.filter(function (s) { return s.noData && !s.error; })
            .map(function (s) { return { name: s.name, since: s.noDataSince }; }) : [];
    }

    // ---------------------------------------------------------- playback (T40)
    // The frames to preload for playback, ascending: every k-th so that
    // frames x tiles stays within maxTiles (the robot renders every tile it
    // has not cached yet, a phone has little memory). With the frames' times
    // (epochs) the stride is laid on the clock (every 10 / 15 min), so a new
    // index a minute later picks the same frames and the preload keeps them;
    // "now" and the last frame are always in.
    function plan(n, latestIdx, tilesPerFrame, maxTiles, epochs) {
        if (!(n > 0)) { return []; }
        var per = Math.max(1, Math.round(tilesPerFrame) || 1);
        var fit = Math.max(2, Math.floor((maxTiles > 0 ? maxTiles : 1e9) / per));
        // the stride from the window's full size (2 h + 2 h of 5 min = 49):
        // an index with a frame more or less keeps the same stride and frames
        var k = Math.max(1, Math.ceil(Math.max(n, 49) / fit));
        var a = latestIdx >= 0 && latestIdx < n ? latestIdx : 0;
        var on = function (i) {
            if (k === 1) { return true; }
            if (epochs && isFinite(epochs[i])) { return Math.round(epochs[i] / 300) % k === 0; }
            return ((i - a) % k + k) % k === 0;
        };
        var out = [];
        for (var i = 0; i < n; i++) {
            if (on(i) || i === a || i === n - 1) { out.push(i); }
        }
        return out;
    }

    // the next frame after i (wrapping) to show: st(j) = 'ready' | 'pending'
    // (on its way: wait for it) | 'skip' (not planned / never loads);
    // -1 = stay (the next one is still loading, or no other one)
    function nextReady(n, i, st) {
        for (var s = 1; s < n + 1; s++) {
            var j = ((i + s) % n + n) % n;
            if (j === i) { return -1; }
            var x = st(j);
            if (x === true || x === 'ready') { return j; }
            if (x === 'pending') { return -1; }
        }
        return -1;
    }
    // how many frames from i on (skips not counted) are ready in a row
    function leadReady(n, i, st) {
        var k = 0;
        for (var s = 0; s < n; s++) {
            var x = st(((i + s) % n + n) % n);
            if (x === 'skip' || x === false) { continue; }
            if (x === 'pending') { break; }
            k++;
        }
        return k;
    }

    // Preload of the playback tiles: the PNGs (a few kB each) are fetched
    // once, kept as blobs and handed to the map as object URLs, so a step of
    // the playback paints from memory — no request, no waiting, nothing
    // cancelled. Bounded by bytes; a new view keeps what it still needs.
    // T40 (check): a frame whose content changed (a new nowcast run every
    // 5 min: a new ?v=) keeps its old pictures until the new ones are in —
    // the playback runs on, the progress does not fall back; a frame the
    // service no longer has (404, it left the 2 h window) is skipped and
    // o.onGone() asks for a new index; the service unreachable (network
    // error) stops the loading at once and calls o.onDown() (no request
    // storm), want()/resume() go on.
    // o: {get(url, signal) -> Promise<Blob|null> (rejects {status} / {net}),
    //     mkUrl(blob), revoke(objUrl), conc, maxBytes, onChange(), onGone(), onDown()}
    function Preload(o) {
        this.o = o || {};
        this.items = new Map();    // url -> {state wait|load|ok|err, gone, obj, size, ctl, waiters}
        this.frames = [];          // [{id, v, urls}] in load order
        this.byId = {};
        this.prev = {};            // id -> the frame's previous version while the new one loads
        this.key = '';
        this.bytes = 0;
        this.active = 0;
        this.full = false;
        this.down = false;
    }
    // frames: [{id, v, urls[]}] in the order they should load
    Preload.prototype.want = function (key, frames) {
        var keep = new Set(), self = this, prev = {};
        frames.forEach(function (f) {
            f.urls.forEach(function (u) { keep.add(u); });
            // a new version of a frame that is in: the old one stays meanwhile
            var old = self.prev[f.id] && self.prev[f.id].v !== f.v ? self.prev[f.id] : self.byId[f.id];
            if (old && old.v !== f.v && self._jobReady(old) && !self._jobReady(f)) {
                prev[f.id] = old;
                old.urls.forEach(function (u) { keep.add(u); });
            }
        });
        Array.from(this.items.keys()).forEach(function (u) {
            var it = self.items.get(u);
            if (!keep.has(u) && !(it && it.fid && it.state === 'load')) { self._drop(u); }
        });
        this.extra = (this.extra || []).filter(function (u) { return self.items.has(u); });
        this.key = key;
        this.frames = frames;
        this.byId = {};
        this.prev = prev;
        frames.forEach(function (f) {
            self.byId[f.id] = f;
            f.urls.forEach(function (u) { if (!self.items.has(u)) { self.items.set(u, { state: 'wait' }); } });
        });
        this.full = false;
        this.down = false;
        this._pump();
    };
    // T40b: a tile the map needs now (the frame on screen), outside the
    // plan: fetched first, through the same limits — so a frame the service
    // dropped shows with one 404, not with a request per tile and zoom
    Preload.prototype.ensure = function (u, fid) {
        // only the frame on screen counts: waiting tiles of a frame the map
        // has moved past (slider, playback) are not fetched any more
        if (fid && this.extraFid && fid !== this.extraFid) { this._dropExtra(); }
        this.extraFid = fid || this.extraFid;
        if (this.items.has(u)) { return; }
        this.items.set(u, { state: 'wait', fid: fid || null });
        (this.extra || (this.extra = [])).push(u);
        this._pump();
    };
    Preload.prototype._dropExtra = function () {
        var self = this, inJob = {};
        this.frames.forEach(function (f) { f.urls.forEach(function (x) { inJob[x] = 1; }); });
        (this.extra || []).forEach(function (u) {
            var it = self.items.get(u);
            if (it && it.state === 'wait' && !inJob[u]) { self._drop(u); }
        });
        this.extra = [];
    };
    Preload.prototype.resume = function () { if (this.down) { this.down = false; this._pump(); } };
    Preload.prototype._pump = function () {
        if (this.down) { return; }
        var conc = this.o.conc > 0 ? this.o.conc : 3;
        if (this.extra && this.extra.length) {
            var self = this;
            this.extra = this.extra.filter(function (u) { var it = self.items.get(u); return it && it.state === 'wait'; });
            for (var ei = 0; ei < this.extra.length && this.active < conc; ei++) {
                var et = this.items.get(this.extra[ei]);
                if (et && et.state === 'wait') { this._load(this.extra[ei], et); }
            }
        }
        for (var fi = 0; fi < this.frames.length && this.active < conc; fi++) {
            var urls = this.frames[fi].urls;
            for (var ui = 0; ui < urls.length && this.active < conc; ui++) {
                var it = this.items.get(urls[ui]);
                if (!it || it.state !== 'wait') { continue; }
                if (this.o.maxBytes > 0 && this.bytes >= this.o.maxBytes) { this.full = true; return; }
                this._load(urls[ui], it);
            }
        }
    };
    // a new version is in: its old one goes
    Preload.prototype._settle = function () {
        var self = this;
        Object.keys(this.prev).forEach(function (id) {
            var f = self.byId[id];
            if (!f || !self._jobReady(f)) { return; }
            var old = self.prev[id];
            delete self.prev[id];
            var keep = new Set(f.urls);
            old.urls.forEach(function (u) { if (!keep.has(u)) { self._drop(u); } });
        });
    };
    Preload.prototype._load = function (u, it) {
        var self = this;
        it.state = 'load';
        it.ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        this.active++;
        var done = function () {
            self.active--;
            var ws = it.waiters;
            it.waiters = null;
            if (ws) { ws.forEach(function (w) { try { w(); } catch (e) { /* the map's business */ } }); }
            self._settle();
            self._pump();
            if (self.o.onChange) { self.o.onChange(); }
        };
        Promise.resolve().then(function () { return self.o.get(u, it.ctl ? it.ctl.signal : undefined); }).then(function (blob) {
            it.ctl = null;
            if (self.items.get(u) !== it) { done(); return; }   // dropped meanwhile
            it.state = 'ok';
            it.size = (blob && blob.size) || 0;
            self.bytes += it.size;
            it.obj = self.o.mkUrl ? self.o.mkUrl(blob) : null;
            self.trouble = false;
            done();
        }, function (e) {
            it.ctl = null;
            if (self.items.get(u) === it) {
                if (e && e.timeout) {
                    // T40b: ONE tile without an answer (20 s) does not stop
                    // the playback: it counts as missing, tried again later
                    self._late(u, it);
                } else if (e && e.net) {
                    // the service does not answer: stop here, ask nothing more
                    it.state = 'wait';
                    self.trouble = true;   // shown until a tile comes again (no flicker on retries)
                    if (!self.down) { self.down = true; if (self.o.onDown) { self.o.onDown(); } }
                } else {
                    it.state = 'err';
                    it.gone = !!(e && e.status === 404);
                    // (a local refusal — a frame already known to be dropped —
                    // tells nothing new: no new index for it)
                    if (it.gone && !(e && e.local) && self.o.onGone) { self.o.onGone(self._frameOf(u)); }
                }
            }
            done();
        });
    };
    // the frame a tile URL belongs to (id or null)
    Preload.prototype._frameOf = function (u) {
        var it = this.items.get(u);
        if (it && it.fid) { return it.fid; }
        for (var id in this.byId) {
            if (this.byId[id].urls.indexOf(u) >= 0) { return id; }
        }
        return null;
    };
    Preload.prototype.RETRY_MS = 30000;
    // a tile that timed out: done for now (its frame plays without it), one
    // try again in the background after RETRY_MS (at most 2, one at a time)
    Preload.prototype._late = function (u, it) {
        var self = this;
        it.state = 'err';
        it.late = (it.late || 0) + 1;
        if (it.late > 2) { return; }
        setTimeout(function () {
            if (self.items.get(u) !== it || it.state !== 'err' || self.retrying) { return; }
            self.retrying = true;
            Promise.resolve().then(function () { return self.o.get(u); }).then(function (blob) {
                self.retrying = false;
                if (self.items.get(u) !== it) { return; }
                it.state = 'ok';
                it.size = (blob && blob.size) || 0;
                self.bytes += it.size;
                it.obj = self.o.mkUrl ? self.o.mkUrl(blob) : null;
                if (self.o.onChange) { self.o.onChange(); }
            }, function (e) {
                self.retrying = false;
                if (self.items.get(u) === it && e && (e.timeout || e.net)) { self._late(u, it); }
            });
        }, this.RETRY_MS);
    };
    Preload.prototype._drop = function (u) {
        var it = this.items.get(u);
        if (!it) { return; }
        this.items.delete(u);
        if (it.ctl) { try { it.ctl.abort(); } catch (e) { /* old browser */ } }
        if (it.obj && this.o.revoke) { this.o.revoke(it.obj); }
        this.bytes -= it.size || 0;
        var ws = it.waiters;
        it.waiters = null;
        if (ws) { ws.forEach(function (w) { try { w(); } catch (e) { /* ignore */ } }); }
    };
    Preload.prototype.clear = function () {
        var self = this;
        Array.from(this.items.keys()).forEach(function (u) { self._drop(u); });
        this.frames = []; this.byId = {}; this.prev = {}; this.key = ''; this.full = false; this.down = false; this.trouble = false;
    };
    // the object URL of a preloaded tile (null = not preloaded / failed)
    Preload.prototype.url = function (u) {
        var it = this.items.get(u);
        return it && it.state === 'ok' ? it.obj : null;
    };
    // the tile is on its way: cb() once it is in (or failed / dropped)
    Preload.prototype.pending = function (u) {
        var it = this.items.get(u);
        return !!(it && !this.down && (it.state === 'wait' || it.state === 'load'));
    };
    Preload.prototype.whenDone = function (u, cb) {
        var it = this.items.get(u);
        if (!it || !(it.state === 'wait' || it.state === 'load')) { cb(); return; }
        (it.waiters || (it.waiters = [])).push(cb);
    };
    Preload.prototype._jobReady = function (f) {
        for (var i = 0; i < f.urls.length; i++) {
            var it = this.items.get(f.urls[i]);
            if (!it || it.state === 'wait' || it.state === 'load') { return false; }
        }
        return true;
    };
    // one tile answered 404: the frame left the service's window (T40b)
    Preload.prototype._jobGone = function (f) {
        for (var i = 0; i < f.urls.length; i++) {
            var it = this.items.get(f.urls[i]);
            if (it && it.gone) { return true; }
        }
        return false;
    };
    Preload.prototype.isGone = function (u) {
        var it = this.items.get(u);
        return !!(it && it.gone);
    };
    // 'ready' | 'pending' | 'skip' (not planned, gone from the service, or
    // the byte limit stops it)
    Preload.prototype.frameState = function (id) {
        var f = this.byId[id];
        if (!f) { return 'skip'; }
        if (this._jobGone(f)) { return 'skip'; }
        if (this.frameReady(id)) { return 'ready'; }
        if (this.full) {
            for (var i = 0; i < f.urls.length; i++) {
                var it = this.items.get(f.urls[i]);
                if (it && it.state === 'load') { return 'pending'; }
            }
            return 'skip';
        }
        return 'pending';
    };
    // every tile of the frame (or of its previous version) is in
    Preload.prototype.frameReady = function (id) {
        var f = this.byId[id];
        if (!f) { return false; }
        if (this._jobReady(f)) { return true; }
        return !!(this.prev[id] && this._jobReady(this.prev[id]));
    };
    // the version of the frame to draw: the new one once it is in, the old
    // one meanwhile (null = not planned)
    Preload.prototype.useV = function (id) {
        var f = this.byId[id];
        if (!f) { return null; }
        if (!this._jobReady(f) && this.prev[id] && this._jobReady(this.prev[id])) { return this.prev[id].v; }
        return f.v;
    };
    Preload.prototype.progress = function () {
        var k = 0, self = this;
        this.frames.forEach(function (f) { if (self.frameReady(f.id)) { k++; } });
        return { k: k, n: this.frames.length, full: this.full, bytes: this.bytes, down: this.down || !!this.trouble };
    };

    // ---------------------------------------------------------------- DOM
    function tr(k, v) { return root && root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function langOf() { return (root && root.VTI18n && root.VTI18n.lang && root.VTI18n.lang()) || 'en'; }
    // T40: "since" of a source without data: the time today, else the date
    function sinceText(epoch) {
        var d = new Date(epoch * 1000), now = new Date();
        if (d.toDateString() === now.toDateString()) { return hhmm(epoch); }
        try {
            return d.toLocaleDateString(langOf() === 'cs' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'numeric' });
        } catch (e) { return d.getDate() + '. ' + (d.getMonth() + 1) + '.'; }
    }
    function hhmm(epoch) {
        try {
            return new Date(epoch * 1000).toLocaleTimeString(langOf() === 'cs' ? 'cs-CZ' : 'en-GB',
                                                              { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            var d = new Date(epoch * 1000), p = function (n) { return (n < 10 ? '0' : '') + n; };
            return p(d.getHours()) + ':' + p(d.getMinutes());
        }
    }
    function relText(min) {
        if (min === 0) { return tr('mapt.precip.rel_now'); }
        var a = Math.abs(min), s = min < 0 ? '−' : '+';
        return (a >= 60 && a % 60 === 0) ? s + (a / 60) + ' h' : s + a + ' min';
    }
    function el(tag, cls, txt) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (txt != null) { e.textContent = txt; }
        return e;
    }

    // opts: {mount, base, onFrame(frame|null), ready() -> bool, onFit(), store}
    function Timeline(opts) {
        this.o = opts || {};
        this.idx = null;
        this.leg = null;
        this.failed = false;
        this.selId = null;
        this.selEpoch = null;
        this.follow = true;
        this.playing = false;
        this._t0 = 0;
        this._poll = null;
        this._play = null;
        this._busy = false;
        this.on = false;
        this.gone = new Set();     // T40b: frames the service answered 404 for
        this._build();
    }

    Timeline.prototype._build = function () {
        var m = this.o.mount, self = this;
        if (!m) { return; }
        m.innerHTML = '';
        m.classList.add('vt-precip');
        var head = el('div', 'vt-precip-head');
        this.e_time = el('span', 'vt-precip-time vt-tnum', '--:--');
        this.e_kind = el('span', 'vt-precip-kind');
        this.e_state = el('span', 'vt-precip-state vt-dim vt-tnum');
        this.e_state.setAttribute('role', 'status');
        head.appendChild(this.e_time); head.appendChild(this.e_kind); head.appendChild(this.e_state);
        m.appendChild(head);

        // T40: [▶] [Whole area | Back] … [Now] above, the slider below at full
        // width (a phone has room for the frames, the buttons keep their text)
        var ctl = el('div', 'vt-precip-ctl');
        this.b_play = el('button', 'btn btn-outline-info vt-precip-btn vt-precip-playbtn');
        this.b_play.type = 'button';
        this.b_play.id = 'mapv3_precip_play';
        this.b_play.addEventListener('click', function () { self.toggle(); });
        this.b_fit = el('button', 'btn btn-outline-primary vt-precip-btn vt-precip-fit');
        this.b_fit.type = 'button';
        this.b_fit.id = 'mapv3_precip_fit';
        this.b_fit.addEventListener('click', function () { self.fitOrBack(); });
        var row = el('div', 'vt-precip-row');
        var sl = el('div', 'vt-precip-slide');
        this.e_track = el('div', 'vt-precip-track');
        this.e_track.setAttribute('aria-hidden', 'true');
        this.e_obs = el('span', 'vt-precip-seg-obs');
        this.e_nc = el('span', 'vt-precip-seg-nc');
        this.e_track.appendChild(this.e_obs); this.e_track.appendChild(this.e_nc);
        // T40: "now" as a mark across the track (measured left, nowcast right)
        this.e_nowmark = el('span', 'vt-precip-nowmark');
        this.e_nowmark.setAttribute('aria-hidden', 'true');
        this.in_range = el('input', 'vt-precip-range');
        this.in_range.type = 'range';
        this.in_range.id = 'mapv3_precip_range';
        this.in_range.min = '0'; this.in_range.max = '0'; this.in_range.step = '1'; this.in_range.value = '0';
        this.in_range.addEventListener('input', function () {
            self.pause();
            // T40b: not onto a frame the service has dropped
            var i = Math.max(parseInt(self.in_range.value, 10), self.liveFrom());
            self._select(i, true);
        });
        sl.appendChild(this.e_track); sl.appendChild(this.e_nowmark); sl.appendChild(this.in_range);
        var ticks = el('div', 'vt-precip-ticks vt-dim vt-tnum');
        ticks.setAttribute('aria-hidden', 'true');
        this.e_t0 = el('span', 'vt-precip-t0');
        this.e_tnow = el('span', 'vt-precip-tnow');
        this.e_t1 = el('span', 'vt-precip-t1');
        ticks.appendChild(this.e_t0); ticks.appendChild(this.e_tnow); ticks.appendChild(this.e_t1);
        sl.appendChild(ticks);
        // T17 M9: the labels are fitted for the width the slider has; it gets
        // another one when its card comes into view (drawn while Map › Display
        // was closed: no width, nothing fitted — "now" ran into the right end
        // label by 2 px on a 360 px phone) or moves into the layers panel
        if (typeof ResizeObserver !== 'undefined') {
            try { new ResizeObserver(function () { self._fixTicks(); }).observe(sl); } catch (e) { /* old browser */ }
        }
        this.b_now = el('button', 'btn btn-outline-secondary vt-precip-btn vt-precip-nowbtn');
        this.b_now.type = 'button';
        this.b_now.id = 'mapv3_precip_now';
        this.b_now.addEventListener('click', function () { self.pause(); self.follow = true; self._select(-1, true); });
        ctl.appendChild(this.b_play); ctl.appendChild(this.b_fit);
        ctl.appendChild(el('span', 'vt-precip-gap')); ctl.appendChild(this.b_now);
        m.appendChild(ctl);
        row.appendChild(sl);
        m.appendChild(row);
        // T40: one short sentence when the view is too close for the radar
        // (or the playback zoomed out by itself)
        // T40: is it raining around the garden now (one sentence)
        this.e_rain = el('div', 'vt-precip-rain vt-fs-xs');
        this.e_rain.hidden = true;
        m.appendChild(this.e_rain);
        this.e_hint = el('div', 'vt-precip-hint vt-fs-xs');
        this.e_hint.hidden = true;
        m.appendChild(this.e_hint);

        this.e_legend = el('div', 'vt-precip-legend');
        m.appendChild(this.e_legend);
        this.e_fail = el('div', 'vt-precip-fail vt-fs-xs');
        this.e_fail.hidden = true;
        m.appendChild(this.e_fail);
        // T40: sources that answer but deliver nothing (not an error, not silent)
        this.e_nodata = el('div', 'vt-precip-nodata vt-fs-xs vt-dim');
        this.e_nodata.hidden = true;
        m.appendChild(this.e_nodata);
        var foot = el('div', 'vt-precip-foot');
        this.e_attr = el('div', 'vt-precip-attr vt-fs-xs vt-dim');
        foot.appendChild(this.e_attr);
        m.appendChild(foot);
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('resize', function () { if (self.on) { self._fixTicks(); } });
        }
        this.relabel();
    };

    Timeline.prototype.sideKm = function () { return this.idx ? this.idx.sideKm : 300; };
    Timeline.prototype.frame = function () {
        var i = find(this.idx, this.selId);
        return i >= 0 ? this.idx.frames[i] : null;
    };
    Timeline.prototype.index = function () { return this.idx; };
    Timeline.prototype.status = function () {
        return state(this.idx, this.failed, serviceNow(this.idx, this._fetchedMs, Date.now()));
    };
    // the credit line of the frame on screen
    Timeline.prototype.attribution = function () {
        return credits(this.idx, this.frame()).map(function (c) { return c.text; }).join(' · ');
    };

    Timeline.prototype.start = function () {
        if (this.on) { return; }
        this.on = true;
        var self = this;
        this._fetch();
        this._poll = setInterval(function () {
            if (typeof document !== 'undefined' && document.hidden) { return; }
            self._fetch();
        }, POLL_MS);
        if (!this.leg) { this._fetchLegend(); }
    };

    Timeline.prototype.stop = function () {
        this.on = false;
        this.pause();
        if (this._poll) { clearInterval(this._poll); this._poll = null; }
    };

    Timeline.prototype._get = function (path) {
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var to = setTimeout(function () { if (ctl) { ctl.abort(); } }, TIMEOUT_MS);
        return fetch(this.o.base + path, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
            .then(function (r) { clearTimeout(to); if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); },
                  function (e) { clearTimeout(to); throw e; });
    };

    Timeline.prototype._fetchLegend = function () {
        var self = this;
        this._get('/legend.json').then(function (j) {
            self.leg = legend(j);
            self._renderLegend();
        }).catch(function () { /* next poll tries again */ });
    };

    Timeline.prototype._fetch = function (cb) {
        if (this._busy) { return; }
        this._busy = true;
        var self = this;
        this._get('/index.json').then(function (j) {
            var idx = parseIndex(j);
            if (!idx) { throw new Error('not a precip index'); }
            self._busy = false;
            self.failed = false;
            var before = self.frame();
            self.idx = idx;
            self._fetchedMs = Date.now();
            // a frame 404 said gone and no longer in the index: forgotten
            self.gone.forEach(function (id) { if (find(idx, id) < 0) { self.gone.delete(id); } });
            if (cb) { cb(); }
            // T40d: an old time line being rebuilt: a new index in 4 s (at most 8x)
            if (idx.refreshing && self.on && (self._quick = (self._quick || 0) + 1) <= 8) {
                setTimeout(function () { if (self.on) { self._fetch(); } }, 4000);
            } else if (!idx.refreshing) { self._quick = 0; }
            var i = pick(idx, self.selId, self.follow, self.selEpoch);
            self._select(i, false, before);
            // T40: new frames while it plays: the preload follows the index
            // (what is in stays, a new frame or signature is fetched)
            if (self.playing && self.o.prepare) { self.o.prepare(); }
            if (!self.leg) { self._fetchLegend(); }
        }).catch(function (e) {
            self._busy = false;
            var was = self.failed;
            self.failed = true;
            self.pause();          // T40: no playback over a dead service (it says so)
            if (!was) { try { console.warn('[precip] service not reachable:', e && e.message); } catch (x) { /* ignore */ } }
            self._render();
            if (!was && self.o.onFrame) { self.o.onFrame(self.frame(), 'down'); }
        });
    };

    // i: frame index (-1 = the newest observation); user: picked by hand
    Timeline.prototype._select = function (i, user, before) {
        var idx = this.idx;
        if (!idx || !idx.frames.length) { this.selId = null; this._render(); if (this.o.onFrame) { this.o.onFrame(null); } return; }
        if (i < 0 || i >= idx.frames.length) { i = idx.latestIdx >= 0 ? idx.latestIdx : idx.frames.length - 1; }
        var f = idx.frames[i];
        if (user) { this.follow = (i === idx.latestIdx); }
        var changed = !before || before.id !== f.id || before.v !== f.v;
        if (user) { changed = changed || this.selId !== f.id; }
        this.selId = f.id;
        this.selEpoch = f.epoch;
        this._t0 = Date.now();
        this._render();
        if ((changed || user) && this.o.onFrame) { this.o.onFrame(f); }
    };

    Timeline.prototype.toggle = function () { if (this.playing) { this.pause(); } else { this.play(); } };

    // T40: ▶ plays from the oldest picture (−2 h) through "now" to the end of
    // the nowcast, in a loop. A frame picked by hand (paused in the middle)
    // goes on from there. Before the first step the tiles of the frames are
    // preloaded for this view (o.prepare; "loading k/n" in the state line),
    // at most WARM_MS — then it steps through the frames that are in while
    // the rest comes. A view too close for the radar zooms out first
    // (o.beforePlay; Back returns).
    // T40: the oldest frames the service has dropped since this index was
    // written (its 2 h window moves every 5 min): asking for them = 404s
    // T40c: the service's index lists exactly the frames it holds (2 h
    // before its newest observation, service.py _build_timeline); the oldest
    // goes only when a NEWER observation arrives there — after this index.
    // So the frames to leave out are counted from the age of the INDEX, not
    // from the age of the newest observation (a late radar shifts nothing):
    // a fresh index (polled every minute, ≤ 90 s) — none; an older one (the
    // tab was hidden) — one per 5 min past that, at most 3. Plus the frames
    // the service answered 404 for. They are never asked for.
    Timeline.prototype.liveFrom = function () {
        var idx = this.idx;
        if (!idx || !this._fetchedMs) { return 0; }
        var age = Math.max(0, Date.now() - this._fetchedMs) / 1000;
        var m = age <= 90 ? 0 : Math.floor((age - 90) / 300) + 1;
        m = Math.min(m, 3);
        // T40d: an old time line being rebuilt (after an idle spell): its
        // oldest frames are about to go — one per 5 min of its age
        if (idx.refreshing) { m = Math.max(m, Math.floor(idx.timelineAge / 300)); }
        m = Math.min(m, idx.latestIdx > 0 ? idx.latestIdx : 0);
        while (m < idx.latestIdx && this.gone.has(idx.frames[m].id)) { m++; }
        return m;
    };
    Timeline.prototype.markGone = function (id) {
        if (!id || this.gone.has(id)) { return; }
        this.gone.add(id);
        this._render();
    };
    // may a tile of frame id be asked for? (in the index, not dropped)
    Timeline.prototype.frameLive = function (id) {
        var i = find(this.idx, id);
        return i >= 0 && i >= this.liveFrom() && !this.gone.has(id);
    };

    Timeline.prototype.play = function () {
        var idx = this.idx;
        if (!idx || idx.frames.length < 2) { return; }
        // an index more than 30 s old: a fresh one (the window may have moved)
        if (this._fetchedMs && Date.now() - this._fetchedMs > 30000) { this._fetch(); }
        if (this.o.beforePlay) { this.o.beforePlay(); }
        this.playing = true;
        this._warm = true;
        this._warmT = Date.now();
        if (this.o.prepare) { this.o.prepare(); }
        var i = find(idx, this.selId);
        if (this.follow || i < this.liveFrom() || i >= idx.frames.length - 1) { this._select(this.liveFrom(), true); }
        this._t0 = Date.now();
        var self = this;
        if (this._play) { clearInterval(this._play); }
        this._play = setInterval(function () { self._tick(); }, 100);
        this._render();
    };

    Timeline.prototype.pause = function () {
        if (this._play) { clearInterval(this._play); this._play = null; }
        this._warm = false;
        if (this.playing) {
            this.playing = false;
            this._render();
            if (this.o.onPause) { this.o.onPause(); }
        }
    };

    // the preload: {k, n, full} (null = no preload, every frame counts as in)
    Timeline.prototype._load = function () { return this.o.loadState ? this.o.loadState() : null; };
    // 'ready' | 'pending' | 'skip' of frame j for the playback
    Timeline.prototype._frameIn = function (j) {
        if (j < this.liveFrom()) { return 'skip'; }
        var f = this.idx.frames[j];
        if (this.gone.has(f.id)) { return 'skip'; }
        if (this.o.frameState) { return this.o.frameState(f); }
        return (!this.o.frameReady || this.o.frameReady(f)) ? 'ready' : 'skip';
    };

    Timeline.prototype._tick = function () {
        var idx = this.idx;
        if (!idx || !this.playing) { return; }
        var ls = this._load(), self = this;
        var stf = function (k) { return self._frameIn(k); };
        if (this._warm) {
            var all = !ls || (!ls.n && !ls.zooming) || ls.k >= ls.n || ls.full;
            var el = Date.now() - this._warmT;
            var go = all || el > WARM_MS || (el > 1000 && leadReady(idx.frames.length, find(idx, this.selId), stf) >= LEAD);
            if (!go) { this._renderState(); return; }
            this._warm = false;
            this._t0 = Date.now();
            this._renderState();
            return;
        }
        var n = idx.frames.length;
        var i = find(idx, this.selId), dt = Date.now() - this._t0;
        var j = nextReady(n, i, stf);
        if (j < 0) { this._renderState(); return; }          // nothing else in yet: stay
        var hold = j <= i ? HOLD_MS : (i === idx.latestIdx ? NOW_HOLD_MS : 0);
        var ready = !this.o.ready || this.o.ready();
        if (dt < STEP_MS + hold) { return; }
        if (!ready && dt < WAIT_MS) { return; }
        this._select(j, true);
    };

    // T40: the view (mapping.js): {small: too close for the radar, back: a
    // view to go back to, auto: the playback zoomed out by itself}
    Timeline.prototype._view = function () {
        var v = this.o.view ? this.o.view() : null;
        return v || { small: false, back: false, auto: false };
    };
    Timeline.prototype.viewChanged = function () { this._renderView(); };
    // Whole area, or Back to the view before it (card and map bar)
    Timeline.prototype.fitOrBack = function () {
        var v = this._view();
        if (v.back && this.o.onRestore) { this.o.onRestore(); }
        else if (this.o.onFit) { this.o.onFit(this.sideKm()); }
        this._renderView();
    };
    // T40: the service stopped answering while it plays: stop, say so now
    // (the index check confirms it and keeps asking at its own pace)
    // T40b: tiles fail with a network error: ask the index. No answer =
    // the service is down (pause + "service not responding", see _fetch);
    // an answer = only tiles failed: ok() resumes them (the playback waits
    // at the edge meanwhile and says "tiles do not load, trying again")
    Timeline.prototype.serviceDown = function (ok) {
        if (this.on) { this._busy = false; this._fetch(ok); }
    };
    // T40: what the play bar on the map shows (mapping.js draws it)
    Timeline.prototype.barInfo = function () {
        var idx = this.idx, f = this.frame(), s = this.status(), v = this._view();
        var ls = this.playing ? this._load() : null;
        var loading = !!(ls && ls.n && ls.k < ls.n && !ls.full && s.state !== 'down');
        var sub = s.state === 'down' ? tr('mapt.precip.st_down')
            : (loading && ls.down) ? tr('mapt.precip.st_retry')
            : loading ? tr('mapt.precip.st_preload', { k: ls.k, n: ls.n })
            : (v.small && !v.back) ? tr('mapt.precip.bar_small') : rainText(idx, s.age);
        return {
            playing: this.playing, canPlay: !!(idx && idx.frames.length >= 2),
            label: f ? badgeText(idx, f) : tr('mapt.precip.title'),
            sub: sub, subTip: (sub && sub === rainText(idx, s.age)) ? tr('mapt.precip.rain_tip') : '', warn: s.state === 'down' || s.state === 'stale',
            nowcast: !!(f && f.kind === 'nowcast'), back: !!v.back, hot: !v.back && !!v.small,
        };
    };
    Timeline.prototype._changed = function () { if (this.o.onRender) { this.o.onRender(); } };

    Timeline.prototype._renderView = function () {
        if (!this.b_fit) { return; }
        var v = this._view();
        var back = !!v.back;
        this.b_fit.textContent = tr(back ? 'mapt.precip.back' : 'mapt.precip.fit');
        this.b_fit.title = tr(back ? 'mapt.precip.back_tip' : 'mapt.precip.fit_tip');
        this.b_fit.disabled = !this.idx && !back;
        // too close: the button is the way out, in the info colour
        this.b_fit.classList.toggle('is-hot', !back && !!v.small);
        var h = back && v.auto ? tr('mapt.precip.hint_zoomed') : (v.small ? tr('mapt.precip.hint_small') : '');
        if (this.e_hint.textContent !== h) { this.e_hint.textContent = h; }
        this.e_hint.hidden = !h;
        this._changed();
    };

    Timeline.prototype.relabel = function () {
        if (!this.b_play) { return; }
        this.b_now.textContent = tr('mapt.precip.now_btn');
        this.b_now.title = tr('mapt.precip.now_tip');
        this.in_range.setAttribute('aria-label', tr('mapt.precip.slider'));
        this._render();
        this._renderLegend();
    };

    Timeline.prototype._render = function () {
        if (!this.b_play) { return; }
        var idx = this.idx, f = this.frame();
        var pl = this.playing;
        this.b_play.textContent = pl ? '❚❚' : '▶';
        var pt = tr(pl ? 'mapt.precip.pause' : 'mapt.precip.play');
        this.b_play.title = pt;
        this.b_play.setAttribute('aria-label', pt);
        this.b_play.setAttribute('aria-pressed', pl ? 'true' : 'false');
        this.b_play.disabled = !idx || idx.frames.length < 2;
        var n = idx ? idx.frames.length : 0;
        this.in_range.max = String(Math.max(0, n - 1));
        this.in_range.disabled = n < 2;
        var i = find(idx, this.selId);
        if (i >= 0) { this.in_range.value = String(i); }
        // the track: observations | nowcast, the "now" mark at the newest observation
        var li = idx ? idx.latestIdx : -1;
        var nowPos = (n > 1 && li >= 0) ? li / (n - 1) : 1;
        var pct = (Math.round(nowPos * 1000) / 10) + '%';
        this.e_obs.style.width = pct;
        this.e_nc.style.left = pct;
        this.e_nc.style.width = 'calc(100% - ' + pct + ')';
        this.e_tnow.style.left = pct;
        this.e_t0.textContent = (idx && n) ? relText(relMin(idx, idx.frames[0])) : '';
        this.e_tnow.textContent = li >= 0 ? tr('mapt.precip.rel_now') : '';
        var lastF = n ? idx.frames[n - 1] : null;
        this.e_t1.textContent = (lastF && lastF.kind === 'nowcast') ? relText(relMin(idx, lastF)) : '';
        this.e_tnow.hidden = !(li > 0 && li < n - 1);
        // the mark spans the track between the thumb's end positions (9 px in)
        this.e_nowmark.style.left = 'calc(9px + (100% - 18px) * ' + (Math.round(nowPos * 1000) / 1000) + ')';
        this.e_nowmark.hidden = this.e_tnow.hidden;
        this._fixTicks();
        // time + kind of the frame on screen
        this.e_time.textContent = f ? hhmm(f.epoch) : '--:--';
        var k = this.e_kind;
        k.className = 'vt-precip-kind';
        if (!f) { k.textContent = ''; }
        else if (f.kind === 'nowcast') {
            k.textContent = tr('mapt.precip.kind_nowcast', { m: relText(relMin(idx, f)) });
            k.classList.add('is-nowcast');
        } else if (i === li) {
            k.textContent = tr('mapt.precip.kind_latest');
        } else {
            k.textContent = tr('mapt.precip.kind_past', { m: relText(relMin(idx, f)) });
        }
        if (this.o.mount) { this.o.mount.classList.toggle('is-nowcast', !!(f && f.kind === 'nowcast')); }
        this._renderState();
        // sources that fail right now (the mosaic goes on with the others)
        var bad = failing(idx);
        this.e_fail.hidden = !bad.length;
        this.e_fail.textContent = bad.length ? tr('mapt.precip.src_fail', { list: bad.join(', ') }) : '';
        // T40: sources without data (answer, but nothing to give) — named
        // with since when, not counted as an error
        var nd = noData(idx);
        this.e_nodata.hidden = !nd.length;
        this.e_nodata.textContent = nd.length ? tr('mapt.precip.src_nodata', {
            list: nd.map(function (x) { return x.since ? x.name + ' (' + tr('mapt.precip.since', { t: sinceText(x.since) }) + ')' : x.name; }).join(', '),
        }) : '';
        this._renderView();
        // credits of this frame, linked
        var a = this.e_attr;
        a.innerHTML = '';
        credits(idx, f).forEach(function (c, ci) {
            if (ci) { a.appendChild(document.createTextNode(' · ')); }
            if (c.url) {
                var l = el('a', '', c.text);
                l.href = c.url; l.target = '_blank'; l.rel = 'noopener noreferrer';
                a.appendChild(l);
            } else {
                a.appendChild(document.createTextNode(c.text));
            }
        });
        // already on the newest picture and following it: nothing to go back to
        this.b_now.disabled = !idx || (this.follow && i === li && !pl);
    };

    // state: age of the newest observation, outage; while the playback
    // preloads: "loading k/n" (T40)
    Timeline.prototype._renderState = function () {
        var st = this.e_state;
        if (!st) { return; }
        var s = this.status(), ls = this.playing ? this._load() : null;
        var loading = !!(ls && ls.n && ls.k < ls.n && !ls.full && s.state !== 'down');
        var txt = (loading && ls.down) ? tr('mapt.precip.st_retry')
            : loading ? tr('mapt.precip.st_preload', { k: ls.k, n: ls.n })
            : s.state === 'down' ? tr('mapt.precip.st_down')
            : s.state === 'loading' ? tr('common.loading')
            : s.state === 'empty' ? tr('mapt.precip.st_empty')
            : s.state === 'updating' ? tr('mapt.precip.st_updating')
            : s.state === 'stale' ? tr('mapt.precip.st_stale', { m: Math.round(s.age / 60) })
            : tr('mapt.precip.st_ok', { m: Math.round(s.age / 60) });
        if (st.textContent !== txt) { st.textContent = txt; }
        st.title = loading ? tr('mapt.precip.st_preload_tip') : s.state === 'down' ? tr('mapt.precip.st_down_tip') : txt;
        var warn = !loading && (s.state === 'down' || s.state === 'stale');
        st.classList.toggle('vt-tone-warn', warn);
        st.classList.toggle('vt-dim', !warn);
        var rt = s.state === 'down' ? '' : rainText(this.idx, s.age);
        if (this.e_rain.textContent !== rt) { this.e_rain.textContent = rt; this.e_rain.title = rt ? tr('mapt.precip.rain_tip') : ''; }
        this.e_rain.hidden = !rt;
        this._changed();
    };

    // the end labels under the slider must not run into "now" (a narrow
    // phone, "now" close to the end): the one that would touch it goes
    Timeline.prototype._fixTicks = function () {
        var t0 = this.e_t0, tn = this.e_tnow, t1 = this.e_t1;
        t0.hidden = false; t1.hidden = false;
        if (tn.hidden || !tn.getBoundingClientRect) { return; }
        var bn = tn.getBoundingClientRect();
        if (!bn.width) { return; }        // not laid out (card hidden)
        var b1 = t1.getBoundingClientRect(), b0 = t0.getBoundingClientRect();
        if (b1.width && bn.right + 4 > b1.left) { t1.hidden = true; }
        if (b0.width && b0.right + 4 > bn.left) { t0.hidden = true; }
    };

    Timeline.prototype._renderLegend = function () {
        var box = this.e_legend, L = this.leg;
        if (!box) { return; }
        box.innerHTML = '';
        if (!L || !L.rain.length) { box.hidden = true; return; }
        box.hidden = false;
        var bar = function (bins, label, cls) {
            var row = el('div', 'vt-precip-lrow ' + cls);
            row.appendChild(el('span', 'vt-precip-lname vt-fs-xs', label));
            var b = el('span', 'vt-precip-bar');
            bins.forEach(function (bn) {
                var c = el('span', 'vt-precip-bin');
                c.style.background = bn.css;
                c.title = (bn.max === null ? '≥ ' + bn.min : bn.min + '–' + bn.max) + ' ' + L.unit;
                b.appendChild(c);
            });
            row.appendChild(b);
            return row;
        };
        box.appendChild(bar(L.rain, tr('mapt.precip.leg_rain'), 'is-rain'));
        var marks = el('div', 'vt-precip-marks vt-fs-xs vt-dim vt-tnum');
        marks.setAttribute('aria-hidden', 'true');
        L.marks.forEach(function (mk) {
            var s = el('span', '', String(mk.v).replace('.', langOf() === 'cs' ? ',' : '.'));
            s.style.left = (Math.round(mk.pos * 1000) / 10) + '%';
            marks.appendChild(s);
        });
        var unit = el('span', 'vt-precip-unit', L.unit);
        marks.appendChild(unit);
        box.appendChild(marks);
        if (L.snow.length) { box.appendChild(bar(L.snow, tr('mapt.precip.leg_snow'), 'is-snow')); }
    };

    // the small label on the map: which time the layer shows
    function badgeText(idx, f) {
        if (!f) { return ''; }
        var m = relMin(idx, f);
        // T40d: in the bar too — measured "now" / "−30 min", or nowcast "+20 min"
        return f.kind === 'nowcast' ? tr('mapt.precip.badge_nowcast', { t: hhmm(f.epoch), m: relText(m) })
            : tr('mapt.precip.badge_obs', { t: hhmm(f.epoch), m: m === 0 ? tr('mapt.precip.rel_now') : relText(m) });
    }

    var api = {
        PORT: PORT, STALE_S: STALE_S, parseIndex: parseIndex, vOf: vOf, serviceNow: serviceNow, base: base, tileUrl: tileUrl, find: find,
        pick: pick, state: state, relMin: relMin, legend: legend, credits: credits, failing: failing,
        noData: noData, rainText: rainText, rainWhen: rainWhen, plan: plan, nextReady: nextReady, leadReady: leadReady, Preload: Preload, SMALL_VIEW_M: SMALL_VIEW_M, PLAY_MAX_Z: PLAY_MAX_Z,
        hash: hash, Timeline: Timeline, badgeText: badgeText, relText: relText,
    };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.VTPrecip = api; }
})(typeof window !== 'undefined' ? window : null);
