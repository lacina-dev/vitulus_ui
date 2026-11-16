#!/usr/bin/env node
/*
 * T17 batch M14 (behaviour, code sliced out of mapping.js verbatim):
 *     node tools/test_map_m14.node.js
 *   - Measure against ČÚZK: the button is hidden for ČÚZK's own group and
 *     drawn maps; with no served map or a map without a datum it stays,
 *     switched off, with the reason under it; no request is sent then;
 *   - "Measuring…" lasts at least 300 ms also when the robot answers at once,
 *     the button is off (aria-busy) for all that time, one request only;
 *   - the note of the layers panel: lines of ČÚZK's frame over a Google /
 *     Bing photo with no offset (measured or by hand) on this map;
 *   - the layers panel shows it once per map and photo (localStorage in
 *     try/catch), closable, never in the editor; i18n keys en + cs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'nodes', 'templates', 'assets', 'js');
const SRC = fs.readFileSync(path.join(JS, 'mapping.js'), 'utf8');
const LYR = fs.readFileSync(path.join(JS, 'vt_map_layers.js'), 'utf8');
let fails = 0;
function check(name, ok, info) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + (typeof info === 'string' ? info : JSON.stringify(info))));
    if (!ok) { fails++; }
}
function sliceAt(src, start) {
    let depth = 0;
    const open = src.indexOf('{', start);
    for (let j = open; j < src.length; j++) {
        if (src[j] === '{') { depth++; } else if (src[j] === '}') { depth--; if (!depth) { return src.slice(start, j + 1); } }
    }
    throw new Error('braces');
}
function fn(name, src) {
    const i = (src || SRC).indexOf('function ' + name + '(');
    if (i < 0) { throw new Error(name + ' not found'); }
    return sliceAt(src || SRC, i);
}
function method(name) {
    const i = SRC.indexOf('\n    ' + name + '(');
    if (i < 0) { throw new Error('method ' + name + ' not in mapping.js'); }
    return sliceAt(SRC, i + 1);
}
const calls = [];
const H = new Function('fetch', 'calls',
    "const UNALIGNED_KEYS = ['sat', 'bing'];\n" + ['tileOffsetMeta', 'baseIsPhoto', 'tileUnalignedNote'].map((n) => fn(n)).join('\n') + '\n' +
    'function mapT(k) { return k; }\n' +
    'const M = {\n' + ['_measSource', '_measBlock', '_measurable', '_updateMeasureButton', '_measureStart', '_unalignedInfo', '_resay'].map(method).join(',\n') + '\n};\n' +
    'return { M, tileUnalignedNote };')((url, opt) => { calls.push({ url, opt }); return H.answer(); }, calls);
check('the list of photos the note is for is the one of mapping.js', /const UNALIGNED_KEYS = \['sat', 'bing'\];/.test(SRC));

function el() {
    const a = {};
    return { hidden: false, disabled: false, textContent: '', setAttribute(k, v) { a[k] = v; }, removeAttribute(k) { delete a[k]; }, getAttribute(k) { return a[k]; } };
}
const SOURCES = {
    sat: { id: 'sat', group: 'photo' }, bing: { id: 'bing', group: 'photo' }, esri: { id: 'esri', group: 'photo' },
    cuzk: { id: 'cuzk', group: 'photo' }, ztm: { id: 'ztm', group: 'map', offset_key: 'cuzk' }, gmap: { id: 'gmap', group: 'map', offset_key: 'sat' },
    sat_hybrid: { id: 'sat_hybrid', group: 'photo', offset_key: 'sat' },
};
function page(base, map, extra) {
    const shown = [];
    const c = Object.assign({}, H.M, {
        tile_offset_map: map, tile_offsets: {}, tile_offsets_meta: {}, aerial_datum: { origin_lat: 50 }, _datumMissing: false,
        MEAS_MIN_BUSY_MS: 300, _measBusy: false, _measPreview: null, shown: shown,
        btn_meas: el(), el_meas_why: el(), el_meas_res: { hidden: true },
        _aerialBase() { return SOURCES[base]; }, _aerialLayerId() { const s = SOURCES[base]; return s.offset_key || s.id; },
        _say(e, f) { e._mapSay = f; e.textContent = f(); },
        _measSrcName() { return base; }, _measureClose() {}, _tileOffsetStatus() {},
        _measureShow(j) { shown.push(j); }, _bgShown() { return true; }, _overlaysOn() { return []; },
    }, extra || {});
    c._say(c.btn_meas, () => (c._measBusy ? 'mapping.m13.measuring' : 'mapping.m13.measure'));
    c._updateMeasureButton();
    return c;
}

// ---- 4: which maps can be measured ------------------------------------------------
let c = page('sat', '10_2026');
check('Google photo on the active map with a datum: the button is on, no reason line',
      !c.btn_meas.hidden && !c.btn_meas.disabled && c.el_meas_why.hidden && c.el_meas_why.textContent === '');
c = page('cuzk', '10_2026');
check('ČÚZK itself: no button, no reason', c.btn_meas.hidden && c.el_meas_why.hidden);
c = page('ztm', '10_2026');
check('a drawn map: no button', c.btn_meas.hidden && c.el_meas_why.hidden);
c = page('sat', '');
check('no served map: the button stays, switched off, with the reason',
      !c.btn_meas.hidden && c.btn_meas.disabled && !c.el_meas_why.hidden && c.el_meas_why.textContent === 'mapping.m14.blocked_no_map');
c._measureStart();
check('… and a press sends nothing', calls.length === 0 && !c._measBusy);
c = page('bing', 'Nmap', { aerial_datum: null, _datumMissing: true });
check('a map without a datum: switched off, "no stored position (datum)"',
      !c.btn_meas.hidden && c.btn_meas.disabled && !c.el_meas_why.hidden && c.el_meas_why.textContent === 'mapping.m14.blocked_no_datum');
c._measureStart();
check('… and a press sends nothing', calls.length === 0);
c.aerial_datum = { origin_lat: 50 }; c._datumMissing = false; c._updateMeasureButton();
check('the datum came (another map served): the button is on again, the reason gone',
      !c.btn_meas.disabled && c.el_meas_why.hidden && c.el_meas_why.textContent === '');
c = page('sat', '10_2026', { aerial_datum: null, _datumMissing: false });
check('datum not asked yet: not blocked (the robot decides, reason no_datum)', !c.btn_meas.disabled && c.el_meas_why.hidden);
check('rebuildAerial records the robot\'s "no datum" and clears it when a datum comes',
      /if \(dj && !this\._datumMissing\) \{ this\._datumMissing = true; this\._updateMeasureButton\(\); \}/.test(SRC) &&
      /if \(this\._datumMissing\) \{ this\._datumMissing = false; this\._updateMeasureButton\(\); \}/.test(SRC));
check('the robot\'s refusals have their own sentences (no_datum, not_active)',
      /no_datum: \(\) => mapT\('mapping\.m13\.why_no_datum'\)/.test(SRC) && /not_active: \(\) => mapT\('mapping\.m13\.why_not_active'\)/.test(SRC));

// ---- 5: the note ---------------------------------------------------------------
const KN = { id: 'kn', offset_key: 'cuzk', layer_order: 'over' }, HILL = { id: 'hillshade', offset_key: 'cuzk', layer_order: 'under' }, RAIN = { id: 'precip' };
const U = H.tileUnalignedNote;
check('cadastre over Google with no offset on this map: note for (map, sat)', JSON.stringify(U({}, {}, 'New', SOURCES.sat, [KN])) === '{"map":"New","key":"sat"}');
check('… also over the Google hybrid (aligned as sat) and Bing', U({}, {}, 'New', SOURCES.sat_hybrid, [KN]).key === 'sat' && U({}, {}, 'New', SOURCES.bing, [KN]).key === 'bing');
check('an offset of ANOTHER map or photo does not count', !!U({ Nmap: { sat: { dx: 1, dy: 0 } }, New: { bing: { dx: 1, dy: 0 } } }, {}, 'New', SOURCES.sat, [KN]));
check('set by hand on this map: no note', U({ New: { sat: { dx: 1.2, dy: -0.2 } } }, {}, 'New', SOURCES.sat, [KN]) === null);
check('measured on this map (also a measured zero: meta only): no note', U({}, { New: { sat: { src: 'measured', ts: 5 } } }, 'New', SOURCES.sat, [KN]) === null);
check('no line overlay on (none, tones under the map, rain): no note', U({}, {}, 'New', SOURCES.sat, []) === null && U({}, {}, 'New', SOURCES.sat, [HILL, RAIN]) === null);
check('ČÚZK, Esri, drawn maps, no background, no map: no note',
      U({}, {}, 'New', SOURCES.cuzk, [KN]) === null && U({}, {}, 'New', SOURCES.esri, [KN]) === null && U({}, {}, 'New', SOURCES.gmap, [KN]) === null &&
      U({}, {}, 'New', null, [KN]) === null && U({}, {}, '', SOURCES.sat, [KN]) === null);
c = page('sat', 'New', { _overlaysOn() { return [KN]; } });
check('the page: note for the shown map and photo', JSON.stringify(c._unalignedInfo()) === '{"map":"New","key":"sat"}');
c._bgShown = () => false;
check('… not while the background is off', c._unalignedInfo() === null);
c = page('sat', 'New', { _overlaysOn() { return [KN]; }, aerial_datum: null, _datumMissing: true });
check('… not when the map cannot be measured (the link would lead nowhere)', c._unalignedInfo() === null);
c = page('sat', 'New', { _overlaysOn() { return [KN]; }, _measPreview: { on: true } });
check('… not while a measured offset is being tried on', c._unalignedInfo() === null);

// the panel's "once per map and photo" (vt_map_layers.js), with a fake store
function panelLogic(store, editor) {
    const info = { v: { map: 'New', key: 'sat' } };
    const rects = { note: { top: 1000, bottom: 1030, height: 30 }, body: { top: 100, bottom: 600, height: 500 } };
    const note = { hidden: true, getBoundingClientRect() { return rects.note; } };
    const body = { getBoundingClientRect() { return rects.body; } };
    const P = new Function('lsGet', 'lsSet', 'window', 'panel', 'editorOpen', 'moreSettings', 'setTimeout',
        LYR.slice(LYR.indexOf("    var UNAL_KEY = 'vitulus_unaligned_seen'"), LYR.indexOf('    function paintFab()')) +
        '\nreturn { placed: function (on) { unalPlaced = on !== false; if (unalPlaced) { unalCheckSeen(); } }, syncUnal: syncUnal, unalGo: unalGo, unalNow: unalNow, close: function () { var id = unalNow(); if (id) { unalClosed[id] = true; } syncUnal(); } };')(
        (k) => store.get(k), (k, v) => store.set(k, v), { innerHeight: 844, mapping_v3: { _unalignedInfo() { return info.v; }, _measureReveal() { info.revealed = true; } } },
        { hidden: false, querySelector(q) { return q === '.vt-lyr-body' ? body : note; } }, () => !!editor.on, () => { info.more = (info.more || 0) + 1; }, (f) => f());
    P.placed();          // the panel has its real size (place() ran); the first-open case is tested below
    return { P, note, info, rects };
}
const mem = () => { const m = {}; return { get: (k) => (k in m ? m[k] : null), set: (k, v) => { m[k] = v; }, m }; };
let st = mem(), ed = { on: false }, a = panelLogic(st, ed);
a.P.syncUnal();
check('first time: the note shows, but lies below the visible part: NOT remembered as seen', a.note.hidden === false && !st.m.vitulus_unaligned_seen);
a.P.syncUnal();
check('… and not after another sync either', !st.m.vitulus_unaligned_seen && a.note.hidden === false);
// first open: place() has not run yet, the body is as tall as its whole content (kontrola M14: 50..1475 px in an 844 px window)
{
    const s0 = mem(), p0 = panelLogic(s0, { on: false });
    p0.P.placed(false);
    p0.rects.body = { top: 50, bottom: 1475, height: 1425 }; p0.rects.note = { top: 842, bottom: 882, height: 40 };
    p0.P.syncUnal();
    check('first open before place(): the row inside the not yet sized body is NOT remembered', p0.note.hidden === false && !s0.m.vitulus_unaligned_seen);
    p0.rects.body = { top: 50, bottom: 288, height: 238 }; p0.P.placed();
    check('… and not after place() either while it lies below the sized body', !s0.m.vitulus_unaligned_seen);
    p0.rects.note = { top: 240, bottom: 280, height: 40 }; p0.P.placed();
    check('… remembered once place() ran and the row is in view', JSON.parse(s0.m.vitulus_unaligned_seen)['New|sat'] === 1);
    const s1 = mem(), p1 = panelLogic(s1, { on: false });
    p1.rects.body = { top: 700, bottom: 1400, height: 700 }; p1.rects.note = { top: 900, bottom: 940, height: 40 }; p1.P.syncUnal();
    check('a body reaching below the window is clipped by the window (innerHeight 844)', !s1.m.vitulus_unaligned_seen);
}
a.rects.note = { top: 560, bottom: 590, height: 30 }; a.P.syncUnal();
check('scrolled into the visible part of the body: remembered in the browser', JSON.parse(st.m.vitulus_unaligned_seen)['New|sat'] === 1);
a.P.syncUnal();
check('it stays while this page lives', a.note.hidden === false);
a.info.v = null; a.P.syncUnal();
check('the lines went off: the note hides', a.note.hidden === true);
a.info.v = { map: 'New', key: 'sat' }; a.P.syncUnal();
check('… and is back with them in the same page', a.note.hidden === false);
a.P.close();
check('× hides it for good', a.note.hidden === true && (a.P.syncUnal(), a.note.hidden === true));
let b = panelLogic(st, ed);
b.P.syncUnal();
check('after a reload: not again for the same map and photo', b.note.hidden === true);
b.info.v = { map: 'New', key: 'bing' }; b.rects.note = { top: 200, bottom: 230, height: 30 }; b.P.syncUnal();
check('another photo of the map: its own one time', b.note.hidden === false && JSON.parse(st.m.vitulus_unaligned_seen)['New|bing'] === 1);
b.P.unalGo();
check('the link opens Map › Display at the Measure button and puts the note away', b.info.more === 1 && b.info.revealed === true && (b.P.syncUnal(), b.note.hidden === true));
let sx = mem(), x1 = panelLogic(sx, { on: false });
x1.P.syncUnal();
check('(unseen row below the fold: nothing stored)', !sx.m.vitulus_unaligned_seen);
x1.P.unalGo();
check('the link counts as seen even when the row was never in view', JSON.parse(sx.m.vitulus_unaligned_seen)['New|sat'] === 1);
check('× (click handler) writes unalMark', /data-lyr-unal-x[\s\S]{0,200}unalMark\(uid\)/.test(LYR));
check('the group-less base is no photo: not noted, not measurable', H.tileUnalignedNote({}, {}, 'New', { id: 'sat', offset_key: 'sat' }, [{ id: 'cuzk', layer_order: 'over' }]) === null);
let e2 = panelLogic(mem(), { on: true });
e2.P.syncUnal();
check('never in the map editor (and not counted as seen there)', e2.note.hidden === true);
const broken = { get() { throw new Error('denied'); }, set() { throw new Error('denied'); }, m: {} };
let ok3 = true, d3;
try { d3 = panelLogic({ get: () => '{not json', set: broken.set }, { on: false }); d3.P.syncUnal(); } catch (x) { ok3 = false; }
check('a broken or blocked browser store does not break the panel (the note still shows)', ok3 && d3.note.hidden === false);
check('the store is read and written inside try/catch', /function lsGet\(k\) \{ try \{/.test(LYR) && /function lsSet\(k, v\) \{ try \{/.test(LYR));
check('the note is a line in the panel, not a dialog; the link is a button of 40 px',
      /data-lyr-unal role="note" hidden/.test(LYR) && /class="vt-lyr-more vt-lyr-unal-go" data-lyr-unal-go/.test(LYR) &&
      /\.vt-lyr-more \{\s*min-height: 40px;/.test(fs.readFileSync(path.join(ROOT, 'nodes', 'templates', 'assets', 'css', 'vt_map_layers.css'), 'utf8')));
{
    // T8 dávka IV: beside the link the words broke into three short lines (desktop en)
    const CSS = fs.readFileSync(path.join(ROOT, 'nodes', 'templates', 'assets', 'css', 'vt_map_layers.css'), 'utf8');
    const rule = (sel) => { const m = CSS.match(new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}')); return m ? m[1] : ''; };
    check('note layout: a grid, the words with × beside them, the link on its own row under the words',
          /display: grid/.test(rule('.vt-lyr-unal')) && /grid-template-columns: minmax\(0, 1fr\) auto/.test(rule('.vt-lyr-unal')) &&
          /grid-row: 1/.test(rule('.vt-lyr-unal-t')) && /grid-column: 2; grid-row: 1/.test(rule('.vt-lyr-unal-x')) &&
          /grid-column: 1 \/ -1; grid-row: 2/.test(rule('.vt-lyr-unal-go')));
    check('note layout: no flex basis that squeezes the words to 7em beside the link', !/flex: 1 1 7em/.test(rule('.vt-lyr-unal-t')));
}

// ---- i18n -----------------------------------------------------------------------
const en = fs.readFileSync(path.join(JS, 'i18n', 'en.js'), 'utf8'), cs = fs.readFileSync(path.join(JS, 'i18n', 'cs.js'), 'utf8');
const KEYS = ['mapping.m14.blocked_no_datum', 'mapping.m14.blocked_no_map', 'maplyr.m14.unal', 'maplyr.m14.unal_tip', 'maplyr.m14.unal_close'];
check('i18n: the M14 keys in en + cs', KEYS.every((k) => en.includes('"' + k + '":') && cs.includes('"' + k + '":')));
check('i18n: the sentence names the datum and the active map (en + cs)',
      /"mapping\.m14\.blocked_no_datum": "[^"]*no stored position \(datum\)[^"]*active map with a datum/.test(en) &&
      /"mapping\.m14\.blocked_no_datum": "[^"]*nemá uloženou polohu \(datum\)[^"]*aktivní mapu s datumem/.test(cs) &&
      /"mapping\.m13\.why_no_datum": "[^"]*\(datum\)/.test(en) && /"mapping\.m13\.why_no_datum": "[^"]*\(datum\)/.test(cs));

// ---- 6: "Measuring…" for at least 300 ms (last: it waits) ----------------------------
(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    H.answer = () => Promise.resolve({ status: 409, json: () => Promise.resolve({ ok: false, reason: 'busy' }) });   // at once
    c = page('sat', '10_2026');
    const t0 = Date.now();
    c._measureStart();
    check('pressed: "Measuring…", the button off and aria-busy, one request',
          c.btn_meas.textContent === 'mapping.m13.measuring' && c.btn_meas.disabled && c.btn_meas.getAttribute('aria-busy') === 'true' && calls.length === 1);
    c._measureStart(); c._updateMeasureButton();
    check('a second press (or a readout update) meanwhile changes nothing', calls.length === 1 && c.btn_meas.disabled);
    await sleep(200);
    check('the robot answered at once: still "Measuring…" after 200 ms, no result yet',
          c._measBusy && c.btn_meas.disabled && c.btn_meas.textContent === 'mapping.m13.measuring' && c.shown.length === 0);
    while (c._measBusy && Date.now() - t0 < 2000) { await sleep(10); }
    const took = Date.now() - t0;
    check('… the result comes after at least 300 ms (' + took + ' ms), the button is on again',
          took >= 295 && took < 3000 && c.shown.length === 1 && c.shown[0].reason === 'busy' && !c.btn_meas.disabled &&
          c.btn_meas.textContent === 'mapping.m13.measure' && c.btn_meas.getAttribute('aria-busy') === undefined);
    H.answer = () => new Promise((res) => setTimeout(() => res({ status: 200, json: () => Promise.resolve({ ok: true }) }), 450));
    const t1 = Date.now();
    c._measureStart();
    while (c._measBusy && Date.now() - t1 < 2000) { await sleep(10); }
    const took2 = Date.now() - t1;
    check('a measurement longer than 300 ms is not held back (' + took2 + ' ms for 450)', took2 >= 445 && took2 < 3000 && c.shown.length === 2);
    H.answer = () => Promise.reject(new Error('network'));
    c._measureStart();
    while (c._measBusy) { await sleep(10); }
    check('no answer: "unreachable", the button on again', c.shown.length === 3 && c.shown[2].reason === 'unreachable' && !c.btn_meas.disabled);
    console.log(fails ? '\nFAILED ' + fails : '\nOK — all checks passed');
    process.exit(fails ? 1 : 0);
})();
