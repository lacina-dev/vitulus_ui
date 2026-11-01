// vt_planner_settings.js — Settings › Navi › Planner: the planner's stored data
// and map assembly, which used to sit at the bottom of the map editor. They work
// without the editor being open, so this has its own topics, created the first
// time the section opens.
(function () {
    'use strict';
    function $(id) { return document.getElementById(id); }
    function ros() { return (window.ros && window.ros.ros) || null; }
    var topics = {};
    function pub(name, type) {
        var r = ros();
        if (!r) return null;
        if (!topics[name]) {
            topics[name] = new ROSLIB.Topic({ ros: r, name: name, messageType: type });
            topics[name].advertise();
        }
        return topics[name];
    }
    function pulse(name) {
        var p = pub(name, 'std_msgs/Bool');
        if (p) p.publish(new ROSLIB.Message({ data: true }));
    }
    var opened = false;
    function firstOpen() {
        var r = ros();
        if (opened || !r) return;
        opened = true;
        new ROSLIB.Topic({ ros: r, name: '/web_plan/log', messageType: 'std_msgs/String' }).subscribe(function (m) {
            var d = $('div_log');
            if (d) d.textContent = m.data;
        });
        new ROSLIB.Topic({ ros: r, name: '/web_plan/map_data', messageType: 'vitulus_msgs/MapEditMap' }).subscribe(function (m) {
            $('input_obstacle_margin').value = m.margin;
            $('input_fill_free').value = m.fill;
            $('input_fill_shape').value = m.shape;
        });
        pulse('/web_plan/republish');   // the current margin / fill / shape
    }
    function stroke(v) {
        window.__coverage_stroke = v;
        if (window.mapEditCoverageStroke) window.mapEditCoverageStroke(v);
    }
    function wire() {
        var sec = document.querySelector('details[data-drawersec="planner_adv"]');
        if (!sec) return;
        sec.addEventListener('toggle', function () { if (sec.open) firstOpen(); });
        if (sec.open) setTimeout(firstOpen, 2000);
        $('btn_save_planner_data').addEventListener('click', function () { pulse('/web_plan/save_planner_data'); });
        $('btn_load_planner_data').addEventListener('click', function () { pulse('/web_plan/load_planner_data'); });
        $('btn_reload_map').addEventListener('click', function () { pulse('/web_plan/reload_map'); });
        $('btn_assemble_map').addEventListener('click', function () {
            var p = pub('/web_plan/assemble_map', 'vitulus_msgs/MapEditMap');
            if (p) p.publish(new ROSLIB.Message({
                name: '', fill: parseInt($('input_fill_free').value),
                margin: parseFloat($('input_obstacle_margin').value), shape: $('input_fill_shape').value,
            }));
        });
        $('btn_path_thin').addEventListener('click', function () { stroke(0.03); });
        $('btn_path_footprint').addEventListener('click', function () { stroke(0.45); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
