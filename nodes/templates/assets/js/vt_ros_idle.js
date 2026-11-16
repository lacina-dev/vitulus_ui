/* vt_ros_idle.js — heavy rosbridge subscriptions rest while nobody can see them (T39).
 *
 * rosbridge on the robot's computer converts and compresses every message for
 * every subscription of every open page, seen or not: the scan (10 Hz), the
 * clouds (15 Hz), the 2 MB base map, /diagnostics (16 Hz). A browser tab in
 * the background, a hidden layer or a closed panel paid the same as the one
 * on screen. A subscription registered here is taken off the server while
 *   - the tab is hidden (after HIDE_MS, so a quick switch costs nothing), or
 *   - its own "is it on screen" test says no (a layer switch, a closed panel),
 * and put back the moment it can be seen again. The listeners stay on the
 * ROSLIB.Topic the whole time (Topic.unsubscribe() without a callback only
 * tells the server), so the layer keeps its state and its last picture.
 *
 *   VTRosIdle.add(name, topicFn, visibleFn)
 *       topicFn()   -> the ROSLIB.Topic now (ROS3D clients replace theirs)
 *       visibleFn() -> optional; false = nobody can see it
 *   VTRosIdle.sync()        look now (call after a layer switch)
 *   VTRosIdle.state()       [{name, on, paused}] for tests and the console
 *
 * Only what this module paused is ever subscribed again: a topic the page
 * itself unsubscribed stays off. Nothing of safety or control is registered
 * here (STOP, motors, blade, joystick, dock) — see map_view.js.
 */
(function () {
    'use strict';
    var HIDE_MS = 10000;     // hidden this long before anything is taken off
    var LOOK_MS = 2000;      // how often the "on screen" tests are asked
    var items = [];
    var hiddenAt = document.hidden ? Date.now() - HIDE_MS : 0;

    function tabGone() { return document.hidden && hiddenAt && Date.now() - hiddenAt >= HIDE_MS; }
    function wanted(it) {
        if (tabGone()) { return false; }
        if (document.hidden) { return !it.paused; }   // hidden a moment: leave things as they are
        if (!it.visible) { return true; }
        try { return !!it.visible(); } catch (e) { return true; }
    }
    function sync() {
        items.forEach(function (it) {
            var t = null;
            try { t = it.topic(); } catch (e) { t = null; }
            if (!t || typeof t.unsubscribe !== 'function') { return; }
            var on = wanted(it);
            if (!on && t.subscribeId) {
                t.unsubscribe();            // the server stops sending; listeners stay
                it.paused = true;
            } else if (on && it.paused) {
                it.paused = false;
                if (!t.subscribeId) { t.subscribe(); }
            }
        });
    }
    function add(name, topicFn, visibleFn) {
        items.push({ name: name, topic: topicFn, visible: visibleFn || null, paused: false });
        sync();
    }
    function state() {
        return items.map(function (it) {
            var t = null;
            try { t = it.topic(); } catch (e) { t = null; }
            return { name: it.name, on: !!(t && t.subscribeId), paused: it.paused };
        });
    }
    document.addEventListener('visibilitychange', function () {
        hiddenAt = document.hidden ? Date.now() : 0;
        if (document.hidden) { setTimeout(sync, HIDE_MS + 50); } else { sync(); }
    });
    setInterval(sync, LOOK_MS);

    window.VTRosIdle = { add: add, sync: sync, state: state, HIDE_MS: HIDE_MS };
})();
