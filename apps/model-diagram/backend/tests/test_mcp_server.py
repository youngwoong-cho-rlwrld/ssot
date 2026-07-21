"""The stdio MCP server: spawn it, drive the handshake, and assert that the
filesystem tools stay root-scoped (the same guard as the SDK path).

Only list_dir/read_file are exercised here — those are answered inside the MCP
subprocess. The four run-state tools forward to the backend over HTTP and are
covered by the shared handler tests via the SDK path.
"""
import json
import os
import subprocess
import sys

import pytest

_SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "mcp_server.py")


class _Server:
    def __init__(self, root: str, paper_file: str | None = None, cluster: str = "local", access_json: str | None = None):
        env = dict(os.environ)
        env.update(
            {
                "MD_CLUSTER": cluster,
                "MD_ROOT": root,
                "MD_RUN_ID": "1",
                "MD_CALLBACK_BASE": "http://127.0.0.1:1",
                "MD_CALLBACK_TOKEN": "unused",
            }
        )
        if access_json:
            env["MD_ACCESS_JSON"] = access_json
        if paper_file:
            env["MD_PAPER_FILE"] = paper_file
        self.proc = subprocess.Popen(
            [sys.executable, _SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        self._id = 0

    def _rpc(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        assert line, f"no response to {method}; stderr={self.proc.stderr.read()}"
        return json.loads(line)

    def notify(self, method: str) -> None:
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.proc.stdin.flush()

    def call_tool(self, name: str, arguments: dict) -> tuple[dict, bool]:
        resp = self._rpc("tools/call", {"name": name, "arguments": arguments})
        result = resp["result"]
        payload = json.loads(result["content"][0]["text"])
        return payload, bool(result.get("isError", False))

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


@pytest.fixture()
def server(tmp_path):
    (tmp_path / "model.py").write_text("import torch\nclass Net: ...\n")
    (tmp_path / "sub").mkdir()
    (tmp_path.parent / "secret.txt").write_text("classified")
    paper = tmp_path / "paper.txt"
    paper.write_text("Table 2: hidden_dim = 512\n")
    srv = _Server(str(tmp_path), paper_file=str(paper))
    init = srv._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
    assert init["result"]["serverInfo"]["name"] == "modeldiagram"
    srv.notify("notifications/initialized")
    yield srv
    srv.close()


def test_tools_list_exposes_six(server):
    resp = server._rpc("tools/list")
    names = {t["name"] for t in resp["result"]["tools"]}
    assert names == {
        "list_dir",
        "read_file",
        "report_stage",
        "report_problem",
        "report_paper_mismatch",
        "finalize_diagram",
    }
    # MCP schema key must be inputSchema, not input_schema.
    assert all("inputSchema" in t for t in resp["result"]["tools"])


def test_list_dir_scoped(server):
    payload, is_error = server.call_tool("list_dir", {"path": ""})
    assert not is_error
    by_name = {e["name"]: e["type"] for e in payload["entries"]}
    assert by_name["model.py"] == "file"
    assert by_name["sub"] == "dir"


def test_read_file_ok(server):
    payload, is_error = server.call_tool("read_file", {"path": "model.py", "start": None, "end": None})
    assert not is_error
    assert "class Net" in payload["text"]
    assert payload["line_count"] == 3


def test_read_file_range(server):
    payload, is_error = server.call_tool("read_file", {"path": "model.py", "start": 2, "end": 2})
    assert not is_error
    assert payload["text"] == "class Net: ..."
    assert payload["range"] == [2, 2]


def test_read_file_escape_rejected(server):
    payload, is_error = server.call_tool("read_file", {"path": "../secret.txt", "start": None, "end": None})
    assert is_error
    assert "rejected" in payload["error"]


def test_list_dir_escape_rejected(server):
    payload, is_error = server.call_tool("list_dir", {"path": "../"})
    assert is_error
    assert "rejected" in payload["error"]


def test_read_paper_virtual_file(server):
    payload, is_error = server.call_tool("read_file", {"path": "__paper__", "start": None, "end": None})
    assert not is_error
    assert "hidden_dim = 512" in payload["text"]


def test_ssh_access_from_env_no_config_lookup():
    """Regression: the worker must consume the pre-resolved MD_ACCESS_JSON and
    take the ssh path — never fail with 'cluster ... is not configured' (which
    is what happened when it tried its own ssot.db lookup with no identity).

    The alias points at a guaranteed-unresolvable .invalid host, so list_dir
    fails with an ssh TRANSPORT error, proving the config lookup was bypassed.
    """
    access = json.dumps({"kind": "ssh", "ssh_alias": "md-test-host.invalid"})
    srv = _Server("/rlwrld2/home/u/model", cluster="kakao", access_json=access)
    try:
        init = srv._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
        assert init["result"]["serverInfo"]["name"] == "modeldiagram"
        srv.notify("notifications/initialized")
        payload, is_error = srv.call_tool("list_dir", {"path": ""})
        assert is_error
        assert "not configured" not in payload["error"]
    finally:
        srv.close()
