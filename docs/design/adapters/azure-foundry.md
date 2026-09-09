# Azure AI Foundry adapter (`azure-foundry`)

Managed online endpoints in an Azure Machine Learning workspace / Foundry project, driven through the ARM REST API. Implementation: `backend/src/modules/model-deployments/adapters/azure-foundry.adapter.ts`.

## Verified against the docs (2026-09-08)

- ARM base `https://management.azure.com`, `api-version=2024-10-01` (learn.microsoft.com/rest/api/azureml, 2024-10-01 moniker; later versions up to 2026-07-01 exist with the same shapes).
- `PUT .../workspaces/{ws}/environments/{name}/versions/{v}` with `properties.image`, `properties.osType`, `properties.inferenceConfig.{livenessRoute,readinessRoute,scoringRoute}.{path,port}`. BYOC deployments require `inferenceConfig`.
- `PUT .../models/{name}/versions/{v}` with `properties.modelType`, `properties.modelUri`; the model mounts under `<modelMountPath>/<name>/<version>` in the container.
- `PUT .../onlineEndpoints/{name}` with `location`, `identity`, `properties.authMode` (Key | AMLToken | AADToken), `properties.traffic`; response carries `properties.scoringUri` and `provisioningState` in Creating | Deleting | Succeeded | Failed | Updating | Canceled. `POST .../listKeys` returns `primaryKey`/`secondaryKey`. `DELETE` removes the endpoint and its deployments.
- `PUT .../onlineEndpoints/{name}/deployments/{dep}` with `location`, `sku.{name,capacity}`, `properties.endpointComputeType: Managed`, `instanceType`, `environmentId`, `environmentVariables`, `model`, `modelMountPath`, `scaleSettings.scaleType` (Default | TargetUtilization), `requestSettings`, liveness/readiness/startup probes. `provisioningState` in Creating | Deleting | Scaling | Updating | Succeeded | Failed | Canceled. Returns 201 with `Azure-AsyncOperation`.
- `PATCH .../deployments/{dep}` accepts only `sku` and `tags` (`PartialMinimalTrackedResourceWithSku`); `sku.capacity` is the instance count. Returns 200 or 202 with `Location`.
- Entra client credentials: `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` form `client_id`, `client_secret`, `scope=https://management.azure.com/.default`, `grant_type=client_credentials`; response `access_token`, `expires_in`. A bad secret is a 400/401 with `error: invalid_client`.

## Deltas from the spec

- **Scoring URI proxies one route.** A managed endpoint forwards `scoringUri` to the environment's `scoringRoute` only. The adapter sets the scoring route to `/v1/chat/completions` on port 8000 and reports `scoringUri` as the endpoint URL; the gateway must call that URL as the chat completions endpoint and cannot list `/v1/models` through it (`details.chatCompletionsOnly`).
- **No scale to zero on the platform.** Managed deployments keep at least one instance. `scale(0)` deletes the deployment and leaves the endpoint (and its URL) in place; `scale(n)` recreates it from the non-secret spec kept on the ref, with registry keys re-read from credentials. `readEndpoint` reports `stopped` while no deployment exists.
- **Traffic is routed after the deployment succeeds.** ARM rejects `traffic` that names a deployment that does not exist yet, so the first `readEndpoint` that sees the deployment `Succeeded` PUTs the endpoint with `traffic: { almyty: 100 }` and reports `deploying` once more.
- **S3 registry source.** Azure model assets accept only `azureml://` datastore or blob URIs, so an S3 version is served exactly as on Hugging Face: the vLLM image gets `ALMYTY_REGISTRY_URI`, `MODEL_ID=/data/model`, optional `AWS_ENDPOINT_URL`, and the registry's read keys in `environmentVariables` (Azure has no separate secret channel for deployments). `azureml://` and `https://*.blob.core.windows.net/` versions are registered as `custom_model` assets and mounted at `/var/azureml-app/model`. `hf://` versions use `MODEL_ID` and `MODEL_REVISION`.
- **Endpoint auth key.** The endpoint is created with `authMode: Key`; the key is fetched by the caller via `listKeys` and is never stored on the ref.
- **Cost.** Cost Management reports a day late, so `costSnapshot` uses the configured `hourlyRateCents` times `sku.capacity` over observed running time.
- **Assets are not cleaned up.** Teardown deletes the endpoint; the environment and model versions stay in the workspace as history.

## Live suite

`CONFORMANCE_LIVE=azure-foundry` with `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_ML_WORKSPACE`, optional `AZURE_LOCATION`, `AZURE_INSTANCE_TYPE`. Never in CI.
