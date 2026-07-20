"""SQLite cache for jobs + eval results.

The backend is otherwise request-driven, fanning SSH/kubectl calls out to the
clusters on every ``/api/jobs`` and ``/api/results`` hit. That makes those
endpoints slow and loses history the moment a job ages out of ``sacct``'s
window. This module is the persistence layer for a background poller
(``poller.py``) that keeps the clusters' state in a local SQLite file so the
API can serve sub-100ms cached reads and accumulate durable job history.

Access model: one shared ``sqlite3`` connection (WAL mode, so readers never
block the writer) guarded by a threading lock. Every public function is async
and runs its work in a worker thread via ``asyncio.to_thread`` so the event
loop never blocks on disk I/O. Nothing touches the filesystem at import time —
the connection (and schema) is created lazily on first use, so
``import app.main`` stays clean.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .jobs import Job, is_terminal_non_completed

# Job columns persisted verbatim from the pydantic model. "start"/"end" are
# quoted everywhere below because "end" is a SQL reserved word.
_JOB_COLUMNS = [
    "cluster",
    "job_id",
    "job_name",
    "partition",
    "state",
    "elapsed",
    "nodelist",
    "reason",
    "time_left",
    "queue_position",
    "start",
    "end",
    "phase",
    "variant",
    "resume_of",
    "resubmit_action",
    "restarts",
]


def _db_path() -> Path:
    override = os.environ.get("TRAIN_EVAL_DB_PATH")
    if override:
        return Path(override).expanduser()
    # app/cache_db.py -> app/ -> backend/ ; keep the DB under backend/data/.
    return Path(__file__).resolve().parent.parent / "data" / "train-eval.sqlite"


_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def _quote(col: str) -> str:
    return f'"{col}"'


def _create_tables(conn: sqlite3.Connection) -> None:
    cols_ddl = ",\n            ".join(
        f"{_quote(c)} TEXT" if c not in ("queue_position", "restarts") else f"{_quote(c)} INTEGER"
        for c in _JOB_COLUMNS
    )
    legacy: list[str] = []
    for table in ("jobs", "results_cache", "poll_meta"):
        columns = {
            row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if columns and "scope" not in columns:
            legacy_name = f"{table}_unscoped_v1"
            conn.execute(f"DROP TABLE IF EXISTS {legacy_name}")
            conn.execute(f"ALTER TABLE {table} RENAME TO {legacy_name}")
            legacy.append(table)

    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS jobs (
            scope TEXT NOT NULL,
            {cols_ddl},
            first_seen_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            is_terminal INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (scope, cluster, job_id)
        );
        CREATE INDEX IF NOT EXISTS jobs_scope_cluster_updated
            ON jobs (scope, cluster, updated_at);

        CREATE TABLE IF NOT EXISTS results_cache (
            scope TEXT NOT NULL,
            cluster TEXT NOT NULL,
            variants_json TEXT NOT NULL DEFAULT '[]',
            errors_json TEXT NOT NULL DEFAULT '[]',
            fetched_at REAL NOT NULL,
            duration_ms INTEGER,
            error TEXT,
            PRIMARY KEY (scope, cluster)
        );

        CREATE TABLE IF NOT EXISTS poll_meta (
            scope TEXT NOT NULL,
            cluster TEXT NOT NULL,
            kind TEXT NOT NULL,
            fetched_at REAL NOT NULL,
            ok INTEGER NOT NULL,
            error TEXT,
            duration_ms INTEGER,
            PRIMARY KEY (scope, cluster, kind)
        );

        CREATE TABLE IF NOT EXISTS cache_configs (
            scope TEXT NOT NULL,
            cluster TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            PRIMARY KEY (scope, cluster)
        );
        """
    )
    job_columns = ", ".join(_quote(column) for column in _JOB_COLUMNS)
    if "jobs" in legacy:
        conn.execute(
            f"""
            INSERT OR IGNORE INTO jobs
              (scope, {job_columns}, first_seen_at, updated_at, is_terminal)
            SELECT '', {job_columns}, first_seen_at, updated_at, is_terminal
            FROM jobs_unscoped_v1
            """
        )
        conn.execute("DROP TABLE jobs_unscoped_v1")
    if "results_cache" in legacy:
        conn.execute(
            """
            INSERT OR IGNORE INTO results_cache
              (scope, cluster, variants_json, errors_json, fetched_at, duration_ms, error)
            SELECT '', cluster, variants_json, errors_json, fetched_at, duration_ms, error
            FROM results_cache_unscoped_v1
            """
        )
        conn.execute("DROP TABLE results_cache_unscoped_v1")
    if "poll_meta" in legacy:
        conn.execute(
            """
            INSERT OR IGNORE INTO poll_meta
              (scope, cluster, kind, fetched_at, ok, error, duration_ms)
            SELECT '', cluster, kind, fetched_at, ok, error, duration_ms
            FROM poll_meta_unscoped_v1
            """
        )
        conn.execute("DROP TABLE poll_meta_unscoped_v1")
    conn.commit()


def _assert_schema_matches_model() -> None:
    """Fail loudly if _JOB_COLUMNS has drifted from the Job model.

    _JOB_COLUMNS is a hand-maintained mirror of jobs.Job; silent drift would
    drop new fields from cached responses and raise OperationalError against an
    old on-disk schema. Catch it at startup with an actionable message instead.
    """
    model_fields = set(Job.model_fields)
    cols = set(_JOB_COLUMNS)
    if cols != model_fields:
        missing = sorted(model_fields - cols)
        extra = sorted(cols - model_fields)
        raise RuntimeError(
            "cache_db._JOB_COLUMNS is out of sync with jobs.Job "
            f"(missing={missing}, extra={extra}). Update _JOB_COLUMNS to match "
            "the model and delete any stale data/train-eval.sqlite."
        )


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _assert_schema_matches_model()
        path = _db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        _create_tables(conn)
        _conn = conn
    return _conn


def _run(fn: Callable[[sqlite3.Connection], Any]) -> Any:
    with _lock:
        return fn(_get_conn())


async def _aexec(fn: Callable[[sqlite3.Connection], Any]) -> Any:
    return await asyncio.to_thread(_run, fn)


def _is_terminal(state: str) -> bool:
    upper = (state or "").upper()
    return upper.startswith("COMPLET") and upper != "COMPLETING" or is_terminal_non_completed(state)


async def init() -> None:
    """Force lazy connection + schema creation (called on poller startup)."""
    await _aexec(lambda _conn: None)


async def sync_cluster_configs(
    fingerprints: dict[str, str], *, scope: str = ""
) -> None:
    """Invalidate cache fragments whose configured cluster identity changed.

    Cluster names are user-editable aliases. Keeping only ``(email, name)`` as
    the cache key can mix data after its SSH alias or paths are changed. This
    transaction also purges removed cluster names so they cannot be returned by
    an explicit or empty-list cache read.
    """

    def _op(conn: sqlite3.Connection) -> None:
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = {
                row["cluster"]: row["fingerprint"]
                for row in conn.execute(
                    "SELECT cluster, fingerprint FROM cache_configs WHERE scope = ?",
                    (scope,),
                ).fetchall()
            }
            affected = {
                cluster
                for cluster in set(current) | set(fingerprints)
                if current.get(cluster) != fingerprints.get(cluster)
            }
            for cluster in affected:
                conn.execute(
                    "DELETE FROM jobs WHERE scope = ? AND cluster = ?",
                    (scope, cluster),
                )
                conn.execute(
                    "DELETE FROM results_cache WHERE scope = ? AND cluster = ?",
                    (scope, cluster),
                )
                conn.execute(
                    "DELETE FROM poll_meta WHERE scope = ? AND cluster = ?",
                    (scope, cluster),
                )
            conn.execute("DELETE FROM cache_configs WHERE scope = ?", (scope,))
            conn.executemany(
                "INSERT INTO cache_configs (scope, cluster, fingerprint) VALUES (?, ?, ?)",
                [(scope, cluster, value) for cluster, value in fingerprints.items()],
            )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise

    await _aexec(_op)


# ── jobs ──

async def upsert_jobs(cluster: str, rows: list[Job], *, scope: str = "") -> None:
    """Insert/update this cluster's jobs.

    Terminal rows are write-once: if a job is already stored terminal and its
    state is unchanged, it's left untouched (updated_at not bumped) so the
    durable history keeps a stable finish timestamp. Jobs that dropped out of
    squeue/sacct are never deleted here — absence is not termination.
    """
    now = time.time()

    def _op(conn: sqlite3.Connection) -> None:
        existing: dict[str, sqlite3.Row] = {
            r["job_id"]: r
            for r in conn.execute(
                'SELECT job_id, state, is_terminal, restarts, "end" '
                "FROM jobs WHERE scope = ? AND cluster = ?",
                (scope, cluster),
            )
        }
        placeholders = ", ".join(_quote(c) for c in _JOB_COLUMNS)
        qmarks = ", ".join("?" for _ in _JOB_COLUMNS)
        update_cols = [c for c in _JOB_COLUMNS if c not in ("cluster", "job_id")]
        set_clause = ", ".join(f"{_quote(c)}=excluded.{_quote(c)}" for c in update_cols)
        sql = (
            f"INSERT INTO jobs (scope, {placeholders}, first_seen_at, updated_at, is_terminal) "
            f"VALUES (?, {qmarks}, ?, ?, ?) "
            f"ON CONFLICT(scope, cluster, job_id) DO UPDATE SET {set_clause}, "
            f"updated_at=excluded.updated_at, is_terminal=excluded.is_terminal"
        )
        for job in rows:
            prev = existing.get(str(job.job_id))
            terminal = _is_terminal(job.state)
            data = job.model_dump()
            if (
                prev is not None
                and prev["is_terminal"]
                and prev["state"] == job.state
                and prev["restarts"] == data.get("restarts")
                and prev["end"] == data.get("end")
            ):
                # Write-once terminal: state, restarts and end all unchanged, so
                # keep the stable row (preserving its finish timestamp). A late
                # restarts/end correction (e.g. a preempted-then-re-failed job
                # keeping the same state) still falls through and updates.
                continue
            values = [scope, *(data.get(c) for c in _JOB_COLUMNS)]
            values += [now, now, 1 if terminal else 0]
            conn.execute(sql, values)
        conn.commit()

    await _aexec(_op)


async def read_jobs(
    clusters: list[str] | None,
    since_epoch: float | None,
    *,
    scope: str = "",
) -> list[dict]:
    """Return cached jobs as Job-shaped dicts.

    Active (non-terminal) jobs are always included. Terminal jobs are included
    only if last updated at/after ``since_epoch`` (None = no time filter),
    which reproduces today's "recent history" window without ever dropping a
    live job.
    """

    def _op(conn: sqlite3.Connection) -> list[dict]:
        cols = ", ".join(_quote(c) for c in _JOB_COLUMNS)
        where = ["scope = ?"]
        params: list[Any] = [scope]
        if clusters == []:
            return []
        if clusters is not None:
            where.append(f"cluster IN ({', '.join('?' for _ in clusters)})")
            params.extend(clusters)
        if since_epoch is not None:
            where.append("(is_terminal = 0 OR updated_at >= ?)")
            params.append(since_epoch)
        clause = f" WHERE {' AND '.join(where)}" if where else ""
        rows = conn.execute(
            f"SELECT {cols} FROM jobs{clause} ORDER BY cluster, job_id", params
        ).fetchall()
        return [{c: r[c] for c in _JOB_COLUMNS} for r in rows]

    return await _aexec(_op)


# ── results ──

async def write_results(
    cluster: str,
    variants: list[dict],
    errors: list[dict],
    fetched_at: float,
    duration_ms: int | None,
    error: str | None,
    *,
    scope: str = "",
) -> None:
    def _op(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            INSERT INTO results_cache
                (scope, cluster, variants_json, errors_json, fetched_at, duration_ms, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, cluster) DO UPDATE SET
                variants_json=excluded.variants_json,
                errors_json=excluded.errors_json,
                fetched_at=excluded.fetched_at,
                duration_ms=excluded.duration_ms,
                error=excluded.error
            """,
            (
                scope,
                cluster,
                json.dumps(variants),
                json.dumps(errors),
                fetched_at,
                duration_ms,
                error,
            ),
        )
        conn.commit()

    await _aexec(_op)


async def read_results(
    clusters: list[str] | None, *, scope: str = ""
) -> dict[str, dict]:
    """Return {cluster: {variants, errors, fetched_at, error}} for stored rows."""

    def _op(conn: sqlite3.Connection) -> dict[str, dict]:
        if clusters == []:
            return {}
        if clusters is not None:
            placeholders = ", ".join("?" for _ in clusters)
            rows = conn.execute(
                f"SELECT * FROM results_cache WHERE scope = ? AND cluster IN ({placeholders})",
                [scope, *clusters],
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM results_cache WHERE scope = ?", (scope,)
            ).fetchall()
        out: dict[str, dict] = {}
        for r in rows:
            out[r["cluster"]] = {
                "variants": json.loads(r["variants_json"]),
                "errors": json.loads(r["errors_json"]),
                "fetched_at": r["fetched_at"],
                "error": r["error"],
            }
        return out

    return await _aexec(_op)


# ── poll metadata ──

async def record_poll(
    cluster: str,
    kind: str,
    ok: bool,
    error: str | None,
    duration_ms: int | None,
    *,
    scope: str = "",
) -> None:
    now = time.time()

    def _op(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            INSERT INTO poll_meta (scope, cluster, kind, fetched_at, ok, error, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, cluster, kind) DO UPDATE SET
                fetched_at=excluded.fetched_at,
                ok=excluded.ok,
                error=excluded.error,
                duration_ms=excluded.duration_ms
            """,
            (scope, cluster, kind, now, 1 if ok else 0, error, duration_ms),
        )
        conn.commit()

    await _aexec(_op)


async def read_poll_meta(
    kind: str | None = None, *, scope: str = ""
) -> dict[str, dict]:
    """Return {cluster: {fetched_at, ok, error, duration_ms}} for one kind."""

    def _op(conn: sqlite3.Connection) -> dict[str, dict]:
        if kind:
            rows = conn.execute(
                "SELECT * FROM poll_meta WHERE scope = ? AND kind = ?", (scope, kind)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM poll_meta WHERE scope = ?", (scope,)
            ).fetchall()
        return {
            r["cluster"]: {
                "fetched_at": r["fetched_at"],
                "ok": bool(r["ok"]),
                "error": r["error"],
                "duration_ms": r["duration_ms"],
            }
            for r in rows
        }

    return await _aexec(_op)
