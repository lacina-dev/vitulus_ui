#!/usr/bin/env node
/* test_agent_ticket.node.js — actions sent to the agent carry a one-time ticket (T8, vt_agent_ticket.js).
 *
 *   node tools/test_agent_ticket.node.js
 *
 * No browser, no agent: vt_agent_ticket.js and the real api() cut out of agent_chat.js run against a fake fetch.
 *   1 kind(): every path the page sends has its class (the agent's httpguard.classify is the same list);
 *     a NEW path in the sources fails here until it is put into PATHS;
 *   2 withTicket(): ticket into the body; guard off / old core -> none; no answer -> not sent;
 *   3 api(): what stops goes out at once without a ticket request; an action asks first; no ticket ->
 *     no POST; 409 stale -> the server's reason, never repeated;
 *   4 the dock door and the page wiring.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
let fails = 0, n = 0;
function ok(name, cond, info) { n += 1; if (!cond) { fails += 1; console.log('FAIL ' + name + (info !== undefined ? ': ' + JSON.stringify(info) : '')); } }

const said = [];
const ctxBase = () => {
    const c = { console, JSON, Math, Date, Object, Array, String, Number, Error, Promise, setTimeout, clearTimeout, AbortController };
    c.window = c; c.globalThis = c;
    c.VTI18n = { t: (k, v) => k + (v ? ' ' + JSON.stringify(v) : '') };
    c.VTNotice = { say: (o) => said.push(o.text) };
    return vm.createContext(c);
};
const ctx = ctxBase();
vm.runInContext(fs.readFileSync(path.join(JS, 'vt_agent_ticket.js'), 'utf8'), ctx);
const TK = ctx.VTAgentTicket;

/* ------------------------------------------------------------ 1 the list of paths */
// [path as the page sends it, body, class].  action = ticket first; stop = at once, no ticket; other = as before.
const PATHS = [
    ['/api/task', { text: 'jeď na TEST' }, 'action'], ['/api/task', { text: 'stop' }, 'action'],      // the agent tells a stopping text itself
    ['/api/v2/chat', { text: 'x' }, 'action'],
    ['/api/stop', { author: 'ui' }, 'stop'],
    ['/api/approvals/decide', { id: 1, decision: 'allow' }, 'action'], ['/api/approvals/decide', { id: 1, decision: 'deny' }, 'stop'],
    ['/api/approvals/auto', { enabled: true }, 'action'], ['/api/approvals/auto', { enabled: false }, 'stop'], ['/api/approvals/auto', {}, 'action'],
    ['/api/watch/3/resume', {}, 'action'], ['/api/watch/3/pause', {}, 'stop'], ['/api/watch/3/cancel', {}, 'stop'],
    ['/api/schedules', { text: 'x' }, 'action'],
    ['/api/schedules/5/run', {}, 'action'], ['/api/schedules/5/resume', {}, 'action'], ['/api/schedules/5/edit', {}, 'action'],
    ['/api/schedules/5/pause', {}, 'stop'], ['/api/schedules/5/delete', {}, 'stop'],
    ['/api/unified/jobs', { text: 'x' }, 'action'],
    ['/api/unified/jobs/a1/run', {}, 'action'], ['/api/unified/jobs/a1/resume', {}, 'action'], ['/api/unified/jobs/a1/rerun', {}, 'action'],
    ['/api/unified/jobs/a1/edit', {}, 'action'], ['/api/unified/jobs/a1/policy', {}, 'action'],
    ['/api/unified/jobs/a1/pause', {}, 'stop'], ['/api/unified/jobs/a1/delete', {}, 'stop'],
    ['/api/unified/jobs/a1/autoapprove', { on: true }, 'action'], ['/api/unified/jobs/a1/autoapprove', { on: false }, 'stop'],
    ['/api/incidents/i9/investigate', {}, 'action'], ['/api/incidents/i9/ack', {}, 'other'], ['/api/incidents/i9/resolve', {}, 'other'],
    ['/api/v2/tools/photo/run', { args: {} }, 'action'],
    ['/api/v2/dock', {}, 'action'], ['/api/v2/dock/w1/revoke', {}, 'stop'], ['/api/v2/rules/r1/revoke', {}, 'stop'],
    ['/agent-dock/grant', { minutes: 30 }, 'action'], ['/agent-dock/revoke/current', {}, 'stop'], ['/agent-dock/revoke/all', {}, 'stop'],
    ['/api/v2/findings/f1/fix', {}, 'action'], ['/api/v2/records/r1/decide', { way: 'a' }, 'action'],
    ['/api/v2/jobs/j1/resume', {}, 'action'], ['/api/v2/jobs/j1/budget', {}, 'action'], ['/api/v2/jobs/j1/touches', {}, 'action'],
    ['/api/v2/jobs/j1/cancel', {}, 'stop'],
    ['/api/doctor/visit', {}, 'action'],
    ['/api/models', { planner: 'x' }, 'other'], ['/api/models/revert', {}, 'other'], ['/api/geofence/propose', {}, 'other'],
];
PATHS.forEach(([p, b, k]) => ok('kind ' + k + ': POST ' + p + ' ' + JSON.stringify(b), TK.kind(p, 'POST', b) === k, TK.kind(p, 'POST', b)));
ok('kind: a GET is a read, whatever the path', TK.kind('/api/task', 'GET') === 'read' && TK.kind('/api/ticket') === 'read');
ok('kind: query string and trailing slash do not matter', TK.kind('/api/stop/?x=1', 'POST') === 'stop' && TK.kind('/api/v2/dock/', 'POST', {}) === 'action');

// the sources: every literal agent path given to api() / VA.api() / VAgent.api() / dockSend() must be known here.
// A prefix ('/api/schedules/' + id + '/' + verb) is known when some PATHS entry or READS entry starts with it.
const READS = ['/api/health', '/api/models', '/api/mapview', '/api/v2/records', '/api/v2/tools', '/api/approvals/auto', '/api/v2/approvals',
               '/api/missions', '/api/state', '/api/doctor', '/api/growth', '/api/v2/jobs/', '/api/v2/records/', '/api/v2/tools/', '/api/incidents/',
               '/api/watch', '/api/watch/', '/api/task', '/api/ticket', '/api/jobs', '/api/jobs/', '/api/tasks', '/api/commands', '/api/panic'];
const known = PATHS.map((x) => x[0]).concat(READS);
const SKIP = /(_bak|\.bak|\.min\.js$)|^(three|ros3d|ros2d|roslib|jquery|easeljs|eventemitter2|nipplejs|pgmjs|mjpegcanvas|vt_mock)/;
const found = {};
fs.readdirSync(JS).filter((f) => /\.js$/.test(f) && !SKIP.test(f)).forEach((f) => {
    const s = fs.readFileSync(path.join(JS, f), 'utf8');
    const re = /\b(?:api|dockSend|dockWrite)\(\s*['"`](\/(?:api|agent-dock)\/[^'"`$?]*)/g;
    let m;
    while ((m = re.exec(s))) { (found[m[1]] = found[m[1]] || []).push(f); }
});
const names = Object.keys(found);
const unlisted = names.filter((p) => !known.some((k) => k === p || k.indexOf(p) === 0)).map((p) => p + ' (' + found[p][0] + ')');
ok('sources: the scan finds the agent paths (' + names.length + ')', names.length >= 25, names);
ok('sources: every agent path of the page is in PATHS / READS', !unlisted.length, unlisted);

/* ------------------------------------------------------------ fake agent */
function agent(o) {
    const A = { calls: [], ticketN: 0 };
    A.fetch = (url, init) => {
        init = init || {};
        const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
        A.calls.push(call);
        const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
        if (url === '/agent/api/ticket') {
            if (o.ticket === 'down') { const e = new TypeError('Failed to fetch'); return Promise.reject(e); }
            if (o.ticket === 'hang') { return new Promise((res, rej) => { if (init.signal) { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); } }); }
            if (o.ticket === 404) { return json(404, { ok: false }); }
            if (o.ticket === 500) { return json(500, { ok: false }); }
            if (o.ticket === 'off') { return json(200, { ok: true, ticket: 'T' + (++A.ticketN), ttl_s: 5, enabled: false }); }
            return json(200, { ok: true, ticket: 'T' + (++A.ticketN), ttl_s: 5.0, enabled: true });
        }
        if (o.post) { return json(o.post[0], o.post[1]); }
        return json(200, { ok: true });
    };
    A.posts = () => A.calls.filter((c) => c.method === 'POST');
    A.tickets = () => A.calls.filter((c) => c.url === '/agent/api/ticket').length;
    return A;
}

/* the real api() of agent_chat.js, cut out with the things it leans on stubbed */
function apiOf(A) {
    const src = fs.readFileSync(path.join(JS, 'agent_chat.js'), 'utf8');
    const cut = (head) => {
        const i = src.indexOf(head);
        if (i < 0) { throw new Error('not found in agent_chat.js: ' + head); }
        let d = 0, j = src.indexOf('{', i);
        for (; j < src.length; j++) { if (src[j] === '{') { d++; } else if (src[j] === '}') { d--; if (!d) { break; } } }
        return src.slice(i, j + 1);
    };
    const c = ctxBase();
    vm.runInContext(fs.readFileSync(path.join(JS, 'vt_agent_ticket.js'), 'utf8'), c);
    c.fetch = A.fetch;
    vm.runInContext("var AGENT_HTTP = '/agent', agentUp = true, conn = {}; function paintConn() {} function markAgentDown() {}\n" +
                    cut('    function ticketSay(text) {') + '\n' + cut('    function api(path, opts) {') + '\nthis.api = api;', c);
    return c.api;
}

(async () => {
    /* ------------------------------------------------------------ 2 withTicket */
    {
        const A = agent({}), body = { text: 'jeď' };
        const b = await TK.withTicket(A.fetch, '/agent', body);
        ok('ticket: put into a copy of the body', b.ticket === 'T1' && b.text === 'jeď' && body.ticket === undefined, b);
        const b2 = await TK.withTicket(A.fetch, '/agent', body);
        ok('ticket: a new one for every action', b2.ticket === 'T2');
    }
    { const b = await TK.withTicket(agent({ ticket: 'off' }).fetch, '/agent', { a: 1 }); ok('ticket: guard switched off on the robot -> sent without one', b.ticket === undefined && b.a === 1, b); }
    { const b = await TK.withTicket(agent({ ticket: 404 }).fetch, '/agent', { a: 1 }); ok('ticket: a core without /api/ticket (404) -> sent without one', b.ticket === undefined && b.a === 1, b); }
    for (const how of ['down', 500]) {
        let e = null; try { await TK.withTicket(agent({ ticket: how }).fetch, '/agent', {}); } catch (x) { e = x; }
        ok('ticket: agent ' + how + ' -> not sent (no_send, nolink, words for the person)', e && e.no_send === true && e.code === 'nolink' && e.vt_text === 'agent.ticket.nolink', e && [e.no_send, e.code, e.vt_text]);
    }
    {
        const t0 = Date.now(); let e = null; try { await TK.withTicket(agent({ ticket: 'hang' }).fetch, '/agent', {}); } catch (x) { e = x; }
        const dt = Date.now() - t0;
        ok('ticket: no answer -> given up after ~2.5 s, not sent', e && e.no_send === true && dt >= 2400 && dt <= 3200, dt);
    }
    ok('refusal: 409 stale read', JSON.stringify(TK.refusal(409, { ok: false, stale: true, code: 'stale', age_s: 42.4, max_age_s: 5 })) ===
        JSON.stringify({ code: 'stale', age_s: 42.4, max_age_s: 5, stopped: false, cancelled: false, cancel_text: '', error: '' }));
    ok('refusal: another 409 / another status is not one', TK.refusal(409, { ok: false, error: 'busy' }) === null && TK.refusal(400, { stale: true }) === null);
    ok('text: late with the age', TK.text({ code: 'stale', age_s: 42.4, max_age_s: 5 }) === 'agent.ticket.late {"age":42,"max":5}');
    ok('text: used / unknown, old page, stopped, cancelled', TK.text({ code: 'ticket_unknown' }) === 'agent.ticket.unknown' && TK.text({ code: 'ticket_required' }) === 'agent.ticket.required' &&
        TK.text({ code: 'stale', stopped: true }) === 'agent.ticket.late_stopped' && TK.text({ code: 'stale', cancelled: true, cancel_text: 'zruš to' }) === 'agent.ticket.late_cancelled {"text":"zruš to"}');

    /* ------------------------------------------------------------ 3 api() of the page */
    {
        const A = agent({}), api = apiOf(A);
        await api('/api/stop', { body: { author: 'ui' } });
        await api('/api/approvals/decide', { body: { id: 1, decision: 'deny' }, keep_error_body: true });
        await api('/api/approvals/auto', { method: 'POST', body: { enabled: false } });
        await api('/api/watch/3/pause', { body: {} });
        await api('/api/unified/jobs/a1/delete', { method: 'POST', body: {} });
        ok('api: STOP, Deny, auto off, pause, delete: one request each, no ticket asked, none in the body', A.tickets() === 0 && A.calls.length === 5 && A.posts().every((c) => c.body.ticket === undefined), A.calls.map((c) => c.url));
        await api('/api/models', { body: { planner: 'x' } });
        await api('/api/state');
        ok('api: other / read: as before', A.tickets() === 0 && A.calls.length === 7);
    }
    {
        const A = agent({}), api = apiOf(A);
        await api('/api/task', { body: { text: 'jeď na TEST', author: 'ui' } });
        await api('/api/approvals/decide', { body: { id: 1, decision: 'allow' }, keep_error_body: true });
        await api('/api/doctor/visit', { method: 'POST', body: {} });
        await api('/api/v2/tools/photo/run', { body: { args: {} }, timeout_ms: 60000 });
        await api('/api/watch/3/resume', { body: {} });
        const seq = A.calls.map((c) => c.method + ' ' + c.url.replace('/agent', ''));
        ok('api: an action asks for a ticket first, every time', seq.join() === ['GET /api/ticket', 'POST /api/task', 'GET /api/ticket', 'POST /api/approvals/decide', 'GET /api/ticket', 'POST /api/doctor/visit',
            'GET /api/ticket', 'POST /api/v2/tools/photo/run', 'GET /api/ticket', 'POST /api/watch/3/resume'].join(), seq);
        ok('api: the ticket rides in the JSON body, the rest of the body is kept', A.posts().map((c) => c.body.ticket).join() === 'T1,T2,T3,T4,T5' && A.posts()[0].body.text === 'jeď na TEST' && A.posts()[1].body.decision === 'allow');
    }
    for (const how of ['down', 500]) {
        const A = agent({ ticket: how }), api = apiOf(A); said.length = 0;
        let e = null; try { await api('/api/task', { body: { text: 'jeď' } }); } catch (x) { e = x; }
        ok('api: agent ' + how + ' at the ticket -> the action is NOT sent, the person is told', A.posts().length === 0 && e && e.no_send === true && said.join() === 'agent.ticket.nolink', [A.calls.length, said]);
        await api('/api/stop', { body: { author: 'ui' } }).catch(() => {});
        ok('api: agent ' + how + ' at the ticket -> STOP is still sent', A.posts().length === 1 && A.posts()[0].url === '/agent/api/stop');
    }
    {
        const A = agent({ ticket: 'off' }), api = apiOf(A);
        await api('/api/task', { body: { text: 'jeď' } });
        ok('api: guard off -> the action is sent without a ticket', A.posts().length === 1 && A.posts()[0].body.ticket === undefined && A.posts()[0].body.text === 'jeď');
    }
    for (const [body, want] of [[{ ok: false, stale: true, code: 'stale', age_s: 63.2, max_age_s: 5, error: 'cs / en' }, 'agent.ticket.late {"age":63,"max":5}'],
                                [{ ok: false, stale: true, code: 'ticket_unknown' }, 'agent.ticket.unknown'],
                                [{ ok: false, stale: true, code: 'stale', stopped: true }, 'agent.ticket.late_stopped']]) {
        const A = agent({ post: [409, body] }), api = apiOf(A); said.length = 0;
        let e = null; try { await api('/api/task', { body: { text: 'jeď' } }); } catch (x) { e = x; }
        await new Promise((r) => setTimeout(r, 30));
        ok('api: 409 ' + body.code + (body.stopped ? ' (stopped)' : '') + ' -> the reason for the person, once, never sent again',
            e && e.stale === true && e.no_retry === true && e.status === 409 && e.vt_text === want && said.join() === want && A.posts().length === 1 && A.tickets() === 1, [e && e.vt_text, said, A.calls.length]);
    }
    {
        const A = agent({ post: [409, { ok: false, error: 'busy' }] }), api = apiOf(A); said.length = 0;
        let e = null; try { await api('/api/approvals/decide', { body: { id: 1, decision: 'deny' }, keep_error_body: true }); } catch (x) { e = x; }
        ok('api: a 409 that is not a late one keeps its body for the caller, no notice', e && e.status === 409 && !e.stale && e.body && e.body.error === 'busy' && !said.length, [e && e.message, said]);
    }

    /* ------------------------------------------------------------ 4 the dock door, the page */
    const chat = fs.readFileSync(path.join(JS, 'agent_chat.js'), 'utf8');
    const grant = chat.slice(chat.indexOf('    function dockGrant(opts) {'), chat.indexOf('    function dockLock(target) {'));
    const lock = chat.slice(chat.indexOf('    function dockLock(target) {'), chat.indexOf('    function dockRelock() {'));
    ok('dock: allowing the dock takes a ticket before /agent-dock/grant', /withTicket\([\s\S]*dockSend\('\/agent-dock\/grant', b, 3\)/.test(grant));
    ok('dock: no ticket -> not sent (answers ok:false, told)', /ticketSay\(err && err\.vt_text\);\s*return \{ok: false, status: 0, code: 'nolink'/.test(grant));
    ok('dock: locking never waits for a ticket', !/withTicket|VTAgentTicket/.test(lock) && /dockSend\('\/agent-dock\/revoke\//.test(lock));
    const web = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'webnode'), 'utf8');
    ok('webnode: the dock door carries the ticket over (both grant shapes)', (web.match(/_dock_ticket\(b, body\)/g) || []).length === 2 && /body\["ticket"\] = tk/.test(web));
    ok('webnode: /agent/* sends the POST body on unchanged and hands the agent\'s 4xx back with its body',
        /data = request\.get_data\(cache=False\)\[:AGENT_MAX_BODY\]/.test(web) && /except urllib\.error\.HTTPError as exc:\s+# the agent's own 4xx\/5xx\s+body = exc\.read\(\)/.test(web) && /status = exc\.code/.test(web));
    const idx = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'templates', 'index.html'), 'utf8');
    ok('index.html: vt_agent_ticket.js is loaded before agent_chat.js', idx.indexOf('/assets/js/vt_agent_ticket.js') > 0 && idx.indexOf('/assets/js/vt_agent_ticket.js') < idx.indexOf('/assets/js/agent_chat.js'));
    ['en', 'cs'].forEach((l) => {
        const d = fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8');
        const miss = ['nolink', 'late', 'late_noage', 'unknown', 'required', 'late_stopped', 'late_cancelled'].filter((k) => d.indexOf('"agent.ticket.' + k + '"') < 0);
        ok('i18n ' + l + ': every agent.ticket.* text', !miss.length, miss);
    });

    console.log((fails ? 'FAIL' : 'OK') + ' — ' + (n - fails) + '/' + n + ' checks');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL (exception) ' + (e && e.stack || e)); process.exit(1); });
