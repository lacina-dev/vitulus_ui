#!/usr/bin/env node
/*
 * D6 (agent panel and its alerts, 2026-11-08) — the logic that changed:
 *
 *     node tools/test_agent_d6.node.js
 *
 *  - Activity rows drop long hex ids from the text a person reads (the
 *    tooltip keeps the whole line); short ids and version hashes stay;
 *  - the core's built-in ways of a finding (ignore / ack / revert) are said in
 *    the UI's language, the agent's own `task` proposal keeps its words, and
 *    the decision POST still carries the core's `way` number (not the label);
 *  - the map strip's finding chip is red only for findings not seen yet;
 *  - the D6 keys exist in en.js and cs.js, cs plural forms included.
 * Functions are sliced out of the sources verbatim (the modules are DOM-bound
 * IIFEs) and run against small stubs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
function dict(lang) {
    const win = {};
    vm.runInNewContext(read(path.join('i18n', lang + '.js')), {window: win});
    return win.VT_I18N_DICT[lang];
}
const EN = dict('en'), CS = dict('cs');
const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s);
let D = EN;
const T = (k, v) => fill(k in D ? D[k] : k, v);

function slice(src, name, file) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) { throw new Error(name + ' not found in ' + file); }
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
        if (src[j] === '{') { depth++; }
        if (src[j] === '}') { depth--; if (!depth) { return src.slice(start, j + 1); } }
    }
    throw new Error(name + ' braces never closed');
}
function sliceVar(src, name, file) {
    const start = src.indexOf('var ' + name + ' =');
    if (start < 0) { throw new Error(name + ' not found in ' + file); }
    return src.slice(start, src.indexOf(';', src.indexOf('}', start)) + 1);
}

const fails = [];
function ok(label, cond) { if (!cond) { fails.push(label); } console.log((cond ? 'ok   ' : 'FAIL ') + label); }

/* ---- Activity: human() */
const act = read('vt_activity.js');
const human = new Function(slice(act, 'human', 'vt_activity.js') + '\nreturn human;')();
ok('activity: a step hash is dropped from the row text',
   human('Step d44e92e5dc4c The briefing "To solve": running -> done') === 'Step The briefing "To solve": running -> done');
ok('activity: 7-char version hashes stay', human('Kit updated 0.9.61 (ba63691) -> 0.9.61 (5833275)') === 'Kit updated 0.9.61 (ba63691) -> 0.9.61 (5833275)');
ok('activity: a long all-digit stamp stays', human('written 20261108_011005, 2 GB free') === 'written 20261108_011005, 2 GB free');
ok('activity: an id after # stays', human('Job #d44e92e5dc4c04: x') === 'Job #d44e92e5dc4c04: x');
ok('activity: empty in, empty out', human('') === '' && human(null) === '');

/* ---- Findings: the built-in ways in the UI's language */
const blk = read('agent_blocks.js');
const ways = new Function('T', 'recDetail',
    sliceVar(blk, 'REC_WAY_I18N', 'agent_blocks.js') + '\n' +
    slice(blk, 'recWayLabel', 'agent_blocks.js') + '\n' + slice(blk, 'recDoes', 'agent_blocks.js') +
    '\nreturn {recWayLabel: recWayLabel, recDoes: recDoes};')(T, {});
const W_IGN = {way: 2, kind: 'ignore', label: 'Příště ignorovat', does: 'Zavřu to…'};
const W_ACK = {way: 3, kind: 'ack', label: 'Beru na vědomí'};
const W_TASK = {way: 0, kind: 'task', label: 'Ověřit obraz kamery', does: 'Jednorázově ověřím obraz.'};
D = EN;
ok('findings en: ignore is "' + ways.recWayLabel(W_IGN) + '"', ways.recWayLabel(W_IGN) === EN['agent.d6.way.ignore']);
ok('findings en: ack is "' + ways.recWayLabel(W_ACK) + '"', ways.recWayLabel(W_ACK) === EN['agent.d6.way.ack']);
ok('findings en: the agent\'s own proposal keeps its words', ways.recWayLabel(W_TASK) === 'Ověřit obraz kamery');
ok('findings en: what ignore does, in English', ways.recDoes({}, W_IGN) === EN['agent.d6.way.ignore_does']);
ok('findings en: what a task does stays the core\'s sentence', ways.recDoes({id: 1}, W_TASK) === 'Jednorázově ověřím obraz.');
D = CS;
ok('findings cs: ignore is the core\'s own word', ways.recWayLabel(W_IGN) === 'Příště ignorovat');
ok('findings cs: ack is the core\'s own word', ways.recWayLabel(W_ACK) === 'Beru na vědomí');
ok('findings: the decision body still sends the way number',
   /body: \{way: way\.way, by: VA\.authorId \|\| 'ui'\}/.test(blk));
ok('findings: a Read-this row has no per-card READ THIS chip', /if \(r\.status !== 'read'\) \{\s*l1\.appendChild\(el\('span', 'vrec-chip/.test(blk));

/* ---- the strip: red only for findings not seen yet */
const chat = read('agent_chat.js');
let LS = {};
const seenN = new Function('lsGet', 'LS_FIND_SEEN',
    slice(chat, 'findingsSeenN', 'agent_chat.js') + '\nreturn findingsSeenN;')((k) => (k in LS ? LS[k] : null), 'k');
const kindOf = (n) => (n > seenN() ? 'finding' : 'finding-seen');
ok('strip: nothing seen yet -> red', kindOf(15) === 'finding');
LS.k = '15';
ok('strip: 15 seen, 15 open -> quiet', kindOf(15) === 'finding-seen');
ok('strip: 15 seen, 16 open -> red again', kindOf(16) === 'finding');
LS.k = 'garbage';
ok('strip: an unreadable mark counts as nothing seen', kindOf(1) === 'finding');
ok('strip: the pick uses the seen mark', /kind: stripReadN > findingsSeenN\(\) \? 'finding' : 'finding-seen'/.test(chat));
ok('strip: the mark comes down with the count', /if \(findingsSeenN\(\) > stripReadN\) \{ lsSet\(LS_FIND_SEEN, String\(stripReadN\)\); \}/.test(chat));
ok('agent STOP: the click still asks first and posts /api/stop',
   /inlineConfirm\(stopBtn, function \(\) \{ doStop\(\); \}\)/.test(chat) && /api\('\/api\/stop', \{body: \{author: displayName \|\| author\}\}\)/.test(chat));

/* ---- dictionaries */
const KEYS = ['agent.d6.stop', 'agent.d6.stop_short', 'agent.d6.stop_tip', 'agent.d6.filter_tip',
    'agent.d6.read_n.one', 'agent.d6.read_n.other', 'agent.d6.robot_state', 'agent.d6.way.ignore',
    'agent.d6.way.ignore_does', 'agent.d6.way.ack', 'agent.d6.way.ack_does', 'agent.d6.way.revert',
    'agent.d6.way.revert_does', 'needs.d6.side_me'];
ok('i18n: every D6 key in en and cs', KEYS.every((k) => typeof EN[k] === 'string' && typeof CS[k] === 'string'));
ok('i18n: cs plural of the strip count (2 few, 5 other)', CS['agent.d6.read_n.few'] === '{n} nepřečtené' && CS['agent.d6.read_n.other'] === '{n} nepřečtených');
ok('i18n: the old strip key is gone', !('agent.strip.read_n' in EN) && !('agent.strip.read_n' in CS));

if (fails.length) { console.log('\n' + fails.length + ' FAILED'); process.exit(1); }
console.log('\nOK — D6 agent checks passed');
