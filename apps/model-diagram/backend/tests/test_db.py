import base64

from app import db
from app.schemas import (
    FinalizeCanvas,
    FinalizeComponent,
    FinalizeEdge,
    FinalizePayload,
    FinalizePaperCitation,
    FinalizePosition,
    FinalizeSnippet,
    FinalizeSource,
)

_SRC = "class M:\n    d = 1\n    e = 2\n"


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _source_b64() -> dict[str, str]:
    """The fetched-content map persist_finalize now takes (source_key -> base64)."""
    return {"s1": _b64(_SRC)}


class _FakeFs:
    """Stand-in for FsAccess: serves named files from an in-memory map.

    The finalize flow now fetches source bytes itself, so finalize/chat tests hand
    it this instead of pasting base64 into the payload.
    """

    def __init__(self, files: dict[str, str] | None = None):
        self._files = files if files is not None else {"model.py": _SRC}

    async def read_file(self, name: str, *args, **kwargs) -> str:
        from app.fsaccess import FsError

        if name not in self._files:
            raise FsError(f"no such file under root: {name}")
        return self._files[name]


def fake_fs(files: dict[str, str] | None = None) -> _FakeFs:
    return _FakeFs(files)


def _payload() -> FinalizePayload:
    return FinalizePayload(
        title="TinyNet — GAM (abc1234)",
        commit_hash="abc1234",
        canvas=FinalizeCanvas(width=680, height=1000),
        sources=[FinalizeSource(source_key="s1", name="model.py", line_count=3)],
        components=[
            FinalizeComponent(
                component_key="dataset",
                kebab_id="dataset",
                kind="component",
                name_html="Dataset",
                shape_html="[B, T]",
                position=FinalizePosition(left=150, top=20, width=380, min_height=72),
                snippets=[FinalizeSnippet(source_key="s1", start=1, end=3)],
            ),
            FinalizeComponent(
                component_key="head",
                kebab_id="head",
                kind="component",
                name_html="Head",
                position=FinalizePosition(left=245, top=200, width=190, min_height=62),
                snippets=[FinalizeSnippet(source_key="s1", start=2, end=2)],
                paper_citations=[
                    FinalizePaperCitation(
                        label="hidden dim",
                        paper_value="512",
                        paper_location="§3 / Table 1",
                        code_value="1",
                        confidence="medium",
                    )
                ],
            ),
        ],
        edges=[FinalizeEdge(path_d="M 340 92 V 200", from_component_key="dataset", to_component_key="head")],
    )


def test_diagram_run_roundtrip(tmp_env):
    db.init_db()
    diagram_id, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/models/tiny", model="claude-opus-4-8"
    )
    assert diagram_id > 0 and run_id > 0

    run = db.get_run(run_id)
    assert run["status"] == "running"
    assert run["diagram_id"] == diagram_id

    db.add_stage_event(run_id, "inspecting_root", "looks good")
    db.add_stage_event(run_id, "pinning_commit", "")
    events = db.list_stage_events(run_id)
    assert [e["stage"] for e in events] == ["inspecting_root", "pinning_commit"]


def test_persist_and_load_model(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/models/tiny", model="m"
    )
    db.persist_finalize(run_id, _payload(), _source_b64())

    model = db.load_diagram_model(run_id)
    assert model["run"]["title"] == "TinyNet — GAM (abc1234)"
    assert model["run"]["canvas_height"] == 1000
    assert model["sources"][0]["line_count"] == 3
    assert {c["component_key"] for c in model["components"]} == {"dataset", "head"}
    assert len(model["edges"]) == 1
    assert model["citations"][0]["label"] == "hidden dim"
    head_id = next(c["id"] for c in model["components"] if c["component_key"] == "head")
    assert model["edges"][0]["to_component_id"] == head_id
    assert model["citations"][0]["component_id"] == head_id


def test_paper_status_update(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    db.set_paper_status(run_id, "mismatch", "paper is for a different model")
    run = db.get_run(run_id)
    assert run["paper_status"] == "mismatch"
    assert run["paper_warning"] == "paper is for a different model"


def test_add_paper_marks_run_attached(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    assert db.get_run(run_id)["paper_status"] == "none"
    db.add_paper(
        run_id,
        kind="url",
        source_url="https://arxiv.org/pdf/1234.5678",
        stored_path="/papers/x.pdf",
        content_type="application/pdf",
        sha256="deadbeef",
        page_count=8,
        parsed_title="A Paper",
    )
    assert db.get_run(run_id)["paper_status"] == "attached"


def test_add_paper_does_not_clobber_mismatch(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    db.set_paper_status(run_id, "mismatch", "wrong model")
    db.add_paper(
        run_id, kind="pdf", source_url=None, stored_path="/papers/y.pdf",
        content_type="application/pdf", sha256="beef", page_count=3, parsed_title=None,
    )
    assert db.get_run(run_id)["paper_status"] == "mismatch"


def _backdate_run(run_id: int, seconds: float) -> None:
    from datetime import datetime, timedelta, timezone

    ts = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()
    conn = db._connect()
    try:
        conn.execute("UPDATE runs SET created_at = ? WHERE id = ?", (ts, run_id))
        conn.commit()
    finally:
        conn.close()


# A pid that is (almost) certainly not a live process: pid 2**31-1 is out of the
# normal range so os.kill(pid, 0) raises ProcessLookupError.
_DEAD_PID = 2**31 - 1


def test_reconcile_orphaned_fails_dead_pid_run(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    db.set_run_pid(run_id, _DEAD_PID)  # worker recorded but no longer alive

    ids = db.reconcile_orphaned_runs()
    assert ids == [run_id]
    run = db.get_run(run_id)
    assert run["status"] == "error"
    assert run["error_kind"] == "agent_failure"
    assert "no longer running" in run["error_detail"]


def test_reconcile_orphaned_keeps_live_pid_run(tmp_env):
    import os

    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    _backdate_run(run_id, 300)  # old, but its worker is alive → must survive
    db.set_run_pid(run_id, os.getpid())  # this test process is unquestionably alive

    ids = db.reconcile_orphaned_runs()
    assert run_id not in ids
    assert db.get_run(run_id)["status"] == "running"


def test_reconcile_orphaned_null_pid_grace(tmp_env):
    db.init_db()
    # Fresh NULL-pid row = a run mid-spawn; must NOT be reconciled.
    _, fresh = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    # Old NULL-pid row = a worker that never came up; reconcile it.
    _, stale = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    _backdate_run(stale, 60)

    ids = db.reconcile_orphaned_runs()
    assert ids == [stale]
    assert db.get_run(fresh)["status"] == "running"
    assert db.get_run(stale)["status"] == "error"


def test_reconcile_orphaned_skips_terminal(tmp_env):
    db.init_db()
    _, done = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    db.set_run_pid(done, _DEAD_PID)
    db.update_run_status(done, "done")

    ids = db.reconcile_orphaned_runs()
    assert done not in ids
    assert db.get_run(done)["status"] == "done"


def test_mark_terminal_is_final_and_guarded(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    # First flip from running → cancelled succeeds.
    assert db.mark_terminal(run_id, "error", error_kind="cancelled", error_detail="cancelled by user") is True
    # A later worker/MCP write cannot resurrect or overwrite the terminal status.
    assert db.mark_terminal(run_id, "error", error_kind="agent_failure", error_detail="boom") is False
    assert db.mark_terminal(run_id, "done") is False
    run = db.get_run(run_id)
    assert run["status"] == "error"
    assert run["error_kind"] == "cancelled"
    assert run["error_detail"] == "cancelled by user"


def test_reconcile_run_if_orphaned_lazy(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    db.set_run_pid(run_id, _DEAD_PID)
    assert db.reconcile_run_if_orphaned(run_id) is True
    assert db.get_run(run_id)["status"] == "error"
    # Idempotent: a second call on the now-terminal run does nothing.
    assert db.reconcile_run_if_orphaned(run_id) is False


# ── agent output capture ───────────────────────────────────────────────────


def test_output_append_and_tail(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    a = db.add_output_line(run_id, "first")
    b = db.add_output_line(run_id, "second")
    assert a["seq"] == 1 and b["seq"] == 2
    assert [r["line"] for r in db.list_output(run_id)] == ["first", "second"]
    # after_seq tails only newer lines.
    assert [r["line"] for r in db.list_output(run_id, after_seq=1)] == ["second"]


def test_output_pruning_caps_lines(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    total = db._OUTPUT_KEEP_LINES + 25
    for i in range(total):
        db.add_output_line(run_id, f"line-{i}")
    rows = db.list_output(run_id)
    assert len(rows) == db._OUTPUT_KEEP_LINES
    # The oldest 25 were pruned; the newest line survives with the highest seq.
    assert rows[-1]["seq"] == total
    assert rows[0]["seq"] == total - db._OUTPUT_KEEP_LINES + 1


def test_list_and_delete(tmp_env):
    db.init_db()
    diagram_id, _ = db.create_diagram_with_run(
        user_email="owner@example.com", cluster="local", path="/p", model="m"
    )
    listed = db.list_diagrams("owner@example.com")
    assert any(d["id"] == diagram_id for d in listed)
    assert db.list_diagrams("other@example.com") == []
    assert not db.delete_diagram(diagram_id, user_email="other@example.com")
    assert db.delete_diagram(diagram_id, user_email="owner@example.com")
    assert db.get_diagram(diagram_id) is None
