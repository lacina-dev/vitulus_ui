#!/usr/bin/env node
/*
 * The help is the documentation (docs/help/*.md, drawn by assets/js/vt_help.js).
 * This keeps it whole:
 *
 *     node tools/test_help_docs.node.js
 *
 * Fails when
 *   - a file has no id / title / group / summary, or its id is not its file name;
 *   - a link to another topic or to a heading (x.md#anchor, #anchor) is dead;
 *   - an image (img/…, ../../nodes/templates/assets/…) does not exist — in
 *     an English topic or a translation (docs/help/cs/) — or a help picture
 *     has no alt text, or img/ has a picture no topic shows, one bigger than
 *     400 kB or not svg / png / webp / jpg;
 *   - a "related:" topic does not exist;
 *   - a "ui:" key is claimed by two topics, or its #anchor is dead;
 *   - a panel, a tab of a panel (index.html, agent_chat.js TAB_ORDER,
 *     vt_support.js TABS) or a help spot that vt_help.js opens has no topic
 *     ("ui:" key) — i.e. a new panel / tab without help;
 *   - the Markdown renderer lets raw HTML through.
 * See docs/help/README.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HELP = path.join(ROOT, 'docs', 'help');
const TPL = path.join(ROOT, 'nodes', 'templates');
const MD = require(path.join(TPL, 'assets', 'js', 'vt_help_md.js'));
const GROUPS = ['Start here', 'Robot', 'Using the UI', 'When something is wrong'];

let fails = 0;
function fail(msg) { fails++; console.log('FAIL ' + msg); }

/* ---- the topics */
const files = fs.readdirSync(HELP).filter((f) => f.endsWith('.md') && f.toUpperCase() !== 'README.MD').sort();
if (!files.length) { fail('no topics in docs/help'); }
const docs = {};
files.forEach((f) => {
    const d = MD.parse(f, fs.readFileSync(path.join(HELP, f), 'utf8'));
    if (docs[d.id]) { fail(f + ': duplicate id ' + d.id); }
    docs[d.id] = d;
    if (d.id + '.md' !== f) { fail(f + ': id "' + d.id + '" is not the file name'); }
    ['title', 'group', 'summary'].forEach((k) => { if (!d.meta[k]) { fail(f + ': front matter has no ' + k); } });
    if (d.meta.group && GROUPS.indexOf(d.meta.group) < 0) { fail(f + ': unknown group "' + d.meta.group + '" (' + GROUPS.join(', ') + ')'); }
    if (d.meta.icon && !/^la-[a-z0-9-]+$/.test(d.meta.icon)) { fail(f + ': icon must be a line-awesome class (la-…)'); }
});
const anchors = (id) => new Set(docs[id].headings.map((h) => h.id));

/* ---- images: every ![alt](src "caption") of a topic (en and every
   translation) must exist on disk, be served, and a help picture (img/…)
   needs an alt text; img/ holds no picture that nothing shows, none bigger
   than IMG_MAX, only web formats. */
const IMG_DIR = path.join(HELP, 'img');
const IMG_MAX = 400 * 1024;
const usedImgs = new Set();
function checkImages(file, text, dir) {
    const re = new RegExp(MD.IMG_RAW.source, 'g');
    let im;
    while ((im = re.exec(text))) {
        const alt = im[1], src = im[2];
        const u = MD.asset(src);
        if (!u) { fail(file + ': image path not served: ' + src); continue; }
        const disk = u.startsWith('/help/') ? path.join(HELP, u.slice(6)) : path.join(TPL, u.slice(1));
        if (!fs.existsSync(disk)) { fail(file + ': image does not exist ' + src); continue; }
        if (u.startsWith('/help/img/')) {
            usedImgs.add(u.slice(10));
            if (!alt.trim()) { fail(file + ': picture ' + src + ' has no alt text'); }
        }
    }
    void dir;
}
const CS = path.join(HELP, 'cs');
if (fs.existsSync(CS)) {
    fs.readdirSync(CS).filter((f) => f.endsWith('.md')).forEach((f) => { checkImages('cs/' + f, fs.readFileSync(path.join(CS, f), 'utf8'), CS); });
}

/* ---- links, images, related */
const lafont = fs.readFileSync(path.join(TPL, 'assets', 'fonts', 'line-awesome.min.css'), 'utf8');
Object.values(docs).forEach((d) => {
    d.links.forEach((t) => {
        if (t.help === undefined) { return; }
        const id = t.help || d.id;
        if (!docs[id]) { fail(d.file + ': link to a missing topic ' + id + '.md'); return; }
        if (t.anchor && !anchors(id).has(t.anchor)) { fail(d.file + ': link to a missing heading ' + id + '.md#' + t.anchor); }
    });
    const imgs = d.html.match(/<img [^>]*src="([^"]+)"/g) || [];
    imgs.forEach((tag) => {
        const src = /src="([^"]+)"/.exec(tag)[1];
        const disk = src.startsWith('/help/') ? path.join(HELP, src.slice(6)) : path.join(TPL, src.slice(1));
        if (!fs.existsSync(disk)) { fail(d.file + ': image does not exist ' + src); }
    });
    checkImages(d.file, fs.readFileSync(path.join(HELP, d.file), 'utf8'), HELP);
    d.meta.related.forEach((r) => { if (!docs[r]) { fail(d.file + ': related topic ' + r + ' does not exist'); } });
    if (d.meta.icon && lafont.indexOf('.' + d.meta.icon + ':before') < 0) { fail(d.file + ': icon ' + d.meta.icon + ' is not in line-awesome'); }
});

if (fs.existsSync(IMG_DIR)) {
    fs.readdirSync(IMG_DIR).forEach((f) => {
        const st = fs.statSync(path.join(IMG_DIR, f));
        if (st.isDirectory()) { return; }
        if (!/\.(svg|png|webp|jpe?g)$/i.test(f)) { fail('img/' + f + ': not a web picture (svg, png, webp, jpg)'); }
        if (st.size > IMG_MAX) { fail('img/' + f + ': ' + Math.round(st.size / 1024) + ' kB > ' + (IMG_MAX / 1024) + ' kB — optimise it'); }
        if (!usedImgs.has(f)) { fail('img/' + f + ': no topic shows it — remove it or use it'); }
    });
}

/* ---- ui keys */
const owner = {};
Object.values(docs).forEach((d) => {
    d.meta.ui.forEach((k) => {
        const p = k.split('#');
        if (owner[p[0]]) { fail('ui key "' + p[0] + '" claimed by ' + owner[p[0]] + ' and ' + d.id); }
        owner[p[0]] = d.id;
        if (p[1] && !anchors(d.id).has(p[1])) { fail(d.file + ': ui key ' + k + ' points to a missing heading'); }
    });
});

/* ---- what must have help: panels, their tabs, the help spots */
const need = new Set(['marker', 'map', 'program', 'config', 'editor', 'agent', 'needs', 'support']);
const html = fs.readFileSync(path.join(TPL, 'index.html'), 'utf8');
const hosts = { div_menu_map: 'map', div_menu_map_program: 'program', div_menu_config: 'config', div_menu_marker: 'marker', div_map_detail: 'editor' };
const starts = Object.keys(hosts).map((id) => ({ id, at: html.indexOf('id="' + id + '"') })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
const tabRe = /data-bs-toggle="tab"[^>]*href="#(tab[-_][\w-]+)"|href="#(tab[-_][\w-]+)"[^>]*data-bs-toggle="tab"/g;
let m;
while ((m = tabRe.exec(html))) {
    const pane = m[1] || m[2];
    const host = starts.filter((h) => h.at < m.index).pop();
    if (!host) { fail('tab #' + pane + ' outside any panel'); continue; }
    need.add(hosts[host.id] + '/' + pane.replace(/^tab[-_]/, ''));
}
const agentSrc = fs.readFileSync(path.join(TPL, 'assets', 'js', 'agent_chat.js'), 'latin1');
const to = /var TAB_ORDER = \[([^\]]+)\]/.exec(agentSrc);
if (!to) { fail('agent_chat.js: TAB_ORDER not found'); } else { to[1].replace(/'(\w+)'/g, (_, t) => { need.add('agent/' + t); }); }
const supSrc = fs.readFileSync(path.join(TPL, 'assets', 'js', 'vt_support.js'), 'utf8');
const st = /var TABS = \[(.+)\];/.exec(supSrc);
if (!st) { fail('vt_support.js: TABS not found'); } else { st[1].replace(/\['(\w+)'/g, (_, t) => { need.add('support/' + t); }); }
const helpSrc = fs.readFileSync(path.join(TPL, 'assets', 'js', 'vt_help.js'), 'utf8');
helpSrc.replace(/toggle\('([\w/]+)'\)/g, (_, k) => { need.add(k); });
need.forEach((k) => { if (!owner[k]) { fail('no help topic for "' + k + '" — add it to "ui:" of a docs/help/*.md'); } });

/* ---- the renderer escapes */
const evil = MD.parse('x.md', '---\nid: x\n---\n<script>alert(1)</script> **b** [a](javascript:alert(1)) ![i](http://e/x.png)\n> [!TIP]\n> <img src=x onerror=1>\n');
if (/<script|<img src=x|javascript:/i.test(evil.html)) { fail('renderer lets raw HTML / javascript: links through: ' + evil.html); }
const evil2 = MD.parse('y.md', '---\nid: y\n---\n![a\" onerror=\"x](img/frame.svg \"<script>x</script>\")\n\n![b](img/frame.svg \"c <b>\") ![c](javascript:alert(1))\n\nt ![d](img/frame.svg \"e\" onload=\"x\")\n');
if (/<script|<b>|javascript:|" on(error|load)=/i.test(evil2.html)) { fail('renderer lets raw HTML through an image / caption: ' + evil2.html); }
const fig = MD.parse('z.md', '---\nid: z\n---\n![A](img/frame.svg \"Cap\")\n\n![B](img/frame.svg) ![C](img/frame.svg)\n');
if (!/<figure class="vth-fig vth-zoom"><img [^>]*alt="A"[^>]*><figcaption>Cap<\/figcaption><\/figure>/.test(fig.html) || !/<div class="vth-figs" data-n="2">/.test(fig.html)) {
    fail('renderer: a paragraph of images is not a figure / a grid: ' + fig.html);
}

const n = Object.keys(docs).length;
console.log((fails ? 'FAILED ' + fails : 'OK') + ' — ' + n + ' topics, ' + Object.keys(owner).length + ' ui keys, ' + need.size + ' required');
process.exit(fails ? 1 : 0);
