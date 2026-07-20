"""Thin wrappers around the local ``openclaw`` CLI.

The CLI owns the gateway auth token and wraps the token-auth WS RPC; the browser
must never reach the gateway directly (no CORS), so every call goes through here
as an argument-list subprocess (never a shell string). We never pass
``--deliver`` or ``--channel`` to ``openclaw agent`` — those would push a turn to
Slack rather than keeping it local.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import tempfile
import time
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from . import settings

log = logging.getLogger("openclaw.cli")

_PROCESS_TERM_GRACE_SECONDS = 3.0
_CHAT_CLEANUP_MARGIN_SECONDS = 10


class _SingleFlightCache:
    """Small event-loop-local TTL cache that shares one in-flight CLI call."""

    def __init__(self, ttl_seconds: float) -> None:
        self.ttl_seconds = ttl_seconds
        self.value: Any = None
        self.stored_at = 0.0
        self.task: asyncio.Task[Any] | None = None

    async def get(self, loader: Callable[[], Awaitable[Any]]) -> Any:
        now = time.monotonic()
        if self.stored_at and now - self.stored_at < self.ttl_seconds:
            return self.value
        task = self.task
        if task is None:
            task = asyncio.create_task(loader())
            self.task = task
        try:
            value = await asyncio.shield(task)
            self.value = value
            self.stored_at = time.monotonic()
            return value
        finally:
            if self.task is task and task.done():
                self.task = None

    def invalidate(self) -> None:
        self.value = None
        self.stored_at = 0.0


_status_cache = _SingleFlightCache(5.0)
_session_caches: dict[int, _SingleFlightCache] = {}
_models_cache = _SingleFlightCache(60.0)


class CliError(Exception):
    """A CLI invocation failed (missing binary, non-zero exit, timeout, or bad
    JSON). Carries a human-readable message plus a ``kind`` the frontend uses to
    tell "openclaw isn't installed" (``cli_missing``) apart from "the gateway is
    down / a call failed" (``gateway_down``)."""

    def __init__(self, message: str, kind: str = "gateway_down") -> None:
        super().__init__(message)
        self.kind = kind


async def _run(
    args: list[str], timeout: int, stdin_data: Optional[bytes] = None
) -> tuple[int, bytes, bytes]:
    """Run ``openclaw <args>`` to completion, returning (rc, stdout, stderr).

    If ``stdin_data`` is given it is written to the child's stdin (used to feed
    a secret to ``models auth paste-api-key`` without ever placing it on the
    command line, where it would show up in the process list).
    """
    bin_path = settings.openclaw_bin()
    try:
        proc = await asyncio.create_subprocess_exec(
            bin_path,
            *args,
            stdin=asyncio.subprocess.PIPE if stdin_data is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=settings.subprocess_env(),
            start_new_session=os.name != "nt",
        )
    except FileNotFoundError as exc:
        raise CliError(f"openclaw CLI not found ({bin_path})", kind="cli_missing") from exc
    except OSError as exc:
        raise CliError(f"failed to launch openclaw: {exc}") from exc

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=stdin_data), timeout=timeout
        )
    except asyncio.TimeoutError as exc:
        await _terminate_process_group(proc)
        raise CliError(f"openclaw {args[0] if args else ''} timed out after {timeout}s") from exc
    except asyncio.CancelledError:
        await _terminate_process_group(proc)
        raise
    except BaseException:
        await _terminate_process_group(proc)
        raise

    # ``communicate`` proves the captured pipes reached EOF, but a command can
    # still leave a detached descendant in its session. Sweep the private
    # process group before returning so no CLI invocation can leak children.
    await _terminate_process_group(proc)

    return proc.returncode or 0, stdout, stderr


async def _terminate_process_group(proc: asyncio.subprocess.Process) -> None:
    """Gracefully stop a CLI invocation and every child it spawned.

    OpenClaw handles SIGTERM by aborting an accepted Gateway run. Give that
    cleanup a short grace period, then force-kill only if the private process
    group is still alive. On POSIX the group must be signalled even when the
    parent already exited: a descendant may still be holding captured pipes.
    """
    if os.name == "nt":
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), _PROCESS_TERM_GRACE_SECONDS)
            except asyncio.TimeoutError:
                proc.kill()
        await proc.wait()
        return

    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        await proc.wait()
        return

    deadline = time.monotonic() + _PROCESS_TERM_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not _process_group_exists(proc.pid):
            await proc.wait()
            return
        await asyncio.sleep(0.05)

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await proc.wait()


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


async def run_json(args: list[str], timeout: int) -> Any:
    """Run an openclaw subcommand and parse its stdout as JSON."""
    rc, stdout, stderr = await _run(args, timeout)
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip() or stdout.decode(
            "utf-8", "replace"
        ).strip()
        raise CliError(f"openclaw {args[0]} exited {rc}: {detail[:500]}")
    text = stdout.decode("utf-8", "replace").strip()
    if not text:
        raise CliError(f"openclaw {args[0]} produced no output")
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError) as exc:
        raise CliError(f"openclaw {args[0]} returned non-JSON output") from exc


async def status() -> Any:
    return await _status_cache.get(
        lambda: run_json(["status", "--json"], settings.STATUS_TIMEOUT)
    )


async def sessions(limit: int = 100) -> Any:
    cache = _session_caches.setdefault(limit, _SingleFlightCache(5.0))
    return await cache.get(
        lambda: run_json(
            ["sessions", "--json", "--all-agents", "--limit", str(limit)],
            settings.SESSIONS_TIMEOUT,
        )
    )


def invalidate_sessions() -> None:
    for cache in _session_caches.values():
        cache.invalidate()


def invalidate_status() -> None:
    _status_cache.invalidate()


async def logs(limit: int) -> list[dict[str, Any]]:
    """Non-streaming tail: run `openclaw logs --json` and return log lines.

    The CLI emits JSONL (a ``meta`` line, ``log`` lines, and possibly a
    ``notice``); we keep only the ``log`` entries and cap to ``limit``.
    """
    rc, stdout, stderr = await _run(
        ["logs", "--json", "--max-bytes", str(settings.LOGS_MAX_BYTES)],
        settings.LOGS_TIMEOUT,
    )
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip()
        raise CliError(f"openclaw logs exited {rc}: {detail[:500]}")
    out: list[dict[str, Any]] = []
    for line in stdout.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(rec, dict) and rec.get("type") == "log":
            out.append(rec)
    return out[-limit:] if limit > 0 else out


async def stream_logs() -> AsyncIterator[str]:
    """Yield raw JSONL lines from ``openclaw logs --json --follow``.

    The subprocess is terminated when the async generator is closed (client
    disconnect), so a browser leaving the page kills the follower.
    """
    bin_path = settings.openclaw_bin()
    try:
        proc = await asyncio.create_subprocess_exec(
            bin_path,
            "logs",
            "--json",
            "--follow",
            "--max-bytes",
            str(settings.LOGS_MAX_BYTES),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=settings.subprocess_env(),
            start_new_session=os.name != "nt",
        )
    except FileNotFoundError as exc:
        raise CliError(f"openclaw CLI not found ({bin_path})", kind="cli_missing") from exc
    except OSError as exc:
        raise CliError(f"failed to launch openclaw logs: {exc}") from exc

    assert proc.stdout is not None
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            yield line.decode("utf-8", "replace").rstrip("\n")
    finally:
        await _terminate_process_group(proc)


def _write_agent_message(message: str) -> str:
    """Write a private temporary message file and return its path."""
    fd, file_path = tempfile.mkstemp(prefix="ssot-openclaw-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(message)
    return file_path


async def agent_turn(
    message: str,
    session_key: Optional[str],
    model: Optional[str] = None,
) -> Any:
    """Run one local agent turn. Never passes --deliver/--channel.

    The message goes through ``--message-file`` rather than argv so large
    Results Sheet contexts do not hit the operating system's argument-size
    limit. The file is mode 0600 (mkstemp) and removed after the CLI exits.
    """
    message_path = await asyncio.to_thread(_write_agent_message, message)
    try:
        args = [
            "agent",
            "--json",
            "--message-file",
            message_path,
            "--timeout",
            str(settings.CHAT_TIMEOUT),
        ]
        if session_key:
            args += ["--session-key", session_key]
        if model:
            args += ["--model", model]
        return await run_json(
            args,
            settings.CHAT_TIMEOUT + _CHAT_CLEANUP_MARGIN_SECONDS,
        )
    finally:
        await asyncio.to_thread(Path(message_path).unlink, missing_ok=True)


# --- models ---------------------------------------------------------------


async def models_list() -> Any:
    return await run_json(["models", "list", "--json"], settings.STATUS_TIMEOUT)


async def models_status() -> Any:
    return await run_json(["models", "status", "--json"], settings.STATUS_TIMEOUT)


async def models_set(model: str) -> None:
    """Set the default model. Raises CliError on non-zero exit."""
    rc, stdout, stderr = await _run(["models", "set", model], settings.STATUS_TIMEOUT)
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip() or stdout.decode(
            "utf-8", "replace"
        ).strip()
        raise CliError(f"openclaw models set exited {rc}: {detail[:300]}")
    _models_cache.invalidate()


async def models_paste_api_key(provider: str, api_key: str) -> None:
    """Store an API key for ``provider`` via ``models auth paste-api-key``.

    The key is written to the child's stdin (never argv, never logged). Raises
    CliError on failure; the error text is the CLI's stderr, which does not echo
    the key.
    """
    rc, stdout, stderr = await _run(
        ["models", "auth", "paste-api-key", "--provider", provider],
        settings.STATUS_TIMEOUT,
        stdin_data=(api_key.rstrip("\n") + "\n").encode("utf-8"),
    )
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip() or stdout.decode(
            "utf-8", "replace"
        ).strip()
        raise CliError(f"openclaw models auth exited {rc}: {detail[:300]}")
    _models_cache.invalidate()


# --- heartbeat & cron controls --------------------------------------------


async def config_set(path: str, value: str) -> None:
    """Set a config value by dotted path. Raises CliError on non-zero exit."""
    rc, stdout, stderr = await _run(["config", "set", path, value], settings.STATUS_TIMEOUT)
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip() or stdout.decode(
            "utf-8", "replace"
        ).strip()
        raise CliError(f"openclaw config set exited {rc}: {detail[:300]}")
    invalidate_status()


async def system_heartbeat(enabled: bool) -> None:
    """Enable or disable heartbeats live (gateway RPC)."""
    action = "enable" if enabled else "disable"
    rc, stdout, stderr = await _run(
        ["system", "heartbeat", action], settings.STATUS_TIMEOUT
    )
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip() or stdout.decode(
            "utf-8", "replace"
        ).strip()
        raise CliError(f"openclaw system heartbeat {action} exited {rc}: {detail[:300]}")
    invalidate_status()


async def cron_list() -> Any:
    return await run_json(["cron", "list", "--json"], settings.STATUS_TIMEOUT)


async def cron_set_enabled(job_id: str, enabled: bool) -> None:
    """Enable or disable a single cron job by id."""
    action = "enable" if enabled else "disable"
    rc, stdout, stderr = await _run(["cron", action, job_id], settings.SESSIONS_TIMEOUT)
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip() or stdout.decode(
            "utf-8", "replace"
        ).strip()
        raise CliError(f"openclaw cron {action} exited {rc}: {detail[:300]}")
    invalidate_status()


def _provider_of(model_key: str) -> str:
    """Provider prefix of a model key, e.g. ``anthropic/claude-x`` -> ``anthropic``."""
    return model_key.split("/", 1)[0] if "/" in model_key else ""


async def models_merged() -> dict[str, Any]:
    """Merge ``models list`` and ``models status`` into one view for the UI."""
    return await _models_cache.get(_load_models_merged)


async def _load_models_merged() -> dict[str, Any]:
    list_task = asyncio.create_task(models_list())
    status_task = asyncio.create_task(models_status())
    try:
        lst, st = await asyncio.gather(list_task, status_task)
    except BaseException:
        list_task.cancel()
        status_task.cancel()
        await asyncio.gather(list_task, status_task, return_exceptions=True)
        raise
    default = st.get("defaultModel")
    resolved = st.get("resolvedDefault") or default
    auth = st.get("auth") or {}
    models = []
    for m in lst.get("models", []):
        key = m.get("key") or ""
        models.append(
            {
                "key": key,
                "name": m.get("name") or key,
                "provider": _provider_of(key),
                "available": bool(m.get("available")),
                "missing": bool(m.get("missing")),
                "tags": m.get("tags") or [],
                "isDefault": key == default or key == resolved,
            }
        )
    return {
        "defaultModel": default,
        "resolvedDefault": resolved,
        "missingProvidersInUse": auth.get("missingProvidersInUse") or [],
        "providers": sorted({_provider_of(m["key"]) for m in models if m["key"]}),
        "models": models,
    }
