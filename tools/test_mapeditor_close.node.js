#!/usr/bin/env node
/*
 * Harness for leaving the map editor (mapeditor.js, vitulus-field#45).
 *
 *     node tools/test_mapeditor_close.node.js
 *
 * mapeditor.js is a DOM-bound IIFE, so the functions under test
 * (closeToMapPanel, toggleDetail, closeFromEditor) are sliced out of the
 * source verbatim and evaluated against stubs of hideDetail / showDetail /
 * controller and window.map_menu.  Checks:
 *   - "Close editor" (header ✕ / footer) leaves the editor and returns to the
 *     Map panel — it does NOT close the whole drawer,
 *   - the "Edit map" toggle does the same when the editor is active and opens
 *     the editor when it is not,
 *   - without show_map_panel the drawer is closed (old fallback), and without
 *     map_menu at all the editor is still left cleanly.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js',
              'mapeditor.js'), 'utf8');

function slice(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if (start < 0) { throw new Error(name + ' not found in mapeditor.js'); }
    let depth = 0, i = SRC.indexOf('{', start);
    for (let j = i; j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; }
        if (SRC[j] === '}') { depth--; if (!depth) { return SRC.slice(start, j + 1); } }
    }
    throw new Error(name + ' braces never closed');
}

function build(mapMenu, active) {
    const calls = [];
    const window = {};
    if (mapMenu) {
        window.map_menu = {};
        mapMenu.forEach(function (fn) {
            window.map_menu[fn] = function () { calls.push(fn); };
        });
    }
    const state = {active: active};
    const controller = function () { return state; };
    const hideDetail = function () { calls.push('hideDetail'); state.active = false; };
    const showDetail = function () { calls.push('showDetail'); state.active = true; };
    const api = new Function('window', 'controller', 'hideDetail', 'showDetail',
        slice('closeToMapPanel') + '\n' + slice('toggleDetail') + '\n' +
        slice('closeFromEditor') + '\n' +
        'return {toggleDetail: toggleDetail, closeFromEditor: closeFromEditor};'
    )(window, controller, hideDetail, showDetail);
    return {api: api, calls: calls};
}

let failed = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failed++; }
    console.log((ok ? 'ok   ' : 'FAIL ') + label +
                (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
}

const FULL = ['show_map_panel', 'close_drawer'];

let t = build(FULL, true);
t.api.closeFromEditor();
check('Close editor returns to the Map panel', t.calls, ['hideDetail', 'show_map_panel']);

t = build(FULL, true);
t.api.toggleDetail();
check('Edit map toggle (active) returns to the Map panel', t.calls, ['hideDetail', 'show_map_panel']);

t = build(FULL, false);
t.api.toggleDetail();
check('Edit map toggle (inactive) opens the editor', t.calls, ['showDetail']);

t = build(['close_drawer'], true);
t.api.closeFromEditor();
check('no show_map_panel -> drawer closed', t.calls, ['hideDetail', 'close_drawer']);

t = build(null, true);
t.api.closeFromEditor();
check('no map_menu -> editor still left', t.calls, ['hideDetail']);

if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('all checks passed');
