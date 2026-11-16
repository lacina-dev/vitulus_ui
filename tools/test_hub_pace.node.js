#!/usr/bin/env node
/*
 * T39: how often the UI asks the field dashboard (vt_hub.js want / pace, the
 * hidden tab) and what vt_needs.js asks for with its panel closed and open,
 * on a fake clock with a counting fetch.
 *
 *     node tools/test_hub_pace.node.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
let fails = 0, n = 0;
function eq(name, got, want) {
    n += 1;
    if (got !== want) { fails += 1; console.log('FAIL ' + name + ': ' + JSON.stringify(got) + ' != ' + JSON.stringify(want)); }
}
function ok(name, v) { eq(name, !!v, true); }

/* a page: fake clock, fake timers, fetch that counts per URL and answers at once
   (synchronous thenables keep the whole thing on the fake clock) */
function page(answers) {
    const r = { t: 1e6, timers: [], hits: {}, vis: [], hidden: false, ls: {}, answers: answers || {} };
    let id = 0;
    function thenable(v, err) {
        return {
            then(f, g) {
                try {
                    if (err) { return g ? thenable(g(err)) : thenable(null, err); }
                    const o = f ? f(v) : v;
                    return (o && typeof o.then === 'function') ? o : thenable(o);
                } catch (e) { return thenable(null, e); }
            },
            catch(g) { return this.then(null, g); }
        };
    }
    r.made = [];
    const el = () => {
        const e = { style: {}, attrs: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            setAttribute(k, v) { e.attrs[k] = v; }, appendChild() {}, addEventListener() {}, insertBefore() {},
            querySelector() { return null; }, parentNode: { insertBefore() {} } };
        r.made.push(e);
        return e;
    };
    const toggler = el();
    r.bell = () => r.made.filter((e) => e.id === 'btn_needs')[0];
    const doc = {
        get hidden() { return r.hidden; }, readyState: 'complete',
        addEventListener(ev, fn) { if (ev === 'visibilitychange') { r.vis.push(fn); } },
        getElementById(id) { return id === 'btn_navbar_toggler' ? toggler : null; }, createElement: el, documentElement: el(), body: el()
    };
    const win = {
        document: doc, console: console, location: { hostname: 'robot' }, innerWidth: 1200,
        addEventListener() {},
        localStorage: { getItem: (k) => (k in r.ls ? r.ls[k] : null), setItem: (k, v) => { r.ls[k] = String(v); } },
        setTimeout: (fn, ms) => { const h = ++id; r.timers.push({ h, at: r.t + (ms || 0), fn }); return h; },
        clearTimeout: (h) => { r.timers = r.timers.filter((x) => x.h !== h); },
        setInterval: () => 0,
        fetch: (url) => {
            r.hits[url] = (r.hits[url] || 0) + 1;
            const a = r.answers[url];
            if (a === 'HANG') { r.hung = (r.hung || 0) + 1; return { then() { return this; }, catch() { return this; } }; }
            if (a === undefined) { return thenable({ ok: false, status: 503, json: () => thenable({ error: 'down' }) }); }
            return thenable({ ok: true, status: 200, json: () => thenable(a) });
        },
        MutationObserver: function () { this.observe = () => {}; }
    };
    win.window = win;
    const RealDate = Date;
    win.Date = class extends RealDate { static now() { return r.t; } };
    win.Date.parse = RealDate.parse;
    r.ctx = vm.createContext(win);
    r.load = (f) => vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), r.ctx, { filename: f });
    r.run = (ms) => {
        const end = r.t + ms;
        for (;;) {
            r.timers.sort((a, b) => a.at - b.at);
            const x = r.timers[0];
            if (!x || x.at > end) { break; }
            r.timers.shift();
            r.t = x.at;
            x.fn();
        }
        r.t = end;
    };
    r.setHidden = (h) => { r.hidden = h; r.vis.forEach((fn) => fn()); };
    r.count = (url) => r.hits[url] || 0;
    r.reset = () => { r.hits = {}; };
    r.win = win;
    return r;
}

const HOME = '/field/api/home', ATT = '/field/api/attention', NOW = '/field/api/activity/current';

/* ---- the hub alone */
let p = page({ '/field/api/x': { a: 1 }, '/agent/y': { b: 1 } });
p.load('vt_hub.js');
let H = p.win.VTHub;
ok('hub has want', typeof H.want === 'function');
ok('hub has pace', typeof H.pace === 'function');
H.poll('x', '/field/api/x', 60000);
eq('first ask at once', p.count('/field/api/x'), 1);
p.run(10 * 60000);
eq('base pace 60 s: 10 more in 10 min', p.count('/field/api/x'), 11);
p.reset();
H.want('x', 'panel', 15000);
p.run(60000);
eq('wanted at 15 s: 4 a minute', p.count('/field/api/x'), 4);
p.reset();
H.want('x', 'other', 30000);
H.want('x', 'panel', 0);
p.run(60000);
eq('the fastest remaining want (30 s)', p.count('/field/api/x'), 2);
H.want('x', 'other', 0);
p.reset();
p.run(120000);
eq('back to the base pace', p.count('/field/api/x'), 2);
H.pace('x', 0);
p.reset();
p.run(10 * 60000);
eq('base 0 and no want: never', p.count('/field/api/x'), 0);
H.refresh('x');
eq('refresh still asks', p.count('/field/api/x'), 1);
p.run(10 * 60000);
eq('and does not restart the beat', p.count('/field/api/x'), 1);
p.reset();
H.want('x', 'panel', 30000);
p.run(1);
eq('a want on stale data asks at once', p.count('/field/api/x'), 1);
p.run(60000);
eq('then at its pace', p.count('/field/api/x'), 3);
/* hidden tab: the field source stands still, the others slow down */
H.poll('y', '/agent/y', 10000);
p.reset();
p.setHidden(true);
p.run(10 * 60000);
eq('hidden: field not asked', p.count('/field/api/x'), 0);
eq('hidden: others on the slow beat', p.count('/agent/y'), 10);
p.reset();
p.setHidden(false);
eq('back: stale field source asked at once', p.count('/field/api/x'), 1);
p.run(60000);
eq('back: its pace again', p.count('/field/api/x'), 3);
/* a short hide must not lose the beat */
p.setHidden(true); p.run(5000); p.setHidden(false);
p.reset();
p.run(60000);
eq('short hide: the beat goes on', p.count('/field/api/x'), 2);
/* loaded in a hidden tab: nothing until it is shown */
p = page({ '/field/api/x': { a: 1 } });
p.hidden = true;
p.load('vt_hub.js');
p.win.VTHub.poll('x', '/field/api/x', 60000);
p.run(5 * 60000);
eq('loaded hidden: no ask', p.count('/field/api/x'), 0);
p.setHidden(false);
eq('shown: asked', p.count('/field/api/x'), 1);

/* ---- an answer that never comes: given up after the timeout, the source lives on */
p = page({ '/field/api/x': 'HANG' });
p.load('vt_hub.js');
H = p.win.VTHub;
let seen = [];
H.on('x', (e) => seen.push(e.ok + ':' + e.err));
H.poll('x', '/field/api/x', 30000);
eq('hang: asked', p.count('/field/api/x'), 1);
p.run(59000);
eq('hang: still waiting before the timeout', p.count('/field/api/x'), 1);
eq('hang: nothing reported yet', seen.length, 0);
p.run(2000);
eq('hang: reported as a failure', seen.join(), 'false:timeout');
p.answers['/field/api/x'] = { a: 2 };
p.run(60000);
eq('hang: asked again after the backoff (30 s x 2)', p.count('/field/api/x'), 2);
eq('hang: the source is alive again', H.get('x').ok, true);
eq('hang: data arrived', H.get('x').data.a, 2);
p.reset();
p.run(60000);
eq('hang: back at its pace', p.count('/field/api/x'), 2);
/* a normal answer leaves no timer behind that would fail it later */
p = page({ '/field/api/x': { a: 1 } });
p.load('vt_hub.js');
p.win.VTHub.pace && p.win.VTHub.poll('x', '/field/api/x', 300000);
p.run(120000);
eq('answered: the timeout does not fire afterwards', p.win.VTHub.get('x').ok, true);

/* ---- vt_needs.js: what the bell costs closed, what the panel asks open */
function needsPage(answers) {
    const q = page(answers);
    q.load('vt_hub.js');
    q.load('vt_needs.js');
    return q;
}
const home = { todo: { mine: { items: [{ key: 'a', title: 'x' }], more: 0 } }, stav: {} };
p = needsPage({ [HOME]: home, [ATT]: { items: [] }, [NOW]: {}, '/field/ui_actions?limit=50': {} });
ok('needs loaded', p.win.VTNeeds);
eq('load: home once', p.count(HOME), 1);
eq('load: attention once (stand-in until home answers)', p.count(ATT), 1);
eq('load: now once', p.count(NOW), 1);
p.reset();
p.run(10 * 60000);
eq('closed 10 min: home once a minute', p.count(HOME), 10);
eq('closed 10 min: attention never', p.count(ATT), 0);
eq('closed 10 min: now once a minute', p.count(NOW), 10);
/* hidden tab: nothing from the dashboard */
p.setHidden(true);
p.reset();
p.run(10 * 60000);
eq('hidden: no home', p.count(HOME), 0);
eq('hidden: no attention', p.count(ATT), 0);
eq('hidden: no now', p.count(NOW), 0);
p.setHidden(false);
eq('shown again: home at once', p.count(HOME), 1);
eq('shown again: still no attention', p.count(ATT), 0);
/* the red of the bell with the panel closed comes from /api/home (kit 0.9.66 todo.mine.high) */
function homeHigh(h) { return { todo: { mine: { items: [{ key: 'a', title: 'x' }], more: 0, high: h } }, stav: {} }; }
p = needsPage({ [HOME]: homeHigh(1), [ATT]: { items: [] }, [NOW]: {} });
ok('the bell exists', p.bell());
eq('undelivered notification: the bell is red', p.bell().attrs['data-state'], 'err');
p.reset();
p.run(5 * 60000);
eq('red without asking the attention list', p.count(ATT), 0);
p.answers[HOME] = homeHigh(0);
p.run(60000);
eq('solved: amber within a minute', p.bell().attrs['data-state'], 'warn');
p.answers[HOME] = homeHigh(2);
p.run(60000);
eq('a new one: red within a minute', p.bell().attrs['data-state'], 'err');
p.answers[HOME] = { todo: { mine: { items: [], more: 0, high: 0 } }, stav: {} };
p.run(60000);
eq('nothing waits: off', p.bell().attrs['data-state'], 'off');
/* an older kit (no high in home): a fresh attention list decides, a stale one does not */
p = needsPage({ [HOME]: home, [ATT]: { items: [{ id: 'n', kind: 'notify', urgency: 'high' }] }, [NOW]: {} });
eq('old kit, fresh list: red', p.bell().attrs['data-state'], 'err');
p.run(3 * 60000);
eq('old kit, list older than 90 s: amber', p.bell().attrs['data-state'], 'warn');

/* the dashboard does not answer /api/home: the attention list stands in, once a minute */
p = needsPage({ [ATT]: { items: [] }, [NOW]: {} });
p.reset();
p.run(10 * 60000);
ok('home down: attention keeps the count (>= 9 in 10 min)', p.count(ATT) >= 9 && p.count(ATT) <= 10);
ok('home down: home backs off', p.count(HOME) <= 4);
/* the support panel wants home faster only while it is open */
p = needsPage({ [HOME]: home, [ATT]: { items: [] }, [NOW]: {} });
p.win.VTHub.want('field.home', 'support', 45000);
p.reset();
p.run(9 * 60000);
eq('support open: home every 45 s', p.count(HOME), 12);
p.win.VTHub.want('field.home', 'support', 0);
p.reset();
p.run(10 * 60000);
eq('support closed: home once a minute', p.count(HOME), 10);

console.log(fails ? ('FAILED ' + fails + ' of ' + n) : ('OK ' + n + ' checks'));
process.exit(fails ? 1 : 0);
