/* vt_hub.js — one shared data hub for the robot UI (U2, I0 of
 * docs/UI_INTEGRATION_PLAN.md).
 *
 * Every panel that shows data from outside rosbridge (the field dashboard
 * through the read-only proxy /field/api/*, the agent through /agent/*)
 * reads it from here instead of running its own poller: ONE timer per
 * source, paused to a slow beat while the tab is hidden, exponential backoff
 * on errors, an immediate refresh when the tab comes back. Panels subscribe
 * with on(key, fn) and get the current value at once.
 *
 * The field dashboard pays CPU on the robot's computer for every answer
 * (T39: /api/home ~1.9 s), so its sources (/field/api/*) are not asked at
 * all while the tab is hidden, and a panel asks faster only while it is
 * open: want(key, who, everyMs) adds its pace, want(key, who, 0) takes it
 * back; the poller runs at the fastest pace anybody wants (its own base
 * pace included) and stands still when nobody wants it.
 *
 *   VTHub.poll(key, url, everyMs)   start (idempotent) a GET poller
 *   VTHub.pace(key, everyMs)        change its base pace; 0 = only on demand
 *   VTHub.want(key, who, everyMs)   `who` needs it this often; 0 = no longer
 *   VTHub.put(key, data)            publish data another module already has
 *                                    (agent_chat.js puts its approvals here)
 *   VTHub.get(key) -> {data, ok, ts, err} | undefined
 *   VTHub.on(key, fn) -> off()      fn(entry) now and on every change
 *   VTHub.refresh(key)              fetch now
 *   VTHub.stop(key)                 stop a poller (data stays; poll() restarts)
 *
 * Read-only by construction: it only ever issues GET.
 */
(function () {
    'use strict';
    var HIDDEN_MS = 60000;       // slow beat while the tab is hidden
    var MAX_BACKOFF_MS = 300000;
    var HIDDEN_OFF = /^\/field\/api\//;   // costs the robot's CPU: nothing while hidden

    var store = {};              // key -> {data, ok, ts, err}
    var subs = {};               // key -> [fn]
    var pollers = {};            // key -> {url, every, timer, fails, busy}

    function emit(key) {
        (subs[key] || []).slice().forEach(function (fn) {
            try { fn(store[key]); } catch (e) { if (window.console) { console.error('[VTHub]', key, e); } }
        });
    }
    function put(key, data, ok, err) {
        store[key] = { data: data, ok: ok !== false, ts: Date.now(), err: err || null };
        emit(key);
    }
    function on(key, fn) {
        (subs[key] = subs[key] || []).push(fn);
        if (store[key]) { try { fn(store[key]); } catch (e) { /* subscriber's problem */ } }
        return function () {
            subs[key] = (subs[key] || []).filter(function (f) { return f !== fn; });
        };
    }
    /* the fastest pace anybody wants; 0 = nobody, the poller stands still */
    function pace(p) {
        var ms = p.every || 0;
        Object.keys(p.wants).forEach(function (w) {
            if (p.wants[w] > 0 && (!ms || p.wants[w] < ms)) { ms = p.wants[w]; }
        });
        return ms;
    }
    function resting(p) { return !pace(p) || (document.hidden && HIDDEN_OFF.test(p.url)); }
    function delay(p) {
        var ms = pace(p);
        if (p.fails) { ms = Math.min(MAX_BACKOFF_MS, ms * Math.pow(2, p.fails)); }
        if (document.hidden) { ms = Math.max(ms, HIDDEN_MS); }
        return ms;
    }
    function schedule(key, after) {
        var p = pollers[key];
        if (!p) { return; }
        clearTimeout(p.timer);
        p.timer = null;
        if (resting(p)) { return; }
        /* a pace that just got faster counts from the last answer */
        var e = store[key], ms = delay(p);
        if (after && e && e.ts) { ms = Math.max(0, ms - (Date.now() - e.ts)); }
        p.timer = setTimeout(function () { fetchNow(key); }, ms);
    }
    function repace(key, change) {
        var p = pollers[key];
        if (!p) { return; }
        var was = pace(p);
        change(p);
        if (pace(p) !== was && !p.busy) { schedule(key, true); }
    }
    function setPace(key, every) {
        repace(key, function (p) { p.every = every > 0 ? Math.max(2000, every) : 0; });
    }
    function want(key, who, every) {
        repace(key, function (p) {
            if (every > 0) { p.wants[who] = Math.max(2000, every); } else { delete p.wants[who]; }
        });
    }
    function fetchNow(key) {
        var p = pollers[key];
        if (!p || p.busy) { return; }
        p.busy = true;
        clearTimeout(p.timer);
        fetch(p.url, { method: 'GET', cache: 'no-store', credentials: 'same-origin',
                       headers: { 'Accept': 'application/json' } })
            .then(function (r) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    if (!r.ok) { throw new Error((j && j.error) || ('HTTP ' + r.status)); }
                    return j;
                });
            })
            .then(function (j) { p.fails = 0; put(key, j, true); },
                  function (e) {
                      p.fails = Math.min(p.fails + 1, 8);
                      var prev = store[key];
                      /* keep the last good data, mark it stale */
                      store[key] = { data: prev ? prev.data : null, ok: false,
                                     ts: prev ? prev.ts : 0, err: String(e && e.message || e) };
                      emit(key);
                  })
            .then(function () { p.busy = false; schedule(key); });
    }
    function poll(key, url, every) {
        if (pollers[key]) { return; }
        pollers[key] = { url: url, every: Math.max(2000, every || 30000), wants: {}, timer: null, fails: 0, busy: false };
        if (!resting(pollers[key])) { fetchNow(key); }   // hidden: the first ask waits for the tab
    }
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            Object.keys(pollers).forEach(function (k) {   // a pending beat must not fire hidden
                if (resting(pollers[k])) { clearTimeout(pollers[k].timer); pollers[k].timer = null; }
            });
            return;
        }
        Object.keys(pollers).forEach(function (k) {
            var e = store[k], ms = pace(pollers[k]);
            if (!ms) { return; }
            if (!e || Date.now() - e.ts > ms) { fetchNow(k); }
            else if (!pollers[k].timer && !pollers[k].busy) { schedule(k, true); }
        });
    });

    function stop(key) {
        var p = pollers[key];
        if (!p) { return; }
        clearTimeout(p.timer);
        delete pollers[key];
    }

    window.VTHub = {
        poll: poll,
        stop: stop,
        pace: setPace,
        want: want,
        put: function (key, data) { put(key, data, true); },
        get: function (key) { return store[key]; },
        on: on,
        refresh: fetchNow
    };
})();
