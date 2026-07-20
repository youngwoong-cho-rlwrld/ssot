import asyncio
import json
import os
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import cli, settings


class SubprocessEnvironmentTests(unittest.TestCase):
    def test_inline_gateway_token_is_passed_through_the_child_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "openclaw.json"
            config_path.write_text(
                json.dumps({"gateway": {"auth": {"mode": "token", "token": "secret"}}}),
                encoding="utf-8",
            )
            with (
                patch.object(settings, "CONFIG_PATH", config_path),
                patch.dict(os.environ, {"PATH": "/usr/bin"}, clear=True),
            ):
                env = settings.subprocess_env()

        self.assertEqual(env["OPENCLAW_GATEWAY_TOKEN"], "secret")
        self.assertNotIn("OPENCLAW_GATEWAY_PASSWORD", env)

    def test_explicit_gateway_environment_wins_over_the_config_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "openclaw.json"
            config_path.write_text(
                json.dumps({"gateway": {"auth": {"mode": "token", "token": "file"}}}),
                encoding="utf-8",
            )
            with (
                patch.object(settings, "CONFIG_PATH", config_path),
                patch.dict(
                    os.environ,
                    {"PATH": "/usr/bin", "OPENCLAW_GATEWAY_TOKEN": "environment"},
                    clear=True,
                ),
            ):
                env = settings.subprocess_env()

        self.assertEqual(env["OPENCLAW_GATEWAY_TOKEN"], "environment")

    def test_password_auth_uses_the_password_environment_variable(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {"gateway": {"auth": {"mode": "password", "password": "secret"}}}
                ),
                encoding="utf-8",
            )
            with (
                patch.object(settings, "CONFIG_PATH", config_path),
                patch.dict(os.environ, {"PATH": "/usr/bin"}, clear=True),
            ):
                env = settings.subprocess_env()

        self.assertEqual(env["OPENCLAW_GATEWAY_PASSWORD"], "secret")
        self.assertNotIn("OPENCLAW_GATEWAY_TOKEN", env)


class SingleFlightCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_callers_share_one_loader(self):
        cache = cli._SingleFlightCache(60)
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {"ok": True}

        first = asyncio.create_task(cache.get(load))
        await started.wait()
        second = asyncio.create_task(cache.get(load))
        release.set()

        self.assertEqual(await asyncio.gather(first, second), [{"ok": True}, {"ok": True}])
        self.assertEqual(calls, 1)


class ProcessCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_signals_group_when_parent_already_exited(self):
        proc = unittest.mock.Mock(pid=1234, returncode=0)
        proc.wait = AsyncMock(return_value=0)

        def killpg(_pid, sig):
            if sig == 0:
                raise ProcessLookupError

        with patch.object(cli.os, "killpg", side_effect=killpg) as mocked:
            await cli._terminate_process_group(proc)

        mocked.assert_any_call(1234, signal.SIGTERM)
        self.assertNotIn(unittest.mock.call(1234, signal.SIGKILL), mocked.call_args_list)
        proc.wait.assert_awaited()

    async def test_force_kills_group_only_after_grace_period(self):
        proc = unittest.mock.Mock(pid=5678, returncode=None)
        proc.wait = AsyncMock(return_value=0)

        with (
            patch.object(cli, "_PROCESS_TERM_GRACE_SECONDS", 0),
            patch.object(cli.os, "killpg") as mocked,
        ):
            await cli._terminate_process_group(proc)

        self.assertEqual(
            mocked.call_args_list,
            [
                unittest.mock.call(5678, signal.SIGTERM),
                unittest.mock.call(5678, signal.SIGKILL),
            ],
        )


if __name__ == "__main__":
    unittest.main()
