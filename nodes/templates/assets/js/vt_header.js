/* vt_header.js — the header of the robot UI (owner 2026-10-25, variant A
 * "three zones"; docs/UI_LAYOUT.md "Navbar", help: docs/help/frame.md).
 *
 * Layouts (class on <body>, --navbar-h):
 *   vt-h-pc   PC / tablet: navbar 44 px + menu band 36 px.
 *             left   logo + connection dot (fixed 172 px), status icons from a
 *                    fixed x (status_header.js);
 *             right  system monitor in fixed slots · ? · bell · Restart · ⋯,
 *                    ending at the round STOP in the top-right corner
 *                    (vt_frame.js; the rows keep --vt-stop-zone free).
 *             Narrowing, never wrapping (vt_header.css):
 *               < 1600  network ↓ only            (vt-h-w1600)
 *               < 1366  system as a chip + card    (vt-h-w1366)
 *               < 1280  menu icons only            (vt-h-w1280)
 *               < 1100  one icon per status group  (vt-h-w1100 → vt-h-sum)
 *             Logo, dot, ?, bell, ⋯ and STOP are never hidden.
 *   vt-h-ph   phone upright (< 576 px): navbar 52 (logo, dot, bell, Restart,
 *             ⋯, STOP) + menu 44 + icons 28 + notices 28 = 152 px;
 *             ? and the system are in ⋯.
 *   vt-h-row  low window (height < 500, phone on its side): ONE row of 44 px —
 *             dot · the panel buttons (#row_menu moves into the navbar) · one
 *             icon per status group · bell · Restart · ⋯; the logo, ? and the
 *             system are in ⋯; the STOP heads the right column.
 *
 * Built here: the Restart icon (#btn_robot_restart, the confirmation of
 * app.js), the ⋯ button + its menu (#vt_hdr_menu: Fullscreen, language,
 * and where the header has no room: logo, ?, system), the divider; the
 * notice's full text as its tooltip (the notice is one line with an ellipsis).
 * Other modules add their own header buttons (help: vt_support.js, bell:
 * vt_needs.js); their place on screen is CSS `order`, not the DOM order.
 * Pure layout + two menus: no ROS, publishes nothing.
 */
(function () {
    'use strict';
    if (window.VTHeader) { return; }
    var SHEET_MAX_W = 576, ROW_MAX_H = 500;
    var NAV_H = {pc: 44, ph: 52, row: 44};

    function $(id) { return document.getElementById(id); }
    function tr(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tag(e, k, attr) { if (window.VTI18n) { VTI18n.tag(e, k, attr); } }
    function setCls(el, c, on) { if (el && el.classList.contains(c) !== !!on) { el.classList.toggle(c, !!on); } }
    function el(t, cls, txt) {
        var e = document.createElement(t);
        if (cls) { e.className = cls; }
        if (txt != null) { e.textContent = txt; }
        return e;
    }

    function layout() {
        var W = window.innerWidth, H = window.innerHeight;
        if (W < SHEET_MAX_W) { return 'ph'; }
        if (H < ROW_MAX_H) { return 'row'; }
        return 'pc';
    }

    var SVG = {
        power: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3.5v8"/><path d="M6.6 7.2a7.6 7.6 0 1 0 10.8 0"/></g></svg>',
        more: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></g></svg>',
        help: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.6"/></g><circle cx="12" cy="16.9" r="1.1" fill="currentColor"/></svg>',
        expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        compress: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        lang: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/></g></svg>'
    };

    /* ------------------------------------------------ the tools */
    var row = null, more = null, menu = null, restart = null, vdiv = null;
    function ensureTools() {
        row = document.querySelector('#div_menu .vt-hdr-row');
        if (!row) { return false; }
        if (!vdiv) {
            vdiv = el('span', 'vt-hdr-vdiv');
            vdiv.setAttribute('aria-hidden', 'true');
        }
        if (vdiv.parentNode !== row) { row.appendChild(vdiv); }
        if (!restart) {
            restart = el('button', 'vt-hdr-tb vt-hdr-restart');
            restart.type = 'button';
            restart.id = 'btn_robot_restart';
            restart.innerHTML = SVG.power;
            restart.title = tr('appjs.restart.tip');
            restart.setAttribute('aria-label', tr('appjs.restart.tip'));
            tag(restart, 'appjs.restart.tip', 'title');
            tag(restart, 'appjs.restart.tip', 'aria-label');
            restart.addEventListener('click', function (e) {
                e.preventDefault();
                closeMenu();
                if (window.VTApp && window.VTApp.restart) { window.VTApp.restart(); }
            });
        }
        if (restart.parentNode !== row) { row.appendChild(restart); }
        if (!more) {
            more = el('button', 'vt-hdr-tb vt-hdr-more');
            more.type = 'button';
            more.id = 'btn_hdr_more';
            more.innerHTML = SVG.more + '<i class="vt-hdr-more-dot" aria-hidden="true"></i>';
            more.title = tr('hdr.more.tip');
            more.setAttribute('aria-label', tr('hdr.more.tip'));
            more.setAttribute('aria-haspopup', 'menu');
            more.setAttribute('aria-expanded', 'false');
            tag(more, 'hdr.more.tip', 'title');
            tag(more, 'hdr.more.tip', 'aria-label');
            more.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleMenu(); });
        }
        if (more.parentNode !== row) { row.appendChild(more); }
        // ? as the same kind of icon button as its neighbours (vt_support.js builds it)
        var help = $('btn_help');
        if (help && !help.classList.contains('vt-hdr-tb')) {
            help.classList.add('vt-hdr-tb');
            help.innerHTML = SVG.help;
        }
        var bell = $('btn_needs');
        if (bell && !bell.classList.contains('vt-hdr-tb')) { bell.classList.add('vt-hdr-tb'); }
        return true;
    }

    /* ------------------------------------------------ the ⋯ menu */
    function buildMenu() {
        if (menu) { return menu; }
        menu = el('div', 'vt-hdr-menu');
        menu.id = 'vt_hdr_menu';
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        document.body.appendChild(menu);
        document.addEventListener('click', function (e) {
            if (!menu.hidden && !menu.contains(e.target) && e.target !== more) { closeMenu(); }
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); } });
        window.addEventListener('resize', function () { if (!menu.hidden) { placeMenu(); } });
        document.addEventListener('vt:fullscreen', function () { if (!menu.hidden) { fillMenu(); } });
        return menu;
    }
    function item(icon, labelKey, onClick, extra) {
        var b = el('button', 'vt-hdr-mi' + (extra ? ' ' + extra : ''));
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.innerHTML = '<span class="vt-hdr-mi-ico" aria-hidden="true">' + (icon || '') + '</span>';
        var l = el('span', 'vt-hdr-mi-l', tr(labelKey));
        b.appendChild(l);
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(b); });
        return b;
    }
    function fillMenu() {
        var L = layout();
        menu.textContent = '';
        if (L === 'row') {
            var head = el('div', 'vt-hdr-mhead');
            head.innerHTML = '<img src="assets/img/vitulusShape.svg" width="95" height="22" alt="VITULUS">';
            menu.appendChild(head);
        }
        if (L !== 'pc') {
            menu.appendChild(item(SVG.help, 'hdr.menu.help', function () {
                closeMenu();
                if (window.VTSupport && window.VTSupport.help) { window.VTSupport.help(); }
                else if ($('btn_help')) { $('btn_help').click(); }
            }));
        }
        if (window.VTApp && window.VTApp.fsSupported && window.VTApp.fsSupported()) {
            var on = window.VTApp.isFs();
            menu.appendChild(item(on ? SVG.compress : SVG.expand, on ? 'appjs.fs.exit' : 'appjs.fs', function () {
                closeMenu();
                window.VTApp.toggleFs();
            }));
        }
        // language: the same choice as Settings › App (saved on the robot)
        var lg = el('div', 'vt-hdr-mlang');
        lg.setAttribute('role', 'group');
        var lab = el('span', 'vt-hdr-mi-ico');
        lab.innerHTML = SVG.lang;
        lg.appendChild(lab);
        var ll = el('span', 'vt-hdr-mi-l', tr('hdr.menu.lang'));
        lg.appendChild(ll);
        var seg = el('span', 'vt-hdr-seg');
        var cur = window.VTI18n ? VTI18n.lang() : 'en';
        (window.VTI18n ? VTI18n.langs() : [{code: 'en', name: 'English'}]).forEach(function (x) {
            var b = el('button', 'vt-hdr-segb', x.code.toUpperCase());
            b.type = 'button';
            b.title = x.name;
            b.setAttribute('aria-label', x.name);
            b.setAttribute('aria-pressed', x.code === cur ? 'true' : 'false');
            b.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                if (window.VTI18n && x.code !== VTI18n.lang()) { VTI18n.setLang(x.code); }
                fillMenu();
            });
            seg.appendChild(b);
        });
        lg.appendChild(seg);
        menu.appendChild(lg);
        if (L !== 'pc' && window.VTSys && window.VTSys.section) {
            var sys = el('div', 'vt-hdr-msys');
            sys.appendChild(window.VTSys.section());
            menu.appendChild(sys);
        }
    }
    function placeMenu() {
        if (!more || !menu) { return; }
        var r = more.getBoundingClientRect();
        var w = menu.offsetWidth || 240;
        var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
        menu.style.left = Math.round(left) + 'px';
        menu.style.top = Math.round(r.bottom + 6) + 'px';
        menu.style.maxHeight = Math.max(160, window.innerHeight - r.bottom - 14) + 'px';
    }
    function openMenu() {
        buildMenu();
        if (window.VTSys && window.VTSys.closeCard) { window.VTSys.closeCard(); }
        fillMenu();
        menu.hidden = false;
        more.setAttribute('aria-expanded', 'true');
        setCls(more, 'vt-on', true);
        placeMenu();
        var f = menu.querySelector('button');
        if (f && f.focus) { try { f.focus({preventScroll: true}); } catch (e) { /* old browser */ } }
    }
    function closeMenu() {
        if (!menu || menu.hidden) { return; }
        menu.hidden = true;
        if (more) { more.setAttribute('aria-expanded', 'false'); setCls(more, 'vt-on', false); }
    }
    function toggleMenu() { if (menu && !menu.hidden) { closeMenu(); } else { openMenu(); } }

    /* ------------------------------------------------ the menu band */
    /* Low window: the panel buttons are part of the one header row. The
       whole #row_menu moves (every module still finds '#row_menu .btn-group'
       and the row's bottom edge is the header's), and back on a taller one. */
    var rmHome = null;
    function placeMenuBand(L) {
        var rm = $('row_menu');
        if (!rm || !row) { return; }
        if (L === 'row') {
            if (!rmHome) {
                rmHome = document.createElement('span');
                rmHome.id = 'row_menu_home';
                rmHome.style.display = 'none';
                rm.parentNode.insertBefore(rmHome, rm);
            }
            if (rm.parentNode !== row) { row.appendChild(rm); }
        } else if (rmHome && rm.parentNode === row) {
            rmHome.parentNode.insertBefore(rm, rmHome);
        }
    }

    /* ------------------------------------------------ the notice: one line */
    function wireNotice() {
        var info = $('span_status_info');
        if (!info || !window.MutationObserver) { return; }
        var sync = function () {
            var txt = (info.textContent || '').replace(/\s+/g, ' ').trim();
            if (info.title !== txt) { info.title = txt; }
        };
        sync();
        new MutationObserver(sync).observe(info, {childList: true, characterData: true, subtree: true});
    }

    /* the agent's pills are cut to their slot: the whole text is the tooltip */
    function wireBars(tries) {
        var bars = $('vagent_bars');
        if (!bars) { if (tries < 40) { setTimeout(function () { wireBars(tries + 1); }, 500); } return; }
        if (!window.MutationObserver) { return; }
        var sync = function () {
            ['vagent_unlocked', 'vagent_panic'].forEach(function (id) {
                var e = $(id);
                if (!e) { return; }
                var txt = (e.textContent || '').replace(/\s+/g, ' ').trim();
                if (e.title !== txt) { e.title = txt; }
            });
        };
        sync();
        new MutationObserver(sync).observe(bars, {childList: true, characterData: true, subtree: true});
    }

    /* the system's worst colour also tints the ⋯ button on a phone, where the
       numbers live in the menu (status_header.js calls this) */
    function sysTone(t) {
        if (more) { more.dataset.sys = t; }
    }

    var lastKey = '';
    function apply() {
        var body = document.body;
        if (!body) { return; }
        var W = window.innerWidth;
        var L = layout();
        var pc = L === 'pc';
        setCls(body, 'vt-hdr', true);
        setCls(body, 'vt-h-pc', pc);
        setCls(body, 'vt-h-ph', L === 'ph');
        setCls(body, 'vt-h-row', L === 'row');
        setCls(body, 'vt-h-w1600', pc && W < 1600);
        setCls(body, 'vt-h-w1366', pc && W < 1366);
        setCls(body, 'vt-h-w1280', pc && W < 1280);
        setCls(body, 'vt-h-w1100', pc && W < 1100);
        setCls(body, 'vt-h-sum', (pc && W < 1100) || L === 'row');
        var nh = NAV_H[L] + 'px';
        var root = document.documentElement;
        if (root.style.getPropertyValue('--navbar-h') !== nh) { root.style.setProperty('--navbar-h', nh); }
        if (ensureTools()) { placeMenuBand(L); }
        var key = L + '|' + W;
        if (key !== lastKey) {
            lastKey = key;
            closeMenu();
            if (window.VTSys && window.VTSys.closeCard) { window.VTSys.closeCard(); }
            if (window.VTSys && window.VTSys.reps) { window.VTSys.reps(); }
            if (window.VtFrame && window.VtFrame.update) { window.VtFrame.update(); }
        }
    }

    var tries = 0;
    function init() {
        apply();
        wireNotice();
        wireBars(0);
        window.addEventListener('resize', apply);
        if (window.VTI18n) {
            VTI18n.onChange(function () { if (menu && !menu.hidden) { fillMenu(); } });
        }
        // the help button and the bell arrive later (other modules): restyle them
        (function late() {
            ensureTools();
            if ((!$('btn_help') || !$('btn_needs')) && ++tries < 40) { setTimeout(late, 250); }
        })();
    }

    window.VTHeader = {layout: layout, update: apply, closeMenu: closeMenu, openMenu: openMenu, sysTone: sysTone};
    // classes before the first paint of the frame (vt_frame.js measures them)
    if (document.body) { apply(); }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
