"""The Claude Code CLI analysis runtime (no ANTHROPIC_API_KEY).

Used when the backend has no API key but a logged-in ``claude`` CLI is available.
It drives the CLI headlessly, exposing the SAME six tools as the SDK path through
a stdio MCP server the CLI launches (:mod:`app.mcp_server`), so stages, warnings,
and finalize flow through ``runs.py`` exactly as before.

Bridge design (kept to one source of truth):

- ``list_dir`` / ``read_file`` run inside the MCP subprocess via the same
  :class:`FsAccess` guard (given cluster+root).
- The four run-state tools are written STRAIGHT TO THE SQLITE DB by the MCP
  subprocess (``MD_DB_DIRECT=1`` + ``MODEL_DIAGRAM_DB``), reusing the same
  ``agent_tools`` handlers and :func:`app.finalize.try_finalize` the SDK loop
  uses. This runtime runs inside a detached worker process (:mod:`app.run_worker`),
  not the web process, so an HTTP callback would have to target the worker; the DB
  is already the single source of truth (the SSE stream tails it), so the tools
  write there directly and no loopback endpoint is needed. The finalize integrity
  verdict is returned to the model as the MCP tool result, preserving the
  correct-and-retry loop (unlike the codex runtime, whose sandbox forces
  single-attempt finalize).

This worker drives the CLI, tails its stdout for a live agent-output log, and
watches the DB for the terminal status the MCP writer records.

Isolation: the CLI runs in a throwaway scratch CWD with ``--setting-sources ""``
(no hooks / no user CLAUDE.md), ``--no-session-persistence``, built-in tools
disabled (``--tools ""``), and only our MCP tools allow-listed and reachable
(``--strict-mcp-config``). The paper (when present) is written to the scratch dir
and exposed only through our read_file tool at ``__paper__``.

CLI note: this ``claude`` (2.1.x) has no ``--max-turns`` flag; the run is bounded
by the task budget in the appended prompt and by ``RUN_TIMEOUT_S`` upstream.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Optional

from . import agent_tools, db, finalize, runtime_common, settings
from .agent_tools import (
    TOOL_NAMES,
    AgentOutcome,
    FinalizeCallback,
    LogCallback,
    MismatchCallback,
    StageCallback,
    build_initial_user,
    build_system_prompt,
    summarize_text,
    summarize_tool_call,
)
from .runtime_common import noop_log as _noop_log

_TERMINAL_STATUSES = {"done", "error"}

_MCP_SERVER_NAME = "modeldiagram"
_EFFORT_LEVELS = {"low", "medium", "high", "xhigh", "max"}
# Detect a logged-out CLI from its output so we can surface a clear message.
_AUTH_HINTS = ("not logged in", "please run /login", "invalid api key", "authentication_error", "/login", "log in to claude")


class CliUnavailable(Exception):
    """The Claude CLI could not be located when a run tried to start."""


def _allowed_tools() -> list[str]:
    return [f"mcp__{_MCP_SERVER_NAME}__{name}" for name in TOOL_NAMES]


def _effort() -> str:
    """CLI effort level; defaults to 'high' for parity with the SDK path.

    MODEL_DIAGRAM_CLI_EFFORT lets ops trade thoroughness for latency/cost without
    a code change (the CLI otherwise defaults to xhigh, which is slower).
    """
    return runtime_common.resolve_effort("MODEL_DIAGRAM_CLI_EFFORT", _EFFORT_LEVELS)


def _looks_logged_out(text: str) -> bool:
    return runtime_common.looks_logged_out(text, _AUTH_HINTS)


def _mcp_config(*, mcp_server_path: str, env: dict[str, str]) -> str:
    config = {
        "mcpServers": {
            _MCP_SERVER_NAME: {
                "command": sys.executable,
                "args": [mcp_server_path],
                "env": env,
            }
        }
    }
    return json.dumps(config)


async def run_agent_cli(
    *,
    run_id: int,
    cluster: str,
    root: str,
    model: str,
    access: dict,
    paper_text: Optional[str],
    has_paper: bool,
    on_stage: StageCallback,
    finalize_cb: FinalizeCallback,
    on_paper_mismatch: MismatchCallback,
    on_log: LogCallback = _noop_log,
) -> AgentOutcome:
    cli_path = settings.claude_cli_path()
    if not cli_path:
        raise CliUnavailable("the Claude CLI is not available")

    outcome = AgentOutcome(paper_status="attached" if has_paper else "none")

    async with runtime_common.RuntimeScratch("md-cli-") as rt:
        mcp_env = {
            "MD_CLUSTER": cluster,
            "MD_ROOT": root,
            "MD_RUN_ID": str(run_id),
            # The MCP subprocess writes run-state straight to this DB (no callback).
            "MD_DB_DIRECT": "1",
            "MODEL_DIAGRAM_DB": str(settings.db_path()),
            # Pre-resolved in the backend; the worker has no identity to look it up.
            "MD_ACCESS_JSON": json.dumps(access),
        }
        if has_paper and paper_text:
            runtime_common.write_paper_file(rt.path, mcp_env, paper_text)

        mcp_server_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_server.py")
        system_prompt = build_system_prompt(cluster, root, has_paper=has_paper, paper_via_tool=True)
        initial_user = build_initial_user(cluster, root, has_paper, paper_via_tool=True)
        # The CLI has no task-budget flag (the SDK path passes output_config.task_budget
        # to make the model pace itself and wrap up). Without it the model can spiral in a
        # long thinking block on the heavy finalize_diagram payload and never emit it, so
        # nudge it to act once it has enough — mirroring the SDK path's pacing.
        initial_user += agent_tools.LAYOUT_PACING_NUDGE + (
            "As soon as the component line ranges are verified, emit finalize_diagram — do not keep "
            "reasoning about positions or routing."
        )

        cmd = [
            cli_path,
            "-p",
            initial_user,
            "--system-prompt",
            system_prompt,
            "--mcp-config",
            _mcp_config(mcp_server_path=mcp_server_path, env=mcp_env),
            "--strict-mcp-config",
            "--tools",
            "",  # disable ALL built-in tools; only our MCP tools remain
            "--allowedTools",
            ",".join(_allowed_tools()),
            "--output-format",
            "stream-json",
            "--verbose",
            "--effort",
            _effort(),  # default high (SDK parity); MODEL_DIAGRAM_CLI_EFFORT tunes it
            "--model",
            model,
            "--no-session-persistence",
            "--setting-sources",
            "",  # no hooks / user CLAUDE.md / output styles — a clean run
        ]

        # The MCP tool subprocess reads MD_* from the config's ``env``; the CLI
        # inherits our environment (which, on this runtime, has no ANTHROPIC_API_KEY,
        # so it uses the logged-in subscription).
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=rt.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        rt.proc = proc

        result_event: dict[str, object] = {}
        debug_log = os.environ.get("MODEL_DIAGRAM_CLI_LOG", "").strip() or None
        pump = asyncio.create_task(_pump_stdout(proc, result_event, debug_log, on_log))
        # The MCP writer records finalize / report_problem on the DB row (terminal
        # status, or the geometry-pending marker a successful finalize sets — the
        # heavy geometry pass runs HERE in the worker, not inside the stdio server).
        watch = asyncio.create_task(_watch_db_settled(run_id))
        await runtime_common.await_pump_or_terminal(pump, watch)

        await proc.wait()
        stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
        await _resolve_cli_outcome(run_id, outcome, proc.returncode or 0, result_event, stderr)
        return outcome


async def _resolve_cli_outcome(
    run_id: int, outcome: AgentOutcome, returncode: int, result_event: dict, stderr: str
) -> None:
    """Decide the run outcome once the CLI has exited, honouring the authoritative DB.

    The MCP subprocess persisted run-state straight to the DB. Three cases:

    * the row is already terminal (report_problem / finalize give-up) → keep it;
    * the row is 'running' with the geometry-pending marker → a finalize passed the
      static integrity check; run the deferred headless-Chrome geometry pass HERE in
      the worker (never inside the stdio MCP server), then mark the run done;
    * otherwise the CLI exited with the row still 'running' → map its exit to failure.
    """
    run = db.get_run(run_id)
    if run and run["status"] in _TERMINAL_STATUSES:
        outcome.status = run["status"]
        outcome.error_kind = run.get("error_kind")
        outcome.error_detail = run.get("error_detail")
        outcome._terminal = True
        return
    if run and run.get("geometry_pending"):
        await finalize.apply_geometry_pass(run_id)
        # Guarded: a cancel that landed first already flipped the row terminal.
        db.mark_terminal(run_id, "done")
        outcome.status = "done"
        outcome._terminal = True
        return
    _finalize_outcome(outcome, returncode, result_event, stderr)


async def _watch_db_settled(run_id: int, poll_seconds: float = 0.5) -> None:
    """Return once the run's DB row is settled: terminal, or finalize-complete.

    The MCP subprocess records run-state on the DB row — a terminal done/error, or
    the geometry-pending marker a successful finalize sets. Either settles the run
    from the CLI's side, so the worker stops the CLI and resolves the outcome. This
    only drives the early-stop; the authoritative state is read after the CLI exits.
    """
    while True:
        await asyncio.sleep(poll_seconds)
        run = db.get_run(run_id)
        if run and (run["status"] in _TERMINAL_STATUSES or run.get("geometry_pending")):
            return


async def _pump_stdout(
    proc: asyncio.subprocess.Process,
    result_event: dict,
    debug_log: Optional[str] = None,
    on_log: LogCallback = _noop_log,
) -> None:
    """Consume the CLI's stream-json output: capture lifecycle + emit an activity log.

    The final ``result`` event carries is_error / subtype / terminal_reason and MCP
    connection status appears in ``init``; those small lines are parsed for
    :func:`_finalize_outcome`. Assistant messages are additionally condensed into
    ``on_log`` lines (text + tool calls) for the live agent-output pane. Set
    MODEL_DIAGRAM_CLI_LOG to tee the raw stream-json to a file for debugging.
    Oversized lines (the base64 finalize payload) flow through intact via
    :func:`runtime_common.stream_lines` and are summarized by shape, never parsed.
    """
    assert proc.stdout is not None

    async def on_line(line: bytes) -> None:
        _handle_stream_line(line, result_event, on_log)

    await runtime_common.stream_lines(proc.stdout, on_line, debug_log=debug_log)


# Cheap byte-substring gate: only the small lifecycle lines are worth parsing.
# Huge assistant tool_use lines (base64 finalize payload) are summarized, not parsed.
_INIT_MARKER = b'"subtype":"init"'
_RESULT_MARKER = b'"type":"result"'
_ASSISTANT_MARKER = b'"type":"assistant"'
# Above this size a line is summarized by shape (never full-parsed) — the base64
# finalize payload routinely exceeds it, and json.loads on it is pure waste.
_LOG_PARSE_MAX = 65536


def _handle_stream_line(line: bytes, result_event: dict, on_log: LogCallback = _noop_log) -> None:
    # Raw-line tee-ing to the debug log is handled by runtime_common.stream_lines.
    if not line.strip():
        return
    if _RESULT_MARKER in line or _INIT_MARKER in line:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return
        etype = event.get("type")
        if etype == "system" and event.get("subtype") == "init":
            result_event["init"] = event
        elif etype == "result":
            result_event["result"] = event
        return
    if _ASSISTANT_MARKER in line:
        _emit_assistant_log(line, on_log)


def _emit_assistant_log(line: bytes, on_log: LogCallback) -> None:
    """Condense one stream-json ``assistant`` message into activity-log lines."""
    if len(line) > _LOG_PARSE_MAX:
        # The only routinely-huge assistant line is the finalize_diagram tool_use.
        if b"finalize_diagram" in line:
            on_log("→ finalize_diagram (submitting diagram payload)")
        return
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return
    message = event.get("message") or {}
    for block in message.get("content") or []:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text" and str(block.get("text", "")).strip():
            on_log(summarize_text(block["text"]))
        elif btype == "tool_use":
            on_log(summarize_tool_call(block.get("name", ""), block.get("input") or {}))


def _finalize_outcome(outcome: AgentOutcome, returncode: int, result_event: dict, stderr: str) -> None:
    """Decide the run outcome once the CLI has exited.

    If a terminal tool already set the outcome (done / not_a_model_root / repeated
    finalize failure), keep it. Otherwise map the CLI's own exit into an
    ``agent_failure``, detecting a logged-out CLI specifically.
    """
    if outcome._terminal:
        return

    result = result_event.get("result") if isinstance(result_event, dict) else None
    blob = (json.dumps(result) if result else "") + "\n" + (stderr or "")
    if _looks_logged_out(blob):
        outcome.status = "error"
        outcome.error_kind = "agent_failure"
        outcome.error_detail = "the Claude CLI is not logged in (run `claude` and sign in, or set ANTHROPIC_API_KEY)"
        return

    if isinstance(result, dict) and result.get("is_error"):
        detail = str(result.get("result") or result.get("subtype") or "the Claude CLI reported an error")
        outcome.status = "error"
        outcome.error_kind = "agent_failure"
        outcome.error_detail = f"claude CLI error: {detail}"[:500]
        return

    if returncode != 0:
        detail = (stderr.strip() or "").splitlines()
        outcome.status = "error"
        outcome.error_kind = "agent_failure"
        outcome.error_detail = f"claude CLI exited {returncode}: {detail[-1] if detail else 'no output'}"[:500]
        return

    # The CLI finished cleanly but never called finalize_diagram.
    outcome.status = "error"
    outcome.error_kind = "agent_failure"
    outcome.error_detail = "the agent stopped without calling finalize_diagram"
