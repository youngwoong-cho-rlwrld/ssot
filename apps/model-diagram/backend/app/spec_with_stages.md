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
- **Sources are named, not pasted** — for every file a snippet points at, add a `sources[]` entry with
  the repo-relative path in `sources[].name` (and its `source_key`). Do NOT paste file contents: the
  backend fetches each named file's exact bytes itself at finalize time (via the same scoped read-only
  access you used) and embeds them byte-for-byte. Only name files that actually exist under the root —
  a name the backend cannot read is a retryable error and finalize will be rejected.

## 3. Structured result (finalize_diagram fields — the tool schema is authoritative)

- `canvas`: `{width, height}` — width 680 by convention, height tall enough for all boxes and wires.
- `sources[]`: `{source_key, name, line_count}` — every file any snippet points at: a stable
  `source_key`, the repo-relative `name`, and OPTIONALLY the `line_count` you expect (for cross-check
  only). You do NOT send file contents — the backend fetches the exact bytes of each named file at
  finalize time and embeds them, then verifies every snippet range against those bytes.
- `components[]`: `{component_key, kebab_id, kind, name_html, shape_html, position, hp_value, hp_cite,
  snippets[], paper_citations[]}`.
  - `kind` is `component` (a diagram box — must have a `position` `{left, top, width, min_height}` and at
    least one snippet) or `hp_row` (a hyperparameter row — must have `hp_value`; `position` is null).
  - `snippets[]` entries are `{source_key, start, end}` (1-indexed inclusive) in step order; more than one
    enables the stepper.
  - `paper_citations[]` (per component) `{label, paper_value, paper_location, code_value, confidence,
    paper_quote, paper_anchor}` — ONLY when a paper is attached and matches; provenance for the §6
    hyperparameter section AND the §10.3 embedded paper panel. `paper_quote` is the EXACT full
    sentence / table-cell text that states this value — copied VERBATIM and CONTIGUOUS from the injected
    paper text (word-for-word, one unbroken span; never paraphrased, summarized, or stitched from
    separate fragments), a complete statement rather than a bare keyword; the panel locates it by
    substring, so an inexact quote will not highlight. Leave `paper_quote` empty only when the paper does
    not state the value (say `not stated` in the row). `paper_anchor` is optional (leave empty unless you
    can identify a real DOM id in the paper). When a paper is attached and matches, finalizing with NO
    quoted `paper_citations` is rejected (§7.1) — supply them, or call `report_paper_mismatch`.
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
- `shape_html` fact lines may be made individually clickable (`.fact` spans) so each line links to its
  own snippet — see §10.2.

**Topology — branch what the code branches.** The layout MUST reflect the code's real data flow, not a
tidy single column. If the pipeline has side inputs (a text encoder, an image/vision encoder, a
proprio/state branch), auxiliary losses (feature/depth/contrastive terms beside the main action loss),
or an optimizer, each is its OWN side-column box with its own wire(s) into the main column — you get
fan-out (one box feeding several) and fan-in (several boxes feeding one). A purely linear, one-per-row
single column is correct ONLY when the code path is genuinely linear end to end. If your layout came out
all-linear, treat that as a review trigger: go back and check for a side encoder, an auxiliary loss, or
an optimizer you collapsed into the trunk, and branch it out. Do NOT invent splits the code does not have
— a genuinely linear model stays linear.

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
versa; the wire count matches the arrowhead count; AND, when a paper is attached and was not reported as
a mismatch, at least one `paper_citation` carries a non-empty verbatim `paper_quote` (§6). The paper
check is retryable (correct and call finalize again, up to the finalize budget); the others are too. If
the budget is exhausted the run ends `agent_failure` with the detail — so verify your line ranges by
reading the exact lines, and collect the paper quotes, before finalizing.

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
  `report_paper_mismatch` and continue code-only. If it DOES match, this stage ends with the paper's
  hyperparameters and the VERBATIM quote sentence backing each one collected, ready to attach as
  `hp_row` components + `paper_citations` (§6). Do not leave this stage until every paper-stated value
  has its exact quote in hand — finalizing a matched paper with no quoted citations is rejected (§7.1).
- `laying_out` — assign box positions, wire paths, and any per-line facts (§10.2).
- `finalizing` — assemble the structured result and call `finalize_diagram` (name the source files;
  the backend fetches their bytes and runs the §7.1 checks). Emit this stage BEFORE the tool call so the
  UI shows progress while the backend fetches sources and renders.

Terminals: `done` (via `finalize_diagram`), `not_a_model_root` (via `report_problem`),
`failed` (agent error / exhausted budget / failed §7.1). `paper_mismatch` is a non-terminal WARNING —
the run still reaches `done`.

## 9. Confidence

Report which labels carry lower-confidence values (e.g. paper table cells you could not verify in code)
via the `confidence` field on `paper_citations` — never silently. When proceeding without a paper (or
after a mismatch), paper-cited numbers are omitted and affected labels are lower-confidence.

## 10. Final-page contract (addendum — supersedes conflicting guidance above)

This captures the final, browser-verified reference page. The backend still owns the verbatim
head/CSS/JS skeleton and assembly — you supply only the structured `finalize_diagram` fields. Each
item below is tagged: *(active)* = part of the v1 contract you must follow; *(backend)* = the backend
guarantees it, nothing for you to do; *(fast-follow — not in v1)* = documented target that is NOT yet
part of the finalize contract, so do NOT emit fields for it.

### 10.1 Height triad *(backend)*

`viewBox="0 0 680 H"`, `.wires { height: H }`, and `.diagram { min-height: H }` must be the SAME
number or the SVG rescales and every arrowhead lands short of its box. The backend derives all three
slots from your single `canvas.height`, so they can never disagree — just set `canvas.height` tall
enough for the lowest box plus its wires (≈ lowest box bottom + 25).

### 10.2 Per-line facts *(active)*

A box's `shape_html` may split its fact lines into individually clickable links instead of plain text.
The FIRST fact line is the box's tensor dimensions (when the component carries tensors) rendered in the
one permitted accent color; boxes with no tensor flow (losses, optimizer, eval protocol) lead with
their key value instead. Prose facts follow.

```html
<span class="fact dim" data-component="KEY" data-step="0">image [B,8,2,3,224,224]</span><br>
<span class="fact" data-component="KEY" data-step="1">20 Hz · chunk 8 · T = 8</span>
```

- Clicking a fact selects component `KEY` AND snippet index `N` (0-based), so one box can point each
  line at a different snippet.
- A fact MUST target its own box's component: `data-component` equals the enclosing box's
  `component_key`. If a line needs code from another component's snippets, copy that snippet into this
  component and point the fact at the local index — a cross-component target lights up the wrong box's
  outline and reads as a bug.
- Mark tensor-dimension facts with `class="fact dim"`; they render in the single accent color
  (`#2563eb`) — the only non-grayscale allowed (amends the grayscale invariant). Detect dim lines by
  their `[B,…]` bracket notation.
- Every value in a fact must be present in the code the click opens. Paper-only numbers are forbidden
  in diagram boxes — they live in the §6 hyperparameter section with citations.
- Facts count as data: the §7.1 backend check rejects any fact whose `data-component` is not its own
  box's component, or whose `data-step` is outside that component's snippet count. Omit `data-step`
  only when the box has a single snippet (it defaults to 0).

### 10.3 Embedded paper panel *(active)*

The page embeds the sanitized source paper in a lower right-pane panel and highlights the exact
sentence / table cell backing each cited value. The backend owns everything visual: it sanitizes the
paper to a whitelisted, id-preserving HTML rendering (arXiv/HTML papers) or per-page text sections
(PDF papers), embeds it as `paperDoc`, and builds `paperRefs` from your `paper_citations`. Clicking a
component (a diagram box or an `hp_row`) whose citation carries a `paper_quote` opens the pane and
cross-highlights that sentence (multi-text-node matching handled by the backend JS).

Your ONLY job for the panel: on each `paper_citations[]` entry, supply `paper_quote` = the exact, full
sentence or table-cell text you read in the injected paper that states the value (§3). The first
citation on a component drives its ref; its `paper_quote` (when present and locatable in the doc) drives
the sentence highlight. Any component that carries a citation OPENS the pane when clicked; if the quote
is empty or can't be found, the pane still opens, just unhighlighted (the pane is hidden only for
components with no citation at all). `paper_anchor` is optional — leave it empty unless you can name a
real DOM id; the matcher searches the whole doc when it is empty. Never fabricate a quote: if the
sentence is not in the paper, leave `paper_quote` empty (the pane will open unhighlighted).

### 10.4 Wire generation & geometry gates *(measure pass active; §7.3 screenshot fast-follow)*

You still supply your intended layout — box positions and orthogonal `path_d` (§5) with generous
vertical gaps. But the backend no longer trusts them blind: after your `finalize_diagram` persists and
the provisional page renders, the backend runs a headless-Chrome **geometry pass** (§7.2). It measures
every box's REAL rendered rect (boxes are taller than `min_height` once fact text wraps), then:

- resolves vertical overlaps by pushing lower boxes straight down, preserving your column structure;
- sets each box's `min-height` to its measured height so wrapped text is always enclosed (fixes the
  "text overflows the box / into the next box" class of bug);
- grows the canvas (updates the A1 height triad); and
- regenerates every wire from the measured geometry (orthogonal M/V/H, routed through the cleared
  inter-row gaps, never through a box interior).

So your job is a *sensible* layout, not a pixel-perfect one — lay boxes out in the right columns with
comfortable gaps and the backend corrects the geometry. The measure pass degrades gracefully: on a host
with no Chrome/Chromium binary it is skipped and your layout is kept as-is, so still leave real vertical
gaps. The endpoint audit and the real-browser screenshot eyeball (§7.3) remain a documented fast-follow.
