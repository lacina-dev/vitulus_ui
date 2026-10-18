---
id: troubleshooting
title: Troubleshooting
group: When something is wrong
order: 200
icon: la-wrench
summary: The robot does not drive, no map, no GPS fix, docking fails, supervisor FAULT, the UI does not respond.
related: [safety, localization, dock, agent, support]
keywords: [problem, error, fault, not working, does not move, stuck, broken, fix, help, restart, reload, rosbridge]
---
# Troubleshooting

Start with the **status icons** (anything red or grey?), the **status bar** under the menu and the
**log** (Changes). Then find your case below. When nothing helps, ask the
[agent](agent.md) or [report it](support.md#report-a-problem).

## The robot does not drive

Check in this order:

1. **Motors off?** After every start, restart and STOP the drive motors are OFF. The joystick
   shows it, the log says *Motors are OFF – turn motors on to move/dock*. →
   **Settings › Motors › ON**.
2. **Did a person take over?** Moving the gamepad stick (or PS / L1 / R1) or the UI joystick
   cancels the goal, docking and a running program, and the software stays stopped after you let
   go ([Safety](safety.md#the-gamepad-ds4-and-the-joystick-beat-the-software)). → send the goal
   again, Undock again, or **Reset** + **Run** the program. A switched-on gamepad with centred
   sticks does *not* block anything.
3. **A program after Stop?** Run is ignored until **Reset** ([Programs](programs.md#run-it)).
4. **An agent task?**
   - *Dock lock* locked → the mission waits; unlock in **Agent › Robot**
     ([Dock lock](agent.md#dock-lock)).
   - *STOP IS LATCHED* banner → write `/stop pokracuj`.
   - The mission waits for the supervisor → see [Supervisor FAULT](#supervisor-fault).
   - The support kit is restarting the stack → missions wait until it is done.
5. **No active map / no localization** → [The map is not visible](#the-map-is-not-visible),
   [localization state](localization.md#read-the-state-right-panel--navi).

## The map is not visible

1. Reload the page (on a phone: close and reopen the app).
2. **Map › Map**: is a map **active**? After **Deactivate** there is deliberately no map →
   **Activate** one.
3. Are the layers ticked (Base, Saved)? Is their opacity above zero (**Display**)?
4. Right after a stack restart the map comes a minute later.
5. A layer that does not draw is not necessarily missing data — the browser may have missed a
   position transform; a reload fixes that.

## GPS does not fix

1. The two GPS icons and the GNSS line ([Localization](localization.md#read-the-state-right-panel--navi)).
2. In or right next to the dock the fix is often poor — that is why the undock first drives to
   UNDOCK and only then waits for RTK.
3. Open sky, a few minutes of patience, the base station running.
4. `FIX` without `GBAS` = no RTK corrections.
5. Still nothing → record a *GNSS forensics* bag (**Settings › Rosbag**) and report it.

## Docking fails

1. *Motors are OFF* → switch them on, press **Dock** again (docking never switches them on).
2. *Map has no DOCK/UNDOCK point* → set the points ([Dock](dock.md#the-points)).
3. The dock and undock programs must be saved (**Map › Dock**), and the map should have been
   finished *while docked*.
4. Reflector not found → clean the reflector, drive the robot to a few metres in front of the dock
   facing it, try again. **Map › Dock › Dock by intensity** tests this stage alone.
5. A failed sequence does not retry by itself; status *failed* = aborted, detectors off, goal
   cancelled.

## Supervisor FAULT

The agent's chat says the supervisor is in FAULT. It stops the robot repeatedly until it is
safe again; it clears by itself once the robot has stood still for at least 10 s with motors and
blade off. A parked mission then usually resumes by itself; after a person took over it waits for
`pokračuj`. Details: [Supervisor FAULT](agent.md#supervisor-fault).

## The UI does not respond

1. Reload the page. Grey icons and *disconnected* = the page lost the robot — click the
   connection text to reconnect.
2. If every button is dead, the robot's websocket bridge (rosbridge) is down → restart the robot
   stack: the **Restart** item in the navbar menu (it restarts the robot's service; motors are OFF
   afterwards).
3. The page loads but a panel is broken after an update → hard reload (Ctrl+Shift+R).
4. *Agent not responding* in the agent panel → the agent process restarts; wait a minute.
5. For maintainers: the web node is restarted with `tools/restart_webnode` (never `kill -9`).

## Something else

- Open **Settings › Diag** — red rows name the part.
- The log's **ROS** view with level *Error* shows the raw messages.
- Ask the agent in Chat: *proč robot nejede?* — it reads the state for you.
