"""SQLite persistence for model diagrams (own model_diagram.db).

Normalized rows are the source of truth; the assembled single-file HTML page is
a cache in ``runs.rendered_html``. Schema follows the plan §10.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from . import settings
from .schemas import FinalizePayload

VALID_STATUSES = {"running", "done", "error"}
VALID_PAPER_STATUS = {"none", "attached", "mismatch"}

# A run whose worker process is confirmed gone (pid recorded but dead) died mid-run
# — most often it was OOM-killed or crashed, since a clean finish writes a terminal
# status before exiting. Runs now survive a *backend* restart (the worker is its own
# detached process), so a plain "backend restarted" is no longer a failure cause.
_ORPHAN_RUN_DETAIL = (
    "the generation worker for this run is no longer running (it crashed or was "
    "killed before finishing); start a new run"
)

# Keep at most this many agent-output lines per run; older lines are pruned as new
# ones arrive so a long run cannot grow the DB without bound.
_OUTPUT_KEEP_LINES = 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    path = settings.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


_SCHEMA = """
CREATE TABLE IF NOT EXISTS diagrams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  path TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  diagram_id INTEGER NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  cluster TEXT NOT NULL,
  path TEXT NOT NULL,
  commit_hash TEXT,
  title TEXT,
  model TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  error_detail TEXT,
  paper_status TEXT NOT NULL DEFAULT 'none',
  paper_warning TEXT,
  pid INTEGER,
  canvas_width INTEGER,
  canvas_height INTEGER,
  rendered_html TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_diagram ON runs(diagram_id);

CREATE TABLE IF NOT EXISTS run_output (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  ts TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_run_output_run ON run_output(run_id, seq);

CREATE TABLE IF NOT EXISTS stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  detail TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_events_run ON stage_events(run_id, id);

CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_url TEXT,
  stored_path TEXT,
  content_type TEXT,
  sha256 TEXT,
  page_count INTEGER,
  parsed_title TEXT,
  panel_path TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_papers_run ON papers(run_id);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  name TEXT NOT NULL,
  content_b64 TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  UNIQUE(run_id, source_key)
);

CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  component_key TEXT NOT NULL,
  kebab_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'component',
  name_html TEXT NOT NULL,
  shape_html TEXT,
  left_px INTEGER,
  top_px INTEGER,
  width_px INTEGER,
  min_height_px INTEGER,
  hp_value TEXT,
  hp_cite TEXT,
  ordinal INTEGER NOT NULL,
  UNIQUE(run_id, component_key)
);
CREATE INDEX IF NOT EXISTS idx_components_run ON components(run_id);

CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  step_ordinal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  paper_value TEXT,
  paper_location TEXT,
  code_value TEXT,
  confidence TEXT,
  paper_quote TEXT,
  paper_anchor TEXT,
  ordinal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path_d TEXT NOT NULL,
  from_component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  to_component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  ordinal INTEGER NOT NULL
);

-- Follow-up chat about a diagram. One thread per diagram; each turn is a user
-- message + an assistant message. The assistant message is produced by a detached
-- chat worker (same infra as runs): it carries pid + status ('pending' until the
-- worker finishes) and, when the turn revised the diagram, revised_run_id points at
-- the new run persisted under the diagram.
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  diagram_id INTEGER NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(diagram_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  anchor_run_id INTEGER,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done',
  error_detail TEXT,
  revised_run_id INTEGER,
  model TEXT,
  pid INTEGER,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, seq);

CREATE TABLE IF NOT EXISTS chat_output (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  ts TEXT NOT NULL,
  UNIQUE(message_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chat_output_msg ON chat_output(message_id, seq);
"""


def init_db() -> None:
    conn = _connect()
    try:
        # WAL lets the web process, each detached run worker, and (on the CLI
        # runtime) the MCP subprocess read/write the one DB concurrently without
        # blocking. It is a persistent property of the file; _connect sets the
        # PRAGMA on every open, but assert it actually took here at init time.
        mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
        if str(mode).lower() != "wal":  # e.g. :memory: or a filesystem without mmap
            conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive migrations for DBs created before a column/table existed.

    ``CREATE TABLE IF NOT EXISTS`` never alters an existing table, so a ``runs``
    table from before the detached-worker change lacks ``pid``; add it in place.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(runs)").fetchall()}
    if "pid" not in cols:
        conn.execute("ALTER TABLE runs ADD COLUMN pid INTEGER")

    diagram_cols = {r["name"] for r in conn.execute("PRAGMA table_info(diagrams)").fetchall()}
    if diagram_cols and "memo" not in diagram_cols:
        conn.execute("ALTER TABLE diagrams ADD COLUMN memo TEXT NOT NULL DEFAULT ''")

    paper_cols = {r["name"] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    if paper_cols and "panel_path" not in paper_cols:
        conn.execute("ALTER TABLE papers ADD COLUMN panel_path TEXT")

    cite_cols = {r["name"] for r in conn.execute("PRAGMA table_info(paper_citations)").fetchall()}
    if cite_cols and "paper_quote" not in cite_cols:
        conn.execute("ALTER TABLE paper_citations ADD COLUMN paper_quote TEXT")
    if cite_cols and "paper_anchor" not in cite_cols:
        conn.execute("ALTER TABLE paper_citations ADD COLUMN paper_anchor TEXT")


# ── diagrams + runs ───────────────────────────────────────────────────────


def create_diagram_with_run(
    *, user_email: str, cluster: str, path: str, model: str
) -> tuple[int, int]:
    now = _now()
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO diagrams (user_email, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (user_email, path, now, now),
        )
        diagram_id = int(cur.lastrowid)
        run_id = _insert_run(conn, diagram_id, user_email, cluster, path, model, now)
        conn.commit()
        return diagram_id, run_id
    finally:
        conn.close()


def create_run(
    *, diagram_id: int, user_email: str, cluster: str, path: str, model: str
) -> int:
    now = _now()
    conn = _connect()
    try:
        run_id = _insert_run(conn, diagram_id, user_email, cluster, path, model, now)
        conn.execute(
            "UPDATE diagrams SET updated_at = ?, path = ? WHERE id = ?",
            (now, path, diagram_id),
        )
        conn.commit()
        return run_id
    finally:
        conn.close()


def _insert_run(
    conn: sqlite3.Connection,
    diagram_id: int,
    user_email: str,
    cluster: str,
    path: str,
    model: str,
    now: str,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO runs (diagram_id, user_email, cluster, path, model, status,
                          paper_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', 'none', ?, ?)
        """,
        (diagram_id, user_email, cluster, path, model, now, now),
    )
    return int(cur.lastrowid)


def get_diagram(diagram_id: int) -> Optional[dict]:
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM diagrams WHERE id = ?", (diagram_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def set_diagram_memo(diagram_id: int, *, user_email: str, memo: str) -> bool:
    """Update a diagram's memo (ownership-scoped); True if a row was updated."""
    conn = _connect()
    try:
        cur = conn.execute(
            "UPDATE diagrams SET memo = ?, updated_at = ? WHERE id = ? AND user_email = ?",
            (memo, _now(), diagram_id, user_email),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_diagram(diagram_id: int, *, user_email: str) -> bool:
    conn = _connect()
    try:
        cur = conn.execute(
            "DELETE FROM diagrams WHERE id = ? AND user_email = ?",
            (diagram_id, user_email),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def list_diagrams(user_email: str) -> list[dict]:
    """Diagrams for a user with their latest run's summary fields."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM diagrams WHERE user_email = ? ORDER BY updated_at DESC",
            (user_email,),
        ).fetchall()
        out: list[dict] = []
        for row in rows:
            latest = conn.execute(
                "SELECT * FROM runs WHERE diagram_id = ? ORDER BY id DESC LIMIT 1",
                (row["id"],),
            ).fetchone()
            has_paper = False
            if latest is not None:
                has_paper = (
                    conn.execute(
                        "SELECT 1 FROM papers WHERE run_id = ? LIMIT 1",
                        (latest["id"],),
                    ).fetchone()
                    is not None
                )
            out.append(
                {
                    "id": row["id"],
                    "path": row["path"],
                    "memo": row["memo"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "latest_run": dict(latest) if latest else None,
                    "has_paper": has_paper,
                }
            )
        return out
    finally:
        conn.close()


def get_run(run_id: int) -> Optional[dict]:
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_runs(diagram_id: int) -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM runs WHERE diagram_id = ? ORDER BY id DESC",
            (diagram_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def update_run_status(
    run_id: int,
    status: str,
    *,
    error_kind: Optional[str] = None,
    error_detail: Optional[str] = None,
    paper_status: Optional[str] = None,
    paper_warning: Optional[str] = None,
) -> None:
    fields = ["status = ?", "updated_at = ?"]
    params: list[Any] = [status, _now()]
    if error_kind is not None:
        fields.append("error_kind = ?")
        params.append(error_kind)
    if error_detail is not None:
        fields.append("error_detail = ?")
        params.append(error_detail)
    if paper_status is not None:
        fields.append("paper_status = ?")
        params.append(paper_status)
    if paper_warning is not None:
        fields.append("paper_warning = ?")
        params.append(paper_warning)
    params.append(run_id)
    conn = _connect()
    try:
        conn.execute(f"UPDATE runs SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
    finally:
        conn.close()


def mark_terminal(
    run_id: int,
    status: str,
    *,
    error_kind: Optional[str] = None,
    error_detail: Optional[str] = None,
    paper_status: Optional[str] = None,
    paper_warning: Optional[str] = None,
) -> bool:
    """Flip a still-``running`` row to a terminal status; return True if it flipped.

    A terminal status is FINAL — this only updates ``WHERE status = 'running'``. That
    makes the terminal write race-safe: once the cancel endpoint records
    ``cancelled``, a worker/MCP write that lands a moment later is a no-op, so the
    worker's own error handling can never resurrect a cancelled (or otherwise
    already-terminal) run.
    """
    fields = ["status = ?", "updated_at = ?"]
    params: list[Any] = [status, _now()]
    if error_kind is not None:
        fields.append("error_kind = ?")
        params.append(error_kind)
    if error_detail is not None:
        fields.append("error_detail = ?")
        params.append(error_detail)
    if paper_status is not None:
        fields.append("paper_status = ?")
        params.append(paper_status)
    if paper_warning is not None:
        fields.append("paper_warning = ?")
        params.append(paper_warning)
    params.append(run_id)
    conn = _connect()
    try:
        cur = conn.execute(
            f"UPDATE runs SET {', '.join(fields)} WHERE id = ? AND status = 'running'", params
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def set_run_pid(run_id: int, pid: int) -> None:
    """Record the detached worker's pid so reconciliation can probe its liveness."""
    conn = _connect()
    try:
        conn.execute(
            "UPDATE runs SET pid = ?, updated_at = ? WHERE id = ?", (pid, _now(), run_id)
        )
        conn.commit()
    finally:
        conn.close()


def _pid_alive(pid: Optional[int]) -> bool:
    """True if ``pid`` names a live process. ``os.kill(pid, 0)`` sends no signal —
    it only checks existence: no error → alive; ProcessLookupError → gone;
    PermissionError → exists but owned by another user (treat as alive)."""
    if not pid or pid <= 0:
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _fail_orphan(conn: sqlite3.Connection, run_id: int) -> None:
    conn.execute(
        "UPDATE runs SET status = 'error', error_kind = 'agent_failure', "
        "error_detail = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        (_ORPHAN_RUN_DETAIL, _now(), run_id),
    )


def reconcile_orphaned_runs(spawn_grace_seconds: float = 15.0) -> list[int]:
    """Fail ``running`` rows whose worker process is gone (returns their ids).

    Each run now executes in its own detached OS process (:mod:`app.run_worker`)
    whose pid is stored on the row, so a run *survives* a backend restart — the
    worker keeps going and writes its terminal status straight to the DB. A row is
    only orphaned when its worker is actually dead:

    * pid recorded and no longer alive → the worker crashed/was killed → fail.
    * pid still NULL and the row is older than ``spawn_grace_seconds`` → the worker
      never came up (or the backend died between the INSERT and the spawn) → fail.
      Fresh NULL-pid rows are left alone so this never races a run mid-spawn.

    The DB is the SSE source of truth (``event_stream`` tails it), so a reconnecting
    client sees the failure frame.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=spawn_grace_seconds)).isoformat()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, pid, created_at FROM runs WHERE status = 'running'"
        ).fetchall()
        failed: list[int] = []
        for row in rows:
            pid = row["pid"]
            if pid is None:
                if row["created_at"] < cutoff:  # never spawned; not a live mid-spawn row
                    _fail_orphan(conn, int(row["id"]))
                    failed.append(int(row["id"]))
            elif not _pid_alive(pid):
                _fail_orphan(conn, int(row["id"]))
                failed.append(int(row["id"]))
        if failed:
            conn.commit()
        return failed
    finally:
        conn.close()


def reconcile_run_if_orphaned(run_id: int, spawn_grace_seconds: float = 15.0) -> bool:
    """Lazily fail one ``running`` run whose worker is dead; True if it was failed.

    Called when a single run is fetched/tailed so a dead worker is caught without
    waiting for the next startup sweep.
    """
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, pid, status, created_at FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
        if row is None or row["status"] != "running":
            return False
        pid = row["pid"]
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=spawn_grace_seconds)).isoformat()
        dead = (pid is None and row["created_at"] < cutoff) or (pid is not None and not _pid_alive(pid))
        if not dead:
            return False
        _fail_orphan(conn, run_id)
        conn.commit()
        return True
    finally:
        conn.close()


def set_paper_status(run_id: int, paper_status: str, paper_warning: str = "") -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE runs SET paper_status = ?, paper_warning = ?, updated_at = ? WHERE id = ?",
            (paper_status, paper_warning, _now(), run_id),
        )
        conn.commit()
    finally:
        conn.close()


def set_rendered_html(run_id: int, html: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE runs SET rendered_html = ?, updated_at = ? WHERE id = ?",
            (html, _now(), run_id),
        )
        conn.commit()
    finally:
        conn.close()


# ── stage events ──────────────────────────────────────────────────────────


def add_stage_event(run_id: int, stage: str, detail: str = "") -> dict:
    ts = _now()
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO stage_events (run_id, stage, detail, ts) VALUES (?, ?, ?, ?)",
            (run_id, stage, detail, ts),
        )
        conn.commit()
        return {"id": int(cur.lastrowid), "run_id": run_id, "stage": stage, "detail": detail, "ts": ts}
    finally:
        conn.close()


def list_stage_events(run_id: int) -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM stage_events WHERE run_id = ? ORDER BY id ASC",
            (run_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── agent output (live activity log) ──────────────────────────────────────


def add_output_line(run_id: int, line: str) -> dict:
    """Append one agent-output line and return ``{seq, line, ts}``.

    ``seq`` is a per-run monotonic counter (max+1). Older lines beyond
    :data:`_OUTPUT_KEEP_LINES` are pruned by seq threshold — cheap and safe
    because seq is monotonic and never reused, and tailing keys off ``after_seq``
    so the gap left by pruning is harmless.
    """
    ts = _now()
    text = line if len(line) <= 4000 else line[:4000] + " …[truncated]"
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM run_output WHERE run_id = ?", (run_id,)
        ).fetchone()
        seq = int(row["m"]) + 1
        conn.execute(
            "INSERT INTO run_output (run_id, seq, line, ts) VALUES (?, ?, ?, ?)",
            (run_id, seq, text, ts),
        )
        if seq > _OUTPUT_KEEP_LINES:
            conn.execute(
                "DELETE FROM run_output WHERE run_id = ? AND seq <= ?",
                (run_id, seq - _OUTPUT_KEEP_LINES),
            )
        conn.commit()
        return {"seq": seq, "line": text, "ts": ts}
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def list_output(run_id: int, after_seq: int = 0) -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT seq, line, ts FROM run_output WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
            (run_id, after_seq),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── papers ────────────────────────────────────────────────────────────────


def add_paper(
    run_id: int,
    *,
    kind: str,
    source_url: Optional[str],
    stored_path: Optional[str],
    content_type: Optional[str],
    sha256: Optional[str],
    page_count: Optional[int],
    parsed_title: Optional[str],
    panel_path: Optional[str] = None,
) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            """
            INSERT INTO papers (run_id, kind, source_url, stored_path, content_type,
                                sha256, page_count, parsed_title, panel_path, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, kind, source_url, stored_path, content_type, sha256, page_count,
             parsed_title, panel_path, _now()),
        )
        # Reflect the attachment on the run so the API/viewer see paper_status
        # 'attached' immediately (it only becomes 'mismatch' if the agent later
        # calls report_paper_mismatch). Guard on 'none' so a re-attach can't clobber
        # a mismatch already recorded for the run.
        conn.execute(
            "UPDATE runs SET paper_status = 'attached', updated_at = ? WHERE id = ? AND paper_status = 'none'",
            (_now(), run_id),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


def run_has_paper(run_id: int) -> bool:
    conn = _connect()
    try:
        return conn.execute("SELECT 1 FROM papers WHERE run_id = ? LIMIT 1", (run_id,)).fetchone() is not None
    finally:
        conn.close()


def get_paper(run_id: int) -> Optional[dict]:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM papers WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_source_b64_by_name(run_id: int) -> dict[str, str]:
    """Map ``name -> content_b64`` for a run's stored sources (chat-revise reuse).

    A chat revision references the anchor run's already-embedded files; reusing
    those bytes by name avoids re-reading the whole repo on every follow-up turn.
    """
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT name, content_b64 FROM sources WHERE run_id = ?", (run_id,)
        ).fetchall()
        return {r["name"]: r["content_b64"] for r in rows}
    finally:
        conn.close()


# ── chat (follow-up conversation about a diagram) ──────────────────────────

_CHAT_OUTPUT_KEEP_LINES = 2000
_CHAT_ORPHAN_DETAIL = (
    "the chat worker for this reply is no longer running (it crashed or was killed); "
    "ask again"
)


def get_or_create_thread(diagram_id: int, user_email: str) -> int:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM chat_threads WHERE diagram_id = ?", (diagram_id,)
        ).fetchone()
        if row is not None:
            return int(row["id"])
        now = _now()
        cur = conn.execute(
            "INSERT INTO chat_threads (diagram_id, user_email, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (diagram_id, user_email, now, now),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


def add_chat_message(
    thread_id: int,
    *,
    role: str,
    content: str = "",
    status: str = "done",
    anchor_run_id: Optional[int] = None,
    model: Optional[str] = None,
) -> dict:
    """Append a chat message (per-thread monotonic ``seq``); returns the row."""
    now = _now()
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM chat_messages WHERE thread_id = ?", (thread_id,)
        ).fetchone()
        seq = int(row["m"]) + 1
        cur = conn.execute(
            """
            INSERT INTO chat_messages (thread_id, anchor_run_id, role, content, status, model,
                                       seq, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (thread_id, anchor_run_id, role, content, status, model, seq, now, now),
        )
        conn.execute("UPDATE chat_threads SET updated_at = ? WHERE id = ?", (now, thread_id))
        conn.commit()
        msg = conn.execute("SELECT * FROM chat_messages WHERE id = ?", (int(cur.lastrowid),)).fetchone()
        return dict(msg)
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_chat_message(message_id: int) -> Optional[dict]:
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM chat_messages WHERE id = ?", (message_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_chat_messages(thread_id: int, after_seq: int = 0) -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC",
            (thread_id, after_seq),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def set_chat_pid(message_id: int, pid: int) -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE chat_messages SET pid = ?, updated_at = ? WHERE id = ?", (pid, _now(), message_id)
        )
        conn.commit()
    finally:
        conn.close()


def finish_chat_message(
    message_id: int,
    status: str,
    *,
    content: Optional[str] = None,
    error_detail: Optional[str] = None,
    revised_run_id: Optional[int] = None,
) -> bool:
    """Flip a still-``pending`` assistant message to terminal; True if it flipped.

    Guarded like :func:`mark_terminal` so a cancel that landed first (or a double
    write) is never clobbered.
    """
    fields = ["status = ?", "updated_at = ?"]
    params: list[Any] = [status, _now()]
    if content is not None:
        fields.append("content = ?")
        params.append(content)
    if error_detail is not None:
        fields.append("error_detail = ?")
        params.append(error_detail)
    if revised_run_id is not None:
        fields.append("revised_run_id = ?")
        params.append(revised_run_id)
    params.append(message_id)
    conn = _connect()
    try:
        cur = conn.execute(
            f"UPDATE chat_messages SET {', '.join(fields)} WHERE id = ? AND status = 'pending'", params
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def set_chat_revised(message_id: int, revised_run_id: int) -> None:
    """Stamp the revision run id on a pending assistant message (does not finish it).

    Used by the CLI-runtime MCP revise handler so the worker can read the new run id
    after the CLI exits; the worker still owns the terminal ``finish_chat_message``.
    """
    conn = _connect()
    try:
        conn.execute(
            "UPDATE chat_messages SET revised_run_id = ?, updated_at = ? WHERE id = ?",
            (revised_run_id, _now(), message_id),
        )
        conn.commit()
    finally:
        conn.close()


def add_chat_output_line(message_id: int, line: str) -> dict:
    ts = _now()
    text = line if len(line) <= 4000 else line[:4000] + " …[truncated]"
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM chat_output WHERE message_id = ?", (message_id,)
        ).fetchone()
        seq = int(row["m"]) + 1
        conn.execute(
            "INSERT INTO chat_output (message_id, seq, line, ts) VALUES (?, ?, ?, ?)",
            (message_id, seq, text, ts),
        )
        if seq > _CHAT_OUTPUT_KEEP_LINES:
            conn.execute(
                "DELETE FROM chat_output WHERE message_id = ? AND seq <= ?",
                (message_id, seq - _CHAT_OUTPUT_KEEP_LINES),
            )
        conn.commit()
        return {"seq": seq, "line": text, "ts": ts}
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def list_chat_output(message_id: int, after_seq: int = 0) -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT seq, line, ts FROM chat_output WHERE message_id = ? AND seq > ? ORDER BY seq ASC",
            (message_id, after_seq),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def reconcile_chat_message_if_orphaned(message_id: int, spawn_grace_seconds: float = 15.0) -> bool:
    """Fail a ``pending`` assistant message whose worker is dead; True if failed."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, pid, status, created_at FROM chat_messages WHERE id = ?", (message_id,)
        ).fetchone()
        if row is None or row["status"] != "pending":
            return False
        pid = row["pid"]
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=spawn_grace_seconds)).isoformat()
        dead = (pid is None and row["created_at"] < cutoff) or (pid is not None and not _pid_alive(pid))
        if not dead:
            return False
        conn.execute(
            "UPDATE chat_messages SET status = 'error', error_detail = ?, updated_at = ? "
            "WHERE id = ? AND status = 'pending'",
            (_CHAT_ORPHAN_DETAIL, _now(), message_id),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def reconcile_orphaned_chat(spawn_grace_seconds: float = 15.0) -> list[int]:
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=spawn_grace_seconds)).isoformat()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, pid, created_at FROM chat_messages WHERE status = 'pending'"
        ).fetchall()
        failed: list[int] = []
        for row in rows:
            pid = row["pid"]
            dead = (pid is None and row["created_at"] < cutoff) or (pid is not None and not _pid_alive(pid))
            if dead:
                conn.execute(
                    "UPDATE chat_messages SET status = 'error', error_detail = ?, updated_at = ? "
                    "WHERE id = ? AND status = 'pending'",
                    (_CHAT_ORPHAN_DETAIL, _now(), int(row["id"])),
                )
                failed.append(int(row["id"]))
        if failed:
            conn.commit()
        return failed
    finally:
        conn.close()


def copy_paper(from_run_id: int, to_run_id: int) -> None:
    """Copy the latest paper row from one run to another (for a chat revision)."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM papers WHERE run_id = ? ORDER BY id DESC LIMIT 1", (from_run_id,)
        ).fetchone()
        if row is None:
            return
        conn.execute(
            """
            INSERT INTO papers (run_id, kind, source_url, stored_path, content_type,
                                sha256, page_count, parsed_title, panel_path, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (to_run_id, row["kind"], row["source_url"], row["stored_path"], row["content_type"],
             row["sha256"], row["page_count"], row["parsed_title"], row["panel_path"], _now()),
        )
        conn.execute(
            "UPDATE runs SET paper_status = 'attached', updated_at = ? WHERE id = ? AND paper_status = 'none'",
            (_now(), to_run_id),
        )
        conn.commit()
    finally:
        conn.close()


# ── finalize persistence ──────────────────────────────────────────────────


def persist_finalize(run_id: int, payload: FinalizePayload, source_b64: dict[str, str]) -> None:
    """Insert the normalized diagram rows for a finalized run (atomic).

    ``source_b64`` maps each ``source_key`` to the base64 of the exact bytes the
    backend fetched from the model root at finalize time (the agent no longer
    sends file contents). ``line_count`` is recomputed from those bytes so the
    render-time highlight bounds provably match the embedded source.
    """
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        # Clear any previous partial rows for idempotency on retry.
        for table in ("edges", "paper_citations", "snippets", "components", "sources"):
            if table == "snippets":
                conn.execute(
                    "DELETE FROM snippets WHERE component_id IN (SELECT id FROM components WHERE run_id = ?)",
                    (run_id,),
                )
            else:
                conn.execute(f"DELETE FROM {table} WHERE run_id = ?", (run_id,))

        source_ids: dict[str, int] = {}
        for src in payload.sources:
            content_b64 = source_b64[src.source_key]
            line_count = _b64_line_count(content_b64)
            cur = conn.execute(
                "INSERT INTO sources (run_id, source_key, name, content_b64, line_count) VALUES (?, ?, ?, ?, ?)",
                (run_id, src.source_key, src.name, content_b64, line_count),
            )
            source_ids[src.source_key] = int(cur.lastrowid)

        component_ids: dict[str, int] = {}
        for ordinal, comp in enumerate(payload.components):
            pos = comp.position
            cur = conn.execute(
                """
                INSERT INTO components (run_id, component_key, kebab_id, kind, name_html,
                                        shape_html, left_px, top_px, width_px, min_height_px,
                                        hp_value, hp_cite, ordinal)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id, comp.component_key, comp.kebab_id, comp.kind, comp.name_html,
                    comp.shape_html,
                    pos.left if pos else None,
                    pos.top if pos else None,
                    pos.width if pos else None,
                    pos.min_height if pos else None,
                    comp.hp_value, comp.hp_cite, ordinal,
                ),
            )
            component_ids[comp.component_key] = int(cur.lastrowid)

        cite_ordinal = 0
        for comp in payload.components:
            comp_id = component_ids[comp.component_key]
            for step, snip in enumerate(comp.snippets):
                conn.execute(
                    "INSERT INTO snippets (component_id, source_id, start_line, end_line, step_ordinal) VALUES (?, ?, ?, ?, ?)",
                    (comp_id, source_ids[snip.source_key], snip.start, snip.end, step),
                )
            for cite in comp.paper_citations:
                conn.execute(
                    """
                    INSERT INTO paper_citations (run_id, component_id, label, paper_value,
                                                 paper_location, code_value, confidence,
                                                 paper_quote, paper_anchor, ordinal)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (run_id, comp_id, cite.label, cite.paper_value, cite.paper_location,
                     cite.code_value, cite.confidence, cite.paper_quote, cite.paper_anchor,
                     cite_ordinal),
                )
                cite_ordinal += 1

        for ordinal, edge in enumerate(payload.edges):
            from_id = component_ids.get(edge.from_component_key) if edge.from_component_key else None
            to_id = component_ids.get(edge.to_component_key) if edge.to_component_key else None
            conn.execute(
                "INSERT INTO edges (run_id, path_d, from_component_id, to_component_id, ordinal) VALUES (?, ?, ?, ?, ?)",
                (run_id, edge.path_d, from_id, to_id, ordinal),
            )

        conn.execute(
            "UPDATE runs SET title = ?, commit_hash = ?, canvas_width = ?, canvas_height = ?, updated_at = ? WHERE id = ?",
            (payload.title, payload.commit_hash, payload.canvas.width, payload.canvas.height, _now(), run_id),
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def apply_geometry(
    run_id: int,
    box_geom: dict[str, tuple[int, int]],
    canvas_height: int,
    edge_paths: dict[int, str],
) -> None:
    """Persist the headless-measured geometry pass (spec §7.2 / A6).

    ``box_geom`` maps component_key -> (top_px, min_height_px); ``edge_paths`` maps
    an edge ordinal -> regenerated orthogonal path_d. Written atomically so the
    re-rendered page always reflects a self-consistent layout.
    """
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for component_key, (top_px, min_height_px) in box_geom.items():
            conn.execute(
                "UPDATE components SET top_px = ?, min_height_px = ? WHERE run_id = ? AND component_key = ?",
                (top_px, min_height_px, run_id, component_key),
            )
        for ordinal, path_d in edge_paths.items():
            conn.execute(
                "UPDATE edges SET path_d = ? WHERE run_id = ? AND ordinal = ?",
                (path_d, run_id, ordinal),
            )
        conn.execute(
            "UPDATE runs SET canvas_height = ?, updated_at = ? WHERE id = ?",
            (canvas_height, _now(), run_id),
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def load_diagram_model(run_id: int) -> dict:
    """Load the normalized rows render.py needs to assemble the page."""
    conn = _connect()
    try:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if run is None:
            raise KeyError(f"run {run_id} not found")
        sources = conn.execute(
            "SELECT * FROM sources WHERE run_id = ? ORDER BY id ASC", (run_id,)
        ).fetchall()
        components = conn.execute(
            "SELECT * FROM components WHERE run_id = ? ORDER BY ordinal ASC", (run_id,)
        ).fetchall()
        comp_by_id = {c["id"]: dict(c) for c in components}
        snippets_by_component: dict[int, list[dict]] = {}
        for comp in components:
            snips = conn.execute(
                "SELECT * FROM snippets WHERE component_id = ? ORDER BY step_ordinal ASC",
                (comp["id"],),
            ).fetchall()
            snippets_by_component[comp["id"]] = [dict(s) for s in snips]
        edges = conn.execute(
            "SELECT * FROM edges WHERE run_id = ? ORDER BY ordinal ASC", (run_id,)
        ).fetchall()
        citations = conn.execute(
            "SELECT * FROM paper_citations WHERE run_id = ? ORDER BY ordinal ASC", (run_id,)
        ).fetchall()
        paper = conn.execute(
            "SELECT * FROM papers WHERE run_id = ? ORDER BY id DESC LIMIT 1", (run_id,)
        ).fetchone()
        source_key_by_id = {s["id"]: s["source_key"] for s in sources}
        return {
            "run": dict(run),
            "sources": [dict(s) for s in sources],
            "components": [dict(c) for c in components],
            "snippets_by_component": snippets_by_component,
            "source_key_by_id": source_key_by_id,
            "comp_by_id": comp_by_id,
            "edges": [dict(e) for e in edges],
            "citations": [dict(c) for c in citations],
            "paper": dict(paper) if paper else None,
        }
    finally:
        conn.close()


def _b64_line_count(content_b64: str) -> int:
    import base64

    text = base64.b64decode(content_b64).decode("utf-8", errors="replace").replace("\r\n", "\n")
    # splitlines() count of the decoded file (matches the §7.1 integrity check).
    return len(text.splitlines())
