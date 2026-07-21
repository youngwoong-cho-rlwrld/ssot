"""Pydantic v2 models matching the shared API contract exactly.

These mirror the frontend TypeScript types one-to-one. Nullable fields use
Optional[...] with a default of None (or a contract-specified default).
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Agent = Literal["claude", "codex", "openclaw"]
Role = Literal["user", "assistant", "system"]


class Session(BaseModel):
    """Lightweight per-session metadata (no transcript)."""

    uid: str  # f"{agent}:{id}"
    agent: Agent
    id: str  # uuid (filename stem)
    path: str  # absolute path to the .jsonl
    project: str  # basename of cwd, or "unknown"
    cwd: str
    title: str
    last_prompt: Optional[str] = None
    model: Optional[str] = None
    git_branch: Optional[str] = None
    cli_version: Optional[str] = None
    created_at: Optional[str] = None  # ISO8601
    updated_at: str  # ISO8601 (falls back to file mtime)
    message_count: int
    active: bool  # file mtime within ACTIVE_WINDOW seconds


class ToolCall(BaseModel):
    name: str
    input_preview: str  # truncated (<= 2000 chars)
    output_preview: Optional[str] = None


class Turn(BaseModel):
    role: Role
    text: str
    tool_calls: list[ToolCall] = []
    ts: Optional[str] = None


class SessionDetail(Session):
    """Session metadata plus the full ordered transcript."""

    turns: list[Turn] = []


class BoardNode(BaseModel):
    uid: str
    x: float = 0
    y: float = 0
    color: Optional[str] = None
    starred: bool = False
    note: str = ""
