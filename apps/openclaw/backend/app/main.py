"""FastAPI app fronting the local ``openclaw`` CLI for the SSOT portal.

Every endpoint either shells out to the CLI (status, sessions, logs, chat) or
reads an on-disk transcript. The backend binds to localhost only; the gateway
injects trusted identity headers and is the sole intended caller. See
``README.md`` for the endpoint list.
"""

from __future__ import annotations

import asyncio
import logging
import re

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import cli, instructions, pause_state, session_store, settings, transcript
from .models import (
    ChatRequest,
    HeartbeatRequest,
    ModelAuthRequest,
    ModelDefaultRequest,
    PauseRequest,
    TranscriptDetail,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("openclaw")

app = FastAPI(title="openclaw backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# A single path component: no separators, no dot-dot, conservative charset.
_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# A session key, e.g. ``agent:main:cron:<uuid>``. Colon-delimited; no path
# separators or dot-dot (it is never used to build a filesystem path).
_SESSION_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]*$")

# Heartbeat cadence, e.g. "15m", "1h", "30s", "2d".
_HEARTBEAT_EVERY = re.compile(r"^\d+[smhd]$")
_CADENCE_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
# Smallest heartbeat cadence we accept; guards against "0s"/"0m" and absurdly
# tight schedules that would hammer the model.
_CADENCE_FLOOR_SECONDS = 60
_chat_gate = asyncio.Semaphore(1)


def _cadence_seconds(every: str) -> int | None:
    """Duration in seconds for a cadence like ``30m``, or None if malformed."""
    if not _HEARTBEAT_EVERY.match(every):
        return None
    return int(every[:-1]) * _CADENCE_UNIT_SECONDS[every[-1]]


async def _config_heartbeat_enabled() -> bool:
    """Config-level heartbeat-enabled for the default agent (fallback view).

    Used only when this backend has no persisted best-known live state; defaults
    to True (heartbeat on) if status is unavailable.
    """
    try:
        st = await cli.status()
    except cli.CliError:
        return True
    agents = (st.get("heartbeat") or {}).get("agents") or []
    return bool(agents[0].get("enabled")) if agents else True


def _cli_error(exc: cli.CliError) -> JSONResponse:
    # cli_missing -> 503 (openclaw not installed); gateway_down/other -> 502.
    status_code = 503 if exc.kind == "cli_missing" else 502
    return JSONResponse(
        status_code=status_code,
        content={"error": exc.kind, "detail": str(exc)},
    )


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
async def status() -> JSONResponse:
    try:
        return JSONResponse(content=await cli.status())
    except cli.CliError as exc:
        return _cli_error(exc)


@app.get("/api/sessions")
async def sessions(limit: int = Query(100, ge=1, le=1000)) -> JSONResponse:
    try:
        return JSONResponse(content=await cli.sessions(limit))
    except cli.CliError as exc:
        return _cli_error(exc)


@app.get("/api/sessions/by-key", response_model=TranscriptDetail)
async def session_detail_by_key(
    agent_id: str = Query(...), key: str = Query(...)
) -> TranscriptDetail:
    """Resolve a transcript from a session key.

    Used for sessions whose transcript is not reachable by ``sessionId`` alone —
    notably cron sessions, whose parent store entry has no ``sessionId`` and
    whose runs write to Claude's own project store under a per-run uuid. The
    backend resolves the latest run and serves its turns (``source`` reports
    how it was found).
    """
    if not _SAFE_COMPONENT.match(agent_id):
        raise HTTPException(status_code=400, detail="invalid agent id")
    if not _SESSION_KEY.match(key):
        raise HTTPException(status_code=400, detail="invalid session key")
    detail = await asyncio.to_thread(transcript.resolve_by_key, agent_id, key)
    if detail is None:
        raise HTTPException(status_code=404, detail="transcript not found")
    return detail


@app.get("/api/sessions/{agent_id}/{session_id}", response_model=TranscriptDetail)
async def session_detail(agent_id: str, session_id: str) -> TranscriptDetail:
    if not (_SAFE_COMPONENT.match(agent_id) and _SAFE_COMPONENT.match(session_id)):
        raise HTTPException(status_code=400, detail="invalid agent or session id")

    path = (settings.AGENTS_ROOT / agent_id / "sessions" / f"{session_id}.jsonl").resolve()
    # Confirm the resolved path stays under AGENTS_ROOT (defence in depth on top
    # of the component charset check).
    if not path.is_relative_to(settings.AGENTS_ROOT):
        raise HTTPException(status_code=400, detail="path traversal rejected")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="transcript not found")

    return await asyncio.to_thread(transcript.build_detail, agent_id, session_id, path)


@app.delete("/api/sessions/{agent_id}/{session_id}")
async def session_delete(
    agent_id: str,
    session_id: str,
    force: bool = Query(False),
) -> JSONResponse:
    if not (_SAFE_COMPONENT.match(agent_id) and _SAFE_COMPONENT.match(session_id)):
        raise HTTPException(status_code=400, detail="invalid agent or session id")
    try:
        result = await asyncio.to_thread(
            session_store.delete_session, agent_id, session_id, force
        )
        cli.invalidate_sessions()
        return JSONResponse(content=result)
    except session_store.SessionNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except session_store.SessionActive as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"delete failed: {exc}") from exc


@app.get("/api/logs")
async def logs(limit: int = Query(200, ge=1, le=5000)) -> JSONResponse:
    try:
        return JSONResponse(content=await cli.logs(limit))
    except cli.CliError as exc:
        return _cli_error(exc)


@app.get("/api/logs/stream")
async def logs_stream(request: Request) -> StreamingResponse:
    async def event_source():
        try:
            async for line in cli.stream_logs():
                if await request.is_disconnected():
                    break
                # SSE frame: one data line per JSONL record.
                yield f"data: {line}\n\n"
        except cli.CliError as exc:
            yield f"event: error\ndata: {exc}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Disable proxy buffering so events flush immediately.
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/chat")
async def chat(body: ChatRequest, request: Request) -> JSONResponse:
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    model = body.model.strip() if body.model else None
    if model:
        try:
            merged = await cli.models_merged()
        except cli.CliError as exc:
            return _cli_error(exc)
        available = {
            item.get("key")
            for item in merged.get("models", [])
            if item.get("available")
        }
        if model not in available:
            raise HTTPException(status_code=400, detail=f"unavailable model: {model}")
    if _chat_gate.locked():
        return JSONResponse(
            status_code=429,
            content={"error": "agent_busy", "detail": "OpenClaw is already processing a chat turn."},
            headers={"Retry-After": "1"},
        )
    try:
        async with _chat_gate:
            result = await _until_disconnect(
                request,
                cli.agent_turn(message, body.session_key, model),
            )
        cli.invalidate_sessions()
        return JSONResponse(content=result)
    except cli.CliError as exc:
        return _cli_error(exc)


async def _until_disconnect(request: Request, operation) -> object:
    """Cancel a CLI-backed operation when its HTTP client disconnects."""
    task = asyncio.create_task(operation)
    try:
        while not task.done():
            done, _pending = await asyncio.wait({task}, timeout=0.25)
            if done:
                break
            if await request.is_disconnected():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise HTTPException(status_code=499, detail="client disconnected")
        return await task
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@app.get("/api/models")
async def models_get() -> JSONResponse:
    try:
        return JSONResponse(content=await cli.models_merged())
    except cli.CliError as exc:
        return _cli_error(exc)


@app.post("/api/models/default")
async def models_set_default(body: ModelDefaultRequest) -> JSONResponse:
    model = body.model.strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        merged = await cli.models_merged()
    except cli.CliError as exc:
        return _cli_error(exc)
    if model not in {m["key"] for m in merged["models"]}:
        raise HTTPException(status_code=400, detail=f"unknown model: {model}")
    try:
        await cli.models_set(model)
    except cli.CliError as exc:
        return _cli_error(exc)
    return JSONResponse(content={"ok": True, "defaultModel": model})


@app.post("/api/models/auth")
async def models_auth(body: ModelAuthRequest) -> JSONResponse:
    provider = body.provider.strip().lower()
    if not re.match(r"^[a-z0-9_-]+$", provider):
        raise HTTPException(status_code=400, detail="invalid provider")
    if not body.api_key.strip():
        raise HTTPException(status_code=400, detail="api_key is required")
    try:
        merged = await cli.models_merged()
    except cli.CliError as exc:
        return _cli_error(exc)
    if provider not in set(merged.get("providers", [])):
        raise HTTPException(status_code=400, detail=f"unknown provider: {provider}")
    try:
        # The key is piped via stdin inside the CLI wrapper and never logged.
        await cli.models_paste_api_key(provider, body.api_key)
    except cli.CliError as exc:
        return _cli_error(exc)
    return JSONResponse(content={"ok": True, "provider": provider})


@app.get("/api/heartbeat")
async def heartbeat_get() -> JSONResponse:
    try:
        st = await cli.status()
    except cli.CliError as exc:
        return _cli_error(exc)
    hb = st.get("heartbeat") or {}
    agents = hb.get("agents") or []
    pstate = await asyncio.to_thread(pause_state.read)
    # Prefer this backend's best-known live state; the config-level agent flag
    # does not reflect the live `system heartbeat` toggle.
    best = pstate.get("heartbeat_enabled")
    config_enabled = bool(agents[0].get("enabled")) if agents else True
    return JSONResponse(
        content={
            "defaultAgentId": hb.get("defaultAgentId"),
            "agents": agents,
            "paused": pstate.get("paused", False),
            "enabled": best if best is not None else config_enabled,
        }
    )


@app.post("/api/heartbeat")
async def heartbeat_set(body: HeartbeatRequest) -> JSONResponse:
    result: dict = {"ok": True}
    if body.every is not None:
        seconds = _cadence_seconds(body.every)
        if seconds is None or seconds < _CADENCE_FLOOR_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"every must be a duration >= {_CADENCE_FLOOR_SECONDS}s "
                    "(e.g. 60s, 30m, 1h)"
                ),
            )
        try:
            await cli.config_set("agents.defaults.heartbeat.every", body.every)
            result["every"] = body.every
        except cli.CliError as exc:
            return _cli_error(exc)
    if body.enabled is not None:
        try:
            await cli.system_heartbeat(body.enabled)
            result["enabled"] = body.enabled
        except cli.CliError as exc:
            return _cli_error(exc)
        # Record our best-known live heartbeat state for GET and pause/resume.
        state = await asyncio.to_thread(pause_state.read)
        state["heartbeat_enabled"] = body.enabled
        await asyncio.to_thread(pause_state.write, state)
    return JSONResponse(content=result)


@app.post("/api/pause")
async def pause(body: PauseRequest) -> JSONResponse:
    """Pause or resume all activity: heartbeat + all cron jobs.

    Pause disables heartbeat and every currently-enabled cron job, recording
    which jobs it disabled. Resume re-enables heartbeat and only the jobs pause
    had disabled (leaving jobs the user disabled themselves untouched). Per
    subsystem results are reported so partial failures are visible.
    """
    paused = body.paused
    state = await asyncio.to_thread(pause_state.read)
    result: dict = {"paused": paused}

    # --- Heartbeat: snapshot prior state on pause, restore conditionally on
    # resume. status.heartbeat.agents[].enabled is config-level and does not
    # reflect the live toggle, so we track our own best-known state and only
    # fall back to config when we have none.
    if paused:
        prior = state.get("heartbeat_enabled")
        if prior is None:
            prior = await _config_heartbeat_enabled()
        try:
            await cli.system_heartbeat(False)
            result["heartbeat"] = {"ok": True, "enabled": False}
            state["heartbeat_enabled"] = False
        except cli.CliError as exc:
            result["heartbeat"] = {"ok": False, "error": str(exc)}
        state["heartbeat_enabled_before_pause"] = prior
    else:
        want = state.get("heartbeat_enabled_before_pause")
        want = True if want is None else bool(want)
        if want:
            try:
                await cli.system_heartbeat(True)
                result["heartbeat"] = {"ok": True, "enabled": True}
                state["heartbeat_enabled"] = True
            except cli.CliError as exc:
                result["heartbeat"] = {"ok": False, "error": str(exc)}
        else:
            # Was disabled before pause: leave it disabled.
            result["heartbeat"] = {"ok": True, "enabled": False}
            state["heartbeat_enabled"] = False
        state["heartbeat_enabled_before_pause"] = None

    # --- Cron: no global toggle exists, so iterate jobs.
    cron: dict = {"ok": True, "failures": []}
    if paused:
        try:
            jobs = (await cli.cron_list()).get("jobs", [])
        except cli.CliError as exc:
            result["cron"] = {"ok": False, "error": str(exc)}
            state["paused"] = True
            await asyncio.to_thread(pause_state.write, state)
            return JSONResponse(content=result)
        disabled: list[str] = list(state.get("cron_disabled_by_pause") or [])
        for job in jobs:
            if job.get("enabled") and job.get("id"):
                try:
                    await cli.cron_set_enabled(job["id"], False)
                    if job["id"] not in disabled:
                        disabled.append(job["id"])
                except cli.CliError as exc:
                    cron["ok"] = False
                    cron["failures"].append({"id": job["id"], "error": str(exc)})
        state["cron_disabled_by_pause"] = disabled
        cron["disabled"] = disabled
    else:
        ids = list(state.get("cron_disabled_by_pause") or [])
        enabled_ids: list[str] = []
        still_failed: list[str] = []
        for job_id in ids:
            try:
                await cli.cron_set_enabled(job_id, True)
                enabled_ids.append(job_id)
            except cli.CliError as exc:
                cron["ok"] = False
                cron["failures"].append({"id": job_id, "error": str(exc)})
                # Keep failed ids so a later resume retries them.
                still_failed.append(job_id)
        state["cron_disabled_by_pause"] = still_failed
        cron["enabled"] = enabled_ids

    state["paused"] = paused
    await asyncio.to_thread(pause_state.write, state)
    result["cron"] = cron
    return JSONResponse(content=result)


@app.get("/api/instructions")
async def instructions_list() -> JSONResponse:
    return JSONResponse(content=await asyncio.to_thread(instructions.list_files))


@app.get("/api/instructions/{name}")
async def instruction_get(name: str) -> JSONResponse:
    try:
        return JSONResponse(content=await asyncio.to_thread(instructions.read_file, name))
    except instructions.InvalidName as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/api/instructions/{name}")
async def instruction_put(name: str, body: instructions.InstructionSave) -> JSONResponse:
    try:
        result = await asyncio.to_thread(instructions.write_file, name, body.content)
        return JSONResponse(content=result)
    except instructions.InvalidName as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"write failed: {exc}") from exc
