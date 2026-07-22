"""The read_file tool's line numbering must match the finalize integrity count
exactly — a trailing newline must NOT let the agent read a line integrity rejects
(the run-7 off-by-one, split("\\n") phantom line vs splitlines())."""
import base64

from app import db
from app.agent_tools import read_result
from app.linecount import line_count


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def test_trailing_newline_counts_agree():
    text = "a\nb\nc\n"  # 3 lines + trailing newline
    reported = read_result("f.py", text, None, None)["line_count"]
    assert reported == 3
    assert reported == line_count(text)
    assert reported == db._b64_line_count(_b64(text))


def test_no_trailing_newline_counts_agree():
    text = "a\nb\nc"  # 3 lines, no trailing newline
    reported = read_result("f.py", text, None, None)["line_count"]
    assert reported == 3
    assert reported == line_count(text)
    assert reported == db._b64_line_count(_b64(text))


def test_crlf_normalized():
    text = "a\r\nb\r\nc\r\n"
    reported = read_result("f.py", text, None, None)["line_count"]
    assert reported == 3
    assert reported == db._b64_line_count(_b64(text))


def test_read_range_cannot_exceed_integrity_count():
    # The agent asks for one line past EOF on a trailing-newline file; the tool must
    # clamp to the real last line, never expose the phantom line integrity rejects.
    text = "a\nb\nc\n"
    total = db._b64_line_count(_b64(text))  # 3
    res = read_result("f.py", text, 1, total + 1)  # request 1..4
    assert res["range"][1] == total  # clamped to 3
    assert res["line_count"] == total
    # the window holds exactly the real lines, no phantom empty final line
    assert res["text"] == "a\nb\nc"
