"""Process configuration for the model-diagram backend.

Everything has a working default for local single-machine use. Values are read
from the environment (Nx injects the repo-root ``.env`` into tasks), mirroring
the other SSOT app backends.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path


def _load_repo_env() -> None:
    """Parse the repo-root .env so ANTHROPIC_API_KEY (and MODEL_DIAGRAM_*) work
    even when the backend is started directly (outside nx, which injects it).

    Real environment values always win — a variable already set is never
    overwritten. Walk up from this file to the workspace root (the dir holding
    nx.json / .git) and load its .env if present.
    """
    here = Path(__file__).resolve()
    root: Path | None = None
    for parent in here.parents:
        if (parent / "nx.json").is_file() or (parent / ".git").exists():
            root = parent
            break
    if root is None:
        return
    env_file = root / ".env"
    if not env_file.is_file():
        return
    for raw in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_repo_env()


def _data_dir() -> Path:
    return Path(os.path.expanduser(os.environ.get("SSOT_DATA_DIR", "~/.ssot"))).resolve()


def db_path() -> Path:
    override = os.environ.get("MODEL_DIAGRAM_DB")
    if override:
        return Path(os.path.expanduser(override)).resolve()
    return _data_dir() / "model_diagram.db"


def papers_dir() -> Path:
    override = os.environ.get("MODEL_DIAGRAM_PAPERS_DIR")
    if override:
        path = Path(os.path.expanduser(override)).resolve()
    else:
        path = _data_dir() / "model-diagram" / "papers"
    path.mkdir(parents=True, exist_ok=True)
    return path


# Ordered allowlist of models a run may use; the first entry is the UI default.
# Each entry is ``(id, label, family)`` where family is the generation runtime:
# ``claude`` (Anthropic SDK or the Claude Code CLI) or ``codex`` (the OpenAI
# ``codex`` CLI). The claude ids are accepted by the CLI's ``--model`` flag and the
# SDK; the codex ids mirror what OpenClaw exposes (``~/.openclaw/openclaw.json``).
# The frontend never hard-codes this list — it reads GET /api/models — so adding a
# model here is the single source of truth. GET /api/models filters this to the
# models whose runtime is actually available (see :func:`available_model_catalog`).
MODEL_ALLOWLIST: list[tuple[str, str, str]] = [
    ("claude-fable-5", "Claude Fable", "claude"),
    ("claude-opus-4-8", "Claude Opus 4.8", "claude"),
    ("claude-sonnet-5", "Claude Sonnet", "claude"),
    ("claude-haiku-4-5", "Claude Haiku", "claude"),
    ("gpt-5.6-sol", "GPT-5.6 Sol", "codex"),
]


def model_name() -> str:
    return os.environ.get("MODEL_DIAGRAM_MODEL", "claude-fable-5")


def model_catalog() -> list[dict[str, str]]:
    """The full allowlist as ``[{"id", "label"}, ...]`` (unfiltered).

    GET /api/models serves the availability-filtered subset instead
    (:func:`available_model_catalog`); this remains the complete registry.
    """
    return [{"id": mid, "label": label} for mid, label, _ in MODEL_ALLOWLIST]


def allowed_model_ids() -> set[str]:
    return {mid for mid, _, _ in MODEL_ALLOWLIST}


def model_family(model_id: str) -> str | None:
    """``claude`` | ``codex`` for a known id, else ``None``."""
    for mid, _, fam in MODEL_ALLOWLIST:
        if mid == model_id:
            return fam
    return None


def default_model() -> str:
    """The model the UI preselects: the configured default when it's allow-listed,
    otherwise the first allow-listed id (so the select's value is always an option).
    """
    configured = model_name()
    return configured if configured in allowed_model_ids() else MODEL_ALLOWLIST[0][0]


def available_model_catalog() -> list[dict[str, str]]:
    """The allowlist filtered to models whose generation runtime is available now.

    Claude models appear when the SDK key or the Claude CLI is present; codex
    models appear when the ``codex`` CLI is present. Served by GET /api/models so
    the UI only ever offers a model it can actually run.
    """
    return [
        {"id": mid, "label": label}
        for mid, label, _ in MODEL_ALLOWLIST
        if runtime_for_model(mid) != "none"
    ]


def resolve_model(requested: str | None) -> str:
    """Validate a caller-supplied model id for a new run.

    ``None`` falls back to :func:`default_model`. A non-null value must be in the
    allowlist, else ``ValueError`` (the API maps it to HTTP 422).
    """
    if requested is None:
        return default_model()
    if requested not in allowed_model_ids():
        raise ValueError(f"unknown model: {requested!r}")
    return requested


def anthropic_api_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    return key or None


def claude_cli_path() -> str | None:
    """Path to a usable ``claude`` CLI, or None.

    ``CLAUDE_CLI_PATH`` overrides discovery; otherwise ``claude`` is looked up on
    PATH. The CLI runtime drives it headlessly against the user's logged-in
    Claude Code subscription (OAuth) — no ANTHROPIC_API_KEY required.
    """
    override = os.environ.get("CLAUDE_CLI_PATH", "").strip()
    if override:
        return override if os.path.isfile(override) and os.access(override, os.X_OK) else None
    return shutil.which("claude")


def codex_cli_path() -> str | None:
    """Path to a usable ``codex`` CLI, or None.

    ``CODEX_CLI_PATH`` overrides discovery; otherwise ``codex`` is looked up on
    PATH. The codex runtime drives it headlessly (``codex exec``) against the
    user's logged-in codex credentials (``$CODEX_HOME/auth.json``). Presence of the
    CLI is what gates the codex models here; an unauthenticated CLI still surfaces
    as a clear per-run ``agent_failure`` ("codex is not logged in") at run time.
    """
    override = os.environ.get("CODEX_CLI_PATH", "").strip()
    if override:
        return override if os.path.isfile(override) and os.access(override, os.X_OK) else None
    return shutil.which("codex")


def active_runtime() -> str:
    """Which generation runtime a *claude* run will use: ``sdk`` | ``claude-cli`` | ``none``.

    ANTHROPIC_API_KEY wins (the SDK loop, unchanged); else a logged-in Claude
    Code CLI; else no runtime is configured and runs end ``credentials_not_configured``.
    Kept for backward compatibility (GET /api/health's ``runtime`` field);
    per-run selection goes through :func:`runtime_for_model`.
    """
    if anthropic_api_key():
        return "sdk"
    if claude_cli_path():
        return "claude-cli"
    return "none"


def codex_runtime() -> str | None:
    """``cli`` when a codex CLI is present, else ``None``."""
    return "cli" if codex_cli_path() else None


def available_runtimes() -> dict[str, str | None]:
    """Per-family runtime availability for GET /api/health.

    ``claude`` is ``sdk`` (API key), ``cli`` (Claude Code CLI), or ``None``;
    ``codex`` is ``cli`` or ``None``.
    """
    if anthropic_api_key():
        claude: str | None = "sdk"
    elif claude_cli_path():
        claude = "cli"
    else:
        claude = None
    return {"claude": claude, "codex": codex_runtime()}


def runtime_for_model(model_id: str) -> str:
    """The runtime a run of ``model_id`` will use: ``sdk`` | ``claude-cli`` | ``codex`` | ``none``.

    Codex-family ids route to the codex CLI when present. Everything else (the
    claude family, and any unknown id for backward compatibility) routes to the
    SDK when a key is set, else the Claude CLI, else ``none``.
    """
    if model_family(model_id) == "codex":
        return "codex" if codex_cli_path() else "none"
    if anthropic_api_key():
        return "sdk"
    if claude_cli_path():
        return "claude-cli"
    return "none"


def api_host() -> str:
    return os.environ.get("MODEL_DIAGRAM_API_HOST", "127.0.0.1").strip() or "127.0.0.1"


def api_port() -> int:
    try:
        return int(os.environ.get("MODEL_DIAGRAM_API_PORT", "8791"))
    except ValueError:
        return 8791


def paper_max_bytes() -> int:
    mb = os.environ.get("MODEL_DIAGRAM_PAPER_MAX_MB", "32")
    try:
        value = float(mb)
    except ValueError:
        value = 32.0
    # Native PDF document blocks are capped at 32MB by the Anthropic API.
    value = min(value, 32.0)
    return int(value * 1024 * 1024)


def paper_max_pages() -> int:
    raw = os.environ.get("MODEL_DIAGRAM_PAPER_MAX_PAGES", "600")
    try:
        return int(raw)
    except ValueError:
        return 600


# Bytes of a single source file we will read into a diagram. Files larger than
# this are rejected by read_file so a run cannot balloon the DB or the prompt.
SOURCE_MAX_BYTES = int(os.environ.get("MODEL_DIAGRAM_SOURCE_MAX_BYTES", str(512 * 1024)))

# Cap on directory entries returned by list_dir in one call.
LIST_DIR_MAX_ENTRIES = int(os.environ.get("MODEL_DIAGRAM_LIST_DIR_MAX", "400"))

# Hard ceiling on agent loop iterations (defensive; task_budget paces normally).
AGENT_MAX_ITERATIONS = int(os.environ.get("MODEL_DIAGRAM_AGENT_MAX_ITERATIONS", "80"))

# Wall-clock ceiling for a single run; on timeout the run is marked agent_failure.
# 3600s (1h) of headroom for large repos. The real cure for the finalize-timeout was
# removing base64 sources from the tool payload (the backend fetches bytes itself);
# this ceiling is insurance for long analysis, not a substitute for that fix.
RUN_TIMEOUT_S = float(os.environ.get("MODEL_DIAGRAM_RUN_TIMEOUT_S", "3600"))

# Consecutive finalize_diagram integrity failures before giving up (plan §6).
MAX_FINALIZE_ATTEMPTS = int(os.environ.get("MODEL_DIAGRAM_MAX_FINALIZE_ATTEMPTS", "3"))


def geometry_pass_enabled() -> bool:
    """Whether the post-finalize headless-Chrome geometry pass runs (§7.2 / A6).

    On by default; set MODEL_DIAGRAM_GEOMETRY_PASS=0 to skip it (tests, or hosts
    where launching a browser during finalize is undesirable). It also self-skips
    when no Chrome/Chromium binary is present.
    """
    return os.environ.get("MODEL_DIAGRAM_GEOMETRY_PASS", "1") != "0"
