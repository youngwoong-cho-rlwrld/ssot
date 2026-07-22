"""Pydantic models for API payloads and the finalize_diagram tool schema.

The finalize payload matches the plan §6 tool schema verbatim: the agent submits
sources (with base64 content + line_count), components (with position / hp_value /
hp_cite / nested paper_citations / snippets) and edges. The backend normalizes it
into the plan §8 tables on ingest.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

# Cluster is an open enum: configured cluster names + "local".
Cluster = str
Confidence = Literal["high", "medium", "low"]
ComponentKind = Literal["component", "hp_row"]


# ── Request bodies ────────────────────────────────────────────────────────


class PaperRef(BaseModel):
    kind: Literal["url", "pdf"]
    url: Optional[str] = None
    paper_ref: Optional[str] = None


class ValidateRequest(BaseModel):
    cluster: Cluster
    path: str
    paper: Optional[PaperRef] = None


class CreateDiagramRequest(BaseModel):
    cluster: Cluster
    path: str
    paper: Optional[PaperRef] = None
    # Optional generation model id; validated against the backend allowlist in the
    # endpoint (settings.resolve_model). Omitted → the backend default.
    model: Optional[str] = None


class ReprovisionRequest(BaseModel):
    cluster: Optional[Cluster] = None
    path: Optional[str] = None
    paper: Optional[PaperRef] = None
    model: Optional[str] = None


class MemoRequest(BaseModel):
    memo: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    # The run being viewed when the question was asked; the chat is anchored to it.
    run_id: int
    message: str = Field(min_length=1, max_length=8000)
    # Optional per-turn generation model (allowlist-validated in the endpoint);
    # omitted falls back to the anchor run's model.
    model: Optional[str] = None


# ── finalize_diagram payload (validated server-side) ──────────────────────


class FinalizeCanvas(BaseModel):
    width: int = Field(ge=200, le=4000)
    height: int = Field(ge=200, le=20000)


class FinalizeSnippet(BaseModel):
    source_key: str = Field(min_length=1)
    start: int = Field(ge=1)
    end: int = Field(ge=1)


class FinalizePaperCitation(BaseModel):
    label: str = Field(min_length=1)
    paper_value: str = ""
    paper_location: str = ""
    code_value: Optional[str] = None
    confidence: Confidence = "high"
    # A4 embedded-paper panel: the exact sentence/table-cell (from the injected
    # paper) stating this value, plus an optional DOM anchor id in the sanitized
    # paper doc. ``paper_quote`` drives cross-highlighting in the paper pane; when
    # empty, the component gets no paper ref and the pane stays hidden for it.
    paper_quote: str = ""
    paper_anchor: str = ""


class FinalizePosition(BaseModel):
    left: int
    top: int
    width: int
    min_height: int


class FinalizeSource(BaseModel):
    source_key: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=500)
    # The agent NAMES the file; the backend fetches its exact bytes at finalize
    # time via the run's scoped read-only access (fsaccess) and embeds them. No
    # base64 crosses the tool boundary — a real repo's files would blow the single
    # finalize tool call past the run timeout. ``line_count`` is an OPTIONAL
    # expected count for cross-checking; the backend recomputes the authoritative
    # value from the bytes it fetches.
    line_count: Optional[int] = Field(default=None, ge=0)


class FinalizeComponent(BaseModel):
    component_key: str = Field(min_length=1, max_length=200)
    kebab_id: str = Field(min_length=1, max_length=200)
    kind: ComponentKind
    name_html: str = Field(min_length=1)
    shape_html: Optional[str] = None
    position: Optional[FinalizePosition] = None
    hp_value: Optional[str] = None
    hp_cite: Optional[str] = None
    snippets: list[FinalizeSnippet] = Field(default_factory=list)
    paper_citations: list[FinalizePaperCitation] = Field(default_factory=list)


class FinalizeEdge(BaseModel):
    path_d: str = Field(min_length=1)
    from_component_key: Optional[str] = None
    to_component_key: Optional[str] = None


class FinalizePayload(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    commit_hash: Optional[str] = None
    canvas: FinalizeCanvas
    sources: list[FinalizeSource] = Field(min_length=1)
    components: list[FinalizeComponent] = Field(min_length=1)
    edges: list[FinalizeEdge] = Field(default_factory=list)


def finalize_tool_schema() -> dict:
    """The finalize_diagram input_schema, verbatim from plan §6."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "commit_hash", "canvas", "sources", "components", "edges"],
        "properties": {
            "title": {"type": "string"},
            "commit_hash": {"type": ["string", "null"]},
            "canvas": {
                "type": "object",
                "additionalProperties": False,
                "required": ["width", "height"],
                "properties": {"width": {"type": "integer"}, "height": {"type": "integer"}},
            },
            "sources": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["source_key", "name", "line_count"],
                    "properties": {
                        "source_key": {"type": "string"},
                        "name": {"type": "string", "description": "Repo-relative path; the backend fetches its exact bytes."},
                        "line_count": {"type": ["integer", "null"], "description": "Optional expected line count (cross-check only)."},
                    },
                },
            },
            "components": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "component_key", "kebab_id", "kind", "name_html", "shape_html",
                        "position", "hp_value", "hp_cite", "snippets", "paper_citations",
                    ],
                    "properties": {
                        "component_key": {"type": "string"},
                        "kebab_id": {"type": "string"},
                        "kind": {"type": "string", "enum": ["component", "hp_row"]},
                        "name_html": {"type": "string"},
                        "shape_html": {"type": ["string", "null"]},
                        "position": {
                            "type": ["object", "null"],
                            "additionalProperties": False,
                            "required": ["left", "top", "width", "min_height"],
                            "properties": {
                                "left": {"type": "integer"},
                                "top": {"type": "integer"},
                                "width": {"type": "integer"},
                                "min_height": {"type": "integer"},
                            },
                        },
                        "hp_value": {"type": ["string", "null"]},
                        "hp_cite": {"type": ["string", "null"]},
                        "snippets": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["source_key", "start", "end"],
                                "properties": {
                                    "source_key": {"type": "string"},
                                    "start": {"type": "integer"},
                                    "end": {"type": "integer"},
                                },
                            },
                        },
                        "paper_citations": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": [
                                    "label", "paper_value", "paper_location", "code_value",
                                    "confidence", "paper_quote", "paper_anchor",
                                ],
                                "properties": {
                                    "label": {"type": "string"},
                                    "paper_value": {"type": "string"},
                                    "paper_location": {"type": "string"},
                                    "code_value": {"type": ["string", "null"]},
                                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                                    "paper_quote": {"type": "string"},
                                    "paper_anchor": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["path_d", "from_component_key", "to_component_key"],
                    "properties": {
                        "path_d": {"type": "string"},
                        "from_component_key": {"type": ["string", "null"]},
                        "to_component_key": {"type": ["string", "null"]},
                    },
                },
            },
        },
    }
