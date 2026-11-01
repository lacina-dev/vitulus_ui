#!/usr/bin/env node
/*
 * The numbers of the map layers Lidar / Camera range (vt_sensor_ranges.js core):
 *
 *     node tools/test_sensor_ranges.node.js
 *
 * What the robot really uses must win over what is set, and a limit lower than
 * what is set must name who cut it. No browser, no ROS.
 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js', 'vt_sensor_ranges.js'));

const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(64) + (cond ? 'ok' : 'FAIL'));
}
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-6);

const limits = {
    lidar: {
        device: { max_distance_m: 16 }, filter: { range_lower: 0.1, range_upper: 16, intensity_lower: 4 },
        costmap: { obstacle_range: 3, raytrace_range: 5 }, local_grid: { width: 5, height: 5 }, chain: { masks: [] },
    },
    camera: { clip_distance: 5, costmap: { obstacle_range: 3.5, min_height: 0.05, max_height: 0.5 } },
};
const profile = { values: { mapper: { use_lidar: true, lidar_max_range_m: 8, lidar_min_intensity: 0, use_cam_obstacle: true, use_cam_free: true },
    camera: { max_depth: 4, range_max: 2.8, min_depth: 0, range_min: 0, max_ground_height: 0.15, min_obstacle_height: 0.25, max_obstacle_height: 0.8 } } };
const depth = (navMax, wideMax, rMax) => ({ profiles: [
    { name: 'nav', values: { max_depth: navMax, range_max: rMax === undefined ? 5 : rMax, min_depth: 0, range_min: 0 } },
    { name: 'wide', values: { max_depth: wideMax, range_max: rMax === undefined ? 2.8 : rMax, min_depth: 0.2, range_min: 0.1,
        max_ground_height: 0.15, min_obstacle_height: -1, max_obstacle_height: 2 } }] });
const info = { K: [616.78, 0, 326.22, 0, 616.68, 235.08, 0, 0, 1], width: 640, height: 480 };
const scan = { range_min: 0.1, range_max: 16, angle_min: -Math.PI, angle_max: Math.PI };
function run(over) {
    return C.computeRanges(Object.assign({ limits, profile, depth: depth(2.8, 4), camUsed: info, camSensor: null, scan,
        camHeight: 0.293, camPitchDown: -0.024 }, over));
}

console.log('limits');
ok('smallest wins', C.limitOf([{ v: 8, by: 'a' }, { v: 5, by: 'b' }]).by === 'b');
ok('of equals the first (nearest the sensor) wins', C.limitOf([{ v: 5, by: 'driver' }, { v: 5, by: 'x' }]).by === 'driver');
ok('missing and 0 (= off) limits do not count', C.limitOf([null, { v: 0, by: 'off' }, { v: null, by: 'n' }, { v: 3, by: 'c' }]).by === 'c');
ok('nothing known = null, not 0', C.limitOf([{ v: null }]) === null);

console.log('lidar');
let r = run();
ok('sees 16 m', r.lidar.sensor.v === 16);
ok('min = the filter / scan bound', near(r.lidar.min.v, 0.1));
ok('mapping 8 m as set, not cut', r.lidar.map.v === 8 && !r.lidar.map.cut);
ok('navigation = costmap obstacle_range', r.lidar.nav.v === 3 && r.lidar.nav.by === 'costmap');
ok('local grid half width', r.lidar.local.v === 2.5);
ok('a full scan is a full circle', r.lidar.full && near(r.lidar.span, 2 * Math.PI));
r = run({ profile: null, live: { lidar_max_range_m: 20, lidar_min_intensity: 1, use_lidar: true } });
ok('a set range above the sensor is cut, the sensor is named', r.lidar.map.v === 16 && r.lidar.map.cut && r.lidar.map.by === 'device');
ok('recording values win over the file ones', r.recording);
ok('min intensity below the chain filter: the filter is named', r.lidar.intMin.v === 4 && r.lidar.intMin.cut && r.lidar.intMin.by === 'filter');
r = run({ scan: Object.assign({}, scan, { angle_min: -1, angle_max: 1 }) });
ok('a narrower scan is reported', !r.lidar.full && near(r.lidar.span, 2));

console.log('camera');
r = run();
ok('nav max = max_depth', near(r.camera.navMax.v, 2.8) && !r.camera.navMax.cut);
ok('fov from camera_info 54.8°', near(r.camera.fov.h * 180 / Math.PI, 54.84, 0.1));
ok('mapping reach = the chain, as set, not "cut"', near(r.camera.mapObs.v, 2.8) && !r.camera.mapObs.cut && r.camera.mapObs.by === 'cam_range');
ok('mapping height from the chain, floor = the ground limit', near(r.camera.mapH.min, 0.15) && near(r.camera.mapH.max, 2));
ok('nav height unknown when the profile lacks it', r.camera.navH.max === null);
r = run({ depth: depth(2.8, 4, 4.5) });
ok('range set above the depth window: the window is named', near(r.camera.mapObs.v, 4) && r.camera.mapObs.cut && r.camera.mapObs.by === 'cam_depth');
r = run({ depth: null });
ok('no chain yet: the profile says what it will run on', near(r.camera.mapObs.v, 2.8) && near(r.camera.mapH.min, 0.25) && near(r.camera.mapH.max, 0.8));
r = run({ profile: null, depth: null });
ok('neither: nothing invented', r.camera.mapObs === null && r.lidar.map && r.lidar.mapOn);
r = run({ profile: { values: { mapper: { use_cam_obstacle: false, use_lidar: false }, camera: {} } } });
ok('sources of the profile switch the views', !r.camera.mapObsOn && r.camera.mapFreeOn && !r.lidar.mapOn);
ok('a label names the cause only when it is not the setting', C.limitLabel({ v: 3, by: 'costmap', cut: true }, 'cam_depth').by === 'costmap' && C.limitLabel({ v: 3, by: 'cam_depth', cut: false }, 'cam_depth').by === null);
r = run();
ok('mapping min = larger of min_depth, range_min', near(r.camera.mapMin.v, 0.2) && r.camera.mapMin.by === 'cam_depth');
r = run({ depth: depth(4, 4) });
ok('nav 4 m set, costmap takes 3.5 m and is named', near(r.camera.navMax.v, 3.5) && r.camera.navMax.cut && r.camera.navMax.by === 'costmap');
r = run({ depth: depth(6, 6, 0), limits: Object.assign({}, limits, { camera: { clip_distance: 5, costmap: {} } }) });
ok('8 m style case: driver cut is named ("5 m: driver")', r.camera.navMax.v === 5 && r.camera.navMax.by === 'driver' && r.camera.navMax.cut);
ok('range_max 0 = off, it does not limit', r.camera.navMax.v === 5);
r = run({ depth: null });
ok('without /depth_obstacles/config no invented numbers', r.camera.navMax === null);
r = run({ camUsed: null });
ok('without camera_info no fov', r.camera.fov === null);
ok('ground from the height + the lowest ray', near(C.groundFrom(0.293, -0.024, 0.378), 0.293 / Math.tan(0.354)));
ok('a ray that never reaches the ground = null', C.groundFrom(0.3, -1, 0.378) === null);

console.log('blocked sectors');
const n = 860, inc = 2 * Math.PI / n;
function scanWith(nearFrom, nearTo) {
    const R = [];
    for (let i = 0; i < n; i++) { const a = -Math.PI + i * inc; R.push(a >= nearFrom && a < nearTo ? 0.2 : (i % 2 ? 4 : null)); }
    return { ranges: R, angle_min: -Math.PI, angle_increment: inc, range_min: 0.1 };
}
const hist = [];
for (let i = 0; i < 10; i++) { hist.push(C.sectorScan(scanWith(0, 0.35))); }
ok('a sector always closer than 0.4 m is blocked', C.blockedSectors(hist).join() === '18,19');
ok('too few scans = no verdict', C.blockedSectors(hist.slice(0, 4)).length === 0);
ok('an open scan blocks nothing', C.blockedSectors(Array(10).fill(C.sectorScan(scanWith(9, 9)))).length === 0);

if (failures.length) { console.log('\nFAIL: ' + failures.join('; ')); process.exit(1); }
console.log('\nOK');
