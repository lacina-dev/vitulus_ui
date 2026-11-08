#!/usr/bin/env node
/*
 * Harness for the agent panel block "Watching" (vt_watch_rules.js, T27).
 *
 *     node tools/test_watch_rules.node.js
 *
 * The file is an IIFE that registers itself with window.VAgent.  It is run
 * against a stub DOM, a stub VAgent (registerBlock + api) and the English
 * dictionary.  Checks:
 *   - registers block 'watch' with a 15 s poll,
 *   - empty list → the empty-state sentence; error → the error line,
 *   - a paused rule shows Resume, a running one Pause; both have Cancel,
 *   - shadow mode note shown when the agent reports it,
 *   - Pause posts /api/watch/<id>/pause; Cancel asks confirm first and posts
 *     /api/watch/<id>/cancel only after yes; nothing is posted on "no".
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const EN = (function () {
    const win = {};
    new Function('window', fs.readFileSync(path.join(ROOT, 'i18n', 'en.js'), 'utf8'))(win);
    return win.VT_I18N_DICT.en;
})();
function fill(s, v) {
    return v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s;
}

let failures = 0;
function ok(label, cond) {
    if (!cond) { failures++; }
    console.log((cond ? 'ok   ' : 'FAIL ') + label);
}

function stubEl(tag) {
    const el = {
        tag: tag, children: [], className: '', textContent: '', disabled: false,
        style: {}, offsetParent: {}, onclick: null, id: '',
        appendChild(c) { this.children.push(c); return c; },
        set textContent(v) { this._t = String(v); if (v === '') { this.children = []; } },
        get textContent() {
            return (this._t || '') + this.children.map(c => c.textContent).join(' ');
        },
    };
    return el;
}
function all(node, pred, out) {
    out = out || [];
    if (pred(node)) { out.push(node); }
    (node.children || []).forEach(c => all(c, pred, out));
    return out;
}

const posted = [];
let reply = {ok: true, rules: [], shadow_motion: false};
let confirmAnswer = false;
let block = null;
const doc = {
    head: stubEl('head'),
    createElement: stubEl,
    getElementById: () => null,
    addEventListener() {},
};
const win = {
    VTI18n: {t: (k, v) => fill(k in EN ? EN[k] : k, v)},
    confirm: () => confirmAnswer,
    addEventListener() {},
    VAgent: {
        registerBlock(def) { block = def; },
        api(p, opts) {
            if (opts && opts.body !== undefined) { posted.push(p); return Promise.resolve({ok: true}); }
            return Promise.resolve(reply);
        },
    },
};
new Function('window', 'document', 'VTI18n', 'setInterval', 'clearInterval',
             fs.readFileSync(path.join(ROOT, 'vt_watch_rules.js'), 'utf8'))(
    win, doc, win.VTI18n, () => 0, () => {});

function flush() { return new Promise(r => setTimeout(r, 0)).then(() => new Promise(r => setTimeout(r, 0))); }

(async function () {
    ok('block registered as "watch"', block && block.id === 'watch');
    ok('poll every 15 s', block && block.poll && block.poll.every_ms === 15000);
    const root = stubEl('div');
    block.render(root);
    await flush();
    ok('empty state sentence', root.textContent.indexOf(EN['watchr.empty']) >= 0);

    reply = {ok: false, error: 'agent down'};
    block.onOpen();
    await flush();
    ok('error line', root.textContent.indexOf('agent down') >= 0);

    reply = {ok: true, shadow_motion: true, rules: [
        {id: 3, state: 'active', when: 'your UI is disconnected for more than 1 min',
         action: 'drive to point A', moves: true, mode: 'stream', every_s: 1, fired: 0},
        {id: 4, state: 'paused', why: 'STOP', when: 'battery below 30', action: 'tell you',
         moves: false, mode: 'poll', every_s: 60, fired: 2, last_fired: Date.now() / 1000 - 120}]};
    block.onOpen();
    await flush();
    const text = root.textContent;
    ok('shadow note shown', text.indexOf(EN['watchr.shadow']) >= 0);
    ok('rule text from the core shown verbatim', text.indexOf('drive to point A') >= 0);
    const buttons = all(root, n => n.tag === 'button');
    const labels = buttons.map(b => b.textContent);
    ok('running rule: Pause; paused rule: Resume; both Cancel',
       labels.filter(l => l === EN['watchr.pause']).length === 1
       && labels.filter(l => l === EN['watchr.resume']).length === 1
       && labels.filter(l => l === EN['watchr.cancel']).length === 2);
    buttons.find(b => b.textContent === EN['watchr.pause']).onclick();
    await flush();
    ok('Pause posts /api/watch/3/pause', posted.indexOf('/api/watch/3/pause') >= 0);
    const cancels = all(root, n => n.tag === 'button' && n.textContent === EN['watchr.cancel']);
    confirmAnswer = false;
    cancels[0].onclick();
    await flush();
    ok('Cancel without confirm posts nothing', posted.filter(p => /cancel/.test(p)).length === 0);
    confirmAnswer = true;
    all(root, n => n.tag === 'button' && n.textContent === EN['watchr.cancel'])[0].onclick();
    await flush();
    ok('Cancel after confirm posts /api/watch/3/cancel', posted.indexOf('/api/watch/3/cancel') >= 0);
    console.log(failures ? failures + ' FAILED' : 'OK — watch block');
    process.exit(failures ? 1 : 0);
})();
