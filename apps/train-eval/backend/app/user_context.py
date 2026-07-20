"""Per-request user identity from the ssot gateway.

The ssot gateway injects ``x-ssot-user: <email>`` on every proxied
``/train-eval/api`` request (it strips any client-sent ``x-ssot-*`` first, so
the value is trusted). We read that header into a contextvar so the config
modules can resolve a per-user settings overlay for the duration of the
request.

Requests WITHOUT the header — OpenClaw cron jobs, direct hits to :18000, and
the legacy ``train-eval-web`` copy — resolve to no user, and every consumer
falls back to the flat global config files in ``~/.train-eval-web/``. That is
exactly today's behavior, unchanged.

The overlay lives under ``~/.train-eval-web/users/<slug>/`` where ``<slug>`` is
the email reduced to a single safe path segment (see :func:`slugify_user`).
"""
from __future__ import annotations

import os
import re
import tempfile
from contextvars import ContextVar
from pathlib import Path

SETTINGS_ROOT = Path.home() / ".train-eval-web"
USERS_ROOT = SETTINGS_ROOT / "users"

_HEADER = b"x-ssot-user"

# The machine owner. The legacy train-eval-web copy on :8000 shares the flat
# global config files and is effectively this owner's instance, so only the
# owner's saves feed those flat files (see save_settings_file). Override with
# TRAIN_EVAL_OWNER_EMAIL.
_OWNER_EMAIL_DEFAULT = "youngwoong.cho@rlwrld.ai"

# email/identity -> one safe path segment. Lowercased; every run of characters
# outside [a-z0-9] collapses to a single hyphen; leading/trailing hyphens are
# trimmed. "youngwoong.cho@rlwrld.ai" -> "youngwoong-cho-rlwrld-ai". A value
# that reduces to nothing (e.g. "@@@") is rejected (returns None), so a
# malformed header can never escape the users/ root or collide with it. The
# collapse is intentionally lossy (a.b@x and a-b@x map to the same slug); that
# collision risk is accepted for real email inputs.
_SLUG_RE = re.compile(r"[^a-z0-9]+")
# Cap the slug so it always fits a single filesystem path segment (255 on most
# filesystems); a caller can't force an ENAMETOOLONG on mkdir with a giant
# header value.
_SLUG_MAX = 64

_current_slug: ContextVar[str | None] = ContextVar("ssot_user_slug", default=None)


def slugify_user(raw: str | None) -> str | None:
    if not raw:
        return None
    slug = _SLUG_RE.sub("-", raw.strip().lower()).strip("-")
    slug = slug[:_SLUG_MAX].strip("-")
    return slug or None


def atomic_write(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically (tmp file + os.replace) so a crash
    mid-write can never leave a truncated file. A truncated overlay would be
    treated as present and WIN over the flat global file on read, so overlay and
    global writes both go through here."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def owner_slug() -> str | None:
    """Slug of the machine owner (TRAIN_EVAL_OWNER_EMAIL, default the repo
    owner). Compared against the request slug — both go through slugify_user."""
    return slugify_user(os.environ.get("TRAIN_EVAL_OWNER_EMAIL") or _OWNER_EMAIL_DEFAULT)


def is_owner_request() -> bool:
    """True when the current request's user is the machine owner."""
    slug = current_user_slug()
    return slug is not None and slug == owner_slug()


def save_settings_file(filename: str, text: str) -> None:
    """Write policy for a per-user-overlaid settings file (atomic writes).

    - No user context (legacy :8000 copy's own UI, direct curl): write the flat
      global file only — unchanged from the original single-file behavior.
    - User context: write the user's own overlay. ADDITIONALLY write the flat
      global file only when the requester is the machine owner
      (is_owner_request), so the legacy copy tracks the owner's values and
      nobody else's. A non-owner save NEVER touches the global file — the flat
      files are stable defaults, not last-writer state.

    A failed overlay write degrades to no-op for that overlay (reads fall back
    to global) rather than 500; it never redirects a non-owner's write to the
    shared global file, which would leak their value to everyone.
    """
    global_file = SETTINGS_ROOT / filename
    overlay = overlay_file(filename)
    if overlay is None:
        atomic_write(global_file, text)
        return
    try:
        atomic_write(overlay, text)
    except OSError as exc:
        print(f"[user_context] overlay write failed for {filename}, save dropped: {exc}")
    if is_owner_request():
        atomic_write(global_file, text)


def use_no_user() -> None:
    """Force the current context to 'no user'.

    Invariant: cache writes must NEVER be user-scoped. Background poll
    entrypoints call this at the top because ``asyncio.create_task`` copies the
    calling request's context — without this reset, a poll triggered from a
    request handler would inherit that user's slug and upsert user-scoped rows
    into the shared cache everyone reads."""
    _current_slug.set(None)


class SsotUserMiddleware:
    """Pure-ASGI middleware that stashes the slugified ``x-ssot-user`` in a
    contextvar for the lifetime of the request.

    Deliberately raw ASGI (not ``BaseHTTPMiddleware``): the contextvar is set in
    the same task that runs the endpoint, so downstream ``get_settings()`` calls
    see the value. ``BaseHTTPMiddleware`` runs ``dispatch`` in a separate context
    and the propagation would not be guaranteed.
    """

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
        token = _current_slug.set(slugify_user(raw))
        try:
            await self.app(scope, receive, send)
        finally:
            _current_slug.reset(token)


def current_user_slug() -> str | None:
    """The slug for the current request, or None when no user header was set."""
    return _current_slug.get()


def user_settings_dir() -> Path | None:
    """``~/.train-eval-web/users/<slug>/`` for the current request, or None."""
    slug = current_user_slug()
    if not slug:
        return None
    return USERS_ROOT / slug


def overlay_file(filename: str) -> Path | None:
    """Per-user overlay path for ``filename``, or None when there is no user."""
    directory = user_settings_dir()
    return (directory / filename) if directory else None
