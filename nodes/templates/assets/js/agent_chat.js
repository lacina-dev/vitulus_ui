/*
 * agent_chat.js — the Vitulus Agent as a first-class panel of the robot UI.
 *
 * 2026-08-23: re-homed from a floating window into the left #ui_drawer, the
 * same drawer Marker/Map/Programs/Settings live in.  This file is the panel
 * SHELL: it owns the drawer mount, the toolbar toggle + unread badge, the
 * connection state, the STOP button, and a small block registry
 * (window.VAgent) that further blocks plug into — agent_blocks.js adds more
 * (robot state, mapview, …) without touching this file.
 *
 * Transport is HTTP to the agent web bridge on :8088 (CORS is open for this
 * origin, webchat.py).  The old rosbridge path (/vitulus_agent/ask) still
 * exists server-side; HTTP is used here because one transport, one poller and
 * one error state beat two of each.  This panel never commands the robot —
 * it carries text, and the red STOP, which is answered by the deterministic
 * core, never by a model.
 *
 * Styling: assets/css/agent_panel.css, Bootstrap variables only.
 */
(function () {
    'use strict';

    var AGENT_HTTP = 'http://' + location.hostname + ':8088';
    var LS_AUTHOR = 'vitulus_agent_author';
    var LS_OPEN = 'vitulus_agent_open';
    var LS_DENSITY = 'vitulus_agent_density';   // '' | 'compact'
    var LS_SCOPE = 'vitulus_agent_scope';       // 'all' | 'mine'
    var LS_SEEN = 'vitulus_agent_seen_id';      // last task id counted as read
    var LS_JOBS = 'vitulus_agent_jobs_hidden';  // job ids dismissed with the ×
    var DRAWER_SEC = 'vitulus_drawer_';         // same prefix mapping.js uses

    // Unique author per browser tab so replies can be matched to the messages
    // this panel sent; the display name is the human one, shared across tabs.
    var author = sessionStorage.getItem('vitulus_agent_author_id');
    if (!author) {
        author = 'webui:' + Math.random().toString(36).slice(2, 6);
        sessionStorage.setItem('vitulus_agent_author_id', author);
    }
    var displayName = lsGet(LS_AUTHOR) || '';

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

    // ------------------------------------------------------------ helpers
    function clock(ts) {
        var d = new Date((ts || 0) * 1000);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    function humanDuration(seconds) {
        if (!seconds || seconds < 0.5) { return ''; }
        if (seconds < 60) { return Math.round(seconds) + ' s'; }
        var m = Math.floor(seconds / 60);
        return m + ' min ' + Math.round(seconds - m * 60) + ' s';
    }

    var SNAP_RE = /\/api\/(?:snapshot|mapview)\/[0-9A-Za-z_.-]+\.(?:jpg|png)/;

    /* Minimal markdown, rendered by BUILDING DOM NODES — never innerHTML with
       reply text (arbitrary model output on the robot's own dashboard). */
    /* Commands the chat renders as CLICKABLE buttons (Robert: „ať příkazy
       /něco jsou v textu klikatelné a rovnou se provádějí").  A fixed list,
       not "any /word": reply text is full of paths (/home/vitulus/…) that
       must stay plain text.  `arg` = how many following tokens belong to it;
       `confirm` = one-tap inline „Opravdu?" before it runs (approvals and
       deletions are decisions; /stop is safe and runs at once). */
    var CLICK_CMDS = {
        status: {arg: 0}, health: {arg: 0}, stop: {arg: 0}, zastav: {arg: 0},
        ukoly: {arg: 0}, pokracuj: {arg: 1}, pokračuj: {arg: 1},
        explore: {arg: 0}, mapa: {arg: 0}, map: {arg: 0},
        allow: {arg: 1, confirm: true}, povol: {arg: 1, confirm: true},
        deny: {arg: 1, confirm: true}, zamitni: {arg: 1, confirm: true},
        zamítni: {arg: 1, confirm: true},
        clear: {arg: 0, confirm: true},
        ukol: {arg: 2, confirm: 'smaz'}, úkol: {arg: 2, confirm: 'smaz'}
    };
    var CMD_RE = /(^|[\s(,;:—-])(\/([a-záčďéěíňóřšťúůýž]+)((?:\s+[^\s,.;)]+){0,2}))(?=$|[\s,.;)])/g;
    /* „#63", „#j:63" (prompt job) and „#s:5" (scheduled/script job) — one
       unified ref namespace, all three land on the Jobs tab. */
    var REF_RE = /(^|[\s(,;:])(?:(práce|práci|job|úkol|úkolu)\s+)?#([js]:)?(\d{1,6})(?=$|[\s,.;:)])/gi;

    function cmdButton(text, needConfirm) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'vagent-cmdbtn';
        b.textContent = text;
        b.title = needConfirm ? 'Run (with confirmation)' : 'Run command';
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (needConfirm) { inlineConfirm(b, function () { submitText(text); openChatSection(); }); }
            else { submitText(text); openChatSection(); }
        });
        return b;
    }

    function refButton(id, label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'vagent-ref';
        b.textContent = label;
        b.title = 'Show job #' + String(id).replace(/^[js]:/, '');
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            highlightJob(id);
        });
        return b;
    }

    /* Plain-text segment → text nodes + command buttons + job refs. */
    function renderPlain(target, text) {
        var out = [], last = 0, m;
        CMD_RE.lastIndex = 0;
        while ((m = CMD_RE.exec(text)) !== null) {
            var name = m[3].toLowerCase(), spec = CLICK_CMDS[name];
            if (!spec) { continue; }
            var argTokens = (m[4] || '').trim().split(/\s+/).filter(Boolean).slice(0, spec.arg);
            var cmd = '/' + m[3] + (argTokens.length ? ' ' + argTokens.join(' ') : '');
            var start = m.index + m[1].length;
            out.push({start: start, end: start + cmd.length, cmd: cmd,
                      confirm: spec.confirm === true ||
                          (typeof spec.confirm === 'string' &&
                           argTokens[0] && argTokens[0].toLowerCase() === spec.confirm)});
            CMD_RE.lastIndex = start + cmd.length;
        }
        REF_RE.lastIndex = 0;
        while ((m = REF_RE.exec(text)) !== null) {
            var s = m.index + m[1].length;
            var overlaps = out.some(function (o) { return s < o.end && s + m[0].length > o.start; });
            if (overlaps) { continue; }
            out.push({start: s, end: m.index + m[0].length, ref: (m[3] || '') + m[4],
                      label: text.slice(s, m.index + m[0].length)});
        }
        out.sort(function (a, b) { return a.start - b.start; });
        out.forEach(function (o) {
            if (o.start < last) { return; }
            if (o.start > last) { target.appendChild(document.createTextNode(text.slice(last, o.start))); }
            target.appendChild(o.cmd ? cmdButton(o.cmd, o.confirm) : refButton(o.ref, o.label));
            last = o.end;
        });
        if (last < text.length) { target.appendChild(document.createTextNode(text.slice(last))); }
    }

    function renderInline(target, text) {
        var re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s"'<>]+)/g;
        var last = 0, m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) {
                renderPlain(target, text.slice(last, m.index));
            }
            var tok = m[0], el;
            if (tok.slice(0, 2) === '**') {
                el = document.createElement('strong');
                renderPlain(el, tok.slice(2, -2));
            } else if (tok.charAt(0) === '`') {
                var inner = tok.slice(1, -1);
                if (/^\/[a-záčďéěíňóřšťúůýž]+(\s|$)/.test(inner) &&
                        CLICK_CMDS[inner.split(/\s+/)[0].slice(1).toLowerCase()]) {
                    el = document.createElement('span');
                    renderPlain(el, inner);       // `/allow 5` in code → button too
                } else {
                    el = document.createElement('code');
                    el.textContent = inner;
                }
            } else {
                el = document.createElement('a');
                el.href = tok; el.target = '_blank'; el.rel = 'noopener';
                el.textContent = tok;
            }
            target.appendChild(el);
            last = m.index + tok.length;
        }
        if (last < text.length) {
            renderPlain(target, text.slice(last));
        }
    }

    /* One-tap inline confirmation instead of window.confirm (a browser
       dialog blocks the page and, with the extension, the whole session). */
    function inlineConfirm(anchor, onYes) {
        if (!anchor || anchor.nextSibling && anchor.nextSibling.className === 'vagent-confirm') { return; }
        var box = document.createElement('span');
        box.className = 'vagent-confirm';
        var q = document.createElement('span');
        q.textContent = 'Really?';
        var yes = document.createElement('button');
        yes.type = 'button'; yes.className = 'cy'; yes.textContent = 'Yes';
        var no = document.createElement('button');
        no.type = 'button'; no.className = 'cn'; no.textContent = 'No';
        box.appendChild(q); box.appendChild(yes); box.appendChild(no);
        function close() { if (box.parentNode) { box.remove(); } }
        yes.addEventListener('click', function (ev) { ev.stopPropagation(); close(); onYes(); });
        no.addEventListener('click', function (ev) { ev.stopPropagation(); close(); });
        anchor.insertAdjacentElement('afterend', box);
        setTimeout(close, 8000);
    }

    function renderMarkdown(target, text) {
        var lines = String(text || '').split('\n');
        var i = 0, list = null;
        while (i < lines.length) {
            var line = lines[i];
            if (/^```/.test(line)) {
                var buf = [];
                i += 1;
                while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
                i += 1;
                var pre = document.createElement('pre');
                pre.textContent = buf.join('\n');
                target.appendChild(pre);
                list = null;
                continue;
            }
            var bullet = /^\s*[-*]\s+(.*)$/.exec(line);
            if (bullet) {
                if (!list) { list = document.createElement('ul'); target.appendChild(list); }
                var li = document.createElement('li');
                renderInline(li, bullet[1]);
                list.appendChild(li);
                i += 1;
                continue;
            }
            list = null;
            if (i > 0) { target.appendChild(document.createElement('br')); }
            renderInline(target, line);
            i += 1;
        }
    }

    // -------------------------------------------------- connection + fetch
    var conn = {okTs: 0, failTs: 0};

    function api(path, opts) {
        opts = opts || {};
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, opts.timeout_ms || 8000) : null;
        var init = {cache: 'no-store', signal: ctl ? ctl.signal : undefined};
        if (opts.method) { init.method = opts.method; }
        if (opts.body !== undefined) {
            init.method = init.method || 'POST';
            init.headers = {'Content-Type': 'application/json'};
            init.body = JSON.stringify(opts.body);
        }
        return fetch(AGENT_HTTP + path, init).then(function (r) {
            if (timer) { clearTimeout(timer); }
            conn.okTs = Date.now();
            paintConn();
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            return r.json();
        }).catch(function (err) {
            if (timer) { clearTimeout(timer); }
            conn.failTs = Date.now();
            paintConn();
            throw err;
        });
    }

    function paintConn() {
        var dot = document.getElementById('vagent_dot');
        var age = document.getElementById('vagent_age');
        if (!dot) { return; }
        var since = conn.okTs ? (Date.now() - conn.okTs) / 1000 : Infinity;
        dot.className = since < 8 ? 'ok' : (since < 25 ? 'slow' : 'bad');
        if (age) {
            age.textContent = conn.okTs
                ? (since < 8 ? '' : Math.round(since) + ' s ago')
                : 'no connection';
            age.title = 'Age of the last successful connection to the agent (:8088)';
        }
    }

    // ------------------------------------------------------ unread badge
    var unread = 0;
    var baseTitle = null;

    function paintBadge() {
        var b = document.getElementById('vagent_badge');
        if (b) {
            b.textContent = unread > 99 ? '99+' : String(unread);
            b.style.display = unread > 0 ? '' : 'none';
        }
        if (baseTitle === null) { baseTitle = document.title; }
        document.title = (unread > 0 ? '(' + unread + ') ' : '') + baseTitle;
    }

    function notify(kind, text) {
        if (isVisible() && !document.hidden) { return; }
        unread += 1;
        paintBadge();
    }

    function clearUnread() {
        unread = 0;
        paintBadge();
    }

    // -------------------------------------------------------- block registry
    var blocks = [];        // [{id, title, order, render, poll, onOpen, el}]
    var built = false;

    function registerBlock(def) {
        if (!def || !def.id || typeof def.render !== 'function') { return; }
        for (var i = 0; i < blocks.length; i++) {
            if (blocks[i].id === def.id) { blocks.splice(i, 1); break; }
        }
        def.order = def.order === undefined ? 50 : def.order;
        blocks.push(def);
        blocks.sort(function (a, b) { return a.order - b.order; });
        if (built) { mountBlocks(); }
    }

    function wireDetails(d, name) {
        var key = DRAWER_SEC + name;      // mapping.js wireGroup ran before we
        var v = lsGet(key);               // existed, so wire ourselves, same key
        if (v === '1') { d.open = true; }
        else if (v === '0') { d.open = false; }
        d.addEventListener('toggle', function () { lsSet(key, d.open ? '1' : '0'); });
    }

    /* Tabs, not a stack: seven open sections in a 460 px column were one
       endless scroll.  Chat / Práce / Schválení / Robot get a tab each; the
       slower blocks (mise, zdraví, nástroje) live as cards under „Více". */
    /* 2026-08-24: Jobs and Tasks were two views of one thing (a job that runs
       once vs. a job that runs on a schedule), so they are ONE tab now. */
    var TAB_LABEL = {chat: 'Chat', jobs: 'Jobs', gate: 'Approvals',
                     robot: 'Robot', incidents: 'Incidents', vice: 'More'};
    var TAB_ORDER = ['chat', 'jobs', 'gate', 'robot', 'incidents', 'vice'];
    var LS_TAB = 'vitulus_agent_tab';
    var panes = {}, tabBtns = {};

    function tabFor(blockId) { return TAB_LABEL[blockId] ? blockId : 'vice'; }

    function ensureTab(tabId) {
        var tabs = panel.querySelector('#vagent_tabs');
        var body = panel.querySelector('#vagent_blocks');
        if (!panes[tabId]) {
            var pane = document.createElement('div');
            pane.className = 'vagent-pane';
            pane.setAttribute('data-pane', tabId);
            pane.setAttribute('data-label', TAB_LABEL[tabId]);
            body.appendChild(pane);
            panes[tabId] = pane;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'vagent-tab';
            btn.setAttribute('data-tab', tabId);
            btn.textContent = TAB_LABEL[tabId];
            btn.addEventListener('click', function () { activateTab(tabId); });
            // keep the visual order stable however late a block registers
            var after = null;
            for (var i = TAB_ORDER.indexOf(tabId) + 1; i < TAB_ORDER.length; i++) {
                if (tabBtns[TAB_ORDER[i]]) { after = tabBtns[TAB_ORDER[i]]; break; }
            }
            tabs.insertBefore(btn, after);
            tabBtns[tabId] = btn;
        }
        return panes[tabId];
    }

    function activateTab(tabId) {
        if (!panes[tabId]) { tabId = 'chat'; }
        if (!panes[tabId]) { return; }
        Object.keys(panes).forEach(function (id) {
            panes[id].classList.toggle('active', id === tabId);
            tabBtns[id].classList.toggle('active', id === tabId);
        });
        tabBtns[tabId].classList.remove('attention');
        lsSet(LS_TAB, tabId);
        blocks.forEach(function (blk) {
            if (tabFor(blk.id) === tabId && blk.onOpen && blk.body) {
                try { blk.onOpen(blk.body); } catch (e) {}
            }
        });
        if (tabId === 'chat') { scrollChatBottom(); }
    }

    /* The chat opens LOOKING AT THE LAST MESSAGE, always: initial history
       load, tab switch, panel open, tab un-hiding.  Deferred twice so layout
       (and late images) have happened before the scroll is measured. */
    function scrollChatBottom() {
        function drop() { if (msgsEl) { msgsEl.scrollTop = msgsEl.scrollHeight; } }
        drop();
        if (window.requestAnimationFrame) {
            requestAnimationFrame(function () { requestAnimationFrame(drop); });
        } else { setTimeout(drop, 50); }
    }

    function flagTab(blockId) {
        var btn = tabBtns[tabFor(blockId)];
        if (btn && !btn.classList.contains('active')) { btn.classList.add('attention'); }
    }

    function mountBlocks() {
        var body = panel.querySelector('#vagent_blocks');
        if (!body) { return; }
        blocks.forEach(function (blk) {
            if (blk.el) { return; }
            var tabId = tabFor(blk.id);
            var pane = ensureTab(tabId);
            var host, inner;
            if (tabId === 'vice') {
                // „More": collapsible cards with memory, count badge in the heading.
                host = document.createElement('details');
                host.className = 'vagent-card';
                host.open = true;
                var h = document.createElement('summary');
                var ht = document.createElement('span');
                ht.className = 'ct';
                ht.textContent = blk.title || blk.id;
                h.appendChild(ht);
                if (blk.summaryExtra) { h.appendChild(blk.summaryExtra); }
                host.appendChild(h);
                inner = document.createElement('div');
                inner.className = 'vagent-sec-body';
                host.appendChild(inner);
                wireDetails(host, 'agent_more_' + blk.id);
            } else {
                host = document.createElement('div');
                host.className = 'vagent-sec-body vagent-pane-body';
                inner = host;
                if (blk.summaryExtra) { tabBtns[tabId].appendChild(blk.summaryExtra); }
            }
            pane.appendChild(host);
            blk.el = host;
            blk.body = inner;
            try { blk.render(inner); } catch (e) { inner.textContent = 'block failed: ' + e; }
        });
        activateTab(lsGet(LS_TAB) || 'chat');
    }

    // ------------------------------------------------------------ the panel
    var panel = document.createElement('div');
    panel.id = 'vagent_panel';
    panel.innerHTML =
        '<div id="vagent_bar">' +
        '<span id="vagent_dot"></span><span id="vagent_age"></span>' +
        '<span class="sp"></span>' +
        '<button id="vagent_density" type="button" title="Display density">▤</button>' +
        '<button id="vagent_clear" type="button" title="Clear view (history stays on the robot)">⌧</button>' +
        '<button id="vagent_stop" type="button" title="STOP — immediate stop, bypasses the queue and the model">STOP</button>' +
        '</div>' +
        '<div id="vagent_status"></div>' +
        '<div id="vagent_tabs"></div>' +
        '<div id="vagent_ctx"></div>' +
        '<div id="vagent_blocks"></div>';
    var panelActive = false;

    function isVisible() {
        return panelActive && !document.hidden;
    }

    // ------------------------------------------------------- drawer mount
    function drawerEls() {
        return {
            drawer: document.getElementById('ui_drawer'),
            body: document.getElementById('ui_drawer_body'),
            title: document.getElementById('ui_drawer_title'),
            backdrop: document.getElementById('ui_drawer_backdrop')
        };
    }

    /* One header row, not two: while the agent panel is active, our dot,
       age and buttons live inside the shared #ui_drawer_head; the moment the
       drawer belongs to anyone else they are taken back out.  The drawer is
       shared chrome — nothing of ours may survive a hand-over. */
    var headBits = null;

    function mergeHead() {
        var head = document.getElementById('ui_drawer_head');
        var title = document.getElementById('ui_drawer_title');
        if (!head || !title || headBits) { return; }
        var left = document.createElement('span');
        left.id = 'vagent_head_left';
        left.appendChild(panel.querySelector('#vagent_dot'));
        left.appendChild(panel.querySelector('#vagent_age'));
        title.insertAdjacentElement('afterend', left);
        var right = document.createElement('span');
        right.id = 'vagent_head_right';
        right.appendChild(panel.querySelector('#vagent_density'));
        right.appendChild(panel.querySelector('#vagent_clear'));
        right.appendChild(panel.querySelector('#vagent_stop'));
        var full = document.getElementById('btn_ui_drawer_full');
        if (full && full.parentNode === head) { head.insertBefore(right, full); }
        else { head.appendChild(right); }
        headBits = {left: left, right: right};
        panel.classList.add('vagent-merged');
    }

    function unmergeHead() {
        if (!headBits) { return; }
        var bar = panel.querySelector('#vagent_bar');
        var sp = bar.querySelector('.sp');
        ['#vagent_dot', '#vagent_age'].forEach(function (id) {
            var el = headBits.left.querySelector(id);
            if (el) { bar.insertBefore(el, sp); }
        });
        ['#vagent_density', '#vagent_clear', '#vagent_stop'].forEach(function (id) {
            var el = headBits.right.querySelector(id);
            if (el) { bar.appendChild(el); }
        });
        headBits.left.remove();
        headBits.right.remove();
        headBits = null;
        panel.classList.remove('vagent-merged');
    }

    /* Chrome sometimes leaves the drawer's transform transition in playState
       'running' with currentTime 0 and startTime null — a throttled compositor
       (window occluded, background tab) never starts it, so the panel parks a
       hundred pixels off-screen with its left edge clipped.  Do not rely on the
       animation: whatever is still un-started two frames later gets finished by
       hand. */
    function settleDrawer(el) {
        if (!el || !el.getAnimations) { return; }
        function settle() {
            el.getAnimations().forEach(function (a) {
                if (a.playState === 'running' && (!a.startTime || !a.currentTime)) {
                    try { a.finish(); } catch (e) {}
                }
            });
        }
        // Two frames when the compositor is running...
        if (window.requestAnimationFrame) {
            requestAnimationFrame(function () { requestAnimationFrame(settle); });
        }
        // ...and plain timers as well: a throttled compositor is exactly the
        // case this exists for, and rAF does not fire there either.  Measured
        // on Robert's 668 px window: the transition sat at currentTime 0 and
        // the rAF-only version never ran.
        setTimeout(settle, 120);
        setTimeout(settle, 500);
    }

    function openPanel() {
        var d = drawerEls();
        if (!d.drawer || !d.body) { return; }
        var mm = window.map_menu;
        if (mm && typeof mm.close_drawer === 'function') {
            try { mm.close_drawer(); } catch (e) {}   // hide Marker/Map/… panels
        }
        if (panel.parentNode !== d.body) { d.body.appendChild(panel); }
        panel.style.display = 'flex';
        d.body.classList.add('vagent-host');
        panelActive = true;

        try {
            var rm = document.getElementById('row_menu');
            if (rm) {
                var b = rm.getBoundingClientRect().bottom;
                if (b > 0) { d.drawer.style.top = Math.round(b + 2) + 'px'; }
            }
        } catch (e) {}
        d.drawer.classList.add('open');
        settleDrawer(d.drawer);
        d.drawer.classList.remove('wide', 'editor');
        d.drawer.setAttribute('aria-hidden', 'false');
        if (d.title) { d.title.textContent = 'Agent'; }
        if (mm) { mm._drawer_last = 'agent'; }        // full-toggle persists per panel
        var full = lsGet('vitulus_drawer_full_agent') === '1';
        if (mm && typeof mm.set_drawer_full === 'function') { mm.set_drawer_full(full); }
        else { d.drawer.classList.toggle('full', full); }
        settleDrawer(d.drawer);   // width/transform change: same stall applies
        if (d.backdrop) { d.backdrop.style.display = window.innerWidth < 576 ? 'block' : 'none'; }

        lsSet(LS_OPEN, '1');
        clearUnread();
        markSeenNow();
        var btn = document.getElementById('btn_agent');
        if (btn) { btn.classList.add('active'); }
        blocks.forEach(function (blk) {
            if (blk.onOpen && blk.el) {
                try { blk.onOpen(blk.body || blk.el); } catch (e) {}
            }
        });
        schedule();   // pollers wake up
        var input = document.getElementById('vagent_input');
        if (input && window.innerWidth >= 576) { input.focus(); }
        mergeHead();
        scrollChatBottom();
        document.dispatchEvent(new Event('vagent:activechange'));
    }

    function deactivate(slideOut) {
        if (!panelActive) { return; }
        unmergeHead();
        panelActive = false;
        var dd = document.getElementById('ui_drawer');
        if (dd) { dd.style.height = ''; }   // keyboard clamp is ours alone
        document.dispatchEvent(new Event('vagent:activechange'));
        panel.style.display = 'none';
        var db = document.getElementById('ui_drawer_body');
        if (db) { db.classList.remove('vagent-host'); }
        lsSet(LS_OPEN, '0');
        var btn = document.getElementById('btn_agent');
        if (btn) { btn.classList.remove('active'); }
        if (slideOut) {
            var d = drawerEls();
            var mm = window.map_menu;
            if (mm && typeof mm._drawer_slide_out === 'function') { mm._drawer_slide_out(); }
            else if (d.drawer) {
                d.drawer.classList.remove('open', 'wide', 'editor', 'full');
                d.drawer.setAttribute('aria-hidden', 'true');
            }
            if (d.backdrop) { d.backdrop.style.display = 'none'; }
        }
    }

    function togglePanel() {
        if (panelActive) { deactivate(true); } else { openPanel(); }
    }

    /* The drawer is shared: Marker/Map/Programs/Settings open through
       map_view.js and set their own title.  Watch the chrome instead of
       patching their code — a title that is not "Agent" means another panel
       took the drawer; a drawer that lost .open means it was closed. */
    /* Soft keyboard: on phones the drawer is 100vw/full height, so when the
       keyboard opens the input would sit under it.  visualViewport tells the
       truth about the visible height; clamp the drawer to it while the agent
       panel is active and re-stick the chat.  Cleared on deactivate — the
       drawer is shared. */
    function watchKeyboard() {
        var vv = window.visualViewport;
        if (!vv) { return; }
        function fit() {
            var d = drawerEls();
            if (!d.drawer) { return; }
            if (!panelActive || window.innerWidth >= 576) {
                d.drawer.style.height = '';
                return;
            }
            var top = parseFloat(d.drawer.style.top || '0') || 0;
            var h = Math.max(200, vv.height - top + (vv.offsetTop || 0));
            d.drawer.style.height = Math.round(h) + 'px';
            scrollChatBottom();
        }
        vv.addEventListener('resize', fit);
        vv.addEventListener('scroll', fit);
        document.addEventListener('vagent:activechange', fit);
    }

    function watchDrawer() {
        var d = drawerEls();
        if (!d.drawer) { return; }
        new MutationObserver(function () {
            if (!panelActive) { return; }
            if (!d.drawer.classList.contains('open')) { deactivate(false); return; }
            settleDrawer(d.drawer);
            scrollChatBottom();   // .full toggle re-lays the chat out
        }).observe(d.drawer, {attributes: true, attributeFilter: ['class']});
        if (d.title) {
            new MutationObserver(function () {
                if (panelActive && d.title.textContent !== 'Agent') { deactivate(false); }
            }).observe(d.title, {childList: true, characterData: true, subtree: true});
        }
    }

    // ------------------------------------------------------- toolbar button
    function installToolbarButton() {
        var group = document.querySelector('#row_menu .btn-group');
        if (!group || document.getElementById('btn_agent')) { return; }
        var btn = document.createElement('button');
        btn.className = 'btn btn-outline-info d-flex justify-content-center ' +
                        'align-items-center all-events';
        btn.id = 'btn_agent';
        btn.type = 'button';
        btn.title = 'Agent — chat, jobs, approvals (Alt+A)';
        btn.style.position = 'relative';
        var ico = document.createElement('i');
        ico.className = 'la la-android';
        ico.style.cssText = 'font-size:17px;font-weight:bold;';
        btn.appendChild(ico);
        var badge = document.createElement('span');
        badge.id = 'vagent_badge';
        badge.style.display = 'none';
        btn.appendChild(badge);
        btn.addEventListener('click', togglePanel);
        group.appendChild(btn);
    }

    // ============================================================ CHAT block
    var seen = {};                    // task ids already rendered
    var lastTaskId = 0;               // feed cursor
    /* Lazy history: only the last page lives in the DOM; older pages are
       fetched when the user scrolls to the top, newest-heavy windows are
       pruned so the chat never holds the whole log (Robert, 2026-08-26). */
    var oldestTaskId = 0;             // smallest task id currently rendered
    var hasMore = false;              // older history exists on the server
    var loadingOlder = false;         // one back-page in flight at a time
    var truncatedBottom = false;      // deep back-scroll dropped newest rows
    var insertRef = null;             // when set, turn() prepends before this
    var MAX_NODES = 300;              // message-node window
    var PAGE = 50;                    // history page size
    var pendingByText = [];           // sent, awaiting the row from the feed
    var msgsEl = null, inputEl = null;
    var scope = lsGet(LS_SCOPE) || 'all';
    var filter = 'all';               // all | chat | report

    function markSeenNow() {
        if (lastTaskId) { lsSet(LS_SEEN, String(lastTaskId)); }
    }

    function atBottom() {
        return msgsEl && (msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 40);
    }

    var jumpBtn = null;
    function paintJump() {
        if (!jumpBtn) { return; }
        var want = truncatedBottom || !atBottom();
        jumpBtn.style.display = want ? '' : 'none';
    }

    function taskKind(task) {
        if (task.source === 'agent') {
            var ev = (task.meta && task.meta.event) || '';
            if (ev || /hlášení z práce|z mise/.test(task.text || '')) { return 'work'; }
            return 'report';          // senses / selfcare / growth
        }
        return task.author === author ? 'me' : 'user';
    }

    function turn(kind, cls, text, meta, taskId) {
        var stick = atBottom();
        var wrap = document.createElement('div');
        wrap.className = 'vagent-turn ' + cls;
        wrap.setAttribute('data-kind', kind);
        if (taskId) { wrap.setAttribute('data-task', taskId); }

        var body = document.createElement('div');
        body.className = 'vagent-msg';
        if (cls === 'vagent-me' || cls === 'vagent-user') { body.textContent = text; }
        else { renderMarkdown(body, text); }
        wrap.appendChild(body);

        var hit = SNAP_RE.exec(text || '');
        if (hit) { attachImage(body, hit[0]); }

        if (meta && meta.length) {
            var line = document.createElement('div');
            line.className = 'vagent-meta';
            meta.forEach(function (part) {
                if (!part || !part.text) { return; }
                var s = document.createElement('span');
                if (part.cls) { s.className = part.cls; }
                s.textContent = part.text;
                line.appendChild(s);
            });
            wrap.appendChild(line);
        }
        if (insertRef && insertRef.parentNode === msgsEl) {
            msgsEl.insertBefore(wrap, insertRef);   // history prepend
        } else {
            msgsEl.appendChild(wrap);
            if (stick) { msgsEl.scrollTop = msgsEl.scrollHeight; }
        }
        return wrap;
    }

    function attachImage(target, url) {
        var img = document.createElement('img');
        img.className = 'snap';
        img.loading = 'lazy';
        img.addEventListener('load', function () {
            if (atBottom()) { msgsEl.scrollTop = msgsEl.scrollHeight; }
        });
        img.src = AGENT_HTTP + url;
        img.addEventListener('click', function () {
            window.open(img.src, '_blank', 'noopener');
        });
        target.appendChild(img);
    }

    function waiting() {
        var d = document.createElement('div');
        d.className = 'vagent-wait';
        var dots = document.createElement('span');
        dots.className = 'vagent-dots';
        dots.textContent = '•••';
        var label = document.createElement('span');
        d.appendChild(dots); d.appendChild(label);
        msgsEl.appendChild(d);
        msgsEl.scrollTop = msgsEl.scrollHeight;
        var began = Date.now();
        function paint() {
            var s = Math.round((Date.now() - began) / 1000);
            var note = s >= 60 ? ' — long task, let it finish'
                : s >= 25 ? ' — thinking longer, probably verifying something'
                : s >= 10 ? ' — using tools' : '';
            label.textContent = ' Vitulus is working… ' + s + ' s' + note;
        }
        paint();
        d.dataset.timer = setInterval(paint, 1000);
        return d;
    }

    function stopWaiting(node) {
        if (node && node.dataset && node.dataset.timer) {
            clearInterval(Number(node.dataset.timer));
        }
        if (node) { node.remove(); }
    }

    function renderTask(task, fromHistory) {
        if (!task || !task.id || seen[task.id]) { return false; }
        var mineOnly = scope === 'mine';
        var isMine = task.author === author;
        var fromAgent = task.source === 'agent';
        if (mineOnly && !isMine && !fromAgent) { return false; }
        seen[task.id] = true;
        if (task.id > lastTaskId) { lastTaskId = task.id; }
        if (!oldestTaskId || task.id < oldestTaskId) { oldestTaskId = task.id; }
        var kind = taskKind(task);

        // The question half (skip if this tab just rendered it optimistically).
        if (!fromAgent && task.text) {
            var matched = false;
            if (!fromHistory && isMine) {
                for (var i = 0; i < pendingByText.length; i++) {
                    if (pendingByText[i].text === task.text) { matched = true; break; }
                }
            }
            if (!matched && (fromHistory || !isMine)) {
                turn(kind, isMine ? 'vagent-me' : 'vagent-user', task.text, [
                    {text: clock(task.ts || 0)},
                    {text: isMine ? (displayName || 'ty') : (task.author || '?'),
                     cls: isMine ? '' : 'who'}
                ], task.id);
            }
        }

        if (task.state !== 'done' && task.state !== 'failed') { return true; }

        // The answer half; release this tab's waiting bubble if it was ours.
        if (isMine) {
            for (var j = 0; j < pendingByText.length; j++) {
                if (pendingByText[j].text === task.text) {
                    stopWaiting(pendingByText[j].node);
                    pendingByText.splice(j, 1);
                    break;
                }
            }
        }
        var took = humanDuration((task.reply_ts || 0) - (task.ts || 0));
        var via = task.engine || '';
        if (task.model) { via += (via ? ' · ' : '') + task.model; }
        var meta = [
            {text: clock(task.reply_ts || task.ts || 0)},
            took ? {text: took} : null,
            task.agent ? {text: task.agent, cls: 'who'} : null,
            via ? {text: via,
                   cls: 'eng' + (/záloha/i.test(task.engine || '') ? ' fb' : '')} : null,
            task.klass ? {text: task.klass, cls: 'kl'} : null
        ];
        var cls = fromAgent ? (kind === 'work' ? 'vagent-work' : 'vagent-report')
            : task.state === 'done' ? 'vagent-bot' : 'vagent-err';
        var row = turn(fromAgent ? kind : 'bot', cls, task.reply || task.text || '(no reply)',
                       meta, task.id);
        // Artefacts from missions/jobs (photos, map renders) as thumbnails.
        var arts = (task.meta && task.meta.artefacts) || [];
        arts.forEach(function (a) {
            if (a && a.url) { attachImage(row.querySelector('.vagent-msg'), a.url); }
        });
        if (fromAgent && task.meta && task.meta.event === 'script_output') {
            // Output of a script task: compact bubble with a link to its card.
            row.classList.add('vagent-script');
            var sh = document.createElement('div');
            sh.className = 'vagent-scripthead';
            var kp = document.createElement('span');
            kp.className = 'vagent-pill kind-script';
            kp.textContent = 'script';
            sh.appendChild(kp);
            var sid = task.meta.schedule_id;
            var stitle = task.meta.schedule_title || (sid ? 'task #' + sid : 'script task');
            var lnk = document.createElement('button');
            lnk.type = 'button';
            lnk.className = 'vagent-ref';
            lnk.textContent = stitle + (sid ? ' (#' + sid + ')' : '');
            lnk.title = 'Show this job in Jobs';
            lnk.addEventListener('click', function (e) {
                e.stopPropagation();
                if (sid) { highlightSched(sid); } else { activateTab('jobs'); }
            });
            sh.appendChild(lnk);
            row.insertBefore(sh, row.firstChild);
        } else if (fromAgent) {
            row.title = 'Click to prepare a reply to this report';
            row.addEventListener('click', function () {
                if (!inputEl) { return; }
                inputEl.value = 'K hlášení #' + task.id + ' (' +
                    String(task.text || '').slice(0, 40) + '…): ';
                inputEl.focus();
            });
            attachFlowButtons(row, task, kind);
        }
        if (!fromHistory && (fromAgent || !isMine)) {
            notify(kind, task.reply || task.text || '');
        }
        return true;
    }

    /* Incident templates — the same three the backend sends as `actions`;
       used client-side when a report carries none (older core). */
    function incidentActions(id, title, text) {
        var what = String(title || text || '').replace(/\s+/g, ' ').slice(0, 160);
        return [
            {label: 'Assign task', action: 'assign',
             text: 'Řeš incident #' + id + ': ' + what},
            {label: 'Plan', action: 'plan',
             text: 'Naplánuj řešení incidentu #' + id + ' (jen plán, nic neprováděj): ' + what},
            {label: 'Execute', action: 'execute',
             text: 'Proveď opravu incidentu #' + id + ': ' + what}
        ];
    }

    var assigned = {};     // incident id + action → „zadáno" for this session

    function actionButtons(container, id, actions, onDone) {
        var bar = document.createElement('div');
        bar.className = 'vagent-actions';
        actions.forEach(function (a) {
            if (!a || !a.text) { return; }
            var key = id + ':' + (a.action || a.label);
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'vagent-actbtn' + (assigned[key] ? ' done' : '');
            b.textContent = assigned[key] ? a.label + ' ✓' : a.label;
            b.title = a.text;
            b.addEventListener('click', function (ev) {
                ev.stopPropagation();
                submitText(a.text, {incident_id: id, action: a.action || a.label});
                assigned[key] = true;
                b.classList.add('done');
                b.textContent = a.label + ' ✓';
                var tag = document.createElement('span');
                tag.className = 'vagent-assigned';
                tag.textContent = 'assigned';
                if (!bar.querySelector('.vagent-assigned')) { bar.appendChild(tag); }
                openChatSection();
                if (onDone) { onDone(a); }
            });
            bar.appendChild(b);
        });
        container.appendChild(bar);
        return bar;
    }

    /* Buttons under agent bubbles: incident actions on reports; „Proveď"
       on a finished job that produced a plan; „Navázat" on any finished
       job.  Unobtrusive — one small row under the meta line. */
    function attachFlowButtons(row, task, kind) {
        var text = String(task.reply || task.text || '');
        var meta = task.meta || {};
        var head = String(task.text || '');
        // Senses/selfcare/doctor reports carry meta.event too (so taskKind
        // says 'work'); what makes them an INCIDENT is the „hlášení:" title,
        // as opposed to „hlášení z práce (#N)" which is a job report.
        var isIncident = !!meta.incident_id || /^hlášení:/i.test(head) ||
            (kind === 'report' && /^(hlášení|vizita|nález|incident)/i.test(text));
        if (isIncident) {
            var id = meta.incident_id || task.id;
            var acts = (meta.actions && meta.actions.length) ? meta.actions
                : incidentActions(id, head.replace(/^hlášení:\s*/i, ''), text);
            actionButtons(row, id, acts);
            return;
        }
        if (kind !== 'work') { return; }
        var jm = /(?:práce|práci|job)\s*#?(\d+)/i.exec(text) || /#(\d+)/.exec(task.text || '');
        var jobId = meta.job_id || (jm && jm[1]);
        if (!jobId) { return; }
        var finished = /hotovo|dokončen|selhal|zrušil|skončil/i.test(text) ||
            meta.event === 'done' || meta.event === 'failed';
        if (!finished) { return; }
        var bar = document.createElement('div');
        bar.className = 'vagent-actions';
        if (/plán/i.test(text) || meta.plan) {
            var go = document.createElement('button');
            go.type = 'button'; go.className = 'vagent-actbtn primary';
            go.textContent = 'Execute';
            go.title = 'Sends: proveď plán z práce #' + jobId;
            go.addEventListener('click', function (e) {
                e.stopPropagation();
                submitText('proveď plán z práce #' + jobId, {job_id: jobId, action: 'execute_plan'});
                openChatSection();
            });
            bar.appendChild(go);
        }
        var cont = document.createElement('button');
        cont.type = 'button'; cont.className = 'vagent-actbtn';
        cont.textContent = 'Follow up';
        cont.title = 'Prepares „pokračuj na ' + jobId + ': …"';
        cont.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!inputEl) { return; }
            inputEl.value = 'pokračuj na ' + jobId + ': ';
            inputEl.focus();
        });
        bar.appendChild(cont);
        row.appendChild(bar);
    }

    function applyFilter() {
        if (!msgsEl) { return; }
        msgsEl.setAttribute('data-filter', filter);
    }

    function pollTasks() {
        var q = '/api/tasks?since_id=' + lastTaskId +
            (scope === 'mine' ? '&author=' + encodeURIComponent(author) : '');
        return api(q).then(function (d) {
            var rows = (d && d.tasks) || [];
            if (truncatedBottom) {
                // A deep back-scroll dropped the newest rows; appending live
                // ones under stale history would render a gap.  Track the
                // cursor and the unread badge only — „Latest" reloads clean.
                rows.forEach(function (t) {
                    if (t.id > lastTaskId) { lastTaskId = t.id; }
                    if (t.source === 'agent'
                            && (t.state === 'done' || t.state === 'failed')) {
                        notify(taskKind(t), t.reply || t.text || '');
                    }
                });
                return;
            }
            rows.forEach(function (t) { renderTask(t, false); });
            if (rows.length) { pruneWindow(false); }
            if (isVisible()) { markSeenNow(); }
        }).catch(function () {});
    }

    function authorQ() {
        return scope === 'mine' ? '&author=' + encodeURIComponent(author) : '';
    }

    function edgeRow(text, cls) {
        var e = document.createElement('div');
        e.className = 'vagent-edge' + (cls ? ' ' + cls : '');
        e.textContent = text;
        return e;
    }

    function turnNodes() {
        return msgsEl ? msgsEl.querySelectorAll('.vagent-turn') : [];
    }

    /* Keep the DOM window at MAX_NODES.  After an append the oldest rows go
       (they are one back-scroll away on the server); after a prepend the
       NEWEST go and „Latest" becomes a clean reload. */
    function pruneWindow(afterPrepend) {
        var nodes = turnNodes();
        var extra = nodes.length - MAX_NODES;
        if (extra <= 0) { return; }
        var i, node, id;
        if (afterPrepend) {
            for (i = 0; i < extra; i++) {
                node = nodes[nodes.length - 1 - i];
                id = parseInt(node.getAttribute('data-task') || '0', 10);
                if (id) { delete seen[id]; }
                node.remove();
            }
            truncatedBottom = true;
            paintJump();
        } else {
            for (i = 0; i < extra; i++) {
                node = nodes[i];
                id = parseInt(node.getAttribute('data-task') || '0', 10);
                if (id) { delete seen[id]; }
                node.remove();
            }
            // The pruned rows still exist server-side: the top edge reopens.
            hasMore = true;
            var edge = msgsEl.querySelector('.vagent-edge.begin');
            if (edge) { edge.remove(); }
            var first = turnNodes()[0];
            oldestTaskId = first
                ? parseInt(first.getAttribute('data-task') || '0', 10) || 0 : 0;
        }
    }

    function loadOlder() {
        if (!hasMore || loadingOlder || !oldestTaskId || !msgsEl) { return; }
        loadingOlder = true;
        var loader = edgeRow('Loading older…');
        msgsEl.insertBefore(loader, msgsEl.firstChild);
        api('/api/tasks?before_id=' + oldestTaskId + '&limit=' + PAGE + authorQ())
            .then(function (d) {
                loader.remove();
                var rows = (d && d.tasks) || [];
                var prevH = msgsEl.scrollHeight;
                var prevTop = msgsEl.scrollTop;
                insertRef = msgsEl.firstChild;
                try {
                    rows.forEach(function (t) { renderTask(t, true); });
                } finally { insertRef = null; }
                msgsEl.scrollTop = prevTop + (msgsEl.scrollHeight - prevH);
                hasMore = !!(d && d.has_more);
                if (!hasMore && !msgsEl.querySelector('.vagent-edge.begin')) {
                    msgsEl.insertBefore(edgeRow('Beginning of history', 'begin'),
                                        msgsEl.firstChild);
                }
                loadingOlder = false;
                pruneWindow(true);
            })
            .catch(function () {
                loader.textContent = 'Older messages could not be loaded.';
                setTimeout(function () { loader.remove(); }, 4000);
                loadingOlder = false;
            });
    }

    function loadHistory() {
        msgsEl.textContent = '';
        seen = {};
        lastTaskId = 0;
        oldestTaskId = 0;
        hasMore = false;
        loadingOlder = false;
        truncatedBottom = false;
        paintJump();
        var loading = document.createElement('div');
        loading.className = 'vagent-empty';
        loading.textContent = 'Loading conversation history…';
        msgsEl.appendChild(loading);

        function finish(found) {
            if (loading.parentNode) { loading.remove(); }
            if (!found) {
                var e = document.createElement('div');
                e.className = 'vagent-empty';
                e.textContent = 'Hi, I am Vitulus. Ask about status, the map or jobs.';
                msgsEl.appendChild(e);
            }
            scrollChatBottom();
            markSeenNow();
        }

        // One bounded call: the LAST page only.  Older pages load when the
        // user scrolls to the top (loadOlder).
        api('/api/tasks?limit=' + PAGE + authorQ()).then(function (data) {
            if (data && Object.prototype.hasOwnProperty.call(data, 'has_more')) {
                var found = false;
                ((data && data.tasks) || []).forEach(function (t) {
                    if (renderTask(t, true)) { found = true; }
                });
                hasMore = !!data.has_more;
                if (!hasMore && found
                        && !msgsEl.querySelector('.vagent-edge.begin')) {
                    msgsEl.insertBefore(edgeRow('Beginning of history', 'begin'),
                                        msgsEl.firstChild);
                }
                finish(found);
                return null;
            }
            // Old backend without paging: fall back to the full forward walk.
            var found = false;
            function page(since) {
                var q = '/api/tasks?since_id=' + since + authorQ();
                return api(q).then(function (d) {
                    var rows = (d && d.tasks) || [];
                    rows.forEach(function (t) {
                        if (renderTask(t, true)) { found = true; }
                    });
                    if (rows.length === 100) {
                        return page(rows[rows.length - 1].id);
                    }
                    finish(found);
                    return null;
                });
            }
            return page(0);
        }).catch(function () {
            if (loading.parentNode) {
                loading.textContent = 'History could not be loaded. You can still write.';
            }
        });
    }

    function submitText(text, meta) {
        if (!text) { return; }
        turn('me', 'vagent-me', text, [
            {text: clock(Date.now() / 1000)},
            {text: displayName || 'ty'}
        ]);
        var node = waiting();
        pendingByText.push({text: text, node: node});
        var body = {text: text, author: author, name: displayName || undefined};
        if (meta && typeof meta === 'object') { body.meta = meta; }
        api('/api/task', {body: body})
            .catch(function () {
                stopWaiting(node);
                for (var i = 0; i < pendingByText.length; i++) {
                    if (pendingByText[i].node === node) { pendingByText.splice(i, 1); break; }
                }
                turn('bot', 'vagent-err', 'Could not send — agent (:8088) is unreachable.', []);
            });
    }

    function renderChat(el) {
        el.innerHTML =
            '<div id="vagent_chips">' +
            '<button data-f="all" class="on" type="button">All</button>' +
            '<button data-f="chat" type="button">Chat</button>' +
            '<button data-f="report" type="button">Reports</button>' +
            '<button data-f="work" type="button">Jobs</button>' +
            '<span class="sp"></span>' +
            '<button id="vagent_scope" type="button" title="All = whole conversation from every device; Mine = this browser only"></button>' +
            '</div>' +
            '<div id="vagent_msgs"></div>' +
            '<div id="vagent_form">' +
            '<textarea id="vagent_input" placeholder="Type a task or question… (/ for commands)"></textarea>' +
            '<button id="vagent_send" type="button">▶</button></div>' +
            '<div id="vagent_quick">' +
            '<button type="button" data-q="/status">/status</button>' +
            '<button type="button" data-q="/health">/health</button>' +
            '<button type="button" data-q="/allow">/allow</button>' +
            '<button type="button" data-q="Jaký je stav robota?">status?</button>' +
            '</div>';
        msgsEl = el.querySelector('#vagent_msgs');
        inputEl = el.querySelector('#vagent_input');
        var send = el.querySelector('#vagent_send');

        // Lazy history: near the top -> fetch the previous page; the floating
        // „Latest" chip returns to (or reloads) the newest messages.
        jumpBtn = document.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.id = 'vagent_jump';
        jumpBtn.textContent = '↓ Latest';
        jumpBtn.title = 'Jump to the latest messages';
        jumpBtn.style.display = 'none';
        jumpBtn.addEventListener('click', function () {
            if (truncatedBottom) { loadHistory(); }
            else { scrollChatBottom(); paintJump(); }
        });
        el.appendChild(jumpBtn);
        msgsEl.addEventListener('scroll', function () {
            if (msgsEl.scrollTop < 80) { loadOlder(); }
            paintJump();
        }, {passive: true});

        Array.prototype.forEach.call(el.querySelectorAll('#vagent_chips [data-f]'), function (b) {
            b.addEventListener('click', function () {
                filter = b.getAttribute('data-f');
                Array.prototype.forEach.call(
                    el.querySelectorAll('#vagent_chips [data-f]'),
                    function (x) { x.classList.toggle('on', x === b); });
                applyFilter();
            });
        });
        var scopeBtn = el.querySelector('#vagent_scope');
        function paintScope() {
            scopeBtn.textContent = scope === 'all' ? 'all' : 'mine';
        }
        scopeBtn.addEventListener('click', function () {
            scope = scope === 'all' ? 'mine' : 'all';
            lsSet(LS_SCOPE, scope);
            paintScope();
            loadHistory();
        });
        paintScope();
        applyFilter();

        Array.prototype.forEach.call(el.querySelectorAll('#vagent_quick [data-q]'), function (b) {
            b.addEventListener('click', function () {
                var q = b.getAttribute('data-q');
                if (q.charAt(0) === '/' && q !== '/status' && q !== '/health') {
                    inputEl.value = q + ' ';
                    inputEl.focus();
                } else {
                    submitText(q);
                }
            });
        });

        function submit() {
            var text = inputEl.value.trim();
            if (!text) { return; }
            inputEl.value = '';
            inputEl.style.height = '38px';
            submitText(text);
        }
        send.addEventListener('click', submit);
        inputEl.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
        });
        inputEl.addEventListener('focus', function () {
            setTimeout(scrollChatBottom, 250);
        });
        inputEl.addEventListener('input', function () {
            inputEl.style.height = '38px';
            inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
        });
        installCommands(el, inputEl, submit);
        loadHistory();
    }

    // ------------------------------------------- slash-command autocomplete
    function installCommands(root, input, submit) {
        var box = document.createElement('div');
        box.id = 'vagent_cmds';
        root.appendChild(box);
        var list = [], shown = [], index = 0, fetched = 0;

        function fetchCommands() {
            fetched = Date.now();
            api('/api/commands').then(function (d) {
                list = (d && d.commands) || [];
            }).catch(function () {});
        }
        function hide() { box.classList.remove('on'); shown = []; }
        function draw() {
            box.textContent = '';
            shown.forEach(function (cmd, i) {
                var row = document.createElement('div');
                row.className = 'vagent-cmd' + (i === index ? ' sel' : '');
                var name = document.createElement('span');
                name.className = 'cn';
                name.textContent = cmd.usage || cmd.name;
                row.appendChild(name);
                var help = document.createElement('span');
                help.className = 'ch';
                help.textContent = cmd.help || '';
                row.appendChild(help);
                row.addEventListener('mousedown', function (ev) {
                    ev.preventDefault();
                    index = i;
                    complete();
                });
                box.appendChild(row);
            });
            box.classList.toggle('on', shown.length > 0);
        }
        function refresh() {
            var value = input.value;
            if (!/^\/\S*$/.test(value)) { hide(); return; }
            if (!list.length) {
                if (Date.now() - fetched > 10000) { fetchCommands(); }
                hide();
                return;
            }
            var prefix = value.toLowerCase();
            shown = list.filter(function (c) {
                return String(c.name || '').toLowerCase().indexOf(prefix) === 0;
            });
            if (shown.length === 1 && String(shown[0].name).toLowerCase() === prefix) {
                hide();
                return;
            }
            index = 0;
            draw();
        }
        function complete() {
            var cmd = shown[index];
            if (!cmd) { return; }
            input.value = cmd.name + (cmd.takes_arg ? ' ' : '');
            hide();
            input.focus();
        }
        input.addEventListener('keydown', function (ev) {
            if (!box.classList.contains('on') || !shown.length) { return; }
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                index = (index + (ev.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
                draw();
            } else if (ev.key === 'Enter' || ev.key === 'Tab') {
                complete();
            } else if (ev.key === 'Escape') {
                hide();
            } else { return; }
            ev.preventDefault();
            ev.stopImmediatePropagation();
        }, true);
        input.addEventListener('input', refresh);
        input.addEventListener('blur', function () { setTimeout(hide, 120); });
        fetchCommands();
    }

    // ==================================================== JOBS (unified model)
    /* One concept: „Job".  A prompt job (text handed to Hermes) and a script
       job (a program the core runs without a model) are the same card, no
       matter whether they run once or on a schedule — the old Jobs and Tasks
       tabs were two views of one thing.  The pane groups by LIFECYCLE:
         Running          running / queued / blocked (legs, slot, stalled)
         Scheduled        interval / daily, scripts included
         Needs attention  failed / draft / stalled, with Rerun-with-note
         Recent           done, collapsed, last 10
       Data: GET /api/unified/jobs.  While the backend is still growing that
       endpoint the very same cards are composed, best effort, from the old
       /api/jobs + /api/schedules, so the tab is never empty. */

    var jobsBody = null, jobsListBox = null;
    var jobsBadge = document.createElement('span');
    jobsBadge.className = 'vagent-cnt';
    var unifiedOk = null;            // null unknown · true live · false 404
    var legacyJobs = [], legacySched = [], legacySchedOk = null;
    var lastJobs = [];               // last normalised list (for forced redraws)
    var jobsErr = '';                // inline note when nothing can be fetched

    var dismissed = {};
    try { dismissed = JSON.parse(lsGet(LS_JOBS) || '{}') || {}; } catch (e) { dismissed = {}; }

    function rememberDismissed(id) {
        dismissed[id] = 1;
        var keys = Object.keys(dismissed);
        if (keys.length > 200) {
            keys.sort().slice(0, 100).forEach(function (k) { delete dismissed[k]; });
        }
        lsSet(LS_JOBS, JSON.stringify(dismissed));
    }

    /* Context bar: while chatting, the one running job and any pending
       approval stay in sight (Robert: "je potřeba ty ostatní panely vidět").
       Hidden when there is nothing to show, and in the full multi-column
       view, where everything is on screen anyway. */
    var ctxJobs = [], ctxAsks = [];

    function paintCtx() {
        var bar = panel.querySelector('#vagent_ctx');
        if (!bar) { return; }
        bar.textContent = '';
        var running = null;
        ctxJobs.forEach(function (j) {
            if (!running && (j.state === 'running' || j.state === 'queued')) { running = j; }
        });
        var pending = ctxAsks.length;
        if (!running && !pending) { bar.style.display = 'none'; return; }
        bar.style.display = '';
        if (running) {
            var jb = document.createElement('button');
            jb.type = 'button';
            jb.className = 'vagent-ctx-item job';
            var pl = document.createElement('span');
            pl.className = 'vagent-pill ' + running.state;
            pl.textContent = running.state === 'running' ? 'running' : 'waiting';
            jb.appendChild(pl);
            var t = document.createElement('span');
            t.className = 'ct';
            t.textContent = '#' + running.id + ' ' + String(running.text || '').slice(0, 60);
            jb.appendChild(t);
            var e2 = document.createElement('span');
            e2.className = 'ce';
            e2.textContent = humanDuration(running.elapsed_s || 0);
            jb.appendChild(e2);
            jb.title = 'Switch to Jobs';
            jb.addEventListener('click', function () { highlightJob('j:' + running.id); });
            bar.appendChild(jb);
        }
        if (pending) {
            var ab = document.createElement('button');
            ab.type = 'button';
            ab.className = 'vagent-ctx-item ask';
            var n = document.createElement('span');
            n.className = 'vagent-cnt warn';
            n.textContent = String(pending);
            ab.appendChild(n);
            var c = document.createElement('span');
            c.className = 'ct';
            c.textContent = 'approvals: ' +
                String((ctxAsks[0] && ctxAsks[0].command) || '').slice(0, 48);
            ab.appendChild(c);
            ab.title = 'Switch to Approvals';
            ab.addEventListener('click', function () {
                activateTab('gate');
                highlightAsk(ctxAsks[0] && ctxAsks[0].id);
            });
            bar.appendChild(ab);
        }
    }

    function openChatSection() { activateTab('chat'); }

    // ---------------------------------------------------------- formatting
    function humanEvery(s) {
        s = Number(s) || 0;
        if (!s) { return '–'; }
        if (s < 60) { return 'every ' + Math.round(s) + ' s'; }
        if (s % 86400 === 0) { return 'every ' + (s / 86400 === 1 ? 'day' : (s / 86400) + ' days'); }
        if (s % 3600 === 0) { return 'every ' + (s / 3600) + ' h'; }
        if (s % 60 === 0) { return 'every ' + (s / 60) + ' min'; }
        return 'every ' + (s < 600 ? Math.round(s) + ' s' : (s / 60).toFixed(1) + ' min');
    }

    function scheduleText(sc) {
        if (!sc) { return ''; }
        if (sc.type === 'daily' || sc.at) { return 'daily at ' + (sc.at || '?'); }
        return humanEvery(sc.every_s);
    }

    function relTime(ts) {
        if (!ts) { return '–'; }
        var d = ts - Date.now() / 1000;
        var a = Math.abs(d), s;
        if (a < 60) { s = Math.round(a) + ' s'; }
        else if (a < 3600) { s = Math.round(a / 60) + ' min'; }
        else if (a < 86400) { s = (a / 3600).toFixed(a < 36000 ? 1 : 0) + ' h'; }
        else { s = Math.round(a / 86400) + ' d'; }
        return d >= 0 ? 'in ' + s : s + ' ago';
    }

    /* How long something took/has been running.  Scripts are measured in
       milliseconds, a prompt job in minutes and hours — one formatter each. */
    function humanSpan(sec) {
        var s = Number(sec);
        if (!isFinite(s) || s <= 0) { return ''; }
        if (s < 90) { return Math.round(s) + ' s'; }
        if (s < 5400) { return Math.round(s / 60) + ' min'; }
        if (s < 172800) { return (s / 3600).toFixed(1) + ' h'; }
        return Math.round(s / 86400) + ' d';
    }

    function durationText(j) {
        var d = j.last && j.last.duration_s;
        if (d === undefined || d === null || d === '') { return ''; }
        return j.kind === 'script' ? humanMs(d) : humanSpan(d);
    }

    function humanMs(sec) {
        if (sec === null || sec === undefined || sec === '') { return ''; }
        var s = Number(sec);
        if (!isFinite(s)) { return ''; }
        return s < 1 ? Math.round(s * 1000) + ' ms' : s.toFixed(s < 10 ? 2 : 1) + ' s';
    }

    function pill(txt, cls, tip) {
        var p = document.createElement('span');
        p.className = 'vagent-pill ' + (cls || '');
        p.textContent = txt;
        if (tip) { p.title = tip; }
        return p;
    }

    /* Redraw discipline (same rules as agent_blocks.js): unchanged data →
       no DOM at all; the user's hand in the pane → defer the redraw. */
    var uiLastClick = 0;
    document.addEventListener('pointerdown', function () { uiLastClick = Date.now(); }, true);
    document.addEventListener('keydown', function () { uiLastClick = Date.now(); }, true);
    function uiInteracting(box) {
        if (!box) { return false; }
        if (Date.now() - uiLastClick < 3000) { return true; }
        try { if (box.matches(':hover')) { return true; } } catch (e) {}
        var a = document.activeElement;
        return !!(a && a !== document.body && box.contains(a));
    }

    /* Open state of card sections lives OUTSIDE the DOM, so a redraw after a
       poll never folds what the owner opened.  Keys: '<ref>:<section>'. */
    var JOB_OPEN_KEY = 'vitulus_agent_job_open';
    var jobOpen = (function () {
        var s = new Set();
        try { JSON.parse(sessionStorage.getItem(JOB_OPEN_KEY) || '[]').forEach(function (k) { s.add(k); }); }
        catch (e) {}
        return s;
    })();
    function jobOpenSet(key, on) {
        if (on) { jobOpen.add(key); jobOpen.delete('!' + key); }
        else { jobOpen.delete(key); jobOpen.add('!' + key); }
        try { sessionStorage.setItem(JOB_OPEN_KEY, JSON.stringify(Array.from(jobOpen))); } catch (e) {}
    }
    /* Tri-state: opened by the owner · closed by the owner · never touched
       (then the caller's default decides).  A poll must never undo either. */
    function jobIsOpen(key, dflt) {
        if (jobOpen.has(key)) { return true; }
        if (jobOpen.has('!' + key)) { return false; }
        return !!dflt;
    }

    // ------------------------------------------------------ the unified shape
    var POLICY_LABEL = {silent: 'Silent', result: 'Result', progress: 'Progress'};
    var POLICY_TIP = 'Whether this job may post to chat';
    var STATUS_CLS = {running: 'running', queued: 'queued', blocked: 'blocked',
                      scheduled: 'scheduled', paused: 'paused', draft: 'draft',
                      failed: 'failed', cancelled: 'failed', done: 'done',
                      stalled: 'stalled'};

    function toPolicy(v, kind) {
        var s = String(v == null ? '' : v).toLowerCase();
        if (s === 'silent' || s === 'quiet') { return 'silent'; }
        if (s === 'result' || s === 'on_change') { return 'result'; }
        if (s === 'progress' || s === 'always') { return 'progress'; }
        return kind === 'script' ? 'result' : 'progress';
    }
    function policyToMode(p) {
        return p === 'silent' ? 'quiet' : p === 'progress' ? 'always' : 'on_change';
    }

    /* "j:123" | "s:5" | 123 | "#123" → {kind, id, ref} */
    function parseRef(ref) {
        var s = String(ref == null ? '' : ref).replace(/^#/, '');
        var m = /^([js]):(.+)$/i.exec(s);
        if (m) { return {kind: m[1].toLowerCase(), id: m[2], ref: m[1].toLowerCase() + ':' + m[2]}; }
        return {kind: 'j', id: s, ref: 'j:' + s};
    }

    function normUnified(j) {
        var kind = j.kind === 'script' ? 'script' : 'prompt';
        var ref = String(j.ref || ((kind === 'script' ? 's:' : 'j:') + j.id));
        return {
            ref: ref, kind: kind,
            archived: !!j.archived, archived_ts: j.archived_ts || null,
            title: j.title || j.text || j.spec || '',
            text: j.text || j.spec || j.description || '',
            status: String(j.status || 'done'),
            schedule: j.schedule || null,
            policy: toPolicy(j.report_policy, kind),
            last: j.last_run || null,
            runs: j.runs_count,
            stalled: !!j.stalled,
            note: j.driver_note || '',
            incident: j.incident_id || null,
            program: j.program_rel || null,
            legs: j.legs, slot: j.slot,
            job_id: j.job_id || null,
            auto: !!j.auto_approve,
            src: 'unified'
        };
    }

    function normLegacyJob(j) {
        return {
            ref: 'j:' + j.id, kind: 'prompt',
            title: j.text || '', text: j.text || '',
            status: String(j.state || 'done'),
            schedule: null,
            policy: 'progress',
            last: {ts: j.finished || j.last_ts || j.started, state: j.state,
                   duration_s: j.elapsed_s, error: j.error || null,
                   output: j.last || null},
            runs: null,
            stalled: !!j.stalled,
            note: j.driver_note || '',
            incident: null, program: null,
            legs: j.legs, slot: j.parallel_slot,
            from_sched: j.schedule_id || null,
            live: j.state === 'blocked' ? j.blocked : j.last,
            subagents: j.subagents, worktree: j.worktree,
            job_id: j.id,
            src: 'jobs'
        };
    }

    function normLegacySched(s) {
        var kind = s.kind === 'script' ? 'script' : 'prompt';
        var state = s.state || (s.enabled ? 'active' : 'paused');
        var status = state === 'draft' ? 'draft'
            : state === 'failed' ? 'failed'
            : state === 'active' ? 'scheduled' : 'paused';
        var lastState = s.last_state ||
            (s.last_exit === undefined || s.last_exit === null ? null
                : (Number(s.last_exit) === 0 ? 'done' : 'failed'));
        return {
            ref: 's:' + s.id, kind: kind,
            title: s.title || s.text || s.description || '',
            text: s.text || s.description || '',
            status: status,
            schedule: {type: s.at_hhmm ? 'daily' : 'interval', every_s: s.every_s,
                       at: s.at_hhmm || null, next_run: s.next_run || null},
            policy: toPolicy(s.report_mode, kind),
            last: {ts: s.last_run, state: lastState, duration_s: s.last_duration_s,
                   output: s.last_output, error: s.last_error, exit: s.last_exit},
            runs: s.run_count || ((s.ok_count || 0) + (s.fail_count || 0)),
            ok_count: s.ok_count, fail_count: s.fail_count, overruns: s.overruns,
            stalled: false,
            note: '', incident: null,
            program: s.program_rel || s.program || null,
            legs: null, slot: null,
            job_id: s.last_job_id || s.setup_job_id || null,
            src: 'sched'
        };
    }

    function composeJobs() {
        var out;
        if (unifiedOk === true) { out = lastUnifiedRaw.map(normUnified); }
        else {
            out = legacySched.map(normLegacySched);
            legacyJobs.forEach(function (j) {
                if (dismissed[j.id] && j.state !== 'running' && j.state !== 'queued' &&
                    j.state !== 'blocked') { return; }
                out.push(normLegacyJob(j));
            });
        }
        // The archive shelf rides along only while its fold is open — it is
        // fetched lazily (?archived=1) and never mixes into the live groups.
        if (archFetched && jobIsOpen('group:archive', false)) {
            var have = {};
            out.forEach(function (j) { have[j.ref] = true; });
            lastArchivedRaw.forEach(function (j) {
                var n = normUnified(j);
                if (!have[n.ref]) { n.archived = true; out.push(n); }
            });
        }
        return out;
    }
    var lastUnifiedRaw = [];
    var lastArchivedRaw = [], archFetched = false, archFetching = false;

    function pollArchived() {
        if (archFetching || unifiedOk !== true) { return Promise.resolve(); }
        archFetching = true;
        return api('/api/unified/jobs?archived=1').then(function (d) {
            archFetching = false;
            if (d && d.ok !== false) {
                lastArchivedRaw = d.jobs || [];
                archFetched = true;
                renderJobsPane(composeJobs());
            }
        }).catch(function () { archFetching = false; });
    }

    function groupOf(j) {
        if (j.archived) { return 'archive'; }
        var st = j.status;
        if (st === 'running' || st === 'queued' || st === 'blocked') { return 'running'; }
        if (st === 'failed' || st === 'draft' || st === 'stalled' || j.stalled) { return 'attention'; }
        if (j.schedule && (st === 'scheduled' || st === 'paused')) { return 'scheduled'; }
        if (st === 'done' || st === 'cancelled') { return 'recent'; }
        return j.schedule ? 'scheduled' : 'recent';
    }

    function jobFp(j) {
        return JSON.stringify([j.ref, j.kind, j.title, j.text, j.status, j.schedule,
            j.policy, j.last, j.runs, j.stalled, j.note, j.legs, j.slot, j.program,
            j.incident, j.live, j.job_id, j.auto, j.archived, groupOf(j)]);
    }

    // --------------------------------------------------------------- actions
    /* Every action prefers the unified endpoint and falls back to what the
       current core really has (schedule verbs, or a Czech sentence in chat —
       the parser has understood those all along). */
    function jobPost(ref, verb, body, legacy) {
        var payload = {author: author};
        if (body) { Object.keys(body).forEach(function (k) { payload[k] = body[k]; }); }
        if (unifiedOk === false) {
            return legacy ? legacy() : Promise.reject(new Error('HTTP 404'));
        }
        return api('/api/unified/jobs/' + encodeURIComponent(ref) + '/' + verb,
                   {method: 'POST', body: payload})
            .then(function (d) {
                if (d && d.ok === false && legacy && /404|nen[aá]lezeno|unknown/i.test(String(d.error || ''))) {
                    return legacy();
                }
                unifiedOk = true;
                return d;
            })
            .catch(function (e) {
                if (/HTTP 404/.test(String(e)) && legacy) { unifiedOk = false; return legacy(); }
                throw e;
            });
    }

    function schedPost(id, verb, body) {
        var payload = {author: author};
        if (body) { Object.keys(body).forEach(function (k) { payload[k] = body[k]; }); }
        return api('/api/schedules/' + id + '/' + verb, {method: 'POST', body: payload});
    }

    function chatFallback(text) {
        submitText(text);
        openChatSection();
        return Promise.resolve({ok: true, chat: true});
    }

    function afterAction() { pollJobs(); pollUnified(); }

    // ------------------------------------------------------------ card parts
    function jobSection(card, ref, key, label, render, opts) {
        opts = opts || {};
        var full = ref + ':' + key;
        var det = document.createElement('details');
        det.className = 'vagent-secd ' + key;
        det.open = jobIsOpen(full, opts.open);
        var sum = document.createElement('summary');
        sum.textContent = label;
        det.appendChild(sum);
        var body = document.createElement('div');
        body.className = 'sd';
        det.appendChild(body);
        var rendered = false;
        function paint() {
            if (rendered && !opts.always) { return; }
            rendered = true;
            body.textContent = '';
            try { render(body); } catch (e) { body.textContent = 'failed: ' + e; }
        }
        det.addEventListener('toggle', function () {
            jobOpenSet(full, det.open);
            if (det.open) { paint(); }
        });
        if (det.open) { paint(); }
        card.appendChild(det);
        return det;
    }

    function actBtn(label, cls, tip, run) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ja' + (cls ? ' ' + cls : '');
        b.textContent = label;
        if (tip) { b.title = tip; }
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            run(b);
        });
        return b;
    }

    /* Rerun with a note — the one thing the owner wants most on a job that
       went wrong: say what should be different and send it back. */
    function rerunSection(card, j) {
        jobSection(card, j.ref, 'rerun', '↻ Rerun with note', function (body) {
            var ta = document.createElement('textarea');
            ta.rows = 2;
            ta.placeholder = 'What should be fixed?';
            body.appendChild(ta);
            var row = document.createElement('div');
            row.className = 'sb';
            var msg = document.createElement('span');
            msg.className = 'sx';
            var go = actBtn('Rerun', 'primary', 'Runs the job again with this note', function (b) {
                var note = ta.value.trim();
                if (!note) { msg.textContent = 'write what should be fixed'; ta.focus(); return; }
                b.disabled = true;
                msg.textContent = 'sending…';
                jobPost(j.ref, 'rerun', {note: note}, function () {
                    return chatFallback('zopakuj ' + (j.kind === 'script' ? 'úkol' : 'práci') +
                        ' #' + parseRef(j.ref).id + ' — co opravit: ' + note);
                }).then(function (d) {
                    b.disabled = false;
                    if (d && d.ok === false) { msg.textContent = 'failed: ' + (d.error || '?'); return; }
                    msg.textContent = '';
                    if (d && d.job_ref) { msg.appendChild(refBtnFor(d.job_ref)); }
                    else { msg.textContent = d && d.chat ? 'sent to chat' : 'sent'; }
                    ta.value = '';
                    afterAction();
                }).catch(function (e) {
                    b.disabled = false;
                    msg.textContent = /HTTP 404/.test(String(e)) ? 'API not available yet' : 'failed: ' + e;
                });
            });
            row.appendChild(go); row.appendChild(msg);
            body.appendChild(row);
        }, {open: j.status === 'failed'});   // a failed job opens it; closing sticks
    }

    function refBtnFor(ref) {
        var p = parseRef(ref);
        return refButton(p.ref, '→ #' + p.id);
    }

    function editSection(card, j) {
        jobSection(card, j.ref, 'edit', '✎ Edit', function (body) {
            var ta = document.createElement('textarea');
            ta.rows = 2;
            ta.placeholder = j.kind === 'script'
                ? 'What should change in the program? (Czech is fine — it goes to Hermes)'
                : 'What should change in this job? (Czech is fine — it goes to Hermes)';
            body.appendChild(ta);
            var row = document.createElement('div');
            row.className = 'sb';
            var msg = document.createElement('span');
            msg.className = 'sx';
            var go = actBtn('Send to Hermes', 'primary', '', function (b) {
                var change = ta.value.trim();
                if (!change) { msg.textContent = 'write what should change'; ta.focus(); return; }
                b.disabled = true;
                msg.textContent = 'sending…';
                var p = parseRef(j.ref);
                jobPost(j.ref, 'edit', {change: change}, function () {
                    if (p.kind === 's') {
                        return schedPost(p.id, 'edit', {change: change}).catch(function () {
                            return chatFallback('uprav dlouhodobý úkol #' + p.id + ': ' + change);
                        });
                    }
                    return chatFallback('uprav práci #' + p.id + ': ' + change);
                }).then(function (d) {
                    b.disabled = false;
                    if (d && d.ok === false) { msg.textContent = 'failed: ' + (d.error || '?'); return; }
                    msg.textContent = '';
                    if (d && (d.job_id || d.job_ref)) { msg.appendChild(refBtnFor(d.job_ref || ('j:' + d.job_id))); }
                    else { msg.textContent = d && d.chat ? 'sent to chat' : 'sent'; }
                    ta.value = '';
                    afterAction();
                }).catch(function (e) {
                    b.disabled = false;
                    msg.textContent = /HTTP 404/.test(String(e)) ? 'API not available yet' : 'failed: ' + e;
                });
            });
            row.appendChild(go); row.appendChild(msg);
            body.appendChild(row);
        });
    }

    function policySelect(j) {
        var wrap = document.createElement('span');
        wrap.className = 'vagent-policy';
        var lab = document.createElement('span');
        lab.className = 'sx';
        lab.textContent = 'report';
        wrap.appendChild(lab);
        var sel = document.createElement('select');
        sel.className = 'vagent-sel';
        sel.title = POLICY_TIP;
        ['silent', 'result', 'progress'].forEach(function (p) {
            var o = document.createElement('option');
            o.value = p; o.textContent = POLICY_LABEL[p];
            if (p === j.policy) { o.selected = true; }
            sel.appendChild(o);
        });
        sel.addEventListener('change', function () {
            var want = sel.value, prev = j.policy;
            sel.disabled = true;
            var p = parseRef(j.ref);
            jobPost(j.ref, 'policy', {report_policy: want}, function () {
                if (p.kind === 's') { return schedPost(p.id, 'mode', {report_mode: policyToMode(want)}); }
                return Promise.reject(new Error('HTTP 404'));
            }).then(function (d) {
                sel.disabled = false;
                if (d && d.ok === false) { sel.value = prev; sel.title = 'failed: ' + (d.error || '?'); return; }
                j.policy = want;
                sel.title = POLICY_TIP;
                afterAction();
            }).catch(function (e) {
                sel.disabled = false;
                sel.value = prev;
                sel.title = /HTTP 404/.test(String(e)) ? 'API not available yet' : 'failed: ' + e;
            });
        });
        wrap.appendChild(sel);
        return wrap;
    }

    /* Auto-approve toggle — the owner's standing yes for this one job.  The
       flag pre-approves ONLY what the Approve button could grant; the safety
       layer and the mower are refused inside the backend shortcut whatever
       the flag says (shellgate.maybe_auto_approve, §11.1/§11.4). */
    var AUTOAPPR_TIP = 'Pre-approve this job’s requests — they pass as if ' +
        'you pressed Approve. Safety layer and mower are never auto-approved.';

    function autoApproveLabel(on) {
        return on ? '🛡✓ auto-approve on' : '🛡 auto-approve';
    }

    function autoApproveToggle(j) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ja autoap' + (j.auto ? ' on' : '');
        b.textContent = autoApproveLabel(j.auto);
        b.title = AUTOAPPR_TIP;
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var want = !j.auto;
            b.disabled = true;
            jobPost(j.ref, 'autoapprove', {on: want}).then(function (d) {
                b.disabled = false;
                if (!d || d.ok === false) { b.title = 'failed: ' + ((d && d.error) || '?'); return; }
                j.auto = want;
                b.classList.toggle('on', want);
                b.textContent = autoApproveLabel(want);
                b.title = AUTOAPPR_TIP;
                afterAction();
            }).catch(function (e) {
                b.disabled = false;
                b.title = /HTTP 404/.test(String(e)) ? 'API not available yet' : 'failed: ' + e;
            });
        });
        return b;
    }

    function deleteBtn(j) {
        return actBtn('🗑', 'danger', 'Delete job', function (b) {
            inlineConfirm(b, function () {
                b.disabled = true;
                var p = parseRef(j.ref);
                jobPost(j.ref, 'delete', null, function () {
                    if (p.kind === 's') { return schedPost(p.id, 'delete'); }
                    rememberDismissed(p.id);
                    return Promise.resolve({ok: true});
                }).then(function () {
                    b.disabled = false;
                    afterAction();
                    renderJobsPane(lastJobs.filter(function (x) { return x.ref !== j.ref; }), true);
                }).catch(function (e) {
                    b.disabled = false;
                    b.title = 'delete failed: ' + e;
                });
            });
        });
    }

    function outputPreview(card, j) {
        var out = j.last && j.last.output;
        if (!out) { return; }
        var key = j.ref + ':out';
        var pre = document.createElement('pre');
        pre.className = 'so' + (jobOpen.has(key) ? ' full' : '');
        pre.textContent = String(out);
        card.appendChild(pre);
        var text = String(out);
        if (text.split('\n').length > 6 || text.length > 400) {
            var more = document.createElement('button');
            more.type = 'button'; more.className = 'vz-more';
            more.textContent = jobOpen.has(key) ? 'less' : 'more';
            more.addEventListener('click', function () {
                var on = !pre.classList.contains('full');
                pre.classList.toggle('full', on);
                more.textContent = on ? 'less' : 'more';
                jobOpenSet(key, on);
            });
            card.appendChild(more);
        }
    }

    function followUpBtn(j) {
        var p = parseRef(j.ref);
        return actBtn('Follow up', '', 'Prepares „pokračuj na ' + p.id + ': …"', function () {
            if (!inputEl) { return; }
            inputEl.value = 'pokračuj na ' + p.id + ': ';
            openChatSection();
            inputEl.focus();
        });
    }

    // ------------------------------------------------------------- the card
    /* ---- the expandable detail: what the job did and created ------------
       Robert: „chci vidět u každého jobu, co udělal, co vytvořil".  Lazy —
       GET /api/unified/jobs/<ref>/detail on first open, cached until the
       card's fingerprint changes (a finished leg, a new state).  When the
       endpoint is missing the section still renders from what the card row
       already carries, with an inline note. */
    var detailCache = {};

    function detailFetch(j) {
        var cached = detailCache[j.ref];
        var fp = jobFp(j);
        if (cached && cached.fp === fp) { return cached.promise; }
        var promise = api('/api/unified/jobs/' + encodeURIComponent(j.ref) + '/detail')
            .then(function (d) {
                if (!d || d.ok === false) { throw new Error((d && d.error) || 'no detail'); }
                return d;
            });
        detailCache[j.ref] = {fp: fp, promise: promise};
        promise.catch(function () { delete detailCache[j.ref]; });
        return promise;
    }

    function jdRow(body, cls, text, tip) {
        var el = document.createElement('div');
        el.className = cls;
        el.textContent = text;
        if (tip) { el.title = tip; }
        body.appendChild(el);
        return el;
    }

    function jdHeading(body, text) {
        var h = document.createElement('div');
        h.className = 'jd-h';
        h.textContent = text;
        body.appendChild(h);
    }

    function copyPath(el, path) {
        function done() {
            var old = el.textContent;
            el.textContent = 'copied';
            setTimeout(function () { el.textContent = old; }, 900);
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(path).then(done, function () {});
                return;
            }
        } catch (e) {}
        try {                                   // http:// fallback
            var ta = document.createElement('textarea');
            ta.value = path;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            done();
        } catch (e2) {}
    }

    function renderDetail(body, d, j) {
        body.textContent = '';
        if (d.note) { jdRow(body, 'sx', d.note); }

        jdHeading(body, 'Goal');
        var goal = jdRow(body, 'jd-txt', d.goal || j.text || '(none)');
        goal.title = '';

        if (d.final_reply) {
            jdHeading(body, 'Result');
            var res = document.createElement('div');
            res.className = 'jd-txt jd-md';
            try { renderMarkdown(res, d.final_reply); }
            catch (e) { res.textContent = d.final_reply; }
            body.appendChild(res);
        }

        var arts = d.artifacts || [];
        if (arts.length) {
            jdHeading(body, 'Files (' + arts.length + ')');
            arts.forEach(function (a) {
                var row = document.createElement('div');
                row.className = 'jd-file';
                var op = document.createElement('span');
                op.className = 'jd-op op-' + (a.op || 'write');
                op.textContent = a.op || '';
                row.appendChild(op);
                var pa = document.createElement('span');
                pa.className = 'jd-path';
                pa.textContent = a.path;
                pa.title = a.path + ' — click copies the path';
                pa.addEventListener('click', function () { copyPath(pa, a.path); });
                row.appendChild(pa);
                if ((a.count || 1) > 1) {
                    var c = document.createElement('span');
                    c.className = 'sx';
                    c.textContent = '×' + a.count;
                    row.appendChild(c);
                }
                body.appendChild(row);
            });
        }

        var legsLog = d.legs && d.legs.length ? d.legs : null;
        if (legsLog) {
            jdHeading(body, 'Timeline (' + legsLog.length + ' legs)');
            legsLog.forEach(function (leg) {
                var row = document.createElement('div');
                row.className = 'jd-leg';
                var head = document.createElement('div');
                head.className = 'jd-leg-h';
                var n = document.createElement('span');
                n.className = 'sx';
                n.textContent = '#' + (leg.n || '?');
                head.appendChild(n);
                head.appendChild(pill(leg.verdict || '?', 'v-' +
                    String(leg.verdict || '').toLowerCase().replace(/[^a-z]/g, ''),
                    ''));
                if (leg.duration_s) {
                    var du = document.createElement('span');
                    du.className = 'sx';
                    du.textContent = humanSpan(leg.duration_s);
                    head.appendChild(du);
                }
                row.appendChild(head);
                if (leg.reply_head) {
                    var rh = document.createElement('div');
                    rh.className = 'jd-leg-t';
                    rh.textContent = leg.reply_head;
                    rh.title = leg.reply_head;
                    row.appendChild(rh);
                }
                if (leg.driver_action) {
                    jdRow(row, 'jd-drv', 'driver — ' + leg.driver_action);
                }
                body.appendChild(row);
            });
        }

        var runs = d.runs || [];
        if (runs.length) {                       // script definitions
            jdHeading(body, 'Recent runs (' + runs.length + ')');
            runs.slice(-8).reverse().forEach(function (r) {
                jdRow(body, 'jd-leg-t mono',
                      relTime(r.ts) + ' · exit ' + (r.exit === null ? '?' : r.exit) +
                      ' · ' + String(r.stdout || r.error || '').split('\n')[0].slice(0, 80),
                      String(r.stdout || r.error || ''));
            });
        }

        var posts = d.posts || [];
        if (posts.length) {
            jdHeading(body, 'Chat posts (' + posts.length + ')');
            posts.forEach(function (p) {
                jdRow(body, 'jd-leg-t', relTime(p.ts) + ' · ' + (p.head || ''),
                      p.head || '');
            });
        }

        var asks = d.approvals || [];
        if (asks.length) {
            jdHeading(body, 'Approvals');
            asks.forEach(function (a) {
                var row = document.createElement('div');
                row.className = 'jd-leg-h';
                /* auto-approved requests are never a pending row — they show
                   as their outcome, marked auto, with the deciding actor */
                var stTxt = a.auto ? 'auto-approved' : (a.state || '');
                row.appendChild(pill('#' + a.id + ' ' + stTxt,
                    a.state === 'pending' ? 'state-blocked' : (a.auto ? 'autoap' : ''),
                    a.by || ''));
                var tx = document.createElement('span');
                tx.className = 'jd-leg-t';
                tx.textContent = a.plain_head || '';
                tx.title = a.plain_head || '';
                row.appendChild(tx);
                body.appendChild(row);
            });
        }
    }

    function detailSection(card, j) {
        jobSection(card, j.ref, 'detail', '☰ Details', function (body) {
            jdRow(body, 'sx', 'loading…');
            detailFetch(j).then(function (d) {
                renderDetail(body, d, j);
            }).catch(function () {
                // Endpoint not there (yet): show what the row itself knows.
                renderDetail(body, {
                    note: 'detail API not available yet — showing the card data',
                    goal: j.text,
                    final_reply: j.last && j.last.output,
                    artifacts: [], legs: [], posts: [], approvals: [],
                }, j);
            });
        }, {always: true});
    }

    function buildJobCard(j, group) {
        var p = parseRef(j.ref);
        var card = document.createElement('div');
        card.className = 'vagent-ujob k-' + j.kind + ' st-' + (STATUS_CLS[j.status] || '') +
            (j.stalled ? ' stalled' : '');
        card.setAttribute('data-ref', j.ref);
        card.setAttribute('data-group', group);

        // ---- head: kind · #ref title · status · stalled · muted
        var top = document.createElement('div');
        top.className = 'st';
        top.appendChild(pill(j.kind, 'kind-' + (j.kind === 'script' ? 'script' : 'prompt'),
            j.kind === 'script'
                ? 'Program written by Hermes, run by the core without a model'
                : 'Text handed to Hermes on every run'));
        var name = document.createElement('span');
        name.className = 'sn';
        name.textContent = '#' + p.id + ' ' + (j.title || j.text || '');
        name.title = j.text || j.title || '';
        top.appendChild(name);
        var stLabel = j.status === 'draft' ? 'writing program…' : j.status;
        top.appendChild(pill(stLabel, 'state-' + (STATUS_CLS[j.status] || 'queued'),
            j.status === 'failed' ? ((j.last && j.last.error) || '') : ''));
        if (j.stalled) {
            top.appendChild(pill('stalled', 'stalled', j.note || 'no progress — the driver is stepping in'));
        }
        if (j.policy === 'silent') {
            top.appendChild(pill('muted', 'muted', 'Silent — this job does not post to chat'));
        }
        if (j.auto) {
            top.appendChild(pill('🛡✓ auto-approve on', 'autoap', AUTOAPPR_TIP));
        }
        if (j.archived) {
            card.classList.add('archived');
            top.appendChild(pill('archived', 'arch',
                j.archived_ts ? 'Archived ' +
                    new Date(j.archived_ts * 1000).toLocaleString('cs-CZ') : ''));
        }
        card.appendChild(top);

        // ---- facts
        var mid = document.createElement('div');
        mid.className = 'sm';
        if (j.schedule) {
            mid.appendChild(pill(scheduleText(j.schedule), 'ivl',
                j.schedule.next_run ? new Date(j.schedule.next_run * 1000).toLocaleString('cs-CZ') : ''));
            var nx = document.createElement('span');
            nx.className = 'sx';
            nx.textContent = (j.status === 'paused') ? 'paused'
                : 'next ' + relTime(j.schedule.next_run);
            mid.appendChild(nx);
        }
        if (j.legs) { mid.appendChild(pill('legs ' + j.legs, '', 'number of legs')); }
        if (j.slot !== undefined && j.slot !== null) {
            mid.appendChild(pill('slot ' + j.slot, '', 'parallel slot'));
        }
        if (j.subagents) { mid.appendChild(pill('subagents ' + j.subagents, '', 'running subagents')); }
        if (j.from_sched) { mid.appendChild(pill('task #' + j.from_sched, '', 'started by a recurring job')); }
        if (j.last && j.last.ts) {
            var lastLbl = document.createElement('span');
            lastLbl.className = 'sx';
            lastLbl.textContent = 'last ' + relTime(j.last.ts) +
                (group !== 'running' && durationText(j) ? ' · ' + durationText(j) : '');
            lastLbl.title = new Date(j.last.ts * 1000).toLocaleString('cs-CZ');
            mid.appendChild(lastLbl);
        }
        if (group === 'running' && durationText(j)) {
            mid.appendChild(pill(durationText(j), '', 'running for'));
        }
        if (j.runs) {
            var rc = document.createElement('span');
            rc.className = 'sx';
            var counted = (j.ok_count || 0) + (j.fail_count || 0);
            rc.textContent = j.runs + '×' +
                (counted ? ' (' + (j.ok_count || 0) + ' ok / ' + (j.fail_count || 0) + ' fail' +
                      (j.overruns ? ' · ' + j.overruns + ' overrun' : '') + ')' : '');
            rc.title = 'runs so far';
            mid.appendChild(rc);
        }
        if (j.job_id && String(j.job_id) !== String(p.id)) {
            mid.appendChild(refButton('j:' + j.job_id, '→ #' + j.job_id));
        }
        if (j.incident) {
            var ib = document.createElement('button');
            ib.type = 'button'; ib.className = 'vagent-ref';
            ib.textContent = 'incident ' + j.incident;
            ib.title = 'Show it in Incidents';
            ib.addEventListener('click', function () { activateTab('incidents'); });
            mid.appendChild(ib);
        }
        if (mid.childNodes.length) { card.appendChild(mid); }

        // ---- what it is doing / why it failed
        var live = j.note ? 'driver: ' + j.note : (j.live || '');
        if (live) {
            var ll = document.createElement('div');
            ll.className = 'jl';
            ll.textContent = live;
            ll.title = live;
            card.appendChild(ll);
        }
        var err = j.last && j.last.error;
        if (err && (group === 'attention' || j.status === 'failed')) {
            var eb = document.createElement('div');
            eb.className = 'se';
            eb.textContent = String(err);
            eb.title = String(err);
            card.appendChild(eb);
        }
        if (group === 'scheduled' && j.kind === 'script') { outputPreview(card, j); }
        if (group === 'attention' && j.kind === 'script') { outputPreview(card, j); }
        if (j.program) {
            var pp = document.createElement('div');
            pp.className = 'sx mono';
            pp.textContent = String(j.program).split('/').slice(-2).join('/');
            pp.title = j.program;
            card.appendChild(pp);
        }

        // ---- group actions
        var acts = document.createElement('div');
        acts.className = 'sa';
        if (group === 'running') {
            acts.appendChild(actBtn('Cancel', '', 'Stop this job', function (b) {
                inlineConfirm(b, function () {
                    jobPost(j.ref, 'cancel', null, function () {
                        return chatFallback('zruš práci ' + p.id);
                    }).then(afterAction).catch(function (e) { b.title = 'cancel failed: ' + e; });
                });
            }));
            if (j.status === 'blocked' || j.stalled) {
                acts.appendChild(actBtn('Resume', 'primary', 'Nudge the job on', function (b) {
                    b.disabled = true;
                    jobPost(j.ref, 'resume', null, function () {
                        return chatFallback('pokračuj na ' + p.id);
                    }).then(function () { b.disabled = false; afterAction(); })
                      .catch(function (e) { b.disabled = false; b.title = 'resume failed: ' + e; });
                }));
            }
        } else if (group === 'scheduled') {
            var on = j.status !== 'paused';
            acts.appendChild(actBtn(on ? '⏸' : '▶', '', on ? 'Pause' : 'Resume', function (b) {
                b.disabled = true;
                jobPost(j.ref, on ? 'pause' : 'resume', null, function () {
                    return schedPost(p.id, on ? 'pause' : 'resume');
                }).then(function () { b.disabled = false; afterAction(); })
                  .catch(function (e) { b.disabled = false; b.title = 'failed: ' + e; });
            }));
            acts.appendChild(actBtn('↻', '', 'Run now (outside the schedule)', function (b) {
                b.disabled = true;
                jobPost(j.ref, 'run', null, function () { return schedPost(p.id, 'run'); })
                    .then(function () {
                        setTimeout(function () { b.disabled = false; }, 1500);
                        afterAction();
                    }).catch(function (e) { b.disabled = false; b.title = 'run failed: ' + e; });
            }));
        } else if (group === 'attention') {
            if (j.status !== 'draft') {
                acts.appendChild(actBtn('↻ Run', '', 'Run again as it stands', function (b) {
                    b.disabled = true;
                    jobPost(j.ref, 'run', null, function () {
                        return p.kind === 's' ? schedPost(p.id, 'run')
                            : chatFallback('zopakuj práci #' + p.id);
                    }).then(function () { b.disabled = false; afterAction(); })
                      .catch(function (e) { b.disabled = false; b.title = 'run failed: ' + e; });
                }));
            }
            acts.appendChild(followUpBtn(j));
        } else if (group === 'archive') {
            // read-only shelf: Unarchive + Details, nothing else
            acts.appendChild(actBtn('Unarchive', 'primary',
                'Take this job off the shelf', function (b) {
                b.disabled = true;
                jobPost(j.ref, 'unarchive', null).then(function () {
                    archFetched = false;    // shelf changed: refetch on open
                    pollArchived();
                    afterAction();
                }).catch(function (e) { b.disabled = false; b.title = 'unarchive failed: ' + e; });
            }));
            card.appendChild(acts);
            detailSection(card, j);
            return card;
        } else {   // recent
            acts.appendChild(followUpBtn(j));
        }
        if (unifiedOk === true && group !== 'running' &&
            (group !== 'scheduled' || j.status === 'paused' || j.status === 'draft')) {
            acts.appendChild(actBtn('🗄', '', 'Archive — put this job away '
                + '(inert, kept, reversible)', function (b) {
                b.disabled = true;
                jobPost(j.ref, 'archive', null).then(function () {
                    archFetched = false;    // shelf changed: refetch on open
                    afterAction();
                }).catch(function (e) { b.disabled = false; b.title = 'archive failed: ' + e; });
            }));
        }
        acts.appendChild(policySelect(j));
        acts.appendChild(autoApproveToggle(j));
        acts.appendChild(deleteBtn(j));
        card.appendChild(acts);

        // ---- sections
        detailSection(card, j);
        if (group === 'attention' || group === 'recent') { rerunSection(card, j); }
        editSection(card, j);
        return card;
    }

    // ------------------------------------------------------------- the pane
    var jobCards = {};          // ref → {node, fp}
    var jobsFp = null, deferredJobs = null;
    var GROUPS = [
        {id: 'running', label: 'Running',
         empty: 'Nothing is running right now.'},
        {id: 'scheduled', label: 'Scheduled',
         empty: 'No scheduled job. Create one above — every N, or daily at a time.'},
        {id: 'attention', label: 'Needs attention',
         empty: 'Nothing failed or waiting to be written.'},
        {id: 'recent', label: 'Recent', empty: 'No finished job yet.'},
        {id: 'archive', label: 'Archive',
         empty: 'Nothing archived. Old finished jobs move here on their own.'}
    ];

    function sortJobs(group, items) {
        items.sort(function (a, b) {
            if (group === 'scheduled') {
                return ((a.schedule && a.schedule.next_run) || 1e12) -
                       ((b.schedule && b.schedule.next_run) || 1e12);
            }
            return ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0);
        });
        return items;
    }

    function renderJobsPane(list, force) {
        if (!jobsListBox) { return; }
        list = list || [];
        var sig = JSON.stringify(list.map(jobFp)) + '|' + unifiedOk + '|' + jobsErr;
        lastJobs = list;
        if (!force && sig === jobsFp) { return; }
        if (!force && uiInteracting(jobsBody)) {
            if (!deferredJobs) {
                deferredJobs = setInterval(function () {
                    if (uiInteracting(jobsBody)) { return; }
                    clearInterval(deferredJobs); deferredJobs = null;
                    renderJobsPane(lastJobs, true);
                }, 1500);
            }
            return;
        }
        jobsFp = sig;
        var buckets = {running: [], scheduled: [], attention: [], recent: [],
                       archive: []};
        list.forEach(function (j) { buckets[groupOf(j)].push(j); });
        var keep = {};
        var pane = jobsBody ? jobsBody.closest('.vagent-pane') : null;
        var scrollTop = pane ? pane.scrollTop : 0;
        var frag = document.createDocumentFragment();

        if (jobsErr) {
            var note = document.createElement('div');
            note.className = 'vagent-empty';
            note.textContent = jobsErr;
            frag.appendChild(note);
        }

        GROUPS.forEach(function (g) {
            if (g.id === 'archive' && unifiedOk !== true) { return; }
            var items = sortJobs(g.id, buckets[g.id]);
            var total = items.length;
            if (g.id === 'recent') { items = items.slice(0, 10); }
            var head = document.createElement('div');
            head.className = 'vagent-sh g-' + g.id;
            head.appendChild(document.createTextNode(g.label));
            var c = document.createElement('span');
            c.className = 'vagent-cnt' + (g.id === 'attention' && total ? ' warn' : '');
            c.textContent = (g.id === 'archive' && !archFetched) ? '…' : String(total);
            head.appendChild(c);

            var host;
            if (g.id === 'recent' || g.id === 'archive') {
                // collapsed by default; the fold survives every poll — and
                // the archive shelf is only ever FETCHED once it is opened
                var gkey = 'group:' + g.id;
                var det = document.createElement('details');
                det.className = 'vagent-group';
                det.open = jobIsOpen(gkey, false);
                var sum = document.createElement('summary');
                sum.appendChild(head);
                det.appendChild(sum);
                det.addEventListener('toggle', function () {
                    jobOpenSet(gkey, det.open);
                    if (g.id === 'archive' && det.open && !archFetched) { pollArchived(); }
                });
                host = document.createElement('div');
                det.appendChild(host);
                frag.appendChild(det);
            } else {
                frag.appendChild(head);
                host = document.createElement('div');
                host.className = 'vagent-group-body';
                frag.appendChild(host);
            }

            if (g.id === 'archive' && !archFetched) {
                var loading = document.createElement('div');
                loading.className = 'vagent-empty';
                loading.textContent = 'Open to load the archive…';
                host.appendChild(loading);
                return;
            }
            if (!items.length) {
                var e = document.createElement('div');
                e.className = 'vagent-empty';
                e.textContent = g.empty;
                host.appendChild(e);
                return;
            }
            items.forEach(function (j) {
                var fpv = jobFp(j);
                var prev = jobCards[j.ref];
                var node;
                if (prev && prev.fp === fpv && prev.node) {
                    node = prev.node;                   // untouched DOM
                } else {
                    node = buildJobCard(j, g.id);
                    jobCards[j.ref] = {node: node, fp: fpv};
                }
                if (String(j.ref) === String(highlightRef)) { node.classList.add('highlight'); }
                keep[j.ref] = true;
                host.appendChild(node);
            });
        });
        Object.keys(jobCards).forEach(function (r) { if (!keep[r]) { delete jobCards[r]; } });
        jobsListBox.textContent = '';
        jobsListBox.appendChild(frag);
        if (pane) { pane.scrollTop = scrollTop; }

        var act = buckets.running.length;
        var att = buckets.attention.length;
        jobsBadge.textContent = act || att ? String(act + att) : '';
        jobsBadge.className = 'vagent-cnt' + (att ? ' warn' : '');
        jobsBadge.title = act + ' running · ' + att + ' need attention';
        if (att) { flagTab('jobs'); }
    }

    // --------------------------------------------------------------- polling
    function pollJobs() {
        return api('/api/jobs').then(function (d) {
            legacyJobs = (d && d.jobs) || [];
            ctxJobs = legacyJobs;
            paintCtx();
            if (unifiedOk !== true) { renderJobsPane(composeJobs()); }
        }).catch(function () {});
    }

    function pollLegacySchedules() {
        return api('/api/schedules').then(function (d) {
            if (!d || d.ok === false) {
                legacySchedOk = false; legacySched = [];
                jobsErr = 'Scheduled jobs: ' + ((d && d.error) || 'API not available yet');
                return;
            }
            legacySchedOk = true;
            jobsErr = '';
            legacySched = d.schedules || [];
        }).catch(function (e) {
            legacySchedOk = false;
            legacySched = [];
            if (/HTTP 404/.test(String(e))) { jobsErr = 'Scheduled jobs: API not available yet.'; }
        });
    }

    function pollUnified() {
        if (!jobsListBox) { return Promise.resolve(); }
        if (unifiedOk === false) {
            return pollLegacySchedules().then(function () { renderJobsPane(composeJobs()); });
        }
        return api('/api/unified/jobs').then(function (d) {
            if (!d || d.ok === false) {
                unifiedOk = false;
                return pollLegacySchedules().then(function () { renderJobsPane(composeJobs()); });
            }
            unifiedOk = true;
            jobsErr = '';
            lastUnifiedRaw = d.jobs || [];
            renderJobsPane(composeJobs());
            return null;
        }).catch(function (e) {
            if (/HTTP 404/.test(String(e))) {
                unifiedOk = false;          // the contract has not landed yet
                jobsErr = '';
                return pollLegacySchedules().then(function () { renderJobsPane(composeJobs()); });
            }
            jobsErr = 'Jobs: agent (:8088) not responding.';
            renderJobsPane(lastJobs, true);
            return null;
        });
    }

    // ------------------------------------------------------------ highlights
    /* „#63", „#j:63" anywhere → the Jobs tab with that card lit up. */
    var highlightRef = null;

    function highlightJob(id) {
        var p = parseRef(id);
        highlightRef = p.ref;
        activateTab('jobs');
        setTimeout(function () {
            if (!jobsListBox) { return; }
            var hit = jobsListBox.querySelector('[data-ref="' + p.ref.replace(/"/g, '') + '"]');
            Array.prototype.forEach.call(jobsListBox.querySelectorAll('.vagent-ujob.highlight'),
                function (n) { if (n !== hit) { n.classList.remove('highlight'); } });
            if (!hit) { return; }
            hit.classList.add('highlight');
            var det = hit.closest('details.vagent-group');
            if (det && !det.open) { det.open = true; jobOpenSet('group:recent', true); }
            try { hit.scrollIntoView({block: 'nearest'}); } catch (e) {}
        }, 80);
        setTimeout(function () {
            if (highlightRef !== p.ref) { return; }
            highlightRef = null;
            if (!jobsListBox) { return; }
            Array.prototype.forEach.call(jobsListBox.querySelectorAll('.vagent-ujob.highlight'),
                function (n) { n.classList.remove('highlight'); });
        }, 6000);
    }

    function highlightSched(id) { highlightJob('s:' + id); }

    // ------------------------------------------------------- creation form
    var INTERVALS = [
        {label: '15 min', s: 900}, {label: '1 h', s: 3600}, {label: '2 h', s: 7200},
        {label: '4 h', s: 14400}, {label: '12 h', s: 43200}, {label: '24 h', s: 86400},
        {label: 'custom', s: 0}
    ];
    var INTERVALS_SCRIPT = [
        {label: '5 s', s: 5}, {label: '10 s', s: 10}, {label: '20 s', s: 20}, {label: '30 s', s: 30},
        {label: '1 min', s: 60}, {label: '5 min', s: 300}, {label: 'custom', s: 0}
    ];

    function parseInterval(v, allowSeconds) {
        var m = /^\s*(\d+(?:[.,]\d+)?)\s*(s|sec|sek|m|min|h|hod|d|dn[ií])?\s*$/i.exec(v || '');
        if (!m) { return 0; }
        var n = parseFloat(m[1].replace(',', '.'));
        var u = (m[2] || (allowSeconds ? 's' : 'm')).toLowerCase().charAt(0);
        return Math.round(n * (u === 'h' ? 3600 : u === 'd' ? 86400 : u === 's' ? 1 : 60));
    }

    function renderJobForm(host) {
        var form = document.createElement('div');
        form.className = 'vagent-schedform vagent-jobform';
        var toggle = document.createElement('button');
        toggle.type = 'button'; toggle.className = 'ja';
        toggle.textContent = '+ new job';
        form.appendChild(toggle);
        var body = document.createElement('div');
        body.className = 'sf';
        body.style.display = 'none';

        // kind: prompt (text for Hermes) | script (a program the core runs)
        var kind = 'prompt', kb = {};
        var kindRow = document.createElement('div');
        kindRow.className = 'vagent-kind';
        [['prompt', 'Prompt', 'Hermes gets the text and works on it'],
         ['script', 'Script', 'Hermes writes a program once; the core then runs it without a model']]
            .forEach(function (k) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'vagent-ivl' + (k[0] === kind ? ' on' : '');
                b.textContent = k[1];
                b.title = k[2];
                b.addEventListener('click', function () { setKind(k[0]); });
                kindRow.appendChild(b);
                kb[k[0]] = b;
            });
        body.appendChild(kindRow);

        var ta = document.createElement('textarea');
        ta.rows = 2;
        body.appendChild(ta);
        var hint = document.createElement('div');
        hint.className = 'sx';
        body.appendChild(hint);

        // when: Now | every N | daily at HH:MM
        var when = 'now';
        var whenRow = document.createElement('div');
        whenRow.className = 'si';
        var wb = {};
        [['now', 'Now', 'Run once, right away'],
         ['every', 'Every…', 'Repeat on an interval'],
         ['daily', 'Daily at…', 'Once a day at a fixed time']].forEach(function (w) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'vagent-ivl' + (w[0] === when ? ' on' : '');
            b.textContent = w[1];
            b.title = w[2];
            b.addEventListener('click', function () { setWhen(w[0]); });
            whenRow.appendChild(b);
            wb[w[0]] = b;
        });
        body.appendChild(whenRow);

        var rowI = document.createElement('div');
        rowI.className = 'si';
        body.appendChild(rowI);
        var chosen = 7200, custom = null;

        function fillIntervals() {
            rowI.textContent = '';
            var list = kind === 'script' ? INTERVALS_SCRIPT : INTERVALS;
            chosen = kind === 'script' ? 20 : 7200;
            list.forEach(function (iv) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'vagent-ivl' + (iv.s === chosen ? ' on' : '');
                b.textContent = iv.label;
                b.addEventListener('click', function () {
                    Array.prototype.forEach.call(rowI.querySelectorAll('.vagent-ivl'),
                        function (x) { x.classList.remove('on'); });
                    b.classList.add('on');
                    chosen = iv.s;
                    custom.style.display = iv.s ? 'none' : '';
                    if (!iv.s) { custom.focus(); }
                });
                rowI.appendChild(b);
            });
            custom = document.createElement('input');
            custom.type = 'text';
            custom.placeholder = kind === 'script' ? 'e.g. 20s, 2m, 1h' : 'e.g. 90m, 3h, 2d';
            custom.style.display = 'none';
            rowI.appendChild(custom);
        }

        var timeRow = document.createElement('div');
        timeRow.className = 'si';
        var timeLbl = document.createElement('span');
        timeLbl.className = 'sx';
        timeLbl.textContent = 'at';
        var timeIn = document.createElement('input');
        timeIn.type = 'time';
        timeIn.value = '07:00';
        timeRow.appendChild(timeLbl); timeRow.appendChild(timeIn);
        body.appendChild(timeRow);

        // report policy
        var policy = 'progress';
        var polRow = document.createElement('div');
        polRow.className = 'si';
        var polLbl = document.createElement('span');
        polLbl.className = 'sx';
        polLbl.textContent = 'report';
        polLbl.title = POLICY_TIP;
        polRow.appendChild(polLbl);
        var pb = {};
        [['silent', 'Silent', 'Never posts to chat — log only'],
         ['result', 'Result', 'Posts the result'],
         ['progress', 'Progress', 'Posts progress and the result']].forEach(function (m) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'vagent-ivl';
            b.textContent = m[1];
            b.title = m[2];
            b.addEventListener('click', function () { setPolicy(m[0]); });
            polRow.appendChild(b);
            pb[m[0]] = b;
        });
        body.appendChild(polRow);

        // auto-approve: the owner's standing yes for this job's requests
        var autoRow = document.createElement('div');
        autoRow.className = 'si';
        var autoLab = document.createElement('label');
        autoLab.className = 'vagent-autoappr';
        autoLab.title = 'Safety layer and mower are never auto-approved.';
        var autoCb = document.createElement('input');
        autoCb.type = 'checkbox';
        autoLab.appendChild(autoCb);
        autoLab.appendChild(document.createTextNode(
            ' Auto-approve (pre-approve this job’s requests)'));
        autoRow.appendChild(autoLab);
        body.appendChild(autoRow);

        function setPolicy(p) {
            policy = p;
            Object.keys(pb).forEach(function (x) { pb[x].classList.toggle('on', x === p); });
        }
        function setWhen(w) {
            when = w;
            Object.keys(wb).forEach(function (x) { wb[x].classList.toggle('on', x === w); });
            rowI.style.display = w === 'every' ? '' : 'none';
            timeRow.style.display = w === 'daily' ? '' : 'none';
        }
        function setKind(k) {
            kind = k;
            Object.keys(kb).forEach(function (x) { kb[x].classList.toggle('on', x === k); });
            ta.placeholder = k === 'script'
                ? 'What should the program do? (e.g. udělej snímek z lidaru a vypiš, když je někdo okolo)'
                : 'What should Hermes do? (e.g. zkontroluj teploty a nahlas výkyvy)';
            hint.textContent = k === 'script'
                ? 'Hermes writes the program from this description; the core then runs it — no model per run. Seconds are fine as an interval.'
                : 'Every run is a Hermes job. Intervals from one minute up.';
            setPolicy(k === 'script' ? 'result' : 'progress');
            fillIntervals();
            setWhen(when);
        }
        setKind('prompt');
        setWhen('now');

        var rowB = document.createElement('div');
        rowB.className = 'sb';
        var ok = document.createElement('button');
        ok.type = 'button'; ok.className = 'ja primary';
        ok.textContent = 'Create';
        var msg = document.createElement('span');
        msg.className = 'sx';
        rowB.appendChild(ok); rowB.appendChild(msg);
        body.appendChild(rowB);
        form.appendChild(body);

        toggle.addEventListener('click', function () {
            var open = body.style.display === 'none';
            body.style.display = open ? '' : 'none';
            toggle.textContent = open ? '− close' : '+ new job';
            if (open) { ta.focus(); }
        });

        ok.addEventListener('click', function () {
            var text = ta.value.trim();
            if (!text) {
                msg.textContent = kind === 'script'
                    ? 'describe what the program should do' : 'write what should be done';
                return;
            }
            var every = 0, at = null;
            if (when === 'every') {
                every = chosen || parseInterval(custom.value, kind === 'script');
                if (kind === 'script' ? (!every || every < 1) : (!every || every < 60)) {
                    msg.textContent = kind === 'script' ? 'interval at least 1 s' : 'interval at least 1 min';
                    return;
                }
            } else if (when === 'daily') {
                at = timeIn.value || '';
                if (!/^\d{2}:\d{2}$/.test(at)) { msg.textContent = 'time as HH:MM'; return; }
            }
            var whenPayload = when === 'now' ? 'now'
                : when === 'every' ? {every_s: every} : {at_hhmm: at};
            var payload = {kind: kind, when: whenPayload, report_policy: policy, author: author};
            if (autoCb.checked) { payload.auto_approve = true; }
            if (kind === 'script') { payload.description = text; } else { payload.text = text; }
            ok.disabled = true;
            msg.textContent = 'creating…';

            function optimistic(ref) {
                var draft = {
                    ref: ref, kind: kind, title: text.slice(0, 60), text: text,
                    status: when === 'now' ? (kind === 'script' ? 'draft' : 'queued')
                        : (kind === 'script' ? 'draft' : 'scheduled'),
                    schedule: when === 'now' ? null
                        : {type: when === 'daily' ? 'daily' : 'interval',
                           every_s: every || 86400, at: at, next_run: null},
                    policy: policy, last: null, runs: 0, stalled: false, note: '',
                    incident: null, program: null, legs: null, slot: null,
                    auto: autoCb.checked, src: 'new'
                };
                renderJobsPane(lastJobs.concat([draft]), true);
            }

            api('/api/unified/jobs', {body: payload}).then(function (d) {
                ok.disabled = false;
                if (!d || d.ok === false) { msg.textContent = 'failed: ' + ((d && d.error) || '?'); return; }
                unifiedOk = true;
                msg.textContent = 'created ';
                if (d.ref) { msg.appendChild(refBtnFor(d.ref)); }
                ta.value = '';
                optimistic(d.ref || 'j:new');
                pollUnified();
            }).catch(function (e) {
                ok.disabled = false;
                if (!/HTTP 404/.test(String(e))) { msg.textContent = 'failed: ' + e; return; }
                unifiedOk = false;
                createLegacy(text, kind, when, every, at, policy, msg, ta, optimistic);
            });
        });

        host.appendChild(form);
        return form;
    }

    /* The contract is not live yet — do the same thing with what the core
       has today: a one-off prompt is a chat task, everything scheduled is a
       schedule row. */
    function createLegacy(text, kind, when, every, at, policy, msg, ta, optimistic) {
        if (when === 'now') {
            if (kind === 'script') {
                submitText('napiš si program, který ' + text + ', a spusť ho');
            } else {
                submitText(text);
            }
            msg.textContent = 'sent to chat (unified API not available yet)';
            ta.value = '';
            openChatSection();
            return;
        }
        var payload = kind === 'script'
            ? {kind: 'script', description: text, every_s: every || 86400,
               report_mode: policyToMode(policy), author: author}
            : {text: text, every_s: every || 86400, author: author};
        if (when === 'daily') { payload.at_hhmm = at; payload.every_s = 86400; }
        api('/api/schedules', {body: payload}).then(function (d) {
            if (!d || d.ok === false) { msg.textContent = 'failed: ' + ((d && d.error) || '?'); return; }
            msg.textContent = 'created ';
            if (d.job_id) { msg.appendChild(refBtnFor('j:' + d.job_id)); }
            ta.value = '';
            optimistic('s:' + d.id);
            pollUnified();
        }).catch(function (e) {
            msg.textContent = 'failed: ' + e;
        });
    }

    function renderJobsTab(el) {
        jobsBody = el;
        renderJobForm(el);
        jobsListBox = document.createElement('div');
        jobsListBox.className = 'vagent-joblist';
        el.appendChild(jobsListBox);
        renderJobsPane(composeJobs(), true);
        pollUnified();
    }

    // ======================================================= APPROVALS block
    var decidedAsks = {}, askOutcomes = {}, askSeen = {};
    var lastAsks = [];
    var gateBody = null;
    var gateBadge = document.createElement('span');
    gateBadge.className = 'vagent-cnt warn';

    function decideAsk(item, allow, row, execChoice) {
        Array.prototype.forEach.call(row.querySelectorAll('button'),
            function (b) { b.disabled = true; });
        var body = {id: item.id, decision: allow ? 'allow' : 'deny', by: author};
        if (allow && execChoice) { body.executor = execChoice; }
        api('/api/approvals/decide', {body: body})
            .then(function (d) {
                var good = !!(d && d.ok);
                if (good) { decidedAsks[item.id] = 1; }
                askOutcomes[item.id] = {
                    ok: good,
                    text: good ? [d.message, d.note].filter(Boolean).join(' ')
                        : ((d && d.error) || 'Decision was not accepted.'),
                    until: Date.now() + 12000
                };
                pollApprovals();
            }).catch(function () {
                askOutcomes[item.id] = {
                    ok: false,
                    text: 'Decision was not sent — agent unreachable. Try again.',
                    until: Date.now() + 12000
                };
                renderApprovals(lastAsks);
            });
    }

    /* Structured approval card, v2 (owner, 2026-08-28): „První potřebuju
       vědět, CO to je, KDO a nějaká základní data — a pak krátkou, stručnou,
       ale výstižnou žádost tak, aby ji pochopil i dement.  Za ní teprve
       následují kompletní detaily."  So the card has four layers, in this
       order, and nothing above the buttons ever scrolls:
         1. header strip — type chip (Plan approval / Held command / Resume
                           job), source (job ref + goal head), who asked, age
                           and the auto-deny countdown;
         2. the ask      — ONE plain Czech sentence composed client-side from
                           the detail fields (askSentence), detail.what as the
                           fallback;
         3. decision row — Approve / Deny (two-tap confirm) plus the compact
                           „via:" executor segment, recommended preselected;
         4. details      — every section collapsed: Plan/Command/Brief,
                           Context, What happens, Risk.
       Open sections survive the poll redraw (askOpen), so does the executor
       pick (askExec); a fingerprint skips the redraw entirely when nothing
       rendered has changed. */
    var askOpen = {};        // '<id>:<section>' -> true/false
    var askExec = {};        // id -> chosen executor (survives the redraw)
    var askRowsMap = {};     // id -> rendered row (for focus from the ctx bar)
    var askFocus = {id: null, until: 0};
    var lastAskFp = null;

    var ASK_KIND = {
        plan:    {chip: 'Plan approval', icon: '▤', cls: 'k-plan',   sec: 'Plan'},
        command: {chip: 'Held command',  icon: '❯', cls: 'k-cmd',    sec: 'Command'},
        resume:  {chip: 'Resume job',    icon: '▶', cls: 'k-resume', sec: 'Brief'}
    };
    /* waiting work (a plan, a parked job) outranks a held one-off command */
    var ASK_RANK = {plan: 0, resume: 1, command: 2};

    function askKind(item) {
        var p = ((item.detail || {}).payload) || {};
        if (p.kind && ASK_KIND[p.kind]) { return p.kind; }
        if (item.tool === 'job' || /^job:/.test(String(item.rule || ''))) {
            return 'resume';
        }
        return 'command';
    }

    function headCut(s, n) {
        s = String(s === null || s === undefined ? '' : s)
            .replace(/\s+/g, ' ').trim();
        if (s.length <= n) { return s; }
        return s.slice(0, n - 1).replace(/[\s,;:.–-]+$/, '') + '…';
    }

    /* Header pill: coarser than the old waitedText, so two pills always fit one phone
       line (and so the fingerprint does not churn every minute). */
    function askAge(seconds) {
        var s = Math.max(0, Math.round(seconds || 0));
        if (s < 60) { return 'waiting ' + s + ' s'; }
        if (s < 3600) { return 'waiting ' + Math.round(s / 60) + ' min'; }
        return 'waiting ' + Math.floor(s / 3600) + ' h';
    }

    /* „práce #147 (…)" is the job itself asking — say so short, the source
       line already carries the goal. */
    function askWho(item) {
        var m = /^prác[ei]\s*#(\d+)/i.exec(String(item.asker || ''));
        if (m) { return 'job #' + m[1]; }
        return headCut(item.asker || 'Hermes', 26);
    }

    function askJobNum(item, ctx) {
        if (item.job_id) { return item.job_id; }
        var m = /(\d+)/.exec(String((ctx && ctx.job_ref) || ''));
        return m ? Number(m[1]) : null;
    }

    /* Who is asking, as a name we can put in a sentence.  „Hermes (chat)" →
       Hermes; „práce #11 (…)" → the agent itself, i.e. Hermes. */
    function askAgent(item) {
        var m = /^([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^\s(,]*)/.exec(String(item.asker || ''));
        return m ? m[1] : 'Hermes';
    }

    /* Title of a plan, for the one-sentence ask.  The bodies come from job
       posts, so they are one long line: „[SCOPE] … Návrh: <title> Problém: …".
       Cut at the next „Heading:" and keep it short. */
    function planTitle(text) {
        var t = String(text || '');
        var m = /(?:N[áa]vrh|Pl[áa]n|Plan|Z[áa]m[ěe]r|Cíl|Goal)\s*:\s*([^\n:;.]{4,80})/i
            .exec(t);
        if (m) {
            var got = m[1];
            var after = t.charAt(m.index + m[0].length);
            if (after === ':') { got = got.replace(/\s*\S+$/, ''); }
            got = got.trim();
            if (got.length >= 4) { return headCut(got, 58); }
        }
        var first = t.replace(/^\s*\[[A-Z]+\][^\n]*?(?=[A-ZÁ-Ž])/, '')
            .split('\n')[0];
        first = String(first || '').split(/[.:]\s/)[0];
        return first && first.length >= 4 ? headCut(first, 58) : '';
    }

    /* The whole point of the card: one sentence a tired owner understands.
       Returns {text, code} — `code` is the monospace tail for held commands. */
    function askSentence(item, kind) {
        var d = item.detail || {};
        var ctx = d.context || {};
        var payload = d.payload || {};
        var n = askJobNum(item, ctx);
        var state = ctx.job_state || item.job_state || '';
        var out = null;
        if (kind === 'plan') {
            var title = planTitle(payload.text || '');
            out = {text: askAgent(item) + ' připravil plán ' +
                (title ? '„' + title + '“ ' : '') +
                (n ? 'pro práci #' + n + ' ' : '') +
                'a čeká na tvoje ANO, aby ho začal stavět.'};
        } else if (kind === 'resume') {
            if (n) {
                out = {text: 'Práce #' + n +
                    (state === 'blocked' ? ' se zasekla' : ' stojí') +
                    ' a čeká na tvoje ANO, aby mohla pokračovat dál.'};
            }
        } else {
            var cmd = payload.text || item.command || '';
            if (cmd) {
                out = {text: 'Robot chce jednou spustit tento příkaz: ',
                       code: headCut(cmd, 78)};
            }
        }
        if (!out || !out.text) {
            out = {text: d.what || item.plain || item.command || 'Čeká se na tvoje rozhodnutí.'};
        }
        return out;
    }

    function askPill(box, text, cls) {
        if (!text) { return; }
        var p = document.createElement('span');
        p.className = 'apill' + (cls ? ' ' + cls : '');
        p.textContent = text;
        p.title = text;
        box.appendChild(p);
    }

    function askSection(item, key, label, open) {
        var d = document.createElement('details');
        d.className = 'askd';
        var stored = askOpen[item.id + ':' + key];
        d.open = stored === undefined ? !!open : !!stored;
        var s = document.createElement('summary');
        s.textContent = label + ' ';
        var hint = document.createElement('span');
        hint.className = 'ashow';
        hint.textContent = 'show';
        s.appendChild(hint);
        d.appendChild(s);
        d.addEventListener('toggle', function () {
            askOpen[item.id + ':' + key] = !!d.open;
        });
        return d;
    }

    function askLine(row, cls, label, text) {
        if (!text) { return; }
        var line = document.createElement('div');
        line.className = 'ar ' + cls;
        var l = document.createElement('span');
        l.className = 'al';
        l.textContent = label;
        line.appendChild(l);
        var v = document.createElement('span');
        v.className = 'av';
        v.textContent = text;
        v.title = text;
        line.appendChild(v);
        row.appendChild(line);
    }

    function highlightAsk(id) {
        if (!id) { return; }
        askFocus = {id: id, until: Date.now() + 6000};
        var row = askRowsMap[id];
        if (row) { row.classList.add('focus'); }
    }

    function askRow(item) {
        var d = item.detail || null;
        var payload = (d && d.payload) || null;
        var ctx = (d && d.context) || {};
        var kind = askKind(item);
        var K = ASK_KIND[kind];
        var row = document.createElement('div');
        row.className = 'vagent-ask ' + K.cls;
        if (askFocus.id === item.id && askFocus.until > Date.now()) {
            row.classList.add('focus');
        }
        row._askId = item.id;
        askRowsMap[item.id] = row;

        // ---- 1. header strip: WHAT it is, WHO asks, basic data -----------
        var head = document.createElement('div');
        head.className = 'ah';
        var chip = document.createElement('span');
        chip.className = 'akind';
        chip.textContent = K.icon + ' ' + K.chip;
        head.appendChild(chip);
        var pills = document.createElement('span');
        pills.className = 'ahp';
        askPill(pills, askAge(item.waiting_s));
        if (item.left_text) {
            askPill(pills, 'auto-deny in ' + item.left_text, 'warn');
        }
        head.appendChild(pills);
        row.appendChild(head);

        var src = document.createElement('div');
        src.className = 'ah asrc';
        var jobRef = ctx.job_ref ||
            (item.job_id ? 'j:' + item.job_id : '');
        var goal = ctx.job_goal || item.job_title || '';
        if (jobRef) {
            var jb = document.createElement('button');
            jb.type = 'button';
            jb.className = 'aref';
            jb.textContent = jobRef + (goal ? ' · ' + headCut(goal, 50) : '');
            jb.title = 'Open ' + jobRef + (goal ? ' — ' + goal : '');
            jb.addEventListener('click', function () { highlightJob(jobRef); });
            src.appendChild(jb);
        } else if (ctx.incident_id || item.incident_id) {
            var inc = document.createElement('span');
            inc.className = 'asrct';
            inc.textContent = 'incident ' + (ctx.incident_id || item.incident_id);
            src.appendChild(inc);
        }
        var by = document.createElement('span');
        by.className = 'aby';
        by.textContent = 'by ' + askWho(item) +
            ((ctx.job_state || item.job_state) === 'blocked' ? ' · parked' : '');
        by.title = item.asker || 'Hermes';
        src.appendChild(by);
        row.appendChild(src);

        // ---- 2. the ask, in one plain sentence ---------------------------
        var say = document.createElement('div');
        say.className = 'asay';
        var sentence = askSentence(item, kind);
        say.textContent = sentence.text;
        if (sentence.code) {
            var code = document.createElement('code');
            code.className = 'acode';
            code.textContent = sentence.code;
            say.appendChild(code);
        }
        say.title = (d && d.what) || item.plain || '';
        row.appendChild(say);

        /* Without structured detail (an older ask, or detail_for having
           failed — the server sends `detail: null` and says so) there is no
           „What happens" section, and the sentence above is only the command
           itself.  The plain Czech line is then the ONLY thing on the card
           saying what that command does, so it goes right under the ask. */
        if (!d && (item.plain || item.reason)) {
            var plain = document.createElement('div');
            plain.className = 'asay aplain';
            plain.textContent = item.plain || item.reason;
            plain.title = plain.textContent;
            row.appendChild(plain);
        }

        // ---- 3. decision row — reachable without scrolling ---------------
        var execChoice = askExec[item.id] || (d && d.recommended) || null;
        var act = document.createElement('div');
        act.className = 'ar aact';
        var yes = document.createElement('button');
        yes.className = 'ay';
        yes.type = 'button';
        yes.textContent = 'Approve';
        yes.title = 'Runs it (same as /allow ' + item.id + ')';
        yes.addEventListener('click', function () {
            decideAsk(item, true, row, execChoice);
        });
        act.appendChild(yes);
        var no = document.createElement('button');
        no.className = 'an';
        no.type = 'button';
        no.textContent = 'Deny';
        no.title = 'Does not run it (same as /deny ' + item.id + ')';
        var armed = false, armTimer = null;
        no.addEventListener('click', function () {
            if (!armed) {                       // inline confirm, one tap more
                armed = true;
                no.textContent = 'Deny — really?';
                no.classList.add('armed');
                armTimer = setTimeout(function () {
                    armed = false;
                    no.textContent = 'Deny';
                    no.classList.remove('armed');
                }, 6000);
                return;
            }
            if (armTimer) { clearTimeout(armTimer); }
            decideAsk(item, false, row);
        });
        act.appendChild(no);
        if (d && d.executors && d.executors.length) {
            var erow = document.createElement('span');
            erow.className = 'aexec';
            var el = document.createElement('span');
            el.className = 'al';
            el.textContent = 'via:';
            erow.appendChild(el);
            d.executors.forEach(function (ex) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'aeb';
                if (ex.id === execChoice) { b.classList.add('sel'); }
                // just the name („Claude Opus 5 (single long run)" → Claude);
                // the full label and its description live in the tooltip
                b.textContent = String(ex.label || ex.id).split(/[\s(]/)[0] +
                    (ex.id === d.recommended ? ' ★' : '');
                b.title = (ex.label || ex.id) + ' — ' + (ex.desc || '') +
                    (ex.id === d.recommended ? ' (recommended)' : '');
                b.addEventListener('click', function () {
                    execChoice = ex.id;
                    askExec[item.id] = ex.id;
                    Array.prototype.forEach.call(
                        erow.querySelectorAll('button'), function (o) {
                            o.classList.remove('sel');
                        });
                    b.classList.add('sel');
                });
                erow.appendChild(b);
            });
            act.appendChild(erow);
        }
        row.appendChild(act);

        // ---- 4. everything else, collapsed -------------------------------
        if (d) {
            var det = document.createElement('div');
            det.className = 'adet';
            var any = false;

            if (payload && payload.text) {
                var words = String(payload.text).trim().split(/\s+/)
                    .filter(Boolean).length;
                var sec = askSection(item, 'payload',
                    K.sec + ' · ' + words + ' words', false);
                var pre = document.createElement('pre');
                pre.className = 'apre' +
                    (payload.kind === 'command' ? ' mono' : '');
                pre.textContent = payload.text;
                sec.appendChild(pre);
                if (payload.truncated) {
                    var more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'amore';
                    more.textContent = 'show full';
                    more.addEventListener('click', function () {
                        more.disabled = true;
                        api('/api/approvals/' + item.id + '/detail')
                            .then(function (full) {
                                var t = full && full.detail &&
                                    full.detail.payload &&
                                    full.detail.payload.text;
                                if (t) { pre.textContent = t; more.textContent = ''; }
                                else { more.disabled = false; }
                            }).catch(function () { more.disabled = false; });
                    });
                    sec.appendChild(more);
                }
                det.appendChild(sec);
                any = true;
            }

            if (ctx.job_ref || ctx.incident_id || ctx.job_goal) {
                var csec = askSection(item, 'ctx', 'Context', false);
                if (ctx.job_goal) {
                    var g = document.createElement('div');
                    g.className = 'actx goal';
                    g.textContent = ctx.job_goal;
                    g.title = ctx.job_goal;
                    csec.appendChild(g);
                }
                var facts = document.createElement('div');
                facts.className = 'actx dim';
                facts.textContent = [
                    ctx.job_ref ? ctx.job_ref : '',
                    ctx.job_state ? 'state ' + ctx.job_state : '',
                    ctx.legs ? 'legs ' + ctx.legs : ''
                ].filter(Boolean).join(' · ');
                if (facts.textContent) { csec.appendChild(facts); }
                if (ctx.last_error) {
                    var er = document.createElement('div');
                    er.className = 'actx err';
                    er.textContent = 'last error: ' + ctx.last_error;
                    er.title = ctx.last_error;
                    csec.appendChild(er);
                }
                (ctx.recent_posts || []).forEach(function (p) {
                    var line = document.createElement('div');
                    line.className = 'actx post';
                    line.textContent = '· ' + p.head;
                    line.title = p.head;
                    csec.appendChild(line);
                });
                det.appendChild(csec);
                any = true;
            }

            if (d.what || d.why || d.action_on_approve || d.action_on_deny) {
                var wsec = askSection(item, 'what', 'What happens', false);
                askLine(wsec, 'awhat', 'Request', d.what);
                askLine(wsec, 'awhy', 'Why', d.why);
                askLine(wsec, 'ayes', 'On approve', d.action_on_approve);
                askLine(wsec, 'ano', 'On deny', d.action_on_deny);
                det.appendChild(wsec);
                any = true;
            }

            if (d.risk && d.risk.length) {
                var rsec = askSection(item, 'risk',
                    'Risk · ' + d.risk.length, false);
                var rrow = document.createElement('div');
                rrow.className = 'ar arisk';
                d.risk.forEach(function (r) {
                    var pill = document.createElement('span');
                    pill.className = 'vagent-pill risk';
                    pill.textContent = r;
                    pill.title = r;
                    rrow.appendChild(pill);
                });
                rsec.appendChild(rrow);
                det.appendChild(rsec);
                any = true;
            }
            if (any) { row.appendChild(det); }
        } else if (item.command) {
            // legacy ask (no structured detail): keep the raw command visible
            var lsec = askSection(item, 'payload', 'Command', false);
            var lpre = document.createElement('pre');
            lpre.className = 'apre mono';
            lpre.textContent = item.command;
            lsec.appendChild(lpre);
            var ldet = document.createElement('div');
            ldet.className = 'adet';
            ldet.appendChild(lsec);
            row.appendChild(ldet);
        }
        return row;
    }

    /* Everything the card renders — so the poll can skip the redraw (and keep
       the open sections, the executor pick and any inline confirm) when
       nothing visible changed. */
    function asksFingerprint(list, outcomeKeys) {
        var parts = (list || []).map(function (a) {
            var d = a.detail || {};
            var p = d.payload || {};
            var c = d.context || {};
            return [a.id, askKind(a), askAge(a.waiting_s), a.left_text || '',
                a.asker || '', a.job_id || '', a.job_state || '',
                d.what || '', a.plain || '', a.command || '',
                p.kind || '', String(p.text || '').length, p.truncated ? 1 : 0,
                c.job_ref || '', c.job_goal || '', c.job_state || '',
                c.legs || 0, c.last_error || '',
                (c.recent_posts || []).map(function (x) { return x.head; }).join('~'),
                (d.risk || []).join('|'),
                (d.executors || []).map(function (e) { return e.id; }).join(','),
                d.recommended || '', askExec[a.id] || '',
                decidedAsks[a.id] ? 1 : 0].join('');
        });
        return parts.join('') + '' + outcomeKeys.join(',');
    }

    function renderApprovals(list) {
        if (!gateBody) { return; }
        var sorted = (list || []).slice().sort(function (a, b) {
            var ra = ASK_RANK[askKind(a)];
            var rb = ASK_RANK[askKind(b)];
            if (ra !== rb) { return ra - rb; }
            return (b.asked || b.id || 0) - (a.asked || a.id || 0);
        });
        ctxAsks = sorted;
        paintCtx();
        lastAsks = list;
        var live = {};
        sorted.forEach(function (a) { live[a.id] = 1; });
        Object.keys(decidedAsks).forEach(function (id) {
            if (!live[id]) { delete decidedAsks[id]; }
        });
        Object.keys(askRowsMap).forEach(function (id) {
            if (!live[id]) { delete askRowsMap[id]; }
        });
        Object.keys(askExec).forEach(function (id) {
            if (!live[id]) { delete askExec[id]; }
        });
        Object.keys(askOpen).forEach(function (key) {
            if (!live[String(key).split(':')[0]]) { delete askOpen[key]; }
        });
        var now = Date.now();
        var outKeys = [];
        Object.keys(askOutcomes).forEach(function (id) {
            if (askOutcomes[id].until < now) { delete askOutcomes[id]; return; }
            outKeys.push(id + ':' + (askOutcomes[id].ok ? 1 : 0) + ':' +
                         askOutcomes[id].text);
        });
        var fresh = false;
        sorted.forEach(function (item) {
            if (!askSeen[item.id]) { askSeen[item.id] = 1; fresh = true; }
        });
        gateBadge.textContent = sorted.length ? String(sorted.length) : '';
        if (sorted.length) { flagTab('gate'); }  // a question outranks the fold
        if (fresh) { notify('approval', ''); }

        var fp = asksFingerprint(sorted, outKeys);
        if (fp === lastAskFp && gateBody.children && gateBody.children.length) {
            return;                              // nothing rendered changed
        }
        lastAskFp = fp;

        gateBody.textContent = '';
        var shown = 0;
        sorted.forEach(function (item) {
            if (decidedAsks[item.id]) { return; }
            gateBody.appendChild(askRow(item));
            shown += 1;
        });
        Object.keys(askOutcomes).forEach(function (id) {
            var row = document.createElement('div');
            row.className = 'vagent-ask ' + (askOutcomes[id].ok ? 'done' : 'bad');
            var line = document.createElement('div');
            line.className = 'am';
            line.textContent = (askOutcomes[id].ok ? '✓ ' : '✕ ') +
                askOutcomes[id].text;
            row.appendChild(line);
            gateBody.appendChild(row);
            shown += 1;
        });
        if (!shown) {
            var e = document.createElement('div');
            e.className = 'vagent-empty';
            e.textContent = 'Nothing waiting for approval.';
            gateBody.appendChild(e);
        }
    }

    function pollApprovals() {
        return api('/api/approvals').then(function (d) {
            renderApprovals((d && d.approvals) || []);
        }).catch(function () {});
    }

    // ==================================================== shared state poll
    var sharedState = {robot: null, health: null, ts: 0};

    function pollState() {
        return api('/api/state').then(function (d) {
            sharedState.robot = (d && d.state) || null;
            sharedState.age_s = d ? d.age_s : null;
            sharedState.ts = Date.now();
            document.dispatchEvent(new CustomEvent('vagent:state', {detail: sharedState}));
        }).catch(function () {});
    }

    // ------------------------------------------------------- status strip
    /* One glance: battery, RTK, dock, motors, core.  Fed by the same events
       the blocks get; unknown fields say '–' rather than guessing. */
    function installStatusStrip() {
        var strip = panel.querySelector('#vagent_status');
        if (!strip) { return; }
        function chip(label, value, cls) {
            var c = document.createElement('span');
            c.className = 'vagent-chip' + (cls ? ' ' + cls : '');
            var l = document.createElement('span');
            l.className = 'lbl';
            l.textContent = label;
            c.appendChild(l);
            c.appendChild(document.createTextNode(value));
            return c;
        }
        function paint(ev) {
            var src = (ev && ev.detail) || sharedState;
            var st = src.robot || {};
            var h = src.health;
            strip.textContent = '';
            var pct = st.battery_pct;
            strip.appendChild(chip('bat', pct != null ? Math.round(pct) + ' %' : '–',
                pct == null ? '' : pct > 50 ? 'good' : pct > 20 ? 'warn' : 'bad'));
            var rtk = st.rtk && typeof st.rtk === 'object' ? st.rtk.fix : st.rtk;
            strip.appendChild(chip('RTK', rtk || '–',
                rtk === 'fixed' ? 'good' : rtk === 'float' ? 'warn' :
                rtk ? 'bad' : ''));
            strip.appendChild(chip('dock', st.in_dock === true ? 'yes'
                : st.in_dock === false ? 'no' : '–'));
            strip.appendChild(chip('motors', st.motor_power === true ? 'on'
                : st.motor_power === false ? 'off' : '–'));
            var coreOk = !!(h && h.ok);
            strip.appendChild(chip('core', coreOk ? 'ok' : '–',
                coreOk ? 'good' : 'bad'));
        }
        document.addEventListener('vagent:state', paint);
        document.addEventListener('vagent:health', paint);
        paint();
    }

    function pollHealth() {
        return api('/api/health').then(function (d) {
            sharedState.health = d || null;
            document.dispatchEvent(new CustomEvent('vagent:health', {detail: sharedState}));
        }).catch(function () {});
    }

    // ---------------------------------------------------------- scheduling
    /* One scheduler. While the panel is visible: tasks 2 s, jobs+approvals
       3 s, state 5 s, plus each registered block's own poll. While hidden:
       one light badge poll every 30 s (approval count + unseen reports), so a
       closed panel costs the robot's CPU nearly nothing. */
    var timers = [];

    function every(ms, fn) { timers.push(setInterval(function () {
        if (isVisible()) { fn(); }
    }, ms)); }

    function schedule() {
        if (timers.length) {         // already scheduled; just kick once
            if (isVisible()) {
                pollTasks(); pollJobs(); pollUnified(); pollApprovals(); pollState(); pollHealth();
            }
            return;
        }
        every(2000, pollTasks);
        every(3000, function () { pollJobs(); pollApprovals(); });
        every(10000, pollUnified);      // schedules + the unified view
        every(5000, function () { pollState(); pollHealth(); });
        blocks.forEach(function (blk) {
            if (blk.poll && blk.poll.fn) { every(blk.poll.every_ms || 5000, blk.poll.fn); }
        });
        setInterval(function () {    // the closed-panel badge poll
            if (isVisible()) { return; }
            var seenId = parseInt(lsGet(LS_SEEN) || '0', 10) || 0;
            api('/api/tasks?since_id=' + seenId).then(function (d) {
                var fresh = ((d && d.tasks) || []).filter(function (t) {
                    return t.source === 'agent' &&
                        (t.state === 'done' || t.state === 'failed');
                });
                if (fresh.length) {
                    unread = fresh.length;
                    paintBadge();
                }
            }).catch(function () {});
            api('/api/approvals').then(function (d) {
                var n = ((d && d.approvals) || []).length;
                if (n && !unread) { unread = n; paintBadge(); }
            }).catch(function () {});
        }, 30000);
        setInterval(paintConn, 2000);
        if (isVisible()) {
            pollTasks(); pollJobs(); pollUnified(); pollApprovals(); pollState(); pollHealth();
        }
    }

    // ---------------------------------------------------------------- init
    function init() {
        panel.style.display = 'none';
        document.body.appendChild(panel);
        installToolbarButton();
        watchDrawer();
        watchKeyboard();

        /* No name box: the agent asks for the name in the chat and the core
           remembers it ([IDENTITA]).  The stored value still rides along. */
        installStatusStrip();

        var density = lsGet(LS_DENSITY) || '';
        if (density === 'compact') { panel.classList.add('vagent-compact'); }
        panel.querySelector('#vagent_density').addEventListener('click', function () {
            var on = panel.classList.toggle('vagent-compact');
            lsSet(LS_DENSITY, on ? 'compact' : '');
        });

        panel.querySelector('#vagent_clear').addEventListener('click', function () {
            if (msgsEl) {
                msgsEl.textContent = '';
                var e = document.createElement('div');
                e.className = 'vagent-empty';
                e.textContent = 'View cleared — history stays on the robot (/clear deletes it for real).';
                msgsEl.appendChild(e);
            }
        });

        panel.querySelector('#vagent_stop').addEventListener('click', function () {
            var stopBtn = panel.querySelector('#vagent_stop');
            inlineConfirm(stopBtn, function () { doStop(); });
        });
        function doStop() {
            api('/api/stop', {body: {author: displayName || author}})
                .then(function (d) {
                    openChatSection();
                    if (msgsEl) {
                        turn('bot', 'vagent-err', (d && d.reply) || 'STOP accepted.', []);
                    }
                }).catch(function () {
                    if (msgsEl) {
                        turn('bot', 'vagent-err',
                             'STOP was not delivered — agent web (:8088) not responding!', []);
                    }
                });
        }

        // Built-in blocks. Approvals on top: a held command is a question the
        // robot cannot answer itself, so it outranks everything below it.
        var gateSum = gateBadge;
        registerBlock({id: 'gate', title: 'Approvals', order: 10,
                       summaryExtra: gateSum,
                       render: function (el) { gateBody = el; }});
        // One Jobs tab: running work, schedules, failures and history together.
        registerBlock({id: 'jobs', title: 'Jobs', order: 20,
                       summaryExtra: jobsBadge,
                       render: renderJobsTab,
                       poll: {every_ms: 8000, fn: function () {
                           if (tabBtns.jobs && tabBtns.jobs.classList.contains('active')) { pollUnified(); }
                       }},
                       onOpen: function () { pollUnified(); }});
        registerBlock({id: 'chat', title: 'Chat', order: 30, render: renderChat});
        built = true;
        mountBlocks();

        document.addEventListener('keydown', function (ev) {
            if (ev.altKey && !ev.ctrlKey && !ev.metaKey &&
                    String(ev.key).toLowerCase() === 'a') {
                ev.preventDefault();
                togglePanel();
            }
        });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && panelActive) {
                clearUnread(); markSeenNow(); scrollChatBottom();
                schedule();   // kick: fresh state/jobs/tasks now, not in 5 s
            }
        });

        schedule();
        paintBadge();
        paintConn();

        // Reopen if it was open last time — after map_view.js restored its own
        // panel (it runs later in the load and would win the drawer anyway).
        if (lsGet(LS_OPEN) === '1') {
            setTimeout(function () {
                var d = drawerEls();
                var takenByOther = d.drawer && d.drawer.classList.contains('open') &&
                    d.title && d.title.textContent !== 'Agent';
                if (!takenByOther) { openPanel(); }
            }, 700);
        }
    }

    // ------------------------------------------------------------- exports
    window.VAgent = {
        registerBlock: registerBlock,
        api: api,
        isVisible: isVisible,
        notify: notify,
        open: openPanel,
        close: function () { deactivate(true); },
        toggle: togglePanel,
        submitText: submitText,
        activateTab: activateTab,
        flagTab: flagTab,
        highlightJob: highlightJob,
        highlightSched: highlightSched,
        inlineConfirm: inlineConfirm,
        incidentActions: incidentActions,
        actionButtons: actionButtons,
        renderMarkdown: renderMarkdown,
        state: sharedState,
        authorId: author,
        displayName: function () { return displayName; },
        http: AGENT_HTTP
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
