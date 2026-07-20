"""Per-user cluster environment settings stored in SSOT SQLite."""
from __future__ import annotations

import re
import shlex

from pydantic import BaseModel, Field

from . import settings_db


class ClusterEnvSettings(BaseModel):
    name: str
    env_text: str
    path: str | None = None
    scope: str | None = None


class ClusterEnvSettingsUpdate(BaseModel):
    env_text: str = Field(default="")


_CLUSTER_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _stored_clusters() -> list[dict]:
    clusters = settings_db.get_namespace("train-eval").get("clusters")
    if not isinstance(clusters, list):
        return []
    return [item for item in clusters if isinstance(item, dict)]


def list_cluster_names() -> list[str]:
    names = {
        str(item.get("name", "")).strip()
        for item in _stored_clusters()
        if _valid_name(str(item.get("name", "")).strip())
    }
    return sorted(names)


def list_settings() -> list[ClusterEnvSettings]:
    return [get_settings(name) for name in list_cluster_names()]


def get_settings(name: str) -> ClusterEnvSettings:
    _validate_name(name)
    for item in _stored_clusters():
        if item.get("name") != name:
            continue
        env_text = item.get("env_text")
        if not isinstance(env_text, str):
            env_text = _serialize_env(item.get("env"))
        return ClusterEnvSettings(
            name=name,
            env_text=env_text,
            path=None,
            scope="user",
        )
    raise FileNotFoundError(f"cluster {name} is not configured")


def save_settings(name: str, env_text: str) -> ClusterEnvSettings:
    _validate_name(name)
    parsed = parse_env_text(env_text, validate_keys=True)
    assignment_lines = [
        line
        for line in env_text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if len(parsed) != len(assignment_lines):
        raise ValueError("cluster settings must contain only literal KEY=value lines")
    normalized = _serialize_env(parsed)
    replacement = {"name": name, "env_text": normalized}

    def replace(current: object) -> list[dict]:
        clusters = [item for item in current if isinstance(item, dict)] if isinstance(current, list) else []
        for index, item in enumerate(clusters):
            if item.get("name") == name:
                clusters[index] = replacement
                break
        else:
            clusters.append(replacement)
        return clusters

    settings_db.mutate_key("train-eval", "clusters", replace)
    return get_settings(name)


def load_env_text(name: str) -> str:
    return get_settings(name).env_text


def parse_env_value(raw: str) -> str:
    """Best-effort unquote of a single env-file assignment value."""
    if not raw:
        return ""
    try:
        parts = shlex.split(raw, comments=False, posix=True)
        if len(parts) == 1:
            return parts[0]
    except ValueError:
        pass
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"'):
        return raw[1:-1]
    return raw


def parse_env_text(text: str, *, validate_keys: bool = False) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        if validate_keys:
            if not _ENV_KEY_RE.fullmatch(key):
                continue
        elif not key:
            continue
        out[key] = parse_env_value(value.strip())
    return out


def _serialize_env(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    lines: list[str] = []
    for key, raw in value.items():
        key = str(key)
        if not _ENV_KEY_RE.fullmatch(key):
            continue
        lines.append(f"{key}={shlex.quote(str(raw))}")
    return ("\n".join(lines) + "\n") if lines else ""


def _valid_name(name: str) -> bool:
    return bool(_CLUSTER_NAME_RE.fullmatch(name))


def _validate_name(name: str) -> None:
    if not _valid_name(name):
        raise FileNotFoundError(f"invalid cluster {name}")
