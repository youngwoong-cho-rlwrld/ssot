"""Runtime selection: SDK when a key is set, else the CLI, else none."""
import os
import sys

from app import settings


def test_claude_cli_path_override_valid(monkeypatch):
    monkeypatch.setenv("CLAUDE_CLI_PATH", sys.executable)
    assert settings.claude_cli_path() == sys.executable


def test_claude_cli_path_override_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_CLI_PATH", str(tmp_path / "nope"))
    assert settings.claude_cli_path() is None


def test_claude_cli_path_discovered(monkeypatch):
    monkeypatch.delenv("CLAUDE_CLI_PATH", raising=False)
    monkeypatch.setattr(settings.shutil, "which", lambda name: "/usr/local/bin/claude" if name == "claude" else None)
    assert settings.claude_cli_path() == "/usr/local/bin/claude"


def test_runtime_sdk_when_key_present(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert settings.active_runtime() == "sdk"


def test_runtime_cli_when_key_absent_but_cli_present(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CLAUDE_CLI_PATH", sys.executable)
    assert settings.active_runtime() == "claude-cli"


def test_runtime_none_when_neither(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CLAUDE_CLI_PATH", "/definitely/not/here")
    monkeypatch.setattr(settings.shutil, "which", lambda name: None)
    assert settings.active_runtime() == "none"


def test_api_host_port_defaults(monkeypatch):
    monkeypatch.delenv("MODEL_DIAGRAM_API_HOST", raising=False)
    monkeypatch.delenv("MODEL_DIAGRAM_API_PORT", raising=False)
    assert settings.api_host() == "127.0.0.1"
    assert settings.api_port() == 8791


def test_api_port_override(monkeypatch):
    monkeypatch.setenv("MODEL_DIAGRAM_API_PORT", "9999")
    assert settings.api_port() == 9999
    monkeypatch.setenv("MODEL_DIAGRAM_API_PORT", "not-a-number")
    assert settings.api_port() == 8791
