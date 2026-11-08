// map_objects.js — the map objects of vitulus_mapping (docs/MAP_OBJECTS.md) for
// the web UI: the type table, pure geometry and list helpers, and the one client
// of /map_objects/* and of the planner's zone_check / zone_op.
//
// Everything above the "client" line is pure and has no DOM and no ROS, so
// tools/test_map_objects.node.js runs it as it is.
//
// A robot without map_objects_server is a normal case: live() stays false, the
// editor works on the owners' lists as it always did, and everything that only
// the server can do says so instead of failing.
window.VTMapObjects = (function () {
    'use strict';

    // type -> family (who owns the file), geometry, tool group, icon. The tool
    // groups are the owner's split: "fix" corrects what the map shows, "meaning"
    // says what a place is and what holds there.
    var TYPES = {
        zone:     { family: 'zone',     geometry: 'area',  group: 'objects', ico: 'la-object-group' },
        waypoint: { family: 'waypoint', geometry: 'point', group: 'objects', ico: 'la-map-marker' },
        path:     { family: 'path',     geometry: 'line',  group: 'objects', ico: 'la-road' },
        obstacle: { family: 'edit',     geometry: 'area',  group: 'fix',     ico: 'la-square' },
        free:     { family: 'edit',     geometry: 'area',  group: 'fix',     ico: 'la-square-o' },
        wall:     { family: 'edit',     geometry: 'line',  group: 'fix',     ico: 'la-minus' },
        place:    { family: 'place',    geometry: 'area',  group: 'meaning', ico: 'la-home' },
        landmark: { family: 'place',    geometry: 'point', group: 'meaning', ico: 'la-map-pin' },
        nogo:     { family: 'place',    geometry: 'area',  group: 'meaning', ico: 'la-ban', rule: true },
        slow:     { family: 'place',    geometry: 'area',  group: 'meaning', ico: 'la-tachometer', rule: true },
        noblade:  { family: 'place',    geometry: 'area',  group: 'meaning', ico: 'la-scissors', rule: true },
        corridor: { family: 'place',    geometry: 'line',  group: 'meaning', ico: 'la-arrows-h' },
    };
    var TEMPORARY = { nogo: true, slow: true, noblade: true };
    var SPEED_MIN = 0.05, SPEED_MAX = 0.40, SPEED_DEF = 0.20;
    var CUT_MIN = 20, CUT_MAX = 80;
    var MIN_AREA = 0.05;
    var CORRIDOR_W = 0.6;

    // ---- geometry: points are [x, y] in metres
    function polyArea(pts) {
        var total = 0;
        for (var i = 0; i < pts.length; i++) {
            var a = pts[i], b = pts[(i + 1) % pts.length];
            total += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(total / 2);
    }
    function lineLength(pts) {
        var total = 0;
        for (var i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        return total;
    }
    function perimeter(pts) {
        return pts.length < 2 ? 0 : lineLength(pts) + (pts.length > 2
            ? Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) : 0);
    }
    function nearestOnSeg(p, a, b) {
        var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        var u = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
        return [a[0] + u * dx, a[1] + u * dy];
    }

    // The nearest vertex within tol wins over any edge: a corner is what one
    // aims at. sets: [{pts, closed}]. -> {x, y, kind} or null.
    function snapPoint(p, sets, tol) {
        var q = [p.x, p.y], best = null, bestD = tol, i, s;
        for (s = 0; s < sets.length; s++) {
            var ps = sets[s].pts;
            for (i = 0; i < ps.length; i++) {
                var d = Math.hypot(ps[i][0] - q[0], ps[i][1] - q[1]);
                if (d <= bestD) { bestD = d; best = { x: ps[i][0], y: ps[i][1], kind: 'vertex' }; }
            }
        }
        if (best) return best;
        bestD = tol;
        for (s = 0; s < sets.length; s++) {
            var pe = sets[s].pts, n = pe.length, edges = sets[s].closed ? n : n - 1;
            if (n < 2) continue;
            for (i = 0; i < edges; i++) {
                var c = nearestOnSeg(q, pe[i], pe[(i + 1) % n]);
                var de = Math.hypot(c[0] - q[0], c[1] - q[1]);
                if (de <= bestD) { bestD = de; best = { x: c[0], y: c[1], kind: 'edge' }; }
            }
        }
        return best;
    }

    // Douglas-Peucker, for a driven trace. The ends stay.
    function simplify(pts, tol) {
        if (pts.length < 3) return pts.slice();
        var keep = new Array(pts.length), stack = [[0, pts.length - 1]], i;
        keep[0] = keep[pts.length - 1] = true;
        while (stack.length) {
            var r = stack.pop(), far = -1, farD = tol;
            for (i = r[0] + 1; i < r[1]; i++) {
                var c = nearestOnSeg(pts[i], pts[r[0]], pts[r[1]]);
                var d = Math.hypot(c[0] - pts[i][0], c[1] - pts[i][1]);
                if (d > farD) { farD = d; far = i; }
            }
            if (far >= 0) { keep[far] = true; stack.push([r[0], far], [far, r[1]]); }
        }
        return pts.filter(function (p, k) { return keep[k]; });
    }

    // Trace by driving: takes robot positions, keeps one per stepM metres. It
    // only records; nothing in here or around it sends anything to the robot.
    function TraceSampler(stepM) {
        this.step = stepM || 0.2;
        this.pts = [];
    }
    TraceSampler.prototype.add = function (x, y) {
        if (!isFinite(x) || !isFinite(y)) return false;
        var last = this.pts[this.pts.length - 1];
        if (last && Math.hypot(x - last[0], y - last[1]) < this.step) return false;
        this.pts.push([x, y]);
        return true;
    };

    // Labels that would overlap on screen: the first in priority order stays.
    // items: [{x, y, w, h, prio, order, cand}] centres and sizes in pixels. -> kept items.
    // cand (optional): [[dx, dy], ...] other places to try, in order, when the
    // first one is taken; a kept item gets the offset it landed on as it.dx, it.dy.
    // block (optional): boxes {x, y, w, h} nothing may cover (the dots of points).
    function declutter(items, pad, block) {
        var m = pad || 0, kept = [], taken = (block || []).slice();
        function free(x, y, it) {
            return taken.every(function (k) {
                return Math.abs(k.x - x) * 2 >= k.w + it.w + m * 2 || Math.abs(k.y - y) * 2 >= k.h + it.h + m * 2;
            });
        }
        var sorted = items.slice().sort(function (a, b) { return a.prio - b.prio || (a.order || 0) - (b.order || 0); });
        sorted.forEach(function (it) {
            var cand = it.cand && it.cand.length ? it.cand : [[0, 0]];
            for (var i = 0; i < cand.length; i++) {
                var x = it.x + cand[i][0], y = it.y + cand[i][1];
                if (!free(x, y, it)) continue;
                it.dx = cand[i][0]; it.dy = cand[i][1];
                kept.push(it);
                taken.push({ x: x, y: y, w: it.w, h: it.h });
                return;
            }
        });
        return kept;
    }

    // ---- object helpers
    function isTemporary(o) { return !!(o && (o.valid_from != null || o.valid_until != null)); }
    // The server computes `active`; the time window only says which kind of
    // inactive it is.
    function ruleState(o, nowS) {
        var temp = isTemporary(o);
        if (temp && o.valid_from != null && nowS < o.valid_from) return { state: 'scheduled', temporary: true };
        if (temp && o.valid_until != null && nowS >= o.valid_until) return { state: 'expired', temporary: true };
        return { state: (o && o.active === false) ? 'inactive' : 'active', temporary: temp };
    }
    function parseList(s) {
        var seen = {}, out = [];
        String(s == null ? '' : s).split(',').forEach(function (x) {
            var v = x.trim();
            if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); }
        });
        return out;
    }
    // <input type="datetime-local"> speaks local time without a zone.
    function toLocalInput(ts) {
        if (ts == null || !isFinite(ts)) return '';
        var d = new Date(ts * 1000);
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function fromLocalInput(s) {
        if (!s) return null;
        var t = new Date(s).getTime();
        return isFinite(t) ? t / 1000 : null;
    }
    function clampSpeed(v) {
        var n = parseFloat(v);
        return isFinite(n) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, n)) : SPEED_DEF;
    }
    // 0 means "not set" in stored zones; it stays what it is.
    function clampCut(v) {
        var n = parseInt(v, 10);
        return !isFinite(n) ? n : (n === 0 ? 0 : Math.min(CUT_MAX, Math.max(CUT_MIN, n)));
    }
    // Search over everything a person calls an object by.
    function matches(row, q, filter) {
        if (filter && filter !== 'all' && row.type !== filter) return false;
        var s = String(q || '').trim().toLowerCase();
        if (!s) return true;
        var hay = [row.name, row.note, row.category].concat(row.aliases || [], row.tags || []).join(' ').toLowerCase();
        return s.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
    }
    // What a save needs of the fields that hold meaning. -> only what differs.
    function metaChanges(before, now) {
        var out = {}, props = {};
        ['note', 'aliases', 'tags', 'valid_from', 'valid_until'].forEach(function (k) {
            if (JSON.stringify(before[k]) !== JSON.stringify(now[k])) out[k] = now[k];
        });
        var pa = before.props || {}, pb = now.props || {};
        Object.keys(pb).forEach(function (k) {
            if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) props[k] = pb[k];
        });
        if (Object.keys(props).length) out.props = props;
        return out;
    }
    // Undo of a delete from its toast: history undo only while that delete is
    // still the newest step, otherwise the whole object is saved back.
    function undoPlan(history, id) {
        var e = (history && history.entries) || [];
        var last = e.length ? e[e.length - 1] : null;
        return (last && last.op === 'delete' && last.id === id) ? 'undo' : 'save';
    }
    // Planner notes of a start: one row per program, zone and code, whichever of
    // the state topics brought it. -> rows + new ones, nothing twice.
    function mergeNotes(rows, add) {
        function key(n) { return [n.program, n.zone, n.code].join('|'); }
        var seen = {}, out = [];
        rows.concat(add || []).forEach(function (n) {
            if (n && !seen[key(n)]) { seen[key(n)] = 1; out.push(n); }
        });
        return out;
    }
    // The planner writes both languages; with several programs each row says whose.
    function notesText(rows, lang) {
        var many = {};
        rows.forEach(function (n) { many[n.program] = 1; });
        many = Object.keys(many).length > 1;
        return rows.map(function (n) {
            var text = (lang === 'cs' ? n.text_cs : n.text_en) || n.text_en || n.code;
            return many ? n.program + ': ' + text : text;
        }).join(' · ');
    }
    // A protected object per the server, or by name until a site is migrated.
    function isProtectedName(name) {
        return ['dock', 'undock', 'docked'].indexOf(String(name).toLowerCase()) >= 0;
    }
    function isProtected(o, name) { return !!(o && o.protected) || isProtectedName(name); }

    // ===================================================================== client
    var OP_TIMEOUT_MS = 8000;
    var _ros = null, _pubOp = null, _pending = {}, _reqN = 0;
    var _subs = [], _listeners = [];
    var state = { objects: [], seq: 0, site: '', history: null, suggestions: [], live: false };

    function emit(what) {
        _listeners.slice().forEach(function (f) { try { f(what); } catch (e) { console.error(e); } });
    }
    function onChange(f) { _listeners.push(f); }
    function nextReq() { _reqN += 1; return 'ui' + Date.now().toString(36) + '_' + _reqN; }
    function jsonOf(msg) { try { return JSON.parse(msg.data); } catch (e) { return null; } }
    function sub(ros, name, cb) {
        var t = new ROSLIB.Topic({ ros: ros, name: name, messageType: 'std_msgs/String' });
        t.subscribe(function (m) { var d = jsonOf(m); if (d) cb(d); });
        return t;
    }
    function settle(r) {
        var p = r && _pending[r.req];
        if (!p) return;
        delete _pending[r.req];
        clearTimeout(p.timer);
        if (p.cb) p.cb(r);
    }
    function start(ros) {
        if (!ros || _ros === ros) return;
        _ros = ros;
        _subs.push(sub(ros, '/map_objects/objects', function (d) {
            state.objects = Array.isArray(d.objects) ? d.objects : [];
            state.seq = d.seq || 0; state.site = d.site || '';
            state.live = true;
            emit('objects');
        }));
        _subs.push(sub(ros, '/map_objects/history', function (d) { state.history = d; emit('history'); }));
        _subs.push(sub(ros, '/map_objects/suggestions', function (d) {
            state.suggestions = Array.isArray(d) ? d : (Array.isArray(d.suggestions) ? d.suggestions : []);
            emit('suggestions');
        }));
        _subs.push(sub(ros, '/map_objects/result', settle));
        _subs.push(sub(ros, '/web_plan/zone_check_result', settle));
        _subs.push(sub(ros, '/web_plan/zone_op_result', settle));
    }
    function live() { return state.live; }
    function find(family, name) {
        for (var i = 0; i < state.objects.length; i++) {
            var o = state.objects[i];
            if (o.family === family && o.name === name) return o;
        }
        return null;
    }
    function findId(id) {
        for (var i = 0; i < state.objects.length; i++) if (state.objects[i].id === id) return state.objects[i];
        return null;
    }
    function places() { return state.objects.filter(function (o) { return o.family === 'place'; }); }
    function send(topicName, payload, cb, timeoutMs) {
        if (!_ros) { if (cb) cb({ ok: false, reason: null, timeout: true }); return null; }
        var topic = send._t[topicName];
        if (!topic) {
            topic = send._t[topicName] = new ROSLIB.Topic({ ros: _ros, name: topicName, messageType: 'std_msgs/String' });
            topic.advertise();
        }
        payload.req = nextReq();
        var entry = { cb: cb, timer: null };
        entry.timer = setTimeout(function () {
            if (_pending[payload.req] !== entry) return;
            delete _pending[payload.req];
            if (cb) cb({ req: payload.req, ok: false, reason: null, timeout: true });
        }, timeoutMs || OP_TIMEOUT_MS);
        _pending[payload.req] = entry;
        topic.publish(new ROSLIB.Message({ data: JSON.stringify(payload) }));
        return payload.req;
    }
    send._t = {};
    function op(payload, cb) {
        payload.actor = 'owner';
        return send('/map_objects/op', payload, cb);
    }
    // Asked again as the shape changes: only the newest question counts.
    var _checkReq = null;
    function zoneCheck(points, settings, name, cb) {
        var req = send('/web_plan/zone_check', { points: points, settings: settings, name: name || '' }, function (r) {
            if (r.req === _checkReq && !r.cancelled) cb(r);
        }, 20000);
        _checkReq = req;
    }
    function zoneOp(payload, cb) { return send('/web_plan/zone_op', payload, cb, 25000); }
    // World layers cost a big message: subscribed only while shown.
    function subscribeLayer(kind, cb) {
        if (!_ros) return null;
        return sub(_ros, '/map_objects/layer/' + kind, cb);
    }

    return {
        TYPES: TYPES, TEMPORARY: TEMPORARY, SPEED_MIN: SPEED_MIN, SPEED_MAX: SPEED_MAX, SPEED_DEF: SPEED_DEF,
        CUT_MIN: CUT_MIN, CUT_MAX: CUT_MAX, MIN_AREA: MIN_AREA, CORRIDOR_W: CORRIDOR_W,
        polyArea: polyArea, lineLength: lineLength, perimeter: perimeter, snapPoint: snapPoint,
        simplify: simplify, TraceSampler: TraceSampler, declutter: declutter,
        isTemporary: isTemporary, ruleState: ruleState, parseList: parseList,
        toLocalInput: toLocalInput, fromLocalInput: fromLocalInput, clampSpeed: clampSpeed, clampCut: clampCut,
        matches: matches, metaChanges: metaChanges, undoPlan: undoPlan, mergeNotes: mergeNotes, notesText: notesText,
        isProtected: isProtected, isProtectedName: isProtectedName,
        state: state, start: start, live: live, onChange: onChange, find: find, findId: findId, places: places,
        _emit: emit,   // diagnostics, tests
        op: op, zoneCheck: zoneCheck, zoneOp: zoneOp, subscribeLayer: subscribeLayer,
    };
})();
