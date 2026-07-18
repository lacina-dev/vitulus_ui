// vitulus_ui: was `window.onload`; converted to a named initialiser invoked
// lazily by app.js the first time the Planner section is shown. It is called as
// `window.initPlanner()` so that inside this function `this === window`, which
// the inline onclick handlers (editPoly/removeZone/runProgram/...) rely on:
// they are defined as `this.xxx = ...` and must end up on `window`.
window.initPlanner = function(opts) {

    console.log("START");
    // vitulus_ui: `opts` lets the planner run INTEGRATED into the map view —
    // editing directly on map_view's live 3D scene (top-down) instead of its own
    // page. In that mode the caller supplies a shared rosbridge connection
    // (opts.ros) and an overlay that mirrors Planner3D.Viewer + the grid client
    // (opts.overlay). Without opts it behaves like the old standalone planner.
    opts = opts || {};
    var integrated = !!opts.overlay;

    var ros;
    if (opts.ros) ros = opts.ros;
    else ros = new ROSLIB.Ros({url: "ws://" + location.hostname + ":9090"});
    // Set true once the backend's zone/polygon lists have been received at least
    // once (see requestInitialData below).
    var initial_lists_received = false;   // zone_list received
    var initial_polys_received = false;   // polygon_list received (separate one-shot)

    let active_map_file_name = "";


    // 2D view  ////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    var viewer;
    var gridClient;
    var wait_for_map = true;
    var width = 700;
    var height = 700;
    scale_plus_btn = document.getElementById("scale_plus");
    scale_minus_btn = document.getElementById("scale_minus");
    div_map = document.getElementById("map");
    div_map_frame = document.getElementById("map_frame");
    // In integrated mode there is no dedicated #map div (we draw over the map
    // view's 3D canvas), so guard the size reads.
    div_map_width = div_map ? div_map.offsetWidth : 700;
    div_map_height = div_map ? div_map.offsetHeight : 700;
    var initiate = true;
    // console.log(div_map_width);
    // console.log(div_map_height);

    // vitulus_ui: the planner now renders with three.js (top-down orthographic)
    // instead of ros2d, so it shares the same 3D base as the map/IMU sections.
    // Planner3D exposes the same API surface ros2d did, so the zone/program/ROS
    // logic below is unchanged. World coordinates ARE ROS metres.

    if (integrated) {
        // Integrated: the overlay over map_view's 3D scene IS both the viewer
        // (PolygonEditor/PathLayer/attachInteraction target) and the grid-client
        // stand-in (rootObject.addChild / on('change')). The map itself is drawn
        // by map_view's own OccupancyGrid, so no MapLayer is created here.
        viewer = opts.overlay;
        gridClient = opts.overlay;
    } else {
        // Create the main viewer (replaces ROS2D.Viewer + Pan/Zoom views).
        viewer = new Planner3D.Viewer({
          divID : 'map',
          width : div_map_width,
          height : div_map_height,
          background: '#232f37'
        });

        // Grid client (replaces ROS2D.OccupancyGridClient).
        gridClient = new Planner3D.MapLayer({
          ros : ros,
          topic: '/web_plan/map_show',
          viewer : viewer,
          continuous: true
        });
    }

    // Coverage path overlay (replaces ROS2D.PathShape).
    var coveragePath = new Planner3D.PathLayer({
        strokeSize : 0.03,
        strokeColor : '#ff0000',
    });
    gridClient.rootObject.addChild(coveragePath);


    // Grid client on change: fit the view to the map the first time it loads
    // and whenever the active map changes (initiate is re-set on map change).
    gridClient.on('change', function() {
        if (initiate){
            resize();
            if (gridClient.bounds) viewer.frameTo(gridClient.bounds);
            initiate = false;
        }
    });

    function resize() {
        // Integrated mode has no #map div and the overlay sizes itself to the
        // map view's canvas, so there is nothing to resize here.
        if (integrated || !div_map) return;
        div_map_width = div_map.offsetWidth;
        div_map_height = div_map.offsetHeight;
        if (div_map_width > 0 && div_map_height > 0) {
            viewer.resize(div_map_width, div_map_height);
        }
    }


    window.addEventListener('resize', function(event){
        resize();
    });


    // Polygons ////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    var polygon_enabled = false
    var clickedPolygon = false;
    var selectedPointIndex = null;
    // Callback functions when there is mouse interaction with the polygon
    var pointCallBack = function(type, event, index) {
        if (polygon_enabled == false){
          if (type === 'mousedown') {
            if (event.nativeEvent.shiftKey === true) {
              polygon.remPoint(index);
            }
            else {
              selectedPointIndex = index;
            }
          }
          clickedPolygon = true;
        }
    };

    var lineCallBack = function(type, event, index) {
      if (type === 'mousedown') {
        if (event.nativeEvent.shiftKey === true) {
          polygon.splitLine(index);
        }
      }
      clickedPolygon = true;
    }

    // Create the polygon editor (replaces ROS2D.PolygonMarker). Starts detached;
    // editPoly/editZone/new-* attach it via viewer.scene.addChild(polygon).
    var polygon = new Planner3D.PolygonEditor({
      lineColor : '#6464ff',
      pointColor : '#ff3232',
      fillColor : '#37c837',
      pointPx : 7,
      pointCallBack : pointCallBack,
      lineCallBack : lineCallBack
    });

    // Mouse + touch interaction (replaces the ros2d stage handlers). Vertex/edge
    // hits drive the same pointCallBack/lineCallBack as before; an empty click
    // adds a point. Modifiers preserved: ctrl-drag (or two-finger) = pan,
    // alt-drag / wheel / pinch = zoom. selectedPointIndex (set by pointCallBack)
    // is the vertex-drag flag.
    Planner3D.attachInteraction(viewer, function(){ return polygon; }, {
        isEnabled:       function(){ return polygon.attached; },
        onVertexDown:    function(i, ev){ pointCallBack('mousedown', { nativeEvent: ev.nativeEvent || ev }, i); },
        onEdgeDown:      function(i, ev){ lineCallBack('mousedown', { nativeEvent: ev.nativeEvent || ev }, i); },
        onAddPoint:      function(world){ polygon.addPoint(world); },
        onMovePoint:     function(i, world){ polygon.movePoint(i, world); },
        onReleaseVertex: function(){ selectedPointIndex = null; },
        draggingVertex:  function(){ return selectedPointIndex !== null; },
        draggingIndex:   function(){ return selectedPointIndex; },
    });


    // Map tools ///////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Map edit log
    var div_log = document.getElementById("div_log")
    var logTopic = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/log',
        messageType: 'std_msgs/String'
    });
    logTopic.subscribe(function (message) {
        // console.log("MapEdit log:" + message.data);
        div_log.textContent = message.data;
    });

    input_obstacle_margin = document.getElementById("input_obstacle_margin");
    input_fill_free = document.getElementById("input_fill_free");
    input_fill_shape = document.getElementById("input_fill_shape");
    btn_assemble_map = document.getElementById("btn_assemble_map");


    // get map data
    function get_map_data() {
        var topic_map_data = new ROSLIB.Topic({
            ros: ros,
            name: '/web_plan/map_data',
            messageType: 'vitulus_msgs/MapEditMap'
        });
        topic_map_data.subscribe(function (message) {
            input_obstacle_margin.value = message.margin;
            input_fill_free.value = message.fill;
            input_fill_shape.value = message.shape;
        });
    }
    get_map_data();

    // assembly map
    function assemble_map() {
        var topic_assemble_map = new ROSLIB.Topic({
            ros: ros,
            name: '/web_plan/assemble_map',
            messageType: 'vitulus_msgs/MapEditMap'
        });
        topic_assemble_map.advertise();

        btn_assemble_map.onclick = function () {
            var msg = new ROSLIB.Message({
                // data : parseInt(input_draw_coverage.value),
                name: "",
                fill: parseInt(input_fill_free.value),
                margin: parseFloat(input_obstacle_margin.value),
                shape: input_fill_shape.value,
            });
            // console.log(msg)
            topic_assemble_map.publish(msg);
        };
    };
    assemble_map();


    // Map show ////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    function show_map() {
        var topic_show_fill_map = new ROSLIB.Topic({
            ros: ros,
            name: '/web_plan/show_map_layer',
            messageType: 'std_msgs/String'
        });
        topic_show_fill_map.advertise();

        // show free fill
        btn_show_fill = document.getElementById("btn_show_fill");
        btn_show_fill.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "filled",
            });
            topic_show_fill_map.publish(msg);
        }

        // show free poly
        btn_show_free_poly = document.getElementById("btn_show_free_poly");
        btn_show_free_poly.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "free_poly",
            });
            topic_show_fill_map.publish(msg);
        }

        // show obstacle poly
        btn_show_obstacles_poly = document.getElementById("btn_show_obstacles_poly");
        btn_show_obstacles_poly.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "obstacles_poly",
            });
            topic_show_fill_map.publish(msg);
        }

        // show assembled_lite
        btn_show_assembled_lite = document.getElementById("btn_show_assembled_lite");
        btn_show_assembled_lite.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "assembled_lite",
            });
            topic_show_fill_map.publish(msg);
        }

        // show original
        btn_show_original = document.getElementById("btn_show_original");
        btn_show_original.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "original",
            });
            topic_show_fill_map.publish(msg);
        }

        // show assembled
        btn_show_assembled = document.getElementById("btn_show_assembled");
        btn_show_assembled.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "assembled",
            });
            topic_show_fill_map.publish(msg);
        }

        // show zone map
        btn_show_zone_map = document.getElementById("btn_show_zone_map");
        btn_show_zone_map.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "zone_map",
            });
            topic_show_fill_map.publish(msg);
        }

        // show zone_border_path map
        btn_show_zone_border_path = document.getElementById("btn_show_zone_border_path");
        btn_show_zone_border_path.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "zone_border_path",
            });
            topic_show_fill_map.publish(msg);
        }

        // show zone_navi map
        btn_show_zone_navi = document.getElementById("btn_show_zone_navi");
        btn_show_zone_navi.onclick = function () {
            var msg = new ROSLIB.Message({
                data: "zone_navi",
            });
            topic_show_fill_map.publish(msg);
        }

    }
    show_map();


    // Polygons  ///////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    function map_polygons() {

        // Polygon elements
        var input_poly_template_name = document.getElementById("input_poly_template_name");
        var input_poly_template_type = document.getElementById("input_poly_template_type");
        var div_poly_list = document.getElementById("div_poly_list");
        div_poly_list.innerHTML = '';
        var btn_new_poly = document.getElementById("btn_new_poly");
        var btn_poly_template_save = document.getElementById("btn_poly_template_save");
        var btn_poly_template_cancel = document.getElementById("btn_poly_template_cancel");
        var div_poly_template = document.getElementById("div_poly_template");
        var div_poly_template_style_attr = div_poly_template.getAttribute('style');
        div_poly_template.setAttribute('style', div_poly_template_style_attr + 'display:none !important');

        // New polygon
        btn_new_poly.onclick = function() {
            div_poly_template.setAttribute('style', div_poly_template_style_attr + 'display:flex');
            viewer.scene.addChild(polygon);
        }

        // Cancel polygon
        btn_poly_template_cancel.onclick = function() {
            div_poly_template.setAttribute('style', div_poly_template_style_attr + 'display:none !important');
            viewer.scene.removeChild(polygon);
            polygon.pointContainer.children = [];
            polygon.lineContainer.children = [];
            polygon.fillShape.graphics._instructions = [];
            polygon.fillShape.graphics._oldInstructions = [];
        }

        // Save polygon
        var topic_save_poly = new ROSLIB.Topic({
                ros : ros,
                name : '/web_plan/save_polygon',
                messageType : 'vitulus_msgs/MapEditPolygon'
        });
        topic_save_poly.advertise();

        btn_poly_template_save.onclick = function() {
            // console.log(polygon.pointContainer.children.length);
            if (polygon.pointContainer.children.length > 0){
                var points = [];
                for (i in polygon.pointContainer.children){
                    points.push({x: polygon.pointContainer.children[i].x, y: polygon.pointContainer.children[i].y * -1});
                }
                // console.log(points);
                var msgPoly = new ROSLIB.Message({
                    header : {
                        frame_id : "map"
                    },
                    polygon : {
                        points : points
                    }
                });
                // console.log(msgPoly);
                var msg = new ROSLIB.Message({
                    header : {
                        frame_id : "map"
                    },
                    name: input_poly_template_name.value,
                    area: 0,
                    type: input_poly_template_type.value,
                    polygon : msgPoly
                });
                topic_save_poly.publish(msg);
                // console.log(msg);

                // clean up
                div_poly_template.setAttribute('style', div_poly_template_style_attr + 'display:none !important');
                viewer.scene.removeChild(polygon);
                polygon.pointContainer.children = [];
                polygon.lineContainer.children = [];
                polygon.fillShape.graphics._instructions = [];
                polygon.fillShape.graphics._oldInstructions = [];
            }else{
                div_log.textContent = "Draw the polygon on the map!";
            }
        }

        // Remove polygon from list by name
        var topic_remove_poly = new ROSLIB.Topic({
            ros : ros,
            name : '/web_plan/remove_polygon',
            messageType : 'std_msgs/String'
        });
        topic_remove_poly.advertise();

        this.removePoly = function(poly_name){
            let msg = new ROSLIB.Message({
                data : poly_name,
            });
            topic_remove_poly.publish(msg);
        }

        // Edit polygon from list by name
        this.editPoly = function(poly_name){
            for (let i in current_poly_list){
                if (current_poly_list[i].name === poly_name){
                    let poly = current_poly_list[i];
                    // console.log(poly);
                    div_poly_template.setAttribute('style', div_poly_template_style_attr + 'display:flex');
                    viewer.scene.removeChild(polygon);
                    polygon.pointContainer.children = [];
                    polygon.lineContainer.children = [];
                    polygon.fillShape.graphics._instructions = [];
                    polygon.fillShape.graphics._oldInstructions = [];
                    viewer.scene.addChild(polygon);
                    for (let point in poly.polygon.polygon.points){
                        // console.log("Point:");
                        // console.log(poly.polygon.polygon.points[point]);
                        polygon.addPoint(poly.polygon.polygon.points[point]);
                    }
                    input_poly_template_name.value = poly.name;
                    input_poly_template_type.value = poly.type;
                }
            }
        }

        // load polygon list
        var polyListTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/web_plan/polygon_list',
            messageType : 'vitulus_msgs/MapEditPolygonList'
        });

        var current_poly_list = [];
        polyListTopic.subscribe(function(message) {
            initial_polys_received = true;
            current_poly_list = message.polygon_list;
            var html_poly_list ='';
            for (let poly in message.polygon_list){
                let poly_name = message.polygon_list[poly].name;
                let poly_type = message.polygon_list[poly].type;
                html_poly_list += `
                    <div class="d-flex align-items-center" style="border-bottom: 1px solid #3a3f44;padding: 3px 2px;font-size: 12px;">
                        <span class="text-info text-truncate" style="flex: 1 1 auto;min-width: 0;" title="${poly_name}">${poly_name}</span>
                        <span class="text-light" style="width: 70px;">${poly_type}</span>
                        <div class="btn-group btn-group-sm" role="group" style="margin-left: 6px;">
                            <button id="btn_poly_edit" class="btn btn-outline-info" type="button" style="font-size: 11px;padding: 1px 8px;" onclick="editPoly(&#39;${poly_name}&#39;)">Edit</button>
                            <button id="btn_poly_remove" class="btn btn-outline-danger" type="button" style="font-size: 11px;padding: 1px 8px;" onclick="removePoly(&#39;${poly_name}&#39;)">Remove</button>
                        </div>
                    </div>
    `;
                div_poly_list.innerHTML = html_poly_list;
            }
            if (message.polygon_list.length == 0){
                div_poly_list.innerHTML = "";
            }
        });
        }
    map_polygons();


    // Zones     ///////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Zone elements
    var input_zone_template_name = document.getElementById("input_zone_template_name");
    var input_zone_template_cut_height = document.getElementById("input_zone_template_cut_height");
    var input_zone_template_rpm = document.getElementById("input_zone_template_rpm");
    var input_zone_template_border_path = document.getElementById("input_zone_template_border_path");
    var input_zone_template_coverage_path = document.getElementById("input_zone_template_coverage_path");
    var input_zone_template_path_distance = document.getElementById("input_zone_template_path_distance");
    var input_zone_template_simplify = document.getElementById("input_zone_template_simplify");
    var btn_new_zone = document.getElementById("btn_new_zone");
    var btn_zone_template_save = document.getElementById("btn_zone_template_save");
    var btn_zone_template_cancel = document.getElementById("btn_zone_template_cancel");
    var div_zone_template = document.getElementById("div_zone_template");
    var header_zone_template_coverage_path = document.getElementById("header_zone_template_coverage_path");
    var header_zone_template_border_path = document.getElementById("header_zone_template_border_path");
    var header_zone_template_path_list = document.getElementById("header_zone_template_path_list");
    var div_zone_list = document.getElementById("div_zone_list");

    // Init zone template
    var zone_template_style_attr = div_zone_template.getAttribute('style');
    var header_zone_template_coverage_path_style_attr = header_zone_template_coverage_path.getAttribute('style');
    var header_zone_template_border_path_style_attr = header_zone_template_border_path.getAttribute('style');
    div_zone_template.setAttribute('style', 'display:none !important');
    div_zone_list.innerHTML = "";
    var current_zone = null;


    // Zone ///////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // New zone
    btn_new_zone.onclick = function () {
        div_zone_template.setAttribute('style', zone_template_style_attr);
        input_zone_template_name.value = "Zone";
        input_zone_template_rpm.value = 3300;
        input_zone_template_cut_height.value = 45;
        input_zone_template_border_path.value = 2;
        input_zone_template_coverage_path.value = 160;
        input_zone_template_path_distance.value = 0.2;
        input_zone_template_simplify.value = 0.1;
        polygon.pointContainer.children = [];
        polygon.lineContainer.children = [];
        polygon.fillShape.graphics._instructions = [];
        polygon.fillShape.graphics._oldInstructions = [];
        viewer.scene.addChild(polygon);
    }

    // Selected zone topic
    var topic_selected_zone = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/selected_zone',
        messageType: 'std_msgs/String'
    });
    topic_selected_zone.advertise();

    // Cancel zone
    btn_zone_template_cancel.onclick = function () {
        div_zone_template.setAttribute('style', 'display:none !important');
        viewer.scene.removeChild(polygon);
        polygon.pointContainer.children = [];
        polygon.lineContainer.children = [];
        polygon.fillShape.graphics._instructions = [];
        polygon.fillShape.graphics._oldInstructions = [];
        let msg = new ROSLIB.Message({
            data: "cancel**cancel**"
        });
        topic_selected_zone.publish(msg);
    }

    // Save zone topic
    var topic_save_zone = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/save_zone',
        messageType: 'vitulus_msgs/MapEditZone'
    });
    topic_save_zone.advertise();

    // Save zone
    btn_zone_template_save.onclick = function () {
        // console.log(polygon.pointContainer.children.length);
        if (polygon.pointContainer.children.length > 0) {
            var points = [];
            for (i in polygon.pointContainer.children) {
                points.push({
                    x: polygon.pointContainer.children[i].x,
                    y: polygon.pointContainer.children[i].y * -1
                });
            }
            // console.log(points);
            var msgPoly = new ROSLIB.Message({
                header: {
                    frame_id: "map"
                },
                polygon: {
                    points: points
                }
            });
            // console.log(msgPoly);
            var msg = new ROSLIB.Message({
                header: {
                    frame_id: "map"
                },
                name: input_zone_template_name.value,
                area: 0,
                type: 'normal',
                cut_height: parseInt(input_zone_template_cut_height.value),
                rpm: parseInt(input_zone_template_rpm.value),
                border_paths: parseInt(input_zone_template_border_path.value),
                coverage_angle: parseInt(input_zone_template_coverage_path.value),
                paths_distance: parseFloat(input_zone_template_path_distance.value),
                simplify: parseFloat(input_zone_template_simplify.value),
                polygon: msgPoly,
                paths: []
            });
            topic_save_zone.publish(msg);
            // console.log(msg);

            // clean up
            div_zone_template.setAttribute('style', 'display:none !important');
            viewer.scene.removeChild(polygon);
            polygon.pointContainer.children = [];
            polygon.lineContainer.children = [];
            polygon.fillShape.graphics._instructions = [];
            polygon.fillShape.graphics._oldInstructions = [];
        } else {
            div_log.textContent = "Draw the polygon on the map!";
        }
    }

    // Get zone list
    var zoneListTopic = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/zone_list',
        messageType: 'vitulus_msgs/MapEditZoneList'
    });

    var current_zone_list = [];
    zoneListTopic.subscribe(function (message) {
        // console.log("Zone list:");
        initial_lists_received = true;
        current_zone_list = message.zone_list;
        var html_zone_list = '';
        for (let zone in message.zone_list) {
            // console.log(message.zone_list[zone]);
            let zone_name = message.zone_list[zone].name;
            let zone_type = message.zone_list[zone].type;
            let zone_area = message.zone_list[zone].area;
            let zone_height = message.zone_list[zone].cut_height;
            let zone_rpm = message.zone_list[zone].rpm;
            html_zone_list += `
                <div class="d-flex align-items-center" style="border-bottom: 1px solid #3a3f44;padding: 3px 2px;font-size: 12px;">
                    <span class="text-info text-truncate" style="flex: 1 1 auto;min-width: 0;" title="${zone_name}">${zone_name}</span>
                    <span class="text-light text-end" style="width: 48px;">${zone_height}mm</span>
                    <span class="text-light text-end" style="width: 58px;">${zone_rpm}rpm</span>
                    <span class="text-light text-end" style="width: 50px;">${zone_area}m&sup2;</span>
                    <div class="btn-group btn-group-sm" role="group" style="margin-left: 6px;">
                        <button id="btn_zone_edit" class="btn btn-outline-info" type="button" style="font-size: 11px;padding: 1px 8px;" onclick="editZone(&#39;${zone_name}&#39;)">Edit</button>
                        <button id="btn_zone_remove" class="btn btn-outline-danger" type="button" style="font-size: 11px;padding: 1px 8px;" onclick="removeZone(&#39;${zone_name}&#39;)">Remove</button>
                    </div>
                </div>
            `;
            div_zone_list.innerHTML = html_zone_list;
        }
        if (message.zone_list.length === 0) {
            div_zone_list.innerHTML = "";
        }
    });


    // Edit zone from list by name
    this.editZone = function (zone_name) {
        for (let i in current_zone_list) {
            if (current_zone_list[i].name === zone_name) {
                let zone = current_zone_list[i];
                // console.log(zone);
                div_zone_template.setAttribute('style', zone_template_style_attr);
                viewer.scene.removeChild(polygon);
                polygon.pointContainer.children = [];
                polygon.lineContainer.children = [];
                polygon.fillShape.graphics._instructions = [];
                polygon.fillShape.graphics._oldInstructions = [];
                viewer.scene.addChild(polygon);
                for (let point in zone.polygon.polygon.points) {
                    // console.log("Point:");
                    // console.log(zone.polygon.polygon.points[point]);
                    polygon.addPoint(zone.polygon.polygon.points[point]);
                }
                input_zone_template_name.value = zone.name;
                input_zone_template_rpm.value = zone.rpm;
                input_zone_template_cut_height.value = zone.cut_height;
                input_zone_template_border_path.value = zone.border_paths;
                input_zone_template_coverage_path.value = zone.coverage_angle;
                input_zone_template_path_distance.value = zone.paths_distance;
                let msg = new ROSLIB.Message({
                    data: zone_name
                });
                topic_selected_zone.publish(msg);
            }
        }
    }

    // Remove zone from list by name
    var topic_remove_zone = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/remove_zone',
        messageType: 'std_msgs/String'
    });
    topic_remove_zone.advertise();

    this.removeZone = function (zone_name) {
        let msg = new ROSLIB.Message({
            data: zone_name,
        });
        topic_remove_zone.publish(msg);
    }



    // Programs     ///////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Program elements. In INTEGRATED mode the planner's own program UI is not
    // used: programs are created/edited from the map view's own Programs menu
    // (map_view.js), so these DOM ids don't exist here. Skip the whole block.
    if (!integrated) {
    var div_program_template = document.getElementById("div_program_template");
    var div_program_list = document.getElementById("div_program_list");
    var btn_program_new = document.getElementById("btn_program_new");
    var input_program_add_zone = document.getElementById("input_program_add_zone");
    var btn_program_add_zone = document.getElementById("btn_program_add_zone");
    var btn_program_template_save = document.getElementById("btn_program_template_save");
    var input_program_template_name = document.getElementById("input_program_template_name");
    var span_program_template_zones = document.getElementById("span_program_template_zones");
    var btn_program_template_cancel = document.getElementById("btn_program_template_cancel");

    var inp_template_rpm = document.getElementById("inp_template_rpm");
    var inp_template_cut_height = document.getElementById("inp_template_cut_height");
    var btn_template_speed_slow = document.getElementById("btn_template_speed_slow");
    var btn_template_speed_mid = document.getElementById("btn_template_speed_mid");
    var btn_template_speed_fast = document.getElementById("btn_template_speed_fast");
    var chk_template_override_zone = document.getElementById("chk_template_override_zone");

    // Init program template
    var program_template_style_attr = div_program_template.getAttribute('style');
    div_program_template.setAttribute('style', 'display:none !important');
    div_program_list.innerHTML = "";
    let selected_program_msg = new ROSLIB.Message({});
    let current_program_list = [];

    function _setTemplatSpeedButtons(speed) {
        const active = 'btn btn-sm btn-secondary';
        const inactive = 'btn btn-sm btn-outline-secondary';
        btn_template_speed_slow.className = speed === 'slow' ? active : inactive;
        btn_template_speed_mid.className  = speed === 'mid'  ? active : inactive;
        btn_template_speed_fast.className = speed === 'fast' ? active : inactive;
    }

    btn_template_speed_slow.onclick = function() { _setTemplatSpeedButtons('slow'); };
    btn_template_speed_mid.onclick  = function() { _setTemplatSpeedButtons('mid');  };
    btn_template_speed_fast.onclick = function() { _setTemplatSpeedButtons('fast'); };

    function _resetTemplateForm() {
        input_program_add_zone.innerHTML = '';
        for (let i in current_zone_list) {
            var option = document.createElement("option");
            option.value = i;
            option.innerHTML = current_zone_list[i].name;
            input_program_add_zone.appendChild(option);
        }
    }

    function _updateZoneDisplay() {
        let zones_el = "";
        for (let i in selected_program_msg.zone_list) {
            const zn = selected_program_msg.zone_list[i].name;
            zones_el += `<span style="background: var(--bs-gray-dark);padding: 2px;border-radius: 5px;padding-right: 4px;padding-left: 4px;margin-left: 2px;"><span style="margin-right: 3px;"><i class="fa fa-remove text-danger" onclick="removeProgramTemplateZone('${zn}')"></i></span><span>${zn}</span></span>`;
        }
        span_program_template_zones.innerHTML = zones_el;
    }

    // New program template show in initial state
    btn_program_new.onclick = function () {
        div_program_template.setAttribute('style', 'display:block !important');
        input_program_template_name.value = "";
        _resetTemplateForm();
        selected_program_msg = new ROSLIB.Message({
            area: 0, last_duration_minutes: 0, last_result: "",
            length: 0, map_name: "", name: "", zone_list: [],
            rpm: 0, cut_height: 0, speed: "mid", override_zone: false,
        });
        inp_template_rpm.value = 0;
        inp_template_cut_height.value = 0;
        _setTemplatSpeedButtons('mid');
        chk_template_override_zone.checked = false;
        span_program_template_zones.innerHTML = "";
    }

    // Add selected zone to program
    btn_program_add_zone.onclick = function () {
        selected_program_msg.zone_list.push(current_zone_list[input_program_add_zone.value]);
        _updateZoneDisplay();
    }

    // Remove zone from program template
    this.removeProgramTemplateZone = function (zone_name) {
        selected_program_msg.zone_list = selected_program_msg.zone_list.filter(z => z.name !== zone_name);
        _updateZoneDisplay();
    }

    // Cancel program template
    btn_program_template_cancel.onclick = function () {
        div_program_template.setAttribute('style', 'display:none !important');
        input_program_template_name.value = "";
        selected_program_msg = new ROSLIB.Message({});
        span_program_template_zones.innerHTML = "";
    }

    // Save new program
    var topic_new_program = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/program_new',
        messageType: 'vitulus_msgs/PlannerProgram'
    });
    topic_new_program.advertise();
    btn_program_template_save.onclick = function () {
        console.log("Save program");
        let ready = true;
        if (input_program_template_name.value === "") {
            ready = false;
            div_log.innerHTML = "<span class='text-danger'>Program name is empty!</span>";
        };
        if (selected_program_msg.zone_list.length === 0) {
            ready = false;
            div_log.innerHTML = "<span class='text-danger'>Program has no zones!</span>";
        }
        if (ready) {
            selected_program_msg.name = input_program_template_name.value + ' (' + active_map_file_name.split("***env*")[0] + ')';
            selected_program_msg.map_name = active_map_file_name;
            selected_program_msg.area = 0;
            selected_program_msg.length = 0;
            for (let i in selected_program_msg.zone_list) {
                selected_program_msg.area += selected_program_msg.zone_list[i].area;
                selected_program_msg.length += selected_program_msg.zone_list[i].length;
            }
            selected_program_msg.rpm = parseInt(inp_template_rpm.value) || 0;
            selected_program_msg.cut_height = parseInt(inp_template_cut_height.value) || 0;
            selected_program_msg.speed = btn_template_speed_slow.classList.contains('btn-secondary') ? 'slow'
                : btn_template_speed_fast.classList.contains('btn-secondary') ? 'fast' : 'mid';
            selected_program_msg.override_zone = chk_template_override_zone.checked;
            topic_new_program.publish(selected_program_msg);
            input_program_template_name.value = "";
            div_program_template.setAttribute('style', 'display:none !important');
            div_log.innerHTML = "<span class='text-info'>Saving program " + selected_program_msg.name + "...</span>";
        }
    }

    // Get program list
    var programListTopic = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/program_list',
        messageType: 'vitulus_msgs/PlannerProgramList'
    });
    programListTopic.subscribe(function (message) {
        current_program_list = message.program_list;
        var html_program_list = '';
        for (let program in message.program_list) {
            const p = message.program_list[program];
            const program_name = p.name;
            const program_area = p.area;
            const program_length = p.length;
            const program_map = p.map_name.split("***env*")[0];
            const program_env = p.map_name.split("***env*")[1];
            const program_rpm = p.rpm || 0;
            const program_cut_height = p.cut_height || 0;
            const program_speed = p.speed || 'mid';
            let program_zones = "";
            for (let zone in p.zone_list) {
                program_zones += '<span>' + p.zone_list[zone].name + '</span>, ';
            }
            program_zones = program_zones.slice(0, -2);
            html_program_list += `
                <div style="border-bottom: 1px solid #444444;padding-right: 4px;padding-left: 6px;padding-bottom: 2px;padding-top: 2px;">
                    <div><span class="text-info" style="margin-right: 6px;width: 155px;font-size: 13.2px;overflow: hidden;display: inline-flex;">${program_name}</span><span class="text-nowrap" style="margin-right: 4px;font-size: 13.2px;width: auto;overflow: hidden;max-width: 62px;display: inline-flex;">${program_length} m</span><span class="text-nowrap" style="margin-right: 4px;font-size: 13.2px;overflow: hidden;max-width: 62px;display: inline-flex;">${program_area} m2</span>
                        <div class="d-xxl-flex align-items-xxl-center float-end" style="display: inline-flex;height: 24px;"><span class="text-nowrap" style="margin-right: 4px;font-size: 13.2px;overflow: hidden;max-width: 98px;display: inline-flex;">${program_map}</span><span class="text-nowrap" style="margin-right: 4px;font-size: 13.2px;overflow: hidden;max-width: 62px;display: inline-flex;">${program_env}</span></div>
                    </div>
                    <div style="margin-top: 2px;margin-bottom: 1px;"><span style="font-size: 12px;color:var(--bs-gray-500);">Zones: </span><span style="color: var(--bs-gray-600);font-size: 12px;">${program_zones}</span></div>
                    <div style="margin-top: 1px;margin-bottom: 2px;">
                        <span style="font-size: 12px;color:var(--bs-gray-500);">RPM: </span><span style="font-size: 12px;color:var(--bs-gray-400);margin-right:8px;">${program_rpm}</span>
                        <span style="font-size: 12px;color:var(--bs-gray-500);">Cut: </span><span style="font-size: 12px;color:var(--bs-gray-400);margin-right:8px;">${program_cut_height} mm</span>
                        <span style="font-size: 12px;color:var(--bs-gray-500);">Speed: </span><span style="font-size: 12px;color:var(--bs-gray-400);">${program_speed}</span>
                        <div class="btn-group btn-group-sm float-end" role="group"><button class="btn btn-outline-info d-inline-flex btn-sm-s" type="button" onclick="editProgram('${program_name}')">Edit</button><button class="btn btn-outline-success d-inline-flex btn-sm-s" type="button" onclick="runProgram('${program_name}')">Run</button><button class="btn btn-outline-danger d-inline-flex btn-sm-s" type="button" onclick="removeProgram('${program_name}')">Remove</button></div>
                    </div>
                </div>
            `;
        }
        div_program_list.innerHTML = html_program_list;
    });

    // Publish selected program to run
    var topic_program_select = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/program_select',
        messageType: 'std_msgs/String'
    });
    topic_program_select.advertise();

    this.runProgram = function (program_name) {
        let msg = new ROSLIB.Message({
            data: program_name,
        });
        topic_program_select.publish(msg);
        // console.log(msg);
    }

    // Remove program from list by name
    var topic_remove_program = new ROSLIB.Topic({
        ros: ros,
        name: '/web_plan/program_remove',
        messageType: 'std_msgs/String'
    });
    topic_remove_program.advertise();

    this.removeProgram = function (name) {
        let msg = new ROSLIB.Message({
            data: name,
        });
        topic_remove_program.publish(msg);
    }

    this.editProgram = function (program_name) {
        const prog = current_program_list.find(p => p.name === program_name);
        if (!prog) return;
        div_program_template.setAttribute('style', 'display:block !important');
        // Strip map suffix: 'ProgramName (mapname)' -> 'ProgramName'
        input_program_template_name.value = prog.name.replace(/ \([^)]+\)$/, '');
        selected_program_msg = new ROSLIB.Message({
            area: 0,
            last_duration_minutes: prog.last_duration_minutes,
            last_result: prog.last_result,
            length: 0,
            map_name: prog.map_name,
            name: prog.name,
            zone_list: prog.zone_list ? prog.zone_list.slice() : [],
            rpm: prog.rpm || 0,
            cut_height: prog.cut_height || 0,
            speed: prog.speed || 'mid',
            override_zone: prog.override_zone || false,
        });
        inp_template_rpm.value = prog.rpm || 0;
        inp_template_cut_height.value = prog.cut_height || 0;
        _setTemplatSpeedButtons(prog.speed || 'mid');
        chk_template_override_zone.checked = prog.override_zone || false;
        _updateZoneDisplay();
    }
    } // end if(!integrated) — planner program UI


    // Paths  //////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    var pathCoverageTopic = new ROSLIB.Topic({
        ros : ros,
        name : '/web_plan/path_show',
        messageType : 'nav_msgs/Path'
    });


    pathCoverageTopic.subscribe(function(message) {
        // console.log("Path:");
        coveragePath.setPath(message);
    });


    // Active map ///////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Program elements
    var btn_save_planner_data = document.getElementById("btn_save_planner_data");
    var btn_load_planner_data = document.getElementById("btn_load_planner_data");
    var btn_reload_map = document.getElementById("btn_reload_map");
    var active_map_name = document.getElementById("active_map_name");

    // Display map name
    var active_map_Topic = new ROSLIB.Topic({
        ros : ros,
        name : '/navi_manager/active_map',
        messageType : 'std_msgs/String'
    });

    active_map_Topic.subscribe(function(message) {
        // vitulus_ui R2 (2026-07-18): stamp the legacy name as data-legacy and let
        // the shared renderer decide header vs tooltip (so opening the Planner does
        // not clobber the mapping-v3 served-site identity in the Map-tab header).
        active_map_name.setAttribute('data-legacy', message.data.split("***env*")[0] + ' (' + message.data.split("***env*")[1] + ')');
        if (window.renderActiveMapName) window.renderActiveMapName();
        if (message.data !== active_map_file_name){
            console.log("Map changed");
            let msg = new ROSLIB.Message({
                data : true,
            });
            topic_publish_reload.publish(msg);
            initiate = true;
            viewer.scene.scaleX = 1;
            viewer.scene.scaleY = 1;

        }
        active_map_file_name = message.data;
    });

    // Load planner data
    var load_planner_data_Topic = new ROSLIB.Topic({
        ros : ros,
        name : '/web_plan/load_planner_data',
        messageType : 'std_msgs/Bool'
    });
    load_planner_data_Topic.advertise();

    btn_load_planner_data.onclick = function () {
        let msg = new ROSLIB.Message({
            data: true,
        });
        load_planner_data_Topic.publish(msg)
    }

    // Save planner data
    var save_planner_data_Topic = new ROSLIB.Topic({
        ros : ros,
        name : '/web_plan/save_planner_data',
        messageType : 'std_msgs/Bool'
    });
    save_planner_data_Topic.advertise();

    btn_save_planner_data.onclick = function () {
        let msg = new ROSLIB.Message({
            data: true,
        });
        save_planner_data_Topic.publish(msg)
    }

    // Reload map
    var reload_map_Topic = new ROSLIB.Topic({
        ros : ros,
        name : '/web_plan/reload_map',
        messageType : 'std_msgs/Bool'
    });
    reload_map_Topic.advertise();

    btn_reload_map.onclick = function () {
        let msg = new ROSLIB.Message({
            data: true,
        });
        reload_map_Topic.publish(msg)
    }









    // Request initial data from backend  //////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    var topic_publish_reload = new ROSLIB.Topic({
        ros : ros,
        name : '/web_plan/reload',
        messageType : 'std_msgs/Bool'
    });
    topic_publish_reload.advertise();
    var msg = new ROSLIB.Message({
        data : true
    });
    // vitulus_ui: request the initial planner data once. Each reload makes the
    // backend reload the (large) planner pickle and republish EVERYTHING
    // (program_list, zone_list, polygon_list, map_data, markers) — a heavy burst
    // — so we trigger it exactly once, like the original WebUI. Fire it when the
    // connection is actually open (so subscriptions are registered on rosbridge
    // first); a one-shot fallback covers a missed 'connection' event.
    // node_planner publishes zone_list/polygon_list once per request (they are
    // one-shot over rosbridge, which doesn't redeliver latched messages to a
    // late client). We fire ONE heavy /web_plan/reload (reloads the planner
    // pickle from disk) to make sure the data is loaded, then re-fetch with the
    // LIGHT /web_plan/republish (re-publishes the in-memory lists, no disk
    // reload) until BOTH the zone and polygon lists have actually arrived. So at
    // most one heavy reload; the retries are cheap.
    var __republish = new ROSLIB.Topic({ ros: ros, name: '/web_plan/republish', messageType: 'std_msgs/Bool' });
    __republish.advertise();
    var __reload_fired = false;
    var __republish_tries = 0;
    function startInitialDataRequests() {
        if (initial_lists_received && initial_polys_received) return;   // got both lists — done
        if (!__reload_fired) {
            __reload_fired = true;
            try { topic_publish_reload.publish(msg); } catch (e) {}     // one heavy reload (load)
        } else {
            try { __republish.publish(new ROSLIB.Message({ data: true })); } catch (e) {}  // cheap re-fetch
        }
        if (__republish_tries++ < 6) window.setTimeout(startInitialDataRequests, 2500);
    }
    ros.on('connection', function () { window.setTimeout(startInitialDataRequests, 500); });
    // In integrated mode the shared rosbridge connection is usually already open
    // (no fresh 'connection' event), so kick the initial reload right away.
    if (ros.isConnected) window.setTimeout(startInitialDataRequests, 200);


    // Subscribe to /navi_manager/map_path and display the path in the view
    var mapPathTopic = new ROSLIB.Topic({
        ros: ros,
        name: '/navi_manager/map_path',
        messageType: 'nav_msgs/Path',
        
    });

    mapPathTopic.subscribe(function(message) {
        if (message.poses && message.poses.length > 0) {
            console.log("Path received");
            coveragePath.setPath(message);
        } else {
            console.log("No path available");
        }
    });

    // Set path strokeSize to 0.45 on btn_path_footprint click
    var btnPathFootprint = document.getElementById("btn_path_footprint");
    btnPathFootprint.onclick = function() {
        console.log("Setting path strokeSize to 0.55");
        coveragePath.strokeSize = 0.45;
    };

    // Set path strokeSize to 0.03 on btn_path_thin click
    var btnPathThin = document.getElementById("btn_path_thin");
    btnPathThin.onclick = function() {
        console.log("Setting path strokeSize to 0.03");
        coveragePath.strokeSize = 0.03;
    };
} /// end of on.load()




