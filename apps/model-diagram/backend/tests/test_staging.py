"""Local mirroring of a remote root for the codex runtime (app.staging).

The transport (ssh/kubectl tar stream) is faked by running the SAME tar command
LOCALLY, so the real exclude rules + streaming cap + FsAccess-on-mirror are
exercised end to end without a cluster.
"""
import asyncio
import os

import pytest

from app import staging
from app.fsaccess import FsAccess, FsError


def _make_remote(tmp_path, *, pt_bytes=10_000_000, code_bytes=40):
    """A fake 'remote' repo: code + a big weight file + wandb + a bulky .git store."""
    root = tmp_path / "remote"
    (root / "src").mkdir(parents=True)
    (root / "src" / "net.py").write_text("x = 1\n" * (code_bytes // 6 + 1))
    (root / "configs").mkdir()
    (root / "configs" / "train.yaml").write_text("lr: 0.001\n")
    (root / "checkpoints").mkdir()
    (root / "checkpoints" / "model.pt").write_bytes(b"\x00" * pt_bytes)
    (root / "wandb" / "run").mkdir(parents=True)
    (root / "wandb" / "run" / "log.txt").write_text("noise\n")
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (root / ".git" / "refs" / "heads").mkdir(parents=True)
    (root / ".git" / "refs" / "heads" / "main").write_text("abc1234def\n")
    (root / ".git" / "objects").mkdir()
    (root / ".git" / "objects" / "big.pack").write_bytes(b"\x00" * 5_000_000)
    return root


def _fake_producer_from_local():
    """A _producer_stream replacement that runs the tar cmd on the LOCAL fs."""
    async def producer(access, cmd):
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk
        await proc.wait()
    return producer


async def test_stage_excludes_artifacts_keeps_code(tmp_path, monkeypatch):
    root = _make_remote(tmp_path)  # 10MB .pt + 5MB .git/objects, tiny code
    monkeypatch.setattr(staging, "_producer_stream", _fake_producer_from_local())
    dest = tmp_path / "stage"
    dest.mkdir()

    # Cap is 2MB: it must NOT trip, because the weight + git object stores are
    # excluded and only the few-byte code/config survive.
    mirror = await staging.stage_root(
        {"kind": "ssh", "ssh_alias": "x"}, str(root), str(dest), size_cap_bytes=2_000_000
    )

    assert os.path.isfile(os.path.join(mirror, "src", "net.py"))
    assert os.path.isfile(os.path.join(mirror, "configs", "train.yaml"))
    text = await FsAccess("local", mirror).read_file("src/net.py")
    assert "x = 1" in text
    # artifacts + heavy dirs excluded
    assert not os.path.exists(os.path.join(mirror, "checkpoints", "model.pt"))
    assert not os.path.exists(os.path.join(mirror, "wandb"))
    # commit pinning preserved: HEAD + refs kept, object store dropped
    assert os.path.isfile(os.path.join(mirror, ".git", "HEAD"))
    assert os.path.isfile(os.path.join(mirror, ".git", "refs", "heads", "main"))
    assert not os.path.exists(os.path.join(mirror, ".git", "objects", "big.pack"))


async def test_stage_cap_enforced_during_stream(tmp_path, monkeypatch):
    # All-code root whose text exceeds a tiny cap → clean StagingError mid-transfer.
    root = tmp_path / "remote"
    (root / "src").mkdir(parents=True)
    (root / "src" / "big.py").write_text("# code line\n" * 500)  # ~6 KB of code
    monkeypatch.setattr(staging, "_producer_stream", _fake_producer_from_local())
    dest = tmp_path / "stage"
    dest.mkdir()
    with pytest.raises(staging.StagingError) as exc:
        await staging.stage_root(
            {"kind": "ssh", "ssh_alias": "x"}, str(root), str(dest), size_cap_bytes=500
        )
    assert "staging cap" in str(exc.value)


async def test_producer_closed_on_cap_exceed(tmp_path, monkeypatch):
    # Regression: on a cap hit (or any abort) the tar producer stream must be closed
    # so the ssh/kubectl child feeding it does not linger. A fake producer records
    # that its GeneratorExit cleanup fired.
    closed = {"v": False}

    async def leaky_producer(access, cmd):
        try:
            while True:
                yield b"\x00" * 4096  # never-ending → forces the cap abort
        finally:
            closed["v"] = True  # aclose() raises GeneratorExit → this runs

    monkeypatch.setattr(staging, "_producer_stream", leaky_producer)
    dest = tmp_path / "stage"
    dest.mkdir()
    with pytest.raises(staging.StagingError):
        await staging.stage_root(
            {"kind": "ssh", "ssh_alias": "x"}, "/whatever", str(dest), size_cap_bytes=1024
        )
    assert closed["v"] is True  # the producer was closed on the abort path


async def test_stage_empty_mirror_is_error(tmp_path, monkeypatch):
    async def empty_producer(access, cmd):
        yield b"\x00" * 1024  # a minimal valid empty tar archive
    monkeypatch.setattr(staging, "_producer_stream", empty_producer)
    dest = tmp_path / "stage"
    dest.mkdir()
    with pytest.raises(staging.StagingError):
        await staging.stage_root(
            {"kind": "ssh", "ssh_alias": "x"}, "/whatever", str(dest), size_cap_bytes=10_000_000
        )


async def test_fsaccess_excluded_artifact_read_message(tmp_path):
    # A mirror missing an excluded artifact: reading it explains WHY, not not-found.
    mirror = tmp_path / "root"
    (mirror / "checkpoints").mkdir(parents=True)
    fs = FsAccess("local", str(mirror), staged_excludes=staging.excluded_file_globs())
    with pytest.raises(FsError) as exc:
        await fs.read_file("checkpoints/model.pt")
    assert "excluded from the codex staging mirror" in str(exc.value)


async def test_fsaccess_missing_non_artifact_is_plain_error(tmp_path):
    mirror = tmp_path / "root"
    mirror.mkdir()
    fs = FsAccess("local", str(mirror), staged_excludes=staging.excluded_file_globs())
    with pytest.raises(FsError) as exc:
        await fs.read_file("src/gone.py")  # not an excluded pattern
    assert "excluded from the codex staging mirror" not in str(exc.value)
