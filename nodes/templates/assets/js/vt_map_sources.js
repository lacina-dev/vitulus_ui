/* vt_map_sources.js — the MapProxy map sources the Map tab and the map editor
 * offer (base maps under the map + transparent overlays on top).
 *
 * ONE place for the list: ui_sources.json beside mapproxy.yaml in the
 * docker-mapproxy repo, served by the webnode as GET /api/map_sources. A new
 * MapProxy layer therefore needs only a new entry there, no UI change. Why
 * not WMTS GetCapabilities: it has no en/cs names, no base/overlay kind, no
 * credits and no "useful zoom" range, and it lists every MapProxy layer
 * including test ones.
 *
 * This file is pure (no DOM, no ROS): it validates the catalog, keeps a
 * built-in fallback (the three sources the UI had before, so the map still
 * works when the catalog is missing), maps old stored choices onto the new
 * ids and builds tile URLs and credit lines. mapping.js does the drawing.
 * Node test: tools/test_map_sources.node.js.
 */
(function (root) {
    'use strict';

    // the sources the UI had before the catalog (same ids, so stored choices
    // and the robot-side alignment offsets keep working)
    var FALLBACK = {
        default_base: 'sat',
        sources: [
            { id: 'sat', kind: 'base', group: 'photo', layer: 'gm_layer', grid: 'gm_grid', format: 'png',
              name: { en: 'Satellite (Google)', cs: 'Satelit (Google)' }, max_zoom: 21,
              attribution: 'Imagery © Google' },
            { id: 'cuzk', kind: 'base', group: 'photo', layer: 'cuzk_layer', grid: 'gm_grid', format: 'png',
              name: { en: 'Orthophoto ČÚZK', cs: 'Ortofoto ČÚZK' }, max_zoom: 21,
              attribution: '© ČÚZK' },
            { id: 'osm', kind: 'base', group: 'map', layer: 'osm_demo', grid: 'webmercator', format: 'png',
              name: { en: 'OpenStreetMap', cs: 'OpenStreetMap' }, max_zoom: 19,
              attribution: '© OpenStreetMap contributors' },
        ],
    };
    // older stored values (labels / MapProxy layer names) -> source id
    var ALIASES = { satellite: 'sat', google: 'sat', gm_layer: 'sat', cuzk_layer: 'cuzk',
                    osm_demo: 'osm', 'čúzk orto': 'cuzk' };
    var ID_RE = /^[a-z0-9_]{1,40}$/;
    var NAME_RE = /^[A-Za-z0-9_]{1,80}$/;
    var MAX_Z = 21;   // gm_grid has 22 levels (z0-z21)
    // base map groups of the source picker (catalog "group"), in this order;
    // a base without a known group goes last, outside any group
    var GROUPS = ['photo', 'map'];
    // T17 M2: how an overlay is drawn, when the catalog entry does not say
    // (catalog fields blend / blend_neutral / recolor / halo win):
    //  - blend 'multiply' (default for layer_order 'under'): the tile darkens
    //    or tints what is under it (background AND robot map) instead of
    //    covering it; blend_neutral = the source's flat-ground colour (0-1),
    //    which then leaves the picture unchanged; blend_gain (1-4) deepens the
    //    shading (2 for the relief: a garden's slopes are shallow, at 1 and the
    //    default 50 % opacity it hardly showed). Measured on ČÚZK DMR 5G tiles
    //    (park and villa test points): relief median grey 0.70-0.73, slope
    //    flat colour about (0.95, 0.93, 0.78).
    //  - recolor '#rrggbb': the pure-red part of the drawing gets this colour;
    //    halo: a thin dark edge around the lines. Only when the catalog asks
    //    (owner 2026-11-08: line overlays look as before, no built-in default).
    var STYLE_DEFAULTS = {
        hillshade: { blend_neutral: [0.72, 0.72, 0.72], blend_gain: 2 },
        slope: { blend_neutral: [0.95, 0.93, 0.78] },
    };
    var HEX_RE = /^#[0-9a-fA-F]{6}$/;

    function num(v, dflt, lo, hi) {
        var n = typeof v === 'number' ? v : parseFloat(v);
        if (!isFinite(n)) { return dflt; }
        return Math.max(lo, Math.min(hi, n));
    }

    function one(s) {
        if (!s || typeof s !== 'object') { return null; }
        var id = String(s.id || '');
        if (!ID_RE.test(id) || !NAME_RE.test(String(s.layer || '')) ||
            !NAME_RE.test(String(s.grid || ''))) { return null; }
        var kind = s.kind === 'overlay' ? 'overlay' : 'base';
        var name = s.name;
        if (typeof name === 'string') { name = { en: name }; }
        if (!name || typeof name !== 'object' || !name.en) { name = { en: id }; }
        var maxZ = Math.round(num(s.max_zoom, 19, 0, MAX_Z));
        var off = String(s.offset_key || id);
        // credit: a string, or {en, cs} when it has words to translate
        var at = s.attribution;
        if (at && typeof at === 'object') {
            at = at.en ? { en: String(at.en), cs: String(at.cs || at.en) } : null;
        } else {
            at = at ? { en: String(at), cs: String(at) } : null;
        }
        var out = {
            id: id,
            kind: kind,
            // bases only: 'photo' (aerial/satellite) | 'map' (drawn) | ''
            group: (kind === 'base' && GROUPS.indexOf(s.group) >= 0) ? s.group : '',
            layer: String(s.layer),
            grid: String(s.grid),
            format: s.format === 'jpeg' ? 'jpeg' : 'png',
            name: { en: String(name.en), cs: name.cs ? String(name.cs) : String(name.en) },
            max_zoom: maxZ,
            min_zoom: Math.round(num(s.min_zoom, 0, 0, maxZ)),
            default_opacity: num(s.default_opacity, kind === 'overlay' ? 0.7 : 1, 0, 1),
            attribution: at,
            // overlays: 'under' = a tone (relief, slope), multiplied over the
            // background and the robot's maps (T17 M2-2: before, it lay under
            // the robot's map fill and was not seen inside the garden);
            // 'over' = lines ON TOP of them
            layer_order: (kind === 'overlay' && s.layer_order === 'under') ? 'under' : 'over',
            offset_key: ID_RE.test(off) ? off : id,
        };
        if (kind === 'overlay') { style(out, s); }
        // T20 E2: an overlay with time frames (the robot's precip-mosaic
        // service): {port} of the service on the robot; mapping.js then takes
        // the tiles from it frame by frame (vt_precip.js) and this MapProxy
        // layer is only the fallback ("latest")
        if (kind === 'overlay' && s.timeline && typeof s.timeline === 'object') {
            out.timeline = { port: Math.round(num(s.timeline.port, 8097, 1, 65535)) };
        }
        return out;
    }

    // the overlay look (T17 M2), see STYLE_DEFAULTS
    function style(out, s) {
        var d = STYLE_DEFAULTS[out.id] || {};
        var pick = function (k) { return (s[k] !== undefined && s[k] !== null) ? s[k] : d[k]; };
        var b = pick('blend');
        out.blend = (b === 'multiply' || b === 'normal') ? b
                  : (out.layer_order === 'under' ? 'multiply' : 'normal');
        var n = pick('blend_neutral');
        if (typeof n === 'number' || typeof n === 'string') { n = [n, n, n]; }
        out.blend_neutral = (Array.isArray(n) && n.length === 3)
            ? n.map(function (v) { return num(v, 1, 0.05, 1); }) : [1, 1, 1];
        var r = pick('recolor');
        out.recolor = (typeof r === 'string' && HEX_RE.test(r)) ? r.toLowerCase() : '';
        out.blend_gain = num(pick('blend_gain'), 1, 1, 4);
        out.halo = pick('halo') === true;
    }

    // catalog JSON -> {bases, overlays, byId, default_base, fromCatalog}
    function normalize(j) {
        var list = (j && Array.isArray(j.sources)) ? j.sources : [];
        var out = { bases: [], overlays: [], byId: {}, default_base: 'sat', fromCatalog: true };
        list.forEach(function (raw) {
            var s = one(raw);
            if (!s || out.byId[s.id]) { return; }
            out.byId[s.id] = s;
            (s.kind === 'overlay' ? out.overlays : out.bases).push(s);
        });
        if (!out.bases.length) {
            out = normalize(FALLBACK);
            out.fromCatalog = false;
            return out;
        }
        var d = j && j.default_base;
        out.default_base = (d && out.byId[d] && out.byId[d].kind === 'base') ? d : out.bases[0].id;
        return out;
    }

    function fallback() {
        var c = normalize(FALLBACK);
        c.fromCatalog = false;
        return c;
    }

    // the base to show for a stored value (old values are mapped, unknown -> default)
    function resolveBase(cat, stored) {
        var v = stored == null ? '' : String(stored);
        var ok = function (id) { return cat.byId[id] && cat.byId[id].kind === 'base'; };
        if (ok(v)) { return v; }
        var a = ALIASES[v.toLowerCase()];
        if (a && ok(a)) { return a; }
        return cat.default_base;
    }

    // the bases split for the picker: [{group, sources}] in GROUPS order, the
    // ungrouped ones last (group ''); empty groups left out. One entry with
    // group '' = a catalog without groups (plain list).
    function baseGroups(cat) {
        var out = [];
        GROUPS.concat(['']).forEach(function (g) {
            var list = ((cat && cat.bases) || []).filter(function (b) { return b.group === g; });
            if (list.length) { out.push({ group: g, sources: list }); }
        });
        return out;
    }

    function label(src, lang) {
        if (!src) { return ''; }
        return (lang && src.name[lang]) || src.name.en || src.id;
    }

    function tileUrl(host, src, z, x, y) {
        return 'http://' + host + '/wmts/' + src.layer + '/' + src.grid + '/' +
               z + '/' + x + '/' + y + '.' + src.format;
    }

    // credit line for the layers on screen (in the UI language), each once
    function attribution(srcs, lang) {
        var seen = {}, out = [];
        (srcs || []).forEach(function (s) {
            var a = s && s.attribution && ((lang && s.attribution[lang]) || s.attribution.en);
            if (a && !seen[a]) { seen[a] = true; out.push(a); }
        });
        return out.join(' · ');
    }

    var api = { FALLBACK: FALLBACK, ALIASES: ALIASES, GROUPS: GROUPS, STYLE_DEFAULTS: STYLE_DEFAULTS, normalize: normalize,
                fallback: fallback, resolveBase: resolveBase, baseGroups: baseGroups, label: label,
                tileUrl: tileUrl, attribution: attribution };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.VTMapSources = api; }
})(typeof window !== 'undefined' ? window : null);
