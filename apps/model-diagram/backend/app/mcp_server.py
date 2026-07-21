"""Stdio MCP server that exposes the six analysis tools to the Claude Code CLI.

Launched by the CLI (via ``--mcp-config``) as a subprocess of the backend on the
Claude-CLI runtime. It speaks the minimal MCP JSON-RPC handshake over stdio
(newline-delimited JSON messages): ``initialize`` → ``tools/list`` →
``tools/call``.

Design — one source of truth (see the module docstrings in ``agent_cli`` and
``callback``):

- ``list_dir`` / ``read_file`` are answered HERE via the SAME :class:`FsAccess`
  guard as the SDK path, constructed from ``MD_CLUSTER`` + ``MD_ROOT``. The paper
  (when present) is exposed as a virtual read_file path ``__paper__``, backed by
  the text file at ``MD_PAPER_FILE``.
- ``report_stage`` / ``report_problem`` / ``report_paper_mismatch`` /
  ``finalize_diagram`` mutate run state that lives in the parent backend process,
  so they are forwarded over a loopback HTTP callback (``MD_CALLBACK_BASE`` +
  per-run ``MD_CALLBACK_TOKEN``) to the backend's ``/internal/mcp/tool`` endpoint,
  which dispatches them through ``callback.dispatch_tool`` — the exact handlers
  the SDK loop uses.

Run as ``<python> <path-to-this-file>``; it inserts the backend dir on sys.path
so ``from app...`` imports resolve regardless of the CLI's scratch CWD.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

# Make ``app`` importable when launched as a bare script from the CLI's scratch cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402

from app import agent_tools  # noqa: E402
from app.fsaccess import FsAccess  # noqa: E402

_PROTOCOL = "2024-11-05"
_SERVER_NAME = "modeldiagram"
_LOCAL_TOOLS = {"list_dir", "read_file"}
_CALLBACK_TOOLS = {"report_stage", "report_problem", "report_paper_mismatch", "finalize_diagram"}


def _tools() -> list[dict]:
    return [
        {"name": s["name"], "description": s["description"], "inputSchema": s["schema"]}
        for s in agent_tools.tool_specs()
    ]


def _paper_text() -> str | None:
    path = os.environ.get("MD_PAPER_FILE", "").strip()
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def _call_local(fs: FsAccess, name: str, args: dict) -> tuple[dict, bool]:
    if name == "list_dir":
        return await agent_tools.fs_list_dir(fs, args)
    return await agent_tools.fs_read_file(fs, args, paper_text=_paper_text())


def _call_callback(name: str, args: dict) -> tuple[dict, bool]:
    base = os.environ["MD_CALLBACK_BASE"].rstrip("/")
    body = {
        "run_id": int(os.environ["MD_RUN_ID"]),
        "token": os.environ["MD_CALLBACK_TOKEN"],
        "tool": name,
        "args": args,
    }
    try:
        resp = httpx.post(f"{base}/internal/mcp/tool", json=body, timeout=120.0)
    except httpx.HTTPError as exc:
        return {"error": f"callback transport error: {exc}"}, True
    if resp.status_code != 200:
        return {"error": f"callback rejected ({resp.status_code}): {resp.text[:200]}"}, True
    data = resp.json()
    return data.get("result", {}), bool(data.get("is_error", False))


def _dispatch_call(fs: FsAccess, name: str, args: dict) -> tuple[dict, bool]:
    if name in _LOCAL_TOOLS:
        return asyncio.run(_call_local(fs, name, args))
    if name in _CALLBACK_TOOLS:
        return _call_callback(name, args)
    return {"error": f"unknown tool: {name}"}, True


def _tool_result(result: dict, is_error: bool) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": is_error}


def main() -> None:
    # Cluster access is pre-resolved by the backend (which has the user's
    # identity) and handed over as MD_ACCESS_JSON; the worker never reads ssot.db.
    access_raw = os.environ.get("MD_ACCESS_JSON")
    access = json.loads(access_raw) if access_raw else None
    fs = FsAccess(os.environ.get("MD_CLUSTER", "local"), os.environ["MD_ROOT"], access=access)
    tools = _tools()

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = req.get("method")
        rid = req.get("id")

        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": _PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": _SERVER_NAME, "version": "0.1.0"},
            }})
        elif method == "notifications/initialized":
            continue  # notification: no response
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": tools}})
        elif method == "tools/call":
            params = req.get("params") or {}
            name = params.get("name", "")
            args = params.get("arguments") or {}
            try:
                result, is_error = _dispatch_call(fs, name, args)
            except Exception as exc:  # never crash the server on one bad call
                result, is_error = {"error": f"tool failed: {exc}"}, True
            _send({"jsonrpc": "2.0", "id": rid, "result": _tool_result(result, is_error)})
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": rid, "result": {}})
        elif rid is not None:
            _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"method not found: {method}"}})


if __name__ == "__main__":
    main()
