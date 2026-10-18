#!/usr/bin/env node
/*
 * The languages of the robot UI (docs/I18N.md):
 *
 *     node tools/test_i18n.node.js            report + checks
 *     node tools/test_i18n.node.js --missing  also list every missing key
 *     node tools/test_i18n.node.js --hardcoded  list English left without i18n (heuristic)
 *
 * REPORTS (never fails — the translation is work in progress):
 *   - keys of en.js that cs.js does not have yet (they show in English);
 *   - help topics of docs/help/*.md without docs/help/cs/<id>.md.
 * FAILS when
 *   - a dictionary does not load, or a value is not a string;
 *   - cs.js has a key en.js does not (English is the source: add it there);
 *   - a translation has other {placeholders} than the English text;
 *   - index.html uses a data-i18n* key that en.js does not have;
 *   - a JS module that uses VTI18n names a key (a quoted 'area.word…' of an
 *     area en.js has) that en.js does not have;
 *   - vt_i18n.js does not fall back: cs → en → the key itself, plurals;
 *   - a docs/help/cs/*.md has no English topic, another id, a group that is
 *     not one of the English group keys, other "ui:" keys than the English
 *     topic, a dead "ui:" anchor, link, image or related topic (links are
 *     checked against the Czech help as the pane shows it: translated topics
 *     in Czech, the rest in English);
 *   - VTHelpMd.merge does not keep English for an untranslated topic.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const TPL = path.join(ROOT, 'nodes', 'templates');
const JS = path.join(TPL, 'assets', 'js');
const HELP = path.join(ROOT, 'docs', 'help');
const LANGS = ['cs'];
const SHOW_MISSING = process.argv.includes('--missing');
const GROUPS = ['Start here', 'Robot', 'Using the UI', 'When something is wrong'];

let fails = 0;
function fail(msg) { fails++; console.log('FAIL ' + msg); }
function note(msg) { console.log('NOTE ' + msg); }

/* ---- dictionaries */
function loadDicts() {
    const win = {};
    const ctx = vm.createContext({ window: win });
    ['en'].concat(LANGS).forEach((l) => {
        const f = path.join(JS, 'i18n', l + '.js');
        try { vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }); } catch (e) { fail('i18n/' + l + '.js does not load: ' + e.message); }
    });
    return win.VT_I18N_DICT || {};
}
const D = loadDicts();
const en = D.en || {};
if (!Object.keys(en).length) { fail('i18n/en.js is empty'); }
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
Object.entries(en).forEach(([k, v]) => { if (typeof v !== 'string') { fail('en: ' + k + ' is not a string'); } });
LANGS.forEach((l) => {
    const d = D[l] || {};
    const missing = Object.keys(en).filter((k) => !(k in d));
    Object.entries(d).forEach(([k, v]) => {
        if (typeof v !== 'string') { fail(l + ': ' + k + ' is not a string'); return; }
        if (!(k in en)) {
            // a plural form only some languages have (key.few / key.many) is fine when en has key.other
            const m = /^(.*)\.(zero|one|two|few|many|other)$/.exec(k);
            if (!(m && (m[1] + '.other') in en)) { fail(l + ': key ' + k + ' is not in en.js (English is the source)'); }
            return;
        }
        if (ph(v) !== ph(en[k])) { fail(l + ': ' + k + ' has placeholders [' + ph(v) + '], English [' + ph(en[k]) + ']'); }
    });
    const pct = Object.keys(en).length ? Math.round(100 * (Object.keys(en).length - missing.length) / Object.keys(en).length) : 0;
    note(l + ': ' + (Object.keys(en).length - missing.length) + '/' + Object.keys(en).length + ' keys translated (' + pct + ' %)' + (missing.length ? ', missing ' + missing.length : ''));
    if (SHOW_MISSING) { missing.forEach((k) => console.log('     missing ' + l + ': ' + k)); }
});

/* ---- keys used in index.html */
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
const used = new Set();
html.replace(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g, (_, k) => { used.add(k); });
used.forEach((k) => { if (!(k in en)) { fail('index.html: data-i18n key "' + k + '" is not in en.js'); } });

/* ---- keys used in JS modules that speak through VTI18n */
const areas = new Set(Object.keys(en).map((k) => k.split('.')[0]));
const plural = (k) => (k + '.other') in en || (k + '.one') in en;
fs.readdirSync(JS).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js')).forEach((f) => {
    const src = fs.readFileSync(path.join(JS, f), 'latin1');
    if (src.indexOf('VTI18n') < 0 || f === 'vt_i18n.js') { return; }
    const re = /'([a-z][a-z0-9]*(?:\.[a-z0-9_]+)+)'/g;
    let m;
    while ((m = re.exec(src))) {
        const k = m[1];
        if (!areas.has(k.split('.')[0]) || /\.(js|css|md|json|html)$/.test(k)) { continue; }
        used.add(k);
        if (!(k in en) && !plural(k)) { fail(f + ': key "' + k + '" is not in en.js'); }
    }
});

/* ---- vt_i18n.js itself: fallback and plurals */
(function () {
    const store = {};
    const win = { VT_I18N_DICT: {
        en: { 'a.one': 'A', 'a.two': 'B {x}', 'n.jobs.one': '{n} job', 'n.jobs.other': '{n} jobs' },
        cs: { 'a.one': 'Á', 'n.jobs.one': '{n} úloha', 'n.jobs.few': '{n} úlohy', 'n.jobs.other': '{n} úloh' }
    } };
    const doc = { readyState: 'complete', documentElement: { setAttribute() {} }, querySelectorAll: () => [],
                  addEventListener() {}, dispatchEvent() {} };
    win.document = doc;
    const ctx = vm.createContext({ window: win, document: doc, console: { debug() {}, error() {} }, Intl, Promise,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
    try { vm.runInContext(fs.readFileSync(path.join(JS, 'vt_i18n.js'), 'utf8'), ctx); } catch (e) { fail('vt_i18n.js does not load: ' + e.message); return; }
    const I = win.VTI18n;
    const eq = (got, want, what) => { if (got !== want) { fail('vt_i18n: ' + what + ' → "' + got + '", want "' + want + '"'); } };
    eq(I.lang(), 'en', 'default language');
    eq(I.t('a.two', { x: 7 }), 'B 7', 'en placeholder');
    I.setLang('cs').catch(() => {});
    eq(I.lang(), 'cs', 'setLang(cs)');
    eq(store.vitulus_lang, 'cs', 'setLang stores vitulus_lang');
    eq(I.t('a.one'), 'Á', 'cs text');
    eq(I.t('a.two', { x: 1 }), 'B 1', 'cs missing → en');
    eq(I.t('no.such.key'), 'no.such.key', 'missing everywhere → key');
    eq(I.tn('n.jobs', 1), '1 úloha', 'cs plural one');
    eq(I.tn('n.jobs', 3), '3 úlohy', 'cs plural few');
    eq(I.tn('n.jobs', 5), '5 úloh', 'cs plural other');
    I.setLang('en').catch(() => {});
    eq(I.tn('n.jobs', 2), '2 jobs', 'en plural other');
})();

/* ---- help: docs/help/<lang>/*.md */
const MD = require(path.join(JS, 'vt_help_md.js'));
const readTopics = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith('.md') && f.toUpperCase() !== 'README.MD').sort()
    .map((f) => MD.parse(f, fs.readFileSync(path.join(dir, f), 'utf8')));
const base = readTopics(HELP);
const baseById = Object.fromEntries(base.map((d) => [d.id, d]));
const uiKeys = (d) => d.meta.ui.map((k) => k.split('#')[0]).sort().join(',');
LANGS.forEach((l) => {
    const dir = path.join(HELP, l);
    const tr = readTopics(dir);
    tr.forEach((d) => {
        const f = l + '/' + d.file;
        const e = baseById[d.id];
        if (!e) { fail('docs/help/' + f + ': no English topic ' + d.id + '.md (English is the source)'); return; }
        if (d.id + '.md' !== d.file) { fail('docs/help/' + f + ': id "' + d.id + '" is not the file name'); }
        ['title', 'group', 'summary'].forEach((k) => { if (!d.meta[k]) { fail('docs/help/' + f + ': front matter has no ' + k); } });
        if (d.meta.group !== e.meta.group) { fail('docs/help/' + f + ': group "' + d.meta.group + '" ≠ English "' + e.meta.group + '" (groups are keys — keep them English)'); }
        if (GROUPS.indexOf(d.meta.group) < 0) { fail('docs/help/' + f + ': unknown group'); }
        if (uiKeys(d) !== uiKeys(e)) { fail('docs/help/' + f + ': ui keys [' + uiKeys(d) + '] ≠ English [' + uiKeys(e) + ']'); }
    });
    // the help as the pane shows it in this language
    const merged = MD.merge(readTopics(HELP), readTopics(dir), l);
    const byId = Object.fromEntries(merged.map((d) => [d.id, d]));
    const anchors = (id) => new Set(byId[id].headings.map((h) => h.id));
    if (merged.length !== base.length) { fail('merge(' + l + '): ' + merged.length + ' topics, English has ' + base.length); }
    merged.forEach((d) => {
        const translated = tr.some((x) => x.id === d.id);
        if (translated && (d.lang !== l || d.untranslated)) { fail('merge(' + l + '): ' + d.id + ' should be the ' + l + ' topic'); }
        if (!translated && (d.lang !== 'en' || !d.untranslated)) { fail('merge(' + l + '): ' + d.id + ' should fall back to English (marked untranslated)'); }
        if (!translated) { return; }
        const f = 'docs/help/' + l + '/' + d.file;
        d.meta.ui.forEach((k) => { const p = k.split('#'); if (p[1] && !anchors(d.id).has(p[1])) { fail(f + ': ui key ' + k + ' points to a missing heading'); } });
        d.links.forEach((t) => {
            if (t.help === undefined) { return; }
            const id = t.help || d.id;
            if (!byId[id]) { fail(f + ': link to a missing topic ' + id + '.md'); return; }
            if (t.anchor && !anchors(id).has(t.anchor)) { fail(f + ': link to a missing heading ' + id + '.md#' + t.anchor + (byId[id].lang === l ? ' (that topic is translated: use its ' + l + ' anchor)' : '')); }
        });
        (d.html.match(/<img [^>]*src="([^"]+)"/g) || []).forEach((tag) => {
            const src = /src="([^"]+)"/.exec(tag)[1];
            const disk = src.startsWith('/help/') ? path.join(HELP, src.slice(6)) : path.join(TPL, src.slice(1));
            if (!fs.existsSync(disk)) { fail(f + ': image does not exist ' + src); }
        });
        d.meta.related.forEach((r) => { if (!byId[r]) { fail(f + ': related topic ' + r + ' does not exist'); } });
    });
    // no merge without translations: everything English
    const none = MD.merge(readTopics(HELP), [], l);
    if (none.some((d) => d.lang !== 'en')) { fail('merge(' + l + ') without translations is not all English'); }
    const untr = merged.filter((d) => d.untranslated).map((d) => d.id);
    note('help ' + l + ': ' + (merged.length - untr.length) + '/' + merged.length + ' topics translated' + (untr.length ? ' (English: ' + untr.join(', ') + ')' : ''));
});

/* ---- hard-coded English left without i18n (heuristic, REPORT only)
 *   index.html: a text node whose element has no data-i18n, a title /
 *   placeholder / aria-label without its data-i18n-<attr>;
 *   JS modules loaded by index.html: a string literal that looks like English
 *   words for a person (≥ 2 words, or one capitalised word in a text-ish
 *   context) on a line that does not go through t()/tn()/tag().
 *   --hardcoded lists every hit; the summary line always prints.
 *   Allowed as they are (technical, data, brand): ALLOW below. */
const SHOW_HARD = process.argv.includes('--hardcoded');
const ALLOW = new Set(['VITULUS', 'Vitulus', 'RTK', 'GPS', 'GNSS', 'IMU', 'ROS', 'EKF', 'D435', 'NUC', 'FPS', 'UTM', 'RTAB-Map', 'RtabMap',
    'rosbag', 'Wi-Fi', 'WiFi', 'English', 'Čeština', 'OK', 'Hz', 'Nm', 'RPM', 'rpm', 'SMACH', 'MBF', 'TF', 'JSON', 'YAML', 'PGM', 'PNG', 'SVG',
    'GitHub', 'Discord', 'Claude', 'Codex', 'Hermes', 'DeepSeek', 'Opus', 'Sonnet', 'Haiku', 'lidar', 'Lidar', 'RGB-D', 'x', 'y', 'z', 'yaw', 'Yaw']);
const enWords = /\b(the|a|an|to|of|is|are|no|not|on|off|and|or|for|with|from|in|at|by|this|that|it|be|was|all|new|save|load|start|stop|map|dock|robot|zone|path|point|delete|cancel|close|open|show|hide|loading|error|failed|waiting|ready|set|reset|edit|add|remove|name|speed|mode|status|none|unknown|connected|disconnected|saved|apply|send|done|running|idle|enabled|disabled|clear|refresh|back|next|yes)\b/i;
function looksText(s) {
    s = s.trim();
    if (s.length < 2 || !/[A-Za-z]{2,}/.test(s)) { return false; }
    if (ALLOW.has(s)) { return false; }
    if (/^[\w.\-\/#:]+$/.test(s) && !/^[A-Z][a-z]+$/.test(s) && !/^[A-Z]{2,}$/.test(s)) { return false; }  // ids, paths, keys
    if (/[{};=<>]|=>|\$\{|px\b|rgba?\(|var\(--|^\.|^#|\.(js|css|png|svg|json|yaml|md|html)\b|^\/|https?:|^[a-z_]+\(|^[a-z]+:[a-z]/.test(s)) { return false; }
    const words = s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    if (words.every((w) => ALLOW.has(w.replace(/[^\w\-]/g, '')) || /^[^A-Za-z]*$/.test(w))) { return false; }
    if (words.length >= 2) { return enWords.test(s) || /^[A-Z][a-z]/.test(s); }
    return /^[A-Z][a-z]{2,}[.…:!?]?$/.test(s) || /^[A-Z]{2,}$/.test(s);
}
const hard = { html: [], js: {} };
(function () {
    const body = html.slice(html.indexOf('<body'));
    // strip <script>/<style> blocks and comments, keep line numbers
    const clean = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' ')).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    const off = html.slice(0, html.indexOf('<body')).split('\n').length - 1;
    const lineOf = (i) => off + clean.slice(0, i).split('\n').length;
    const stack = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
    const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'param', 'track']);
    let m;
    while ((m = re.exec(clean))) {
        if (m[4] !== undefined) {
            const txt = m[4].replace(/&nbsp;|&#?\w+;/g, ' ').trim();
            const top = stack[stack.length - 1];
            if (txt && looksText(txt) && !(top && top.i18n)) { hard.html.push(lineOf(m.index) + ': "' + txt.slice(0, 70) + '"'); }
            continue;
        }
        const tagName = m[2].toLowerCase(), attrs = m[3];
        if (m[1]) { while (stack.length && stack.pop().tag !== tagName) { /* unclosed */ } continue; }
        ['title', 'placeholder', 'aria-label'].forEach((a) => {
            const v = new RegExp('\\s' + a + '="([^"]*)"').exec(attrs);
            if (v && looksText(v[1]) && attrs.indexOf('data-i18n-' + a + '=') < 0) { hard.html.push(lineOf(m.index) + ': ' + a + '="' + v[1].slice(0, 60) + '"'); }
        });
        if (!VOID.has(tagName) && !/\/\s*$/.test(attrs)) { stack.push({ tag: tagName, i18n: /\sdata-i18n="/.test(attrs) }); }
    }
})();
(function () {
    const loaded = [];
    html.replace(/<script src="\/assets\/js\/([\w.\/-]+\.js)"/g, (_, f) => { loaded.push(f); });
    const LIBS = new Set(['three.js', 'easeljs.js', 'eventemitter2.js', 'roslib.js', 'ros3d.js', 'nipplejs.js', 'mjpegcanvas.js', 'vt_i18n.js', 'vt_help_md.js']);
    loaded.filter((f) => !LIBS.has(f) && !f.startsWith('i18n/')).forEach((f) => {
        const lines = fs.readFileSync(path.join(JS, f), 'utf8').split('\n');
        let inC = false;
        lines.forEach((ln, i) => {
            let s = ln;
            if (inC) { const e = s.indexOf('*/'); if (e < 0) { return; } s = s.slice(e + 2); inC = false; }
            s = s.replace(/\/\*.*?\*\//g, '');
            const c = s.indexOf('/*'); if (c >= 0) { inC = true; s = s.slice(0, c); }
            if (/^\s*\/\//.test(s) || /console\.|throw |new Error|querySelector|getElementById|addEventListener|classList|localStorage|\.on\(|\.emit\(|ROSLIB|messageType|serviceType|name:\s*'\//.test(s)) { return; }
            s = s.replace(/\b(?:t|tn|tag|_t|T)\s*\(\s*'[^']*'/g, '').replace(/VTI18n\.\w+\([^)]*\)/g, '');
            const lit = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`/g;
            let mm;
            while ((mm = lit.exec(s))) {
                let v = mm[1] !== undefined ? mm[1] : (mm[2] !== undefined ? mm[2] : mm[3]);
                // text between tags inside an HTML template string
                const parts = /[<>]/.test(v) ? (v.match(/>([^<>]+)</g) || []).map((x) => x.slice(1, -1)) : [v];
                parts.forEach((p) => {
                    p = p.replace(/\\u2026|\\u00a0|&nbsp;|&\w+;/g, ' ');
                    if (looksText(p)) { (hard.js[f] = hard.js[f] || []).push((i + 1) + ': "' + p.trim().slice(0, 70) + '"'); }
                });
            }
        });
    });
})();
const jsHard = Object.values(hard.js).reduce((a, l) => a + l.length, 0);
note('hard-coded English (heuristic): index.html ' + hard.html.length + ', JS ' + jsHard +
    (jsHard ? ' (' + Object.entries(hard.js).sort((a, b) => b[1].length - a[1].length).map(([f, l]) => f + ' ' + l.length).join(', ') + ')' : '') +
    (SHOW_HARD ? '' : ' — --hardcoded lists them'));
if (SHOW_HARD) {
    hard.html.forEach((h) => console.log('     index.html:' + h));
    Object.entries(hard.js).forEach(([f, l]) => l.forEach((h) => console.log('     ' + f + ':' + h)));
}

console.log((fails ? 'FAILED ' + fails : 'OK') + ' — ' + Object.keys(en).length + ' en keys, ' + used.size + ' used in index.html / JS');
process.exit(fails ? 1 : 0);
