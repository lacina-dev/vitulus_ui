/* status_header.js — the robot status icon strip (#status_div, the green
   pictograms: wifi/gps/imu/lidar/camera/mower/motors/temps/supply/batt)
   lives at the top of the map view on small screens, but on a wide viewport
   it moves into the page header, between the rain icon and the menu button.
   The strip is the SAME element either way (dashboard.js updates the <img>
   nodes by id; moving a node keeps those references valid). */
(function () {
    'use strict';
    if (window.__status_header_wired) { return; }   // never double-wire
    window.__status_header_wired = true;
    var BREAK = 992;          // px; below this the strip stays where it was
    var moved = false;
    var marker = null;        // remembers the original spot in #row_icons

    function els() {
        return {
            strip: document.getElementById('status_div'),
            brand: document.querySelector('nav .navbar-brand'),
            toggler: document.getElementById('btn_navbar_toggler')
        };
    }

    function toHeader() {
        var e = els();
        if (!e.strip || !e.toggler || !e.toggler.parentNode || moved) { return; }
        if (!marker) {
            marker = document.createElement('span');
            marker.id = 'status_div_home';
            marker.style.display = 'none';
            e.strip.parentNode.insertBefore(marker, e.strip);
        }
        e.toggler.parentNode.insertBefore(e.strip, e.toggler);
        e.strip.classList.add('in-header');
        moved = true;
    }

    function toMap() {
        var e = els();
        if (!e.strip || !moved) { return; }
        if (marker && marker.parentNode) {
            marker.parentNode.insertBefore(e.strip, marker);
        }
        e.strip.classList.remove('in-header');
        moved = false;
    }

    /* Seventeen icons in one 417 px line was a washing line.  The same icons,
       wrapped into four meaning-groups with a gap between groups, read faster
       and take a third less width — and when the space is genuinely narrow the
       groups wrap into two short rows instead of one long one.  The <img>
       nodes are MOVED, never recreated: dashboard.js swaps their `src` by bare
       id, so the ids must survive and must not be duplicated. */
    var GROUPS = [
        {id: 'sense', title: 'Connectivity, position & sensors',
         icons: ['ico_wifi', 'ico_gps', 'ico_gps_nav', 'ico_imu', 'ico_lidar', 'ico_camera']},
        {id: 'drive', title: 'Drive & mower',
         icons: ['ico_fl_motor', 'ico_fr_motor', 'ico_rl_motor', 'ico_rr_motor', 'ico_mower']},
        {id: 'therm', title: 'Temperatures & cooling',
         icons: ['ico_temp_pcb', 'ico_fan_pcb', 'ico_temp', 'ico_fan']},
        {id: 'power', title: 'Power',
         icons: ['ico_supply', 'ico_batt']}
    ];
    var TITLES = {
        ico_wifi: 'Wi-Fi', ico_gps: 'GPS fix', ico_gps_nav: 'GPS navigation',
        ico_imu: 'IMU', ico_lidar: 'Lidar', ico_camera: 'Camera',
        ico_mower: 'Mower', ico_fl_motor: 'Front-left motor',
        ico_fr_motor: 'Front-right motor', ico_rl_motor: 'Rear-left motor',
        ico_rr_motor: 'Rear-right motor', ico_temp_pcb: 'PCB temperature',
        ico_fan_pcb: 'PCB fan', ico_temp: 'Ambient temperature',
        ico_fan: 'External fan', ico_supply: 'Supply input',
        ico_batt: 'Battery'
    };

    function groupIcons() {
        var strip = document.getElementById('status_div');
        if (!strip || strip.dataset.grouped === '1') { return; }
        strip.classList.add('sh-strip');
        GROUPS.forEach(function (g) {
            var box = document.createElement('span');
            box.className = 'sh-group';
            box.setAttribute('data-group', g.id);
            box.title = g.title;
            g.icons.forEach(function (id) {
                var img = document.getElementById(id);
                if (!img) { return; }              // a missing icon is not fatal
                if (!img.title && TITLES[id]) { img.title = TITLES[id]; }
                box.appendChild(img);              // move, keep the same node
            });
            if (box.childNodes.length) { strip.appendChild(box); }
        });
        strip.dataset.grouped = '1';
    }

    /* Host telemetry belongs with the header controls, not buried in a
       diagnostic page.  The agent bridge exposes a read-only /api/system
       sample; this widget only reads it and remains visibly stale/offline when
       the bridge cannot answer. */
    var monitor = null;
    var monitorTimer = null;

    function metricBox(label) {
        var box = document.createElement('span');
        box.className = 'sh-system-metric';
        box.dataset.metric = label.toLowerCase();
        var ring = document.createElement('i');
        ring.className = 'sh-system-ring';
        var value = document.createElement('b');
        value.textContent = '–';
        ring.appendChild(value);
        var name = document.createElement('small');
        name.textContent = label;
        box.appendChild(ring);
        box.appendChild(name);
        return box;
    }

    /* The widget lives in ONE place: first item of the header controls list
       (#div_menu .navbar-nav), BEFORE the Fullscreen/Restart buttons — the
       owner's decision (2026-08-29).  Bootstrap then does the responsive work
       for free: on lg+ that list is the right-aligned header group, below lg
       it sits inside the #navcol-1 collapse, so the monitor folds under the
       hamburger together with the buttons instead of crowding the phone bar.
       app.js prepends its own buttons at its own pace, so first place is
       re-asserted on every ensure (each 2 s poll tick + resize). */
    function monitorHome() {
        return document.querySelector('#div_menu .navbar-nav');
    }

    function ensureSystemMonitor() {
        var home = monitorHome();
        if (!home) { return null; }
        if (!monitor) {
            monitor = document.createElement('li');
            monitor.id = 'system_monitor_header';
            monitor.className = 'nav-item sh-system is-offline';
            monitor.title = 'System Vitulus NUC';
            var state = document.createElement('i');
            state.className = 'sh-system-state';
            monitor.appendChild(state);
            ['CPU', 'MEM', 'DISK'].forEach(function (label) {
                monitor.appendChild(metricBox(label));
            });
            var net = document.createElement('span');
            net.className = 'sh-system-net';
            net.dataset.metric = 'net';
            net.innerHTML = '<small>NET</small><b class="rx">↓ –</b><b class="tx">↑ –</b>';
            monitor.appendChild(net);
        }
        monitor.classList.remove('sh-system-inline');   // legacy mode, gone
        if (monitor.parentNode !== home || home.firstElementChild !== monitor) {
            home.insertBefore(monitor, home.firstElementChild);  // move, never recreate
        }
        return monitor;
    }

    function systemColor(value) {
        if (value >= 90) { return '#ff5263'; }
        if (value >= 75) { return '#ffb547'; }
        return '#43d58b';
    }

    function setPercent(name, value, title) {
        if (!monitor) { return; }
        var box = monitor.querySelector('[data-metric="' + name + '"]');
        if (!box) { return; }
        var ring = box.querySelector('.sh-system-ring');
        var output = ring.querySelector('b');
        var valid = typeof value === 'number' && isFinite(value);
        var percent = valid ? Math.max(0, Math.min(100, value)) : 0;
        var color = valid ? systemColor(percent) : '#667784';
        output.textContent = valid ? Math.round(percent) + '%' : '–';
        ring.style.background = 'conic-gradient(' + color + ' ' +
            (percent * 3.6) + 'deg, rgba(255,255,255,.13) 0)';
        box.title = title;
    }

    function formatRate(value) {
        if (typeof value !== 'number' || !isFinite(value)) { return '–'; }
        var units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
        var unit = 0;
        while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
        return (value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)) + units[unit];
    }

    function paintSystem(data) {
        if (!ensureSystemMonitor()) { return; }
        var cpu = data && data.cpu || {};
        var mem = data && data.mem || {};
        var disk = data && data.disk || {};
        var net = data && data.net || {};
        setPercent('cpu', cpu.percent,
            'CPU ' + (cpu.percent == null ? 'nedostupné' : cpu.percent + '%') +
            ' · load ' + (cpu.load_1m == null ? '–' : cpu.load_1m));
        setPercent('mem', mem.percent, 'Paměť ' + (mem.percent == null ? 'nedostupná' : mem.percent + '%'));
        setPercent('disk', disk.percent,
            'Disk / ' + (disk.percent == null ? 'nedostupný' : disk.percent + '%') +
            ' · volno ' + (disk.free_bytes == null ? '–' : formatRate(disk.free_bytes).replace('/s', '')));
        var netBox = monitor.querySelector('[data-metric="net"]');
        netBox.querySelector('.rx').textContent = '↓ ' + formatRate(net.rx_bytes_s);
        netBox.querySelector('.tx').textContent = '↑ ' + formatRate(net.tx_bytes_s);
        monitor.classList.remove('is-offline');
        monitor.title = 'System Vitulus NUC · aktualizováno ' + new Date((data.ts || Date.now() / 1000) * 1000).toLocaleTimeString();
    }

    function pollSystem() {
        ensureSystemMonitor();
        var url = location.protocol + '//' + location.hostname + ':8088/api/system';
        fetch(url, {cache: 'no-store'}).then(function (response) {
            if (!response.ok) { throw new Error('HTTP ' + response.status); }
            return response.json();
        }).then(paintSystem).catch(function () {
            if (monitor) { monitor.classList.add('is-offline'); monitor.title = 'Systémová telemetrie nedostupná'; }
        }).finally(function () {
            monitorTimer = window.setTimeout(pollSystem, 2000);
        });
    }

    function relayout() {
        groupIcons();
        ensureSystemMonitor();
        if (window.innerWidth >= BREAK) { toHeader(); } else { toMap(); }
    }

    var t = null;
    function onResize() {
        if (t) { clearTimeout(t); }
        t = setTimeout(relayout, 120);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { relayout(); pollSystem(); });
    } else { relayout(); pollSystem(); }
    window.addEventListener('resize', onResize);
    /* Widget styling lives in assets/css/status_header.css. */
})();
