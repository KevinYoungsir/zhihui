# Infinite-Canvas provider compatibility layer

This project uses the public provider behavior of
[KevinYoungsir/Infinite-Canvas](https://github.com/KevinYoungsir/Infinite-Canvas)
as an interoperability reference. No bundled CLI binary, monolithic server
implementation, prompt, or UI source was copied.

## Implemented API mode

- The browser sends a base URL, protocol choice, and transient API key to this
  project's authenticated backend.
- The backend reads the upstream model catalog using the provider's standard
  model endpoint and returns metadata only. It never returns the key.
- Supported discovery protocols are OpenAI-compatible, Google Gemini,
  Volcengine Ark, and RunningHub. `auto` infers the protocol from the URL.
- Models are normalized and classified into `text`, `image`, `video`, and
  `audio`; the canvas UI currently exposes text, image, and video selection.
- Saving a selected model reuses the existing AES-GCM BYOK vault and existing
  chat/image model references (`custom:<provider-id>`).

## Runtime paths

- Chat/Agent: OpenAI-compatible `chat/completions` through the existing LLM
  router.
- Image generation: OpenAI-compatible `images/generations` through the existing
  image service.
- Model discovery: `POST /api/v1/me/byok/discover-models`.

Google Gemini and RunningHub discovery is supported, but generation still needs
a provider-specific transport if the upstream does not implement the
OpenAI-compatible chat/image endpoints.

## Security

- Provider URLs must be public HTTP(S) URLs; obvious loopback, private-network,
  link-local, and metadata endpoints are rejected.
- Redirects are disabled and responses are capped at 2 MB.
- Saved keys remain encrypted server-side. Discovery credentials are transient
  request data and are filtered from application logs.
- `LOCAL_CANVAS_MODE=true` is an explicit development-only login bypass and is
  off by default.

