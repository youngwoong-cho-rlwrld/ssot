import base64

import pytest

from app.render import IntegrityError, check_integrity, render_page

_SRC = "class M:\n    d = 1\n    e = 2\n"


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _component(cid, key, kebab, kind, *, left=None, top=None, hp_value=None, hp_cite=None, name="X"):
    return {
        "id": cid, "component_key": key, "kebab_id": kebab, "kind": kind,
        "name_html": name, "shape_html": "", "left_px": left, "top_px": top,
        "width_px": 190 if left is not None else None, "min_height_px": 62 if left is not None else None,
        "hp_value": hp_value, "hp_cite": hp_cite, "ordinal": cid,
    }


def _model(*, end_line: int = 3, with_paper: bool = False, paper_status: str = "attached") -> dict:
    sources = [{"id": 1, "source_key": "s1", "name": "model.py", "content_b64": _b64(_SRC), "line_count": 3}]
    components = [
        _component(10, "dataset", "dataset", "component", left=150, top=20, name="Dataset"),
        _component(11, "head", "head", "component", left=245, top=200, name="Head"),
    ]
    snippets_by_component = {
        10: [{"id": 1, "component_id": 10, "source_id": 1, "start_line": 1, "end_line": end_line, "step_ordinal": 0}],
        11: [{"id": 2, "component_id": 11, "source_id": 1, "start_line": 2, "end_line": 2, "step_ordinal": 0}],
    }
    citations = []
    paper = None
    run_paper_status = "none"
    if with_paper:
        run_paper_status = paper_status
        components.append(
            _component(20, "hp-hidden-dim", "hp-hidden-dim", "hp_row",
                       hp_value="512 · repo 1", hp_cite="§3 / Table 1", name="hidden dim")
        )
        components.append(
            _component(21, "hp-optimizer", "hp-optimizer", "hp_row",
                       hp_value="AdamW", hp_cite="§4", name="optimizer")
        )
        # hp-hidden-dim is clickable (has a snippet); hp-optimizer is static (none).
        snippets_by_component[20] = [
            {"id": 3, "component_id": 20, "source_id": 1, "start_line": 2, "end_line": 2, "step_ordinal": 0}
        ]
        citations = [
            {"id": 1, "component_id": 20, "label": "hidden dim", "paper_value": "512",
             "paper_location": "§3 / Table 1", "code_value": "1", "confidence": "medium", "ordinal": 0},
        ]
        paper = {"parsed_title": "Tiny Paper"}
    return {
        "run": {"title": "TinyNet — GAM (abc1234)", "canvas_width": 680, "canvas_height": 1000, "paper_status": run_paper_status},
        "sources": sources,
        "components": components,
        "snippets_by_component": snippets_by_component,
        "source_key_by_id": {1: "s1"},
        "comp_by_id": {c["id"]: c for c in components},
        "edges": [
            {"id": 1, "path_d": "M 340 92 V 200", "from_component_id": 10, "to_component_id": 11, "ordinal": 0},
        ],
        "citations": citations,
        "paper": paper,
    }


def test_integrity_passes():
    assert check_integrity(_model()) == []


def test_integrity_flags_out_of_range():
    errors = check_integrity(_model(end_line=99))
    assert errors
    assert any("out of range" in e for e in errors)
    with pytest.raises(IntegrityError):
        render_page(_model(end_line=99))


def test_integrity_flags_missing_position():
    model = _model()
    model["components"][0]["left_px"] = None
    errors = check_integrity(model)
    assert any("no position" in e for e in errors)


def test_render_smoke():
    html = render_page(_model())
    assert "<!doctype html>" in html
    assert 'data-component="dataset"' in html
    assert 'data-component="head"' in html
    assert 'id="dataset"' in html
    assert html.count('marker-end="url(#arrow)"') == 1
    assert 'let activeComponent = "dataset"' in html
    assert "const sources =" in html
    assert "const components =" in html


def test_render_with_paper_section():
    html = render_page(_model(with_paper=True))
    assert 'class="hp"' in html
    assert "hidden dim" in html
    assert 'class="component hp-row" id="hp-hidden-dim" data-component="hp-hidden-dim"' in html
    assert "hp-row-static" in html  # the optimizer row (no snippet)
    assert "AdamW" in html


def test_fact_handler_and_css_present():
    html = render_page(_model())
    assert ".fact { cursor: pointer; }" in html
    assert ".fact.dim { color: #2563eb; }" in html  # the one permitted accent (spec §10.2)
    assert 'document.querySelectorAll(".fact")' in html


def test_valid_fact_targets_own_box():
    model = _model()
    # dataset owns one snippet (step 0); a dim tensor line pointing at its own box.
    model["components"][0]["shape_html"] = (
        '<span class="fact dim" data-component="dataset" data-step="0">[B,8,7]</span>'
    )
    assert check_integrity(model) == []
    html = render_page(model)
    assert '<span class="fact dim" data-component="dataset"' in html


def test_fact_cross_component_flagged():
    model = _model()
    # dataset box points a fact at 'head' — forbidden by §10.2 (must target own box).
    model["components"][0]["shape_html"] = (
        '<span class="fact" data-component="head" data-step="0">x</span>'
    )
    errors = check_integrity(model)
    assert any("must target its own box's component" in e for e in errors)
    with pytest.raises(IntegrityError):
        render_page(model)


def test_fact_step_out_of_range_flagged():
    model = _model()
    # dataset owns exactly one snippet (step 0); step 3 is out of range.
    model["components"][0]["shape_html"] = (
        '<span class="fact" data-component="dataset" data-step="3">x</span>'
    )
    errors = check_integrity(model)
    assert any("data-step 3 out of range" in e for e in errors)


def test_paper_mismatch_hides_hp_section():
    html = render_page(_model(with_paper=True, paper_status="mismatch"))
    assert 'class="hp"' not in html
    # the hp_row components have no snippets rendered as diagram boxes, so still no data-component leak
    assert "hidden dim" not in html


# ── A4 embedded paper panel ─────────────────────────────────────────────────

_PANEL_DOC = '<section id="S3"><p>Hidden dim is 512 in all runs.</p></section>'


def _model_with_panel(tmp_path, *, quote="Hidden dim is 512 in all runs.", paper_status="attached"):
    """A paper model whose clickable hp row carries a paper_quote → paper ref."""
    model = _model(with_paper=True, paper_status=paper_status)
    panel = tmp_path / "paper.panel.html"
    panel.write_text(_PANEL_DOC, encoding="utf-8")
    model["paper"] = {"parsed_title": "Tiny Paper", "panel_path": str(panel)}
    # hp-hidden-dim (component_id 20) is the clickable row; attach a quote to it.
    model["citations"] = [
        {"id": 1, "component_id": 20, "label": "hidden dim", "paper_value": "512",
         "paper_location": "§3 / Table 1", "code_value": "1", "confidence": "medium",
         "paper_quote": quote, "paper_anchor": "S3", "ordinal": 0},
    ]
    return model


def test_paper_pane_markup_always_present():
    # The pane chrome ships on every page (hidden when no ref), matching the reference.
    html = render_page(_model())
    assert 'id="paper-pane"' in html
    assert "function updatePaper()" in html
    assert "const paperRefs = {}" in html  # no paper → empty refs
    assert 'const paperDoc = ""' in html


def test_paper_pane_refs_and_doc_embedded(tmp_path):
    html = render_page(_model_with_panel(tmp_path))
    assert '"hp-hidden-dim":' in html  # ref keyed by the rendered component
    assert "Hidden dim is 512 in all runs." in html  # the cited sentence (quote)
    assert 'const paperDoc = ""' not in html  # doc actually embedded
    assert "Tiny Paper" in html  # bar prefix from the paper title


def test_paper_pane_skips_citation_without_quote(tmp_path):
    model = _model_with_panel(tmp_path, quote="")
    html = render_page(model)
    # No quote → no ref → pane stays inert and the doc is not embedded.
    assert "const paperRefs = {}" in html
    assert 'const paperDoc = ""' in html


def test_paper_pane_suppressed_on_mismatch(tmp_path):
    model = _model_with_panel(tmp_path, paper_status="mismatch")
    html = render_page(model)
    assert "const paperRefs = {}" in html
    assert 'const paperDoc = ""' in html


def test_paper_body_wraps_long_tokens():
    # The paper pane must wrap unbroken tokens (PDF/math text) instead of scrolling
    # horizontally forever ("doesn't change lines"): overflow-wrap/word-break on it.
    html = render_page(_model())
    assert "overflow-wrap: break-word" in html
    assert "word-break: break-word" in html


def test_paper_pane_autocloses_when_quote_absent():
    # Deliberate deviation from the reference: when no cited sentence matches, the
    # pane closes rather than showing an unhighlighted paper. The else branch of the
    # scroll decision must hide the pane.
    html = render_page(_model())
    idx = html.index("const scrollTarget = marked || target;")
    tail = html[idx:idx + 800]
    assert "} else {" in tail and "paperPane.hidden = true;" in tail
