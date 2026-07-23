"""MODEL_OUTPUT_DIR propagation for the SKT slurm job_submit filter.

SKT's job_submit.lua rejects any sbatch job whose MODEL_OUTPUT_DIR env is unset
or does not start with /fsx/rlwrld-unified-checkpoints/<user>/. Both fresh submit
and resume route through submit.submit(), so the derivation below feeds the
sbatch --export for either path.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import paths, submit  # noqa: E402

# UNIFIED_EXPERIMENTS_DIR as configured for SKT, and the prefix the filter
# derives (MODEL_OUTPUT_ROOT + "/" + username + "/").
UNIFIED_ROOT = "/fsx/rlwrld-unified-checkpoints/youngwoong_cho/experiments"
FILTER_PREFIX = "/fsx/rlwrld-unified-checkpoints/youngwoong_cho/"


def _passes_filter(path: str) -> bool:
    # Mirrors job_submit.lua: non-empty, no ./ or ../ elements, correct prefix.
    if not path:
        return False
    if "/./" in path or "/../" in path or path.endswith(("/.", "/..")):
        return False
    return path.startswith(FILTER_PREFIX)


class ModelOutputDirTests(unittest.TestCase):
    def _skt_dirs(self, variant: str, namespace: str):
        exp_out_dir = f"{UNIFIED_ROOT}/{variant}"
        return (
            exp_out_dir,
            paths.checkpoint_dir(exp_out_dir, namespace),
            paths.eval_dir(exp_out_dir, namespace),
        )

    def test_eval_resume_uses_eval_dir_under_prefix(self):
        exp, ckpt, ev = self._skt_dirs(
            "dexjoco_physixel_bimanual_5tasks_224",
            "dexjoco_physixel_bimanual_5tasks_224_20260721_193504_510f7e",
        )
        out = submit.derive_model_output_dir("eval", UNIFIED_ROOT, ckpt, ev, exp)
        self.assertEqual(out, ev)
        self.assertTrue(_passes_filter(out), out)

    def test_train_uses_checkpoint_dir_under_prefix(self):
        exp, ckpt, ev = self._skt_dirs("v", "v_20260101_000000_abc123")
        out = submit.derive_model_output_dir("train", UNIFIED_ROOT, ckpt, ev, exp)
        self.assertEqual(out, ckpt)
        self.assertTrue(_passes_filter(out), out)

    def test_no_unified_root_sets_nothing(self):
        # kakao has no UNIFIED_EXPERIMENTS_DIR and no filter; export nothing.
        self.assertIsNone(
            submit.derive_model_output_dir("eval", "", None, "/home/u/eval", "/home/u")
        )

    def test_falls_back_to_exp_out_dir_when_specific_missing(self):
        exp = f"{UNIFIED_ROOT}/v"
        out = submit.derive_model_output_dir("eval", UNIFIED_ROOT, None, None, exp)
        self.assertEqual(out, exp)
        self.assertTrue(_passes_filter(out), out)


if __name__ == "__main__":
    unittest.main()
