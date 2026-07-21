"""Run lifecycle: detached agent tasks + per-run SSE pub/sub.

A run executes as a detached asyncio task. Stage events are persisted as they
happen and also published to any live SSE subscribers. A client disconnecting
from the SSE stream NEVER cancels the run — the task owns its own lifetime.

SSE messages are ``data: <json>\\n\\n`` with a ``type`` field per plan §10:
``stage`` | ``warning`` | ``done`` | ``error``.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator, Optional

from . import agent, db, paper as paper_mod, settings
from .agent import CredentialsMissing
from .fsaccess import FsAccess
from .pathcheck import precheck_path
from .render import IntegrityError, render_page
from .schemas import FinalizePayload
from .user_context import user_scope

_TERMINAL_STATUSES = {"done", "error"}


class _Broker:
    """Per-run fan-out of run events to live SSE subscribers."""

    def __init__(self) -> None:
        self._subs: dict[int, set[asyncio.Queue]] = {}

    def subscribe(self, run_id: int) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._subs.setdefault(run_id, set()).add(queue)
        return queue

    def unsubscribe(self, run_id: int, queue: asyncio.Queue) -> None:
        subs = self._subs.get(run_id)
        if subs:
            subs.discard(queue)
            if not subs:
                self._subs.pop(run_id, None)

    def publish(self, run_id: int, event: dict) -> None:
        for queue in list(self._subs.get(run_id, ())):
            queue.put_nowait(event)


_broker = _Broker()
# Hold references to detached tasks so they are not garbage-collected mid-run.
_tasks: set[asyncio.Task] = set()


def start_run(run_id: int, *, user_email: str) -> None:
    """Spawn the detached agent task for a running run."""
    task = asyncio.create_task(_execute_run(run_id, user_email))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _execute_run(run_id: int, user_email: str) -> None:
    # The task runs outside any HTTP request, so resolve settings as this user.
    with user_scope(user_email):
        try:
            await asyncio.wait_for(_run_body(run_id), timeout=settings.RUN_TIMEOUT_S)
        except asyncio.TimeoutError:
            _fail(run_id, "agent_failure", f"run timed out after {settings.RUN_TIMEOUT_S:.0f}s")
        except CredentialsMissing:
            _fail(run_id, "credentials_not_configured", "agent credentials not configured (ANTHROPIC_API_KEY)")
        except Exception as exc:  # never let a run task die silently
            _fail(run_id, "agent_failure", f"unexpected error: {exc}")


async def _run_body(run_id: int) -> None:
    run = db.get_run(run_id)
    if run is None:
        return

    # Re-validate the path on every run (plan §4): resolve the root fresh.
    check = await precheck_path(run["cluster"], run["path"])
    if not check.ok or not check.resolved_root:
        _fail(run_id, "broken_path", check.detail or "path precheck failed")
        return

    fs = FsAccess(run["cluster"], check.resolved_root)
    paper_row = db.get_paper(run_id)
    paper_block = paper_mod.load_paper_block(paper_row) if paper_row else []

    async def on_stage(stage: str, detail: str) -> None:
        event = db.add_stage_event(run_id, stage, detail)
        _broker.publish(run_id, {"type": "stage", "id": event["id"], "stage": stage, "detail": detail, "ts": event["ts"]})

    async def on_paper_mismatch(reason: str) -> None:
        db.set_paper_status(run_id, "mismatch", reason)
        _broker.publish(run_id, {"type": "warning", "kind": "paper_mismatch", "detail": reason})

    async def finalize_cb(raw: dict) -> tuple[bool, Optional[str]]:
        return await _try_finalize(run_id, raw)

    outcome = await agent.run_agent(
        fs=fs,
        cluster=run["cluster"],
        root=check.resolved_root,
        paper_block=paper_block,
        on_stage=on_stage,
        finalize_cb=finalize_cb,
        on_paper_mismatch=on_paper_mismatch,
    )

    if outcome.status == "done":
        db.update_run_status(
            run_id, "done", paper_status=outcome.paper_status, paper_warning=outcome.paper_warning or ""
        )
        _broker.publish(run_id, {"type": "done", "run_id": run_id})
        return

    kind = outcome.error_kind or "agent_failure"
    db.update_run_status(run_id, "error", error_kind=kind, error_detail=outcome.error_detail)
    _broker.publish(run_id, {"type": "error", "kind": kind, "detail": outcome.error_detail})


async def _try_finalize(run_id: int, raw: dict) -> tuple[bool, Optional[str]]:
    """Validate + persist + render one finalize attempt.

    Returns (True, None) on success (rows persisted, HTML cached), or
    (False, detail) so the agent can correct and call finalize_diagram again.
    """
    try:
        payload = FinalizePayload.model_validate(raw)
    except Exception as exc:
        return False, f"payload does not match the schema: {exc}"

    # Snippets must reference declared sources before we touch the DB.
    source_keys = {s.source_key for s in payload.sources}
    for comp in payload.components:
        for snip in comp.snippets:
            if snip.source_key not in source_keys:
                return False, f"component {comp.component_key!r} snippet references unknown source {snip.source_key!r}"

    db.persist_finalize(run_id, payload)
    model = db.load_diagram_model(run_id)
    try:
        html = render_page(model)
    except IntegrityError as exc:
        return False, str(exc)
    db.set_rendered_html(run_id, html)
    return True, None


def _fail(run_id: int, kind: str, detail: str) -> None:
    db.update_run_status(run_id, "error", error_kind=kind, error_detail=detail)
    _broker.publish(run_id, {"type": "error", "kind": kind, "detail": detail})


# ── SSE ────────────────────────────────────────────────────────────────────


async def event_stream(run_id: int) -> AsyncIterator[dict]:
    """Replay persisted stage events, then tail live events until terminal.

    Yields sse_starlette-compatible dicts (``{"data": <json>}``). Disconnect does
    not cancel the run. A terminal event closes the stream.
    """
    queue = _broker.subscribe(run_id)
    try:
        seen_ids: set[int] = set()
        for ev in db.list_stage_events(run_id):
            seen_ids.add(ev["id"])
            yield _sse({"type": "stage", "stage": ev["stage"], "detail": ev.get("detail") or "", "ts": ev["ts"]})

        run = db.get_run(run_id)
        if run is None:
            yield _sse({"type": "error", "kind": "agent_failure", "detail": "run not found"})
            return
        if run["status"] in _TERMINAL_STATUSES:
            yield _sse(_terminal_from_run(run))
            return

        while True:
            event = await queue.get()
            etype = event.get("type")
            if etype == "stage":
                if event.get("id") in seen_ids:
                    continue
                yield _sse({"type": "stage", "stage": event["stage"], "detail": event.get("detail") or "", "ts": event.get("ts")})
            elif etype == "warning":
                yield _sse({"type": "warning", "kind": event.get("kind"), "detail": event.get("detail")})
            elif etype == "done":
                yield _sse({"type": "done", "run_id": run_id})
                return
            elif etype == "error":
                yield _sse({"type": "error", "kind": event.get("kind"), "detail": event.get("detail")})
                return
    finally:
        _broker.unsubscribe(run_id, queue)


def _sse(payload: dict) -> dict:
    return {"data": json.dumps(payload)}


def _terminal_from_run(run: dict) -> dict:
    if run["status"] == "done":
        return {"type": "done", "run_id": run["id"]}
    return {"type": "error", "kind": run.get("error_kind"), "detail": run.get("error_detail")}
