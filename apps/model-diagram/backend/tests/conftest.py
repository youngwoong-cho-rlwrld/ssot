import pytest


@pytest.fixture(autouse=True)
def _disable_geometry_pass(monkeypatch):
    """Keep the headless-Chrome geometry pass out of the test path by default.

    Set in os.environ (not just the process) so the MCP/chat subprocess tests,
    which spawn with ``env=dict(os.environ)``, inherit the skip. The dedicated
    geometry tests exercise the pass explicitly.
    """
    monkeypatch.setenv("MODEL_DIAGRAM_GEOMETRY_PASS", "0")


@pytest.fixture()
def tmp_env(tmp_path, monkeypatch):
    """Point the backend's data dir + papers dir at an isolated temp location."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("SSOT_DATA_DIR", str(data_dir))
    monkeypatch.setenv("MODEL_DIAGRAM_PAPERS_DIR", str(tmp_path / "papers"))
    return data_dir
