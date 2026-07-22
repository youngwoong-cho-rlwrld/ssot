"""Re-provision paper semantics: omitted → inherit, null → remove, ref → replace.

The bug this locks down: a re-provision that didn't touch the paper used to DROP
it (paper_status 'none'), so the new run lost the hyperparameters. Intent is now
by PRESENCE of the `paper` field (Pydantic model_fields_set), and inheritance
copies from the anchor run (falling back to the latest)."""
import pytest
from fastapi.testclient import TestClient

from app import db, main, runs, settings
from app.paper import PaperResult
from app.pathcheck import PathCheck

_USER = {"x-ssot-user": "u@example.com"}


@pytest.fixture()
def client(tmp_env, monkeypatch):
    db.init_db()
    monkeypatch.setattr(runs, "start_run", lambda *a, **k: None)

    async def ok_precheck(cluster, path):
        return PathCheck(ok=True, resolved_root=path or "/m")

    monkeypatch.setattr(main, "precheck_path", ok_precheck)
    return TestClient(main.app)


def _diagram_with_paper(source_url: str = "http://paper/A", sha: str = "shaA") -> tuple[int, int]:
    """A done diagram+run carrying a paper (the predecessor a re-provision inherits)."""
    diagram_id, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/m", model="claude-fable-5"
    )
    db.update_run_status(run_id, "done")
    db.add_paper(
        run_id, kind="url", source_url=source_url, stored_path="/x/A.txt",
        content_type="text/html", sha256=sha, page_count=None, parsed_title="Paper A",
        panel_path=None,
    )
    return diagram_id, run_id


def test_omitted_paper_inherits(client):
    diagram_id, _ = _diagram_with_paper()
    # No `paper` key → inherit the anchor/latest run's paper.
    res = client.post(f"/api/diagrams/{diagram_id}/runs", headers=_USER, json={})
    assert res.status_code == 201
    new_run_id = res.json()["run_id"]
    assert db.get_paper(new_run_id) is not None
    assert db.get_run(new_run_id)["paper_status"] == "attached"


def test_explicit_null_removes(client):
    diagram_id, _ = _diagram_with_paper()
    res = client.post(f"/api/diagrams/{diagram_id}/runs", headers=_USER, json={"paper": None})
    assert res.status_code == 201
    new_run_id = res.json()["run_id"]
    assert db.get_paper(new_run_id) is None
    assert db.get_run(new_run_id)["paper_status"] == "none"


def test_replace_validates_and_attaches_new_paper(client, monkeypatch):
    diagram_id, _ = _diagram_with_paper(source_url="http://paper/A", sha="shaA")

    async def fake_resolve(paper):
        # A distinct, validated replacement (not the inherited one).
        return PaperResult(
            ok=True, kind="url", source_url="http://paper/B", stored_path="/x/B.txt",
            content_type="text/html", sha256="shaB", page_count=None, parsed_title="Paper B",
            panel_path=None,
        )

    monkeypatch.setattr(main, "_resolve_paper", fake_resolve)
    res = client.post(
        f"/api/diagrams/{diagram_id}/runs", headers=_USER,
        json={"paper": {"kind": "url", "url": "http://paper/B"}},
    )
    assert res.status_code == 201
    paper = db.get_paper(res.json()["run_id"])
    assert paper is not None and paper["sha256"] == "shaB"  # the replacement, not shaA


def test_replace_rejects_broken_paper(client, monkeypatch):
    diagram_id, _ = _diagram_with_paper()

    async def bad_resolve(paper):
        return PaperResult(ok=False, error="unreadable paper")

    monkeypatch.setattr(main, "_resolve_paper", bad_resolve)
    before = len(db.list_runs(diagram_id))
    res = client.post(
        f"/api/diagrams/{diagram_id}/runs", headers=_USER,
        json={"paper": {"kind": "url", "url": "http://broken"}},
    )
    assert res.status_code == 400 and res.json()["error"] == "broken_paper"
    # A rejected paper must not create a run.
    assert len(db.list_runs(diagram_id)) == before


def test_inherits_from_anchor_not_paperless_latest(client):
    """The run-10 scenario: a newer paperless run exists, but re-provisioning from
    an older paper-bearing run inherits ITS paper (anchor beats latest)."""
    diagram_id, run_with_paper = _diagram_with_paper()
    paperless_latest = db.create_run(
        diagram_id=diagram_id, user_email="u@example.com", cluster="local", path="/m",
        model="claude-fable-5",
    )
    db.update_run_status(paperless_latest, "done")
    assert db.get_paper(paperless_latest) is None  # the bug artifact

    res = client.post(
        f"/api/diagrams/{diagram_id}/runs", headers=_USER,
        json={"anchor_run_id": run_with_paper},
    )
    assert res.status_code == 201
    new_run_id = res.json()["run_id"]
    assert db.get_paper(new_run_id) is not None  # inherited the anchor's paper
    assert db.get_run(new_run_id)["paper_status"] == "attached"


def test_inherits_from_latest_when_no_anchor(client):
    diagram_id, _ = _diagram_with_paper()
    # No anchor_run_id and no paper key → fall back to the latest run's paper.
    res = client.post(f"/api/diagrams/{diagram_id}/runs", headers=_USER, json={"path": "/m"})
    assert res.status_code == 201
    assert db.get_paper(res.json()["run_id"]) is not None
