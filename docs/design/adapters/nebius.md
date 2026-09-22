# Nebius adapter (`nebius`)

Nebius **Token Factory** dedicated endpoints: an isolated, managed
deployment of a supported model, operated by Nebius, called over their
OpenAI-compatible API. Implementation:
`backend/src/modules/model-deployments/adapters/nebius.adapter.ts`.

## Verified (2026-09-09)

**1. Is there a managed inference product?** Yes. Nebius Token Factory
(formerly Nebius AI Studio; `docs.studio.nebius.com` 301s to
`docs.tokenfactory.nebius.com`). It has public serverless endpoints over a
model catalog, and **dedicated endpoints**: "A dedicated endpoint is an
isolated deployment of a supported model template, created and managed
through a control plane API."
https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/deploy-api
https://nebius.com/services/token-factory/inference-service

**2. What can be served?** A model template from Nebius' catalog, and, for
eligible models, custom weights: "Custom weights support is supported for
eligible models" on dedicated endpoints, versus base models only on public
endpoints. Not an arbitrary Hugging Face repo, and not arbitrary weights.
https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/overview

**3. Native way to point at a model.** `model_name` plus `flavor_name`,
taken from `GET /v0/dedicated_endpoints/templates`, which "returns valid
combinations of model_name, flavor_name, gpu_type, gpu_count, and region".
A fine-tune is attached with `custom_weights_id` on create or update.
Custom weights come out of the Custom Weights Hub, which is fed by Nebius'
own post-training runs: "Trained custom models land in Custom Weights, and
from there they attach to a Dedicated Endpoint with the base model". There
is **no upload API and no object-storage ingest**: the feature is
"currently in beta and available on request", enabled by Nebius support,
and "At launch, deployment is reviewed by solutions engineers".
https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/custom-weights
https://nebius.com/blog/posts/dedicated-endpoints-and-custom-weights-hub

**4. REST surface** (control plane `https://api.tokenfactory.nebius.com`,
`Authorization: Bearer <API token>`):

| Operation | Method | Path |
|-----------|--------|------|
| list templates | GET | `/v0/dedicated_endpoints/templates` |
| create | POST | `/v0/dedicated_endpoints` |
| list | GET | `/v0/dedicated_endpoints` |
| read | GET | `/v0/dedicated_endpoints/{endpoint_id}` |
| update / scale | PATCH | `/v0/dedicated_endpoints/{endpoint_id}` |
| delete | DELETE | `/v0/dedicated_endpoints/{endpoint_id}` |

`DedicatedEndpointCreateRequest`: `name` (1-100), `description` (<=500),
`model_name`, `flavor_name`, `gpu_type` (`gpu-l40s-d`, `gpu-l40s-a`,
`gpu-h100-sxm`, `gpu-h200-sxm`, `gpu-b200-sxm`, `gpu-b200-sxm-a`,
`gpu-b300-sxm`), `gpu_count` (>= 0), `region` (`eu-north1`, `us-central1`,
`eu-west1`, `tf-us1`, ... ), `scaling.{min_replicas, max_replicas}` (each
>= 1), optional `routing_key` (11-128 chars, must start with
`dedicated/`), optional `custom_weights_id`, optional
`reservation_policy`. The 201 returns the endpoint plus `id`, `enabled`,
`deployment.{ready_replicas, status, readiness}` and `created_at`.
`DedicatedEndpointUpdateRequest` takes `name`, `description`,
`routing_key`, `enabled`, `gpu_type`, `gpu_count`, `custom_weights_id`,
`scaling`.

`DeploymentStatus` is `starting | running | updating | stopping | stopped
| error`; `DeploymentReadiness` is `ready | partially_ready | not_ready`.
"Use Readiness to decide whether to send traffic": `ready` is "fully
provisioned and ready for expected traffic", `partially_ready` "can serve
traffic, but below expected capacity", `not_ready` "cannot reliably serve
requests".

Chat is the region's data plane, with the `routing_key` as the model:

```bash
curl -sS "https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{ "model": "<routing_key>", "messages": [{"role":"user","content":"Hello"}] }'
```

"Initial deployment can take several minutes. While provisioning,
inference may fail (often `404`) until the endpoint is routable."
https://docs.tokenfactory.nebius.com/api-reference/dedicated-endpoints/create-dedicated-endpoint
https://docs.tokenfactory.nebius.com/api-reference/dedicated-endpoints/update-dedicated-endpoint
https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/operating
https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/lifecycle-and-status

**5. Cost signals.** No usage API. Spend is shown in the console Usage
tab. The billing policy says only that "A dedicated endpoint is considered
active, accessible, and billable when at least one replica is running" and
"Scaling above or below minimum replicas adjusts billing dynamically on a
PAYG basis".
https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/billing-policy
https://docs.tokenfactory.nebius.com/other-capabilities/billing-new

## What the adapter does

- `deploy` POSTs a dedicated endpoint with `model_name` and `flavor_name`.
  A `nebius://model/flavor` version names both directly; an `hf://org/repo`
  version uses `org/repo` as `model_name` (Nebius names templates after
  the upstream repo) and `providerConfig.flavorName` for the flavor. A
  fine-tune is `providerConfig.customWeightsId`.
- `readEndpoint` folds status and readiness together: `running` +
  `ready`/`partially_ready` is `ready`; `running` + `not_ready` is
  `deploying`; `starting` is `deploying`; `updating` is `scaling`;
  `stopping`/`stopped` and `enabled: false` are `stopped`; `error` is
  `failed`; 404 is `missing`.
- `scale(0)` PATCHes `{ enabled: false }`, which is the documented way to
  stop a dedicated endpoint given `min_replicas` cannot go below 1;
  `scale(n)` PATCHes `{ enabled: true, scaling: {...} }`.
- `teardown` DELETEs the endpoint.

## Deltas from the spec

- **`registrySources` is `['hub']`, and narrowly.** The hub repo must
  correspond to a Nebius model template; anything else is refused at
  create time by Nebius. An `s3://` version is refused up front with
  `ADAPTER_UNSUPPORTED_SOURCE`.
- **We cannot register a fine-tune.** Custom weights is a beta with no
  upload route. `customWeightsId` is an operator-supplied id for weights
  Nebius already holds. almyty never ships bytes.
- **The data-plane host is derived from the region** as
  `https://api.tokenfactory.<region>.nebius.com/v1`, verified for
  `us-central1`; `providerConfig.dataPlaneHost` overrides it for any
  region whose host differs.
- **Cost is a rate, not a reading.** No usage API, so `costSnapshot`
  multiplies `hourlyRateCents` (per GPU per replica) by
  `gpu_count * ready_replicas`.

## Removed in this pass

The previous adapter was not Token Factory at all: it created a boot disk
and a GPU **compute instance** on Nebius AI Cloud
(`https://api.eu.nebius.cloud/compute/v1`), signed an RS256 service-account
JWT to exchange for an IAM token, and booted vLLM through cloud-init that
pulled the weights out of our S3 registry with credentials written into a
root-only env file on the VM. Its own doc justified this by saying Token
Factory custom weights are a support-gated beta -- true, and irrelevant:
almost every version we would deploy there is a catalog model, and the ones
that are not simply are not deployable on Nebius today. Gone: the compute
API, the disk lifecycle, the JWT exchange, the cloud-init, the registry
credentials.

## Live suite

`CONFORMANCE_LIVE=nebius` with `NEBIUS_API_TOKEN`, optional
`NEBIUS_REGION`. Never in CI.
