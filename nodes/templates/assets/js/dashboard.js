// Desc: Dashboard for Vitulus WebUI

class ROS {
    constructor() {
        this.ros = new ROSLIB.Ros({url: "ws://" + location.hostname + ":9090"});
        console.log("Connected to ROS.");
    }
}

class IconStatus {
    constructor(ros) {
        this.icon_status_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/device_state_pub/icon_status',
            messageType: 'vitulus_msgs/Device_icon_status'
        });
        this.subscribe = this.icon_status_topic.subscribe(function (message) {
            // WiFi
            if (message.wifi === "FINE") {
                ico_wifi.src = "assets/img/robot_icons/Nextion_ico_wifi_green.png";
            }
            if (message.wifi === "MEDIUM") {
                ico_wifi.src = "assets/img/robot_icons/Nextion_ico_wifi_orange.png";
            }
            if (message.wifi === "BAD") {
                ico_wifi.src = "assets/img/robot_icons/Nextion_ico_wifi_red.png";
            }
            if (message.wifi === "DISCONNECTED") {
                ico_wifi.src = "assets/img/robot_icons/Nextion_ico_wifi_grey.png";
            }
            // GPS
            if (message.gnss === "RTK") {
                ico_gps.src = "assets/img/robot_icons/Nextion_ico_gps_green.png";
            }
            if (message.gnss === "3DFIX") {
                ico_gps.src = "assets/img/robot_icons/Nextion_ico_gps_orange.png";
            }
            if (message.gnss === "BAD") {
                ico_gps.src = "assets/img/robot_icons/Nextion_ico_gps_red.png";
            }
            if (message.gnss === "DISABLED") {
                ico_gps.src = "assets/img/robot_icons/Nextion_ico_gps_grey.png";
            }
            // GPS_NAV
            if (message.gnss_nav === "RTK") {
                ico_gps_nav.src = "assets/img/robot_icons/Nextion_ico_gpsnav_green.png";
            }
            if (message.gnss_nav === "3DFIX") {
                ico_gps_nav.src = "assets/img/robot_icons/Nextion_ico_gpsnav_orange.png";
            }
            if (message.gnss_nav === "BAD") {
                ico_gps_nav.src = "assets/img/robot_icons/Nextion_ico_gpsnav_red.png";
            }
            if (message.gnss_nav === "DISABLED") {
                ico_gps_nav.src = "assets/img/robot_icons/Nextion_ico_gpsnav_grey.png";
            }
            // IMU
            if (message.imu === "ON") {
                ico_imu.src = "assets/img/robot_icons/Nextion_ico_imu_green.png";
            }
            else  {
                ico_imu.src = "assets/img/robot_icons/Nextion_ico_imu_grey.png";
            }
            // LIDAR
            if (message.lidar === "ON") {
                ico_lidar.src = "assets/img/robot_icons/Nextion_ico_lidar_green.png";
            }
            else  {
                ico_lidar.src = "assets/img/robot_icons/Nextion_ico_lidar_grey.png";
            }
            // D435
            if (message.d435 === "ON") {
                ico_camera.src = "assets/img/robot_icons/Nextion_ico_camera_green.png";
            }
            else  {
                ico_camera.src = "assets/img/robot_icons/Nextion_ico_camera_grey.png";
            }
            // MOWER
            if (message.mower === "ON") {
                ico_mower.src = "assets/img/robot_icons/Nextion_ico_mower_green.png";
            }
            if (message.mower === "BUSY") {
                ico_mower.src = "assets/img/robot_icons/Nextion_ico_mower_green.png";
            }
            if (message.mower === "ERROR") {
                ico_mower.src = "assets/img/robot_icons/Nextion_ico_mower_red.png";
            }
            if (message.mower === "DISABLED") {
                ico_mower.src = "assets/img/robot_icons/Nextion_ico_mower_grey.png";
            }
            // FL MOTOR
            if (message.mot_lf === "OK") {
                ico_fl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLF_green.png";
            }
            if (message.mot_lf === "WARM") {
                ico_fl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLF_orange.png";
            }
            if (message.mot_lf === "HOT") {
                ico_fl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLF_red.png";
            }
            if (message.mot_lf === "DISABLED") {
                ico_fl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLF_grey.png";
            }
            // FR MOTOR
            if (message.mot_rf === "OK") {
                ico_fr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRF_green.png";
            }
            if (message.mot_rf === "WARM") {
                ico_fr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRF_orange.png";
            }
            if (message.mot_rf === "HOT") {
                ico_fr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRF_red.png";
            }
            if (message.mot_rf === "DISABLED") {
                ico_fr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRF_grey.png";
            }
            // RL MOTOR
            if (message.mot_lr === "OK") {
                ico_rl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLR_green.png";
            }
            if (message.mot_lr === "WARM") {
                ico_rl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLR_orange.png";
            }
            if (message.mot_lr === "HOT") {
                ico_rl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLR_red.png";
            }
            if (message.mot_lr === "DISABLED") {
                ico_rl_motor.src = "assets/img/robot_icons/Nextion_ico_motorLR_grey.png";
            }
            // RR MOTOR
            if (message.mot_rr === "OK") {
                ico_rr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRR_green.png";
            }
            if (message.mot_rr === "WARM") {
                ico_rr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRR_orange.png";
            }
            if (message.mot_rr === "HOT") {
                ico_rr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRR_red.png";
            }
            if (message.mot_rr === "DISABLED") {
                ico_rr_motor.src = "assets/img/robot_icons/Nextion_ico_motorRR_grey.png";
            }
            // TEMP_PCB
            if (message.temp_int === "OK") {
                ico_temp_pcb.src = "assets/img/robot_icons/Nextion_ico_tempPCB_green.png";
            }
            if (message.temp_int === "WARM") {
                ico_temp_pcb.src = "assets/img/robot_icons/Nextion_ico_tempPCB_orange.png";
            }
            if (message.temp_int === "HOT") {
                ico_temp_pcb.src = "assets/img/robot_icons/Nextion_ico_tempPCB_red.png";
            }
            if (message.temp_int === "DISABLED") {
                ico_temp_pcb.src = "assets/img/robot_icons/Nextion_ico_tempPCB_grey.png";
            }
            // FAN_PCB
            if (message.fan_int === "ON") {
                ico_fan_pcb.src = "assets/img/robot_icons/Nextion_ico_fanPCB_green.png";
            }
            else  {
                ico_fan_pcb.src = "assets/img/robot_icons/Nextion_ico_fanPCB_grey.png";
            }
            // TEMP_EXT
            if (message.temp_ext === "OK") {
                ico_temp.src = "assets/img/robot_icons/Nextion_ico_temp_green.png";
            }
            if (message.temp_ext === "WARM") {
                ico_temp.src = "assets/img/robot_icons/Nextion_ico_temp_orange.png";
            }
            if (message.temp_ext === "HOT") {
                ico_temp.src = "assets/img/robot_icons/Nextion_ico_temp_red.png";
            }
            if (message.temp_ext === "DISABLED") {
                ico_temp.src = "assets/img/robot_icons/Nextion_ico_temp_grey.png";
            }
            // FAN_EXT
            if (message.fan_ext === "ON") {
                ico_fan.src = "assets/img/robot_icons/Nextion_ico_fan_green.png";
            }
            else  {
                ico_fan.src = "assets/img/robot_icons/Nextion_ico_fan_grey.png";
            }
            // supply
            if (message.supply === "ONLINE") {
                ico_supply.src = "assets/img/robot_icons/Nextion_ico_supply_green.png";
            }
            else  {
                if (message.supply === "FAIL") {
                ico_supply.src = "assets/img/robot_icons/Nextion_ico_supply_red.png";
                }
                else  {
                    ico_supply.src = "assets/img/robot_icons/Nextion_ico_supply_grey.png";
                }
            }
            // BATTERY
            if (message.batt === "FULL") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_batt_full.png";
            }
            if (message.batt === "75") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_batt_34.png";
            }
            if (message.batt === "50") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_batt_half.png";
            }
            if (message.batt === "25") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_batt_14.png";
            }
            if (message.batt === "EMPTY") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_batt_empty.png";
            }
            if (message.batt === "FULL_CHARGE") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_battCHARGE_full.png";
            }
            if (message.batt === "75_CHARGE") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_battCHARGE_34.png";
            }
            if (message.batt === "50_CHARGE") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_battCHARGE_half.png";
            }
            if (message.batt === "25_CHARGE") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_battCHARGE_14.png";
            }
            if (message.batt === "EMPTY_CHARGE") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_battCHARGE_empty.png";
            }
            if (message.batt === "DISABLED") {
                ico_batt.src = "assets/img/robot_icons/Nextion_ico_batt_disabled.png";
            }
        });
    }
}

window.onload = function () {
    console.log("onload")
    ros = new ROS();
    icon_status = new IconStatus(ros);


} /// end of on.load()




