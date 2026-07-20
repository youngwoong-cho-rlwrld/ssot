"""Background poller that refreshes the SQLite cache (cache_db.py).

Two independent loops run from the FastAPI lifespan: a fast one polling job
state (default 45s) and a slow one scanning eval results (default 300s). Each
cycle reuses the existing live fetch paths (``jobs.list_jobs`` /
``results.list_results``) one cluster at a time so a single unreachable cluster
can't fail the whole cycle — its failure is recorded in ``poll_meta`` and the
last good data keeps being served (stale, but present).

Env gates:
  TRAIN_EVAL_POLLER        "1" (default) enables the poller; "0" disables it,
                           in which case the API falls back to live fetches and
                           the backend behaves exactly as it did before.
  TRAIN_EVAL_JOBS_POLL_S   jobs loop interval, seconds (default 45)
  TRAIN_EVAL_RESULTS_POLL_S results loop interval, seconds (default 300)
"""

from __future__ import annotations

import asyncio
import os
import time

from . import cache_db, clusters, settings_db, user_context


def poller_enabled() -> bool:
    return os.environ.get("TRAIN_EVAL_POLLER", "1") != "0"


def jobs_poll_interval() -> float:
    return float(os.environ.get("TRAIN_EVAL_JOBS_POLL_S", "45"))


def results_poll_interval() -> float:
    return float(os.environ.get("TRAIN_EVAL_RESULTS_POLL_S", "300"))


# Jobs kept as a recent-history window for the default cached view: active jobs
# plus terminal jobs seen in the last 24h, mirroring today's sacct window.
DEFAULT_JOBS_WINDOW_HOURS = 24

# Fire-and-forget poll tasks (job-action triggers) kept referenced so the event
# loop doesn't garbage-collect them mid-flight.
_pending: set[asyncio.Task] = set()
_results_inflight: dict[tuple[str, str, str], asyncio.Task] = {}


async def poll_jobs_once(cluster: str, email: str | None = None) -> None:
    """Refresh one cluster's jobs into the cache. Never raises."""
    from . import jobs as jobs_mod

    scope = user_context.normalize_email(email) or ""
    with user_context.user_scope(email):
        fingerprints = clusters.cache_fingerprints()
        await cache_db.sync_cluster_configs(fingerprints, scope=scope)
        fingerprint = fingerprints.get(cluster)
        if fingerprint is None:
            return
        t0 = time.monotonic()
        try:
            rows = await jobs_mod.list_jobs([cluster], hours=DEFAULT_JOBS_WINDOW_HOURS)
        except Exception as exc:  # noqa: BLE001 - isolate per-cluster failure
            await cache_db.record_poll(
                cluster, "jobs", ok=False,
                error=str(exc) or type(exc).__name__,
                duration_ms=int((time.monotonic() - t0) * 1000),
                scope=scope,
            )
            return
        if clusters.cache_fingerprints().get(cluster) != fingerprint:
            await cache_db.sync_cluster_configs(
                clusters.cache_fingerprints(), scope=scope
            )
            return
        await cache_db.upsert_jobs(cluster, rows, scope=scope)
        await cache_db.record_poll(
            cluster, "jobs", ok=True, error=None,
            duration_ms=int((time.monotonic() - t0) * 1000),
            scope=scope,
        )


async def refresh_results(cluster: str, email: str | None = None):
    """Scan and persist one cluster's eval results.

    This is shared by the background poller and the explicit ``fresh=1`` API
    path so a manual refresh cannot return data that is newer than the durable
    cache. Concurrent refreshes for the same cluster await one shared scan;
    different clusters still scan concurrently.

    A scan-level error is returned in the regular ResultsResponse while the
    last good cache row is preserved and returned with the current error.
    """
    scope = user_context.normalize_email(email) or ""
    with user_context.user_scope(email):
        fingerprints = clusters.cache_fingerprints()
    await cache_db.sync_cluster_configs(fingerprints, scope=scope)
    fingerprint = fingerprints.get(cluster)
    if fingerprint is None:
        return await _cached_results_with_error(
            cluster, f"Cluster env for {cluster} is not configured", scope=scope
        )
    inflight_key = (scope, cluster, fingerprint)
    task = _results_inflight.get(inflight_key)
    if task is None:
        task = asyncio.create_task(_refresh_results_once(cluster, email, fingerprint))
        _results_inflight[inflight_key] = task

        def clear(
            completed: asyncio.Task, target: tuple[str, str, str] = inflight_key
        ) -> None:
            if _results_inflight.get(target) is completed:
                _results_inflight.pop(target, None)

        task.add_done_callback(clear)
    # One caller disconnecting must not cancel the refresh shared by the
    # background poller and other API callers.
    return await asyncio.shield(task)


async def _refresh_results_once(
    cluster: str, email: str | None = None, fingerprint: str | None = None
):
    from . import results as results_mod

    scope = user_context.normalize_email(email) or ""
    with user_context.user_scope(email):
        t0 = time.monotonic()
        try:
            resp = await results_mod.list_results(cluster)
        except Exception as exc:
            error = str(exc) or type(exc).__name__
            await cache_db.record_poll(
                cluster, "results", ok=False, error=error,
                duration_ms=int((time.monotonic() - t0) * 1000),
                scope=scope,
            )
            return await _cached_results_with_error(cluster, error, scope=scope)

        duration_ms = int((time.monotonic() - t0) * 1000)
        error = next((item.error for item in resp.errors if item.cluster == cluster), None)
        if error:
            await cache_db.record_poll(
                cluster, "results", ok=False, error=error, duration_ms=duration_ms,
                scope=scope,
            )
            return await _cached_results_with_error(cluster, error, scope=scope)

        current_fingerprints = clusters.cache_fingerprints()
        if fingerprint is not None and current_fingerprints.get(cluster) != fingerprint:
            await cache_db.sync_cluster_configs(current_fingerprints, scope=scope)
            return await _cached_results_with_error(
                cluster, "Cluster settings changed during refresh.", scope=scope
            )

        fetched_at = time.time()
        variants = [variant.model_dump() for variant in resp.variants]
        errors = [item.model_dump() for item in resp.errors]
        await cache_db.write_results(
            cluster, variants, errors,
            fetched_at=fetched_at, duration_ms=duration_ms, error=None,
            scope=scope,
        )
        await cache_db.record_poll(
            cluster, "results", ok=True, error=None, duration_ms=duration_ms,
            scope=scope,
        )
        resp.fetched_at = {cluster: fetched_at}
        resp.stale = False
        return resp


async def _cached_results_with_error(
    cluster: str, error: str, *, scope: str = ""
):
    """Return the last good snapshot plus the current refresh error."""
    from . import results as results_mod

    cached = (await cache_db.read_results([cluster], scope=scope)).get(cluster)
    variants = []
    previous_errors = []
    fetched_at: dict[str, float] = {}
    if cached is not None:
        try:
            variants = [
                results_mod.ResultVariant.model_validate(item)
                for item in cached["variants"]
            ]
            previous_errors = [
                results_mod.ClusterResultError.model_validate(item)
                for item in cached["errors"]
                if item.get("cluster") != cluster
            ]
            fetched_at[cluster] = cached["fetched_at"]
        except (TypeError, ValueError):
            variants = []
            previous_errors = []
            fetched_at = {}
    return results_mod.ResultsResponse(
        clusters=[cluster],
        variants=variants,
        errors=[
            *previous_errors,
            results_mod.ClusterResultError(cluster=cluster, error=error),
        ],
        fetched_at=fetched_at,
        stale=True,
    )


async def poll_results_once(cluster: str, email: str | None = None) -> None:
    """Refresh one cluster's eval results into the cache. Never raises.

    ``results.list_results`` swallows per-cluster failures into ``.errors``
    rather than raising, so a failed scan yields an empty variant list. We must
    NOT overwrite good cached data with that emptiness — on error we record the
    failure and leave the previous fragment in place (served stale).
    """
    try:
        await refresh_results(cluster, email)
    except Exception:  # noqa: BLE001 - failure was recorded by refresh_results
        return


def schedule_jobs_poll(cluster: str) -> None:
    """Fire-and-forget an immediate jobs refresh for a cluster.

    Called after a successful submit/cancel/resume so the cached jobs list
    reflects the mutation without waiting for the next poll cycle. No-op when
    the poller is disabled (the API is serving live in that mode anyway).
    """
    if not poller_enabled():
        return
    try:
        task = asyncio.create_task(
            poll_jobs_once(cluster, user_context.current_user_email())
        )
    except RuntimeError:
        # No running loop (e.g. called from a sync/test context) — skip.
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


def schedule_results_poll(cluster: str) -> None:
    """Start one scoped Results refresh without blocking the request."""
    if not poller_enabled():
        return
    try:
        task = asyncio.create_task(
            poll_results_once(cluster, user_context.current_user_email())
        )
    except RuntimeError:
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def _poll_all(kind: str) -> None:
    poll = poll_jobs_once if kind == "jobs" else poll_results_once
    tasks = []
    for email in settings_db.list_principals("train-eval"):
        with user_context.user_scope(email):
            fingerprints = clusters.cache_fingerprints()
            await cache_db.sync_cluster_configs(
                fingerprints, scope=user_context.normalize_email(email) or ""
            )
            tasks.extend(poll(cluster, email) for cluster in fingerprints)
    await asyncio.gather(*tasks, return_exceptions=True)


async def _loop(kind: str, interval: float, initial_delay: float = 0.0) -> None:
    if initial_delay:
        await asyncio.sleep(initial_delay)
    while True:
        try:
            await _poll_all(kind)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            print(f"[poller] {kind} cycle failed: {exc}")
        await asyncio.sleep(interval)


async def run() -> None:
    """Entry point for the lifespan task. Returns immediately if disabled."""
    if not poller_enabled():
        return
    await cache_db.init()
    # Stagger results behind jobs so the two heavy cycles don't fire together
    # on startup.
    jobs_task = asyncio.create_task(_loop("jobs", jobs_poll_interval()))
    results_task = asyncio.create_task(
        _loop("results", results_poll_interval(), initial_delay=3.0)
    )
    try:
        await asyncio.gather(jobs_task, results_task)
    except asyncio.CancelledError:
        jobs_task.cancel()
        results_task.cancel()
        await asyncio.gather(jobs_task, results_task, return_exceptions=True)
        raise
