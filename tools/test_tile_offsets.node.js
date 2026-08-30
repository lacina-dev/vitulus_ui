#!/usr/bin/env node
/*
 * Harness for the AERIAL TILE OFFSET math + render hook (mapping.js).
 *
 *     node tools/test_tile_offsets.node.js
 *
 * mapping.js is a DOM/ROS-bound class with no exports, so it cannot be
 * imported in node. Same seam as the other harnesses in this directory: the
 * code under test is sliced out of the source VERBATIM and evaluated against
 * stubs.
 *
 *   - the pure helpers (tileOffsetGet/Clamp/Nudge/Put/Format) are top-level
 *     function declarations, sliced by name;
 *   - the render hook (_applyAerialOffset) and its two feeders
 *     (_currentTileOffset, _aerialLayerId) are class methods, sliced and
 *     re-hosted as object-literal methods (identical shorthand syntax) so they
 *     can be called against a stub `this` carrying a fake three.js group.
 *
 * Checks:
 *   - an unknown map / unknown layer / corrupt or out-of-range entry all
 *     resolve to a ZERO offset (the "never break the map view" contract),
 *   - nudges accumulate and clamp at +/-50 m,
 *   - storing a zero offset deletes the entry and prunes the empty map key
 *     (mirrors what webnode's store does),
 *   - the render hook writes ONLY position.x/position.y of the aerial group
 *     and leaves its z (the layer-order anchor) alone,
 *   - switching the tile layer switches which offset is applied,
 *   - a missing group is a no-op, not a throw.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'nodes', 'templates', 'assets',
                           'js', 'mapping.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

// ---- verbatim slicing -----------------------------------------------------
function sliceAt(start, what) {
    let depth = 0;
    const open = SRC.indexOf('{', start);
    if (open < 0) { throw new Error(what + ': no body'); }
    for (let j = open; j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; }
        else if (SRC[j] === '}') { depth--; if (!depth) { return SRC.slice(start, j + 1); } }
    }
    throw new Error(what + ': braces never closed');
}
function sliceFn(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if (start < 0) { throw new Error(name + ' not found in mapping.js'); }
    return sliceAt(start, name);
}
function sliceMethod(name) {
    const marker = '\n    ' + name + '(';
    const start = SRC.indexOf(marker);
    if (start < 0) { throw new Error('method ' + name + ' not found in mapping.js'); }
    return sliceAt(start + 1, name);
}

// TILE_OFFSET_MAX_M is a top-level const in the source; take its value from
// there too so the harness can never drift from the shipped bound.
const MAXM_LINE = /const\s+TILE_OFFSET_MAX_M\s*=\s*([0-9.]+)\s*;/.exec(SRC);
if (!MAXM_LINE) { throw new Error('TILE_OFFSET_MAX_M not found in mapping.js'); }
const MAX_M = parseFloat(MAXM_LINE[1]);

const helpers = new Function(
    'const TILE_OFFSET_MAX_M = ' + MAX_M + ';\n' +
    sliceFn('tileOffsetGet') + '\n' +
    sliceFn('tileOffsetClamp') + '\n' +
    sliceFn('tileOffsetNudge') + '\n' +
    sliceFn('tileOffsetPut') + '\n' +
    sliceFn('tileOffsetFormat') + '\n' +
    'return {tileOffsetGet, tileOffsetClamp, tileOffsetNudge, tileOffsetPut,' +
    ' tileOffsetFormat};')();
const {tileOffsetGet, tileOffsetNudge, tileOffsetPut, tileOffsetFormat} = helpers;

// re-host the three class methods as object-literal methods (same syntax)
const render = new Function(
    'tileOffsetGet',
    'return {' + sliceMethod('_aerialLayerId') + ',\n' +
    sliceMethod('_currentTileOffset') + ',\n' +
    sliceMethod('_applyAerialOffset') + '};')(tileOffsetGet);

// ---- tiny assert ----------------------------------------------------------
const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(64) + (cond ? 'ok' : 'FAIL'));
}
function eq(label, got, want) {
    ok(label + '  [' + JSON.stringify(got) + ']', JSON.stringify(got) === JSON.stringify(want));
}

console.log('aerial tile offset — math + render hook (node harness)');

// ---- 1. lookup / degradation ---------------------------------------------
console.log('\nlookup degrades to zero on anything unusable');
const STORE = {Nmap: {sat: {dx: 0.35, dy: -0.2}, osm: {dx: 1, dy: 1}}};
eq('known (Nmap, sat)', tileOffsetGet(STORE, 'Nmap', 'sat'), {dx: 0.35, dy: -0.2});
eq('unknown map', tileOffsetGet(STORE, 'zahrada2026', 'sat'), {dx: 0, dy: 0});
eq('unknown layer', tileOffsetGet(STORE, 'Nmap', 'cuzk'), {dx: 0, dy: 0});
eq('no store', tileOffsetGet(null, 'Nmap', 'sat'), {dx: 0, dy: 0});
eq('no map name', tileOffsetGet(STORE, '', 'sat'), {dx: 0, dy: 0});
eq('NaN entry', tileOffsetGet({M: {l: {dx: NaN, dy: 1}}}, 'M', 'l'), {dx: 0, dy: 0});
eq('string entry', tileOffsetGet({M: {l: {dx: 'x', dy: 1}}}, 'M', 'l'), {dx: 0, dy: 0});
eq('null entry', tileOffsetGet({M: {l: null}}, 'M', 'l'), {dx: 0, dy: 0});
eq('out-of-range entry', tileOffsetGet({M: {l: {dx: MAX_M + 1, dy: 0}}}, 'M', 'l'),
   {dx: 0, dy: 0});
eq('garbled layers table', tileOffsetGet({M: 7}, 'M', 'l'), {dx: 0, dy: 0});

// ---- 2. nudging -----------------------------------------------------------
console.log('\nnudges accumulate and clamp');
eq('first nudge from nothing', tileOffsetNudge(undefined, 0.1, 0), {dx: 0.1, dy: 0});
eq('accumulates', tileOffsetNudge({dx: 0.1, dy: 0}, 0.1, -0.5), {dx: 0.2, dy: -0.5});
eq('coarse (shift) step', tileOffsetNudge({dx: 0, dy: 0}, 0.5, 0), {dx: 0.5, dy: 0});
eq('float noise rounded to 0.1 mm',
   tileOffsetNudge({dx: 0.1, dy: 0}, 0.2, 0), {dx: 0.3, dy: 0});
eq('clamps at +max', tileOffsetNudge({dx: MAX_M, dy: 0}, 1, 0), {dx: MAX_M, dy: 0});
eq('clamps at -max', tileOffsetNudge({dx: 0, dy: -MAX_M}, 0, -1), {dx: 0, dy: -MAX_M});
eq('bad step reads as 0', tileOffsetNudge({dx: 1, dy: 2}, 'oops', undefined),
   {dx: 1, dy: 2});

// ---- 3. store mutation ----------------------------------------------------
console.log('\nstore mutation mirrors the robot store');
let s = {};
s = tileOffsetPut(s, 'Nmap', 'sat', {dx: 0.4, dy: -0.1});
eq('put creates map + layer', s, {Nmap: {sat: {dx: 0.4, dy: -0.1}}});
s = tileOffsetPut(s, 'Nmap', 'osm', {dx: 1, dy: 1});
eq('second layer is independent', s,
   {Nmap: {sat: {dx: 0.4, dy: -0.1}, osm: {dx: 1, dy: 1}}});
s = tileOffsetPut(s, 'Nmap', 'osm', {dx: 0, dy: 0});
eq('zero deletes just that layer', s, {Nmap: {sat: {dx: 0.4, dy: -0.1}}});
s = tileOffsetPut(s, 'Nmap', 'sat', {dx: 0, dy: 0});
eq('last zero prunes the map key', s, {});
eq('put without a layer is a no-op', tileOffsetPut({a: 1}, 'Nmap', ''), {a: 1});
eq('put clamps', tileOffsetPut({}, 'M', 'l', {dx: 9e9, dy: -9e9}),
   {M: {l: {dx: MAX_M, dy: -MAX_M}}});

// ---- 4. readout -----------------------------------------------------------
console.log('\nreadout');
ok('formats metres to 2dp', tileOffsetFormat({dx: 0.35, dy: -0.2})
   === 'dx 0.35 m / dy -0.20 m');
ok('formats a missing offset as zero', tileOffsetFormat(undefined)
   === 'dx 0.00 m / dy 0.00 m');

// ---- 5. the render hook ---------------------------------------------------
console.log('\nrender hook translates ONLY the aerial group');
const Z_AERIAL = -0.05;
function ctx(store, mapName, layer, withGroup) {
    return {
        tile_offsets: store,
        tile_offset_map: mapName,
        sel_aerial_src: layer === null ? null : {value: layer},
        aerial_group: withGroup === false ? null
            : {position: {x: 0, y: 0, z: Z_AERIAL}, rotation: {z: -0.0013}},
        _aerialLayerId: render._aerialLayerId,
        _currentTileOffset: render._currentTileOffset,
        _applyAerialOffset: render._applyAerialOffset,
    };
}
let c = ctx(STORE, 'Nmap', 'sat');
c._applyAerialOffset();
ok('applies dx to position.x', c.aerial_group.position.x === 0.35);
ok('applies dy to position.y', c.aerial_group.position.y === -0.2);
ok('leaves position.z (layer order) alone', c.aerial_group.position.z === Z_AERIAL);
ok('leaves rotation (datum yaw) alone', c.aerial_group.rotation.z === -0.0013);

c = ctx(STORE, 'Nmap', 'osm');
c._applyAerialOffset();
ok('switching tile layer applies that layer offset',
   c.aerial_group.position.x === 1 && c.aerial_group.position.y === 1);

c = ctx(STORE, 'Nmap', 'cuzk');
c.aerial_group.position.x = 9; c.aerial_group.position.y = 9;
c._applyAerialOffset();
ok('a layer with no stored offset resets to zero',
   c.aerial_group.position.x === 0 && c.aerial_group.position.y === 0);

c = ctx(STORE, 'zahrada2026_3', 'sat');
c.aerial_group.position.x = 9;
c._applyAerialOffset();
ok('an unknown map draws unshifted', c.aerial_group.position.x === 0);

c = ctx(STORE, '', 'sat');
c._applyAerialOffset();
ok('no active map draws unshifted', c.aerial_group.position.x === 0);

c = ctx(STORE, 'Nmap', 'sat', false);
let threw = false;
try { c._applyAerialOffset(); } catch (e) { threw = true; }
ok('missing 3D group is a no-op, not a throw', !threw);

c = ctx(STORE, 'Nmap', null);
c._applyAerialOffset();
ok('missing source <select> falls back to the sat layer',
   c.aerial_group.position.x === 0.35);

// ---- summary --------------------------------------------------------------
console.log('');
if (failures.length) {
    console.log('FAILED (' + failures.length + '):');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('all checks passed');
