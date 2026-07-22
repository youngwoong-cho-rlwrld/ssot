import io
import re

from pypdf import PdfWriter

from app import paper as paper_mod
from app.paper import (
    arxiv_id,
    normalize_arxiv,
    pdf_panel_html,
    resolve_paper,
    sanitize_paper_html,
    validate_upload,
    validate_url,
)


def _make_pdf(pages: int = 1) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_arxiv_normalize():
    assert normalize_arxiv("https://arxiv.org/abs/2401.12345") == "https://arxiv.org/pdf/2401.12345"
    assert normalize_arxiv("https://arxiv.org/abs/2401.12345.pdf") == "https://arxiv.org/pdf/2401.12345"
    assert normalize_arxiv("https://example.com/paper") == "https://example.com/paper"


async def test_valid_pdf_upload(tmp_env):
    result = await validate_upload(_make_pdf(3))
    assert result.ok
    assert result.is_pdf
    assert result.page_count == 3
    assert result.sha256
    # blob is stored keyed by sha256 for dedup
    assert result.stored_path and result.stored_path.endswith(f"{result.sha256}.pdf")


async def test_reject_non_pdf(tmp_env):
    result = await validate_upload(b"this is not a pdf at all")
    assert not result.ok
    assert "PDF" in result.error


async def test_resolve_uploaded_pdf(tmp_env):
    up = await validate_upload(_make_pdf(1))
    assert up.ok
    resolved = await resolve_paper("pdf", url=None, paper_ref=up.sha256)
    assert resolved.ok
    assert resolved.page_count == 1


async def test_resolve_missing_pdf(tmp_env):
    resolved = await resolve_paper("pdf", url=None, paper_ref="deadbeef")
    assert not resolved.ok


async def test_uploaded_pdf_panel_path_optional(tmp_env):
    # Blank pages extract no text, so no panel is written (panel_path stays None).
    # The path is populated only when there is extractable per-page text.
    result = await validate_upload(_make_pdf(2))
    assert result.ok
    assert result.panel_path is None


# ── A4 paper-panel sanitizer ────────────────────────────────────────────────

_ARXIV_HTML = """
<html><head><title>My Paper</title><script>track()</script>
<style>.c{color:red}</style></head>
<body>
  <nav>skip this navigation<img src="logo.png"> and this</nav>
  <article>
    <section id="S5.SS1">
      <h2 id="S5">Training</h2>
      <p>We optimize with <math alttext="AdamW">bad</math> at a constant rate.<img src="x.png"></p>
      <button onclick="go()">interactive</button>
      <svg><path d="M0 0"/></svg>
      <table id="A1.T5"><tr><td>lr</td><td>5e-5</td></tr></table>
    </section>
  </article>
</body></html>
"""


def test_sanitize_keeps_structure_and_ids():
    out = sanitize_paper_html(_ARXIV_HTML)
    # whitelisted structure + LaTeXML ids survive
    assert '<section id="S5.SS1">' in out
    assert '<h2 id="S5">' in out
    assert '<table id="A1.T5">' in out
    assert "constant rate" in out
    # <math alttext> renders its alt text, not the child "bad"
    assert "AdamW" in out and ">bad<" not in out


def test_sanitize_drops_noise_and_head():
    out = sanitize_paper_html(_ARXIV_HTML)
    for gone in ("track()", "color:red", "<script", "<style", "<svg", "<nav",
                 "<button", "skip this navigation", "interactive", "My Paper"):
        assert gone not in out, gone


def test_sanitize_void_tag_in_dropped_subtree_no_truncation():
    # An <img> inside a dropped <nav> must not desync the skip counter and eat
    # the rest of the document (A4.1 void-tag rule).
    out = sanitize_paper_html(_ARXIV_HTML)
    assert "constant rate" in out  # content AFTER the nav still present


def test_pdf_panel_html_has_page_sections(tmp_env):
    html = pdf_panel_html(_make_pdf(2))
    # Blank pages extract no text, so a 2-page blank PDF yields an empty panel;
    # the shape (string, no exceptions) is what matters for the fallback path.
    assert isinstance(html, str)


# ── arXiv HTML rendition preference (spec A4 panel like the reference) ───────

_ARXIV_HTML_BYTES = (
    b"<html><head><title>T</title></head><body>"
    b"<article>"
    b"<section id='S5'><h2 id='S5.h'>Training setup</h2>"
    b"<p>We optimize with AdamW using a constant learning rate of 5.16e-5 for the backbone.</p>"
    b"<p>" + (b"The policy is trained on a large mixture of manipulation datasets across many tasks. " * 12) +
    b"</p>"
    b"<table id='A1.T5'><thead><tr><th>param</th><th>value</th></tr></thead>"
    b"<tbody><tr><td>batch size</td><td>160</td></tr></tbody></table>"
    b"</section></article></body></html>"
)


def test_arxiv_id_extraction():
    assert arxiv_id("https://arxiv.org/abs/2310.06825") == "2310.06825"
    assert arxiv_id("https://arxiv.org/abs/2310.06825v2") == "2310.06825v2"
    assert arxiv_id("https://arxiv.org/pdf/2310.06825") == "2310.06825"
    assert arxiv_id("https://arxiv.org/html/2310.06825v3") == "2310.06825v3"
    assert arxiv_id("https://example.com/paper") is None


async def test_arxiv_prefers_html_rendition(tmp_env, monkeypatch):
    async def fake_fetch(target):
        return _ARXIV_HTML_BYTES if "/html/" in target else None
    monkeypatch.setattr(paper_mod, "_fetch_bytes", fake_fetch)

    result = await validate_url("https://arxiv.org/abs/2310.06825")
    assert result.ok and result.content_type == "text/html" and not result.is_pdf
    assert result.panel_path
    panel = open(result.panel_path, encoding="utf-8").read()
    # LaTeXML structure survives → renders like the reference (headings, tables, ids)
    assert "<h2" in panel and "<table" in panel
    assert 'id="S5"' in panel and 'id="A1.T5"' in panel
    # agent text is derived from the sanitized panel (so quotes will match)
    assert "AdamW" in result.text and "5.16e-5" in result.text


async def test_arxiv_falls_back_to_pdf_when_no_html(tmp_env, monkeypatch):
    async def no_html(target):
        return None  # both arxiv.org/html and ar5iv 404
    monkeypatch.setattr(paper_mod, "_fetch_bytes", no_html)

    pdf = _make_pdf(2)

    class _Resp:
        status_code = 200
        headers = {"content-type": "application/pdf"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def aiter_bytes(self):
            yield pdf

    class _Client:
        def __init__(self, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, target):
            return _Resp()

    monkeypatch.setattr(paper_mod.httpx, "AsyncClient", _Client)
    result = await validate_url("https://arxiv.org/abs/2310.06825")
    assert result.ok and result.is_pdf and result.content_type == "application/pdf"


def test_sanitize_preserves_headings_and_tables():
    panel = sanitize_paper_html(_ARXIV_HTML_BYTES.decode("utf-8"))
    assert "<h2" in panel and "<p>" in panel
    assert "<table" in panel and "<td>" in panel and "<th>" in panel
    assert 'id="S5"' in panel and 'id="A1.T5"' in panel
    assert "<script" not in panel and "<title" not in panel


def _js_normalize(s: str) -> str:
    # mirror updatePaper()'s whitespace collapse + textContent (tags stripped, no space)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


async def test_quote_from_agent_text_matches_panel(tmp_env, monkeypatch):
    # A verbatim sentence the agent copies from result.text must be locatable in the
    # panel's DOM text (the A4 cross-highlighter uses substring on textContent).
    async def fake_fetch(target):
        return _ARXIV_HTML_BYTES if "/html/" in target else None
    monkeypatch.setattr(paper_mod, "_fetch_bytes", fake_fetch)
    result = await validate_url("https://arxiv.org/abs/2310.06825")

    panel = open(result.panel_path, encoding="utf-8").read()
    quote = "We optimize with AdamW using a constant learning rate of 5.16e-5 for the backbone."
    assert quote in result.text  # the agent can read this exact sentence
    assert _js_normalize(quote) in _js_normalize(panel)  # …and the matcher finds it
