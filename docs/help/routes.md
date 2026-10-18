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

The planner retries three times and clears its obstacle memory before it gives up.
**Cancel navigation** stops the drive (the log says *Goal canceled*; the motors stay on).

## Speed

**Right panel › Controls › Slow / Mid / Fast** sets the driving speed of navigation and of the
joystick. It is remembered on the robot across restarts.

| | forward | reverse | turn |
|---|---|---|---|
| Slow | 0.25 m/s | 0.25 m/s | 0.9 rad/s |
| Mid | 0.4 m/s | 0.25 m/s | 0.9 rad/s |
| Fast | 0.75 m/s | 0.5 m/s | 1.5 rad/s |

## Points

**Map › Point** lists saved points: **Go** drives there, **Show** shows it on the map, **Remove**
deletes it. **Add** saves the robot's current position as a new point.

## Paths

**Map › Path** lists saved paths: **Drive**, **Add** (a point), **Show**, **Remove**.
To record one: type a name, then **New** (starts at the current position, add points as you
drive) or **New auto** (records as you drive; **Stop auto** ends it). **Clear paths** deletes all.

Paths and waypoints can also be drawn in the [map editor](map-editor.md).
