"""The OpenAI ``codex`` CLI analysis runtime (codex-family models).

Selected when a run's model is a codex-family id (see ``settings.MODEL_ALLOWLIST``)
and the ``codex`` CLI is present. It drives the CLI headlessly (``codex exec``),
exposing the SAME six tools as the SDK/Claude-CLI paths through the SAME
runtime-agnostic stdio MCP server (:mod:`app.mcp_server`).

Why codex needs its own runtime and does NOT reuse the Claude-CLI loopback
callback — a constraint discovered empirically against this codex (0.144.x):

* codex runs a ``-s read-only`` seatbelt sandbox, and it launches stdio MCP
  servers *inside that sandbox*. Under the sandbox the MCP server can still do
  filesystem READS (so ``list_dir`` / ``read_file`` work for a LOCAL root), but
  ALL network and socket egress is denied — a loopback HTTP/UDS callback simply
  hangs and codex reports "user cancelled MCP tool call". So the Claude-CLI
  design (four run-state tools POST back to a loopback endpoint) cannot work here.
* codex's ``--json`` event stream, however, echoes every MCP tool call with its
  full ``arguments`` (verified complete for a 12 KB argument). So instead of the
  DB-direct writes the Claude-CLI runtime uses (the sandbox also blocks writing the
  DB file) we DISPATCH FROM THE STREAM: the worker parses codex's stdout and runs
  report_stage / report_paper_mismatch / report_problem / finalize_diagram through
  the exact same handlers the SDK loop uses. The MCP server, seeing no
  ``MD_DB_DIRECT``, answers those four tools with a local ack so the model
  proceeds; the authoritative processing happens here from the stream.

Safety / tool isolation. The ``-s read-only`` sandbox is the guarantee: it
rejects every write (verified — apply_patch and shell edits are denied) and all
network egress from the model's builtin tools, so even though codex always ships
a shell/apply_patch tool that config cannot remove, they cannot mutate anything.
On top of that we drop the model's non-analysis tools via ``-c features.*=false``
(shell/exec/browser/computer-use/image/apps) and ``tools.web_search=false`` so the
model is steered to our six MCP tools, and run in an empty scratch CWD (``-C``) and
``--ephemeral``. The ``-c features.*`` form is used rather than ``--disable`` so an
unknown/renamed flag degrades gracefully instead of hard-erroring the run.

Approvals. Non-interactive ``exec`` auto-cancels every MCP tool call unless a
reviewer approves it, so we set ``-c approvals_reviewer="auto_review"`` explicitly —
the run is then self-sufficient regardless of the host's ``~/.codex/config.toml``
(reproduced on the devserver: with no reviewer in its config, report_stage /
list_dir / finalize_diagram all came back "cancelled"; this Mac only worked because
its config happened to set that key). ``approval_policy=never/on-failure`` does NOT
help — the MCP cancel is governed by the reviewer, not the approval policy.
``--ignore-user-config`` is still deliberately NOT used: it makes codex treat our
MCP tool calls as untrusted and auto-cancel them even WITH the reviewer set. The
reviewer only auto-approves the request; the ``-s read-only`` seccomp sandbox is
unchanged, so writes/network stay blocked.

Documented limitations (honest residual):
* Because the user config loads, any remote MCP servers the user has configured
  remain nominally reachable to the model; the web/browser/apps feature disables
  plus ``tools.web_search=false`` close the built-in web vectors, and the guard
  forbids external lookups, but a user-configured MCP server is a residual surface
  (mitigated by the read-only sandbox — nothing it does can mutate state).
* Remote clusters (ssh / kubectl): the sandboxed MCP server cannot open the
  network those need, so the backend MIRRORS the remote root to a local dir before
  the run (:mod:`app.staging`) and points FsAccess at the mirror — the sandbox stays
  read-only and the run reads locally. The mirror excludes .git objects (kept: HEAD
  + refs for commit pinning) and is capped (MODEL_DIAGRAM_CODEX_STAGE_MAX_BYTES) and
  deleted when the run ends. This is codex-only; other runtimes reach remote roots
  directly.
* finalize is single-attempt: the model gets an immediate ack (it cannot receive
  the backend's integrity verdict through the sandbox), so a payload that fails
  §7.1 ends the run ``agent_failure`` rather than being retried. The layout
  pacing nudge keeps the payload simple to minimise this.
* Isolation leans on the OS sandbox plus the ``features.*`` disables reflecting
  codex's current builtin-tool set; a future codex adding a new default-on action
  tool would want adding to ``_DISABLED_FEATURES``.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Optional

from . import agent_tools, runtime_common, settings
from .agent_tools import (
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

_MCP_SERVER_NAME = "modeldiagram"
_EFFORT_LEVELS = {"minimal", "low", "medium", "high", "xhigh"}
_RUNSTATE_TOOLS = {"report_stage", "report_paper_mismatch", "report_problem", "finalize_diagram"}

# codex builtin tool features we turn off so the model is steered to our MCP tools.
# The OS sandbox is the real safety guarantee; these merely reduce wasted turns and
# keep the model from browsing/searching (which the guard forbids). The `-c
# features.*=false` form degrades gracefully if a flag is renamed (unlike `--disable`,
# which hard-errors on an unknown flag).
_DISABLED_FEATURES = (
    "shell_tool",
    "unified_exec",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "apps",
)

# Detect an unauthenticated codex CLI from its output (verified: `codex exec` emits
# `turn.failed` + a top-level error carrying a 401 when CODEX_HOME has no auth).
_AUTH_HINTS = (
    "401 unauthorized",
    "missing bearer",
    "unauthorized",
    "not logged in",
    "please run codex login",
    "run `codex login`",
    "no credentials",
)


class CodexUnavailable(Exception):
    """The codex CLI could not be located when a run tried to start."""


def _effort() -> str:
    """codex reasoning effort; defaults to 'high' for parity with the other runtimes.

    MODEL_DIAGRAM_CODEX_EFFORT lets ops trade thoroughness for latency/cost.
    """
    return runtime_common.resolve_effort("MODEL_DIAGRAM_CODEX_EFFORT", _EFFORT_LEVELS)


def _looks_logged_out(text: str) -> bool:
    return runtime_common.looks_logged_out(text, _AUTH_HINTS)


def _toml_str(value: str) -> str:
    """Encode ``value`` as a TOML basic string for a ``-c key=<value>`` override.

    Quoting explicitly (rather than leaning on codex's parse-failure-to-literal
    fallback) makes every value an unambiguous string — notably MD_ACCESS_JSON,
    whose ``{"kind":...}`` would otherwise read as a malformed inline table.
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _build_codex_cmd(
    *,
    codex_path: str,
    model: str,
    scratch: str,
    mcp_server_path: str,
    mcp_env: dict[str, str],
) -> list[str]:
    """Assemble the ``codex exec`` argv (pure; unit-tested).

    The prompt is NOT here — it is written to the child's stdin by the caller
    (the embedded spec is large; stdin avoids any argv size limit).
    """
    cmd = [
        codex_path,
        "exec",
        "--json",  # machine-readable JSONL event stream (we dispatch run-state from it)
        "--sandbox",
        "read-only",  # SAFETY: rejects all writes + network egress from the model's tools
        "--skip-git-repo-check",  # the scratch CWD is not a repo
        # NOTE: deliberately NOT --ignore-user-config. That flag makes codex treat
        # our MCP tool calls as untrusted and auto-cancel them non-interactively
        # ("user cancelled MCP tool call") — verified, and not restorable via
        # approval_policy/trust/features. So the user's codex config loads; the
        # feature/tool disables below strip the web-facing surface instead.
        "--ephemeral",  # do not persist session files
        "-C",
        scratch,  # empty scratch working root
        "-m",
        model,
        # Non-interactive `exec` has no human to approve MCP tool calls. Without an
        # explicit reviewer, codex AUTO-CANCELS every MCP tool call on any host whose
        # user config lacks one — reproduced on the devserver (report_stage / list_dir /
        # finalize_diagram all "cancelled"), while this Mac only worked because its
        # ~/.codex/config.toml happens to set approvals_reviewer="auto_review". Set it
        # explicitly so the run is self-sufficient regardless of the box's config. This
        # only auto-APPROVES the request; the -s read-only seccomp sandbox is unchanged,
        # so writes/network stay blocked (verified: turn metadata still "sandbox":"seccomp").
        "-c",
        f"approvals_reviewer={_toml_str('auto_review')}",
        "-c",
        "suppress_unstable_features_warning=true",
        "-c",
        f"model_reasoning_effort={_toml_str(_effort())}",
        "-c",
        "tools.web_search=false",  # the guard forbids any web/search tool
        "-c",
        "tools.view_image=false",
    ]
    for feature in _DISABLED_FEATURES:
        cmd += ["-c", f"features.{feature}=false"]
    # Attach our runtime-agnostic MCP server; codex launches it (sandboxed) and
    # passes the env table through to it. No MD_DB_DIRECT is set → the server runs
    # in stream-ack mode and run-state is dispatched here from --json.
    cmd += [
        "-c",
        f"mcp_servers.{_MCP_SERVER_NAME}.command={_toml_str(sys.executable)}",
        "-c",
        f"mcp_servers.{_MCP_SERVER_NAME}.args=[{_toml_str(mcp_server_path)}]",
    ]
    for key, value in mcp_env.items():
        cmd += ["-c", f"mcp_servers.{_MCP_SERVER_NAME}.env.{key}={_toml_str(value)}"]
    return cmd


class _CodexStreamDispatcher:
    """Base for turning codex's ``--json`` JSONL into runtime effects.

    Parses only the lines a runtime cares about (a cheap byte gate first), records
    the lifecycle events (turn.completed / turn.failed / top-level error) into
    ``self.result`` for the exit mapping, and forwards each completed item to the
    subclass's :meth:`_dispatch_item`. The dedup guard is shared: codex may echo an
    item id more than once.
    """

    _GATE = (
        b'"turn.completed"',
        b'"turn.failed"',
        b'"type":"error"',
        b'"mcp_tool_call"',
        b'"agent_message"',
    )

    def __init__(self) -> None:
        self.result: dict[str, object] = {}
        self._seen: set[str] = set()

    async def handle_line(self, line: bytes) -> None:
        if not any(marker in line for marker in self._GATE):
            return
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return
        etype = event.get("type")
        if etype == "turn.completed":
            self.result["completed"] = True
        elif etype == "turn.failed":
            err = event.get("error") or {}
            self.result["failed"] = str(err.get("message") or err) if isinstance(err, dict) else str(err)
        elif etype == "error":
            self.result["error"] = str(event.get("message") or "codex reported an error")
        elif etype == "item.completed":
            await self._dispatch_item(event.get("item") or {})

    def _already_seen(self, item: dict) -> bool:
        """True if this item id was handled before (codex may echo an item twice)."""
        item_id = str(item.get("id") or "")
        if item_id and item_id in self._seen:
            return True
        if item_id:
            self._seen.add(item_id)
        return False

    async def _dispatch_item(self, item: dict) -> None:  # pragma: no cover - overridden
        raise NotImplementedError


class _StreamDispatcher(_CodexStreamDispatcher):
    """Generation runtime: dispatch run-state from the tool calls codex echoes.

    The four run-state MCP tools are answered with a local ack inside the sandboxed
    MCP server; their real effect happens here.
    """

    def __init__(
        self,
        outcome: AgentOutcome,
        on_stage: StageCallback,
        on_paper_mismatch: MismatchCallback,
        finalize_cb: FinalizeCallback,
        terminal: asyncio.Event,
        on_log: LogCallback = _noop_log,
    ) -> None:
        super().__init__()
        self.outcome = outcome
        self.on_stage = on_stage
        self.on_paper_mismatch = on_paper_mismatch
        self.finalize_cb = finalize_cb
        self.terminal = terminal
        self.on_log = on_log

    async def _dispatch_item(self, item: dict) -> None:
        itype = item.get("type")
        if itype == "agent_message":
            text = summarize_text(item.get("text") or "")
            if text:
                self.on_log(text)
            return
        if itype != "mcp_tool_call" or item.get("server") != _MCP_SERVER_NAME:
            return
        if item.get("status") != "completed":
            return
        if self._already_seen(item):
            return
        tool = item.get("tool")
        args = item.get("arguments") or {}
        self.on_log(summarize_tool_call(str(tool or ""), args))
        if tool not in _RUNSTATE_TOOLS:
            return
        if tool == "report_stage":
            await agent_tools.handle_stage(self.on_stage, args)
        elif tool == "report_paper_mismatch":
            await agent_tools.handle_paper_mismatch(self.outcome, self.on_paper_mismatch, args)
        elif tool == "report_problem":
            agent_tools.handle_report_problem(self.outcome, args)
            self.terminal.set()
        elif tool == "finalize_diagram":
            ok, error = await self.finalize_cb(args)
            if ok:
                self.outcome.status = "done"
                self.outcome._terminal = True
            else:
                # No model-visible retry on codex (the ack already returned), so a
                # failed integrity check ends the run rather than looping.
                self.outcome.status = "error"
                self.outcome.error_kind = "agent_failure"
                self.outcome.error_detail = f"finalize_diagram failed integrity: {error}"
                self.outcome._terminal = True
            self.terminal.set()


async def run_agent_codex(
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
    codex_path = settings.codex_cli_path()
    if not codex_path:
        raise CodexUnavailable("the codex CLI is not available")

    outcome = AgentOutcome(paper_status="attached" if has_paper else "none")
    async with runtime_common.RuntimeScratch("md-codex-") as rt:
        # No MD_DB_DIRECT → the MCP server runs in stream-ack mode; run-state is
        # dispatched here from codex's --json output.
        mcp_env = {
            "MD_CLUSTER": cluster,
            "MD_ROOT": root,
            "MD_RUN_ID": str(run_id),
            # Pre-resolved in the backend; the worker has no identity to look it up.
            "MD_ACCESS_JSON": json.dumps(access),
        }
        if has_paper and paper_text:
            runtime_common.write_paper_file(rt.path, mcp_env, paper_text)

        mcp_server_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_server.py")
        system_prompt = build_system_prompt(cluster, root, has_paper=has_paper, paper_via_tool=True)
        initial_user = build_initial_user(cluster, root, has_paper, paper_via_tool=True)
        # Same pacing preamble as the Claude-CLI path (no geometry tool → a correct
        # integrity-passing diagram is the goal, not a perfect layout); here finalize
        # is single-attempt, so getting it right the first time matters.
        initial_user += agent_tools.LAYOUT_PACING_NUDGE + (
            "Verify every component line range before you call finalize_diagram, and call it once "
            "with the full, correct structure."
        )
        # codex exec has no system-prompt channel: concatenate and feed on stdin.
        prompt = f"{system_prompt}\n\n----- TASK -----\n\n{initial_user}"

        cmd = _build_codex_cmd(
            codex_path=codex_path,
            model=model,
            scratch=rt.path,
            mcp_server_path=mcp_server_path,
            mcp_env=mcp_env,
        )

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=rt.path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        rt.proc = proc
        assert proc.stdin is not None
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        terminal = asyncio.Event()
        dispatcher = _StreamDispatcher(outcome, on_stage, on_paper_mismatch, finalize_cb, terminal, on_log)
        debug_log = os.environ.get("MODEL_DIAGRAM_CODEX_LOG", "").strip() or None
        pump = asyncio.create_task(_pump_stream(proc, dispatcher, debug_log))
        watch = asyncio.create_task(terminal.wait())
        await runtime_common.await_pump_or_terminal(pump, watch)

        await proc.wait()
        stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
        _finalize_outcome(outcome, proc.returncode or 0, dispatcher.result, stderr)
        return outcome


async def _pump_stream(proc: asyncio.subprocess.Process, dispatcher: _CodexStreamDispatcher, debug_log: Optional[str]) -> None:
    """Feed codex's ``--json`` JSONL to the dispatcher, one oversized-safe line at a time."""
    assert proc.stdout is not None
    await runtime_common.stream_lines(proc.stdout, dispatcher.handle_line, debug_log=debug_log)


def classify_codex_exit(result: dict, returncode: int, stderr: str) -> Optional[str]:
    """Map a finished ``codex`` invocation to a failure detail, or None if it exited
    cleanly. Shared by the generation and chat runtimes (which set different outcome
    objects but classify the exit identically).

    Precedence: an unauthenticated CLI (its 401 signature), then a failed turn, then
    a top-level error without a completed turn, then a non-zero exit.
    """
    failed = result.get("failed") if isinstance(result, dict) else None
    top_error = result.get("error") if isinstance(result, dict) else None
    completed = bool(result.get("completed")) if isinstance(result, dict) else False
    blob = "\n".join(str(x) for x in (failed, top_error, stderr) if x)

    if _looks_logged_out(blob):
        return "codex is not logged in (run `codex login`, or set CODEX_HOME to an authenticated config)"
    if failed:
        return f"codex turn failed: {failed}"[:500]
    if top_error and not completed:
        return f"codex error: {top_error}"[:500]
    if returncode != 0:
        detail = (stderr.strip() or "").splitlines()
        return f"codex exited {returncode}: {detail[-1] if detail else 'no output'}"[:500]
    return None


def _finalize_outcome(outcome: AgentOutcome, returncode: int, result: dict, stderr: str) -> None:
    """Decide the run outcome once codex has exited.

    If a run-state tool already set the outcome (done / not_a_model_root / failed
    finalize), keep it. Otherwise map codex's own exit into an ``agent_failure`` (a
    detected failure), or — a clean exit with no finalize — the stopped-early error.
    """
    if outcome._terminal:
        return
    detail = classify_codex_exit(result, returncode, stderr)
    outcome.status = "error"
    outcome.error_kind = "agent_failure"
    outcome.error_detail = detail or "the agent stopped without calling finalize_diagram"
