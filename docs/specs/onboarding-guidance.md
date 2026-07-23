# Spec: In-app onboarding guidance ("golden path")

Owner: holy-fox (implementation) · green-lynx (spec, copy, analytics verification) · Status: proposed

## Goal

Get a new org from signup to a working agent call with the product itself doing the guiding.
North-star metric: **time to first successful call** (TTFC) through a gateway or agent.
Everything in this spec is additive UI + one read endpoint — no modal tours, no forced flows.

## Principle

Developers ignore tours but follow state. Guidance is always derived from **what actually
exists in the org** (entity counts, call logs), never from "user clicked Next". A user who
does everything via the CLI must see the checklist complete itself in the web UI.

## Activation definition

Two milestones, tracked separately:

- `activated_sample` — first successful call through any gateway/agent, including seeded sample objects.
- `activated_real` — first successful call involving an API/tool the org created itself (non-sample).

## The golden path (checklist steps)

Completion is computed server-side from entity state. Step order is fixed; steps can
complete out of order and the UI just checks them off.

| # | Step key | Complete when | Deep link |
|---|---|---|---|
| 1 | `provider` | ≥1 LLM provider with health != failed | /models → add-provider dialog open |
| 2 | `api` | ≥1 API imported (sample counts, flagged) | /apis → import dialog open |
| 3 | `gateway` | ≥1 gateway with ≥1 tool assigned | /gateways → create flow |
| 4 | `first_call` | ≥1 successful gateway request OR agent run | /agents → Try It focused |
| 5 | `external_client` (optional, shown after 4) | ≥1 gateway request whose client is not the almyty frontend (MCP handshake, OpenAI-compat call, curl) | gateway detail → Channel Setup panel |

## Backend (one endpoint + one seeding action)

### GET `/orgs/:orgId/onboarding`

Returns computed state; cheap aggregate over existing tables (counts + one exists-query on
request logs). Cache 30s per org.

```json
{
  "steps": {
    "provider": true, "api": true, "gateway": false,
    "first_call": false, "external_client": false
  },
  "sampleWorkspace": false,
  "dismissed": false,
  "activatedSampleAt": null,
  "activatedRealAt": null
}
```

`PATCH /orgs/:orgId/onboarding { "dismissed": true }` — per-user, persisted (user settings,
not org-wide: a teammate joining later gets their own card).

### POST `/orgs/:orgId/sample-workspace`

Idempotent. Seeds the Petstore example: API + generated tools + one MCP gateway (tools
assigned, key created) + one demo agent wired to the org's first healthy provider (skip
agent if no provider). All created entities get `sample: true` and a single
"Delete sample workspace" action removes them. Returns the created ids.
This is the productized version of what we already do by hand on staging.

## Frontend surfaces

### A. Dashboard "Getting started" card

- Rendered at the top of Dashboard while `!dismissed && !activated_real`.
- Progress ring (n/4), step rows with check/current/todo states, each row = one sentence + one CTA button (deep links above).
- Current step is visually primary; completed rows collapse to a single line.
- Secondary action on the card: **Load sample workspace** (hidden once `sampleWorkspace`).
- Dismiss (×) → PATCH dismissed; a small "Setup n/4" pill remains in the sidebar footer until activation, click restores the card.
- Poll the endpoint on dashboard mount + after any create action; no websockets needed.

### B. Empty states (the real onboarding surface)

Every module list page, when empty, uses one shared `GuidedEmptyState` component:
icon, one "why this exists" sentence, primary CTA, and (where applicable) a
"use the sample" secondary. Exact copy in the table below — implementor should not
write copy, green-lynx owns these strings.

| Page | Body copy | Primary CTA | Secondary |
|---|---|---|---|
| /models | Connect an LLM provider to power agents and tool generation. Keys stay encrypted at rest. | Add provider | — |
| /apis | Import an OpenAPI, GraphQL, SOAP, or Protobuf schema — every operation becomes a typed tool. | Import API | Load the Petstore sample |
| /tools | Tools are generated from your APIs. Import an API and its operations appear here. | Import API | Load the Petstore sample |
| /gateways | A gateway serves a set of tools over MCP, A2A, UTCP, and Agent Skills — one endpoint, every protocol. | Create gateway | — |
| /agents | Agents call models and tools to do a job — with cross-vendor verification if you want a second opinion. | Create agent | Load the Petstore sample |
| /runners | A runner connects one of your machines and publishes its capabilities as tools. Code and credentials stay local. | Set up runner (docs) | — |
| /memory | Memory gives agents recall across runs — per-agent or shared, with bi-temporal history. | Docs: memory | — |

### C. The payoff moment

After step 3 completes (first gateway with tools), the gateway detail page already shows
Channel Setup / integration snippets — extend it with a one-time highlight of the
`claude mcp add <name> -- npx -y @almyty/mcp-server <org>/<gateway>` snippet and the copy:
"Point any MCP client at this and your tools are live. This is the moment almyty exists for."
When `external_client` flips true, the card celebrates once (subtle, no confetti physics —
a check + "An external client called your gateway.") and the checklist is done.

### D. Out of scope (v2, do not build now)

Post-activation "recipes" (verify panels, memory, constraints, channels walkthroughs),
CLI `almyty init` parity, in-app changelog.

## Analytics (PostHog, existing shared project)

Frontend fires on **observed state transitions** (a step rendered incomplete last poll,
complete now), so CLI-driven completions are still captured on next dashboard visit:

- `onboarding_step_completed` `{ step, via: "ui" | "observed" }`
- `onboarding_dismissed` `{ steps_done }`
- `sample_workspace_loaded`
- `activation` `{ kind: "sample" | "real" }`

Distinct id is already the logged-in user (`identify()` shipped); org id as group/property.
No new PostHog config needed. green-lynx builds the funnel dashboard
(site visit → signup → each step → activation) once events flow on staging.

## Acceptance criteria

1. New org, empty: dashboard shows the card at step 1; every empty state shows its guided copy.
2. Completing steps via **CLI only**, then visiting the dashboard: steps show complete, `via: "observed"` events fire.
3. Sample workspace: one click seeds it, checklist advances to step 4, single delete removes all sample entities and (if nothing real exists) the checklist regresses accordingly.
4. Dismiss persists per user across sessions; sidebar pill restores.
5. `external_client` completes from a real `claude mcp add` handshake against staging.
6. No regression on populated orgs: card absent for any org with `activated_real`.
7. Events visible in PostHog staging-tagged within one dashboard visit of each transition.

## Non-goals

No modal/overlay tours. No blocking wizards. No email drips (separate project). No
entitlement gating — this ships to every tier including self-host.
