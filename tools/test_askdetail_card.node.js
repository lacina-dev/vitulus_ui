#!/usr/bin/env node
/*
 * Harness for the structured approval card (agent_chat.js).
 *
 *     node tools/test_askdetail_card.node.js
 *
 * The APPROVALS block is evaluated against a stub DOM (the same seam
 * test_webchat.py uses).  Since the 2026-08-28 redesign the card has a fixed
 * four-layer hierarchy and the harness asserts it end to end:
 *
 *   1. header strip   (.ah  = type chip + age/auto-deny pills,
 *                      .ah.asrc = job ref + goal head + who asked)
 *   2. the ask        (.asay — ONE plain Czech sentence per kind)
 *   3. decision row   (.ar.aact — Approve / Deny / „via:" executors)
 *   4. details        (.adet — every <details> collapsed by default)
 *
 * plus: ordering (plans, then parked jobs, then held commands; newest first),
 * the executor pick and open sections surviving a redraw, the two-tap Deny,
 * the no-redraw fingerprint, the truncated-payload fetch, legacy asks with no
 * `detail`, and the empty state.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js',
              'agent_chat.js'), 'utf8');
const start = SRC.indexOf('    // ======================================================= APPROVALS block');
const end = SRC.indexOf('    // ==================================================== shared state poll');
if (start < 0 || end < 0) {
    console.error('FAIL approvals block markers not found');
    process.exit(1);
}
const block = SRC.slice(start, end);

function el(tag) {
    return {
        tag: tag, className: '', _text: '', title: '', type: '',
        disabled: false, open: false, children: [], handlers: {},
        get textContent() { return this._text; },
        set textContent(v) { this._text = String(v); if (v === '') { this.children = []; } },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener(k, fn) { this.handlers[k] = fn; },
        querySelectorAll() { return this.all().filter(n => n.tag === 'button'); },
        all() { return this.children.reduce((a, c) => a.concat([c], c.all ? c.all() : []), []); },
        classList: null,
        text() {
            return (this._text ? this._text + ' ' : '') +
                this.children.map(c => (c.text ? c.text() : c._text || '')).join(' ');
        }
    };
}
function withClassList(node) {
    const s = new Set();
    node.classList = {
        add: c => { s.add(c); node.className = (node.className + ' ' + c).trim(); },
        remove: c => {
            s.delete(c);
            node.className = node.className.split(/\s+/)
                .filter(x => x && x !== c).join(' ');
        },
        contains: c => s.has(c),
        toggle: (c, on) => (on ? s.add(c) : s.delete(c))
    };
    return node;
}
const realCreate = tag => withClassList(el(tag));

const gate = realCreate('div');
global.document = {
    getElementById: id => (id === 'vagent_gate' ? gate : null),
    createElement: realCreate
};
const AGENT_HTTP = 'http://robot:8088';
const author = 'webui:test';
let posted = [];
let detailFetches = [];
const FULL_TEXT = 'FULL PLAN ' + 'y'.repeat(50);
function api(url, opts) {
    if (url.indexOf('/decide') >= 0) {
        posted.push(opts.body);
        return Promise.resolve({ok: true, message: 'ok'});
    }
    if (/\/api\/approvals\/\d+\/detail$/.test(url)) {
        detailFetches.push(url);
        return Promise.resolve({ok: true, detail: {payload: {text: FULL_TEXT}}});
    }
    return Promise.resolve({approvals: []});
}
let ctxAsks = [];
function paintCtx() {}
function flagTab() {}
function notify() {}
function activateTab() {}
let highlighted = [];
function highlightJob(ref) { highlighted.push(ref); }

let gateBody = null;
eval(block + '\ngateBody = gate;'
    + 'global.__w = {renderApprovals, askOpen, askExec, askRowsMap, '
    + 'askOutcomes, highlightAsk, askSentence, askKind, planTitle};');
const w = global.__w;

let fails = 0;
function ok(label, got) {
    const good = !!got;
    if (!good) { fails++; }
    console.log((good ? 'ok' : 'fail') + '\t' + label);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXECUTORS = [
    {id: 'hermes', label: 'Hermes (staged legs)', desc: 'a'},
    {id: 'codex', label: 'Codex (single long run)', desc: 'b'},
    {id: 'claude', label: 'Claude Opus 5 (single long run)', desc: 'c'}];

/* fixtures modelled on the live asks #60 (plan), #55 (resume), #56 (command) */
function planAsk(id, asked) {
    return {
        id: id, asked: asked, command: 'pokračuj na 147', tool: 'job',
        rule: 'job:resume', job_id: 147, job_state: 'blocked',
        asker: 'práce #147 (Rozvíjej vitulusovi ai schopnosti…)',
        plain: 'Práce #147 stojí: návrh a kachní kritika byly hozeny do chatu…',
        waiting_s: 62000, left_text: '6 h 41 min',
        detail: {
            what: 'Schválit plán práce #147 a pustit ji do realizace.',
            why: 'zadání explicitně žádá počkat na schválení majitele',
            action_on_approve: 'Práce dostane tvůj souhlas a pokračuje implementací.',
            action_on_deny: 'Práce zůstane odložená.',
            payload: {kind: 'plan', truncated: true, text:
                '[SCOPE] src/vitulus_claude/agent/incidents.py Návrh: AI ' +
                'diagnostický rozlišovač pro incidenty Problém: Deeper look ' +
                'dnes vrací jednu příčinu a verdikt.'},
            context: {job_ref: 'j:147', job_state: 'blocked', legs: 2,
                job_goal: 'Rozvíjej vitulusovi ai schopnosti. Udělej něco čím ' +
                    'přineseš vitulusovi lepší schopnost pomocí ai.',
                last_error: 'zaseklo se: čeká na schválení majitele',
                recent_posts: [{ts: 1, head: 'Práce #147 (etapa 2) se zasekla'}]},
            risk: ['pokračuje v repu; na drát jen přes brány'],
            executors: EXECUTORS, recommended: 'codex'
        }
    };
}
const resumeAsk = {
    id: 55, asked: 300, command: 'pokračuj na 11', tool: 'job',
    rule: 'job:resume', job_id: 11, job_state: 'done',
    asker: 'práce #11 (nekonecna prace)', waiting_s: 62318, left_text: '6 h 41 min',
    plain: 'Práce #11 stojí: 3 etap po sobě spadlo…',
    detail: {
        what: 'Oživit práci #11 a pustit ji dál.',
        why: '3 etapy po sobě spadly',
        action_on_approve: 'Práce pokračuje.', action_on_deny: 'Zůstane odložená.',
        payload: {kind: 'resume', text: '3 etapy po sobě spadly, restart jádra'},
        context: {job_ref: 'j:11', job_goal: 'nekonečná práce', job_state: 'done',
                  legs: 0, recent_posts: []},
        risk: [], executors: EXECUTORS, recommended: 'codex'
    }
};
const cmdAsk = {
    id: 56, asked: 500, tool: 'terminal', rule: 'systemctl:?',
    command: 'systemctl --user --failed --no-pager', asker: 'Hermes (chat)',
    job_id: 143, job_state: 'done', waiting_s: 62221, left_text: '6 h 43 min',
    plain: 'zastaví/spustí/restartuje službu na tomhle robotu',
    detail: {
        what: 'Spustit držený příkaz na robotu (jednou).',
        why: 'zastaví/spustí/restartuje službu na tomhle robotu',
        action_on_approve: 'Příkaz projde branou a spustí se.',
        action_on_deny: 'Příkaz neproběhne.',
        payload: {kind: 'command', truncated: false,
                  text: 'systemctl --user --failed --no-pager'},
        context: {job_ref: 'j:143', job_goal: 'Vizita robota', job_state: 'done',
                  legs: 1, recent_posts: []},
        risk: ['drží ho brána shellu (systemctl:?)'], executors: [],
        recommended: null
    }
};

function cls(node) { return String(node.className || ''); }
function kids(row) { return row.children.map(cls); }
function detailsOf(row) { return row.all().filter(n => n.tag === 'details'); }

async function main() {
    // ---- 1. hierarchy, ordering, collapsed detail -----------------------
    const planNew = planAsk(61, 200), planOld = planAsk(60, 100);
    w.renderApprovals([planOld, cmdAsk, resumeAsk, planNew]);
    const order = gate.children.map(r => r._askId);
    ok('plans first, then parked job, then held command',
        order.join(',') === '61,60,55,56');
    ok('newest plan on top (61 before 60)',
        order.indexOf(61) < order.indexOf(60));

    const row = gate.children[0];                       // the plan card
    const layout = kids(row);
    ok('layer 1 is the header strip', layout[0] === 'ah');
    ok('layer 1b is the source line', layout[1] === 'ah asrc');
    ok('layer 2 is the plain sentence', layout[2] === 'asay');
    ok('layer 3 is the decision row', layout[3] === 'ar aact');
    ok('layer 4 is the collapsed details', layout[4] === 'adet');
    ok('actions come before details',
        layout.indexOf('ar aact') < layout.indexOf('adet'));
    ok('nothing else above the buttons', layout.length === 5);

    const header = row.children[0].text() + ' ' + row.children[1].text();
    ok('header names the type', header.indexOf('Plan approval') >= 0);
    ok('header shows the age', header.indexOf('waiting 17 h') >= 0);
    ok('header shows the auto-deny countdown',
        header.indexOf('auto-deny in 6 h 41 min') >= 0);
    ok('header shows the job ref + goal head', header.indexOf('j:147') >= 0 &&
        header.indexOf('Rozvíjej vitulusovi ai') >= 0);
    ok('header goal is cut short (no scroll)',
        header.indexOf('lepší schopnost pomocí ai') < 0);
    ok('header shows who asked', header.indexOf('by job #147') >= 0);
    ok('header flags a parked job', header.indexOf('parked') >= 0);
    ok('left border carries the type', cls(row).indexOf('k-plan') >= 0);
    ok('held command gets its own colour',
        cls(gate.children[3]).indexOf('k-cmd') >= 0);
    ok('resume gets its own colour',
        cls(gate.children[2]).indexOf('k-resume') >= 0);

    const say = row.children[2].text();
    ok('plan sentence names the plan title',
        say.indexOf('připravil plán „AI diagnostický rozlišovač pro incidenty“') >= 0);
    ok('plan sentence names the job', say.indexOf('pro práci #147') >= 0);
    ok('plan sentence asks for a yes', say.indexOf('čeká na tvoje ANO') >= 0);
    ok('plan title stops before the next heading',
        say.indexOf('Problém') < 0);
    const saySt = gate.children[2].children[2].text();
    ok('resume sentence is plain Czech',
        saySt.indexOf('Práce #11 stojí a čeká na tvoje ANO') >= 0);
    const sayCmd = gate.children[3].children[2].text();
    ok('command sentence is plain Czech',
        sayCmd.indexOf('Robot chce jednou spustit tento příkaz') >= 0);
    ok('command sentence shows the command itself',
        sayCmd.indexOf('systemctl --user --failed') >= 0);
    ok('command is rendered as <code>',
        gate.children[3].children[2].children.some(c => c.tag === 'code'));
    const blockedSay = w.askSentence(
        Object.assign({}, resumeAsk, {job_state: 'blocked',
            detail: Object.assign({}, resumeAsk.detail,
                {context: Object.assign({}, resumeAsk.detail.context,
                    {job_state: 'blocked'})})}), 'resume').text;
    ok('a parked job says it is stuck',
        blockedSay.indexOf('Práce #11 se zasekla') >= 0);
    ok('a bare ask falls back to detail.what',
        w.askSentence({id: 1, detail: {what: 'Udělej X.'}}, 'resume').text
            === 'Udělej X.');

    const secs = detailsOf(row);
    ok('four detail sections', secs.length === 4);
    ok('all sections collapsed by default', secs.every(s => s.open === false));
    ok('payload section is labelled + counted',
        secs[0].text().indexOf('Plan · ') >= 0 &&
        secs[0].text().indexOf(' words') >= 0);
    ok('closed section offers „show"', secs[0].text().indexOf('show') >= 0);
    ok('section order: payload, context, what happens, risk',
        secs[1].text().indexOf('Context') >= 0 &&
        secs[2].text().indexOf('What happens') >= 0 &&
        secs[3].text().indexOf('Risk') >= 0);
    const body = row.text();
    ok('plan text lives in the detail', body.indexOf('[SCOPE] src/vitulus') >= 0);
    ok('what/why/on-approve live in the detail',
        body.indexOf('Schválit plán práce #147') >= 0 &&
        body.indexOf('počkat na schválení majitele') >= 0 &&
        body.indexOf('pokračuje implementací') >= 0);
    ok('context carries goal, state, legs, error and posts',
        body.indexOf('lepší schopnost pomocí ai') >= 0 &&
        body.indexOf('state blocked') >= 0 && body.indexOf('legs 2') >= 0 &&
        body.indexOf('last error') >= 0 &&
        body.indexOf('etapa 2) se zasekla') >= 0);
    ok('risk pill renders', body.indexOf('na drát jen přes brány') >= 0);
    ok('command card labels its payload Command',
        detailsOf(gate.children[3])[0].text().indexOf('Command · ') >= 0);
    ok('resume card labels its payload Brief',
        detailsOf(gate.children[2])[0].text().indexOf('Brief · ') >= 0);

    // ---- 2. decision row -------------------------------------------------
    let buttons = row.querySelectorAll();
    const act = row.children[3];
    const actBtns = act.querySelectorAll();
    ok('Approve is the first control', actBtns[0]._text === 'Approve');
    ok('Deny is the second control', actBtns[1]._text === 'Deny');
    const execBtns = actBtns.filter(b => cls(b).indexOf('aeb') >= 0);
    ok('executor segment sits in the decision row', execBtns.length === 3);
    ok('via: label is compact', act.text().indexOf('via:') >= 0);
    const preselected = execBtns.filter(b => b.classList.contains('sel'));
    ok('recommended preselected (codex)', preselected.length === 1 &&
        preselected[0]._text.indexOf('Codex') >= 0);
    ok('recommended starred', preselected[0]._text.indexOf('★') >= 0);
    ok('held command offers no executor',
        gate.children[3].querySelectorAll()
            .filter(b => cls(b).indexOf('aeb') >= 0).length === 0);

    // job link from the header
    const refBtn = buttons.find(b => cls(b) === 'aref');
    refBtn.handlers.click();
    ok('header job link highlights j:147', highlighted[0] === 'j:147');

    // ---- 3. state that must survive the poll redraw ----------------------
    execBtns.find(b => b._text.indexOf('Claude') >= 0).handlers.click();
    const openSec = secs[1];
    openSec.open = true;
    openSec.handlers.toggle();
    planNew.waiting_s = 62400;                  // a poll with a fresher clock
    w.renderApprovals([planOld, cmdAsk, resumeAsk, planNew]);
    const row2 = gate.children[0];
    ok('the card was redrawn', row2 !== row);
    const sel2 = row2.querySelectorAll()
        .filter(b => cls(b).indexOf('aeb') >= 0 && b.classList.contains('sel'));
    ok('executor pick survives the redraw',
        sel2.length === 1 && sel2[0]._text.indexOf('Claude') >= 0);
    const ctx2 = detailsOf(row2).find(d => d.text().indexOf('Context') >= 0);
    ok('open section survives the redraw', ctx2.open === true);
    ok('the other sections stay closed',
        detailsOf(row2).filter(d => d.open).length === 1);

    // ---- 4. fingerprint: no redraw when nothing rendered changed ---------
    w.renderApprovals([planOld, cmdAsk, resumeAsk, planNew]);
    ok('identical poll does not rebuild the DOM', gate.children[0] === row2);
    planNew.left_text = '6 h 40 min';
    w.renderApprovals([planOld, cmdAsk, resumeAsk, planNew]);
    ok('a changed countdown does rebuild', gate.children[0] !== row2);

    // ---- 5. truncated payload fetches the full text ----------------------
    const row3 = gate.children[0];
    const moreBtn = row3.querySelectorAll().find(b => cls(b) === 'amore');
    ok('truncated payload offers show full', !!moreBtn);
    moreBtn.handlers.click();
    await sleep(5);
    ok('show full fetched /detail', detailFetches.length === 1);

    // ---- 6. Deny asks twice ---------------------------------------------
    posted = [];
    const denyBtn = row3.querySelectorAll().find(b => cls(b).indexOf('an') >= 0
        && b._text.indexOf('Deny') === 0);
    denyBtn.handlers.click();
    ok('first Deny tap only arms', posted.length === 0 &&
        denyBtn._text.indexOf('really') >= 0 &&
        denyBtn.classList.contains('armed'));
    denyBtn.handlers.click();
    await sleep(5);
    ok('second Deny tap decides', posted.length === 1 &&
        posted[0].decision === 'deny' && !('executor' in posted[0]));

    // ---- 7. Approve posts the chosen executor ---------------------------
    posted = [];
    w.renderApprovals([planAsk(70, 900)]);
    const row4 = gate.children[0];
    row4.querySelectorAll()
        .find(b => cls(b).indexOf('aeb') >= 0 && b._text.indexOf('Claude') >= 0)
        .handlers.click();
    row4.querySelectorAll().find(b => b._text === 'Approve').handlers.click();
    ok('approve posts the picked executor (claude)', posted.length === 1 &&
        posted[0].decision === 'allow' && posted[0].executor === 'claude');
    await sleep(5);
    posted = [];
    w.renderApprovals([planAsk(71, 901)]);
    gate.children[0].querySelectorAll()
        .find(b => b._text === 'Approve').handlers.click();
    ok('a fresh ask approves with the recommended executor',
        posted.length === 1 && posted[0].executor === 'codex');
    await sleep(5);

    // ---- 8. legacy ask without detail ------------------------------------
    posted = [];
    w.renderApprovals([{id: 4, command: 'rosparam set /x 1',
        plain: 'nastaví parametr', asker: 'práce #12', waiting_s: 7200,
        left_text: '22 h', job_state: 'blocked'}]);
    const legacy = gate.children[0];
    // Same four layers, plus the plain-Czech line: without detail there is no
    // „What happens" section, so `plain` is the only thing on the card that
    // says what the command actually does — it sits right under the ask.
    ok('legacy card keeps the four-layer shape',
        kids(legacy).slice(0, 5).join(',')
            === 'ah,ah asrc,asay,asay aplain,ar aact');
    ok('legacy card renders the command',
        legacy.text().indexOf('rosparam set /x 1') >= 0);
    ok('legacy card still says what the command does',
        legacy.text().indexOf('nastaví parametr') >= 0);
    ok('legacy card has no executor buttons',
        legacy.querySelectorAll().filter(b => cls(b).indexOf('aeb') >= 0)
            .length === 0);
    legacy.querySelectorAll().find(b => b._text === 'Approve').handlers.click();
    ok('legacy approve posts no executor field', posted.length === 1 &&
        !('executor' in posted[0]));
    await sleep(5);

    // ---- 9. outcome banner, then the empty state -------------------------
    w.renderApprovals([]);
    ok('decision outcome banner shows first',
        gate.text().indexOf('✓') >= 0);
    Object.keys(w.askOutcomes).forEach(k => { w.askOutcomes[k].until = 0; });
    w.renderApprovals([]);
    ok('empty state text kept',
        gate.children[0]._text.indexOf('Nothing waiting') >= 0);

    console.log(fails ? fails + ' FAILURE(S)' : 'all ask-card checks passed');
    process.exit(fails ? 1 : 0);
}

main();
