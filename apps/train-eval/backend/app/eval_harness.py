"""Eval-harness abstraction.

An eval job runs in one of two environments:
  - ``isaac``: Isaac Sim, driven by ``scripts/eval_allex.py`` against a GR00T
    policy server (``lib/eval_body.sh``).
  - ``dexjoco``: the DexJoCo MuJoCo benchmark, driven by ``dexjoco-openpi-eval``
    against either a GR00T or an openpi/pi0.5 policy server
    (``lib/eval_body_dexjoco.sh``).

Each harness owns the behavior that used to be scattered as
``if EVAL_HARNESS == "dexjoco"`` string checks: the entrypoint flag list shown
in the submit preview and the submit-time required-field validation. Eval
completion + progress probing hang off the same abstraction (see
``eval_completion.py`` / ``details.py``).

``harness_for(variant)`` selects the harness from the variant's model registry
entry (the model's eval body script, 1:1), defaulting to ``isaac``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from .dexjoco_rollout import rollout_for_variant
from .training_models import resolve_training_model

if TYPE_CHECKING:
    from .submit import SubmitRequest
    from .variants import Variant


def _first_task_row(variant: "Variant") -> tuple[str, str, str]:
    """The ``(short, task_name, instruction)`` of the variant's first TASKS row.

    Configs express every eval task — single or multi — as
    ``TASKS=("short|task_name|instruction" ...)``; the preview shows the first
    row's flags. Empty strings when TASKS is absent."""
    tasks = (getattr(variant, "arrays", {}) or {}).get("TASKS") or []
    if not tasks:
        return "", "", ""
    parts = tasks[0].split("|", 2)
    parts += [""] * (3 - len(parts))
    return parts[0], parts[1], parts[2]


class EvalHarness(ABC):
    """Strategy for one eval environment."""

    name: str

    @abstractmethod
    def eval_flags(self, variant: "Variant") -> list[tuple[str, str]]:
        """The ``(flag, value)`` list the eval entrypoint receives.

        Mirrors the harness's ``lib/eval_body*.sh`` client invocation so the
        submit preview shows the flags the body would actually emit.
        """

    @abstractmethod
    def progress_probe(self, *, eval_dir_expr: str, log_dir_q: str, job_id_q: str) -> str:
        """Remote bash printing this harness's whitespace-separated live-progress
        counters. ``*_expr``/``*_q`` args are already shell-quoted by the caller."""

    @abstractmethod
    def parse_progress(self, probe_stdout: str, *, n_eps: int) -> tuple[int, int]:
        """``(completed_runs, current_episodes)`` from the probe output.

        ``current_episodes`` already folds in every live signal this harness
        uses; the caller clamps it to ``max_steps``. No cross-harness signals.
        """

    def validate_submit(self, req: "SubmitRequest", variant: "Variant") -> None:
        """Raise ``ValueError`` if a harness-required submit field is missing.

        Default: the harness has no extra required field.
        """
        return None


class IsaacHarness(EvalHarness):
    name = "isaac"

    def eval_flags(self, variant: "Variant") -> list[tuple[str, str]]:
        v = variant
        _short, task_name, instruction = _first_task_row(v)
        return [
            ("--task-name", task_name),
            ("--instruction", instruction),
            ("--n-episodes", v.vars.get("N_EPISODES", "")),
            ("--n-runs", v.vars.get("N_RUNS", "")),
            ("EVAL_NUM_ENVS_PER_GPU", "1"),
            ("--execution-horizon", v.vars.get("EXECUTION_HORIZON", "")),
            ("--max-episode-steps", v.vars.get("MAX_EPISODE_STEPS", "")),
            ("(eval_sets)", " ".join(v.arrays.get("EVAL_SETS") or [])),
        ]

    def progress_probe(self, *, eval_dir_expr: str, log_dir_q: str, job_id_q: str) -> str:
        # Finished runs (results.json) + buffered per-episode videos + the
        # in-flight run's client-stdout episode/run markers.
        return (
            f"eval_dir={eval_dir_expr}; log_dir={log_dir_q}; job_id={job_id_q}; "
            'completed=$(find "$eval_dir" -type f -path "*/run_*/results.json" 2>/dev/null | wc -l); '
            "video_eps=$(find \"$eval_dir\" -type f -path '*/videos/ep*.mp4' 2>/dev/null | wc -l); "
            'pattern="$log_dir"/*_"$job_id".out; '
            "stdout_eps=$(grep -h '^Episode .* completed' $pattern 2>/dev/null | wc -l); "
            "stdout_runs=$(grep -h '^Results saved to:' $pattern 2>/dev/null | wc -l); "
            "printf '%s %s %s %s\\n' \"$completed\" \"$stdout_eps\" \"$stdout_runs\" \"$video_eps\""
        )

    def parse_progress(self, probe_stdout: str, *, n_eps: int) -> tuple[int, int]:
        parts = probe_stdout.strip().split()
        if len(parts) != 4:
            raise ValueError(f"invalid isaac progress probe output: {probe_stdout.strip()!r}")
        completed, stdout_eps, stdout_runs, video_eps = (int(p) for p in parts)
        completed_steps = completed * n_eps
        # Prefer client stdout (native Isaac vectorization finishes several envs
        # per server reset); subtract already-counted finished runs.
        stdout_incomplete = min(n_eps, max(0, stdout_eps - stdout_runs * n_eps)) if n_eps > 0 else 0
        current_eps = max(completed_steps + stdout_incomplete, video_eps)
        return completed, current_eps


class DexjocoHarness(EvalHarness):
    name = "dexjoco"

    def eval_flags(self, variant: "Variant") -> list[tuple[str, str]]:
        v = variant
        rollout = rollout_for_variant(v)
        _short, task_name, _instr = _first_task_row(v)
        return [
            ("--task", task_name),
            ("--server", v.vars.get("DEXJOCO_SERVER_TYPE", "groot")),
            ("(families)", " ".join(v.arrays.get("EVAL_SETS") or [])),
            ("--episodes", v.vars.get("N_EPISODES", "")),
            ("--n-runs", v.vars.get("N_RUNS", "")),
            ("--seed", v.vars.get("EVAL_BASE_SEED", "")),
            ("--inference-mode", rollout.inference_mode),
            ("--action-horizon", rollout.action_horizon),
            ("--replan-ratio", rollout.replan_ratio),
            ("--checkpoint", "<eval-checkpoint>"),
        ]

    def validate_submit(self, req: "SubmitRequest", variant: "Variant") -> None:
        rollout_for_variant(variant)
        # The task can come from the submit request (UI picker) or from the
        # variant's own TASKS rows (config.sh). Every dexjoco config now ships at
        # least one TASKS row (the __single__ sentinel for single-task variants),
        # which is what lets retries / programmatic resubmits work without
        # re-specifying the task.
        task = (getattr(req, "dexjoco_task", None) or "").strip()
        has_task_row = bool((variant.arrays or {}).get("TASKS"))
        if not task and not has_task_row:
            raise ValueError("dexjoco_task is required for DexJoCo evals")

    def progress_probe(self, *, eval_dir_expr: str, log_dir_q: str, job_id_q: str) -> str:
        # DexJoCo writes one episode_NN_<success|failure> dir per finished
        # episode (episode_NN_temp is the in-flight one) and a results.json per
        # finished run. The episode dirs are the only live mid-run signal.
        return (
            f"eval_dir={eval_dir_expr}; "
            'completed=$(find "$eval_dir" -type f -path "*/run_*/results.json" 2>/dev/null | wc -l); '
            "episode_dirs=$(find \"$eval_dir\" -type d 2>/dev/null | grep -cE '/episode_[0-9]+_(success|failure)(_|$)'); "
            "printf '%s %s\\n' \"$completed\" \"$episode_dirs\""
        )

    def parse_progress(self, probe_stdout: str, *, n_eps: int) -> tuple[int, int]:
        parts = probe_stdout.strip().split()
        if len(parts) != 2:
            raise ValueError(f"invalid dexjoco progress probe output: {probe_stdout.strip()!r}")
        completed, episode_dirs = int(parts[0]), int(parts[1])
        current_eps = max(completed * n_eps, episode_dirs) if n_eps > 0 else episode_dirs
        return completed, current_eps


DEFAULT_HARNESS = "isaac"
_HARNESSES: dict[str, EvalHarness] = {
    harness.name: harness for harness in (IsaacHarness(), DexjocoHarness())
}


def harness_for_name(name: str | None) -> EvalHarness:
    """Select the eval harness by name (e.g. from job metadata); default isaac."""
    key = (name or DEFAULT_HARNESS).strip().lower()
    return _HARNESSES.get(key, _HARNESSES[DEFAULT_HARNESS])


def harness_for(variant: "Variant") -> EvalHarness:
    """Select the eval harness for ``variant`` from its model registry entry.

    The harness follows 1:1 from the model's eval body script
    (``configs/models/<MODEL_ID>.env``); the legacy per-config ``EVAL_HARNESS``
    var is only consulted when the MODEL_ID can't be resolved."""
    try:
        name: str | None = resolve_training_model(variant).harness
    except Exception:
        name = variant.vars.get("EVAL_HARNESS")
    return harness_for_name(name)
