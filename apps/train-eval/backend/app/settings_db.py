"""Synchronous access to the gateway-owned per-user settings database.

``~/.ssot/ssot.db`` is the only persistent source for account settings.  This
module intentionally keeps synchronous getters because submission rendering
uses settings from deep synchronous call paths.  Connections are short-lived,
read one small namespace, and use SQLite's WAL/busy-timeout support.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import user_context


def db_path() -> Path:
    root = Path(os.path.expanduser(os.environ.get("SSOT_DATA_DIR", "~/.ssot")))
    return root.resolve() / "ssot.db"


def _email(explicit: str | None = None) -> str | None:
    value = explicit if explicit is not None else user_context.current_user_email()
    if not value:
        return None
    return value.strip().lower() or None


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(db_path(), timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def get_namespace(namespace: str, *, email: str | None = None) -> dict[str, Any]:
    principal = _email(email)
    path = db_path()
    if principal is None or not path.is_file():
        return {}
    connection: sqlite3.Connection | None = None
    try:
        connection = _connect()
        rows = connection.execute(
            """
            SELECT s.key, s.value
            FROM user_settings AS s
            JOIN users AS u ON u.id = s.user_id
            WHERE lower(u.email) = ? AND s.namespace = ?
            """,
            (principal, namespace),
        ).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        if connection is not None:
            connection.close()

    out: dict[str, Any] = {}
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            out[row["key"]] = row["value"]
    return out


def list_principals(namespace: str) -> list[str]:
    """Exact emails with at least one value in ``namespace``."""
    path = db_path()
    if not path.is_file():
        return []
    connection: sqlite3.Connection | None = None
    try:
        connection = _connect()
        rows = connection.execute(
            """
            SELECT DISTINCT lower(u.email) AS email
            FROM user_settings AS s
            JOIN users AS u ON u.id = s.user_id
            WHERE s.namespace = ?
            ORDER BY email
            """,
            (namespace,),
        ).fetchall()
        return [str(row["email"]) for row in rows]
    except sqlite3.Error:
        return []
    finally:
        if connection is not None:
            connection.close()


def mutate_key(
    namespace: str,
    key: str,
    mutate: Callable[[Any], Any],
    *,
    email: str | None = None,
) -> Any:
    """Atomically transform one top-level settings value."""
    principal = _email(email)
    if principal is None:
        raise ValueError("authenticated SSOT user required")
    connection = _connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        user = connection.execute(
            "SELECT id FROM users WHERE lower(email) = ?", (principal,)
        ).fetchone()
        if user is None:
            raise ValueError("SSOT user is not registered")
        user_id = int(user["id"])
        row = connection.execute(
            """
            SELECT value FROM user_settings
            WHERE user_id = ? AND namespace = ? AND key = ?
            """,
            (user_id, namespace, key),
        ).fetchone()
        current: Any = None
        if row is not None:
            try:
                current = json.loads(row["value"])
            except (TypeError, json.JSONDecodeError):
                current = row["value"]
        updated = mutate(current)
        connection.execute(
            """
            INSERT INTO user_settings (user_id, namespace, key, value, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, namespace, key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
            """,
            (
                user_id,
                namespace,
                key,
                json.dumps(updated),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        connection.commit()
        return updated
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def set_key(
    namespace: str, key: str, value: Any, *, email: str | None = None
) -> Any:
    return mutate_key(namespace, key, lambda _current: value, email=email)


def update_section(
    namespace: str,
    section: str,
    values: dict[str, Any],
    *,
    email: str | None = None,
) -> dict[str, Any]:
    def merge(existing: Any) -> dict[str, Any]:
        merged = dict(existing) if isinstance(existing, dict) else {}
        merged.update(values)
        return merged

    return mutate_key(namespace, section, merge, email=email)
