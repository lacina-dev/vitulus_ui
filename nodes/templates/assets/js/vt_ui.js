/* vt_ui.js — small behaviour of the shared panel anatomy (U1, 2026-10).
 *
 * Tab strips are one row that scrolls sideways (vt_panel.css). On a phone the
 * last tabs can sit off-screen, so:
 *   - a strip that has more tabs to the right/left gets .vt-more-r / .vt-more-l
 *     (CSS fades that edge as the "there is more" hint);
 *   - the active tab is scrolled into view whenever a strip becomes visible or
 *     its active tab changes, so the panel never opens on a hidden tab.
 * Pure presentation: no state, no ROS, safe to load anywhere after the DOM.
 */
(function () {
    'use strict';
    var SEL = 'ul.nav-tabs.drawer-pills, #vagent_tabs';

    function update(strip) {
        if (!strip || !strip.clientWidth) { return; }
        var max = strip.scrollWidth - strip.clientWidth;
        strip.classList.toggle('vt-more-r', strip.scrollLeft < max - 2);
        strip.classList.toggle('vt-more-l', strip.scrollLeft > 2);
    }

    function revealActive(strip) {
        if (!strip || !strip.clientWidth) { return; }
        var a = strip.querySelector('.active');
        if (!a) { update(strip); return; }
        var s = strip.getBoundingClientRect(), r = a.getBoundingClientRect();
        if (r.left < s.left || r.right > s.right) {
            strip.scrollLeft += (r.left + r.width / 2) - (s.left + s.width / 2);
        }
        update(strip);
    }

    var bound = (typeof WeakSet === 'function') ? new WeakSet() : null;
    function bind(strip) {
        if (!bound || bound.has(strip)) { return; }
        bound.add(strip);
        strip.addEventListener('scroll', function () { update(strip); }, {passive: true});
        new MutationObserver(function (recs) {
            // our own .vt-more-* toggles on the strip itself are not a tab change
            for (var i = 0; i < recs.length; i++) {
                if (recs[i].target !== strip) { revealActive(strip); return; }
            }
        })
            .observe(strip, {subtree: true, attributes: true, attributeFilter: ['class']});
    }

    function all() {
        var list = document.querySelectorAll(SEL);
        for (var i = 0; i < list.length; i++) { bind(list[i]); revealActive(list[i]); }
    }

    function init() {
        all();
        window.addEventListener('resize', all);
        // panels are shown/hidden by toggling the drawer + their own display
        var d = document.getElementById('ui_drawer');
        if (d) {
            var t = null;   // debounced: the agent panel mutates a lot
            new MutationObserver(function () {
                if (t) { return; }
                t = setTimeout(function () { t = null; all(); }, 120);
            })
                .observe(d, {subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true});
        }
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
