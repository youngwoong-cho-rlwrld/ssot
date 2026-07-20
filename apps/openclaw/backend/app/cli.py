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
from typing import Any, AsyncIterator, Optional

from . import settings

log = logging.getLogger("openclaw.cli")


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
        proc.kill()
        await proc.wait()
        raise CliError(f"openclaw {args[0] if args else ''} timed out after {timeout}s") from exc

    return proc.returncode or 0, stdout, stderr


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
    return await run_json(["status", "--json"], settings.STATUS_TIMEOUT)


async def sessions(limit: int = 100) -> Any:
    return await run_json(
        ["sessions", "--json", "--all-agents", "--limit", str(limit)],
        settings.SESSIONS_TIMEOUT,
    )


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
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()


async def agent_turn(message: str, session_key: Optional[str]) -> Any:
    """Run one local agent turn. Never passes --deliver/--channel."""
    args = ["agent", "--json", "-m", message]
    if session_key:
        args += ["--session-key", session_key]
    return await run_json(args, settings.CHAT_TIMEOUT)


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


# --- heartbeat & cron controls --------------------------------------------


async def config_set(path: str, value: str) -> None:
    """Set a config value by dotted path. Raises CliError on non-zero exit."""
    rc, stdout, stderr = await _run(["config", "set", path, value], settings.STATUS_TIMEOUT)
    if rc != 0:
        detail = stderr.decode("utf-8", "replace").strip() or stdout.decode(
            "utf-8", "replace"
        ).strip()
        raise CliError(f"openclaw config set exited {rc}: {detail[:300]}")


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


def _provider_of(model_key: str) -> str:
    """Provider prefix of a model key, e.g. ``anthropic/claude-x`` -> ``anthropic``."""
    return model_key.split("/", 1)[0] if "/" in model_key else ""


async def models_merged() -> dict[str, Any]:
    """Merge ``models list`` and ``models status`` into one view for the UI."""
    lst, st = await asyncio.gather(models_list(), models_status())
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
