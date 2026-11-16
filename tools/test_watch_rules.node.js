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
 *   - a blocked run shows its time and reason ("last 23:16 blocked (dock)"),
 *     a once-only rule says so,
 *   - Pause posts /api/watch/<id>/pause; Cancel asks confirm first and posts
 *     /api/watch/<id>/cancel only after yes; nothing is posted on "no",
 *   - T21 A7: a rule that would leave the dock without the owner's word says
 *     "waits for you" and the sentence to write; a dock block for another
 *     reason does not; the owner's own words stand first; what the block read
 *     is shared (window.VTWatchRules) and nothing is posted by any of it.
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

const TODAY_2316 = (function () { const d = new Date(); d.setHours(23, 16, 0, 0); return d.getTime() / 1000; })();
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
        setAttribute(k, v) { this[k] = v; },
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
         moves: false, mode: 'poll', every_s: 60, fired: 2, last_fired: Date.now() / 1000 - 120},
        {id: 5, state: 'active', when: 'it is 23:15', action: 'drive to point B', moves: true,
         mode: 'poll', every_s: 30, fired: 0, repeat: 'once',
         last_blocked: {ts: TODAY_2316, kind: 'dock', mission: null, why: 'robot je v doku'}},
        {id: 6, state: 'active', when: 'it is 23:15', action: 'drive to point C', moves: true,
         mode: 'poll', every_s: 30, fired: 0,
         last_blocked: {ts: new Date(2026, 10, 7, 23, 16).getTime() / 1000, kind: 'mission',
                        mission: 296, why: 'běží mise #296'}}]};
    block.onOpen();
    await flush();
    const text = root.textContent;
    ok('shadow note shown', text.indexOf(EN['watchr.shadow']) >= 0);
    ok('rule text from the core shown verbatim', text.indexOf('drive to point A') >= 0);
    ok('blocked run shown with time and reason (not "never")',
       text.indexOf(fill(EN['watchr.blocked'], {when: '23:16', why: EN['watchr.block.dock']})) >= 0);
    // T8 III: day first, like the rest of the English UI (en-GB) — 7 November is 7/11
    ok('blocked on another day: with the date in the English format (7/11)',
       text.indexOf(fill(EN['watchr.blocked'], {when: '7/11 23:16',
                                                why: fill(EN['watchr.block.mission'], {n: 296})})) >= 0);
    ok('repeat once shown', text.indexOf(EN['watchr.repeat.once']) >= 0);
    const buttons = all(root, n => n.tag === 'button');
    const labels = buttons.map(b => b.textContent);
    ok('running rule: Pause; paused rule: Resume; all Cancel',
       labels.filter(l => l === EN['watchr.pause']).length === 3
       && labels.filter(l => l === EN['watchr.resume']).length === 1
       && labels.filter(l => l === EN['watchr.cancel']).length === 4);
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
    // T21 A7
    const before = posted.length;
    const NO_WORD = {ts: TODAY_2316, kind: 'dock', mission: null,
                     why: 'robot je v doku a výjezd jsi pro tohle hlídání nepovolil'};
    reply = {ok: true, shadow_motion: false, rules: [
        {id: 12, state: 'active', when: 'baterie (%) nad 50', action: 'provedu dock.undock', moves: true,
         mode: 'poll', every_s: 60, fired: 0, repeat: 'once', last_blocked: NO_WORD,
         owner_text: 'Hlídej baterii: až bude nad 50 %, vyjeď z doku.'},
        {id: 13, state: 'active', when: 'it is 23:15', action: 'drive to point B', moves: true,
         mode: 'poll', every_s: 30, fired: 0,
         last_blocked: {ts: TODAY_2316, kind: 'dock', mission: null, why: 'robot je v doku'}},
        {id: 14, state: 'paused', why: 'STOP', when: 'x', action: 'y', moves: true, mode: 'poll', every_s: 30,
         last_blocked: NO_WORD}]};
    block.onOpen();
    await flush();
    const cards = all(root, n => /(^| )vwr-card( |$)/.test(n.className));
    const part = (c, cls) => all(c, n => n.className.split(' ').indexOf(cls) >= 0).map(n => n.textContent).join('|');
    ok('A7 waiting for the owner\'s word: state "waits for you"',
       cards.length === 3 && part(cards[0], 'vwr-state') === EN['watchr.state.waits'] && / waits/.test(cards[0].className));
    ok('A7 … with the sentence to write and the rule\'s number',
       part(cards[0], 'vwr-ask') === fill(EN['watchr.ask.undock'], {id: 12})
       && part(cards[0], 'vwr-ask').indexOf('u hlídání 12 povol výjezd z doku') >= 0);
    ok('A7 the owner\'s own words first, the agent\'s reading under them',
       part(cards[0], 'vwr-said').indexOf('Hlídej baterii: až bude nad 50 %, vyjeď z doku.') >= 0
       && cards[0].children.findIndex(n => n.className === 'vwr-said')
          < cards[0].children.findIndex(n => /vwr-main/.test(n.className))
       && part(cards[0], 'vwr-main').indexOf('baterie (%) nad 50 → provedu dock.undock') >= 0);
    ok('A7 the dock block is still said (time and reason)',
       cards[0].textContent.indexOf(fill(EN['watchr.blocked'], {when: '23:16', why: EN['watchr.block.dock']})) >= 0);
    ok('A7 a dock block for another reason: "running", no sentence',
       part(cards[1], 'vwr-state') === EN['watchr.state.active'] && part(cards[1], 'vwr-ask') === '');
    ok('A7 a paused rule stays "paused"',
       part(cards[2], 'vwr-state') === EN['watchr.state.paused'] && part(cards[2], 'vwr-ask') === '');
    ok('A7 no owner text: the core\'s line is the main line as before',
       part(cards[1], 'vwr-said') === '' && part(cards[1], 'vwr-main') === 'it is 23:15 → drive to point B');
    const W = win.VTWatchRules;
    ok('A7 shared with the Autonomy panel: the same answer, waits() per rule',
       W && W.last() === reply && W.waits(reply.rules[0]) === true && W.waits(reply.rules[1]) === false
       && W.waits(reply.rules[2]) === false && W.waits(Object.assign({}, reply.rules[1], {needs_undock_word: true})) === true
       && W.waits(Object.assign({}, reply.rules[0], {needs_undock_word: false})) === false);
    ok('A7 refresh asks at most once per interval', W.refresh(20000) === false && W.refresh(0) === true);
    await flush();
    ok('A7 showing and sharing posts nothing', posted.length === before);
    console.log(failures ? failures + ' FAILED' : 'OK — watch block');
    process.exit(failures ? 1 : 0);
})();
