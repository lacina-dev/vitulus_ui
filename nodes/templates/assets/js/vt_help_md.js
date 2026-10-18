/* vt_help_md.js — the small Markdown dialect of the help (docs/help/*.md).
 *
 * The help IS the documentation: the same .md files read in git are drawn by
 * the help panel (vt_help.js). This file turns one file into
 *   { id, file, meta: {title, group, order, summary, icon, ui: [...], related: [...]},
 *     html, headings: [{level, text, id}], blocks: [{id, heading, text}] }
 * and is shared with the node test (tools/test_help_docs.node.js).
 *
 * Dialect (GitHub-compatible, so the files also read well on GitHub/gitea):
 *   front matter  ---  key: value  /  key: [a, b]  ---
 *   # ## ###      headings, anchors = GitHub slugs (dock.md#how-do-i-undock)
 *   - / 1.        lists (two-space indent = one nested level)
 *   > [!TIP] / [!NOTE] / [!WARNING] / [!CAUTION]   callouts (GitHub alerts)
 *   | a | b |     tables
 *   ```flow       a step diagram: one step per line, "Title | detail",
 *                 optional tone prefix "ok:" "warn:" "err:" "info:"
 *   **b** *i* `code` [text](x.md#anchor) ![alt](img/x.svg)
 * Links: "x.md#a" → another help section, "#a" → this one, http(s) → new tab,
 * "img/…" → /help/img/…, "../../nodes/templates/assets/…" → /assets/…
 * Every piece of text is HTML-escaped first; nothing in a file can inject
 * markup (raw HTML shows as text).
 */
(function (root) {
    'use strict';

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    /* GitHub heading slug: lower case, drop punctuation, spaces → "-" */
    function slug(text) {
        return String(text).toLowerCase().trim()
            .replace(/[`*_]/g, '')
            .replace(/[^\p{L}\p{N}\s-]/gu, '')
            .replace(/\s/g, '-');
    }
    function fold(s) {   // case + diacritics folding for the search
        return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    function parseMeta(text) {
        var meta = {}, body = text;
        var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
        if (m) {
            body = text.slice(m[0].length);
            m[1].split(/\r?\n/).forEach(function (line) {
                var kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
                if (!kv) { return; }
                var v = kv[2].trim();
                if (/^\[.*\]$/.test(v)) {
                    v = v.slice(1, -1).split(',').map(function (x) { return x.trim().replace(/^["']|["']$/g, ''); })
                        .filter(function (x) { return x; });
                } else {
                    v = v.replace(/^["']|["']$/g, '');
                    if (/^-?\d+$/.test(v)) { v = parseInt(v, 10); }
                }
                meta[kv[1]] = v;
            });
        }
        return { meta: meta, body: body };
    }

    /* link target → {href, help, ext} */
    function target(href) {
        href = String(href || '').trim();
        if (/^https?:\/\//i.test(href)) { return { href: href, ext: true }; }
        var hm = /^(?:\.\/)?([\w-]+)\.md(?:#([\w\p{L}-]+))?$/u.exec(href);
        if (hm) { return { href: '#help/' + hm[1] + (hm[2] ? '/' + hm[2] : ''), help: hm[1], anchor: hm[2] || '' }; }
        var am = /^#([\w\p{L}-]+)$/u.exec(href);
        if (am) { return { href: href, help: '', anchor: am[1] }; }
        return { href: asset(href), plain: true };
    }
    function asset(src) {
        src = String(src || '').trim();
        if (/^img\//.test(src)) { return '/help/' + src; }
        if (/^\.\.\/img\//.test(src)) { return '/help/' + src.slice(3); }   // from docs/help/<lang>/
        var a = /^(?:\.\.\/)+nodes\/templates\/(assets\/.*)$/.exec(src);
        if (a) { return '/' + a[1]; }
        if (/^\/(assets|help)\//.test(src)) { return src; }
        return '';
    }

    /* inline: escape, then code spans, images, links, bold, italic */
    function inline(s, links) {
        var codes = [];
        s = String(s).replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
        s = esc(s);
        s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, src) {
            var u = asset(src.replace(/&amp;/g, '&'));
            if (!u) { return alt; }
            return '<img class="vth-img" src="' + u + '" alt="' + alt + '" loading="lazy">';
        });
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, txt, href) {
            var t = target(href.replace(/&amp;/g, '&'));
            if (links) { links.push(t); }
            if (t.ext) { return '<a href="' + esc(t.href) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>'; }
            if (t.help !== undefined) {
                return '<a href="' + esc(t.href) + '" class="vth-link" data-help="' + esc(t.help) + '" data-anchor="' + esc(t.anchor) + '">' + txt + '</a>';
            }
            return t.href ? '<a href="' + esc(t.href) + '" target="_blank" rel="noopener">' + txt + '</a>' : txt;
        });
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
        s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
        return s;
    }
    function plain(s) {
        return String(s).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/[*`]/g, '').replace(/^>\s?\[![A-Z]+\]\s*/, '');
    }

    /* a table cell that is just a colour name gets a swatch of the UI's tone */
    var SWATCH = { green: 'ok', orange: 'warn', red: 'err', grey: 'off', gray: 'off' };
    var CALLOUT = { TIP: ['ok', 'Tip'], NOTE: ['info', 'Note'], IMPORTANT: ['info', 'Important'],
                    WARNING: ['warn', 'Careful'], CAUTION: ['err', 'Danger'] };

    function flow(lines) {
        var steps = lines.filter(function (l) { return l.trim(); }).map(function (l) {
            var tone = '', m = /^\s*(ok|warn|err|info|off):\s*/.exec(l);
            if (m) { tone = m[1]; l = l.slice(m[0].length); }
            var parts = l.split('|');
            return '<li class="vth-step"' + (tone ? ' data-state="' + tone + '"' : '') + '><span class="vth-step-t">' +
                inline(parts[0].trim()) + '</span>' + (parts[1] ? '<span class="vth-step-d">' + inline(parts.slice(1).join('|').trim()) + '</span>' : '') + '</li>';
        });
        return '<ol class="vth-flow">' + steps.join('') + '</ol>';
    }

    function table(rows, links) {
        var cells = function (r) { return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(rows[0]);
        var out = '<div class="vth-tablewrap"><table class="vth-table"><thead><tr>' +
            head.map(function (c) { return '<th>' + inline(c, links) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.slice(2).forEach(function (r) {
            out += '<tr>' + cells(r).map(function (c) {
                var sw = SWATCH[c.toLowerCase()];
                return '<td>' + (sw ? '<span class="vth-sw" data-state="' + sw + '"></span>' : '') + inline(c, links) + '</td>';
            }).join('') + '</tr>';
        });
        return out + '</tbody></table></div>';
    }

    function render(body, links) {
        var L = body.split(/\r?\n/), i = 0, out = [], headings = [], blocks = [], used = {};
        var cur = { id: '', heading: '', text: [] };
        blocks.push(cur);
        function addText(t) { cur.text.push(plain(t)); }
        while (i < L.length) {
            var line = L[i];
            if (/^```/.test(line)) {
                var lang = line.slice(3).trim(), buf = [];
                i++;
                while (i < L.length && !/^```/.test(L[i])) { buf.push(L[i]); i++; }
                i++;
                if (lang === 'flow') { out.push(flow(buf)); buf.forEach(function (b) { addText(b.replace(/^\w+:\s*/, '').replace('|', ' ')); }); }
                else { out.push('<pre class="vth-pre"><code>' + esc(buf.join('\n')) + '</code></pre>'); addText(buf.join(' ')); }
                continue;
            }
            var h = /^(#{1,4})\s+(.*)$/.exec(line);
            if (h) {
                var lv = h[1].length, txt = h[2].trim(), id = slug(plain(txt));
                if (used[id] !== undefined) { used[id]++; id += '-' + used[id]; } else { used[id] = 0; }
                headings.push({ level: lv, text: plain(txt), id: id });
                if (lv > 1) {   // the file's "# Title" is the panel's own title
                    out.push('<h' + (lv + 1) + ' id="vth-' + esc(id) + '" class="vth-h' + lv + '">' + inline(txt, links) + '</h' + (lv + 1) + '>');
                }
                if (lv <= 3) { cur = { id: id, heading: plain(txt), text: [] }; blocks.push(cur); }
                i++; continue;
            }
            if (/^\s*>/.test(line)) {
                var q = [];
                while (i < L.length && /^\s*>/.test(L[i])) { q.push(L[i].replace(/^\s*>\s?/, '')); i++; }
                var cm = /^\[!([A-Z]+)\]\s*(.*)$/.exec(q[0] || ''), kind = cm && CALLOUT[cm[1]];
                if (kind) { q[0] = cm[2]; }
                var inner = render(q.join('\n'), links);   // lists etc. inside a callout
                inner.blocks.forEach(function (b) { addText(b.text); });
                out.push('<div class="vth-callout"' + (kind ? ' data-state="' + kind[0] + '"' : '') + '>' +
                    (kind ? '<span class="vth-callout-k">' + kind[1] + '</span>' : '') + inner.html + '</div>');
                continue;
            }
            if (/^\s*\|/.test(line) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
                var rows = [];
                while (i < L.length && /^\s*\|/.test(L[i])) { rows.push(L[i]); i++; }
                rows.forEach(function (r, k) { if (k !== 1) { addText(r.replace(/\|/g, ' ')); } });
                out.push(table(rows, links));
                continue;
            }
            var li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
            if (li) {
                var ordered = /\d/.test(li[2]), items = [];
                while (i < L.length) {
                    var m2 = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(L[i]);
                    if (m2) {
                        if (m2[1].length >= 2 && items.length) { items[items.length - 1].sub.push(m2[3]); }
                        else { items.push({ t: m2[3], sub: [], subOrd: false }); }
                        if (m2[1].length >= 2) { items[items.length - 1].subOrd = /\d/.test(m2[2]); }
                        i++; continue;
                    }
                    if (/^\s{2,}\S/.test(L[i]) && items.length) {   // continuation line
                        var last = items[items.length - 1];
                        if (last.sub.length) { last.sub[last.sub.length - 1] += ' ' + L[i].trim(); } else { last.t += ' ' + L[i].trim(); }
                        i++; continue;
                    }
                    break;
                }
                var tag = ordered ? 'ol' : 'ul';
                out.push('<' + tag + ' class="vth-list">' + items.map(function (it) {
                    addText(it.t); it.sub.forEach(addText);
                    var st = it.subOrd ? 'ol' : 'ul';
                    return '<li>' + inline(it.t, links) + (it.sub.length ? '<' + st + ' class="vth-list">' + it.sub.map(function (s) { return '<li>' + inline(s, links) + '</li>'; }).join('') + '</' + st + '>' : '') + '</li>';
                }).join('') + '</' + tag + '>');
                continue;
            }
            if (!line.trim()) { i++; continue; }
            var para = [];
            while (i < L.length && L[i].trim() && !/^(#{1,4}\s|```|\s*>|\s*([-*]|\d+\.)\s|\s*\|)/.test(L[i])) { para.push(L[i].trim()); i++; }
            if (!para.length) { para.push(line.trim()); i++; }
            addText(para.join(' '));
            out.push('<p>' + inline(para.join(' '), links) + '</p>');
        }
        blocks.forEach(function (b) { b.text = b.text.join(' '); });
        return { html: out.join('\n'), headings: headings, blocks: blocks.filter(function (b) { return b.text || b.heading; }) };
    }

    function parse(file, text) {
        var pm = parseMeta(text), links = [];
        var r = render(pm.body, links);
        var meta = pm.meta;
        if (!meta.title) { var h1 = r.headings.filter(function (h) { return h.level === 1; })[0]; meta.title = h1 ? h1.text : file; }
        ['ui', 'related', 'keywords'].forEach(function (k) {
            if (meta[k] && !Array.isArray(meta[k])) { meta[k] = [String(meta[k])]; }
            if (!meta[k]) { meta[k] = []; }
        });
        return { id: meta.id || String(file).replace(/\.md$/, ''), file: file, meta: meta,
                 html: r.html, headings: r.headings, blocks: r.blocks, links: links };
    }

    /* Language of the help: `base` = the parsed English topics, `tr` = the
       parsed topics of docs/help/<lang>/. A translation replaces the English
       topic with the same id; every other topic stays English and is marked
       untranslated (d.lang = 'en', d.untranslated = true). A translation
       without an English topic is dropped (English is the source). */
    function merge(base, tr, lang) {
        var by = {};
        (tr || []).forEach(function (d) { if (d && d.id) { by[d.id] = d; } });
        return (base || []).map(function (d) {
            var x = lang && lang !== 'en' ? by[d.id] : null;
            if (x) { x.lang = lang; x.untranslated = false; x.source = d; return x; }
            d.lang = 'en';
            d.untranslated = !!(lang && lang !== 'en');
            return d;
        });
    }

    var api = { parse: parse, slug: slug, fold: fold, esc: esc, asset: asset, merge: merge };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    else { root.VTHelpMd = api; }
})(typeof window !== 'undefined' ? window : this);
