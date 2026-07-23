"""Detached per-turn chat worker: ``python -m app.chat_worker <message_id>``.

Same infra as :mod:`app.run_worker` — a detached process (``start_new_session``),
pid recorded on the row, all state written to the sqlite DB (the assistant message
+ its activity log), terminal write guarded — so a chat turn survives a backend
restart and the DB-tail SSE streams it live.

It processes ONE pending assistant message: rebuilds the diagram context, replays
prior turns, runs the chat agent (SDK or Claude CLI), and finishes the message with
the answer text and, when the turn revised the diagram, the new run id.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from typing import Optional

from . import chat, db, paper as paper_mod, settings, staging
from .fsaccess import FsAccess, FsError, resolve_access
from .pathcheck import precheck_path
from .user_context import user_scope

_NO_RUNTIME = (
    "No agent runtime is configured. Set ANTHROPIC_API_KEY in the repo-root .env, or log in to "
    "the Claude Code CLI (run `claude` and sign in), then try again."
)


def _log(message_id: int, line: str) -> None:
    try:
        db.add_chat_output_line(message_id, line)
    except Exception:
        pass


async def execute_chat(message_id: int) -> None:
    msg = db.get_chat_message(message_id)
    if msg is None:
        return
    # user_email is carried by the anchor run (and the thread); resolve settings as them.
    anchor = db.get_run(int(msg["anchor_run_id"])) if msg.get("anchor_run_id") else None
    user_email = anchor["user_email"] if anchor else None
    with user_scope(user_email):
        try:
            await asyncio.wait_for(_chat_body(message_id, msg, anchor), timeout=settings.RUN_TIMEOUT_S)
        except asyncio.TimeoutError:
            _fail(message_id, f"chat timed out after {settings.RUN_TIMEOUT_S:.0f}s")
        except Exception as exc:  # never leave the message pending
            _fail(message_id, f"unexpected error: {exc}")


async def _chat_body(message_id: int, msg: dict, anchor: Optional[dict]) -> None:
    if anchor is None:
        _fail(message_id, "the diagram run this chat is anchored to no longer exists")
        return

    model = msg.get("model") or anchor.get("model") or settings.model_name()
    runtime = settings.runtime_for_model(model)
    if runtime == "none":
        _fail(message_id, _NO_RUNTIME)
        return

    check = await precheck_path(anchor["cluster"], anchor["path"])
    if not check.ok or not check.resolved_root:
        _fail(message_id, check.detail or "the model root is no longer reachable")
        return
    try:
        access = await resolve_access(anchor["cluster"])
    except FsError as exc:
        _fail(message_id, str(exc))
        return

    # The user's message is the latest row; prior turns are the history before it.
    thread_id = int(msg["thread_id"])
    all_msgs = db.list_chat_messages(thread_id)
    user_text = ""
    history: list[dict] = []
    for m in all_msgs:
        if m["id"] == message_id:
            continue
        if m["seq"] < msg["seq"]:
            history.append(m)
    # The paired user message is the newest user row before this assistant turn.
    user_rows = [m for m in history if m["role"] == "user"]
    if user_rows:
        user_text = user_rows[-1]["content"]
        history = [m for m in history if m["id"] != user_rows[-1]["id"]]

    summary = chat.build_diagram_summary(anchor["id"])
    # Papers are inherited across a diagram's runs, so the anchor run always carries
    # the diagram's paper. Inject it into the chat turn exactly as generation does,
    # so paper-mapping questions and revisions can cite it (a revision that omits the
    # paper's citations is otherwise rejected by finalize's integrity check).
    paper_row = db.get_paper(anchor["id"])
    outcome = chat.ChatOutcome()

    def on_log(line: str) -> None:
        _log(message_id, line)

    _log(message_id, f"chat · {runtime} runtime · model {model}")
    if paper_row:
        _log(message_id, "paper attached, injecting into chat context")

    if runtime == "sdk":
        fs = FsAccess(anchor["cluster"], check.resolved_root, access=access)
        paper_block = paper_mod.load_paper_block(paper_row) if paper_row else []
        await chat.run_chat_sdk(
            fs=fs, cluster=anchor["cluster"], root=check.resolved_root, model=model,
            summary=summary, history=history, user_message=user_text, paper_block=paper_block,
            revise_cb=chat.make_revise_cb(
                anchor_run=anchor, diagram_id=anchor["diagram_id"], user_email=anchor["user_email"],
                outcome=outcome, fs=fs,
            ),
            outcome=outcome, on_log=on_log,
        )
    elif runtime == "codex":
        await _run_codex_chat(message_id, anchor, check.resolved_root, access, model,
                              summary, history, user_text, paper_row, outcome, on_log)
    else:  # claude-cli
        paper_text = paper_mod.load_paper_text(paper_row) if paper_row else None
        await chat.run_chat_cli(
            message_id=message_id, cluster=anchor["cluster"], root=check.resolved_root, model=model,
            access=access, summary=summary, history=history, user_message=user_text,
            paper_text=paper_text, has_paper=paper_row is not None,
            outcome=outcome, on_log=on_log,
        )

    if outcome.status == "done":
        db.finish_chat_message(
            message_id, "done",
            content=outcome.answer_text or "Done.",
            revised_run_id=outcome.revise_run_id if outcome.revised else None,
        )
        _log(message_id, "finished: done" + (" (revised)" if outcome.revised else ""))
    else:
        _fail(message_id, outcome.error_detail or "the chat did not complete")


async def _run_codex_chat(message_id, anchor, resolved_root, access, model, summary,
                          history, user_text, paper_row, outcome, on_log) -> None:
    """Codex chat: the sandboxed MCP server can't ssh, so mirror a remote anchor
    root locally (like codex runs) and read from it; the mirror is deleted after."""
    eff_cluster, eff_root, eff_access = anchor["cluster"], resolved_root, access
    staged_dir: Optional[str] = None
    if anchor["cluster"] != "local":
        staged_dir = tempfile.mkdtemp(prefix=f"md-chat-stage-{message_id}-", dir=str(settings.stage_dir()))
        on_log(f"staging remote root to local mirror for codex chat ({staged_dir})")
        try:
            mirror = await staging.stage_root(
                access, resolved_root, staged_dir, size_cap_bytes=settings.codex_stage_max_bytes()
            )
        except staging.StagingError as exc:
            shutil.rmtree(staged_dir, ignore_errors=True)
            _fail(message_id, str(exc))
            return
        eff_cluster, eff_root, eff_access = "local", mirror, {"kind": "local"}

    staged_excludes = staging.excluded_file_globs() if staged_dir is not None else None
    fs = FsAccess(eff_cluster, eff_root, access=eff_access, staged_excludes=staged_excludes)
    paper_text = paper_mod.load_paper_text(paper_row) if paper_row else None
    try:
        await chat.run_chat_codex(
            message_id=message_id, cluster=eff_cluster, root=eff_root, model=model, access=eff_access,
            summary=summary, history=history, user_message=user_text,
            paper_text=paper_text, has_paper=paper_row is not None,
            revise_cb=chat.make_revise_cb(
                anchor_run=anchor, diagram_id=anchor["diagram_id"], user_email=anchor["user_email"],
                outcome=outcome, fs=fs,
            ),
            outcome=outcome, on_log=on_log,
        )
    finally:
        if staged_dir is not None:
            shutil.rmtree(staged_dir, ignore_errors=True)


def _fail(message_id: int, detail: str) -> None:
    db.finish_chat_message(message_id, "error", error_detail=detail)
    _log(message_id, f"failed: {detail}")


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print("usage: python -m app.chat_worker <message_id>", file=sys.stderr)
        return 2
    try:
        message_id = int(argv[0])
    except ValueError:
        print(f"invalid message_id: {argv[0]!r}", file=sys.stderr)
        return 2
    db.init_db()
    try:
        db.set_chat_pid(message_id, os.getpid())
    except Exception:
        pass
    asyncio.run(execute_chat(message_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
