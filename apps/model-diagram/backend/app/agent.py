"""The SDK analysis runtime: an Anthropic tool-use loop with scoped read-only tools.

The agent walks the model codebase at the given root and produces the structured
diagram via ``finalize_diagram``. It has NO web/fetch/search tools — the only
external artifact is the user's paper, which the backend pre-fetches and injects
into the initial message. Every file read is scoped to the model root by
``FsAccess`` (server-side path-escape guard), independent of the prompt.

The tool set, schemas, handlers, and system prompt are shared with the Claude
CLI runtime (:mod:`app.agent_tools`); this module only owns the SDK message loop.
``finalize_diagram`` is validated by a caller-supplied callback: on an integrity
failure the errors are returned to the agent so it can correct and call again.
"""
from __future__ import annotations

import json
import os

from anthropic import AsyncAnthropic

from . import settings
from .agent_tools import (
    AgentOutcome,
    FinalizeCallback,
    LogCallback,
    MismatchCallback,
    StageCallback,
    build_initial_user,
    build_system_prompt,
    fs_list_dir,
    fs_read_file,
    handle_finalize,
    handle_paper_mismatch,
    handle_report_problem,
    handle_stage,
    summarize_text,
    summarize_tool_call,
    tool_specs,
)
from .fsaccess import FsAccess
from .runtime_common import noop_log as _noop_log

_TASK_BUDGET = max(20000, int(os.environ.get("MODEL_DIAGRAM_TASK_BUDGET", "200000")))
_MAX_TOKENS = int(os.environ.get("MODEL_DIAGRAM_MAX_TOKENS", "64000"))


class CredentialsMissing(Exception):
    """No usable agent runtime (neither ANTHROPIC_API_KEY nor the Claude CLI)."""


def _tools() -> list[dict]:
    return [
        {"name": s["name"], "description": s["description"], "input_schema": s["schema"]}
        for s in tool_specs()
    ]


def _initial_user(cluster: str, root: str, paper_block: list[dict]) -> list[dict]:
    intro = build_initial_user(cluster, root, bool(paper_block), paper_via_tool=False)
    return [{"type": "text", "text": intro}, *paper_block]


async def run_agent(
    *,
    fs: FsAccess,
    cluster: str,
    root: str,
    model: str,
    paper_block: list[dict],
    on_stage: StageCallback,
    finalize_cb: FinalizeCallback,
    on_paper_mismatch: MismatchCallback,
    on_log: LogCallback = _noop_log,
) -> AgentOutcome:
    api_key = settings.anthropic_api_key()
    if not api_key:
        raise CredentialsMissing("ANTHROPIC_API_KEY is not configured")

    client = AsyncAnthropic(api_key=api_key)
    tools = _tools()
    system = build_system_prompt(cluster, root, has_paper=bool(paper_block), paper_via_tool=False)
    outcome = AgentOutcome(paper_status="attached" if paper_block else "none")
    messages: list[dict] = [{"role": "user", "content": _initial_user(cluster, root, paper_block)}]

    for _ in range(settings.AGENT_MAX_ITERATIONS):
        async with client.beta.messages.stream(
            model=model,
            max_tokens=_MAX_TOKENS,
            system=system,
            messages=messages,
            tools=tools,
            thinking={"type": "adaptive"},
            output_config={"effort": "high", "task_budget": {"type": "tokens", "total": _TASK_BUDGET}},
            betas=["task-budgets-2026-03-13"],
        ) as stream:
            response = await stream.get_final_message()

        if response.stop_reason == "refusal":
            outcome.status = "error"
            outcome.error_kind = "agent_failure"
            outcome.error_detail = "the model refused the request"
            return outcome

        messages.append({"role": "assistant", "content": response.content})
        for block in response.content:
            if block.type == "text" and block.text.strip():
                on_log(summarize_text(block.text))
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses:
            outcome.status = "error"
            outcome.error_kind = "agent_failure"
            outcome.error_detail = "the agent stopped without calling finalize_diagram"
            return outcome

        tool_results: list[dict] = []
        for block in tool_uses:
            args = block.input if isinstance(block.input, dict) else {}
            on_log(summarize_tool_call(block.name, args))
            content, is_error = await _dispatch(block, fs, on_stage, finalize_cb, on_paper_mismatch, outcome)
            if is_error:
                on_log(f"  ! {block.name} error: {summarize_text(content, limit=300)}")
            tool_results.append(
                {"type": "tool_result", "tool_use_id": block.id, "content": content, "is_error": is_error}
            )
            if outcome._terminal:
                return outcome

        messages.append({"role": "user", "content": tool_results})

    outcome.status = "error"
    outcome.error_kind = "agent_failure"
    outcome.error_detail = f"agent exceeded {settings.AGENT_MAX_ITERATIONS} iterations without finishing"
    return outcome


async def _dispatch(
    block,
    fs: FsAccess,
    on_stage: StageCallback,
    finalize_cb: FinalizeCallback,
    on_paper_mismatch: MismatchCallback,
    outcome: AgentOutcome,
) -> tuple[str, bool]:
    name = block.name
    args = block.input if isinstance(block.input, dict) else {}

    if name == "report_stage":
        return json.dumps(await handle_stage(on_stage, args)), False

    if name == "list_dir":
        result, is_error = await fs_list_dir(fs, args)
        return json.dumps(result), is_error

    if name == "read_file":
        result, is_error = await fs_read_file(fs, args)
        return json.dumps(result), is_error

    if name == "report_paper_mismatch":
        return json.dumps(await handle_paper_mismatch(outcome, on_paper_mismatch, args)), False

    if name == "report_problem":
        return json.dumps(handle_report_problem(outcome, args)), False

    if name == "finalize_diagram":
        result, is_error = await handle_finalize(outcome, finalize_cb, args)
        return json.dumps(result), is_error

    return json.dumps({"error": f"unknown tool: {name}"}), True
