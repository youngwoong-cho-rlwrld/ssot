from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.sources import parse_codex_meta


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


if __name__ == "__main__":
    unittest.main()
