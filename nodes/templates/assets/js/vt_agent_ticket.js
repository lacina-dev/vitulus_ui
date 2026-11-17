/* vt_agent_ticket.js — an action sent to the agent over HTTP is never carried out late (T8, 2026-11-17).
 *
 * Why: a POST written into a connection of a lost network stays in TCP; when the
 * network is back — seconds or minutes later, the page long gone — the agent would
 * still get it: "go", an Allow of a drive, a tool run. The agent therefore hands out
 * a one-time ticket (GET /api/ticket -> {ok, ticket, ttl_s, enabled}); an ACTION
 * carries it in its JSON body and the agent refuses it (HTTP 409, {stale: true, code})
 * when it comes later than ttl_s after the ticket was issued, or twice. The ticket
 * request doubles as the check that the agent hears us right now.
 *
 * What goes how (kind(), the same list as the agent's httpguard.classify):
 *   'stop'    only stops, forbids or locks (STOP, Deny, auto-approval off, pause /
 *             cancel / delete, revoke): sent AT ONCE, no ticket, never waits;
 *   'action'  starts or allows something: ticket first (TICKET_MS at most). No ticket
 *             (agent not reachable) -> NOT sent, the caller gets an error with
 *             no_send: true and the words for the person; {enabled: false} or a core
 *             without /api/ticket (HTTP 404) -> sent without one, as before;
 *   'other'   known to change nothing on the robot (models, incident notes, a fence proposal):
 *             as before. A path nobody listed is an ACTION (the safe side);
 *   'read'    GET.
 * A chat message is always an action here: the agent itself recognises the wording
 * that only stops and never refuses that one. And because it may be a STOP in words,
 * a chat message is the one action that still goes out when no ticket can be had —
 * without one, the person is told; the agent then refuses it unless it only stops.
 * A refusal (409 stale) is never repeated automatically: the person looks at the
 * robot and presses again.
 *
 *   VTAgentTicket.kind(path, method, body)            -> 'read' | 'stop' | 'action' | 'other'
 *   VTAgentTicket.withTicket(fetchFn, base, body)     -> Promise<body with ticket | body>
 *                                                        rejects {no_send: true, code: 'nolink'}
 *   VTAgentTicket.refusal(status, json)               -> null | {code, age_s, max_age_s, stopped, cancelled, cancel_text}
 *   VTAgentTicket.text(ref)                           -> the sentence for the person (i18n agent.ticket.*)
 * tools/test_agent_ticket.node.js holds the list of the paths the page sends and fails on a new one.
 */
(function (root) {
    'use strict';
    var TICKET_MS = 2500;

    function truthy(v) { return !!v; }
    function kind(path, method, body) {
        path = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
        var b = (body && typeof body === 'object') ? body : {};
        if (String(method || 'GET').toUpperCase() === 'GET') { return 'read'; }
        var m;
        // the webnode door of the dock permit (adds the owner's proof): /agent-dock/*
        if (path === '/agent-dock/grant') { return 'action'; }
        if (/^\/agent-dock\/revoke\/[^/]+$/.test(path)) { return 'stop'; }
        if (path === '/api/stop') { return 'stop'; }
        if (chat(path)) { return 'action'; }
        if (path === '/api/approvals/decide') {
            return String(b.decision || '').trim().toLowerCase() === 'allow' ? 'action' : 'stop';
        }
        if (path === '/api/approvals/auto') { return (b.enabled === false && !b.on) ? 'stop' : 'action'; }
        if ((m = /^\/api\/watch\/\d+\/(cancel|pause|resume)$/.exec(path))) { return m[1] === 'resume' ? 'action' : 'stop'; }
        if (path === '/api/schedules' || path === '/api/unified/jobs') { return 'action'; }
        if ((m = /^\/api\/schedules\/\d+\/(\w+)$/.exec(path))) {
            return (m[1] === 'pause' || m[1] === 'delete') ? 'stop' : 'action';
        }
        if ((m = /^\/api\/unified\/jobs\/[^/]+\/(\w+)$/.exec(path))) {
            if (m[1] === 'pause' || m[1] === 'delete') { return 'stop'; }
            if (m[1] === 'autoapprove') { return truthy(b.on) ? 'action' : 'stop'; }
            return 'action';
        }
        if ((m = /^\/api\/incidents\/[^/]+\/(\w+)$/.exec(path))) { return /^(ack|resolve|comment)$/.test(m[1]) ? 'other' : 'action'; }
        if (/^\/api\/v2\/tools\/[^/]+\/run$/.test(path) || path === '/api/v2/dock' || path === '/api/doctor/visit' ||
                /^\/api\/v2\/(findings\/[^/]+\/fix|records\/[^/]+\/decide)$/.test(path)) { return 'action'; }
        if (/^\/api\/v2\/dock\/[^/]+\/revoke$/.test(path) || /^\/api\/v2\/rules\/[^/]+\/revoke$/.test(path)) { return 'stop'; }
        if ((m = /^\/api\/v2\/jobs\/[^/]+\/(\w+)$/.exec(path))) {
            return m[1] === 'cancel' ? 'stop' : 'action';
        }
        // what is known to change nothing on the robot
        if (path === '/api/models' || path === '/api/models/revert' || path === '/api/geofence/propose') { return 'other'; }
        // A path nobody listed (also one the agent itself hands to the page, records' "way.path"):
        // an action — the safe side, as in vt_link.js. The agent strips the ticket from the body
        // of every POST, so one too many does no harm.
        return 'action';
    }
    function chat(path) {
        path = String(path || '').split('?')[0].replace(/\/+$/, '');
        return path === '/api/task' || path === '/api/v2/chat';
    }

    function noLink(why) {
        var e = new Error('no ticket: ' + why);
        e.no_send = true; e.code = 'nolink'; e.status = 0;
        e.vt_text = text({ code: 'nolink' });
        return e;
    }

    // fetchFn(url, init) -> Promise<Response>;  base = '/agent'
    function withTicket(fetchFn, base, body) {
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = null;
        var gave = new Promise(function (res, rej) {
            timer = setTimeout(function () { if (ctl) { try { ctl.abort(); } catch (e) { /* gone */ } } rej(noLink('timeout')); }, TICKET_MS);
        });
        var asked = Promise.resolve().then(function () {
            return fetchFn(base + '/api/ticket', { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
        }).then(function (r) {
            if (r.status === 404) { return { enabled: false }; }     // a core that knows no tickets: as before
            if (!r.ok) { throw noLink('HTTP ' + r.status); }
            return r.json();
        }).then(function (d) {
            var out = {};
            Object.keys(body || {}).forEach(function (k) { out[k] = body[k]; });
            if (d && d.enabled === false) { return out; }             // the guard is switched off on the robot
            if (!d || d.ok === false || typeof d.ticket !== 'string' || !d.ticket) { throw noLink('no ticket in the answer'); }
            out.ticket = d.ticket;
            return out;
        }, function (e) { throw (e && e.no_send) ? e : noLink(String(e && e.message || e)); });
        return Promise.race([asked, gave]).then(function (v) { clearTimeout(timer); return v; },
                                                function (e) { clearTimeout(timer); throw e; });
    }

    function refusal(status, json) {
        if (status !== 409 || !json || json.stale !== true) { return null; }
        return { code: String(json.code || 'stale'), age_s: json.age_s, max_age_s: json.max_age_s,
                 stopped: json.stopped === true, cancelled: json.cancelled === true,
                 cancel_text: json.cancel_text || '', error: json.error || '' };
    }

    function text(ref) {
        var t = (root.VTI18n && root.VTI18n.t) ? function (k, v) { return root.VTI18n.t(k, v); } : function (k) { return k; };
        ref = ref || {};
        if (ref.code === 'nolink') { return t('agent.ticket.nolink'); }
        if (ref.code === 'chat_unconfirmed') { return t('agent.ticket.chat_unconfirmed'); }
        if (ref.stopped) { return t('agent.ticket.late_stopped'); }
        if (ref.cancelled) { return t('agent.ticket.late_cancelled', { text: ref.cancel_text }); }
        if (ref.code === 'stale') {
            if (!(+ref.age_s > 0)) { return t('agent.ticket.late_noage'); }
            return t('agent.ticket.late', { age: Math.round(+ref.age_s), max: Math.round(+ref.max_age_s || 0) });
        }
        if (ref.code === 'ticket_required') { return t('agent.ticket.required'); }
        return t('agent.ticket.unknown');
    }

    root.VTAgentTicket = { kind: kind, chat: chat, withTicket: withTicket, refusal: refusal, text: text, TICKET_MS: TICKET_MS };
}(typeof window !== 'undefined' ? window : globalThis));
