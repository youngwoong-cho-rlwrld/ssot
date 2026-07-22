"""Canonical source line splitting + counting.

ONE definition shared by the ``read_file`` tool (line numbering, the truncation
cut, and the reported ``line_count``) and the finalize integrity check (the max
valid line for a snippet range). A line the agent can read must always exist for
integrity — so both sides count the same way.

Uses ``splitlines()`` semantics on ``\\r\\n``-normalized text: a trailing newline
does NOT create a phantom final line. The old ``read_file`` path used
``split("\\n")``, which appended an empty element after a trailing newline and let
the agent read line N+1 that integrity (``splitlines()``) then rejected as out of
range — the run-7 off-by-one.
"""
from __future__ import annotations


def source_lines(text: str) -> list[str]:
    """Canonical 1-indexed line list for source content."""
    return text.replace("\r\n", "\n").splitlines()


def line_count(text: str) -> int:
    """Authoritative line count — identical on the read and integrity sides."""
    return len(source_lines(text))
