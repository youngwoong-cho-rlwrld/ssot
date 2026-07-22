"""agent_codex: codex-exec argv construction, stream dispatch, and outcome mapping.

The live codex invocation is not exercised here (that needs the CLI + network);
these cover the deterministic pieces: the command we build (read-only sandbox +
hermetic flags + MCP attach), the run-state dispatch off codex's --json stream,
and the exit→outcome mapping including the logged-out signature.
"""
import asyncio

import pytest

from app import agent_codex
from app.agent_tools import AgentOutcome


def _cmd(**over):
    base = dict(
        codex_path="/usr/local/bin/codex",
        model="gpt-5.6-sol",
        scratch="/tmp/scratch",
        mcp_server_path="/app/mcp_server.py",
        mcp_env={"MD_CLUSTER": "local", "MD_ACCESS_JSON": '{"kind":"local"}'},
    )
    base.update(over)
    return agent_codex._build_codex_cmd(**base)


# ── command construction ────────────────────────────────────────────────────


def test_cmd_uses_read_only_sandbox_and_is_headless():
    cmd = _cmd()
    assert cmd[:2] == ["/usr/local/bin/codex", "exec"]
    assert "--json" in cmd
    # read-only sandbox is the SAFETY guarantee (blocks writes + network egress).
    assert cmd[cmd.index("--sandbox") + 1] == "read-only"
    assert "--dangerously-bypass-approvals-and-sandbox" not in cmd  # never bypass
    # --ignore-user-config is deliberately NOT passed: it makes codex auto-cancel
    # our MCP tool calls non-interactively. The user config loads; the tool disables
    # below strip the web-facing surface instead.
    assert "--ignore-user-config" not in cmd
    assert "--ephemeral" in cmd
    assert "--skip-git-repo-check" in cmd
    assert cmd[cmd.index("-C") + 1] == "/tmp/scratch"
    assert cmd[cmd.index("-m") + 1] == "gpt-5.6-sol"
    # Explicit reviewer so exec auto-approves our MCP tool calls regardless of the
    # host's config (without it codex auto-cancels them non-interactively — verified
    # on the devserver). Sandbox stays read-only, so this does not weaken safety.
    assert 'approvals_reviewer="auto_review"' in cmd


def test_cmd_disables_builtin_tools_gracefully():
    cmd = _cmd()
    # web/image tool config off, and the exec/browser features disabled via the
    # graceful `-c features.*` form (not `--disable`, which hard-errors on unknowns).
    assert "tools.web_search=false" in cmd
    assert "features.shell_tool=false" in cmd
    assert "features.unified_exec=false" in cmd
    assert "features.browser_use=false" in cmd


def test_cmd_attaches_mcp_server_without_callback_base():
    import sys

    cmd = _cmd()
    assert f'mcp_servers.modeldiagram.command="{sys.executable}"' in cmd
    assert 'mcp_servers.modeldiagram.args=["/app/mcp_server.py"]' in cmd
    assert 'mcp_servers.modeldiagram.env.MD_CLUSTER="local"' in cmd
    # MD_ACCESS_JSON survives as a quoted TOML string with inner quotes escaped.
    assert 'mcp_servers.modeldiagram.env.MD_ACCESS_JSON="{\\"kind\\":\\"local\\"}"' in cmd
    # Stream-dispatch mode: no callback base is handed to the sandboxed server.
    assert not any("MD_CALLBACK_BASE" in c for c in cmd)


def test_toml_str_escapes_quotes_and_backslashes():
    assert agent_codex._toml_str("a") == '"a"'
    assert agent_codex._toml_str('a"b') == '"a\\"b"'
    assert agent_codex._toml_str("a\\b") == '"a\\\\b"'


def test_effort_defaults_and_override(monkeypatch):
    monkeypatch.delenv("MODEL_DIAGRAM_CODEX_EFFORT", raising=False)
    assert agent_codex._effort() == "high"
    monkeypatch.setenv("MODEL_DIAGRAM_CODEX_EFFORT", "low")
    assert agent_codex._effort() == "low"
    monkeypatch.setenv("MODEL_DIAGRAM_CODEX_EFFORT", "bogus")
    assert agent_codex._effort() == "high"


def test_looks_logged_out_detects_401():
    assert agent_codex._looks_logged_out(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication"
    )
    assert agent_codex._looks_logged_out("please run codex login")
    assert not agent_codex._looks_logged_out("turn completed successfully")


# ── stream dispatch ─────────────────────────────────────────────────────────


def _dispatcher():
    stages: list[tuple[str, str]] = []
    mismatches: list[str] = []
    finals: list[dict] = []

    async def on_stage(stage, detail):
        stages.append((stage, detail))

    async def on_mismatch(reason):
        mismatches.append(reason)

    async def finalize_cb(raw):
        finals.append(raw)
        return finalize_cb.result

    finalize_cb.result = (True, None)
    outcome = AgentOutcome()
    d = agent_codex._StreamDispatcher(outcome, on_stage, on_mismatch, finalize_cb, asyncio.Event())
    return d, outcome, stages, mismatches, finals, finalize_cb


def _stage_line(stage, detail, item_id="item_1"):
    return (
        '{"type":"item.completed","item":{"id":"%s","type":"mcp_tool_call","server":"modeldiagram",'
        '"tool":"report_stage","arguments":{"stage":"%s","detail":"%s"},"status":"completed"}}'
        % (item_id, stage, detail)
    ).encode()


async def test_dispatch_report_stage_calls_handler():
    d, outcome, stages, *_ = _dispatcher()
    await d.handle_line(_stage_line("inspecting_root", "looking"))
    assert stages == [("inspecting_root", "looking")]


async def test_dispatch_dedups_by_item_id():
    d, outcome, stages, *_ = _dispatcher()
    line = _stage_line("mapping_pipeline", "x", item_id="item_5")
    await d.handle_line(line)
    await d.handle_line(line)  # same id: must not fire twice
    assert stages == [("mapping_pipeline", "x")]


async def test_dispatch_ignores_other_servers():
    d, outcome, stages, *_ = _dispatcher()
    other = (
        '{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"somethingelse",'
        '"tool":"report_stage","arguments":{"stage":"x","detail":"y"},"status":"completed"}}'
    ).encode()
    await d.handle_line(other)
    assert stages == []


async def test_dispatch_report_problem_sets_terminal():
    d, outcome, *_ = _dispatcher()
    line = (
        '{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"modeldiagram",'
        '"tool":"report_problem","arguments":{"kind":"not_a_model_root","message":"nope"},"status":"completed"}}'
    ).encode()
    await d.handle_line(line)
    assert outcome._terminal is True
    assert outcome.error_kind == "not_a_model_root"
    assert d.terminal.is_set()


async def test_dispatch_finalize_success_marks_done():
    d, outcome, _s, _m, finals, finalize_cb = _dispatcher()
    finalize_cb.result = (True, None)
    line = (
        '{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"modeldiagram",'
        '"tool":"finalize_diagram","arguments":{"title":"T"},"status":"completed"}}'
    ).encode()
    await d.handle_line(line)
    assert finals == [{"title": "T"}]
    assert outcome.status == "done"
    assert outcome._terminal is True
    assert d.terminal.is_set()


async def test_dispatch_finalize_failure_is_terminal_agent_failure():
    d, outcome, _s, _m, _f, finalize_cb = _dispatcher()
    finalize_cb.result = (False, "snippet references unknown source")
    line = (
        '{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"modeldiagram",'
        '"tool":"finalize_diagram","arguments":{"title":"T"},"status":"completed"}}'
    ).encode()
    await d.handle_line(line)
    assert outcome.status == "error"
    assert outcome.error_kind == "agent_failure"
    assert "unknown source" in outcome.error_detail
    assert outcome._terminal is True


async def test_dispatch_captures_lifecycle_events():
    d, *_ = _dispatcher()
    await d.handle_line(b'{"type":"error","message":"unexpected status 401 Unauthorized"}')
    await d.handle_line(b'{"type":"turn.failed","error":{"message":"boom"}}')
    await d.handle_line(b'{"type":"turn.completed","usage":{}}')
    assert d.result["error"].startswith("unexpected status 401")
    assert d.result["failed"] == "boom"
    assert d.result["completed"] is True


async def test_dispatch_tolerates_huge_finalize_line():
    d, outcome, _s, _m, finals, finalize_cb = _dispatcher()
    finalize_cb.result = (True, None)
    big = "A" * 200_000
    line = (
        '{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"modeldiagram",'
        '"tool":"finalize_diagram","arguments":{"blob":"%s"},"status":"completed"}}' % big
    ).encode()
    await d.handle_line(line)
    assert finals and len(finals[0]["blob"]) == 200_000
    assert outcome.status == "done"


# ── outcome mapping ─────────────────────────────────────────────────────────


def test_finalize_outcome_keeps_terminal():
    oc = AgentOutcome()
    oc._terminal = True
    oc.status = "done"
    agent_codex._finalize_outcome(oc, 0, {"failed": "ignored"}, "")
    assert oc.status == "done"


def test_finalize_outcome_maps_logged_out():
    oc = AgentOutcome()
    agent_codex._finalize_outcome(oc, 1, {"failed": "401 Unauthorized: Missing bearer"}, "")
    assert oc.status == "error"
    assert oc.error_kind == "agent_failure"
    assert "not logged in" in oc.error_detail


def test_finalize_outcome_maps_turn_failed():
    oc = AgentOutcome()
    agent_codex._finalize_outcome(oc, 1, {"failed": "context length exceeded"}, "")
    assert oc.error_kind == "agent_failure"
    assert "context length exceeded" in oc.error_detail


def test_finalize_outcome_clean_exit_without_finalize():
    oc = AgentOutcome()
    agent_codex._finalize_outcome(oc, 0, {"completed": True}, "")
    assert oc.error_kind == "agent_failure"
    assert "without calling finalize_diagram" in oc.error_detail
