"""Session file scanning + light metadata parsing.

Three agents are supported:

- Claude Code: ``~/.claude/projects/*/*.jsonl`` (one JSON record per line).
- Codex CLI:   ``~/.codex/sessions/**/*.jsonl`` (one JSON record per line,
  each ``{"timestamp", "type", "payload"}``).
- OpenClaw:    ``~/.openclaw/agents/*/sessions/*.jsonl`` (OpenClaw message
  envelopes; trajectory sidecars are ignored).

Parsing is deliberately defensive: every file is wrapped in try/except and a
failed file is logged and skipped; individual unparseable lines are skipped too.
Only cheap metadata is extracted here; the full transcript lives in
``transcript.py``.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from .models import Session

log = logging.getLogger("session_board.sources")

# Title length cap and preview/truncation limits.
TITLE_MAX = 120

# Harness-injected text markers. If an extracted user message contains or starts
# with any of these, it is not a "genuine" user message and is skipped for the
# title fallback.
CLAUDE_INJECTED_MARKERS = (
    "<local-command-caveat>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<system-reminder>",
    "Caveat:",
    "<bash-input>",
    "<bash-stdout>",
)


def active_window() -> int:
    """ACTIVE_WINDOW in seconds, from env, default 300."""
    raw = os.environ.get("SESSION_BOARD_ACTIVE_WINDOW", "300")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 300


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------


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
                # Skip a single malformed line rather than failing the file.
                continue
            if isinstance(rec, dict):
                yield rec


def _collapse_ws(text: str) -> str:
    """Strip and collapse internal runs of whitespace to single spaces."""
    return " ".join(text.split())


def _cap_title(text: str) -> str:
    text = _collapse_ws(text)
    if len(text) > TITLE_MAX:
        text = text[:TITLE_MAX].rstrip()
    return text


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _is_active(path: Path) -> bool:
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        return False
    return age <= active_window()


def _to_dt(value: str) -> Optional[datetime]:
    """Parse an ISO8601 string to an aware datetime (UTC if naive); None if bad."""
    try:
        s = value.replace("Z", "+00:00") if value.endswith("Z") else value
        dt = datetime.fromisoformat(s)
    except (ValueError, AttributeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _min_max(values: Iterable[Optional[str]]) -> tuple[Optional[str], Optional[str]]:
    """Return (earliest, latest) ISO strings, ordered by parsed datetime.

    Comparing parsed datetimes (rather than raw strings) is robust to mixed
    fractional-second precision and timezone offsets. The original strings are
    returned so the stored timestamp format is preserved.
    """
    parsed = [(v, _to_dt(v)) for v in values if v]
    parsed = [(v, d) for (v, d) in parsed if d is not None]
    if not parsed:
        return None, None
    earliest = min(parsed, key=lambda p: p[1])[0]
    latest = max(parsed, key=lambda p: p[1])[0]
    return earliest, latest


# ---------------------------------------------------------------------------
# Claude
# ---------------------------------------------------------------------------


def _claude_text_from_content(content: Any) -> str:
    """Extract plain text from a Claude message ``content`` field.

    If content is a string, return it. If a list of blocks, join the ``text`` of
    blocks whose type is ``text``.
    """
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


def _claude_is_injected(text: str) -> bool:
    stripped = text.lstrip()
    for marker in CLAUDE_INJECTED_MARKERS:
        if marker in text or stripped.startswith(marker):
            return True
    return False


def parse_claude_meta(path: Path) -> Optional[Session]:
    """Parse one Claude session file into a Session (metadata only).

    Returns None if the file cannot be read at all.
    """
    try:
        session_id = path.stem

        ai_title: Optional[str] = None
        last_prompt: Optional[str] = None
        first_user_text: Optional[str] = None  # first genuine user message
        cwd: Optional[str] = None
        model: Optional[str] = None  # model of the LAST assistant record w/ one
        git_branch: Optional[str] = None  # last seen, ignoring literal "HEAD"
        cli_version: Optional[str] = None  # last seen version
        timestamps: list[str] = []
        message_count = 0

        for rec in _iter_records(path):
            rtype = rec.get("type")

            ts = rec.get("timestamp")
            if isinstance(ts, str) and ts:
                timestamps.append(ts)

            if rtype == "ai-title":
                t = rec.get("aiTitle")
                if isinstance(t, str) and t.strip():
                    ai_title = t
                continue

            if rtype == "last-prompt":
                t = rec.get("lastPrompt")
                if isinstance(t, str) and t.strip():
                    last_prompt = t
                continue

            if rtype == "user":
                message_count += 1
                if cwd is None and isinstance(rec.get("cwd"), str):
                    cwd = rec.get("cwd")
                branch = rec.get("gitBranch")
                if isinstance(branch, str):
                    git_branch = None if branch == "HEAD" else branch
                ver = rec.get("version")
                if isinstance(ver, str) and ver:
                    cli_version = ver
                if first_user_text is None:
                    msg = rec.get("message") or {}
                    text = _claude_text_from_content(msg.get("content"))
                    text = text.strip()
                    if text and not _claude_is_injected(text):
                        first_user_text = text
                continue

            if rtype == "assistant":
                message_count += 1
                if cwd is None and isinstance(rec.get("cwd"), str):
                    cwd = rec.get("cwd")
                msg = rec.get("message") or {}
                m = msg.get("model")
                if isinstance(m, str) and m:
                    model = m  # keep overwriting -> ends as last assistant model
                continue

            # Other record types may still carry cwd / version metadata.
            if cwd is None and isinstance(rec.get("cwd"), str):
                cwd = rec.get("cwd")

        cwd = cwd or ""
        project = Path(cwd).name if cwd else "unknown"

        # Title fallback chain.
        title = ai_title or last_prompt or first_user_text or session_id[:8]
        title = _cap_title(title)

        created_at, last_ts = _min_max(timestamps)
        updated_at = last_ts or _mtime_iso(path)

        return Session(
            uid=f"claude:{session_id}",
            agent="claude",
            id=session_id,
            path=str(path),
            project=project,
            cwd=cwd,
            title=title,
            last_prompt=(last_prompt.strip() if isinstance(last_prompt, str) else None),
            model=model,
            git_branch=git_branch,
            cli_version=cli_version,
            created_at=created_at,
            updated_at=updated_at,
            message_count=message_count,
            active=_is_active(path),
        )
    except Exception as exc:  # noqa: BLE001 - defensive per-file isolation
        log.warning("failed to parse claude session %s: %s", path, exc)
        return None


# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------


def _codex_is_injected(text: str) -> bool:
    """A Codex user message is injected if it starts with an instruction/markup
    block such as ``<environment>`` or ``<permissions>``.

    Only the leading-``<`` case is treated as injected. Matching the bare word
    "instructions" anywhere (the previous behaviour) wrongly dropped legitimate
    prompts like "follow these instructions to refactor X".
    """
    return text.lstrip().startswith("<")


def _codex_text_from_content(content: Any) -> str:
    """Join the ``text`` of input_text / output_text blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in (
                "input_text",
                "output_text",
            ):
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return ""


def _codex_git_branch(git: Any) -> Optional[str]:
    if isinstance(git, dict):
        branch = git.get("branch")
        if isinstance(branch, str) and branch and branch != "HEAD":
            return branch
        url = git.get("repository_url")
        if isinstance(url, str) and url:
            return url
    return None


def parse_codex_meta(path: Path) -> Optional[Session]:
    """Parse one Codex session file into a Session (metadata only)."""
    try:
        # Fallback id from filename: rollout-<ts>-<uuid>.jsonl -> last 5 dashed
        # groups form the uuid. Simpler + robust: take the trailing uuid chunk.
        fallback_id = path.stem
        if fallback_id.startswith("rollout-"):
            # rollout-2026-06-16T15-40-43-019ecf29-2f9a-7c42-ad41-b871d6b00ec5
            parts = fallback_id.split("-")
            if len(parts) >= 5:
                fallback_id = "-".join(parts[-5:])

        session_id: Optional[str] = None
        session_meta_seen = False
        cwd: Optional[str] = None
        cli_version: Optional[str] = None
        model: Optional[str] = None
        git_branch: Optional[str] = None
        meta_timestamp: Optional[str] = None
        timestamps: list[str] = []

        # Title candidates.
        title_event_user: Optional[str] = None  # first genuine event_msg user
        title_resp_user: Optional[str] = None  # first response_item user input

        # Message counts.
        event_msg_count = 0  # user_message + agent_message
        resp_msg_count = 0  # response_item messages role in {user, assistant}

        for rec in _iter_records(path):
            rtype = rec.get("type")
            ts = rec.get("timestamp")
            if isinstance(ts, str) and ts:
                timestamps.append(ts)

            payload = rec.get("payload")
            if not isinstance(payload, dict):
                continue

            if rtype == "session_meta":
                # A rollout can contain later nested session_meta records. The
                # file/card identity is the first session metadata record and
                # must never be overwritten by a child record.
                if session_meta_seen:
                    continue
                session_meta_seen = True
                pid = payload.get("id")
                if isinstance(pid, str) and pid:
                    session_id = pid
                if isinstance(payload.get("cwd"), str):
                    cwd = payload.get("cwd")
                if isinstance(payload.get("cli_version"), str):
                    cli_version = payload.get("cli_version")
                mt = payload.get("timestamp")
                if isinstance(mt, str) and mt:
                    meta_timestamp = mt
                gb = _codex_git_branch(payload.get("git"))
                if gb is not None:
                    git_branch = gb
                continue

            if rtype == "turn_context":
                m = payload.get("model")
                if isinstance(m, str) and m:
                    model = m
                if cwd is None and isinstance(payload.get("cwd"), str):
                    cwd = payload.get("cwd")
                continue

            if rtype == "event_msg":
                ptype = payload.get("type")
                if ptype == "user_message":
                    event_msg_count += 1
                    if title_event_user is None:
                        msg = payload.get("message")
                        if isinstance(msg, str):
                            text = msg.strip()
                            if text and not _codex_is_injected(text):
                                title_event_user = text
                elif ptype == "agent_message":
                    event_msg_count += 1
                continue

            if rtype == "response_item":
                ptype = payload.get("type")
                if ptype == "message":
                    role = payload.get("role")
                    if role in ("user", "assistant"):
                        resp_msg_count += 1
                    if role == "user" and title_resp_user is None:
                        text = _codex_text_from_content(payload.get("content")).strip()
                        if text and not _codex_is_injected(text):
                            title_resp_user = text
                continue

        session_id = session_id or fallback_id
        cwd = cwd or ""
        project = Path(cwd).name if cwd else "unknown"

        # Title fallback chain.
        title = title_event_user or title_resp_user or session_id[:8]
        title = _cap_title(title)

        last_prompt = title_event_user or title_resp_user
        if isinstance(last_prompt, str):
            last_prompt = last_prompt.strip() or None

        _, last_ts = _min_max(timestamps)
        created_at = meta_timestamp or (timestamps[0] if timestamps else None)
        updated_at = last_ts or _mtime_iso(path)

        message_count = event_msg_count if event_msg_count else resp_msg_count

        return Session(
            uid=f"codex:{session_id}",
            agent="codex",
            id=session_id,
            path=str(path),
            project=project,
            cwd=cwd,
            title=title,
            last_prompt=last_prompt,
            model=model,
            git_branch=git_branch,
            cli_version=cli_version,
            created_at=created_at,
            updated_at=updated_at,
            message_count=message_count,
            active=_is_active(path),
        )
    except Exception as exc:  # noqa: BLE001 - defensive per-file isolation
        log.warning("failed to parse codex session %s: %s", path, exc)
        return None


# ---------------------------------------------------------------------------
# OpenClaw
# ---------------------------------------------------------------------------


def _openclaw_text_from_content(content: Any) -> str:
    """Extract text from an OpenClaw string or text-block list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return ""


def _openclaw_message_identity(message: dict[str, Any]) -> Optional[str]:
    key = message.get("idempotencyKey")
    if isinstance(key, str) and key:
        return key
    metadata = message.get("__openclaw")
    if isinstance(metadata, dict):
        mirror = metadata.get("mirrorIdentity")
        if isinstance(mirror, str) and mirror:
            return mirror
    return None


def _openclaw_message_signature(message: dict[str, Any]) -> str:
    try:
        content = json.dumps(
            message.get("content"), ensure_ascii=False, sort_keys=True, default=str
        )
    except (TypeError, ValueError):
        content = str(message.get("content"))
    return f"{message.get('role')}\0{content}"


def _iter_openclaw_messages(
    path: Path,
) -> Iterator[tuple[dict[str, Any], dict[str, Any]]]:
    """Yield visible OpenClaw messages without Slack mirror copies."""
    seen_identities: set[str] = set()
    assistant_signatures: set[str] = set()
    for rec in _iter_records(path):
        if rec.get("type") != "message":
            continue
        message = rec.get("message") or {}
        if not isinstance(message, dict):
            continue
        identity = _openclaw_message_identity(message)
        if identity is not None:
            if identity in seen_identities:
                continue
            seen_identities.add(identity)
        signature = _openclaw_message_signature(message)
        if (
            isinstance(identity, str)
            and identity.startswith("channel-final:")
            and signature in assistant_signatures
        ):
            continue
        if message.get("role") == "assistant":
            assistant_signatures.add(signature)
        yield rec, message


def parse_openclaw_meta(path: Path) -> Optional[Session]:
    """Parse one OpenClaw session envelope file into board metadata."""
    try:
        session_id = path.name.removesuffix(".jsonl")
        agent_id = path.parent.parent.name or "main"
        cwd = ""
        created_at: Optional[str] = None
        timestamps: list[str] = []

        for rec in _iter_records(path):
            if rec.get("type") != "session":
                continue
            if isinstance(rec.get("cwd"), str):
                cwd = rec["cwd"]
            ts = rec.get("timestamp")
            if isinstance(ts, str) and ts:
                created_at = ts
                timestamps.append(ts)
            break

        first_prompt: Optional[str] = None
        last_prompt: Optional[str] = None
        model: Optional[str] = None
        message_count = 0
        for rec, message in _iter_openclaw_messages(path):
            ts = rec.get("timestamp")
            if isinstance(ts, str) and ts:
                timestamps.append(ts)
            role = message.get("role")
            if role not in ("user", "assistant"):
                continue
            message_count += 1
            if role == "user":
                text = _openclaw_text_from_content(message.get("content")).strip()
                if text:
                    first_prompt = first_prompt or text
                    last_prompt = text
            elif role == "assistant":
                value = message.get("model")
                if isinstance(value, str) and value:
                    model = value

        title = _cap_title(first_prompt or session_id[:8])
        _, last_ts = _min_max(timestamps)
        return Session(
            uid=f"openclaw:{session_id}",
            agent="openclaw",
            id=session_id,
            path=str(path),
            project=f"openclaw/{agent_id}",
            cwd=cwd,
            title=title,
            last_prompt=last_prompt,
            model=model,
            git_branch=None,
            cli_version=None,
            created_at=created_at,
            updated_at=last_ts or _mtime_iso(path),
            message_count=message_count,
            active=_is_active(path),
        )
    except Exception as exc:  # noqa: BLE001 - defensive per-file isolation
        log.warning("failed to parse openclaw session %s: %s", path, exc)
        return None
