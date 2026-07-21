import io

from pypdf import PdfWriter

from app.paper import normalize_arxiv, resolve_paper, validate_upload


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
