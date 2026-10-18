/* vt_needs.js — "Needs you": ONE place for everything that waits for a
 * human (U2, I1 of docs/UI_INTEGRATION_PLAN.md).
 *
 *  - a bell in the navbar, always in the same slot (left of the menu
 *    toggler): quiet when nothing waits, amber + count when something does,
 *    red when something is urgent / would move the robot;
 *  - a panel in the shared left drawer (desktop column, phone bottom sheet)
 *    with two groups of cards in the field look (vt_field.css):
 *      Robot agent — approvals of the robot's agent (from agent_chat.js,
 *                    the same list the agent strip shows; no second poller),
 *      Support     — the field kit's "Potřebuje tě" (/field/api/attention,
 *                    read-only proxy in webnode).
 *
 * Read-only in this phase: deciding happens where the guards are — agent
 * approvals in Agent › Work, field items on the Support dashboard (its page
 * token + same-origin checks must not be bypassed). Each card says so and
 * links there.
 */
(function () {
    'use strict';
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tn(k, n, v) { return window.VTI18n ? VTI18n.tn(k, n, v) : k; }
    var drawerTitle = '';   // the text this panel put into #ui_drawer_title
    var FIELD_EVERY = 30000;
    var panel = null, active = false, bell = null, bellN = null;
    var openGroups = {};

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    function age(sec) {
        if (sec === null || sec === undefined || isNaN(sec)) { return ''; }
        sec = Math.max(0, Math.round(sec));
        if (sec < 60) { return sec + ' s'; }
        if (sec < 3600) { return Math.round(sec / 60) + ' min'; }
        if (sec < 86400) { return Math.round(sec / 3600) + ' h'; }
        return Math.round(sec / 86400) + ' d';
    }
    function sinceSec(v) {
        if (!v) { return null; }
        var t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
        return isNaN(t) ? null : (Date.now() - t) / 1000;
    }
    function supportUrl(link) {
        var l = (typeof link === 'string' && /^#\/[A-Za-z0-9/_-]*$/.test(link)) ? link : '#/attention';
        return 'https://' + location.hostname + ':8790/' + l;
    }

    /* ------------------------------------------------------------ model */
    function model() {
        var asks = (window.VTHub && VTHub.get("agent.asks")) || null;
        var field = (window.VTHub && VTHub.get("field.attention")) || null;
        var a = (asks && asks.data) || [];
        var f = (field && field.data && field.data.items) || [];
        var urgent = a.some(function (x) { return x.moves; }) ||
            f.some(function (x) { return x.urgency === 'high'; }) ||
            !!(field && field.data && field.data.high);
        return { asks: a, field: f, fieldEntry: field, askEntry: asks,
                 n: a.length + f.length, urgent: urgent };
    }

    /* ------------------------------------------------------------- bell */
    function installBell() {
        var toggler = document.getElementById('btn_navbar_toggler');
        if (!toggler || document.getElementById('btn_needs')) { return; }
        bell = el('button', 'vt-needs-bell');
        bell.id = 'btn_needs';
        bell.type = 'button';
        bell.setAttribute('aria-label', t('needs.title'));
        bell.title = t('needs.bell.tip');
        bell.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
        bellN = el('span', 'vt-needs-n');
        bell.appendChild(bellN);
        bell.addEventListener('click', toggle);
        toggler.parentNode.insertBefore(bell, toggler);
    }
    /* a low window (phone in landscape) hides the navbar: the bell then
       moves to the end of the menu band, so it is reachable in every pose */
    function placeBell() {
        if (!bell) { return; }
        var nav = document.getElementById('div_menu');
        var navShown = nav && nav.offsetParent !== null && getComputedStyle(nav).display !== 'none';
        var group = document.querySelector('#row_menu .btn-group');
        var toggler = document.getElementById('btn_navbar_toggler');
        if (!navShown && group) {
            if (bell.parentNode !== group) {
                group.appendChild(bell);
                bell.classList.add('btn', 'btn-outline-info', 'vt-needs-inrow');
            }
        } else if (toggler && bell.parentNode !== toggler.parentNode) {
            toggler.parentNode.insertBefore(bell, toggler);
            bell.classList.remove('btn', 'btn-outline-info', 'vt-needs-inrow');
        }
    }
    function paintBell(m) {
        if (!bell) { return; }
        bell.setAttribute('data-state', m.n ? (m.urgent ? 'err' : 'warn') : 'off');
        bellN.textContent = m.n ? (m.n > 99 ? '99+' : String(m.n)) : '';
        bell.classList.toggle('vt-on', active);
        bell.title = t('needs.bell.tip');
        bell.setAttribute('aria-label', m.n ? t('needs.bell.n', { n: m.n }) : t('needs.bell.none'));
    }

    /* ------------------------------------------------------------ panel */
    function card(state, head, main, sub, chips, actions) {
        var c = el('div', 'vt-card vt-needs-card');
        c.setAttribute('data-state', state);
        var h = el('div', 'vt-card-head');
        h.appendChild(el('span', 'vt-card-title', head.title));
        if (head.end) { h.appendChild(el('span', 'vt-end', head.end)); }
        c.appendChild(h);
        if (main) { c.appendChild(el('div', 'vt-needs-main', main)); }
        if (sub) { c.appendChild(el('div', 'vt-needs-sub', sub)); }
        if (chips && chips.length) {
            var p = el('div', 'vt-pills');
            chips.forEach(function (x) {
                var s = el('span', 'vt-pill', x[0]);
                if (x[1]) { s.setAttribute('data-state', x[1]); }
                p.appendChild(s);
            });
            c.appendChild(p);
        }
        if (actions && actions.length) {
            var a = el('div', 'vt-needs-acts');
            actions.forEach(function (x) { a.appendChild(x); });
            c.appendChild(a);
        }
        return c;
    }
    function linkBtn(label, href) {
        var b = el('a', 'btn btn-outline-info vt-needs-btn', label);
        b.href = href; b.target = '_blank'; b.rel = 'noopener';
        return b;
    }
    function agentBtn() {
        var b = el('button', 'btn btn-outline-info vt-needs-btn', t('needs.review_agent'));
        b.type = 'button';
        b.addEventListener('click', function () {
            if (window.VAgent) {
                try { VAgent.open(); if (VAgent.activateTab) { VAgent.activateTab('work'); } } catch (e) { /* agent down */ }
            }
        });
        return b;
    }
    function group(key, title, count, body) {
        var d = el('details', 'drawer-sec vt-needs-grp');
        d.open = openGroups[key] !== false;
        var s = el('summary');
        s.appendChild(el('span', 'vt-needs-gt', title));
        s.appendChild(el('span', 'vt-needs-gn', String(count)));
        d.appendChild(s);
        var b = el('div', 'drawer-sec-body vt-stack');
        body.forEach(function (x) { b.appendChild(x); });
        d.appendChild(b);
        d.addEventListener('toggle', function () {
            openGroups[key] = d.open;
            lsSet('vitulus_needs_groups', JSON.stringify(openGroups));
        });
        return d;
    }

    /* I6: a field item also links to the agent chat and to its issue */
    /* ---------------------------------------- I5: decide from the robot UI
       (kit 0.9.38 "Zápisy z UI robota"): Done, a card option WITHOUT motion,
       Hide 24 h, Remind, Accept / Dismiss a finding. Two clicks (the first
       arms, the second sends within 5 s); the webnode asks the dashboard for
       a single-use token bound to this card and the text shown here, and the
       dashboard runs its own endpoint. Nothing else is writable from here. */
    var LS_UI_AUTHOR = 'vitulus_ui_author';
    function author() {
        var a = lsGet('vitulus_agent_author') || lsGet(LS_UI_AUTHOR) || '';
        return String(a).replace(/^"|"$/g, '').trim().slice(0, 60);
    }
    function writesOn() {
        var e = window.VTHub && VTHub.get("ui.actions");
        return !!(e && e.data && e.data.writes);
    }
    function send(action, payload, shown, cardEl, msgEl) {
        var who = author();
        if (!who) {
            msgEl.setAttribute('data-state', 'warn');
            msgEl.textContent = t('needs.sign_first');
            return;
        }
        msgEl.removeAttribute('data-state');
        msgEl.textContent = t('needs.sending');
        var body = JSON.stringify(Object.assign({ author: who, shown: shown }, payload));
        fetch('/field/act/' + action, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Vitulus-UI': '1' }, body: body
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) { return [r.ok, j]; });
        }).then(function (res) {
            var ok = res[0] && res[1].ok !== false;
            msgEl.setAttribute('data-state', ok ? 'ok' : 'err');
            msgEl.textContent = ok ? (res[1].message ? t('needs.sent.msg', { msg: res[1].message }) : t('needs.sent')) :
                t('needs.not_done', { err: res[1].error || res[1].message || t('needs.err') });
            if (ok) {
                cardEl.classList.add('vt-needs-done');
                if (window.VTHub) { VTHub.refresh("field.attention"); VTHub.refresh("ui.actions"); }
            }
        }, function (e) {
            msgEl.setAttribute('data-state', 'err');
            msgEl.textContent = t('needs.not_done', { err: e && e.message || e });
        });
    }
    function armButton(label, cls, onSend, title) {
        var b = el('button', 'btn vt-needs-btn vt-decide-btn ' + (cls || ''), label);
        b.type = 'button';
        if (title) { b.title = title; }
        var timer = null;
        b.addEventListener('click', function () {
            if (!b.classList.contains('vt-armed')) {
                b.classList.add('vt-armed');
                b.textContent = t('needs.sure', { label: label });
                timer = setTimeout(function () { b.classList.remove('vt-armed'); b.textContent = label; }, 5000);
                return;
            }
            clearTimeout(timer);
            b.classList.remove('vt-armed');
            b.textContent = label;
            b.disabled = true;
            onSend();
            setTimeout(function () { b.disabled = false; }, 3000);
        });
        return b;
    }
    function decideRow(x, p, cardEl) {
        if (!writesOn()) { return null; }
        var row = el('div', 'vt-decide');
        var btns = el('div', 'vt-decide-btns');
        var msg = el('div', 'vt-decide-msg');
        msg.setAttribute('aria-live', 'polite');
        var shown = p.headline || x.title || '';
        (p.options || []).forEach(function (o, i) {
            if (!o || !o.changes_something) { return; }
            if (o.motion) {
                btns.appendChild(el('span', 'vt-pill vt-decide-motion', t('needs.motion_pill', { label: o.label || t('needs.option') })));
                return;
            }
            if (!p.pid || !p.sha) { return; }
            btns.appendChild(armButton(o.label || t('needs.option_n', { n: i + 1 }), o.recommended ? 'vt-decide-rec' : '',
                function () { send('pick', { pid: p.pid, opt: i, sha: p.sha }, shown, cardEl, msg); },
                o.what_happens || ''));
        });
        (x.actions || []).forEach(function (a) {
            if (!a || !a.kind) { return; }
            if (a.kind === 'step-done' && a.step) {
                btns.appendChild(armButton(a.label && a.label !== 'Hotovo' ? a.label : t('common.done'), 'vt-decide-rec', function () {
                    send('done', { step: a.step, issue: a.issue ? Number(a.issue) : null }, shown, cardEl, msg);
                }));
            } else if (a.kind === 'snooze' && a.aid) {
                btns.appendChild(armButton(t('needs.hide24'), '', function () { send('snooze', { id: a.aid }, shown, cardEl, msg); }));
            } else if (a.kind === 'remind' && a.issue) {
                btns.appendChild(armButton(t('needs.remind'), '', function () { send('remind', { issue: Number(a.issue) }, shown, cardEl, msg); },
                    t('needs.remind.tip')));
            } else if ((a.kind === 'finding-accept' || a.kind === 'finding-dismiss') && a.fid) {
                var acc = a.kind === 'finding-accept';
                btns.appendChild(armButton(acc ? t('needs.accept') : t('needs.dismiss'), acc ? 'vt-decide-rec' : '', function () {
                    send(a.kind, { id: a.fid }, shown, cardEl, msg);
                }));
            }
        });
        if (!btns.children.length) { return null; }
        row.appendChild(btns);
        row.appendChild(msg);
        return row;
    }
    function nameRow() {
        if (author() || !writesOn()) { return null; }
        var r = el('div', 'vt-card vt-needs-name');
        r.setAttribute('data-state', 'info');
        r.appendChild(el('div', 'vt-needs-sub', t('needs.name.hint')));
        var inp = el('input', 'form-control');
        inp.type = 'text'; inp.maxLength = 60; inp.placeholder = t('needs.name.placeholder');
        inp.addEventListener('change', function () { lsSet(LS_UI_AUTHOR, inp.value.trim()); render(); });
        r.appendChild(inp);
        return r;
    }

    function fieldActs(x, p) {
        var acts = [linkBtn(t('needs.open_support'), supportUrl(x.link))];
        if (window.VTLinks) {
            acts.push(VTLinks.button(t('needs.ask'), function () {
                var hl = p.headline || x.title || '';
                VTLinks.askAgent(x.issue ? t('needs.ask.draft_issue', { n: x.issue, title: hl })
                                         : t('needs.ask.draft', { title: hl }));
            }, t('needs.ask.tip')));
            if (x.issue && window.VTSupport) {
                acts.push(VTLinks.button(t('needs.issue_n', { n: x.issue }), function () { VTLinks.openIssue(x.issue); }));
            }
        }
        return acts;
    }
    function render() {
        var m = model();
        paintBell(m);
        if (!panel || !active) { return; }
        var meta = document.getElementById('vt_needs_meta');
        if (meta) {
            meta.textContent = m.n ? tn('needs.waiting', m.n) : t('needs.nothing_waits');
        }
        var root = panel.querySelector('.vt-needs-body');
        root.textContent = '';

        // P22: all clear = ONE good-news line; the two groups keep their place
        // (header + 0) but no longer repeat "nothing here" twice below it
        var allClear = !m.n && m.fieldEntry && m.fieldEntry.ok && !!m.askEntry;
        if (allClear) {
            root.appendChild(el('p', 'vt-empty-ok', t('needs.all_clear')));
        }

        /* robot agent */
        var ac = m.asks.map(function (x) {
            return card(x.moves ? 'err' : 'warn',
                { title: x.moves ? t('needs.card.motion') : t('needs.card.approval'), end: age(x.waiting_s) },
                x.what || t('needs.card.ask'), null,
                [[t('needs.chip.agent')], x.moves ? [t('needs.chip.moves'), 'err'] : null].filter(Boolean),
                [agentBtn()]);
        });
        if (!m.askEntry) {
            ac = [el('p', 'vt-empty', t('needs.wait_agent'))];
        } else if (!ac.length) {
            ac = allClear ? [] : [el('p', 'vt-empty', t('needs.no_approvals'))];
        }
        root.appendChild(group('agent', t('needs.grp.agent'), m.asks.length, ac));

        /* field kit */
        var fc;
        if (!m.fieldEntry) {
            fc = [el('span', 'vt-skel'), el('span', 'vt-skel vt-skel-short')];
        } else if (!m.fieldEntry.ok && !m.field.length) {
            fc = [el('p', 'vt-empty', t('needs.field.unreachable', { err: m.fieldEntry.err || t('needs.err') }))];
        } else {
            fc = m.field.map(function (x) {
                var p = x.plain || {};
                var rec = (p.options || []).filter(function (o) { return o.recommended; })[0];
                var chips = [[x.kind || t('needs.chip.item')]];
                if (x.issue) { chips.push(['#' + x.issue, 'info']); }
                if (x.urgency === 'high') { chips.push([t('needs.chip.urgent'), 'err']); }
                if (rec && rec.motion) { chips.push([t('needs.chip.motion'), 'warn']); }
                var KIND = { 'human-step': 'human_step', decision: 'decision', approve: 'approve',
                             finding: 'finding', test: 'test', reply: 'reply' };
                var c = card(x.urgency === 'high' ? 'err' : 'warn',
                    { title: t(Object.prototype.hasOwnProperty.call(KIND, x.kind) ? 'needs.kind.' + KIND[x.kind] : 'needs.kind.support'),
                      end: age(sinceSec(x.since)) },
                    p.headline || x.title || '', p.explain || x.why || '',
                    chips.concat(rec ? [[t('needs.chip.recommended', { label: (rec.label || '').slice(0, 60) }), 'ok']] : []),
                    fieldActs(x, p));
                var dr = decideRow(x, p, c);
                if (dr) { c.insertBefore(dr, c.querySelector('.vt-needs-acts')); }
                return c;
            });
            if (!fc.length) { fc = allClear ? [] : [el('p', 'vt-empty', t('needs.field.none'))]; }
            if (!m.fieldEntry.ok) {
                fc.unshift(el('p', 'vt-empty', t('needs.field.stale')));
            }
        }
        var nr = nameRow();
        if (nr && m.field.length) { fc.unshift(nr); }
        root.appendChild(group('field', t('needs.grp.field'), m.field.length, fc));
    }

    function build() {
        panel = el('div', 'vt-needs');
        panel.id = 'vt_needs_panel';
        panel.style.display = 'none';
        panel.appendChild(el('div', 'vt-needs-body vt-stack'));
        var meta = el('span', 'vt-needs-meta');
        meta.id = 'vt_needs_meta';
        panel.appendChild(meta);
    }

    /* the shared drawer: open it the way the agent panel does, give it back
       the moment someone else takes it (title changes / drawer closes) */
    function open() {
        var d = document.getElementById('ui_drawer'), body = document.getElementById('ui_drawer_body');
        var title = document.getElementById('ui_drawer_title');
        if (!d || !body) { return; }
        var mm = window.map_menu;
        if (window.VAgent && VAgent.isVisible && VAgent.isVisible()) { try { VAgent.close(); } catch (e) { /* ok */ } }
        if (mm && typeof mm.close_drawer === 'function') { try { mm.close_drawer(); } catch (e) { /* ok */ } }
        if (panel.parentNode !== body) { body.appendChild(panel); }
        panel.style.display = 'block';
        try {
            var rm = document.getElementById('row_menu');
            var b = rm && rm.getBoundingClientRect().bottom;
            if (b > 0) {
                d.style.top = Math.round(b + 2) + 'px';
                document.documentElement.style.setProperty('--vt-drawer-top', Math.round(b + 2) + 'px');
            }
        } catch (e) { /* layout not ready */ }
        d.classList.remove('wide', 'editor');
        d.classList.add('open');
        settle(d);
        d.setAttribute('aria-hidden', 'false');
        if (title) { drawerTitle = t('needs.title'); title.textContent = drawerTitle; }
        var metaSlot = document.getElementById('ui_drawer_meta');
        var meta = document.getElementById('vt_needs_meta');
        if (metaSlot && meta) { metaSlot.appendChild(meta); }
        if (mm) { mm._drawer_last = 'needs'; if (mm.set_drawer_full) { mm.set_drawer_full(lsGet('vitulus_drawer_full_needs') === '1'); } }
        var bd = document.getElementById('ui_drawer_backdrop');
        if (bd) { bd.style.display = window.innerWidth < 576 ? 'block' : 'none'; }
        active = true;
        lsSet('vitulus_needs_open', '1');
        if (window.VTHub) { VTHub.refresh("field.attention"); }
        if (!VTHub.get("agent.asks") && window.VAgent && VAgent.pollApprovals) {
            try { VAgent.pollApprovals(); } catch (e) { /* agent down */ }
        }
        render();
    }
    function deactivate(slideOut) {
        if (!active) { return; }
        active = false;
        panel.style.display = 'none';
        var meta = document.getElementById('vt_needs_meta');
        if (meta) { panel.appendChild(meta); }
        lsSet('vitulus_needs_open', '0');
        if (slideOut) {
            var mm = window.map_menu, d = document.getElementById('ui_drawer');
            if (mm && typeof mm._drawer_slide_out === 'function') { mm._drawer_slide_out(); }
            else if (d) { d.classList.remove('open', 'wide', 'editor', 'full'); d.setAttribute('aria-hidden', 'true'); }
            var bd = document.getElementById('ui_drawer_backdrop');
            if (bd) { bd.style.display = 'none'; }
        }
        render();
    }
    /* Chrome can leave the drawer's slide-in transition un-started when the
       compositor is throttled (window occluded / in the background): the
       drawer then has .open but sits off-screen. Same fix as agent_chat.js
       settleDrawer: finish whatever has not started, two frames later and on
       plain timers (rAF does not run there either). */
    function settle(d) {
        if (!d || !d.getAnimations) { return; }
        var run = function () {
            d.getAnimations().forEach(function (a) {
                if (a.playState === 'running' && (!a.startTime || !a.currentTime)) {
                    try { a.finish(); } catch (e) { /* gone */ }
                }
            });
        };
        if (window.requestAnimationFrame) { requestAnimationFrame(function () { requestAnimationFrame(run); }); }
        setTimeout(run, 120);
        setTimeout(run, 500);
    }
    /* really on screen? (.open alone is not proof, see settle) */
    function shown() {
        var d = document.getElementById('ui_drawer');
        if (!active || !d || !d.classList.contains('open') || panel.style.display === 'none') { return false; }
        var r = d.getBoundingClientRect();
        return r.width > 0 && r.right > 40 && r.left > -40;
    }
    /* the bell: closes only what the user can SEE open; anything else
       (stale state, a stalled slide-in) opens / re-shows the panel */
    function toggle() { if (shown()) { deactivate(true); } else { active = false; open(); } }
    function watchDrawer() {
        var d = document.getElementById('ui_drawer'), title = document.getElementById('ui_drawer_title');
        if (d) {
            new MutationObserver(function () {
                if (active && !d.classList.contains('open')) { deactivate(false); }
            }).observe(d, { attributes: true, attributeFilter: ['class'] });
        }
        if (title) {
            new MutationObserver(function () {
                if (active && title.textContent !== drawerTitle) { deactivate(false); }
            }).observe(title, { childList: true, characterData: true, subtree: true });
        }
        var fb = document.getElementById('btn_ui_drawer_full');
        if (fb) {
            fb.addEventListener('click', function () {
                if (!active) { return; }
                setTimeout(function () {
                    lsSet('vitulus_drawer_full_needs', d && d.classList.contains('full') ? '1' : '0');
                }, 0);
            });
        }
        var xb = document.getElementById('btn_ui_drawer_close');
        if (xb) { xb.addEventListener('click', function () { if (active) { deactivate(true); } }); }
    }

    function init() {
        if (!window.VTHub) { return; }
        try { openGroups = JSON.parse(lsGet('vitulus_needs_groups') || '{}') || {}; } catch (e) { openGroups = {}; }
        build();
        installBell();
        placeBell();
        window.addEventListener('resize', function () { setTimeout(placeBell, 120); });
        var nav = document.getElementById('div_menu');
        if (nav) { new MutationObserver(placeBell).observe(nav, { attributes: true, attributeFilter: ['style', 'class'] }); }
        watchDrawer();
        VTHub.on("agent.asks", render);
        VTHub.on("field.attention", render);
        VTHub.poll("field.attention", '/field/api/attention', FIELD_EVERY);
        VTHub.on("ui.actions", render);
        VTHub.poll("ui.actions", '/field/ui_actions?limit=50', 60000);   // I5: switch + audit
        setInterval(function () { if (active) { render(); } }, 30000);   // ages tick
        if (window.VTI18n) {
            VTI18n.onChange(function () {   // live language switch: the drawer title, bell and cards
                var tt = document.getElementById('ui_drawer_title');
                if (active && tt) { drawerTitle = t('needs.title'); tt.textContent = drawerTitle; }
                render();
            });
        }
        if (lsGet('vitulus_needs_open') === '1') { setTimeout(open, 1500); }
        window.VTNeeds = { open: open, close: function () { deactivate(true); }, toggle: toggle };
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
