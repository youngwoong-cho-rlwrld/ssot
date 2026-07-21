"""FastAPI app for session-board.

Serves session metadata, full transcripts, and the whiteboard board store. See
``README.md`` for the run command and endpoint list.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import board_store, cache, cleanup as cleanup_service, settings
from .models import BoardNode, Session, SessionDetail
from .trash import DeleteNotAllowed, move_to_trash

logging.basicConfig(level=logging.INFO)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Rehydrate small persisted metadata and let the dedicated indexer handle
    # changed transcripts. Startup never parses the source corpus.
    try:
        cache.prime(
            settings.CLAUDE_ROOT,
            settings.CODEX_ROOT,
            settings.OPENCLAW_ROOT,
        )
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("session_board").warning("startup scan failed: %s", exc)
    yield


app = FastAPI(title="session-board backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class HealthCounts(BaseModel):
    claude: int
    codex: int
    openclaw: int


class Health(BaseModel):
    status: str
    counts: HealthCounts


class BoardUpdate(BaseModel):
    """Partial board-node update body. All fields optional."""

    x: Optional[float] = None
    y: Optional[float] = None
    color: Optional[str] = None
    starred: Optional[bool] = None
    note: Optional[str] = None


class DeleteResult(BaseModel):
    status: str
    uid: str
    trashed_to: str


class CleanupCounts(BaseModel):
    system: int
    old: int
    short: int


class CleanupPreview(BaseModel):
    counts: CleanupCounts
    affected: int
    affected_uids: list[str]


class CleanupSelection(BaseModel):
    categories: list[cleanup_service.CleanupCategory]
    affected_uids: list[str] = Field(max_length=10_000)


class CleanupResult(BaseModel):
    status: str
    affected: int
    deleted: int
    failed: int


# ---------------------------------------------------------------------------
# Per-request scan roots
# ---------------------------------------------------------------------------


def resolve_roots(
    x_ssot_sessions_claude_root: Optional[str] = Header(default=None),
    x_ssot_sessions_codex_root: Optional[str] = Header(default=None),
    x_ssot_sessions_openclaw_root: Optional[str] = Header(default=None),
) -> tuple[Path, Path, Path]:
    """Resolve the Claude, Codex, and OpenClaw roots for this request.

    The gateway injects per-user override headers (trusted; the backend binds to
    localhost and direct exposure is unsupported). When a header is absent, fall
    back to the env-configured default from ``settings``. Header values get the
    same ``~``/env expansion as the env defaults.
    """
    claude_root = (
        settings.expand_root(x_ssot_sessions_claude_root)
        if x_ssot_sessions_claude_root
        else settings.CLAUDE_ROOT
    )
    codex_root = (
        settings.expand_root(x_ssot_sessions_codex_root)
        if x_ssot_sessions_codex_root
        else settings.CODEX_ROOT
    )
    openclaw_root = (
        settings.expand_root(x_ssot_sessions_openclaw_root)
        if x_ssot_sessions_openclaw_root
        else settings.OPENCLAW_ROOT
    )
    return claude_root, codex_root, openclaw_root


# ---------------------------------------------------------------------------
# Filtering helpers
# ---------------------------------------------------------------------------


def _parse_iso(value: str) -> Optional[datetime]:
    """Parse an ISO8601 string to an aware datetime (UTC if naive)."""
    try:
        # Accept a trailing Z (Python <3.11 fromisoformat rejects it; 3.11+ ok,
        # but normalize anyway for safety).
        normalized = value.replace("Z", "+00:00") if value.endswith("Z") else value
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _since_cutoff(since: str) -> Optional[datetime]:
    """Interpret ``since`` as either an ISO timestamp or a number of seconds.

    A bare number means "this many seconds ago". An ISO string is an absolute
    cutoff. Returns the cutoff datetime, or None if it cannot be parsed.
    """
    since = since.strip()
    if not since:
        return None
    # Numeric -> seconds ago.
    try:
        secs = float(since)
        return datetime.now(tz=timezone.utc) - timedelta(seconds=secs)
    except ValueError:
        pass
    return _parse_iso(since)


def _matches_query(sess: Session, q: str) -> bool:
    needle = q.lower()
    haystacks = [sess.title, sess.last_prompt or "", sess.project]
    return any(needle in (h or "").lower() for h in haystacks)


def _updated_key(sess: Session) -> Any:
    """Sort key for updated_at desc. Parse to datetime; unparseable sorts last."""
    dt = _parse_iso(sess.updated_at) if sess.updated_at else None
    return dt or datetime.min.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/api/health", response_model=Health)
def health(roots: tuple[Path, Path, Path] = Depends(resolve_roots)) -> Health:
    c = cache.counts(*roots)
    return Health(
        status="ok",
        counts=HealthCounts(
            claude=c["claude"], codex=c["codex"], openclaw=c["openclaw"]
        ),
    )


@app.get("/api/sessions", response_model=list[Session])
def list_sessions(
    agent: Optional[str] = None,
    project: Optional[str] = None,
    q: Optional[str] = None,
    since: Optional[str] = None,
    roots: tuple[Path, Path, Path] = Depends(resolve_roots),
) -> list[Session]:
    sessions = cache.list_all(*roots)

    if agent:
        sessions = [s for s in sessions if s.agent == agent]
    if project:
        sessions = [s for s in sessions if s.project == project]
    if q:
        sessions = [s for s in sessions if _matches_query(s, q)]
    if since:
        cutoff = _since_cutoff(since)
        if cutoff is not None:
            filtered: list[Session] = []
            for s in sessions:
                dt = _parse_iso(s.updated_at) if s.updated_at else None
                if dt is not None and dt >= cutoff:
                    filtered.append(s)
            sessions = filtered

    sessions.sort(key=_updated_key, reverse=True)
    return sessions


@app.get("/api/sessions/{agent}/{id}", response_model=SessionDetail)
def session_detail(
    agent: str,
    id: str,
    roots: tuple[Path, Path, Path] = Depends(resolve_roots),
) -> SessionDetail:
    uid = f"{agent}:{id}"
    detail = cache.get_detail(uid, *roots)
    if detail is None:
        raise HTTPException(status_code=404, detail="session not found")
    return detail


@app.get("/api/board", response_model=list[BoardNode])
def board() -> list[BoardNode]:
    return board_store.list_nodes()


@app.get("/api/cleanup", response_model=CleanupPreview)
def cleanup_preview(
    categories: list[cleanup_service.CleanupCategory] = Query(default=[]),
    roots: tuple[Path, Path, Path] = Depends(resolve_roots),
) -> CleanupPreview:
    summary = cleanup_service.summarize(
        cleanup_service.discover(
            roots[0], roots[1], exact=False, openclaw_root=roots[2]
        ),
        categories,
    )
    return CleanupPreview(
        counts=CleanupCounts(**summary.counts),
        affected=summary.affected,
        affected_uids=list(summary.affected_uids),
    )


@app.delete("/api/cleanup", response_model=CleanupResult)
def cleanup_sessions(
    body: CleanupSelection,
    roots: tuple[Path, Path, Path] = Depends(resolve_roots),
) -> CleanupResult:
    outcome = cleanup_service.clean(
        roots[0],
        roots[1],
        body.categories,
        body.affected_uids,
        openclaw_root=roots[2],
    )
    return CleanupResult(
        status="deleted" if outcome.failed == 0 else "partial",
        affected=outcome.affected,
        deleted=outcome.deleted,
        failed=outcome.failed,
    )


@app.put("/api/board/{uid}", response_model=BoardNode)
def update_board(uid: str, body: BoardUpdate) -> BoardNode:
    # exclude_unset so only the fields the client actually sent are merged.
    partial = body.model_dump(exclude_unset=True)
    return board_store.upsert(uid, partial)


@app.delete("/api/sessions/{agent}/{id}", response_model=DeleteResult)
def delete_session(
    agent: str,
    id: str,
    roots: tuple[Path, Path, Path] = Depends(resolve_roots),
) -> DeleteResult:
    """Delete a session entirely: move its .jsonl to the Trash and drop it from
    the cache and the board."""
    uid = f"{agent}:{id}"
    if agent == "openclaw":
        raise HTTPException(
            status_code=409,
            detail="delete OpenClaw sessions from the OpenClaw app",
        )
    session = cache.get_session(uid, *roots)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    path = Path(session.path)
    if not path.exists():
        # Already gone on disk; just drop our references.
        cache.forget(uid, *roots)
        board_store.delete(uid)
        raise HTTPException(status_code=404, detail="session file no longer exists")

    try:
        dest = move_to_trash(path, allowed_roots=roots)
    except DeleteNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to delete: {exc}")

    cache.forget(uid, *roots)
    board_store.delete(uid)
    return DeleteResult(status="deleted", uid=uid, trashed_to=str(dest))
