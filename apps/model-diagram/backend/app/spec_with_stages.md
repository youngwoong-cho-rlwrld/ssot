# Click-to-code architecture page — reproduction spec (with Stages)

Produces an interactive single-file HTML architecture page for ANY codebase, in exactly the style of
`gam_architecture.html` / `gam_original_architecture.html`: left pane = minimal grayscale component
diagram with orthogonal arrowed wires, right pane = VS-Code-style source viewer; clicking a component
(or a hyperparameter row) highlights the exact defining lines of the real source, with a stepper when
a component maps to several snippets. Everything is embedded — the file works offline from `file://`.

You (the analysis agent) do NOT write the HTML. You analyze the model at the given root using your
scoped read-only tools and then call `finalize_diagram` with the structured fields below. The backend
assembles the single-file page from your structured result and runs the §7.1 integrity checks. Follow
every content rule; a run is rejected if the §7.1 checks fail.

---

## 1. Inputs

1. A codebase at the given cluster + path, pinned to ONE commit (record the short hash; it goes in the
   `title` and captions). Pin the commit yourself during analysis (e.g. read `.git/HEAD` /
   `git`-style metadata through your read tools) and report it in `finalize_diagram.commit_hash`.
2. OPTIONALLY a source paper. The paper is **pre-fetched, validated, and injected by the backend** into
   your initial message — as a native PDF document block or as extracted HTML text. You have **no fetch,
   web, or search tools**: you cannot reach the internet, cannot follow references out of the paper, and
   cannot open any URL. Use ONLY the injected paper. If no paper block is present, no paper was attached.

If the injected paper does not actually describe the model at this root, call `report_paper_mismatch`
with a reason and then finalize the diagram from code ONLY (omit paper-cited numbers; mark affected
labels lower-confidence). The run still completes.

## 2. Content rules (what goes in, and how it must be derived)

- **Components = what the code actually does at that commit.** Walk the real pipeline
  (data → encoders → core model → outputs → losses → serving/eval → optimizer). Do NOT copy the
  component list from a previous page for a different codebase; if a stage does not exist in this
  code, it does not get a box.
- **Every claim label is code-verified.** Tensor dims, token counts, defaults, loss types: read them
  from the source (docstrings, config defaults, constructor args), never from memory or a paper alone.
  Verify every line range by reading those exact lines before you finalize.
- **Contradictions are annotated, not resolved.** Where paper and repo (or config and code default)
  disagree, the label shows both: `paper: T5 · repo default: CLIP-L/14`.
- **Line ranges are 1-indexed inclusive** and must point at the DEFINING code (class/function/config
  block), not incidental usage.
- **Sources are embedded byte-for-byte** — put the exact file bytes (base64) in `sources[].content_b64`
  and the repo-relative path in `sources[].name`.

## 3. Structured result (finalize_diagram fields — the tool schema is authoritative)

- `canvas`: `{width, height}` — width 680 by convention, height tall enough for all boxes and wires.
- `sources[]`: `{source_key, name, content_b64, line_count}` — every file any snippet points at, base64
  of the exact bytes read at the pinned commit, plus its line count.
- `components[]`: `{component_key, kebab_id, kind, name_html, shape_html, position, hp_value, hp_cite,
  snippets[], paper_citations[]}`.
  - `kind` is `component` (a diagram box — must have a `position` `{left, top, width, min_height}` and at
    least one snippet) or `hp_row` (a hyperparameter row — must have `hp_value`; `position` is null).
  - `snippets[]` entries are `{source_key, start, end}` (1-indexed inclusive) in step order; more than one
    enables the stepper.
  - `paper_citations[]` (per component) `{label, paper_value, paper_location, code_value, confidence}` —
    ONLY when a paper is attached and matches; provenance for the §6 hyperparameter section.
- `edges[]`: `{path_d, from_component_key, to_component_key}` — orthogonal wires (see §5).

Integrity requirements (enforced by the backend, §7.1): every diagram box has a `position` and at least
one snippet; every `hp_row` has an `hp_value`; every snippet's `source_key` exists in `sources`; every
`start`/`end` is within the decoded file's line count.

## 4. Fixed skeleton

The backend owns the verbatim head/CSS/JS skeleton. You only supply the structured data. The only
things that vary per project are the title (page name + short commit), the generated component
positions (§5), and the canvas height (`canvas_height`) — set it tall enough for all boxes and wires.

## 5. Diagram: buttons, positions, wires

**Canvas**: fixed width 680; height = whatever the layout needs. Set `canvas_width=680` and
`canvas_height` to the real canvas height.

**Boxes** — one component per pipeline stage, grayscale only:
- `name_html` = short name (+ ` · ` variant note where useful).
- `shape_html` = 1–3 short monospace fact lines; tensor dims in `[B,H,V,…]` bracket notation, `·` as a
  separator, `<br>` for line breaks.
- Position rule per box: `left_px`, `top_px`, `width_px` (190 for column boxes, 380/420 for full-width
  rows), `min_height_px`. Lay out top→bottom in pipeline order; put side branches (text encoder,
  optimizer, losses) in left/right columns.

**Wires** — orthogonal (`M/V/H` only), stair-step, with arrowheads (the backend adds the marker). Set
`path_d` using only `M`/`V`/`H` commands. Start at the source box's bottom/side edge and end at the
target's top/side edge. Route around intervening boxes through free corridors (e.g. `x=10` left of the
box column); a wire may never pass through a box interior. Because real rendered boxes are taller than
`min_height_px` (text wraps), leave generous vertical gaps between rows.

## 6. Hyperparameter section (when a paper is given)

When a matching paper is attached, add one `hp_row` component per hyperparameter (with `hp_value` =
the paper value, and the repo value where different, and `hp_cite` = the citation like `§4 / Table 2`),
giving it `snippets` pointing at the verified config/code so the row is clickable. Attach the matching
`paper_citations[]` provenance to that component. The backend renders the §6 hyperparameter section from
the `hp_row` components. Cover EVERY hyperparameter the paper states (optimizer, lr + multipliers,
schedule, batch, steps, action/proprio dims, chunk, views/resolution, context length, every loss weight,
augmentation, EMA, inference protocol, data mixture, model sizes) — one `hp_row` each, and `not stated`
said outright where the paper omits it.

## 7. Verification

### 7.1 Data integrity (static) — enforced by the backend

The backend re-checks, before marking the run done: every snippet's `source_key` resolves; every
`start`/`end` is within the decoded file's line count; every diagram box has a components entry and vice
versa; the wire count matches the arrowhead count. If any check fails the run ends `agent_failure` with
the detail — so verify your line ranges by reading the exact lines before finalizing.

### 7.2 / 7.3 Geometry & visual gates — documented fast-follow

Headless-Chrome overlap/wire-through-box geometry checks and the screenshot eyeball pass are a
documented fast-follow; they are NOT run in v1. Lay out carefully so boxes don't overlap and wires
don't cross box interiors.

## 8. Stages — report_stage transitions

Call `report_stage` at each transition so the UI can show live progress. Use exactly these stage names,
in order (skip the two paper stages when no paper is attached):

`inspecting_root → pinning_commit → mapping_pipeline → locating_sources → verifying_lines →
(reading_paper) → (cross_checking_paper) → laying_out → finalizing`

- `inspecting_root` — confirm the root is a real model codebase; if not, call `report_problem` (this is
  the `not_a_model_root` hard error) and stop.
- `pinning_commit` — determine and record the short commit hash.
- `mapping_pipeline` — walk data → encoders → core model → outputs → losses → serving/eval → optimizer.
- `locating_sources` — find the defining file:line ranges for each component.
- `verifying_lines` — read the exact lines to confirm every range is correct.
- `reading_paper` — (paper only) read the injected paper.
- `cross_checking_paper` — (paper only) confirm the paper describes THIS model; if not,
  `report_paper_mismatch` and continue code-only.
- `laying_out` — assign box positions and wire paths.
- `finalizing` — call `finalize_diagram`.

Terminals: `done` (via `finalize_diagram`), `not_a_model_root` (via `report_problem`),
`failed` (agent error / exhausted budget / failed §7.1). `paper_mismatch` is a non-terminal WARNING —
the run still reaches `done`.

## 9. Confidence

Report which labels carry lower-confidence values (e.g. paper table cells you could not verify in code)
via the `confidence` field on `paper_citations` — never silently. When proceeding without a paper (or
after a mismatch), paper-cited numbers are omitted and affected labels are lower-confidence.
