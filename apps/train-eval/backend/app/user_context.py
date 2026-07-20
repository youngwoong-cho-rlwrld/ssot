"""Exact per-request identity injected by the SSOT gateway.

There is no owner exception and no headerless fallback.  An authenticated
request resolves settings only for its exact email address; a request without
``x-ssot-user`` has no account settings.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

_HEADER = b"x-ssot-user"
_current_email: ContextVar[str | None] = ContextVar("ssot_user_email", default=None)


def normalize_email(raw: str | None) -> str | None:
    if not raw:
        return None
    email = raw.strip().lower()
    return email or None


@contextmanager
def user_scope(email: str | None) -> Iterator[None]:
    """Temporarily resolve settings as one exact user."""
    token = _current_email.set(normalize_email(email))
    try:
        yield
    finally:
        _current_email.reset(token)


class SsotUserMiddleware:
    """Store the trusted gateway identity for the lifetime of one request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw: str | None = None
        for name, value in scope.get("headers", []):
            if name.lower() == _HEADER:
                raw = value.decode("latin-1")
                break
        token = _current_email.set(normalize_email(raw))
        try:
            await self.app(scope, receive, send)
        finally:
            _current_email.reset(token)


def current_user_email() -> str | None:
    return _current_email.get()
