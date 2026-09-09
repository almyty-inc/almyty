# Nebius adapter (`nebius`)

One GPU VM per deployment on Nebius AI Cloud compute, running the vLLM OpenAI container. Implementation: `backend/src/modules/model-deployments/adapters/nebius.adapter.ts`.

## Which path and why

Two Nebius products were checked:

- **Nebius Token Factory (formerly AI Studio) dedicated endpoints.** Verified: `POST https://api.tokenfactory.nebius.com/v0/dedicated_endpoints` with `name`, `model_name`, `flavor_name`, `gpu_type` (gpu-l40s-d | gpu-l40s-a | gpu-h100-sxm | gpu-h200-sxm | gpu-b200-sxm | gpu-b200-sxm-a | gpu-b300-sxm), `gpu_count`, `region`, `scaling.{min_replicas (>= 1), max_replicas}`, optional `custom_weights_id`; `GET /v0/dedicated_endpoints`, `PATCH` (`enabled`, `scaling`, `gpu_type`, `custom_weights_id`), `DELETE`; templates at `GET /v0/dedicated_endpoints/templates`; status `deployment.status` in starting | running | updating | stopping | stopped | error plus `readiness`; inference through the routing key at a regional `https://api.tokenfactory.<region>.nebius.com/v1`. Billing is per running replica; stopped endpoints bill nothing. **Custom weights are a beta enabled by support** with no documented upload API, so an S3 registry version cannot reach a dedicated endpoint through the public API today. That fails the contract's "S3 alone" rule.
- **Nebius compute** (the path taken). REST gateway transcodes the gRPC API; instances and disks are plain resources with Operation replies.

When the custom weights hub is public, a `nebius-token-factory` adapter for the dedicated endpoints API above is the better managed path; this adapter stays the raw compute one.

## Verified against the docs (2026-09-08)

- REST base `https://api.eu.nebius.cloud` (docs.nebius.com/rest-api): `POST /compute/v1/instances`, `GET /compute/v1/instances/{id}`, `DELETE /compute/v1/instances/{id}`, `POST /compute/v1/instances/{id}:start`, `POST /compute/v1/instances/{id}:stop`; `POST /compute/v1/disks`, `GET /compute/v1/disks/{id}`, `DELETE /compute/v1/disks/{id}`. Mutations return an Operation `{ id, resourceId, done }`.
- Instance spec (nebius/api `compute/v1/instance.proto`): `resources.platform` (a platform name such as `gpu-h100-sxm`, `gpu-l40s-a`, `cpu-d3`), `resources.preset` (for example `1gpu-16vcpu-200gb`), `bootDisk.{attachMode: READ_WRITE, existingDisk.id}`, `networkInterfaces[].{name, subnetId, ipAddress, publicIpAddress}`, `cloudInitUserData` (max 32768 chars). Status `state` in CREATING | UPDATING | STARTING | RUNNING | STOPPING | STOPPED | DELETING | ERROR; `status.networkInterfaces[].publicIpAddress.address`.
- Disks are created from an image family (`sourceImageFamily.imageFamily`, e.g. `ubuntu22.04-cuda12`) with `type` and `sizeGibibytes`, and must be READY before an instance references them.
- IAM (docs.nebius.com/rest-api/authentication): `POST https://auth.eu.nebius.com/oauth2/token/exchange` form `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token_type=urn:ietf:params:oauth:token-type:access_token`, `subject_token=<RS256 JWT with kid, iss=sub=service account id, exp <= 5 min>`, `subject_token_type=urn:ietf:params:oauth:token-type:jwt`; response `access_token`, `issued_token_type`, `token_type: Bearer`, `expires_in`; tokens live 12 hours. Requests carry `Authorization: Bearer <token>`.
- gRPC-gateway errors are `{ code, message }`; quota failures surface as RESOURCE_EXHAUSTED.

## Deltas from the spec

- **Two resources per deployment.** A boot disk is created first (polled until READY, bounded by the adapter's `diskWait`), then the instance. If the instance fails to create the disk is deleted so nothing bills. Teardown deletes the instance, then the disk; a disk delete that races the detach is swallowed and left for the next sweep.
- **Auth.** `accessToken` (12 h IAM token) or a service account authorized key: `serviceAccountId`, `publicKeyId` and the PEM `privateKey`; the JWT is signed with Node's crypto and the exchanged token is cached per key until five minutes before expiry. Nothing secret is stored on the ref.
- **One replica per VM.** `scale(n > 1)` and `desired.replicas > 1` are refused. `scale(0)` issues `:stop`, `scale(1)` issues `:start`. A stopped VM bills only its disk, so `scaleToZero` is `true` and the compute rate is reported as 0 while stopped.
- **Readiness is a probe.** RUNNING plus a public address plus `GET http://<ip>:8000/v1/models` answering is `ready`.
- **Weights arrive through cloud-init**, identical to the DigitalOcean path: root-only `/opt/almyty/env`, Docker and the NVIDIA container toolkit installed if the image lacks them, S3 sync via the `amazon/aws-cli` container, vLLM with `--restart unless-stopped`. Hub versions pull from the Hub directly.
- **Endpoint is plain HTTP on the public address.** Restrict it by security group or front it before use.
- **Cost.** Nebius exposes no spend API; `costSnapshot` uses the configured `hourlyRateCents` while the VM is not stopped.
- **Region** is implied by the API host and subnet (the EU gateway by default); `apiHost` and `authHost` are configurable for other regions.

## Live suite

`CONFORMANCE_LIVE=nebius` with `NEBIUS_SA_ID`, `NEBIUS_KEY_ID`, `NEBIUS_PRIVATE_KEY`, `NEBIUS_PARENT_ID`, `NEBIUS_SUBNET_ID`, optional `NEBIUS_PLATFORM`, `NEBIUS_PRESET`. Never in CI.
