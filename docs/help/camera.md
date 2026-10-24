---
id: camera
title: Camera (D435) — accuracy and calibration
group: Robot
order: 70
icon: la-camera
summary: Settings › Camera — check the depth against the lidar, calibrate the camera with one button and a wizard, the sensor settings and the image layers.
ui: [config/camera]
related: [settings, frame, mapping, troubleshooting]
keywords: [handover, restore the camera, usb, driver reset, camera, d435, realsense, depth, accuracy, calibration, calibrate, tare, on-chip, lidar, obstacles too far, distance, error, emitter, laser, exposure, white balance, layers, restore, factory]
---
# Camera (D435)

**Settings › Camera** has everything about the robot's depth camera (Intel RealSense D435):
whether it runs, how accurate its depth is, its calibration, the sensor settings and the layers
drawn over its image.

## Why accuracy matters

The camera sees obstacles the lidar cannot (low things, things above the lidar's plane). They go
into the costmap and the map **where the camera measures them**. A camera whose depth is off
draws an obstacle *behind* its real place — and the error grows fast with the distance: a stereo
camera's error grows with the **square** of the distance (twice as far = four times the error).

The lidar measures walls to about a centimetre, so the robot uses it as the tape measure: no
RealSense Viewer and no person measuring.

## Check

Press **Check** in the **Depth accuracy** card. For a few seconds the robot compares the camera's
depth with the lidar wherever both see the same surface; the camera keeps running. You get:

| Line | Meaning |
|---|---|
| Error at 1 / 2 / 3 m | how much farther (+) or nearer (−) the camera sees things than they are |
| Checked | when |
| points, range | how many lidar points matched and how far they were |

| Verdict | Error at 2 m | |
|---|---|---|
| green | accurate | ≤ 5 cm |
| orange | slightly off | ≤ 12 cm — calibrating helps |
| red | needs calibration | > 12 cm |
| grey | no data / near walls only | point the robot at walls or posts 1–4 m away and check again |

> [!TIP]
> The check needs something the lidar and the camera both see: walls, posts, door frames,
> a fence. An open lawn gives no data.

## Calibrate (the wizard)

**Calibrate…** opens the wizard in the card. It never moves the robot; the camera pauses for
about a minute (no obstacles from the camera meanwhile).

```flow
Prepare the scene | a flat wall 0.6–2 m in front of the camera, all lines green
Calibrate | backup, on-chip, tare, check — about a minute
ok: Result | saved to the camera, or the previous calibration stays
```

1. **Prepare the scene.** Face the robot squarely to a flat wall, a garage door or a fence board,
   **0.6–2 m** away (1–1.5 m is best). The live image shows a **frame in the middle** — that is
   where the camera calibrates; the wall must fill it. Textured surfaces (brick, wood, plaster)
   work best; not glass, mirrors or a wall in harsh sun. To move the robot, switch the motors on
   and drive with the joystick, or push it by hand with the motors off. The checklist under the
   image turns green line by line and says what to do when a line is red:

   | Red line | What to do |
   |---|---|
   | The robot is moving | let it stand |
   | A mowing program runs | stop it first |
   | No wall in front of the camera | turn the robot to the wall |
   | Too close / too far | 0.6–2 m |
   | At an angle | face the wall squarely (at most 30°) |
   | The wall is not in the frame | come closer; avoid glass, mirrors, dark surfaces |
   | Not flat / ground in the frame | pick a plain wall that covers the middle of the image |

   **Measured with a tape** (optional): the distance from the camera's front glass to the wall,
   square to it. Left empty, the lidar measures it (recommended).
2. **Start calibration.** The robot backs up the camera's calibration, runs the **on-chip**
   calibration (depth noise) and the **tare** (absolute distance, to the wall distance from the
   lidar), then checks the result against the lidar again. **Cancel** works until the camera
   comes back; nothing is changed then.
3. **Result.** When the error got smaller, the new calibration is **saved in the camera** (it
   stays there across restarts and is used by everything that reads the camera). Otherwise the
   previous calibration stays — the camera's memory was never written. The card shows the error
   at 2 m and at the wall before and after.

## The camera during a calibration (handover)

The camera has two users: the ROS driver, which streams it to the robot, and the calibration,
which talks to the camera directly. Handing it over is a fixed sequence; the wizard shows every
step with its state (waiting / running / ok / error) and time, and **each step checks its
result before the next one starts**:

```flow
Ready | the ROS camera streams, no USB reconnecting, nobody else holds it, nothing paused
Pause | ROS camera paused, the camera's USB devices settled for 2 s
Session | one calibration session: backup, on-chip, tare, write into the camera, read back
Released | the calibration holds nothing of the camera any more
Back | a reset of the camera loads the new calibration; the ROS camera streams again (15 Hz)
ok: After | the wall in the middle of the image and the lidar check, compared with before
```

When the result is worse than before, the same four steps run once more (*Revert: …* lines) and
write the backup back, read back and verified.

- **Ready** is also part of step 1 of the wizard (*Camera handover*). A red line there blocks
  **Start**; *USB reconnecting*, *no depth* and *paused from before* show **Restore the camera**
  (a reset of the camera driver, then it waits until depth streams again — about 20–40 s).
- **Back**: when the image does not return in 20 s, the robot resets the camera driver by itself
  and waits up to 40 s more. Only then does it report that the camera did not come back.
- The camera's firmware cannot try a calibration out before saving it: a new calibration only
  takes effect after it is **written into the camera and the camera is reset**. So the robot
  writes it, checks that the camera's memory reads back exactly what was written, resets the
  camera and only then measures. If the error at the wall or the lidar check got worse, it
  writes the backup back by itself.
- The **Calibration library** (pyrealsense2) must match the camera's firmware (FW 05.14 →
  2.53.1). The robot installs the right one by itself into its own folder; the line in
  *Camera handover* says when it is missing or does not match, with **Install the calibration
  library** (needs the internet). With a library that does not match, the camera measures the
  same, but the calibration cannot be written into it.
- The robot changes only what is needed: **on-chip** only when its health says the calibration
  can be improved (|health| ≥ 0.25), **tare** only when the distance at the wall is off by more
  than 1.5 cm (or 1 %). When neither is needed, the result is *The camera is accurate — nothing
  to change* and nothing is written. When both are needed on a camera without the RAM preview,
  tare runs in its own session after the on-chip result is written and loaded (*Tare: …* lines).
- Every end of the wizard says where the camera is (*back and streams* / *not streaming*) and
  whether anything was written into the camera.

**Test camera handover** (under *Details and history*) runs exactly this sequence with a 3 s
stream and writes nothing — a quick way to see that the handover works on this robot.

## When it does not work

- **The button Start stays grey** — a red line in the checklist; the text says why.
- **"Neither on-chip nor tare calibration ran"** — the scene was not good enough for the camera
  (too little texture, too dark, too bright). Try another wall.
- **"Still too far off"** — try a different wall, closer (about 1 m), out of direct sun.
- **"The camera did not come back, not even after a driver reset"** — press **Restore the
  camera**; if the image stays black, restart the stack.
- **"After the pause the camera kept reconnecting on USB"** — the camera was given back; wait a
  minute (the line *The camera is stable on USB* turns green) and try again. If it repeats,
  check the USB cable and connector of the camera.
- **"The camera could not be used for the calibration"** — the small *Detail* line says what
  the camera library reported; nothing was written. **Test camera handover** shows which step
  fails.
- **The calibration library is missing** — the check works, calibrating needs `pyrealsense2` on
  the robot.

## Restore and factory

**Details and history** lists the last calibrations. **Restore previous** writes back the
calibration from before the last saved one; **Factory calibration** writes the one the camera
left the factory with. Both need two clicks and pause the camera for a few seconds. Every write
first keeps a copy of what was in the camera (on the robot in `~/.vitulus/camera/calib/`).

## Camera card

Model, serial number, firmware, USB, and the depth and colour frame rates. Green = streaming,
blue = paused for a calibration, red = no image.

## Sensor

Live settings of the camera: **IR projector** (the pattern that helps the depth on plain
surfaces), **Laser power**, **Depth auto exposure**, **Colour auto exposure**, **Colour auto white
balance**. A change applies at once and is remembered on the robot — it is set again whenever the
camera starts. **•** marks a setting changed from the default; **Defaults** puts them all back.

## Image layers

The overlays drawn over the camera image in the right panel — Lidar, Obstacles, Free, Depth — and
their opacity; the same choice as the layer menu on the image ([The screen](frame.md#camera)).
Recording the camera is in **Settings › Rosbag** ([Settings](settings.md#rosbag)).
