/* vt_ui.js — small behaviour of the shared panel anatomy (U1, 2026-10).
 *
 * Tab strips are one row that scrolls sideways (vt_panel.css), never wrap.
 * When a strip has more tabs than room (narrow desktop panel, phone, Czech
 * labels, the compact head that shares the row with STOP / ⤢ / ✕):
 *   - the edge with more tabs gets .vt-more-r / .vt-more-l and shows a small
 *     ‹ / › button (sticky inside the strip, it takes no room): a click scrolls
 *     by about one panel width;
 *   - a mouse wheel over the strip scrolls it sideways (a PC has no swipe);
 *     a finger swipes it natively, scroll-snap stops on a tab;
 *   - the active / clicked / focused tab is scrolled into view (nearest edge,
 *     clear of the ‹ › buttons), also whenever a strip becomes visible, so a
 *     panel never opens on a hidden tab; ← → move between tabs.
 * Pure presentation: no state, no ROS, safe to load anywhere after the DOM.
 */
(function () {
    'use strict';
    var SEL = 'ul.nav-tabs.drawer-pills, #vagent_tabs';
    var NAV_W = 28;   // the ‹ › buttons' width (vt_panel.css .vt-tabs-nav)
    var t = function (k, d) {
        var s = window.VTI18n ? VTI18n.t(k) : k;
        return (s && s !== k) ? s : d;
    };

    function tabs(strip) {
        return Array.prototype.filter.call(strip.children, function (c) {
            return !c.classList.contains('vt-tabs-nav');
        });
    }

    function update(strip) {
        if (!strip || !strip.clientWidth) { return; }
        var max = strip.scrollWidth - strip.clientWidth;
        strip.classList.toggle('vt-more-r', strip.scrollLeft < max - 2);
        strip.classList.toggle('vt-more-l', strip.scrollLeft > 2);
    }

    // scroll `el` (a tab inside the strip) to the nearest visible spot
    function reveal(strip, el, smooth) {
        if (!strip || !el || !strip.clientWidth) { update(strip); return; }
        var s = strip.getBoundingClientRect(), r = el.getBoundingClientRect();
        var padL = strip.scrollLeft > 2 ? NAV_W : 4, padR = NAV_W;
        var d = 0;
        if (r.left < s.left + padL) { d = r.left - (s.left + padL); }
        else if (r.right > s.right - padR) { d = r.right - (s.right - padR); }
        if (Math.abs(d) > 1) {
            if (smooth && strip.scrollBy) { strip.scrollBy({left: d, behavior: 'smooth'}); }
            else { strip.scrollLeft += d; }
        }
        update(strip);
    }

    function revealActive(strip) {
        if (!strip || !strip.clientWidth) { return; }
        var a = strip.querySelector('.active:not(.vt-tabs-nav)');
        if (!a) { update(strip); return; }
        reveal(strip, a, false);
    }

    function page(strip, dir) {
        var step = Math.max(80, strip.clientWidth - 2 * NAV_W - 24) * dir;
        if (strip.scrollBy) { strip.scrollBy({left: step, behavior: 'smooth'}); }
        else { strip.scrollLeft += step; }
    }

    function makeNav(strip, side) {
        var b = document.createElement('button');
        b.type = 'button';
        b.tabIndex = -1;                       // keyboard uses ← → on the tabs
        b.className = 'vt-tabs-btn';
        b.textContent = side === 'l' ? '‹' : '›';
        var k = side === 'l' ? 'common.tabs.prev' : 'common.tabs.next';
        var lbl = t(k, side === 'l' ? 'Previous tabs' : 'More tabs');
        b.title = lbl; b.setAttribute('aria-label', lbl);
        if (window.VTI18n && VTI18n.tag) { VTI18n.tag(b, k, 'title'); VTI18n.tag(b, k, 'aria-label'); }
        b.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            page(strip, side === 'l' ? -1 : 1);
        });
        var w;
        if (strip.tagName === 'UL') { w = document.createElement('li'); w.setAttribute('role', 'presentation'); w.appendChild(b); }
        else { w = b; }
        w.classList.add('vt-tabs-nav', 'vt-tabs-nav-' + side);
        return w;
    }

    function ensureNav(strip) {
        var l = strip.querySelector(':scope > .vt-tabs-nav-l');
        var r = strip.querySelector(':scope > .vt-tabs-nav-r');
        if (!l) { l = makeNav(strip, 'l'); }
        if (!r) { r = makeNav(strip, 'r'); }
        if (strip.firstElementChild !== l) { strip.insertBefore(l, strip.firstChild); }
        if (strip.lastElementChild !== r) { strip.appendChild(r); }
    }

    var bound = (typeof WeakSet === 'function') ? new WeakSet() : null;
    function bind(strip) {
        if (!bound || bound.has(strip)) { return; }
        bound.add(strip);
        strip.addEventListener('scroll', function () { update(strip); }, {passive: true});
        // PC: the wheel scrolls the strip sideways while it can; at its end
        // the wheel goes back to scrolling the panel
        strip.addEventListener('wheel', function (e) {
            if (e.ctrlKey) { return; }
            var max = strip.scrollWidth - strip.clientWidth;
            if (max <= 2) { return; }
            var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (e.deltaMode === 1) { d *= 16; }
            if ((d > 0 && strip.scrollLeft >= max - 1) || (d < 0 && strip.scrollLeft <= 0)) { return; }
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { return; }   // a touchpad swipe scrolls natively
            e.preventDefault();
            strip.scrollLeft += d;
        }, {passive: false});
        // a clicked or focused tab comes fully into view
        strip.addEventListener('click', function (e) {
            var tab = e.target.closest && e.target.closest('a, button');
            if (tab && strip.contains(tab) && !tab.closest('.vt-tabs-nav')) { reveal(strip, tab, true); }
        });
        strip.addEventListener('focusin', function (e) {
            if (!e.target.closest('.vt-tabs-nav')) { reveal(strip, e.target, true); }
        });
        // ← → / Home / End move between the tabs (Bootstrap's own handler
        // does it for .nav-tabs where it exists; this covers every strip)
        strip.addEventListener('keydown', function (e) {
            var k = e.key;
            if (e.defaultPrevented || (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End')) { return; }
            var list = tabs(strip).map(function (c) { return c.matches('a, button') ? c : c.querySelector('a, button'); })
                .filter(function (x) { return x && x.offsetParent !== null; });
            var i = list.indexOf(e.target.closest('a, button'));
            if (i < 0) { return; }
            var j = k === 'Home' ? 0 : k === 'End' ? list.length - 1 : i + (k === 'ArrowRight' ? 1 : -1);
            j = Math.max(0, Math.min(list.length - 1, j));
            if (j === i) { return; }
            e.preventDefault();
            list[j].focus();
            list[j].click();
        });
        new MutationObserver(function (recs) {
            // our own .vt-more-* toggles on the strip itself are not a tab change
            for (var i = 0; i < recs.length; i++) {
                if (recs[i].target !== strip && !(recs[i].target.closest && recs[i].target.closest('.vt-tabs-nav'))) {
                    settle(strip); return;
                }
            }
        })
            .observe(strip, {subtree: true, attributes: true, attributeFilter: ['class']});
    }

    // reveal the active tab only when it matters — the strip just became
    // visible, its width changed or another tab became active; any other
    // mutation in the drawer (it changes a lot) must not undo the owner's
    // own scrolling of the strip
    var seen = (typeof WeakMap === 'function') ? new WeakMap() : null;
    function settle(strip) {
        var a = strip.querySelector('.active:not(.vt-tabs-nav)');
        var w = strip.clientWidth;
        var prev = seen ? seen.get(strip) : null;
        if (seen) { seen.set(strip, {a: a, w: w}); }
        if (!prev || prev.a !== a || prev.w !== w) { revealActive(strip); }
        else { update(strip); }
    }

    function all() {
        var list = document.querySelectorAll(SEL);
        for (var i = 0; i < list.length; i++) { ensureNav(list[i]); bind(list[i]); settle(list[i]); }
    }


    function init() {
        all();
        window.addEventListener('resize', all);
        // panels are shown/hidden by toggling the drawer + their own display
        var d = document.getElementById('ui_drawer');
        if (d) {
            var tm = null;   // debounced: the agent panel mutates a lot
            new MutationObserver(function () {
                if (tm) { return; }
                tm = setTimeout(function () { tm = null; all(); }, 120);
            })
                .observe(d, {subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true});
        }
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();

/* ---------------------------------------------------------------------------
 * Phone bottom sheet (U1 kolo 2): drag the grip / the header, and the soft
 * keyboard.
 *   drag up   > 60 px  -> full screen          (same as ⤢ / tap on the grip)
 *   drag down > 60 px  -> back from full screen to the sheet
 *   drag down > 140 px -> close the panel      (on the sheet)
 * While the finger moves the sheet follows it (transform / height), on
 * release it snaps. A drag never turns into a click on the grip.
 * Keyboard: iOS keeps the layout viewport when the keyboard opens, so the
 * bottom-anchored sheet would sit under it. visualViewport tells the truth:
 * the sheet is lifted onto the keyboard and fills the visible area, and the
 * focused field is scrolled into view. The Agent panel has its own copy of
 * this (agent_chat.js watchKeyboard) and is left to it.
 * ------------------------------------------------------------------------- */
(function () {
    'use strict';
    var MOBILE = 576, UP = 60, DOWN_FULL = 60, DOWN_CLOSE = 140;

    function drawer() { return document.getElementById('ui_drawer'); }
    function isPhone() { return window.innerWidth < MOBILE; }
    function agentOwns() {
        var b = document.getElementById('ui_drawer_body');
        return !!(b && b.classList.contains('vagent-host'));
    }
    function setFull(on) {
        var mm = window.map_menu;
        if (mm && mm.set_drawer_full) { mm.set_drawer_full(on); }
        else { var d = drawer(); if (d) { d.classList.toggle('full', on); } }
    }
    function closePanel() {
        if (agentOwns() && window.VAgent && window.VAgent.close) { window.VAgent.close(); return; }
        var mm = window.map_menu;
        if (mm && mm.close_drawer) { mm.close_drawer(); }
    }

    var drag = null;          // {y0, h0, full, moved}
    var suppressClick = false;

    function onStart(ev) {
        var d = drawer();
        if (!d || !isPhone() || !d.classList.contains('open') || ev.touches.length !== 1) { return; }
        // the header's own buttons stay buttons
        if (ev.target.closest && ev.target.closest('button') && ev.target.id !== 'ui_drawer_grip') { return; }
        drag = {y0: ev.touches[0].clientY, h0: d.getBoundingClientRect().height,
                full: d.classList.contains('full'), moved: false, dy: 0};
    }
    function onMove(ev) {
        if (!drag) { return; }
        var d = drawer();
        var dy = ev.touches[0].clientY - drag.y0;
        drag.dy = dy;
        if (!drag.moved && Math.abs(dy) < 8) { return; }
        drag.moved = true;
        ev.preventDefault();                       // no page / map gesture underneath
        d.style.transition = 'none';
        if (dy > 0) {                               // down: the sheet follows the finger
            d.style.transform = 'translateY(' + Math.round(dy) + 'px)';
        } else if (!drag.full) {                    // up: the sheet grows
            d.style.transform = '';
            d.style.height = Math.round(drag.h0 - dy) + 'px';
            d.style.maxHeight = 'none';
        }
    }
    function onEnd() {
        if (!drag) { return; }
        var d = drawer(), dy = drag.dy, moved = drag.moved, full = drag.full;
        drag = null;
        if (!d) { return; }
        d.style.transition = ''; d.style.transform = '';
        if (!agentOwns()) { d.style.height = ''; }
        d.style.maxHeight = '';
        if (!moved) { return; }                    // a tap: the grip's click does it
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 400);
        if (dy < -UP && !full) { setFull(true); }
        else if (dy > DOWN_CLOSE && !full) { closePanel(); }
        else if (dy > DOWN_FULL && full) { setFull(false); }
    }

    function initSheet() {
        var d = drawer();
        if (!d) { return; }
        ['ui_drawer_grip', 'ui_drawer_head'].forEach(function (id) {
            var t = document.getElementById(id);
            if (!t) { return; }
            t.addEventListener('touchstart', onStart, {passive: true});
            t.addEventListener('touchmove', onMove, {passive: false});
            t.addEventListener('touchend', onEnd);
            t.addEventListener('touchcancel', onEnd);
        });
        var grip = document.getElementById('ui_drawer_grip');
        if (grip) {
            grip.addEventListener('click', function (ev) {
                if (suppressClick) { ev.stopImmediatePropagation(); ev.preventDefault(); }
            }, true);
        }

        var vv = window.visualViewport;
        if (!vv) { return; }
        var lifted = false;
        function fit() {
            var dd = drawer();
            if (!dd || agentOwns()) { lifted = false; return; }
            var visBottom = (vv.offsetTop || 0) + vv.height;
            var kb = window.innerHeight - visBottom;
            if (!isPhone() || !dd.classList.contains('open') || kb < 60) {
                if (lifted) { dd.style.bottom = ''; dd.style.height = ''; lifted = false; }
                return;
            }
            var top = parseFloat(getComputedStyle(document.documentElement)
                .getPropertyValue('--vt-drawer-top')) || 96;
            dd.style.bottom = Math.round(kb) + 'px';
            dd.style.height = Math.round(Math.max(160, visBottom - top)) + 'px';
            lifted = true;
            var a = document.activeElement;
            if (a && dd.contains(a) && a.scrollIntoView) {
                try { a.scrollIntoView({block: 'center'}); } catch (e) { a.scrollIntoView(); }
            }
        }
        vv.addEventListener('resize', fit);
        vv.addEventListener('scroll', fit);
        d.addEventListener('focusin', function () { setTimeout(fit, 250); });
        window.__vtSheetFit = fit;   // test hook (tour.py) — no behaviour of its own
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initSheet); }
    else { initSheet(); }
})();

/* U1 kolo 3: small checkboxes wrapped in a plain span/div (keyboard teleop in
 * the right panel, the Mapping "direct" sources) get the wrapper as their
 * 40 px touch target: a tap on the wrapper — not on the box or a link/button
 * inside — toggles the box exactly as a tap on it would. */
(function () {
    'use strict';
    var WRAP = '#div_status_speed-1, #ui_drawer span:has(> input[type="checkbox"])';
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest || t.closest('input, label, button, a, select')) { return; }
        var w;
        try { w = t.closest(WRAP); } catch (e) { return; }   // :has unsupported
        if (!w) { return; }
        var box = w.querySelector(':scope > input[type="checkbox"]');
        if (box && !box.disabled) { box.click(); }
    });
    window.__vtHitWrap = WRAP;
})();
