"""Runtime-agnostic plumbing shared by the CLI/codex analysis runtimes.

The SDK runtime (:mod:`app.agent`) is an in-process Anthropic loop and needs none
of this; the two subprocess runtimes (:mod:`app.agent_cli`, :mod:`app.agent_codex`)
and the chat drivers (:mod:`app.chat`) all drive a child process, tail its stdout
for oversized JSONL lines, race that pump against a terminal signal, and tear the
child + its scratch dir down on every exit path. Those mechanics lived in four
near-identical copies; they live here once.

Nothing here imports the Anthropic SDK, ``app.chat``, or the DB, so it is safe to
pull into any runtime (including the sandboxed MCP subprocess) without dragging in
heavy deps.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from typing import Awaitable, Callable, Optional

# One condensed agent-activity line for the live output pane (mirrors
# ``agent_tools.LogCallback``; duplicated here to avoid a back-import).
LineCallback = Callable[[bytes], Awaitable[None]]


def noop_log(_line: str) -> None:
    """A LogCallback that drops the line (the default when no sink is wired)."""


# ── stream pumping ────────────────────────────────────────────────────────────

# Above ~128 MiB an unterminated line is a runaway; drop it to keep the pipe alive
# rather than buffer without bound.
_MAX_LINE_BYTES = 128 * 1024 * 1024


async def stream_lines(
    stdout: asyncio.StreamReader,
    on_line: LineCallback,
    *,
    debug_log: Optional[str] = None,
) -> None:
    """Read newline-delimited output in fixed chunks and hand each line to ``on_line``.

    Deliberately NOT ``stdout.readline`` / ``async for`` — those enforce asyncio's
    64 KB line cap and raise ``LimitOverrunError``. A single stream-json / --json
    line routinely exceeds that (the finalize_diagram tool call carries the full
    base64 source payload), and a crash here would leave the child blocked on a full
    stdout pipe until the run times out. Oversized lines flow through intact so the
    caller can parse (codex) or summarize-by-shape (Claude CLI) them.

    ``debug_log`` (a path) tees every non-empty raw line to a file for debugging.
    """
    log = open(debug_log, "a", encoding="utf-8") if debug_log else None
    buf = bytearray()
    try:
        while True:
            chunk = await stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                nl = buf.find(b"\n")
                if nl == -1:
                    if len(buf) > _MAX_LINE_BYTES:
                        buf.clear()  # give up on a runaway line; keep the stream alive
                    break
                line = bytes(buf[:nl])
                del buf[: nl + 1]
                _tee(log, line)
                await on_line(line)
        if buf:
            trailing = bytes(buf)
            _tee(log, trailing)
            await on_line(trailing)
    finally:
        if log:
            log.close()


def _tee(log, line: bytes) -> None:
    if log and line.strip():
        log.write(line.decode("utf-8", errors="replace") + "\n")
        log.flush()


# ── pump-vs-terminal race ─────────────────────────────────────────────────────


async def await_pump_or_terminal(
    pump: asyncio.Task, watch: asyncio.Task, *, drain_timeout: float = 8.0
) -> None:
    """Wait for the stdout ``pump`` or the ``watch`` (terminal signal), first wins.

    If the terminal watch wins (a finalize / report_problem landed, or the DB row
    went terminal), give the pump a bounded window to drain the child's tail output,
    then stop it. Otherwise the pump reached EOF on its own and the watch is moot.
    """
    done, _pending = await asyncio.wait({pump, watch}, return_when=asyncio.FIRST_COMPLETED)
    if watch in done and pump not in done:
        try:
            await asyncio.wait_for(pump, timeout=drain_timeout)
        except asyncio.TimeoutError:
            pump.cancel()
    else:
        watch.cancel()


# ── child + scratch lifecycle ─────────────────────────────────────────────────


async def terminate_process(proc, *, timeout: float = 5.0) -> None:
    """SIGTERM a still-running child, escalating to SIGKILL after ``timeout``."""
    if proc is None or proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()


class RuntimeScratch:
    """Async context manager owning a run's throwaway scratch dir + child process.

    Enter to get a ``.path`` scratch dir; assign the spawned child to ``.proc`` so
    that on ANY exit path the child is terminated (terminate → wait → kill) and the
    scratch tree is removed — the teardown that every subprocess runtime repeated.
    """

    def __init__(self, prefix: str) -> None:
        self._prefix = prefix
        self.path: str = ""
        self.proc = None

    async def __aenter__(self) -> "RuntimeScratch":
        self.path = tempfile.mkdtemp(prefix=self._prefix)
        return self

    async def __aexit__(self, *_exc) -> bool:
        await terminate_process(self.proc)
        shutil.rmtree(self.path, ignore_errors=True)
        return False


def write_paper_file(scratch: str, mcp_env: dict, paper_text: str) -> None:
    """Write the run's paper into ``scratch`` and point ``MD_PAPER_FILE`` at it.

    The MCP server serves this file at the virtual read_file path ``__paper__`` on
    every runtime, so the agent reads the paper through the same tool as source.
    """
    paper_file = os.path.join(scratch, "paper.txt")
    with open(paper_file, "w", encoding="utf-8") as fh:
        fh.write(paper_text)
    mcp_env["MD_PAPER_FILE"] = paper_file


# ── misc shared bits ──────────────────────────────────────────────────────────


def resolve_effort(env_var: str, levels: set[str], *, default: str = "high") -> str:
    """A runtime's reasoning-effort level from ``env_var``, clamped to ``levels``.

    Lets ops trade thoroughness for latency/cost without a code change; an unknown
    value falls back to ``default`` (parity with the SDK path).
    """
    raw = os.environ.get(env_var, default).strip().lower()
    return raw if raw in levels else default


def looks_logged_out(text: str, hints: tuple[str, ...]) -> bool:
    """True when ``text`` carries any of a runtime's not-authenticated ``hints``."""
    lowered = text.lower()
    return any(hint in lowered for hint in hints)
