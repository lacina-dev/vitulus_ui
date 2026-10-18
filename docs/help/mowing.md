---
id: mowing
title: Mowing unit
group: Robot
order: 65
icon: la-cut
summary: Mower power, the blade, cut height and RPM in Settings › Mower.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [mower, blade, knife, cut height, height, rpm, start motor, stop motor, mower command, print help]
---
# Mowing unit

Programs drive the mower by themselves. **Settings › Mower** is for checking and manual control.

> [!CAUTION]
> The blade is dangerous. Start it by hand only with the robot on the lawn, nobody near it, and
> your other hand on **STOP**.

| Control | What it does |
|---|---|
| **ON / OFF** | mower power. The row shows the temperature and status: OFF, READY, RUN, CALIB, HEIGHT, ERR, BLOCKED, TEMP |
| **Direction** | Left / Right — the blade's direction of rotation |
| **Height** | current / max in **mm**; type a height in mm (20 up to the max, e.g. 45) and **Set** |
| **RPM** | current / setpoint; type a value (500–4000) and **Set** |
| **Home** | height calibration — the cutting height drives to its reference position |
| **START MOTOR / STOP MOTOR** | starts / stops the blade |

- The last height and RPM you set are remembered and applied again whenever the mower powers
  on; the blade itself always stays off at power-on.
- Programs use the zone's or the program's cut height and RPM ([Programs](programs.md)).
- **Cut height is always in millimetres** — here, in zones ([Map editor](map-editor.md)) and in
  programs; the robot itself works in mm. 45 mm = 4.5 cm. The max is the top position of the
  deck, where the blade parks after mowing.
- Status **TEMP**: the mower is too hot — a running program returns to the dock.

## Commands

The **Commands** card sends text commands straight to the mower's controller and shows its answer
below. Try `PRINT HELP` to list them. Meant for service.
