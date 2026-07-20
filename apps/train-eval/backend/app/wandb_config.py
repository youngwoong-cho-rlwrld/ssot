"""Per-user Weights & Biases settings stored in SSOT SQLite."""
from __future__ import annotations

from . import settings_db

DEFAULT_PROJECT = ""
WANDB_ENTITY_OVERRIDE = None
WANDB_WORKSPACE_OVERRIDE = None


def _settings() -> dict:
    value = settings_db.get_namespace("train-eval").get("wandb")
    return value if isinstance(value, dict) else {}


def get_project() -> str:
    value = _settings().get("project")
    return value.strip() if isinstance(value, str) else ""


def get_api_key() -> str:
    value = _settings().get("api_key")
    return value.strip() if isinstance(value, str) else ""


def project_scope() -> str:
    return "user"


def set_project(name: str) -> None:
    settings_db.update_section("train-eval", "wandb", {"project": name.strip()})


def set_api_key(key: str) -> None:
    settings_db.update_section("train-eval", "wandb", {"api_key": key.strip()})
