---
id: settings
title: Settings
group: Using the UI
order: 120
icon: la-cog
summary: Motors, Navi, Power, Mower, Diag, Rosbag, IMU and App (language, agent, support, display) — what each tab is for.
ui: [config, config/motors#motors, config/lidar#navi, config/power#power, config/diag#diag, config/rosbag#rosbag, config/imu#imu, config/app#app]
related: [safety, mowing, status-icons]
keywords: [settings, app, language, czech, čeština, jazyk, english, display, motors, torque, navi, lidar, power, battery, charge, sleep, diagnostics, diag, rosbag, recording, bag, imu, calibration]
---
# Settings

**Settings** (⚙ in the menu band) has one tab per part of the robot, and **App** for this
application itself. The **?** in the panel head jumps to the tab you have open.

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

## App

Settings of this application (the UI), not of the robot. Nothing here moves the robot or changes
anything on it except the stored language.

- **Language** — **English** or **Čeština**. It switches at once, without a reload, and is stored
  **on the robot**, so every phone and PC shows the same language (the line under the buttons
  says *Saved on the robot*). When the robot cannot store it (it is restarting, or the page runs
  as `?mock`), it is kept on this device only and the line says so. The help follows the
  language; a topic not translated yet shows in English with a note. The default is English.
- **Agent** — *Message density* (Comfortable / Compact, the same as ▤ in the agent panel),
  *Chat history* (All devices / This browser, the same as the all / mine switch above the chat)
  and the tab the agent panel *opens on*.
- **Support** — *Your name*, which signs the decisions you make in **Needs you** (audit), the tab
  the Support panel *opens on*, and whether *decisions from the robot UI* are allowed. That last
  one is only shown here; it is switched in the Support kit (**Open the Support dashboard**).
- **Display** — what this device shows at the next start: the log (Hidden / Small / Full screen)
  and what it shows (Changes / ROS), the camera small or large, the joystick, whether the view
  follows the map or the robot, and the right panel on a phone (one line or full).

Agent, Support and Display are remembered **in this browser** (each phone or PC has its own) and
follow what you do elsewhere in the UI — set here what the next start should look like.
