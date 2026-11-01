#!/usr/bin/env python3
"""sensor_limits.py — what the lidar and the depth camera really are limited by.

Read side of the map layers "Lidar range" / "Camera range" and of Settings › Lidar
(GET /api/sensor_limits, webnode). One answer instead of a dozen rosapi calls:

  * lidar device     the driver logs it ONLY at start (model, firmware, health,
                     scan mode): rplidar-rplidarNode-*-stdout.log
  * lidar parameters driver, the laser_filters chain, costmaps, consumers
  * camera           the driver's clip_distance, the costmap's limits

The mapper's values are not here: they are the mapping profile of the site,
/mapping_manager/profile_state (vitulus_mapping/profiles.py).
Nothing here reaches ROS writes or the robot's behaviour.

The functions take plain values so tools/test_sensor_limits.py runs them
without ROS.
"""
import glob
import os
import re
import time

ANSI = re.compile(r'\x1b\[[0-9;]*m')

# the filters of the chain that only gate range / intensity; any other type may
# hide a part of the view and is reported as a mask
PLAIN_FILTERS = ('LaserScanIntensityFilter', 'LaserScanRangeFilter')
TOPICS = ('/rplidar/scan', '/rplidar/scan_ovr', '/rplidar/scan_filtered', '/scan', '/rplidar/scan_5m')

LOG_PATTERNS = (
    ('model', re.compile(r'RPLIDAR MODE:\s*(\S+)')),
    ('serial', re.compile(r'RPLIDAR S/N:\s*(\S+)')),
    ('firmware', re.compile(r'Firmware Ver:\s*(\S+)')),
    ('hardware', re.compile(r'Hardware Rev:\s*(\S+)')),
    ('health', re.compile(r'health status\s*:\s*([A-Za-z]+)')),
)
LOG_MODE = re.compile(r'current scan mode:\s*([^,]+),\s*sample rate:\s*([\d.]+)\s*Khz,'
                      r'\s*max_distance:\s*([\d.]+)\s*m,\s*scan frequency:\s*([\d.]+)\s*Hz')


def parse_rplidar_log(text):
    """Device facts from the driver's start log; the last line of a kind wins."""
    out = {}
    for line in ANSI.sub('', text or '').splitlines():
        for key, rx in LOG_PATTERNS:
            m = rx.search(line)
            if m:
                out[key] = m.group(1)
        m = LOG_MODE.search(line)
        if m:
            out['scan_mode'] = m.group(1).strip()
            out['sample_khz'] = float(m.group(2))
            out['max_distance_m'] = float(m.group(3))
            out['scan_frequency_hz'] = float(m.group(4))
    return out


def read_device(log_dir='~/.ros/log/latest'):
    """The newest driver log; {} when there is none (older roslaunch layout)."""
    files = glob.glob(os.path.join(os.path.expanduser(log_dir), 'rplidar-rplidarNode-*-stdout.log'))
    files.sort(key=os.path.getmtime, reverse=True)
    for path in files[:3]:
        try:
            # the facts are at the start, a respawn appends: the tail is enough
            with open(path, 'rb') as fh:
                fh.seek(max(0, os.path.getsize(path) - 262144))
                dev = parse_rplidar_log(fh.read().decode('utf-8', 'replace'))
        except OSError:
            continue
        if dev:
            dev['log_mtime'] = int(os.path.getmtime(path))
            return dev
    return {}


def chain_summary(chain):
    """The launch-file chain -> launch defaults + filters that may hide beams."""
    out = {'intensity': None, 'range': None, 'masks': []}
    for f in chain or []:
        if not isinstance(f, dict):
            continue
        kind = str(f.get('type', '')).split('/')[-1]
        params = f.get('params') or {}
        if kind == 'LaserScanIntensityFilter':
            out['intensity'] = {'lower': _num(params.get('lower_threshold')),
                                'upper': _num(params.get('upper_threshold'))}
        elif kind == 'LaserScanRangeFilter':
            out['range'] = {'lower': _num(params.get('lower_threshold')),
                            'upper': _num(params.get('upper_threshold')),
                            'lower_replacement': _num(params.get('lower_replacement_value')),
                            'upper_replacement': _num(params.get('upper_replacement_value'))}
        if kind not in PLAIN_FILTERS:
            out['masks'].append({'name': f.get('name'), 'type': kind, 'params': params})
    return out


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def subscribers_of(system_state, topics=TOPICS):
    """rosgraph getSystemState -> {topic: [nodes that read it]}."""
    subs = dict(system_state[1]) if system_state and len(system_state) > 1 else {}
    return {t: sorted(subs.get(t, [])) for t in topics}


def snapshot(param, system_state, log_dir='~/.ros/log/latest'):
    """The whole answer. param(name, default) reads the parameter server."""
    filt = '/laser_filter_scan_rplidar/'
    gcm = '/move_base_flex/global_costmap/obstacle_layer/'
    return {
        'ok': True, 'ts': int(time.time()),
        'lidar': {
            'device': read_device(log_dir),
            'driver': param('/rplidar/rplidarNode', {}) or {},
            'chain': chain_summary(param(filt + 'scan_filter_chain', [])),
            'filter': {'intensity_lower': _num(param(filt + 'intensity/lower_threshold', None)),
                       'range_lower': _num(param(filt + 'range/lower_threshold', None)),
                       'range_upper': _num(param(filt + 'range/upper_threshold', None))},
            'costmap': {'obstacle_range': _num(param(gcm + 'laser_scan/obstacle_range', None)),
                        'raytrace_range': _num(param(gcm + 'laser_scan/raytrace_range', None)),
                        'topic': param(gcm + 'laser_scan/topic', None)},
            'local_grid': {'width': _num(param('/local_costmap_node/grid_width_meters', None)),
                           'height': _num(param('/local_costmap_node/grid_height_meters', None)),
                           'topic': param('/local_costmap_node/scan_topic', None)},
            'drive_primitive': {'stop_distance': _num(param('/drive_primitive/stop_distance', 0.30)),
                                'scan_timeout': _num(param('/drive_primitive/scan_timeout', 0.5)),
                                'topic': param('/drive_primitive/scan_topic', '/rplidar/scan_filtered')},
            'subscribers': subscribers_of(system_state),
        },
        'camera': {
            'clip_distance': _num(param('/d435/realsense2_camera/clip_distance', None)),
            'costmap': {'obstacle_range': _num(param(gcm + 'obstacles_pc/obstacle_range', None)),
                        'raytrace_range': _num(param(gcm + 'obstacles_pc/raytrace_range', None)),
                        'min_height': _num(param(gcm + 'obstacles_pc/min_obstacle_height', None)),
                        'max_height': _num(param(gcm + 'obstacles_pc/max_obstacle_height', None))},
        },
    }
