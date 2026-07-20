"""Cluster discovery and literal environment parsing from SSOT SQLite."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess

from pydantic import BaseModel

from . import cluster_settings


def _find_bash() -> str:
    candidates = [
        os.environ.get("TRAIN_EVAL_BASH"),
        "/opt/homebrew/bin/bash",
        "/usr/local/bin/bash",
        shutil.which("bash"),
    ]
    for candidate in candidates:
        if candidate and _bash_version(candidate) >= 4:
            return candidate
    raise RuntimeError("bash >= 4 required")


def _bash_version(path: str) -> int:
    try:
        output = subprocess.check_output(
            [path, "-c", "echo $BASH_VERSINFO"], text=True
        )
        return int(output.split()[0])
    except Exception:
        return 0


_BASH = _find_bash()


def _bash_unescape(value: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(value):
        if value[index] == "\\" and index + 1 < len(value):
            out.append(value[index + 1])
            index += 2
        else:
            out.append(value[index])
            index += 1
    return "".join(out)


class ClusterEnv(BaseModel):
    name: str
    vars: dict[str, str]

    @property
    def ssh_alias(self) -> str:
        return (self.vars.get("SSH_ALIAS") or "").strip()


def list_clusters() -> list[str]:
    return cluster_settings.list_cluster_names()


def cache_fingerprints() -> dict[str, str]:
    """Stable cache identity for each configured cluster."""
    return {
        name: hashlib.sha256(
            cluster_settings.load_env_text(name).encode("utf-8")
        ).hexdigest()
        for name in list_clusters()
    }


async def load_cluster(name: str) -> ClusterEnv:
    text = cluster_settings.load_env_text(name)
    if not text.strip():
        raise FileNotFoundError(f"Cluster env for {name} is not configured")
    vars = cluster_settings.parse_env_text(text, validate_keys=True)
    if name != "mlxp":
        missing = [
            key
            for key in ("SSH_ALIAS", "PARTITION", "LOG_DIR", "DATA_DIR")
            if not vars.get(key)
        ]
        if missing:
            raise FileNotFoundError(
                f"Cluster env for {name} is missing required values: {', '.join(missing)}"
            )
    return ClusterEnv(name=name, vars=vars)
