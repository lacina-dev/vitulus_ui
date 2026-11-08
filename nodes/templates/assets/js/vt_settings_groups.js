/* vt_settings_groups.js — the groups of Settings (D3, owner 2026-11-08 / D28).
 *
 * Settings had ten tabs in one strip; now three groups, each with its tabs:
 *   Robot   — Motors · Power · Mower
 *   Sensors — Navi · Lidar · Camera · IMU
 *   System  — App · Diag · Rosbag
 * Row 1 (#cfg_groups) = the groups, row 2 (#cfg_tabs) = the tabs of the open
 * group. Every tab is still the Bootstrap link <a href="#tab_…"
 * data-bs-toggle="tab"> it was, so whatever opens a tab (the remembered tab in
 * app.js, Autonomy › "power", the header's Diag card, Camera › Rosbag, the
 * help) keeps working: when ANY tab is shown, the group row follows it. The
 * tabs of the other groups are only hidden. A group click opens the tab last
 * used in that group (localStorage vitulus_cfg_group_tab), else its first.
 * The tab the panel remembers (vitulus_tab_settings) was "#tab_lidar" for the
 * Navi tab before D3; it is moved to "#tab_navi" here, before app.js reads it.
 * Pure presentation: no ROS, nothing is sent.
 */
(function () {
    'use strict';
    var KEY = 'vitulus_cfg_group_tab';
    try {
        if (localStorage.getItem('vitulus_tab_settings') === '#tab_lidar') {
            localStorage.setItem('vitulus_tab_settings', '#tab_navi');
        }
    } catch (e) { /* storage blocked: the panel opens on its default tab */ }

    var groupsEl = document.getElementById('cfg_groups');
    var tabsEl = document.getElementById('cfg_tabs');
    if (!groupsEl || !tabsEl) { return; }

    function load() {
        try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function save(g, href) {
        var m = load();
        m[g] = href;
        try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) { /* per-device convenience only */ }
    }
    function items(g) {
        return Array.prototype.filter.call(tabsEl.querySelectorAll(':scope > li[data-cfg-group]'), function (li) {
            return !g || li.getAttribute('data-cfg-group') === g;
        });
    }
    function linkOf(li) { return li.querySelector('a[data-bs-toggle="tab"]'); }

    // show group g's tabs and mark it; does not change the open tab
    function paint(g) {
        items().forEach(function (li) { li.hidden = li.getAttribute('data-cfg-group') !== g; });
        // a group with one tab (none today) needs no second row
        tabsEl.hidden = items(g).length < 2;
        groupsEl.querySelectorAll('[data-cfg-group]').forEach(function (b) {
            var on = b.getAttribute('data-cfg-group') === g;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.tabIndex = on ? 0 : -1;
        });
        groupsEl.setAttribute('data-open', g);
    }

    function groupOfLink(a) {
        var li = a && a.closest('li[data-cfg-group]');
        return li ? li.getAttribute('data-cfg-group') : null;
    }

    function openGroup(g) {
        var list = items(g);
        if (!list.length) { return; }
        var want = load()[g], target = null;
        list.forEach(function (li) { var a = linkOf(li); if (a && a.getAttribute('href') === want) { target = a; } });
        if (!target) { target = linkOf(list[0]); }
        paint(g);
        if (!target || target.classList.contains('active')) { return; }
        try {
            if (window.bootstrap && bootstrap.Tab) { bootstrap.Tab.getOrCreateInstance(target).show(); }
            else { target.click(); }
        } catch (e) { target.click(); }
    }

    groupsEl.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-cfg-group]');
        if (!b || !groupsEl.contains(b)) { return; }
        e.preventDefault();
        openGroup(b.getAttribute('data-cfg-group'));
    });

    // whatever showed a tab (a click, app.js restoring it, another module):
    // the groups follow, and the tab is remembered for its group
    items().forEach(function (li) {
        var a = linkOf(li);
        if (!a) { return; }
        a.addEventListener('shown.bs.tab', function () {
            var g = groupOfLink(a);
            if (!g) { return; }
            paint(g);
            save(g, a.getAttribute('href'));
        });
    });

    function sync() {
        var act = tabsEl.querySelector('a.nav-link.active[data-bs-toggle="tab"]');
        paint(groupOfLink(act) || 'sensors');
    }
    sync();
    // app.js restores the remembered tab on DOMContentLoaded; follow it even
    // if its shown.bs.tab fired before the listeners above existed
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(sync, 0); }); }
    else { setTimeout(sync, 0); }

    window.VTSettingsGroups = { open: openGroup, sync: sync };
})();
