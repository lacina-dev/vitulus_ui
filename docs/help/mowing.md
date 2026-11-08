---
id: mowing
title: Mowing unit
group: Robot
order: 65
icon: la-cut
summary: Mower power, the blade, cut height and RPM in Settings › Mower.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [hold, hold to start, half a second, grass height, grass, calibration, grass_calib, terrain, off the plan, plan line, gps line, lidar line, heading vs gnss, cross-track, xte, localization wrong, mow load, load, trail, heat, temperature, overload, past runs, mower, blade, knife, cut height, height, rpm, remember, saved height, saved rpm, after power-off, start motor, stop motor, mower command, print help, mower stop, stop, idle, docking cancelled]
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

**START MOTOR acts only when you hold it for half a second** — with the mouse, a finger, or
Enter / Space held on the keyboard. The button fills while you hold it; letting go earlier (or
sliding off it) sends nothing and the line under it says so. A plain click does nothing.
**STOP**, **STOP MOTOR**, a lost connection to the robot, a second finger or leaving the tab during the
hold cancel it — the blade then does not start. **STOP MOTOR** acts at once (on the press itself).

![Settings › Mower with numbered markers](img/shot-mower.webp "1 ON / OFF (power) · 2 direction · 3 height in mm + Set · 4 RPM + Set · 5 Home · 6 START MOTOR (hold ½ s) / STOP MOTOR")

| Control | What it does |
|---|---|
| **Power ON / OFF** | mower power; the filled half is the real state. The card head shows **Temp** (the mower board's temperature) and the **State**: OFF, INIT, HOME, HEIGHT, READY, RUN, ERR, BLOCKED, TEMP |
| **Direction** | Left / Right — the blade's direction of rotation. The current mower controller does not take it: it always reports LEFT |
| **Height** | current / max in **mm**; type a height in mm (from the mower's minimum, 25 mm by default, up to the max, e.g. 45) and **Set**. A value outside that range is ignored |
| **RPM** | current / setpoint; type a value (500–4000) and **Set** |
| **Home** | height calibration — the deck drives up to its top stop and takes it as the reference |
| **START MOTOR / STOP MOTOR** | starts (hold ½ s) / stops the blade |

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

- **Colour** shows one thing at a time, you pick it under **Colour shows**: Load, Torque, Speed,
  Slope, Temperature, GPS vs lidar, GPS vs wheels, RTCM age, Rpm dip, Off the plan or Heading vs GNSS.
  The legend gives real values.
- **Width** shows what the robot was doing. A full stripe as wide as the deck: cutting. A narrower
  one: spin-up or waiting. A thin line: blade off. Violet: stopped by a no-blade rule. Pink: blocked,
  white: motor hot.
- **Stops and events** are small icons: blocked, overload, recovery, backup, detour, stall, no
  progress, new path window, a temperature warning, an RTCM gap, RTK lost and back, a GPS jump, off
  the plan (↯, 25 cm or more). When they crowd, the worst stay; zoom in for the rest.
- **Lines** are thin lines over the trail, each with its own switch next to the events: **Plan**
  (light, dashed) is where the robot should have been, the point of the planned path nearest to it;
  **GPS** (green) and **Lidar** (cyan) are where each of them put the robot. The trail itself is the
  fused pose, the one the robot steered by. A line breaks where its source had no data.
- **Tap the trail** for a short card: position, blade, drive, GNSS, power and job at that moment. With a
  mouse, hovering shows the first numbers. A tapped card also puts small dots on the map, joined
  to the pose: plan, pose (orange), GPS and lidar; they go away when the card closes.
- **Run** picks a past run, under it are the totals: time mowing, transit, stops, load, peak
  temperature, energy, and how far the robot was from the plan, GPS from the plan and the heading
  from GNSS (median / p95).

Load 100 % is the point where the mower firmware cuts the motor: motor current at its limit
(1.54 A) or speed down to a quarter of the setpoint, whichever is closer. The blade running free reads
about 10 %. Temperature is recorded raw, so a single wrong reading stays visible: one sample on an
otherwise cool run is a sensor spike, a slow climb is real heating.

- **Torque** is the sum over the four wheels, how hard they work to move the robot: about 7 Nm on a
  straight, up to 17 in turns. Each wheel is limited to 20 Nm. The card adds
  the hardest wheel.
- **GPS vs lidar** and **GPS vs wheels** are the honest view of GPS. The accuracy the receiver reports
  says 1.4 cm almost everywhere, whatever is really happening, so it is only in the card.
  GPS vs lidar is how far the lidar scan, laid on the map, wants to move the GPS position: usually
  10 to 40 cm, and a bad map reads the same as a bad GPS. GPS vs wheels compares the GPS step
  in one second with the wheels, which cannot jump: about 4 cm in RTK fix, more means the
  position really moved; from 50 cm a mark stays on the map. Turns are skipped.
- **RTCM age** is the time since the last correction from the base. It swings between 0 and 1 s,
  3 s counts as a gap and leaves a mark. Rate, satellites and pDOP are in the card.
- **Rpm dip** is how far the blade fell below the set rpm. The motor control holds it within 2 rpm
  almost all the time, so the scale is fine: a few rpm already show. Real grass shows better in Load.

### Which source was wrong

The **Position** group of the card is a small table, one row per source:

| Row | vs plan, cm | vs pose fwd / left, cm |
|---|---|---|
| Plan | 0, the reference | where the plan was from the robot |
| Pose | sideways distance from the plan, + = robot left of it | 0 / 0, the reference |
| GPS | GPS sideways from the plan | where GPS put the robot: ahead / to the left of the pose |
| Lidar | lidar sideways from the plan | the same for the lidar |

Under it: heading of the pose against the heading of the two GNSS antennas (with their accuracy
and the difference Δ), who owned the localization, and the state of the lidar tracker.

How to read it, with **Off the plan** as the colour and the GPS line on:

- **Pose near the plan, GPS far from it**: the robot followed the plan, but the plan was followed
  in a wrong place — the localization was wrong. The GPS line (and the lidar line, if it agrees with
  GPS) shows where the robot really drove.
- **Pose far from the plan**: the robot knew it was off and did not get back — the steering, the
  path controller, wheels slipping on a slope or an obstacle on the way.
- **GPS and lidar apart, pose with one of them**: the pose followed that source; the other one
  disagrees. Owner and tracker state in the card say who was trusted then.
- **Heading vs GNSS** large while driving straight: the fused heading drifted; a pose that follows a
  wrong heading drifts sideways soon after.

What is recorded: **GPS** only while the receiver has a fix, and the GPS line is drawn **only in RTK
fix** — a float can lie metres away while the receiver still reports a few cm, so the line breaks
there. The card still shows a float GPS against the pose, marked *RTK float*, but not against the plan.
**Lidar** is recorded also when it disagrees with GPS (the tracker says *lidar disagrees*) — exactly
then it is worth a look. **Heading vs GNSS** is left out in turns, where the two never match in time.

Runs recorded before these data existed show them in grey, no data, and have no lines or Position
table. Torque is there from the first runs.

## Grass height ahead

While the robot drives or mows, the depth camera measures the grass in a strip in front of it
(0.8–1.6 m from the robot's centre, ±0.35 m to the sides) and tells grass from terrain that rises
or falls. The camera sees only the top of the grass, never the soil, so:

- **On the map** (map editor › Layers › **Grass height**, file `grass.npz` of the site) a 0.2 m
  cell gets a height only once its ground is known: when the wheels drive over it, or from the
  terrain of earlier runs. Each cell keeps the last height, the median, how many times it was
  seen and when. Colours: green = up to the cut height + 2 cm, yellow = cut + 2–4 cm, orange =
  more. Cells are 0.2 m, so a mown | uncut edge stays sharp on the map.
- **Right now** (`/grass/ahead`) the ground ahead is taken from the wheels or earlier runs, else
  the robot's own plane is extended forward. Classes against the cut height: `below_cut`,
  `+2-4cm`, `>+4cm`, or `unknown`.
- A **smooth** surface (concrete, a path) close to the ground is ground. A gentle ramp or dip is
  taken off; when the whole strip, the mown lane beside it included, tilts more, it is terrain:
  without known ground the answer is `unknown` (`terrain_change`), not a height. Under grass
  a tilt never lowers the height (the grass may just grow taller ahead), it only makes the answer
  less sure. Lanes that differ sharply side by side: a smooth raised lane is a kerb; a taller lane
  whose grass reaches down to the ground of the low lane is a mown | uncut edge — each lane is
  reported (`lanes_mm`) and the answer is the tall lane; a whole lane lifted (kerb, bed border,
  stone edging, bank) is terrain → `unknown`. On the map, a cell holding a flat bottom under a much
  higher top (lawn and a kerb top) and a cell seen only at a corner in a turn are not written.
- Without a calibration the numbers are raw and `/grass/ahead` says `uncalibrated`.

### Calibrate the grass height

Needs a ruler, flat concrete, freshly mown lawn and a patch of taller grass. The robot stands
still for each record (no program running), the sample lies straight in front of it. Commands run
in a terminal on the robot.

1. **Concrete** (camera zero): robot on flat concrete with 2 m of concrete in front —
   `rosrun vitulus_mapping grass_calib record --label beton --x 1.2`. Then turn the robot by
   180° on the same concrete and record it again (that measures the IMU's tilt error; without
   it `fit` stops with an error).
2. **Mown grass**: robot on the lawn it just mowed. Measure the grass with the ruler at 0.8, 1.2
   and 1.6 m from the robot's centre (half-way between the front and rear wheels), ruler on the
   soil, read where most blades end. Average in mm.
3. Record each distance: `grass_calib record --label posekano --true-mm <mm> --x 0.8`, then
   `--x 1.2` and `--x 1.6`.
4. **Taller grass** (at least 4–6 cm taller), the same way with `--label vysoka`.
5. A wrong measurement? Just record it again: `fit` takes only the newest record of each label
   and distance. `grass_calib list` shows the records, `grass_calib clear --label …` removes one.
6. `grass_calib fit` computes the camera zero, the IMU tilt error and the scale, prints the error
   on each sample (±10 mm good, ±20 mm usable), a WARNING when mown and tall grass do not lie on
   one line (measure again) and the recommended strip. The node picks it up in 5 s.
7. `grass_calib check` prints once a second what the camera sees now — compare with the ruler.

More: `vitulus_mapping/docs/GRASS_HEIGHT.md`.

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

**Service: commands to the mower board** (collapsed, under the Mower card) sends text commands
straight to the mower's controller — four numbered rows, each with **Send** — and shows its
answer below. Try `PRINT HELP` to list them. Meant for service.
