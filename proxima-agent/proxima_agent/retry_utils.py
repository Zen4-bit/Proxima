"""Proxima — Retry Utilities.
Computes exponential backoff delays with random jitter.
"""

import random
import threading
import time

_jitter_counter = 0
_jitter_lock = threading.Lock()


def jittered_backoff(
    attempt: int,
    *,
    base_delay: float = 2.0,
    max_delay: float = 60.0,
    jitter_ratio: float = 0.5,
    multiplier: float = 2.0,
) -> float:
    """Computes a jittered exponential backoff delay in seconds."""
    global _jitter_counter
    with _jitter_lock:
        _jitter_counter += 1
        tick = _jitter_counter

    exponent = max(0, attempt - 1)
    if exponent >= 63 or base_delay <= 0 or multiplier <= 0:
        delay = max_delay
    else:
        delay = min(base_delay * (multiplier ** exponent), max_delay)

    seed = (time.time_ns() ^ (tick * 0x9E3779B9)) & 0xFFFFFFFF
    rng = random.Random(seed)
    jitter = rng.uniform(0, jitter_ratio * delay)
    return delay + jitter
