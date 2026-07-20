"""Parse an OpenClaw on-disk transcript into ordered Turns.

Transcript files live at ``<AGENTS_ROOT>/<agentId>/sessions/<sessionId>.jsonl``.
They are Claude Code-style JSONL: line 1 is ``{"type":"session", ...}`` and the
rest are ``{"type":"message", "message":{"role","content"}}`` records. OpenClaw's
content blocks use its own schema (adapted from session-viewer's Claude parser):

- assistant text:   ``{"type":"text","text":...}``
- assistant call:   ``{"type":"toolCall","id","name","arguments","input"}``
- tool result:      role ``"toolResult"`` with ``{"type":"toolResult",
  "toolCallId"|"toolUseId"|"tool_use_id","content"|"text"}`` blocks
- user:             a plain string, or a list of ``text`` blocks

Parsing is defensive: bad lines are skipped, and any failure yields the turns
collected so far. Text/preview is capped at 2000 chars.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from . import settings
from .models import ToolCall, TranscriptDetail, Turn

log = logging.getLogger("openclaw.transcript")

PREVIEW_MAX = 2000
TRUNC_SUFFIX = "... [truncated]"

# Cron jobs have no transcript of their own; we fall back to their most recent
# run, whose Claude Code JSONL lives in the run workspace's project store. A run
# is matched by the ``cron:<jobId>`` marker the gateway injects into the first
# prompt. Scan is bounded so a huge project store can't stall a request.
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_MARKER_MAX_LINES = 20
_MAX_RUN_FILES_SCANNED = 500


def _truncate(text: str) -> str:
    if len(text) <= PREVIEW_MAX:
        return text
    return text[:PREVIEW_MAX] + TRUNC_SUFFIX


def _stringify(value: Any) -> str:
    """Stringify a tool-result / arguments value for a preview."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        all_text = True
        for block in value:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
            else:
                all_text = False
                break
        if all_text and parts:
            return "\n".join(parts)
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def _iter_records(path: Path) -> Iterable[dict[str, Any]]:
    """Yield parsed JSON objects from a jsonl file, skipping bad lines."""
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(rec, dict):
                yield rec


class _Builder:
    """Accumulates Turns plus a tool-call id index for attaching outputs."""

    def __init__(self) -> None:
        self.turns: list[Turn] = []
        self._by_id: dict[str, ToolCall] = {}

    def add_call(self, turn: Turn, name: str, input_preview: str, tool_id: Optional[str]) -> None:
        call = ToolCall(name=name, input_preview=_truncate(input_preview))
        turn.tool_calls.append(call)
        if tool_id:
            self._by_id[tool_id] = call

    def attach_output(self, tool_id: Optional[str], output: str) -> None:
        if tool_id is not None:
            call = self._by_id.get(tool_id)
            if call is not None and call.output_preview is None:
                call.output_preview = _truncate(output)
                return
        # Fall back to the last tool_call that has no output yet.
        for turn in reversed(self.turns):
            for call in reversed(turn.tool_calls):
                if call.output_preview is None:
                    call.output_preview = _truncate(output)
                    return


def _text_from_content(content: Any) -> str:
    """Join the text of a message's ``text`` blocks (or the raw string)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return ""


def _tool_result_id(block: dict[str, Any]) -> Optional[str]:
    for key in ("toolCallId", "toolUseId", "tool_use_id", "id"):
        v = block.get(key)
        if isinstance(v, str) and v:
            return v
    return None


def _ingest_message(b: _Builder, role: Any, content: Any, ts: Optional[str]) -> None:
    """Fold one message (role + content blocks) into the turn builder.

    Shared by the OpenClaw-envelope parser and the Claude Code parser: both
    reduce to a ``(role, content, ts)`` triple whose content blocks use the same
    schema (``text`` / ``tool_use`` / ``tool_result``).
    """
    if role == "assistant":
        turn = Turn(role="assistant", text="", ts=ts)
        text_parts: list[str] = []
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    t = block.get("text")
                    if isinstance(t, str):
                        text_parts.append(t)
                elif btype in ("toolCall", "tool_use"):
                    name = block.get("name") or "tool"
                    raw = block.get("arguments")
                    if raw is None:
                        raw = block.get("input", {})
                    b.add_call(turn, str(name), _stringify(raw), block.get("id"))
        elif isinstance(content, str):
            text_parts.append(content)
        turn.text = _truncate("\n".join(text_parts))
        # Skip empty assistant turns that carried no text and no calls.
        if turn.text or turn.tool_calls:
            b.turns.append(turn)
        return

    if role in ("toolResult", "tool"):
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                out = block.get("text")
                if not isinstance(out, str):
                    out = _stringify(block.get("content"))
                b.attach_output(_tool_result_id(block), out)
        return

    if role == "user":
        # A user message may itself carry tool_result blocks (Claude-style).
        if isinstance(content, list):
            results = [
                blk
                for blk in content
                if isinstance(blk, dict)
                and blk.get("type") in ("toolResult", "tool_result")
            ]
            non_results = [
                blk
                for blk in content
                if isinstance(blk, dict)
                and blk.get("type") not in ("toolResult", "tool_result")
            ]
            if results and not non_results:
                for tr in results:
                    out = tr.get("text")
                    if not isinstance(out, str):
                        out = _stringify(tr.get("content"))
                    b.attach_output(_tool_result_id(tr), out)
                return
        text = _text_from_content(content).strip()
        if text:
            b.turns.append(Turn(role="user", text=_truncate(text), ts=ts))
        return

    # Unknown role: ignore silently.


def _build_turns(path: Path) -> list[Turn]:
    b = _Builder()
    for rec in _iter_records(path):
        if rec.get("type") != "message":
            continue
        msg = rec.get("message") or {}
        if not isinstance(msg, dict):
            continue
        ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
        _ingest_message(b, msg.get("role"), msg.get("content"), ts)
    return b.turns


def build_detail(agent_id: str, session_id: str, path: Path) -> TranscriptDetail:
    """Read a transcript file into a TranscriptDetail (metadata + turns)."""
    cwd: Optional[str] = None
    model: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    message_count = 0
    turns: list[Turn] = []

    try:
        for rec in _iter_records(path):
            rtype = rec.get("type")
            ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
            if rtype == "session":
                if isinstance(rec.get("cwd"), str):
                    cwd = rec.get("cwd")
                if ts:
                    created_at = ts
                continue
            if rtype == "message":
                message_count += 1
                if ts:
                    updated_at = ts
                msg = rec.get("message") or {}
                if isinstance(msg, dict):
                    m = msg.get("model")
                    if isinstance(m, str) and m:
                        model = m
        turns = _build_turns(path)
    except Exception as exc:  # noqa: BLE001 - keep detail usable on partial fail
        log.warning("failed to build transcript for %s: %s", path, exc)

    if updated_at is None:
        try:
            updated_at = datetime.fromtimestamp(
                path.stat().st_mtime, tz=timezone.utc
            ).isoformat()
        except OSError:
            updated_at = None

    return TranscriptDetail(
        agent_id=agent_id,
        session_id=session_id,
        cwd=cwd,
        model=model,
        created_at=created_at,
        updated_at=updated_at,
        message_count=message_count,
        turns=turns,
        source="session",
    )


# --- Claude Code transcripts (cron run fallback) ---------------------------
# The claude-cli runtime writes Claude Code's native JSONL: the top-level
# ``type`` is the role (``user`` / ``assistant``), the message sits under
# ``message``, and an assistant turn is split across one record per content
# block (all sharing ``message.id``). We coalesce those back into one message so
# the shared block logic in ``_ingest_message`` applies unchanged.


def _claude_messages(path: Path) -> Iterator[tuple[str, Any, Optional[str]]]:
    """Yield ``(role, content, ts)`` from a Claude Code JSONL.

    Consecutive assistant records with the same ``message.id`` are merged into a
    single message (their block lists concatenated). Any non-message record type
    (``queue-operation``, ``attachment``, ``last-prompt``, …) flushes a pending
    assistant message and is otherwise ignored.
    """
    pend_id: Optional[str] = None
    pend_blocks: list[Any] = []
    pend_ts: Optional[str] = None

    def flush() -> Iterator[tuple[str, Any, Optional[str]]]:
        nonlocal pend_id, pend_blocks, pend_ts
        if pend_id is not None:
            yield "assistant", pend_blocks, pend_ts
            pend_id, pend_blocks, pend_ts = None, [], None

    for rec in _iter_records(path):
        rtype = rec.get("type")
        ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}

        if rtype == "assistant":
            mid = msg.get("id")
            content = msg.get("content")
            blocks = content if isinstance(content, list) else []
            if pend_id is not None and mid == pend_id:
                pend_blocks.extend(blocks)
            else:
                yield from flush()
                pend_id, pend_blocks, pend_ts = mid, list(blocks), ts
            continue

        yield from flush()
        if rtype == "user":
            yield "user", msg.get("content"), ts

    yield from flush()


def build_detail_claude(
    agent_id: str, session_id: str, path: Path, source: str
) -> TranscriptDetail:
    """Read a Claude Code JSONL into a TranscriptDetail (metadata + turns)."""
    cwd: Optional[str] = None
    model: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    message_count = 0
    turns: list[Turn] = []

    try:
        for rec in _iter_records(path):
            rtype = rec.get("type")
            if rtype not in ("user", "assistant"):
                continue
            message_count += 1
            ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
            if ts:
                if created_at is None:
                    created_at = ts
                updated_at = ts
            if cwd is None and isinstance(rec.get("cwd"), str):
                cwd = rec.get("cwd")
            if rtype == "assistant":
                msg = rec.get("message") or {}
                m = msg.get("model") if isinstance(msg, dict) else None
                if isinstance(m, str) and m:
                    model = m

        b = _Builder()
        for role, content, ts in _claude_messages(path):
            _ingest_message(b, role, content, ts)
        turns = b.turns
    except Exception as exc:  # noqa: BLE001 - keep detail usable on partial fail
        log.warning("failed to build claude transcript for %s: %s", path, exc)

    if updated_at is None:
        try:
            updated_at = datetime.fromtimestamp(
                path.stat().st_mtime, tz=timezone.utc
            ).isoformat()
        except OSError:
            updated_at = None

    return TranscriptDetail(
        agent_id=agent_id,
        session_id=session_id,
        cwd=cwd,
        model=model,
        created_at=created_at,
        updated_at=updated_at,
        message_count=message_count,
        turns=turns,
        source=source,
    )


def _claude_project_dir(workspace: Path) -> Path:
    """Claude Code's project store dir for ``workspace``.

    Claude slugifies the absolute workspace path by replacing every
    non-alphanumeric character with ``-`` (e.g. ``/Users/x/.openclaw/workspace``
    -> ``-Users-x--openclaw-workspace``).
    """
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(workspace))
    return settings.CLAUDE_PROJECTS_ROOT / slug


def _file_has_marker(path: Path, marker: str) -> bool:
    """True if ``marker`` appears in the first few lines of ``path``."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i >= _MARKER_MAX_LINES:
                    break
                if marker in line:
                    return True
    except OSError:
        return False
    return False


def find_latest_cron_run(job_id: str, workspace: Path) -> Optional[Path]:
    """Newest Claude Code transcript in ``workspace`` belonging to cron ``job_id``.

    Runs of the same job share a project dir with every other agent turn in that
    workspace, so a file is only accepted when it carries the ``cron:<jobId>``
    marker the gateway injects into the run's first prompt.
    """
    if not _JOB_ID_RE.match(job_id):
        return None
    proj = _claude_project_dir(workspace).resolve()
    if not proj.is_relative_to(settings.CLAUDE_PROJECTS_ROOT) or not proj.is_dir():
        return None
    marker = f"cron:{job_id}"
    try:
        files = sorted(
            proj.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
        )
    except OSError:
        return None
    for path in files[:_MAX_RUN_FILES_SCANNED]:
        if _file_has_marker(path, marker):
            return path
    return None


def _read_session_entry(agent_id: str, key: str) -> Optional[dict[str, Any]]:
    """Return the sessions.json entry for ``key`` under ``agent_id`` (or None)."""
    store = (settings.AGENTS_ROOT / agent_id / "sessions" / "sessions.json").resolve()
    if not store.is_relative_to(settings.AGENTS_ROOT) or not store.is_file():
        return None
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = data.get(key) if isinstance(data, dict) else None
    return entry if isinstance(entry, dict) else None


def resolve_by_key(agent_id: str, key: str) -> Optional[TranscriptDetail]:
    """Resolve a transcript from a session key.

    Prefers the session's own on-disk JSONL (via its ``sessionId``). When that is
    absent — as for a cron session, whose parent entry carries no ``sessionId``
    and whose runs write to Claude's project store — falls back to the job's most
    recent run, marking the result ``source="latest_run"``.
    """
    entry = _read_session_entry(agent_id, key) or {}
    sessions_dir = (settings.AGENTS_ROOT / agent_id / "sessions").resolve()

    session_id = entry.get("sessionId")
    if isinstance(session_id, str) and session_id:
        own = (sessions_dir / f"{session_id}.jsonl").resolve()
        if own.is_relative_to(settings.AGENTS_ROOT) and own.is_file():
            return build_detail(agent_id, session_id, own)

    if ":cron:" in key:
        job_id = key.split(":cron:", 1)[1].split(":", 1)[0]
        report = entry.get("systemPromptReport")
        ws = report.get("workspaceDir") if isinstance(report, dict) else None
        workspace = Path(ws) if isinstance(ws, str) and ws else settings.WORKSPACE_ROOT
        run = find_latest_cron_run(job_id, workspace)
        if run is not None:
            return build_detail_claude(agent_id, run.stem, run, source="latest_run")

    return None
