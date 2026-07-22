from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app import submit

REPO_DEFAULT = "TRAIN_GLOBAL_BATCH_SIZE=128\nTRAIN_BATCH_SIZE=32\n"
TRAINING_SNAPSHOT = "TRAIN_GLOBAL_BATCH_SIZE=256\nTRAIN_BATCH_SIZE=64\n"


def variant() -> SimpleNamespace:
    return SimpleNamespace(name="exp_a", raw=REPO_DEFAULT)


class ResolveEvalBaseConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_checkpoint_uses_repo_default(self) -> None:
        got = await submit.resolve_eval_base_config(variant(), "", "kakao")
        self.assertEqual(got, REPO_DEFAULT)

    async def test_no_training_job_falls_back_to_repo_default(self) -> None:
        with patch.object(
            submit, "find_training_job_for_checkpoint", AsyncMock(return_value=None)
        ):
            got = await submit.resolve_eval_base_config(variant(), "/ckpt/step-100", "kakao")
        self.assertEqual(got, REPO_DEFAULT)

    async def test_uses_snapshot_path_from_meta(self) -> None:
        info = {
            "cluster": "kakao",
            "job_id": "42",
            "job_name": "exp_a_train_x",
            "config_snapshot_path": "$HOME/.train-eval-web/experiments/exp_a/config_x.sh",
        }
        with patch.object(
            submit, "find_training_job_for_checkpoint", AsyncMock(return_value=info)
        ), patch.object(
            submit, "_read_remote_text", AsyncMock(return_value=TRAINING_SNAPSHOT)
        ) as read:
            got = await submit.resolve_eval_base_config(variant(), "/ckpt/step-100", "kakao")
        self.assertEqual(got, TRAINING_SNAPSHOT)
        read.assert_awaited_once_with(
            "kakao", "$HOME/.train-eval-web/experiments/exp_a/config_x.sh"
        )

    async def test_derives_snapshot_path_from_job_name(self) -> None:
        info = {"cluster": "kakao", "job_id": "42", "job_name": "exp_a_train_x"}
        with patch.object(
            submit, "find_training_job_for_checkpoint", AsyncMock(return_value=info)
        ), patch.object(
            submit, "_read_remote_text", AsyncMock(return_value=TRAINING_SNAPSHOT)
        ) as read:
            got = await submit.resolve_eval_base_config(variant(), "/ckpt/step-100", "kakao")
        self.assertEqual(got, TRAINING_SNAPSHOT)
        # Path is reconstructed deterministically for the resolved variant/job.
        expected = submit.config_snapshot_paths("exp_a", "exp_a_train_x").path
        read.assert_awaited_once_with("kakao", expected)

    async def test_missing_snapshot_file_falls_back_to_repo_default(self) -> None:
        info = {"cluster": "kakao", "job_id": "42", "job_name": "exp_a_train_x"}
        with patch.object(
            submit, "find_training_job_for_checkpoint", AsyncMock(return_value=info)
        ), patch.object(
            submit, "_read_remote_text", AsyncMock(return_value=None)
        ):
            got = await submit.resolve_eval_base_config(variant(), "/ckpt/step-100", "kakao")
        self.assertEqual(got, REPO_DEFAULT)

    async def test_cross_cluster_reads_from_training_cluster(self) -> None:
        # Checkpoint copied to skt for eval, but trained on kakao: read the
        # snapshot from the training cluster, not the eval cluster.
        info = {
            "cluster": "kakao",
            "job_id": "42",
            "job_name": "exp_a_train_x",
            "config_snapshot_path": "$HOME/.train-eval-web/experiments/exp_a/config_x.sh",
        }
        with patch.object(
            submit, "find_training_job_for_checkpoint", AsyncMock(return_value=info)
        ), patch.object(
            submit, "_read_remote_text", AsyncMock(return_value=TRAINING_SNAPSHOT)
        ) as read:
            await submit.resolve_eval_base_config(variant(), "/ckpt/step-100", "skt")
        self.assertEqual(read.await_args.args[0], "kakao")


if __name__ == "__main__":
    unittest.main()
