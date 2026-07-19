# GAM DexJoCo debug — experiment log (2026-07-19)

Investigation into why GAM DexJoCo policies scored 0% success. Format:
"To test A, did B → result. *experiment* `job`".

Root cause found: **hold-collapse** — training used absolute joint-position
targets (`action_frame="base"`) q01/q99-normalized over full joint ranges, so
within-chunk motion is only ~2.3% of the L1 loss signal; the model converged to
"hold current pose". The paper works because it uses **relative delta-EEF**
actions. Fix = observation-anchored delta-action targets + chunk 8 + velocity
loss; retrains in flight.

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
  motion = 2.3% of loss signal)
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

Open:
- **Does the delta-action fix work?** → *testing* (MLXP train `f2fa677f`)
- **Do relative 3D keypoints add value?** → *testing* (MLXP train `d6810082`)

## Running
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
  sim → valid (microwave solvable; absolute-pose semantics confirmed).
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
  absolute targets, within-chunk motion = 2.3% of loss variance. *collapse cause*

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
