"""Environment-driven settings for the openclaw backend.

Configuration is read from ``os.environ`` once at import time and exposed as
module-level constants. Env var names are part of the SSOT contract (see the
repo ``.env.example``); defaults keep the app working for local single-machine
use without any env set.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


def _expand(value: str) -> Path:
    """Expand ``~`` and environment variables in a path string."""
    return Path(os.path.expanduser(os.path.expandvars(value)))


# --- openclaw CLI ----------------------------------------------------------
# The `openclaw` CLI owns the gateway token and wraps every RPC; the backend
# only ever shells out to it (never touches ~/.openclaw/openclaw.json). When
# launched via nx/uvicorn the login shell PATH is not inherited, so Homebrew's
# bin dir must be on PATH for the binary to resolve.
_EXTRA_PATH = os.environ.get("OPENCLAW_EXTRA_PATH", "/opt/homebrew/bin:/usr/local/bin")
CONFIG_PATH: Path = _expand(
    os.environ.get("OPENCLAW_CONFIG_PATH", "~/.openclaw/openclaw.json")
).resolve()


def _gateway_credentials_from_config() -> dict[str, str]:
    """Read inline gateway credentials without exposing them in argv.

    OpenClaw's websocket control commands require explicit client credentials.
    Some CLI versions do not reuse ``gateway.auth`` consistently for those
    commands, so pass the configured secret through the child environment. A
    malformed file or a secret-reference object is left to the CLI to handle.
    """
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    auth = config.get("gateway", {}).get("auth", {})
    if not isinstance(auth, dict):
        return {}
    mode = auth.get("mode")
    key = "password" if mode == "password" else "token"
    value = auth.get(key)
    if not isinstance(value, str) or not value.strip():
        return {}
    env_key = (
        "OPENCLAW_GATEWAY_PASSWORD"
        if key == "password"
        else "OPENCLAW_GATEWAY_TOKEN"
    )
    return {env_key: value.strip()}


def subprocess_env() -> dict[str, str]:
    """Return a PATH- and gateway-auth-aware OpenClaw child environment."""
    env = dict(os.environ)
    existing = env.get("PATH", "")
    parts = [p for p in _EXTRA_PATH.split(os.pathsep) if p]
    parts += [p for p in existing.split(os.pathsep) if p and p not in parts]
    env["PATH"] = os.pathsep.join(parts)
    if not (
        env.get("OPENCLAW_GATEWAY_TOKEN") or env.get("OPENCLAW_GATEWAY_PASSWORD")
    ):
        env.update(_gateway_credentials_from_config())
    return env


def openclaw_bin() -> str:
    """Resolve the openclaw binary, honouring OPENCLAW_BIN and the augmented PATH."""
    explicit = os.environ.get("OPENCLAW_BIN")
    if explicit:
        return explicit
    found = shutil.which("openclaw", path=subprocess_env()["PATH"])
    return found or "openclaw"


# --- transcript source -----------------------------------------------------
# ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl holds the on-disk
# transcript (Claude Code record format).
AGENTS_ROOT: Path = _expand(
    os.environ.get("OPENCLAW_AGENTS_ROOT", "~/.openclaw/agents")
).resolve()

# Cron jobs run on the ``claude-cli`` runtime, which writes its transcript not to
# the OpenClaw sessions dir but to Claude Code's own project store, one JSONL per
# run named by Claude's session uuid (not the OpenClaw run id). The directory is
# ``<CLAUDE_PROJECTS_ROOT>/<slug>`` where ``<slug>`` is the run workspace path
# with every non-alphanumeric char replaced by ``-``. We resolve a cron session's
# latest run from here as a fallback (see transcript.resolve_by_key).
CLAUDE_PROJECTS_ROOT: Path = _expand(
    os.environ.get("OPENCLAW_CLAUDE_PROJECTS_ROOT", "~/.claude/projects")
).resolve()


# --- global instructions ---------------------------------------------------
# The gateway injects the workspace's AGENTS.md/SOUL.md/etc. into every agent
# turn's system prompt, read fresh each turn. The CLI reports the path via
# `openclaw config get agents.defaults.workspace`; the default mirrors it so the
# editor works without any env set.
WORKSPACE_ROOT: Path = _expand(
    os.environ.get("OPENCLAW_WORKSPACE_ROOT", "~/.openclaw/workspace")
).resolve()


# --- backend state ---------------------------------------------------------
# Small persisted state owned by this backend (not openclaw's). Currently holds
# the list of cron jobs the pause-all control disabled, so resume re-enables
# only those and leaves already-disabled jobs alone.
STATE_DIR: Path = _expand(
    os.environ.get("OPENCLAW_BACKEND_STATE_DIR", "~/.openclaw/portal-state")
).resolve()


# --- timeouts (seconds) ----------------------------------------------------
def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


STATUS_TIMEOUT: int = _int_env("OPENCLAW_STATUS_TIMEOUT", 15)
SESSIONS_TIMEOUT: int = _int_env("OPENCLAW_SESSIONS_TIMEOUT", 20)
LOGS_TIMEOUT: int = _int_env("OPENCLAW_LOGS_TIMEOUT", 20)
CHAT_TIMEOUT: int = _int_env("OPENCLAW_CHAT_TIMEOUT", 120)

# Byte cap passed to `openclaw logs`. The CLI enforces a hard max of 1000000.
LOGS_MAX_BYTES: int = min(_int_env("OPENCLAW_LOGS_MAX_BYTES", 1000000), 1000000)


# --- CORS ------------------------------------------------------------------
# Under the gateway everything is same-origin; these matter only for direct dev
# access to the backend. Defaults cover the Vite dev server on 5175.
_DEFAULT_CORS_ORIGINS = [
    "http://localhost:5175",
    "http://127.0.0.1:5175",
]
_extra_cors = [
    o.strip()
    for o in os.environ.get("OPENCLAW_CORS_ORIGINS", "").split(",")
    if o.strip()
]
CORS_ORIGINS: list[str] = _DEFAULT_CORS_ORIGINS + _extra_cors
