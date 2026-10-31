/* vt_sensor_ranges.js — map layers "Lidar range" and "Camera range": how far each
 * sensor sees and how far the robot really uses it, around the robot, whether a
 * map is being recorded or not. Nothing here sends anything to the robot.
 *
 * Every number comes from the robot (GET /api/sensor_limits = nodes/sensor_limits.py,
 * /depth_obstacles/config, camera_info, the scan itself, TF); a limit that is
 * lower than what is set says who cut it ("5 m: driver").
 *
 *   core      VTSensorCore: pure functions, tools/test_sensor_ranges.node.js
 *   data      VTSensorLimits: shared with vt_lidar_settings.js; asks the robot
 *             only while somebody needs it (need(name, on))
 *   layer     two groups of lines in the 3D view. The geometry is built only when
 *             a limit changes; TF just moves the groups, the view scales the
 *             labels (at most 5 × a second, nothing while the layer is off).
 *   card      the legend on the map, with the numbers
 *
 * Next to it stays the "Sensing" layer (mapping.js MapSensing): the live footprint
 * during a recording. This one is the limits, not the current scan.
 * ROS3D bundles its own THREE (r89 API), never window.THREE: see MappingV3._r3d.
 */
(function (root) {
    'use strict';

    /* ============================================================ core */

    /* the smallest of the limits that exist; the first of equals wins, so a
       list ordered from the sensor to the consumer names the real cause */
    function limitOf(list) {
        var best = null;
        (list || []).forEach(function (l) {
            if (l && typeof l.v === 'number' && isFinite(l.v) && l.v > 0 && (!best || l.v < best.v)) { best = l; }
        });
        return best ? { v: best.v, by: best.by } : null;
    }
    /* the largest: lower bounds add up the other way round */
    function floorOf(list) {
        var best = null;
        (list || []).forEach(function (l) {
            if (l && typeof l.v === 'number' && isFinite(l.v) && (!best || l.v > best.v)) { best = l; }
        });
        return best ? { v: best.v, by: best.by } : null;
    }
    /* a limit lower than what is set = cut by something else */
    function cut(res, set, setBy) {
        if (!res) { return null; }
        var o = { v: res.v, by: res.by, set: (typeof set === 'number') ? set : null, cut: false };
        if (o.set !== null && res.v < o.set - 1e-6 && res.by !== setBy) { o.cut = true; }
        return o;
    }

    function fovFromInfo(info) {
        var K = info && (info.K || info.k);
        if (!K || !(K[0] > 0) || !(K[4] > 0) || !(info.width > 0) || !(info.height > 0)) { return null; }
        var left = Math.atan(K[2] / K[0]), right = Math.atan((info.width - K[2]) / K[0]);
        var up = Math.atan(K[5] / K[4]), down = Math.atan((info.height - K[5]) / K[4]);
        return { left: left, right: right, up: up, down: down,
                 h: left + right, v: up + down, frame: (info.header && info.header.frame_id) || '' };
    }

    /* how far from the camera its lowest ray reaches the ground (flat ground at
       base_link height); null when that ray never does */
    function groundFrom(height, pitchDown, downHalf) {
        if (!(height > 0)) { return null; }
        var a = pitchDown + downHalf;
        if (!(a > 0.002)) { return null; }
        return height / Math.tan(a);
    }

    function profileOf(cfg, name) {
        var p = ((cfg && cfg.profiles) || []).filter(function (x) { return x.name === name; })[0];
        return p ? (p.values || {}) : null;
    }

    function computeRanges(i) {
        var L = (i.limits && i.limits.lidar) || {}, C = (i.limits && i.limits.camera) || {};
        var mapper = i.live || ((i.limits && i.limits.mapper && i.limits.mapper.values) || {});
        var dev = L.device || {}, flt = L.filter || {}, scan = i.scan || {};
        var cost = L.costmap || {}, grid = L.local_grid || {};

        var sensor = limitOf([{ v: dev.max_distance_m, by: 'device' }, { v: scan.range_max, by: 'driver' },
                              { v: flt.range_upper, by: 'filter' }]);
        var min = floorOf([{ v: scan.range_min, by: 'driver' }, { v: flt.range_lower, by: 'filter' }]);
        var setMap = (typeof mapper.lidar_max_range_m === 'number') ? mapper.lidar_max_range_m : null;
        var map = cut(limitOf([{ v: setMap, by: 'mapper' }].concat(sensor ? [sensor] : [])), setMap, 'mapper');
        var setInt = (typeof mapper.lidar_min_intensity === 'number') ? mapper.lidar_min_intensity : null;
        var intMin = floorOf([{ v: setInt, by: 'mapper' }, { v: flt.intensity_lower, by: 'filter' }]);
        var span = (typeof scan.angle_max === 'number' && typeof scan.angle_min === 'number')
            ? scan.angle_max - scan.angle_min : null;
        var full = span === null || span >= 2 * Math.PI - 0.02;
        var lidar = {
            min: min, sensor: sensor, map: map, mapOn: mapper.use_lidar !== false,
            freeNoHit: mapper.lidar_free_no_hit !== false,
            intMin: intMin ? { v: intMin.v, by: intMin.by, set: setInt, cut: setInt !== null && intMin.v > setInt + 1e-6 } : null,
            nav: limitOf([{ v: cost.obstacle_range, by: 'costmap' }].concat(sensor ? [sensor] : [])),
            clear: limitOf([{ v: cost.raytrace_range, by: 'costmap' }].concat(sensor ? [sensor] : [])),
            local: limitOf([{ v: grid.width > 0 && grid.height > 0 ? Math.min(grid.width, grid.height) / 2 : null, by: 'local_grid' }]),
            span: full ? 2 * Math.PI : span, full: full,
            a0: full ? -Math.PI : scan.angle_min, a1: full ? Math.PI : scan.angle_max,
            masks: ((L.chain && L.chain.masks) || []).map(function (m) { return m.type; }),
        };

        var fov = fovFromInfo(i.camUsed), sfov = fovFromInfo(i.camSensor);
        var nav = profileOf(i.depth, 'nav'), wide = profileOf(i.depth, 'wide');
        var clip = (C.clip_distance > 0) ? { v: C.clip_distance, by: 'driver' } : null;
        var cc = C.costmap || {};
        function depthEnd(p, extra, setBy, set) {
            if (!p) { return null; }
            return cut(limitOf([clip, { v: p.range_max, by: 'cam_range' }, { v: p.max_depth, by: 'cam_depth' }, extra]), set, setBy);
        }
        function depthStart(p) {
            if (!p) { return null; }
            return floorOf([{ v: p.min_depth, by: 'cam_depth' }, { v: p.range_min, by: 'cam_range' }]);
        }
        var obsSet = (typeof mapper.obstacle_max_range_m === 'number') ? mapper.obstacle_max_range_m : null;
        var freeSet = (typeof mapper.free_max_range_m === 'number') ? mapper.free_max_range_m : null;
        var pitchDown = (typeof i.camPitchDown === 'number') ? i.camPitchDown : null;
        var camera = {
            fov: fov, sensorFov: sfov, clip: clip,
            navMin: depthStart(nav), navMax: depthEnd(nav, { v: cc.obstacle_range, by: 'costmap' }, 'cam_depth', nav ? nav.max_depth : null),
            mapMin: depthStart(wide),
            mapObs: depthEnd(wide, { v: obsSet, by: 'mapper' }, 'mapper', obsSet),
            mapFree: depthEnd(wide, { v: freeSet, by: 'mapper' }, 'mapper', freeSet),
            mapObsOn: mapper.use_cam_obstacle !== false, mapFreeOn: mapper.use_cam_free !== false,
            costmap: cc,
            ground: (fov && pitchDown !== null) ? groundFrom(i.camHeight, pitchDown, fov.down) : null,
            height: i.camHeight,
        };
        return { lidar: lidar, camera: camera, recording: !!i.live };
    }

    /* the sectors a scan shows nothing beyond the robot: a beam closer than
       BLOCK_M in almost every scan is something on the robot or against it */
    var SECTORS = 36, BLOCK_M = 0.4, BLOCK_SCANS = 10, BLOCK_SHARE = 0.8;
    function sectorScan(scan) {
        var R = (scan && scan.ranges) || [], n = R.length, out = [];
        var inc = Number(scan && scan.angle_increment) || 0, a0 = Number(scan && scan.angle_min) || 0;
        var rmin = Number(scan && scan.range_min) || 0, i;
        for (i = 0; i < SECTORS; i++) { out.push({ n: 0, near: 0 }); }
        for (i = 0; i < n; i++) {
            var a = a0 + i * inc, s = Math.floor((a + Math.PI) / (2 * Math.PI) * SECTORS);
            s = ((s % SECTORS) + SECTORS) % SECTORS;
            out[s].n++;
            var r = R[i];
            if (typeof r === 'number' && isFinite(r) && r >= rmin && r < BLOCK_M) { out[s].near++; }
        }
        return out;
    }
    function blockedSectors(hist) {
        if (!hist || hist.length < BLOCK_SCANS) { return []; }
        var out = [];
        for (var s = 0; s < SECTORS; s++) {
            var n = 0, near = 0;
            hist.forEach(function (h) { n += h[s].n; near += h[s].near; });
            if (n > 0 && near / n >= BLOCK_SHARE) { out.push(s); }
        }
        return out;
    }

    var Core = { limitOf: limitOf, floorOf: floorOf, cut: cut, fovFromInfo: fovFromInfo, groundFrom: groundFrom,
        computeRanges: computeRanges, sectorScan: sectorScan, blockedSectors: blockedSectors, SECTORS: SECTORS };
    if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
    root.VTSensorCore = Core;

    /* ============================================================ helpers */
    var I = root.VTI18n;
    function t(k, v) { return I ? I.t(k, v) : k; }
    function lang() { return I && I.lang ? I.lang() : 'en'; }
    function num(v, d) {
        if (typeof v !== 'number' || !isFinite(v)) { return '—'; }
        return v.toLocaleString(lang(), { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    function m(v, d) { return t('ranges.m', { v: num(v, d === undefined ? (v < 1 ? 2 : 1) : d) }); }
    function deg(rad) { return t('ranges.deg', { v: num(rad * 180 / Math.PI, 0) }); }
    function byText(by) { return t('ranges.by.' + by); }
    /* "5,0 m: driver" when a limit is lower than what is set */
    function whyCut(x) { return x && x.cut ? t('ranges.cut', { v: m(x.v), by: byText(x.by), set: m(x.set) }) : ''; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    function parse(msg) { try { return msg ? JSON.parse(msg.data) : null; } catch (e) { return null; } }
    function rosOf() { return (root.ros && root.ros.ros) || null; }

    /* ============================================================ data */
    var D = {
        limits: null, limitsAt: 0, limitsErr: false, depth: null, camUsed: null, camSensor: null, scan: null,
        needs: {}, listeners: [], ros: null, subCfg: null, askedInfo: 0, timer: 0, sig: '', tfCam: null, tfBase: null,
    };
    var FETCH_MS = 10000;

    function anyNeed() { return Object.keys(D.needs).some(function (k) { return D.needs[k]; }); }
    function mapperLive() {
        var mp = root.map_sensing && root.map_sensing.mapping;
        if (!mp) { return null; }
        var mgr = parse(mp._lastManagerMsg);
        if (!mgr || !mgr.running) { return null; }
        var dir = parse(mp._lastDirectMsg);
        return (dir && dir.settings) || null;
    }
    function recording() {
        var mp = root.map_sensing && root.map_sensing.mapping, mgr = mp && parse(mp._lastManagerMsg);
        return !!(mgr && mgr.running);
    }
    function emit() {
        D.listeners.slice().forEach(function (f) { try { f(); } catch (e) { console.error('[ranges]', e); } });
    }
    /* 2 cm steps: the camera's height and pitch come from TF and tremble */
    function coarse(o) {
        return JSON.stringify(o, function (k, v) { return typeof v === 'number' ? Math.round(v * 50) / 50 : v; });
    }
    function onCfg(msg) { var c = parse(msg); if (c) { D.depth = c; changed(); } }
    function changed() {
        var sig = coarse(ranges()) + '|' + lang();
        if (sig !== D.sig) { D.sig = sig; emit(); }
    }
    function fetchLimits(force) {
        if (!force && Date.now() - D.limitsAt < FETCH_MS) { return; }
        D.limitsAt = Date.now();
        fetch('/api/sensor_limits', { cache: 'no-store' }).then(function (r) {
            if (!r.ok) { throw new Error(String(r.status)); }
            return r.json();
        }).then(function (j) {
            if (j && j.ok) { D.limits = j; D.limitsErr = false; changed(); }
        }).catch(function () { D.limitsErr = true; changed(); });
    }
    function setLimits(j) { if (j && j.ok) { D.limits = j; D.limitsAt = Date.now(); D.limitsErr = false; changed(); } }
    function askInfo(ros) {
        if (D.camUsed && D.camSensor) { return; }
        if (Date.now() - D.askedInfo < 30000) { return; }
        D.askedInfo = Date.now();
        [['/rtabmap/rgb/camera_info_out', 'camUsed'], ['/d435/depth/camera_info', 'camSensor']].forEach(function (x) {
            if (D[x[1]]) { return; }
            var tp = new ROSLIB.Topic({ ros: ros, name: x[0], messageType: 'sensor_msgs/CameraInfo', queue_length: 1 });
            var cb = function (msg) {
                try { tp.unsubscribe(cb); } catch (e) { /* ignore */ }
                D[x[1]] = msg;
                changed();
            };
            tp.subscribe(cb);
        });
    }
    function pump() {
        var ros = rosOf();
        if (!anyNeed()) {
            if (D.subCfg) { try { D.subCfg.unsubscribe(onCfg); } catch (e) { /* ignore */ } D.subCfg = null; }
            return;
        }
        fetchLimits(false);
        if (ros && root.ROSLIB) {
            if (ros !== D.ros) { D.ros = ros; D.subCfg = null; D.askedInfo = 0; }
            if (!D.subCfg) {
                D.subCfg = new ROSLIB.Topic({ ros: ros, name: '/depth_obstacles/config', messageType: 'std_msgs/String', queue_length: 1 });
                D.subCfg.subscribe(onCfg);
            }
            askInfo(ros);
        }
        changed();
    }
    function need(name, on) {
        D.needs[name] = !!on;
        if (!D.timer) { D.timer = setInterval(pump, 2000); }
        pump();
    }
    function camGeom() {
        var b = D.tfBase, c = D.tfCam;
        if (!c || !c.rotation) { return {}; }
        var q = c.rotation, fz = 2 * ((q.x || 0) * (q.z || 0) - (q.w === undefined ? 1 : q.w) * (q.y || 0));
        var o = { camPitchDown: -Math.asin(Math.max(-1, Math.min(1, fz))) };
        if (b && b.translation && c.translation) { o.camHeight = c.translation.z - b.translation.z; }
        return o;
    }
    function ranges() {
        var g = camGeom();
        return computeRanges({ limits: D.limits, live: mapperLive(), depth: D.depth, camUsed: D.camUsed, camSensor: D.camSensor,
            scan: D.scan, camPitchDown: g.camPitchDown, camHeight: g.camHeight });
    }
    root.VTSensorLimits = {
        need: need,
        ranges: ranges,
        limits: function () { return D.limits; },
        limitsFailed: function () { return D.limitsErr; },
        setLimits: setLimits,
        refresh: function () { fetchLimits(true); },
        onChange: function (f) { D.listeners.push(f); },
        live: mapperLive,
        recording: recording,
        setScanMeta: function (s) { D.scan = s; changed(); },
        /* base_scan against base_link (rad); the URDF mount until TF arrives */
        lidarYaw: function () {
            ensureTf();
            return (S.tfL && S.tfB) ? yawOf(S.tfL.rotation) - yawOf(S.tfB.rotation) : -Math.PI / 2;
        },
        fmt: { num: num, m: m, deg: deg, byText: byText, whyCut: whyCut },
    };

    /* ============================================================ layer */
    var COL = { lidar: 0xb388ff, cam: 0xffd23f, block: 0xff6b6b };
    var LS_LIDAR = 'vitulus_ranges_lidar', LS_CAM = 'vitulus_ranges_camera', LS_CARD = 'vitulus_ranges_card';
    var Z = 0.04, ORDER = 26, TEXT_PX = 15;
    var S = {
        chkL: null, chkC: null, T: null, V: null, tf: null, tfOn: false,
        gL: null, gC: null, labels: [], scanSub: null, scanAt: 0, scanRx: 0, hist: [], blocked: [], blockSig: '',
        built: '', card: null, tfL: null, tfScaleAt: 0,
    };

    function viewer3d() { return (root.viewer && root.viewer.viewer) || null; }
    function tfClient() { return (root.tf_client && root.tf_client.tfClientMap) || null; }
    function lidarOn() { return !!(S.chkL && S.chkL.checked); }
    function camOn() { return !!(S.chkC && S.chkC.checked); }

    function ensureCheck(id, ls, labelKey, tipKey, swatch) {
        var chk = document.getElementById(id);
        if (!chk) {
            var row = document.querySelector('.map-layers-row');
            if (!row) { return null; }
            var div = el('div', 'form-check form-check-inline');
            div.setAttribute('data-i18n-title', tipKey);
            div.title = t(tipKey);
            div.innerHTML = '<input class="form-check-input" type="checkbox" id="' + id + '">' +
                '<label class="form-check-label vt-fs-sm" for="' + id + '"><span data-i18n="' + labelKey + '">' + t(labelKey) +
                '</span> <span class="' + swatch + '">&#9679;</span></label>';
            row.appendChild(div);
            chk = document.getElementById(id);
        }
        chk.checked = lsGet(ls) === '1';
        chk.addEventListener('change', function () { lsSet(ls, chk.checked ? '1' : '0'); sync(); });
        return chk;
    }
    function ensureChecks() {
        if (!S.chkL) { S.chkL = ensureCheck('mapv3_chk_ranges_lidar', LS_LIDAR, 'ranges.layer.lidar', 'ranges.layer.lidar_tip', 'vt-sw-b388ff'); }
        if (!S.chkC) { S.chkC = ensureCheck('mapv3_chk_ranges_camera', LS_CAM, 'ranges.layer.camera', 'ranges.layer.camera_tip', 'vt-sw-ffd23f'); }
    }

    function clearGroup(g) {
        while (g.children.length) {
            var o = g.children[0];
            g.remove(o);
            if (o.geometry) { o.geometry.dispose(); }
            if (o.material) {
                if (o.material.map) { o.material.map.dispose(); }
                o.material.dispose();
            }
        }
    }
    function addLines(g, pts, color, opacity) {
        if (!pts.length) { return; }
        var T = S.T, ge = new T.BufferGeometry(), arr = new Float32Array(pts.length * 3 / 2);
        for (var i = 0, j = 0; i < pts.length; i += 2) { arr[j++] = pts[i]; arr[j++] = pts[i + 1]; arr[j++] = Z; }
        var a = new T.BufferAttribute(arr, 3);
        if (ge.setAttribute) { ge.setAttribute('position', a); } else { ge.addAttribute('position', a); }
        var o = new T.LineSegments(ge, new T.LineBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false, depthTest: false }));
        o.frustumCulled = false;
        o.renderOrder = ORDER + 1;
        g.add(o);
    }
    function addFill(g, tris, color, opacity) {
        if (!tris.length) { return; }
        var T = S.T, ge = new T.BufferGeometry(), arr = new Float32Array(tris.length * 3 / 2);
        for (var i = 0, j = 0; i < tris.length; i += 2) { arr[j++] = tris[i]; arr[j++] = tris[i + 1]; arr[j++] = Z - 0.005; }
        var a = new T.BufferAttribute(arr, 3);
        if (ge.setAttribute) { ge.setAttribute('position', a); } else { ge.addAttribute('position', a); }
        var mat = new T.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false, depthTest: false });
        mat.side = T.DoubleSide;
        var o = new T.Mesh(ge, mat);
        o.frustumCulled = false;
        o.renderOrder = ORDER;
        g.add(o);
    }
    /* a ring (or arc) as line segments; dash = every other piece */
    function arcLines(r, a0, a1, dash) {
        var n = Math.max(24, Math.min(180, Math.round(Math.abs(a1 - a0) * Math.max(4, r) * 3))), pts = [];
        for (var i = 0; i < n; i++) {
            if (dash && i % 2) { continue; }
            var x0 = a0 + (a1 - a0) * i / n, x1 = a0 + (a1 - a0) * (i + 1) / n;
            pts.push(r * Math.cos(x0), r * Math.sin(x0), r * Math.cos(x1), r * Math.sin(x1));
        }
        return pts;
    }
    /* a band r0..r1 between two angles */
    function band(r0, r1, a0, a1) {
        var n = Math.max(8, Math.round(Math.abs(a1 - a0) / (2 * Math.PI) * 96)), tr = [];
        for (var i = 0; i < n; i++) {
            var x0 = a0 + (a1 - a0) * i / n, x1 = a0 + (a1 - a0) * (i + 1) / n;
            var c0 = Math.cos(x0), s0 = Math.sin(x0), c1 = Math.cos(x1), s1 = Math.sin(x1);
            tr.push(r0 * c0, r0 * s0, r1 * c0, r1 * s0, r1 * c1, r1 * s1);
            tr.push(r0 * c0, r0 * s0, r1 * c1, r1 * s1, r0 * c1, r0 * s1);
        }
        return tr;
    }
    function addLabel(g, text, x, y, color, rank) {
        var T = S.T, cv = document.createElement('canvas'), px = 28, ctx = cv.getContext('2d');
        ctx.font = '600 ' + px + 'px sans-serif';
        var w = Math.ceil(ctx.measureText(text).width) + 20, h = px + 14;
        cv.width = w; cv.height = h;
        ctx = cv.getContext('2d');
        ctx.font = '600 ' + px + 'px sans-serif';
        ctx.fillStyle = 'rgba(20,24,28,0.78)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 10, h / 2 + 1);
        var tex = new T.CanvasTexture(cv);
        tex.minFilter = T.LinearFilter;
        tex.generateMipmaps = false;
        var mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        var sp = new T.Sprite(mat);
        sp.position.set(x, y, Z + 0.01);
        sp.renderOrder = ORDER + 2;
        sp.userData.aspect = w / h;
        sp.userData.rank = rank || 0;
        g.add(sp);
        S.labels.push(sp);
    }

    function buildLidar(r) {
        var L = r.lidar, g = S.gL, C = COL.lidar, a0 = L.a0, a1 = L.a1;
        clearGroup(g);
        if (!L.sensor) { return; }
        var labels = [];
        addLines(g, arcLines(L.sensor.v, a0, a1, true), C, 0.5);
        labels.push([L.sensor.v, t('ranges.lbl.sees', { v: m(L.sensor.v) }), 3]);
        if (L.map && L.mapOn) {
            addFill(g, band(L.min ? L.min.v : 0, L.map.v, a0, a1), C, 0.07);
            addLines(g, arcLines(L.map.v, a0, a1, false), C, 0.95);
            labels.push([L.map.v, t('ranges.lbl.map', { v: m(L.map.v) }), 2]);
        }
        if (L.nav) {
            addFill(g, band(L.min ? L.min.v : 0, L.nav.v, a0, a1), C, 0.1);
            addLines(g, arcLines(L.nav.v, a0, a1, false), C, 0.95);
            addLines(g, arcLines(L.nav.v + 0.03, a0, a1, false), C, 0.95);
            labels.push([L.nav.v, t('ranges.lbl.nav', { v: m(L.nav.v) }), 1]);
        }
        if (L.min) { addLines(g, arcLines(L.min.v, a0, a1, false), C, 0.6); }
        var sec = 2 * Math.PI / 36, red = [], redLines = [], reach = (L.map && L.mapOn) ? L.map.v : L.sensor.v;
        S.blocked.forEach(function (s) {
            var x0 = -Math.PI + s * sec;
            red = red.concat(band(0, reach, x0, x0 + sec));
            redLines = redLines.concat(arcLines(reach, x0, x0 + sec, false));
        });
        addFill(g, red, COL.block, 0.22);
        addLines(g, redLines, COL.block, 0.9);
        /* the same bearing for all (the robot's left: the frame is turned by the
           mount), equal rings share a label */
        var b = lidarLabelBearing();
        labels.sort(function (x, y) { return x[0] - y[0]; });
        for (var i = 0; i < labels.length; i++) {
            var txt = labels[i][1], rank = labels[i][2];
            while (i + 1 < labels.length && Math.abs(labels[i + 1][0] - labels[i][0]) < 0.05) { txt += ' · ' + labels[++i][1]; }
            addLabel(g, txt, labels[i][0] * Math.cos(b), labels[i][0] * Math.sin(b), '#d9c8ff', rank);
        }
    }
    function lidarLabelBearing() {
        /* base_scan is turned against base_link: label bearing = robot's left */
        var y = (S.tfL && S.tfB) ? yawOf(S.tfL.rotation) - yawOf(S.tfB.rotation) : -Math.PI / 2;
        return Math.PI / 2 - y;
    }
    function buildCamera(r) {
        var K = r.camera, g = S.gC, C = COL.cam, F = K.fov;
        clearGroup(g);
        if (!F) { return; }
        var a0 = -F.right, a1 = F.left;
        function edges(rr) { return [0, 0, rr * Math.cos(a0), rr * Math.sin(a0), 0, 0, rr * Math.cos(a1), rr * Math.sin(a1)]; }
        var navV = K.navMax ? K.navMax.v : 0;
        var mapV = Math.max(K.mapObs && K.mapObsOn ? K.mapObs.v : 0, K.mapFree && K.mapFreeOn ? K.mapFree.v : 0);
        var far = K.clip ? K.clip.v : Math.max(navV, mapV);
        var startN = K.navMin ? K.navMin.v : 0;
        /* what the sensor can see: the raw depth view up to the driver's cut */
        if (far > 0) {
            var SF = K.sensorFov;
            var sa0 = SF ? -SF.right : a0, sa1 = SF ? SF.left : a1;
            addLines(g, arcLines(far, sa0, sa1, true), C, 0.5);
            addLines(g, [0, 0, far * Math.cos(sa0), far * Math.sin(sa0), 0, 0, far * Math.cos(sa1), far * Math.sin(sa1)], C, 0.3);
        }
        /* what is used */
        if (mapV > 0) {
            addFill(g, band(0, mapV, a0, a1), C, 0.09);
            addLines(g, arcLines(mapV, a0, a1, false), C, 0.8);
        }
        if (navV > 0) {
            addFill(g, band(startN, navV, a0, a1), C, 0.16);
            addLines(g, arcLines(navV, a0, a1, false), C, 1);
            addLines(g, arcLines(navV + 0.03, a0, a1, false), C, 1);
        }
        addLines(g, edges(Math.max(navV, mapV, 0.1)), C, 0.9);
        if (startN > 0.01) { addLines(g, arcLines(startN, a0, a1, false), C, 0.8); }
        if (K.ground) { addLines(g, arcLines(K.ground, a0, a1, true), C, 0.9); }
        var cm = K.costmap.obstacle_range;
        if (cm > 0 && (!K.navMax || cm > K.navMax.v + 0.05) && (!K.clip || cm < K.clip.v)) {
            addLines(g, arcLines(cm, a0, a1, true), 0xffffff, 0.35);
        }
        var bb = a1 + 0.03;
        function put(rr, txt, rank) { addLabel(g, txt, rr * Math.cos(bb), rr * Math.sin(bb), '#ffe68a', rank); }
        if (far > 0) { put(far, t('ranges.lbl.sees', { v: m(far) }), 4); }
        if (navV > 0 && Math.abs(navV - mapV) < 0.05) { put(navV, t('ranges.lbl.navmap', { v: m(navV) }), 1); }
        else {
            if (navV > 0) { put(navV, t('ranges.lbl.nav', { v: m(navV) }), 1); }
            if (mapV > 0) { put(mapV, t('ranges.lbl.map', { v: m(mapV) }), 2); }
        }
        if (K.ground) { put(K.ground, t('ranges.lbl.ground', { v: m(K.ground) }), 3); }
    }
    function rebuild() {
        var r = ranges();
        var sig = coarse([r, S.blocked, lang(), lidarLabelBearing()]);
        if (sig === S.built) { return; }
        S.built = sig;
        S.labels = [];
        if (S.gL) { buildLidar(r); }
        if (S.gC) { buildCamera(r); }
        scaleLabels();
    }
    function yawOf(q) {
        var x = q.x || 0, y = q.y || 0, z = q.z || 0, w = q.w === undefined ? 1 : q.w;
        return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    }
    function place(g, tr) {
        if (!g || !tr || !tr.translation) { return; }
        g.position.set(tr.translation.x, tr.translation.y, 0);
        g.rotation.set(0, 0, yawOf(tr.rotation || {}));
    }
    /* labels keep their size on the screen; one that would cover another hides
       (the card has every number). Added from the most important one. */
    function scaleLabels() {
        var V = S.V, cam = V && V.camera;
        if (!cam || !S.labels.length) { return; }
        var el2 = V.renderer && V.renderer.domElement;
        var h = (el2 && el2.clientHeight) || 600, wpx = (el2 && el2.clientWidth) || 800;
        var pos = new S.T.Vector3(), taken = [];
        S.labels.slice().sort(function (a, b) { return a.userData.rank - b.userData.rank; }).forEach(function (sp) {
            sp.updateMatrixWorld();
            pos.setFromMatrixPosition(sp.matrixWorld);
            var w = 2 * cam.position.distanceTo(pos) * Math.tan((cam.fov || 50) * Math.PI / 360) / h;
            var hh = TEXT_PX * w * 1.5;
            sp.scale.set(hh * sp.userData.aspect, hh, 1);
            pos.project(cam);
            var cx = (pos.x + 1) / 2 * wpx, cy = (1 - pos.y) / 2 * h, hw = TEXT_PX * 1.5 * sp.userData.aspect / 2, hh2 = TEXT_PX * 0.75;
            var hit = taken.some(function (r) { return Math.abs(r[0] - cx) < r[2] + hw && Math.abs(r[1] - cy) < r[3] + hh2; });
            sp.visible = !hit;
            if (!hit) { taken.push([cx, cy, hw, hh2]); }
        });
    }
    function ensureScene() {
        if (S.gL) { return true; }
        var V = viewer3d(), T = root.ROS3D && ROS3D.THREE;
        if (!V || !V.scene || !T) { return false; }
        S.V = V; S.T = T;
        S.gL = new T.Object3D(); S.gC = new T.Object3D();
        S.gL.visible = S.gC.visible = false;
        V.scene.add(S.gL); V.scene.add(S.gC);
        if (V.cameraControls && V.cameraControls.addEventListener) {
            V.cameraControls.addEventListener('change', scaleLabels);
        }
        return true;
    }
    function ensureTf() {
        var tf = tfClient();
        if (S.tfOn || !tf) { return; }
        S.tfOn = true;
        tf.subscribe('base_link', function (x) { D.tfBase = x; S.tfB = x; });
        tf.subscribe('base_scan', function (x) { S.tfL = x; if (S.gL) { place(S.gL, x); } });
        tf.subscribe('d435_link', function (x) { D.tfCam = x; if (S.gC) { place(S.gC, x); } });
    }

    /* the scan: once in 2 s, 10 scans = the blocked sectors of the last 20 s */
    function onScan(msg) {
        var now = Date.now();
        if (now - S.scanAt < 1800) { return; }
        S.scanAt = now;
        S.hist.push(sectorScan(msg));
        if (S.hist.length > 10) { S.hist.shift(); }
        var b = blockedSectors(S.hist), sig = b.join(',');
        D.scan = { range_min: msg.range_min, range_max: msg.range_max, angle_min: msg.angle_min, angle_max: msg.angle_max };
        if (sig !== S.blockSig) { S.blockSig = sig; S.blocked = b; D.sig = ''; }
        changed();
    }
    function syncScan(want) {
        var ros = rosOf();
        if (want && !S.scanSub && ros && root.ROSLIB) {
            S.scanSub = new ROSLIB.Topic({ ros: ros, name: '/rplidar/scan_filtered', messageType: 'sensor_msgs/LaserScan', throttle_rate: 2000, queue_length: 1 });
            S.scanSub.subscribe(onScan);
        } else if (!want && S.scanSub) {
            try { S.scanSub.unsubscribe(onScan); } catch (e) { /* ignore */ }
            S.scanSub = null;
            S.hist = []; S.blocked = []; S.blockSig = '';
        }
    }
    function sync() {
        ensureChecks();
        var on = lidarOn() || camOn(), vis = on && !document.hidden;
        var ok = ensureScene();
        if (vis) { ensureTf(); }
        need('layer', vis);
        syncScan(vis && lidarOn());
        if (ok) {
            S.gL.visible = lidarOn();
            S.gC.visible = camOn();
            place(S.gL, S.tfL);
            place(S.gC, D.tfCam);
            if (vis) { rebuild(); }
        }
        paintCard();
    }

    /* ============================================================ card */
    function row(body, key, value, sub) {
        var r = el('div', 'vt-rng-row');
        r.appendChild(el('span', 'vt-rng-k', t(key)));
        r.appendChild(el('span', 'vt-rng-v', value));
        body.appendChild(r);
        if (sub) { body.appendChild(el('div', 'vt-rng-why', sub)); }
    }
    function sourceLine() {
        var lim = D.limits && D.limits.mapper;
        if (recording()) { return t('ranges.src.rec'); }
        return lim && lim.site ? t('ranges.src.next_site', { site: lim.site }) : t('ranges.src.next');
    }
    function ensureCard() {
        if (S.card) { return S.card; }
        var c = el('div', 'vt-rng-card');
        document.body.appendChild(c);
        c.id = 'vt_ranges_card';
        c.style.display = 'none';
        var head = el('button', 'vt-rng-head');
        head.type = 'button';
        c.appendChild(head);
        S.cardTitle = el('span', 'vt-rng-title');
        head.appendChild(S.cardTitle);
        S.cardArrow = el('i', 'la la-angle-down vt-rng-arrow');
        head.appendChild(S.cardArrow);
        S.cardBody = el('div', 'vt-rng-body');
        c.appendChild(S.cardBody);
        var st = lsGet(LS_CARD);
        S.cardOpen = st === null ? root.innerWidth >= 600 : st === '1';
        head.addEventListener('click', function () {
            S.cardOpen = !S.cardOpen;
            lsSet(LS_CARD, S.cardOpen ? '1' : '0');
            paintCard();
        });
        S.card = c;
        return c;
    }
    function goSettings(tab) {
        var b = document.getElementById('btn_settings');
        var d = document.getElementById('ui_drawer');
        var open = d && d.offsetParent !== null;
        if (b && !open) { b.click(); }
        setTimeout(function () {
            var l = document.querySelector('a.nav-link[href="#' + tab + '"]');
            if (l) { l.click(); }
        }, 50);
    }
    function paintCard() {
        var c = ensureCard(), on = lidarOn() || camOn();
        c.style.display = on ? '' : 'none';
        if (!on) { return; }
        var r = ranges(), B = S.cardBody, L = r.lidar, K = r.camera;
        S.cardTitle.textContent = t('ranges.title');
        S.cardArrow.className = 'la vt-rng-arrow ' + (S.cardOpen ? 'la-angle-down' : 'la-angle-up');
        B.style.display = S.cardOpen ? '' : 'none';
        B.textContent = '';
        if (!S.cardOpen) { return; }
        if (D.limitsErr && !D.limits) { B.appendChild(el('div', 'vt-rng-why', t('ranges.no_data'))); }
        if (lidarOn()) {
            var h = el('div', 'vt-rng-sec');
            h.appendChild(el('span', 'vt-sw-b388ff', '●'));
            var lk = el('a', 'vt-rng-link', t('ranges.lidar'));
            lk.href = '#';
            lk.addEventListener('click', function (e) { e.preventDefault(); goSettings('tab_rplidar'); });
            h.appendChild(lk);
            h.appendChild(el('span', 'vt-rng-v', L.full ? t('ranges.full_view') : deg(L.span)));
            B.appendChild(h);
            row(B, 'ranges.sees', L.sensor ? (L.min ? num(L.min.v, 2) + '–' : '') + m(L.sensor.v) : '—',
                L.sensor ? byText(L.sensor.by) : '');
            row(B, 'ranges.mapping', L.map && L.mapOn ? m(L.map.v) : t('ranges.off'), whyCut(L.map));
            row(B, 'ranges.nav', L.nav ? m(L.nav.v) : '—', L.nav ? byText(L.nav.by) : '');
            if (L.local) { row(B, 'ranges.local', m(L.local.v), ''); }
            if (L.masks.length) { B.appendChild(el('div', 'vt-rng-why', t('ranges.masks', { list: L.masks.join(', ') }))); }
            if (S.blocked.length) { B.appendChild(el('div', 'vt-rng-why vt-rng-warn', t('ranges.blocked', { n: S.blocked.length * 10 }))); }
        }
        if (camOn()) {
            var hc = el('div', 'vt-rng-sec');
            hc.appendChild(el('span', 'vt-sw-ffd23f', '●'));
            var ck = el('a', 'vt-rng-link', t('ranges.camera'));
            ck.href = '#';
            ck.addEventListener('click', function (e) { e.preventDefault(); goSettings('tab_camera'); });
            hc.appendChild(ck);
            hc.appendChild(el('span', 'vt-rng-v', K.fov ? deg(K.fov.h) + (K.sensorFov ? ' (' + t('ranges.fov_sensor', { v: deg(K.sensorFov.h) }) + ')' : '') : '—'));
            B.appendChild(hc);
            if (!K.fov) { B.appendChild(el('div', 'vt-rng-why', t('ranges.no_info'))); }
            row(B, 'ranges.driver', K.clip ? m(K.clip.v) : '—', '');
            row(B, 'ranges.nav', K.navMax ? m(K.navMax.v) : '—', whyCut(K.navMax));
            row(B, 'ranges.map_obs', K.mapObs && K.mapObsOn ? m(K.mapObs.v) : t('ranges.off'), whyCut(K.mapObs));
            row(B, 'ranges.map_free', K.mapFree && K.mapFreeOn ? m(K.mapFree.v) : t('ranges.off'), whyCut(K.mapFree));
            row(B, 'ranges.costmap', K.costmap.obstacle_range ? t('ranges.costmap_v', { v: m(K.costmap.obstacle_range), a: num(K.costmap.min_height, 2), b: num(K.costmap.max_height, 2) }) : '—', '');
            if (K.ground) { row(B, 'ranges.ground', m(K.ground), ''); }
        }
        B.appendChild(el('div', 'vt-rng-why', sourceLine()));
    }

    /* ============================================================ start */
    function init() {
        ensureChecks();
        root.VTSensorLimits.onChange(function () {
            if (S.gL && (lidarOn() || camOn())) { rebuild(); }
            paintCard();
        });
        var hook = setInterval(function () {      // the viewer exists after initMapView
            ensureChecks();
            if (S.chkL && viewer3d() && tfClient()) { clearInterval(hook); sync(); }
        }, 700);
        setInterval(function () {
            if ((lidarOn() || camOn()) && !document.hidden) { scaleLabels(); }
        }, 500);
        document.addEventListener('visibilitychange', sync);
        if (I && I.onChange) { I.onChange(function () { changed(); paintCard(); }); }
    }
    root.VTSensorRanges = {
        show: function (which) {      // Settings › Lidar: "Show on the map"
            ensureChecks();
            var chk = which === 'camera' ? S.chkC : S.chkL;
            if (chk && !chk.checked) { chk.checked = true; lsSet(which === 'camera' ? LS_CAM : LS_LIDAR, '1'); sync(); }
            if (root.map_menu && map_menu.close_drawer) { map_menu.close_drawer(); }
            try { if (root.VtFrame && VtFrame.camLarge && VtFrame.camLarge()) { VtFrame.camSet(false); } } catch (e) { /* layout only */ }
        },
        _state: function () { return S; },
    };
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 800); }); }
    else { setTimeout(init, 800); }
})(typeof window !== 'undefined' ? window : this);
