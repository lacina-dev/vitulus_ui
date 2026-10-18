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
   replace each zone's own cut height and RPM (both must be above 0).
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
| **Automation off** | the master controller is disabled by a parameter on the robot (`automation_enabled`) |
| **Mowing** | a program runs now |
| **Off dock** | the robot is out of the dock |
| **Starting** | a program is being started |

The line under the tag is the scheduler's own status and the next run, for example
*Idle (Wait 12m for …)*.

> [!NOTE]
> On this robot automation is currently configured **off** (`automation_enabled: false` in
> `vitulus_planner/config/master_controller.yaml`), so the calendar shows *Automation off* and
> starts nothing; programs run only by hand.

Why a program does not start or stopped early: [Why the robot waits](waiting.md).
