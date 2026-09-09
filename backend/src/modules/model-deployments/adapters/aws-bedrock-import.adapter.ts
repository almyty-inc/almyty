import axios from 'axios';
import { randomUUID } from 'crypto';

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
 * Amazon Bedrock Custom Model Import: the customer's own AWS account,
 * serverless, on-demand.
 *
 * Control plane REST at https://bedrock.{region}.amazonaws.com, SigV4
 * service "bedrock". A deployment is one import job
 * (POST /model-import-jobs) whose S3 source is the registry version
 * itself, so there is no upload step; Bedrock reads the safetensors +
 * config.json + tokenizer files through `roleArn`. The imported model ARN
 * is the endpoint: inference goes to bedrock-runtime
 * POST /model/{arn}/invoke on demand. Bedrock runs and bills model copies
 * itself (5-minute windows from the first inference, zero when idle), so
 * scaling is implicit: `scale(0)` only marks the handle as standby.
 * Teardown is DELETE /imported-models/{name}. Deltas and verified facts:
 * docs/design/adapters/aws-bedrock-import.md.
 */
const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-central-1'];

/** Families Bedrock accepts, as prefixes of the version's `base`. */
const ARCHITECTURES = ['mistral', 'mixtral', 'flan', 'llama', 'mllama', 'gpt_bigcode', 'gptbigcode', 'qwen2', 'qwen3', 'gpt-oss', 'gpt_oss'];

const JOB_STATE: Record<string, ActualState['state']> = { InProgress: 'deploying', Completed: 'ready', Failed: 'failed' };

export class AwsBedrockImportAdapter implements ModelProviderAdapter {
  readonly key = 'aws-bedrock-import';
  readonly displayName = 'AWS Bedrock (custom model import)';

  constructor(private readonly http: AwsHttp = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: ARCHITECTURES,
      lora: 'merged',
      serverless: true,
      dedicated: false,
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
        roleArn: { type: 'string', title: 'Import service role ARN', description: 'IAM role Bedrock assumes to read the registry bucket' },
        kmsKeyId: { type: 'string', title: 'KMS key for the imported model', description: 'Optional; AWS-managed key otherwise' },
        vpcSubnetIds: { type: 'array', items: { type: 'string' }, title: 'VPC subnet ids', description: 'Optional; run the import job inside a VPC' },
        vpcSecurityGroupIds: { type: 'array', items: { type: 'string' }, title: 'VPC security group ids' },
        hourlyRateCents: { type: 'integer', title: 'Price per running model copy per hour (cents)', description: 'CMUs per copy times the per-CMU rate from the Bedrock pricing page; used to estimate spend until CloudWatch ModelCopy is wired' },
      },
      required: ['accessKeyId', 'secretAccessKey', 'region', 'roleArn'],
    };
  }

  private creds(credentials: AdapterCredentials) {
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      throw Object.assign(new Error('missing AWS access key'), { code: 'ADAPTER_AUTH', status: 401 });
    }
    return { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken };
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', region: string, path: string, credentials: AdapterCredentials, body?: any): Promise<any> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const signed = signAwsRequest({
      method,
      url: `https://bedrock.${region}.amazonaws.com${path}`,
      service: 'bedrock',
      region,
      headers: data ? { 'content-type': 'application/json' } : {},
      body: data,
      credentials: this.creds(credentials),
    });
    const res = await this.http.request({ method, url: signed.url, headers: signed.headers, data });
    return res.data;
  }

  static modelName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 40)}`;
  }

  static invokeUrl(region: string, modelArn: string): string {
    return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelArn)}/invoke`;
  }

  /** The import source is the registry prefix itself; the @pin is the version's, not S3's. */
  static s3Uri(registryUri: string): string {
    if (!registryUri.startsWith('s3://')) throw new UnsupportedOperationError('aws-bedrock-import', `importing from ${registryUri.split(':')[0]}:// (only the S3 registry source)`);
    return registryUri.replace(/@[^@/]+$/, '');
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    this.creds(credentials);
    if (!ARCHITECTURES.some((a) => request.version.base.toLowerCase().startsWith(a))) {
      throw Object.assign(new Error(`Bedrock custom model import does not accept the ${request.version.base} architecture`), { code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE' });
    }
    const cfg = request.providerConfig;
    const region = request.desired.region ?? cfg.region ?? 'us-east-1';
    const importedModelName = AwsBedrockImportAdapter.modelName(request.deploymentId);
    const jobName = `${importedModelName}-${Date.now().toString(36)}`;
    const body = {
      jobName,
      importedModelName,
      roleArn: cfg.roleArn,
      modelDataSource: { s3DataSource: { s3Uri: AwsBedrockImportAdapter.s3Uri(request.version.registryUri) } },
      clientRequestToken: randomUUID(),
      ...(cfg.kmsKeyId ? { importedModelKmsKeyId: cfg.kmsKeyId } : {}),
      ...(cfg.vpcSubnetIds?.length ? { vpcConfig: { subnetIds: cfg.vpcSubnetIds, securityGroupIds: cfg.vpcSecurityGroupIds ?? [] } } : {}),
      importedModelTags: [
        { key: 'almyty:deployment', value: request.deploymentId },
        { key: 'almyty:organization', value: request.organizationId },
      ],
    };
    try {
      const res = await this.call('POST', region, '/model-import-jobs', credentials, body);
      return { jobName, jobArn: res?.jobArn, importedModelName, region, createdAt: new Date().toISOString(), hourlyRateCents: cfg.hourlyRateCents ?? 0, maxCopies: request.desired.replicas ?? 1 };
    } catch (err) {
      classifyAwsError(err, 'create model import job failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let job: any;
    try {
      job = await this.call('GET', ref.region, `/model-import-jobs/${encodeURIComponent(ref.jobName)}`, credentials);
    } catch (err: any) {
      return this.missingOrThrow(err, 'import job not found', 'read import job failed');
    }
    const raw = String(job?.status ?? 'InProgress');
    if (raw !== 'Completed') {
      return { state: JOB_STATE[raw] ?? 'deploying', region: ref.region, message: job?.failureMessage, details: { rawState: raw, jobArn: job?.jobArn } };
    }

    let model: any;
    try {
      model = await this.call('GET', ref.region, `/imported-models/${encodeURIComponent(ref.importedModelName)}`, credentials);
    } catch (err: any) {
      return this.missingOrThrow(err, 'imported model deleted', 'read imported model failed');
    }
    const modelArn = model?.modelArn ?? job?.importedModelArn;
    if (modelArn && !ref.importedModelArn) ref.importedModelArn = modelArn;
    const url = modelArn ? AwsBedrockImportAdapter.invokeUrl(ref.region, modelArn) : undefined;
    const details = {
      rawState: raw,
      modelArn,
      modelArchitecture: model?.modelArchitecture,
      instructSupported: model?.instructSupported,
      customModelUnitsPerCopy: model?.customModelUnits?.customModelUnitsPerModelCopy,
      customModelUnitsVersion: model?.customModelUnits?.customModelUnitsVersion,
    };
    if (Number(ref.maxCopies ?? 1) === 0) {
      return { state: 'stopped', url, replicas: 0, region: ref.region, details: { ...details, note: 'standby: on-demand model, no copies billed while idle' } };
    }
    return { state: 'ready', url, replicas: Number(ref.maxCopies ?? 1), region: ref.region, details };
  }

  private missingOrThrow(err: any, missingMessage: string, fallback: string): ActualState {
    try {
      classifyAwsError(err, fallback);
    } catch (typed: any) {
      if (typed.code === 'ADAPTER_NOT_FOUND') return { state: 'missing', message: missingMessage };
      throw typed;
    }
  }

  /**
   * Bedrock scales imported-model copies itself and bills nothing while
   * idle, so the only thing to record is the ceiling the operator wants:
   * zero means standby, which the read reports as stopped.
   */
  async scale(ref: EndpointRef, replicas: number, _credentials: AdapterCredentials): Promise<void> {
    ref.maxCopies = replicas;
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.call('DELETE', ref.region, `/imported-models/${encodeURIComponent(ref.importedModelName)}`, credentials);
    } catch (err: any) {
      try {
        classifyAwsError(err, 'delete imported model failed');
      } catch (typed: any) {
        if (typed.code === 'ADAPTER_NOT_FOUND') return;
        throw typed;
      }
    }
  }

  /**
   * No billing API per model: spend is the configured per-copy rate over
   * the time since import, an upper bound because Bedrock only bills
   * 5-minute windows in which a copy actually served inference.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return {
      spentCents: Math.round(rate * hours),
      ratePerHourCents: actual.state === 'ready' ? rate * Math.max(1, actual.replicas ?? 1) : 0,
      observedAt: new Date(),
    };
  }
}
