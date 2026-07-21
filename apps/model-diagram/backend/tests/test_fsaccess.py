import pytest

from app.fsaccess import FsAccess, FsError, PathEscape


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
