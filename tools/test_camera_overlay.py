#!/usr/bin/env python3
"""Offline checks of nodes/camera_overlay (no ROS master needed).

  python3 tools/test_camera_overlay.py

1. pinhole projection with a known calibration (pixel, depth, drop behind /
   outside the image, plumb_bob distortion);
2. the packed wire format (what vt_cam_overlay.js decodes);
3. PointCloud2 parsing (x, y, z at their offsets, NaN dropped);
4. TF timing: data at its stamp, camera at the image stamp, joined through
   odom — a point seen before a 10 deg turn lands where it is in the newer
   image (the RViz Camera display behaviour), not where the stale pose says;
5. depth colour map: no depth = black, near = red, far = blue.
"""
import importlib.machinery
import math
import os
import struct
import sys

import numpy as np
import rospy
import tf2_ros
from geometry_msgs.msg import TransformStamped
from sensor_msgs.msg import CameraInfo, PointCloud2, PointField

HERE = os.path.dirname(os.path.abspath(__file__))
co = importlib.machinery.SourceFileLoader(
    'camera_overlay', os.path.join(HERE, '..', 'nodes', 'camera_overlay')).load_module()

fails = []


def check(name, ok, info=''):
    print(('ok    ' if ok else 'FAIL  ') + name + ('  ' + info if info else ''))
    if not ok:
        fails.append(name)


def cinfo(D=None, frame='cam'):
    ci = CameraInfo()
    ci.header.frame_id = frame
    ci.width, ci.height = 640, 480
    ci.P = [600.0, 0, 320, 0, 0, 600.0, 240, 0, 0, 0, 1, 0]
    ci.D = D or [0.0] * 5
    ci.distortion_model = 'plumb_bob'
    return ci


# 1 ---------------------------------------------------------------- projection
I = co.Intrinsics(cinfo())
u, v, z = co.project(np.array([[0.5, 0.25, 2.0], [0, 0, -1.0], [10, 0, 1.0], [0, 0, 0.05]]), I)
check('pixel of a known point', u.shape == (1,) and abs(u[0] - 470) < 1e-6 and abs(v[0] - 315) < 1e-6
      and abs(z[0] - 2.0) < 1e-9, '%s %s' % (u, v))
Id = co.Intrinsics(cinfo(D=[0.1, 0, 0, 0, 0]))
ud, vd, _ = co.project(np.array([[0.5, 0.25, 2.0]]), Id)
r2 = 0.25 ** 2 + 0.125 ** 2
check('plumb_bob radial distortion', abs(ud[0] - (320 + 600 * 0.25 * (1 + 0.1 * r2))) < 1e-6)

# 2 -------------------------------------------------------------- wire format
b = co.pack(np.array([470.4, 10.0]), np.array([315.6, 479.0]), np.array([2.0, 0.5]), I, 12.5, 12.75)
mg, w, h, n, td, ti = struct.unpack_from('<4sHHIdd', b)
body = np.frombuffer(b, '<u2', offset=28)
check('packed header', (mg, w, h, n, td, ti) == (b'VCO1', 640, 480, 2, 12.5, 12.75))
check('packed points u,v,mm', list(body) == [470, 316, 2000, 10, 479, 500], str(list(body)))
check('packed size 28 + 6/pt', len(b) == 28 + 12)

# 3 -------------------------------------------------------------- cloud parse
pc = PointCloud2()
pc.height, pc.width, pc.point_step = 1, 3, 16
pc.row_step = 48
pc.fields = [PointField('x', 0, 7, 1), PointField('y', 4, 7, 1), PointField('z', 8, 7, 1),
             PointField('rgb', 12, 7, 1)]
pc.data = struct.pack('<4f4f4f', 1, 2, 3, 0, float('nan'), 0, 1, 0, 4, 5, 6, 0)
p = co.cloud_points(pc)
check('PointCloud2 x,y,z (NaN dropped)', p.shape == (2, 3) and list(p[1]) == [4, 5, 6])

# 4 ------------------------------------------------------------- TF at stamps
rospy.rostime.set_rostime_initialized(True)


def tfm(parent, child, t, x=0.0, y=0.0, z=0.0, yaw=0.0, q=None):
    m = TransformStamped()
    m.header.frame_id, m.child_frame_id = parent, child
    m.header.stamp = rospy.Time.from_sec(t)
    m.transform.translation.x, m.transform.translation.y, m.transform.translation.z = x, y, z
    if q is None:
        q = (0, 0, math.sin(yaw / 2), math.cos(yaw / 2))
    (m.transform.rotation.x, m.transform.rotation.y, m.transform.rotation.z,
     m.transform.rotation.w) = q
    return m


buf = tf2_ros.Buffer(rospy.Duration(30))
# camera optical frame on base_link (z forward = base x, x right = -base y, y down = -base z)
buf.set_transform_static(tfm('base_link', 'cam', 0, x=0.2, z=0.5, q=(-0.5, 0.5, -0.5, 0.5)), 't')
buf.set_transform_static(tfm('base_link', 'laser', 0, x=0.1, z=0.3), 't')
yaw2 = math.radians(10)
for t, yaw in ((9.9, 0.0), (10.0, 0.0), (10.5, yaw2), (10.6, yaw2)):
    buf.set_transform(tfm('odom', 'base_link', t, yaw=yaw), 't')


class Fake(object):
    pass


node = Fake()
node.intr = co.Intrinsics(cinfo(frame='cam'))
node.tf_buf = buf
node.fixed = 'odom'
node.tf_timeout = 0.0
L = co.Layer('scan', '', None, None, None)
pt = np.array([[4.0, 0.0, 0.0]])            # 4 m straight ahead of the laser
node.t_img = rospy.Time.from_sec(10.0)      # image at the same time as the scan
c0 = co.CameraOverlay.to_camera(node, L, 'laser', rospy.Time.from_sec(10.0), pt)
u0, _, _ = co.project(c0, node.intr)
node.t_img = rospy.Time.from_sec(10.5)      # newer image, robot turned 10 deg left
c1 = co.CameraOverlay.to_camera(node, L, 'laser', rospy.Time.from_sec(10.0), pt)
u1, _, _ = co.project(c1, node.intr)
check('same time: point on the optical axis', abs(u0[0] - 320) < 0.5, 'u=%.2f' % u0[0])
# turned left -> the point moves right in the image by about fx*tan(10 deg)
exp = 320 + 600 * math.tan(yaw2)
check('image later than data: motion compensated through odom', abs(u1[0] - exp) < 8,
      'u=%.1f expected ~%.1f' % (u1[0], exp))
node.fixed = 'nonexistent'                  # no fixed frame -> transform at the data stamp
c2 = co.CameraOverlay.to_camera(node, L, 'laser', rospy.Time.from_sec(10.0), pt)
check('fallback: transform at the data stamp', np.allclose(c2, c0))

# 5 ---------------------------------------------------------------- colour map
lut = co.turbo_lut()
d = np.array([[0.0, 0.2, 5.0]], dtype=np.float32)
img = co.depth_colormap(d, 0.2, 5.0, lut)
check('no depth = black', list(img[0, 0]) == [0, 0, 0])
check('near = red (R > B)', int(img[0, 1, 2]) > int(img[0, 1, 0]), str(img[0, 1]))
check('far = blue (B > R)', int(img[0, 2, 0]) > int(img[0, 2, 2]), str(img[0, 2]))

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
