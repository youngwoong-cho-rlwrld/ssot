"""FastAPI entrypoint for the model-diagram backend.

Mounted by the gateway at /model-diagram/api. Identity arrives via the
gateway-injected ``x-ssot-user`` header (SsotUserMiddleware); cluster settings
are read from the shared ssot.db keyed by that user. The HTTP contract is the
plan §10 boundary.
"""
from __future__ import annotations

import os
import socket
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse

from . import cluster_settings, db, paper as paper_mod, runs, settings, user_context
from .paper import PaperResult
from .pathcheck import precheck_path
from .schemas import (
    ChatRequest,
    CreateDiagramRequest,
    MemoRequest,
    PaperRef,
    ReprovisionRequest,
    ValidateRequest,
)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    db.init_db()
    # Runs execute in detached worker processes and survive a backend restart, so a
    # row left 'running' is only orphaned when its worker is actually gone. Fail
    # those (dead/missing pid) in the DB — the SSE source of truth — so reconnecting
    # clients see the error; live workers are left running.
    db.reconcile_orphaned_runs()
    db.reconcile_orphaned_chat()
    yield


app = FastAPI(title="model-diagram", lifespan=_lifespan)

_cors_origins = [
    o.strip()
    for o in os.environ.get("MODEL_DIAGRAM_CORS_ORIGINS", "http://localhost:5176").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(user_context.SsotUserMiddleware)


def _require_user() -> str:
    email = user_context.current_user_email()
    if not email:
        raise HTTPException(401, "authentication required")
    return email


async def _resolve_paper(paper: PaperRef | None) -> PaperResult | None:
    if paper is None:
        return None
    return await paper_mod.resolve_paper(paper.kind, url=paper.url, paper_ref=paper.paper_ref)


def _run_summary(run: dict) -> dict:
    return {
        "run_id": run["id"],
        "status": run["status"],
        "cluster": run["cluster"],
        "path": run["path"],
        "commit_hash": run.get("commit_hash"),
        "title": run.get("title"),
        "has_paper": db.run_has_paper(run["id"]),
        "paper_status": run.get("paper_status"),
        "error_kind": run.get("error_kind"),
        "created_at": run["created_at"],
    }


def _run_detail(run: dict) -> dict:
    detail = _run_summary(run)
    detail.update(
        {
            "diagram_id": run["diagram_id"],
            "model": run.get("model"),
            "error_detail": run.get("error_detail"),
            "paper_warning": run.get("paper_warning"),
            "updated_at": run["updated_at"],
            "stages": [
                {"stage": e["stage"], "detail": e.get("detail") or "", "ts": e["ts"]}
                for e in db.list_stage_events(run["id"])
            ],
        }
    )
    return detail


# ── discovery ─────────────────────────────────────────────────────────────


@app.get("/api/health")
async def health() -> dict:
    # `runtime` reports the claude generation path (backward compatible);
    # `runtimes` reports per-family AUTHENTICATED availability (claude: sdk|cli|null,
    # codex: cli|null) — a runtime whose CLI is installed but not logged in reports
    # null so the UI prompts for auth before a run is attempted; `runtime_status`
    # distinguishes that "unauthenticated" case from "missing" for the warning copy;
    # `anthropic_configured` is kept for backward compatibility.
    return {
        "status": "ok",
        "anthropic_configured": settings.anthropic_api_key() is not None,
        "runtime": settings.active_runtime(),
        "runtimes": settings.available_runtimes(),
        "runtime_status": settings.runtime_status(),
        # The machine the backend (and thus the agent CLIs) run on — auth setup must
        # happen HERE, not on the user's laptop, so the setup modal names it.
        "hostname": socket.gethostname(),
    }


@app.get("/api/models")
async def models() -> dict:
    _require_user()
    # Only offer models whose generation runtime is available right now (claude
    # models when the SDK key or Claude CLI is present; codex models when the codex
    # CLI is present). If the configured default is not currently available, fall
    # back to the first available id so the select's value is always an option.
    catalog = settings.available_model_catalog()
    default = settings.default_model()
    available_ids = {m["id"] for m in catalog}
    if default not in available_ids and catalog:
        default = catalog[0]["id"]
    return {"models": catalog, "default": default}


@app.get("/api/clusters")
async def clusters() -> dict:
    _require_user()
    names = ["local"]
    try:
        for name in cluster_settings.list_cluster_names():
            if name not in names:
                names.append(name)
    except Exception:
        pass
    return {"clusters": names}


# ── papers ────────────────────────────────────────────────────────────────


@app.post("/api/papers/upload")
async def upload_paper(file: UploadFile) -> JSONResponse:
    _require_user()
    data = await file.read()
    result = await paper_mod.validate_upload(data, filename=file.filename or "")
    if not result.ok:
        return JSONResponse(status_code=400, content={"error": "broken_paper", "detail": result.error})
    return JSONResponse(
        {
            "paper_ref": result.sha256,
            "filename": file.filename or "",
            "page_count": result.page_count,
            "sha256": result.sha256,
        }
    )


# ── validation ────────────────────────────────────────────────────────────


@app.post("/api/validate")
async def validate(body: ValidateRequest) -> dict:
    _require_user()
    check = await precheck_path(body.cluster, body.path)
    path_ok = check.ok
    paper_ok = True
    paper_detail = ""
    if body.paper is not None:
        result = await _resolve_paper(body.paper)
        paper_ok = result is not None and result.ok
        paper_detail = "" if paper_ok else (result.error if result else "paper missing")
    if path_ok and paper_ok:
        return {"ok": True}
    details = [d for d in (None if path_ok else check.detail, paper_detail if not paper_ok else None) if d]
    return {
        "ok": False,
        "path_error": None if path_ok else "broken_path",
        "paper_error": None if paper_ok else "broken_paper",
        "detail": "; ".join(details),
    }


# ── diagrams / runs ───────────────────────────────────────────────────────


@app.post("/api/diagrams")
async def create_diagram(body: CreateDiagramRequest) -> JSONResponse:
    email = _require_user()
    check = await precheck_path(body.cluster, body.path)
    if not check.ok:
        return JSONResponse(status_code=400, content={"error": "broken_path", "detail": check.detail})
    paper_result = await _resolve_paper(body.paper)
    if body.paper is not None and (paper_result is None or not paper_result.ok):
        detail = paper_result.error if paper_result else "paper missing"
        return JSONResponse(status_code=400, content={"error": "broken_paper", "detail": detail})

    try:
        model = settings.resolve_model(body.model)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    diagram_id, run_id = db.create_diagram_with_run(
        user_email=email, cluster=body.cluster, path=body.path, model=model
    )
    _attach_paper(run_id, paper_result)
    runs.start_run(run_id, user_email=email)
    return JSONResponse(status_code=201, content={"diagram_id": diagram_id, "run_id": run_id})


@app.post("/api/diagrams/{diagram_id}/runs")
async def reprovision(diagram_id: int, body: ReprovisionRequest) -> JSONResponse:
    email = _require_user()
    diagram = db.get_diagram(diagram_id)
    if diagram is None or diagram["user_email"] != email:
        raise HTTPException(404, "diagram not found")

    latest = db.list_runs(diagram_id)
    cluster = body.cluster or (latest[0]["cluster"] if latest else "local")
    path = body.path or (latest[0]["path"] if latest else diagram["path"])

    # The run whose paper we inherit when the request doesn't change it: the run
    # this re-provision was launched from (anchor), else the diagram's latest run.
    inherit_source_id: int | None = None
    if body.anchor_run_id is not None:
        anchor = db.get_run(body.anchor_run_id)
        if anchor is not None and anchor["diagram_id"] == diagram_id:
            inherit_source_id = anchor["id"]
    if inherit_source_id is None and latest:
        inherit_source_id = latest[0]["id"]

    check = await precheck_path(cluster, path)
    if not check.ok:
        return JSONResponse(status_code=400, content={"error": "broken_path", "detail": check.detail})

    # Paper intent is by PRESENCE: field absent → inherit; explicit null → remove;
    # a PaperRef → replace. Only validate when a replacement is actually supplied.
    paper_changed = "paper" in body.model_fields_set
    paper_result = None
    if paper_changed and body.paper is not None:
        paper_result = await _resolve_paper(body.paper)
        if paper_result is None or not paper_result.ok:
            detail = paper_result.error if paper_result else "paper missing"
            return JSONResponse(status_code=400, content={"error": "broken_paper", "detail": detail})

    try:
        model = settings.resolve_model(body.model)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    run_id = db.create_run(
        diagram_id=diagram_id, user_email=email, cluster=cluster, path=path, model=model
    )
    if not paper_changed:
        # Inherit the anchor/latest run's paper (copy_paper is a no-op if it had none).
        if inherit_source_id is not None:
            db.copy_paper(inherit_source_id, run_id)
    elif body.paper is not None:
        _attach_paper(run_id, paper_result)
    # else: explicit null → leave the new run paperless (removed).
    runs.start_run(run_id, user_email=email)
    return JSONResponse(status_code=201, content={"run_id": run_id})


@app.get("/api/diagrams")
async def list_diagrams() -> dict:
    email = _require_user()
    items = db.list_diagrams(email)
    return {
        "diagrams": [
            {
                "id": d["id"],
                "path": d["path"],
                "memo": d.get("memo") or "",
                "latest_run": _run_summary(d["latest_run"]) if d["latest_run"] else None,
            }
            for d in items
        ]
    }


@app.get("/api/diagrams/{diagram_id}")
async def get_diagram(diagram_id: int) -> dict:
    email = _require_user()
    diagram = db.get_diagram(diagram_id)
    if diagram is None or diagram["user_email"] != email:
        raise HTTPException(404, "diagram not found")
    return {
        "id": diagram["id"],
        "path": diagram["path"],
        "memo": diagram.get("memo") or "",
        "runs": [_run_summary(r) for r in db.list_runs(diagram_id)],
    }


@app.patch("/api/diagrams/{diagram_id}")
async def update_diagram_memo(diagram_id: int, body: MemoRequest) -> dict:
    email = _require_user()
    if not db.set_diagram_memo(diagram_id, user_email=email, memo=body.memo):
        raise HTTPException(404, "diagram not found")
    return {"id": diagram_id, "memo": body.memo}


@app.delete("/api/diagrams/{diagram_id}", status_code=204)
async def delete_diagram(diagram_id: int) -> Response:
    email = _require_user()
    if not db.delete_diagram(diagram_id, user_email=email):
        raise HTTPException(404, "diagram not found")
    return Response(status_code=204)


@app.get("/api/runs/{run_id}")
async def get_run(run_id: int) -> dict:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    # Lazily catch a run whose worker died so a fetch reflects the failure without
    # waiting for the next startup sweep.
    if run["status"] == "running" and db.reconcile_run_if_orphaned(run_id):
        run = db.get_run(run_id) or run
    return _run_detail(run)


@app.get("/api/runs/{run_id}/events")
async def run_events(run_id: int, request: Request) -> EventSourceResponse:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    headers = {"Cache-Control": "no-cache, no-transform"}
    return EventSourceResponse(runs.event_stream(run_id), headers=headers, ping=15)


@app.post("/api/runs/{run_id}/cancel")
async def cancel_run(run_id: int) -> dict:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    if run["status"] != "running":
        raise HTTPException(409, "run is not running")
    result = await runs.cancel_run(run_id)
    if result == "not_found":
        raise HTTPException(404, "run not found")
    if result == "not_running":
        raise HTTPException(409, "run is not running")
    return {"status": "cancelled"}


@app.get("/api/runs/{run_id}/output")
async def run_output(run_id: int, after_seq: int = 0) -> dict:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    lines = db.list_output(run_id, after_seq=after_seq)
    return {"lines": lines, "last_seq": lines[-1]["seq"] if lines else after_seq}


# ── chat (follow-up conversation about a diagram) ──────────────────────────


def _chat_message_out(msg: dict) -> dict:
    return {
        "id": msg["id"],
        "role": msg["role"],
        "content": msg.get("content") or "",
        "status": msg["status"],
        "error_detail": msg.get("error_detail"),
        "revised_run_id": msg.get("revised_run_id"),
        "anchor_run_id": msg.get("anchor_run_id"),
        "seq": msg["seq"],
        "created_at": msg["created_at"],
    }


# Chat is per RUN: each run has its own transcript (a revision's new run starts
# empty). Routes are keyed by run_id; the thread is created lazily on first use.


@app.get("/api/runs/{run_id}/chat")
async def get_run_chat(run_id: int) -> dict:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    # Read-only: a GET must not create a thread (that happens on the first POST). A
    # run with no thread yet returns an empty history, which the frontend renders as
    # the empty-chat state.
    thread_id = db.get_thread_id(run_id)
    messages = db.list_chat_messages(thread_id) if thread_id is not None else []
    return {
        "thread_id": thread_id,
        "run_id": run_id,
        "messages": [_chat_message_out(m) for m in messages],
    }


@app.post("/api/runs/{run_id}/chat", status_code=201)
async def post_run_chat(run_id: int, body: ChatRequest) -> dict:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    if run["status"] != "done":
        raise HTTPException(409, "chat is only available on a completed diagram run")

    # A per-turn model override is allowlist-validated; omitted → the run's model.
    if body.model:
        try:
            model = settings.resolve_model(body.model)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
    else:
        model = run.get("model")

    thread_id = db.get_or_create_thread(run_id, run["diagram_id"], email)
    db.add_chat_message(thread_id, role="user", content=body.message.strip(),
                        status="done", anchor_run_id=run_id)
    assistant = db.add_chat_message(
        thread_id, role="assistant", content="", status="pending",
        anchor_run_id=run_id, model=model,
    )
    runs.start_chat(assistant["id"])
    return {"thread_id": thread_id, "assistant_message_id": assistant["id"]}


def _require_chat_message(message_id: int, email: str) -> dict:
    msg = db.get_chat_message(message_id)
    if msg is None:
        raise HTTPException(404, "chat message not found")
    anchor = db.get_run(int(msg["anchor_run_id"])) if msg.get("anchor_run_id") else None
    if anchor is None or anchor["user_email"] != email:
        raise HTTPException(404, "chat message not found")
    return msg


@app.get("/api/chat/{message_id}/events")
async def chat_events(message_id: int, request: Request) -> EventSourceResponse:
    email = _require_user()
    _require_chat_message(message_id, email)
    headers = {"Cache-Control": "no-cache, no-transform"}
    return EventSourceResponse(runs.chat_event_stream(message_id), headers=headers, ping=15)


@app.get("/api/chat/{message_id}/output")
async def chat_output(message_id: int, after_seq: int = 0) -> dict:
    email = _require_user()
    _require_chat_message(message_id, email)
    lines = db.list_chat_output(message_id, after_seq=after_seq)
    return {"lines": lines, "last_seq": lines[-1]["seq"] if lines else after_seq}


@app.post("/api/chat/{message_id}/cancel")
async def cancel_chat(message_id: int) -> dict:
    email = _require_user()
    msg = _require_chat_message(message_id, email)
    if msg["status"] != "pending":
        raise HTTPException(409, "chat message is not pending")
    result = await runs.cancel_chat(message_id)
    if result == "not_found":
        raise HTTPException(404, "chat message not found")
    if result == "not_running":
        raise HTTPException(409, "chat message is not pending")
    return {"status": "cancelled"}


@app.get("/api/runs/{run_id}/page")
async def run_page(run_id: int) -> HTMLResponse:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    if not run.get("rendered_html"):
        return JSONResponse(status_code=409, content={"error": "run_not_done"})
    return HTMLResponse(run["rendered_html"])


def _attach_paper(run_id: int, result: PaperResult | None) -> None:
    if result is None or not result.ok:
        return
    db.add_paper(
        run_id,
        kind=result.kind,
        source_url=result.source_url,
        stored_path=result.stored_path,
        content_type=result.content_type,
        sha256=result.sha256,
        page_count=result.page_count,
        parsed_title=result.parsed_title,
        panel_path=result.panel_path,
    )
