# RunPod adapter (`runpod`)

Serverless endpoints running the vLLM worker. Implementation: `backend/src/modules/model-deployments/adapters/runpod.adapter.ts`.

## Verified against the docs (2026-09-08)

- Control plane REST at `https://rest.runpod.io/v1`, `Authorization: Bearer <api key>` (docs.runpod.io/api-reference).
- `POST /templates` with `name`, `imageName`, `isServerless`, `env`, `containerDiskInGb`, `ports`, `dockerStartCmd`, `volumeInGb`, `containerRegistryAuthId`; returns `id`. `DELETE /templates/{id}` returns 204.
- `POST /endpoints` with `name`, `templateId`, `computeType` (GPU | CPU), `gpuTypeIds`, `gpuCount`, `workersMin` (>= 0), `workersMax`, `idleTimeout` (1..3600 s), `scalerType` (QUEUE_DELAY | REQUEST_COUNT), `scalerValue`, `flashboot`, `dataCenterIds`, `networkVolumeId`, `allowedCudaVersions`, `executionTimeoutMs`; returns the endpoint with `id`, `workersMin`, `workersMax`, `gpuTypeIds`, `templateId`, `workers[]`, `createdAt`.
- `GET /endpoints/{id}` returns the same object (404 when gone). `PATCH /endpoints/{id}` accepts `workersMin`, `workersMax`, `gpuTypeIds`, `templateId`, `idleTimeout`, `scalerType`, `scalerValue`, `flashboot`, `dataCenterIds`, `networkVolumeId`, `executionTimeoutMs`. `DELETE /endpoints/{id}` returns 204 (400 invalid id, 401 unauthorized).
- Data plane `GET https://api.runpod.ai/v2/{id}/health` returns `{ jobs: { completed, failed, inProgress, inQueue, retried }, workers: { idle, running } }`; OpenAI-compatible base URL `https://api.runpod.ai/v2/{id}/openai/v1` with the same bearer key.
- vLLM worker env: `MODEL_NAME` (Hub repo id or a local path), `MODEL_REVISION`, `HF_TOKEN`, `MAX_MODEL_LEN`, `QUANTIZATION`, `TENSOR_PARALLEL_SIZE`, `OPENAI_SERVED_MODEL_NAME_OVERRIDE`, `RAW_OPENAI_OUTPUT`; `BASE_PATH` defaults to `/runpod-volume`.

## Deltas from the spec

- **The stock worker does not read S3.** No S3 environment is documented for `runpod/worker-v1-vllm`. For an S3 registry version the template carries `ALMYTY_REGISTRY_URI`, `AWS_ENDPOINT_URL`, the registry's read keys and `MODEL_NAME=/runpod-volume/almyty/model`; serving it requires either the almyty worker image (the stock image plus a fetch step before vLLM starts, set via `image`) or a network volume (`networkVolumeId`) already synced to that path. Hub versions work with the stock image unchanged.
- **Secrets are template env.** RunPod offers no secret store for serverless templates, so registry keys and `HF_TOKEN` are written into the template's `env`. Nothing secret is kept on the ref.
- **Replicas are always-on workers.** `scale(n)` sets `workersMin=n` (and lifts `workersMax` if needed); `scale(0)` sets both bounds to 0, which is the only way to keep a serverless endpoint from starting a worker on the next request. With `workersMin=0` and `workersMax>0` the endpoint is reported `ready` with 0 replicas: it is live and cold-starts on demand.
- **Cost.** RunPod bills workers per second and its GPU price list endpoint could not be verified from the public docs (404), so `costSnapshot` uses the configured `hourlyRateCents` per worker times `max(running, workersMin)`. Idle flashboot-cached workers are not counted.
- **Region** is expressed as `dataCenterIds`; `desired.region` becomes a single data center id.

## Live suite

`CONFORMANCE_LIVE=runpod` with `RUNPOD_API_KEY`. Never in CI.
