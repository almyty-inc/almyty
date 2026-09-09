# Adapter: vertex

Google Vertex AI endpoints, in the customer's own GCP project. Adapter key `vertex`, source `backend/src/modules/model-deployments/adapters/vertex.adapter.ts`, fixture conformance `__tests__/conformance/vertex.conformance.spec.ts`.

## Verified API facts (docs.cloud.google.com/vertex-ai REST reference, checked 2026-09-08)

- REST base `https://{location}-aiplatform.googleapis.com/v1`, OAuth2 bearer token with the `https://www.googleapis.com/auth/cloud-platform` scope. Service-account keys are exchanged through the JWT bearer grant: RS256 JWT with `iss` (client_email), `scope`, `aud https://oauth2.googleapis.com/token`, `iat`, `exp` (max 1 hour), posted as `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=...`; the response is `{access_token, token_type, expires_in}`.
- `POST {parent}/endpoints?endpointId=` with `{displayName, dedicatedEndpointEnabled, ...}` returns a long-running Operation whose response is the Endpoint. `GET {endpoint}` returns `deployedModels [{id, model, displayName, dedicatedResources, createTime}]`, `trafficSplit`, `dedicatedEndpointDns`. `DELETE {endpoint}` returns an Operation.
- `POST {parent}/models:upload` with `{model: {displayName, containerSpec {imageUri, command, args, env [{name, value}], ports [{containerPort}], predictRoute, healthRoute}, artifactUri?}}` returns an Operation whose response is `{model, modelVersionId}`.
- `POST {endpoint}:deployModel` with `{deployedModel: {model, displayName, dedicatedResources {machineSpec {machineType, acceleratorType, acceleratorCount}, minReplicaCount, maxReplicaCount}, enableAccessLogging}, trafficSplit}` returns an Operation whose response carries `deployedModel.id`; `'0'` in `trafficSplit` names the model being deployed. Permission `aiplatform.endpoints.deployModel`.
- `POST {endpoint}:undeployModel {deployedModelId, trafficSplit?}` and `PATCH {endpoint}:mutateDeployedModel {deployedModel: {id, dedicatedResources: {minReplicaCount, maxReplicaCount}}, updateMask}` both return Operations; only the replica range, autoscaling metrics and logging flags are mutable.
- `GET {operation name}` returns `{name, metadata, done, error {code, message, details}, response}`. Errors use the google.rpc envelope `{error: {code, message, status}}`: 401 `UNAUTHENTICATED`, 403 `PERMISSION_DENIED`, 404 `NOT_FOUND`, 429 `RESOURCE_EXHAUSTED` (quota), 400 `FAILED_PRECONDITION` (for example deleting an endpoint that still has a deployed model).
- Self-deployed models are reachable OpenAI-style at `{base}/projects/{p}/locations/{l}/endpoints/{id}/chat/completions`, or through `https://{dedicatedEndpointDns}/v1/...` on a dedicated endpoint.

## Deltas from the spec

- **Three long-running operations per deployment.** `deploy` creates the endpoint (id `almyty-{id}`) and uploads the model and awaits both (they finish in seconds), then starts `deployModel` and returns; `readEndpoint` tracks that operation until the model shows in `deployedModels` (typically 10 to 20 minutes). An operation error becomes `failed` with its message. A refused `deployModel` (quota) deletes the endpoint and model again.
- **Weights stream from S3 into vLLM.** No GCS copy: the uploaded model is the `vllm/vllm-openai` image with `--model s3://bucket/prefix --load-format runai_streamer --served-model-name {name} --port 8080`, and the registry keys plus `AWS_ENDPOINT_URL` as container env. `predictRoute` is `/v1/chat/completions`, `healthRoute` `/health`. Container env is plaintext in the Vertex model resource, visible to anyone who can read the model; a scoped read-only registry key is required, and Secret Manager references are the follow-up. Only the S3 registry source is accepted. The Run:ai streamer extra being present in the upstream image is to be confirmed in the live smoke; `image` is overridable.
- **Vertex never scales dedicated resources to zero** (`minReplicaCount >= 1`), so `scaleToZero` is `false`. `scale(0)` undeploys the model and keeps the endpoint (state `stopped`, zero burn); `scale(n)` mutates the replica range when deployed and redeploys when undeployed. Teardown undeploys first because Vertex refuses to delete an endpoint with a deployed model, then deletes the endpoint and the model.
- **Replica count is the configured minimum**, since `GET endpoint` does not report current replicas; Cloud Monitoring `prediction/online/replicas` is the follow-up.
- **Cost is an estimate**: `hourlyRateCents` per replica (machine plus accelerators) times replicas. Cloud Billing export is the only source of actuals and is not wired.
- **Credentials**: `accessToken` is used as given; otherwise `serviceAccountJson` is exchanged and the token cached per client email until a minute before expiry. Both are `x-secret`. `google-auth-library` is a dependency of the repo but the exchange is done with Node crypto so the HTTP client stays injectable for fixtures.

## Live smoke

`CONFORMANCE_LIVE=vertex` with `GOOGLE_SERVICE_ACCOUNT_JSON`, `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `VERTEX_TEST_S3_URI`, `REGISTRY_ACCESS_KEY_ID`, `REGISTRY_SECRET_ACCESS_KEY`. The project needs L4 quota in the location. Not yet run.
