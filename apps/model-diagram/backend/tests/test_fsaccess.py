import pytest

from app import fsaccess
from app.clusters import ClusterEnv
from app.fsaccess import ClusterAccessError, FsAccess, FsError, PathEscape, resolve_access
from app.ssh import SSHResult


async def test_local_list_and_read(tmp_path):
    (tmp_path / "a.py").write_text("x = 1\ny = 2\n")
    (tmp_path / "sub").mkdir()
    fs = FsAccess("local", str(tmp_path))

    entries = await fs.list_dir("")
    by_name = {e["name"]: e["kind"] for e in entries}
    assert by_name["a.py"] == "file"
    assert by_name["sub"] == "dir"

    text = await fs.read_file("a.py")
    assert text == "x = 1\ny = 2\n"


async def test_probe_root(tmp_path):
    fs = FsAccess("local", str(tmp_path))
    assert await fs.probe_root() == "dir"
    missing = FsAccess("local", str(tmp_path / "nope"))
    assert await missing.probe_root() is None


async def test_reject_dotdot_escape(tmp_path):
    (tmp_path.parent / "secret.txt").write_text("nope")
    fs = FsAccess("local", str(tmp_path))
    with pytest.raises(PathEscape):
        await fs.read_file("../secret.txt")


async def test_reject_absolute_outside(tmp_path):
    fs = FsAccess("local", str(tmp_path))
    with pytest.raises(PathEscape):
        await fs.read_file("/etc/hostname")


async def test_reject_symlink_escape(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("classified")
    (root / "link").symlink_to(secret)
    fs = FsAccess("local", str(root))
    with pytest.raises(PathEscape):
        await fs.read_file("link")


async def test_reject_oversize(tmp_path):
    (tmp_path / "big").write_text("0123456789")
    fs = FsAccess("local", str(tmp_path))
    with pytest.raises(FsError):
        await fs.read_file("big", max_bytes=3)


async def test_remote_path_guard_is_lexical(tmp_path):
    # No transport is exercised; the guard must reject before any remote call.
    fs = FsAccess("kakao", "/rlwrld2/home/u/model")
    with pytest.raises(PathEscape):
        await fs.read_file("../../etc/passwd")
    with pytest.raises(PathEscape):
        await fs.read_file("/etc/passwd")


# ── pre-resolved access (the cluster-propagation fix) ────────────────────────


async def test_preresolved_ssh_access_bypasses_settings_lookup(monkeypatch):
    """With access passed in, list_dir takes the ssh path and NEVER calls
    load_cluster — the bug was the out-of-process worker doing that lookup with
    no identity, yielding 'cluster kakao is not configured'."""
    calls: dict = {}

    async def fake_ssh_run(host, cmd, timeout=60.0, input_text=None):
        calls["host"] = host
        calls["cmd"] = cmd
        return SSHResult(returncode=0, stdout="a.py\nsub/\n", stderr="")

    def boom(*_a, **_k):
        raise AssertionError("load_cluster must not be called when access is pre-resolved")

    monkeypatch.setattr(fsaccess, "ssh_run", fake_ssh_run)
    monkeypatch.setattr(fsaccess, "load_cluster", boom)

    fs = FsAccess("kakao", "/rlwrld2/home/u/model", access={"kind": "ssh", "ssh_alias": "kakao-login-1"})
    entries = await fs.list_dir("")
    by_name = {e["name"]: e["kind"] for e in entries}
    assert by_name == {"a.py": "file", "sub": "dir"}
    assert calls["host"] == "kakao-login-1"


async def test_resolve_access_local():
    assert await resolve_access("local") == {"kind": "local"}


async def test_resolve_access_ssh(monkeypatch):
    async def fake_load_cluster(name):
        return ClusterEnv(name=name, vars={"SSH_ALIAS": "kakao-login-2"})

    monkeypatch.setattr(fsaccess, "load_cluster", fake_load_cluster)
    assert await resolve_access("kakao") == {"kind": "ssh", "ssh_alias": "kakao-login-2"}


async def test_resolve_access_unconfigured_is_actionable(monkeypatch):
    async def missing(name):
        raise FileNotFoundError(f"cluster {name} is not configured")

    monkeypatch.setattr(fsaccess, "load_cluster", missing)
    with pytest.raises(ClusterAccessError) as excinfo:
        await resolve_access("kakao")
    msg = str(excinfo.value)
    assert "not configured" in msg
    assert "Settings" in msg  # actionable: points the user at cluster settings


async def test_resolve_access_ssh_missing_alias(monkeypatch):
    async def no_alias(name):
        return ClusterEnv(name=name, vars={"PARTITION": "gpu"})

    monkeypatch.setattr(fsaccess, "load_cluster", no_alias)
    with pytest.raises(ClusterAccessError) as excinfo:
        await resolve_access("kakao")
    assert "SSH_ALIAS" in str(excinfo.value)
