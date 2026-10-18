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
    var SPINE = 12, SPINE_PHONE = 6;
    var JOY_BESIDE_MIN = 240;          // C frame 3: min. room for the right panel above the stick   // C frame: the back of the C when the panel is hidden
    var LS_LAST = 'vitulus_last_panel';
    var BTN_FOR = {marker: 'btn_marker', map: 'btn_map', program: 'btn_programs',
                   config: 'btn_settings', agent: 'btn_agent'};

    function $(id) { return document.getElementById(id); }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    // classList.toggle rewrites the class attribute (and fires the body-class
    // MutationObserver below) even when nothing changes — touch it on change only
    function setCls(el, c, on) {
        if (el && el.classList.contains(c) !== !!on) { el.classList.toggle(c, !!on); }
    }
    function px(v) { return Math.max(0, Math.round(v || 0)) + 'px'; }
    function setVar(k, v) {
        var root = document.documentElement;
        if (root.style.getPropertyValue(k) !== v) { root.style.setProperty(k, v); }
    }

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

    var lastDock = null, resizeTimer = null, raf = null, lastTop = null, lastMini = null;

    function update() {
        raf = null;
        var root = document.documentElement, body = document.body;
        var W = window.innerWidth, H = window.innerHeight;
        var m = mode();
        ['dock', 'overlay', 'sheet'].forEach(function (k) { setCls(body, 'vt-m-' + k, k === m); });
        setCls(body, 'vt-frame', true);

        var drawer = $('ui_drawer');
        var open = !!(drawer && drawer.classList.contains('open'));
        var full = !!(drawer && drawer.classList.contains('full'));
        setCls(body, 'vt-panel-open', open);
        if (open) {
            var key = window.map_menu && window.map_menu._drawer_last;
            if (key && key !== 'editor') { lsSet(LS_LAST, key); }
            // the map editor needs the map in the hollow: a large camera steps back
            if (key === 'editor' && body.classList.contains('vt-cam-large')) { setTimeout(function () { camSet(false); }, 0); }
        }
        label();
        paintToggles();
        var btn = $('btn_panel_toggle');
        if (btn) {
            setCls(btn, 'vt-on', open);
            var bt = (open ? 'Hide panel' : 'Show panel') + ' (Alt+P)';
            if (btn.title !== bt) { btn.title = bt; }
            btn.setAttribute('aria-pressed', open ? 'true' : 'false');
        }

        // navbar: hidden by LayoutManager on low windows (landscape phone) —
        // the agent bars (#vagent_bars) must then start at the top, not under
        // a navbar that is not there (they used to cover the menu row)
        var nav = $('div_menu'), sp = $('menu_spacer');
        var navB = visible(nav) ? (visible(sp) ? sp.getBoundingClientRect().bottom
                                                : nav.getBoundingClientRect().bottom) : 0;
        setVar('--vt-frame-nav-b', px(navB));
        // top band: bottom edge of the menu row
        var rm = $('row_menu');
        var top = rm ? rm.getBoundingClientRect().bottom : 0;
        // notice band
        var info = $('span_status_info');
        var row = info && info.closest ? info.closest('.vt-notice-row') : null;
        // C frame 3: on a phone in portrait the status icons and the notice
        // band are part of the top of the C (opaque, frame surface) — the
        // right panel's row then hangs straight from it
        if (m === 'sheet') {
            var ri = $('row_icons');
            if (visible(ri)) { top = Math.max(top, ri.getBoundingClientRect().bottom); }
            if (row && visible(row)) { top = Math.max(top, row.getBoundingClientRect().bottom); }
        }
        setVar('--vt-frame-top', px(top));
        var nb = top;
        if (row && visible(info)) { nb = Math.max(nb, row.getBoundingClientRect().bottom); }
        setVar('--vt-frame-notice-b', px(nb));
        // bottom bar zone
        var bm = $('div_bottom_menu');
        var bh = bm ? Math.max(0, H - bm.getBoundingClientRect().top) : 0;
        setVar('--vt-frame-bottom', px(bh));
        // left panel
        var occ = 0;
        if (open && !full && m !== 'sheet' && drawer) { occ = drawer.offsetWidth; }
        setVar('--vt-frame-left', px(occ));
        // P19: the panel over the map (landscape phone) — its width, so the
        // status strip can centre itself in the part of the hollow left free
        var ovl = (open && !full && m === 'overlay' && drawer) ? drawer.offsetWidth : 0;
        setVar('--vt-frame-ovl-left', px(ovl));
        // C frame (owner 2026-10-18): with the panel hidden a narrow SPINE
        // keeps the top and bottom bars joined — the frame stays a "C".
        var spine = (occ > 0) ? 0 : (m === 'sheet' ? SPINE_PHONE : SPINE);
        var cleft = occ > 0 ? occ : spine;
        if (open && m === 'sheet') { cleft = spine; }
        setVar('--vt-frame-spine', px(spine));
        setVar('--vt-frame-cleft', px(cleft));
        setCls(body, 'vt-c-spine', spine > 0);
        var dock = (m === 'dock') ? cleft : 0;
        setVar('--vt-frame-dock', px(dock));

        // ---- C frame 3: the protrusions (docs/UI_LAYOUT.md) ---------------
        // Their sizes come from CSS (log height, joystick size), their places
        // from these variables; nothing here depends on the right panel's
        // own placement, so the two scripts cannot chase each other.
        var log = $('div_log_view');
        var logVis = visible(log);
        var logFull = logVis && log.classList.contains('log-expanded');
        var lh = (logVis && !logFull) ? log.offsetHeight : 0;
        setVar('--vt-frame-log-h', px(lh));
        var joy = $('joy_view');
        var joyOn = visible(joy);
        setCls(body, 'vt-joy-on', joyOn);
        var jw = joyOn ? joy.offsetWidth : 0;
        // the small log rises from the bottom bar, from the back of the C;
        // when the open panel leaves it too little room it runs under the
        // panel instead (the panel then stands on it)
        var logLeft = cleft;
        var wide = lh > 0 && m !== 'sheet' && occ > 0 && (W - occ - jw) < LOG_MIN_W;
        if (wide) { logLeft = 0; }
        setCls(body, 'vt-log-wide', wide);
        // the joystick stands on the bottom bar at the right edge, beside the
        // small log — or ON the log when the two would not fit side by side
        // (phone in portrait)
        var joyOnLog = joyOn && lh > 0 && (W - logLeft - jw) < LOG_MIN_W;
        setCls(body, 'vt-joy-on-log', joyOnLog);
        setVar('--vt-frame-log-left', px(logLeft));
        setVar('--vt-frame-log-right', px(joyOn && !joyOnLog ? jw : 0));
        setVar('--vt-frame-joy-w', px(jw));
        setVar('--vt-frame-joy-b', px(bh + (joyOnLog ? lh : 0)));
        setVar('--vt-frame-ledge', px(bh + lh));       // top of the bottom bar + small log
        setCls(body, 'vt-c-log', lh > 0);

        // right panel: hangs from the top band at the right edge
        var rp = $('right_panel');
        var rpOn = visible(rp);
        var rpw = 0, rpb = nb, rpFull = false;
        if (rpOn) {
            var rr = rp.getBoundingClientRect();
            rpb = rr.bottom;
            rpFull = !rp.classList.contains('compact') && !rp.classList.contains('narrow');
            if (m !== 'sheet') { rpw = Math.max(0, W - rr.left); }
            setVar('--vt-frame-rp-left', px(rr.left));
        }
        setCls(body, 'vt-c-rp', rpOn);
        // an unfolded right panel on a low window (landscape phone) would be
        // squeezed to a sliver above the stick: the stick then stands beside
        // the panel's column instead, and the column runs down to the ledge
        var joyBeside = joyOn && rpOn && rpFull && m !== 'sheet' &&
            (H - (bh + (joyOnLog ? lh : 0)) - joy.offsetHeight - top) < JOY_BESIDE_MIN;
        setCls(body, 'vt-joy-beside-rp', joyBeside);
        setVar('--vt-frame-joy-r', px(joyBeside ? rpw : 0));
        setVar('--vt-frame-rp-w', px(rpw));
        setVar('--vt-frame-rp-b', px(rpb));
        // the full log grows from the bottom bar into the hollow, beside the
        // right panel / the joystick (never under them, never over the notices)
        var flr = 0;
        if (rpOn && m !== 'sheet') { flr = Math.max(flr, W - rp.getBoundingClientRect().left + 8); }
        if (joyOn && m !== 'sheet') { flr = Math.max(flr, jw + 8); }   // phone: the stick stays on top of it
        setVar('--vt-frame-logfull-r', px(flr));
        setCls(body, 'vt-c-logfull', logFull);
        setCls(body, 'vt-c-logfull-edge', logFull && flr === 0);

        // bottom of the C's cavity at its back: the bottom bar + the small log,
        // the top of the full log, or the top of the open phone sheet (the
        // sheet is the bottom of the C rising)
        var cb = bh + (logLeft <= cleft ? lh : 0);
        if (logFull) { cb = Math.max(cb, H - log.getBoundingClientRect().top); }
        if (open && m === 'sheet' && drawer) { cb = Math.max(bh, H - drawer.getBoundingClientRect().top); }
        setVar('--vt-frame-cbottom', px(cb));

        // U1 kolo 6: joystick vs. the phone sheet — when the stick is on and
        // the sheet is open, the sheet leaves room above itself for the stick
        // and the stick sits right above the sheet (never under it)
        if (m === 'sheet' && open && joyOn && drawer) {
            // the free band ends at the notices AND the right panel's row
            var avail = H - bh - Math.max(nb, rpb);
            var jh = joy.offsetHeight || 150;
            setVar('--vt-frame-sheet-max', px(Math.max(160, avail - jh - 24)));
            setVar('--vt-frame-sheet-h', px(drawer.offsetHeight));
        } else {
            setVar('--vt-frame-sheet-h', '0px');
        }

        // ---- the large camera: part of the scheme, in the C's hollow -------
        placeCamLarge(m, cleft, nb, rpb, rpw, rpFull, bh + lh, W, H);

        // the map canvas changes size when the docked panel opens/closes or
        // when it moves into / out of the right panel (large camera swap)
        var mini = body.classList.contains('vt-map-mini');
        if (dock !== lastDock || mini !== lastMini) {
            lastDock = dock;
            lastMini = mini;
            if (resizeTimer) { clearTimeout(resizeTimer); }
            resizeTimer = setTimeout(function () {
                window.dispatchEvent(new Event('resize'));
            }, 230);   // after the drawer's 0.2 s slide
        }
        // the right panel hangs from the top band: re-place it when that moves
        if (top !== lastTop) {
            lastTop = top;
            if (window.VtRightDock) { window.VtRightDock.place(); }
        }
    }

    // Large camera geometry. With the map in the right panel (the swap) the
    // camera takes the whole hollow (image centred, 4:3); otherwise it is the
    // biggest 4:3 box anchored in the hollow's top-left corner at the back of
    // the C (phone portrait: a band across the top, at most half the hollow),
    // so the map stays visible beside / below it.
    var STREAM_MAX_W = 640;
    function placeCamLarge(m, cleft, nb, rpb, rpw, rpFull, ledge, W, H) {
        var body = document.body;
        if (!body.classList.contains('vt-cam-large')) { return; }
        var mini = body.classList.contains('vt-map-mini');
        var L = cleft, T = (m === 'sheet') ? Math.max(nb, rpb) : nb;
        var R = (m !== 'sheet' && rpFull) ? rpw : 0;
        var aw = Math.max(80, W - L - R), ah = Math.max(60, H - ledge - T);
        if (m === 'sheet') { ah = Math.min(ah, Math.round((H - ledge - T) * 0.5)); }
        var cw = aw, ch = Math.round(aw * 3 / 4);
        if (ch > ah) { ch = ah; cw = Math.round(ah * 4 / 3); }
        // with the map in the slot the camera's box fills the hollow left of
        // the right panel (not under it: the map shows through the panel's
        // window there), the image centred
        var bw = mini ? aw : cw, bhh = mini ? ah : ch;
        setVar('--vt-cam-ml', px(mini ? (aw - cw) / 2 : 0));
        setVar('--vt-cam-l', px(L));
        setVar('--vt-cam-t', px(T));
        setVar('--vt-cam-w', px(bw));
        setVar('--vt-cam-h', px(bhh));
        setVar('--vt-cam-cw', px(cw));
        setVar('--vt-cam-ch', px(ch));
        // the stream: sharp but bounded (the canvas is scaled by CSS)
        var cv = window.camera_view;
        if (!cv || !cv.camViewer || !cv._big) { return; }
        var sw = Math.min(cw, STREAM_MAX_W), sh = Math.round(sw * 3 / 4);
        if (Math.abs((cv.camViewer.width || 0) - sw) < 8 && Math.abs((cv.camViewer.height || 0) - sh) < 8) { return; }
        cv.camViewer.width = sw;
        cv.camViewer.height = sh;
        cv.camViewer.quality = 60;
        var cnv = cv.camViewer.canvas || ($('div_camera_view') && $('div_camera_view').querySelector('canvas'));
        if (cnv) { cnv.width = sw; cnv.height = sh; }
        if (cv._active && typeof cv.reloadStream === 'function') { cv.reloadStream('large', true); }
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
        if (last === 'needs' && window.VTNeeds && window.VTNeeds.open) { window.VTNeeds.open(); return; }   // U2
        if (last === 'support' && window.VTSupport && window.VTSupport.open) { window.VTSupport.open(); return; }   // U2
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
            if (!b) { return; }
            setCls(b, 'vt-on', on[id]);
            var ap = on[id] ? 'true' : 'false';
            if (b.getAttribute('aria-pressed') !== ap) { b.setAttribute('aria-pressed', ap); }
        });
    }

    // C frame: the spine (clickable = open the panel) and the two concave
    // inner corners where the spine/panel meets the top and the bottom bar
    function installC() {
        if ($('vt_c_spine')) { return; }
        var sp = document.createElement('button');
        sp.type = 'button';
        sp.id = 'vt_c_spine';
        sp.setAttribute('aria-label', 'Show panel (Alt+P)');
        sp.title = 'Show panel (Alt+P)';
        sp.addEventListener('click', function (e) { e.preventDefault(); togglePanel(); });
        document.body.appendChild(sp);
        // tl/bl: the back meets the top / the bottom; tr: the top band turns
        // down into the right panel; jb: the joystick's foot on the bottom
        // ledge; lr: the full log's foot on the bottom bar (C frame 3)
        ['tl', 'bl', 'tr', 'jb', 'lr'].forEach(function (k) {
            var c = document.createElement('div');
            c.id = 'vt_c_' + k;
            c.className = 'vt-c-corner';
            c.setAttribute('aria-hidden', 'true');
            document.body.appendChild(c);
        });
        // large camera: the map shrinks into the right panel's camera slot;
        // this cover takes the clicks there (never a goal / marker click on
        // the tiny map) and swaps back
        var mm = document.createElement('button');
        mm.type = 'button';
        mm.id = 'vt_map_mini';
        mm.title = 'Back to the map (Alt+C)';
        mm.setAttribute('aria-label', 'Back to the map — small camera (Alt+C)');
        mm.innerHTML = '<span><i class="la la-map"></i> Map</span>';
        mm.addEventListener('click', function (e) { e.preventDefault(); camSet(false); });
        document.body.appendChild(mm);
    }

    function init() {
        installC();
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
            if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.code === 'KeyC') {
                var tg = ev.target && ev.target.tagName;
                if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') { return; }
                ev.preventDefault();
                camSet(!document.body.classList.contains('vt-cam-large'));
                return;
            }
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
        hookCamera(0);
        // right_dock.js builds the right panel after load; re-measure then
        setTimeout(schedule, 500);
        setTimeout(schedule, 1500);
    }

    // ------------------------------------------------ camera small / large
    // Three states, all chosen in the right panel's Camera section (+ Alt+C):
    //   hidden = the section folded (or the panel closed): no stream;
    //   small  = live preview in the right panel's slot;
    //   large  = the camera takes the C's hollow and the map moves into the
    //            slot (desktop) / a band across the top of the hollow (phone).
    // Large is remembered (vitulus_cam_large). The stream only runs while the
    // camera is on screen (right_dock.js paintCam decides).
    var LS_CAMLARGE = 'vitulus_cam_large';
    function camSet(large) {
        var body = document.body, cv = window.camera_view;
        large = !!large;
        lsSet(LS_CAMLARGE, large ? '1' : '0');
        if (large && window.VtRightDock) { window.VtRightDock.reveal(); }   // open panel + unfold Camera
        setCls(body, 'vt-cam-large', large);
        if (!large) { setCls(body, 'vt-map-mini', false); }
        update();                                   // geometry before the stream is sized
        if (cv && typeof cv._applySize === 'function' && !!cv._big !== large) {
            cv._big = large;
            if (cv.camViewer && cv._active) { cv._applySize(); }
        }
        update();
        if (window.VtRightDock) { window.VtRightDock.place(); }
    }
    // CameraView's own click on the view (zoom in / out) goes the same way
    function hookCamera(tries) {
        var cv = window.camera_view;
        if (!cv || typeof cv.toggleSize !== 'function') {
            if (tries < 40) { setTimeout(function () { hookCamera(tries + 1); }, 500); }
            return;
        }
        if (cv.__vtHooked) { return; }
        cv.__vtHooked = true;
        cv.toggleSize = function () { camSet(!document.body.classList.contains('vt-cam-large')); };
        if (lsGet(LS_CAMLARGE) === '1') { setTimeout(function () { camSet(true); }, 800); }
    }

    window.VtFrame = {update: schedule, toggle: togglePanel, mode: mode, camSet: camSet,
                      camLarge: function () { return document.body.classList.contains('vt-cam-large'); }};
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); }); }
    else { setTimeout(init, 0); }
})();
