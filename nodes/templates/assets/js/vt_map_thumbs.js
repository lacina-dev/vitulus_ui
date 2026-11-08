/* vt_map_thumbs.js — small pictures of a program's zones (T17 M7, 2026-11-08).
 *
 * Programs: each program card gets a small picture of its zones — the zone
 * polygons from the robot's map (the planner's program list) over the same
 * background map the Map tab shows (same catalog, same choice, the aerial
 * photo by default). With the background off, no datum, or MapProxy not
 * answering, the picture is the shape alone on a neutral ground.
 *
 * Cost, by design:
 *   - lazy: a card is drawn when it scrolls into view (IntersectionObserver),
 *     a card nobody looks at asks for nothing;
 *   - ONE zoom level per card, at most 2 x 2 tiles (MAX_TILES_CARD), and all
 *     thumbnails of one source together make at most MAX_TILES_SOURCE tile
 *     requests per page (then a coarser level, then the shape alone). Zones of
 *     one garden share their tiles, so 20 programs usually need a handful;
 *   - shared with the main map: a tile the 3D map already holds (its texture
 *     cache, mapping.js) is drawn from there with no request; the rest uses
 *     the very same tile URL and CORS mode as the main map, so the browser
 *     cache serves both;
 *   - nothing goes to the robot: no ROS, only GET of tiles from the robot's
 *     MapProxy (the same as the main map) and, when the main map has not
 *     fetched it yet, GET /api/datum of the robot's webnode. No other service.
 *
 * Reads mapping.js state only through pure getters (chk_aerial, _aerialBase,
 * _aerialTileUrl, _currentTileOffset, aerial_datum, _baseNone, _tcache);
 * nothing there is changed.
 *
 * The pure part (projection, zoom choice, tile plan, budget) has no DOM and is
 * tested in node: tools/test_map_thumbs.node.js.
 */
(function (root) {
    'use strict';

    var TILE = 256;
    var MAX_TILES_CARD = 4;      // one zoom level per card: at most 2 x 2 tiles
    var MAX_TILES_SOURCE = 32;   // tile requests of all thumbnails of one source per page
    var ZMAX = 20;               // finer is pointless for a 64 px picture
    var PAD = 0.14;              // margin around the zones (share of their size)
    var MIN_EXT_M = 8;           // a tiny zone is shown at least this wide (m)
    var MERC0 = 156543.03392;    // m per pixel of zoom 0 at the equator

    // ---- pure ----------------------------------------------------------------

    function metersPerDeg(latDeg) {
        var phi = latDeg * Math.PI / 180.0;
        return {
            mLat: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi),
            mLon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi),
        };
    }

    // the map's rotation vs TRUE north (rad, CCW) — the same as mapping.js _mapTrueYaw
    function trueYaw(d) {
        var yaw = d.yaw_rad || 0.0;
        if (d.origin_lat == null || d.origin_lon == null) { return yaw; }
        var lon0 = (d.utm_zone || 33) * 6 - 183;
        var phi = d.origin_lat * Math.PI / 180.0;
        var dl = (d.origin_lon - lon0) * Math.PI / 180.0;
        return yaw - Math.atan(Math.tan(dl) * Math.sin(phi));
    }

    // a map point (m) -> lon/lat, the inverse of how mapping.js lays the tiles:
    // the tile group is shifted by the alignment offset `off` (map frame) and
    // turned by -trueYaw, so a map point p sits over tile ground R(+yaw)(p - off)
    function mapToLonLat(d, x, y, off) {
        var yaw = trueYaw(d), c = Math.cos(yaw), s = Math.sin(yaw);
        var px = x - ((off && off.dx) || 0), py = y - ((off && off.dy) || 0);
        var e = c * px - s * py, n = s * px + c * py;
        var m = metersPerDeg(d.origin_lat);
        return { lon: d.origin_lon + e / m.mLon, lat: d.origin_lat + n / m.mLat };
    }

    // lon/lat -> pixel of the whole world at zoom 0 (256 px wide), y down
    function world0(lon, lat) {
        var latR = lat * Math.PI / 180.0;
        return {
            x: (lon + 180) / 360 * TILE,
            y: (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * TILE,
        };
    }

    function bbox(rings) {
        var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 };
        rings.forEach(function (r) {
            r.forEach(function (p) {
                if (!isFinite(p.x) || !isFinite(p.y)) { return; }
                b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x);
                b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y);
                b.n++;
            });
        });
        return b.n ? b : null;
    }

    // rings (arrays of {x, y}) that have at least 3 points
    function cleanRings(rings) {
        return (rings || []).map(function (r) {
            return (r || []).filter(function (p) { return p && isFinite(p.x) && isFinite(p.y); });
        }).filter(function (r) { return r.length >= 3; });
    }

    // Fit points (any planar frame, y up when yUp) into w x h with a margin:
    // returns {k: px per unit, ox, oy: frame point at the picture's top-left}.
    function fit(b, w, h, minExt, yUp) {
        var bw = Math.max(b.x1 - b.x0, minExt), bh = Math.max(b.y1 - b.y0, minExt);
        var k = Math.min(w / (bw * (1 + 2 * PAD)), h / (bh * (1 + 2 * PAD)));
        var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        return { k: k, cx: cx, cy: cy, ox: cx - w / (2 * k), oy: yUp ? cy + h / (2 * k) : cy - h / (2 * k) };
    }

    // The shape alone (no datum / no background): map metres, north up (the
    // map frame is true-north ENU on the robot, #32). -> rings in CSS px.
    function planShape(rings, w, h) {
        rings = cleanRings(rings);
        var b = bbox(rings);
        if (!b) { return null; }
        var f = fit(b, w, h, MIN_EXT_M, true);
        return {
            rings: rings.map(function (r) {
                return r.map(function (p) { return [(p.x - f.ox) * f.k, (f.oy - p.y) * f.k]; });
            }),
            mpp: 1 / f.k,
        };
    }

    // The tile range at zoom z that covers the picture (fit f in zoom-0 pixels).
    function rangeAt(f, w, h, z) {
        var s = Math.pow(2, z) / TILE, eps = 1e-9;
        var x0 = Math.floor(f.ox * s), x1 = Math.floor((f.ox + w / f.k) * s - eps);
        var y0 = Math.floor(f.oy * s), y1 = Math.floor((f.oy + h / f.k) * s - eps);
        var n = Math.pow(2, z);
        x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(n - 1, x1); y1 = Math.min(n - 1, y1);
        return { x0: x0, x1: x1, y0: y0, y1: y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
    }

    // Shape + tiles: rings (map m) over the background map.
    // o = {w, h, dpr, maxZoom, maxTiles, off}. -> {z, rings (CSS px),
    // tiles: [{z, x, y, left, top, size}], zWant} or null (no points / datum).
    // Zoom: the level whose pixels match the picture's device pixels (z0+k
    // rounding), never above the source's max zoom or ZMAX, then coarser
    // until the picture needs at most maxTiles tiles.
    function planTiles(rings, d, o) {
        if (!d || d.origin_lat == null || d.origin_lon == null) { return null; }
        rings = cleanRings(rings);
        if (!rings.length) { return null; }
        var w = o.w, h = o.h, dpr = Math.max(1, o.dpr || 1);
        var pr = rings.map(function (r) {
            return r.map(function (p) { var ll = mapToLonLat(d, p.x, p.y, o.off); return world0(ll.lon, ll.lat); });
        });
        var b = bbox(pr);
        if (!b) { return null; }
        var mpp0 = MERC0 * Math.max(0.05, Math.cos(d.origin_lat * Math.PI / 180.0));
        var f = fit(b, w, h, MIN_EXT_M / mpp0, false);
        var zTop = Math.min(ZMAX, (o.maxZoom >= 0) ? o.maxZoom : ZMAX);
        var zWant = Math.max(0, Math.min(zTop, Math.round(Math.log(f.k * dpr) / Math.LN2)));
        var cap = o.maxTiles > 0 ? o.maxTiles : MAX_TILES_CARD;
        var z = zWant, rg = rangeAt(f, w, h, z);
        while (rg.count > cap && z > 0) { z--; rg = rangeAt(f, w, h, z); }
        return {
            z: z, zWant: zWant, mpp: mpp0 / f.k,
            rings: pr.map(function (r) {
                return r.map(function (p) { return [(p.x - f.ox) * f.k, (p.y - f.oy) * f.k]; });
            }),
            tilesAt: function (zz) {
                var r = rangeAt(f, w, h, zz), out = [], size = TILE / Math.pow(2, zz) * f.k;
                for (var ty = r.y0; ty <= r.y1; ty++) {
                    for (var tx = r.x0; tx <= r.x1; tx++) {
                        out.push({ z: zz, x: tx, y: ty, size: size,
                                   left: (tx * TILE / Math.pow(2, zz) - f.ox) * f.k,
                                   top: (ty * TILE / Math.pow(2, zz) - f.oy) * f.k });
                    }
                }
                return out;
            },
        };
    }

    // Request budget per source: urls asked so far (a url asked again — the
    // browser cache — does not count twice).
    function Budget(max) { this.max = max > 0 ? max : MAX_TILES_SOURCE; this.asked = {}; }
    Budget.prototype._set = function (src) { return this.asked[src] || (this.asked[src] = {}); };
    Budget.prototype.fresh = function (src, urls) {
        var s = this._set(src);
        return urls.filter(function (u) { return !s[u]; }).length;
    };
    Budget.prototype.fits = function (src, urls) {
        var s = this._set(src);
        return Object.keys(s).length + this.fresh(src, urls) <= this.max;
    };
    Budget.prototype.take = function (src, urls) {
        var s = this._set(src);
        urls.forEach(function (u) { s[u] = 1; });
    };
    Budget.prototype.count = function (src) { return Object.keys(this._set(src)).length; };

    // Pick the tiles of a plan within the budget: the planned zoom, or one or
    // two levels coarser; null = the shape alone. urlOf(tile) -> url;
    // cached(url) -> true when it costs no request (main map texture).
    function chooseTiles(plan, srcId, budget, urlOf, cached) {
        for (var z = plan.z; z >= Math.max(0, plan.z - 2); z--) {
            var tiles = plan.tilesAt(z);
            tiles.forEach(function (t) { t.url = urlOf(t); });
            var need = tiles.filter(function (t) { return !(cached && cached(t.url)); })
                            .map(function (t) { return t.url; });
            if (budget.fits(srcId, need)) { budget.take(srcId, need); return tiles; }
        }
        return null;
    }

    // zone polygons of a program message (vitulus_msgs/PlannerProgram)
    function programRings(program) {
        return ((program && program.zone_list) || []).map(function (z) {
            var pts = (z && z.polygon && z.polygon.polygon && z.polygon.polygon.points) || [];
            return pts.map(function (p) { return { x: +p.x, y: +p.y }; });
        });
    }

    var api = {
        TILE: TILE, MAX_TILES_CARD: MAX_TILES_CARD, MAX_TILES_SOURCE: MAX_TILES_SOURCE, ZMAX: ZMAX,
        metersPerDeg: metersPerDeg, trueYaw: trueYaw, mapToLonLat: mapToLonLat, world0: world0,
        planShape: planShape, planTiles: planTiles, Budget: Budget, chooseTiles: chooseTiles,
        programRings: programRings, cleanRings: cleanRings,
    };

    // ---- browser -------------------------------------------------------------
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
        if (root) { root.VTMapThumbs = api; }
        return;
    }

    var budget = new Budget(MAX_TILES_SOURCE);
    var imgs = new Map();         // url -> {img, st: 0 loading | 1 ok | 2 failed, cbs}
    var stats = { requests: 0, mainCache: 0, loaded: 0, failed: 0, drawn: 0 };
    var hosts = [];               // [{el, provider}]
    var io = null;
    var ownDatum = null, ownDatumAt = 0, datumAsk = null;

    function M() { return window.mapping_v3 || null; }

    // the tile the 3D map already holds (no request) — read-only peek
    function mainTexImage(url) {
        try {
            var C = M() && M()._tcache;
            var e = C && C.map && C.map.get(url);
            var im = e && e.tex && e.tex.image;
            return (im && (im.naturalWidth || im.width) > 1) ? im : null;
        } catch (e) { return null; }
    }

    // what the background map is now: {src, datum, off, urlOf} or null (shape alone)
    function env() {
        var m = M();
        if (!m) { return null; }
        try {
            if (!(m.chk_aerial && m.chk_aerial.checked)) { return null; }
            if (m._baseNone === true) { return null; }     // no tile at all loads (offline)
            var src = m._aerialBase && m._aerialBase();
            if (!src) { return null; }
            var d = m.aerial_datum || ownDatum;
            var off = { dx: 0, dy: 0 };
            try { off = m._currentTileOffset() || off; } catch (e) { /* no offsets yet */ }
            return {
                src: src, datum: d, off: off,
                urlOf: function (t) { return m._aerialTileUrl(src, t.z, t.x, t.y); },
            };
        } catch (e) { return null; }
    }

    // the robot's datum when the main map has not fetched it (background on,
    // map tab never built yet) — one GET to this webnode, at most once a minute
    function askDatum() {
        if (datumAsk || (Date.now() - ownDatumAt < 60000)) { return; }
        ownDatumAt = Date.now();
        try {
            datumAsk = fetch('/api/datum', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (dj) {
                    datumAsk = null;
                    if (dj && dj.ok !== false && dj.origin_lat != null) { ownDatum = dj; refresh(); }
                })
                .catch(function () { datumAsk = null; });
        } catch (e) { datumAsk = null; }
    }

    var used = {};                // distinct tile urls the pictures drew (stats)
    function loadTile(url, cb) {
        used[url] = 1;
        var im = mainTexImage(url);
        if (im) { stats.mainCache++; cb(im); return; }
        var e = imgs.get(url);
        if (e && e.st === 1) { cb(e.img); return; }
        // a failed tile (MapProxy offline: HTTP 500 outside its cache) is not
        // asked again for a minute; then it may come
        if (e && e.st === 2 && Date.now() - e.at < 60000) { cb(null); return; }
        if (e && e.st === 0) { e.cbs.push(cb); return; }
        e = { img: new Image(), st: 0, cbs: [cb] };
        imgs.set(url, e);
        stats.requests++;
        e.img.crossOrigin = 'anonymous';           // the main map's mode: one cache entry
        e.img.decoding = 'async';
        e.img.onload = function () { e.st = 1; stats.loaded++; var c = e.cbs; e.cbs = []; c.forEach(function (f) { f(e.img); }); };
        e.img.onerror = function () {
            e.st = 2; e.at = Date.now(); stats.failed++;
            var c = e.cbs; e.cbs = []; c.forEach(function (f) { f(null); });
        };
        e.img.src = url;
    }

    // the tokens, read once (getComputedStyle right after the cards were
    // written would force a style pass per picture); again after refresh()
    var pal = null;
    function palette() {
        if (pal) { return pal; }
        var cs = null;
        try { cs = getComputedStyle(document.documentElement); } catch (e) { cs = null; }
        var v = function (name, dflt) { var x = cs ? cs.getPropertyValue(name).trim() : ''; return x || dflt; };
        pal = {
            // the zone colours of the planner's program drawing (run_path.py ZONE_COLORS)
            zones: [v('--vt-zone-1', '#0dcaf0'), v('--vt-zone-2', '#ffc208'),
                    v('--vt-zone-3', '#e866ff'), v('--vt-zone-4', '#8cf059')],
            bg: v('--vt-zonepic-bg', '#2f3a43'),
            rim: v('--vt-zonepic-rim', 'rgba(0, 0, 0, 0.55)'),
        };
        return pal;
    }

    function paint(cv, w, h, dpr, rings, tiles, onPhoto) {
        var ctx = cv.getContext('2d');
        if (!ctx) { return; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        var P = palette();
        ctx.fillStyle = P.bg;
        ctx.fillRect(0, 0, w, h);
        (tiles || []).forEach(function (t) {
            if (!t.img) { return; }
            try { ctx.drawImage(t.img, t.left, t.top, t.size, t.size); } catch (e) { /* broken image */ }
        });
        var cols = P.zones;
        ctx.lineJoin = 'round';
        rings.forEach(function (r, i) {
            if (r.length < 3) { return; }
            ctx.beginPath();
            r.forEach(function (p, j) { if (j) { ctx.lineTo(p[0], p[1]); } else { ctx.moveTo(p[0], p[1]); } });
            ctx.closePath();
            var col = cols[i % cols.length];
            ctx.globalAlpha = onPhoto ? 0.22 : 0.30;
            ctx.fillStyle = col;
            ctx.fill();
            ctx.globalAlpha = 1;
            if (onPhoto) {          // a dark rim under the line: readable on a photo
                ctx.lineWidth = 3;
                ctx.strokeStyle = P.rim;
                ctx.stroke();
            }
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = col;
            ctx.stroke();
        });
        stats.drawn++;
    }

    // size: {w, h} in CSS px (from the observer's box, so no layout is forced)
    function draw(el, provider, size) {
        var rings = cleanRings(provider(el.getAttribute('data-thumb')));
        if (!rings.length) { el.setAttribute('data-shape', '0'); return; }
        el.setAttribute('data-shape', '1');
        var cv = el.querySelector('canvas');
        if (!cv) { cv = document.createElement('canvas'); el.insertBefore(cv, el.firstChild); }
        var w = (size && size.w) || el.clientWidth || 64, h = (size && size.h) || el.clientHeight || 48;
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); }
        if (cv.height !== Math.round(h * dpr)) { cv.height = Math.round(h * dpr); }
        var gen = (el._vtThumbGen || 0) + 1;
        el._vtThumbGen = gen;
        var E = env();
        var plan = null;
        if (E && !E.datum) { askDatum(); }
        if (E && E.datum) {
            plan = planTiles(rings, E.datum, { w: w, h: h, dpr: dpr, maxZoom: E.src.max_zoom, off: E.off });
        }
        var tiles = plan && chooseTiles(plan, E.src.id, budget, E.urlOf, function (u) { return !!mainTexImage(u) || imgs.has(u); });
        el.setAttribute('data-bg', tiles ? 'map' : 'none');
        if (!tiles) {
            var s = planShape(rings, w, h);
            if (s) { paint(cv, w, h, dpr, s.rings, null, false); }
            return;
        }
        // tiles already here (main map / earlier pictures) paint at once;
        // otherwise the shape now (same framing) and the background when its
        // tiles have come
        var left = tiles.length;
        tiles.forEach(function (t) {
            loadTile(t.url, function (img) {
                t.img = img;
                if (--left === 0 && el._vtThumbGen === gen) {
                    var any = tiles.some(function (x) { return !!x.img; });
                    el.setAttribute('data-bg', any ? 'map' : 'none');
                    paint(cv, w, h, dpr, plan.rings, tiles, any);
                }
            });
        });
        if (left > 0) { paint(cv, w, h, dpr, plan.rings, null, false); }
    }

    // pictures that came into view are drawn a few per task, so a list that
    // opens with many cards never makes one long task (the phone stays smooth)
    var queue = [], pumping = false;
    function enqueue(el, h, size) {
        queue.push([el, h, size]);
        if (!pumping) { pumping = true; setTimeout(pump, 0); }
    }
    function pump() {
        var t0 = Date.now();
        while (queue.length && Date.now() - t0 < 8) {
            var q = queue.shift();
            if (!document.body.contains(q[0])) { continue; }
            try { draw(q[0], q[1].provider, q[2]); }
            catch (e) { console.warn('[thumbs] draw failed:', e); }
        }
        if (queue.length) { setTimeout(pump, 0); } else { pumping = false; }
    }

    function observer() {
        if (io || typeof window.IntersectionObserver !== 'function') { return io; }
        io = new window.IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (!en.isIntersecting) { return; }
                io.unobserve(en.target);
                var h = hostOf(en.target), r = en.boundingClientRect;
                // the canvas fills the padding box: the box minus the 1 px border
                if (h) { enqueue(en.target, h, r && r.width > 4 ? { w: Math.round(r.width) - 2, h: Math.round(r.height) - 2 } : null); }
            });
        }, { rootMargin: '120px 0px' });
        return io;
    }
    function hostOf(el) {
        for (var i = 0; i < hosts.length; i++) {
            if (hosts[i].el.contains(el)) { return hosts[i]; }
        }
        return null;
    }
    function watch(h) {
        var els = h.el.querySelectorAll('.vt-thumb[data-thumb]');
        var O = observer();
        Array.prototype.forEach.call(els, function (el) {
            if (O) { O.observe(el); }
            else {
                try { draw(el, h.provider); } catch (e) { console.warn('[thumbs] draw failed:', e); }
            }
        });
    }

    // host: element holding .vt-thumb[data-thumb] spans (drawn again whenever
    // the host's content was replaced: call bind again); provider(key) ->
    // rings [[{x, y}, …], …] in map metres (zone i gets colour i).
    function bind(host, provider) {
        if (!host || typeof provider !== 'function') { return; }
        var h = null;
        for (var i = 0; i < hosts.length; i++) { if (hosts[i].el === host) { h = hosts[i]; } }
        if (!h) { h = { el: host, provider: provider }; hosts.push(h); }
        h.provider = provider;
        watch(h);
    }

    // the background changed (source, on/off, datum): draw the visible cards again
    var refreshTimer = null;
    function refresh() {
        if (refreshTimer) { clearTimeout(refreshTimer); }
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            pal = null;
            hosts.forEach(function (h) {
                if (!document.body.contains(h.el)) { return; }
                if (io) {
                    Array.prototype.forEach.call(h.el.querySelectorAll('.vt-thumb[data-thumb]'), function (el) {
                        io.unobserve(el); io.observe(el);       // visible ones fire again
                    });
                } else { watch(h); }
            });
        }, 200);
    }
    document.addEventListener('vt:map-sources', refresh);
    // another site / a datum captured / a new tile alignment (mapping.js
    // _georefChanged): a datum fetched here may be the old one
    document.addEventListener('vt:map-georef', function (ev) {
        var why = ev && ev.detail && ev.detail.why;
        if (why === 'site' || why === 'datum') { ownDatum = null; ownDatumAt = 0; }
        refresh();
    });
    document.addEventListener('change', function (ev) {
        var id = ev.target && ev.target.id;
        if (id === 'mapv3_chk_aerial' || id === 'mapv3_aerial_src') { refresh(); }
    }, true);

    api.bind = bind;
    api.refresh = refresh;
    api.stats = function () {
        var o = {};
        Object.keys(stats).forEach(function (k) { o[k] = stats[k]; });
        o.used = Object.keys(used).length;
        o.asked = {};
        Object.keys(budget.asked).forEach(function (k) { o.asked[k] = budget.count(k); });
        return o;
    };
    root.VTMapThumbs = api;
})(typeof window !== 'undefined' ? window : this);
