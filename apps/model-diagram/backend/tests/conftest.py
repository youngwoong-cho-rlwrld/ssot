import pytest


@pytest.fixture()
def tmp_env(tmp_path, monkeypatch):
    """Point the backend's data dir + papers dir at an isolated temp location."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("SSOT_DATA_DIR", str(data_dir))
    monkeypatch.setenv("MODEL_DIAGRAM_PAPERS_DIR", str(tmp_path / "papers"))
    return data_dir
