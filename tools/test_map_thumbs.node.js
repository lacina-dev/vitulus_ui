#!/usr/bin/env node
// T17 M7: the zone pictures of Programs (vt_map_thumbs.js) — projection onto
// the background map, one zoom per card, the tile budget (20 programs of one
// garden ask for few tiles), the shape alone without a datum, and the card
// click: a click on the picture is the existing Show, never a hide, nothing else.
// Run: node tools/test_map_thumbs.node.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
const T = require(path.join(JS, 'vt_map_thumbs.js'));
let fails = 0;
function ok(name, cond, extra) {
    console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || extra === undefined ? '' : ' ' + JSON.stringify(extra)));
    if (!cond) fails++;
}
// a PUBLIC test point (park Ladronka, Prague), never the robot's garden
const D = { ok: true, origin_lat: 50.0817, origin_lon: 14.35, yaw_rad: 0, utm_zone: 33 };
// the true-north map: yaw_rad = grid convergence (as on the robot, #32)
const lon0 = 33 * 6 - 183;
D.yaw_rad = Math.atan(Math.tan((D.origin_lon - lon0) * Math.PI / 180) * Math.sin(D.origin_lat * Math.PI / 180));
const rect = (x0, y0, x1, y1) => [{x: x0, y: y0}, {x: x1, y: y0}, {x: x1, y: y1}, {x: x0, y: y1}];

// ---- projection
const o = T.mapToLonLat(D, 0, 0);
ok('map origin = datum origin', Math.abs(o.lon - D.origin_lon) < 1e-12 && Math.abs(o.lat - D.origin_lat) < 1e-12, o);
const m = T.metersPerDeg(D.origin_lat);
const e10 = T.mapToLonLat(D, 10, 0);
ok('10 m east on a true-north map', Math.abs((e10.lon - D.origin_lon) * m.mLon - 10) < 1e-6
    && Math.abs(e10.lat - D.origin_lat) * m.mLat < 1e-6, e10);
const sh = T.mapToLonLat(D, 1, 0, {dx: 1, dy: 0});
ok('alignment offset: the tiles moved by the offset', Math.abs(sh.lon - D.origin_lon) < 1e-12, sh);
const rot = Object.assign({}, D, {yaw_rad: D.yaw_rad + Math.PI / 2});
const r10 = T.mapToLonLat(rot, 10, 0);
ok('a map turned 90°: map +x is true north', Math.abs((r10.lat - D.origin_lat) * m.mLat - 10) < 1e-6, r10);

// ---- the shape alone
const W = 64, H = 48;
const inside = (rings, w, h) => rings.every((r) => r.every(([x, y]) => x >= -1e-9 && y >= -1e-9 && x <= w + 1e-9 && y <= h + 1e-9));
const s1 = T.planShape([rect(-11, -14, 19, 2)], W, H);
ok('shape: fits the picture', s1 && inside(s1.rings, W, H), s1 && s1.rings);
ok('shape: north up (larger y = higher)', s1.rings[0][2][1] < s1.rings[0][0][1]);
ok('shape: a margin around', s1.rings[0].every(([x, y]) => x > 2 && y > 2 && x < W - 2 && y < H - 2));
ok('shape: no points, no picture', T.planShape([[{x: 0, y: 0}, {x: 1, y: 1}]], W, H) === null && T.planShape([], W, H) === null);
const tiny = T.planShape([rect(0, 0, 0.5, 0.5)], W, H);
ok('shape: a tiny zone is not blown up', tiny.mpp >= 8 * 1.28 / W - 1e-9, tiny.mpp);

// ---- shape + tiles
const p1 = T.planTiles([rect(-11, -14, 19, 2)], D, {w: W, h: H, dpr: 2, maxZoom: 21});
ok('tiles: one zoom, at most 4 tiles', p1 && p1.tilesAt(p1.z).length <= 4 && p1.z <= T.ZMAX, p1 && [p1.z, p1.tilesAt(p1.z).length]);
ok('tiles: the zone fits the picture', inside(p1.rings, W, H), p1.rings);
const cover = (tiles) => tiles.length && Math.min(...tiles.map((t) => t.left)) <= 0 && Math.min(...tiles.map((t) => t.top)) <= 0
    && Math.max(...tiles.map((t) => t.left + t.size)) >= W && Math.max(...tiles.map((t) => t.top + t.size)) >= H;
ok('tiles: they cover the whole picture', cover(p1.tilesAt(p1.z)), p1.tilesAt(p1.z));
ok('tiles: shape and tiles agree with the shape alone (same framing ±1 px)',
    p1.rings[0].every(([x, y], i) => Math.abs(x - s1.rings[0][i][0]) < 1 && Math.abs(y - s1.rings[0][i][1]) < 1),
    [p1.rings[0], s1.rings[0]]);
// a map corner lies in its own tile: slippy tile of its lon/lat vs. the drawn rect
(() => {
    const ll = T.mapToLonLat(D, -11, -14), n = Math.pow(2, p1.z);
    const w0 = T.world0(ll.lon, ll.lat), tx = Math.floor(w0.x * n / 256), ty = Math.floor(w0.y * n / 256);
    const t = p1.tilesAt(p1.z).find((q) => q.x === tx && q.y === ty);
    const [px, py] = p1.rings[0][0];
    ok('tiles: a zone corner is drawn inside the tile it lies in', t && px >= t.left && px <= t.left + t.size
        && py >= t.top && py <= t.top + t.size, {t, px, py});
})();
const osm = T.planTiles([rect(0, 0, 3, 3)], D, {w: W, h: H, dpr: 2, maxZoom: 19});
ok('tiles: the source max zoom holds', osm.z <= 19, osm.z);
const zfine = T.planTiles([rect(0, 0, 3, 3)], D, {w: W, h: H, dpr: 2, maxZoom: 22});
ok('tiles: never finer than ZMAX', zfine.z <= T.ZMAX, zfine.z);
ok('tiles: no datum = no tiles (shape alone)', T.planTiles([rect(0, 0, 3, 3)], {ok: false}, {w: W, h: H}) === null);
const big = T.planTiles([rect(-300, -200, 300, 200)], D, {w: W, h: H, dpr: 2, maxZoom: 21});
ok('tiles: a big area goes coarser, still ≤ 4 tiles', big.tilesAt(big.z).length <= 4 && big.z < 18, [big.z, big.tilesAt(big.z).length]);

// ---- budget: 20 programs of one garden (40 x 30 m)
const url = (t) => `http://robot:8082/wmts/gm_layer/gm_grid/${t.z}/${t.x}/${t.y}.png`;
function runBudget(progs, dpr) {
    const B = new T.Budget();
    let drawnWithTiles = 0;
    progs.forEach((rings) => {
        const p = T.planTiles(rings, D, {w: W, h: H, dpr, maxZoom: 21});
        const tiles = p && T.chooseTiles(p, 'sat', B, url, () => false);
        if (tiles) drawnWithTiles++;
    });
    return {asked: B.count('sat'), withTiles: drawnWithTiles};
}
const zones20 = [];
for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) zones20.push(rect(-20 + i * 8, -15 + j * 7.5, -20 + i * 8 + 7.5, -15 + j * 7.5 + 7));
const progs = zones20.map((z) => [z]);
progs.push(zones20.slice(0, 6), zones20.slice(6, 14), zones20);                     // programs with several zones
const b2 = runBudget(progs, 2), b1 = runBudget(progs, 1);
console.log('     23 programs / 20 zones: tiles asked dpr2=' + b2.asked + ', dpr1=' + b1.asked);
ok('budget: 20 zones of one garden ask ≤ 32 tiles (phone, DPR 2)', b2.asked <= 32 && b2.asked > 0, b2);
ok('budget: … and every card got its background', b2.withTiles === progs.length, b2);
ok('budget: desktop (DPR 1) too', b1.asked <= 32 && b1.withTiles === progs.length, b1);
// zones far apart (each its own tiles): the budget stops at MAX_TILES_SOURCE, the rest = shape alone
const far = []; for (let i = 0; i < 30; i++) far.push([rect(i * 2000, 0, i * 2000 + 20, 20)]);
const bf = runBudget(far, 2);
ok('budget: never more than MAX_TILES_SOURCE requests', bf.asked <= T.MAX_TILES_SOURCE && bf.withTiles < far.length, bf);
// a tile the main map already holds costs nothing
(() => {
    const B = new T.Budget(4);
    const p = T.planTiles([rect(-11, -14, 19, 2)], D, {w: W, h: H, dpr: 2, maxZoom: 21});
    const tiles = T.chooseTiles(p, 'sat', B, url, () => true);
    ok('budget: tiles of the main map cache are free', tiles && B.count('sat') === 0, B.count('sat'));
})();
// the program message -> rings
const prog = {zone_list: [{polygon: {polygon: {points: [{x: 0, y: 0, z: 0}, {x: 1, y: 0, z: 0}, {x: 1, y: 1, z: 0}]}}}, {polygon: {polygon: {points: []}}}, {}]};
const pr = T.programRings(prog);
ok('program rings: one per zone, in program order', pr.length === 3 && pr[0].length === 3 && pr[0][1].x === 1 && T.cleanRings(pr).length === 1, pr);
ok('program rings: nothing', T.programRings(null).length === 0);

// ---- the card: a click on the picture = the existing Show, nothing else
const src = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
function cut(text, head) {
    const start = text.indexOf(head);
    if (start < 0) throw new Error('no ' + head);
    let i = text.indexOf('{', start), depth = 0;
    for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    throw new Error('unbalanced ' + head);
}
const published = [];
class Topic {
    constructor(o) { this.name = o.name; }
    subscribe() {} advertise() {}
    publish(msg) { published.push([this.name, msg.name !== undefined ? msg.name : msg.data]); }
}
const ctx = {
    console, window: {addEventListener() {}, setTimeout: () => 0, clearTimeout() {}},
    document: {getElementById: () => null, addEventListener() {}},
    ROSLIB: {Topic, Message: function (mm) { Object.assign(this, mm); }},
    vtEsc: (s) => String(s), vtT: (k) => k, vtOnLang() {}, vtResultState: () => 'off', vtTag() {},
    uiPrefGet: () => '', uiPrefSet() {},
};
vm.createContext(ctx);
vm.runInContext(cut(src, 'class ProgramZoneItemTemplate') + cut(src, 'class ProgramListItemTemplate') + cut(src, 'class ForeignProgramItemTemplate')
    + cut(src, 'class Programs') + '\nthis.Programs = Programs;', ctx);
const row = {innerHTML: '', classList: {toggle() {}}, style: {}, dataset: {}};
const span = () => ({innerText: '', removeAttribute() {}, value: 0, checked: false, className: '', dataset: {}, classList: {contains: () => false, toggle() {}}});
const menu = new Proxy({div_menu_program_items_row: row, div_menu_program_detail_row: row}, {
    get(t, k) { if (!(k in t)) t[k] = span(); return t[k]; }});
ctx.Programs.prototype.init = function () {};
const P = new ctx.Programs({}, menu, {markerArrayClient: {markers: {}, removeMarker() {}}});
const zl = prog.zone_list.map((z) => Object.assign({name: 'Z', paths: []}, z));
P.program_list_msg = {program_list: [{name: 'Front', map_name: 'SITE', area: 10, length: 5, zone_list: zl},
                                     {name: 'Back', map_name: 'SITE', area: 10, length: 5, zone_list: zl}]};
P.draw_program_list();
P.available_zones = [{name: 'Z'}];      // the zone list is here (no republish on open)
ok('card: has the picture slot of its program', row.innerHTML.includes('data-thumb="o0"') && row.innerHTML.includes('vt-prog-thumb'), row.innerHTML);
ok('card: the click goes through cardClick', row.innerHTML.includes('programs.cardClick(0, event)'));
const evOn = (shape) => ({target: {closest: (sel) => (sel.indexOf('vt-prog-thumb') >= 0 && shape ? {} : null)}});
const sentNow = (f) => { published.length = 0; f(); return published.map((x) => x[0].split('/').pop() + ':' + x[1]); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// -- no planner state: Show at most once per program, until a Hide
P.marker_state = null;
let got = sentNow(() => P.cardClick(0, evOn(false)));
ok('card text: opens the program, sends nothing', same(got, []) && P.selected_program.name === 'Front', got);
got = sentNow(() => P.cardClick(0, evOn(true)));
ok('picture: the existing Show (program_to_show_marker) once', same(got, ['program_to_show_marker:Front']), got);
got = sentNow(() => P.cardClick(0, evOn(true)));
ok('picture again, no planner state: nothing (never a hide, not twice)', same(got, []) && P._programShown(), got);
P.cardClick(1, evOn(false)); got = sentNow(() => P.cardClick(0, evOn(true)));
ok('away and back, no planner state: still nothing', same(got, []), got);
P.show_program_in_map();                    // Hide
got = sentNow(() => P.cardClick(0, evOn(true)));
ok('after a Hide the picture shows it again', same(got, ['program_to_show_marker:Front']), got);
// -- with the planner state (the reviewer's cases): A = Front selected, a click on B = Back
const caseB = (ms, thumb) => {
    P.marker_state = null; P.cardClick(0, evOn(false));
    P.marker_state = Object.assign({run: '', run_visible: false, manual: '', total_m: 0}, ms); P._syncShowBtn();
    return sentNow(() => P.cardClick(1, evOn(thumb)));
};
got = caseB({manual: 'Back'}, true);
ok('B_already_manual, picture: nothing — B stays shown', same(got, []) && P._programShown(), got);
got = caseB({manual: 'Back'}, false);
ok('B_already_manual, card: nothing — B stays shown', same(got, []) && P._programShown(), got);
got = caseB({manual: 'agent:front_lawn'}, true);
ok('agent_zone_shown, picture: clear, then Show B', same(got, ['program_to_show_marker:none', 'program_to_show_marker:Back']) && P._programShown(), got);
got = caseB({manual: 'agent:front_lawn'}, false);
ok('agent_zone_shown, card: clear only, the button says Show', same(got, ['program_to_show_marker:none']) && !P._programShown(), got);
got = caseB({manual: 'Front'}, true);
ok('A_manual_shown, picture: clear A, Show B', same(got, ['program_to_show_marker:none', 'program_to_show_marker:Back']), got);
got = caseB({run: 'Back', run_visible: false}, true);
ok('B_running_hidden, picture: run_path_show true', same(got, ['run_path_show:true']), got);
got = caseB({run: 'Back', run_visible: true}, true);
ok('B_running_visible, picture: nothing (no hide)', same(got, []) && P._programShown(), got);
// a program of another map: no picture of zones, no Show
ctx.window.vitulusSites = [{name: 'BACK', programs_info: [{name: 'B1', area: 1, zone_names: ['Z']}]}];
ctx.window.vitulusServedSite = 'SITE';
P._foreignSig = ''; P._onSites();
ok('foreign card: picture slot without zones (map sign)', row.innerHTML.includes('data-thumb="f0"'), row.innerHTML);

// ---- wiring
const html = fs.readFileSync(path.join(ROOT, 'nodes', 'templates', 'index.html'), 'utf8');
ok('index.html loads the module', /<script src="\/assets\/js\/vt_map_thumbs\.js"><\/script>/.test(html));
ok('map_view.js loads it for an old template', src.includes("s.src = '/assets/js/vt_map_thumbs.js'"));
const thumbs = fs.readFileSync(path.join(JS, 'vt_map_thumbs.js'), 'utf8');
ok('module: no ROS, no write, no other host', !/ROSLIB|\.publish\(|method\s*:|XMLHttpRequest|sendBeacon|https?:\/\//.test(thumbs.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
const mapping = fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8');
ok('georef: mapping.js tells site / datum / offset changes', ["_georefChanged('site')", "_georefChanged('datum')", "_georefChanged('offset')"].every((k) => mapping.includes(k))
    && mapping.includes("new CustomEvent('vt:map-georef'"));
ok('georef: the pictures draw again and forget their own datum', /addEventListener\('vt:map-georef'[\s\S]{0,300}ownDatum = null[\s\S]{0,80}refresh\(\)/.test(thumbs));
const en = fs.readFileSync(path.join(JS, 'i18n', 'en.js'), 'utf8'), cs = fs.readFileSync(path.join(JS, 'i18n', 'cs.js'), 'utf8');
ok('i18n: the tooltip in en + cs', en.includes('"prog.m7.thumb_tip"') && cs.includes('"prog.m7.thumb_tip"'));
if (fails) { console.log('FAILED ' + fails); process.exit(1); }
console.log('OK');
