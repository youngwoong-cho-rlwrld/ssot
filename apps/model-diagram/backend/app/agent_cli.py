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
import shutil
import sys
import tempfile
from typing import Optional

from . import db, settings
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

_TERMINAL_STATUSES = {"done", "error"}


def _noop_log(_line: str) -> None:
    pass


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
    raw = os.environ.get("MODEL_DIAGRAM_CLI_EFFORT", "high").strip().lower()
    return raw if raw in _EFFORT_LEVELS else "high"


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

    scratch = tempfile.mkdtemp(prefix="md-cli-")
    proc: Optional[asyncio.subprocess.Process] = None
    try:
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
            paper_file = os.path.join(scratch, "paper.txt")
            with open(paper_file, "w", encoding="utf-8") as fh:
                fh.write(paper_text)
            mcp_env["MD_PAPER_FILE"] = paper_file

        mcp_server_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_server.py")
        system_prompt = build_system_prompt(cluster, root, has_paper=has_paper, paper_via_tool=True)
        initial_user = build_initial_user(cluster, root, has_paper, paper_via_tool=True)
        # The CLI has no task-budget flag (the SDK path passes output_config.task_budget
        # to make the model pace itself and wrap up). Without it the model can spiral in a
        # long thinking block on the heavy finalize_diagram payload and never emit it, so
        # nudge it to act once it has enough — mirroring the SDK path's pacing.
        initial_user += (
            "\n\nBounded budget — do NOT over-deliberate on layout. You have no geometry-measurement "
            "tool, so a perfect layout is impossible and not the goal; a correct diagram that passes "
            "the integrity checks is. Use a simple single-column top-to-bottom layout with straight "
            "vertical orthogonal wires between adjacent boxes. As soon as the component line ranges "
            "are verified, emit finalize_diagram — do not keep reasoning about positions or routing."
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
            cwd=scratch,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        result_event: dict[str, object] = {}
        debug_log = os.environ.get("MODEL_DIAGRAM_CLI_LOG", "").strip() or None
        pump = asyncio.create_task(_pump_stdout(proc, result_event, debug_log, on_log))
        watch = asyncio.create_task(_watch_db_terminal(run_id))
        done, _pending = await asyncio.wait({pump, watch}, return_when=asyncio.FIRST_COMPLETED)

        if watch in done and pump not in done:
            # The MCP writer recorded a terminal status (finalize / report_problem).
            # Give the CLI a brief window to wrap up, then stop it — outcome decided.
            try:
                await asyncio.wait_for(pump, timeout=8.0)
            except asyncio.TimeoutError:
                pump.cancel()
        else:
            watch.cancel()

        await proc.wait()
        stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
        # The DB is authoritative: if the MCP subprocess recorded a terminal status
        # (done, integrity give-up, not_a_model_root), keep it. Only when the CLI
        # exited with the row still 'running' do we map its exit into a failure.
        run = db.get_run(run_id)
        if run and run["status"] in _TERMINAL_STATUSES:
            outcome.status = run["status"]
            outcome.error_kind = run.get("error_kind")
            outcome.error_detail = run.get("error_detail")
            outcome._terminal = True
        else:
            _finalize_outcome(outcome, proc.returncode or 0, result_event, stderr)
        return outcome
    finally:
        if proc is not None and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
        shutil.rmtree(scratch, ignore_errors=True)


async def _watch_db_terminal(run_id: int, poll_seconds: float = 0.5) -> None:
    """Return once the run's DB row reaches a terminal status.

    The MCP subprocess writes run-state (including the terminal done/error) straight
    to the DB, so the worker learns the outcome by polling the row rather than via a
    callback event. This only drives the early-stop of the CLI; the authoritative
    status is read from the DB after the process exits.
    """
    while True:
        await asyncio.sleep(poll_seconds)
        run = db.get_run(run_id)
        if run and run["status"] in _TERMINAL_STATUSES:
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

    Reads in fixed-size chunks and splits lines by hand, deliberately NOT using
    ``proc.stdout.readline`` / ``async for`` — those enforce asyncio's 64KB line
    limit and raise LimitOverrunError. Individual stream-json lines routinely
    exceed that (the finalize_diagram assistant message carries base64 sources),
    and a crash here would leave the CLI blocked on a full stdout pipe until the
    run times out. Oversized lines are summarized without a full JSON parse.
    """
    assert proc.stdout is not None
    log = open(debug_log, "a", encoding="utf-8") if debug_log else None
    buf = bytearray()
    max_line = 128 * 1024 * 1024  # bound memory on a pathological unterminated line
    try:
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                nl = buf.find(b"\n")
                if nl == -1:
                    if len(buf) > max_line:
                        buf.clear()  # give up on a runaway line; keep the stream alive
                    break
                line = bytes(buf[: nl])
                del buf[: nl + 1]
                _handle_stream_line(line, result_event, log, on_log)
        if buf:
            _handle_stream_line(bytes(buf), result_event, log, on_log)
    finally:
        if log:
            log.close()


# Cheap byte-substring gate: only the small lifecycle lines are worth parsing.
# Huge assistant tool_use lines (base64 finalize payload) are summarized, not parsed.
_INIT_MARKER = b'"subtype":"init"'
_RESULT_MARKER = b'"type":"result"'
_ASSISTANT_MARKER = b'"type":"assistant"'
# Above this size a line is summarized by shape (never full-parsed) — the base64
# finalize payload routinely exceeds it, and json.loads on it is pure waste.
_LOG_PARSE_MAX = 65536


def _handle_stream_line(line: bytes, result_event: dict, log, on_log: LogCallback = _noop_log) -> None:
    if not line.strip():
        return
    if log:
        log.write(line.decode("utf-8", errors="replace") + "\n")
        log.flush()
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


def _looks_logged_out(text: str) -> bool:
    lowered = text.lower()
    return any(hint in lowered for hint in _AUTH_HINTS)
