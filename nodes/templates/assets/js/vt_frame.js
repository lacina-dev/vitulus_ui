/* vt_frame.js — the application FRAME (U1, kolo 5).  docs/UI_LAYOUT.md
 *
 * One place that knows where every area sits:
 *   - layout mode on <body>: vt-m-dock (PC) | vt-m-overlay (landscape phone,
 *     small tablet, low window) | vt-m-sheet (phone portrait);
 *   - vt-panel-open while the left panel (#ui_drawer) is shown;
 *   - CSS variables with the frame edges (top band, notice band, bottom bar,
 *     left panel, right panel, small log) that vt_panel.css "frame" rules use
 *     to place the panel, the map, the log and the notices so that nothing
 *     covers the controls or the notices.
 * Plus the panel show/hide toggle (#btn_panel_toggle in the menu band, Alt+P).
 * Pure layout: no ROS, publishes nothing.
 */
(function () {
    'use strict';

    var DOCK_MIN_W = 1024, DOCK_MIN_H = 500, SHEET_MAX_W = 576, LOG_MIN_W = 420;
    var LS_LAST = 'vitulus_last_panel';
    var BTN_FOR = {marker: 'btn_marker', map: 'btn_map', program: 'btn_programs',
                   config: 'btn_settings', agent: 'btn_agent'};

    function $(id) { return document.getElementById(id); }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function px(v) { return Math.max(0, Math.round(v || 0)) + 'px'; }

    function mode() {
        var w = window.innerWidth, h = window.innerHeight;
        if (w < SHEET_MAX_W) { return 'sheet'; }
        if (w >= DOCK_MIN_W && h >= DOCK_MIN_H) { return 'dock'; }
        return 'overlay';
    }

    function visible(el) {
        if (!el) { return false; }
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') { return false; }
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    var lastDock = null, resizeTimer = null, raf = null;

    function update() {
        raf = null;
        var root = document.documentElement, body = document.body;
        var m = mode();
        ['dock', 'overlay', 'sheet'].forEach(function (k) { body.classList.toggle('vt-m-' + k, k === m); });
        body.classList.add('vt-frame');

        var drawer = $('ui_drawer');
        var open = !!(drawer && drawer.classList.contains('open'));
        var full = !!(drawer && drawer.classList.contains('full'));
        body.classList.toggle('vt-panel-open', open);
        if (open) {
            var key = window.map_menu && window.map_menu._drawer_last;
            if (key && key !== 'editor') { lsSet(LS_LAST, key); }
        }
        label();
        paintToggles();
        var btn = $('btn_panel_toggle');
        if (btn) {
            btn.classList.toggle('vt-on', open);
            btn.title = (open ? 'Hide panel' : 'Show panel') + ' (Alt+P)';
            btn.setAttribute('aria-pressed', open ? 'true' : 'false');
        }

        // navbar: hidden by LayoutManager on low windows (landscape phone) —
        // the agent bars (#vagent_bars) must then start at the top, not under
        // a navbar that is not there (they used to cover the menu row)
        var nav = $('div_menu'), sp = $('menu_spacer');
        var navB = visible(nav) ? (visible(sp) ? sp.getBoundingClientRect().bottom
                                                : nav.getBoundingClientRect().bottom) : 0;
        root.style.setProperty('--vt-frame-nav-b', px(navB));
        // top band: bottom edge of the menu row
        var rm = $('row_menu');
        var top = rm ? rm.getBoundingClientRect().bottom : 0;
        root.style.setProperty('--vt-frame-top', px(top));
        // notice band
        var nb = top;
        var info = $('span_status_info');
        var row = info && info.closest ? info.closest('.vt-notice-row') : null;
        if (row && visible(info)) { nb = Math.max(nb, row.getBoundingClientRect().bottom); }
        root.style.setProperty('--vt-frame-notice-b', px(nb));
        // bottom bar zone
        var bm = $('div_bottom_menu');
        var bh = bm ? Math.max(0, window.innerHeight - bm.getBoundingClientRect().top) : 0;
        root.style.setProperty('--vt-frame-bottom', px(bh));
        // left panel
        var occ = 0;
        if (open && !full && m !== 'sheet' && drawer) { occ = drawer.offsetWidth; }
        root.style.setProperty('--vt-frame-left', px(occ));
        var dock = (m === 'dock') ? occ : 0;
        root.style.setProperty('--vt-frame-dock', px(dock));
        // right panel (only when it sits in the map area, i.e. not on a phone)
        var rp = $('right_panel');
        var rpw = 0, rpb = nb;
        if (visible(rp)) {
            var rr = rp.getBoundingClientRect();
            rpb = rr.bottom;
            if (m !== 'sheet') { rpw = Math.max(0, window.innerWidth - rr.left); }
        }
        root.style.setProperty('--vt-frame-rp-w', px(rpw));
        root.style.setProperty('--vt-frame-rp-b', px(rpb));
        // small log
        var log = $('div_log_view');
        var lh = (visible(log) && !log.classList.contains('log-expanded')) ? log.offsetHeight : 0;
        root.style.setProperty('--vt-frame-log-h', px(lh));
        // kolo 6: next to an open panel the small log can get too narrow
        // (landscape phone: ~160 px). Then it spans the full width above the
        // bottom bar and the panel ends above it instead.
        var wide = lh > 0 && m !== 'sheet' && occ > 0 && (window.innerWidth - occ - rpw) < LOG_MIN_W;
        body.classList.toggle('vt-log-wide', wide);

        // U1 kolo 6: joystick vs. the phone sheet — when the stick is on and
        // the sheet is open, the sheet leaves room above itself for the stick
        // and the stick sits right above the sheet (never under it)
        var joy = $('joy_view');
        var joyOn = visible(joy);
        body.classList.toggle('vt-joy-on', joyOn);
        if (m === 'sheet' && open && joyOn && drawer) {
            // the free band ends at the notices AND the right panel's row
            var avail = window.innerHeight - bh - Math.max(nb, rpb);
            var jh = joy.offsetHeight || 150;
            root.style.setProperty('--vt-frame-sheet-max', px(Math.max(160, avail - jh - 24)));
            root.style.setProperty('--vt-frame-sheet-h', px(drawer.offsetHeight));
        } else {
            root.style.setProperty('--vt-frame-sheet-h', '0px');
        }

        // the map canvas changes width when the docked panel opens/closes
        if (dock !== lastDock) {
            lastDock = dock;
            if (resizeTimer) { clearTimeout(resizeTimer); }
            resizeTimer = setTimeout(function () {
                window.dispatchEvent(new Event('resize'));
            }, 230);   // after the drawer's 0.2 s slide
        }
    }

    function schedule() {
        if (raf) { return; }
        raf = (window.requestAnimationFrame || setTimeout)(update);
    }

    // ------------------------------------------------ panel show / hide
    function togglePanel() {
        var drawer = $('ui_drawer');
        var open = !!(drawer && drawer.classList.contains('open'));
        if (open) {
            var mm = window.map_menu;
            if (mm && mm._drawer_last === 'agent' && window.VAgent && window.VAgent.close) {
                window.VAgent.close();
            } else if (mm && mm._drawer_last === 'editor') {
                var ex = $('btn_map_detail_close');   // editor: back to Map, then hide
                if (ex) { ex.click(); }
                if (mm.close_drawer) { mm.close_drawer(); }
            } else if (mm && mm.close_drawer) {
                mm.close_drawer();
            }
            return;
        }
        var last = lsGet(LS_LAST) || 'map';
        if (last === 'agent' && window.VAgent && window.VAgent.open) { window.VAgent.open(); return; }
        var b = $(BTN_FOR[last] || 'btn_map');
        if (b) { b.click(); }
    }

    function installToggle() {
        var group = document.querySelector('#row_menu .btn-group');
        if (!group || $('btn_panel_toggle')) { return; }
        var b = document.createElement('button');
        b.type = 'button';
        b.id = 'btn_panel_toggle';
        b.className = 'btn btn-outline-info d-flex justify-content-center align-items-center all-events vt-panel-toggle';
        b.setAttribute('aria-label', 'Show / hide panel');
        b.innerHTML = '<i class="la la-columns"></i>';
        b.addEventListener('click', function (e) { e.preventDefault(); togglePanel(); });
        group.insertBefore(b, group.firstChild);
    }

    // ------------------------------------------------ labels + states
    // One name per control, used for the tooltip, the screen-reader label and
    // (on a PC, vt_panel.css) the visible text next to the icon.
    var LABELS = {
        btn_panel_toggle: ['Panel', 'Show / hide the left panel (Alt+P)'],
        btn_marker: ['Marker', 'Marker — drag it on the map and send a navigation goal'],
        btn_settings: ['Settings', 'Settings — motors, navi, power, mower, diag, rosbag, IMU'],
        btn_map: ['Map', 'Map — maps, paths, points, dock, rain, localization'],
        btn_programs: ['Programs', 'Mowing programs and calendar'],
        btn_agent: ['Agent', null],
        btn_stop_all: ['STOP', 'STOP — stop all motion'],
        btn_camera_show: ['Camera', 'Show / hide the camera preview'],
        btn_joy: ['Joystick', 'Show / hide the on-screen joystick'],
        btn_follow: ['Follow', 'Camera follows the map / the robot'],
        btn_log: ['Log', 'Show / hide the log (expand it from its own bar)']
    };
    function label() {
        Object.keys(LABELS).forEach(function (id) {
            var b = $(id);
            if (!b || b.dataset.label) { return; }
            b.dataset.label = LABELS[id][0];
            if (LABELS[id][1] && !b.title) { b.title = LABELS[id][1]; }
            if (!b.getAttribute('aria-label')) { b.setAttribute('aria-label', b.title || LABELS[id][0]); }
        });
    }
    // bottom-bar toggles show whether their thing is on (the old .active
    // flag was JS-only and webui.js strips the class anyway)
    function paintToggles() {
        var on = {
            btn_camera_show: visible($('div_camera_view')),
            btn_joy: visible($('joy_view')),
            btn_log: visible($('div_log_view')),
            btn_follow: !!(window.tf_client && window.tf_client.follow_target === 'robot')
        };
        Object.keys(on).forEach(function (id) {
            var b = $(id);
            if (b) { b.classList.toggle('vt-on', on[id]); b.setAttribute('aria-pressed', on[id] ? 'true' : 'false'); }
        });
    }

    function init() {
        installToggle();
        label();
        update();
        window.addEventListener('resize', schedule);
        var watch = function (el, opts) { if (el) { new MutationObserver(schedule).observe(el, opts); } };
        watch($('ui_drawer'), {attributes: true, attributeFilter: ['class', 'style']});
        watch($('right_panel'), {attributes: true, attributeFilter: ['class', 'style']});
        watch($('div_log_view'), {attributes: true, attributeFilter: ['class', 'style']});
        watch($('span_status_info'), {attributes: true, childList: true, characterData: true, subtree: true});
        watch(document.body, {attributes: true, attributeFilter: ['class']});
        watch($('joy_view'), {attributes: true, attributeFilter: ['style', 'class']});
        watch($('div_camera_view'), {attributes: true, attributeFilter: ['style']});
        var fb = $('btn_follow');
        if (fb) { fb.addEventListener('click', function () { setTimeout(schedule, 50); }); }
        if (window.ResizeObserver) {
            var ro = new ResizeObserver(schedule);
            ['row_menu', 'div_bottom_menu', 'ui_drawer', 'right_panel', 'div_log_view'].forEach(function (id) {
                if ($(id)) { ro.observe($(id)); }
            });
            var info = $('span_status_info');
            var row = info && info.closest ? info.closest('.vt-notice-row') : null;
            if (row) { ro.observe(row); }
        }
        document.addEventListener('keydown', function (ev) {
            if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey &&
                (ev.key === 'p' || ev.key === 'P' || ev.code === 'KeyP')) {
                ev.preventDefault();
                togglePanel();
                return;
            }
            // Esc hides the panel — unless the user is typing, a modal or the
            // full log is up (Esc belongs to them then)
            if (ev.key === 'Escape' && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
                var t = ev.target, tag = t && t.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) { return; }
                if (document.querySelector('.modal.show')) { return; }
                var lg = $('div_log_view');
                if (lg && lg.classList.contains('log-expanded')) { return; }
                var d = $('ui_drawer');
                if (d && d.classList.contains('open')) { ev.preventDefault(); togglePanel(); }
            }
        });
        // right_dock.js builds the right panel after load; re-measure then
        setTimeout(schedule, 500);
        setTimeout(schedule, 1500);
    }

    window.VtFrame = {update: schedule, toggle: togglePanel, mode: mode};
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); }); }
    else { setTimeout(init, 0); }
})();
