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
 * Amazon Bedrock, in the customer's own AWS account.
 *
 * almyty does not host inference; Bedrock does. This adapter drives the
 * two paths AWS documents, and picks between them from the version's
 * registry URI:
 *
 *   bedrock://<model id or ARN>  a model from Bedrock's own catalog. The
 *     deployment is an application inference profile
 *     (POST /inference-profiles) whose tags carry the almyty deployment,
 *     so AWS attributes the spend. Inference is serverless and on demand
 *     at the OpenAI-compatible surface
 *     https://bedrock-runtime.{region}.amazonaws.com/openai/v1.
 *
 *   s3://...                     the customer's own weights. Bedrock
 *     Custom Model Import reads Hugging Face format weights straight out
 *     of Amazon S3 through `roleArn` (POST /model-import-jobs); S3 is the
 *     only source the API accepts, and it is AWS's own documented path,
 *     not a workaround. Inference is
 *     POST /model/{importedModelArn}/invoke on the runtime host.
 *
 * Anything else is refused with a typed error naming what Bedrock reads.
 * Control plane REST at https://bedrock.{region}.amazonaws.com, SigV4
 * service "bedrock". Verified API facts and deltas:
 * docs/design/adapters/aws-bedrock-import.md.
 */
const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-2', 'ap-northeast-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
  'ca-central-1', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'sa-east-1',
];

/** Custom Model Import is offered in four regions only. */
const IMPORT_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-central-1'];

/** Families Custom Model Import accepts, as prefixes of the version's `base`. */
const ARCHITECTURES = ['mistral', 'mixtral', 'flan', 'llama', 'mllama', 'gpt_bigcode', 'gptbigcode', 'qwen2', 'qwen3', 'gpt-oss', 'gpt_oss'];

const JOB_STATE: Record<string, ActualState['state']> = { InProgress: 'deploying', Completed: 'ready', Failed: 'failed' };

const ACCEPTED_SOURCES = "a Bedrock catalog model (bedrock://<model id or ARN>) or Hugging Face format weights in Amazon S3 (s3://) for Custom Model Import";

export class AwsBedrockImportAdapter implements ModelProviderAdapter {
  readonly key = 'aws-bedrock-import';
  readonly displayName = 'AWS Bedrock';

  constructor(private readonly http: AwsHttp = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: true,
      dedicated: false,
      scaleToZero: true,
      regions: REGIONS,
      // Bedrock reads model artifacts from Amazon S3 by design; it cannot
      // read a Hugging Face repository, and a catalog model needs no
      // source at all because AWS already holds the weights.
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
        roleArn: { type: 'string', title: 'Import service role ARN', description: 'Custom Model Import only: the IAM role Bedrock assumes to read the weights bucket' },
        kmsKeyId: { type: 'string', title: 'KMS key for the imported model', description: 'Custom Model Import only; AWS-managed key otherwise' },
        vpcSubnetIds: { type: 'array', items: { type: 'string' }, title: 'VPC subnet ids', description: 'Custom Model Import only: run the import job inside a VPC' },
        vpcSecurityGroupIds: { type: 'array', items: { type: 'string' }, title: 'VPC security group ids' },
        hourlyRateCents: { type: 'integer', title: 'Price per running model copy per hour (cents)', description: 'Custom Model Import only: CMUs per copy times the per-CMU rate from the Bedrock pricing page; used to estimate spend until CloudWatch ModelCopy is wired' },
        inPerMTok: { type: 'number', title: 'Catalog input price (USD per million tokens)', description: 'Catalog models bill per token; from the Bedrock pricing page' },
        outPerMTok: { type: 'number', title: 'Catalog output price (USD per million tokens)' },
      },
      required: ['accessKeyId', 'secretAccessKey', 'region'],
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

  /** The OpenAI-compatible base AWS recommends for new applications. */
  static openAiBase(region: string): string {
    return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
  }

  /** Which of the two Bedrock paths this version asks for. */
  static route(registryUri: string): 'catalog' | 'import' {
    if (registryUri.startsWith('bedrock://')) return 'catalog';
    if (registryUri.startsWith('s3://')) return 'import';
    throw new UnsupportedOperationError('aws-bedrock-import', `a ${registryUri.split(':')[0]}:// version. Bedrock reads ${ACCEPTED_SOURCES}`);
  }

  /** The import source is the registry prefix itself; the @pin is the version's, not S3's. */
  static s3Uri(registryUri: string): string {
    return registryUri.replace(/@[^@/]+$/, '');
  }

  /**
   * `modelSource.copyFrom` wants an ARN. A bare model id becomes the
   * region's foundation-model ARN (no account id in that ARN, per the
   * CreateInferenceProfile examples); a cross-region system-defined
   * profile has to be given as a full ARN because its account id is the
   * customer's and this adapter never guesses it.
   */
  static copyFrom(registryUri: string, region: string): string {
    const id = registryUri.slice('bedrock://'.length).replace(/@[^@/]+$/, '');
    if (!id) throw new UnsupportedOperationError('aws-bedrock-import', 'a bedrock:// version with no model id');
    if (id.startsWith('arn:')) return id;
    if (/^[a-z]{2}\./.test(id)) {
      throw new UnsupportedOperationError(
        'aws-bedrock-import',
        `the cross-region profile id "${id}". Give the full inference profile ARN (bedrock://arn:aws:bedrock:${region}:<account>:inference-profile/${id}), because its account id cannot be inferred`,
      );
    }
    return `arn:aws:bedrock:${region}::foundation-model/${id}`;
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    this.creds(credentials);
    const route = AwsBedrockImportAdapter.route(request.version.registryUri);
    const cfg = request.providerConfig;
    const region = request.desired.region ?? cfg.region ?? 'us-east-1';
    return route === 'catalog'
      ? this.deployCatalog(request, credentials, region)
      : this.deployImport(request, credentials, region);
  }

  /** A listed model: an application inference profile, tagged so AWS attributes the spend. */
  private async deployCatalog(request: DeployRequest, credentials: AdapterCredentials, region: string): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const copyFrom = AwsBedrockImportAdapter.copyFrom(request.version.registryUri, region);
    const inferenceProfileName = AwsBedrockImportAdapter.modelName(request.deploymentId);
    const body = {
      inferenceProfileName,
      description: `almyty deployment ${request.deploymentId}`,
      modelSource: { copyFrom },
      clientRequestToken: randomUUID(),
      tags: [
        { key: 'almyty:deployment', value: request.deploymentId },
        { key: 'almyty:organization', value: request.organizationId },
      ],
    };
    try {
      const res = await this.call('POST', region, '/inference-profiles', credentials, body);
      return {
        route: 'catalog',
        inferenceProfileName,
        inferenceProfileArn: res?.inferenceProfileArn,
        modelId: copyFrom,
        region,
        createdAt: new Date().toISOString(),
        url: `${AwsBedrockImportAdapter.openAiBase(region)}/chat/completions`,
        inPerMTok: cfg.inPerMTok,
        outPerMTok: cfg.outPerMTok,
      };
    } catch (err) {
      classifyAwsError(err, 'create inference profile failed');
    }
  }

  /** The customer's own weights: one import job reading their S3 prefix. */
  private async deployImport(request: DeployRequest, credentials: AdapterCredentials, region: string): Promise<EndpointRef> {
    if (!ARCHITECTURES.some((a) => request.version.base.toLowerCase().startsWith(a))) {
      throw Object.assign(new Error(`Bedrock custom model import does not accept the ${request.version.base} architecture`), { code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE' });
    }
    if (!IMPORT_REGIONS.includes(region)) {
      throw Object.assign(new Error(`Bedrock custom model import is only offered in ${IMPORT_REGIONS.join(', ')}, not ${region}`), { code: 'ADAPTER_UNSUPPORTED_REGION' });
    }
    const cfg = request.providerConfig;
    if (!cfg.roleArn) {
      throw Object.assign(new Error('Bedrock custom model import needs roleArn: the IAM role Bedrock assumes to read the weights bucket'), { code: 'ADAPTER_CONFIG_INVALID' });
    }
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
      return { route: 'import', jobName, jobArn: res?.jobArn, importedModelName, region, createdAt: new Date().toISOString(), hourlyRateCents: cfg.hourlyRateCents ?? 0, maxCopies: request.desired.replicas ?? 1 };
    } catch (err) {
      classifyAwsError(err, 'create model import job failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    return ref.route === 'catalog' ? this.readCatalog(ref, credentials) : this.readImport(ref, credentials);
  }

  private async readCatalog(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let profile: any;
    try {
      profile = await this.call('GET', ref.region, `/inference-profiles/${encodeURIComponent(ref.inferenceProfileArn ?? ref.inferenceProfileName)}`, credentials);
    } catch (err: any) {
      return this.missingOrThrow(err, 'inference profile deleted', 'read inference profile failed');
    }
    const status = String(profile?.status ?? 'ACTIVE');
    const url = `${AwsBedrockImportAdapter.openAiBase(ref.region)}/chat/completions`;
    return {
      state: status === 'ACTIVE' ? 'ready' : 'deploying',
      url,
      openAiBase: AwsBedrockImportAdapter.openAiBase(ref.region),
      // On-demand: AWS runs however many copies it needs and bills tokens.
      replicas: 1,
      region: ref.region,
      details: {
        route: 'catalog',
        rawState: status,
        inferenceProfileArn: profile?.inferenceProfileArn ?? ref.inferenceProfileArn,
        inferenceProfileId: profile?.inferenceProfileId,
        profileType: profile?.type,
        // What to put in the OpenAI request's `model` field.
        modelId: profile?.inferenceProfileId ?? profile?.inferenceProfileArn ?? ref.inferenceProfileArn,
        modelArns: (profile?.models ?? []).map((m: any) => m.modelArn),
      },
    };
  }

  private async readImport(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let job: any;
    try {
      job = await this.call('GET', ref.region, `/model-import-jobs/${encodeURIComponent(ref.jobName)}`, credentials);
    } catch (err: any) {
      return this.missingOrThrow(err, 'import job not found', 'read import job failed');
    }
    const raw = String(job?.status ?? 'InProgress');
    if (raw !== 'Completed') {
      return { state: JOB_STATE[raw] ?? 'deploying', region: ref.region, message: job?.failureMessage, details: { route: 'import', rawState: raw, jobArn: job?.jobArn } };
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
      route: 'import',
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
   * Both paths are serverless: Bedrock decides how much capacity to run
   * and bills nothing while idle, so there is nothing to send to AWS. A
   * catalog profile has no notion of standby at all; for an imported
   * model zero records the operator's standby wish, which the read
   * reports as stopped.
   */
  async scale(ref: EndpointRef, replicas: number, _credentials: AdapterCredentials): Promise<void> {
    if (ref.route === 'catalog') return;
    ref.maxCopies = replicas;
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const path = ref.route === 'catalog'
      ? `/inference-profiles/${encodeURIComponent(ref.inferenceProfileArn ?? ref.inferenceProfileName)}`
      : `/imported-models/${encodeURIComponent(ref.importedModelName)}`;
    try {
      await this.call('DELETE', ref.region, path, credentials);
    } catch (err: any) {
      try {
        classifyAwsError(err, ref.route === 'catalog' ? 'delete inference profile failed' : 'delete imported model failed');
      } catch (typed: any) {
        if (typed.code === 'ADAPTER_NOT_FOUND') return;
        throw typed;
      }
    }
  }

  /**
   * No billing API per model. A catalog model bills per token, so the
   * hourly rate is zero and the per-token prices the operator entered are
   * reported as-is. An imported model is the configured per-copy rate
   * over the time since import, an upper bound because Bedrock only bills
   * 5-minute windows in which a copy actually served inference.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    if (ref.route === 'catalog') {
      const inPerMTok = Number(ref.inPerMTok ?? 0);
      const outPerMTok = Number(ref.outPerMTok ?? 0);
      return {
        spentCents: 0,
        ratePerHourCents: 0,
        ...(inPerMTok || outPerMTok ? { perToken: { inPerMTok, outPerMTok, currency: 'USD' } } : {}),
        observedAt: new Date(),
      };
    }
    const rate = Number(ref.hourlyRateCents ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return {
      spentCents: Math.round(rate * hours),
      ratePerHourCents: actual.state === 'ready' ? rate * Math.max(1, actual.replicas ?? 1) : 0,
      observedAt: new Date(),
    };
  }
}
