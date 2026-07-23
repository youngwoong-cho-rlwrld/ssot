"""Default scheduler resource requests for submitted jobs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class SlurmResources:
    cpus_per_task: int
    memory: str


_SKT_RLWRLD_GPU_TRAIN: dict[int, SlurmResources] = {
    1: SlurmResources(cpus_per_task=22, memory="250G"),
    2: SlurmResources(cpus_per_task=44, memory="500G"),
    4: SlurmResources(cpus_per_task=88, memory="1000G"),
    7: SlurmResources(cpus_per_task=154, memory="1700G"),
    8: SlurmResources(cpus_per_task=176, memory="0"),
}

_SKT_L40S_GPU_TRAIN: dict[int, SlurmResources] = {
    1: SlurmResources(cpus_per_task=12, memory="90G"),
    2: SlurmResources(cpus_per_task=24, memory="180G"),
    3: SlurmResources(cpus_per_task=36, memory="270G"),
    4: SlurmResources(cpus_per_task=44, memory="350G"),
}

_SLURM_TRAIN_FALLBACK = SlurmResources(cpus_per_task=16, memory="180G")
_SLURM_EVAL_DEFAULT = SlurmResources(cpus_per_task=4, memory="40G")

# Clusters whose slurmctld runs a job_submit filter that forbids explicit
# --cpus-per-task / --mem (and --cpus-per-gpu / --mem-per-gpu / --mem-per-cpu) on
# GPU partitions and auto-applies the partition per-GPU defaults (DefCpuPerGPU /
# DefMemPerGPU). Submissions to these clusters must carry no CPU/memory flags.
# This is a per-cluster policy, overridable per cluster via the env flag
# SLURM_PARTITION_DEFAULTS_ONLY (1/0) when a cluster's filter is added or removed.
_PARTITION_DEFAULTS_ONLY_CLUSTERS = frozenset({"kakao", "skt"})
_TRUTHY = {"1", "true", "yes", "on"}


def cluster_enforces_partition_defaults(cluster: str, env_flag: str | None = None) -> bool:
    """Whether the cluster's slurmctld rejects explicit CPU/memory sbatch flags.

    An explicit SLURM_PARTITION_DEFAULTS_ONLY value in the cluster env wins;
    otherwise fall back to the known-cluster default so a submission works
    without extra configuration.
    """
    flag = (env_flag or "").strip().lower()
    if flag:
        return flag in _TRUTHY
    return cluster.strip().lower() in _PARTITION_DEFAULTS_ONLY_CLUSTERS


def _eval_resources(num_gpus: int, n_envs_per_gpu: int) -> SlurmResources:
    """Scale the eval request with the number of concurrent sim workers.

    Each DexJoCo worker is a single-threaded MuJoCo client (physics + EGL
    render thread + light inference process) plus a policy server, so budget
    2 CPUs and 10G per sim, floored at the historical 4-CPU/40G request.
    """
    sims = max(1, num_gpus) * max(1, n_envs_per_gpu)
    return SlurmResources(
        cpus_per_task=max(_SLURM_EVAL_DEFAULT.cpus_per_task, 2 * sims),
        memory=f"{max(40, 10 * sims)}G",
    )


def slurm_resources_for(
    *,
    cluster: str,
    partition: str,
    phase: Literal["train", "eval"],
    num_gpus: int,
    n_envs_per_gpu: int = 1,
    env_flag: str | None = None,
) -> SlurmResources | None:
    """Resource request for the sbatch command, or None to send no flags.

    Clusters whose slurmctld enforces partition-default CPU/memory (kakao and
    skt) reject explicit --cpus-per-task / --mem ("파티션 기본값(DefCpuPerGPU)이
    자동 적용됩니다") and derive CPU/memory from the partition per-GPU defaults, so
    their submissions must carry no resource flags at all. `env_flag` is the
    cluster's SLURM_PARTITION_DEFAULTS_ONLY override.
    """
    if cluster_enforces_partition_defaults(cluster, env_flag):
        return None

    if phase == "eval":
        return _eval_resources(num_gpus, n_envs_per_gpu)

    cluster_key = cluster.strip().lower()
    partition_key = partition.strip().lower()
    if cluster_key == "skt" and partition_key == "rlwrld-gpu":
        return _SKT_RLWRLD_GPU_TRAIN.get(num_gpus, _SLURM_TRAIN_FALLBACK)
    if cluster_key == "skt" and partition_key == "l40s-gpu":
        return _SKT_L40S_GPU_TRAIN.get(num_gpus, _SLURM_TRAIN_FALLBACK)
    return _SLURM_TRAIN_FALLBACK
