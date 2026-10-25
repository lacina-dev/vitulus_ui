#!/usr/bin/env python3
"""help_shots.py — refresh the screenshots of the help (docs/help/img/shot-*.webp).

The help shows the real UI in small, annotated crops: a numbered marker on each
control that the text next to the picture explains. This script makes all of
them again from a running UI, so after a UI change it is one command:

    # a dev instance of THIS worktree, never the live robot UI (see README):
    nice -n 19 tools/help_shots.py --url http://127.0.0.1:7861
    nice -n 19 tools/help_shots.py --url http://127.0.0.1:7861 --only shot-dock-tab,shot-navi
    nice -n 19 tools/help_shots.py --url http://127.0.0.1:7861 --demo   # the pictures for the help
    tools/help_shots.py --list

Safety: every page is opened with ?mock (vt_mock.js: the page reads the robot
live but sends nothing) and the script stops when the page is not in mock mode.
It only clicks menu buttons, tabs and section heads (list CLICK_OK); port 7779
(the live UI) is refused.

--demo: the panels that show conversations and reports (Agent chat, Support
issues, Needs you, Activity) get invented, neutral content instead of the
owner's real chat and reports. The browser answers those GET requests itself
(Playwright route, DEMO below) — nothing is sent to any server. Shots marked
demo=True are skipped without --demo, so the owner's messages never end up in
the help by accident.

Needs: python3-playwright + Google Chrome, Pillow with WebP. The pictures are
the live robot's state at that moment (night = black camera) — shots whose
content would mislead are schematic SVG instead (docs/help/img/*.svg).
"""
import argparse
import io
import json
import time
import os
import re
import sys

try:
    os.nice(19)          # the robot's CPU is shared with navigation
except Exception:
    pass

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs', 'help', 'img')

DESK = (1440, 900)
PHONE = (390, 844)

# Selectors the script may click (DOM .click()): menu, tabs, section heads,
# view switches. Anything that could command the robot is not here.
CLICK_OK = re.compile(r'^(#btn_(marker|settings|map|programs|agent|support|log|joy|panel_toggle|help|needs)'
                      r'|a\[href="#tab[-_][\w-]+"\]|#btn_ui_drawer_(help|full)|#btn_log_expand|#btn_map_detail_toggle|#div_menu_program_items_row|#btn_calendar_add|\.vth-|#vt_help|\[data-tab=|'
                      r'#rp_|\.rp-|\.vco-btn|\.vt-sec|summary|details|\.vagent-tab|\.vt-support-tab|\.cam-|#cam_|\.vtcam)')

# the map view starts close on the dock; a little farther shows the garden.
# The aerial photo layer is switched off in the pictures: it would show where
# the owner lives (the help goes to every user of the kit).
AERIAL_OFF = "const a = document.getElementById('mapv3_chk_aerial'); if (a && a.checked) a.click(); return '';"
ZOOM_OUT = ("const v = viewer.viewer; v.camera.position.z *= 2.2; v.cameraControls.update();" + AERIAL_OFF)

# the running card is painted by the page's own code from the mission's
# state; the picture sets that state in the page only (nothing is sent)
RUNNING = ("const L = (programs.program_list_msg && programs.program_list_msg.program_list) || [];"
           " programs.mission_program = (L[0] && L[0].name) || 'front_lawn';"
           " programs.mission_status = '%s'.replace('NAME', programs.mission_program);"
           " programs._paintRunning(); programs._paintRunning = () => {}; return '';")

# Every shot: name, viewport, steps before the picture, what to crop, markers.
#   steps: ('click', sel) | ('js', code) | ('wait', ms) | ('wheel', x, y, dy)
#   clip:  None = the whole viewport, a selector (its box), or [x, y, w, h]
#   marks: (selector, label, where) — where = tl tr bl br l r t b c (around the box),
#          a trailing '!' also draws a frame around the element
#   width: the width of the saved picture (px); scale: device pixel ratio
TALL = (1440, 1500)          # left-panel pictures: the whole tab fits without scrolling
OPEN = "document.querySelectorAll(%s).forEach(d => d.open = true); return '';"


def panel(btn, tab=None, more=()):
    st = [('click', btn), ('wait', 900)]
    if tab:
        st += [('click', 'a[href="#%s"]' % tab), ('wait', 700)]
    return st + list(more)


SHOTS = [
    # --- the whole screen (start.md) and the phone (frame.md)
    dict(name='shot-desktop', vp=DESK, scale=1, width=1200, md=26,
         steps=[('click', '#btn_map'), ('click', '#btn_log'), ('click', '#btn_joy'), ('wait', 1500), ('js', ZOOM_OUT),
                ('js', "const ok = document.querySelector('#joy_view .vt-joy-intro-ok'); if (ok && ok.offsetParent) ok.click(); return '';"), ('wait', 300)],
         marks=[('#status_div', '1', 'b'), ('#btn_marker', '2', 'r'),
                ('#ui_drawer_head', '3', 'c'), ('#map_view', '4', 'c'), ('#rp_body', '5', 'bl'),
                ('#div_log_view', '6', 'tr'), ('#joy_view', '7', 'l'), ('#vt_stop_big', '8', 'l')]),
    dict(name='shot-phone', vp=PHONE, scale=2, width=480, md=26,
         marks=[('#btn_needs', '1', 'b'), ('#btn_panel_toggle', '2', 'b'), ('#status_div', '3', 'r'), ('#map_view', '4', 'c'),
                ('#right_panel', '5', 'b'), ('#vt_stop_big', '6', 'bl'), ('#btn_log', '7', 't'), ('#btn_hdr_more', '8', 'b')]),
    # 2026-10-25 header variant A: a phone on its side = ONE header row (frame.md "The top bar")
    dict(name='shot-phone-land', vp=(844, 390), scale=2, width=844, clip=[0, 0, 844, 132], pad=0, md=22,
         marks=[('#conn_status', '1', 'b'), ('#btn_panel_toggle', '2', 'b'), ('#status_div', '3', 'b'), ('#btn_needs', '4', 'b'),
                ('#btn_robot_restart', '5', 'b'), ('#btn_hdr_more', '6', 'b'), ('#vt_stop_big', '7', 'bl')]),
    dict(name='shot-phone-sheet', vp=PHONE, scale=2, width=480, md=26,
         steps=[('click', '#btn_map'), ('wait', 1200)],
         marks=[('#ui_drawer_grip', '1', 'c'), ('#div_menu_map a[href="#tab-map"]', '2', 'b'), ('#btn_ui_drawer_help', '3', 't'),
                ('#btn_ui_drawer_full', '4', 't'), ('#btn_ui_drawer_close', '5', 't')]),
    # --- frame pieces (frame.md)
    # the big STOP in the top-right corner, in its collar; the header runs into it (safety.md, frame.md)
    dict(name='shot-stop', vp=DESK, scale=2, width=560, clip=[DESK[0] - 470, 0, 470, 210], pad=0, marks=[]),
    # 2026-10-25: Log · Follow · Joystick — pad 14 keeps the Joystick tab rising out of the bar
    dict(name='shot-bottom-bar', vp=(1000, 700), scale=2, width=900, clip='#div_bottom_menu', pad=14, marks=[]),
    dict(name='shot-log', vp=DESK, scale=2, width=900, clip='#div_log_view', pad=0, trim=(820, 300), md=18,
         steps=[('click', '#btn_log'), ('wait', 600), ('click', '#btn_log_expand'), ('wait', 1000)],
         marks=[('#div_log_view .btn-outline-info:not(.log-iconbtn)', '1', 'b'), ('#div_log_view .btn-outline-info:not(.log-iconbtn):not(.active)', '2', 'b'),
                ('#btn_log_pause', '3', 'b'), ('#btn_log_clear', '4', 'b'), ('#btn_log_collapse', '5', 'b'), ('.vth-q-log', '6', 'r')]),
    # 2026-10-25: the drive deck = the ring (variant C2, right column): capsule, speed segments,
    # Slow / Mid / Fast, the stick, Keys / Motors icons, ?, − / +
    dict(name='shot-joystick', vp=DESK, scale=3, width=420, clip='#joy_view', pad=0, md=15,
         steps=[('click', '#btn_joy'), ('wait', 800),
                ('js', "const ok = document.querySelector('#joy_view .vt-joy-intro-ok'); if (ok && ok.offsetParent) ok.click(); return '';"), ('wait', 300)],
         marks=[('#joy_view .vt-ring-cap', '1', 'r'), ('#joy_view .vt-ring-seg:nth-of-type(4)', '2', 't'),
                ('#joy_view .vt-ring-lbl[data-mode="fast"]', '3', 'tr'), ('#joy_view .vt-ring-knob', '4', 'c'), ('#joy_view [data-k="kb"]', '5', 'bl'),
                ('#joy_view [data-k="mot"]', '6', 'br'), ('#joy_view [data-k="help"]', '7', 'r'), ('#joy_view [data-k="minus"]', '8', 'l')]),
    dict(name='shot-camera-layers', vp=DESK, scale=2, width=400, clip='#right_panel section.rp-sec:last-of-type', pad=4, md=18,
         steps=[('click', '.vco-btn'), ('wait', 700)],
         marks=[('#right_panel .rp-cam-seg', '1', 't'), ('.vco-btn', '2', 'l'), ('.vco-chip:nth-of-type(1)', '3', 't'),
                ('.vco-chip:nth-of-type(2)', '4', 't'), ('.vco-chip:nth-of-type(3)', '5', 'b'), ('.vco-chip:nth-of-type(4)', '6', 'b'),
                ('.vco-op input', '7', 'b')]),
    # 2026-10-25 header variant A: the whole top bar — logo + dot · icons · computer · ? · bell · Restart · ⋯ · STOP
    dict(name='shot-navbar', vp=(1920, 900), scale=1.5, width=1400, clip=[0, 0, 1920, 84], pad=0, md=18,
         marks=[('#conn_status', '1', 'b'), ('#status_div', '2', 'b'), ('#system_monitor_header', '3', 'b'),
                ('#btn_help', '4', 'b'), ('#btn_needs', '5', 'b'), ('#btn_robot_restart', '6', 'b'), ('#btn_hdr_more', '7', 'b'),
                ('#vt_stop_big', '8', 'l')]),
    dict(name='shot-status-icons', vp=DESK, scale=3, width=900, clip='#status_div', pad=4, marks=[]),
    # --- right panel (dock.md, routes.md, localization.md)
    dict(name='shot-controls', vp=DESK, scale=3, width=560, clip='#right_panel section.rp-sec[data-sec="drive"]', pad=2, md=15,
         marks=[('#span_batt_pct', '1', 'l'), ('#rp_motors', '2', 'l'),
                ('#dock_btn_menu_dock', '3', 'b'), ('#dock_btn_menu_undock', '4', 'b'), ('#dock_btn_menu_stop', '5', 'b')]),
    # 2026-10-18 evening: three levels — head tokens, the expand (caret), the detail icon (before "?") to Map › Loc
    dict(name='shot-navi', vp=DESK, scale=3, width=560, clip='#right_panel section.rp-sec[data-sec="state"]', pad=2, md=15,
         steps=[('click', '.rp-sec[data-sec="state"] > h5'), ('wait', 1500)],
         marks=[('#span_odom_drive', '1', 'b'), ('#span_odom_hdg', '2', 'b'), ('#rp_odo_dot', '3', 'b'),
                ('.rp-sec[data-sec="state"] .rp-dq', '4', 'b'), ('#span_odom_prob', '5', 'b'),
                ('.rp-trk1 .vt-chip', '6', 'b')]),
    dict(name='shot-rp-mower', vp=DESK, scale=3, width=560, clip='#right_panel section.rp-sec[data-sec="mower"]', pad=2, md=15,
         steps=[('click', '.rp-sec[data-sec="mower"] > h5'), ('wait', 1000)],
         marks=[('#rp_mower_chip', '1', 'b'), ('#rp_mower_blade', '2', 'b'), ('#rp_mower_start', '3', 'b'),
                ('.rp-sec[data-sec="mower"] .rp-cells', '4', 'l')]),
    dict(name='shot-rp-gnss', vp=DESK, scale=3, width=560, clip='#right_panel section.rp-sec[data-sec="gnss"]', pad=2, md=15,
         steps=[('click', '.rp-sec[data-sec="gnss"] > h5'), ('wait', 2500)],
         marks=[('#rp_gnss_sum .vt-chip:nth-of-type(1)', '1', 'b'), ('#rp_gnss_sum .vt-chip:nth-of-type(2)', '2', 'b'),
                ('#rp_gnss_sum .rp-gsum-t', '3', 'b'), ('#rp_gnss_sum .rp-corr', '4', 'b'),
                ('.rp-sec[data-sec="gnss"] .rp-dq', '5', 'b'), ('.rp-gq .vt-gx-col:nth-of-type(1)', '6', 'l')]),
    # --- Map panel (mapping.md, dock.md, localization.md, routes.md)
    dict(name='shot-map-tab', vp=TALL, clip='#ui_drawer_head|#tab-map', steps=panel('#btn_map', 'tab-map'),
         marks=[('#active_map_name', '1', 'b'), ('#btn_map_detail_toggle', '2', 'r'), ('#mapv3_btn_deactivate', '3', 'r'),
                ('#mapv3_sites_row .ml-card.is-active .ml-head', '4', 'l'),
                ('#mapv3_sites_row .ml-card:not(.is-active) .ml-actions button:not(.del)', '5', 'l'),
                ('#mapv3_sites_row .ml-card:not(.is-active) .ml-btn.del', '6', 'r'),
                ('#mapv3_chk_base', '7', 't'),
                ('#tab-map details:nth-of-type(1) summary', '8', 'ri'), ('#tab-map details:nth-of-type(2) summary', '9', 'ri')]),
    dict(name='shot-map-recording', vp=TALL, clip='#tab-map details:nth-of-type(1)', trim=(2000, 470),
         steps=panel('#btn_map', 'tab-map', [('js', OPEN % "'#tab-map details:nth-of-type(1)'")]),
         marks=[('#mapv3_input_site', '1', 'tl'), ('#mapv3_btn_start', '2', 't'), ('#mapv3_btn_stop', '3', 't'),
                ('#mapv3_btn_reset_map', '4', 'b'), ('#mapv3_btn_discard', '5', 'b')]),
    dict(name='shot-dock-tab', vp=TALL, clip='#ui_drawer_head|#tab-dock',
         steps=panel('#btn_map', 'tab-dock', [('js', OPEN % "'#tab-dock details[data-drawersec=dock_points], #tab-dock details[data-drawersec=dock_seed]'")]),
         marks=[('#dock_label_enable_by_map', '1', 'l'), ('#dock_label_enable_by_intensity', '2', 'l'),
                ('#map_dock_btn_update_point', '3', 'r'), ('#map_undock_btn_update_point', '4', 'r'),
                ('details[data-drawersec=dock_mapping] summary', '5', 'ri'), ('#dock_div_seed_status', '6', 'ri'),
                ('details[data-drawersec=dock_program] summary', '7', 'ri'), ('details[data-drawersec=undock_program] summary', '8', 'ri')]),
    dict(name='shot-loc-tab', vp=TALL, clip='#ui_drawer_head|#tab-gloc', steps=panel('#btn_map', 'tab-gloc'),
         marks=[('#gloc_btn_localize', '1', 't'), ('#gloc_chk_auto', '2', 't'), ('#gloc_btn_apply', '3', 't'), ('#gloc_btn_force', '4', 't'),
                ('#loc_gnss_card .vt-card-title', '5', 'r'), ('#span_trk_state', '6', 'r')]),
    dict(name='shot-point-tab', vp=TALL, clip='#ui_drawer_head|#tab-point', steps=panel('#btn_map', 'tab-point', [('js', OPEN % "'#tab-point details'")]),
         marks=[('#input_menu_point_new', '1', 'b'), ('#btn_menu_point_new_save', '2', 'b'), ('#btn_menu_point_clear', '3', 'b')]),
    dict(name='shot-path-tab', vp=TALL, clip='#ui_drawer_head|#tab-path', steps=panel('#btn_map', 'tab-path', [('js', OPEN % "'#tab-path details'")]),
         marks=[('#input_menu_path_new', '1', 'b'), ('#btn_menu_path_new_save', '2', 'b'), ('#btn_menu_path_new_auto', '3', 'b'),
                ('#btn_menu_path_stop_auto', '4', 'b'), ('#btn_menu_path_clear', '5', 'b')]),
    dict(name='shot-marker', vp=(1200, 720), scale=1, width=1000, md=26, steps=[('click', '#btn_marker'), ('wait', 1500)],
         marks=[('#range_marker_orientation', '1', 'b'), ('#btn_marker_send_goal', '2', 't'), ('#btn_marker_cancel_navigation', '3', 't')]),
    # --- Programs (programs.md)
    dict(name='shot-programs', vp=TALL, clip='#ui_drawer_head|#tab_programs', trim=(2000, 575),
         steps=panel('#btn_programs', 'tab_programs', [('wait', 3000), ('click', '#div_menu_program_items_row > :first-child'), ('wait', 1500)]),
         marks=[('#div_menu_program_items_row > :first-child', '1', 'ri'),
                ('#btn_menu_program_run', '2', 't'), ('#btn_menu_program_resume', '3', 't'), ('#btn_menu_program_show', '4', 't'),
                ('#btn_menu_program_stop', '5', 't'), ('#btn_menu_program_reset', '6', 't'),
                ('#btn_program_save_settings', '7', 'r'), ('#btn_program_delete', '8', 'l')]),
    dict(name='shot-program-running', vp=TALL, scale=2, width=640, clip='#div_program_running', pad=4,
         steps=panel('#btn_programs', 'tab_programs', [('js', RUNNING % 'NAME: exe path 3/12')]), marks=[]),
    dict(name='shot-program-stopped', vp=TALL, scale=2, width=640, clip='#div_program_running', pad=4,
         steps=panel('#btn_programs', 'tab_programs', [('js', RUNNING % 'Stopped')]), marks=[]),
    dict(name='shot-calendar', vp=DESK, clip='#ui_drawer_head|#ui_drawer_body', steps=panel('#btn_programs', 'tab_calendar', [('wait', 3000)]),
         marks=[('#span_scheduler_state', '1', 'b'), ('#chk_scheduler_inhibit', '2', 'b'), ('#span_scheduler_status, #span_scheduler_next', '3', 'r'),
                ('#div_calendar_events, #div_calendar_events *', '4', 'ri'), ('#btn_calendar_add', '5', 'ri')]),
    dict(name='shot-calendar-form', vp=TALL, clip='#div_calendar_form', pad=6,
         steps=panel('#btn_programs', 'tab_calendar', [('wait', 1000), ('click', '#btn_calendar_add'), ('wait', 800)]),
         marks=[('#sel_cal_program', '1', 'ri'), ('#input_cal_hour', '2', 'r'), ('#sel_cal_recurrence', '3', 'ri'),
                ('#btn_cal_save', '4', 'l')]),
    # --- Settings (settings.md, mowing.md, safety.md)
    dict(name='shot-motors', vp=TALL, clip='#ui_drawer_head|#tab_motors', trim=(2000, 560), steps=panel('#btn_settings', 'tab_motors'),
         marks=[('#btngroup_motors_on_off', '1', 'bl'), ('#btn_motor_torque', '2', 'ri'), ('#ico_fl_motor_conf', '3', 'l')]),
    dict(name='shot-mower', vp=TALL, clip='#ui_drawer_head|#tab_mower', trim=(2000, 720), steps=panel('#btn_settings', 'tab_mower'),
         marks=[('#btn_mower_off', '1', 'ri'), ('#btn_mower_right', '2', 'ri'), ('#btn_mower_set_height', '3', 'ri'),
                ('#btn_mower_set_rpm', '4', 'ri'), ('#btn_mower_home', '5', 'ri'), ('#btn_mower_start_motor', '6', 'ri')]),
    dict(name='shot-app', vp=TALL, clip='#ui_drawer_head|#tab_app', steps=panel('#btn_settings', 'tab_app', [('wait', 800)]),
         marks=[('#div_app_settings .vt-app-sec:nth-child(%d) > :first-child' % i, str(i), 'c') for i in (1, 2, 3, 4)]),
    # --- editor, agent, support, help
    dict(name='shot-editor', vp=DESK, scale=1, width=1200, md=26,
         steps=panel('#btn_map', 'tab-map', [('click', '#btn_map_detail_toggle'), ('wait', 3000), ('js', ZOOM_OUT)]),
         marks=[('#mapedit_tools', '1', 'ri'), ('#mapedit_tools + *, #mapedit_context', '2', 'tr'), ('#mapedit_context', '3', 'ri'),
                ('#mapedit_edit_list, #div_map_detail details', '4', 'ri'), ('#btn_map_detail_close_footer', '5', 't'),
                ('#map_view', '6', 'c')]),
    dict(name='shot-agent', vp=DESK, demo=True, clip='#ui_drawer_head|#ui_drawer_body', steps=panel('#btn_agent', None, [('wait', 2500)]),
         marks=[('#vagent_status', '1', 'ri'), ('#vagent_stop', '2', 'b'),
                ('#vagent_tabs', '3', 'b'), ('#vagent_panel textarea, #vagent_panel input[type=text]', '4', 't'), ('#vagent_quick', '5', 'ri')]),
    dict(name='shot-support', vp=DESK, demo=True, clip='#ui_drawer_head|#ui_drawer_body', trim=(2000, 300),
         steps=panel('#btn_support', None, [('wait', 2500)]), marks=[]),
    dict(name='shot-needs', vp=TALL, demo=True, clip='#ui_drawer_head|#ui_drawer_body', trim=(2000, 1500),
         steps=[('js', "try{localStorage.setItem('vitulus_ui_author','Demo')}catch(e){}; return '';"),
                ('click', '#btn_needs'), ('wait', 2500)],
         marks=[('.vt-fv-hero', '1', 'ri'), ('.vt-ask-k-decide .vt-ask-type', '2', 'r'), ('.vt-ask-k-decide .vt-ask-opt', '3', 'ri'),
                ('.vt-ask-k-decide .vt-ask-next', '4', 'ri'), ('.vt-ask-k-steps .vt-ask-step', '5', 'ri'),
                ('.vt-ask-k-approve .vt-ask-facts', '6', 'ri')]),
    dict(name='shot-help', vp=DESK, scale=1, width=1200, md=26,
         steps=panel('#btn_map', 'tab-dock', [('click', '#btn_ui_drawer_help'), ('wait', 1500)]),
         marks=[('#btn_ui_drawer_help', '1', 'b'), ('.vth-search', '2', 'b'), ('.vth-toc', '3', 'l'), ('.vth-close', '4', 'b')]),
]


# --- --demo: invented, neutral content for the panels that show the owner's
# conversations and reports. The browser answers these GET requests itself
# (Playwright route), the server never sees them; everything else is read live.
def _demo_tasks(now):
    T = []

    def add(ago_s, source, author, klass, text, reply, took=4, meta=None):
        ts = now - ago_s
        T.append(dict(id=900 + len(T), ts=ts, source=source, author=author, text=text, klass=klass,
                      state='done', reply=reply, reply_ts=ts + took, meta=meta))
    add(1500, 'web', 'Owner', 'query', 'status?',
        'Docked and charged (battery 100 %). RTK fix, accuracy 2 cm. Drive motors off, blade off.')
    add(1380, 'web', 'Owner', 'mission', 'Test drive: undock, drive to TEST, wait 10 s, dock back',
        'Taking it as mission #12. Plan, checked like a test scenario: 1) undock, 2) drive to TEST, '
        '3) wait 10 s, 4) dock. I report after every phase; say "cancel" to stop it.')
    add(1330, 'agent', 'agent', 'mission', 'mission #12 · phase 1/4',
        'Phase 1/4 undock — done: motors on, out of the dock at UNDOCK, RTK fix.', took=1)
    add(1270, 'agent', 'agent', 'mission', 'mission #12 · phase 2/4',
        'Phase 2/4 drive to TEST — done in 48 s, 11.6 m, goal reached within 6 cm.', took=1)
    add(1255, 'agent', 'agent', 'mission', 'mission #12 · phase 3/4',
        'Phase 3/4 wait 10 s at TEST — done.', took=1)
    add(1190, 'agent', 'agent', 'mission', 'mission #12 · phase 4/4',
        'Phase 4/4 dock — done: docked, the charger supplies power. Mission #12 finished in 3 min 10 s.', took=1)
    add(420, 'web', 'Owner', 'query', 'Is the path to the back lawn clear?',
        'Yes. The lidar sees no new obstacle on the planned path; the nearest one is the bench, 1.4 m off the path.')
    return T


def _demo_issue(n, title, status, current, labels, who, ago_h, closed=False):
    order = ['reported', 'assessed', 'fixed', 'released', 'tested', 'verified', 'closed']
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - ago_h * 3600))
    steps = []
    for sid in order:
        st = 'done' if order.index(sid) < order.index(current) else ('current' if sid == current else 'todo')
        steps.append(dict(id=sid, state=st, when=stamp if st == 'done' else None, detail=None))
    return dict(number=n, title=title, state='CLOSED' if closed else 'OPEN', labels=labels, kind='report',
                status_text=status, last_change=stamp, created_at=stamp, closed_at=stamp if closed else None,
                url='', comments=2, waiting='tester' if who else None, motion=False,
                pipeline=dict(mode='pipeline', steps=steps, current=None if closed else current, closed=closed,
                              tally=None, redo=False, round=1, partial=False, rounds=[]),
                turn='verify' if who else 'none', agent_active=False, mine=False, who='verify' if who else 'none',
                who_label=who, mine_since=None)


def _demo_issues():
    iss = [
        _demo_issue(12, '[report] Camera picture stays on "waiting for signal" on a tablet',
                    'fix released, test running', 'released', ['area:ui', 'sev:minor', 'waiting:tester'], 'Tester', 1.2),
        _demo_issue(11, '[report] Undock waits too long for RTK under the roof edge',
                    'fix ready, waiting for release', 'fixed', ['area:dock', 'sev:minor'], None, 5),
        _demo_issue(9, '[report] Program list is empty after switching the map',
                    'verified', 'closed', ['area:programs', 'sev:minor'], None, 30, closed=True),
    ]
    return dict(meta=dict(repo='', lang='en', kit_version='1.0.0', stale=False, error=None, approvals=True),
                role='owner', issues=iss,
                turn=dict(who={}, labels={}, counts=dict(you=0, agent=0, field=0, verify=1, them=0, none=1, open=2),
                          you=[], names={}),
                contexts={})


DEMO_EMPTY_ATTENTION = dict(count=0, oldest_since=None, high=0, items=[], you_issues=[], working=0, mine=0, acks=[], ctx={})


def _demo_iso(min_ago):
    return time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(time.time() - 60 * min_ago))


def _demo_asks():
    """Needs you: one card of each kind (kit 0.9.52 `ask`), invented and neutral."""
    dec = dict(v=1, type='decide', id='turn:12', issue=12, kind='turn', label='Decision', thread='12', since=_demo_iso(95),
               title='How to check the camera on the tablet (#12)',
               why='The tester sees "waiting for signal" on the tablet; on a PC the camera works.', motion=False,
               decide=dict(question='Which way should the agent check it?',
                           options=[dict(idx=0, label='The agent adds a camera log, the tester only opens the page', rec=True, motion=False,
                                         changes=True, what='The agent makes the change and releases it; the tester opens the camera once.', steps=[]),
                                    dict(idx=1, label='Wait for the next tablet update', rec=False, motion=False, changes=False,
                                         what='Nothing changes; the agent asks again in a week.', steps=[])],
                           pick=dict(pid='p12demo', sha='0a1b2c3d4e'), rec_why='The fastest way: the tester sets nothing up.',
                           discuss=dict(thread='12', label='None fits, talk it over with the agent',
                                        text='None of the variants for #12 fits, let us talk it over.')),
               next='After the click the agent does it and shows the result here.', tech='', open='#/issue/12')
    stp = dict(v=1, type='steps', id='human-step:hs-0123456789ab', issue=14, kind='human-step', label='Task with steps', thread='14',
               since=_demo_iso(20), title='Retest the dock lock (#14)', why='Only a person on site can do this - the agent guides you.',
               motion=False, steps=dict(steps=[dict(k=1, id='R1', do='Open Settings > Dock on the phone', see='the dock lock is shown as Locked', motion=False),
                                               dict(k=2, id='R2', do='Open the lock for 10 minutes', see='the lock shows the time left', motion=False)],
                                        actions=[dict(kind='step-done', step='hs-0123456789ab', issue=14, label='Done')], say=''),
               next='After each step click Done, or Does not work - the agent follows up at once.', tech='', open='#/issue/14')
    app = dict(v=1, type='approve', id='approve:demo01', issue=None, kind='approve', label='Approval', thread='general', since=_demo_iso(40),
               title='Release a new change for the tester', why='The change reaches the tester\'s robot - you let it go.', motion=False,
               approve=dict(change='Release a new change for the tester', for_whom='the tester', risk='It does not move the robot and can be undone.',
                            what='You approve releasing 2 changes (vitulus_ui) - the tester gets them on the robot; the list is below.',
                            actions=[dict(kind='approve', id='demo01', sha='0', label='Approve'), dict(kind='dismiss', id='demo01', sha='0', label='Reject')],
                            list=[dict(head='vitulus_ui · master · 2 changes', lines=['Help: the dock lock in pictures', 'Camera: reconnect after a network change'],
                                       more='', carried=[])]),
               next='Approve: the agent releases the change and the tester gets it by itself. Reject: nothing is released.', tech='', open='#/attention')
    return [dec, stp, app]


def _demo_home():
    asks = _demo_asks()
    items = [dict(key=a['id'], issue=a['issue'], title=a['title'], kind='do', since=a['since'], thread=a['thread'],
                  link=a['open'], ask=a, type=a['type'], actions=[], options=[]) for a in asks]
    return dict(role='owner', meta=dict(kit_version='0.9.54'), footer=dict(kit_version='0.9.54', release='field-demo-1', watch=dict(available=True, fresh=True)),
                stav=[dict(login='owner', name='You', role='owner', me=True, tone='ok', say='The robot runs; everything is saved.',
                           facts=[dict(k='release', v='field-demo-1')], news=[]),
                      dict(login='tester', name='Tester', role='tester', me=False, tone='ok', say='Has the newest release, the robot runs on it.',
                           facts=[dict(k='release', v='field-demo-1')], news=[])],
                todo=dict(v=1, role='owner', names=dict(you='You', peer='Tester', peer_gen='Tester'),
                          mine=dict(who='you', items=items, more=0, notes=[]), peer=dict(who='peer', name='Tester', items=[], more=0, notes=[])),
                turn=dict(counts=dict(you=2, agent=1, field=0, verify=2, them=0), who={'15': 'agent'}, names=dict(them='Tester')),
                issues=dict(us=[dict(number=15, title='Map tiles load slowly', status_text='agent prepares a fix')]),
                velin=dict(sides=[], stage_of={}, stages={}), gh_access=dict(level='ok'), fleet=dict(self={}), blocks=[], flow_sent=[])


def demo_answer(path, query):
    """The invented answer for a GET path, or None (read live)."""
    if path == '/agent/api/tasks':
        return dict(tasks=[] if 'since_id' in query else _demo_tasks(time.time()),
                    cleared_after=0, has_more=False, oldest_id=900, live_floor=900)
    if path == '/field/api/issues':
        return _demo_issues()
    if path == '/field/api/attention':
        return DEMO_EMPTY_ATTENTION
    if path == '/field/api/home':
        return _demo_home()
    if path == '/field/api/activity/current':
        return dict(busy=[dict(slot='run', issue=15, text='The agent fixes #15: map tiles', text_en='The agent fixes #15: map tiles',
                               started=_demo_iso(3))], state='busy', level='info', signal=dict(state='connected'),
                    agents=dict(runs=[], others=[]))
    if path == '/field/ui_actions':
        return dict(ok=True, writes=True, ask=True, actions=[])
    if path == '/agent/api/v2/approvals':
        return dict(approvals=[], ts=time.time())
    return None


def install_demo(ctx):
    from urllib.parse import urlsplit

    def handle(route):
        u = urlsplit(route.request.url)
        data = demo_answer(u.path, u.query) if route.request.method == 'GET' else None
        if data is None:
            return route.continue_()
        route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
    ctx.route(re.compile(r'^https?://[^/]+/(agent|field)/'), handle)


def mark_js():
    return r"""
([spec, D]) => {
  document.querySelectorAll('.hs-mark-layer').forEach(e => e.remove());
  const L = document.createElement('div');
  L.className = 'hs-mark-layer';
  L.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:700 13px/1 Roboto,Arial,sans-serif';
  document.body.appendChild(L);
  const miss = [], boxes = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden'; };
  spec.forEach(([sel, label, where]) => {
    let el = null;
    for (const s of sel.split(',')) { el = Array.from(document.querySelectorAll(s.trim())).find(vis); if (el) break; }
    if (!el) { miss.push(sel); return; }
    const r = el.getBoundingClientRect();
    const frame = where.endsWith('!'); where = where.replace('!', '');
    if (frame) {
      const f = document.createElement('div');
      f.style.cssText = `position:fixed;left:${r.left-3}px;top:${r.top-3}px;width:${r.width+6}px;height:${r.height+6}px;border:2px solid #0dcaf0;border-radius:7px;box-shadow:0 0 0 2px rgba(16,24,29,.7)`;
      L.appendChild(f);
    }
    const g = 3;
    let x = r.left + r.width / 2 - D / 2, y = r.top + r.height / 2 - D / 2;
    if (where.includes('l')) x = r.left - D - g;
    if (where.includes('r')) x = r.right + g;
    if (where.includes('t')) y = r.top - D - g;
    if (where.includes('b')) y = r.bottom + g;
    if (where === 'ri') x = r.right - D - 8;
    if (where === 'li') x = r.left + 8;
    if (where === 'tl' || where === 'bl') x = r.left;
    if (where === 'tr' || where === 'br') x = r.right - D;
    x = Math.max(2, Math.min(innerWidth - D - 2, x)); y = Math.max(2, Math.min(innerHeight - D - 2, y));
    const m = document.createElement('div');
    m.textContent = label;
    const fs = Math.round(D * 0.56), bw = D < 20 ? 1.5 : 2;
    m.style.cssText = `position:fixed;left:${x}px;top:${y}px;min-width:${D}px;height:${D}px;padding:0 ${D/4}px;box-sizing:border-box;border-radius:${D}px;display:flex;align-items:center;justify-content:center;background:#0dcaf0;color:#10181d;font-size:${fs}px;border:${bw}px solid #10181d;box-shadow:0 0 0 ${bw}px rgba(255,255,255,.85),0 1px 4px rgba(0,0,0,.6)`;
    L.appendChild(m);
    boxes.push([x - 3, y - 3, x + D + 3, y + D + 3]);
  });
  return [miss, boxes];
}
"""


def box_of(pg, clip, pad):
    if clip is None:
        return None
    if isinstance(clip, (list, tuple)):
        x, y, w, h = clip
    else:
        r = pg.evaluate("""(sel) => { let u = null;
            for (const s of sel.split('|')) { const e = Array.from(document.querySelectorAll(s.trim())).find(e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
              if (!e) continue; const r = e.getBoundingClientRect();
              u = u ? {l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom)} : {l: r.left, t: r.top, r: r.right, b: r.bottom}; }
            return u; }""", clip)
        if not r:
            raise RuntimeError('clip not found: ' + clip)
        x, y, w, h = r['l'], r['t'], r['r'] - r['l'], r['b'] - r['t']
    vw, vh = pg.viewport_size['width'], pg.viewport_size['height']
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(vw, x + w + pad), min(vh, y + h + pad)
    return {'x': x0, 'y': y0, 'width': x1 - x0, 'height': y1 - y0}


def run(url, only, keep_png, demo=False):
    base = url.rstrip('/')
    if re.search(r':7779\b', base):
        sys.exit('refused: :7779 is the live UI — start a dev instance (docs/help/README.md)')
    page_url = base + '/?mock'
    done = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=False,
                              args=['--headless=new', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
        for s in SHOTS:
            if only and s['name'] not in only:
                continue
            if s.get('demo') and not demo:
                print('  %s: skipped — shows chat / reports, run with --demo' % s['name'])
                continue
            w, h = s['vp']
            phone = w < 600
            ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=s.get('scale', 2),
                                is_mobile=phone, has_touch=phone,
                                # the page's service worker would fetch past the demo route
                                service_workers='block' if demo else 'allow')
            if demo:
                install_demo(ctx)
            pg = ctx.new_page()
            pg.add_init_script('window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;'
                               'try{localStorage.clear()}catch(e){}')
            pg.goto(page_url, wait_until='domcontentloaded')
            pg.wait_for_timeout(s.get('boot', 8000))
            if not pg.evaluate("document.documentElement.classList.contains('vt-mock')"):
                sys.exit('refused: the page is not in mock mode')
            pg.evaluate('()=>{' + AERIAL_OFF + '}')   # every picture: no aerial photo (where the owner lives)
            pg.wait_for_timeout(600)
            for st in s.get('steps', []):
                k = st[0]
                if k == 'click':
                    if not CLICK_OK.search(st[1]):
                        sys.exit('refused click (not in CLICK_OK): ' + st[1])
                    r = pg.evaluate("(s)=>{const e=Array.from(document.querySelectorAll(s)).find(e=>e.offsetParent!==null)||document.querySelector(s); if(!e) return 'missing '+s; e.click(); return ''}", st[1])
                    if r:
                        print('  ' + s['name'] + ': ' + r)
                    pg.wait_for_timeout(700)
                elif k == 'js':
                    r = pg.evaluate('()=>{' + st[1] + '}')
                    if r:
                        print('  ' + s['name'] + ' js: ' + str(r)[:300])
                    pg.wait_for_timeout(400)
                elif k == 'wait':
                    pg.wait_for_timeout(st[1])
                elif k == 'wheel':
                    pg.mouse.move(st[1], st[2])
                    pg.mouse.wheel(0, st[3])
                    pg.wait_for_timeout(900)
            # the mock badge is not part of the UI
            pg.add_style_tag(content='.vt-mock-badge{display:none!important}')
            pg.wait_for_timeout(300)
            miss, boxes = pg.evaluate(mark_js(), [[list(m) for m in s.get('marks', [])], s.get('md', 22)])
            if miss:
                print('  ' + s['name'] + ': markers not found: ' + ', '.join(miss))
            clip = box_of(pg, s.get('clip'), s.get('pad', 8))
            if clip and s.get('trim'):   # keep only the top-left w x h of the box
                clip['width'] = min(clip['width'], s['trim'][0]); clip['height'] = min(clip['height'], s['trim'][1])
            if clip and boxes:      # the markers stay in the picture
                x0 = min([clip['x']] + [b[0] for b in boxes]); y0 = min([clip['y']] + [b[1] for b in boxes])
                x1 = max([clip['x'] + clip['width']] + [b[2] for b in boxes])
                y1 = max([clip['y'] + clip['height']] + [b[3] for b in boxes])
                vw, vh = pg.viewport_size['width'], pg.viewport_size['height']
                x0, y0, x1, y1 = max(0, x0), max(0, y0), min(vw, x1), min(vh, y1)
                clip = {'x': x0, 'y': y0, 'width': x1 - x0, 'height': y1 - y0}
            png = pg.screenshot(clip=clip) if clip else pg.screenshot()
            im = Image.open(io.BytesIO(png)).convert('RGB')
            tw = s.get('width', 720)
            if im.width > tw:
                im = im.resize((tw, round(im.height * tw / im.width)), Image.LANCZOS)
            out = os.path.join(OUT, s['name'] + '.webp')
            im.save(out, 'WEBP', quality=s.get('q', 82), method=6)
            if keep_png:
                im.save(os.path.join(keep_png, s['name'] + '.png'))
            print('%s  %dx%d  %d kB' % (out, im.width, im.height, os.path.getsize(out) // 1024))
            done.append(s['name'])
            ctx.close()
        b.close()
    return done


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', help='a dev instance, e.g. http://127.0.0.1:7861 (never :7779)')
    ap.add_argument('--only', default='', help='comma separated shot names')
    ap.add_argument('--list', action='store_true', help='list the shots and exit')
    ap.add_argument('--demo', action='store_true',
                    help='invented chat / reports instead of the real ones (use for the help pictures)')
    ap.add_argument('--png', default='', help='also save a PNG copy into this directory (for a look)')
    a = ap.parse_args()
    if a.list:
        for s in SHOTS:
            print(s['name'], '%dx%d' % s['vp'])
        sys.exit(0)
    if not a.url:
        ap.error('--url is required')
    run(a.url, set(x for x in a.only.split(',') if x), a.png, a.demo)
