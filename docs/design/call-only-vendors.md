# Call-only inference vendors: OpenAI-compatible hosts

Status: shipped on feat/models-layer-phase-a (2026-09-08). Scope: the inference vendors that expose an OpenAI-compatible chat completions API and therefore ride the existing OpenAI dispatch path (`callOpenAI` / `callOpenAIStream`) exactly like xAI, DeepSeek, Groq and Together. Nothing vendor-specific is added beyond a base URL, a Bearer key, catalog copy and a price-feed namespace.

"Call-only" means almyty calls the vendor; it never deploys or trains there. Deployment adapters are a separate matrix in `models-layer.md`.

## What every vendor gets

| Layer | File | What was added per type |
|---|---|---|
| Enum | `backend/src/entities/llm-provider.entity.ts` | `LlmProviderType` value, `getApiUrl()` default base, `getAuthHeaders()` Bearer case |
| Catalog | `backend/src/modules/llm-providers/llm-provider-catalog.ts` | display name, description, feature badges, key console URL, docs URL |
| Dispatch | `llm-chat-runner.helper.ts`, `llm-chat.helper.ts` | routed to `callOpenAI` (sync) and `callOpenAIStream` (streaming); API key required at save time |
| Models | `llm-models.helper.ts` | live list via `GET <base>/models` (`fetchOpenAIModels`), default capability flags, empty seed price table |
| Default model | `default-model.resolver.ts` | family regexes (no literal ids); hosts fall back to the first served chat model |
| Pricing | `model-catalog/pricing/price-feed.service.ts` | LiteLLM namespace and, where one exists, OpenRouter prefix |
| Usage API | `provider-usage/provider-usage.capability.ts` | `supported: false` with a note (no vendor here documents a usage/cost API) |
| Frontend | `components/llm-providers/*`, `pages/llm-providers.tsx`, `pages/llm-provider-detail.tsx` | type union, create-dialog and filter entries, logo glyph, key URL |

DTO validation (`@IsEnum(LlmProviderType)`) and the Swagger enum derive from the enum, so they picked the new values up without edits. The health check (`performHealthCheck`) resolves a model through `DefaultModelResolver` and calls the same dispatch path, and `assertModelIsServed` checks a configured model against the live `/models` list whenever the vendor has one.

## Verified facts (2026-09-08)

Verified by probing each base with an invalid key (an auth error proves the route exists; a 404 proves it does not) and by reading the vendor's current docs. Public `/models` means the list is served without a key.

| Type | Base URL (default) | `GET /models` | Tools | Streaming | Key console | Docs |
|---|---|---|---|---|---|---|
| `fireworks` | `https://api.fireworks.ai/inference/v1` | yes (auth-gated) | yes, OpenAI tool spec | yes | https://app.fireworks.ai/settings/users/api-keys | https://docs.fireworks.ai |
| `cerebras` | `https://api.cerebras.ai/v1` | yes (documented) | yes | yes | https://cloud.cerebras.ai | https://inference-docs.cerebras.ai |
| `deepinfra` | `https://api.deepinfra.com/v1/openai` | yes (auth-gated) | yes (`tools`, `tool_choice` documented) | yes | https://deepinfra.com/dash/api_keys | https://docs.deepinfra.com |
| `novita` | `https://api.novita.ai/openai` | yes (public; entries carry a `features` list incl. `function-calling`) | yes | yes | https://novita.ai/settings/key-management | https://docs.novita.ai |
| `perplexity` | `https://api.perplexity.ai/router/v1` | yes (documented, auth-gated) | not documented on the chat surface | yes | https://console.perplexity.ai | https://docs.perplexity.ai |
| `zai` | `https://api.z.ai/api/paas/v4` | not documented (route answers 401 like every other path) | yes (documented) | yes (documented) | https://z.ai/manage-apikey/apikey-list | https://docs.z.ai |
| `baseten` | `https://inference.baseten.co/v1` | yes (documented, returns pricing and context) | yes (all Model API models) | yes | https://app.baseten.co/settings/api_keys | https://docs.baseten.co |
| `nebius` | `https://api.tokenfactory.nebius.com/v1` | yes (auth-gated) | yes (LiteLLM flags) | yes | https://tokenfactory.nebius.com/settings/api-keys | https://docs.tokenfactory.nebius.com |
| `sambanova` | `https://api.sambanova.ai/v1` | yes (public) | yes (LiteLLM flags) | yes | https://cloud.sambanova.ai/apis | https://docs.sambanova.ai |

Notes:

- Novita documents `api.novita.ai/openai` as the base; the older `api.novita.ai/v3/openai` still answers. Both serve `/models` publicly.
- Perplexity is mid-migration. The legacy Sonar endpoint `https://api.perplexity.ai/chat/completions` works until 2026-09-27 and has no `/models`; its successor, the Agent API (`/v1/agent`), is not chat-completions shaped. The Router API (`/router/v1`, OpenAI-compatible, lists models with prices) is the default base here; it is in private preview (api@perplexity.ai). A user on the legacy endpoint sets `apiUrl` to `https://api.perplexity.ai` and an explicit model; with no model the resolver reports `NO_MODEL_CONFIGURED` because the listing 404s.
- Z.ai: `/models` is not in the docs. The list is attempted; if it fails, `DefaultModelResolver` catches the listing error and reports `NO_MODEL_CONFIGURED` with the vendor's reason (added in this change), and the user sets a model. `/test-connection` and the models endpoint keep surfacing the raw listing error, the contract every other type has. `assertModelIsServed` passes through when nothing is listed.
- Nebius AI Studio was renamed Nebius Token Factory; `api.studio.nebius.com` still answers but the docs only name the new host.
- Cerebras keys are minted on the platform page under https://cloud.cerebras.ai (no stable deep link).

## Pricing

No seed prices were added. The LiteLLM cost map carries every one of these vendors under `litellm_provider` values `fireworks_ai`, `cerebras`, `deepinfra`, `novita`, `perplexity`, `zai`, `baseten`, `nebius`, `sambanova` (checked against the live JSON on 2026-09-08: 320, 8, 135, 135, 76, 16, 12, 57 and 19 chat entries). The feed strips the first path segment, which yields exactly the id each host's `/models` returns (Fireworks: `accounts/fireworks/models/<name>`). OpenRouter cross-checks only Perplexity (`perplexity/`) and Z.ai (`z-ai/`); the other hosts have no OpenRouter namespace.

Hosts that serve other authors' open models (`HOSTED_OPEN_MODEL_TYPES` in `llm-models.helper.ts`) skip the cross-provider seed fallback: `deepseek-v3` on Novita is never billed at DeepSeek's list price. Without a feed quote such a model is unpriced, which the catalog surfaces, rather than silently wrong.

## Default model selection

`default-model.resolver.ts` gained family regexes, not ids: Perplexity prefers `sonar-pro`, then `sonar`, then any `sonar-*`; Z.ai prefers plain `glm-N`, then `glm-N-flash`, then any `glm-*`. The seven hosts share one preference (instruct Llama, instruct Qwen, DeepSeek-V, then those families loosely) and, unlike first-party vendors, fall back to the first served chat model when none of those is listed, because a host's catalog is a moving mix of authors.

## Left out

- Replicate. Its HTTP API is predictions-based (`POST /v1/models/{owner}/{name}/predictions`, `POST /v1/predictions`); the reference documents no path containing `chat` or `openai`, and `https://api.replicate.com/openai/v1/chat/completions` is a 404. There is no OpenAI-compatible chat completions endpoint to ride, so it is not a provider type. If Replicate ships one, it is a nine-line addition per the table above.
- Usage/cost ingestion: none of the nine vendors documents a programmatic usage or billing API, so all are `supported: false` in the provider-usage capability map.
