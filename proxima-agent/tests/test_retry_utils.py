"""Tests for proxima_agent.retry_utils.jittered_backoff — exponential backoff
with jitter. Assertions use ranges (jitter is random) plus the deterministic
edge cases (zero jitter, cap, degenerate inputs).
"""
import unittest

from proxima_agent.retry_utils import jittered_backoff


class TestJitteredBackoff(unittest.TestCase):
    def test_attempt_one_is_base_plus_bounded_jitter(self):
        # base=2, jitter_ratio=0.5 → result in [2, 3].
        for _ in range(50):
            d = jittered_backoff(1, base_delay=2.0, jitter_ratio=0.5)
            self.assertGreaterEqual(d, 2.0)
            self.assertLessEqual(d, 3.0)

    def test_zero_jitter_is_deterministic(self):
        d = jittered_backoff(1, base_delay=2.0, jitter_ratio=0.0)
        self.assertEqual(d, 2.0)
        # attempt 3 with 2x multiplier → 2 * 2^2 = 8.
        d3 = jittered_backoff(3, base_delay=2.0, jitter_ratio=0.0)
        self.assertEqual(d3, 8.0)

    def test_delay_grows_with_attempt(self):
        d1 = jittered_backoff(1, base_delay=1.0, jitter_ratio=0.0)
        d2 = jittered_backoff(2, base_delay=1.0, jitter_ratio=0.0)
        d3 = jittered_backoff(3, base_delay=1.0, jitter_ratio=0.0)
        self.assertLess(d1, d2)
        self.assertLess(d2, d3)

    def test_capped_at_max_delay(self):
        d = jittered_backoff(10, base_delay=2.0, max_delay=30.0, jitter_ratio=0.0)
        self.assertEqual(d, 30.0)

    def test_huge_attempt_returns_max_delay(self):
        # exponent >= 63 short-circuits to max_delay (avoids overflow).
        d = jittered_backoff(100, base_delay=2.0, max_delay=60.0, jitter_ratio=0.0)
        self.assertEqual(d, 60.0)

    def test_degenerate_base_or_multiplier_falls_back_to_max(self):
        self.assertEqual(jittered_backoff(1, base_delay=0, max_delay=5.0, jitter_ratio=0.0), 5.0)
        self.assertEqual(jittered_backoff(1, base_delay=2.0, multiplier=0, max_delay=5.0, jitter_ratio=0.0), 5.0)

    def test_custom_multiplier(self):
        # multiplier 3, attempt 2 → 1 * 3^1 = 3.
        d = jittered_backoff(2, base_delay=1.0, multiplier=3.0, jitter_ratio=0.0)
        self.assertEqual(d, 3.0)


if __name__ == "__main__":
    unittest.main()
