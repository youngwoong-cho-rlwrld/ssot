from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

from app import cache_db
from app.jobs import Job


def job(cluster: str, job_id: str, name: str) -> Job:
    return Job(
        cluster=cluster,
        job_id=job_id,
        job_name=name,
        partition="gpu",
        state="RUNNING",
        elapsed="00:01",
        nodelist="node",
    )


def terminal_job(cluster: str, job_id: str, name: str) -> Job:
    row = job(cluster, job_id, name)
    row.state = "COMPLETED"
    row.end = "2026-07-20T12:00:00+00:00"
    return row


class CacheScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.env = patch.dict(
            os.environ,
            {"TRAIN_EVAL_DB_PATH": f"{self.tempdir.name}/cache.sqlite"},
        )
        self.env.start()
        if cache_db._conn is not None:
            cache_db._conn.close()
            cache_db._conn = None
        await cache_db.init()

    async def asyncTearDown(self) -> None:
        if cache_db._conn is not None:
            cache_db._conn.close()
            cache_db._conn = None
        self.env.stop()
        self.tempdir.cleanup()

    async def test_jobs_results_and_poll_metadata_are_isolated_by_email(self) -> None:
        await cache_db.upsert_jobs(
            "kakao", [job("kakao", "1", "one")], scope="one@example.com"
        )
        await cache_db.upsert_jobs(
            "kakao", [job("kakao", "1", "two")], scope="two@example.com"
        )
        self.assertEqual(
            (await cache_db.read_jobs(None, None, scope="one@example.com"))[0][
                "job_name"
            ],
            "one",
        )
        self.assertEqual(
            (await cache_db.read_jobs(None, None, scope="two@example.com"))[0][
                "job_name"
            ],
            "two",
        )

        await cache_db.write_results(
            "kakao", [{"variant": "one"}], [], 1.0, 1, None,
            scope="one@example.com",
        )
        await cache_db.write_results(
            "kakao", [{"variant": "two"}], [], 2.0, 1, None,
            scope="two@example.com",
        )
        self.assertEqual(
            (await cache_db.read_results(None, scope="one@example.com"))["kakao"][
                "variants"
            ][0]["variant"],
            "one",
        )
        self.assertEqual(
            (await cache_db.read_results(None, scope="two@example.com"))["kakao"][
                "variants"
            ][0]["variant"],
            "two",
        )

        await cache_db.record_poll(
            "kakao", "results", True, None, 1, scope="one@example.com"
        )
        self.assertIn(
            "kakao",
            await cache_db.read_poll_meta("results", scope="one@example.com"),
        )
        self.assertEqual(
            await cache_db.read_poll_meta("results", scope="two@example.com"),
            {},
        )

    async def test_config_changes_and_removals_purge_only_that_users_cache(self) -> None:
        scope = "one@example.com"
        await cache_db.sync_cluster_configs({"kakao": "v1"}, scope=scope)
        await cache_db.upsert_jobs("kakao", [job("kakao", "1", "old")], scope=scope)
        await cache_db.write_results("kakao", [], [], 1.0, 1, None, scope=scope)
        await cache_db.record_poll("kakao", "jobs", True, None, 1, scope=scope)

        await cache_db.sync_cluster_configs({"kakao": "v2"}, scope=scope)
        self.assertEqual(await cache_db.read_jobs(["kakao"], None, scope=scope), [])
        self.assertEqual(await cache_db.read_results(["kakao"], scope=scope), {})
        self.assertEqual(await cache_db.read_poll_meta("jobs", scope=scope), {})

        await cache_db.upsert_jobs("kakao", [job("kakao", "2", "new")], scope=scope)
        await cache_db.sync_cluster_configs({}, scope=scope)
        self.assertEqual(await cache_db.read_jobs([], None, scope=scope), [])
        self.assertEqual(await cache_db.read_results([], scope=scope), {})

    async def test_successful_snapshot_closes_only_missing_active_jobs(self) -> None:
        scope = "one@example.com"
        await cache_db.upsert_jobs(
            "kakao",
            [
                job("kakao", "missing", "was-running"),
                job("kakao", "present", "still-running"),
                terminal_job("kakao", "finished", "already-finished"),
            ],
            scope=scope,
        )

        await cache_db.reconcile_jobs(
            "kakao", [job("kakao", "present", "still-running")], scope=scope
        )

        rows = {
            row["job_id"]: row
            for row in await cache_db.read_jobs(["kakao"], None, scope=scope)
        }
        self.assertEqual(rows["present"]["state"], "RUNNING")
        self.assertEqual(rows["missing"]["state"], "CANCELLED")
        self.assertEqual(
            rows["missing"]["reason"], "No longer reported by cluster"
        )
        self.assertIsNotNone(rows["missing"]["end"])
        self.assertEqual(rows["finished"]["state"], "COMPLETED")

    async def test_empty_successful_snapshot_is_scope_isolated(self) -> None:
        await cache_db.upsert_jobs(
            "mlxp", [job("mlxp", "same", "one")], scope="one@example.com"
        )
        await cache_db.upsert_jobs(
            "mlxp", [job("mlxp", "same", "two")], scope="two@example.com"
        )

        await cache_db.reconcile_jobs("mlxp", [], scope="one@example.com")

        one = await cache_db.read_jobs(["mlxp"], None, scope="one@example.com")
        two = await cache_db.read_jobs(["mlxp"], None, scope="two@example.com")
        self.assertEqual(one[0]["state"], "CANCELLED")
        self.assertEqual(two[0]["state"], "RUNNING")


if __name__ == "__main__":
    unittest.main()
