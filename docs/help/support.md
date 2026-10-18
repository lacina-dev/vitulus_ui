---
id: support
title: Field support
group: Robot
order: 90
icon: la-life-ring
summary: The Support panel, what the watcher does, stack restarts and how to report a problem.
ui: [support, support/issues#issues, support/releases#releases, support/signal#signal]
related: [agent, troubleshooting]
keywords: [support, field, kit, watcher, issue, report, release, retest, signal, restart, stack, dashboard, hlídač]
---
# Field support

The **field support kit** connects this robot with the owner's robot: problems are reported,
fixed, released and retested in one loop. Its full dashboard runs on the robot at
`https://<robot>:8790` (*Support dashboard*); the **Support** panel of this UI shows the
essentials and links there.

```flow
Reported | you describe the problem
Assessed | the owner's side answers
Fixed | a change is made
warn: Released | the robot gets the update
Tested | you try it again
ok: Closed | done
```

## The Support panel

Open **Support** (the last button of the menu band). It only reads; decisions are made on the
dashboard.

### Issues

Open reports with their stage in the loop, severity and **whose turn** it is. Each card has
**Open in Support**, **Ask the agent** (opens the agent chat with a draft about the issue — you
send it) and **Timeline** (Agent › Activity filtered to the issue).

### Releases

The kit version, whether the watcher is fresh, and what waits for a **retest** on this robot.

### Signal

Both robots (heartbeat, kit version, readiness) and the phone notifications (delay, sent,
received).

## What the watcher does

A watcher on the robot runs every ~10 minutes. It fetches news, works out the next step of the
loop (deploy a release, retest, answer, close) and either does it by itself or asks a person with
one click (the bell, [Needs you](agent.md#needs-you)). **It never moves the robot** — anything
with motion is done by a person with a hand on STOP.

## Stack restarts

When new code arrives, the kit restarts the robot stack by itself — but only when it is safe:
the robot in the dock, no program, no agent mission, the dock lock locked, motors and blade off,
no mapping, no motion for 2 minutes, battery at least 15 %. Otherwise the step waits under
*Blokuje* (blocked) with *Zkusit znovu* (try again). You get a notification when it restarted.

> [!IMPORTANT]
> After a restart the **drive motors are OFF** and the kit never switches them on. The map and
> the status icons are grey for a minute while the stack starts.

## Report a problem

1. Open the Support dashboard › **Problems** › **Nové hlášení** (new report).
2. Describe it in your own words. The field agent asks at most three questions, checks the robot
   (read-only), looks for duplicates and writes a draft.
3. When the draft is ready, **Podat hlášení** (submit; two clicks).

From this UI, **Ask the agent** on an issue pre-fills the agent chat. The dashboard has its own
help at **Support › Help** (`#/help`).
