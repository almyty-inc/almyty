import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';

import { ModelDeployment, ModelDeploymentDesired, ModelDeploymentState } from '../../entities/model-deployment.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { Credential } from '../../entities/credential.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { AdapterRegistry } from './adapters/adapter.registry';
import { ModelSource, canRun, readModelSource, schemesFor } from './model-source';
import { AdapterCredentials } from './adapters/adapter.interface';
import { ModelRegistryService } from '../model-registry/model-registry.service';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';

export const MODEL_RECONCILE_QUEUE = 'model-reconcile';
export const MODEL_RECONCILE_JOB = 'reconcile';

export interface CreateDeploymentDto {
  /**
   * The model to run, as configuration: hf://org/repo@sha for a Hugging
   * Face repository, bedrock:// fireworks:// together:// and the rest for
   * a model that already lives on that platform, s3:// or gs:// for
   * artifacts a provider reads itself. Either this or modelVersionId.
   */
  model?: string;
  /** Architecture family, when the adapter checks it and the reference does not carry one. */
  base?: string;
  /** A registered version instead, for operators who track their own artifacts. */
  modelVersionId?: string;
  providerType: string;
  desired?: ModelDeploymentDesired;
  providerConfig?: Record<string, any>;
  /** Credential in the vault whose decrypted config is handed to the adapter. */
  credentialId?: string | null;
  budgetId?: string | null;
  modelId?: string | null;
}

/**
 * Desired state for deployments. Controllers write here; the adapter is
 * only ever driven by the reconcile processor, so every provider
 * mutation goes through one queue and one audit trail.
 */
@Injectable()
export class ModelDeploymentsService {
  private readonly logger = new Logger(ModelDeploymentsService.name);

  constructor(
    @InjectRepository(ModelDeployment) private readonly deployments: Repository<ModelDeployment>,
    @InjectRepository(ModelVersion) private readonly versions: Repository<ModelVersion>,
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    @InjectQueue(MODEL_RECONCILE_QUEUE) private readonly queue: Queue,
    private readonly adapters: AdapterRegistry,
    private readonly envelopeCrypto: EnvelopeCryptoService,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() private readonly registry?: ModelRegistryService,
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
  ) {}

  async list(organizationId: string): Promise<ModelDeployment[]> {
    return this.deployments.find({ where: { organizationId }, order: { createdAt: 'DESC' } });
  }

  async get(organizationId: string, id: string): Promise<ModelDeployment> {
    const d = await this.deployments.findOne({ where: { id, organizationId } });
    if (!d) throw new NotFoundException('Deployment not found');
    return d;
  }

  /** Validate against the adapter's capabilities and schema, persist desired state, enqueue a reconcile. */
  async create(organizationId: string, userId: string | null, dto: CreateDeploymentDto): Promise<ModelDeployment> {
    const adapter = this.adapters.get(dto.providerType);
    if (!adapter) throw new BadRequestException({ code: 'ADAPTER_UNKNOWN', message: `Unknown deployment adapter: ${dto.providerType}` });
    // A registered version is optional. Naming the model is configuration.
    const version = dto.modelVersionId
      ? await this.versions.findOne({ where: { id: dto.modelVersionId, organizationId } })
      : null;
    if (dto.modelVersionId && !version) throw new NotFoundException('Model version not found');
    const reference = version?.registryUri ?? dto.model;
    if (!reference) {
      throw new BadRequestException({ code: 'MODEL_REQUIRED', message: 'Name the model to run with `model`, or point at a registered version with `modelVersionId`' });
    }

    const caps = adapter.capabilities();
    let source: ModelSource;
    try {
      source = readModelSource(reference);
    } catch (err: any) {
      throw new BadRequestException({ code: err?.code ?? 'REGISTRY_URI_INVALID', message: err?.message ?? String(err) });
    }
    // Where the model lives decides who can run it, and that is settled
    // here rather than by a provider error mid-deployment.
    const runnable = canRun(adapter.key, caps, source);
    if (runnable.ok === false) {
      throw new BadRequestException({
        code: 'ADAPTER_UNSUPPORTED_SOURCE',
        message: `${adapter.displayName} cannot run ${reference}: ${runnable.reason}`,
        accepts: schemesFor(adapter.key, caps).map((s) => `${s}://`),
      });
    }

    const base = version?.base ?? dto.base ?? null;
    if (caps.architectures !== 'any' && base && !caps.architectures.some((a) => base.startsWith(a))) {
      // Refused at submit, not at provider error: this is what the pre-submit warning is for.
      throw new BadRequestException({
        code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE',
        message: `${adapter.displayName} cannot serve ${base}; it supports ${caps.architectures.join(', ')}`,
      });
    }
    const desired = dto.desired ?? {};
    if (desired.region && caps.regions.length > 0 && !caps.regions.includes(desired.region)) {
      throw new BadRequestException({ code: 'ADAPTER_REGION_UNAVAILABLE', message: `${adapter.displayName} is not available in ${desired.region}` });
    }
    // A connection satisfies the schema's secret fields; they are then
    // refused inline (below) so the secret lives in one place.
    const schema = dto.credentialId ? schemaWithoutSecretRequirements(adapter.configSchema()) : adapter.configSchema();
    const problems = validateAgainstSchema(dto.providerConfig ?? {}, schema);
    if (problems.length) throw new BadRequestException({ code: 'PROVIDER_CONFIG_INVALID', message: problems.join('; ') });
    // One place for the secret: a deployment that names a connection may
    // not also paste one. The form creates the connection first.
    if (dto.credentialId) {
      const inline = inlineSecretKeys(dto.providerConfig ?? {}, adapter.configSchema());
      if (inline.length) {
        throw new BadRequestException({
          code: 'PROVIDER_CONFIG_INLINE_SECRET',
          message: `providerConfig carries a secret (${inline.join(', ')}) while credentialId is set; put the secret on the connection`,
        });
      }
    }

    const deployment = this.deployments.create({
      organizationId,
      modelVersionId: version?.id ?? null,
      modelRef: version ? null : source.raw,
      modelBase: version ? null : base,
      modelId: dto.modelId ?? null,
      providerType: adapter.key,
      desired: { replicas: 1, minScale: caps.scaleToZero ? 0 : 1, maxScale: 1, ...desired },
      providerConfig: { ...(dto.providerConfig ?? {}), ...(dto.credentialId ? { credentialId: dto.credentialId } : {}) },
      externalRef: null,
      actual: null,
      state: 'pending',
      budgetId: dto.budgetId ?? null,
      createdBy: userId,
    });
    await deployment.encryptSensitiveDataForOrg(this.envelopeCrypto);
    const saved = await this.deployments.save(deployment);
    this.audit(saved, AuditAction.MODEL_DEPLOYMENT_TRANSITION, userId, { from: null, to: 'pending' });
    await this.enqueue(saved.id);
    return saved;
  }

  async scale(organizationId: string, id: string, replicas: number, userId: string | null): Promise<ModelDeployment> {
    const d = await this.get(organizationId, id);
    if (!Number.isInteger(replicas) || replicas < 0) throw new BadRequestException('replicas must be a non-negative integer');
    d.desired = { ...d.desired, replicas };
    const saved = await this.deployments.save(d);
    this.audit(saved, AuditAction.MODEL_DEPLOYMENT_TRANSITION, userId, { desiredReplicas: replicas });
    await this.enqueue(saved.id);
    return saved;
  }

  /** Mark for teardown; the endpoint goes when reconcile runs. Weights are never touched. */
  async teardown(organizationId: string, id: string, userId: string | null): Promise<ModelDeployment> {
    const d = await this.get(organizationId, id);
    if (d.state !== 'tearing_down') {
      const from = d.state;
      d.state = 'tearing_down';
      // The intent outlives the state: a teardown that fails a tick must
      // be retried, not forgotten because the row moved to degraded.
      d.desired = { ...d.desired, teardownRequested: true } as ModelDeployment['desired'];
      await this.deployments.save(d);
      this.audit(d, AuditAction.MODEL_DEPLOYMENT_TRANSITION, userId, { from, to: 'tearing_down' });
    }
    await this.enqueue(d.id);
    return d;
  }

  /** Credentials for the adapter: the vault entry named in providerConfig, else the config's own secrets. */
  /**
   * Everything an adapter may need for one call: the deployment's own
   * credential (vault reference first, inline secrets second) plus the
   * organization's registry keys when the version lives in its bucket.
   * Registry keys never come from the environment or from providerConfig.
   */
  async credentialsFor(deployment: ModelDeployment): Promise<AdapterCredentials> {
    await this.envelopeCrypto.warmOrg(deployment.organizationId);
    const config = deployment.getDecryptedProviderConfig();
    let creds: AdapterCredentials = {};
    if (config.credentialId) {
      if (this.credentialRefs) {
        // Through the store: inactive, expired or ungranted rows refuse here.
        // The deployment's creator is the acting user for a background
        // reconcile, so a personal connection is checked against their
        // grants rather than silently allowed.
        const resolved = await this.credentialRefs.resolve(deployment.organizationId, config.credentialId, {
          principal: deployment.createdBy ? { id: deployment.createdBy } : undefined,
          context: { purpose: 'deploy', resourceType: 'model_deployment', resourceId: deployment.id },
        });
        creds = { ...(resolved.config as Record<string, string>) };
      } else {
        const credential = await this.credentials.findOne({ where: { id: config.credentialId, organizationId: deployment.organizationId } });
        if (!credential) throw Object.assign(new Error('deployment credential not found'), { code: 'ADAPTER_AUTH' });
        creds = { ...(credential.getDecryptedConfig() as Record<string, string>) };
      }
    }
    for (const [k, v] of Object.entries(config)) {
      if (k !== 'credentialId' && ModelDeployment.isSecretKey(k) && typeof v === 'string' && !/^registry/i.test(k)) creds[k] = v;
    }
    if (this.registry) {
      const version = deployment.modelVersionId ? await this.versions.findOne({ where: { id: deployment.modelVersionId } }) : null;
      if (version?.registryUri?.startsWith('s3://')) {
        creds = { ...creds, ...(await this.registry.adapterCredentialsFor(deployment.organizationId)) };
      }
    }
    return creds;
  }

  async enqueue(deploymentId: string): Promise<void> {
    try {
      await this.queue.add(MODEL_RECONCILE_JOB, { deploymentId }, { jobId: `reconcile-${deploymentId}-${Date.now()}`, removeOnComplete: true, removeOnFail: 50 });
    } catch (err: any) {
      // The repeatable sweep will pick it up; a queue hiccup must not fail the request.
      this.logger.warn(`Could not enqueue reconcile for ${deploymentId}: ${err.message}`);
    }
  }

  audit(d: ModelDeployment, action: AuditAction, userId: string | null | undefined, details: Record<string, any>): void {
    void this.auditLog
      ?.log({
        organizationId: d.organizationId,
        userId: userId ?? undefined,
        action,
        resourceType: AuditResource.MODEL_DEPLOYMENT,
        resourceId: d.id,
        resourceName: `${d.providerType}:${d.modelVersionId}`,
        details: { state: d.state, providerType: d.providerType, ...details },
      })
      .catch(() => undefined);
  }
}

/** Enough of JSON schema to refuse a bad providerConfig at submit: required keys, types, enums. */
export function validateAgainstSchema(config: Record<string, any>, schema: Record<string, any>): string[] {
  const problems: string[] = [];
  const props: Record<string, any> = schema?.properties ?? {};
  for (const key of schema?.required ?? []) {
    if (config[key] === undefined || config[key] === null || config[key] === '') problems.push(`${key} is required`);
  }
  for (const [key, value] of Object.entries(config)) {
    const def = props[key];
    if (!def) continue;
    if (def.type === 'string' && typeof value !== 'string') problems.push(`${key} must be a string`);
    if ((def.type === 'number' || def.type === 'integer') && typeof value !== 'number') problems.push(`${key} must be a number`);
    if (def.type === 'boolean' && typeof value !== 'boolean') problems.push(`${key} must be true or false`);
    if (Array.isArray(def.enum) && !def.enum.includes(value)) problems.push(`${key} must be one of ${def.enum.join(', ')}`);
  }
  return problems;
}

/** The adapter schema with its `x-secret` fields no longer required: a credentialId supplies them. */
export function schemaWithoutSecretRequirements(schema: Record<string, any>): Record<string, any> {
  const props: Record<string, any> = schema?.properties ?? {};
  const required = (schema?.required ?? []).filter((key: string) => props[key]?.['x-secret'] !== true);
  return { ...schema, required };
}

/** providerConfig keys that hold a pasted secret: marked `x-secret` in the adapter schema, or secret-looking by name. */
export function inlineSecretKeys(config: Record<string, any>, schema: Record<string, any>): string[] {
  const props: Record<string, any> = schema?.properties ?? {};
  return Object.entries(config)
    .filter(([key, value]) => key !== 'credentialId' && typeof value === 'string' && value.length > 0)
    .filter(([key]) => props[key]?.['x-secret'] === true || ModelDeployment.isSecretKey(key))
    .map(([key]) => key);
}

export type { ModelDeploymentState };
