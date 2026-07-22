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
from html import escape as _html_escape
from html.parser import HTMLParser
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
    # A4 paper panel: path to the sanitized HTML rendering embedded in the page.
    panel_path: Optional[str] = None


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
    panel_path = _store_panel(pdf_panel_html(data), sha256)
    return PaperResult(
        ok=True,
        kind="pdf",
        stored_path=str(stored),
        content_type="application/pdf",
        sha256=sha256,
        page_count=page_count,
        parsed_title=title,
        is_pdf=True,
        panel_path=panel_path,
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
        panel_path = _store_panel(pdf_panel_html(data), sha256)
        return PaperResult(
            ok=True, kind="url", source_url=url, stored_path=str(stored),
            content_type="application/pdf", sha256=sha256, page_count=page_count,
            parsed_title=title, is_pdf=True, panel_path=panel_path,
        )

    if content_type in ("text/html", "application/xhtml+xml", "text/plain") or not content_type:
        text, title = _extract_html_text(data)
        if len(text) < _MIN_HTML_TEXT_CHARS:
            return PaperResult(ok=False, error="no paper-like text found at URL")
        sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
        stored = _store_blob(text.encode("utf-8"), sha256, ".txt")
        raw_html = data.decode("utf-8", errors="replace")
        panel_path = _store_panel(sanitize_paper_html(raw_html), sha256)
        return PaperResult(
            ok=True, kind="url", source_url=url, stored_path=str(stored),
            content_type="text/html", sha256=sha256, page_count=None,
            parsed_title=title, is_pdf=False, text=text, panel_path=panel_path,
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
        panel_path = _store_panel(pdf_panel_html(data), paper_ref)
        return PaperResult(
            ok=True, kind="pdf", stored_path=str(stored), content_type="application/pdf",
            sha256=paper_ref, page_count=page_count, parsed_title=title, is_pdf=True,
            panel_path=panel_path,
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


# ── A4 paper-panel rendering (sanitized HTML embedded in the page) ──────────

# Structural tags kept for the embedded paper pane; every attribute is stripped
# except ``id`` (the LaTeXML anchors the cross-highlighting scrolls to).
_PANEL_KEEP_TAGS = frozenset({
    "section", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "em", "i", "b",
    "strong", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "figure",
    "figcaption", "ul", "ol", "li", "div", "br", "cite", "sub", "sup",
})
# Dropped WITH their content (subtree skipped): the noise/interactive/vector bits.
_PANEL_DROP_TAGS = frozenset({"script", "style", "svg", "nav", "button", "annotation", "annotation-xml"})
# Void elements never emit an end tag, so they must never touch the skip counter
# (A4.1): an <img> inside a dropped subtree that bumps skip is never balanced and
# silently truncates the rest of the document.
_PANEL_VOID_TAGS = frozenset({
    "br", "img", "hr", "input", "meta", "link", "area", "base", "col", "embed",
    "source", "track", "wbr",
})
_ARTICLE_RE = re.compile(r"<article\b[^>]*>(.*?)</article>", re.IGNORECASE | re.DOTALL)
_BODY_RE = re.compile(r"<body\b[^>]*>(.*?)</body>", re.IGNORECASE | re.DOTALL)


class _PanelSanitizer(HTMLParser):
    """Reduce arbitrary paper HTML to the whitelisted, id-preserving subset (A4.1)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0  # depth inside a dropped subtree

    def handle_starttag(self, tag: str, attrs: list) -> None:
        tag = tag.lower()
        if tag == "math":
            # Render the LaTeX alt text as escaped text; skip the MathML children.
            if not self._skip:
                alt = dict(attrs).get("alttext")
                if alt:
                    self.parts.append(_html_escape(alt))
            self._skip += 1
            return
        if tag in _PANEL_DROP_TAGS:
            if tag not in _PANEL_VOID_TAGS:
                self._skip += 1
            return
        if self._skip:
            return
        if tag not in _PANEL_KEEP_TAGS:
            return
        if tag in _PANEL_VOID_TAGS:
            self.parts.append(f"<{tag}>")
            return
        anchor = dict(attrs).get("id")
        if anchor:
            self.parts.append(f'<{tag} id="{_html_escape(anchor, quote=True)}">')
        else:
            self.parts.append(f"<{tag}>")

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        tag = tag.lower()
        if tag == "math" and not self._skip:
            alt = dict(attrs).get("alttext")
            if alt:
                self.parts.append(_html_escape(alt))
            return
        if self._skip:
            return
        if tag in _PANEL_KEEP_TAGS and tag in _PANEL_VOID_TAGS:
            self.parts.append(f"<{tag}>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "math":
            if self._skip:
                self._skip -= 1
            return
        if tag in _PANEL_DROP_TAGS:
            if tag not in _PANEL_VOID_TAGS and self._skip:
                self._skip -= 1
            return
        if self._skip:
            return
        if tag in _PANEL_KEEP_TAGS and tag not in _PANEL_VOID_TAGS:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(_html_escape(data))


def sanitize_paper_html(raw_html: str) -> str:
    """Sanitized, id-preserving HTML for the embedded paper pane (A4.1).

    Slices to the paper's <article> (else <body>) so head/nav text never leaks,
    then keeps only the whitelisted structural tags with ids intact.
    """
    match = _ARTICLE_RE.search(raw_html) or _BODY_RE.search(raw_html)
    fragment = match.group(1) if match else raw_html
    parser = _PanelSanitizer()
    parser.feed(fragment)
    parser.close()
    return "".join(parser.parts).strip()


def pdf_panel_html(data: bytes) -> str:
    """Panel HTML for a PDF paper: one id'd section per page of extracted text.

    PDFs carry no DOM, so the pane falls back to per-page text sections
    (``id="page-N"``) whose paragraphs the agent's quotes can still be found in.
    """
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception:
        return ""
    sections: list[str] = []
    for index, page_text in enumerate(pages, start=1):
        paras = [_WS_RE.sub(" ", p).strip() for p in re.split(r"\n\s*\n", page_text)]
        body = "".join(f"<p>{_html_escape(p)}</p>" for p in paras if p)
        if not body:
            continue
        sections.append(f'<section id="page-{index}"><h3>Page {index}</h3>{body}</section>')
    return "".join(sections)


def _store_panel(panel_html: str, sha256: str) -> Optional[str]:
    """Store the panel HTML next to its paper blob, keyed by the paper sha256."""
    if not panel_html:
        return None
    path = settings.papers_dir() / f"{sha256}.panel.html"
    path.write_text(panel_html, encoding="utf-8")
    return str(path)
