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
    ROS3D: { OccupancyGrid: function () {} },
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

console.log('\npanel');
ok('index.html: "Dim the robot\'s map over the background", ticked',
   /<input class="form-check-input" type="checkbox" id="mapv3_bg_dim" checked>/.test(html) &&
   /data-i18n="mapt\.aerial\.dim"/.test(html));

console.log(failures.length ? '\nFAILED: ' + failures.length + '\n  ' + failures.join('\n  ') : '\nOK — all checks passed');
process.exit(failures.length ? 1 : 0);
