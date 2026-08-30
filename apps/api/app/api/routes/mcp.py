"""MCP canvas control REST API."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser
from app.core.config import settings
from app.services.i18n.errors import http_error, service_error_http
from app.services.i18n.locale import LocaleDep
from app.services.mcp.dispatch import McpCanvasError, call_mcp_canvas_tool
from app.services.mcp.push.channel import ack_pending_batches, fetch_pending_batches
from app.services.mcp.run_grants import (
    GRANT_TTL_SEC,
    McpRunGrantError,
    mint_run_grant,
    revoke_run_grant,
    validate_run_grant,
)
from app.services.mcp.session import touch_live_session
from app.services.mcp.tool_registry import list_mcp_tool_definitions
from app.services.projects import ProjectForbiddenError, ProjectNotFoundError

router = APIRouter(prefix="/mcp/canvas", tags=["mcp-canvas"])


class McpToolCallIn(BaseModel):
    tool: str = Field(..., min_length=1, max_length=128)
    arguments: dict[str, Any] = Field(default_factory=dict)


class McpHeartbeatIn(BaseModel):
    project_id: str = Field(..., min_length=1, max_length=128)


class McpPendingAckIn(BaseModel):
    project_id: str = Field(..., min_length=1, max_length=128)
    batch_ids: list[str] = Field(default_factory=list)


class McpRunGrantIn(BaseModel):
    run_id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    project_id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")


def _mcp_http_error(exc: Exception, locale: str | None = None) -> HTTPException:
    if isinstance(exc, McpCanvasError):
        raw_code = str(exc.code or "request_failed")
        mapped = {
            "not_found": (404, "project_not_found"),
            "forbidden": (403, "forbidden"),
            "revision_conflict": (412, "project_revision_conflict"),
        }.get(raw_code)
        if mapped:
            status, code = mapped
            return http_error(status, code, locale)
        return service_error_http(raw_code, locale, status=400, message=str(exc).strip())
    if isinstance(exc, ProjectNotFoundError):
        return http_error(404, "project_not_found", locale)
    if isinstance(exc, ProjectForbiddenError):
        return http_error(403, "forbidden", locale)
    return http_error(500, "internal_error", locale)


def _require_enabled(locale: str | None = None) -> None:
    if not settings.mcp_canvas_enabled:
        raise http_error(503, "mcp_disabled", locale)


def _grant_token(authorization: str) -> str:
    scheme, _, token = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="MCP run grant required")
    return token.strip()


@router.get("/tools")
def list_tools(locale: LocaleDep, current_user: CurrentUser) -> dict[str, Any]:
    _require_enabled(locale)
    return {"tools": list_mcp_tool_definitions()}


@router.post("/call")
def call_tool(locale: LocaleDep, current_user: CurrentUser, body: McpToolCallIn) -> dict[str, Any]:
    _require_enabled(locale)
    try:
        result = call_mcp_canvas_tool(
            user_id=current_user.id,
            tool=body.tool,
            arguments=body.arguments,
        )
        return {"ok": True, "result": result}
    except Exception as exc:
        raise _mcp_http_error(exc, locale) from exc


@router.post("/runs/grants")
def create_run_grant(
    locale: LocaleDep,
    current_user: CurrentUser,
    body: McpRunGrantIn,
) -> dict[str, Any]:
    _require_enabled(locale)
    from app.services.mcp.auth import load_writable_project

    load_writable_project(current_user.id, body.project_id)
    token, grant = mint_run_grant(
        user_id=current_user.id,
        project_id=body.project_id,
        run_id=body.run_id,
    )
    return {
        "grant": token,
        "runId": grant.run_id,
        "projectId": grant.project_id,
        "allowedTools": sorted(grant.allowed_tools),
        "expiresIn": GRANT_TTL_SEC,
    }


@router.delete("/runs/{run_id}/grants")
def delete_run_grant(
    run_id: str,
    locale: LocaleDep,
    current_user: CurrentUser,
) -> dict[str, Any]:
    _require_enabled(locale)
    return {"ok": True, "revoked": revoke_run_grant(user_id=current_user.id, run_id=run_id)}


@router.get("/runs/tools")
def list_run_tools(
    locale: LocaleDep,
    authorization: str = Header(..., alias="Authorization"),
    run_id: str = Header(..., alias="X-Recombyn-Run-Id"),
) -> dict[str, Any]:
    _require_enabled(locale)
    try:
        grant = validate_run_grant(_grant_token(authorization), run_id=run_id)
    except McpRunGrantError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    definitions = []
    for definition in list_mcp_tool_definitions():
        name = str((definition.get("function") or {}).get("name") or "")
        if name in grant.allowed_tools:
            definitions.append(definition)
    return {"tools": definitions, "runId": grant.run_id, "projectId": grant.project_id}


@router.post("/runs/call")
def call_run_tool(
    locale: LocaleDep,
    body: McpToolCallIn,
    authorization: str = Header(..., alias="Authorization"),
    run_id: str = Header(..., alias="X-Recombyn-Run-Id"),
) -> dict[str, Any]:
    _require_enabled(locale)
    args = dict(body.arguments or {})
    requested_project = str(args.get("project_id") or args.get("projectId") or "").strip()
    try:
        grant = validate_run_grant(
            _grant_token(authorization),
            run_id=run_id,
            tool=body.tool,
            project_id=requested_project or None,
        )
        args.pop("projectId", None)
        args["project_id"] = grant.project_id
        result = call_mcp_canvas_tool(
            user_id=grant.user_id,
            tool=body.tool,
            arguments=args,
            run_id=grant.run_id,
        )
        return {"ok": True, "result": result}
    except McpRunGrantError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception as exc:
        raise _mcp_http_error(exc, locale) from exc


@router.post("/session/heartbeat")
def session_heartbeat(
    locale: LocaleDep,
    current_user: CurrentUser,
    body: McpHeartbeatIn,
) -> dict[str, Any]:
    _require_enabled(locale)
    touch_live_session(body.project_id, user_id=current_user.id)
    return {"ok": True, "projectId": body.project_id}


@router.get("/pending")
def list_pending(
    locale: LocaleDep,
    current_user: CurrentUser,
    project_id: str = Query(..., min_length=1, max_length=128),
    limit: int = Query(8, ge=1, le=32),
) -> dict[str, Any]:
    _require_enabled(locale)
    # ACL: must be able to read project
    from app.services.mcp.auth import load_writable_project

    load_writable_project(current_user.id, project_id)
    batches = fetch_pending_batches(project_id, limit=limit)
    return {"projectId": project_id, "batches": batches}


@router.post("/pending/ack")
def ack_pending(
    locale: LocaleDep,
    current_user: CurrentUser,
    body: McpPendingAckIn,
) -> dict[str, Any]:
    _require_enabled(locale)
    from app.services.mcp.auth import load_writable_project

    load_writable_project(current_user.id, body.project_id)
    removed = ack_pending_batches(body.project_id, body.batch_ids)
    return {"ok": True, "removed": removed}
