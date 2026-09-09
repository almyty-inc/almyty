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
 * Amazon SageMaker real-time endpoints: dedicated instances in the
 * customer's own AWS account.
 *
 * JSON 1.1 protocol at https://api.sagemaker.{region}.amazonaws.com
 * (POST /, X-Amz-Target: SageMaker.{Operation}), SigV4 service
 * "sagemaker". A deployment is three resources: CreateModel (the LMI/vLLM
 * deep learning container with the registry prefix as uncompressed
 * ModelDataSource), CreateEndpointConfig (one production variant with the
 * instance type and count) and CreateEndpoint. DescribeEndpoint drives the
 * state; UpdateEndpointWeightsAndCapacities scales the variant, including
 * to zero when managed instance scaling allows it; teardown deletes the
 * endpoint, the config and the model. SageMaker pulls the weights through
 * `executionRoleArn`, not through registry keys, so the registry bucket
 * must be readable by that role. Deltas: docs/design/adapters/sagemaker.md.
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

export class SageMakerAdapter implements ModelProviderAdapter {
  readonly key = 'sagemaker';
  readonly displayName = 'Amazon SageMaker (real-time endpoint)';

  constructor(private readonly http: AwsHttp = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: REGIONS,
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
        executionRoleArn: { type: 'string', title: 'Execution role ARN', description: 'Role SageMaker assumes to pull the image and read the registry bucket' },
        image: { type: 'string', title: 'Container image', description: `Defaults to the LMI vLLM DLC for the region (${DEFAULT_IMAGE_TAG})` },
        instanceType: { type: 'string', title: 'Instance type', default: 'ml.g5.xlarge' },
        volumeSizeGb: { type: 'integer', title: 'EBS volume (GB)', description: 'Only for instance types without local NVMe' },
        modelDataDownloadTimeoutSeconds: { type: 'integer', minimum: 60, default: 1800 },
        containerStartupHealthCheckTimeoutSeconds: { type: 'integer', minimum: 60, default: 1800 },
        environment: { type: 'object', additionalProperties: { type: 'string' }, title: 'Extra container environment', description: 'Merged over the LMI defaults' },
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
    return { endpointName: base, endpointConfigName: `${base}-cfg`, modelName: `${base}-model` };
  }

  static defaultImage(region: string): string {
    return `${DLC_ACCOUNT}.dkr.ecr.${region}.amazonaws.com/${DEFAULT_IMAGE_TAG}`;
  }

  static invokeUrl(region: string, endpointName: string): string {
    return `https://runtime.sagemaker.${region}.amazonaws.com/endpoints/${encodeURIComponent(endpointName)}/invocations`;
  }

  /** An uncompressed S3 prefix source must end with a slash. */
  static s3Prefix(registryUri: string): string {
    if (!registryUri.startsWith('s3://')) throw new UnsupportedOperationError('sagemaker', `deploying from ${registryUri.split(':')[0]}:// (only the S3 registry source)`);
    return `${registryUri.replace(/@[^@/]+$/, '').replace(/\/+$/, '')}/`;
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    this.creds(credentials);
    const cfg = request.providerConfig;
    const region = request.desired.region ?? cfg.region ?? 'us-east-1';
    const names = SageMakerAdapter.names(request.deploymentId);
    const instanceType = request.desired.hardware ?? cfg.instanceType ?? 'ml.g5.xlarge';
    const replicas = Math.max(1, request.desired.replicas ?? 1);
    const minScale = request.desired.minScale;
    const maxScale = Math.max(replicas, request.desired.maxScale ?? replicas);
    const tags = [
      { Key: 'almyty:deployment', Value: request.deploymentId },
      { Key: 'almyty:organization', Value: request.organizationId },
    ];
    const vpc = cfg.vpcSubnetIds?.length ? { VpcConfig: { Subnets: cfg.vpcSubnetIds, SecurityGroupIds: cfg.vpcSecurityGroupIds ?? [] } } : {};

    const model = {
      ModelName: names.modelName,
      ExecutionRoleArn: cfg.executionRoleArn,
      PrimaryContainer: {
        Image: cfg.image ?? SageMakerAdapter.defaultImage(region),
        ModelDataSource: { S3DataSource: { S3Uri: SageMakerAdapter.s3Prefix(request.version.registryUri), S3DataType: 'S3Prefix', CompressionType: 'None' } },
        Environment: {
          HF_MODEL_ID: '/opt/ml/model',
          OPTION_ROLLING_BATCH: 'vllm',
          ...(request.desired.quantization ? { OPTION_QUANTIZE: request.desired.quantization } : {}),
          ...(cfg.environment ?? {}),
        },
      },
      Tags: tags,
      ...vpc,
    };
    const endpointConfig = {
      EndpointConfigName: names.endpointConfigName,
      ProductionVariants: [
        {
          VariantName: VARIANT,
          ModelName: names.modelName,
          InstanceType: instanceType,
          InitialInstanceCount: replicas,
          InitialVariantWeight: 1,
          ModelDataDownloadTimeoutInSeconds: cfg.modelDataDownloadTimeoutSeconds ?? 1800,
          ContainerStartupHealthCheckTimeoutInSeconds: cfg.containerStartupHealthCheckTimeoutSeconds ?? 1800,
          ...(cfg.volumeSizeGb ? { VolumeSizeInGB: cfg.volumeSizeGb } : {}),
          ...(minScale !== undefined || maxScale > replicas
            ? {
                ManagedInstanceScaling: { Status: 'ENABLED', MinInstanceCount: minScale ?? replicas, MaxInstanceCount: maxScale },
                RoutingConfig: { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' },
              }
            : {}),
        },
      ],
      ...(cfg.kmsKeyId ? { KmsKeyId: cfg.kmsKeyId } : {}),
      Tags: tags,
    };

    const created: string[] = [];
    try {
      await this.op('CreateModel', region, model, credentials);
      created.push('model');
      await this.op('CreateEndpointConfig', region, endpointConfig, credentials);
      created.push('config');
      const res = await this.op('CreateEndpoint', region, { EndpointName: names.endpointName, EndpointConfigName: names.endpointConfigName, Tags: tags }, credentials);
      return {
        ...names,
        endpointArn: res?.EndpointArn,
        region,
        instanceType,
        url: SageMakerAdapter.invokeUrl(region, names.endpointName),
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
        initialInstanceCount: replicas,
      };
    } catch (err) {
      // Leave nothing half-made: a failed later step removes the earlier resources.
      if (created.includes('config')) await this.op('DeleteEndpointConfig', region, { EndpointConfigName: names.endpointConfigName }, credentials).catch(() => undefined);
      if (created.includes('model')) await this.op('DeleteModel', region, { ModelName: names.modelName }, credentials).catch(() => undefined);
      classifyAwsError(err, 'create endpoint failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let ep: any;
    try {
      ep = await this.op('DescribeEndpoint', ref.region, { EndpointName: ref.endpointName }, credentials);
    } catch (err: any) {
      try {
        classifyAwsError(err, 'describe endpoint failed');
      } catch (typed: any) {
        if (typed.code === 'ADAPTER_NOT_FOUND') return { state: 'missing', message: 'endpoint not found' };
        throw typed;
      }
    }
    const raw = String(ep?.EndpointStatus ?? 'Creating');
    const variant = (ep?.ProductionVariants ?? []).find((v: any) => v.VariantName === VARIANT) ?? ep?.ProductionVariants?.[0];
    const current = typeof variant?.CurrentInstanceCount === 'number' ? variant.CurrentInstanceCount : undefined;
    let state = STATE_MAP[raw] ?? 'deploying';
    if (state === 'ready' && current === 0) state = 'stopped';
    return {
      state,
      url: ref.url,
      replicas: current,
      hardware: variant?.InstanceType ?? ref.instanceType,
      region: ref.region,
      message: ep?.FailureReason,
      details: { rawState: raw, desiredInstanceCount: variant?.DesiredInstanceCount, endpointConfigName: ep?.EndpointConfigName },
    };
  }

  /** Zero instances is accepted only on a variant with managed instance scaling and MinInstanceCount 0. */
  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.op('UpdateEndpointWeightsAndCapacities', ref.region, {
        EndpointName: ref.endpointName,
        DesiredWeightsAndCapacities: [{ VariantName: VARIANT, DesiredInstanceCount: replicas }],
      }, credentials);
    } catch (err) {
      classifyAwsError(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const steps: Array<[string, Record<string, any>]> = [
      ['DeleteEndpoint', { EndpointName: ref.endpointName }],
      ['DeleteEndpointConfig', { EndpointConfigName: ref.endpointConfigName }],
      ['DeleteModel', { ModelName: ref.modelName }],
    ];
    for (const [operation, body] of steps) {
      try {
        await this.op(operation, ref.region, body, credentials);
      } catch (err: any) {
        try {
          classifyAwsError(err, `${operation} failed`);
        } catch (typed: any) {
          if (typed.code !== 'ADAPTER_NOT_FOUND') throw typed;
        }
      }
    }
  }

  /** No per-endpoint billing API: instance rate times observed instances and time. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    const running = actual.state === 'ready' || actual.state === 'scaling' ? actual.replicas ?? Number(ref.initialInstanceCount ?? 1) : 0;
    return {
      spentCents: Math.round(rate * hours * Number(ref.initialInstanceCount ?? 1)),
      ratePerHourCents: rate * running,
      observedAt: new Date(),
    };
  }
}
