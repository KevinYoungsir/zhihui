from __future__ import annotations

import json


class FakeRedis:
    def __init__(self) -> None:
        self.items: list[str] = []

    def lrange(self, _key: str, start: int, end: int) -> list[str]:
        if end == -1:
            return self.items[start:]
        return self.items[start : end + 1]

    def rpush(self, _key: str, payload: str) -> None:
        self.items.append(payload)

    def expire(self, _key: str, _seconds: int) -> None:
        return None


def test_publish_pending_reuses_batch_for_same_operation(monkeypatch):
    from app.services.mcp.push import channel
    from app.core.config import settings

    fake = FakeRedis()
    monkeypatch.setattr(channel, "_redis", lambda: fake)
    monkeypatch.setattr(settings, "mcp_canvas_enabled", True)

    first = channel.publish_pending_ops(
        "project-1",
        [{"name": "create_text", "args": {"text": "one"}}],
        run_id="run-1",
        operation_id="run-1:rpc-7",
    )
    second = channel.publish_pending_ops(
        "project-1",
        [{"name": "create_text", "args": {"text": "one"}}],
        run_id="run-1",
        operation_id="run-1:rpc-7",
    )

    assert first == "run-1:rpc-7"
    assert second == first
    assert len(fake.items) == 1
    payload = json.loads(fake.items[0])
    assert payload["batchId"] == first
    assert payload["operationId"] == first
