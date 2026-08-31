# Builder image topology

Agent-app builds need compilers, packagers, signing tools, temporary credentials, and outbound access to pinned runtime artifacts. The request API needs none of those. Production should therefore run builds in a dedicated worker image rather than adding the build toolchain to the API image.

## Decision

Use a separate `app-builder` worker image that consumes the existing build queue. Keep the API responsible for validation, authorization, queueing, status, and downloads. The worker owns compilation, signing, upload, and cleanup.

An ephemeral Kubernetes Job per build is the stronger long-term isolation boundary. It can use the same builder image and queue contract, so moving from a long-running worker to per-build Jobs does not require changing the API or artifact model.

## Options

| Topology | Advantages | Costs and risks | Verdict |
|---|---|---|---|
| Toolchains in the API image | One deployment and no new queue consumer | Larger attack surface and image; compilers and signing tools share the request-serving pod; build CPU, memory, and disk compete with API traffic; broad outbound access; harder autoscaling | Development only |
| Dedicated build worker | Independent scaling and resources; no inbound traffic; API remains lean; signing material stays out of API pods; simplest production-ready boundary | One additional image and deployment; worker lifecycle and queue depth need monitoring | Recommended now |
| Kubernetes Job per build | Fresh filesystem and process namespace for every tenant build; hard resource and deadline limits; easy forensic retention or teardown | More scheduler latency and control-plane work; requires a job launcher, completion reconciliation, and stronger retry idempotency | Recommended evolution |

## Runtime flow

```text
browser
  |
  | POST /apps/:slug/builds
  v
API -- validate target, platform, ownership, and readiness
  |
  | enqueue build id only
  v
build queue ---> app-builder worker ---> object storage
                     |                       |
                     | status + metadata     | presigned or API-streamed download
                     v                       v
                  database <-------------- API
```

The queue payload should contain identifiers, not decrypted credentials or customer configuration snapshots. The worker reloads the build, app, distribution, and credential inside the job's organization scope immediately before execution. This keeps the database as the source of truth and prevents secrets from living in Redis.

## Image contents

The API image keeps only the application runtime and production dependencies. The builder image adds:

- Bun for `tui` and `binary` compilation.
- Node and `npx`, plus the pinned Electron and `electron-builder` dependencies, for desktop artifacts.
- `rcodesign` for macOS signing and notarization.
- `osslsigncode` for Windows signing.
- The terminal client entry point and desktop shell assets referenced by `APP_BUILD_CLIENT_ENTRY` and `APP_BUILD_DESKTOP_SHELL`.

Pin tool versions in the image and publish its digest alongside the API release. Build records should store the builder image digest and tool versions so an artifact can be reproduced and audited later.

## Security boundary

The worker should run as a non-root user with a read-only root filesystem and an ephemeral, size-limited scratch volume. It needs no inbound Service. Give it only the database/queue reads required by the job, write access to the artifact prefix, and narrowly scoped egress for pinned Electron downloads and signing/notarization endpoints.

Signing credentials are decrypted only after the worker claims a build. Write them with mode `0600`, pass passwords through files or stdin rather than arguments, and remove credential files before deleting the scratch directory. Never place certificates, private keys, passwords, or provider keys in queue payloads, build logs, pod environment variables, or Kubernetes Job specs.

Set CPU, memory, ephemeral-storage, wall-clock, output-size, and concurrency limits per build. A failed or timed-out build must still run cleanup and persist a terminal status. Queue retries must be idempotent: a retry may replace the artifact for the same build id, but it must not create another build record or publish a partially signed file.

## Readiness and rollout

`GET /apps/:slug/distributions/:target/capabilities` should report the worker fleet's capability, not the API pod's local binaries. Publish a short-lived readiness record from each worker containing its image digest, platforms, compiler versions, signing tools, and last heartbeat; the API aggregates healthy workers by target and platform.

Roll out in four steps:

1. Build the dedicated image and run the existing queue processor in a separate deployment. Remove build binaries and the processor from the API deployment.
2. Add worker heartbeats and make the capabilities endpoint read them. Keep the UI refusal when no compatible worker is healthy.
3. Add per-target resource classes and autoscale from queue depth and oldest-job age.
4. Introduce an optional Kubernetes Job launcher using the same image and build contract for high-isolation tenants or signing workloads.

The staging warning that Bun is absent is useful evidence: the UI is correctly refusing a build, but installing Bun into the API pod is not the production fix. Deploying a compatible builder worker is.
