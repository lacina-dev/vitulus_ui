---
id: settings
title: Settings
group: Using the UI
order: 120
icon: la-cog
summary: Motors, Navi, Power, Mower, Diag, Rosbag and IMU — what each tab is for.
ui: [config, config/motors#motors, config/lidar#navi, config/power#power, config/diag#diag, config/rosbag#rosbag, config/imu#imu]
related: [safety, mowing, status-icons]
keywords: [settings, motors, torque, navi, lidar, power, battery, charge, sleep, diagnostics, diag, rosbag, recording, bag, imu, calibration]
---
# Settings

**Settings** (⚙ in the menu band) has one tab per part of the robot. The **?** in the panel head
jumps to the tab you have open.

## Motors

- **ON / OFF** — power of the four drive motors. **They are OFF after every start**
  ([Safety](safety.md#motors-are-off-after-every-start)); switch them on here before you drive
  by hand or dock. The button's colour follows the real motor state.
- **Torque** (0–24 Nm) and **Save** — the motors' torque limit.
- One card per wheel (front / rear, left / right): id, status, torque, temperature, velocity,
  position, voltage, mode. The wheel icons in the navbar mirror their state: green OK, orange
  warm, red hot, grey off.

## Navi

- **Speed** SLOW / MODERATE / FAST — the same setting as Slow / Mid / Fast in the right panel
  ([speeds](routes.md#speed)).
- **Lidar** ON / OFF.
- **RtabMap** sensor source (Camera / Lidar / Both) and distance — for the older RTAB-Map
  localization; normally left alone.

## Power

- **Supply** — charger input (V, A), battery (V, A, charging state, %), capacity, the computer's
  (NUC) output, and whether the motor and mower outputs are on.
- **Temperature** — board and external temperature and fan speeds.
- **Outputs & limits** — motor and mower output ON / OFF, charge and cut-off currents for run and
  standby, board and external temperature limits. Change only if you know why.
- **Sleep control** — sleep time, **Sleep now** (Timed / Until charged), standby delay, charged
  offset, discharge timeout. The scheduler uses sleep while it waits
  ([Why the robot waits](waiting.md)).

## Mower

Mower power, the blade, cut height and RPM — see [Mowing unit](mowing.md).

## Diag

The live list of the robot's diagnostics (ROS `/diagnostics`): a summary on top, then groups of
rows *dot · name · message* in a stable order. Green OK, orange warning, red error, grey stale.
Useful when something is red in the navbar and you want to know which part.

## Rosbag

Recording of sensor data for analysis:

- **D435 RGB-D camera** — REC / STOP and the frame rate (FPS, **Set**).
- **GNSS forensics** — records the GPS heading, fix and pose ownership (for localization issues).
- **Stored bags** — the list with **Download** and **Delete** (↻ refreshes).

Bags take a lot of disk space; delete what you no longer need.

## IMU

Calibration of the inertial sensor: **Remove DCD**, **Reset IMU**, **Run**, **Save**, and the
state of the IMU, navigation, magnetometer, RTK and fusion. A small stick lets the robot only
rotate in place during the calibration. Meant for service.
