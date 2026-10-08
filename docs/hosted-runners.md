# Hosted runners

A hosted runner is a machine almyty starts for you, instead of one you run
yourself. You describe an **environment** once: which repository, which
image, a setup script, which connections become environment variables, and
which websites it may reach. When an agent needs it, almyty starts a pod for
it, and when nobody has used it for a while, the pod goes away. The files
stay on a volume, so the next time it starts, the work is where it was left.

This page is the developer reference: what to switch on, what the cluster
needs, and every setting. The design is
`docs/design/hosted-runners-and-always-on.md`.

Status: phase 2, behind a switch, for staging. There is no page in the app
yet, the runner images are not built yet, and nothing is billed yet (usage is
recorded).

## In short

- Off unless `HOSTED_RUNNERS_ENABLED=true`.
- Pods run on a separate Kubernetes cluster whose sandbox nodes run gVisor.
  No customer pod ever runs on plain runc.
- Every person gets their own workspace on an environment. It is suspended
  after its idle timeout (15 minutes by default, 5 to 120), kept for 30 days
  while suspended, with a notice on day 23, then deleted.
- A pod never holds anybody's login. It starts with a single-use enrollment
  token and trades it for a credential that only works for its own runner.
- Coding CLIs in a pod reach models through almyty's Anthropic- and
  OpenAI-compatible endpoints with a pod model token that works for that pod
  only, while it runs. Vendor keys go into a pod only where an environment
  allows it.
- One folder per person per environment; the jobs that use it run one after
  another.
- When an environment's owner leaves, it goes to an organization owner or
  admin, files kept; when the team it was shared with is deleted, it becomes
  private to its owner.
- Every number above is a setting, not code.

## How it works

1. An agent with `agentConfig.environmentId` set, or a call to one of an
   environment's tools (`env.<name>.shell.exec`, `env.<name>.runner.info`,
   `env.<name>.agent.list`), needs a machine.
2. The caller's persistent workspace on that environment is found or made
   (one per environment, person and, for an agent acting as itself, agent).
   If it is suspended, almyty asks for its pod and the call answers
   `workspace_waking`. An agent run sleeps and tries again after
   `wake.retryAfterSeconds`; past `wake.budgetSeconds` the call fails
   `workspace_unavailable`.
3. The reconcile loop (one job per change, plus a sweep every minute)
   creates the pod's objects, writes a fresh enrollment token, a fresh pod
   model token and the environment's connection values into the pod's
   Secret, and scales it up.
4. The runner in the pod calls `POST /runners/enroll` with the token, gets a
   runner credential, and holds `/runners/hosted/stream` with it, like any
   runner holds its stream. When it heartbeats, the machine is ready and the
   call goes through, once no other job of the same person is working in the
   workspace (see One folder, one job at a time).
5. Each call restarts the idle clock. Past the environment's idle timeout
   the pod is scaled to zero, the Secret deleted, and the workspace marked
   `suspended`. The volume stays.

Only the reconcile loop talks to the cluster. Services write what they want
(`desired`) and the loop does it, records what it saw, and audits every
move.

## Switching it on

| Variable | What it is |
|---|---|
| `HOSTED_RUNNERS_ENABLED` | `true` to switch hosted runners on. Anything else is off: the routes refuse to create or change environments, enrollment refuses every token, and the sweep is not scheduled. |
| `HOSTED_RUNNERS_CLUSTER_CONNECTION` | The platform pool's cluster: `<organizationId>/<connectionId>`, a `kubernetes` connection (Credentials page, "Kubernetes cluster") in the platform operator's organization, shared with that organization. No cluster secret is ever an environment variable on the API. |
| `HOSTED_RUNNERS_PROVIDER` | The adapter new hosted runners use: `kubernetes` (default). `stub` runs nothing and is only registered outside production; it is for tests and a local stack. |
| `PUBLIC_API_URL` | The almyty API the pods connect to. Its host is added to every pod's egress allowlist. Override with the `apiUrl` setting. |
| `HOSTED_RUNNERS_SETTINGS_FILE` | A JSON file merged over the default settings (below). |
| `HOSTED_RUNNERS_SETTINGS` | Inline JSON merged over the defaults and the file. |

Settings that cannot work (an idle default outside its bounds, a notice day
after the deletion day, a pod running as root) stop the API at boot with a
sentence saying which.

## Settings

All numbers live here. Defaults in brackets.

| Key | What it is |
|---|---|
| `idleTimeoutMinutes.default` / `.min` / `.max` | An environment's idle timeout and the range a user may set. [15, 5, 120] |
| `suspendedRetention.keepDays` / `.noticeDay` | How long an untouched suspended workspace is kept, and when its owner is told. [30, 23] An always-on agent's own workspace is kept while the agent is on. |
| `wake.budgetSeconds` / `.retryAfterSeconds` | How long a call waits for a starting machine in all, and how often a run tries again. [180, 10] |
| `enrollment.tokenTtlMinutes` / `.credentialTtlMinutes` | Lifetime of the single-use enrollment token, and of the runner credential (renewable at `POST /runners/hosted/credential`). [10, 60] |
| `reconcile.sweepCron` | The sweep's schedule, or `off`. [every minute] |
| `reconcile.claimLeaseMinutes` | How long a provisioning claim holds before another API pod may take it over. [15] |
| `reconcile.orphanGraceMinutes` | How long a machine the cluster lost is waited for before it is given up. [30] |
| `reconcile.maxReadFailures` | Failed reads in a row before a machine is marked failed. [3] |
| `reconcile.enrollWaitMinutes` | How long a started pod has to enroll before it is restarted with a new token. [5] |
| `reconcile.batchSize` | Machines one sweep looks at. [200] |
| `resourceClasses.<name>` | `cpu`, `memory`, `ephemeralStorage` and `volumeGi` of each size. [small 1/2Gi/4Gi/10, medium 2/4Gi/8Gi/20, large 4/8Gi/16Gi/40] |
| `defaultResourceClass` | The size an environment gets when it names none. [small] |
| `images.<name>` | The curated images an environment may pick, by name. Pin each by digest. Custom images are not offered. [standard, standard-browser] |
| `capacity.maxConcurrentRunners` / `.maxWorkspaces` / `.resourceClasses` | What every organization may use when no plan capacity is installed: pods at once, workspaces kept, sizes allowed (`null` for all). [2, 10, all] Plan capacity replaces this per plan in phase 3. |
| `cluster.namespacePrefix` | Each organization's namespace is this plus its id. [`almyty-rt-`] |
| `cluster.storageClassName` | StorageClass of workspace volumes; `null` for the cluster default. |
| `cluster.workspaceMountPath` | Where the volume is mounted. [`/workspace`] |
| `cluster.runAsUser` / `.runAsGroup` | The non-root user the runner runs as. [1000, 1000] |
| `cluster.dnsNamespace` / `.dnsPodLabels` | Where cluster DNS runs, for the one egress rule that is not by name. [kube-system, `k8s-app: kube-dns`] |
| `cluster.tlsPorts` | Ports the egress allowlist opens. [443] |
| `apiUrl` | The API the pods connect to; empty uses `PUBLIC_API_URL`. |
| `usageRetention.months` | How long a usage interval is kept after it closed, unless the organization's retention policy sets `runnerUsageDays`. [13] |
| `workspaceQueue.waitSeconds` / `.pollSeconds` / `.leaseMinutes` / `.retryAfterSeconds` | One folder, one job at a time: how long a call waits for another job to finish with the workspace, how often it looks, how long a job keeps the workspace after its last call, and when a run that was told "busy" tries again. [30, 2, 30, 15] |
| `modelAccess.tokenTtlMinutes` / `.touchEverySeconds` | The pod model token's longest life (it is also revoked when the pod stops), and how often its last use is recorded. [480, 60] |
| `runsList.defaultLimit` / `.maxLimit` | How many runs `GET /environments/:id/runs` returns by default, and at most. [50, 200] |

Example: a longer idle timeout and an extra size.

```json
{
  "idleTimeoutMinutes": { "default": 30 },
  "resourceClasses": { "xl": { "cpu": "8", "memory": "16Gi", "ephemeralStorage": "32Gi", "volumeGi": 100 } }
}
```

## What runs in the cluster

Per organization, in namespace `almyty-rt-<organization id>` (labelled
`almyty.com/runner-pool=true`, Pod Security `restricted`):

- a **ResourceQuota** sized from capacity (pods at once times the largest
  allowed size, volumes kept, no Services) and a **LimitRange** so no
  container asks for more than the largest size;
- a **NetworkPolicy** `default-deny`: nothing in, nothing out.

Per hosted runner (one per workspace):

- a **CiliumNetworkPolicy** that lets its pod reach cluster DNS, and the
  environment's allowlisted hosts, the almyty API and the repository's host
  over TLS only, **matched by SNI** (`serverNames`). An address-based rule
  is not enough: hosts behind one CDN share addresses, and in the gVisor
  test `registry.yarnpkg.com` was reachable through an allowlist that named
  only `registry.npmjs.org` until the rule matched on SNI. Allowlist entries
  are exact host names: no wildcards, addresses or internal names;
- a **PersistentVolumeClaim** `ws-<workspace id>` (ReadWriteOnce);
- a **Secret** `hr-<workspace id>-env` with the enrollment token and the
  connection values, written before each start and deleted while the pod is
  scaled to zero;
- a **Deployment** `hr-<workspace id>`, replicas 0 or 1, `Recreate`, whose
  pod runs under `runtimeClassName: gvisor`, as a non-root user, all
  capabilities dropped, read-only root (the volume and `/tmp` are writable),
  no service-account token, and every secret value by reference to the
  Secret, never inline.

The builders for these are in
`backend/src/modules/hosted-runners/adapters/kubernetes/manifests.ts`. They
are the only place in the backend that writes a pod, and the client refuses
to send one that is not sandboxed.

## Cluster setup

Use a cluster of its own for the runner pool, not the one almyty runs on.
This is what passed on DigitalOcean (DOKS 1.35 and 1.36, containerd 1.7 and
2.2, Cilium 1.19, gVisor `20260928.0`, 2026-10-08).

1. **Two node pools.**
   - A **system pool**, untainted. CoreDNS, Hubble and metrics do not
     tolerate the sandbox taint; with only tainted nodes, DNS has nowhere to
     run.
   - A **sandbox pool** with label `almyty.com/sandbox=gvisor` and taint
     `almyty.com/sandbox=gvisor:NoSchedule`. Run **at least two nodes** (or
     the autoscaler with headroom): a node replace or upgrade takes about 2.5
     to 5.5 minutes to reinstall gVisor, and with one node every pod waits
     that long.
2. **The gVisor installer DaemonSet** (`gvisor-system/gvisor-installer`,
   privileged, on sandbox nodes only). Every minute it checks that `runsc`,
   its shim and the `gvisor-bin/` sidecars are installed at the pinned
   release with a pinned sha512, adds the `runsc` runtime to containerd's
   config if it is missing (choosing the table for config version 2 or 3),
   restarts containerd only if the config changed, probes with
   `runsc --network=none do dmesg`, and only then labels the node
   `almyty.com/gvisor=ready`. On any failure it removes the label.
   - Only the installer sets the ready label. Never put it in the node pool
     spec, or a new node claims readiness before `runsc` exists.
   - Do not use `ctr run` as a probe; it exits 128 silently on DOKS.
   - Rewriting containerd's config on a live node kills running sandboxes;
     the installer only appends when its marker is missing.
   - Bump the release by changing the pinned version and sha512.
3. **The RuntimeClass** `gvisor`: handler `runsc`, scheduling
   `nodeSelector: almyty.com/gvisor=ready` and a toleration for the sandbox
   taint (`buildRuntimeClass()` in the manifests file describes it). Pods
   only name the class; they land on ready sandbox nodes and wait otherwise.
4. **Cilium** with the L7 proxy on (`enable-l7-proxy: true`, the DOKS
   default), which SNI and DNS rules need.
5. **A ServiceAccount for almyty** whose role covers only namespaces
   labelled `almyty.com/runner-pool=true` and only these kinds: Namespace,
   ResourceQuota, LimitRange, NetworkPolicy, CiliumNetworkPolicy,
   PersistentVolumeClaim, Secret, Deployment (and its `scale`), and reading
   Pods. Put its token, the API server URL and the cluster CA into a
   `kubernetes` connection and point `HOSTED_RUNNERS_CLUSTER_CONNECTION` at
   it.

The cloud metadata address (169.254.169.254) was already unreachable from
pods on DOKS; the default-deny policy keeps it so elsewhere.

## Models from inside a pod

A coding CLI in a hosted pod (Claude Code, Codex, any client of the
Anthropic or OpenAI API) reaches models through almyty, never with a vendor
key or anybody's login (Decision 6).

- At every pod start the reconcile loop mints a **pod model token**
  (`almyty_pod_...`), stores only its sha256 in `hosted_model_tokens`, and
  writes it into the pod's Secret as `ALMYTY_MODEL_TOKEN`,
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. The pod's plain environment
  carries `ANTHROPIC_BASE_URL` (the API origin) and `OPENAI_BASE_URL` (the
  API origin plus `/v1`), so a CLI that honours them talks to almyty.
- The token names one hosted runner, so one workspace, environment and
  organization, and acts as the **workspace's owner**: it runs exactly the
  agents the owner may run, under the owner's and the organization's
  budgets, through the same routing as any other call.
- It is accepted by `POST /v1/messages`, `POST /v1/chat/completions` and
  `GET /v1/models` only. Every other route treats it as an unknown key.
- It works only while its pod is the one running (machine `ready`, asked
  to run, workspace active), its owner is still an active member, and for
  at most `modelAccess.tokenTtlMinutes`. It is revoked the moment the loop
  stops the pod (idle, suspended by hand, torn down, failed), when the next
  start mints a new one, and when its owner leaves the organization.
- Every call is attributed to the machine: the response carries
  `X-Almyty-Hosted-Runner`, `X-Almyty-Environment` and
  `X-Almyty-Workspace`, the run's metadata carries `hosted`, and the audit
  log gets a `hosted_model_call` row. Minting and revoking are audited too
  (`hosted_model_token_issued`, `hosted_model_token_revoked`).

**Vendor keys**, for a CLI that cannot change its base URL, are off unless
an environment turns on `allowVendorKeys`. With it off, an `envBindings`
entry naming a model provider's connection (one a model provider of the
organization uses, or one made from a model vendor's connector) is refused
when the environment is saved and again at every pod start. With it on, a
binding to `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` replaces the pod token
for that vendor, and that vendor's base URL is not set. Turning it on or off
is a new environment version and is audited.

What the endpoints run today is an almyty **agent**: `model` names the
agent (`agent:<id>` or its name), and client-declared `tools` are refused.
A coding CLI that sends its own tools on every request (Claude Code and
Codex do) therefore cannot use them yet; see "Not yet".

## One folder, one job at a time

A person's workspace on an environment is one folder, the volume at
`cluster.workspaceMountPath`, shared by every job of theirs there. Jobs
run one after another in it:

- A job (an agent run with its helpers and sub-agents) takes the workspace
  with its first call and keeps it while any run of the job is going and
  it has used the workspace within `workspaceQueue.leaseMinutes`.
- A call of another job waits for it, looking every
  `workspaceQueue.pollSeconds`, for up to `workspaceQueue.waitSeconds`, and
  then answers `workspace_busy`; an agent run sleeps
  `workspaceQueue.retryAfterSeconds` and tries again, as it does for a
  waking machine.
- A call that belongs to no run (a person calling a tool by hand) holds the
  workspace for that call only.
- A job that ended is noticed by the next one that wants the workspace; a
  holder that crashed loses the workspace when its lease runs out.

The lease is three columns on the workspace (`leaseHolder`, `leaseJob`,
`leaseUntil`), taken by conditional updates, so it holds across API pods.
The pod itself also runs one thing at a time: enrollment sets
`maxConcurrent: 1` whatever the runner asks for.

## When the owner or the team goes

- **The owner leaves the organization** (removed, left, or deleted their
  account): every environment they own, whatever its visibility, is
  handed to the organization's longest-standing owner, or, with no other
  owner, its longest-standing admin. Visibility, workspaces and files stay.
  Their own workspaces have their pod stopped at once and their pod model
  token revoked, because the pod's Secret was built from their connections;
  the files stay, and the workspace moves to the same person unless that
  person already has one on that environment (then it stays suspended under
  the departed owner until the retention window ends, and an admin can
  release it). Every move is an audit row (`ownership_transfer`); the new
  owner is told (`environments.handed_over`).
- **A team is deleted**: an environment shared with it keeps its owner and
  becomes private, with its tools; the owner can share it again. Audited
  (`visibility_change`, reason `team_deleted`); the owner is told
  (`environments.unshared`). A team deleted by any other path gets the same
  from a database trigger, without the notice.
## Data

| Table | What it holds |
|---|---|
| `environments` | One per environment; soft-deleted. `version` goes up on every change a pod would run differently with. `allowVendorKeys` (off by default) lets its bindings carry a model provider's key. |
| `hosted_runners` | Desired and observed state per pod. Only the reconcile loop writes `state`, `actual`, `externalRef`, `lastError`. |
| `runner_enrollment_tokens` | The sha256 of each single-use token, its expiry and when it was used. |
| `hosted_model_tokens` | The sha256 of each pod model token, the pod, workspace, environment and owner it is bound to, its expiry, and when and why it was revoked. |
| `runner_usage_intervals` | When each pod ran, from the loop's own observations; one open interval per pod. Kept for `usageRetention.months` (13) after it closed, or the organization's `runnerUsageDays` (see [retention.md](retention.md)); an open one is never deleted. Reported to Stripe in phase 3. |
| `runners.kind` | `self` (a machine someone runs) or `hosted`. The one-runner-per-account rule is `self` only. Hosted runners are not listed on the runners page. |
| `workspaces.kind` | `job` or `persistent`. Only a persistent workspace can be `suspended`, and it is never stranded or released by a run ending. `leaseHolder`, `leaseJob` and `leaseUntil` say which job is working in it. |

## Who may do what

- Creating, changing or deleting an environment needs member or above.
  Reading needs viewer or above, and the access policy decides which rows.
- An environment is private by default. Sharing it with a team or the
  organization is the `hosted_shared_environments` entitlement (Business);
  the check is on the change only (see [enterprise.md](enterprise.md)).
- Running an agent on it needs `use` of the environment, judged like a
  runner: by the person, or by the gateway or agent the run acts as.
- A workspace's owner may suspend or release it; an organization owner or
  admin may too.
- The runner credential is accepted on `/runners/hosted/stream` and
  `POST /runners/hosted/credential` only. Everywhere else it is a 401.
- The pod model token is accepted on `/v1/messages`, `/v1/chat/completions`
  and `/v1/models` only, as the workspace's owner. Everywhere else it is a
  401.

## API

| Route | What it does |
|---|---|
| `GET /environments` | The environments you may see, whether hosted runners are on, and `options` (as below). |
| `GET /environments/options` | What an environment form may offer, from the settings and the plan: curated image names, the sizes this organization may use, the default size, the idle-timeout default and bounds, how long a suspended workspace's files are kept and when its owner is told, the usage retention, and the capacity. |
| `GET /environments/usage` | Runner minutes this month (UTC; or `?from=&to=`), per environment you may see and by size, and for the whole organization when you are an owner or admin (`null` otherwise). |
| `POST /environments` | Create one. |
| `GET /environments/:id` | One environment. |
| `PATCH /environments/:id` | Change it. |
| `DELETE /environments/:id` | Delete it; its machines and volumes go too. |
| `GET /environments/:id/workspaces` | Its workspaces (yours; all of them for an admin) with their machine's state. |
| `GET /environments/:id/runs` | Runs of agents whose machine is this environment (`agentConfig.environmentId`), newest first: autonomous runs (top-level) and workflow executions. Yours; all of them for an owner or admin. `?limit=` up to `runsList.maxLimit`. |
| `POST /environments/:id/workspaces/:workspaceId/suspend` | Park a workspace now. |
| `POST /environments/:id/workspaces/:workspaceId/release` | Let it go, with its files. |
| `POST /runners/enroll` | A pod trades its token for a runner credential. |
| `POST /runners/hosted/credential` | A runner renews its credential. |
| `POST /v1/messages`, `POST /v1/chat/completions`, `GET /v1/models` | Also take a pod model token (see Models from inside a pod). |

## Not yet

- The Hosted tab in the app, including `allowVendorKeys` on the
  environment page, the `runnerUsageDays` field in the Data retention card,
  and the two new notification types in the notification list.
- The `runner-env` images and `almyty-runner start --enroll` in the runner
  package.
- A model pass-through for coding CLIs: an Anthropic- and
  OpenAI-compatible endpoint that forwards a CLI's own request (its tools
  included) to a model through almyty's routing, budgets and attribution.
  Today's `/v1/messages` and `/v1/chat/completions` run almyty agents and
  refuse client-declared tools, so the pod model token works there but
  Claude Code and Codex cannot do their work through them yet.
- Renewing a pod model token inside a pod that runs longer than
  `modelAccess.tokenTtlMinutes`: such a pod gets 401 from the model
  endpoints until its next start.
- A spend budget of its own per environment or workspace; model calls from
  a pod count against the owner's and the organization's budgets.
- Plan capacity and Stripe reporting (phase 3, in `ee`).
- An organization's own cluster (phase 4).
