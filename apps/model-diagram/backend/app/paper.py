"""Paper fetch / normalize / validate for the ``broken_paper`` precheck (plan §3).

The agent has NO web access. Any paper the user attaches is fetched, validated,
and parsed HERE, then injected into the agent's initial message as a native PDF
document block (base64) or extracted HTML text. Blobs are stored on disk under
MODEL_DIAGRAM_PAPERS_DIR, keyed by sha256 (dedup).
"""
from __future__ import annotations

import base64
import hashlib
import io
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx
from pypdf import PdfReader

from . import settings

_ARXIV_ABS_RE = re.compile(r"^(https?://(?:www\.)?arxiv\.org)/abs/(.+?)(?:\.pdf)?$", re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_WS_RE = re.compile(r"[ \t\r\f\v]+")

_MIN_HTML_TEXT_CHARS = 800
_FETCH_TIMEOUT = 30.0


@dataclass
class PaperResult:
    ok: bool
    error: str = ""
    kind: str = ""  # 'url' | 'pdf'
    source_url: Optional[str] = None
    stored_path: Optional[str] = None
    content_type: Optional[str] = None
    sha256: Optional[str] = None
    page_count: Optional[int] = None
    parsed_title: Optional[str] = None
    is_pdf: bool = False
    text: Optional[str] = None  # extracted text for HTML papers


# ── URL normalization ─────────────────────────────────────────────────────


def normalize_arxiv(url: str) -> str:
    """Rewrite an arXiv /abs/ URL to its /pdf/ form; pass others through."""
    match = _ARXIV_ABS_RE.match(url.strip())
    if match:
        return f"{match.group(1)}/pdf/{match.group(2)}"
    return url.strip()


# ── validation entrypoints ────────────────────────────────────────────────


async def validate_upload(data: bytes, *, filename: str = "") -> PaperResult:
    """Validate an uploaded PDF (magic bytes, pypdf decode, caps) and store it."""
    if len(data) > settings.paper_max_bytes():
        return PaperResult(ok=False, error=f"PDF exceeds size cap ({settings.paper_max_bytes()} bytes)")
    if not data[:5].startswith(b"%PDF-"):
        return PaperResult(ok=False, error="not a PDF (missing %PDF magic bytes)")
    ok, detail, page_count, title = _decode_pdf(data)
    if not ok:
        return PaperResult(ok=False, error=detail)
    sha256 = hashlib.sha256(data).hexdigest()
    stored = _store_blob(data, sha256, ".pdf")
    return PaperResult(
        ok=True,
        kind="pdf",
        stored_path=str(stored),
        content_type="application/pdf",
        sha256=sha256,
        page_count=page_count,
        parsed_title=title,
        is_pdf=True,
    )


async def validate_url(url: str) -> PaperResult:
    """Fetch a paper URL with timeout+size caps and validate by content type."""
    target = normalize_arxiv(url)
    if not target.lower().startswith(("http://", "https://")):
        return PaperResult(ok=False, error="paper URL must be http(s)")
    cap = settings.paper_max_bytes()
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=_FETCH_TIMEOUT) as client:
            async with client.stream("GET", target) as response:
                if response.status_code >= 400:
                    return PaperResult(ok=False, error=f"fetch failed: HTTP {response.status_code}")
                content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > cap:
                        return PaperResult(ok=False, error=f"paper exceeds size cap ({cap} bytes)")
                    chunks.append(chunk)
        data = b"".join(chunks)
    except httpx.HTTPError as exc:
        return PaperResult(ok=False, error=f"could not fetch paper URL: {exc}")

    # Content-type sniffing: trust the header, but fall back to magic bytes.
    if content_type == "application/pdf" or data[:5].startswith(b"%PDF-"):
        ok, detail, page_count, title = _decode_pdf(data)
        if not ok:
            return PaperResult(ok=False, error=detail)
        sha256 = hashlib.sha256(data).hexdigest()
        stored = _store_blob(data, sha256, ".pdf")
        return PaperResult(
            ok=True, kind="url", source_url=url, stored_path=str(stored),
            content_type="application/pdf", sha256=sha256, page_count=page_count,
            parsed_title=title, is_pdf=True,
        )

    if content_type in ("text/html", "application/xhtml+xml", "text/plain") or not content_type:
        text, title = _extract_html_text(data)
        if len(text) < _MIN_HTML_TEXT_CHARS:
            return PaperResult(ok=False, error="no paper-like text found at URL")
        sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
        stored = _store_blob(text.encode("utf-8"), sha256, ".txt")
        return PaperResult(
            ok=True, kind="url", source_url=url, stored_path=str(stored),
            content_type="text/html", sha256=sha256, page_count=None,
            parsed_title=title, is_pdf=False, text=text,
        )

    return PaperResult(ok=False, error=f"unsupported content type: {content_type or 'unknown'}")


async def resolve_paper(kind: str, *, url: Optional[str], paper_ref: Optional[str]) -> PaperResult:
    """Resolve a PaperRef to a validated PaperResult (re-fetch URL, reload PDF)."""
    if kind == "url":
        if not url:
            return PaperResult(ok=False, error="paper URL missing")
        return await validate_url(url)
    if kind == "pdf":
        if not paper_ref:
            return PaperResult(ok=False, error="paper_ref missing")
        stored = settings.papers_dir() / f"{paper_ref}.pdf"
        if not stored.is_file():
            return PaperResult(ok=False, error="uploaded paper not found (re-upload)")
        data = stored.read_bytes()
        ok, detail, page_count, title = _decode_pdf(data)
        if not ok:
            return PaperResult(ok=False, error=detail)
        return PaperResult(
            ok=True, kind="pdf", stored_path=str(stored), content_type="application/pdf",
            sha256=paper_ref, page_count=page_count, parsed_title=title, is_pdf=True,
        )
    return PaperResult(ok=False, error=f"unknown paper kind: {kind}")


# ── content-block loader (for the agent's initial message) ─────────────────


def load_paper_block(paper_row: dict) -> list[dict]:
    """Build Anthropic content blocks from a persisted paper row."""
    stored_path = paper_row.get("stored_path")
    if not stored_path:
        return []
    path = Path(stored_path)
    if not path.is_file():
        return []
    if (paper_row.get("content_type") or "") == "application/pdf":
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        return [{
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": b64},
        }]
    text = path.read_text(encoding="utf-8", errors="replace")
    return [{"type": "text", "text": f"ATTACHED PAPER (extracted text):\n\n{text}"}]


def load_paper_text(paper_row: dict) -> Optional[str]:
    """Extract the paper as plain text for the CLI runtime's virtual read_file.

    The CLI path can't take a base64 document block in the initial message, so the
    paper is exposed through OUR read_file tool at ``__paper__``. PDFs are
    text-extracted with pypdf; HTML/text papers are already stored as ``.txt``.
    Returns None if no usable text can be produced.
    """
    stored_path = paper_row.get("stored_path")
    if not stored_path:
        return None
    path = Path(stored_path)
    if not path.is_file():
        return None
    if (paper_row.get("content_type") or "") == "application/pdf":
        try:
            reader = PdfReader(io.BytesIO(path.read_bytes()))
            pages = [page.extract_text() or "" for page in reader.pages]
        except Exception:
            return None
        text = "\n\n".join(pages).strip()
        return text or None
    return path.read_text(encoding="utf-8", errors="replace")


# ── internals ──────────────────────────────────────────────────────────────


def _store_blob(data: bytes, sha256: str, ext: str) -> Path:
    path = settings.papers_dir() / f"{sha256}{ext}"
    if not path.exists():  # dedup: identical content already stored
        path.write_bytes(data)
    return path


def _decode_pdf(data: bytes) -> tuple[bool, str, Optional[int], Optional[str]]:
    """Verify a PDF decodes via pypdf and respects the page cap."""
    try:
        reader = PdfReader(io.BytesIO(data))
        page_count = len(reader.pages)
    except Exception as exc:  # pypdf raises many error types on corrupt input
        return False, f"PDF could not be decoded: {exc}", None, None
    if page_count == 0:
        return False, "PDF has no pages", None, None
    if page_count > settings.paper_max_pages():
        return False, f"PDF exceeds page cap ({page_count} > {settings.paper_max_pages()})", None, None
    title = None
    try:
        if reader.metadata and reader.metadata.title:
            title = str(reader.metadata.title)
    except Exception:
        title = None
    return True, "", page_count, title


def _extract_html_text(data: bytes) -> tuple[str, Optional[str]]:
    html = data.decode("utf-8", errors="replace")
    title = None
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if title_match:
        title = _WS_RE.sub(" ", _HTML_TAG_RE.sub("", title_match.group(1))).strip() or None
    stripped = _SCRIPT_STYLE_RE.sub(" ", html)
    text = _HTML_TAG_RE.sub(" ", stripped)
    # Collapse entities minimally and whitespace.
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    lines = [_WS_RE.sub(" ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line), title
