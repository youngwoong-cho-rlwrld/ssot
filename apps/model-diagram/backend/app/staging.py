"""Mirror a remote model root to a local scratch dir for the codex runtime.

Why this exists: codex launches the stdio MCP server INSIDE its read-only
seatbelt sandbox, which blocks ALL network egress (verified — the only way to get
network is codex's ``workspace-write`` mode, which also opens a write path and lets
the model's builtin shell reach the network, an unacceptable safety downgrade). So
the sandboxed MCP server cannot ssh/kubectl to a remote cluster.

Instead, for a codex run on a remote cluster the backend mirrors the root to a
local directory BEFORE the run (the backend is NOT sandboxed), then points
``FsAccess`` at the local mirror — read scoping and the finalize byte-fetch are
unchanged, they just resolve against a local path. The mirror is deleted when the
run ends.

Only TEXT/CODE is mirrored: the architecture analysis reads source, config, and
docs, never model weights, datasets, logs, or media. So the tar stream EXCLUDES
the standard ML blob patterns + heavy dirs (weights, wandb/outputs/checkpoints/
datasets/…) — an exclusion list, so unknown text formats always survive. The
``.git`` object/LFS stores are excluded too, but ``.git/HEAD`` + refs are kept so
the agent pins the commit exactly as for a local root. The size cap is enforced
DURING the transfer (post-exclusion bytes), so a root that is 7 GB of checkpoints
but a few MB of code stages fine.

Transport is ``tar`` streamed over the resolved access (ssh master reuse for ssh
clusters, ``kubectl exec`` for mlxp).
"""
from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import tempfile
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable, Optional

from . import settings
from .ssh import ssh_stream_bytes

# Binary / artifact FILE globs — matched anywhere (``*`` spans ``/`` in both GNU
# and bsdtar), so ``*.pt`` drops ``./a/b/x.pt``. ``*.egg-info`` catches the dir too.
_EXCLUDE_FILE_GLOBS = (
    "*.pt", "*.pth", "*.ckpt", "*.safetensors", "*.npz", "*.npy", "*.hdf5", "*.h5",
    "*.tar", "*.zip", "*.mp4", "*.avi", "*.gif", "*.png", "*.jpg", "*.jpeg",
    "*.egg-info",
)
# Heavy DIRS excluded with their whole subtree (tar prunes matched dirs). Each name
# needs both the top-level (``./name``) and nested (``*/name``) form — bsdtar's
# ``*/name`` does not match a top-level ``./name``.
_EXCLUDE_DIR_NAMES = (
    "wandb", "outputs", "checkpoints", "logs", "data", "datasets",
    "__pycache__", ".venv", "node_modules",
)
# Git: drop the object/LFS/submodule stores (the bulk); KEEP HEAD + refs for pinning.
_EXCLUDE_GIT = (".git/objects", ".git/lfs", ".git/modules")


class StagingError(Exception):
    """The remote root could not be mirrored (over cap, transport failure)."""


def excluded_file_globs() -> tuple[str, ...]:
    """FILE globs excluded from the mirror (for the 'binary artifact' read note)."""
    return _EXCLUDE_FILE_GLOBS


def _exclude_patterns() -> list[str]:
    patterns: list[str] = list(_EXCLUDE_FILE_GLOBS)
    for name in _EXCLUDE_DIR_NAMES:
        patterns += [f"./{name}", f"*/{name}"]
    for git in _EXCLUDE_GIT:
        patterns += [f"./{git}", f"*/{git}"]
    # Operator additions (comma-separated raw globs).
    extra = os.environ.get("MODEL_DIAGRAM_STAGE_EXCLUDES", "").strip()
    if extra:
        patterns += [p.strip() for p in extra.split(",") if p.strip()]
    return patterns


def _tar_command(root: str) -> str:
    excludes = " ".join(f"--exclude={shlex.quote(p)}" for p in _exclude_patterns())
    # -C into the root and archive '.' so the mirror has the root's CONTENTS at top
    # level (matching how FsAccess resolves paths relative to the root).
    return f"tar -C {shlex.quote(root)} {excludes} -cf - ."


async def _producer_stream(access: dict, cmd: str) -> AsyncIterator[bytes]:
    """Async byte stream of ``cmd``'s stdout over the resolved access."""
    kind = access.get("kind")
    if kind == "ssh":
        async for chunk in ssh_stream_bytes(access["ssh_alias"], cmd):
            yield chunk
        return
    if kind == "kubectl":
        async for chunk in _kubectl_stream(access, cmd):
            yield chunk
        return
    raise StagingError(f"cannot stage a root for access kind {kind!r}")


async def _kubectl_stream(access: dict, cmd: str) -> AsyncIterator[bytes]:
    proc = await asyncio.create_subprocess_exec(
        "kubectl", "exec", "-n", access.get("namespace", ""), access.get("pod", ""),
        "--", "sh", "-lc", cmd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=1 << 20,
    )
    assert proc.stdout is not None
    try:
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _extract_tar(stream: AsyncIterator[bytes], dest: str, *, cap_bytes: int) -> None:
    """Extract a tar byte stream into ``dest``, aborting cleanly past ``cap_bytes``.

    The cap is enforced on the POST-EXCLUSION stream (only code/text is in it), so
    a root whose bulk is excluded artifacts stages fine. ``tar -x`` (bsdtar/GNU)
    strips leading slashes and rejects ``..``, so a crafted archive cannot escape.
    """
    proc = await asyncio.create_subprocess_exec(
        "tar", "-x", "-f", "-", "-C", dest,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdin is not None
    total = 0
    over_cap = False
    try:
        async for chunk in stream:
            total += len(chunk)
            if total > cap_bytes:
                over_cap = True
                break
            proc.stdin.write(chunk)
            await proc.stdin.drain()
        proc.stdin.close()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        # Close the producer on EVERY exit path — a cap hit, a dead tar, or any error
        # abandons the stream mid-flight, and without an explicit close the ssh /
        # kubectl child feeding it lingers (its own finally never runs). aclose()
        # raises GeneratorExit into the suspended producer so its cleanup fires.
        aclose = getattr(stream, "aclose", None)
        if aclose is not None:
            await aclose()
    if over_cap:
        proc.kill()
        await proc.wait()
        raise StagingError(
            f"the code/text portion of this root exceeds the {cap_bytes}-byte codex "
            "staging cap even after excluding weights/datasets/logs; point at a smaller "
            "subtree or raise MODEL_DIAGRAM_CODEX_STAGE_MAX_BYTES"
        )
    _, stderr = await proc.communicate()
    if (proc.returncode or 0) != 0:
        raise StagingError(f"mirror extraction failed: {stderr.decode(errors='replace').strip()[:300]}")


async def stage_root(access: dict, root: str, dest_dir: str, *, size_cap_bytes: int) -> str:
    """Mirror ``root`` (reached via ``access``) into ``dest_dir``; return the mirror path.

    Raises :class:`StagingError` if the post-exclusion content exceeds
    ``size_cap_bytes`` or the transport fails.
    """
    mirror = os.path.join(dest_dir, "root")
    os.makedirs(mirror, exist_ok=True)
    await _extract_tar(
        _producer_stream(access, _tar_command(root)), mirror, cap_bytes=size_cap_bytes
    )
    # A silently-empty mirror (transport produced nothing) is a failure, not a
    # valid empty root — the agent would then report "not a model root".
    if not os.listdir(mirror):
        raise StagingError("mirror is empty after transfer, the remote root could not be read")
    return mirror


@asynccontextmanager
async def staged_root_for_codex(
    access: dict,
    resolved_root: str,
    *,
    prefix: str,
    on_log: Optional[Callable[[str], None]] = None,
):
    """Mirror a REMOTE root locally for a codex run/chat and yield the effective
    ``(cluster, root, access, staged_excludes)`` to run against; delete the mirror on
    exit. Raises :class:`StagingError` if the mirror fails (the caller records it).

    Only for a remote cluster — the sandboxed MCP server cannot ssh/kubectl, so the
    backend mirrors first and points FsAccess at the local copy. Local roots read
    directly and never enter this. Shared by the run and chat workers.
    """
    staged_dir = tempfile.mkdtemp(prefix=prefix, dir=str(settings.stage_dir()))
    if on_log:
        on_log(f"staging remote root to local mirror for codex ({staged_dir})")
    try:
        mirror = await stage_root(
            access, resolved_root, staged_dir, size_cap_bytes=settings.codex_stage_max_bytes()
        )
        yield "local", mirror, {"kind": "local"}, excluded_file_globs()
    finally:
        shutil.rmtree(staged_dir, ignore_errors=True)
