#!/usr/bin/env python3
"""Lidar <-> D435 extrinsics check from a bag (offline, no ROS master).

What the camera overlay (nodes/camera_overlay) can only be as good as: the
URDF positions of base_scan and d435_color_optical_frame. This tool measures
them against each other from recorded data.

  static BAG [--cam-yaw DEG] [--cam-ty M] [--cam-pitch DEG]
      Robot standing still. Median /scan and median aligned depth over the
      bag; every lidar point is projected into the colour image with the TF
      from the bag's /tf_static (optionally with a trial correction of the
      camera mount, applied at d435_bottom_screw_frame like the URDF does)
      and compared with the D435 depth in that pixel:
        * depth - lidar by range band (same-surface matches only) and the fit
          depth - lidar = k * z^2 (a stereo disparity bias grows with z^2;
          a TF error does not)
        * occlusion edges: lidar edge vs depth edge in the same image row [px]
        * grid fit of camera yaw / lateral shift (robust, depth bias removed)
  crab BAG
      Robot driving (daylight for VO). For straight segments of the wheel
      odometry: direction of travel in /licp/odom and /vo/odom vs their own
      heading. A sensor mounted with a yaw error e shows a constant crab
      angle e (same sign forward and backward); the wheel odometry is the
      0 reference.

Record (read-only, robot still, 30-60 s):
  rosbag record -O s.bag /scan /d435/aligned_depth_to_color/image_raw \
      /d435/color/camera_info /d435/color/image_raw/compressed /tf /tf_static
Best scene: 1.5-5 m in front of flat walls / posts / door frames with free
space behind them (clean vertical edges at several distances, left and
right of the image centre), not clutter.
"""
import argparse
import sys

import numpy as np
import rosbag

DEG = np.pi / 180.0


# ------------------------------------------------------------------ TF utils
def quat_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def rz(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def ry(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


class Static(object):
    def __init__(self, tfs):
        self.p = {}
        for tr in tfs:
            T = np.eye(4)
            q = tr.transform.rotation
            t = tr.transform.translation
            T[:3, :3] = quat_mat((q.x, q.y, q.z, q.w))
            T[:3, 3] = (t.x, t.y, t.z)
            self.p[tr.child_frame_id] = (tr.header.frame_id, T)

    def to_base(self, frame, upto='base_link'):
        T = np.eye(4)
        while frame != upto:
            if frame not in self.p:
                raise KeyError('no static TF chain %s -> %s' % (frame, upto))
            parent, A = self.p[frame]
            T = A @ T
            frame = parent
        return T

    def camera(self, frame, yaw=0.0, pitch=0.0, ty=0.0, mount='d435_bottom_screw_frame'):
        """base <- camera optical, with a trial correction of the mount joint."""
        Tm = self.to_base(mount)
        Tmc = np.linalg.inv(Tm) @ self.to_base(frame)
        Tm2 = Tm.copy()
        Tm2[:3, :3] = rz(yaw * DEG) @ ry(pitch * DEG) @ Tm[:3, :3]
        Tm2[1, 3] += ty
        return Tm2 @ Tmc


# ------------------------------------------------------------------ static
def load_static(path):
    b = rosbag.Bag(path)
    tfs, depths, scans, ci, sm = [], [], [], None, None
    for top, m, _ in b.read_messages():
        if top == '/tf_static':
            tfs.extend(m.transforms)
        elif top.endswith('aligned_depth_to_color/image_raw'):
            d = np.frombuffer(m.data, dtype='<u2').reshape(m.height, m.width).astype(np.float32)
            d[d == 0] = np.nan
            depths.append(d / 1000.0)
        elif top == '/scan':
            scans.append(np.asarray(m.ranges, dtype=np.float32))
            sm = m
        elif top == '/d435/color/camera_info':
            ci = m
    if not (tfs and depths and scans and ci):
        sys.exit('bag needs /tf_static, aligned depth, /scan and /d435/color/camera_info')
    S = np.stack(scans)
    S[~np.isfinite(S)] = np.nan
    with np.errstate(all='ignore'):
        D = np.nanmedian(np.stack(depths), axis=0)
        r = np.nanmedian(S, axis=0)
    a = sm.angle_min + np.arange(len(r)) * sm.angle_increment
    return Static(tfs), D, r, a, sm.header.frame_id, ci


class Scene(object):
    def __init__(self, path):
        self.st, self.D, self.r, self.a, self.lframe, ci = load_static(path)
        P = ci.P
        self.fx, self.cx, self.fy, self.cy = P[0], P[2], P[5], P[6]
        self.cframe = ci.header.frame_id
        self.H, self.W = self.D.shape
        self.Tbl = self.st.to_base(self.lframe)

    def lidar_pts(self, idx=None):
        r, a = (self.r, self.a) if idx is None else (self.r[idx], self.a[idx])
        return np.c_[r * np.cos(a), r * np.sin(a), np.zeros_like(r)]

    def project(self, Tcl, P):
        pc = P @ Tcl[:3, :3].T + Tcl[:3, 3]
        z = pc[:, 2]
        with np.errstate(all='ignore'):
            return self.fx * pc[:, 0] / z + self.cx, self.fy * pc[:, 1] / z + self.cy, z

    def Tcl(self, yaw=0.0, pitch=0.0, ty=0.0):
        return np.linalg.inv(self.st.camera(self.cframe, yaw, pitch, ty)) @ self.Tbl

    def depth_at(self, u, v, win=1):
        out = np.full(len(u), np.nan)
        for i, (uu, vv) in enumerate(zip(u, v)):
            ui, vi = int(round(uu)), int(round(vv))
            if win <= ui < self.W - win and win <= vi < self.H - win:
                p = self.D[vi - win:vi + win + 1, ui - win:ui + win + 1]
                if np.isfinite(p).any():
                    out[i] = np.nanmedian(p)
        return out

    def pairs(self, yaw=0.0, pitch=0.0, ty=0.0, win=1):
        ok = np.isfinite(self.r)
        u, v, z = self.project(self.Tcl(yaw, pitch, ty), self.lidar_pts()[ok])
        m = (z > 0.3) & (u >= 1) & (u < self.W - 1) & (v >= 1) & (v < self.H - 1)
        return u[m], v[m], z[m], self.depth_at(u[m], v[m], win)

    def edges(self, yaw=0.0, pitch=0.0, ty=0.0, k=0.0, jump=0.3, search=40):
        """lidar occlusion edges vs the depth edge in the same row [px]."""
        Tcl = self.Tcl(yaw, pitch, ty)
        r, a, n = self.r, self.a, len(self.r)
        out = []
        for i in range(n):
            j = (i + 1) % n
            for f, b in ((i, j), (j, i)):
                if not np.isfinite(r[f]) or (np.isfinite(r[b]) and r[b] - r[f] < jump):
                    continue
                ae = np.angle(np.exp(1j * a[f]) + np.exp(1j * a[b]))
                P = np.array([[r[f] * np.cos(a[f]), r[f] * np.sin(a[f]), 0],
                              [r[f] * np.cos(ae), r[f] * np.sin(ae), 0]])
                u, v, z = self.project(Tcl, P)
                if not (z[0] > 0.3 and search + 3 < u[1] < self.W - search - 3 and 1 < v[0] < self.H - 1):
                    continue
                side = np.sign(u[1] - u[0])
                row = self.D[int(round(v[0]))]
                row = row / (1 + k * row)
                best = None
                for du in range(-search, search + 1):
                    u0 = int(round(u[1])) + du
                    fg, bg = row[int(u0 - side * 2)], row[int(u0 + side * 2)]
                    if np.isfinite(fg) and abs(fg - z[0]) < 0.12 * z[0] and \
                            (not np.isfinite(bg) or bg - z[0] > 0.25):
                        if best is None or abs(du) < abs(best):
                            best = du
                if best is not None:
                    out.append((u[1], z[0], side, best))
        return np.array(out).reshape(-1, 4)


def cmd_static(o):
    sc = Scene(o.bag)
    print('lidar %s, camera %s, %dx%d, fx %.1f' % (sc.lframe, sc.cframe, sc.W, sc.H, sc.fx))
    Tbc = sc.st.camera(sc.cframe, o.cam_yaw, o.cam_pitch, o.cam_ty)
    print('base<-lidar  t %s  yaw %+.2f deg' % (np.round(sc.Tbl[:3, 3], 3),
                                               np.degrees(np.arctan2(sc.Tbl[1, 0], sc.Tbl[0, 0]))))
    print('base<-camera t %s  (trial yaw %+.2f pitch %+.2f deg, ty %+.3f m)' % (
        np.round(Tbc[:3, 3], 3), o.cam_yaw, o.cam_pitch, o.cam_ty))
    u, v, z, d = sc.pairs(o.cam_yaw, o.cam_pitch, o.cam_ty)
    e = d - z
    same = np.isfinite(e) & (np.abs(e) < 0.06 * z + 0.05)
    print('\nlidar points in image %d, with depth %d, same-surface %d' % (len(z), np.isfinite(e).sum(), same.sum()))
    print('median |depth - lidar| all %.3f m, same-surface %.3f m' % (
        np.nanmedian(np.abs(e)), np.median(np.abs(e[same])) if same.any() else np.nan))
    for lo, hi in ((0.3, 1.5), (1.5, 2.5), (2.5, 3.3), (3.3, 5.0), (5.0, 10.0)):
        s = same & (z >= lo) & (z < hi)
        if s.any():
            print('  z %.1f-%.1f m  n %3d  depth - lidar %+.3f m (%+.1f %%)' % (
                lo, hi, s.sum(), np.median(e[s]), 100 * np.median(e[s] / z[s])))
    k = float(np.sum(e[same] * z[same] ** 2) / np.sum(z[same] ** 4)) if same.any() else 0.0
    print('fit depth - lidar = k z^2: k = %.4f 1/m  (1 m %+.3f, 2 m %+.3f, 4 m %+.3f)' % (k, k, 4 * k, 16 * k))
    E = sc.edges(o.cam_yaw, o.cam_pitch, o.cam_ty, k)
    print('\nedges (depth edge - lidar edge, + = lidar left of the image edge):')
    for x in E:
        print('  u %4.0f  z %.2f m  bg %s  %+3d px' % (x[0], x[1], 'right' if x[2] > 0 else 'left ', x[3]))
    if len(E):
        print('  median %+.1f px, median |.| %.1f px, n %d' % (np.median(E[:, 3]), np.median(np.abs(E[:, 3])), len(E)))
    if o.fit:
        print('\ngrid fit (robust, depth bias k removed): yaw [deg] x ty [m]')
        res = []
        for yw in np.arange(-3, 3.01, 0.1):
            for ty in np.arange(-0.06, 0.0601, 0.01):
                uu, vv, zz, dd = sc.pairs(o.cam_yaw + yw, o.cam_pitch, o.cam_ty + ty, win=0)
                rel = (dd / (1 + k * dd) - zz) / zz
                rel = rel[np.isfinite(rel)]
                res.append((np.sum(np.log1p((rel / 0.03) ** 2)), yw, ty, len(rel)))
        res.sort()
        for c, yw, ty, n in res[:6]:
            print('  cost %7.1f  yaw %+.1f  ty %+.2f  n %d' % (c, yw, ty, n))
        c0 = [x for x in res if abs(x[1]) < 1e-6 and abs(x[2]) < 1e-6][0][0]
        print('  (no correction: cost %.1f)  — trust only when the best is clearly separated' % c0)


# ------------------------------------------------------------------ crab
def cmd_crab(o):
    b = rosbag.Bag(o.bag)
    tops = ['/mobile_base_controller/odom', '/licp/odom', '/vo/odom', '/odometry/ekf_wheel_odom']
    D = {}
    for top, m, _ in b.read_messages(topics=tops):
        q = m.pose.pose.orientation
        if q.w == 0 and q.z == 0 and q.x == 0 and q.y == 0:
            continue                      # rtabmap odometry lost
        yaw = np.arctan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
        p = m.pose.pose.position
        D.setdefault(top, []).append((m.header.stamp.to_sec(), p.x, p.y, yaw,
                                      m.twist.twist.linear.x, m.twist.twist.angular.z))
    D = {k: np.array(v) for k, v in D.items()}
    w = D.get('/mobile_base_controller/odom')
    if w is None:
        sys.exit('bag needs /mobile_base_controller/odom')
    win = o.window

    def straight(t0, t1):
        s = (w[:, 0] >= t0) & (w[:, 0] <= t1)
        if s.sum() < 5:
            return 0
        v, om = w[s, 4], w[s, 5]
        if np.all(np.abs(om) < 0.08) and np.all(np.abs(v) > 0.12) and (np.all(v > 0) or np.all(v < 0)):
            return int(np.sign(v[0]))
        return 0

    for top in tops:
        if top not in D:
            print('%-30s not in bag' % top)
            continue
        A = D[top]
        res = []
        t = A[0, 0]
        while t < A[-1, 0] - win:
            sg = straight(t, t + win)
            i0, i1 = np.searchsorted(A[:, 0], t), min(np.searchsorted(A[:, 0], t + win), len(A) - 1)
            if sg and i1 - i0 > 3 and A[i1, 0] - A[i0, 0] < win * 1.4:
                dx, dy = A[i1, 1] - A[i0, 1], A[i1, 2] - A[i0, 2]
                dyaw = np.angle(np.exp(1j * (A[i1, 3] - A[i0, 3])))
                if np.hypot(dx, dy) > 0.15 and abs(dyaw) < 4 * DEG:
                    ang = np.arctan2(dy, dx) + (np.pi if sg < 0 else 0)
                    yaw = np.angle(np.exp(1j * A[i0, 3]) + np.exp(1j * A[i1, 3]))
                    res.append((np.degrees(np.angle(np.exp(1j * (ang - yaw)))), sg))
            t += win
        R = np.array(res).reshape(-1, 2)
        for sg in (1, -1):
            x = R[R[:, 1] == sg, 0]
            if len(x):
                print('%-30s %s n %4d  crab median %+.2f deg  IQR [%+.2f %+.2f]' % (
                    top, 'fwd' if sg > 0 else 'rev', len(x), np.median(x), *np.percentile(x, [25, 75])))
    print('sensor yaw error ~ mean of fwd and rev medians (same sign both ways);'
          ' fwd/rev of opposite sign = lag / lever arm, not mounting')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd')
    s = sp.add_parser('static')
    s.add_argument('bag')
    s.add_argument('--cam-yaw', type=float, default=0.0, help='trial extra camera yaw [deg]')
    s.add_argument('--cam-pitch', type=float, default=0.0, help='trial extra camera pitch [deg]')
    s.add_argument('--cam-ty', type=float, default=0.0, help='trial extra camera y shift [m]')
    s.add_argument('--fit', action='store_true', help='grid fit camera yaw / y shift')
    c = sp.add_parser('crab')
    c.add_argument('bag')
    c.add_argument('--window', type=float, default=1.5)
    o = ap.parse_args()
    if o.cmd == 'static':
        cmd_static(o)
    elif o.cmd == 'crab':
        cmd_crab(o)
    else:
        ap.print_help()


if __name__ == '__main__':
    main()
