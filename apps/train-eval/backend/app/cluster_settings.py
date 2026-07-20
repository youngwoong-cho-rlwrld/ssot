"""User-editable cluster environment settings.

Repo cluster env files are templates. The effective, user-specific env text is
saved outside git under ~/.train-eval-web/clusters/<cluster>.env.

Cluster env holds the owner's personal cluster identity (SSH_ALIAS, REPO_ROOT
under their home, LOG_DIR, …), so it is per-user like the other settings:

- Owner (TRAIN_EVAL_OWNER_EMAIL) and header-absent requests (poller,
  notifications monitor, legacy copy, direct curl) read/write the flat GLOBAL
  files — their view IS the machine config. Background machinery always runs
  header-absent (the poller resets the user contextvar at entry), so it stays
  on the global env.
- An identified NON-OWNER reads/writes their own overlay under
  ~/.train-eval-web/users/<slug>/clusters/<cluster>.env. When they have no
  overlay yet, reads return a SCAFFOLD: the same clusters and env var KEYS as
  global with every VALUE blanked (the key set is app contract; the values are
  personal and must not leak). They must configure before they can submit.
"""

from __future__ import annotations

import re
import shlex
from pathlib import Path

from pydantic import BaseModel, Field

from . import user_context
from .paths import CLUSTERS_DIR


_SETTINGS_DIR = Path.home() / ".train-eval-web" / "clusters"
_BUILTIN_CLUSTER_ORDER = ("kakao", "skt", "mlxp")


class ClusterEnvSettings(BaseModel):
    name: str
    env_text: str
    path: str | None = None
    # Additive: "user" when resolved from the caller's overlay/scaffold, else
    # "global". Additive-only for the gateway UI; existing consumers ignore it.
    scope: str | None = None


class ClusterEnvSettingsUpdate(BaseModel):
    env_text: str = Field(default="")


def list_cluster_names() -> list[str]:
    names = set(_BUILTIN_CLUSTER_ORDER)
    names.update(p.stem for p in CLUSTERS_DIR.glob("*.env") if p.is_file())
    return sorted(names, key=lambda n: (_order(n), n))


def list_settings() -> list[ClusterEnvSettings]:
    return [get_settings(name) for name in list_cluster_names()]


def get_settings(name: str) -> ClusterEnvSettings:
    _validate_name(name)
    if _use_overlay():
        overlay = _overlay_dir() / f"{name}.env"
        if overlay.is_file():
            return ClusterEnvSettings(
                name=name, env_text=overlay.read_text(), path=str(overlay), scope="user"
            )
        # No overlay yet: scaffold the global key set with blanked values so no
        # owner path leaks. path=None marks it as not-yet-configured.
        global_text, _ = _read_global(name)
        return ClusterEnvSettings(
            name=name, env_text=_scaffold_from(global_text), path=None, scope="user"
        )
    text, path = _read_global(name)
    return ClusterEnvSettings(name=name, env_text=text, path=path, scope="global")


def save_settings(name: str, env_text: str) -> ClusterEnvSettings:
    _validate_name(name)
    normalized = env_text.rstrip() + ("\n" if env_text.strip() else "")
    # Owner/header-absent -> flat global file; non-owner -> their overlay.
    user_context.atomic_write(_effective_saved_path(name), normalized)
    return get_settings(name)


def load_env_text(name: str) -> str:
    return get_settings(name).env_text


_ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


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
    """Best-effort parser for simple export/KEY=value env files.

    Slurm runtime still uses bash sourcing for exact semantics. This parser is
    only for sync settings like MLXP config fields and the training-model
    registry. With ``validate_keys`` set, lines whose key is not a valid shell
    identifier are skipped (otherwise any non-empty key is accepted).
    """
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


def _validate_name(name: str) -> None:
    if name not in list_cluster_names():
        raise FileNotFoundError(f"unknown cluster {name}")


def _use_overlay() -> bool:
    """True when the caller is an identified non-owner: they operate on their
    own cluster overlay. Owner and header-absent callers use the flat global
    files (their view is the machine config)."""
    return (
        user_context.current_user_slug() is not None
        and not user_context.is_owner_request()
    )


def _overlay_dir() -> Path:
    """Per-user cluster overlay dir. Only call when _use_overlay() is true (a
    non-owner request), where user_settings_dir() is never None."""
    base = user_context.user_settings_dir()
    assert base is not None  # guaranteed by _use_overlay()
    return base / "clusters"


def _effective_saved_path(name: str) -> Path:
    if _use_overlay():
        return _overlay_dir() / f"{name}.env"
    return _global_saved_path(name)


def _read_global(name: str) -> tuple[str, str | None]:
    """The global (owner/machine) view: saved global file if present, else the
    repo template, else empty."""
    saved = _global_saved_path(name)
    if saved.is_file():
        return saved.read_text(), str(saved)
    template = _template_path(name)
    if template.is_file():
        return template.read_text(), str(template)
    return "", None


def _scaffold_from(global_text: str) -> str:
    """Blank-value scaffold: one ``KEY=`` (or ``export KEY=``) per assignment
    key found in ``global_text``, in first-seen order, with all values AND
    comments dropped so no owner value can leak through the response body."""
    lines: list[str] = []
    seen: set[str] = set()
    for raw in global_text.splitlines():
        s = raw.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        exported = s.startswith("export ")
        body = s[len("export "):] if exported else s
        key = body.split("=", 1)[0].strip()
        if not key or key in seen:
            continue
        seen.add(key)
        lines.append(f"{'export ' if exported else ''}{key}=")
    return ("\n".join(lines) + "\n") if lines else ""


def _global_saved_path(name: str) -> Path:
    return _SETTINGS_DIR / f"{name}.env"


def _template_path(name: str) -> Path:
    return CLUSTERS_DIR / f"{name}.env"


def _order(name: str) -> int:
    try:
        return _BUILTIN_CLUSTER_ORDER.index(name)
    except ValueError:
        return len(_BUILTIN_CLUSTER_ORDER)
