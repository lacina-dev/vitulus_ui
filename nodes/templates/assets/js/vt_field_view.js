/* vt_field_view.js — the field kit's own language inside the robot UI
 * (Robert 2026-10-25: "jasně, přehledně, stručně; má to pomáhat, ne zdržovat").
 *
 * Draws what the field dashboard composes for PEOPLE (vitulus-field
 * tools/_overview.py, kit 0.9.43+) — the texts come from the server, this
 * file only lays them out in the robot UI's card anatomy (vt_field.css):
 *
 *   VTField.state(stav)          "How we stand": one row per side — dot, who,
 *                                ONE sentence, the key facts       (/api/home stav)
 *   VTField.task(it, opts)       one thing a person has to do     (/api/home todo)
 *                                · a decision: the agent's variants, the
 *                                  recommended one chosen; "Confirm: …" and
 *                                  "None fits, talk it over with the agent"
 *                                · a step: "Start by telling your agent: „…“"
 *                                  and "Start with the agent"; Done / Hide
 *   VTField.lane(L, mine, names) a column of tasks + its calm notes
 *   VTField.issue(h, n)          the human block of an issue      (/api/issue human)
 *                                origin, phases with who / when, Problem /
 *                                Cause / Fix, What to do, Who did what
 *
 * Writes go ONLY through the webnode door /field/act/<action> (kit 0.9.38 +
 * "ask" 0.9.52): the webnode gets a single-use token from the dashboard bound
 * to this card and the text shown here; two clicks (arm, then send within
 * 5 s); every write is signed with the name from this device. A choice that
 * would move the robot is never offered here.
 */
(function () {
    'use strict';
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    var THREAD_RE = /^(general|[1-9][0-9]{0,5})$/;
    var HASH_RE = /^#\/[A-Za-z0-9/_.:-]*$/;
    function dash(link) {
        var l = (typeof link === 'string' && HASH_RE.test(link)) ? link : '#/';
        return 'https://' + location.hostname + ':8790/' + l;
    }
    function linkBtn(label, href, cls) {
        var b = el('a', 'btn btn-outline-info vt-needs-btn ' + (cls || ''), label);
        b.href = href; b.target = '_blank'; b.rel = 'noopener';
        return b;
    }
    function btn(label, fn, cls, title) {
        var b = el('button', 'btn btn-outline-info vt-needs-btn ' + (cls || ''), label);
        b.type = 'button';
        if (title) { b.title = title; }
        b.addEventListener('click', function (e) { e.preventDefault(); fn(b); });
        return b;
    }

    /* ------------------------------------------------------------ who */
    var role = 'owner';                      // this side's role (todo.role / home.role)
    function setRole(r) { if (r === 'owner' || r === 'tester') { role = r; } }
    function other(r) { return r === 'owner' ? 'tester' : 'owner'; }
    /* a server tag {k, t} as a small label: orange = the owner's side, cyan =
       the tester's side, lavender = an agent, grey = field / the watcher */
    function tag(w, small) {
        if (!w || !w.t) { return null; }
        var side = w.k === 'you' ? role : (w.k === 'peer' ? other(role) : null);
        var c = w.k === 'agent' ? 'agent' : (w.k === 'field' || w.k === 'watch') ? 'field' :
            (side === 'tester' ? 'test' : 'own');
        return el('span', 'vt-fv-tag vt-fv-t-' + c + (small ? ' vt-fv-sm' : ''), w.t);
    }

    /* ---------------------------------------------------------- writes */
    var LS_UI_AUTHOR = 'vitulus_ui_author';
    function author() {
        var a = lsGet('vitulus_agent_author') || lsGet(LS_UI_AUTHOR) || '';
        return String(a).replace(/^"|"$/g, '').trim().slice(0, 60);
    }
    function writesOn() {
        var e = window.VTHub && VTHub.get('ui.actions');
        return !!(e && e.data && e.data.writes);
    }
    /* the text the dashboard shows on the card (its sha binds the token):
       the headline of the attention item */
    function attItems() {
        var e = window.VTHub && VTHub.get('field.attention');
        return (e && e.data && e.data.items) || [];
    }
    function headline(i) {
        var p = (i && i.plain) || {};
        return String(p.headline || (i && i.title) || '');
    }
    function shownById(id) {
        var hit = attItems().filter(function (i) { return i.id === id; })[0];
        return hit ? headline(hit) : '';
    }
    /* the first card the dashboard finds for an action (tools/vitulus-dash ui_card) */
    function shownByAct(test) {
        var hit = attItems().filter(function (i) {
            return (i.actions || []).some(function (a) { return a && test(a); });
        })[0];
        return hit ? headline(hit) : '';
    }
    function shownByPid(pid) {
        var hit = attItems().filter(function (i) { return i.plain && i.plain.pid === pid; })[0];
        return hit ? headline(hit) : '';
    }
    var done = {};                           // key -> {ts, msg}: sent from here, waiting for fresh data
    var DONE_MS = 5 * 60000;
    function isDone(key) {
        var d = done[key];
        if (d && Date.now() - d.ts < DONE_MS) { return d; }
        delete done[key];
        return null;
    }
    function send(action, payload, shown, box, msgEl, key) {
        var who = author();
        if (!who) {
            msgEl.setAttribute('data-state', 'warn');
            msgEl.textContent = t('needs.sign_first');
            return;
        }
        msgEl.removeAttribute('data-state');
        msgEl.textContent = t('needs.sending');
        fetch('/field/act/' + action, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Vitulus-UI': '1' },
            body: JSON.stringify(Object.assign({ author: who, shown: shown }, payload))
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) { return [r.ok, j]; });
        }).then(function (res) {
            var ok = res[0] && res[1].ok !== false;
            msgEl.setAttribute('data-state', ok ? 'ok' : 'err');
            var m = ok ? (action === 'ask' ? t('fv.sent_agent') : (res[1].message ? t('needs.sent.msg', { msg: res[1].message }) : t('needs.sent'))) :
                t('needs.not_done', { err: res[1].error || res[1].message || t('needs.err') });
            msgEl.textContent = m;
            if (ok) {
                if (key) { done[key] = { ts: Date.now(), msg: m }; }
                if (box) { box.classList.add('vt-needs-done'); }
                if (window.VTHub) {
                    ['field.attention', 'field.home', 'ui.actions'].forEach(function (k) { VTHub.refresh(k); });
                }
            }
        }, function (e) {
            msgEl.setAttribute('data-state', 'err');
            msgEl.textContent = t('needs.not_done', { err: e && e.message || e });
        });
    }
    /* two clicks: the first arms ("Sure? …"), the second sends within 5 s */
    function armButton(label, cls, onSend, title) {
        var b = el('button', 'btn vt-needs-btn vt-decide-btn ' + (cls || ''), label);
        b.type = 'button';
        if (title) { b.title = title; }
        var timer = null;
        /* a button with rich content (an option: label + what happens) gets its
           children back after "Sure? …" (b._rich = the nodes) */
        function restore() {
            if (b._rich) { b.textContent = ''; b._rich.forEach(function (k) { b.appendChild(k); }); }
            else { b.textContent = b.dataset.label || label; }
        }
        b.addEventListener('click', function () {
            if (!b.classList.contains('vt-armed')) {
                b.classList.add('vt-armed');
                b.textContent = t('needs.sure', { label: b.dataset.label || label });
                timer = setTimeout(function () { b.classList.remove('vt-armed'); restore(); }, 5000);
                return;
            }
            clearTimeout(timer);
            b.classList.remove('vt-armed');
            restore();
            b.disabled = true;
            onSend();
            setTimeout(function () { b.disabled = false; }, 3000);
        });
        return b;
    }
    /* "Start with the agent" / "talk it over": the prepared sentence goes
       into the issue's thread on the field and the agent takes it from there.
       A thread that is not an issue (an item thread) opens on the dashboard.
       Whether the dashboard takes it from the robot UI is not a version
       number (the door came in on a side branch of kit 0.9.52, main's 0.9.52
       has no door): the webnode asks the dashboard once in a while with a
       request it refuses either way and reports `ask` in /field/ui_actions. */
    function askOn() {
        var e = window.VTHub && VTHub.get('ui.actions');
        return !!(e && e.data && e.data.ask === true);
    }
    function askButton(thread, text, label, primary, box, msgEl, key, link) {
        if (!text) { return null; }
        if (!THREAD_RE.test(String(thread || '')) || !writesOn() || !askOn()) {
            return linkBtn(label, dash(link || (THREAD_RE.test(String(thread || '')) ? '#/issue/' + thread : '#/')),
                primary ? 'vt-fv-go' : '');
        }
        return armButton(label, primary ? 'vt-decide-rec' : '', function () {
            send('ask', { thread: String(thread), text: text }, text, box, msgEl, key);
        }, t('fv.ask.tip', { text: text }));
    }

    /* ------------------------------------------------------- state */
    function state(stav) {
        var sec = el('section', 'vt-fv-sec vt-fv-state');
        sec.appendChild(el('h3', 'vt-fv-h', t('fv.state')));
        if (!stav || !stav.length) {
            sec.appendChild(el('p', 'vt-empty', t('fv.state.none')));
            return sec;
        }
        stav.forEach(function (c) {
            if (c.role) { if (c.me) { setRole(c.role); } }
            var tone = { ok: 'ok', warn: 'warn', bad: 'err' }[c.tone] || 'off';
            var row = el('div', 'vt-fv-side');
            row.setAttribute('data-state', tone);
            var head = el('div', 'vt-fv-shead');
            head.appendChild(el('span', 'vt-sdot'));
            var tg = tag({ k: c.me ? 'you' : 'peer', t: c.me ? t('fv.you') : (c.name || c.login) });
            if (tg) { head.appendChild(tg); }
            head.appendChild(el('span', 'vt-fv-say', c.say || ''));
            row.appendChild(head);
            var facts = (c.facts || []).filter(function (f) { return f && f.v; });
            if (facts.length || (c.news || []).length) {
                var fx = el('div', 'vt-fv-facts');
                facts.forEach(function (f) {
                    var s = el('span', null, f.k + ' ');
                    var b = el('b', f.tone === 'warn' ? 'vt-fv-warn' : null, f.v);
                    s.appendChild(b);
                    fx.appendChild(s);
                });
                if ((c.news || []).length) {
                    var s = el('span', null, t('fv.news') + ' ');
                    s.appendChild(el('b', null, c.news.map(function (x) { return x.title + ' (#' + Number(x.n) + ')'; }).join(', ')));
                    fx.appendChild(s);
                }
                row.appendChild(fx);
            }
            sec.appendChild(row);
        });
        return sec;
    }

    /* -------------------------------------------------------- tasks */
    var picked = {};                         // key -> chosen variant (survives a re-render)
    function variants(it, box, msgEl) {
        var wrap = el('div', 'vt-fv-decide');
        var fs = el('fieldset', 'vt-fv-opts');
        fs.appendChild(el('legend', 'vt-fv-lead', it.question || t('fv.variants')));
        var opts = it.options || [];
        var sel = picked[it.key];
        if (sel === undefined) {
            var r = opts.filter(function (o) { return o.rec && !o.motion; })[0] || opts.filter(function (o) { return !o.motion; })[0];
            sel = r ? r.idx : null;
        }
        var name = 'vt-fv-o-' + String(it.key).replace(/[^\w-]/g, '_');
        var pick = it.pick || {};
        var canPick = writesOn() && pick.pid && /^[0-9a-f]{6,64}$/.test(pick.sha || '');
        var confirm = null;
        function label(o) { return t('fv.confirm', { label: o.label }); }
        opts.forEach(function (o) {
            var lab = el('label', 'vt-fv-opt');
            var inp = el('input');
            inp.type = 'radio'; inp.name = name; inp.value = String(o.idx);
            inp.checked = Number(o.idx) === Number(sel);
            inp.disabled = !!o.motion;
            inp.addEventListener('change', function () {
                picked[it.key] = Number(o.idx);
                if (confirm) {
                    confirm.dataset.label = label(o);
                    confirm.dataset.opt = String(o.idx);
                    confirm.classList.remove('vt-armed');
                    confirm.textContent = label(o);
                }
            });
            lab.appendChild(inp);
            var tx = el('span', 'vt-fv-otx');
            var ot = el('span', 'vt-fv-ot', o.label || '');
            if (o.rec) { ot.appendChild(el('span', 'vt-fv-rec', t('fv.rec'))); }
            if (o.motion) { ot.appendChild(el('span', 'vt-fv-motion', t('fv.motion'))); }
            tx.appendChild(ot);
            if (o.desc) { tx.appendChild(el('span', 'vt-fv-od', o.desc)); }
            lab.appendChild(tx);
            fs.appendChild(lab);
        });
        wrap.appendChild(fs);
        var acts = el('div', 'vt-needs-acts vt-fv-acts');
        var cur = opts.filter(function (o) { return Number(o.idx) === Number(sel); })[0];
        if (cur && canPick) {
            confirm = armButton(label(cur), 'vt-decide-rec', function () {
                send('pick', { pid: pick.pid, opt: Number(confirm.dataset.opt), sha: pick.sha },
                    shownByPid(pick.pid), box, msgEl, it.key);
            }, t('fv.confirm.tip'));
            confirm.dataset.label = label(cur);
            confirm.dataset.opt = String(cur.idx);
            acts.appendChild(confirm);
        } else if (cur) {
            acts.appendChild(linkBtn(t('fv.decide_in_support'), dash(it.link), 'vt-fv-go'));
        }
        var d = askButton(it.thread || it.issue || 'general', it.discuss, t('fv.discuss'), false, box, msgEl, it.key, it.link);
        if (d) { acts.appendChild(d); }
        wrap.appendChild(acts);
        return wrap;
    }
    function itemActions(it, box, msgEl, acts) {
        (it.actions || []).forEach(function (a) {
            if (!a || !a.kind) { return; }
            if (a.kind === 'step-done' && a.step && writesOn()) {
                acts.appendChild(armButton(a.label && a.label !== 'Hotovo' ? a.label : t('common.done'), '', function () {
                    send('done', { step: a.step, issue: a.issue ? Number(a.issue) : null },
                        shownById('human-step:' + a.step) || shownByAct(function (x) { return x.kind === 'step-done' && x.step === a.step; }),
                        box, msgEl, it.key);
                }, t('fv.done.tip')));
            } else if (a.kind === 'remind' && a.issue && writesOn()) {
                acts.appendChild(armButton(t('needs.remind'), '', function () {
                    send('remind', { issue: Number(a.issue) },
                        shownByAct(function (x) { return x.kind === 'remind' && String(x.issue) === String(a.issue); }), box, msgEl, it.key);
                }, t('needs.remind.tip')));
            } else if ((a.kind === 'finding-accept' || a.kind === 'finding-dismiss') && a.fid && writesOn()) {
                var acc = a.kind === 'finding-accept';
                acts.appendChild(armButton(acc ? t('needs.accept') : t('needs.dismiss'), '', function () {
                    send(a.kind, { id: a.fid },
                        shownByAct(function (x) { return (x.kind === 'finding-accept' || x.kind === 'finding-dismiss') && x.fid === a.fid; }), box, msgEl, it.key);
                }));
            } else if (a.kind === 'snooze' && a.aid && writesOn()) {
                acts.appendChild(armButton(t('needs.hide24'), '', function () {
                    send('snooze', { id: a.aid },
                        shownByAct(function (x) { return x.kind === 'snooze' && x.aid === a.aid; }), box, msgEl, it.key);
                }));
            } else if (a.kind === 'approve') {
                /* approving a watcher action stays on the dashboard (its guards) */
                acts.appendChild(linkBtn(t('fv.approve_in_support'), dash(it.link)));
            }
        });
    }
    /* opts: {mine, onIssue(n)} */
    function task(it, opts) {
        opts = opts || {};
        var mine = !!opts.mine;
        var box = el('div', 'vt-card vt-fv-task');
        box.setAttribute('data-state', mine ? (it.urgent ? 'err' : 'warn') : 'off');
        box.dataset.key = it.key || '';
        var head = el('div', 'vt-card-head');
        var title = el('span', 'vt-card-title', it.title || '');
        if (it.issue) { title.appendChild(el('span', 'vt-fv-n', '#' + Number(it.issue))); }
        head.appendChild(title);
        box.appendChild(head);
        if (it.sub) { box.appendChild(el('div', 'vt-fv-sub', it.sub)); }
        if (it.why) { box.appendChild(el('p', 'vt-fv-why', it.why)); }
        var from = el('div', 'vt-fv-from');
        (it.from || []).forEach(function (x) {
            var s = el('span', null, (x.what === 'reported' ? t('fv.reported') : x.what === 'prepared' ? t('fv.prepared') : '') + ' ');
            var tg = tag(x, true);
            if (tg) { s.appendChild(tg); }
            from.appendChild(s);
        });
        if (it.waits) {
            var w = el('span', null, t('fv.waits') + ' ');
            var tg2 = tag(it.waits, true);
            if (tg2) { w.appendChild(tg2); }
            if (it.since_text) { w.appendChild(document.createTextNode(' ' + t('fv.since', { when: it.since_text }))); }
            from.appendChild(w);
        }
        if (from.children.length) { box.appendChild(from); }
        var msg = el('div', 'vt-decide-msg');
        msg.setAttribute('aria-live', 'polite');
        var dn = isDone(it.key);
        if (dn) {
            box.classList.add('vt-needs-done');
            msg.setAttribute('data-state', 'ok');
            msg.textContent = dn.msg;
            box.appendChild(msg);
            return box;
        }
        var acts = el('div', 'vt-needs-acts vt-fv-acts');
        if (it.kind === 'decide' && mine && (it.options || []).length) {
            box.appendChild(variants(it, box, msg));
        } else {
            if (it.say) {
                var sa = el('div', 'vt-fv-say-agent', mine ? t('fv.say_you') : t('fv.say'));
                sa.appendChild(document.createTextNode(' '));
                sa.appendChild(el('q', null, it.say));
                box.appendChild(sa);
                if (mine) {
                    var st = askButton(it.thread || it.issue || 'general', it.say, t('fv.start'), true, box, msg, it.key, it.link);
                    if (st) { acts.appendChild(st); }
                }
            }
            if (mine) { itemActions(it, box, msg, acts); }
        }
        if (it.issue && opts.onIssue) {
            acts.appendChild(btn(t('fv.detail'), function () { opts.onIssue(Number(it.issue)); }));
        } else if (it.link && !(it.kind === 'decide' && mine) &&
                   !(mine && (it.actions || []).some(function (x) { return x && x.kind === 'approve'; }))) {
            acts.appendChild(linkBtn(t('fv.detail_support'), dash(it.link)));
        }
        if (acts.children.length) { box.appendChild(acts); }
        box.appendChild(msg);
        return box;
    }
    function notes(list, onIssue) {
        if (!list || !list.length) { return null; }
        var w = el('div', 'vt-fv-notes');
        list.forEach(function (n) {
            var p = el('p', 'vt-fv-note', (n.text || '') + ' ');
            if (n.issue && onIssue) {
                var a = el('a', null, t('fv.open'));
                a.href = '#';
                a.addEventListener('click', function (e) { e.preventDefault(); onIssue(Number(n.issue)); });
                p.appendChild(a);
            } else if (n.link && HASH_RE.test(n.link)) {
                var l = el('a', null, t('fv.open'));
                l.href = dash(n.link); l.target = '_blank'; l.rel = 'noopener';
                p.appendChild(l);
            }
            w.appendChild(p);
        });
        return w;
    }

    /* ---------------------------------------------------------- asks */
    /* ONE card for everything a person is asked (kit 0.9.52, tools/_asks.py; the
       dashboard's askCardHtml): three types in one anatomy —
         type label · waits · #N  →  title (wraps, never cut)  →  Why you  →
         body of the type  →  What happens next  →  For agents (folded)
       decide   the question, the prepared options as big buttons (recommended
                first and marked; an option that moves the robot is never a
                button — its steps are shown, a person does them at the robot),
                "Why recommended", "None fits, talk it over with the agent";
       approve  what changes / for whom / risk (+ the release's change list) and
                the buttons: those the robot UI may write (finding, remind, hide)
                here, a watcher approval / merge / task on the dashboard's own
                card (its guards) — "Approve or reject in Support";
       steps    one step at a time: Do / You should see, Done (next step; the
                last one is the item's own Done), Does not work (the agent on
                the dashboard's card), Back.
       `it` = a todo item of /api/home or an attention item, both with `ask`. */
    var LS_STEP = 'vitulus_ask_step.';
    function ageText(since) {
        if (!since) { return ''; }
        var ms = typeof since === 'number' ? (since > 1e12 ? since : since * 1000) : Date.parse(since);
        if (isNaN(ms)) { return ''; }
        var s = Math.max(0, (Date.now() - ms) / 1000);
        if (s < 3600) { return Math.max(1, Math.round(s / 60)) + ' min'; }
        if (s < 86400) { return Math.round(s / 3600) + ' h'; }
        return Math.round(s / 86400) + ' d';
    }
    /* the dashboard page that has this card with its own buttons */
    function writePage(a, it) {
        var n = a.issue || it.issue;
        return n ? '#/issue/' + Number(n) : '#/attention';
    }
    function stepOf(id, n) {
        var k = Number(lsGet(LS_STEP + id) || 0) || 0;
        return Math.max(0, Math.min(k, Math.max(0, n - 1)));
    }
    var WRITABLE = { 'finding-accept': 1, 'finding-dismiss': 1, 'remind': 1, 'snooze': 1, 'step-done': 1 };
    /* the item's own buttons the robot UI may press (two clicks, signed) */
    function directButtons(acts, it, box, msgEl, primaryFirst) {
        var out = [];
        (acts || []).forEach(function (a) {
            if (!a || !WRITABLE[a.kind] || !writesOn()) { return; }
            var cls = primaryFirst && !out.length ? 'vt-decide-rec' : '';
            var label = a.label || '';
            if (a.kind === 'step-done' && a.step) {
                out.push(armButton(label && label !== 'Hotovo' ? label : t('common.done'), cls, function () {
                    send('done', { step: a.step, issue: a.issue ? Number(a.issue) : null },
                        shownById('human-step:' + a.step) || shownByAct(function (x) { return x.kind === 'step-done' && x.step === a.step; }),
                        box, msgEl, it.key);
                }, t('fv.done.tip')));
            } else if (a.kind === 'remind' && a.issue) {
                out.push(armButton(label || t('needs.remind'), cls, function () {
                    send('remind', { issue: Number(a.issue) },
                        shownByAct(function (x) { return x.kind === 'remind' && String(x.issue) === String(a.issue); }), box, msgEl, it.key);
                }, t('needs.remind.tip')));
            } else if ((a.kind === 'finding-accept' || a.kind === 'finding-dismiss') && a.fid) {
                var acc = a.kind === 'finding-accept';
                out.push(armButton(label || (acc ? t('needs.accept') : t('needs.dismiss')), cls, function () {
                    send(a.kind, { id: a.fid },
                        shownByAct(function (x) { return (x.kind === 'finding-accept' || x.kind === 'finding-dismiss') && x.fid === a.fid; }), box, msgEl, it.key);
                }));
            } else if (a.kind === 'snooze' && a.aid) {
                out.push(armButton(t('needs.hide24'), '', function () {
                    send('snooze', { id: a.aid },
                        shownByAct(function (x) { return x.kind === 'snooze' && x.aid === a.aid; }), box, msgEl, it.key);
                }));
            }
        });
        return out;
    }
    function askDecide(a, it, box, msgEl) {
        var d = a.decide || {}, p = d.pick || {}, wrap = el('div', 'vt-ask-body');
        var opts = (d.options || []).slice().sort(function (x, y) { return (y.rec ? 1 : 0) - (x.rec ? 1 : 0); });
        if (d.question && d.question !== a.title) { wrap.appendChild(el('p', 'vt-ask-q', d.question)); }
        var canPick = writesOn() && p.pid && /^[0-9a-f]{6,64}$/.test(p.sha || '');
        if (opts.length) {
            var g = el('div', 'vt-ask-opts');
            g.setAttribute('role', 'group');
            opts.forEach(function (o, k) {
                var lab = el('span', 'vt-ask-ol', o.label || '');
                if (o.rec) { lab.appendChild(el('span', 'vt-fv-rec', t('fv.rec'))); }
                if (o.motion) {
                    /* never a button: a person does it at the robot, hand on STOP */
                    var m = el('div', 'vt-ask-opt vt-ask-opt-motion');
                    lab.appendChild(el('span', 'vt-fv-motion', t('fv.ask.motion_badge')));
                    m.appendChild(lab);
                    if (o.what) { m.appendChild(el('span', 'vt-ask-ow', o.what)); }
                    if ((o.steps || []).length) {
                        var ol = el('ol', 'vt-ask-msteps');
                        o.steps.forEach(function (s) { ol.appendChild(el('li', null, s)); });
                        m.appendChild(ol);
                    }
                    m.appendChild(el('span', 'vt-ask-ow vt-ask-only', t('fv.ask.motion_only')));
                    g.appendChild(m);
                    return;
                }
                var primary = k === 0 && o.rec;
                var b = canPick ?
                    armButton(o.label || '', 'vt-ask-opt' + (primary ? ' vt-decide-rec' : ''), function () {
                        send('pick', { pid: p.pid, opt: Number(o.idx), sha: p.sha }, shownByPid(p.pid), box, msgEl, it.key);
                    }, t('fv.confirm.tip')) :
                    linkBtn('', dash(writePage(a, it)), 'vt-ask-opt vt-decide-btn' + (primary ? ' vt-decide-rec' : ''));
                if (!canPick) { b.title = t('fv.decide_in_support'); }
                b.textContent = '';
                b.appendChild(lab);
                if (o.what) { b.appendChild(el('span', 'vt-ask-ow', o.what)); }
                b._rich = Array.prototype.slice.call(b.childNodes);
                g.appendChild(b);
            });
            wrap.appendChild(g);
            if (!canPick) { wrap.appendChild(el('p', 'vt-ask-hint', t('fv.ask.pick_on_dash'))); }
        } else {
            /* a question without prepared answers: answered on the dashboard */
            var acts0 = el('div', 'vt-needs-acts vt-fv-acts');
            acts0.appendChild(linkBtn(t('fv.ask.answer_in_support'), dash(writePage(a, it)), 'vt-fv-go'));
            wrap.appendChild(acts0);
        }
        if (d.rec_why) { wrap.appendChild(el('p', 'vt-ask-recwhy', t('fv.ask.rec_why', { why: d.rec_why }))); }
        var ds = d.discuss || {};
        var db = askButton(it.thread || ds.thread || a.thread || it.issue || 'general', it.discuss || ds.text,
            t('fv.discuss'), false, box, msgEl, it.key, writePage(a, it));
        if (db) {
            var r = el('div', 'vt-needs-acts vt-fv-acts vt-ask-discuss');
            r.appendChild(db);
            wrap.appendChild(r);
        }
        return wrap;
    }
    /* the change list of a release ("Co se mění"): per repo a head line and
       the commit subjects, newest first (kit 0.9.53 flow change lines) */
    function changeList(list, open) {
        if (!list || !list.length) { return null; }
        var d = el('details', 'vt-ask-changes');
        d.open = open !== false;
        d.appendChild(el('summary', null, t('fv.ask.changes')));
        list.forEach(function (c) {
            if (c.head) { d.appendChild(el('div', 'vt-ask-chead', c.head)); }
            var ul = el('ul', 'vt-ask-clines');
            (c.lines || []).forEach(function (x) { ul.appendChild(el('li', null, x)); });
            if (c.more) { ul.appendChild(el('li', 'vt-ask-cmore', c.more)); }
            d.appendChild(ul);
            (c.carried || []).forEach(function (x) { d.appendChild(el('div', 'vt-ask-carried', '↳ ' + x)); });
        });
        return d;
    }
    function askApprove(a, it, box, msgEl) {
        var ap = a.approve || {}, wrap = el('div', 'vt-ask-body');
        if (ap.what) { wrap.appendChild(el('p', 'vt-ask-q', ap.what)); }
        var rows = [['fv.ask.change', ap.change !== a.title ? ap.change : ''], ['fv.ask.for', ap.for_whom], ['fv.ask.risk', ap.risk]]
            .filter(function (r) { return r[1]; });
        if (rows.length) {
            var dl = el('dl', 'vt-ask-facts');
            rows.forEach(function (r) { dl.appendChild(el('dt', null, t(r[0]))); dl.appendChild(el('dd', null, r[1])); });
            wrap.appendChild(dl);
        }
        var cl = changeList(ap.list, true);
        if (cl) { wrap.appendChild(cl); }
        var acts = el('div', 'vt-needs-acts vt-fv-acts');
        var all = (ap.actions || []).filter(Boolean);
        var direct = directButtons(all, it, box, msgEl, true);
        /* a watcher approval, merge or task stays on the dashboard's own card */
        if (!all.length || direct.length < all.length) {
            acts.appendChild(linkBtn(t('fv.ask.approve_in_support'), dash(writePage(a, it)), 'vt-fv-go'));
            direct.forEach(function (b) { b.classList.remove('vt-decide-rec'); });
        }
        direct.forEach(function (b) { acts.appendChild(b); });
        wrap.appendChild(acts);
        return wrap;
    }
    function askSteps(a, it, box, msgEl) {
        var sp = a.steps || {}, steps = sp.steps || [], n = steps.length, id = String(a.id || it.key || '');
        var wrap = el('div', 'vt-ask-body');
        var say = it.say || sp.say;
        var thread = it.thread || a.thread || it.issue || 'general';
        if (!n) {
            wrap.appendChild(el('p', 'vt-ask-q', t('fv.ask.no_steps')));
            var r0 = el('div', 'vt-needs-acts vt-fv-acts');
            var st0 = askButton(thread, say, t('fv.start'), true, box, msgEl, it.key, writePage(a, it));
            if (st0) { r0.appendChild(st0); }
            directButtons(sp.actions, it, box, msgEl, !st0).forEach(function (b) { r0.appendChild(b); });
            if (r0.children.length) { wrap.appendChild(r0); }
            return wrap;
        }
        var ol = el('ol', 'vt-ask-steps');
        function show(k) {
            lsSet(LS_STEP + id, String(k));
            Array.prototype.forEach.call(ol.children, function (li, j) {
                li.hidden = j !== k;
            });
        }
        steps.forEach(function (s, k) {
            var li = el('li', 'vt-ask-step');
            var sn = el('div', 'vt-ask-sn', t('fv.ask.step_n', { k: k + 1, n: n }));
            if (s.motion) { sn.appendChild(el('span', 'vt-fv-motion', t('fv.ask.motion_badge'))); }
            li.appendChild(sn);
            var dd = el('div', 'vt-ask-sdo');
            dd.appendChild(el('b', null, t('fv.ask.do') + ': '));
            dd.appendChild(document.createTextNode(s.do || ''));
            li.appendChild(dd);
            if (s.see) {
                var se = el('div', 'vt-ask-ssee');
                se.appendChild(el('b', null, t('fv.ask.see') + ': '));
                se.appendChild(document.createTextNode(s.see));
                li.appendChild(se);
            }
            var row = el('div', 'vt-needs-acts vt-fv-acts');
            if (k < n - 1) {
                row.appendChild(btn(t('common.done'), function () { show(k + 1); }, 'vt-fv-go'));
            } else {
                var last = directButtons(sp.actions, it, box, msgEl, true);
                if (last.length) { last.forEach(function (b) { row.appendChild(b); }); }
                else { row.appendChild(el('span', 'vt-ask-alldone', t('fv.ask.all_done'))); }
            }
            /* "does not work": the field agent follows up — on the dashboard's card */
            row.appendChild(linkBtn(t('fv.ask.fail'), dash(writePage(a, it)), 'vt-ask-fail'));
            if (k > 0) { row.appendChild(btn(t('fv.ask.back'), function () { show(k - 1); }, 'vt-ask-back')); }
            li.appendChild(row);
            ol.appendChild(li);
        });
        wrap.appendChild(ol);
        show(stepOf(id, n));
        return wrap;
    }
    /* opts: {onIssue(n)} */
    function ask(it, opts) {
        opts = opts || {};
        var a = it.ask || {};
        var key = String(it.key || it.id || a.id || '');
        if (it.key !== key) { it = Object.assign({}, it, { key: key }); }
        var box = el('div', 'vt-card vt-fv-task vt-ask vt-ask-k-' + (a.type || 'x'));
        box.setAttribute('data-state', it.urgent || it.urgency === 'high' ? 'err' : 'warn');
        box.dataset.key = key;
        var head = el('div', 'vt-ask-h');
        head.appendChild(el('span', 'vt-ask-type vt-ask-type-' + (a.type || 'x'), t('fv.ask.t.' + a.type)));
        var meta = el('span', 'vt-ask-meta');
        var ag = ageText(a.since || it.since);
        if (ag) { meta.appendChild(el('span', 'vt-ask-age', t('fv.ask.waits', { age: ag }))); }
        var n = a.issue || it.issue;
        if (n && opts.onIssue) {
            var nb = el('a', 'vt-fv-n', '#' + Number(n));
            nb.href = '#';
            nb.title = t('fv.detail');
            nb.addEventListener('click', function (e) { e.preventDefault(); opts.onIssue(Number(n)); });
            meta.appendChild(nb);
        } else if (n) {
            meta.appendChild(el('span', 'vt-fv-n', '#' + Number(n)));
        }
        head.appendChild(meta);
        box.appendChild(head);
        box.appendChild(el('h4', 'vt-ask-title', a.title || it.title || ''));
        var msg = el('div', 'vt-decide-msg');
        msg.setAttribute('aria-live', 'polite');
        var dn = isDone(key);
        if (dn) {
            box.classList.add('vt-needs-done');
            msg.setAttribute('data-state', 'ok');
            msg.textContent = dn.msg;
            box.appendChild(msg);
            return box;
        }
        if (a.why) {
            var w = el('p', 'vt-ask-why');
            w.appendChild(el('b', null, t('fv.ask.why') + ': '));
            w.appendChild(document.createTextNode(a.why));
            box.appendChild(w);
        }
        if (a.motion) {
            var pl = el('div', 'vt-pills');
            var pm = el('span', 'vt-pill', t('fv.ask.motion'));
            pm.setAttribute('data-state', 'warn');
            pl.appendChild(pm);
            box.appendChild(pl);
        }
        box.appendChild(a.type === 'decide' ? askDecide(a, it, box, msg) :
            a.type === 'approve' ? askApprove(a, it, box, msg) : askSteps(a, it, box, msg));
        if (a.next) {
            var nx = el('p', 'vt-ask-next');
            nx.appendChild(el('b', null, t('fv.ask.next') + ': '));
            nx.appendChild(document.createTextNode(a.next));
            box.appendChild(nx);
        }
        box.appendChild(msg);
        if (a.tech) {
            var tech = el('details', 'vt-ask-tech');
            tech.appendChild(el('summary', null, t('fv.ask.tech')));
            tech.appendChild(el('pre', null, a.tech));
            box.appendChild(tech);
        }
        return box;
    }

    /* --------------------------------------------------------- issue */
    function issue(h, n, onIssue) {
        var art = el('article', 'vt-fv-issue');
        if (!h) {
            art.appendChild(el('p', 'vt-empty', t('fv.i.none')));
            art.appendChild(linkBtn(t('support.open'), dash('#/issue/' + n)));
            return art;
        }
        var top = el('div', 'vt-fv-ihead');
        top.appendChild(el('h3', 'vt-fv-ih', h.title || ('#' + n)));
        var o = h.origin || {};
        var orig = el('div', 'vt-fv-origin');
        orig.appendChild(el('span', null, t('fv.i.reported')));
        var ot = tag(o.who, true);
        if (ot) { orig.appendChild(ot); }
        if (o.when) { orig.appendChild(el('b', null, o.when)); }
        if ((o.refs || []).length) {
            var rf = el('span', null, t('fv.i.follows') + ' ');
            o.refs.forEach(function (r, i) {
                var a = el('a', null, '#' + Number(r));
                a.href = '#';
                a.addEventListener('click', function (e) { e.preventDefault(); if (onIssue) { onIssue(Number(r)); } });
                if (i) { rf.appendChild(document.createTextNode(', ')); }
                rf.appendChild(a);
            });
            orig.appendChild(rf);
        }
        top.appendChild(orig);
        art.appendChild(top);

        var ph = el('ol', 'vt-fv-phases');
        ph.setAttribute('aria-label', t('fv.i.phases'));
        (h.phases || []).forEach(function (p) {
            var li = el('li', 'vt-fv-ph vt-fv-ph-' + (p.state || 'todo'));
            li.appendChild(el('span', 'vt-fv-pn', p.name || ''));
            var pw = el('span', 'vt-fv-pw');
            var pt = tag(p.who, true);
            if (pt) { pw.appendChild(pt); }
            var when = p.state === 'now' && !p.when ? t('fv.i.now') : (p.when || p.detail || '');
            if (when) { pw.appendChild(el('span', 'vt-fv-pwhen', when)); }
            li.appendChild(pw);
            ph.appendChild(li);
        });
        art.appendChild(ph);

        var bx = h.boxes || {};
        var three = el('div', 'vt-fv-three');
        [['problem', 'fv.i.problem'], ['cause', 'fv.i.cause'], ['fix', 'fv.i.fix']].forEach(function (k) {
            var b = el('div', 'vt-fv-box');
            b.appendChild(el('b', 'vt-fv-k', t(k[1])));
            b.appendChild(el('span', bx[k[0]] ? null : 'vt-fv-dim', bx[k[0]] || '–'));
            three.appendChild(b);
        });
        art.appendChild(three);

        var td = h.todo;
        if (td) {
            var box = el('div', 'vt-card vt-fv-start');
            box.setAttribute('data-state', td.mine ? 'warn' : 'off');
            var th = el('div', 'vt-fv-todo-h');
            var tt = tag(td.who);
            if (tt) { th.appendChild(tt); }
            th.appendChild(el('span', 'vt-fv-todo-t', t('fv.i.todo')));
            box.appendChild(th);
            var sa = el('div', 'vt-fv-say-agent', (td.lead || '') + ' ');
            if (td.say) { sa.appendChild(el('q', null, td.say)); }
            if (td.mine && td.after) { sa.appendChild(document.createTextNode(' ' + td.after)); }
            box.appendChild(sa);
            if ((td.steps || []).length) {
                var ol = el('ol', 'vt-fv-steps');
                td.steps.forEach(function (s) {
                    var li = el('li');
                    var d = el('div', 'vt-fv-do', s.do || '');
                    if (s.motion) { d.appendChild(el('span', 'vt-fv-motion', t('fv.motion'))); }
                    li.appendChild(d);
                    if (s.see) { li.appendChild(el('div', 'vt-fv-see', s.see)); }
                    if (s.agent) { li.appendChild(el('div', 'vt-fv-ag', s.agent)); }
                    ol.appendChild(li);
                });
                box.appendChild(ol);
            }
            var msg = el('div', 'vt-decide-msg');
            msg.setAttribute('aria-live', 'polite');
            if (td.mine) {
                var acts = el('div', 'vt-needs-acts vt-fv-acts');
                var st = askButton(td.thread || String(n), td.say, t('fv.start'), true, box, msg, 'issue:' + n, '#/issue/' + n);
                if (st) { acts.appendChild(st); }
                box.appendChild(acts);
            }
            if (td.help) {
                var hp = el('p', 'vt-fv-help');
                var at = tag({ k: 'agent', t: t('fv.agent') }, true);
                if (at) { hp.appendChild(at); }
                hp.appendChild(document.createTextNode(' ' + td.help));
                box.appendChild(hp);
            }
            box.appendChild(msg);
            art.appendChild(box);
        }

        if ((h.log || []).length) {
            var lg = el('details', 'drawer-sec vt-needs-grp vt-fv-log');
            lg.open = lsGet('vitulus_fv_log_open') !== '0';
            var sm = el('summary');
            sm.appendChild(el('span', 'vt-needs-gt', t('fv.i.log')));
            sm.appendChild(el('span', 'vt-needs-gn', String(h.log.length)));
            lg.appendChild(sm);
            lg.addEventListener('toggle', function () { lsSet('vitulus_fv_log_open', lg.open ? '1' : '0'); });
            var body = el('div', 'drawer-sec-body');
            h.log.slice().reverse().forEach(function (x) {
                var r = el('div', 'vt-fv-tl');
                r.appendChild(el('time', null, x.when || ''));
                var xt = tag(x.who, true);
                if (xt) { r.appendChild(xt); }
                var tx = el('div', 'vt-fv-tlx', x.what || '');
                if (x.why) { tx.appendChild(el('span', 'vt-fv-w', x.why)); }
                r.appendChild(tx);
                body.appendChild(r);
            });
            lg.appendChild(body);
            art.appendChild(lg);
        }
        var tech = el('div', 'vt-needs-acts vt-fv-tech');
        tech.appendChild(linkBtn(h.tech || t('fv.i.tech'), dash('#/issue/' + n)));
        art.appendChild(tech);
        return art;
    }

    window.VTField = {
        state: state, task: task, ask: ask, changeList: changeList, notes: notes, issue: issue, tag: tag, setRole: setRole,
        author: author, writesOn: writesOn, dash: dash, linkBtn: linkBtn, btn: btn, isDone: isDone
    };
})();
