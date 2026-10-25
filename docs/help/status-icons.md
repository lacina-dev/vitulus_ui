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

![The navbar on a PC with numbered markers](img/shot-navbar.webp "1 connection dot · 2 status icons (the first is the weather) · 3 computer (CPU · RAM · ↓ ↑) · 4 ? help · 5 Needs you (the bell) · 6 Restart · 7 ⋯ more · 8 STOP")

![The status icons close up: sensing, driving, temperature and power groups](img/shot-status-icons.webp "The groups, left to right: weather · sensing · driving · temperature · power")

They sit in the navbar right after the logo, always at the same place, in groups (weather ·
sensing · driving · temperature · power); on a phone held upright in their own row under the menu.
On a narrow window (under 1100 px) and on a phone on its side each group shows **one icon — the
worst one of the group** (red before orange before green before grey); hover it for the group, the
full row comes back on a wider window. Hover an icon for its name.

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

The **cloud** — the first status icon — is the weather ([Weather](waiting.md#weather-map--rain)):
green = no rain expected, orange = rain expected, red = raining now; no icon = no weather data
yet. Click it to see the rain radar (**Map › Rain**).

The **dot** next to the logo is the connection of this page to the robot: green connected,
orange (pulsing) connecting, red no connection — hover it for the words, click it to reconnect
right away. When the connection drops, the notice band under the menu also says
*No connection to the robot · reconnecting…* until it is back.

> [!TIP]
> All icons grey? The page is not connected, or the robot stack is (re)starting — wait a minute,
> then see [Troubleshooting](troubleshooting.md#the-ui-does-not-respond).

## The computer monitor

On the right of the navbar the robot's computer (NUC) in fixed places: **CPU** and **RAM** in %,
then the network — **↓** download and **↑** upload with their unit (B/s, kB/s, MB/s). The numbers
are smoothed over a few seconds, so the block stays calm and never changes its width. A number
turns **orange** only when it needs a look: the CPU when its **average over 30 s** is 90 % or more
(red from 97 %), RAM from 90 % (red 97 %) — a short spike does not colour anything. Click the block
for a **card** with rings CPU · RAM · DISK, the network, the 30-s average and the load, and a link
to **Settings › Diag**.

Narrower windows: under 1600 px only download ↓; under 1366 px the block is one **chip** (an icon
in the colour of the worst of CPU, RAM and disk) — click it for the same card. On a phone the
computer is in **⋯** (a small dot on ⋯ when it needs a look). Grey = the computer's data is not
available.
