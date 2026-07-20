"""Per-user Slack notification settings stored in SSOT SQLite."""
from __future__ import annotations

from pydantic import BaseModel

from . import settings_db


class NotificationSettings(BaseModel):
    enabled: bool = False
    configured: bool = False
    notify_submitted: bool = False
    notify_running: bool = False
    notify_completed: bool = False
    notify_failed: bool = False
    notify_cancelled: bool = False


class NotificationSettingsUpdate(BaseModel):
    enabled: bool = False
    slack_webhook_url: str | None = None
    notify_submitted: bool = False
    notify_running: bool = False
    notify_completed: bool = False
    notify_failed: bool = False
    notify_cancelled: bool = False


def _settings() -> dict:
    value = settings_db.get_namespace("train-eval").get("notifications")
    return value if isinstance(value, dict) else {}


def webhook_url() -> str:
    value = _settings().get("slack_webhook_url")
    return value.strip() if isinstance(value, str) else ""


def get_settings() -> NotificationSettings:
    data = _settings()
    return NotificationSettings(
        enabled=bool(data.get("enabled", False)),
        configured=bool(webhook_url()),
        notify_submitted=bool(data.get("notify_submitted", False)),
        notify_running=bool(data.get("notify_running", False)),
        notify_completed=bool(data.get("notify_completed", False)),
        notify_failed=bool(data.get("notify_failed", False)),
        notify_cancelled=bool(data.get("notify_cancelled", False)),
    )


def save_settings(req: NotificationSettingsUpdate) -> NotificationSettings:
    def update(existing: object) -> dict:
        data = dict(existing) if isinstance(existing, dict) else {}
        data["enabled"] = bool(req.enabled)
        if req.slack_webhook_url and req.slack_webhook_url.strip():
            data["slack_webhook_url"] = req.slack_webhook_url.strip()
        data["notify_submitted"] = bool(req.notify_submitted)
        data["notify_running"] = bool(req.notify_running)
        data["notify_completed"] = bool(req.notify_completed)
        data["notify_failed"] = bool(req.notify_failed)
        data["notify_cancelled"] = bool(req.notify_cancelled)
        return data

    settings_db.mutate_key("train-eval", "notifications", update)
    return get_settings()


def event_enabled(event: str) -> bool:
    settings = get_settings()
    return {
        "submitted": settings.notify_submitted,
        "running": settings.notify_running,
        "completed": settings.notify_completed,
        "failed": settings.notify_failed,
        "cancelled": settings.notify_cancelled,
    }.get(event, False)
