---
id: waiting
title: Why the robot waits
group: Robot
order: 70
icon: la-hourglass-half
summary: Battery, rain, temperature, the night window and other reasons why nothing starts.
ui: [map/rain]
related: [autonomy, programs, mowing, troubleshooting]
keywords: [wait, waiting, sleep, rain, weather, battery, temperature, night, forecast, radar, idle, does not start]
---
# Why the robot waits

Often the robot does nothing on purpose. The calendar's status line
([Autonomy › Now](autonomy.md#now)) and the log say why.

## Before a program starts

```flow
Time of a calendar event | automation on, Hold off
In the dock? | and the stack runs for 5 min, programs loaded
Robot free? | no program, docking, person driving or agent; no Reset pending
warn: Allowed time? | by default 07:00–21:00 and 30 min of it left, otherwise it sleeps until then
warn: Battery ≥ 40 %? | and, by the rain setting, no rain now, in the last 60 min or within 30 min
ok: Start | the robot undocks and mows; RTK is awaited outside, at the undock point
```

The scheduler starts nothing while:

- automation is off, or **Hold** is on;
- the robot is **not in the dock**;
- the robot stack started less than 5 minutes ago, or the programs are not loaded yet;
- the mission is not ready (it waits for **Reset** after a stop or an error: the calendar card
  says so), or a program, docking, a person driving or the agent is using the robot;
- it is outside the **allowed mowing time** (by default 07:00–21:00, change it in
  [Autonomy › Plan](programs.md#allowed-mowing-time)), or less than 30 minutes of it are left
  — the robot sleeps until the window opens. This limits only the calendar, not a run by hand or
  the agent;
- the scheduled program is not on the active map (retried every 5 minutes, then reported).

None of this waits for GPS: the robot starts in the dock, where RTK is poor or missing, drives out
and waits for RTK at the undock point. If RTK does not come there, it returns and tries again, 3
times at most.

A program also refuses to start when:

- the **battery is below 40 %**;
- it **rains now**, rained in the last 60 minutes, or rain is forecast within 30 minutes
  (unless [the rain setting](#what-rain-does) says otherwise; these are the defaults, set in [Autonomy › Weather](autonomy.md#weather)).

A calendar program refused for the battery charges to 80 %, one refused for rain waits for the retry time (by default 2 h) — then
the robot tries again. The event is not used up by a refusal.

No weather data (no internet, the radar source down, data older than 30 minutes) does not stop the
calendar: the robot mows and the log says *No current weather data, starting anyway*. Wet grass
is covered by **Wait after rain**, by default the 60 minutes after the last rain. With **Start with
old weather data** off, old data block the start instead.

### What rain does

**Autonomy › Weather** has one choice, the same for the calendar, a run by hand and a run the agent
starts:

| Choice | Calendar | Run by hand or by the agent |
|---|---|---|
| **Always** (default) | rain stops the start | rain stops the start |
| **Calendar only** | rain stops the start | it goes |
| **Ignore** | it goes | it goes |

Nothing but rain depends on this choice: the battery, temperature and safety limits stay.

When rain would refuse a **Run** or **Resume**, a dialog says why (raining now, rained a short while
ago, rain forecast) and offers **Ignore rain this time**. That applies to this one run only and ends
with it: the next run obeys the setting again. If you cancel, nothing starts. Only a person can do
this; the agent says why rain refused its run and leaves the choice to you.

The calendar has no such dialog: it waits for the retry time and tries again.

## During mowing

| Reason | What happens |
|---|---|
| Battery ≤ 25 % | returns to the dock, charges to 80 %, then **continues** where it stopped |
| It rains, or 2 of 3 forecast steps say RAIN | returns (unless **Go home when it rains** is off), tries again after the retry time, by default 2 h, then **continues** where it stopped |
| Mower too hot (TEMP) | returns, waits 1 h, then **continues** |
| The allowed time ends (by default 21:00) | finishes the path it is on, returns, **continues** with the next path when the window opens |
| A critical error | returns, waits 30 min, **continues**; after 3 errors of one run it gives up and reports it |
| RTK not ready | returns, stays awake, tries again in 5 min; counts as an error above |
| Terminal error in the dock (undock failed) | waits 20 min, resets, tries again; counts as an error above |
| Terminal error off the dock | stays and beeps; **Needs Reset** in the calendar |
| Stopped by a person | nothing automatic — start it again yourself |

**Continues** means the same zone and path, from the start of the 6 m section the robot was on, as
many times as it takes. A program gives up with a report (it stays listed in the calendar card, and
**Resume** in Programs still continues where it stopped) after 3 errors, after 3 interruptions in a
row that moved it nowhere, after 12 interruptions, or after 48 hours. What it lost on the way home
is at most that one section.

This applies to programs the calendar started; a program you started yourself is not continued
automatically, use **Resume**. A stack restart in the middle changes nothing: the robot knows what
was unfinished, and it continues when it is in the dock (off the dock, the calendar card says it
needs bringing back). An event due meanwhile waits for it. Recovery sleeps are shortened so the
robot is awake for the next scheduled program.

## How the robot sleeps

Sleep means the **computer is off** and the power module wakes it, in the dock, at the set time.
It only happens with [Automation on](programs.md#automation-on--off), never with Hold, and the robot
stays awake while somebody is using it: a program, a dock move, driving, an agent mission, a
logged-in terminal, or an open web UI.

1. The power module confirms the wake time. If it does not, nothing happens and the robot stays awake.
2. The system shuts down cleanly. Three minutes after the command the power module cuts the
   power. Until the shutdown starts, Hold or switching Automation off cancels the sleep.
3. The robot wakes in the dock about 12 minutes before the program. A sleep is at most 12 hours;
   after a longer pause the robot just wakes, checks and sleeps again. Nothing waits for GPS in the
   dock, the signal is settled at the undock point.

Charging sleeps for an estimated time, at most 6 hours, then checks the battery and sleeps again if
needed, so a lost charging contact cannot leave it asleep for good. Without charging, or after two
charges that added nothing, it stays awake and tells you.

The **power button does not wake a sleeping robot** — that is how the power module works now.

A program that ends off the dock waits 20 minutes for the robot to come back. The robot **never
sleeps off the dock**: after that it says so, and if the automation left it outside it sends it home
once. A robot you stopped stays where it is.

## Weather (Map › Rain)

The cloud icon (the first status icon in the navbar) shows the rain alert: OK, rain expected,
raining now (click it to refresh the radar and open this tab). **Map › Rain** has the **weather report** (status, alert, current rain, place, time and
a timeline of past and forecast steps: OK / WARN / ALERT / RAIN / UNAVAILABLE), the **rain now**
radar image and the **forecast** (+10 / 20 / 30 min). The images refresh every 30 s.

## Temperature

The temperature icons (board, outside) and the motor icons turn orange when warm and red when
hot. The power module has its own temperature limits (**Settings › Power**); the safety node
switches the drive motors off when one of them is above 70 °C, and the mower motor likewise.
