"""Follow-up chat: worker spawn, revise-persist, MCP chat dispatch, DB-tail, endpoints."""
import json
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from app import chat, chat_worker, db, main, runs, settings
from app.pathcheck import PathCheck
from tests.test_db import _SRC, _payload, _source_b64, fake_fs  # known-good payload + fs stub

_USER = {"x-ssot-user": "u@example.com"}
_SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "mcp_server.py")


def _done_diagram() -> tuple[int, int]:
    """A diagram with one completed run (chat is only offered on a done run)."""
    diagram_id, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/models/tiny", model="claude-fable-5"
    )
    db.update_run_status(run_id, "done")
    return diagram_id, run_id


def _attach_text_paper(tmp_path, run_id: int, text: str = "PAPER: the head hidden dim is 4.") -> str:
    """Attach an HTML/text paper (stored on disk) to a run, as inheritance would."""
    stored = tmp_path / f"paper-{run_id}.txt"
    stored.write_text(text, encoding="utf-8")
    db.add_paper(
        run_id, kind="url", source_url="http://example.com/paper", stored_path=str(stored),
        content_type="text/html", sha256=f"sha-{run_id}", page_count=None,
        parsed_title="A Paper", panel_path=None,
    )
    return text


def _async_return(value):
    async def _fn(*_args, **_kwargs):
        return value
    return _fn


# ── chat tool set + summary ─────────────────────────────────────────────────


def test_chat_tools_are_fs_plus_revise():
    names = {s["name"] for s in chat.chat_tool_specs()}
    assert names == {"list_dir", "read_file", "revise_diagram"}


# ── paper injection into the chat context ───────────────────────────────────


def test_chat_system_prompt_advertises_paper_and_citation_rule():
    via_tool = chat.build_chat_system_prompt("local", "/r", has_paper=True, paper_via_tool=True)
    assert "__paper__" in via_tool  # CLI reads it through the virtual read_file path
    # The revise-must-cite-verbatim rule is guard-specific (the base spec also mentions
    # paper_citations, so key on the unique guard phrase).
    assert "VERBATIM quote from the paper" in via_tool
    injected = chat.build_chat_system_prompt("local", "/r", has_paper=True, paper_via_tool=False)
    assert "attached in your first message" in injected and "__paper__" not in injected
    none = chat.build_chat_system_prompt("local", "/r", has_paper=False)
    assert "No paper is attached" in none and "VERBATIM quote from the paper" not in none


def test_chat_initial_user_notes_paper_presence():
    via_tool = chat.build_chat_initial_user("SUM", [], "hi", has_paper=True, paper_via_tool=True)
    assert "__paper__" in via_tool
    injected = chat.build_chat_initial_user("SUM", [], "hi", has_paper=True, paper_via_tool=False)
    assert "attached below" in injected
    plain = chat.build_chat_initial_user("SUM", [], "hi")
    assert "SOURCE PAPER" not in plain


async def test_worker_injects_paper_block_on_sdk(tmp_env, tmp_path, monkeypatch):
    db.init_db()
    diagram_id, run_id = _done_diagram()
    text = _attach_text_paper(tmp_path, run_id)
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    db.add_chat_message(thread_id, role="user", content="does it match the paper?",
                        status="done", anchor_run_id=run_id)
    msg = db.add_chat_message(thread_id, role="assistant", status="pending", anchor_run_id=run_id)

    monkeypatch.setattr(chat_worker, "precheck_path",
                        _async_return(PathCheck(ok=True, resolved_root=str(tmp_path))))
    monkeypatch.setattr(chat_worker, "resolve_access", _async_return({"kind": "local"}))
    monkeypatch.setattr(settings, "runtime_for_model", lambda _m: "sdk")

    captured: dict = {}

    async def fake_sdk(**kwargs):
        captured.update(kwargs)
        kwargs["outcome"].status = "done"
        kwargs["outcome"].answer_text = "ok"

    monkeypatch.setattr(chat, "run_chat_sdk", fake_sdk)
    await chat_worker.execute_chat(msg["id"])

    assert captured["paper_block"]  # non-empty — the anchor run's paper rode along
    assert text in json.dumps(captured["paper_block"])
    assert captured["user_message"] == "does it match the paper?"


async def test_worker_injects_paper_ref_on_cli(tmp_env, tmp_path, monkeypatch):
    db.init_db()
    diagram_id, run_id = _done_diagram()
    text = _attach_text_paper(tmp_path, run_id)
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    db.add_chat_message(thread_id, role="user", content="map the paper", status="done", anchor_run_id=run_id)
    msg = db.add_chat_message(thread_id, role="assistant", status="pending", anchor_run_id=run_id)

    monkeypatch.setattr(chat_worker, "precheck_path",
                        _async_return(PathCheck(ok=True, resolved_root=str(tmp_path))))
    monkeypatch.setattr(chat_worker, "resolve_access", _async_return({"kind": "local"}))
    monkeypatch.setattr(settings, "runtime_for_model", lambda _m: "claude-cli")

    captured: dict = {}

    async def fake_cli(**kwargs):
        captured.update(kwargs)
        kwargs["outcome"].status = "done"
        kwargs["outcome"].answer_text = "ok"

    monkeypatch.setattr(chat, "run_chat_cli", fake_cli)
    await chat_worker.execute_chat(msg["id"])

    assert captured["has_paper"] is True
    assert captured["paper_text"] == text


async def test_worker_no_paper_passes_empty(tmp_env, tmp_path, monkeypatch):
    db.init_db()
    diagram_id, run_id = _done_diagram()  # no paper attached
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    db.add_chat_message(thread_id, role="user", content="hi", status="done", anchor_run_id=run_id)
    msg = db.add_chat_message(thread_id, role="assistant", status="pending", anchor_run_id=run_id)

    monkeypatch.setattr(chat_worker, "precheck_path",
                        _async_return(PathCheck(ok=True, resolved_root=str(tmp_path))))
    monkeypatch.setattr(chat_worker, "resolve_access", _async_return({"kind": "local"}))
    monkeypatch.setattr(settings, "runtime_for_model", lambda _m: "sdk")

    captured: dict = {}

    async def fake_sdk(**kwargs):
        captured.update(kwargs)
        kwargs["outcome"].status = "done"
        kwargs["outcome"].answer_text = "ok"

    monkeypatch.setattr(chat, "run_chat_sdk", fake_sdk)
    await chat_worker.execute_chat(msg["id"])
    assert captured["paper_block"] == []


def test_build_diagram_summary(tmp_env):
    db.init_db()
    _, run_id = _done_diagram()
    db.persist_finalize(run_id, _payload(), _source_b64())
    summary = chat.build_diagram_summary(run_id)
    assert "TinyNet" in summary
    assert "Dataset" in summary and "Head" in summary
    assert "hidden dim" in summary  # citation label surfaced


# ── revise persists a NEW run under the diagram ─────────────────────────────


async def test_handle_revise_persists_new_run(tmp_env):
    db.init_db()
    diagram_id, run_id = _done_diagram()
    anchor = db.get_run(run_id)
    outcome = chat.ChatOutcome()
    revise_cb = chat.make_revise_cb(
        anchor_run=anchor, diagram_id=diagram_id, user_email="u@example.com", outcome=outcome, fs=fake_fs()
    )
    result, is_error = await chat.handle_revise(outcome, revise_cb, _payload().model_dump())
    assert not is_error and result["ok"] is True
    assert outcome.revised is True and outcome._terminal is True
    new_run_id = outcome.revise_run_id
    assert new_run_id and new_run_id != run_id
    new_run = db.get_run(new_run_id)
    assert new_run["diagram_id"] == diagram_id
    assert new_run["status"] == "done"
    assert new_run["rendered_html"] and new_run["title"] == "TinyNet — GAM (abc1234)"
    # The revision is a sibling run under the same diagram.
    assert {r["id"] for r in db.list_runs(diagram_id)} >= {run_id, new_run_id}


async def test_revise_retains_paper_on_new_run(tmp_env, tmp_path):
    """A chat revision copies the anchor run's paper to the new run, so its finalize
    can validate paper_citations (a revision that dropped the paper couldn't)."""
    db.init_db()
    diagram_id, run_id = _done_diagram()
    _attach_text_paper(tmp_path, run_id)
    anchor = db.get_run(run_id)
    outcome = chat.ChatOutcome()
    revise_cb = chat.make_revise_cb(
        anchor_run=anchor, diagram_id=diagram_id, user_email="u@example.com", outcome=outcome, fs=fake_fs()
    )
    # The copied paper is matched, so the revise finalize must carry a quoted
    # citation (same §7.1 coverage rule as a fresh run).
    raw = _payload().model_dump()
    raw["components"][1]["paper_citations"][0]["paper_quote"] = "The hidden dim is 512."
    result, is_error = await chat.handle_revise(outcome, revise_cb, raw)
    assert not is_error and result["ok"] is True
    assert db.get_paper(outcome.revise_run_id) is not None


async def test_handle_revise_rejects_bad_payload_then_gives_up(tmp_env, monkeypatch):
    monkeypatch.setattr("app.settings.MAX_FINALIZE_ATTEMPTS", 1)
    db.init_db()
    diagram_id, run_id = _done_diagram()
    anchor = db.get_run(run_id)
    outcome = chat.ChatOutcome()
    revise_cb = chat.make_revise_cb(
        anchor_run=anchor, diagram_id=diagram_id, user_email="u@example.com", outcome=outcome, fs=fake_fs()
    )
    result, is_error = await chat.handle_revise(outcome, revise_cb, {"title": "nope"})
    assert is_error and result["ok"] is False
    assert outcome.status == "error" and outcome._terminal is True
    # The lazily-created revision run is closed as error, not left dangling 'running'.
    assert db.get_run(outcome.revise_run_id)["status"] == "error"


# ── chat worker spawn arg construction ──────────────────────────────────────


class _FakeProc:
    def __init__(self, pid):
        self.pid = pid

    def wait(self, timeout=None):
        return 0


def test_start_chat_spawns_detached_worker(tmp_env, monkeypatch):
    db.init_db()
    diagram_id, run_id = _done_diagram()
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    msg = db.add_chat_message(thread_id, role="assistant", status="pending", anchor_run_id=run_id)
    captured = {}

    def fake_popen(argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return _FakeProc(pid=7777)

    monkeypatch.setattr(runs.subprocess, "Popen", fake_popen)
    runs.start_chat(msg["id"])
    assert captured["argv"][0] == sys.executable
    assert captured["argv"][1:] == ["-m", "app.chat_worker", str(msg["id"])]
    assert captured["kwargs"]["start_new_session"] is True
    assert db.get_chat_message(msg["id"])["pid"] == 7777


def test_chat_threads_migrate_to_per_run(tmp_env):
    """An old per-diagram chat_threads (UNIQUE(diagram_id)) migrates to per-run,
    backfilling run_id to the diagram's latest run and preserving the transcript."""
    db.init_db()
    diagram_id, run_id = _done_diagram()

    conn = db._connect()
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.executescript(
            """
            DROP TABLE chat_threads;
            CREATE TABLE chat_threads (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              diagram_id INTEGER NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
              user_email TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(diagram_id)
            );
            """
        )
        conn.execute(
            "INSERT INTO chat_threads (id, diagram_id, user_email, created_at, updated_at) "
            "VALUES (1, ?, 'u@example.com', 't', 't')",
            (diagram_id,),
        )
        conn.execute(
            "INSERT INTO chat_messages (thread_id, anchor_run_id, role, content, status, seq, created_at, updated_at) "
            "VALUES (1, ?, 'user', 'legacy message', 'done', 1, 't', 't')",
            (run_id,),
        )
        conn.commit()
        conn.execute("PRAGMA foreign_keys = ON")
    finally:
        conn.close()

    db.init_db()  # runs the per-run rebuild

    cols = {r["name"] for r in db._connect().execute("PRAGMA table_info(chat_threads)").fetchall()}
    assert "run_id" in cols
    # The legacy thread now points at the diagram's latest run, and its message survived.
    assert db.get_or_create_thread(run_id, diagram_id, "u@example.com") == 1
    assert [m["content"] for m in db.list_chat_messages(1)] == ["legacy message"]


# ── MCP chat-mode revise dispatch (Claude-CLI path) ─────────────────────────


def test_mcp_chat_revise_persists_and_stamps(tmp_path, monkeypatch):
    dbfile = tmp_path / "md.db"
    monkeypatch.setenv("MODEL_DIAGRAM_DB", str(dbfile))
    monkeypatch.setenv("SSOT_DATA_DIR", str(tmp_path / "data"))
    db.init_db()
    diagram_id, run_id = _done_diagram()
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    msg = db.add_chat_message(thread_id, role="assistant", status="pending", anchor_run_id=run_id)
    # The revise flow fetches the named source's bytes from the root at finalize time.
    (tmp_path / "model.py").write_text(_SRC)

    env = dict(os.environ)
    env.update({
        "MD_CLUSTER": "local", "MD_ROOT": str(tmp_path), "MD_CHAT": "1",
        "MD_CHAT_MESSAGE_ID": str(msg["id"]), "MODEL_DIAGRAM_DB": str(dbfile),
        "MD_ACCESS_JSON": '{"kind":"local"}',
    })
    proc = subprocess.Popen(
        [sys.executable, _SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, env=env,
    )
    try:
        def rpc(rid, method, params=None):
            m = {"jsonrpc": "2.0", "id": rid, "method": method}
            if params is not None:
                m["params"] = params
            proc.stdin.write(json.dumps(m) + "\n")
            proc.stdin.flush()
            return json.loads(proc.stdout.readline())

        rpc(1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
        names = {t["name"] for t in rpc(2, "tools/list")["result"]["tools"]}
        assert names == {"list_dir", "read_file", "revise_diagram"}
        r = rpc(3, "tools/call", {"name": "revise_diagram", "arguments": _payload().model_dump()})
        payload = json.loads(r["result"]["content"][0]["text"])
        assert payload["ok"] is True and not r["result"].get("isError")
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    stamped = db.get_chat_message(msg["id"])
    assert stamped["revised_run_id"]
    new_run = db.get_run(stamped["revised_run_id"])
    assert new_run["diagram_id"] == diagram_id and new_run["status"] == "done"


# ── chat DB-tail stream ─────────────────────────────────────────────────────


async def test_chat_event_stream_replays_and_terminates(tmp_env):
    db.init_db()
    diagram_id, run_id = _done_diagram()
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    msg = db.add_chat_message(thread_id, role="assistant", status="pending", anchor_run_id=run_id)
    db.add_chat_output_line(msg["id"], "→ read_file model.py")
    db.finish_chat_message(msg["id"], "done", content="It reads the head from model.py:2.")

    frames = [json.loads(f["data"]) async for f in runs.chat_event_stream(msg["id"])]
    types = [f["type"] for f in frames]
    assert "log" in types
    final = frames[-1]
    assert final["type"] == "message" and final["status"] == "done"
    assert final["content"] == "It reads the head from model.py:2."


async def test_chat_event_stream_reconciles_dead_worker(tmp_env, monkeypatch):
    monkeypatch.setattr(runs, "_POLL_SECONDS", 0.01)
    db.init_db()
    diagram_id, run_id = _done_diagram()
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    msg = db.add_chat_message(thread_id, role="assistant", status="pending", anchor_run_id=run_id)
    db.set_chat_pid(msg["id"], 2**31 - 1)  # dead pid → reconciled on first poll

    frames = [json.loads(f["data"]) async for f in runs.chat_event_stream(msg["id"])]
    assert frames[-1]["status"] == "error"
    assert db.get_chat_message(msg["id"])["status"] == "error"


# ── endpoints ───────────────────────────────────────────────────────────────


@pytest.fixture()
def client(tmp_env, monkeypatch):
    db.init_db()
    monkeypatch.setattr(runs, "start_chat", lambda *a, **k: None)
    return TestClient(main.app)


def test_post_chat_creates_turn_and_history(client):
    _, run_id = _done_diagram()
    res = client.post(f"/api/runs/{run_id}/chat", headers=_USER,
                      json={"message": "why is the head 4-dim?"})
    assert res.status_code == 201
    assistant_id = res.json()["assistant_message_id"]
    assert db.get_chat_message(assistant_id)["status"] == "pending"
    # History carries the user turn + the pending assistant turn.
    hist = client.get(f"/api/runs/{run_id}/chat", headers=_USER).json()
    roles = [m["role"] for m in hist["messages"]]
    assert roles == ["user", "assistant"]
    assert hist["messages"][0]["content"] == "why is the head 4-dim?"


def test_chat_is_per_run(client):
    """Two runs under one diagram have INDEPENDENT transcripts."""
    diagram_id, run1 = _done_diagram()
    run2 = db.create_run(diagram_id=diagram_id, user_email="u@example.com",
                         cluster="local", path="/models/tiny", model="claude-fable-5")
    db.update_run_status(run2, "done")
    client.post(f"/api/runs/{run1}/chat", headers=_USER, json={"message": "about run 1"})
    client.post(f"/api/runs/{run2}/chat", headers=_USER, json={"message": "about run 2"})
    h1 = client.get(f"/api/runs/{run1}/chat", headers=_USER).json()
    h2 = client.get(f"/api/runs/{run2}/chat", headers=_USER).json()
    assert h1["thread_id"] != h2["thread_id"]
    assert h1["messages"][0]["content"] == "about run 1"
    assert h2["messages"][0]["content"] == "about run 2"
    assert all("run 2" not in m["content"] for m in h1["messages"])


def test_post_chat_uses_given_model(client):
    _, run_id = _done_diagram()  # run model = claude-fable-5
    res = client.post(f"/api/runs/{run_id}/chat", headers=_USER,
                      json={"message": "hi", "model": "claude-haiku-4-5"})
    assert res.status_code == 201
    assert db.get_chat_message(res.json()["assistant_message_id"])["model"] == "claude-haiku-4-5"


def test_post_chat_defaults_to_run_model(client):
    _, run_id = _done_diagram()
    res = client.post(f"/api/runs/{run_id}/chat", headers=_USER, json={"message": "hi"})
    assert res.status_code == 201
    assert db.get_chat_message(res.json()["assistant_message_id"])["model"] == "claude-fable-5"


def test_post_chat_rejects_unknown_model(client):
    _, run_id = _done_diagram()
    res = client.post(f"/api/runs/{run_id}/chat", headers=_USER,
                      json={"message": "hi", "model": "totally-bogus-9"})
    assert res.status_code == 422


def test_post_chat_rejects_running_run(client):
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="claude-fable-5"
    )  # still 'running'
    res = client.post(f"/api/runs/{run_id}/chat", headers=_USER, json={"message": "hi"})
    assert res.status_code == 409


def test_chat_cancel_404_and_409(client):
    diagram_id, run_id = _done_diagram()
    assert client.post("/api/chat/999999/cancel", headers=_USER).status_code == 404
    thread_id = db.get_or_create_thread(run_id, diagram_id, "u@example.com")
    msg = db.add_chat_message(thread_id, role="assistant", status="done", anchor_run_id=run_id)
    assert client.post(f"/api/chat/{msg['id']}/cancel", headers=_USER).status_code == 409
