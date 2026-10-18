---
id: localization
title: Localization and GPS
group: Robot
order: 40
icon: la-crosshairs
summary: How the robot knows where it is — RTK, the map, the dock — and what the states mean.
ui: [right/state, map/gloc#the-loc-tab-lidar-global-localization]
related: [mapping, dock, troubleshooting, status-icons]
keywords: [gps, gnss, rtk, fix, float, pose, tracker, dead reckoning, heading, localize, relocalize, gloc]
---
# Localization and GPS

The robot combines several sources into one position (the *pose*):

- **RTK GPS** — two receivers on the robot plus a base station give centimetre accuracy and the
  heading. Best on open sky.
- **The dock** — while seated in the dock the robot knows exactly where it is.
- **The lidar tracker** — matches the lidar scan against the site map; works at night and under
  trees.
- **Odometry** — wheels, lidar (Li) and camera (VO) measure how the robot moves; alone it drifts.

![Four sources feed one position; the Pose chip says which one owns it now](img/localization.svg "1 RTK GPS (satellites, the base station, the two antennas) · 2 the dock · 3 the lidar tracker (scan against the map) · 4 odometry (wheels, IMU) · 5 one pose · 6 the Pose chip: green = anchored, orange = map-matched, red = drifting")

## Read the state (right panel › Navi)

![The Navi section of the right panel with numbered markers](img/shot-navi.webp "Right panel › Navi: 1 Pose chip · 2 heading source (hdg) · 3 odometry chips VO / Li / Wh / FIX / PROB · 4 GNSS fix · 5 satellites · 6 position accuracy · 7 heading accuracy")

The first chip (1) says **who owns the pose now**:

| Chip | Colour | Meaning |
|---|---|---|
| `RTK` | green | GPS owns the pose. A fix must first prove itself: about 1 m of driving, or about 10 s standing still with a steady fix and a good heading. |
| `DOCK` | green | Anchored by the dock. |
| `TRACKER` | orange | The lidar scan matched against the site map. |
| `RTABMAP` | orange | Camera / lidar map localization (older maps). |
| `EXT` | orange | An external or legacy source. |
| `DEAD-RECKON` / `DR (…)` | red | No absolute anchor — the position drifts (the bracket says which odometry carries it, e.g. `DR (LICP)`). Drive with care, stop longer missions. |

The small chips next to it: **VO / Li / Wh** = visual, lidar and wheel odometry (green = usable,
outlined = in use), **FIX** = a usable raw RTK fix, **PROB** = the GPS fix has proven itself (see
`RTK` above), **Δ** = how far the bridge estimate differs from the live pose, **hdg SAT / IMU** = heading from the two GPS antennas or from the IMU fallback.

**GNSS** line:

| Shown | Meaning |
|---|---|
| `GBAS` | RTK fixed — the good state |
| `FIX` | a standard fix (also RTK float) — not centimetre-exact |
| `SBAS` | satellite-augmented fix |
| `NO FIX` | no position from GPS |
| `fix —` | no data |
| `sats N` | satellites used |
| `pos ±cm` | position accuracy: green ≤ 5 cm, orange ≤ 50 cm, red above |
| `hdg ±°` | heading accuracy: green ≤ 2°, orange ≤ 6°, red above; `—` = no RTK heading |

The two GPS icons in the navbar ([Status icons](status-icons.md)) say the same in one colour:
green = RTK, orange = a 3D fix without RTK (or float), red = bad, grey = no data. **Undocking
waits for both to be green** (docking only when it first has to load the outdoor dock map).

## When GPS does not fix

1. Is the robot under a roof, trees or next to a wall? Drive it a few metres into open sky.
2. Wait — after a start RTK can take a few minutes.
3. Check the base station (power, its own link) — without it there is no RTK.
4. With `FIX` but no `GBAS`, the corrections are missing or poor.
5. The robot can still navigate on the map with the lidar tracker (`TRACKER`), just less
   precisely; long missions should wait for RTK.

See also [Troubleshooting › GPS](troubleshooting.md#gps-does-not-fix).

## The Loc tab (lidar global localization)

**Map › Loc** asks: *where does the current lidar scan fit best on the loaded map?* Use it when
the robot is lost (`DEAD-RECKON`, or the robot on the map is obviously in the wrong place).

![The Loc tab of the Map panel with numbered buttons](img/shot-loc-tab.webp "Map › Loc: 1 Localize · 2 auto 5 s · 3 Apply → robot · 4 Force")

1. **Localize** (or tick **auto 5 s**) — computes candidates. Computing never moves the robot.
2. Read the result: best pose and score, and the **margin**:
   *✓ unambiguous*, *⚠ AMBIGUOUS* or *⚠ YAW MISMATCH (mirror alias?)*. The heatmap shows the
   match (yellow = better, blue cross = best, red cross = where the robot thinks it is).
3. **Apply → robot** sends the best pose to the localization. It is enabled only for an
   unambiguous result; near the dock the robot may still refuse it (the dock wins).
4. **Force** applies it anyway — only for recovery, when you are sure.

> [!TIP]
> A pose that jumps right after undocking usually settles once RTK proves itself (about 1 m of
> driving, or a short stop, in open sky). If the robot is far off, stop, use Loc, then continue.
