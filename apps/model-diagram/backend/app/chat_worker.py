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
import sys
from typing import Optional

from . import chat, db, settings
from .fsaccess import FsAccess, FsError, resolve_access
from .pathcheck import precheck_path
from .user_context import user_scope

_CODEX_UNSUPPORTED = (
    "Follow-up chat isn't supported on the codex runtime yet — reopen this diagram with a "
    "Claude model (Fable/Opus/Sonnet/Haiku) to ask questions or request changes."
)
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
    if runtime == "codex":
        _finish_answer(message_id, _CODEX_UNSUPPORTED)
        return
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
    outcome = chat.ChatOutcome()

    def on_log(line: str) -> None:
        _log(message_id, line)

    _log(message_id, f"chat · {runtime} runtime · model {model}")

    if runtime == "sdk":
        fs = FsAccess(anchor["cluster"], check.resolved_root, access=access)
        await chat.run_chat_sdk(
            fs=fs, cluster=anchor["cluster"], root=check.resolved_root, model=model,
            summary=summary, history=history, user_message=user_text,
            revise_cb=chat.make_revise_cb(
                anchor_run=anchor, diagram_id=anchor["diagram_id"], user_email=anchor["user_email"],
                outcome=outcome, fs=fs,
            ),
            outcome=outcome, on_log=on_log,
        )
    else:  # claude-cli
        await chat.run_chat_cli(
            message_id=message_id, cluster=anchor["cluster"], root=check.resolved_root, model=model,
            access=access, summary=summary, history=history, user_message=user_text,
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


def _finish_answer(message_id: int, text: str) -> None:
    db.finish_chat_message(message_id, "done", content=text)


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
