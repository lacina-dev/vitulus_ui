---
id: mowing
title: Mowing unit
group: Robot
order: 65
icon: la-cut
summary: Mower power, the blade, cut height and RPM in Settings › Mower.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [mower, blade, knife, cut height, height, rpm, remember, saved height, saved rpm, after power-off, start motor, stop motor, mower command, print help, mower stop, stop, idle, docking cancelled]
---
# Mowing unit

Programs drive the mower by themselves. **Settings › Mower** is for checking and manual control.
While the mower is switched on, the right panel shows a **Mower** row under Controls: the status
chip, a blade dot with the RPM, the cut height and — only when hot — the temperature
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
