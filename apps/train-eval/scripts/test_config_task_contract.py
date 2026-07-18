"""Contract for the unified task/model config shape (config redesign).

Every experiment variant must express its eval task(s) through a TASKS array and
must not carry the scalars the model registry / TASKS row now own:

  - single-task variants  -> exactly one row whose SHORT is the __single__
    sentinel (drives the flat, no-subdir output layout);
  - multi-task variants   -> two or more rows, none using the __single__ short.

None of TASK_NAME / DEXJOCO_TASK / INSTRUCTION / EVAL_HARNESS / MODEL_VERSION /
ACTION_HORIZON_MODE / FLAGS_PROFILE / DEXJOCO_GIT_COMMIT may survive in a config.
"""
from __future__ import annotations

import asyncio
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.variants import list_variants, load_variant  # noqa: E402

SENTINEL = "__single__"
FORBIDDEN_SCALARS = (
    "TASK_NAME",
    "DEXJOCO_TASK",
    "INSTRUCTION",
    "EVAL_HARNESS",
    "MODEL_VERSION",
    "ACTION_HORIZON_MODE",
    "FLAGS_PROFILE",
    "DEXJOCO_GIT_COMMIT",
)


class ConfigTaskContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Load every variant once, in a single event loop: variants.load_variant
        # shares a module-level semaphore that can't cross asyncio.run loops.
        async def load_all():
            return await asyncio.gather(*(load_variant(n) for n in list_variants()))

        cls.variants = asyncio.run(load_all())

    def test_every_variant_has_tasks(self):
        for v in self.variants:
            rows = v.arrays.get("TASKS")
            self.assertTrue(rows, f"{v.name}: no TASKS array")

    def test_single_vs_multi_task_shape(self):
        for v in self.variants:
            rows = v.arrays.get("TASKS") or []
            shorts = [r.split("|", 1)[0] for r in rows]
            if SENTINEL in shorts:
                # A __single__ sentinel must be the ONLY row (single-task).
                self.assertEqual(
                    shorts, [SENTINEL],
                    f"{v.name}: __single__ sentinel mixed with other task rows: {shorts}",
                )
                # The single row must carry task_name and instruction fields.
                self.assertGreaterEqual(
                    rows[0].count("|"), 2,
                    f"{v.name}: __single__ row is missing task_name|instruction: {rows[0]!r}",
                )
            else:
                self.assertGreaterEqual(
                    len(rows), 1, f"{v.name}: empty multi-task TASKS"
                )

    def test_tasks_array_is_multiline(self):
        # The submit-time TASKS override regexes (submission_snapshot.py) match
        # `^TASKS=\(.*?^\)\s*$` with MULTILINE|DOTALL — they require the closing
        # `)` on its own line. A single-line `TASKS=(...)` slips past them: the
        # override silently no-ops and the submitted task/instruction is wrong.
        # Assert against the RAW config text so single-line arrays are rejected.
        override_re = re.compile(r"^TASKS=\(.*?^\)\s*$", re.MULTILINE | re.DOTALL)
        for v in self.variants:
            self.assertRegex(
                v.raw,
                r"(?m)^TASKS=\(\s*$",
                f"{v.name}: TASKS=( must start a multi-line array (opening paren "
                f"alone on its line); single-line TASKS=(...) breaks submit-time overrides",
            )
            self.assertIsNotNone(
                override_re.search(v.raw),
                f"{v.name}: TASKS array is not matched by the submit-time override "
                f"regex (closing ) must be on its own line)",
            )

    def test_no_forbidden_scalars(self):
        for v in self.variants:
            present = [k for k in FORBIDDEN_SCALARS if k in v.vars]
            self.assertEqual(
                present, [], f"{v.name}: forbidden scalar(s) still set: {present}"
            )


if __name__ == "__main__":
    unittest.main()
