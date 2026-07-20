from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app import jobs, notifications


def job(cluster: str, state: str) -> jobs.Job:
    return jobs.Job(
        cluster=cluster,
        job_id="1",
        job_name=f"eval_{cluster}",
        partition="gpu",
        state=state,
        elapsed="00:01",
        nodelist="node",
        phase="eval",
        variant=cluster,
    )


class NotificationScopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_transition_monitor_iterates_users_with_isolated_state(self):
        monitor = notifications._Monitor()
        monitor.primed = {"one@example.com", "two@example.com"}
        monitor.state = {
            "one@example.com|kakao/1": {
                "email": "one@example.com",
                "cluster": "kakao",
                "event": "running",
            },
            "two@example.com|kakao/1": {
                "email": "two@example.com",
                "cluster": "kakao",
                "event": "running",
            },
        }

        async def collect(email):
            return {
                f"{email}|kakao/1": {
                    "email": email,
                    "cluster": "kakao",
                    "event": "completed",
                    "_job": job("kakao", "COMPLETED"),
                }
            }

        monitor._collect = collect
        monitor._persist = Mock()
        posts = []

        async def post(message):
            posts.append((notifications.user_context.current_user_email(), message))

        with (
            patch.object(
                notifications.settings_db,
                "list_principals",
                return_value=["one@example.com", "two@example.com"],
            ),
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
            patch.object(notifications, "_post", side_effect=post),
        ):
            await monitor._tick()

        self.assertEqual(
            [email for email, _message in posts],
            ["one@example.com", "two@example.com"],
        )
        self.assertEqual(len(monitor.state), 2)


if __name__ == "__main__":
    unittest.main()
