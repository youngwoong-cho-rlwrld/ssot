#!/usr/bin/env python3
"""Token-free pre-gate for the train-completion-watch agent cron.

Runs as a cheap OpenClaw command cron every few minutes. It checks whether the
Post-training pipeline agent turn would have anything to do — a terminal train
job that is not yet recorded in the pipeline state file, or a Slack button
card still awaiting delivery verification — and only then triggers the LLM
agent cron via ``openclaw cron run``. Idle cycles therefore cost zero model
tokens.

A trigger damper (``--min-trigger-minutes``) caps how often the agent turn can
be re-triggered while work is pending, so a stuck card cannot burn an agent
turn on every gate tick.

The SSOT train-eval backend scopes cluster settings per user, so every API
request carries the ``x-ssot-user`` header.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Slurm/MLXP terminal-state prefixes (sacct may suffix, e.g. "CANCELLED by
# <uid>"); COMPLETING is active and must not match, so COMPLETED is exact.
_TERMINAL_PREFIXES = (
    "FAIL",
    "TIMEOUT",
    "OUT_OF_MEMORY",
    "NODE_FAIL",
    "PREEMPT",
    "CANCEL",
    "BOOT_FAIL",
    "DEADLINE",
)


def _is_terminal(state: str) -> bool:
    u = (state or "").split(" ")[0].upper()
    return u == "COMPLETED" or u.startswith(_TERMINAL_PREFIXES)


def _fetch_jobs(api_base: str, user: str, hours: int, timeout: float) -> list[dict]:
    req = urllib.request.Request(
        f"{api_base.rstrip('/')}/api/jobs?hours={hours}",
        headers={"x-ssot-user": user},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read())
    jobs = payload.get("jobs")
    if not isinstance(jobs, list):
        raise ValueError("malformed /api/jobs response: no jobs list")
    return jobs


def _load_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"malformed state file {path}: expected object")
    return data


def _pending_reasons(jobs: list[dict], state: dict) -> list[str]:
    reasons = []
    for job in jobs:
        if job.get("phase") != "train" or not _is_terminal(job.get("state", "")):
            continue
        key = f"{job.get('cluster')}/{job.get('job_id')}"
        if key not in state:
            reasons.append(f"unprocessed terminal train job {key} ({job.get('state')})")
    for key, record in state.items():
        # The pipeline marks a card that still needs Slack-side verification
        # with prompt_delivery_pending; match anywhere in the record so the
        # gate does not depend on the exact field name the agent used.
        if "prompt_delivery_pending" in json.dumps(record):
            reasons.append(f"pending card verification for {key}")
    return reasons


def _damper_ok(marker: Path, min_minutes: float) -> bool:
    try:
        return (time.time() - marker.stat().st_mtime) >= min_minutes * 60
    except FileNotFoundError:
        return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", default="http://127.0.0.1:8000")
    parser.add_argument("--ssot-user", default="youngwoong.cho@rlwrld.ai")
    parser.add_argument("--hours", type=int, default=48)
    parser.add_argument("--api-timeout-seconds", type=float, default=30.0)
    parser.add_argument(
        "--state-file",
        default="~/.openclaw/workspace/state/train-watch.json",
    )
    parser.add_argument(
        "--trigger-cron-id",
        help="OpenClaw cron job id of the train-completion-watch agent job",
    )
    parser.add_argument("--openclaw-bin", default="openclaw")
    parser.add_argument(
        "--min-trigger-minutes",
        type=float,
        default=15.0,
        help="Do not re-trigger the agent job more often than this",
    )
    parser.add_argument(
        "--marker-file",
        default="~/.train-eval-web/train-watch-gate.last",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report the decision without triggering the agent cron",
    )
    args = parser.parse_args()

    try:
        jobs = _fetch_jobs(
            args.api_base, args.ssot_user, args.hours, args.api_timeout_seconds
        )
        state = _load_state(Path(args.state_file).expanduser())
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    reasons = _pending_reasons(jobs, state)
    marker = Path(args.marker_file).expanduser()
    result = {"work": bool(reasons), "reasons": reasons[:10], "triggered": False}

    if reasons and not _damper_ok(marker, args.min_trigger_minutes):
        result["damped"] = True
    elif reasons and args.dry_run:
        result["dry_run"] = True
    elif reasons:
        if not args.trigger_cron_id:
            print(json.dumps({"error": "work found but no --trigger-cron-id"}))
            return 1
        proc = subprocess.run(
            [args.openclaw_bin, "cron", "run", args.trigger_cron_id],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode != 0:
            print(json.dumps({"error": f"cron run failed: {proc.stderr.strip()[:300]}"}))
            return 1
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        result["triggered"] = True

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
