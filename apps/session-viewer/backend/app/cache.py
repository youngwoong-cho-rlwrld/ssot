"""Fast, root-scoped metadata snapshots for session sources.

Session transcripts can be very large, so filesystem discovery and JSONL parsing
must never happen while holding request-shared state locks.  This module keeps an
immutable snapshot per pair of source roots and refreshes those snapshots on a
small, dedicated executor.  Warm list requests only copy the current snapshot;
they never wait for a scan.

Parsed metadata is also persisted in the SSOT SQLite database using a full stat
fingerprint.  A process restart can therefore rebuild its in-memory snapshot by
stat'ing files and decoding small cached Session objects instead of re-reading
gigabytes of transcripts.  New and changed files are parsed in size order and
published in batches so a first-time index becomes useful progressively.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from . import settings
from .models import Session, SessionDetail
from .sources import active_window, parse_claude_meta, parse_codex_meta
from .transcript import build_detail

log = logging.getLogger("session_board.cache")

REFRESH_MAX_AGE_SECONDS = 10.0
# The table suffix is the parser schema version. Bump it whenever Session
# extraction semantics change so old rows cannot silently survive a deploy.
_PERSIST_TABLE = "session_metadata_cache_v2"
_PUBLISH_BATCH_SIZE = 24

RootKey = tuple[str, str]
Parser = Callable[[Path], Optional[Session]]


@dataclass(frozen=True)
class _Fingerprint:
    device: int
    inode: int
    mtime_ns: int
    size: int


@dataclass(frozen=True)
class _Candidate:
    path: Path
    parser: Parser
    fingerprint: _Fingerprint


@dataclass(frozen=True)
class _Snapshot:
    sessions: tuple[Session, ...]
    by_uid: dict[str, Session]
    refreshed_at: float
    complete: bool


# All of these maps are protected by _lock.  The lock is deliberately only used
# for in-memory reads/swaps; no glob, stat, parsing, or SQLite work happens under
# it.
_meta: dict[str, tuple[_Fingerprint, Session]] = {}
_detail: dict[str, tuple[_Fingerprint, SessionDetail]] = {}
_snapshots: dict[RootKey, _Snapshot] = {}
_scan_locks: dict[RootKey, threading.Lock] = {}
_refreshing: set[RootKey] = set()
_tombstones: dict[RootKey, dict[str, Optional[_Fingerprint]]] = {}
_lock = threading.RLock()

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="session-index")
_persistence_enabled = True
_persistence_init_lock = threading.Lock()
_initialized_db_path: Optional[str] = None


def _root_key(claude_root: Path, codex_root: Path) -> RootKey:
    return (str(claude_root.resolve()), str(codex_root.resolve()))


def _get_scan_lock(key: RootKey) -> threading.Lock:
    with _lock:
        scan_lock = _scan_locks.get(key)
        if scan_lock is None:
            scan_lock = threading.Lock()
            _scan_locks[key] = scan_lock
        return scan_lock


def _fingerprint(path: Path) -> Optional[_Fingerprint]:
    try:
        stat = path.stat()
    except OSError:
        return None
    return _Fingerprint(
        device=stat.st_dev,
        inode=stat.st_ino,
        mtime_ns=stat.st_mtime_ns,
        size=stat.st_size,
    )


def _candidates(claude_root: Path, codex_root: Path) -> list[_Candidate]:
    discovered: dict[str, tuple[Path, Parser]] = {}
    if claude_root.exists():
        for path in claude_root.glob("*/*.jsonl"):
            resolved = path.resolve()
            discovered[str(resolved)] = (resolved, parse_claude_meta)
    if codex_root.exists():
        for path in codex_root.glob("**/*.jsonl"):
            resolved = path.resolve()
            discovered[str(resolved)] = (resolved, parse_codex_meta)

    candidates: list[_Candidate] = []
    for path, parser in discovered.values():
        fingerprint = _fingerprint(path)
        if fingerprint is not None:
            candidates.append(_Candidate(path, parser, fingerprint))

    # On a brand-new cache, make the common small transcripts visible first.
    candidates.sort(key=lambda item: (item.fingerprint.size, str(item.path)))
    return candidates


def _open_connection() -> sqlite3.Connection:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(settings.DB_PATH, timeout=5)
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def _ensure_persistence() -> None:
    global _initialized_db_path
    db_path = str(settings.DB_PATH.resolve())
    if _initialized_db_path == db_path:
        return
    with _persistence_init_lock:
        if _initialized_db_path == db_path:
            return
        connection = _open_connection()
        try:
            # WAL changes journal mode and belongs in initialization, not every
            # read connection where it can contend with board traffic.
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {_PERSIST_TABLE} (
                    path TEXT PRIMARY KEY,
                    device INTEGER NOT NULL,
                    inode INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    session_json TEXT NOT NULL
                )
                """
            )
            connection.commit()
        finally:
            connection.close()
        _initialized_db_path = db_path


def _connect() -> sqlite3.Connection:
    _ensure_persistence()
    return _open_connection()


def _load_persisted(paths: list[str]) -> dict[str, tuple[_Fingerprint, Session]]:
    if not _persistence_enabled or not paths:
        return {}
    result: dict[str, tuple[_Fingerprint, Session]] = {}
    try:
        connection = _connect()
        try:
            # Stay below SQLite's parameter limit on older builds.
            for offset in range(0, len(paths), 400):
                chunk = paths[offset : offset + 400]
                placeholders = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    f"SELECT path, device, inode, mtime_ns, size, session_json "
                    f"FROM {_PERSIST_TABLE} WHERE path IN ({placeholders})",
                    chunk,
                ).fetchall()
                for path, device, inode, mtime_ns, size, raw_session in rows:
                    try:
                        session = Session.model_validate_json(raw_session)
                    except Exception:  # noqa: BLE001 - a bad row is a cache miss
                        continue
                    result[path] = (
                        _Fingerprint(device, inode, mtime_ns, size),
                        session,
                    )
        finally:
            connection.close()
    except sqlite3.Error as exc:
        log.warning("could not read persistent session metadata: %s", exc)
    return result


def _store_persisted(entries: list[tuple[str, _Fingerprint, Session]]) -> None:
    if not _persistence_enabled or not entries:
        return
    try:
        connection = _connect()
        try:
            connection.executemany(
                f"INSERT INTO {_PERSIST_TABLE} "
                "(path, device, inode, mtime_ns, size, session_json) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET "
                "device=excluded.device, inode=excluded.inode, "
                "mtime_ns=excluded.mtime_ns, size=excluded.size, "
                "session_json=excluded.session_json",
                [
                    (
                        path,
                        fingerprint.device,
                        fingerprint.inode,
                        fingerprint.mtime_ns,
                        fingerprint.size,
                        session.model_dump_json(),
                    )
                    for path, fingerprint, session in entries
                ],
            )
            connection.commit()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        log.warning("could not persist session metadata: %s", exc)


def _delete_persisted(paths: list[str]) -> None:
    if not _persistence_enabled or not paths:
        return
    try:
        connection = _connect()
        try:
            connection.executemany(
                f"DELETE FROM {_PERSIST_TABLE} WHERE path = ?",
                [(path,) for path in paths],
            )
            connection.commit()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        log.warning("could not invalidate persistent session metadata: %s", exc)


def _with_current_active(session: Session, fingerprint: _Fingerprint) -> Session:
    active = (time.time_ns() - fingerprint.mtime_ns) <= active_window() * 1_000_000_000
    if session.active == active:
        return session
    return session.model_copy(update={"active": active})


def _publish(
    key: RootKey,
    sessions_by_path: dict[str, Session],
    *,
    complete: bool,
) -> _Snapshot:
    with _lock:
        tombstones = _tombstones.get(key, {})
        sessions = tuple(
            session
            for path, session in sessions_by_path.items()
            if path not in tombstones
        )
        snapshot = _Snapshot(
            sessions=sessions,
            by_uid={session.uid: session for session in sessions},
            refreshed_at=time.monotonic(),
            complete=complete,
        )
        _snapshots[key] = snapshot
    return snapshot


def prime(claude_root: Path, codex_root: Path) -> list[Session]:
    """Build a snapshot from memory/disk metadata and refresh misses in back.

    This function performs directory and SQLite metadata work, but never parses
    a transcript.  It is safe to use during startup and for the first listing.
    """
    key = _root_key(claude_root, codex_root)
    with _lock:
        existing = _snapshots.get(key)
    if existing is not None:
        return list(existing.sessions)

    scan_lock = _get_scan_lock(key)
    with scan_lock:
        with _lock:
            existing = _snapshots.get(key)
            memory = dict(_meta)
        if existing is not None:
            return list(existing.sessions)

        candidates = _candidates(claude_root, codex_root)
        persisted = _load_persisted([str(item.path) for item in candidates])
        sessions_by_path: dict[str, Session] = {}
        exact = True
        memory_updates: dict[str, tuple[_Fingerprint, Session]] = {}

        for item in candidates:
            path = str(item.path)
            cached = memory.get(path) or persisted.get(path)
            if cached is None:
                exact = False
                continue
            cached_fingerprint, session = cached
            sessions_by_path[path] = _with_current_active(session, item.fingerprint)
            if cached_fingerprint == item.fingerprint:
                memory_updates[path] = (item.fingerprint, sessions_by_path[path])
            else:
                exact = False

        with _lock:
            _meta.update(memory_updates)
        snapshot = _publish(key, sessions_by_path, complete=exact)

    # Even an exact snapshot may become stale later; list_all applies the age
    # threshold.  An incomplete one begins indexing immediately.
    if not snapshot.complete:
        _schedule_refresh(claude_root, codex_root)
    return list(snapshot.sessions)


def _refresh_root(claude_root: Path, codex_root: Path) -> list[Session]:
    key = _root_key(claude_root, codex_root)
    scan_lock = _get_scan_lock(key)
    with scan_lock:
        candidates = _candidates(claude_root, codex_root)
        live_paths = {str(item.path) for item in candidates}

        with _lock:
            tombstones = _tombstones.setdefault(key, {})
            # A newly created file at a formerly deleted path has a different
            # identity and may legitimately enter a later snapshot.
            for item in candidates:
                path = str(item.path)
                deleted_fingerprint = tombstones.get(path)
                if (
                    path in tombstones
                    and (
                        deleted_fingerprint is None
                        or deleted_fingerprint != item.fingerprint
                    )
                ):
                    tombstones.pop(path, None)
            active_tombstones = set(tombstones)
            memory = dict(_meta)
            current = _snapshots.get(key)

        candidates = [
            item for item in candidates if str(item.path) not in active_tombstones
        ]
        live_paths.difference_update(active_tombstones)

        persisted = _load_persisted([str(item.path) for item in candidates])
        sessions_by_path = {
            session.path: session
            for session in (current.sessions if current is not None else ())
            if session.path in live_paths
        }
        for path, (_, session) in persisted.items():
            if path in live_paths and path not in sessions_by_path:
                sessions_by_path[path] = session

        # Publish removals and any disk-backed starting point before parsing.
        _publish(key, sessions_by_path, complete=False)
        pending_persistence: list[tuple[str, _Fingerprint, Session]] = []
        changed_since_publish = 0

        for item in candidates:
            path = str(item.path)
            cached = memory.get(path) or persisted.get(path)
            if cached is not None and cached[0] == item.fingerprint:
                session = _with_current_active(cached[1], item.fingerprint)
                sessions_by_path[path] = session
                with _lock:
                    _meta[path] = (item.fingerprint, session)
                continue

            session = item.parser(item.path)
            if session is None:
                # A transient parse failure must not erase last-known-good
                # metadata or bless the changed fingerprint.
                changed_since_publish += 1
                continue

            # Only mark a parse reusable if the file did not change while it
            # was being read.  Active files get another pass on the next cycle.
            after = _fingerprint(item.path)
            if after is None:
                sessions_by_path.pop(path, None)
                changed_since_publish += 1
                continue
            if after != item.fingerprint:
                # The parser raced an append. Keep the previous object and retry
                # instead of publishing a transcript/fingerprint mismatch.
                changed_since_publish += 1
                continue
            session = _with_current_active(session, after)
            sessions_by_path[path] = session
            changed_since_publish += 1
            with _lock:
                _meta[path] = (item.fingerprint, session)
            memory[path] = (item.fingerprint, session)
            pending_persistence.append((path, item.fingerprint, session))

            if changed_since_publish >= _PUBLISH_BATCH_SIZE:
                _store_persisted(pending_persistence)
                pending_persistence.clear()
                _publish(key, sessions_by_path, complete=False)
                changed_since_publish = 0

        _store_persisted(pending_persistence)
        return list(_publish(key, sessions_by_path, complete=True).sessions)


def scan_all(claude_root: Path, codex_root: Path) -> list[Session]:
    """Synchronously refresh and return an exact snapshot.

    Cleanup uses this exact operation.  Normal list/health requests use
    list_all(), which never waits behind this work once a snapshot exists.
    """
    return _refresh_root(claude_root, codex_root)


def _schedule_refresh(claude_root: Path, codex_root: Path) -> None:
    key = _root_key(claude_root, codex_root)
    with _lock:
        if key in _refreshing:
            return
        _refreshing.add(key)

    def run() -> None:
        try:
            _refresh_root(claude_root, codex_root)
        except Exception as exc:  # noqa: BLE001 - retain last good snapshot
            log.warning("session metadata refresh failed for %s: %s", key, exc)
        finally:
            with _lock:
                _refreshing.discard(key)

    try:
        _executor.submit(run)
    except RuntimeError:
        # Interpreter shutdown can race a final request.
        with _lock:
            _refreshing.discard(key)


def list_all(claude_root: Path, codex_root: Path) -> list[Session]:
    """Return the latest root-scoped snapshot without waiting for a refresh."""
    key = _root_key(claude_root, codex_root)
    with _lock:
        snapshot = _snapshots.get(key)

    if snapshot is None:
        sessions = prime(claude_root, codex_root)
        with _lock:
            snapshot = _snapshots.get(key)
        if snapshot is None:
            return sessions

    if time.monotonic() - snapshot.refreshed_at >= REFRESH_MAX_AGE_SECONDS:
        _schedule_refresh(claude_root, codex_root)
    return list(snapshot.sessions)


def get_session(uid: str, claude_root: Path, codex_root: Path) -> Optional[Session]:
    """Resolve a uid only within the requested roots."""
    key = _root_key(claude_root, codex_root)
    with _lock:
        snapshot = _snapshots.get(key)
    if snapshot is None:
        prime(claude_root, codex_root)
        with _lock:
            snapshot = _snapshots.get(key)
    return snapshot.by_uid.get(uid) if snapshot is not None else None


def get_detail(uid: str, claude_root: Path, codex_root: Path) -> Optional[SessionDetail]:
    """Return a SessionDetail cached by the file's full stat fingerprint."""
    session = get_session(uid, claude_root, codex_root)
    if session is None:
        return None
    fingerprint = _fingerprint(Path(session.path))
    if fingerprint is None:
        return None
    with _lock:
        cached = _detail.get(session.path)
        if cached is not None and cached[0] == fingerprint:
            return cached[1]
    detail = build_detail(session)
    with _lock:
        _detail[session.path] = (fingerprint, detail)
    return detail


def forget(
    uid: str,
    claude_root: Optional[Path] = None,
    codex_root: Optional[Path] = None,
) -> None:
    """Drop a root-scoped uid's exact path from every overlapping snapshot."""
    requested_key = (
        _root_key(claude_root, codex_root)
        if claude_root is not None and codex_root is not None
        else None
    )

    # First resolve the uid within the requested scope. The same uid may point
    # at a different file for another user/root and must not be removed there.
    with _lock:
        lookup_keys = [requested_key] if requested_key is not None else list(_snapshots)
        target_paths = {
            snapshot.by_uid[uid].path
            for key in lookup_keys
            if (snapshot := _snapshots.get(key)) is not None
            and uid in snapshot.by_uid
        }
        fingerprints = {
            path: _meta[path][0]
            for path in target_paths
            if path in _meta
        }

    missing = [path for path in target_paths if path not in fingerprints]
    persisted = _load_persisted(missing)
    for path, (fingerprint, _) in persisted.items():
        fingerprints[path] = fingerprint

    with _lock:
        for key, snapshot in list(_snapshots.items()):
            removed_from_snapshot = [
                session.path
                for session in snapshot.sessions
                if session.path in target_paths
            ]
            if not removed_from_snapshot:
                continue
            for path in removed_from_snapshot:
                _tombstones.setdefault(key, {})[path] = fingerprints.get(path)
            remaining = {
                session.path: session
                for session in snapshot.sessions
                if session.path not in target_paths
            }
            sessions = tuple(remaining.values())
            _snapshots[key] = _Snapshot(
                sessions=sessions,
                by_uid={session.uid: session for session in sessions},
                refreshed_at=time.monotonic(),
                complete=snapshot.complete,
            )

        for path in target_paths:
            _meta.pop(path, None)
            _detail.pop(path, None)

    _delete_persisted(list(target_paths))


def counts(claude_root: Path, codex_root: Path) -> dict[str, int]:
    """Return cached source counts without waiting for filesystem parsing."""
    counts_by_agent = {"claude": 0, "codex": 0}
    for session in list_all(claude_root, codex_root):
        if session.agent in counts_by_agent:
            counts_by_agent[session.agent] += 1
    return counts_by_agent


def reset_for_tests(*, persistence: bool = False) -> None:
    """Clear process state and configure persistence for isolated tests."""
    global _initialized_db_path, _persistence_enabled
    with _lock:
        _meta.clear()
        _detail.clear()
        _snapshots.clear()
        _scan_locks.clear()
        _refreshing.clear()
        _tombstones.clear()
        _persistence_enabled = persistence
    with _persistence_init_lock:
        _initialized_db_path = None
