---
id: status-icons
title: Status icons and colours
group: Using the UI
order: 110
icon: la-circle
summary: What every icon in the navbar says, the computer monitor, and the four colours used everywhere.
ui: [icons]
related: [localization, settings, troubleshooting]
keywords: [icon, icons, colour, color, green, orange, red, grey, gray, status, wifi, gps, imu, lidar, camera, motor, temperature, fan, supply, battery, charging, connection, online, offline, monitor, cpu, memory, disk, network, nuc]
---
# Status icons and colours

## The four colours

The whole UI uses the same four tones — on icons, chips, cards and log dots:

| Colour | Means |
|---|---|
| green | OK |
| orange | warning — works, but look at it |
| red | fault — something is wrong |
| grey | no data or switched off |

The accent colour (cyan) is not a state: it marks links, the active tab and what is selected.

## The icons in the navbar

![The navbar on a PC with numbered markers](img/shot-navbar.webp "1 connection to the robot · 2 rain alert · 3 status icons · 4 ? help · 5 Needs you (the bell)")

![The status icons close up: sensing, driving, temperature and power groups](img/shot-status-icons.webp "The four groups, left to right: sensing · driving · temperature · power")

On a PC they sit in the navbar in four groups (sensing · driving · temperature · power); on a
narrow screen in a strip under the menu. Hover an icon for its name.

| Icon | What | Green | Orange | Red | Grey |
|---|---|---|---|---|---|
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_wifi_green.png) | Wi-Fi | good | medium | bad | disconnected |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_gps_green.png) | GPS (position receiver) | RTK | 3D fix, no RTK | bad | no data |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_gpsnav_green.png) | GPS-nav (heading receiver) | RTK | 3D fix, no RTK | bad | no data |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_imu_green.png) | IMU | on | — | — | off |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_lidar_green.png) | Lidar | on | — | — | off |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_camera_green.png) | Camera (D435) | on | — | — | off |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_mower_green.png) | Mower | on / busy | — | error | disabled |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_motorLF_green.png) | Drive motor (one per wheel) | OK | warm | hot | disabled |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_tempPCB_green.png) | Board temperature | OK | warm | hot | no data |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_fanPCB_green.png) | Board fan | running | — | — | off |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_temp_green.png) | Outside temperature | OK | warm | hot | no data |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_fan_green.png) | Fan | running | — | — | off |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_supply_green.png) | Charger supply | online (= docked) | — | fail | none |
| ![](../../nodes/templates/assets/img/robot_icons/Nextion_ico_batt_full.png) | Battery | full · ¾ · ½ · ¼ · empty; with a flash while charging | | | no data |

The **cloud** icon next to the logo is the rain alert ([Weather](waiting.md#weather-map--rain)),
the **connection** text left of it (**ONLINE** / **CONNECTING** / **OFFLINE**) says whether the page
is connected to the robot — click it to reconnect right away.

> [!TIP]
> All icons grey? The page is not connected, or the robot stack is (re)starting — wait a minute,
> then see [Troubleshooting](troubleshooting.md#the-ui-does-not-respond).

## The computer monitor

At the start of the navbar's right group (on a narrow screen under the menu button **☰**) four
small gauges show the robot's computer (NUC): **CPU**, **MEM** (memory), **DISK** and **NET**
(download ↓ / upload ↑). A gauge is green below 75 %, orange from 75 % and red from 90 %; grey
when the computer's data is not available. Hover it for details.
