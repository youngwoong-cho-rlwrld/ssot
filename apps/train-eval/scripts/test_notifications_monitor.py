from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import jobs, notifications  # noqa: E402


def job(cluster: str, state: str) -> jobs.Job:
    return jobs.Job(
        cluster=cluster,
        job_id="153064",
        job_name=f"youngwoong_eval_{cluster}_20260713_212351",
        partition="background",
        state=state,
        elapsed="00:01",
        nodelist="node",
        phase="eval",
        variant=f"variant_{cluster}",
    )


class NotificationMonitorTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_numeric_id_on_two_clusters_does_not_collide(self):
        async def list_jobs(cluster_names, **_kwargs):
            cluster = cluster_names[0]
            return [job(cluster, "RUNNING")]

        monitor = notifications._Monitor()
        with (
            patch.object(
                notifications.clusters,
                "list_clusters",
                return_value=["kakao", "skt"],
            ),
            patch.object(notifications.jobs, "list_jobs", list_jobs),
        ):
            current = await monitor._collect("person@example.com")

        self.assertEqual(
            set(current),
            {
                "person@example.com|kakao/153064",
                "person@example.com|skt/153064",
            },
        )

    async def test_both_cluster_transitions_are_notified(self):
        async def collect(email):
            return {
                f"{email}|kakao/153064": {
                    "email": email,
                    "cluster": "kakao",
                    "event": "completed",
                    "_job": job("kakao", "COMPLETED"),
                },
                f"{email}|skt/153064": {
                    "email": email,
                    "cluster": "skt",
                    "event": "failed",
                    "_job": job("skt", "FAILED"),
                },
            }

        monitor = notifications._Monitor()
        monitor.primed = {"person@example.com"}
        monitor.state = {
            "person@example.com|kakao/153064": {
                "email": "person@example.com", "cluster": "kakao", "event": "running"
            },
            "person@example.com|skt/153064": {
                "email": "person@example.com", "cluster": "skt", "event": "running"
            },
        }
        monitor._collect = collect
        monitor._persist = Mock()
        post = AsyncMock()
        with (
            patch.object(
                notifications.notifications_config,
                "get_settings",
                return_value=SimpleNamespace(enabled=True, configured=True),
            ),
            patch.object(
                notifications.notifications_config,
                "event_enabled",
                return_value=True,
            ),
            patch.object(notifications, "_post", post),
            patch.object(
                notifications.settings_db,
                "list_principals",
                return_value=["person@example.com"],
            ),
        ):
            await monitor._tick()

        self.assertEqual(post.await_count, 2)
        messages = "\n".join(call.args[0] for call in post.await_args_list)
        self.assertIn("kakao/153064", messages)
        self.assertIn("skt/153064", messages)


class SuspendedNotificationTests(unittest.IsolatedAsyncioTestCase):
    def test_event_for_state_maps_suspended(self):
        # mlxp maps a Kueue-suspended workload (Job .spec.suspend) to the
        # normalized state "SUSPENDED"; it must be a notable event, and resume
        # surfaces through the existing RUNNING event.
        self.assertEqual(notifications._event_for_state("SUSPENDED"), "suspended")
        self.assertEqual(notifications._event_for_state("RUNNING"), "running")
        # Non-notable states stay unmapped.
        self.assertIsNone(notifications._event_for_state("PENDING"))

    def test_event_enabled_gates_suspended(self):
        cfg = notifications.notifications_config
        with patch.object(
            cfg, "get_settings",
            return_value=cfg.NotificationSettings(notify_suspended=True),
        ):
            self.assertTrue(cfg.event_enabled("suspended"))
        with patch.object(
            cfg, "get_settings",
            return_value=cfg.NotificationSettings(notify_suspended=False),
        ):
            self.assertFalse(cfg.event_enabled("suspended"))

    async def _run_tick(self, listed_state: str, prior_event: str) -> AsyncMock:
        async def list_jobs(cluster_names, **_kwargs):
            return [job(cluster_names[0], listed_state)]

        monitor = notifications._Monitor()
        monitor.primed = {"person@example.com"}
        monitor.state = {
            "person@example.com|skt/153064": {
                "email": "person@example.com", "cluster": "skt", "event": prior_event,
            },
        }
        monitor._persist = Mock()
        post = AsyncMock()
        with (
            patch.object(notifications.clusters, "list_clusters", return_value=["skt"]),
            patch.object(notifications.jobs, "list_jobs", list_jobs),
            patch.object(
                notifications.notifications_config, "get_settings",
                return_value=SimpleNamespace(enabled=True, configured=True),
            ),
            patch.object(
                notifications.notifications_config, "event_enabled", return_value=True,
            ),
            patch.object(notifications, "_post", post),
            patch.object(
                notifications.settings_db, "list_principals",
                return_value=["person@example.com"],
            ),
        ):
            await monitor._tick()
        return post

    async def test_transition_into_suspended_notifies(self):
        post = await self._run_tick("SUSPENDED", prior_event="running")
        self.assertEqual(post.await_count, 1)
        message = post.await_args_list[0].args[0]
        self.assertIn("Suspended", message)
        self.assertIn("skt/153064", message)

    async def test_resume_from_suspended_notifies_running(self):
        post = await self._run_tick("RUNNING", prior_event="suspended")
        self.assertEqual(post.await_count, 1)
        message = post.await_args_list[0].args[0]
        self.assertIn("Running", message)
        self.assertIn("skt/153064", message)


if __name__ == "__main__":
    unittest.main()
