"""Move a session file to the macOS Trash instead of unlinking it.

Deleting a session removes its on-disk ``.jsonl``. We move the file to
``~/.Trash`` rather than permanently unlinking, so an accidental delete of real
work history can be recovered from Finder; emptying the Trash makes it permanent.

A safety guard ensures only files under the known session roots can ever be
deleted, so a crafted uid/path can never trash arbitrary files.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

from . import settings


class DeleteNotAllowed(Exception):
    """Raised when a delete targets a path outside the allowed session roots."""


def _is_under_allowed_root(path: Path, allowed_roots: tuple[Path, ...]) -> bool:
    resolved = path.resolve()
    for root in allowed_roots:
        try:
            resolved.relative_to(root.resolve())
            return True
        except ValueError:
            continue
    return False


def move_to_trash(path: Path, allowed_roots: tuple[Path, ...]) -> Path:
    """Move ``path`` into ``~/.Trash`` and return the destination.

    ``allowed_roots`` are the session roots for the current request (which may be
    per-user gateway overrides); only files under one of them may be deleted.
    Raises ``DeleteNotAllowed`` if the path is outside the allowed session roots,
    and ``OSError`` if the move itself fails.
    """
    if not _is_under_allowed_root(path, allowed_roots):
        raise DeleteNotAllowed(f"refusing to delete path outside session roots: {path}")

    trash = settings.TRASH_DIR
    trash.mkdir(parents=True, exist_ok=True)

    dest = trash / path.name
    if dest.exists():
        # Avoid clobbering an existing trashed file of the same name.
        dest = trash / f"{path.stem}-{int(time.time())}{path.suffix}"

    shutil.move(str(path), str(dest))
    return dest
