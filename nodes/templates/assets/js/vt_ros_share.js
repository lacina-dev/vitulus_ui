/* vt_ros_share.js — one rosbridge subscription (and one advertisement) per topic
 * and connection, also after any number of reconnects (T8 D11, 2026-11-08).
 *
 * Why: the page builds several ROSLIB.Topic objects for the same topic (the
 * header, the right panel, the autonomy card… each its own), and roslib sends
 * one `subscribe` per object. rosbridge merges them per topic anyway (one copy
 * of each message, throttle = the lowest, queue = the lowest, compression =
 * the strongest), so the extra ones only cost ops, log lines and server work —
 * up to 3x per topic on every connection in the D10 review (rosbridge log:
 * "[Client N] Subscribed to /mower_smach/active_program" 3x per client).
 * roslib's own resubscribe-on-close is also fragile: a Topic that both
 * subscribes and advertises shares one `waitForReconnect` flag (one of the two
 * is not re-sent), and after unsubscribe() it removes only the LAST close
 * handler, so an unsubscribed topic can come back on the next reconnect.
 *
 * What this does (loaded right after roslib.js, before any Topic exists):
 * Topic.subscribe / unsubscribe / advertise / unadvertise are replaced. Per
 * ROSLIB.Ros and topic name there is one "share": the Topic objects in it, one
 * wire id, and the socket the op was last sent on. The op goes out
 *   - when the first Topic joins (if the link is up),
 *   - again, with the SAME id, when a later Topic joins a share already sent
 *     on this socket: rosbridge then only rewrites that id's entry (still one
 *     subscription on the wire) but hands out a LATCHED topic's last message
 *     once more — so a module that subscribes later still gets the value, as
 *     it did with its own subscribe before (D11 review: Camera card got no
 *     /depth_obstacles/config and said "not answering"); every member hears
 *     that copy, exactly like before, when each Topic had its own id;
 *   - once on every new socket (the Ros 'connection' event; ros.socket is a new
 *     object after each connect), never twice on the same socket otherwise;
 * the closing op goes out when the last Topic leaves. The wire parameters are
 * the merge rosbridge itself would make (rosbridge_library subscribe.py
 * update_params), re-sent with the same id when the merge changes, so what the
 * server streams is exactly what it streamed before. Messages still reach every
 * Topic through ros.on(name), as in roslib; publish() is unchanged (it calls
 * advertise() when the Topic is not advertised yet).
 *
 * window.VTRosShare.stats(ros) -> {subs: {topic: members}, advs: {topic: members}}
 */
(function () {
    'use strict';
    if (!window.ROSLIB || !ROSLIB.Topic || !ROSLIB.Topic.prototype) { return; }
    var T = ROSLIB.Topic.prototype;
    var COMP = { 'none': 0, 'png': 1, 'cbor': 2, 'cbor-raw': 3 };

    function reg(ros) {
        if (ros.__vtShare) { return ros.__vtShare; }
        var R = ros.__vtShare = { subs: {}, advs: {}, n: 0 };
        // On every new socket: each live share once (insertion order = the order
        // the page subscribed in; advertisements first so a publish queued while
        // the link was down never runs ahead of its advertise).
        ros.on('connection', function () {
            Object.keys(R.advs).forEach(function (k) { sendAdv(ros, R.advs[k]); });
            Object.keys(R.subs).forEach(function (k) { sendSub(ros, R.subs[k]); });
        });
        return R;
    }

    function up(ros) { return !!(ros.isConnected && ros.socket); }

    function subParams(sh) {
        var thr = null, q = null, comp = 'none', type = null;
        sh.members.forEach(function (t) {
            thr = thr === null ? t.throttle_rate : Math.min(thr, t.throttle_rate);
            q = q === null ? t.queue_length : Math.min(q, t.queue_length);
            if ((COMP[t.compression] || 0) > (COMP[comp] || 0)) { comp = t.compression; }
            if (!type && t.messageType) { type = t.messageType; }
        });
        return { type: type, throttle_rate: thr || 0, queue_length: q || 0, compression: comp };
    }

    function sendSub(ros, sh, force) {
        if (!sh.members.length || !up(ros)) { return; }
        var p = subParams(sh), key = JSON.stringify(p);
        if (sh.sentOn === ros.socket && sh.sentKey === key && !force) { return; }
        sh.sentOn = ros.socket; sh.sentKey = key;
        ros.callOnConnection({ op: 'subscribe', id: sh.id, type: p.type, topic: sh.name,
                               compression: p.compression, throttle_rate: p.throttle_rate,
                               queue_length: p.queue_length });
    }

    function sendAdv(ros, sh) {
        if (!sh.members.length || !up(ros) || sh.sentOn === ros.socket) { return; }
        var t = sh.members[0];
        sh.sentOn = ros.socket;
        ros.callOnConnection({ op: 'advertise', id: sh.id, type: t.messageType, topic: sh.name,
                               latch: t.latch, queue_size: t.queue_size });
    }

    T.subscribe = function (callback) {
        if (typeof callback === 'function') { this.on('message', callback); }
        if (this.subscribeId) { return; }
        var ros = this.ros, R = reg(ros), sh = R.subs[this.name];
        if (!sh) {
            sh = R.subs[this.name] = { name: this.name, members: [], sentOn: null, sentKey: null,
                                       id: 'subscribe:' + this.name + ':' + (++ros.idCounter) };
        }
        ros.on(this.name, this._messageCallback);
        this.subscribeId = sh.id;
        // a later member of a share already on this socket: the same id again,
        // so rosbridge hands out a latched value to it too (see the head)
        var late = sh.members.length > 0 && sh.sentOn === ros.socket;
        sh.members.push(this);
        sendSub(ros, sh, late);
    };

    T.unsubscribe = function (callback) {
        if (callback) {
            this.off('message', callback);
            // other callbacks still listen: the topic stays
            if (this.listeners('message').length) { return; }
        }
        if (!this.subscribeId) { return; }
        var ros = this.ros, R = reg(ros), sh = R.subs[this.name];
        ros.off(this.name, this._messageCallback);
        this.emit('unsubscribe');
        this.subscribeId = null;
        if (!sh) { return; }
        var i = sh.members.indexOf(this);
        if (i >= 0) { sh.members.splice(i, 1); }
        if (sh.members.length) { sendSub(ros, sh); return; }   // the merge may change
        delete R.subs[this.name];
        if (up(ros) && sh.sentOn === ros.socket) {
            ros.callOnConnection({ op: 'unsubscribe', id: sh.id, topic: sh.name });
        }
    };

    T.advertise = function () {
        if (this.isAdvertised) { return; }
        var ros = this.ros, R = reg(ros), sh = R.advs[this.name];
        if (!sh) {
            sh = R.advs[this.name] = { name: this.name, members: [], sentOn: null,
                                       id: 'advertise:' + this.name + ':' + (++ros.idCounter) };
        }
        this.advertiseId = sh.id;
        this.isAdvertised = true;
        sh.members.push(this);
        sendAdv(ros, sh);
    };

    T.unadvertise = function () {
        if (!this.isAdvertised) { return; }
        var ros = this.ros, R = reg(ros), sh = R.advs[this.name];
        this.emit('unadvertise');
        this.isAdvertised = false;
        if (!sh) { return; }
        var i = sh.members.indexOf(this);
        if (i >= 0) { sh.members.splice(i, 1); }
        if (sh.members.length) { return; }
        delete R.advs[this.name];
        if (up(ros) && sh.sentOn === ros.socket) {
            ros.callOnConnection({ op: 'unadvertise', id: sh.id, topic: sh.name });
        }
    };

    window.VTRosShare = {
        stats: function (ros) {
            var R = ros && ros.__vtShare, out = { subs: {}, advs: {} };
            if (!R) { return out; }
            Object.keys(R.subs).forEach(function (k) { out.subs[k] = R.subs[k].members.length; });
            Object.keys(R.advs).forEach(function (k) { out.advs[k] = R.advs[k].members.length; });
            return out;
        }
    };
})();
