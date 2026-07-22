# GAM DexJoCo debugging — complete handoff (2026-07-20)

> **Audited update (2026-07-21):** current status, corrected causal claims, and
> the instrumented experiment ladder now live in the
> [audited July 21 plan](./gam-dexjoco-audited-status-and-experiment-plan-2026-07-21.md).
> In particular, the 2.3% figure is normalized target variance, the original
> absolute-target
> hold-collapse is proven but the remaining plain-delta failure is not
> root-caused, and the 30k plain-delta run already trained DA3 blocks 13–39.
> Treat this July 20 document's in-flight status as historical.

Written so someone with **zero prior context** can pick this up. Read top to
bottom once, then use the sections as reference.

---

## 0. TL;DR

- **Problem:** Our GAM robot policies score **0% success** on every tested
  DexJoCo manipulation task. PhysiXel scores 42% on microwave and 20% on
  photograph with the same harness, so those tasks and the harness are winnable.
- **Original-run root cause (proven):** GAM was trained to predict an
  **absolute 44-D EEF-pose + hand-joint target**. Over one short action chunk
  the target barely moves, so within-chunk motion is only **2.3436% of
  normalized target variance** — the
  model collapses to "hold the current pose." The GAM paper avoids this by
  predicting **relative/delta** actions (motion is the whole signal).
- **The fix:** retrain predicting **delta actions** (`a_t − current_pose`)
  instead of absolute. This **removed the collapse** (the model now predicts
  motion) **but the retrained policy is still too imprecise to complete tasks
  → still 0% closed-loop.** It is **necessary but not sufficient**; it looks
  possibly undertrained (30k steps vs the paper's 150k reference recipe) and
  has a badly predicted right-arm EEF rotation block. The cause of that low
  precision is not yet proven.
- **Where we are:** the original absolute-target collapse is proven; the delta
  fix is directionally correct but its remaining failure needs controlled
  rotation, adaptation, and training-length tests before a stronger retrain.

---

## 1. Vocabulary (know these 6 terms)

- **GAM** = "Geometric Action Model", a robot policy (arXiv 2606.17046, repo
  `cvlab-kaist/Geometric-Action-Model`). Uses a geometry/depth backbone
  ("DA3") + a predictor + an action head. This is the model we're debugging.
- **DexJoCo** = our in-house bimanual (two-arm, two-hand) MuJoCo simulation +
  dataset. 5 tasks: assembly, hanoi, microwave_cook, photograph, unlock_ipad.
- **PhysiXel** = a *different* policy family that already works on DexJoCo
  (the baseline we compare against: microwave 42%, photograph 20%).
- **LIBERO** = a public single-arm benchmark the GAM paper reports on (~90–97%).
  We use it as a **control** (known-good data + public checkpoints).
- **Action representation** — the crux of everything:
  - **absolute** = "put the EEF/hand AT this pose" (what we wrongly used).
  - **delta / relative** = "MOVE the end-effector BY this much" (what the
    paper uses; motion is the signal).
- **Chunk** = the model predicts C future actions at once (paper C=8; our
  broken run used C=16). One model step → C low-level actions executed.

---

## 2. The root cause, in one paragraph

Action targets are **absolute EEF-pose + hand-joint values**, normalized to each
dimension's full working range (q01/q99). Within one C-step chunk the action
moves a tiny fraction of its range, so **within-chunk motion is ~2.3% of
normalized target variance** — the other ~98% is the static pose the model
can copy from its own proprioception "for free." The loss optimum is therefore
"predict ≈ current pose" = **hold-collapse**. The GAM paper's LIBERO setup uses
**delta end-effector** actions (via robosuite's OSC controller), where the
target is zero-centered motion, so this never happens. Subtle trap: the config
value `action_frame="base"` means **delta** in the paper's LIBERO code but was
(re)used as **absolute** for DexJoCo — that's the seam the bug entered through.

---

## 3. Everything we tested (the evidence)

Format: **To test X → recipe → conclusion (why)**. "Offline" = run the model on
stored data, no simulator. "Closed-loop" = model drives the sim, count task
successes.

| # | To test… | Recipe | Conclusion | Why |
|---|---|---|---|---|
| 1 | our GAM LIBERO serving/eval path works | GAM + LIBERO (paper ckpt) | LIBERO path OK | 30/30 closed-loop |
| 2 | calibrate the offline motion metric | GAM + LIBERO (paper ckpt, offline) | good model = magR 0.6–0.9 | reference point |
| 3 | absolute drops motion into collapse regime (LIBERO) | GAM + LIBERO + absolute (offline) | yes | motion 12.9%→1.9% |
| 4 | absolute also fails LIBERO closed-loop | GAM + LIBERO + abs (3-way) | **incomplete** | see audited Jul 21 plan |
| 5 | our model predicts motion or holds pose | GAM + DexJoCo + absolute (offline) | hold-collapse (ours) | magR 0.05 vs 0.6–0.9 |
| 6 | the original-run root cause | GAM + DexJoCo + absolute (variance decomp) | absolute targets | motion 2.3436% of target variance |
| 7 | action history rescues it | GAM + DexJoCo + absolute + H>1 | no → training-side | flat at H=1/3/7 |
| 8 | rule out corrupt/catastrophic backbone failure | DA3 hash/depth/drift | ruled out | hash match, clean depth |
| 9 | test gross dataset↔env contract | DexJoCo env + GT actions replayed | layout/semantics work | GT actions solve 2/5 microwave replays |
| 10 | delta fix WITH keypoints (closed-loop) | GAM + DexJoCo + delta + rel-keypoints | fails/incomplete | 0/50 on four tasks (0/200); no unlock result |
| 11 | why kpdelta is 0% (serving vs model) | kpdelta checkpoint (probe) | reconstruction exact, model weak | block R² −0.047–0.435 |
| 12 | plain delta predicts motion better than kp | GAM + DexJoCo + delta C8 (offline, box) | better, still imprecise | beats kp 5/6 blocks; r_rot broken |
| 13 | plain delta fix closed-loop | GAM + DexJoCo + delta C8 | **fails (0%)** | 0/25 mic, 0/25 photo |

Reading order (the ablation ladder): **1–2** the known-good LIBERO path works
(paper model → 30/30). **3** shows offline that switching delta→absolute drops
motion into the collapse regime; **4**, the closed-loop causal confirmation,
remains incomplete. **5–9** root-cause the original DexJoCo absolute checkpoint
while ruling out broad contract and corrupt-backbone alternatives. **10–13**
show that the multi-change delta recipe removes collapse offline but remains too
weak for closed-loop success.

**Two independent confirmations the original-run mechanism is real & specific:**
- The offline *within-chunk motion %* metric: delta=12.9% vs absolute=1.9% (on
  LIBERO, holding everything else fixed).
- The serving math was **verified correct** (reconstruction roundtrip error
  ~1e-10; rotation geodesic ~1e-6°) — so the 0% is the model, not a serving bug.

---

## 4. The fix (what "delta" means concretely)

Instead of predicting the absolute action `a_t`, predict the **observation-
anchored delta**:

```
delta_k = a_{t+k}^abs − p44(proprio_t)        # training target, k = 0..C-1
```

- `p44(...)` projects the 46-D proprioception vector to the 44-D action layout
  (per arm: xyz stays, **quaternion(wxyz)→rotvec** for orientation, hand joints
  copy). Implemented as `dexjoco_dual_proprio_to_p44` in
  `src/robot/data/dexjoco_lerobot.py`.
- Normalizer (q01/q99) is **recomputed on the delta distribution**, stored
  under a new stats key `dexjoco_dual_arm_delta`.
- **Serving reconstructs absolute** before sending to the robot:
  `a_abs = delta + p44(current_state)` — in
  `apps/train-eval/lib/dexjoco/gam_dexjoco_server.py` (auto-detects a `*_delta`
  stats key). Rotvec is added component-wise, which is the *exact inverse* of
  the loader's subtraction (verified: reconstructed rotation is exact).
- Also added: `chunk_size=8` (match paper), a **velocity loss** (`lambda_vel`)
  on chunk first-differences, and a **motion-space metric** logged to W&B
  (`motion_ratio`, `delta_R2`) so a future collapse is visible during training.

Two variants were built:
- **plain delta** — predicts the 44-D delta directly. gam branch
  `dexjoco-delta-actions` (tip `5b340e3`).
- **keypoint-delta** — predicts 126-D *relative* hand keypoints, then an MLP
  decodes to the 44-D delta. gam branch `dexjoco-kpbottleneck-delta`
  (tip `3ed78a1`). The extra decoder adds approximation error; it did worse
  than plain delta.

Two launch bugs found & fixed on the branches (both would silently break a run):
- `b8837ed` — action-stats pooling used only 1 window/leaf when
  `samples=-1` → degenerate normalizer.
- `5b340e3` — the init checkpoint `pretrained-gam.pt` carries
  `train_steps=235000`; the trainer inherited it, so a 30k-step run exited at
  step 0. Fix: reset step counter when initializing from a foreign checkpoint.

---

## 5. Results of the fix (the sobering part)

| Variant | Training | Offline delta R² (per block) | Closed-loop |
|---|---|---|---|
| absolute (original) | collapsed | ~0 motion (magR 0.05) | 0% (all tasks) |
| keypoint-delta | escaped collapse | −0.047–0.435 | 0/50 on four tasks; no unlock result |
| plain delta | escaped collapse | 0.21–0.58 (r_rot **−0.32**) | **0/25** mic, **0/25** photo |

- The delta fix **works at the training level** (model predicts real motion,
  ~half the GT magnitude) but **the policy is not accurate enough** → still
  misses grasps → 0% success.
- **Plain delta > keypoint-delta** on 5 of 6 action blocks (worth pursuing the
  plain variant, drop the keypoint one for now).
- **Localized symptom: right-arm EEF rotation (`r_rot`, R² −0.32)** — the model
  predicts this three-dimensional block especially poorly. This does not yet
  identify whether the cause is representation, data, or optimization.

**Interpretation:** necessary-but-not-sufficient. Training length, rotation
representation/data, and adaptation capacity remain hypotheses, not conclusions.
They need gated tests before an expensive retrain.

---

## 6. What should be done next (priority order)

1. **Implement the fixed-manifest debug probe and pass a motion-stratified tiny
   overfit**, including both rotation blocks and a checkpoint/server reload.
2. **Audit and A/B rotation targets:** current component-wise rotvec delta
   versus a matched group-relative SO(3) target. Keep the current method unless
   the controlled A/B improves rotation without hurting other blocks.
3. **Test adaptation capacity:** blocks 13–39 are already trainable in the 30k
   delta run. Compare that baseline with a stronger adaptation setting rather
   than presenting 13–39 as a new fix.
4. **Only after those gates pass, run the 150k learning curve**, retaining C=8,
   delta statistics, velocity loss, and checkpoint-level motion metrics. Submit
   a 5+5 microwave/photo gate only after offline metrics pass.
5. **Finish the LIBERO 3-way ablation** as a confirmatory parallel control; do
   not block the DexJoCo ladder on it.

---

## 7. Infrastructure (where things run)

Three compute targets — know which can do what:

- **skt** — Slurm cluster. `ssh skt`. Slurm binaries need
  `export PATH=/opt/slurm/bin:$PATH`. Partitions: `rlwrld-gpu` (H200) and
  `l40s-gpu` (+ `_background` preemptible variants). **Currently GPU-saturated**
  (jobs sit PENDING for hours). Has `/fsx` shared storage (all checkpoints).
- **MLXP** — Kubernetes GPU (H200). Reached via the backend, or
  `kubectl exec youngwoong-data-pod -n p-rlwrld -- ...`. Storage under `/data`.
  **Training was done here.** Datasets at `/data/youngwoong/datasets/<name>`.
- **The in-house box** — `ssh youngwoong@100.80.190.34`. **RTX 5080, 16 GB,
  Ubuntu, NOT Slurm, NO /fsx.** A raw GPU escape hatch when Slurm is jammed.
  Gotchas: **build the venv on python3.11** (3.12 dev headers missing → Triton
  JIT fails); `torch` cu130 works out-of-the-box on Blackwell (sm_120); LIBERO
  sim **works** here (python3.11 + numpy 1.26.4 + robosuite 1.4.1 + mujoco
  3.6.0 + bddl 1.0.1). 16 GB forces small batches / grad checkpointing / frozen
  backbone. Files staged under `~/scratch/dexjoco-spike/`. Only compute that
  does **not** need something absent (it has no /fsx, so transfer inputs).

**train-eval-web** (the harness that runs everything): backend at
`http://localhost:8000` on the Mac. Key API:
- Submit: `POST /api/submit` with `{cluster, variant, phase:"train"|"eval",
  checkpoint_path (eval), job_name, idempotency_key, eval_num_gpus,
  eval_num_envs_per_gpu, eval_tasks, eval_n_episodes, eval_n_runs, partition,
  train_git_commit}`. **An explicit `job_name` is required when
  `idempotency_key` is set.** Job names must be descriptive and
  `youngwoong_`-prefixed (standing rule from the user).
- Cancel: `DELETE /api/jobs/skt/<id>`.
- Resume a timed-out eval (seeds prior results so per-episode resume works):
  `POST /api/jobs/skt/<id>/resume`.
- Copy checkpoint MLXP↔skt with delete-after:
  `POST /api/jobs/mlxp/<id>/copy-checkpoint`
  `{dest_cluster:"skt", sources:[<run dir>], delete_source:true}`; poll
  `GET /api/copy-jobs/<copy_id>`.

**EVAL CONSTRAINT (important):** multi-env eval is **disabled** backend-side
("ALLEX target reset path is not vector-env safe") — every DexJoCo eval runs
**1 env / 1 GPU**, so a full 5-task × 50-ep × 3-run eval takes ~24 h. For a
signal, restrict to `eval_tasks=[microwave, photograph]` with fewer episodes.
1 env is also the apples-to-apples match to PhysiXel (which ran 1 env).

---

## 8. Concrete paths, commits, IDs

- Local repo (this Mac): `~/workspace/ssot`. Relevant:
  `apps/train-eval/lib/dexjoco/gam_dexjoco_server.py` (server + delta
  reconstruction), `apps/train-eval/configs/experiments/<variant>/`
  (config.sh + gam_config.yaml).
- Prior handoff docs: `apps/train-eval/docs/gam-dexjoco-zero-success-debug-2026-07-19.md`
  (original investigation + resolution), `...gam-dexjoco-experiments-log-2026-07-19.md`
  (Q/A log + config table).
- GAM training repo: skt `/fsx/rlwrld/youngwoong_cho/workspace/gam`; MLXP
  `/data/youngwoong/workspace/gam`. Branches: `dexjoco-delta-actions`
  (`5b340e3`, plain), `dexjoco-kpbottleneck-delta` (`3ed78a1`, keypoint).
  Transfer a branch skt→MLXP with a git bundle over `kubectl cp` + `git fetch`.
- Checkpoints on skt (`/fsx/rlwrld/youngwoong_cho/.train-eval-web/experiments/<variant>/checkpoints/<run>/`):
  - plain delta: `dexjoco_gam_delta_c8_bimanual_5tasks_224/.../*_074130_2cec1c/checkpoint-final.pt`
  - keypoint delta: `dexjoco_gam_kpbottleneck_delta_bimanual_5tasks_224/.../*_085426_450c2f/checkpoint-final.pt`
  - Each has `action_stats/dexjoco_dual_arm_delta.json` (+ `_proprio`, `_keypoint`).
- DA3 backbone: `track4world_da3.pth` (sha256-verified vs the official HF
  dataset `SeonghuJeon/3da-libero-training-assets`).
- Diagnostic artifacts on skt `/fsx/rlwrld/youngwoong_cho/debug_20260719/`:
  `offline_fit/`, `collapse_cause/vardecomp.json`, `libero_control/` (paper
  repro + eglfix), `libero_absolute_abtest/` (3-way ablation), `kpdelta_diag/`,
  `plaindelta_diag/`. On the box: `~/scratch/dexjoco-spike/`.
- W&B: entity `youngwoong`, project `dexjoco` (private).

**In-flight jobs (as of this doc):**
- LIBERO ablation on the box: arm A (delta) training (~3 h), then C, then B.
  Slurm twins for A cancelled; B/C twins (`164912/164913/164914/164915`) remain
  as fallback. `validate` (164909) already passed (absolute controllers execute
  on GPU).
- DexJoCo plain-delta eval `165003` — **completed, 0/25 + 0/25** (see §5).

---

## 9. Gotchas (learned the hard way)

- **Don't confuse `action_frame="base"`**: delta in LIBERO code, absolute in the
  DexJoCo config. This ambiguity caused the whole bug.
- **Serving reconstruction is the exact inverse of the current component-wise
  loader transform.** That rules out a loader/server mismatch, but not whether
  component-wise rotvec delta is the best geometric target.
- **`motion_ratio` in training logs is noisy** per-batch (0.008→5.27); don't
  read a single value. Use the offline probe (per-block R² + std_pred/std_gt)
  for a clean read.
- **Multi-env eval is disabled** → 1 env only → evals are slow; scope episodes.
- **Eval resume must be seeded** (use the backend `/resume`, which reuses the
  namespace) or per-episode resume restarts a run from episode 0.
- **The box needs python3.11** (not 3.12) or Triton JIT fails; it has no /fsx
  so inputs must be transferred (~13 GB ckpt+backbone).
- **`scontrol update partition=` is blocked** on skt (submit plugin) — to move a
  job between partitions you must cancel + resubmit.
- Background monitors on the Mac can get reaped and `declare -A` (bash 3.2)
  fails — write portable poll loops.
- The permission classifier may block `scancel`/resume from the shell; use the
  backend API (`DELETE /api/jobs/...`) instead.

---

## 10. The one-sentence status

The original absolute-target checkpoint failed by proven hold-collapse; the
30k delta checkpoint removed that collapse but remained too imprecise (0%
closed-loop), and the cause of its low precision is unresolved, so rotation,
adaptation, and training length must be separated with the instrumented gates
in the audited July 21 plan before a 150k run.
