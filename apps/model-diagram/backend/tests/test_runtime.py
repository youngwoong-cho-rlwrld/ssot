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


# ── codex CLI discovery + per-model runtime routing ────────────────────────


def test_codex_cli_path_override_valid(monkeypatch):
    monkeypatch.setenv("CODEX_CLI_PATH", sys.executable)
    assert settings.codex_cli_path() == sys.executable


def test_codex_cli_path_override_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_CLI_PATH", str(tmp_path / "nope"))
    assert settings.codex_cli_path() is None


def test_codex_cli_path_discovered(monkeypatch):
    monkeypatch.delenv("CODEX_CLI_PATH", raising=False)
    monkeypatch.setattr(
        settings.shutil, "which", lambda name: "/usr/local/bin/codex" if name == "codex" else None
    )
    assert settings.codex_cli_path() == "/usr/local/bin/codex"


def test_runtime_for_claude_model_prefers_sdk(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert settings.runtime_for_model("claude-fable-5") == "sdk"


def test_runtime_for_claude_model_falls_to_cli(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CLAUDE_CLI_PATH", sys.executable)
    assert settings.runtime_for_model("claude-opus-4-8") == "claude-cli"


def test_runtime_for_codex_model_uses_codex_when_present(monkeypatch):
    # A codex-family id routes to the codex runtime regardless of any claude key.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    assert settings.runtime_for_model("gpt-5.6-sol") == "codex"


def test_runtime_for_codex_model_none_when_cli_absent(monkeypatch):
    monkeypatch.setattr(settings, "codex_cli_path", lambda: None)
    assert settings.runtime_for_model("gpt-5.6-sol") == "none"


def test_available_runtimes_reports_both_families(monkeypatch):
    # available_runtimes is auth-aware, so pin the auth checks explicitly to keep
    # the test hermetic (independent of the host's real ~/.claude / ~/.codex).
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(settings, "claude_cli_path", lambda: "/usr/local/bin/claude")
    monkeypatch.setattr(settings, "claude_cli_authenticated", lambda: True)
    monkeypatch.setattr(settings, "codex_cli_path", lambda: None)
    assert settings.available_runtimes() == {"claude": "cli", "codex": None}
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    monkeypatch.setattr(settings, "codex_authenticated", lambda: True)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert settings.available_runtimes() == {"claude": "sdk", "codex": "cli"}


# ── auth-aware runtime availability ────────────────────────────────────────
# The health probe must report an installed-but-unauthenticated CLI as
# unavailable (so the UI prompts for login before a run), while distinguishing
# that "unauthenticated" state from "missing". Detection is a filesystem check
# against fake home dirs (CODEX_HOME / CLAUDE_CONFIG_DIR).


def test_codex_authenticated_true_when_auth_json_present(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "auth.json").write_text("{}", encoding="utf-8")
    assert settings.codex_authenticated() is True


def test_codex_authenticated_false_when_auth_json_absent(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    assert settings.codex_authenticated() is False


def test_codex_authenticated_true_with_openai_api_key(monkeypatch, tmp_path):
    # An env key is an alternate codex credential even without auth.json.
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")
    assert settings.codex_authenticated() is True


def test_claude_authenticated_via_credentials_file(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    (tmp_path / ".credentials.json").write_text("{}", encoding="utf-8")
    assert settings.claude_cli_authenticated() is True


def test_claude_authenticated_via_oauth_account_object(monkeypatch, tmp_path):
    # macOS keeps tokens in the Keychain; the logged-in account is recorded as a
    # non-null oauthAccount object in <config-dir>/.claude.json.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    (tmp_path / ".claude.json").write_text(
        '{"oauthAccount": {"emailAddress": "a@b.c"}}', encoding="utf-8"
    )
    assert settings.claude_cli_authenticated() is True


def test_claude_unauthenticated_when_oauth_account_null(monkeypatch, tmp_path):
    # A logged-out config may carry a null oauthAccount — not authenticated.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    (tmp_path / ".claude.json").write_text('{"oauthAccount": null}', encoding="utf-8")
    assert settings.claude_cli_authenticated() is False


def test_claude_unauthenticated_when_no_markers(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    assert settings.claude_cli_authenticated() is False


def test_available_runtimes_hides_unauthenticated_cli(monkeypatch):
    # CLI present but not logged in → reported unavailable (null), not "cli".
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(settings, "claude_cli_path", lambda: "/usr/local/bin/claude")
    monkeypatch.setattr(settings, "claude_cli_authenticated", lambda: False)
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    monkeypatch.setattr(settings, "codex_authenticated", lambda: False)
    assert settings.available_runtimes() == {"claude": None, "codex": None}


def test_runtime_status_distinguishes_missing_from_unauthenticated(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # claude: installed but logged out → unauthenticated; codex: not installed → missing.
    monkeypatch.setattr(settings, "claude_cli_path", lambda: "/usr/local/bin/claude")
    monkeypatch.setattr(settings, "claude_cli_authenticated", lambda: False)
    monkeypatch.setattr(settings, "codex_cli_path", lambda: None)
    assert settings.runtime_status() == {"claude": "unauthenticated", "codex": "missing"}
    # Both ready.
    monkeypatch.setattr(settings, "claude_cli_authenticated", lambda: True)
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    monkeypatch.setattr(settings, "codex_authenticated", lambda: True)
    assert settings.runtime_status() == {"claude": "ready", "codex": "ready"}


def test_runtime_status_sdk_is_ready(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert settings.runtime_status()["claude"] == "ready"


def test_available_model_catalog_unaffected_by_codex_auth(monkeypatch):
    # The models list stays presence-gated: an installed-but-unauthenticated codex
    # CLI still lists its models (the user can log in via the modal, then run).
    monkeypatch.setattr(settings, "anthropic_api_key", lambda: "sk-test")
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    monkeypatch.setattr(settings, "codex_authenticated", lambda: False)
    ids = {m["id"] for m in settings.available_model_catalog()}
    assert "gpt-5.6-sol" in ids


def test_available_model_catalog_filters_codex(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", lambda: "sk-test")
    monkeypatch.setattr(settings, "codex_cli_path", lambda: None)
    ids = {m["id"] for m in settings.available_model_catalog()}
    assert "gpt-5.6-sol" not in ids
    assert "claude-fable-5" in ids
    monkeypatch.setattr(settings, "codex_cli_path", lambda: "/usr/local/bin/codex")
    ids = {m["id"] for m in settings.available_model_catalog()}
    assert "gpt-5.6-sol" in ids


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
