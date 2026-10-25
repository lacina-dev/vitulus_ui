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

Open **Support** (the button next to **Agent** in the menu band). What waits for you is in the
bell ([Needs you](agent.md#needs-you)); this panel is the overview of the loop. Its tabs: **Issues**, **Releases**, **Signal** and **Help** (the topics of
this help).

![The Support panel with its tabs and the first issue card](img/shot-support.webp "Support › Issues: tabs Issues · Releases · Signal · Help, then one card per open report")

### Issues

Open reports with their stage in the loop, severity and **whose turn** it is. Each card has
**Detail**, **Open in Support**, **Ask the agent** (opens the robot agent's chat with a draft
about the issue — you send it) and **Timeline** (Agent › Activity filtered to the issue).

**Detail** shows the issue for people, as on the dashboard's issue page:

- the title, **who reported it and when** (and which issue it follows);
- the **phases** — Reported → Cause → Fix released → Verified → Done — each with **who** did it
  and **when**; the current one is orange;
- **Problem · Cause · Fix** in one sentence each;
- **What to do** — whose turn it is, the sentence to tell your agent, the steps or variants, and
  **Start with the agent** (two clicks: the sentence goes to your agent in the issue's thread);
- **Who did what** — the history, newest first.

The technical protocol for agents stays on the dashboard (the button at the end). **← Issues** or
the **Issues** tab goes back to the list.

### Releases

- On top one sentence: *The newest release field-… went out 2 h ago.* and how many released fixes
  wait for a test by the other side. The kit version and the watcher's last check are folded
  under *Details for agents*.
- **Sent to ⟨Mac⟩** — the three newest releases: what the other side gets in one sentence (*Mac
  gets 13 changes (vitulus_ui) by itself, without a click. Then a build and a stack restart – the
  watcher does it once the robot is idle.*) and, folded, **What changes**: per repository the
  branch, who and when, and the commit subjects, newest first. Older releases under **Older (N)**.
- **Released, waiting for a test** — the issues whose fix went out and waits for a retest.

### Signal

Both robots (heartbeat, kit version, readiness) and the phone notifications (delay, sent,
received).

## What the watcher does

A watcher on the robot runs whenever the signal brings news, and on a timer (every 10 minutes, or
every 30 while the signal works). It fetches news, works out the next step of the
loop (deploy a release, retest, answer, close) and either does it by itself or asks a person with
one click (the bell, [Needs you](agent.md#needs-you)). **It never moves the robot** — anything
with motion is done by a person with a hand on STOP.

## Stack restarts

When new code arrives, the kit restarts the robot stack by itself — but only when it is safe:
the robot in the dock, no program, no agent mission, the dock lock locked, motors and blade off,
no mapping, no motion for 2 minutes, battery at least 15 %. Otherwise the step waits under
**Blocked** on the dashboard with **Try again**. You get a notification when it restarted.

> [!IMPORTANT]
> After a restart the **drive motors are OFF** and the kit never switches them on. The map and
> the status icons are grey for a minute while the stack starts.

## Report a problem

1. Open the Support dashboard › **Issues** › **New report**.
2. Describe it in your own words. The field agent asks what is missing, checks the robot
   (read-only), looks for duplicates and writes a draft.
3. When the draft is ready, **File the report** (two clicks: the second one confirms).

From this UI, **Ask the agent** on an issue pre-fills the agent chat. The dashboard has its own
help (`#/help`); **Support › Help › Support kit help** opens it.
