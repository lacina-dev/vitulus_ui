// vitulus_ui — single-page orchestrator.
//
// The three former pages are now folded into one document:
//   #section_map -> map_view.js (window.initMapView) [default, eager]
//   the planner is integrated into the map view (top-down edit mode)
//   the IMU calibration page is now a TAB (#tab_imu) inside the settings menu
//     (#div_menu_config), lazily initialised by initImu() on first reveal.
//
// Each renderer (ros3d) must be initialised while its container is visible and
// sized, so the IMU viewer is initialised the first time its tab is shown, not
// at page load, and its render loop only runs while that tab is visible.

(function () {
    'use strict';

    // The former separate "Planner" section is gone: the map editor is now
    // integrated INTO the map view (top-down edit mode, controls in the map
    // menu — see mapeditor.js / initPlanner's integrated path).
    var SECTIONS = ['section_map'];

    // Lazy-init state. map_view is initialised eagerly on window load.
    var inited = {
        section_map: false,
    };

    function ensureInit(id) {
        if (inited[id]) return;
        // Only the map section remains as a page-level section; it is initialised
        // eagerly on window load (see below), so there is nothing lazy to do here.
        return;
    }

    // Start/stop a ros3d viewer's render loop (ROS3D.Viewer.start()/stop()).
    function setRos3dActive(v, active) {
        if (!v) return;
        try {
            if (active) { if (v.stopped) v.start(); }
            else { if (!v.stopped && typeof v.stop === 'function') v.stop(); }
        } catch (e) { /* viewer without start/stop */ }
    }

    // ---- IMU calibration: now a tab inside the settings menu (#div_menu_config).
    // The IMU 3D viewer (ros3d) must only render while that tab is actually
    // visible (settings menu open AND IMU tab active), otherwise it keeps drawing
    // at 60fps in the background and saturates the GPU — the same concern the old
    // page-sections had. syncImuRender() reconciles the render loop with that
    // visibility, lazily initialising imu_calibration.js on first reveal.
    var imuInited = false;

    function syncImuRender() {
        var menu = document.getElementById('div_menu_config');
        var tab = document.getElementById('tab_imu');
        var menuVisible = !!menu && menu.style.display !== 'none' &&
            getComputedStyle(menu).display !== 'none';
        var tabActive = !!tab && tab.classList.contains('active');
        var on = menuVisible && tabActive;
        if (on && !imuInited) {
            try {
                if (typeof window.initImu === 'function') {
                    window.initImu();
                    imuInited = true;
                }
            } catch (e) {
                console.error('[vitulus_ui] initImu failed:', e);
            }
        }
        setRos3dActive(window.__ros3d_imu, on);
        if (on) {
            // The IMU viewer uses a ResizeObserver on #3d_view; nudge a resize once
            // the tab is laid out so it picks up the now-visible size.
            setTimeout(function () {
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            }, 80);
        }
    }
    window.__syncImuRender = syncImuRender;

    function wireImuTab() {
        var tabs = document.querySelectorAll(
            '#div_menu_config .nav-tabs a[data-bs-toggle="tab"]');
        tabs.forEach(function (a) {
            a.addEventListener('shown.bs.tab', syncImuRender);
        });
    }

    function showSection(id) {
        if (SECTIONS.indexOf(id) === -1) id = 'section_map';
        SECTIONS.forEach(function (sid) {
            var el = document.getElementById(sid);
            if (el) el.style.display = (sid === id) ? '' : 'none';
        });
        // Highlight the active nav link.
        var links = document.querySelectorAll('.nav-section-link');
        links.forEach(function (a) {
            if (a.getAttribute('data-section') === id) a.classList.add('active');
            else a.classList.remove('active');
        });
        ensureInit(id);
        // Pause the map view's heavy ROS work (SLAM occupancy grid, laser, point
        // clouds, camera) while another section is active — otherwise it keeps
        // rebuilding the occupancy-grid mesh in the background and starves the
        // planner/IMU, which froze the UI. Resume when the map section is shown.
        try {
            if (window.ros && typeof window.ros.suspend === 'function') {
                if (id === 'section_map') window.ros.resume();
                else window.ros.suspend();
            }
        } catch (e) { /* map view not initialised yet */ }
        // Stop the ros3d render loops (map view, IMU) of hidden sections. They
        // otherwise keep drawing their 3D scenes at 60fps regardless of
        // visibility; with all three sections open that saturated the GPU and
        // took down the remote desktop (NoMachine) session. The planner's own
        // viewer already skips drawing while hidden.
        setRos3dActive(window.__ros3d_map, id === 'section_map');
        // Let the now-visible renderer recompute its canvas size. ros2d (planner)
        // listens for window 'resize'; map_view re-layouts on it too; imu uses a
        // ResizeObserver that fires when the element becomes visible.
        try { window.dispatchEvent(new Event('resize')); } catch (e) { /* old browsers */ }
        // A second tick after layout settles (some viewers read size async).
        setTimeout(function () {
            try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        }, 60);
    }

    function sectionFromHash() {
        var h = (location.hash || '').replace('#', '');
        if (h === 'map') return 'section_map';
        // '#planner' is legacy (old deep link / bookmark) — the planner is now
        // part of the map view, so fall back to the map section.
        if (h === 'planner') return 'section_map';
        return null;
    }

    function wireNav() {
        var links = document.querySelectorAll('.nav-section-link');
        links.forEach(function (a) {
            a.addEventListener('click', function (ev) {
                ev.preventDefault();
                var id = a.getAttribute('data-section');
                if (location.hash !== a.getAttribute('href')) {
                    location.hash = a.getAttribute('href');
                }
                showSection(id);
                // Collapse the mobile navbar after picking a section.
                var collapse = document.getElementById('navcol-1');
                if (collapse && collapse.classList.contains('show')) {
                    collapse.classList.remove('show');
                }
            });
        });
        window.addEventListener('hashchange', function () {
            var id = sectionFromHash();
            if (id) showSection(id);
        });
        addRestartButton();
        wireImuTab();
    }

    // ---- "Restart robot" button (POST /system/restart on the web server) ----
    function addRestartButton() {
        var ul = document.querySelector('#div_menu .navbar-nav');
        if (!ul || document.getElementById('btn_robot_restart')) return;
        var li = document.createElement('li');
        li.className = 'nav-item d-inline-flex align-items-center';
        li.style.display = 'inline-flex';
        li.innerHTML = '<a class="nav-link" href="#" id="btn_robot_restart" ' +
            'title="Restart the whole robot (vitulus.service)">' +
            '<i class="la la-power-off" style="margin-right:8px;font-size:18px;color:#e8643c;"></i>Restart</a>';
        ul.appendChild(li);
        li.querySelector('#btn_robot_restart').addEventListener('click', function (ev) {
            ev.preventDefault();
            confirmRestart();
        });
    }

    function restartOverlay() {
        var el = document.createElement('div');
        el.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(18,24,28,0.92);' +
            'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
            'color:#d6e6f0;font-size:18px;text-align:center;padding:20px;';
        el.innerHTML = '<div style="width:46px;height:46px;border:4px solid rgba(255,255,255,0.15);' +
            'border-top-color:#e8643c;border-radius:50%;animation:vitulus-spin 1s linear infinite;margin-bottom:18px;"></div>' +
            '<div id="restart_msg" style="white-space:pre-line;max-width:520px;"></div>';
        document.body.appendChild(el);
        return {
            setText: function (t) { var m = el.querySelector('#restart_msg'); if (m) m.textContent = t; },
            close: function () { el.remove(); },
        };
    }

    function confirmRestart() {
        if (!window.confirm('Restart the whole robot now?\n\n' +
            'All running robot programs will stop and the system will come back up in a minute or two.')) return;
        var ov = restartOverlay();
        ov.setText('Sending restart command…');
        fetch('/system/restart', { method: 'POST' })
            .then(function (r) { return r.json().catch(function () { return { ok: true }; }); })
            .then(function (d) {
                if (d && d.ok === false) {
                    ov.setText('Restart failed: ' + (d.error || 'unknown') +
                        '\n\nIs the passwordless sudo rule installed?\n' +
                        '(setup/vitulus-ui-sudoers → /etc/sudoers.d/vitulus-ui)');
                    addCloseButton(ov);
                    return;
                }
                pollUntilBack(ov);
            })
            .catch(function () {
                // The server may already have been killed by the restart — expected.
                pollUntilBack(ov);
            });
    }

    function addCloseButton(ov) {
        var b = document.createElement('button');
        b.textContent = 'Close';
        b.className = 'btn btn-sm btn-light';
        b.style.marginTop = '16px';
        b.onclick = function () { ov.close(); };
        document.querySelector('#restart_msg').appendChild(document.createElement('br'));
        document.querySelector('#restart_msg').appendChild(b);
    }

    function pollUntilBack(ov) {
        var t0 = Date.now();
        var iv = setInterval(function () {
            var secs = Math.round((Date.now() - t0) / 1000);
            ov.setText('Robot is restarting… (' + secs + 's)\nThe page will reload automatically when it is back.');
            fetch('/?_=' + Date.now(), { cache: 'no-store' }).then(function (r) {
                if (r && r.ok && secs > 5) {   // ignore the brief window before the old server dies
                    clearInterval(iv);
                    ov.setText('Back online — reloading…');
                    setTimeout(function () { location.reload(); }, 900);
                }
            }).catch(function () { /* still down — keep polling */ });
        }, 3000);
    }

    // Wire navigation as soon as the DOM is ready.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireNav);
    } else {
        wireNav();
    }

    // Initialise the map view eagerly (it is the default section and the most
    // important live view). Done on 'load' so jQuery/bootstrap (foot scripts)
    // and all assets are available, matching the original window.onload timing.
    window.addEventListener('load', function () {
        if (typeof window.initMapView === 'function') {
            try {
                window.initMapView();
                inited.section_map = true;
                // Wire the in-view map editor now that window.ros / __ros3d_map /
                // map_menu exist (mapeditor.js builds the overlay lazily on first
                // use, so this just attaches the menu button + map-info sub).
                if (window.MapEditor && window.MapEditor.wire) window.MapEditor.wire();
            } catch (e) {
                console.error('[vitulus_ui] initMapView failed:', e);
            }
        }
        // Honour a deep link (e.g. /map_edit served at #planner) once map view
        // is up, so the requested section is shown and initialised.
        var deep = sectionFromHash();
        if (deep && deep !== 'section_map') {
            showSection(deep);
        }
    });
})();
