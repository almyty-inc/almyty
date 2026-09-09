# Adapter: sagemaker

Amazon SageMaker real-time endpoints, in the customer's own AWS account. Adapter key `sagemaker`, source `backend/src/modules/model-deployments/adapters/sagemaker.adapter.ts`, fixture conformance `__tests__/conformance/sagemaker.conformance.spec.ts`.

## Verified API facts (docs.aws.amazon.com/sagemaker, checked 2026-09-08)

- JSON 1.1 protocol: `POST https://api.sagemaker.{region}.amazonaws.com/` with `Content-Type: application/x-amz-json-1.1` and `X-Amz-Target: SageMaker.{Operation}`; SigV4 service name `sagemaker`. Inference at `https://runtime.sagemaker.{region}.amazonaws.com/endpoints/{name}/invocations`.
- `CreateModel {ModelName, ExecutionRoleArn, PrimaryContainer {Image, ModelDataSource {S3DataSource {S3Uri, S3DataType: S3Prefix|S3Object, CompressionType: None|Gzip}}, Environment}, Tags, VpcConfig}` returns `{ModelArn}`. An uncompressed prefix source lands in `/opt/ml/model`.
- `CreateEndpointConfig {EndpointConfigName, ProductionVariants [{VariantName, ModelName, InstanceType, InitialInstanceCount, InitialVariantWeight, ModelDataDownloadTimeoutInSeconds, ContainerStartupHealthCheckTimeoutInSeconds, VolumeSizeInGB, ManagedInstanceScaling {Status ENABLED|DISABLED, MinInstanceCount >= 0, MaxInstanceCount >= 1}, RoutingConfig {RoutingStrategy}}], KmsKeyId, Tags}` returns `{EndpointConfigArn}`.
- `CreateEndpoint {EndpointName, EndpointConfigName, Tags}` returns `{EndpointArn}`; names are `[a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}` and unique per region.
- `DescribeEndpoint {EndpointName}`: `EndpointStatus` in `OutOfService | Creating | Updating | SystemUpdating | RollingBack | InService | Deleting | Failed | UpdateRollbackFailed`, `FailureReason`, `ProductionVariants [{VariantName, InstanceType, CurrentInstanceCount, DesiredInstanceCount, CurrentWeight, DesiredWeight, VariantStatus}]`.
- `UpdateEndpointWeightsAndCapacities {EndpointName, DesiredWeightsAndCapacities [{VariantName, DesiredInstanceCount (min 0), DesiredWeight}]}` puts the endpoint in `Updating`, then `InService`.
- `DeleteEndpoint`, `DeleteEndpointConfig`, `DeleteModel`. A config in use by a live endpoint may not be deleted.
- Errors: `ResourceLimitExceeded` 400 on the create and update calls; common errors `AccessDeniedException` 403, `UnrecognizedClientException` 403, `ExpiredTokenException` 403, `ThrottlingException` 400 (documented as 400 for SageMaker), `ValidationError` 400. The type is the body's `__type` (`com.amazon.coral.service#Name`). A missing endpoint is not a 404: `DescribeEndpoint` returns 400 `ValidationException` with "Could not find endpoint".

## Deltas from the spec

- **Three resources per deployment**, named `almyty-{id}-model`, `almyty-{id}-cfg`, `almyty-{id}`. A failure in a later create step deletes the earlier resources so nothing is left half-made.
- **Container**: the LMI (DJL) vLLM deep learning container `763104351884.dkr.ecr.{region}.amazonaws.com/djl-inference:0.33.0-lmi15.0.0-cu128` by default, with `HF_MODEL_ID=/opt/ml/model` and `OPTION_ROLLING_BATCH=vllm`; `environment` from the provider config is merged over that, and `image` replaces the whole URI (the DLC ECR account differs in a few regions, and the LMI version moves).
- **Weights are pulled by the execution role, not by registry keys.** `ModelDataSource` points at the registry prefix (`s3://bucket/prefix/`, the `@pin` stripped, trailing slash required for `S3Prefix`). The registry bucket must be readable by `executionRoleArn` and live in the customer's AWS account or be shared with it; a MinIO or cross-cloud registry cannot be served here without copying first. Only the S3 registry source is accepted.
- **Scale to zero** is expressed as `ManagedInstanceScaling {MinInstanceCount: 0}` plus `RoutingConfig LEAST_OUTSTANDING_REQUESTS` on the variant whenever `minScale`/`maxScale` are given, and `scale(0)` sends `DesiredInstanceCount: 0`. SageMaker still needs an Application Auto Scaling target and policy to scale in and out on its own; the adapter does not create those (a follow-up). Without managed scaling a fixed count is provisioned and `scale(0)` is refused by SageMaker as a `ValidationException`.
- **State mapping**: `Creating` deploying; `Updating | SystemUpdating | RollingBack` scaling; `InService` ready, or stopped when the variant has zero instances; `OutOfService | Deleting` stopped; `Failed | UpdateRollbackFailed` failed with `FailureReason`; a missing endpoint is `missing`.
- **Cost is an estimate**: `hourlyRateCents` for the instance type times observed instances for the rate, times the initial count and elapsed time for spend. The Pricing API needs `pricing:GetProducts` in us-east-1 and a product filter per instance type; not wired.
- Requests are signed with the in-repo SigV4 signer (`model-deployments/aws-request.ts`) because no SageMaker SDK client is installed.

## Live smoke

`CONFORMANCE_LIVE=sagemaker` with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `SAGEMAKER_EXECUTION_ROLE_ARN`, `SAGEMAKER_TEST_S3_URI` (prefix with HF-format weights in the same account). An `ml.g5.xlarge` endpoint takes 8 to 15 minutes to come `InService`. Not yet run.
