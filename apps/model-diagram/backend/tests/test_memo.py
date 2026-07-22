"""Per-diagram memo: additive column migration + the PATCH endpoint."""
import pytest
from fastapi.testclient import TestClient

from app import db, main

_USER = {"x-ssot-user": "u@example.com"}


@pytest.fixture()
def client(tmp_env):
    db.init_db()
    return TestClient(main.app)


def _diagram(email: str = "u@example.com") -> int:
    diagram_id, _ = db.create_diagram_with_run(
        user_email=email, cluster="local", path="/models/tiny", model="claude-fable-5"
    )
    return diagram_id


def test_memo_migration_adds_column_with_default(tmp_env):
    # Simulate a DB created before `memo`: a diagrams table without the column.
    conn = db._connect()
    try:
        conn.executescript(
            "CREATE TABLE diagrams (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "user_email TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL, "
            "updated_at TEXT NOT NULL);"
        )
        conn.execute(
            "INSERT INTO diagrams (user_email, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ("u@example.com", "/p", "t0", "t0"),
        )
        conn.commit()
    finally:
        conn.close()

    db.init_db()  # runs _migrate → adds the memo column
    cols = {r["name"] for r in db._connect().execute("PRAGMA table_info(diagrams)").fetchall()}
    assert "memo" in cols
    # The pre-existing row gets the '' default, not NULL.
    assert db.get_diagram(1)["memo"] == ""


def test_new_diagram_memo_defaults_empty(client):
    diagram_id = _diagram()
    assert db.get_diagram(diagram_id)["memo"] == ""


def test_patch_memo_updates_and_appears_in_payloads(client):
    diagram_id = _diagram()
    res = client.patch(
        f"/api/diagrams/{diagram_id}", headers=_USER, json={"memo": "check the encoder dims"}
    )
    assert res.status_code == 200
    assert res.json() == {"id": diagram_id, "memo": "check the encoder dims"}
    assert db.get_diagram(diagram_id)["memo"] == "check the encoder dims"

    listed = client.get("/api/diagrams", headers=_USER).json()["diagrams"]
    assert any(d["id"] == diagram_id and d["memo"] == "check the encoder dims" for d in listed)
    detail = client.get(f"/api/diagrams/{diagram_id}", headers=_USER).json()
    assert detail["memo"] == "check the encoder dims"


def test_patch_memo_can_clear(client):
    diagram_id = _diagram()
    client.patch(f"/api/diagrams/{diagram_id}", headers=_USER, json={"memo": "x"})
    res = client.patch(f"/api/diagrams/{diagram_id}", headers=_USER, json={"memo": ""})
    assert res.status_code == 200
    assert db.get_diagram(diagram_id)["memo"] == ""


def test_patch_memo_ownership_404(client):
    diagram_id = _diagram(email="owner@example.com")
    res = client.patch(
        f"/api/diagrams/{diagram_id}",
        headers={"x-ssot-user": "someone-else@example.com"},
        json={"memo": "sneaky"},
    )
    assert res.status_code == 404
    assert db.get_diagram(diagram_id)["memo"] == ""  # untouched


def test_patch_memo_unknown_404(client):
    assert client.patch("/api/diagrams/99999", headers=_USER, json={"memo": "x"}).status_code == 404
