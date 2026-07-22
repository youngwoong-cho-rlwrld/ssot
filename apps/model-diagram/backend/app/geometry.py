"""Headless-Chrome geometry pass for the generated architecture page (spec §7.2 / A6).

The agent lays boxes out blind — it has no way to measure how tall a box renders
once its fact text wraps in the real font, so boxes overlap and text spills into
neighbours. This module renders the finalized page in headless Chrome, measures
every box's ACTUAL rect, then:

  * resolves vertical overlaps by pushing lower boxes down (columns preserved),
  * sets each box's min-height to its measured height (so borders enclose text),
  * grows the canvas, and
  * regenerates every wire from the measured geometry (orthogonal, routed through
    the cleared inter-row gaps — never through a box interior).

Everything degrades gracefully: with no Chrome binary (e.g. a headless Linux
devserver with no browser) the measure pass is skipped and the un-measured page is
kept — a run must never fail for lack of a browser.

Chrome is driven over the raw DevTools Protocol via a websocket (no node / no
playwright dependency); only a Chrome/Chromium binary is required.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from typing import Optional

import websockets

# ── box geometry model ──────────────────────────────────────────────────────


@dataclass
class Rect:
    left: int
    top: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height


# Minimum vertical gap between two boxes that share horizontal extent.
GAP_PX = 28
# Clearance below the lowest box, matching the height-triad convention (A1/§10.1).
BOTTOM_MARGIN_PX = 25


def _x_overlaps(a: Rect, b: Rect) -> bool:
    """True if two boxes share any horizontal extent (same visual column/lane)."""
    return a.left < b.right and b.left < a.right


def detect_overlaps(boxes: dict[str, Rect]) -> list[tuple[str, str]]:
    """Return id pairs whose rects intersect in BOTH axes (the §7.2 overlap gate)."""
    ids = list(boxes)
    hits: list[tuple[str, str]] = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = boxes[ids[i]], boxes[ids[j]]
            if _x_overlaps(a, b) and a.top < b.bottom and b.top < a.bottom:
                hits.append((ids[i], ids[j]))
    return hits


def resolve_overlaps(boxes: dict[str, Rect], gap: int = GAP_PX) -> dict[str, Rect]:
    """Push boxes straight down until no two column-mates overlap (columns kept).

    Processes boxes top-to-bottom; each box is placed at or below the bottom (plus
    ``gap``) of every already-placed box it shares a column/lane with, but never
    ABOVE its original top. Only ``top`` changes — ``left``/``width``/``height`` are
    the measured values — so column structure and box sizes are preserved.
    """
    order = sorted(boxes, key=lambda k: (boxes[k].top, boxes[k].left))
    placed: list[Rect] = []
    out: dict[str, Rect] = {}
    for key in order:
        b = boxes[key]
        new_top = b.top
        for p in placed:
            if _x_overlaps(b, p):
                new_top = max(new_top, p.bottom + gap)
        moved = Rect(left=b.left, top=new_top, width=b.width, height=b.height)
        out[key] = moved
        placed.append(moved)
    return out


def canvas_height_for(boxes: dict[str, Rect], margin: int = BOTTOM_MARGIN_PX) -> int:
    """Tallest box bottom plus bottom clearance (feeds the A1 height triad)."""
    if not boxes:
        return 200
    return max(b.bottom for b in boxes.values()) + margin


def route_wire(src: Rect, dst: Rect) -> str:
    """Orthogonal ``path_d`` from src to dst using only M/V/H, from measured rects.

    Routing (A6), chosen to stay out of box interiors:
      * dst below src: leave src's bottom-centre, step across at the mid-gap y
        (the cleared lane between the two rows), enter dst's top-centre. Collapses
        to a straight vertical when the two share a centre x.
      * dst beside src (its top is within src's vertical span): leave the facing
        side edge at src's mid-y and run straight into dst's near side edge.
      * dst above src (feedback): leave src's side, run out to a corridor left of
        both, climb, and enter dst's near side edge.
    """
    scx, dcx = src.left + src.width // 2, dst.left + dst.width // 2

    if dst.top >= src.bottom:  # forward / downward
        mid = (src.bottom + dst.top) // 2
        if scx == dcx:
            return f"M {scx} {src.bottom} V {dst.top}"
        return f"M {scx} {src.bottom} V {mid} H {dcx} V {dst.top}"

    if dst.top >= src.top or dst.bottom > src.top:  # roughly side-by-side
        if dst.left >= src.right:  # dst to the right
            y = src.top + src.height // 2
            return f"M {src.right} {y} H {dst.left}"
        if dst.right <= src.left:  # dst to the left
            y = src.top + src.height // 2
            return f"M {src.left} {y} H {dst.right}"

    # dst above src (feedback): exit right, corridor to the right of both, climb in.
    corridor = max(src.right, dst.right) + 12
    sy = src.top + src.height // 2
    dy = dst.top + dst.height // 2
    return f"M {src.right} {sy} H {corridor} V {dy} H {dst.right}"


# ── headless-Chrome measurement (raw CDP over a websocket) ───────────────────

_CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
)
_WS_LINE_RE = re.compile(r"DevTools listening on (ws://\S+)")

# Measures every diagram box's rendered rect (offset* is relative to .diagram, the
# positioned ancestor, so it shares the box's CSS px coordinate system) plus the
# paper pane's horizontal overflow (a wrapping-regression probe).
_MEASURE_JS = r"""
(function () {
  var diagram = document.querySelector('.diagram');
  var boxes = {};
  document.querySelectorAll('.diagram .component').forEach(function (el) {
    boxes[el.id] = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
  });
  var pb = document.querySelector('.paper-body');
  var paper = pb ? { scrollWidth: pb.scrollWidth, clientWidth: pb.clientWidth } : null;
  return JSON.stringify({ boxes: boxes, diagramHeight: diagram ? diagram.scrollHeight : 0, paper: paper });
})()
"""


def find_chrome() -> Optional[str]:
    """Locate a Chrome/Chromium binary, or None (→ skip the measure pass)."""
    env = os.environ.get("MODEL_DIAGRAM_CHROME")
    if env and os.path.exists(env):
        return env
    for path in _CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


async def measure_page(html: str, chrome_path: str, *, timeout: float = 25.0) -> Optional[dict]:
    """Render ``html`` headless and return ``{boxes, diagramHeight, paper}`` or None.

    Returns None on any launch/protocol/timeout failure — the caller keeps the
    un-measured page rather than failing the run.
    """
    return await _run_headless(html, chrome_path, _MEASURE_JS, timeout=timeout)


async def _run_headless(html: str, chrome_path: str, expr: str, *, timeout: float) -> Optional[dict]:
    """Launch headless Chrome on ``html`` and return ``JSON.parse`` of ``expr``."""
    tmp = tempfile.mkdtemp(prefix="md-measure-")
    html_path = os.path.join(tmp, "page.html")
    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            chrome_path,
            "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
            "--disable-extensions", "--hide-scrollbars", "--force-device-scale-factor=1",
            f"--user-data-dir={os.path.join(tmp, 'profile')}",
            "--remote-debugging-port=0", "about:blank",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        ws_url = await asyncio.wait_for(_read_ws_url(proc), timeout)
        if not ws_url:
            return None
        return await asyncio.wait_for(_drive_cdp(ws_url, html_path, expr), timeout)
    except (asyncio.TimeoutError, OSError, websockets.WebSocketException, json.JSONDecodeError, KeyError):
        return None
    finally:
        if proc is not None and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


async def _read_ws_url(proc) -> Optional[str]:
    assert proc.stderr is not None
    while True:
        line = await proc.stderr.readline()
        if not line:
            return None
        match = _WS_LINE_RE.search(line.decode("utf-8", errors="replace"))
        if match:
            return match.group(1)


async def _drive_cdp(browser_ws: str, html_path: str, expr: str) -> Optional[dict]:
    async with websockets.connect(browser_ws, max_size=None) as ws:
        counter = [0]

        async def send(method: str, params: Optional[dict] = None, session: Optional[str] = None) -> dict:
            counter[0] += 1
            call_id = counter[0]
            msg: dict = {"id": call_id, "method": method, "params": params or {}}
            if session:
                msg["sessionId"] = session
            await ws.send(json.dumps(msg))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == call_id:
                    return resp

        created = await send("Target.createTarget", {"url": "file://" + html_path})
        target_id = created["result"]["targetId"]
        attached = await send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        session = attached["result"]["sessionId"]
        await send("Runtime.enable", session=session)

        for _ in range(120):  # ≤6s waiting for the document to finish laying out
            ready = await send(
                "Runtime.evaluate",
                {"expression": "document.readyState", "returnByValue": True},
                session=session,
            )
            if ready.get("result", {}).get("result", {}).get("value") == "complete":
                break
            await asyncio.sleep(0.05)

        evaluated = await send(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True},
            session=session,
        )
        value = evaluated.get("result", {}).get("result", {}).get("value")
        await send("Target.closeTarget", {"targetId": target_id})
        return json.loads(value) if value else None


async def evaluate_page(html: str, chrome_path: str, expr: str, *, timeout: float = 25.0) -> Optional[dict]:
    """Render ``html`` headless and return ``JSON.parse`` of ``expr``'s result, or None.

    ``expr`` must evaluate to a JSON string. Used by tests to drive real interaction
    (e.g. click a component, then read the paper pane's visibility).
    """
    return await _run_headless(html, chrome_path, expr, timeout=timeout)


def boxes_from_measurement(measurement: dict) -> dict[str, Rect]:
    """Turn the measure_page ``boxes`` blob into rounded Rects."""
    out: dict[str, Rect] = {}
    for key, r in (measurement.get("boxes") or {}).items():
        out[key] = Rect(
            left=round(r["left"]), top=round(r["top"]),
            width=round(r["width"]), height=round(r["height"]),
        )
    return out


@dataclass
class GeometryPlan:
    changed: bool
    box_geom: dict[str, tuple[int, int]]  # component_key -> (top_px, min_height_px)
    canvas_height: int
    edge_paths: dict[int, str]  # edge ordinal -> path_d
    overlaps_before: int
    overlaps_after: int


def plan_geometry(model: dict, boxes: dict[str, Rect]) -> Optional[GeometryPlan]:
    """Compute the corrected layout from measured rects (pure; no I/O).

    ``boxes`` is keyed by kebab_id (the button's DOM id). Resolves overlaps, sets
    each box's min-height to its measured height (so text is enclosed), grows the
    canvas, and regenerates every wire from the resolved rects. Returns None when
    no diagram box was measured; ``changed`` is False when the measured layout
    already matches what is persisted (no overlaps, no height growth).
    """
    comp_by_kebab = {c["kebab_id"]: c for c in model["components"] if c["kind"] == "component"}
    measured = {k: r for k, r in boxes.items() if k in comp_by_kebab}
    if not measured:
        return None

    overlaps_before = len(detect_overlaps(measured))
    resolved = resolve_overlaps(measured)
    overlaps_after = len(detect_overlaps(resolved))

    box_geom: dict[str, tuple[int, int]] = {}
    changed = overlaps_before > 0
    for kebab, rect in resolved.items():
        comp = comp_by_kebab[kebab]
        box_geom[comp["component_key"]] = (rect.top, rect.height)
        if rect.top != comp.get("top_px") or rect.height != (comp.get("min_height_px") or 0):
            changed = True

    canvas_height = canvas_height_for(resolved)
    if canvas_height != (model["run"].get("canvas_height") or 0):
        changed = True

    # Regenerate wires from the resolved geometry (kebab id lookups via component id).
    key_by_id = {c["id"]: c["kebab_id"] for c in model["components"]}
    edge_paths: dict[int, str] = {}
    for edge in model["edges"]:
        src_kebab = key_by_id.get(edge.get("from_component_id"))
        dst_kebab = key_by_id.get(edge.get("to_component_id"))
        src, dst = resolved.get(src_kebab), resolved.get(dst_kebab)
        if src and dst:
            path = route_wire(src, dst)
            edge_paths[edge["ordinal"]] = path
            if path != edge.get("path_d"):
                changed = True

    return GeometryPlan(
        changed=changed, box_geom=box_geom, canvas_height=canvas_height,
        edge_paths=edge_paths, overlaps_before=overlaps_before, overlaps_after=overlaps_after,
    )
