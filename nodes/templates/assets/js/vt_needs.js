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
    var TITLE = 'Needs you';
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
        var asks = (window.VTHub && VTHub.get('agent.asks')) || null;
        var field = (window.VTHub && VTHub.get('field.attention')) || null;
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
        bell.setAttribute('aria-label', TITLE);
        bell.title = TITLE + ' — approvals and decisions waiting for you';
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
        bell.setAttribute('aria-label', m.n ? (TITLE + ': ' + m.n) : TITLE + ': nothing waits');
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
        var b = el('button', 'btn btn-outline-info vt-needs-btn', 'Review in Agent › Work');
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

    function render() {
        var m = model();
        paintBell(m);
        if (!panel || !active) { return; }
        var meta = document.getElementById('vt_needs_meta');
        if (meta) {
            meta.textContent = m.n ? (m.n + ' waiting') : 'nothing waits';
        }
        var root = panel.querySelector('.vt-needs-body');
        root.textContent = '';

        if (!m.n && m.fieldEntry && m.fieldEntry.ok) {
            root.appendChild(el('p', 'vt-empty-ok', 'Nothing waits for you.'));
        }

        /* robot agent */
        var ac = m.asks.map(function (x) {
            return card(x.moves ? 'err' : 'warn',
                { title: x.moves ? 'Movement needs your yes' : 'Approval', end: age(x.waiting_s) },
                x.what || 'The agent asks for a decision.', null,
                [['agent'], x.moves ? ['moves the robot', 'err'] : null].filter(Boolean),
                [agentBtn()]);
        });
        if (!m.askEntry) {
            ac = [el('p', 'vt-empty', 'Waiting for the agent…')];
        } else if (!ac.length) {
            ac = [el('p', 'vt-empty', 'No approvals waiting.')];
        }
        root.appendChild(group('agent', 'Robot agent', m.asks.length, ac));

        /* field kit */
        var fc;
        if (!m.fieldEntry) {
            fc = [el('span', 'vt-skel'), el('span', 'vt-skel vt-skel-short')];
        } else if (!m.fieldEntry.ok && !m.field.length) {
            fc = [el('p', 'vt-empty', 'Support dashboard not reachable (' + (m.fieldEntry.err || 'error') + ').')];
        } else {
            fc = m.field.map(function (x) {
                var p = x.plain || {};
                var rec = (p.options || []).filter(function (o) { return o.recommended; })[0];
                var chips = [[x.kind || 'item']];
                if (x.issue) { chips.push(['#' + x.issue, 'info']); }
                if (x.urgency === 'high') { chips.push(['urgent', 'err']); }
                if (rec && rec.motion) { chips.push(['motion', 'warn']); }
                var KIND = { 'human-step': 'Your step', decision: 'Decision', approve: 'Approval',
                             finding: 'Finding', test: 'Test', reply: 'Reply' };
                return card(x.urgency === 'high' ? 'err' : 'warn',
                    { title: KIND[x.kind] || 'Support', end: age(sinceSec(x.since)) },
                    p.headline || x.title || '', p.explain || x.why || '',
                    chips.concat(rec ? [['recommended: ' + (rec.label || '').slice(0, 60), 'ok']] : []),
                    [linkBtn('Open in Support', supportUrl(x.link))]);
            });
            if (!fc.length) { fc = [el('p', 'vt-empty', 'Nothing from Support.')]; }
            if (!m.fieldEntry.ok) {
                fc.unshift(el('p', 'vt-empty', 'Support not reachable — showing the last known list.'));
            }
        }
        root.appendChild(group('field', 'Support', m.field.length, fc));
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
        d.setAttribute('aria-hidden', 'false');
        if (title) { title.textContent = TITLE; }
        var metaSlot = document.getElementById('ui_drawer_meta');
        var meta = document.getElementById('vt_needs_meta');
        if (metaSlot && meta) { metaSlot.appendChild(meta); }
        if (mm) { mm._drawer_last = 'needs'; if (mm.set_drawer_full) { mm.set_drawer_full(lsGet('vitulus_drawer_full_needs') === '1'); } }
        var bd = document.getElementById('ui_drawer_backdrop');
        if (bd) { bd.style.display = window.innerWidth < 576 ? 'block' : 'none'; }
        active = true;
        lsSet('vitulus_needs_open', '1');
        if (window.VTHub) { VTHub.refresh('field.attention'); }
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
    function toggle() { if (active) { deactivate(true); } else { open(); } }
    function watchDrawer() {
        var d = document.getElementById('ui_drawer'), title = document.getElementById('ui_drawer_title');
        if (d) {
            new MutationObserver(function () {
                if (active && !d.classList.contains('open')) { deactivate(false); }
            }).observe(d, { attributes: true, attributeFilter: ['class'] });
        }
        if (title) {
            new MutationObserver(function () {
                if (active && title.textContent !== TITLE) { deactivate(false); }
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
        VTHub.on('agent.asks', render);
        VTHub.on('field.attention', render);
        VTHub.poll('field.attention', '/field/api/attention', FIELD_EVERY);
        setInterval(function () { if (active) { render(); } }, 30000);   // ages tick
        if (lsGet('vitulus_needs_open') === '1') { setTimeout(open, 1500); }
        window.VTNeeds = { open: open, close: function () { deactivate(true); }, toggle: toggle };
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
