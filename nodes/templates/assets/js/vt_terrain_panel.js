/* vt_terrain_panel.js — Map › Terrain: the robot's terrain in one place (T31, 2026-11-08).
 *
 * Owner: "I need to control and see the terrain from the UI." One section of
 * the Map tab (details.map-sec data-mapsec="terrain", between Map recording
 * and Display), four cards in the one panel anatomy:
 *
 *   1. Persistent map the global terrain map (terrain_recorder, vitulus_mapping,
 *                     T30) by contract ~/vitulus/predavka/t31-teren-ui-kontrakt.md
 *                     v1: recording / waiting (gate closed, why) / paused / off /
 *                     no site / not running, area, last write; build on/off
 *                     (stored by the recorder), pause, rebuild from a run (import
 *                     of a mosaic prepared on the robot: merge, or replace with a
 *                     token and a backup), delete (token, backup) — ONLY these
 *                     writes, ONLY through /terrain_recorder/cmd
 *   2. Terrain node   is traversability_local (vitulus_traversability, T10)
 *                     running: CPU, ms, Hz, TF failures, the dock zone, the
 *                     localisation epoch — from its ~stats (DiagnosticStatus,
 *                     every 5 s); its parameters read-only (~config, latched);
 *                     its set topic is not used (not in the contract)
 *   3. On the map     quick switches of the existing layers "Traversability"
 *                     (vt_terrain_layer.js, #mapv3_chk_trav) and "Mowed area
 *                     terrain" (vt_terrain_mosaic.js, #mapv3_chk_tmosaic) + view
 *                     + their opacity + legend. Nothing is drawn here: a tap sets
 *                     the layer's own control and fires its event, as the layers
 *                     button does.
 *   4. No-go candidates  state.nogo_candidates, a list "to review" with "Show
 *                     on map" (camera + a ring for a few seconds). Approving
 *                     comes later: nothing is written.
 *
 * Cost: subscribed only while the section is open, the Map panel shown and
 * the page visible (state every 2 s, node stats every 5 s, both small).
 * Safety: nothing here moves the robot or the blade; every write is one
 * recorder command by a button press; delete and replace need the recorder's
 * token, i.e. a second press in the confirmation. In ?mock they are swallowed.
 * Pure part (module.exports) tested in tools/test_terrain_panel.node.js;
 * the page in tools/test_terrain_panel_ui.py. i18n: tpan.* (block // T31).
 * Help: docs/help/terrain.md (+ cs).
 */
(function (root) {
    'use strict';

    /* ================================================================ contract
       The only place that names the robot's interfaces: the terrain node's from
       vitulus_traversability (traversability_local.hpp), the recorder's from
       t31-teren-ui-kontrakt.md v1. */
    var CONTRACT = {
        node: {
            stats: '/traversability_local/stats', statsType: 'diagnostic_msgs/DiagnosticStatus', downMs: 17000,
            config: '/traversability_local/config',
        },
        rec: {
            state: '/terrain_recorder/state', downMs: 10000,      // "no message > 10 s = not running"
            cmd: '/terrain_recorder/cmd', result: '/terrain_recorder/cmd_result',
            cmds: ['enable', 'disable', 'pause', 'resume', 'delete_map', 'import', 'rebuild_export', 'list'],
            answerMs: 8000,           // a quick command answers within this
            heavyMs: 90000,           // import / delete (with the token) hold the recorder's lock: at least 60 s
            longMs: 180000,           // a running one (state.last_cmd.running) at the latest within this
            // an answer after these still counts (cmd_result by its id): said as it comes
        },
    };
    var LS_OPEN = 'vitulus_maptab_terrain', LS_PARAMS = 'vitulus_maptab_terrain_params';
    var FLOW_MS = 60000;          // an open question closes itself after this (the token's 60 s)
    var RING_MS = 9000;           // "show on map" ring
    var LIVE = ['on', 'off', 'paused', 'nosite'];

    /* ==================================================================== pure */
    function num(v) { if (v === null || v === undefined || v === '') { return null; } var n = Number(v); return isFinite(n) ? n : null; }
    function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : null; }
    function str(v) { return typeof v === 'string' ? v : ''; }

    // diagnostic_msgs/DiagnosticStatus -> {level, message, kv}
    function diag(m) {
        if (!m || typeof m !== 'object') { return null; }
        var kv = {};
        (Array.isArray(m.values) ? m.values : []).forEach(function (x) {
            if (x && typeof x.key === 'string') { kv[x.key] = String(x.value == null ? '' : x.value); }
        });
        return { level: int(m.level) || 0, message: String(m.message || ''), kv: kv };
    }
    // the node's warnings (traversability_local.cpp publishStats) -> i18n keys
    var NODE_WARN = { 'no clouds': 'no_clouds', 'TF failures': 'tf', 'stale clouds': 'stale',
                      'integration over budget': 'int_budget', 'features over budget': 'feat_budget',
                      'latency over budget': 'lat_budget', 'CPU over budget': 'cpu_budget' };
    function nodeWarns(message) {
        if (!message || message === 'ok') { return []; }
        return String(message).split(/\s*,\s*/).filter(Boolean).map(function (w) {
            return NODE_WARN[w] ? { key: NODE_WARN[w] } : { key: 'other', raw: w };
        });
    }
    // is a periodic topic alive: 'wait' (not / just subscribed), 'down' (silent), 'ok'
    function alive(now, subAt, rxAt, downMs) {
        if (!subAt) { return 'wait'; }
        if (!rxAt || rxAt < subAt) { return (now - subAt > downMs) ? 'down' : 'wait'; }
        return (now - rxAt > downMs) ? 'down' : 'ok';
    }
    // the terrain node's card from its last DiagnosticStatus
    function nodeView(d, now, subAt, rxAt) {
        var a = alive(now, subAt, rxAt, CONTRACT.node.downMs);
        var v = { state: a, facts: null, warns: [] };
        if (a !== 'ok' || !d) { return v; }
        var k = d.kv;
        v.facts = {
            cpu: num(k.cpu_process_pct), ms: num(k.features_ms_avg), hz: num(k.cloud_hz),
            tf: int(k.tf_failures), zones: int(k.exempt_zones_active), zonesNoTf: int(k.exempt_zones_missing_tf),
            epoch: int(k.epoch), epochEvents: int(k.epoch_events), epochReason: k.epoch_last_reason || '',
            settling: k.settling === '1',
        };
        if (v.facts.cpu !== null && v.facts.cpu < 0) { v.facts.cpu = null; }
        v.warns = nodeWarns(d.message);
        v.state = d.level >= 2 ? 'err' : (d.level === 1 || v.warns.length) ? 'warn' : 'ok';
        return v;
    }
    // the recorder's gate reason (contract §1, terrainfuse.QualityGate) -> {key, v}
    function gateWhy(reason) {
        var r = String(reason == null ? '' : reason), m;
        if (r === 'ok') { return { key: 'ok', v: {} }; }
        if (!r || r === 'no data') { return { key: 'no_data', v: {} }; }
        var fixed = { 'no navpvt': 'no_navpvt', 'navpvt stale': 'navpvt_stale', 'no loc_status': 'no_loc',
                      'loc_status stale': 'loc_stale', 'gps not good': 'gps_bad', 'heading not ok': 'heading',
                      'anchor frozen': 'anchor', 'owner dock': 'docked' };
        if (fixed[r]) { return { key: fixed[r], v: {} }; }
        if ((m = /^fix class (-?\d+)$/.exec(r))) { return { key: 'fix', v: { n: m[1] } }; }
        if ((m = /^hAcc ([\d.]+) mm$/.exec(r))) { return { key: 'hacc', v: { cm: (parseFloat(m[1]) / 10).toFixed(1).replace(/\.0$/, '') } }; }
        // the position's owner by kind, never its raw name (owner 2026-11-08: no technical words)
        if ((m = /^owner (.*)$/.exec(r))) {
            var who = m[1];
            return { key: /lidar|relock|cbgl|gloc|scan|amcl/i.test(who) ? 'owner_lidar' : /odom|wheel|imu|ekf/i.test(who) ? 'owner_odom' : 'owner_other',
                     v: {}, raw: r };
        }
        return { key: 'other', v: {}, raw: r };
    }
    // a no-go candidate (contract: id, kind, area_m2, cells, centroid [x, y], polygon, map frame) or null
    function candidate(c, i) {
        if (!c || typeof c !== 'object') { return null; }
        var poly = Array.isArray(c.polygon) ? c.polygon.filter(function (p) {
            return Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null;
        }).map(function (p) { return [+p[0], +p[1]]; }) : [];
        var x = Array.isArray(c.centroid) ? num(c.centroid[0]) : num(c.x);
        var y = Array.isArray(c.centroid) ? num(c.centroid[1]) : num(c.y);
        if ((x === null || y === null) && poly.length >= 3) {
            x = 0; y = 0;
            poly.forEach(function (p) { x += p[0]; y += p[1]; });
            x /= poly.length; y /= poly.length;
        }
        if (x === null || y === null) { return null; }
        var kind = { 3: 'step', 4: 'slope', step: 'step', slope: 'slope', drop: 'drop' }[c.kind] || 'other';
        return { id: String(c.id != null ? c.id : 'c' + i), kind: kind, x: x, y: y, area: num(c.area_m2), cells: int(c.cells),
                 poly: poly.length >= 3 ? poly : null };
    }
    // the recorder's card from its last /terrain_recorder/state
    var MODES = { recording: 'on', waiting: 'on', paused: 'paused', off: 'off', no_site: 'nosite' };
    function recView(st, now, subAt, rxAt) {
        var a = alive(now, subAt, rxAt, CONTRACT.rec.downMs);
        var v = { state: a, enabled: false, gate: null, area: null, tiles: null, writeAge: null, site: '', cands: [], candsMore: 0,
                  imports: [], backups: [], exportErr: '', lastCmd: null };
        if (a !== 'ok' || !st || typeof st !== 'object') { return v; }
        if (st.running === false) { v.state = 'down'; return v; }
        v.enabled = st.enabled === true;
        v.state = MODES[st.mode] || (st.enabled === false ? 'off' : st.paused ? 'paused' : 'on');
        var g = st.gate;
        if (g && typeof g === 'object') { v.gate = { open: g.open === true, why: gateWhy(g.reason) }; }
        else if (typeof g === 'string') { v.gate = { open: g === 'ok', why: gateWhy(g) }; }
        if (st.mode === 'waiting' && v.gate) { v.gate.open = false; }
        v.site = str(st.site);
        var m = (st.map && typeof st.map === 'object') ? st.map : {};
        v.area = num(m.area_m2);
        v.tiles = int(m.tiles);
        var lw = num(m.last_write), stamp = num(st.stamp);
        // the age on the robot's own clock (no skew with this device)
        v.writeAge = lw === null ? null : (stamp !== null ? stamp - lw : now / 1000 - lw);
        var ex = st.export;
        if (ex && typeof ex === 'object' && ex.ok === false) { v.exportErr = str(ex.error) || 'error'; }
        var list = Array.isArray(st.nogo_candidates) ? st.nogo_candidates : [];
        v.cands = list.slice(0, 50).map(candidate).filter(Boolean);
        v.candsMore = Math.max(0, list.length - 50);
        v.imports = (Array.isArray(st.imports) ? st.imports : []).filter(function (x) { return x && str(x.name); })
            .map(function (x) { return { name: x.name }; });
        v.backups = (Array.isArray(st.backups) ? st.backups : []).filter(function (x) { return x && str(x.name); })
            .map(function (x) { return { name: x.name, area: num(x.area_m2) }; });
        v.lastCmd = (st.last_cmd && typeof st.last_cmd === 'object') ? st.last_cmd : null;
        return v;
    }
    // which recorder buttons make sense (the recorder decides anyway)
    function recActions(v) {
        var live = LIVE.indexOf(v.state) >= 0, site = live && v.state !== 'nosite' && !!v.site;
        return { toggle: live, pause: v.state === 'on' || v.state === 'paused', rebuild: site, clear: site, export: site };
    }
    // the recorder's error codes (contract: English codes, the UI says them)
    // (vitulus_mapping terrainfuse.py RecorderCore._command; "internal: …" = generic)
    var ERRORS = ['bad_token', 'not_available', 'no_site', 'unknown_cmd', 'unknown_import', 'bad_mode', 'bad_source', 'no_token'];
    function errKey(code) {
        code = String(code || '');
        if (/^bad_mosaic\b/.test(code)) { return 'tpan.err.bad_mosaic'; }
        return ERRORS.indexOf(code) >= 0 ? 'tpan.err.' + code : '';
    }
    // a command that holds the recorder's lock for a while (contract §2)
    function heavy(cmd, extra) { return cmd === 'import' || (cmd === 'delete_map' && !!(extra && extra.confirm)); }
    // seconds -> {key, v} "just now" / "{n} min ago" / "{n} h ago" / days
    function ago(sec) {
        if (sec === null || !isFinite(sec)) { return null; }
        if (sec < 0) { sec = 0; }
        if (sec < 60) { return { key: 'now', v: {} }; }
        if (sec < 3600) { return { key: 'min', v: { n: Math.round(sec / 60) } }; }
        if (sec < 48 * 3600) { return { key: 'h', v: { n: Math.round(sec / 3600) } }; }
        return { key: 'd', v: { n: Math.round(sec / 86400) } };
    }
    // the node's ~config -> rows [{key, value, def, min, max, changed}]
    function configRows(cfg) {
        if (!cfg || typeof cfg !== 'object' || !cfg.values || typeof cfg.values !== 'object') { return []; }
        return Object.keys(cfg.values).sort().map(function (k) {
            var r = (cfg.ranges && cfg.ranges[k]) || [], val = num(cfg.values[k]), def = num(cfg.defaults && cfg.defaults[k]);
            return { key: k, value: val, def: def, min: num(r[0]), max: num(r[1]),
                     changed: val !== null && def !== null && Math.abs(val - def) > 1e-9 };
        });
    }
    function fmtNum(v, dec) {
        if (v === null || v === undefined || !isFinite(v)) { return '–'; }
        var s = (+v).toFixed(dec);
        return dec > 0 ? s.replace(/\.?0+$/, '') || '0' : s;
    }
    // a parameter as it was meant: 0.59999999999999998 -> 0.6, 0.0002 stays 0.0002
    function fmtParam(v) {
        if (v === null || v === undefined || !isFinite(v)) { return '–'; }
        if (Math.abs(v) < 0.01 && v !== 0) { return String(Number(v.toPrecision(3))); }
        return String(Number((+v).toFixed(4)));
    }
    function fmtArea(m2) {
        if (m2 === null || m2 === undefined || !isFinite(m2)) { return null; }
        return m2 >= 100 ? String(Math.round(m2)) : m2.toFixed(1);
    }

    var api = { CONTRACT: CONTRACT, diag: diag, nodeWarns: nodeWarns, alive: alive, nodeView: nodeView, gateWhy: gateWhy,
                candidate: candidate, recView: recView, recActions: recActions, errKey: errKey, heavy: heavy, ago: ago, configRows: configRows,
                fmtNum: fmtNum, fmtParam: fmtParam, fmtArea: fmtArea };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (typeof document === 'undefined') { if (root) { root.VTTerrainPanel = api; } return; }

    /* ================================================================= browser */
    function t(k, v) { return root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function lang() { return (root.VTI18n && root.VTI18n.lang && root.VTI18n.lang()) || 'en'; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function $(id) { return document.getElementById(id); }
    function rosOf() { return (root.ros && root.ros.ros) || null; }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    function setText(e, s) { if (e && e.textContent !== s) { e.textContent = s; } }
    function setState(e, s) { if (e && (e.getAttribute('data-state') || '') !== (s || '')) { if (s) { e.setAttribute('data-state', s); } else { e.removeAttribute('data-state'); } } }
    function fire(e, ty) { if (e) { e.dispatchEvent(new Event(ty)); } }
    function nb(s) { return String(s).replace(/ /g, ' '); }
    function agoText(sec) { var a = ago(sec); return a ? t('tpan.ago.' + a.key, a.v) : '–'; }
    function areaText(m2) { var a = fmtArea(m2); return a === null ? '–' : nb(a + ' m²'); }

    var S = {
        sec: null, body: null, P: {}, timer: 0, want: false, ros: null,
        nodeSub: null, nodeSubAt: 0, nodeRx: 0, nodeDiag: null,
        cfgSub: null, cfg: null, cfgSig: '',
        recSub: null, recSubAt: 0, recRx: 0, rec: null, resSub: null,
        recPub: null, waiting: {}, late: {}, seq: 0, busy: '', msg: null, exportWait: null,
        flow: null, flowT: 0, importSig: '',
        candSig: '', legSig: '', ring: null, ringT: 0,
    };

    /* ---------------------------------------------------------- skeleton */
    function card(key, icon) {
        var c = el('div', 'vt-card vt-tp-card');
        c.setAttribute('data-tp', key);
        var h = el('div', 'vt-card-head');
        var i = el('i', 'la ' + icon + ' vt-fa');
        i.setAttribute('aria-hidden', 'true');
        h.appendChild(i);
        var tt = el('span', 'vt-card-title vt-tp-title');
        h.appendChild(tt);
        var meta = el('span', 'vt-end vt-tp-meta');
        h.appendChild(meta);
        c.appendChild(h);
        return { card: c, title: tt, meta: meta, head: h };
    }
    function fact(parent, key) {
        var f = el('div', 'vt-tp-fact');
        var k = el('span', 'vt-tp-fk');
        k.setAttribute('data-k', key);
        var v = el('span', 'vt-tp-fv vt-tnum', '–');
        f.appendChild(k); f.appendChild(v);
        parent.appendChild(f);
        return { k: k, v: v, key: key, box: f };
    }
    function button(cls, act) {
        var b = el('button', 'btn btn-sm ' + cls);
        b.type = 'button';
        b.setAttribute('data-tp-act', act);
        return b;
    }

    function build() {
        var P = S.P = {};
        var body = S.body;
        body.textContent = '';
        P.intro = el('div', 'vt-hint vt-tp-intro');
        body.appendChild(P.intro);

        // 1. the persistent map (the controls: most important, first)
        var r = card('rec', 'la-database');
        P.rec = r;
        P.recMain = el('div', 'vt-tp-main');
        r.card.appendChild(P.recMain);
        P.recSub = el('div', 'vt-tp-sub');
        r.card.appendChild(P.recSub);
        P.recFacts = el('div', 'vt-tp-facts');
        P.fGate = fact(P.recFacts, 'gate');
        P.fArea = fact(P.recFacts, 'area');
        P.fWrite = fact(P.recFacts, 'write');
        P.fSite = fact(P.recFacts, 'site');
        P.fSite.v.classList.add('vt-tp-ell');
        r.card.appendChild(P.recFacts);
        var acts = el('div', 'vt-tp-acts');
        P.bToggle = button('btn-outline-info vt-tp-switch', 'toggle');
        P.bToggle.setAttribute('role', 'switch');
        P.bToggle.setAttribute('aria-checked', 'false');
        P.bToggle.innerHTML = '<span class="vt-tp-sw" aria-hidden="true"></span><span class="vt-tp-bl"></span>';
        P.bPause = button('btn-outline-secondary', 'pause');
        P.bRebuild = button('btn-outline-secondary', 'rebuild');
        P.bClear = button('btn-outline-danger', 'clear');
        [P.bToggle, P.bPause, P.bRebuild, P.bClear].forEach(function (b) { acts.appendChild(b); });
        r.card.appendChild(acts);
        // the one box for questions: delete, rebuild (choose a mosaic, then confirm)
        P.flow = el('div', 'vt-card vt-tp-confirm');
        P.flow.setAttribute('data-state', 'warn');
        P.flow.setAttribute('role', 'group');
        P.flow.hidden = true;
        P.cText = el('div', 'vt-tp-ctext');
        P.cText.id = 'vt_tp_ctext';
        P.flow.setAttribute('aria-describedby', 'vt_tp_ctext');
        P.flow.appendChild(P.cText);
        P.choose = el('div', 'vt-tp-choose');
        var lab = el('label', 'vt-tp-clab');
        P.selL = el('span', 'vt-tp-vl');
        lab.appendChild(P.selL);
        P.sel = el('select', 'form-select form-select-sm vt-tp-sel');
        lab.appendChild(P.sel);
        P.choose.appendChild(lab);
        P.bList = button('btn-outline-secondary vt-tp-list', 'list');
        P.choose.appendChild(P.bList);
        P.mGroup = el('div', 'vt-tp-modes vt-tp-imodes');
        P.mGroup.setAttribute('role', 'radiogroup');
        ['merge', 'replace'].forEach(function (md) {
            var b = el('button', 'vt-tp-mode');
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', 'false');
            b.setAttribute('data-tp-imode', md);
            P.mGroup.appendChild(b);
        });
        P.choose.appendChild(P.mGroup);
        P.flow.appendChild(P.choose);
        P.cNote = el('div', 'vt-hint vt-tp-cbackup');
        P.flow.appendChild(P.cNote);
        var cActs = el('div', 'vt-tp-acts');
        P.cNo = button('btn-outline-secondary', 'flow-no');
        P.cYes = button('btn-danger', 'flow-yes');
        cActs.appendChild(P.cNo); cActs.appendChild(P.cYes);
        P.flow.appendChild(cActs);
        r.card.appendChild(P.flow);
        P.recMsg = el('div', 'vt-tp-msg');
        P.recMsg.setAttribute('role', 'status');
        P.recMsg.setAttribute('aria-live', 'polite');
        r.card.appendChild(P.recMsg);
        P.exp = el('div', 'vt-tp-exp');
        P.expT = el('span', 'vt-tp-sub');
        P.exp.appendChild(P.expT);
        P.bExport = button('btn-outline-secondary', 'export');
        P.exp.appendChild(P.bExport);
        r.card.appendChild(P.exp);
        body.appendChild(r.card);

        // 2. the terrain node
        var n = card('node', 'la-heartbeat');
        P.node = n;
        P.nodeMain = el('div', 'vt-tp-main');
        n.card.appendChild(P.nodeMain);
        P.nodeFacts = el('div', 'vt-tp-facts');
        P.fCpu = fact(P.nodeFacts, 'cpu');
        P.fMs = fact(P.nodeFacts, 'ms');
        P.fHz = fact(P.nodeFacts, 'hz');
        P.fTf = fact(P.nodeFacts, 'tf');
        P.fZone = fact(P.nodeFacts, 'zone');
        P.fEpoch = fact(P.nodeFacts, 'epoch');
        n.card.appendChild(P.nodeFacts);
        P.nodeSub = el('div', 'vt-tp-sub');
        n.card.appendChild(P.nodeSub);
        var det = el('details', 'vt-tp-params');
        det.open = lsGet(LS_PARAMS) === '1';
        det.addEventListener('toggle', function () { lsSet(LS_PARAMS, det.open ? '1' : '0'); if (det.open) { paintParams(true); } });
        P.pSum = el('summary', 'vt-fs-sm');
        det.appendChild(P.pSum);
        P.pHint = el('div', 'vt-hint vt-tp-phint');
        det.appendChild(P.pHint);
        P.pList = el('div', 'vt-tp-plist');
        det.appendChild(P.pList);
        P.params = det;
        n.card.appendChild(det);
        body.appendChild(n.card);

        // 3. on the map
        var m = card('map', 'la-map-o');
        P.map = m;
        P.lyrTrav = layerRow('trav');
        P.lyrMos = layerRow('mosaic');
        m.card.appendChild(P.lyrTrav.row);
        m.card.appendChild(P.lyrMos.row);
        var vw = el('div', 'vt-tp-view');
        P.viewL = el('span', 'vt-tp-vl');
        P.viewL.id = 'vt_tp_view_l';
        vw.appendChild(P.viewL);
        P.modes = el('div', 'vt-tp-modes');
        P.modes.setAttribute('role', 'group');
        P.modes.setAttribute('aria-labelledby', 'vt_tp_view_l');
        ['cost', 'reason', 'height'].forEach(function (md) {
            var b = el('button', 'vt-tp-mode');
            b.type = 'button';
            b.setAttribute('data-tp-mode', md);
            b.setAttribute('aria-pressed', 'false');
            P.modes.appendChild(b);
        });
        vw.appendChild(P.modes);
        m.card.appendChild(vw);
        P.leg = el('div', 'vt-tp-legend');
        m.card.appendChild(P.leg);
        var more = el('div', 'vt-tp-acts');
        P.bLayers = button('btn-outline-info', 'layers');
        more.appendChild(P.bLayers);
        m.card.appendChild(more);
        body.appendChild(m.card);

        // 4. no-go candidates (to review)
        var c = card('cands', 'la-flag-o');
        P.cands = c;
        P.candHint = el('div', 'vt-hint vt-tp-chint');
        c.card.appendChild(P.candHint);
        P.candList = el('ul', 'vt-tp-clist');
        c.card.appendChild(P.candList);
        P.candEmpty = el('div', 'vt-tp-sub vt-tp-cempty');
        c.card.appendChild(P.candEmpty);
        body.appendChild(c.card);

        body.addEventListener('click', onClick);
        body.addEventListener('input', onRange);
        body.addEventListener('change', function (e) {
            var sel = e.target;
            if (sel && sel.hasAttribute && sel.hasAttribute('data-tp-pick') && root.VTTerrainMosaic && VTTerrainMosaic.pick) {
                VTTerrainMosaic.pick(sel.value);
                paintMap();
            }
        });
        P.sel.addEventListener('change', function () { if (S.flow) { S.flow.name = P.sel.value; paint(); } });
        // keys of own controls never drive (vt_joy.js listens on window)
        body.addEventListener('keydown', function (e) {
            var g = e.target && e.target.closest && e.target.closest('.vt-tp-modes');
            var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (g && step) {
                var list = Array.prototype.slice.call(g.querySelectorAll('button:not([disabled])'));
                var i = list.indexOf(document.activeElement);
                e.preventDefault(); e.stopPropagation();
                if (i >= 0) { list[(i + step + list.length) % list.length].focus(); }
                return;
            }
            if (/^(Arrow|Home$|End$|Page)/.test(e.key) && e.target && /^(INPUT|SELECT)$/.test(e.target.tagName)) { e.stopPropagation(); }
        });
        labels();
        paint();
    }
    function layerRow(key) {
        var row = el('div', 'vt-tp-lyr');
        var b = el('button', 'vt-tp-lyrbtn');
        b.type = 'button';
        b.setAttribute('role', 'switch');
        b.setAttribute('aria-checked', 'false');
        b.setAttribute('data-tp-layer', key);
        var sw = el('span', 'vt-tp-sw');
        sw.setAttribute('aria-hidden', 'true');
        b.appendChild(sw);
        var name = el('span', 'vt-tp-ln');
        b.appendChild(name);
        var st = el('span', 'vt-tp-ls vt-tnum');
        b.appendChild(st);
        row.appendChild(b);
        var hint = el('div', 'vt-tp-lh');
        row.appendChild(hint);
        var op = el('label', 'vt-tp-op');
        var opL = el('span', 'vt-tp-vl');
        op.appendChild(opL);
        var rg = el('input', 'vt-tp-range');
        rg.type = 'range'; rg.min = '0'; rg.max = '100'; rg.step = '5';
        rg.setAttribute('data-tp-op', key);
        op.appendChild(rg);
        var opV = el('output', 'vt-tp-opv vt-tnum');
        op.appendChild(opV);
        row.appendChild(op);
        var opH = el('div', 'vt-hint vt-tp-ophint');
        row.appendChild(opH);
        var L = { row: row, btn: b, name: name, st: st, hint: hint, op: op, opL: opL, range: rg, opV: opV, opH: opH, key: key };
        if (key === 'mosaic') {
            // which terrain map is shown (the mosaic module chooses; several: pick one)
            L.pickRow = el('label', 'vt-tp-pick');
            L.pickL = el('span', 'vt-tp-vl');
            L.pickRow.appendChild(L.pickL);
            L.pick = el('select', 'form-select form-select-sm vt-tp-sel');
            L.pick.setAttribute('data-tp-pick', '1');
            L.pickRow.appendChild(L.pick);
            L.cur = el('span', 'vt-tp-cur vt-tnum');
            L.pickRow.appendChild(L.cur);
            row.insertBefore(L.pickRow, op);
        }
        return L;
    }

    // static texts (again on a language switch)
    function labels() {
        var P = S.P;
        if (!P.rec) { return; }
        setText(S.sumTitle, t('tpan.title'));
        setText(P.intro, t('tpan.intro'));
        setText(P.rec.title, t('tpan.rec.title'));
        setText(P.node.title, t('tpan.node.title'));
        setText(P.map.title, t('tpan.map.title'));
        setText(P.cands.title, t('tpan.cand.title'));
        [P.fGate, P.fArea, P.fWrite, P.fSite, P.fCpu, P.fMs, P.fHz, P.fTf, P.fZone, P.fEpoch].forEach(function (f) {
            setText(f.k, t('tpan.f.' + f.key));
            f.box.title = t('tpan.f.' + f.key + '_tip');
        });
        P.bPause.title = t('tpan.rec.pause_tip');
        P.bRebuild.title = t('tpan.rec.rebuild_tip');
        P.bClear.title = t('tpan.rec.clear_tip');
        P.bToggle.title = t('tpan.rec.toggle_tip');
        setText(P.bToggle.querySelector('.vt-tp-bl'), t('tpan.rec.toggle'));
        setText(P.bRebuild, t('tpan.rec.rebuild'));
        setText(P.bClear, t('tpan.rec.clear'));
        setText(P.bExport, t('tpan.rec.export'));
        P.bExport.title = t('tpan.rec.export_tip', { layer: t('tmos.layer') });
        setText(P.cNo, t('common.cancel'));
        setText(P.selL, t('tpan.imp.source'));
        P.sel.setAttribute('aria-label', t('tpan.imp.source'));
        setText(P.bList, t('tpan.imp.list'));
        P.bList.title = t('tpan.imp.list_tip');
        P.mGroup.setAttribute('aria-label', t('tpan.imp.how'));
        P.mGroup.querySelectorAll('[data-tp-imode]').forEach(function (b) { setText(b, t('tpan.imp.mode.' + b.getAttribute('data-tp-imode'))); });
        setText(P.pSum, t('tpan.node.params'));
        setText(P.pHint, t('tpan.node.params_hint'));
        setText(P.lyrTrav.name, t('trav.layer'));       // the layers' own names (one name in the whole UI)
        setText(P.lyrMos.name, t('tmos.layer'));
        setText(P.lyrMos.pickL, t('tmos.pick'));
        P.lyrMos.pick.setAttribute('aria-label', t('tmos.pick'));
        P.lyrMos.pickSig = '';
        P.lyrTrav.btn.title = t('tpan.lyr.trav_tip');
        P.lyrMos.btn.title = t('tpan.lyr.mosaic_tip');
        [P.lyrTrav, P.lyrMos].forEach(function (L) {
            setText(L.opL, t('tpan.opacity'));
            L.range.setAttribute('aria-label', t('tpan.opacity_of', { name: L.name.textContent }));
        });
        setText(P.lyrTrav.opH, t('tpan.opacity_hint'));
        P.lyrMos.opH.hidden = true;
        setText(P.viewL, t('tpan.view'));
        P.modes.querySelectorAll('[data-tp-mode]').forEach(function (b) { setText(b, t('tpan.view.' + b.getAttribute('data-tp-mode'))); });
        setText(P.bLayers, t('tpan.map.layers'));
        setText(P.candHint, t('tpan.cand.hint'));
        S.helpBtn.title = t('common.help');
        S.helpBtn.setAttribute('aria-label', t('common.help'));
        S.legSig = ''; S.candSig = ''; S.cfgSig = ''; S.importSig = '';
    }

    /* ---------------------------------------------------------- data */
    function topic(ros, name, type, cb) {
        var tp = new ROSLIB.Topic({ ros: ros, name: name, messageType: type, queue_length: 1 });
        tp.subscribe(cb);
        return tp;
    }
    function subscribe() {
        var ros = rosOf();
        if (!ros || !root.ROSLIB) { return; }
        if (ros !== S.ros) { unsubscribe(); S.ros = ros; }
        var now = Date.now();
        if (!S.nodeSub) { S.nodeSub = topic(ros, CONTRACT.node.stats, CONTRACT.node.statsType, onNode); S.nodeSubAt = now; }
        if (!S.cfgSub) { S.cfgSub = topic(ros, CONTRACT.node.config, 'std_msgs/String', onCfg); }
        if (!S.recSub) { S.recSub = topic(ros, CONTRACT.rec.state, 'std_msgs/String', onRec); S.recSubAt = now; }
        if (!S.resSub) { S.resSub = topic(ros, CONTRACT.rec.result, 'std_msgs/String', onResult); }
    }
    function unsubscribe() {
        ['nodeSub', 'cfgSub', 'recSub'].forEach(function (k) {
            if (S[k]) { try { S[k].unsubscribe(); } catch (e) { /* closed */ } S[k] = null; }
        });
        S.nodeSubAt = 0; S.recSubAt = 0;
        dropIdle();
    }
    function pending() { return Object.keys(S.waiting).length + Object.keys(S.late).length > 0; }
    // the answers and the command publisher stay only while a command is out (or the section is open)
    function dropIdle() {
        if (S.want || pending()) { return; }
        if (S.resSub) { try { S.resSub.unsubscribe(); } catch (e) { /* closed */ } S.resSub = null; }
        if (S.recPub) { try { S.recPub.unadvertise(); } catch (e) { /* closed */ } S.recPub = null; }
    }
    function parse(m) { try { var j = JSON.parse(m.data); return j && typeof j === 'object' ? j : null; } catch (e) { return null; } }
    function onNode(m) { S.nodeDiag = diag(m); S.nodeRx = Date.now(); paint(); }
    function onCfg(m) { var c = parse(m); if (c) { S.cfg = c; paintParams(false); } }
    function onRec(m) {
        var j = parse(m);
        if (!j) { return; }
        S.rec = j;
        S.recRx = Date.now();
        if (j.last_cmd) { answer(j.last_cmd); }
        // the picture asked for asynchronously: done when the export's version changes
        var ex = j.export;
        if (S.exportWait && ex && typeof ex === 'object') {
            var W = S.exportWait;
            if (ex.running) { W.seenRunning = true; }
            else if (ex.version !== W.from || ex.stamp !== W.stamp || W.seenRunning) {
                // done: a new picture, or a new failure (said by the line under the buttons)
                S.exportWait = null;
                S.msg = ex.ok === false ? null : { key: 'tpan.msg.done.export', state: 'ok' };
            }
        }
        paint();
    }
    function onResult(m) { var j = parse(m); if (j) { answer(j); } }
    // an answer for one of our commands (cmd_result or state.last_cmd)
    function answer(a) {
        if (!a || a.id == null) { return; }
        var final = !(a.ok === null || a.ok === undefined);
        // contract v2: the latched state says only token_sent; the token itself comes in cmd_result
        if (final && a.ok && a.result && a.result.token_sent && !a.result.confirm_token) { return; }
        var late = S.late[a.id];
        if (late) {                                   // after we stopped waiting: still said
            if (final) { delete S.late[a.id]; late.done(a, true); dropIdle(); }
            return;
        }
        var w = S.waiting[a.id];
        if (!w) { return; }
        if (!final) {
            if (a.running) { w.extend(); }        // a long command is on its way
            return;
        }
        delete S.waiting[a.id];
        clearTimeout(w.timer);
        w.done(a, false);
        dropIdle();
    }

    /* the one door for writes: a recorder command of the contract, by a button press */
    function recCmd(cmd, extra, done) {
        var ros = rosOf();
        if (!ros || !root.ROSLIB || CONTRACT.rec.cmds.indexOf(cmd) < 0) { done({ ok: false, error: 'noros' }, false); return; }
        if (!S.resSub || S.resSub.ros !== ros) { S.resSub = topic(ros, CONTRACT.rec.result, 'std_msgs/String', onResult); }
        if (!S.recPub || S.recPub.ros !== ros) {
            S.recPub = new ROSLIB.Topic({ ros: ros, name: CONTRACT.rec.cmd, messageType: 'std_msgs/String' });
        }
        S.seq += 1;
        var id = 'ui-tpan-' + (Date.now() % 1000000000) + '-' + S.seq, msg = { id: id, cmd: cmd };
        Object.keys(extra || {}).forEach(function (k) { msg[k] = extra[k]; });
        var w = { done: done, timer: 0 };
        // no answer in time: say so, but a later answer with this id still counts (kept 10 min)
        var giveUp = function () {
            if (!S.waiting[id]) { return; }
            delete S.waiting[id];
            S.late[id] = w;
            setTimeout(function () { delete S.late[id]; dropIdle(); }, 600000);
            done({ ok: false, error: 'timeout' }, false);
        };
        w.timer = setTimeout(giveUp, heavy(cmd, extra) ? CONTRACT.rec.heavyMs : CONTRACT.rec.answerMs);
        if (heavy(cmd, extra)) { w.long = true; }
        w.extend = function () {
            if (w.long) { return; }
            w.long = true;
            clearTimeout(w.timer);
            w.timer = setTimeout(giveUp, CONTRACT.rec.longMs);
            if (S.busy) { S.msg = { key: 'tpan.msg.running', state: '' }; paint(); }
        };
        S.waiting[id] = w;
        S.recPub.publish(new ROSLIB.Message({ data: JSON.stringify(msg) }));
    }
    // send, show "sending", then the answer; then(a) runs on success
    function run(cmd, extra, okKey, then) {
        if (S.busy) { return; }
        S.busy = cmd;
        S.msg = { key: heavy(cmd, extra) ? 'tpan.msg.running' : 'tpan.msg.sending', state: '' };
        paint();
        recCmd(cmd, extra, function (a, late) {
            if (!late) { S.busy = ''; }
            if (a && a.ok) {
                var r = (a.result && typeof a.result === 'object') ? a.result : {};
                S.msg = okKey ? { key: okKey, v: msgVars(a), state: 'ok' } : null;
                if (late && !okKey) { S.msg = { key: 'tpan.msg.late', state: '' }; }
                if (cmd === 'rebuild_export' && r.queued) {
                    var ex = (S.rec && S.rec.export) || {};
                    S.exportWait = { from: ex.version, stamp: ex.stamp };
                    S.msg = { key: 'tpan.msg.export_queued', state: '' };
                }
                if (then && !late) { then(a); }     // a late token is not shown: it may have expired
            } else {
                var err = String((a && a.error) || '');
                S.msg = err === 'timeout' ? { key: 'tpan.msg.timeout', state: 'err' }
                    : err === 'noros' ? { key: 'tpan.msg.noros', state: 'err' }
                    : errKey(err) ? { key: errKey(err), state: 'err', raw: err }
                    : { key: 'tpan.msg.refused', state: 'err', raw: err };
                // the mosaic is gone: back to the choice, where Refresh list is
                if (err === 'unknown_import' && cmd === 'import' && !late) {
                    openFlow({ kind: 'import', step: 'choose', name: '', mode: (extra && extra.mode) || 'merge' }, true);
                }
            }
            paint();
        });
    }
    function msgVars(a) {
        var r = (a && a.result && typeof a.result === 'object') ? a.result : {};
        return { backup: str(r.backup) || '–', cells: r.imported_cells != null ? String(r.imported_cells) : '–' };
    }

    /* ---------------------------------------------------------- actions */
    function view() { return recView(S.rec, Date.now(), S.recSubAt, S.recRx); }
    function onClick(e) {
        var b = e.target.closest && e.target.closest('button');
        if (!b || !S.body.contains(b) || b.disabled) { return; }
        var act = b.getAttribute('data-tp-act'), v = view();
        if (act === 'toggle') { run(v.enabled ? 'disable' : 'enable', null, v.enabled ? 'tpan.msg.done.disable' : 'tpan.msg.done.enable'); return; }
        if (act === 'pause') { run(v.state === 'paused' ? 'resume' : 'pause', null, v.state === 'paused' ? 'tpan.msg.done.resume' : 'tpan.msg.done.pause'); return; }
        if (act === 'clear') { askDelete(); return; }
        if (act === 'rebuild') { openFlow({ kind: 'import', step: 'choose', name: v.imports.length ? v.imports[0].name : '', mode: 'merge' }); return; }
        if (act === 'list') { run('list', null, 'tpan.msg.done.list'); return; }
        if (act === 'export') { run('rebuild_export', null, 'tpan.msg.done.export'); return; }
        if (act === 'flow-no') { closeFlow(true); return; }
        if (act === 'flow-yes') { flowYes(); return; }
        if (act === 'layers') { if (root.VTMapLayers && VTMapLayers.open) { VTMapLayers.open(); } return; }
        if (act === 'show') { showCand(b.getAttribute('data-tp-cand')); return; }
        if (b.hasAttribute('data-tp-imode')) { if (S.flow) { S.flow.mode = b.getAttribute('data-tp-imode'); paint(); } return; }
        if (b.hasAttribute('data-tp-layer')) { toggleLayer(b.getAttribute('data-tp-layer')); return; }
        if (b.hasAttribute('data-tp-mode')) { setMode(b.getAttribute('data-tp-mode')); }
    }
    // delete, step 1: the recorder deletes nothing and gives a token; the
    // question shows what goes; step 2 (the second press) sends the token
    function askDelete() {
        run('delete_map', null, '', function (a) {
            var r = a.result || {};
            if (!r.confirm_token) { S.msg = { key: 'tpan.err.no_token', state: 'err' }; return; }
            openFlow({ kind: 'clear', step: 'confirm', token: String(r.confirm_token), info: r,
                       ms: Math.min(FLOW_MS, (num(r.expires_s) || 60) * 1000) });
        });
    }
    function flowYes() {
        var f = S.flow;
        if (!f) { return; }
        if (f.kind === 'clear') {
            closeFlow(false);
            run('delete_map', { confirm: f.token }, 'tpan.msg.done.clear');
            return;
        }
        // import: choose -> (merge) confirm here | (replace) token from the recorder -> confirm
        var base = { source: 'mosaic', name: f.name, mode: f.mode };
        if (f.step === 'choose') {
            if (!f.name) { return; }
            if (f.mode === 'merge') { f.step = 'confirm'; paint(); return; }
            run('import', base, '', function (a) {
                var r = a.result || {};
                if (!r.confirm_token) { closeFlow(false); S.msg = { key: 'tpan.msg.done.import', v: msgVars(a), state: 'ok' }; return; }
                openFlow({ kind: 'import', step: 'confirm', name: f.name, mode: 'replace', token: String(r.confirm_token), info: r,
                           ms: Math.min(FLOW_MS, (num(r.expires_s) || 60) * 1000) });
            });
            return;
        }
        closeFlow(false);
        if (f.mode === 'replace') { base.confirm = f.token; }
        run('import', base, 'tpan.msg.done.import');
    }
    function openFlow(f, keepMsg) {
        S.flow = f;
        clearTimeout(S.flowT);
        S.flowT = setTimeout(function () { closeFlow(false); }, f.ms || FLOW_MS);
        if (f.step === 'choose' && !keepMsg) { S.msg = null; }
        S.importSig = '';
        paint();
        try { (f.step === 'choose' ? S.P.sel : S.P.cNo).focus({ preventScroll: false }); } catch (e) { /* old browser */ }
    }
    function closeFlow(refocus) {
        var was = S.flow;
        S.flow = null;
        clearTimeout(S.flowT);
        paint();
        if (refocus && was) { try { (was.kind === 'clear' ? S.P.bClear : S.P.bRebuild).focus(); } catch (e) { /* old browser */ } }
    }

    /* ---------------------------------------------------------- layers (mirror) */
    function travChk() { return $('mapv3_chk_trav'); }
    function mosChk() { return $('mapv3_chk_tmosaic'); }
    function toggleLayer(key) {
        var c = key === 'trav' ? travChk() : mosChk();
        if (!c) { return; }
        c.checked = !c.checked;
        fire(c, 'change');
        try { document.dispatchEvent(new CustomEvent('vt:map-sources')); } catch (e) { /* old browser */ }
        paint();
    }
    function hasOpt(sel, v) { return !!sel && Array.prototype.some.call(sel.options || [], function (o) { return o.value === v; }); }
    function setMode(md) {
        [$('mapv3_trav_mode'), $('mapv3_tmosaic_mode')].forEach(function (s) {
            if (s && s.value !== md && hasOpt(s, md)) { s.value = md; fire(s, 'change'); }
        });
        paint();
    }
    function onRange(e) {
        var r = e.target;
        if (!r || !r.hasAttribute || !r.hasAttribute('data-tp-op')) { return; }
        var v = r.value, key = r.getAttribute('data-tp-op');
        // each layer its own opacity (0–1); the live one is multiplied by the shared "Maps opacity" in the layer
        var o = $(key === 'trav' ? 'mapv3_trav_op' : 'mapv3_tmosaic_op');
        if (o) { o.value = String(+v / 100); fire(o, 'input'); }
        var L = key === 'trav' ? S.P.lyrTrav : S.P.lyrMos;
        setText(L.opV, nb(v + ' %'));
    }

    /* ---------------------------------------------------------- show on map */
    function viewer() { return (root.viewer && root.viewer.viewer) || root.__ros3d_map || null; }
    function showCand(id) {
        var c = null;
        view().cands.forEach(function (x) { if (x.id === id) { c = x; } });
        var V = viewer(), T = root.ROS3D && ROS3D.THREE;
        if (!c || !V || !T || !V.cameraControls) { return; }
        var cc = V.cameraControls, cam = V.camera;
        var dx = c.x - cc.center.x, dy = c.y - cc.center.y;
        cc.center.x += dx; cc.center.y += dy;
        cam.position.x += dx; cam.position.y += dy;
        // the drawer covers part of the map: move the point into the free part
        try {
            var cv = V.renderer && V.renderer.domElement, dr = $('ui_drawer');
            if (cv && dr && dr.offsetParent) {
                var cr = cv.getBoundingClientRect(), r = dr.getBoundingClientRect();
                var dist = cam.position.distanceTo(cc.center), fov = (cam.fov || 40) * Math.PI / 180;
                var mpp = 2 * dist * Math.tan(fov / 2) / Math.max(1, cr.height);
                var px = 0, py = 0;
                if (r.width < cr.width * 0.9 && r.left <= cr.left + 4) { px = (r.right - cr.left) / 2; }     // drawer on the left
                else if (r.top > cr.top + cr.height * 0.2) { py = (cr.bottom - r.top) / 2; }               // sheet at the bottom
                if (px || py) {
                    cc.center.x -= px * mpp; cam.position.x -= px * mpp;
                    cc.center.y -= py * mpp; cam.position.y -= py * mpp;
                }
            }
        } catch (e) { /* the point stays in the middle */ }
        try { cc.update(); } catch (e) { /* frozen by the editor */ }
        ring(c, V, T);
    }
    function dropRing(V, g) {
        V.scene.remove(g);
        g.children.forEach(function (o) { o.geometry.dispose(); o.material.dispose(); });
    }
    function ring(c, V, T) {
        if (S.ring) { dropRing(V, S.ring); S.ring = null; }
        clearTimeout(S.ringT);
        var g = new T.Object3D(), col = 0xff7100;       // the brand orange (vt_tokens --vt-brand)
        var rad = Math.max(0.6, c.area ? Math.sqrt(c.area / Math.PI) + 0.4 : 0.8);
        [rad, rad + 0.15].forEach(function (r, k) {
            var geo = new T.Geometry();
            for (var i = 0; i <= 48; i++) { var a = i / 48 * Math.PI * 2; geo.vertices.push(new T.Vector3(c.x + r * Math.cos(a), c.y + r * Math.sin(a), 0.06)); }
            var l = new T.Line(geo, new T.LineBasicMaterial({ color: col, transparent: true, opacity: k ? 0.5 : 1, depthTest: false, depthWrite: false }));
            l.renderOrder = 60; l.frustumCulled = false;
            g.add(l);
        });
        if (c.poly) {
            var pg = new T.Geometry();
            c.poly.concat([c.poly[0]]).forEach(function (p) { pg.vertices.push(new T.Vector3(p[0], p[1], 0.06)); });
            var pl = new T.Line(pg, new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
            pl.renderOrder = 61; pl.frustumCulled = false;
            g.add(pl);
        }
        V.scene.add(g);
        S.ring = g;
        S.ringT = setTimeout(function () { if (S.ring === g) { dropRing(V, g); S.ring = null; } }, RING_MS);
    }

    /* ---------------------------------------------------------- paint */
    function paint() {
        var P = S.P;
        if (!P.rec) { return; }
        var now = Date.now(), ros = rosOf(), online = !!(ros && ros.isConnected !== false);
        var nv = nodeView(S.nodeDiag, now, S.nodeSubAt, S.nodeRx);
        // while a command is out the recorder can be silent (it holds its lock): not "not running"
        var rv = recView(S.rec, now, S.recSubAt, S.busy && S.rec ? now : S.recRx);
        if (!online) { nv.state = rv.state = 'noros'; }
        paintRec(rv);
        paintNode(nv);
        paintMap();
        paintCands(rv);
        // the summary: one pill for the section (the persistent map). A closed
        // gate (in the dock, no RTK) and a pause are normal: info, not a warning
        var gate = rv.state === 'on' && rv.gate && !rv.gate.open;
        var key = gate ? 'gate' : rv.state;
        var sum = { on: gate ? 'info' : 'ok', paused: 'info', off: 'off', nosite: 'info' }[rv.state] || '';
        var sumTxt = S.want ? t('tpan.sum.' + key) : '';
        setText(S.sumMeta, sumTxt);
        setState(S.sumMeta, S.want && sum ? sum : '');
        S.sumMeta.hidden = !sumTxt;
    }
    function paintRec(v) {
        var P = S.P, st = v.state, gate = st === 'on' && v.gate && !v.gate.open;
        // not running = not installed / VITULUS_TERRAIN_GLOBAL off (the default): grey, said below
        setState(P.rec.card, { on: gate ? 'info' : 'ok', paused: 'info', off: 'off', nosite: 'info', down: 'off', noros: 'off' }[st] || '');
        setText(P.rec.meta, t('tpan.rec.st.' + (gate ? 'waiting' : st)));
        setText(P.recMain, t('tpan.rec.main.' + (gate ? 'on_gate' : st)));
        var sub = '';
        if (gate) { sub = t('tpan.gate.' + v.gate.why.key, v.gate.why.v); }
        else if (st === 'down') { sub = t('tpan.rec.down_hint'); }
        else if (st === 'off') { sub = t('tpan.rec.off_hint'); }
        P.recSub.title = gate && v.gate.why.raw ? v.gate.why.raw : '';
        setText(P.recSub, sub);
        P.recSub.hidden = !sub;
        var live = LIVE.indexOf(st) >= 0;
        P.recFacts.hidden = !live;
        if (live) {
            setText(P.fGate.v, v.gate ? (v.gate.open ? t('tpan.gate.open') : t('tpan.gate.closed')) : '–');
            setState(P.fGate.v, v.gate ? (v.gate.open ? 'ok' : 'info') : '');
            setText(P.fArea.v, areaText(v.area));
            setText(P.fWrite.v, v.writeAge !== null ? agoText(v.writeAge) : t('tpan.never'));
            setText(P.fSite.v, v.site || t('tpan.rec.no_site'));
            P.fSite.v.title = v.site || '';
        }
        var A = recActions(v), busy = !!S.busy, flow = S.flow;
        if (flow && !(flow.kind === 'clear' ? A.clear : A.rebuild)) { S.flow = flow = null; }
        P.bToggle.disabled = !A.toggle || busy;
        P.bToggle.setAttribute('aria-checked', String(v.enabled));
        P.bPause.disabled = !A.pause || busy;
        setText(P.bPause, t(st === 'paused' ? 'tpan.rec.resume' : 'tpan.rec.pause'));
        P.bPause.setAttribute('aria-pressed', String(st === 'paused'));
        P.bRebuild.disabled = !A.rebuild || busy || !!flow;
        P.bClear.disabled = !A.clear || busy || !!flow;
        var on = function (b, cmds) { b.classList.toggle('vt-tp-busy', busy && cmds.indexOf(S.busy) >= 0); };
        on(P.bToggle, ['enable', 'disable']); on(P.bPause, ['pause', 'resume']); on(P.bClear, ['delete_map']);
        on(P.bRebuild, ['import', 'list']); on(P.bExport, ['rebuild_export']);
        paintFlow(v, flow, busy);
        var m = S.msg;
        setText(P.recMsg, m ? t(m.key, m.v) : '');
        P.recMsg.title = (m && m.raw) || '';
        setState(P.recMsg, m ? m.state : '');
        P.recMsg.hidden = !P.recMsg.textContent;
        P.exp.hidden = !(live && v.exportErr);
        if (!P.exp.hidden) { setText(P.expT, t('tpan.rec.export_err')); P.expT.title = v.exportErr; }
        P.bExport.disabled = !A.export || busy;
    }
    function paintFlow(v, f, busy) {
        var P = S.P;
        P.flow.hidden = !f;
        if (!f) { return; }
        var choose = f.kind === 'import' && f.step === 'choose';
        P.choose.hidden = !choose;
        P.flow.setAttribute('role', choose ? 'group' : 'alertdialog');
        var info = f.info || {}, site = str(info.site) || v.site || '–';
        var area = areaText(num(info.area_m2) !== null ? num(info.area_m2) : v.area);
        var tiles = int(info.tiles) !== null ? int(info.tiles) : (v.tiles !== null ? v.tiles : '–');
        var keep = v.backups.length;
        if (f.kind === 'clear') {
            setText(P.cText, t('tpan.confirm.clear', { site: site, area: area, tiles: tiles }));
            setText(P.cNote, t('tpan.confirm.backup.clear', { n: keep }));
            setText(P.cYes, t('tpan.confirm.yes.clear'));
        } else if (choose) {
            setText(P.cText, t('tpan.imp.title', { site: site }));
            var sig = lang() + '|' + v.imports.map(function (x) { return x.name; }).join(',');
            if (sig !== S.importSig) {
                S.importSig = sig;
                P.sel.textContent = '';
                v.imports.forEach(function (x) { P.sel.appendChild(el('option', '', x.name)).value = x.name; });
                if (!v.imports.length) { var o = el('option', '', t('tpan.imp.none_opt')); o.value = ''; P.sel.appendChild(o); }
            }
            if (f.name && !v.imports.some(function (x) { return x.name === f.name; })) { f.name = v.imports.length ? v.imports[0].name : ''; }
            if (!f.name && v.imports.length) { f.name = v.imports[0].name; }
            if (P.sel.value !== f.name) { P.sel.value = f.name; }
            P.sel.title = f.name;
            P.sel.disabled = !v.imports.length;
            P.bList.disabled = busy;
            P.mGroup.querySelectorAll('[data-tp-imode]').forEach(function (b) {
                var md = b.getAttribute('data-tp-imode');
                b.setAttribute('aria-checked', String(md === f.mode));
                b.tabIndex = md === f.mode ? 0 : -1;
            });
            setText(P.cNote, v.imports.length ? t('tpan.imp.hint.' + f.mode) : t('tpan.imp.none'));
            setText(P.cYes, t('tpan.imp.next'));
        } else {
            setText(P.cText, t('tpan.confirm.import.' + f.mode, { site: site, area: area, name: f.name }));
            setText(P.cNote, t(f.mode === 'replace' ? 'tpan.confirm.backup.replace' : 'tpan.imp.hint.merge', { n: keep }));
            setText(P.cYes, t('tpan.confirm.yes.' + f.mode));
        }
        var danger = f.kind === 'clear' || (f.mode === 'replace' && !choose);
        P.cYes.className = 'btn btn-sm ' + (danger ? 'btn-danger' : choose ? 'btn-info' : 'btn-warning');
        P.cYes.disabled = busy || (choose && !f.name);
    }
    function paintNode(v) {
        var P = S.P, st = v.state;
        setState(P.node.card, { ok: 'ok', warn: 'warn', err: 'err', down: 'warn', noros: 'off' }[st] || '');
        setText(P.node.meta, t('tpan.node.st.' + st));
        setText(P.nodeMain, t('tpan.node.main.' + st));
        var f = v.facts;
        P.nodeFacts.hidden = !f;
        if (f) {
            setText(P.fCpu.v, f.cpu === null ? '–' : nb(fmtNum(f.cpu, 0) + ' %'));
            setText(P.fMs.v, f.ms === null ? '–' : nb(fmtNum(f.ms, 1) + ' ms'));
            setText(P.fHz.v, f.hz === null ? '–' : t('tpan.node.per_s', { n: fmtNum(f.hz, 0) }));
            setText(P.fTf.v, f.tf === null ? '–' : String(f.tf));
            setState(P.fTf.v, f.tf ? 'warn' : '');
            // the dock zone: applied when the node knows where the dock is (TF), or why not
            setText(P.fZone.v, f.zones === null ? '–' : f.zones > 0 ? t('tpan.node.zone_on', { n: f.zones })
                : f.zonesNoTf > 0 ? t('tpan.node.zone_notf') : t('tpan.node.zone_none'));
            setState(P.fZone.v, f.zones === 0 && f.zonesNoTf > 0 ? 'warn' : '');
            setText(P.fEpoch.v, f.epoch === null ? '–' : (f.settling ? t('tpan.node.epoch_settling', { n: f.epoch }) : String(f.epoch)));
            P.fEpoch.box.title = t('tpan.f.epoch_tip');
        }
        var sub = v.warns.map(function (w) { return t('tpan.node.w.' + w.key); }).join(' · ');
        P.nodeSub.title = v.warns.filter(function (w) { return w.raw; }).map(function (w) { return w.raw; }).join(', ');
        if (st === 'down') { sub = t('tpan.node.down_hint'); }
        setText(P.nodeSub, sub);
        P.nodeSub.hidden = !sub;
    }
    function paintParams(force) {
        var P = S.P;
        if (!P.pList || (!P.params.open && !force)) { return; }
        var rows = configRows(S.cfg), sig = lang() + JSON.stringify(rows);
        if (sig === S.cfgSig) { return; }
        S.cfgSig = sig;
        P.pList.textContent = '';
        if (!rows.length) { P.pList.appendChild(el('div', 'vt-tp-sub', t('tpan.node.params_none'))); return; }
        rows.forEach(function (r) {
            var d = el('div', 'vt-tp-prow' + (r.changed ? ' is-changed' : ''));
            d.appendChild(el('span', 'vt-tp-pk', r.key));
            d.appendChild(el('span', 'vt-tp-pv vt-tnum', fmtParam(r.value)));
            var meta = (r.min !== null && r.max !== null) ? t('tpan.node.range', { min: fmtParam(r.min), max: fmtParam(r.max) }) : '';
            if (r.changed) { meta = t('tpan.node.changed', { def: fmtParam(r.def) }) + (meta ? ' · ' + meta : ''); }
            d.appendChild(el('span', 'vt-tp-pm vt-tnum', meta));
            P.pList.appendChild(d);
        });
    }
    function paintMap() {
        var P = S.P, tc = travChk(), mc = mosChk();
        var TI = root.VTTerrain && VTTerrain.info ? VTTerrain.info() : null;
        var MI = root.VTTerrainMosaic && VTTerrainMosaic.info ? VTTerrainMosaic.info() : null;
        paintLayer(P.lyrTrav, tc, tc && tc.checked && TI ? t('tpan.lyr.st.' + TI.state) : '', tc ? '' : t('tpan.lyr.missing'),
            $('mapv3_trav_op'), 100);
        paintPick(P.lyrMos, mc, MI);
        paintLayer(P.lyrMos, mc, mc && mc.checked && MI && MI.state ? t('tmos.st.' + MI.state) : '', mc ? '' : t('tpan.lyr.missing'),
            $('mapv3_tmosaic_op'), 100);
        // the view: of the layers that are on (or that exist, when none is on)
        var travOn = !!(tc && tc.checked), mosOn = !!(mc && mc.checked);
        var tv = TI ? TI.views : { reason: true, cost: true, height: false };
        if (TI && TI.source === 'grid') { tv = { reason: false, cost: true, height: false }; }
        var mv = MI ? MI.views : { cost: true, reason: true, height: false };
        var useT = tc && (travOn || !mosOn), useM = mc && (mosOn || !travOn);
        var mode = useT && TI ? (TI.source === 'grid' ? 'cost' : TI.mode) : useM && MI ? MI.mode
            : (($('mapv3_trav_mode') || $('mapv3_tmosaic_mode') || {}).value || 'cost');
        P.modes.querySelectorAll('[data-tp-mode]').forEach(function (b) {
            var md = b.getAttribute('data-tp-mode'), ok = (useT && tv[md]) || (useM && mv[md]);
            if (b.disabled !== !ok) { b.disabled = !ok; }
            b.setAttribute('aria-pressed', String(md === mode));
            b.title = !tc && !mc ? '' : (!ok ? t(md === 'height' ? 'tpan.view.height_off' : 'tpan.view.cost_only') : t('tpan.view.' + md + '_tip'));
        });
        var sig = mode + '|' + lang();
        if (sig !== S.legSig) { S.legSig = sig; P.leg.innerHTML = legendHtml(mode); }
    }
    // the terrain map the mosaic layer shows: a choice when there are several, else its name
    function mosName(m) {
        if (!m) { return ''; }
        var nm = m.source === 'terrain_recorder' ? t('tmos.recorder') : String(m.name || '');
        var w = m.generated_unix != null ? m.generated_unix : (m.stamp != null ? m.stamp : m.mtime);
        if (!(w > 0)) { return nm; }
        var when = new Date(w * 1000).toLocaleString(lang() === 'cs' ? 'cs-CZ' : 'en-GB',
            { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
        return nm + ' · ' + when;
    }
    function paintPick(L, chk, MI) {
        var list = (MI && MI.list) || [], cur = MI && MI.mosaic;
        L.pickRow.hidden = !(chk && cur);
        if (L.pickRow.hidden) { return; }
        var many = list.length > 1;
        L.pick.hidden = !many;
        L.cur.hidden = many;
        if (many) {
            var sig = lang() + '|' + list.map(function (x) { return x.name + '@' + (x.mtime || '') + '@' + (x.stamp || ''); }).join(',');
            if (sig !== L.pickSig) {
                L.pickSig = sig;
                L.pick.textContent = '';
                list.forEach(function (x) { var o = el('option', '', mosName(x)); o.value = x.name; L.pick.appendChild(o); });
            }
            if (L.pick.value !== cur.name && document.activeElement !== L.pick) { L.pick.value = cur.name; }
            L.pick.title = mosName(cur);
        } else {
            setText(L.cur, mosName(cur));
            L.cur.title = mosName(cur);
        }
    }
    // a layer row: switch, state, its opacity (0–100 % shown; scale = 100 / control max)
    function paintLayer(L, chk, st, missing, opEl, scale) {
        L.btn.disabled = !chk;
        L.btn.setAttribute('aria-checked', String(!!(chk && chk.checked)));
        setText(L.st, st);
        setText(L.hint, missing);
        L.hint.hidden = !missing;
        L.op.hidden = !opEl;
        if (L.key === 'trav') { L.opH.hidden = !opEl; }
        if (opEl) {
            var pct = String(Math.round((parseFloat(opEl.value) || 0) * scale));
            if (document.activeElement !== L.range && L.range.value !== pct) { L.range.value = pct; }
            setText(L.opV, nb(L.range.value + ' %'));
        }
    }
    function rgba(c) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255).toFixed(2) + ')'; }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    // the legend of a view from the live layer's own colours (vt_terrain_layer.js)
    function legendHtml(mode) {
        var V = root.VTTerrain;
        if (!V || !V.costColor) { return ''; }
        if (mode === 'cost') {
            var stops = [0, 25, 49, 50, 75, 99].map(function (c, i, a) { return rgba(V.costColor(c)) + ' ' + Math.round(i / a.length * 100) + '%'; });
            stops.push(rgba(V.costColor(100)) + ' 86%', rgba(V.costColor(100)) + ' 100%');
            return '<span class="vt-tp-grad" style="background:linear-gradient(90deg,' + stops.join(',') + ')"></span>' +
                '<span class="vt-tp-gl"><span>' + esc(t('tpan.leg.free')) + '</span><span>' + esc(t('tpan.leg.hard')) + '</span><span>' +
                esc(t('tpan.leg.lethal')) + '</span></span>';
        }
        if (mode === 'height' && V.heightColor) {
            var sp = V.ELEV_SPAN_CM || 15, hs = [128 - sp, 128, 128 + sp].map(function (x) { return rgba(V.heightColor(x)); });
            return '<span class="vt-tp-grad" style="background:linear-gradient(90deg,' + hs.join(',') + ')"></span>' +
                '<span class="vt-tp-gl vt-tnum"><span>' + esc(t('tpan.leg.low', { cm: sp })) + '</span><span>' + esc(t('tpan.leg.level')) +
                '</span><span>' + esc(t('tpan.leg.high', { cm: sp })) + '</span></span>';
        }
        if (!V.REASON || !V.REASON_KEYS) { return ''; }
        return '<span class="vt-tp-reasons">' + [1, 2, 3, 4, 5, 6, 7].map(function (c) {
            var col = c === 2 ? V.reasonColor(2, 75) : V.REASON[c];
            return '<span class="vt-tp-reason"><span class="vt-tp-chip" style="background:rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')"></span>' +
                esc(t('trav.r.' + V.REASON_KEYS[c])) + '</span>';
        }).join('') + '</span>';
    }
    function paintCands(v) {
        var P = S.P, live = LIVE.indexOf(v.state) >= 0;
        setText(P.cands.meta, live ? t('tpan.cand.count', { n: v.cands.length + v.candsMore }) : '');
        var sig = lang() + '|' + live + '|' + v.cands.map(function (c) {
            return c.id + ':' + c.kind + ':' + fmtArea(c.area) + ':' + c.cells;
        }).join(',') + '|' + v.candsMore;
        if (sig === S.candSig) { return; }
        S.candSig = sig;
        P.candList.textContent = '';
        v.cands.forEach(function (c) {
            var li = el('li', 'vt-tp-cand');
            var txt = el('div', 'vt-tp-ctxt');
            var top = el('div', 'vt-tp-ctop');
            var tag = el('span', 'vt-pill vt-tp-ckind', t('tpan.cand.kind.' + c.kind));
            tag.setAttribute('data-state', c.kind === 'step' || c.kind === 'slope' ? 'warn' : 'info');
            top.appendChild(tag);
            if (c.area !== null) { top.appendChild(el('span', 'vt-tp-carea vt-tnum', areaText(c.area))); }
            txt.appendChild(top);
            txt.appendChild(el('div', 'vt-tp-cmeta vt-tnum', t('tpan.cand.where', { x: fmtNum(c.x, 1), y: fmtNum(c.y, 1) })));
            li.appendChild(txt);
            var b = el('button', 'btn btn-sm btn-outline-info vt-tp-show', t('tpan.cand.show'));
            b.type = 'button';
            b.setAttribute('data-tp-act', 'show');
            b.setAttribute('data-tp-cand', c.id);
            b.setAttribute('aria-label', t('tpan.cand.show_aria', { kind: t('tpan.cand.kind.' + c.kind) }));
            li.appendChild(b);
            P.candList.appendChild(li);
        });
        if (v.candsMore) { P.candList.appendChild(el('li', 'vt-tp-sub', t('tpan.cand.more', { n: v.candsMore }))); }
        var empty = !live ? t('tpan.cand.unknown') : (v.cands.length ? '' : t('tpan.cand.none'));
        setText(P.candEmpty, empty);
        P.candEmpty.hidden = !empty;
    }

    /* ---------------------------------------------------------- mount + life */
    function shown() {
        if (!S.sec || !S.sec.open || document.hidden) { return false; }
        return !!S.body.offsetParent;     // the Map panel and its Map tab are shown
    }
    function tick() {
        var want = shown();
        if (want !== S.want) {
            S.want = want;
            if (want) { subscribe(); } else { unsubscribe(); }
        } else if (want) { subscribe(); }     // reconnected: a new ros
        if (want || S.sumMeta.textContent) { paint(); }
    }
    function mount() {
        if (S.sec) { return true; }
        var tab = $('tab-map'), layers = tab && tab.querySelector('details.map-sec[data-mapsec="layers"]');
        if (!tab) { return false; }
        var d = el('details', 'map-sec vt-tp');
        d.setAttribute('data-mapsec', 'terrain');
        d.id = 'mapv3_sec_terrain';
        var sum = el('summary', 'vt-tp-sum');
        S.sumTitle = el('span', 'vt-tp-sumt');
        sum.appendChild(S.sumTitle);
        S.sumMeta = el('span', 'vt-pill vt-tp-summ');
        S.sumMeta.hidden = true;
        sum.appendChild(S.sumMeta);
        S.helpBtn = el('button', 'vt-tp-help', '?');
        S.helpBtn.type = 'button';
        S.helpBtn.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (root.VTHelp) { VTHelp.open('terrain'); }
        });
        sum.appendChild(S.helpBtn);
        d.appendChild(sum);
        S.body = el('div', 'map-sec-body vt-tp-body');
        d.appendChild(S.body);
        if (layers) { tab.insertBefore(d, layers); } else { tab.appendChild(d); }
        S.sec = d;
        d.open = lsGet(LS_OPEN) === '1';
        d.addEventListener('toggle', function () { lsSet(LS_OPEN, d.open ? '1' : '0'); tick(); });
        build();
        return true;
    }
    function init() {
        if (!mount()) { return; }
        S.timer = setInterval(tick, 1000);
        document.addEventListener('visibilitychange', tick);
        document.addEventListener('rosconnected', function () { unsubscribe(); S.ros = null; tick(); });
        // a layer changed elsewhere (Map › Display, the layers button, the editor)
        document.addEventListener('vt:map-sources', function () { if (S.want) { paintMap(); } });
        ['change', 'input'].forEach(function (ty) {
            document.addEventListener(ty, function (e) {
                var id = e.target && e.target.id;
                if (S.want && id && id.indexOf('mapv3_') === 0) { paintMap(); }
            }, true);
        });
        document.addEventListener('keydown', function (e) {
            if (S.flow && e.key === 'Escape' && S.sec.contains(document.activeElement)) { closeFlow(true); }
        });
        if (root.VTI18n && VTI18n.onChange) { VTI18n.onChange(function () { labels(); paint(); paintParams(true); }); }
        tick();
    }

    api._S = S;
    api.paint = paint;
    api.showCand = showCand;
    root.VTTerrainPanel = api;
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})(typeof window !== 'undefined' ? window : this);
