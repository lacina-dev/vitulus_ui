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

    function relayout() {
        groupIcons();
        if (window.innerWidth >= BREAK) { toHeader(); } else { toMap(); }
    }

    var t = null;
    function onResize() {
        if (t) { clearTimeout(t); }
        t = setTimeout(relayout, 120);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', relayout);
    } else { relayout(); }
    window.addEventListener('resize', onResize);
})();
