"""Detached per-run worker: ``python -m app.run_worker <run_id>``.

Executes the FULL agent flow for one run in its own OS process, writing every
piece of state — stage events, the live agent-output log, the finalized diagram
rows + cached HTML, and the terminal status — straight to the sqlite DB, which is
the single source of truth. Because the worker is a detached process (spawned with
``start_new_session=True``), a run SURVIVES a backend restart: dev-mode
``uvicorn --reload`` recycling the web process on every ``.py`` edit no longer
kills in-flight runs. The web process holds no run state in memory.

Runtime routing is unchanged (SDK / Claude-CLI / codex by the run's model family);
the only new wiring is ``on_log`` (condensed activity → :func:`db.add_output_line`)
and the DB-authoritative terminal write (the Claude-CLI runtime's MCP subprocess
may have already recorded the terminal status, so we never clobber it).
"""
from __future__ import annotations

import asyncio
import os
import sys
from typing import Optional

from . import agent, agent_cli, agent_codex, db, finalize, paper as paper_mod, settings, staging
from .agent import CredentialsMissing
from .agent_cli import CliUnavailable
from .agent_codex import CodexUnavailable
from .fsaccess import FsAccess, FsError, resolve_access
from .pathcheck import precheck_path
from .user_context import user_scope

_TERMINAL_STATUSES = {"done", "error"}
_NO_RUNTIME_DETAIL = (
    "No agent runtime is configured. Set ANTHROPIC_API_KEY in the repo-root .env, "
    "or log in to the Claude Code CLI (run `claude` and sign in), then restart the backend."
)
_NO_CODEX_RUNTIME_DETAIL = (
    "The codex CLI is not available for this model. Install it and sign in "
    "(run `codex login`), then restart the backend, or pick a Claude model."
)


def _log(run_id: int, line: str) -> None:
    """Persist one agent-output line; never let logging break a run."""
    try:
        db.add_output_line(run_id, line)
    except Exception:
        pass


async def execute_run(run_id: int) -> None:
    """Top-level entry: resolve the run's user, run it, and never die silently."""
    run = db.get_run(run_id)
    if run is None:
        return
    # The worker runs outside any HTTP request; resolve settings as the run's user.
    with user_scope(run.get("user_email")):
        try:
            await asyncio.wait_for(_run_body(run_id), timeout=settings.RUN_TIMEOUT_S)
        except asyncio.TimeoutError:
            _fail(run_id, "agent_failure", f"run timed out after {settings.RUN_TIMEOUT_S:.0f}s")
        except CodexUnavailable:
            _fail(run_id, "credentials_not_configured", _NO_CODEX_RUNTIME_DETAIL)
        except (CredentialsMissing, CliUnavailable):
            _fail(run_id, "credentials_not_configured", _NO_RUNTIME_DETAIL)
        except Exception as exc:  # never let a worker die without recording why
            _fail(run_id, "agent_failure", f"unexpected error: {exc}")


async def _run_body(run_id: int) -> None:
    run = db.get_run(run_id)
    if run is None:
        return

    # Re-validate the path on every run: resolve the root fresh.
    check = await precheck_path(run["cluster"], run["path"])
    if not check.ok or not check.resolved_root:
        _fail(run_id, "broken_path", check.detail or "path precheck failed")
        return

    model = run.get("model") or settings.model_name()
    runtime = settings.runtime_for_model(model)
    if runtime == "none":
        detail = _NO_CODEX_RUNTIME_DETAIL if settings.model_family(model) == "codex" else _NO_RUNTIME_DETAIL
        _fail(run_id, "credentials_not_configured", detail)
        return

    # Resolve cluster access ONCE, here where the user's identity + settings are
    # available. The resolved config is handed to the fs helpers and (on the
    # CLI/codex runtimes) to the out-of-process MCP worker — so no subprocess ever
    # reads ssot.db.
    try:
        access = await resolve_access(run["cluster"])
    except FsError as exc:
        _fail(run_id, "broken_path", str(exc))
        return

    # The codex runtime sandboxes the MCP server and blocks its network, so a codex
    # run on a REMOTE cluster cannot ssh/kubectl. Mirror the root to a local dir and
    # run against that (read scoping + finalize byte-fetch resolve locally). Other
    # runtimes reach remote roots directly and need no staging.
    if runtime == "codex" and run["cluster"] != "local":
        try:
            async with staging.staged_root_for_codex(
                access, check.resolved_root, prefix=f"md-stage-{run_id}-",
                on_log=lambda line: _log(run_id, line),
            ) as (eff_cluster, eff_root, eff_access, staged_excludes):
                _log(run_id, f"mirror ready; running codex against {eff_root}")
                # A read of an excluded (not-mirrored) artifact gets a clear error.
                await _dispatch_runtime(
                    run_id, runtime, model, eff_cluster, eff_root, eff_access,
                    staged_excludes=staged_excludes,
                )
        except staging.StagingError as exc:
            _fail(run_id, "broken_path", str(exc))
        return

    await _dispatch_runtime(run_id, runtime, model, run["cluster"], check.resolved_root, access)


async def _dispatch_runtime(
    run_id: int, runtime: str, model: str, cluster: str, root: str, access: dict,
    *, staged_excludes: Optional[tuple[str, ...]] = None,
) -> None:
    fs = FsAccess(cluster, root, access=access, staged_excludes=staged_excludes)
    paper_row = db.get_paper(run_id)

    async def on_stage(stage: str, detail: str) -> None:
        db.add_stage_event(run_id, stage, detail)

    async def on_paper_mismatch(reason: str) -> None:
        db.set_paper_status(run_id, "mismatch", reason)

    async def finalize_cb(raw: dict) -> tuple[bool, Optional[str]]:
        # The backend fetches each named source's bytes itself via the run's scoped
        # access (fs) — the agent no longer ships base64 in the finalize payload.
        return await finalize.try_finalize(run_id, raw, fs)

    def on_log(line: str) -> None:
        _log(run_id, line)

    _log(run_id, f"starting {runtime} runtime · model {model} · root {root}")

    if runtime == "sdk":
        paper_block = paper_mod.load_paper_block(paper_row) if paper_row else []
        outcome = await agent.run_agent(
            fs=fs,
            cluster=cluster,
            root=root,
            model=model,
            paper_block=paper_block,
            on_stage=on_stage,
            finalize_cb=finalize_cb,
            on_paper_mismatch=on_paper_mismatch,
            on_log=on_log,
        )
    elif runtime == "codex":
        paper_text = paper_mod.load_paper_text(paper_row) if paper_row else None
        outcome = await agent_codex.run_agent_codex(
            run_id=run_id,
            cluster=cluster,
            root=root,
            model=model,
            access=access,
            paper_text=paper_text,
            has_paper=paper_row is not None,
            on_stage=on_stage,
            finalize_cb=finalize_cb,
            on_paper_mismatch=on_paper_mismatch,
            on_log=on_log,
        )
    else:  # claude-cli
        paper_text = paper_mod.load_paper_text(paper_row) if paper_row else None
        outcome = await agent_cli.run_agent_cli(
            run_id=run_id,
            cluster=cluster,
            root=root,
            model=model,
            access=access,
            paper_text=paper_text,
            has_paper=paper_row is not None,
            on_stage=on_stage,
            finalize_cb=finalize_cb,
            on_paper_mismatch=on_paper_mismatch,
            on_log=on_log,
        )

    # DB is authoritative. On the Claude-CLI runtime the MCP subprocess already
    # wrote the terminal status (finalize / report_problem); respect it rather than
    # overwriting from our reconstructed outcome.
    current = db.get_run(run_id)
    if current and current["status"] in _TERMINAL_STATUSES:
        _log(run_id, f"finished: {current['status']}")
        return

    if outcome.status == "done":
        db.mark_terminal(
            run_id, "done", paper_status=outcome.paper_status, paper_warning=outcome.paper_warning or ""
        )
        _log(run_id, "finished: done")
        return

    kind = outcome.error_kind or "agent_failure"
    db.mark_terminal(run_id, "error", error_kind=kind, error_detail=outcome.error_detail)
    _log(run_id, f"finished: error ({kind}) {outcome.error_detail or ''}".rstrip())


def _fail(run_id: int, kind: str, detail: str) -> None:
    # Guarded so a run cancelled out from under us (SIGTERM → the worker unwinds) is
    # not overwritten with an agent_failure.
    db.mark_terminal(run_id, "error", error_kind=kind, error_detail=detail)
    _log(run_id, f"failed ({kind}): {detail}")


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print("usage: python -m app.run_worker <run_id>", file=sys.stderr)
        return 2
    try:
        run_id = int(argv[0])
    except ValueError:
        print(f"invalid run_id: {argv[0]!r}", file=sys.stderr)
        return 2
    db.init_db()
    # Belt-and-suspenders: record our own pid so liveness checks work even if the
    # parent never got to store it (the parent sets it right after spawn too).
    try:
        db.set_run_pid(run_id, os.getpid())
    except Exception:
        pass
    asyncio.run(execute_run(run_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
