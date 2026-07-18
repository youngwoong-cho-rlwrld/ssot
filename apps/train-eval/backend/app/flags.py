"""Render the exact flag list a job's training/eval entrypoint receives.

The body scripts in `lib/` are the source of truth — this module mirrors
their flag set so the UI can show the same list of flags the body would
actually emit for a given variant. If you change lib/train_body*.sh,
update the corresponding builder here.
"""
from __future__ import annotations



from .eval_harness import harness_for
from .train_overrides import DEFAULT_TRAIN_NUM_WORKERS
from .training_models import resolve_training_model
from .variants import Variant
from .wandb_config import get_project


def serialize_flags(out: list[tuple[str, str]]) -> list[dict[str, str]]:
    """Serialize a [(flag, value), ...] list to the API's flag-dict shape."""
    return [{"flag": f, "value": val} for f, val in out]


def flags_for(variant: Variant, phase: str) -> list[tuple[str, str]]:
    """Return [(flag, value), ...] for the variant's entrypoint.

    Pseudo-values like `<job-name>` mark fields the submitter fills in at
    submit time rather than reading from the variant.
    """
    if phase in ("train", "resume"):
        model = resolve_training_model(variant).flags_profile
        if model == "n1.7":
            return _train_n17(variant)
        if model == "n1.6":
            return _train_n16(variant)
        if model == "n1.5":
            return _train_n15(variant)
    if phase == "eval":
        return harness_for(variant).eval_flags(variant)
    return []


# ── train ─────────────────────────────────────────────────────────────

def _train_n15(v: Variant) -> list[tuple[str, str]]:
    """scripts/gr00t_finetune.py — N1.5 training, called from train_body.sh."""
    return [
        ("--num-gpus", v.vars.get("TRAIN_NUM_GPUS", "")),
        ("--batch-size", v.vars.get("TRAIN_BATCH_SIZE", "")),
        ("--learning_rate", "1e-4"),
        ("--output-dir", "$EXP_DIR/checkpoints/$SUBMIT_OUTPUT_NAMESPACE"),
        ("--data-config", "$EXP_DIR/data_config.yaml"),
        ("--max-steps", v.vars.get("MAX_STEPS", "")),
        ("--save-steps", v.vars.get("SAVE_STEPS", "")),
        ("--dataloader_num_workers", v.vars.get("TRAIN_NUM_WORKERS", str(DEFAULT_TRAIN_NUM_WORKERS))),
        ("--dataloader-prefetch-factor", "10"),
        ("--video-backend", "torchcodec"),
        ("--resume", "(if checkpoint exists)"),
        ("--report-to", "wandb"),
        ("--pin_memory", ""),
        ("--run_name", "<job-name>"),
        ("--seed", "42"),
        *[(a, "") for a in (v.arrays.get("TRAIN_EXTRA_ARGS") or [])],
    ]


def _train_n16(v: Variant) -> list[tuple[str, str]]:
    """gr00t/experiment/launch_finetune.py — N1.6 training."""
    global_batch = v.vars.get("TRAIN_GLOBAL_BATCH_SIZE") or v.vars.get("GLOBAL_BATCH_SIZE") or ""
    if not global_batch:
        try:
            nb = int(v.vars.get("TRAIN_NUM_GPUS", "0")) * int(v.vars.get("TRAIN_BATCH_SIZE", "0"))
            global_batch = str(nb) if nb > 0 else ""
        except ValueError:
            global_batch = ""
    names = v.arrays.get("TRAIN_DATASET_NAMES") or (
        [v.vars["DATASET_NAME"]] if "DATASET_NAME" in v.vars else []
    )
    dataset_paths = " ".join(f"$DATA_DIR/{n}" for n in names)
    modality_file = v.vars.get("TRAIN_MODALITY_CONFIG", "")
    out: list[tuple[str, str]] = [
        ("--base-model-path", "nvidia/GR00T-N1.6-3B"),
        ("--dataset-path", dataset_paths),
        ("--embodiment-tag", "NEW_EMBODIMENT"),
        ("--modality-config-path", f"$EXP_DIR/{modality_file}" if modality_file else ""),
        ("--num-gpus", v.vars.get("TRAIN_NUM_GPUS", "")),
        ("--output-dir", "$EXP_DIR/checkpoints"),
        ("--global-batch-size", global_batch),
        ("--learning-rate", "1e-4"),
        ("--max-steps", v.vars.get("MAX_STEPS", "")),
        ("--save-steps", v.vars.get("SAVE_STEPS", "")),
        ("--save-total-limit", "5"),
        ("--dataloader-num-workers", v.vars.get("TRAIN_NUM_WORKERS", str(DEFAULT_TRAIN_NUM_WORKERS))),
        ("--experiment-name", "<output-namespace>"),
        ("--use-wandb", ""),
        ("--color-jitter-params", "brightness 0.2 contrast 0.2 saturation 0.2 hue 0.1"),
    ]
    out.append(("--wandb-project", get_project()))
    out.extend((a, "") for a in (v.arrays.get("TRAIN_EXTRA_ARGS") or []))
    return out


def _train_n17(v: Variant) -> list[tuple[str, str]]:
    """gr00t/experiment/launch_finetune{,_multi}.py — N1.7 training.

    Two launchers share this preview. A variant that carries TRAIN_DATA_YAML
    trains multi-dataset via launch_finetune_multi.py (--data-yaml, plus an
    optional --action-horizon); otherwise it trains single-dataset via
    launch_finetune.py (--dataset-path singular + --modality-config-path, no
    --action-horizon). The base model is always passed explicitly because the
    single launcher requires it and the multi launcher would otherwise default
    to the 2B checkpoint.
    """
    global_batch = v.vars.get("TRAIN_GLOBAL_BATCH_SIZE") or v.vars.get("GLOBAL_BATCH_SIZE") or ""
    if not global_batch:
        try:
            nb = int(v.vars.get("TRAIN_NUM_GPUS", "0")) * int(v.vars.get("TRAIN_BATCH_SIZE", "0"))
            global_batch = str(nb) if nb > 0 else ""
        except ValueError:
            global_batch = ""
    data_yaml = (v.vars.get("TRAIN_DATA_YAML") or "").strip()

    out: list[tuple[str, str]] = [("--base-model-path", "nvidia/GR00T-N1.7-3B")]
    if data_yaml:
        out.append(("--data-yaml", f"$EXP_DIR/{data_yaml}"))
    else:
        names = v.arrays.get("TRAIN_DATASET_NAMES") or (
            [v.vars["DATASET_NAME"]] if "DATASET_NAME" in v.vars else []
        )
        # launch_finetune.py takes a single --dataset-path.
        out.append(("--dataset-path", f"$DATA_DIR/{names[0]}" if names else ""))
        out.append(("--embodiment-tag", "NEW_EMBODIMENT"))
        modality_file = v.vars.get("TRAIN_MODALITY_CONFIG", "")
        out.append(
            ("--modality-config-path", f"$EXP_DIR/{modality_file}" if modality_file else "")
        )
    out.extend([
        ("--num-gpus", v.vars.get("TRAIN_NUM_GPUS", "")),
        ("--output-dir", "$EXP_DIR/checkpoints"),
        ("--global-batch-size", global_batch),
        ("--learning-rate", "1e-4"),
        ("--max-steps", v.vars.get("MAX_STEPS", "")),
        ("--save-steps", v.vars.get("SAVE_STEPS", "")),
        ("--save-total-limit", "5"),
        ("--dataloader-num-workers", v.vars.get("TRAIN_NUM_WORKERS", str(DEFAULT_TRAIN_NUM_WORKERS))),
        ("--experiment-name", "<output-namespace>"),
        ("--use-wandb", ""),
        ("--wandb-project", get_project()),
        ("--color-jitter-params", "brightness 0.2 contrast 0.2 saturation 0.2 hue 0.1"),
    ])
    # --action-horizon exists only on the multi launcher (MultiFinetuneConfig).
    if data_yaml and v.vars.get("TRAIN_ACTION_HORIZON"):
        out.append(("--action-horizon", v.vars["TRAIN_ACTION_HORIZON"]))
    out.extend((a, "") for a in (v.arrays.get("TRAIN_EXTRA_ARGS") or []))
    return out
