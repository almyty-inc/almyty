# The six layers

**Status: ACCEPTED** (2026-09-10). Supersedes the earlier orchestration
draft, which conflated layers. Incorporates the protocol registry decision
of the same date, which supersedes the earlier "provider cards are data
only for the OpenAI-compatible bearer family" framing.

Owner: wild-lynx (spec), teal-goat (implementation). Accepted by Frane.

---

## The rule

Six layers: **Connections, Models, Routing, Roles, Strategies,
Orchestrator.** Each is configurable on its own and depends only
**downward**. Never sideways, never upward.

A user can stop at any layer and the product still works:

| Stop at | You get |
|---------|---------|
| Connections | Connect accounts, call models by hand |
| + Models | A catalog, deployments, your own fine-tunes |
| + Routing | Pick a model from a requirement, no agents involved |
| + Roles | Agent slots. Pin everything and never use routing |
| + Strategies | Execution shapes over roles, model-agnostic |
| + Orchestrator | Something picks the strategy. Off by default |

Two invariants that failed in the earlier draft and are fixed here:

1. **A strategy may never name a concrete model.** If a strategy row
   contains a model id, the layering is broken.
2. **Measurement is cross-cutting, not part of orchestration.** Route
   trace, budget, verifier and co-failure measurement are consulted by
   whichever layer executes; they are not a layer.

Enforcement: a lint rule or test fails the build on an upward import. This
is not a convention, it is checked.

---

## L1 Connections

Owns accounts, credentials, auth methods, grants and health. **Knows
nothing about models.**

**Entities.** `Connector` (data) / `Connection` (a Credential plus
connectorKey, accountLabel, health, scopes) / `ConnectionGrant`
(principal x permission x optional budget).

**Connect methods.** `oauth2_pkce`, `oauth2_code`,
`client_credentials`, `api_key` (deep link to the vendor's key page plus
live validation), `cloud_iam`, `service_account`, `installation`.

**Single-store rule.** No module holds a third-party secret outside
`credentials`. Ratcheted by `no-secrets-outside-credentials.spec.ts`.

**Security, and it belongs here rather than in Models.** Any user-supplied
base URL goes through an egress allowlist with private-range blocking
(SSRF). Every generic provider in L2 takes a user-supplied URL, so this is
the layer that has to hold the gate.

**Interface up.** `resolveConnection(id, principal)`, grant-checked;
`connectionHealth(id)`.

**Configurable.** Enabled connectors per org, owner scope (org or user),
`allowUserScopedConnections`, grants.

---

## L2 Models

Owns what a connection can serve. Depends on L1 only.

**Entities.** `Model` (catalog entry) / `ModelVersion` /
`ModelDeployment` / `EvalScore`.

**Three equal ways a model enters the catalog.** None is the primary one:

1. **Listed** from a provider's model listing.
2. **Typed** by id where the vendor documents no listing, validated by a
   real call. Four shipped vendors document no listing; this is normal.
3. **Deployed** from your own weights.

### Protocols

**There is no single generic path with exceptions.** There are several
real wire protocols, each spoken by multiple vendors. Each protocol is
**one implementation in code that many vendors share**: implement it once,
and every vendor speaking it becomes a row.

**The protocol registry. This vocabulary is closed; extending it is a
code change, deliberately.**

| Protocol | Notes |
|----------|-------|
| `chat_completions` | OpenAI Chat Completions |
| `responses` | OpenAI Responses. Perplexity is already this shape, which is why it needed bespoke code |
| `anthropic_messages` | Not Anthropic-only: Baseten, Z.ai and Moonshot expose it so Anthropic-SDK clients work |
| `gemini_generate_content` | Google direct and Vertex |
| `bedrock_converse` | |
| `cohere_v2` | |
| `embeddings` | |
| `rerank` | Cohere's shape is the de facto one others copy |

**Auth is a separate enum, orthogonal to protocol**: `bearer`,
`x_api_key`, `sigv4`, `service_account`, `azure_key`, `custom_headers`.
Vertex minting a one-hour token per call is **auth**, not protocol.

### Provider profiles

Named `providerProfile`. Not "card": that word already means a model
catalog entry in this codebase and the collision would reach the schema.
No shared word between the two concepts.

A profile holds a **map of protocols** with one marked preferred:

```
zai     { anthropic_messages (preferred), chat_completions }
cohere  { cohere_v2 (preferred), chat_completions, rerank, embeddings }
qwen    { dashscope_native (preferred), chat_completions }
```

This dissolves the quirk-override problem. Cohere serving chat on the
compatibility base while its listing stays on native `/v1/models` is not
an override, it is **two protocol entries with different bases**. The same
applies to the other apparent inconsistencies: Hugging Face's endpoint
precedence, Ollama's root-versus-base, Perplexity's shape, Azure's path.

Per-protocol fields: base URL (with `{dotted.path}` substitution for a
base that embeds the account's own region, resource or endpoint id), auth,
path, listing path and envelope, pricing source.

Anthropic, Google, Bedrock and Foundry **keep their profiles**, with
`protocol` set accordingly. Nothing goes back into a switch.

### One registry, both directions

The same `anthropic_messages` implementation serves inbound clients and
calls outbound vendors. Writing it twice is the duplication that caused
most of this week's bugs.

**Inbound protocols are translators at the edge, never branches through
the core.** Each converts to one internal request shape; outbound
translates back out. So a new inbound protocol is one adapter and composes
with every layer automatically.

Inbound order: `chat_completions` (already served), then
**`anthropic_messages`** (highest value: it is what makes Claude Code and
every Anthropic-SDK client work against almyty with a base-URL change, and
it carries thinking blocks and real tool use instead of flattening them),
then `responses`, then `gemini_generate_content`, then
`rerank`/`embeddings`. **Skip `bedrock_converse` inbound**: SDK plus
signing, small audience, poor ratio.

### Native first

Compatibility shims are a fallback, not the default. They lose real
things: Anthropic's OpenAI-compatible endpoint drops thinking blocks and
fine-grained tool use, Gemini's shim loses safety settings, grounding and
most multimodal handling, Vertex's loses context caching, Qwen's OpenAI
mode hides DashScope features.

Routing everything through `chat_completions` would ship a product that
makes every model worse than calling it directly, which is the opposite of
the pitch.

Calls go native unless (a) a role or strategy needs a capability only
another path provides, or (b) the user overrides.

### Capabilities are protocol-scoped

**Not vendor-scoped.** "Z.ai supports extended thinking" is meaningless
alone: true on its `anthropic_messages` path, false on its
`chat_completions` path.

So the model carries capabilities **per protocol**, and L3 filters on
`(model, protocol)` pairs rather than models. Any downgrade from native to
compat is a deliberate, **recorded** loss: the route trace names which
capabilities were dropped and why. Silent degradation is the exact bug
class that has been biting all week.

### A generic provider per protocol

We have "Custom OpenAI-compatible URL" for vendors we have never heard of.
Every implemented protocol gets the same escape hatch: Custom Responses,
Custom Anthropic Messages, Custom Gemini, Custom Cohere, rerank,
embeddings. Same form each time: base URL, auth, model id.

That covers the internal endpoint, the vendor that launched last week, and
self-hosted servers (vLLM and TGI serve OpenAI-shaped, and plenty now
serve Anthropic-shaped). **No per-protocol work**: if the protocol is
implemented, its generic provider is free.

Two requirements: these take a user-supplied URL so they go through the L1
egress allowlist, and a custom endpoint has no listing and no known
capabilities, so the user declares what it supports and validation is a
real call, exactly like a typed model id.

### Deployments

Adapters: fireworks, together, baseten, modal, runpod,
huggingface-endpoints, aws-bedrock-import, sagemaker, vertex,
azure-foundry, plus digitalocean and nebius, plus the ollama and custom
wrappers. Ollama Cloud is a distinct connection.

The ten named first are a **live-verification priority order, not an
exclusion list**. Working code is not deleted for being outside it.

**Replicate is added.** It was excluded for having "no chat-completions
path to ride", which means the filter in use was "is it OpenAI-shaped and
cheap to wire" rather than "does it matter", while a bespoke dispatch was
built for Perplexity. Replicate is one of the best-known places to run open
and custom models, which is the product goal.

Adapter priority is driven by `docs/design/byo-weights-market.md`: whether
a provider takes an **arbitrary repo or your own fine-tune** versus a fixed
catalog is the distinction that matters here, and it was never made
explicitly before.

**Interface up.** `listModels(filter)`, `getModel(id)`,
`callModel(modelId, request)`.

**Configurable.** Catalog membership, per-model overrides (price, privacy
tier, region, enabled), deployment desired state.

---

## L3 Routing

Owns: given a requirement, choose a model. Depends on L2 only.

**Usable with no agent.** The OpenAI-compatible endpoint takes a policy
directly.

**In.** `ModelRequirement {capabilities, minContext, maxBlendedPrice,
privacyTierCeiling, region, tags}` plus `RoutingPolicy {objective:
cheapest | fastest | pinned, fallbackChain, pinnedModel,
connectionPreference}`.

**Out.** `RoutePlan {ordered candidates, rejected with reasons}`.

**`connectionPreference` is applied BEFORE cost ranking.** Which account
runs a model is a commercial decision (committed cloud spend, negotiated
contracts, direct vendor relationships) and it is usually already made
before we see it. Cost ranking operates only inside the surviving set.

Filtering is on `(model, protocol)` pairs, per L2.

**Interface up.** `plan(requirement, policy)`.

**Configurable.** Org default policy, per-call override, preference order,
objective.

---

## L4 Roles

Owns an agent slot with a requirement and a binding. Depends on L3
optionally and L2. Knows nothing about strategies.

`AgentRole {agentId, key, displayName, requirement, binding}` where
binding is `{pinned, modelId}` or `{resolved, policy}`.

Nodes reference `roleKey`. The existing per-node model field **stays
valid** and is deprecated in documentation only.

**A pinned binding never touches L3.** Roles are fully usable with routing
switched off. Resolved bindings are recorded per run, so a run always
names the concrete model per role.

**This is the vendor-independence fix.** Rebinding the principal role from
a hosted frontier model to your own fine-tune is a binding change, with no
graph edit.

**Interface up.** `resolveRoles(agentId, runContext)`.

**Configurable.** Role set, requirement, binding mode, per-run override.

---

## L5 Strategies

Owns the execution shape over roles. Depends on L4 only. **Must not name a
concrete model.**

`Strategy {key, displayName, roleSlots, shape}` as data, seeded, editable.

Built-ins: `single`, `cascade`, `best_of_n`, `panel`,
`explore_extract_patch`.

**A StrategyCompiler compiles strategy plus role bindings into the
existing execution graph.** The engine does not change shape. If you find
yourself editing the engine, stop and reconsider the compiler.

**Eject-to-graph** turns any strategy into a plain editable graph.

**New node type `extract_context`.** N prior rollout transcripts plus the
task, one call on a role slot, a schema-validated brief
`{relevantFiles, symbols, callers, tests, notes}` into run context. Its
own step, its own cost.

**Interface up.** `compile(strategyKey, roleBindings)`,
`describe(strategyKey) -> {roleSlots, costBand, latencyBand}`.

**Configurable.** Strategy per agent, parameters (N, thresholds), custom
strategies, eject.

---

## L6 Orchestrator

Owns choosing a strategy, and optionally bindings. Depends on L5 and L3.

**Off by default** (`ORCHESTRATOR_ENABLED`).

A small model on an orchestrator role receives the request, the strategies
via `describe()`, and eligible models as tool-style descriptions. It
returns `{strategy, roleBindings, reasoning}`, schema-validated,
budget-accounted, with a 2s default timeout, falling back to the
configured static strategy on **any** failure.

**Depth limit: one layer above strategies.** No orchestrators choosing
orchestrators. Enforced in code.

**Configurable.** Enabled, model, timeout, fallback strategy, allowed
strategies.

---

## Cross-cutting, not a layer

**Budget.** `BudgetPolicy {ceilingPerRun, ceilingPerTask,
stopWhen{verifierPasses, confidenceAbove, marginalGainBelow}, onExceed:
stop | degrade | ask}`, enforced by the existing budgets module, consulted
between stages by whichever layer executes. Every decision records the
projection that caused it.

**Verifier.** Interface `score(candidates, task, context) -> {candidateId,
score, passed, rationale}`. Implementations: `panel` (the existing
cross-vendor refute panel, unchanged, default), `model` (any catalog entry
as scorer), `trained` (served via runner or a deployed endpoint). Writes
`EvalScore`. `POST /verifiers/:id/export` produces a training set from run
history. We ship the **recipe** in `docs/verifiers.md`, not weights.

**Route trace.** Every step records `hops[] {layer, decidedBy, chosen,
alternatives, reason, latencyMs, costEstimate}`. Layer values include
provider-side routers and gateways, because the decision continues below
us. Where a provider reports what it actually served, record it and **flag
divergence**. Mark opaque-cost hops rather than reporting a number we
cannot know. Records capability loss on any native-to-compat downgrade.

**Beta (co-failure rate).** A nightly job per task class: how often every
eligible model failed the same request. This is the mathematical ceiling
on any routing gain, surfaced as "routing headroom". Without it nobody can
tell whether more routing work buys anything.

---

## UI

Existing design system only: shadcn/ui, zinc-950 canvas, zinc-900 cards,
solid zinc-800 borders, cyan scale, Manrope. **No new primitives.**

One surface per layer, each usable on its own:

- **Connections gallery.** Best-available connect method, health, scopes,
  owner, grants, rotate and disconnect, add custom connector.
- **Models catalog.** Profile fields plus origin (listed, typed,
  deployed), per-model overrides, deployments desired versus actual with
  cost, versions as "tracked artifacts" with the note that most people
  never need one.
- **Routing policy editor with live preview**, showing what a sample
  requirement resolves to and what was rejected and why.
- **Roles panel** in the builder: slots with requirement and binding, the
  resolved model with vendor, price, latency and privacy, one click
  between pinned and resolved, and the server's typed refusal rendered
  with its accepts list.
- **Strategy picker.** Inline shape diagram, role slots needed, cost and
  latency bands, parameters, eject.
- **Orchestrator settings.** Enable, model, timeout, fallback, allowed
  strategies.
- **Run view route-trace timeline** with expandable hops and visible
  candidate scores.
- **Budget panel.** Ceiling, projection, live spend, stop rule, and the
  reason when degraded.
- **Routing headroom** on analytics.

Every surface ships a real empty state naming the first action, plus
keyboard paths in builder panels.

---

## Open core

Safety and core capability are free. Governance, scale and analytics are
paid. **Core must be fully usable without EE, and EE must never be
required for a safety property.**

**Core (Apache).** All six layers in full: every connect method, all
deployment adapters, routing, roles, all built-in strategies,
`extract_context`, the orchestrator, budget policy with per-run ceilings,
the verifier interface with panel and model implementations, route-trace
recording, all the UI above, all documentation.

**EE (`backend/ee/modules/`).** Trained-verifier serving and the
training-data pipeline; cross-run and org-wide cost and quality analytics
including the beta dashboard; strategy A/B with statistical comparison;
auto-promotion of strategies or bindings from measured results; org-wide
routing and connection policy enforcement (pairs with
connections-governance); chargeback per role and strategy; long-horizon
route-trace retention and export.

---

## Documentation

One document per layer, each standing alone: `connections.md`,
`models.md`, `routing.md`, `roles.md`, `strategies.md`,
`orchestrator.md`, plus `verifiers.md` and `budgets.md` for the
cross-cutting concerns, plus `providers.mdx` **generated from profile
data**.

`routing.md` must state the honest limits: the co-failure ceiling, cascade
overhead inside agent loops, and latency stacking when composing with
provider-side routers.

Status headers everywhere. Dated Verified sections for any provider claim.

---

## Gates, one per layer

1. **Connections.** A PKCE connect and an api_key connect both end in a
   validated connection with a resolved account label. An agent can only
   use a connection it was granted. A base URL outside the allowlist is
   refused.
2. **Models.** The same ModelVersion deploys to two adapters by config
   change only. A model typed by id with no listing works. Per-model
   overrides take effect. A vendor speaking two protocols is callable on
   both, and the preferred one is used by default.
3. **Routing.** `plan()` is callable with no agent. `connectionPreference`
   beats cost ranking. Preview shows chosen and rejected with reasons.
4. **Roles.** An agent with every role pinned runs with routing disabled
   entirely. Rebinding the principal to a self-deployed fine-tune needs no
   graph edit.
5. **Strategies.** `explore_extract_patch` runs end to end and beats
   always-frontier on cost at equal or better quality on a real task set.
   No strategy row contains a model id. Eject produces an editable graph
   that behaves identically.
6. **Orchestrator.** Chooses a strategy, is budget-accounted, falls back
   cleanly on timeout, is disabled by default, and the product is fully
   usable with it off.
7. **Cross-cutting.** Budget stops a run early on verifier pass with the
   projection recorded. Route trace shows a provider-side hop and flags
   requested-versus-served divergence. Beta computes on real run history.

---

## What already exists

Checked against the tree on 2026-09-10. This is the difference between
"build six layers" and "finish six layers", and it is most of the plan's
value: the majority of L1 to L3 is already built and the work is
extension, not creation.

| Layer | Exists today | Missing |
|-------|--------------|---------|
| L1 Connections | `modules/connections/` with the connector catalog, ConnectMethod schema, PKCE, grants, rotation, EE governance hook, and the single-store ratchet | The egress allowlist as an L1 concern (today it is per-consumer, e.g. `OLLAMA_ALLOW_PRIVATE_URLS`) |
| L2 Models | `model-catalog/`, `model-registry/`, `model-deployments/` with 15 adapters, model-as-configuration, the source compatibility matrix, the price feed | Provider profiles as data (started, `feat/vendor-cards`), the protocol registry, per-protocol capabilities, inbound protocols beyond chat_completions, Replicate, generated `providers.mdx` |
| L3 Routing | `model-catalog/routing/` with policy, objectives, fallback chain, latency learning, verify escalation, and `selectCandidates` **already returning rejected-with-reasons** | `connectionPreference` applied before cost ranking, `plan()` exposed standalone with no agent, filtering on `(model, protocol)` pairs, the live-preview endpoint |
| L4 Roles | Nothing. The per-node model field and `modelConfig.routing` are the current mechanism | The whole layer: entity, migration, `roleKey` on `llm_call`, resolution, per-run recording |
| L5 Strategies | The execution graph, and `parallel`, `merge`, `verify` node types that strategies compile down to | The whole layer: entity, seeds, compiler, eject, `extract_context` node |
| L6 Orchestrator | Nothing | The whole layer |
| Budget | `modules/budgets/`, deployment budget stops, `budgetHeadroomCents` in routing | `BudgetPolicy` with `stopWhen`, between-stage consultation, recorded projections |
| Verifier | `agent-verifier.helper.ts` with the cross-vendor refute panel, and the verify node | The interface with model and trained implementations, `EvalScore` writes, the export endpoint |
| Route trace | `routing` attribution stamped on responses, node results and the audit log | `hops[]`, provider-side hops, requested-versus-served divergence, opaque-cost marking, capability-loss recording |
| Beta | Nothing | The nightly co-failure job and routing headroom |

Two conclusions worth stating rather than leaving implicit. First, L1 to
L3 are extensions of working code, so their PRs should be small and their
risk is regression rather than novelty. Second, L4 to L6 are genuinely
new, and they are also the layers with no existing users, so they can be
built behind flags without a shim period.

## Build plan

**This extends existing code. Nothing here is a rewrite.**

Read before writing anything: `CLAUDE.md`,
`docs/design/models-layer.md`, `backend/src/modules/agents/**`
(`agent-execution.engine.ts`, `agent-node-executor.ts`,
`agent-collaboration.helper.ts`, `agent-cost-estimator.ts`,
`agent-verifier.helper.ts`), `backend/src/modules/model-catalog/routing/**`,
`backend/src/modules/budgets/**`, `backend/src/modules/credentials/**`,
`backend/src/modules/audit-log/**`, `backend/ee/modules/**`,
`frontend/src/pages/agent-builder.tsx` and `models.tsx`.

### Order of operations

0. Rebase `feat/models-layer-phase-a` onto current development and re-run
   everything. **Measured 2026-09-10: 26 ahead, 4 behind**, and three of
   the four are this branch's own merges plus a docs commit. This is
   housekeeping, not a gate. (An earlier claim of "23 behind" was a
   reversed `rev-list` reading.)
1. **#600** through review against the amended models spec, merged.
2. **Provider profiles**: swap the entity switches to a lookup behind the
   existing equivalence suite, merged separately. Apply the
   `providerProfile` rename and the `protocol` enum first.
3. **The six layers, one PR per layer**, in dependency order. A layer's PR
   must not touch a layer above it.

### One PR per layer

1. **Connections.** Connector catalog, ConnectMethod schema, PKCE in
   `oauth2.service`, `connections:*` permissions, grants, a
   resolve-through-grant helper, and the egress allowlist with
   private-range blocking for user-supplied base URLs. Consumers migrate
   to `credentialId` behind read-through shims; old columns drop only when
   every consumer is green.
2. **Models.** Provider profiles as data with the protocol registry and
   the closed vocabulary. Protocol implementations shared across vendors,
   both directions. Three catalog entry paths equally supported.
   Per-model, per-protocol capabilities. Per-model overrides. Ollama Cloud
   as its own connection. Replicate adapter. `providers.mdx` generated
   from profile data.
3. **Routing.** `plan(requirement, policy)` standalone with no agent
   dependency. `connectionPreference` applied before cost ranking.
   `RoutePlan` carries rejected-with-reasons. Filtering on
   `(model, protocol)` pairs. A live-preview endpoint for the policy
   editor.
4. **Roles.** `AgentRole` entity and migration. `llm_call.config.roleKey`
   alongside the existing model field, both valid. Resolution through L3
   only when `binding.mode` is resolved. Resolved bindings recorded per
   run.
5. **Strategies.** `Strategy` entity and seeds. `StrategyCompiler`
   producing the existing execution graph. Eject-to-graph. The
   `extract_context` node with schema-validated output. A database
   constraint or test that makes it impossible for a strategy row to
   contain a model id.
6. **Orchestrator.** Behind `ORCHESTRATOR_ENABLED`, default off. Small
   model on an orchestrator role, schema-validated output,
   budget-accounted, 2s timeout, clean fallback to the static strategy,
   depth limit of one enforced in code.
7. **Cross-cutting.** BudgetPolicy consulted between stages with recorded
   projections. The Verifier interface with panel (unchanged default),
   model and trained implementations, writing `EvalScore`, plus the export
   endpoint. RouteTrace hops including provider-side routers, with
   requested-versus-served divergence flagging and opaque-cost marking.
   The nightly beta job.
8. **Frontend.** One surface per layer as specified, existing design
   system only, no new primitives, real empty states, keyboard paths,
   tests alongside.
9. **EE.** `backend/ee/modules` as listed above. Core fully usable
   without any of it.
10. **Docs.** One per layer plus `verifiers.md`, `budgets.md`, and the
    generated `providers.mdx`.

### Hard invariants

Violating any of these means rework.

- Dependencies point downward only. A layer may not import from a layer
  above it. A lint rule or test fails on an upward import.
- A strategy never names a concrete model. A role with a pinned binding
  never calls the router. Routing is callable with no agent.
- Extend, do not replace. Strategies compile to the existing graph, the
  verifier panel's current behaviour is the default implementation,
  budgets flow through the existing module.
- Nothing vendor-specific outside provider profiles and adapter
  `providerConfig`. The protocol vocabulary is closed and extending it is
  a code change.
- Every routing and budget decision records its reason and, where
  relevant, the projection behind it. Never report a cost we cannot know:
  mark it opaque.
- Test at the seam a change crosses. Any change to a request or response
  shape needs a test at the boundary that shape actually crosses (a
  controller through ValidationPipe, or a client-to-server end-to-end
  test). A unit test calling a service directly does not count.
- No em-dashes in user-facing copy or documentation.

### Production grade

The bar for every PR in this stack:

- **Proven at the seam it crosses.** Five bugs shipped green this week for
  exactly this reason.
- **Every fix reverted once** to watch its new test go red, then restored.
  Guards proven, not asserted.
- **Demonstrated against a running stack** with evidence in the PR, not a
  green suite alone.
- **No adapter or provider claims verification without a dated live run.**
  Fixture-green is stated as fixture-green everywhere, including in the
  documentation.
- **Errors reach the user with their reason.** No "Request failed with
  status code 400".
- **Every new surface**: real empty state, keyboard paths, loading and
  error states, existing design system only, no new primitives.
- **Migrations reversible and tested both directions.** No destructive
  migration without a shim period.
- **Secrets never** in logs, audit events, actual-state records or error
  bodies.
- **Documentation updated in the same PR**, with a Status header and dated
  Verified sections for provider claims.
- **Concurrency, rate limits and timeouts stated per external call.** No
  unbounded retries. No unbounded agent fan-out.

### Delegation

Every delegated brief states a **maximum number of sub-agents and a
stopping condition**, or it does not get delegated. This rule exists
because two agents became seventeen on a broad brief with no cap.

### Definition of done

All seven gates demonstrated against a **running stack**, not unit tests
alone, with evidence in the PR. Lint and full suites green, both
typechecks clean, documentation committed, PR into development linking
this document. Progress and blockers posted to `#almyty`.

If a provider API has drifted from this document's assumptions, verify
against current documentation and record the delta here rather than
improvising silently.

---

## Open questions

Three, recorded rather than silently decided, because the answers change a
schema and the vocabulary is declared closed.

**1. Is `dashscope_native` in the registry?** The worked example above
gives `qwen { dashscope_native (preferred), chat_completions }`, but
`dashscope_native` is not one of the eight protocols listed. Either the
registry has nine entries or the example should say `chat_completions`
only. This matters precisely because the vocabulary is closed: a ninth
entry is a code change and an implementation, not a row. The same question
applies to any other vendor-native shape we might want to prefer.

**2. What is the preferred protocol when a vendor speaks several and the
capabilities differ?** "Native first" answers it for a single call. It
does not answer what a router should do when the native path lacks a
capability the requirement asks for and the compat path has it, or the
reverse. The current answer is that L3 filters on `(model, protocol)`
pairs, which means a requirement can select a compat path over a native
one. That is correct, but it means "native first" is a tie-break rather
than a rule, and the documentation should say so plainly.

**3. Where does an inbound protocol's model id resolve?** A client calling
us with `anthropic_messages` names a model in Anthropic's namespace. That
name has to map onto a catalog entry that might be served by a different
vendor entirely. That mapping is L2's, but it is not specified above, and
it is the difference between "point Claude Code at almyty" working and
returning a confusing not-found.

None of the three blocks starting L1, which is why they are recorded here
rather than held as a gate.

## Non-goals

- Training models ourselves beyond the documented verifier recipe.
- A learned model-level router. L3 stays deterministic.
- Orchestrators above orchestrators.
- Reproducing any vendor's benchmark number.
- Extending the protocol vocabulary without a code change.
