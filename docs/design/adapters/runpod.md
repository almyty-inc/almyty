# RunPod adapter (`runpod`)

RunPod **Serverless**, running RunPod's own vLLM worker. RunPod operates
the workers, the queue, the autoscaler and the OpenAI-compatible route;
almyty supplies a Hugging Face repo id. Implementation:
`backend/src/modules/model-deployments/adapters/runpod.adapter.ts`.

## Verified (2026-09-09)

**1. Is there a managed inference product?** Yes, RunPod Serverless with a
first-party worker image. "The easiest way to deploy a vLLM worker is
through Runpod's ready-to-deploy repos", and the endpoint "is compatible
with both the OpenAI client and Runpod's native API". RunPod is a GPU
cloud, so the adjacent products (Pods, GPU instances) are raw compute and
out of scope; Serverless is the managed one.
https://docs.runpod.io/serverless/vllm/get-started

**2. What can be served?** "vLLM supports thousands of models on Hugging
Face and an ever-growing list of transformer architectures, including
Llama, Mistral, Qwen, Gemma, Phi, and DeepSeek", public, gated or private
with a token. Not a catalog: any repo vLLM can load.
https://www.runpod.io/blog/run-vllm-on-runpod-serverless

**3. Native way to point at a model.** The worker's `MODEL_NAME`
environment variable: "Path of the model weights" -- "Local folder or
Hugging Face repo ID". `MODEL_REVISION` pins the revision, `HF_TOKEN`
unlocks a gated or private repo. There is no S3, URL or object-storage
source on the stock worker.
https://github.com/runpod-workers/worker-vllm

**4. REST surface** (control plane `https://rest.runpod.io/v1`,
`Authorization: Bearer <api key>`):

| Operation | Method | Path |
|-----------|--------|------|
| create template | POST | `/templates` |
| delete template | DELETE | `/templates/{id}` |
| create endpoint | POST | `/endpoints` |
| list endpoints | GET | `/endpoints` |
| read endpoint | GET | `/endpoints/{endpointId}` |
| update / scale | PATCH | `/endpoints/{endpointId}` |
| delete endpoint | DELETE | `/endpoints/{endpointId}` |

`POST /templates` takes `name`, `imageName`, `isServerless`, `env` (the
only secret channel RunPod offers a serverless template),
`containerDiskInGb`, `ports`, `volumeInGb`, `volumeMountPath`; returns
`id`. `POST /endpoints` takes `name`, `templateId`, `computeType`
(`GPU`/`CPU`), `gpuTypeIds`, `gpuCount`, `workersMin`, `workersMax`,
`idleTimeout` (1..3600 s), `scalerType` (`QUEUE_DELAY`/`REQUEST_COUNT`),
`scalerValue`, `flashboot`, `dataCenterIds`, `networkVolumeId`,
`executionTimeoutMs`. `GET /endpoints/{id}` returns `id`, `name`,
`templateId`, `workersMin`, `workersMax`, `gpuTypeIds`, `gpuCount`,
`dataCenterIds`, `env`, `idleTimeout`, `scalerType`, `scalerValue`,
`createdAt`; there is no endpoint-level status field. `PATCH` accepts the
same scaling fields.

Data plane `https://api.runpod.ai/v2/{endpoint_id}`:

```
GET https://api.runpod.ai/v2/{endpoint_id}/health
{ "jobs": { "completed": 1, "failed": 5, "inProgress": 0, "inQueue": 2, "retried": 0 },
  "workers": { "idle": 0, "running": 0 } }
```

The OpenAI-compatible base is
`https://api.runpod.ai/v2/{ENDPOINT_ID}/openai/v1`, with the same API key
as the bearer and the model named either by the Hugging Face repo id or by
`OPENAI_SERVED_MODEL_NAME_OVERRIDE`.
https://docs.runpod.io/api-reference/endpoints/GET/endpoints/endpointId
https://docs.runpod.io/api-reference/templates/POST/templates
https://docs.runpod.io/serverless/endpoints/operation-reference
https://docs.runpod.io/serverless/vllm/openai-compatibility

**5. Cost signals.** RunPod bills serverless workers per second. Its REST
API v2 announcement says billing endpoints exist ("Combined with the
billing endpoints, you can query available hardware, deploy against it,
monitor the workload, and reconcile the cost"), but no billing path or
response body is in the API reference, so nothing was verified well enough
to call. `costSnapshot` stays on the configured rate.
https://www.runpod.io/blog/runpods-rest-api-v2-is-here-one-api-for-your-entire-gpu-stack
https://docs.runpod.io/serverless/pricing

## What the adapter does

- `deploy` creates a serverless template (RunPod's `worker-v1-vllm` image
  plus the vLLM environment) and an endpoint pointing at it.
- `readEndpoint` reads the endpoint and its `/health`. `workersMax === 0`
  is `stopped`; live workers are `ready`; `workersMin === 0` with a
  non-zero ceiling is `ready` with 0 replicas, because the endpoint is up
  and cold-starts on the next request; otherwise `deploying`.
- `scale(n)` PATCHes `workersMin`; `scale(0)` sets both bounds to 0, the
  only way to stop a serverless endpoint answering.
- `teardown` deletes the endpoint, then the template.

## Deltas from the spec

- **`registrySources` is `['hub']`.** The stock worker reads the Hub or a
  path already inside the container. An `s3://` version is refused with
  `ADAPTER_UNSUPPORTED_SOURCE`.
- **Secrets are template env.** RunPod has no secret store for serverless
  templates, so `HF_TOKEN` is written into the template's `env`. Nothing
  secret is kept on the `EndpointRef`.
- **Region** is `dataCenterIds`; `desired.region` becomes one id.
- **Cost.** `hourlyRateCents` per worker times `max(running, workersMin)`.

## Removed in this pass

The S3 branch. It set `ALMYTY_REGISTRY_URI`, `AWS_ENDPOINT_URL` and our
registry access keys in the template environment, pointed `MODEL_NAME` at
`/runpod-volume/almyty/model`, and required either "the almyty worker
image (the stock image plus a fetch step before vLLM starts)" or a network
volume someone had synced by hand. That is a per-provider workaround for a
rule that no longer exists, and it shipped our storage credentials to a
third party. Gone, with the three `registry*` config fields.

## Live suite

`CONFORMANCE_LIVE=runpod` with `RUNPOD_API_KEY`. Never in CI.
