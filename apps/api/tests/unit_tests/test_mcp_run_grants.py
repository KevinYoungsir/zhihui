from __future__ import annotations

import json

import pytest

from app.services.mcp import run_grants


class FakePipeline:
    def __init__(self, store: dict[str, str]):
        self.store = store
        self.ops = []

    def setex(self, key, _ttl, value):
        self.ops.append(("set", key, value))
        return self

    def delete(self, key):
        self.ops.append(("delete", key, None))
        return self

    def execute(self):
        results = []
        for kind, key, value in self.ops:
            if kind == "set":
                self.store[key] = value
                results.append(True)
            else:
                results.append(1 if self.store.pop(key, None) is not None else 0)
        return results


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}

    def get(self, key):
        return self.store.get(key)

    def pipeline(self):
        return FakePipeline(self.store)


def test_grant_is_bound_to_run_project_and_tools(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(run_grants, "_redis", lambda: redis)
    monkeypatch.setattr(
        run_grants,
        "exposed_tool_names",
        lambda: frozenset({"get_scene_summary", "create_text", "delete_nodes"}),
    )
    token, grant = run_grants.mint_run_grant(
        user_id="user-1", project_id="project-1", run_id="run-1"
    )
    assert token.startswith("mcp_run_")
    assert token not in "".join(redis.store.values())
    assert grant.allowed_tools == frozenset({"get_scene_summary", "create_text"})
    validated = run_grants.validate_run_grant(
        token, run_id="run-1", project_id="project-1", tool="create_text"
    )
    assert validated.user_id == "user-1"
    with pytest.raises(run_grants.McpRunGrantError):
        run_grants.validate_run_grant(token, run_id="other", tool="create_text")
    with pytest.raises(run_grants.McpRunGrantError):
        run_grants.validate_run_grant(token, run_id="run-1", project_id="other")
    with pytest.raises(run_grants.McpRunGrantError):
        run_grants.validate_run_grant(token, run_id="run-1", tool="delete_nodes")


def test_revoke_invalidates_grant(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(run_grants, "_redis", lambda: redis)
    monkeypatch.setattr(run_grants, "exposed_tool_names", lambda: frozenset({"create_text"}))
    token, _ = run_grants.mint_run_grant(
        user_id="user-1", project_id="project-1", run_id="run-1"
    )
    assert run_grants.revoke_run_grant(user_id="user-1", run_id="run-1")
    with pytest.raises(run_grants.McpRunGrantError):
        run_grants.validate_run_grant(token, run_id="run-1", tool="create_text")


def test_expired_grant_is_rejected(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(run_grants, "_redis", lambda: redis)
    monkeypatch.setattr(run_grants, "exposed_tool_names", lambda: frozenset({"create_text"}))
    token, _ = run_grants.mint_run_grant(
        user_id="user-1", project_id="project-1", run_id="run-1"
    )
    grant_key = next(key for key in redis.store if key.startswith("mcp:run-grant:") and "index" not in key)
    payload = json.loads(redis.store[grant_key])
    payload["expires_at"] = 0
    redis.store[grant_key] = json.dumps(payload)
    with pytest.raises(run_grants.McpRunGrantError, match="expired"):
        run_grants.validate_run_grant(token, run_id="run-1", tool="create_text")
