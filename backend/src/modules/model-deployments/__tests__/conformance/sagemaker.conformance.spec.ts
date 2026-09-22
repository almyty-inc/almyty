import { SageMakerAdapter } from '../../adapters/sagemaker.adapter';
import { accessKeyOf } from '../../aws-request';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the SageMaker control plane,
 * faithful to the JSON 1.1 protocol (POST /, X-Amz-Target:
 * SageMaker.{Operation}), the documented EndpointStatus and
 * InferenceComponentStatus values, the {__type, message} error envelope,
 * and the quirk that a missing endpoint or component is a 400
 * ValidationException rather than a 404. Live mode
 * (CONFORMANCE_LIVE=sagemaker with AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_REGION, SAGEMAKER_EXECUTION_ROLE_ARN and
 * SAGEMAKER_TEST_S3_URI) runs the same cases against a real account;
 * never in CI.
 */
function fixtureHttp() {
  const models = new Map<string, any>();
  const configs = new Map<string, any>();
  const endpoints = new Map<string, any>();
  const components = new Map<string, any>();
  const calls: Array<{ target: string; headers: Record<string, string>; body: any }> = [];
  const awsError = (status: number, type: string, message: string) =>
    Object.assign(new Error(`${status}`), { response: { status, data: { __type: `com.amazon.coral.service#${type}`, message }, headers: {} } });
  const missingEndpoint = (name: string) => awsError(400, 'ValidationException', `Could not find endpoint "arn:aws:sagemaker:us-east-1:111122223333:endpoint/${name}".`);
  const missingComponent = (name: string) => awsError(400, 'ValidationException', `Could not find inference component "${name}".`);
  const http = {
    request: jest.fn(async (config: { method: string; url: string; headers: Record<string, string>; data?: string }) => {
      const target = String(config.headers['x-amz-target'] ?? '').replace(/^SageMaker\./, '');
      const body = config.data ? JSON.parse(config.data) : {};
      calls.push({ target, headers: config.headers, body });
      if (accessKeyOf(config.headers.authorization) !== 'AKIAVALID') {
        throw awsError(403, 'UnrecognizedClientException', 'The security token included in the request is invalid.');
      }
      switch (target) {
        case 'CreateModel':
          models.set(body.ModelName, body);
          return { status: 200, data: { ModelArn: `arn:aws:sagemaker:us-east-1:111122223333:model/${body.ModelName}` } };
        case 'CreateEndpointConfig': {
          const variant = body.ProductionVariants[0];
          if (variant.InstanceType === 'ml.p5.48xlarge') throw awsError(400, 'ResourceLimitExceeded', 'The account-level service limit ml.p5.48xlarge for endpoint usage is 0 Instances.');
          configs.set(body.EndpointConfigName, body);
          return { status: 200, data: { EndpointConfigArn: `arn:aws:sagemaker:us-east-1:111122223333:endpoint-config/${body.EndpointConfigName}` } };
        }
        case 'CreateEndpoint': {
          const cfg = configs.get(body.EndpointConfigName);
          if (!cfg) throw awsError(400, 'ValidationException', `Could not find endpoint configuration "${body.EndpointConfigName}".`);
          const variant = cfg.ProductionVariants[0];
          endpoints.set(body.EndpointName, {
            EndpointName: body.EndpointName,
            EndpointArn: `arn:aws:sagemaker:us-east-1:111122223333:endpoint/${body.EndpointName}`,
            EndpointConfigName: body.EndpointConfigName,
            EndpointStatus: 'Creating',
            ProductionVariants: [{ VariantName: variant.VariantName, InstanceType: variant.InstanceType, CurrentInstanceCount: 0, DesiredInstanceCount: variant.InitialInstanceCount, CurrentWeight: 1, DesiredWeight: 1 }],
          });
          return { status: 200, data: { EndpointArn: endpoints.get(body.EndpointName).EndpointArn } };
        }
        case 'CreateInferenceComponent': {
          if (!endpoints.has(body.EndpointName)) throw missingEndpoint(body.EndpointName);
          if (body.Specification?.ComputeResourceRequirements?.NumberOfAcceleratorDevicesRequired > 8) {
            throw awsError(400, 'ResourceLimitExceeded', 'The requested accelerator devices exceed the instance capacity.');
          }
          components.set(body.InferenceComponentName, {
            InferenceComponentName: body.InferenceComponentName,
            InferenceComponentArn: `arn:aws:sagemaker:us-east-1:111122223333:inference-component/${body.InferenceComponentName}`,
            EndpointName: body.EndpointName,
            VariantName: body.VariantName,
            InferenceComponentStatus: 'Creating',
            Specification: body.Specification,
            RuntimeConfig: { CurrentCopyCount: 0, DesiredCopyCount: body.RuntimeConfig?.CopyCount ?? 1 },
          });
          return { status: 200, data: { InferenceComponentArn: components.get(body.InferenceComponentName).InferenceComponentArn } };
        }
        case 'DescribeEndpoint': {
          const ep = endpoints.get(body.EndpointName);
          if (!ep) throw missingEndpoint(body.EndpointName);
          // The fixture finishes any transition on the first read after it.
          if (ep.EndpointStatus === 'Creating' || ep.EndpointStatus === 'Updating') {
            ep.EndpointStatus = 'InService';
            ep.ProductionVariants[0].CurrentInstanceCount = ep.ProductionVariants[0].DesiredInstanceCount;
          }
          return { status: 200, data: JSON.parse(JSON.stringify(ep)) };
        }
        case 'DescribeInferenceComponent': {
          const ic = components.get(body.InferenceComponentName);
          if (!ic) throw missingComponent(body.InferenceComponentName);
          if (ic.InferenceComponentStatus === 'Creating' || ic.InferenceComponentStatus === 'Updating') {
            ic.InferenceComponentStatus = 'InService';
            ic.RuntimeConfig.CurrentCopyCount = ic.RuntimeConfig.DesiredCopyCount;
            // Managed instance scaling drains the variant once no copy is left.
            const ep = endpoints.get(ic.EndpointName);
            if (ep) ep.ProductionVariants[0].CurrentInstanceCount = ic.RuntimeConfig.CurrentCopyCount === 0 ? 0 : Math.max(1, ep.ProductionVariants[0].DesiredInstanceCount);
          }
          return { status: 200, data: JSON.parse(JSON.stringify(ic)) };
        }
        case 'UpdateInferenceComponentRuntimeConfig': {
          const ic = components.get(body.InferenceComponentName);
          if (!ic) throw missingComponent(body.InferenceComponentName);
          ic.RuntimeConfig.DesiredCopyCount = body.DesiredRuntimeConfig.CopyCount;
          ic.InferenceComponentStatus = 'Updating';
          return { status: 200, data: { InferenceComponentArn: ic.InferenceComponentArn } };
        }
        case 'DeleteInferenceComponent':
          if (!components.delete(body.InferenceComponentName)) throw missingComponent(body.InferenceComponentName);
          return { status: 200, data: '' };
        case 'DeleteEndpoint':
          if (!endpoints.delete(body.EndpointName)) throw missingEndpoint(body.EndpointName);
          return { status: 200, data: '' };
        case 'DeleteEndpointConfig':
          if (!configs.delete(body.EndpointConfigName)) throw awsError(400, 'ValidationException', `Could not find endpoint configuration "${body.EndpointConfigName}".`);
          return { status: 200, data: '' };
        case 'DeleteModel':
          if (!models.delete(body.ModelName)) throw awsError(400, 'ValidationException', `Could not find model "${body.ModelName}".`);
          return { status: 200, data: '' };
        default:
          throw new Error(`unexpected operation ${target}`);
      }
    }),
  };
  return { models, configs, endpoints, components, calls, http };
}

const live = liveRequested('sagemaker');
const fixture = fixtureHttp();
const adapter = () => (live ? new SageMakerAdapter() : new SageMakerAdapter(fixture.http));
const liveCreds = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
const tiny = {
  id: 'v1',
  name: 'qwen3-0.6b',
  registryUri: live ? `${process.env.SAGEMAKER_TEST_S3_URI}@live` : 's3://registry/models/qwen3-0.6b@etag1',
  base: 'qwen3-0.6b',
  quantizations: [],
  manifestSha: 'sha',
};
const config = {
  region: live ? process.env.AWS_REGION ?? 'us-east-1' : 'us-east-1',
  executionRoleArn: live ? process.env.SAGEMAKER_EXECUTION_ROLE_ARN : 'arn:aws:iam::111122223333:role/sagemaker-exec',
  instanceType: 'ml.g5.xlarge',
  hourlyRateCents: 141,
};

runConformance(live ? 'sagemaker (LIVE)' : 'sagemaker (fixture)', {
  adapter,
  credentials: live ? liveCreds : { accessKeyId: 'AKIAVALID', secretAccessKey: 'secret' },
  badCredentials: { accessKeyId: 'AKIAEXPIRED', secretAccessKey: 'secret' },
  tinyVersion: tiny,
  providerConfig: config,
  quotaExceededConfig: live ? undefined : { ...config, instanceType: 'ml.p5.48xlarge' },
  vanish: live ? undefined : (_a, ref) => { fixture.endpoints.delete(ref.endpointName); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('sagemaker request shape', () => {
  const creds = { accessKeyId: 'AKIAVALID', secretAccessKey: 'secret' };
  const request = (overrides: Partial<Parameters<SageMakerAdapter['deploy']>[0]> = {}) => ({
    deploymentId: 'abc-123',
    organizationId: 'org-1',
    version: { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
    desired: { replicas: 2, minScale: 0, maxScale: 3, hardware: 'ml.g6.2xlarge', region: 'eu-west-1' },
    providerConfig: { region: 'us-east-1', executionRoleArn: 'arn:aws:iam::111122223333:role/sagemaker-exec', environment: { OPTION_MAX_MODEL_LEN: '8192' }, kmsKeyId: 'alias/almyty', hourlyRateCents: 141 },
    ...overrides,
  });

  it('creates model, config, endpoint and inference component in order, with the registry prefix as uncompressed model data', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    const ref = await a.deploy(request(), creds);
    expect(f.calls.map((c) => c.target)).toEqual(['CreateModel', 'CreateEndpointConfig', 'CreateEndpoint', 'CreateInferenceComponent']);
    for (const c of f.calls) {
      expect(c.headers['content-type']).toBe('application/x-amz-json-1.1');
      expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAVALID\/\d{8}\/eu-west-1\/sagemaker\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
    }
    expect(f.http.request.mock.calls[0][0].url).toBe('https://api.sagemaker.eu-west-1.amazonaws.com/');

    const model = f.calls[0].body;
    expect(model).toEqual({
      ModelName: 'almyty-abc123-model',
      ExecutionRoleArn: 'arn:aws:iam::111122223333:role/sagemaker-exec',
      PrimaryContainer: {
        Image: '763104351884.dkr.ecr.eu-west-1.amazonaws.com/djl-inference:0.33.0-lmi15.0.0-cu128',
        ModelDataSource: { S3DataSource: { S3Uri: 's3://registry/models/q/', S3DataType: 'S3Prefix', CompressionType: 'None' } },
        Environment: { HF_MODEL_ID: '/opt/ml/model', OPTION_ROLLING_BATCH: 'vllm', OPTION_MAX_MODEL_LEN: '8192' },
      },
      Tags: [{ Key: 'almyty:deployment', Value: 'abc-123' }, { Key: 'almyty:organization', Value: 'org-1' }],
    });
    // SageMaker pulls the weights itself through the execution role.
    expect(JSON.stringify(f.calls.map((c) => c.body))).not.toContain('AWS_ACCESS_KEY_ID');

    const cfg = f.calls[1].body;
    expect(cfg.EndpointConfigName).toBe('almyty-abc123-cfg');
    expect(cfg.KmsKeyId).toBe('alias/almyty');
    expect(cfg.ProductionVariants).toEqual([
      {
        VariantName: 'primary',
        InstanceType: 'ml.g6.2xlarge',
        InitialInstanceCount: 1,
        InitialVariantWeight: 1,
        ManagedInstanceScaling: { Status: 'ENABLED', MinInstanceCount: 0, MaxInstanceCount: 3 },
        RoutingConfig: { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' },
      },
    ]);
    // The variant names no model: hosting it in an inference component is
    // what lets the endpoint scale in to zero instances.
    expect(cfg.ProductionVariants[0].ModelName).toBeUndefined();

    expect(f.calls[2].body).toEqual({ EndpointName: 'almyty-abc123', EndpointConfigName: 'almyty-abc123-cfg', Tags: model.Tags });
    expect(f.calls[3].body).toEqual({
      InferenceComponentName: 'almyty-abc123-ic',
      EndpointName: 'almyty-abc123',
      VariantName: 'primary',
      Specification: {
        ModelName: 'almyty-abc123-model',
        ComputeResourceRequirements: { NumberOfAcceleratorDevicesRequired: 1 },
        StartupParameters: { ModelDataDownloadTimeoutInSeconds: 1800, ContainerStartupHealthCheckTimeoutInSeconds: 1800 },
      },
      RuntimeConfig: { CopyCount: 2 },
      Tags: model.Tags,
    });
    expect(ref).toMatchObject({ endpointName: 'almyty-abc123', endpointConfigName: 'almyty-abc123-cfg', modelName: 'almyty-abc123-model', inferenceComponentName: 'almyty-abc123-ic', region: 'eu-west-1', instanceType: 'ml.g6.2xlarge', copyCount: 2, hourlyRateCents: 141 });
    expect(ref.url).toBe('https://runtime.sagemaker.eu-west-1.amazonaws.com/endpoints/almyty-abc123/invocations');
  });

  it('deploys a JumpStart or Marketplace model package with no image and no artifacts of ours', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    const arn = 'arn:aws:sagemaker:eu-west-1:111122223333:model-package/llama-3-1-8b-instruct-v1';
    await a.deploy(request({ version: { id: 'v', name: 'llama', registryUri: `sagemaker://model-package/${arn}`, base: 'llama-3.1-8b', quantizations: [], manifestSha: 's' } }), creds);
    expect(f.calls[0].body.PrimaryContainer).toEqual({ ModelPackageName: arn });
    expect(f.calls[0].body.PrimaryContainer.Image).toBeUndefined();
    expect(f.calls[0].body.PrimaryContainer.ModelDataSource).toBeUndefined();
  });

  it('refuses a model package reference that is not an ARN', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    await expect(a.deploy(request({ version: { id: 'v', name: 'q', registryUri: 'sagemaker://model-package/llama-3-1-8b', base: 'q', quantizations: [], manifestSha: 's' } }), creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    expect(f.calls).toHaveLength(0);
  });

  it('honours a custom image and a fixed replica floor', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    await a.deploy(request({ desired: { replicas: 1, minScale: 1, maxScale: 1 }, providerConfig: { region: 'us-east-1', executionRoleArn: 'arn:aws:iam::1:role/r', image: 'vllm/vllm-openai:latest', acceleratorDevices: 2, minMemoryMb: 16384 } }), creds);
    expect(f.calls[0].body.PrimaryContainer.Image).toBe('vllm/vllm-openai:latest');
    const variant = f.calls[1].body.ProductionVariants[0];
    expect(variant.InstanceType).toBe('ml.g5.xlarge');
    expect(variant.ManagedInstanceScaling).toEqual({ Status: 'ENABLED', MinInstanceCount: 1, MaxInstanceCount: 1 });
    expect(f.calls[3].body.Specification.ComputeResourceRequirements).toEqual({ NumberOfAcceleratorDevicesRequired: 2, MinMemoryRequiredInMb: 16384 });
  });

  it('removes the model and config again when a later create step fails', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    await expect(a.deploy(request({ desired: { hardware: 'ml.p5.48xlarge' } }), creds)).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
    expect(f.calls.map((c) => c.target)).toEqual(['CreateModel', 'CreateEndpointConfig', 'DeleteModel']);
    expect(f.models.size).toBe(0);
  });

  it('removes the endpoint too when the inference component is refused', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    await expect(a.deploy(request({ providerConfig: { region: 'us-east-1', executionRoleArn: 'arn:aws:iam::1:role/r', acceleratorDevices: 16 } }), creds)).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
    expect(f.calls.map((c) => c.target)).toEqual(['CreateModel', 'CreateEndpointConfig', 'CreateEndpoint', 'CreateInferenceComponent', 'DeleteEndpoint', 'DeleteEndpointConfig', 'DeleteModel']);
    expect(f.endpoints.size + f.configs.size + f.models.size + f.components.size).toBe(0);
  });

  it('refuses a source SageMaker cannot read, naming the two it accepts, before calling AWS', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    for (const registryUri of ['hf://Qwen/Qwen3-0.6B@main', 'gs://bucket/models/q@etag', 'bedrock://anthropic.claude-3-sonnet-20240229-v1:0']) {
      await expect(a.deploy(request({ version: { id: 'v', name: 'q', registryUri, base: 'q', quantizations: [], manifestSha: 's' } }), creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    }
    await expect(a.deploy(request({ version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'q', quantizations: [], manifestSha: 's' } }), creds)).rejects.toThrow(/s3:\/\/.*model-package/s);
    expect(f.calls).toHaveLength(0);
  });

  it('maps every documented EndpointStatus, and the component status once the endpoint is in service', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    const ref = await a.deploy(request(), creds);
    await a.readEndpoint(ref, creds);
    const ep = f.endpoints.get(ref.endpointName);
    const ic = f.components.get(ref.inferenceComponentName);
    for (const [raw, expected] of Object.entries({ SystemUpdating: 'scaling', RollingBack: 'scaling', OutOfService: 'stopped', Deleting: 'stopped', Failed: 'failed', UpdateRollbackFailed: 'failed' })) {
      ep.EndpointStatus = raw;
      ep.FailureReason = raw === 'Failed' ? 'ml.g6.2xlarge capacity unavailable' : undefined;
      const actual = await a.readEndpoint(ref, creds);
      expect(actual.state).toBe(expected);
      if (raw === 'Failed') expect(actual.message).toBe('ml.g6.2xlarge capacity unavailable');
    }
    ep.EndpointStatus = 'InService';
    for (const [raw, expected] of Object.entries({ InService: 'ready', Failed: 'failed', Deleting: 'stopped' })) {
      ic.InferenceComponentStatus = raw;
      ic.FailureReason = raw === 'Failed' ? 'container failed the health check' : undefined;
      const actual = await a.readEndpoint(ref, creds);
      expect(actual.state).toBe(expected);
      expect(actual.details!.inferenceComponentState).toBe(raw);
    }
    ic.InferenceComponentStatus = 'InService';
    ic.FailureReason = undefined;
    ic.RuntimeConfig.CurrentCopyCount = 0;
    expect((await a.readEndpoint(ref, creds)).state).toBe('stopped');
    // The endpoint outliving its component serves nothing.
    f.components.delete(ref.inferenceComponentName);
    expect((await a.readEndpoint(ref, creds)).state).toBe('stopped');
  });

  it('scales the copy count, reaches zero copies and zero instances, and tears down in order', async () => {
    const f = fixtureHttp();
    const a = new SageMakerAdapter(f.http);
    const ref = await a.deploy(request(), creds);
    const ready = await a.readEndpoint(ref, creds);
    expect(ready.state).toBe('ready');
    expect(ready.replicas).toBe(2);
    expect(ready.details).toMatchObject({ inferenceComponentName: 'almyty-abc123-ic', invokeHeader: 'X-Amzn-SageMaker-Inference-Component' });

    await a.scale(ref, 3, creds);
    const scale = f.calls[f.calls.length - 1];
    expect(scale.target).toBe('UpdateInferenceComponentRuntimeConfig');
    expect(scale.body).toEqual({ InferenceComponentName: 'almyty-abc123-ic', DesiredRuntimeConfig: { CopyCount: 3 } });
    const scaled = await a.readEndpoint(ref, creds);
    expect(scaled.replicas).toBe(3);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(141);

    await a.scale(ref, 0, creds);
    const stopped = await a.readEndpoint(ref, creds);
    expect(stopped.state).toBe('stopped');
    expect(stopped.replicas).toBe(0);
    // Managed instance scaling drains the variant after the last copy is gone, so the count is zero on the next read.
    expect((await a.readEndpoint(ref, creds)).details!.currentInstanceCount).toBe(0);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(0);

    await a.teardown(ref, creds);
    expect(f.calls.slice(-4).map((c) => c.target)).toEqual(['DeleteInferenceComponent', 'DeleteEndpoint', 'DeleteEndpointConfig', 'DeleteModel']);
    expect(f.endpoints.size + f.configs.size + f.models.size + f.components.size).toBe(0);
    await expect(a.teardown(ref, creds)).resolves.toBeUndefined();
    expect((await a.readEndpoint(ref, creds)).state).toBe('missing');
  });
});
