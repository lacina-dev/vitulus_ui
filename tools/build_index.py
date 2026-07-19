#!/usr/bin/env python3
"""RETIRED build helper for the unified single-page UI (templates/index.html).

!!!  SAFETY INTERLOCK — THIS SCRIPT IS DISABLED ON PURPOSE.  !!!
!!!  index.html is now HAND-MAINTAINED and is the canonical source.  !!!

Running this script is DESTRUCTIVE and would REVERT the live UI. It regenerates
index.html from the stale source templates (map_view.html + imu_calibration.html),
but since ~2026-07-17 index.html has been hand-edited directly in-tree across
~20 commits (map-editor panel redesign + tool grids, left drawer UI, fluid
Settings tabs, Map-tab consolidation, rain-tab reorder, hidden legacy blocks,
...). Those edits were NEVER back-ported into map_view.html, so a rebuild today
would silently throw ~8 KB of live UI (1000+ diff lines, spread across the whole
document) on the floor.

The pipeline has therefore been INVERTED:
  * index.html  ....... canonical, hand-edited, served by nodes/webnode at "/",
                        "/map_edit" and "/imu_calibration" (all render index.html).
  * map_view.html ..... STALE build-input, no longer authoritative. Kept for
                        history only (see the banner comment at its top). NOT
                        served at runtime — nothing reads it except this script.
  * this script ....... a hard no-op that refuses to run (see main() below).

If you truly need the old assembly logic (e.g. to bootstrap a fresh single-page
UI from scratch), read the legacy body of main() below and run it deliberately
by hand — but understand it will overwrite index.html with the stale layout.

The three original WebUI pages (map view, planner, IMU calibration) were merged
into ONE document so the browser loads a single responsive page. The map view
kept its exact markup/design and became the default section; the planner and
IMU pages became hidden sections shown via the navbar and lazily initialised by
app.js. That merge is done; index.html is the artifact and is edited directly.

Design notes / why each transform exists:
  * map_view.js / map_edit.js / imu_calibration.js were changed from
    `window.onload = ...` to named initialisers (initMapView/initPlanner/initImu)
    so all three can coexist; this script just wires the extra <script> tags.
  * imu_calibration.js is wrapped in an IIFE (done in the JS file) because it
    declares classes (ROS, Viewer3D, ViewerGrid, JoyTeleop) that clash with
    identically named globals in map_view.js.
  * The planner/imu navs and the imu `joy_view`/`div_content` ids are dropped or
    renamed here/there to avoid duplicate-id collisions with the map view.
"""

import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
TPL = os.path.normpath(os.path.join(HERE, '..', 'nodes', 'templates'))

MAP_VIEW = os.path.join(TPL, 'map_view.html')
MAP_EDIT = os.path.join(TPL, 'map_edit.html')
IMU = os.path.join(TPL, 'imu_calibration.html')
OUT = os.path.join(TPL, 'index.html')

JQUERY_MARK = '<script src="assets/js/jquery.min.js">'


def read(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


def slice_between(text, start_mark, end_mark, where='index', inclusive_start=False):
    s = text.index(start_mark)
    if not inclusive_start:
        s += len(start_mark)
    e = text.index(end_mark, s)
    return text[s:e]


def extract_planner_column(me):
    """Return the planner's control column from map_edit.html.

    That is the contiguous run of panels from ``#current_map`` through the end of
    ``#panel_map_programs`` — everything except the planner's own map canvas. We
    find the start at ``id="current_map"`` and walk <div>/</div> from the panel's
    opening tag for ``#panel_map_programs`` until balanced, so the slice ends
    exactly where that last panel closes.
    """
    start = me.index('<div id="current_map"')
    pe = me.index('id="panel_map_programs"')
    open_tag = me.rindex('<div', 0, pe)
    depth = 0
    i = open_tag
    end = None
    while i < len(me):
        nd = me.find('<div', i)
        nc = me.find('</div>', i)
        if nc == -1:
            break
        if nd != -1 and nd < nc:
            depth += 1
            i = nd + 4
        else:
            depth -= 1
            i = nc + 6
            if depth == 0:
                end = i
                break
    if end is None:
        raise RuntimeError('could not balance #panel_map_programs')
    return me[start:end]


def _legacy_build():
    """Original (now RETIRED) assembly. Kept for reference/bootstrap only.

    DO NOT call this from main(). It overwrites templates/index.html with the
    STALE layout assembled from map_view.html + imu_calibration.html, reverting
    every hand edit made to index.html since ~2026-07-17. See module docstring.
    """
    mv = read(MAP_VIEW)
    me = read(MAP_EDIT)
    imu = read(IMU)

    # ---- map_view head (everything up to and including </head>) -------------
    head = mv[:mv.index('</head>') + len('</head>')]

    # The planner was migrated from ros2d to three.js (planner3d.js), so ros2d
    # is no longer needed — only ros3d/three.js renderers remain on the page.
    # planner + imu logic + the page orchestrator, after the last map_view lib.
    head = head.replace(
        '<script src="/assets/js/keyboardteleop.js"></script>',
        '<script src="/assets/js/keyboardteleop.js"></script>\n'
        '<script src="/assets/js/planner3d.js"></script>\n'
        '<script src="/assets/js/map_edit.js"></script>\n'
        '<script src="/assets/js/mapeditor.js"></script>\n'
        '<script src="/assets/js/imu_calibration.js"></script>\n'
        '<script src="/assets/js/app.js"></script>',
    )

    # The map editor's control column now lives inside the map menu panel
    # (#div_menu_mapedit). The planner panels were authored at a fixed ~494px
    # width; let them shrink to the menu width on narrow viewports so the editor
    # is usable on a phone (the editing itself happens on the full-screen 3D map).
    responsive_css = (
        '<style id="vitulus-ui-responsive">\n'
        '#div_menu_mapedit > div { width: 100% !important; max-width: 494px; }\n'
        '@media (max-width: 540px) {\n'
        '  #div_menu_mapedit > div { width: 100% !important; }\n'
        '}\n'
        '/* IMU tab: propagate the bounded outer height down the row + columns so\n'
        '   the left controls column fills the block; #3d_view gets its own\n'
        '   explicit viewport height (set in build) and no longer relies on this. */\n'
        '#div_content_imu > .row,\n'
        '#div_content_imu > .row > [class*="col-"] { height: 100%; }\n'
        '</style>\n'
    )
    head = head.replace('</head>', responsive_css + '</head>')

    # ---- map_view body pieces ----------------------------------------------
    nav_start_mark = '    <nav class="navbar navbar-expand-lg" id="div_menu"'
    nav_start = mv.index(nav_start_mark)
    nav_end = mv.index('</nav>', nav_start) + len('</nav>')

    body_open = mv.index('<body>') + len('<body>')
    modals = mv[body_open:nav_start]                       # remove-confirm modals
    nav = mv[nav_start:nav_end]                            # top navbar
    mv_content = mv[nav_end:mv.index('    ' + JQUERY_MARK)]  # menu_spacer + div_content
    # inclusive_start keeps the JQUERY_MARK <script> tag itself in the slice, so we
    # must NOT prepend it again — doing so produced a malformed, doubled
    # `<script ...><script ...></script>` tag in the generated index.html.
    foot = slice_between(mv, JQUERY_MARK, '</body>', inclusive_start=True)

    # The top navbar no longer carries any section/page links: the planner is
    # integrated into the map view, and the IMU calibration page is now a tab in
    # the settings menu (#div_menu_config). So strip the "Map view", "Planner"
    # and "Imu calibration" <li> items entirely — the navbar keeps only the brand
    # on the left and the Restart item (injected at runtime by app.js) on the right.
    def drop_li(nav_html, href):
        a = nav_html.index(href)
        li_start = nav_html.rindex('<li', 0, a)
        li_end = nav_html.index('</li>', a) + len('</li>')
        return nav_html[:li_start] + nav_html[li_end:]

    nav = drop_li(nav, 'href="/map_edit"')          # Planner
    nav = drop_li(nav, 'href="/imu_calibration"')   # Imu calibration
    nav = drop_li(nav, 'href="/"')                  # Map view (match last)

    # The map editor's control panel (#div_menu_mapedit, with the Zones/Polygons/
    # Map sub-tabs) is authored directly in map_view.html in the native menu
    # style, so nothing is injected from map_edit.html any more. map_edit.js
    # (integrated mode) just drives those ids. `me` is still read only to keep the
    # historical extract helper available, but it is no longer used for layout.
    _ = me

    # ---- imu body: just the #div_content block, with id collisions renamed --
    imu_dc_start = imu.index('<div id="div_content"')
    imu_after = imu[imu_dc_start:imu.index('    ' + JQUERY_MARK)]
    imu_after = imu_after.rstrip()
    # strip the single trailing wrapper </div> that belonged to imu's <body> div
    assert imu_after.endswith('</div>')
    imu_content = imu_after[:imu_after.rfind('</div>')].rstrip()
    imu_content = imu_content.replace('id="div_content"', 'id="div_content_imu"')
    imu_content = imu_content.replace('id="joy_view"', 'id="joy_view_imu"')

    # The IMU markup was authored page-sized (its outer #div_content_imu and the
    # diagnostics box both size off 100vh). Inside the settings-menu tab it needs
    # a bounded height so the whole block (3D viewer on the right, controls on the
    # left) fits the tab without a giant scroll. The tab pane caps at
    # `calc(100vh - 150px)`, so the outer block targets `calc(100vh - 165px)` to
    # sit inside it with a little margin.
    #
    # The original 100% height chain is broken: the #3d_view derives off
    # min-height/max-height:100% but its parent column (and the .row wrapper) have
    # no height, so 100% had nothing to resolve against and it ballooned to ~769px.
    # We therefore (a) propagate height:100% down the .row + both columns, and
    # (b) give #3d_view an explicit viewport-derived height so it never depends on
    # a fragile percentage chain — `calc(100vh - 175px)` comes out ~575px tall on a
    # ~950px window and roughly square at the half-width menu column.
    # Replaces are best-effort: if a target string drifts, warn but don't crash.
    def shrink(html, old, new, label):
        if old in html:
            return html.replace(old, new)
        print('  WARNING: IMU sizing target not found (%s): %r' % (label, old))
        return html

    imu_content = shrink(imu_content,
                         'id="div_content_imu" style="height: calc(100vh - 42px);"',
                         'id="div_content_imu" style="height: calc(100vh - 165px);"',
                         'outer height')
    imu_content = shrink(imu_content,
                         'height: calc(((100vh - 42px)/2) - 50px - 43px - 8px);',
                         'height: 200px;',
                         'div_diag height')
    imu_content = shrink(imu_content,
                         'id="3d_view" style="width: 100%;background: rgba(2,60,85,0.22);'
                         '/*resize: vertical;*/overflow: hidden;min-height: 100%;'
                         'max-height: 100%;padding: 2px;"',
                         'id="3d_view" style="width: 100%;background: rgba(2,60,85,0.22);'
                         '/*resize: vertical;*/overflow: hidden;'
                         'height: calc(100vh - 175px);min-height: 0;'
                         'max-height: none;padding: 2px;"',
                         '3d_view height')

    # IMU calibration content is injected into the settings-menu tab placeholder
    # inside the map view section (built into mv_content), not into a page section.
    imu_placeholder = ('<!-- vitulus_ui: IMU calibration content injected here by '
                       'build_index.py -->')
    assert imu_placeholder in mv_content, \
        'IMU tab placeholder missing from map_view.html (#tab_imu)'
    mv_content = mv_content.replace(imu_placeholder, imu_content)

    body = (
        '<body>\n'
        + modals
        + nav + '\n'
        + '<div id="section_map">\n' + mv_content + '\n</div>\n'
        + '    ' + foot + '\n'
        + '</body>'
    )

    out = head + '\n\n' + body + '\n\n</html>\n'
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(out)

    print('wrote', OUT, '(%d bytes)' % len(out))
    print('  modals       : %d bytes' % len(modals))
    print('  nav          : %d bytes' % len(nav))
    print('  section_map  : %d bytes (incl. IMU tab)' % len(mv_content))
    print('  imu (in tab) : %d bytes' % len(imu_content))


def main():
    """Safety interlock: refuse to run and explain why. Never touches index.html."""
    msg = (
        "\n"
        "==================================================================\n"
        " build_index.py is DISABLED (safety interlock).\n"
        "==================================================================\n"
        " index.html is now HAND-MAINTAINED and is the canonical source.\n"
        " Running this generator would REVERT the live UI: it rebuilds\n"
        " index.html from the STALE templates (map_view.html + imu_calibration\n"
        " .html), discarding ~8 KB of hand edits made directly to index.html\n"
        " since 2026-07-17 (map-editor panel, drawer UI, tool grids, fluid\n"
        " Settings tabs, Map-tab consolidation, rain-tab reorder, ...).\n"
        "\n"
        " Nothing to do:\n"
        "   * Edit the UI by editing nodes/templates/index.html directly,\n"
        "     then restart the vitulus_ui node (Flask caches the template).\n"
        "   * map_view.html / map_edit.html / imu_calibration.html are stale\n"
        "     build-inputs, kept for history only, served by nobody.\n"
        "\n"
        " If you REALLY intend to regenerate from the stale templates (this\n"
        " throws away the live UI), call _legacy_build() by hand, deliberately.\n"
        "==================================================================\n"
    )
    sys.stderr.write(msg)
    sys.exit(2)


if __name__ == '__main__':
    main()
