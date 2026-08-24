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
    var REF_RE = /(^|[\s(,;:])(?:(práce|práci|job|úkol)\s+)?#(\d{1,6})(?=$|[\s,.;:)])/gi;

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
        b.title = 'Show job #' + id;
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
            out.push({start: s, end: m.index + m[0].length, ref: m[3],
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
    var TAB_LABEL = {chat: 'Chat', jobs: 'Jobs', gate: 'Approvals', tasks: 'Tasks',
                     robot: 'Robot', incidents: 'Incidents', vice: 'More'};
    var TAB_ORDER = ['chat', 'jobs', 'gate', 'tasks', 'robot', 'incidents', 'vice'];
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
        msgsEl.appendChild(wrap);
        if (stick) { msgsEl.scrollTop = msgsEl.scrollHeight; }
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
            lnk.title = 'Show this task in Tasks';
            lnk.addEventListener('click', function (e) {
                e.stopPropagation();
                if (sid) { highlightSched(sid); } else { activateTab('tasks'); }
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
            ((d && d.tasks) || []).forEach(function (t) { renderTask(t, false); });
            if (isVisible()) { markSeenNow(); }
        }).catch(function () {});
    }

    function loadHistory() {
        msgsEl.textContent = '';
        seen = {};
        lastTaskId = 0;
        var loading = document.createElement('div');
        loading.className = 'vagent-empty';
        loading.textContent = 'Loading conversation history…';
        msgsEl.appendChild(loading);
        var found = false;
        function page(since) {
            var q = '/api/tasks?since_id=' + since +
                (scope === 'mine' ? '&author=' + encodeURIComponent(author) : '');
            return api(q).then(function (data) {
                if (loading.parentNode) { loading.remove(); }
                var rows = (data && data.tasks) || [];
                rows.forEach(function (t) { if (renderTask(t, true)) { found = true; } });
                if (rows.length === 100) { return page(rows[rows.length - 1].id); }
                if (!found) {
                    var e = document.createElement('div');
                    e.className = 'vagent-empty';
                    e.textContent = 'Hi, I am Vitulus. Ask about status, the map or jobs.';
                    msgsEl.appendChild(e);
                }
                scrollChatBottom();
                markSeenNow();
                return null;
            });
        }
        page(0).catch(function () {
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

    // ============================================================ JOBS block
    var dismissed = {};
    try { dismissed = JSON.parse(lsGet(LS_JOBS) || '{}') || {}; } catch (e) { dismissed = {}; }

    function rememberDismissed(id) {
        dismissed[id] = 1;
        var keys = Object.keys(dismissed);
        if (keys.length > 200) {
            keys.sort(function (a, b) { return a - b; })
                .slice(0, 100).forEach(function (k) { delete dismissed[k]; });
        }
        lsSet(LS_JOBS, JSON.stringify(dismissed));
    }

    function jobLabel(job) {
        var mins = Math.max(0, Math.round((job.elapsed_s || 0) / 60));
        var leg = job.leg ? 'leg ' + job.leg : null;
        if (job.state === 'running') {
            return [leg, job.steps ? job.steps + ' steps' : 'starting',
                    mins ? mins + ' min' : null].filter(Boolean).join(' · ');
        }
        if (job.state === 'blocked') { return [leg, 'waiting for you'].filter(Boolean).join(' · '); }
        if (job.state === 'done') { return leg ? leg + ' · done' : 'done'; }
        if (job.state === 'cancelled') { return 'cancelled'; }
        if (job.state === 'failed') { return 'failed'; }
        if (job.state === 'queued') { return 'queued'; }
        return job.state || '';
    }

    var jobsBody = null;
    var jobsBadge = document.createElement('span');
    jobsBadge.className = 'vagent-cnt';

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
            var pill = document.createElement('span');
            pill.className = 'vagent-pill ' + running.state;
            pill.textContent = running.state === 'running' ? 'running' : 'waiting';
            jb.appendChild(pill);
            var t = document.createElement('span');
            t.className = 'ct';
            t.textContent = '#' + running.id + ' ' +
                String(running.text || '').slice(0, 60);
            jb.appendChild(t);
            var el = document.createElement('span');
            el.className = 'ce';
            el.textContent = humanDuration(running.elapsed_s || 0);
            jb.appendChild(el);
            jb.title = 'Switch to Jobs';
            jb.addEventListener('click', function () { activateTab('jobs'); });
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
            ab.addEventListener('click', function () { activateTab('gate'); });
            bar.appendChild(ab);
        }
    }

    function renderJobs(list) {
        if (!jobsBody) { return; }
        ctxJobs = list || [];
        paintCtx();
        jobsBody.textContent = '';
        var shown = 0, active = 0;
        list.forEach(function (job) {
            if (job.state === 'running' || job.state === 'blocked' ||
                job.state === 'queued') { active += 1; }
            if (dismissed[job.id]) { return; }
            shown += 1;
            var row = document.createElement('div');
            row.className = 'vagent-job ' + (job.state || '') +
                (job.stalled ? ' stalled' : '') +
                (String(job.id) === String(highlightId) ? ' hl' : '');
            row.setAttribute('data-job', job.id);
            var mark = document.createElement('span');
            if (job.state === 'running') { mark.className = 'vagent-spin'; mark.textContent = '⟳'; }
            else if (job.state === 'blocked') { mark.textContent = '⏸'; }
            else if (job.state === 'queued') { mark.textContent = '⋯'; }
            else { mark.textContent = job.state === 'done' ? '✓' : '✕'; }
            row.appendChild(mark);
            var title = document.createElement('span');
            title.className = 'jt';
            title.textContent = '#' + job.id + ' ' + (job.text || '');
            title.title = job.text || '';
            row.appendChild(title);
            var detail = job.state === 'blocked' ? job.blocked : job.last;
            if ((job.state === 'running' || job.state === 'blocked') && detail) {
                var live = document.createElement('span');
                live.className = 'jl';
                live.textContent = detail;
                live.title = detail;
                row.appendChild(live);
            }
            var num = document.createElement('span');
            num.className = 'jn';
            num.textContent = jobLabel(job);
            row.appendChild(num);
            if (job.stalled) {
                var st = document.createElement('span');
                st.className = 'vagent-pill stalled';
                st.textContent = 'stalled';
                st.title = job.driver_note || 'no progress — the driver is stepping in';
                row.appendChild(st);
            }

            if (job.state === 'running' || job.state === 'queued') {
                var cancel = document.createElement('button');
                cancel.className = 'ja';
                cancel.type = 'button';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', function () {
                    inlineConfirm(cancel, function () {
                        submitText('zruš práci ' + job.id);
                        openChatSection();
                    });
                });
                row.appendChild(cancel);
            }
            if (job.state === 'blocked') {
                var go = document.createElement('button');
                go.className = 'ja';
                go.type = 'button';
                go.textContent = 'Resume';
                go.addEventListener('click', function () {
                    submitText('pokračuj na ' + job.id);
                    openChatSection();
                });
                row.appendChild(go);
            }
            if (job.state !== 'running' && job.state !== 'blocked' && job.state !== 'queued') {
                var x = document.createElement('button');
                x.className = 'jx';
                x.type = 'button';
                x.textContent = '✕';
                x.title = 'Remove from list';
                x.addEventListener('click', function () {
                    rememberDismissed(job.id);
                    row.remove();
                });
                row.appendChild(x);
            }
            jobsBody.appendChild(row);
        });
        if (!shown) {
            var e = document.createElement('div');
            e.className = 'vagent-empty';
            e.textContent = 'No background jobs.';
            jobsBody.appendChild(e);
        }
        jobsBadge.textContent = active ? String(active) : '';
        renderTasksJobs(list);
    }

    function openChatSection() {
        activateTab('chat');
    }

    /* „#63" anywhere → Práce tab with that job lit up for a few seconds. */
    var highlightId = null;

    function highlightJob(id) {
        highlightId = String(id);
        activateTab('jobs');
        if (jobsBody) {
            Array.prototype.forEach.call(jobsBody.querySelectorAll('.vagent-job'), function (r) {
                r.classList.toggle('hl', r.getAttribute('data-job') === highlightId);
            });
            var hit = jobsBody.querySelector('.vagent-job.hl');
            if (hit && hit.scrollIntoView) { hit.scrollIntoView({block: 'nearest'}); }
        }
        setTimeout(function () {
            if (highlightId === String(id)) { highlightId = null; }
            if (jobsBody) {
                Array.prototype.forEach.call(jobsBody.querySelectorAll('.vagent-job.hl'),
                    function (r) { r.classList.remove('hl'); });
            }
        }, 6000);
    }

    function pollJobs() {
        return api('/api/jobs').then(function (d) {
            renderJobs((d && d.jobs) || []);
        }).catch(function () {});
    }

    // ============================================================ TASKS block
    /* Dlouhodobé úkoly (schedules) + a compact mirror of running jobs with
       the driver's view (legs, stalled, slot, subagents).  Robert: „bude je
       evidovat a vizualizovat a ovládat v panelu AGENT". */
    var tasksBody = null, schedBox = null, runBox = null, schedForm = null;
    var tasksBadge = document.createElement('span');
    tasksBadge.className = 'vagent-cnt warn';
    var schedApiOk = null;      // null = unknown, false = 404 (old core)
    var lastSchedules = [];

    function humanEvery(s) {
        s = Number(s) || 0;
        if (!s) { return '–'; }
        if (s < 60) { return 'every ' + Math.round(s) + ' s'; }
        if (s % 86400 === 0) { return 'every ' + (s / 86400 === 1 ? 'day' : (s / 86400) + ' days'); }
        if (s % 3600 === 0) { return 'every ' + (s / 3600) + ' h'; }
        if (s % 60 === 0) { return 'every ' + (s / 60) + ' min'; }
        return 'every ' + (s < 600 ? Math.round(s) + ' s' : (s / 60).toFixed(1) + ' min');
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

    function humanMs(sec) {
        if (sec === null || sec === undefined || sec === '') { return ''; }
        var s = Number(sec);
        if (!isFinite(s)) { return ''; }
        return s < 1 ? Math.round(s * 1000) + ' ms' : s.toFixed(s < 10 ? 2 : 1) + ' s';
    }

    function schedAction(id, verb, btn, body) {
        var payload = {author: author};
        if (body) { Object.keys(body).forEach(function (k) { payload[k] = body[k]; }); }
        return api('/api/schedules/' + id + '/' + verb, {method: 'POST', body: payload})
            .then(function (d) { pollSchedules(); return d; })
            .catch(function (e) {
                if (btn) { btn.title = 'failed: ' + e; }
                turn('bot', 'vagent-err', 'Task #' + id + ' – ' + verb + ' failed: ' + e, []);
                throw e;
            });
    }

    /* Redraw discipline for the Tasks tab (same rules as agent_blocks.js):
       unchanged data → no DOM; user's hand in the pane → defer. */
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
    var schedFp = null, runFp = null, deferredSched = null, deferredRun = null;

    /* Open state of card sections (output / edit / program / log) lives
       outside the DOM, so a redraw after a poll never folds what the owner
       opened.  Keys: '<schedule id>:<section>'. */
    var SCHED_OPEN_KEY = 'vitulus_agent_sched_open';
    var schedOpen = (function () {
        var s = new Set();
        try { JSON.parse(sessionStorage.getItem(SCHED_OPEN_KEY) || '[]').forEach(function (k) { s.add(k); }); }
        catch (e) {}
        return s;
    })();
    function schedOpenSet(key, on) {
        if (on) { schedOpen.add(key); } else { schedOpen.delete(key); }
        try { sessionStorage.setItem(SCHED_OPEN_KEY, JSON.stringify(Array.from(schedOpen))); } catch (e) {}
    }
    var schedCards = {};            // id → {node, fp}
    var schedCache = {};            // id → {program, log} fetched on demand
    var modeApiOk = null;           // null = unknown, false = /mode returned 404

    function schedFingerprint(s) {
        return JSON.stringify([s.id, s.kind, s.title, s.text, s.every_s, s.enabled, s.state,
            s.next_run, s.last_run, s.last_job_id, s.last_state, s.run_count, s.program,
            s.report_mode, s.last_output, s.last_exit, s.last_duration_s, s.fail_count,
            s.ok_count, s.overruns, s.last_error, s.timeout_s]);
    }

    function pill(txt, cls, tip) {
        var p = document.createElement('span');
        p.className = 'vagent-pill ' + (cls || '');
        p.textContent = txt;
        if (tip) { p.title = tip; }
        return p;
    }

    function schedState(s) {
        // Older core has no `state`: derive it from `enabled`.
        if (s.state) { return s.state; }
        return s.enabled ? 'active' : 'paused';
    }

    function highlightSched(id) {
        activateTab('tasks');
        setTimeout(function () {
            var c = schedBox && schedBox.querySelector('[data-sched="' + id + '"]');
            if (!c) { return; }
            c.classList.add('highlight');
            try { c.scrollIntoView({block: 'nearest'}); } catch (e) {}
            setTimeout(function () { c.classList.remove('highlight'); }, 6000);
        }, 80);
    }

    /* A collapsible section inside a card (output / edit / program / log).
       `render(body)` is called when the section opens for the first time
       (or again when `refresh` is true). */
    function schedSection(card, s, key, label, render, opts) {
        opts = opts || {};
        var full = s.id + ':' + key;
        var det = document.createElement('details');
        det.className = 'vagent-secd ' + key;
        det.open = schedOpen.has(full);
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
            schedOpenSet(full, det.open);
            if (det.open) { paint(); }
        });
        if (det.open) { paint(); }
        card.appendChild(det);
        return det;
    }

    function buildSchedCard(s) {
        var kind = s.kind === 'script' ? 'script' : 'agent';
        var state = schedState(s);
        var card = document.createElement('div');
        card.className = 'vagent-sched ' + kind + ' st-' + state +
            (state === 'paused' ? ' paused' : '');
        card.setAttribute('data-sched', s.id);

        var top = document.createElement('div');
        top.className = 'st';
        top.appendChild(pill(kind, 'kind-' + kind, kind === 'script'
            ? 'Program written by Hermes, run by the core without a model'
            : 'Text task handed to Hermes on every run'));
        var name = document.createElement('span');
        name.className = 'sn';
        name.textContent = '#' + s.id + ' ' + (s.title || s.text || '');
        name.title = s.text || s.title || '';
        top.appendChild(name);
        top.appendChild(pill(humanEvery(s.every_s), 'ivl', s.timeout_s ? 'timeout ' + s.timeout_s + ' s' : ''));
        card.appendChild(top);

        var mid = document.createElement('div');
        mid.className = 'sm';
        // State pill (script kinds carry a real state; agent kinds active/paused)
        var stLabel = state === 'draft' ? 'writing program…' : state;
        var stp = pill(stLabel, 'state-' + state, state === 'failed' ? (s.last_error || '') : '');
        mid.appendChild(stp);
        if (state === 'draft' && s.last_job_id) {
            mid.appendChild(refButton(s.last_job_id, '→ #' + s.last_job_id));
        }
        var last = document.createElement('span');
        last.className = 'sx';
        last.textContent = 'last ' + (s.last_run ? relTime(s.last_run) : 'never') +
            (kind === 'script' && s.last_duration_s !== undefined && s.last_duration_s !== null
                ? ' · ' + humanMs(s.last_duration_s) : '');
        last.title = s.last_run ? new Date(s.last_run * 1000).toLocaleString('cs-CZ') : '';
        mid.appendChild(last);
        if (kind === 'script') {
            if (s.last_exit !== undefined && s.last_exit !== null) {
                mid.appendChild(pill('exit ' + s.last_exit, Number(s.last_exit) === 0 ? 'done' : 'failed',
                    Number(s.last_exit) === 0 ? 'last run ok' : 'last run failed'));
            }
            var cnt = document.createElement('span');
            cnt.className = 'sx';
            cnt.textContent = (s.ok_count || 0) + ' ok / ' + (s.fail_count || 0) + ' fail' +
                (s.overruns ? ' · ' + s.overruns + ' overrun' : '');
            cnt.title = 'successful / failed runs' + (s.overruns ? ' · runs skipped because the previous one was still going' : '');
            mid.appendChild(cnt);
        } else {
            if (s.last_state) { mid.appendChild(pill(s.last_state, s.last_state)); }
            if (s.last_job_id && state !== 'draft') { mid.appendChild(refButton(s.last_job_id, '→ #' + s.last_job_id)); }
            if (s.run_count) {
                var rc = document.createElement('span');
                rc.className = 'sx';
                rc.textContent = s.run_count + '×';
                mid.appendChild(rc);
            }
        }
        var next = document.createElement('span');
        next.className = 'sx';
        next.textContent = (state === 'active' || (state !== 'draft' && s.enabled))
            ? 'next ' + relTime(s.next_run) : (state === 'draft' ? '' : 'paused');
        next.title = s.next_run ? new Date(s.next_run * 1000).toLocaleString('cs-CZ') : '';
        mid.appendChild(next);
        card.appendChild(mid);

        if (state === 'failed' && s.last_error) {
            var err = document.createElement('div');
            err.className = 'se';
            err.textContent = s.last_error;
            err.title = s.last_error;
            card.appendChild(err);
        }

        // ---- script kind: output, mode, edit, program, log
        if (kind === 'script') {
            if (s.last_output) {
                var outKey = s.id + ':out';
                var pre = document.createElement('pre');
                pre.className = 'so' + (schedOpen.has(outKey) ? ' full' : '');
                pre.textContent = String(s.last_output);
                card.appendChild(pre);
                var lines = String(s.last_output).split('\n').length;
                if (lines > 6 || String(s.last_output).length > 400) {
                    var more = document.createElement('button');
                    more.type = 'button'; more.className = 'vz-more';
                    more.textContent = schedOpen.has(outKey) ? 'less' : 'more';
                    more.addEventListener('click', function () {
                        var on = !pre.classList.contains('full');
                        pre.classList.toggle('full', on);
                        more.textContent = on ? 'less' : 'more';
                        schedOpenSet(outKey, on);
                    });
                    card.appendChild(more);
                }
            }
            var modeRow = document.createElement('div');
            modeRow.className = 'sr';
            var ml = document.createElement('span');
            ml.className = 'sx';
            ml.textContent = 'report';
            modeRow.appendChild(ml);
            var modes = ['quiet', 'on_change', 'always'];
            var modeLabel = {quiet: 'quiet', on_change: 'on change', always: 'always'};
            if (modeApiOk === false) {
                modeRow.appendChild(pill(modeLabel[s.report_mode] || s.report_mode || 'on change', 'queued',
                    'quiet = log only · on change = chat when the output changes · always = every run'));
            } else {
                var sel = document.createElement('select');
                sel.className = 'vagent-sel';
                sel.title = 'quiet = log only · on change = chat when the output changes · always = every run';
                modes.forEach(function (m) {
                    var o = document.createElement('option');
                    o.value = m; o.textContent = modeLabel[m];
                    if ((s.report_mode || 'on_change') === m) { o.selected = true; }
                    sel.appendChild(o);
                });
                sel.addEventListener('change', function () {
                    sel.disabled = true;
                    api('/api/schedules/' + s.id + '/mode', {method: 'POST',
                        body: {report_mode: sel.value, author: author}})
                        .then(function (d) {
                            sel.disabled = false;
                            if (!d || d.ok === false) { sel.value = s.report_mode || 'on_change'; }
                            else { modeApiOk = true; pollSchedules(); }
                        }).catch(function (e) {
                            sel.disabled = false;
                            sel.value = s.report_mode || 'on_change';
                            if (/HTTP 404/.test(String(e))) { modeApiOk = false; renderSchedules(lastSchedules, true); }
                        });
                });
                modeRow.appendChild(sel);
            }
            if (s.program) {
                var pp = document.createElement('span');
                pp.className = 'sx mono';
                pp.textContent = String(s.program).split('/').slice(-2).join('/');
                pp.title = s.program;
                modeRow.appendChild(pp);
            }
            card.appendChild(modeRow);
        }

        var acts = document.createElement('div');
        acts.className = 'sa';
        if (state !== 'draft') {
            var pr = document.createElement('button');
            pr.type = 'button'; pr.className = 'ja';
            var isOn = state === 'active' || (s.enabled && state !== 'paused' && state !== 'failed');
            pr.textContent = isOn ? '⏸ pause' : '▶ resume';
            pr.title = isOn ? 'Pause' : (state === 'failed' ? 'Resume (clears the failure)' : 'Resume');
            pr.addEventListener('click', function () {
                pr.disabled = true;
                schedAction(s.id, isOn ? 'pause' : 'resume', pr).catch(function () {});
            });
            acts.appendChild(pr);
            var now = document.createElement('button');
            now.type = 'button'; now.className = 'ja';
            now.textContent = '↻ run now';
            now.title = 'Run now (outside the interval)';
            now.addEventListener('click', function () {
                now.disabled = true;
                schedAction(s.id, 'run', now).then(function () {
                    if (kind !== 'script') { openChatSection(); }
                    setTimeout(function () { now.disabled = false; }, 1500);
                }).catch(function () { now.disabled = false; });
            });
            acts.appendChild(now);
        }
        var del = document.createElement('button');
        del.type = 'button'; del.className = 'ja danger';
        del.textContent = '🗑';
        del.title = 'Delete task';
        del.addEventListener('click', function () {
            inlineConfirm(del, function () { schedAction(s.id, 'delete', del).catch(function () {}); });
        });
        acts.appendChild(del);
        card.appendChild(acts);

        if (kind === 'script') {
            // Edit — a prompt for Hermes: what should change in the program.
            schedSection(card, s, 'edit', 'Edit', function (body) {
                var ta = document.createElement('textarea');
                ta.rows = 2;
                ta.placeholder = 'What should change? (Czech is fine — it goes to Hermes)';
                body.appendChild(ta);
                var row = document.createElement('div');
                row.className = 'sb';
                var go = document.createElement('button');
                go.type = 'button'; go.className = 'ja primary';
                go.textContent = 'Send to Hermes';
                var msg = document.createElement('span');
                msg.className = 'sx';
                row.appendChild(go); row.appendChild(msg);
                body.appendChild(row);
                go.addEventListener('click', function () {
                    var change = ta.value.trim();
                    if (!change) { msg.textContent = 'write what should change'; return; }
                    go.disabled = true; msg.textContent = 'sending…';
                    api('/api/schedules/' + s.id + '/edit', {method: 'POST', body: {change: change, author: author}})
                        .then(function (d) {
                            go.disabled = false;
                            if (!d || d.ok === false) { msg.textContent = 'failed: ' + ((d && d.error) || '?'); return; }
                            msg.textContent = '';
                            if (d.job_id) { msg.appendChild(refButton(d.job_id, '→ #' + d.job_id + ' writing…')); }
                            else { msg.textContent = 'sent'; }
                            ta.value = '';
                            pollSchedules();
                        }).catch(function (e) {
                            go.disabled = false;
                            if (/HTTP 404/.test(String(e))) {
                                msg.textContent = 'API missing — sending to chat';
                                submitText('/skript uprav ' + s.id + ' ' + change);
                                openChatSection();
                            } else { msg.textContent = 'failed: ' + e; }
                        });
                });
            });
            // Program — SPEC / source / changelog, read-only.
            schedSection(card, s, 'prog', 'Program', function (body) {
                var tabs = document.createElement('div');
                tabs.className = 'pv-tabs';
                var pane = document.createElement('pre');
                pane.className = 'pv-pane';
                pane.textContent = 'loading…';
                var parts = [['spec', 'SPEC'], ['source', 'source'], ['changelog', 'changelog']];
                var cur = 'spec';
                function show(data) {
                    pane.textContent = (data && data[cur]) ? String(data[cur]) : '(empty)';
                    Array.prototype.forEach.call(tabs.children, function (b) {
                        b.classList.toggle('on', b.getAttribute('data-p') === cur);
                    });
                }
                parts.forEach(function (p) {
                    var b = document.createElement('button');
                    b.type = 'button'; b.className = 'vagent-fchip' + (p[0] === cur ? ' on' : '');
                    b.setAttribute('data-p', p[0]);
                    b.textContent = p[1];
                    b.addEventListener('click', function () { cur = p[0]; show(schedCache[s.id] && schedCache[s.id].program); });
                    tabs.appendChild(b);
                });
                body.appendChild(tabs); body.appendChild(pane);
                api('/api/schedules/' + s.id + '/program').then(function (d) {
                    if (!d || d.ok === false) { pane.textContent = (d && d.error) || 'API not available yet'; return; }
                    schedCache[s.id] = schedCache[s.id] || {};
                    schedCache[s.id].program = d;
                    show(d);
                }).catch(function (e) {
                    pane.textContent = /HTTP 404/.test(String(e)) ? 'API not available yet' : 'failed: ' + e;
                });
            }, {always: true});
            // Log — last runs.
            schedSection(card, s, 'log', 'Log', function (body) {
                var tbl = document.createElement('table');
                tbl.className = 'vagent-runs';
                var loading = document.createElement('div');
                loading.className = 'sx';
                loading.textContent = 'loading…';
                body.appendChild(loading);
                api('/api/schedules/' + s.id + '/log?n=20').then(function (d) {
                    loading.remove();
                    if (!d || d.ok === false) {
                        body.textContent = (d && d.error) || 'API not available yet';
                        return;
                    }
                    var runs = d.runs || [];
                    if (!runs.length) { body.textContent = 'no runs yet'; return; }
                    var hdr = tbl.insertRow();
                    ['time', 'exit', 'took', 'output'].forEach(function (h) {
                        var c = document.createElement('th'); c.textContent = h; hdr.appendChild(c);
                    });
                    runs.slice().reverse().forEach(function (r) {
                        var tr = tbl.insertRow();
                        tr.className = Number(r.exit) === 0 ? 'ok' : 'fail';
                        var c1 = tr.insertCell(); c1.textContent = clock(r.ts || 0);
                        c1.title = r.ts ? new Date(r.ts * 1000).toLocaleString('cs-CZ') : '';
                        var c2 = tr.insertCell(); c2.textContent = r.exit === undefined || r.exit === null ? '–' : String(r.exit);
                        var c3 = tr.insertCell(); c3.textContent = humanMs(r.duration_s);
                        var c4 = tr.insertCell();
                        var first = String(r.error || r.output || '').split('\n')[0];
                        c4.textContent = first;
                        c4.title = String(r.error ? 'error: ' + r.error + '\n' : '') + String(r.output || '');
                    });
                    body.appendChild(tbl);
                }).catch(function (e) {
                    loading.textContent = /HTTP 404/.test(String(e)) ? 'API not available yet' : 'failed: ' + e;
                });
            }, {always: true});
        }
        return card;
    }

    function renderSchedules(list, force) {
        if (!schedBox) { return; }
        list = list || [];
        var sig = JSON.stringify(list.map(schedFingerprint));
        if (!force && sig === schedFp) { return; }
        if (!force && uiInteracting(tasksBody)) {
            if (!deferredSched) {
                deferredSched = setInterval(function () {
                    if (uiInteracting(tasksBody)) { return; }
                    clearInterval(deferredSched); deferredSched = null;
                    renderSchedules(lastSchedules, true);
                }, 1500);
            }
            lastSchedules = list;
            return;
        }
        schedFp = sig;
        lastSchedules = list;
        var agents = list.filter(function (s) { return s.kind !== 'script'; });
        var scripts = list.filter(function (s) { return s.kind === 'script'; });
        var keep = {};
        var pane = tasksBody ? tasksBody.closest('.vagent-pane') : null;
        var scrollTop = pane ? pane.scrollTop : 0;

        function section(host, title, items, emptyText) {
            var h = document.createElement('div');
            h.className = 'vagent-sh';
            h.textContent = title;
            var c = document.createElement('span');
            c.className = 'vagent-cnt';
            c.textContent = String(items.length);
            h.appendChild(c);
            host.appendChild(h);
            if (!items.length) {
                var e = document.createElement('div');
                e.className = 'vagent-empty';
                e.textContent = emptyText;
                host.appendChild(e);
                return;
            }
            items.forEach(function (s) {
                var fp = schedFingerprint(s);
                var prev = schedCards[s.id];
                var node;
                if (prev && prev.fp === fp && prev.node) {
                    node = prev.node;                      // untouched DOM
                } else {
                    node = buildSchedCard(s);
                    schedCards[s.id] = {node: node, fp: fp};
                }
                keep[s.id] = true;
                host.appendChild(node);
            });
        }
        // Rebuild the container order; unchanged cards are moved, not rebuilt,
        // so their open sections and typed text survive.
        var frag = document.createDocumentFragment();
        section(frag, 'Agent tasks', agents,
            'No agent task yet. Create one with „+ new" or in chat: „založ si dlouhodobý úkol … každé 2 h".');
        section(frag, 'Script tasks', scripts,
            'No script task yet. Describe what the program should do („+ new" → Script task) and Hermes writes it; the core then runs it on the interval without a model.');
        Object.keys(schedCards).forEach(function (id) { if (!keep[id]) { delete schedCards[id]; } });
        schedBox.textContent = '';
        schedBox.appendChild(frag);
        if (pane) { pane.scrollTop = scrollTop; }
    }

    function pollSchedules() {
        if (!schedBox) { return Promise.resolve(); }
        return api('/api/schedules').then(function (d) {
            if (!d || d.ok === false) {
                schedApiOk = false;
                schedBox.textContent = '';
                var e = document.createElement('div');
                e.className = 'vagent-empty';
                e.textContent = 'Recurring tasks: ' + ((d && d.error) || 'API not available yet');
                schedBox.appendChild(e);
                return;
            }
            schedApiOk = true;
            renderSchedules(d.schedules || []);
        }).catch(function (err) {
            schedApiOk = false;
            if (!schedBox) { return; }
            schedBox.textContent = '';
            var e = document.createElement('div');
            e.className = 'vagent-empty';
            e.textContent = /HTTP 404/.test(String(err))
                ? 'Recurring tasks: API not available yet (core without /api/schedules). For now create them in chat: „založ si dlouhodobý úkol … každé 2 h".'
                : 'Recurring tasks: agent (:8088) not responding.';
            schedBox.appendChild(e);
        });
    }

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

    function renderSchedForm(host) {
        var form = document.createElement('div');
        form.className = 'vagent-schedform';
        var toggle = document.createElement('button');
        toggle.type = 'button'; toggle.className = 'ja';
        toggle.textContent = '+ new';
        form.appendChild(toggle);
        var body = document.createElement('div');
        body.className = 'sf';
        body.style.display = 'none';

        // Kind switch: agent task (text for Hermes) | script task (program)
        var kindRow = document.createElement('div');
        kindRow.className = 'vagent-kind';
        var kind = 'agent';
        var kb = {};
        [['agent', 'Agent task', 'Hermes gets the text on every run (minutes to hours)'],
         ['script', 'Script task', 'Hermes writes a program once; the core runs it on the interval (seconds to hours) without a model']]
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

        var rowI = document.createElement('div');
        rowI.className = 'si';
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
        body.appendChild(rowI);

        var modeRow = document.createElement('div');
        modeRow.className = 'si';
        var modeLbl = document.createElement('span');
        modeLbl.className = 'sx';
        modeLbl.textContent = 'report';
        modeRow.appendChild(modeLbl);
        var mode = 'on_change';
        [['quiet', 'quiet', 'log only'], ['on_change', 'on change', 'chat when the output changes'],
         ['always', 'always', 'chat on every run']].forEach(function (m) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'vagent-ivl' + (m[0] === mode ? ' on' : '');
            b.textContent = m[1];
            b.title = m[2];
            b.addEventListener('click', function () {
                Array.prototype.forEach.call(modeRow.querySelectorAll('.vagent-ivl'),
                    function (x) { x.classList.remove('on'); });
                b.classList.add('on');
                mode = m[0];
            });
            modeRow.appendChild(b);
        });
        body.appendChild(modeRow);

        function setKind(k) {
            kind = k;
            Object.keys(kb).forEach(function (x) { kb[x].classList.toggle('on', x === k); });
            ta.placeholder = k === 'script'
                ? 'What should the program do and how? (e.g. udělej snímek z lidaru, porovnej se základnou a vypiš, když je někdo okolo)'
                : 'What Hermes should do regularly… (e.g. zkontroluj teploty a nahlas výkyvy)';
            hint.textContent = k === 'script'
                ? 'Hermes writes the program from this description, then the core runs it on the interval — no model per run. You can change it later with Edit.'
                : 'Every run is a Hermes job with a report in chat.';
            modeRow.style.display = k === 'script' ? '' : 'none';
            fillIntervals();
        }
        setKind('agent');

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
            toggle.textContent = open ? '− close' : '+ new';
            if (open) { ta.focus(); }
        });

        ok.addEventListener('click', function () {
            var text = ta.value.trim();
            var every = chosen || parseInterval(custom.value, kind === 'script');
            if (!text) { msg.textContent = kind === 'script' ? 'describe what the program should do' : 'write what should be done'; return; }
            if (kind === 'script') {
                if (!every || every < 1) { msg.textContent = 'interval at least 1 s'; return; }
            } else if (!every || every < 60) { msg.textContent = 'interval at least 1 min'; return; }
            ok.disabled = true;
            msg.textContent = 'creating…';
            var payload = kind === 'script'
                ? {kind: 'script', description: text, every_s: every, report_mode: mode, author: author}
                : {text: text, every_s: every, author: author};
            api('/api/schedules', {body: payload})
                .then(function (d) {
                    ok.disabled = false;
                    if (!d || d.ok === false) {
                        msg.textContent = 'failed: ' + ((d && d.error) || '?');
                        return;
                    }
                    msg.textContent = '';
                    if (kind === 'script') {
                        var t = document.createTextNode('created #' + d.id + ' — Hermes is writing the program ');
                        msg.appendChild(t);
                        if (d.job_id) { msg.appendChild(refButton(d.job_id, '→ #' + d.job_id)); }
                        // Optimistic draft card until the next poll agrees.
                        var draft = {id: d.id, kind: 'script', title: text.slice(0, 60), text: text,
                                     every_s: every, enabled: false, state: 'draft',
                                     report_mode: mode, last_job_id: d.job_id || null};
                        renderSchedules(lastSchedules.concat([draft]), true);
                    } else {
                        msg.textContent = 'created #' + d.id;
                    }
                    ta.value = '';
                    pollSchedules();
                }).catch(function (e) {
                    ok.disabled = false;
                    if (/HTTP 404/.test(String(e))) {
                        // Old core: fall back to the chat phrasing the parser knows.
                        msg.textContent = 'API missing — sending to chat';
                        if (kind === 'script') {
                            submitText('napiš si program, který ' + text + ', a pouštěj ho každých ' + every + ' s');
                        } else {
                            submitText('/ukol každé ' + Math.round(every / 60) + 'min ' + text);
                        }
                        openChatSection();
                    } else {
                        msg.textContent = 'failed: ' + e;
                    }
                });
        });
        host.appendChild(form);
        return form;
    }

    var lastRunList = [];

    function renderTasksJobs(list, force) {
        if (!runBox) { return; }
        var sig = JSON.stringify((list || []).map(function (j) {
            return [j.id, j.state, j.stalled, j.legs, j.driver_note, j.parallel_slot,
                    j.subagents, j.worktree, j.schedule_id, j.last,
                    Math.floor((j.elapsed_s || 0) / 60)];
        }));
        lastRunList = list || [];
        if (!force && sig === runFp) { return; }
        if (!force && uiInteracting(runBox)) {
            if (!deferredRun) {
                deferredRun = setInterval(function () {
                    if (uiInteracting(runBox)) { return; }
                    clearInterval(deferredRun); deferredRun = null;
                    renderTasksJobs(lastRunList, true);
                }, 1500);
            }
            return;
        }
        runFp = sig;
        runBox.textContent = '';
        var stalled = 0, shown = 0;
        (list || []).forEach(function (job) {
            if (job.state !== 'running' && job.state !== 'queued' && job.state !== 'blocked') { return; }
            shown += 1;
            if (job.stalled) { stalled += 1; }
            var row = document.createElement('div');
            row.className = 'vagent-job compact ' + (job.state || '') + (job.stalled ? ' stalled' : '');
            row.setAttribute('data-job', job.id);
            var title = document.createElement('span');
            title.className = 'jt';
            title.textContent = '#' + job.id + ' ' + String(job.text || '').slice(0, 90);
            title.title = job.text || '';
            row.appendChild(title);
            var facts = document.createElement('div');
            facts.className = 'jf';
            function fact(txt, cls, tip) {
                var p = document.createElement('span');
                p.className = 'vagent-pill ' + (cls || '');
                p.textContent = txt;
                if (tip) { p.title = tip; }
                facts.appendChild(p);
            }
            fact(job.state === 'running' ? 'running' : job.state === 'blocked' ? 'waiting for you' : 'queued', job.state);
            if (job.stalled) { fact('stalled', 'stalled', job.driver_note || ''); }
            if (job.legs) { fact('legs ' + job.legs, '', 'number of legs'); }
            if (job.parallel_slot !== undefined && job.parallel_slot !== null) {
                fact('slot ' + job.parallel_slot, '', 'parallel slot');
            }
            if (job.subagents) { fact('subagents ' + job.subagents, '', 'running subagents'); }
            if (job.worktree) { fact('worktree', '', job.worktree); }
            if (job.schedule_id) { fact('task #' + job.schedule_id, '', 'started by a recurring task'); }
            if (job.elapsed_s) { fact(humanDuration(job.elapsed_s), ''); }
            row.appendChild(facts);
            if (job.driver_note) {
                var dn = document.createElement('div');
                dn.className = 'jl';
                dn.textContent = 'driver: ' + job.driver_note;
                dn.title = job.driver_note;
                row.appendChild(dn);
            } else if (job.last) {
                var ll = document.createElement('div');
                ll.className = 'jl';
                ll.textContent = job.last;
                ll.title = job.last;
                row.appendChild(ll);
            }
            var acts = document.createElement('div');
            acts.className = 'sa';
            if (job.state !== 'blocked') {
                var c = document.createElement('button');
                c.type = 'button'; c.className = 'ja';
                c.textContent = 'Cancel';
                c.addEventListener('click', function () {
                    inlineConfirm(c, function () { submitText('zruš práci ' + job.id); openChatSection(); });
                });
                acts.appendChild(c);
            }
            if (job.state === 'blocked' || job.stalled) {
                var g = document.createElement('button');
                g.type = 'button'; g.className = 'ja primary';
                g.textContent = 'Resume';
                g.addEventListener('click', function () {
                    submitText('pokračuj na ' + job.id); openChatSection();
                });
                acts.appendChild(g);
            }
            row.appendChild(acts);
            runBox.appendChild(row);
        });
        if (!shown) {
            var e = document.createElement('div');
            e.className = 'vagent-empty';
            e.textContent = 'Nothing is running right now.';
            runBox.appendChild(e);
        }
        tasksBadge.textContent = stalled ? String(stalled) : '';
        tasksBadge.title = stalled ? stalled + ' jobs without progress' : '';
        if (stalled) { flagTab('tasks'); }
    }

    function renderTasks(el) {
        tasksBody = el;
        var h1 = document.createElement('h4');
        h1.className = 'vagent-h';
        h1.textContent = 'Recurring';
        el.appendChild(h1);
        renderSchedForm(el);
        schedBox = document.createElement('div');
        schedBox.className = 'vagent-schedlist';
        el.appendChild(schedBox);
        var h2 = document.createElement('h4');
        h2.className = 'vagent-h';
        h2.textContent = 'Running';
        el.appendChild(h2);
        runBox = document.createElement('div');
        runBox.className = 'vagent-runlist';
        el.appendChild(runBox);
        renderTasksJobs(ctxJobs);
        pollSchedules();
    }

    // ======================================================= APPROVALS block
    var decidedAsks = {}, askOutcomes = {}, askSeen = {};
    var lastAsks = [];
    var gateBody = null;
    var gateBadge = document.createElement('span');
    gateBadge.className = 'vagent-cnt warn';

    function waitedText(seconds) {
        var s = Math.max(0, Math.round(seconds || 0));
        if (s < 60) { return 'waiting ' + s + ' s'; }
        if (s < 5400) { return 'waiting ' + Math.round(s / 60) + ' min'; }
        var h = Math.floor(s / 3600);
        var m = Math.round((s - h * 3600) / 60);
        return 'waiting ' + h + ' h' + (m ? ' ' + m + ' min' : '');
    }

    function decideAsk(item, allow, row) {
        Array.prototype.forEach.call(row.querySelectorAll('button'),
            function (b) { b.disabled = true; });
        api('/api/approvals/decide', {body: {id: item.id,
            decision: allow ? 'allow' : 'deny', by: author}})
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

    function askRow(item) {
        var row = document.createElement('div');
        row.className = 'vagent-ask';
        var top = document.createElement('div');
        top.className = 'ar';
        var cmd = document.createElement('span');
        cmd.className = 'ac';
        cmd.textContent = item.command || '';
        cmd.title = item.command || '';
        top.appendChild(cmd);
        var when = document.createElement('span');
        when.className = 'at';
        when.textContent = waitedText(item.waiting_s) +
            (item.left_text ? ' · ' + item.left_text + ' left' : '');
        top.appendChild(when);
        row.appendChild(top);
        var mid = document.createElement('div');
        mid.className = 'ar';
        var plain = document.createElement('span');
        plain.className = 'ap';
        plain.textContent = item.plain || item.reason || '';
        plain.title = plain.textContent;
        mid.appendChild(plain);
        row.appendChild(mid);
        var bottom = document.createElement('div');
        bottom.className = 'ar';
        var who = document.createElement('span');
        who.className = 'aw';
        who.textContent = 'asked by ' + (item.asker || 'Hermes') +
            (item.job_state === 'blocked' ? ' · job parked, waiting' : '');
        bottom.appendChild(who);
        var yes = document.createElement('button');
        yes.className = 'ay';
        yes.type = 'button';
        yes.textContent = 'Approve';
        yes.title = 'The command will run (same as /allow ' + item.id + ')';
        yes.addEventListener('click', function () { decideAsk(item, true, row); });
        bottom.appendChild(yes);
        var no = document.createElement('button');
        no.className = 'an';
        no.type = 'button';
        no.textContent = 'Deny';
        no.title = 'The command will not run (same as /deny ' + item.id + ')';
        no.addEventListener('click', function () { decideAsk(item, false, row); });
        bottom.appendChild(no);
        row.appendChild(bottom);
        return row;
    }

    function renderApprovals(list) {
        if (!gateBody) { return; }
        ctxAsks = list || [];
        paintCtx();
        lastAsks = list;
        var live = {};
        list.forEach(function (a) { live[a.id] = 1; });
        Object.keys(decidedAsks).forEach(function (id) {
            if (!live[id]) { delete decidedAsks[id]; }
        });
        gateBody.textContent = '';
        var shown = 0, fresh = false;
        list.forEach(function (item) {
            if (decidedAsks[item.id]) { return; }
            if (!askSeen[item.id]) { askSeen[item.id] = 1; fresh = true; }
            gateBody.appendChild(askRow(item));
            shown += 1;
        });
        var now = Date.now();
        Object.keys(askOutcomes).forEach(function (id) {
            if (askOutcomes[id].until < now) { delete askOutcomes[id]; return; }
            var row = document.createElement('div');
            row.className = 'vagent-ask ' + (askOutcomes[id].ok ? 'done' : 'bad');
            var line = document.createElement('div');
            line.className = 'am';
            line.textContent = (askOutcomes[id].ok ? '✓ ' : '✕ ') + askOutcomes[id].text;
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
        gateBadge.textContent = list.length ? String(list.length) : '';
        if (list.length) { flagTab('gate'); }   // a question outranks the fold
        if (fresh) { notify('approval', ''); }
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
                pollTasks(); pollJobs(); pollApprovals(); pollState(); pollHealth();
            }
            return;
        }
        every(2000, pollTasks);
        every(3000, function () { pollJobs(); pollApprovals(); });
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
            pollTasks(); pollJobs(); pollApprovals(); pollState(); pollHealth();
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
        registerBlock({id: 'jobs', title: 'Jobs', order: 20,
                       summaryExtra: jobsBadge,
                       render: function (el) { jobsBody = el; }});
        registerBlock({id: 'tasks', title: 'Tasks', order: 25,
                       summaryExtra: tasksBadge,
                       render: renderTasks,
                       poll: {every_ms: 10000, fn: function () {
                           if (tabBtns.tasks && tabBtns.tasks.classList.contains('active')) { pollSchedules(); }
                       }},
                       onOpen: function () { pollSchedules(); }});
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
