#!/usr/bin/env python3
"""Offline checks of nodes/camera_calib (no ROS master, no camera needed).

  python3 tools/test_camera_calib.py

1. fit_bias: synthetic depth - lidar pairs with a z^2 stereo bias (our
   camera k = 0.013, Mac's k = 0.09) plus noise and outliers (edges,
   background) -> k recovered, verdict ok / warn / bad;
2. plane_z_roi: a wall straight ahead and one turned 25 deg -> the mean Z
   over the central ROI;
3. decide: better -> keep, not better / worse in the lidar -> revert.
"""
import importlib.machinery
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
cc = importlib.machinery.SourceFileLoader(
    'camera_calib', os.path.join(HERE, '..', 'nodes', 'camera_calib')).load_module()

fails = []


def check(name, ok, info=''):
    print(('ok    ' if ok else 'FAIL  ') + name + ('  ' + info if info else ''))
    if not ok:
        fails.append(name)


def pairs(k, n=600, seed=1):
    rng = np.random.default_rng(seed)
    z = rng.uniform(0.6, 4.0, n)
    e = k * z * z + rng.normal(0, 0.01 + 0.005 * z, n)
    bad = rng.random(n) < 0.15                # edges / background behind the lidar point
    e[bad] = rng.uniform(0.5, 3.0, bad.sum())
    return z, e


# 1. fit_bias
for k, want in ((0.013, 'warn'), (0.09, 'bad'), (0.0, 'ok'), (0.008, 'ok')):
    z, e = pairs(k)
    f = cc.fit_bias(z, e)
    check('fit_bias k=%.3f' % k, f is not None and abs(f['k'] - k) < 0.004,
          'k %.4f n %s' % (f['k'], f['n']) if f else 'None')
    check('verdict k=%.3f -> %s' % (k, want), cc.verdict(f) == want, cc.verdict(f))
check('fit_bias too few pairs -> None', cc.fit_bias([1.0] * 5, [0.0] * 5) is None)
check('verdict(None) = no_data', cc.verdict(None) == 'no_data')
z, e = pairs(0.0)
m = z < 1.3
check('only near walls -> limited', cc.verdict(cc.fit_bias(z[m], e[m])) == 'limited')

# 2. plane_z_roi: camera at base origin, optical frame z = base x, x = -base y, y = -base z
T = np.eye(4)
T[:3, :3] = np.array([[0, 0, 1], [-1, 0, 0], [0, -1, 0]], float)
W, H, fx, fy = 256, 144, 128.0, 128.0
wall = (np.array([1.5, 0.0]), np.array([-1.0, 0.0]))       # x = 1.5, normal to the camera
zc = cc.plane_z_roi(wall, T, fx, fy, W / 2, H / 2, W, H)
check('wall ahead at 1.5 m', abs(zc - 1.5) < 1e-6, '%.4f' % zc)
a = math.radians(25)
n = np.array([-math.cos(a), -math.sin(a)])
wall = (np.array([1.5, 0.0]), n)
zc = cc.plane_z_roi(wall, T, fx, fy, W / 2, H / 2, W, H)
check('wall turned 25 deg: ROI mean ~ centre', abs(zc - 1.5) < 0.01, '%.4f' % zc)
T2 = T.copy()
T2[:3, 3] = (0.2, 0.0, 0.3)                                 # camera 0.2 m in front of base
zc = cc.plane_z_roi((np.array([1.5, 0.0]), np.array([-1.0, 0.0])), T2, fx, fy, W / 2, H / 2, W, H)
check('camera offset 0.2 m -> 1.3 m', abs(zc - 1.3) < 1e-6, '%.4f' % zc)

# 3. decide
b = {'b2': 0.36}
good = {'b2': 0.01}
keep, why = cc.decide(b, good, 1.78, 1.502, 1.5)
check('better -> keep', keep and why == 'calib.res.saved', why)
keep, why = cc.decide(b, good, 1.505, 1.56, 1.5)
check('worse at the wall -> revert', not keep and why == 'calib.res.not_better', why)
keep, why = cc.decide({'b2': 0.02}, {'b2': 0.2}, 1.52, 1.501, 1.5)
check('lidar after much worse -> revert', not keep and why == 'calib.res.lidar_worse', why)
keep, why = cc.decide(None, None, float('nan'), float('nan'), 1.5)
check('no measurement -> revert', not keep and why == 'calib.res.no_measure', why)
keep, why = cc.decide(None, None, 1.9, 1.62, 1.5)
check('better but still far off -> revert', not keep and why == 'calib.res.still_off', why)

# 4. Handover: the ROS <-> SDK state machine against a fake world (virtual
#    clock; the driver, the kernel's /dev/video nodes, the SDK, our fds)
class FakeSession(object):
    def __init__(self, world):
        self.w = world
        if world.sdk_raises:
            raise RuntimeError("acquire: Cannot open '/dev/video0' Last Error: No such file or directory")
        world.open_sessions += 1

    def close(self):
        self.w.open_sessions -= 1


class FakeOps(object):
    def __init__(self, **kw):
        self.t = 1000.0
        self.streaming = True          # ROS driver streams depth
        self.stream_from = 0.0
        self.polling = True
        self.flag = None
        self.nodes_at = None           # time the uvcvideo nodes appear after the pause
        self.unstable = False          # nodes renumber forever (the 24. 10. failure)
        self.stops = True              # depth stops after enable false
        self.enable_true_fails = False
        self.enable_true_dead = False  # enable true answers, depth never comes
        self.reset_works = True
        self.leak = False
        self.sdk_raises = False
        self.foreign = []
        self.binds = []
        self.open_sessions = 0
        self.resets = 0
        self.calls = []
        self.__dict__.update(kw)

    # clock
    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s

    def gc(self):
        pass

    # driver
    def enable(self, on):
        self.calls.append(('enable', on))
        if on:
            if self.enable_true_fails:
                raise RuntimeError('open(...) failed. UVC device is streaming!')
            if not self.enable_true_dead:
                self.streaming, self.stream_from = True, self.t + 1.0
                self.nodes_at = None
        else:
            if self.stops:
                self.streaming = False
            self.nodes_at = self.t + 0.6

    def reset(self):
        self.resets += 1
        if not self.reset_works:
            raise RuntimeError('reset failed')
        self.streaming, self.stream_from = True, self.t + 15.0
        self.nodes_at = None

    def polling_get(self):
        return self.polling

    def polling_set(self, v):
        self.polling = v

    def depth_hz(self):
        return 15.0 if self.streaming and self.t >= self.stream_from + 2.0 else 0.0

    def depth_age(self):
        return 0.05 if self.streaming and self.t >= self.stream_from else 99.0

    # kernel / sysfs / proc
    def video_nodes(self):
        if self.nodes_at is None or self.t < self.nodes_at:
            return []
        if self.unstable:
            k = int((self.t - self.nodes_at) / 0.5) % 2
            return ['video%d' % (4 * k + i) for i in range(4)]
        return ['video0', 'video1', 'video2', 'video3']

    def binds_since(self, t):
        return sum(1 for b in self.binds if b >= t)

    def foreign_holders(self):
        return list(self.foreign)

    def sdk_problem(self):
        return getattr(self, 'sdk_prob', None)

    def held_by_self(self):
        return ['/dev/video0 (deleted)'] if self.leak else []

    def flag_get(self):
        return self.flag

    def flag_set(self, d):
        self.flag = dict(d)

    def flag_clear(self):
        self.flag = None

    def sdk_open(self):
        return FakeSession(self)


def job(ops, work=None):
    """preflight -> pause -> session -> resume like run_dry, with the same
    'resume on every exit' rule as start_job. -> (error key, steps)"""
    st = cc.Steps(['preflight', 'pause', 'sdk', 'release', 'resume'], clock=ops.now)
    H = cc.Handover(ops, st)
    err = None
    try:
        H.preflight()
        H.pause()
        H.session(work or (lambda s: 'ok'))
        H.resume()
    except cc.StepError as ex:
        err = ex.key
    finally:
        if H.paused:
            try:
                H.resume()
            except cc.StepError as ex:
                err = err or ex.key
        st.finish()
    return err, {i['id']: i['s'] for i in st.items}, st


o = FakeOps()
err, s, st = job(o)
check('handover ok: every step ok', err is None and all(v == 'ok' for v in s.values()), str(s))
check('handover ok: polling off during, back on after', o.polling is True and ('enable', False) in o.calls)
check('handover ok: flag cleared, no reset, session closed', o.flag is None and o.resets == 0 and o.open_sessions == 0)
check('handover ok: pause waited for stable nodes', st.get('pause').get('nodes') == 4)

o = FakeOps(flag={'polling': True}, streaming=False, foreign=['python3(42)'])
err, s, _ = job(o)
check('preflight: left flag + no depth + foreign -> refused, nothing paused',
      err == 'calib.err.preflight' and s['pause'] == 'skip' and ('enable', False) not in o.calls, err)
o = FakeOps(binds=[999.0])
check('preflight: a bind 1 s ago = rebinding', cc.Handover(o, cc.Steps([])).problems() == ['rebinding'])

o = FakeOps(unstable=True)
err, s, _ = job(o)
check('pause: nodes keep renumbering -> unstable, camera given back',
      err == 'calib.err.unstable' and s['sdk'] == 'skip' and s['resume'] == 'ok' and o.flag is None, '%s %s' % (err, s))

o = FakeOps(stops=False)
err, s, _ = job(o)
check('pause: depth does not stop -> not_paused, resumed', err == 'calib.err.not_paused' and s['resume'] == 'ok', err)

o = FakeOps(sdk_raises=True)
err, s, st = job(o)
check('sdk error -> calib.err.sdk with the text, released, resumed',
      err == 'calib.err.sdk' and 'video0' in st.get('sdk').get('a', {}).get('e', '') and
      s['release'] == 'ok' and s['resume'] == 'ok' and o.open_sessions == 0, '%s %s' % (err, s))

o = FakeOps(leak=True)
err, s, _ = job(o)
check('fd leak -> calib.err.leak, still resumed', err == 'calib.err.leak' and s['resume'] == 'ok', '%s %s' % (err, s))

o = FakeOps(enable_true_fails=True)
err, s, st = job(o)
check('enable true fails -> reset -> ok', err is None and o.resets == 1 and st.get('resume').get('reset') is True, '%s %s' % (err, s))

o = FakeOps(enable_true_dead=True)
err, s, st = job(o)
check('enable true but no depth in 20 s -> reset -> ok', err is None and o.resets == 1, '%s %s' % (err, s))

o = FakeOps(enable_true_fails=True, reset_works=False)
err, s, _ = job(o)
check('reset fails too -> camera_off, flag kept for the next start',
      err == 'calib.err.camera_off' and s['resume'] == 'err' and o.flag is not None, '%s %s' % (err, s))

o = FakeOps()


def cancel_inside(sess):
    raise cc.Cancelled()


st = cc.Steps(['pause', 'sdk', 'release', 'resume'], clock=o.now)
H = cc.Handover(o, st)
H.pause()
try:
    H.session(cancel_inside)
except cc.Cancelled:
    pass
H.resume()
check('cancel inside the session -> released, resumed',
      st.state('sdk') == 'err' and st.get('sdk')['d'] == 'calib.msg.cancelled' and st.state('resume') == 'ok')

o = FakeOps(sdk_prob='sdk_mismatch')
check('preflight: SDK not matching the FW -> sdk_mismatch', cc.Handover(o, cc.Steps([])).problems() == ['sdk_mismatch'])

o = FakeOps(reset_works=False)
st = cc.Steps(['pause', 'resume'], clock=o.now)
H = cc.Handover(o, st)
H.pause()
try:
    H.resume(force_reset=True)
    err = None
except cc.StepError as ex:
    err = ex.key
check('reset does not bring the camera back -> camera_off, no enable tried',
      err == 'calib.err.camera_off' and ('enable', True) not in o.calls and o.flag is not None, err)
o = FakeOps()
st = cc.Steps(['pause', 'resume'], clock=o.now)
H = cc.Handover(o, st)
H.pause()
H.resume(force_reset=True)
check('resume through a reset (loads the flash) -> ok, polling back',
      o.resets == 1 and st.state('resume') == 'ok' and o.polling is True and o.flag is None)


# 5. write_verified: flash write + read back (FW 05.14 has no RAM preview)
class FakeAC(object):
    def __init__(self, flash, ram_refused=True, corrupt=False):
        self.flash, self.cur, self.ram_refused, self.corrupt = list(flash), None, ram_refused, corrupt
        self.writes = 0

    def set_calibration_table(self, t):
        self.cur = list(t)          # kept (librealsense 2.53.1), then CALIBRECALC is refused
        if self.ram_refused:
            raise RuntimeError('hwmon command 0x51( 0 0 0 cafecafe ) failed (response -1= Invalid Command)')

    def write_calibration(self):
        if self.cur is None:
            raise RuntimeError('Calibration table was not set')
        self.writes += 1
        self.flash = list(self.cur)
        if self.corrupt:
            self.flash[5] ^= 0xff

    def get_calibration_table(self):
        return list(self.flash)


old, new = list(range(64)), [x + 1 for x in range(64)]
ac, log = FakeAC(old), {}
check('write_verified: RAM refused, flash written, read back == new',
      cc.write_verified(ac, new, log) and ac.flash == new and 'Invalid Command' in log.get('ram_error', ''))
ac = FakeAC(old)
check('write_verified: identical table -> flash unchanged, ok', cc.write_verified(ac, old) and ac.flash == old and ac.writes == 1)
ac = FakeAC(old, corrupt=True)
ok = cc.write_verified(ac, new)
ac.corrupt = False
back = cc.write_verified(ac, old)
check('write_verified: read back differs -> False; the backup written back -> True, flash == backup',
      ok is False and back is True and ac.flash == old)

# 6. FW <-> SDK
check('FW 05.14 needs pyrealsense2 2.53.1', cc.sdk_required('05.14.00.00') == '2.53.1.4623')
check('unknown FW -> the default SDK', cc.sdk_required('05.16.00.00') == cc.SDK_DEFAULT)
check('no FW yet -> no requirement', cc.sdk_required('') is None)
import tempfile
d = tempfile.mkdtemp()
os.makedirs(os.path.join(d, 'pyrealsense2-2.53.1.4623.dist-info'))
check('sdk_installed reads the dist-info, no import', cc.sdk_installed(d) == '2.53.1.4623' and cc.sdk_installed(d + '/x') is None)

# 7. what to calibrate (23:13 run: +0.3 cm at the wall, health -0.465)
nan = float('nan')
check('tare not needed: +0.3 cm raw, -0.7 cm ROS at 1.23 m', not cc.tare_needed(1.238, 1.2351, 1.227, 1.2341))
check('tare needed: raw +2 cm', cc.tare_needed(1.255, 1.2351))
check('tare needed: ROS off even when raw is fine', cc.tare_needed(1.236, 1.2351, 1.30, 1.2341))
check('tare: no measurement -> not needed', not cc.tare_needed(nan, nan, nan, nan))
bk = list(range(32))
oc = [x + 1 for x in bk]
check('on-chip useful: changed table, |h| 0.465', cc.onchip_useful(oc, -0.465, bk))
check('on-chip not useful: |h| 0.1 (good already)', not cc.onchip_useful(oc, 0.1, bk))
check('on-chip not useful: same table', not cc.onchip_useful(bk, -0.9, bk))
check('on-chip not useful: no health', not cc.onchip_useful(oc, None, bk))
check('on-chip health as a list', cc.onchip_useful(oc, [0.6, 0.1], bk))
check('tare where: not needed -> skip', cc.tare_where(oc, False, False) == 'skip')
check('tare where: no on-chip table -> here (over flash)', cc.tare_where(None, True, None) == 'here')
check('tare where: RAM preview works -> here (chained)', cc.tare_where(oc, True, True) == 'here')
check('tare where: FW without RAM preview -> next (own session after reset)', cc.tare_where(oc, True, False) == 'next')
st_ = cc.Steps(['a', 'after'])
st_.insert_before('after', ['t1', 't2'])
check('steps: tare rows go in front of "after"', [i['id'] for i in st_.items] == ['a', 't1', 't2', 'after'])

# 8. every text key the node can send has an English and a Czech text
import re as _re
ROOT = os.path.join(HERE, '..')


def dict_keys(lang):
    src = open(os.path.join(ROOT, 'nodes', 'templates', 'assets', 'js', 'i18n', lang + '.js')).read()
    return set(_re.findall(r'^\s*"([^"]+)"\s*:', src, _re.M)) | set(_re.findall(r"^\s*'([^']+)'\s*:", src, _re.M))


EN, CS = dict_keys('en'), dict_keys('cs')
node_src = open(os.path.join(ROOT, 'nodes', 'camera_calib')).read()
need = set(_re.findall(r"'(calib\.(?:err|msg|res)\.[a-z_]+)'", node_src))
need |= {'calib.step.' + i for i in cc.Node.STEP_IDS}
for r in set(_re.findall(r"sc\['reasons'\]\.append\('(\w+)'\)", node_src)):
    need |= {'calib.reason.' + r, 'calib.reason_short.' + r}
probs = set(_re.findall(r"p\.append\('(\w+)'\)", node_src)) | {'no_sdk', 'sdk_mismatch'}
for r in probs:
    need |= {'calib.pre.' + r, 'calib.pre_short.' + r}
for ph in set(_re.findall(r"set_phase\('(\w+)'", node_src)) - {'done', 'check'}:
    need.add('calib.ph.' + ph)
miss_en = sorted(k for k in need if k not in EN)
miss_cs = sorted(k for k in need if k not in CS)
check('node keys have English (%d keys)' % len(need), not miss_en, ', '.join(miss_en))
check('node keys have Czech', not miss_cs, ', '.join(miss_cs))

print('\n%d failed' % len(fails) if fails else '\nall ok')
sys.exit(1 if fails else 0)
