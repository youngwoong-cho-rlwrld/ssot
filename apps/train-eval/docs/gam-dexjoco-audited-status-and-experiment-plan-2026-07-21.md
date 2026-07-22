# GAM + DexJoCo: audited status and instrumented experiment plan (2026-07-21)

This document supersedes the current-status and next-step claims in the July 19
debug log and the July 20 handoff. Those documents remain useful as historical
investigation records.

The audit used the checked-in configs and server, cached MLXP metadata, Slurm
accounting and live queue state, and the diagnostic artifacts under
`/fsx/rlwrld/youngwoong_cho/debug_20260719/`. Times below are KST.

## 1. Audited conclusion

There are two different GAM failures, and they must not be described as one
root cause:

1. **Original absolute-target GAM:** the failure mechanism is well supported.
   The 44-D target was an absolute bimanual action layout
   `[right xyz, right rotvec, right hand16, left xyz, left rotvec, left hand16]`.
   Within a C=16 chunk, motion accounted for only **2.3436% of normalized target
   variance**. The trained checkpoint reproduced static pose well but predicted
   only about 5% of ground-truth within-chunk motion. It therefore hold-collapsed.
2. **Corrected plain-delta GAM:** hold-collapse was removed, but the 30k policy
   remained too inaccurate and scored 0/50 on microwave and photograph. This is
   the **proximate cause** of its closed-loop failure. Why the accuracy remained
   low is **not proven**. Rotation representation/data, training length, and
   adaptation capacity are hypotheses that require controlled experiments.

The shortest accurate narrative is:

> PhysiXel shows that microwave, photograph, and the shared harness are
> winnable. Original absolute-target GAM failed through a demonstrated
> DC-dominated hold-collapse. Delta+C8+velocity loss restored motion but not
> enough action precision. The underlying cause of the remaining plain-delta
> failure is unresolved; the keypoint bottleneck is a measured additional
> degradation, not the common root cause.

## 2. Terminology and evidence corrections

- Do not call the 44-D action simply "absolute joints." Its arm blocks are
  absolute end-effector xyz/rotvec targets and its hand blocks are 16 joint
  targets per hand.
- Do not call 2.3% a measured fraction of L1 loss. The saved artifact reports
  `within_var_norm / total_var_norm = 0.0234364`, a fraction of normalized
  target variance. It explains why an absolute loss is DC-dominated, but it is
  not a direct decomposition of realized L1 loss.
- The delta retrain was not a single-variable A/B. It changed absolute→delta
  targets, C=16→C=8, recomputed normalization statistics, and added velocity
  loss. The LIBERO target audit supports the representation mechanism, but the
  controlled LIBERO closed-loop A/B/C is not complete.
- Current delta rotation is **component-wise rotvec subtraction/addition**. The
  loader/server round trip is numerically exact, but that does not prove it is
  the best or geometrically correct relative SO(3) target. Rotation dimensions
  3 and 25 span about 6 radians, which makes a branch-cut/antipodal audit
  justified.
- `r_rot R2 = -0.32` is the three-dimensional **right-arm end-effector rotation
  block**, not one wrist joint. It is a symptom in the plain-delta checkpoint,
  not a keypoint-decoder-only failure.
- The 30k plain-delta config already has DA3 fine-tuning enabled with blocks
  13–39 trainable (`freeze_blocks_before: 13`). "Unfreeze blocks 13–39" is
  therefore not a new intervention. A capacity experiment must compare the
  current partial-fine-tuning recipe with stronger adaptation, while a frozen
  control answers only whether fine-tuning helps at all.
- The DA3 check rules out a wrong/corrupt backbone and catastrophic drift. It
  does not prove the amount or learning rate of DexJoCo adaptation is sufficient.
- PhysiXel establishes nonzero success for microwave (42%) and photograph
  (20%). It does not establish that every DexJoCo task is winnable by the
  current data/recipe; it was also 0% on assembly and hanoi.
- N1.6 has not run and is not evidence in this causal chain.
- GT replay succeeded in 2/5 microwave trajectories. This strongly checks the
  gross 44-D layout, absolute-pose semantics, and environment execution path;
  it does not certify every demonstration or GAM's learned data conversion.
- The 30/30 paper-checkpoint LIBERO control validates the known-good GAM
  checkpoint plus the local LIBERO serving/evaluation/backbone path. It does
  not validate DexJoCo ingestion or fine-tuning.
- The stateful-serving probe rules out per-request reset as the sole cause for
  the tested collapsed checkpoint. It does not rule out every second-order
  serving difference.

## 3. Audited experiment ledger

Counts marked "historical snapshot" are conservative numbers recorded by the
older handoff. A storage audit on July 21 found additional failure directories
across roots; retry/resume roots may duplicate attempts, so these must not be
read as exact clean evaluation denominators.

| Submitted       | Experiment / IDs                                                                                 | Question                                                              | Result                                                                                                                                                                                                      | Supported conclusion                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Jul 16 12:38    | Original absolute C16; MLXP train `...d5f717f1`; evals `160953`, `161194`, `162702`, `162749`    | Does the original DexJoCo GAM recipe control the five tasks?          | Historical snapshot 0/300+; July 21 storage audit found at least 489 failure directories and no success across roots                                                                                        | Established zero success and behavior decaying toward holding; later offline probes identify hold-collapse.                      |
| Earlier control | PhysiXel absolute-action baseline                                                                | Are the same simulator and harness capable of success?                | Microwave 42%, photograph 20%                                                                                                                                                                               | These two tasks and the common harness are winnable. Do not generalize to all tasks or GAM ingestion.                            |
| Jul 17 20:37    | Keypoint-v2 absolute C16; MLXP train `...12ac7032`; evals `161192`, `161494`, `162596`, `162738` | Does a keypoint bottleneck fix the original failure?                  | Historical snapshot 0/460+; July 21 storage audit found at least 580 failure directories and no success across roots                                                                                        | No. It did not remove the common absolute-target failure.                                                                        |
| Jul 18 23:57    | Original absolute + stateful serving; probes `162748`, `162856`                                  | Was per-request history reset the root cause?                         | `162748`: 0/20; separate three-episode `162856` probe confirmed history commits                                                                                                                             | Not the sole root cause for this checkpoint. The paper-aligned serving fix remains.                                              |
| Jul 19 01:21    | Original absolute offline fit; `163529`                                                          | Does the checkpoint learn motion or mostly pose?                      | Predicted within-chunk motion about 5% of GT                                                                                                                                                                | Direct evidence of hold-collapse.                                                                                                |
| Jul 19 01:28    | DA3 verification; `163694`                                                                       | Is the backbone wrong, corrupt, or catastrophically drifted?          | Hash matched; depth sensible; measured drift small                                                                                                                                                          | Those backbone failure modes are ruled out. Adaptation sufficiency is not.                                                       |
| Jul 19 01:32    | GT absolute-action replay; `163699`                                                              | Is the gross dataset→environment action contract executable?          | Microwave success 2/5; early arm tracking about 0.7–1.6 mm                                                                                                                                                  | Gross layout/semantics/environment path validated; not a full data-quality proof.                                                |
| Jul 19 01:38    | Original absolute offline history H=1/3/7; `163701`                                              | Can action history recover the collapsed checkpoint?                  | Collapse metric unchanged                                                                                                                                                                                   | The dominant failure is training-side for this checkpoint.                                                                       |
| Jul 19 ~01:57   | Original absolute variance decomposition                                                         | Why is pose copying an easy optimum?                                  | Within-chunk motion = 2.3436% of normalized target variance                                                                                                                                                 | Quantifies DC dominance; do not relabel as literal loss contribution.                                                            |
| Jul 19 07:42    | Plain-delta C8; MLXP train `...f2fa677f`                                                         | Is the bottleneck itself degrading action fit?                        | Five non-`r_rot` blocks R2 0.21–0.58; `r_rot=-0.32`                                                                                                                                                         | Plain delta is the best measured variant, but right-arm rotation is especially poor.                                             |
| Jul 19 08:55    | Keypoint-delta C8; MLXP train `...d6810082`; eval `164105`, cancelled resume `164916`            | Do delta targets prevent collapse when using the keypoint bottleneck? | Motion restored; official results are 0/50 on each of assembly, hanoi, microwave, and photograph (0/200 total); unlock has no completed result. Offline block R2 includes `r_rot=-0.047` and tops at 0.435. | Delta prevents the original collapse, but this trained keypoint policy is inaccurate. No five-task success rate can be reported. |
| Jul 19 12:16    | Paper GAM checkpoint on LIBERO; `163863`, `163864`, EGL fixes `163953`, `163954`                 | Does a known-good GAM work through our LIBERO stack?                  | Earlier attempts 9/30; `163953` 24/30; final `163954` 30/30                                                                                                                                                 | Known-good GAM/LIBERO serving and evaluation work end-to-end after the EGL lifecycle fix.                                        |
| Jul 20 08:37    | LIBERO A/B/C representation ablation; `164909`–`164915`                                          | Can target representation be isolated in a common dataset/recipe?     | Incomplete; see live status below                                                                                                                                                                           | No closed-loop representation conclusion yet.                                                                                    |
| Jul 20 11:03    | Plain-delta closed-loop; eval `165003`                                                           | Does restored offline motion transfer to control?                     | Microwave 0/25; photograph 0/25                                                                                                                                                                             | Motion is necessary but insufficient; this checkpoint lacks control precision.                                                   |
| Jul 20 14:26    | In-house-box LIBERO Arm A, delta EEF C8, frozen DA3                                              | Is a reduced delta recipe sufficient?                                 | Training stopped at 4k of intended 12k; 0/30                                                                                                                                                                | Inconclusive and under the intended budget; does not disprove delta.                                                             |

Identifier corrections relative to the circulated table: the original training
suffix is `d5f717f1`, not `d5f7kklk`; plain delta is `f2fa677f`, not
`f2fabsfng`; and `164105`/`164916` are keypoint-delta evaluation jobs, not the
training job.

Exact MLXP training IDs:

- original absolute: `youngwoong-train-dexjoco-gam-bimanual-5tasks-224-20260-d5f717f1`;
- keypoint-v2 absolute: `youngwoong-train-dexjoco-gam-kpbottleneck-v2-bimanual-12ac7032`;
- plain delta: `youngwoong-train-dexjoco-gam-delta-c8-bimanual-5tasks-f2fa677f`;
- keypoint delta: `youngwoong-train-dexjoco-gam-kpbottleneck-delta-bimanu-d6810082`.

## 4. Live status at 2026-07-21 10:57 KST

| Workstream                       | Live status                                                                                                                                                                                   | Consequence                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Strong plain-delta retrain       | Corrected 90k MLXP job `...073a35ec` is **SUSPENDED**, with no pod, progress, or W&B run. The preceding 84k `...7a976798` failed before training because 10k save cadence did not divide 84k. | The proposed 150k instrumented retrain has not been launched. The suspended 90k job is not a substitute for the experiment plan below. |
| PhysiXel longer control          | Four-task 60k MLXP job `...5e98956f` is **RUNNING**; global batch 512, four GPUs, checkpoints every 20k.                                                                                      | Useful undertraining control, but it excludes unlock-iPad and is not yet evaluated.                                                    |
| PhysiXel five-task baseline eval | Resume `165872` is **PENDING** on two L40S GPUs; 212/750 episodes preserved, 0/15 result files complete.                                                                                      | There is still no fully evaluated five-task PhysiXel result.                                                                           |
| LIBERO A                         | Slurm `164910`/`164911` cancelled. Box A stopped at 4k and scored 0/30.                                                                                                                       | A is not a completed 12k control.                                                                                                      |
| LIBERO B absolute EEF            | Train `164912` pending after preemptions; partial log/checkpoint around step 1k. Eval `164913` waits on dependency.                                                                           | Do not say B never ran; do not call it finished.                                                                                       |
| LIBERO C absolute joint          | Train `164914` running after repeated preemptions; eval `164915` waits on dependency.                                                                                                         | The controlled ablation remains incomplete.                                                                                            |
| N1.6 / N1.7                      | Untracked config directories only; no matching MLXP or Slurm jobs.                                                                                                                            | Neither model contributes evidence yet.                                                                                                |

## 5. Exact answer: why did GAM + DexJoCo fail?

### Original absolute-target checkpoint

The evidence chain is coherent:

1. Absolute targets contain a large static-pose component across each short
   chunk; measured within-chunk motion is only 2.3436% of normalized variance.
2. The checkpoint achieves good absolute fit (`R2≈0.85`) while producing only
   about 5% of ground-truth motion (`magR≈0.05`). A DC-dominated metric can look
   healthy while the behavior holds.
3. Increasing history H=1/3/7 does not restore motion.
4. GT replay, DA3 integrity, and a paper LIBERO control eliminate several broad
   action-contract, backbone-corruption, and stack-failure alternatives.
5. Delta-target retraining restores predicted motion.

Therefore the original checkpoint failed by **absolute-target hold-collapse**.

### 30k plain-delta checkpoint

What is proven:

- Serving reconstruction is numerically consistent with the current loader.
- The model predicts nontrivial motion; it is not the same hold-collapse.
- Offline block accuracy is weak, with the right-arm EEF rotation block at
  `R2=-0.32`.
- Closed-loop microwave and photograph miss the required manipulation precision
  and score 0/50.

What is not proven:

- that component-wise rotvec delta is the cause;
- that 30k training length is the cause;
- that DA3 capacity/adaptation is the cause;
- that any single one of those changes will produce success.

Those are the hypotheses the next ladder must separate.

## 6. Reusable debugging module contract

Implement one reusable `DexJoCoDebugProbe` in the GAM training repository and
run it on a fixed held-out manifest at every saved checkpoint. The module must
write both W&B scalars and a versioned JSON artifact. Every artifact must include
the training commit, config hash, checkpoint hash/step, normalizer stats hash,
dataset manifest hash, random seed, task counts, and sample/window IDs.

Expose it through config rather than one-off scripts, with fields equivalent to
`enabled`, `manifest_path`, `every_n_steps`, `rotation_mode`, and `output_dir`.
It must support an offline checkpoint command as well as a trainer hook so the
same implementation is used for tiny overfit, A/Bs, and long-run checkpoints.

### Offline metrics

Report each scalar overall, per task, per dimension, and for the six blocks
`r_xyz`, `r_rot`, `r_hand`, `l_xyz`, `l_rot`, `l_hand`:

```text
r2_zero = 1 - sum((prediction - target)^2) / sum(target^2)
r2_centered = 1 - sum((prediction - target)^2) / sum((target - mean(target))^2)
magnitude_ratio = RMS(prediction) / RMS(target)
direction_cosine = dot(prediction, target) / (norm(prediction) * norm(target))
```

Also report normalized MAE/RMSE, sign agreement, prediction/target standard
deviation ratio, and metrics stratified by target-motion quantile. R2 is unstable
for low-variance slices, so it must never be the sole gate.

For rotation, report:

- component-wise rotvec q01/q99, raw range, normalized saturation/clipping rate,
  and branch-cut crossings near pi;
- reconstruction geodesic error after combining target delta with its anchor;
- prediction geodesic error (median/p90), direction cosine, magnitude ratio, and
  recall on high-rotation windows;
- both right and left rotation blocks, especially dimensions 3 and 25.

The rotation audit must name the convention explicitly. Compare the current
component-wise target with controller-consistent SO(3) candidates and their
matched inverses:

```text
current: rotvec(R_target) - rotvec(R_anchor)
body:    Log(R_anchor^T R_target); reconstruct R_anchor Exp(delta)
base:    Log(R_target R_anchor^T); reconstruct Exp(delta) R_anchor
```

Stage 1 must determine whether the environment/controller semantics call for
the body- or base-frame form before Stage 3 selects one candidate for A/B.

For optimization, report output-block gradient norms, DA3 gradient norms by
block, update-to-weight norms, learning rates, and non-finite counts.

For collapse detection, compare against the explicit zero-delta/hold baseline:

- predicted versus target within-chunk motion;
- hold-baseline and model L1/RMSE;
- fraction of windows where the model improves on hold;
- freeze rate and high-motion recall.

### Rollout metrics

Ground-truth actions are unavailable during normal closed-loop evaluation. Do
not log an "action/GT ratio" unless the rollout is explicitly replay-aligned.
Instead log per arm:

- commanded and realized translation/rotation magnitude;
- fraction of near-zero action chunks and visually static frames;
- end-effector-to-target and hand-to-object distances;
- contacts, grasp acquisition/loss, task-stage transitions, and timeout reason;
- normalizer saturation and server reconstruction/boundary counters.

Save a compact event trace and videos for every cheap-gate episode.

## 7. Gated experiment ladder

Each row has one claim, one controlled change, mandatory falsifying evidence,
and a gate. Thresholds below are operational launch gates, not established laws.

| Stage                             | Claim                                                                     | Controlled change                                                                                                                                | Required debug proof                                                                              | Gate / decision                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Freeze the benchmark           | Later differences are attributable                                        | Fixed held-out windows, task/seed manifest, config/checkpoint/stats hashes                                                                       | `DexJoCoDebugProbe` artifact is deterministic across two runs                                     | No training A/B starts until deterministic.                                                                                                              |
| 1. Rotation data audit            | Rotvec branch cuts or normalization damage rotation targets               | No model change; compare current component-wise delta with candidate group-relative SO(3) target and matched inverse                             | q01/q99/range, branch-cut rate, clipping, geodesic round trip, high-motion counts per arm/task    | Candidate must reconstruct numerically and materially reduce discontinuity/saturation without deleting real motion. Otherwise keep current target.       |
| 2. Motion-stratified tiny overfit | Full loader→normalizer→model→checkpoint→server path can learn every block | Overfit 1–5 episodes selected to contain substantial motion in all six blocks, especially `r_rot`                                                | Per-block R2/MAE/std ratio/direction/mag ratio, gradients, reload parity, rotation geodesic error | All blocks `r2_zero` and `r2_centered >0.95`, mag ratio near 1, and numerical reconstruction. Failure blocks a long run and identifies the broken layer. |
| 3. Rotation A/B                   | A group-relative SO(3) target improves rotation learning                  | Current component-wise rotvec delta versus group-relative SO(3); otherwise identical data, seed, C8, optimizer, steps, DA3 setting               | Both-arm rotation R2/geodesic/high-motion recall plus all nonrotation blocks                      | Adopt only if rotation improves clearly without material regression elsewhere. If not, reject the representation hypothesis.                             |
| 4. Adaptation-capacity A/B        | Current DA3 adaptation limits held-out precision                          | Current blocks 13–39 trainable versus a stronger adaptation setting; keep target/seed/steps fixed. Optional fully frozen arm is diagnostic only. | DA3 gradient/update norms, held-out per-block curves, validation loss, collapse metrics           | Stronger adaptation must materially improve held-out metrics, not only train loss. Otherwise retain current setting.                                     |
| 5. Training-length curve          | Best recipe is undertrained                                               | One continuous run with identical recipe and checkpoints at 30k/60k/90k/120k/150k                                                                | Fixed-manifest per-block curves, plateau detector, mag ratio, high-motion recall, gradient health | Proceed when every block clears the prespecified gate (initial proposal: R2 ≳0.8 and mag ratio 0.8–1.2) or stop if metrics plateau below it.             |
| 6. Cheap closed-loop gate         | Offline precision transfers to control                                    | Fixed 5 microwave + 5 photograph episodes                                                                                                        | Success plus rollout action/freeze/distance/contact/stage traces                                  | Require nonzero success and qualitative reduction in freeze/near-miss failures. This is only a launch gate, not efficacy evidence.                       |
| 7. Final evaluation               | Improvement is repeatable                                                 | Three training seeds; fixed full evaluation protocol                                                                                             | Per-seed success, confidence intervals, full offline probe artifacts                              | Consistent gain over the 0% GAM baseline and comparison with the matched PhysiXel evaluation.                                                            |

## 8. Launch prescription

Do **not** spend a 150k run until Stage 2 learns both rotation blocks through the
entire saved-checkpoint and serving path. Then:

1. Use the winning Stage-3 rotation target, or retain current rotvec delta if
   SO(3) does not win.
2. Keep C=8, delta-specific statistics, velocity loss, and motion metrics.
3. Treat DA3 blocks 13–39 trainable as the existing baseline; change adaptation
   only if Stage 4 supports it.
4. Train one 150k learning-curve run, checkpointing every 30k, rather than
   launching independent length runs.
5. Run the fixed offline probe at every checkpoint. Only submit the 5+5 cheap
   rollout after the offline gate passes.
6. Expand to a full three-seed evaluation only after nonzero cheap-gate success.

The LIBERO B/C ablation may continue in parallel, but it must not be used as a
substitute for the DexJoCo tiny-overfit, rotation, and precision gates.
