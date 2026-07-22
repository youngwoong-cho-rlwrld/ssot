# GAM DexJoCo zero-success debug — state & plan (2026-07-19)

> **Superseded for current status (2026-07-21):** see the
> [audited July 21 plan](./gam-dexjoco-audited-status-and-experiment-plan-2026-07-21.md).
> This document correctly diagnoses the original absolute-target checkpoint,
> but that cause
> must not be generalized to the later plain-delta checkpoint. The 2.3% number
> is a fraction of normalized target variance, not a measured fraction of L1
> loss.

Handoff for continuing the investigation into why GAM-family policies score
**0% success across all DexJoCo tasks** while PhysiXel (groot server) scores
42% on microwave and 20% on photograph with byte-identical eval configs.

## 0. RESOLVED (2026-07-19): original-run root cause found — retrain required

**The fine-tune hold-collapsed during training.** Targets are absolute EEF-pose
and hand-joint values normalized to each dimension's full q01/q99 working
range, so within-chunk motion is only **2.3436% of normalized target variance**
(xyz blocks ~1%). "Hold current pose" captures the other 97.7% of that target
variance,
and the model converged to that optimum: offline teacher-forced chunks carry
~**5% of GT motion magnitude** (chance direction on rot/hand), unchanged at
H=1/3/7 with GT action history. The paper avoids this target setup because
LIBERO uses zero-centered **delta-EEF actions** where motion is the target;
`base_delta` in our tree is a **no-op alias** (returns actions unchanged),
so delta targets were never actually implemented for DexJoCo. W&B looked
healthy (`r2_norm` 0.96) because that metric is DC-dominated — no
motion-space metric is logged.

Every other layer is now positively validated:
- Offline abs-fit fine (R² 0.85, no denorm/sign/scale bug), but delta-space
  magR≈0.05 → hold-collapse (`/fsx/.../debug_20260719/offline_fit/`).
- GT-action replay solves microwave in the eval env (2/5 open-loop, sub-mm
  tracking; absolute-pose semantics confirmed) → contract intact
  (`.../gt_replay/`).
- DA3 backbone sha256-matches the official release (HF dataset
  `SeonghuJeon/3da-libero-training-assets`), renders sensible depth, no
  fine-tune drift (blocks 13–39 moved ~1% relL2; EMA≈base to 0.1% — the
  `use_ema` A/B is moot) (`.../backbone/`).
- **Paper LIBERO-spatial checkpoint on OUR cluster stack: 15/15 closed-loop
  success** and offline magR 0.6–0.9 → plumbing/serving/eval validated
  end-to-end; the collapse is specific to our run (`.../libero_control/`).
- Variance decomposition + recipe diff vs paper: `.../collapse_cause/vardecomp.json`.

**Retrain prescription (ranked):**
1. Implement real delta-action targets in the DexJoCo loader
   (`a_t^Δ = a_t^abs − proprio_current`), recompute q01/q99 on the delta
   distribution, reconstruct absolute at serve time (server has proprio).
   This is a code change + stats refresh, not a config flip.
2. `chunk_size=8` (match paper C=8; 16 amplifies DC dominance).
3. Optional insurance: velocity-loss term `lambda_vel * L1(Δpred, Δgt)`.
4. Log a motion-space metric (delta-R²/magR) to W&B — `r2_norm` is DC-blind.
5. Secondary: fix rotvec antipodal range inflation (dims 3/25 span ~6.0).

Serving fix status: boundary threshold recalibrated from 162856 probe data
(in-episode deltas up to ~2.5 early-episode, true boundaries 5.6–6.3) →
`GAM_SERVER_RESET_STATE_L2` default now **3.5**. Real but secondary; history
provably does not rescue the collapsed checkpoint.

The sections below are the investigation log that led here.

## 1. Symptom

- `dexjoco_gam_bimanual_5tasks_224` (baseline) — **0 / 300+** episodes.
- `dexjoco_gam_kpbottleneck_v2_bimanual_5tasks_224` (v2) — **0 / 460+** episodes.
- All failures are **timeouts at the step cap** (1000–1500 steps per task); no
  safety aborts. `bimanual_unlock_ipad` fails specifically with
  `failure_no_password_input` (never presses a button).
- Behavior (verified frame-by-frame from episode videos): **purposeful gross
  motion, no vision-guided precision, often decaying to stillness** (baseline
  assembly: grasps peg, near-miss insert; v2: reaches then freezes, up to 95%
  static frames). The user reports individual **joint trajectories look weird**.
- Comparison honesty: PhysiXel also scores 0% on assembly and hanoi. Its wins
  are `bimanual_microwave_cook` (42%) and `bimanual_photograph` (20%) — those
  two are the meaningful A/B tasks.

## 2. Environment / topology

- Local monorepo: `~/workspace/ssot` (`apps/train-eval` = harness backend
  `backend/app/`, sbatch bodies `lib/`, experiment configs
  `configs/experiments/<variant>/config.sh`). Backend at `127.0.0.1:8000`,
  gateway `:4000`. Submissions rsync `lib/` + configs to skt
  `~/.train-eval-web/` (SHARED staging — a new submit updates the server
  script that PENDING/resumed jobs will start).
- Cluster: ssh alias `skt`. Eval partition `rlwrld-gpu` (6× p5en-48xl nodes,
  8× H200 each). **Nodes -3 and -5 are excluded**
  (`SBATCH_EXCLUDE` in `~/.train-eval-web/clusters/skt.env` on the Mac):
  node-3 freezes all clients (0 bytes written, procs alive); node-5 kills
  clients silently ~8 min in. Node-6 is proven healthy. The kill/freeze
  plague is node-time-correlated (suspected FSx/Lustre); it also hits 1-env
  jobs, and killed clients become zombies under a live micromamba wrapper.
- GAM training repo worktrees on skt (per-job pins):
  `/fsx/rlwrld/youngwoong_cho/.train-eval-web/.worktrees/<jobid>` —
  baseline commit `69afa53`, kpbottleneck-v2 commit `e47b919`.
  Key file: `src/eval_libero_unified.py` (policy closure, `load_stage1_policy`
  ~:1752, closure ~:2960, `_generate_gam_chunks` ~:2769,
  `commit_observation` :4011, `reset_episode` :4060, canonical LIBERO loop
  ~:4831/:5234-5246/:5553-5575).
- Eval client (shared with groot; proven good):
  `/fsx/rlwrld/youngwoong_cho/workspace/dexjoco-canonical-6a6d1b2c/dexjoco/dexjoco_openpi_client/`
  (`eval_dexjoco_openpi.py`, `dexjoco_openpi_env.py`). One websocket for all
  episodes; no episode marker on the wire; executes returned 16-action chunk,
  replans when 8 remain (`blocking_overlap`, `replan_ratio=0.5`).
- GAM server (OURS, in the ssot repo): `apps/train-eval/lib/dexjoco/gam_dexjoco_server.py`.
- Checkpoints:
  - baseline: `/fsx/rlwrld/youngwoong_cho/.train-eval-web/experiments/dexjoco_gam_bimanual_5tasks_224/checkpoints/dexjoco_gam_bimanual_5tasks_224_20260716_123746_b1f90b/checkpoint-final.pt`
  - v2: `/fsx/rlwrld-unified-checkpoints/youngwoong_cho/experiments/dexjoco_gam_kpbottleneck_v2_bimanual_5tasks_224/checkpoints/dexjoco_gam_kpbottleneck_v2_bimanual_5tasks_224_20260717_203724_c251e4/checkpoint-final.pt`
  - DA3 backbone: `checkpoints/track4world_da3.pth` (resolved via `DA3_ROOT`
    in the eval body).
- W&B: entity `youngwoong`, project `dexjoco` (PRIVATE — links 404 in
  browsers not logged in as `youngwoong`). Train runs are healthy
  (30k steps, run id == job name).
- Datasets: LeRobot dexjoco data; GAM ingestion via
  `src/robot/data/dexjoco_lerobot.py` in the training repo. PhysiXel trains
  from the same source data through a different pipeline and succeeds.

## 3. What has been established (do NOT re-investigate)

### Ruled out, with evidence
- Action/state dims & layout (44/46; `[r_xyz3,r_rotvec3,r_hand16 | l_...]`,
  rotvec→quat client-side) — correct.
- Action normalizer (q01_q99, key `dexjoco_dual_arm`, present in ckpt,
  applied both directions; loader raises on mismatch, no identity fallback).
- Proprio normalizer — saved + applied.
- Camera mapping — client `base`→server `front`→training `observation.images.ego`;
  eval frame-0 pixel-identical to a training ego frame.
- Image preprocessing — same shared `_normalize_image_tensor` as training.
- `student_da3_ema missing=[1335 keys]` load warning — **benign by design**
  (subset EMA of blocks 13–39 + heads overlaid AFTER the full base load;
  missing keys retain fine-tuned base values). Note: serving uses
  `--use-ema` default-on → blocks 13–39 come from EMA weights (step 30000,
  decay .999) — an untested A/B (`use_ema=False`) remains.
- Chunk/horizon indexing (`execute_start` picks a_t; one model step = 16 env
  actions) — correct. ZeRO-2 checkpoint complete.
- Harness/env/client — groot vs GAM eval configs byte-identical; only the
  server binary differs.
- Infra (server crashes/NaN/OOM) — none; actions flow every step.
- The kpbottleneck feature is NOT the cause of the zero (baseline without it
  is also 0%), but v2 is behaviorally worse (earlier freeze) — it has its own
  regression on top, to revisit after the baseline works.

### The serving deviation found (fixed, effect unproven)
`gam_dexjoco_server.py` called `policy.reset_episode()` on EVERY request →
permanent H_eff=1, zero past-action conditioning, KV cache wiped per chunk.
Paper protocol (GAM = "Geometric Action Model", arXiv 2606.17046, official
repo): eval at **H=1 observation history** BUT with **KV-cached context and
previous-action a_{t-1} maintained across the episode**; repo's canonical
LIBERO loop resets once per episode and commits executed actions every step.
So per-request reset deviates on the past-action/KV axis (our fine-tune
trained with H_choices=[1..7], action_input_rate=0.4 → multi-H is
in-distribution for our checkpoints).

**Fix shipped** (ssot commits `c16e850`, logging in a later commit): server
now keeps state across requests — feeds back the previously returned chunk
via `override_pending_action_chunk` + `commit_observation(1)`, resets only on
a detected episode boundary (proprio L2 jump > `GAM_SERVER_RESET_STATE_L2`,
default 0.5), logs `episode boundary`/`in-episode` decisions.

**Probe verdict (RESOLVED 2026-07-19):** 20 episodes (microwave+photograph)
with the stateful server: **0/20, all full-cap timeouts** (job 162748), and
the instrumented probe (job 162856) CONFIRMS the stateful path engaged:
in-episode deltas 0.07–0.46 (< 0.5 threshold), commits accumulated steadily
(14→114 over reqs 20→120), true boundaries detected (L2≈5.6 at episode
end/cap). Minor: the first ~4–5 chunks of each episode exceed the threshold
(L2 0.7–2.5, fast initial motion) and spuriously reset, so history builds
from ~chunk 5 — cosmetic. **Conclusion: memoryless serving was NOT the root
cause of the 0%.** The serving fix is paper-aligned and stays, but the
problem is upstream (model / data adaptation / training) — sections 5.0–5.2
are the active line of attack. Remaining server-side second-order items:
`use_ema=False` A/B, feeding back the executed ~8 actions instead of the
full 16-chunk.

### Other shipped fixes (orthogonal)
- Multi-env eval: `N_ENVS_PER_GPU` in config.sh (workers = GPUs × envs; each
  worker owns whole (task,set,run) units; ~12G VRAM per server; validated
  2× and 4×/GPU on H200). CPU/mem request scales (`resource_presets.py`).
- Watchdog: zombie-client detection + 60 s retry backoff
  (`eval_body_dexjoco.sh`); `DEXJOCO_NO_PROGRESS_TIMEOUT_SECONDS=900` for the
  bimanual baseline config. KNOWN GAP: a killed client that leaves a zombie
  CHILD under a live micromamba wrapper evades the tracked-pid zombie check
  (seen on node-5); the mp4-progress timeout still catches it at 900 s.
- Per-inference cost measured: GAM ~2.1 s (H200, flat across tasks —
  inference-bound); groot 0.27–2.6 s on L40S (often sim-floor-bound at
  30 Hz). Episodes: caps 1000–1500 steps, videos 30 fps, sim self-paces.

## 4. In-flight jobs (supervisor watches these; do not disturb)

Supervisor: persistent monitor sourcing
`<scratchpad>/evalwatch/watch.sh` + `jobs.txt`; on TIMEOUT resume via
`POST http://localhost:8000/api/jobs/skt/<id>/resume`; fires a per-task event
when BOTH bimanual namespaces have 3/3 runs of a task (comparison trigger).

- `162738` — v2 resume (namespace `*_210730_289cbd`, OLD memoryless server,
  ~225 episodes done pre-resume). "Before" data for v2.
- `162749` — baseline resume (namespace `*_215234_f8a960`, 234 broken-server
  episodes banked; the resumed portion runs the FIXED server → segment
  episodes by mtime when comparing).
- `162856` — instrumented 3-episode probe (see above).

## 5. The debugging plan (next agent: execute in this order)

### 0a. Offline teacher-forced per-joint fit (~1 h; most decisive for "weird joints")
Feed ~50 training-set samples through the trained checkpoint offline (no
sim): load the LeRobot dataset the run trained on, run the model's
`policy(obs, prompt)`/forward with GT observations, compare predicted action
chunks vs GT actions **per dimension** (R², MSE, overlay plots; check scale
and sign per dim: xyz 0-2, rotvec 3-5, hand 6-21, then left-arm block 22-43).
- Good fit offline + bad rollout → compounding error / serving / env side.
- Specific dims off in scale/sign → denormalization or convention bug.
- Poor fit everywhere → training-side problem (check W&B action-r2 of run
  `youngwoong_train_dexjoco_gam_bimanual_5tasks_224_20260716_123746`).
Use the worktree venv: `.worktrees/162702/.venv/bin/python` with
`PYTHONPATH=<worktree>/src`; dataset path per `gam_config.yaml` in
`~/.train-eval-web/experiments/dexjoco_gam_bimanual_5tasks_224/`.

### 0b. Ground-truth action replay in the eval env (~1 h)
Step the DexJoCo sim with GT action sequences straight from the dataset (no
model), same env/config as eval. If GT actions fail the task → dataset↔env
contract broken (absolute-vs-delta, gripper, dt) and no model can win.
PhysiXel succeeding on the same source data makes this less likely, so if
replay passes, diff **GAM's dataloader vs groot's** field-by-field on one
sample (state composition order, action column selection).

### 1. Backbone (GFM/DA3) verification (~30 min)
- sha256 `track4world_da3.pth` vs the official release
  (project page cvlab-kaist.github.io/Geometric-Action-Model, HF
  `SeonghuJeon/3da-libero-gam`).
- Functional: run DA3 on a few eval frames, render predicted depth — garbage
  depth = wrong/broken backbone in one glance.
- Fine-tune drift check: cosine distance between the served encoder blocks
  (checkpoint `student_da3`, and the EMA overlay for blocks 13–39) and the
  pretrained `track4world_da3.pth` weights — catches a catastrophically
  diverged fine-tune that "loads cleanly" but has drifted into uselessness.
- A/B `use_ema=False` (server flag/env; serving currently overlays EMA onto
  blocks 13–39) — 3-episode probe.

### 2. Paper reproduction (strongest end-to-end control)
1. Download the paper's LIBERO checkpoint (HF above), run the repo's OWN
   eval (`docs/evaluation.md`, `eval_libero_unified.py`) → expect ~97.6%.
   Validates plumbing/backbone with zero dependence on our training.
2. If needed, retrain on LIBERO with the paper recipe (public data) →
   validates the training pipeline.
3. The remaining delta to our DexJoCo fine-tune isolates our adaptation:
   46-dim state composition, 44-dim action layout, chunk 16 (paper uses
   C=8!), camera view, or data volume/quality.

### Decision tree
- 0a bad on specific dims → fix denorm/convention, re-probe (cheap).
- 0a good, 0b bad → fix dataset↔env contract.
- 0a good, 0b good, statefulness confirmed engaged, still 0% → run 2.1;
  if 2.1 reproduces 97.6% → our DexJoCo adaptation (state/action/chunk/data)
  is the suspect — consider retraining with C=8 and paper-matching post-train
  (H=1) recipe.
- Also revisit `--use-ema` off (quick) before any retrain.

## 6. Operational gotchas
- Byte-growth, not mtimes, for liveness; check completed-units vs expected
  rate (~7 min/failure-episode on H200).
- SKT client deaths come in simultaneous pairs; retries + 900 s timeout
  handle them; avoid nodes -3/-5 (already excluded).
- scp on this Mac is openrsync/SFTP-broken for globs; use
  `ssh skt 'tar -C dir -cz .' > f.tgz` to pull files.
- Every submit rsyncs `lib/` → changes the server code future/pending jobs
  run. Segment mixed namespaces by episode mtime.
- Eval submits need explicit `checkpoint_path` + unique `job_name` +
  `idempotency_key`. Resume: `/api/jobs/skt/<id>/resume` (TIMEOUT only);
  `/retry` after failure.
