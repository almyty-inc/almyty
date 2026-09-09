# Together AI adapter (`together`)

Verified 2026-09-08 against docs.together.ai (reference pages `createendpoint`, `getendpoint`, `updateendpoint`, `deleteendpoint`, `listhardware`, `upload-model`, `getjob`, and the dedicated-endpoints guides). Source: `backend/src/modules/model-deployments/adapters/together.adapter.ts`. Scope: dedicated endpoints for a registry version only; Together-hosted serverless models are call-only and not handled here.

## What was verified

- v1 base `https://api.together.xyz/v1` (docs also list `https://api.together.ai/v1`), `Authorization: Bearer <key>`. Errors come back as `{error: {type, message}}`; the endpoint pages document 403 Unauthorized, 404 Not Found, 500.
- `POST /v1/endpoints`: `model` (required), `hardware` (required, an id from `/v1/hardware` such as `1x_nvidia_a100_80gb_sxm` or `8x_nvidia_h200_140gb_sxm`), `autoscaling {min_replicas, max_replicas}` (required), `display_name`, `disable_speculative_decoding` (default false), `disable_prompt_cache` (deprecated, no effect), `state` (`STARTED` | `STOPPED`, default STARTED), `inactive_timeout` (minutes, null or 0 disables), `availability_zone` (e.g. `us-central-4b`). Response `DedicatedEndpoint`: `object: endpoint`, `id` (`endpoint-<uuid>`), `name`, `display_name`, `model`, `hardware`, `type: dedicated`, `owner`, `state` in `PENDING | STARTING | STARTED | STOPPING | STOPPED | ERROR`, `autoscaling`, `created_at`.
- `GET /v1/endpoints/{id}` returns the same object; `PATCH /v1/endpoints/{id}` takes `display_name`, `state`, `autoscaling`, `inactive_timeout`; `DELETE /v1/endpoints/{id}` returns 204.
- `GET /v1/hardware[?model=]`: `data[] {id, pricing {cents_per_minute}, specs {gpu_type, gpu_link, gpu_memory, gpu_count}, availability {status: available | unavailable | insufficient}}`.
- `POST /v1/models` (custom model upload): `model_name` (required), `model_source` (required: a Hugging Face repo id such as `unsloth/Qwen2.5-72B-Instruct`, or an HTTPS archive URL such as a presigned S3 `.tar.gz`), `model_type` (`model` | `adapter`), `hf_token`, `description`, `base_model`, `lora_model`. Response `{job_id, model_name, model_id, model_source}`; the returned `model_name` is owner-prefixed (`owner/model_name`). `GET /v1/jobs/{jobId}` reports the upload; the docs say the model is deployable once `status` is `Complete`.
- Billing (dedicated-endpoints/pricing): per minute of hardware uptime; "a deployment scaled to zero replicas, or stopped, costs nothing"; `min_replicas` is the cost floor. Published rates: H100 80GB $3.99/h, B200 180GB $8.99/h; H200, B300, GB300 on request.
- The archive for a custom upload must contain the checkpoint files at its root (safetensors only); a valid directory holds `config.json`, `model*.safetensors`, `model.safetensors.index.json`, tokenizer files.

## Deltas from the spec

- Together cannot read `s3://` with keys. An S3 registry version needs a presigned HTTPS URL of a `.tar.gz` or `.zip` of the version (`credentials.registryArchiveUrlSecret` or `providerConfig.registryArchiveUrlSecret`, named so the at-rest secret pattern encrypts it; expiry at least 100 minutes per the docs); without it the adapter refuses with `ADAPTER_ERROR` before calling Together. Producing that archive from the flat registry layout is the registry service's job, not the adapter's.
- The upload is synchronous inside `deploy()` (and exposed as `upload()`): `deploy` cannot hand back a half-made handle because refs are persisted opaquely and reads never write them back. `upload()` returns `together://owner/name@model-id`; a version registered with that URI deploys without uploading again. `uploadTimeoutMinutes` (default 60) bounds the job poll.
- The endpoint is addressed through the shared inference base `https://api.together.xyz/v1` with the endpoint's `name` as the chat `model`; `ActualState.details.model` carries it and `url` is the shared base.
- v1 reports no live replica count. While `STARTED` the adapter reports `max(min_replicas, 1)` running replicas; otherwise 0.
- Scale to zero is `PATCH {state: STOPPED}` (billed nothing); a positive count patches `autoscaling.min_replicas` (max raised to match) and `state: STARTED`. `capabilities().scaleToZero` is true on that basis plus `inactive_timeout`.
- Cost: the rate is `cents_per_minute * 60` for the endpoint's hardware from `/v1/hardware`, falling back to `hourlyRateCents`; spend is rate times uptime since creation because Together publishes no spend endpoint.
- `capabilities().regions` is empty: `availability_zone` is a free-form string with no documented list; `desired.region` is passed through as the zone.
- A newer v2 "DMI" API exists (`https://api.together.ai/v2/projects/{projectId}/endpoints`, deployments with `DEPLOYMENT_STATE_*`, `/v2/public/inference-instance-types` with `priceCentsPerHour`, `/projects/{projectId}/models/uploads` with `REMOTE_UPLOAD_STATUS_*`, `tg beta` CLI). The v1 endpoints above remain documented and are what this adapter uses; the v2 shape is noted here for when v1 is retired.
- Teardown deletes the endpoint only; the uploaded model stays (v1 documents no model delete) and is reusable for the same version.

## Live mode

`CONFORMANCE_LIVE=together TOGETHER_API_KEY=... npx jest src/modules/model-deployments/__tests__/conformance/together.conformance.spec.ts`. Uploads `hf://Qwen/Qwen3-0.6B@main` and deploys it on `1x_nvidia_a100_80gb_sxm`. Never runs in CI.
