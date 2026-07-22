"""Run lifecycle: detached worker process + DB-tailing SSE.

A run executes in its own detached OS process (:mod:`app.run_worker`), spawned
here, which writes ALL state (stages, agent output, finalize rows, terminal
status) to the sqlite DB. The web process holds NO run state in memory, so a run
survives a backend restart (dev-mode ``uvicorn --reload`` on every ``.py`` edit,
deploys) — the worker keeps running and the DB stays the single source of truth.

The SSE stream (:func:`event_stream`) tails that DB: it replays persisted stage
events + output lines, then polls for new rows and status changes, emitting the
terminal frame the moment the row reaches ``done``/``error``. This survives
worker/web restarts transparently — a client reconnect just resumes tailing — and
delivers the terminal frame even when the run finished while no client was
connected.

SSE messages are ``data: <json>\\n\\n`` with a ``type`` field:
``stage`` | ``warning`` | ``log`` | ``done`` | ``error``.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
from typing import AsyncIterator, Optional

from . import db, settings

_TERMINAL_STATUSES = {"done", "error"}
# error_kind recorded for a user cancellation; the frontend treats it as a neutral
# outcome (not a failure) — distinct from agent_failure et al.
CANCELLED_KIND = "cancelled"
CANCELLED_DETAIL = "cancelled by user"
# How often the SSE stream polls the DB for new stages/output/status. ~1s keeps
# the UI live without hammering sqlite for each connected client.
_POLL_SECONDS = float(os.environ.get("MODEL_DIAGRAM_SSE_POLL_S", "1.0"))

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _spawn_worker(module: str, arg: int, label: str) -> Optional[int]:
    """Spawn a detached worker (``python -m <module> <arg>``); return its pid or None.

    ``start_new_session=True`` detaches the worker into its own session/process group
    so it is not killed when the web process (its parent) restarts; on a cross-restart
    the worker reparents to init, which reaps it. A daemon reaper thread waits on the
    child so it does not linger as a zombie within one web-process lifetime.
    """
    env = os.environ.copy()
    # Pin the worker (and any MCP subprocess it launches) to the exact same DB the
    # web process is using, regardless of how each resolves defaults.
    env["MODEL_DIAGRAM_DB"] = str(settings.db_path())
    proc = subprocess.Popen(
        [sys.executable, "-m", module, str(arg)],
        cwd=_BACKEND_DIR,
        env=env,
        start_new_session=True,
        stdin=subprocess.DEVNULL,
    )
    threading.Thread(target=proc.wait, name=label, daemon=True).start()
    return proc.pid


def start_run(run_id: int, *, user_email: str | None = None) -> None:
    """Spawn the detached worker process that executes ``run_id`` (pid recorded so
    reconciliation can probe liveness; the worker resolves its own user identity)."""
    try:
        pid = _spawn_worker("app.run_worker", run_id, f"reap-run-{run_id}")
    except Exception as exc:  # spawning failed outright — fail the run in the DB
        db.update_run_status(
            run_id, "error", error_kind="agent_failure",
            error_detail=f"could not start the generation worker: {exc}",
        )
        return
    db.set_run_pid(run_id, pid)


def start_chat(message_id: int) -> None:
    """Spawn the detached chat worker that produces assistant ``message_id``."""
    try:
        pid = _spawn_worker("app.chat_worker", message_id, f"reap-chat-{message_id}")
    except Exception as exc:
        db.finish_chat_message(message_id, "error", error_detail=f"could not start the chat worker: {exc}")
        return
    db.set_chat_pid(message_id, pid)


# ── cancellation ─────────────────────────────────────────────────────────────


async def cancel_run(run_id: int, *, grace_seconds: float = 3.0) -> str:
    """Cancel a running run: record ``cancelled``, then stop its worker group.

    Returns ``"cancelled"`` on success, ``"not_found"`` for an unknown run, or
    ``"not_running"`` if the run is already terminal (the DB flip is guarded, so a
    run that finished a moment before losing this race is left as-is).

    The status is flipped FIRST (guarded, so it can't clobber a genuine terminal
    result) so the SSE tail emits the cancelled frame even if the signal is slow;
    then the worker's whole process group is SIGTERM'd (the worker is a session
    leader via ``start_new_session``, so the CLI + MCP children die with it) and
    escalated to SIGKILL after a short grace.
    """
    run = db.get_run(run_id)
    if run is None:
        return "not_found"
    if run["status"] != "running":
        return "not_running"
    if not db.mark_terminal(run_id, "error", error_kind=CANCELLED_KIND, error_detail=CANCELLED_DETAIL):
        return "not_running"  # finished concurrently — respect the real result
    db.add_output_line(run_id, "cancelled by user")
    await _terminate_worker_group(run.get("pid"), grace_seconds)
    return "cancelled"


async def _terminate_worker_group(pid: object, grace_seconds: float) -> None:
    """SIGTERM the worker's process group, escalating to SIGKILL after a grace."""
    if not pid:
        return
    pid = int(pid)
    try:
        pgid = os.getpgid(pid)
    except OSError:
        pgid = pid  # already gone, or we can't read it; killpg(pid) still targets its group
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return  # worker already exited
    except OSError:
        return
    deadline = asyncio.get_event_loop().time() + grace_seconds
    while db._pid_alive(pid) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.2)
    if db._pid_alive(pid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except OSError:
            pass


async def cancel_chat(message_id: int, *, grace_seconds: float = 3.0) -> str:
    """Cancel a pending chat turn: flip the message to a neutral cancelled state, then
    stop its worker group. Mirrors :func:`cancel_run` (guarded write + SIGTERM/KILL)."""
    msg = db.get_chat_message(message_id)
    if msg is None:
        return "not_found"
    if msg["status"] != "pending":
        return "not_running"
    if not db.finish_chat_message(message_id, "error", error_detail=CANCELLED_DETAIL):
        return "not_running"
    db.add_chat_output_line(message_id, "cancelled by user")
    await _terminate_worker_group(msg.get("pid"), grace_seconds)
    return "cancelled"


# ── SSE (DB-tailing) ─────────────────────────────────────────────────────────


def _chat_message_frame(msg: dict) -> dict:
    return {
        "type": "message",
        "id": msg["id"],
        "role": msg["role"],
        "content": msg.get("content") or "",
        "status": msg["status"],
        "error_detail": msg.get("error_detail"),
        "revised_run_id": msg.get("revised_run_id"),
        "seq": msg["seq"],
        "ts": msg.get("updated_at") or msg.get("created_at"),
    }


async def chat_event_stream(message_id: int) -> AsyncIterator[dict]:
    """Tail one assistant chat message from the DB: replay its activity log, stream new
    log lines + status, and close on the terminal (done/error) message frame.

    Same DB-tail design as :func:`event_stream` (survives restarts; a dead worker is
    reconciled on each poll so the stream resolves instead of hanging)."""
    last_seq = 0

    def drain_logs() -> list[dict]:
        nonlocal last_seq
        out: list[dict] = []
        for row in db.list_chat_output(message_id, after_seq=last_seq):
            last_seq = row["seq"]
            out.append({"type": "log", "seq": row["seq"], "line": row["line"], "ts": row["ts"]})
        return out

    for frame in drain_logs():
        yield _sse(frame)

    msg = db.get_chat_message(message_id)
    if msg is None:
        yield _sse({"type": "error", "detail": "chat message not found"})
        return
    yield _sse(_chat_message_frame(msg))
    if msg["status"] != "pending":
        return

    while True:
        await asyncio.sleep(_POLL_SECONDS)
        db.reconcile_chat_message_if_orphaned(message_id)
        for frame in drain_logs():
            yield _sse(frame)
        msg = db.get_chat_message(message_id)
        if msg is None:
            yield _sse({"type": "error", "detail": "chat message not found"})
            return
        if msg["status"] != "pending":
            for frame in drain_logs():
                yield _sse(frame)
            yield _sse(_chat_message_frame(msg))
            return


async def event_stream(run_id: int) -> AsyncIterator[dict]:
    """Replay persisted stages + output from the DB, then tail it until terminal.

    Yields sse_starlette-compatible dicts (``{"data": <json>}``). Nothing here can
    cancel the run (it lives in another process). A terminal status closes the
    stream. On every poll a run with a dead worker is reconciled to ``error`` so a
    crashed worker still resolves the stream instead of hanging forever.
    """
    last_stage_id = 0
    last_seq = 0
    warned_mismatch = False

    def drain() -> list[dict]:
        nonlocal last_stage_id, last_seq
        frames: list[dict] = []
        for ev in db.list_stage_events(run_id):
            if ev["id"] > last_stage_id:
                last_stage_id = ev["id"]
                frames.append(
                    {"type": "stage", "stage": ev["stage"], "detail": ev.get("detail") or "", "ts": ev["ts"]}
                )
        for out in db.list_output(run_id, after_seq=last_seq):
            last_seq = out["seq"]
            frames.append({"type": "log", "seq": out["seq"], "line": out["line"], "ts": out["ts"]})
        return frames

    for frame in drain():
        yield _sse(frame)

    run = db.get_run(run_id)
    if run is None:
        yield _sse({"type": "error", "kind": "agent_failure", "detail": "run not found"})
        return
    if run["paper_status"] == "mismatch":
        warned_mismatch = True
        yield _sse({"type": "warning", "kind": "paper_mismatch", "detail": run.get("paper_warning") or ""})
    if run["status"] in _TERMINAL_STATUSES:
        yield _sse(_terminal_from_run(run))
        return

    while True:
        await asyncio.sleep(_POLL_SECONDS)
        # A crashed/killed worker leaves the row 'running' forever; catch it here so
        # the stream (and the watching client) resolves promptly.
        db.reconcile_run_if_orphaned(run_id)

        for frame in drain():
            yield _sse(frame)

        run = db.get_run(run_id)
        if run is None:
            yield _sse({"type": "error", "kind": "agent_failure", "detail": "run not found"})
            return
        if not warned_mismatch and run["paper_status"] == "mismatch":
            warned_mismatch = True
            yield _sse({"type": "warning", "kind": "paper_mismatch", "detail": run.get("paper_warning") or ""})
        if run["status"] in _TERMINAL_STATUSES:
            # Final drain: catch stages/output written just before the status flip.
            for frame in drain():
                yield _sse(frame)
            yield _sse(_terminal_from_run(run))
            return


def _sse(payload: dict) -> dict:
    return {"data": json.dumps(payload)}


def _terminal_from_run(run: dict) -> dict:
    if run["status"] == "done":
        return {"type": "done", "run_id": run["id"]}
    return {"type": "error", "kind": run.get("error_kind"), "detail": run.get("error_detail")}
