"""Pydantic v2 models for the transcript contract.

These mirror the frontend TypeScript ``Turn`` / ``ToolCall`` types one-to-one
(adapted from session-viewer). The status / sessions / logs / chat endpoints
pass the CLI's own JSON straight through and need no models here.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Role = Literal["user", "assistant", "system"]


class ToolCall(BaseModel):
    name: str
    input_preview: str  # truncated (<= 2000 chars)
    output_preview: Optional[str] = None


class Turn(BaseModel):
    role: Role
    text: str
    tool_calls: list[ToolCall] = []
    ts: Optional[str] = None


class TranscriptDetail(BaseModel):
    """A session's on-disk transcript rendered as ordered turns."""

    agent_id: str
    session_id: str
    cwd: Optional[str] = None
    model: Optional[str] = None
    created_at: Optional[str] = None  # ISO8601
    updated_at: Optional[str] = None  # ISO8601
    message_count: int
    turns: list[Turn] = []
    # How this transcript was resolved: ``"session"`` for the session's own
    # on-disk JSONL, or ``"latest_run"`` when a cron session (which has no
    # transcript of its own) was served its most recent run's transcript.
    source: Optional[str] = None


class ChatRequest(BaseModel):
    message: str
    session_key: Optional[str] = None
    model: Optional[str] = Field(default=None, max_length=512)


class ModelDefaultRequest(BaseModel):
    model: str


class ModelAuthRequest(BaseModel):
    provider: str
    api_key: str


class HeartbeatRequest(BaseModel):
    every: Optional[str] = None
    enabled: Optional[bool] = None


class PauseRequest(BaseModel):
    paused: bool
