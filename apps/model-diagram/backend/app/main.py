"""FastAPI entrypoint for the model-diagram backend.

Mounted by the gateway at /model-diagram/api. Identity arrives via the
gateway-injected ``x-ssot-user`` header (SsotUserMiddleware); cluster settings
are read from the shared ssot.db keyed by that user. The HTTP contract is the
plan §10 boundary.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse

from . import cluster_settings, db, paper as paper_mod, runs, settings, user_context
from .paper import PaperResult
from .pathcheck import precheck_path
from .schemas import CreateDiagramRequest, PaperRef, ReprovisionRequest, ValidateRequest


@asynccontextmanager
async def _lifespan(app: FastAPI):
    db.init_db()
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
    return {"status": "ok", "anthropic_configured": settings.anthropic_api_key() is not None}


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

    diagram_id, run_id = db.create_diagram_with_run(
        user_email=email, cluster=body.cluster, path=body.path, model=settings.model_name()
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

    check = await precheck_path(cluster, path)
    if not check.ok:
        return JSONResponse(status_code=400, content={"error": "broken_path", "detail": check.detail})
    paper_result = await _resolve_paper(body.paper)
    if body.paper is not None and (paper_result is None or not paper_result.ok):
        detail = paper_result.error if paper_result else "paper missing"
        return JSONResponse(status_code=400, content={"error": "broken_paper", "detail": detail})

    run_id = db.create_run(
        diagram_id=diagram_id, user_email=email, cluster=cluster, path=path, model=settings.model_name()
    )
    _attach_paper(run_id, paper_result)
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
        "runs": [_run_summary(r) for r in db.list_runs(diagram_id)],
    }


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
    return _run_detail(run)


@app.get("/api/runs/{run_id}/events")
async def run_events(run_id: int, request: Request) -> EventSourceResponse:
    email = _require_user()
    run = db.get_run(run_id)
    if run is None or run["user_email"] != email:
        raise HTTPException(404, "run not found")
    headers = {"Cache-Control": "no-cache, no-transform"}
    return EventSourceResponse(runs.event_stream(run_id), headers=headers, ping=15)


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
    )
