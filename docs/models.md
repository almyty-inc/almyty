# Models layer

The models layer decides which model answers a call, what it costs, and where it runs. It has three parts:

| Module | Path | Owns |
|--------|------|------|
| Catalog | `backend/src/modules/model-catalog/` | Model cards, the router, the automatic price feed |
| Registry | `backend/src/modules/model-registry/` | Weights and manifests (`s3://`, `file://`, `hf://`) |
| Deployments | `backend/src/modules/model-deployments/` | Provider adapters, the reconcile loop, budgets |

Design and provider deltas: `docs/design/models-layer.md`. Registry details: `docs/model-registry.md`.

## Support is data, not a list

There is no code list of supported models. A model is usable when its **card** exists in the org's catalog and:

1. it has a way to be called (a stored LLM provider row, or an endpoint URL from a deployment),
2. its status is `active`, and
3. one **validation run** has passed (`POST /models/:id/validate` makes a real, short call and records the result).

`Model.isSelectable()` is the only definition of "usable". A retired vendor model fails validation and drops out; a new self-hosted endpoint joins the moment its run passes. Nothing else flips the flag.

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
- `POST /models` against a stored provider (admin picks the vendor id)
- `POST /models/register-endpoint { name, url, apiKey?, vendorModelId, privacyTier?, region? }` for any OpenAI-compatible server you run yourself. The URL and key become a `custom` LLM provider row (key encrypted like every other), the card points at it.
- A deployment reaching `ready` fills the card it was created for (`endpointRef.url`, `deploymentId`).

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

Routing needs the catalog module wired in (it is, in `app.module.ts`); without it a routed request fails with `ROUTING_UNAVAILABLE` rather than silently falling back.

## Deployments

`GET /model-adapters` describes every registered adapter as data: capabilities and a JSON schema for its config (`x-secret: true` marks fields that are encrypted at rest and never returned). `POST /model-deployments` records desired state; the reconcile queue (`MODEL_RECONCILE_CRON`, default every 2 minutes) is the only thing that talks to a provider. `POST /model-deployments/:id/scale { replicas }` and `/teardown` change desired state only.

Adapters in Phase A: `huggingface-endpoints` (REST), `modal` (drives the `modal` CLI; Modal has no HTTP API), `ollama` (pulls or creates the model on a local or remote Ollama server, loads it, unloads on scale-to-zero, deletes on teardown; `hf://` versions pull through `hf.co/`, `s3://` versions need `registryMirrorPath` on the host), `custom-endpoint` (watches and prices an OpenAI-compatible server managed elsewhere; cannot deploy), and `stub` outside production.
 Each passes the same conformance suite in fixture mode; set `CONFORMANCE_LIVE=<adapter key>` with real credentials to run it live. Adapters never import each other (`adapter-isolation.spec.ts` enforces it).

A deployment with a `budgetId` is charged from the adapter's cost snapshot on every reconcile. Reaching the budget scales it to zero, writes `model_deployment_budget_stop`, and notifies.

## CLI

```
npx @almyty/models list [--selectable] [--json]
npx @almyty/models get <id>
npx @almyty/models register --name <n> --provider <providerId> --model <vendorModelId> [--tier public|private_cloud|local] [--region r]
npx @almyty/models register-endpoint --name <n> --url <base url> --model <vendorModelId> [--api-key k] [--tier ...] [--region ...]
npx @almyty/models sync <providerId>
npx @almyty/models validate <id>
npx @almyty/models versions
npx @almyty/models register-version --name <n> --uri <pinned registry uri> [--base b] [--quantizations q1,q2]
npx @almyty/models adapters
npx @almyty/models deploy --model-version <modelVersionId> --adapter <key> [--config '<json>'] [--desired '<json>'] [--credential <id>] [--budget <id>] [--model <cardId>]
npx @almyty/models deployments
npx @almyty/models scale <deploymentId> <replicas>
npx @almyty/models teardown <deploymentId>
```

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `MODEL_CATALOG_BACKFILL` | unset | `off` skips the boot-time backfill of providers that have no cards yet |
| `MODEL_PRICE_FEED_CRON` | `0 4 * * *` | Price feed refresh; `off` disables |
| `MODEL_RECONCILE_CRON` | `*/2 * * * *` | Deployment reconcile sweep; `off` disables |
| `MODEL_STUB_ADAPTER` | unset | `true` registers the stub adapter in production too |
| `MODEL_REGISTRY_S3_*` | falls back to `STORAGE_S3_*` | Single-tenant seed only: creates the one organization's registry connection on first boot; ignored with more than one organization |
| `CONFORMANCE_LIVE` | unset | Adapter key whose conformance spec runs against the real provider |
