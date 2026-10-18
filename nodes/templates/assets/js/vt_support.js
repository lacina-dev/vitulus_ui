/* vt_support.js — the Support panel: the field kit inside the robot UI, and
 * the Help (U2, I3 + I4 of docs/UI_INTEGRATION_PLAN.md).
 *
 *   menu band  [ … Agent | ⛑ Support ]   opens the panel (last tab)
 *   navbar     [ ? ]  (≥ 576 px)          opens the help pane (vt_help.js) for
 *                                         the panel and tab open right now
 *   tabs       Issues · Releases · Signal · Help
 *
 * Issues / Releases / Signal read the field dashboard through the read-only
 * proxy (/field/api/issues, /field/api/home) via the shared hub; they poll
 * only while the panel is open. Nothing here writes: every card links to the
 * Support dashboard, where its guards are. Help lists the topics of
 * docs/help/*.md (vt_help.js) — the help text is NOT kept in this file; every
 * change of the UI updates those .md files (docs/help/README.md).
 */
(function () {
    'use strict';
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    var drawerTitle = '';   // the text this panel put into #ui_drawer_title
    var LS_TAB = 'vitulus_support_tab';
    var TABS = [['issues', 'app.field.tab.issues'], ['releases', 'app.field.tab.releases'], ['signal', 'app.field.tab.signal'], ['help', 'app.field.tab.help']];
    var panel = null, active = false, tab = 'issues';
    var panes = {}, tabLinks = {};
    var hlIssue = null, hlUntil = 0, hlScrolled = false;   // I6: the card to point at

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    function dash(path) { return 'https://' + location.hostname + ':8790/' + (path || '#/'); }
    function ago(iso) {
        var ms = typeof iso === 'number' ? iso * 1000 : Date.parse(iso);
        if (!iso || isNaN(ms)) { return ''; }
        var s = Math.max(0, (Date.now() - ms) / 1000);
        if (s < 90) { return t('common.ago.s', { n: Math.round(s) }); }
        if (s < 5400) { return t('common.ago.min', { n: Math.round(s / 60) }); }
        if (s < 129600) { return t('common.ago.h', { n: Math.round(s / 3600) }); }
        return t('common.ago.d', { n: Math.round(s / 86400) });
    }
    function linkBtn(label, href) {
        var b = el('a', 'btn btn-outline-info vt-needs-btn', label);
        b.href = href; b.target = '_blank'; b.rel = 'noopener';
        return b;
    }
    function card(state, title, end, main, sub, pills, acts) {
        var c = el('div', 'vt-card vt-needs-card');
        c.setAttribute('data-state', state);
        var h = el('div', 'vt-card-head');
        h.appendChild(el('span', 'vt-card-title', title));
        if (end) { h.appendChild(el('span', 'vt-end', end)); }
        c.appendChild(h);
        if (main) { c.appendChild(el('div', 'vt-needs-main', main)); }
        if (sub) { c.appendChild(el('div', 'vt-needs-sub', sub)); }
        if (pills && pills.length) {
            var p = el('div', 'vt-pills');
            pills.forEach(function (x) {
                if (!x) { return; }
                var s = el('span', 'vt-pill', x[0]);
                if (x[1]) { s.setAttribute('data-state', x[1]); }
                p.appendChild(s);
            });
            c.appendChild(p);
        }
        if (acts && acts.length) {
            var a = el('div', 'vt-needs-acts');
            acts.forEach(function (x) { a.appendChild(x); });
            c.appendChild(a);
        }
        return c;
    }
    function waitOr(entry, fn) {
        if (!entry) { return [el('span', 'vt-skel'), el('span', 'vt-skel vt-skel-short')]; }
        if (!entry.ok && !entry.data) {
            return [el('p', 'vt-empty', t('support.unreachable', { err: entry.err || t('support.err') }))];
        }
        var out = fn(entry.data);
        if (!entry.ok) { out.unshift(el('p', 'vt-empty', t('support.stale'))); }
        return out;
    }

    /* --------------------------------------------------------- Issues */
    var STAGE = { reported: 'support.stage.reported', assessed: 'support.stage.assessed', fixed: 'support.stage.fixed',
                  released: 'support.stage.released', tested: 'support.stage.tested', verified: 'support.stage.verified',
                  closed: 'support.stage.closed', test: 'support.stage.test' };
    var TURN = { owner: 'support.turn.owner', tester: 'support.turn.tester', agent: 'support.turn.agent', none: null,
                 you: 'support.turn.you' };
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function stageLabel(st) { return own(STAGE, st) ? t(STAGE[st]) : st; }
    function stageOf(i) {
        var p = i.pipeline || {};
        if (p.closed) { return 'closed'; }
        if (p.current) { return p.current; }
        var last = null;
        (p.steps || []).forEach(function (s) { if (s.state === 'done') { last = s.id; } });
        return last || 'reported';
    }
    function sevOf(i) {
        var l = (i.labels || []).filter(function (x) { return /^sev:/.test(x); })[0];
        return l ? l.slice(4) : null;
    }
    function issueCard(i) {
        var st = stageOf(i), sev = sevOf(i);
        var tone = i.state === 'CLOSED' ? 'off' : (i.waiting || i.mine ? 'warn' : (sev === 'critical' || sev === 'major' ? 'err' : 'info'));
        var turn = i.who_label || (own(TURN, i.turn) && TURN[i.turn] ? t(TURN[i.turn]) : null);
        var c = card(tone, '#' + i.number + ' · ' + (i.kind || t('support.kind.issue')), ago(i.last_change),
            i.title || '', i.status_text ? t('support.status', { s: i.status_text }) : null,
            [[stageLabel(st), st === 'released' || st === 'test' ? 'warn' : null],
             sev ? [sev, sev === 'critical' || sev === 'major' ? 'err' : null] : null,
             turn ? [t('support.turn', { who: turn }), 'info'] : null,
             i.motion ? [t('support.motion'), 'warn'] : null,
             i.agent_active ? [t('support.agent_working'), 'info'] : null],
            issueActs(i.number, i.title));
        c.dataset.issue = String(i.number);
        if (hlIssue === String(i.number) && Date.now() < hlUntil) { c.classList.add('vt-hl'); }
        return c;
    }
    /* I6: an issue links to the dashboard, the agent chat and its timeline */
    function issueActs(n, title) {
        var acts = [linkBtn(t('support.open'), dash('#/issue/' + n))];
        if (window.VTLinks) {
            acts.push(VTLinks.button(t('support.ask'), function () {
                VTLinks.askAgent(title ? t('support.ask.draft_title', { n: n, title: title }) : t('support.ask.draft', { n: n }));
            }, t('support.ask.tip')));
            acts.push(VTLinks.button(t('support.timeline'), function () { VTLinks.issueTimeline(n); },
                t('support.timeline.tip')));
        }
        return acts;
    }
    function renderIssues() {
        var pane = panes.issues; if (!pane) { return; }
        pane.textContent = '';
        waitOr(VTHub.get("field.issues"), function (d) {
            var all = d.issues || [];
            var open = all.filter(function (i) { return i.state !== 'CLOSED'; });
            var closed = all.filter(function (i) { return i.state === 'CLOSED'; }).slice(0, 10);
            var out = [];
            out.push(el('p', 'vt-needs-sub', t('support.issues.count', { open: open.length, all: all.length })));
            if (!open.length) { out.push(el('p', 'vt-empty-ok', t('support.issues.none'))); }
            open.forEach(function (i) { out.push(issueCard(i)); });
            if (closed.length) {
                var det = el('details', 'drawer-sec vt-needs-grp');
                var s = el('summary'); s.appendChild(el('span', 'vt-needs-gt', t('support.issues.closed')));
                s.appendChild(el('span', 'vt-needs-gn', String(closed.length)));
                det.appendChild(s);
                var b = el('div', 'drawer-sec-body vt-stack');
                closed.forEach(function (i) { b.appendChild(issueCard(i)); });
                det.appendChild(b);
                out.push(det);
            }
            out.push(linkBtn(t('support.issues.all'), dash('#/issues')));
            return out;
        }).forEach(function (x) { pane.appendChild(x); });
        var hit = hlIssue && pane.querySelector('.vt-needs-card[data-issue="' + hlIssue + '"]');
        if (hit && !hlScrolled) {
            hlScrolled = true;
            var det = hit.closest('details');
            if (det && !det.open) { det.open = true; }
            try { hit.scrollIntoView({ block: 'center' }); } catch (e) { hit.scrollIntoView(); }
        }
    }

    /* ------------------------------------------------------- Releases */
    function renderReleases() {
        var pane = panes.releases; if (!pane) { return; }
        pane.textContent = '';
        waitOr(VTHub.get("field.home"), function (d) {
            var f = d.footer || {}, w = f.watch || {}, out = [];
            out.push(card('info', t('support.rel.kit'), f.release || '',
                t('support.rel.kit_version', { v: f.kit_version || '?' }),
                w.available ? (w.result ? t('support.rel.watcher_result', { ago: ago(w.last_tick), result: w.result })
                                        : t('support.rel.watcher', { ago: ago(w.last_tick) })) : t('support.rel.no_watcher'),
                [[w.fresh ? t('support.rel.fresh') : t('support.rel.stale'), w.fresh ? 'ok' : 'warn']],
                [linkBtn(t('support.rel.history'), dash('#/history'))]));
            var stage = (d.velin && d.velin.stage_of) || {};
            var waiting = Object.keys(stage).filter(function (n) { return stage[n] === 'released' || stage[n] === 'test'; });
            var iss = {};
            ((VTHub.get("field.issues") || {}).data || { issues: [] }).issues.forEach(function (i) { iss[i.number] = i; });
            out.push(el('div', 'vt-act-day', t('support.rel.waiting')));
            if (!waiting.length) { out.push(el('p', 'vt-empty-ok', t('support.rel.none'))); }
            waiting.forEach(function (n) {
                var i = iss[n] || {};
                var rel = ((i.pipeline || {}).steps || []).filter(function (s) { return s.id === 'released'; })[0] || {};
                out.push(card('warn', '#' + n + (i.kind ? ' · ' + i.kind : ''), rel.when ? ago(rel.when) : '',
                    i.title || t('support.issue_n', { n: n }), rel.detail ? t('support.rel.release', { d: rel.detail }) : null,
                    [[stage[n] === 'test' ? t('support.stage.test') : t('support.stage.released'), 'warn']],
                    issueActs(n, i.title)));
            });
            var st = (d.velin && d.velin.stages) || {};
            var pills = Object.keys(st).filter(function (k) { return st[k]; }).map(function (k) { return [stageLabel(k) + ' ' + st[k]]; });
            if (pills.length) { out.push(card('off', t('support.rel.loop'), t('support.rel.open', { n: d.velin.open || 0 }), null, null, pills)); }
            return out;
        }).forEach(function (x) { pane.appendChild(x); });
    }

    /* --------------------------------------------------------- Signal */
    function renderSignal() {
        var pane = panes.signal; if (!pane) { return; }
        pane.textContent = '';
        waitOr(VTHub.get("field.home"), function (d) {
            var v = d.velin || {}, sg = v.signal || {}, out = [];
            (v.sides || []).forEach(function (s) {
                var ok = s.ok && s.kit_ok && s.signal === 'connected';
                out.push(card(ok ? 'ok' : 'warn',
                    t(s.me ? 'support.sig.title_me' : 'support.sig.title', { robot: s.robot || '?', role: s.role || '' }),
                    t('support.sig.heartbeat', { ago: ago(s.heartbeat_at) }),
                    s.login || '', t('support.sig.state', { state: s.state || '?', kit: s.kit || '?' }),
                    [[s.signal || t('support.sig.unknown'), s.signal === 'connected' ? 'ok' : 'warn'],
                     s.human ? [t('support.sig.human', { n: s.human }), 'warn'] : null,
                     s.errors_24h ? [t('support.sig.errors', { n: s.errors_24h }), 'err'] : null,
                     [t('support.sig.ready', { r: s.ready || '?' }), s.ready === 'pass' ? 'ok' : 'warn']]));
            });
            out.push(card('info', t('support.sig.phone'), sg.last_received ? t('support.sig.last', { ago: ago(sg.last_received) }) : '',
                null, t('support.sig.stats', { delay: sg.median_delay_s != null ? sg.median_delay_s + ' s' : '?',
                                               sent: sg.sent_24h || 0, recv: sg.received_24h || 0, rec: sg.reconnects || 0 }),
                null, [linkBtn(t('support.sig.open'), dash('#/signal'))]));
            return out;
        }).forEach(function (x) { pane.appendChild(x); });
    }

    /* ----------------------------------------------------------- Help */
    /* The help is the documentation in docs/help/*.md, drawn by vt_help.js
       (the same topics open from the "?" in every panel head). This tab only
       lists the topics; a click opens the help pane next to the panel. */
    function renderHelp() {
        var pane = panes.help; if (!pane) { return; }
        pane.textContent = '';
        if (!window.VTHelp) { pane.appendChild(el('p', 'vt-empty', t('support.help.none'))); return; }
        pane.appendChild(el('p', 'vt-needs-sub', t('support.help.intro')));
        pane.appendChild(VTHelp.cards(function (id) { VTHelp.open(id); }));
        var more = el('div', 'vt-needs-acts');
        more.appendChild(linkBtn(t('support.help.kit'), dash('#/help')));
        pane.appendChild(more);
    }

    /* ------------------------------------------------------- tabs/data */
    function showTab(id) {
        tab = id; lsSet(LS_TAB, id);
        paintBtn();
        TABS.forEach(function (tb) {
            panes[tb[0]].hidden = tb[0] !== id;
            tabLinks[tb[0]].classList.toggle('active', tb[0] === id);
            tabLinks[tb[0]].setAttribute('aria-selected', tb[0] === id ? 'true' : 'false');
        });
        render();
    }
    function render() {
        if (!active) { return; }
        ({ issues: renderIssues, releases: renderReleases, signal: renderSignal, help: renderHelp })[tab]();
    }
    function startData() {
        if (!window.VTHub) { return; }
        VTHub.poll("field.issues", '/field/api/issues', 60000);
        VTHub.poll("field.home", '/field/api/home', 60000);
    }
    function stopData() {
        if (!window.VTHub) { return; }
        VTHub.stop("field.issues");
        VTHub.stop("field.home");
    }

    function build() {
        panel = el('div', 'vt-support');
        panel.id = 'vt_support_panel';
        panel.style.display = 'none';
        var ul = el('ul', 'nav nav-tabs drawer-pills');
        ul.setAttribute('role', 'tablist');
        TABS.forEach(function (tb) {
            var li = el('li', 'nav-item'); li.setAttribute('role', 'presentation');
            var a = el('a', 'nav-link', t(tb[1]));
            if (window.VTI18n) { VTI18n.tag(a, tb[1]); }   // follows every language switch
            a.href = '#'; a.setAttribute('role', 'tab');
            a.addEventListener('click', function (e) { e.preventDefault(); showTab(tb[0]); });
            li.appendChild(a); ul.appendChild(li);
            tabLinks[tb[0]] = a;
        });
        panel.appendChild(ul);
        TABS.forEach(function (tb) {
            var p = el('div', 'vt-stack vt-support-pane');
            p.hidden = true;
            panes[tb[0]] = p;
            panel.appendChild(p);
        });
    }

    /* ----------------------------------- the shared drawer (as Needs you) */
    function settle(d) {
        if (!d || !d.getAnimations) { return; }
        var run = function () {
            d.getAnimations().forEach(function (a) {
                if (a.playState === 'running' && (!a.startTime || !a.currentTime)) { try { a.finish(); } catch (e) { /* gone */ } }
            });
        };
        if (window.requestAnimationFrame) { requestAnimationFrame(function () { requestAnimationFrame(run); }); }
        setTimeout(run, 120); setTimeout(run, 500);
    }
    function shown() {
        var d = document.getElementById('ui_drawer');
        if (!active || !d || !d.classList.contains('open')) { return false; }
        var r = d.getBoundingClientRect();
        return r.width > 0 && r.right > 40 && r.left > -40;
    }
    function open(wantTab) {
        var d = document.getElementById('ui_drawer'), body = document.getElementById('ui_drawer_body');
        var title = document.getElementById('ui_drawer_title');
        if (!d || !body) { return; }
        var mm = window.map_menu;
        if (window.VAgent && VAgent.isVisible && VAgent.isVisible()) { try { VAgent.close(); } catch (e) { /* ok */ } }
        if (window.VTNeeds && document.getElementById('vt_needs_panel') &&
            document.getElementById('vt_needs_panel').style.display !== 'none') { try { VTNeeds.close(); } catch (e) { /* ok */ } }
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
        if (title) { drawerTitle = t('support.title'); title.textContent = drawerTitle; }
        if (mm) { mm._drawer_last = 'support'; if (mm.set_drawer_full) { mm.set_drawer_full(lsGet('vitulus_drawer_full_support') === '1'); } }
        var bd = document.getElementById('ui_drawer_backdrop');
        if (bd) { bd.style.display = window.innerWidth < 576 ? 'block' : 'none'; }
        active = true;
        lsSet('vitulus_support_open', '1');
        paintBtn();
        startData();
        showTab(wantTab || tab);
    }
    function deactivate(slideOut) {
        if (!active) { return; }
        active = false;
        panel.style.display = 'none';
        lsSet('vitulus_support_open', '0');
        stopData();
        paintBtn();
        if (slideOut) {
            var mm = window.map_menu, d = document.getElementById('ui_drawer');
            if (mm && typeof mm._drawer_slide_out === 'function') { mm._drawer_slide_out(); }
            else if (d) { d.classList.remove('open', 'wide', 'editor', 'full'); d.setAttribute('aria-hidden', 'true'); }
            var bd = document.getElementById('ui_drawer_backdrop');
            if (bd) { bd.style.display = 'none'; }
        }
    }
    function toggle() { if (shown()) { deactivate(true); } else { active = false; open(); } }
    function openHelp() {
        if (window.VTHelp) { VTHelp.toggle(); return; }
        open('help');
    }
    function watchDrawer() {
        var d = document.getElementById('ui_drawer'), title = document.getElementById('ui_drawer_title');
        if (d) { new MutationObserver(function () { if (active && !d.classList.contains('open')) { deactivate(false); } }).observe(d, { attributes: true, attributeFilter: ['class'] }); }
        if (title) { new MutationObserver(function () { if (active && title.textContent !== drawerTitle) { deactivate(false); } }).observe(title, { childList: true, characterData: true, subtree: true }); }
        var fb = document.getElementById('btn_ui_drawer_full');
        if (fb) { fb.addEventListener('click', function () { if (active) { setTimeout(function () { lsSet('vitulus_drawer_full_support', d && d.classList.contains('full') ? '1' : '0'); }, 0); } }); }
        var xb = document.getElementById('btn_ui_drawer_close');
        if (xb) { xb.addEventListener('click', function () { if (active) { deactivate(true); } }); }
    }

    /* ----------------------------------------------------- the buttons */
    var menuBtn = null, helpBtn = null;
    function paintBtn() {
        if (menuBtn) { menuBtn.classList.toggle('vt-on', active); }
    }
    function installButtons() {
        var group = document.querySelector('#row_menu .btn-group');
        if (group && !document.getElementById('btn_support')) {
            menuBtn = el('button', 'btn btn-outline-info d-flex justify-content-center align-items-center all-events vt-support-btn');
            menuBtn.id = 'btn_support';
            menuBtn.type = 'button';
            menuBtn.title = t('support.btn.tip');
            menuBtn.setAttribute('aria-label', t('support.title'));
            menuBtn.dataset.label = t('support.title');    // vt_frame.js label anatomy (text next to the icon on a PC)
            if (window.VTI18n) { VTI18n.tag(menuBtn, 'support.btn.tip', 'title'); VTI18n.tag(menuBtn, 'support.title', 'aria-label'); }
            menuBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M6 6l3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5"/></svg>';
            menuBtn.addEventListener('click', toggle);
            var agent = document.getElementById('btn_agent');
            if (agent && agent.parentNode === group) { group.insertBefore(menuBtn, agent.nextSibling); }
            else { group.appendChild(menuBtn); }
        }
        var bell = document.getElementById('btn_needs');
        var toggler = document.getElementById('btn_navbar_toggler');
        if (!document.getElementById('btn_help') && toggler) {
            helpBtn = el('button', 'vt-help-btn', '?');
            helpBtn.id = 'btn_help';
            helpBtn.type = 'button';
            helpBtn.title = t('support.help.tip');
            helpBtn.setAttribute('aria-label', t('common.help'));
            if (window.VTI18n) { VTI18n.tag(helpBtn, 'support.help.tip', 'title'); VTI18n.tag(helpBtn, 'common.help', 'aria-label'); }
            helpBtn.addEventListener('click', openHelp);
            toggler.parentNode.insertBefore(helpBtn, bell && bell.parentNode === toggler.parentNode ? bell : toggler);
        }
    }

    function init() {
        if (!window.VTHub) { return; }
        tab = lsGet(LS_TAB) || 'issues';
        if (!TABS.some(function (tb) { return tb[0] === tab; })) { tab = 'issues'; }
        build();
        watchDrawer();
        var tries = 0;
        (function wait() {   // the agent button is created by agent_chat.js — land after it
            if (document.getElementById('btn_agent') || ++tries > 20) { installButtons(); return; }
            setTimeout(wait, 250);
        })();
        VTHub.on("field.issues", function () { if (active && (tab === 'issues' || tab === 'releases')) { render(); } });
        VTHub.on("field.home", function () { if (active && (tab === 'releases' || tab === 'signal')) { render(); } });
        if (lsGet('vitulus_support_open') === '1') { setTimeout(function () { open(); }, 1600); }
        if (window.VTI18n) {
            VTI18n.onChange(function () {   // live language switch: drawer title, the menu label, the open tab
                var tt = document.getElementById('ui_drawer_title');
                if (active && tt) { drawerTitle = t('support.title'); tt.textContent = drawerTitle; }
                if (menuBtn) { menuBtn.dataset.label = t('support.title'); }
                render();
            });
        }
        window.VTSupport = { open: open, close: function () { deactivate(true); }, toggle: toggle, help: openHelp,
            tab: function () { return active ? tab : null; },
            /* I6: open Issues and point at card #n (survives the refresh that follows opening) */
            showIssue: function (n) {
                hlIssue = String(n).replace(/\D/g, ''); hlUntil = Date.now() + 4000; hlScrolled = false;
                open('issues');
            } };
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
