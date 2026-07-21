"""Discover and remove groups of disposable coding-agent sessions.

Cleanup deliberately relies on metadata the agent CLIs already write:

- ``system``: SDK-originated Claude cron runs (or Codex exec runs) carrying the
  existing ``cron:`` marker.
- ``old``: transcript files whose mtime is more than 14 days old.
- ``short``: sessions with fewer than 10 parsed chat messages.

Counts and deletion targets use the same uid identity as dashboard cards.
Cleanup permanently removes selected files after applying the same source-root
safety guard used by single-session deletion.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal, Optional

from . import board_store, cache
from .sources import _claude_text_from_content, _codex_text_from_content, _iter_records
from .trash import DeleteNotAllowed, delete_permanently

log = logging.getLogger("session_board.cleanup")

CleanupCategory = Literal["system", "old", "short"]
CATEGORIES: tuple[CleanupCategory, ...] = ("system", "old", "short")
OLD_SECONDS = 14 * 24 * 60 * 60

# path -> ((device, inode, mtime_ns, size), intrinsic categories). Old age is
# deliberately derived at request time rather than cached.
_category_cache: dict[str, tuple[tuple[int, int, int, int], frozenset[CleanupCategory]]] = {}
_category_lock = threading.Lock()


@dataclass(frozen=True)
class CleanupCandidate:
    path: Path
    categories: frozenset[CleanupCategory]
    uid: Optional[str] = None


@dataclass(frozen=True)
class CleanupSummary:
    counts: dict[CleanupCategory, int]
    affected: int
    affected_uids: tuple[str, ...]


@dataclass(frozen=True)
class CleanupOutcome:
    affected: int
    deleted: int
    failed: int


def _is_old(path: Path, now: float) -> bool:
    try:
        return now - path.stat().st_mtime > OLD_SECONDS
    except OSError:
        return False


def _claude_categories(path: Path) -> set[CleanupCategory]:
    categories: set[CleanupCategory] = set()
    try:
        for rec in _iter_records(path):
            if rec.get("type") != "user":
                continue
            message = rec.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            text = _claude_text_from_content(content)
            if (
                rec.get("entrypoint") == "sdk-cli"
                and rec.get("promptSource") == "sdk"
                and "cron:" in text.lower()
            ):
                categories.add("system")
            # Origin, sidechain, and cron markers are established by the first
            # user record and stay fixed for the lifetime of the session.
            break
    except OSError:
        return categories
    return categories


def _codex_categories(path: Path) -> set[CleanupCategory]:
    categories: set[CleanupCategory] = set()
    exec_origin = False
    cron_marker = False
    try:
        for rec in _iter_records(path):
            payload = rec.get("payload")
            if not isinstance(payload, dict):
                continue
            if rec.get("type") == "session_meta":
                source = payload.get("source")
                exec_origin = exec_origin or source == "exec"
                continue
            if (
                rec.get("type") == "response_item"
                and payload.get("type") == "message"
                and payload.get("role") == "user"
            ):
                text = _codex_text_from_content(payload.get("content"))
                cron_marker = "cron:" in text.lower()
                break
            if rec.get("type") == "event_msg" and payload.get("type") == "user_message":
                message = payload.get("message")
                cron_marker = isinstance(message, str) and "cron:" in message.lower()
                break
    except OSError:
        return categories
    if exec_origin and cron_marker:
        categories.add("system")
    return categories


def _classification_fingerprint(path: Path) -> Optional[tuple[int, int, int, int]]:
    try:
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size)


def _cached_categories(path: Path, agent: str) -> set[CleanupCategory]:
    resolved = str(path.resolve())
    before = _classification_fingerprint(path)
    if before is None:
        return set()
    with _category_lock:
        cached = _category_cache.get(resolved)
    if cached is not None and cached[0] == before:
        return set(cached[1])

    if agent == "claude":
        categories = _claude_categories(path)
    elif agent == "codex":
        categories = _codex_categories(path)
    else:
        categories = set()
    after = _classification_fingerprint(path)
    if after == before:
        with _category_lock:
            _category_cache[resolved] = (before, frozenset(categories))
    return categories


def discover(
    claude_root: Path,
    codex_root: Path,
    *,
    exact: bool = True,
    openclaw_root: Optional[Path] = None,
) -> list[CleanupCandidate]:
    """Return cleanup candidates keyed exactly like dashboard cards."""
    now = time.time()
    candidates: dict[str, CleanupCandidate] = {}

    sessions = (
        cache.scan_all(claude_root, codex_root, openclaw_root)
        if exact
        else cache.list_all(claude_root, codex_root, openclaw_root)
    )
    for session in sessions:
        # OpenClaw owns additional session indexes and trajectory sidecars.
        # Session Viewer exposes those sessions read-only instead of partially
        # deleting their primary JSONL file.
        if session.agent == "openclaw":
            continue
        path = Path(session.path)
        categories = _cached_categories(path, session.agent)
        if _is_old(path, now):
            categories.add("old")
        if session.message_count < 10:
            categories.add("short")
        if categories:
            # React Flow cards are keyed by uid. Using the same identity here
            # keeps option counts, highlights, and destructive targets aligned.
            candidates[session.uid] = CleanupCandidate(
                path=path,
                categories=frozenset(categories),
                uid=session.uid,
            )

    return list(candidates.values())


def summarize(
    candidates: Iterable[CleanupCandidate],
    selected: Iterable[CleanupCategory],
) -> CleanupSummary:
    rows = list(candidates)
    selected_set = set(selected)
    counts = {
        category: sum(category in candidate.categories for candidate in rows)
        for category in CATEGORIES
    }
    matched = [candidate for candidate in rows if candidate.categories & selected_set]
    affected_uids = tuple(
        sorted(candidate.uid for candidate in matched if candidate.uid is not None)
    )
    return CleanupSummary(
        counts=counts,
        affected=len(matched),
        affected_uids=affected_uids,
    )


def clean(
    claude_root: Path,
    codex_root: Path,
    selected: Iterable[CleanupCategory],
    affected_uids: Iterable[str],
    *,
    openclaw_root: Optional[Path] = None,
) -> CleanupOutcome:
    """Permanently delete the previewed card union and clear references.

    The client sends the exact card uids returned by the preview. Rechecking
    both uid and category against the current non-blocking snapshot prevents a
    later full scan from silently expanding the destructive target set.
    """
    selected_set = set(selected)
    requested_uids = set(affected_uids)
    targets = [
        candidate
        for candidate in discover(
            claude_root,
            codex_root,
            exact=False,
            openclaw_root=openclaw_root,
        )
        if candidate.uid in requested_uids
        and candidate.categories & selected_set
    ]
    deleted = 0
    failed = 0

    for candidate in targets:
        try:
            delete_permanently(
                candidate.path,
                allowed_roots=tuple(
                    root
                    for root in (claude_root, codex_root, openclaw_root)
                    if root is not None
                ),
            )
        except (DeleteNotAllowed, OSError) as exc:
            failed += 1
            log.warning("cleanup failed for %s: %s", candidate.path, exc)
            continue

        deleted += 1
        if candidate.uid:
            cache.forget(candidate.uid, claude_root, codex_root, openclaw_root)
            try:
                board_store.delete(candidate.uid)
            except Exception as exc:  # noqa: BLE001 - file is already deleted
                log.warning("failed to remove board node %s: %s", candidate.uid, exc)

    return CleanupOutcome(affected=len(targets), deleted=deleted, failed=failed)
