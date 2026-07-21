"""Pydantic models for API payloads and the finalize_diagram tool schema.

The finalize payload matches the plan §6 tool schema verbatim: the agent submits
sources (with base64 content + line_count), components (with position / hp_value /
hp_cite / nested paper_citations / snippets) and edges. The backend normalizes it
into the plan §8 tables on ingest.
"""
from __future__ import annotations

import base64
import binascii
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

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


class ReprovisionRequest(BaseModel):
    cluster: Optional[Cluster] = None
    path: Optional[str] = None
    paper: Optional[PaperRef] = None


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


class FinalizePosition(BaseModel):
    left: int
    top: int
    width: int
    min_height: int


class FinalizeSource(BaseModel):
    source_key: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=500)
    content_b64: str = Field(min_length=1)
    line_count: int = Field(ge=0)

    @field_validator("content_b64")
    @classmethod
    def _valid_b64(cls, value: str) -> str:
        try:
            base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("content_b64 is not valid base64") from exc
        return value


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
                    "required": ["source_key", "name", "content_b64", "line_count"],
                    "properties": {
                        "source_key": {"type": "string"},
                        "name": {"type": "string"},
                        "content_b64": {"type": "string"},
                        "line_count": {"type": "integer"},
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
                                "required": ["label", "paper_value", "paper_location", "code_value", "confidence"],
                                "properties": {
                                    "label": {"type": "string"},
                                    "paper_value": {"type": "string"},
                                    "paper_location": {"type": "string"},
                                    "code_value": {"type": ["string", "null"]},
                                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
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
