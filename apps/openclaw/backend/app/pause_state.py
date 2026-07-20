"""Persist the pause-all control's restore state.

OpenClaw has no global cron toggle, so "pause all" disables each currently
enabled cron job individually. We record which jobs *we* disabled so that
"resume" re-enables only those — a job the user had already disabled must stay
disabled. We likewise snapshot the heartbeat-enabled state at pause time so
resume only re-enables heartbeat if it was on before. Because the live heartbeat
toggle is not reflected in ``status`` (that field is config-level),
``heartbeat_enabled`` is this backend's own best-known view of the live state.
The state is a small JSON file owned by this backend.

Fields:
- ``paused``: whether pause-all is currently engaged.
- ``cron_disabled_by_pause``: ids of cron jobs pause disabled and resume owes a
  re-enable (a still-failed id stays here so a later resume retries it).
- ``heartbeat_enabled``: best-known live heartbeat state (None = unknown).
- ``heartbeat_enabled_before_pause``: snapshot taken at pause for resume.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from . import settings

log = logging.getLogger("openclaw.pause_state")

_PATH = settings.STATE_DIR / "pause_state.json"
_DEFAULT: dict[str, Any] = {
    "paused": False,
    "cron_disabled_by_pause": [],
    "heartbeat_enabled": None,
    "heartbeat_enabled_before_pause": None,
}


def read() -> dict[str, Any]:
    """Return the persisted pause state, or defaults if none/unreadable."""
    try:
        with _PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return {**_DEFAULT, **data}
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return dict(_DEFAULT)


def write(state: dict[str, Any]) -> None:
    """Atomically persist the pause state."""
    settings.STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_name(_PATH.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, _PATH)
