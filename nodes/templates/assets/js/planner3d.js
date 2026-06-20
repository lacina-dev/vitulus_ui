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
            this.fillMesh.position.z = 0.05; this.fillMesh.renderOrder = 3;
            this.edgeLine = new T.LineSegments(new T.BufferGeometry(),
                new T.LineBasicMaterial({ color: this.lineColor, depthTest: false }));
            this.edgeLine.position.z = 0.1; this.edgeLine.renderOrder = 4;
            this.vertGroup = new T.Group(); this.vertGroup.position.z = 0.15; this.vertGroup.renderOrder = 5;
            this.group.add(this.fillMesh, this.edgeLine, this.vertGroup);
            this._vertGeo = new T.CircleGeometry(1, 16);
            this._vertMat = new T.MeshBasicMaterial({ color: this.pointColor, depthTest: false });
            // The FIRST polygon vertex marks where mowing-path planning starts, so
            // it is drawn in a distinct light-blue to set it apart from the rest.
            this.firstPointColor = new T.Color(opts.firstPointColor || '#5cc8ff');
            this._firstVertMat = new T.MeshBasicMaterial({ color: this.firstPointColor, depthTest: false });

            // ros2d-compatible container facades. map_edit reads .children[i].x/.y
            // and assigns .children = [] to clear; we intercept the assignment.
            var self = this;
            this.pointContainer = {};
            Object.defineProperty(this.pointContainer, 'children', {
                get: function () { return self._pts; },
                set: function (v) { self._pts = v || []; self._redraw(); },
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
            if (this.viewer) this.viewer.markDirty();
        }

        // ---- world<->store helpers (store keeps y = -rosY) ----
        _worldOf(i) { return { x: this._pts[i].x, y: -this._pts[i].y }; }   // -> ros world
        _storeFromRos(pos) { return { x: pos.x, y: -pos.y }; }

        // ---- ros2d-compatible mutation API (positions are ROS metres) ----
        addPoint(pos) { this._pts.push(this._storeFromRos(pos)); this._redraw(); }
        remPoint(index) { if (index >= 0 && index < this._pts.length) { this._pts.splice(index, 1); this._redraw(); } }
        movePoint(index, pos) { if (index >= 0 && index < this._pts.length) { this._pts[index] = this._storeFromRos(pos); this._redraw(); } }
        splitLine(index) {
            var n = this._pts.length; if (n < 2) return;
            var a = this._pts[index], b = this._pts[(index + 1) % n];
            this._pts.splice(index + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            this._redraw();
        }

        // ---- hit testing in ros world coords; returns {type,index} ----
        hitTest(world, tol) {
            var n = this._pts.length, i;
            for (i = 0; i < n; i++) {
                var w = this._worldOf(i);
                if (Math.hypot(w.x - world.x, w.y - world.y) <= tol) return { type: 'vertex', index: i };
            }
            for (i = 0; i < n; i++) {
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
                vm.material = (i === 0) ? this._firstVertMat : this._vertMat;
            }
            this._updateVertexScale();
            // edges (line loop as segments)
            var seg = [];
            if (n >= 2) for (i = 0; i < n; i++) { var a = this._worldOf(i), b = this._worldOf((i + 1) % n); seg.push(a.x, a.y, 0, b.x, b.y, 0); }
            this.edgeLine.geometry.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
            this.edgeLine.geometry.computeBoundingSphere();
            // fill
            if (n >= 3) {
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
    // Replicates the original ctrl=pan / alt=zoom / click=add / shift+vertex=
    // remove / shift+edge=split, plus wheel zoom and basic touch (one finger =
    // add/drag vertex, two fingers = pan + pinch zoom).
    function attachInteraction(viewer, getPolygon, state) {
        // state: { isEnabled():bool (editing gate), onVertexDown(i,ev),
        //          onEdgeDown(i,ev), onAddPoint(world), onMovePoint(i,world),
        //          onReleaseVertex() }
        var el = viewer.renderer.domElement;
        var mouseDown = false, panKey = false, zoomKey = false, clickedPolygon = false;
        var last = { x: 0, y: 0 };

        function hit(ev) {
            var poly = getPolygon();
            if (!poly) return { type: null, index: -1 };
            var world = viewer.screenToWorld(ev.clientX, ev.clientY);
            return poly.hitTest(world, viewer.worldTol(10));
        }

        el.addEventListener('mousedown', function (ev) {
            mouseDown = true; clickedPolygon = false;
            panKey = ev.ctrlKey; zoomKey = ev.altKey;
            last.x = ev.clientX; last.y = ev.clientY;
            if (!panKey && !zoomKey && state.isEnabled()) {
                var h = hit(ev);
                if (h.type === 'vertex') { clickedPolygon = true; state.onVertexDown(h.index, ev); }
                else if (h.type === 'edge') { clickedPolygon = true; state.onEdgeDown(h.index, ev); }
            }
        });
        window.addEventListener('mousemove', function (ev) {
            if (state.draggingVertex()) { state.onMovePoint(state.draggingIndex(), viewer.screenToWorld(ev.clientX, ev.clientY)); viewer.markDirty(); return; }
            if (!mouseDown) return;
            var dx = ev.clientX - last.x, dy = ev.clientY - last.y;
            if (zoomKey) { var f = 1 + (dy > 0 ? 1 : -1) * Math.min(0.25, Math.abs(dy) / 200); viewer.zoomAt(f, last.x, last.y); }
            else if (panKey) { viewer.panByPixels(dx, dy); }
            last.x = ev.clientX; last.y = ev.clientY;
        });
        window.addEventListener('mouseup', function (ev) {
            if (state.draggingVertex()) { state.onReleaseVertex(); mouseDown = false; return; }
            if (mouseDown && !clickedPolygon && !panKey && !zoomKey && state.isEnabled() && _inBounds(el, ev)) {
                state.onAddPoint(viewer.screenToWorld(ev.clientX, ev.clientY));
            }
            mouseDown = false; panKey = false; zoomKey = false; clickedPolygon = false;
        });
        el.addEventListener('wheel', function (ev) {
            ev.preventDefault();
            viewer.zoomAt(ev.deltaY > 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY);
        }, { passive: false });

        // ---- touch ----
        var touchMode = null, t0 = null, t1 = null, pinchStart = 0;
        el.addEventListener('touchstart', function (ev) {
            if (ev.touches.length === 1) {
                var t = ev.touches[0]; last.x = t.clientX; last.y = t.clientY;
                if (state.isEnabled()) {
                    var h = poly_hit(t); if (h.type === 'vertex') { touchMode = 'vertex'; state.onVertexDown(h.index, { nativeEvent: {} }); return; }
                }
                touchMode = 'tap';
            } else if (ev.touches.length === 2) {
                touchMode = 'gesture'; t0 = ev.touches[0]; t1 = ev.touches[1];
                pinchStart = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
                last.x = (t0.clientX + t1.clientX) / 2; last.y = (t0.clientY + t1.clientY) / 2;
            }
            ev.preventDefault();
        }, { passive: false });
        function poly_hit(t) { var poly = getPolygon(); if (!poly) return { type: null }; return poly.hitTest(viewer.screenToWorld(t.clientX, t.clientY), viewer.worldTol(14)); }
        el.addEventListener('touchmove', function (ev) {
            if (touchMode === 'vertex' && ev.touches.length === 1) { var t = ev.touches[0]; state.onMovePoint(state.draggingIndex(), viewer.screenToWorld(t.clientX, t.clientY)); }
            else if (touchMode === 'gesture' && ev.touches.length === 2) {
                var a = ev.touches[0], b = ev.touches[1];
                var mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
                viewer.panByPixels(mid.x - last.x, mid.y - last.y);
                var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                if (pinchStart > 0) viewer.zoomAt(pinchStart / d, mid.x, mid.y);
                pinchStart = d; last.x = mid.x; last.y = mid.y;
            } else if (touchMode === 'tap') { touchMode = 'tapmove'; }
            ev.preventDefault();
        }, { passive: false });
        el.addEventListener('touchend', function (ev) {
            if (touchMode === 'vertex') state.onReleaseVertex();
            else if (touchMode === 'tap' && state.isEnabled()) {
                var t = ev.changedTouches[0]; state.onAddPoint(viewer.screenToWorld(t.clientX, t.clientY));
            }
            if (ev.touches.length === 0) touchMode = null;
            ev.preventDefault();
        }, { passive: false });
    }
    function _inBounds(el, ev) {
        var r = el.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    }

    return { Viewer: Viewer, MapLayer: MapLayer, PathLayer: PathLayer, PolygonEditor: PolygonEditor, attachInteraction: attachInteraction };
})();
