/* vt_activity.js — Agent › Activity: ONE timeline of what the robot's agent
 * and the field kit did (U2, I2 of docs/UI_INTEGRATION_PLAN.md).
 *
 * Sources (read-only GETs through the shared hub, vt_hub.js):
 *   field.now       /field/api/activity/current   the "now" line (busy / waiting)
 *   field.activity  /field/api/activity           the kit's events, last 24 h
 *   agent.jobs      /agent/api/v2/jobs            the agent's jobs and findings
 * Rows in the field look (vt_field.css .vt-acts > .vt-act): dot in the
 * tone of the event · text · source · time; fixed height, nothing jumps on
 * a refresh. Filters: All · Agent · Support · Problems (remembered). The
 * timeline only reads; acting happens in Work / Findings / Needs you.
 */
(function () {
    'use strict';
    var LS_FILTER = 'vitulus_activity_filter';
    var PAGE = 60;
    var root = null, listEl = null, nowEl = null, pillsEl = null, moreEl = null;
    var filter = 'all', shown = PAGE, started = false, issueOnly = null, issueChip = null;

    function tr(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tag(e, k, attr) { if (window.VTI18n) { VTI18n.tag(e, k, attr); } return e; }
    /* the kit sends text (its own language, Czech) and text_en: show the one of the UI's language */
    function kitText(x) {
        var cs = window.VTI18n && VTI18n.lang() === 'cs';
        return (cs ? (x.text || x.text_en) : (x.text_en || x.text)) || '';
    }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
    function dayLabel(t) {
        var k = dayKey(t), now = Date.now();
        if (k === dayKey(now)) { return tr('activity.today'); }
        if (k === dayKey(now - 86400000)) { return tr('activity.yesterday'); }
        var d = new Date(t);
        return d.getDate() + '. ' + (d.getMonth() + 1) + '.';
    }

    /* ------------------------------------------------- normalise sources */
    var FIELD_SRC = { tick: 'activity.src.watcher', runner: 'activity.src.runner', dash: 'activity.src.dashboard',
                      restart: 'activity.src.restart', kit: 'activity.src.kit', fleet: 'activity.src.fleet',
                      agent: 'activity.src.field_agent' };
    function fieldRows() {
        /* one issue: its own query over 7 days (the dashboard filters) */
        var e = window.VTHub && VTHub.get(issueOnly ? 'field.issueact:' + issueOnly : "field.activity");
        var ev = (e && e.data && e.data.events) || [];
        return ev.map(function (x) {
            var t = Date.parse(x.ts);
            return { t: isNaN(t) ? 0 : t, side: 'field',
                     state: x.level === 'error' ? 'err' : (x.level === 'warn' ? 'warn' : 'off'),
                     text: kitText(x) || x.kind || '',
                     src: Object.prototype.hasOwnProperty.call(FIELD_SRC, x.source) ? tr(FIELD_SRC[x.source])
                         : (x.source || tr('activity.src.support')),
                     issue: x.issue || null,
                     key: 'f:' + (x.ts || '') + ':' + (x.kind || '') + ':' + (x.action_id || '') };
        });
    }
    var JOB_DONE = { done: 'ok', finished: 'ok', cancelled: 'off', failed: 'err', error: 'err' };
    function agentRows() {
        var e = window.VTHub && VTHub.get("agent.jobs");
        var jobs = (e && e.data && e.data.jobs) || [];
        var out = [];
        jobs.forEach(function (j) {
            var what = j.kind === 'finding' ? tr('activity.finding', { title: j.title || '' })
                : tr('activity.job', { id: j.id, title: j.title || '' });
            if (j.created) {
                out.push({ t: j.created * 1000, side: 'agent',
                           state: j.kind === 'finding' ? 'warn' : 'info',
                           busy: j.state === 'running',
                           text: j.kind === 'finding' ? what : tr('activity.started', { what: what }),
                           src: j.origin || tr('activity.src.agent'), key: 'a:' + j.id + ':c', job: j.id, kind: j.kind });
            }
            if (j.finished) {
                var st = JOB_DONE[j.state] || 'off';
                var how = j.outcome ? j.outcome : j.state;
                out.push({ t: j.finished * 1000, side: 'agent', state: st,
                           text: j.error ? tr('activity.closed_err', { how: how, what: what, err: j.error })
                                         : tr('activity.closed', { how: how, what: what }),
                           src: j.origin || tr('activity.src.agent'), key: 'a:' + j.id + ':f', job: j.id, kind: j.kind });
            }
        });
        return out;
    }
    /* I5: the robot UI's own writes (webnode ~/.vitulus/ui_actions.jsonl) */
    function uiRows() {
        var e = window.VTHub && VTHub.get("ui.actions");
        var acts = (e && e.data && e.data.actions) || [];
        return acts.map(function (a) {
            var t = Date.parse(String(a.ts || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
            if (a.action === 'dock-relock' && a.author === 'robot') {
                // free drive locked itself (agent core, v2/dock_relock)
                return { t: isNaN(t) ? 0 : t, side: 'agent', state: 'ok', src: tr('activity.src.dock'),
                         text: tr('activity.dock_relock', { r: a.receipt || '?' }),
                         key: 'u:' + a.ts + ':' + a.ref };
            }
            var uv = { who: a.author || '?', action: a.action, ref: a.ref || '', msg: a.message };
            return { t: isNaN(t) ? 0 : t, side: 'field', state: a.ok ? 'ok' : 'err', src: tr('activity.src.ui'),
                     text: a.message ? tr('activity.ui_msg', uv) : tr('activity.ui', uv),
                     key: 'u:' + a.ts + ':' + a.ref };
        });
    }
    function rows() {
        var all = fieldRows().concat(agentRows()).concat(issueOnly ? [] : uiRows());
        if (issueOnly) { all = all.filter(function (r) { return r.side === 'field'; }); }
        if (filter === 'agent') { all = all.filter(function (r) { return r.side === 'agent'; }); }
        else if (filter === 'field') { all = all.filter(function (r) { return r.side === 'field'; }); }
        else if (filter === 'problems') { all = all.filter(function (r) { return r.state === 'err' || r.state === 'warn'; }); }
        all.sort(function (a, b) { return b.t - a.t; });
        return all;
    }

    /* ------------------------------------------------------------ render */
    function renderNow() {
        if (!nowEl) { return; }
        var e = window.VTHub && VTHub.get("field.now");
        var d = e && e.data;
        nowEl.textContent = '';
        var row = el('div', 'vt-act vt-act-now');
        if (!d) { row.appendChild(el('span', 'vt-skel')); nowEl.appendChild(row); return; }
        var busy = (d.busy && d.busy.length) || d.state === 'busy' || d.state === 'running';
        row.setAttribute('data-state', d.level === 'error' ? 'err' : (d.level === 'warn' || d.state === 'waiting') ? 'warn' : (busy ? 'info' : 'ok'));
        if (busy) { row.classList.add('vt-busy'); }
        row.appendChild(el('span', 'vt-sdot'));
        var txt = el('span', 'vt-act-txt', kitText(d).replace(/\s+/g, ' '));
        txt.title = kitText(d);
        row.appendChild(txt);
        row.appendChild(el('span', 'vt-act-time', e.ok ? tr('common.now') : tr('activity.stale')));
        nowEl.appendChild(row);
    }
    function renderList() {
        if (!listEl) { return; }
        var fe = window.VTHub && VTHub.get(issueOnly ? 'field.issueact:' + issueOnly : "field.activity"), ae = window.VTHub && VTHub.get("agent.jobs");
        var all = rows();
        listEl.textContent = '';
        if (!fe && !ae) {
            for (var i = 0; i < 4; i++) { listEl.appendChild(el('span', 'vt-skel')); }
            moreEl.hidden = true;
            return;
        }
        if (!all.length) {
            listEl.appendChild(el('p', 'vt-empty', issueOnly ? tr('activity.none_issue', { n: issueOnly })
                : (filter === 'problems' ? tr('activity.none_problems') : tr('activity.none'))));
        }
        var lastDay = null;
        var ul = null;
        all.slice(0, shown).forEach(function (r) {
            var dk = dayKey(r.t);
            if (dk !== lastDay) {
                lastDay = dk;
                listEl.appendChild(el('div', 'vt-act-day', dayLabel(r.t)));
                ul = el('ul', 'vt-acts');
                listEl.appendChild(ul);
            }
            var li = el('li', 'vt-act');
            li.setAttribute('data-state', r.state);
            if (r.busy) { li.classList.add('vt-busy'); }
            li.appendChild(el('span', 'vt-sdot'));
            var t = el('span', 'vt-act-txt', r.text);
            t.title = r.text;
            li.appendChild(t);
            if (r.issue) { t.textContent = '#' + r.issue + ' · ' + r.text; }
            /* I6: a row opens what it is about (read only) */
            var go = rowLink(r);
            if (go) {
                li.classList.add('vt-act-link');
                li.tabIndex = 0;
                li.setAttribute('role', 'button');
                li.addEventListener('click', go);
                li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
            }
            var meta = el('span', 'vt-act-time');
            meta.appendChild(el('span', 'vt-act-src vt-act-src-' + r.side, r.side === 'agent' ? tr('activity.src.agent') : r.src));
            meta.appendChild(document.createTextNode(' ' + hhmm(r.t)));
            li.appendChild(meta);
            ul.appendChild(li);
        });
        moreEl.hidden = all.length <= shown;
        var errs = [];
        if (fe && !fe.ok) { errs.push(tr('activity.err.field', { err: fe.err })); }
        if (ae && !ae.ok) { errs.push(tr('activity.err.agent', { err: ae.err })); }
        if (errs.length) { listEl.insertBefore(el('p', 'vt-empty', tr('activity.unreachable', { what: errs.join(' · ') })), listEl.firstChild); }
    }
    function rowLink(r) {
        if (!window.VTLinks) { return null; }
        if (r.side === 'agent' && r.job) { return function () { VTLinks.openAgentJob(r.job, r.kind); }; }
        if (r.side === 'field' && r.issue && window.VTSupport) { return function () { VTLinks.openIssue(r.issue); }; }
        return null;
    }
    function paintIssue() {
        if (!issueChip) { return; }
        issueChip.hidden = !issueOnly;
        issueChip.firstChild.textContent = issueOnly ? tr('activity.issue_only', { n: issueOnly }) : '';
    }
    function paintPills() {
        Array.prototype.forEach.call(pillsEl.children, function (b) {
            b.classList.toggle('active', b.dataset.f === filter);
            b.setAttribute('aria-pressed', b.dataset.f === filter ? 'true' : 'false');
        });
    }

    function build(body) {
        root = body;
        root.classList.add('vt-activity');
        root.textContent = '';
        nowEl = el('div', 'vt-act-nowbox');
        root.appendChild(nowEl);
        pillsEl = el('div', 'vt-act-filters');
        [['all', 'common.all'], ['agent', 'activity.f.agent'], ['field', 'activity.f.field'],
         ['problems', 'activity.f.problems']].forEach(function (f) {
            var b = tag(el('button', 'vt-act-filter', tr(f[1])), f[1]);
            b.type = 'button';
            b.dataset.f = f[0];
            b.addEventListener('click', function () {
                filter = f[0]; shown = PAGE; lsSet(LS_FILTER, filter); paintPills(); renderList();
            });
            pillsEl.appendChild(b);
        });
        root.appendChild(pillsEl);
        issueChip = el('div', 'vt-attn vt-act-issue');
        issueChip.setAttribute('data-state', 'info');
        issueChip.appendChild(el('span', 'vt-attn-txt', ''));
        var x = el('button', 'vt-iconbtn', '✕');
        x.type = 'button'; x.title = tr('activity.issue_clear.tip'); x.setAttribute('aria-label', tr('activity.issue_clear'));
        tag(x, 'activity.issue_clear.tip', 'title'); tag(x, 'activity.issue_clear', 'aria-label');
        x.addEventListener('click', function () { setIssue(null); });
        issueChip.appendChild(x);
        issueChip.hidden = true;
        root.appendChild(issueChip);
        listEl = el('div', 'vt-act-list');
        root.appendChild(listEl);
        moreEl = tag(el('button', 'btn btn-outline-info vt-act-more', tr('activity.more')), 'activity.more');
        moreEl.type = 'button';
        moreEl.hidden = true;
        moreEl.addEventListener('click', function () { shown += PAGE; renderList(); });
        root.appendChild(moreEl);
        paintPills();
        renderNow();
        renderList();
    }
    function start() {
        if (started || !window.VTHub) { return; }
        started = true;
        VTHub.on("field.now", renderNow);
        VTHub.on("field.activity", renderList);
        VTHub.on("agent.jobs", renderList);
        VTHub.on("ui.actions", renderList);
        VTHub.poll("field.now", '/field/api/activity/current', 15000);
        VTHub.poll("field.activity", '/field/api/activity?hours=24&limit=200', 60000);
        VTHub.poll("agent.jobs", '/agent/api/v2/jobs?limit=50', 60000);
    }

    function register(VA) {
        filter = lsGet(LS_FILTER) || 'all';
        VA.registerBlock({
            id: 'activity', title: tr('activity.title'), titleKey: 'activity.title', order: 25,
            render: function (body) { build(body); },
            /* the sources start the first time the tab is opened, and every
               opening asks again (the hub keeps one poller per source) */
            onOpen: function () {
                if (!started) { start(); return; }
                ["field.now", "field.activity", "agent.jobs"].forEach(function (k) { VTHub.refresh(k); });
            }
        });
        setInterval(function () { if (root && root.offsetParent) { renderList(); } }, 60000);  // day labels
        if (window.VTI18n) {   // live language switch: everything drawn with tr()
            VTI18n.onChange(function () { if (root) { renderNow(); renderList(); paintIssue(); } });
        }
    }
    var issueKey = null, subscribed = {};
    function setIssue(n) {
        issueOnly = n ? String(n).replace(/\D/g, '') || null : null;
        filter = 'all'; shown = PAGE;
        if (pillsEl) { paintPills(); }
        paintIssue();
        if (!started) { start(); }
        if (window.VTHub) {
            if (issueKey) { VTHub.stop(issueKey); }
            issueKey = issueOnly ? 'field.issueact:' + issueOnly : null;   // one key per issue: never a stale list
            if (issueKey) {
                if (!subscribed[issueKey]) {
                    subscribed[issueKey] = true;
                    var k = issueKey;
                    VTHub.on(k, function () { if (issueKey === k) { renderList(); } });
                }
                VTHub.poll(issueKey, '/field/api/activity?issue=' + issueOnly + '&hours=168&limit=200', 60000);
            }
        }
        renderList();
    }
    window.VTActivity = { filterIssue: setIssue };
    var registered = false;
    function tryRegister() {
        if (registered) { return true; }
        if (window.VAgent && window.VAgent.registerBlock) { registered = true; register(window.VAgent); return true; }
        return false;
    }
    if (!tryRegister()) {
        document.addEventListener('vagent:ready', tryRegister, { once: true });
        var tries = 0, iv = setInterval(function () {
            if (tryRegister() || ++tries > 40) { clearInterval(iv); }
        }, 250);
    }
})();
