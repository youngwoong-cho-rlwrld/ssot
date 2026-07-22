"""Validate + persist + render one ``finalize_diagram`` attempt (DB-backed).

This is the single implementation of the finalize integrity flow, shared by every
runtime so there is exactly one source of truth:

- the SDK and codex runtimes call it from the detached worker (:mod:`app.run_worker`);
- the Claude-CLI runtime calls it from the out-of-process MCP server
  (:mod:`app.mcp_server`), which writes straight to the same sqlite DB.

It returns ``(True, None)`` when the rows are persisted and the HTML cached, or
``(False, detail)`` so the agent can correct and call ``finalize_diagram`` again.
Nothing here touches run status — the caller decides terminality (so the CLI
retry loop and the SDK loop share this exact validation without either owning the
other's lifecycle).
"""
from __future__ import annotations

import base64
from typing import Optional

from . import db, geometry, settings
from .fsaccess import FsAccess, FsError, PathEscape
from .render import IntegrityError, render_page
from .schemas import FinalizePayload


async def try_finalize(
    run_id: int,
    raw: dict,
    fs: FsAccess,
    *,
    reuse_sources: Optional[dict[str, str]] = None,
) -> tuple[bool, Optional[str]]:
    """Validate → fetch source bytes → persist → render one finalize attempt.

    The agent NAMES its source files; the backend fetches each one's exact bytes
    HERE via the run's scoped read-only access (``fs``) and embeds them, so no
    base64 crosses the tool boundary (that single giant tool call was blowing real
    runs past the timeout). Fetching at finalize time also strengthens integrity:
    every snippet range is now checked against bytes provably read from the actual
    root at finalize time, not against agent-supplied content.

    ``reuse_sources`` (name -> content_b64) lets a chat revision reuse the anchor
    run's already-embedded files instead of re-reading them; any name not present
    is fetched fresh. A named file that cannot be read is a RETRYABLE error so the
    agent can correct the path and call finalize again.
    """
    try:
        payload = FinalizePayload.model_validate(raw)
    except Exception as exc:
        return False, f"payload does not match the schema: {exc}"

    # Snippets must reference declared sources before we touch the DB.
    source_keys = {s.source_key for s in payload.sources}
    for comp in payload.components:
        for snip in comp.snippets:
            if snip.source_key not in source_keys:
                return False, f"component {comp.component_key!r} snippet references unknown source {snip.source_key!r}"

    # Paper coverage: when a paper is attached AND was NOT reported as a mismatch,
    # the finalize MUST carry paper_citations with verbatim quotes — otherwise the
    # §6 hyperparameter section and the paper panel have nothing to show (observed:
    # codex runs finishing with zero citations). Retryable, same budget as other
    # integrity errors; report_paper_mismatch is the escape hatch.
    err = _paper_coverage_error(run_id, payload)
    if err:
        return False, err

    reuse = reuse_sources or {}
    source_b64: dict[str, str] = {}
    for src in payload.sources:
        cached = reuse.get(src.name)
        if cached is not None:
            source_b64[src.source_key] = cached
            continue
        try:
            text = await fs.read_file(src.name)
        except PathEscape as exc:
            return False, f"source {src.name!r} is outside the model root: {exc}"
        except FsError as exc:
            return False, (
                f"source file {src.name!r} could not be read from the model root: {exc}. "
                "Name only files that exist under the root, then call finalize_diagram again."
            )
        source_b64[src.source_key] = base64.b64encode(text.encode("utf-8")).decode("ascii")

    db.persist_finalize(run_id, payload, source_b64)
    model = db.load_diagram_model(run_id)
    try:
        html = render_page(model)
    except IntegrityError as exc:
        return False, str(exc)
    db.set_rendered_html(run_id, html)

    # §7.2 / A6 geometry pass: measure the real render and correct overlaps/wires.
    # Best-effort — a failure here (no browser, protocol error) never fails the run.
    await _apply_geometry_pass(run_id, html)
    return True, None


def _paper_coverage_error(run_id: int, payload: FinalizePayload) -> Optional[str]:
    """Retryable message when a matched paper carries no cited quotes, else None.

    A run has a matched paper when a paper row exists and the run's paper_status is
    not ``mismatch`` (the agent can clear the requirement with report_paper_mismatch).
    """
    if not db.get_paper(run_id):
        return None
    run = db.get_run(run_id) or {}
    if run.get("paper_status") == "mismatch":
        return None
    has_quote = any(
        (cite.paper_quote or "").strip()
        for comp in payload.components
        for cite in comp.paper_citations
    )
    if has_quote:
        return None
    return (
        "a paper is attached and matched: supply paper_citations with verbatim paper_quote "
        "sentences for every value the paper states (spec §6) — the hyperparameter section and the "
        "paper panel need them — or call report_paper_mismatch if the paper does not describe this model."
    )


def _geom_log(run_id: int, line: str) -> None:
    try:
        db.add_output_line(run_id, line)
    except Exception:
        pass


async def _apply_geometry_pass(run_id: int, html: str) -> None:
    """Measure the finalized page in headless Chrome and fix overlaps + wires.

    Renders the provisional page, measures every box's real rect, resolves vertical
    overlaps (columns preserved), sets each box's min-height to its measured height
    (so wrapped text is enclosed), grows the canvas, regenerates wires from the
    measured geometry, and re-renders. Degrades gracefully: no Chrome binary or any
    measurement/persist error leaves the un-measured page in place.
    """
    if not settings.geometry_pass_enabled():
        return
    try:
        chrome = geometry.find_chrome()
        if not chrome:
            _geom_log(run_id, "geometry pass skipped: no Chrome/Chromium binary available")
            return
        measurement = await geometry.measure_page(html, chrome)
        if not measurement:
            _geom_log(run_id, "geometry pass skipped: headless measurement unavailable")
            return
        model = db.load_diagram_model(run_id)
        boxes = geometry.boxes_from_measurement(measurement)
        plan = geometry.plan_geometry(model, boxes)
        if plan is None or not plan.changed:
            _geom_log(run_id, "geometry pass: layout already clean, no changes")
            return
        db.apply_geometry(run_id, plan.box_geom, plan.canvas_height, plan.edge_paths)
        remeasured = db.load_diagram_model(run_id)
        try:
            new_html = render_page(remeasured)
        except IntegrityError:
            return  # keep the provisional page if the corrected layout fails a check
        db.set_rendered_html(run_id, new_html)
        _geom_log(
            run_id,
            f"geometry pass: resolved {plan.overlaps_before} → {plan.overlaps_after} box overlaps, "
            f"canvas {plan.canvas_height}px",
        )
    except Exception as exc:  # never let the measure pass break a finalized run
        _geom_log(run_id, f"geometry pass skipped after error: {exc}")
