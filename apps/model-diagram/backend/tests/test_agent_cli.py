"""agent_cli internals: stdout pumping must tolerate huge stream-json lines.

Regression: the finalize_diagram assistant message carries base64 source
contents on a single stdout line that exceeds asyncio's 64KB readline limit.
The old ``async for line in proc.stdout`` raised LimitOverrunError, killing the
pump and leaving the CLI blocked on a full pipe until the run timed out.
"""
import asyncio

import pytest

from app import agent_cli, db
from app.agent_tools import AgentOutcome


class _FakeProc:
    def __init__(self, reader: asyncio.StreamReader):
        self.stdout = reader


async def _feed(*lines: bytes) -> asyncio.StreamReader:
    reader = asyncio.StreamReader()
    for line in lines:
        reader.feed_data(line)
    reader.feed_eof()
    return reader


async def test_pump_tolerates_line_over_64kb_and_captures_result():
    huge = b'{"type":"assistant","message":{"blob":"' + (b"A" * 200_000) + b'"}}\n'
    result_line = b'{"type":"result","subtype":"success","is_error":false,"result":"done"}\n'
    reader = await _feed(huge, result_line)

    result_event: dict = {}
    await agent_cli._pump_stdout(_FakeProc(reader), result_event, None)

    assert result_event.get("result", {}).get("subtype") == "success"
    assert result_event["result"]["is_error"] is False


async def test_pump_captures_init_and_result():
    reader = await _feed(
        b'{"type":"system","subtype":"init","mcp_servers":[{"name":"modeldiagram","status":"connected"}]}\n',
        b'{"type":"system","subtype":"thinking_tokens","estimated_tokens":100}\n',
        b'{"type":"result","subtype":"error_during_execution","is_error":true}\n',
    )
    result_event: dict = {}
    await agent_cli._pump_stdout(_FakeProc(reader), result_event, None)

    assert result_event["init"]["mcp_servers"][0]["status"] == "connected"
    assert result_event["result"]["is_error"] is True


async def test_effort_defaults_and_override(monkeypatch):
    monkeypatch.delenv("MODEL_DIAGRAM_CLI_EFFORT", raising=False)
    assert agent_cli._effort() == "high"
    monkeypatch.setenv("MODEL_DIAGRAM_CLI_EFFORT", "low")
    assert agent_cli._effort() == "low"
    monkeypatch.setenv("MODEL_DIAGRAM_CLI_EFFORT", "bogus")
    assert agent_cli._effort() == "high"  # invalid falls back to high


# ── worker completion of a deferred finalize (item 14) ──────────────────────


async def test_resolve_outcome_runs_deferred_geometry_then_marks_done(tmp_env, monkeypatch):
    # The MCP server finalized inside the stdio server (geometry deferred): the row is
    # still 'running' with the geometry-pending marker. The worker's resolve step must
    # run the geometry pass HERE and then mark the run done.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="claude-fable-5"
    )
    db.set_rendered_html(run_id, "<html>provisional</html>")
    assert db.mark_geometry_pending(run_id) is True

    ran: list = []

    async def spy(rid):
        ran.append(rid)

    monkeypatch.setattr(agent_cli.finalize, "apply_geometry_pass", spy)

    outcome = AgentOutcome()
    await agent_cli._resolve_cli_outcome(run_id, outcome, 0, {}, "")
    assert ran == [run_id]  # the browser pass ran in the worker
    assert outcome.status == "done" and outcome._terminal is True
    assert db.get_run(run_id)["status"] == "done"


async def test_resolve_outcome_keeps_terminal_row(tmp_env, monkeypatch):
    # A row already terminal (report_problem / finalize give-up) is respected as-is,
    # and the geometry pass is not run.
    db.init_db()
    _, run_id = db.create_diagram_with_run(
        user_email="u@example.com", cluster="local", path="/p", model="claude-fable-5"
    )
    db.mark_terminal(run_id, "error", error_kind="not_a_model_root", error_detail="nope")

    async def boom(_rid):
        raise AssertionError("geometry must not run on a terminal row")

    monkeypatch.setattr(agent_cli.finalize, "apply_geometry_pass", boom)

    outcome = AgentOutcome()
    await agent_cli._resolve_cli_outcome(run_id, outcome, 0, {}, "")
    assert outcome.status == "error" and outcome.error_kind == "not_a_model_root"
