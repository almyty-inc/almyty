# Plan: BYOK UX, Cost Governance, and Open-Core Split

Status: in progress (P1 started) · Owner: TBD · Last updated: 2026-07-01

**License CONFIRMED (2026-07-01): Apache-2.0 for the OSS core + a commercial license for `ee/`.** (Not AGPL — frictionless enterprise self-host is the priority.)

This plan turns three strategic gaps into sequenced, buildable workstreams:

1. **Simpler BYOK** — make bringing your own provider keys frictionless.
2. **Cost governance** — the "payments" that matters for a BYOK platform: metering, budgets, caps, alerts on the user's *own* spend.
3. **Open-core split** — carve a clean OSS/EE boundary so almyty can be open-sourced without giving away what enterprises pay for, and stand up hosted subscription billing for the commercial tier.

Guiding principle throughout: **never gate a core primitive.** Agents, tools, all tool types, gateways, every protocol (MCP/A2A/UTCP/Skills), BYOK, single-org RBAC, memory, and the runner stay fully open. That surface *is* the product and the adoption funnel; crippling it destroys trust and growth. EE gates only what enterprises need and individuals never miss.

---

## Current-state grounding (what already exists)

- **BYOK**: `modules/credentials` + `modules/llm-providers`. Provider config is shape-validated on save (`llm-chat-runner.helper.ts:validateProviderConfiguration`), but there is **no live test-connection** (no real API ping) and **no key-acquisition URLs** in the catalog (`llm-provider-catalog.ts` exposes only display name / description / features per provider type).
- **Metering**: `entities/usage-metric.entity.ts` (`usage_metrics`) records typed metrics (value `decimal(15,4)`, unit, joins to org/user/gateway/tool/llmProvider, timestamp). `monitoring` module aggregates. Each `AgentRun` carries `totalCost`.
- **Per-run cost cap already works**: `agent-runtime.service.ts` `startRun` accepts `maxCostCents` (default 100 = $1) and stops a run that exceeds it. What's missing is **rollup budgets across runs** (per agent / per org / per period).
- **Reusable cap pattern**: the memory module already implements soft/hard caps with configurable behavior — `canonical-memory-config.entity.ts` (`softcapBehavior`: `reject` | `warn_log` | `silent`, plus per-scope hard/soft caps) and an append-only `memory_softcap_warnings` log. **Spend governance should mirror this pattern, not invent a new one.**
- **Tenancy / entitlement stub**: `entities/organization.entity.ts` already has `plan` (default `'free'`; comment says free/pro/enterprise), `planExpiresAt`, and `billingInfo` (json). **Nothing reads or enforces them today** — `plan` is a mutable free-text string, so it is not a security boundary.
- **Auth**: local password + JWT + API-key strategies only (`modules/auth/strategies`). No SSO/SAML/OIDC/SCIM.

---

## Workstream 1 — Simpler BYOK (OSS, ships first)

**Goal:** a first-time user goes provider → link out to get a key → paste → validated → live, in under a minute.

### 1.1 Provider key-acquisition links
- Extend `llm-provider-catalog.ts` with `getProviderKeyUrl(type)` and optional `getProviderDocsUrl(type)`. Static, per provider type:
  - OpenAI `https://platform.openai.com/api-keys` · Anthropic `https://console.anthropic.com/settings/keys` · Gemini `https://aistudio.google.com/apikey` · Groq, Mistral, Together, Perplexity, DeepSeek, Cohere, Azure/Bedrock/Vertex (console deep-links) · Ollama (local, no key — show setup note instead).
- Surface inline in the add/edit-provider dialog (`frontend/src/components/llm-providers/`): a "Get your API key ↗" link + one-line "where this lives."
- **Effort:** ~0.5 day. **Risk:** none. **Test:** unit test that every `LlmProviderType` returns either a key URL or an explicit "no key required" marker (fails CI when a new provider is added without one).

### 1.2 Live test-connection / key health
- Add `POST /llm-providers/:id/test` (and a pre-save variant taking raw config) that does a minimal real call per provider (e.g. list-models or a 1-token completion) and returns `{ ok, latencyMs, error? }`.
- UI: "Test connection" button on the dialog; validate before storing; show green/red.
- Persist last-checked status on the provider entity (`lastCheckedAt`, `lastCheckStatus`) so the providers list can badge stale/invalid keys instead of failing mid-run. Optional periodic re-check via existing BullMQ jobs.
- **Effort:** ~2–3 days (per-provider probe adapters). **Test:** mocked probe per provider family; invalid-key path returns structured error, not a 500.

### 1.3 Onboarding wizard
- First-run empty state on Models page → guided: pick provider → link out → paste → test → done, then "create your first agent."
- **Effort:** ~2 days. Pure UX; no backend beyond 1.1/1.2.

**Definition of done:** new user can add + validate a key with a working "get key" link, and the providers list shows key health. All OSS.

---

## Workstream 2 — Cost governance (OSS "payments")

**Goal:** every operator can see and cap spend of their own keys. Mirror the memory soft/hard-cap pattern.

### 2.1 Spend aggregation & visibility
- Roll `usage_metrics` + `AgentRun.totalCost` into queryable spend: by org, agent, provider, period (day/week/month). Most data exists; add aggregation queries + a `monitoring`/analytics endpoint and a Cost tab UI.
- **Effort:** ~2–3 days (largely read-side over existing data).

### 2.2 Budgets & caps (the enforcement layer)
- New `SpendBudget` entity + migration, scoped to org and optionally agent/provider: `periodType` (day/month), `limitCents`, `behavior` (`warn_log` | `reject` — reuse the memory `SoftCapBehavior` semantics), soft-threshold %.
- Enforcement hook in the run/LLM path: before a run (and between steps), compare period-to-date spend to budget. `warn_log` → append a warning + emit alert but continue; `reject` → block new runs with a clear error. Reuse the existing per-run `maxCostCents` machinery for the in-run stop; the budget adds the *cross-run* ceiling.
- Append-only `spend_alerts` (mirror `memory_softcap_warnings`) for audit + UI.
- **Effort:** ~4–5 days. **Test:** budget exceeded → run rejected with typed error; soft threshold → warning row + alert, run proceeds; no budget → unchanged behavior.

### 2.3 Alerts
- Wire threshold breaches to the `mail` module + in-app notifications (80% soft warn, 100% hard). Optional webhook/Slack via existing interface adapters.
- **Effort:** ~1–2 days.

**Definition of done:** operator sets a monthly org budget, sees spend accrue, gets an 80% email, and runs are blocked at 100% (or warned, per behavior). Entirely OSS — this is cost *visibility/control of the user's own keys*, not charging them.

---

## Workstream 3 — Open-core split + hosted billing (EE)

**Goal:** a clean, enforceable OSS/EE boundary and, for the hosted tier, real subscription billing. This is prerequisite work before any public open-sourcing.

### 3.1 Entitlement enforcement (must land before open-sourcing)
- **Problem:** `plan` is a mutable string; gating EE behind it is trivially bypassed once the code is public.
- Introduce a real entitlement check: a signed license token (offline-verifiable, e.g. Ed25519) decoded into a set of `entitlements` (feature flags + limits). A small `LicenseService` exposes `has(feature)` / `limit(key)`. OSS builds default to the community entitlement set.
- Feature-flag helper (backend guard/decorator + frontend gate) reads entitlements, not `plan`.
- **Effort:** ~3–4 days. **Test:** community build denies EE features; a signed EE token unlocks them; tampered token is rejected.

### 3.2 Code/license boundary
- Move EE-only modules into a top-level `ee/` directory (or a separate private package) with a distinct license header. OSS core = **Apache-2.0**; `ee/` = commercial (or BSL 1.1 with a change-date). This is the proven infra open-core pattern (GitLab/Sentry).
- OSS build excludes `ee/`; the EE build composes core + `ee/`. Document the boundary in `docs/architecture.md` and a `LICENSING.md`.
- **Decision needed:** Apache-2.0 vs AGPL for the core. Recommend **Apache-2.0** for frictionless enterprise self-host; choose AGPL only if the copyleft moat against cloud rehosting is a deliberate priority.

### 3.3 EE feature set (gate these, in priority order)
1. **SSO/SAML/OIDC + SCIM provisioning** — the #1 enterprise paywall and greenfield here. First EE feature to build. New `auth` strategies + provisioning; gated by entitlement.
2. **Advanced RBAC** — custom/fine-grained roles + ABAC. Core keeps owner/admin/member + team LEAD.
3. **Audit retention/export/SIEM streaming** — basic `audit-log` stays OSS; long retention, export, and Splunk/Datadog streaming are EE.
4. **Compliance pack** — org-wide *enforced* pii-filter / security-scanner / guardrail policy + reporting (the plugins stay OSS as building blocks; enforced org policy is EE).
5. **Cost allocation / chargeback / forecasting** — basic spend (WS2) is OSS; per-team chargeback/showback + forecasting are EE.
6. **BYO-KMS + data residency** — customer-managed `ENCRYPTION_KEY` material and region pinning.
7. **Approval policy engine** — multi-step/conditional/quorum workflows (single-gate approvals stay OSS).

### 3.4 Hosted subscription billing (only for the commercial cloud)
- Stripe integration: checkout, customer/subscription objects, webhooks → set `plan` + issue the entitlement token; seat management; dunning/`planExpiresAt` handling. `billingInfo` already exists to hang this on.
- **Scope note:** this is distinct from WS2. WS2 governs the user's LLM spend on their own keys (OSS). This charges customers for the hosted almyty subscription (EE/commercial). Build last, and only if the hosted tier ships.
- **Effort:** ~1–2 weeks including webhook reconciliation + tests.

---

## Sequencing

| Phase | Scope | Rough effort | Gates open-sourcing? |
|------|-------|--------------|----------------------|
| **P1** | WS1 BYOK links + validation + onboarding | ~1 week | No — ship anytime |
| **P2** | WS2 spend visibility + budgets/caps + alerts | ~1.5 weeks | No |
| **P3** | WS3.1 entitlements + WS3.2 license boundary | ~1 week | **Yes — must precede public OSS** |
| **P4** | WS3.3 #1 SSO/SAML (first EE feature) | ~1.5 weeks | No |
| **P5** | Remaining EE features (3.3 #2–7), as demand pulls | ongoing | No |
| **P6** | WS3.4 hosted Stripe billing | ~1.5 weeks | Only if hosted tier |

Rationale: P1/P2 are pure adoption + user value and carry no strategic risk, so they go first. P3 is the **hard prerequisite** for open-sourcing (without real entitlements, EE gating is theater). SSO (P4) is the highest-value first paywall. Hosted billing (P6) is last and conditional.

---

## Risks & open questions

- **Entitlement bypass** — the whole EE model rests on P3 landing *before* the code goes public. Do not open-source with `plan`-string gating.
- ~~**License choice**~~ — **DECIDED (2026-07-01): Apache-2.0 core + commercial `ee/`.**
- **"Payments" ambiguity** — confirm intent: WS2 (govern user's own spend, OSS) vs WS3.4 (charge for hosted subscription, EE). This plan does both, separately.
- **Provider probe cost** — test-connection makes a real (tiny) API call; document it and keep it minimal/free where possible (prefer list-models over completions).
- **Scope creep in EE** — resist gating anything in the core primitive set; every gate should pass the test "would an individual/OSS self-hoster reasonably expect this for free?"

---

## Immediate next actions (if approved)

1. P1.1 provider key-URL map + inline links (smallest, highest-visibility win).
2. Spike the entitlement/license token design (P3.1) in parallel, since it blocks open-sourcing and informs the `ee/` boundary.
3. Decide the license (core + ee) so the boundary work isn't redone.

---

# Task-by-task breakdown

Each task lists: **files/surfaces**, **acceptance/test**, **~effort**, **deps**. IDs are stable references for grpvn/issue tracking. Effort is dev-days for one engineer.

## P1 — Simpler BYOK (OSS)

**T1.1 Provider key-URL map**
- Files: `backend/src/modules/llm-providers/llm-provider-catalog.ts` (+ `getProviderKeyUrl`, `getProviderDocsUrl`, `providerRequiresKey`).
- Accept: every `LlmProviderType` returns a key URL or an explicit "no key required" marker; unit test iterates the enum and fails if any provider is unmapped.
- Effort: 0.5 · Deps: none.

**T1.2 Expose key URLs via API/DTO**
- Files: `llm-providers.controller.ts` catalog endpoint + `frontend/src/types` + `frontend/src/lib/api.ts`.
- Accept: catalog response includes `keyUrl`/`docsUrl`/`requiresKey` per provider; existing catalog test updated.
- Effort: 0.5 · Deps: T1.1.

**T1.3 Inline "Get your API key" link in provider dialog**
- Files: `frontend/src/components/llm-providers/` (add/edit dialog).
- Accept: dialog shows "Get your API key ↗" (external, `rel=noopener`) + one-line location hint; hidden for no-key providers (Ollama shows setup note). Frontend test asserts link renders for OpenAI, hidden for Ollama.
- Effort: 0.5 · Deps: T1.2.

**T1.4 Per-provider live probe adapters**
- Files: new `llm-providers/providers/*-probe` or extend existing provider adapters; a `probe(config): {ok,latencyMs,error?}` per family (list-models preferred over completion to stay free).
- Accept: each provider family has a minimal real call; invalid key → structured typed error (never a 500); mocked unit test per family.
- Effort: 2 · Deps: none (parallel to T1.1–1.3).

**T1.5 Test-connection endpoints**
- Files: `llm-providers.controller.ts` — `POST /llm-providers/:id/test` + pre-save `POST /llm-providers/test` (raw config, no persist).
- Accept: returns `{ok,latencyMs,error?}`; rate-limited; RBAC-guarded; controller test for ok + invalid-key paths.
- Effort: 1 · Deps: T1.4.

**T1.6 Persist key health + badge**
- Files: `entities/llm-provider.entity.ts` (`lastCheckedAt`, `lastCheckStatus`) + migration; providers list UI badge.
- Accept: migration adds nullable columns; save runs a probe and stores status; list badges stale/invalid keys. Migration + service test.
- Effort: 1 · Deps: T1.5.

**T1.7 Optional periodic re-check job**
- Files: `modules/jobs` BullMQ processor.
- Accept: scheduled job re-probes active providers, updates health; disabled by env flag. Processor test.
- Effort: 1 · Deps: T1.6.

**T1.8 First-run onboarding wizard**
- Files: `frontend/src/pages` Models empty state + wizard component.
- Accept: empty state → pick provider → link out → paste → test → "create first agent"; e2e happy-path.
- Effort: 2 · Deps: T1.3, T1.5.

## P2 — Cost governance (OSS)

**T2.1 Spend aggregation queries**
- Files: `modules/monitoring` (+ analytics service) over `usage_metrics` + `AgentRun.totalCost`.
- Accept: aggregate spend by org/agent/provider/period (day/week/month); indexed queries; service test with seeded metrics.
- Effort: 2 · Deps: none.

**T2.2 Cost tab UI**
- Files: `frontend/src/components/analytics` (new Cost tab).
- Accept: spend over time + breakdown by provider/agent; empty state; loads from T2.1 endpoint.
- Effort: 1.5 · Deps: T2.1.

**T2.3 SpendBudget entity + migration**
- Files: new `entities/spend-budget.entity.ts` (scope org + optional agent/provider, `periodType`, `limitCents`, `behavior` reusing memory `SoftCapBehavior` semantics `warn_log|reject`, `softThresholdPct`) + migration.
- Accept: migration + entity registered in `app.module` forFeature; CRUD service + tests.
- Effort: 1.5 · Deps: none.

**T2.4 Budget CRUD API + UI**
- Files: new `budgets` controller/service (or under monitoring) + settings UI.
- Accept: create/list/update/delete budgets, RBAC-guarded (admin/owner); controller tests.
- Effort: 1.5 · Deps: T2.3.

**T2.5 Enforcement hook**
- Files: `agent-runtime.service.ts` run/step path.
- Accept: before a run + between steps, compare period-to-date spend vs budget; `reject` → block new run with typed error (reuse per-run `maxCostCents` stop for in-run); `warn_log` → proceed + record; no budget → unchanged. Runtime tests for reject / warn / no-budget.
- Effort: 2.5 · Deps: T2.3, T2.1.

**T2.6 spend_alerts log + emit**
- Files: new `entities/spend-alert.entity.ts` (mirror `memory_softcap_warnings`) + migration; append on threshold breach.
- Accept: soft (80%) + hard (100%) breaches append rows; queryable for UI. Migration + test.
- Effort: 1 · Deps: T2.5.

**T2.7 Alert delivery**
- Files: `modules/mail` + in-app notifications; optional interface-adapter webhook (Slack).
- Accept: 80% email + in-app; 100% email; dedup per period so it fires once. Test the dedup + send.
- Effort: 1.5 · Deps: T2.6.

## P3 — Entitlements + license boundary (gates open-sourcing)

**T3.1 License token format + verifier**
- Files: new `modules/licensing` — Ed25519-signed token → `{entitlements, limits, expiresAt}`; offline verify; community default when absent.
- Accept: valid token unlocks; tampered/expired rejected; missing → community set. Unit tests for all three.
- Effort: 2 · Deps: none.

**T3.2 Feature-gate helpers**
- Files: backend guard/decorator `@RequiresEntitlement('sso')` + `LicenseService.has()/limit()`; frontend gate component/hook.
- Accept: gated route returns 402/403 without entitlement; frontend hides/locks EE UI. Guard + hook tests.
- Effort: 1.5 · Deps: T3.1.

**T3.3 Migrate `plan` reads to entitlements**
- Files: anywhere reading `organization.plan` for gating (audit first).
- Accept: no EE decision keys off the mutable `plan` string; `plan` becomes display/billing metadata only. Regression test asserting community build denies an EE feature.
- Effort: 1 · Deps: T3.2.

**T3.4 `ee/` boundary + build split**
- Files: new top-level `ee/` dir; build config for OSS (excludes `ee/`) vs EE (core + `ee/`); `LICENSING.md`; update `docs/architecture.md`.
- Accept: OSS build compiles + runs without `ee/`; EE build includes it; CI builds both. Smoke test each build boots.
- Effort: 2 · Deps: T3.2.

**T3.5 License decision (non-code)** — ✅ **DECIDED 2026-07-01: Apache-2.0 core + commercial `ee/`.**
- Remaining: add `LICENSE` (Apache-2.0) at repo root + `ee/LICENSE` (commercial) + per-file headers when the `ee/` boundary lands (T3.4).
- Effort: 0.5 · Deps: none.

## P4 — SSO/SAML (first EE feature)

**T4.1 SAML/OIDC strategies** — `modules/auth/strategies` (EE), gated by `sso` entitlement. Accept: SP-initiated SAML + OIDC login; IdP metadata config per org. Effort: 4 · Deps: T3.2.
**T4.2 SCIM provisioning** — user/group provision + deprovision endpoints (EE). Accept: SCIM 2.0 create/update/deactivate; token-auth. Effort: 3 · Deps: T4.1.
**T4.3 Org SSO settings UI** (EE-gated). Effort: 2 · Deps: T4.1.

## P5 — Remaining EE (demand-pulled)

- **T5.1 Advanced RBAC** — custom roles + ABAC (core keeps owner/admin/member + team LEAD). Effort: 4.
- **T5.2 Audit retention/export/SIEM** — long retention + export + Splunk/Datadog stream (basic `audit-log` stays OSS). Effort: 3.
- **T5.3 Compliance pack** — org-wide enforced pii-filter/security-scanner/guardrail policy + reporting. Effort: 3.
- **T5.4 Chargeback/showback/forecasting** — extends P2 aggregation (EE). Effort: 3.
- **T5.5 BYO-KMS + data residency** — customer-managed `ENCRYPTION_KEY` + region pinning. Effort: 4.
- **T5.6 Approval policy engine** — multi-step/conditional/quorum (single-gate approvals stay OSS). Effort: 4.

## P6 — Hosted subscription billing (EE, only if hosted tier)

**T6.1 Stripe customer/subscription + checkout** — `modules/billing`, hang on `billingInfo`. Effort: 3 · Deps: T3.1.
**T6.2 Webhooks → entitlement issuance** — on subscription change, set `plan` + mint entitlement token; reconcile. Effort: 3 · Deps: T6.1, T3.1.
**T6.3 Seat management + dunning** — seats, `planExpiresAt` handling, grace/lock. Effort: 3 · Deps: T6.2.
**T6.4 Billing UI** — plan, invoices, seats. Effort: 2 · Deps: T6.1.

---

## Rollup

- **P1** ~1 wk · **P2** ~1.5 wk · **P3** ~1 wk (blocks OSS) · **P4** ~1.5 wk · **P5** demand-pulled · **P6** ~1.5 wk (conditional).
- Critical path to open-sourcing: **P3** (+ T3.5 license decision, do first).
- Every task carries a test (project rule: no feature/fix without real tests). Every schema change is a migration (never synchronize).
