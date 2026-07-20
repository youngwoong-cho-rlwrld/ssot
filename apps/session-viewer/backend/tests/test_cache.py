from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path
from unittest.mock import patch

from app import cache, settings
from app.main import board as board_endpoint


class SessionCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.claude_a = root / "claude-a"
        self.codex_a = root / "codex-a"
        self.claude_b = root / "claude-b"
        self.codex_b = root / "codex-b"
        for path in (self.claude_a, self.codex_a, self.claude_b, self.codex_b):
            path.mkdir()
        cache.reset_for_tests()

    def tearDown(self) -> None:
        cache.reset_for_tests()
        self.temp.cleanup()

    @staticmethod
    def _write_claude(root: Path, session_id: str, title: str) -> Path:
        path = root / "project" / f"{session_id}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        records = [
            {"type": "ai-title", "aiTitle": title, "timestamp": "2026-07-20T00:00:00Z"},
            {
                "type": "user",
                "timestamp": "2026-07-20T00:00:01Z",
                "cwd": "/workspace/project",
                "message": {"content": title},
            },
        ]
        path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )
        return path

    def test_same_uid_is_resolved_within_the_requested_roots(self) -> None:
        self._write_claude(self.claude_a, "shared", "from root A")
        self._write_claude(self.claude_b, "shared", "from root B")

        cache.scan_all(self.claude_a, self.codex_a)
        cache.scan_all(self.claude_b, self.codex_b)

        session_a = cache.get_session("claude:shared", self.claude_a, self.codex_a)
        session_b = cache.get_session("claude:shared", self.claude_b, self.codex_b)

        self.assertIsNotNone(session_a)
        self.assertIsNotNone(session_b)
        self.assertEqual(session_a.title, "from root A")
        self.assertEqual(session_b.title, "from root B")
        self.assertTrue(Path(session_a.path).is_relative_to(self.claude_a.resolve()))
        self.assertTrue(Path(session_b.path).is_relative_to(self.claude_b.resolve()))

    def test_session_parsing_never_holds_the_global_state_lock(self) -> None:
        self._write_claude(self.claude_a, "slow", "slow session")
        parser_entered = threading.Event()
        release_parser = threading.Event()
        original_parser = cache.parse_claude_meta
        scan_errors: list[BaseException] = []

        def slow_parser(path: Path):
            parser_entered.set()
            if not release_parser.wait(timeout=2):
                raise TimeoutError("test did not release the parser")
            return original_parser(path)

        def run_scan() -> None:
            try:
                cache.scan_all(self.claude_a, self.codex_a)
            except BaseException as exc:  # noqa: BLE001 - forwarded to test thread
                scan_errors.append(exc)

        with patch("app.cache.parse_claude_meta", side_effect=slow_parser):
            scan_thread = threading.Thread(target=run_scan, daemon=True)
            scan_thread.start()
            self.assertTrue(parser_entered.wait(timeout=1), "scan never reached parser")
            acquired = cache._lock.acquire(timeout=0.2)
            if acquired:
                cache._lock.release()
            release_parser.set()
            scan_thread.join(timeout=2)

        self.assertTrue(acquired, "filesystem parsing held the cache state lock")
        self.assertFalse(scan_thread.is_alive())
        self.assertEqual(scan_errors, [])

    def test_warm_restart_primes_from_persistent_metadata_without_parsing(self) -> None:
        self._write_claude(self.claude_a, "persisted", "survives restart")
        data_dir = Path(self.temp.name) / "data"

        with (
            patch.object(settings, "DATA_DIR", data_dir),
            patch.object(settings, "DB_PATH", data_dir / "ssot.db"),
        ):
            cache.reset_for_tests(persistence=True)
            with patch(
                "app.cache.parse_claude_meta",
                wraps=cache.parse_claude_meta,
            ) as initial_parser:
                initial = cache.scan_all(self.claude_a, self.codex_a)
            self.assertEqual(initial_parser.call_count, 1)
            self.assertEqual(initial[0].title, "survives restart")
            self.assertTrue(settings.DB_PATH.exists())

            # Model a new worker: process memory is empty but its SQLite cache
            # remains. An unchanged transcript must not be reopened or parsed.
            cache.reset_for_tests(persistence=True)
            with patch(
                "app.cache.parse_claude_meta",
                side_effect=AssertionError("warm restart reparsed transcript"),
            ) as restarted_parser:
                restarted = cache.prime(self.claude_a, self.codex_a)

            restarted_parser.assert_not_called()
            self.assertEqual(len(restarted), 1)
            self.assertEqual(restarted[0].uid, "claude:persisted")
            self.assertEqual(restarted[0].title, "survives restart")

    def test_forget_during_refresh_cannot_resurrect_a_deleted_session(self) -> None:
        path = self._write_claude(self.claude_a, "deleted", "before deletion")
        cache.scan_all(self.claude_a, self.codex_a)
        self._write_claude(self.claude_a, "deleted", "changed before deletion")

        parser_finished_reading = threading.Event()
        release_parser_result = threading.Event()
        original_parser = cache.parse_claude_meta
        refresh_errors: list[BaseException] = []

        def parsed_before_delete(changed_path: Path):
            session = original_parser(changed_path)
            parser_finished_reading.set()
            if not release_parser_result.wait(timeout=2):
                raise TimeoutError("test did not release parsed session")
            return session

        def run_refresh() -> None:
            try:
                cache.scan_all(self.claude_a, self.codex_a)
            except BaseException as exc:  # noqa: BLE001 - forwarded to test thread
                refresh_errors.append(exc)

        with patch("app.cache.parse_claude_meta", side_effect=parsed_before_delete):
            refresh_thread = threading.Thread(target=run_refresh, daemon=True)
            refresh_thread.start()
            self.assertTrue(
                parser_finished_reading.wait(timeout=1),
                "refresh never parsed the changed transcript",
            )
            path.unlink()
            cache.forget("claude:deleted", self.claude_a, self.codex_a)
            release_parser_result.set()
            refresh_thread.join(timeout=2)

        self.assertFalse(refresh_thread.is_alive())
        self.assertEqual(refresh_errors, [])
        self.assertEqual(cache.list_all(self.claude_a, self.codex_a), [])
        self.assertIsNone(
            cache.get_session("claude:deleted", self.claude_a, self.codex_a)
        )

    def test_stale_reads_and_unrelated_board_work_do_not_wait_for_refresh(self) -> None:
        path = self._write_claude(self.claude_a, "changing", "before refresh")
        cache.scan_all(self.claude_a, self.codex_a)
        self._write_claude(self.claude_a, "changing", "after refresh")

        parser_entered = threading.Event()
        release_parser = threading.Event()
        original_parser = cache.parse_claude_meta

        def slow_parser(changed_path: Path):
            parser_entered.set()
            if not release_parser.wait(timeout=3):
                raise TimeoutError("test did not release the parser")
            return original_parser(changed_path)

        # A zero max-age deterministically makes the warm snapshot eligible for
        # background refresh without adding a wall-clock sleep to the suite.
        with (
            patch("app.cache.REFRESH_MAX_AGE_SECONDS", 0),
            patch("app.cache.parse_claude_meta", side_effect=slow_parser) as mocked_parser,
        ):
            first = cache.list_all(self.claude_a, self.codex_a)
            self.assertEqual(first[0].title, "before refresh")
            self.assertTrue(parser_entered.wait(timeout=1), "refresh was not scheduled")

            # Model the shared AnyIO request pool: if stale list requests wait on
            # the active scan, they occupy every worker and the unrelated board
            # request queued behind them cannot run.
            board_ran = threading.Event()

            def fast_board():
                board_ran.set()
                return []

            with (
                patch(
                    "app.main.board_store.list_nodes",
                    side_effect=fast_board,
                ),
                ThreadPoolExecutor(max_workers=8) as pool,
            ):
                reads = [
                    pool.submit(cache.list_all, self.claude_a, self.codex_a)
                    for _ in range(8)
                ]
                board = pool.submit(board_endpoint)
                done, _ = wait([*reads, board], timeout=0.5)
                completed_before_release = len(done)
                board_completed_before_release = board.done()
                release_parser.set()
                wait([*reads, board], timeout=2)

            self.assertEqual(completed_before_release, 9)
            self.assertTrue(board_completed_before_release)
            self.assertTrue(board_ran.is_set())
            self.assertEqual(mocked_parser.call_count, 1, "refresh was not single-flight")
            for future in reads:
                self.assertEqual(future.result()[0].title, "before refresh")

            # Stop scheduling new refreshes while polling for the completion of
            # the one deliberately stalled above.
            cache.REFRESH_MAX_AGE_SECONDS = 3600
            deadline = time.monotonic() + 2
            refreshed = first
            while time.monotonic() < deadline:
                refreshed = cache.list_all(self.claude_a, self.codex_a)
                if refreshed[0].title == "after refresh":
                    break
                time.sleep(0.01)

        self.assertEqual(refreshed[0].title, "after refresh")
        self.assertEqual(Path(refreshed[0].path), path.resolve())


if __name__ == "__main__":
    unittest.main()
