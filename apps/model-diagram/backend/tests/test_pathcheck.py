from app.pathcheck import precheck_path


async def test_dir_ok(tmp_path):
    check = await precheck_path("local", str(tmp_path))
    assert check.ok
    assert check.resolved_root == str(tmp_path.resolve())


async def test_missing_path(tmp_path):
    check = await precheck_path("local", str(tmp_path / "does-not-exist"))
    assert not check.ok
    assert "does not exist" in check.detail


async def test_file_is_not_a_root(tmp_path):
    f = tmp_path / "file.txt"
    f.write_text("x")
    check = await precheck_path("local", str(f))
    assert not check.ok
    assert "not a directory" in check.detail


async def test_empty_path():
    check = await precheck_path("local", "   ")
    assert not check.ok
