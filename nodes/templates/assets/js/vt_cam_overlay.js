/* vt_cam_overlay.js — overlays on the camera image (2026-10-18).
 *
 * Draws, on top of the camera view (small in the right panel or large in the
 * C's hollow), any of: Lidar (/scan), Obstacles and Free (the obstacle
 * segmentation clouds) and Depth (the aligned depth image, colour-mapped).
 * The robot does the geometry: node vitulus_ui/camera_overlay projects the
 * data into the camera's pixels (camera_info + TF at the data / image stamps,
 * like the RViz Camera display) and only while a layer here is on — every
 * layer off = no subscription = the node does nothing.
 *
 *   /camera_overlay/scan|obstacles|free   std_msgs/UInt8MultiArray (rosbridge
 *        sends it base64): '<4sHHIdd' header (magic VCO1, image w, h, n,
 *        data stamp, image stamp) + n x '<HHH' (u px, v px, depth mm)
 *   /camera_overlay/depth                 bgr8 image, streamed as MJPEG by
 *        web_video_server like the camera; black = no depth, blended with
 *        'screen' so black stays transparent
 *
 * Choices (layers + opacity) are remembered per browser (localStorage, guarded).
 * window.VTCamOverlay = { state(), set(layer, on), opacity(v), inject(layer, b64|Uint8Array) }
 */
(function () {
    'use strict';
    var LS = 'vitulus_cam_overlay';
    var LAYERS = [
        // id, label key, colour (UI palette: accent / error / OK), tooltip key
        ['scan', 'cam.layer.scan', '#0dcaf0', 'cam.layer.scan.tip'],
        ['obstacles', 'cam.layer.obstacles', '#ff5f6d', 'cam.layer.obstacles.tip'],
        ['free', 'cam.layer.free', '#43d58b', 'cam.layer.free.tip'],
        ['depth', 'cam.layer.depth', null, 'cam.layer.depth.tip']
    ];
    /* set the text / attribute now and follow every language switch */
    function tag(e, k, attr) {
        if (window.VTI18n) { VTI18n.tag(e, k, attr); }
        else if (attr) { e.setAttribute(attr, k); } else { e.textContent = k; }
    }
    var STALE_MS = 1500;          // a layer whose data stopped is not drawn
    var st = load();
    var host = null, wrap = null, ui = null, cnv = null, ctx = null, img = null, btn = null, menu = null;
    var subs = {}, data = {}, rafId = 0, lastBox = '';

    function load() {
        var s = {scan: false, obstacles: false, free: false, depth: false, opacity: 0.75};
        try {
            var j = JSON.parse(localStorage.getItem(LS) || '{}');
            LAYERS.forEach(function (l) { if (typeof j[l[0]] === 'boolean') { s[l[0]] = j[l[0]]; } });
            if (typeof j.opacity === 'number' && j.opacity >= 0.1 && j.opacity <= 1) { s.opacity = j.opacity; }
        } catch (e) {}
        return s;
    }
    function save() { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) {} }
    function anyOn() { return LAYERS.some(function (l) { return st[l[0]]; }); }

    function cam() { return window.camera_view || null; }
    function camActive() {
        var cv = cam();
        return !!(cv && cv._active && !document.hidden && host && host.style.display !== 'none');
    }
    function rosOf() { return (window.ros && window.ros.ros) || null; }

    // ------------------------------------------------------------- DOM
    function el(tag, cls, parent) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (parent) { parent.appendChild(e); }
        return e;
    }
    function stop(ev) { ev.stopPropagation(); }

    function build() {
        host = document.getElementById('div_camera_view');
        if (!host || wrap) { return !!wrap; }
        /* a wrapper, not a direct child canvas: '#div_camera_view > canvas'
           rules size the camera canvas and must not touch ours */
        wrap = el('div', 'vco-wrap', host);
        img = el('img', 'vco-depth', wrap);
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        cnv = el('canvas', 'vco-pts', wrap);
        ctx = cnv.getContext('2d');

        /* the button and the menu ride on the image's box too (in L the
           host is wider than the image) */
        ui = el('div', 'vco-ui', host);
        btn = el('button', 'vco-btn', ui);
        btn.type = 'button';
        tag(btn, 'cam.btn.tip', 'title');
        tag(btn, 'cam.overlays', 'aria-label');
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
            '<path d="M12 3 2 8l10 5 10-5-10-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
            '<path d="m2 12 10 5 10-5M2 16l10 5 10-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); toggleMenu(); });

        menu = el('div', 'vco-menu', ui);
        menu.setAttribute('role', 'group');
        tag(menu, 'cam.overlays', 'aria-label');
        menu.style.display = 'none';
        ['click', 'pointerdown', 'mousedown', 'touchstart'].forEach(function (t) {
            menu.addEventListener(t, stop, {passive: true});
        });
        var row = el('div', 'vco-chips', menu);
        LAYERS.forEach(function (l) {
            var b = el('button', 'vco-chip', row);
            b.type = 'button';
            b.setAttribute('data-layer', l[0]);
            tag(b, l[3], 'title');
            var dot = el('span', 'vco-dot', b);
            if (l[2]) { dot.style.background = l[2]; } else { dot.classList.add('vco-dot-depth'); }
            tag(el('span', '', b), l[1]);
            b.addEventListener('click', function (ev) { ev.stopPropagation(); set(l[0], !st[l[0]]); });
        });
        var op = el('label', 'vco-op', menu);
        tag(el('span', '', op), 'cam.opacity');
        var rng = el('input', '', op);
        rng.type = 'range'; rng.min = '10'; rng.max = '100'; rng.step = '5';
        rng.value = String(Math.round(st.opacity * 100));
        tag(rng, 'cam.opacity.aria', 'aria-label');
        rng.addEventListener('input', function () { opacity(+rng.value / 100); });
        var hq = el('button', 'vco-help', op);
        hq.type = 'button';
        hq.textContent = '?';
        tag(hq, 'cam.help', 'title');
        tag(hq, 'cam.help', 'aria-label');
        hq.addEventListener('click', function (ev) {
            ev.stopPropagation();
            toggleMenu(false);
            if (window.VTHelp && VTHelp.open) { VTHelp.open('frame', 'camera-overlays'); }
        });
        document.addEventListener('click', function (ev) {
            if (menu.style.display !== 'none' && !menu.contains(ev.target) && ev.target !== btn) { toggleMenu(false); }
        });
        paint();
        return true;
    }

    function toggleMenu(open) {
        if (!menu) { return; }
        if (typeof open !== 'boolean') { open = menu.style.display === 'none'; }
        menu.style.display = open ? '' : 'none';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.classList.toggle('on', open || anyOn());
    }

    function paint() {
        if (!menu) { return; }
        Array.prototype.forEach.call(menu.querySelectorAll('.vco-chip'), function (b) {
            var on = !!st[b.getAttribute('data-layer')];
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        btn.classList.toggle('on', anyOn() || menu.style.display !== 'none');
        wrap.style.setProperty('--vco-op', String(st.opacity));
    }

    // ------------------------------------------------------------ data
    function b64bytes(s) {
        if (s instanceof Uint8Array) { return s; }
        if (Array.isArray(s)) { return new Uint8Array(s); }
        var bin = atob(s || ''), n = bin.length, out = new Uint8Array(n);
        for (var i = 0; i < n; i++) { out[i] = bin.charCodeAt(i); }
        return out;
    }
    function decode(bytes) {
        if (bytes.length < 28) { return null; }
        var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (dv.getUint8(0) !== 86 || dv.getUint8(1) !== 67 || dv.getUint8(2) !== 79 || dv.getUint8(3) !== 49) { return null; }
        var w = dv.getUint16(4, true), h = dv.getUint16(6, true), n = dv.getUint32(8, true);
        n = Math.min(n, Math.floor((bytes.length - 28) / 6));
        var pts = new Uint16Array(n * 3);
        for (var i = 0, o = 28; i < n * 3; i++, o += 2) { pts[i] = dv.getUint16(o, true); }
        return {w: w, h: h, n: n, pts: pts, t: Date.now()};
    }
    function onMsg(layer, m) {
        var d = null;
        try { d = decode(b64bytes(m && m.data)); } catch (e) { d = null; }
        if (!d) { return; }
        data[layer] = d;
        schedule();
    }

    function subscribe(layer) {
        var r = rosOf();
        if (!r || subs[layer] || typeof ROSLIB === 'undefined') { return; }
        var t = new ROSLIB.Topic({ros: r, name: '/camera_overlay/' + layer,
                                  messageType: 'std_msgs/UInt8MultiArray',
                                  throttle_rate: 150, queue_length: 1});
        t.subscribe(function (m) { onMsg(layer, m); });
        subs[layer] = t;
    }
    function unsubscribe(layer) {
        if (subs[layer]) { try { subs[layer].unsubscribe(); } catch (e) {} delete subs[layer]; }
        delete data[layer];
    }

    function depthUrl() {
        var cv = cam();
        var hostn = (cv && cv.host) || location.hostname, port = (cv && cv.port) || 8080;
        return 'http://' + hostn + ':' + port + '/stream?topic=/camera_overlay/depth&type=mjpeg' +
            '&quality=50&width=320&height=240&killcache=' + Date.now();
    }

    /* subscribe exactly what is on and visible; everything else off */
    function sync() {
        if (!build()) { return; }
        var live = camActive();
        ['scan', 'obstacles', 'free'].forEach(function (l) {
            if (live && st[l]) { subscribe(l); } else { unsubscribe(l); }
        });
        var wantDepth = live && st.depth;
        var has = (img.getAttribute('src') || '').indexOf('/camera_overlay/depth') >= 0;
        if (wantDepth && !has) { img.src = depthUrl(); }
        else if (!wantDepth && has) { img.removeAttribute('src'); img.src = ''; img.removeAttribute('src'); }
        img.style.display = wantDepth ? '' : 'none';
        wrap.style.display = (live && anyOn()) ? '' : 'none';
        ui.style.display = live ? '' : 'none';
        if (!live) { toggleMenu(false); }
        if (live) { place(); }
        schedule();
    }

    // ------------------------------------------------------------ drawing
    /* the overlay box = the camera canvas's box inside the host (S: the
       slot, L: centred in the hollow with margins) */
    function place() {
        // The camera canvas is the host's own <canvas> child — not the first
        // child: the overlay divs sit in front of it, and a camera reload
        // appends a new canvas after them (live 18. 10.: points never drawn).
        var c = null;
        for (var k = host ? host.firstElementChild : null; k; k = k.nextElementSibling) {
            if (k.tagName === 'CANVAS') { c = k; break; }
        }
        if (!c) { return false; }
        var box = c.offsetLeft + ',' + c.offsetTop + ',' + c.offsetWidth + ',' + c.offsetHeight;
        if (box !== lastBox) {
            lastBox = box;
            [wrap, ui].forEach(function (e) {
                e.style.left = c.offsetLeft + 'px';
                e.style.top = c.offsetTop + 'px';
                e.style.width = c.offsetWidth + 'px';
                e.style.height = c.offsetHeight + 'px';
            });
        }
        return c.offsetWidth > 0 && c.offsetHeight > 0;
    }

    function schedule() {
        if (rafId) { return; }
        rafId = (window.requestAnimationFrame || setTimeout)(draw);
    }

    function draw() {
        rafId = 0;
        if (!wrap || !place() || wrap.style.display === 'none') { return; }
        var W = wrap.clientWidth, H = wrap.clientHeight;
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var cw = Math.round(W * dpr), ch = Math.round(H * dpr);
        if (cnv.width !== cw || cnv.height !== ch) { cnv.width = cw; cnv.height = ch; }
        ctx.clearRect(0, 0, cw, ch);
        var now = Date.now();
        // free under obstacles under lidar
        [['free', '#43d58b', 0.8], ['obstacles', '#ff5f6d', 1.0], ['scan', '#0dcaf0', 1.2]].forEach(function (L) {
            var d = data[L[0]];
            if (!st[L[0]] || !d || now - d.t > STALE_MS || !d.w || !d.h) { return; }
            var sx = cw / d.w, sy = ch / d.h;
            var base = Math.max(1.5 * dpr, Math.min(cw / 640 * 2.4, 5 * dpr)) * L[2];
            ctx.fillStyle = L[1];
            ctx.globalAlpha = st.opacity;
            var p = d.pts;
            for (var i = 0; i < d.n; i++) {
                var z = p[i * 3 + 2] / 1000;
                var s = base * (z > 0 ? Math.max(0.6, Math.min(1.4, 2.5 / z)) : 1);
                ctx.fillRect(p[i * 3] * sx - s / 2, p[i * 3 + 1] * sy - s / 2, s, s);
            }
        });
        ctx.globalAlpha = 1;
    }

    // ------------------------------------------------------------ API
    function set(layer, on) {
        if (!(layer in st) || layer === 'opacity') { return; }
        st[layer] = !!on;
        save();
        paint();
        sync();
    }
    function opacity(v) {
        st.opacity = Math.max(0.1, Math.min(1, +v || 0.75));
        save();
        paint();
        schedule();
    }

    function init() {
        if (!build()) { setTimeout(init, 500); return; }
        sync();
        // the camera starts / stops / resizes without telling anyone: a cheap
        // poll keeps subscriptions and the box in step (nothing is drawn or
        // subscribed while the camera is off)
        setInterval(function () {
            sync();
            if (wrap && wrap.style.display !== 'none') { schedule(); }
        }, 700);
        window.addEventListener('resize', schedule);
        document.addEventListener('visibilitychange', sync);
        document.addEventListener('rosconnected', function () {
            Object.keys(subs).forEach(unsubscribe);
            sync();
        });
        img.addEventListener('error', function () {
            // web_video_server not ready / topic not there yet: retry later
            if (st.depth && camActive()) {
                setTimeout(function () { if (st.depth && camActive()) { img.src = depthUrl(); } }, 4000);
            }
        });
    }

    window.VTCamOverlay = {
        state: function () { return JSON.parse(JSON.stringify(st)); },
        set: set,
        opacity: opacity,
        open: function () { toggleMenu(true); },
        inject: function (layer, b) { onMsg(layer, {data: b}); },
        _subs: function () { return Object.keys(subs); }
    };
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); }); }
    else { setTimeout(init, 0); }
})();
