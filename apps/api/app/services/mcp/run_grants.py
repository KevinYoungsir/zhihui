"""Short-lived, least-privilege grants for desktop CLI Canvas MCP runs."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

from app.services.mcp.tool_registry import exposed_tool_names

GRANT_TTL_SEC = 660
_PHASE_ONE_TOOLS = frozenset(
    {
        "get_scene_summary",
        "list_nodes",
        "list_frames",
        "apply_tool_ops",
        "create_frame",
        "create_shape",
        "create_text",
        "update_node",
    }
)


class McpRunGrantError(Exception):
    pass


@dataclass(frozen=True)
class McpRunGrant:
    user_id: str
    project_id: str
    run_id: str
    allowed_tools: frozenset[str]
    expires_at: int


def _redis():
    from app.core.config import settings
    import redis

    return redis.from_url(settings.redis_url, decode_responses=True)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _grant_key(digest: str) -> str:
    return f"mcp:run-grant:{digest}"


def _run_key(user_id: str, run_id: str) -> str:
    identity = hashlib.sha256(f"{user_id}:{run_id}".encode("utf-8")).hexdigest()
    return f"mcp:run-grant-index:{identity}"


def _phase_one_allowed_tools() -> frozenset[str]:
    return frozenset(exposed_tool_names().intersection(_PHASE_ONE_TOOLS))


def mint_run_grant(*, user_id: str, project_id: str, run_id: str) -> tuple[str, McpRunGrant]:
    token = f"mcp_run_{secrets.token_urlsafe(32)}"
    digest = _digest(token)
    allowed_tools = _phase_one_allowed_tools()
    expires_at = int(time.time()) + GRANT_TTL_SEC
    grant = McpRunGrant(
        user_id=str(user_id),
        project_id=str(project_id),
        run_id=str(run_id),
        allowed_tools=allowed_tools,
        expires_at=expires_at,
    )
    payload = json.dumps(
        {
            "user_id": grant.user_id,
            "project_id": grant.project_id,
            "run_id": grant.run_id,
            "allowed_tools": sorted(grant.allowed_tools),
            "expires_at": grant.expires_at,
        },
        separators=(",", ":"),
    )
    client = _redis()
    index_key = _run_key(grant.user_id, grant.run_id)
    prior_digest = client.get(index_key)
    pipe = client.pipeline()
    if prior_digest:
        pipe.delete(_grant_key(str(prior_digest)))
    pipe.setex(_grant_key(digest), GRANT_TTL_SEC, payload)
    pipe.setex(index_key, GRANT_TTL_SEC, digest)
    pipe.execute()
    return token, grant


def validate_run_grant(
    token: str,
    *,
    run_id: str,
    tool: str | None = None,
    project_id: str | None = None,
) -> McpRunGrant:
    raw_token = str(token or "").strip()
    if not raw_token.startswith("mcp_run_") or len(raw_token) > 256:
        raise McpRunGrantError("invalid grant")
    raw = _redis().get(_grant_key(_digest(raw_token)))
    if not raw:
        raise McpRunGrantError("expired or revoked grant")
    try:
        payload: dict[str, Any] = json.loads(raw)
        grant = McpRunGrant(
            user_id=str(payload["user_id"]),
            project_id=str(payload["project_id"]),
            run_id=str(payload["run_id"]),
            allowed_tools=frozenset(str(value) for value in payload["allowed_tools"]),
            expires_at=int(payload["expires_at"]),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise McpRunGrantError("invalid grant record") from exc
    if grant.expires_at <= int(time.time()):
        raise McpRunGrantError("expired grant")
    if not hmac.compare_digest(grant.run_id, str(run_id or "")):
        raise McpRunGrantError("run mismatch")
    if project_id is not None and not hmac.compare_digest(
        grant.project_id, str(project_id or "")
    ):
        raise McpRunGrantError("project mismatch")
    if tool is not None and str(tool) not in grant.allowed_tools:
        raise McpRunGrantError("tool not allowed")
    return grant


def revoke_run_grant(*, user_id: str, run_id: str) -> bool:
    client = _redis()
    index_key = _run_key(str(user_id), str(run_id))
    digest = client.get(index_key)
    pipe = client.pipeline()
    pipe.delete(index_key)
    if digest:
        pipe.delete(_grant_key(str(digest)))
    results = pipe.execute()
    return bool(digest or any(int(value or 0) > 0 for value in results))
