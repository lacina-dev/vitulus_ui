#!/usr/bin/env node
/*
 * The robot's map over a background map (T17 M2):
 *
 *     node tools/test_map_legibility.node.js
 *
 * Runs the real code out of map_view.js / mapping.js in a sandbox:
 *   - M2-1 / M2-5: "Dim the robot's map over the background" — MapLayerOpacity
 *     (stored choice, default on; dimmed only while a background map is
 *     painted; one texture rebuild per change of the effective state) and the
 *     colours getColor() bakes: faint free space, transparent unknown, full
 *     fill in a ring around obstacles (getValue + vtObstacleHalo), nothing
 *     changes without a background map; the same choice in Settings › App ›
 *     Display;
 *   - M2-2: tone overlays sit above the robot's maps (SITE, PREVIEW) and under
 *     the terrain / line overlays / everything drawn;
 *   - M2-A (check): with a tone overlay on, the obstacles and their ring are
 *     drawn once more above it, and the multiply never goes below
 *     VT_MULT_FLOOR (ČÚZK relief 0.12 at opacity 1 turned everything black);
 *   - M2-B (check): without a background map the tones are blended by alpha;
 *   - M2-2 / M2-3 / M2-6: vtTileShader really patches ROS3D's MeshBasicMaterial
 *     fragment shader (multiply, recolor, halo blocks), and a plain material is
 *     left alone; the dim checkbox is in index.html, ticked.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TPL = path.join(__dirname, '..', 'nodes', 'templates');
const JS = path.join(TPL, 'assets', 'js');
const mapView = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
const mapping = fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8');
const ros3d = fs.readFileSync(path.join(JS, 'ros3d.js'), 'utf8');
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
const en = fs.readFileSync(path.join(JS, 'i18n', 'en.js'), 'utf8');

const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(66) + (cond ? 'ok' : 'FAIL'));
}
function slice(src, from, to) {
    const a = src.indexOf(from), b = src.indexOf(to, a + 1);
    if (a < 0 || b < 0) { throw new Error('marker not found: ' + (a < 0 ? from : to)); }
    return src.slice(a, b);
}

console.log('map legibility (node harness)');

// ---- map_view.js: layer order, opacity manager, palette, getValue/getColor
const store = {};
const timers = [];
const domReady = [];
const checkbox = { checked: true };
const ctx = vm.createContext({
    document: { addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') { domReady.push(fn); } },
                getElementById: (id) => (id === 'mapv3_bg_dim' ? checkbox : null) },
    window: {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
                    removeItem: (k) => { delete store[k]; } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    ROS3D: (function () {
        function Mesh(geometry, material) { this.geometry = geometry; this.material = material; this.children = [];
                                            this.userData = {}; this.visible = true; this.renderOrder = 0; }
        Mesh.prototype.add = function (c) { this.children.push(c); c.parent = this; };
        function OccupancyGrid() {}
        OccupancyGrid.prototype = Object.create(Mesh.prototype);
        OccupancyGrid.prototype.constructor = OccupancyGrid;
        return { OccupancyGrid: OccupancyGrid, Mesh: Mesh };
    })(),
    Math: Math, Uint8Array: Uint8Array, Uint16Array: Uint16Array, console: console,
});
const code = slice(mapView, 'var MapLayerOrder = {', '// U1 kolo 2:') +
    '\nthis.MapLayerOrder = MapLayerOrder; this.MapLayerOpacity = MapLayerOpacity; this.MapPalette = MapPalette;' +
    ' this.VT_FREE_HALO = VT_FREE_HALO; this.vtObstacleHalo = vtObstacleHalo;';
vm.runInContext(code, ctx, { filename: 'map_view.js (slice)' });
const O = ctx.MapLayerOrder, MLO = ctx.MapLayerOpacity, P = ctx.MapPalette;
const proto = ctx.ROS3D.OccupancyGrid.prototype;
const runTimers = () => { while (timers.length) { timers.shift()(); } };

console.log('\nlayer order (M2-2)');
ok('tone overlays above the saved map and the preview', O.OVERLAY_UNDER > O.SITE && O.OVERLAY_UNDER > O.PREVIEW);
ok('… under terrain, line overlays, edits and program paths',
   O.OVERLAY_UNDER < O.TERRAIN && O.OVERLAY_UNDER < O.OVERLAY && O.OVERLAY_UNDER < O.EDITS && O.OVERLAY_UNDER < O.PROGRAM);

console.log('\ndim over a background (M2-1, owner decision: default on)');
ok('default: dim wanted, nothing dimmed before a background shows', MLO.dim_pref === true && MLO.dim_active === false);
let rebuilt = 0;
const client = { _lastMsg: { m: 1 }, processMessage: () => { rebuilt++; } };
MLO._clients.push(client);
MLO.setBackground(true); runTimers();
ok('background painted -> dimmed, grids rebuilt once', MLO.dim_active === true && rebuilt === 1);
MLO.setBackground(true); runTimers();
ok('same state again -> no rebuild', rebuilt === 1);
MLO.setDimPref(false); runTimers();
ok('unticked -> full fill, stored as "0"', MLO.dim_active === false && store.vitulus_map_dim_on_bg === '0' && rebuilt === 2);
MLO.setDimPref(true); MLO.setBackground(false); runTimers();
ok('no background -> full fill', MLO.dim_active === false);
store.vitulus_map_dim_on_bg = '0'; MLO.load();
ok('stored "0" is read back', MLO.dim_pref === false);
delete store.vitulus_map_dim_on_bg; MLO.load();
ok('nothing stored -> dim', MLO.dim_pref === true);

console.log('\nSettings › App › Display');
const added = [];
ctx.window.VTAppSettings = { add: (sec, it) => added.push([sec, it]) };
domReady.forEach((fn) => fn());
const item = added.find(([sec, it]) => sec === 'display' && it.id === 'map_dim');
ok('the choice is also in Settings › App › Display', !!item);
if (item) {
    const it = item[1];
    ok('… reads the stored choice', it.get() === (MLO.dim_pref ? '1' : '0'));
    it.set('0');
    ok('… "Full" turns dimming off and unticks the Map checkbox', MLO.dim_pref === false && checkbox.checked === false &&
       store.vitulus_map_dim_on_bg === '0');
    it.set('1');
    ok('… "Dimmed" turns it back on', MLO.dim_pref === true && checkbox.checked === true);
    ok('… labels are i18n keys', ['app.display.mapdim', 'app.display.mapdim.hint'].every((k) => en.indexOf('"' + k + '"') > 0) &&
       it.options.every((o) => en.indexOf('"' + o[1] + '"') > 0));
}
runTimers();

console.log('\ncolours baked into the grid texture');
const W = 9, H = 9;
const data = new Array(W * H).fill(0);
data[4 * W + 4] = 100;                                  // one obstacle in the middle
data[0] = -1;                                           // one unknown corner
const grid = (r, g, b) => ({ color: { r: r, g: g, b: b }, texture: { image: { width: W, height: H } },
                             scale: { x: 0.1 } });
const SITE = grid(0, 100, 255), BASE = grid(0, 255, 255), DIRECT = grid(0, 180, 180);
const col = (gr, i) => proto.getColor.call(gr, i, 0, 0, proto.getValue.call(gr, i, 0, 0, data));
MLO.setDimPref(true); MLO.setBackground(false); runTimers();
ok('no background: saved free = full fill', col(SITE, 0 * W + 8)[3] === P.SITE.free[3]);
ok('no background: base unknown keeps its grey', col(BASE, 0)[3] === MLO.unknownAlpha(P.BASE.unknownNative));
MLO.setBackground(true); runTimers();
ok('dimmed: saved free far from obstacles is faint', col(SITE, 0 * W + 8)[3] === P.SITE.freeDim[3] && P.SITE.freeDim[3] <= 64);
ok('dimmed: base free faint', col(BASE, 8 * W + 8)[3] === P.BASE.freeDim[3] && P.BASE.freeDim[3] <= 64);
ok('dimmed: base unknown transparent (M2-5)', col(BASE, 0)[3] === 0);
ok('dimmed: obstacles unchanged', col(SITE, 4 * W + 4).join() === P.SITE.obstacle.join() &&
   col(BASE, 4 * W + 4).join() === P.BASE.obstacle.join());
ok('dimmed: free next to an obstacle keeps the full fill (ring)', col(SITE, 4 * W + 5)[3] === P.SITE.free[3] &&
   col(SITE, 1 * W + 1)[3] === P.SITE.free[3] && col(BASE, 7 * W + 7)[3] === P.BASE.free[3]);
ok('… the ring is 0.3 m (3 cells at 0.1 m), not more', col(SITE, 0 * W + 0 + 8)[3] === P.SITE.freeDim[3] &&
   proto.getValue.call(SITE, 0, 0, 0, data) === -1);
ok('other grids (Direct) are not touched', proto.getValue.call(DIRECT, 4 * W + 5, 0, 0, data) === 0);
const data2 = data.slice(); data2[4 * W + 3] = -1;    // unknown right next to the obstacle (outside a fence)
const SITE2 = grid(0, 100, 255);
ok('unknown next to an obstacle gets the ring too', proto.getValue.call(SITE2, 4 * W + 3, 0, 0, data2) === ctx.VT_FREE_HALO);
const halo = ctx.vtObstacleHalo([0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4, 4, 1, 100);
ok('vtObstacleHalo: square ring of radius 1', Array.from(halo).join('') === '0111' + '0111' + '0111' + '0000');

// ---- mapping.js: the tile shader on ROS3D's real MeshBasicMaterial shader
console.log('\ntile shader (M2-2, M2-3, M2-6)');
const fragSrc = slice(ros3d, 'var meshbasic_frag = "', '";\n');
const frag = JSON.parse(fragSrc.slice('var meshbasic_frag = '.length) + '"');
const sctx = vm.createContext({});
vm.runInContext(slice(mapping, 'function vtTileLodBias(shader) {', '/* T17 M3: the tile cache') +
    '\nthis.vtTileShader = vtTileShader;', sctx, { filename: 'mapping.js (slice)' });
const run = (defines, vt) => {
    const sh = { fragmentShader: frag.replace('#include <map_fragment>', '#include <map_fragment>'), uniforms: {} };
    sctx.vtTileShader.call({ defines: defines, userData: { vt: vt } }, sh);
    return sh;
};
const plain = run(undefined, undefined);
ok('plain tile: only the LOD bias, no extra uniforms', /texture2D\( map, vUv, -1\.0 \)/.test(plain.fragmentShader) &&
   plain.fragmentShader.indexOf('vtNeutral') < 0 && !plain.uniforms.vtNeutral);
const mul = run({ VT_MULTIPLY: 1 }, { neutral: [0.72, 0.72, 0.72] });
ok('multiply: premultiplied output divided by the neutral tone',
   /#ifdef VT_MULTIPLY\n\tgl_FragColor = vec4\(clamp\(1\.0 - vtGain \* \(1\.0 - outgoingLight \/ vtNeutral\)/.test(mul.fragmentShader) &&
   mul.uniforms.vtNeutral.value.join() === '0.72,0.72,0.72');
const rec = run({ VT_RECOLOR: 1, VT_HALO: 1 }, { tint: [0.66, 0.78, 1] });
ok('recolor + halo blocks inserted before the texel is applied',
   rec.fragmentShader.indexOf('#ifdef VT_RECOLOR') > 0 && rec.fragmentShader.indexOf('#ifdef VT_HALO') > 0 &&
   rec.fragmentShader.indexOf('#ifdef VT_HALO') < rec.fragmentShader.indexOf('diffuseColor *= texelColor'));
ok('uniform declarations precede main()', rec.fragmentShader.indexOf('uniform vec3 vtTint;') <
   rec.fragmentShader.indexOf('void main()'));
ok('tiles use vtTileShader and the overlay look', /mat\.onBeforeCompile = vtTileShader;/.test(mapping) &&
   /this\._tileStyle\(mat, src\);/.test(mapping));
ok('multiply blending = dst*src + dst*(1-srcA)', /blendSrc = VT_BLEND\.dstColor/.test(mapping) &&
   /blendDst = VT_BLEND\.oneMinusSrcAlpha/.test(mapping) &&
   /var CustomBlending = 5;[\s\S]*var OneMinusSrcAlphaFactor = 205;[\s\S]*var DstColorFactor = 208;/.test(ros3d));

console.log('\nobstacles above the tone overlays (M2-A)');
const fakeGrid = () => { const g = new ctx.ROS3D.Mesh({}, { clone() { return Object.assign({}, this, { clone: undefined }); }, opacity: 1 });
                         return g; };
const siteC = { _layerRenderOrder: O.SITE, currentGrid: fakeGrid() }, costC = { _layerRenderOrder: O.COSTMAP, currentGrid: fakeGrid() };
MLO.setBackground(true); MLO.setDimPref(true); runTimers();
MLO._applyOpacityToClient(siteC); MLO._applyOpacityToClient(costC);
const top = siteC.currentGrid._vtTop;
ok('saved map gets an obstacle plane over the same texture, costmap none', !!top && top.parent === siteC.currentGrid &&
   !costC.currentGrid._vtTop);
ok('… hidden while no tone overlay is on', top.visible === false);
MLO._clients.push(siteC); MLO.setToneOn(true);
ok('… shown with a tone overlay, above it and under the terrain', top.visible === true &&
   top.renderOrder > O.OVERLAY_UNDER && top.renderOrder < O.TERRAIN);
const aDim = top.material.alphaTest;
ok('… dimmed: keeps obstacles, probable obstacles and the ring, not the faint tint',
   P.SITE.obstacle[3] / 255 >= aDim && P.SITE.obstacleProb[3] / 255 >= aDim && P.SITE.free[3] / 255 >= aDim &&
   P.SITE.freeDim[3] / 255 < aDim && P.BASE.freeDim[3] / 255 < aDim);
MLO.setDimPref(false); runTimers(); MLO._applyOpacityToClient(siteC);
ok('… full fill: obstacles only (free has the ring\'s alpha there)', P.SITE.obstacle[3] / 255 >= top.material.alphaTest &&
   P.SITE.free[3] / 255 < top.material.alphaTest);
MLO.setDimPref(true); MLO.setToneOn(false); runTimers();
ok('… tone off -> hidden again', top.visible === false);
// the checker's case: ČÚZK relief 0.12 on a slope, opacity 1, over a dark lawn
const MSrc = require(path.join(JS, 'vt_map_sources.js'));
const hs = MSrc.normalize({ sources: [{ id: 'sat', kind: 'base', layer: 'a', grid: 'g' },
                                      { id: 'hillshade', kind: 'overlay', layer: 'b', grid: 'g', layer_order: 'under' }] }).byId.hillshade;
const floor = parseFloat((mapping.match(/var VT_MULT_FLOOR = ([0-9.]+);/) || [])[1]);
const factor = (c) => Math.max(floor, Math.min(1, 1 - hs.blend_gain * (1 - c / hs.blend_neutral[0])));
const over = (dst, rgba) => dst.map((d, i) => d * (1 - rgba[3] / 255) + rgba[i] * rgba[3] / 255);
const lum = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
                    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const wcag = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const lawn = [90, 120, 60], f = factor(0.12);
const shade = (c) => c.map((v) => v * f);
const ground = shade(over(lawn, P.SITE.freeDim));
const ring = over(shade(over(lawn, P.SITE.free)), P.SITE.free);         // multiplied, then the obstacle plane again
const obst = over(shade(P.SITE.obstacle.slice(0, 3)), P.SITE.obstacle);
ok('deep shadow 0.12, opacity 1: the ground keeps >= 35 % (floor)', floor >= 0.35 && f === floor && ground[1] >= 0.35 * lawn[1] * 0.8);
const lab = (c) => { const l = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    const xyz = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]].map((r, k) =>
        (r[0] * l[0] + r[1] * l[1] + r[2] * l[2]) / [0.95047, 1, 1.08883][k]);
    const ff = xyz.map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
    return [116 * ff[1] - 16, 500 * (ff[0] - ff[1]), 200 * (ff[1] - ff[2])]; };
const dE = (a, b) => Math.hypot(...lab(a).map((v, k) => v - lab(b)[k]));
const ringNoTone = over(lawn, P.SITE.free);
console.log('    (model, lawn ' + lawn.join() + ': obstacle/ring WCAG ' + wcag(obst, ring).toFixed(2) + ' (no tone ' +
            wcag(P.SITE.obstacle.slice(0, 3), ringNoTone).toFixed(2) + '), dE ' + dE(obst, ring).toFixed(0) +
            '; ring/shaded ground WCAG ' + wcag(ring, ground).toFixed(2) + ')');
ok('… obstacle stays red, distinct from its ring (dE >= 40, >= 75 % of the no-tone contrast)',
   obst.join() === P.SITE.obstacle.slice(0, 3).join() && dE(obst, ring) >= 40 &&
   wcag(obst, ring) >= 0.75 * wcag(P.SITE.obstacle.slice(0, 3), ringNoTone));
ok('… ring stands out from the shaded ground (>= 3:1)', wcag(ring, ground) >= 3);
ok('shader clamps the multiply at VT_MULT_FLOOR', /#define VT_MULT_FLOOR ' \+ VT_MULT_FLOOR\.toFixed\(2\)/.test(mapping) &&
   /clamp\(1\.0 - vtGain \* \(1\.0 - outgoingLight \/ vtNeutral\), VT_MULT_FLOOR, 1\.0\)/.test(mapping));

console.log('\ntones without a background map (M2-B)');
const cls = vm.runInContext('(class { ' + slice(mapping, '    _tileStyle(mat, src) {', '    // M2-A (check): is a tone overlay') +
    ' })', vm.createContext({ VT_BLEND: { normal: 1, custom: 5, add: 100, dstColor: 208, oneMinusSrcAlpha: 205 }, Object: Object }));
const T = new cls();
let bg = false; T._bgShown = () => bg;
const mk = () => ({ userData: {}, blending: 1 });
const relief = { kind: 'overlay', blend: 'multiply', blend_neutral: [0.72, 0.72, 0.72], blend_gain: 2 };
const m1 = mk(); T._tileStyle(m1, relief);
ok('no background: the tone is blended by alpha (no multiply)', !m1.defines.VT_MULTIPLY && m1.blending === 1 && m1.userData.vtMultiply);
bg = true; const m2 = mk(); T._tileStyle(m2, relief);
ok('background: multiply (dst*src + dst*(1-srcA))', m2.defines.VT_MULTIPLY === 1 && m2.blending === 5 && m2.blendSrc === 208 && m2.blendDst === 205);
T.ov_layers = { hillshade: { group: { children: [{ material: m1 }, { material: m2 }] } } };
T._applyToneBlend();
ok('background appears: planes already on the map switch to multiply', m1.defines.VT_MULTIPLY === 1 && m1.blending === 5 && m1.needsUpdate);
bg = false; T._applyToneBlend();
ok('background gone: back to alpha', !m1.defines.VT_MULTIPLY && !m2.defines.VT_MULTIPLY && m1.blending === 1 && m2.blending === 1);
const line = mk(); T._tileStyle(line, { kind: 'overlay', blend: 'normal', halo: true });
ok('line overlays are not touched', line.defines.VT_HALO === 1 && !line.userData.vtMultiply && line.blending === 1);

console.log('\npanel');
ok('index.html: "Dim the robot\'s map over the background", ticked',
   /<input class="form-check-input" type="checkbox" id="mapv3_bg_dim" checked>/.test(html) &&
   /data-i18n="mapt\.aerial\.dim"/.test(html));

console.log(failures.length ? '\nFAILED: ' + failures.length + '\n  ' + failures.join('\n  ') : '\nOK — all checks passed');
process.exit(failures.length ? 1 : 0);
