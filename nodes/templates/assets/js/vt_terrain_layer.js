/* vt_terrain_layer.js — map layer "Traversability" (T29, 2026-11-08).
 *
 * What the robot's terrain node (traversability_local, vitulus_traversability,
 * T10) sees right now: its 6 × 6 m window around the robot, 5 cm cells, drawn
 * flat on the ground in the 3D map, over the maps, under the robot and paths.
 * Three views: REASON (free / higher cost / step / slope / obstacle /
 * unconfirmed drop / dock zone), COST 0–100, HEIGHT (when the node sends it);
 * the dock's exception zones as outlines.
 *
 * Sources, in this order:
 *   1. /traversability/ui (std_msgs/String, JSON v1, contract
 *      ~/vitulus/predavka/t10-ui-kontrakt.md): grey PNGs in base64 (reason
 *      codes 0–7, cost 0–100 / 255 unknown, optional elevation cm+128 / 0
 *      unknown), the window's corner and resolution in "odom", the pose
 *      map <- odom at the data's time (no re-framing relay needed), zones;
 *   2. fallback while (1) sends nothing: /traversability/local_costmap_map_framed
 *      (nav_msgs/OccupancyGrid, the node's costmap re-framed to map by
 *      costmap_reframe_t10, a second instance of nodes/costmap_reframe started
 *      by launch/vitulus_ui.launch) — the cost view only
 *
 * Cost, by design: subscribed ONLY while the layer is ticked and the page is
 * visible (the node publishes /traversability/ui only while it has a
 * subscriber), throttle_rate 500 ms + queue_length 1; the fallback grid only
 * while (1) is silent. One texture recoloured in place (no new geometry per
 * message); the PNGs decode asynchronously, a newer message drops an older one
 * still decoding. Nothing goes to the robot: subscribe / unsubscribe only.
 *
 * Loaded by vt_map_layers.js (no index.html change). Controls (mirrored by the
 * layers panel): #mapv3_chk_trav (Map tab layers row, remembered),
 * #mapv3_trav_mode (reason | cost | height, remembered), #mapv3_ov_trav_st.
 * Opacity: the global "Maps opacity" (MapLayerOpacity), as the other grids.
 * The fallback's colours: a wrapper of ROS3D.OccupancyGrid.prototype.getColor
 * for grids whose color object carries vtTrav (map_view.js stays untouched).
 * Pure part tested in node: tools/test_terrain_layer.node.js. i18n: trav.*.
 * ROS3D bundles its own THREE (r89): ROS3D.THREE, never window.THREE.
 */
(function (root) {
    'use strict';

    var TOPIC_UI = '/traversability/ui';
    var TOPIC = '/traversability/local_costmap_map_framed';   // fallback grid
    var THROTTLE_MS = 500;
    var NODATA_MS = 6000;      // ticked this long without data: the node sends nothing
    var STALE_MS = 3000;       // no new data this long: old data (drawn faded)
    var FALLBACK_MS = 4000;    // /traversability/ui silent this long: use the grid
    var RESUB_MS = 15000;      // a subscription silent this long gets a second one (then 30 s, 60 s)
    var RESUB_MAX_MS = 60000;
    var OVERLAP_MS = 20000;    // the old subscription is dropped when the new one speaks, at the latest after this
    var LS_ON = 'vitulus_layer_trav', LS_MODE = 'vitulus_layer_trav_mode';
    var MODES = ['reason', 'cost', 'height'];
    var ELEV_SPAN_CM = 15;     // height colours saturate at ±15 cm (as the T10 pictures)

    // ---- pure ------------------------------------------------------------
    function lerp(a, b, f) { return Math.round(a + (b - a) * f); }
    function mix(c0, c1, f) { return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f), lerp(c0[3], c1[3], f)]; }
    var CLEAR = [0, 0, 0, 0];
    // cost -> RGBA: 0 free = faint green, up to 49 green → yellow-green, 50–99
    // hard = yellow → orange, 100 not passable = red, unknown (-1, 255) clear
    function costColor(v) {
        if (v === 100) { return [229, 57, 53, 235]; }
        if (v === 0) { return [76, 175, 80, 90]; }
        if (v >= 1 && v <= 49) { return mix([76, 175, 80, 110], [192, 202, 51, 160], (v - 1) / 48); }
        if (v >= 50 && v <= 99) { return mix([255, 214, 0, 190], [255, 109, 0, 225], (v - 50) / 49); }
        return CLEAR;
    }
    // reason codes of the contract -> RGBA; 0 = unknown = clear
    var REASON = {
        0: CLEAR,
        1: [76, 175, 80, 90],      // free: green, faint
        2: [255, 193, 7, 200],     // higher cost: yellow → orange by cost (reasonColor)
        3: [156, 39, 176, 235],    // step: violet
        4: [41, 98, 255, 235],     // slope: blue
        5: [229, 57, 53, 240],     // obstacle: red
        6: [149, 117, 205, 210],   // unconfirmed drop: grey-violet
        7: [158, 158, 158, 170],   // in the dock zone: grey
    };
    var REASON_KEYS = { 1: 'free', 2: 'higher', 3: 'step', 4: 'slope', 5: 'obstacle', 6: 'drop', 7: 'zone' };
    function reasonColor(code, cost) {
        if (code === 2 && cost >= 50 && cost <= 99) { return mix([255, 214, 0, 190], [255, 109, 0, 225], (cost - 50) / 49); }
        return REASON[code] || CLEAR;
    }
    // elevation byte: 0 unknown, else cm + 128; blue (lower) – pale (level) – brown (higher)
    function heightColor(v) {
        if (!(v >= 1 && v <= 254)) { return CLEAR; }
        var f = Math.max(-1, Math.min(1, (v - 128) / ELEV_SPAN_CM));
        return f < 0 ? mix([245, 245, 220, 170], [30, 136, 229, 230], -f) : mix([245, 245, 220, 170], [121, 85, 72, 235], f);
    }
    // one view of the window as RGBA bytes in PNG row order (row 0 = highest y);
    // src = {reason, cost, elevation}: one value a cell, or null. -> null when
    // the view has no data
    function colorize(mode, src, n, out) {
        var R = src.reason, C = src.cost, E = src.elevation;
        if ((mode === 'height' && !E) || (mode === 'cost' && !C) || (mode === 'reason' && !R)) { return null; }
        out = (out && out.length === n * 4) ? out : new Uint8ClampedArray(n * 4);
        for (var i = 0; i < n; i++) {
            var c = mode === 'height' ? heightColor(E[i]) : mode === 'cost' ? costColor(C[i]) : reasonColor(R[i], C ? C[i] : 0);
            var k = i * 4;
            out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2]; out[k + 3] = c[3];
        }
        return out;
    }
    // a message of the contract -> a checked object, or null
    function parse(text) {
        var m;
        try { m = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
        if (!m || typeof m !== 'object' || m.v !== 1) { return null; }
        var w = m.width | 0, h = m.height | 0, res = +m.resolution;
        if (!(w > 0 && h > 0 && w * h <= 640 * 640) || !(res > 0 && res < 10)) { return null; }
        if (!Array.isArray(m.origin) || !isFinite(+m.origin[0]) || !isFinite(+m.origin[1])) { return null; }
        if (typeof m.reason !== 'string' || typeof m.cost !== 'string' || !m.reason || !m.cost) { return null; }
        var map = m.map && isFinite(+m.map.x) && isFinite(+m.map.y) && isFinite(+m.map.yaw)
            ? { x: +m.map.x, y: +m.map.y, yaw: +m.map.yaw } : null;
        var zones = Array.isArray(m.zones) ? m.zones.filter(function (z) {
            return Array.isArray(z) && z.length >= 3 && z.every(function (p) { return Array.isArray(p) && isFinite(+p[0]) && isFinite(+p[1]); });
        }).slice(0, 16) : [];
        return {
            stamp: +m.stamp || 0, res: res, w: w, h: h, ox: +m.origin[0], oy: +m.origin[1], map: map,
            reason: m.reason, cost: m.cost, elevation: (typeof m.elevation === 'string' && m.elevation) ? m.elevation : null,
            zones: zones, counts: (m.counts && typeof m.counts === 'object') ? m.counts : null,
        };
    }
    // a point of the frame ("odom") in the map frame
    function toMap(map, x, y) {
        var c = Math.cos(map.yaw), s = Math.sin(map.yaw);
        return [map.x + c * x - s * y, map.y + s * x + c * y];
    }
    // where the window lies in the map frame: centre, size, turn; null without map <- odom
    function placement(p) {
        if (!p || !p.map) { return null; }
        var w = p.w * p.res, h = p.h * p.res, c = toMap(p.map, p.ox + w / 2, p.oy + h / 2);
        return { cx: c[0], cy: c[1], yaw: p.map.yaw, w: w, h: h };
    }
    // the zones (polygons in the frame) in the map frame
    function zonesToMap(p) {
        if (!p || !p.map) { return []; }
        return p.zones.map(function (z) { return z.map(function (q) { return toMap(p.map, +q[0], +q[1]); }); });
    }
    // the layer's state from times (ms); last = the last contract message (or null)
    function state(now, onAt, lastRx, last) {
        if (!onAt) { return 'off'; }
        if (!lastRx) { return (now - onAt > NODATA_MS) ? 'nodata' : 'wait'; }
        if (now - lastRx > NODATA_MS) { return 'nodata'; }
        if (last && !last.map) { return 'notf'; }
        if (now - lastRx > STALE_MS) { return 'stale'; }
        return 'ok';
    }
    // which source draws: 'ui' while the contract topic speaks, 'grid' when it
    // has been silent FALLBACK_MS since the layer came on or since its last message
    function source(now, onAt, uiRx) {
        if (!onAt) { return ''; }
        var since = uiRx || onAt;
        return (now - since > FALLBACK_MS) ? 'grid' : 'ui';
    }

    var api = { costColor: costColor, reasonColor: reasonColor, heightColor: heightColor, colorize: colorize,
                parse: parse, placement: placement, zonesToMap: zonesToMap, state: state, source: source,
                REASON: REASON, REASON_KEYS: REASON_KEYS, MODES: MODES, ELEV_SPAN_CM: ELEV_SPAN_CM,
                TOPIC: TOPIC, TOPIC_UI: TOPIC_UI, THROTTLE_MS: THROTTLE_MS, NODATA_MS: NODATA_MS,
                STALE_MS: STALE_MS, FALLBACK_MS: FALLBACK_MS, RESUB_MS: RESUB_MS, OVERLAP_MS: OVERLAP_MS };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (typeof document === 'undefined') { if (root) { root.VTTerrain = api; } return; }

    // ---- browser -----------------------------------------------------------
    function t(k, v) { return root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function $(id) { return document.getElementById(id); }
    function rosOf() { return (root.ros && root.ros.ros) || null; }
    function viewer3d() { return (root.viewer && root.viewer.viewer) || null; }
    function tfMap() { return (root.tf_client && root.tf_client.tfClientMap) || null; }
    function ready() { return !!(rosOf() && viewer3d() && tfMap() && root.ROS3D && root.ROSLIB); }
    function order() {
        var MLO = (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder : null;
        // over the maps and the live / direct rasters, under sensing, paths and the robot
        return (MLO && MLO.DIRECT !== undefined ? MLO.DIRECT : 21) + 0.5;
    }
    function mapsOpacity() {
        var o = (typeof MapLayerOpacity !== 'undefined') ? MapLayerOpacity.maps_opacity : 1;
        return (o >= 0 && o <= 1) ? o : 1;
    }

    var S = {
        chk: null, mode: null, st: null, onAt: 0, timer: null, stateNow: 'off', src: '',
        // contract source
        uiSub: null, uiRx: 0, last: null, seq: 0, decoded: null, rxUi: 0, bytesUi: 0,
        group: null, mesh: null, tex: null, canvas: null, ctx: null, img: null, zones: null, zsig: '',
        // fallback grid
        client: null, gridOn: false, gridRx: 0, gridAt: 0, rxGrid: 0,
        uiSubAt: 0, uiWait: RESUB_MS, uiOld: [], lastRaw: null, gridSubAt: 0, gridWait: RESUB_MS, resubs: 0,
    };
    var COLOR = { r: 1, g: 2, b: 3, vtTrav: true };     // identifies the fallback's grids in getColor

    // ---- controls in the Map tab's layers row, mirrored by the panel
    function ensureControls() {
        if (S.chk) { return true; }
        var row = document.querySelector('.map-layers-row');
        if (!row) { return false; }
        var div = document.createElement('div');
        div.className = 'form-check form-check-inline vt-trav-ctl';
        div.setAttribute('data-i18n-title', 'trav.layer_tip');
        div.title = t('trav.layer_tip');
        div.innerHTML = '<input class="form-check-input" type="checkbox" id="mapv3_chk_trav">' +
            '<label class="form-check-label vt-fs-sm" for="mapv3_chk_trav"><span data-i18n="trav.layer">' + t('trav.layer') +
            '</span> <span class="vt-sw-trav">&#9632;</span></label>' +
            '<span hidden><select id="mapv3_trav_mode"><option value="reason">reason</option><option value="cost">cost</option>' +
            '<option value="height">height</option></select><span id="mapv3_ov_trav_st"></span></span>';
        row.appendChild(div);
        S.chk = $('mapv3_chk_trav'); S.mode = $('mapv3_trav_mode'); S.st = $('mapv3_ov_trav_st');
        S.chk.checked = lsGet(LS_ON) === '1';
        var md = lsGet(LS_MODE);
        S.mode.value = MODES.indexOf(md) >= 0 ? md : 'reason';
        S.chk.addEventListener('change', function () { lsSet(LS_ON, S.chk.checked ? '1' : '0'); sync(); });
        S.mode.addEventListener('change', function () { lsSet(LS_MODE, S.mode.value); paint(); tellPanel(); });
        tellPanel();
        return true;
    }
    function tellPanel() { try { document.dispatchEvent(new CustomEvent('vt:map-sources')); } catch (e) { /* old browser */ } }

    // ---- subscriptions: the contract topic while ticked + visible; the grid
    // only while the contract topic is silent
    function sync() {
        var want = !!(S.chk && S.chk.checked) && !document.hidden && ready();
        if (want) {
            if (!S.onAt) { S.onAt = Date.now(); S.uiRx = 0; S.gridRx = 0; S.last = null; }
            if (!S.uiSub) { S.uiSub = uiTopic(); S.uiSubAt = Date.now(); S.uiWait = RESUB_MS; }
            gridWanted(source(Date.now(), S.onAt, S.uiRx) === 'grid');
        } else {
            if (S.uiSub) { try { S.uiSub.unsubscribe(); } catch (e) { /* closed */ } S.uiSub = null; }
            dropOldUi();
            gridWanted(false);
            S.onAt = 0;
        }
        if (!(S.chk && S.chk.checked)) { show(false); }
        if (S.chk && S.chk.checked && !S.timer) { S.timer = setInterval(tick, 1000); }
        if (!(S.chk && S.chk.checked) && S.timer) { clearInterval(S.timer); S.timer = null; }
        tick();
    }
    function show(on) {
        if (S.group) { S.group.visible = on && S.src === 'ui'; }
        var c = S.client, n = c && (c.sceneNode || c.currentGrid);
        if (n) { n.visible = on && S.src === 'grid'; }
    }

    // ---- 1. /traversability/ui
    // a subscription whose messages go to onUi with the topic that brought them
    function uiTopic() {
        var tp = new ROSLIB.Topic({ ros: rosOf(), name: TOPIC_UI, messageType: 'std_msgs/String',
                                    throttle_rate: THROTTLE_MS, queue_length: 1 });
        tp.subscribe(function (m) { onUi(m, tp); });
        return tp;
    }
    function dropOldUi(keep) {
        S.uiOld = S.uiOld.filter(function (tp) {
            if (tp === keep) { return true; }
            try { tp.unsubscribe(); } catch (e) { /* closed */ }
            return false;
        });
    }
    function onUi(m, tp) {
        var raw = m && m.data;
        // two subscriptions overlap while one is renewed: each message once,
        // and the one that speaks stays (the others go)
        if (tp && tp !== S.uiSub && S.uiOld.indexOf(tp) >= 0) {
            var cur = S.uiSub; S.uiSub = tp; S.uiOld = S.uiOld.filter(function (x) { return x !== tp; });
            if (cur) { S.uiOld.push(cur); }
        }
        if (S.uiOld.length) { dropOldUi(); }
        if (raw && raw === S.lastRaw) { return; }
        S.lastRaw = raw;
        S.uiWait = RESUB_MS;
        var p = parse(raw);
        S.rxUi++; S.bytesUi += raw ? raw.length : 0;
        if (!p) { return; }
        S.uiRx = Date.now();
        S.last = p;
        var seq = ++S.seq;
        decode(p, function (d) {
            if (seq !== S.seq || !d) { return; }      // a newer message is on its way
            S.decoded = d;
            draw();
        });
        tick();
    }
    // the PNG(s) -> value arrays (channel R), elevation only when sent
    function decode(p, done) {
        var names = ['reason', 'cost'].concat(p.elevation ? ['elevation'] : []);
        var out = { w: p.w, h: p.h, reason: null, cost: null, elevation: null }, left = names.length, failed = false;
        names.forEach(function (k) {
            var img = new Image();
            img.onload = function () {
                if (failed) { return; }
                try {
                    if (img.naturalWidth !== p.w || img.naturalHeight !== p.h) { throw new Error('size'); }
                    var sc = decode.cv || (decode.cv = document.createElement('canvas'));
                    sc.width = p.w; sc.height = p.h;
                    var cx = sc.getContext('2d', { willReadFrequently: true });
                    cx.clearRect(0, 0, p.w, p.h);
                    cx.drawImage(img, 0, 0);
                    var px = cx.getImageData(0, 0, p.w, p.h).data, n = p.w * p.h, a = new Uint8Array(n);
                    for (var i = 0; i < n; i++) { a[i] = px[i * 4]; }
                    out[k] = a;
                } catch (e) { failed = true; done(null); return; }
                if (--left === 0) { done(out); }
            };
            img.onerror = function () { if (!failed) { failed = true; done(null); } };
            img.src = 'data:image/png;base64,' + p[k];
        });
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
            S.img = S.ctx.createImageData(w, h);
            S.tex = new T.Texture(S.canvas);
            S.tex.magFilter = T.NearestFilter;      // 5 cm cells stay crisp up close
            S.tex.minFilter = T.LinearFilter;
            S.tex.generateMipmaps = false;
            S.mesh = new T.Mesh(new T.PlaneGeometry(1, 1),
                new T.MeshBasicMaterial({ map: S.tex, transparent: true, depthWrite: false, depthTest: false }));
            S.mesh.renderOrder = order();
            S.mesh.frustumCulled = false;
            S.group.add(S.mesh);
        }
        return true;
    }
    // the zones' outlines (rebuilt only when they change)
    function drawZones(p) {
        var T = ROS3D.THREE, pts = zonesToMap(p);
        var sig = pts.map(function (z) { return z.map(function (q) { return q[0].toFixed(2) + ',' + q[1].toFixed(2); }).join(' '); }).join('|');
        if (sig === S.zsig) { return; }
        S.zsig = sig;
        if (S.zones) {
            S.zones.children.slice().forEach(function (o) { S.zones.remove(o); o.geometry.dispose(); o.material.dispose(); });
        } else { S.zones = new T.Object3D(); S.group.add(S.zones); }
        pts.forEach(function (z) {
            var g = new T.Geometry();
            z.concat([z[0]]).forEach(function (q) { g.vertices.push(new T.Vector3(q[0], q[1], 0.012)); });
            var l = new T.Line(g, new T.LineBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }));
            l.renderOrder = order() + 0.1;
            l.frustumCulled = false;
            S.zones.add(l);
        });
    }
    function draw() {
        var p = S.last, d = S.decoded, pl = placement(p);
        if (!p || !d || !(S.chk && S.chk.checked) || S.src !== 'ui') { return; }
        if (!pl) { show(false); return; }
        if (!ensureMesh(p.w, p.h)) { return; }
        paint();
        S.mesh.scale.set(pl.w, pl.h, 1);
        S.mesh.position.set(pl.cx, pl.cy, 0.01);
        S.mesh.rotation.z = pl.yaw;
        drawZones(p);
        show(true);
        applyOpacity();
    }
    function viewMode() {
        var m = S.mode ? S.mode.value : 'reason';
        if (m === 'height' && !(S.decoded && S.decoded.elevation)) { m = 'reason'; }
        return m;
    }
    function paint() {
        var d = S.decoded;
        if (!d || !S.img) { return; }
        if (!colorize(viewMode(), d, d.w * d.h, S.img.data)) { return; }
        S.ctx.putImageData(S.img, 0, 0);
        S.tex.needsUpdate = true;
    }
    function applyOpacity() {
        if (!S.mesh) { return; }
        S.mesh.material.opacity = mapsOpacity() * (S.stateNow === 'stale' ? 0.45 : 1);
    }

    // ---- 2. fallback grid (ros3d client, topic throttled; the stock client has no throttle_rate)
    function wrapColors() {
        var P = root.ROS3D && ROS3D.OccupancyGrid && ROS3D.OccupancyGrid.prototype;
        if (!P || P._vtTravWrapped) { return !!P; }
        var orig = P.getColor;
        P.getColor = function (index, row, col, value) {
            if (this.color && this.color.vtTrav) { return costColor(value); }
            return orig.call(this, index, row, col, value);
        };
        P._vtTravWrapped = true;
        return true;
    }
    function makeClient() {
        var Base = ROS3D.OccupancyGridClient;
        function TravClient(o) { return Reflect.construct(Base, [o], TravClient); }
        TravClient.prototype = Object.create(Base.prototype);
        TravClient.prototype.constructor = TravClient;
        TravClient.prototype.subscribe = function () {
            this.unsubscribe();
            this.rosTopic = new ROSLIB.Topic({ ros: this.ros, name: this.topicName, messageType: 'nav_msgs/OccupancyGrid',
                                               queue_length: 1, compression: this.compression, throttle_rate: THROTTLE_MS });
            // keep the scene node of an earlier subscription (processMessage
            // re-targets it); stock subscribe() would orphan it
            if (this.sceneNode === undefined) { this.sceneNode = null; }
            this._boundProcessMessage = this.processMessage.bind(this);
            this.rosTopic.subscribe(this._boundProcessMessage);
        };
        Object.setPrototypeOf(TravClient, Base);
        var c = new TravClient({
            ros: rosOf(), tfClient: tfMap(), rootObject: viewer3d().scene, continuous: true, compression: 'cbor',
            topic: TOPIC, color: COLOR, opacity: 0.85,
            offsetPose: new ROSLIB.Pose({ position: new ROSLIB.Vector3({ x: 0, y: 0, z: 0.01 }),
                                          orientation: new ROSLIB.Quaternion({ x: 0, y: 0, z: 0, w: 1 }) }),
        });
        c.on('change', function () { S.gridRx = Date.now(); S.rxGrid++; S.gridWait = RESUB_MS; show(true); tick(); });
        if (typeof MapLayerOpacity !== 'undefined' && MapLayerOpacity.registerClient) { MapLayerOpacity.registerClient(c, order()); }
        return c;
    }
    function gridWanted(on) {
        if (on && !S.gridOn && wrapColors()) {
            if (!S.client) { S.client = makeClient(); } else { S.client.subscribe(); }
            S.gridOn = true; S.gridRx = 0; S.gridAt = S.gridSubAt = Date.now(); S.gridWait = RESUB_MS;
        } else if (!on && S.gridOn) {
            // every listener off (MapLayerOpacity adds one to the topic too):
            // only then roslib sends rosbridge the unsubscribe
            try { if (S.client.rosTopic) { S.client.rosTopic.unsubscribe(); } } catch (e) { /* closed */ }
            S.gridOn = false;
        }
    }

    // Hotfix 2026-11-08 (robot): a subscription made while the page connects
    // can stay silent (rosbridge sends, roslib never emits it — the subscribe
    // went out twice under one id). Hotfix 2: renewing by unsubscribe +
    // subscribe made it worse — on the loaded robot a fresh rosbridge
    // subscription takes up to ~10 s to deliver its first message, and the
    // unsubscribe tore down rosbridge's own ROS subscriber each time, so a
    // renewal every 10 s never let data through ("no data", no subscriber).
    // Now: silent RESUB_MS since the subscription / the last message -> a
    // SECOND subscription next to the first (rosbridge keeps its ROS
    // subscriber); the one that delivers stays, the other goes (at the latest
    // after OVERLAP_MS). Then 30 s, 60 s between tries; data resets it.
    function watchdog(now) {
        var R = rosOf();
        if (!S.onAt || !R || R.isConnected === false) { return; }
        if (S.uiSub && now - Math.max(S.uiRx, S.uiSubAt) > S.uiWait) {
            S.resubs++;
            S.uiOld.push(S.uiSub);
            var olds = S.uiOld.slice();
            S.uiSub = uiTopic(); S.uiSubAt = now;
            S.uiWait = Math.min(RESUB_MAX_MS, S.uiWait * 2);
            setTimeout(function () {
                olds.forEach(function (tp) {
                    var k = S.uiOld.indexOf(tp);
                    if (k >= 0) { S.uiOld.splice(k, 1); try { tp.unsubscribe(); } catch (e) { /* closed */ } }
                });
            }, OVERLAP_MS);
        }
        if (S.gridOn && S.client && now - Math.max(S.gridRx, S.gridSubAt) > S.gridWait) {
            S.resubs++;
            // the old topic stays subscribed in rosbridge (MapLayerOpacity keeps a
            // listener on it) until the new one is up, then goes
            var old = S.client.rosTopic;
            try { S.client.subscribe(); } catch (e) { /* next round */ }
            S.gridSubAt = now;
            S.gridWait = Math.min(RESUB_MAX_MS, S.gridWait * 2);
            setTimeout(function () { try { if (old && old !== S.client.rosTopic) { old.unsubscribe(); } } catch (e) { /* closed */ } }, OVERLAP_MS);
        }
    }

    // ---- state + source (1 Hz while ticked)
    function tick() {
        var on = !!(S.chk && S.chk.checked), now = Date.now();
        if (on && !document.hidden) { watchdog(now); }
        var src = (on && S.onAt) ? source(now, S.onAt, S.uiRx) : '';
        if (src !== S.src) {
            S.src = src;
            if (S.onAt) { gridWanted(src === 'grid'); }
            show(on);
            if (src === 'ui') { draw(); }
        }
        var st = !on ? 'off' : document.hidden ? 'paused' : !rosOf() ? 'noros'
            : src === 'grid' ? state(now, S.onAt, S.gridRx, null)
            : state(now, S.onAt, S.uiRx, S.last);
        if (st === 'nodata' || st === 'notf') { show(false); } else if (on) { show(true); }
        var changed = st !== S.stateNow;
        S.stateNow = st;
        if (changed) { applyOpacity(); }
        if (S.st) {
            var s = on ? t('trav.st.' + st) : '';
            if (S.st.textContent !== s) { S.st.textContent = s; }
        }
        if (changed || S._srcTold !== src) { S._srcTold = src; tellPanel(); }
    }

    // for the panel: state, source, which views have data
    function info() {
        var views = S.src === 'grid' ? { reason: false, cost: true, height: false }
            : { reason: true, cost: true, height: !!(S.last && S.last.elevation) };
        return { state: S.stateNow, source: S.src, views: views, mode: viewMode(),
                 rx: S.rxUi + S.rxGrid, rxUi: S.rxUi, rxGrid: S.rxGrid, bytesUi: S.bytesUi,
                 subscribed: !!S.uiSub, gridOn: S.gridOn, resubs: S.resubs, counts: S.last ? S.last.counts : null };
    }

    function init() {
        if (!$('map_view')) { return; }
        var hook = setInterval(function () {
            if (!ensureControls() || !ready()) { return; }
            clearInterval(hook);
            sync();
        }, 500);
        document.addEventListener('visibilitychange', sync);
        document.addEventListener('rosconnected', function () {
            if (S.uiSub && S.uiSub.ros !== rosOf()) { S.uiSub = null; }
            sync();
        });
        if (root.VTI18n && root.VTI18n.onChange) { root.VTI18n.onChange(function () { S.stateNow = ''; tick(); }); }
    }

    api.info = info;
    api.sync = sync;
    api._S = S;
    root.VTTerrain = api;
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})(typeof window !== 'undefined' ? window : this);
