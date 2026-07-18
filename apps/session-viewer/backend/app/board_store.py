"""SQLite persistence for whiteboard node positions/annotations.

Board state lives in the SSOT-wide SQLite database (``$SSOT_DATA_DIR/ssot.db``)
in a table namespaced to this app, ``session_board_nodes``. The public API is
unchanged from the previous board.json implementation:

- ``load()``      -> ``{uid: BoardNode}`` for the whole board
- ``list_nodes()``-> ``list[BoardNode]``
- ``upsert()``    -> merge a partial update for one uid, return the result
- ``delete()``    -> remove one uid, return whether it existed

A connection is opened per operation (sqlite3 connections are not shareable
across threads, and FastAPI runs these sync calls in a threadpool). WAL mode is
enabled for better read/write concurrency. A module lock serializes writes and
the one-time initialization/migration. On first use, any nodes from a legacy
``board.json`` are imported for uids not already present; the JSON is left in
place.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from . import settings
from .models import BoardNode

log = logging.getLogger("session_board.board_store")

_TABLE = "session_board_nodes"

_lock = threading.Lock()
_initialized = False


def _default_node(uid: str) -> BoardNode:
    return BoardNode(uid=uid, x=0, y=0, color=None, starred=False, note="")


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _row_to_node(row: sqlite3.Row) -> BoardNode:
    return BoardNode(
        uid=row["uid"],
        x=row["x"],
        y=row["y"],
        color=row["color"],
        starred=bool(row["starred"]),
        note=row["note"] or "",
    )


def _create_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {_TABLE} (
            uid TEXT PRIMARY KEY,
            x REAL,
            y REAL,
            color TEXT,
            starred INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            updated_at TEXT
        )
        """
    )


def _migrate_legacy_json(conn: sqlite3.Connection) -> None:
    """Import nodes from a legacy board.json for uids not already in the table.

    Leaves the JSON file in place. Any read/parse error is logged and ignored so
    a corrupt legacy file cannot prevent the store from working.
    """
    path = settings.LEGACY_BOARD_JSON
    if not path.exists():
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, ValueError, OSError) as exc:
        log.warning("legacy board.json unreadable (%s); skipping migration", exc)
        return
    if not isinstance(raw, dict):
        log.warning("legacy board.json is not an object; skipping migration")
        return

    existing = {row["uid"] for row in conn.execute(f"SELECT uid FROM {_TABLE}")}
    imported = 0
    now = _now_iso()
    for uid, data in raw.items():
        if uid in existing or not isinstance(data, dict):
            continue
        try:
            node = BoardNode(**{**data, "uid": uid})
        except Exception as exc:  # noqa: BLE001 - skip a single bad node
            log.warning("skipping bad legacy board node %s: %s", uid, exc)
            continue
        conn.execute(
            f"INSERT INTO {_TABLE} (uid, x, y, color, starred, note, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (node.uid, node.x, node.y, node.color, int(node.starred), node.note, now),
        )
        imported += 1
    if imported:
        conn.commit()
        log.info("migrated %d node(s) from legacy board.json", imported)


def _ensure_init() -> None:
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        conn = _connect()
        try:
            _create_table(conn)
            conn.commit()
            _migrate_legacy_json(conn)
        finally:
            conn.close()
        _initialized = True


def load() -> dict[str, BoardNode]:
    """Load the whole board as {uid: BoardNode}."""
    _ensure_init()
    conn = _connect()
    try:
        rows = conn.execute(
            f"SELECT uid, x, y, color, starred, note FROM {_TABLE}"
        ).fetchall()
    finally:
        conn.close()
    return {row["uid"]: _row_to_node(row) for row in rows}


def list_nodes() -> list[BoardNode]:
    """Return all board nodes."""
    return list(load().values())


def upsert(uid: str, partial: dict[str, Any]) -> BoardNode:
    """Merge ``partial`` into the node for ``uid`` (creating it if needed) and
    persist it. Returns the resulting node.
    """
    # Only allow contract fields to be merged; ignore anything else.
    allowed = {"x", "y", "color", "starred", "note"}
    clean = {k: v for k, v in partial.items() if k in allowed}

    _ensure_init()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                f"SELECT uid, x, y, color, starred, note FROM {_TABLE} WHERE uid = ?",
                (uid,),
            ).fetchone()
            existing = _row_to_node(row) if row is not None else _default_node(uid)
            merged = existing.model_copy(update=clean)
            merged.uid = uid  # never let a partial override the identity
            conn.execute(
                f"INSERT INTO {_TABLE} (uid, x, y, color, starred, note, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(uid) DO UPDATE SET "
                "x=excluded.x, y=excluded.y, color=excluded.color, "
                "starred=excluded.starred, note=excluded.note, "
                "updated_at=excluded.updated_at",
                (
                    merged.uid,
                    merged.x,
                    merged.y,
                    merged.color,
                    int(merged.starred),
                    merged.note,
                    _now_iso(),
                ),
            )
            conn.commit()
        finally:
            conn.close()
        return merged


def delete(uid: str) -> bool:
    """Remove a node. Returns True if it existed."""
    _ensure_init()
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute(f"DELETE FROM {_TABLE} WHERE uid = ?", (uid,))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()
