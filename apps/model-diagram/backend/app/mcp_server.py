"""Stdio MCP server that exposes the six analysis tools to the Claude Code CLI.

Launched by the CLI (via ``--mcp-config``) as a subprocess of the backend on the
Claude-CLI runtime. It speaks the minimal MCP JSON-RPC handshake over stdio
(newline-delimited JSON messages): ``initialize`` → ``tools/list`` →
``tools/call``.

Design — one source of truth (see the module docstring in ``agent_cli``):

- ``list_dir`` / ``read_file`` are answered HERE via the SAME :class:`FsAccess`
  guard as the SDK path, constructed from ``MD_CLUSTER`` + ``MD_ROOT``. The paper
  (when present) is exposed as a virtual read_file path ``__paper__``, backed by
  the text file at ``MD_PAPER_FILE``.
- ``report_stage`` / ``report_problem`` / ``report_paper_mismatch`` /
  ``finalize_diagram`` mutate run state that is persisted in the sqlite DB. The
  server runs one of two modes for them, chosen by env:

  * ``MD_DB_DIRECT=1`` (Claude-CLI runtime): write STRAIGHT to the DB
    (``MODEL_DIAGRAM_DB``) via the same ``agent_tools`` handlers and
    :func:`app.finalize.try_finalize` the SDK loop uses. The finalize integrity
    verdict is returned to the model as the tool result, preserving retry.
  * neither set (codex runtime): the sandbox blocks both network and DB writes, so
    ack locally and let the backend dispatch run-state from codex's ``--json``
    stream instead.

Run as ``<python> <path-to-this-file>``; it inserts the backend dir on sys.path
so ``from app...`` imports resolve regardless of the CLI's scratch CWD.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

# Make ``app`` importable when launched as a bare script from the CLI's scratch cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import agent_tools  # noqa: E402
from app.fsaccess import FsAccess  # noqa: E402

_PROTOCOL = "2024-11-05"
_SERVER_NAME = "modeldiagram"
_LOCAL_TOOLS = {"list_dir", "read_file"}
_RUNSTATE_TOOLS = {"report_stage", "report_problem", "report_paper_mismatch", "finalize_diagram"}

# One AgentOutcome per server process (one run) so finalize retry-attempt counting
# and the mismatch flag survive across tool calls.
_OUTCOME = agent_tools.AgentOutcome()
# Chat mode: one ChatOutcome per process (created lazily to avoid importing chat
# on the non-chat paths). Persists the revise run id + attempt count across calls.
_CHAT_OUTCOME_HOLDER: list = []


def _chat_outcome():
    from app import chat

    if not _CHAT_OUTCOME_HOLDER:
        _CHAT_OUTCOME_HOLDER.append(chat.ChatOutcome())
    return _CHAT_OUTCOME_HOLDER[0]


def _chat_mode() -> bool:
    return bool(os.environ.get("MD_CHAT"))


def _tools() -> list[dict]:
    if _chat_mode():
        from app import chat  # local import (no anthropic pulled in)

        specs = chat.chat_tool_specs()
    else:
        specs = agent_tools.tool_specs()
    return [
        {"name": s["name"], "description": s["description"], "inputSchema": s["schema"]}
        for s in specs
    ]


def _paper_text() -> str | None:
    path = os.environ.get("MD_PAPER_FILE", "").strip()
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def _call_local(fs: FsAccess, name: str, args: dict) -> tuple[dict, bool]:
    if name == "list_dir":
        return await agent_tools.fs_list_dir(fs, args)
    return await agent_tools.fs_read_file(fs, args, paper_text=_paper_text())


def _stream_ack(name: str, args: dict) -> tuple[dict, bool]:
    """Ack a run-state tool locally (codex stream-dispatch mode).

    The codex sandbox blocks both network and DB writes, so this server cannot
    persist run-state itself. The backend instead reads run-state from codex's
    ``--json`` event stream; here we just acknowledge so the model proceeds.
    Mirrors the successful-path shapes the DB-direct handlers return.
    """
    if name == "report_paper_mismatch":
        return {"ok": True, "instruction": "Continue using code-derived values only."}, False
    return {"ok": True}, False


def _call_db_direct(fs: FsAccess, name: str, args: dict) -> tuple[dict, bool]:
    """Persist one run-state tool straight to the sqlite DB (Claude-CLI runtime).

    Reuses the exact ``agent_tools`` handlers + :func:`app.finalize.try_finalize`
    the SDK loop uses (one source of truth), and records the terminal run status on
    the row so the worker (tailing the DB) and any SSE client see it.
    """
    from app import db, finalize  # local import: keep DB deps out of codex/ack mode

    run_id = int(os.environ["MD_RUN_ID"])

    async def on_stage(stage: str, detail: str) -> None:
        db.add_stage_event(run_id, stage, detail)

    async def on_mismatch(reason: str) -> None:
        db.set_paper_status(run_id, "mismatch", reason)

    async def finalize_cb(raw: dict):
        # The backend fetches source bytes itself via the run's scoped access (fs).
        return await finalize.try_finalize(run_id, raw, fs)

    if name == "report_stage":
        return asyncio.run(agent_tools.handle_stage(on_stage, args)), False
    if name == "report_paper_mismatch":
        return asyncio.run(agent_tools.handle_paper_mismatch(_OUTCOME, on_mismatch, args)), False
    if name == "report_problem":
        result = agent_tools.handle_report_problem(_OUTCOME, args)
        db.mark_terminal(run_id, "error", error_kind=_OUTCOME.error_kind, error_detail=_OUTCOME.error_detail)
        return result, False
    if name == "finalize_diagram":
        result, is_error = asyncio.run(agent_tools.handle_finalize(_OUTCOME, finalize_cb, args))
        if _OUTCOME._terminal:
            if _OUTCOME.status == "done":
                db.mark_terminal(run_id, "done")
            else:
                db.mark_terminal(run_id, "error", error_kind=_OUTCOME.error_kind, error_detail=_OUTCOME.error_detail)
        return result, is_error
    return {"error": f"unknown tool: {name}"}, True


def _call_chat_revise(fs: FsAccess, args: dict) -> tuple[dict, bool]:
    """Persist a chat ``revise_diagram`` straight to the DB (Claude-CLI chat mode).

    Reuses :func:`app.chat.make_revise_cb` + :func:`app.chat.handle_revise` (one
    source of truth for the §7.1 checks + new-run persistence), and stamps the new
    run id on the message so the worker finishes the turn with it.
    """
    from app import chat, db  # local import: keep DB deps off the ack path

    message_id = int(os.environ["MD_CHAT_MESSAGE_ID"])
    msg = db.get_chat_message(message_id)
    if not msg or not msg.get("anchor_run_id"):
        return {"error": "chat message or anchor run not found"}, True
    anchor = db.get_run(int(msg["anchor_run_id"]))
    if not anchor:
        return {"error": "anchor run not found"}, True
    outcome = _chat_outcome()
    revise_cb = chat.make_revise_cb(
        anchor_run=anchor, diagram_id=anchor["diagram_id"], user_email=anchor["user_email"],
        outcome=outcome, fs=fs,
    )
    result, is_error = asyncio.run(chat.handle_revise(outcome, revise_cb, args))
    if outcome.revised and outcome.revise_run_id:
        db.set_chat_revised(message_id, outcome.revise_run_id)
    return result, is_error


def _dispatch_call(fs: FsAccess, name: str, args: dict) -> tuple[dict, bool]:
    if name in _LOCAL_TOOLS:
        return asyncio.run(_call_local(fs, name, args))
    if _chat_mode():
        if name == "revise_diagram":
            # Codex chat runs the MCP server inside codex's sandbox (no DB/network),
            # so — like the codex generation path — ack locally and let the backend
            # dispatch the real revise from codex's --json stream (MD_STREAM_ACK).
            # The Claude-CLI chat path (unsandboxed) writes straight to the DB here.
            if os.environ.get("MD_STREAM_ACK"):
                return {"ok": True}, False
            return _call_chat_revise(fs, args)
        return {"error": f"unknown chat tool: {name}"}, True
    if name in _RUNSTATE_TOOLS:
        if os.environ.get("MD_DB_DIRECT"):
            return _call_db_direct(fs, name, args)
        return _stream_ack(name, args)
    return {"error": f"unknown tool: {name}"}, True


def _tool_result(result: dict, is_error: bool) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": is_error}


def main() -> None:
    # Cluster access is pre-resolved by the backend (which has the user's
    # identity) and handed over as MD_ACCESS_JSON; the worker never reads ssot.db.
    access_raw = os.environ.get("MD_ACCESS_JSON")
    access = json.loads(access_raw) if access_raw else None
    fs = FsAccess(os.environ.get("MD_CLUSTER", "local"), os.environ["MD_ROOT"], access=access)
    tools = _tools()

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = req.get("method")
        rid = req.get("id")

        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": _PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": _SERVER_NAME, "version": "0.1.0"},
            }})
        elif method == "notifications/initialized":
            continue  # notification: no response
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": tools}})
        elif method == "tools/call":
            params = req.get("params") or {}
            name = params.get("name", "")
            args = params.get("arguments") or {}
            try:
                result, is_error = _dispatch_call(fs, name, args)
            except Exception as exc:  # never crash the server on one bad call
                result, is_error = {"error": f"tool failed: {exc}"}, True
            _send({"jsonrpc": "2.0", "id": rid, "result": _tool_result(result, is_error)})
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": rid, "result": {}})
        elif rid is not None:
            _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"method not found: {method}"}})


if __name__ == "__main__":
    main()
