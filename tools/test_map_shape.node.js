#!/usr/bin/env node
/*
 * Shape editing of the map editor, without a browser.
 *
 *     node tools/test_map_shape.node.js
 *
 * planner3d.js runs on a stub of THREE, so Planner3D.PolygonEditor and
 * Planner3D.attachInteraction are the real code; pointer events are fired by
 * hand at a fake canvas whose world is 1 px = 0.01 m. _crosses is sliced out of
 * mapedits.js. Checks:
 *   - hit testing: nearest vertex, white dot, no closing edge on an open line,
 *   - undo: one step per action, a whole drag is one step,
 *   - minPoints holds, selection follows,
 *   - gestures: tap, pan, vertex drag, new vertex by tap and by drag, pinch,
 *     a second finger takes the drag back, a cancelled drag is taken back,
 *     shift+click, the fatter touch target, wheel direction,
 *   - a crossing outline is recognised and a plain one is not,
 *   - a reshaped path keeps the headings of the poses it did not touch.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');

// ---- the part of THREE that PolygonEditor touches
class V { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { this.x = x; this.y = y; this.z = z; } }
class Obj {
    constructor() { this.position = new V(); this.scale = new V(); this.children = []; this.visible = true; }
    add() { for (let i = 0; i < arguments.length; i++) { this.children.push(arguments[i]); } }
    remove(o) { this.children = this.children.filter(c => c !== o); }
}
class Geo { setAttribute() {} computeBoundingSphere() {} dispose() {} }
const THREE = {
    Color: class {}, Group: Obj,
    Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
    LineSegments: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
    BufferGeometry: Geo, CircleGeometry: Geo, ShapeGeometry: Geo,
    MeshBasicMaterial: class {}, LineBasicMaterial: class {},
    Float32BufferAttribute: class {},
    Shape: class { moveTo() {} lineTo() {} closePath() {} },
};
const window = {THREE: THREE};
const src = fs.readFileSync(path.join(JS, 'planner3d.js'), 'utf8');
new Function('window', 'EventEmitter2', src)(window, class {});
const Planner3D = window.Planner3D;

function canvas() {
    const on = {};
    return {
        style: {},
        addEventListener(t, f) { on[t] = f; },
        setPointerCapture() {},
        fire(t, ev) { on[t](Object.assign({pointerType: 'mouse', button: 0, preventDefault() {}}, ev)); },
    };
}
function rig(points, opts) {
    const el = canvas();
    const log = {taps: [], vertex: [], pan: [0, 0], zoom: [], gestures: 0};
    const viewer = {
        renderer: {domElement: el},
        screenToWorld: (x, y) => ({x: x / 100, y: y / 100}),   // 1 px = 1 cm
        worldTol: px => px / 100,
        panByPixels(dx, dy) { log.pan[0] += dx; log.pan[1] += dy; },
        zoomAt(f) { log.zoom.push(f); },
        markDirty() {}, setDrawing() {}, overlayGroup: new Obj(),
        invertWheel: !!(opts && opts.invertWheel),
    };
    const P = new Planner3D.PolygonEditor({pointPx: 7});
    Object.assign(P, {showMids: true, minPoints: 0}, opts && opts.poly);
    P._attach(viewer);
    P.pointContainer.children = points.map(p => ({x: p[0], y: -p[1]}));
    Planner3D.attachInteraction(viewer, () => P, {
        isEnabled: () => P.attached,
        onTap: (w, ev) => log.taps.push([w.x, w.y, ev.pointerType]),
        onVertexTap: i => log.vertex.push(i),
        onGesture: () => { log.gestures++; },
    });
    return {el, P, log};
}
function pts(P) { return P.pointContainer.children.map(p => [p.x, -p.y]); }
function down(r, x, y, ev) { r.el.fire('pointerdown', Object.assign({pointerId: 1, clientX: x, clientY: y}, ev)); }
function move(r, x, y, ev) { r.el.fire('pointermove', Object.assign({pointerId: 1, clientX: x, clientY: y}, ev)); }
function up(r, x, y, ev) { r.el.fire('pointerup', Object.assign({pointerId: 1, clientX: x, clientY: y}, ev)); }
function drag(r, a, b, ev) { down(r, a[0], a[1], ev); move(r, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ev); move(r, b[0], b[1], ev); up(r, b[0], b[1], ev); }

let failed = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failed++; }
    console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
}
const SQ = [[1, 1], [3, 1], [3, 3], [1, 3]];       // metres; 200 px edges

let r = rig(SQ);
check('hit: nearest of two vertices', r.P.hitTest({x: 2.9, y: 1}, 2.2), {type: 'vertex', index: 1});
check('hit: white dot', r.P.hitTest({x: 2, y: 1}, 0.2), {type: 'mid', index: 0});
check('hit: edge away from the dot', r.P.hitTest({x: 1.5, y: 1}, 0.2), {type: 'edge', index: 0});
check('hit: closing edge of a ring', r.P.hitTest({x: 1, y: 1.5}, 0.2), {type: 'edge', index: 3});
check('hit: inside is nothing', r.P.hitTest({x: 2, y: 2}, 0.2).type, null);

r = rig(SQ, {poly: {openLine: true}});
check('hit: an open line has no closing edge', r.P.hitTest({x: 1, y: 1.5}, 0.2).type, null);
check('open line: dots on its edges only', r.P._mids.length, 3);

r = rig(SQ, {poly: {minPoints: 3}});
check('nothing to undo at the start', r.P.canUndo(), false);
r.P.remPoint(0);
check('remPoint', pts(r.P).length, 3);
check('minPoints holds', r.P.remPoint(0), false);
r.P.undo();
check('undo brings it back in place', pts(r.P), SQ);

r = rig(SQ);
down(r, 400, 400); up(r, 400, 400);
check('tap on empty map', r.log.taps, [[4, 4, 'mouse']]);
check('...the shape stays', pts(r.P), SQ);
check('...gesture reported', r.log.gestures, 1);

r = rig(SQ);
drag(r, [500, 500], [560, 520]);
check('drag on empty map pans', r.log.pan, [60, 20]);
check('...and is no tap', r.log.taps, []);

r = rig(SQ);
drag(r, [300, 300], [340, 310]);
check('vertex drag', pts(r.P)[2], [3.4, 3.1]);
check('...no pan', r.log.pan, [0, 0]);
r.P.undo();
check('a whole drag is one undo step', pts(r.P), SQ);
check('...and no more steps', r.P.canUndo(), false);

r = rig(SQ);
down(r, 300, 300); move(r, 302, 301); up(r, 302, 301);
check('a shaky press is a tap on the vertex', r.log.vertex, [2]);
check('...it does not move it', pts(r.P), SQ);

r = rig(SQ);
down(r, 200, 100); up(r, 200, 100);
check('tap on a dot adds a vertex', pts(r.P), [[1, 1], [2, 1], [3, 1], [3, 3], [1, 3]]);
check('...and selects it', r.log.vertex, [1]);
r.P.undo();
check('...one undo step', pts(r.P), SQ);

r = rig(SQ);
drag(r, [200, 100], [210, 60]);
check('drag from a dot', pts(r.P)[1], [2.1, 0.6]);
r.P.undo();
check('...one undo step', pts(r.P), SQ);

r = rig(SQ);
down(r, 300, 300, {shiftKey: true}); up(r, 300, 300, {shiftKey: true});
check('shift+click removes a vertex', pts(r.P), [[1, 1], [3, 1], [1, 3]]);

r = rig(SQ);
down(r, 150, 100, {shiftKey: true}); up(r, 150, 100, {shiftKey: true});
check('shift+click on an edge splits it', pts(r.P).length, 5);

r = rig(SQ);
const T = {pointerType: 'touch'};
down(r, 115, 115, T); up(r, 115, 115, T);
check('a fingertip reaches 22 px', r.log.vertex, [0]);
r = rig(SQ);
down(r, 115, 115); up(r, 115, 115);
check('a mouse pointer does not', [r.log.vertex, r.log.taps.length], [[], 1]);

r = rig(SQ);
down(r, 500, 500, T);
r.el.fire('pointerdown', {pointerId: 2, clientX: 600, clientY: 500, pointerType: 'touch'});
r.el.fire('pointermove', {pointerId: 2, clientX: 650, clientY: 500, pointerType: 'touch'});
check('pinch zooms, by the finger distance', r.log.zoom, [100 / 150]);
up(r, 500, 500, T);
r.el.fire('pointerup', {pointerId: 2, clientX: 650, clientY: 500, pointerType: 'touch'});
check('pinch is no tap', r.log.taps, []);

r = rig(SQ);
down(r, 300, 300, T); move(r, 340, 300, T);
check('drag in progress', pts(r.P)[2], [3.4, 3]);
r.el.fire('pointerdown', {pointerId: 2, clientX: 600, clientY: 500, pointerType: 'touch'});
check('a second finger takes the drag back', pts(r.P), SQ);
r.el.fire('pointerup', {pointerId: 2, clientX: 600, clientY: 500, pointerType: 'touch'});
up(r, 340, 300, T);
check('...and nothing is left to undo', r.P.canUndo(), false);

r = rig(SQ);
down(r, 300, 300, T); move(r, 340, 300, T);
r.el.fire('pointercancel', {pointerId: 1, clientX: 340, clientY: 300, pointerType: 'touch'});
check('a cancelled drag is taken back', pts(r.P), SQ);

r = rig(SQ);
r.el.fire('wheel', {deltaY: 100, clientX: 0, clientY: 0});
check('wheel down: away', r.log.zoom[0] > 1, true);
r = rig(SQ, {invertWheel: true});
r.el.fire('wheel', {deltaY: 100, clientX: 0, clientY: 0});
check('inverted like the live map', r.log.zoom[0] < 1, true);

r = rig(SQ);
down(r, 500, 500, {altKey: true}); up(r, 500, 500, {altKey: true});
check('alt+tap on the map is a tap, for placing without snap', r.log.taps.length, 1);
r = rig(SQ);
drag(r, [500, 500], [500, 560], {altKey: true});
check('alt+drag on the map still zooms', [r.log.zoom.length > 0, r.log.taps.length], [true, 0]);
r = rig(SQ);
drag(r, [300, 300], [340, 310], {altKey: true});
check('alt on a vertex moves it', pts(r.P)[2], [3.4, 3.1]);

r = rig(SQ);
r.P.setPoints([[0, 0], [1, 0], [1, 1]], true);
check('setPoints without a step', r.P.canUndo(), false);
r.P.setPoints(SQ);
r.P.undo();
check('setPoints with one step', pts(r.P), [[0, 0], [1, 0], [1, 1]]);
r = rig([]);
r.P.checkpoint(); r.P.appendPoint({x: 1, y: 1}); r.P.appendPoint({x: 2, y: 1});
r.P.undo();
check('a trace comes back with one undo', pts(r.P), []);

r = rig(SQ);
r.P._detach(r.P.viewer);
down(r, 300, 300); up(r, 300, 300);
check('no shape open: a vertex place is a plain tap', [r.log.taps.length, r.log.vertex], [1, []]);

// ---- crossing outline
const ME = fs.readFileSync(path.join(JS, 'mapedits.js'), 'utf8');
const at = ME.indexOf('function _crosses(');
let depth = 0, end = -1;
for (let j = ME.indexOf('{', at); j < ME.length; j++) {
    if (ME[j] === '{') { depth++; }
    if (ME[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
}
const crosses = new Function(ME.slice(at, end) + '\nreturn _crosses;')();
check('a square does not cross', crosses(SQ), false);
check('a triangle does not cross', crosses([[0, 0], [2, 0], [1, 2]]), false);
check('a concave ring does not cross', crosses([[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]]), false);
check('a bowtie crosses', crosses([[0, 0], [2, 2], [2, 0], [0, 2]]), true);
check('a pentagon with a vertex pulled through crosses', crosses([[6, 2], [0, 0], [4, 0], [4, 4], [0, 4]]), true);

// ---- headings of a reshaped path
function sliceFn(name) {
    const from = ME.indexOf('function ' + name + '(');
    let n = 0;
    for (let j = ME.indexOf('{', from); j < ME.length; j++) {
        if (ME[j] === '{') { n++; }
        if (ME[j] === '}') { n--; if (!n) { return ME.slice(from, j + 1); } }
    }
    throw new Error(name);
}
const pathYaws = new Function(sliceFn('pathYaws') + '\nreturn pathYaws;')();
const LINE = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
const REC = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66];     // recorded: not the line's direction
const moved = LINE.map(p => p.slice()); moved[2] = [2, 1];
const up45 = Math.PI / 4, down45 = -Math.PI / 4;
check('unchanged path keeps every heading', pathYaws(LINE, REC, LINE), REC);
check('a moved point changes itself and its neighbours only', pathYaws(LINE, REC, moved),
      [0.11, up45, down45, 0, 0.55, 0.66]);
const added = [[0, 0], [1, 0], [2, 0], [2.5, 1], [3, 0], [4, 0], [5, 0]];
check('an added point: itself and both neighbours',
      pathYaws(LINE, REC, added).map(y => +y.toFixed(3)),
      [0.11, 0.22, 1.107, -1.107, 0, 0.55, 0.66]);
check('a removed point: its two neighbours',
      pathYaws(LINE, REC, [[0, 0], [1, 0], [3, 0], [4, 0], [5, 0]]), [0.11, 0, 0, 0.55, 0.66]);
const lastMoved = LINE.map(p => p.slice()); lastMoved[5] = [4, 1];
check('last point moved: along its segment, neighbour towards it',
      pathYaws(LINE, REC, lastMoved).map(y => +y.toFixed(3)), [0.11, 0.22, 0.33, 0.44, 1.571, 1.571]);
const firstMoved = LINE.map(p => p.slice()); firstMoved[0] = [0, 1];
check('first point moved', pathYaws(LINE, REC, firstMoved), [down45, 0, 0.33, 0.44, 0.55, 0.66]);
const standing = [[0, 0], [0, 0], [1, 0], [2, 0]];    // the robot stood still while recording
check('a standing pose keeps its heading', pathYaws(standing, [1, 2, 3, 4], standing), [1, 2, 3, 4]);
const dup = [[0, 0], [0, 0], [1, 1], [2, 0]];
check('no direction on a zero segment: the one before',
      pathYaws(standing, [1, 2, 3, 4], dup).map(y => +y.toFixed(3)), [1, 0.785, -0.785, -0.785]);
check('result always matches the points', pathYaws(LINE, REC, added).length, added.length);

if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('all checks passed');
