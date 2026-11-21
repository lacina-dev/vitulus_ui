#!/usr/bin/env node
/*
 * T17 M20 (2026-11-21) — the view's target stays on the ground:
 *     node tools/test_map_m20.node.js
 * Owner: "no photo background; zoomed in everything disappears and the robot is said to be 2.11 km away."
 * ROS3D pans in the view plane; in a tilted view that lifts / sinks the target. The wheel then zooms towards a
 * point off the ground, the tiles are fetched around its x / y and the "robot out of view" pill measures from it.
 * Here: the pure rule (vtGroundTarget) and the wrapper around the controls' update(), with the pan as ros3d does it.
 * The same in a real browser: tools/test_map_zoom_ui.py.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const JS = path.join(path.resolve(__dirname, '..'), 'nodes', 'templates', 'assets', 'js');
const mv = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
const ros3d = fs.readFileSync(path.join(JS, 'ros3d.js'), 'utf8');
let fails = 0, count = 0;
function check(name, ok, info) {
    count++;
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + (typeof info === 'string' ? info : JSON.stringify(info))));
    if (!ok) { fails++; }
}
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-6);
const src = mv.slice(mv.indexOf('var MAP_GROUND_MIN_DIP'), mv.indexOf('/* T17 M7: the zone pictures'));
const src0 = mv.slice(mv.indexOf('var MAP_MAX_TILT_DEG'), mv.indexOf('/* T17 M7: the zone pictures'));
const G = new Function(src0 + '\nreturn { vtGroundTarget: vtGroundTarget, vtTiltLimit: vtTiltLimit, keep: vtMapKeepTargetOnGround, DIP: MAP_GROUND_MIN_DIP, MAXT: MAP_MAX_TILT_DEG };')();

check('ros3d pans in the VIEW plane (the cause): the pan plane\'s normal is the camera\'s axis, target and camera move by the same step',
    /moveStartNormal = new THREE\.Vector3\(0, 0, 1\);\s*var rMat = new THREE\.Matrix4\(\)\.extractRotation\(this\.camera\.matrix\);\s*moveStartNormal\.applyMatrix4\(rMat\);/.test(ros3d) &&
    /that\.center\.addVectors\(moveStartCenter\.clone\(\), delta\.clone\(\)\);\s*that\.camera\.position\.addVectors\(moveStartPosition\.clone\(\), delta\.clone\(\)\);/.test(ros3d));
check('the map view\'s controls get the guard where their limits are set', /vtMapKeepTargetOnGround\(ctrl\);\s*\}/.test(mv.slice(mv.indexOf('function vtMapCamLimits'), mv.indexOf('var MAP_GROUND_MIN_DIP'))));

// ---- the rule
check('target on the ground: nothing to do', G.vtGroundTarget({ x: 0, y: -100, z: 100 }, { x: 0, y: 0, z: 0 }) === null);
let g = G.vtGroundTarget({ x: 0, y: -800, z: 600 }, { x: 0, y: 0, z: -1500 });
check('a remembered view, target 1500 m under the ground → only the target moves, along the line of sight onto the ground; the camera stays', g && g.dp.x === 0 && g.dp.y === 0 && g.dp.z === 0 && g.c.z === 0 && near(g.c.x, 0) && near(g.c.y, -800 + 800 * 600 / 2100), g);
g = G.vtGroundTarget({ x: 10, y: -800, z: 600 }, { x: 10, y: -400, z: 300 });
check('target in the air → the same line prolonged to the ground', g && g.dp.z === 0 && near(g.c.y, 0) && near(g.c.x, 10) && g.c.z === 0, g);
{
    // the picture does not change: the old and the new target lie on one line from the camera
    const p = { x: 3, y: -500, z: 250 }, c = { x: 40, y: 900, z: 320 };         // looking UP at a target above the camera: not along the line
    g = G.vtGroundTarget(p, c);
    check('line of sight does not go down (target above the camera) → target and camera lowered together by the target\'s height', g && g.dp.z === -320 && near(g.c.x, 40) && near(g.c.y, 900) && g.c.z === 0, g);
    const p2 = { x: 0, y: -1000, z: 20 }, c2 = { x: 0, y: 0, z: 5 };              // 0.86 deg under the horizon: the ground hit would be far away
    g = G.vtGroundTarget(p2, c2);
    check('view flatter than ~3° → lowered together too (no jump to a far-away ground point)', g && g.dp.z === -5 && g.dp.y === 0 && near(g.c.y, 0), g);
    g = G.vtGroundTarget({ x: 0, y: -100, z: -30 }, { x: 0, y: 0, z: -80 });
    check('camera under the ground → lowered together (never sent along a line that leaves the ground)', g && g.dp.z === 80 && g.c.z === 0, g);
    g = G.vtGroundTarget({ x: 0, y: -1200 - 100, z: 700 - 60 }, { x: 0, y: -100, z: -60 }, true);
    check('after a PAN (target sank 60 m with the camera): both go back up along the line of sight by the same step — target on the ground, the camera at its height again (700 m), offset unchanged',
        g && g.c.z === 0 && near(640 + g.dp.z, 700) && near(g.dp.y, g.c.y - (-100)) && near((-1300 + g.dp.y) - g.c.y, -1200), g);
    check('bad numbers → nothing', G.vtGroundTarget({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: NaN }) === null && G.vtGroundTarget(null, { z: 1 }) === null);
}

// ---- the wrapper, with a pan as ros3d does it in a tilted view
function mkCtrl() {
    const cam = { up: { set(x, y, z) { this.v = [x, y, z]; } }, position: { x: 0, y: -1200, z: 700 }, look: null, lookAt(c) { this.look = { x: c.x, y: c.y, z: c.z }; } };
    const ctrl = { camera: cam, center: { x: 0, y: 0, z: 0 }, updates: 0, update() { this.updates++; this.camera.lookAt(this.center); }, axes: { position: { copy(c) { this.v = { x: c.x, y: c.y, z: c.z }; } } } };
    return ctrl;
}
// the view plane's "up" for this camera (tilted ~60° from the vertical, looking north)
function viewUp(ctrl) {
    const p = ctrl.camera.position, c = ctrl.center, d = [c.x - p.x, c.y - p.y, c.z - p.z], L = Math.hypot(...d), f = d.map((v) => v / L);
    const up = [-f[0] * f[2], -f[1] * f[2], 1 - f[2] * f[2]], U = Math.hypot(...up);
    return up.map((v) => v / U);
}
function pan(ctrl, metres) { const u = viewUp(ctrl); ['x', 'y', 'z'].forEach((k, i) => { ctrl.center[k] += u[i] * metres; ctrl.camera.position[k] += u[i] * metres; }); ctrl.update(); }
{
    // before M20: a few drags in a tilted view and the target is hundreds of metres off the ground
    const old = mkCtrl();
    for (let i = 0; i < 6; i++) { pan(old, -350); }
    const hit = (() => { const p = old.camera.position, c = old.center, k = p.z / (p.z - c.z); return { x: p.x + k * (c.x - p.x), y: p.y + k * (c.y - p.y) }; })();
    const off = Math.hypot(hit.x - old.center.x, hit.y - old.center.y);
    check('before M20 (replayed): six drags in a view tilted 60° → the target is ' + Math.round(-old.center.z) + ' m under the ground, and the ground on screen lies ' + (off / 1000).toFixed(2) +
        ' km from the target\'s x / y (where the tiles were fetched and the pill measured from)', old.center.z < -1000 && off > 1500, [old.center, hit]);
    // now
    const K = mkCtrl(); G.keep(K); K.update();
    const off0 = { y: K.camera.position.y - K.center.y, z: K.camera.position.z - K.center.z };
    const seen = [];
    for (let i = 0; i < 6; i++) {
        const c0 = { x: K.center.x, y: K.center.y };
        pan(K, -350);
        seen.push({ z: K.center.z, camZ: K.camera.position.z, offY: K.camera.position.y - K.center.y, stepY: K.center.y - c0.y, stepX: K.center.x - c0.x });
    }
    check('now: after every drag in the tilted view the target is on the ground (z = 0)', seen.every((s) => s.z === 0), seen.map((s) => s.z));
    check('now: the drag is a pan over the ground — the camera keeps its height (700 m), its tilt and its distance (it sank under the ground before)', seen.every((s) => near(s.camZ, 700, 1e-6) && near(s.offY, off0.y, 1e-6)), seen.map((s) => [s.camZ, s.offY]));
    check('now: every drag moves the view the same way over the ground (south, ' + Math.round(-seen[0].stepY) + ' m each, nothing sideways)', seen.every((s) => near(s.stepY, seen[0].stepY, 1e-6) && near(s.stepX, 0, 1e-6)) && seen[0].stepY < -350, seen.map((s) => s.stepY));
    check('now: the camera looks at the target, the axes follow it', near(K.camera.look.z, 0) && near(K.camera.look.y, K.center.y) && near(K.axes.position.v.y, K.center.y));
    const n = K.updates; G.keep(K); K.update();
    check('the guard is put on once', K.updates === n + 1);
    // a zoom or a turn on a grounded target: untouched
    K.camera.position.z += 100; const pz = K.camera.position.z, cy0 = K.center.y; K.update();
    check('zoom / tilt with the target on the ground is not touched', K.camera.position.z === pz && K.center.y === cy0 && K.center.z === 0);
}
{
    // a stored view with its target off the ground (the owner's browser): healed by the first update
    const K = mkCtrl(); K.camera.position = { x: 0, y: -800, z: 600 }; K.center = { x: 0, y: 0, z: -1500 }; G.keep(K); K.update();
    check('a stored view with the target 1500 m under the ground is healed at the first update: target on the ground on the same line of sight, camera in place',
        K.center.z === 0 && near(K.center.y, -800 + 800 * 600 / 2100) && K.camera.position.y === -800 && K.camera.position.z === 600, K.center);
    // straight-down view, target on the ground: untouched
    const T = mkCtrl(); T.camera.position = { x: 5, y: 5, z: 1000 }; T.center = { x: 5, y: 5, z: 0 }; G.keep(T); T.update();
    check('the usual top-down view is not touched', T.center.x === 5 && T.center.z === 0 && T.camera.position.z === 1000);
}

// ---- the tilt limit
{
    const deg = (p, c) => Math.atan2(Math.hypot(p.x - c.x, p.y - c.y), p.z - c.z) * 180 / Math.PI;
    check('tilt: within ' + G.MAXT + '° from the vertical nothing is changed (top-down, 30°, exactly the limit)', G.vtTiltLimit({ x: 0, y: -0.001, z: 1000 }, { x: 0, y: 0, z: 0 }) === null &&
        G.vtTiltLimit({ x: 0, y: -500, z: 866 }, { x: 0, y: 0, z: 0 }) === null && G.vtTiltLimit({ x: 0, y: -Math.sin(Math.PI / 3) * 100, z: 50 }, { x: 0, y: 0, z: 0 }) === null);
    // measured live 2026-11-21: one drag put the camera here
    const c = { x: -0.81, y: -1.2, z: 0 }, p = { x: -47.1, y: -186.84, z: -360.83 };
    const t = G.vtTiltLimit(p, c);
    const r0 = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z), r1 = t && Math.hypot(t.p.x - c.x, t.p.y - c.y, t.p.z - c.z);
    check('tilt: the camera 360 m UNDER the ground (measured live after one drag) → back above it at ' + G.MAXT + '°, same side, same distance', t && t.p.z > 0 && near(deg(t.p, c), G.MAXT, 1e-6) && near(r1, r0, 1e-6) &&
        near(Math.atan2(t.p.y - c.y, t.p.x - c.x), Math.atan2(p.y - c.y, p.x - c.x), 1e-9), t);
    const t2 = G.vtTiltLimit({ x: 0, y: -1000, z: 20 }, { x: 0, y: 0, z: 0 });
    check('tilt: a view along the horizon → ' + G.MAXT + '°; screen-up points away from the camera and up', t2 && near(deg(t2.p, { x: 0, y: 0, z: 0 }), G.MAXT, 1e-6) && t2.up.y > 0 && t2.up.z > 0 && near(Math.hypot(t2.up.x, t2.up.y, t2.up.z), 1), t2);
    const K = mkCtrl(); K.camera.position = { x: 0, y: -300, z: -200 }; G.keep(K); K.update();
    check('tilt: the controls\' update puts it right (camera above the ground, looking at the target, target on the ground)', K.camera.position.z > 0 && near(deg(K.camera.position, K.center), G.MAXT, 1e-6) && K.center.z === 0 && K.camera.up.v && K.camera.look.z === 0);
    // a remembered view: camera under the ground AND the target off it (the owner's browser, as saved by the live run)
    const S = mkCtrl(); S.camera.position = { x: -40.7, y: 1955.7, z: -320.8 }; S.center = { x: 0, y: 2119, z: -4.3 }; G.keep(S); S.update();
    check('remembered view with the camera under the ground and the target off it: healed in one update (camera above, tilt ≤ ' + G.MAXT + '°, target z = 0)', S.camera.position.z > 0 && deg(S.camera.position, S.center) <= G.MAXT + 1e-6 && S.center.z === 0, [S.camera.position, S.center]);
}

// ---- the tiles cover the ground the view shows (mapping.js _aerialViewParams)
{
    const mp = fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8');
    const i = mp.indexOf('    _aerialViewParams() {');
    let d = 0, j = mp.indexOf('{', i); const b0 = j; for (; j < mp.length; j++) { if (mp[j] === '{') d++; else if (mp[j] === '}') { d--; if (!d) break; } }
    const body = mp.slice(b0, j + 1);
    const mkV = (pos, up) => ({ viewer3d: { camera: { position: Object.assign({ distanceTo(c) { return Math.hypot(this.x - c.x, this.y - c.y, this.z - c.z); } }, pos), fov: 1.4, aspect: 1.5, up },
        cameraControls: { center: { x: 0, y: 0, z: 0 } }, renderer: { domElement: { clientHeight: 800 } } } });
    const f = new Function('document', 'vtMapPixelRatio', 'return function () ' + body)({ getElementById: () => null }, () => 1);
    const top = f.call(mkV({ x: 0, y: -0.001, z: 1000 }, { x: 0, y: 1, z: 0 }));
    check('tiles: top-down, north up → the frame itself (as before)', near(top.covW, top.halfW, 1e-6) && near(top.covH, top.halfH, 1e-6) && near(top.halfW, top.halfH * 1.5, 1e-9));
    const turned = f.call(mkV({ x: 0, y: -0.001, z: 1000 }, { x: 1, y: 0, z: 0 }));
    check('tiles: the map turned by 90° → the cover is turned too (it was the upright frame: the sides of a wide screen had no photo)', near(turned.covW, turned.halfH, 1e-6) && near(turned.covH, turned.halfW, 1e-6));
    const tilt = f.call(mkV({ x: 0, y: -866.0254, z: 500 }, { x: 0, y: 0.5, z: 0.866 }));
    check('tiles: tilted 60° looking north → the cover reaches twice as far along the line of sight (1 / cos 60°)', near(tilt.covH, 2 * tilt.halfH, 1e-3) && near(tilt.covW, tilt.halfW, 1e-6), tilt);
    check('tiles: the zoom level and the pins still use the frame (halfH unchanged by turn or tilt)', near(tilt.halfH, top.halfH, 1e-6) && near(turned.halfH, top.halfH, 1e-9));
    check('tiles: the cover is what the tile range is built from', /const hw = \(vp\.covW \|\| vp\.halfW\) \* M, hh = \(vp\.covH \|\| vp\.halfH\) \* M;/.test(mp));
}

console.log(fails ? '\n' + fails + ' of ' + count + ' FAILED' : '\nall ' + count + ' checks passed');
process.exit(fails ? 1 : 0);
