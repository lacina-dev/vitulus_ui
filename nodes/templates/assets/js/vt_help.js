/* vt_help.js — Help: the robot's and the UI's documentation, drawn in the UI.
 *
 * ONE source: the Markdown files in docs/help/*.md (served read-only by the
 * webnode at /help/docs.json, images at /help/img/). Nothing of the help text
 * lives in this file — edit the .md, restart the webnode, done. How to keep it
 * current: docs/help/README.md (+ tools/test_help_docs.node.js).
 *
 * Where it shows (never on its own — only when someone asks):
 *   - the small "?" in the head of the left panel  → the topic of the panel
 *     AND its open tab (front matter "ui:" of a .md says which keys it covers)
 *   - "?" in the navbar (PC)                       → the same, or the topic list
 *   - "?" in the right panel's Navi section head, the log toolbar
 *   - Support › Help                               → the topic list
 * PC / landscape: a pane on the right edge of the C frame (over the right
 * panel; the joystick stays reachable). Phone portrait: a sheet over the
 * panel sheet. Esc or ✕ closes it; the map and the left panel stay usable.
 *
 * window.VTHelp = { open(keyOrTopic, anchor), close(), toggle(), contextKey(),
 *                   topics(cb), cards(onPick) }
 */
(function () {
    'use strict';
    var MD = window.VTHelpMd;
    var I = window.VTI18n;
    function t(k, v) { return I ? I.t(k, v) : k; }
    function lang() { return I ? I.lang() : 'en'; }
    /* group names stay English in the front matter (they are keys); the
       pane shows them in the UI language */
    var GROUPS = ['Start here', 'Robot', 'Using the UI', 'When something is wrong'];
    var GROUP_KEY = { 'Start here': 'help.group.start', 'Robot': 'help.group.robot',
                      'Using the UI': 'help.group.ui', 'When something is wrong': 'help.group.wrong' };
    function groupName(g) { return GROUP_KEY[g] ? t(GROUP_KEY[g]) : g; }
    var docs = null, byId = {}, uiMap = {}, loading = null, docsLang = null;
    var pane, body, search, backBtn, title;
    var history = [], cur = null, ctxKey = null, opener = null;

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    function $(id) { return document.getElementById(id); }
    /* a text that follows the UI language (vt_i18n.js re-applies data-i18n*) */
    function tagT(e, key, attr) {
        if (I) { return I.tag(e, key, attr); }
        if (attr) { e.setAttribute(attr, key); } else { e.textContent = key; }
        return e;
    }

    /* --------------------------------------------------------- the docs */
    /* docs/help/*.md in English + docs/help/<lang>/*.md for the UI language
       (VTHelpMd.merge: a translation replaces its topic, the rest stays EN) */
    function load(cb) {
        if (docs && docsLang !== lang()) { docs = null; byId = {}; uiMap = {}; }
        if (docs) { cb(docs); return; }
        if (loading) { loading.push(cb); return; }
        loading = [cb];
        var want = lang();
        fetch('/help/docs.json' + (want !== 'en' ? '?lang=' + encodeURIComponent(want) : ''), { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            return r.json();
        }).then(function (j) {
            var base = (j.docs || []).map(function (d) { return MD.parse(d.file, d.text); });
            var tr = (j.translations || []).map(function (d) { return MD.parse(d.file, d.text); });
            docs = MD.merge ? MD.merge(base, tr, j.lang || 'en') : base;
            docsLang = want;
            docs.sort(function (a, b) { return (a.meta.order || 999) - (b.meta.order || 999) || a.meta.title.localeCompare(b.meta.title); });
            docs.forEach(function (d) {
                byId[d.id] = d;
                d.meta.ui.forEach(function (k) {
                    var p = k.split('#');
                    if (!uiMap[p[0]]) { uiMap[p[0]] = { id: d.id, anchor: p[1] || '' }; }
                });
            });
        }).catch(function (e) {
            docs = [];
            docs.error = String(e && e.message || e);
            docsLang = want;
        }).then(function () {
            var q = loading; loading = null;
            q.forEach(function (f) { f(docs); });
        });
    }

    /* ----------------------------------------------- what is open now */
    var PANEL_HOST = { marker: 'div_menu_marker', map: 'div_menu_map', program: 'div_menu_map_program',
                       config: 'div_menu_config', editor: 'div_map_detail' };
    function contextKey() {
        var d = $('ui_drawer');
        if (!d || !d.classList.contains('open')) { return null; }
        if (window.VAgent && VAgent.isVisible && VAgent.isVisible()) {
            var at = document.querySelector('#vagent_tabs .vagent-tab.active');
            return 'agent' + (at && at.dataset.tab ? '/' + at.dataset.tab : '');
        }
        var np = $('vt_needs_panel');
        if (np && np.style.display !== 'none') { return 'needs'; }
        var sp = $('vt_support_panel');
        if (sp && sp.style.display !== 'none') {
            var st = window.VTSupport && VTSupport.tab ? VTSupport.tab() : '';
            return 'support' + (st ? '/' + st : '');
        }
        var mm = window.map_menu, key = mm && mm._drawer_last;
        if (!key) { return null; }
        var host = $(PANEL_HOST[key]);
        var act = host && host.querySelector('.tab-content > .tab-pane.active');
        return key + (act && act.id ? '/' + tabKey(act.id) : '');
    }
    function tabKey(paneId) { return String(paneId).replace(/^tab[-_]/, ''); }
    /* "map/dock" → its topic; else the panel's topic ("map"); else null */
    function resolve(key) {
        if (!key) { return null; }
        if (byId[key]) { return { id: key, anchor: '' }; }
        if (uiMap[key]) { return uiMap[key]; }
        var p = key.split('/')[0];
        return uiMap[p] || null;
    }

    /* ------------------------------------------------------------ views */
    function card(d, onPick) {
        var b = el('button', 'vth-card');
        b.type = 'button';
        var t = el('span', 'vth-card-t');
        if (d.meta.icon) { t.appendChild(el('i', 'la ' + d.meta.icon)); }
        t.appendChild(document.createTextNode(d.meta.title));
        b.appendChild(t);
        if (d.meta.summary) { b.appendChild(el('span', 'vth-card-s', d.meta.summary)); }
        b.addEventListener('click', function () { onPick(d.id); });
        return b;
    }
    function cardsByGroup(onPick) {
        var frag = document.createDocumentFragment();
        var groups = GROUPS.slice();
        docs.forEach(function (d) { if (d.meta.group && groups.indexOf(d.meta.group) < 0) { groups.push(d.meta.group); } });
        groups.forEach(function (g) {
            var list = docs.filter(function (d) { return (d.meta.group || 'Robot') === g; });
            if (!list.length) { return; }
            frag.appendChild(el('h3', 'vth-grp', groupName(g)));
            var grid = el('div', 'vth-cards');
            list.forEach(function (d) { grid.appendChild(card(d, onPick)); });
            frag.appendChild(grid);
        });
        return frag;
    }
    function foot(extra) {
        var f = el('div', 'vth-foot');
        f.appendChild(document.createTextNode(t('help.foot.doc')));
        f.appendChild(el('code', null, extra || 'docs/help/'));
        f.appendChild(document.createTextNode(t('help.foot.kit')));
        var a = el('a', null, t('help.foot.link'));
        a.href = 'https://' + location.hostname + ':8790/#/help'; a.target = '_blank'; a.rel = 'noopener';
        f.appendChild(a);
        return f;
    }
    function showHome() {
        cur = null;
        backBtn.hidden = true;
        body.textContent = '';
        if (docs.error) {
            body.appendChild(el('p', 'vth-empty', t('help.error', { err: docs.error })));
            return;
        }
        var ctx = resolve(ctxKey);
        if (ctx && byId[ctx.id]) {
            var box = el('div', 'vth-ctx');
            box.appendChild(el('span', 'vth-ctx-lab', t('help.ctx')));
            box.appendChild(card(byId[ctx.id], function () { go(ctx.id, ctx.anchor); }));
            body.appendChild(box);
        } else {
            body.appendChild(el('p', 'vth-intro', t('help.intro')));
        }
        body.appendChild(cardsByGroup(function (id) { go(id); }));
        body.appendChild(foot());
        body.scrollTop = 0;
    }
    function showDoc(id, anchor) {
        var d = byId[id];
        if (!d) { showHome(); return; }
        cur = { id: id, anchor: anchor || '' };
        backBtn.hidden = false;
        body.textContent = '';
        var cr = el('div', 'vth-crumb');
        var hb = el('button', null, t('help.all')); hb.type = 'button';
        hb.addEventListener('click', function () { history.push(cur); showHome(); });
        cr.appendChild(hb);
        cr.appendChild(document.createTextNode('›  ' + groupName(d.meta.group || '')));
        body.appendChild(cr);
        body.appendChild(el('h2', 'vth-h-title', d.meta.title));
        if (d.meta.summary) { body.appendChild(el('p', 'vth-sum', d.meta.summary)); }
        if (d.untranslated) { body.appendChild(el('p', 'vth-sum vth-untr', t('help.untranslated'))); }
        var h2 = d.headings.filter(function (h) { return h.level === 2; });
        if (h2.length >= 3) {
            var toc = el('div', 'vth-toc');
            h2.forEach(function (h) {
                var b = el('button', null, h.text); b.type = 'button';
                b.addEventListener('click', function () { jump(h.id); });
                toc.appendChild(b);
            });
            body.appendChild(toc);
        }
        var doc = el('div', 'vth-doc');
        doc.innerHTML = d.html;          // escaped by vt_help_md.js (no raw HTML from files)
        body.appendChild(doc);
        if (d.meta.related.length) {
            var rel = el('div', 'vth-ctx');
            rel.appendChild(el('span', 'vth-ctx-lab', t('help.related')));
            var g = el('div', 'vth-cards');
            d.meta.related.forEach(function (r) { if (byId[r]) { g.appendChild(card(byId[r], function () { go(r); })); } });
            rel.appendChild(g);
            body.appendChild(rel);
        }
        body.appendChild(foot('docs/help/' + (d.lang && d.lang !== 'en' ? d.lang + '/' : '') + d.file));
        body.scrollTop = 0;
        if (anchor) { setTimeout(function () { jump(anchor); }, 30); }
    }
    function jump(anchor) {
        var t = body.querySelector('#vth-' + (window.CSS && CSS.escape ? CSS.escape(anchor) : anchor));
        if (!t) { return; }
        try { t.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { t.scrollIntoView(); }
        t.classList.remove('vth-flash'); void t.offsetWidth; t.classList.add('vth-flash');
    }
    function go(id, anchor) {
        if (cur || body.firstChild) { history.push(cur); }
        if (history.length > 30) { history.shift(); }
        search.value = '';
        showDoc(id, anchor);
    }
    function back() {
        var prev = history.pop();
        if (prev && prev.id) { showDoc(prev.id, prev.anchor); } else { showHome(); }
    }

    /* ---------------------------------------------------------- search */
    /* highlight every searched word (folded match, original text kept) */
    function mark(text, words) {
        var f = MD.fold(text), spans = [];
        words.forEach(function (w) {
            var i = 0;
            while (w && (i = f.indexOf(w, i)) >= 0) { spans.push([i, i + w.length]); i += w.length; }
        });
        spans.sort(function (a, b) { return a[0] - b[0]; });
        var frag = document.createDocumentFragment(), at = 0;
        spans.forEach(function (s) {
            if (s[0] < at) { return; }
            frag.appendChild(document.createTextNode(text.slice(at, s[0])));
            frag.appendChild(el('mark', null, text.slice(s[0], s[1])));
            at = s[1];
        });
        frag.appendChild(document.createTextNode(text.slice(at)));
        return frag;
    }
    /* ~150 characters around the first hit, cut at word boundaries */
    function snippet(txt, w) {
        var at = MD.fold(txt).indexOf(w);
        if (at < 0 || txt.length <= 160) { return txt.length > 160 ? txt.slice(0, txt.lastIndexOf(' ', 155)) + '…' : txt; }
        var from = Math.max(0, at - 50);
        if (from) { var sp = txt.indexOf(' ', from); from = sp >= 0 && sp < at ? sp + 1 : from; }
        var to = Math.min(txt.length, from + 160);
        if (to < txt.length) { var e = txt.lastIndexOf(' ', to); to = e > at ? e : to; }
        return (from ? '…' : '') + txt.slice(from, to) + (to < txt.length ? '…' : '');
    }
    function runSearch() {
        var raw = search.value.trim();
        if (raw.length < 2) { if (cur) { showDoc(cur.id, ''); } else { showHome(); } return; }
        var words = MD.fold(raw).split(/\s+/).filter(Boolean);
        var hits = [];
        docs.forEach(function (d) {
            var kw = MD.fold(d.meta.title + ' ' + (d.meta.summary || '') + ' ' + d.meta.keywords.join(' '));
            d.blocks.forEach(function (b, bi) {
                var hay = MD.fold(b.heading + ' ' + b.text);
                var score = 0;
                var all = words.every(function (w) {
                    var inH = MD.fold(b.heading).indexOf(w) >= 0, inT = hay.indexOf(w) >= 0, inK = kw.indexOf(w) >= 0;
                    if (inH) { score += 5; } if (inK) { score += bi === 0 ? 3 : 1; } if (inT) { score += 1; }
                    return inH || inT || inK;
                });
                if (all) { hits.push({ d: d, b: b, score: score }); }
            });
        });
        hits.sort(function (a, b) { return b.score - a.score; });
        body.textContent = '';
        if (!hits.length) {
            body.appendChild(el('p', 'vth-empty', t('help.nothing', { q: raw })));
            return;
        }
        var ul = el('ul', 'vth-hits');
        hits.slice(0, 30).forEach(function (h) {
            var li = el('li', 'vth-hit'), b = el('button'); b.type = 'button';
            var t = el('span', 'vth-hit-t');
            t.appendChild(mark(h.b.heading || h.d.meta.title, words));
            if (h.b.heading && h.b.heading !== h.d.meta.title) { t.appendChild(el('small', null, '  · ' + h.d.meta.title)); }
            b.appendChild(t);
            var s = el('span', 'vth-hit-s'); s.appendChild(mark(snippet(h.b.text, words[0]), words));
            b.appendChild(s);
            b.addEventListener('click', function () { go(h.d.id, h.b.id); });
            li.appendChild(b); ul.appendChild(li);
        });
        body.appendChild(ul);
    }

    /* ----------------------------------------------------- the pane */
    function sheetMode() { return window.innerWidth < 576; }
    function build() {
        pane = el('aside');
        pane.id = 'vt_help';
        pane.setAttribute('role', 'complementary');
        tagT(pane, 'help.title', 'aria-label');
        pane.setAttribute('aria-hidden', 'true');
        var grip = el('button', 'vth-grip'); grip.type = 'button';
        tagT(grip, 'help.full', 'aria-label');
        grip.addEventListener('click', function () { pane.classList.toggle('vth-full'); });
        pane.appendChild(grip);
        var head = el('div', 'vth-head');
        backBtn = el('button', 'vth-btn', '‹'); backBtn.type = 'button';
        tagT(backBtn, 'help.back', 'title'); tagT(backBtn, 'help.back', 'aria-label'); backBtn.hidden = true;
        backBtn.addEventListener('click', back);
        title = tagT(el('span', 'vth-title'), 'help.title');
        search = el('input', 'vth-search');
        search.type = 'search'; tagT(search, 'help.search', 'placeholder'); tagT(search, 'help.search', 'aria-label');
        search.addEventListener('input', runSearch);
        var x = el('button', 'vth-btn vth-close', '×'); x.type = 'button';
        tagT(x, 'help.close.tip', 'title'); tagT(x, 'help.close', 'aria-label');
        x.addEventListener('click', close);
        head.appendChild(backBtn); head.appendChild(title); head.appendChild(search); head.appendChild(x);
        pane.appendChild(head);
        body = el('div', 'vth-body'); body.tabIndex = -1;
        body.addEventListener('click', function (e) {
            var z = e.target.closest && e.target.closest('.vth-zoom .vth-img');
            if (z) { e.preventDefault(); zoom(z); return; }
            var a = e.target.closest && e.target.closest('a.vth-link');
            if (!a) { return; }
            e.preventDefault();
            var id = a.getAttribute('data-help'), an = a.getAttribute('data-anchor');
            if (!id && cur) { jump(an); return; }
            go(id, an);
        });
        pane.appendChild(body);
        document.body.appendChild(pane);
        // Esc closes help first (before the frame's Esc hides the left panel)
        document.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Escape' || !isOpen()) { return; }
            if (lightbox) { ev.stopPropagation(); ev.preventDefault(); unzoom(); return; }
            if (ev.target === search && search.value) { search.value = ''; runSearch(); ev.stopPropagation(); ev.preventDefault(); return; }
            var tg = ev.target && ev.target.tagName;
            if ((tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') && ev.target !== search) { return; }
            ev.stopPropagation(); ev.preventDefault();
            close();
        }, true);
        window.addEventListener('resize', function () { if (isOpen()) { pane.classList.toggle('vth-sheet', sheetMode()); } });
    }
    /* a help picture in full size over everything; click / Esc / ✕ closes */
    var lightbox = null;
    function zoom(img) {
        unzoom();
        lightbox = el('div', 'vth-lightbox');
        lightbox.setAttribute('role', 'dialog');
        lightbox.setAttribute('aria-label', img.alt || '');
        var big = el('img');
        big.src = img.currentSrc || img.src; big.alt = img.alt || '';
        lightbox.appendChild(big);
        var fc = img.parentNode && img.parentNode.querySelector('figcaption');
        if (fc) { var p = el('p'); p.textContent = fc.textContent; lightbox.appendChild(p); }
        var x = el('button', 'vth-btn', '×'); x.type = 'button';
        var cx = pane && pane.querySelector('.vth-close');
        x.setAttribute('aria-label', (cx && cx.getAttribute('aria-label')) || 'Close');
        lightbox.appendChild(x);
        lightbox.addEventListener('click', unzoom);
        document.body.appendChild(lightbox);
        x.focus();
    }
    function unzoom() { if (lightbox) { lightbox.remove(); lightbox = null; } }
    function isOpen() { return !!pane && pane.classList.contains('open'); }
    function paint() {
        var on = isOpen();
        ['btn_help', 'btn_ui_drawer_help'].forEach(function (id) { var b = $(id); if (b) { b.classList.toggle('vt-on', on); } });
    }
    function open(key, anchor) {
        if (!pane) { build(); }
        opener = document.activeElement;
        ctxKey = key === undefined ? contextKey() : key;
        pane.classList.toggle('vth-sheet', sheetMode());
        pane.classList.add('open');
        pane.setAttribute('aria-hidden', 'false');
        paint();
        load(function () {
            history = []; cur = null; search.value = '';
            var r = resolve(ctxKey);
            if (byId[ctxKey]) { showDoc(ctxKey, anchor); }
            else if (r && (anchor || ctxKey)) { showDoc(r.id, anchor || r.anchor); }
            else { showHome(); }
            try { body.focus({ preventScroll: true }); } catch (e) { /* old browser */ }
        });
    }
    function close() {
        if (!pane || !isOpen()) { return; }
        unzoom();
        pane.classList.remove('open', 'vth-full');
        pane.setAttribute('aria-hidden', 'true');
        paint();
        if (opener && opener.focus && document.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    }
    function toggle(key, anchor) {
        if (isOpen()) {
            var k = key === undefined ? contextKey() : key;
            if (k === ctxKey || !anchor && resolve(k) && cur && resolve(k).id === cur.id) { close(); return; }
        }
        open(key, anchor);
    }

    /* ------------------------------------------------- the "?" buttons */
    function qBtn(id, labelKey, onClick) {
        var b = el('button', 'vth-q', '?');
        if (id) { b.id = id; }
        b.type = 'button'; tagT(b, labelKey, 'title'); tagT(b, labelKey, 'aria-label');
        b.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); onClick(); });
        return b;
    }
    function install() {
        var head = $('ui_drawer_head'), full = $('btn_ui_drawer_full');
        if (head && !$('btn_ui_drawer_help')) {
            head.insertBefore(qBtn('btn_ui_drawer_help', 'help.q.panel', function () { toggle(); }), full || $('btn_ui_drawer_close'));
        }
        // the log toolbar: what Changes / ROS mean
        var tb = document.querySelector('#div_log_view .log-toolbar');
        if (tb && !tb.querySelector('.vth-q')) {
            var lb = qBtn(null, 'help.q.log', function () { toggle('log'); });
            lb.classList.add('vth-q-log');
            /* into the button row itself (2026-10-25): as a sibling of the row
               it fell onto a line of its own on a phone (a 40 px band with a
               lone "?"); in the row it ends the bar after the counter */
            var row = tb.querySelector('.log-toolbar-row');
            var ex = $('btn_log_expand');
            if (row) { row.appendChild(lb); }
            else if (ex && ex.parentNode === tb) { tb.insertBefore(lb, ex); } else { tb.appendChild(lb); }
        }
        // the right panel's Navi section: what the localization chips mean
        var tries = 0;
        (function rp() {
            var h = document.querySelector('#right_panel .rp-sec[data-sec="state"] > h5');
            if (h && !h.querySelector('.vth-q')) {
                var b = qBtn(null, 'help.q.state', function () { toggle('right/state'); });
                var caret = h.querySelector('.rp-caret');
                h.insertBefore(b, caret || null);
                // the GNSS section next to it: what the receiver card says
                var hg = document.querySelector('#right_panel .rp-sec[data-sec="gnss"] > h5');
                if (hg && !hg.querySelector('.vth-q')) {
                    var bg = qBtn(null, 'help.q.gnss', function () { toggle('right/gnss'); });
                    hg.insertBefore(bg, hg.querySelector('.rp-caret') || null);
                }
                // Controls and Mower: the same "?" so every head ends alike
                [['drive', 'help.q.drive', 'dock'], ['mower', 'help.q.mower', 'mowing']].forEach(function (d) {
                    var hx = document.querySelector('#right_panel .rp-sec[data-sec="' + d[0] + '"] > h5');
                    if (hx && !hx.querySelector('.vth-q')) {
                        var bx = qBtn(null, d[1], function () { toggle(d[2]); });
                        hx.insertBefore(bx, hx.querySelector('.rp-caret') || null);
                    }
                });
                return;
            }
            if (++tries < 20) { setTimeout(rp, 500); }
        })();
    }

    /* language switch: the next load() fetches that language; an open pane
       redraws the topic (or the list) it shows */
    function relang() {
        if (!docs || docsLang === lang()) { return; }
        docs = null; byId = {}; uiMap = {};
        if (!isOpen()) { return; }
        var at = cur;
        load(function () {
            history = [];
            search.value = '';
            if (at && byId[at.id]) { showDoc(at.id, ''); } else { showHome(); }
        });
    }
    function init() {
        if (!MD) { return; }
        install();
        if (I) { I.onChange(relang); }
        window.VTHelp = {
            open: open, close: close, toggle: toggle, contextKey: contextKey, isOpen: isOpen,
            topics: function (cb) { load(cb); },
            /* topic cards for other panels (Support › Help) */
            cards: function (onPick) {
                var box = el('div');
                load(function () {
                    if (docs.error) { box.appendChild(el('p', 'vt-empty', t('help.error.short'))); return; }
                    box.appendChild(cardsByGroup(onPick || function (id) { open(id); }));
                });
                return box;
            },
            _resolve: function (k) { return resolve(k); }
        };
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
