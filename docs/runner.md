# Runner + Workspace architecture

This doc captures the load-bearing decisions behind the runner and workspace subsystem. Code references are grouped by cluster; commits on the original feature branch follow the same cluster split.

## Why this exists

A runner is remote execution on **any machine you control**: your laptop, a
build box, a GPU host, a server inside your own network. It registers that
machine with almyty and runs process, shell and workspace work there, so the
code, the credentials and the output stay on the machine while almyty sends the
command and reads the result. The backend never spawns anything itself, and the
runner never calls an LLM provider — that asymmetry is what keeps the machine
the user's and the model choice almyty's.

That general capability is the point. Anything that needs to run *where the
data is* — against a private repo, behind a VPN, on a box with a GPU or a
licensed binary or a VPN-only database — is a runner job, and most of them have
nothing to do with coding agents.

One case it happens to be unusually good at is orchestrating coding-agent CLIs.
Every such CLI on the market is single-vendor: Claude Code calls Anthropic
models, Codex calls OpenAI's, gemini-cli calls Google's, aider lets you pick but
each subagent is still locked to one provider per turn. Because the runner
exposes a generic process surface rather than per-tool wrappers, one almyty
workflow can drive any of them with any model, in one coherent workspace: a PM
agent plans, dispatches subtasks to specialist agents on different CLIs and
different models, all editing the same checkout on the same runner.

**v1 limit:** one runner per account. Multi-machine registration is not
available yet.

Every load-bearing decision below serves that: a generic surface on a machine
the user owns.

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

The data model carries no such restriction; the limit lives in the registration policy in `RunnerService.register` (and `create`, for the setup page's record). When the v1.x scheduler arrives, the limit lifts without a migration.

### Identity: what makes a runner yours

A runner is identified and authorised by the login its daemon presents, never by its name.

- `POST /runners/register` takes the owner from the bearer token (the user who ran `almyty-auth login`, or whose `ALMYTY_TOKEN` it is) and the organization from `X-Organization-Id` (`--org`), which `JwtStrategy` refuses for an organization the user is not a member of. Nothing in the body names an owner or an org.
- The name is a label, **unique within the organization**. A name another member already uses is refused with 409. It used to be unique only per owner, while the published tool names (`runner.<name>.<method>`) are unique per organization and publishing replaces rows by name: a second member registering the same name deleted the first member's tools and republished them pointing at their own machine, so an agent calling `runner.<name>.shell.exec` ran on the wrong person's computer.
- The same user restarting with the same name (a rebuilt machine) updates the same row in place; the newest session takes the dispatches. That is the intended takeover and only the owner can do it.
- `runner.hello` binds a Streamable HTTP session to a runner only when the session's user **owns** the runner (`RunnerService.isOwnedBy`). It used to check the organization only, so another member of the same org could bind their daemon's session to your runner id and receive its dispatches (`getActiveSession` takes the newest session). Sessions themselves are bound to the user who minted them: another member cannot POST on, or open the stream of, your session id.

### Visibility

`visibility` is `private` | `team` | `org`, the same three tiers as agents, tools, APIs, gateways, LLM providers and credentials (`AccessPolicyService`). A runner nobody chose a visibility for is **private**: it runs commands as its owner on its owner's machine. The setup page sets it on the pending record; the daemon does not send one, and re-registration keeps what is stored (it used to reset every runner to `org` on each restart).

A private runner is visible to and usable by its owner only, org owners/admins included:

- `GET /runners` (`listVisible`, via `applyListFilter` with the owner column) and `GET /runners/:id` (`getOne`, 404) hide it.
- `RunnerService.resolveForDispatch(runnerId, callerUserId)` — the one function every dispatch goes through (runner REST endpoints, runner-backed tools) — refuses anyone but the owner, and refuses a dispatch with no known caller (an API-key gateway call). Team runners need a team member; org runners accept any member, and a dispatch with no caller as before.
- The coding bridge (`/runners/:id/coding/*`) uses `getUsable` (visibility-aware) instead of "any org member".
- Published capability tools inherit the runner's visibility, team and owner (`createdBy`), so they are hidden from tool lists and MCP surfaces the same way, and `ToolExecutorService` refuses to execute a private tool for anyone but its owner.
- Update and delete of a private runner answer 404 to everyone but the owner.

### Stranding fan-out

When `RunnerService.tick()` flips a runner to OFFLINE, it returns the runner id in `markStrandedFor`. The same tick processor calls `WorkspaceService.markStrandedForRunners` to flip every active workspace pinned to those runners to STRANDED with `closeReason: { kind: 'stranded', detail: <runnerId> }`. There is no migration to a different runner; stranded = stranded.

### TTL expiry

`WorkspaceService.sweepExpired` runs on the same `workspace-tick` BullMQ job as the runner tick (one queue, one cadence). 24h hard cap on TTL.

### Reclaiming processes for dead workspaces

Releasing or expiring a workspace only moves a database row. The processes it
started are on the user's own machine, and something has to kill them.

That happens on the **heartbeat**, not on a release message. Every heartbeat the
runner sends is answered with a `heartbeat` envelope correlated to it, carrying
`workspaces: { active: [...] }` — the set `WorkspaceService.listActiveForRunner`
returns for that runner. The runner kills (`ProcessManager.killWorkspace`)
everything it is hosting outside that set.

A `workspace.release` RPC was the obvious alternative and is the wrong shape:
drop that one message — pod restart, stream gap, runner mid-reconnect — and the
user's processes run forever with nothing left to notice. A set re-sent every
30s self-heals; a missed reconciliation costs one beat.

`active` is the only status reported. `released`, `expired` and `stranded` are
all terminal and all mean the same thing to the machine holding the processes.
`stranded` included: it is set when the runner went offline, it is deliberately
one-way, and a runner that comes back is holding processes for work that is
never resuming.

Four rules keep this from killing the wrong thing:

- **Absent is not empty.** An ack with no `workspaces` key reclaims nothing; an
  ack with `active: []` reclaims everything. An older backend never acks at all,
  and a newer one that could not build the set omits the key rather than sending
  an empty one — an empty set is an instruction to kill.
- **Ambiguity reclaims nothing.** An unparseable set, or an ack that does not
  correlate to a heartbeat this runner actually sent (a replayed frame, say),
  kills nothing and logs why.
- **Nothing newer than the question.** A workspace whose oldest running process
  started after the heartbeat was sent is skipped: the backend's answer predates
  it. The next beat picks it up.
- **Say what was killed.** A reclaim writes
  `workspace <id> reclaimed: killed N process(es) because the backend no longer
  lists it as active` to stdout. Silently terminating someone's processes erodes
  trust in the daemon even when it is right.

Backwards compatible both ways, and the protocol version stays at 1: this adds
payload fields to an existing envelope type. An old runner ignores server-sent
heartbeat envelopes; a new runner talking to an old backend never receives an
ack and so reclaims nothing.

Runner half: `packages/runner/src/workspace-reclaimer.ts`. Backend half:
`RunnerCallService.ackHeartbeat`.

44 unit tests + 6 integration tests against real Postgres.

## Cluster 3: Runner CLI daemon (`packages/runner`)

New package; ships as `@almyty/runner` with a `bin: almyty-runner`.

- **Install path**: `npm i -g @almyty/runner @almyty/auth` once, then the installed binaries (`almyty-auth login`, `almyty-runner start|status|stop`). The daemon is long-lived and queried/stopped locally, so it is a pinned global install rather than an `npx` resolution per start. The umbrella `@almyty/cli` exposes the same commands as `almyty runner …`.
- **Auth via `@almyty/client`**: same shared resolver every other almyty CLI uses. ALMYTY_TOKEN env first, then `~/.almyty/credentials.json` written by `almyty-auth login`. No parallel structures.
- **Config in JSON**: `~/.almyty/config.json` (global), `./.almyty/config.json` (project), env (`ALMYTY_*`, including `ALMYTY_ORG_ID`), CLI flags (`--name`, `--org`, `--label`, `--config`, `--url`). Layered lowest precedence first; backend overrides apply at registration and only constrain.
- **Detected vs configured**: `runtimeInfo` (os, arch, hostname, cpu, memory, runner version, binaries) detected at startup, never settable. `RunnerConfig` (name, labels, isolation, paths, network/install policy, concurrency cap) user-set.
- **PTY by default**: `node-pty` lazy-loaded on first PTY spawn so non-PTY tests don't pay the native dep cost. Pipe mode via `pty: false`.
- **Resource scoping**: every `process_id` namespaced by `workspaceId`. Cross-workspace access throws `PROCESS_CROSS_WORKSPACE`; this is the runner's load-bearing security boundary.
- **No per-tool wrappers**: the runner exposes generic process primitives only. There is no `claude_code.run`, no `git.commit`, no `npm.install`. Tool-specific intelligence lives in agent prompts and orchestration policy.

53 tests, including end-to-end against real `node-pty` and real `/bin/cat` over a real PTY round-tripping stdin/EOF/exit. Streamable HTTP client tests cover POST 202/200, GET stream parse, Last-Event-ID reconnect carry, 404 session-lost, and malformed SSE recovery.

## Cluster 4: Demo + docs

The walkthrough lives at [docs/runner-demo.md](runner-demo.md): start a runner with `almyty runner start`, watch capabilities auto-publish in `/tools`, execute `runner.info` and `shell.exec` from the UI, see output stream back. Every step exercises the routing path end-to-end (cluster 5.5).
## Cluster 5: Runner + Workspace UI (`frontend/src/pages`)

Five pages, all conforming to the existing UI patterns in the repo (React Router v6, TanStack Query inline in pages, shadcn/ui components, custom `<table>`s with the same header/Card/empty-state shape `agents.tsx` uses):

- `/runners` — list page with state badge (a runner whose daemon never connected reads "never connected"), visibility badge, OS/arch, last heartbeat, capacity, labels, and a Delete action behind a one-line confirmation. Lists every runner the caller may see: their own (private ones included), org-wide ones, and team ones for their teams. Polls every 15s (half the runner heartbeat interval). Empty state links to the start-a-runner page.
- `/runners/:id` — detail page with runtime info, labels, capabilities (binary detection results), active workspaces, recent (terminated) workspaces. The owner changes visibility in place on this page. Delete renders when the runner is `offline` or has never connected and requires confirmation.
- `/runners/new` — the setup page. Step 1: name, labels, visibility (Private by default, Team, Org-wide). "Generate command" creates the runner record (`POST /runners`, pending: never connected) holding all of that, so step 2's commands need only the name: `npm i -g @almyty/runner @almyty/auth`, `almyty-auth login`, `almyty-runner start --name X --org <org-id>`. From step 2 the user can go Back (the pending record is updated in place with `PATCH /runners/:id`, rename allowed only while pending) or Cancel (the pending record is deleted). Step 3 polls the record and opens the runner on its first heartbeat. An abandoned setup stays visible on `/runners` as "never connected" and can be deleted there.
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

## Dispatch and capability publication

Both of these are in place, and they are the two halves of "an agent calls a
runner tool".

- **Dispatch**: `backend/src/modules/runner/runner-call.service.ts` resolves a
  runner-backed call to the runner's live Streamable HTTP session and pushes a
  worker envelope over it. `coding-relay.service.ts` sits on top for the
  `coding.*` surface, relaying a coding-CLI session's input and output between
  the agent and the runner.
- **Capability publication**: `runner-capability.publisher.ts` registers a
  runner's detected capabilities as catalog tools on registration. `publish()`
  stamps each with `source: runner:<runner_name>` and the capability's own
  `requiresWorkspace` flag (true for the workspace-scoped surfaces, false for
  the informational ones), owner-scoped. `unpublish()` removes them when the
  runner goes away.

## Isolation: host is what runs

The workspace entity stores an isolation tier, and `WorkspaceService` records
one per workspace. But **no container runtime is wired into any build**, so
host isolation is what actually executes:

- The runner's built-in default is `defaultIsolation: 'host'`, and the daemon
  prints what that permits at boot (`describeIsolationPosture` in
  `packages/runner/src/config.ts`).
- Asking for `container` is refused rather than silently downgraded:
  `packages/runner/src/policy.ts` throws `COMMAND_DENIED` from
  `assertIsolationSupported()` before any spawn. The same is true of
  `networkBlocked: true`, which cannot be enforced on the host.
- So a container tier is a *refusal*, not a sandbox. The honest guards that do
  work today are `allowedCwdRoots` (realpath-canonicalized, so symlinks and
  `..` cannot escape), `denyPatterns`, `installBlocked` and `maxConcurrent`,
  plus the backend's constrain-only overrides at registration.

Container enforcement via podman is still a follow-up; WASM and firejail tiers
are explicit anti-goals. Until then, treat a runner as a machine that runs the
commands you send it.

## What's deferred to follow-up clusters

- **Container isolation enforcement**: see above — the tier is stored and
  refused, not enforced.
- **Multi-runner scheduling**: the data model supports it; the picker in `WorkspaceService.pickRunner` returns the user's single runner today, and throws `multiple runners present but no scheduler in v1.0` if there is more than one and no explicit `runnerId`. Scheduler logic is v1.x.
- **Real-time runner state in the UI**: the polling-vs-subscription question described under the UI cluster above.

## Anti-goals reaffirmed

- No `fs.read | write | copy | move | delete` primitives. Use `shell.exec`.
- No `runner.install` API. Detection only.
- No drain mode beyond "refuse new on shutdown signal."
- No workspace migration across runners. Stranded = stranded.
- No per-tool wrappers.
- No WASM or firejail isolation tiers.

If a future change contradicts these, surface the contradiction in the PR description rather than silently working around it.
