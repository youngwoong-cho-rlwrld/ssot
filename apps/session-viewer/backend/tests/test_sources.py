from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.sources import parse_codex_meta, parse_openclaw_meta
from app.transcript import build_detail


class CodexSourceTests(unittest.TestCase):
    def test_first_session_meta_owns_the_rollout_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / (
                "rollout-2026-07-20T00-00-00-"
                "019f0000-0000-7000-8000-000000000001.jsonl"
            )
            records = [
                {
                    "timestamp": "2026-07-20T00:00:00Z",
                    "type": "session_meta",
                    "payload": {
                        "id": "019f0000-0000-7000-8000-000000000001",
                        "timestamp": "2026-07-20T00:00:00Z",
                        "cwd": "/workspace/parent",
                    },
                },
                {
                    "timestamp": "2026-07-20T00:00:01Z",
                    "type": "session_meta",
                    "payload": {
                        "id": "019f0000-0000-7000-8000-000000000002",
                        "timestamp": "2026-07-20T00:00:01Z",
                        "cwd": "/workspace/child",
                    },
                },
            ]
            path.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )

            session = parse_codex_meta(path)

        self.assertIsNotNone(session)
        assert session is not None
        self.assertEqual(session.id, "019f0000-0000-7000-8000-000000000001")
        self.assertEqual(session.uid, "codex:019f0000-0000-7000-8000-000000000001")
        self.assertEqual(session.cwd, "/workspace/parent")


class OpenClawSourceTests(unittest.TestCase):
    def test_slack_session_metadata_and_transcript_are_deduplicated(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "main" / "sessions" / "slack-session.jsonl"
            path.parent.mkdir(parents=True)
            prompt = {
                "role": "user",
                "content": "hello from Slack",
                "idempotencyKey": "runtime:turn:prompt",
            }
            answer = {
                "role": "assistant",
                "content": [{"type": "text", "text": "hello"}],
                "model": "gpt-test",
                "idempotencyKey": "runtime:turn:assistant",
            }
            records = [
                {
                    "type": "session",
                    "timestamp": "2026-07-21T00:00:00Z",
                    "cwd": "/workspace/ssot",
                },
                {"type": "message", "timestamp": "2026-07-21T00:00:01Z", "message": prompt},
                {"type": "message", "timestamp": "2026-07-21T00:00:02Z", "message": prompt},
                {"type": "message", "timestamp": "2026-07-21T00:00:03Z", "message": answer},
                {
                    "type": "message",
                    "timestamp": "2026-07-21T00:00:04Z",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hello"}],
                        "idempotencyKey": "channel-final:123.456:0",
                    },
                },
            ]
            path.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )

            session = parse_openclaw_meta(path)
            assert session is not None
            detail = build_detail(session)

        self.assertEqual(session.uid, "openclaw:slack-session")
        self.assertEqual(session.agent, "openclaw")
        self.assertEqual(session.project, "openclaw/main")
        self.assertEqual(session.title, "hello from Slack")
        self.assertEqual(session.model, "gpt-test")
        self.assertEqual(session.message_count, 2)
        self.assertEqual(
            [(turn.role, turn.text) for turn in detail.turns],
            [("user", "hello from Slack"), ("assistant", "hello")],
        )


if __name__ == "__main__":
    unittest.main()
