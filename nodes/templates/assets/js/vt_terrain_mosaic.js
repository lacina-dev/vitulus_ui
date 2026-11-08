/* vt_terrain_mosaic.js — map layer "Mowed area terrain" (T30, 2026-11-08).
 *
 * The terrain map of a whole mowed area, made offline from the mowing
 * recordings (vitulus_traversability terrain_mosaic) and stored on the robot
 * per site; the webnode serves it read-only:
 *   GET /api/terrain_mosaic          the served site's mosaics, newest first:
 *                                    georeference (frame map, resolution, width,
 *                                    height, yaw, origin_x / origin_y = the min
 *                                    corner, PNG row 0 = max y), files, stats
 *   GET /api/terrain_mosaic/<file>   its PNGs (ETag, no-cache)
 * Drawn flat on the ground in the map frame (as the live layer Traversability),
 * under it. Three views: TRAVERSABILITY (cost colours, the mosaic's own RGBA),
 * REASON (codes 0–7 as /traversability/ui), HEIGHT (16-bit elevation, mm + 1,
 * decoded here: a canvas would round 16 bits to 8). Its own opacity.
 *
 * Cost: one GET of the list and of the view's PNG when the layer comes on or
 * the view changes (a few hundred kB once); nothing while off; nothing goes
 * to the robot but these GETs.
 *
 * Loaded by vt_map_layers.js (no index.html change). Controls, mirrored by the
 * layers panel: #mapv3_chk_tmosaic (Map tab layers row, remembered),
 * #mapv3_tmosaic_mode (cost | reason | height), #mapv3_tmosaic_op (opacity),
 * #mapv3_ov_tmosaic_st (short state). Pure part (PNG 16-bit decoding,
 * colours, placement) tested in node: tools/test_terrain_mosaic.node.js.
 * i18n: tmos.* (block "// T30"). ROS3D bundles its own THREE (r89).
 */
(function (root) {
    'use strict';

    var LS_ON = 'vitulus_layer_tmosaic', LS_MODE = 'vitulus_layer_tmosaic_mode', LS_OP = 'vitulus_layer_tmosaic_op';
    var MODES = ['cost', 'reason', 'height'];
    var REASON = {
        0: [0, 0, 0, 0], 1: [76, 175, 80, 120], 2: [255, 193, 7, 210], 3: [156, 39, 176, 235],
        4: [41, 98, 255, 235], 5: [229, 57, 53, 240], 6: [149, 117, 205, 210], 7: [158, 158, 158, 180],
    };

    // ---- pure ------------------------------------------------------------
    function paeth(a, b, c) {
        var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    }
    // a PNG's chunks: {w, h, depth, color, interlace, idat (Uint8Array, still deflated)} or null
    function pngChunks(buf) {
        var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        var sig = [137, 80, 78, 71, 13, 10, 26, 10];
        for (var i = 0; i < 8; i++) { if (u[i] !== sig[i]) { return null; } }
        var dv = new DataView(u.buffer, u.byteOffset, u.byteLength), p = 8, out = { idat: [] }, n = 0;
        while (p + 8 <= u.length) {
            var len = dv.getUint32(p), type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
            var d = u.subarray(p + 8, p + 8 + len);
            if (type === 'IHDR') {
                out.w = dv.getUint32(p + 8); out.h = dv.getUint32(p + 12);
                out.depth = u[p + 16]; out.color = u[p + 17]; out.interlace = u[p + 20];
            } else if (type === 'IDAT') { out.idat.push(d); n += d.length; }
            else if (type === 'IEND') { break; }
            p += 12 + len;
        }
        var all = new Uint8Array(n), q = 0;
        out.idat.forEach(function (c) { all.set(c, q); q += c.length; });
        out.idat = all;
        return out.w ? out : null;
    }
    // the inflated scanlines of a 16-bit grey PNG -> Uint16Array (row 0 = top)
    function unfilterGray16(raw, w, h) {
        var stride = w * 2, out = new Uint16Array(w * h), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
        for (var y = 0; y < h; y++) {
            var f = raw[y * (stride + 1)], o = y * (stride + 1) + 1;
            for (var x = 0; x < stride; x++) {
                var a = x >= 2 ? cur[x - 2] : 0, b = prev[x], c = x >= 2 ? prev[x - 2] : 0, v = raw[o + x];
                cur[x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 255;
            }
            for (var i = 0; i < w; i++) { out[y * w + i] = (cur[2 * i] << 8) | cur[2 * i + 1]; }
            var t = prev; prev = cur; cur = t;
        }
        return out;
    }
    // elevation (mm + 1, 0 = unknown) -> RGBA: blue lowest … pale … brown highest
    function heightColor(v, lo, hi) {
        if (!v) { return [0, 0, 0, 0]; }
        var f = hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
        var A = [30, 136, 229, 225], B = [245, 245, 220, 200], C = [121, 85, 72, 235];
        var k = f < 0.5 ? f * 2 : (f - 0.5) * 2, p = f < 0.5 ? A : B, q = f < 0.5 ? B : C;
        return [Math.round(p[0] + (q[0] - p[0]) * k), Math.round(p[1] + (q[1] - p[1]) * k), Math.round(p[2] + (q[2] - p[2]) * k), Math.round(p[3] + (q[3] - p[3]) * k)];
    }
    // the known range of an elevation array (robust: 1st–99th percentile)
    function heightRange(a) {
        var vals = [];
        for (var i = 0; i < a.length; i += Math.max(1, Math.floor(a.length / 20000))) { if (a[i]) { vals.push(a[i]); } }
        if (!vals.length) { return null; }
        vals.sort(function (x, y) { return x - y; });
        return { lo: vals[Math.floor(vals.length * 0.01)], hi: vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))] };
    }
    // where the raster lies in the map frame: centre, size, turn (about the min corner)
    function placement(g) {
        if (!g || !(g.resolution > 0) || !(g.width > 0) || !(g.height > 0)) { return null; }
        var w = g.width * g.resolution, h = g.height * g.resolution, yaw = +g.yaw || 0, c = Math.cos(yaw), s = Math.sin(yaw);
        return { cx: +g.origin_x + c * w / 2 - s * h / 2, cy: +g.origin_y + s * w / 2 + c * h / 2, w: w, h: h, yaw: yaw };
    }
    function reasonColor(code) { return REASON[code] || REASON[0]; }

    var api = { pngChunks: pngChunks, unfilterGray16: unfilterGray16, heightColor: heightColor, heightRange: heightRange,
                placement: placement, reasonColor: reasonColor, REASON: REASON, MODES: MODES };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (typeof document === 'undefined') { if (root) { root.VTTerrainMosaic = api; } return; }

    // ---- browser -----------------------------------------------------------
    function t(k, v) { return root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function $(id) { return document.getElementById(id); }
    function viewer3d() { return (root.viewer && root.viewer.viewer) || null; }

    var S = { chk: null, mode: null, op: null, st: null, state: 'off', list: null, m: null, listAt: 0,
              group: null, mesh: null, tex: null, canvas: null, ctx: null, cache: {}, seq: 0, hRange: null,
              heightOk: typeof DecompressionStream !== 'undefined' };

    function ensureControls() {
        if (S.chk) { return true; }
        var row = document.querySelector('.map-layers-row');
        if (!row) { return false; }
        var div = document.createElement('div');
        div.className = 'form-check form-check-inline vt-tmos-ctl';
        div.setAttribute('data-i18n-title', 'tmos.layer_tip');
        div.title = t('tmos.layer_tip');
        div.innerHTML = '<input class="form-check-input" type="checkbox" id="mapv3_chk_tmosaic">' +
            '<label class="form-check-label vt-fs-sm" for="mapv3_chk_tmosaic"><span data-i18n="tmos.layer">' + t('tmos.layer') +
            '</span> <span class="vt-sw-trav">&#9632;</span></label>' +
            '<span hidden><select id="mapv3_tmosaic_mode"><option value="cost">cost</option><option value="reason">reason</option>' +
            '<option value="height">height</option></select><input type="range" id="mapv3_tmosaic_op" min="0" max="1" step="0.05">' +
            '<span id="mapv3_ov_tmosaic_st"></span></span>';
        row.appendChild(div);
        S.chk = $('mapv3_chk_tmosaic'); S.mode = $('mapv3_tmosaic_mode'); S.op = $('mapv3_tmosaic_op'); S.st = $('mapv3_ov_tmosaic_st');
        S.chk.checked = lsGet(LS_ON) === '1';
        var md = lsGet(LS_MODE); S.mode.value = MODES.indexOf(md) >= 0 ? md : 'cost';
        var op = parseFloat(lsGet(LS_OP)); S.op.value = String(op >= 0 && op <= 1 ? op : 0.85);
        S.chk.addEventListener('change', function () { lsSet(LS_ON, S.chk.checked ? '1' : '0'); sync(); });
        S.mode.addEventListener('change', function () { lsSet(LS_MODE, S.mode.value); draw(); tell(); });
        S.op.addEventListener('input', function () { lsSet(LS_OP, S.op.value); applyOpacity(); });
        tell();
        return true;
    }
    function tell() { try { document.dispatchEvent(new CustomEvent('vt:map-sources')); } catch (e) { /* old browser */ } }
    function setState(st) {
        if (st === S.state) { return; }
        S.state = st;
        if (S.st) { S.st.textContent = (S.chk && S.chk.checked) ? t('tmos.st.' + st) : ''; }
        tell();
    }

    function sync() {
        var on = !!(S.chk && S.chk.checked);
        if (!on) { if (S.group) { S.group.visible = false; } setState('off'); return; }
        if (S.list && Date.now() - S.listAt < 60000) { draw(); return; }
        setState('loading');
        fetch('/api/terrain_mosaic', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (j) {
            S.list = (j && Array.isArray(j.mosaics)) ? j.mosaics : [];
            S.listAt = Date.now();
            S.m = S.list[0] || null;
            if (!S.m) { setState('nomap'); if (S.group) { S.group.visible = false; } return; }
            draw();
        }).catch(function () { S.list = null; setState('error'); });
    }

    function viewMode() {
        var m = S.mode ? S.mode.value : 'cost', f = S.m ? S.m.files : {};
        if (m === 'height' && (!f.elevation16 || !S.heightOk)) { m = 'cost'; }
        if (m === 'reason' && !f.reason) { m = 'cost'; }
        if (m === 'cost' && !f.cost_rgba && !f.cost) { m = f.reason ? 'reason' : 'cost'; }
        return m;
    }
    function get(name, kind) {
        var key = name + '|' + kind;
        if (S.cache[key]) { return S.cache[key]; }
        var url = '/api/terrain_mosaic/' + encodeURIComponent(name);
        var pr = kind === 'img' ? new Promise(function (res, rej) {
            var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = url;
        }) : fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) { throw new Error(r.status); } return r.arrayBuffer(); });
        S.cache[key] = pr;
        pr.catch(function () { delete S.cache[key]; });
        return pr;
    }
    function inflate(u8) {
        return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    }

    // paint the view into the canvas (w x h = the raster), then place the plane
    function draw() {
        var m = S.m, g = m && m.georef;
        if (!m || !(S.chk && S.chk.checked)) { return; }
        var mode = viewMode(), seq = ++S.seq, f = m.files;
        setState('loading');
        var job;
        if (mode === 'height') {
            job = get(f.elevation16, 'buf').then(function (buf) {
                var c = pngChunks(buf);
                if (!c || c.depth !== 16 || c.color !== 0 || c.interlace) { throw new Error('png'); }
                return inflate(c.idat).then(function (raw) {
                    var a = unfilterGray16(new Uint8Array(raw), c.w, c.h), rg = heightRange(a);
                    S.hRange = rg;
                    return paint(c.w, c.h, function (i) { return heightColor(a[i], rg ? rg.lo : 0, rg ? rg.hi : 0); });
                });
            });
        } else if (mode === 'reason') {
            job = get(f.reason, 'img').then(function (im) {
                var px = grey(im);
                return paint(im.naturalWidth, im.naturalHeight, function (i) { return reasonColor(px[i * 4]); });
            });
        } else if (f.cost_rgba) {
            job = get(f.cost_rgba, 'img').then(function (im) {
                return paint(im.naturalWidth, im.naturalHeight, null, im);
            });
        } else {
            job = Promise.reject(new Error('nofile'));
        }
        job.then(function () {
            if (seq !== S.seq) { return; }
            var pl = placement(g);
            if (!pl || !S.mesh) { setState('error'); return; }
            S.mesh.scale.set(pl.w, pl.h, 1);
            S.mesh.position.set(pl.cx, pl.cy, 0.008);
            S.mesh.rotation.z = pl.yaw;
            S.group.visible = !!(S.chk && S.chk.checked);
            applyOpacity();
            setState('ok');
        }).catch(function () { if (seq === S.seq) { setState('error'); } });
    }
    function grey(im) {
        var cv = grey.cv || (grey.cv = document.createElement('canvas'));
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        var cx = cv.getContext('2d', { willReadFrequently: true });
        cx.clearRect(0, 0, cv.width, cv.height); cx.drawImage(im, 0, 0);
        return cx.getImageData(0, 0, cv.width, cv.height).data;
    }
    function paint(w, h, colorOf, img) {
        if (!ensureMesh(w, h)) { throw new Error('3d'); }
        if (img) {
            S.ctx.clearRect(0, 0, w, h);
            S.ctx.drawImage(img, 0, 0);
        } else {
            var im = S.ctx.createImageData(w, h), d = im.data;
            for (var i = 0, n = w * h; i < n; i++) {
                var c = colorOf(i), k = i * 4;
                d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = c[3];
            }
            S.ctx.putImageData(im, 0, 0);
        }
        S.tex.needsUpdate = true;
    }
    function ensureMesh(w, h) {
        var V = viewer3d(), T = root.ROS3D && ROS3D.THREE;
        if (!V || !T) { return false; }
        if (!S.group) { S.group = new T.Object3D(); V.scene.add(S.group); }
        if (!S.mesh || S.canvas.width !== w || S.canvas.height !== h) {
            if (S.mesh) { S.group.remove(S.mesh); S.mesh.geometry.dispose(); S.mesh.material.dispose(); S.tex.dispose(); }
            S.canvas = S.canvas || document.createElement('canvas');
            S.canvas.width = w; S.canvas.height = h;
            S.ctx = S.canvas.getContext('2d');
            S.tex = new T.Texture(S.canvas);
            S.tex.magFilter = T.NearestFilter; S.tex.minFilter = T.LinearFilter; S.tex.generateMipmaps = false;
            S.mesh = new T.Mesh(new T.PlaneGeometry(1, 1),
                new T.MeshBasicMaterial({ map: S.tex, transparent: true, depthWrite: false, depthTest: false }));
            var MLO = (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder : null;
            // over the maps, right under the live layer Traversability (DIRECT + 0.5)
            S.mesh.renderOrder = (MLO && MLO.DIRECT !== undefined ? MLO.DIRECT : 21) + 0.3;
            S.mesh.frustumCulled = false;
            S.group.add(S.mesh);
        }
        return true;
    }
    function applyOpacity() {
        if (!S.mesh) { return; }
        var op = S.op ? parseFloat(S.op.value) : 0.85;
        S.mesh.material.opacity = (op >= 0 && op <= 1) ? op : 0.85;
    }

    // for the panel
    function info() {
        var f = S.m ? S.m.files : {};
        return { state: S.state, mode: viewMode(), mosaic: S.m, hRange: S.hRange,
                 views: { cost: !!(f.cost_rgba), reason: !!f.reason, height: !!f.elevation16 && S.heightOk } };
    }

    function init() {
        if (!$('map_view')) { return; }
        var hook = setInterval(function () {
            if (!ensureControls() || !viewer3d()) { return; }
            clearInterval(hook);
            sync();
        }, 500);
        if (root.VTI18n && root.VTI18n.onChange) {
            root.VTI18n.onChange(function () { var s = S.state; S.state = ''; setState(s); });
        }
    }

    api.info = info; api.sync = sync; api._S = S;
    root.VTTerrainMosaic = api;
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})(typeof window !== 'undefined' ? window : this);
