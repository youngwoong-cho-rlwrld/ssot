"""Episode-count fallback: a run whose summary results.json has not been staged
yet, but whose per-episode outcome dirs are all present, counts as complete.

This tests the canonical pure helper; _REMOTE_SCRIPT (which runs standalone on
the cluster) carries an identical inline copy validated over ssh.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import results  # noqa: E402


class ProvisionalRateTests(unittest.TestCase):
    def test_complete_run_counts_with_derived_rate(self):
        # 510f7e run_3: 16 success + 34 failure == 50 episodes -> rate 0.32.
        self.assertEqual(
            results.provisional_rate_from_episodes(16, 34, 50), (0.32, 16, 50)
        )

    def test_in_progress_run_stays_partial(self):
        # 005056 run_2: 8 success + 13 failure == 21 < 50 -> not counted.
        self.assertIsNone(results.provisional_rate_from_episodes(8, 13, 50))

    def test_unknown_episode_count_never_counts(self):
        self.assertIsNone(results.provisional_rate_from_episodes(16, 34, None))
        self.assertIsNone(results.provisional_rate_from_episodes(16, 34, 0))

    def test_all_success_and_all_failure(self):
        self.assertEqual(results.provisional_rate_from_episodes(50, 0, 50), (1.0, 50, 50))
        self.assertEqual(results.provisional_rate_from_episodes(0, 50, 50), (0.0, 0, 50))

    def test_over_count_does_not_match(self):
        # Guard: more outcome dirs than expected is not a clean completion.
        self.assertIsNone(results.provisional_rate_from_episodes(30, 30, 50))

    def test_remote_script_mirror_matches_canonical(self):
        # The inline copy in _REMOTE_SCRIPT (standalone on the cluster) must stay
        # in sync with the canonical helper. Extract just that self-contained
        # function and compare outputs.
        import re

        match = re.search(
            r"\ndef _provisional_rate_from_episodes\(.*?\n(?=\ndef )",
            results._REMOTE_SCRIPT,
            re.S,
        )
        self.assertIsNotNone(match, "mirror helper not found in _REMOTE_SCRIPT")
        ns: dict = {}
        exec(match.group(0), ns)
        mirror = ns["_provisional_rate_from_episodes"]
        for succ, fail, n in [(16, 34, 50), (8, 13, 50), (50, 0, 50), (16, 34, None)]:
            self.assertEqual(
                mirror(succ, fail, n),
                results.provisional_rate_from_episodes(succ, fail, n),
            )


if __name__ == "__main__":
    unittest.main()
