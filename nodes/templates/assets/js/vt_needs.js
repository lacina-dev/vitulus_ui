/* vt_needs.js — "Needs you": ONE place for everything that waits for a
 * human (U2, I1 of docs/UI_INTEGRATION_PLAN.md; field language 2026-10-25).
 *
 *  - a bell in the navbar, always in the same slot (left of the menu
 *    toggler): quiet when nothing waits, amber + count when something does,
 *    red when something is urgent / would move the robot. It counts ONLY
 *    what waits for a person (alert-only-when-needed): the robot agent's
 *    approvals and parked work, and the field's "Na tobě" (todo.mine of
 *    /api/home) — never calm notes, info or what the agents handle;
 *  - a panel in the shared left drawer (desktop column, phone bottom sheet)
 *    that speaks the field's language (vt_field_view.js):
 *      How we stand — both sides in one sentence each       (/api/home stav)
 *      On you       — the robot agent's asks + the field's tasks: decisions
 *                     with the agent's variants (Confirm / talk it over),
 *                     steps that start with the agent ("Start with the
 *                     agent"), Done / Hide; Detail opens the issue's human
 *                     block in Support                          (/api/home todo)
 *      <peer> has to do — folded, quiet: what the other side is on
 *
 * Field writes go through the webnode door /field/act/* (vt_field_view.js);
 * agent approvals are decided in Agent › Work.
 */
(function () {
    'use strict';
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tn(k, n, v) { return window.VTI18n ? VTI18n.tn(k, n, v) : k; }
    var drawerTitle = '';   // the text this panel put into #ui_drawer_title
    var FIELD_EVERY = 30000, HOME_EVERY = 45000;
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
        var l = (typeof link === 'string' && /^#\/[A-Za-z0-9/_.:-]*$/.test(link)) ? link : '#/';
        return 'https://' + location.hostname + ':8790/' + l;
    }

    /* ------------------------------------------------------------ model */
    /* an attention item that waits for this side's person — the field's own
       rule (dash/app.js attnIsInfo / attnState): information (kind live,
       info: true) waits for nobody, the agent's own job ("the agent is on
       it", ask.agent_work) and what is already being done are not counted */
    function waitsOnMe(x) {
        if (!x || x.info === true || x.kind === 'live' || x.kind === 'info') { return false; }
        var a = x.ask;
        if (a && a.agent_work) { return false; }
        var pk = ((x.plain || {}).pick || {}).state || '';
        if (/^(queued|working)$/.test(pk)) { return false; }
        return a ? true : x.urgency !== 'low';
    }
    function model() {
        var H = window.VTHub;
        var asks = (H && H.get("agent.asks")) || null;
        var field = (H && H.get("field.attention")) || null;
        var home = (H && H.get("field.home")) || null;
        /* agent work that needs a person and is not an approval — the core
           decides (attention.py: dock lock, parked mission, a failure only a
           human can fix); everything the agent handles itself stays out */
        var needs = (H && H.get("agent.needs")) || null;
        var a = (asks && asks.data) || [];
        var w = (needs && needs.data) || [];
        var hd = home && home.data;
        /* the field's words in the viewer's language (ui-doors: home.alt[lang] = the same
           stav / todo composed in the other language) */
        var hl = hd && hd.alt && window.VTI18n && VTI18n.lang && hd.alt[VTI18n.lang()];
        if (hl) { hd = Object.assign({}, hd, hl); }
        var todo = hd && hd.todo && hd.todo.mine ? hd.todo : null;
        var mine = todo ? (todo.mine.items || []) : null;
        /* before /api/home answers (it is the slow one): the attention list
           without calm info (urgency low) stands in for the count */
        var f = mine || ((field && field.data && field.data.items) || []).filter(waitsOnMe);
        var fieldN = mine ? mine.length + (todo.mine.more || 0) : f.length;
        /* the warnings only a person solves (GitHub token, field not running,
           Signal off, the other side silent / stuck, this side behind) — the
           field's menu bubble counts them too (kit 0.9.54 hmAlertList) */
        var now = (H && H.get("field.now")) || null;
        var cur = now && now.data;
        var al = hd && window.VTField && VTField.alerts ? VTField.alerts(hd, cur) : [];
        var urgent = a.some(function (x) { return x.moves; }) ||
            w.some(function (x) { return x.code === 'safety'; }) ||
            al.some(function (x) { return x.tone === 'bad'; }) ||
            ((field && field.data && field.data.items) || []).some(function (x) { return x.urgency === 'high'; });
        return { asks: a, work: w, field: f, todo: todo, stav: hd && hd.stav, home: home, hd: hd, cur: cur,
                 fieldEntry: field, askEntry: asks, fieldN: fieldN, alerts: al,
                 n: a.length + w.length + fieldN + al.length, urgent: urgent };
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
    /* the navbar is on screen in every pose since the header variant A
       (owner 2026-10-25; on a low window it is the one header row), so the
       bell always stays there — its place in the row is CSS (vt_header.css) */
    function placeBell() {
        if (!bell) { return; }
        var toggler = document.getElementById('btn_navbar_toggler');
        if (toggler && bell.parentNode !== toggler.parentNode) {
            toggler.parentNode.insertBefore(bell, toggler);
        }
        bell.classList.remove('btn', 'btn-outline-info', 'vt-needs-inrow');
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
    function agentBtn(ref) {
        var b = el('button', 'btn btn-outline-info vt-needs-btn', t('needs.review_agent'));
        b.type = 'button';
        b.addEventListener('click', function () {
            if (window.VAgent) {
                try {
                    VAgent.open();
                    if (VAgent.activateTab) { VAgent.activateTab('work'); }
                    if (ref && VAgent.highlightJob) { VAgent.highlightJob(ref); }
                } catch (e) { /* agent down */ }
            }
        });
        return b;
    }
    /* the robot agent's asks in the SAME anatomy as the field's cards
       (vt_field.css .vt-ask): type · waits → title → Why you → button →
       What happens next; the source is a small "robot agent" tag */
    function agentAsk(state, type, since, title, why, sub, chips, btn, next) {
        var c = el('div', 'vt-card vt-fv-task vt-ask vt-ask-k-agent');
        c.setAttribute('data-state', state);
        var h = el('div', 'vt-ask-h');
        h.appendChild(el('span', 'vt-ask-type', type));
        var tg = window.VTField && VTField.tag({ k: 'agent', t: t('needs.chip.robot_agent') }, true);
        if (tg) { h.appendChild(tg); }
        var meta = el('span', 'vt-ask-meta');
        var ag = age(since);
        if (ag) { meta.appendChild(el('span', 'vt-ask-age', t('fv.ask.waits', { age: ag }))); }
        h.appendChild(meta);
        c.appendChild(h);
        c.appendChild(el('h4', 'vt-ask-title', title));
        if (why) {
            var w = el('p', 'vt-ask-why');
            w.appendChild(el('b', null, t('fv.ask.why') + ': '));
            w.appendChild(document.createTextNode(why));
            c.appendChild(w);
        }
        if (sub) { c.appendChild(el('div', 'vt-needs-sub', sub)); }
        if (chips && chips.length) {
            var p = el('div', 'vt-pills');
            chips.forEach(function (x) {
                var sp = el('span', 'vt-pill', x[0]);
                if (x[1]) { sp.setAttribute('data-state', x[1]); }
                p.appendChild(sp);
            });
            c.appendChild(p);
        }
        var a = el('div', 'vt-needs-acts vt-fv-acts');
        btn.classList.add('vt-fv-go');
        a.appendChild(btn);
        c.appendChild(a);
        if (next) {
            var nx = el('p', 'vt-ask-next');
            nx.appendChild(el('b', null, t('fv.ask.next') + ': '));
            nx.appendChild(document.createTextNode(next));
            c.appendChild(nx);
        }
        return c;
    }
    /* one sentence: WHAT you are asked to do and WHY (ajob.attn.<code>);
       the core's own Czech sentence is the sub-line — it is evidence */
    /* a latched STOP (mise #253): the card carries the way out — the same
       words the owner would type, posted into the chat as him */
    function stopBtn() {
        var b = el('button', 'btn btn-outline-danger vt-needs-btn', t('agent.panic.release'));
        b.type = 'button';
        b.title = t('agent.panic.release_tip');
        b.addEventListener('click', function () {
            b.disabled = true;
            try {
                if (window.VAgent && VAgent.submitText) { VAgent.submitText('/stop pokracuj'); }
                else if (window.VAgent && VAgent.api) {
                    VAgent.api('/api/task', { body: { text: '/stop pokracuj' } });
                }
            } catch (e) { b.disabled = false; return; }
            setTimeout(function () { b.disabled = false; }, 6000);
        });
        return b;
    }
    function workCard(x) {
        if (x.code === 'stop_latched') {
            return agentAsk('err', t('needs.work.stop_latched'), sinceSec(x.since),
                t('ajob.attn.stop_latched'), t('needs.agent.why_stop'), x.why || null, null,
                stopBtn(), t('needs.agent.next_stop'));
        }
        var key = 'needs.work.' + x.code, head = t(key);
        if (head === key) { head = t('needs.work.other'); }
        var main = t('ajob.attn.' + x.code, { ref: x.ref });
        if (main === 'ajob.attn.' + x.code) { main = x.why || ''; }
        var sub = '#' + String(x.ref || '').replace(/^[js]:/, '') + ' ' + (x.title || '');
        if (x.detail) { sub += ' — ' + x.detail; }
        return agentAsk(x.code === 'safety' ? 'err' : 'warn', head, sinceSec(x.since),
            main.charAt(0).toUpperCase() + main.slice(1), t('needs.agent.why_work'), sub, null, agentBtn(x.ref), t('needs.agent.next_work'));
    }
    /* a new capability (a new write on the robot the agent may not give
       itself): decided right here — Allow signs it in your name, Deny (two
       taps) archives it; the same /api/approvals/decide as Agent › Work */
    function capButtons(x) {
        var box = el('span', 'vt-needs-capbtns');
        var yes = el('button', 'btn btn-info vt-needs-btn', t('needs.cap.allow'));
        var no = el('button', 'btn btn-outline-secondary vt-needs-btn', t('needs.cap.deny'));
        var out = el('span', 'vt-needs-sub');
        yes.type = no.type = 'button';
        function send(allow) {
            yes.disabled = no.disabled = true;
            out.textContent = t('needs.sending');
            if (!window.VAgent || !VAgent.decideApproval) { out.textContent = t('needs.err'); return; }
            VAgent.decideApproval(x.id, allow).then(function (res) {
                no.classList.remove('vt-armed');
                out.textContent = (res.ok ? '✓ ' : '✕ ') + res.text;
                if (!res.ok) { yes.disabled = no.disabled = false; }
            });
        }
        yes.addEventListener('click', function () { send(true); });
        var timer = null;
        no.addEventListener('click', function () {
            if (!no.classList.contains('vt-armed')) {
                no.classList.add('vt-armed');
                no.textContent = t('needs.cap.deny_really');
                timer = setTimeout(function () {
                    no.classList.remove('vt-armed');
                    no.textContent = t('needs.cap.deny');
                    render();
                }, 6000);
                return;
            }
            if (timer) { clearTimeout(timer); }
            send(false);
        });
        box.appendChild(yes);
        box.appendChild(no);
        box.appendChild(out);
        return box;
    }
    function askCard(x) {
        if (x.kind === 'capability') {
            return agentAsk(x.moves ? 'err' : 'warn', t('needs.cap.type'), x.waiting_s,
                x.what || t('needs.card.ask'), t('needs.cap.why'), null,
                x.recommend ? [[t('needs.cap.rec.' + x.recommend), x.recommend === 'deny' ? 'warn' : 'info']] : null,
                capButtons(x), t('needs.cap.next'));
        }
        return agentAsk(x.moves ? 'err' : 'warn', t('fv.ask.t.approve'), x.waiting_s,
            x.what || t('needs.card.ask'), x.moves ? t('needs.agent.why_motion') : t('needs.agent.why_ask'), null,
            x.moves ? [[t('fv.ask.motion'), 'warn']] : null, agentBtn(), t('needs.agent.next_ask'));
    }
    function group(key, title, count, body, defOpen) {
        var d = el('details', 'drawer-sec vt-needs-grp');
        d.open = openGroups[key] === undefined ? defOpen !== false : openGroups[key] !== false;
        d.dataset.grp = key;
        var s = el('summary');
        s.appendChild(el('span', 'vt-needs-gt', title));
        s.appendChild(el('span', 'vt-needs-gn', String(count)));
        d.appendChild(s);
        var b = el('div', 'drawer-sec-body vt-stack');
        body.forEach(function (x) { if (x) { b.appendChild(x); } });
        d.appendChild(b);
        d.addEventListener('toggle', function () {
            openGroups[key] = d.open;
            lsSet('vitulus_needs_groups', JSON.stringify(openGroups));
        });
        return d;
    }
    function nameRow() {
        if (!window.VTField || VTField.author() || !VTField.writesOn()) { return null; }
        var r = el('div', 'vt-card vt-needs-name');
        r.setAttribute('data-state', 'info');
        r.appendChild(el('div', 'vt-needs-sub', t('needs.name.hint')));
        var inp = el('input', 'form-control');
        inp.type = 'text'; inp.maxLength = 60; inp.placeholder = t('needs.name.placeholder');
        inp.addEventListener('change', function () { lsSet('vitulus_ui_author', inp.value.trim()); render(); });
        r.appendChild(inp);
        return r;
    }
    function openIssue(n) {
        if (window.VTSupport && VTSupport.showIssueDetail) { VTSupport.showIssueDetail(n); }
        else if (window.VTLinks) { VTLinks.openIssue(n); }
    }
    /* before /api/home answers: the attention item as a plain card */
    function attCard(x) {
        if (x.ask && x.ask.type && window.VTField && VTField.ask) {
            return VTField.ask(Object.assign({}, x, { ask: VTField.askOf(x) }), { onIssue: openIssue });
        }
        var p = x.plain || {};
        return card(x.urgency === 'high' ? 'err' : 'warn', { title: p.headline || x.title || '', end: age(sinceSec(x.since)) },
            null, p.explain || x.why || '', x.issue ? [['#' + x.issue, 'info']] : null,
            [VTField.linkBtn(t('needs.open_support'), supportUrl(x.link))]);
    }

    function render() {
        var m = model();
        paintBell(m);
        if (!panel || !active) { return; }
        var meta = document.getElementById('vt_needs_meta');
        if (meta) { meta.textContent = m.n ? tn('needs.waiting', m.n) : t('needs.nothing_waits'); }
        var root = panel.querySelector('.vt-needs-body');
        // keep the reader's place: a poll must not throw the list back to the top
        var sc = root.closest('#ui_drawer_body') || root.parentNode;
        var keepTop = sc ? sc.scrollTop : 0;
        // an armed button or a picked variant is a person in the middle of a click
        if (root.querySelector('.vt-armed')) { return; }
        root.textContent = '';
        if (!window.VTField) { return; }
        if (m.todo && m.todo.role) { VTField.setRole(m.todo.role); }

        /* the state in one sentence (what waits on you, what the agents and the
           other side do), both sides one line each, their facts folded */
        if (m.hd) { root.appendChild(VTField.hero(m.hd, m.n, m.urgent)); }
        else if (!m.home) { root.appendChild(el('span', 'vt-skel')); }

        /* on you: the warnings, the robot agent's asks, the field's asks */
        var on = [];
        m.alerts.forEach(function (x) { on.push(VTField.alertCard(x)); });
        m.work.forEach(function (x) { on.push(workCard(x)); });
        m.asks.forEach(function (x) { on.push(askCard(x)); });
        var nr = nameRow();
        if (nr && m.fieldN) { on.push(nr); }
        if (m.todo) {
            m.todo.mine.items.forEach(function (it) {
                on.push(it.ask && it.ask.type ? VTField.ask(it, { onIssue: openIssue }) :
                    VTField.task(it, { mine: true, onIssue: openIssue }));
            });
        } else {
            m.field.forEach(function (x) { on.push(attCard(x)); });
            if (!m.fieldEntry && !m.home) { on.push(el('span', 'vt-skel vt-skel-short')); }
        }
        if (!on.length) {
            var known = (m.home && m.home.ok) || (m.fieldEntry && m.fieldEntry.ok);
            on.push(el('p', known ? 'vt-empty-ok' : 'vt-empty', known ? t('needs.all_clear') : t('needs.wait_field')));
        }
        if (m.todo && m.todo.mine.more) {
            on.push(VTField.linkBtn(t('fv.more_n', { n: m.todo.mine.more }), supportUrl('#/attention')));
        }
        var nt = m.todo && VTField.notes(m.todo.mine.notes, openIssue, 'notes:mine');   // folded, like the field's Domů
        if (nt) { on.push(nt); }
        if ((m.home && !m.home.ok) || (m.fieldEntry && !m.fieldEntry.ok)) {
            on.push(el('p', 'vt-empty', (m.home && m.home.data) || (m.fieldEntry && m.fieldEntry.data) ?
                t('needs.field.stale') : t('needs.field.unreachable', { err: (m.home && m.home.err) || (m.fieldEntry && m.fieldEntry.err) || t('needs.err') })));
        }
        var onTitle = t('fv.on_you');
        root.appendChild(group('mine', onTitle, m.n, on));

        /* what the agents are on right now (never counted) */
        if (m.hd) {
            var rows = VTField.agentRows(m.hd, m.cur);
            root.appendChild(group('agents', t('fv.agents'), rows.length, [VTField.agents(m.hd, m.cur, openIssue)]));
        }

        /* what the other side is on: folded, never counted */
        if (m.todo && m.todo.peer) {
            var P = m.todo.peer, names = m.todo.names || {};
            var pc = (P.items || []).map(function (it) { return VTField.task(it, { mine: false, onIssue: openIssue }); });
            if (!pc.length) { pc.push(el('p', 'vt-empty', t('fv.empty_peer', { name: names.peer || P.name || '?' }))); }
            var pn = VTField.notes(P.notes, openIssue);
            if (pn) { pc.push(pn); }
            root.appendChild(group('peer', t('fv.peer_wait', { name: (window.VTI18n && VTI18n.lang() === 'cs' && names.peer_gen) || names.peer || P.name || '?' }),
                (P.items || []).length + (P.more || 0), pc, false));
        }
        var foot = el('div', 'vt-needs-acts vt-fv-foot');
        foot.appendChild(VTField.linkBtn(t('fv.open_dash'), supportUrl('#/')));
        root.appendChild(foot);
        if (sc) { sc.scrollTop = keepTop; }
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
        if (window.VTHub) { VTHub.refresh("field.attention"); VTHub.refresh("field.home"); }
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
        VTHub.on("agent.needs", render);
        VTHub.on("field.attention", render);
        VTHub.poll("field.attention", '/field/api/attention', FIELD_EVERY);
        /* the field's own words for people: stav + todo (one poller, shared
           with Support › Releases / Signal) */
        VTHub.on("field.home", render);
        /* what runs now + the watcher / Signal state (the field's 5 s "busy") */
        VTHub.on("field.now", render);
        VTHub.poll("field.now", '/field/api/activity/current', 15000);
        VTHub.poll("field.home", '/field/api/home', HOME_EVERY);
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
