---
id: agent
title: Vitulus agent
group: Robot
order: 80
icon: la-comments-o
summary: Give the robot a task in plain words, follow its missions, approvals, findings and the dock lock.
ui: [agent, agent/chat#give-a-task, agent/work#work-approvals-and-jobs, agent/activity#activity, agent/findings#findings, agent/robot#robot-and-the-dock-lock, agent/models#models, needs#needs-you]
related: [safety, dock, support]
keywords: [learn, learned, playbook, experience, naučil, co ses naučil, jak bys to řešil, strategy, free drive, until docked, agent, chat, mission, task, test drive, pokračuj, continue, zruš, cancel, approve, deny, findings, needs you, bell, dock lock, unlock, supervisor, fault, stop latched, restart, reconnect, ros master]
---
# Vitulus agent

The agent is an assistant on the robot. It reads the robot's state, answers questions, keeps an
eye on problems and — within strict limits — drives the robot for you. Open **Agent** in the menu
band. Write to it in Czech or English; most of its replies are in Czech.

Tabs: **Chat** · **Work** · **Activity** · **Findings** · **Robot** · **Models**.

## Give a task

Type into **Chat** what you want, in plain words. A simple drive becomes a **mission** straight
away, for example:

```
udělej undock, dojeď na TEST, počkej 10 s a vrať se do doku
```

A mission is a numbered job (**#N**) of steps: *undock*, *drive to a named waypoint*, *wait*
(up to 10 min), *dock*. The plan is checked before anything moves (the waypoints must exist on the
active map), then the agent reports after each step. Anything more complex (photos, maps, routes,
conditions) goes to its planner first. **The mower and the blade are never part of a mission.**

```flow
You write | "drive to TEST and back"
Plan + check | waypoints exist, actions allowed
warn: Dock lock | the owner allows the move
Run | step by step, a report after each
ok: Report | done, or why not
```

### Continue and cancel

| You write | What happens |
|---|---|
| `pokračuj` (or *jeď dál*, *dokonči to*, *odblokuj*…) | resumes the newest parked mission; also restarts the newest cancelled / failed one (within 2 h) from the step where it stopped |
| `pokračuj na 223` / `pokračuj misi #223` | resumes mission #223; `pokračuj na 223: …` adds information |
| `zruš misi #223` (or *zrušit job 223*, *stop mise 223*) | cancels #223 at once — a running step ends, the robot is stopped, no further step starts |
| `zruš to` | cancels the current job |

Only these fixed words continue or cancel — never a model's guess. The mission card has the same
as buttons (**Resume**, **Cancel**), and **Follow up** pre-fills `pokračuj na N: `.

## Work (approvals and jobs)

**Work** has the **approvals** pinned on top, then *Needs you* (parked jobs), the jobs and the
*Mission / driving* card. When the agent wants to do something that needs a person, it asks:
**Approve** / **Deny**. If the robot would move, the card says
*THE ROBOT WOULD MOVE — only you may allow this* and the button needs a second tap.

## Robot and the dock lock

**Robot** shows the live state, the robot tools and the **Dock lock** card.

### Dock lock

By default the agent **cannot move the robot out of the dock** — every moving action (undock,
dock, drive to a waypoint, drive a path) needs the owner's click here. Stopping always works.

1. Pick a preset and read its scope: *Actions*, *Not allowed*, *Valid for*, *Uses*,
   *Signed by*.
   - **Free drive — anything until the robot is back in the dock** (on top) — unlocks every
     move (not the mower) without a use limit. It locks itself once the robot is back in the
     dock (or after 12 h at most). Unlocked while the robot stands in the dock, it waits until the
     robot leaves and comes back. The card says *Unlocked until docked*.
   - **Test drive** — undock, drive to waypoints, dock back (and switch motors on if needed);
     30 min, up to 8 moves; no saved routes, no mower.
   - **Undock only, once** — 15 min, 1 use.
   - **Undock and dock back** — 30 min, 2 uses.
2. **Unlock — tap again to confirm**, then **Yes — unlock the dock** within 6 s.
3. While open the card shows *UNLOCKED*, *Uses left*, *Expires in* and **Lock again** — which
   takes any unlock back at once.

A mission that needs the lock parks itself; its chat message has **Open Dock lock**. After you
unlock, the mission continues by itself (after 2 h of waiting only `pokračuj` restarts it). The
lock governs the agent only, not your own buttons and joystick.

## The agent's STOP

The red **STOP** in the agent panel's head (two taps) stops what the agent started — the
supervisor stops the robot within about 1.5 s. It **latches**: the agent refuses all actions,
and a banner says *STOP IS LATCHED*, until you write `/stop pokracuj`. It is not the robot STOP —
that is the red STOP bottom left ([Safety](safety.md#stop)).

### Supervisor FAULT

While a mission drives, a separate supervisor watches it. It goes to **FAULT** and keeps the
robot stopped when the robot leaves its allowed area, loses its position, the agent stops
answering, the time runs out, the blade spins, or a **person takes over** (joystick, gamepad).
It clears itself after at least 10 s once the robot stands still with the motors and the blade
off — nothing moves when it clears. A parked mission then resumes by itself (at most twice in 30
min); after a takeover, the blade or a position bound it waits for `pokračuj`.

The supervisor's stop switches the blade off directly; it sends the mower stop only while a
mowing program runs, so a FAULT during a test drive never cancels the docking that follows.

### Robot restart during a mission

When the robot's software restarts (the support kit does it after an update), the agent stays
running and reconnects to the restarted robot by itself within a few seconds — the mission sees
the robot again and goes on. A parked mission resumes once the supervisor is READY, starting
from what the robot really is doing (an undock it already finished is not repeated). If the
agent itself had to restart because of it, the mission also resumes by itself; after any other
restart of the agent (yours, a crash) it waits for `pokračuj`.

## Activity

One timeline of what the agent and the support kit did — reports, decisions, deploys — with
filters. Decisions made in the UI are signed with your name and show up here.

## Findings

What the agent noticed in the logs and the robot's health. It sorts each finding by itself:
a real problem (looks deeper and repairs it if it may), expected, noise (both closed), or
uncertain (it asks you one question). On a card: **Acknowledge**, **Investigate** (returns a
verdict: fix now / later / monitor / ignore), **Resolve**, **Undo ignore**, and for a repair plan
**Approve plan** / **Deny**.

Repairs by itself change only the agent's own code, never driving, mowing or safety (those are
only proposed), and never while a mission runs. You get a short message *Problem · Reasoning ·
Fix · Verification* with *Vrátit zpět* (revert) and *Příště ignorovat* (ignore next time).

## What the agent learns

Every mission is kept as an **episode**: the task, map, waypoint, time of day and light, rain,
RTK, battery, CPU load and code version, every step that failed (with its failure class and the
raw reason), what the agent tried next and whether it helped, how long each step took, and the
end. From these it counts — simply and visibly, no black box:

- **which recovery helps** for which failure, as a smoothed success rate with the counts it is
  made of (*via waypoint X helped 3/3 here, 4/5 for this action*); a recovery tried 3× that never
  helped is marked *don't repeat*;
- **how long steps really take** (*undock after the map: median 150 s, max 170 s — keep the step
  limit at least 255 s*);
- **lessons** from its reflection — all of them, also those that no longer fit its short memory.

Besides single recoveries it keeps whole **strategies**: which tools and steps solved a kind of
situation, which one was decisive, which were useless, how long it took and what it cost (model
calls, CPU). It recalls them by how **similar** the situation is — localization, GPS, obstacle,
light, terrain; the place is only one of the features — so a way that worked on one map is tried
on another, and a strategy that keeps failing stops being preferred. Ask `jak bys to řešil`
(optionally with the problem, e.g. *…když je ztracená lokalizace*) to see what it would do and why.

The result is the agent's **playbook**: the planner and the mission decider read it, and you can
too — write `co ses naučil` or `/naucil` in **Chat** (the full playbook is the file
`~/.vitulus/agent/playbook.md`).

When the same failure keeps coming back and nothing it knows helps, the agent opens a **finding**
for it by itself (**Findings**), and the usual path follows: analysis, and a repair through tests
— never while a mission is running.

## Models

Which AI model does what for the agent (chat, planning, analysis) — informational.

## Needs you

The **bell** in the navbar is quiet when nothing waits, orange with a count when something does,
red when it is urgent or the robot would move. It opens one list of everything that waits for a
person:

- **Robot agent** — approvals and parked jobs; decide them in **Agent › Work**.
- **Support** — what the field support kit waits for. These can be decided right in the list:
  **Done**, an option of the card, **Hide 24 h**, **Remind**, **Accept / Dismiss** a finding. Two
  clicks within 5 s; each decision is signed with your name. An option that moves the robot is
  never offered here.
