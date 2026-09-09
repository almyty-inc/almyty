# Inference vendors: the verified matrix

Every `LlmProviderType` almyty offers, checked against the vendor's current
documentation. Each row carries the source URL and the date it was read.

Model independence is the product: an agent routes to any model on any
inference source, chosen per step by policy. That only holds if every
source listed here actually answers. This document exists so a provider
cannot be offered in the UI without someone having confirmed it works.

**Last full verification: 2026-09-09.** The nine OpenAI-compatible hosts
added on 2026-09-08 were re-checked on 2026-09-09; everything else was
verified for the first time on 2026-09-09.

Verification is documentation-derived plus, where a doc was ambiguous,
unauthenticated HTTP and DNS probes. Nothing was called with a live key.
Anything a vendor's docs do not state is marked "not documented" rather
than assumed.

## What every provider gets

| Layer | File | What a type needs |
|---|---|---|
| Enum | `backend/src/entities/llm-provider.entity.ts` | `LlmProviderType` value, `getApiUrl()` base, `getAuthHeaders()` case, `getModelsUrl()` override if the listing is not `<base>/models` |
| Catalog | `llm-providers/llm-provider-catalog.ts` | display name, description, feature badges, key console URL, docs URL |
| Dispatch | `llm-chat-runner.helper.ts`, `llm-chat.helper.ts` | a `case` in both the sync and streaming switches; structural config required at save time |
| Models | `llm-models.helper.ts` | live list where one exists, default capability flags, seed price table entry |
| Default model | `default-model.resolver.ts` | family regexes, never literal ids |
| Pricing | `model-catalog/pricing/price-feed.service.ts` | LiteLLM namespace and OpenRouter prefix, or an explicit `null` |
| Usage API | `provider-usage/provider-usage.capability.ts` | `supported` plus a note when false |
| Frontend | `components/llm-providers/*` | type union, select entry, structural form fields, glyph, key URL |

`__tests__/dispatch-completeness.spec.ts` iterates `Object.values(LlmProviderType)`
and asserts every value reaches a real implementation. Adding an enum value
without a dispatch path fails CI. That test exists because AWS Bedrock
shipped without one (see "Defects found and fixed").

## The matrix

Streaming and tools describe what the vendor documents on the surface we
call, not what every model behind it supports.

### First-party model vendors

| Type | Chat base (default) | Auth | Model list | Tools | Stream | Source (read 2026-09-09) |
|---|---|---|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | `Authorization: Bearer` | `GET /v1/models` | yes | yes | https://developers.openai.com/api/reference/overview |
| `anthropic` | `https://api.anthropic.com/v1` | `x-api-key` + `anthropic-version: 2023-06-01` | `GET /v1/models?limit=1000` (cursor-paginated) | yes | yes | https://platform.claude.com/docs/en/api/models-list |
| `google` | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` | `GET /v1beta/models` (`{models:[{name}]}`) | yes | yes | https://ai.google.dev/gemini-api/docs/api-key |
| `mistral` | `https://api.mistral.ai/v1` | `Authorization: Bearer` | `GET /v1/models` | yes | yes | https://docs.mistral.ai/api/ |
| `xai` | `https://api.x.ai/v1` | `Authorization: Bearer` | `GET /v1/models` | yes | yes | https://docs.x.ai/developers/rest-api-reference/inference |
| `deepseek` | `https://api.deepseek.com` | `Authorization: Bearer` | `GET /models` | yes | yes | https://api-docs.deepseek.com/api/create-chat-completion/ |
| `cohere` | `https://api.cohere.ai/compatibility/v1` | `Authorization: Bearer` | `GET https://api.cohere.com/v1/models` (`{models:[{name}]}`) | yes | yes | https://docs.cohere.com/docs/compatibility-api |
| `perplexity` | `https://api.perplexity.ai/v1` (Responses-shaped) | `Authorization: Bearer` | `GET /v1/models` (unauthenticated) | yes, flat Responses shape | yes | https://docs.perplexity.ai/docs/agent-api/quickstart |
| `moonshot` | `https://api.moonshot.ai/v1` | `Authorization: Bearer` | `GET /v1/models` | yes | yes | https://platform.kimi.ai/docs/api/list-models |
| `qwen` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `Authorization: Bearer` | **none documented** | yes | yes | https://docs.qwencloud.com/api-reference/toolkitframework/openai-compatible/overview.md |
| `zai` | `https://api.z.ai/api/paas/v4` | `Authorization: Bearer` | **none documented** | yes | yes | https://docs.z.ai/api-reference/introduction |

### Aggregators and OpenAI-compatible hosts

| Type | Chat base (default) | Auth | Model list | Tools | Stream | Source (read 2026-09-09) |
|---|---|---|---|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | Bearer + `HTTP-Referer` + `X-OpenRouter-Title` | `GET /api/v1/models` (unauthenticated) | yes | yes | https://openrouter.ai/docs/app-attribution |
| `groq` | `https://api.groq.com/openai/v1` | `Authorization: Bearer` | `GET /openai/v1/models` | yes | yes | https://console.groq.com/docs/api-reference |
| `together` | `https://api.together.ai/v1` | `Authorization: Bearer` | `GET /v1/models` (bare array) | yes | yes | https://docs.together.ai/docs/quickstart |
| `fireworks` | `https://api.fireworks.ai/inference/v1` | `Authorization: Bearer` | not documented on the OpenAI surface | yes | yes | https://docs.fireworks.ai/tools-sdks/openai-compatibility |
| `cerebras` | `https://api.cerebras.ai/v1` | `Authorization: Bearer` | `GET /v1/models` | yes | yes | https://inference-docs.cerebras.ai/api-reference/models |
| `deepinfra` | `https://api.deepinfra.com/v1/openai` | `Authorization: Bearer` | `GET https://api.deepinfra.com/v1/models` (one segment above the chat base) | yes | yes | https://docs.deepinfra.com/api-reference/models/openai-models.md |
| `novita` | `https://api.novita.ai/openai/v1` | `Authorization: Bearer` | `GET /openai/v1/models` | yes | yes | https://docs.novita.ai/api-reference/model-apis-llm-list-models |
| `baseten` | `https://inference.baseten.co/v1` | `Authorization: Bearer` | `GET /v1/models` | yes | yes | https://docs.baseten.co/development/model-apis/overview |
| `nebius` | `https://api.tokenfactory.nebius.com/v1` | `Authorization: Bearer` | `GET /v1/models` | yes | not documented | https://docs.tokenfactory.nebius.com/api-reference/models/list-models.md |
| `sambanova` | `https://api.sambanova.ai/v1` | `Authorization: Bearer` | **none documented** | yes | yes | https://docs.sambanova.ai/cloud/docs/get-started/api-keys-urls |
| `huggingface` | `https://router.huggingface.co/v1` | `Authorization: Bearer hf_` | `GET /v1/models` (carries per-provider `supports_tools` and pricing) | yes | yes | https://huggingface.co/docs/inference-providers/index |

### The customer's own cloud

| Type | Chat base (default) | Auth | Model list | Tools | Stream | Source (read 2026-09-09) |
|---|---|---|---|---|---|---|
| `azure_openai` | `https://{resource}.openai.azure.com/openai/v1` | `api-key` header | `GET /openai/v1/models` (catalog, not deployments) | yes | yes | https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle |
| `azure_ai_foundry` | `https://{resource}.services.ai.azure.com/openai/v1` | `Authorization: Bearer` (or `api-key`) | `GET /openai/v1/models` | yes | yes | https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/inference |
| `aws_bedrock` | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` | `Authorization: Bearer` (Bedrock API key, no SigV4) | `GET /openai/v1/models` | client-side yes | yes | https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html |
| `vertex_ai` | `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi` | `Authorization: Bearer <1h OAuth token>` | **none on this surface** | yes | yes | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai |

### Vendor serverless we can call without deploying

| Type | Chat base (default) | Auth | Model list | Tools | Stream | Source (read 2026-09-09) |
|---|---|---|---|---|---|---|
| `digitalocean` | `https://inference.do-ai.run/v1` | `Authorization: Bearer` (model access key) | `GET /v1/models` | not documented | implied, not shown | https://docs.digitalocean.com/products/inference/how-to/si-endpoints/index.html.md |
| `runpod` | `https://api.runpod.ai/v2/{endpoint}/openai/v1` | `Authorization: Bearer rpa_` | `GET /models`, scoped to that endpoint | per-model | yes | https://docs.runpod.io/public-endpoints/overview |
| `modal` | `https://inference.us-west.modal.direct/v1` | `Authorization: Bearer wk-<id>.ws-<secret>` | `GET /v1/models`, scoped to the token | implied, not shown | implied, not shown | https://modal.com/docs/guide/endpoint-integrations |

### Local and generic

| Type | Chat base (default) | Auth | Model list | Tools | Stream | Source (read 2026-09-09) |
|---|---|---|---|---|---|---|
| `ollama` | `http://localhost:11434/v1` | none (optional Bearer for an auth proxy) | native `GET /api/tags` | yes | yes | https://docs.ollama.com/api/openai-compatibility |
| `custom` | operator-supplied | per `custom.authMethod` | `<base>/models` | operator's | operator's | n/a |

## Defects found and fixed

Each of these was live in the product before 2026-09-09.

1. **AWS Bedrock was offered but could not answer.** Validated, priced,
   catalogued, selectable in the create dialog - and with no `case` in
   `dispatchProviderCall`. Every chat fell to the default branch and threw
   "Unsupported LLM provider type". It also had no region field in the
   create form, so it could not be saved from the UI in the first place.
   Fixed: routed onto the OpenAI-compatible `bedrock-runtime` surface with a
   Bedrock API key as a bearer token, region field added, key now required
   at save time. `dispatch-completeness.spec.ts` is the guard.
2. **Azure OpenAI could never have worked.** `getApiUrl()` returned
   `.../deployments/{name}?api-version={v}` - a base with a query string -
   and the shared OpenAI client appended `/chat/completions` after it,
   producing `...?api-version=2024-10-21/chat/completions`. The API key was
   also sent as `Authorization: Bearer`, which on that surface means an
   Entra ID token and 401s. Fixed: the `/openai/v1` surface, no
   `api-version`, `api-key` header. The deployment name is the model, so
   `DefaultModelResolver` returns it rather than picking from the catalog
   listing (which lists models, not the resource's deployments).
3. **Hugging Face pointed at a host that no longer resolves.**
   `api-inference.huggingface.co` has no DNS record; the adapter also sent
   a text-generation body (`inputs` / `generated_text`). Fixed: the
   OpenAI-compatible Inference Providers router, which brings streaming,
   tool calling and a model listing with it.
4. **Cohere sent a v1 body to a v2 path.** `callCohere` built
   `{message, chat_history}` (the v1 shape) and posted it to `/v2/chat`,
   which takes `messages`. Fixed: Cohere's OpenAI-compatible Compatibility
   API, with the model list still on the documented native `/v1/models`.
5. **Perplexity's default base is retiring.** It was `/router/v1`, private
   preview. The chat-completions alias on the bare host retires
   2026-09-27, and the Agent API that replaces it is Responses-shaped, so
   no `<base>/chat/completions` client survives. Fixed: a Responses-shaped
   dispatch against `https://api.perplexity.ai/v1`, which a paying customer
   can use today; the Router stays reachable via `apiUrl`.
6. **Gemini keys travelled in the URL.** `?key=` still works, but Google's
   own guidance calls it out as leaking keys through URL scans and logs.
   Fixed: `x-goog-api-key`.
7. **DeepSeek and Together were on undocumented bases.** DeepSeek's current
   docs carry no `/v1` segment; Together documents `api.together.ai`, not
   the `.xyz` alias we used. Both corrected.
8. **Together's model list always came back empty.** Its `/v1/models`
   returns a bare JSON array and the parser only read `{data:[...]}`. The
   parser now accepts a bare array and Cohere's `{models:[...]}` too.
9. **DeepInfra's model list hit an undocumented path.** Its listing is one
   segment above its chat base. `getModelsUrl()` now carries per-vendor
   overrides for DeepInfra and Cohere.
10. **Anthropic's model list was silently truncated.** The listing is
    cursor-paginated and defaults to 20 items, so the "newest" pick was made
    from a partial page. Now requests the documented maximum.
11. **Novita's base only matched the SDK form.** `api.novita.ai/openai` is
    the SDK `base_url`; the documented chat and models curls both use
    `/openai/v1`. Corrected.
12. **OpenRouter's attribution header was the superseded one.** `X-Title`
    still works; `X-OpenRouter-Title` is current.
13. **The frontend enum listed 8 of 24 types.** `frontend/src/types/index.ts`
    had drifted badly. Completed, and the key-URL test now derives its list
    from the enum so it cannot drift again.

## What a provider genuinely cannot do

Recorded here rather than papered over in the capability map.

- **Vertex AI cannot use a static API key.** Google's docs state that only
  Google Cloud Auth works on the OpenAI-compatible surface; Vertex API keys
  exist but express mode covers only `generateContent`, not
  `endpoints/openapi`. The credential is a service-account JSON key and the
  adapter mints a one-hour OAuth token per call (cached by
  google-auth-library). A pasted access token is also accepted.
- **Vertex AI serves no model list on that surface**, so a model must be
  named at save time. Validation enforces it.
- **Vertex Model Garden partner models are not on the OpenAI surface.**
  Claude, Mistral, Grok and Jamba on Vertex use `:rawPredict` with each
  vendor's native body. `vertex_ai` therefore serves Gemini on Vertex plus
  self-deployed endpoints. Llama MaaS on Vertex is retired.
- **Anthropic Claude is not served on Bedrock's OpenAI surface.** The API
  compatibility matrix lists ChatCompletions as "no" for every Claude row;
  Claude on Bedrock is Converse/Invoke or the native Messages API. Models
  that do work there include the OpenAI, xAI, Qwen, Z.AI and Writer
  families. Server-side tools (web search) are a `bedrock-mantle` feature,
  not available on `bedrock-runtime`.
- **Bedrock model ids are often inference profile ids** (`us.`, `global.`
  prefixed), not bare foundation-model ids. Driven from
  `GET /openai/v1/models` rather than hardcoded.
- **Qwen documents no model listing.** Its compatible-mode reference
  enumerates exactly six OpenAI APIs and `/models` is not among them, and
  Alibaba documents listing absence elsewhere when it applies. A model must
  be configured; the resolver reports `NO_MODEL_CONFIGURED` rather than
  guessing.
- **Z.ai, SambaNova and Fireworks' OpenAI surface document no listing
  either.** Same contract: the request is attempted, and a failure becomes
  `NO_MODEL_CONFIGURED` with the vendor's own reason.
- **Azure and Foundry cannot be validated by key alone.** `model` is the
  customer's deployment name, so a valid key with nothing deployed still
  cannot answer. Both require a deployment name at save time.
- **Modal requires a Shared Endpoint to exist first** (a dashboard action,
  not a container deploy), and `model` is the endpoint's hostname.
- **RunPod always carries an endpoint in the URL.** For the public catalog
  that is a shared model slug and nothing needs deploying; for a private
  worker it is the customer's endpoint id. There is no shared base without
  one, so it is a required field.
- **DigitalOcean's tool calling is not documented** on the plain chat
  surface, and streaming is only implied by "OpenAI-compatible" rather than
  shown in an example. Both are flagged here rather than asserted.
- **Nebius streaming is not documented** on any page found, though the
  surface is otherwise OpenAI-compatible.
- **No vendor here documents a usage/cost API** except OpenAI and
  Anthropic. Everything else is `supported: false` with a note.

## Time-sensitive, with dates

- **Perplexity Sonar chat completions retire 2026-09-27** (announced
  2026-08-13). The Router API is still private preview.
- **Azure AI Inference beta SDK retired 2026-08-26**; the
  `{resource}.services.ai.azure.com/models` route rides it. We use
  `/openai/v1`.
- **Anthropic deprecated `temperature` / `top_p` / `top_k`** for models
  after Claude Opus 4.6. Already handled by `callWithDeprecatedParamRetry`,
  which strips the param the vendor names and retries once.
- **DeepSeek's `deepseek-chat` and `deepseek-reasoner` aliases are being
  discontinued.** No literal ids are stored anywhere, so this only affects
  users who typed one.
- **Groq retired `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` on
  2026-08-16**; Gemini retired `gemini-2.0-flash*` on 2026-06-01; Mistral
  retired Large 2.1, Small 3.2 and Nemo through 2026. `DefaultModelResolver`
  holds no literal ids by design, so all of these resolve from the vendor's
  live list.
- **Moonshot retired the entire `moonshot-v1` series and `kimi-latest`**
  (2026-08-31 and 2026-01-28). Current flagship is `kimi-k3`.
- **Nebius AI Studio keys stopped working 2026-01-31** after the Token
  Factory rename.
- **xAI and OpenAI both describe Chat Completions as legacy** in favour of
  Responses. Neither has published a sunset date; both still work.

## Not added, with evidence

- **Replicate** - predictions-based HTTP API
  (`POST /v1/models/{owner}/{name}/predictions`); no chat-completions path
  exists to ride.
- **Databricks Foundation Model APIs** - DBRX was retired from
  pay-per-token on 2025-04-30; FMAPIs now serve third-party open weights
  only, so there is no first-party Databricks model to name.
- **Aleph Alpha** - Luminous API deprecated; company acquired by Cohere
  (announced 2026-04-24).
- **LG EXAONE, TII Falcon, 01.AI Yi** - open weights only, no vendor-run
  developer API.
- **Amazon Nova, Microsoft Phi** - first-party families with no standalone
  base URL; reachable through `aws_bedrock` and `azure_ai_foundry`.

Candidates a customer might reasonably name that we still cannot reach
directly, listed rather than added unasked: MiniMax
(`https://api.minimax.io/v1`), Upstage Solar (`https://api.upstage.ai/v1`),
ByteDance Doubao / Volcengine Ark, Baidu ERNIE Qianfan
(`https://qianfan.baidubce.com/v2`), Tencent Hunyuan, iFlytek Spark, AI21,
Writer, Naver HyperCLOVA X, IBM watsonx (IAM token, not a plain key),
Nvidia NIM and Snowflake Cortex. MiniMax and Upstage are the cleanest
additions: plain OpenAI-compatible bases with Bearer keys.

## Pricing

Live prices come from the LiteLLM cost map. Namespaces checked against the
live JSON on 2026-09-09: `moonshot` (24 chat entries), and `dashscope` /
`qwencloud` / `qwen_ai_platform` (45 each, byte-identical mirrors of one
catalog). `moonshot_ai` and `qwen` do not exist as feed keys. OpenRouter
prefixes are `moonshotai/` and `qwen/`.

DigitalOcean, RunPod and Modal have no LiteLLM namespace, so models there
stay unpriced rather than borrowing another vendor's list price. Hosts that
serve other authors' models (`HOSTED_OPEN_MODEL_TYPES`) skip the
cross-provider seed fallback for the same reason: `deepseek-v4` on RunPod is
never billed at DeepSeek's list price.

## Known gaps in this verification

Stated so the next pass knows where to look.

- Nothing was called with a live key. Every "yes" is what the vendor
  documents, not an observed response.
- AWS's own pages disagree on the `bedrock-mantle` base
  (`/v1` vs `/openai/v1`). `bedrock-runtime`, which we default to, is
  consistent everywhere.
- Perplexity's SSE event enumeration is not published; the parser handles
  the two documented events and ignores unknown types.
- `https://api.perplexity.ai/v1/chat/completions` is undocumented in either
  direction; the OpenAI-compat alias is at the bare host. Not relied on.
- Whether `api.deepseek.com/v1` still answers is unconfirmed. The
  documented base is used.
- Cohere's `/compatibility/v1/models` could not be distinguished from
  absent without a key (it 401s), which is why the listing stays on the
  documented native `/v1/models`.
- Closed on 2026-09-09: the type filter on `frontend/src/pages/llm-providers.tsx`
  and the third logo map in `frontend/src/pages/llm-provider-detail.tsx` were
  stale hand-written lists. Not cosmetic after all: the filter was eight
  entries behind the create form, so a provider a user could create could
  never be filtered for. Both now render from `providerTypeLabels` in
  `frontend/src/components/llm-providers/provider-type-config.ts`, and
  `provider-types.test.ts` fails when an enum value has no label or logo.
