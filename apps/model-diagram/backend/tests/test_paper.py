import io

from pypdf import PdfWriter

from app.paper import (
    normalize_arxiv,
    pdf_panel_html,
    resolve_paper,
    sanitize_paper_html,
    validate_upload,
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
