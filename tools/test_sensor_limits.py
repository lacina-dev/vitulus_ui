#!/usr/bin/env python3
"""nodes/sensor_limits.py without ROS:  python3 tools/test_sensor_limits.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'nodes'))
import sensor_limits as S

LOG = '''\x1b[0m[ INFO] [1793478406.1]: RPLIDAR running on ROS package rplidar_ros, SDK Version:2.1.0\x1b[0m
\x1b[0m[ INFO] [1793478406.7]: RPLIDAR MODE:A4M1\x1b[0m
\x1b[0m[ INFO] [1793478406.7]: RPLIDAR S/N: 6F99E18B\x1b[0m
\x1b[0m[ INFO] [1793478406.7]: Firmware Ver: 1.01\x1b[0m
\x1b[0m[ INFO] [1793478406.7]: Hardware Rev: 18\x1b[0m
\x1b[0m[ INFO] [1793478406.7]: RPLidar health status : OK.\x1b[0m
\x1b[0m[ INFO] [1793478407.0]: current scan mode: Standard, sample rate: 5 Khz, max_distance: 16.0 m, scan frequency:10.0 Hz, \x1b[0m
'''
CHAIN = [{'name': 'intensity', 'type': 'laser_filters/LaserScanIntensityFilter', 'params': {'lower_threshold': 4, 'upper_threshold': 100000}},
         {'name': 'range', 'type': 'laser_filters/LaserScanRangeFilter', 'params': {'lower_threshold': 0.1, 'upper_threshold': 16.0}}]


class T(unittest.TestCase):
    def test_log(self):
        d = S.parse_rplidar_log(LOG)
        self.assertEqual((d['model'], d['firmware'], d['hardware'], d['health']), ('A4M1', '1.01', '18', 'OK'))
        self.assertEqual((d['scan_mode'], d['sample_khz'], d['max_distance_m'], d['scan_frequency_hz']), ('Standard', 5.0, 16.0, 10.0))

    def test_log_respawn_last_wins(self):
        self.assertEqual(S.parse_rplidar_log(LOG + 'RPLidar health status : Warning.\n')['health'], 'Warning')

    def test_no_log(self):
        with tempfile.TemporaryDirectory() as t:
            self.assertEqual(S.read_device(t), {})

    def test_chain(self):
        c = S.chain_summary(CHAIN)
        self.assertEqual(c['intensity']['lower'], 4.0)
        self.assertEqual(c['range']['upper'], 16.0)
        self.assertEqual(c['masks'], [])

    def test_mask_is_reported(self):
        c = S.chain_summary(CHAIN + [{'name': 'ang', 'type': 'laser_filters/LaserScanAngularBoundsFilterInPlace', 'params': {}}])
        self.assertEqual(c['masks'][0]['type'], 'LaserScanAngularBoundsFilterInPlace')

    def test_precedence(self):
        v, s = S.mapper_next(dict(S.MAPPER_FALLBACK), {'lidar_max_range_m': 0.5, 'obstacle_max_range_m': 1.1}, {'lidar_max_range_m': 6.0})
        self.assertEqual((v['lidar_max_range_m'], s['lidar_max_range_m']), (6.0, 'pending'))
        self.assertEqual((v['obstacle_max_range_m'], s['obstacle_max_range_m']), (1.1, 'site'))
        self.assertEqual(s['use_lidar'], 'default')

    def test_clean(self):
        self.assertEqual(S.clean_pending({'lidar_max_range_m': '8', 'use_lidar': False}), {'lidar_max_range_m': 8.0, 'use_lidar': False})
        for bad in ({}, None, {'x': 1}, {'lidar_max_range_m': 17}, {'lidar_max_range_m': 0.1}, {'lidar_max_range_m': float('nan')},
                    {'lidar_max_range_m': True}, {'use_lidar': 1}, {'lidar_min_intensity': -1}, {'lidar_min_intensity': 'a'}):
            with self.assertRaises(ValueError):
                S.clean_pending(bad)

    def test_pending_merge_and_clear(self):
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, 'x', S.PENDING_NAME)
            S.merge_pending(p, {'use_lidar': False})
            S.merge_pending(p, {'lidar_max_range_m': 5})
            self.assertEqual(json.load(open(p)), {'lidar_max_range_m': 5.0, 'use_lidar': False})
            with self.assertRaises(ValueError):
                S.merge_pending(p, {'lidar_max_range_m': 99})
            self.assertEqual(json.load(open(p))['lidar_max_range_m'], 5.0)      # a refused change keeps the file
            S.clear_pending(p)
            S.clear_pending(p)
            self.assertFalse(os.path.exists(p))

    def test_snapshot(self):
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, 'site1'))
            json.dump({'site': 'site1'}, open(os.path.join(t, '.last_served'), 'w'))
            json.dump({'lidar_max_range_m': 0.5}, open(os.path.join(t, 'site1', 'direct_overrides.json'), 'w'))
            y = os.path.join(t, 'm.yaml')
            open(y, 'w').write('direct_raster:\n  lidar_max_range_m: 8.0\n  lidar_min_intensity: 0.0\n')
            params = {'/laser_filter_scan_rplidar/scan_filter_chain': CHAIN, '/d435/realsense2_camera/clip_distance': 5.0}
            out = S.snapshot(lambda n, d: params.get(n, d), [[], [['/scan', ['/a', '/b']]], []], y, t, t)
            self.assertEqual(out['mapper']['site'], 'site1')
            self.assertEqual(out['mapper']['values']['lidar_max_range_m'], 0.5)
            self.assertEqual(out['lidar']['subscribers']['/scan'], ['/a', '/b'])
            self.assertEqual(out['camera']['clip_distance'], 5.0)
            json.dumps(out)


if __name__ == '__main__':
    unittest.main()
