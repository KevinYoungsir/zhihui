"""Discover and classify models exposed by an upstream AI provider.

This is a small compatibility layer inspired by Infinite-Canvas' provider
discovery contract.  It intentionally contains no provider credentials or
copied provider implementation: keys are supplied request-scoped and the
response is reduced to safe model metadata.
"""

from __future__ import annotations

from typing import Any, Literal

import httpx

from app.services.security import is_public_http_url

ProviderProtocol = Literal["auto", "openai", "gemini", "volcengine", "runninghub"]
ModelKind = Literal["text", "image", "video", "audio"]

_VIDEO_WORDS = (
    "veo",
    "sora",
    "wan2",
    "wanx",
    "seedance",
    "kling",
    "hailuo",
    "video",
    "t2v",
    "i2v",
    "s2v",
)
_IMAGE_WORDS = (
    "banana",
    "image",
    "dall-e",
    "imagen",
    "flux",
    "stable-diffusion",
    "sdxl",
    "midjourney",
    "z-image",
    "qwen-image",
    "klein",
    "seedream",
    "text-to-image",
    "image-to-image",
)
_AUDIO_WORDS = (
    "audio",
    "speech",
    "tts",
    "voice",
    "whisper",
    "transcribe",
)


def infer_provider_protocol(base_url: str, protocol: ProviderProtocol = "auto") -> str:
    requested = str(protocol or "auto").strip().lower()
    if requested != "auto":
        return requested
    url = str(base_url or "").lower()
    if "generativelanguage.googleapis.com" in url or "/v1beta" in url:
        return "gemini"
    if "volces.com" in url or "volcengine" in url or "/api/v3" in url:
        return "volcengine"
    if "runninghub" in url or "/openapi/v2" in url:
        return "runninghub"
    return "openai"


def model_discovery_url(base_url: str, protocol: ProviderProtocol = "auto") -> str:
    base = str(base_url or "").strip().rstrip("/")
    if not is_public_http_url(base):
        raise ValueError("baseUrl must be a public http(s) URL")
    resolved = infer_provider_protocol(base, protocol)
    suffix = {
        "gemini": "/v1beta/models",
        "volcengine": "/api/v3/models",
        "runninghub": "/openapi/v2/models",
        "openai": "/v1/models",
    }[resolved]
    prefix = suffix.rsplit("/models", 1)[0]
    if base.lower().endswith("/models"):
        return base
    if prefix and base.lower().endswith(prefix.lower()):
        return f"{base}/models"
    return f"{base}{suffix}"


def _source_models(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("data", "models", "list", "items"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    result = payload.get("result")
    if isinstance(result, dict):
        return _source_models(result)
    return []


def classify_model(model_id: str, metadata: dict[str, Any] | None = None) -> ModelKind:
    meta = metadata or {}
    hints: list[str] = [str(model_id or "")]
    for key in ("type", "kind", "category", "task", "model_type"):
        if meta.get(key) is not None:
            hints.append(str(meta[key]))
    for key in ("modalities", "capabilities", "supported_generation_methods"):
        value = meta.get(key)
        if isinstance(value, list):
            hints.extend(str(item) for item in value)
        elif value is not None:
            hints.append(str(value))
    haystack = " ".join(hints).lower().replace("_", "-")
    if any(word in haystack for word in _VIDEO_WORDS):
        return "video"
    if any(word in haystack for word in _AUDIO_WORDS):
        return "audio"
    if any(word in haystack for word in _IMAGE_WORDS):
        return "image"
    return "text"


def parse_upstream_models(payload: Any, *, protocol: str = "openai") -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in _source_models(payload):
        if isinstance(raw, str):
            model_id = raw.strip()
            metadata: dict[str, Any] = {}
        elif isinstance(raw, dict):
            metadata = raw
            model_id = str(
                raw.get("id") or raw.get("model") or raw.get("name") or ""
            ).strip()
        else:
            continue
        if protocol == "gemini" and model_id.startswith("models/"):
            model_id = model_id[len("models/") :]
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        label = str(
            metadata.get("display_name")
            or metadata.get("displayName")
            or metadata.get("label")
            or model_id
        ).strip()
        models.append(
            {
                "id": model_id,
                "label": label or model_id,
                "kind": classify_model(model_id, metadata),
                "ownedBy": str(metadata.get("owned_by") or metadata.get("publisher") or ""),
            }
        )
    return models


async def discover_upstream_models(
    *,
    base_url: str,
    api_key: str,
    protocol: ProviderProtocol = "auto",
    timeout_seconds: float = 15.0,
) -> dict[str, Any]:
    key = str(api_key or "").strip()
    if not key:
        raise ValueError("apiKey required")
    resolved = infer_provider_protocol(base_url, protocol)
    url = model_discovery_url(base_url, resolved)  # validates public URL
    headers = (
        {"x-goog-api-key": key, "Accept": "application/json"}
        if resolved == "gemini"
        else {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    )
    timeout = httpx.Timeout(max(1.0, min(float(timeout_seconds), 30.0)))
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        if len(response.content) > 2_000_000:
            raise ValueError("upstream model catalog is too large")
        payload = response.json()
    models = parse_upstream_models(payload, protocol=resolved)
    categories: dict[str, list[dict[str, Any]]] = {
        "text": [],
        "image": [],
        "video": [],
        "audio": [],
    }
    for model in models:
        categories[model["kind"]].append(model)
    return {
        "protocol": resolved,
        "total": len(models),
        "models": models,
        "categories": categories,
    }
