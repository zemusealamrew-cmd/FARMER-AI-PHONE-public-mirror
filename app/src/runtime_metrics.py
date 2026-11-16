"""Process measurements without assuming Unix resource exists on Windows.

Windows working set includes shared pages; it is not private committed memory.
Child accounting is unavailable here on Windows and is reported as null, not zero.
"""
import sys
import time


def process_usage():
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes

        class MemoryCounters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in (
                    'PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
                    'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                    'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        api = ctypes.WinDLL('psapi', use_last_error=True).GetProcessMemoryInfo
        api.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
        api.restype = wintypes.BOOL
        counters = MemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if not api(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'peak_rss_kib': counters.PeakWorkingSetSize / 1024,
                'cpu_seconds': time.process_time(),
                'metric_source': 'Windows GetProcessMemoryInfo/process_time; own process only'}
    import resource
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return {'peak_rss_kib': usage.ru_maxrss / (1024 if sys.platform == 'darwin' else 1),
            'cpu_seconds': usage.ru_utime + usage.ru_stime,
            'metric_source': 'getrusage RUSAGE_SELF; own process only'}


def child_usage():
    if sys.platform == 'win32':
        return {'peak_rss_kib': None, 'cpu_seconds': None}
    import resource
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {'peak_rss_kib': usage.ru_maxrss / (1024 if sys.platform == 'darwin' else 1),
            'cpu_seconds': usage.ru_utime + usage.ru_stime}
