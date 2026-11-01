// planner3d.js — three.js (global THREE r160) top-down replacement for the
// ros2d-based planner renderer, so the planner uses the same 3D base as the
// map view / IMU sections.
//
// World coordinates ARE ROS metres (x right, y up); the camera looks straight
// down -Z (orthographic), so the view behaves exactly like the old 2D editor
// but is rendered by three.js. The classes below expose the same API surface
// that map_edit.js already uses against ros2d, so the ~900 lines of zone /
// program / ROS data handling in map_edit.js are reused unchanged:
//
//   ROS2D.Viewer            -> Planner3D.Viewer        (.scene.addChild/removeChild)
//   ROS2D.OccupancyGridClient -> Planner3D.MapLayer    (.on('change'), .rootObject)
//   ROS2D.PathShape         -> Planner3D.PathLayer      (.setPath, .strokeSize)
//   ROS2D.PolygonMarker     -> Planner3D.PolygonEditor  (.pointContainer.children,
//                                addPoint/remPoint/movePoint/splitLine, callbacks)
//
// map_edit.js reads vertices as `pointContainer.children[i].x` and
// `children[i].y * -1` (ros2d stored screen-y = -rosY), so we keep that exact
// convention: each child is {x: rosX, y: -rosY}.

window.Planner3D = (function () {
    'use strict';
    var T = window.THREE;

    function hex(c) { return (typeof c === 'string') ? c : c; }

    // ------------------------------------------------------------------ Viewer
    class Viewer {
        constructor(opts) {
            opts = opts || {};
            this.dom = document.getElementById(opts.divID);
            this.width = opts.width || (this.dom ? this.dom.clientWidth : 600) || 600;
            this.height = opts.height || (this.dom ? this.dom.clientHeight : 600) || 600;

            this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
            // Cap pixel ratio at 2: on HiDPI phones a 3x buffer of a big map is
            // very heavy in software/weak GPUs and was a likely cause of jank.
            this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            this.renderer.setClearColor(new T.Color(opts.background || '#232f37'), 1);
            this.canvas = this.renderer.domElement;
            if (this.dom) {
                this.dom.innerHTML = '';
                this.dom.appendChild(this.canvas);
                this.canvas.style.display = 'block';
                this.canvas.style.touchAction = 'none';
                this.canvas.style.width = '100%';
                this.canvas.style.height = '100%';
            }
            this.renderer.setSize(this.width, this.height, false);

            this.scene3 = new T.Scene();
            this.scene3.add(new T.AmbientLight(0xffffff, 1.0));
            this._v = new T.Vector3();

            // View state: centre (metres) + half-height (metres) -> zoom.
            this.cx = 0; this.cy = 0; this.viewHalf = 10;
            this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
            this.camera.up.set(0, 1, 0);
            this._applyCamera();

            // Layer groups (drawing order via renderOrder / z).
            this.mapGroup = new T.Group();      this.mapGroup.position.z = 0;
            this.pathGroup = new T.Group();     this.pathGroup.position.z = 0.5;
            this.overlayGroup = new T.Group();  this.overlayGroup.position.z = 1.0;
            this.scene3.add(this.mapGroup, this.pathGroup, this.overlayGroup);

            this._dirty = true;
            this._raf = null;
            var self = this;
            this._loop = function () {
                self._raf = requestAnimationFrame(self._loop);
                // Skip rendering while the planner section is hidden (canvas has
                // no layout box) — avoids wasted GPU work behind the other tabs.
                if (!self._dirty) return;
                if (self.canvas.offsetParent === null || self.canvas.clientWidth === 0) return;
                self._dirty = false;
                self.renderer.render(self.scene3, self.camera);
            };
            this._loop();

            // Keep the drawing buffer matched to the container at all times, even
            // when the layout changes without a window 'resize' (e.g. a side
            // panel expands). This is the robust fix for the map distorting /
            // disappearing and clicks landing in the wrong place.
            if (window.ResizeObserver && this.dom) {
                this._ro = new ResizeObserver(function () { self._syncSize(); });
                this._ro.observe(this.dom);
            }

            // Compatibility "scene" object mirroring ros2d's viewer.scene API
            // that map_edit.js calls (addChild/removeChild of editor & path,
            // and the scaleX/scaleY reset on map change).
            this.scene = {
                addChild: function (obj) { if (obj && obj._attach) obj._attach(self); },
                removeChild: function (obj) { if (obj && obj._detach) obj._detach(self); },
                scaleX: 1, scaleY: 1,
            };

            // Expose the active viewer for diagnostics/tests.
            if (window.Planner3D) window.Planner3D._lastViewer = this;
        }

        // Read the container's current pixel size and resize to match.
        _syncSize() {
            var w = this.dom ? this.dom.clientWidth : this.width;
            var h = this.dom ? this.dom.clientHeight : this.height;
            if (w > 0 && h > 0 && (w !== this.width || h !== this.height)) this.resize(w, h);
        }

        _applyCamera() {
            var aspect = (this.height > 0) ? this.width / this.height : 1;
            if (!isFinite(aspect) || aspect <= 0) aspect = 1;
            this.camera.left = -this.viewHalf * aspect;
            this.camera.right = this.viewHalf * aspect;
            this.camera.top = this.viewHalf;
            this.camera.bottom = -this.viewHalf;
            this.camera.position.set(this.cx, this.cy, 100);
            this.camera.lookAt(this.cx, this.cy, 0);
            this.camera.updateProjectionMatrix();
            this.markDirty();
        }

        markDirty() { this._dirty = true; }

        resize(w, h) {
            w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
            if (w === this.width && h === this.height) { this.markDirty(); return; }
            this.width = w; this.height = h;
            // updateStyle=false: the canvas is CSS-sized to 100% of the container,
            // so we only need to size the drawing buffer to match.
            this.renderer.setSize(this.width, this.height, false);
            this._applyCamera();
        }

        // pixels per metre at current zoom (vertical)
        pxPerM() { return this.height / (2 * this.viewHalf); }
        worldTol(px) { return px / this.pxPerM(); }

        // Map a screen point to world (ROS) metres. Uses unproject through the
        // actual camera so the result is always exactly consistent with what is
        // rendered, regardless of devicePixelRatio or canvas size.
        screenToWorld(clientX, clientY) {
            var r = this.canvas.getBoundingClientRect();
            var w = r.width || this.width, h = r.height || this.height;
            this._v.set(((clientX - r.left) / w) * 2 - 1,
                        -(((clientY - r.top) / h) * 2 - 1), 0);
            this._v.unproject(this.camera);
            return { x: this._v.x, y: this._v.y };
        }

        panByPixels(dxPx, dyPx) {
            var mPerPx = (2 * this.viewHalf) / this.height;
            this.cx -= dxPx * mPerPx;     // drag right -> content follows cursor
            this.cy += dyPx * mPerPx;
            this._applyCamera();
        }

        zoomAt(factor, clientX, clientY) {
            var before = this.screenToWorld(clientX, clientY);
            this.viewHalf = Math.max(0.25, Math.min(2000, this.viewHalf * factor));
            this._applyCamera();
            var after = this.screenToWorld(clientX, clientY);
            this.cx += before.x - after.x;
            this.cy += before.y - after.y;
            this._applyCamera();
            if (this.onZoom) this.onZoom();
        }

        // Fit the given bounds {minx,miny,maxx,maxy} (metres) into the view.
        frameTo(b, pad) {
            if (!b) return;
            pad = (pad == null) ? 1.1 : pad;
            this.cx = (b.minx + b.maxx) / 2;
            this.cy = (b.miny + b.maxy) / 2;
            var halfH = Math.max(0.5, (b.maxy - b.miny) / 2);
            var aspect = this.width / this.height;
            var halfW = Math.max(0.5, (b.maxx - b.minx) / 2) / aspect;
            this.viewHalf = Math.max(halfH, halfW) * pad;
            this._applyCamera();
            if (this.onZoom) this.onZoom();
        }
    }

    // ---------------------------------------------------------------- MapLayer
    // Replaces ROS2D.OccupancyGridClient: subscribes to a nav_msgs/OccupancyGrid
    // topic and renders it as a textured plane. Emits 'change' (EventEmitter2).
    class MapLayer {
        constructor(opts) {
            EventEmitter2.call(this);
            var self = this;
            this.viewer = opts.viewer;
            this.continuous = opts.continuous;
            this.mesh = null;
            this.bounds = null;
            this.rootObject = { addChild: function (o) { if (o && o._attach) o._attach(self.viewer); } };

            this._topic = new ROSLIB.Topic({
                ros: opts.ros, name: opts.topic || '/map',
                messageType: 'nav_msgs/OccupancyGrid', compression: 'png',
            });
            // Coalesce incoming maps: store the latest and render at most once per
            // animation frame. The map can arrive in bursts (connection
            // reconnects, reload retries, live edits); rendering every one was
            // allocating a fresh 5.7 MB ImageData + texture each time and thrashed
            // the GC into multi-second pauses. We now render only the newest.
            this._pending = null;
            this._rafPending = false;
            this._topic.subscribe(function (message) {
                self._pending = message;
                self._scheduleRender();
            });
        }

        _scheduleRender() {
            if (this._rafPending) return;
            this._rafPending = true;
            var self = this;
            requestAnimationFrame(function () {
                self._rafPending = false;
                var msg = self._pending; self._pending = null;
                if (!msg) return;
                self._render(msg);
                self.emit('change');
                if (!self.continuous && self._topic) self._topic.unsubscribe();
            });
        }

        _render(message) {
            var info = message.info, W = info.width, H = info.height, res = info.resolution;
            var ox = info.origin.position.x, oy = info.origin.position.y;

            // Reuse the canvas / ImageData / texture / geometry across messages;
            // only reallocate when the map dimensions actually change. This keeps
            // the per-update cost to an in-place pixel fill + a texture re-upload,
            // with no large allocations (the GC pressure that froze the UI).
            var dimsChanged = (W !== this._W || H !== this._H);
            if (dimsChanged) {
                this._W = W; this._H = H;
                this._canvas = document.createElement('canvas');
                this._canvas.width = W; this._canvas.height = H;
                this._ctx = this._canvas.getContext('2d');
                this._img = this._ctx.createImageData(W, H);
                var dd = this._img.data;            // set alpha once, then leave it
                for (var a = 3; a < dd.length; a += 4) dd[a] = 255;
            }

            var data = this._img.data, src = message.data;
            for (var r = 0; r < H; r++) {
                var rowOut = r * W * 4;             // canvas row 0 = top = highest world-y
                var rowIn = (H - 1 - r) * W;
                for (var c = 0; c < W; c++) {
                    var d = src[rowIn + c];
                    var v = (d === 100) ? 0 : (d === 0) ? 255 : 127;
                    var i = rowOut + c * 4;
                    data[i] = data[i + 1] = data[i + 2] = v;
                }
            }
            this._ctx.putImageData(this._img, 0, 0);

            if (dimsChanged || !this.mesh) {
                if (this.mesh) {
                    this.viewer.mapGroup.remove(this.mesh);
                    if (this.mesh.material.map) this.mesh.material.map.dispose();
                    this.mesh.material.dispose(); this.mesh.geometry.dispose();
                }
                this._tex = new T.CanvasTexture(this._canvas);
                this._tex.magFilter = T.NearestFilter;
                this._tex.minFilter = T.LinearFilter;
                this._tex.generateMipmaps = false;
                this.mesh = new T.Mesh(new T.PlaneGeometry(W * res, H * res),
                    new T.MeshBasicMaterial({ map: this._tex }));
                this._res = res;
                this.viewer.mapGroup.add(this.mesh);
            } else {
                this._tex.needsUpdate = true;       // reuse texture, flag re-upload
                if (this._res !== res) {            // resolution changed (rare)
                    this._res = res;
                    this.mesh.geometry.dispose();
                    this.mesh.geometry = new T.PlaneGeometry(W * res, H * res);
                }
            }
            this.mesh.position.set(ox + W * res / 2, oy + H * res / 2, 0);
            this.bounds = { minx: ox, miny: oy, maxx: ox + W * res, maxy: oy + H * res };
            this.viewer.markDirty();
        }
    }
    MapLayer.prototype.__proto__ = EventEmitter2.prototype;

    // --------------------------------------------------------------- PathLayer
    // Replaces ROS2D.PathShape (the coverage path). Renders a nav_msgs/Path as a
    // flat ribbon of `strokeSize` width (metres), so e.g. the 0.45 m footprint
    // path shows its true width like a mown strip.
    class PathLayer {
        constructor(opts) {
            opts = opts || {};
            this.viewer = null;
            this.color = new T.Color(opts.strokeColor || '#ff0000');
            this.strokeSize = opts.strokeSize || 0.03;
            this.poses = null;
            this.mesh = new T.Mesh(new T.BufferGeometry(),
                new T.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.85, side: T.DoubleSide }));
            this.mesh.renderOrder = 2;
        }
        _attach(viewer) { this.viewer = viewer; if (this.mesh.parent !== viewer.pathGroup) viewer.pathGroup.add(this.mesh); viewer.markDirty(); }
        _detach(viewer) { viewer.pathGroup.remove(this.mesh); viewer.markDirty(); }

        setPath(path) {
            this.poses = (path && path.poses) ? path.poses : null;
            this._rebuild();
        }
        _rebuild() {
            var poses = this.poses;
            var geo = this.mesh.geometry;
            if (!poses || poses.length < 2) { geo.setIndex([]); geo.setAttribute('position', new T.Float32BufferAttribute([], 3)); geo.computeBoundingSphere(); if (this.viewer) this.viewer.markDirty(); return; }
            var hw = Math.max(0.01, this.strokeSize) / 2;
            var pts = [];
            for (var i = 0; i < poses.length; i++) pts.push([poses[i].pose.position.x, poses[i].pose.position.y]);
            var pos = [], idx = [];
            // Build a triangle strip ribbon by offsetting each vertex by the
            // averaged segment normal.
            for (var k = 0; k < pts.length; k++) {
                var prev = pts[Math.max(0, k - 1)], next = pts[Math.min(pts.length - 1, k + 1)];
                var tx = next[0] - prev[0], ty = next[1] - prev[1];
                var len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
                var nx = -ty, ny = tx;       // left normal
                pos.push(pts[k][0] + nx * hw, pts[k][1] + ny * hw, 0);
                pos.push(pts[k][0] - nx * hw, pts[k][1] - ny * hw, 0);
            }
            for (var s = 0; s < pts.length - 1; s++) {
                var a = s * 2;
                idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
            geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
            geo.setIndex(idx);
            geo.computeBoundingSphere();
            if (this.viewer) this.viewer.markDirty();
        }
    }

    // ----------------------------------------------------------- PolygonEditor
    // Replaces ROS2D.PolygonMarker. Vertices are constant-pixel discs; edges are
    // a line loop; the interior is a translucent filled shape. The vertex store
    // keeps ros2d's screen-y convention {x: rosX, y: -rosY} so map_edit.js reads
    // it unchanged.
    class PolygonEditor {
        constructor(opts) {
            opts = opts || {};
            this.viewer = null;
            this.attached = false;
            this.lineColor = new T.Color(opts.lineColor || '#6464ff');
            this.pointColor = new T.Color(opts.pointColor || '#ff3232');
            this.fillColor = new T.Color(opts.fillColor || '#37c837');
            this.pointPx = opts.pointPx || 7;     // vertex radius in screen pixels
            this.lineCallBack = opts.lineCallBack;
            this.pointCallBack = opts.pointCallBack;

            this._pts = [];                        // [{x: rosX, y: -rosY}]
            this.group = new T.Group();
            this.fillMesh = new T.Mesh(new T.BufferGeometry(),
                new T.MeshBasicMaterial({ color: this.fillColor, transparent: true, opacity: 0.28, side: T.DoubleSide, depthTest: false }));
            // Above every editor layer: the shape being edited is what you act on.
            this.fillMesh.position.z = 0.05; this.fillMesh.renderOrder = 50;
            this.edgeLine = new T.LineSegments(new T.BufferGeometry(),
                new T.LineBasicMaterial({ color: this.lineColor, depthTest: false }));
            this.edgeLine.position.z = 0.1; this.edgeLine.renderOrder = 51;
            this.vertGroup = new T.Group(); this.vertGroup.position.z = 0.15;
            this.midGroup = new T.Group(); this.midGroup.position.z = 0.14;
            this.group.add(this.fillMesh, this.edgeLine, this.midGroup, this.vertGroup);
            this._vertGeo = new T.CircleGeometry(1, 16);
            this._vertMat = new T.MeshBasicMaterial({ color: this.pointColor, depthTest: false, transparent: true });
            this._selMat = new T.MeshBasicMaterial({ color: new T.Color('#ffd84a'), depthTest: false, transparent: true });
            this._midMat = new T.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.75 });
            // The FIRST polygon vertex marks where mowing-path planning starts, so
            // it is drawn in a distinct light-blue to set it apart from the rest.
            this.firstPointColor = new T.Color(opts.firstPointColor || '#5cc8ff');
            this._firstVertMat = new T.MeshBasicMaterial({ color: this.firstPointColor, depthTest: false, transparent: true });

            // Shape editing. openLine: a chain without the closing edge (path,
            // barrier). showMids: a "+" handle on every edge long enough to hit.
            // minPoints: remPoint keeps at least this many vertices.
            // selected: the vertex the panel's "Delete point" acts on.
            // onChange: called after every change of the vertices.
            this.showMids = false;
            this.minPoints = 0;
            this.selected = -1;
            this.onChange = null;
            this._undo = [];

            // ros2d-compatible container facades. map_edit reads .children[i].x/.y
            // and assigns .children = [] to clear; we intercept the assignment.
            var self = this;
            this.pointContainer = {};
            Object.defineProperty(this.pointContainer, 'children', {
                get: function () { return self._pts; },
                set: function (v) { self._pts = v || []; self.selected = -1; self._undo = []; self._redraw(); self._changed(); },
            });
            this.lineContainer = {}; var dummyLines = [];
            Object.defineProperty(this.lineContainer, 'children', {
                get: function () { return dummyLines; },
                set: function (v) { dummyLines = v || []; },  // cleared together with points
            });
            this.fillShape = { graphics: { _instructions: [], _oldInstructions: [], clear: function () {} } };

            if (window.Planner3D) window.Planner3D._lastEditor = this;
        }

        // attach/detach via viewer.scene.addChild/removeChild compatibility
        _attach(viewer) {
            this.viewer = viewer;
            if (!this.attached) { viewer.overlayGroup.add(this.group); this.attached = true; }
            if (!this._onZoomBound) {
                var self = this;
                this._onZoomBound = function () { self._updateVertexScale(); };
            }
            viewer.onZoom = this._composeZoom(viewer.onZoom, this._onZoomBound);
            this._updateVertexScale();
            // vitulus_ui integrated overlay: a shape is now open for editing, so
            // the overlay should grab the mouse (see Ros3dEditOverlay.setDrawing).
            if (viewer.setDrawing) viewer.setDrawing(true);
            viewer.markDirty();
        }
        _detach(viewer) {
            if (this.attached) { viewer.overlayGroup.remove(this.group); this.attached = false; viewer.markDirty(); }
            if (viewer.setDrawing) viewer.setDrawing(false);
        }
        _composeZoom(orig, extra) {
            if (!orig || orig === extra) return extra;
            return function () { try { orig(); } catch (e) {} extra(); };
        }

        _vertWorldRadius() { return this.viewer ? this.viewer.worldTol(this.pointPx) : 0.15; }
        _updateVertexScale() {
            var rad = this._vertWorldRadius();
            // The first vertex (mowing-path start) is drawn a bit larger than the
            // rest so it stands out together with its light-blue colour.
            for (var i = 0; i < this.vertGroup.children.length; i++) {
                var r = (i === 0) ? rad * 1.6 : rad;
                this.vertGroup.children[i].scale.set(r, r, 1);
            }
            this._layoutMids(rad);
            if (this.viewer) this.viewer.markDirty();
        }
        // "+" handles: edge midpoints, only where the edge is long enough on
        // screen for the handle not to sit on its neighbours.
        _edgeCount() {
            var n = this._pts.length;
            return n < 2 ? 0 : (this.openLine ? n - 1 : n);
        }
        _layoutMids(rad) {
            var eN = this.showMids ? this._edgeCount() : 0, n = this._pts.length;
            var minLen = this.viewer ? this.viewer.worldTol(this.midMinPx()) : 1;
            var used = 0;
            this._mids = [];
            for (var i = 0; i < eN; i++) {
                var a = this._worldOf(i), b = this._worldOf((i + 1) % n);
                if (Math.hypot(b.x - a.x, b.y - a.y) < minLen) continue;
                var m = this.midGroup.children[used];
                if (!m) { m = new T.Mesh(this._vertGeo, this._midMat); m.renderOrder = 52; this.midGroup.add(m); }
                m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
                m.scale.set(rad * 0.62, rad * 0.62, 1);
                m.visible = true;
                this._mids.push({ index: i, x: m.position.x, y: m.position.y });
                used++;
            }
            for (var k = used; k < this.midGroup.children.length; k++) this.midGroup.children[k].visible = false;
        }
        midMinPx() { return this.pointPx * 7; }

        // ---- world<->store helpers (store keeps y = -rosY) ----
        _worldOf(i) { return { x: this._pts[i].x, y: -this._pts[i].y }; }   // -> ros world
        _storeFromRos(pos) { return { x: pos.x, y: -pos.y }; }

        // ---- ros2d-compatible mutation API (positions are ROS metres) ----
        addPoint(pos) { this.checkpoint(); this._pts.push(this._storeFromRos(pos)); this._redraw(); this._changed(); }
        remPoint(index) {
            if (index < 0 || index >= this._pts.length || this._pts.length <= this.minPoints) return false;
            this.checkpoint();
            this._pts.splice(index, 1);
            this.selected = -1;
            this._redraw(); this._changed();
            return true;
        }
        // A drag calls movePoint many times: its one checkpoint is taken by the
        // gesture when the drag starts.
        // Replace all vertices in one undo step (a driven trace, simplified).
        setPoints(pts, noCheckpoint) {
            if (!noCheckpoint) this.checkpoint();
            this._pts = pts.map(function (p) { return { x: p[0], y: -p[1] }; });
            this.selected = -1;
            this._redraw(); this._changed();
        }
        // A driven trace grows without one undo step per sample.
        appendPoint(pos) { this._pts.push(this._storeFromRos(pos)); this._redraw(); this._changed(); }
        movePoint(index, pos) { if (index >= 0 && index < this._pts.length) { this._pts[index] = this._storeFromRos(pos); this._redraw(); this._changed(); } }
        splitLine(index) {
            var n = this._pts.length; if (n < 2) return -1;
            this.checkpoint();
            var a = this._pts[index], b = this._pts[(index + 1) % n];
            this._pts.splice(index + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            this._redraw(); this._changed();
            return index + 1;
        }
        select(index) { this.selected = index; this._redraw(); this._changed(); }

        // ---- undo: one snapshot per user action ----
        checkpoint() {
            this._undo.push(this._pts.map(function (p) { return { x: p.x, y: p.y }; }));
            if (this._undo.length > 100) this._undo.shift();
        }
        canUndo() { return this._undo.length > 0; }
        undo() {
            if (!this._undo.length) return;
            this._pts = this._undo.pop();
            this.selected = -1;
            this._redraw(); this._changed();
        }
        resetUndo() { this._undo = []; this._changed(); }
        _changed() { if (this.onChange) { try { this.onChange(); } catch (e) { console.error(e); } } }

        // ---- hit testing in ros world coords; returns {type,index} ----
        // The nearest vertex wins, so dense shapes stay usable; a "+" handle
        // comes next, an edge last. An open chain has no closing edge to hit.
        hitTest(world, tol) {
            var n = this._pts.length, i, best = -1, bestD = tol;
            for (i = 0; i < n; i++) {
                var w = this._worldOf(i), d = Math.hypot(w.x - world.x, w.y - world.y);
                if (d <= bestD) { bestD = d; best = i; }
            }
            if (best >= 0) return { type: 'vertex', index: best };
            var mids = this.showMids ? (this._mids || []) : [];
            bestD = tol;
            for (i = 0; i < mids.length; i++) {
                var md = Math.hypot(mids[i].x - world.x, mids[i].y - world.y);
                if (md <= bestD) { bestD = md; best = mids[i].index; }
            }
            if (best >= 0) return { type: 'mid', index: best };
            var eN = this._edgeCount();
            for (i = 0; i < eN; i++) {
                var p1 = this._worldOf(i), p2 = this._worldOf((i + 1) % n);
                if (this._distToSeg(world, p1, p2) <= tol * 0.8) return { type: 'edge', index: i };
            }
            return { type: null, index: -1 };
        }
        _distToSeg(p, a, b) {
            var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
            if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
            var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        }

        // ---- rendering ----
        _redraw() {
            var n = this._pts.length, i;
            // vertices
            while (this.vertGroup.children.length > n) { var m = this.vertGroup.children.pop(); m.geometry = null; }
            while (this.vertGroup.children.length < n) {
                var mesh = new T.Mesh(this._vertGeo, this._vertMat); this.vertGroup.add(mesh);
            }
            for (i = 0; i < n; i++) {
                var w = this._worldOf(i);
                var vm = this.vertGroup.children[i];
                vm.position.set(w.x, w.y, 0);
                // first vertex = mowing-path start point -> light-blue, rest red
                vm.material = (i === this.selected) ? this._selMat
                    : ((i === 0) ? this._firstVertMat : this._vertMat);
                vm.renderOrder = (i === this.selected) ? 54 : 53;
            }
            this._updateVertexScale();
            // edges (line loop as segments; openLine=true draws an open chain
            // without the closing segment - used by the path/barrier tools)
            var seg = [];
            var eN = this._edgeCount();
            for (i = 0; i < eN; i++) { var a = this._worldOf(i), b = this._worldOf((i + 1) % n); seg.push(a.x, a.y, 0, b.x, b.y, 0); }
            this.edgeLine.geometry.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
            this.edgeLine.geometry.computeBoundingSphere();
            // fill
            if (n >= 3 && !this.openLine) {
                var shape = new T.Shape();
                var w0 = this._worldOf(0); shape.moveTo(w0.x, w0.y);
                for (i = 1; i < n; i++) { var wi = this._worldOf(i); shape.lineTo(wi.x, wi.y); }
                shape.closePath();
                this.fillMesh.geometry.dispose();
                this.fillMesh.geometry = new T.ShapeGeometry(shape);
                this.fillMesh.visible = true;
            } else {
                this.fillMesh.visible = false;
            }
            if (this.viewer) this.viewer.markDirty();
        }
    }

    // --------------------------------------------------- interaction wiring
    // One gesture code for mouse, pen and touch (Pointer Events), in map and
    // shape alike:
    //   tap on empty map     state.onTap(world, ev)
    //   drag on empty map    pan (one finger or the mouse; ctrl+drag as before)
    //   pinch, wheel         zoom; alt+drag on the map as before, alt+tap is a
    //                        tap (alt = no snap)
    //   drag a vertex        move it
    //   tap a vertex         state.onVertexTap(i)  (shift+click removes it)
    //   tap or drag a "+"    a new vertex on that edge
    //   shift+click an edge  split it
    // A touch has a fat fingertip, hence the larger tolerance. A second finger
    // during a vertex drag means "zoom": the drag is taken back.
    //
    // state: { isEnabled():bool (a shape is open), onTap(world, ev),
    //          onVertexTap(i), onGesture() (the map was touched),
    //          snap(world, ev, index) -> where a dragged vertex lands (optional),
    //          onHover(world, ev), onDragEnd() }
    function attachInteraction(viewer, getPolygon, state) {
        var el = viewer.renderer.domElement;
        var ptrs = {};          // pointerId -> {x, y}
        var g = null;           // the gesture in progress
        var DRAG_PX = 6;
        el.style.touchAction = 'none';

        function nPtrs() { return Object.keys(ptrs).length; }
        function twoPtrs() { var k = Object.keys(ptrs); return [ptrs[k[0]], ptrs[k[1]]]; }
        function toWorld(ev) { return viewer.screenToWorld(ev.clientX, ev.clientY); }
        function tolPx(ev) { return ev.pointerType === 'mouse' ? 12 : 22; }   // 44 px target
        function shapeHit(ev) {
            var poly = getPolygon();
            if (!poly || !state.isEnabled()) return { type: null, index: -1 };
            return poly.hitTest(toWorld(ev), viewer.worldTol(tolPx(ev)));
        }
        function takeBackDrag() {
            var poly = getPolygon();
            if (g && g.dragged && poly) poly.undo();
        }

        el.addEventListener('pointerdown', function (ev) {
            ptrs[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
            try { el.setPointerCapture(ev.pointerId); } catch (e) {}
            if (state.onGesture) state.onGesture();
            if (nPtrs() === 2) {
                takeBackDrag();
                var p = twoPtrs();
                g = { kind: 'pinch', d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y),
                      x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
                return;
            }
            if (nPtrs() > 2) return;
            var base = { x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY };
            if (ev.button !== 0 || ev.ctrlKey) { g = Object.assign(base, { kind: 'pan' }); return; }
            var h = shapeHit(ev), poly = getPolygon();
            if (ev.altKey && h.type !== 'vertex' && h.type !== 'mid') { g = Object.assign(base, { kind: 'zoomdrag', moved: false }); return; }
            if (h.type === 'vertex') {
                if (ev.shiftKey) { poly.remPoint(h.index); return; }
                g = Object.assign(base, { kind: 'vertex', index: h.index, dragged: false });
            } else if (h.type === 'mid') {
                g = Object.assign(base, { kind: 'mid', index: h.index, dragged: false });
            } else if (h.type === 'edge' && ev.shiftKey) {
                poly.splitLine(h.index);
            } else {
                g = Object.assign(base, { kind: 'tap' });
            }
        });

        el.addEventListener('pointermove', function (ev) {
            if (!(ev.pointerId in ptrs)) {
                if (ev.pointerType === 'mouse') {   // hover: say what a press would do
                    var over = shapeHit(ev).type;
                    el.style.cursor = (over === 'vertex' || over === 'mid') ? 'pointer' : '';
                    if (state.onHover) state.onHover(toWorld(ev), ev);
                }
                return;
            }
            ptrs[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
            if (!g) return;
            var poly = getPolygon();
            if (g.kind === 'pinch') {
                if (nPtrs() < 2) return;
                var p = twoPtrs();
                var mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
                var d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
                viewer.panByPixels(mid.x - g.x, mid.y - g.y);
                if (g.d > 0 && d > 0) viewer.zoomAt(g.d / d, mid.x, mid.y);
                g.d = d; g.x = mid.x; g.y = mid.y;
                return;
            }
            var far = Math.hypot(ev.clientX - g.x0, ev.clientY - g.y0) > DRAG_PX;
            if (g.kind === 'tap' && far) g.kind = 'pan';
            if (g.kind === 'pan') viewer.panByPixels(ev.clientX - g.x, ev.clientY - g.y);
            else if (g.kind === 'zoomdrag') {
                if (!far && !g.moved) return;
                g.moved = true;
                var dy = ev.clientY - g.y;
                viewer.zoomAt(1 + (dy > 0 ? 1 : -1) * Math.min(0.25, Math.abs(dy) / 200), g.x, g.y);
            } else if (g.kind === 'mid' && far) {
                g.index = poly.splitLine(g.index);       // its checkpoint covers the drag
                g.kind = 'vertex'; g.dragged = true;
            } else if (g.kind === 'vertex' && (far || g.dragged)) {
                if (!g.dragged) { poly.checkpoint(); g.dragged = true; }
                poly.movePoint(g.index, state.snap ? state.snap(toWorld(ev), ev, g.index) : toWorld(ev));
            }
            g.x = ev.clientX; g.y = ev.clientY;
            viewer.markDirty();
        });

        function pointerGone(ev, cancelled) {
            var known = ev.pointerId in ptrs;
            delete ptrs[ev.pointerId];
            if (!known || !g) return;
            if (g.kind === 'pinch') { if (nPtrs() === 0) g = null; return; }
            var done = g; g = null;
            if (state.onDragEnd) state.onDragEnd();
            if (cancelled) { if (done.dragged) { g = done; takeBackDrag(); g = null; } return; }
            var poly = getPolygon();
            if (done.kind === 'tap' || (done.kind === 'zoomdrag' && !done.moved)) { if (state.onTap) state.onTap(toWorld(ev), ev); }
            else if (done.kind === 'vertex' && !done.dragged) { if (state.onVertexTap) state.onVertexTap(done.index); }
            else if (done.kind === 'mid') { var i = poly.splitLine(done.index); if (state.onVertexTap) state.onVertexTap(i); }
        }
        el.addEventListener('pointerup', function (ev) { pointerGone(ev, false); });
        el.addEventListener('pointercancel', function (ev) { pointerGone(ev, true); });
        el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

        el.addEventListener('wheel', function (ev) {
            ev.preventDefault();
            var f = ev.deltaY > 0 ? 1.1 : 1 / 1.1;
            viewer.zoomAt(viewer.invertWheel ? 1 / f : f, ev.clientX, ev.clientY);
        }, { passive: false });
    }

    return { Viewer: Viewer, MapLayer: MapLayer, PathLayer: PathLayer, PolygonEditor: PolygonEditor, attachInteraction: attachInteraction };
})();
