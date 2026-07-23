"""Per-cluster partition-default policy for slurm CPU/memory flags.

skt and kakao run a job_submit filter that rejects explicit --cpus-per-task /
--mem on GPU partitions; submissions there must send no resource flags (None).
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import resource_presets as rp  # noqa: E402


def resources(cluster, phase="eval", partition="l40s-gpu_background", num_gpus=1, env_flag=None):
    return rp.slurm_resources_for(
        cluster=cluster,
        partition=partition,
        phase=phase,
        num_gpus=num_gpus,
        n_envs_per_gpu=1,
        env_flag=env_flag,
    )


class PartitionDefaultsPolicyTests(unittest.TestCase):
    def test_skt_eval_sends_no_flags(self):
        # The reported failure: skt eval resume must omit --cpus-per-task/--mem.
        self.assertIsNone(resources("skt", phase="eval"))

    def test_skt_train_sends_no_flags(self):
        self.assertIsNone(resources("skt", phase="train", partition="rlwrld-gpu", num_gpus=8))

    def test_kakao_still_sends_no_flags(self):
        self.assertIsNone(resources("kakao", phase="eval"))
        self.assertIsNone(resources("kakao", phase="train", num_gpus=4))

    def test_unfiltered_cluster_gets_presets(self):
        # A cluster without the filter keeps explicit resource requests.
        r = resources("gaia", phase="train", partition="gpu", num_gpus=1)
        self.assertIsNotNone(r)
        self.assertGreater(r.cpus_per_task, 0)

    def test_env_flag_disables_policy_for_skt(self):
        # Explicit override wins: SLURM_PARTITION_DEFAULTS_ONLY=0 re-enables flags.
        self.assertIsNotNone(resources("skt", phase="eval", env_flag="0"))

    def test_env_flag_enables_policy_for_new_cluster(self):
        # A future filtered cluster opts in via config without a code change.
        self.assertIsNone(resources("newgpu", phase="eval", env_flag="1"))

    def test_enforcement_flag_parsing(self):
        for truthy in ("1", "true", "TRUE", "yes", "on"):
            self.assertTrue(rp.cluster_enforces_partition_defaults("x", truthy))
        for falsy in ("0", "false", "no", "off"):
            self.assertFalse(rp.cluster_enforces_partition_defaults("x", falsy))
        # No override -> known-cluster default.
        self.assertTrue(rp.cluster_enforces_partition_defaults("skt", None))
        self.assertTrue(rp.cluster_enforces_partition_defaults("kakao", ""))
        self.assertFalse(rp.cluster_enforces_partition_defaults("gaia", None))


if __name__ == "__main__":
    unittest.main()
