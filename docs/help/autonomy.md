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
blocked, grey is not checked now (GPS is checked when a run starts; the line shows the live fix).
**Why isn't it sleeping?** shows only what keeps the robot awake; an open SSH session or web UI is
blue, it keeps the robot awake on purpose. The › next to a line takes you to where it is fixed.

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

### Sleep

The sentence under **Sleep** is the plan: when it goes to sleep, for how long, when it wakes, or what
holds it awake. The same sentence stands at the top of the page, and **Cancel** is above the map, in
the right panel and at the top while a sleep is counting down. With the robot's timing the power goes
3 minutes after the start and the robot wakes at the stated time; the time *off* is shorter than
the time you ask for by those 3 minutes.

- **Sleep automatically** is the robot's own sleeping. **Sleep now** works either way.
- **Ignore logins** and **Ignore open UI**: off, a terminal or an open page keeps the robot awake. On,
  it goes to sleep with you connected, the power goes and the page and every terminal lose it until it
  wakes. Switching one on can start a sleep at once, so it first tells you the duration and the wake
  time and asks.
- **Cancel** holds automatic sleep off for 30 minutes and says until when, then the countdown comes
  again. For longer, use **Stay awake** (N hours).
- **Sleep now**: the box takes what the robot accepts, today from 16 minutes (a limit of 15 and a clock
  margin), and the line under it says what would happen. A start inside the sleep is a choice: wake for
  it (the sleep gets shorter) or skip it. A login on a terminal refuses Sleep now unless Ignore logins
  is on. While a sleep is counting down, cancel that one first. With this page open a 60 s countdown
  runs first. If it fails afterwards, the page says so.

Some limits are not settings yet. **Advanced** lists them with their values: the shortest sleep, the
wait before the power goes, the longest piece of sleep, the countdown and the time a Cancel holds.

### Hardware reset

**Hardware reset: everything off for N s** (also in Settings › Power) is not a sleep. Power to the
computer, motors and mower goes off for N seconds, default 60, only the power module stays on. It works
in the dock on the charger with nothing running. It says what will happen and asks, then the power
goes 20 s later, with **Cancel** until then. It is a hard cut without a clean shutdown, and this page
and Claude sessions go too; the robot is back about 2 minutes after. The scheduler does not know
about it. The page that started it reconnects, says how it went and puts the power module's times back.

### The mower board stops answering

During mowing the robot stops after 3 s without news from the mower board. If the board answers
within 6 s, it just drives on. If not, the blade gets stopped and the robot tries to bring the board back
(the panel shows the banner, here and in the right panel). While the board stays silent the mower's power
stays off: it comes back only once the board answers. When that fails, or the mission ends meanwhile,
the power stays off, the robot goes home without the blade and the run stays waiting at its place. If you
switch the mower off yourself during mowing, the robot goes home, leaves it off and tells you. The run
does not resume by itself: start it when you want it.

**Reset a silent mower board by itself** (Faults, off by default, you turn it on per robot): when the board is still silent in the
dock, on the charger, with nothing running, the robot does a hardware reset on its own: announced 60 s
ahead with **Cancel**, power off for a minute, the run goes on after the boot. It does this once per
run and at most twice in 24 hours; after that it tells you and waits. If somebody is connected and
**Ignore logins** / **Ignore open UI** are off, it does not cut: it tells you and waits until they are
gone. A terminal used in the last 10 minutes stops it even with **Ignore logins** on. Cancel holds for
that run. Off the dock it never cuts.

### A start that does not run today

One calendar entry runs once a day. If an entry already ran today and has a later start today, Plan
says so, names the next start and offers **Run today anyway** (the same as deleting the entry and
adding it again). Moving an entry to another time needs nothing: it counts as a new start.

## Calendar or agent

Who decides when to mow: the **calendar** (your slots, as always) or the **agent**. Switch it in the
panel, or tell the agent in the chat: "mow as you see fit" / "switch to the agent" and "back to the
calendar". After an update it is the calendar, nothing changes until you switch.

In the agent mode the agent looks at the weather (rain history and forecast), when each zone was last
mowed, what the last run left unfinished and how heavy the cutting was, and tells the robot *mow
program X between these times* or *don't mow until T*, with its reason and confidence. The robot
carries the advice out the same way as **Run next**: every check of **Could it start now?** still
applies. **Leaving the dock stays yours:** the robot follows the agent's "mow" only while you have
unlocked the dock (preset **Mow**); without it the agent tells you once in the chat — "I want to mow
X between …, unlock the dock" — and the robot waits. The unlock is used up only when the robot really
leaves. Without a fresh advice the calendar decides meanwhile (it can be switched off: then nothing
starts without the agent). While an advice is in force, the calendar's slots are the agent's to decide
and are not caught up later. In the agent mode the robot sleeps at most until the next morning, so the
agent gets its daily look.

**Hard limits** stay in the robot, the agent cannot override them: starts only 08:00–20:00 (a run
already out goes on until the allowed mowing time ends, 21:00 by default), not within 3 h after rain,
not below 5 °C, the same zone again only after 2 days (finishing an unfinished program is not held
back). With no current weather (radar and forecast both old) the agent mode does not start. In the agent mode they always
apply; in the calendar mode only when you turn them on. A run you start by hand, or **Run next**, is
never limited by them. Every decision — advice received, run started, waited and why, skipped,
refused by a limit — is in the **History**.

## Advanced

Rarely needed timing, and the **locked limits** the robot reports: firmware and safety limits such
as temperature, tilt, STOP and the blade rules. They are shown with a lock and the reason, and
cannot be changed here. No setting here relaxes a safety limit.

## History

The journal says in plain words what happened: started, finished, skipped, missed, waited, slept,
woke, settings changed. Filter it by runs, waits, sleep or settings. Problems stay on top until you
**Clear** them.

## The line above the map

One line says what the robot is doing, and what is about to happen: a sleep ahead ("Going to sleep
in 5 min for 11 h 55 min") when that is known, the countdown with **Cancel**, *Sleep cancelled*, *Leaving:
Bigger*, *Waiting for RTK*, *Mowing finished*. STOP and errors come first and stay until they are over.
The robot's routine lines wait their turn, each stays at least 2.5 seconds, and all of them stay in
the **Log**. On a phone the line is shorter; the whole sentence is in the panel.

## Outside the panel

The **Auto** row of the right panel shows the next start, or the state when the robot waits or
needs someone; open it for next start, battery and rain, › leads here. It stays quiet while all is
fine. When something needs you, it turns amber or red and the top card says what; on a phone a dot
appears in the collapsed row.
