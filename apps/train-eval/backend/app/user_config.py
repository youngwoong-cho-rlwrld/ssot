"""Persisted user identity settings.

We store the username in ~/.train-eval-web/user.json so default job names
carry a per-user prefix (e.g. youngwoong_train_...). Empty means no prefix.
The TRAIN_EVAL_WEB_USERNAME env var wins over the saved value.
"""
from __future__ import annotations


import json
import os
import re
from pathlib import Path

from pydantic import BaseModel

from . import user_context

_SETTINGS_DIR = Path.home() / ".train-eval-web"
_FILENAME = "user.json"
_SETTINGS_FILE = _SETTINGS_DIR / _FILENAME

# The username lands in slurm job names, wandb run ids, and staging paths,
# so keep it to scheduler/path-safe characters. Phase keywords are reserved:
# job_identity.parse_phase_and_variant keys on the first train/eval/resume
# token, so a username containing one would misparse every job it prefixes.
_USERNAME_RE = re.compile(r"[A-Za-z0-9._-]+")
_RESERVED_TOKENS = {"train", "eval", "resume"}


class UserSettings(BaseModel):
    username: str = ""
    # Additive, response-only: "user" when the value came from a per-user
    # overlay, else "global". Ignored on input.
    scope: str | None = None


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


def validate_username(name: str) -> str:
    name = name.strip()
    if not name:
        return ""
    if not _USERNAME_RE.fullmatch(name):
        raise ValueError(
            "username may only contain letters, numbers, dot, underscore, or hyphen"
        )
    if _RESERVED_TOKENS & set(name.split("_")):
        raise ValueError("username must not contain 'train', 'eval', or 'resume'")
    return name


def _effective_file() -> tuple[Path, str]:
    """The file that governs this request and its scope: the per-user overlay
    when present, else the flat global file."""
    overlay = user_context.overlay_file(_FILENAME)
    if overlay is not None and overlay.is_file():
        return overlay, "user"
    return _SETTINGS_FILE, "global"


def get_username() -> str:
    """Env var > per-user overlay (when present) > flat global file. Empty
    string means no job-name prefix."""
    env = os.environ.get("TRAIN_EVAL_WEB_USERNAME")
    if env:
        return env.strip()
    path, _ = _effective_file()
    return (_read_file(path).get("username") or "").strip()


def get_settings() -> UserSettings:
    _, scope = _effective_file()
    return UserSettings(username=get_username(), scope=scope)


def save_settings(req: UserSettings) -> UserSettings:
    data = _load()
    data["username"] = validate_username(req.username)
    _save(data)
    return get_settings()
