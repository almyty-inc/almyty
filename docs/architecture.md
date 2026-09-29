# almyty — system architecture

How the system is put together: the layers, what lives in each, and the paths a
request takes through them. This is a map, not a tutorial and not a plan. Where
a subsystem has its own design doc, this page says what it is and where it sits
and then points there rather than restating it.

The authoritative answer to any specific number or list is the code. Module
lists and counts here are the kind of thing that drifts, so each one names the
file you can count it in.

## Shape

Two deployables and two stateful services.

```
                    +------------------------------------+
   browser  ------>  |  frontend (React + Vite)          |
                    |  nginx in production                |
                    +------------------------------------+
                                   | JSON over HTTPS
                                   | httpOnly cookie auth
                                   v
  MCP / A2A / UTCP  +------------------------------------+
  Skills / OpenAI   |  backend (NestJS)                  |
  clients  ------>  |                                     |
                    |  controllers -> services -> TypeORM |
                    |  BullMQ producers + processors      |
                    +------------------------------------+
                        |                |            |
                        v                v            v
                  PostgreSQL 16      Redis 7     outbound:
                  (+ pgvector)    (cache+queue)  LLM vendors,
                                                 user APIs,
                                                 runners
```

The backend is the only thing that talks to the database, the queue, LLM
vendors and user-configured APIs. The frontend holds no secrets and no tokens:
it calls the backend with `withCredentials: true` and the browser carries an
httpOnly cookie. Nothing writes a token to `localStorage` — the Zustand persist
`partialize` config deliberately omits the token field, and
`store/__tests__/auth.logout.test.ts` asserts it is absent from the persisted
payload, because anything in `localStorage` is readable by any script that gets
onto the page.

## Stack, as it is

Read from `backend/package.json`, `frontend/package.json` and the Dockerfiles
rather than from memory; the majors below are what those files pin today.

**Backend** — NestJS 11, TypeScript, TypeORM against PostgreSQL 16 (the
`pgvector/pgvector:pg16` image, because the memory module stores embeddings),
Redis 7 for cache and as the BullMQ backing store. Auth is Passport JWT over an
httpOnly cookie with bcrypt password hashing. Validation is class-validator
through a global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`
both on, so an unknown field in a request body is a 400 rather than something
silently dropped — which is why adding a field to an entity means adding it to
the DTO too. `helmet` and `cookie-parser` are installed globally in
`backend/src/main.ts`, and CORS is explicit. Swagger serves at `/docs` but is **fail-closed**: the route is not mounted at all unless `SWAGGER_ENABLED` is exactly `true`, so a deployment that forgets the variable does not publish its full route and DTO surface to anonymous callers. Health
lives at `/health`, `/health/live` and `/health/ready` via
`@nestjs/terminus`. The container listens on 3000.

**Frontend** — React with Vite, TypeScript, shadcn/ui over Radix primitives
with Tailwind, Zustand for client state and TanStack Query for server state,
TanStack Table for tables, react-hook-form with zod resolvers for forms,
`@xyflow/react` for the agent builder canvas, Recharts for analytics. Dev
server on 3002; production is a static build served by nginx on 8080.

**Infrastructure** — multi-stage Dockerfiles on `node:*-alpine` with an
nginx-alpine stage for the frontend, `docker-compose.yml` for local (postgres,
redis, backend, frontend, nginx), a Kustomize base under `k8s/base`, and
GitHub Actions for CI.

Ports, in one place:

| Service | Host (dev) | Container |
|---|---|---|
| Backend | 4000 | 3000 |
| Frontend | 3002 | 8080 (nginx) |
| PostgreSQL | 5432 | 5432 |
| Redis | 6379 | 6379 |

## The domain, in one line

almyty turns **APIs into tools**, composes tools into **agents** that are not
tied to one model, and serves those agents out over **protocols and chat
channels**. The last link is the one that matters: an agent is reachable from
an MCP client, a coding harness, a Slack thread and an HTTP call without being
rebuilt for each.

That yields the four nouns everything else hangs off:

- **API** — an imported schema (OpenAPI, GraphQL, SOAP, Protobuf, SDK). Parsing
  lives in `modules/schema-parser`, one parser per format.
- **Tool** — one callable operation. Generated from an API operation, or
  authored directly as HTTP, JavaScript, GraphQL, LLM-backed or SDK. Execution
  and the sandbox are in `modules/tools`; JavaScript tools run in a
  `worker_threads` sandbox, not in the request process.
- **Agent** — a graph of nodes, or an autonomous loop. `modules/agents`.
- **Gateway** — a published surface. `modules/gateways`.

## Backend module map

`backend/src/modules/` is the unit of organization; `backend/src/entities/`
holds the TypeORM entities (count them there — it is well past what any doc has
claimed). Grouped by what they are for:

**Identity and tenancy** — `auth` (JWT, registration, login, OAuth), `users`,
`organizations` (multi-tenancy and RBAC), `approvals`, `audit-log`,
`licensing`, `kms`, `referrals`, `onboarding`.

**Building blocks** — `apis`, `schema-parser`, `json-schema-translator`,
`tools`, `tool-hub` (catalog and discovery), `files`, `versions` (universal
entity versioning), `promoted-skills`.

**Agents** — `agents` (CRUD, the DAG execution engine, the autonomous step
processor, scheduler, webhooks, and the OpenAI- and Anthropic-compatible
endpoints), `agent-constraints`, `memory` (agent memory and embeddings),
`agent-apps` (the `/apps` factory: products, builds, signing, distributions).

**Serving** — `gateways` (CRUD, auth enforcement, protocol serving, the unified
endpoint, and the chat channel adapters), `mcp` (MCP and UTCP controllers, the
MCP OAuth 2.1 server, transports), `a2a`, `acp`, `mcp-sources`.

**Models** — `llm-providers` (per-vendor dispatch), `model-catalog` (model
cards, the router, the automatic price feed), `model-registry` (weights and
manifests), `model-deployments` (provider adapters, reconcile loop, budgets).

**Execution elsewhere** — `runner` (registration, state machine, dispatch
resolution, capability publication), `workspace` (workspace lifecycle and the
TTL sweep).

**Operations** — `jobs` (BullMQ queues and processors), `monitoring`,
`notifications`, `mail`, `health`, `plugins`, `budgets`, `provider-usage`,
`retention`, `lifecycle`, `credentials`, `connections`.

### Two rules about where things live

Both of these get guessed wrong:

- The **chat channel adapters are in `gateways/channels/adapters/`**, not in an
  `interfaces` module. There is no `interfaces` module.
- Every third-party secret lives in **`credentials`**, and only there. No module
  adds a secret column of its own; a test ratchets that. See
  `docs/connections.md`.

## Frontend structure

`frontend/src/`:

- `pages/` — thin shells. A page wires routing and data and delegates the
  rendering to components; the substantial screens (agent builder, agent
  detail, analytics) are assembled from extracted pieces rather than written
  inline.
- `components/ui/` — the shadcn primitives plus the shared states every list
  screen needs: skeleton, empty-state, query-error, data-table.
- `components/<domain>/` — per-domain components: `agents/` (with `nodes/`,
  `builder/`, `detail/`), `apis/`, `gateways/`, `tools/`, `analytics/`,
  `settings/`, `llm-providers/`, and `layout/` for the dashboard and auth
  shells.
- `lib/` — the axios client (`withCredentials` on every call) and helpers.
- `store/` — Zustand stores: auth, organization, app.
- `types/` — shared types, including the enums mirrored from backend entities.

The sidebar order in `components/layout/dashboard-layout.tsx` follows the pipeline narrative and then configuration, with a divider between: Dashboard → APIs → Tools → Gateways → Agents → Apps → Runners → Workspaces → Connections → Approvals, then Models → Memory → Analytics → Settings. Apps sits directly after Agents deliberately — shipping an agent as a product is the last link of the chain, so it stays above the fold.

## Request paths

Five paths cover almost everything.

### 1. A dashboard call

Browser → nginx → backend controller → `JwtAuthGuard` reads the httpOnly
cookie → `RolesGuard` checks the role on the current organization →
`ValidationPipe` (whitelisting) → service → TypeORM. Anything sensitive also
writes an `audit-log` entry.

In dev the frontend runs on Vite with a proxy, and **the proxy needs a rule per
backend controller prefix**. A new top-level prefix that works in production
and 404s locally is almost always a missing proxy rule, not a routing bug.

### 2. A tool call arriving over a protocol

An external client (MCP, A2A, UTCP, Skills, or the OpenAI-compatible surface)
hits the unified endpoint — `unified-endpoint.controller.ts`, which catches
`/:orgSlug/:resourceSlug` and everything beneath it, plus
`/.well-known/agent-card.json`. It resolves the org and the gateway from the
slugs, enforces the gateway's own auth, and delegates to the protocol handler
for that gateway type. The handler resolves the named tool, and
`modules/tools` executes it: an API or HTTP tool makes the outbound call with
credentials resolved through a grant, a JavaScript tool runs in the worker
sandbox, an LLM tool goes back out through the provider layer.

One endpoint, every protocol: the gateway type decides the dialect, not the URL
shape.

### 3. An agent run

`modules/agents` compiles the agent into a graph and walks it.
`agent-execution.engine.ts` drives the run and `agent-node-executor.ts`
dispatches each node by type — its `switch` is the definitive list of node
types, so count it there rather than trusting a number in a doc. Nodes cover
input and output, LLM calls, tool calls, control flow (condition, transform,
loop, parallel, merge), composition (sub-agent) and the compiled-strategy steps
(verify, extract_context).

Every LLM call inside a run goes through the router rather than naming a model
directly, and a routed call stamps `routing` attribution onto the response, the
node result and the audit log — so "which model actually answered" is always
recoverable. Roles, strategies and the per-agent orchestrator sit above this;
see `docs/roles.md`, `docs/strategies.md`, `docs/orchestrator.md` and
`docs/routing.md`.

Long or scheduled runs move to BullMQ: `agent-runtime.processor.ts` executes,
`agent-scheduler.service.ts` triggers, `agent-run-reaper.service.ts` cleans up
runs whose worker died.

### 4. A message from a chat channel

A platform webhook (or, for Discord, a held Gateway websocket) reaches the
channel's adapter in `gateways/channels/adapters/`. The adapter does three
things and nothing else: verify the signature, normalize the inbound payload,
and later format and send the reply. Everything shared — resolving the gateway,
starting or continuing the run, and applying the EU AI Act Art. 50 AI
disclosure — lives once in `channel-gateway.service.ts`, so a new channel
inherits it. Replies are dispatched fire-and-forget from a run-completion
listener. Inventory and per-adapter detail: `docs/interface-adapters-audit.md`.

### 5. Work on someone else's machine

A runner-backed tool resolves to a live runner session and dispatches a worker
envelope over Streamable HTTP; the runner executes locally and streams results
back. The backend never spawns a process itself and the runner never calls an
LLM vendor. `docs/runner.md`.

## Visibility: who may see a resource, and who may run it

Agents, tools, APIs, gateways, runners, LLM providers and credentials carry
one of three tiers (`AccessPolicyService`):

| Tier | Who sees it and who may run it |
|---|---|
| `org` | every active member of the organization |
| `team` | active members of its team, plus org owners and admins |
| `private` | its owner only; org owners and admins included in "nobody else" |

**Seeing and running are one rule.** Lists filter with
`AccessPolicyService.applyListFilter`, and every execution asks
`ExecutionAccessService`, whose user rule *is*
`AccessPolicyService.canAccess(user, resource, 'use')` — so a member can never
run something a list hides from them, and never be refused something it shows.
A refusal is the same 404 a missing resource gets, so it does not confirm that
a team or private resource exists.

**A run carries the scope of whoever started it** (`agent_runs.principal`;
`ExecuteAgentOptions.principal` for a workflow run; `ToolExecutionOptions.principal`
for a tool call). Everything the run does — `tool_call` and `sub_agent` nodes,
an autonomous run's tool calls, `invoke_agent`, the tool ids `create_agent`
hands a temporary agent, collaboration participants, a sandboxed
`tools.invoke` — is authorized against that inherited principal, never against
the child resource or the `userId` stamped on the row. An org agent anyone may
run therefore reaches a team tool only when the person who started it could.
An autonomous run re-checks its principal against its agent on every step, so
a run resumed after input or approval stops if the scope is gone. Who the
principal is, per surface:

| Started by | Principal |
|---|---|
| dashboard session, API key, CLI JWT, `/v1` compat, the org's own (system) MCP endpoint | that user |
| a schedule tick or heartbeat | the agent's owner **at fire time**; an owner who has left the team (or the org) stops it with a FAILED run that says why, and the schedule or heartbeat is paused |
| a published gateway (MCP, A2A, UTCP, Skills, ACP, a chat channel, the Webhook channel, hosted chat) | the gateway |

**The gateway rule.** A gateway is a publication: whoever its own auth admits
gets what it serves, so what it may serve is bounded by the gateway's scope.
An `org` resource: any gateway of the organization. A `team` resource: only a
gateway scoped to that same team, or a gateway private to someone who may run
the resource right now. A `private` resource: only a gateway private to its
owner. It is checked when a resource is put on a gateway (the person doing it
must also be able to run it; an app distribution for a team agent is created
scoped to that team) and again on every call, so a resource moved to another
team, or a private gateway whose owner left the team, stops being served.

**One gate, three executors.** `AgentExecutionEngine.execute`,
`AgentRuntimeService.startRun` and `ToolExecutorService.executeTool` ask
`ExecutionAccessService` before doing any work and refuse to run at all when it
is not wired. `common/authorization/__tests__/execution-access-guard.spec.ts`
reads the source and fails if an executor stops asking, if a call into one
does not name a principal, or if anything else reaches the layer below them.

## Background work

BullMQ on Redis, with the queues registered in `modules/jobs`. The pattern is
consistent: a producer enqueues, a `@Processor` consumes, and the work is
idempotent because a job can be retried. Schema import and tool generation run
here (a large OpenAPI document is not a request-lifetime job), as do the model
price feed and catalog sync, provider health checks, provider usage pulls,
deployment reconciliation, agent runs and schedules, and the retention sweep.

A rule worth stating: **only the reconcile processor mutates a model
deployment's provider.** Anything else reads it.

## Data

TypeORM against PostgreSQL, connected with discrete parameters
(`DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`,
`DATABASE_NAME`, plus `DB_SSL` for managed databases) rather than a single
URL.

**Every schema change ships a migration.** `synchronize` is never used. New
enum-ish columns are TEXT with a CHECK constraint rather than a Postgres ENUM
type, which is what the gateway, agent and runner tables already do, and it is
what keeps adding a value from being a type migration.

`modules/versions` gives any entity marked versioned a full serialized snapshot
on each update — that is what the Change History panel reads. Retention is
per-organization and per data class, swept hourly; `docs/retention.md`.

## Cross-cutting invariants

The things that quietly break if you do not know them:

- **Tokens live in httpOnly cookies only.** Never `localStorage`. Tests
  enforce it.
- **Secrets live in `credentials` only**, reached through grants, and every
  resolve is audited. `docs/connections.md`.
- **Team and private are execution boundaries, not list filters.** A run
  carries the scope of whoever started it and everything it does is
  authorized against that; see "Visibility" above.
- **Model support is registry data, never a list in code.** A card is usable
  only through `Model.isSelectable()` — active, callable, and with at least one
  passed validation run. Pricing comes from a live feed; the table in
  `llm-models.helper.ts` is an offline seed. `docs/models.md`.
- **Deployment adapters never import one another**, and `providerConfig` is
  opaque to everything except its own adapter.
- **No hardcoded model ids.** A blank model resolves against the vendor's live
  list.
- **Validation whitelists.** A field the DTO does not declare is rejected, so
  an entity field with no DTO field is unreachable through the product.

## Where to read next

- `docs/models.md` — catalog, routing, pricing, deployments
- `docs/routing.md` — how a model gets chosen, and the honest limits
- `docs/strategies.md`, `docs/roles.md`, `docs/orchestrator.md` — the execution
  layers above a single call
- `docs/connections.md` — connectors, connections, grants
- `docs/runner.md` — runners and workspaces
- `docs/agent-factory.md` — `/apps`: builds, signing, distributions
- `docs/interface-adapters-audit.md` — the chat channels, adapter by adapter
- `docs/retention.md`, `docs/budgets.md`, `docs/enterprise.md` — operational
  and commercial surfaces
- `docs/design/` — per-subsystem design notes (`models-layer.md`, `connections*.md`, `call-only-vendors.md`, and the adapter notes)
This comprehensive architecture provides a solid foundation for building your LLM tool gateway system with enterprise-grade capabilities, scalability, and maintainability.