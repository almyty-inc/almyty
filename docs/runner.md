# Runner + Workspace architecture

This doc captures the load-bearing decisions behind the runner and workspace subsystem. Code references are grouped by cluster; commits on the original feature branch follow the same cluster split.

## Why this exists

Every coding agent CLI on the market is single-vendor: Claude Code calls Anthropic models, Codex calls OpenAI's, gemini-cli calls Google's, aider lets you pick but each subagent is still locked to one provider per turn. The wedge: let an almyty workflow orchestrate any CLI coding agent with any model, on the user's machine, in one coherent workspace. PM agent (any model) plans, dispatches subtasks to specialist agents (different CLIs, different models), all editing the same codebase on the same runner.

Every load-bearing decision below serves that wedge.

## Topology

```
+--------+     Streamable HTTP     +-----------+      spawn      +----------+
| almyty | <---------------------> | runner    | --------------> | claude   |
| backend|     POST + GET stream   | (your box)|                 | codex    |
+--------+                         +-----------+                 | gemini   |
    ^                                    |                       | aider    |
    |  workspace.create / .release       v                       | git/etc. |
    |  agent calls into runner-backed    process+shell           +----------+
    |  tools                             primitives
```

The backend never spawns processes itself; it dispatches over the runner connection. The runner never makes outbound calls to LLM providers (those go through the backend's own LLM provider module). The runner exposes a generic process surface; per-tool intelligence lives in agent prompts.

## Cluster 1: Streamable HTTP transport + worker-protocol framing

`backend/src/modules/mcp/transports/streamable-http.transport.ts` and `backend/src/modules/mcp/types/worker-protocol.types.ts`.

- **Why not WebSockets**: MCP Streamable HTTP (2025-03-26 revision) is the transport the project will need anyway for non-runner MCP clients. Building it as the foundation for the runner connection saves a separate transport.
- **Single endpoint, two methods**: `POST /mcp/streamable` for client→server, `GET /mcp/streamable` for the server→client SSE stream. Sessions identified by the `Mcp-Session-Id` header.
- **Two message shapes on one wire**: JSON-RPC for MCP itself (routed to `McpService.handleJsonRpc`), worker envelopes for the runner (and any future worker-shaped protocols, emitted as `envelope` events for downstream subscribers).
- **Reconnect via Last-Event-ID**: per-session ring buffer of recent events. Client reconnects with the last id it saw; server replays everything after. REPLAY_UNAVAILABLE error when the requested id has aged out of the buffer.
- **Cross-tenant refusal returns UNKNOWN_SESSION**: not 403, not "session belongs to another org" — the same code as truly-unknown so the response doesn't leak session existence.

12 tests cover JSON-RPC unary and notification, worker envelope dispatch, malformed envelope rejection, session mint and reuse, cross-tenant refusal, formatted SSE frame shape, mid-stream disconnect-and-resume, and the aged-out replay error path.

## Cluster 2: Runner backend module + Workspace module

Three entities, all greenfield (`backend/src/entities/runner.entity.ts`, `runner-session.entity.ts`, `workspace.entity.ts`):

- **Runner**: registration, runtime info, config, state, lastHeartbeatAt
- **RunnerSession**: audit trail of Streamable HTTP connections per runner
- **Workspace**: a (runner, cwd) reservation with a TTL

Migration uses TEXT + CHECK constraints rather than Postgres ENUM types (matches gateway and agent tables); partial indexes for the two hot queries (active session lookup, expiry sweep).

### Runner state machine

Pure functions in `backend/src/modules/runner/runner-state.ts`. Single source of truth; service calls `nextState(snapshot, event)` and writes the result. Transitions:

```
registered                   initial; never heartbeated
registered -> online         first heartbeat
online <-> busy              workspace count change
online|busy -> stale         3 missed heartbeats (~90s)
stale -> online|busy         heartbeat resumes within 5 min grace
stale -> offline             grace expires
any -> draining              clean shutdown signal
draining -> offline          drain grace expires
```

`canAcceptWork(state)` returns true for ONLINE and BUSY only; routing checks this before dispatching.

### Single-runner-per-account in v1.0

The data model carries no such restriction; the limit lives in the registration policy in `RunnerService.register`. When the v1.x scheduler arrives, the limit lifts without a migration.

### Stranding fan-out

When `RunnerService.tick()` flips a runner to OFFLINE, it returns the runner id in `markStrandedFor`. The same tick processor calls `WorkspaceService.markStrandedForRunners` to flip every active workspace pinned to those runners to STRANDED with `closeReason: { kind: 'stranded', detail: <runnerId> }`. There is no migration to a different runner; stranded = stranded.

### TTL expiry

`WorkspaceService.sweepExpired` runs on the same `workspace-tick` BullMQ job as the runner tick (one queue, one cadence). 24h hard cap on TTL.

44 unit tests + 6 integration tests against real Postgres.

## Cluster 3: Runner CLI daemon (`packages/runner`)

New package; ships as `@almyty/runner` with a `bin: almyty-runner`.

- **Auth via `@almyty/client`**: same shared resolver every other almyty CLI uses. ALMYTY_TOKEN env first, then `~/.almyty/credentials.json` written by `@almyty/auth login`. No parallel structures.
- **Config in JSON**: `~/.almyty/config.json` (global), `./.almyty/config.json` (project), env (`ALMYTY_*`), CLI flags (`--name`, `--label`, `--config`, `--url`). Layered lowest precedence first; backend overrides apply at registration and only constrain.
- **Detected vs configured**: `runtimeInfo` (os, arch, hostname, cpu, memory, runner version, binaries) detected at startup, never settable. `RunnerConfig` (name, labels, isolation, paths, network/install policy, concurrency cap) user-set.
- **PTY by default**: `node-pty` lazy-loaded on first PTY spawn so non-PTY tests don't pay the native dep cost. Pipe mode via `pty: false`.
- **Resource scoping**: every `process_id` namespaced by `workspaceId`. Cross-workspace access throws `PROCESS_CROSS_WORKSPACE`; this is the runner's load-bearing security boundary.
- **No per-tool wrappers**: the runner exposes generic process primitives only. There is no `claude_code.run`, no `git.commit`, no `npm.install`. Tool-specific intelligence lives in agent prompts and orchestration policy.

53 tests, including end-to-end against real `node-pty` and real `/bin/cat` over a real PTY round-tripping stdin/EOF/exit. Streamable HTTP client tests cover POST 202/200, GET stream parse, Last-Event-ID reconnect carry, 404 session-lost, and malformed SSE recovery.

## Cluster 4: Demo + docs

The walkthrough lives at [docs/runner-demo.md](runner-demo.md): start a runner with `almyty runner start`, watch capabilities auto-publish in `/tools`, execute `runner.info` and `shell.exec` from the UI, see output stream back. Every step exercises the routing path end-to-end (cluster 5.5).
## Cluster 5: Runner + Workspace UI (`frontend/src/pages`)

Five pages, all conforming to the existing UI patterns in the repo (React Router v6, TanStack Query inline in pages, shadcn/ui components, custom `<table>`s with the same header/Card/empty-state shape `agents.tsx` uses):

- `/runners` — list page with state badge, OS/arch, last heartbeat, capacity, labels. Polls every 15s (half the runner heartbeat interval). Empty state links to the start-a-runner page.
- `/runners/:id` — detail page with runtime info, labels, capabilities (binary detection results), active workspaces, recent (terminated) workspaces. Deregister button only renders when state is `offline`; uses the existing `AlertDialog` confirmation pattern.
- `/runners/new` — the adoption page. Three-step ordered list: name + labels form, exact `npx @almyty/runner start --name X --label k=v` command (with copy buttons) ready to paste on the target machine, then a "Waiting for first heartbeat..." indicator that polls the runners list and navigates to the runner detail when the runner appears with state online and a recent heartbeat. Validates name uniqueness against existing runners and the `[a-zA-Z0-9_-]{1,64}` regex the backend enforces.
- `/workspaces` — list page with status filter (active by default), per-runner filter, cwd substring search.
- `/workspaces/:id` — detail page with metadata, close reason (only for terminated workspaces), Release action (only for active).

Shared mappings live in `frontend/src/pages/runners-shared.ts`: runner state -> badge variant (online=success, busy=secondary, stale/draining=warning, offline=destructive), workspace status -> badge variant (active=success, released=secondary, expired=outline, stranded=destructive), and the polling cadence constant.

Sidebar entry inserted in `dashboard-layout.tsx` after Agents, before Credentials. Cpu icon from lucide-react, matching the existing icon convention.

### Open question deferred to follow-up: real-time updates

Cluster 1 lands a Streamable HTTP transport on the backend. A natural follow-up is to use it for runner-state subscriptions in the UI (the start-page "waiting for heartbeat" experience and the detail-page state badge would both feel snappier with sub-second updates instead of 15s polling). The cleanest shape would be a per-org event subscription routed through the same `/mcp/streamable` endpoint with a runner-events worker envelope; the UI subscribes once and gets push updates. Polling stays as the conservative default until that subscription endpoint exists; this cluster doesn't add any speculative subscription code.

### Anti-goals (UI cluster)

- No real-time graphs, sparklines, capacity charts.
- No bulk operations (multi-select delete/release).
- No in-UI runner config editing — config lives in `~/.almyty/config.json`; the UI links to the README.
- No "create runner from UI" — the UI generates the command, the user runs it on their own machine.
- No new toast/notification system, dep, theming, or analytics.

## What's deferred to follow-up clusters

- **Routing layer**: the integration point that translates a runner-backed tool call from `tool-executor.service.ts` into a Streamable HTTP envelope dispatch via `transport.push(streamableSessionId, ...)`. The data model + state machine + REST CRUD are in place; this cluster wires the existing tool dispatch path through.
- **Capability publication into the tool catalog**: on runner registration, register the runner's capabilities as tools with `source: runner:<runner_name>`, `requires_workspace: true`, owner-scoped visibility.
- **Container isolation enforcement**: the workspace entity stores the isolation tier; the runner's process manager honors it. v1.0 is host-only; container support via podman lands as a follow-up. (WASM and firejail are explicit anti-goals.)
- **Multi-runner scheduling**: the data model supports it; the picker in `WorkspaceService.pickRunner` returns the user's single runner today and throws if there's more than one. Scheduler logic is v1.x.

## Anti-goals reaffirmed

- No `fs.read | write | copy | move | delete` primitives. Use `shell.exec`.
- No `runner.install` API. Detection only.
- No drain mode beyond "refuse new on shutdown signal."
- No workspace migration across runners. Stranded = stranded.
- No per-tool wrappers.
- No web UI for runners (separate ticket).
- No WASM or firejail isolation tiers.

If a future change contradicts these, surface the contradiction in the PR description rather than silently working around it.
