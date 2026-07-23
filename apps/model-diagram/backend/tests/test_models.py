"""Model allowlist + the chosen model plumbed onto the run row.

Unit-covers the settings allowlist helpers, then drives the create/reprovision
endpoints (with the path precheck and the detached run task stubbed out) to prove
a request's model reaches the ``runs.model`` column and that an off-allowlist id
is rejected with HTTP 422.
"""
import pytest
from fastapi.testclient import TestClient

from app import db, main, runs, settings
from app.pathcheck import PathCheck

_USER = {"x-ssot-user": "u@example.com"}


# ── settings allowlist ─────────────────────────────────────────────────────


def test_default_model_is_claude_fable(monkeypatch):
    monkeypatch.delenv("MODEL_DIAGRAM_MODEL", raising=False)
    assert settings.model_name() == "claude-fable-5"
    assert settings.default_model() == "claude-fable-5"


def test_model_catalog_shape_and_default_present():
    catalog = settings.model_catalog()
    assert catalog[0] == {"id": "claude-fable-5", "label": "Claude Fable"}
    ids = {m["id"] for m in catalog}
    assert {"claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"} <= ids
    assert settings.default_model() in ids


def test_resolve_model_defaults_and_validates(monkeypatch):
    monkeypatch.delenv("MODEL_DIAGRAM_MODEL", raising=False)
    assert settings.resolve_model(None) == "claude-fable-5"
    assert settings.resolve_model("claude-opus-4-8") == "claude-opus-4-8"
    with pytest.raises(ValueError):
        settings.resolve_model("claude-bogus-9")


def test_default_model_clamps_off_allowlist_override(monkeypatch):
    # An env override outside the allowlist must not become the UI default, or the
    # select would carry a value that isn't one of its options.
    monkeypatch.setenv("MODEL_DIAGRAM_MODEL", "some-private-model")
    assert settings.default_model() == "claude-fable-5"


# ── endpoint plumbing ──────────────────────────────────────────────────────


@pytest.fixture()
def client(tmp_env, monkeypatch):
    db.init_db()
    # Keep the path precheck and the detached agent task out of these tests: we
    # only care that the endpoint stores the right model on the run row.
    async def _ok_path(cluster, path):
        return PathCheck(ok=True, resolved_root="/models/tiny")

    monkeypatch.setattr(main, "precheck_path", _ok_path)
    monkeypatch.setattr(runs, "start_run", lambda *a, **k: None)
    return TestClient(main.app)


def test_models_endpoint(client, monkeypatch):
    # Force a known runtime state: claude available (SDK key), codex CLI absent.
    monkeypatch.setattr(settings, "anthropic_api_key", lambda: "sk-test")
    monkeypatch.setattr(settings, "codex_cli_path", lambda: None)
    res = client.get("/api/models", headers=_USER)
    assert res.status_code == 200
    body = res.json()
    assert body["default"] == "claude-fable-5"
    # Only the claude models (codex CLI absent), sorted by label within the group.
    ids = [m["id"] for m in body["models"]]
    assert ids == ["claude-fable-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5"]


def test_models_endpoint_orders_anthropic_before_openai(client, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", lambda: "sk-test")
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    body = client.get("/api/models", headers=_USER).json()
    fams = [m["family"] for m in body["models"]]
    # every claude entry precedes every codex entry
    assert max(i for i, f in enumerate(fams) if f == "claude") < min(i for i, f in enumerate(fams) if f == "codex")
    # each group is sorted by display label
    claude = [m["label"] for m in body["models"] if m["family"] == "claude"]
    codex = [m["label"] for m in body["models"] if m["family"] == "codex"]
    assert claude == sorted(claude) and codex == sorted(codex)
    labels = {m["id"]: m["label"] for m in body["models"]}
    assert labels["gpt-5.6-sol"] == "GPT-5.6 Sol" and labels["o1"] == "o1"


def test_new_openai_ids_route_to_codex(monkeypatch):
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    for mid in ("o1", "o3", "gpt-5.5", "gpt-5.6", "gpt-5.6-sol"):
        assert settings.model_family(mid) == "codex"
        assert settings.runtime_for_model(mid) == "codex"


def test_models_endpoint_excludes_claude_when_no_runtime(client, monkeypatch):
    # No claude runtime, codex CLI present: only codex models are offered and the
    # default falls back to the first available (codex) id, not an absent claude one.
    monkeypatch.setattr(settings, "anthropic_api_key", lambda: None)
    monkeypatch.setattr(settings, "claude_cli_path", lambda: None)
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    body = client.get("/api/models", headers=_USER).json()
    ids = [m["id"] for m in body["models"]]
    assert ids == ["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "o1", "o3"]  # all codex, label-sorted
    assert all(m["family"] == "codex" for m in body["models"])
    assert body["default"] == "gpt-5.5"  # first available


def test_create_diagram_stores_default_model_when_omitted(client, monkeypatch):
    monkeypatch.delenv("MODEL_DIAGRAM_MODEL", raising=False)
    res = client.post("/api/diagrams", headers=_USER, json={"cluster": "local", "path": "/models/tiny"})
    assert res.status_code == 201
    run = db.get_run(res.json()["run_id"])
    assert run["model"] == "claude-fable-5"


def test_create_diagram_stores_chosen_model(client):
    res = client.post(
        "/api/diagrams",
        headers=_USER,
        json={"cluster": "local", "path": "/models/tiny", "model": "claude-haiku-4-5"},
    )
    assert res.status_code == 201
    run = db.get_run(res.json()["run_id"])
    assert run["model"] == "claude-haiku-4-5"


def test_create_diagram_rejects_off_allowlist_model(client):
    res = client.post(
        "/api/diagrams",
        headers=_USER,
        json={"cluster": "local", "path": "/models/tiny", "model": "claude-bogus-9"},
    )
    assert res.status_code == 422


def test_models_endpoint_includes_family(client, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", lambda: "sk-test")
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    body = client.get("/api/models", headers=_USER).json()
    fam = {m["id"]: m["family"] for m in body["models"]}
    assert fam["claude-fable-5"] == "claude"
    assert fam["gpt-5.6-sol"] == "codex"


# ── codex + remote cluster: allowed (backend mirrors the root locally) ──────


def test_create_allows_codex_on_remote_cluster(client):
    # Previously 422; codex on a remote cluster is now supported via local staging.
    res = client.post(
        "/api/diagrams", headers=_USER,
        json={"cluster": "kakao", "path": "/models/tiny", "model": "gpt-5.6-sol"},
    )
    assert res.status_code == 201


def test_create_allows_codex_on_local(client):
    res = client.post(
        "/api/diagrams", headers=_USER,
        json={"cluster": "local", "path": "/models/tiny", "model": "gpt-5.6-sol"},
    )
    assert res.status_code == 201


def test_create_allows_claude_on_remote(client):
    res = client.post(
        "/api/diagrams", headers=_USER,
        json={"cluster": "kakao", "path": "/models/tiny", "model": "claude-fable-5"},
    )
    assert res.status_code == 201


def test_validate_passes_codex_on_remote_cluster(client):
    # No codex/remote guard anymore — validate only checks path + paper.
    res = client.post(
        "/api/validate", headers=_USER,
        json={"cluster": "kakao", "path": "/models/tiny", "model": "gpt-5.6-sol"},
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_reprovision_allows_codex_on_remote_cluster(client):
    created = client.post(
        "/api/diagrams", headers=_USER,
        json={"cluster": "local", "path": "/models/tiny", "model": "claude-fable-5"},
    ).json()
    res = client.post(
        f"/api/diagrams/{created['diagram_id']}/runs", headers=_USER,
        json={"cluster": "kakao", "model": "gpt-5.6-sol"},
    )
    assert res.status_code == 201


def test_reprovision_stores_chosen_model(client):
    created = client.post(
        "/api/diagrams",
        headers=_USER,
        json={"cluster": "local", "path": "/models/tiny", "model": "claude-fable-5"},
    ).json()
    res = client.post(
        f"/api/diagrams/{created['diagram_id']}/runs",
        headers=_USER,
        json={"model": "claude-sonnet-5"},
    )
    assert res.status_code == 201
    run = db.get_run(res.json()["run_id"])
    assert run["model"] == "claude-sonnet-5"
