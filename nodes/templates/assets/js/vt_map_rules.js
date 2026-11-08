// vt_map_rules.js — the banner of the map rules, everywhere in the UI, not only
// in the editor: the human joystick is never blocked (docs/MAP_OBJECTS.md §5), so
// this is what tells a person they drove into a no-go. Reads /map_rules/state and
// /map_rules/warning (map_rules_guard); silent topics show nothing.
(function () {
    'use strict';
    var WARN_MS = 15000;
    var state = null, warning = null, warnTimer = null, el = null;
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function jsonOf(m) { try { return JSON.parse(m.data); } catch (e) { return null; } }
    function editing() {
        var c = window.__map_overlay;
        return !!(c && c.editing);
    }
    function names(list, type) {
        return (list || []).filter(function (x) { return x && x.type === type; })
            .map(function (x) { return x.name; }).join(', ');
    }
    // Outside the zone it mows the program drives with the blade stopped (the
    // guard's zone fence): normal, no banner; only in the editor, as info.
    function outsideZone(s) {
        return s.blade === 'stopped_by_rule' && s.held_by === 'zone' && !names(s.in, 'noblade');
    }
    // What needs a person now: red first. In the editor also what is near.
    function current() {
        var s = state || {}, inNogo = names(s.in, 'nogo');
        if (warning && warning.type === 'dock') return { tone: 'err', text: t('maprules.dock_blocked', { name: warning.name || '' }) };
        if (warning && warning.type === 'nogo') return { tone: 'err', text: t('maprules.in_nogo', { name: warning.name || '' }) };
        if (warning && warning.text) return { tone: 'warn', text: warning.text };
        if (inNogo) return { tone: 'err', text: t('maprules.in_nogo', { name: inNogo }) };
        if (s.blade === 'stopped_by_rule' && !outsideZone(s)) {
            var nb = names(s.in, 'noblade');
            return { tone: 'warn', text: nb ? t('maprules.blade_stopped', { name: nb }) : t('maprules.blade_stopped_any') };
        }
        if (s.blade === 'restore_failed') return { tone: 'err', text: t('maprules.blade_failed') };
        if (!editing()) return null;
        var near = names(s.near, 'nogo'), slow = names(s.in, 'slow');
        if (near) return { tone: 'warn', text: t('maprules.near_nogo', { name: near }) };
        if (slow) return { tone: 'info', text: t('maprules.in_slow', { name: slow }) };
        if (outsideZone(s)) return { tone: 'info', text: t('maprules.blade_outside_zone', { name: (s.zone && s.zone.name) || '' }) };
        return null;
    }
    function paint() {
        var c = current();
        if (!el) {
            if (!c) return;
            el = document.createElement('div');
            el.id = 'vt_maprule_banner';
            el.className = 'vt-attn';
            el.setAttribute('role', 'alert');
            el.innerHTML = '<span class="vt-attn-lab"></span><span class="vt-attn-txt"></span>';
            document.body.appendChild(el);
        }
        el.style.display = c ? '' : 'none';
        if (!c) return;
        el.setAttribute('data-state', c.tone);
        el.querySelector('.vt-attn-lab').textContent = t('maprules.label');
        var tx = el.querySelector('.vt-attn-txt');
        tx.textContent = c.text;
        tx.title = c.text;
    }
    function start(ros) {
        new ROSLIB.Topic({ ros: ros, name: '/map_rules/state', messageType: 'std_msgs/String' }).subscribe(function (m) {
            state = jsonOf(m);
            paint();
        });
        new ROSLIB.Topic({ ros: ros, name: '/map_rules/warning', messageType: 'std_msgs/String' }).subscribe(function (m) {
            var w = jsonOf(m);
            if (!w) return;
            warning = w;
            if (warnTimer) clearTimeout(warnTimer);
            warnTimer = setTimeout(function () { warning = null; paint(); }, WARN_MS);
            paint();
        });
        if (window.VTMapObjects) VTMapObjects.start(ros);
    }
    var tries = setInterval(function () {
        var ros = window.ros && window.ros.ros;
        if (!ros || !window.ROSLIB) return;
        clearInterval(tries);
        start(ros);
    }, 500);
    if (window.VTI18n) VTI18n.onChange(paint);
    window.VTMapRules = { refresh: paint };
})();
