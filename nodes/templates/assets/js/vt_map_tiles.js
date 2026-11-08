/* vt_map_tiles.js — the pure part of the MapProxy tile layers (T17 M3).
 *
 * mapping.js draws the background map and the overlays as one plane per
 * XYZ tile. This file holds what does not need the DOM or three.js, so it
 * can be tested in node (tools/test_map_tiles.node.js):
 *
 *   - tile maths: does tile A overlap tile B (any zooms), the ancestor of a
 *     tile, which tiles of a range lie under a tile, the order to load a
 *     range in (view centre first);
 *   - budgets per device: how many tiles all layers may use together and how
 *     much GPU memory the tile textures may take (a phone gets less);
 *   - TexCache: the shared cache of tile textures. A texture used by a plane
 *     holds a reference; one no plane uses stays cached (so a view seen a
 *     moment ago, or the same tile in the next build, paints at once, with no
 *     request) until the idle limit or the hard limit evicts it, oldest
 *     first. The hard limit counts every cached texture, in use or not;
 *   - offline fill: the plain white tile MapProxy sends without internet,
 *     a cache-busting URL and the outage bookkeeping that reloads the tiles
 *     once the network / robot / MapProxy is back.
 */
(function (root) {
    'use strict';

    var MB = 1024 * 1024;

    // GPU bytes of one RGBA texture, with the mipmap chain (+1/3) when it has one
    function texBytes(w, h, mip) {
        var b = Math.max(1, w | 0) * Math.max(1, h | 0) * 4;
        return Math.round(mip ? b * 4 / 3 : b);
    }

    // tile {z,x,y} as a square in tile units of zoom z
    function span(t, z) {
        var s = Math.pow(2, z - t.z);
        return { x0: t.x * s, x1: (t.x + 1) * s, y0: t.y * s, y1: (t.y + 1) * s };
    }

    // do two tiles (any zooms) overlap?
    function overlaps(a, b) {
        var z = Math.max(a.z, b.z), A = span(a, z), B = span(b, z);
        return A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1;
    }

    // the tile dz levels coarser that contains t
    function ancestor(t, dz) {
        var s = Math.pow(2, dz);
        return { z: t.z - dz, x: Math.floor(t.x / s), y: Math.floor(t.y / s) };
    }

    // tiles of zoom z inside `range` {tx0,tx1,ty0,ty1} that lie under tile t
    // (inclusive bounds) or null when none do
    function under(t, z, range) {
        var x0, x1, y0, y1;
        if (t.z <= z) {
            var S = span(t, z);
            x0 = S.x0; x1 = S.x1 - 1; y0 = S.y0; y1 = S.y1 - 1;
        } else {
            var a = ancestor(t, t.z - z);
            x0 = x1 = a.x; y0 = y1 = a.y;
        }
        x0 = Math.max(x0, range.tx0); x1 = Math.min(x1, range.tx1);
        y0 = Math.max(y0, range.ty0); y1 = Math.min(y1, range.ty1);
        return (x0 <= x1 && y0 <= y1) ? { x0: x0, x1: x1, y0: y0, y1: y1 } : null;
    }

    // [x, y] of every tile in `range`, nearest to (cx, cy) first (fractional
    // tile coordinates of the view centre at the range's zoom)
    function orderByDistance(range, cx, cy) {
        var out = [];
        for (var x = range.tx0; x <= range.tx1; x++) {
            for (var y = range.ty0; y <= range.ty1; y++) {
                var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
                out.push([x, y, dx * dx + dy * dy]);
            }
        }
        out.sort(function (p, q) { return p[2] - q[2]; });
        return out.map(function (p) { return [p[0], p[1]]; });
    }

    // Limits per device. A 256 px tile texture with mipmaps is ~0.35 MB.
    //   desktop: 600 tiles for all layers (~210 MB at worst), the background
    //            map at most 400; textures at most 240 MB, unused ones 32 MB
    //   phone / tablet (coarse pointer): 240 tiles (~84 MB), the background
    //            map at most 160; textures at most 96 MB, unused ones 16 MB
    function budgets(env) {
        var mobile = !!(env && env.coarse);
        return mobile
            ? { mobile: true, tileBudget: 240, baseCap: 160, hardBytes: 96 * MB, idleBytes: 16 * MB }
            : { mobile: false, tileBudget: 600, baseCap: 400, hardBytes: 240 * MB, idleBytes: 32 * MB };
    }

    // The most detailed zoom used for a source. `sel` = the Detail choice:
    // 'auto' (or empty) = the source's max_zoom on a desktop, one level less
    // on a phone / tablet (coarse pointer: Google z20, ČÚZK z19), so the
    // background map does not take the phone's tile budget and the overlays
    // keep their detail (ředitel 2026-11-08, until the owner decides); a
    // number = a manual cap, the same on every device, never above max_zoom.
    function zoomCap(maxZoom, sel, env) {
        var mz = Math.max(0, maxZoom | 0);
        if (sel === 'auto' || sel === '' || sel == null) {
            return (env && env.coarse) ? Math.max(0, mz - 1) : mz;
        }
        var n = parseInt(sel, 10);
        return (n >= 0) ? Math.min(mz, n) : mz;
    }

    // Phone with overlays on (ředitel 2026-11-08). The tile budget of a phone
    // (240) cannot hold the background map at the screen's device pixels and
    // five overlays too, so on a coarse pointer:
    //   - the background map may use at most HALF the budget while any
    //     overlay is on (it then steps to a coarser zoom as a whole: no holes;
    //     its line says "tile limit"). Half, not budget/(1+overlays): with five
    //     overlays that would be 40 tiles = z18 for a 300 m view, too coarse,
    //     while half (120) keeps it at z19 there;
    //   - overlays aim at CSS pixels, not device pixels (thin lines and tones
    //     gain little from the extra level), tone overlays (layer_order
    //     'under': relief, slope — smooth rasters) one level coarser still.
    //   At a 300 m view on 390x844 DPR 2: map z19 ~45 tiles, three line
    //   overlays z19 ~45 each, two tones z18 ~15 each = ~210 of 240.
    // A desktop (fine pointer) is unchanged.
    function baseShare(budget, env, overlaysOn) {
        return (env && env.coarse && overlaysOn > 0) ? Math.floor(budget / 2) : budget;
    }
    // the adaptive zoom an overlay aims at; zAdaptive is in device pixels,
    // dpr = the map's pixel ratio (1-2)
    function overlayWant(zAdaptive, src, env, dpr) {
        if (!(env && env.coarse) || !isFinite(zAdaptive)) { return zAdaptive; }
        var shift = Math.max(0, Math.round(Math.log(Math.max(1, dpr || 1)) / Math.LN2));
        var tone = src && src.layer_order === 'under' ? 1 : 0;
        return Math.max(0, zAdaptive - shift - tone);
    }

    // ---- offline fill (docker-mapproxy M4) ----------------------------------
    // Without internet MapProxy answers tiles it does not have with a fill:
    // its old cache, a magnified coarser level, or a plain white tile — all
    // HTTP 200, max-age 3600 and one constant ETag, so the browser keeps them
    // even after the network is back.

    // the plain white fill: every pixel opaque white (RGBA bytes)
    function isBlankWhite(px) {
        if (!px || !px.length) { return false; }
        for (var i = 0; i + 3 < px.length; i += 4) {
            if (px[i] !== 255 || px[i + 1] !== 255 || px[i + 2] !== 255 || px[i + 3] !== 255) {
                return false;
            }
        }
        return true;
    }

    // url + a cache-busting parameter (token 0/empty = the url as it is)
    function withBust(url, token) {
        if (!token) { return url; }
        return url + (url.indexOf('?') < 0 ? '?' : '&') + 'r=' + token;
    }

    // Outage bookkeeping: mark() when tiles fail, come white, the browser
    // goes offline or the robot connection drops; recovered() when the
    // network / robot is back or a tile that failed loads for real. It says
    // true once per outage (and not sooner than minGapMs after the last
    // refresh): then every tile on the map is loaded again past the browser
    // cache. `pending` = recovered but too soon: ask again after `retryIn(now)`.
    function Outage(opts) {
        this.minGap = (opts && opts.minGapMs > 0) ? opts.minGapMs : 20000;
        this.down = false;
        this.since = 0;
        this.last = -Infinity;
        this.pending = false;
    }
    Outage.prototype.mark = function (now) {
        if (!this.down) { this.down = true; this.since = now; }
    };
    Outage.prototype.recovered = function (now) {
        if (!this.down) { return false; }
        if (now - this.last < this.minGap) { this.pending = true; return false; }
        this.down = false; this.pending = false; this.last = now;
        return true;
    };
    Outage.prototype.retryIn = function (now) {
        return Math.max(0, this.minGap - (now - this.last));
    };

    // ---- texture cache -----------------------------------------------------
    // opts: { dispose(tex), idleBytes, hardBytes }
    function TexCache(opts) {
        opts = opts || {};
        this.dispose = opts.dispose || function () {};
        this.idleCap = opts.idleBytes > 0 ? opts.idleBytes : 64 * MB;
        this.hardCap = opts.hardBytes > 0 ? opts.hardBytes : 256 * MB;
        this.map = new Map();        // key -> {tex, bytes, refs}; order = LRU (oldest first)
        this.bytes = 0;              // every cached texture
        this.idle = 0;               // those no plane uses
        this.evicted = 0;
    }
    TexCache.prototype.has = function (k) { return this.map.has(k); };
    TexCache.prototype.get = function (k) {
        var e = this.map.get(k);
        if (e) { this.map.delete(k); this.map.set(k, e); }   // most recently used
        return e || null;
    };
    // a new texture, not yet used by any plane (refs 0)
    TexCache.prototype.put = function (k, tex, bytes) {
        var old = this.map.get(k);
        if (old) {
            if (old.tex === tex) { return old; }
            this._drop(k, old);
        }
        var e = { tex: tex, bytes: bytes > 0 ? bytes : 0, refs: 0 };
        this.map.set(k, e);
        this.bytes += e.bytes;
        this.idle += e.bytes;
        return e;
    };
    TexCache.prototype.acquire = function (k) {
        var e = this.get(k);
        if (!e) { return null; }
        if (e.refs === 0) { this.idle -= e.bytes; }
        e.refs++;
        return e;
    };
    TexCache.prototype.release = function (k) {
        var e = this.map.get(k);
        if (!e || e.refs <= 0) { return; }
        e.refs--;
        if (e.refs === 0) { this.idle += e.bytes; }
    };
    TexCache.prototype._drop = function (k, e) {
        this.map.delete(k);
        this.bytes -= e.bytes;
        if (e.refs === 0) { this.idle -= e.bytes; }
        this.evicted++;
        try { this.dispose(e.tex); } catch (err) { /* best effort */ }
    };
    // evict unused textures, oldest first, until both limits hold; returns
    // true when textures in use alone still exceed the hard limit (the
    // caller then lets go of stand-in planes and trims again)
    TexCache.prototype.trim = function () {
        if (this.idle <= this.idleCap && this.bytes <= this.hardCap) { return false; }
        var self = this, victims = [];
        var idle = this.idle, bytes = this.bytes;
        this.map.forEach(function (e, k) {
            if (e.refs === 0 && (idle > self.idleCap || bytes > self.hardCap)) {
                victims.push(k); idle -= e.bytes; bytes -= e.bytes;
            }
        });
        victims.forEach(function (k) { self._drop(k, self.map.get(k)); });
        return this.bytes > this.hardCap;
    };
    TexCache.prototype.clear = function () {
        var self = this;
        Array.from(this.map.keys()).forEach(function (k) { self._drop(k, self.map.get(k)); });
    };
    TexCache.prototype.stats = function () {
        var used = 0;
        this.map.forEach(function (e) { if (e.refs > 0) { used++; } });
        return { textures: this.map.size, used: used, bytes: this.bytes, idleBytes: this.idle,
                 evicted: this.evicted, hardBytes: this.hardCap, idleCap: this.idleCap };
    };

    var api = { texBytes: texBytes, overlaps: overlaps, ancestor: ancestor, under: under,
                orderByDistance: orderByDistance, budgets: budgets, zoomCap: zoomCap, baseShare: baseShare, overlayWant: overlayWant,
                isBlankWhite: isBlankWhite, withBust: withBust, Outage: Outage, TexCache: TexCache, MB: MB };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.VTMapTiles = api; }
})(typeof window !== 'undefined' ? window : null);
