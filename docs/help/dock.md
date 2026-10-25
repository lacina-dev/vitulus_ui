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

![The Controls section of the right panel: battery, motors and the Dock, Undock and Stop buttons](img/shot-controls.webp "Right panel › Controls: 3 Dock · 4 Undock · 5 Stop (aborts the sequence)")

**Right panel › Controls › Undock** runs the saved *undock program*:

```flow
Motors on | the program switches the drive motors on
Back out | intensity: drives 1.25 m out of the dock
To UNDOCK | by the site map, to the UNDOCK point
warn: Wait for RTK | both GPS receivers RTK and GPS odometry ready for 5 s (10 min, after a reboot up to ~25 min)
ok: Ready | motors stay on
```

- It waits for motors up to 20 s; if they do not come up, the undock aborts.
- With a site map that has an **UNDOCK** point the robot first drives out to that point and only
  then waits for GPS — under the roof edge of the dock the fix is often poor.
- *Waiting for RTK fix* in the status bar means the robot stands and waits for both GPS icons to
  turn green (and for the GPS odometry to settle). Losing RTK restarts the 5 s count. Every 30 s
  the display shows the progress, e.g. *Waiting for RTK: main RTK, heading 3DFIX - 4:43 / 19:43*
  (time waited / current limit).
- The limit is 10 minutes. While the receivers make progress (the main one reaches RTK, the
  heading one switches to RTK) it grows by 15 minutes, but never past ~25 minutes after the GPS
  came up — after a reboot the heading receiver needs ~15–17 minutes. Then the undock aborts with
  *RTK not ready in time*. In a mowing program the robot then drives back to the dock and the
  program is retried later (like after any other error); a manual Undock leaves it standing.

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

The robot first helps itself, and it always says what is going on in the status bar — it never
just stands there.

```flow
Dock check | before it looks for the reflector and before it starts to move, the robot checks the docking controller, the lidar reflector filter and the motors
Watch progress | while reversing in (and driving out) it watches that the distance keeps shrinking
warn: Stalled | 15 s without progress → it stops and says why
Retry | restarts the docking controller and tries again; with a map it first drives back to the DOCK point (at most 2×)
err: Aborted | only then: *Docking aborted: …* with the reason
```

What you can see in the status bar:

| Message | What the robot does |
|---|---|
| *Dock check: waiting for …* | a part of the docking is not ready yet (normal for a few seconds after Dock); after 15 s it restarts the docking controller once |
| *Dock check failed: …* | the part did not come up even after the restart → the retry below |
| *Docking stalled: no progress for 15 s (… m to go): …* | the robot stopped; the reason says why — e.g. *collision gate* (the lidar sees something right next to the robot), *dock reflector not visible*, *drive motors are off* |
| *Docking motion held: collision gate …* (log) | something is within ~1.5 cm of the robot; it waits instead of pushing |
| *Docking retry 1/2: …* | it restarts the controller and tries again by itself |
| *Docking aborted: …* | after 2 retries it gives up: the detectors are switched off, the navigation is cancelled, the motors stay as they were |

If the charger supplies power during a retry, the robot counts as docked. *Motors are OFF* is
never retried — docking does not switch the motors on.

> [!TIP]
> - *Motors are OFF* → switch them on, press Dock again.
> - *Docking aborted: stalled … collision gate* → look around the robot: something stands right
>   next to it (a toy, a hose, a post). Remove it and press Dock.
> - *Map has no DOCK/UNDOCK point* → set the point (above).
> - Stuck at *Waiting for RTK fix* → look at the GPS icons and the
>   [localization state](localization.md); open sky helps, the base station must run.
> - Reflector not found → is the reflector clean and visible, is the robot within a few metres of
>   the dock and facing it? Drive closer with the joystick and try again.
> - More in [Troubleshooting](troubleshooting.md#docking-fails).
