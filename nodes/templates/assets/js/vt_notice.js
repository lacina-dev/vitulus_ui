/* vt_notice.js — the one line above the map (#span_status_info) and who gets it.
 *
 * Before this file every /nextion/log_info line replaced the text at once, and every
 * line started its own 10 s timer that nobody cleared, so an older timer took a newer
 * line away after a moment. A STOP was overwritten by the next routine line.
 *
 * Now everybody asks here. One item shows at a time, the best first:
 *   level 0  STOP, errors, lost link        level 1  sleep announcements, what needs a person
 *   level 2  what the robot does now        level 3  the robot's routine lines
 * An item stays at least MIN_MS of its level. A sticky one (a countdown, a lost link) stays
 * until cleared; items of its level or better get their turn and it comes back, routine
 * lines wait behind it. The same key or text is not repeated within REPEAT_MS. The queue is
 * short: the oldest routine line goes first, it is in the log panel anyway (status_logger).
 *
 * Latched topics answer a new subscriber at once with their last line, of any age. Those
 * come as a burst after (re)connecting: only the last of it is shown.
 *
 *   VTNotice.say({ key, text, level, sticky, ttl, action: { text, fn }, conn, urgent })
 *   VTNotice.clear(key)
 *   VTNotice.robot(line)      a line of /nextion/log_info
 */
(function (root) {
    'use strict';

    var MIN_MS = [6000, 5000, 4000, 2500];
    var TTL_MS = [12000, 10000, 8000, 10000];
    var REPEAT_MS = 30000;
    var HOLD_MS = 90000;        // a routine line older than this is history, not news
    var BURST_MS = 2000;
    var MAX_ROUTINE = 4;

    function make(env) {
        var now = env.now || function () { return Date.now(); };
        var later = env.later || function (fn, ms) { return setTimeout(fn, ms); };
        var stop = env.stop || function (h) { clearTimeout(h); };
        var paint = env.paint;
        var cur = null, queue = [], recent = {}, timer = null, burstUntil = 0, burstLine = null, burstTimer = null;

        function arm(ms) {
            if (timer !== null) { stop(timer); }
            timer = later(function () { timer = null; pump(); }, Math.max(0, ms));
        }
        function show(item) {
            cur = item;
            cur.shown = now();
            paint(cur);
            arm(item.sticky || queue.length ? (MIN_MS[item.level] || 3000) : (item.ttl || TTL_MS[item.level]));
        }
        function best() {
            var b = -1;
            queue.forEach(function (q, i) {
                if (b < 0 || q.level < queue[b].level) { b = i; }
            });
            return b;
        }
        function take(i) { return queue.splice(i, 1)[0]; }
        function age() {
            var t = now();
            queue = queue.filter(function (q) { return q.level < 3 || t - q.t < HOLD_MS; });
        }
        function pump() {
            age();
            var i = best();
            if (!cur) {
                if (i >= 0) { show(take(i)); } else { paint(null); }
                return;
            }
            var shownFor = now() - cur.shown;
            var min = MIN_MS[cur.level] || 3000;
            var done = shownFor >= (cur.sticky ? min : (cur.ttl || TTL_MS[cur.level]));
            if (i < 0) {
                if (cur.sticky) { arm(min); }
                else if (done) { cur = null; paint(null); }
                else { arm((cur.ttl || TTL_MS[cur.level]) - shownFor); }
                return;
            }
            var q = queue[i];
            /* better news does not wait: a level 0 at once, others after a blink */
            if (q.level < cur.level && (q.level === 0 || shownFor >= 1500)) {
                if (cur.sticky) { queue.push(cur); }
                show(take(i));
                return;
            }
            if (shownFor < min) { arm(min - shownFor); return; }
            /* a sticky lets its equals and betters through, routine lines wait */
            if (cur.sticky && q.level > cur.level) { arm(min); return; }
            if (cur.sticky) { queue.push(cur); }
            show(take(i));
        }
        function say(o) {
            var key = o.key || o.text;
            var item = { key: key, text: o.text, level: o.level === undefined ? 2 : o.level, sticky: !!o.sticky,
                         ttl: o.ttl, action: o.action || null, conn: !!o.conn, t: now() };
            if (cur && cur.key === key) {
                var same = cur.text === item.text;
                item.shown = cur.shown;
                cur = item;
                if (!same) { paint(cur); }
                recent[key] = { text: item.text, t: now() };
                if (!item.sticky) { arm(item.ttl || TTL_MS[item.level]); }
                return;
            }
            var at = -1;
            queue.forEach(function (q, i) { if (q.key === key) { at = i; } });
            if (at >= 0) { item.t = queue[at].t; queue[at] = item; urgent(o, item); return; }
            var r = recent[key];
            if (!item.sticky && r && r.text === item.text && now() - r.t < (o.repeat_ms || REPEAT_MS)) { return; }
            recent[key] = { text: item.text, t: now() };
            queue.push(item);
            if (urgent(o, item)) { return; }
            if (item.level === 3) {
                var routine = queue.filter(function (q) { return q.level === 3; });
                if (routine.length > MAX_ROUTINE) { queue.splice(queue.indexOf(routine[0]), 1); }
            }
            pump();
        }
        /* urgent (a lost link): shown NOW, also over an equal line still in its minimum
           time (the STOP line); a sticky one it pushes aside comes back later */
        function urgent(o, item) {
            if (!o.urgent || !cur || cur.key === item.key || item.level > cur.level) { return false; }
            if (cur.sticky) { queue.push(cur); }
            show(take(queue.indexOf(item)));
            return true;
        }
        function clear(key) {
            queue = queue.filter(function (q) { return q.key !== key; });
            delete recent[key];
            if (cur && cur.key === key) { cur = null; if (timer !== null) { stop(timer); timer = null; } pump(); }
        }
        function classify(line) {
            if (/\b(STOP|CRITICAL|TERMINAL|FATAL|ERROR|FAULT)\b|\[SAFETY\]|chyba|nouz/i.test(line)) { return 0; }
            if (/warn|varov|blocked|hold|no-?go|zákaz|přehř|overheat/i.test(line)) { return 1; }
            return 3;
        }
        function robot(line, text) {
            var raw = String(line === undefined || line === null ? '' : line).trim();
            if (!raw) { return; }
            /* the master's own diary: Autonomy says it in words, the log keeps it */
            if (/^\[(Master|Sleep)\]/.test(raw)) { return; }
            var o = { key: 'robot:' + raw, text: text || raw, level: classify(raw), repeat_ms: 8000 };
            if (now() < burstUntil) {
                burstLine = o;
                if (burstTimer === null) {
                    burstTimer = later(function () {
                        burstTimer = null;
                        var l = burstLine;
                        burstLine = null;
                        if (l) { l.ttl = 6000; say(l); }
                    }, Math.max(0, burstUntil - now()));
                }
                return;
            }
            say(o);
        }
        function connected() { burstUntil = now() + BURST_MS; }
        return { say: say, clear: clear, robot: robot, connected: connected, pump: pump,
                 _cur: function () { return cur; }, _queue: function () { return queue; } };
    }

    root.VTNoticeMake = make;
    if (typeof document === 'undefined') { return; }

    function span() { return document.getElementById('span_status_info'); }
    function paint(item) {
        var info = span();
        if (!info) { return; }
        if (!item) {
            while (info.firstChild) { info.removeChild(info.firstChild); }
            info.classList.remove('vt-notice-conn');
            delete info.dataset.level;
            info.textContent = ' ';
            info.style.display = 'none';
            return;
        }
        info.classList.toggle('vt-notice-conn', !!item.conn);
        info.dataset.level = item.level;
        /* a countdown repaints every second: its button must stay the same element or a
           click that spans a repaint is lost */
        var old = document.getElementById('btn_notice_action');
        if (old && item.action && info.dataset.key === item.key) {
            info.firstChild.textContent = item.text;
            old.textContent = item.action.text;
            old.onclick = item.action.fn;
        } else {
            while (info.firstChild) { info.removeChild(info.firstChild); }
            var tx = document.createElement('span');
            tx.className = 'vt-notice-t';
            tx.textContent = item.text;
            info.appendChild(tx);
            if (item.action) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'vt-notice-act';
                b.id = 'btn_notice_action';
                b.textContent = item.action.text;
                b.onclick = item.action.fn;
                info.appendChild(b);
            }
        }
        info.dataset.key = item.key;
        info.style.display = item.action ? 'inline-flex' : 'inline';
    }
    root.VTNotice = make({ paint: paint });
    document.addEventListener('rosconnected', function () { root.VTNotice.connected(); });
}(typeof window !== 'undefined' ? window : globalThis));
