"""Per-user W&B credentials and project settings endpoints."""
from __future__ import annotations


import asyncio
from pydantic import BaseModel

from .wandb_config import get_api_key, get_project, project_scope, set_api_key, set_project


class WandbStatus(BaseModel):
    logged_in: bool
    entity: str | None = None
    project: str
    error: str | None = None
    # Additive: "user" when `project` came from a per-user overlay, else
    # "global". Additive-only for the gateway UI; existing consumers ignore it.
    scope: str | None = None


class LoginRequest(BaseModel):
    key: str


class ProjectRequest(BaseModel):
    project: str


async def get_status() -> WandbStatus:
    """Probe W&B using only the current user's SQLite-backed API key."""

    key = get_api_key()
    if not key:
        return WandbStatus(
            logged_in=False,
            entity=None,
            project=get_project(),
            scope=project_scope(),
        )

    def _probe() -> tuple[str | None, str | None]:
        try:
            import wandb
            api = wandb.Api(api_key=key, timeout=5)
            entity = api.default_entity
            return entity, None
        except Exception as e:
            return None, str(e)

    entity, err = await asyncio.to_thread(_probe)
    return WandbStatus(
        logged_in=entity is not None,
        entity=entity,
        project=get_project(),
        error=err,
        scope=project_scope(),
    )


async def validate(key: str) -> WandbStatus:
    """Validate a key without persisting it."""
    def _do() -> tuple[str | None, str | None]:
        try:
            import wandb
            api = wandb.Api(api_key=key.strip(), timeout=5)
            return api.default_entity, None
        except Exception as e:
            return None, str(e)

    entity, err = await asyncio.to_thread(_do)
    return WandbStatus(
        logged_in=entity is not None,
        entity=entity,
        project=get_project(),
        error=err,
        scope=project_scope(),
    )


async def login(key: str) -> WandbStatus:
    """Validate and save the current user's API key in SSOT SQLite."""
    from . import details

    status = await validate(key)
    if status.logged_in:
        set_api_key(key)

    # Clear cached wandb identity data so the next request re-resolves it.
    details._wandb_entity_cache.clear()
    details._wandb_workspace_cache.clear()
    return status


async def set_project_endpoint(project: str) -> WandbStatus:
    from . import details

    set_project(project)
    details._wandb_workspace_cache.clear()
    return await get_status()
