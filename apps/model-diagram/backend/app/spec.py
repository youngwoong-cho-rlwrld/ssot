"""Loads the embedded spec_with_stages.md used as the agent's system guidance."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_SPEC_PATH = Path(__file__).parent / "spec_with_stages.md"


@lru_cache(maxsize=1)
def load_spec() -> str:
    return _SPEC_PATH.read_text(encoding="utf-8")
