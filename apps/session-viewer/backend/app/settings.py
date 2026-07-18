"""Environment-driven settings for the session-viewer backend.

All configuration is read from ``os.environ`` exactly once at import time and
exposed as module-level constants. Stdlib only. Env var names are part of the
SSOT contract (see the repo ``.env.example``); defaults keep the app working for
local single-machine use without any env set.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Location of this package's directory (app/) and its parent (backend/), used to
# resolve paths relative to the source tree (e.g. the legacy board.json).
_APP_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _APP_DIR.parent


def _expand(value: str) -> Path:
    """Expand ``~`` and environment variables in a path string."""
    return Path(os.path.expanduser(os.path.expandvars(value)))


def expand_root(value: str) -> Path:
    """Expand a per-request root override (e.g. from a gateway header).

    Applies the same ``~``/env expansion used for the env-var roots so header
    overrides and env defaults are treated identically.
    """
    return _expand(value)


# --- session sources -------------------------------------------------------
CLAUDE_ROOT: Path = _expand(
    os.environ.get("SESSIONS_CLAUDE_ROOT", "~/.claude/projects")
)
CODEX_ROOT: Path = _expand(
    os.environ.get("SESSIONS_CODEX_ROOT", "~/.codex/sessions")
)


def _default_trash_dir() -> Path:
    """Platform default trash dir: ~/.Trash on macOS, XDG trash elsewhere."""
    if sys.platform == "darwin":
        return Path.home() / ".Trash"
    return Path.home() / ".local" / "share" / "Trash" / "files"


TRASH_DIR: Path = (
    _expand(os.environ["SESSIONS_TRASH_DIR"])
    if os.environ.get("SESSIONS_TRASH_DIR")
    else _default_trash_dir()
)


# --- CORS -------------------------------------------------------------------
# Under the gateway everything is same-origin; these matter only for direct dev
# access to the backend. Defaults cover the Vite dev server on 5174.
_DEFAULT_CORS_ORIGINS = [
    "http://localhost:5174",
    "http://127.0.0.1:5174",
]
_extra_cors = [
    o.strip()
    for o in os.environ.get("SESSIONS_CORS_ORIGINS", "").split(",")
    if o.strip()
]
CORS_ORIGINS: list[str] = _DEFAULT_CORS_ORIGINS + _extra_cors


# --- persistence ------------------------------------------------------------
# SSOT-wide SQLite database, shared across apps. This app namespaces its tables.
DATA_DIR: Path = _expand(os.environ.get("SSOT_DATA_DIR", "~/.ssot"))
DB_PATH: Path = DATA_DIR / "ssot.db"

# One-time migration source: the legacy per-app board.json, historically at
# backend/board.json next to the app/ package.
LEGACY_BOARD_JSON: Path = (
    _expand(os.environ["SESSIONS_LEGACY_BOARD_JSON"])
    if os.environ.get("SESSIONS_LEGACY_BOARD_JSON")
    else _BACKEND_DIR / "board.json"
)
