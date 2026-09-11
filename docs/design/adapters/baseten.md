# Baseten adapter (`baseten`)

Baseten **dedicated deployments** on the Baseten Inference Stack
(BIS-LLM): a config-only deploy of a model whose weights Baseten mirrors
from your source. Implementation:
`backend/src/modules/model-deployments/adapters/baseten.adapter.ts`.

## Verified (2026-09-09)

**1. The managed product, and whether there is a serverless option.** Two
products. **Model APIs** are Baseten's serverless, OpenAI- and
Anthropic-compatible endpoints over their own catalogue of hosted LLMs.
**Dedicated Inference** runs your model on your own replicas with
autoscaling, environments and scale-to-zero; that is this adapter. Within
dedicated, BIS-LLM (v2) is the current engine path and "the deploy is
config-only": "There's no engine build step ... the settings under
`bis_llm.config` are passed to a prebuilt serving image."
https://docs.baseten.co/inference/model-apis/overview
https://docs.baseten.co/engines/bis-llm/bis-llm-config

**2. What model sources the product accepts.** Weights come through the
**Baseten Delivery Network**, which "mirrors model weights to Baseten and
caches them near your replicas". Each `weights[]` entry names a `source`
URI, and BDN supports `hf://` (Hugging Face Hub), `bt://` (Baseten
Training checkpoints), `s3://`, `gs://`, `r2://`, `cw://` and `azure://`.
A Hugging Face repo is the documented default and the example in both the
BDN reference and the `POST /v1/llm_models` code sample
(`{"mount_location": "/models/base", "source": "hf://meta-llama/Llama-3-8B"}`).
For Hugging Face the format is `hf://owner/repo@revision` and "When you
use a branch name like `@main`, Baseten resolves it to the specific commit
SHA at deploy time and mirrors those exact files."

A private or gated source is authenticated by a **per-source `auth`
block**, and the docs are explicit that it is not the same thing as the
top-level secrets config: "BDN authenticates private or gated repos
through this per-source `auth` block, which is separate from the
top-level `secrets` config. A `secrets` entry alone does not authenticate
weight mirroring." `auth` is `{auth_method, auth_secret_name}` with
`auth_method` in `CUSTOM_SECRET`, `AWS_OIDC`, `AWS_ASSUME_ROLE`,
`GCP_OIDC`. For Hugging Face the secret holds the plain token and is
named `hf_access_token` by convention; for S3 with IAM credentials the
secret is named `aws_credentials` and holds
`{"aws_access_key_id", "aws_secret_access_key", "aws_region"}` -- "Use
these exact key names. Common variations like `access_key_id` (without
the `aws_` prefix) cause authentication failures." Baseten does the
mirroring: "The mirror lists objects under your prefix and downloads each
file once."

There is also a model-archive route (`POST /v1/models` with a
`library_listing` source, or a Truss archive staged through
`POST /v1/prepare_model_upload`), which BIS-LLM does not need.
https://docs.baseten.co/development/model/bdn
https://docs.baseten.co/reference/management-api/models/creates-a-model-from-a-source

**3. REST surface** (`https://api.baseten.co/v1`, `Authorization: Bearer
<key>`; the hosted OpenAPI 3.1 spec at `/v1/spec` is authoritative and was
read directly):

| Operation | Method | Path |
|-----------|--------|------|
| create | POST | `/v1/llm_models` |
| new version of one | POST | `/v1/llm_models/{model_id}/deployments` |
| read | GET | `/v1/models/{model_id}/deployments/{deployment_id}` |
| scale | PATCH | `/v1/models/{model_id}/deployments/{deployment_id}/autoscaling_settings` |
| start / stop | POST | `.../activate`, `.../deactivate` |
| delete deployment | DELETE | `/v1/models/{model_id}/deployments/{deployment_id}` |
| delete model | DELETE | `/v1/models/{model_id}` |
| upsert a secret | POST | `/v1/secrets` |
| instance prices | GET | `/v1/instance_type_prices` |
| billing | GET | `/v1/billing/usage_summary` |
| regions | GET | `/v1/regions` |

`CreateLLMModelRequestV1` requires `name` and `resources` and takes
`region`, `llm_version`, `llm_config`, `environment_variables`,
`model_metadata`, `autoscaling_settings`, `additional_autoscaling_config`,
`metadata` and `weights` ("Weight configurations for BDN model weight
distribution"). It answers `LLMModelHandleV1`: `model_id`, `version_id`
(the deployment), `hostname`, `instance_type_name`.
`UpdateAutoscalingSettingsV1` is `{min_replica, max_replica,
autoscaling_window, scale_down_delay, concurrency_target,
target_utilization_percentage, target_in_flight_tokens,
max_scale_down_rate}`, all optional. `DeploymentStatusV1` is
`BUILDING | DEPLOYING | DEPLOY_FAILED | LOADING_MODEL | ACTIVE |
UNHEALTHY | BUILD_FAILED | BUILD_STOPPED | DEACTIVATING | INACTIVE |
FAILED | UPDATING | SCALED_TO_ZERO | WAKING_UP`, alongside
`active_replica_count`, `instance_type_name` and `region {slug,
display_name}`.

`bis_llm.config` keys, from the configuration reference: `engine_backend`
(`vllm` | `trtllm`), `gpuTRTImage`, `checkpoint_name` ("The Hugging Face
repository ID (or mounted path) of the model checkpoint"), `model_name`,
`served_model_name`, `model_path` / `model_path_for_tokenizer` ("Local
paths to the model and its tokenizer when you mount weights with the
top-level `weights` block"), `tensor_parallel_size`, `engine_config` (in
the active engine's own field names -- vLLM's `max_num_seqs`,
`max_num_batched_tokens`, `max_model_len`; TRT-LLM's `max_batch_size`,
`max_num_tokens`, `max_seq_len`), `tokenizer_limit_length`.

The OpenAI-compatible chat URL is per model, on Baseten's host. A
deployment is addressed as
`https://model-{model_id}.api.baseten.co/deployment/{deployment_id}/...`,
and a custom server's routes hang off `sync`, so the OpenAI base is
`.../deployment/{deployment_id}/sync/v1` and chat is
`{base}/chat/completions`. The environment form
`https://model-{model_id}.api.baseten.co/environments/production/sync/v1`
is the same route pinned to an environment instead.
https://docs.baseten.co/reference/management-api/overview
https://docs.baseten.co/inference/calling-your-model
https://docs.baseten.co/reference/inference-api/overview

**4. Cost signals.** A **usage API and a price list**, the fullest of the
four. `GET /v1/billing/usage_summary?start_date&end_date` (range at most
31 days, earliest 2026-01-01) returns `UsageSummaryV1` with
`dedicated_usage` carrying `subtotal`, `credits_used`, `total`, `minutes`
and a **per-deployment `breakdown`**: each `DedicatedItemV1` has a
`billable_resource` (`{id, kind, name, model_id, model_name,
instance_type, ...}`, kind `MODEL_DEPLOYMENT`), `subtotal`,
`compute_cost`, `surcharge_cost`, `minutes`, `inference_requests` and a
daily series. Money fields come back as a number or a decimal string.
`GET /v1/instance_type_prices` returns `instance_types[] {instance_type
{id, name, gpu_count, gpu_type, ...}, price}` where `price` is "Usage
price in USD / minute".
https://docs.baseten.co/reference/management-api/billing/gets-billing-usage-summary-for-a-date-range
https://docs.baseten.co/reference/management-api/instance-types/gets-instance-type-prices

## What the adapter does

- `deploy` POSTs `/v1/llm_models` with `weights: [{source,
  mount_location: /models/almyty, auth?}]` and an `llm_config` that points
  the engine and its tokenizer at that mount. When the source is private
  it first upserts the workspace secret the `auth` block names.
- `readEndpoint` maps `DeploymentStatusV1` and reports
  `active_replica_count`.
- `scale(0)` calls `deactivate`; `scale(n)` PATCHes the replica bounds and
  calls `activate`.
- `teardown` deletes the deployment and then the model; the shared secret
  stays.
- `costSnapshot` takes the burn rate from `instance_type_prices` (USD per
  minute times 6000 gives cents per hour) and the spend from the billing
  breakdown for this deployment, falling back to rate times uptime when
  the key lacks billing scope.

## Deltas from the spec

- **`registrySources` is `['hub', 's3', 'gcs']`, Hub first.** BDN mirrors
  all three itself. `bt://`, `r2://`, `cw://` and `azure://` are accepted
  by `weightSource` too, since Baseten documents them, but they have no
  `RegistrySource` value to declare. A scheme BDN cannot mirror is refused
  with `ADAPTER_UNSUPPORTED_SOURCE`.
- **The `@etag` pin is stripped for a bucket source** and kept for
  `hf://`, where `@revision` is part of the documented format.
- **The secret is workspace-wide.** BDN references credentials by secret
  name, so `hf_access_token` and `aws_credentials` are shared across the
  workspace; the adapter upserts on deploy and never deletes on teardown.
- **Scale to zero is `deactivate`**, which is immediate and bills nothing,
  rather than `min_replica: 0` plus a scale-down delay.
- **`llm_config` and `weights` are `additionalProperties: true` in the
  spec.** The keys sent are the documented `bis_llm.config` and
  `weights[]` keys of `config.yaml`; that `/v1/llm_models` accepts them
  verbatim is verified at the schema level only and must be confirmed by
  the live run.
- **`regions` is empty in `capabilities()`**: placement is enabled per
  workspace and listed by `GET /v1/regions`.

## Removed in this pass

The **environment-variable credential path**. Registry keys used to be
written into a secret named `aws_secret_json` and a custom endpoint
passed as `environment_variables.AWS_ENDPOINT_URL`, on the assumption
that the serving container would fetch the weights. Neither is how BDN
works: mirroring happens outside the container and is authenticated by
the per-source `auth` block, which the adapter had not been sending at
all, so a private source would never have mirrored. The secret name is
now `aws_credentials`, matching the documented key names, and
`environment_variables` is gone from the request.

## Live suite

`CONFORMANCE_LIVE=baseten` with `BASETEN_API_KEY`. Uses an `L4`
accelerator and `hf://Qwen/Qwen3-0.6B@main`. Never in CI.
