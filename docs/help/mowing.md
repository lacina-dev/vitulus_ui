---
id: mowing
title: Mowing unit
group: Robot
order: 65
icon: la-cut
summary: Mower power, the blade, cut height and RPM in Settings › Mower.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [mower, blade, knife, cut height, height, rpm, start motor, stop motor, mower command, print help, mower stop, stop, idle, docking cancelled]
---
# Mowing unit

Programs drive the mower by themselves. **Settings › Mower** is for checking and manual control.

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

- When the mower powers on, its controller starts afresh: the deck drives up to the top
  (Home), the RPM setpoint is the controller's stored default and the blade stays off. A height
  or RPM you set by hand is not kept over a power-off.
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
