"""Detached-worker spawn + DB-tailing SSE.

``start_run`` must launch ``python -m app.run_worker <id>`` as a detached process
and record its pid; ``event_stream`` must reconstruct the whole stream (replay +
terminal) from the DB alone, with no in-process pubsub.
"""
import json
import signal
import sys

import pytest
from fastapi.testclient import TestClient

from app import db, main, runs


def _mk_run() -> int:
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="claude-fable-5"
    )
    return run_id


class _FakeProc:
    def __init__(self, pid: int):
        self.pid = pid

    def wait(self, timeout=None):  # reaped by the daemon thread start_run spawns
        return 0


def test_start_run_spawns_detached_worker_and_records_pid(tmp_env, monkeypatch):
    run_id = _mk_run()
    captured: dict = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return _FakeProc(pid=4321)

    monkeypatch.setattr(runs.subprocess, "Popen", fake_popen)
    runs.start_run(run_id, user_email="u@example.com")

    assert captured["args"][0] == sys.executable
    assert captured["args"][1:] == ["-m", "app.run_worker", str(run_id)]
    # Detached into its own session so a web-process restart never kills it.
    assert captured["kwargs"]["start_new_session"] is True
    assert captured["kwargs"]["cwd"] == runs._BACKEND_DIR
    # The worker + its MCP child resolve the SAME DB the web process is using.
    assert "MODEL_DIAGRAM_DB" in captured["kwargs"]["env"]
    assert db.get_run(run_id)["pid"] == 4321


def test_start_run_fails_run_when_spawn_raises(tmp_env, monkeypatch):
    run_id = _mk_run()

    def boom(*a, **k):
        raise OSError("no fork for you")

    monkeypatch.setattr(runs.subprocess, "Popen", boom)
    runs.start_run(run_id, user_email="u@example.com")
    run = db.get_run(run_id)
    assert run["status"] == "error"
    assert run["error_kind"] == "agent_failure"


async def _collect(run_id: int) -> list[dict]:
    return [json.loads(frame["data"]) async for frame in runs.event_stream(run_id)]


async def test_event_stream_replays_and_terminates_from_db(tmp_env):
    run_id = _mk_run()
    db.add_stage_event(run_id, "inspecting_root", "looking")
    db.add_output_line(run_id, "→ read_file model.py")
    db.add_stage_event(run_id, "finalizing", "")
    db.mark_terminal(run_id, "done")

    frames = await _collect(run_id)
    types = [f["type"] for f in frames]
    # Replayed stages + the agent-output log line, then the terminal frame — all
    # reconstructed from the DB with no live worker and no in-memory pubsub.
    assert types.count("stage") == 2
    assert {"stage": "inspecting_root", "detail": "looking"}.items() <= frames[0].items()
    log = next(f for f in frames if f["type"] == "log")
    assert log["line"] == "→ read_file model.py" and log["seq"] == 1
    assert frames[-1] == {"type": "done", "run_id": run_id}


async def test_event_stream_emits_mismatch_warning_and_error(tmp_env):
    run_id = _mk_run()
    db.set_paper_status(run_id, "mismatch", "paper is for a different model")
    db.mark_terminal(run_id, "error", error_kind="agent_failure", error_detail="boom")

    frames = await _collect(run_id)
    warn = next(f for f in frames if f["type"] == "warning")
    assert warn == {"type": "warning", "kind": "paper_mismatch", "detail": "paper is for a different model"}
    assert frames[-1] == {"type": "error", "kind": "agent_failure", "detail": "boom"}


async def test_event_stream_reconciles_dead_worker_while_tailing(tmp_env, monkeypatch):
    """A run whose worker is dead must resolve to an error frame, not hang."""
    monkeypatch.setattr(runs, "_POLL_SECONDS", 0.01)
    run_id = _mk_run()
    db.set_run_pid(run_id, 2**31 - 1)  # dead pid → reconciled on the first poll

    frames = await _collect(run_id)
    assert frames[-1]["type"] == "error"
    assert db.get_run(run_id)["status"] == "error"


# ── cancellation ────────────────────────────────────────────────────────────

_FAKE_PID = 2**31 - 1  # out of range → os.getpgid raises, os.kill(_,0) reports dead


async def test_cancel_run_marks_cancelled_and_signals_group(tmp_env, monkeypatch):
    run_id = _mk_run()
    db.set_run_pid(run_id, _FAKE_PID)
    calls: list[tuple] = []
    monkeypatch.setattr(runs.os, "killpg", lambda pgid, sig: calls.append((pgid, sig)))

    result = await runs.cancel_run(run_id, grace_seconds=0.05)
    assert result == "cancelled"
    run = db.get_run(run_id)
    assert run["status"] == "error"
    assert run["error_kind"] == "cancelled"
    assert run["error_detail"] == "cancelled by user"
    # SIGTERM'd the worker's process group (pgid falls back to the pid here).
    assert calls and calls[0] == (_FAKE_PID, signal.SIGTERM)
    # The cancellation is visible in the agent-output log too.
    assert any("cancelled" in r["line"] for r in db.list_output(run_id))


async def test_cancel_run_rejects_non_running(tmp_env, monkeypatch):
    run_id = _mk_run()
    db.mark_terminal(run_id, "done")
    monkeypatch.setattr(runs.os, "killpg", lambda *a: (_ for _ in ()).throw(AssertionError("must not signal")))
    assert await runs.cancel_run(run_id) == "not_running"
    assert db.get_run(run_id)["status"] == "done"


async def test_cancel_run_not_found(tmp_env):
    db.init_db()
    assert await runs.cancel_run(999999) == "not_found"


def test_cancel_endpoint_404_and_409(tmp_env):
    db.init_db()
    client = TestClient(main.app)
    headers = {"x-ssot-user": "u@example.com"}
    assert client.post("/api/runs/999/cancel", headers=headers).status_code == 404
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="claude-fable-5"
    )
    db.mark_terminal(run_id, "done")
    assert client.post(f"/api/runs/{run_id}/cancel", headers=headers).status_code == 409
