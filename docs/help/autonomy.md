---
id: autonomy
title: Autonomy
group: Robot
order: 65
icon: la-calendar-check-o
summary: What the robot does on its own and why, and all the rules for it — automatic mowing, Hold, plan, weather, battery, sleep, faults.
ui: [autonomy]
related: [programs, waiting, settings]
keywords: [autonomy, autonomie, automatic, automation, hold, pause, plan, calendar, weather, rain, ignore rain, battery, sleep, stay awake, faults, retries, history, locked, limits]
---
# Autonomy

**Autonomy** in the menu is the one place that says what the robot does on its own and why. The top
card says in one sentence what it does now and what comes next. Under it, each section has a head
with a colour and short tokens; open it for the numbers and the controls. What you open stays open.

![The top of Autonomy with numbered markers](img/shot-autonomy.webp "1 state tag · 2 what it does now, next under it · 3 Automatic mowing · 4 Pause (Hold) · 5 could it start now · 6 why it does not sleep")

## The two switches

- **Automatic mowing** is the master switch: calendar starts, sleeping and resuming. Off, nothing
  starts by itself and the robot does not sleep by itself ([more](programs.md#automation-on--off)).
- **Pause (Hold)** stops **new starts only**. A running mission finishes; to end it use **Stop**
  ([more](programs.md#hold)).

## Now

**Could it start now?** lists every condition of a start: green is fine, amber waits, red is
blocked. **Why isn't it sleeping?** shows only what keeps the robot awake. The › next to a line takes
you to where it is fixed.

## Plan

![Plan with numbered markers](img/shot-autonomy-plan.webp "1 the next 7 days: allowed time (blue), starts (marks, with the time under them), expected sleep (grey) · 2 Skip next · 3 No mowing today · 4 Run next planned now")

The calendar and the [allowed mowing time](programs.md#allowed-mowing-time) are here. The timeline
shows the next 7 days: starts, the allowed time and expected sleep. **Skip next** skips one start,
**No mowing today** skips today, **Run next planned now** starts the next program at once (tap
twice). A skipped start is crossed out in the timeline, and the same button undoes it. The calendar
form, recurrence and the catch-up rules are in [Programs and calendar](programs.md#the-calendar).

## Weather

![Weather with numbered markers](img/shot-autonomy-rain.webp "1 the radar now and the next 30 minutes · 2 what rain does")

One choice decides what rain does:

| Choice | What rain does |
|---|---|
| **Always** | stops every start, by the calendar or by hand |
| **Calendar only** | stops the calendar; a run you start yourself goes |
| **Ignore** | stops nothing; the robot mows in the rain |

Under it: how long to wait after rain, how far ahead the forecast counts, when to try again, and
whether a mowing robot goes home when it starts to rain. The images stay in
[Map › Rain](waiting.md#weather-map--rain). When rain would refuse a **Run**, a dialog
offers **Ignore rain this time**: it applies to that one run only.

## Battery, Sleep, Faults

Each setting has a label, one sentence and its default, and **Reset** when it differs. A change
applies at once and the row says *Saved*. A refused value says why and the old one stays.

**Sleep** also has **Stay awake** (for N hours) and **Sleep now** (for a time, or until charged, tap
twice). Sleep now works only in the dock with nothing running. If someone else is connected, a 60 s
countdown appears at the top with **Cancel**.

## Advanced

Rarely needed timing, and the **locked limits** the robot reports: firmware and safety limits such
as temperature, tilt, STOP and the blade rules. They are shown with a lock and the reason, and
cannot be changed here. No setting here relaxes a safety limit.

## History

The journal says in plain words what happened: started, finished, skipped, missed, waited, slept,
woke, settings changed. Filter it by runs, waits, sleep or settings. Problems stay on top until you
**Clear** them.

## Outside the panel

The **Auto** row of the right panel shows the next start, or the state when the robot waits or
needs someone; open it for next start, battery and rain, › leads here. It stays quiet while all is
fine. When something needs you, it turns amber or red and the top card says what; on a phone a dot
appears in the collapsed row.
