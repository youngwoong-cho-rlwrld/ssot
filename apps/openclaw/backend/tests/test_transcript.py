from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.transcript import build_detail


class TranscriptTests(unittest.TestCase):
    def test_deduplicates_slack_mirrors_and_channel_delivery_echoes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "session.jsonl"
            prompt = {
                "role": "user",
                "content": "where are you running?",
                "idempotencyKey": "runtime:turn:prompt",
                "__openclaw": {"mirrorIdentity": "turn:prompt"},
            }
            answer = {
                "role": "assistant",
                "content": [{"type": "text", "text": "devserver"}],
                "idempotencyKey": "runtime:turn:assistant",
                "__openclaw": {"mirrorIdentity": "turn:assistant"},
            }
            records = [
                {"type": "session", "timestamp": "2026-07-21T00:00:00Z"},
                {"type": "message", "timestamp": "2026-07-21T00:00:01Z", "message": prompt},
                {"type": "message", "timestamp": "2026-07-21T00:00:02Z", "message": prompt},
                {"type": "message", "timestamp": "2026-07-21T00:00:03Z", "message": answer},
                {
                    "type": "message",
                    "timestamp": "2026-07-21T00:00:04Z",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "devserver"}],
                        "idempotencyKey": "channel-final:123.456:0",
                    },
                },
            ]
            path.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )

            detail = build_detail("main", "session", path)

        self.assertEqual(detail.message_count, 2)
        self.assertEqual(
            [(turn.role, turn.text) for turn in detail.turns],
            [("user", "where are you running?"), ("assistant", "devserver")],
        )


if __name__ == "__main__":
    unittest.main()
