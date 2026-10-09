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

Status: phase 2, behind a switch, for staging. The app has a Hosted tab on
the Runners page (user guide: docs-site "Hosted machines"); the runner images
are built in CI but not published yet, and nothing is billed yet (usage is
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
- Coding CLIs in a pod reach models through almyty's model pass-through
  (their own requests, tools and all, to an organization-wide provider)
  via the runner's loopback proxy, which holds an hour-long pod model token
  and renews it while the pod runs. Vendor keys go into a pod only where an
  environment allows it.
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
| `images.<name>` | The curated images an environment may pick, by name. Pin each by digest. Custom images are not offered. [standard, standard-browser] `images/runner-env/settings.json` lists the images CI builds (see [Images and enroll mode](#images-and-enroll-mode)). |
| `capacity.maxConcurrentRunners` / `.maxWorkspaces` / `.resourceClasses` | What every organization may use when no plan capacity is installed: pods at once, workspaces kept, sizes allowed (`null` for all). [2, 10, all] Plan capacity replaces this per plan in phase 3. |
| `cluster.namespacePrefix` | Each organization's namespace is this plus its id. [`almyty-rt-`] |
| `cluster.storageClassName` | StorageClass of workspace volumes; `null` for the cluster default. |
| `cluster.workspaceMountPath` | Where the volume is mounted. [`/workspace`] |
| `cluster.runAsUser` / `.runAsGroup` | The non-root user the runner runs as. [1000, 1000] |
| `cluster.dnsNamespace` / `.dnsPodLabels` | Where cluster DNS runs, for the one egress rule that is not by name. [kube-system, `k8s-app: kube-dns`] |
| `cluster.tlsPorts` | Ports the egress allowlist opens. [443] |
| `cluster.clusterCidrs` | The cluster's pod and service CIDRs, closed to every runner on top of the private ranges that are always closed. Only needed when they lie outside 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16 (DOKS's defaults are inside 10.0.0.0/8). [none] |
| `cluster.disruptionBudget.minAvailable` / `.maxUnavailable` | Each runner's PodDisruptionBudget: set exactly one, the other `null`, as a number of pods or a percentage. `maxUnavailable: 0` makes a node drain wait until the runner is idle and scaled to zero. [null, 0] |
| `apiUrl` | The API the pods connect to; empty uses `PUBLIC_API_URL`. |
| `usageRetention.months` | How long a usage interval is kept after it closed, unless the organization's retention policy sets `runnerUsageDays`. [13] |
| `workspaceQueue.waitSeconds` / `.pollSeconds` / `.leaseMinutes` / `.retryAfterSeconds` | One folder, one job at a time: how long a call waits for another job to finish with the workspace, how often it looks, how long a job keeps the workspace after its last call, and when a run that was told "busy" tries again. [30, 2, 30, 15] |
| `modelAccess.tokenTtlMinutes` / `.touchEverySeconds` / `.localProxyPort` / `.upstreamTimeoutSeconds` | The pod model token's lifetime (the runner renews it while the pod runs; it also dies when the pod stops), how often its last use is recorded, the loopback port of the runner's model proxy, and how long one pass-through call may take. [60, 60, 4319, 600] |
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
  are exact host names: no wildcards, addresses or internal names. The same
  policy carries `egressDeny` rules, which win over every allow, for the
  private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), carrier-grade
  NAT (100.64.0.0/10), link-local with the metadata address
  (169.254.0.0/16), loopback (127.0.0.0/8, ::1/128), IPv6 unique-local and
  link-local (fc00::/7, fe80::/10) and `cluster.clusterCidrs`: an allowed
  name that resolves to a private address is still dropped. The almyty API
  is reached by its public name, like any allowlisted host, so it must
  resolve to a public address (it does from a separate runner cluster);
- a **PodDisruptionBudget** `hr-<workspace id>` on the runner's pod
  (`cluster.disruptionBudget`, default `maxUnavailable: 0`), so a node
  drain for an upgrade or a replacement waits for the runner to go idle
  instead of killing it mid-job. A pod that is not ready may always be
  evicted (`unhealthyPodEvictionPolicy: AlwaysAllow`), so a broken runner
  never holds a node;
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
   PodDisruptionBudget (`policy/poddisruptionbudgets`: create, patch, get,
   delete), PersistentVolumeClaim, Secret, Deployment (and its `scale`), and
   reading Pods. Without the PodDisruptionBudget rule every provision fails
   with HTTP 403. Put its token, the API server URL and the cluster CA into a
   `kubernetes` connection and point `HOSTED_RUNNERS_CLUSTER_CONNECTION` at
   it.
6. **Optional: pre-pull the standard image** with the DaemonSet in
   [`docs/design/hosted-runners/image-prepull.yaml`](design/hosted-runners/image-prepull.yaml),
   so the first wake on a new sandbox node does not wait for the image to
   download. almyty does not apply it; set its image to the reference in
   `images.standard` and update both together.

The cloud metadata address (169.254.169.254) was already unreachable from
pods on DOKS; the runner policy's `egressDeny` on 169.254.0.0/16 keeps it so
elsewhere.

## Models from inside a pod

A coding CLI in a hosted pod (Claude Code, Codex, aider, any client of the
Anthropic or OpenAI API) reaches models through almyty, never with a vendor
key or anybody's login (Decision 6).

**The pod model token.**

- At every pod start the reconcile loop mints one (`almyty_pod_...`),
  stores only its sha256 in `hosted_model_tokens`, and writes it into the
  pod's Secret as `ALMYTY_MODEL_TOKEN`, with its expiry in
  `ALMYTY_MODEL_TOKEN_EXPIRES_AT`. The pod's plain environment names the
  runner's model proxy (`ALMYTY_MODEL_PROXY_PORT`, from
  `modelAccess.localProxyPort`) and where to renew
  (`ALMYTY_MODEL_RENEW_PATH`).
- It is short: `modelAccess.tokenTtlMinutes` (60). The runner renews it
  while the pod runs, at three quarters of its life, at
  `POST /runners/hosted/model-token` with the current token as its bearer.
  Only the current token of a running pod is accepted there, before it
  expires; the answer is a new token and its expiry, and the old one stops
  working at once.
- It dies with its pod: it is revoked the moment the loop stops the pod
  (idle, suspended by hand, torn down, failed), when the next start mints
  a new one, and when its owner leaves the organization. A token whose pod
  is not running, whose workspace is not active, or whose owner is no
  longer an active member is refused even before then.
- It names one hosted runner, so one workspace, environment and
  organization, and acts as the workspace's owner. It is accepted by the
  model pass-through and its own renewal only; every other route treats it
  as an unknown key.

**The runner's model proxy.** The CLIs never hold the token. The runner
takes `ALMYTY_MODEL_TOKEN` out of its environment as it starts (nothing it
starts inherits it), listens on `127.0.0.1:<ALMYTY_MODEL_PROXY_PORT>`, and
forwards each `/v1/...` call to the almyty API with the current token in
place of whatever key the CLI sent, streaming both ways. The image's
entrypoint points every CLI at the proxy with a placeholder key (see
[Coding CLIs](#coding-clis)), so a renewed token is used from the next call
on without restarting anything. A renewal the API refuses (the pod is
being stopped) leaves the CLIs with 401s until the next start; it does not
stop the runner. The code is `packages/runner/src/model-proxy.ts`.

**The model pass-through.** What a pod token gets on the model endpoints is
the CLI's own call, forwarded, not an almyty agent:

- `POST /v1/messages` (and `/v1/messages/count_tokens`) goes to a provider
  speaking Anthropic's Messages API, `POST /v1/chat/completions` to one
  speaking OpenAI's chat completions, `POST /v1/responses` (the only API
  Codex speaks) to an OpenAI provider. The request goes unchanged (its
  tools, tool choice, thinking settings and stream), and the vendor's answer
  comes back as it came, streamed when the client asked for a stream.
- `model` is a model of the organization's catalog, by its vendor id or
  name: the first validated card for it, in catalog order, on an active
  provider a pod may use that speaks the protocol. A pod may use the
  organization-wide providers, and its owner's own private providers the
  owner granted to their hosted workspaces: the one-click grant,
  `hostedPodAccess: true` on `PATCH /llm-providers/:id`, which only the
  owner of a private provider can set (it is cleared when the provider
  stops being private). A team's provider, or another member's, is never
  used. `GET /v1/models` lists exactly the models a pod may name.
- Before the call the organization's spend budgets are checked; a budget
  that rejects answers in the client's error shape (Anthropic 400, OpenAI
  429 `insufficient_quota`) and nothing is called.
- After it, the call is a row in `hosted_model_calls` (tokens read from the
  answer or the stream's events, cost from the card's price), which the
  organization's spend and budgets count; the route is audited
  (`model_routed`, with cost) and so is the pod's call (`hosted_model_call`).
  The response carries `X-Almyty-Hosted-Runner`, `X-Almyty-Environment`,
  `X-Almyty-Workspace`, `X-Almyty-Route-Model` and `X-Almyty-Route-Provider`.
- Only a pod token reaches it. An API key on `/v1/messages` and
  `/v1/chat/completions` still runs an agent, as before; `/v1/responses`
  and `/v1/messages/count_tokens` take a pod token and nothing else.
- The model routes accept a request body up to `MODEL_PASSTHROUGH_BODY_LIMIT`
  (32mb), because a CLI resends its whole conversation on every call.

**Vendor keys**, for a CLI that cannot use almyty's endpoints (Gemini CLI
today), are off unless an environment turns on `allowVendorKeys`. With it
off, an `envBindings` entry naming a model provider's connection (one a
model provider of the organization uses, or one made from a model vendor's
connector) is refused when the environment is saved and again at every pod
start. With it on, binding `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`) gives that CLI the key, and the entrypoint leaves that
family alone. Turning it on or off is a new environment version and is
audited.

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
  the files stay, and each workspace moves to the same person. Where that
  person already has a workspace on the environment, they keep both: the
  departed member's is kept **read-only** (`readOnly`, with
  `inheritedFromUserId`), to copy from or delete. Its pod mounts the volume
  read-only (with `HOME` in `/tmp`) and sets nothing up; only a call that
  names it (`workspaceId`) works there, and only for its new owner. It
  follows the usual suspended retention: the notice on day 23 goes to the
  new owner, and it is deleted after 30 days unused. Every move is an audit
  row (`ownership_transfer`, with `readOnly` where it applies); the new
  owner is told (`environments.handed_over`, which says when a workspace
  was kept read-only).
- **A team is deleted**: an environment shared with it keeps its owner and
  becomes private, with its tools; the owner can share it again. Audited
  (`visibility_change`, reason `team_deleted`); the owner is told
  (`environments.unshared`). A team deleted by any other path gets the same
  from a database trigger, without the notice.

## Images and enroll mode

A pod runs one of the curated `almyty/runner-env` images. Its entrypoint
starts the runner in enroll mode; nothing else in the image is specific to
almyty.

### The images

`images/runner-env/Dockerfile` builds every flavour as a target:

| Target | What it adds |
|---|---|
| `standard` | `node` and `python` together, and the coding CLIs: Claude Code, Codex, Gemini CLI, aider (see [Coding CLIs](#coding-clis)) |
| `standard-browser` | `standard` and Playwright with headless Chromium (see [The browser](#the-browser)) |
| `node` | pnpm and yarn |
| `python` | pip, venv and the Python headers native wheels build against |

All four share a `base` stage: Debian slim with Node 26 (the repo's one
Node major), git and git-lfs, build-essential, curl, jq, tini, and
`@almyty/runner` at the version pinned by `ARG RUNNER_VERSION`. The
runner's PTY binding (node-pty) compiles against the build tools there.

They are made for the pod the backend writes:

- **uid and gid 1000** (`USER 1000:1000`, the node image's user renamed
  `runner`), the `cluster.runAsUser` / `.runAsGroup` defaults. Change
  those settings and the images no longer match.
- **Read-only root.** Only `/workspace` (the volume) and `/tmp` (an
  emptyDir) are written at run time. `HOME` is `/workspace/.home`, and the
  entrypoint points npm's global prefix and cache, pip's cache and the XDG
  folders under it and puts `~/.local/bin` and the npm prefix on `PATH`.
  `npm i -g` and `pip install` therefore work, and what they install lives
  on the volume. Outside a venv, `pip install` becomes a user install
  (`PIP_BREAK_SYSTEM_PACKAGES=1`); system packages are not touched.
- **tini** is PID 1, so the processes the runner starts are reaped.
- The command is `almyty-runner start --enroll`.

`images/runner-env/settings.json` is the curated list in the shape of
`HOSTED_RUNNERS_SETTINGS_FILE`: one `images.<name>` entry per target,
tagged `almyty/runner-env:<target>-<RUNNER_VERSION>`. Point the setting at
that file (or copy its `images` into `HOSTED_RUNNERS_SETTINGS`) to offer
them. Settings merge key by key, so names in the built-in defaults that
the file does not mention stay offered. The built-in defaults name
`standard` and `standard-browser` with the same tags as the file. Once
pushed, pin each entry by digest (`...:standard-1.6.0@sha256:...`).
`scripts/check-runner-env-images.js` (in CI's repo-invariants job) fails
when a listed name is not a target, when a tag does not carry the pinned
version, when the pin is ahead of `packages/runner`, when a built-in default
is not in the file with the same reference, or when the workflow does not
build and smoke-test exactly the listed flavours.

Build one locally from the repository root:

```bash
docker build --target standard -t runner-env:standard images/runner-env
```

That installs the pinned runner from npm. To try the runner in this
checkout instead, pack it and pass it as the `runner-pkg` build context:

```bash
(cd packages/runner && npm ci && npm run build && npm pack --pack-destination /tmp/runner-pkg)
mv /tmp/runner-pkg/almyty-runner-*.tgz /tmp/runner-pkg/almyty-runner.tgz
docker build --target standard --build-context runner-pkg=/tmp/runner-pkg -t runner-env:standard images/runner-env
```

To run it as the cluster does: `--user 1000:1000 --read-only --cap-drop
ALL --tmpfs /tmp`, a volume owned by uid 1000 at `/workspace`,
`HOME=/workspace/.home`, `ALMYTY_API_URL` and `ALMYTY_ENROLLMENT_TOKEN`.

CI (`.github/workflows/runner-env-images.yml`) builds all four, with the
runner packed from the checkout, on every PR and push that touches
`images/runner-env/**` or `packages/runner/**`, and runs
`images/runner-env/smoke.sh` on each as the pod runs it: uid 1000,
`--enroll` present, a failed enrollment exits 1, every coding CLI starts
and the runner detects it, the model-token wiring, and (for
`standard-browser`) a headless Chromium page load. Run the same script
locally after a build: `images/runner-env/smoke.sh runner-env:standard
standard`. CI pushes only from `master` and `v*` tags. The push builds with
the pinned runner from npm and refuses an image whose runner has no
`--enroll`. To release new images: publish the runner, bump
`RUNNER_VERSION` in the Dockerfile and the tags in `settings.json` and the
backend's default `images` together, merge to `master`, then pin the pushed
digests in `settings.json`.

### Coding CLIs

`standard` and `standard-browser` carry the coding CLIs the runner detects
and drives, each from its vendor's package at a version pinned by an `ARG`
in the Dockerfile: Claude Code (`@anthropic-ai/claude-code`), Codex
(`@openai/codex`), Gemini CLI (`@google/gemini-cli`) and aider
(`aider-chat`, in its own venv at `/opt/aider`). They are read-only in the
image; their config, sessions and caches go under `HOME` on the volume.
Self-updates, first-run questions and analytics are switched off.

They call models through almyty, not a vendor, so keys stay in the store
They call models through almyty, not a vendor, so keys stay in the store
and every call is routed, budgeted and attributed. When the pod has
`ALMYTY_MODEL_TOKEN` and `ALMYTY_API_URL`, the entrypoint sets the
settings below. With `ALMYTY_MODEL_PROXY_PORT` too (the backend always
sends it), the base URL is the runner's loopback model proxy,
`http://127.0.0.1:<port>`, and the key is a placeholder
(`almyty-pod-local`): the runner forwards each call to almyty with the
current pod token and renews that token while the pod runs, so the CLIs
never hold it (see [Models from inside a pod](#models-from-inside-a-pod)).
Without the port the CLIs get the API URL and the token directly.

| CLI | Settings | Calls |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (a bearer; `ANTHROPIC_API_KEY` would make it ask which to use) | `POST /v1/messages` (and `/v1/messages/count_tokens`) |
| aider | `AIDER_OPENAI_API_BASE`, `AIDER_OPENAI_API_KEY`, `AIDER_ANTHROPIC_API_KEY` | `/v1/chat/completions`, `/v1/messages` |
| Codex | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and an `almyty` provider in `~/.codex/config.toml` (Codex ignores `OPENAI_BASE_URL`) | `POST /v1/responses` |
| Gemini CLI | nothing: no almyty endpoint speaks its API | a vendor key (`GEMINI_API_KEY`) bound on an environment that allows vendor keys |

A family the pod configured itself (its own base URL or key) is left
alone. The Codex file is rewritten on every start while its first line is
the entrypoint's marker; replace the file to manage it yourself. A session
the runner starts with its own `CODEX_HOME` does not see it.

### The browser

`standard-browser` adds Playwright (pinned) with the headless Chromium
build it was released against and the libraries it needs, in
`/opt/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`). `NODE_PATH` makes the
global `playwright` requirable without a project install. A project that
pins another Playwright release sets `PLAYWRIGHT_BROWSERS_PATH` under
`HOME` and installs its own browser there.

Chromium runs without its own sandbox, which is Playwright's default
(`chromiumSandbox: false` adds `--no-sandbox`). Its sandbox needs a setuid
helper, which `allowPrivilegeEscalation: false` rules out, or unprivileged
user namespaces, which the `RuntimeDefault` seccomp profile refuses to a
container without `CAP_SYS_ADMIN`. With the pod's restrictions,
`chromiumSandbox: true` fails at launch ("Chromium sandboxing failed").
The pod is the sandbox: gVisor, non-root, no capabilities, read-only root.

### Enroll mode

`almyty-runner start --enroll` (also `almyty runner start --enroll`) is the
runner without a login. It takes `--url` and nothing that names an
identity: `--name`, `--org`, `--label` and `--config` are refused, because
the token decides which runner this is.

1. It reads the token from `ALMYTY_ENROLLMENT_TOKEN` (the pod's Secret,
   through `envFrom`), or from the file named by
   `ALMYTY_ENROLLMENT_TOKEN_FILE`, and removes both variables from its
   environment, so nothing it starts inherits them. The API is
   `ALMYTY_API_URL` (`--url` overrides it); plain `http` is refused except
   to localhost.
2. It sends `POST /runners/enroll` with the token and its runtime info
   (no config: the backend sets the policy, host isolation inside the
   sandbox with the working folder limited to the volume). Any refusal, a
   malformed answer or an unreachable API ends the process with exit 1,
   and Kubernetes restarts the container. The token is single use, so the
   restarted container is refused too until the reconcile loop writes a
   fresh one (`reconcile.enrollWaitMinutes`).
3. The credential stays in memory: never on disk, never in the
   environment, never in a log line or error message (the state file
   `almyty runner status` reads holds the session id, not the
   credential). It is renewed at `POST /runners/hosted/credential` when
   three quarters of its life have passed. A failed renewal is retried
   every 30 seconds while there is time. A 401, 403 or 404 (the hosted
   runner is gone), or a credential about to expire, ends the process
   with exit 1.
4. On the volume's first start, or when `ALMYTY_ENVIRONMENT_VERSION`
   differs from `/workspace/.almyty/env-version`, it sets the workspace
   up before connecting, so the machine is ready only after setup:
   - `ALMYTY_REPO_URL` is cloned into `/workspace/repo` and `ALMYTY_REPO_REF`
     checked out (a branch, a tag or a commit). `ALMYTY_GIT_TOKEN` reaches
     git as an HTTP header through `GIT_CONFIG_*` variables of that one
     process: not on a command line, not in a file, not in the remote
     URL. An existing checkout is never touched again; a new version only
     re-runs the setup script.
   - `ALMYTY_SETUP_SCRIPT` runs with bash, in the checkout (or
     `/workspace` without one), with the pod's environment, its output in
     the pod log. It is stopped after `ALMYTY_SETUP_TIMEOUT_SECONDS`
     (1800).
   - On success the version is written to `/workspace/.almyty/env-version`.
     On failure it is not, so the next start tries again, and the runner
     still comes online, so the problem can be looked at from a shell
     instead of from a restart loop.
5. It holds `/runners/hosted/stream` with the credential (re-read on every
   request, so a renewed one is used at once), says `runner.hello` and
   heartbeats like any runner.
6. When the pod carries a model token (`ALMYTY_MODEL_TOKEN` and
   `ALMYTY_MODEL_PROXY_PORT`), it takes the token out of its environment
   at the start (with the enrollment token), listens on
   `127.0.0.1:<port>` and forwards the coding CLIs' `/v1/...` calls to the
   API with the current token, which it renews at three quarters of its
   life (see [Models from inside a pod](#models-from-inside-a-pod)). On a
   read-only (inherited) workspace (`ALMYTY_WORKSPACE_READ_ONLY`) step 4
   sets nothing up.

The code is `packages/runner/src/enroll.ts` (token, enrollment, renewal),
`hosted-setup.ts` (first start), `model-proxy.ts` (the model token and
proxy) and `RunnerDaemon.startEnrolled`. The tests run it against a fake
API with the backend's rules (`test/fake-hosted-api.ts`,
`test/enroll.spec.ts`, `test/model-proxy.spec.ts`).

### Binary allowlist

An environment may list the binaries its runner starts
(`egress.allowBinaries`). The pod gets the list as `ALMYTY_ALLOW_BINARIES`,
a JSON array, and the runner adds it to the policy the backend sent
(`packages/runner/src/policy.ts`, next to `denyPatterns`). With a list:

- a `process.spawn` or coding-agent start whose binary is not listed is
  refused (`command_denied`);
- every command a `shell.exec` line starts is checked: the first word of
  each command, including those in `$( )`, backticks, `( )` and pipelines,
  after variable assignments and redirections. Builtins that cannot start a
  program (`cd`, `echo`, `export`, `test`, ...) need no listing; `exec`,
  `eval`, `command`, `source` and `trap` do. A command name built at run
  time (`$CMD`, a glob) is refused;
- an entry without a slash allows that name, found on `PATH`; an entry with
  a slash allows exactly that absolute path, so `./claude` is not `claude`.

A list the runner cannot read stops it before it enrolls (exit 1), rather
than letting it run unrestricted. No list, or an empty one, means no
restriction.

Inside the sandbox this is a guard rail, not the boundary: a listed shell,
interpreter or wrapper (`bash`, `python`, `node`, `env`, `xargs`, an npm
script) can still start anything. The boundary is the pod.

## Data

| Table | What it holds |
|---|---|
| `environments` | One per environment; soft-deleted. `version` goes up on every change a pod would run differently with. `allowVendorKeys` (off by default) lets its bindings carry a model provider's key. |
| `hosted_runners` | Desired and observed state per pod. Only the reconcile loop writes `state`, `actual`, `externalRef`, `lastError`. |
| `runner_enrollment_tokens` | The sha256 of each single-use token, its expiry and when it was used. |
| `hosted_model_tokens` | The sha256 of each pod model token, the pod, workspace, environment and owner it is bound to, its expiry, and when and why it was revoked. |
| `hosted_model_calls` | Every call a pod's coding CLI made through the model pass-through: pod, workspace, environment, owner, provider, model, protocol, status, tokens and cost. A spend source beside agent runs, so the organization's budgets see it. Kept like the usage intervals. |
| `runner_usage_intervals` | When each pod ran, from the loop's own observations; one open interval per pod. Kept for `usageRetention.months` (13) after it closed, or the organization's `runnerUsageDays` (see [retention.md](retention.md)); an open one is never deleted. Reported to Stripe in phase 3. |
| `runners.kind` | `self` (a machine someone runs) or `hosted`. The one-runner-per-account rule is `self` only. Hosted runners are not listed on the runners page. |
| `workspaces.kind` | `job` or `persistent`. Only a persistent workspace can be `suspended`, and it is never stranded or released by a run ending. `leaseHolder`, `leaseJob` and `leaseUntil` say which job is working in it. |
| `workspaces.kind` | `job` or `persistent`. Only a persistent workspace can be `suspended`, and it is never stranded or released by a run ending. `leaseHolder`, `leaseJob` and `leaseUntil` say which job is working in it; `readOnly` and `inheritedFromUserId` mark a departed member's workspace kept for an admin. |
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
- The pod model token is accepted by the model pass-through
  (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`,
  `/v1/messages/count_tokens`, `/v1/models`) and by its own renewal
  (`POST /runners/hosted/model-token`) only. Everywhere else it is a 401.

## API

| Route | What it does |
|---|---|
| `GET /environments` | The environments you may see, each with `mine` (your own machine there: workspace, status, machine state and `desired.replicas`; null before you used it), whether hosted runners are on, and `settings` (as below). |
| `GET /environments/settings` | What an environment form may offer, from the settings and the plan: curated image names, the sizes this organization may use, the default size, the idle-timeout default and bounds, how long a suspended workspace's files are kept and when its owner is told, the usage retention, and the capacity. |
| `GET /environments/usage` | Runner minutes this month (UTC; or `?from=&to=`), per environment you may see and by size, and for the whole organization when you are an owner or admin (`null` otherwise). |
| `POST /environments` | Create one. |
| `GET /environments/:id` | One environment. |
| `PATCH /environments/:id` | Change it. |
| `DELETE /environments/:id` | Delete it; its machines and volumes go too. |
| `GET /environments/:id/workspaces` | Its workspaces (yours; all of them for an admin) with their machine's state and `desired.replicas` (whether anything asked for the pod). |
| `GET /environments/:id/runs` | Runs of agents whose machine is this environment (`agentConfig.environmentId`), newest first: autonomous runs (top-level) and workflow executions. Yours; all of them for an owner or admin. `?limit=` up to `runsList.maxLimit`. |
| `POST /environments/:id/workspaces/:workspaceId/suspend` | Park a workspace now. |
| `POST /environments/:id/workspaces/:workspaceId/release` | Let it go, with its files. |
| `POST /runners/enroll` | A pod trades its token for a runner credential. |
| `POST /runners/hosted/credential` | A runner renews its credential. |
| `POST /runners/hosted/model-token` | A running pod trades its current model token (`Authorization: Bearer`) for a fresh one; the old one stops at once. |
| `POST /v1/messages`, `POST /v1/chat/completions` | With a pod model token: the model pass-through (the CLI's own request, to an organization-wide provider). With an API key: an almyty agent, as before. |
| `POST /v1/responses`, `POST /v1/messages/count_tokens` | The model pass-through only: a pod model token and nothing else. |
| `GET /v1/models`, `GET /v1/models/:model` | With a pod model token: the organization-wide providers' models a pod may name. |

## Not yet

- Published `runner-env` images: the Dockerfile pins @almyty/runner 1.5.5,
  the first release with the local model proxy (`dist/model-proxy.js`), and
  `settings.json` and the backend default `images` name the 1.5.5 tags
  without digests. TODO: the 1.5.5 images exist only after 1.5.5 is on npm
  and the release push has run; pin the pushed digests in `settings.json`
  and the backend default `images` then. The entrypoint points the CLIs at
  the model proxy only when the image's runner has it; with an older
  runner the CLIs get the pod token directly and lose it at its first
  renewal.
- Gemini CLI through almyty: no almyty endpoint speaks its API, so it
  keeps a vendor key from the store (`allowVendorKeys`).
- Bedrock, Vertex AI and Azure OpenAI as pass-through targets (later).
- A spend budget of its own per environment or workspace; model calls from
  a pod count against the organization's budgets.
- Plan capacity and Stripe reporting (phase 3, in `ee`).
- An organization's own cluster (phase 4).
