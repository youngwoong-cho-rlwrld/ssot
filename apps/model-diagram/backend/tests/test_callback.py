"""The loopback bridge: token auth + the four run-state tools dispatch through
the shared handlers and drive the AgentOutcome / terminal event."""
import asyncio

import pytest

from app import callback
from app.agent_tools import AgentOutcome
from app.callback import BridgeAuthError, RunBridge


def _bridge(run_id=1, token="secret"):
    stages: list[tuple[str, str]] = []
    mismatches: list[str] = []
    finalized: list[dict] = []

    async def on_stage(stage, detail):
        stages.append((stage, detail))

    async def on_paper_mismatch(reason):
        mismatches.append(reason)

    async def finalize_cb(raw):
        finalized.append(raw)
        # A well-formed payload "succeeds"; a sentinel forces failure.
        if raw.get("_fail"):
            return False, "integrity error"
        return True, None

    outcome = AgentOutcome()
    bridge = RunBridge(
        run_id=run_id,
        token=token,
        outcome=outcome,
        on_stage=on_stage,
        finalize_cb=finalize_cb,
        on_paper_mismatch=on_paper_mismatch,
        terminal=asyncio.Event(),
    )
    return bridge, stages, mismatches, finalized


@pytest.fixture()
def registered():
    bridge, stages, mismatches, finalized = _bridge()
    callback.register(bridge)
    yield bridge, stages, mismatches, finalized
    callback.unregister(bridge.run_id)


async def test_bad_token_rejected(registered):
    bridge, *_ = registered
    with pytest.raises(BridgeAuthError):
        await callback.dispatch_tool(bridge.run_id, "wrong", "report_stage", {"stage": "inspecting_root", "detail": "x"})


async def test_unknown_run_rejected():
    with pytest.raises(BridgeAuthError):
        await callback.dispatch_tool(999, "secret", "report_stage", {})


async def test_report_stage(registered):
    bridge, stages, _m, _f = registered
    result, is_error = await callback.dispatch_tool(bridge.run_id, "secret", "report_stage", {"stage": "mapping_pipeline", "detail": "walking"})
    assert result == {"ok": True} and not is_error
    assert stages == [("mapping_pipeline", "walking")]


async def test_paper_mismatch(registered):
    bridge, _s, mismatches, _f = registered
    result, is_error = await callback.dispatch_tool(bridge.run_id, "secret", "report_paper_mismatch", {"reason": "wrong paper"})
    assert not is_error and result["ok"] is True
    assert bridge.outcome.paper_status == "mismatch"
    assert bridge.outcome.paper_warning == "wrong paper"
    assert mismatches == ["wrong paper"]
    assert not bridge.terminal.is_set()  # mismatch does NOT end the run


async def test_report_problem_sets_terminal(registered):
    bridge, *_ = registered
    result, is_error = await callback.dispatch_tool(bridge.run_id, "secret", "report_problem", {"kind": "not_a_model_root", "message": "not a model"})
    assert result == {"ok": True} and not is_error
    assert bridge.outcome.status == "error"
    assert bridge.outcome.error_kind == "not_a_model_root"
    assert bridge.terminal.is_set()


async def test_finalize_success_sets_terminal(registered):
    bridge, _s, _m, finalized = registered
    result, is_error = await callback.dispatch_tool(bridge.run_id, "secret", "finalize_diagram", {"title": "X"})
    assert result == {"ok": True} and not is_error
    assert finalized == [{"title": "X"}]
    assert bridge.outcome.status == "done"
    assert bridge.terminal.is_set()


async def test_finalize_failure_returns_errors(registered):
    bridge, *_ = registered
    result, is_error = await callback.dispatch_tool(bridge.run_id, "secret", "finalize_diagram", {"_fail": True})
    assert is_error
    assert result["ok"] is False and "errors" in result
    assert not bridge.terminal.is_set()  # can retry
    assert bridge.outcome.status != "done"
