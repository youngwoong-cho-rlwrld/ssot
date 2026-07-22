"""The shared finalize flow: validate → persist → render, DB-backed.

One implementation serves every runtime (SDK/codex in the worker, Claude-CLI in
the MCP subprocess), so this covers the success path and the two pre-DB rejections.
"""
from app import db, finalize
from tests.test_db import _payload, fake_fs  # a known-good FinalizePayload + fs stub


async def test_try_finalize_persists_and_caches_html(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs())
    assert ok and err is None
    run = db.get_run(run_id)
    assert run["rendered_html"] and "<html" in run["rendered_html"].lower()
    assert run["title"] == "TinyNet — GAM (abc1234)"
    # The backend fetched + embedded the named file's bytes itself.
    model = db.load_diagram_model(run_id)
    assert model["sources"][0]["line_count"] == 3


async def test_try_finalize_rejects_bad_schema(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    ok, err = await finalize.try_finalize(run_id, {"title": "only a title"}, fake_fs())
    assert not ok and "schema" in err


async def test_try_finalize_rejects_unknown_source(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    raw = _payload().model_dump()
    raw["components"][0]["snippets"][0]["source_key"] = "does-not-exist"
    ok, err = await finalize.try_finalize(run_id, raw, fake_fs())
    assert not ok and "unknown source" in err


async def test_try_finalize_unreadable_source_is_retryable(tmp_env):
    # A named file the backend cannot fetch is a retryable integrity error, not a crash.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs(files={}))
    assert not ok
    assert "could not be read" in err and "model.py" in err


async def test_try_finalize_reuses_named_sources(tmp_env):
    # reuse_sources supplies bytes by name so no fetch happens (chat-revise path);
    # an EMPTY fs would fail on fetch, proving the reuse map was used.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    from tests.test_db import _source_b64  # {"s1": b64(_SRC)}, but reuse keys by NAME

    reuse = {"model.py": _source_b64()["s1"]}
    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs(files={}), reuse_sources=reuse)
    assert ok and err is None
