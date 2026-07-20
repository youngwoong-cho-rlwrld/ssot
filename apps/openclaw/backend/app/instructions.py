"""Read/write the global instruction files injected into every agent turn.

The gateway injects a fixed set of workspace files (AGENTS.md, SOUL.md, …) into
each agent turn's system prompt, read fresh every turn, so an edit here applies
from the next turn with no restart. Only the whitelisted names are ever touched;
the resolved path is confirmed to stay under ``WORKSPACE_ROOT`` as defence in
depth on top of the exact-name check (the workspace dir also holds .git/,
memory/, state/ and other files that must never be reachable).

Writes are atomic (temp file + ``os.replace``) and keep a single ``<name>.bak``
snapshot of the previous version.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel

from . import settings

# Exactly the files the gateway injects — nothing else is editable.
WHITELIST: tuple[str, ...] = (
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
)

# Refuse absurdly large writes; these are prompt files, not blobs.
MAX_BYTES = 512 * 1024


class InstructionSave(BaseModel):
    """PUT body: the full new contents of an instruction file."""

    content: str


class InvalidName(ValueError):
    """Requested a name outside the whitelist (surfaced to the client as 400)."""


def _resolve(name: str) -> Path:
    """Map a whitelisted file name to its path, rejecting anything else."""
    if name not in WHITELIST:
        raise InvalidName(f"unknown instruction file: {name!r}")
    path = (settings.WORKSPACE_ROOT / name).resolve()
    # The exact-name check already forbids separators, but confirm containment
    # in case WORKSPACE_ROOT is a symlink into an unexpected place.
    if path.parent != settings.WORKSPACE_ROOT:
        raise InvalidName(f"resolved path escapes workspace: {name!r}")
    return path


def _iso_mtime(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except OSError:
        return None


def _meta(name: str, path: Path) -> dict[str, object]:
    exists = path.is_file()
    return {
        "name": name,
        "exists": exists,
        "size": path.stat().st_size if exists else 0,
        "mtime": _iso_mtime(path) if exists else None,
    }


def list_files() -> dict[str, object]:
    """List the whitelisted instruction files with size/mtime metadata."""
    files = [_meta(name, _resolve(name)) for name in WHITELIST]
    return {"workspace": str(settings.WORKSPACE_ROOT), "files": files}


def read_file(name: str) -> dict[str, object]:
    """Return a single instruction file's content plus metadata.

    A missing whitelisted file is not an error: it is reported as empty content
    with ``exists=False`` so the editor can create it on first save.
    """
    path = _resolve(name)
    meta = _meta(name, path)
    content = ""
    if path.is_file():
        content = path.read_text(encoding="utf-8", errors="replace")
    meta["content"] = content
    return meta


def write_file(name: str, content: str) -> dict[str, object]:
    """Atomically write an instruction file, snapshotting the prior version.

    Backs up the current contents to ``<name>.bak`` (single generation), then
    writes ``content`` to a temp file in the same directory and ``os.replace``\\s
    it over the target so a reader never sees a half-written file.
    """
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise InvalidName(f"content exceeds {MAX_BYTES} bytes")

    path = _resolve(name)
    backed_up = False
    if path.is_file():
        bak = path.with_name(path.name + ".bak")
        bak.write_bytes(path.read_bytes())
        backed_up = True

    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)

    meta = _meta(name, path)
    meta["backed_up"] = backed_up
    return meta
