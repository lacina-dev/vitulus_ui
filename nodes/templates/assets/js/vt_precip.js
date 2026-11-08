/* vt_precip.js — the precipitation mosaic layer's time line (T20 E2).
 *
 * The robot's own precip-mosaic service (package vitulus_precip, HTTP on
 * port 8097, one map from several radars: ČHMÚ, EUMETNET OPERA, RainViewer …)
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

    // ---------------------------------------------------------------- DOM
    function tr(k, v) { return root && root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function langOf() { return (root && root.VTI18n && root.VTI18n.lang && root.VTI18n.lang()) || 'en'; }
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

        var row = el('div', 'vt-precip-row');
        this.b_play = el('button', 'btn btn-outline-info vt-precip-btn');
        this.b_play.type = 'button';
        this.b_play.id = 'mapv3_precip_play';
        this.b_play.addEventListener('click', function () { self.toggle(); });
        var sl = el('div', 'vt-precip-slide');
        this.e_track = el('div', 'vt-precip-track');
        this.e_track.setAttribute('aria-hidden', 'true');
        this.e_obs = el('span', 'vt-precip-seg-obs');
        this.e_nc = el('span', 'vt-precip-seg-nc');
        this.e_track.appendChild(this.e_obs); this.e_track.appendChild(this.e_nc);
        this.in_range = el('input', 'vt-precip-range');
        this.in_range.type = 'range';
        this.in_range.id = 'mapv3_precip_range';
        this.in_range.min = '0'; this.in_range.max = '0'; this.in_range.step = '1'; this.in_range.value = '0';
        this.in_range.addEventListener('input', function () {
            self.pause();
            self._select(parseInt(self.in_range.value, 10), true);
        });
        sl.appendChild(this.e_track); sl.appendChild(this.in_range);
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
        row.appendChild(this.b_play); row.appendChild(sl); row.appendChild(this.b_now);
        m.appendChild(row);

        this.e_legend = el('div', 'vt-precip-legend');
        m.appendChild(this.e_legend);
        this.e_fail = el('div', 'vt-precip-fail vt-fs-xs');
        this.e_fail.hidden = true;
        m.appendChild(this.e_fail);
        var foot = el('div', 'vt-precip-foot');
        this.e_attr = el('div', 'vt-precip-attr vt-fs-xs vt-dim');
        this.b_fit = el('button', 'btn btn-outline-primary btn-sm vt-precip-fit');
        this.b_fit.type = 'button';
        this.b_fit.id = 'mapv3_precip_fit';
        this.b_fit.addEventListener('click', function () { if (self.o.onFit) { self.o.onFit(self.sideKm()); } });
        foot.appendChild(this.e_attr); foot.appendChild(this.b_fit);
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

    Timeline.prototype._fetch = function () {
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
            var i = pick(idx, self.selId, self.follow, self.selEpoch);
            self._select(i, false, before);
            if (!self.leg) { self._fetchLegend(); }
        }).catch(function (e) {
            self._busy = false;
            var was = self.failed;
            self.failed = true;
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

    Timeline.prototype.play = function () {
        var idx = this.idx;
        if (!idx || idx.frames.length < 2) { return; }
        this.playing = true;
        var i = find(idx, this.selId);
        if (i >= idx.frames.length - 1) { this._select(0, true); }
        this._t0 = Date.now();
        var self = this;
        if (this._play) { clearInterval(this._play); }
        this._play = setInterval(function () { self._tick(); }, 100);
        this._render();
    };

    Timeline.prototype.pause = function () {
        if (this._play) { clearInterval(this._play); this._play = null; }
        if (this.playing) { this.playing = false; this._render(); }
    };

    Timeline.prototype._tick = function () {
        var idx = this.idx;
        if (!idx || !this.playing) { return; }
        var i = find(idx, this.selId), dt = Date.now() - this._t0;
        var last = i >= idx.frames.length - 1;
        var ready = !this.o.ready || this.o.ready();
        if (dt < (last ? STEP_MS + HOLD_MS : STEP_MS)) { return; }
        if (!ready && dt < WAIT_MS) { return; }
        this._select(last ? 0 : i + 1, true);
    };

    Timeline.prototype.relabel = function () {
        if (!this.b_play) { return; }
        this.b_now.textContent = tr('mapt.precip.now_btn');
        this.b_now.title = tr('mapt.precip.now_tip');
        this.b_fit.textContent = tr('mapt.precip.fit');
        this.b_fit.title = tr('mapt.precip.fit_tip');
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
        // state: age of the newest observation, outage
        var s = this.status(), st = this.e_state;
        var txt = s.state === 'down' ? tr('mapt.precip.st_down')
            : s.state === 'loading' ? tr('common.loading')
            : s.state === 'empty' ? tr('mapt.precip.st_empty')
            : s.state === 'stale' ? tr('mapt.precip.st_stale', { m: Math.round(s.age / 60) })
            : tr('mapt.precip.st_ok', { m: Math.round(s.age / 60) });
        st.textContent = txt;
        st.title = s.state === 'down' ? tr('mapt.precip.st_down_tip') : txt;
        st.classList.toggle('vt-tone-warn', s.state === 'down' || s.state === 'stale');
        st.classList.toggle('vt-dim', !(s.state === 'down' || s.state === 'stale'));
        // sources that fail right now (the mosaic goes on with the others)
        var bad = failing(idx);
        this.e_fail.hidden = !bad.length;
        this.e_fail.textContent = bad.length ? tr('mapt.precip.src_fail', { list: bad.join(', ') }) : '';
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
        this.b_fit.disabled = !idx;
        // already on the newest picture and following it: nothing to go back to
        this.b_now.disabled = !idx || (this.follow && i === li && !pl);
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
        return f.kind === 'nowcast' ? tr('mapt.precip.badge_nowcast', { t: hhmm(f.epoch), m: relText(m) })
                                    : tr('mapt.precip.badge', { t: hhmm(f.epoch) });
    }

    var api = {
        PORT: PORT, STALE_S: STALE_S, parseIndex: parseIndex, vOf: vOf, serviceNow: serviceNow, base: base, tileUrl: tileUrl, find: find,
        pick: pick, state: state, relMin: relMin, legend: legend, credits: credits, failing: failing,
        hash: hash, Timeline: Timeline, badgeText: badgeText, relText: relText,
    };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.VTPrecip = api; }
})(typeof window !== 'undefined' ? window : null);
