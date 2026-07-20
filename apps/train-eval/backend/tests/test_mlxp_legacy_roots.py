from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app import checkpoint_links, mlxp_config, mlxp_jobs


def settings(*, experiments_dir: str = "/data/unified/user/experiments") -> SimpleNamespace:
    return SimpleNamespace(
        experiments_dir=experiments_dir,
        ddn_user_home="/data/user",
    )


class MlxpLegacyRootTests(unittest.IsolatedAsyncioTestCase):
    def test_experiment_roots_include_current_then_legacy(self) -> None:
        self.assertEqual(
            mlxp_config.experiments_roots(settings()),
            (
                "/data/unified/user/experiments",
                "/data/user/experiments",
            ),
        )

    def test_experiment_roots_dedupe_when_legacy_is_current(self) -> None:
        self.assertEqual(
            mlxp_config.experiments_roots(
                settings(experiments_dir="/data/user/experiments/")
            ),
            ("/data/user/experiments",),
        )

    async def test_checkpoint_copy_lookup_reads_both_roots(self) -> None:
        record = {
            "source_cluster": "mlxp",
            "source_job": "training-job",
            "source_path": "/data/user/experiments/example/checkpoints/run/checkpoint-100",
            "dest_path": "/remote/checkpoints/run",
        }
        kubectl = AsyncMock(return_value=(0, json.dumps(record) + "\n", ""))
        with (
            patch.object(checkpoint_links, "get_mlxp_settings", return_value=settings()),
            patch.object(checkpoint_links, "_kubectl_bash_lc", kubectl),
        ):
            self.assertEqual(
                await checkpoint_links._mlxp_copy_history_records(),
                [record],
            )

        command = kubectl.await_args.args[0]
        self.assertIn(
            "/data/unified/user/experiments/.train-eval-web/checkpoint-copies/*.jsonl",
            command,
        )
        self.assertIn(
            "/data/user/experiments/.train-eval-web/checkpoint-copies/*.jsonl",
            command,
        )

    async def test_archived_job_preserves_wandb_project_and_snapshot_paths(self) -> None:
        run = {
            "job_id": "training-job",
            "job_name": "train_example_20260701_112738",
            "output_namespace": "example_20260701_112738_abcdef",
            "variant": "example",
            "train_note": "note",
            "num_gpus": "2",
            "start": "2026-07-01T11:27:42+09:00",
            "end": "2026-07-02T01:21:02+09:00",
            "elapsed": "13:53:20",
            "checkpoint_dir": "/data/user/experiments/example/checkpoints/run",
            "config_snapshot_path": "/data/user/experiments/example/config_run.sh",
            "config_snapshot_meta_path": "/data/user/experiments/example/config_run.meta.json",
            "wandb_project": "dexjoco",
        }
        with patch.object(
            mlxp_jobs, "_list_archived_runs", AsyncMock(return_value=[run])
        ):
            record = await mlxp_jobs._archived_record("training-job")

        self.assertIsNotNone(record)
        comment = mlxp_jobs.parse_comment_fields(record["JobComment"])
        self.assertEqual(comment["wandb_project"], "dexjoco")
        self.assertEqual(comment["checkpoint_dir"], run["checkpoint_dir"])
        self.assertEqual(
            comment["config_snapshot_meta_path"],
            run["config_snapshot_meta_path"],
        )

    async def test_checkpoint_lookup_falls_back_to_other_cluster_metadata(self) -> None:
        checkpoint = "/remote/checkpoints/example_20260701_abcdef"

        async def local_lookup(cluster: str, _checkpoint: str):
            if cluster == "mlxp":
                return {
                    "cluster": "mlxp",
                    "job_id": "training-job",
                    "job_name": "train_example_20260701_112738",
                }
            return None

        with (
            patch.object(checkpoint_links, "list_clusters", return_value=["skt", "mlxp", "kakao"]),
            patch.object(checkpoint_links, "checkpoint_copy_links", AsyncMock(return_value=[])),
            patch.object(checkpoint_links, "_local_checkpoint_job", side_effect=local_lookup),
        ):
            result = await checkpoint_links.find_training_job_for_checkpoint(
                "skt", checkpoint
            )

        self.assertEqual(result["job_id"], "training-job")

    async def test_checkpoint_lookup_rejects_ambiguous_cross_cluster_metadata(self) -> None:
        checkpoint = "/remote/checkpoints/example_20260701_abcdef"

        async def local_lookup(cluster: str, _checkpoint: str):
            if cluster == "skt":
                return None
            return {
                "cluster": cluster,
                "job_id": f"{cluster}-training-job",
                "job_name": "train_example_20260701_112738",
            }

        with (
            patch.object(checkpoint_links, "list_clusters", return_value=["skt", "mlxp", "kakao"]),
            patch.object(checkpoint_links, "checkpoint_copy_links", AsyncMock(return_value=[])),
            patch.object(checkpoint_links, "_local_checkpoint_job", side_effect=local_lookup),
        ):
            result = await checkpoint_links.find_training_job_for_checkpoint(
                "skt", checkpoint
            )

        self.assertIsNone(result)

    def test_remote_lookup_matches_legacy_train_namespace_alias(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            jobs_dir = os.path.join(tempdir, ".train-eval-web", "jobs")
            os.makedirs(jobs_dir)
            with open(os.path.join(jobs_dir, "389121.meta"), "w") as handle:
                handle.write(
                    "phase=train\n"
                    "job_name=train_dexjoco_physixel_click_mouse_campaign\n"
                    "checkpoint_dir=$HOME/.train-eval-web/experiments/"
                    "dexjoco_physixel_click_mouse_train/checkpoints/"
                    "dexjoco_physixel_click_mouse_train_20260627_160127_dee92b\n"
                )

            checkpoint = (
                f"{tempdir}/.train-eval-web/experiments/"
                "dexjoco_physixel_click_mouse/checkpoints/"
                "dexjoco_physixel_click_mouse_20260627_160127_dee92b"
            )
            env = {
                **os.environ,
                "HOME": tempdir,
                "CHECKPOINT_LOOKUP_B64": base64.b64encode(
                    checkpoint.encode()
                ).decode(),
                "CHECKPOINT_LOOKUP_CLUSTER": "kakao",
            }
            result = subprocess.run(
                [sys.executable, "-c", checkpoint_links._REMOTE_CHECKPOINT_LOOKUP_SCRIPT],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )

        self.assertEqual(json.loads(result.stdout)["job_id"], "389121")


if __name__ == "__main__":
    unittest.main()
