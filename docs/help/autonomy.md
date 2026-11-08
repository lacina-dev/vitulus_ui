---
id: autonomy
title: Autonomy
group: Robot
order: 65
icon: la-calendar-check-o
summary: What the robot does on its own and why, and all the rules for it — automatic mowing, Hold, who decides (calendar or agent), plan, weather, battery, sleep, faults.
ui: [autonomy]
related: [programs, waiting, settings]
keywords: [autonomy, autonomie, automatic, automation, hold, pause, who decides, agent mode, advice, dock permission, hard limits, plan, calendar, weather, rain, ignore rain, battery, sleep, stay awake, faults, retries, history, locked, limits]
---
# Autonomy

**Autonomy** in the menu is the one place that says what the robot does on its own and why. The top
card says in one sentence what it does now and what comes next. Under the next start two buttons answer
at a glance: **who decides** (*Calendar decides* / *Agent decides*) and **could it start now** (*Could start
now*, amber *Waits: Weather* or *Hard limit: cold*, red *Won't start now: Battery +1*, grey *Won't start now: Nothing planned* — the first thing that
holds it and how many more; grey when it is your choice or the state of the robot, e.g. *Won't start now:
Automation*, *Waits for the agent's advice*, *Not now: Sleeping*, *Not starting now*; amber *Going to sleep*
while a sleep counts down). It is green only when the robot reports that it waits for its next start and
nothing holds it by the robot's own rules: no check blocks or waits, automation and programs are on, no hard
limit in force, an advice that wants to go has the dock permit (the calendar standing in needs none). Any
other state is not green; its sentence is in the tooltip. A tap opens that section; nothing is sent. The
next start is said only here. Under the buttons one short line says the sleep: *Sleeps 6 h 27 min once
free; held by: Logins, Web UI ›* — the whole sentence is in its tooltip and in **Sleep**, where a tap
on the line takes you.

When the page loses the robot (more than 3 s), the top card says *No connection to the robot since 20:12:
what you see here may no longer hold.* and the rest of the page goes muted: it is the last state the
robot sent, not the current one. It goes away as soon as the robot answers again.

Under the card come the sections, on every screen in this order: **Now**, **Plan**, **Who decides**,
then Weather, Battery, Sleep, Faults, History, Advanced. Each has a head with a colour and short
tokens; open it for the live numbers (battery now, errors, wakes — not the settings again) and the controls. What you open stays open; the head of an open section stays at the top while you scroll through it, so it
folds from there, and with three or more open **Fold all** at the foot of the top card folds them all. On a first visit Now and
Plan are open; Who decides stays folded while the calendar decides (the card says so) and opens by
itself while the agent decides, until you open or fold it yourself.

![The top of Autonomy with numbered markers](img/shot-autonomy.webp "1 state tag · 2 what it does now, next under it · 3 who decides: calendar or agent · 4 could it start now · 5 the sleep, short · 6 Automatic mowing · 7 Pause (Hold)")

## The two switches

- **Automatic mowing** is the master switch: calendar starts, sleeping and resuming. Off, nothing
  starts by itself and the robot does not sleep by itself ([more](programs.md#automation-on--off)).
- **Pause (Hold)** stops **new starts only**. A running mission finishes; to end it use **Stop**
  ([more](programs.md#hold)).

## Now

**Could it start now?** shows first what holds a start: amber waits, red is blocked, grey is switched
off (automation, no programs). The head of the section says the same as the top card. The conditions
that are fine (green; *no time limit* counts as fine) and those not checked now (grey: GPS is checked when a run starts, the line shows
the live fix) fold into one line, *Nothing holds a start: 10 fine. Not checked now: 2.*; **Show all**
lists every one of them, **Problems only** folds them again (remembered).
The › next to a line takes you to where it is fixed. What keeps the robot awake is in **Sleep**.

## Plan

![Plan with numbered markers](img/shot-autonomy-plan.webp "1 the next 7 days: hours 0–24, allowed time (blue), starts (marks, with the time under them), expected sleep (hatched grey), now (white line) · 2 Skip next · 3 No mowing today · 4 Start the next program now (its own row, it moves the robot; the line under it says what it does, or why it would be refused now)")

The calendar and the [allowed mowing time](programs.md#allowed-mowing-time) are here; the head of the
section shows the allowed time while it limits (*Allowed 07:00–21:00*). The timeline covers the next
7 days with an hour scale on top: a day on which something happens (a start, a sleep that begins or
ends) gets its track with the allowed time, the starts and the expected sleep (hatched); days asleep
all day, or with nothing, fold into one line each, e.g. *Tue 10 Nov – Fri 13 Nov: asleep the whole
time*. Each calendar entry is one row: its switch, the program over its time and days, **Edit** and
**Delete**; an entry switched off says *Off* and only its name and time are dimmed. When every entry is
switched off (and the calendar decides), nothing starts by itself and the page says why: *Nothing is
planned: the calendar entry Bigger 23:15 is switched off* in **Could it start now?** (› opens Plan), *Calendar
off* in the head of Plan and a line in Plan to switch it on. **Skip next** skips one start (its second line names it: *Bigger · today 23:15*),
**No mowing today** skips today. A skipped start is crossed out in the timeline, and the same button
undoes it.

**Start Bigger now** (the name of the next program; *Run next planned now* when nothing is planned)
has its own row below them, because it moves the robot. It brings the next planned start forward:
the robot leaves the dock and mows at once, and that start is used up (it does not run again at its
time). It is a start by hand, so the hard limits don't apply, but every check of **Could it start
now?** still must pass. The line under the button says this before you tap — or why the robot would
refuse it now (*Would be refused now: Not in the dock*, *…: Falling asleep*, a hardware reset coming), that a run is under
way, or that an open run waits (*Bigger waits (Battery): nothing more starts*). Tap
twice: the first tap asks *Tap again*, after 4 s it lets go by itself. The calendar
form, recurrence and the catch-up rules are in [Programs and calendar](programs.md#the-calendar).

## Weather

![Weather with numbered markers](img/shot-autonomy-rain.webp "1 the radar now and the next 30 minutes · 2 what rain does")

One choice decides what rain does; the head of the section says it (*Rain stops all*, *Rain stops
calendar*, *Rain ignored*) next to the radar now:

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

The sentence under **Sleep** is the plan: when it goes to sleep, for how long, when it wakes. Until it
sleeps, the **Next wake** tile shows that planned wake (*≈ 23:01 (plan)*); once asleep, the robot's own. Right
under it **Why isn't it sleeping?** lists what keeps the robot awake; someone logged in on a terminal
or an open web UI is blue, it keeps the robot awake on purpose. The top of the page says the same
short (who holds it by name), and **Cancel** is above the map, in the right panel and at the top while
a sleep is counting down. With the robot's timing the power goes
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

In the panel it is the section **Who decides**, under Plan:

![Who decides with numbered markers](img/shot-autonomy-mode.webp "1 Calendar | Agent · 2 waits for the dock permission, Dock permit › · 3 the advice in force · 4 rules and hard limits")

- **Calendar | Agent**: the highlighted one is what the robot reports. A tap switches, the line under it
  says *Switched to: Agent* once the robot confirms (or why not). Opening the page never switches
  anything. The head of the section shows the mode and what it does now: *By the plan*, *Plan + limits*, *Calendar stands in*,
  *Waits for advice*, *Limit: rain*, *Waits for dock*…
- **Waits for dock** (amber box): the agent wants to mow and the dock is locked. It names the program
  and until when the advice holds; **Dock permit ›** opens the dock permit tile in the Agent panel,
  where you allow a time window. The page does not allow the dock itself. Before the advice's time the
  box is blue and says the robot will leave only with your permission. Without an advice waiting, a quiet
  line under the switch says the permit (*Dock unlocked until 17:00*, *Dock locked*, a scheduled
  window) with **Dock permit ›**; when a window ended with the robot out, the box says that it
  finishes the path and comes home.
- In **Could it start now?** an advice run has the line **Dock permit** (*Allowed*, *Not allowed: the
  advice waits for your dock permit*, *The owners file is missing*, …); calendar runs do not have it.
- **Advice in force**: what the agent advised (mow program X between …, or no mowing until …), its
  state (waiting, carried out, missed, expired, dropped), confidence and reason in the language of the
  page (an older agent sends only its own words, in Czech: those show).
- **Last decision**: what was decided, when, by whom (agent or calendar) and why — the same sentence as
  in the History. In the Calendar mode it shows only once there is a decision. A decision whose time is over (*no mowing
  until 19:30* at 20:10) is grey with *over at 19:30*. While the amber box says
  that the advice waits for your dock permission, the same decision is not repeated under it.
- **Rules and hard limits** fold away: the head says *in force* or *not in force now*; they open by
  themselves while in force and stay folded while not, until you open or fold them yourself (remembered). Inside, first one line with the [allowed mowing time](programs.md#allowed-mowing-time),
  e.g. *Allowed mowing time 07:00–21:00 (on) — applies to the agent too* or *off*. It is the same time
  as in Plan, there is no separate one for the agent; **›** takes you to the card in Plan where you set
  it. Then *Calendar stands in without advice*, *Hard limits for the calendar too*, *Wait after rain*,
  *Lowest temperature*, *Same zone again after*. These limits apply only in the Agent mode, or in the
  Calendar mode with *Hard limits for the calendar too* on. Each with its default and **Reset**, saved
  like any setting.

In the agent mode the agent looks at the weather (rain history and forecast), when each zone was last
mowed, what the last run left unfinished and how heavy the cutting was, and tells the robot *mow
program X between these times* or *don't mow until T*, with its reason and confidence. The robot
carries the advice out the same way as **Run next**: every check of **Could it start now?** still
applies. **Leaving the dock stays yours:** the robot follows the agent's "mow" only inside a dock permit
window you allowed ([Dock permit](agent.md#dock-permit)); without it the agent tells you once in the
chat — "I want to mow X between …, allow the dock" — and the robot waits. When the window ends with
the robot out, it finishes the path (at most 5 min) and comes home (history: *the dock permit ended
with the robot out*); a new window from now cancels that. Without a fresh advice the calendar decides meanwhile (it can be switched off: then nothing
starts without the agent). While an advice is in force, the calendar's slots are the agent's to decide
and are not caught up later. In the agent mode the robot sleeps at most until the allowed mowing time
opens next, so the agent gets its daily look.

**Hard limits** stay in the robot, the agent cannot override them: starts only in the allowed mowing
time (07:00–21:00 by default, also with less than 30 minutes of it left nothing starts; a run already
out goes on until it ends, as in the calendar; with the time switched off, the time of day does not
hold the agent either), not within 3 h after rain,
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

The journal says in plain words what happened: started, finished, how a run ended when it did not
finish (*stopped by hand*, *ended: someone switched the mower's power off*, *gave up after repeated
errors*), skipped, missed, why it waited (*stopped for rain* vs *start refused because of rain — it did not leave*), slept, woke (on time, or how much
later or earlier than planned — *Woke up 5 days later than planned* after a power cut), what setting changed and who changed it (*You
changed: Ignore open UI → on*; a burst of changes within a minute or two is one row: where each setting ended up, *(×4)*), and the agent's advice and the switches of who decides. The newest
come first, under a line for each day, each row with its time; **Show older** adds the rest. Filter
it: **Mowing** (runs and their waits), **Decisions** (who decides, the agent's advice, settings),
**Problems** (what went wrong, red or amber, with their count) or **Sleep**; the choice is
remembered. Problems the robot reports stay on top until you **Clear** them.

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
