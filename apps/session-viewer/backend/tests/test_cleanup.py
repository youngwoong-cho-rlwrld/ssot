from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from app import cache, cleanup as cleanup_service
from app.cleanup import OLD_SECONDS, clean, discover, summarize
from app.main import app


class CleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.claude_root = root / "claude"
        self.codex_root = root / "codex"
        self.openclaw_root = root / "openclaw"
        self.claude_root.mkdir()
        self.codex_root.mkdir()
        self.openclaw_root.mkdir()
        cache.reset_for_tests()

    def tearDown(self) -> None:
        cache.reset_for_tests()
        self.temp.cleanup()

    @staticmethod
    def _write(path: Path, records: list[dict]) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )
        return path

    def _fixtures(self) -> dict[str, Path]:
        now = "2026-07-20T00:00:00Z"
        cron = self._write(
            self.claude_root / "project" / "cron-session.jsonl",
            [
                {
                    "type": "user",
                    "timestamp": now,
                    "cwd": "/workspace/project",
                    "entrypoint": "sdk-cli",
                    "promptSource": "sdk",
                    "message": {"content": "scheduled run cron:nightly"},
                }
            ],
        )
        old = self._write(
            self.claude_root / "project" / "old-session.jsonl",
            [
                {
                    "type": "user",
                    "timestamp": now,
                    "cwd": "/workspace/project",
                    "entrypoint": "cli",
                    "promptSource": "typed",
                    "message": {"content": "ordinary session"},
                }
            ],
        )
        codex_agent = self._write(
            self.codex_root / "2026" / "07" / "20" / "agent-session.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": now,
                    "payload": {
                        "id": "agent-session",
                        "timestamp": now,
                        "cwd": "/workspace/project",
                        "source": {"subagent": {}},
                        "thread_source": "subagent",
                        "parent_thread_id": "parent-session",
                    },
                }
            ],
        )
        hidden_agent = self._write(
            self.claude_root
            / "project"
            / "parent-session"
            / "subagents"
            / "agent-hidden.jsonl",
            [{"type": "assistant", "message": {"content": "worker"}}],
        )
        old_mtime = time.time() - OLD_SECONDS - 60
        os.utime(old, (old_mtime, old_mtime))
        os.utime(hidden_agent, (old_mtime, old_mtime))
        return {
            "cron": cron,
            "old": old,
            "codex_agent": codex_agent,
            "hidden_agent": hidden_agent,
        }

    def test_preview_counts_categories_and_unique_union(self) -> None:
        self._fixtures()
        candidates = discover(self.claude_root, self.codex_root)

        empty = summarize(candidates, [])
        self.assertEqual(
            empty.counts,
            {"system": 1, "old": 1, "short": 3},
        )
        self.assertEqual(empty.affected, 0)
        self.assertEqual(empty.affected_uids, ())

        combined = summarize(candidates, ["old", "short"])
        self.assertEqual(combined.affected, 3)
        self.assertEqual(
            combined.affected_uids,
            (
                "claude:cron-session",
                "claude:old-session",
                "codex:agent-session",
            ),
        )

        short = summarize(candidates, ["short"])
        self.assertEqual(short.affected, 3)
        self.assertEqual(
            short.affected_uids,
            (
                "claude:cron-session",
                "claude:old-session",
                "codex:agent-session",
            ),
        )

    def test_cleanup_routes_are_in_the_api_contract(self) -> None:
        paths = app.openapi()["paths"]
        self.assertIn("get", paths["/api/cleanup"])
        self.assertIn("delete", paths["/api/cleanup"])

    def test_openclaw_cron_runs_are_system_and_delete_store_sidecars(self) -> None:
        sessions_dir = self.openclaw_root / "main" / "sessions"
        cron = self._write(
            sessions_dir / "cron-run.jsonl",
            [
                {
                    "type": "session",
                    "timestamp": "2026-07-20T00:00:00Z",
                    "cwd": "/workspace/ssot",
                },
                {
                    "type": "message",
                    "timestamp": "2026-07-20T00:00:01Z",
                    "message": {
                        "role": "user",
                        "content": "[cron:job-id nightly] run one cycle",
                        "idempotencyKey": "cron:prompt",
                    },
                },
            ],
        )
        trajectory = self._write(
            sessions_dir / "cron-run.trajectory.jsonl",
            [{"type": "trace"}],
        )
        store = sessions_dir / "sessions.json"
        store.write_text(
            json.dumps(
                {
                    "agent:main:cron:job-id": {"sessionId": "cron-run"},
                    "agent:main:direct": {"sessionId": "keep-me"},
                }
            ),
            encoding="utf-8",
        )
        inactive_mtime = time.time() - 600
        os.utime(cron, (inactive_mtime, inactive_mtime))
        os.utime(trajectory, (inactive_mtime, inactive_mtime))

        candidates = discover(
            self.claude_root,
            self.codex_root,
            openclaw_root=self.openclaw_root,
        )
        preview = summarize(candidates, ["system"])

        self.assertEqual(preview.counts["system"], 1)
        self.assertEqual(preview.affected_uids, ("openclaw:cron-run",))

        with patch("app.cleanup.board_store.delete"):
            result = clean(
                self.claude_root,
                self.codex_root,
                ["system"],
                preview.affected_uids,
                openclaw_root=self.openclaw_root,
            )

        self.assertEqual(result.deleted, 1)
        self.assertFalse(cron.exists())
        self.assertFalse(trajectory.exists())
        saved = json.loads(store.read_text(encoding="utf-8"))
        self.assertNotIn("agent:main:cron:job-id", saved)
        self.assertIn("agent:main:direct", saved)

    def test_preview_reuses_classification_and_does_not_wait_for_exact_refresh(
        self,
    ) -> None:
        self._fixtures()
        cache.scan_all(self.claude_root, self.codex_root)

        parser_entered = threading.Event()
        release_parser = threading.Event()
        refresh_errors: list[BaseException] = []
        original_parser = cache.parse_claude_meta

        with (
            patch(
                "app.cleanup._claude_categories",
                wraps=cleanup_service._claude_categories,
            ) as claude_classifier,
            patch(
                "app.cleanup._codex_categories",
                wraps=cleanup_service._codex_categories,
            ) as codex_classifier,
        ):
            initial = discover(self.claude_root, self.codex_root, exact=False)
            self.assertEqual(
                summarize(initial, []).counts,
                {"system": 1, "old": 1, "short": 3},
            )
            self.assertEqual(claude_classifier.call_count, 2)
            self.assertEqual(codex_classifier.call_count, 1)

            blocking_path = self._write(
                self.claude_root / "project" / "blocking-session.jsonl",
                [
                    {
                        "type": "user",
                        "timestamp": "2026-07-20T00:00:00Z",
                        "cwd": "/workspace/project",
                        "message": {"content": "new while refreshing"},
                    }
                ],
            ).resolve()

            def slow_new_parser(path: Path):
                if path == blocking_path:
                    parser_entered.set()
                    if not release_parser.wait(timeout=2):
                        raise TimeoutError("preview waited for exact refresh")
                return original_parser(path)

            def run_exact_refresh() -> None:
                try:
                    cache.scan_all(self.claude_root, self.codex_root)
                except BaseException as exc:  # noqa: BLE001 - forwarded to test
                    refresh_errors.append(exc)

            with patch("app.cache.parse_claude_meta", side_effect=slow_new_parser):
                refresh_thread = threading.Thread(target=run_exact_refresh, daemon=True)
                refresh_thread.start()
                self.assertTrue(
                    parser_entered.wait(timeout=1),
                    "exact refresh never reached the new transcript",
                )

                started = time.monotonic()
                try:
                    system_preview = discover(
                        self.claude_root,
                        self.codex_root,
                        exact=False,
                    )
                    old_preview = discover(
                        self.claude_root,
                        self.codex_root,
                        exact=False,
                    )
                finally:
                    elapsed = time.monotonic() - started
                    release_parser.set()
                    refresh_thread.join(timeout=2)

            self.assertLess(elapsed, 0.25)
            self.assertFalse(refresh_thread.is_alive())
            self.assertEqual(refresh_errors, [])
            self.assertEqual(summarize(system_preview, ["system"]).affected, 1)
            self.assertEqual(summarize(old_preview, ["old"]).affected, 1)
            self.assertEqual(
                claude_classifier.call_count,
                2,
                "category toggles reclassified unchanged Claude transcripts",
            )
            self.assertEqual(
                codex_classifier.call_count,
                1,
                "category toggles reclassified unchanged Codex transcripts",
            )

    def test_clean_permanently_deletes_only_selected_union(self) -> None:
        fixtures = self._fixtures()
        candidates = discover(self.claude_root, self.codex_root)
        preview = summarize(candidates, ["system", "old"])

        def fake_delete(path: Path, allowed_roots: tuple[Path, ...]) -> None:
            self.assertIn(self.claude_root, allowed_roots)
            self.assertIn(self.codex_root, allowed_roots)
            path.unlink()

        with (
            patch("app.cleanup.delete_permanently", side_effect=fake_delete),
            patch("app.cleanup.board_store.delete"),
        ):
            result = clean(
                self.claude_root,
                self.codex_root,
                ["system", "old"],
                preview.affected_uids,
            )

        self.assertEqual(result.affected, 2)
        self.assertEqual(result.deleted, 2)
        self.assertEqual(result.failed, 0)
        self.assertFalse(fixtures["cron"].exists())
        self.assertFalse(fixtures["old"].exists())
        self.assertTrue(fixtures["hidden_agent"].exists())
        self.assertTrue(fixtures["codex_agent"].exists())


if __name__ == "__main__":
    unittest.main()
