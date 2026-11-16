/* vt_i18n.js — the language of the robot UI (en / cs), without a build step.
 *
 * Dictionaries: assets/js/i18n/<lang>.js, each one fills
 *     window.VT_I18N_DICT.<lang> = { 'some.key': 'Text', ... }
 * English (en) is the source and the fallback: a key missing in another
 * language shows the English text; a key missing everywhere shows the key
 * itself (and is logged once). How to translate: docs/I18N.md; the check:
 * tools/test_i18n.node.js.
 *
 * Static text in index.html (no JS needed):
 *     <span data-i18n="settings.tab.app">App</span>          textContent
 *     <input data-i18n-placeholder="log.search" ...>          placeholder
 *     <button data-i18n-title="x.tip" data-i18n-aria-label="x.tip">
 * The English text stays in the markup (it is what shows before this file
 * runs, and what a search in the HTML finds). An element with data-i18n has
 * its WHOLE text replaced — keep icons outside it (wrap the words in a span).
 *
 * API for JS modules (window.VTI18n):
 *     t(key, vars)          text in the current language; {name} in the text is
 *                           replaced from vars ({n: 3} → "3 jobs")
 *     tn(key, n, vars)      plural: key.one / key.few / key.many / key.other
 *                           (Intl.PluralRules of the language; cs: 1 / 2–4 / 5+)
 *     lang()                'en' | 'cs'
 *     langs()               [{code, name}] — names in their own language
 *     setLang(code)         switch now (live, no reload) and remember it
 *     apply(root)           translate data-i18n* inside root (default: document)
 *     tag(el, key, attr)    set data-i18n(-attr) on an element and translate it
 *     onChange(fn) → off()  fn(lang) after every switch (re-render your text)
 *     has(key, lang)        is the key in that dictionary
 *     node(kind, line)      a robot node's fixed English line ('gloc', 'rosbag', 'dockui', 'plan')
 *                           in the UI language; an unknown line unchanged
 *     watchNode(el, kind)   keep translating what another module writes into el
 * Event: document 'vt:lang' (CustomEvent, detail.lang) after every switch.
 *
 * Where the choice lives: the robot (~/.vitulus/ui/ui_settings.json through
 * GET/POST /api/ui_settings of the webnode — one language on every device)
 * and a copy in localStorage 'vitulus_lang' (the first paint before the robot
 * answers, and when it cannot be reached). Default: English.
 */
(function () {
    'use strict';
    var LS = 'vitulus_lang';
    var DEFAULT = 'en';
    var LANGS = [{ code: 'en', name: 'English' }, { code: 'cs', name: 'Čeština' }];
    var DICT = window.VT_I18N_DICT = window.VT_I18N_DICT || {};
    var ATTRS = ['title', 'placeholder', 'aria-label'];
    var cur = DEFAULT, subs = [], warned = {}, serverLang = null;

    function lsGet() { try { return localStorage.getItem(LS); } catch (e) { return null; } }
    function lsSet(v) { try { localStorage.setItem(LS, v); } catch (e) { /* private mode */ } }
    function known(code) { return LANGS.some(function (l) { return l.code === code; }); }

    function raw(key, lang) {
        var d = DICT[lang];
        return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
    }
    function fill(s, vars) {
        if (!vars) { return s; }
        return String(s).replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
        });
    }
    function t(key, vars) {
        var s = raw(key, cur);
        if (s === undefined && cur !== DEFAULT) { s = raw(key, DEFAULT); }
        if (s === undefined) {
            if (!warned[key]) { warned[key] = 1; try { console.debug('[i18n] missing key', key); } catch (e) { /* no console */ } }
            s = key;
        }
        return fill(s, vars);
    }
    function pluralCat(n, lang) {
        try { return new Intl.PluralRules(lang).select(n); } catch (e) { return n === 1 ? 'one' : 'other'; }
    }
    function tn(key, n, vars) {
        var v = Object.assign({ n: n }, vars || {});
        // this language's category, its .other, then English's category, .other
        var tries = [[cur, pluralCat(n, cur)], [cur, 'other'], [DEFAULT, pluralCat(n, DEFAULT)], [DEFAULT, 'other']];
        for (var i = 0; i < tries.length; i++) {
            var s = raw(key + '.' + tries[i][1], tries[i][0]);
            if (s !== undefined) { return fill(s, v); }
        }
        return t(key + '.other', v);
    }

    function applyEl(el) {
        var k = el.getAttribute('data-i18n');
        if (k) { el.textContent = t(k); }
        ATTRS.forEach(function (a) {
            var ka = el.getAttribute('data-i18n-' + a);
            if (ka) { el.setAttribute(a, t(ka)); }
        });
    }
    function apply(root) {
        root = root || document;
        var sel = '[data-i18n],' + ATTRS.map(function (a) { return '[data-i18n-' + a + ']'; }).join(',');
        if (root.nodeType === 1 && root.matches && root.matches(sel)) { applyEl(root); }
        var list = root.querySelectorAll ? root.querySelectorAll(sel) : [];
        Array.prototype.forEach.call(list, applyEl);
    }
    function tag(el, key, attr) {
        if (!el) { return el; }
        el.setAttribute(attr ? 'data-i18n-' + attr : 'data-i18n', key);
        applyEl(el);
        return el;
    }

    function switchTo(code) {
        if (!known(code)) { code = DEFAULT; }
        var changed = code !== cur;
        cur = code;
        document.documentElement.setAttribute('lang', code);
        if (!changed) { return; }
        apply(document);
        watched.forEach(function (w) { w.paint(); });
        subs.slice().forEach(function (fn) { try { fn(cur); } catch (e) { try { console.error(e); } catch (x) { /* no console */ } } });
        try { document.dispatchEvent(new CustomEvent('vt:lang', { detail: { lang: cur } })); } catch (e) { /* old browser */ }
    }

    /* the robot's copy: /api/ui_settings (same-origin JSON, X-Vitulus-UI) */
    function save(code) {
        if (!window.fetch) { return Promise.reject(new Error('no fetch')); }
        return window.fetch('/api/ui_settings', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Vitulus-UI': '1' },
            body: JSON.stringify({ lang: code })
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
                if (!r.ok || !j.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }
                serverLang = code;
                return j;
            });
        });
    }
    /* setLang → Promise: resolves {saved: 'robot'} or {saved: 'device', error} */
    function setLang(code) {
        if (!known(code)) { return Promise.reject(new Error('unknown language ' + code)); }
        lsSet(code);
        switchTo(code);
        return save(code).then(function () { return { saved: 'robot' }; },
                               function (e) { return { saved: 'device', error: String(e && e.message || e) }; });
    }
    function loadServer() {
        if (!window.fetch) { return; }
        window.fetch('/api/ui_settings', { cache: 'no-cache', credentials: 'same-origin' }).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            // only a language somebody stored; the server's default never
            // overrides this browser's own choice
            var stored = j && j.stored && j.stored.indexOf('lang') >= 0;
            var l = stored && j.settings && j.settings.lang;
            if (l && known(l)) {
                serverLang = l;
                lsSet(l);
                switchTo(l);
            }
        }).catch(function () { /* robot unreachable: the local copy stays */ });
    }

    /* T8 E: lines a robot node sends as fixed English text — gloc_server's
       /gloc/status, the rosbag recorders' /vitulus_rosbag/<name>/status, the
       webnode's dock door (kind dockui, below) — in the UI language. A known line maps to a key (numbers, names and the
       node's own reasons stay as they came: {vars} from the pattern's
       groups; a code word in a group, e.g. manual / force, gets its own key);
       an unknown line is shown unchanged. The first rule that
       matches wins. Sources: vitulus_navi/nodes/gloc_server (_set_status),
       vitulus_rosbag/recorder_base.py (_publish_status). */
    var NUM = '(-?[0-9.]+)';
    var NODE = {
        gloc: [
            [/^idle \(no map yet\)$/, 'node.gloc.idle_nomap'],
            [/^idle$/, 'node.gloc.idle'],
            [/^computing\.\.\.$/, 'gloc.computing'],
            [/^relocalizing \(auto\)\.\.\.$/, 'node.gloc.relocalizing'],
            [new RegExp('^ok ' + NUM + 's margin ' + NUM + '%$'), 'node.gloc.ok', ['s', 'm']],
            [new RegExp('^relock rejected: margin ' + NUM + '% < gate ' + NUM + '%$'), 'node.gloc.rej_margin', ['m', 'g']],
            [/^relock rejected: yaw deviates from current heading \(mirror alias\?\)$/, 'node.gloc.rej_yaw'],
            [new RegExp('^relock rejected: ' + NUM + 'm > radius ' + NUM + 'm$'), 'node.gloc.rej_radius', ['d', 'r']],
            [new RegExp('^relock rejected: rms (\\S+) > gate ' + NUM + '$'), 'node.gloc.rej_rms', ['rms', 'g']],
            [new RegExp('^relock rejected: far ' + NUM + 'm at margin ' + NUM + '%$'), 'node.gloc.rej_far', ['d', 'm']],
            [/^relock rejected: (.+)$/, 'node.gloc.rej', ['why']],
            [new RegExp('^relock probation \\(' + NUM + ', ' + NUM + '\\) ' + NUM + ' ticks / ' + NUM + ' m$'), 'node.gloc.probe', ['x', 'y', 'n', 'd']],
            [/^relock probation failed — lost$/, 'node.gloc.probe_failed'],
            [new RegExp('^relock probation ' + NUM + '/' + NUM + ' ticks, ' + NUM + '/' + NUM + ' m$'), 'node.gloc.probe_step', ['i', 'n', 'a', 'd']],
            [new RegExp('^RELOCK APPLIED \\(' + NUM + ', ' + NUM + '\\) po probaci$'), 'node.gloc.relock_applied', ['x', 'y']],
            [new RegExp('^apply refused: margin ' + NUM + '% < gate ' + NUM + '%$'), 'node.gloc.refused_margin', ['m', 'g']],
            [new RegExp('^apply refused: candidate yaw deviates > ' + NUM + ' deg from current heading \\(mirror alias\\?\\)$'), 'node.gloc.refused_yaw', ['deg']],
            [/^apply refused: (.+)$/, 'node.gloc.refused', ['why']],
            [new RegExp('^APPLIED \\((\\w+)\\) -> (\\S+) \\(' + NUM + ', ' + NUM + ', ' + NUM + 'deg\\)$'), 'node.gloc.applied', ['how', 'topic', 'x', 'y', 'yaw'], { how: 'node.gloc.how.' }],
            [/^error: (.+)$/, 'node.gloc.error', ['e']]
        ],
        rosbag: [
            [/^idle$/, 'node.bag.idle'],
            [/^recording \| fps=unlimited \| (.+)$/, 'node.bag.rec_nolimit', ['bag']],
            [new RegExp('^recording \\| fps=' + NUM + ' \\| (.+)$'), 'node.bag.rec', ['fps', 'bag']]
        ],
        /* T8 I: why an Allow / Lock of the dock did not go through, as the
           webnode writes it into the UI's action log (nodes/webnode
           _dock_post, _dock_clear_direct) — Agent › Activity */
        dockui: [
            [/^no ui_token$/, 'node.dockui.no_token'],
            [/^agent unreachable: .+$/, 'node.dockui.agent_down'],
            [/^direct clear: no answer \(.+\)$/, 'node.dockui.no_answer'],
            [/^direct: unknown window (\S+)$/, 'node.dockui.unknown_window', ['id']],
            /* T8 II: the direct path writes this line on a refusal too (ok=false):
               as a REASON it means the node said no while the agent was down */
            [/^locked directly in the node\b.*$/, 'node.dockui.direct_refused']
        ],
        /* T8 II: the planner's line under Settings › Navi › Planner (#div_log,
           /web_plan/log): vitulus_planner/nodes/node_planner log_publisher and
           the plainest lines of master_controller log(). Names and numbers stay
           as they came; any other line (a refusal whose reason is a sentence
           of its own, the master's diagnostic lines) is shown as sent. */
        plan: [
            [/^Planner data saved\.$/, 'node.plan.data_saved'],
            [/^Planner map saved\.$/, 'node.plan.map_saved'],
            [/^Map name is empty\.$/, 'node.plan.name_empty'],
            [/^Running planner data cleaned\.$/, 'node.plan.cleaned'],
            [/^Be shure that you have loaded the map with RtabMap\.$/, 'node.plan.reload_hint'],
            [/^Reloading map from \/rtabmap\/grid_map$/, 'node.plan.reloading'],
            [/^No site served yet — planner data unavailable\.$/, 'node.plan.no_site'],
            [/^Planner data NOT loaded \(saved data unusable\)\.$/, 'node.plan.not_loaded_bad'],
            [/^Not loaded!!! It's a new map\. Save it in Navi Manager first\.$/, 'node.plan.not_loaded_new'],
            [/^Not saved!!! No site served \/ new map\. Save it in Navi Manager first\.$/, 'node.plan.not_saved_new'],
            [/^Not saved!!! No planner workspace \(no map is active\)\.$/, 'node.plan.not_saved_ws'],
            [/^Map Assembled\.$/, 'node.plan.assembled'],
            [/^Planner programs loaded$/, 'node.plan.programs_loaded'],
            [/^Planner data loaded \(site '(.+)'\)$/, 'node.plan.data_loaded_site', ['site']],
            [/^Planner data loaded$/, 'node.plan.data_loaded'],
            [/^Creating outline paths\.\.\.$/, 'node.plan.outline'],
            [/^Creating coverage paths\.\.\.$/, 'node.plan.coverage'],
            [/^Polygon (\S+) (.+) saved\.$/, 'node.plan.poly_saved', ['type', 'name']],
            [/^Polygon (.+) removed\.$/, 'node.plan.poly_removed', ['name']],
            [/^Zone '(.+)' renamed to '(.+)'\.$/, 'node.plan.zone_renamed', ['old', 'name']],
            [/^Zone '(.+)' update propagated to (\d+) program\(s\)\.$/, 'node.plan.zone_propagated', ['name', 'n']],
            [/^Removed zone '(.+)' from (\d+) program\(s\)\.$/, 'node.plan.zone_unlinked', ['name', 'n']],
            [/^Zone '(.+)' NOT (saved|removed): internal planner error\.$/, 'node.plan.zone_internal', ['name', 'op'], { op: 'node.plan.op.' }],
            [/^Zone (.+) selected\.$/, 'node.plan.zone_selected', ['name']],
            [/^Zone ([^:]+) saved\.$/, 'node.plan.zone_saved', ['name']],
            [/^Program selected to (run|resume): (.+)$/, 'node.plan.selected', ['verb', 'name'], { verb: 'node.plan.verb.' }],
            [/^Program '(.+)' not found on the active map$/, 'node.plan.prog_missing', ['name']],
            [/^Program '(.+)' NOT saved: it has no zones\.$/, 'node.plan.prog_no_zones', ['name']],
            [/^Program '(.+)' NOT deleted: it is running — Stop it first\.$/, 'node.plan.prog_running', ['name']],
            [/^\[Master\] Program succeeded\.$/, 'node.plan.m.succeeded'],
            [/^\[Master\] Robot returned to dock\.$/, 'node.plan.m.docked'],
            [/^\[Master\] Robot is off the dock: sending it home\.$/, 'node.plan.m.sending_home'],
            [/^\[Master\] Window closed: going home after this path\.$/, 'node.plan.m.window_closed'],
            [/^\[Master\] Automation (ON|OFF)\.$/, 'node.plan.m.automation', ['on'], { on: 'node.plan.onoff.' }],
            [/^\[Master\] Calendar updated \((\d+) events\)$/, 'node.plan.m.calendar', ['n']],
            /* T8 III: the rest of the common lines — refusals with a fixed reason,
               a finished zone operation, the master's run / sleep lines. Left as
               sent on purpose: a line whose reason is itself an English sentence
               or a dump ("Zone split refused: …", "… not started: …", "Chain: …",
               "[Master] Settings changed by …", "Staying awake: …") — half a
               translation would read worse than the whole line as the node wrote it. */
            [/^Zone ([^:]+) removed\.$/, 'node.plan.zone_removed', ['name']],
            [/^Zone '(.+)' NOT saved: no map is active — activate or record a map first\.$/, 'node.plan.zone_nosave_nomap', ['name']],
            [/^Zone '(.+)' NOT removed: no map is active\.$/, 'node.plan.zone_noremove_nomap', ['name']],
            [/^Zone '(.+)' NOT saved: the programs of the active map are not loaded yet — try again in a moment\.$/, 'node.plan.zone_nosave_programs', ['name']],
            [/^Zone '(.+)' NOT saved: program '(.+)' is running on it — stop it first\.$/, 'node.plan.zone_nosave_running', ['name', 'program']],
            [/^Zone '(.+)' NOT saved: cut height (\S+) mm is outside (.+)\.$/, 'node.plan.zone_nosave_cut', ['name', 'value', 'range']],
            [/^Zone '(.+)' NOT saved: mowing paths could not be generated — the zone is too small or lies outside the map\.$/, 'node.plan.zone_nosave_paths', ['name']],
            [/^Zone '(.+)' NOT saved: this shape leaves no mowing path — it is too small or lies outside the free space of the map\.$/, 'node.plan.zone_nosave_shape', ['name']],
            [/^Zone (split|merge|duplicate) done: (.+)\.$/, 'node.plan.zop_done', ['op', 'names'], { op: 'node.plan.zop.' }],
            [/^Map NOT assembled: no map is active — activate or record a map first\.$/, 'node.plan.map_noassemble'],
            [/^Polygon '(.+)' NOT (saved|removed): no map is active — activate or record a map first\.$/, 'node.plan.poly_nomap', ['name', 'op'], { op: 'node.plan.pop.' }],
            [/^Program '(.+)' NOT (saved|removed): the programs of the active map are not loaded yet — try again in a moment\.$/, 'node.plan.prog_not_ready', ['name', 'op'], { op: 'node.plan.pop.' }],
            [/^Program '(.+)' NOT saved: cut height (\S+) mm is outside (.+)\.$/, 'node.plan.prog_nosave_cut', ['name', 'value', 'range']],
            [/^Program '(.+)' NOT saved: no map is active — activate a map first \(a program belongs to the map it is created on\)\.$/, 'node.plan.prog_nosave_nomap', ['name']],
            [/^Program '(.+)': loading map '(.+)' before the undock\.$/, 'node.plan.prog_loading_map', ['name', 'site']],
            [/^Programs not loaded: zones or datum of map '(.+)' are not ready$/, 'node.plan.progs_wait_zones', ['site']],
            [/^Programs not loaded: the program list of map '(.+)' could not be saved to its site bundle$/, 'node.plan.progs_wait_bundle', ['site']],
            [/^\[Master\] ([^:]+) moved: slot of (\S+) is free again\.$/, 'node.plan.m.moved', ['name', 'day']],
            [/^\[Master\] Window set: (\d\d:\d\d)-(\d\d:\d\d)\.$/, 'node.plan.m.window_set', ['from', 'to']],
            [/^\[Master\] Window set: off\.$/, 'node.plan.m.window_off'],
            [/^\[Master\] ([^:]+) is already finished\.$/, 'node.plan.m.already_done', ['name']],
            [/^\[Master\] Resuming program: (.+) \(([^()]*)\)$/, 'node.plan.m.resuming', ['name', 'why'], { why: 'node.plan.why.' }],
            [/^\[Master\] Starting scheduled program: (.+) \(([^()]*)\)$/, 'node.plan.m.starting', ['name', 'why'], { why: 'node.plan.why.' }],
            [/^\[Master\] Following the program that is out: (.+)$/, 'node.plan.m.following', ['name']],
            [/^\[Master\] Mission of ([^:]+) was lost\.$/, 'node.plan.m.lost', ['name']],
            [/^\[Master\] Program did not start \(see the planner log\)\.$/, 'node.plan.m.no_start'],
            [/^\[Master\] Dock permit homeward cancelled: mowing on\.$/, 'node.plan.m.permit_on'],
            [/^\[Master\] Dock permit ended with the robot out: finishing this path \(max (\d+) s\), then home\.$/, 'node.plan.m.permit_ended', ['s']],
            [/^\[Master\] Dock permit: the path did not end in time, home now\.$/, 'node.plan.m.permit_late'],
            [/^\[Master\] Terminal error in the dock\. Resetting SMACH, the run retries\.$/, 'node.plan.m.dock_error'],
            [/^\[Master\] Mower temperature sensor fault: run given up\.$/, 'node.plan.m.temp_fault'],
            [/^\[Master\] A person took the mower's power away: no resume\.$/, 'node.plan.m.power_taken'],
            [/^\[Master\] ([^:]+) refused \(([^()]+)\), retry (\d+)\/(\d+)\.$/, 'node.plan.m.refused', ['name', 'code', 'i', 'n']],
            [/^\[Master\] Recovery: charge, then resume\.$/, 'node.plan.m.recover_charge'],
            [/^\[Master\] PM confirms the cancel\.$/, 'node.plan.m.pm_cancel_ok'],
            [/^\[Master\] Unfinished sleep of a previous run: cancelled\.$/, 'node.plan.m.sleep_leftover'],
            [/^\[Master\] Awake after sleep \(([+-]\d+) min against plan\)\.$/, 'node.plan.m.awake', ['min']],
            [/^\[Master\] Sleep \(([^,()]+)\) for (\d+)m\.$/, 'node.plan.m.sleep_for', ['why', 'min'], { why: 'node.plan.why.' }],
            [/^\[Master\] Sleep \(([^,()]+), ([\d.]+) min\)\.$/, 'node.plan.m.sleep_mode', ['mode', 'min'], { mode: 'node.plan.why.' }],
            [/^\[Sleep\] PM armed, shutting the OS down\.$/, 'node.plan.s.armed'],
            [/^\[Sleep\] PM did not confirm the cancel\.$/, 'node.plan.s.no_cancel']
        ]
    };
    var NODE_MAX = 500;
    function nodeText(kind, s) {
        s = s == null ? '' : String(s);
        /* T8 III: a line this long is no fixed line of a node (a dump, a trace):
           shown as sent, and the patterns never grind through it */
        if (s.length > NODE_MAX) { return s; }
        var rules = NODE[kind] || [];
        for (var i = 0; i < rules.length; i++) {
            var m = rules[i][0].exec(s);
            if (!m) { continue; }
            if (raw(rules[i][1], cur) === undefined && raw(rules[i][1], DEFAULT) === undefined) { return s; }
            var vars = {};
            var codes = rules[i][3] || {};      // {var: key prefix}: a known code word is translated too
            (rules[i][2] || []).forEach(function (n, j) {
                var v = m[j + 1];
                if (codes[n] && (raw(codes[n] + v, cur) !== undefined || raw(codes[n] + v, DEFAULT) !== undefined)) {
                    v = t(codes[n] + v);
                }
                vars[n] = v;
            });
            return t(rules[i][1], vars);
        }
        return s;
    }
    /* an element another module fills with a node's raw line: translated
       after every write and on every language switch (the raw line is kept,
       the module's own logic keeps reading the message, not the DOM) */
    var watched = [];
    function watchNode(el, kind) {
        if (!el || typeof MutationObserver === 'undefined') { return; }
        if (watched.some(function (x) { return x.el === el; })) { return; }
        var w = { el: el, raw: null, out: null };
        w.paint = function () {
            if (w.raw === null) { return; }
            w.out = nodeText(kind, w.raw);
            if (el.textContent !== w.out) { el.textContent = w.out; }
            /* T8 I: the place may be narrower than the line (it then ends in
               „…“): the whole line is always the tooltip */
            if (el.getAttribute && el.getAttribute('title') !== w.out) { el.setAttribute('title', w.out); }
        };
        var seen = function () {
            /* V-f: while the place still holds a text of the page itself (a data-i18n child: the
               template's "Initialized"), it is not a node's line — apply() translates it; kept as
               "raw" it was written back in the language of the page load on every switch */
            if (el.querySelector && el.querySelector('[data-i18n]')) { w.raw = null; w.out = null; return; }
            if (el.textContent === w.out) { return; }
            w.raw = el.textContent;
            w.paint();
        };
        watched.push(w);
        new MutationObserver(seen).observe(el, { childList: true, characterData: true, subtree: true });
        seen();
    }
    /* filled by map_view.js RosbagControl straight from /vitulus_rosbag/<name>/status */
    var NODE_EL = [['span_d435_rec_status', 'rosbag'], ['span_gnss_rec_status', 'rosbag'],
                   /* T8 II: #div_log is written by vt_planner_settings.js and the map editor (the same topic) */
                   ['div_log', 'plan']];

    var first = lsGet();
    cur = known(first) ? first : DEFAULT;
    document.documentElement.setAttribute('lang', cur);

    window.VTI18n = {
        t: t, tn: tn, apply: apply, tag: tag,
        lang: function () { return cur; },
        langs: function () { return LANGS.slice(); },
        setLang: setLang,
        serverLang: function () { return serverLang; },
        has: function (key, lang) { return raw(key, lang || cur) !== undefined; },
        onChange: function (fn) {
            subs.push(fn);
            return function () { var i = subs.indexOf(fn); if (i >= 0) { subs.splice(i, 1); } };
        },
        node: nodeText, watchNode: watchNode,
        DEFAULT: DEFAULT
    };

    function boot() {
        if (cur !== DEFAULT) { apply(document); }
        if (document.getElementById) {
            NODE_EL.forEach(function (p) { watchNode(document.getElementById(p[0]), p[1]); });
        }
        loadServer();
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); }
    else { boot(); }
})();
