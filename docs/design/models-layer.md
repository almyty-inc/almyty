
# Spec: Models layer - catalog, registry, deployments, router (Phase A)

Status: ACCEPTED per Frane. Owner: teal-goat (lead), Codex builds under assignment. Scope: the core (catalog, registry, deployments, router tier 1, conformance) developed against two adapters, then every deployment adapter in the committed matrix below. Training adapters are a later assignment.

## Grounding in the current codebase (verified 2026-09-07, development @ Sep 4)

- NestJS + TypeORM + Bull. Repeatable-job pattern exists in modules/lifecycle (lifecycle-email processor with stable jobId + cron eviction) - reuse for the reconcile sweep. NOTE: the module name 'lifecycle' is taken by activation emails; the new modules are model-catalog, model-registry, model-deployments.
- entities/llm-provider.entity.ts: LlmProviderType enum (15 types), config JSON with apiKey/usageApiKey/apiUrl/model, field-crypto encryption, VersionedEntity. Providers stay as-is; a Model references a provider row.
- modules/llm-providers/llm-chat-runner.helper.ts: callLlmProvider retry/backoff (429/500/502/503), dispatchProviderCall. Router tier 1 hooks in here.
- modules/budgets: spend caps + budget-exceeded.exception - deployment budget gate reuses this, no new budget code.
- modules/credentials (+oauth2): provider account credentials for adapters live here, not in the adapter.
- modules/audit-log: extend run records with model attribution, do not build a parallel log.
- EE lives at backend/ee/modules.
- Verifier panel (modules/agents/agent-verifier.helper.ts) with all_pass|majority|any_fail_blocks -> becomes the escalation trigger + the interim eval score for gated promotion.
- Merged this week and to be built on, not duplicated (per teal-goat, #569/#575): DefaultModelResolver (blank model -> vendor live list by family, no literal ids), model-errors.ts (MODEL_NOT_FOUND), assertModelIsServed on provider save, lastErrorAt/lastSuccessAt on providers. The Model card's resolution and health fields extend these; no parallel default list, no parallel health tracking.
- Observability/eval module (wild-lynx spec, Langfuse-shaped, OTel) is PROPOSED, not built. Decision: Models ships a minimal internal EvalScore now with a documented migration to the scores API; do not build a judge harness here.

## Inference-provider support rule (answers 01M1ZXEH; per Frane, nothing hardcoded)

'Supported' is a property of registry data, not of a code-level list. A provider is selectable in any dropdown iff a provider card is registered for it with: (a) a working chat dispatch path, (b) assertModelIsServed-backed validation, (c) a pricing source (native API, LiteLLM cost map entry, or manual field), and (d) a passing validation/conformance run recorded on the card. The UI renders exclusively from registered cards, so: aws_bedrock disappears from the dropdown automatically today (no chat implementation -> no valid card) and reappears the day its dispatch path lands - nobody 'drops' or 'adds' providers by editing a list. OpenAI-compatible vendors (fireworks, deepinfra, perplexity, cerebras, novita, baseten, vLLM, LiteLLM-proxy) get named cards as data (base URL template, pricing source, quirks), addable/editable in the UI by an org admin without a release; the 12 tested types ship as pre-registered cards. azure_openai keeps its card only once it has tests. Same rule at both layers: inference providers = card + validation run; deployment adapters = registered adapter + passing conformance run. Nothing else confers 'support'.

## New entities (all VersionedEntity, org-scoped)

1. Model (model_catalog): providerId (FK llm_providers), name, endpointRef (nullable - filled by deployment or manual registration), base (e.g. qwen3-14b), modelVersionId (nullable FK); capabilities jsonb { tools, vision, reasoning, embedding, structuredOutput }; contextLength int; pricing jsonb { inPerMTok, outPerMTok, currency }; measuredLatencyMs jsonb { p50, p95, updatedAt }; privacyTier enum local|private_cloud|public; region; status enum active|inactive|error|deploying. This row IS the machine-readable model card the router reads. Manual registration of any OpenAI-compatible endpoint must work (CUSTOM provider) with all fields hand-set.

2. ModelVersion (model_versions): registryUri (s3://bucket/prefix@etag | hf://org/repo@sha | file:// for runner-local), base, sizeBytes, quantizations string[], lineage jsonb { trainingJobId?, datasetRef?, parentVersionId? }, evalScores jsonb (interim), manifestSha. Registry format: plain safetensors + almyty-manifest.json (schema in docs/model-registry.md: base, tokenizer ref, chat template, license, created, lineage). Vendor-neutral: S3-compatible is the default and the only registry the conformance suite uses. HF is an optional source, never required.

3. ModelDeployment (model_deployments): modelVersionId, providerType (adapter key), desired jsonb { hardware, replicas, minScale, maxScale, quantization, region, privacyTier }, providerConfig jsonb (opaque, validated by adapter, encrypted fields via field-crypto), externalRef jsonb (adapter-owned), actual jsonb (last reconcile read), state enum pending|deploying|ready|degraded|scaling|tearing_down|orphaned|failed, lastReconcileAt, budgetId (FK budgets). Invariant: nothing vendor-specific outside providerConfig/externalRef.

4. EvalScore (interim, model_eval_scores): modelVersionId, suite, score numeric, passed bool, runRef, createdAt. Written by the verifier panel today; replaced by the observability scores API when it ships (keep the table, swap the writer).

### Pricing feed (decided by Frane, 2026-09-08)

Prices are automatic, never a hand-maintained table. The card's pricing is filled by a daily job from two public sources: the LiteLLM cost map (primary; ~3,800 entries, updated daily, current ids present under plain keys) and the OpenRouter models API (cross-check, no key). Providers that publish prices natively (Together, OpenRouter) are read natively when the card's provider is one of them; self-deployed models get their price from the deployment adapter's costSnapshot. Each card records price, source and fetchedAt; an operator may override a price on the Models settings page with reset-to-feed. A card with no price from any source is marked unpriced on the card and on every run that used it, never silently zero. A disagreement between sources above a threshold flags the card. Vendor cost and usage APIs (OpenAI, Anthropic) reconcile estimated against actual spend where a key allows it. The existing pricing table in llm-models.helper.ts becomes an offline seed for air-gapped installs and nothing else.

## Adapter interface (frozen; modules/model-deployments/adapters/adapter.interface.ts)

ModelProviderAdapter: key; capabilities(): AdapterCapabilities; upload?(v, creds); deploy(d, creds) -> EndpointRef; readEndpoint(ref, creds) -> ActualState; scale(ref, n, creds); teardown(ref, creds); costSnapshot(ref, creds) -> CostSnapshot. train?/jobStatus? slots reserved for Phase B, unimplemented.
AdapterCapabilities: architectures string[]|'any'; lora merged|multi|none; serverless; dedicated; scaleToZero; regions; registrySources ('s3'|'hub'|'local')[].
Rules: an adapter may not import or invoke another adapter; every adapter must accept registrySources ['s3'] alone; UI warnings derive from capabilities() (architecture mismatch blocks at submit, not at provider error).

## Phase A adapters (the two extremes)

- huggingface-endpoints: managed product path. create/read/scale/pause/delete Inference Endpoint from a registry URI; hub + s3 sources; scaleToZero true.
- modal: raw-container path. Pinned vLLM container image running the version from S3; serverless scale-to-zero; architectures 'any'. Conformance reference adapter.
- Existing Ollama + CUSTOM providers get thin wrapper adapters (readEndpoint/costSnapshot only, deploy/teardown = clean UnsupportedOperation) so catalog and router treat every model uniformly.

## Reconcile loop (model-deployments.processor.ts, Bull)

Repeatable sweep (stable jobId, MODEL_RECONCILE_CRON default */2 min) + on-demand job per mutation. Each tick: readEndpoint -> diff vs desired -> action (deploy/scale/teardown) or mark degraded/orphaned; write actual; emit audit-log event; costSnapshot -> budgets spend; budget exceeded -> scale to zero + notify (reuse budget-exceeded flow). Orphan rule: externalRef exists with no matching desired state past retention -> teardown + audit event. Never delete weights, only endpoints.

## Router tier 1 (llm-chat-runner.helper.ts + new model-router.helper.ts)

Selection: (1) hard filters - privacyTier ceiling, region allowlist, capability requirements, status=active, budget headroom; (2) explicit fallback chain if configured on the node; (3) otherwise rank by objective (cheapest|fastest|pinned) over the filtered set. No learned router, no embedding match in Phase A (Phase C). Fallback: on retryable exhaustion or provider error, advance to next model in chain (callLlmProvider iterates a resolved model list instead of a single provider). Audit: every run records { modelId, modelVersionId, routingRationale, attempt }. Escalation hook: verifier failure may advance the chain, flag MODEL_ROUTER_VERIFY_ESCALATION, default off.

## Conformance suite (modules/model-deployments/__tests__/conformance/)

Parametrized over adapters. Fixture mode in CI; live mode (CONFORMANCE_LIVE=<adapter>) against a real account required before an adapter is marked shipped. Cases: deploy tiny model (Qwen3-0.6B or smaller) from S3 -> poll ready -> chat completion through the gateway -> scale to zero -> teardown -> costSnapshot sane; failures: unsupported architecture (clean pre-submit error), quota exceeded, expired credential, orphan detection.

## API + UI (everything configurable - Frane's rule: sane defaults, configurable in the proper menus)

REST: CRUD /models, /model-versions, /model-deployments (+ POST :id/promote, :id/teardown), llm-providers controller conventions. GET /model-adapters returns each adapter's capabilities() + JSON schema for providerConfig; ALL UI renders from that - shipping a new adapter requires zero UI changes. Generated deploy form with pre-submit capability warnings, schema-driven like tool config forms. Org Settings -> Models: editable defaults table (recommended provider per usage tier, pre-filled, reset-to-recommended) + per-adapter enable/disable (disabled = gone from forms and router). Per-node routing card in the builder (privacy ceiling, region allowlist, objective, fallback chain) inheriting org defaults, same inherit pattern as the privacy block. Phase A screens: Models list beside Providers, deployment detail (desired vs actual, state timeline, cost), register-custom-endpoint, generated deploy form, org defaults table, per-node routing card. CLI: almyty models list|register|deploy|teardown.

## EE split

Core (Apache): entities, adapter interface, both adapters, reconcile, router tier 1, conformance, CLI, all Phase A UI. EE (backend/ee/modules/model-lifecycle): canary traffic split + comparison analytics, auto-promotion policies, retrain triggers, managed provider accounts. Phase A leaves clean extension points only (promotion is a plain endpoint core-side).

## Gates (Phase A done =)

1. Hand-registered custom OpenAI-compatible endpoint; router selects it under a privacy/cost policy; run audit shows model + version + rationale.
2. Same ModelVersion deployed from S3 to HF Endpoints and to Modal by changing only providerType + providerConfig; chat traffic flows through both via the gateway; router never referenced provider specifics.
3. Conformance green (fixtures) for both adapters + one live run each; budget cap scales a deployment to zero and audits it.

## Non-goals (Phase A)

Training, datasets, remaining adapters, tier-2 LLM orchestrator, embedding-based routing, canary analytics, Helm chart, HF Inference Providers marketplace, any UI beyond the six Phase A screens.

## Open items

Observability scores API: swap EvalScore writer when it lands, keep the table. Coordinate rebases with the privacy block on development. Product naming 'Models' beside Tools and Agents: Frane to confirm.


## Provider matrix (committed)

Inference providers (call) and deployment adapters (deploy custom weights) are distinct concepts everywhere. Every deployment adapter below is committed scope of this assignment; "Phase A" names only the two the core is developed against.

Full committed adapter list:
- Core pair: modal (conformance reference), huggingface-endpoints
- Managed custom-model hosts: baseten (NEW - the largest managed custom-model platform, was missing), together, fireworks (also covers Azure via Foundry)
- Customer's own cloud: aws_bedrock custom import, sagemaker, vertex, azure-foundry (native)
- Raw GPU: runpod, digitalocean
- EU-hosted: nebius (NEW - GDPR-sensitive workloads, pairs with our EU AI Act mapping)
- Local: ollama runner wrapper, custom URL wrapper

Call-only, NEVER deploy adapters (provider cards only): openrouter (aggregator, hosts no weights), groq (LoRA hosting enterprise-gated), deepinfra, cerebras, novita, zai, replicate (now Cloudflare), perplexity.

Per-adapter definition of done: conformance green in fixture mode + one live smoke test with evidence in the PR + provider card with pricing source + enum value/dispatch path where new. Verify each provider's current deploy API before implementing and record deltas in the design doc. Spec + build prompt files updated with Frane (provider matrix section + new deliverable 9).


## Sequencing

No time estimates: agents build this, so sequencing is dependency order and gates only.


