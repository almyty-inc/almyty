import axios from 'axios';

import {
  ActualState,
  AdapterCapabilities,
  AdapterCredentials,
  CostSnapshot,
  DeployRequest,
  EndpointRef,
  ModelProviderAdapter,
  UnsupportedOperationError,
} from './adapter.interface';
import { AwsHttp, classifyAwsError, signAwsRequest } from '../aws-request';

/**
 * Amazon SageMaker AI real-time inference, in the customer's own AWS
 * account.
 *
 * JSON 1.1 protocol at https://api.sagemaker.{region}.amazonaws.com
 * (POST /, X-Amz-Target: SageMaker.{Operation}), SigV4 service
 * "sagemaker". SageMaker loads model artifacts from Amazon S3 by design
 * and pulls them itself through `executionRoleArn`, so S3 is the native
 * source here and almyty is never in the data path.
 *
 * A deployment is four resources: CreateModel, CreateEndpointConfig,
 * CreateEndpoint and CreateInferenceComponent. The endpoint config's
 * variant deliberately names no model: hosting the model in an inference
 * component is what AWS requires for an endpoint that can scale in to and
 * out from zero instances, and it is the shape AWS documents for new
 * real-time endpoints. Scaling is
 * UpdateInferenceComponentRuntimeConfig on the copy count, which may be
 * zero; the variant's ManagedInstanceScaling then drains the instances.
 *
 * Two model sources, chosen from the version's registry URI:
 *
 *   s3://...                             the customer's own weights, read
 *     as an uncompressed S3Prefix by a serving container (the LMI/vLLM
 *     deep learning container by default).
 *
 *   sagemaker://model-package/<arn>      a listed model: a SageMaker
 *     JumpStart or AWS Marketplace model package, deployed through
 *     PrimaryContainer.ModelPackageName so AWS supplies the image and the
 *     artifacts and almyty specifies no container at all.
 *
 * Deltas and verified facts: docs/design/adapters/sagemaker.md.
 */
const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-south-1', 'sa-east-1',
];

/** The LMI (vLLM) deep learning container; the ECR account differs in a few regions, so the image is overridable. */
const DEFAULT_IMAGE_TAG = 'djl-inference:0.33.0-lmi15.0.0-cu128';
const DLC_ACCOUNT = '763104351884';
const VARIANT = 'primary';

const ACCEPTED_SOURCES = 'model artifacts in Amazon S3 (s3://), or a JumpStart / Marketplace model package (sagemaker://model-package/<arn>)';

const STATE_MAP: Record<string, ActualState['state']> = {
  Creating: 'deploying',
  Updating: 'scaling',
  SystemUpdating: 'scaling',
  RollingBack: 'scaling',
  InService: 'ready',
  OutOfService: 'stopped',
  Deleting: 'stopped',
  Failed: 'failed',
  UpdateRollbackFailed: 'failed',
};

/** InferenceComponentStatus: InService | Creating | Updating | Failed | Deleting. */
const IC_STATE_MAP: Record<string, ActualState['state']> = {
  Creating: 'deploying',
  Updating: 'scaling',
  InService: 'ready',
  Failed: 'failed',
  Deleting: 'stopped',
};

export class SageMakerAdapter implements ModelProviderAdapter {
  readonly key = 'sagemaker';
  readonly displayName = 'Amazon SageMaker AI (real-time endpoint)';

  constructor(private readonly http: AwsHttp = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: REGIONS,
      // SageMaker reads model artifacts from Amazon S3 by design, through
      // the execution role. It has no way to read a Hugging Face
      // repository directly, and a model package needs no source at all.
      registrySources: ['s3'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        accessKeyId: { type: 'string', title: 'AWS access key id', 'x-secret': true },
        secretAccessKey: { type: 'string', title: 'AWS secret access key', 'x-secret': true },
        sessionToken: { type: 'string', title: 'AWS session token', description: 'Only for temporary credentials', 'x-secret': true },
        region: { type: 'string', title: 'Region', enum: REGIONS, default: 'us-east-1' },
        executionRoleArn: { type: 'string', title: 'Execution role ARN', description: 'Role SageMaker assumes to pull the image and read the model artifacts from S3' },
        image: { type: 'string', title: 'Container image', description: `S3 source only; defaults to the LMI vLLM DLC for the region (${DEFAULT_IMAGE_TAG}). A model package brings its own image.` },
        instanceType: { type: 'string', title: 'Instance type', default: 'ml.g5.xlarge' },
        acceleratorDevices: { type: 'integer', minimum: 0, default: 1, title: 'Accelerator devices per copy', description: 'NumberOfAcceleratorDevicesRequired on the inference component' },
        minMemoryMb: { type: 'integer', minimum: 128, title: 'Minimum memory per copy (MB)', description: 'MinMemoryRequiredInMb on the inference component' },
        volumeSizeGb: { type: 'integer', title: 'EBS volume (GB)', description: 'Only for instance types without local NVMe' },
        modelDataDownloadTimeoutSeconds: { type: 'integer', minimum: 60, default: 1800 },
        containerStartupHealthCheckTimeoutSeconds: { type: 'integer', minimum: 60, default: 1800 },
        environment: { type: 'object', additionalProperties: { type: 'string' }, title: 'Extra container environment', description: 'S3 source only; merged over the LMI defaults' },
        kmsKeyId: { type: 'string', title: 'KMS key for the instance volume' },
        vpcSubnetIds: { type: 'array', items: { type: 'string' }, title: 'VPC subnet ids' },
        vpcSecurityGroupIds: { type: 'array', items: { type: 'string' }, title: 'VPC security group ids' },
        hourlyRateCents: { type: 'integer', title: 'Instance price per hour (cents)', description: 'From the SageMaker pricing page; used to estimate spend' },
      },
      required: ['accessKeyId', 'secretAccessKey', 'region', 'executionRoleArn'],
    };
  }

  private creds(credentials: AdapterCredentials) {
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      throw Object.assign(new Error('missing AWS access key'), { code: 'ADAPTER_AUTH', status: 401 });
    }
    return { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken };
  }

  private async op(operation: string, region: string, body: Record<string, any>, credentials: AdapterCredentials): Promise<any> {
    const data = JSON.stringify(body);
    const signed = signAwsRequest({
      method: 'POST',
      url: `https://api.sagemaker.${region}.amazonaws.com/`,
      service: 'sagemaker',
      region,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `SageMaker.${operation}` },
      body: data,
      credentials: this.creds(credentials),
    });
    const res = await this.http.request({ method: 'POST', url: signed.url, headers: signed.headers, data });
    return res.data;
  }

  static names(deploymentId: string) {
    const base = `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 40)}`;
    return { endpointName: base, endpointConfigName: `${base}-cfg`, modelName: `${base}-model`, inferenceComponentName: `${base}-ic` };
  }

  static defaultImage(region: string): string {
    return `${DLC_ACCOUNT}.dkr.ecr.${region}.amazonaws.com/${DEFAULT_IMAGE_TAG}`;
  }

  static invokeUrl(region: string, endpointName: string): string {
    return `https://runtime.sagemaker.${region}.amazonaws.com/endpoints/${encodeURIComponent(endpointName)}/invocations`;
  }

  /** An uncompressed S3 prefix source must end with a slash. */
  static s3Prefix(registryUri: string): string {
    return `${registryUri.replace(/@[^@/]+$/, '').replace(/\/+$/, '')}/`;
  }

  /** The model package ARN behind a sagemaker://model-package/ version. */
  static modelPackageArn(registryUri: string): string {
    const arn = registryUri.slice('sagemaker://model-package/'.length).replace(/@[^@/]+$/, '');
    if (!arn.startsWith('arn:')) {
      throw new UnsupportedOperationError('sagemaker', `the model package reference "${arn}". Give the full ARN, as sagemaker://model-package/arn:aws:sagemaker:<region>:<account>:model-package/<name>`);
    }
    return arn;
  }

  /** The container definition for the version, which decides who supplies the image. */
  static primaryContainer(request: DeployRequest, region: string): Record<string, any> {
    const uri = request.version.registryUri;
    const cfg = request.providerConfig;
    if (uri.startsWith('sagemaker://model-package/')) {
      // AWS supplies the image and the artifacts; almyty specifies neither.
      return { ModelPackageName: SageMakerAdapter.modelPackageArn(uri) };
    }
    if (uri.startsWith('s3://')) {
      return {
        Image: cfg.image ?? SageMakerAdapter.defaultImage(region),
        ModelDataSource: { S3DataSource: { S3Uri: SageMakerAdapter.s3Prefix(uri), S3DataType: 'S3Prefix', CompressionType: 'None' } },
        Environment: {
          HF_MODEL_ID: '/opt/ml/model',
          OPTION_ROLLING_BATCH: 'vllm',
          ...(request.desired.quantization ? { OPTION_QUANTIZE: request.desired.quantization } : {}),
          ...(cfg.environment ?? {}),
        },
      };
    }
    throw new UnsupportedOperationError('sagemaker', `a ${uri.split(':')[0]}:// version. SageMaker deploys ${ACCEPTED_SOURCES}`);
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    this.creds(credentials);
    const cfg = request.providerConfig;
    const region = request.desired.region ?? cfg.region ?? 'us-east-1';
    const names = SageMakerAdapter.names(request.deploymentId);
    const primaryContainer = SageMakerAdapter.primaryContainer(request, region);
    const instanceType = request.desired.hardware ?? cfg.instanceType ?? 'ml.g5.xlarge';
    const copies = Math.max(1, request.desired.replicas ?? 1);
    const minInstances = request.desired.minScale ?? 0;
    const maxInstances = Math.max(1, request.desired.maxScale ?? copies);
    const tags = [
      { Key: 'almyty:deployment', Value: request.deploymentId },
      { Key: 'almyty:organization', Value: request.organizationId },
    ];
    const vpc = cfg.vpcSubnetIds?.length ? { VpcConfig: { Subnets: cfg.vpcSubnetIds, SecurityGroupIds: cfg.vpcSecurityGroupIds ?? [] } } : {};

    const model = {
      ModelName: names.modelName,
      ExecutionRoleArn: cfg.executionRoleArn,
      PrimaryContainer: primaryContainer,
      Tags: tags,
      ...vpc,
    };
    const endpointConfig = {
      EndpointConfigName: names.endpointConfigName,
      ProductionVariants: [
        {
          // No ModelName: the model is hosted in an inference component,
          // which is what lets this endpoint scale in to zero instances.
          VariantName: VARIANT,
          InstanceType: instanceType,
          InitialInstanceCount: Math.max(1, minInstances || 1),
          InitialVariantWeight: 1,
          ManagedInstanceScaling: { Status: 'ENABLED', MinInstanceCount: minInstances, MaxInstanceCount: maxInstances },
          RoutingConfig: { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' },
          ...(cfg.volumeSizeGb ? { VolumeSizeInGB: cfg.volumeSizeGb } : {}),
        },
      ],
      ...(cfg.kmsKeyId ? { KmsKeyId: cfg.kmsKeyId } : {}),
      Tags: tags,
    };
    const inferenceComponent = {
      InferenceComponentName: names.inferenceComponentName,
      EndpointName: names.endpointName,
      VariantName: VARIANT,
      Specification: {
        ModelName: names.modelName,
        ComputeResourceRequirements: {
          NumberOfAcceleratorDevicesRequired: cfg.acceleratorDevices ?? 1,
          ...(cfg.minMemoryMb ? { MinMemoryRequiredInMb: cfg.minMemoryMb } : {}),
        },
        StartupParameters: {
          ModelDataDownloadTimeoutInSeconds: cfg.modelDataDownloadTimeoutSeconds ?? 1800,
          ContainerStartupHealthCheckTimeoutInSeconds: cfg.containerStartupHealthCheckTimeoutSeconds ?? 1800,
        },
      },
      RuntimeConfig: { CopyCount: copies },
      Tags: tags,
    };

    const created: string[] = [];
    try {
      await this.op('CreateModel', region, model, credentials);
      created.push('model');
      await this.op('CreateEndpointConfig', region, endpointConfig, credentials);
      created.push('config');
      const res = await this.op('CreateEndpoint', region, { EndpointName: names.endpointName, EndpointConfigName: names.endpointConfigName, Tags: tags }, credentials);
      created.push('endpoint');
      await this.op('CreateInferenceComponent', region, inferenceComponent, credentials);
      return {
        ...names,
        endpointArn: res?.EndpointArn,
        region,
        instanceType,
        url: SageMakerAdapter.invokeUrl(region, names.endpointName),
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
        copyCount: copies,
        minInstances,
        maxInstances,
      };
    } catch (err) {
      // Leave nothing half-made: a failed later step removes the earlier resources.
      if (created.includes('endpoint')) await this.op('DeleteEndpoint', region, { EndpointName: names.endpointName }, credentials).catch(() => undefined);
      if (created.includes('config')) await this.op('DeleteEndpointConfig', region, { EndpointConfigName: names.endpointConfigName }, credentials).catch(() => undefined);
      if (created.includes('model')) await this.op('DeleteModel', region, { ModelName: names.modelName }, credentials).catch(() => undefined);
      classifyAwsError(err, 'create endpoint failed');
    }
  }

  private notFound(err: any, fallback: string): boolean {
    try {
      classifyAwsError(err, fallback);
    } catch (typed: any) {
      if (typed.code === 'ADAPTER_NOT_FOUND') return true;
      throw typed;
    }
    return false;
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let ep: any;
    try {
      ep = await this.op('DescribeEndpoint', ref.region, { EndpointName: ref.endpointName }, credentials);
    } catch (err: any) {
      if (this.notFound(err, 'describe endpoint failed')) return { state: 'missing', message: 'endpoint not found' };
    }
    const raw = String(ep?.EndpointStatus ?? 'Creating');
    const variant = (ep?.ProductionVariants ?? []).find((v: any) => v.VariantName === VARIANT) ?? ep?.ProductionVariants?.[0];
    const instances = typeof variant?.CurrentInstanceCount === 'number' ? variant.CurrentInstanceCount : undefined;
    let state = STATE_MAP[raw] ?? 'deploying';

    let ic: any;
    let icRaw: string | undefined;
    if (state === 'ready') {
      try {
        ic = await this.op('DescribeInferenceComponent', ref.region, { InferenceComponentName: ref.inferenceComponentName }, credentials);
      } catch (err: any) {
        // The endpoint is up but the component is gone: nothing serves.
        if (this.notFound(err, 'describe inference component failed')) return { state: 'stopped', url: ref.url, replicas: 0, hardware: variant?.InstanceType ?? ref.instanceType, region: ref.region, message: 'no inference component on the endpoint' };
      }
      icRaw = String(ic?.InferenceComponentStatus ?? 'Creating');
      state = IC_STATE_MAP[icRaw] ?? 'deploying';
    }
    const copies = typeof ic?.RuntimeConfig?.CurrentCopyCount === 'number' ? ic.RuntimeConfig.CurrentCopyCount : undefined;
    if (state === 'ready' && (copies === 0 || instances === 0)) state = 'stopped';

    return {
      state,
      url: ref.url,
      replicas: copies ?? (state === 'stopped' ? 0 : undefined),
      hardware: variant?.InstanceType ?? ref.instanceType,
      region: ref.region,
      message: ic?.FailureReason ?? ep?.FailureReason,
      details: {
        rawState: raw,
        inferenceComponentState: icRaw,
        inferenceComponentName: ref.inferenceComponentName,
        // InvokeEndpoint must name the component it is addressing.
        invokeHeader: 'X-Amzn-SageMaker-Inference-Component',
        desiredCopyCount: ic?.RuntimeConfig?.DesiredCopyCount,
        currentInstanceCount: instances,
        desiredInstanceCount: variant?.DesiredInstanceCount,
        endpointConfigName: ep?.EndpointConfigName,
      },
    };
  }

  /**
   * Copy count is the scaling knob on an inference component, and zero is
   * legal: the variant's ManagedInstanceScaling (MinInstanceCount 0) then
   * drains the instances. Automatic scale-out from zero additionally
   * needs an Application Auto Scaling policy and a CloudWatch alarm on
   * NoCapacityInvocationFailures, which the adapter does not create.
   */
  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.op('UpdateInferenceComponentRuntimeConfig', ref.region, {
        InferenceComponentName: ref.inferenceComponentName,
        DesiredRuntimeConfig: { CopyCount: replicas },
      }, credentials);
      ref.copyCount = replicas;
    } catch (err) {
      classifyAwsError(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const steps: Array<[string, Record<string, any>]> = [
      ['DeleteInferenceComponent', { InferenceComponentName: ref.inferenceComponentName }],
      ['DeleteEndpoint', { EndpointName: ref.endpointName }],
      ['DeleteEndpointConfig', { EndpointConfigName: ref.endpointConfigName }],
      ['DeleteModel', { ModelName: ref.modelName }],
    ];
    for (const [operation, body] of steps) {
      try {
        await this.op(operation, ref.region, body, credentials);
      } catch (err: any) {
        if (!this.notFound(err, `${operation} failed`)) throw err;
      }
    }
  }

  /** No per-endpoint billing API: instance rate times observed instances and time. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    const instances = Number(actual.details?.currentInstanceCount ?? 0);
    const running = actual.state === 'ready' || actual.state === 'scaling' ? Math.max(1, instances) : 0;
    return {
      spentCents: Math.round(rate * hours * Math.max(1, Number(ref.minInstances ?? 0) || 1)),
      ratePerHourCents: rate * running,
      observedAt: new Date(),
    };
  }
}
