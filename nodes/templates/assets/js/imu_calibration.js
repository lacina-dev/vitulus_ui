// Desc: IMU calibration for Vitulus WebUI
//
// vitulus_ui: the whole file is wrapped in an IIFE so that its top-level
// classes (ROS, Viewer3D, ViewerGrid, JoyTeleop) do NOT collide with the
// identically named classes defined globally by map_view.js. Only
// `window.initImu` is exported. The init-time singletons (ros, viewer, ...)
// are declared at IIFE scope below so they stay private and never overwrite
// map_view's same-named globals.
(function () {

// IIFE-scoped singletons populated by window.initImu (keeps them off `window`).
var ros, imu_diag, viewer, viewer_grid, imu_markers, imu_yaws, imu_buttons, joy_teleop;

class ROS {
    constructor() {
        this.ros = new ROSLIB.Ros({url: "ws://" + location.hostname + ":9090"});
        console.log("Connected to ROS.");
    }
}


class Viewer3D{

    constructor(ros) {

        this.viewer = new ROS3D.Viewer({
                divID : '3d_view',
                width : 600,
                height : 600,
                near : 0.2,
                far : 1000,
                antialias : true,
                intensity : 1.0,
                alpha : 1.0,
                background : '#1e2f38',  // 1e2f38
                cameraPose : {  x : 0, y : 0, z : 190 },
                displayPanAndZoomFrame : true
            });

    }

    changeViewerSize(){
            var width = document.getElementById("3d_view").clientWidth;
            var height = document.getElementById("3d_view").clientHeight;
            var padding = parseInt((document.getElementById("3d_view").style.padding).replace('px', ''));
            this.viewer.resize(width, height);
            document.getElementById("3d_view").Width = width;
            document.getElementById("3d_view").Height = height;
        };

    updateCam(){
        this.viewer.cameraControls.rotateDown();
        this.viewer.cameraControls.rotateLeft(-1.57);
        this.viewer.camera.fov = 1;
    };
}


class ImuYaws {

    constructor(ros) {
        this.imu_yaws_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/imu/yaws',
            messageType: 'std_msgs/Float32MultiArray'
        });
        this.rtk_yaws_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/gnss_heading/yaws',
            messageType: 'std_msgs/Float32MultiArray'
        });

        this.subscribe = this.imu_yaws_topic.subscribe(function (message) {
            span_imu_deg.innerHTML = "Imu: " + message.data[0].toFixed(2) + "°";
            span_nav_deg.innerHTML = "Nav: " + message.data[1].toFixed(2) + "°";
            span_mag_deg.innerHTML = "Mag: " + message.data[2].toFixed(2) + "°";
        });
        this.subscribe = this.rtk_yaws_topic.subscribe(function (message) {
            span_rtk_deg.innerHTML = "RTK: " + message.data[1].toFixed(2) + "°";
            span_imu_deg.innerHTML = "IMU: " + message.data[0].toFixed(2) + "°";
            span_fuse_deg.innerHTML = "Fused: " + message.data[2].toFixed(2) + "°";
        });
    }
}


class ImuButtons{

    constructor(ros) {
        this.run_save_calib_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/bno085/run_calibration',
            messageType : 'std_msgs/Bool'
        });

        this.run_restart_imu_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/bno085/restart',
            messageType : 'std_msgs/Bool'
        });

        this.run_reset_dcd_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/bno085/reset_calibration',
            messageType : 'std_msgs/Bool'
        });

        this.init();
    }

    init(){
        this.run_save_calib_topic.advertise();
        this.run_restart_imu_topic.advertise();
        this.run_reset_dcd_topic.advertise();
    }

    pub_run_calibration() {
        let msg = new ROSLIB.Message({
            data: true
        });
        this.run_save_calib_topic.publish(msg);
    }

    pub_save_calibration() {
        let msg = new ROSLIB.Message({
            data: false
        });
        this.run_save_calib_topic.publish(msg);
    }

    pub_restart_imu() {
        let msg = new ROSLIB.Message({
            data: true
        });
        this.run_restart_imu_topic.publish(msg);
    }

    pub_reset_dcd() {
        let msg = new ROSLIB.Message({
            data: true
        });
        this.run_reset_dcd_topic.publish(msg);
    }
}


class ViewerGrid{

    constructor(viewer) {
        viewer.viewer.scene.add(new ROS3D.Grid({
                                        num_cells : 50,
                                        color: "#333333",
                                        cellSize: 0.3,
        }));
    }
}

class Imu_Markers {

        constructor(ros) {

        this.tfClient = new ROSLIB.TFClient({
          ros : ros.ros,
          angularThres : 0.01,
          transThres : 0.01,
          rate : 10.0,
          fixedFrame : '/bno_imu_link'
        });
        this.markerArrayClient = new ROS3D.MarkerArrayClient({
          ros: ros.ros,
          rootObject: viewer.viewer.scene,
          tfClient: this.tfClient,
          topic: "/imu/markers",
        });
        this.markerArrayGnssClient = new ROS3D.MarkerArrayClient({
          ros: ros.ros,
          rootObject: viewer.viewer.scene,
          tfClient: this.tfClient,
          topic: "/gnss_heading/markers",
        });

    }
}

class ImuDiag {

    constructor(ros) {

        var diag_arr = [];

        this.diag_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/diagnostics',
            messageType: 'diagnostic_msgs/DiagnosticArray'
        });

        this.subscribe = this.diag_topic.subscribe(function (message) {
            message.status.forEach(function(element){
                var contains_element = false;
                diag_arr.forEach(function(item){
                    if (item.name === element.name){
                        item.message = element.message;
                        item.level = element.level;
                        contains_element = true;
                    }
                });
                if (contains_element === false){
                    const el_name = element.name + ":";
                    if (el_name.includes("BNO085")){
                        diag_arr.push(element);
                    }
                    if (el_name.includes("fix:")){
                        diag_arr.push(element);
                    }
                    // if (element.name.includes("gnss_heading: fix:")){
                    //     diag_arr.push(element);
                    // }
                }
            });
            var diag_html_content = '';
            diag_arr.forEach(function(item){
                var diag_html_item = '<div>';
                diag_html_item += '<span>' + item.name.replace("IMU BNO085: ", "") + ': </span> ';
                if (item.level === 0){ diag_html_item += '<span style="color: var(--bs-success);">' + item.message + '</span>';};
                if (item.level === 1){ diag_html_item += '<span style="color: var(--bs-warning);">' + item.message + '</span>';}
                if (item.level === 2){ diag_html_item += '<span style="color: var(--bs-danger);">' + item.message + '</span>';}

                diag_html_item += '</div>';
                diag_html_content += diag_html_item;
            });
            div_diag.innerHTML = diag_html_content;
            });
    }
}


class JoyTeleop {
    constructor(ros) {
        this.twist = new ROSLIB.Message({
            linear: {x: 0, y: 0, z: 0},
            angular: {x: 0,y: 0, z: 0}
        });
        this.cmdVel = new ROSLIB.Topic({
            ros: ros.ros,
            name: "/cmd_vel",
            messageType: "geometry_msgs/Twist"
        });
        this.publishImmidiately = true;
        this.lin = 0;
        this.ang = 0;
        this.publish_joy = false;
        this.joysize = 200;
        // this.joysize = 172;
        this.joystickContainer = document.getElementById("joy_view_imu");
        this.options = {
            zone: this.joystickContainer,
            position: { left: 50 + "%", top: 50 + "%" },
            mode: "static",
            //catchDistance: 1,
            size: this.joysize,
            color: "#0066ff",
            dynamicPage: true,
            //restJoystick: true
        };
        this.manager = nipplejs.create(this.options);
        this.pub_end_published = false;

        this.init();
    }

    init(){
        this.cmdVel.advertise();
    }

    moveAction(linear, angular) {
        if (linear !== undefined && angular !== undefined) {
            this.twist.linear.x = linear;
            this.twist.angular.z = angular;
        } else {
            this.twist.linear.x = 0;
            this.twist.angular.z = 0;
        }
        this.cmdVel.publish(this.twist);
    }

    joy_pub_speed(){
        if (this.publish_joy){
            this.moveAction(this.lin, this.ang);
            this.pub_end_published = false;
        }else{
            if (this.pub_end_published === false){
                this.moveAction(0, 0);
                this.pub_end_published = true;
            }
        }
    }

    set_lin(lin){
        this.lin = lin;
    }

    set_ang(ang){
        this.ang = ang;
    }

    set_publish_joy(publish_joy){
        this.publish_joy = publish_joy;
    }
}


window.initImu = function () {
    ros = new ROS();

    imu_diag = new ImuDiag(ros);
    viewer = new Viewer3D(ros);
    // vitulus_ui: expose the ros3d viewer so app.js can stop its render loop while
    // the IMU section is hidden (it otherwise keeps drawing at 60fps).
    window.__ros3d_imu = viewer.viewer;
    viewer.changeViewerSize();
    const resizeObserver =  new ResizeObserver((entries) => {
        for (const entry of entries) {
            if (entry.target.id === "3d_view") {
                viewer.changeViewerSize();
            }
        }
    });
    resizeObserver.observe(document.getElementById("3d_view"));
    viewer.updateCam();
    viewer.viewer.addObject(new THREE.AmbientLight(0x696969));
    viewer_grid = new ViewerGrid(viewer);
    imu_markers = new Imu_Markers(ros);
    imu_yaws = new ImuYaws(ros);
    imu_buttons = new ImuButtons(ros);
    btn_run_calibration.onclick = function() {imu_buttons.pub_run_calibration()};
    btn_save_dcd.onclick = function() {imu_buttons.pub_save_calibration()};
    btn_remove_dcd.onclick = function() {imu_buttons.pub_reset_dcd()};
    btn_reset_imu.onclick = function() {imu_buttons.pub_restart_imu()};
    joy_teleop = new JoyTeleop(ros);

    joy_teleop.manager.on("move", function(evt, nipple) {
        let direction = nipple.angle.degree - 90;
        if (direction > 180) {
            direction = -(450 - nipple.angle.degree);
        }
        let nip_distance = (nipple.distance/(joy_teleop.joysize/2));
        let lin = 0; // 0.52
        let ang = Math.sin(direction / 57.29) * nip_distance * 1.2;
        joy_teleop.set_lin(lin);
        joy_teleop.set_ang(ang);
        joy_teleop.set_publish_joy(true);
    });
    joy_teleop.manager.on("end", function() {
        //moveAction(0, 0);
        joy_teleop.set_publish_joy(false);
        joy_teleop.set_lin(0);
        joy_teleop.set_ang(0);
    });

    setInterval(function() {joy_teleop.joy_pub_speed()}, 50)
};

})();