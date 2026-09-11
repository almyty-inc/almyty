# Together AI adapter (`together`)

Together **dedicated model inference** (DMI): a model of yours running on
reserved GPUs behind a stable endpoint string, called through Together's
shared OpenAI-compatible inference API. Implementation:
`backend/src/modules/model-deployments/adapters/together.adapter.ts`.

## Verified (2026-09-09)

**1. The managed product, and whether there is a serverless option.** Two
separate products. **Serverless** inference is per-token over Together's
catalog of 100+ models and provisions nothing. **Dedicated model
inference** runs your model on dedicated GPUs; that is what this adapter
drives. DMI is a v2 resource model (project, model, config, endpoint,
deployment, replica) and **v1 is closed to new endpoints**: "Creating a
new v1 endpoint and restarting a stopped or paused one are no longer
available. These operations now return `endpoints_v1_create_access_disabled`
(HTTP 403) through the API (`POST /v1/endpoints`), SDK, CLI, and web UI."
https://docs.together.ai/docs/serverless/overview
https://docs.together.ai/docs/dedicated-endpoints/concepts
https://docs.together.ai/docs/dedicated-endpoints/migrate-from-v1

**2. What model sources the product accepts.** Together's own **catalog**
(`tg beta models public --product dedicated`, each architecture published
as one or more deployment profiles pinning a weight to a config), a
**fine-tune trained on Together**, and an **upload**. An upload has three
sources -- "Your local machine, Hugging Face Hub, or an S3 presigned URL"
-- and must be "a fine-tuned variant of a base model that Together AI
supports for dedicated inference", registered against a `baseModelId`
(`ml_...`) first. The documented remote path is a **server-side pull**:
"A remote upload streams the weights server-side, so you don't download
them locally first", with `--token` "for gated or private Hugging Face
repos". Only safetensors are accepted, and each revision is validated
(`REVISION_VALIDATION_STATUS_*`) before it can be deployed.
https://docs.together.ai/docs/dedicated-endpoints/custom-models
https://docs.together.ai/docs/dedicated-endpoints/models

**3. REST surface** (`https://api.together.ai/v2`, bearer token; the key
is scoped to one project):

| Operation | Method | Path |
|-----------|--------|------|
| identify the project | GET | `/v1/whoami` |
| register a model | POST | `/v2/projects/{projectId}/models` |
| remote upload | POST | `/v2/projects/{projectId}/models/uploads` |
| upload status | GET | `/v2/projects/{projectId}/models/uploads/{id}` |
| list deployment profiles | GET | `/v2/projects/{projectId}/configs?referenceModel=` |
| create endpoint | POST | `/v2/projects/{projectId}/endpoints` |
| read endpoint | GET | `/v2/projects/{projectId}/endpoints/{id}` |
| route traffic | PATCH | `/v2/projects/{projectId}/endpoints/{id}` |
| delete endpoint | DELETE | `/v2/projects/{projectId}/endpoints/{id}` |
| create deployment | POST | `/v2/projects/{projectId}/endpoints/{endpointId}/deployments` |
| read deployment | GET | `.../deployments/{id}` |
| scale / stop | PATCH | `.../deployments/{id}` |
| delete deployment | DELETE | `.../deployments/{id}` |
| instance types and prices | GET | `/v2/public/inference-instance-types` |

`DE.CreateModelRequest` requires `name`, `type` (`model` or `adapter`) and
`baseModelId`. `DE.CreateRemoteUploadSpec` requires `modelId` and
`remoteUrl` ("Hugging Face repository URL or presigned archive URL to
import") and takes `token` ("Optional source credential used to access a
private remote location. The value is write-only and is not returned").
`DE.RemoteUpload.status` is `REMOTE_UPLOAD_STATUS_{PENDING, RUNNING,
ERROR, SUCCEEDED, FAILED}`.

`DE.CreateEndpointRequest` requires only `name`; the response carries
`id` (`ep_...`), the project-qualified `name`, an `etag` and a
`trafficSplit`. `DE.CreateDeploymentRequest` requires `name` and
`autoscaling`, and takes `model`
(`projects/{projectId}/models/{modelId}[/revisions/{revisionId}]`),
`config` (`projects/{projectId}/configs/{configRevisionId}`), `placement`
and `enableLora`. `DE.Autoscaling` is `{minReplicas, maxReplicas,
scaleUpWindow, scaleDownWindow, scaleToZeroWindow, scalingMetrics}` with
the windows as duration strings; "Set both `minReplicas` and
`maxReplicas` to `0` to stop the deployment". `DE.DeploymentStatus.state`
is `DEPLOYMENT_STATE_{PROVISIONING, READY, SCALING, DEGRADED, FAILED,
STOPPED, STOPPING}`, with `readyReplicas`, `scheduledReplicas` and
`message`.

Routing is a separate step and it is not optional: "Even if it's `READY`,
a deployment receives no traffic until you route traffic to it", and the
troubleshooting entry for `endpoint_not_configured` (HTTP 400) "though
the deployment is READY" is exactly that. The split is set by PATCHing
the endpoint's `trafficSplit` with `{deploymentId, weight}` entries.
Deletion has an order: stop the deployment, drop its split weight, delete
the deployment, then delete the endpoint.

The OpenAI-compatible chat URL is Together's shared inference host, not a
per-endpoint host: "Dedicated model inference is served at
`https://api-inference.together.ai`", and the endpoint string
`<project_slug>/<endpoint_name>` is passed as the `model` field. A
deployment's own qualified name can be passed as `model` to bypass the
split and target it directly.
https://docs.together.ai/docs/dedicated-endpoints/manage
https://docs.together.ai/docs/dedicated-endpoints/route-traffic
https://docs.together.ai/docs/dedicated-endpoints/requests
https://docs.together.ai/reference/dmi/deployments-create

**4. Cost signals.** A **price list, not a usage API**. DMI "bills based
on the hardware your deployments run on", by the minute, per replica,
"only while it's ready", and "a deployment scaled to zero replicas, or
stopped, costs nothing". `GET /v2/public/inference-instance-types`
returns `DE.InferenceInstanceType` with `priceCentsPerHour` ("On-demand
price for one running replica, in US cents per hour") alongside `gpuType`,
`gpuCount` and per-region `headroom`. Published rates include
`1xnvidia-h100-80gb` at $3.99/hour and `1xnvidia-b200-180gb` at $8.99.
The only other measurement route, `GET /projects/{id}/endpoints/{id}/analytics`,
returns "request, token, latency, throughput, error, and
resource-utilization metrics" -- no dollars.
https://docs.together.ai/docs/dedicated-endpoints/pricing
https://docs.together.ai/reference/dmi/instance-types-list
https://docs.together.ai/reference/dmi/endpoints-analytics

## What the adapter does

- `upload` registers the version as a project model against
  `providerConfig.baseModelId`, then POSTs a remote upload naming the Hub
  URL and, when the repo is private or gated, the customer's own Hub
  token, and polls the job to `REMOTE_UPLOAD_STATUS_SUCCEEDED`. It returns
  `together://ml_...`, which deploys without importing again.
- `deploy` resolves the project (from `providerConfig.projectId` or
  `/v1/whoami`), resolves the model, picks the published config, creates
  the endpoint, creates the deployment, and PATCHes the traffic split so
  the deployment actually serves.
- `readEndpoint` maps `DEPLOYMENT_STATE_*` and reports `status.readyReplicas`.
- `scale(0)` sets both replica bounds to zero; `scale(n)` raises the floor.
- `teardown` clears the split, stops the deployment, deletes it, then
  deletes the endpoint, tolerating a 400 while replicas drain.
- `costSnapshot` prices a replica from the public instance-type catalog.

## Deltas from the spec

- **`registrySources` is `['hub']`.** The remote upload is the only import
  Together performs on its own behalf, and the Hub is the source we can
  hand it without becoming the transfer. An `s3://` version is refused
  with `ADAPTER_UNSUPPORTED_SOURCE`.
- **An upload needs a base model.** `baseModelId` is required by the API
  and cannot be guessed from a registry version, so a version with no
  `providerConfig.baseModelId` is refused before anything is created.
- **We do not guess a deployment profile.** When a model publishes more
  than one config the adapter refuses and lists them, the same way
  Together's own CLI does; `providerConfig.configId` picks one.
- **Placement is set once.** Together cannot change placement on a live
  deployment, so `desired.region` (or `providerConfig.regions`) is applied
  as inline placement at create time only.
- **Cost is a rate, not a reading.**

## Removed in this pass

The whole v1 path, which no longer creates anything: `POST /v1/endpoints`,
`POST /v1/models` with `model_source`, `GET /v1/jobs/{id}`,
`GET /v1/hardware`, and the `STARTED`/`STOPPED` state machine.

With it went the **presigned-archive workaround**: an S3 registry version
used to be uploaded by handing Together a presigned HTTPS URL of a
`.tar.gz` of the version, carried in the secret
`registryArchiveUrlSecret`. Producing and signing that archive is almyty
standing in the middle of a weight transfer for a provider whose
documented import is a Hub URL. Gone, along with the config field.

## Live suite

`CONFORMANCE_LIVE=together` with `TOGETHER_API_KEY`, and
`TOGETHER_PROJECT_ID` / `TOGETHER_BASE_MODEL_ID` when the key's project or
base model should be pinned. Imports `hf://Qwen/Qwen3-0.6B@main` and
deploys it on the model's published profile. Never in CI.
