import json

import pytest


# ── shared fake-codex harness (used by test_agent_codex + test_chat) ──────────
# The live codex invocation needs the CLI + network; these fakes let the runtime
# drivers (run_agent_codex / run_chat_codex) be exercised end to end by feeding a
# canned --json event stream through a stand-in child process.


class FakeStream:
    """A one-shot async byte stream: yields ``data`` once, then EOF."""

    def __init__(self, data: bytes = b""):
        self._data, self._sent = data, False

    async def read(self, n: int = -1) -> bytes:
        if self._sent:
            return b""
        self._sent = True
        return self._data


class FakeStdin:
    def write(self, b):
        pass

    async def drain(self):
        pass

    def close(self):
        pass


class FakeCodexProc:
    """Stand-in for the ``codex exec`` child: stdout replays canned JSONL events."""

    def __init__(self, stdout_bytes: bytes):
        self.stdout = FakeStream(stdout_bytes)
        self.stderr = FakeStream(b"")
        self.stdin = FakeStdin()
        self.returncode = None

    async def wait(self):
        self.returncode = 0
        return 0

    def terminate(self):
        self.returncode = 0

    def kill(self):
        self.returncode = 0


def codex_stream(*events) -> bytes:
    """Serialize codex ``--json`` events to newline-delimited JSONL bytes."""
    return b"".join((json.dumps(e) + "\n").encode() for e in events)


@pytest.fixture()
def install_fake_codex(monkeypatch):
    """Return an installer ``(events, capture) -> None`` that stubs codex spawning.

    Patches ``asyncio.create_subprocess_exec`` to return a :class:`FakeCodexProc`
    replaying ``events`` (recording the argv into ``capture['cmd']``) and makes the
    codex CLI look present.
    """
    from app import settings

    def _install(events, capture):
        async def fake_exec(*cmd, **kw):
            capture["cmd"] = list(cmd)
            return FakeCodexProc(codex_stream(*events))

        monkeypatch.setattr("asyncio.create_subprocess_exec", fake_exec)
        monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")

    return _install


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
