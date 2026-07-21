"""Loopback bridge from the CLI runtime's MCP subprocess back into the backend.

On the Claude-CLI runtime the six tools are served by an out-of-process stdio
MCP server (:mod:`app.mcp_server`) that the CLI launches. ``list_dir`` /
``read_file`` it answers itself (root-scoped :class:`FsAccess`), but the four
run-state tools must mutate state that lives in THIS process — the run's
``AgentOutcome``, the SSE broker, and the SQLite persistence. So the MCP server
POSTs those to an internal loopback endpoint (see ``main.internal_mcp_tool``),
which calls :func:`dispatch_tool` here.

The bridge is registered per run with a random bearer token; the internal
endpoint is loopback-only (the backend binds 127.0.0.1) and not under ``/api``,
so the gateway never proxies it. The handlers are the SAME ones the SDK loop
uses (:mod:`app.agent_tools`) — there is exactly one implementation of each tool.
"""
from __future__ import annotations

import asyncio
import hmac
from dataclasses import dataclass

from . import agent_tools
from .agent_tools import AgentOutcome, FinalizeCallback, MismatchCallback, StageCallback


@dataclass
class RunBridge:
    run_id: int
    token: str
    outcome: AgentOutcome
    on_stage: StageCallback
    finalize_cb: FinalizeCallback
    on_paper_mismatch: MismatchCallback
    terminal: asyncio.Event


_bridges: dict[int, RunBridge] = {}


def register(bridge: RunBridge) -> None:
    _bridges[bridge.run_id] = bridge


def unregister(run_id: int) -> None:
    _bridges.pop(run_id, None)


class BridgeAuthError(Exception):
    """The run is unknown or the callback token did not match."""


async def dispatch_tool(run_id: int, token: str, tool: str, args: dict) -> tuple[dict, bool]:
    """Run one run-state tool for the CLI runtime; returns (result, is_error).

    Raises :class:`BridgeAuthError` for an unknown run or a bad token.
    """
    bridge = _bridges.get(run_id)
    if bridge is None or not hmac.compare_digest(bridge.token, str(token)):
        raise BridgeAuthError("unknown run or invalid callback token")

    if tool == "report_stage":
        return await agent_tools.handle_stage(bridge.on_stage, args), False
    if tool == "report_paper_mismatch":
        return await agent_tools.handle_paper_mismatch(bridge.outcome, bridge.on_paper_mismatch, args), False
    if tool == "report_problem":
        result = agent_tools.handle_report_problem(bridge.outcome, args)
        bridge.terminal.set()
        return result, False
    if tool == "finalize_diagram":
        result, is_error = await agent_tools.handle_finalize(bridge.outcome, bridge.finalize_cb, args)
        if bridge.outcome._terminal:
            bridge.terminal.set()
        return result, is_error
    return {"error": f"unknown tool: {tool}"}, True
