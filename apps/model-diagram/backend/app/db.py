"""SQLite persistence for model diagrams (own model_diagram.db).

Normalized rows are the source of truth; the assembled single-file HTML page is
a cache in ``runs.rendered_html``. Schema follows the plan §10.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from . import settings
from .schemas import FinalizePayload

VALID_STATUSES = {"running", "done", "error"}
VALID_PAPER_STATUS = {"none", "attached", "mismatch"}


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
  canvas_width INTEGER,
  canvas_height INTEGER,
  rendered_html TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_diagram ON runs(diagram_id);

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
"""


def init_db() -> None:
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


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
) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            """
            INSERT INTO papers (run_id, kind, source_url, stored_path, content_type,
                                sha256, page_count, parsed_title, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, kind, source_url, stored_path, content_type, sha256, page_count, parsed_title, _now()),
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


# ── finalize persistence ──────────────────────────────────────────────────


def persist_finalize(run_id: int, payload: FinalizePayload) -> None:
    """Insert the normalized diagram rows for a finalized run (atomic).

    ``line_count`` is recomputed from the decoded content (not trusted from the
    agent) so the render-time highlight bounds match the embedded bytes.
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
            line_count = _b64_line_count(src.content_b64)
            cur = conn.execute(
                "INSERT INTO sources (run_id, source_key, name, content_b64, line_count) VALUES (?, ?, ?, ?, ?)",
                (run_id, src.source_key, src.name, src.content_b64, line_count),
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
                                                 paper_location, code_value, confidence, ordinal)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (run_id, comp_id, cite.label, cite.paper_value, cite.paper_location,
                     cite.code_value, cite.confidence, cite_ordinal),
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
