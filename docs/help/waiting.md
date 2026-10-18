---
id: waiting
title: Why the robot waits
group: Robot
order: 70
icon: la-hourglass-half
summary: Battery, rain, temperature, the night window and other reasons why nothing starts.
ui: [map/rain]
related: [programs, mowing, troubleshooting]
keywords: [wait, waiting, sleep, rain, weather, battery, temperature, night, forecast, radar, idle, does not start]
---
# Why the robot waits

Often the robot does nothing on purpose. The calendar's status line
([Programs › Calendar](programs.md#the-calendar)) and the log say why.

## Before a program starts

The scheduler starts nothing while:

- automation is off, or **Hold** is on;
- the robot is **not in the dock**;
- the robot stack started less than 5 minutes ago, or the programs are not loaded yet;
- the mission is not ready (e.g. it waits for **Reset** after a stop);
- it is outside the **day window 07:00–21:00** — the robot sleeps until the window opens;
- the scheduled program is not on the active map (skipped for that day).

A program also refuses to start when:

- the **battery is below 40 %**;
- it **rains now**, rained in the last 60 minutes, or rain is forecast within 30 minutes.

> [!NOTE]
> On this robot the rain checks are currently configured **off** (`weather_rain_bypass: true` in
> `vitulus_navi/config/mower_smach.yaml`).

## During mowing

| Reason | What happens |
|---|---|
| Battery ≤ 25 % | returns to the dock, charges, then **resumes** |
| Rain (2 of 3 forecast steps say RAIN) | returns, sleeps 4 h, then tries again |
| Mower too hot (TEMP) | returns, sleeps 1 h |
| A critical error | sleeps 30 min |
| Terminal error | waits 20 min, resets, then sleeps 8 h |
| Stopped by a person | nothing automatic — start it again yourself |

Resuming needs at least 40 % battery. Recovery sleeps are shortened so the robot is awake for the
next scheduled program. A program that ends off the dock waits 20 minutes for the robot to come
back, then the robot goes to an emergency sleep.

## Weather (Map › Rain)

The cloud icons in the navbar show the rain alert: OK, rain expected, raining now (click it to
refresh). **Map › Rain** has the **weather report** (status, alert, current rain, place, time and
a timeline of past and forecast steps: OK / WARN / ALERT / RAIN / UNAVAILABLE), the **rain now**
radar image and the **forecast** (+10 / 20 / 30 min). The images refresh every 30 s.

## Temperature

The temperature icons (board, outside) and the motor icons turn orange when warm and red when
hot. The power module has its own temperature limits (**Settings › Power**); the safety node
switches the drive motors off above 70 °C.
