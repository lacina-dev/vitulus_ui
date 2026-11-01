---
id: mowing
title: Mowing unit
group: Robot
order: 65
icon: la-cut
summary: Mower power, the blade, cut height and RPM in Settings › Mower.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [mow load, load, trail, heat, temperature, overload, past runs, mower, blade, knife, cut height, height, rpm, remember, saved height, saved rpm, after power-off, start motor, stop motor, mower command, print help, mower stop, stop, idle, docking cancelled]
---
# Mowing unit

Programs drive the mower by themselves. **Settings › Mower** is for checking and manual control.
While the mower is switched on, the right panel shows a **Mower** section under Controls: the
title row has the status chip, a blade dot with the RPM, — only when hot — the temperature and
the blade buttons **▶ Start** (two taps, only while `READY`) / **■ Stop** (red while the blade
spins), the same as START MOTOR / STOP MOTOR here; click the title to expand **Blade**, **Height** and **Temp** (always, orange from 50 °C, red
from 60 °C) and the running program
([The right panel](frame.md#the-right-panel)).

> [!CAUTION]
> The blade is dangerous. Start it by hand only with the robot on the lawn, nobody near it, and
> your other hand on **STOP**.

![Settings › Mower with numbered markers](img/shot-mower.webp "1 ON / OFF (power) · 2 direction · 3 height in mm + Set · 4 RPM + Set · 5 Home · 6 START MOTOR / STOP MOTOR")

| Control | What it does |
|---|---|
| **ON / OFF** | mower power. The row shows the temperature and status: OFF, INIT, HOME, HEIGHT, READY, RUN, ERR, BLOCKED, TEMP |
| **Direction** | Left / Right — the blade's direction of rotation. The current mower controller does not take it: it always reports LEFT |
| **Height** | current / max in **mm**; type a height in mm (from the mower's minimum, 25 mm by default, up to the max, e.g. 45) and **Set**. A value outside that range is ignored |
| **RPM** | current / setpoint; type a value (500–4000) and **Set** |
| **Home** | height calibration — the deck drives up to its top stop and takes it as the reference |
| **START MOTOR / STOP MOTOR** | starts / stops the blade |

- **The robot remembers the height and RPM you set here** (also with the joystick or on the
  robot's display), over a mower power-off and a robot restart. The line under RPM shows the
  saved values — also while the mower is off or not answering.
- When the mower powers on, its controller starts afresh: the deck drives up to the top
  (Home) and the blade stays off. Once the mower reports READY the robot moves the deck to the
  saved height and sets the saved RPM as the setpoint. **It never starts the blade** — that is
  still only **START MOTOR** or a program. It does not do it while a program is running.
- A program's or zone's height and RPM, and parking the blade at the max after mowing or on a
  stop, are only for that moment — they do not change the saved values.
- Programs use the zone's or the program's cut height and RPM ([Programs](programs.md)).
- **Cut height is always in millimetres** — here, in zones ([Map editor](map-editor.md)) and in
  programs; the robot itself works in mm. 45 mm = 4.5 cm. The max is the top position of the
  deck, where the blade parks after mowing.
- Status **TEMP**: the mower is too hot — the blade switches off (it can start again once it
  has cooled down) and a running program returns to the dock.

## Mow load on the map

The layer **Mow load** (Map tab, Layers, and the Layers panel of the editor) draws a trail behind the
robot, live during mowing and later for any of the last 30 runs. It turns on by itself while a
program runs, until you set it yourself; then your choice stays.

- **Colour** shows one thing at a time, you pick it under **Colour shows**: Load, Speed, Slope,
  Temperature, Accuracy, RTCM age or Rpm dip. The legend gives real values.
- **Width** shows what the robot was doing. A full stripe as wide as the deck: cutting. A narrower
  one: spin-up or waiting. A thin line: blade off. Violet: stopped by a no-blade rule. Pink: blocked,
  white: motor hot.
- **Stops and events** are small icons: blocked, overload, recovery, backup, detour, stall, no
  progress, new path window, a temperature warning, an RTCM gap, RTK lost and back. When they crowd, the worst stay; zoom in for the rest.
- **Tap the trail** for a short card: blade, drive, position, power and job at that moment. With a
  mouse, hovering shows the first numbers.
- **Run** picks a past run, under it are the totals: time mowing, transit, stops, load, peak
  temperature, energy.

Load 100 % is the point where the mower firmware cuts the motor: motor current at its limit
(1.54 A) or speed down to a quarter of the setpoint, whichever is closer. The blade running free reads
about 10 %. Temperature is recorded raw, so a single wrong reading stays visible: one sample on an
otherwise cool run is a sensor spike, a slow climb is real heating.

- **Accuracy** is hAcc, how far off the receiver says it may be: about 1.4 cm in RTK fix, 2.7 cm in
  float, metres without corrections. The fix class itself is in the card and as a mark where it changes.
- **RTCM age** is the time since the last correction from the base. It swings between 0 and 1 s,
  3 s counts as a gap and leaves a mark. Rate, satellites and pDOP are in the card.
- **Rpm dip** is how far the blade fell below the set rpm. The motor control holds it within 2 rpm
  almost all the time, so the scale is fine: a few rpm already show. Real grass shows better in Load.

Runs recorded before the Accuracy and RTCM data existed show those two in grey, no data.

## Stop

A mower stop (from **Programs › Stop**, the agent's supervisor or a person taking over with the
joystick) acts **at once**: the blade gets *off* the moment the stop arrives.

- **A program runs** — the stop also cancels the program's docking manoeuvre and ends the
  mission in *Stopped*, immediately, every time.
- **No program runs** — only the blade is switched off. Nothing else is stopped, so a docking
  the agent or you started is never cancelled by it.
- Several stops in a row count as one. The supervisor and the joystick takeover send the mower
  stop only while a program runs; they switch the blade off directly anyway.
- A mower **without power** (mower switch off) is not waited for: the stop is done in a moment
  instead of tens of seconds, and the mowing node can always be stopped or restarted.

## Commands

The **Commands** card sends text commands straight to the mower's controller and shows its answer
below. Try `PRINT HELP` to list them. Meant for service.
