/* vt_map_layers.js — the layers button ON the map (T17 M5, 2026-11-08).
 *
 * A round button under the compass rose in the map's top-left corner opens
 * a small panel (a sheet at the bottom on a phone, a card beside the button
 * on a wider screen): the background map in two groups (photos / maps) plus
 * None, its opacity, the overlays from the catalog (lines and labels, terrain
 * tones) each with its own opacity, a hint and the slope legend, and the rain
 * radar. Before, changing the background on a phone took 5–6 steps deep in
 * the Map panel (map_audit.md M5-1); now it is two taps.
 *
 * ONE place of truth: the Map tab controls of mapping.js (#mapv3_chk_aerial,
 * #mapv3_aerial_src, #mapv3_aerial_opacity, #mapv3_ov_<id>[_op],
 * #mapv3_chk_rain, #mapv3_rain_opacity). This panel only mirrors them: a tap
 * here sets the Map tab control and fires its own 'change' / 'input' event,
 * so mapping.js stores the choice, rebuilds the tiles and tells the map
 * editor ('vt:map-sources'); a change made in the Map tab or in the editor
 * shows here at once (capture listener + 'vt:map-sources').
 *
 * "New" marks: sources the browser has not seen in this panel yet (stored
 * ids in localStorage vitulus_layers_seen; the first time the sources of
 * batch M1 count as seen) get a small "new" tag and the button a
 * dot, until the panel is closed once.
 *
 * Pure UI: no ROS, no HTTP, nothing goes to the robot.
 */
(function () {
    'use strict';

    var LS_SEEN = 'vitulus_layers_seen';
    // the sources of batch M1 (docker-mapproxy 5b6240f) count as known: "new"
    // is for what came after (Wayback, CENIA, relief x10/x20, aspect, DMP …)
    var OLD_IDS = ['sat', 'sat_hybrid', 'cuzk', 'esri', 'bing', 'gmap', 'ztm', 'otm', 'osm',
                   'kn', 'ruian', 'contours', 'hillshade', 'slope'];
    // catalog overlays that are weather (shown under Weather beside the ČHMÚ
    // radar): the precipitation mosaic of T20 and anything marked so
    function isWeather(o) { return o.id === 'precip' || o.group === 'weather' || !!o.timeline; }
    var PHONE_MAX_W = 576;                     // vt_frame.js SHEET_MAX_W
    var SHEET_PART = 0.62;                     // phone: at most this much of the map hollow
    // overlays with a short hint (i18n maplyr.hint.<id>); a new catalog id
    // without one just shows its name
    var HINTS = ['kn', 'ruian', 'contours', 'hillshade', 'relief_x10', 'relief_x20', 'slope', 'aspect', 'surface_relief', 'precip'];
    // ČÚZK DMR 5G SlopeRGBMap colour map (REST legend of the image service,
    // sampled 2026-11-08): grey = flat, yellow, orange, brown = steep
    var SLOPE_STOPS = ['#d1d1d1', '#fffac2', '#ffff00', '#ffbe00', '#fe7200', '#a24a1b'];
    // T17 M8-6: ČÚZK DMR 5G AspectRGBMap — the colour of a slope facing N, NE,
    // E … NW, sampled around the cone of the hill Říp (public point, z16,
    // map_audit2.md 1.3); the legend is a colour wheel with the four letters
    var ASPECT_STOPS = ['#8ad317', '#04a152', '#046bb5', '#5511a3', '#9d039c', '#fa7158', '#fbaa48', '#f8f40c'];
    // T17 M8-3: the base thumbnails show the real map around the view centre:
    // one tile at this zoom (or the source's max), at half size (the 32 px
    // inside of the 34 px thumbnail with its 1 px border covers ~64 tile px,
    // ~50 m of ground at 50° N)
    var THUMB_Z = 17, THUMB_SCALE = 0.5, THUMB_PX = 32;
    var ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
        '<path d="M12 3 2 8l10 5 10-5-10-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
        '<path d="m2 12 10 5 10-5M2 16l10 5 10-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

    function $(id) { return document.getElementById(id); }
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function lang() { return (window.VTI18n && VTI18n.lang && VTI18n.lang()) || 'en'; }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function pct(v) { return Math.round((parseFloat(v) || 0) * 100) + '\u00a0%'; }
    function cssPx(cs, k, d) { var v = parseFloat(cs.getPropertyValue(k)); return isFinite(v) ? v : d; }

    // the catalog mapping.js uses (fallback list until it is there)
    function catalog() {
        var M = window.mapping_v3;
        if (M && M.map_sources) { return M.map_sources; }
        return window.VTMapSources ? VTMapSources.fallback() : null;
    }
    // "Satellite (Google)" -> ["Satellite", "Google"]: the name big, the provider small
    function splitName(s) {
        var m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(s);
        var out = m && m[1] ? [m[1], m[2]] : [s, ''];
        // a date like 2025-04 never breaks at its hyphen
        return out.map(function (x) { return x.replace(/(\d)-(\d)/g, '$1\u2011$2'); });
    }

    // ---- state of the Map tab controls (the truth)
    function bgOn() { var c = $('mapv3_chk_aerial'); return !!(c && c.checked); }
    function baseId() { var s = $('mapv3_aerial_src'); return s ? s.value : ''; }
    function ovOn(id) { var c = $('mapv3_ov_' + id); return !!(c && c.checked); }
    function rainOn() { var c = $('mapv3_chk_rain'); return !!(c && c.checked); }
    function fire(el, type) { if (el) { el.dispatchEvent(new Event(type)); } }

    function setBase(id) {
        var s = $('mapv3_aerial_src'), c = $('mapv3_chk_aerial');
        if (s && s.value !== id) { s.value = id; fire(s, 'change'); }
        // the source first, then the layer: the build after the tick uses the new source
        if (c && !c.checked) { c.checked = true; fire(c, 'change'); }
        notifyEditor();
        sync();
    }
    function setBgOff() {
        var c = $('mapv3_chk_aerial');
        if (c && c.checked) { c.checked = false; fire(c, 'change'); }
        notifyEditor();
        sync();
    }
    function setChk(id, on) {
        var c = $(id);
        if (c && c.checked !== on) { c.checked = on; fire(c, 'change'); }
        sync();
    }
    function setRange(id, v) {
        var r = $(id);
        if (r) { r.value = String(v); fire(r, 'input'); }
    }
    // the background on/off is a Map tab layer without its own event to the
    // editor; its Layers panel listens to this one (mapedit_ui.js)
    function notifyEditor() {
        try { document.dispatchEvent(new CustomEvent('vt:map-sources')); } catch (e) { /* old browser */ }
    }

    // ---- "new" sources
    function seen() {
        var raw = lsGet(LS_SEEN), s = null;
        if (raw) { try { s = JSON.parse(raw); } catch (e) { s = null; } }
        if (!Array.isArray(s)) {
            s = OLD_IDS.slice();
            var b = baseId();
            if (b && s.indexOf(b) < 0) { s.push(b); }
            lsSet(LS_SEEN, JSON.stringify(s));
        }
        return s;
    }
    function allIds(cat) {
        return cat ? cat.bases.concat(cat.overlays).map(function (x) { return x.id; }) : [];
    }
    function newIds(cat) {
        if (!cat || !cat.fromCatalog) { return []; }
        var s = seen();
        return allIds(cat).filter(function (id) { return s.indexOf(id) < 0; });
    }
    function markSeen() {
        var cat = catalog();
        if (!cat || !cat.fromCatalog) { return; }
        var s = seen();
        allIds(cat).forEach(function (id) { if (s.indexOf(id) < 0) { s.push(id); } });
        lsSet(LS_SEEN, JSON.stringify(s));
        paintFab();
    }

    // ---- DOM
    var fab = null, panel = null, bodyEl = null, isOpen = false, sig = '', fresh = [], timer = null;

    function build() {
        if (fab) { return; }
        fab = document.createElement('button');
        fab.type = 'button';
        fab.id = 'vt_lyr_fab';
        fab.className = 'vt-lyr-fab';
        fab.setAttribute('aria-expanded', 'false');
        fab.setAttribute('aria-controls', 'vt_lyr_panel');
        fab.innerHTML = ICON + '<span class="vt-lyr-dot" hidden></span>';
        fab.addEventListener('click', function () { toggle(); });
        document.body.appendChild(fab);

        panel = document.createElement('div');
        panel.id = 'vt_lyr_panel';
        panel.className = 'vt-lyr-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'vt_lyr_title');
        panel.tabIndex = -1;
        panel.hidden = true;
        panel.innerHTML =
            '<div class="vt-lyr-head">' + ICON +
            '<span id="vt_lyr_title" class="vt-lyr-title"></span>' +
            '<span id="vt_lyr_meta" class="vt-lyr-meta"></span>' +
            '<button type="button" class="vt-lyr-iconbtn" data-lyr-help>?</button>' +
            '<button type="button" class="vt-lyr-iconbtn" data-lyr-close>&times;</button></div>' +
            '<div class="vt-lyr-body" id="vt_lyr_body"></div>';
        bodyEl = panel.querySelector('#vt_lyr_body');
        document.body.appendChild(panel);

        panel.addEventListener('click', onClick);
        panel.addEventListener('input', onInput);
        // T31: the mowed-area map picker
        panel.addEventListener('change', function (e) {
            var sel = e.target;
            if (sel && sel.hasAttribute && sel.hasAttribute('data-lyr-mpick') && window.VTTerrainMosaic && VTTerrainMosaic.pick) {
                VTTerrainMosaic.pick(sel.value);
            }
        });
        panel.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); close(true); return; }
            // focus inside this card: the arrows never drive (director 2026-11-08);
            // their own action (scrolling the card, a slider) stays
            if (/^Arrow/.test(e.key)) { e.stopPropagation(); }
            // arrows in the base radio group: move AND pick (as radios do)
            var el = e.target;
            if (!el || !el.hasAttribute || !el.hasAttribute('data-lyr-base')) { return; }
            var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            var list = Array.prototype.slice.call(panel.querySelectorAll('[data-lyr-base]'));
            var i = list.indexOf(el), j = -1;
            if (step) { j = (i + step + list.length) % list.length; }
            else if (e.key === 'Home') { j = 0; }
            else if (e.key === 'End') { j = list.length - 1; }
            if (j < 0) { return; }
            e.preventDefault();
            e.stopPropagation();      // these keys pick a map, they never drive (vt_joy.js)
            list[j].focus();
            setBase(list[j].getAttribute('data-lyr-base'));
        });
        // a tap outside closes (the tap still reaches the map)
        document.addEventListener('pointerdown', function (e) {
            if (!isOpen) { return; }
            if (panel.contains(e.target) || fab.contains(e.target)) { return; }
            close(false);
        }, true);
        document.addEventListener('keydown', function (e) {
            if (isOpen && e.key === 'Escape') { close(true); }
        });
        labels();
    }

    function labels() {
        if (!fab) { return; }
        fab.title = fab.classList.contains('vt-lyr-warn') ? t('maplyr.m8.btn_warn') : t('maplyr.btn_tip');
        fab.setAttribute('aria-label', t('maplyr.btn'));
        $('vt_lyr_title').textContent = t('maplyr.title');
        var h = panel.querySelector('[data-lyr-help]');
        h.title = t('common.help');
        h.setAttribute('aria-label', t('common.help'));
        var c = panel.querySelector('[data-lyr-close]');
        c.title = t('common.close');
        c.setAttribute('aria-label', t('common.close'));
    }

    function structSig(cat) {
        if (!cat) { return ''; }
        var l = lang();
        return l + '|' + cat.bases.map(function (b) { return b.id + ':' + b.group + ':' + VTMapSources.label(b, l); }).join(',') +
            '|' + cat.overlays.map(function (o) { return o.id + ':' + o.layer_order + ':' + VTMapSources.label(o, l); }).join(',') +
            '|' + (!!$('mapv3_chk_rain')) + '|' + (!!$('mapv3_chk_trav')) + '|' + (!!$('mapv3_chk_tmosaic')) + '|' + (!!$('mapv3_align_etrs')) + '|' + fresh.join(',');
    }

    function newTag(id) {
        return fresh.indexOf(id) >= 0
            ? '<span class="vt-lyr-new" title="' + esc(t('maplyr.new_tip')) + '">' + esc(t('maplyr.new')) + '</span>' : '';
    }

    function rangeHtml(target, name) {
        var r = $(target);
        var v = r ? r.value : '1';
        var lab = t('mapt.aerial.ov_opacity', { name: name });
        return '<div class="vt-lyr-op"><span class="vt-lyr-op-l">' + esc(t('mapt.opacity')) + '</span>' +
            '<input type="range" min="0" max="1" step="0.05" value="' + esc(v) + '" data-lyr-op="' + esc(target) + '" aria-label="' + esc(lab) + '">' +
            '<output class="vt-lyr-op-v vt-tnum" data-lyr-opv="' + esc(target) + '">' + pct(v) + '</output></div>';
    }

    function legendHtml(id) {
        if (id === 'slope') {
            return '<div class="vt-lyr-legend"><span class="vt-lyr-grad" style="background:linear-gradient(90deg,' + SLOPE_STOPS.join(',') + ')"></span>' +
                '<span class="vt-lyr-legend-l"><span>' + esc(t('maplyr.legend.flat')) + '</span><span>' + esc(t('maplyr.legend.steep')) + '</span></span></div>';
        }
        if (id === 'aspect') {
            // conic gradient from north, clockwise (as on a compass)
            var stops = ASPECT_STOPS.concat([ASPECT_STOPS[0]]).map(function (c, i) { return c + ' ' + (i * 45) + 'deg'; });
            var L = function (k, cls) { return '<span class="vt-lyr-asp-l ' + cls + '">' + esc(t('maplyr.m8.asp.' + k)) + '</span>'; };
            return '<div class="vt-lyr-legend vt-lyr-asp"><span class="vt-lyr-asp-w" role="img" aria-label="' + esc(t('maplyr.m8.asp.aria')) + '">' +
                '<span class="vt-lyr-asp-c" style="background:conic-gradient(' + stops.join(',') + ')"></span>' +
                L('n', 'is-n') + L('e', 'is-e') + L('s', 'is-s') + L('w', 'is-w') + '</span>' +
                '<span class="vt-lyr-asp-t">' + esc(t('maplyr.m8.asp.text')) + '</span></div>';
        }
        return '';
    }

    // ---- T17 M8-3: real thumbnails of the bases
    // The tile at zoom z under lon/lat and how to show it in a size x size box
    // at `scale` CSS px per tile px, the point in the middle as far as the
    // tile allows (no neighbour tiles: a point near a tile edge sits off-centre).
    // -> {z, x, y, bg: tile size (CSS px), px, py: background position}
    function thumbPlan(lon, lat, z, size, scale) {
        if (!isFinite(lon) || !isFinite(lat) || Math.abs(lat) > 85) { return null; }
        var n = Math.pow(2, z), latR = lat * Math.PI / 180;
        var fx = (lon + 180) / 360 * n;
        var fy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
        var x = Math.floor(fx), y = Math.floor(fy), bg = 256 * scale;
        var clamp = function (v) { return Math.max(size - bg, Math.min(0, v)); };
        return { z: z, x: x, y: y, bg: bg,
                 px: Math.round(clamp(size / 2 - (fx - x) * bg)), py: Math.round(clamp(size / 2 - (fy - y) * bg)) };
    }
    // the view centre in lon/lat (mapping.js datum + camera), or null
    function viewLonLat() {
        var M = window.mapping_v3, d = M && M.aerial_datum;
        var V = M && M.viewer3d, c = V && V.cameraControls && V.cameraControls.center;
        if (!d || d.origin_lat == null || d.origin_lon == null || !c || !window.VTMapThumbs) { return null; }
        try { return VTMapThumbs.mapToLonLat(d, c.x, c.y, null); } catch (e) { return null; }
    }
    // paint each base's thumbnail (only when its tile changed); the drawn
    // icon stays under it while the tile loads or when it cannot
    function paintThumbs() {
        var M = window.mapping_v3, cat = catalog(), ll = viewLonLat();
        if (!panel || !cat || !M || typeof M._aerialTileUrl !== 'function') { return; }
        panel.querySelectorAll('[data-lyr-base]').forEach(function (el) {
            var img = el.querySelector('.vt-lyr-thumb-img');
            var src = cat.byId[el.getAttribute('data-lyr-base')];
            if (!img || !src) { return; }
            var p = ll ? thumbPlan(ll.lon, ll.lat, Math.min(THUMB_Z, src.max_zoom || THUMB_Z), THUMB_PX, THUMB_SCALE) : null;
            var url = '';
            if (p) { try { url = M._aerialTileUrl(src, p.z, p.x, p.y); } catch (e) { url = ''; } }
            var key = url ? url + '|' + p.px + ',' + p.py : '';
            if (img.getAttribute('data-k') === key) { return; }
            img.setAttribute('data-k', key);
            if (!url) { img.style.backgroundImage = ''; return; }
            // CSS background: the same GET of the robot's MapProxy as the map
            // (browser cache shared), a failed tile just leaves the icon
            img.style.backgroundImage = 'url("' + url.replace(/["\\]/g, '') + '")';
            img.style.backgroundSize = p.bg + 'px ' + p.bg + 'px';
            img.style.backgroundPosition = p.px + 'px ' + p.py + 'px';
        });
    }

    // ---- T17 M8-2: the precipitation time line inside the panel
    // The one Timeline (vt_precip.js, mounted by mapping.js in #mapv3_precip
    // under the overlay's row in Map › Display) moves into the panel's
    // Precipitation row while the panel is open and the layer is on, and back
    // when the panel closes or redraws — one control, one state, two places.
    var tlHome = null;
    function tlEl() { return $('mapv3_precip'); }
    // the labels under the slider are placed for the width they had (the
    // panel is narrower than Map › Display): let the time line hide the one
    // that would run into "now" again, once the new width is laid out
    function tlRefit() {
        var go = function () {
            try { var P = window.mapping_v3 && window.mapping_v3._precip; if (P && P._fixTicks) { P._fixTicks(); } }
            catch (e) { /* the time line is not there yet */ }
        };
        if (window.requestAnimationFrame) { requestAnimationFrame(go); } else { go(); }
    }
    function tlDetach() {
        var el = tlEl();
        if (!el || !tlHome || !panel || !panel.contains(el)) { return; }
        if (tlHome.next && tlHome.next.parentNode === tlHome.parent) { tlHome.parent.insertBefore(el, tlHome.next); }
        else if (tlHome.parent) { tlHome.parent.appendChild(el); }
        tlRefit();
    }
    function tlAttach() {
        var el = tlEl();
        var slot = panel && panel.querySelector('[data-lyr-tl]');
        if (!el || !slot) { return; }
        var on = ovOn(slot.getAttribute('data-lyr-tl'));
        if (!on || panel.hidden) { tlDetach(); return; }
        if (slot.contains(el)) { return; }
        if (!panel.contains(el)) { tlHome = { parent: el.parentNode, next: el.nextSibling }; }
        slot.appendChild(el);
        tlRefit();
    }

    // T29: the terrain row — view buttons (only views with data), legend of
    // the view, the source when it is the fallback, the state sentence
    var travLegSig = '';
    function syncTrav() {
        var row = panel && panel.querySelector('[data-lyr-row="trav"]'), chk = $('mapv3_chk_trav');
        if (!row || !chk) { return; }
        var I = window.VTTerrain && VTTerrain.info ? VTTerrain.info()
            : { state: '', source: '', views: { reason: true, cost: true, height: false }, mode: 'reason' };
        row.querySelectorAll('[data-lyr-tmode]').forEach(function (b) {
            var m = b.getAttribute('data-lyr-tmode'), off = !I.views[m];
            b.setAttribute('aria-pressed', String(I.source === 'grid' ? m === 'cost' : I.mode === m));
            if (b.disabled !== off) { b.disabled = off; }
            b.title = off ? t(m === 'height' ? 'trav.view.height_off' : 'trav.view.grid_only') : '';
        });
        // the fallback grid has the cost only
        var mode = I.source === 'grid' ? 'cost' : I.mode;
        var leg = row.querySelector('[data-lyr-tleg]'), sig = mode + '|' + lang();
        if (leg && (travLegSig !== sig || !leg.firstChild)) { travLegSig = sig; leg.innerHTML = travLegendHtml(mode); }
        var src = row.querySelector('[data-lyr-tsrc]');
        if (src) {
            var sm = chk.checked && I.source === 'grid' ? t('trav.src.grid') : '';
            if (src.textContent !== sm) { src.textContent = sm; }
            src.hidden = !sm;
        }
        var st = row.querySelector('[data-lyr-tstat]');
        if (st) {
            var why = chk.checked && ['nodata', 'stale', 'noros', 'notf'].indexOf(I.state) >= 0 ? t('trav.why.' + I.state) : '';
            if (st.textContent !== why) { st.textContent = why; }
            st.hidden = !why;
        }
    }

    // T30: the mowed-area terrain row — views with data, legend, what map, state
    var mosLegSig = '';
    function syncMosaic() {
        var row = panel && panel.querySelector('[data-lyr-row="tmosaic"]'), chk = $('mapv3_chk_tmosaic');
        if (!row || !chk) { return; }
        var I = window.VTTerrainMosaic && VTTerrainMosaic.info ? VTTerrainMosaic.info()
            : { state: '', mode: 'cost', views: { cost: true, reason: true, height: false }, mosaic: null };
        row.querySelectorAll('[data-lyr-mmode]').forEach(function (b) {
            var m = b.getAttribute('data-lyr-mmode'), off = I.mosaic ? !I.views[m] : false;
            b.setAttribute('aria-pressed', String(I.mode === m));
            if (b.disabled !== off) { b.disabled = off; }
            b.title = off ? t(m === 'height' && I.mosaic && I.mosaic.files.elevation16 ? 'tmos.height_browser' : 'tmos.view_none') : '';
        });
        var prow = row.querySelector('[data-lyr-mpickrow]'), psel = row.querySelector('[data-lyr-mpick]'), list = I.list || [];
        if (prow && psel) {
            var psig = list.map(function (x) { return x.name + '@' + x.mtime; }).join('|') + '|' + lang();
            if (psel.getAttribute('data-sig') !== psig) {
                psel.setAttribute('data-sig', psig);
                var L = lang();
                psel.innerHTML = list.map(function (x) {
                    var d = new Date(x.mtime * 1000);
                    var when = d.toLocaleString(L === 'cs' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
                    return '<option value="' + esc(x.name) + '">' + esc(mosaicName(x) + ' · ' + when) + '</option>';
                }).join('');
            }
            if (I.mosaic && psel.value !== I.mosaic.name && document.activeElement !== psel) { psel.value = I.mosaic.name; }
            prow.hidden = !(chk.checked && list.length > 1);
        }
        var rg = I.hRange, sig = I.mode + '|' + lang() + '|' + (rg ? rg.lo + '-' + rg.hi : '');
        var leg = row.querySelector('[data-lyr-mleg]');
        if (leg && (mosLegSig !== sig || !leg.firstChild)) { mosLegSig = sig; leg.innerHTML = mosaicLegendHtml(I.mode, rg); }
        var inf = row.querySelector('[data-lyr-minfo]'), m = I.mosaic, txt = '';
        if (chk.checked && m) {
            var st = m.stats || {}, L = lang(), n = function (v, d) { var x = (+v).toFixed(d); return L === 'cs' ? x.replace('.', ',') : x; };
            txt = t('tmos.info', { name: mosaicName(m), area: st.area_known_m2 != null ? n(st.area_known_m2, 0) : '—',
                                   lethal: st.lethal_pct != null ? n(st.lethal_pct, 1) : '—' });
        }
        if (inf && inf.textContent !== txt) { inf.textContent = txt; }
        if (inf) { inf.hidden = !txt; }
        var ms = row.querySelector('[data-lyr-mstat]');
        if (ms) {
            var why = chk.checked && ['nomap', 'error'].indexOf(I.state) >= 0 ? t('tmos.why.' + I.state) : '';
            if (ms.textContent !== why) { ms.textContent = why; }
            ms.hidden = !why;
        }
    }
    // the robot's lasting map (terrain_recorder export) by its role, the others by name
    function mosaicName(m) { return m.source === 'terrain_recorder' ? t('tmos.recorder') : m.name; }
    function mosaicLegendHtml(mode, rg) {
        if (mode === 'reason') { return travLegendHtml('reason'); }
        if (mode === 'height') {
            var span = rg ? Math.max(1, Math.round((rg.hi - rg.lo) / 10)) : 0;     // mm -> cm
            return '<div class="vt-lyr-legend"><span class="vt-lyr-grad" style="background:linear-gradient(90deg,rgb(30,136,229),rgb(245,245,220),rgb(121,85,72))"></span>' +
                '<span class="vt-lyr-legend-l vt-tnum"><span>' + esc(t('tmos.leg.low')) + '</span><span>' + esc(t('tmos.leg.span', { cm: span })) +
                '</span><span>' + esc(t('tmos.leg.high')) + '</span></span></div>';
        }
        return '<div class="vt-lyr-legend"><span class="vt-lyr-grad" style="background:linear-gradient(90deg,#4caf50 0%,#ffeb3b 45%,#f44336 85%,#7f0000 86%,#7f0000 100%)"></span>' +
            '<span class="vt-lyr-legend-l"><span>' + esc(t('trav.leg.free')) + '</span><span>' + esc(t('trav.leg.hard')) + '</span><span>' +
            esc(t('trav.leg.lethal')) + '</span></span></div>';
    }

    // ---- T17 M8-5: is the background map loading? (mapping.js _baseLoad,
    // event 'vt:map-tiles'); 'none' = not one tile came (MapProxy / internet)
    function bgLoad() {
        var M = window.mapping_v3, s = M && M._baseLoad;
        return (bgOn() && s && s.state) ? s : null;
    }

    // ---- T29: the terrain layer's views and legends (vt_terrain_layer.js colours)
    function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a === undefined ? (c[3] / 255).toFixed(2) : a) + ')'; }
    function travModesHtml() {
        return '<div class="vt-lyr-tmodes" role="group" aria-label="' + esc(t('trav.view')) + '">' +
            ['cost', 'reason', 'height'].map(function (m) {      // the same order as the mowed-area layer
                return '<button type="button" class="vt-lyr-tmode" data-lyr-tmode="' + m + '" aria-pressed="false">' + esc(t('trav.mode.' + m)) + '</button>';
            }).join('') + '</div>';
    }
    function travLegendHtml(mode) {
        var V = window.VTTerrain;
        if (!V || !V.costColor) { return ''; }
        if (mode === 'cost') {
            var cs = [0, 25, 49, 50, 75, 99].map(function (c, i, a) { return rgba(V.costColor(c)) + ' ' + Math.round(i / a.length * 100) + '%'; });
            cs.push(rgba(V.costColor(100)) + ' 86%', rgba(V.costColor(100)) + ' 100%');
            return '<div class="vt-lyr-legend"><span class="vt-lyr-grad" style="background:linear-gradient(90deg,' + cs.join(',') + ')"></span>' +
                '<span class="vt-lyr-legend-l"><span>' + esc(t('trav.leg.free')) + '</span><span>' + esc(t('trav.leg.hard')) + '</span><span>' +
                esc(t('trav.leg.lethal')) + '</span></span></div>';
        }
        if (mode === 'height' && V.heightColor) {
            var sp = V.ELEV_SPAN_CM, hs = [128 - sp, 128, 128 + sp].map(function (v) { return rgba(V.heightColor(v)); });
            return '<div class="vt-lyr-legend"><span class="vt-lyr-grad" style="background:linear-gradient(90deg,' + hs.join(',') + ')"></span>' +
                '<span class="vt-lyr-legend-l vt-tnum"><span>' + esc(t('trav.leg.low', { cm: sp })) + '</span><span>' + esc(t('trav.leg.level')) +
                '</span><span>' + esc(t('trav.leg.high', { cm: sp })) + '</span></span></div>';
        }
        if (!V.REASON) { return ''; }
        return '<div class="vt-lyr-legend vt-lyr-treasons">' + [1, 2, 3, 4, 5, 6, 7].map(function (c) {
            var col = c === 2 ? V.reasonColor(2, 75) : V.REASON[c];
            return '<span class="vt-lyr-treason"><span class="vt-lyr-tchip" style="background:' + rgba(col, 1) + '"></span>' +
                esc(t('trav.r.' + V.REASON_KEYS[c])) + '</span>';
        }).join('') + '<span class="vt-lyr-treason"><span class="vt-lyr-tchip is-zone"></span>' + esc(t('trav.r.zone_line')) + '</span></div>';
    }

    function ovRow(key, chkId, name, hint, extra) {
        return '<div class="vt-lyr-ov" data-lyr-row="' + esc(key) + '">' +
            '<button type="button" class="vt-lyr-ovt" role="switch" aria-checked="false" data-lyr-chk="' + esc(chkId) + '"' +
            (hint ? ' title="' + esc(hint) + '"' : '') + '>' +
            '<span class="vt-lyr-sw-ui" aria-hidden="true"></span>' +
            '<span class="vt-lyr-ovn">' + esc(name) + newTag(key) + '</span>' +
            '<span class="vt-lyr-ovs vt-tnum" data-lyr-st="' + esc(key) + '"></span></button>' +
            '<div class="vt-lyr-ovx" hidden>' + extra +
            (hint ? '<div class="vt-lyr-hint">' + esc(hint) + '</div>' : '') + '</div></div>';
    }

    function render() {
        var cat = catalog();
        if (!fab || !cat || !window.VTMapSources) { return; }
        fresh = newIds(cat);
        var s = structSig(cat);
        if (s === sig) { sync(); return; }
        sig = s;
        var MS = window.VTMapSources, l = lang(), h = [];
        // background
        h.push('<section class="vt-lyr-sec"><div class="vt-lyr-sec-h"><span id="vt_lyr_bg_h">' + esc(t('maplyr.bg')) + '</span>' +
            '<button type="button" class="vt-lyr-none" data-lyr-none aria-pressed="false" title="' + esc(t('maplyr.bg_none_tip')) + '">' +
            esc(t('maplyr.bg_none')) + '</button></div>' +
            // M8-5: right under the heading, seen without scrolling
            '<div class="vt-lyr-bgst" data-lyr-bgst role="status" hidden></div>' +
            // ONE radio group over both groups: arrows walk all the bases
            '<div role="radiogroup" aria-labelledby="vt_lyr_bg_h">');
        (MS.baseGroups ? MS.baseGroups(cat) : [{ group: '', sources: cat.bases }]).forEach(function (g) {
            if (g.group) {
                h.push('<div class="vt-lyr-grp-h">' + esc(g.group === 'photo' ? t('mapt.aerial.group_photo')
                    : (g.group === 'map' ? t('mapt.aerial.group_map') : g.group)) + '</div>');
            }
            h.push('<div class="vt-lyr-grid">');
            g.sources.forEach(function (b) {
                var nm = splitName(MS.label(b, l));
                h.push('<button type="button" role="radio" aria-checked="false" tabindex="-1" class="vt-lyr-base" data-lyr-base="' + esc(b.id) + '" title="' + esc(MS.label(b, l)) + '">' +
                    '<span class="vt-lyr-thumb vt-lyr-thumb-' + esc(b.group || 'other') + '" aria-hidden="true"><span class="vt-lyr-thumb-img"></span></span>' +
                    '<span class="vt-lyr-bt"><span class="vt-lyr-bn">' + esc(nm[0]) + '</span>' +
                    (nm[1] ? '<span class="vt-lyr-bp">' + esc(nm[1]) + '</span>' : '') + '</span>' + newTag(b.id) + '</button>');
            });
            h.push('</div>');
        });
        h.push('</div><div data-lyr-bgop>' + rangeHtml('mapv3_aerial_opacity', t('maplyr.bg')) + '</div>' +
            // M9-1: Google onto ČÚZK (only while a Google base is shown)
            ($('mapv3_align_etrs') ? '<div data-lyr-align hidden>' + ovRow('align', 'mapv3_align_etrs', t('maplyr.m9.align'), t('maplyr.m9.align_hint'), '') + '</div>' : '') +
            '</section>');
        // overlays: lines on top, tones under
        var weather = cat.overlays.filter(isWeather);
        var lines = cat.overlays.filter(function (o) { return !isWeather(o) && o.layer_order !== 'under'; });
        var tones = cat.overlays.filter(function (o) { return !isWeather(o) && o.layer_order === 'under'; });
        var ovs = function (list) {
            list.forEach(function (o) {
                var nm = MS.label(o, l);
                var hint = HINTS.indexOf(o.id) >= 0 ? t('maplyr.hint.' + o.id) : '';
                h.push(ovRow(o.id, 'mapv3_ov_' + o.id, nm, hint, rangeHtml('mapv3_ov_' + o.id + '_op', nm) + legendHtml(o.id) +
                    (o.timeline ? '<div class="vt-lyr-tl" data-lyr-tl="' + esc(o.id) + '"></div>' : '')));
            });
        };
        if (cat.overlays.length || $('mapv3_chk_rain') || $('mapv3_chk_trav') || $('mapv3_chk_tmosaic')) {
            h.push('<section class="vt-lyr-sec"><div class="vt-lyr-sec-h"><span>' + esc(t('maplyr.ov')) + '</span></div>');
            if (lines.length) { h.push('<div class="vt-lyr-grp-h">' + esc(t('maplyr.grp.lines')) + '</div>'); ovs(lines); }
            if (tones.length) { h.push('<div class="vt-lyr-grp-h">' + esc(t('maplyr.grp.terrain')) + '</div>'); ovs(tones); }
            // T29: what the robot's terrain node sees now (vt_terrain_layer.js)
            if ($('mapv3_chk_trav')) {
                h.push('<div class="vt-lyr-grp-h">' + esc(t('trav.grp')) + '</div>');
                h.push(ovRow('trav', 'mapv3_chk_trav', t('trav.layer'), t('trav.hint'),
                    rangeHtml('mapv3_trav_op', t('trav.layer')) + travModesHtml() + '<div data-lyr-tleg></div>' +
                    '<div class="vt-lyr-hint" data-lyr-tsrc hidden></div>' +
                    '<div class="vt-lyr-tstat" data-lyr-tstat role="status" hidden></div>'));
            }
            // T30: the terrain map of the whole mowed area (vt_terrain_mosaic.js)
            if ($('mapv3_chk_tmosaic')) {
                if (!$('mapv3_chk_trav')) { h.push('<div class="vt-lyr-grp-h">' + esc(t('trav.grp')) + '</div>'); }
                h.push(ovRow('tmosaic', 'mapv3_chk_tmosaic', t('tmos.layer'), t('tmos.hint'),
                    rangeHtml('mapv3_tmosaic_op', t('tmos.layer')) +
                    // more maps of the site (one mowing, the robot's lasting map …): pick one
                    '<div class="vt-lyr-mpick" data-lyr-mpickrow hidden><select class="form-select form-select-sm" data-lyr-mpick aria-label="' +
                    esc(t('tmos.pick')) + '"></select></div>' +
                    '<div class="vt-lyr-tmodes" role="group" aria-label="' + esc(t('trav.view')) + '">' +
                    ['cost', 'reason', 'height'].map(function (m) {
                        return '<button type="button" class="vt-lyr-tmode" data-lyr-mmode="' + m + '" aria-pressed="false">' + esc(t('tmos.mode.' + m)) + '</button>';
                    }).join('') + '</div><div data-lyr-mleg></div>' +
                    '<div class="vt-lyr-hint vt-tnum" data-lyr-minfo hidden></div>' +
                    '<div class="vt-lyr-tstat" data-lyr-mstat role="status" hidden></div>'));
            }
            if ($('mapv3_chk_rain') || weather.length) {
                h.push('<div class="vt-lyr-grp-h">' + esc(t('maplyr.grp.weather')) + '</div>');
                if ($('mapv3_chk_rain')) {
                    h.push(ovRow('rain', 'mapv3_chk_rain', t('maplyr.rain'), t('maplyr.hint.rain'), rangeHtml('mapv3_rain_opacity', t('maplyr.rain'))));
                }
                ovs(weather);
            }
            h.push('</section>');
        }
        h.push('<div class="vt-lyr-foot"><button type="button" class="vt-lyr-more" data-lyr-more>' + esc(t('maplyr.more')) + '</button></div>');
        tlDetach();                    // the time line goes home before the rows are replaced
        bodyEl.innerHTML = h.join('');
        sync();
    }

    // state only (no re-render): keeps focus and scroll
    function sync() {
        if (!fab) { return; }
        paintFab();
        if (!panel || panel.hidden) { return; }
        var on = bgOn(), b = baseId();
        var bases = panel.querySelectorAll('[data-lyr-base]'), anyOn = false;
        bases.forEach(function (el) {
            var c = on && el.getAttribute('data-lyr-base') === b;
            if (el.getAttribute('aria-checked') !== String(c)) { el.setAttribute('aria-checked', String(c)); }
            el.tabIndex = c ? 0 : -1;
            anyOn = anyOn || c;
        });
        if (!anyOn && bases.length) { bases[0].tabIndex = 0; }   // the group stays reachable by Tab
        var none = panel.querySelector('[data-lyr-none]');
        if (none) { none.setAttribute('aria-pressed', String(!on)); }
        var bop = panel.querySelector('[data-lyr-bgop]');
        if (bop) { bop.hidden = !on; }
        var alg = panel.querySelector('[data-lyr-align]'), bsrc = on && catalog() && catalog().byId[b];
        if (alg) { alg.hidden = !(bsrc && (bsrc.offset_key || bsrc.id) === 'sat'); }
        // M8-5: one line when the background does not load (none / some missing)
        var bst = panel.querySelector('[data-lyr-bgst]'), ld = bgLoad();
        if (bst) {
            var msg = !ld ? '' : (ld.state === 'none' ? t('maplyr.m8.bg_none')
                : (ld.state === 'some' ? t('maplyr.m8.bg_some', { f: ld.f, n: ld.n }) : ''));
            if (bst.textContent !== msg) { bst.textContent = msg; }
            bst.hidden = !msg;
        }
        tlAttach();
        paintThumbs();
        syncTrav();
        syncMosaic();
        var cat = catalog(), meta = $('vt_lyr_meta');
        if (meta) {
            var src = on && cat && cat.byId[b];
            meta.textContent = src ? splitName(VTMapSources.label(src, lang()))[0] : t('maplyr.bg_none');
        }
        panel.querySelectorAll('[data-lyr-chk]').forEach(function (el) {
            var c = $(el.getAttribute('data-lyr-chk')), v = !!(c && c.checked);
            el.setAttribute('aria-checked', String(v));
            var x = el.parentNode.querySelector('.vt-lyr-ovx');
            if (x) { x.hidden = !v; }
            var key = el.parentNode.getAttribute('data-lyr-row');
            var st = el.querySelector('[data-lyr-st]');
            if (st) {
                var src = key === 'rain' ? null : $('mapv3_ov_' + key + '_st');
                var txt = v && src ? src.textContent : '';
                if (st.textContent !== txt) { st.textContent = txt; }
            }
        });
        panel.querySelectorAll('[data-lyr-op]').forEach(function (r) {
            var id = r.getAttribute('data-lyr-op'), m = $(id);
            if (m && document.activeElement !== r && r.value !== m.value) { r.value = m.value; }
            var o = panel.querySelector('[data-lyr-opv="' + id + '"]');
            if (o) { o.textContent = pct(r.value); }
        });
    }

    function paintFab() {
        if (!fab) { return; }
        var dot = fab.querySelector('.vt-lyr-dot');
        var any = newIds(catalog()).length > 0;
        if (dot.hidden === any) { dot.hidden = !any; }
        fab.classList.toggle('vt-lyr-has-new', any);
        // the button tells what is on: background + overlays
        var cat = catalog(), n = 0;
        if (cat) { cat.overlays.forEach(function (o) { if (ovOn(o.id)) { n++; } }); }
        if (rainOn()) { n++; }
        var tv = $('mapv3_chk_trav');
        if (tv && tv.checked) { n++; }
        var tm = $('mapv3_chk_tmosaic');
        if (tm && tm.checked) { n++; }
        fab.classList.toggle('vt-lyr-active', bgOn() || n > 0);
        // M8-5: not one tile of the background came: the button says so
        var ld = bgLoad(), warn = !!(ld && ld.state === 'none');
        if (fab.classList.contains('vt-lyr-warn') !== warn) {
            fab.classList.toggle('vt-lyr-warn', warn);
            fab.title = warn ? t('maplyr.m8.btn_warn') : t('maplyr.btn_tip');
        }
    }

    function onClick(e) {
        var el = e.target.closest('button');
        if (!el || !panel.contains(el)) { return; }
        if (el.hasAttribute('data-lyr-base')) { setBase(el.getAttribute('data-lyr-base')); return; }
        if (el.hasAttribute('data-lyr-none')) { setBgOff(); return; }
        if (el.hasAttribute('data-lyr-chk')) {
            var id = el.getAttribute('data-lyr-chk'), c = $(id);
            setChk(id, !(c && c.checked));
            return;
        }
        if (el.hasAttribute('data-lyr-close')) { close(true); return; }
        if (el.hasAttribute('data-lyr-help')) {
            close(false);
            if (window.VTHelp) { VTHelp.open('mapping', lang() === 'cs' ? 'tlačítko-vrstev-na-mapě' : 'the-layers-button-on-the-map'); }
            return;
        }
        if (el.hasAttribute('data-lyr-mmode')) {
            var mm = $('mapv3_tmosaic_mode'), mv = el.getAttribute('data-lyr-mmode');
            if (mm && !el.disabled && mm.value !== mv) { mm.value = mv; fire(mm, 'change'); }
            sync();
            return;
        }
        if (el.hasAttribute('data-lyr-tmode')) {
            var ms = $('mapv3_trav_mode'), m = el.getAttribute('data-lyr-tmode');
            if (ms && !el.disabled && ms.value !== m) { ms.value = m; fire(ms, 'change'); }
            sync();
            return;
        }
        if (el.hasAttribute('data-lyr-more')) { moreSettings(); }
    }
    function onInput(e) {
        var r = e.target;
        if (!r || !r.hasAttribute || !r.hasAttribute('data-lyr-op')) { return; }
        var id = r.getAttribute('data-lyr-op');
        setRange(id, r.value);
        var o = panel.querySelector('[data-lyr-opv="' + id + '"]');
        if (o) { o.textContent = pct(r.value); }
    }

    function editorOpen() {
        try { return !!(window.MapEditor && MapEditor.controller && MapEditor.controller().active); } catch (e) { return false; }
    }
    // the rest (detail, alignment, rain area …) stays in Map › Display (layers);
    // in the map editor its own Layers section
    function moreSettings() {
        close(false);
        // the editor open? (asked WITHOUT map_menu.editor_holds(): that one
        // arms the editor's "close twice" guard and shrinks it)
        if (editorOpen()) {
            var es = $('mapedit_sec_layers');
            if (es) {
                es.open = true;
                setTimeout(function () { try { es.scrollIntoView({ block: 'start' }); } catch (x) { /* old browser */ } }, 50);
            }
            return;
        }
        var mm = (typeof map_menu !== 'undefined') ? map_menu : null;   // map_view.js
        var shown = mm && mm.current_submenu === 'map' && mm.row_submenu_visible;
        if (!shown) { var b = $('btn_map'); if (b) { b.click(); } }
        var tab = document.querySelector('a[href="#tab-map"]');
        if (tab && !tab.classList.contains('active')) { tab.click(); }
        var d = document.querySelector('details[data-mapsec="layers"]');
        if (d) {
            d.open = true;
            setTimeout(function () { try { d.scrollIntoView({ block: 'start' }); } catch (x) { /* old browser */ } }, 300);
        }
    }

    // ---- open / close / place
    function open() {
        build();
        isOpen = true;
        panel.hidden = false;
        fab.setAttribute('aria-expanded', 'true');
        render();
        sync();
        place();
        try { panel.focus({ preventScroll: true }); } catch (e) { /* old browser */ }
        // the overlay rows count their tiles: refresh their state while open
        if (!timer) { timer = setInterval(sync, 1000); }
    }
    function close(refocus) {
        if (!isOpen) { return; }
        isOpen = false;
        tlDetach();                    // M8-2: the time line back to Map › Display
        panel.hidden = true;
        fab.setAttribute('aria-expanded', 'false');
        if (timer) { clearInterval(timer); timer = null; }
        markSeen();
        sig = '';                      // the "new" tags go on the next opening
        if (refocus) { try { fab.focus({ preventScroll: true }); } catch (e) { /* old browser */ } }
    }
    function toggle() { if (isOpen) { close(true); } else { open(); } }

    var lastRoseH = 0;
    function place() {
        if (!fab) { return; }
        var root = document.documentElement, cs = getComputedStyle(root);
        var W = window.innerWidth, H = window.innerHeight;
        var ftop = cssPx(cs, '--vt-frame-top', 72), cb = cssPx(cs, '--vt-frame-cbottom', 40);
        var fbot = cssPx(cs, '--vt-frame-bottom', 40), rpw = cssPx(cs, '--vt-frame-rp-w', 0);
        var phone = W < PHONE_MAX_W;
        // under the compass rose (vt_georef.js); while the rose is hidden the
        // button keeps its place (no jump when it comes)
        var rose = $('vt_utm_rose'), rTop = ftop + 10, top;
        if (rose) {
            var rcs = getComputedStyle(rose);
            if (rcs.display !== 'none' && rose.offsetHeight) {
                var r = rose.getBoundingClientRect();
                rTop = r.top;
                lastRoseH = r.height;
            } else {
                rTop = parseFloat(rcs.top) || rTop;
            }
        }
        top = Math.round(rTop + (lastRoseH || (phone ? 66 : 80)) + 8);
        var hide = document.body.classList.contains('vt-cam-large') || top + 44 > H - cb - 4;
        if (fab.hidden !== hide) { fab.hidden = hide; }
        if (fab.style.top !== top + 'px') { fab.style.top = top + 'px'; }
        if (hide && isOpen) { close(false); }
        if (!panel || panel.hidden) { return; }
        var st = panel.style;
        if (phone) {
            // a sheet over the bottom of the map: the bottom bar, the stick
            // and the STOP stay free, the map keeps more than a third above it
            var hollow = Math.max(160, H - ftop - fbot);
            st.left = '4px'; st.right = '4px'; st.top = 'auto';
            st.bottom = Math.round(fbot + 4) + 'px';
            st.width = 'auto';
            st.maxHeight = Math.round(hollow * SHEET_PART) + 'px';
            panel.classList.add('vt-lyr-sheet');
        } else {
            var fr = fab.getBoundingClientRect(), right = fr.right;
            if (rose && rose.offsetHeight) { right = Math.max(right, rose.getBoundingClientRect().right); }
            var left = Math.round(right + 8);
            st.left = left + 'px'; st.right = 'auto'; st.bottom = 'auto';
            st.top = Math.round(rTop) + 'px';
            st.width = Math.max(240, Math.min(352, W - left - rpw - 12)) + 'px';
            st.maxHeight = Math.max(160, Math.round(H - rTop - cb - 10)) + 'px';
            panel.classList.remove('vt-lyr-sheet');
        }
    }

    var placeRaf = null;
    function schedulePlace() {
        if (placeRaf) { return; }
        placeRaf = requestAnimationFrame(function () { placeRaf = null; place(); });
    }
    var syncRaf = null;
    function scheduleSync() {
        if (syncRaf) { return; }
        syncRaf = requestAnimationFrame(function () { syncRaf = null; sync(); });
    }

    // T29: the terrain layer's module, loaded from here (no index.html change)
    function loadTerrain() {
        if (window.VTTerrain || document.querySelector('script[data-vt-terrain]')) { return; }
        var sc = document.createElement('script');
        sc.src = '/assets/js/vt_terrain_layer.js';
        sc.setAttribute('data-vt-terrain', '1');
        sc.onload = function () { sig = ''; if (isOpen) { render(); } };
        document.head.appendChild(sc);
    }
    // T17 M10: measuring on the map, loaded the same way
    // T30: the mowed-area terrain map, loaded the same way
    function loadMosaic() {
        if (window.VTTerrainMosaic || document.querySelector('script[data-vt-tmosaic]')) { return; }
        var sc = document.createElement('script');
        sc.src = '/assets/js/vt_terrain_mosaic.js';
        sc.setAttribute('data-vt-tmosaic', '1');
        document.head.appendChild(sc);
    }

    function loadMeasure() {
        if (window.VTMapMeasure || document.querySelector('script[data-vt-measure]')) { return; }
        var sc = document.createElement('script');
        sc.src = '/assets/js/vt_map_measure.js';
        sc.setAttribute('data-vt-measure', '1');
        document.head.appendChild(sc);
    }

    function init() {
        if (!document.getElementById('map_view')) { return; }
        build();
        loadTerrain();
        loadMeasure();
        loadMosaic();
        place();
        // the Map tab / editor changed something: mirror it (capture: the
        // events fired by mapping.js / mapedits.js do not bubble)
        ['change', 'input'].forEach(function (ty) {
            document.addEventListener(ty, function (e) {
                var id = e.target && e.target.id;
                if (id && id.indexOf('mapv3_') === 0) { scheduleSync(); }
            }, true);
        });
        document.addEventListener('vt:map-sources', function () {
            if (isOpen) { render(); } else { paintFab(); }
        });
        // M8-5: the background started / stopped loading (mapping.js)
        document.addEventListener('vt:map-tiles', scheduleSync);
        if (window.VTI18n && VTI18n.onChange) {
            VTI18n.onChange(function () { labels(); sig = ''; if (isOpen) { render(); } });
        }
        window.addEventListener('resize', schedulePlace);
        window.addEventListener('orientationchange', schedulePlace);
        // the frame moves its edges through CSS variables on <html> and modes
        // on <body>; the rose shows / hides through its style
        try {
            var mo = new MutationObserver(schedulePlace);
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
            mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            var hook = setInterval(function () {
                var r = $('vt_utm_rose');
                if (r) { mo.observe(r, { attributes: true, attributeFilter: ['style'] }); clearInterval(hook); schedulePlace(); }
            }, 1000);
        } catch (e) { setInterval(place, 1000); }
        paintFab();
    }

    window.VTMapLayers = { open: open, close: close, toggle: toggle, sync: sync, place: place,
                           _splitName: splitName, _newIds: newIds, _thumbPlan: thumbPlan, ASPECT_STOPS: ASPECT_STOPS };
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
