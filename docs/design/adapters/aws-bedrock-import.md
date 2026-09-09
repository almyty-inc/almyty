# Adapter: aws-bedrock-import

Amazon Bedrock Custom Model Import, in the customer's own AWS account. Adapter key `aws-bedrock-import`, source `backend/src/modules/model-deployments/adapters/aws-bedrock-import.adapter.ts`, fixture conformance `__tests__/conformance/aws-bedrock-import.conformance.spec.ts`.

## Verified API facts (docs.aws.amazon.com/bedrock, checked 2026-09-08)

- Control plane REST at `https://bedrock.{region}.amazonaws.com`, SigV4 service name `bedrock`. Runtime at `https://bedrock-runtime.{region}.amazonaws.com`.
- `POST /model-import-jobs` with `jobName`, `importedModelName`, `roleArn`, `modelDataSource.s3DataSource.s3Uri` (required), optional `clientRequestToken`, `importedModelKmsKeyId`, `vpcConfig {subnetIds, securityGroupIds}`, `jobTags`, `importedModelTags`. Returns 201 `{jobArn}`. Name patterns: model `([0-9a-zA-Z][_-]?)+` (max 63), job `[a-zA-Z0-9](-*[a-zA-Z0-9\+\-\.])*`.
- `GET /model-import-jobs/{jobIdentifier}` accepts the ARN or the job name; `status` is `InProgress | Completed | Failed`, with `importedModelArn` and `failureMessage`.
- `GET /imported-models/{modelIdentifier}` (ARN or name) returns `modelArn`, `modelArchitecture`, `instructSupported`, `customModelUnits {customModelUnitsPerModelCopy, customModelUnitsVersion}`. `DELETE /imported-models/{modelIdentifier}` returns 200 with an empty body.
- Errors: `AccessDeniedException` 403, `ResourceNotFoundException` 404, `ThrottlingException` 429, `ServiceQuotaExceededException` 400, `ConflictException` 400, `ValidationException` 400. The type travels in the `x-amzn-ErrorType` header, the body is `{message}`.
- Regions: `us-east-1`, `us-east-2`, `us-west-2`, `eu-central-1` only. GPT-OSS only in us-east-1.
- Architectures: Mistral, Mixtral, Flan-T5, Llama 2/3/3.1/3.2/3.3, Mllama, GPTBigCode, Qwen2/2.5/2-VL/2.5-VL, Qwen3 (`Qwen3ForCausalLM`, `Qwen3MoeForCausalLM`; Converse unsupported for Qwen3), GPT-OSS 20B/120B. Weights must be Hugging Face format (`.safetensors`, `config.json`, `tokenizer_config.json`, `tokenizer.json`), under 200 GB (100 GB multimodal), context under 128K, transformers 4.51.3. No embedding models. Bedrock overrides Llama 3 `rope_scaling`.
- Inference: `POST /model/{importedModelArn}/invoke` on the runtime host, on-demand throughput only. `ModelNotReadyException` (429) while a copy warms up; the SDK retries up to 5 times.
- Billing: Custom Model Units per model copy, charged in 5-minute windows from the first successful inference; idle models bill nothing. Cost formula: copies x CMUs per copy x per-CMU-per-minute rate x (5-minute windows / 60). CMU count and version come from `GetImportedModel`; the rate is only on the pricing page.

## Deltas from the spec

- **No separate upload step.** The import job reads the S3 registry prefix directly (`s3://bucket/prefix`, the version `@pin` stripped). `roleArn` must be able to read that bucket; registry access keys are not used. Only the S3 registry source is supported; `hf://` and `file://` are refused with `ADAPTER_UNSUPPORTED_OPERATION`.
- **Serverless, so scaling is implicit.** Bedrock adds and removes model copies itself. `scale(n)` records the ceiling on the handle only; `scale(0)` marks the handle standby, which `readEndpoint` reports as `stopped` with a zero burn rate. Nothing is sent to AWS.
- **The endpoint is an ARN, not a URL.** `url` is the runtime invoke URL with the imported model ARN URL-encoded into the path, so the gateway can address the model; the gateway's Bedrock dispatch signs the call itself.
- **Architecture gate is by prefix of `version.base`** against the family list above (`mistral`, `mixtral`, `flan`, `llama`, `mllama`, `gpt_bigcode`, `qwen2`, `qwen3`, `gpt-oss`). Bedrock detects the real architecture from `config.json`; a mismatch surfaces as a `Failed` job with `failureMessage`.
- **No cancel API for an import job.** Teardown deletes the imported model by name; while the job is still `InProgress` that call fails with a conflict and the reconcile loop retries after the job finishes.
- **Cost is an estimate.** There is no per-model billing API. `hourlyRateCents` (CMUs per copy x per-CMU rate, entered by the operator) times hours since the import gives an upper bound; the rate is reported as zero when standby. Reading the CloudWatch `ModelCopy` metric to count billed copies is the follow-up.
- Requests are signed with the in-repo SigV4 signer (`model-deployments/aws-request.ts`, cross-checked against `@smithy/signature-v4` in `__tests__/aws-request.spec.ts`) because no Bedrock SDK client is installed.

## Live smoke

`CONFORMANCE_LIVE=aws-bedrock-import` with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN` optional), `AWS_REGION`, `BEDROCK_IMPORT_ROLE_ARN`, `BEDROCK_TEST_S3_URI` (HF-format weights of a small Qwen3 or Llama). Import takes 15 to 45 minutes. Not yet run.
