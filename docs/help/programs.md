---
id: programs
title: Programs and calendar
group: Robot
order: 60
icon: la-calendar
summary: What to mow and when — programs, Run / Resume / Stop / Reset, the calendar and Hold.
ui: [program, program/programs, program/calendar#the-calendar]
related: [map-editor, mowing, waiting]
keywords: [program, programs, calendar, schedule, hold, held, active, automation off, run, resume, stop, reset, override zone]
---
# Programs and calendar

A **program** says *what* to mow: a list of zones of the active map, the speed, and optionally one
cut height and RPM for all of them. The **calendar** says *when*. Both are in **Programs**.

## Make a program

1. Activate the map first — a program belongs to the map it is made on.
2. **Programs › Programs › New**: a **name**, add zones from the list (**Add zone**).
3. **Speed**: Slow / Mid / Fast.
4. **RPM** and **Cut height (mm)**, and **Override zone**: with it ticked, these two values
   replace each zone's own cut height and RPM (both must be above 0). The height is in
   millimetres like everywhere in the UI, e.g. 50 = 5 cm.
5. **Save**.

## Run it

| Button | What it does |
|---|---|
| **Run** | starts the program from the beginning — the robot undocks and mows |
| **Resume** | continues an unfinished program from the zone / path where it stopped |
| **Show / Hide** | draws the program's paths on the map |
| **Stop** | stops the mission |
| **Reset** | clears a *STOPPED* or *TERMINAL ERROR* state |

> [!IMPORTANT]
> After a Stop or an error the mission waits for **Reset** — Run and Resume are ignored until
> then, and the UI says *…press Reset first*.

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
*Idle (Wait 12m for …)*.

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
