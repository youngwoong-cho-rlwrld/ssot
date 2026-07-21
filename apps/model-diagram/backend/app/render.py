"""Assemble the self-contained click-to-code HTML page from normalized rows.

Reproduces the interaction grammar of gam_original_architecture.html: a left
diagram pane of absolutely-positioned component boxes wired with orthogonal SVG
paths, a right VS-Code-style source pane, click-to-highlight line ranges, and a
snippet stepper — all embedded, working from file://. Also implements the spec
§7.1 static integrity checks.
"""
from __future__ import annotations

import base64
import html
import json
from typing import Any


class IntegrityError(Exception):
    """A rendered page failed a spec §7.1 static integrity check."""


# ── model shaping ─────────────────────────────────────────────────────────


def _sources_json(model: dict) -> dict[str, dict]:
    return {
        s["source_key"]: {"name": s["name"], "base64": s["content_b64"]}
        for s in model["sources"]
    }


def _components_json(model: dict, show_hp: bool) -> dict[str, list[dict]]:
    """componentKey -> [{source, start, end}, ...] in step order.

    hp_row components only participate when the hyperparameter section is shown;
    otherwise they render nowhere, so they must not appear as a components entry.
    """
    out: dict[str, list[dict]] = {}
    source_key_by_id = model["source_key_by_id"]
    for comp in model["components"]:
        if comp["kind"] == "hp_row" and not show_hp:
            continue
        snippets = model["snippets_by_component"].get(comp["id"], [])
        if not snippets:
            continue
        out[comp["component_key"]] = [
            {
                "source": source_key_by_id[s["source_id"]],
                "start": s["start_line"],
                "end": s["end_line"],
            }
            for s in snippets
        ]
    return out


# ── integrity (spec §7.1) ─────────────────────────────────────────────────


def check_integrity(model: dict) -> list[str]:
    """Return a list of integrity problems (empty == passes §7.1)."""
    errors: list[str] = []
    sources = model["sources"]
    line_counts = {s["source_key"]: s["line_count"] for s in sources}
    source_keys = set(line_counts)

    show_hp = _show_hp(model)
    comp_json = _components_json(model, show_hp)

    for comp in model["components"]:
        key = comp["component_key"]
        if comp["kind"] == "component":
            # Diagram boxes must be clickable and positioned (spec §5).
            if key not in comp_json:
                errors.append(f"component {key!r} has no snippets")
            if comp.get("left_px") is None or comp.get("top_px") is None:
                errors.append(f"component {key!r} (kind=component) has no position")
        elif comp["kind"] == "hp_row" and show_hp:
            if not comp.get("hp_value"):
                errors.append(f"hp_row {key!r} has no hp_value")

    for key, snippets in comp_json.items():
        for snip in snippets:
            src = snip["source"]
            if src not in source_keys:
                errors.append(f"component {key!r} references unknown source {src!r}")
                continue
            start, end = snip["start"], snip["end"]
            n = line_counts[src]
            if not (1 <= start <= end <= n):
                errors.append(
                    f"component {key!r} snippet {start}-{end} out of range for {src!r} (1..{n})"
                )

    # Every data-component attribute must have a components entry and vice versa.
    rendered_keys = _rendered_component_keys(model, show_hp)
    missing = rendered_keys - set(comp_json)
    if missing:
        errors.append(f"data-component keys with no components entry: {sorted(missing)}")
    unused = set(comp_json) - rendered_keys
    if unused:
        errors.append(f"components entries with no data-component in HTML: {sorted(unused)}")

    return errors


def _rendered_component_keys(model: dict, show_hp: bool) -> set[str]:
    """Keys that will appear as a data-component attribute in the page.

    Diagram boxes and (when the hp section is shown) hyperparameter rows are
    clickable when they carry snippets; an hp_row without snippets renders as a
    static (non-button) row.
    """
    keys: set[str] = set()
    for comp in model["components"]:
        if comp["kind"] == "hp_row" and not show_hp:
            continue
        if model["snippets_by_component"].get(comp["id"]):
            keys.add(comp["component_key"])
    return keys


# ── HTML assembly ─────────────────────────────────────────────────────────


def render_page(model: dict) -> str:
    errors = check_integrity(model)
    if errors:
        raise IntegrityError("; ".join(errors))

    run = model["run"]
    title = run.get("title") or "Model diagram"
    canvas_w = run.get("canvas_width") or 680
    canvas_h = run.get("canvas_height") or 1450

    show_hp = _show_hp(model)
    sources = _sources_json(model)
    components = _components_json(model, show_hp)
    initial_key = _initial_component(model, components)

    position_css = _position_css(model)
    hp_css = _hp_css() if show_hp else ""
    buttons_html = _diagram_buttons(model)
    wires_html = _wires_svg(model, canvas_w, canvas_h)
    hp_html = _hp_section(model) if show_hp else ""

    sources_js = json.dumps(sources, ensure_ascii=False)
    components_js = json.dumps(components, ensure_ascii=False)

    return _PAGE_TEMPLATE.format(
        title=html.escape(title),
        canvas_w=canvas_w,
        canvas_h=canvas_h,
        position_css=position_css,
        hp_css=hp_css,
        wires=wires_html,
        buttons=buttons_html,
        hp_section=hp_html,
        sources_js=sources_js,
        components_js=components_js,
        initial_component=json.dumps(initial_key),
    )


def _initial_component(model: dict, components: dict[str, list]) -> str:
    for comp in model["components"]:
        if comp["kind"] == "component" and comp["component_key"] in components:
            return comp["component_key"]
    return next(iter(components), "")


def _position_css(model: dict) -> str:
    rules: list[str] = []
    for comp in model["components"]:
        if comp["kind"] != "component":
            continue
        rules.append(
            f"    #{comp['kebab_id']} {{ left: {comp['left_px']}px; top: {comp['top_px']}px; "
            f"width: {comp['width_px']}px; min-height: {comp['min_height_px']}px; }}"
        )
    return "\n".join(rules)


def _diagram_buttons(model: dict) -> str:
    parts: list[str] = []
    for comp in model["components"]:
        if comp["kind"] != "component":
            continue
        if not model["snippets_by_component"].get(comp["id"]):
            continue
        kebab = html.escape(comp["kebab_id"], quote=True)
        key = html.escape(comp["component_key"], quote=True)
        shape = comp.get("shape_html") or ""
        parts.append(
            f'        <button class="component" id="{kebab}" data-component="{key}" '
            f'data-testid="component-{kebab}">\n'
            f'          <span class="name">{comp["name_html"]}</span>\n'
            f'          <span class="shape">{shape}</span>\n'
            f'        </button>'
        )
    return "\n".join(parts)


def _wires_svg(model: dict, canvas_w: int, canvas_h: int) -> str:
    paths = "\n".join(
        f'          <path class="wire" marker-end="url(#arrow)" d="{html.escape(e["path_d"], quote=True)}" />'
        for e in model["edges"]
    )
    return (
        f'        <svg class="wires" viewBox="0 0 {canvas_w} {canvas_h}" aria-hidden="true">\n'
        f'          <defs>\n'
        f'            <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" '
        f'orient="auto" markerUnits="strokeWidth">\n'
        f'              <path d="M0,0 L7,3.5 L0,7 Z" fill="#111"/>\n'
        f'            </marker>\n'
        f'          </defs>\n'
        f'{paths}\n'
        f'        </svg>'
    )


def _show_hp(model: dict) -> bool:
    if (model["run"].get("paper_status") or "none") == "mismatch":
        return False
    return any(c["kind"] == "hp_row" for c in model["components"])


def _hp_section(model: dict) -> str:
    hp_rows = [c for c in model["components"] if c["kind"] == "hp_row"]
    if not hp_rows:
        return ""
    paper = model["paper"] or {}
    paper_title = html.escape(paper.get("parsed_title") or "paper")
    rows = [_hp_row(model, comp) for comp in hp_rows]
    return (
        f'      <section class="hp" aria-label="Paper hyperparameters">\n'
        f'        <h2 class="hp-title">All hyperparameters — {paper_title}</h2>\n'
        f'        <p class="hp-note">Click a row to open the matching code/config in the viewer.</p>\n'
        f'{chr(10).join(rows)}\n'
        f'      </section>'
    )


def _hp_row(model: dict, comp: dict) -> str:
    label = comp["name_html"]  # HTML from the agent
    value = html.escape(comp.get("hp_value") or "not stated")
    cite = html.escape(comp.get("hp_cite") or "not stated")
    kebab = html.escape(comp["kebab_id"], quote=True)

    if model["snippets_by_component"].get(comp["id"]):
        key = html.escape(comp["component_key"], quote=True)
        return (
            f'        <button class="component hp-row" id="{kebab}" data-component="{key}" '
            f'data-testid="hp-{kebab}">\n'
            f'          <span class="hp-name">{label}</span>\n'
            f'          <span class="hp-value">{value}</span>\n'
            f'          <span class="hp-cite">{cite}</span>\n'
            f'        </button>'
        )
    return (
        f'        <div class="hp-row hp-row-static" id="{kebab}" data-testid="hp-{kebab}">\n'
        f'          <span class="hp-name">{label}</span>\n'
        f'          <span class="hp-value">{value}</span>\n'
        f'          <span class="hp-cite">{cite}</span>\n'
        f'        </div>'
    )


def _hp_css() -> str:
    return """
    .hp { width: 640px; margin: 24px auto 40px; }
    .hp-title { margin: 0 0 4px; font-size: 15px; font-weight: 700; }
    .hp-note { margin: 0 0 12px; color: var(--muted); font-size: 11.5px; }
    .hp-row {
      position: static;
      display: grid;
      grid-template-columns: 128px 1fr 92px;
      gap: 10px;
      align-items: baseline;
      width: 100%;
      min-height: 0;
      margin: 0 0 6px;
      padding: 8px 10px;
    }
    .hp-row-static {
      border: 1px solid var(--line);
      background: var(--paper);
    }
    .hp-name { font-size: 12px; font-weight: 650; }
    .hp-value { color: var(--ink); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .hp-cite { color: var(--muted); font-size: 10.5px; text-align: right; }"""


def source_line_count(content_b64: str) -> int:
    text = base64.b64decode(content_b64).decode("utf-8", errors="replace").replace("\r\n", "\n")
    return len(text.splitlines())


_PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{
      color-scheme: light;
      --paper: #fff;
      --ink: #111;
      --muted: #666;
      --line: #b7b7b7;
      --panel: #f5f5f5;
      --editor: #171717;
      --editor-2: #202020;
      --editor-ink: #e8e8e8;
      --editor-muted: #888;
      --highlight: #3b3b3b;
    }}

    * {{ box-sizing: border-box; }}

    html, body {{
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--paper);
    }}

    main {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      width: 100%;
      height: 100%;
    }}

    .diagram-pane {{
      min-width: 0;
      overflow: auto;
      border-right: 1px solid var(--ink);
      background: var(--paper);
    }}

    .diagram {{
      position: relative;
      width: 680px;
      min-height: {canvas_h}px;
      margin: 0 auto;
    }}

    .wires {{
      position: absolute;
      inset: 0;
      width: 680px;
      height: {canvas_h}px;
      pointer-events: none;
    }}

    .wire {{
      fill: none;
      stroke: var(--ink);
      stroke-width: 1.25;
      vector-effect: non-scaling-stroke;
    }}

    .component {{
      position: absolute;
      z-index: 2;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-height: 62px;
      padding: 10px 12px;
      border: 1px solid var(--ink);
      border-radius: 0;
      color: var(--ink);
      background: var(--paper);
      text-align: left;
      font: inherit;
      cursor: pointer;
    }}

    .component:focus-visible,
    .component.is-active {{
      background: var(--panel);
      outline: 2px solid var(--ink);
      outline-offset: -2px;
    }}

    .component:focus-visible {{ outline-offset: 2px; }}

    .name {{
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
    }}

    .shape {{
      margin-top: 5px;
      color: var(--muted);
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }}

{position_css}
{hp_css}

    .code-pane {{
      min-width: 0;
      height: 100%;
      overflow: hidden;
      color: var(--editor-ink);
      background: var(--editor);
    }}

    .editor {{
      display: grid;
      grid-template-rows: 42px 1fr;
      height: 100%;
    }}

    .editor-bar {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      min-width: 0;
      border-bottom: 1px solid #333;
      background: var(--editor-2);
    }}

    .file-name {{
      min-width: 0;
      padding: 0 14px;
      overflow: hidden;
      color: var(--editor-ink);
      font: 12px/42px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}

    .stepper {{
      display: flex;
      align-items: center;
      height: 100%;
      border-left: 1px solid #333;
    }}

    .stepper[hidden] {{ display: none; }}

    .step-button {{
      width: 34px;
      height: 100%;
      padding: 0;
      border: 0;
      color: var(--editor-ink);
      background: transparent;
      font-size: 16px;
      cursor: pointer;
    }}

    .step-button:hover:not(:disabled),
    .step-button:focus-visible {{ background: #303030; }}
    .step-button:disabled {{ color: #555; cursor: default; }}

    .step-count {{
      min-width: 48px;
      color: #bbb;
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-align: center;
    }}

    .code-scroll {{
      overflow: auto;
      scrollbar-color: #555 var(--editor);
      scrollbar-width: thin;
    }}

    .code {{
      min-width: max-content;
      padding: 10px 0 28px;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      tab-size: 4;
    }}

    .code-line {{
      display: grid;
      grid-template-columns: 56px auto;
      min-height: 18px;
      padding-right: 24px;
      white-space: pre;
    }}

    .code-line.is-highlight {{ background: var(--highlight); }}

    .line-number {{
      padding-right: 14px;
      color: var(--editor-muted);
      text-align: right;
      user-select: none;
    }}

    .line-text {{ color: var(--editor-ink); }}

    .loading {{
      padding: 20px;
      color: var(--editor-muted);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }}

    @media (max-width: 900px) {{
      main {{ grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }}
      .diagram-pane {{ border-right: 0; border-bottom: 1px solid var(--ink); }}
    }}
  </style>
</head>
<body>
  <main>
    <section class="diagram-pane" aria-label="Architecture diagram">
      <div class="diagram">
{buttons}
{wires}
      </div>
{hp_section}
    </section>

    <section class="code-pane" aria-label="Code preview">
      <div class="editor">
        <div class="editor-bar">
          <div class="file-name" id="file-name" data-testid="file-name"></div>
          <div class="stepper" id="stepper" data-testid="stepper" hidden>
            <button class="step-button" id="previous" data-testid="previous-snippet" aria-label="Previous snippet">‹</button>
            <span class="step-count" id="step-count"></span>
            <button class="step-button" id="next" data-testid="next-snippet" aria-label="Next snippet">›</button>
          </div>
        </div>
        <div class="code-scroll" id="code-scroll">
          <div class="code" id="code" data-testid="code-preview"></div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const sources = {sources_js};

    const components = {components_js};

    const cache = new Map();
    const code = document.getElementById("code");
    const codeScroll = document.getElementById("code-scroll");
    const fileName = document.getElementById("file-name");
    const stepper = document.getElementById("stepper");
    const stepCount = document.getElementById("step-count");
    const previous = document.getElementById("previous");
    const next = document.getElementById("next");
    const componentButtons = [...document.querySelectorAll(".component")];

    let activeComponent = {initial_component};
    let activeStep = 0;
    let renderToken = 0;

    function escapeHtml(value) {{
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }}

    async function loadSource(key) {{
      if (!cache.has(key)) {{
        const bytes = Uint8Array.from(atob(sources[key].base64), (char) => char.charCodeAt(0));
        const sourceText = new TextDecoder().decode(bytes).replaceAll("\\r\\n", "\\n");
        cache.set(key, Promise.resolve(sourceText.split("\\n")));
      }}
      return cache.get(key);
    }}

    async function render() {{
      const token = ++renderToken;
      const snippets = components[activeComponent];
      const snippet = snippets[activeStep];
      const source = sources[snippet.source];

      componentButtons.forEach((button) => {{
        button.classList.toggle("is-active", button.dataset.component === activeComponent);
      }});

      fileName.textContent = source.name;
      stepper.hidden = snippets.length === 1;
      stepCount.textContent = `${{activeStep + 1}} / ${{snippets.length}}`;
      previous.disabled = activeStep === 0;
      next.disabled = activeStep === snippets.length - 1;
      code.innerHTML = '<div class="loading">Loading…</div>';

      try {{
        const lines = await loadSource(snippet.source);
        if (token !== renderToken) return;
        code.innerHTML = lines.map((line, index) => {{
          const lineNumber = index + 1;
          const highlighted = lineNumber >= snippet.start && lineNumber <= snippet.end;
          return `<div class="code-line${{highlighted ? " is-highlight" : ""}}" data-line="${{lineNumber}}">` +
            `<span class="line-number">${{lineNumber}}</span>` +
            `<span class="line-text">${{escapeHtml(line) || " "}}</span>` +
          `</div>`;
        }}).join("");

        const target = code.querySelector(`[data-line="${{snippet.start}}"]`);
        if (target) {{
          codeScroll.scrollTop = Math.max(0, target.offsetTop - codeScroll.clientHeight * 0.28);
          codeScroll.scrollLeft = 0;
        }}
      }} catch (error) {{
        if (token !== renderToken) return;
        code.innerHTML = `<div class="loading">${{escapeHtml(error.message)}}</div>`;
      }}
    }}

    function selectComponent(key) {{
      activeComponent = key;
      activeStep = 0;
      render();
    }}

    componentButtons.forEach((button) => {{
      button.addEventListener("click", () => selectComponent(button.dataset.component));
    }});

    previous.addEventListener("click", () => {{
      if (activeStep > 0) {{
        activeStep -= 1;
        render();
      }}
    }});

    next.addEventListener("click", () => {{
      if (activeStep < components[activeComponent].length - 1) {{
        activeStep += 1;
        render();
      }}
    }});

    render();
  </script>
</body>
</html>
"""
