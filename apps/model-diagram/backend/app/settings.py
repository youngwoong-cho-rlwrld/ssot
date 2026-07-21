"""Process configuration for the model-diagram backend.

Everything has a working default for local single-machine use. Values are read
from the environment (Nx injects the repo-root ``.env`` into tasks), mirroring
the other SSOT app backends.
"""
from __future__ import annotations

import os
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


def model_name() -> str:
    return os.environ.get("MODEL_DIAGRAM_MODEL", "claude-opus-4-8")


def anthropic_api_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    return key or None


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
RUN_TIMEOUT_S = float(os.environ.get("MODEL_DIAGRAM_RUN_TIMEOUT_S", "1800"))

# Consecutive finalize_diagram integrity failures before giving up (plan §6).
MAX_FINALIZE_ATTEMPTS = int(os.environ.get("MODEL_DIAGRAM_MAX_FINALIZE_ATTEMPTS", "3"))
