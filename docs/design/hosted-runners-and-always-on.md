# Hosted runners and always-on agents

Design for two of Frane's specs: **hosted runners** ("cloud environments") and
**always-on agents**. The second depends on the first in one place only, the
agent's home machine. All fifteen open questions are decided (see
[Decisions](#decisions)). Always on (phase 1) and agents that act as
themselves have shipped; hosted runners are not built yet, and gVisor on
DigitalOcean has been tested and works.

## In plain words

Today an agent that needs a computer (to check out code, run a coding
assistant, open a browser, run a script) borrows one you start yourself: your
laptop or a server, running `almyty-runner`. When that machine sleeps, the
work stops, and whatever the agent was doing on it is lost.

After this change you can ask almyty for the machine instead. You describe it
once (which repository, which tools, which secrets, which websites it may
reach), and almyty starts it when there is work and parks it when there is
none. Its files stay where they were, so the next time it starts, the work
picks up where it left off. You can watch it and steer it from any device.

Agents can also be **always on**. Your support agent keeps working overnight:
it wakes every half hour and whenever something happens (a webhook fires, a
connection is about to expire, you write to it on Slack). Each time it
continues the same conversation it was having yesterday, does the harmless
things by itself, asks you before anything sensitive (a refund over $500, an
email to a customer), and sends you a summary in the channel you picked.
When other people write to it, they keep their own chats; the agent only
gets a short note that someone wrote. This part is already available, on
your own machine or with no machine at all.

The almyty machines run in a sealed box of their own, so a script on one
cannot see the computer underneath, other customers, or websites you did not
allow. If a machine sits idle for 15 minutes (you can choose between 5 and
120), it is parked, and you pay for the minutes it was running, idle ones
included. Its files are kept for 30 days after its last use; you get a
notice a week before they are removed.

Free accounts keep running agents on their own machines, as now, and can make
them always on there. Paid plans add almyty-hosted machines with included
hours.

## Contents

- [Recon: what the code says today](#recon-what-the-code-says-today)
- [Goals and non-goals](#goals-and-non-goals)
- [Where this sits in the six layers](#where-this-sits-in-the-six-layers)
- [Part 1: hosted runners](#part-1-hosted-runners)
- [Part 2: always-on agents](#part-2-always-on-agents)
- [Metering and tiers](#metering-and-tiers)
- [Security and abuse limits](#security-and-abuse-limits)
- [gVisor on DigitalOcean: test results](#gvisor-on-digitalocean-test-results)
- [Failure modes](#failure-modes)
- [Observability](#observability)
- [Rollout](#rollout), with [Phase 1 status](#phase-1-status-on-development)
- [Test plan](#test-plan)
- [Risks](#risks)
- [Decisions](#decisions)

## Recon: what the code says today

Re-verified on `development` at `b0281c1a`, after #881/#882 (agent-made
workspaces), #886 (schedules, channel posts, amount rules, held calls),
#889, #890 and #892. The spec's recon was taken at `4aac2c5`; the last column
says where it has moved. The rows phase 1 changed (always on #930, agent
identity #927) were brought up to date on 2026-10-08.

| Spec recon (4aac2c5) | Today | Status |
|---|---|---|
| No provisioner; no k8s client | Still true. `backend/package.json` has no Kubernetes client; runners exist only when a user runs `almyty-runner start`. There is no runner container image either: `packages/runner` ships as an npm package only. | unchanged |
| Unique index on (ownerUserId, organizationId) blocks pools | Still true, and enforced in three places: the schema (`UQ_runners_owner_org`, `migrations/1750790000000-UniquenessParity.ts`, asserted by `runner/uniqueness-parity.spec.ts`), the cap in `RunnerService.register` and `create` ("single runner per account in v1.0"), and a name unique per organization (`assertNameFreeInOrganization`). All three move for hosted runners. | unchanged |
| Workspace = runner + cwd; STRANDED, no reattach | Moved. A workspace now also carries `name`, `agentId` and `runId`. An agent run gets one automatically (`RunWorkspaceService.acquire`): one per job and runner, shared with helpers down the `parentRunId` chain, released when the last run of the job ends (`workspace/run-end-release.ts`, plus `releaseForEndedRuns` on the tick). Default TTL one hour, cap 24 hours. Stranding is still one-way (`markStrandedForRunners`), and re-registering a runner also leaves the old incarnation's workspaces stranded. The folder stays on disk after release; the heartbeat ack kills its processes. | moved: a per-job lifecycle exists, persistence does not |
| Container isolation not implemented (fails closed) | Still true. `packages/runner/src/policy.ts` `assertIsolationSupported()` refuses `container` and `networkBlocked`; host is what runs (`docs/runner.md`, "Isolation: host is what runs"). | unchanged |
| Coding relay is pod-local | Still true (`runner/coding-relay.service.ts`, its multi-replica note). It already matters: `k8s/base/api-deployment.yaml` runs **2 API replicas**, so a coding session's output can land on the pod the viewer is not connected to. The transport's own Redis bridge (`strm:out`, `strm:resp`, `strm:sess:<id>` in `mcp/transports/streamable-http.transport.ts`) already carries dispatches and responses across pods; only `coding.*` events do not ride it. | unchanged, and a live bug at 2 replicas |
| Billing is seats only | Still true. `ee/modules/billing` sells per-seat Pro and Business prices. `PLAN_ENTITLEMENTS[pro]` is empty and its comment says "hosted usage caps live outside the entitlement token", but nothing implements such caps. No meter, no usage record. | unchanged |
| Heartbeat: fresh run, fixed prompt, every N minutes, `maxSteps: 10`, timer only | True at `b0281c1a`. Since #930 the Heartbeat is **Always on**: a standing thread, wakes from a timer, channels, webhooks, connection events and a button, the agent's real limits, timers restored at boot, and reports through the scheduled-post path (`agents/always-on/`). Schedule stays a separate thing (Decision 13). | done (#930); see Phase 1 status |
| Tools go to any runner matching `runnerLabels` | Still true (`RunnerService.resolveByLabels`, `agentConfig.runnerLabels`). | unchanged |
| Approval policies "(auto-review)" | There is no auto-review in the code. What exists: the `request_approval` built-in tool (the agent asks); **amount rules**, now free and outside the Business entitlement (`approvals/amount-rules.service.ts`, `ApprovalToolAmountTrigger`, `c77e85dd`); **held calls** for callers that cannot pause (`approval_requests.toolId`, `paramsHash`, `heldResult`, `executedAt`; `tools/tool-approval-gate.service.ts`); an autonomous run pauses in `WAITING_APPROVAL`; pending approvals expire on a sweep; multi-step and quorum policies are EE `approval_policy`. Since #930, Always on's propose/act and ask-first list sit in the same gate. The refute-only verifier (`agents/agent-verifier.helper.ts`) is the nearest thing to an automatic reviewer. | decided: no auto-approver; a later reviewer may only escalate (Decision 7) |
| Wake on credential/connection events | At `b0281c1a`: no event bus; connection state changes surfaced only as notifications. Since #930 `connections/connection-events.ts` is that bus, published where the `connections.*` notifications are made (EE credentials governance) and consumed by Always on. | done for `expiring`, `expired`, `rotation_due` (#930) |
| (not in recon) Runner auth | A runner presents its **user's** login token (`almyty-auth login` or `ALMYTY_TOKEN`). There is no runner-scoped credential, and a hosted pod must never hold a user's token. | new seam needed |
| (not in recon) Browser | The runner has no browser capability; `runtimeInfo.binaries` probes CLIs only. | new |
| (not in recon) Run identity | At `b0281c1a`: `ExecutionPrincipal` was `user` or `gateway` (`common/authorization/execution-access.service.ts`). Since #927 it has an `agent` kind: an agent can act as itself (`agents/agent-identity.ts`, entitlement `agent_identity`). | done (#927) |

Also relevant and already there: Streamable HTTP with `Last-Event-ID` replay
and the Redis session registry; label routing; the runner UI; the reconcile
pattern in `model-deployments` (adapter contract in
`adapters/adapter.interface.ts`, the only-the-processor-touches-adapters rule
in `model-deployments.processor.ts`); the `workspace` grant principal on
`connection_grants`; context compaction (`agent-context-compactor.helper.ts`);
channel posting for scheduled results
(`gateways/channels/scheduled-post.service.ts`); the Webhook channel adapter
(`gateways/channels/adapters/webhook.adapter.ts`).

## Goals and non-goals

### Goals

1. An **environment** an organization defines once and reuses: repository,
   base image, setup script, secrets by reference to the credential store,
   dependency cache, egress and binary allowlist. Org-scoped, versioned and
   access-controlled like every other resource.
2. A **provisioner** that runs hosted runner pods for environments in
   Kubernetes, under a sandboxed runtime, with default-deny networking and a
   short-lived enrollment credential, built on the model-deployments
   reconcile and adapter pattern.
3. **Persistent workspaces** on hosted runners: one volume per workspace, so
   a fresh pod reattaches and resumes. Scale to zero when idle.
4. A **cross-pod coding relay**, so a coding session can be watched and
   steered from any device, whichever API pod it lands on.
5. **Runner-minutes metering** per organization, reported to Stripe.
6. **Always on** as an option on autonomous agents, grown from the Heartbeat
   card. It wakes on a timer and on events, resumes one standing thread and
   one workspace, uses the agent's real run limits, acts or proposes through
   approvals, and reports through channels and notifications.
7. Self-hosted runners keep working exactly as today, on every plan.

### Non-goals

- No new agent type. Workflow agents keep cron and webhooks unchanged.
- No change to the executor, strategies or orchestrator (L5/L6).
- No workspace migration between machines. A hosted workspace reattaches to
  a new pod of the *same* environment through its volume. It never moves to
  a different environment or to a self-hosted runner.
- No WASM or firejail tiers (still anti-goals in `docs/runner.md`).
- No hosted runners on the Free plan, and no gating of self-hosted runners on
  any plan (`runner` stays in `COMMUNITY_ENTITLEMENTS`).
- No GPU environments in this design.
- No general-purpose hosting: a hosted runner runs agent work. It does not
  accept inbound traffic.

## Where this sits in the six layers

`docs/design/layers.md` describes the path of a *model call*. Neither spec
adds a layer to that stack, and neither should. Where they touch it:

- **L1, egress.** A hosted environment's egress allowlist is the same idea as
  the per-organization allowlist in `connections/egress-policy.ts`, but
  `safeFetch` cannot enforce it, because traffic from a pod never passes
  through backend code. It is enforced at the network: a default-deny
  NetworkPolicy plus a per-environment Cilium policy that allows the listed
  hosts by FQDN and TLS SNI and denies private ranges (below). The allowlist
  uses the same vocabulary (hosts, no private ranges), so one mental model
  covers both. The new Kubernetes client gets an entry in
  `outbound-transport-inventory.guard.spec.ts` saying why its URL is safe:
  it comes from a stored, admin-owned connection, never from user input at
  request time.
- **L3/L4, model calls from coding CLIs.** A coding CLI inside a hosted pod
  calls a model. By default (Decision 6) it calls almyty's own Anthropic- and
  OpenAI-compatible endpoints (`agents/agent-anthropic-compat.controller.ts`,
  `agents/agent-openai-compat.controller.ts`) with a pod-scoped token, so the
  call re-enters at L3/L4 and is routed, budgeted and attributed like any
  other. The runner itself still never calls a model provider.
- **Cross-cutting, budgets.** Runner-minutes become a cost the budget ledger
  sees (`docs/budgets.md`). "Every decision records the projection that
  caused it" applies to a refused wake the same as to a refused model call.
- **Always on is an entry point, not a layer.** It decides *when* a run
  starts and *which thread* it continues, then calls
  `AgentRuntimeService.startRun` the way the scheduler and the channels do.
  The rule that keeps it honest mirrors L5's: **a wake never changes the
  engine.** If always on needs an executor change, the design is wrong.

## Part 1: hosted runners

### Shape

```
                          +---------- runner cluster (gVisor pool) --------------+
 almyty API pods          | namespace almyty-rt-<org>  (ResourceQuota, deny-all)  |
 +-----------------+      |  +------------------------------------------------+  |
 | hosted-runners  | k8s  |  | Deployment hr-<id>  (replicas 0|1, Recreate)   |  |
 | reconcile loop  |----->|  |   pod: runtimeClassName gvisor                 |  |
 | (only caller of | API  |  |     almyty-runner --enroll   (env image)       |  |
 |  the adapters)  |      |  |     /workspace  <-  PVC ws-<workspaceId>       |  |
 +-----------------+      |  +------------------------------------------------+  |
          ^               |        | egress: Cilium policy, default deny         |
          | Streamable    |        v                                             |
          | HTTP, as for  |  almyty API ingress + the environment's hosts,       |
          | any runner    |  by FQDN and TLS SNI, port 443 only                  |
          |               +------------------------------------------------------+
          +------------- the runner registers and heartbeats like any runner
```

To the backend a hosted runner is an ordinary runner: it registers,
heartbeats, takes dispatches over Streamable HTTP and obeys the heartbeat
ack. What is new is who starts it, who it authenticates as, and what happens
when it goes away.

### Data model

New tables use TEXT + CHECK rather than Postgres enums, matching the runner
tables (`migrations/1745310000000-RunnerWorkspaceInit.ts`). One migration per
phase; nothing uses `synchronize`.

**`environments`** (new, `backend/src/entities/environment.entity.ts`,
`@VersionedEntity()` so `versions/` keeps every saved version):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `organizationId` | uuid | FK, cascade |
| `ownerUserId` | uuid | creator; the owner for visibility |
| `visibility`, `teamId` | varchar(8), uuid | `private` by default; `team`/`org` per Decision 4 |
| `name` | varchar(64) | unique per org; used in tool names (`env.<name>.*`) |
| `description` | text | |
| `repo` | jsonb | `{ url, ref, connectionId? }`. The git credential is a connection, never a column. |
| `image` | jsonb | `{ base: 'standard' \| 'standard-browser', digest }`; custom images per Decision 9 |
| `setupScript` | text | runs once per workspace volume per environment version |
| `secretBindings` | jsonb | `[{ connectionId, field, envVar }]`. References only; values resolve through a grant to principal `environment` at pod start. |
| `cache` | jsonb | `{ paths: string[], sizeGi }` |
| `egress` | jsonb | `{ allowHosts: string[], allowBinaries?: string[] }` |
| `resourceClass` | varchar(16) | `small`, `medium`, `large` (CPU, memory, disk); the billable unit |
| `idleTimeoutMinutes` | int | default 15, allowed 5 to 120 (Decision 3); default and range come from plan settings, not code |
| `clusterConnectionId` | uuid null | Enterprise: the org's own cluster, a `kubernetes` connection. Null means the platform pool. |
| `createdAt`, `updatedAt`, `deletedAt` | timestamptz | soft delete; the loop tears down what is left |

`connection_grants`: add `environment` to `GRANT_PRINCIPAL_TYPES`
(`entities/connection-grant.entity.ts`). An environment is only ever a grant
target, never a connection owner, the same rule as `workspace`
([connections-grants.md](connections-grants.md)). Every resolve at pod start
is audited, as every resolve already is. `no-secrets-outside-credentials.spec.ts`
keeps passing, because nothing above stores a secret.

**`hosted_runners`** (new, `entities/hosted-runner.entity.ts`): the
provisioner's desired and actual state, the same split as `model_deployments`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `organizationId` | uuid | |
| `environmentId` | uuid | |
| `environmentVersion` | int | the version the pod was started from |
| `workspaceId` | uuid | the persistent workspace this pod serves (one pod per workspace) |
| `runnerId` | uuid null | the `runners` row it enrolled as; stable across pod restarts |
| `providerType` | varchar | adapter key: `kubernetes`, `stub` |
| `desired` | jsonb | `{ replicas: 0 \| 1, resourceClass, teardownRequested? }`, written by services |
| `providerConfig` | jsonb | opaque to everything but the adapter |
| `externalRef` | jsonb null | adapter-owned: namespace, deployment, PVC and secret names |
| `actual` | jsonb null | last read; never secrets |
| `state` | varchar | `pending`, `provisioning`, `ready`, `suspending`, `suspended`, `failed`, `tearing_down`, `torn_down`, `orphaned` |
| `lastActiveAt` | timestamptz | last dispatch, coding session or attached viewer |
| `lastReconcileAt`, `lastError` | | |
| `createdBy` | uuid | |

Only the reconcile processor writes `state`, `actual`, `externalRef`,
`lastError` and `lastReconcileAt`. Services write `desired` and enqueue. That
is the `ObservedColumns` rule from `model-deployments.processor.ts`, and a
guard spec of the same shape enforces it.

**`runners`** (changed):

- `kind` varchar(8), `self | hosted`, default `self`.
- `hostedRunnerId` uuid null.
- `UQ_runners_owner_org` becomes a partial unique index `WHERE kind = 'self'`,
  and the single-runner cap in `register`/`create` applies to `kind = 'self'`
  only. Self-hosted behaviour does not change.
- Name uniqueness per organization stays. Hosted runners get generated names
  (`env-<environment>-<first 8 of workspace id>`) and are never renamed.
- Hosted runners do **not** publish per-runner capability tools
  (`runner-capability.publisher.ts`): one pod per workspace would flood the
  catalog. The environment publishes one set, `env.<name>.<method>`, that
  routes to the caller's workspace on that environment (see Dispatch).

**`workspaces`** (changed):

- `kind` varchar(12), `job | persistent`, default `job`. `job` is everything
  that exists today. `persistent` is a hosted workspace that outlives runs.
- `environmentId` uuid null.
- `volumeRef` jsonb null, adapter-owned (PVC name, size, snapshot source).
- `status` gains `suspended`, a **non-terminal** state: the pod is scaled to
  zero and the volume is kept. `active <-> suspended` both ways;
  `suspended -> released | expired` allowed; a `persistent` workspace never
  reaches `stranded`. The one-way guard
  (`workspace/workspace-transitions-are-one-way.spec.ts`) is extended, not
  loosened: the terminal states stay terminal.
- `lastActiveAt` timestamptz.
- A partial unique index allows at most one non-terminal persistent workspace
  per `(environmentId, ownerUserId, agentId)`. An always-on agent's home
  workspace is that row with `agentId` set.

**`runner_enrollment_tokens`** (new): `id`, `organizationId`,
`hostedRunnerId`, `tokenHash` (sha256), `expiresAt` (10 minutes), `usedAt`.
Single use.

**`runner_usage_intervals`** (new, `entities/runner-usage-interval.entity.ts`):
`id`, `organizationId`, `hostedRunnerId`, `environmentId`, `workspaceId`,
`agentId` null, `resourceClass`, `startedAt`, `endedAt` null, `reportedAt`
null, `meterIdentifier` null. A new retention class in
[retention.md](../retention.md), kept at least as long as an invoice can be
disputed.

### The provisioner

New module `backend/src/modules/hosted-runners/`, the model-deployments
shape:

```
hosted-runners/
  adapters/
    hosted-runner-adapter.interface.ts   the frozen contract
    adapter.registry.ts
    kubernetes.adapter.ts                @kubernetes/client-node
    stub.adapter.ts                      in-memory, internal: true
  hosted-runners.service.ts              writes desired, enqueues
  hosted-runners.processor.ts            the only caller of adapters
  environments.service.ts, environments.controller.ts
  enrollment.service.ts
  hosted-capacity.service.ts             plan capacity (see Metering)
  __tests__/conformance/                 one suite every adapter passes
```

The contract mirrors `ModelProviderAdapter`; credentials are passed in,
never held:

```ts
interface HostedRunnerAdapter {
  readonly key: string;
  capabilities(): { runtimeClasses: string[]; resourceClasses: string[]; volumeSnapshots: boolean };
  /** Namespace if missing, PVC, NetworkPolicy, enrollment Secret, Deployment at 0. */
  provision(req: ProvisionRequest, creds: AdapterCredentials): Promise<HostedRef>;
  read(ref: HostedRef, creds: AdapterCredentials): Promise<HostedActual>;
  scale(ref: HostedRef, replicas: 0 | 1, creds: AdapterCredentials): Promise<void>;
  rotateEnrollment(ref: HostedRef, token: string, creds: AdapterCredentials): Promise<void>;
  teardown(ref: HostedRef, opts: { keepVolume: boolean }, creds: AdapterCredentials): Promise<void>;
}
```

The rules carry over unchanged: adapters never import each other
(`adapter-isolation.spec.ts` gets a sibling); `providerConfig` is opaque to
everything but its adapter; only the processor mutates a provider; every
transition is audited.

**The loop** (queue `hosted-runner-reconcile`): a sweep every 60 seconds,
plus an immediate enqueue whenever `desired` changes, because a wake must not
wait for the sweep. Each tick reads the actual state, diffs it against
desired, acts, and writes what it saw:

| Desired | Actual | Action |
|---|---|---|
| row exists, never provisioned | nothing | `provision` |
| replicas 1 | 0, or not ready | mint an enrollment token, `rotateEnrollment`, `scale(1)`; `provisioning` until the runner heartbeats |
| replicas 1 | ready, runner online | `ready`; open a usage interval if none is open |
| replicas 0 | running | `scale(0)`; `suspending`, then `suspended`; close the usage interval; workspace `suspended` |
| `teardownRequested` | anything | `teardown`; volume kept or deleted by the workspace's status |
| nothing | exists in the cluster | orphan after 30 minutes' grace, then torn down (the `ORPHAN_GRACE_MS` rule) |

A provisioning claim carries a lease, as `DEPLOY_CLAIM_LEASE_MS` does, so two
API pods never provision the same row and a pod that died mid-provision does
not leave it stuck. Three consecutive read failures mark the row `failed`.

**Idle detection.** The runner reports activity in its heartbeat (running
processes and open coding sessions per workspace). These are new optional
fields; the protocol version stays at 1, and an absent field means "unknown,
treat as active". The backend also bumps `lastActiveAt` on every dispatch and
for every attached viewer of the coding relay. When `now - lastActiveAt`
exceeds `idleTimeoutMinutes` and no run of the workspace is live
(`jobHasLiveRun`), the service writes `replicas: 0`.

**Waking.** `RunnerCallService.dispatch` and `RunWorkspaceService.acquire`
gain one branch: when the target workspace is `persistent` and `suspended`,
or its runner is not online yet, they call `HostedRunnersService.ensureAwake`,
which writes `replicas: 1` and enqueues. Then:

- An autonomous run gets a retryable `workspace_waking` tool result, and the
  step processor puts the run to `SLEEPING` with a resume in 10 seconds (the
  existing sleep path), within a 3-minute wake budget, after which the call
  fails `workspace_unavailable`.
- An interactive caller (UI, MCP) gets `202` with the workspace state and
  polls (the 15-second cadence already in `runners-shared.ts`).

Target: under 30 seconds from cold wake to first command at p50, with the
environment image pre-pulled on runner nodes.

### Kubernetes objects and sandboxing

**The runner cluster** (Decision 2) is a separate DigitalOcean Kubernetes
cluster that runs hosted runners and nothing else of ours. Its shape follows
the gVisor test ([results](#gvisor-on-digitalocean-test-results)):

- An untainted **system pool** for CoreDNS, Hubble, metrics and the like,
  which do not tolerate the sandbox taint.
- A **gVisor pool** of at least two nodes (or the autoscaler with headroom),
  labelled `almyty.com/sandbox=gvisor` and tainted
  `almyty.com/sandbox=gvisor:NoSchedule` in the pool spec. The pool spec
  never carries the ready label.
- The **gVisor installer DaemonSet** on that pool, the only thing that sets
  or removes `almyty.com/gvisor=ready` on a node: it sets it after `runsc
  do` boots a sandbox there, removes it on any failure, and re-asserts it
  every minute. It pins the gVisor release and sha512 and installs
  `gvisor-bin/` next to `runsc` (releases since 2026-09 need those sidecars).
  It reads the containerd config's `version` to choose the runtime table
  (v2 on Kubernetes 1.35, v3 on 1.36), appends that table only when its
  marker is missing, and never rewrites the config of a live node, because
  a rewrite plus restart kills every sandbox on it. Its health check is
  `runsc do` plus "containerd started after the config last changed";
  `ctr run` is not a valid check (it fails silently on these nodes while
  the kubelet path works). For production the binaries are baked into the
  installer image rather than downloaded.
- The **`gvisor` RuntimeClass** (handler `runsc`), which schedules only onto
  `almyty.com/gvisor=ready` nodes and tolerates the sandbox taint. A node
  that is new, upgrading or failing its install takes no sandboxed pod.

The reference manifests are in [hosted-runners/](hosted-runners/).

Each organization gets a namespace `almyty-rt-<org short id>`, labelled
`almyty.io/runner-pool=true`, with:

- A **ResourceQuota and LimitRange** sized from the org's plan capacity
  (concurrent hosted runners times resource class). A runaway org exhausts
  its own quota, not the node pool.
- A **default-deny NetworkPolicy** for ingress and egress. Allowed egress:
  DNS to kube-dns, the almyty API's public ingress (the runner connects out,
  exactly as a self-hosted one does), and the environment's allowlist
  (below). Nothing else: explicitly not `169.254.169.254`, the cluster
  CIDRs, the Kubernetes API or other namespaces. No ingress at all.

Per workspace: a **PVC** `ws-<workspaceId>` (RWO, sized from the
environment's cache and class); a **Secret** with the enrollment token and
the resolved environment secrets; and a **Deployment** with `replicas: 0|1`
and `strategy: Recreate` (an RWO volume mounts once). Runners are always a
Deployment (or a Job), never a bare pod: node drains on replace and upgrade
delete bare pods, and a controller reschedules them. A
**PodDisruptionBudget** keeps a drain from taking a busy runner down
without warning. The pod has:

- `runtimeClassName: gvisor`, always; never plain runc;
- non-root, `readOnlyRootFilesystem` except `/workspace` and `/tmp`, all
  capabilities dropped, `allowPrivilegeEscalation: false`, seccomp
  `RuntimeDefault`;
- `automountServiceAccountToken: false`;
- requests and limits from the resource class, and an ephemeral-storage
  limit.

**Egress allowlist.** A NetworkPolicy cannot name hostnames, and a Cilium
`toFQDNs` rule alone is not enough: it allows by resolved IP, so every host
that shares a CDN IP with an allowed one is reachable too (tested:
`registry.yarnpkg.com` behind an allowed `registry.npmjs.org`). Each
environment therefore gets a **CiliumNetworkPolicy** in its namespace,
selecting that environment's pods, with a DNS rule for kube-dns and one
rule on port 443 that lists the environment's `allowHosts` both as
`toFQDNs` and as TLS SNI `serverNames`, which Cilium's Envoy enforces. The
provisioner writes it from `egress.allowHosts` at provision and on every
environment version. Port 443 only: plain HTTP is not allowed out. An allowed
name that resolves to a private address would pass an FQDN rule, so the
policy also carries `egressDeny` rules for private ranges, the cluster CIDRs
and the metadata address, which win over any allow (the L1 rule). The
binary allowlist (`allowBinaries`) is enforced in the runner's policy
(`packages/runner/src/policy.ts`, next to `denyPatterns`); inside a sandbox
it is a guard rail, not the boundary.

**The provisioner's own access.** The API talks to the runner cluster as a
ServiceAccount whose RBAC covers only namespaces labelled
`almyty.io/runner-pool=true` and only the kinds above. Its kubeconfig is a
connection in `credentials` (connector `kubernetes`), never an env var on the
API pod, so the Enterprise case (the org's own cluster) is the same code with
a different connection. The API's own policy
(`k8s/base/api-network-policy.yaml`) does not change: runners reach the API
the way the public does, through ingress.

**Images.** One maintained family, `almyty/runner-env`, built in CI.
`standard` has node, python, git and the coding CLIs the runner already
detects (claude, codex, gemini, aider). `standard-browser` adds headless
Chromium and Playwright, for agents that need a browser (the "persistent
machine and browser" of spec 2). Pinned by digest on the environment version.
Custom images come later, as a Business option with a scan on import
(Decision 9).

### Enrollment

A hosted pod must never hold a user's login token, and today that is the
only credential a runner has.

1. Before `scale(1)`, the processor mints a token (32 random bytes), stores
   its hash in `runner_enrollment_tokens` with a 10-minute expiry, and writes
   it into the pod's Secret through `rotateEnrollment`.
2. The runner starts with `almyty-runner start --enroll` and calls
   `POST /runners/enroll` with it. The backend checks hash, expiry and single
   use, and answers with a **runner credential**: a JWT with
   `sub: runner:<runnerId>`, `org`, `act: <workspace owner's user id>`, one
   hour's expiry, renewable by the runner over its live session.
3. `JwtStrategy` accepts a `runner:` subject on the runner surface only
   (`/mcp/streamable`, and `/runners/:id/*` for its own id). Everywhere else
   it is a 401. For `kind = 'hosted'`, `runner.hello` binds the session when
   the credential's runner id matches, in place of the "session user owns the
   runner" check.

The token is useless after first use or ten minutes. The runner credential is
useless outside its own runner; it cannot call an agent, read a credential or
list anything.

### Persistent workspaces and the existing lifecycle

The per-job lifecycle from #881/#882 stays as it is. The new kind sits
beside it:

| | `job` workspace (today) | `persistent` workspace (new) |
|---|---|---|
| Created by | `RunWorkspaceService.acquire`, on the first runner call of a job | the first call of a job routed to an environment, or enabling Always on with a home environment |
| Lives on | any runner, self-hosted or hosted | a hosted runner only |
| Shared by | the job: the top-level run and every descendant | every job of its owner (and agent, if set) on that environment |
| Ends | when the last run of the job ends; TTL 1 h (max 24 h) as a net | never by run end; `released` by the user, `expired` after the retention window while suspended (Decision 8) |
| Its runner goes away | `stranded`, one-way | `suspended`; the next wake starts a fresh pod on the same volume |
| Processes | killed by the heartbeat ack after release | killed by the heartbeat ack after release, and by scale to zero |

Concretely:

- `releaseRunWorkspaces` and `releaseForEndedRuns` skip
  `kind = 'persistent'`. They select by `runId`, which a persistent workspace
  does not carry; a guard spec pins that.
- `markStrandedForRunners` skips runners with `kind = 'hosted'`; their
  workspaces go `suspended` instead. Stranded stays a self-hosted-only state,
  as the spec asks.
- `listActiveForRunner` returns `active` persistent workspaces as before, so
  the heartbeat-ack reclaim rules in [runner.md](../runner.md) apply
  unchanged.
- `sweepExpired` ignores persistent workspaces' `ttlAt` (it is null) and
  instead expires `suspended` ones untouched for the retention window.
- A person's jobs on one environment share one folder, the whole volume,
  and run one after another (decided 2026-10-08). A job holds the
  workspace while any of its runs is going (`WorkspaceLeaseService`); a
  call of another job waits, then answers `workspace_busy` and the run
  sleeps and retries.

**Setup and cache.** On the first start of a volume, or when the environment
version changed, the runner clones `repo` at `ref`, runs `setupScript`, and
writes `/workspace/.almyty/env-version`. Cache paths live on the same volume.
Building a "golden" volume once per environment version and cloning new
workspace volumes from a VolumeSnapshot is a phase-4 optimisation, behind
`capabilities().volumeSnapshots`.

### Dispatch

An agent picks a hosted environment with `agentConfig.environmentId`, next to
`runnerLabels` under Capabilities > Machine. The environment's published
tools (`env.<name>.shell.exec`, `env.<name>.coding.start`, ...) carry
`requiresWorkspace: true` and route like this:

1. Find the caller's persistent workspace on that environment, or create it
   (subject to capacity).
2. If it is suspended, wake it (above).
3. Dispatch to its runner through the unchanged `RunnerCallService.dispatch`,
   with `findForDispatch` deciding coverage exactly as today.

`runnerLabels` keep working for self-hosted runners. An agent names one or
the other, not both (a validation error).

### Cross-pod coding relay

The missing piece is small, because steering already crosses pods:
`coding.input` and `coding.stop` are dispatches, and dispatches ride
`strm:out` today. Only the event stream back (`coding.output`,
`coding.exit`) is pod-local.

The change, in `runner/coding-relay.service.ts`:

1. When a `coding.*` envelope arrives on a pod, after the existing ownership
   checks, append it to a Redis stream
   (`XADD coding:evt:<runnerId>:<sessionId> MAXLEN ~ 2000`; the entry id
   doubles as the SSE event id) and `PUBLISH coding:evt:<runnerId>` a
   pointer.
2. Each pod holds one pattern subscription on the subscriber connection the
   transport already opens, and re-emits to its local SSE subscribers of
   that runner.
3. `GET /runners/:id/coding/sessions/:sessionId/events` honours
   `Last-Event-ID` by reading the stream from that id (`XRANGE`). A phone
   that joins a session started on a laptop sees the backlog, then live
   output.
4. Without Redis (tests, single-pod dev) it stays pod-local, as the transport
   does.

Authorization does not change (`getUsable` on the runner; coding session ids
are scoped to the runner). Streams expire 24 hours after their last event.

This was meant to ship first and on its own, because it fixes the
two-replica deployment today. It has **not** shipped yet: as of 2026-10-08
`coding-relay.service.ts` still relays pod-locally (see
[Phase 1 status](#phase-1-status-on-development)).

### Environments UI

Following "no dialogs" and "reuse UI components", environments are created
and edited on a page, reusing the runner setup page's step layout, under a
"Hosted" tab on `/runners` (Decision 10). An environment's page shows its
versions (from `versions/`), its workspaces with their state, a live view of
a coding session (the relay above), month-to-date runner-minutes, and
Suspend and Release per workspace.

## Part 2: always-on agents

Phase 1 of this part has shipped (#930); see
[Phase 1 status](#phase-1-status-on-development). The design below is kept
as written, with notes where the build differs.

### What changes for the agent

The Heartbeat card in `frontend/src/components/agents/builder/autonomous-config.tsx`
becomes **Always on**. It stays an option on autonomous agents. When it is on
it shows what wakes the agent, where it works (its home machine), what it may
do on its own, and where it reports. Workflow agents are untouched.

### Data model

`agents.heartbeat` becomes `agents.alwaysOn`: one migration renames the
column and reshapes the JSON; `enabled`, the interval, the prompt and
`pausedReason` carry over.

```ts
alwaysOn: {
  enabled: boolean;
  /** Standing instructions, read at every wake (was the heartbeat prompt). */
  brief: string;
  wakeOn: {
    timer?: { everyMinutes: number };    // floor per Decision 5
    channelIds?: string[];               // agent channels whose messages wake it (Decision 1)
    webhookChannelIds?: string[];        // Webhook-type agent channels
    connectionEvents?: Array<'expiring' | 'expired' | 'inactive' | 'rotation_due'>;
  };
  home?: { environmentId: string };      // otherwise runnerLabels, or no machine
  standingConversationId?: string;       // set on the first wake
  workspaceId?: string;                  // the persistent home workspace
  actMode: 'propose' | 'act';            // Decision 7
  reportTo: ScheduleDelivery[];          // channel and/or webhook, as schedules use
  report: 'every_wake' | 'when_acted' | 'daily_digest';
  maxWakesPerHour: number;               // default 12
  pausedReason?: AgentPauseReason;
}
```

`AgentPauseReason` gains `CAPACITY_EXHAUSTED` and `WAKE_LOOP`.

As built in phase 1 (`modules/agents/always-on/always-on.types.ts`), the
shape differs in a few places: Webhook channels sit in `wakeOn.channelIds`
with the rest; the owner's own channel is `ownerChannel: { channelId,
address, trustEmail? }` (Decision 1); the ask-first list is
`askFirstToolIds`; `report` is `every_wake` or `when_acted` (no
`daily_digest` yet); `liveRunId` tracks the standing thread's latest run;
`home` and `workspaceId` wait for hosted runners. `IDENTITY_LAPSED` joined
the pause reasons with agent identity.

**`agent_wakes`** (new): the inbox between events and runs.

| Column | Notes |
|---|---|
| `id`, `organizationId`, `agentId` | |
| `source` | `timer`, `channel`, `webhook`, `connection`, `manual` |
| `sourceRef` | channel id, connection id, ... |
| `summary` | one bounded line the agent reads ("Slack #support: new message from Ana") |
| `payload` | bounded JSON (16 KB), never secrets |
| `dedupeKey` | unique per agent: the timer tick, a message id, connection + event + day |
| `status` | `queued`, `consumed`, `coalesced`, `dropped` |
| `runId` | the run that consumed it |
| `createdAt`, `consumedAt` | |

### Wake sources

Every source writes an `agent_wakes` row through one function,
`AlwaysOnService.wake(agentId, source, ...)`, and enqueues `always-on-wake`
with job id `wake:<agentId>`, so the queue collapses duplicates. Nothing else
starts an always-on run.

- **Timer.** The `heartbeat` job in `agent-runtime.processor.ts` becomes
  `always-on-tick` and only calls `wake(..., 'timer')`. Its repeatable jobs
  are restored at boot the way schedules are, closing today's gap; the
  restore is the reconcile the builder save already runs
  (`reconcileHeartbeat` in `agents.controller.ts`, renamed).
- **Webhooks.** A Webhook-type agent channel listed in
  `wakeOn.webhookChannelIds`. Its signature checks do not change. Instead of
  starting a per-sender conversation, `channel-gateway.service.ts` calls
  `wake(..., 'webhook')` with a summary of the payload. Repo events
  (Business) arrive the same way, from a repository host's webhook pointed at
  that channel.
- **Connection events.** There is no event bus, so this adds the smallest
  one: a `ConnectionEventsPublisher`, called at exactly the sites that create
  the `connections.*` notifications today. It wakes agents that hold a grant
  on that connection (principal `agent`) and listed the event.
- **Channel messages.** Messages on a channel in `wakeOn.channelIds` wake the
  agent. Only the owner's own messages join the standing thread; anyone
  else keeps their own chat and the agent gets a one-line summary
  (Decision 1).
- **Manual.** A "Wake now" action on the agent page; `PATCH
  /agents/:id/heartbeat` becomes `PATCH /agents/:id/always-on`.

**Loop guard.** A wake caused by the agent's own outbound message (a report
it posted into a channel it also listens to) is dropped by sender identity.
More consumed wakes than `maxWakesPerHour` pauses the agent with `WAKE_LOOP`
and tells the owner.

### Continuity: one thread, one workspace, real limits

`always-on-wake` handles one agent at a time: single flight per agent, through
a Redis lock on the agent id that is released when the run ends.

1. If a run on the agent's standing thread is live (running, sleeping,
   waiting for input or approval), it does nothing: the wakes stay queued,
   and the step processor drains them into the live run at its next step as
   one user message ("While you were working: ..."). That is the existing
   conversation path, not a new one.
2. Otherwise it claims every queued wake (`status = consumed`, `runId`) and
   calls `startRun(agentId, org, owner, <brief + wake summaries>,
   { conversationId: standingConversationId, principal, metadata:
   { triggerType: 'always_on', wakeIds } })`. No `maxSteps`: the run uses the
   agent's resolved limits (`resolveRunLimits`: env floor, organization,
   agent), as a scheduled run has since `db01d158`. The literal
   `maxSteps: 10` is deleted, and a guard spec keeps it gone.
3. The standing conversation is created on the first wake and stored in
   `alwaysOn.standingConversationId`. Context compaction
   (`agent-context-compactor.helper.ts`) is forced on for it: a thread that
   lives for months must not resend months of history. Memory and
   constraints carry over as they do now.
4. The machine. With `home.environmentId`, runner calls go to the agent's
   persistent workspace on that environment (`alwaysOn.workspaceId`), which
   run end never releases. Without it, `runnerLabels` and the per-job
   workspace apply as today: a self-hosted runner works, it just starts a
   fresh folder on each wake.
5. Owner and access are judged at fire time, exactly as the heartbeat does
   now (`executionAccess.canExecute` with the owner's principal; a refusal
   pauses with `OWNER_CANNOT_RUN`).

Retention: the standing conversation is exempt from the conversation sweep
as a whole. Its messages older than `conversationsDays` are pruned inside it,
and the compaction summary keeps the gist. [retention.md](../retention.md)
gets the rule.

### Act or propose

Sensitive actions go through the approval machinery that already exists:

- **`propose`** (the default). Every tool on the agent's "ask first" list
  pauses the run in `WAITING_APPROVAL` before it runs, and `approval.pending`
  goes to the owner (and through `reportTo`, with a link to the approval).
  The list generalises an amount rule without a threshold: a new
  `ApprovalToolCallTrigger { kind: 'tool_call', toolId }` beside
  `ApprovalToolAmountTrigger`, enforced by the same
  `tools/tool-approval-gate.service.ts`, and free like amount rules. When
  Always on is first switched on, the card pre-fills the list with the
  agent's tools that are not read-only by method (HTTP `GET`/`HEAD` and
  `runner.info` count as read-only; everything else is listed), and the owner
  edits it.
- **`act`**. The agent runs everything except what an amount rule or the
  list catches.
- Amount rules apply in both modes, always. On Business, multi-step
  `approval_policy` policies apply on top, unchanged.
- The automatic reviewer the spec calls "auto-review" comes later and may
  only escalate an action to a person, never approve one (Decision 7).

A run waiting for approval holds the agent's single flight: new wakes queue
behind it and arrive when it resumes. A rejection ends the run (today's
behaviour) and is reported.

### Reporting

- **Channels and webhook.** `reportTo` reuses `ScheduleDelivery` and
  `ScheduledPostService.post`, so a report goes out through the channel's
  usual send path, AI disclosure included.
- **Notifications.** Two new types in `notification-types.ts`:
  `agent.report` (in-app on, email off) and `agent.paused` (in-app and email
  on). `run.failed` keeps its default (email off).
- `report: 'daily_digest'` batches into one post a day in the owner's
  timezone, reusing the schedule's time-of-day logic.

## Metering and tiers

### What is metered

**Runner-minutes**: the minutes a hosted runner pod was running, per
resource class, from the provisioner's own observations. A row in
`runner_usage_intervals` opens at `ready` and closes at `suspended` or
teardown. What the pod says about itself is never the source. That includes
the idle tail before scale to zero (Decision 3): it is the cost we pay, and
the usage page shows it as its own line. Always-on runtime is metered the
same way: an always-on agent with a hosted home accrues minutes while its
pod runs, and nothing while it is suspended between wakes.

Model spend is not runner-minutes. It stays where it is (BYOK and budgets).

### Recording to Stripe

In `ee/modules/billing`:

- A metered price per resource class, added to Pro, Business and Enterprise
  subscriptions as extra subscription items, with the included hours as a
  free first tier (graduated pricing), so Stripe does the "included, then
  overage" arithmetic.
- An hourly job, `runner-usage-report`, sums closed and still-open intervals
  per org and class for the hour and sends one Stripe meter event per
  (org, class, hour) with the identifier `<org>:<class>:<hour>`, so a retry
  never bills twice. It writes `reportedAt` and `meterIdentifier` back.
- On an Enterprise contract the same totals are recorded and shown, and
  nothing goes to Stripe.
- The OSS build has no billing module. A self-hosted install running its own
  pool has no plan capacity and bills nobody; its usage page still shows
  minutes.

### Capacity

`hosted-capacity.service.ts` answers "may this org start or wake a hosted
runner now". Every number it uses is data, never a constant in the code
that reads it (Decision 5), in the same three layers Always on already uses
(`modules/agents/always-on/always-on-capacity.ts`):

1. The plan catalog seeds a row per plan (`PLAN_HOSTED_CAPACITY`): included
   runner-hours per resource class, concurrent hosted runners, included
   always-on agents with a hosted home, the default monthly ceiling, the
   allowed idle-timeout range (5 to 120 minutes) and its default (15).
2. The install overrides any of it from the environment
   (`HOSTED_PLAN_CAPACITY`, JSON keyed by plan, as
   `ALWAYS_ON_PLAN_CAPACITY` is).
3. An organization may tighten its own in its settings, never loosen them.

The table lives outside the entitlement token, as `billing.constants.ts`
already says hosted caps should, and reaches `src` through a provider
interface that `ee` fills (the same seam as `OrgLicenseResolver`). Without
`ee`, capacity is unlimited; on a Stripe-backed plan it fails closed.

### Tiers, as the specs say

| Plan | Hosted runners (spec 1) | Always on (spec 2) |
|---|---|---|
| **Free** | Self-hosted runners only. `runner` stays a community entitlement and is never gated. No hosted environments. | Included. Runs on your own runner, or with no machine at all. |
| **Pro** | Hosted environments, private to their owner; included runner-hours plus metered overage. | 3 always-on agents included by default (a seeded setting, Decision 5), at home on a hosted environment or on your own runner. Runtime counts toward runner-minutes. |
| **Business** | Adds shared environments (team and org visibility), approvals on environment use, and repo-event triggers. | Adds specialist agents that act as themselves (`agent_identity`, shipped; Decision 11). |
| **Enterprise** | The same pool in their own cluster (an org-owned `kubernetes` connection on the environment). | The same, in their cluster. |

Entitlement keys for Business and Enterprise: `agent_identity` already
exists (#927); `hosted_shared_environments` is new and goes into
`EE_ENTITLEMENTS`, `PLAN_ENTITLEMENTS`, `frontend/src/lib/plan-catalog.ts` and
[enterprise.md](../enterprise.md) together; the existing parity test catches a
miss. Capacity numbers are not entitlements and stay out of the token.

Gating `team`/`org` visibility on environments is the first place visibility
itself is plan-gated; everywhere else it is community. Decided (Decision 4):
Pro is private only, and the gate sits on the visibility write only.

## Security and abuse limits

**Isolation.** gVisor per pod, never plain runc (Decision 2), on a
dedicated runner cluster that runs nothing else of ours. Non-root,
read-only root, no capabilities, no service-account token, one workspace
per pod. One organization's pods never share a namespace with another's. A
volume belongs to one workspace. Inside the sandbox the pod sees gVisor's
kernel, not the node's (tested: `4.19.0-gvisor`, an empty `/sys/module`, no
host `dmesg`).

**Sandbox runtime.** The `gvisor` RuntimeClass schedules only onto nodes
labelled `almyty.com/gvisor=ready`, and only the installer DaemonSet sets
that label, after `runsc do` has booted a sandbox on that node. The label is
never part of the node-pool spec, so a fresh node cannot claim readiness
before gVisor exists. The installer pins the gVisor release and its sha512,
installs `gvisor-bin/` next to `runsc`, picks the containerd config table
from the config's `version`, appends to the config only when its marker is
missing and never rewrites the config of a live node (doing so kills the
sandboxes running on it). The installer is privileged on the node; it is
cluster plumbing we ship, never anything a customer can configure.

**Network.** Default deny, ingress and egress. Out only to DNS, the API
ingress, and the environment's allowlist; nothing inbound. The allowlist is
a Cilium policy with both `toFQDNs` and TLS SNI rules (`serverNames`), on
port 443 only. FQDN rules alone allow by resolved IP, and on shared CDN IPs
that opens hosts nobody listed (tested: `registry.yarnpkg.com` was reachable
with only `registry.npmjs.org` allowed, until SNI rules were added). Plain
HTTP, raw IPs, other namespaces, the Kubernetes API and cloud metadata are
unreachable (metadata already is on DigitalOcean nodes, policy or not).

**Credentials.** The enrollment token is single-use and lives 10 minutes; the
runner credential is scoped to one runner and the runner surface; user
tokens never enter a pod. Environment secrets resolve through grants at pod
start (audited) into the pod's Secret, which is deleted at scale to zero and
rewritten at wake, so a secret rotated in the store reaches the next wake.
Model keys stay in the store (Decision 6): coding CLIs call almyty's model
pass-through with a pod model token, and a vendor key is injected only for
a CLI that cannot use almyty's endpoints (Gemini CLI), on an environment
that allows it (`allowVendorKeys`, off by default). As built, the token is
minted by the reconcile loop at every pod start (sha256 only in
`hosted_model_tokens`), lives an hour and is renewed by the runner with
itself while the pod runs, sits in the pod's Secret as
`ALMYTY_MODEL_TOKEN`, is served to the CLIs by the runner's loopback proxy
(the CLIs hold a placeholder), and is revoked when the pod stops or its
owner leaves. The pass-through forwards to organization-wide providers,
and to the owner's private ones only through their explicit one-click grant
(`hostedPodAccess`).

**Abuse.** Hosted runners are paid-only, so every org that has one has a
card on file. On top of that:

- A ResourceQuota per org namespace; CPU and memory limits per pod;
  ephemeral-storage and volume size caps.
- A concurrency cap per org from plan capacity, and a monthly ceiling the
  owner sets (a spend budget on runner-minutes; its default is a plan
  setting, seeded at three times the included hours), past which wakes are
  refused with `CAPACITY_EXHAUSTED`.
- Sustained-CPU detection: a pod at its CPU limit for more than 30 minutes
  with no dispatch is suspended and the owner told (the shape of mining).
- An egress bandwidth limit per pod (Cilium's bandwidth manager, to be
  verified on the runner cluster) and per-pod flow totals from Hubble for the
  abuse alert.
- Always on: the timer floor, `maxWakesPerHour`, the loop guard, single
  flight per agent, and the agent's real run limits on every wake.
- Any-device access: watching or steering a coding session needs exactly the
  access that dispatching to that runner needs (`getUsable`), no more.

**Audit.** New actions: `environment.created/updated/deleted`;
`hosted_runner.provisioned/woken/suspended/torn_down/failed`;
`runner.enrolled`; `workspace.suspended/resumed`;
`always_on.enabled/disabled/paused`; `agent.wake_dropped`. The connections
layer already audits every secret resolve.

## gVisor on DigitalOcean: test results

**Verdict: gVisor on a dedicated DigitalOcean Kubernetes cluster is viable.**
Tested on 2026-10-08 on a throwaway cluster (fra1, Kubernetes 1.35.7-do.5,
upgraded to 1.36.3-do.5 during the test, deleted after about 1h20m with
nothing left behind). Every check passed and no fallback trigger fired. The
existing clusters were never touched.

**What the cluster looked like.**

- Two node pools. `sys`, one untainted small node: CoreDNS, Hubble and the
  other system pods do not tolerate the sandbox taint, so a cluster made only
  of tainted gVisor nodes has no DNS. `gvisor`, the runner pool, labelled
  `almyty.com/sandbox=gvisor` and tainted
  `almyty.com/sandbox=gvisor:NoSchedule`.
- Nodes: Debian 13, kernel 6.12. On 1.35, containerd 1.7.29 with config
  `version = 2`; on 1.36, containerd 2.2.3 with config `version = 3`, where
  the CRI runtime table moved to `plugins.'io.containerd.cri.v1.runtime'`.
- Cilium 1.19.3 with the L7 proxy on (needed for FQDN and SNI rules) and
  Hubble. gVisor ran on its default platform (systrap); no KVM needed.

**How gVisor gets onto the nodes.** DigitalOcean does not offer gVisor, so a
DaemonSet installs it. The tested manifests are kept as references in
[hosted-runners/](hosted-runners/):

- [`gvisor-installer.yaml`](hosted-runners/gvisor-installer.yaml): the
  `gvisor-system` namespace, a ServiceAccount that may only get and patch
  nodes, the install script, the DaemonSet (privileged, host PID, the host's
  `/` mounted, only on `almyty.com/sandbox=gvisor` nodes) and the `gvisor`
  RuntimeClass. Every 60 seconds the script checks that `runsc`, the
  containerd shim, `gvisor-bin/gvisor_sentry`, a release stamp and its
  marker in the containerd config are all there. If not, it removes the
  ready label, downloads the pinned release, checks its sha512, installs it,
  and appends the `runsc` runtime table at the path the config's `version`
  calls for. If containerd started before the config last changed, it
  removes the label and restarts containerd. Then it boots a sandbox with
  `runsc --network=none do dmesg`, and only if that prints "Starting gVisor"
  does it set `almyty.com/gvisor=ready` (re-asserted every loop). The
  RuntimeClass schedules onto `almyty.com/gvisor=ready` nodes and tolerates
  the sandbox taint, so a pod needs nothing but `runtimeClassName: gvisor`.
- [`runner-egress-sni.yaml`](hosted-runners/runner-egress-sni.yaml): a
  default-deny NetworkPolicy for the runner namespace and a
  CiliumNetworkPolicy that allows DNS to kube-dns and port 443 to the listed
  hosts, by both `toFQDNs` and TLS SNI (`serverNames`).
- [`runner-deployment.yaml`](hosted-runners/runner-deployment.yaml): the
  runner-shaped test workload, a Deployment under `runtimeClassName:
  gvisor`. It is the tested shape, not the production pod spec (that adds
  the security context, volume and limits from
  [Kubernetes objects and sandboxing](#kubernetes-objects-and-sandboxing)).

**The checks.**

| # | Check | Result |
|---|---|---|
| 1 | Isolation: a gVisor pod and a runc pod on one node | Pass. gVisor saw kernel `4.19.0-gvisor`, "Starting gVisor..." in `dmesg`, an empty `/sys/module`, CPU model unknown. runc saw the host kernel and 208 modules |
| 2 | Runner-shaped workload (node 22, git, npm, outbound HTTPS) | Pass. `git clone` from github.com, `npm i -g`, `curl` to an allowed site; repeated on the replaced and the upgraded node |
| 3 | Default deny and an allowlist for gVisor pods | Pass, with the SNI finding below. With policy: other sites, raw IPs, other namespaces' services, the Kubernetes API and inbound traffic all blocked (Hubble: `Policy denied DROPPED`). Cloud metadata (169.254.169.254) was unreachable from every pod even without policy |
| 4 | Scheduling only onto ready nodes | Pass. A pod without the RuntimeClass went to the system node; with the ready label removed a gVisor pod stayed Pending, and ran about 15 seconds after the label came back |
| 5 | containerd restart (1.7 and 2.2) | Pass. The running sandbox survived with 0 restarts and kept its egress |
| 5b | Self-heal after the config and `runsc` were wiped | Pass. The installer noticed within a minute and was ready 2 minutes later. The running sandbox died and was recreated: rewriting the config and restarting containerd kills live sandboxes |
| 6 | Node replace | Pass. The new node got the pool's taint and label, stayed unlabelled until the installer was ready, and the runner landed there. About 5.5 minutes without a runner on a one-node pool (install about 2 minutes: 50 s download, 60 s extract) |
| 7 | Upgrade 1.35.7 to 1.36.3 (containerd 1.7 to 2.2, config v2 to v3) | Pass. The installer on the new node wrote the v3 table. About 2.5 minutes without a runner; all checks passed again afterwards |

**Findings that change the design.** Each is folded into the sections above
([Kubernetes objects and sandboxing](#kubernetes-objects-and-sandboxing),
[Security and abuse limits](#security-and-abuse-limits)).

1. **The egress allowlist must use TLS SNI rules.** Cilium's `toFQDNs`
   allows by resolved IP. `registry.yarnpkg.com` shares Cloudflare IPs with
   `registry.npmjs.org` and was reachable with only npm allowed. Adding
   `serverNames` on the 443 rule blocked it while npm, git and the other
   allowed hosts kept working.
2. **The installer alone owns the ready label.** It sets it after a
   successful probe, removes it on any failure, and re-asserts it every
   loop. `almyty.com/gvisor=ready` must never be in the node-pool spec, or a
   new node claims readiness before gVisor exists. The pool spec carries only
   `almyty.com/sandbox=gvisor` and the taint.
3. **At least two gVisor nodes, and an untainted system pool.** One gVisor
   node means minutes without runners on every replace and upgrade; the
   system pool is what keeps DNS alive.
4. **Newer gVisor releases need `gvisor-bin/` next to `runsc`.** Since
   2026-09 a release ships sidecar binaries (`gvisor_sentry` and others)
   that must sit in `/usr/local/bin/gvisor-bin/`; without them every sandbox
   fails under the strict sidecar policy. Releases come only as tarballs, so
   the installer downloads one archive and checks its checksum.
5. **containerd config v2 or v3 is detected, never assumed.** The table path
   changed between Kubernetes 1.35 and 1.36 on DigitalOcean.
6. **Never rewrite the containerd config on a live node.** Append only when
   the marker is missing. A rewrite plus restart kills every sandbox on the
   node; a plain restart does not.
7. **Runners run as a Deployment or Job, never as bare pods.** Node drains on
   replace and upgrade delete bare pods; a controller reschedules them.
8. **`ctr run` is not a valid health check.** `ctr run --runtime
   io.containerd.runsc.v1` exits 128 silently on these nodes while the same
   runtime works through the kubelet. The probe is `runsc do` plus "did
   containerd start after the config last changed".

**Before production.** Bake the gVisor binaries into the installer image
(install time from about 2 minutes to seconds); run two or more gVisor nodes
or the autoscaler with headroom; add a PodDisruptionBudget to runner
Deployments (untested here; drains respect it up to a timeout); bump the
pinned release and checksum on purpose, with the staging smoke.

## Failure modes

| What fails | What the user sees | What the system does |
|---|---|---|
| Cluster API unreachable | The workspace stays "waking"; after 3 minutes the tool call fails `workspace_unavailable` | The loop retries; three read failures mark the row `failed`, audited; the owner is notified |
| Pod crashes | The running command fails; the agent sees a tool error | The Deployment restarts it; the runner enrolls again with a new token; the workspace stays `active`; the volume is intact |
| Node lost | As a crash, slower | Pod rescheduled; the RWO volume detaches and reattaches (minutes on block storage); same-zone constraint |
| Volume lost or corrupt | The workspace page says so | Workspace `released` with the reason; a fresh one on next use; never silently recreated over a damaged one |
| API pod dies mid-provision | Nothing | The claim lease expires; another pod takes the row |
| Orphaned pod or volume | Nothing | Torn down after 30 minutes' grace, audited |
| Enrollment token expired before the pod started | A slower wake | A new token on the next tick |
| Redis down | Coding output only on the receiving pod; wakes delayed | Transport and relay fall back to pod-local; queued jobs resume when Redis returns; timers restored at boot |
| Stripe down | Nothing | The meter report retries; identifiers make it idempotent |
| Capacity exhausted | Wake refused; agent paused with `CAPACITY_EXHAUSTED`; owner notified | No pod started |
| An always-on run hits a limit | The run ends with the limit's sentence; the report says so | The next wake starts a new run on the same thread |
| An approval is never answered | The agent waits; wakes queue | The existing approval expiry applies; the queue is capped at 100 wakes, oldest coalesced |
| Wake storm (webhook flood) | Wakes coalesce into one message | Dedupe keys, `maxWakesPerHour`, the `WAKE_LOOP` pause |
| The owner leaves the team or the org | Agent paused with `OWNER_CANNOT_RUN` or `OWNER_NOT_MEMBER` | As for heartbeats today. Leaving the org: their environments go to the longest-standing owner (else admin), their own hosted workspaces stop at once and keep their files, their pod model tokens are revoked. A deleted team's shared environments become private to their owner |
| A gVisor node is replaced, upgraded or autoscaled | Runners on it go Pending for a few minutes (2.5 to 5.5 minutes measured on a one-node pool); a wake waits | The installer DaemonSet reinstalls gVisor on the new node and only then labels it ready; the Deployment reschedules the pod there. Two or more gVisor nodes and a PodDisruptionBudget keep this out of sight |
| The gVisor install fails on a node (bad download, checksum mismatch, containerd config schema it does not know) | Nothing, if other gVisor nodes are ready; otherwise wakes wait | The installer removes the ready label and retries every minute; sandboxed pods never land there; the missing-label alert fires |
| The org's plan lapses | Hosted workspaces suspended; always-on agents with a hosted home, or acting as themselves, paused; owner notified | No new pods; volumes kept for the retention window; turning the plan back on resumes |

## Observability

- **Metrics** (monitoring module): hosted runners by state; wake latency
  (desired 1 to runner online), p50 and p95; provision failures by reason;
  orphans torn down; open usage intervals; metered minutes against observed
  pod minutes (the drift should be zero); wake queue depth and coalesced
  wakes per agent; always-on runs per hour; approvals waiting.
- **Logs** carry `hostedRunnerId`, `workspaceId`, `environmentId`, `agentId`
  and `runId` through the correlation scope.
- **UI.** The environment page shows each workspace's state and why it last
  changed (the `lastError`/`closeReason` pattern). The agent page shows
  Always on's last wake, what caused it, the next timer and any pause reason
  (`pause-reason-banner.tsx`).
- **Alerts**: provision failure rate, orphan count, metering drift, a spike
  in egress policy drops per org (Hubble flow logs, `Policy denied`), and a
  gVisor node that has been up for more than 5 minutes without the
  `almyty.com/gvisor=ready` label (the installer is failing on it).

## Rollout

Four phases. Each is a PR stack against `development` that ends with the
pre-push checks (including `build:ee` and `ee-di-smoke`) and the repo guard
suites. Nothing reaches production before Frane signs off its phase.

### Phase 1: always on, on machines people already have

Spec 2 items 1, 2 and 4 plus reporting, for self-hosted runners and for
agents with no machine (Decision 12). It was also meant to ship the
cross-pod coding relay, which is a live bug today.

- Heartbeat renamed Always on (column, card, endpoint, job, docs).
- Timers restored at boot; `maxSteps: 10` gone; real limits.
- Standing thread with forced compaction; single flight; `agent_wakes`.
- Wake sources: timer, Webhook channels, channel messages, manual.
- `tool_call` approval trigger, `propose` and `act`; reporting through
  `ScheduledPostService` and the two notification types.
- Redis-backed coding relay with `Last-Event-ID` replay.

Acceptance:

- An always-on agent woken by its timer, then a webhook, then a Slack message
  answers all three in one conversation whose history shows them in order.
- A wake that arrives during a live run is delivered into that run, not into
  a second run.
- A tool on the "ask first" list pauses the run; approving it on the approval
  page runs it once; the report lands in the chosen channel.
- With two API replicas, a coding session's output reaches a viewer on either
  pod, and a viewer who joins late gets the backlog.
- No regressions in schedules, migrated heartbeat agents or channels.

#### Phase 1 status on development

Checked against `origin/development` on 2026-10-08. Always on merged in #930
and agent identity in #927. The user-facing description is
[always-on.md](../always-on.md). Paths are under `backend/src/` unless they
start with `frontend/`.

| Item | Status | Where |
|---|---|---|
| Heartbeat renamed Always on: column | done | `migrations/1750813802000-AlwaysOn.ts` renames `agents.heartbeat` to `agents.alwaysOn` and reshapes it; existing heartbeats keep acting on their own (`actMode: 'act'`) |
| ... card and page | done | `frontend/src/components/agents/detail/always-on-card.tsx`, `frontend/src/pages/agent-always-on.tsx`, `frontend/src/components/agents/builder/autonomous-config.tsx` |
| ... endpoint | done | `modules/agents/always-on/always-on.controller.ts`: `GET`/`PATCH /agents/:id/always-on`, `POST .../wake`, `GET .../wakes` |
| ... job | done | `ALWAYS_ON_TICK_JOB` and `ALWAYS_ON_WAKE_JOB` in `modules/agents/agent-runtime.processor.ts`; a leftover `heartbeat` job fires as a tick (`handleLegacyHeartbeat`) |
| ... docs | done | `docs/always-on.md`, plus the docs site |
| Timers restored at boot | done | `AlwaysOnService.onModuleInit` calls `restoreTimers`; an agent whose timer cannot be restored is paused and says why |
| `maxSteps: 10` gone, real limits | done | `startRun(..., { agentLimits: true })` in `AlwaysOnService.process`; `always-on/__tests__/always-on-wiring.guard.spec.ts` keeps the literal out |
| Standing thread | done | `alwaysOn.standingConversationId`, set on the first wake; a swept conversation starts a new one |
| Forced compaction | done | `modules/agents/agent-step-processor.ts` turns compaction on for `triggerType: 'always_on'` |
| Single flight | done | Redis lock `always-on:lock:<agentId>` and `alwaysOn.liveRunId`; wakes during a live run are handed to it by `drainInto`, called from the step processor |
| `agent_wakes` | done | `entities/agent-wake.entity.ts`; unique per `(agentId, dedupeKey)` |
| Wake source: timer | done | `AlwaysOnService.tick` |
| Wake source: Webhook channels | done | `AlwaysOnService.routeInbound`, called from `gateways/channels/channel-gateway.service.ts`. As built, Webhook channels are listed in `wakeOn.channelIds`; there is no separate `webhookChannelIds` |
| Wake source: channel messages | done, per Decision 1 | `routeInbound`: the owner's own address on `alwaysOn.ownerChannel` joins the thread; others keep their chats and the agent gets one line, which waits for the next timer when one is set. Email counts as the owner only with `trustEmail` |
| Wake source: manual | done | `AlwaysOnService.wakeNow`, `POST /agents/:id/always-on/wake` |
| Wake source: connection events (planned for phase 3) | done early, partly | `modules/connections/connection-events.ts`; published only from `ee/modules/connections-governance/connections-governance.service.ts` (`notifyOwners`), where the `connections.*` notifications are made. Events are `expiring`, `expired`, `rotation_due`; `inactive` is not wired |
| Loop guard, `maxWakesPerHour`, `WAKE_LOOP` | done | own-bot messages dropped in `routeInbound`; the hourly cap in `process`; numbers from `always-on/always-on-capacity.ts` (plan catalog, `ALWAYS_ON_PLAN_CAPACITY`, org settings) |
| `tool_call` approval trigger, `propose` and `act` | done, different shape | not a stored `ApprovalToolCallTrigger`: `asksFirst` and `askFirstHit` in `modules/tools/tool-approval-gate.service.ts` read the agent's `alwaysOn`. `propose` asks before every tool that is not read-only (`sideEffect !== 'read'`); `act` asks before `askFirstToolIds`. Amount rules apply in both |
| Reporting through the scheduled-post path | done | `AlwaysOnService.onRunFinished` posts through `ScheduledResultPoster` (`modules/agents/scheduled-result-poster.ts`) to `reportTo` and to the owner's channel |
| Notification types `agent.report`, `agent.paused` | done | `modules/notifications/notification-types.ts`; report email off by default, pause email on |
| `report: 'daily_digest'` | open | only `every_wake` and `when_acted` exist (`always-on.types.ts`) |
| `CAPACITY_EXHAUSTED` pause | open (reserved) | declared in `entities/agent.entity.ts`, raised nowhere; it belongs to hosted capacity |
| Redis-backed coding relay with `Last-Event-ID` replay | **open** | `modules/runner/coding-relay.service.ts` still relays pod-locally (its multi-replica note says so). The `Last-Event-ID` ring buffer in `modules/runner/transport/worker-stream.transport.ts` replays a runner session's own stream on one pod; it does not carry `coding.*` events across pods. With 2 API replicas the bug in the recon table is still live |
| Agent identity (planned for phase 4) | done early | `modules/agents/agent-identity.ts`, `agent-identity-reach.ts`; `kind: 'agent'` in `common/authorization/execution-access.service.ts`; entitlement `agent_identity` in `frontend/src/lib/plan-catalog.ts` and `docs/enterprise.md`. A lapsed plan pauses the agent with `IDENTITY_LAPSED` and tells the owner; it never falls back to running as the owner. Always-on wakes run as the agent when it acts as itself |

Acceptance, against the list above: one thread across wakes, a wake joining
a live run, and reporting are unit-tested with a harness
(`always-on/__tests__/always-on.service.spec.ts` and its siblings), not yet
run end to end against live channels. The two-replica coding check fails
until the relay lands. The relay is the one phase-1 item to finish before
phase 2.

### Phase 2: hosted environments, staging only

Spec 1 items 1 to 3, behind `HOSTED_RUNNERS_ENABLED`, on staging, platform
pool only.

- `environments`, `hosted_runners`, enrollment, the runner `kind` and partial
  unique index, workspace `kind` and `suspended`.
- `kubernetes` and `stub` adapters; the reconcile loop; per-org namespaces,
  quota, the default-deny NetworkPolicy and the per-environment Cilium SNI
  egress policy; the runner cluster with its system pool and gVisor pool, the
  gVisor installer DaemonSet and the `gvisor` RuntimeClass.
- `runner-env` images; `almyty-runner --enroll`.
- The environments page; `env.<name>.*` tools; `agentConfig.environmentId`.

Acceptance:

- Create an environment for a repo and run an agent against it: a pod comes
  up under gVisor, clones, runs setup and does the work.
- Leave it idle past the timeout: the pod goes, the workspace reads
  "suspended", the runner does not strand.
- Call it again: a new pod mounts the same volume, the earlier edits are
  there, and the p50 cold wake is under 30 seconds.
- From inside the pod, the metadata IP, the cluster service CIDR, another
  org's namespace, a host off the allowlist and a host off the allowlist on
  the same CDN IPs as an allowed one are unreachable; a host on the
  allowlist is reachable.
- No user token appears in any pod spec, Secret or log (asserted).

### Phase 3: metering, tiers, production

Spec 1 item 5 and spec 2 items 3 and 5.

- `runner_usage_intervals`, the hourly Stripe meter report, metered prices,
  the capacity service and `PLAN_HOSTED_CAPACITY`, a usage page.
- Always on with a hosted home (`alwaysOn.home.environmentId`, the persistent
  agent workspace); always-on runtime metered.
- Connection-event wakes. Shipped early with phase 1 for the events the
  credentials governance module raises; see Phase 1 status.
- Production rollout for Pro.

Acceptance:

- One hour of a running pod produces exactly one meter event per class with
  the right quantity, idempotent under retry (stripe-mock integration).
- Included hours cost nothing on the invoice preview; overage is billed.
- A Free org cannot create an environment, and can still register and use a
  self-hosted runner and make an agent always on.
- An always-on agent with a hosted home writes a file on Monday and reads it
  on Tuesday's wake.

### Phase 4: Business and Enterprise

- Shared environments (`hosted_shared_environments`), approvals on
  environment use, repo-event triggers.
- Specialist agents with their own identities (`agent_identity`). Shipped
  ahead of this phase; see Phase 1 status.
- Enterprise: environments on an org-owned `kubernetes` connection; contract
  metering without Stripe.
- Golden-volume snapshots per environment version; optionally a warm pool.

Acceptance: a Business team shares one environment and each member's
workspace is separate; an agent running as itself resolves only the
connections granted to it; an Enterprise environment provisions into the
customer's cluster with no platform credentials involved.

## Test plan

Every unit gets a test that proves a real entry point reaches it (the
"unwired units" rule): a wake source with no caller, or an adapter no
processor calls, fails a guard spec.

**Backend unit (jest)**

- The adapter conformance suite in `hosted-runners/__tests__/conformance/`,
  run against `stub`, and against `kubernetes` with a fake API server.
- The reconcile processor: every row of the desired/actual table; the claim
  lease; the orphan grace; three strikes to `failed`; only the processor
  writes observed columns (a guard spec, as in model-deployments).
- Workspace transitions: `active <-> suspended`; terminal states stay
  terminal; persistent workspaces never strand and run end never releases
  them.
- Enrollment: single use, expiry, the runner credential refused off the
  runner surface.
- Capacity: fails closed; unlimited without `ee`.
- Always on: wake dedupe, coalescing into a live run, single flight, the loop
  guard, `maxWakesPerHour`, real limits (a guard against the `maxSteps: 10`
  literal), timers restored at boot, access judged at fire time.
- The `tool_call` trigger in `tool-approval-gate.service.ts`, in both modes,
  with amount rules still applying.
- Metering: intervals opened and closed from observations; hourly
  aggregation; stable identifiers.

**Guard specs (source-reading)**

- Hosted adapters do not import each other.
- No secret column in the new entities (`no-secrets-outside-credentials`).
- Every `AlwaysOnService.wake` source has a caller.
- `markStrandedForRunners` filters to `kind = 'self'`.
- `outbound-transport-inventory.guard.spec.ts` lists the Kubernetes client.
- Entitlement parity across `billing.constants.ts`, `plan-catalog.ts` and
  `docs/enterprise.md`.

**Integration (`RUN_DB_INTEGRATION=1`)**

- The partial unique index on runners: a second `self` runner refused, many
  `hosted` ones accepted.
- Persistent workspace uniqueness per (environment, owner, agent).
- The cross-pod coding relay: two transport instances on one Redis, an event
  in on one and out of the other, replay by `Last-Event-ID`.
- Stripe meter events against `stripe-mock` (`STRIPE_API_BASE`).

**Cluster (a local kind cluster and staging)**

- kind with runc for the reconcile path end to end in CI (gVisor does not run
  in kind; runc there is for testing our code, never for customer code); a
  staging smoke under gVisor before each release, each Kubernetes upgrade
  and each gVisor release bump. The smoke repeats the checks in the test
  results above: kernel isolation, the runner-shaped workload, the network
  policy, scheduling only onto ready nodes, a containerd restart, a node
  replace.
- Network tests from inside a pod: metadata IP, cluster CIDR, another
  namespace, a host off the allowlist, a host on it, and a host off the
  allowlist that shares CDN IPs with one on it (`registry.yarnpkg.com`
  next to an allowed `registry.npmjs.org`), which must be blocked.
- The installer: on a node without gVisor the ready label is absent and a
  sandboxed pod stays Pending; after install it runs; a config that already
  carries the marker is never rewritten.
- Suspend and resume keep files; a pod killed mid-command recovers.

**Frontend**

- vitest for the Always on card, the environment page and the usage page;
  the `localStorage` token regression tests still pass.
- Playwright: create an environment, run an agent, watch the session from a
  second browser context, suspend, resume.

## Risks

- **Sandboxed runtime upkeep.** gVisor on DigitalOcean's managed Kubernetes
  works (tested, see the results above), but it is installed by us, not by
  the provider. Every node replace, autoscale and upgrade reinstalls it, the
  containerd config schema can change between Kubernetes minors (it did, v2
  to v3), and gVisor's release layout can change (it did, `gvisor-bin/`).
  Mitigations: the installer owns the ready label, so a node that is not
  ready never takes a sandboxed pod; the release and checksum are pinned and
  bumped on purpose; a staging smoke under gVisor before each Kubernetes
  upgrade and each gVisor bump.
- **Upgrade and replace gaps.** On a one-node gVisor pool a replace took
  about 5.5 minutes and an upgrade about 2.5 minutes before a runner ran
  again. Mitigations: at least two gVisor nodes or the autoscaler with
  headroom, a PodDisruptionBudget on runner Deployments, binaries baked into
  the installer image (install drops from about 2 minutes to seconds).
- **Domain fronting through shared CDN IPs.** SNI rules close the leak that
  FQDN-by-IP rules leave open, but a client that sends an allowed SNI and a
  different HTTP `Host` header may still reach another site on the same
  CDN. The allowlist narrows egress; it is not a full content filter.
- **Cold-start latency.** Large images and block-volume attach can push a
  wake past a minute. Mitigations: pre-pulled images, small base images, the
  volume in the node's zone, a warm pool later.
- **Cost of idle volumes.** Every suspended workspace keeps a volume.
  Mitigations: the 30-day retention window (Decision 8), volume size caps, a
  storage line on the usage page.
- **Coding CLIs and their terms.** Running a vendor's CLI in a hosted pod on
  a user's personal subscription login may not be allowed by that vendor, so
  it is not offered; CLIs go through almyty's compatible endpoints with the
  org's own keys (Decision 6).
- **Context growth.** A standing thread that lives for months depends on
  compaction; a compaction bug becomes a cost bug. Mitigations: forced
  compaction (shipped), a hard context cap, the run's cost limit.
- **Runaway always-on cost.** Every wake is a model call on the user's keys.
  Mitigations: wake limits, real run limits, budgets, the loop guard, and
  reports that show the cost of each wake.
- **Plan-gated visibility.** Shared environments break a pattern held
  everywhere else, and it is easy to get wrong in list filters. Mitigation:
  the gate on the visibility write only, plus a test.

## Decisions

Frane decided all fifteen on 2026-10-08. The rest of this doc follows them.

1. **Which conversation a channel message joins: (b).** Visitors keep their
   own chats, as today. Only the owner's own channel (their Slack DM, their
   address on a channel they named) feeds the standing thread; messages from
   anyone else reach the agent as a one-line wake summary, never their words.
   Mixing strangers into the thread the agent reasons in would leak one
   visitor's messages into another's answers.
2. **Where the runner pool runs: a separate DigitalOcean Kubernetes cluster
   with gVisor.** Tested viable on 2026-10-08; see
   [gVisor on DigitalOcean: test results](#gvisor-on-digitalocean-test-results).
   Customer code never runs on plain runc, not even for a trial.
3. **Idle timeout and what is metered.** 15 minutes by default, adjustable
   from 5 to 120 per environment. Pod-running minutes are metered, including
   the idle tail before the timeout, because that is the cost we pay, and
   the usage page says so plainly.
4. **Visibility of environments: (a).** Pro environments are private to
   their owner; team and org sharing is a Business feature, gated on the
   visibility write only.
5. **Capacity numbers are configuration, never code.** The starting numbers
   (Pro 3 always-on agents and 40 small-class runner-hours per seat per
   month, overage by the minute; Free unlimited always-on agents with a
   15-minute timer floor and 6 wakes an hour; a 5-minute floor on paid
   plans) are seeded defaults only. Every number lives in plan and settings
   data: the plan catalog seeds a row, the install overrides it from the
   environment, an organization may tighten its own. No number is a constant
   in the code that uses it ("make configurable, don't hardcode"). Always on
   already works this way (`always-on-capacity.ts`, `ALWAYS_ON_PLAN_CAPACITY`,
   `organizations.settings.alwaysOn`); hosted capacity follows the same
   shape.
6. **Model keys for coding CLIs in hosted pods.** (a) By default CLIs call
   almyty's Anthropic- and OpenAI-compatible endpoints with a pod-scoped
   token, so keys stay in the store and every call is routed, budgeted and
   attributed. (b) The vendor key is injected from the store only for a CLI
   that cannot change its base URL. (c) Logging in to a personal CLI
   subscription inside a pod is not offered.
7. **Automatic review: (a) now, a reviewer later.** Phase 1 ships propose
   and act with amount rules and the ask-first list. A later automatic
   reviewer may only escalate a proposed action to a person; it never
   approves anything.
8. **Volume retention.** A suspended workspace keeps its volume for 30 days
   untouched, gets a notice at day 23, then is `expired` and deleted. An
   always-on agent's home workspace is exempt while the agent is on.
9. **Images.** Curated images plus a setup script. Custom images come later
   as a Business option, digest-pinned and scanned on import.
10. **Where environments live in the UI: (a).** A "Hosted" tab on `/runners`
    next to the machines people registered; the sidebar does not change.
11. **Agents with their own identities: (a).** The agent runs as itself: an
    `agent` kind of `ExecutionPrincipal`, its own connection grants, its own
    audit actor, under the `agent_identity` entitlement. Shipped; see
    [Phase 1 status](#phase-1-status-on-development).
12. **Always on before hosted runners: yes.** Always on shipped first and is
    merged (#930).
13. **Schedule and Always on: (a).** Both stay, separate, with one line on
    the card saying how they differ (shipped: `ALWAYS_ON_VS_SCHEDULE` in
    `frontend/src/lib/always-on.ts`).
14. **Repo events: (a).** Through a Webhook channel first, pointed at the
    repository host; a dedicated connector only when someone asks.
15. **Open-core line: (a).** The provisioner, adapters and usage records live
    in `backend/src` (Apache), so a self-hosting user can run hosted runners
    in their own cluster. Only Stripe reporting and plan capacity live in
    `ee`.

Also decided:

- **Owner email.** Email to the owner is an option for always-on reports,
  off by default, with a hint that explains it. Mail from the owner's address
  counts as the owner only when they turn that on (`ownerChannel.trustEmail`),
  because an email sender can be faked.
- **Plan lapse.** When a plan lapses, what it paid for pauses and the owner
  is notified. Nothing quietly falls back to running as someone else.
- **Model providers.** Unattended and hosted work uses the organization's
  org-wide model providers only. The owner's private provider reaches it
  only through an explicit one-click grant.

Decided after the phase 2 merge (Frane, 2026-10-08), and built:

- **The owner leaves.** Every environment the departing person owns goes to
  one organization admin, chosen the same way every time: the
  longest-standing owner, else the longest-standing admin. Audited; the
  files are kept. Their own workspaces have their pod stopped at once (its
  Secret holds their connections and their model token) and move to the
  same person. Where that person already has one on the environment they
  keep both: the departed member's read-only (its volume mounted
  read-only, used only by a call that names it), to copy from or delete,
  with the normal suspended retention and the day-23 notice to them.
- **A team is deleted.** An environment shared with it keeps its owner and
  becomes private; the owner is told in plain words and can share it again.
- **Usage records** are kept 13 months after they close, a retention class
  (`runnerUsageDays`) an organization can set, with the 13 months as the
  install default (`usageRetention.months`); an open interval is never
  deleted. Pods' model calls are kept the same way.
- **One folder per person per environment.** The two-folders idea under
  "Persistent workspaces" is replaced: a person's jobs on an environment
  share one `/workspace` and run one after another (a job holds the
  workspace while it runs; others wait, then sleep and retry).
- **Decision 6, built.** A pod model token, minted at every pod start with
  only its hash stored, an hour long (`modelAccess.tokenTtlMinutes`) and
  renewed by the runner with itself while the pod runs; it dies when the
  pod stops, fails or is torn down. It is bound to the hosted runner (so
  workspace, environment and organization) and acts as the workspace's
  owner. It lives in the pod's Secret as `ALMYTY_MODEL_TOKEN`, which the
  runner takes out of its environment and serves to the CLIs through a
  loopback model proxy, so the CLIs hold only a placeholder key and keep
  working across renewals. What it reaches is the **model pass-through**:
  the CLI's own request (tools, stream, thinking) forwarded to an
  organization-wide provider of the catalog, never the owner's private or
  a team provider, on `/v1/messages`, `/v1/chat/completions` and
  `/v1/responses` (Codex), budgeted against the organization's budgets,
  recorded as spend (`hosted_model_calls`), audited (`model_routed`,
  `hosted_model_call`) and attributed on the response. An API key on the
  first two still runs an agent; the pass-through takes a pod token only.
  Vendor keys are an opt-in per environment (`allowVendorKeys`), off by
  default; Gemini CLI needs one, since no almyty endpoint speaks its API.
  The owner's private provider reaches pods only through their explicit
  one-click grant (`hostedPodAccess` on the provider, owner-only).