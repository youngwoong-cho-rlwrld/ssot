"""Scoped, read-only filesystem access for the analysis agent.

Every read is confined to the model root. Local reads resolve symlinks and
reject any target that escapes the root (canonical containment). Remote reads
(ssh, kubectl-exec) are lexically confined to the root and every argument is
``shlex.quote``d, so a crafted path cannot inject shell. Remote symlink
resolution is a documented limitation (see the TODO in read_file/list_dir).

Only three verbs are exposed: probe the root kind, list a directory, read a
file. Nothing here writes, and there is no network/web access of any kind.
"""
from __future__ import annotations

import asyncio
import fnmatch
import posixpath
import shlex
from pathlib import Path
from typing import Literal, Optional

from . import mlxp_config
from . import mlxp_data_pod
from .clusters import load_cluster
from .ssh import ssh_run

PathKind = Literal["dir", "file"]


class PathEscape(Exception):
    """Raised when a requested path would leave the model root."""


class FsError(Exception):
    """A read failed (missing path, transport error, oversize, etc.)."""


class ClusterAccessError(FsError):
    """The cluster's access config could not be resolved (not configured)."""


async def resolve_access(cluster: str) -> dict:
    """Resolve a cluster to a self-contained access config, in the backend.

    This runs where the request's identity is available (settings live in
    ssot.db keyed by the user's email), so the resolved config can be handed to
    an out-of-process worker — the MCP server on the CLI runtime — that has no
    identity of its own. The returned dict is one of:

    - ``{"kind": "local"}``
    - ``{"kind": "ssh", "ssh_alias": <alias>}``
    - ``{"kind": "kubectl", "namespace": <ns>, "pod": <pod>}``  (mlxp)

    Raises :class:`ClusterAccessError` with an actionable message when the
    cluster isn't configured for this account.
    """
    if cluster == "local":
        return {"kind": "local"}
    if cluster == "mlxp":
        try:
            s = mlxp_config.get_settings()
            pod = await mlxp_data_pod.ensure_listing_pod()
        except Exception as exc:
            raise ClusterAccessError(
                f"cluster 'mlxp' is not available: {exc}. Configure MLXP settings in Settings, then retry."
            ) from exc
        return {"kind": "kubectl", "namespace": s.namespace, "pod": pod}
    try:
        env = await load_cluster(cluster)
    except FileNotFoundError as exc:
        raise ClusterAccessError(
            f"cluster '{cluster}' is not configured for your account. Add its SSH settings in "
            "Settings (cluster configuration), then retry."
        ) from exc
    alias = env.ssh_alias
    if not alias:
        raise ClusterAccessError(
            f"cluster '{cluster}' has no SSH_ALIAS configured. Set it in Settings (cluster "
            "configuration), then retry."
        )
    return {"kind": "ssh", "ssh_alias": alias}


class FsAccess:
    """Read-only accessor scoped to one cluster + absolute model root."""

    def __init__(
        self,
        cluster: str,
        root: str,
        access: Optional[dict] = None,
        staged_excludes: Optional[tuple[str, ...]] = None,
    ):
        self.cluster = cluster
        # Pre-resolved access config (backend). When None, it is resolved lazily
        # via resolve_access() on first remote call — fine in-process (identity
        # is set), but an out-of-process worker MUST pass access explicitly.
        self._access = access
        # File globs that were excluded when this root was mirrored for the codex
        # runtime (weights/datasets/…). A read of a missing file matching one of
        # these gets a clear "excluded artifact" error instead of a bare not-found,
        # so the agent understands the file exists on the cluster but was not copied.
        self._staged_excludes = staged_excludes or ()
        if cluster == "local":
            self.local_root: Optional[Path] = Path(root).expanduser().resolve()
            self.root = str(self.local_root)
        else:
            self.local_root = None
            self.root = posixpath.normpath(root)

    # ── path guards ──────────────────────────────────────────────────────

    def _local_abs(self, user_path: str) -> Path:
        assert self.local_root is not None
        raw = (user_path or "").strip()
        if not raw:
            candidate = self.local_root
        else:
            supplied = Path(raw)
            candidate = supplied if supplied.is_absolute() else self.local_root / supplied
        # resolve() follows symlinks (strict=False on 3.11); a symlink that
        # points outside the root resolves to an outside path and fails below.
        resolved = candidate.resolve()
        if resolved != self.local_root and not resolved.is_relative_to(self.local_root):
            raise PathEscape(f"path escapes model root: {user_path!r}")
        return resolved

    def _remote_abs(self, user_path: str) -> str:
        raw = (user_path or "").strip()
        if not raw:
            candidate = self.root
        elif raw.startswith("/"):
            candidate = posixpath.normpath(raw)
        else:
            candidate = posixpath.normpath(posixpath.join(self.root, raw))
        root_prefix = self.root.rstrip("/") + "/"
        if candidate != self.root and not candidate.startswith(root_prefix):
            raise PathEscape(f"path escapes model root: {user_path!r}")
        return candidate

    # ── public reads ─────────────────────────────────────────────────────

    async def probe_root(self, timeout: float = 15.0) -> Optional[PathKind]:
        """Return dir/file for the root itself, or None if it is absent."""
        if self.cluster == "local":
            return await asyncio.to_thread(self._local_kind, self.local_root)
        return await self._remote_kind(self.root, timeout)

    async def list_dir(self, user_path: str = "", timeout: float = 20.0) -> list[dict]:
        """List a directory under the root. Each entry: {name, kind}."""
        from . import settings

        if self.cluster == "local":
            target = self._local_abs(user_path)
            return await asyncio.to_thread(self._local_list, target, settings.LIST_DIR_MAX_ENTRIES)

        target = self._remote_abs(user_path)
        # TODO(fast-follow): remote symlink escapes aren't resolved (lexical guard only).
        script = f"ls -1Ap -- {shlex.quote(target)}"
        out = await self._remote_run(script, timeout)
        entries: list[dict] = []
        for line in out.splitlines():
            name = line.strip()
            if not name:
                continue
            if name.endswith("/"):
                entries.append({"name": name[:-1], "kind": "dir", "size": None})
            else:
                entries.append({"name": name, "kind": "file", "size": None})
            if len(entries) >= settings.LIST_DIR_MAX_ENTRIES:
                break
        return entries

    async def read_file(self, user_path: str, max_bytes: Optional[int] = None, timeout: float = 30.0) -> str:
        """Read a file under the root as UTF-8 text (errors replaced)."""
        from . import settings

        cap = max_bytes if max_bytes is not None else settings.SOURCE_MAX_BYTES
        if self.cluster == "local":
            target = self._local_abs(user_path)
            if self._staged_excludes and not target.is_file():
                base = target.name
                if any(fnmatch.fnmatch(base, glob) for glob in self._staged_excludes):
                    raise FsError(
                        f"'{user_path}' was excluded from the codex staging mirror (binary/artifact "
                        "file, not copied) — the analysis reads text/code only; skip it"
                    )
            return await asyncio.to_thread(self._local_read, target, cap)

        target = self._remote_abs(user_path)
        # TODO(fast-follow): remote symlink escapes aren't resolved (lexical guard only).
        quoted = shlex.quote(target)
        size_out = await self._remote_run(f"wc -c < {quoted}", timeout)
        try:
            size = int(size_out.strip().split()[0])
        except (ValueError, IndexError):
            raise FsError(f"could not stat remote file: {target}")
        if size > cap:
            raise FsError(f"file exceeds {cap} bytes ({size}): {target}")
        return await self._remote_run(f"cat -- {quoted}", timeout)

    # ── local helpers ────────────────────────────────────────────────────

    @staticmethod
    def _local_kind(path: Optional[Path]) -> Optional[PathKind]:
        if path is None:
            return None
        if path.is_dir():
            return "dir"
        if path.is_file():
            return "file"
        return None

    @staticmethod
    def _local_list(path: Path, limit: int) -> list[dict]:
        if not path.is_dir():
            raise FsError(f"not a directory: {path}")
        entries: list[dict] = []
        for child in sorted(path.iterdir(), key=lambda p: p.name):
            is_dir = child.is_dir()
            kind: PathKind = "dir" if is_dir else "file"
            size: Optional[int] = None
            if not is_dir:
                try:
                    size = child.stat().st_size
                except OSError:
                    size = None
            entries.append({"name": child.name, "kind": kind, "size": size})
            if len(entries) >= limit:
                break
        return entries

    @staticmethod
    def _local_read(path: Path, cap: int) -> str:
        if not path.is_file():
            raise FsError(f"not a file: {path}")
        size = path.stat().st_size
        if size > cap:
            raise FsError(f"file exceeds {cap} bytes ({size}): {path}")
        return path.read_bytes().decode("utf-8", errors="replace")

    # ── remote helpers ───────────────────────────────────────────────────

    async def _remote_kind(self, path: str, timeout: float) -> Optional[PathKind]:
        quoted = shlex.quote(path)
        script = f"if [ -d {quoted} ]; then echo dir; elif [ -f {quoted} ]; then echo file; else echo none; fi"
        try:
            out = (await self._remote_run(script, timeout)).strip()
        except FsError:
            return None
        return out if out in ("dir", "file") else None

    async def _get_access(self) -> dict:
        if self._access is None:
            self._access = await resolve_access(self.cluster)
        return self._access

    async def _remote_run(self, script: str, timeout: float) -> str:
        access = await self._get_access()
        if access.get("kind") == "kubectl":
            return await self._kubectl_bash(script, timeout, access)
        alias = access.get("ssh_alias", "")
        if not alias:
            raise ClusterAccessError(f"cluster {self.cluster!r} has no SSH_ALIAS configured")
        result = await ssh_run(alias, script, timeout=timeout)
        if result.returncode != 0:
            raise FsError(result.stderr.strip() or result.stdout.strip() or f"remote command failed: {script}")
        return result.stdout

    @staticmethod
    async def _kubectl_bash(script: str, timeout: float, access: dict) -> str:
        namespace = access.get("namespace") or ""
        pod = access.get("pod") or ""
        if not namespace or not pod:
            raise ClusterAccessError("mlxp access config is missing namespace/pod")
        proc = await asyncio.create_subprocess_exec(
            "kubectl", "exec", "-n", namespace, pod, "--", "bash", "-lc", script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if (proc.returncode or 0) != 0:
            raise FsError(stderr.decode(errors="replace").strip() or f"kubectl exec failed: {script}")
        return stdout.decode(errors="replace")
