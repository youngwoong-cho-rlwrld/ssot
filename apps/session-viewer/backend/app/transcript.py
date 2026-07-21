"""Full transcript parsing: build an ordered list of Turns for a session.

``build_detail(session)`` reads the whole session file and produces a
``SessionDetail`` (the metadata from ``sources`` plus ``turns``).

Truncation: any text or preview is capped at 2000 chars, appending
``"... [truncated]"`` when cut.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from .models import Session, SessionDetail, ToolCall, Turn
from .sources import (
    _claude_text_from_content,
    _codex_text_from_content,
    _iter_records,
    _iter_openclaw_messages,
    _openclaw_text_from_content,
)

log = logging.getLogger("session_board.transcript")

PREVIEW_MAX = 2000
TRUNC_SUFFIX = "... [truncated]"


def _truncate(text: str) -> str:
    if len(text) <= PREVIEW_MAX:
        return text
    return text[:PREVIEW_MAX] + TRUNC_SUFFIX


def _stringify(value: Any) -> str:
    """Stringify a tool-result / output value for a preview.

    Strings pass through. Lists of content blocks join their ``text`` fields when
    present, otherwise the whole thing is JSON-encoded. Anything else is
    JSON-encoded with a str() fallback.
    """
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


class _Builder:
    """Accumulates Turns plus a side index from tool-use id -> ToolCall.

    The id index is what lets a later tool_result / function_call_output find the
    exact ToolCall it belongs to without polluting the public ToolCall model with
    a non-contract field.
    """

    def __init__(self) -> None:
        self.turns: list[Turn] = []
        self._by_id: dict[str, ToolCall] = {}

    def add_call(self, turn: Turn, name: str, input_preview: str, tool_id: Optional[str]) -> None:
        call = ToolCall(name=name, input_preview=_truncate(input_preview))
        turn.tool_calls.append(call)
        if tool_id:
            self._by_id[tool_id] = call

    def attach_output(self, tool_use_id: Optional[str], output: str) -> bool:
        """Attach ``output`` to a matching tool_call's output_preview.

        Preference: the tool_call whose id matches ``tool_use_id`` (when still
        unfilled); otherwise the most recent tool_call lacking an output.
        """
        if tool_use_id is not None:
            call = self._by_id.get(tool_use_id)
            if call is not None and call.output_preview is None:
                call.output_preview = _truncate(output)
                return True
        # Fall back to the last tool_call that has no output yet.
        for turn in reversed(self.turns):
            for call in reversed(turn.tool_calls):
                if call.output_preview is None:
                    call.output_preview = _truncate(output)
                    return True
        return False


# ---------------------------------------------------------------------------
# Claude
# ---------------------------------------------------------------------------

_CLAUDE_SKIP_TYPES = {
    "attachment",
    "file-history-snapshot",
    "mode",
    "permission-mode",
    "ai-title",
    "last-prompt",
}


def _build_claude_turns(path: Path) -> list[Turn]:
    b = _Builder()

    for rec in _iter_records(path):
        rtype = rec.get("type")
        if rtype in _CLAUDE_SKIP_TYPES:
            continue
        ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None

        if rtype == "assistant":
            msg = rec.get("message") or {}
            blocks = msg.get("content")
            text_parts: list[str] = []
            turn = Turn(role="assistant", text="", ts=ts)
            if isinstance(blocks, list):
                for block in blocks:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "text":
                        t = block.get("text")
                        if isinstance(t, str):
                            text_parts.append(t)
                    elif btype == "tool_use":
                        name = block.get("name") or "tool"
                        try:
                            inp = json.dumps(
                                block.get("input", {}),
                                ensure_ascii=False,
                                default=str,
                            )
                        except (TypeError, ValueError):
                            inp = str(block.get("input"))
                        b.add_call(turn, str(name), inp, block.get("id"))
            elif isinstance(blocks, str):
                text_parts.append(blocks)
            turn.text = _truncate("\n".join(text_parts))
            b.turns.append(turn)
            continue

        if rtype == "user":
            msg = rec.get("message") or {}
            content = msg.get("content")
            # If content is a list of ONLY tool_result blocks, attach each result
            # as output to the matching prior tool_call instead of making a Turn.
            if isinstance(content, list):
                results = [
                    blk
                    for blk in content
                    if isinstance(blk, dict) and blk.get("type") == "tool_result"
                ]
                non_results = [
                    blk
                    for blk in content
                    if isinstance(blk, dict) and blk.get("type") != "tool_result"
                ]
                if results and not non_results:
                    for tr in results:
                        out = _stringify(tr.get("content"))
                        b.attach_output(tr.get("tool_use_id"), out)
                    continue
            # Otherwise a normal user turn from extracted text.
            text = _claude_text_from_content(content).strip()
            if text:
                b.turns.append(Turn(role="user", text=_truncate(text), ts=ts))
            continue

        # Unknown but not skipped: ignore silently.

    return b.turns


# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------


def _build_codex_turns(path: Path) -> list[Turn]:
    b = _Builder()
    saw_response_message = False
    event_fallback: list[Turn] = []

    for rec in _iter_records(path):
        rtype = rec.get("type")
        ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
        payload = rec.get("payload")
        if not isinstance(payload, dict):
            continue

        if rtype == "response_item":
            ptype = payload.get("type")

            if ptype == "message":
                role = payload.get("role")
                text = _codex_text_from_content(payload.get("content")).strip()
                if role == "assistant":
                    saw_response_message = True
                    b.turns.append(Turn(role="assistant", text=_truncate(text), ts=ts))
                elif role == "user":
                    saw_response_message = True
                    b.turns.append(Turn(role="user", text=_truncate(text), ts=ts))
                elif role == "developer":
                    saw_response_message = True
                    b.turns.append(Turn(role="system", text=_truncate(text), ts=ts))
                continue

            if ptype == "function_call":
                name = payload.get("name") or "tool"
                args = payload.get("arguments")
                if not isinstance(args, str):
                    try:
                        args = json.dumps(args, ensure_ascii=False, default=str)
                    except (TypeError, ValueError):
                        args = str(args)
                call_id = payload.get("call_id") or payload.get("id")
                # Append the call to the previous assistant turn, else open a new
                # assistant turn to carry it.
                if b.turns and b.turns[-1].role == "assistant":
                    turn = b.turns[-1]
                else:
                    turn = Turn(role="assistant", text="", ts=ts)
                    b.turns.append(turn)
                b.add_call(turn, str(name), args, call_id)
                continue

            if ptype == "function_call_output":
                out = _stringify(payload.get("output"))
                call_id = payload.get("call_id") or payload.get("id")
                b.attach_output(call_id, out)
                continue

            # reasoning and other response_item types are skipped.
            continue

        if rtype == "event_msg":
            ptype = payload.get("type")
            if ptype == "user_message":
                msg = payload.get("message")
                if isinstance(msg, str) and msg.strip():
                    event_fallback.append(
                        Turn(role="user", text=_truncate(msg.strip()), ts=ts)
                    )
            elif ptype == "agent_message":
                msg = payload.get("message")
                if isinstance(msg, str) and msg.strip():
                    event_fallback.append(
                        Turn(role="assistant", text=_truncate(msg.strip()), ts=ts)
                    )
            continue

    if not saw_response_message:
        # No response_item message records -> fall back to event_msg turns.
        return event_fallback
    return b.turns


# ---------------------------------------------------------------------------
# OpenClaw
# ---------------------------------------------------------------------------


def _build_openclaw_turns(path: Path) -> list[Turn]:
    b = _Builder()
    for rec, message in _iter_openclaw_messages(path):
        role = message.get("role")
        content = message.get("content")
        ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None

        if role == "assistant":
            turn = Turn(role="assistant", text="", ts=ts)
            text_parts: list[str] = []
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type")
                    if block_type == "text" and isinstance(block.get("text"), str):
                        text_parts.append(block["text"])
                    elif block_type in ("toolCall", "tool_use"):
                        raw = block.get("arguments")
                        if raw is None:
                            raw = block.get("input", {})
                        b.add_call(
                            turn,
                            str(block.get("name") or "tool"),
                            _stringify(raw),
                            block.get("id"),
                        )
            elif isinstance(content, str):
                text_parts.append(content)
            turn.text = _truncate("\n".join(text_parts))
            if turn.text or turn.tool_calls:
                b.turns.append(turn)
            continue

        if role in ("toolResult", "tool"):
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    output = block.get("text")
                    if not isinstance(output, str):
                        output = _stringify(block.get("content"))
                    tool_id = (
                        block.get("toolCallId")
                        or block.get("toolUseId")
                        or block.get("tool_use_id")
                        or block.get("id")
                    )
                    b.attach_output(tool_id, output)
            continue

        if role == "user":
            if isinstance(content, list):
                results = [
                    block
                    for block in content
                    if isinstance(block, dict)
                    and block.get("type") in ("toolResult", "tool_result")
                ]
                non_results = [
                    block
                    for block in content
                    if isinstance(block, dict)
                    and block.get("type") not in ("toolResult", "tool_result")
                ]
                if results and not non_results:
                    for block in results:
                        output = block.get("text")
                        if not isinstance(output, str):
                            output = _stringify(block.get("content"))
                        tool_id = (
                            block.get("toolCallId")
                            or block.get("toolUseId")
                            or block.get("tool_use_id")
                            or block.get("id")
                        )
                        b.attach_output(tool_id, output)
                    continue
            text = _openclaw_text_from_content(content).strip()
            if text:
                b.turns.append(Turn(role="user", text=_truncate(text), ts=ts))

    return b.turns


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def build_detail(session: Session) -> SessionDetail:
    """Build a SessionDetail (metadata + ordered turns) for a session."""
    path = Path(session.path)
    turns: list[Turn] = []
    try:
        if session.agent == "claude":
            turns = _build_claude_turns(path)
        elif session.agent == "codex":
            turns = _build_codex_turns(path)
        elif session.agent == "openclaw":
            turns = _build_openclaw_turns(path)
    except Exception as exc:  # noqa: BLE001 - keep detail usable on partial fail
        log.warning("failed to build transcript for %s: %s", session.path, exc)
        turns = []

    return SessionDetail(**session.model_dump(), turns=turns)
