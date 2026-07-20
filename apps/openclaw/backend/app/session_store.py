"""Delete a session by editing the agent's on-disk ``sessions.json``.

OpenClaw has no CLI to delete a session, so we edit the store directly:
``<AGENTS_ROOT>/<agentId>/sessions/sessions.json`` is a dict keyed by
session-key, each value carrying the ``sessionId``. Deleting a session means
removing that key (atomic read-modify-write) and unlinking the transcript files
named ``<sessionId>.*`` in the same directory.

The gateway reads ``sessions.json`` on demand, so the change takes effect
immediately. We refuse to delete a session that looks active (updated within
``ACTIVE_WINDOW_MS`` or still running) unless ``force`` is set, because the
gateway may rewrite the entry for a running session mid-delete.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from . import settings

log = logging.getLogger("openclaw.session_store")

# Matches the frontend's "active" heuristic (util.ts ACTIVE_WINDOW_MS).
ACTIVE_WINDOW_MS = 5 * 60 * 1000


class SessionNotFound(Exception):
    """No session with the given id in this agent's store."""


class SessionActive(Exception):
    """Session looks active; refuse to delete unless forced."""


def _store_path(agent_id: str) -> Path:
    path = (settings.AGENTS_ROOT / agent_id / "sessions" / "sessions.json").resolve()
    if not path.is_relative_to(settings.AGENTS_ROOT):
        raise SessionNotFound("path traversal rejected")
    return path


def _looks_active(entry: dict) -> bool:
    if entry.get("status") == "running":
        return True
    updated = entry.get("updatedAt") or entry.get("lastInteractionAt")
    if isinstance(updated, (int, float)):
        return (time.time() * 1000 - updated) < ACTIVE_WINDOW_MS
    return False


def delete_session(agent_id: str, session_id: str, force: bool = False) -> dict:
    """Remove the session with ``session_id`` from ``agent_id``'s store.

    Returns a summary dict. Raises ``SessionNotFound`` if the session or store
    is missing, or ``SessionActive`` if it looks active and ``force`` is False.
    """
    store = _store_path(agent_id)
    if not store.is_file():
        raise SessionNotFound(f"no session store for agent {agent_id!r}")

    with store.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise SessionNotFound("session store is not a mapping")

    match_key = None
    for key, entry in data.items():
        if isinstance(entry, dict) and entry.get("sessionId") == session_id:
            match_key = key
            break
    if match_key is None:
        raise SessionNotFound(f"no session with id {session_id!r}")

    if not force and _looks_active(data[match_key]):
        raise SessionActive(f"session {session_id!r} looks active; use force to delete")

    del data[match_key]

    # Atomic replace so a concurrent gateway read never sees a half-written file.
    tmp = store.with_name(store.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, store)

    # Unlink the transcript files for this session (<sessionId>.*). The id charset
    # is validated by the caller, so it carries no glob metacharacters.
    removed: list[str] = []
    sessions_dir = store.parent
    for path in sessions_dir.glob(f"{session_id}.*"):
        try:
            path.unlink()
            removed.append(path.name)
        except OSError as exc:
            log.warning("failed to unlink %s: %s", path, exc)

    return {"deleted": True, "session_key": match_key, "files_removed": removed}
