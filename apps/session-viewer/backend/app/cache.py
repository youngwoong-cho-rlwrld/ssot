"""In-memory cache over the session sources.

Re-parsing every file on every request would be wasteful (hundreds of files), so
this module keeps:

- ``_meta`` : path -> (mtime, size, Session) for cheap metadata.
- ``_index``: uid -> path, so a detail request can locate its file.
- ``_detail``: path -> (mtime, SessionDetail) for parsed transcripts.

``scan_all()`` globs both sources and only re-parses files whose (mtime, size)
changed since last scan; unchanged files reuse the cached Session.

The scan roots are passed in per request (the gateway may override them per
user). Cache entries are keyed by absolute file path, so entries scanned from
different roots coexist without colliding; a scan only returns and only prunes
entries under the roots it was given.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable, Optional

from .models import Session, SessionDetail
from .sources import parse_claude_meta, parse_codex_meta
from .transcript import build_detail

# path -> (mtime, size, Session)
_meta: dict[str, tuple[float, int, Session]] = {}
# uid -> path
_index: dict[str, str] = {}
# path -> (mtime, SessionDetail)
_detail: dict[str, tuple[float, SessionDetail]] = {}

_lock = threading.Lock()


def _glob_claude(base: Path) -> list[Path]:
    return list(base.glob("*/*.jsonl")) if base.exists() else []


def _glob_codex(base: Path) -> list[Path]:
    return list(base.glob("**/*.jsonl")) if base.exists() else []


def _is_under(path: Path, roots: tuple[Path, ...]) -> bool:
    """True if ``path`` lives under any of ``roots`` (by resolved prefix)."""
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for root in roots:
        try:
            resolved.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False


def _scan_group(paths: list[Path], parser: Callable[[Path], Optional[Session]]) -> None:
    """Refresh ``_meta``/``_index`` for one source's paths in place."""
    for path in paths:
        key = str(path)
        try:
            st = path.stat()
        except OSError:
            continue
        cached = _meta.get(key)
        if cached is not None and cached[0] == st.st_mtime and cached[1] == st.st_size:
            # Unchanged: keep cached Session, just make sure the index points here.
            _index[cached[2].uid] = key
            continue
        sess = parser(path)
        if sess is None:
            continue
        _meta[key] = (st.st_mtime, st.st_size, sess)
        _index[sess.uid] = key


def scan_all(claude_root: Path, codex_root: Path) -> list[Session]:
    """Scan the given roots, re-parsing only changed files.

    Returns only the Sessions found under ``claude_root``/``codex_root`` for this
    call. Cache entries scanned from other roots are left untouched so listings
    for different users do not evict each other.
    """
    with _lock:
        claude_paths = _glob_claude(claude_root)
        codex_paths = _glob_codex(codex_root)

        live_keys = {str(p) for p in claude_paths} | {str(p) for p in codex_paths}

        _scan_group(claude_paths, parse_claude_meta)
        _scan_group(codex_paths, parse_codex_meta)

        # Drop entries for files that no longer exist, but only within the roots
        # scanned this call -- entries from other roots must survive.
        roots = (claude_root, codex_root)
        stale = [
            k
            for k in _meta
            if k not in live_keys and _is_under(Path(k), roots)
        ]
        for k in stale:
            uid = _meta[k][2].uid
            _meta.pop(k, None)
            _detail.pop(k, None)
            if _index.get(uid) == k:
                _index.pop(uid, None)

        return [_meta[k][2] for k in live_keys if k in _meta]


def get_session(uid: str, claude_root: Path, codex_root: Path) -> Optional[Session]:
    """Return the cached Session for a uid (scanning first if unknown)."""
    if uid not in _index:
        scan_all(claude_root, codex_root)
    with _lock:
        key = _index.get(uid)
        if key is None:
            return None
        entry = _meta.get(key)
        return entry[2] if entry else None


def get_detail(uid: str, claude_root: Path, codex_root: Path) -> Optional[SessionDetail]:
    """Return a SessionDetail for a uid, cached by (path, mtime)."""
    session = get_session(uid, claude_root, codex_root)
    if session is None:
        return None
    key = session.path
    try:
        mtime = Path(key).stat().st_mtime
    except OSError:
        mtime = -1.0
    with _lock:
        cached = _detail.get(key)
        if cached is not None and cached[0] == mtime:
            return cached[1]
    # Parse outside the lock (file IO can be slow); store result under the lock.
    detail = build_detail(session)
    with _lock:
        _detail[key] = (mtime, detail)
    return detail


def forget(uid: str) -> None:
    """Drop a uid and its file entry from all caches (e.g. after deletion)."""
    with _lock:
        key = _index.pop(uid, None)
        if key is not None:
            _meta.pop(key, None)
            _detail.pop(key, None)


def counts(claude_root: Path, codex_root: Path) -> dict[str, int]:
    """Return {claude, codex} session counts for the given roots."""
    sessions = scan_all(claude_root, codex_root)
    c = {"claude": 0, "codex": 0}
    for sess in sessions:
        if sess.agent in c:
            c[sess.agent] += 1
    return c
