# Code mode and tool discovery

Status: accepted (all 15 recommendations in "Decisions for Frane"). Being built phase
by phase. Done: part A, the stored side-effect class (#915); part B, search_tools and get_tool
with embeddings (#917); part E for autonomous agents, `toolMode` and the benchmark harness
(#920); P2, code mode for autonomous agents: the `code` sandbox profile, the broker, write
policy, change sets, grants, `extract`, traces and sandbox CPU in usage (#924). P3 (#925): gateway exposure on MCP, UTCP and Skills behind `CODE_MODE_GATEWAYS`
(default off; scripts from outside clients run in QuickJS in a worker of their own, decided at the P3 gate below, `feat/code-mode-quickjs`), held change sets for
callers that cannot pause, the workflow Code step, the UTCP aliases, and code mode in the
benchmark harness; the full benchmark run is still to come. Recon taken on `development` at
`b0281c1a` (after #886, #889, #892).

## In plain words

Today, when an agent (or a coding assistant connected to an almyty
gateway) can use tools, it is handed the full description of every tool
up front, and it uses them one call at a time: ask, wait, read the whole
answer, ask again. With five tools that is fine. With three imported APIs
and two hundred tools, most of the agent's attention goes on reading
descriptions it will never use, and a job that needs fifty small steps
takes fifty round trips.

This design changes two things:

- **The agent looks tools up instead of being handed all of them.** It
  gets a search box and a "tell me more about this one" button, the way a
  person uses a catalogue instead of reading it cover to cover.
- **The agent can write a short script, and almyty runs it.** Instead of
  fifty separate requests, it writes one small program ("find every sold
  pet, keep the ones older than 30 days, archive each one"), almyty runs
  it in a locked box, and only the final answer goes back to the agent.

Nothing about safety is relaxed. Every call the script makes still goes
through the same checks, credentials and audit log as if the agent had
made it directly, and anything that changes or deletes data can be held
for a person.

Everyday example: you ask your assistant to "archive every pet we sold
more than a month ago". You get **one** approval screen listing the 37
archives it wants to make, you click Approve once, and the audit log shows
all 37 changes under that one request. Before, you would get either 37
separate approval prompts or none at all.

## Goals

1. A client or agent working against a large tool set sees a small,
   stable set of meta-tools and finds the rest on demand.
2. An agent can express a multi-call job as one script that runs
   server-side, against typed functions generated from the imported API.
3. Every call a script makes is a normal tool call: same principal,
   gateway scope, security policy, plugins, amount rules, credentials,
   egress gate, `tool_executions` row and audit entry as a direct call.
4. Writes and deletes made from a script can be staged into one change
   set that a person approves or rejects as a whole.
5. The benefit is measured on a fixed benchmark before anyone claims it.

## Non-goals

- A general-purpose compute service. `run_code` exists to orchestrate
  tool calls; it has no network, filesystem, packages or credentials.
- Replacing JavaScript tools. Human-written JS tools keep their own
  sandbox profile (network through the guard, credentials, dependencies).
- The MCP 2026-07-28 protocol surface (annotations, `outputSchema`,
  `structuredContent`, tasks, `input_required`). That is the MCP
  compliance design, a separate document in progress. This doc supplies
  the data those fields carry and consumes the result; it does not specify
  the wire format again.
- Rollback of committed writes. A rejected change set means the staged
  calls never ran; a write that already ran is reported, not undone.
- Client-side sandboxes. The point is that the client does not need one.

## What changed since the spec's recon

The spec's recon was taken on `development` at `4aac2c5`. This week's
merges moved several of its statements.

| Spec says | Now (`b0281c1a`) | Consequence for this design |
|---|---|---|
| "Approvals are agent-initiated only. There is no per-tool gate." | #886 added one. `tools/tool-approval-gate.service.ts` checks every `executeTool` against approval policies' **amount rules** (`approval_policies.trigger`, kind `tool_amount`; core, while multi-step sign-off is EE `approval_policy`). A caller that can pause (the autonomous runtime, `holdForApproval: 'caller'`) puts its run in `WAITING_APPROVAL` with `workingMemory.gatedToolCalls` and replays them in `runApprovedCalls`. A caller that cannot wait gets a **held call**: an `approval_requests` row with `toolId` and a params `fingerprint`, run once on approval (`runHeld`), its result kept on the row and collected with `_approvalId`. | Staging (D) extends this rather than adding a mechanism: a staged call is a gated call whose reason is its side-effect class instead of an amount. Missing: a **change set** (N calls under one request) and side-effect triggers. |
| node-sandbox runs "without network" | The image is Node 26 (`engines >=26`). The worker starts with `--permission` **and** `--allow-net` (Node 26's net permission is all-or-nothing), and `sandbox-net-guard.ts` refuses private and metadata destinations in-process. JS tools also receive a `credentials` argument and an allowlisted `require` with installed dependencies. | The current profile has network and credentials on purpose. Code mode needs its own profile: no `--allow-net`, the guard in deny-all mode, no credentials, no dependencies. |
| Protocol tools (#889) | Hand-made GraphQL, SOAP and gRPC tools are stored as protocol config (`protocol-tool-config.ts`), never as generated JS, and every outbound executor (HTTP, GraphQL, SOAP, gRPC) decides egress in one place, `executors/tool-egress.ts` (org egress allowlist plus DNS pinning). | The broker needs no network of its own: brokered calls leave through the executors, so through L1. `graphqlConfig` gives a query/mutation signal for classification. |
| Tool gateways "MCP / UTCP / TOOLS" | There is no `TOOLS` gateway type. The tool-kind types are `mcp`, `utcp` and `skills` (`entities/gateway.entity.ts`). | Exposure (E) applies to MCP and UTCP; for Skills it means generating a skill that documents the code API. |
| Workflow node types (CLAUDE.md says 12) | The dispatch switch in `agent-node-executor.ts` has 13 (`decision` was added). | A Code node would be the 14th. |
| `ToolInvocationBudget` caps nested calls | Unchanged: depth 3, 25 total, 4 in flight per root execution, env-tunable. | `run_code` gets its own, larger budget (Decision 10). |

Statements that are still accurate, re-verified on `b0281c1a`:

- The MCP server negotiates at most `2025-03-26` (`mcp/mcp.service.ts`).
  `tools/list` emits `name`, `description` and `inputSchema` only;
  `tools/call` returns one text block plus `isError`
  (`mcp/services/mcp-tool.handler.ts`). No annotations anywhere.
- `mcp-sources` keeps a remote tool's `name`, `description` and
  `inputSchema` (`mcp-client.service.ts`, `mcp-sources.service.ts`), nothing
  else.
- The UTCP manual already emits `outputs: tool.outputSchema`
  (`mcp/utcp.service.ts`).
- Discovery is custom JSON-RPC (`tools/discover|search|get`), advertised
  under `capabilities.experimental.almyty`. `tools/search` is a
  case-insensitive substring match on name and description; there are no
  embeddings in it.
- `CodegenService` renders `Params` interfaces from `inputSchema`; every
  generated function returns `Promise<any>`.
- Autonomous agents put every tool's schema in the request
  (`AgentRuntimeBuilders.buildToolDefinitions`), with no deferral.
- `ToolExecution` has `runId` and `gatewayId` but no parent link.

Two facts the spec does not mention shape the design:

- **There is no explicit prompt caching in the dispatch path.** Nothing in
  `llm-providers` sets a cache marker. A stable tools array helps today
  only with vendors that cache prefixes automatically. Explicit cache
  markers are separate work and not required here.
- **The tool integrity hash** (`common/security/tool-integrity.ts`) covers
  name, description, parameters, code and execution method. A side-effect
  class that could change silently would let a tool drop from
  `destructive` to `read` and skip staging, so the class joins the hash.

## How it fits the six layers

The six layers in [layers.md](layers.md) describe the model stack. Tool
execution sits beside it, and code mode stays there. Where it touches the
stack:

- **L1, transport and egress.** The sandbox has no network. Every
  brokered call reaches the outside through the existing executors, which
  decide egress in `tool-egress.ts`. Code mode adds no outbound transport,
  so `outbound-transport-inventory.guard.spec.ts` gains no entry.
- **L3 and L4.** `extract(value, schema)` is a model call. It runs as a
  role (`extractor`): a pinned role never routes, an unpinned one asks the
  router with the organization's policy, and the call is attributed like
  any routed call.
- **L5 and L6.** `toolMode` is not a strategy (it does not compile to
  nodes) and not an orchestrator choice. It is a property of how one model
  call sees its tools. The workflow Code node is an engine change (a new
  node type), so by the L5 rule no strategy may depend on it until it
  exists as a node.
- **Cross-cutting: budgets.** Brokered calls, sandbox CPU time and
  `extract` cost are charged to the run's budget like any other step, and
  a refusal records the projection that caused it.

## Design

### A. Side-effect class on every tool

Each tool carries `sideEffect: read | write | destructive`, `openWorld:
boolean`, and where the value came from.

| Source | Rule |
|---|---|
| Manual override | Wins over everything. Set on the tool page; audited. |
| MCP annotations (a remote tool from `mcp-sources`) | `readOnlyHint: true` → read; `destructiveHint: true` → destructive; otherwise write. `openWorldHint` copied. |
| Generated from OpenAPI | `GET`, `HEAD`, `OPTIONS` → read; `DELETE` → destructive; `POST`, `PUT`, `PATCH` → write. |
| GraphQL (generated, or `graphqlConfig`) | `query` → read; `mutation` → write; `subscription` → read. |
| SOAP, gRPC, SDK, hand-made HTTP with a templated method | No reliable signal: the default (Decision 4). |
| JavaScript tool | The default: it can do whatever its code does. |
| LLM tool | read: it has no outbound path besides the model. |

`openWorld` is true for anything that calls a third party and false for
LLM tools. The class is computed at generation and import time and again
on re-import (an override survives re-import), never at call time. It is
part of the integrity hash.

It is emitted as MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint` where the method says so, `openWorldHint`) by the MCP
compliance work; this doc owns only the mapping above.

### B. Discovery as meta-tools

Three meta-tools, the same on every surface:

- `search_tools({ query, limit? })` returns `[{ name, summary, sideEffect,
  score }]`. Hybrid ranking: keyword match (name, description, operation
  id, tags, API name) and vector similarity from
  `memory/embedding.service.ts`, merged by reciprocal rank. The candidate
  set is narrowed to the caller's scope **before** ranking: on a gateway,
  `servableToolsOnGateway` minus other members' private tools (exactly the
  `tools/list` set); for an agent, the agent's tools after
  `executionAccess.filterExecutable`. A tool outside the scope never
  appears, not even in a count.
- `get_tool({ name, detail? })` with `detail: name | description | full`.
  `full` returns `inputSchema`, `outputSchema` when known, the side-effect
  class, the TypeScript signature as code mode calls it, and one example
  call (the OpenAPI example, else one synthesized from the schema).
- `call_tool({ name, arguments })` returns the tool's result. It lets the
  tools array stay constant while the set of usable tools changes, which
  keeps any provider-side prefix cache intact.

Embeddings are computed on tool create, update and re-import by a BullMQ
job, and stored with the model that produced them (the memory store's
rule: vectors from different models are never compared). An organization
with no embedding-capable provider gets the hash fallback, and the keyword
half carries the ranking; search still works.

The existing JSON-RPC methods `tools/discover|search|get` become aliases
of the new handlers, so nothing that uses them breaks.

**Autonomous agents switch automatically.** At the start of a run the
runtime estimates the token size of the tool definitions it would send.
Above a threshold (Decision 9) the run gets the meta-tools instead of the
full list, plus any tools the agent pins as always visible. The choice is
made once per run and kept, so the tools array does not change between
steps.

### C. Code mode: `run_code`

```
run_code({ code: string, timeoutMs?: number })
  -> { result, logs, calls, staged, error?, committed? }
```

**Language.** TypeScript or JavaScript. Types are stripped on the host
with Node's `module.stripTypeScriptTypes` (no transpile, no type check),
and the body runs as an async function. No `import`, no `require`.

**What the script sees.** One namespace per source, generated by
`CodegenService` with return types from `outputSchema`:

```ts
const sold = await petstore.findPetsByStatus({ status: 'sold' });
const old = sold.filter((p) => daysSince(p.updatedAt) > 30);
await Promise.all(old.map((p) => petstore.updatePet({ ...p, status: 'archived' })));
log(`${old.length} to archive`);
return { archived: old.map((p) => p.id) };
```

- The namespace is the API's slug (or the MCP source's name); the function
  is the tool's operation id in camelCase. Hand-made tools without an API
  live under `custom`. Collisions get a numeric suffix, and `get_tool`
  shows the exact name.
- `tools.search(query)` and `tools.get(name)` behave like the meta-tools;
  `tools.call(name, args)` is the untyped escape hatch.
- `extract(value, schema)` sends `value` and a JSON Schema to the
  `extractor` role and returns an object validated against the schema, or
  throws. It is for sources with no `outputSchema`, whose functions return
  `unknown`.
- `log(...)` appends to the execution's log.

Only `log()` output and the return value go back to the model. Both are
capped (Decision 10) with the marker text of `agents/persist-cap.ts`
(`… (truncated from N characters)`), so the UI and the model read a
truncation the same way.

**The broker.** Every namespace function is a stub that posts an
`invoke-tool` message to the host over the channel `tools.invoke` already
uses. On the host, the broker:

1. Resolves the name **only within the scope listing** the script was
   given (the gateway's servable set or the agent's tools). Anything else
   is "not found", as on `tools/call`.
2. Claims a slot on the code execution's invocation budget (total and in
   flight).
3. Applies the write policy (section D). A staged call stops here.
4. Calls `ToolExecutorService.executeTool` with the outer call's
   principal, `organizationId`, `gatewayId`, `scopes`, `runId`, `agentId`,
   `holdForApproval: 'caller'` and the new `codeExecutionId`. Access
   checks, gateway servability, security policy, input mapping, schema
   validation, sanitization, `PRE_TOOL_EXECUTION` plugins, amount rules,
   cache, rate limits, credentials and egress all happen inside
   `executeTool`, unchanged.
5. Returns `data` to the script, or makes the stub throw a `ToolError` when
   the result is not a success (`isError` on MCP).

`Promise.all` works. Parallelism is bounded by the budget's in-flight
cap, and a call over the cap is refused (the script can catch it), never
queued, exactly as nested calls behave today.

**Errors.** An uncaught error ends the script and comes back as `{ error:
{ message, tool?, line? }, committed: [...], staged: [...] }`. `committed`
is read from this code execution's `tool_executions` rows that were writes
or deletes and succeeded, so the model knows what already happened before
deciding what to do next. A timeout or memory kill is reported the same
way.

**The trace.** One `code_executions` row per `run_code` holds the script
as submitted, logs, return value, status, timing, CPU time and the change
set. Each brokered call is an ordinary `tool_executions` row with
`codeExecutionId` set. The run view shows the script and its call tree
under the step.

### D. Safety: every call is checked; approving a script approves nothing

The broker decides per call, from the tool's class and the policy of the
agent or gateway:

| Class | Options | Default |
|---|---|---|
| read | runs | runs |
| write | allow, stage, deny | allow; stage when the agent or gateway has staging on (Decision 5) |
| destructive | allow, stage, deny | stage |

The policy lives on the agent (`agentConfig.codeMode.writes`) and the
gateway (`configuration.codeMode.writes`), with per-tool exceptions.
Categorical grants narrow it within one run: "allow `tickets.create` in
this run, max 20" lets those calls through without staging until the
count is used up.

**Staging.** A staged call does not run. Its stub returns `{ staged: true,
id }` and the call (tool, arguments, params hash, class) is appended to the
code execution's change set. The script carries on. When it finishes:

- **Autonomous agent:** the run goes to `WAITING_APPROVAL` with one
  approval request whose payload is the change set, one entry per call
  (readable tool name, arguments, class, any amount rule it also trips).
  This reuses the `gatedToolCalls` path: on approval the runtime runs the
  entries in order through `executeTool` with `approvedGate`, records each
  as a `tool_executions` row under the same code execution, and gives the
  model one tool result summarising what ran. On rejection nothing ran,
  and the model is told so.
- **Gateway or MCP client:** the caller cannot wait, so the change set is
  held the way a held call is today (`ToolApprovalGateService.hold`, one
  request for the whole set). The `run_code` result says it is waiting
  and carries the request id; calling again with it returns the outcome.
  A client that supports MCP tasks gets a task instead; that mapping
  belongs to the MCP compliance design.

A staged result is a receipt, not data: it carries nothing from the real
call, so later logic in the same script cannot depend on it. The `run_code`
description says so and tells the model to split work into a reading
script and a writing script when a write's result matters.

**Amount rules.** A call the broker allows still meets the amount gate
inside `executeTool`. With `holdForApproval: 'caller'` the gate answers
`approvalRequired`; the broker turns that into a staged entry, so the
person sees it in the same change set with the rule shown. One decision
covers both. If the rule's policy needs EE multi-step sign-off, the change
set needs those steps.

**Plugins** run on every brokered call, because they run inside
`executeTool`. EE adds cross-source flow rules ("data read from source X
may not be sent to tool Y"), enforced in the broker, which sees every call
and its arguments in order. The first version tracks provenance per code
execution, not per value.

**The sandbox profile.** A new `code` profile on `NodeSandboxService`:

- The worker starts with `--permission` and **without** `--allow-net`; on
  Node 26 the runtime then refuses every socket. The net guard is also
  installed in deny-all mode, so a worker on an older Node refuses too.
- No `credentials` argument, no `require`, no installed dependencies, a
  scrubbed `process.env`, read access only to the worker script.
- Its own pool limits (`SANDBOX_CODE_MAX_WORKERS`, a per-organization
  share, a queue), separate from JS tools, so model-written code cannot
  starve human-written tools or the other way round.
- Timeout and memory caps; CPU time measured and recorded per execution.

Whether this profile stays on Node workers or moves to an interpreter
compiled to WebAssembly or a separate V8 isolate library is Decision 1.
The broker and the stub protocol are the same either way, so the choice
can change after P2 without touching anything above it.

### E. Surfaces

- **Autonomous agents:** `agentConfig.toolMode = direct | discover | code
  | auto`. `direct` is today's behaviour. `discover` sends the meta-tools.
  `code` sends the meta-tools plus `run_code`. `auto` is `direct` under
  the threshold and `discover` (plus `code`, Decision 8) above it.
- **Workflow agents:** an optional Code node on the same runtime, with the
  workflow context as input and the agent's tools as its scope.
- **Tool gateways:** `configuration.exposure = tools | code | both` on MCP
  and UTCP gateways. `code` lists `search_tools`, `get_tool` and
  `run_code` (Decision 3); `both` lists those after the normal tools. On a
  Skills gateway, `code` generates a skill that documents the typed API
  and points at the gateway's `run_code`.
- **UTCP.** In `code` exposure the manual lists the meta-tools with
  gateway call templates. In a `tools` manual a generated tool points at
  the upstream API directly; in `code` exposure nothing does, because the
  script runs here. Naming is checked against UTCP's code-mode library in
  P3 and aliased if it differs.
- **OpenAI-compatible API:** inherits the agent's `toolMode`.

### Caching

- `tools/list` keeps its 60 s per-gateway cache; the `code` listing is a
  constant.
- The generated typings for a scope are cached per scope and version
  stamp (the latest `updatedAt` among the scope's tools and gateway
  tools), and dropped on any change. The broker resolves names at call
  time, so a tool removed after the typings were generated is "not found",
  never a stale success.
- A tool's result cache (`configuration.cache`) applies to brokered calls
  exactly as to direct ones, after the gates.
- Embeddings are kept per tool and model, and recomputed when the embedded
  text (name, description, operation id) changes.

## Data model and migrations

| Change | Kind |
|---|---|
| `tools.sideEffect` (`read`/`write`/`destructive`, not null), `tools.openWorld` (bool), `tools.sideEffectSource` (`override`/`annotation`/`http_method`/`graphql`/`default`) | Migration; backfilled in the migration from the operation's method and the GraphQL operation type |
| `tool_embeddings` (toolId, model, dim, vector, textHash, updatedAt), HNSW index | Migration (pgvector is already enabled by `MemoryCanonicalInit`) |
| `code_executions` (id, organizationId, runId, agentId, gatewayId, userId, code, logs, result, error, status, changeSet, approvalRequestId, cpuMs, durationMs, createdAt) | Migration; same retention class as `tool_executions` |
| `tool_executions.codeExecutionId` (nullable, indexed, FK on delete set null) | Migration |
| `configuration.mcp.outputSchema` and `configuration.mcp.annotations` on MCP-backed tools | JSON, no migration |
| `agentConfig.toolMode`, `agentConfig.codeMode`, gateway `configuration.exposure` and `configuration.codeMode` | JSON, no migration; the DTOs and the frontend types must carry them |
| The change set on an approval | `approval_requests.payload.changeSet`; no column |

## API and MCP surface changes

- MCP and UTCP: the meta-tools on every tool gateway in `code` or `both`
  exposure.
- REST: `POST /tools/search` (hybrid), `GET /tools/:id/signature`,
  `PATCH /tools/:id` accepts a `sideEffect` override, `GET
  /agents/:id/runs/:runId/code-executions/:codeExecutionId` with its call tree (built under
  the run so access follows the agent, as for the run itself), `GET /analytics/script-usage`.
- Codegen: the gateway and tool SDK downloads gain return types.
- Approvals: a change-set view (the calls, their class, any rule hits),
  approved or rejected as a whole.
- Agent and gateway pages: tool mode, exposure and write policy, set
  inline on the page.

## Interaction with the MCP compliance work

The MCP 2026-07-28 compliance design (a separate document, in progress)
owns protocol negotiation up to 2025-06-18 and 2026-07-28, `annotations`,
`outputSchema` and `structuredContent` in `tools/list` and in results,
tasks, and `input_required`. This design depends on it and does not
repeat it:

- **Prerequisite (spec item F).** Code mode needs `outputSchema` to type
  return values, and `mcp-sources` to store a remote tool's `outputSchema`
  and annotations. The storage half (`configuration.mcp.*`) is listed here
  because classification reads it; the wire half is the other document's.
- **Annotations.** This doc defines how `sideEffect` and `openWorld` are
  derived; the other emits them.
- **Waiting for a person.** A staged change set on a gateway is the case
  tasks and `input_required` exist for. The fallback here (a request id,
  call again) works on any protocol version; the task mapping is the other
  document's.

## Phases

**P1: prerequisites, classification, discovery.**
- The MCP compliance prerequisites land (other document); `mcp-sources`
  stores `outputSchema` and annotations.
- `sideEffect` and `openWorld` with migration, backfill, override and the
  integrity hash.
- `search_tools`, `get_tool`, `call_tool`; the embeddings job; the old
  JSON-RPC methods aliased.
- `toolMode = direct | discover | auto` for autonomous agents (`auto`
  choosing between `direct` and `discover`).
- The benchmark harness, with baseline numbers for `direct` against
  `discover`.

Acceptance: every tool has a class and a source; a generated GET is
`read`, a DELETE `destructive`, a GraphQL mutation `write`; `search_tools`
on a gateway never returns a tool `tools/list` would not (guard test); an
agent over the threshold sends the same tools array on every step; the
baseline report exists.

**P2: code mode for autonomous agents.**
- The `code` sandbox profile, the broker, typed namespaces, `extract`,
  `log`.
- Write policy, staging, change sets, categorical grants, the amount-rule
  merge.
- `code_executions`, `codeExecutionId`, and the run view with script and
  call tree.

Acceptance: "Archive every sold pet older than 30 days" on a Petstore
agent runs as one `run_code`, stages N writes, and shows one approval
with N changes. Approve runs the N calls and the audit shows N
`tool_executions` under one `code_executions` row; reject runs none. The
sandbox escape suite passes. A script that throws after two writes reports
both under `committed`.

**P3: surfaces and the benchmark.**
- Gateway exposure `tools | code | both` on MCP and UTCP; the Skills skill.
- The workflow Code node.
- The UTCP code-mode naming check and aliases.
- The full benchmark run; numbers are published only after it.

Acceptance: a Petstore gateway in `code` exposure lists 3 tools in an
off-the-shelf MCP client and completes the archive task end to end; the
benchmark report below exists.

## Test plan

- **Unit.** The classification table (every row, plus an override
  surviving re-import); the threshold arithmetic; namespace and name
  generation including collisions; the broker's decision matrix (class ×
  policy × grant × amount hit); the truncation marker; `committed` built
  from the call log.
- **Sandbox escape suite** for the `code` profile: sockets (net, tls,
  dgram, fetch, http2), DNS, filesystem, `process` and its env,
  `child_process`, workers, `require`, `import()`, `createRequire`,
  `process.mainModule`, the `Function` constructor and prototype tricks,
  timers and promises outliving the return, memory and CPU exhaustion,
  log and return-value floods.
- **Guard tests** (source-reading, so an unwired path fails): every broker
  path ends in `executeTool`; the `code` profile never passes `--allow-net`
  or credentials; `search_tools` and `run_code` resolve against the same
  scope function `tools/list` uses; the side-effect class is in the
  integrity hash.
- **Integration** (`RUN_DB_INTEGRATION=1`): the P2 acceptance scenario
  against a local Petstore; a held change set on a gateway, approved,
  rejected and expired; an amount rule inside a change set; a plugin
  halting one brokered call.
- **End to end:** an MCP client against a `code` gateway; the change-set
  view in Approvals (Playwright).
- **Benchmark, the claimed benefit.** Petstore plus two other imported
  APIs, 50+ tools. A fixed task set (single lookups, multi-step reads,
  bulk writes, tasks no tool can do), each with a deterministic check on
  the end state. Every task runs in `direct`, `discover` and `code` on at
  least three models from different vendors, five times each. Reported per
  mode: input and output tokens (from provider usage, not estimates),
  wall-clock latency, model turns, tool calls, success rate and cost, as
  medians with their spread. No number is published or quoted before this
  run.

## Risks

- **Weaker models write worse code than they make calls.** `auto` falls
  back to `discover` for model families that lose on the benchmark;
  `code` is never forced.
- **Sandbox escape.** The highest-impact risk. Mitigated by a profile
  without network or credentials, the escape suite, a separate pool and
  Decision 1. An escape reaches the backend process, which is why external
  gateways get `run_code` only in P3.
- **Partial commits.** A script can commit some writes and then fail.
  Staging destructive calls by default and the `committed` list reduce
  this; they do not remove it.
- **Staged receipts confuse the model.** Addressed in the tool
  description and measured by the benchmark's bulk-write tasks.
- **Data moving across sources in one script.** Core has write staging;
  real flow control is EE and per execution at first.
- **Missing output types.** Many imports lack response schemas. Those
  functions return `unknown` and lean on `extract`, which costs a model
  call.
- **Typing drift.** A tool can change between typing and execution; the
  broker resolves at call time and answers "not found" or a validation
  error, never running an old shape.
- **Hosted CPU cost.** Server-side sandboxes move client CPU onto the
  platform; CPU time is recorded from the first release.

## P3 as built

- **The switch.** `CODE_MODE_GATEWAYS` (default off) decides whether any
  gateway may serve `code` or `both`. While it is off, saving either is
  refused with a plain sentence, and a gateway that has one serves its
  tools as before. A gateway whose only auth method is "none" also serves
  its tools as before (decision 12); a Skills gateway counts as
  authenticated, because only signed-in members reach it.
- **MCP.** `tools/list` in `code` lists exactly `search_tools`, `get_tool`
  and `run_code`; in `both` it lists the gateway's tools, then those three
  and `call_tool`. The listing cache key carries the exposure. `tools/call`
  answers the meta-tools over `discoveryScope`, the set `tools/list` reads;
  `run_code` runs through `CodeModeService.runOnGateway` with the gateway's
  principal and `gatewayId`, so the executor re-checks every brokered call.
- **Held change sets.** A caller that cannot pause (a gateway client, a
  workflow step) gets its staged changes held as one approval request with
  no run (`payload.kind: 'change_set'`, the caller in `payload._call`). On
  approval the set runs once (the script row is claimed first), in order,
  through the executor with the approval and the caller's gateway; on
  rejection or expiry none of it runs. The client calls `run_code` again
  with only `{ approvalId }` and gets the outcome; another gateway asking
  with that id gets "not found".
- **UTCP.** In `code` and `both` the manual lists the meta-tools with call
  templates at `<gateway>/execute/meta/<name>`, authenticated like the
  gateway. UTCP's code-mode library calls the same tools `tool_info` and
  `call_tool_chain`; both names are accepted there (decision 2). It runs
  scripts on the client, in its own sandbox; here the script runs on the
  server and the client needs none.
- **Skills.** A Skills gateway in `code` is one skill: the typed functions,
  one namespace per API, and how to post a script to
  `POST /gateways/:id/skills/run-code`, which a member runs as themselves.
- **Workflow Code step.** The 14th node type, `code`: a script over the
  agent's tools, with `context.input` (the run's input) and
  `context.steps` (earlier steps' outputs) as a frozen `context` global.
  Its result is what the script returns. Its calls come out of the run's
  tool-call budget. Held changes stop the run in `waiting_approval` (the
  change set's approval carries `payload.workflowExecutionId`); once it is
  decided, `WorkflowApprovalResumeService` settles the set and carries the
  run on from the step, replaying the steps before it from the run's
  record. Approved, the step's output is the script's return value;
  rejected or expired, the step fails with `APPROVAL_REJECTED` and the run
  ends cancelled. The model-facing "call run_code again with the
  approvalId" note is for gateway clients only.

## P3 gate: the sandbox runtime (decision 1)

**Decided (Frane, 2026-10-02):** scripts sent by outside clients through a
gateway run in QuickJS compiled to WebAssembly, in a worker of their own.
Agents and workflows inside almyty keep the Node `code` profile.
`CODE_MODE_GATEWAYS` stays off by default; it is switched on per install.

**In plain words.** A script an outside app sends now runs in a box that
contains nothing but the JavaScript language: no files, no network, no
other software, not even a way to ask the server for anything except the
one door to your tools. Each script gets a fresh box, which is thrown away
when the script ends, so it can never slow the server down or keep memory.
A script that uses too much memory, computes for too long or simply takes
too long is stopped.

**As built** (`tools/node-sandbox/quickjs-sandbox.service.ts`,
`quickjs-sandbox-worker.ts`):

- **Its own pool.** `QuickJsSandboxService` runs each script in a fresh
  worker thread, terminated when the script ends, so the interpreter never
  runs on the server's event loop and all its memory, the WebAssembly
  memory included, is given back. The pool is separate from JavaScript
  tools and from the Node profile (`SANDBOX_QUICKJS_MAX_WORKERS`, default
  4; `_PER_ORG`, half; `_MAX_QUEUE_SIZE`, 50; `_MAX_QUEUE_PER_ORG`, a
  quarter; past a queue limit the script is refused, not queued).
- **The worker.** Started with the permission model, read access to its
  own files and the interpreter's packages only, no network, no child
  processes, no workers, and an empty environment. Its own JavaScript heap
  is capped (64 MB).
- **Inside the interpreter.** No `require`, `import`, `process`, timers,
  network or message port. The prelude builds the script's globals (one
  object per API, `tools`, `extract`, `log`, `console`, `ToolError`, a
  frozen `context`) around a single host function, then deletes that
  function from the global object. Calls use the same broker protocol as
  the Node profile, so the broker, the write policy and staging are the
  same code.
- **Memory.** The WebAssembly memory is created with a hard maximum of
  `CODE_MODE_MEMORY_MB` (default 128) and cannot grow past it; QuickJS's
  own allocator is capped a little under it, so a script gets a clean
  "out of memory" and its worker is terminated.
- **CPU.** The time spent inside the interpreter is summed across every
  entry, and the interrupt handler stops the script past
  `CODE_MODE_CPU_MS` (default 10 s). Time waiting on tool calls does not
  count.
- **Wall time.** The host terminates the worker at the script's timeout
  (`CODE_MODE_TIMEOUT_MS`, at most `CODE_MODE_MAX_TIMEOUT_MS`), whatever
  it is doing.
- Every limit is set for the install by its variable, and an organization
  may lower each one in `settings.codeMode`, never raise it.
- **Tests.** `quickjs-sandbox-profile.spec.ts` runs the escape suite and
  every limit against real workers, in CI with the backend tests.
  Gateway `run_code` (MCP, UTCP, Skills) goes through `runOnGateway`, which
  asks for `runtime: 'quickjs'`; without the QuickJS service it refuses
  rather than falling back to Node (`code-mode-runtime.spec.ts`).

The measurements behind the decision:

**In plain words.** Both boxes kept every escape attempt out. The Node box
runs scripts at full speed, but it is Node with its doors locked, so its
safety rests on every lock holding. The WebAssembly box has no doors at
all: nothing is in it but the language. Its cost is that heavy computation
runs 30 to 50 times slower, which matters little for scripts that mostly
wait on tool calls, and that it still needs its own worker to keep its
memory and its CPU away from the server.

**What was measured.** QuickJS (`quickjs-emscripten` 0.32, MIT, about
1 MB of WebAssembly) against the compiled Node `code` profile, on the same
machine (Apple silicon, Node 26), with the same broker protocol: each tool
function is an async call to the host with JSON in and out, and calls run
4 at a time. The spike code is not in the repository; each number is one
run of 20 to 50 scripts.

| | Node `code` profile (a worker per script) | QuickJS in WebAssembly (in the server process) |
|---|---|---|
| Escape attempts | All of the P2 suite refused (sockets, DNS, files, environment, modules, `process` bindings, the `Function` constructor, timers outliving the script, a forged last message) | 9 of 9 refused (`require`, `process`, `fetch`, `import()`, `WebSocket`, the `Function` constructor, a host function's constructor, timers): none of them exist |
| A trivial script, start to answer | p50 51 ms, p95 61 ms (mostly starting the worker) | p50 0.5 ms, p95 1 ms |
| 100 brokered calls, 4 at a time | p50 75 ms | p50 41 ms |
| A CPU-bound loop (2e7 iterations) | 61 ms | 2,000 to 3,000 ms |
| Memory cap | Killed at 128 MB after about 0.5 s | Refused at 64 MB, but only after about 10 s; the server process kept the WebAssembly memory (2.3 GB resident after the run) |
| Endless loop | Killed at the timeout | Interrupted at the deadline |

**What it means.**

- The interpreter's attack surface is the language and the one host
  function. The Node profile's is Node itself, held by the permission
  model, the module hooks and the removed bindings. An escape from the
  Node profile needs a hole in any of those; an escape from QuickJS needs a
  bug in the interpreter or the WebAssembly runtime.
- In the server's own process QuickJS would block the event loop while a
  script computes, and would not give its memory back. It would run in a
  worker of its own, as the Node profile does, so most of its start-up
  advantage goes (a worker costs about 50 ms either way).
- Scripts orchestrate tool calls, and their own computation is small. The
  slower interpreter is unlikely to matter, but a script that sorts or
  filters large results will feel it.

**Recommendation at the time.** Run scripts from outside clients in QuickJS
inside a dedicated worker, behind the same broker protocol and limits.
Decided as recommended; see the top of this section.

## Decisions for Frane

1. **Sandbox runtime for model-written code.** Options: Node workers with
   a new `code` profile; a JavaScript interpreter compiled to WebAssembly;
   a separate V8 isolate library. **Recommended:** Node workers with the
   `code` profile for P2 (agents, organization-internal callers), and a
   WebAssembly-interpreter spike behind the same broker protocol, decided
   at the P3 gate before gateways expose `run_code` to external clients.
   **Decided at the P3 gate:** QuickJS in a dedicated worker for outside
   clients; the Node `code` profile for agents and workflows.
2. **Meta-tool names.** `search_tools` / `get_tool` / `run_code` (spec part
   2) or the MCP best-practices spelling (spec part 1 says
   `get_tool_details`). **Recommended:** one canonical set matching the MCP
   best-practices page as published, with another spelling as an alias on
   UTCP gateways only if UTCP's code-mode library uses it.
3. **List `call_tool` in `code` exposure?** The acceptance criterion says 3
   tools. **Recommended:** `code` exposure lists exactly `search_tools`,
   `get_tool` and `run_code`; `call_tool` appears in `discover` mode and
   `both` exposure. A single call in code mode is a one-line script.
4. **Default class where there is no signal** (SOAP, gRPC, SDK, JS tools,
   remote MCP tools without annotations, templated HTTP methods).
   **Recommended:** `write`, never `destructive` by guess; a person can
   override per tool.
5. **What turns on staging for writes.** Options: an explicit switch on
   the agent and gateway; implied by any enabled approval policy in the
   organization. **Recommended:** an explicit switch, default off for
   writes (destructive calls are staged regardless); org-wide enforced
   staging is the EE item.
6. **Change-set approval granularity.** All or nothing, or per change.
   **Recommended:** all or nothing in P2, as specced; per-change selection
   later if people ask for it.
7. **A change fails while an approved set runs.** Stop at the first
   failure, or continue. **Recommended:** stop, report what ran and what
   did not, no automatic rollback.
8. **`auto` above the threshold.** `discover` only, or `discover` plus
   `code` as specced. **Recommended:** `discover` only until the P3
   benchmark shows `code` winning on the models in use, then `discover`
   plus `code` per model family.
9. **Threshold.** **Recommended:** 3% of the model card's `contextLength`,
   with a fixed fallback of 4,000 tokens when the card has none,
   overridable per agent.
10. **`run_code` limits.** **Recommended:** its own env-tunable budget: 100
    brokered calls, 4 in flight, scripts calling tools one level deep (a
    JS tool it calls keeps today's nested budget), 30 s default and 120 s
    maximum wall time, 128 MB, and logs and return value capped at 16 KB
    each on the way back to the model.
11. **`extract()` model and availability.** **Recommended:** an `extractor`
    role, pinned if the agent sets it, otherwise routed with the
    organization's policy preferring the cheapest selectable model. On
    gateways only when the gateway names a provider connection; elsewhere
    `extract` throws "not available here".
12. **`code` exposure on gateways without authentication.**
    **Recommended:** not allowed. `code` and `both` require the gateway
    to have at least one auth method configured, because the CPU is the
    platform's and an unauthenticated caller is anonymous.
13. **Where traces live.** A `code_executions` table plus
    `tool_executions.codeExecutionId`, or JSON in
    `tool_executions.metadata`. **Recommended:** the table and the column,
    so the call tree is queryable and retention and audit export work
    unchanged.
14. **Hosted metering of sandbox CPU.** **Recommended:** record CPU ms per
    code execution from P2 and show it in usage; pricing it is a separate
    decision.
15. **Tier placement.** Meta-tools, code mode and staging core;
    cross-source flow rules and org-enforced staging EE (`approval_policy`,
    `compliance_pack`); hosted sandbox CPU counts toward usage.
    **Recommended:** as specced.
