// mapedit_ui.js — the parts of the map editor panel that are lists and small
// reports: the one object list (search + type filter), history, suggestions,
// layers panel with legends, and the undo toast. No tool logic: mapedits.js says
// what to show and gets the actions back through `api`.
window.MapEditPanel = (function () {
    'use strict';
    var MO = window.VTMapObjects;
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tn(k, n, v) { return window.VTI18n ? VTI18n.tn(k, n, v) : k; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function $(id) { return document.getElementById(id); }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

    var api = null;
    var FILTER_KEY = 'vitulus_editor_filter';
    var _rows = [], _query = '', _filter = lsGet(FILTER_KEY) || 'all';

    // ---- undo toast: every delete is immediate, this is the way back
    var _toastTimer = null, TOAST_MS = 9000;
    function hideToast() {
        var el = $('mapedit_toast');
        if (el) el.classList.remove('on');
        if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    }
    function toast(text, undo) {
        var el = $('mapedit_toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mapedit_toast';
            el.setAttribute('role', 'status');
            document.body.appendChild(el);
        }
        el.innerHTML = '<span class="mapedit-toast-txt">' + esc(text) + '</span>' +
            (undo ? '<button type="button" class="btn btn-outline-info">' + esc(t('medits.undo')) + '</button>' : '');
        if (undo) el.querySelector('button').addEventListener('click', function () { hideToast(); undo(); });
        el.classList.add('on');
        if (_toastTimer) clearTimeout(_toastTimer);
        _toastTimer = setTimeout(hideToast, TOAST_MS);
    }

    // ---- the one object list
    var FILTERS = ['all', 'zone', 'waypoint', 'path', 'place', 'landmark', 'nogo', 'slow', 'noblade', 'corridor', 'obstacle', 'free', 'wall'];
    function buildFilter() {
        var sel = $('mapedit_obj_filter');
        if (!sel) return;
        sel.innerHTML = FILTERS.map(function (f) {
            return '<option value="' + f + '"' + (f === _filter ? ' selected' : '') + '>' +
                esc(t(f === 'all' ? 'medits.filter.all' : 'medits.kind.' + f)) + '</option>';
        }).join('');
    }
    function renderList(rows) {
        if (rows) _rows = rows;
        var host = $('mapedit_obj_list');
        if (!host) return;
        var shown = _rows.filter(function (r) { return MO.matches(r, _query, _filter); });
        var cnt = $('mapedit_obj_count');
        if (cnt) cnt.textContent = (shown.length === _rows.length) ? String(_rows.length) : shown.length + ' / ' + _rows.length;
        if (!shown.length) {
            host.innerHTML = '<div class="vt-fs-sm vt-muted vt-pad-s">' + esc(t(_rows.length ? 'medits.list.nothing' : 'medits.list.empty')) + '</div>';
            return;
        }
        var scroll = host.scrollTop;
        host.innerHTML = shown.map(function (r) {
            var tt = MO.TYPES[r.type] || {};
            var inner = '<i class="la ' + (tt.ico || 'la-square') + ' mapedit-ico" data-type="' + esc(r.type) + '"></i>' +
                '<span class="text-truncate vt-grow1 vt-min0' + (r.dim ? ' vt-muted' : '') + '" title="' + esc(r.name) + '">' + esc(r.name || t('medits.unnamed')) + '</span>';
            if (r.state && r.state !== 'active') inner += '<span class="vt-pill" data-state="off">' + esc(t('medits.state.' + r.state)) + '</span>';
            else if (r.temporary) inner += '<span class="vt-pill" data-state="info">' + esc(t('medits.state.temporary')) + '</span>';
            inner += '<span class="mapedit-row-meta vt-muted">' + esc(r.meta || '') + '</span>';
            if (r.type === 'path') {
                inner += '<button class="btn btn-outline-secondary mapedit-path-vis" data-n="' + esc(r.name) + '" type="button" title="' + esc(t('medits.path_vis')) +
                    '" aria-label="' + esc(t('medits.path_vis')) + '"><i class="la ' + (r.dim ? 'la-eye-slash' : 'la-eye') + '"></i></button>';
            }
            return api.rowHtml(r.kind, r.name, inner);
        }).join('');
        host.scrollTop = scroll;
        host.querySelectorAll('.mapedit-path-vis').forEach(function (b) {
            b.addEventListener('click', function () { api.togglePath(b.getAttribute('data-n')); });
        });
        api.markRows();
    }

    // ---- history: who changed what
    function clock(ts) {
        var d = new Date(ts * 1000), now = new Date();
        var hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { day: 'numeric', month: 'numeric' }) + ' ' + hm;
    }
    var ACTOR_STATE = { owner: 'info', agent: 'brand', robot: 'ok' };
    function renderHistory() {
        var host = $('mapedit_history');
        if (!host) return;
        var h = MO.state.history;
        if (!MO.live() && !h) { host.innerHTML = '<div class="vt-empty">' + esc(t('medits.hist.offline')) + '</div>'; return; }
        var e = (h && h.entries) || [];
        if (!e.length) { host.innerHTML = '<div class="vt-empty">' + esc(t('medits.hist.empty')) + '</div>'; return; }
        host.innerHTML = '<ul class="vt-acts">' + e.slice().reverse().map(function (x) {
            var actor = ACTOR_STATE[x.actor] ? x.actor : 'unknown';
            return '<li class="vt-act mapedit-hist" data-state="' + (ACTOR_STATE[x.actor] || 'off') + '"><span class="vt-sdot"></span>' +
                '<span class="vt-act-txt"><b>' + esc(t('medits.actor.' + actor)) + '</b> ' +
                esc(t('medits.op.' + (x.op === 'undo' || x.op === 'redo' || x.op === 'delete' || x.op === 'save' ? x.op : 'update'), { name: x.name || '' })) + '</span>' +
                '<span class="vt-act-time">' + esc(x.ts ? clock(x.ts) : '') + '</span></li>';
        }).join('') + '</ul>';
    }

    // ---- suggestions of the robot
    function renderSuggestions() {
        var host = $('mapedit_sugg');
        if (!host) return;
        var open = (MO.state.suggestions || []).filter(function (s) { return s.state === 'new' || !s.state; });
        var cnt = $('mapedit_sugg_count');
        if (cnt) cnt.textContent = open.length ? String(open.length) : '';
        if (!open.length) { host.innerHTML = '<div class="vt-empty">' + esc(t('medits.sugg.empty')) + '</div>'; api.onSuggestions(open); return; }
        host.innerHTML = open.map(function (s) {
            return '<div class="mapedit-sugg" data-id="' + esc(s.id) + '">' +
                '<div class="vt-grow1 vt-min0"><div>' + esc(t('medits.sugg.kind.' + (s.kind === 'landmark' ? 'landmark' : 'obstacle'))) + '</div>' +
                '<div class="vt-fs-xs vt-muted">' + esc(t('medits.sugg.seen', { m: Number(s.size_m || 0).toFixed(1), n: s.seen || 0 })) + '</div></div>' +
                '<button class="btn btn-outline-info btn-sm" type="button" data-act="accept">' + esc(t('medits.sugg.accept')) + '</button>' +
                '<button class="btn btn-outline-secondary btn-sm" type="button" data-act="ignore">' + esc(t('medits.sugg.ignore')) + '</button></div>';
        }).join('');
        host.querySelectorAll('.mapedit-sugg').forEach(function (row) {
            var id = row.getAttribute('data-id');
            row.addEventListener('click', function (ev) {
                var b = ev.target.closest('button');
                if (b) api.suggestion(id, b.getAttribute('data-act')); else api.frameSuggestion(id);
            });
        });
        api.onSuggestions(open);
    }

    // ---- layers panel
    var GROUPS = [
        { k: 'medits.layers.objects', rows: ['waypoints', 'paths', 'edits', 'zones', 'places'] },
        { k: 'medits.layers.world', rows: ['coverage', 'mow_load', 'grass', 'gnss', 'slope', 'terrain', 'aerial'] },
    ];
    function renderLayers() {
        var host = $('mapedit_layers');
        if (!host) return;
        host.innerHTML = GROUPS.map(function (g) {
            return '<div class="mapedit-lay-head">' + esc(t(g.k)) + '</div>' + g.rows.map(function (k) {
                var on = api.layerOn(k);
                return '<label class="mapedit-lay" for="mapedit_lay_' + k + '"><input class="form-check-input" type="checkbox" id="mapedit_lay_' + k + '"' +
                    (on ? ' checked' : '') + ' data-layer="' + k + '"><span class="vt-grow1">' + esc(t('medits.layer.' + k)) + '</span></label>' +
                    '<div class="mapedit-legend" id="mapedit_legend_' + k + '">' + legendHtml(k, on) + '</div>' +
                    (k === 'aerial' ? overlayRowsHtml() : '');
            }).join('');
        }).join('');
        if (window.VTMowTrail) VTMowTrail.renderPanels();
        host.querySelectorAll('[data-layer]').forEach(function (c) {
            c.addEventListener('change', function () {
                var k = c.getAttribute('data-layer');
                api.setLayer(k, c.checked);
                setLegend(k);
            });
        });
        wireMapSources(host);
        host._msSig = mapSourcesSig();
    }
    // ---- map sources (Map tab controls are the single truth: these mirror
    // #mapv3_aerial_src and the #mapv3_ov_<id> checkboxes of mapping.js)
    function overlayRowsHtml() {
        var rows = document.querySelectorAll('#mapv3_overlays [data-ov]');
        if (!rows.length) return '';
        return '<div class="mapedit-lay-head">' + esc(t('medits.layer.overlays')) + '</div>' +
            Array.prototype.map.call(rows, function (r) {
                var id = r.getAttribute('data-ov'), c = $('mapv3_ov_' + id), lab = $('mapv3_ov_' + id + '_lab');
                var op = $('mapv3_ov_' + id + '_op'), name = lab ? lab.textContent : id;
                return '<label class="mapedit-lay" for="mapedit_ov_' + esc(id) + '"><input class="form-check-input" type="checkbox" id="mapedit_ov_' +
                    esc(id) + '" data-ovl="' + esc(id) + '"' + (c && c.checked ? ' checked' : '') + '><span class="vt-grow1">' +
                    esc(name) + '</span></label>' +
                    // T17 M5-2: the overlay's opacity here too (mirrors #mapv3_ov_<id>_op)
                    (op ? '<div class="vt-lyr-op mapedit-ovop" data-ovop-row="' + esc(id) + '"' + (c && c.checked ? '' : ' hidden') + '>' +
                        '<span class="vt-lyr-op-l">' + esc(t('mapt.opacity')) + '</span>' +
                        '<input type="range" min="0" max="1" step="0.05" value="' + esc(op.value) + '" data-ovop="' + esc(id) + '" aria-label="' +
                        esc(t('mapt.aerial.ov_opacity', {name: name})) + '">' +
                        '<output class="vt-lyr-op-v vt-tnum">' + Math.round(parseFloat(op.value) * 100) + '\u00a0%</output></div>' : '');
            }).join('');
    }
    function baseSelectHtml() {
        var src = $('mapv3_aerial_src');
        if (!src) return '';
        return '<label class="vt-muted" for="mapedit_base">' + esc(t('medits.legend.base')) + '</label> ' +
            '<select class="form-select form-select-sm" id="mapedit_base">' +
            // same options and groups (optgroup) as the Map tab picker
            Array.prototype.map.call(src.children, function (n) {
                var one = function (o) {
                    return '<option value="' + esc(o.value) + '"' + (o.value === src.value ? ' selected' : '') + '>' + esc(o.textContent) + '</option>';
                };
                if (n.tagName === 'OPTGROUP') {
                    return '<optgroup label="' + esc(n.label) + '">' + Array.prototype.map.call(n.children, one).join('') + '</optgroup>';
                }
                return one(n);
            }).join('') + '</select>';
    }
    function wireMapSources(host) {
        var b = host.querySelector('#mapedit_base');
        if (b) b.addEventListener('change', function () {
            var src = $('mapv3_aerial_src');
            if (src) { src.value = b.value; src.dispatchEvent(new Event('change')); }
        });
        host.querySelectorAll('[data-ovl]').forEach(function (c) {
            c.addEventListener('change', function () {
                var m = $('mapv3_ov_' + c.getAttribute('data-ovl'));
                if (m) { m.checked = c.checked; m.dispatchEvent(new Event('change')); }
            });
        });
        host.querySelectorAll('[data-ovop]').forEach(function (r) {
            r.addEventListener('input', function () {
                var m = $('mapv3_ov_' + r.getAttribute('data-ovop') + '_op');
                if (m) { m.value = r.value; m.dispatchEvent(new Event('input')); }
                var o = r.parentNode.querySelector('output');
                if (o) o.textContent = Math.round(parseFloat(r.value) * 100) + '\u00a0%';
            });
        });
    }
    // which bases / overlays exist and their names (a new catalog or language =
    // re-render); toggles and the
    // chosen base are NOT part of it — those are synced in place
    function mapSourcesSig() {
        // labels count too: the Map tab relabels its picker on a language
        // switch AFTER this panel re-rendered (VTI18n.onChange order), and
        // its 'vt:map-sources' event must then re-render the copy here
        var src = $('mapv3_aerial_src');
        return (src ? Array.prototype.map.call(src.querySelectorAll('optgroup, option'), function (o) {
            return o.tagName === 'OPTGROUP' ? '[' + o.label + ']' : o.value + '=' + o.textContent;
        }).join(',') : '') + '|' +
            Array.prototype.map.call(document.querySelectorAll('#mapv3_overlays [data-ov]'), function (r) {
                var id = r.getAttribute('data-ov'), lab = $('mapv3_ov_' + id + '_lab');
                return id + '=' + (lab ? lab.textContent : '');
            }).join(',');
    }
    // Map tab changed a source: mirror it here without re-rendering the panel
    // (keeps focus and scroll); re-render only when the set of sources changed.
    function syncMapSources() {
        var host = $('mapedit_layers');
        if (!api || !host) return;
        if (host._msSig !== mapSourcesSig()) { renderLayers(); return; }
        host.querySelectorAll('[data-ovl]').forEach(function (c) {
            var m = $('mapv3_ov_' + c.getAttribute('data-ovl'));
            if (m && c.checked !== m.checked) c.checked = m.checked;
        });
        host.querySelectorAll('[data-ovop-row]').forEach(function (row) {
            var id = row.getAttribute('data-ovop-row'), c = $('mapv3_ov_' + id), m = $('mapv3_ov_' + id + '_op');
            row.hidden = !(c && c.checked);
            var r = row.querySelector('input');
            if (r && m && document.activeElement !== r && r.value !== m.value) {
                r.value = m.value;
                var o = row.querySelector('output');
                if (o) o.textContent = Math.round(parseFloat(m.value) * 100) + '\u00a0%';
            }
        });
        // the background on / off (the layers button on the map changes it too)
        var la = $('mapedit_lay_aerial');
        if (la && la.checked !== api.layerOn('aerial')) { la.checked = api.layerOn('aerial'); setLegend('aerial'); }
        var b = $('mapedit_base'), src = $('mapv3_aerial_src');
        if (b && src && b.value !== src.value) b.value = src.value;
    }
    document.addEventListener('vt:map-sources', syncMapSources);
    // an opacity moved in the Map tab or the layers button: mirror it here
    document.addEventListener('input', function (e) {
        var id = e.target && e.target.id;
        if (id && /^mapv3_ov_.+_op$/.test(id) && $('mapedit_layers')) syncMapSources();
    }, true);
    function legendHtml(k, on) {
        if (!on) return '';
        var msg = api.layerMsg(k);
        if (k === 'mow_load') return window.VTMowTrail ? VTMowTrail.panelHost() : '';
        if (k === 'aerial') return baseSelectHtml();
        if (k === 'terrain') return '<span class="mapedit-swatch vt-sw-terrain-grad"></span> ' + esc(t('medits.legend.terrain'));
        if (k !== 'coverage' && k !== 'gnss' && k !== 'slope' && k !== 'grass') return '';
        var stops = msg && msg.legend && msg.legend.stops;
        if (!msg || !msg.w || !stops) return '<span class="vt-muted">' + esc(t(k === 'grass' ? 'medits.layer.grass_none' : 'medits.layer.no_data')) + '</span>';
        // grass: classes against the cut height, translated by their key
        var title = k === 'grass' && msg.legend.cut_mm != null ? t('medits.legend.grass_title', { cut: msg.legend.cut_mm }) : msg.legend.title;
        return (title ? '<div class="vt-muted">' + esc(title) + '</div>' : '') + stops.map(function (s) {
            var lab = k === 'grass' && s.key ? t('medits.legend.grass.' + s.key) : s.label;
            return '<span class="mapedit-stop"><i style="background:' + esc(/^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : '#888') + '"></i>' + esc(lab) + '</span>';
        }).join('');
    }
    function setLegend(k) {
        var el = $('mapedit_legend_' + k);
        if (el) el.innerHTML = legendHtml(k, api.layerOn(k));
        if (el && k === 'aerial') wireMapSources(el);
        if (k === 'mow_load' && window.VTMowTrail) VTMowTrail.renderPanels();
    }

    function init(a) {
        api = a;
        var q = $('mapedit_obj_search'), f = $('mapedit_obj_filter');
        buildFilter();
        if (q) q.addEventListener('input', function () { _query = q.value; renderList(); });
        if (f) f.addEventListener('change', function () { _filter = f.value; lsSet(FILTER_KEY, _filter); renderList(); });
        renderLayers();
        renderHistory();
        renderSuggestions();
    }
    function onLang() {
        if (!api) return;
        buildFilter(); renderList(); renderLayers(); renderHistory(); renderSuggestions();
    }
    return {
        init: init, onLang: onLang, toast: toast, hideToast: hideToast, renderList: renderList,
        renderHistory: renderHistory, renderSuggestions: renderSuggestions, renderLayers: renderLayers, setLegend: setLegend,
    };
})();
