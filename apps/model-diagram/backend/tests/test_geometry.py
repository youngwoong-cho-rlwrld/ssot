"""The headless-Chrome geometry pass: overlap math + wire routing (pure), plus a
live measurement smoke that is skipped when no Chrome binary is present."""
import pytest

from app import geometry
from app.geometry import Rect


def _boxes(spec: dict[str, tuple[int, int, int, int]]) -> dict[str, Rect]:
    return {k: Rect(left=l, top=t, width=w, height=h) for k, (l, t, w, h) in spec.items()}


# ── overlap detection + resolution ──────────────────────────────────────────


def test_detect_overlaps_same_column():
    boxes = _boxes({"a": (245, 20, 190, 90), "b": (245, 80, 190, 60)})  # b.top < a.bottom
    assert geometry.detect_overlaps(boxes) == [("a", "b")]


def test_detect_overlaps_ignores_side_by_side():
    # Same y-band but disjoint x — different columns, no overlap.
    boxes = _boxes({"a": (20, 20, 190, 90), "b": (470, 20, 190, 90)})
    assert geometry.detect_overlaps(boxes) == []


def test_resolve_overlaps_pushes_down_and_preserves_column():
    boxes = _boxes({"a": (245, 20, 190, 90), "b": (245, 80, 190, 60)})
    out = geometry.resolve_overlaps(boxes, gap=28)
    assert out["a"].top == 20  # top box unmoved
    assert out["b"].top == 20 + 90 + 28  # pushed below a + gap
    assert out["b"].left == 245 and out["b"].width == 190  # column + size preserved
    assert geometry.detect_overlaps(out) == []


def test_resolve_overlaps_no_change_when_clear():
    boxes = _boxes({"a": (245, 20, 190, 60), "b": (245, 200, 190, 60)})
    out = geometry.resolve_overlaps(boxes)
    assert out["b"].top == 200  # already clear, not moved


def test_resolve_overlaps_full_width_row_pushed_below_all():
    # A wide row overlaps both columns above it and must land below the lower one.
    boxes = _boxes({
        "left": (20, 20, 190, 120),
        "right": (470, 20, 190, 60),
        "wide": (130, 60, 420, 80),
    })
    out = geometry.resolve_overlaps(boxes, gap=25)
    assert out["wide"].top == 20 + 120 + 25  # below the taller 'left' column box
    assert geometry.detect_overlaps(out) == []


def test_canvas_height_for():
    boxes = _boxes({"a": (245, 20, 190, 90), "b": (245, 200, 190, 60)})
    assert geometry.canvas_height_for(boxes, margin=25) == 200 + 60 + 25


# ── wire routing ────────────────────────────────────────────────────────────


def test_route_wire_straight_vertical_same_column():
    src = Rect(245, 20, 190, 80)   # cx = 340, bottom = 100
    dst = Rect(245, 200, 190, 60)  # cx = 340, top = 200
    assert geometry.route_wire(src, dst) == "M 340 100 V 200"


def test_route_wire_stairstep_when_columns_differ():
    src = Rect(20, 20, 190, 80)    # cx = 115, bottom = 100
    dst = Rect(470, 300, 190, 60)  # cx = 565, top = 300
    # down to the mid-gap, across, into the target top
    assert geometry.route_wire(src, dst) == "M 115 100 V 200 H 565 V 300"


def test_route_wire_side_entry_right():
    src = Rect(20, 100, 190, 80)    # right = 210, mid-y = 140
    dst = Rect(470, 100, 190, 80)   # left = 470
    assert geometry.route_wire(src, dst) == "M 210 140 H 470"


def test_route_wire_endpoints_touch_boxes():
    # Every generated path's first point sits on the source edge; last on the dst edge.
    src = Rect(245, 20, 190, 80)
    dst = Rect(245, 200, 190, 60)
    d = geometry.route_wire(src, dst)
    assert d.startswith("M 340 100")  # src bottom-centre
    assert d.endswith("V 200")        # into dst top


# ── plan_geometry (model + measured rects → persisted-shape updates) ─────────


def _model_with(components, edges, canvas_height=1000):
    return {
        "run": {"canvas_height": canvas_height},
        "components": components,
        "edges": edges,
    }


def _comp(cid, key, kebab, top, mh, kind="component"):
    return {"id": cid, "component_key": key, "kebab_id": kebab, "kind": kind,
            "top_px": top, "min_height_px": mh}


def test_plan_geometry_resolves_and_regenerates():
    comps = [_comp(1, "dataset", "dataset", 20, 62), _comp(2, "head", "head", 80, 62)]
    edges = [{"id": 1, "ordinal": 0, "from_component_id": 1, "to_component_id": 2, "path_d": "OLD"}]
    model = _model_with(comps, edges)
    # Measured: dataset renders 90px tall (wrapped), overlapping head at top=80.
    boxes = _boxes({"dataset": (245, 20, 190, 90), "head": (245, 80, 190, 62)})
    plan = geometry.plan_geometry(model, boxes)
    assert plan is not None and plan.changed
    assert plan.overlaps_before == 1 and plan.overlaps_after == 0
    # head pushed below dataset; min-heights set to measured heights
    assert plan.box_geom["dataset"] == (20, 90)
    assert plan.box_geom["head"][0] == 20 + 90 + geometry.GAP_PX
    # wire regenerated from the resolved rects (no longer "OLD")
    assert plan.edge_paths[0] != "OLD" and plan.edge_paths[0].startswith("M ")
    assert plan.canvas_height == geometry.canvas_height_for(
        {"dataset": Rect(245, 20, 190, 90), "head": Rect(245, plan.box_geom["head"][0], 190, 62)}
    )


def test_plan_geometry_no_change_when_measured_matches():
    comps = [_comp(1, "a", "a", 20, 90), _comp(2, "b", "b", 200, 62)]
    edges = []
    model = _model_with(comps, edges, canvas_height=geometry.canvas_height_for(
        {"a": Rect(245, 20, 190, 90), "b": Rect(245, 200, 190, 62)}))
    boxes = _boxes({"a": (245, 20, 190, 90), "b": (245, 200, 190, 62)})
    plan = geometry.plan_geometry(model, boxes)
    assert plan is not None and not plan.changed


def test_plan_geometry_none_without_boxes():
    model = _model_with([_comp(1, "a", "a", 20, 62)], [])
    assert geometry.plan_geometry(model, {}) is None


# ── live headless measurement (skipped without a browser) ───────────────────


def test_measure_page_live_or_skip():
    chrome = geometry.find_chrome()
    if not chrome:
        pytest.skip("no Chrome/Chromium binary on this host")
    import asyncio

    html = """<!doctype html><html><head><meta charset=utf-8><style>
    .diagram { position: relative; width: 680px; }
    .component { position: absolute; border: 1px solid #111; padding: 10px; width: 190px; box-sizing: border-box; }
    #a { left: 245px; top: 20px; min-height: 62px; }
    </style></head><body><div class="diagram">
    <button class="component" id="a"><span class="shape">line one that is quite long and wraps across multiple lines within the narrow box width here</span></button>
    </div></body></html>"""
    m = asyncio.run(geometry.measure_page(html, chrome))
    assert m is not None, "headless measurement failed"
    boxes = geometry.boxes_from_measurement(m)
    assert "a" in boxes
    assert boxes["a"].height > 62  # wrapped text makes the real box taller than min-height
