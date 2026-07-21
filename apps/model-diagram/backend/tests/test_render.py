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


def test_paper_mismatch_hides_hp_section():
    html = render_page(_model(with_paper=True, paper_status="mismatch"))
    assert 'class="hp"' not in html
    # the hp_row components have no snippets rendered as diagram boxes, so still no data-component leak
    assert "hidden dim" not in html
