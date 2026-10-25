#!/usr/bin/env node
/*
 * The field's ask cards in the robot UI (vt_field_view.js VTField.ask; kit 0.9.52
 * tools/_asks.py, the dashboard's askCardHtml).
 *
 *     node tools/test_field_asks.node.js
 *
 * Data: tools/fixtures_field_asks.json — invented items built by the kit's own
 * code (decide with a motion option, steps, approve of a finding, approve of a
 * release with its change list). A stub DOM is enough: the module only builds
 * elements. Checked:
 *   - one anatomy for all three types: type label · title · Why you · body ·
 *     What happens next (+ the technical fold);
 *   - decide: recommended option first; an option with motion is NEVER a
 *     button; two clicks send /field/act/pick with the option's idx, pid, sha;
 *     writes off -> the options link to the dashboard's card;
 *   - approve: a watcher approval / release stays on the dashboard ("Approve or
 *     reject in Support", the change list shown); a finding is decided here
 *     (/field/act/finding-accept);
 *   - steps: one step at a time, Done moves on, the last Done is the item's own
 *     step-done (/field/act/done), "Does not work" opens the dashboard's card;
 *   - "talk it over" goes through /field/act/ask only when the webnode found the
 *     door (ui.actions.ask === true), else it is a link — never a button that
 *     can only fail.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_field_asks.json'), 'utf8'));

let fails = 0;
function ok(cond, what) {
    console.log((cond ? 'ok   ' : 'FAIL ') + what);
    if (!cond) { fails++; }
}

/* ---- a stub DOM: just what the module uses */
class Node {
    constructor(tag) {
        this.tagName = String(tag || '').toUpperCase(); this.childNodes = []; this.parentNode = null;
        this.attrs = {}; this.dataset = {}; this.handlers = {}; this.hidden = false; this.disabled = false;
        this.open = false; this.style = {}; this.className = ''; this._text = null;
        const self = this;
        this.classList = {
            add(...c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); self.className = [...s].join(' '); },
            remove(...c) { self.className = self.className.split(/\s+/).filter(x => x && c.indexOf(x) < 0).join(' '); },
            contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
            toggle(c, on) { if (on === undefined ? !this.contains(c) : on) { this.add(c); } else { this.remove(c); } }
        };
    }
    get children() { return this.childNodes.filter(n => n.tagName !== '#TEXT'); }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(n) { if (n.parentNode) { n.parentNode.removeChild(n); } n.parentNode = this; this.childNodes.push(n); return n; }
    insertBefore(n, ref) {
        if (n.parentNode) { n.parentNode.removeChild(n); }
        const i = ref ? this.childNodes.indexOf(ref) : -1;
        n.parentNode = this;
        if (i < 0) { this.childNodes.push(n); } else { this.childNodes.splice(i, 0, n); }
        return n;
    }
    removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); } n.parentNode = null; return n; }
    get textContent() { return this._text !== null ? this._text : this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this._text = null; if (v !== '' && v !== null && v !== undefined) { const t = new Node('#text'); t._text = String(v); t.parentNode = this; this.childNodes.push(t); } }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    click() { if (this.disabled) { return; } (this.handlers.click || []).forEach(fn => fn({ preventDefault() {} })); }
    all(test) { const out = []; const walk = n => { n.children.forEach(c => { if (test(c)) { out.push(c); } walk(c); }); }; walk(this); return out; }
    byClass(c) { return this.all(n => n.classList.contains(c)); }
}
const document = {
    createElement: tag => new Node(tag),
    createTextNode: s => { const t = new Node('#text'); t._text = String(s); return t; }
};
const store = {};
const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
const EN = (function () {
    const win = {};
    new Function('window', fs.readFileSync(path.join(JS, 'i18n', 'en.js'), 'utf8'))(win);
    return win.VT_I18N_DICT.en;
})();
const hub = {};
const sent = [];
const timers = [];
const window = {
    VTI18n: { t: (k, v) => String(k in EN ? EN[k] : k).replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? String(v[n]) : m)),
              lang: () => 'en' },
    VTHub: { get: k => hub[k] || null, refresh() {} }
};
function fetch(url, init) {
    sent.push({ url: url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
}
const location = { hostname: 'robot.local' };
new Function('window', 'VTI18n', 'VTHub', 'document', 'localStorage', 'fetch', 'location', 'setTimeout', 'clearTimeout',
    fs.readFileSync(path.join(JS, 'vt_field_view.js'), 'utf8'))(
    window, window.VTI18n, window.VTHub, document, localStorage, fetch, location,
    (fn) => { timers.push(fn); return timers.length; }, () => {});
window.VTI18n.tn = (k, n, v) => window.VTI18n.t(k + '.' + (n === 1 ? 'one' : 'other'), Object.assign({ n: n }, v || {}));
const F = window.VTField;
ok(F && typeof F.ask === 'function', 'VTField.ask exists');

/* the session: writes on, a name on this device, the attention items the cards bind to */
store.vitulus_ui_author = 'Robert';
hub['field.attention'] = { ok: true, data: FX.attention };
function setDoor(writes, ask) { hub['ui.actions'] = { ok: true, data: { ok: true, writes: writes, ask: ask, actions: [] } }; }
const items = FX.todo.mine.items;
const byType = t => items.filter(x => x.ask && x.ask.type === t);
const txt = n => n.textContent;

/* ---------------------------------------------------------------- anatomy */
setDoor(true, false);
items.forEach(it => {
    const c = F.ask(it, { onIssue() {} });
    const kids = c.children.map(k => k.className.split(' ')[0]);
    const order = ['vt-ask-h', 'vt-ask-title', 'vt-ask-why', 'vt-ask-body', 'vt-ask-next'];
    const idx = order.map(k => kids.indexOf(k));
    ok(idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), it.ask.type + ': type · title · why · body · next in order (' + it.ask.title.slice(0, 30) + ')');
    ok(txt(c.byClass('vt-ask-type')[0]) === EN['fv.ask.t.' + it.ask.type], it.ask.type + ': the type label');
    ok(c.getAttribute('data-state') === 'warn', it.ask.type + ': amber, no left stripe class');
});

/* ---------------------------------------------------------------- decide */
const dec = byType('decide')[0];
let c = F.ask(dec, {});
const opts = c.byClass('vt-ask-opts')[0].children;
ok(opts[0].classList.contains('vt-decide-rec') && /recommended/.test(txt(opts[0])), 'decide: the recommended option first and filled');
const mot = opts.filter(o => o.classList.contains('vt-ask-opt-motion'));
ok(mot.length === 1 && mot[0].tagName === 'DIV', 'decide: the option with motion is a box, not a button');
ok(mot[0].byClass('vt-ask-msteps').length === 1, 'decide: the motion option shows its steps');
ok(opts.filter(o => o.tagName === 'BUTTON').length === 2, 'decide: two option buttons (no motion)');
const second = opts.filter(o => o.tagName === 'BUTTON')[1];
second.click();
ok(/^Sure\?/.test(txt(second)) && sent.length === 0, 'decide: first click arms ("Sure? …"), nothing sent');
second.click();
const pickOpt = dec.ask.decide.options.filter(o => !o.rec && !o.motion)[0];
ok(sent.length === 1 && sent[0].url === '/field/act/pick' && sent[0].body.opt === pickOpt.idx &&
   sent[0].body.pid === dec.ask.decide.pick.pid && sent[0].body.sha === dec.ask.decide.pick.sha,
   'decide: second click sends pick with the option idx, pid and sha');
ok(sent[0].body.author === 'Robert' && sent[0].body.shown === FX.attention.items.filter(i => i.id === dec.key)[0].plain.headline,
   'decide: signed, bound to the headline the dashboard shows');
ok(second.byClass('vt-ask-ol').length === 1, 'decide: the button gets its label + text back after the click');
const disc = c.byClass('vt-ask-discuss')[0].children[0];
ok(disc.tagName === 'A' && /:8790\/#\/issue\/63$/.test(disc.href), 'decide: no ask door -> "talk it over" is a link to the issue');
setDoor(true, true);
c = F.ask(dec, {});
const disc2 = c.byClass('vt-ask-discuss')[0].children[0];
ok(disc2.tagName === 'BUTTON', 'decide: ask door found -> "talk it over" is a button');
sent.length = 0; disc2.click(); disc2.click();
ok(sent.length === 1 && sent[0].url === '/field/act/ask' && sent[0].body.thread === '63' && sent[0].body.text === dec.discuss,
   'decide: it sends exactly the sentence the field prepared, into the issue thread');
setDoor(false, false);
c = F.ask(dec, {});
const lnk = c.byClass('vt-ask-opts')[0].children.filter(o => !o.classList.contains('vt-ask-opt-motion'));
ok(lnk.every(o => o.tagName === 'A' && /:8790\/#\/issue\/63$/.test(o.href)), 'decide: writes off -> the options open the dashboard card');

/* ---------------------------------------------------------------- approve */
setDoor(true, false);
const rel = byType('approve').filter(x => x.ask.kind === 'approve')[0];
c = F.ask(rel, {});
const relActs = c.byClass('vt-fv-acts')[0].children;
ok(relActs.length === 1 && relActs[0].tagName === 'A' && txt(relActs[0]) === EN['fv.ask.approve_in_support'] && /#\/attention$/.test(relActs[0].href),
   'approve (release): only "Approve or reject in Support", to the dashboard card');
ok(c.byClass('vt-ask-changes').length === 1 && c.byClass('vt-ask-clines')[0].children.length >= 4, 'approve (release): the change list, commit by commit');
ok(/13/.test(txt(c.byClass('vt-ask-q')[0])), 'approve (release): what exactly you approve (13 changes)');
const fnd = byType('approve').filter(x => x.ask.kind === 'finding')[0];
c = F.ask(fnd, {});
const fa = c.byClass('vt-fv-acts')[0].children;
ok(fa.length === 2 && fa.every(b => b.tagName === 'BUTTON'), 'approve (finding): both buttons here (the robot UI may write them)');
sent.length = 0; fa[0].click(); fa[0].click();
ok(sent.length === 1 && sent[0].url === '/field/act/finding-accept' && sent[0].body.id === 'a1b2c3d4e5f6', 'approve (finding): accept sends the finding id');

/* ---------------------------------------------------------------- steps */
const st = byType('steps')[0];
delete store['vitulus_ask_step.' + st.ask.id];
c = F.ask(st, {});
const lis = c.byClass('vt-ask-steps')[0].children;
ok(lis.length === 2 && !lis[0].hidden && lis[1].hidden, 'steps: one step at a time');
const done1 = lis[0].byClass('vt-fv-go')[0];
done1.click();
ok(lis[0].hidden && !lis[1].hidden && store['vitulus_ask_step.' + st.ask.id] === '1', 'steps: Done shows the next step (remembered)');
const lastBtn = lis[1].children.filter(k => k.className.indexOf('vt-fv-acts') >= 0)[0].children[0];
sent.length = 0; lastBtn.click(); lastBtn.click();
ok(sent.length === 1 && sent[0].url === '/field/act/done' && sent[0].body.step === 'hs-0123456789ab', "steps: the last Done is the item's own step-done");
const fail = lis[1].byClass('vt-ask-fail')[0];
ok(fail && fail.tagName === 'A' && /#\/issue\/8$/.test(fail.href), 'steps: "Does not work" opens the dashboard card of #8');
ok(lis[1].byClass('vt-ask-back').length === 1, 'steps: Back on the second step');

/* ---------------------------------------------------------------- ui-doors */
function setDoors(ask, approve) { hub['ui.actions'] = { ok: true, data: { ok: true, writes: true, ask: ask, approve: approve, actions: [] } }; }
setDoors(true, true);
c = F.ask(rel, {});
let ra = c.byClass('vt-fv-acts')[0].children;
ok(ra.length === 2 && ra.every(b => b.tagName === 'BUTTON') && txt(ra[0]) === 'Approve' && txt(ra[1]) === 'Reject',
   'approve door: the release card has Approve + Reject here, no detour to Support');
const relAct = rel.ask.approve.actions.filter(x => x.kind === 'approve')[0];
sent.length = 0; ra[0].click(); ra[0].click();
ok(sent.length === 1 && sent[0].url === '/field/act/approve' && sent[0].body.id === relAct.id && sent[0].body.prompt_sha256 === relAct.sha,
   'approve door: two clicks send the action id and the prompt sha of THIS card');
ok(sent[0].body.shown === FX.attention.items.filter(i => i.id === rel.key)[0].title, 'approve door: bound to the title the dashboard shows');
sent.length = 0; ra[1].click(); ra[1].click();
ok(sent.length === 1 && sent[0].url === '/field/act/dismiss' && JSON.stringify(Object.keys(sent[0].body).sort()) === '["author","id","shown"]',
   'approve door: Reject sends only the id');
const relMove = JSON.parse(JSON.stringify(rel)); relMove.ask.motion = true;
ra = F.ask(relMove, {}).byClass('vt-fv-acts')[0].children;
ok(ra.length === 1 && ra[0].tagName === 'A', 'approve door: an action with robot motion stays on the dashboard');
setDoors(true, false);
ra = F.ask(rel, {}).byClass('vt-fv-acts')[0].children;
ok(ra.length === 1 && ra[0].tagName === 'A', 'approve door missing (older kit): the link to the card, as before');
setDoors(true, true);
delete store['vitulus_ask_step.' + st.ask.id];
c = F.ask(st, {});
const nf = c.byClass('vt-ask-fail')[0];
ok(nf.tagName === 'BUTTON', '"Does not work": a button when the ask door is there');
sent.length = 0; nf.click(); nf.click();
ok(sent.length === 1 && sent[0].url === '/field/act/ask' && sent[0].body.thread === String(st.ask.thread) &&
   sent[0].body.text === st.ask.steps.steps[0].fail, '"Does not work": sends the step\'s own prepared sentence to the agent');
setDoors(false, false);
ok(F.ask(st, {}).byClass('vt-ask-fail')[0].tagName === 'A', '"Does not work": a link to the dashboard without the door');
/* the viewer's language */
window.VTI18n.lang = () => 'cs';
ok(F.inLang({ x: 'en' }, { cs: { x: 'cs' } }).x === 'cs' && F.inLang({ x: 'en' }, null).x === 'en', 'language: the alt text for the viewer, else the base');
ok(F.askOf({ ask: { title: 'A' }, ask_alt: { cs: { title: 'Á' } } }).title === 'Á', 'language: an attention item\'s ask in the viewer\'s language');
window.VTI18n.lang = () => 'en';

/* ---------------------------------------------------------------- home: warnings, agents, the sentence */
const H0 = { stav: [{ login: 'lacina-dev', me: true, name: 'Robert', tone: 'ok', say: 'Robot runs.' },
                    { login: 'maciii', name: 'Mac', tone: 'ok', say: 'Has the newest release.' }],
             turn: { counts: { agent: 1, field: 1, verify: 7, them: 1 }, who: { '61': 'agent', '63': 'you' }, names: { them: 'Mac' } },
             todo: { names: { peer: 'Mac' } },
             issues: { us: [{ number: 61, title: '[report] Lidar drops after start', status_text: 'agent prepares a fix' }, { number: 63, title: 'Keyboard' }] },
             velin: { sides: [{ login: 'lacina-dev', me: true, state: 'ok' }, { login: 'maciii', state: 'waiting' }] },
             gh_access: { level: 'ok' }, fleet: { self: { banner: null } }, blocks: [] };
ok(F.alerts(H0, { state: 'idle', level: 'info', signal: { state: 'connected' } }).length === 0, 'home: all fine -> no warning (nothing counted)');
const H1 = JSON.parse(JSON.stringify(H0));
H1.gh_access = { level: 'warn', title: 'Token expires', line: 'Renew it.', url: 'https://github.com/settings/personal-access-tokens' };
H1.velin.sides[1].state = 'stale';
H1.fleet.self.banner = 'This robot is behind';
const al = F.alerts(H1, { state: 'off', level: 'info', signal: { state: 'off' } });
ok(al.map(a => a.key).join(',') === 'gh,watch,signal,side-maciii,fleet', 'home: the field bubble\'s warnings (GitHub, field off, Signal off, other side silent, behind)');
ok(al.filter(a => a.tone === 'bad').map(a => a.key).join(',') === 'watch', 'home: field not running is the red one');
ok(al[0].href === 'https://github.com/settings/personal-access-tokens' && /Mac is silent/.test(al[3].title), 'home: GitHub link only to the token settings; the side by its name');
const evil = JSON.parse(JSON.stringify(H1)); evil.gh_access.url = 'https://evil.example/';
ok(/:8790\/#\/trust$/.test(F.alerts(evil, null)[0].href), 'home: a foreign URL never becomes a link (the dashboard instead)');
const rows = F.agentRows(Object.assign({}, H0, { blocks: [{ id: 'b1', blocked: true, kind: 'restart-stack' }] }),
    { busy: [{ slot: 'tick' }, { slot: 'run', issue: 61, text: 'fixes #61', started: new Date().toISOString() }],
      agents: { others: [{ login: 'maciii', text: 'verifies #56 · step 2/3', issue: 56 }, { login: 'maciii', agent: false, text: 'kit step' }] } });
ok(rows.map(r => r.k.split('-')[0]).join(',') === 'b,w,o,pv' && rows[0].n === 61,
   'agents: run (no tick), the watcher\'s wait, the other side\'s agent (not a kit step), Mac verifying; #61 not twice');
ok(rows[2].text === 'verifies #56' && rows[3].text === 'tests 7 fixes at the robot', 'agents: the peer row is one short line');
const hero = F.hero(H0, 5, false);
ok(/^5 things wait for you\./.test(txt(hero.byClass('vt-fv-hsay')[0])) && hero.getAttribute('data-state') === 'warn', 'hero: "5 things wait for you." amber');
ok(/The agents handle 2 things themselves, Mac tests 7 fixes and has 1 thing more on the move\./.test(txt(hero.byClass('vt-fv-hbusy')[0])), 'hero: what the agents and the other side do');
ok(F.hero(H0, 0, false).getAttribute('data-state') === 'ok' && /Nothing is needed/.test(txt(F.hero(H0, 0, false))), 'hero: nothing -> green, "Nothing is needed from you."');
ok(hero.byClass('vt-fv-hside').length === 2 && hero.byClass('vt-fv-htech').length === 0, 'hero: one line per side; no facts -> no fold');

/* ---------------------------------------------------------------- issue detail */
const HI = { title: 'Keyboard drive stalls on Mac', origin: { who: { k: 'peer', t: 'Mac' }, when: '13:43', refs: [] },
             now: { text: 'Driving with the keyboard still stalls.', phase: 'Fix released', who: { k: 'peer', t: 'Mac' }, closed: false },
             phases: [{ name: 'Reported', state: 'done' }, { name: 'Fix released', state: 'now' }], boxes: {}, log: [],
             asks: [dec.ask, Object.assign({}, dec.ask, { id: 'x', agent_work: 'git' })] };
const art = F.issue(HI, 63, () => {});
const nowB = art.byClass('vt-fv-now')[0];
ok(nowB && /Driving with the keyboard still stalls/.test(txt(nowB)) && /Whose move:/.test(txt(nowB)) && /Fix released/.test(txt(nowB)),
   'issue: where it stands in one sentence, the phase and whose move');
ok(art.byClass('vt-ask').length === 1, 'issue: the ask card of the issue (an "agent is on it" ask is not a card)');
const kidsI = art.children.map(k => k.className.split(' ')[0]);
ok(kidsI.indexOf('vt-fv-phases') < kidsI.indexOf('vt-card'), 'issue: the card right after the phases');
ok(/Closed/.test(txt(F.issue(Object.assign({}, HI, { asks: [], now: { text: 'Done.', closed: true } }), 63).byClass('vt-fv-now')[0])), 'issue: closed says so');

/* ---------------------------------------------------------------- texts */
['fv.ask.t.decide', 'fv.ask.t.approve', 'fv.ask.t.steps', 'fv.ask.why', 'fv.ask.next', 'fv.ask.approve_in_support'].forEach(k => {
    ok(k in EN, 'en: ' + k);
});

if (fails) { console.log('\n' + fails + ' check(s) FAILED'); process.exit(1); }
console.log('\nall field ask checks passed');
