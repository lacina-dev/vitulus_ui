---
id: troubleshooting
title: Troubleshooting
group: When something is wrong
order: 200
icon: la-wrench
summary: The robot does not drive, no map, no GPS fix, docking fails or is cancelled, supervisor FAULT, a mission did not finish, the agent after a restart, the UI does not respond, where the logs of the nodes are.
related: [safety, localization, dock, agent, support]
keywords: [problem, error, fault, not working, does not move, stuck, broken, fix, help, restart, reload, rosbridge, docking cancelled, mower stop, reconnect, mission not finished, returned to dock, need help, log, logs, node log, stdout, rosout, journal, journalctl]
---
# Troubleshooting

Start with the **status icons** (anything red or grey?), the **status bar** under the menu and the
**log** (Changes). Then find your case below. When nothing helps, ask the
[agent](agent.md) or [report it](support.md#report-a-problem).

## The robot does not drive

![The drive ring](img/shot-joystick.webp "The drive ring says it first: the stick's edge is grey and the motor icon (6) is orange — click it to switch them on.")

Check in this order:

1. **Motors off?** After every start, restart and STOP the drive motors are OFF. The joystick
   shows it, the log says *Motors are OFF – turn motors on to move/dock*. →
   the orange **motor icon** in the drive ring (green = on) (or **Settings › Motors › ON**).
2. **Did a person take over?** Moving the gamepad stick (or PS / L1 / R1) or the UI joystick
   cancels the goal, docking and a running program, and the software stays stopped after you let
   go ([Safety](safety.md#the-gamepad-ds4-and-the-joystick-beat-the-software)). → send the goal
   again, Undock again, or **Reset** + **Run** the program. A switched-on gamepad with centred
   sticks does *not* block anything.
3. **A program after Stop?** Run is ignored until **Reset** ([Programs](programs.md#interrupt-and-continue)).
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
6. In an agent mission the agent waits for RTK by itself after a failed undock (up to 10 min, the
   display says *Agent: waiting RTK*); without RTK it drives back to the dock
   ([When a step fails](agent.md#when-a-step-fails)).

## Docking fails

1. *Motors are OFF* → switch them on, press **Dock** again (docking never switches them on).
2. *Map has no DOCK/UNDOCK point* → set the points ([Dock](dock.md#the-points)).
3. The dock and undock programs must be saved (**Map › Dock**), and the map should have been
   finished *while docked*.
4. Reflector not found → clean the reflector, drive the robot to a few metres in front of the dock
   facing it, try again. **Map › Dock › Dock by intensity** tests this stage alone.
5. A failed sequence does not retry by itself; status *failed* = aborted, detectors off, goal
   cancelled. An agent mission does retry: it drives in front of the dock (UNDOCK) again and
   docks from there ([When a step fails](agent.md#when-a-step-fails)).

## Supervisor FAULT

The agent's chat says the supervisor is in FAULT. It stops the robot repeatedly until it is
safe again; it clears by itself once the robot has stood still for at least 10 s with motors and
blade off. A parked mission then usually resumes by itself; after a person took over it waits for
`pokračuj`. Details: [Supervisor FAULT](agent.md#supervisor-fault).

## The agent's mission did not finish

- *Back in the dock — the task was not finished*: the agent tried its alternatives, none worked,
  so it brought the robot home. The chat names the cause and every attempt (*Zotavení cestou*).
  Fix the cause (an obstacle, no RTK, a waypoint in a bad place) and give the task again.
- *Need help – see app* on the display: even docking failed; the robot stands with the motors
  off. Look at it, then write `pokračuj` or drive it home yourself.
- The mission waits after a takeover, STOP or the blade: the agent never retries those — write
  `pokračuj` when it is safe.

## Docking was cancelled for no reason

Docking ended with *failed* although nobody pressed anything, often right after a restart or a
supervisor FAULT. An older mowing node used to send a delayed stop to the dock tens of seconds
after a mower stop, even with no program running. Now a mower stop cancels docking only while a
mowing program runs, and at once ([Mowing unit](mowing.md#stop)). If it still happens, report it
with the time.

## The agent does not see the robot after a restart

After the robot's software restarted, the agent reconnects by itself within a few seconds; a
mission waiting on the robot goes on. If the chat keeps saying the robot does not answer for
more than a minute, ask the agent *stav robota* or report it ([Robot restart during a
mission](agent.md#robot-restart-during-a-mission)).

## The UI does not respond

1. Reload the page. Grey icons and *OFFLINE* in the navbar = the page lost the robot — click
   that text (*Click to reconnect*) to reconnect at once.
2. If every button is dead, the robot's websocket bridge (rosbridge) is down → restart the robot
   stack: the **Restart** item in the navbar menu (it restarts the robot's service; motors are OFF
   afterwards).
3. The page loads but a panel is broken after an update → hard reload (Ctrl+Shift+R).
4. The agent panel says the agent is not running on this robot or is not responding → the
   agent restarts by itself after a crash; wait a minute. Still the same → report it.
5. For maintainers: the web node is restarted with `tools/restart_webnode` (never `kill -9`).

## Where the logs of the robot's nodes are

For maintainers and the agent, on the robot (SSH). Every ROS node writes into its own file in the
directory of the current run, `~/.ros/log/latest/`:

- `<node>-N-stdout.log` — what the node printed (its INFO messages, `print`). The name follows the
  node's namespace and name, e.g. `d435-realsense2_camera_manager-12-stdout.log` or
  `mower-node_mower-26-stdout.log`. Follow one with
  `tail -f ~/.ros/log/latest/navi_man-*-stdout.log`.
- `rosout.log` — the messages of **all** nodes in one file, every line with the node's name; the
  quickest way to find who reported an error: `grep -i error ~/.ros/log/latest/rosout.log`.
- `<node>-N.log` — the internal log of Python nodes; `roslaunch-*.log` — starts, crashes and
  respawns of nodes.
- The service journal (`journalctl -u vitulus`) is only for the start of the stack; it also gets
  the nodes' warnings and errors (stderr), but without node names — look into the files above.
- An older run: `ls -t ~/.ros/log/` lists the run directories, newest first. Old runs are cleaned
  up daily (older than 7 days, the whole directory kept under 500 MB).

## Something else

- Open **Settings › Diag** — red rows name the part.
- The log's **ROS** view with level *Error* shows the raw messages.
- Ask the agent in Chat: *proč robot nejede?* — it reads the state for you.
