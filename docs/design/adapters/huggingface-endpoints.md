# Hugging Face Inference Endpoints adapter (`huggingface-endpoints`)

Dedicated, autoscaling endpoints that Hugging Face runs for you on AWS,
GCP or Azure, built from a repository on the Hub. Implementation:
`backend/src/modules/model-deployments/adapters/huggingface-endpoints.adapter.ts`.

## Verified (2026-09-09)

**1. The managed product, and whether there is a serverless option.**
Inference Endpoints is the **dedicated** product: "Inference Endpoints
offers a secure production solution to easily deploy any model from the
Hub on dedicated and autoscaling infrastructure managed by Hugging Face."
There is no serverless mode inside it. Hugging Face's serverless offer is
a **different product**, Inference Providers, which routes a request to a
third-party provider and deploys nothing of yours; it is a call-only
integration and not this adapter's job. There is also a **catalog** of
one-click deployable models, surfaced on an endpoint as the read-only
`model.fromCatalog` flag; it is a UI template over the same create call.
https://huggingface.co/docs/inference-endpoints/index
https://huggingface.co/docs/inference-providers/index

**2. What model sources the product accepts.** One: **a Hugging Face
repository**. In the OpenAPI spec (`https://api.endpoints.huggingface.cloud/openapi.json`,
`HF Inference Endpoints API` 2.0.0) `EndpointModel` requires
`repository`, `framework` and `image`, and `repository` is documented as
"HuggingFace model repository (e.g. `meta-llama/Llama-2-7b-hf`)", with an
optional `revision` ("Git commit SHA or branch name (defaults to latest
main)"). Even a **custom container** is built this way: "select a model
repository (which will be mounted at `/repository` inside the container)",
and "The Model Artifacts (weights) are stored under `/repository`". There
is no field anywhere in the create body that names object storage, a URL,
or an upload. So: their catalog is the Hub itself, a fine-tune is just a
repo you pushed, and there is no upload API.

A private repo in the caller's own namespace is reachable with the token
that creates the endpoint. A gated or third-party repo is authenticated
with the container secret `HF_TOKEN`: `EndpointModel.secrets` is
"Secret environment variables (values are encrypted at rest)" and the
spec's own example is `{"HF_TOKEN": "hf_xxx"}`. That is the customer's
Hub token, held by Hugging Face, not by us.
https://huggingface.co/docs/inference-endpoints/engines/custom_container
https://huggingface.co/docs/inference-endpoints/guides/create_endpoint

**3. REST surface** (`https://api.endpoints.huggingface.cloud`, bearer
token, scopes marked `[READ]` / `[WRITE]`):

| Operation | Method | Path |
|-----------|--------|------|
| create | POST | `/v2/endpoint/{namespace}` |
| list | GET | `/v2/endpoint/{namespace}` |
| read | GET | `/v2/endpoint/{namespace}/{name}` |
| update / scale | PUT | `/v2/endpoint/{namespace}/{name}` |
| scale to zero | POST | `/v2/endpoint/{namespace}/{name}/scale-to-zero` |
| pause | POST | `/v2/endpoint/{namespace}/{name}/pause` |
| resume | POST | `/v2/endpoint/{namespace}/{name}/resume` |
| delete | DELETE | `/v2/endpoint/{namespace}/{name}` |
| providers and prices | GET | `/v2/provider` (public) |
| quotas | GET | `/v2/provider/quotas/{namespace}` |

`Endpoint` requires `name` (lowercase alphanumeric and `-`, at most 32
characters), `type`, `provider`, `compute`, `model`. `EndpointType` is
`public | authenticated | private` -- there is no `protected`.
`EndpointProvider` is `{vendor, region}`. `EndpointCompute` is
`{accelerator, instanceType, instanceSize, scaling}` with `Accelerator` in
`cpu | gpu | neuron | zero_gpu`, and `EndpointScaling` is
`{minReplica, maxReplica, scaleToZeroTimeout}` where "Minimum number of
replicas (set to 0 to enable scale-to-zero)" and the timeout is "Minutes
of inactivity before scaling to zero (default: 15, requires
minReplica=0)". `EndpointModelImage` is a `oneOf` keyed by engine --
`vLLM`, `vLLMOmni`, `vLLMNeuron`, `sGLang`, `tgi`, `tgiNeuron`, `tei`,
`llamacpp`, `hfServe`, `huggingface`, `huggingfaceNeuron`, `custom` --
and every one of them extends `BaseContainer`, which requires `url` and
takes `port` and `healthRoute`. `EndpointFramework` is
`custom | pytorch | llamacpp`. Update is `PUT` with `EndpointUpdate`;
there is no PATCH.

`EndpointStatus.state` is `pending | initializing | updating |
updateFailed | running | paused | failed | scaledToZero`, alongside
`url`, `readyReplica`, `targetReplica`, `message`, `errorMessage` and
`lastUsedAt`.

The OpenAI-compatible chat URL is the endpoint's own host: the create and
read responses carry `status.url`
(`https://endpoint-id.region.vendor.endpoints.huggingface.cloud`), and the
serving engine exposes the OpenAI routes under `/v1` on it, so chat goes
to `<status.url>/v1/chat/completions`. vLLM's own deployment guide
confirms the engine container form used here
(`--engine vllm --custom-image vllm/vllm-openai:v0.23.0 --port 8000`).
https://huggingface.co/docs/inference-endpoints/api_reference
https://docs.vllm.ai/en/stable/deployment/frameworks/hf_inference_endpoints/

**4. Cost signals.** A **price list, not a usage API**. `GET /v2/provider`
is public and returns, for every vendor and region, a `Compute` per
instance type carrying `pricePerHour` ("Cost per replica per hour (USD)")
plus a `quota` of `{maxAccelerators, usedAccelerators}`. Read live on
2026-09-09 it offers aws `eu-west-1`, `us-east-1`, `us-east-2`,
`us-west-2`; azure `eastus`; gcp `us-east4`, with GPU instance types
`nvidia-t4`, `nvidia-a10g`, `nvidia-l4`, `nvidia-l40s`, `nvidia-a100`,
`nvidia-h100`, `nvidia-h200`, `nvidia-rtx-pro-6000` (for example
`aws-us-east-1-nvidia-t4-x1` at $0.60/hour). Nothing in the API reports
money already spent.

## What the adapter does

- `deploy` POSTs the endpoint with `model.repository` and, when the
  version pins one, `model.revision`, on the configured engine image.
  A gated repo's token goes in `model.secrets.HF_TOKEN`.
- `readEndpoint` maps `EndpointState` onto the contract's states and sets
  `openAiBase` to `<status.url>/v1`.
- `scale(0)` POSTs `scale-to-zero`; `scale(n)` PUTs the replica bounds and
  then POSTs `resume`.
- `teardown` DELETEs the endpoint.
- `costSnapshot` prices a replica from `GET /v2/provider`, matched on the
  endpoint's vendor, region, instance type and size, and falls back to
  `hourlyRateCents`.

## Deltas from the spec

- **`registrySources` is `['hub']` and only that.** There is no way to
  serve weights that do not live in a Hub repository, so an `s3://`
  version is refused up front with `ADAPTER_UNSUPPORTED_SOURCE` naming
  `hf://owner/repo[@revision]`.
- **Cost is a rate, not a reading.** No usage API exists, so spend is the
  published price over observed uptime.
- **Regions are a snapshot.** `capabilities().regions` lists what
  `GET /v2/provider` offered on 2026-09-09; the live list is authoritative
  and `providerConfig.region` accepts anything.

## Removed in this pass

The previous adapter carried a **placeholder repository**: because
`EndpointModel.repository` is required, an S3 registry version was
deployed against a fixed `almyty/registry-placeholder` repo, with the
real registry URI passed as the container env `ALMYTY_REGISTRY_URI` and
our object-storage keys passed as endpoint secrets `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, in the hope that a vLLM container would ignore
the mounted repo and fetch the weights itself. That is a workaround
around the product, not a use of it, and it handed our registry
credentials to a third party. Gone with it: the `registryAccessKeyId`,
`registrySecretAccessKey` and `registryEndpoint` config fields.

Two smaller corrections came out of re-reading the spec: the endpoint
type was being sent as `protected`, which is not a member of
`EndpointType`; and `env`/`secrets` were being nested inside
`image.custom` with a snake_case `health_route`, when they belong on
`model` and the container field is `healthRoute`.

## Live suite

`CONFORMANCE_LIVE=huggingface-endpoints` with `HF_TOKEN` (Inference
Endpoints write scope) and `HF_NAMESPACE`. Deploys
`hf://Qwen/Qwen3-0.6B@main` on an `nvidia-t4`. Never in CI.
