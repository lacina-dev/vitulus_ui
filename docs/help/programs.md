---
id: programs
title: Programs and calendar
group: Robot
order: 60
icon: la-calendar
summary: What to mow and when — programs (make, edit, delete), Run / Resume / Stop / Reset, the calendar and Hold.
ui: [program, program/programs, program/calendar#the-calendar]
related: [map-editor, mowing, waiting]
keywords: [program, programs, calendar, schedule, hold, held, active, automation off, run, resume, stop, reset, override zone, delete, remove, rename, running, missing, interrupt, pause]
---
# Programs and calendar

A **program** says *what* to mow: a list of zones of the active map, the speed, and optionally one
cut height and RPM for all of them. The **calendar** says *when*. Both are in **Programs**.

## Make a program

1. Activate the map first — a program belongs to the map it is made on.
2. **Programs › Programs › New program**: a **name**, add zones from the list (**Add zone**).
3. **Speed**: Slow / Mid / Fast.
4. **RPM** and **Cut height (mm)**, and **Override zone**: with it ticked, these two values
   replace each zone's own cut height and RPM (both must be above 0). The height is in
   millimetres like everywhere in the UI, e.g. 50 = 5 cm.
5. **Save**.

To change a program, open its card, edit and **Save** again. A new name renames it (the old
entry goes away). A program the robot is running cannot be renamed — Stop it first.

## Delete a program

1. Open the program's card in **Programs › Programs**.
2. **Delete** (red, next to **Save**) and confirm in the dialog.

The program's zones stay on the map — only the program goes. If calendar events use the program,
the dialog says how many; they stay in the calendar marked **missing** and are skipped until you
**Edit** them and pick another program. A program that is running cannot be deleted — **Stop**
it first (a stopped program can be deleted).

## Run it

| Button | What it does |
|---|---|
| **Run** | starts the program from the beginning — the robot undocks and mows |
| **Resume** | continues an unfinished program from the zone / path where it stopped |
| **Show / Hide** | draws the program's paths on the map |
| **Stop** | stops the mission: the drive goal is cancelled, the blade stops, the robot stands where it is — *Stopped* |
| **Reset** | clears a *STOPPED* or *TERMINAL ERROR* state |

While a program runs, a **Running** card on top of the program list shows its name and state with
a **Stop** button — whichever program (or none) is open below. After a Stop it turns into
**Stopped** with **Reset**.

### Interrupt and continue

A running program stops on any of these — always into *Stopped*, the blade off:

- **Stop** in Programs (the Running card or the program's card),
- the red **STOP** bottom left (it also switches the drive motors off — [Safety](safety.md#stop)),
- taking over with the gamepad or the web joystick ([Safety](safety.md#the-gamepad-ds4-and-the-joystick-beat-the-software)).

The robot then stands and waits. To go on: **Reset**, then **Resume** (continues from about where it
stopped — the mission saves its place every minute) or **Run** (from the beginning). Off the dock the motors must be on —
after the red STOP switch them on first (**Settings › Motors › ON**), otherwise the start is
refused with *Start rejected: motors are OFF*. To end the program instead, **Reset** and drive the robot home
(**Right panel › Controls › Dock**).

> [!IMPORTANT]
> After a Stop or an error the mission waits for **Reset** — Run and Resume are ignored until
> then, and the UI says *…press Reset first*.

If the planner refuses something (no zones, a zone no longer on the map, no active map, the
program is running), the reason appears under the buttons of the program's card.

## The calendar

**Programs › Calendar** lists events: program, time and recurrence (Once, Daily, Weekly with days,
Monthly, Yearly), each with an on / off switch, **Edit** and **Del**. An event starts within 15
minutes after its time, once a day.

The tag in the calendar's head says what the scheduler does now:

| Tag | Meaning |
|---|---|
| **Active** | the scheduler will start programs (idle, waiting for the next event) |
| **Held** | **Hold** is on — nothing starts from the calendar until you switch Hold off |
| **Automation off** | the scheduler is switched off on the robot (`automation_enabled: false`, see [below](#automation-on--off)) — nothing starts by itself |
| **Mowing** | a program runs now |
| **Off dock** | the robot is out of the dock |
| **Starting** | a program is being started |

The line under the tag is the scheduler's own status and the next run, for example
*Idle (Wait 12m for …)*, or *Mowing (Stopped - press Reset)* while a scheduled program waits
for Reset.

An event whose program is not on the active map (deleted, renamed, or made on another map) shows
**missing**; the scheduler skips it for that day. **Edit** it and pick a program.

### Hold

**Hold** stops new starts from the calendar — it does not stop a program that already runs (use
**Stop** for that). A scheduled program that runs when you switch Hold on is still followed to its
end. If it was interrupted (battery, rain, temperature) the robot does not go to sleep while Hold is
on; when you switch Hold off, the scheduler resumes it as usual.

### Automation on / off

`automation_enabled` is the master switch of the scheduler (the master controller):

- **on** (`true`): the calendar starts programs by itself and the robot sleeps / resumes on its
  own (battery, rain, temperature, the night window — see [Why the robot waits](waiting.md));
- **off** (`false`): the scheduler is passive — no automatic start and no automatic sleep;
  programs run only when you start them by hand.

How to tell: the calendar's tag says **Automation off** and the status line *Disabled* when it is
off; any other tag (Active, Held, Mowing, …) means it is on.

Where to change it: `automation_enabled` in `vitulus_planner/config/master_controller.yaml`. The
controller reads it once when it starts, so the change applies after the robot stack (or the
`master_controller` node) restarts. To pause the calendar for a while without touching the
configuration, use **Hold**.

Why a program does not start or stopped early: [Why the robot waits](waiting.md).
