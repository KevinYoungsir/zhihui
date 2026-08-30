from app.services.llm.provider_discovery import (
    classify_model,
    infer_provider_protocol,
    model_discovery_url,
    parse_upstream_models,
)


def test_model_discovery_url_avoids_duplicate_version_prefix() -> None:
    assert (
        model_discovery_url("https://example.com/v1", "openai")
        == "https://example.com/v1/models"
    )
    assert (
        model_discovery_url("https://example.com/v1beta", "gemini")
        == "https://example.com/v1beta/models"
    )


def test_protocol_is_inferred_from_provider_url() -> None:
    assert infer_provider_protocol("https://generativelanguage.googleapis.com") == "gemini"
    assert infer_provider_protocol("https://ark.cn-beijing.volces.com/api/v3") == "volcengine"
    assert infer_provider_protocol("https://api.example.com") == "openai"


def test_upstream_shapes_are_normalized_and_deduplicated() -> None:
    payload = {
        "models": [
            {"name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro"},
            {"name": "models/imagen-4", "displayName": "Imagen 4"},
            {"name": "models/imagen-4"},
        ]
    }
    models = parse_upstream_models(payload, protocol="gemini")
    assert [model["id"] for model in models] == ["gemini-2.5-pro", "imagen-4"]
    assert [model["kind"] for model in models] == ["text", "image"]


def test_model_classifier_matches_generation_families() -> None:
    assert classify_model("openai/sora-2") == "video"
    assert classify_model("doubao-seedream-5") == "image"
    assert classify_model("gpt-4o-mini-tts") == "audio"
    assert classify_model("deepseek-chat") == "text"

