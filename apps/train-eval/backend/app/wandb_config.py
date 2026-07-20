"""Persisted wandb settings.

We store the wandb project name in ~/.train-eval-web/wandb.json so the
backend, the body script renderer, and the URL builder all agree on
where the runs live. The TRAIN_EVAL_WEB_WANDB_PROJECT env var still
wins over the saved value when present.
"""
from __future__ import annotations


import json
import os
from pathlib import Path

from . import user_context

DEFAULT_PROJECT = "my project"
_SETTINGS_DIR = Path.home() / ".train-eval-web"
_FILENAME = "wandb.json"
_SETTINGS_FILE = _SETTINGS_DIR / _FILENAME

# Wandb identity overrides:
#   - entity: wandb.Api().default_entity after `wandb login` on this laptop is
#     used by default; this env var forces a specific entity.
#   - workspace: the browser workspace selector for the entity.
WANDB_ENTITY_OVERRIDE = os.environ.get("TRAIN_EVAL_WEB_WANDB_ENTITY")
WANDB_WORKSPACE_OVERRIDE = os.environ.get("TRAIN_EVAL_WEB_WANDB_WORKSPACE")


def _read_file(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _load() -> dict:
    return _read_file(_SETTINGS_FILE)


def _save(data: dict) -> None:
    """Persist via the owner-gated write policy: a per-user save writes only
    that user's overlay; the flat global file is written for header-absent
    requests and for the machine owner. See user_context.save_settings_file."""
    user_context.save_settings_file(_FILENAME, json.dumps(data, indent=2))


def _effective_file() -> tuple[Path, str]:
    """The file governing this request and its scope: per-user overlay when
    present, else the flat global file."""
    overlay = user_context.overlay_file(_FILENAME)
    if overlay is not None and overlay.is_file():
        return overlay, "user"
    return _SETTINGS_FILE, "global"


def get_project() -> str:
    """Env var > per-user overlay (when present) > flat global file > default."""
    env = os.environ.get("TRAIN_EVAL_WEB_WANDB_PROJECT")
    if env:
        return env
    path, _ = _effective_file()
    return _read_file(path).get("project") or DEFAULT_PROJECT


def project_scope() -> str:
    """"user" when the effective project comes from a per-user overlay, else
    "global". Reflects the file source; an env-var override reads as global."""
    if os.environ.get("TRAIN_EVAL_WEB_WANDB_PROJECT"):
        return "global"
    _, scope = _effective_file()
    return scope


def set_project(name: str) -> None:
    data = _load()
    data["project"] = name.strip()
    _save(data)
