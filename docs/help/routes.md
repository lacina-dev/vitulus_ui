---
id: routes
title: Paths, points and the marker
group: Robot
order: 58
icon: la-map-signs
summary: Send the robot somewhere — by the marker, a saved point or a saved path.
ui: [marker, map/path#paths, map/point#points]
related: [map-editor, frame, safety]
keywords: [marker, goal, send goal, cancel navigation, path, point, waypoint, go, drive, record path, speed]
---
# Paths, points and the marker

All of these drive the robot by itself on the active map — the drive motors must be on, and you
should be able to see the robot or the camera. **Cancel navigation** or **STOP** ends the drive.

## Send a goal with the marker

1. Open **Marker** in the menu band. A goal marker appears on the map.
2. Click or tap the map where the robot should go (or drag the marker).
3. Turn it with the **Heading** slider to the direction the robot should end in.
4. Press **Send goal**.

When it finds no path the planner tries up to three times; when the drive itself fails it clears
its obstacle memory and plans again before it gives up.
**Cancel navigation** stops the drive (the log says *Goal canceled*; the motors stay on).

## Speed

**Right panel › Controls › Slow / Mid / Fast** sets the driving speed of navigation and of the
joystick. It is remembered on the robot across restarts. Navigation:

| | forward | reverse | turn |
|---|---|---|---|
| Slow | 0.25 m/s | 0.25 m/s | 0.9 rad/s |
| Mid | 0.4 m/s | 0.25 m/s | 0.9 rad/s |
| Fast | 0.75 m/s | 0.5 m/s | 1.5 rad/s |

The joystick drives with the same forward speed (also in reverse) and turns at 0.6 / 1.3 /
1.5 rad/s.

## Points

**Map › Point** lists saved points: the marker button at the start of a row drives there, **Show**
shows it on the map, **✕** removes it. Type a name and press **Add** to save the robot's current
position as a new point; **Clear points** deletes all points of the map. **Cancel navi** stops the
drive.

## Paths

**Map › Path** lists saved paths: the arrow button at the start of a row drives the path, **Add**
adds the robot's current position as the next point, **Show** shows it, **✕** removes it.
To record one: type a name, then **New** (starts at the current position, add points as you
drive) or **New auto** (records as you drive; **Stop auto** ends it). **Clear paths** deletes all
paths of the map. **Cancel navi** stops the drive.

Paths and waypoints can also be drawn in the [map editor](map-editor.md).
