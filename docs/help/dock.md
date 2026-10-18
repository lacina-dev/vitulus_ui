---
id: dock
title: Dock and undock
group: Robot
order: 30
icon: la-home
summary: How the robot leaves and finds its charging dock, and what to do when it fails.
ui: [map/dock]
related: [localization, safety, troubleshooting]
keywords: [dock, undock, charging, reflector, intensity, waypoint, DOCK, UNDOCK, docked, lock]
---
# Dock and undock

The dock charges the robot. Its charging contacts are at the **rear**, so the robot always
**reverses in**. A retro-reflector on the dock lets the lidar find it precisely ("intensity").
The robot counts as **docked when the charger supplies power** (supply icon green, *ONLINE*).

![The dock from above with numbered parts: the dock, its reflector, the seated robot, the DOCK and UNDOCK points, the roof edge and open sky](img/dock.svg "Green dashes = the way out (undock), cyan = the way in (dock, reversing).")

1. **The dock** with the charging contacts on its back wall.
2. **The reflector** — the lidar sees it as a very bright stripe and finds the dock by it.
3. **docked** — the robot's pose when seated (rear on the contacts).
4. **DOCK** — the approach point in front of the dock, facing away from it; from here the robot
   reverses in.
5. **UNDOCK** — the point the robot drives out to.
6. **Under the roof edge** GPS is poor — that is why undock waits for RTK only at UNDOCK.
7. **Open sky** — RTK comes back here.

## Undock

![The Controls section of the right panel: speed, keyboard, battery and the Dock, Undock and Stop buttons](img/shot-controls.webp "Right panel › Controls: 4 Dock · 5 Undock · 6 Stop (aborts the sequence)")

**Right panel › Controls › Undock** runs the saved *undock program*:

```flow
Motors on | the program switches the drive motors on
Back out | intensity: drives 1.25 m out of the dock
To UNDOCK | by the site map, to the UNDOCK point
warn: Wait for RTK | both GPS receivers RTK and GPS odometry ready for 5 s (max 10 min)
ok: Ready | motors stay on
```

- It waits for motors up to 20 s; if they do not come up, the undock aborts.
- With a site map that has an **UNDOCK** point the robot first drives out to that point and only
  then waits for GPS — under the roof edge of the dock the fix is often poor.
- *Waiting for RTK fix* in the status bar means the robot stands and waits for both GPS icons to
  turn green (and for the GPS odometry to settle). Losing RTK restarts the 5 s count. After 10 minutes the undock aborts with
  *Navigation readiness timeout*.

## Dock

**Right panel › Controls › Dock** runs the saved *dock program*:

```flow
To DOCK | navigates by the map to the DOCK point in front of the dock
Find the dock | lidar dock map and / or the reflector
Reverse in | until the charger supplies power
ok: Seat | 15 s seating, then motors off
```

> [!IMPORTANT]
> Docking never switches the motors on. If they are off it fails at once with
> *Motors are OFF – turn motors on to dock*. Switch them on in **Settings › Motors**, then press
> Dock again.

**Stop** next to Dock / Undock aborts the sequence (the status shows *failed* for a moment — that
is expected).

## The Dock tab (Map › Dock)

For setting up and for manual tests; normally the right panel's Dock / Undock is enough.

![The Dock tab of the Map panel with numbered cards](img/shot-dock-tab.webp "Map › Dock: 1 dock by lidar map · 2 dock by intensity · 3 Update the DOCK point · 4 Update the UNDOCK point · 5 dock detector map · 6 localization seed · 7 dock program · 8 undock program")

| Part | What it does |
|---|---|
| Dock by lidar map | enable switch, Predock, Dock, Undock, Stop — the lidar dock-map stage alone |
| Dock by intensity | enable switch, Dock, Undock, Stop — the reflector stage alone |
| Dock / undock points | **Navi** drives to the DOCK or UNDOCK point; **Update** saves the robot's *current* position as that point |
| Dock detector map | New map, Edit map, Save map — the lidar picture of the dock |
| Localization seed | the *docked* pose used to localize in the dock; says *docked waypoint MISSING* when it is not set |
| Dock program / Undock program | tick the steps (map point, lidar map path, intensity action), then **Execute** or **Save** |

The manual cards bypass the dock state machine — use them only while you watch the robot.

### The points

- **DOCK** — the approach point in front of the dock, the goal of the map stage when docking.
- **UNDOCK** — the point the robot drives out to.
- **docked** — the robot's pose when seated; it seeds the localization in the dock. It is created
  automatically when you finish a map recording *while docked* ([Mapping](mapping.md)).

To set DOCK or UNDOCK: drive the robot exactly there (heading too), then **Update**. Or move the
point in the [map editor](map-editor.md).

## Dock lock (agent)

The [Vitulus agent](agent.md) may not undock or drive away from the dock on its own: the **dock
lock** is opened only by the owner, in **Agent › Robot › Dock lock**, for a named scope. See
[Dock lock](agent.md#dock-lock). The lock is only for the agent: a program you start in
**Programs** (Run / Resume) or one the calendar starts undocks without it.

## When it fails

There are no automatic retries: on a timeout or error the sequence goes to *aborted*, the
detectors are switched off and the navigation is cancelled. The motors stay as they were.

> [!TIP]
> - *Motors are OFF* → switch them on, press Dock again.
> - *Map has no DOCK/UNDOCK point* → set the point (above).
> - Stuck at *Waiting for RTK fix* → look at the GPS icons and the
>   [localization state](localization.md); open sky helps, the base station must run.
> - Reflector not found → is the reflector clean and visible, is the robot within a few metres of
>   the dock and facing it? Drive closer with the joystick and try again.
> - More in [Troubleshooting](troubleshooting.md#docking-fails).
