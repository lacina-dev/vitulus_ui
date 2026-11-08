#!/usr/bin/env node
// Zone fence in the UI (map_rules_guard, 2026-11-08): outside the zone it mows the
// program drives with the blade stopped, normal, so no banner and no notice; the
// editor shows it as info.  node tools/test_zone_fence_ui.node.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'nodes/templates/assets/js');

function banner(state, editing) {
    const subs = {};
    const els = [];
    const el = () => {
        const kids = {};
        const e = { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
            querySelector(sel) { return kids[sel] || (kids[sel] = { textContent: '' }); } };
        els.push(e);
        return e;
    };
    let tick = null;
    const ctx = {
        window: {}, document: { createElement: el, body: { appendChild() {} } },
        setInterval(fn) { tick = fn; return 1; }, clearInterval() {}, setTimeout() { return 1; },
        clearTimeout() {}, console,
    };
    ctx.window.ros = { ros: {} };
    ctx.window.VTI18n = ctx.VTI18n = { t: (k) => k, onChange() {} };
    ctx.window.__map_overlay = { editing: !!editing };
    ctx.window.VTMapObjects = null;
    ctx.ROSLIB = ctx.window.ROSLIB = { Topic: function (o) { this.subscribe = (cb) => { subs[o.name] = cb; }; } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(JS, 'vt_map_rules.js'), 'utf8'), ctx);
    tick();
    subs['/map_rules/state']({ data: JSON.stringify(state) });
    const e = els[0];
    if (!e || e.style.display === 'none') return null;
    return { tone: e.attrs['data-state'], text: e.querySelector('.vt-attn-txt').textContent };
}

const out = { blade: 'stopped_by_rule', held_by: 'zone', in: [], zone: { name: 'Bigger', outside: true } };
assert.strictEqual(banner(out, false), null, 'zone transit: no banner');
assert.deepStrictEqual(banner(out, true), { tone: 'info', text: 'maprules.blade_outside_zone' }, 'editor: info');
const nb = { blade: 'stopped_by_rule', held_by: 'noblade', in: [{ type: 'noblade', name: 'Bed' }] };
assert.strictEqual(banner(nb, false).tone, 'warn', 'noblade area still warns');

// A fence stop crossing a noblade area on the way back: the area warns.
assert.strictEqual(banner({ blade: 'stopped_by_rule', held_by: 'zone', in: [{ type: 'noblade', name: 'Bed' }] }, false).text,
    'maprules.blade_stopped', 'noblade inside the zone warns');
// No name known: the text without a name.
assert.strictEqual(banner({ blade: 'stopped_by_rule', held_by: 'noblade', in: [] }, false).text,
    'maprules.blade_stopped_any', 'no empty name');

// vt_autonomy: no notice for the zone fence
const auto = fs.readFileSync(path.join(JS, 'vt_autonomy.js'), 'utf8');
assert(/nb \|\| st\.held_by !== 'zone'/.test(auto), 'autonomy: zone fence is not said');
assert(!/maprules\.blade_outside_zone/.test(auto), 'autonomy: no outside-zone notice');

assert(/blade_stopped_any/.test(auto), 'autonomy: no empty name');
const mv = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
assert(mv.includes("'Held: blade spinning up': 'smach.held_blade_spinup'"), 'map_view: spin-up text translated');

// i18n and help
for (const lang of ['en', 'cs']) {
    const d = fs.readFileSync(path.join(JS, 'i18n', lang + '.js'), 'utf8');
    for (const k of ['maprules.blade_outside_zone', 'maprules.blade_stopped_any', 'smach.held_blade_spinup']) {
        assert(d.includes('"' + k + '"'), lang + ' key ' + k);
    }
}
const cs = fs.readFileSync(path.join(ROOT, 'docs/help/cs/safety.md'), 'utf8');
assert(cs.includes('- **STOP** vždy zastaví i nůž.'), 'cs help: STOP line');
assert(cs.includes('15 cm') && fs.readFileSync(path.join(ROOT, 'docs/help/safety.md'), 'utf8').includes('15 cm'), 'help: edge 15 cm');
console.log('OK — zone fence UI');
