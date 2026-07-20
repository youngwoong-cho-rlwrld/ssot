"""Per-user job identity stored in the SSOT SQLite database."""
from __future__ import annotations

import re

from pydantic import BaseModel

from . import settings_db

_USERNAME_RE = re.compile(r"[A-Za-z0-9._-]+")
_RESERVED_TOKENS = {"train", "eval", "resume"}


class UserSettings(BaseModel):
    username: str = ""
    scope: str | None = None


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


def get_username() -> str:
    value = settings_db.get_namespace("profile").get("username")
    return value.strip() if isinstance(value, str) else ""


def get_settings() -> UserSettings:
    return UserSettings(username=get_username(), scope="user")


def save_settings(req: UserSettings) -> UserSettings:
    settings_db.set_key("profile", "username", validate_username(req.username))
    return get_settings()
