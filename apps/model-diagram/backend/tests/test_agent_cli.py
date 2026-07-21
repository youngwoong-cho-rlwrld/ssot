"""agent_cli internals: stdout pumping must tolerate huge stream-json lines.

Regression: the finalize_diagram assistant message carries base64 source
contents on a single stdout line that exceeds asyncio's 64KB readline limit.
The old ``async for line in proc.stdout`` raised LimitOverrunError, killing the
pump and leaving the CLI blocked on a full pipe until the run timed out.
"""
import asyncio

import pytest

from app import agent_cli


class _FakeProc:
    def __init__(self, reader: asyncio.StreamReader):
        self.stdout = reader


async def _feed(*lines: bytes) -> asyncio.StreamReader:
    reader = asyncio.StreamReader()
    for line in lines:
        reader.feed_data(line)
    reader.feed_eof()
    return reader


async def test_pump_tolerates_line_over_64kb_and_captures_result():
    huge = b'{"type":"assistant","message":{"blob":"' + (b"A" * 200_000) + b'"}}\n'
    result_line = b'{"type":"result","subtype":"success","is_error":false,"result":"done"}\n'
    reader = await _feed(huge, result_line)

    result_event: dict = {}
    await agent_cli._pump_stdout(_FakeProc(reader), result_event, None)

    assert result_event.get("result", {}).get("subtype") == "success"
    assert result_event["result"]["is_error"] is False


async def test_pump_captures_init_and_result():
    reader = await _feed(
        b'{"type":"system","subtype":"init","mcp_servers":[{"name":"modeldiagram","status":"connected"}]}\n',
        b'{"type":"system","subtype":"thinking_tokens","estimated_tokens":100}\n',
        b'{"type":"result","subtype":"error_during_execution","is_error":true}\n',
    )
    result_event: dict = {}
    await agent_cli._pump_stdout(_FakeProc(reader), result_event, None)

    assert result_event["init"]["mcp_servers"][0]["status"] == "connected"
    assert result_event["result"]["is_error"] is True


async def test_effort_defaults_and_override(monkeypatch):
    monkeypatch.delenv("MODEL_DIAGRAM_CLI_EFFORT", raising=False)
    assert agent_cli._effort() == "high"
    monkeypatch.setenv("MODEL_DIAGRAM_CLI_EFFORT", "low")
    assert agent_cli._effort() == "low"
    monkeypatch.setenv("MODEL_DIAGRAM_CLI_EFFORT", "bogus")
    assert agent_cli._effort() == "high"  # invalid falls back to high
