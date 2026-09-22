# Adapter: aws-bedrock-import

Amazon Bedrock, in the customer's own AWS account. Adapter key `aws-bedrock-import` (the key is the deployment's `providerType` and cannot change), source `backend/src/modules/model-deployments/adapters/aws-bedrock-import.adapter.ts`, fixture conformance `__tests__/conformance/aws-bedrock-import.conformance.spec.ts`.

almyty is not in the hosting business here. Bedrock is the managed product, and the adapter uses the two paths AWS documents: its own catalog for a listed model, and Custom Model Import for the customer's own weights. Amazon S3 is the native artifact source for the second, because it is the only source `CreateModelImportJob` accepts, and Bedrock reads the bucket itself through an IAM role. No weight byte passes through this backend on either path.

## Verified (docs.aws.amazon.com, fetched 2026-09-09)

### Managed catalog and serverless invocation

- Catalog: `GET /foundation-models` on `https://bedrock.{region}.amazonaws.com` returns `modelSummaries[]` with `modelId`, `modelArn`, `providerName`, `inferenceTypesSupported` (`ON_DEMAND | PROVISIONED`), `customizationsSupported`, `modelLifecycle`. https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html
- Application inference profile, which is what a deployment of a catalog model is: `POST /inference-profiles` with `{inferenceProfileName, description?, modelSource: {copyFrom}, clientRequestToken?, tags[]}`, returning `201 {inferenceProfileArn, status: "ACTIVE"}`. `modelSource` is a union whose only documented member is `copyFrom`: a foundation-model ARN in one region (`arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`, no account id) or a system-defined cross-region inference profile ARN (which does carry the customer's account id). Errors: `AccessDeniedException` 403, `ConflictException` 400, `ResourceNotFoundException` 404, `ServiceQuotaExceededException` 400, `ThrottlingException` 429, `TooManyTagsException` 400, `ValidationException` 400. https://docs.aws.amazon.com/bedrock/latest/APIReference/API_CreateInferenceProfile.html
- `GET /inference-profiles/{inferenceProfileIdentifier}` (id or ARN) returns `{inferenceProfileArn, inferenceProfileId, inferenceProfileName, description, models: [{modelArn}], status: "ACTIVE", type: "SYSTEM_DEFINED" | "APPLICATION", createdAt, updatedAt}`. `DELETE /inference-profiles/{inferenceProfileIdentifier}` removes an application profile. https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetInferenceProfile.html
- OpenAI-compatible inference, recommended for new applications: `POST https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions` with AWS SigV4 (service `bedrock`) or a Bedrock API key bearer token; `GET .../openai/v1/models` lists what the endpoint serves. The `bedrock-mantle` endpoint (`https://bedrock-mantle.{region}.api.aws/v1/chat/completions`) is the other, also supported, home for the same API. Native invocation stays `InvokeModel` (`POST /model/{modelId}/invoke`) and `Converse`. https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html
- Cost attribution: tags on an application inference profile flow into Cost Explorer and CUR 2.0 once activated as cost allocation tags; there is also automatic per-IAM-principal attribution, and model invocation logging to CloudWatch Logs or S3 for token counts. https://docs.aws.amazon.com/bedrock/latest/userguide/cost-management.html

### Custom Model Import

- `POST /model-import-jobs` with `jobName`, `importedModelName`, `roleArn`, `modelDataSource.s3DataSource.s3Uri` (required), optional `clientRequestToken`, `importedModelKmsKeyId`, `vpcConfig {subnetIds, securityGroupIds}`, `jobTags`, `importedModelTags`. Returns 201 `{jobArn}`. `modelDataSource` is a union whose only member is `s3DataSource`: there is no Hugging Face or SageMaker source, so weights must already be in S3 in Hugging Face format. https://docs.aws.amazon.com/bedrock/latest/APIReference/API_CreateModelImportJob.html
- `GET /model-import-jobs/{jobIdentifier}` (ARN or name): `status` is `InProgress | Completed | Failed`, with `importedModelArn` and `failureMessage`. `GET /imported-models/{modelIdentifier}` returns `modelArn`, `modelArchitecture`, `instructSupported`, `customModelUnits {customModelUnitsPerModelCopy, customModelUnitsVersion}`. `DELETE /imported-models/{modelIdentifier}`. `GET /imported-models` lists them.
- Regions: `us-east-1`, `us-east-2`, `us-west-2`, `eu-central-1` only; GPT-OSS in us-east-1 only. Architectures: Mistral, Mixtral, Flan, Llama 2/3/3.1/3.2/3.3, Mllama, GPTBigCode, Qwen2/2.5/2-VL/2.5-VL, Qwen3 (`Qwen3ForCausalLM`, `Qwen3MoeForCausalLM`, no Converse), GPT-OSS 20B/120B. Weights in Hugging Face format (`.safetensors`, `config.json`, `tokenizer_config.json`, `tokenizer.json`), under 200 GB (100 GB multimodal), context under 128K, transformers 4.51.3. No embedding models. https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html
- Inference: `POST /model/{importedModelArn}/invoke` on the runtime host, on demand. Billing is Custom Model Units per running model copy, charged in 5-minute windows from the first successful inference; idle models bill nothing, and AWS adds and removes copies itself. https://docs.aws.amazon.com/bedrock/latest/userguide/import-model-calculate-cost.html
- Errors: the type travels in the `x-amzn-ErrorType` header, the body is `{message}`.

### Which product for which request

A model AWS already lists is served on demand by Bedrock itself, and the deployment is an application inference profile that makes the spend attributable. Own weights in a supported architecture go through Custom Model Import, which gives the same serverless surface with no endpoint to manage. Own weights in any other architecture, or a model needing a custom container or a chosen GPU, belong on SageMaker instead; see `sagemaker.md`.

## Deltas from the spec

- **Two routes, one adapter, chosen by the version's registry URI.** `bedrock://<model id or ARN>` takes the catalog route; `s3://` takes Custom Model Import. Anything else is refused with `ADAPTER_UNSUPPORTED_OPERATION` whose message names both accepted forms.
- **Catalog route.** One `POST /inference-profiles` tagged `almyty:deployment` and `almyty:organization`, so AWS attributes the cost rather than almyty inventing an attribution of its own. A bare model id becomes `arn:aws:bedrock:{region}::foundation-model/{id}`; a cross-region profile id such as `us.anthropic....` is refused with the ARN form it needs, because its account id cannot be inferred. `url` is `.../openai/v1/chat/completions` and `openAiBase` is `.../openai/v1`; `details.modelId` carries what to put in the OpenAI request's `model` field. `scale()` sends nothing to AWS: Bedrock decides the capacity and bills per token. Teardown deletes the profile.
- **Import route: no separate upload step.** The import job reads the S3 prefix directly (`s3://bucket/prefix`, the version `@pin` stripped). `roleArn` must be able to read that bucket; no registry access keys are handed to AWS. An import outside the four supported regions is refused with `ADAPTER_UNSUPPORTED_REGION`, and one with no `roleArn` with `ADAPTER_CONFIG_INVALID`, both before any call.
- **Serverless, so scaling is implicit on both routes.** On the import route `scale(n)` records the ceiling on the handle only; `scale(0)` marks standby, which `readEndpoint` reports as `stopped` with a zero burn rate.
- **The imported endpoint is an ARN, not a URL.** `url` is the runtime invoke URL with the imported model ARN URL-encoded into the path; the gateway's Bedrock dispatch signs the call itself.
- **Architecture gate applies to the import route only,** by prefix of `version.base` against the family list above. Bedrock detects the real architecture from `config.json`; a mismatch surfaces as a `Failed` job with `failureMessage`. A catalog model has no gate: whatever AWS lists, AWS serves.
- **No cancel API for an import job.** Teardown deletes the imported model by name; while the job is still `InProgress` that call fails with a conflict and the reconcile loop retries after the job finishes.
- **Cost is an estimate.** A catalog deployment reports `spentCents: 0`, `ratePerHourCents: 0` and the operator's `inPerMTok`/`outPerMTok` as `perToken`, because Bedrock bills tokens and exposes no per-profile spend API; Cost Explorer against the profile's tags is the actuals path. An imported model uses `hourlyRateCents` (CMUs per copy times the per-CMU rate) times hours since import as an upper bound. Reading the CloudWatch `ModelCopy` metric to count billed copies is the follow-up.
- Requests are signed with the in-repo SigV4 signer (`model-deployments/aws-request.ts`, cross-checked against `@smithy/signature-v4` in `__tests__/aws-request.spec.ts`) because no Bedrock SDK client is installed.

## Not wired

- `CreateProvisionedModelThroughput`, for a catalog or imported model that needs guaranteed capacity rather than on demand.
- `CreateMarketplaceModelEndpoint`, for a Bedrock Marketplace model, which is a SageMaker-hosted endpoint behind a Bedrock-shaped API.

## Live smoke

`CONFORMANCE_LIVE=aws-bedrock-import` with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN` optional), `AWS_REGION`, `BEDROCK_IMPORT_ROLE_ARN`, `BEDROCK_TEST_S3_URI` (HF-format weights of a small Qwen3 or Llama). Import takes 15 to 45 minutes; a catalog profile is created in seconds. Not yet run.
