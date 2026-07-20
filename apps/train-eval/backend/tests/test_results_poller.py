import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app import poller, results


class ResultsPollerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        poller._results_inflight.clear()

    async def test_failed_scan_returns_last_good_snapshot(self):
        failed = results.ResultsResponse(
            clusters=["kakao"],
            variants=[],
            errors=[results.ClusterResultError(cluster="kakao", error="ssh unavailable")],
        )
        cached = {
            "kakao": {
                "variants": [{"cluster": "kakao", "variant": "kept", "tasks": []}],
                "errors": [],
                "fetched_at": 123.0,
                "error": None,
            }
        }

        with (
            patch.object(
                poller.clusters, "cache_fingerprints", return_value={"kakao": "v1"}
            ),
            patch.object(poller.cache_db, "sync_cluster_configs", AsyncMock()),
            patch.object(results, "list_results", AsyncMock(return_value=failed)),
            patch.object(poller.cache_db, "read_results", AsyncMock(return_value=cached)),
            patch.object(poller.cache_db, "record_poll", AsyncMock()),
        ):
            response = await poller.refresh_results("kakao")

        self.assertEqual([item.variant for item in response.variants], ["kept"])
        self.assertEqual(response.fetched_at, {"kakao": 123.0})
        self.assertTrue(response.stale)
        self.assertEqual(response.errors[0].error, "ssh unavailable")

    async def test_concurrent_refreshes_share_one_scan(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0
        response = results.ResultsResponse(clusters=["kakao"], variants=[])

        async def scan(_cluster, _email=None, _fingerprint=None):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return response

        with (
            patch.object(
                poller.clusters, "cache_fingerprints", return_value={"kakao": "v1"}
            ),
            patch.object(poller.cache_db, "sync_cluster_configs", AsyncMock()),
            patch.object(poller, "_refresh_results_once", side_effect=scan),
        ):
            first = asyncio.create_task(poller.refresh_results("kakao"))
            await started.wait()
            second = asyncio.create_task(poller.refresh_results("kakao"))
            release.set()
            resolved = await asyncio.gather(first, second)

        self.assertEqual(calls, 1)
        self.assertIs(resolved[0], response)
        self.assertIs(resolved[1], response)

    async def test_different_users_do_not_share_an_inflight_scan(self):
        calls = []
        release = asyncio.Event()

        async def scan(cluster, email=None, _fingerprint=None):
            calls.append((cluster, email))
            await release.wait()
            return results.ResultsResponse(clusters=[cluster], variants=[])

        with (
            patch.object(
                poller.clusters, "cache_fingerprints", return_value={"kakao": "v1"}
            ),
            patch.object(poller.cache_db, "sync_cluster_configs", AsyncMock()),
            patch.object(poller, "_refresh_results_once", side_effect=scan),
        ):
            one = asyncio.create_task(
                poller.refresh_results("kakao", "one@example.com")
            )
            two = asyncio.create_task(
                poller.refresh_results("kakao", "two@example.com")
            )
            await asyncio.sleep(0)
            release.set()
            await asyncio.gather(one, two)

        self.assertCountEqual(
            calls,
            [
                ("kakao", "one@example.com"),
                ("kakao", "two@example.com"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
