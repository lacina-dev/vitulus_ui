#!/usr/bin/env node
/*
 * Harness for the Sensing layer beam classifier (mapping.js).
 *
 *     node tools/test_sensing.node.js
 *
 * sensingClassifyBeams() must label every lidar beam the way the Direct mapper
 * (vitulus_mapping/nodes/direct_raster, cb_scan) ingests it, so the drawn scan
 * polygon is what the map really takes in. Sliced verbatim from mapping.js
 * (same seam as test_tile_offsets.node.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'templates',
                                      'assets', 'js', 'mapping.js'), 'utf8');
function sliceFn(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if (start < 0) { throw new Error(name + ' not found in mapping.js'); }
    let depth = 0;
    for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; }
        else if (SRC[j] === '}') { depth--; if (!depth) { return SRC.slice(start, j + 1); } }
    }
    throw new Error(name + ': braces never closed');
}
const {sensingClassifyBeams, sensingRot2} = new Function(
    sliceFn('sensingClassifyBeams') + '\n' + sliceFn('sensingRot2') +
    '\nreturn {sensingClassifyBeams, sensingRot2};')();

const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(64) + (cond ? 'ok' : 'FAIL'));
}
const scan = (ranges, intens) => ({angle_min: -Math.PI, angle_increment: 0.1,
    range_min: 0.1, range_max: 16, ranges: ranges, intensities: intens || []});

// rosbridge: inf/NaN arrive as null
const s = scan([2.0, 9.0, null, null, 0.05, 16.0, 3.0], [10, 10, 0, 7, 10, 10, 2]);
let B = sensingClassifyBeams(s, 8.0, true, 0, 360);
ok('hit inside the cap is a hit at its range', B.k[0] === 1 && Math.abs(B.r[0] - 2) < 1e-6);
ok('finite return beyond the cap = free ray to the cap', B.k[1] === 2 && B.r[1] === 8);
ok('null + intensity 0 (no-return) = free ray', B.k[2] === 2);
ok('null + intensity > 0 (filter-rejected return) = unknown', B.k[3] === 0);
ok('below range_min = unknown', B.k[4] === 0);
ok('>= range_max = no-return free ray', B.k[5] === 2);
B = sensingClassifyBeams(s, 8.0, false, 0, 360);
ok('lidar_free_no_hit off: no free rays at all', B.k[1] === 0 && B.k[2] === 0 && B.k[5] === 0);
B = sensingClassifyBeams(s, 8.0, true, 5, 360);
ok('weak return under the intensity gate = unknown', B.k[6] === 0 && B.k[0] === 1);
const big = scan(new Array(859).fill(1.0), new Array(859).fill(10));
B = sensingClassifyBeams(big, 8.0, true, 0, 360);
ok('downsampled to <= 360 beams', B.n <= 360 && B.n > 250);
ok('angles follow angle_min + i*increment', Math.abs(B.a[1] - (-Math.PI + 3 * 0.1)) < 1e-5);
B = sensingClassifyBeams(scan([], []), 8, true, 0, 360);
ok('empty scan -> no beams, no throw', B.n === 0);
const R = sensingRot2({x: 0, y: 0, z: Math.sin(-Math.PI / 4), w: Math.cos(-Math.PI / 4)});
ok('yaw -90° mount: sensor +x maps to world -y', Math.abs(R[0]) < 1e-9 && Math.abs(R[2] + 1) < 1e-9);
const F = sensingRot2({x: 1, y: 0, z: 0, w: 0});
ok('upside-down mount mirrors y', F[0] === 1 && F[3] === -1);

if (failures.length) { console.log('FAILED ' + failures.length); process.exit(1); }
console.log('OK');
