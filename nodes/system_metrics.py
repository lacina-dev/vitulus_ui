"""Read-only host metrics for the UI header monitor (CPU / MEM / DISK / NET).

Pure Linux /proc + os.statvfs, no third-party deps, no ROS. Served by the
robot's own Flask webnode at GET /api/system so the header widget is
self-contained and does not depend on any external service.

CPU% and network throughput need two counter samples: the first CPU reading
falls back to normalized 1-minute load, and the first network rate is zero;
both become measured deltas on the next poll. A short cache (matching the
widget's ~2 s poll) keeps repeated requests cheap and gives the deltas a
stable time base. Every field degrades to None/0 on error rather than raising,
so a partial read still returns a usable payload.
"""

import os
import threading
import time

# The header polls ~every 2 s; caching just under that avoids recomputing on
# every request while keeping the numbers fresh and the counter deltas honest.
CACHE_TTL = 1.5

_lock = threading.Lock()
_cache = {'payload': None, 'ts': 0.0, 'cpu': None, 'net': None}


def _read_cpu_times():
    """(total, idle) jiffies from the aggregate line of /proc/stat."""
    with open('/proc/stat', 'r') as stream:
        fields = stream.readline().split()
    if not fields or fields[0] != 'cpu' or len(fields) < 5:
        raise ValueError('missing cpu summary in /proc/stat')
    values = [int(value) for value in fields[1:]]
    total = sum(values)
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return total, idle


def _read_meminfo():
    """(total_bytes, used_bytes) from /proc/meminfo (used = total - available)."""
    values = {}
    with open('/proc/meminfo', 'r') as stream:
        for line in stream:
            key, _, value = line.partition(':')
            if not value:
                continue
            values[key] = int(value.strip().split()[0]) * 1024
    total = values.get('MemTotal')
    available = values.get('MemAvailable')
    if not total or available is None:
        raise ValueError('missing MemTotal or MemAvailable in /proc/meminfo')
    return total, total - available


def _read_net_totals():
    """Aggregate non-loopback RX/TX byte counters from /proc/net/dev."""
    rx = tx = 0
    with open('/proc/net/dev', 'r') as stream:
        lines = stream.readlines()[2:]
    for line in lines:
        name, _, counters = line.partition(':')
        if not counters or name.strip() == 'lo':
            continue
        fields = counters.split()
        if len(fields) >= 9:
            rx += int(fields[0])
            tx += int(fields[8])
    return rx, tx


def load_system_metrics():
    """Bounded, cached host metrics as {cpu, mem, disk, net, ts, errors}."""
    now_mono = time.monotonic()
    with _lock:
        cached = _cache['payload']
        if cached is not None and now_mono - _cache['ts'] < CACHE_TTL:
            return cached

        errors = []
        cpu = {'percent': None, 'load_1m': None, 'cores': os.cpu_count() or 1,
               'source': None}
        try:
            total, idle = _read_cpu_times()
            previous = _cache['cpu']
            if previous is not None:
                total_delta = total - previous[0]
                idle_delta = idle - previous[1]
                if total_delta > 0:
                    cpu['percent'] = round(
                        max(0.0, min(100.0, 100.0 * (1.0 - idle_delta / total_delta))), 1)
                    cpu['source'] = 'proc_stat_delta'
            cpu['load_1m'] = round(os.getloadavg()[0], 2)
            if cpu['percent'] is None:
                cpu['percent'] = round(min(100.0, 100.0 * cpu['load_1m'] / cpu['cores']), 1)
                cpu['source'] = 'loadavg_first_sample'
            _cache['cpu'] = (total, idle)
        except Exception as exc:  # noqa: BLE001 - partial metrics beat a 500
            errors.append('cpu: %s' % exc)

        mem = {'used_bytes': None, 'total_bytes': None, 'percent': None}
        try:
            mem_total, mem_used = _read_meminfo()
            mem.update({'used_bytes': mem_used, 'total_bytes': mem_total,
                        'percent': round(100.0 * mem_used / mem_total, 1)})
        except Exception as exc:  # noqa: BLE001
            errors.append('mem: %s' % exc)

        disk = {'mount': '/', 'used_bytes': None, 'total_bytes': None,
                'free_bytes': None, 'percent': None}
        try:
            stat = os.statvfs('/')
            disk_total = stat.f_blocks * stat.f_frsize
            disk_free = stat.f_bavail * stat.f_frsize
            disk_used = disk_total - disk_free
            disk.update({'used_bytes': disk_used, 'total_bytes': disk_total,
                         'free_bytes': disk_free,
                         'percent': round(100.0 * disk_used / disk_total, 1)})
        except Exception as exc:  # noqa: BLE001
            errors.append('disk: %s' % exc)

        net = {'rx_bytes_s': 0.0, 'tx_bytes_s': 0.0,
               'rx_total_bytes': None, 'tx_total_bytes': None}
        try:
            rx, tx = _read_net_totals()
            previous = _cache['net']
            if previous is not None:
                elapsed = now_mono - previous[0]
                if elapsed > 0:
                    net['rx_bytes_s'] = round(max(0, rx - previous[1]) / elapsed, 1)
                    net['tx_bytes_s'] = round(max(0, tx - previous[2]) / elapsed, 1)
            net.update({'rx_total_bytes': rx, 'tx_total_bytes': tx})
            _cache['net'] = (now_mono, rx, tx)
        except Exception as exc:  # noqa: BLE001
            errors.append('net: %s' % exc)

        payload = {'cpu': cpu, 'mem': mem, 'disk': disk, 'net': net,
                   'ts': time.time(), 'errors': errors}
        _cache['payload'] = payload
        _cache['ts'] = now_mono
        return payload
