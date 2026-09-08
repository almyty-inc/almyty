# DigitalOcean adapter (`digitalocean`)

One GPU Droplet per deployment running the vLLM OpenAI container. Implementation: `backend/src/modules/model-deployments/adapters/digitalocean.adapter.ts`.

## Verified against the docs (2026-09-08)

- API v2 at `https://api.digitalocean.com/v2`, `Authorization: Bearer <token>` (docs.digitalocean.com/reference/api/reference/droplets).
- `POST /droplets` with `name`, `region`, `size`, `image`, `ssh_keys`, `backups`, `ipv6`, `monitoring`, `tags`, `user_data` (cloud-config, max 64 KiB), `vpc_uuid`; returns 202 with `droplet.{id, status, size_slug, size.price_hourly, region.slug, networks.v4[].{ip_address,type}}`. `status` is new | active | off | archive.
- `GET /droplets/{id}` returns the same envelope; 404 `{ id: "not_found", message }` when gone.
- `POST /droplets/{id}/actions` with `type` power_off | power_on | shutdown; returns `action.status` in-progress | completed | errored.
- `DELETE /droplets/{id}` returns 204.
- Errors: `{ id, message, request_id }` with 401 unauthorized, 404 not_found, 422 unprocessable_entity (droplet limit reached), 429 too_many_requests (5000/h, 250/min).
- GPU sizes: `gpu-h100x1-80gb`, `gpu-h100x8-640gb`, `gpu-h200x1-141gb`, `gpu-h200x8-1128gb`, `gpu-l40sx1-48gb`, `gpu-4000adax1-20gb`, `gpu-6000adax1-48gb`, `gpu-mi300x1-192gb`, `gpu-mi300x8-1536gb`. Images: `gpu-h100x1-base` (CUDA toolkit, pinned driver, nvidia-container-toolkit), `gpu-h100x8-base`, `gpu-amd-base`, plus an inference-optimized image that ships Docker and `vllm-openai`.

## Deltas from the spec

- **Powered off still bills.** DigitalOcean charges a droplet at its full hourly rate while it exists, on or off. `scale(0)` powers the droplet off (compute stops, cost does not), so `capabilities().scaleToZero` is `false` and `costSnapshot` keeps reporting `size.price_hourly` for an `off` droplet. Only `teardown` (delete) stops the bill.
- **One replica per droplet.** `scale(n > 1)` and `desired.replicas > 1` are refused with `ADAPTER_UNSUPPORTED_OPERATION`.
- **Readiness is a probe.** `active` plus a public IPv4 address plus `GET http://<ip>:8000/v1/models` answering is `ready`; an active droplet whose container is still pulling weights is `deploying`.
- **Weights arrive through cloud-init.** `user_data` writes a root-only `/opt/almyty/env` (registry keys or `HF_TOKEN`), installs Docker if the image lacks it, syncs an S3 version with the `amazon/aws-cli` container (`--endpoint-url` for non-AWS registries), and runs `vllm/vllm-openai` with `--restart unless-stopped` so it comes back after `power_on`. Hub versions pass `--model org/repo --revision rev`.
- **Endpoint is plain HTTP on the public address.** vLLM listens on 8000 with no TLS or auth; put the droplet in a VPC and front it, or restrict the gateway to it, before exposing it. The adapter tags droplets `almyty` and `almyty-deployment:<id>` for cleanup.
- **Cost** comes from `droplet.size.price_hourly` on every read (cents, rounded); `hourlyRateCents` is only a fallback when the API omits it.
- **Gradient AI Platform.** DigitalOcean's Gradient platform advertises "BYOM" dedicated GPU endpoints, but the public API reference documents only serverless inference on hosted foundation models, agents and knowledge bases; no custom weights upload or deployment endpoint is documented. The droplet path is therefore the implemented one; revisit when Gradient exposes a custom model API.

## Live suite

`CONFORMANCE_LIVE=digitalocean` with `DIGITALOCEAN_TOKEN`, optional `DIGITALOCEAN_REGION`. Never in CI.
