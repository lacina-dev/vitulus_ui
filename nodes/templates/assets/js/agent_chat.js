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

    /* E8/1: the panel talks to the agent through ONE same-origin door,
       `/agent/*`, proxied by webnode to 127.0.0.1:8088.  No CORS, no second
       port in the browser, and :8088 can be bound to loopback.  A webnode
       that predates the proxy has no /agent route — the health probe notices
       and falls back to the open port, so a half-updated robot still works. */
    /* 2026-08-31: the fallback to http://<host>:8088 is GONE, deliberately.
       The proxy is served by the very webnode that served this page, so if
       the page loaded, the door exists; and :8088 is being bound to loopback
       precisely so that nothing on the LAN can approve things in the owner's
       name.  Keeping a fallback would have meant the panel quietly using the
       hole we are closing.  An old webnode without the proxy therefore reads
       as "agent not running" — which is honest, and one restart away. */
    var AGENT_HTTP = '/agent';
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

    /* i18n (docs/I18N.md).  The panel's OWN words go through VTI18n; what
       the agent, the owner or a job wrote (messages, job texts, outputs,
       the commands sent to the agent) is data and is never translated.
       `_t`/`_tn` and not `t`: this file has dozens of locals called `t`.
       lt(el, key, vars, attr) is VTI18n.tag with {vars}: the key is kept on
       the element (data-vti-<attr>) and painted again on every language
       switch (relangEls), so text drawn once — a bubble's meta line, a form
       label — follows the switch without a redraw. */
    function _t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function _tn(k, n, v) { return window.VTI18n ? VTI18n.tn(k, n, v) : k; }
    var LT_ATTRS = ['text', 'title', 'placeholder', 'aria-label', 'data-label'];
    function ltPaint(el, attr) {
        var spec;
        try { spec = JSON.parse(el.getAttribute('data-vti-' + attr) || 'null'); } catch (e) { spec = null; }
        if (!spec) { return; }
        // a var may itself be a key: {k: <key>} — translated too
        var vars = spec[1];
        if (vars) {
            vars = Object.assign({}, vars);
            Object.keys(vars).forEach(function (n) {
                if (vars[n] && typeof vars[n] === 'object' && vars[n].k) { vars[n] = _t(vars[n].k); }
            });
        }
        var s = spec[2] != null ? _tn(spec[0], spec[2], vars) : _t(spec[0], vars);
        if (attr === 'text') { el.textContent = s; } else { el.setAttribute(attr, s); }
    }
    function lt(el, key, vars, attr) {
        if (!el) { return el; }
        attr = attr || 'text';
        el.setAttribute('data-vti-' + attr, JSON.stringify([key, vars || null]));
        ltPaint(el, attr);
        return el;
    }
    function ltn(el, key, n, vars, attr) {
        if (!el) { return el; }
        attr = attr || 'text';
        el.setAttribute('data-vti-' + attr, JSON.stringify([key, vars || null, n]));
        ltPaint(el, attr);
        return el;
    }
    /* a later plain assignment must not be overwritten by a stale key */
    function ltOff(el, attr) { if (el) { el.removeAttribute('data-vti-' + (attr || 'text')); } return el; }
    function relangEls(root) {
        root = root || document;
        LT_ATTRS.forEach(function (a) {
            Array.prototype.forEach.call(root.querySelectorAll('[data-vti-' + a + ']'),
                function (el) { ltPaint(el, a); });
        });
    }

    // ------------------------------------------------------------ helpers
    function clock(ts) {
        var d = new Date((ts || 0) * 1000);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    /* U21: this stopped at minutes, so a job running since yesterday was
       pinned at the top of Work as „1704 min 26 s" — and two lines below,
       its own card said „28.2 h".  Two spellings of one number, side by
       side, and the readable one was not the one in the owner's eye line.
       Above an hour it reads „28 h 24 min", above a day „1 d 4 h"; the
       seconds are dropped there because nobody reads the seconds of a
       28-hour job. */
    function humanDuration(seconds) {
        if (!seconds || seconds < 0.5) { return ''; }
        if (seconds < 60) { return Math.round(seconds) + ' s'; }
        if (seconds < 3600) {
            var m = Math.floor(seconds / 60);
            return m + ' min ' + Math.round(seconds - m * 60) + ' s';
        }
        if (seconds < 86400) {
            var h = Math.floor(seconds / 3600);
            return h + ' h ' + Math.round((seconds - h * 3600) / 60) + ' min';
        }
        var d = Math.floor(seconds / 86400);
        return d + ' d ' + Math.round((seconds - d * 86400) / 3600) + ' h';
    }

    var SNAP_RE = /\/api\/(?:snapshot|mapview|lidar)\/[0-9A-Za-z_.-]+\.(?:jpg|png)/;
    var SNAP_RE_ALL = new RegExp(SNAP_RE.source, 'g');

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
        lt(b, needConfirm ? 'chat.cmd.run_confirm' : 'chat.cmd.run', null, 'title');
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
        lt(b, 'chat.ref.show', {id: String(id).replace(/^[js]:/, '')}, 'title');
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
        lt(q, 'agent.confirm.really');
        var yes = document.createElement('button');
        yes.type = 'button'; yes.className = 'cy'; lt(yes, 'common.yes');
        var no = document.createElement('button');
        no.type = 'button'; no.className = 'cn'; lt(no, 'common.no');
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

    /* The agent panel is an AGENT feature. On a robot that does not run the
       vitulus_agent service (:8088) — e.g. a public vitulus_ui checkout — the
       panel must be quietly absent, not a broken box hammering a dead port.
       `agentUp` gates every poller: null = not yet probed, true/false = last
       /api/health result. A slow standalone probe flips it and re-applies the
       UI; nothing else touches :8088 until it reads true. */
    var agentUp = null;
    var probeInFlight = false;

    /* Issue vitulus-field#28: on a tester's robot the agent is not installed
       at all, the /agent route exists (webnode) but answers 503, and the
       panel kept asking /api/unified/jobs about once a second — the console
       drowned in 503s.  So: the first 503 or network failure of ANY /agent
       call marks the agent down (one console.warn, not one per request),
       every poller goes quiet behind the agentUp gate, and only the health
       probe keeps asking, with exponential backoff 5 s → 10 → 20 → 40 → 120 s.
       The first good answer resets the backoff and wakes the pollers, so a
       single transient 503 on the owner's robot costs at most ~5 s. */
    var PROBE_UP_MS = 30000, PROBE_MIN_MS = 5000, PROBE_MAX_MS = 120000;
    var probeDelay = PROBE_MIN_MS;
    var probeTimer = null;
    var downWarned = false;

    function nextProbe(ms) {
        if (probeTimer) { clearTimeout(probeTimer); }
        probeTimer = setTimeout(function () { probeTimer = null; probeAgent(); }, ms);
    }

    function markAgentDown(why) {
        if (agentUp === false) { return; }
        agentUp = false;
        if (!downWarned) {
            downWarned = true;
            try { console.warn('Vitulus agent is not available (' + why +
                               '); agent panel polling paused, retrying with backoff.'); } catch (e) {}
        }
        applyAgentState();
        probeDelay = PROBE_MIN_MS;
        nextProbe(probeDelay);
    }

    function healthOnce(base) {
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 4000) : null;
        return fetch(base + '/api/health', {cache: 'no-store',
                signal: ctl ? ctl.signal : undefined})
            .then(function (r) { if (timer) { clearTimeout(timer); } return r.ok; })
            .catch(function () { if (timer) { clearTimeout(timer); } return false; });
    }

    function probeAgent() {
        if (probeInFlight) { return; }
        probeInFlight = true;
        healthOnce(AGENT_HTTP)
            .then(function (up) {
                probeInFlight = false;
                var was = agentUp;
                if (!up) {
                    if (was !== false) { markAgentDown('health probe failed'); return; }
                    probeDelay = Math.min(probeDelay * 2, PROBE_MAX_MS);
                    nextProbe(probeDelay);          // still down: back off
                    return;
                }
                agentUp = true;
                downWarned = false;                 // warn again on a later outage
                probeDelay = PROBE_MIN_MS;
                nextProbe(PROBE_UP_MS);             // up: the old slow watch
                conn.okTs = Date.now();
                applyAgentState();
                if (agentUp && typeof schedule === 'function' &&
                        (was !== true || !timers.length)) {
                    schedule();     // seamlessly start pollers on down->up
                }
            });
    }

    /* Reflect availability without ever removing the button (no layout shift):
       up = normal; down/unknown = dimmed + honest tooltip, and an open panel
       shows one calm placeholder instead of empty broken blocks. */
    function applyAgentState() {
        var btn = document.getElementById('btn_agent');
        if (btn) {
            var down = agentUp === false;
            btn.classList.toggle('agent-down', down);
            lt(btn, down ? 'agent.btn.down' : 'agent.btn.tip', null, 'title');
        }
        renderAgentPlaceholder();
    }

    function renderAgentPlaceholder() {
        var blocks = panel.querySelector('#vagent_blocks');
        if (!blocks) { return; }
        var ph = panel.querySelector('#vagent_down');
        if (agentUp === false) {
            blocks.classList.add('vagent-hidden');
            if (!ph) {
                ph = document.createElement('div');
                ph.id = 'vagent_down';
                ph.className = 'vagent-down';
                var msg = document.createElement('p');
                lt(msg, 'agent.down.msg');
                ph.appendChild(msg);
                var retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'vagent-retry';
                lt(retry, 'agent.down.retry');
                retry.addEventListener('click', function () { probeAgent(); });
                ph.appendChild(retry);
                blocks.parentNode.insertBefore(ph, blocks);
            }
            ph.style.display = '';
        } else {
            blocks.classList.remove('vagent-hidden');
            if (ph) { ph.style.display = 'none'; }
        }
    }

    function api(path, opts) {
        opts = opts || {};
        // Single chokepoint: while the agent is known down, no caller (chat
        // pollers, agent_blocks refreshers, user actions) touches :8088 — no
        // network, no console error spam. A benign empty resolve (not a
        // reject) keeps the several no-.catch callers in agent_blocks quiet;
        // they just render empty. /api/health is the exception, and the probe
        // uses fetch directly, not api().
        if (agentUp === false && path !== '/api/health') {
            return Promise.resolve({ ok: false, agent_down: true });
        }
        // ?mock: no write ever reaches the agent (its STOP latch, chat
        // commands, approvals) - logged and counted by vt_mock.js
        var mockMethod = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
        if (window.VTMock && window.VTMock.blocks(mockMethod, AGENT_HTTP + path)) {
            return Promise.resolve({ ok: false, mock: true, error: 'blocked in ?mock' });
        }
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
            if (r.status === 503) {          // webnode: nothing behind /agent (#28)
                markAgentDown('HTTP 503 from /agent');
                var e503 = new Error('HTTP 503');
                e503.status = 503;
                throw e503;
            }
            conn.okTs = Date.now();
            paintConn();
            if (!r.ok) {
                // Some endpoints put the ONLY useful text in the body of a
                // refusal — /api/models answers 400 with ready-made sentences
                // in `problems`. Throwing on the status code alone would drop
                // exactly the part the reader needs, so callers that know how
                // to show it ask for the body to survive the throw.
                if (opts.keep_error_body) {
                    return r.json().catch(function () { return null; })
                        .then(function (body) {
                            var err = new Error('HTTP ' + r.status);
                            err.status = r.status;
                            err.body = body;
                            throw err;
                        });
                }
                throw new Error('HTTP ' + r.status);
            }
            return r.json().then(function (body) {
                /* U40: the core answers with LENGTHS („this is 131 s old"),
                   never with the moment of capture.  A length is only worth
                   anything next to the instant it was measured at, and that
                   instant is NOW — the moment the answer arrived here.  Every
                   answer therefore carries `__at` (ms, this browser's clock),
                   so a caller can turn a length into a moment
                   (`captured = __at/1000 - age_s`) and let it age honestly.
                   Without it the panel re-derived „taken 0 s ago" from a
                   two-minute-old picture on every redraw. */
                if (body && typeof body === 'object') {
                    try {
                        Object.defineProperty(body, '__at',
                            {value: Date.now(), enumerable: false,
                             writable: true, configurable: true});
                    } catch (e) { body.__at = Date.now(); }
                }
                return body;
            });
        }).catch(function (err) {
            if (timer) { clearTimeout(timer); }
            // network-level failure (not our own timeout abort) = no agent
            if (err && err.name === 'TypeError') { markAgentDown('network error'); }
            conn.failTs = Date.now();
            paintConn();
            throw err;
        });
    }

    /* ============================================================ numbers
       „Součet a stáří jsou dvě místa, kde panel přestává citovat a začíná
       tvrdit — a obě dnes v noci lhaly."  (tester, round 3)

       U35 was a sum the panel made without knowing one card was a duplicate.
       U40 was an age the panel computed from a length it had been handed
       finished.  Both were the panel ASSERTING where it should have been
       QUOTING, and neither was catchable by looking at the screen.

       So: every number that says something about the world is drawn by
       num(), and num() writes down WHERE IT CAME FROM, into the DOM, next to
       the number.  Then the panel can be asked to check itself.

       `src` is a pointer the audit can follow:
         "/api/doctor#counts.open"                — a field of an answer
         "sum:/api/models#roles[*].usd_7d"        — a sum over an array
         "/api/models#roles[role=chat].calls_7d"  — a row picked by a key
         "derived: … "                            — the panel worked it out;
                                                    not machine-checkable, but
                                                    it has to SAY so
       A null value is never a zero: it prints as unreadable, which is the one
       thing the Findings tab already got right and everything else did not. */

    function num(value, src, opts) {
        opts = opts || {};
        var s = document.createElement('span');
        if (src) { s.setAttribute('data-src', String(src)); }
        var bad = (value === null || value === undefined || value === '' ||
                   (typeof value === 'number' && isNaN(value)));
        if (bad) {
            s.className = 'vagent-unknown' + (opts.cls ? ' ' + opts.cls : '');
            if (opts.unknown) { s.textContent = opts.unknown; }
            else { lt(s, 'agent.num.unreadable'); }
            return s;
        }
        if (opts.cls) { s.className = opts.cls; }
        s.setAttribute('data-num', String(value));
        s.textContent = (opts.format ? opts.format(value) : String(value)) +
                        (opts.unit ? opts.unit : '');
        if (opts.title) { s.title = opts.title; }
        return s;
    }

    /* obj + "a.b[2].c" | "roles[role=chat].usd_7d" | "roles[*].usd_7d" */
    function digPath(obj, path) {
        var cur = obj, miss = {__missing: true};
        var parts = String(path || '').split('.');
        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            var m = /^([^\[]*)((\[[^\]]*\])*)$/.exec(seg);
            if (!m) { return miss; }
            if (m[1]) {
                if (cur == null || typeof cur !== 'object') { return miss; }
                if (Array.isArray(cur)) {
                    // fan out a field over a list
                    cur = cur.map(function (x) { return x == null ? null : x[m[1]]; });
                } else {
                    if (!(m[1] in cur)) { return miss; }
                    cur = cur[m[1]];
                }
            }
            var idx = (m[2] || '').match(/\[[^\]]*\]/g) || [];
            for (var k = 0; k < idx.length; k++) {
                var inner = idx[k].slice(1, -1);
                if (!Array.isArray(cur)) { return miss; }
                if (inner === '*') { continue; }            // stay a list
                var kv = /^([A-Za-z_][\w]*)=(.*)$/.exec(inner);
                if (kv) {
                    var hit = null;
                    for (var j = 0; j < cur.length; j++) {
                        if (cur[j] && String(cur[j][kv[1]]) === kv[2]) { hit = cur[j]; break; }
                    }
                    if (hit === null) { return miss; }
                    cur = hit;
                } else {
                    cur = cur[Number(inner)];
                    if (cur === undefined) { return miss; }
                }
            }
        }
        return cur;
    }

    /* VAgent.auditNumbers() — run it from the console, or from the Robot tab.
       It re-asks the core for every endpoint the panel is quoting and says
       which drawn numbers no longer match.  This is the hour the tester spent
       by hand in round 3, done in ten seconds and repeatable by the owner. */
    function auditNumbers(opts) {
        opts = opts || {};
        var nodes = document.querySelectorAll('[data-src]');
        var byEp = {}, items = [], derived = [];
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var src = n.getAttribute('data-src') || '';
            var shown = n.getAttribute('data-num');
            if (/^derived:/i.test(src)) {
                derived.push({src: src, shown: n.textContent, node: n});
                continue;
            }
            var agg = null, rest = src;
            var am = /^(sum|count|max|min):(.*)$/.exec(src);
            if (am) { agg = am[1]; rest = am[2]; }
            var hash = rest.indexOf('#');
            if (hash < 0) { derived.push({src: src, shown: n.textContent, node: n}); continue; }
            var ep = rest.slice(0, hash), path = rest.slice(hash + 1);
            byEp[ep] = true;
            items.push({node: n, ep: ep, path: path, agg: agg, src: src,
                        shown: shown, text: n.textContent});
        }
        var eps = Object.keys(byEp);
        return Promise.all(eps.map(function (ep) {
            return api(ep).then(function (d) { return {ep: ep, d: d}; })
                          .catch(function (e) { return {ep: ep, err: String(e)}; });
        })).then(function (answers) {
            var live = {};
            answers.forEach(function (a) { live[a.ep] = a; });
            var rows = [], bad = [], unreadable = [];
            items.forEach(function (it) {
                var a = live[it.ep];
                if (!a || a.err) {
                    unreadable.push({src: it.src, shown: it.text, why: (a && a.err) || 'no answer'});
                    return;
                }
                var v = digPath(a.d, it.path);
                if (v && v.__missing) {
                    unreadable.push({src: it.src, shown: it.text, why: 'field not in the answer'});
                    return;
                }
                if (it.agg && Array.isArray(v)) {
                    var nums = v.filter(function (x) { return x != null && !isNaN(Number(x)); })
                                .map(Number);
                    v = it.agg === 'count' ? v.length
                      : it.agg === 'max' ? Math.max.apply(null, nums)
                      : it.agg === 'min' ? Math.min.apply(null, nums)
                      : nums.reduce(function (s2, x) { return s2 + x; }, 0);
                }
                var drawn = it.shown === null || it.shown === '' ? null : Number(it.shown);
                var real = (v === null || v === undefined) ? null : Number(v);
                var same = (drawn === null && real === null) ||
                    (drawn !== null && real !== null && !isNaN(drawn) && !isNaN(real) &&
                     Math.abs(drawn - real) <= (opts.tol || 1e-6) * Math.max(1, Math.abs(real)));
                var rec = {src: it.src, shown: it.text, drawn: drawn, core: real, ok: same};
                rows.push(rec);
                if (!same) { bad.push(rec); }
            });
            var report = {checked: rows.length, mismatches: bad,
                          unreadable: unreadable, derived: derived, rows: rows};
            try {
                if (console.table) { console.table(rows); }
                console.log('[VAgent.auditNumbers] ' + rows.length + ' checked, ' +
                            bad.length + ' MISMATCH, ' + unreadable.length +
                            ' unreadable, ' + derived.length + ' derived (declared, not checkable)');
                if (bad.length) {
                    console.log('[VAgent.auditNumbers] a mismatch means the panel ' +
                        'and the core disagree RIGHT NOW. That is either a wrong ' +
                        'number or a stale one — read it together with the age ' +
                        'the panel shows next to it.');
                }
                if (bad.length && console.table) { console.table(bad); }
                if (derived.length && console.table) {
                    console.table(derived.map(function (d2) {
                        return {src: d2.src, shown: d2.shown};
                    }));
                }
            } catch (e) {}
            return report;
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
                ? (since < 8 ? '' : _t('common.ago.s', {n: Math.round(since)}))
                : _t('agent.conn.none');
            age.title = _t('agent.conn.tip');
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
    /* 2026-08-30 (E8/4): six tabs down to four — Chat · Work · Findings ·
       Robot.  Approvals stop being a tab: a tab you have to remember to open
       is not a notification, so they are pinned cards at the TOP of Work
       (block order 10 puts them above the job list) and the shell strip
       shouts about them without the panel being open at all.  "More" is gone
       too — its cards moved to the tab they belong to. */
    /* 2026-08-31: a fifth tab, on the owner's explicit ask — „chtel bych
       v agentovi tab kde tohle pujde nastavit. Na jake veci bude pouzivan
       jaky model jakeho providera."  It is the one screen that is neither
       chat, work, a finding nor the robot: it is how the agent is wired. */
    /* U2 I2: Activity = one timeline of the agent's jobs and the field kit's
       events (vt_activity.js registers the block). */
    /* display names: app.agent.tab.<id> (the same words Settings › App
       offers for „Agent opens on"); the ids themselves never change */
    var TAB_LABEL = {chat: 'app.agent.tab.chat', work: 'app.agent.tab.work',
                     activity: 'app.agent.tab.activity',
                     findings: 'app.agent.tab.findings', robot: 'app.agent.tab.robot',
                     models: 'app.agent.tab.models'};
    var TAB_ORDER = ['chat', 'work', 'activity', 'findings', 'robot', 'models'];
    // block id -> tab.  The tab's PRIMARY block renders plain, the rest as
    // collapsible cards; `gate` is pinned (plain) although it is not primary.
    var TAB_OF = {chat: 'chat', jobs: 'work', gate: 'work', mise: 'work',
                  incidents: 'findings', zdravi: 'findings',
                  robot: 'robot', nastroje: 'robot', dock: 'robot',
                  tools: 'robot',
                  models: 'models', activity: 'activity'};
    var TAB_PRIMARY = {chat: 'chat', work: 'jobs', findings: 'incidents',
                       robot: 'robot', models: 'models', activity: 'activity'};
    var TAB_PINNED = {gate: 1, dock: 1};
    // old tab ids still used by callers (and by localStorage) -> new ones
    var TAB_ALIAS = {jobs: 'work', gate: 'work', incidents: 'findings',
                     vice: 'robot'};
    var LS_TAB = 'vitulus_agent_tab';
    var panes = {}, tabBtns = {};

    function relangTabs() {
        Object.keys(tabBtns).forEach(function (id) {
            var n = tabBtns[id].firstChild;
            if (n && n.nodeType === 3) { n.nodeValue = _t(TAB_LABEL[id]); }
        });
    }

    function tabFor(blockId) {
        return TAB_OF[blockId] || (TAB_LABEL[blockId] ? blockId : 'work');
    }

    function ensureTab(tabId) {
        var tabs = panel.querySelector('#vagent_tabs');
        var body = panel.querySelector('#vagent_blocks');
        if (!panes[tabId]) {
            var pane = document.createElement('div');
            pane.className = 'vagent-pane';
            pane.setAttribute('data-pane', tabId);
            lt(pane, TAB_LABEL[tabId], null, 'data-label');
            body.appendChild(pane);
            panes[tabId] = pane;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'vagent-tab';
            btn.setAttribute('data-tab', tabId);
            // the words are the button's FIRST TEXT NODE, not its whole
            // text: the primary block's badge is appended to this button
            // (a span — and every span in a tab is styled as a badge), so
            // a language switch rewrites only this node (relangTabs)
            btn.appendChild(document.createTextNode(_t(TAB_LABEL[tabId])));
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

    /* `restore` = "this is the panel putting itself back where the owner
       left it", not a choice anybody made.  U26: mountBlocks() runs again
       on EVERY block registration, so this ran while half the panes did not
       exist yet; the blind fallback below then landed on some other tab AND
       WROTE IT BACK, destroying the remembered choice before the pane that
       would have satisfied it was even created.  The owner's tab was not
       forgotten, it was overwritten.  So: a fallback is never remembered,
       and a restore never writes at all — only a tab somebody actually
       asked for does. */
    function activateTab(tabId, restore) {
        // callers still say 'jobs' / 'gate' / 'incidents' — and so does a
        // localStorage value written before the tabs were merged
        if (!panes[tabId] && TAB_ALIAS[tabId]) { tabId = TAB_ALIAS[tabId]; }
        if (!panes[tabId] && TAB_OF[tabId]) { tabId = TAB_OF[tabId]; }
        var fellBack = false;
        if (!panes[tabId]) { tabId = 'chat'; fellBack = true; }
        if (!panes[tabId]) { return; }
        Object.keys(panes).forEach(function (id) {
            panes[id].classList.toggle('active', id === tabId);
            tabBtns[id].classList.toggle('active', id === tabId);
        });
        tabBtns[tabId].classList.remove('attention');
        if (!restore && !fellBack) { lsSet(LS_TAB, tabId); }
        blocks.forEach(function (blk) {
            if (tabFor(blk.id) === tabId && blk.onOpen && blk.body) {
                try { blk.onOpen(blk.body); } catch (e) {}
            }
        });
        if (tabId === 'chat') {
            scrollChatBottom();
            /* U41: the chat input only HAS a width once its pane is on
               screen.  Becoming visible is not a resize, so nothing used to
               tell the placeholder to look again — and a panel restored on
               another tab kept the desktop sentence on a phone for ever. */
            if (syncPlaceholder) {
                syncPlaceholder();
                if (window.requestAnimationFrame) {
                    requestAnimationFrame(syncPlaceholder);
                }
            }
        }
    }

    /* The chat opens LOOKING AT THE LAST MESSAGE, always: initial history
       load, tab switch, panel open, tab un-hiding.  Deferred twice so layout
       (and late images) have happened before the scroll is measured. */
    function scrollChatBottom() {
        stickBottom = true;
        // the deferred drops respect a scroll the user made in between
        function drop() { if (msgsEl && stickBottom) { msgsEl.scrollTop = msgsEl.scrollHeight; } }
        if (msgsEl) { msgsEl.scrollTop = msgsEl.scrollHeight; }
        if (window.requestAnimationFrame) {
            requestAnimationFrame(function () { requestAnimationFrame(drop); });
        } else { setTimeout(drop, 50); }
    }

    /* C1 (owner: „odjíždí text v chatu"): a LAYOUT change — the phone
       keyboard (visualViewport resize/scroll, which iOS fires while the
       owner scrolls the messages with the keyboard up), the sheet / drawer
       resizing, .full, coming back to the tab, focusing the input — used to
       call scrollChatBottom() and yank the chat to the end no matter where
       the owner was reading.  Layout changes only KEEP the bottom: the chat
       follows the end only if it was already there (sticky bottom).  The
       state is remembered from the owner's own scrolling, not re-measured
       after the change — a viewport that just shrank under the keyboard is
       „not at the bottom" by measurement, yet it was a moment ago. */
    var stickBottom = true;
    function keepBottom() {
        if (stickBottom) { scrollChatBottom(); }
    }

    function flagTab(blockId) {
        var btn = tabBtns[tabFor(blockId)];
        if (btn && !btn.classList.contains('active')) { btn.classList.add('attention'); }
    }

    /* Is the tab that HOSTS this block the one on screen?
       A block knows its own id; which tab it lives in is the shell's
       business and has already changed once (six tabs merged into five).
       Every caller that resolved a tab by its DOM NAME went silently false
       the day that happened, and stayed false:
         · `.vagent-tab[data-tab="incidents"]` -> null  (U19: the Findings
           badge never cleared, because "am I looking at it" was never true)
         · `tabBtns.jobs` -> undefined          (U20: the Work list's 8 s
           poll never fired once — 45 s open, 0 requests)
         · the CSS scroller list (`vice`/`jobs`/`gate`/`incidents`)  — the
           owner's own „models nejde scrolovat".
       Three sites, one mistake, none of them noisy.  So: nobody outside
       this file names a tab any more.  Ask here, and tabFor() answers. */
    /* A width of 0 is what a hidden element reports, and it is not a width.
       Every place in this file that decides something FROM a size asks this,
       so that „not measured" can never again be mistaken for „small" (U41)
       or for „large" (which is what it was mistaken for). */
    function measuredWidth(node) {
        var w = node && node.clientWidth;
        return (w && w > 0) ? w : null;
    }

    function blockTabActive(blockId) {
        var btn = tabBtns[tabFor(blockId)];
        return !!(btn && btn.classList.contains('active'));
    }

    function mountBlocks() {
        var body = panel.querySelector('#vagent_blocks');
        if (!body) { return; }
        blocks.forEach(function (blk) {
            if (blk.el) { return; }
            var tabId = tabFor(blk.id);
            var pane = ensureTab(tabId);
            var host, inner;
            var asCard = !(TAB_PRIMARY[tabId] === blk.id || TAB_PINNED[blk.id]);
            if (asCard) {
                // secondary block: collapsible card with memory, count badge
                // in the heading.
                host = document.createElement('details');
                host.className = 'vagent-card';
                host.open = true;
                var h = document.createElement('summary');
                var ht = document.createElement('span');
                ht.className = 'ct';
                // `titleKey` (an i18n key) follows the language switch;
                // a plain `title` is shown as given
                if (blk.titleKey) { lt(ht, blk.titleKey); }
                else { ht.textContent = blk.title || blk.id; }
                h.appendChild(ht);
                if (blk.summaryExtra) { h.appendChild(blk.summaryExtra); }
                host.appendChild(h);
                inner = document.createElement('div');
                inner.className = 'vagent-sec-body';
                host.appendChild(inner);
                wireDetails(host, 'agent_more_' + blk.id);
            } else if (TAB_PINNED[blk.id]) {
                // pinned at the top of its tab, with a heading of its own —
                // it is a guest in someone else's pane, so it has to say
                // what it is.  Hidden altogether while it has nothing.
                host = document.createElement('div');
                host.className = 'vagent-sec-body vagent-pinned';
                var ph = document.createElement('div');
                ph.className = 'vagent-pinhead';
                var pt = document.createElement('span');
                pt.className = 'ct';
                if (blk.titleKey) { lt(pt, blk.titleKey); }
                else { pt.textContent = blk.title || blk.id; }
                ph.appendChild(pt);
                if (blk.summaryExtra) { ph.appendChild(blk.summaryExtra); }
                host.appendChild(ph);
                inner = document.createElement('div');
                host.appendChild(inner);
            } else {
                host = document.createElement('div');
                host.className = 'vagent-sec-body vagent-pane-body';
                inner = host;
                if (blk.summaryExtra) { tabBtns[tabId].appendChild(blk.summaryExtra); }
            }
            pane.appendChild(host);
            blk.el = host;
            blk.body = inner;
            try { blk.render(inner); } catch (e) { lt(inner, 'agent.block.failed', {err: String(e)}); }
        });
        activateTab(lsGet(LS_TAB) || 'chat', true);   // restore, never write
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
    // the English titles above are the first paint; these follow the language
    lt(panel.querySelector('#vagent_density'), 'agent.density.tip', null, 'title');
    lt(panel.querySelector('#vagent_clear'), 'agent.clear.tip', null, 'title');
    lt(panel.querySelector('#vagent_stop'), 'agent.stop.tip', null, 'title');
    var panelActive = false;
    var syncPlaceholder = null;   // U32, set when the chat block is built

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
        // U1: the shared anatomy has a meta slot (status) and an actions slot
        var metaSlot = document.getElementById('ui_drawer_meta');
        if (metaSlot) { metaSlot.appendChild(left); }
        else { title.insertAdjacentElement('afterend', left); }
        var right = document.createElement('span');
        right.id = 'vagent_head_right';
        right.appendChild(panel.querySelector('#vagent_density'));
        right.appendChild(panel.querySelector('#vagent_clear'));
        right.appendChild(panel.querySelector('#vagent_stop'));
        var actSlot = document.getElementById('ui_drawer_actions');
        var full = document.getElementById('btn_ui_drawer_full');
        if (actSlot) { actSlot.appendChild(right); }
        else if (full && full.parentNode === head) { head.insertBefore(right, full); }
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
                if (b > 0) {
                    d.drawer.style.top = Math.round(b + 2) + 'px';
                    document.documentElement.style.setProperty('--vt-drawer-top', Math.round(b + 2) + 'px');
                }
            }
        } catch (e) {}
        d.drawer.classList.add('open');
        settleDrawer(d.drawer);
        // U32: the input has no width while the panel is hidden, so the
        // placeholder cannot be chosen before it is on screen.
        if (syncPlaceholder) { syncPlaceholder(); }
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
        renderAgentPlaceholder();   // show the "agent not running" note if down
        if (agentUp !== true) { probeAgent(); }   // re-check on open
        schedule();   // pollers wake up (no-op while the agent is down)
        var input = document.getElementById('vagent_input');
        if (input && agentUp === true && window.innerWidth >= 576) { input.focus(); }
        mergeHead();
        scrollChatBottom();
        document.dispatchEvent(new Event('vagent:activechange'));
    }

    function deactivate(slideOut) {
        if (!panelActive) { return; }
        unmergeHead();
        panelActive = false;
        var dd = document.getElementById('ui_drawer');
        if (dd) { dd.style.height = ''; dd.style.bottom = ''; }   // keyboard clamp is ours alone
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
                d.drawer.style.bottom = '';
                return;
            }
            /* U1: on a phone the drawer is a bottom sheet (vt_panel.css).
               Keyboard closed -> leave it to the CSS (sheet / full screen).
               Keyboard open (iOS keeps the layout viewport, so the sheet
               would sit under it) -> lift the sheet onto the keyboard and
               let it fill the visible area up to the menu row. */
            var visBottom = (vv.offsetTop || 0) + vv.height;
            var kb = window.innerHeight - visBottom;
            if (kb < 60) {
                d.drawer.style.height = '';
                d.drawer.style.bottom = '';
            } else {
                var top = parseFloat(getComputedStyle(document.documentElement)
                    .getPropertyValue('--vt-drawer-top')) || parseFloat(d.drawer.style.top || '0') || 0;
                d.drawer.style.bottom = Math.round(kb) + 'px';
                d.drawer.style.height = Math.round(Math.max(200, visBottom - top)) + 'px';
            }
            keepBottom();
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
            keepBottom();   // .full toggle re-lays the chat out
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
        lt(btn, 'agent.btn.tip', null, 'title');
        btn.classList.add('vagent-btn');   // position: relative (badge anchor), vt_panel.css
        var ico = document.createElement('i');
        ico.className = 'la la-android';
        btn.appendChild(ico);
        var badge = document.createElement('span');
        badge.id = 'vagent_badge';
        badge.style.display = 'none';
        btn.appendChild(badge);
        btn.addEventListener('click', togglePanel);
        group.appendChild(btn);
    }

    // ============================================================ CHAT block
    var seen = {};                    // task ids whose QUESTION half is rendered
    var answered = {};                // task ids whose ANSWER half is rendered
    var openIds = {};                 // rendered but still unanswered (watch_ids)
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

    var V2_KIND = {work: 'work', action: 'work', recur: 'work',
                  finding: 'report', tick: 'report', ask: 'report'};

    function taskKind(task) {
        if (task.source === 'agent') {
            // v2 says what a row IS (ask|work|action|finding|recur|tick);
            // until it does, the v1 heuristic below stands.
            var k2 = task.meta && typeof task.meta.kind === 'string'
                ? V2_KIND[task.meta.kind] : null;
            if (k2) { return k2; }
            var ev = (task.meta && task.meta.event) || '';
            if (ev || /hlášení z práce|z mise/.test(task.text || '')) { return 'work'; }
            return 'report';          // senses / selfcare / growth
        }
        return task.author === author ? 'me' : 'user';
    }

    /* U33, second half: the doctor's 24 h summary arrives as its own task,
       and NINE byte-identical copies of it were stacked in the chat (four
       pairs shared a second).  The Findings tab has collapsed repeats since
       forever — „×828" instead of eight hundred cards — and the chat, fed
       from the same place, had none of it.  Same idea, same badge: an
       identical bubble arriving straight after its twin becomes a count on
       the twin.  Only the robot's own lines, never the owner's, and never
       across a gap: two identical answers ten minutes apart are two events
       and stay two bubbles. */
    var MINE_KINDS = {me: 1, user: 1};
    function repeatKey(kind, cls, text) {
        // everything the ROBOT says can repeat itself — a reply (`bot`), a
        // report from the doctor (`report`) or a note from a job (`work`).
        // The owner's own lines never collapse: if he typed it twice he
        // meant it twice.
        if (MINE_KINDS[kind]) { return null; }
        var t = String(text == null ? '' : text);
        if (t.length < 24) { return null; }     // "ok" twice is not a repeat
        return kind + ' ' + cls + ' ' + t;
    }
    function bumpRepeat(node, taskId) {
        var n = (parseInt(node.getAttribute('data-repeat') || '1', 10) || 1) + 1;
        node.setAttribute('data-repeat', String(n));
        if (taskId) {
            var m = node.getAttribute('data-merged');
            node.setAttribute('data-merged', (m ? m + ',' : '') + taskId);
            /* `data-task` on a collapsed group is the OLDEST id in it, so
               oldestTaskId (read off the first node) still names a row that
               really is the oldest one on screen.  Get that wrong and
               loadOlder() asks for a page it already has — and if a whole
               page collapsed into one bubble, forever. */
            var cur = parseInt(node.getAttribute('data-task') || '0', 10) || 0;
            var nid = parseInt(taskId, 10) || 0;
            if (nid && (!cur || nid < cur)) { node.setAttribute('data-task', String(nid)); }
        }
        var host = node.querySelector('.vagent-meta');
        if (!host) {
            host = document.createElement('div');
            host.className = 'vagent-meta';
            node.appendChild(host);
        }
        var b = node.querySelector('.vagent-repeat');
        if (!b) {
            b = document.createElement('span');
            b.className = 'vagent-repeat';
            host.insertBefore(b, host.firstChild);
        }
        b.textContent = '×' + n;
        ltn(b, 'chat.repeat.tip', n, null, 'title');
    }

    function turn(kind, cls, text, meta, taskId) {
        var stick = stickBottom || atBottom();
        var prepend = !!(insertRef && insertRef.parentNode === msgsEl);
        // The neighbour on the side this bubble is going in: the last row
        // when appending, the row it would sit in front of when a scroll-up
        // page is prepended.  Both directions merge; bumpRepeat() keeps
        // data-task pointing at the oldest id of the group so the back-scroll
        // cursor stays honest.
        var rkey = repeatKey(kind, cls, text);
        if (rkey && msgsEl) {
            // NOT `insertRef` itself: loadOlder() sets it once and inserts
            // the whole page in order in front of it, so the row this one
            // follows is the one inserted just before — the node sitting
            // immediately above insertRef right now.
            // At the top of a freshly prepended page there is nothing above
            // insertRef yet, and then the row this one is adjacent to is
            // insertRef itself — otherwise a repeat that straddles a page
            // boundary would be the one pair that stayed doubled.
            var nb = prepend
                ? (insertRef.previousElementSibling || insertRef)
                : msgsEl.lastElementChild;
            if (nb && nb.classList && nb.classList.contains('vagent-turn') &&
                    nb.getAttribute('data-dedup') === rkey) {
                bumpRepeat(nb, taskId);
                if (!prepend && stick) { msgsEl.scrollTop = msgsEl.scrollHeight; }
                return nb;
            }
        }
        var wrap = document.createElement('div');
        if (rkey) { wrap.setAttribute('data-dedup', rkey); }
        wrap.className = 'vagent-turn ' + cls;
        wrap.setAttribute('data-kind', kind);
        if (taskId) { wrap.setAttribute('data-task', taskId); }

        var body = document.createElement('div');
        body.className = 'vagent-msg';
        if (cls === 'vagent-me' || cls === 'vagent-user') { body.textContent = text; }
        else { renderMarkdown(body, text); }
        wrap.appendChild(body);

        /* All images in the message, not just the first: a lidar event
           carries the scan AND the photo (and depth at night). */
        var seen = {};
        (String(text || '').match(SNAP_RE_ALL) || []).forEach(function (u) {
            if (!seen[u]) { seen[u] = 1; attachImage(body, u); }
        });

        if (meta && meta.length) {
            var line = document.createElement('div');
            line.className = 'vagent-meta';
            meta.forEach(function (part) {
                if (!part || !(part.text || part.key)) { return; }
                var s = document.createElement('span');
                if (part.cls) { s.className = part.cls; }
                if (part.key) { lt(s, part.key, part.vars); } else { s.textContent = part.text; }
                line.appendChild(s);
            });
            wrap.appendChild(line);
        }
        if (insertRef && insertRef.parentNode === msgsEl) {
            msgsEl.insertBefore(wrap, insertRef);   // history prepend
        } else {
            msgsEl.appendChild(wrap);
            if (stick) { followNew(wrap, cls === 'vagent-me'); }
        }
        return wrap;
    }

    /* C1: the chat was at the end and a new bubble arrived.  A short one —
       stay on the end.  One taller than the view (a long answer) — show its
       START: dropping to its last line made the text „run away" from the
       owner before he could read it.  Then the chat is no longer at the end,
       so nothing below (late images, the next poll) pulls it anywhere.
       A view squeezed to a sliver (keyboard + sheet) is no measure of
       „long" — there every bubble would count, so it just follows the end. */
    function followNew(wrap, mine) {
        var view = msgsEl.clientHeight;
        if (!mine && view >= 120 && wrap.offsetHeight > view - 24) {
            var top = wrap.getBoundingClientRect().top -
                msgsEl.getBoundingClientRect().top + msgsEl.scrollTop - 6;
            msgsEl.scrollTop = Math.max(0, top);
            stickBottom = atBottom();
            return;
        }
        msgsEl.scrollTop = msgsEl.scrollHeight;
        stickBottom = true;
    }

    function attachImage(target, url) {
        var img = document.createElement('img');
        img.className = 'snap';
        img.loading = 'lazy';
        img.addEventListener('load', function () {
            // measured AFTER the image grew the chat, atBottom() is false
            // even when the owner was on the end — use the remembered state
            if (stickBottom) { msgsEl.scrollTop = msgsEl.scrollHeight; }
        });
        img.src = AGENT_HTTP + url;
        img.addEventListener('click', function () {
            window.open(img.src, '_blank', 'noopener');
        });
        target.appendChild(img);
    }

    /* The waiting bubble used to INVENT what the core was doing: at 10 s it
       claimed „using tools", at 25 s „thinking longer, probably verifying
       something".  It knew none of that — it was reading a clock (E8/6).
       Now it says only what it can stand behind: how long it has waited, and
       the task's own state once the feed reports one (queued / working).
       When the core serves /api/jobs/<id>/trace this is where the real trace
       goes; until then, nothing beats a made-up story. */
    function waiting() {
        var d = document.createElement('div');
        d.className = 'vagent-wait';
        var dots = document.createElement('span');
        dots.className = 'vagent-dots';
        dots.textContent = '•••';
        var label = document.createElement('span');
        d.appendChild(dots); d.appendChild(label);
        msgsEl.appendChild(d);
        msgsEl.scrollTop = msgsEl.scrollHeight;   // the owner just sent: go to the end
        stickBottom = true;
        var began = Date.now();
        var stateWord = '';
        function paint() {
            var s = Math.round((Date.now() - began) / 1000);
            // one sentence per variant (word order differs between
            // languages); `stateWord` is the feed's own word
            var key = s >= 60
                ? (stateWord ? 'chat.wait.sent_state_long' : 'chat.wait.sent_long')
                : (stateWord ? 'chat.wait.sent_state' : 'chat.wait.sent');
            label.textContent = ' ' + _t(key, {s: s, state: stateWord});
        }
        d.setState = function (word) {
            word = String(word || '').trim();
            if (word && word !== stateWord) { stateWord = word; paint(); }
        };
        // …and while it waits, the owner can read the core's real trace
        // instead of a story about clocks.
        d.setTrace = function (id) { if (id) { attachTrace(d, id); } };
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

    /* ------------------------------------------------- reasoning drawer
       E8/6.  The waiting bubble used to invent what the core was doing; the
       core has kept a real trace all along and it went nowhere.  Every chat
       row carries the v2 work id in `meta.v2`, which is the id
       /api/jobs/<id>/trace speaks, so the drawer hangs off the bubble it
       belongs to: [time] · [what I did] · [what I waited for] · [what I
       found], and a line the core marked `false_claim` is red — the whole
       point is that a claim the core caught itself making is visible to the
       owner, not buried. */
    var traceOpen = {};        // v2 id -> already fetched node

    function traceId(task) {
        var v = task && task.meta && task.meta.v2;
        return (typeof v === 'number' && v > 0) ? v : null;
    }

    function traceRowText(row) {
        var bits = [];
        // `did` repeats `kind` on most rows („created created"); the column
        // already carries it, so only a DIFFERENT verb is worth the width
        if (row.did && String(row.did) !== String(row.kind)) {
            bits.push(String(row.did));
        }
        if (row.found) { bits.push(String(row.found)); }
        if (row.error) { bits.push(_t('chat.trace.error', {err: String(row.error)})); }
        return bits.join(' · ');
    }

    function renderTrace(box, data) {
        box.textContent = '';
        var rows = (data && data.trace) || [];
        if (!rows.length) {
            box.appendChild(lt(edgeRow(''), 'chat.trace.none'));
            return;
        }
        var t0 = rows[0].ts || 0;
        rows.forEach(function (row) {
            var line = document.createElement('div');
            line.className = 'vtrace-row' +
                (row.false_claim ? ' false' : '') +
                (row.error ? ' err' : '');
            var t = document.createElement('span');
            t.className = 'vt-t';
            t.textContent = '+' + Math.max(0, Math.round((row.ts || 0) - t0)) + ' s';
            t.title = new Date((row.ts || 0) * 1000).toLocaleTimeString('cs-CZ');
            line.appendChild(t);
            var k = document.createElement('span');
            k.className = 'vt-k';
            k.textContent = row.kind || '';
            line.appendChild(k);
            var w = document.createElement('span');
            w.className = 'vt-w';
            if (row.waited != null) { lt(w, 'chat.trace.waited', {s: Math.round(row.waited)}); }
            line.appendChild(w);
            var d = document.createElement('span');
            d.className = 'vt-d';
            d.textContent = traceRowText(row);
            d.title = d.textContent;
            line.appendChild(d);
            if (row.false_claim) {
                var f = document.createElement('span');
                f.className = 'vt-f';
                lt(f, 'chat.trace.false');
                lt(f, 'chat.trace.false_tip', null, 'title');
                line.appendChild(f);
            }
            box.appendChild(line);
        });
        var tail = document.createElement('div');
        tail.className = 'vt-tail';
        var usd = rows.reduce(function (a, r) { return a + (r.usd || 0); }, 0);
        // `state` is the core's word (data)
        ltn(tail, usd ? 'chat.trace.steps_usd' : 'chat.trace.steps', rows.length,
            {usd: usd ? usd.toFixed(3) : '', state: data.state ? ' · ' + data.state : ''});
        box.appendChild(tail);
    }

    /* One toggle under a bubble: closed by default, fetched on demand — the
       trace of a long job is not something to pull on every poll. */
    function attachTrace(row, id) {
        if (!id || row.querySelector('.vtrace-btn')) { return; }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vtrace-btn';
        lt(btn, 'chat.trace.btn');
        lt(btn, 'chat.trace.btn_tip', null, 'title');
        var box = document.createElement('div');
        box.className = 'vtrace';
        box.style.display = 'none';
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var open = box.style.display === 'none';
            box.style.display = open ? '' : 'none';
            btn.classList.toggle('on', open);
            if (!open || traceOpen[id]) { return; }
            box.textContent = '';
            box.appendChild(lt(edgeRow(''), 'chat.trace.loading'));
            api('/api/jobs/' + id + '/trace').then(function (d) {
                if (!d || d.ok === false) {
                    box.textContent = '';
                    box.appendChild((d && d.error)
                        ? lt(edgeRow(''), 'chat.trace.no_err', {err: String(d.error)})
                        : lt(edgeRow(''), 'chat.trace.no_answer'));
                    return;
                }
                traceOpen[id] = true;
                renderTrace(box, d);
            }).catch(function (e) {
                box.textContent = '';
                box.appendChild(/HTTP 404/.test(String(e))
                    ? lt(edgeRow(''), 'chat.trace.old')
                    : lt(edgeRow(''), 'chat.trace.failed', {err: String(e)}));
            });
        });
        row.appendChild(btn);
        row.appendChild(box);
    }

    function renderTask(task, fromHistory) {
        if (!task || !task.id) { return false; }
        /* A row is seen TWICE by design: first while the core is still
           working on it (state new/working, no reply), then again when it
           finishes.  `seen` must therefore only suppress a second QUESTION,
           never the answer — a task whose answer half is still missing is
           allowed straight back in.  Before this, the first sighting also
           moved the feed cursor past the id, so the done-transition was
           never fetched at all and the chat kept spinning forever with the
           reply already sitting in the store (measured: task 3244 done on
           the robot, bubble still "working… 78 s"). */
        var finished = task.state === 'done' || task.state === 'failed';
        var known = !!seen[task.id];
        if (known && (!finished || answered[task.id])) { return false; }
        var mineOnly = scope === 'mine';
        var isMine = task.author === author;
        var fromAgent = task.source === 'agent';
        if (mineOnly && !isMine && !fromAgent) { return false; }
        seen[task.id] = true;
        if (finished) { delete openIds[task.id]; }
        else { openIds[task.id] = 1; }
        if (task.id > lastTaskId) { lastTaskId = task.id; }
        if (!oldestTaskId || task.id < oldestTaskId) { oldestTaskId = task.id; }
        var kind = taskKind(task);

        // The question half (skip if this tab just rendered it optimistically).
        if (!known && !fromAgent && task.text) {
            var matched = false;
            if (!fromHistory && isMine) {
                for (var i = 0; i < pendingByText.length; i++) {
                    if (pendingByText[i].text === task.text) { matched = true; break; }
                }
            }
            if (!matched && (fromHistory || !isMine)) {
                turn(kind, isMine ? 'vagent-me' : 'vagent-user', task.text, [
                    {text: clock(task.ts || 0)},
                    isMine && !displayName ? {key: 'chat.you'}
                        : {text: isMine ? displayName : (task.author || '?'),
                           cls: isMine ? '' : 'who'}
                ], task.id);
            }
        }

        if (!finished) {
            // the bubble stops guessing and repeats the feed's own word
            if (isMine) {
                for (var w = 0; w < pendingByText.length; w++) {
                    if (pendingByText[w].text === task.text &&
                            pendingByText[w].node &&
                            pendingByText[w].node.setState) {
                        // 'new' is the panel's word „queued" (translated);
                        // any other state is the feed's own word (data)
                        pendingByText[w].node.setState(
                            task.state === 'new' ? _t('ajob.state.queued') : task.state);
                        if (pendingByText[w].node.setTrace) {
                            pendingByText[w].node.setTrace(traceId(task));
                        }
                        break;
                    }
                }
            }
            return true;
        }
        answered[task.id] = true;

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
        var row = turn(fromAgent ? kind : 'bot', cls, task.reply || task.text || _t('chat.no_reply'),
                       meta, task.id);
        // Artefacts from missions/jobs (photos, map renders) as thumbnails.
        var arts = (task.meta && task.meta.artefacts) || [];
        arts.forEach(function (a) {
            if (a && a.url) { attachImage(row.querySelector('.vagent-msg'), a.url); }
        });
        attachTrace(row, traceId(task));
        if (fromAgent && task.meta && task.meta.event === 'script_output') {
            // Output of a script task: compact bubble with a link to its card.
            row.classList.add('vagent-script');
            var sh = document.createElement('div');
            sh.className = 'vagent-scripthead';
            var kp = document.createElement('span');
            kp.className = 'vagent-pill kind-script';
            lt(kp, 'ajob.kind.script');
            sh.appendChild(kp);
            var sid = task.meta.schedule_id;
            var stitle = task.meta.schedule_title || '';
            var lnk = document.createElement('button');
            lnk.type = 'button';
            lnk.className = 'vagent-ref';
            if (stitle) { lnk.textContent = stitle + (sid ? ' (#' + sid + ')' : ''); }
            else if (sid) { lt(lnk, 'chat.script.task_n', {id: sid}); }
            else { lt(lnk, 'chat.script.task'); }
            lt(lnk, 'chat.script.show', null, 'title');
            lnk.addEventListener('click', function (e) {
                e.stopPropagation();
                if (sid) { highlightSched(sid); } else { activateTab('jobs'); }
            });
            sh.appendChild(lnk);
            row.insertBefore(sh, row.firstChild);
        } else if (fromAgent) {
            lt(row, 'chat.report.reply_tip', null, 'title');
            row.addEventListener('click', function () {
                if (!inputEl) { return; }
                inputEl.value = 'K hlášení #' + task.id + ' (' +
                    String(task.text || '').slice(0, 40) + '…): ';
                inputEl.focus();
            });
            attachFlowButtons(row, task, kind);
        }
        /* a quiet report (RTK fix, dock, „repaired it myself", a summary —
           the core marks it, attention.py) stays in the feed but does not
           bump the badge: the count is for things that want a person */
        if (!fromHistory && (fromAgent || !isMine) && !(fromAgent && task.quiet)) {
            notify(kind, task.reply || task.text || '');
        }
        return true;
    }

    /* Incident templates — the same three the backend sends as `actions`;
       used client-side when a report carries none (older core). */
    /* English display title of a robot finding (owner rule: the UI speaks
       English). The v1 doctor (/api/doctor) titles its findings with a Czech
       label per `kind` (selfcare.TITLES, senses.TITLES, incidents.py) — the
       kind is stable, so the UI shows its own English name for it and keeps
       the agent's text for the body. Unknown kinds fall back to the title,
       never in capitals. */
    var FINDING_EN = {
        brain_failures: 'agent.finding.brain_failures',
        oracle_failures: 'agent.finding.oracle_failures',
        latency_drift: 'agent.finding.latency_drift',
        job_failures: 'agent.finding.job_failures',
        job_stalled: 'agent.finding.job_stalled',
        log_errors: 'agent.finding.log_errors',
        queue_stalled: 'agent.finding.queue_stalled',
        task_stuck: 'agent.finding.task_stuck',
        bridge_down: 'agent.finding.bridge_down',
        chat_topic_dead: 'agent.finding.chat_topic_dead',
        topic_silent: 'agent.finding.topic_silent',
        disk_footprint: 'agent.finding.disk_footprint',
        escalated: 'agent.finding.escalated',
        repaired: 'agent.finding.repaired',
        repair_refused: 'agent.finding.repair_refused',
        rtk_fixed: 'agent.finding.rtk_fixed',
        rtk_lost: 'agent.finding.rtk_lost',
        battery_low: 'agent.finding.battery_low',
        battery_critical: 'agent.finding.battery_critical',
        charging_started: 'agent.finding.charging_started',
        charging_complete: 'agent.finding.charging_complete',
        dock_left: 'agent.finding.dock_left',
        dock_returned: 'agent.finding.dock_returned',
        mower_unauthorised: 'agent.finding.mower_unauthorised',
        rain_out_of_dock: 'agent.finding.rain_out_of_dock',
        motor_power_changed: 'agent.finding.motor_power_changed',
        drive_motor_fault: 'agent.finding.drive_motor_fault',
        drive_motor_recovered: 'agent.finding.drive_motor_recovered',
        service_down: 'agent.finding.service_down',
        service_up: 'agent.finding.service_up',
        morning_report: 'agent.finding.morning_report'
    };
    function findingTitle(f) {
        if (!f) { return ''; }
        var job = /#(\d+)/.exec(String(f.title || ''));
        if (f.kind === 'job_parked') {
            return job ? _t('agent.finding.job_parked_n', {n: job[1]}) : _t('agent.finding.job_parked');
        }
        if (f.kind === 'job_unrecoverable') {
            return job ? _t('agent.finding.job_unrecoverable_n', {n: job[1]})
                : _t('agent.finding.job_unrecoverable');
        }
        if (FINDING_EN[f.kind]) { return _t(FINDING_EN[f.kind]); }
        var t = String(f.title || f.kind || '').trim();
        if (t && t === t.toUpperCase() && t !== t.toLowerCase()) {
            t = t.charAt(0) + t.slice(1).toLowerCase();
        }
        return t;
    }

    function incidentActions(id, title, text) {
        var what = String(title || text || '').replace(/\s+/g, ' ').slice(0, 160);
        // `text` is what goes to the agent (its own language) — not UI;
        // `label` is the English name for callers that print it as is,
        // `labelKey` the same name in the UI's language
        return [
            {label: 'Assign task', labelKey: 'agent.incident.assign', action: 'assign',
             text: 'Řeš incident #' + id + ': ' + what},
            {label: 'Plan', labelKey: 'agent.incident.plan', action: 'plan',
             text: 'Naplánuj řešení incidentu #' + id + ' (jen plán, nic neprováděj): ' + what},
            {label: 'Execute', labelKey: 'agent.incident.execute', action: 'execute',
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
            // a label from the backend is its own text; ours has a key
            var lab = a.labelKey ? {k: a.labelKey} : a.label;
            function paintLab(done) {
                if (a.labelKey) { lt(b, done ? 'agent.act.done' : 'agent.act.label', {label: lab}); }
                else { b.textContent = done ? a.label + ' ✓' : a.label; }
            }
            paintLab(!!assigned[key]);
            b.title = a.text;
            b.addEventListener('click', function (ev) {
                ev.stopPropagation();
                submitText(a.text, {incident_id: id, action: a.action || a.label});
                assigned[key] = true;
                b.classList.add('done');
                paintLab(true);
                var tag = document.createElement('span');
                tag.className = 'vagent-assigned';
                lt(tag, 'agent.act.assigned');
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
        /* A mission parked at the dock lock: the one thing it needs is the
           owner's tap in the Dock lock card, so the bubble carries the way
           there.  Once he unlocks, the mission carries on by itself. */
        if (meta.event === 'awaiting_dock') {
            var dbar = document.createElement('div');
            dbar.className = 'vagent-actions';
            var dgo = document.createElement('button');
            dgo.type = 'button';
            dgo.className = 'vagent-actbtn primary';
            lt(dgo, 'chat.dock.open');
            lt(dgo, 'chat.dock.open_tip', null, 'title');
            dgo.addEventListener('click', function (e) {
                e.stopPropagation();
                openDock(meta.dock_grant || 'test');
            });
            dbar.appendChild(dgo);
            row.appendChild(dbar);
            return;
        }
        /* Mission reports (2026-10-25, owner: „no Execute that starts who
           knows what"): a mission is one piece of work.  No Execute / Follow
           up under its reports — those started brand-new missions (#242).
           A mission that stands and waits for the owner gets one button,
           Continue, which says „pokračuj #N" to THAT mission. */
        if (meta.mission_job) {
            /* operator_stopped / operator_timeout: an operator mission that
               stopped waiting (no answer, STOP standing) carries on in the
               same conversation on „pokračuj #N" (2026-10-25, #254). */
            var parkedEv = {awaiting_supervisor: 1, blocked: 1, parked_for_human: 1,
                            dock_wait_over: 1, supervisor_wait_over: 1,
                            operator_stopped: 1, operator_timeout: 1};
            if (!parkedEv[meta.event]) { return; }
            var mid = meta.mission_job;
            var mbar = document.createElement('div');
            mbar.className = 'vagent-actions';
            var mgo = document.createElement('button');
            mgo.type = 'button';
            mgo.className = 'vagent-actbtn primary';
            lt(mgo, 'chat.flow.resume');
            lt(mgo, 'chat.flow.execute_tip', {cmd: 'pokra\u010duj #' + mid}, 'title');
            mgo.addEventListener('click', function (e) {
                e.stopPropagation();
                submitText('pokra\u010duj #' + mid, {job_id: mid, action: 'resume'});
                openChatSection();
            });
            mbar.appendChild(mgo);
            row.appendChild(mbar);
            return;
        }
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
            lt(go, 'agent.incident.execute');
            lt(go, 'chat.flow.execute_tip', {cmd: 'proveď plán z práce #' + jobId}, 'title');
            go.addEventListener('click', function (e) {
                e.stopPropagation();
                submitText('proveď plán z práce #' + jobId, {job_id: jobId, action: 'execute_plan'});
                openChatSection();
            });
            bar.appendChild(go);
        }
        var cont = document.createElement('button');
        cont.type = 'button'; cont.className = 'vagent-actbtn';
        lt(cont, 'chat.flow.follow');
        lt(cont, 'chat.flow.follow_tip', {cmd: 'pokračuj na ' + jobId + ': …'}, 'title');
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

    /* Ids the panel currently renders as unanswered, newest 50.  The feed is
       a forward cursor (`id > since_id`), so a row whose reply lands after
       the cursor moved past it would never come back — `watch_ids` is the
       server's answer to exactly that (webchat.py `_api_tasks`), and
       `watch_open=1` additionally carries tasks that were already running
       before this tab loaded. */
    function watchQ() {
        var ids = Object.keys(openIds).map(Number).sort(function (a, b) {
            return a - b;
        }).slice(-50);
        return '&watch_open=1' + (ids.length ? '&watch_ids=' + ids.join(',') : '');
    }

    /* The log panel in map_view.js used to poll the agent itself (a second
       5 s hit on :8088, from a file that is not allowed to talk to the agent
       at all).  It listens for this instead — the panel is the single reader
       of the feed and forwards what it sees. */
    var emitted = {};
    function emitTasks(rows) {
        (rows || []).forEach(function (t) {
            if (!t || !t.id || emitted[t.id]) { return; }
            emitted[t.id] = 1;
            document.dispatchEvent(new CustomEvent('vagent:task', {detail: t}));
        });
        var keys = Object.keys(emitted);
        if (keys.length > 600) {          // bounded, like the DOM window
            keys.sort(function (x, y) { return x - y; })
                .slice(0, 300).forEach(function (k) { delete emitted[k]; });
        }
    }

    function pollTasks() {
        var q = '/api/tasks?since_id=' + lastTaskId + watchQ() +
            (scope === 'mine' ? '&author=' + encodeURIComponent(author) : '');
        return api(q).then(function (d) {
            var rows = (d && d.tasks) || [];
            emitTasks(rows);
            if (truncatedBottom) {
                // A deep back-scroll dropped the newest rows; appending live
                // ones under stale history would render a gap.  Track the
                // cursor and the unread badge only — „Latest" reloads clean.
                rows.forEach(function (t) {
                    if (t.id > lastTaskId) { lastTaskId = t.id; }
                    if (t.source === 'agent' && !t.quiet
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
                if (id) { delete seen[id]; delete answered[id]; }
                // a collapsed repeat (U33) stands for several task ids
                String(node.getAttribute('data-merged') || '').split(',')
                    .forEach(function (m) {
                        var mid = parseInt(m, 10);
                        if (mid) { delete seen[mid]; delete answered[mid]; }
                    });
                node.remove();
            }
            truncatedBottom = true;
            paintJump();
        } else {
            for (i = 0; i < extra; i++) {
                node = nodes[i];
                id = parseInt(node.getAttribute('data-task') || '0', 10);
                if (id) { delete seen[id]; delete answered[id]; }
                // a collapsed repeat (U33) stands for several task ids
                String(node.getAttribute('data-merged') || '').split(',')
                    .forEach(function (m) {
                        var mid = parseInt(m, 10);
                        if (mid) { delete seen[mid]; delete answered[mid]; }
                    });
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
        var loader = lt(edgeRow(''), 'chat.older.loading');
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
                    msgsEl.insertBefore(lt(edgeRow('', 'begin'), 'chat.history.begin'),
                                        msgsEl.firstChild);
                }
                loadingOlder = false;
                pruneWindow(true);
            })
            .catch(function () {
                lt(loader, 'chat.older.failed');
                setTimeout(function () { loader.remove(); }, 4000);
                loadingOlder = false;
            });
    }

    function loadHistory() {
        msgsEl.textContent = '';
        seen = {};
        answered = {};
        openIds = {};
        lastTaskId = 0;
        oldestTaskId = 0;
        hasMore = false;
        loadingOlder = false;
        truncatedBottom = false;
        paintJump();
        var loading = document.createElement('div');
        loading.className = 'vagent-empty';
        lt(loading, 'chat.history.loading');
        msgsEl.appendChild(loading);

        function finish(found) {
            if (loading.parentNode) { loading.remove(); }
            if (!found) {
                var e = document.createElement('div');
                e.className = 'vagent-empty';
                lt(e, 'chat.hello');
                msgsEl.appendChild(e);
            }
            scrollChatBottom();
            markSeenNow();
        }

        // One bounded call: the LAST page only.  Older pages load when the
        // user scrolls to the top (loadOlder).
        // Vrací se řetěz (nikdo ze stávajících volajících ho nečte), aby se
        // na dokončení dalo počkat — `submitText()` po něm kreslí bublinu,
        // jinak by ji přepsala dolétající historie.
        return api('/api/tasks?limit=' + PAGE + authorQ()).then(function (data) {
            if (data && Object.prototype.hasOwnProperty.call(data, 'has_more')) {
                var found = false;
                ((data && data.tasks) || []).forEach(function (t) {
                    if (renderTask(t, true)) { found = true; }
                });
                hasMore = !!data.has_more;
                if (!hasMore && found
                        && !msgsEl.querySelector('.vagent-edge.begin')) {
                    msgsEl.insertBefore(lt(edgeRow('', 'begin'), 'chat.history.begin'),
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
                lt(loading, 'chat.history.failed');
            }
        });
    }

    function submitText(text, meta) {
        if (!text) { return; }
        /* KDYŽ ČLOVĚK NĚCO NAPÍŠE, VYHRÁVÁ TO NAD PROCHÁZENÍM HISTORIE.
           Po hlubokém odrolování nahoru zahodí `pruneWindow(true)` nejnovější
           řádky a nastaví `truncatedBottom`; od té chvíle `pollTasks()`
           **záměrně nevykresluje nové zprávy**, aby nevznikla díra. To je
           správně pro cizí zprávy — ale ne pro moji vlastní: naměřeno, že
           odeslané `/status` (jádro ho přijalo jako úkol 3352) se objevilo
           jako bublina „Sent 6 s ago" a při nejbližším pollu **zmizelo**,
           odpověď nedorazila nikdy a nic to nevysvětlilo. Únikovka („↓ Latest")
           existovala, ale hledat ji po vlastní odeslané větě nikdo nebude.
           Vrátíme se proto k živému konci dřív, než bublinu nakreslíme. */
        var body = {text: text, author: author, name: displayName || undefined};
        if (meta && typeof meta === 'object') { body.meta = meta; }

        function draw() {
            turn('me', 'vagent-me', text, [
                {text: clock(Date.now() / 1000)},
                displayName ? {text: displayName} : {key: 'chat.you'}
            ]);
            var node = waiting();
            pendingByText.push({text: text, node: node});
            return node;
        }

        /* Odeslání jde ven HNED — návrat k živému konci ho nesmí zdržet.
           `.catch` se připojuje rovnou, ne až ve `wire()`: mezi odesláním a
           dokreslením bublinky je v truncated větvi celý reload, a kdyby
           požadavek selhal v té mezeře, byla by z toho neošetřená rejekce a
           hláška „Could not send" by nedorazila nikdy. */
        var sendFailed = false, onFail = null;
        var sending = api('/api/task', {body: body});
        sending.catch(function () {
            sendFailed = true;
            if (onFail) { onFail(); }
        });

        function wire(node) {
            onFail = function () {
                stopWaiting(node);
                for (var i = 0; i < pendingByText.length; i++) {
                    if (pendingByText[i].node === node) {
                        pendingByText.splice(i, 1);
                        break;
                    }
                }
                // a UI line drawn as a bubble: it keeps the language of
                // the moment it was drawn (like a log line)
                turn('bot', 'vagent-err', _t('chat.send.failed'), []);
            };
            if (sendFailed) { onFail(); }
        }

        if (truncatedBottom) {
            // Bublina se kreslí AŽ po reloadu: `loadHistory()` maže
            // `#vagent_msgs` a dosypává stránku, takže bublina nakreslená
            // dřív by skončila nad historií, nebo by ji reload smazal.
            var back = loadHistory();
            if (back && typeof back.then === 'function') {
                back.then(function () {
                    // Odeslání proběhlo DŘÍV než reload, takže dolétlá
                    // stránka už moji větu obsahuje — naměřeno: bez téhle
                    // kontroly se `/status` vykreslil dvakrát. Optimistickou
                    // bublinu proto kreslíme jen tehdy, když tam ještě není.
                    if (!lastTurnIsMine(text)) { wire(draw()); }
                    scrollChatBottom();
                });
                return;
            }
        }
        wire(draw());
    }

    /* Je poslední moje bublina právě tahle věta? Porovnává se text, protože
       id serverového řádku v tu chvíli ještě neznáme. */
    function lastTurnIsMine(text) {
        var nodes = turnNodes();
        var want = String(text).trim();
        for (var i = nodes.length - 1; i >= 0 && i >= nodes.length - 4; i--) {
            var n = nodes[i];
            if (!n.classList.contains('vagent-me')) { continue; }
            var body = n.querySelector('.vagent-body') || n;
            if (String(body.textContent || '').trim().indexOf(want) === 0) {
                return true;
            }
        }
        return false;
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
        // the English in the markup above is the first paint only
        [['all', 'chat.filter.all'], ['chat', 'chat.filter.chat'],
         ['report', 'chat.filter.report'], ['work', 'chat.filter.work']].forEach(function (f) {
            lt(el.querySelector('#vagent_chips [data-f="' + f[0] + '"]'), f[1]);
        });
        lt(el.querySelector('#vagent_scope'), 'chat.scope.tip', null, 'title');
        // the label only; data-q is what is sent to the agent
        lt(el.querySelector('#vagent_quick [data-q="Jaký je stav robota?"]'), 'chat.quick.status');

        /* U32: at rest the field is 44 px — one touch target — but its own
           placeholder needed 64 px at 390 px wide, so the phone showed
           „Type a task or question… (/ for" and the TOP HALF of „commands)",
           with a scrollbar drawn inside an empty field.  It is the first
           thing the owner sees in the panel on a phone.  The field grows
           correctly the moment you type (5 lines -> 112 px), so this is a
           resting-state fault and it belongs to the placeholder, not to the
           height: where the column is narrow, a shorter sentence that fits
           on one line.  Re-checked on resize, because the drawer changes
           width without the page reloading (Expand ↗). */
        /* U41, and it is the same mistake this whole night was about:
           A WIDTH OF ZERO IS NOT A WIDTH.  When the panel is restored on
           Work / Robot / Models, the chat pane is hidden, so `clientWidth`
           is 0 — and `(w && w < 340)` read that zero as „wide", picked the
           long sentence, and the phone got the top half of „commands)" back.
           U26 made it worse by remembering the tab honestly: an owner who
           last looked at Work now hit it every time.
           So: 0 means UNMEASURED, and an unmeasured field asks the things
           that do have a width — the drawer, then the window — instead of
           guessing.  And the answer is recomputed when the Chat tab is
           actually shown, not only on `resize`, because becoming visible
           changes the width without the window changing size. */
        syncPlaceholder = function () {
            var w = measuredWidth(inputEl);
            // no width of its own -> ask the window, which always has one;
            // 576 px is the panel's own phone breakpoint (see openPanel)
            var narrow = (w != null) ? (w < 340) : (window.innerWidth < 576);
            inputEl.placeholder = narrow
                ? _t('chat.input.short')
                : _t('chat.input.long');
        };
        syncPlaceholder();
        if (window.requestAnimationFrame) { requestAnimationFrame(syncPlaceholder); }
        window.addEventListener('resize', syncPlaceholder);

        // Lazy history: near the top -> fetch the previous page; the floating
        // „Latest" chip returns to (or reloads) the newest messages.
        jumpBtn = document.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.id = 'vagent_jump';
        lt(jumpBtn, 'chat.jump');
        lt(jumpBtn, 'chat.jump.tip', null, 'title');
        jumpBtn.style.display = 'none';
        jumpBtn.addEventListener('click', function () {
            if (truncatedBottom) { loadHistory(); }
            else { scrollChatBottom(); paintJump(); }
        });
        el.appendChild(jumpBtn);
        msgsEl.addEventListener('scroll', function () {
            // hidden (other tab / closed panel) measures 0 — not a decision
            if (msgsEl.clientHeight > 0) { stickBottom = atBottom(); }
            if (msgsEl.scrollTop < 80) { loadOlder(); }
            paintJump();
        }, {passive: true});
        // the sheet / drawer / keyboard resizing the scroller: keep the end
        // only if the chat was on it (C1)
        if (window.ResizeObserver) {
            new ResizeObserver(function () {
                if (msgsEl.clientHeight > 0) { keepBottom(); paintJump(); }
            }).observe(msgsEl);
        }

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
        /* 2026-10-25: an icon, not the word — "all" here next to the
           filter pill "All" read as the same thing twice; the tooltip says
           what is shown and what a click does */
        function paintScope() {
            var all = scope === 'all';
            scopeBtn.innerHTML = '<i class="la ' + (all ? 'la-users' : 'la-user') + '" aria-hidden="true"></i>';
            lt(scopeBtn, all ? 'chat.scope.all_tip' : 'chat.scope.mine_tip', null, 'title');
            lt(scopeBtn, all ? 'chat.scope.all_tip' : 'chat.scope.mine_tip', null, 'aria-label');
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
            setTimeout(keepBottom, 250);
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
        // Every active job counts; show the newest RUNNING one (matches the
        // top of the Jobs tab) plus the total, so the bar never contradicts
        // the tab (owner saw "one, and a different one" — 4 were running).
        var active = barJobs().filter(function (j) {
            return j.state === 'running' || j.state === 'queued';
        });
        active.sort(function (a, b) {
            var ra = a.state === 'running' ? 0 : 1;
            var rb = b.state === 'running' ? 0 : 1;
            return ra !== rb ? ra - rb : (b.id || 0) - (a.id || 0);
        });
        var running = active[0] || null;
        var pending = ctxAsks.length;
        if (!running && !pending) { bar.style.display = 'none'; return; }
        bar.style.display = '';
        if (running) {
            var jb = document.createElement('button');
            jb.type = 'button';
            jb.className = 'vagent-ctx-item job';
            var pl = document.createElement('span');
            // U25: this used to print `waiting` for anything that was not
            // `running`, so a queued job was called two different things two
            // lines apart.  Same word as its own card, always.
            var pw = stateWord(running.state, running.stalled);
            pl.className = 'vagent-pill ' + (STATUS_CLS[pw] || pw);
            pl.textContent = stateLabel(pw) + (active.length > 1 ? ' ' + active.length : '');
            jb.appendChild(pl);
            var t = document.createElement('span');
            t.className = 'ct';
            t.textContent = '#' + running.id + ' ' + String(running.text || '').slice(0, 60)
                + (active.length > 1 ? '  ' + _t('ajob.ctx.more', {n: active.length - 1}) : '');
            jb.appendChild(t);
            var e2 = document.createElement('span');
            e2.className = 'ce';
            e2.textContent = humanDuration(running.elapsed_s || 0);
            jb.appendChild(e2);
            jb.title = _t('ajob.ctx.to_jobs');
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
            c.textContent = _t('appr.ctx.label', {cmd:
                String((ctxAsks[0] && ctxAsks[0].command) || '').slice(0, 48)});
            ab.appendChild(c);
            ab.title = _t('appr.ctx.tip');
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
        if (s < 60) { return _t('ajob.every', {t: Math.round(s) + ' s'}); }
        if (s % 86400 === 0) {
            return s / 86400 === 1 ? _t('ajob.every.day') : _tn('ajob.every.days', s / 86400);
        }
        if (s % 3600 === 0) { return _t('ajob.every', {t: (s / 3600) + ' h'}); }
        if (s % 60 === 0) { return _t('ajob.every', {t: (s / 60) + ' min'}); }
        return _t('ajob.every', {t: s < 600 ? Math.round(s) + ' s' : (s / 60).toFixed(1) + ' min'});
    }

    function scheduleText(sc) {
        if (!sc) { return ''; }
        if (sc.type === 'daily' || sc.at) { return _t('ajob.daily_at', {at: sc.at || '?'}); }
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
        return d >= 0 ? _t('ajob.rel.in', {t: s}) : _t('ajob.rel.ago', {t: s});
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
    // i18n keys (the ids silent/result/progress are the API's words)
    var POLICY_LABEL = {silent: 'ajob.policy.silent', result: 'ajob.policy.result',
                        progress: 'ajob.policy.progress'};
    var POLICY_TIP = 'ajob.policy.tip';
    /* v1 and v2 state names side by side.  The v2 core's vocabulary is
       queued|running|waiting|done|failed|cancelled|armed|paused (plan §7);
       'waiting' is v1's 'blocked' (it wants a human), 'armed' is a recurring
       job standing ready, i.e. v1's 'scheduled'.  Keeping both means the
       panel does not need a flag day when :8088 starts speaking v2. */
    var STATUS_CLS = {running: 'running', queued: 'queued', blocked: 'blocked',
                      scheduled: 'scheduled', paused: 'paused', draft: 'draft',
                      failed: 'failed', cancelled: 'cancelled', done: 'done',
                      stalled: 'stalled',
                      waiting: 'blocked', armed: 'scheduled'};

    /* U25: ONE word for the state of a job, spelled in ONE place.
       Job #185 wore four different ones on a single screen — `waiting` in
       the pinned bar, `RUNNING` as the heading of the group it sat in,
       `queued` on its own badge and `BLOCKED` in its progress bar.  Three of
       them meant „nothing is happening" and the heading claimed the
       opposite, so the one question the tab exists to answer — is it working
       or not? — had no answer.  Every place that shows a job's state now
       asks stateWord(); nobody spells one itself. */
    var STATE_WORD = {running: 'running', queued: 'queued', blocked: 'blocked',
                      waiting: 'blocked', scheduled: 'scheduled',
                      armed: 'scheduled', paused: 'paused', draft: 'draft',
                      failed: 'failed', cancelled: 'cancelled', done: 'done'};
    function stateWord(status, stalled) {
        var s = String(status == null ? '' : status).toLowerCase();
        var w = STATE_WORD[s] || s;
        // stalled is a fact ABOUT a running job, not a fifth state — except
        // when the job already says it is blocked, which says more.
        if (stalled && w !== 'blocked') { return 'stalled'; }
        return w || 'unknown';
    }
    /* stateWord() is an id (CSS classes are built from it); this is how it
       READS.  A word the panel does not know is the core's own — shown as is. */
    var STATE_KEY = {running: 'ajob.state.running', queued: 'ajob.state.queued',
                     blocked: 'ajob.state.blocked', scheduled: 'ajob.state.scheduled',
                     paused: 'ajob.state.paused', draft: 'ajob.state.draft',
                     failed: 'ajob.state.failed', cancelled: 'ajob.state.cancelled',
                     done: 'ajob.state.done', stalled: 'ajob.state.stalled',
                     unknown: 'ajob.state.unknown'};
    function stateLabel(w) { return STATE_KEY[w] ? _t(STATE_KEY[w]) : w; }

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
            /* The progress bar used to be fed ONLY by the rich v1 row
               (legacyById).  v1 is frozen, so the same numbers are taken
               from the unified row, which the core still writes. */
            steps: j.steps, live_last: j.last || null,
            phase: j.phase_title || j.phase || '',
            verdict: j.verdict || '',
            elapsed_s: (j.active_elapsed_s != null ? j.active_elapsed_s : j.waited_s),
            job_id: j.job_id || null,
            auto: !!j.auto_approve,
            // Only a RUN row is "from" a schedule; a definition row carries
            // its own id in schedule_id and must not pill itself.
            from_sched: (ref.indexOf('j:') === 0 ? (j.schedule_id || null) : null),
            /* Does it need a HUMAN? The core decides (attention.py), the
               panel only colours: human = lit, agent = working on it
               quietly, none = nothing waits. Absent (older core) = null,
               and the old status-based grouping stands. */
            attn: j.attention || null,
            attn_code: j.attention_code || '',
            attn_why: j.attention_why || '',
            attn_params: j.attention_params || {},
            tidy: j.tidy || null,
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
        if (st === 'running' || st === 'queued' || st === 'blocked' ||
                st === 'waiting') { return 'running'; }
        /* Owner, 2026-10-18: „what does not need me must not light up".
           With the core's verdict, ONLY attn=human goes to Needs attention;
           a failure the agent handles or that waits for nobody is history. */
        if (j.attn) {
            if (j.attn === 'human') { return 'attention'; }
            if (st === 'stalled' || j.stalled) { return 'running'; }
            if (j.schedule) { return 'scheduled'; }
            return 'recent';
        }
        if (st === 'failed' || st === 'draft' || st === 'stalled' || j.stalled) { return 'attention'; }
        if (j.schedule && (st === 'scheduled' || st === 'paused' || st === 'armed')) { return 'scheduled'; }
        if (st === 'done' || st === 'cancelled') { return 'recent'; }
        return j.schedule ? 'scheduled' : 'recent';
    }

    function jobFp(j) {
        var pr = progressFor(j, parseRef(j.ref));
        return JSON.stringify([j.ref, j.kind, j.title, j.text, j.status, j.schedule,
            j.policy, j.last, j.runs, j.stalled, j.note, j.legs, j.slot, j.program,
            j.incident, j.live, j.job_id, j.auto, j.archived, j.amendments,
            j.attn, j.attn_code, j.attn_params, j.tidy, groupOf(j), pr]);
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
            try { render(body); } catch (e) { body.textContent = _t('ajob.failed', {err: String(e)}); }
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
        jobSection(card, j.ref, 'rerun', _t('ajob.rerun.title'), function (body) {
            var ta = document.createElement('textarea');
            ta.rows = 2;
            ta.placeholder = _t('ajob.rerun.ph');
            body.appendChild(ta);
            var row = document.createElement('div');
            row.className = 'sb';
            var msg = document.createElement('span');
            msg.className = 'sx';
            var go = actBtn(_t('ajob.rerun.btn'), 'primary', _t('ajob.rerun.tip'), function (b) {
                var note = ta.value.trim();
                if (!note) { msg.textContent = _t('ajob.rerun.empty'); ta.focus(); return; }
                b.disabled = true;
                msg.textContent = _t('ajob.sending');
                jobPost(j.ref, 'rerun', {note: note}, function () {
                    return chatFallback('zopakuj ' + (j.kind === 'script' ? 'úkol' : 'práci') +
                        ' #' + parseRef(j.ref).id + ' — co opravit: ' + note);
                }).then(function (d) {
                    b.disabled = false;
                    if (d && d.ok === false) { msg.textContent = _t('ajob.failed', {err: d.error || '?'}); return; }
                    msg.textContent = '';
                    if (d && d.job_ref) { msg.appendChild(refBtnFor(d.job_ref)); }
                    else { msg.textContent = d && d.chat ? _t('ajob.sent_chat') : _t('ajob.sent'); }
                    ta.value = '';
                    afterAction();
                }).catch(function (e) {
                    b.disabled = false;
                    msg.textContent = /HTTP 404/.test(String(e)) ? _t('ajob.api_missing') : _t('ajob.failed', {err: String(e)});
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
        jobSection(card, j.ref, 'edit', _t('ajob.edit.title'), function (body) {
            var ta = document.createElement('textarea');
            ta.rows = 2;
            ta.placeholder = j.kind === 'script'
                ? _t('ajob.edit.ph_script')
                : _t('ajob.edit.ph_job');
            body.appendChild(ta);
            var row = document.createElement('div');
            row.className = 'sb';
            var msg = document.createElement('span');
            msg.className = 'sx';
            var go = actBtn(_t('ajob.edit.btn'), 'primary', '', function (b) {
                var change = ta.value.trim();
                if (!change) { msg.textContent = _t('ajob.edit.empty'); ta.focus(); return; }
                b.disabled = true;
                msg.textContent = _t('ajob.sending');
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
                    if (d && d.ok === false) { msg.textContent = _t('ajob.failed', {err: d.error || '?'}); return; }
                    msg.textContent = '';
                    if (d && (d.job_id || d.job_ref)) { msg.appendChild(refBtnFor(d.job_ref || ('j:' + d.job_id))); }
                    else { msg.textContent = d && d.chat ? _t('ajob.sent_chat') : _t('ajob.sent'); }
                    ta.value = '';
                    afterAction();
                }).catch(function (e) {
                    b.disabled = false;
                    msg.textContent = /HTTP 404/.test(String(e)) ? _t('ajob.api_missing') : _t('ajob.failed', {err: String(e)});
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
        lab.textContent = _t('ajob.policy.label');
        wrap.appendChild(lab);
        var sel = document.createElement('select');
        sel.className = 'vagent-sel';
        sel.title = _t(POLICY_TIP);
        ['silent', 'result', 'progress'].forEach(function (p) {
            var o = document.createElement('option');
            o.value = p; o.textContent = _t(POLICY_LABEL[p]);
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
                if (d && d.ok === false) { sel.value = prev; sel.title = _t('ajob.failed', {err: d.error || '?'}); return; }
                j.policy = want;
                sel.title = _t(POLICY_TIP);
                afterAction();
            }).catch(function (e) {
                sel.disabled = false;
                sel.value = prev;
                sel.title = /HTTP 404/.test(String(e)) ? _t('ajob.api_missing') : _t('ajob.failed', {err: String(e)});
            });
        });
        wrap.appendChild(sel);
        return wrap;
    }

    /* Auto-approve toggle — the owner's standing yes for this one job.  The
       flag pre-approves ONLY what the Approve button could grant; the safety
       layer and the mower are refused inside the backend shortcut whatever
       the flag says (shellgate.maybe_auto_approve, §11.1/§11.4). */
    /* NOTE (2026-08-30): the core refuses to auto-decide only mower/blade and
       safety-layer requests (`shellgate.never_asks` + `mentions_mower`).
       DRIVING IS NOT ON THAT LIST, so this flag can still pass a request that
       moves the machine — which is exactly what the owner reserved for
       himself.  Until the core excludes movement too (see the report), the
       tooltip says so out loud and turning the flag ON costs a second tap. */
    var AUTOAPPR_TIP = 'ajob.autoappr.tip';      // an i18n key: _t(AUTOAPPR_TIP)

    function autoApproveLabel(on) {
        return on ? _t('ajob.autoappr.on') : _t('ajob.autoappr.off');
    }

    function autoApproveToggle(j) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ja autoap' + (j.auto ? ' on' : '');
        b.textContent = autoApproveLabel(j.auto);
        b.title = _t(AUTOAPPR_TIP);
        var arm = false, armT = null;
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var want = !j.auto;
            if (want && !arm) {          // switching it ON is a decision
                arm = true;
                b.textContent = _t('ajob.autoappr.arm');
                b.classList.add('armed');
                armT = setTimeout(function () {
                    arm = false;
                    b.classList.remove('armed');
                    b.textContent = autoApproveLabel(j.auto);
                }, 6000);
                return;
            }
            if (armT) { clearTimeout(armT); }
            arm = false;
            b.classList.remove('armed');
            b.disabled = true;
            jobPost(j.ref, 'autoapprove', {on: want}).then(function (d) {
                b.disabled = false;
                if (!d || d.ok === false) { b.title = _t('ajob.failed', {err: (d && d.error) || '?'}); return; }
                j.auto = want;
                b.classList.toggle('on', want);
                b.textContent = autoApproveLabel(want);
                b.title = _t(AUTOAPPR_TIP);
                afterAction();
            }).catch(function (e) {
                b.disabled = false;
                b.title = /HTTP 404/.test(String(e)) ? _t('ajob.api_missing') : _t('ajob.failed', {err: String(e)});
            });
        });
        return b;
    }

    function deleteBtn(j) {
        return actBtn('🗑', 'danger', _t('ajob.delete.tip'), function (b) {
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
                    b.title = _t('ajob.delete.failed', {err: String(e)});
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
            more.textContent = jobOpen.has(key) ? _t('ajob.out.less') : _t('ajob.out.more');
            more.addEventListener('click', function () {
                var on = !pre.classList.contains('full');
                pre.classList.toggle('full', on);
                more.textContent = on ? _t('ajob.out.less') : _t('ajob.out.more');
                jobOpenSet(key, on);
            });
            card.appendChild(more);
        }
    }

    function followUpBtn(j) {
        var p = parseRef(j.ref);
        return actBtn(_t('chat.flow.follow'), '',
                      _t('chat.flow.follow_tip', {cmd: 'pokračuj na ' + p.id + ': …'}), function () {
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
            el.textContent = _t('ajob.d.copied');
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

        jdHeading(body, _t('ajob.d.goal'));
        var goal = jdRow(body, 'jd-txt', d.goal || j.text || _t('ajob.d.none'));
        goal.title = '';
        // Amendments: later „pokračuj na N: …" / rerun notes / script edits
        // change what the job should do — the original goal alone is then
        // out of date (owner 2026-08-29). Show them right under the goal.
        var ams = (d.amendments || []).filter(function (a) {
            return a && (a.kind === 'note' || a.kind === 'edit');
        });
        if (ams.length) {
            var box = document.createElement('div');
            box.className = 'jd-amends';
            var h = document.createElement('div');
            h.className = 'jd-amends-h';
            h.textContent = _t('ajob.d.amends', {n: ams.length});
            box.appendChild(h);
            ams.forEach(function (a, i) {
                var row = document.createElement('div');
                row.className = 'jd-amend';
                var meta = document.createElement('span');
                meta.className = 'jd-amend-m';
                var when = a.ts ? new Date(a.ts * 1000).toLocaleString(window.VTI18n ? VTI18n.lang() : undefined) : '';
                meta.textContent = (i + 1) + '. ' + (a.by || _t('ajob.d.owner'))
                    + (when ? ' · ' + when : '');
                var txt = document.createElement('span');
                txt.className = 'jd-amend-t';
                txt.textContent = a.text || a.raw || '';
                row.appendChild(meta);
                row.appendChild(txt);
                box.appendChild(row);
            });
            // Dimmed revival lines, collapsed, so the timeline is complete
            // without pretending the doctor changed the goal.
            var revs = (d.amendments || []).filter(function (a) {
                return a && a.kind === 'revival';
            });
            if (revs.length) {
                var rd = document.createElement('div');
                rd.className = 'jd-amend-rev';
                rd.textContent = _tn('ajob.d.revivals', revs.length);
                box.appendChild(rd);
            }
            body.appendChild(box);
        }

        if (d.final_reply) {
            jdHeading(body, _t('ajob.d.result'));
            var res = document.createElement('div');
            res.className = 'jd-txt jd-md';
            try { renderMarkdown(res, d.final_reply); }
            catch (e) { res.textContent = d.final_reply; }
            body.appendChild(res);
        }

        var arts = d.artifacts || [];
        if (arts.length) {
            jdHeading(body, _t('ajob.d.files', {n: arts.length}));
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
                pa.title = _t('ajob.d.path_tip', {path: a.path});
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
            jdHeading(body, _tn('ajob.d.timeline', legsLog.length));
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
                    jdRow(row, 'jd-drv', _t('ajob.d.driver', {what: leg.driver_action}));
                }
                body.appendChild(row);
            });
        }

        var runs = d.runs || [];
        if (runs.length) {                       // script definitions
            jdHeading(body, _t('ajob.d.runs', {n: runs.length}));
            runs.slice(-8).reverse().forEach(function (r) {
                jdRow(body, 'jd-leg-t mono',
                      relTime(r.ts) + ' · exit ' + (r.exit === null ? '?' : r.exit) +
                      ' · ' + String(r.stdout || r.error || '').split('\n')[0].slice(0, 80),
                      String(r.stdout || r.error || ''));
            });
        }

        var posts = d.posts || [];
        if (posts.length) {
            jdHeading(body, _t('ajob.d.posts', {n: posts.length}));
            posts.forEach(function (p) {
                jdRow(body, 'jd-leg-t', relTime(p.ts) + ' · ' + (p.head || ''),
                      p.head || '');
            });
        }

        var asks = d.approvals || [];
        if (asks.length) {
            jdHeading(body, _t('ajob.d.approvals'));
            asks.forEach(function (a) {
                var row = document.createElement('div');
                row.className = 'jd-leg-h';
                /* auto-approved requests are never a pending row — they show
                   as their outcome, marked auto, with the deciding actor */
                var stTxt = a.auto ? _t('ajob.d.auto_approved') : (a.state || '');
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
        jobSection(card, j.ref, 'detail', _t('ajob.d.title'), function (body) {
            jdRow(body, 'sx', _t('ajob.d.loading'));
            detailFetch(j).then(function (d) {
                renderDetail(body, d, j);
            }).catch(function () {
                // Endpoint not there (yet): show what the row itself knows.
                renderDetail(body, {
                    note: _t('ajob.d.api_missing'),
                    goal: j.text,
                    final_reply: j.last && j.last.output,
                    artifacts: [], legs: [], posts: [], approvals: [],
                }, j);
            });
        }, {always: true});
    }

    /* ------------------------------------------------------- JobProgress
       E8/3.  A running job used to be a wall of text; the numbers that say
       where it actually is (leg, legs, phase, steps, last, verdict, stalled)
       were fetched every 3 s in /api/jobs and drawn nowhere.  This is a
       segmented bar — one segment per leg, the current one live — plus one
       line of facts and one truncated line of what it last did. */
    var legacyById = {};        // job id -> the rich live row from /api/jobs
    var LEG_MAX = 14;           // segments drawn; beyond that they merge

    function progressFor(j, p) {
        // a frozen v1 row is 30 h old; the unified row on `j` is current
        var live = legacyFrozen ? null : legacyById[p && p.id];
        // with v1 frozen, a unified row is a first-class source of progress
        if (!live && j.src !== 'legacy' && !j.legs && !j.steps) { return null; }
        var src = live || j;
        var legs = Number(src.legs || 0);
        var leg = Number(src.leg || legs || 0);
        if (!legs && !leg && !src.steps) { return null; }
        return {
            leg: leg, legs: Math.max(legs, leg),
            steps: src.steps || 0,
            phase: src.phase_title || src.phase || '',
            verdict: src.verdict || '',
            stalled: !!(src.stalled || j.stalled),
            state: src.state || j.status || '',
            last: (typeof src.last === 'string' ? src.last : '') ||
                  (typeof j.live_last === 'string' ? j.live_last : '') ||
                  (j.last && j.last.output) || '',
            elapsed_s: src.elapsed_s
        };
    }

    function jobProgress(card, j, group) {
        var pr = progressFor(j, parseRef(j.ref));
        if (!pr) { return; }
        var running = group === 'running';
        if (!running && !pr.legs) { return; }

        var box = document.createElement('div');
        box.className = 'jp' + (pr.stalled ? ' stalled' : '');

        var bar = document.createElement('div');
        bar.className = 'jp-bar';
        var total = Math.max(1, Math.min(pr.legs || 1, LEG_MAX));
        var merged = (pr.legs || 0) > LEG_MAX;
        for (var i = 1; i <= total; i++) {
            var seg = document.createElement('span');
            var isNow = running && !pr.stalled &&
                (merged ? i === total : i === pr.leg);
            seg.className = 'jp-seg' + (i <= pr.leg ? ' done' : '') +
                (isNow ? ' now' : '');
            seg.title = _t('ajob.p.leg', {n: merged && i === total ? pr.leg : i}) +
                (pr.phase && isNow ? ' · ' + pr.phase : '');
            bar.appendChild(seg);
        }
        box.appendChild(bar);

        var facts = document.createElement('div');
        facts.className = 'jp-facts';
        function fact(text, title, cls) {
            if (!text) { return; }
            var s = document.createElement('span');
            s.className = 'jp-f' + (cls ? ' ' + cls : '');
            s.textContent = text;
            if (title) { s.title = title; }
            facts.appendChild(s);
        }
        fact(pr.legs ? _t('ajob.p.leg_of', {n: pr.leg || pr.legs, of: pr.legs}) : '',
             _t('ajob.p.leg_tip'));
        fact(pr.steps ? _tn('ajob.p.steps', pr.steps) : '', _t('ajob.p.steps_tip'));
        fact(pr.phase, _t('ajob.p.phase'));
        fact(pr.elapsed_s ? shortAge(pr.elapsed_s) : '', _t('ajob.p.elapsed'));
        if (pr.verdict) {
            // U25: printed bare, `BLOCKED` read as a fourth state of the job
            // itself.  It is the verdict of ONE LEG — say so on the chip, not
            // only in a tooltip nobody hovers on a phone.
            fact(_t('ajob.p.verdict', {v: pr.verdict}), _t('ajob.p.verdict_tip'),
                 /BLOCK|FAIL/i.test(pr.verdict) ? 'bad'
                 : /OK|DONE/i.test(pr.verdict) ? 'good' : '');
        }
        if (pr.stalled) { fact(_t('ajob.state.stalled'), _t('ajob.p.stalled_tip'), 'bad'); }
        if (facts.childNodes.length) { box.appendChild(facts); }

        if (pr.last) {
            var lastLine = document.createElement('div');
            lastLine.className = 'jp-last';
            lastLine.textContent = String(pr.last);
            lastLine.title = String(pr.last);
            box.appendChild(lastLine);
        }
        card.appendChild(box);
    }

    /* One sentence on WHO is on it: you (lit), the agent (quiet), or
       nobody needs to be (quiet).  The words are the panel's (VTI18n, keyed
       by the core's code); the core's own Czech sentence rides in the
       tooltip as evidence. */
    function attnText(code, params, fallback) {
        var key = (code.indexOf('fix.') === 0 ? 'ajob.handled.' : 'ajob.attn.') + code;
        var got = _t(key, params || {});
        return got && got !== key ? got : (fallback || '');
    }
    function attnLine(card, j) {
        if (!j.attn || !j.attn_code) { return; }
        if (j.attn_code === 'active' || j.attn_code === 'done' ||
                j.attn_code === 'scheduled' || j.attn_code === 'paused') { return; }
        var params = {};
        Object.keys(j.attn_params || {}).forEach(function (k) { params[k] = j.attn_params[k]; });
        if (params.next_ts) { params.when = relTime(params.next_ts); }
        var txt = attnText(j.attn_code, params, j.attn_why);
        if (!txt) { return; }
        var row = document.createElement('div');
        row.className = 'vagent-attn a-' + j.attn;
        var who = document.createElement('span');
        who.className = 'aw';
        who.textContent = _t('ajob.attn.who.' + j.attn);
        row.appendChild(who);
        row.appendChild(document.createTextNode(' ' + txt));
        row.title = j.attn_why || txt;
        if (j.tidy && j.tidy.fix) { row.title += '\n' + j.tidy.fix; }
        card.appendChild(row);
    }

    function buildJobCard(j, group) {
        var p = parseRef(j.ref);
        var card = document.createElement('div');
        card.className = 'vagent-ujob k-' + j.kind + ' st-' + (STATUS_CLS[j.status] || '') +
            (j.stalled ? ' stalled' : '') + (j.attn ? ' attn-' + j.attn : '');
        card.setAttribute('data-ref', j.ref);
        card.setAttribute('data-group', group);

        // ---- head: kind · #ref title · status · stalled · muted
        var top = document.createElement('div');
        top.className = 'st';
        top.appendChild(pill(_t(j.kind === 'script' ? 'ajob.kind.script' : 'ajob.kind.prompt'),
            'kind-' + (j.kind === 'script' ? 'script' : 'prompt'),
            j.kind === 'script'
                ? _t('ajob.kind.script_tip')
                : _t('ajob.kind.prompt_tip')));
        var name = document.createElement('span');
        name.className = 'sn';
        name.textContent = '#' + p.id + ' ' + (j.title || j.text || '');
        name.title = j.text || j.title || '';
        top.appendChild(name);
        // stalled has its own pill right below, so it is not folded in here
        var stLabel = j.status === 'draft' ? _t('ajob.c.writing') : stateLabel(stateWord(j.status));
        top.appendChild(pill(stLabel, 'state-' + (STATUS_CLS[j.status] || 'queued'),
            j.status === 'failed' ? ((j.last && j.last.error) || '') : ''));
        if (j.stalled) {
            top.appendChild(pill(_t('ajob.state.stalled'), 'stalled', j.note || _t('ajob.c.stalled_tip')));
        }
        if (j.policy === 'silent') {
            top.appendChild(pill(_t('ajob.c.muted'), 'muted', _t('ajob.c.muted_tip')));
        }
        if (j.auto) {
            top.appendChild(pill(_t('ajob.autoappr.on'), 'autoap', _t(AUTOAPPR_TIP)));
        }
        if (j.archived) {
            card.classList.add('archived');
            top.appendChild(pill(_t('ajob.c.archived'), 'arch',
                j.archived_ts ? _t('ajob.c.archived_at', {at:
                    new Date(j.archived_ts * 1000).toLocaleString('cs-CZ')}) : ''));
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
            nx.textContent = (j.status === 'paused') ? _t('ajob.state.paused')
                : _t('ajob.c.next', {t: relTime(j.schedule.next_run)});
            mid.appendChild(nx);
        }
        if (j.legs) { mid.appendChild(pill(_t('ajob.c.legs', {n: j.legs}), '', _t('ajob.c.legs_tip'))); }
        if (j.slot !== undefined && j.slot !== null) {
            mid.appendChild(pill(_t('ajob.c.slot', {n: j.slot}), '', _t('ajob.c.slot_tip')));
        }
        if (j.subagents) {
            mid.appendChild(pill(_t('ajob.c.subagents', {n: j.subagents}), '', _t('ajob.c.subagents_tip')));
        }
        if (j.from_sched) {
            var fs = pill(_t('ajob.c.from', {id: j.from_sched}), '', _t('ajob.c.from_tip', {id: j.from_sched}));
            fs.classList.add('vt-pointer');
            fs.addEventListener('click', function () {
                if (window.VAgent && VAgent.highlightSched) { VAgent.highlightSched(j.from_sched); }
            });
            mid.appendChild(fs);
        }
        if (j.last && j.last.ts) {
            var lastLbl = document.createElement('span');
            lastLbl.className = 'sx';
            lastLbl.textContent = _t('ajob.c.last', {t: relTime(j.last.ts)}) +
                (group !== 'running' && durationText(j) ? ' · ' + durationText(j) : '');
            lastLbl.title = new Date(j.last.ts * 1000).toLocaleString('cs-CZ');
            mid.appendChild(lastLbl);
        }
        if (group === 'running' && durationText(j)) {
            mid.appendChild(pill(durationText(j), '', _t('ajob.c.running_for')));
        }
        if (j.runs) {
            var rc = document.createElement('span');
            rc.className = 'sx';
            var counted = (j.ok_count || 0) + (j.fail_count || 0);
            rc.textContent = j.runs + '×' +
                (counted ? ' ' + (j.overruns
                    ? _t('ajob.c.counts_over', {ok: j.ok_count || 0, fail: j.fail_count || 0, over: j.overruns})
                    : _t('ajob.c.counts', {ok: j.ok_count || 0, fail: j.fail_count || 0})) : '');
            rc.title = _t('ajob.c.runs_tip');
            mid.appendChild(rc);
        }
        if (j.job_id && String(j.job_id) !== String(p.id)) {
            mid.appendChild(refButton('j:' + j.job_id, '→ #' + j.job_id));
        }
        if (j.incident) {
            var ib = document.createElement('button');
            ib.type = 'button'; ib.className = 'vagent-ref';
            ib.textContent = _t('ajob.c.incident', {id: j.incident});
            ib.title = _t('ajob.c.incident_tip');
            ib.addEventListener('click', function () { activateTab('incidents'); });
            mid.appendChild(ib);
        }
        if (mid.childNodes.length) { card.appendChild(mid); }

        // ---- where the job actually is (segmented, E8/3)
        jobProgress(card, j, group);

        // ---- what it is doing / why it failed
        var live = j.note ? _t('ajob.c.driver', {note: j.note}) : (j.live || '');
        if (live) {
            var ll = document.createElement('div');
            ll.className = 'jl';
            ll.textContent = live;
            ll.title = live;
            card.appendChild(ll);
        }
        attnLine(card, j);
        var err = j.last && j.last.error;
        if (err && (group === 'attention' || j.status === 'failed')) {
            var eb = document.createElement('div');
            eb.className = 'se' + (j.attn && j.attn !== 'human' ? ' quiet' : '');
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
            acts.appendChild(actBtn(_t('ajob.a.cancel'), '', _t('ajob.a.cancel_tip'), function (b) {
                inlineConfirm(b, function () {
                    jobPost(j.ref, 'cancel', null, function () {
                        return chatFallback('zruš práci ' + p.id);
                    }).then(afterAction).catch(function (e) { b.title = _t('ajob.a.cancel_failed', {err: String(e)}); });
                });
            }));
            if (j.status === 'blocked' || j.stalled) {
                acts.appendChild(actBtn(_t('ajob.a.resume'), 'primary', _t('ajob.a.resume_tip'), function (b) {
                    b.disabled = true;
                    jobPost(j.ref, 'resume', null, function () {
                        return chatFallback('pokračuj na ' + p.id);
                    }).then(function () { b.disabled = false; afterAction(); })
                      .catch(function (e) { b.disabled = false; b.title = _t('ajob.a.resume_failed', {err: String(e)}); });
                }));
            }
        } else if (group === 'scheduled') {
            var on = j.status !== 'paused';
            acts.appendChild(actBtn(on ? '⏸' : '▶', '', on ? _t('ajob.a.pause') : _t('ajob.a.resume'), function (b) {
                b.disabled = true;
                jobPost(j.ref, on ? 'pause' : 'resume', null, function () {
                    return schedPost(p.id, on ? 'pause' : 'resume');
                }).then(function () { b.disabled = false; afterAction(); })
                  .catch(function (e) { b.disabled = false; b.title = _t('ajob.failed', {err: String(e)}); });
            }));
            acts.appendChild(actBtn('↻', '', _t('ajob.a.run_now'), function (b) {
                b.disabled = true;
                jobPost(j.ref, 'run', null, function () { return schedPost(p.id, 'run'); })
                    .then(function () {
                        setTimeout(function () { b.disabled = false; }, 1500);
                        afterAction();
                    }).catch(function (e) { b.disabled = false; b.title = _t('ajob.a.run_failed', {err: String(e)}); });
            }));
        } else if (group === 'attention') {
            if (j.status !== 'draft') {
                acts.appendChild(actBtn(_t('ajob.a.run'), '', _t('ajob.a.run_tip'), function (b) {
                    b.disabled = true;
                    jobPost(j.ref, 'run', null, function () {
                        return p.kind === 's' ? schedPost(p.id, 'run')
                            : chatFallback('zopakuj práci #' + p.id);
                    }).then(function () { b.disabled = false; afterAction(); })
                      .catch(function (e) { b.disabled = false; b.title = _t('ajob.a.run_failed', {err: String(e)}); });
                }));
            }
            acts.appendChild(followUpBtn(j));
        } else if (group === 'archive') {
            // read-only shelf: Unarchive + Details, nothing else
            acts.appendChild(actBtn(_t('ajob.a.unarchive'), 'primary',
                _t('ajob.a.unarchive_tip'), function (b) {
                b.disabled = true;
                jobPost(j.ref, 'unarchive', null).then(function () {
                    archFetched = false;    // shelf changed: refetch on open
                    pollArchived();
                    afterAction();
                }).catch(function (e) { b.disabled = false; b.title = _t('ajob.a.unarchive_failed', {err: String(e)}); });
            }));
            card.appendChild(acts);
            detailSection(card, j);
            return card;
        } else {   // recent
            acts.appendChild(followUpBtn(j));
        }
        if (unifiedOk === true && group !== 'running' &&
            (group !== 'scheduled' || j.status === 'paused' || j.status === 'draft')) {
            acts.appendChild(actBtn('🗄', '', _t('ajob.a.archive_tip'), function (b) {
                b.disabled = true;
                jobPost(j.ref, 'archive', null).then(function () {
                    archFetched = false;    // shelf changed: refetch on open
                    afterAction();
                }).catch(function (e) { b.disabled = false; b.title = _t('ajob.a.archive_failed', {err: String(e)}); });
            }));
        }
        // the policy (report ▾ + auto-approve) is one group: on a narrow card
        // it wraps as a whole instead of leaving one control alone on a line
        var pol = document.createElement('span');
        pol.className = 'vagent-polgrp';
        pol.appendChild(policySelect(j));
        pol.appendChild(autoApproveToggle(j));
        acts.appendChild(pol);
        acts.appendChild(deleteBtn(j));
        card.appendChild(acts);

        // ---- sections
        detailSection(card, j);
        if (group === 'attention' || group === 'recent') { rerunSection(card, j); }
        editSection(card, j);
        return card;
    }

    // ------------------------------------------------------------- the pane
    var unifiedIdle = 0;        // U34: beats skipped while Work is off screen
    var jobCards = {};          // ref → {node, fp}
    var jobsFp = null, deferredJobs = null;
    /* `saysState` is the whole point of U42.  A group heading is either a
       claim about the STATE of what is under it („Running", „Scheduled",
       „Needs attention") or a claim about a SHELF („Recent", „Archive").
       Only the first kind can be contradicted by its contents, and only the
       first kind therefore gets renamed to match them.  Each group declares
       which it is, here, once — nobody outside this table decides it. */
    // label / mixed / empty are i18n keys
    var GROUPS = [
        {id: 'running', label: 'ajob.g.running', saysState: true, mixed: 'ajob.g.active',
         empty: 'ajob.g.running_empty'},
        {id: 'scheduled', label: 'ajob.g.scheduled', saysState: true,
         empty: 'ajob.g.scheduled_empty'},
        {id: 'attention', label: 'ajob.g.attention', saysState: true,
         empty: 'ajob.g.attention_empty'},
        {id: 'recent', label: 'ajob.g.recent', empty: 'ajob.g.recent_empty'},
        {id: 'handled', label: 'ajob.g.handled', empty: 'ajob.g.handled_empty'},
        {id: 'archive', label: 'ajob.g.archive',
         empty: 'ajob.g.archive_empty'}
    ];

    /* U25, second half — and U42, which was the same fault one group over.
       The heading of a group must say what is IN it.  `running` is a bucket
       of everything alive (running · queued · blocked · stalled), so it was
       headed „RUNNING 1" over a single queued, blocked job.  `scheduled` is a
       bucket of everything with a timetable, so it was headed „SCHEDULED 3"
       over three jobs that were all `paused` — i.e. over the whole of the
       robot's regular work, saying it would run.

       The rule is now one rule for every group that claims a state:
         · one state word under the heading  -> the heading IS that word
         · several                           -> they are listed („scheduled ·
           paused"), because a mixture named after one of its halves is the
           lie we keep finding; `running` keeps „Active", the word U25 chose
           for its mixture
         · too many to list, or a shelf group -> the fixed label */
    function groupHeading(g, items) {
        if (!g.saysState || !items || !items.length) { return _t(g.label); }
        var seen = {}, order = [];
        items.forEach(function (j) {
            var w = stateWord(j.status, j.stalled);
            if (!seen[w]) { seen[w] = 1; order.push(stateLabel(w)); }
        });
        function cap(w) { return w.charAt(0).toUpperCase() + w.slice(1); }
        if (order.length === 1) { return cap(order[0]); }
        if (g.mixed) { return _t(g.mixed); }
        if (order.length <= 3) { return cap(order.join(' · ')); }
        return _t(g.label);
    }

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
        var sig = JSON.stringify(list.map(jobFp)) + '|' + unifiedOk + '|' + jobsErr +
            '|' + JSON.stringify(lastHandled);
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
                       handled: [], archive: []};
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
            if (g.id === 'handled' && (unifiedOk !== true || !lastHandled.length)) { return; }
            var items = g.id === 'handled' ? lastHandled.slice()
                : sortJobs(g.id, buckets[g.id]);
            var total = items.length;
            if (g.id === 'recent') { items = items.slice(0, 10); }
            var head = document.createElement('div');
            head.className = 'vagent-sh g-' + g.id;
            head.appendChild(document.createTextNode(groupHeading(g, items)));
            var c = document.createElement('span');
            c.className = 'vagent-cnt' + (g.id === 'attention' && total ? ' warn' : '');
            c.textContent = (g.id === 'archive' && !archFetched) ? '…' : String(total);
            head.appendChild(c);

            var host;
            if (g.id === 'recent' || g.id === 'archive' || g.id === 'handled') {
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
                loading.textContent = _t('ajob.g.archive_open');
                host.appendChild(loading);
                return;
            }
            if (!items.length) {
                var e = document.createElement('div');
                e.className = 'vagent-empty';
                e.textContent = _t(g.empty);
                host.appendChild(e);
                return;
            }
            if (g.id === 'handled') {
                items.forEach(function (h) { host.appendChild(handledRow(h)); });
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
        jobsBadge.title = _t('ajob.badge.tip', {run: act, att: att});
        if (att) { flagTab('jobs'); }
    }

    /* „Handled by agent" — the owner's short overview, Problem · Reason ·
       Fix, of what the agent tidied or solved on its own.  Read-only, never a
       badge: it exists so that „quiet" can be checked, not to be acted on. */
    var lastHandled = [];
    var HANDLED_CODES = {cancelled: 1, superseded: 1, replaced: 1, cause_gone: 1,
                         cause_fixed: 1, denied: 1, grow: 1, transient: 1,
                         agent_stopped: 1, revived: 1, selfcare_repair: 1};
    function handledRow(h) {
        var row = document.createElement('div');
        row.className = 'vagent-handled';
        var head = document.createElement('div');
        head.className = 'hh';
        if (h.ref) { head.appendChild(refButton(h.ref, '#' + String(h.ref).replace(/^j:/, ''))); }
        var tt = document.createElement('span');
        tt.className = 'ht';
        tt.textContent = (h.params && h.params.title) || h.problem || '';
        tt.title = h.problem || '';
        head.appendChild(tt);
        var when = document.createElement('span');
        when.className = 'sx';
        when.textContent = h.ts ? relTime(h.ts) : '';
        if (h.ts) { when.title = new Date(h.ts * 1000).toLocaleString('cs-CZ'); }
        head.appendChild(when);
        row.appendChild(head);
        var known = HANDLED_CODES[h.code];
        var params = {};
        Object.keys(h.params || {}).forEach(function (k) { params[k] = h.params[k]; });
        [['problem', h.problem],
         ['reason', known && h.code !== 'selfcare_repair'
             ? attnText(h.code, params, h.why) : h.why],
         ['fix', known && h.code !== 'selfcare_repair'
             ? attnText('fix.' + h.code, params, h.fix) : h.fix]
        ].forEach(function (pair) {
            if (!pair[1]) { return; }
            var line = document.createElement('div');
            line.className = 'hl';
            var lab = document.createElement('span');
            lab.className = 'hk';
            lab.textContent = _t('ajob.handled.' + pair[0]);
            line.appendChild(lab);
            line.appendChild(document.createTextNode(' ' + pair[1]));
            row.appendChild(line);
        });
        return row;
    }

    // --------------------------------------------------------------- polling
    /* The v1 job list is FROZEN.  The core stopped writing to it on
       2026-08-30 19:14 and now says so in the answer itself: `frozen: <ts>`,
       one leftover row (#185, „queued" for thirty hours and never going to
       start) and `counts.open: 29` with `source: v2:work` — i.e. „ask v2".
       The panel used to read that single stale row as WHAT THE ROBOT IS
       DOING NOW: the context bar and the shell strip both claimed a job that
       nobody will run, while 29 open ones were invisible to them.
       A list the core has declared frozen is history, not state. */
    var legacyFrozen = 0, legacyOpenCount = null;

    function pollJobs() {
        return api('/api/jobs').then(function (d) {
            legacyJobs = (d && d.jobs) || [];
            legacyFrozen = (d && Number(d.frozen)) || 0;
            legacyOpenCount = (d && d.counts && d.counts.open != null)
                ? Number(d.counts.open) : null;
            legacyById = {};
            legacyJobs.forEach(function (row) { legacyById[row.id] = row; });
            ctxJobs = legacyJobs;
            paintCtx();
            paintStrip();
            if (unifiedOk !== true) { renderJobsPane(composeJobs()); }
        }).catch(function () {});
    }

    /* The one list both bars are allowed to speak about.  It is the SAME
       list the Work tab draws, which is the whole point — the owner saw
       „one, and a different one" often enough tonight. */
    function barJobs() {
        if (unifiedOk === true) {
            return lastUnifiedRaw.filter(function (j) {
                return !j.archived && !j.schedule;     // definitions are not runs
            }).map(function (j) {
                return {id: j.id, state: String(j.status || ''),
                        stalled: !!j.stalled,
                        text: j.title || j.text || '',
                        last: j.last || null,
                        error: (j.last_run && j.last_run.error) || null,
                        blocked: j.driver_note || null,
                        elapsed_s: j.active_elapsed_s != null
                            ? j.active_elapsed_s : j.waited_s,
                        legs: j.legs, steps: j.steps};
            });
        }
        if (legacyFrozen) { return []; }   // frozen history says nothing about now
        return legacyJobs || [];
    }

    function pollLegacySchedules() {
        return api('/api/schedules').then(function (d) {
            if (!d || d.ok === false) {
                legacySchedOk = false; legacySched = [];
                jobsErr = (d && d.error) ? _t('ajob.err.sched', {err: d.error})
                    : _t('ajob.err.sched_missing');
                return;
            }
            legacySchedOk = true;
            jobsErr = '';
            legacySched = d.schedules || [];
        }).catch(function (e) {
            legacySchedOk = false;
            legacySched = [];
            if (/HTTP 404/.test(String(e))) { jobsErr = _t('ajob.err.sched_missing') + '.'; }
        });
    }

    function pollUnified() {
        if (!jobsListBox) { return Promise.resolve(); }
        if (unifiedOk === false) {
            return pollLegacySchedules().then(function () { renderJobsPane(composeJobs()); });
        }
        return api('/api/unified/jobs').then(function (d) {
            // agent down (#28) says nothing about the contract — don't latch
            if (d && d.agent_down) { return null; }
            if (!d || d.ok === false) {
                unifiedOk = false;
                return pollLegacySchedules().then(function () { renderJobsPane(composeJobs()); });
            }
            unifiedOk = true;
            jobsErr = '';
            lastUnifiedRaw = d.jobs || [];
            lastHandled = Array.isArray(d.handled) ? d.handled : [];
            renderJobsPane(composeJobs());
            return null;
        }).catch(function (e) {
            if (/HTTP 404/.test(String(e))) {
                unifiedOk = false;          // the contract has not landed yet
                jobsErr = '';
                return pollLegacySchedules().then(function () { renderJobsPane(composeJobs()); });
            }
            jobsErr = _t('ajob.err.down');
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
        {key: 'ajob.f.custom', s: 0}
    ];
    var INTERVALS_SCRIPT = [
        {label: '5 s', s: 5}, {label: '10 s', s: 10}, {label: '20 s', s: 20}, {label: '30 s', s: 30},
        {label: '1 min', s: 60}, {label: '5 min', s: 300}, {key: 'ajob.f.custom', s: 0}
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
        lt(toggle, 'ajob.f.new');
        form.appendChild(toggle);
        var body = document.createElement('div');
        body.className = 'sf';
        body.style.display = 'none';

        // kind: prompt (text for Hermes) | script (a program the core runs)
        var kind = 'prompt', kb = {};
        var kindRow = document.createElement('div');
        kindRow.className = 'vagent-kind';
        [['prompt', 'ajob.f.prompt', 'ajob.f.prompt_tip'],
         ['script', 'ajob.f.script', 'ajob.f.script_tip']]
            .forEach(function (k) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'vagent-ivl' + (k[0] === kind ? ' on' : '');
                lt(b, k[1]);
                lt(b, k[2], null, 'title');
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
        [['now', 'ajob.f.now', 'ajob.f.now_tip'],
         ['every', 'ajob.f.every', 'ajob.f.every_tip'],
         ['daily', 'ajob.f.daily', 'ajob.f.daily_tip']].forEach(function (w) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'vagent-ivl' + (w[0] === when ? ' on' : '');
            lt(b, w[1]);
            lt(b, w[2], null, 'title');
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
                if (iv.key) { lt(b, iv.key); } else { b.textContent = iv.label; }
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
            lt(custom, kind === 'script' ? 'ajob.f.custom_ph_script' : 'ajob.f.custom_ph', null, 'placeholder');
            custom.style.display = 'none';
            rowI.appendChild(custom);
        }

        var timeRow = document.createElement('div');
        timeRow.className = 'si';
        var timeLbl = document.createElement('span');
        timeLbl.className = 'sx';
        lt(timeLbl, 'ajob.f.at');
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
        lt(polLbl, 'ajob.policy.label');
        lt(polLbl, POLICY_TIP, null, 'title');
        polRow.appendChild(polLbl);
        var pb = {};
        [['silent', 'ajob.policy.silent', 'ajob.f.silent_tip'],
         ['result', 'ajob.policy.result', 'ajob.f.result_tip'],
         ['progress', 'ajob.policy.progress', 'ajob.f.progress_tip']].forEach(function (m) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'vagent-ivl';
            lt(b, m[1]);
            lt(b, m[2], null, 'title');
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
        lt(autoLab, AUTOAPPR_TIP, null, 'title');
        var autoCb = document.createElement('input');
        autoCb.type = 'checkbox';
        autoLab.appendChild(autoCb);
        // a span, not a text node: the label also holds the checkbox
        var autoTxt = document.createElement('span');
        lt(autoTxt, 'ajob.f.auto');
        autoLab.appendChild(document.createTextNode(' '));
        autoLab.appendChild(autoTxt);
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
            lt(ta, k === 'script' ? 'ajob.f.ph_script' : 'ajob.f.ph_prompt', null, 'placeholder');
            lt(hint, k === 'script' ? 'ajob.f.hint_script' : 'ajob.f.hint_prompt');
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
        lt(ok, 'ajob.f.create');
        var msg = document.createElement('span');
        msg.className = 'sx';
        rowB.appendChild(ok); rowB.appendChild(msg);
        body.appendChild(rowB);
        form.appendChild(body);

        toggle.addEventListener('click', function () {
            var open = body.style.display === 'none';
            body.style.display = open ? '' : 'none';
            lt(toggle, open ? 'ajob.f.close' : 'ajob.f.new');
            if (open) { ta.focus(); }
        });

        ok.addEventListener('click', function () {
            var text = ta.value.trim();
            if (!text) {
                lt(msg, kind === 'script' ? 'ajob.f.empty_script' : 'ajob.f.empty');
                return;
            }
            var every = 0, at = null;
            if (when === 'every') {
                every = chosen || parseInterval(custom.value, kind === 'script');
                if (kind === 'script' ? (!every || every < 1) : (!every || every < 60)) {
                    lt(msg, kind === 'script' ? 'ajob.f.min_s' : 'ajob.f.min_min');
                    return;
                }
            } else if (when === 'daily') {
                at = timeIn.value || '';
                if (!/^\d{2}:\d{2}$/.test(at)) { lt(msg, 'ajob.f.time'); return; }
            }
            var whenPayload = when === 'now' ? 'now'
                : when === 'every' ? {every_s: every} : {at_hhmm: at};
            var payload = {kind: kind, when: whenPayload, report_policy: policy, author: author};
            if (autoCb.checked) { payload.auto_approve = true; }
            if (kind === 'script') { payload.description = text; } else { payload.text = text; }
            ok.disabled = true;
            lt(msg, 'ajob.f.creating');

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
                if (!d || d.ok === false) { lt(msg, 'ajob.failed', {err: (d && d.error) || '?'}); return; }
                unifiedOk = true;
                createdMsg(msg);
                if (d.ref) { msg.appendChild(refBtnFor(d.ref)); }
                ta.value = '';
                optimistic(d.ref || 'j:new');
                pollUnified();
            }).catch(function (e) {
                ok.disabled = false;
                if (!/HTTP 404/.test(String(e))) { lt(msg, 'ajob.failed', {err: String(e)}); return; }
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
            lt(msg, 'ajob.f.sent_legacy');
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
            if (!d || d.ok === false) { lt(msg, 'ajob.failed', {err: (d && d.error) || '?'}); return; }
            createdMsg(msg);
            if (d.job_id) { msg.appendChild(refBtnFor('j:' + d.job_id)); }
            ta.value = '';
            optimistic('s:' + d.id);
            pollUnified();
        }).catch(function (e) {
            lt(msg, 'ajob.failed', {err: String(e)});
        });
    }

    /* „created →#12": the words in a span of their own (they follow the
       language), the ref button appended after them */
    function createdMsg(msg) {
        ltOff(msg);
        msg.textContent = '';
        var w = document.createElement('span');
        lt(w, 'ajob.f.created');
        msg.appendChild(w);
        msg.appendChild(document.createTextNode(' '));
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
        /* `keep_error_body` matters more here than anywhere else in the panel.
           A refused decision answers 403 and puts the WHOLE reason in the
           body; without this flag api() throws on the status code alone and
           the reason is gone. That is how Approve/Deny looked "dead" for
           three days (2026-09-02): the agent was answering "chybí
           /etc/vitulus/approval_tokens" and the panel was printing "agent
           unreachable", which sent the owner looking at the wrong thing. */
        api('/api/approvals/decide', {body: body, keep_error_body: true})
            .then(function (d) {
                var good = !!(d && d.ok);
                if (good) { decidedAsks[item.id] = 1; }
                askOutcomes[item.id] = {
                    ok: good,
                    text: good ? [d.message, d.note].filter(Boolean).join(' ')
                        : ((d && d.error) || _t('appr.err.not_accepted')),
                    until: Date.now() + 12000
                };
                pollApprovals();
            }).catch(function (err) {
                askOutcomes[item.id] = {
                    ok: false,
                    text: decideError(err),
                    until: Date.now() + 20000
                };
                renderApprovals(lastAsks);
            });
    }

    /* One sentence for a decision that did not go through — the agent's own
       words whenever it said any, our guess only when it said nothing. */
    function decideError(err) {
        var body = err && err.body;
        if (body && body.error) { return String(body.error); }
        if (err && err.status) {
            return _t('appr.err.refused', {status: err.status});
        }
        return _t('appr.err.unreachable');
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

    // chip / sec are i18n keys
    var ASK_KIND = {
        plan:    {chip: 'appr.kind.plan',    icon: '▤', cls: 'k-plan',   sec: 'appr.sec.plan'},
        command: {chip: 'appr.kind.command', icon: '❯', cls: 'k-cmd',    sec: 'appr.sec.command'},
        resume:  {chip: 'appr.kind.resume',  icon: '▶', cls: 'k-resume', sec: 'appr.sec.brief'}
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
        if (s < 60) { return _t('appr.age', {t: s + ' s'}); }
        if (s < 3600) { return _t('appr.age', {t: Math.round(s / 60) + ' min'}); }
        return _t('appr.age', {t: Math.floor(s / 3600) + ' h'});
    }

    /* „práce #147 (…)" is the job itself asking — say so short, the source
       line already carries the goal. */
    function askWho(item) {
        var m = /^prác[ei]\s*#(\d+)/i.exec(String(item.asker || ''));
        if (m) { return _t('appr.who.job', {n: m[1]}); }
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

    /* Would granting this ask make the robot MOVE?
       Robert, 2026-08-30: „robot by nemel vyjizdet pokud mu to nepovolim ja.
       Ja osobne" — so a request that can move the machine must never look
       like the routine ones.  This is a UI guard, deliberately generous
       (a false positive costs one extra tap, a false negative costs a robot
       leaving the dock): it reads the ask's own words, in both languages.
       It does NOT replace the core's refusal list — see the report: today
       `shellgate.never_asks` covers the mower and the safety layer, but NOT
       driving, so auto-approve can still pass a movement request. */
    var MOVE_RE = new RegExp(
        'undock|\\bdock\\b|vyjed|vyjeď|vyjet|vyjizd|vyjížd|zajed|zajeď|' +
        'jed\\b|jeď|jezd|pojed|pojeď|projed|projeď|rozjed|rozjeď|' +
        'drive|driving|move_base|movebase|cmd_vel|navigate|navigac|' +
        'goal|waypoint|trasa|trasu|objed|objeď|zahrad|garden|patrol|' +
        'motor_power|motor power|pohon|undocking|mow|sekac|sekač|sekat|' +
        'program\\s*#?\\d', 'i');

    function askMoves(item) {
        var d = item.detail || {};
        var p = d.payload || {};
        var blob = [item.command, item.plain, item.reason, d.what,
                    d.action_on_approve, p.text, item.job_title,
                    (d.context || {}).job_goal].join(' ');
        return MOVE_RE.test(String(blob));
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
            // one sentence per variant: word order differs between languages
            var pk = 'appr.say.plan' + (title ? '_title' : '') + (n ? '_job' : '');
            out = {text: _t(pk, {who: askAgent(item), title: title, n: n})};
        } else if (kind === 'resume') {
            if (n) {
                out = {text: _t(state === 'blocked' ? 'appr.say.resume_stuck'
                                                    : 'appr.say.resume_still', {n: n})};
            }
        } else {
            var cmd = payload.text || item.command || '';
            if (cmd) {
                out = {text: _t('appr.say.command') + ' ',
                       code: headCut(cmd, 78)};
            }
        }
        if (!out || !out.text) {
            out = {text: d.what || item.plain || item.command
                   || _t('appr.say.waiting')};
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
        hint.textContent = _t('appr.show');
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
        chip.textContent = K.icon + ' ' + _t(K.chip);
        head.appendChild(chip);
        var pills = document.createElement('span');
        pills.className = 'ahp';
        askPill(pills, askAge(item.waiting_s));
        if (item.left_text) {
            askPill(pills, _t('appr.autodeny', {t: item.left_text}), 'warn');
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
            jb.title = goal ? _t('appr.open_goal', {ref: jobRef, goal: goal})
                : _t('appr.open', {ref: jobRef});
            jb.addEventListener('click', function () { highlightJob(jobRef); });
            src.appendChild(jb);
        } else if (ctx.incident_id || item.incident_id) {
            var inc = document.createElement('span');
            inc.className = 'asrct';
            inc.textContent = _t('ajob.c.incident', {id: ctx.incident_id || item.incident_id});
            src.appendChild(inc);
        }
        var by = document.createElement('span');
        by.className = 'aby';
        by.textContent = _t((ctx.job_state || item.job_state) === 'blocked'
            ? 'appr.by_parked' : 'appr.by', {who: askWho(item)});
        by.title = item.asker || 'Hermes';
        src.appendChild(by);
        row.appendChild(src);

        // ---- 2. the ask, in one plain sentence ---------------------------
        var moves = askMoves(item);
        if (moves) {
            row.classList.add('moves');
            var mv = document.createElement('div');
            mv.className = 'amove';
            mv.textContent = _t('appr.move.banner');
            mv.title = _t('appr.move.tip');
            row.appendChild(mv);
        }
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
        yes.className = 'ay' + (moves ? ' moves' : '');
        yes.type = 'button';
        yes.textContent = moves ? _t('appr.move.allow') : _t('appr.approve');
        yes.title = moves
            ? _t('appr.move.allow_tip', {id: item.id})
            : _t('appr.approve_tip', {id: item.id});
        if (moves) {
            // The irreversible half of the card is the one that gets the
            // second tap; Deny has had one all along.
            var yArmed = false, yTimer = null;
            yes.addEventListener('click', function () {
                if (!yArmed) {
                    yArmed = true;
                    yes.textContent = _t('appr.move.confirm');
                    yes.classList.add('armed');
                    yTimer = setTimeout(function () {
                        yArmed = false;
                        yes.textContent = _t('appr.move.allow');
                        yes.classList.remove('armed');
                    }, 6000);
                    return;
                }
                if (yTimer) { clearTimeout(yTimer); }
                decideAsk(item, true, row, execChoice);
            });
        } else {
            yes.addEventListener('click', function () {
                decideAsk(item, true, row, execChoice);
            });
        }
        act.appendChild(yes);
        var no = document.createElement('button');
        no.className = 'an';
        no.type = 'button';
        no.textContent = _t('appr.deny');
        no.title = _t('appr.deny_tip', {id: item.id});
        var armed = false, armTimer = null;
        no.addEventListener('click', function () {
            if (!armed) {                       // inline confirm, one tap more
                armed = true;
                no.textContent = _t('appr.deny_really');
                no.classList.add('armed');
                armTimer = setTimeout(function () {
                    armed = false;
                    no.textContent = _t('appr.deny');
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
            el.textContent = _t('appr.via');
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
                    (ex.id === d.recommended ? ' ' + _t('appr.recommended') : '');
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
                    _t(K.sec) + ' · ' + _tn('appr.words', words), false);
                var pre = document.createElement('pre');
                pre.className = 'apre' +
                    (payload.kind === 'command' ? ' mono' : '');
                pre.textContent = payload.text;
                sec.appendChild(pre);
                if (payload.truncated) {
                    var more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'amore';
                    more.textContent = _t('appr.show_full');
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
                var csec = askSection(item, 'ctx', _t('appr.sec.context'), false);
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
                    ctx.job_state ? _t('appr.ctx.state', {s: ctx.job_state}) : '',
                    ctx.legs ? _t('ajob.c.legs', {n: ctx.legs}) : ''
                ].filter(Boolean).join(' · ');
                if (facts.textContent) { csec.appendChild(facts); }
                if (ctx.last_error) {
                    var er = document.createElement('div');
                    er.className = 'actx err';
                    er.textContent = _t('appr.ctx.last_error', {err: ctx.last_error});
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
                var wsec = askSection(item, 'what', _t('appr.sec.what'), false);
                askLine(wsec, 'awhat', _t('appr.l.request'), d.what);
                askLine(wsec, 'awhy', _t('appr.l.why'), d.why);
                askLine(wsec, 'ayes', _t('appr.l.on_approve'), d.action_on_approve);
                askLine(wsec, 'ano', _t('appr.l.on_deny'), d.action_on_deny);
                det.appendChild(wsec);
                any = true;
            }

            if (d.risk && d.risk.length) {
                var rsec = askSection(item, 'risk',
                    _t('appr.sec.risk', {n: d.risk.length}), false);
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
            var lsec = askSection(item, 'payload', _t('appr.sec.command'), false);
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
            // anything that can move the machine sits at the very top of the
            // pinned cards — that decision is the owner's alone
            var ma = askMoves(a) ? 0 : 1;
            var mb = askMoves(b) ? 0 : 1;
            if (ma !== mb) { return ma - mb; }
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
            /* A refusal arrives as two lines („Rozhodnutí odmítnuto" +
               „Důvod: …") and the second one is the whole message. Without
               this the browser folds them into one run and the reason ends up
               far off the right edge on a phone. */
            line.classList.add('vt-pre');
            row.appendChild(line);
            gateBody.appendChild(row);
            shown += 1;
        });
        if (!shown) {
            var e = document.createElement('div');
            e.className = 'vagent-empty';
            e.textContent = _t('appr.empty');
            gateBody.appendChild(e);
        }
        // Pinned at the top of Work: it must take no room when it is empty.
        var pin = gateBody.parentNode;
        if (pin && pin.classList && pin.classList.contains('vagent-pinned')) {
            pin.style.display = shown ? '' : 'none';
        }
    }

    /* U44: `/api/approvals` had TWO owners — this one, for the strip, and a
       second fetch inside the closed-panel badge poll that asked the same
       question 1 ms later just to count the answers.  Two answers about one
       thing means the bar and the button can disagree, and they were only
       ever going to disagree at the worst moment.  There is now exactly one
       fetch, and everything that needs approvals (the strip, the Work pane,
       the unread badge) reads THAT answer.

       The cadence is the core's to set: it sends `poll_after_s`, and the
       panel obeys that one number instead of keeping a clock of its own.
       The panel only ever makes it SLOWER — a shut panel and a background
       tab are not worth the robot's CPU. */
    var approvalsAfterMs = 3000;     // until the core says otherwise
    var approvalsTimer = null;

    function pollApprovals() {
        return api('/api/approvals').then(function (d) {
            stripAsks = (d && d.approvals) || [];
            /* U2 I1: the shared hub gets the SAME list (one poller, U44);
               the Needs you panel reads it from there */
            if (window.VTHub) {
                window.VTHub.put("agent.asks",   // a hub key, not i18n (double quotes: test_i18n)
                stripAsks.map(function (a) {
                    return {id: a.id, what: (a.detail && a.detail.what) || a.plain || a.command || '',
                            waiting_s: a.waiting_s, moves: !!askMoves(a)};
                }));
            }
            /* Work that needs a HUMAN and is not an approval (a mission
               waiting for the dock to be unlocked, a parked job, a failure
               only a person can fix) — the core decides (attention.py), the
               same answer feeds the bell. */
            if (window.VTHub && d && Array.isArray(d.needs_you)) {
                window.VTHub.put("agent.needs", d.needs_you);   // a hub key, not i18n
            }
            var after = d && Number(d.poll_after_s);
            if (after && !isNaN(after)) {
                approvalsAfterMs = Math.min(120000, Math.max(2000, after * 1000));
            }
            renderApprovals(stripAsks);
            paintStrip();
            // the badge counts the SAME list the strip drew — U44
            if (!panelActive && stripAsks.length && !unread) {
                unread = stripAsks.length;
                paintBadge();
            }
        }).catch(function () {});
    }

    function scheduleApprovals() {
        if (approvalsTimer) { clearTimeout(approvalsTimer); approvalsTimer = null; }
        var wait = approvalsAfterMs;
        if (!panelActive) { wait = Math.max(wait, 30000); }
        else if (document.hidden) { wait = Math.max(wait, BG_MS); }
        approvalsTimer = setTimeout(function () {
            approvalsTimer = null;
            if (agentUp !== true) { scheduleApprovals(); return; }
            pollApprovals().then(scheduleApprovals, scheduleApprovals);
        }, wait);
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
    var paintStatusStrip = null;
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
            strip.appendChild(chip(_t('agent.st.bat'), pct != null ? Math.round(pct) + ' %' : '–',
                pct == null ? '' : pct > 50 ? 'good' : pct > 20 ? 'warn' : 'bad'));
            var rtk = st.rtk && typeof st.rtk === 'object' ? st.rtk.fix : st.rtk;
            strip.appendChild(chip('RTK', rtk || '–',
                rtk === 'fixed' ? 'good' : rtk === 'float' ? 'warn' :
                rtk ? 'bad' : ''));
            strip.appendChild(chip(_t('agent.st.dock'), st.in_dock === true ? _t('agent.st.yes')
                : st.in_dock === false ? _t('agent.st.no') : '–'));
            strip.appendChild(chip(_t('agent.st.motors'), st.motor_power === true ? _t('agent.st.on')
                : st.motor_power === false ? _t('agent.st.off') : '–'));
            var coreOk = !!(h && h.ok);
            strip.appendChild(chip(_t('agent.st.core'), coreOk ? 'ok' : '–',
                coreOk ? 'good' : 'bad'));
        }
        document.addEventListener('vagent:state', paint);
        document.addEventListener('vagent:health', paint);
        paintStatusStrip = paint;     // the language switch repaints it
        paint();
    }

    function pollHealth() {
        return api('/api/health').then(function (d) {
            sharedState.health = d || null;
            document.dispatchEvent(new CustomEvent('vagent:health', {detail: sharedState}));
        }).catch(function () {});
    }

    // ==================================================== the dock lock
    /* Robert, 2026-08-30: „Dokovy zamek muzu odemknout jen ja kliknutim v ui.
       jestli to agent obejde? At ma jasne stanovene, ze takova narizeni nesmi
       obchazet."

       So this panel is the ONLY place the lock opens, and what it grants is a
       single named action for a few minutes, not a mode.  The core enforces
       it (`v2/ros_wire.check()` refuses every moving action without a live
       row in `dock_release`); everything here is the human half: say exactly
       what is being allowed, take a second tap for it, show it while it lasts,
       and give one click to take it back.  The countdown below is DISPLAY
       ONLY — expiry, the use count and the signature are decided in the core,
       which is the half the agent cannot reach. */
    var dockState = {supported: null, locked: true, release: null, ts: 0};
    var dockEl = null;

    /* Two grants, both NAMED — the release is a list of action ids and the
       core refuses `*`, `all` and `any` (ros_wire `_release_from_row`), so the
       card lists the actions themselves rather than saying "allow movement".
       Two, not one, because one departure alone strands the robot outside:
       coming home is `dock.start`, and that is movement too. */
    /* button / title / lines are i18n keys; the getters below hand callers
       (agent_blocks.js renders the card) the text in the current language */
    /* action ids in double quotes: they are ids of the core's lock, and
       test_i18n reads every single-quoted area.word as an i18n key */
    var DOCK_GRANTS = [{
        /* 2026-10-18, the owner: „Chci dock unlock, který bude na cokoliv
           a zapne se zas až tím, že robot zajede do docku."  Still NAMED:
           the core writes the full list of guarded actions from its signed
           registry (ros_wire.free_drive_actions — this list is what the card
           shows and the webnode lets through), no use limit, and the core
           locks it again by itself once the robot has left the dock and is
           back in it (v2/dock_relock).  12 h stays as the safety cap. */
        key: 'free',
        until_docked: true,
        /* 18. 10. evening, the owner: „Přidej agentovi všechny akce, a to
           i převzetí gamepadem" — direct driving (drive.*, through the
           cmd_vel_mux `primitive` input, always under the gamepad and the
           web joystick) and saved mowing programs are moves too.  The blade
           is never an action: only a saved program runs it. */
        actions: ["dock.start", "dock.start_modality", "dock.undock",
                  "drive.rotate", "drive.straight", "drive.velocity",
                  "map.new", "map.save", "map.session_start", "map.session_stop",
                  "motor.on", "mower.program_resume", "mower.program_run",
                  "nav.backup", "nav.execute_path", "nav.goto_offset",
                  "nav.goto_waypoint", "nav.goto_xy"],
        minutes: 720,
        max_runs: null,
        primary: true,
        button: 'agent.dock.free.button',
        title: 'agent.dock.free.title',
        lines: [
            ['agent.dock.l.actions', 'agent.dock.free.actions'],
            ['agent.dock.l.not', 'agent.dock.free.not'],
            ['agent.dock.l.uses', 'agent.dock.free.uses'],
            ['agent.dock.l.locks', 'agent.dock.free.locks'],
            ['agent.dock.l.signed', 'agent.dock.free.signed']
        ]
    }, {
        /* 2026-10-18: the owner stands at the robot and wants the agent to
           do a test drive — undock, drive to a waypoint, wait, dock back.
           Those are THREE moving actions in one mission, and each phase
           spends one use (`ros_wire.guard`), so one tap has to cover all of
           them with room for a retry.  `motor.on` is in the list because it
           counts as movement while a navigation goal is pending (B13); when
           nothing is pending it never spends a use. */
        key: 'test',
        /* The mission's recovery (recovery.CATALOGUE) backs off an obstacle,
           turns, takes a detour point or docks by another modality — each
           of those is a move and spends a use, so the test drive covers them
           and has room for them. */
        actions: ["dock.undock", "nav.goto_waypoint", "dock.start", "motor.on",
                  "nav.backup", "drive.rotate", "drive.straight", "nav.goto_xy",
                  "nav.goto_offset", "dock.start_modality"],
        minutes: 45,
        max_runs: 12,
        button: 'agent.dock.test.button',
        title: 'agent.dock.test.title',
        lines: [
            ['agent.dock.l.actions', 'agent.dock.test.actions'],
            ['agent.dock.l.not', 'agent.dock.test.not'],
            ['agent.dock.l.valid', 'agent.dock.test.valid'],
            ['agent.dock.l.uses', 'agent.dock.test.uses'],
            ['agent.dock.l.signed', 'agent.dock.test.signed']
        ]
    }, {
        /* 18. 10.: a saved mowing program, started the way the Run / Resume
           buttons of the program card start it (/web_plan/program_select).
           The program undocks, mows and docks back by itself; the blade runs
           only inside it, and the supervisor's mowing run stops it on STOP,
           a takeover or a lost heartbeat. */
        key: 'mow',
        actions: ["mower.program_run", "mower.program_resume", "motor.on"],
        minutes: 60,
        max_runs: 3,
        button: 'agent.dock.mow.button',
        title: 'agent.dock.mow.title',
        lines: [
            ['agent.dock.l.actions', 'agent.dock.mow.actions'],
            ['agent.dock.l.not', 'agent.dock.mow.not'],
            ['agent.dock.l.valid', 'agent.dock.mow.valid'],
            ['agent.dock.l.uses', 'agent.dock.mow.uses'],
            ['agent.dock.l.stops', 'agent.dock.mow.stops'],
            ['agent.dock.l.signed', 'agent.dock.mow.signed']
        ]
    }, {
        key: 'out',
        actions: ["dock.undock"],
        minutes: 15,
        max_runs: 1,
        button: 'agent.dock.out.button',
        title: 'agent.dock.out.title',
        lines: [
            ['agent.dock.l.actions', 'agent.dock.out.actions'],
            ['agent.dock.l.not', 'agent.dock.out.not'],
            ['agent.dock.l.valid', 'agent.dock.out.valid'],
            ['agent.dock.l.uses', 'agent.dock.out.uses'],
            ['agent.dock.l.signed', 'agent.dock.out.signed']
        ]
    }, {
        key: 'round',
        actions: ["dock.undock", "dock.start"],
        minutes: 30,
        max_runs: 2,
        button: 'agent.dock.round.button',
        title: 'agent.dock.round.title',
        lines: [
            ['agent.dock.l.actions', 'agent.dock.round.actions'],
            ['agent.dock.l.not', 'agent.dock.round.not'],
            ['agent.dock.l.valid', 'agent.dock.round.valid'],
            ['agent.dock.l.uses', 'agent.dock.round.uses'],
            ['agent.dock.l.signed', 'agent.dock.round.signed']
        ]
    }];
    DOCK_GRANTS.forEach(function (g) { g.ttl_s = g.minutes * 60; });
    DOCK_GRANTS.forEach(function (g) {
        var kb = g.button, kt = g.title, kl = g.lines;
        Object.defineProperty(g, 'button', {enumerable: true, get: function () { return _t(kb); }});
        Object.defineProperty(g, 'title', {enumerable: true, get: function () { return _t(kt); }});
        Object.defineProperty(g, 'lines', {enumerable: true, get: function () {
            return kl.map(function (pair) { return [_t(pair[0]), _t(pair[1])]; });
        }});
    });

    function dockRelease() { return dockState.release || null; }

    function dockLeft(rel) {
        if (!rel || !rel.until) { return 0; }
        return Math.max(0, rel.until - Date.now() / 1000);
    }

    function mmss(sec) {
        sec = Math.max(0, Math.round(sec));
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec - h * 3600) / 60);
        var ss = ('0' + (sec - h * 3600 - m * 60)).slice(-2);
        if (h) { return h + ':' + ('0' + m).slice(-2) + ':' + ss; }
        return m + ':' + ss;
    }

    /* Free drive (until_docked) has no use limit: the robot coming home
       ends it, not a count. */
    function dockUsesLeft(rel) {
        if (!rel) { return 0; }
        if (rel.until_docked) { return Infinity; }
        return Math.max(0, (rel.max_runs || 1) - (rel.used || 0));
    }

    function announceDock() {
        document.dispatchEvent(new CustomEvent('vagent:dock', {detail: dockState}));
        paintUnlocked();
    }

    /* The release the lock honours is the NEWEST valid row (ros_wire
       `_db_release`), which is `active[0]` of GET /api/v2/dock.  `until` is
       rebuilt from `left_s` on THIS browser's clock (the phone's clock is not
       the robot's), so the countdown is honest even with a skewed clock. */
    function dockFromV2(d) {
        var a = (d && d.active && d.active[0]) || null;
        if (!a) { return null; }
        var at = (d.__at || Date.now()) / 1000;
        return {id: a.id, row_id: a.id, actions: a.actions || [],
                until: at + Math.max(0, +a.left_s || 0),
                max_runs: a.max_runs, used: a.used || 0, by: a.by,
                channel: a.channel, note: a.note,
                until_docked: !!a.until_docked,
                left_dock_ago: a.left_dock ? Math.max(0, (d.ts || 0) - a.left_dock) : null};
    }

    /* The newest release the core locked again by itself (robot docked),
       for the note on the locked card. */
    function dockAutoRelocked(d) {
        var r = ((d && d.recent) || []).filter(function (x) {
            return x && x.revoked_note && /robot docked/.test(x.revoked_note);
        })[0];
        if (!r || !r.revoked) { return null; }
        var ago = Math.max(0, (d.ts || 0) - r.revoked);
        if (ago > 12 * 3600) { return null; }
        return {id: r.id, at: Date.now() - ago * 1000, note: r.revoked_note};
    }

    function pollDock(force) {
        // „not served yet" is a statement about a moment, not a verdict: the
        // endpoint can land while the page is open, so opening the tab asks
        // again even after a 404.
        if (dockState.supported === false && !force) { return Promise.resolve(); }
        return api('/api/v2/dock').then(function (d) {
            if (!d || d.agent_down) { return; }
            if (d.ok === false && !d.active) {
                dockState.supported = /not found|404/i.test(String(d.error || ''))
                    ? false : dockState.supported;
                dockState.error = d.error || null;
                announceDock(); return;
            }
            dockState.supported = true;
            dockState.error = null;
            dockState.release = dockFromV2(d);
            dockState.relocked = dockAutoRelocked(d);
            dockState.locked = !dockState.release;
            dockState.ts = Date.now();
            announceDock();
        }).catch(function (e) {
            if (/HTTP 404/.test(String(e))) {
                dockState.supported = false;      // core does not serve it yet
                announceDock();
            }
        });
    }

    /* The webnode door that adds the owner's proof (webnode /agent-dock/*):
       same origin, JSON, X-Vitulus-UI.  NOT api() — /agent/* forwards no
       token, so the core would rightly answer 403 there. */
    function dockWrite(path, body) {
        if (window.VTMock && window.VTMock.blocks('POST', path)) {   // ?mock: never unlock / relock
            return Promise.reject(new Error('blocked in ?mock'));
        }
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 15000) : null;
        return fetch(path, {
            method: 'POST', cache: 'no-store', credentials: 'same-origin',
            signal: ctl ? ctl.signal : undefined,
            headers: {'Content-Type': 'application/json', 'X-Vitulus-UI': '1'},
            body: JSON.stringify(body || {})
        }).then(function (r) {
            if (timer) { clearTimeout(timer); }
            return r.json().catch(function () { return null; }).then(function (d) {
                if (!r.ok) {
                    return {ok: false, error: (d && d.error) || ('HTTP ' + r.status)};
                }
                return d || {ok: false, error: _t('agent.dock.err.empty')};
            });
        }, function (e) {
            if (timer) { clearTimeout(timer); }
            return {ok: false, error: (window.VTMock && VTMock.on)
                ? _t('agent.dock.err.mock')
                : String((e && e.message) || e)};
        });
    }

    /* The grant itself.  Never called without a second tap in the card. */
    function dockUnlock(grant, note) {
        grant = grant || DOCK_GRANTS[0];
        var body = {
            actions: grant.actions,
            minutes: grant.minutes,
            note: note || ('granted in the panel (' + grant.key + '): ' +
                           grant.actions.join(', '))
        };
        // Free drive carries no use count: it ends when the robot docks.
        if (grant.until_docked) { body.until_docked = true; }
        else { body.max_runs = grant.max_runs; }
        return dockWrite('/agent-dock/grant', body).then(function (d) {
            if (d && d.ok !== false && d.id) {
                return pollDock(true).then(function () { return d; });
            }
            return d;
        });
    }

    function dockRelock() {
        var rel = dockRelease();
        if (!rel || !rel.id) { return pollDock(true); }
        return dockWrite('/agent-dock/revoke/' + encodeURIComponent(rel.id), {})
            .then(function (d) {
                if (!d || d.ok === false) {
                    notify('report', 'Dock not locked again: ' + ((d && d.error) || '?'));
                    throw new Error((d && d.error) || 'relock refused');
                }
                return pollDock(true).then(function () { return d; });
            });
    }

    /* Open the Dock lock card (Robot tab) — from a mission that waits for it,
       or from the UNLOCKED bar.  With `key`, go straight to that grant's
       scope card so the owner reads it and taps twice. */
    function openDock(key) {
        openPanel();
        activateTab('robot');
        document.dispatchEvent(new CustomEvent('vagent:dock-open',
            {detail: {key: key || null}}));
    }

    /* Always visible while anything is unlocked — the owner must never have
       to open a tab to find out that the dock is open, and taking it back is
       one click from wherever he is. */
    var unlockedEl = null;
    function paintUnlocked() {
        if (!unlockedEl) { return; }
        var rel = dockRelease();
        var live = rel && dockLeft(rel) > 0 && dockUsesLeft(rel) > 0;
        if (!live) {
            unlockedEl.style.display = 'none';
            unlockedEl.textContent = '';
            layoutBars();
            return;
        }
        unlockedEl.textContent = '';
        var lab = document.createElement('span');
        lab.className = 'vs-lab';
        lab.textContent = _t('agent.dock.bar.label');
        unlockedEl.appendChild(lab);
        var txt = document.createElement('span');
        txt.className = 'vs-txt';
        var n = dockUsesLeft(rel);
        txt.textContent = rel.until_docked
            ? _t('agent.dock.bar.free', {t: mmss(dockLeft(rel))})
            : _tn('agent.dock.bar.uses', n, {actions: (rel.actions || []).join(', '),
                                              t: mmss(dockLeft(rel))});
        unlockedEl.appendChild(txt);
        var back = document.createElement('button');
        back.type = 'button';
        back.className = 'vs-btn';
        back.textContent = _t('agent.dock.bar.lock');
        back.title = _t('agent.dock.bar.lock_tip');
        back.addEventListener('click', function (ev) {
            ev.stopPropagation();
            back.disabled = true;
            dockRelock().catch(function () { back.disabled = false; });
        });
        unlockedEl.appendChild(back);
        unlockedEl.style.display = '';
        layoutBars();
    }

    // ================================================ shell strip + now bar
    /* E8/2.  One row of chrome outside the panel, so the owner sees the one
       thing that needs him without opening anything.  It shows AT MOST ONE
       item, in this order:
           1. an approval is waiting        2. work is blocked
           3. a serious finding is open     4. what the agent is doing NOW
       and when there is none of those it has ZERO height (display:none), so
       nothing on the page moves.  The "now bar" (4) is the quiet one: verb +
       object + leg n/m + time, hard-cut to 60 characters. */
    var stripEl = null, stripText = null, stripFindings = [], stripAsks = [];
    var stripReadN;              // v2 „Read this" count (undefined = older core)
    var stripFp = '';
    var STRIP_CUT = 60;

    function cut(s, n) {
        s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        n = n || STRIP_CUT;
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    function shortAge(sec) {
        if (sec == null || !isFinite(sec)) { return ''; }
        if (sec < 90) { return Math.round(sec) + ' s'; }
        if (sec < 5400) { return Math.round(sec / 60) + ' min'; }
        if (sec < 172800) { return Math.round(sec / 3600) + ' h'; }
        return Math.round(sec / 86400) + ' d';
    }

    function legOf(job) {
        var leg = job.leg || 0;
        var legs = job.legs || 0;
        if (!leg && !legs) { return ''; }
        return legs && legs >= (leg || 0)
            ? _t('ajob.p.leg_of', {n: leg || legs, of: legs})
            : _t('ajob.p.leg', {n: leg || legs});
    }

    /* The one thing worth a row of screen, or null. */
    function stripPick() {
        if (stripAsks.length) {
            var a = stripAsks[0];
            for (var q = 0; q < stripAsks.length; q++) {
                if (askMoves(stripAsks[q])) { a = stripAsks[q]; break; }
            }
            var what = (a.detail && a.detail.what) || a.plain || a.command || '';
            if (askMoves(a)) {
                return {kind: 'move', tab: 'work',
                        label: _t('appr.strip.move'),
                        text: cut(what, 40),
                        age: shortAge(a.waiting_s)};
            }
            return {kind: 'ask', tab: 'work',
                    label: stripAsks.length > 1
                        ? _t('appr.strip.many', {n: stripAsks.length})
                        : _t('appr.strip.one'),
                    text: cut(what, 44),
                    age: shortAge(a.waiting_s)};
        }
        var jobs = barJobs();
        var blocked = null, running = null;
        for (var i = 0; i < jobs.length; i++) {
            var j = jobs[i];
            if (!blocked && (j.state === 'blocked' || j.state === 'waiting' ||
                    j.stalled)) { blocked = j; }
            if (!running && j.state === 'running') { running = j; }
        }
        if (blocked) {
            return {kind: 'blocked', tab: 'work', jobId: blocked.id,
                    label: _t(blocked.stalled && blocked.state !== 'blocked'
                        ? 'ajob.strip.stalled' : 'ajob.strip.blocked', {id: blocked.id}),
                    text: cut(blocked.blocked || blocked.error || blocked.last ||
                              blocked.text, 44),
                    age: shortAge(blocked.elapsed_s)};
        }
        /* Findings light the strip only when one asks for the OWNER („Read
           this", v2 records) — an open, even high, finding the agent is still
           analysing or has handled wants nobody.  An older core without the
           count keeps the old open+high rule. */
        if (typeof stripReadN === 'number') {
            if (stripReadN > 0) {
                return {kind: 'finding', tab: 'findings',
                        label: _t('agent.strip.finding'),
                        text: _t('agent.strip.read_n', {n: stripReadN}), age: ''};
            }
        }
        var hot = null;
        for (var k = 0; k < stripFindings.length && typeof stripReadN !== 'number'; k++) {
            var f = stripFindings[k];
            if (f.state === 'open' && f.severity === 'high') { hot = f; break; }
        }
        if (hot) {
            return {kind: 'finding', tab: 'findings',
                    label: _t('agent.strip.finding'),
                    text: findingTitle(hot) + (hot.count > 1 ? ' · ' + hot.count + '×' : ''),
                    age: shortAge(hot.last_seen ? (Date.now() / 1000 - hot.last_seen) : null)};
        }
        if (running) {
            // now bar: verb + object + leg n/m + time
            return {kind: 'now', tab: 'work', jobId: running.id,
                    label: '',
                    text: cut((running.phase_title || running.last || running.text ||
                               _t('ajob.strip.working')) + '', STRIP_CUT - 18),
                    meta: [legOf(running), shortAge(running.elapsed_s)]
                        .filter(Boolean).join(' · ')};
        }
        return null;
    }

    function installStrip() {
        if (document.getElementById('vagent_bars')) { return; }
        barsEl = document.createElement('div');
        barsEl.id = 'vagent_bars';
        panicEl = document.createElement('div');
        panicEl.id = 'vagent_panic';
        panicEl.setAttribute('role', 'alert');
        panicEl.style.display = 'none';
        barsEl.appendChild(panicEl);
        unlockedEl = document.createElement('div');
        unlockedEl.id = 'vagent_unlocked';
        unlockedEl.setAttribute('role', 'status');
        unlockedEl.style.display = 'none';
        barsEl.appendChild(unlockedEl);
        stripEl = document.createElement('div');
        stripEl.id = 'vagent_strip';
        stripEl.setAttribute('role', 'status');
        stripEl.style.display = 'none';
        stripEl.addEventListener('click', function () {
            var pick = stripPick();
            openPanel();
            if (pick) {
                activateTab(pick.tab);
                if (pick.jobId) { highlightJob(pick.jobId); }
            }
        });
        barsEl.appendChild(stripEl);
        document.body.appendChild(barsEl);
        window.addEventListener('resize', layoutBars);
    }

    /* The bars float over the map, so nothing in the page reflows; the one
       thing they must not do is cover the floating map menu, so it steps
       down by exactly the height they take (zero when they are empty). */
    function layoutBars() {
        var rm = document.getElementById('row_menu');
        if (!rm || !barsEl) { return; }
        var h = barsEl.offsetHeight || 0;
        rm.style.marginTop = h ? h + 'px' : '';
    }

    /* E8/7 — the stuck-STOP banner.  `execute.panic_active()` is a latch: it
       holds until a human clears it, and while it holds the robot refuses to
       act.  Nothing in the UI said so.  The core does not serve it yet (see
       the report's "POŽADAVKY NA JÁDRO"), so this reads whatever exists —
       state.panic first, then /api/panic — and stays silent otherwise. */
    var panicEl = null, barsEl = null, panicSeen = null, panicProbe = true;

    function paintPanic() {
        if (!panicEl) { return; }
        var on = !!(panicSeen && panicSeen.active);
        if (!on) {
            panicEl.style.display = 'none';
            panicEl.textContent = '';
            layoutBars();
            return;
        }
        var by = panicSeen.by ? ' ' + _t('agent.panic.by', {who: panicSeen.by}) : '';
        var when = panicSeen.at
            ? ' · ' + _t('ajob.rel.ago', {t: shortAge(Date.now() / 1000 - panicSeen.at)}) : '';
        var txt = _t('agent.panic.text', {by: by, when: when});
        if (panicEl.textContent !== txt) { panicEl.textContent = txt; }
        panicEl.style.display = '';
        layoutBars();
    }

    function pollPanic() {
        var st = sharedState.robot;
        if (st && st.panic && typeof st.panic === 'object') {
            panicSeen = {active: !!st.panic.active, at: st.panic.at, by: st.panic.by};
            paintPanic();
            return;
        }
        if (!panicProbe) { return; }
        api('/api/panic').then(function (d) {
            if (!d || d.ok === false || d.agent_down) { return; }
            panicSeen = {active: !!(d.active || d.panic),
                         at: d.at || null, by: d.by || null};
            paintPanic();
        }).catch(function (e) {
            if (/HTTP 404/.test(String(e))) { panicProbe = false; }  // ask once
        });
    }

    function paintStrip() {
        if (!stripEl) { return; }
        var pick = stripPick();
        var fp = pick ? [pick.kind, pick.label, pick.text, pick.age, pick.meta].join('|') : '';
        if (fp === stripFp) { return; }
        stripFp = fp;
        stripEl.textContent = '';
        if (!pick) {
            stripEl.style.display = 'none';
            document.body.classList.remove('vagent-strip-on');
            layoutBars();
            return;
        }
        stripEl.className = 'va-' + pick.kind;
        var lab = document.createElement('span');
        lab.className = 'vs-lab';
        lab.textContent = pick.label || _t('agent.strip.now');
        stripEl.appendChild(lab);
        var txt = document.createElement('span');
        txt.className = 'vs-txt';
        txt.textContent = cut(pick.text, STRIP_CUT);
        stripEl.appendChild(txt);
        var right = pick.meta || pick.age;
        if (right) {
            var m = document.createElement('span');
            m.className = 'vs-meta';
            m.textContent = right;
            stripEl.appendChild(m);
        }
        stripEl.title = (pick.label ? pick.label + ' — ' : '') + pick.text +
            (right ? ' (' + right + ')' : '') + ' · ' + _t('agent.strip.tip');
        stripEl.style.display = '';
        document.body.classList.add('vagent-strip-on');
        layoutBars();
    }

    /* The strip must be right even with the panel shut, so it has a poller of
       its own — slow, two calls per minute, plus findings every 4th tick. */
    var stripTick = 0;
    function pollStrip() {
        if (agentUp !== true) { return; }
        stripTick += 1;
        // approvals are NOT fetched here any more: they have one owner and
        // one cadence (scheduleApprovals), which keeps running with the
        // panel shut. U44.
        if (!panelActive) { pollJobs(); }
        pollPanic();
        pollDock();            // the dock bar must be right with the panel shut
        if (stripTick % 4 === 1) {
            api('/api/doctor').then(function (d) {
                stripFindings = (d && d.findings) || [];
                var rn = d && d.counts && d.counts.read;
                stripReadN = (typeof rn === 'number') ? rn : undefined;
                paintStrip();
            }).catch(function () {});
        }
        paintStrip();
    }

    // ---------------------------------------------------------- scheduling
    /* One scheduler. While the panel is visible: tasks 2 s, jobs+approvals
       3 s, state 5 s, plus each registered block's own poll. While hidden:
       one light badge poll every 30 s (approval count + unseen reports), so a
       closed panel costs the robot's CPU nearly nothing. */
    var timers = [];
    var BG_MS = 15000;      // slow rate for an OPEN panel in a background tab

    /* An open panel keeps polling even when its tab is in the background —
       just slowly.  The old gate was `isVisible()`, i.e. panel open AND tab
       in front; a panel opened in a tab that is not the front one therefore
       polled nothing at all, which is exactly what "robot state unavailable
       while /api/state returns 97 %" was: the blocks' onOpen (map render)
       runs ungated, the pollers do not, so the map loaded and the state
       never did.  Cost of the background rate: one /api/state + /api/tasks
       per 15 s, which is what the closed-panel badge poll already spends. */
    function every(ms, fn) {
        var last = 0;
        timers.push(setInterval(function () {
            if (agentUp !== true || !panelActive) { return; }
            var now = Date.now();
            if (document.hidden && (now - last) < BG_MS) { return; }
            last = now;
            fn();
        }, ms));
    }

    function kickAll() {
        pollTasks(); pollJobs(); pollUnified(); pollApprovals();
        pollState(); pollHealth(); pollDock();
    }

    function schedule() {
        if (agentUp !== true) { return; }   // nothing polls a down/unknown agent
        if (timers.length) {         // already scheduled; just kick once
            if (panelActive) { kickAll(); scheduleApprovals(); }
            return;
        }
        every(2000, pollTasks);
        every(3000, pollJobs);
        scheduleApprovals();        // U44: approvals have their own, single,
                                    // core-paced loop — open panel or shut
        /* NOTE: the unified job list is polled in exactly ONE place — the
           `jobs` block's own poll, below (see U34).  There used to be a
           second, unconditional `every(10000, pollUnified)` here; while the
           block's poll was dead (U23, it hung on the pre-merge tab name)
           that one was carrying the list alone and nobody noticed the
           duplication.  Fixing U23 woke the second poller and the panel
           started asking the robot for the same list every ~4 s, measured.
           A machine at load 13 does not need the panel's help. */
        every(5000, function () { pollState(); pollHealth(); });
        every(5000, pollDock);
        // the countdown in the bar has to tick even between polls
        setInterval(function () { if (dockRelease()) { paintUnlocked(); } }, 1000);
        blocks.forEach(function (blk) {
            if (blk.poll && blk.poll.fn) { every(blk.poll.every_ms || 5000, blk.poll.fn); }
        });
        setInterval(function () {    // the closed-panel badge poll
            if (agentUp !== true || panelActive) { return; }
            var seenId = parseInt(lsGet(LS_SEEN) || '0', 10) || 0;
            api('/api/tasks?since_id=' + seenId).then(function (d) {
                emitTasks((d && d.tasks) || []);
                var fresh = ((d && d.tasks) || []).filter(function (t) {
                    return t.source === 'agent' && !t.quiet &&
                        (t.state === 'done' || t.state === 'failed');
                });
                if (fresh.length) {
                    unread = fresh.length;
                    paintBadge();
                }
            }).catch(function () {});
            /* U44: there used to be a second `/api/approvals` right here,
               1 ms after the strip's, only to count what the strip had
               already been told.  The badge now reads that same answer in
               pollApprovals(). One question, one answer. */
        }, 30000);
        setInterval(paintConn, 2000);
        if (panelActive) { kickAll(); }
    }

    // --------------------------------------------------- language switch
    /* Settings › App › Language switches live (docs/I18N.md).  Text drawn
       through lt() repaints itself (relangEls); what is drawn with _t() is
       drawn again from the last data — job cards, approval cards, the
       context bar, the shell strip, the dock bar.  Chat bubbles are not
       redrawn: their text is the conversation (data); a UI line written as
       a bubble (send failed, STOP) keeps the language it was drawn in. */
    function relang() {
        relangEls(document);
        relangTabs();
        if (syncPlaceholder) { syncPlaceholder(); }
        applyAgentState();
        paintConn();
        if (paintStatusStrip) { paintStatusStrip(); }
        jobCards = {};
        jobsFp = null;
        if (jobsListBox) { renderJobsPane(lastJobs, true); }
        lastAskFp = null;
        if (gateBody) { renderApprovals(lastAsks); }
        paintCtx();
        stripFp = '';
        paintStrip();
        paintUnlocked();
        paintPanic();
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

        /* U29: this emptied the chat and left no way back.  Measured: waiting
           through a poll, switching tabs, scrolling to the top — none of them
           brought a single bubble back; only a full page reload did.  The
           button's own tooltip promises the history is still on the robot,
           and it is — so the panel now offers to go and fetch it, one click,
           right where the history used to be.  (Its red neighbour STOP has a
           two-step confirm; this one earns an undo instead, because undoing
           it costs nothing but a request.) */
        panel.querySelector('#vagent_clear').addEventListener('click', function () {
            if (!msgsEl) { return; }
            msgsEl.textContent = '';
            var e = document.createElement('div');
            e.className = 'vagent-empty';
            var ew = document.createElement('span');
            lt(ew, 'chat.cleared');
            e.appendChild(ew);
            e.appendChild(document.createTextNode(' '));
            var undo = document.createElement('button');
            undo.type = 'button';
            undo.className = 'vagent-ref';
            lt(undo, 'chat.cleared.undo');
            lt(undo, 'chat.cleared.undo_tip', null, 'title');
            undo.addEventListener('click', function () {
                undo.disabled = true;
                lt(undo, 'common.loading');
                loadHistory();
            });
            e.appendChild(undo);
            msgsEl.appendChild(e);
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
                        turn('bot', 'vagent-err', (d && d.reply) || _t('agent.stop.ok'), []);
                    }
                }).catch(function () {
                    if (msgsEl) {
                        turn('bot', 'vagent-err', _t('agent.stop.failed'), []);
                    }
                });
        }

        // Built-in blocks. Approvals on top: a held command is a question the
        // robot cannot answer itself, so it outranks everything below it.
        var gateSum = gateBadge;
        registerBlock({id: 'gate', title: 'Approvals', titleKey: 'appr.title', order: 10,
                       summaryExtra: gateSum,
                       render: function (el) { gateBody = el; }});
        // One Jobs tab: running work, schedules, failures and history together.
        registerBlock({id: 'jobs', title: 'Jobs', titleKey: 'ajob.title', order: 20,
                       summaryExtra: jobsBadge,
                       render: renderJobsTab,
                       poll: {every_ms: 8000, fn: function () {
                           // U23: this said `tabBtns.jobs`, and the key has
                           // been `work` since the tabs merged — so the poll
                           // never ran and the Work tab only ever refreshed
                           // when you switched away and back.
                           // U34: and it is now the ONLY poller of this
                           // list.  Full rate while the owner is looking at
                           // it, half rate when he is not — the tab badge
                           // and the shell strip still have to be right when
                           // he is reading the chat, they just do not have
                           // to be right to the second.
                           if (blockTabActive('jobs')) { unifiedIdle = 0; pollUnified(); return; }
                           if ((++unifiedIdle % 2) === 0) { pollUnified(); }
                       }},
                       onOpen: function () { pollUnified(); }});
        registerBlock({id: 'chat', title: 'Chat', titleKey: 'chat.title', order: 30, render: renderChat});
        built = true;
        mountBlocks();
        if (window.VTI18n && VTI18n.onChange) { VTI18n.onChange(relang); }

        document.addEventListener('keydown', function (ev) {
            if (ev.altKey && !ev.ctrlKey && !ev.metaKey &&
                    String(ev.key).toLowerCase() === 'a') {
                ev.preventDefault();
                togglePanel();
            }
        });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && panelActive) {
                clearUnread(); markSeenNow(); keepBottom();
                schedule();   // kick: fresh state/jobs/tasks now, not in 5 s
            }
        });

        installStrip();
        probeAgent();                         // decide availability once, now
        // …and keep watching: probeAgent re-arms itself (30 s up, backoff down)
        setInterval(pollStrip, 30000);        // shell strip: right even when shut
        setTimeout(pollStrip, 1500);
        schedule();
        paintBadge();
        paintConn();

        // Reopen if it was open last time — after map_view.js restored its own
        // panel (it runs later in the load and would win the drawer anyway).
        if (lsGet(LS_OPEN) === '1') {
            setTimeout(function () {
                if (agentUp === false) { return; }   // don't auto-open a down agent
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
        /* U2: the Needs you panel asks for the approvals once when it opens
           (the same single poller, U44, no second loop) */
        pollApprovals: function () { return pollApprovals(); },
        api: api,
        num: num,                     // every number says where it came from
        auditNumbers: auditNumbers,   // …and the panel can be asked to prove it
        measuredWidth: measuredWidth,
        isVisible: isVisible,
        notify: notify,
        open: openPanel,
        close: function () { deactivate(true); },
        toggle: togglePanel,
        submitText: submitText,
        activateTab: activateTab,
        flagTab: flagTab,
        blockTabActive: blockTabActive,
        highlightJob: highlightJob,
        highlightSched: highlightSched,
        inlineConfirm: inlineConfirm,
        incidentActions: incidentActions,
        findingTitle: findingTitle,
        actionButtons: actionButtons,
        renderMarkdown: renderMarkdown,
        state: sharedState,
        authorId: author,
        displayName: function () { return displayName; },
        http: AGENT_HTTP,                 // resolved at load; see httpBase()
        httpBase: function () { return AGENT_HTTP; },
        // the dock lock: state, the one-shot grant, and taking it back
        dock: {
            state: function () { return dockState; },
            grants: function () { return DOCK_GRANTS; },
            unlock: dockUnlock,
            open: openDock,
            relock: dockRelock,
            poll: pollDock,
            left: dockLeft,
            usesLeft: dockUsesLeft,
            mmss: mmss
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
