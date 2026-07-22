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


def _payload() -> FinalizePayload:
    return FinalizePayload(
        title="TinyNet — GAM (abc1234)",
        commit_hash="abc1234",
        canvas=FinalizeCanvas(width=680, height=1000),
        sources=[FinalizeSource(source_key="s1", name="model.py", content_b64=_b64(_SRC), line_count=3)],
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
    db.persist_finalize(run_id, _payload())

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


def test_reconcile_stale_runs_fails_orphaned_running(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    _backdate_run(run_id, 60)  # older than the guard window

    ids = db.reconcile_stale_runs()
    assert ids == [run_id]
    run = db.get_run(run_id)
    assert run["status"] == "error"
    assert run["error_kind"] == "agent_failure"
    assert "restarted" in run["error_detail"]


def test_reconcile_stale_runs_skips_fresh_and_terminal(tmp_env):
    db.init_db()
    # A run created just now must not be reconciled (guard window).
    _, fresh = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    # An already-terminal run must be left untouched.
    _, done = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    _backdate_run(done, 60)
    db.update_run_status(done, "done")

    ids = db.reconcile_stale_runs()
    assert fresh not in ids and done not in ids
    assert db.get_run(fresh)["status"] == "running"
    assert db.get_run(done)["status"] == "done"


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
