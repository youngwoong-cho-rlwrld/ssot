"""Backend ``broken_path`` precheck (plan §3, tier (a)).

Runs before any agent work: resolves the model root on the target cluster and
confirms it exists and is a directory. Any transport failure (ssh down, kubectl
unreachable) is reported as ``broken_path`` so the run never starts.
"""
from __future__ import annotations

import posixpath
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .fsaccess import FsAccess, PathEscape


@dataclass
class PathCheck:
    ok: bool
    detail: str = ""
    resolved_root: Optional[str] = None


async def precheck_path(cluster: str, path: str) -> PathCheck:
    raw = (path or "").strip()
    if not raw:
        return PathCheck(ok=False, detail="path is empty")

    try:
        root = await _resolve_root(cluster, raw)
    except Exception as exc:  # transport failure while resolving home, etc.
        return PathCheck(ok=False, detail=f"could not resolve path: {exc}")

    try:
        fs = FsAccess(cluster, root)
        kind = await fs.probe_root()
    except PathEscape as exc:
        return PathCheck(ok=False, detail=str(exc))
    except Exception as exc:
        # ssh/kubectl transport failures land here — broken_path per Decision 3.
        return PathCheck(ok=False, detail=f"cluster unreachable or probe failed: {exc}")

    if kind is None:
        return PathCheck(ok=False, detail="path does not exist")
    if kind != "dir":
        return PathCheck(ok=False, detail="path is not a directory (a model root must be a directory)")
    return PathCheck(ok=True, resolved_root=root)


async def _resolve_root(cluster: str, path: str) -> str:
    if cluster == "local":
        return str(Path(path).expanduser().resolve())

    if path.startswith(("~", "$HOME", "${HOME}")):
        home = await _remote_home(cluster)
        if not home:
            raise RuntimeError("could not resolve remote $HOME")
        rest = path
        for token in ("${HOME}/", "$HOME/", "~/"):
            if rest.startswith(token):
                return posixpath.normpath(f"{home}/{rest[len(token):]}")
        for token in ("${HOME}", "$HOME", "~"):
            if rest == token:
                return home.rstrip("/")
    return posixpath.normpath(path)


async def _remote_home(cluster: str) -> Optional[str]:
    # Use a throwaway accessor purely to run the home probe (no path guard needed).
    probe = FsAccess(cluster, "/")
    try:
        out = await probe._remote_run('printf %s "$HOME"', 10.0)
    except Exception:
        return None
    home = out.strip()
    return home if home.startswith("/") else None
