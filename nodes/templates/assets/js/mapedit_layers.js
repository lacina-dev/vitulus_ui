// mapedit_layers.js — what the map editor draws besides the owners' lists (those
// are in mapedits.js): the objects with meaning, the recorded world layers, the
// robot's suggestions, the zone_check preview and the snap ring.
//
// All of it goes into the editor overlay (mapeditor.js) with the global THREE,
// under overlayGroup, so it shows only while the editor is open.
window.MapEditLayers = (function () {
    'use strict';
    var T = window.THREE, MO = window.VTMapObjects;

    var COL = { place: '#8fd14f', landmark: '#ffd23f', nogo: '#ff3b4e', slow: '#ffab45', noblade: '#b388ff', corridor: '#5cc8ff' };
    var LABEL_COL = { place: '#c5ec9f', landmark: '#ffe58a', nogo: '#ff9aa4', slow: '#ffd29a', noblade: '#d9c2ff', corridor: '#a9e0ff' };
    // A rule must read as a rule, not as one more tinted polygon: each has its
    // own hatch. Tile = 1.5 m on the ground.
    var HATCH_M = 1.5;
    function hatch(type) {
        var cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        var c = cv.getContext('2d');
        c.strokeStyle = COL[type]; c.fillStyle = COL[type]; c.lineWidth = 5;
        if (type === 'nogo' || type === 'noblade') {
            c.beginPath();
            for (var i = -64; i < 128; i += 32) { c.moveTo(i, 64); c.lineTo(i + 64, 0); }
            if (type === 'noblade') for (var k = -64; k < 128; k += 32) { c.moveTo(k, 0); c.lineTo(k + 64, 64); }
            c.stroke();
        } else {
            for (var y = 8; y < 64; y += 24) for (var x = 8; x < 64; x += 24) { c.beginPath(); c.arc(x, y, 4, 0, 6.3); c.fill(); }
        }
        var tex = new T.CanvasTexture(cv);
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.repeat.set(1 / HATCH_M, 1 / HATCH_M);
        return tex;
    }
    var _hatch = {};
    function hatchOf(type) { if (!_hatch[type]) _hatch[type] = hatch(type); return _hatch[type]; }

    function outline(pts, closed, dashed) {
        var seg = [], n = pts.length, edges = closed ? n : n - 1;
        for (var i = 0; i < edges; i++) {
            var a = pts[i], b = pts[(i + 1) % n];
            if (!dashed) { seg.push(a[0], a[1], 0, b[0], b[1], 0); continue; }
            var len = Math.hypot(b[0] - a[0], b[1] - a[1]), parts = Math.max(1, Math.floor(len / 0.5));
            for (var k = 0; k < parts; k += 2) {
                var u = k / parts, v = (k + 1) / parts;
                seg.push(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, 0, a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v, 0);
            }
        }
        var g = new T.BufferGeometry();
        g.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
        return g;
    }
    function dispose(o) {
        for (var i = o.children.length - 1; i >= 0; i--) dispose(o.children[i]);
        o.children.length = 0;
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
            // a hatch is shared and stays; a layer image is the layer's own
            if (o.material.map && !o.material.map.userData.keep) o.material.map.dispose();
            o.material.dispose();
        }
    }

    class Layers {
        // deps: {makeLabel(text, x, y, order, color, extent), order(): int, rescale()}
        constructor(overlay, deps) {
            this.overlay = overlay;
            this.deps = deps;
            this.group = new T.Group();  this.group.position.z = 0.09;
            this.world = new T.Group();  this.world.position.z = 0.02;
            this.sugg = new T.Group();   this.sugg.position.z = 0.13;
            this.preview = new T.Group(); this.preview.position.z = 0.07;
            this.mark = new T.Group();   this.mark.position.z = 0.2;
            this.ring = new T.Mesh(new T.RingGeometry(0.72, 1, 24),
                new T.MeshBasicMaterial({ color: 0xffd84a, side: T.DoubleSide, depthTest: false, depthWrite: false, transparent: true }));
            this.ring.renderOrder = 60;
            this.ring.visible = false;
            this.mark.add(this.ring);
            this.attach(overlay);
            this.worlds = {};            // kind -> {mesh, msg}
            for (var k in COL) if (k !== 'place' && k !== 'landmark' && k !== 'corridor') hatchOf(k).userData.keep = true;
        }
        attach(overlay) {
            this.overlay = overlay;
            [this.world, this.preview, this.group, this.sugg, this.mark].forEach(function (g) {
                if (g.parent !== overlay.overlayGroup) overlay.overlayGroup.add(g);
            });
        }
        setPlaces(list, nowS) {
            dispose(this.group);
            var order = this.deps.order();
            for (var i = 0; i < list.length; i++) this._place(list[i], order, nowS);
            this.deps.rescale();
        }
        _place(o, order, nowS) {
            var pts = o.points || [], type = o.type, col = new T.Color(COL[type] || '#ffffff');
            var rs = MO.ruleState(o, nowS), on = rs.state === 'active';
            var dim = on ? 1 : 0.4;
            var tt = MO.TYPES[type] || {};
            if (type === 'landmark' && pts.length) {
                var g = new T.Group();
                g.position.set(pts[0][0], pts[0][1], 0);
                g.userData.wp = true;           // constant size on screen, as a waypoint
                var d = new T.Mesh(new T.CircleGeometry(0.22, 4), new T.MeshBasicMaterial({ color: col, depthTest: false, depthWrite: false }));
                d.renderOrder = order + 2;
                g.add(d);
                this.group.add(g);
            } else if (type === 'corridor' && pts.length >= 2) {
                var w = (o.props && o.props.width_m) || MO.CORRIDOR_W;
                this.group.add(this._ribbon(pts, w, col, order, 0.2 * dim));
                var cl = new T.LineSegments(outline(pts, false, true), new T.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: dim }));
                cl.renderOrder = order + 0.1;
                this.group.add(cl);
            } else if (pts.length >= 3) {
                var shape = new T.Shape();
                shape.moveTo(pts[0][0], pts[0][1]);
                for (var k = 1; k < pts.length; k++) shape.lineTo(pts[k][0], pts[k][1]);
                shape.closePath();
                var mat = tt.rule
                    ? new T.MeshBasicMaterial({ map: hatchOf(type), transparent: true, opacity: 0.75 * dim, side: T.DoubleSide, depthTest: false, depthWrite: false })
                    : new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12 * dim, side: T.DoubleSide, depthTest: false, depthWrite: false });
                var fill = new T.Mesh(new T.ShapeGeometry(shape), mat);
                fill.renderOrder = order;
                this.group.add(fill);
                // an inactive rule keeps its place on the map, dashed
                var line = new T.LineSegments(outline(pts, true, !on), new T.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: dim }));
                line.renderOrder = order + 0.1;
                this.group.add(line);
            }
            if (!pts.length || !o.name) return;
            var text = o.name;
            if (type === 'slow' && o.props && o.props.speed_mps != null) text += ' · ' + Number(o.props.speed_mps).toFixed(2) + ' m/s';
            var c = pts.length === 1 ? pts[0] : this._centre(pts);
            var lb = this.deps.makeLabel(text, c[0], c[1], order + 3, LABEL_COL[type] || '#ffffff', pts.length === 1 ? 0 : this._extent(pts));
            if (lb) {
                lb.userData.label.prio = tt.rule ? 0 : 2;
                if (pts.length === 1) lb.userData.label.beside = true;
                this.group.add(lb);
            }
        }
        _centre(pts) {
            var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            pts.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
            return [(x0 + x1) / 2, (y0 + y1) / 2];
        }
        _extent(pts) {
            var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            pts.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
            return Math.hypot(x1 - x0, y1 - y0);
        }
        _ribbon(pts, width, col, order, opacity) {
            var hw = Math.max(0.02, width) / 2, pos = [], idx = [];
            for (var k = 0; k < pts.length; k++) {
                var prev = pts[Math.max(0, k - 1)], next = pts[Math.min(pts.length - 1, k + 1)];
                var tx = next[0] - prev[0], ty = next[1] - prev[1], len = Math.hypot(tx, ty) || 1;
                var nx = -ty / len, ny = tx / len;
                pos.push(pts[k][0] + nx * hw, pts[k][1] + ny * hw, 0, pts[k][0] - nx * hw, pts[k][1] - ny * hw, 0);
            }
            for (var s = 0; s < pts.length - 1; s++) { var a = s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
            var geo = new T.BufferGeometry();
            geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
            geo.setIndex(idx);
            var m = new T.Mesh(geo, new T.MeshBasicMaterial({ color: col, transparent: true, opacity: opacity, side: T.DoubleSide, depthTest: false, depthWrite: false }));
            m.renderOrder = order;
            return m;
        }

        // ---- recorded world layers: an image over the data's bounding box.
        // origin, w, h and res come with every message (the crop changes).
        setWorld(kind, msg) {
            var self = this, old = this.worlds[kind];
            if (!msg || !msg.w || !msg.h || !msg.png_b64) {
                if (old) { this.world.remove(old); dispose(old); delete this.worlds[kind]; }
                return;
            }
            var img = new Image();
            img.onload = function () {
                var cur = self.worlds[kind];
                if (cur) { self.world.remove(cur); dispose(cur); }
                var tex = new T.Texture(img);
                tex.needsUpdate = true;
                tex.magFilter = T.NearestFilter;
                tex.minFilter = T.LinearFilter;
                tex.generateMipmaps = false;
                var w = msg.w * msg.res, h = msg.h * msg.res;
                var m = new T.Mesh(new T.PlaneGeometry(w, h),
                    new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false }));
                m.position.set(msg.origin[0] + w / 2, msg.origin[1] + h / 2, 0);
                m.renderOrder = self.deps.order() - 3;
                self.world.add(m);
                self.worlds[kind] = m;
            };
            img.src = 'data:image/png;base64,' + msg.png_b64;
        }
        dropWorld(kind) { this.setWorld(kind, null); }

        setSuggestions(list) {
            dispose(this.sugg);
            var col = new T.Color('#ffffff'), order = this.deps.order() + 4;
            for (var i = 0; i < list.length; i++) {
                var pts = list[i].points || [];
                if (!pts.length) continue;
                var ring = pts.length === 1 ? null : pts;
                if (ring) {
                    var l = new T.LineSegments(outline(ring, true, true), new T.LineBasicMaterial({ color: col, depthTest: false }));
                    l.renderOrder = order;
                    this.sugg.add(l);
                } else {
                    var g = new T.Group();
                    g.position.set(pts[0][0], pts[0][1], 0);
                    g.userData.wp = true;
                    var m = new T.Mesh(new T.RingGeometry(0.16, 0.24, 20), new T.MeshBasicMaterial({ color: col, side: T.DoubleSide, depthTest: false, depthWrite: false }));
                    m.renderOrder = order;
                    g.add(m);
                    this.sugg.add(g);
                }
            }
            this.deps.rescale();
        }

        // polylines [[[x, y], ...], ...] of a zone_check
        setPreview(lines) {
            dispose(this.preview);
            var seg = [];
            (lines || []).forEach(function (ln) {
                for (var i = 0; i + 1 < ln.length; i++) seg.push(ln[i][0], ln[i][1], 0, ln[i + 1][0], ln[i + 1][1], 0);
            });
            if (!seg.length) return;
            var g = new T.BufferGeometry();
            g.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
            var l = new T.LineSegments(g, new T.LineBasicMaterial({ color: 0x43d58b, depthTest: false, transparent: true, opacity: 0.8 }));
            l.renderOrder = this.deps.order() - 0.5;
            this.preview.add(l);
        }

        showSnap(p, radiusM) {
            this.ring.visible = !!p;
            if (p) { this.ring.position.set(p.x, p.y, 0); this.ring.scale.set(radiusM, radiusM, 1); }
        }
    }
    return { Layers: Layers };
})();
