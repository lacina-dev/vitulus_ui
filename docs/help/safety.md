---
id: safety
title: Safety
group: Start here
order: 20
icon: la-shield
summary: STOP, the gamepad, the blade, the power button and why motors are off after a start.
ui: [stop]
related: [dock, mowing, frame]
keywords: [stop, emergency, blade, knife, gamepad, ds4, motors off, danger]
---
# Safety

Vitulus is a heavy robot with a sharp, fast blade. It moves by itself when a program, a mission
of the agent or a navigation goal tells it to.

> [!CAUTION]
> Keep hands and feet away from the underside while the mower is powered. Never lift or tilt the
> robot with the blade running. Children and pets must not be near a mowing robot.

## STOP

The red **STOP** button, always bottom left (same place and size on every screen), does all of
this at once:

1. cancels the navigation goal,
2. switches the drive motors **off**,
3. stops a running mowing program,
4. stops the blade,
5. stops docking or undocking,
6. opens the motor switch of the power module.

After a STOP nothing drives until someone switches the motors on again
(**Settings › Motors › ON**, or an Undock, which switches them on by itself). STOP is sent once —
it does not lock anything, so a new command (an Undock, the display) can switch the motors on again.

> [!NOTE]
> The agent panel has its own red **STOP** in its head. It stops the agent's mission and is
> answered by the robot core, never by a model.

## Motors are off after every start

After a boot, a restart of the robot stack or a restart of the base driver, the **drive motors
are OFF**. The robot cannot move until someone switches them on:

- **Settings › Motors › ON**, or
- **Undock** (the undock program switches them on), or
- the button on the robot's display.

The safety node switches the motors off by itself (with an alarm) when a motor reports a fault,
stops reporting, or gets hotter than 70 °C while powered.

## The gamepad (DS4) overrides the software

A paired PlayStation DS4 gamepad talks to the robot directly (no web UI, no Wi-Fi needed).
**As soon as it is switched on it sends drive commands all the time** — zero while the sticks are
centred — and so it overrides autonomous navigation and docking: the robot practically stands
still and does what the sticks say.

- Right stick forward / back, left stick turn.
- Triangle / Cross = mower power on / off, Circle / Square = blade on / off,
  D-pad up / down = cut height, left / right = blade RPM.

> [!WARNING]
> - The gamepad does **not** switch the drive motors off and does not cancel the navigation goal.
>   When you switch it off (or walk out of range) the software drives on where it stopped. Cancel
>   the goal or press **STOP** if the robot must stay.
> - Switch the gamepad **off** before a program, an undock or an agent mission — otherwise it
>   holds the robot. A mission of the agent counts it as a human taking over and stops.
> - With the motors off the gamepad does not move the robot either.

## The physical button

Holding the power button on the robot for **4 seconds or longer** cuts the power of the motors,
the battery output and the computer (the hardest stop; the UI goes away too). Holding it only
2–4 s is a standby that software can undo.

## The blade

- The blade has its own switch: **Settings › Mower › START MOTOR / STOP MOTOR**
  ([Mowing](mowing.md)). Programs start and stop it by themselves.
- Switching the mower **power** on does not start the blade; it only re-applies the last height
  and RPM.
- **STOP** always stops the blade too.

## Trying things without moving the robot

Open the UI with `?mock` at the end of the address (for example `http://192.168.0.1:7779/?mock`).
The page then **reads** everything live but **sends nothing** to the robot: a small *MOCK* badge
counts what was blocked. Good for learning the UI and for testing layouts.
