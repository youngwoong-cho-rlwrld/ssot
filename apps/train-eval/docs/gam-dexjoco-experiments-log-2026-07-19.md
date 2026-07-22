# GAM DexJoCo debug — experiment log (2026-07-19)

> **Historical log:** audited conclusions, corrected identifiers, live status,
> and the next experiment design are in the
> [audited July 21 plan](./gam-dexjoco-audited-status-and-experiment-plan-2026-07-21.md).
> "Retrains in flight" below was true when this log was written, not a current
> status.

Investigation into why GAM DexJoCo policies scored 0% success. Format:
"To test A, did B → result. *experiment* `job`".

Original-run root cause found: **hold-collapse** — training used absolute
EEF-pose and hand-joint targets (`action_frame="base"`) q01/q99-normalized over
full action ranges, so
within-chunk motion is only ~2.3% of normalized target variance; the model
converged to "hold current pose". The paper works because it uses **relative
delta-EEF** actions. Fix = observation-anchored delta-action targets + chunk 8
and velocity loss; retrains were in flight when this log was written.

## Question log ("Is A a problem? → Yes/No")
- **Is the model just learning "hold pose" instead of motion?** → **Yes**
  (offline fit: motion = ~5% of GT)
- **Does giving it action history fix that?** → **No** (H=1/3/7 all collapsed →
  training-side, not serving)
- **Is the dataset↔env action contract broken?** → **No** (GT replay solves the task)
- **Is the DA3 backbone wrong or unhealthy?** → **No** (hash matches, depth
  sensible, no drift)
- **Is the collapse intrinsic to GAM (vs our training)?** → **No** (paper ckpt
  moves offline, magR 0.6–0.9 → it's ours)
- **Is the serving/statefulness the root cause?** → **No** (real, but secondary)
- **Is the root cause our absolute action targets?** → **Yes** (within-chunk
  motion = 2.3% of normalized target variance)
- **Does the paper legitimize absolute joint targets?** → **No** (all their
  results are delta-EEF; "joint commands" is an unqualified aside)

- **Did wrong execution horizon cause the low LIBERO reproduction?** → **No**
  (`action_horizon=1` already executes the full C=8 chunk per model step; H1≡H8,
  both 9/30. Config all verified correct.)
- **Is the low LIBERO reproduction a config/serving mismatch?** → **No** — it was
  an **env-lifecycle bug**: the LIBERO env is created once per task and its EGL
  render context leaks → worker `SIGABRT` after ~4 episodes → remaining episodes
  return "Broken pipe" and are counted as failures. Recreating the env per
  episode → **30/30 = 100%** on spatial tasks 0–2 (above paper's ~90%). Every
  config knob (normalizer `libero_noop_spatial`, image hflip/rotate, proprio
  axis_angle, camera, sampling) verified against the ckpt's embedded config.
  → **Reproduction control PASSES; eval/serving/backbone validated end-to-end.**

Later result:
- **Does the delta-action fix work?** → It removes hold-collapse but the 30k
  policy remains inaccurate and scores 0/50 (MLXP train `f2fa677f`, eval
  `165003`). The underlying precision failure remains unresolved.
- **Do relative 3D keypoints add value?** → No evidence of benefit: plain delta
  beats keypoint delta on 5/6 action blocks. The incomplete keypoint-delta eval
  produced official 0/50 results on four tasks (0/200 total) and no unlock result
  (MLXP train `d6810082`, eval `164105`, cancelled resume `164916`).

## Running when written
- To test the fix (absolute→relative actions) for hold-collapse, retraining on
  MLXP. *delta-action train* `youngwoong-train-...delta-c8-...-f2fa677f`
- To test whether relative 3D hand keypoints add value on top of the delta fix,
  retraining on MLXP. *kpbottleneck-delta train*
  `youngwoong-train-...kpbottleneck-delta-...-d6810082`

## Done
- To test if the model learned motion or just "hold pose", ran offline
  teacher-forced per-joint fit → collapse (motion = ~5% of GT magnitude).
  *offline fit* (job 163529)
- To test whether action history rescues it, ran H>1 teacher-forcing → no
  (magR flat at H=1/3/7) → training-side, not serving. *hist fit* (job 163701)
- To test if the dataset↔env action contract is valid, replayed GT actions in
  sim → gross layout/semantics valid (microwave solved 2/5 replays;
  absolute-pose semantics confirmed).
  *GT replay* (job 163699)
- To test if the DA3 backbone is correct/healthy, ran sha256 + depth render +
  fine-tune drift → correct, sensible depth, no drift. *backbone verify*
  (job 163694)
- To test whether the collapse is ours or intrinsic to GAM, ran the paper
  checkpoint offline → magR 0.6–0.9 (real motion) → ours. *LIBERO control*
- To test whether our eval/serving/backbone reproduces the paper end-to-end, ran
  the paper LIBERO-spatial ckpt closed-loop → 30/30 = 100% after fixing an EGL
  env-recreation bug (was mis-reading as 30% from crash-cascade failures).
  *LIBERO reproduction* (skt `163863`/`163864` + eglfix2)
- To test the root cause, ran variance decomposition of normalized actions →
  absolute targets, within-chunk motion = 2.3436% of normalized target variance.
  *collapse cause*

## Notes / open items
- Serving fix (secondary): boundary threshold recalibrated `GAM_SERVER_RESET_STATE_L2`
  0.5→3.5; server auto-detects `*_delta` checkpoints and reconstructs
  absolute = delta + p44(state).
- Paper LIBERO closed-loop reproduction was 11/30 = 36.7% at
  `action_horizon=1` (single-step execution) — NOT the paper's ~90%+. The
  *LIBERO re-eval* above tests whether matching C=8 chunk execution closes it;
  eval-only (no retrain).
- Two launch-blockers fixed on the delta branch: stats pooling with
  `samples=-1` (b8837ed); step counter inherited from `pretrained-gam.pt`
  (train_steps=235000) causing 0-step exit (5b340e3).
- Next after retrains finish: copy checkpoint to skt (delete-after-copy),
  submit eval.

See also: `gam-dexjoco-zero-success-debug-2026-07-19.md` (full investigation
handoff + resolution).
