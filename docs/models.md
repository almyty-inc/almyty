# Models layer

The models layer decides which model answers a call, what it costs, and where it runs. It has three parts:

| Module | Path | Owns |
|--------|------|------|
| Catalog | `backend/src/modules/model-catalog/` | Model cards, the router, the automatic price feed |
| Registry | `backend/src/modules/model-registry/` | Weights and manifests (`s3://`, `file://`, `hf://`) |
| Deployments | `backend/src/modules/model-deployments/` | Models on the customer's own cloud account: provider adapters, the reconcile loop, budgets |

Design and provider deltas: `docs/design/models-layer.md`. Registry details: `docs/model-registry.md`.

## Support is data, not a list

There is no code list of supported models. A model is usable when its **card** exists in the org's catalog and:

1. it has a way to be called (a stored LLM provider row, or an endpoint URL from a model running on the customer's cloud account),
2. its status is `active`, and
3. one **validation run** has passed (`POST /models/:id/validate` makes a real, short call and records the result).

`Model.isSelectable()` is the only definition of "usable". A retired vendor model fails validation and drops out; a new self-hosted endpoint joins the moment its run passes. Nothing else flips the flag.

## Provider profiles and protocols

**Status: BUILT** (2026-09-10). Layer 2 of `docs/design/layers.md`.

A vendor is a row, not code. Adding one used to mean editing eight files
across two languages: an enum member, a base URL case, an auth case, two
dispatch lists, a model-list case, a price-feed row, a usage-capability
row and five catalog maps. That is why the provider list grew by whoever
was cheapest to wire rather than by who mattered, and why the question of
which vendors we carry kept being reopened.

A profile carries the base URL, auth, the path, the listing shape, the
pricing source, the capabilities, the key and docs URLs, and the date the
surface was last checked against the vendor's own documentation.

### Protocols

There is no single generic path with exceptions. There are several real
wire protocols, each spoken by many vendors, and each is **one
implementation that many vendors share**: implement it once, and every
vendor speaking it becomes a row.

| Protocol | Notes |
|----------|-------|
| `chat_completions` | OpenAI Chat Completions |
| `responses` | OpenAI Responses; Perplexity is this shape |
| `anthropic_messages` | Not Anthropic-only: Baseten, Z.ai and Moonshot expose it |
| `gemini_generate_content` | Google direct and Vertex |
| `bedrock_converse` | |
| `cohere_v2` | |
| `dashscope_native` | Qwen; its OpenAI mode hides DashScope features |
| `embeddings` | |
| `rerank` | |

"Closed" means adding one is a deliberate code change with an
implementation, a test and documentation. It is not a frozen list: vendor
natives keep appearing and several expose capabilities their
OpenAI-compatible mode hides, which is why they earn a protocol rather
than a quirk field.

**Auth is a separate, orthogonal enum**: `bearer`, `x_api_key`, `sigv4`,
`service_account`, `azure_key`, `custom_headers`. Vertex minting a
one-hour token per call is auth, not a different wire shape.

A profile holds a map of protocols with one preferred, so a vendor
speaking two is two entries rather than a quirk override. Cohere serving
chat on the compatibility base while its listing stays native is two
protocol entries with different bases.

### Quirks are fields

Writer's chat path is `/chat`, not `/chat/completions`. Spark serves each
model generation on its own base and the current two share the model id
`spark-x`, so the generation is required. Ark is a different product
inside and outside mainland China, so the edition is chosen. A base that
embeds an account's own region, resource name or endpoint id is a
template filled from the configuration.

None of those is a reason to exclude a vendor, which is what they had
previously been used as.

### Inbound, and native first

The same protocol implementation serves inbound clients and calls outbound
vendors; writing it twice is the duplication that caused most of a week's
bugs. Inbound protocols are translators at the edge, never branches
through the core.

`anthropic_messages` inbound is what lets an Anthropic SDK client reach an
almyty agent with a base URL change, carrying thinking blocks and real tool
use instead of flattening them. Claude Code is **not** one of those clients:
it always declares tools, and this endpoint refuses client-declared tools for
the reason set out below.

Point one at `POST /v1/messages`:

```bash
curl https://api.almyty.com/v1/messages \
  -H "x-api-key: $ALMYTY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"agent:my-agent","max_tokens":1024,
       "messages":[{"role":"user","content":"hello"}]}'
```

`model` names the agent, as `agent:<id>` or its name. The key goes in
`x-api-key`, the way an Anthropic client already sends it, or as a bearer
token if you have one already. A tool result arrives as a user message of
`tool_result` blocks and stays a tool turn rather than being flattened
into text, which is the difference between a client's tool loop working
and stopping without an error.

The conversation, the `system` prompt, `temperature` and `max_tokens` all
reach the run. `/v1/messages` is stateless, so the `messages` array is the
conversation and a client resends it whole every turn; it is rendered into
the agent's input as a labelled transcript, because an agent prompt binds one
string and anything left beside it reaches no model. `system` is folded into
the same transcript, ahead of the turns. `temperature` and `max_tokens` are
applied to the run's `llm_call` nodes and to `modelConfig` for the length of
the request; nothing is written back to the stored agent.

Three limits, stated because finding them at run time is worse.

**Client-declared tools are refused.** An almyty agent runs its own
tools: a `tool_call` node executes inside the run and the answer comes
back finished, so there is no turn at which a tool could be handed to you
to run. A request carrying `tools` gets a 400 saying so. Accepting them
and answering normally would leave a client whose tools never fire and
nothing to debug. Give the agent the tools instead. This is the reason
Claude Code, which always sends tools, does not work against this
endpoint yet — the loop would have to run on our side and be reported
back, which is not built.

**Streaming is not implemented here.** `"stream": true` is refused
saying so, rather than answered with one JSON object where the client is
waiting for SSE.

**Usage is not split.** A run records one token total and nothing keeps the
input and output halves apart, so `usage.input_tokens` reports 0 and
`output_tokens` carries the whole run rather than the completion alone. Every
response on both compat routes carries `x-almyty-usage-split: unavailable` so
a caller can tell the split apart from a measurement. Do not attribute cost
from it.

Compatibility shims are a fallback, not the default: Anthropic's
OpenAI-compatible endpoint drops thinking blocks, Gemini's shim loses
safety settings and grounding, Vertex's loses context caching. Routing
everything through chat completions would make every model worse than
calling it directly.

Native-first is a **default and a tie-break, not an invariant**. Once
routing filters on `(model, protocol)` pairs, a requirement asking for a
capability the native path lacks must be able to select a compat path.
The invariant is narrower: when two paths both satisfy a requirement,
prefer native, and record any downgrade in the route trace with the
capabilities dropped. Silence is forbidden, not the downgrade.

### The OpenAI-compatible route

`POST /v1/chat/completions` and `GET /v1/models` follow the same three rules:
the whole `messages` array reaches the run as a transcript, `temperature` and
`max_tokens` are honoured per request, and the token split is disclosed rather
than invented — `total_tokens` is measured, `prompt_tokens` and
`completion_tokens` are 0, and the same `x-almyty-usage-split` header says so.

What it cannot honour, it refuses with a 400 naming the field in
`error.param`: `tools`, `tool_choice`, `functions`, `function_call`, a
`response_format` other than `text`, `n` other than 1, `top_p` other than 1,
non-zero `frequency_penalty` or `presence_penalty`, `stop`, `seed`,
`logprobs` and `top_logprobs`. The defaults a client library sends unasked
(`n: 1`, `top_p: 1`, zero penalties) pass. `stream_options.include_usage` is
honoured: the final chunk before `[DONE]` carries `usage` with an empty
`choices` array.

A stream that fails after the headers are flushed ends with an SSE frame
carrying an `error` object, which is what the real API sends and what both
SDKs raise on, rather than `finish_reason: "error"` — not one of the five
OpenAI values, so a consumer switching on it reads a truncated answer as a
finished one. A non-streaming run that does not complete is a 502 carrying an
error object, for the same reason.

### Capabilities are protocol-scoped

"Z.ai supports extended thinking" is meaningless alone: true on its
`anthropic_messages` path, false on its `chat_completions` path. So
capabilities live per protocol and routing filters on `(model, protocol)`
pairs rather than on models.

### A generic provider per protocol

Every implemented protocol gets the same escape hatch the OpenAI path
already had: a base URL, auth and a model id for a vendor we have never
heard of, an internal endpoint, or a self-hosted server. No per-protocol
work; if the protocol is implemented, its generic provider is free. Those
take a user-supplied URL, so they pass through the L1 egress allowlist,
and a custom endpoint has no listing and no known capabilities, so the
user declares what it supports and validation is a real call.

## Cards

`GET/POST /models`, `GET/PATCH/DELETE /models/:id`. A card carries:

- `providerId` or `endpointRef.url`, plus `vendorModelId` (the id sent on the wire)
- `capabilities` (tools, vision, reasoning, embedding, structuredOutput), `contextLength`
- `privacyTier` (`local` < `private_cloud` < `public`), `region`
- `pricing` + `pricingSource`, optional `pricingOverride` (wins when set)
- `validationStatus`, `lastValidatedAt`, `lastValidationError`, `measuredLatencyMs`

Ways a card comes to exist:

- **Automatically, from the provider.** Creating an LLM provider, changing its configuration, and every passing health check (`POST /llm-providers/:id/test`, and the check that runs a second after create and update) import what the provider currently lists, in the background. Cards already present are left alone. A card whose vendor id has vanished from the list goes `inactive` with `metadata.retiredAt` and `metadata.retiredReason: "not listed by provider"`; it is never deleted, because runs and audit rows reference card ids, and it comes back on its own when the provider lists it again. An empty list (the vendor could not be asked) retires nothing. Deleting a provider retires its cards the same way (`retiredReason: "provider deleted"`); the card's `providerId` is nulled by the database, so it is no longer callable.
- **Health check as validation.** The health check makes a real call with the provider's resolved model. Passing records a validation run on that provider's card for that vendor id (`validationStatus: passed`, `lastValidatedAt`, `measuredLatencyMs`), creating the card when the catalog has none, so a fresh organization with one healthy provider can route right away. A `MODEL_NOT_FOUND` failure marks the card `failed` with the error; any other failure leaves the catalog alone. The audit row carries `source: health_check`.
- **Backfill on boot.** Every active provider that has no cards yet is synced once at startup (a queued job with a stable id, so replicas do it once; off under `NODE_ENV=test` and `MODEL_CATALOG_BACKFILL=off`).
- `POST /models/sync { providerId }` runs the same import for one provider by hand; `POST /models/sync` with no body runs it for every active provider of the org and returns a per-provider summary (`created`, `skipped`, `retired`, `reinstated`, `error`).
- `POST /models` against a stored provider (admin picks the vendor id).
- **A server you run.** Any OpenAI-compatible server (vLLM, Ollama, TGI, llama.cpp, LiteLLM) is a `custom` LLM provider (`POST /llm-providers { type: "custom", configuration: { apiUrl, apiKey? } }`, key encrypted like every other) plus an ordinary card (`POST /models { providerId, vendorModelId }`). Creating the provider also syncs what `GET <base>/models` lists. The UI's "A server you run" path does both calls.
- **A model on your cloud account.** `POST /model-deployments` creates the card at once (`status: deploying`, not selectable) and links it, unless `modelId` names an existing card; optional `name` and `vendorModelId` label it. When the endpoint reaches `ready` the reconcile processor fills `endpointRef.url` and `deploymentId`, sets the card `active`, and writes its provider row. The tick that moves the deployment into `ready` (claimed with a compare-and-set, so once however many ticks see it) then runs the validation itself, audited with `source: hosted_model_ready`, unless the card has already passed; a pass makes it selectable, and a failure is recorded on the card without affecting the reconcile.

Every register, validate, price change and route is an audit row (`model_registered`, `model_validated`, `model_price_updated`, `model_routed`).

## Pricing

Automatic. The daily job (`MODEL_PRICE_FEED_CRON`, default 04:00) loads the LiteLLM cost map and cross-checks OpenRouter; a disagreement above 25% is kept on the card in `metadata.pricingDisagreement`. Cards are priced at registration from the cached feed and refreshed by the job. `pricingSource` says where a number came from: `feed:litellm`, `feed:openrouter`, `native` (provider-reported), `adapter` (a deployment's cost snapshot), `manual` (an override), or `unpriced`. The hand-maintained table in `llm-models.helper.ts` is an offline seed only.

## Routing

An `llm_call` node (or any chat request) may carry a `routing` policy instead of a `providerId`:

```json
{
  "routing": {
    "objective": "cheapest",
    "privacyTier": "private_cloud",
    "regions": ["eu-central"],
    "capabilities": { "tools": true },
    "fallbackChain": ["<card id or vendor model id>", "..."],
    "pinnedModel": "<card id or vendor model id>",
    "budgetHeadroomCents": 500
  }
}
```

Selection is pure (`routing/model-router.ts`): filter by selectability, tier ceiling, region, capabilities and budget headroom, then order by objective (`cheapest` by blended feed price, `fastest` by measured p50, `pinned`, or an explicit `fallbackChain`). The chat runner walks the chain: a candidate that fails for a reason that is not the request's fault (retired model, quota, outage, auth on that provider) is skipped; a request-shaped failure (400, 413, 422) or a caller abort stops the walk.

**Organization default.** An `llm_call` node that names neither a `providerId` nor a `routing` policy uses the organization's default policy, `settings.defaultRouting`, when one is set. It has the same shape as the node policy and is read and written through the organization endpoints (`GET /organizations/:id`, `PATCH /organizations/:id { settings: { defaultRouting } }`; `null` clears it, other `settings` keys are left as they are). The PATCH validates the policy: `objective` is one of `cheapest | fastest | pinned`, `privacyTier` one of `local | private_cloud | public`, `regions` and `fallbackChain` are string arrays, `capabilities` an object of booleans, `pinnedModel` a string, `budgetHeadroomCents` a non-negative integer or `null`. A policy on the node always wins over the default. The executor caches the default for 30 seconds per organization, so a change applies to the next run, not the one in flight. A node with neither, in an organization without a default, fails with a message that says so.

**Latency learning.** `fastest` ranks by `measuredLatencyMs.p50`, which real traffic keeps current: after every routed answer the router folds the response time into the answering card (p50 as an exponential moving average with weight 0.2 for the new sample; p95 jumps to a slower sample at once and decays toward faster ones by a tenth per sample). The estimate lives in memory and is written to the card at most once a minute; after a restart it is seeded from the stored value. A validation run or a passing health check resets both to that single measurement.

The answer records what happened. `ChatResponse.routing` and the node result carry `{ modelId, modelVersionId, vendorModelId, providerId, rationale, attempt, tried, rejected }`, and the same lands in the audit log as `model_routed`. `nodeResults[nodeId].routing` on a run shows which card served which step and why.

Autonomous agents route too: `modelConfig.routing` on the agent replaces `providerId` for every step. Streaming takes the head of the plan (a stream cannot switch models mid-answer) and stamps the same attribution with attempt 1. With `MODEL_ROUTER_VERIFY_ESCALATION=true` and `routing.escalation: { onVerifyFail: 'next-candidate', maxEscalations? }`, a verifier rejection sends the revision to the next candidate of the plan instead of the same model; the run's working memory carries the adjusted policy and the count, and the run emits `route.escalated`.

**Several models in one agent.** Routing picks one model per step and falls back when it fails. Running models *alongside* each other is the agent graph's job, not the router's: a `parallel` node fans out to as many `llm_call` nodes as you like, each with its own `routing` policy or pinned provider, and a `merge` node collects the answers. Merge strategies are `first_response` (whichever returns first), `concatenate`, `best_of_n` (a judge model picks one) and `consensus`. So Claude, Kimi, Qwen and GPT can answer the same prompt in one run and a judge can choose between them, or four steps of one agent can each use a different model. The two mechanisms compose: every branch of a fan-out still routes, still records its attribution, and still falls back on its own.

Every card is called through a stored provider row. A card served by a model on the customer's cloud account gets one written by the reconcile processor when that model reaches ready: an `openai` provider pointed at the OpenAI-compatible base, so chat goes to `<base>/chat/completions` and the key lives in the credential store like any other provider's. A server the customer runs is a `custom` provider they create themselves (`POST /llm-providers`), with the same chat path. A card with no usable provider row is not a candidate, and a provider whose connection no longer resolves for the caller drops out of the plan rather than being called without it.

Routing needs the catalog module wired in (it is, in `app.module.ts`); without it a routed request fails with `ROUTING_UNAVAILABLE` rather than silently falling back.

## Models on your cloud account (`model-deployments`)

A model hosted on the customer's own cloud account is still one card in the Models list; where it runs is an attribute ("Runs on: Your Hugging Face account (Inference Endpoint)"), and its state, hourly cost, budget and start/stop/scale controls live on the card's detail. User-facing copy never says "deployment" or "tracked artifact": the docs site calls this "your cloud account" and each adapter "a cloud". The code names stay: the `model-deployments` module, the `ModelDeployment` entity, `/model-deployments`, `/model-adapters`, the CLI's `deploy`/`deployments`/`scale`/`teardown`, and `deploymentId` fields. User docs: `docs-site/content/models/your-cloud.mdx`.

`GET /model-adapters` describes every registered adapter as data: capabilities, the model references it accepts (`modelSchemes`), and a JSON schema for its config (`x-secret: true` marks fields that are encrypted at rest and never returned). `POST /model-deployments` records desired state and creates the card at once (`status: deploying`, linked through `endpointRef.deploymentId` once ready; optional `name` and `vendorModelId` label it; `modelId` attaches an existing card instead). The reconcile queue (`MODEL_RECONCILE_CRON`, default every 2 minutes) is the only thing that talks to a provider. `POST /model-deployments/:id/scale { replicas }` and `/teardown` change desired state only.

### Naming the model is configuration

A hosted model takes its source as a string. There is nothing to register first:

```
POST /model-deployments { "model": "hf://Qwen/Qwen3-0.6B", "providerType": "huggingface-endpoints" }
POST /model-deployments { "model": "fireworks://accounts/acme/models/qwen3-tuned", "providerType": "fireworks" }
```

Two kinds of reference. An **artifact** points at bytes and is pinned, so the model is reproducible: `hf://org/repo@sha` (a bare `hf://org/repo` is pinned to the commit it resolves to), `s3://bucket/prefix@etag`, `gs://bucket/prefix@generation`, `file:///path@sha`. A **provider reference** names a model that already exists on a platform, which versions it itself, so no pin is needed: `bedrock://`, `sagemaker://`, `vertex://`, `foundry://`, `azureml://`, `fireworks://`, `together://`, `baseten://`. Lineage (base model, quantization) is shown on the card as plain facts.

`modelVersionId` still works and is the other way in, for power users only: the registry (`/model-versions`, `almyty models register-version`) records a manifest digest, lineage and evaluation history against an artifact. It is documented in the API and CLI references as an optional aside, never as a front-door concept.

### Where the weights come from, and who can read them

almyty is not in the hosting business. A hosted model runs on the provider's own managed product, and the weights come from wherever that provider natively reads them, most often a Hugging Face repository. `registrySources` on each adapter names what its provider can really read, native default first. Weight files never pass through almyty.

That means the two do not mix freely, and the API says so rather than letting you find out from a provider error. Bedrock custom import reads S3 and cannot take a Hub repo. Hugging Face Inference Endpoints serves a Hub repo and nothing else. Vertex wants Cloud Storage or Model Garden. A provider reference runs only on the provider that owns it. A mismatch is refused at submit with `ADAPTER_UNSUPPORTED_SOURCE` and the list of what that adapter does accept, and `modelSchemes` lets a form filter in either direction: the providers that can run the model you have, or the sources the provider you picked will take.

That also makes our own object storage optional. It is needed only where a provider reads object storage natively: the AWS adapters and Fireworks read S3, Baseten mirrors from S3 or Cloud Storage through its delivery network, Vertex reads Cloud Storage, and a self-host points its own server at its own store. Connecting a registry bucket is not a precondition for anything else: a card from a configured provider, a server you run, and a hosted model from a Hugging Face repository all work without one. Each adapter passes the same conformance suite in fixture mode; set `CONFORMANCE_LIVE=<adapter key>` with real credentials to run it live. Adapters never import each other (`adapter-isolation.spec.ts` enforces it).

A hosted model with a `budgetId` is charged from the adapter's cost snapshot on every reconcile. Reaching the budget scales it to zero, writes `model_deployment_budget_stop`, and notifies.

## CLI

`@almyty/models`, documented in `packages/models-cli/README.md`. Every read
command takes `--json`.

```
npx @almyty/models list [--selectable] [--status active|inactive|error|deploying]
                        [--tier public|private_cloud|local] [--provider <providerId>]
npx @almyty/models get <id>
npx @almyty/models register --name <n> --provider <providerId> --model <vendorModelId>
                           [--tier t] [--region r] [--context n]
npx @almyty/models set <id> [--name n] [--tier t] [--region r] [--context n]
                           [--status s] [--price-in n --price-out n] [--clear-price]
npx @almyty/models sync [providerId]
npx @almyty/models validate <id>
npx @almyty/models delete <id>
npx @almyty/models route [--objective cheapest|fastest|pinned] [--tier t] [--regions a,b]
                         [--needs tools,vision] [--capabilities '<json>'] [--pinned m]
                         [--chain a,b] [--budget-headroom cents] [--prefer a,b]
npx @almyty/models versions
npx @almyty/models register-version --name <n> --uri <pinned registry uri> [--base b] [--quantizations q1,q2]
npx @almyty/models adapters
npx @almyty/models host <model> --adapter <key> [--base b] [--config-file <path>] [--config-stdin]
                        [--desired '<json>'] [--credential <id>] [--budget <id>] [--card <cardId>]
npx @almyty/models host --model-version <modelVersionId> --adapter <key> [...]
npx @almyty/models hosted
npx @almyty/models hosted <id>
npx @almyty/models scale <hostedId> <replicas>
npx @almyty/models teardown <hostedId>
```

`list` and `get` report **why** a card is not selectable — a status that is
not active and its retirement reason, nothing that can call it, or no passed
validation run — rather than printing a name and leaving the router's refusal
to be discovered by running something.

`route` is `POST /models/route-preview` from the terminal: it takes a policy
and answers with the ordered candidates and every rejection with its reason,
calling nothing. It exits 5 when no card satisfies the policy.

`set` is `PATCH /models/:id`. A `--price-in`/`--price-out` pair writes
`pricingOverride`, which wins over the feed; `--clear-price` drops back to it.
Both numbers are required together: half an override would price input by hand
and output from the feed.

**No secret is taken as a flag value**, because argv is visible in `ps`, in
shell history and in most CI logs. A server's key goes on its `custom` provider, never on the models CLI; adapter configuration comes from `--config-file`
or `--config-stdin`, or better, from `--credential <connectionId>` naming a
connection. `--config` is still accepted for the fields an adapter does not
mark `x-secret` and is refused the moment it carries one that is; `adapters`
prints which fields those are.

Exit codes are the suite's shared table: 0 success, 1 unexpected, 2 usage,
3 not authenticated, 4 not found, 5 the operation ran and failed.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `MODEL_CATALOG_BACKFILL` | unset | `off` skips the boot-time backfill of providers that have no cards yet |
| `MODEL_PRICE_FEED_CRON` | `0 4 * * *` | Price feed refresh; `off` disables |
| `MODEL_RECONCILE_CRON` | `*/2 * * * *` | Reconcile sweep for models on cloud accounts; `off` disables |
| `MODEL_STUB_ADAPTER` | unset | `true` registers the stub adapter in production too |
| `LLM_ALLOW_PRIVATE_URLS` | unset | `true` lets `custom` providers (a server you run) reach private or loopback hosts (a vLLM box on the LAN); mirrors `OLLAMA_ALLOW_PRIVATE_URLS` |
| `MODEL_REGISTRY_S3_*` | falls back to `STORAGE_S3_*` | Single-tenant seed only: creates the one organization's registry connection on first boot; ignored with more than one organization |
| `CONFORMANCE_LIVE` | unset | Adapter key whose conformance spec runs against the real provider |
