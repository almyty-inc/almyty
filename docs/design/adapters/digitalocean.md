# DigitalOcean adapter (`digitalocean`)

DigitalOcean Gradient AI **Dedicated Inference**: a managed inference
service DigitalOcean operates, which serves a model on dedicated GPUs
behind an OpenAI-compatible HTTPS endpoint. Implementation:
`backend/src/modules/model-deployments/adapters/digitalocean.adapter.ts`.

**Dedicated Inference is a DigitalOcean public preview.** An account has
to enable it from the Feature Preview page in the control panel before
any call works, and the API may change under us. The adapter declares
`availability: 'public_preview'` so the form says so before anything is
created, and a 403 from the dedicated-inference routes is reported as
`ADAPTER_PREVIEW_NOT_ENABLED` naming the opt-in, rather than as a
rejected credential: a token that works everywhere else on the
DigitalOcean API is still refused here until the preview is on.

## Verified (2026-09-09)

**1. Is there a managed inference product?** Yes, two of them.

- Serverless Inference: DigitalOcean-hosted foundation models on a single
  OpenAI-compatible base, `https://inference.do-ai.run/v1`, bearer model
  access key. Catalog only, no model of ours.
  https://docs.digitalocean.com/products/inference/how-to/si-endpoints/
- Dedicated Inference: "A managed inference service that lets you host and
  scale open-source and commercial LLMs on dedicated GPUs", vLLM under the
  hood, "Clients send OpenAI-compatible API requests (for example, HTTPS to
  /v1/chat/completions-style routes)". This is the one we deploy into.
  https://docs.digitalocean.com/products/inference/details/features/
  https://www.digitalocean.com/blog/dedicated-inference-technical-deep-dive
- Batch Inference and an Inference Router also exist; neither serves a
  model we supply.

**2. What can be served?** Dedicated Inference serves a Hugging Face
repository directly, and any model imported into the Model Catalog through
BYOM. "The platform supports Bring Your Own Models (BYOM), allowing you to
import models from: Hugging Face (including gated models), DigitalOcean
Spaces." Constraints: "Only Safetensors files with accompanying JSON, YAML,
and documentation files are supported. Only dedicated inference-compatible
architectures are supported, including `Qwen2ForCausalLM` and
`Qwen3ForCausalLM`."
https://docs.digitalocean.com/products/inference/how-to/import-models/

**3. Native way to point at a model.** A Hugging Face repo id in
`model_slug` with `model_provider: "hugging_face"`, plus
`access_tokens.hugging_face_token` for a gated repo. DigitalOcean Spaces is
a *BYOM import* source, not a deployment source: the import is Control
Panel only ("To use BYOM, import models using the Control Panel"), and it
produces a catalog entry under **My Models** which is then selected in a
deployment. There is no documented REST route for the import itself.

**4. REST surface** (base `https://api.digitalocean.com`, bearer PAT):

| Operation | Method | Path |
|-----------|--------|------|
| create | POST | `/v2/dedicated-inferences` |
| list | GET | `/v2/dedicated-inferences` |
| read | GET | `/v2/dedicated-inferences/{id}` |
| update / scale | PATCH | `/v2/dedicated-inferences/{id}` |
| delete | DELETE | `/v2/dedicated-inferences/{id}` |
| accelerators | GET | `/v2/dedicated-inferences/{id}/accelerators` |
| tokens | GET / POST | `/v2/dedicated-inferences/{id}/tokens` |
| revoke token | DELETE | `/v2/dedicated-inferences/{id}/tokens/{token_id}` |
| sizes | GET | `/v2/dedicated-inferences/sizes` |
| gpu model config | GET | `/v2/dedicated-inferences/gpu-model-config` |
| CA certificate | GET | `/v2/dedicated-inferences/{id}/ca-certificate` |

Create body, verbatim from the reference:

```json
{
  "spec": {
    "version": 1,
    "name": "new-dedicated-inference",
    "region": "atl1",
    "vpc": { "uuid": "997615ce-132d-4bae-9270-9ee21b395e5d" },
    "enable_public_endpoint": true,
    "model_deployments": [{
      "model_slug": "mistral/mistral-7b-instruct-v3",
      "model_provider": "hugging_face",
      "workload_config": {},
      "accelerators": [{ "scale": 2, "type": "prefill_decode", "accelerator_slug": "gpu-mi300x1-192gb" }]
    }]
  },
  "access_tokens": { "hugging_face_token": "$HF_TOKEN" }
}
```

202 response carries `dedicated_inference.{id, status, region, endpoints:
{public_endpoint_fqdn, private_endpoint_fqdn}, spec}` and a first `token`
`{ value: "di_...", id, name }`. `status` is one of `new`, `provisioning`,
`updating`, `active`, `deleting`, `error`. Scaling is a PATCH of the same
`spec` with a new `model_deployments[].accelerators[].scale`. The
OpenAI-compatible chat URL is `public_endpoint_fqdn` (or
`private_endpoint_fqdn` inside the VPC) with `/v1` appended; the FQDN
itself carries no version suffix. Auth on the data plane is the dedicated
inference token as a bearer, not the account PAT. Regions: `atl1`, `nyc2`,
`tor1`.
https://docs.digitalocean.com/reference/api/reference/dedicated-inference/
https://docs.digitalocean.com/products/inference/how-to/use-dedicated-inference/
https://docs.digitalocean.com/products/inference/reference/api/

**5. Cost signals.** A price list, no usage API. "Dedicated Inference is
billed per GPU-hour based on the GPU you use": AMD MI300X $2.59, MI300X 8x
$20.70, MI325X $2.98, MI325X 8x $23.82, MI350X $6.89, NVIDIA H100 $4.41,
H100 8x $30.32, H200 $4.47, H200 8x $35.78, B300 $10.39, B300 8x $83.10.
No billing or usage endpoint for a dedicated inference is documented.
https://docs.digitalocean.com/products/inference/details/pricing/

## What the adapter does

- `deploy` POSTs one dedicated inference with a single model deployment.
  `model_slug` comes from an `hf://org/repo` version; `providerConfig`
  may override `modelSlug` and `modelProvider` to select a model already
  imported into the Model Catalog through BYOM.
- `readEndpoint` maps `status`: `new`/`provisioning` to `deploying`,
  `updating` to `scaling`, `active` to `ready`, `deleting` to `stopped`,
  `error` to `failed`, 404 to `missing`. `url` and `openAiBase` are the
  public FQDN plus `/v1`.
- `scale(n)` PATCHes the accelerator `scale`. `teardown` DELETEs.
- The deployment token from the create response is returned on the
  `EndpointRef` so the gateway can call the endpoint; it is the only
  secret on the ref and the caller is expected to store it encrypted.

## Deltas from the spec

- **`registrySources` is `['hub']`.** Dedicated Inference reads a Hugging
  Face repo, or a catalog model DigitalOcean already holds. It cannot read
  our object storage, so an `s3://` version is refused with
  `ADAPTER_UNSUPPORTED_SOURCE` naming what is accepted.
- **A fine-tune needs a Control Panel import first.** BYOM has no REST
  route, so almyty cannot register custom weights on the operator's
  behalf. The operator imports once (from Hugging Face or their own
  Spaces bucket) and then names the resulting model with
  `providerConfig.modelSlug`.
- **Architecture limits are real.** Dedicated Inference documents
  `Qwen2ForCausalLM` and `Qwen3ForCausalLM` among supported
  architectures. The adapter does not pre-screen: DigitalOcean rejects an
  unsupported architecture at create time and that comes back as
  `ADAPTER_UNSUPPORTED_ARCHITECTURE`.
- **Scale to zero is unverified.** The reference gives no minimum for
  `accelerators[].scale`, and billing is per GPU-hour for the accelerators
  that exist, so `capabilities().scaleToZero` is `false` and only
  `teardown` reliably stops the bill.
- **Cost is a rate, not a reading.** No usage API, so `costSnapshot`
  multiplies `hourlyRateCents` (from the price list above, per
  accelerator) by the current scale.

## Removed in this pass

The previous adapter created a GPU Droplet from a GPU base image and drove
a cloud-init that installed Docker, synced weights out of our S3 registry
with the `amazon/aws-cli` container, and ran `vllm/vllm-openai` on port
8000 over plain HTTP. That made almyty the hosting orchestrator and the
weight delivery route. It also recorded, wrongly, that "the public API
reference documents only serverless inference on hosted foundation models"
-- Dedicated Inference and BYOM were already documented. All of the droplet
path is gone: no `/v2/droplets`, no cloud-init, no registry keys.

## Live suite

`CONFORMANCE_LIVE=digitalocean` with `DIGITALOCEAN_TOKEN`, optional
`DIGITALOCEAN_REGION`. Never in CI.
