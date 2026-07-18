"""Eval-video listing and byte-range streaming.

Isaac eval runs buffer per-episode recordings at
``<eval_dir>/<task…>/<eval_set>/run_*/videos/ep*.mp4`` on the cluster. These
helpers enumerate them in one remote round-trip and stream individual files
(with HTTP Range support so the browser player can seek) straight off the
cluster over the same ssh mechanism the rest of the backend uses.

DexJoCo runs write ``episode_NN_success|failure`` directories instead and
generally produce no mp4s, so the listing simply comes back empty for them.
"""

from __future__ import annotations

import json
import os
import shlex

from pydantic import BaseModel

from . import clusters
from .details import get_details
from .remote_paths import remote_path_expr
from .ssh import ssh_run, ssh_stream_bytes


class VideoFile(BaseModel):
    path: str        # POSIX path relative to eval_dir (used by the stream endpoint)
    size: int        # bytes
    run_dir: str     # absolute run directory — equals dirname(EvalRun.path)
    episode: str     # file basename, e.g. "ep0.mp4"


class VideoListing(BaseModel):
    eval_dir: str | None = None
    eval_harness: str | None = None
    videos: list[VideoFile] = []


# Enumerates every buffered episode mp4 under EVAL_DIR in one shot: relative
# path (for the stream query), size, absolute run dir (so the frontend can join
# a video to its EvalRun via dirname(EvalRun.path)), and basename.
_VIDEO_LISTING_SCRIPT = r'''
import json
import os
from pathlib import Path

root = Path(os.environ["EVAL_DIR"])
rows = []
if root.is_dir():
    for path in sorted(root.glob("**/videos/ep*.mp4"), key=lambda p: str(p)):
        try:
            size = path.stat().st_size
        except OSError:
            continue
        rows.append({
            "path": path.relative_to(root).as_posix(),
            "size": size,
            "run_dir": str(path.parent.parent),
            "episode": path.name,
        })
print(json.dumps(rows))
'''


async def resolve_eval_context(cluster: str, job_id: str) -> tuple[str | None, str | None]:
    """Return (eval_dir, eval_harness) for a job, both possibly None."""
    det = await get_details(
        cluster,
        job_id,
        include_progress=False,
        include_training_link=False,
    )
    return det.paths.eval_dir, det.eval_harness


async def list_videos(cluster: str, job_id: str) -> VideoListing:
    eval_dir, harness = await resolve_eval_context(cluster, job_id)
    if not eval_dir:
        return VideoListing(eval_dir=None, eval_harness=harness, videos=[])

    cmd = (
        f"EVAL_DIR={remote_path_expr(eval_dir)} "
        "python3 - <<'PY'\n" + _VIDEO_LISTING_SCRIPT + "\nPY"
    )

    if cluster == "mlxp":
        # Isaac (the only harness that records mp4s) runs on the slurm clusters,
        # so mlxp eval dirs have no videos to enumerate; degrade to empty.
        return VideoListing(eval_dir=eval_dir, eval_harness=harness, videos=[])

    host = (await clusters.load_cluster(cluster)).ssh_alias
    r = await ssh_run(host, cmd, timeout=20.0)
    if r.returncode != 0:
        return VideoListing(eval_dir=eval_dir, eval_harness=harness, videos=[])
    try:
        raw = json.loads(r.stdout or "[]")
    except json.JSONDecodeError:
        return VideoListing(eval_dir=eval_dir, eval_harness=harness, videos=[])
    return VideoListing(
        eval_dir=eval_dir,
        eval_harness=harness,
        videos=[VideoFile.model_validate(item) for item in raw],
    )


class VideoPathError(Exception):
    """Raised when a requested video path can't be safely resolved."""


def resolve_video_path(eval_dir: str, rel_path: str) -> str:
    """Resolve a client-supplied relative path against eval_dir.

    Rejects absolute paths and any `..` traversal that would escape eval_dir
    (as far as lexical normalization can catch — remote symlinks can't be
    resolved here without an extra round-trip). Returns the absolute remote
    path on success.
    """
    if not rel_path or rel_path.startswith("/") or "\x00" in rel_path:
        raise VideoPathError("invalid video path")
    base = os.path.normpath(eval_dir)
    target = os.path.normpath(os.path.join(base, rel_path))
    if target != base and not target.startswith(base + os.sep):
        raise VideoPathError("video path escapes eval dir")
    if not target.endswith(".mp4"):
        raise VideoPathError("not a video file")
    return target


async def remote_file_size(cluster: str, abs_path: str) -> int | None:
    host = (await clusters.load_cluster(cluster)).ssh_alias
    r = await ssh_run(host, f"stat -c %s {shlex.quote(abs_path)}", timeout=15.0)
    if r.returncode != 0:
        return None
    try:
        return int(r.stdout.strip())
    except ValueError:
        return None


def stream_remote_range(cluster: str, abs_path: str, start: int, length: int | None):
    """Async byte generator for `length` bytes of `abs_path` starting at `start`.

    Uses GNU dd's byte-granular skip/count so we transfer only the requested
    window, piped through the multiplexed ssh master.
    """
    quoted = shlex.quote(abs_path)
    if start == 0 and length is None:
        cmd = f"cat {quoted}"
    else:
        cmd = (
            f"dd if={quoted} iflag=skip_bytes,count_bytes "
            f"skip={start} count={length} bs=64k 2>/dev/null"
        )
    return _ssh_bytes(cluster, cmd)


async def _ssh_bytes(cluster: str, cmd: str):
    host = (await clusters.load_cluster(cluster)).ssh_alias
    async for chunk in ssh_stream_bytes(host, cmd):
        yield chunk
