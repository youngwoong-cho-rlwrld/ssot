"""The shared finalize flow: validate → persist → render, DB-backed.

One implementation serves every runtime (SDK/codex in the worker, Claude-CLI in
the MCP subprocess), so this covers the success path and the two pre-DB rejections.
"""
from app import db, finalize
from app.agent_tools import AgentOutcome, handle_finalize
from tests.test_db import _payload, fake_fs  # a known-good FinalizePayload + fs stub


async def test_run_geometry_flag_gates_the_browser_pass(tmp_env, monkeypatch):
    # run_geometry=False (the Claude-CLI path, which finalizes inside the stdio MCP
    # server) must persist + render but NEVER invoke the headless-Chrome pass; the
    # worker runs it afterwards. run_geometry=True keeps the inline pass.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    calls: list = []

    async def spy(rid, html):
        calls.append(rid)

    monkeypatch.setattr(finalize, "_apply_geometry_pass", spy)

    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs(), run_geometry=False)
    assert ok and err is None and calls == []  # skipped inside the MCP server
    assert db.get_run(run_id)["rendered_html"]  # rows + provisional HTML still cached

    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs(), run_geometry=True)
    assert ok and calls == [run_id]  # inline pass ran on the in-worker path


async def test_apply_geometry_pass_reads_cached_html(tmp_env, monkeypatch):
    # The deferred public entry loads the run's cached HTML and delegates; a run with
    # no cached HTML is a safe no-op (e.g. cancelled before finalize).
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    seen: list = []

    async def spy(rid, html):
        seen.append((rid, html))

    monkeypatch.setattr(finalize, "_apply_geometry_pass", spy)

    await finalize.apply_geometry_pass(run_id)  # no HTML yet → no-op
    assert seen == []

    await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs(), run_geometry=False)
    await finalize.apply_geometry_pass(run_id)  # now the cached HTML is passed through
    assert len(seen) == 1 and seen[0][0] == run_id and "<html" in seen[0][1].lower()


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


async def test_finalize_integrity_failure_is_retryable_then_done(tmp_env):
    # An integrity failure must be RETRYABLE: the run stays 'running', the tool
    # result carries the errors as feedback (is_error False, so the CLI does not
    # end the turn), and a corrected finalize then completes the run.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    outcome = AgentOutcome()

    async def cb(raw):
        return await finalize.try_finalize(run_id, raw, fake_fs())

    bad = _payload().model_dump()
    bad["components"][0]["snippets"][0]["end"] = 999  # past the 3-line model.py
    result, is_error = await handle_finalize(outcome, cb, bad)
    assert is_error is False  # retryable feedback, NOT a tool error
    assert result["ok"] is False and result.get("errors") and "instruction" in result
    assert outcome._terminal is False
    assert db.get_run(run_id)["status"] == "running"  # not marked terminal

    result2, is_error2 = await handle_finalize(outcome, cb, _payload().model_dump())
    assert is_error2 is False and result2["ok"] is True
    assert outcome._terminal is True and outcome.status == "done"
    run = db.get_run(run_id)
    assert run["rendered_html"] and "<html" in run["rendered_html"].lower()


async def test_finalize_exhausted_attempts_end_run(tmp_env, monkeypatch):
    # After MAX_FINALIZE_ATTEMPTS integrity failures the run gives up (terminal).
    monkeypatch.setattr("app.settings.MAX_FINALIZE_ATTEMPTS", 2)
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    outcome = AgentOutcome()

    async def cb(raw):
        return await finalize.try_finalize(run_id, raw, fake_fs())

    bad = _payload().model_dump()
    bad["components"][0]["snippets"][0]["end"] = 999
    _, e1 = await handle_finalize(outcome, cb, bad)
    assert e1 is False and outcome._terminal is False  # first: retryable
    _, e2 = await handle_finalize(outcome, cb, bad)
    assert e2 is True and outcome._terminal is True  # second: exhausted → terminal
    assert outcome.status == "error" and outcome.error_kind == "agent_failure"


# ── paper citation coverage (spec §6/§7.1) ──────────────────────────────────


def _attach_paper(run_id):
    db.add_paper(
        run_id, kind="url", source_url="http://x/p.pdf", stored_path=None,
        content_type="application/pdf", sha256="deadbeef", page_count=1, parsed_title="P",
    )


async def test_finalize_matched_paper_without_quotes_is_retryable(tmp_env):
    # A matched paper + citations with no verbatim quote (the observed codex failure)
    # is a RETRYABLE integrity error, not a silent done-with-empty-panel.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    _attach_paper(run_id)  # run.paper_status → 'attached' (matched)
    # _payload()'s single citation has an empty paper_quote.
    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs())
    assert not ok
    assert "paper is attached and matched" in err and "report_paper_mismatch" in err
    assert db.get_run(run_id)["status"] == "running"  # not marked terminal


async def test_finalize_paper_mismatch_waives_quote_requirement(tmp_env):
    # When the agent reported the paper does not describe this model, no citations
    # are required — the run finalizes code-only.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    _attach_paper(run_id)
    db.set_paper_status(run_id, "mismatch", "paper is about a different model")
    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs())
    assert ok and err is None


async def test_finalize_matched_paper_with_quote_passes(tmp_env):
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    _attach_paper(run_id)
    raw = _payload().model_dump()
    raw["components"][1]["paper_citations"][0]["paper_quote"] = "The hidden dim is 512."
    ok, err = await finalize.try_finalize(run_id, raw, fake_fs())
    assert ok and err is None


async def test_finalize_no_paper_needs_no_citations(tmp_env):
    # A run with no paper attached is unaffected by the coverage check.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="m"
    )
    ok, err = await finalize.try_finalize(run_id, _payload().model_dump(), fake_fs())
    assert ok and err is None
