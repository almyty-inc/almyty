# Fireworks AI adapter (`fireworks`)

Fireworks **on-demand deployments**: dedicated GPUs running a model that
already lives in your Fireworks account, called through their
OpenAI-compatible inference API. Implementation:
`backend/src/modules/model-deployments/adapters/fireworks.adapter.ts`.

## Verified (2026-09-09)

**1. The managed product, and whether there is a serverless option.** Both
exist. **Serverless inference** is per-token over Fireworks' own catalog
and cannot serve an uploaded model. **On-demand deployments** give you
"dedicated GPUs for your models", billed by GPU-second, with "broader
model selection" and custom models; that is this adapter. Fireworks now
pushes **deployment shapes** as the way to configure one: "Do not create
deployments without a shape ... Most failed deployment creations on
Fireworks are deployments without a shape, and the unshaped path may be
deprecated in the future."
https://docs.fireworks.ai/serverless/overview
https://docs.fireworks.ai/guides/ondemand-deployments

**2. What model sources the product accepts.** A model that is already a
Fireworks resource: their **catalog**
(`accounts/fireworks/models/<model>`), a **fine-tune trained on
Fireworks**, or a **custom checkpoint uploaded into the account**. The
upload has three documented routes, and none of them is a Hugging Face
import:

- **local files**, `firectl model create <MODEL_ID> /path/to/files/`;
- **object storage, read by Fireworks itself** --
  `firectl model create <MODEL_ID> s3://<BUCKET>/<PATH>/ --role-arn ...`
  (or `--aws-access-key-id` / `--aws-secret-access-key`), and the Azure
  Blob equivalent with a SAS-token secret or federated identity. "For
  larger models, you can upload directly from cloud storage (S3 or Azure
  Blob Storage) for faster transfer instead of uploading from your local
  machine", and the CLI's `--poll-duration` is "the duration to poll for
  model **import operation** completion";
- **the REST API**, a four-step signed-URL pipeline: create the model,
  `:getUploadEndpoint` for a signed URL per file, `PUT` every file, then
  poll `:validateUpload` until the model is `READY`.

The Hugging Face URL field exists but is **not an import**: "Set
`huggingFaceUrl` if this uploaded custom base model should be considered
for Fireworks managed training. Fireworks uses the Hugging Face URL to
infer the training renderer and locate compatible training shapes."
Confirmed against the create-model schema, whose `gatewayModel` has
`githubUrl`, `huggingFaceUrl`, `baseModelDetails`, `peftDetails` and no
source, bucket, credential or import field of any kind. The documented
default for a large checkpoint is therefore the object-storage import,
driven by `firectl`.
https://docs.fireworks.ai/models/uploading-custom-models
https://docs.fireworks.ai/models/uploading-custom-models-api
https://docs.fireworks.ai/api-reference/create-model
https://docs.fireworks.ai/tools-sdks/firectl/commands/model-create

**3. REST surface** (`https://api.fireworks.ai`, bearer token; errors use
the gRPC-style `{code, message, status}` with `UNAUTHENTICATED`,
`PERMISSION_DENIED`, `NOT_FOUND`, `ALREADY_EXISTS`, `RESOURCE_EXHAUSTED`,
`FAILED_PRECONDITION`):

| Operation | Method | Path |
|-----------|--------|------|
| read a model | GET | `/v1/accounts/{account_id}/models/{model_id}` |
| create a deployment | POST | `/v1/accounts/{account_id}/deployments?deploymentId=` |
| read | GET | `/v1/accounts/{account_id}/deployments/{deployment_id}` |
| update bounds | PATCH | `/v1/accounts/{account_id}/deployments/{deployment_id}` |
| scale | PATCH | `/v1/accounts/{account_id}/deployments/{deployment_id}:scale` |
| delete | DELETE | `/v1/accounts/{account_id}/deployments/{deployment_id}?hard&ignoreChecks` |
| metered usage | GET/POST | `/v1/accounts/{account_id}/billingUsage` and `:query` |
| account cost totals | GET | `/v1/accounts/{account_id}/billing/summary` |

A deployment takes `baseModel` (required), `displayName`,
`minReplicaCount`, `maxReplicaCount`, `deploymentShape`, and, when no
shape fits, `acceleratorType` and `acceleratorCount`, plus `precision`,
`autoscalingPolicy {scaleUpWindow, scaleDownWindow, scaleToZeroWindow,
loadTargets, scalingSchedules}` and `placement`. `state` is
`CREATING | READY | UPDATING | DELETING | DELETED | FAILED`; scaled-to-zero
is not a state but a UI label derived from the fields ("`Scaled to 0`:
`state == READY && min_replica_count == 0 && ... ready_replica_count == 0`").
`:scale` takes only `{replicaCount}`. `PATCH` requires `baseModel` even
when only the counts change. Accelerators are `NVIDIA_A100_80GB`,
`NVIDIA_H100_80GB`, `NVIDIA_H200_141GB`, `NVIDIA_B200_180GB`,
`NVIDIA_B300_288GB`, `AMD_MI325X_256GB`, `AMD_MI350X_288GB`. Placement is
a multi-region (`GLOBAL`, `US`, `EUROPE`, `APAC`) or one of 26 single
regions, cannot be changed in place, and every placement except `GLOBAL`
starts at zero quota.

The OpenAI-compatible chat URL is the shared inference host
`https://api.fireworks.ai/inference/v1`, with
`accounts/{account_id}/deployments/{deployment_id}` as the `model`.
https://docs.fireworks.ai/api-reference/create-deployment
https://docs.fireworks.ai/api-reference/scale-deployment
https://docs.fireworks.ai/deployments/regions

**4. Cost signals.** A **usage API plus a price list**. `billingUsage`
meters quantities per deployment: "Dedicated-deployment rows also include
the deployment's region (`placement` ...) and metered
`accelerator_seconds`", grouped by `deployment_name` and
`accelerator_type`, filtered over `POST /billingUsage:query` with
`filter: {deployment_name: {values: [...]}}`, capped at a 31-day window
and aggregated daily. It reports no dollars at that grain: "Costs are
reported at the account level ... They aren't broken down by the same
dimensions as usage, so per-API-key or per-deployment dollar figures
aren't returned today". `GET /billing/summary` gives rated dollars by
billing category (serverless, dedicated, training) for the account, not
per deployment. List prices per GPU hour from 2026-09-01: H100 80GB $8,
H200 141GB $8, B200 180GB $13, B300 288GB $15, GB300 $20, and
"Region-restricted deployments are priced at a 1.5x premium".
https://docs.fireworks.ai/accounts/exporting-usage-and-costs
https://fireworks.ai/pricing

## What the adapter does

- `deploy` resolves the model resource for the version, checks an
  imported model is `READY`, and POSTs the deployment on the configured
  shape or accelerator.
- `readEndpoint` maps the deployment state and reports `READY` with zero
  ready replicas as `stopped`, which is the documented scaled-to-zero
  shape.
- `scale` PATCHes the bounds (resending `baseModel`) and then `:scale`,
  so the live count moves at once instead of waiting for the autoscaler.
- `teardown` DELETEs the deployment with `ignoreChecks`; the model stays.
- `costSnapshot` reads metered `accelerator_seconds` for this deployment
  from `billingUsage:query` and prices them at the list rate (times 1.5
  for a single-region placement), falling back to rate times uptime when
  the key cannot read billing.

## Deltas from the spec

- **`registrySources` is `['s3']`, and the import is the operator's
  step.** Fireworks reads a bucket itself, with a role ARN or keys the
  operator gives it. There is no REST field for that import, so the
  adapter does not perform it: for an `s3://` version it looks up
  `almyty-v-<version id>` in the account and, when it is missing, refuses
  with `ADAPTER_UNSUPPORTED_SOURCE` and the exact `firectl model create`
  command to run.
- **A hub version cannot be served at all** and is refused up front.
  `huggingFaceUrl` is training metadata, not a source.
- **Spend is metered, the rate is a list price.** GPU-seconds come from
  Fireworks; the dollars per second do not.
- **`architectures` is `any`** at the contract level; Fireworks validates
  the checkpoint on import, before this adapter is involved.

## Removed in this pass

The **byte-streaming upload**. The adapter used to create an
`HF_BASE_MODEL` record, call `:getUploadEndpoint` for a signed URL per
file, and then stream every weight file through this backend to Fireworks'
storage -- reading them either from our object storage through a lazily
required `@aws-sdk/client-s3`, or from `huggingface.co` -- before polling
`:validateUpload`. That made the API container the data path for
multi-gigabyte checkpoints, on a route Fireworks documents for a CLI on
an operator's machine. Gone with it: `upload()`, the `ModelFileSource` /
`ModelFileSourceFactory` injection points, the AWS SDK dependency, the
`almyty-manifest.json` filter, and the `registryAccessKeyId`,
`registrySecretAccessKey`, `registryEndpoint`, `registryRegion`,
`hfToken` and `uploadTimeoutMinutes` config fields.

`deploymentShape` was added in the same pass, because Fireworks now says
plainly that an unshaped deployment is the usual cause of a failed create.

## Live suite

`CONFORMANCE_LIVE=fireworks` with `FIREWORKS_API_KEY`,
`FIREWORKS_ACCOUNT` and `FIREWORKS_TEST_MODEL` (a
`fireworks://accounts/.../models/...` the account can already deploy).
Never in CI.
