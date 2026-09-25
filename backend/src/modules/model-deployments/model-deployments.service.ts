import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';

import { ModelDeployment, ModelDeploymentDesired, ModelDeploymentState } from '../../entities/model-deployment.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { Model } from '../../entities/model.entity';
import { SpendBudget } from '../../entities/spend-budget.entity';
import { Credential } from '../../entities/credential.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { AdapterRegistry } from './adapters/adapter.registry';
import { ModelSource, canRun, defaultCardName, defaultVendorModelId, readModelSource, schemesFor } from './model-source';
import { AdapterCredentials } from './adapters/adapter.interface';
import { ModelRegistryService } from '../model-registry/model-registry.service';
import { HfRevisionResolver, ModelSourceUnresolvedError, hfPinRequest } from '../model-registry/hf-revision.resolver';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';
import { isUniqueViolation } from '../../common/utils/unique-violation';
export const MODEL_RECONCILE_QUEUE = 'model-reconcile';
export const MODEL_RECONCILE_JOB = 'reconcile';

export interface CreateDeploymentDto {
  /**
   * The model to run, as configuration: hf://org/repo for a Hugging Face
   * repository (a branch, tag or sha after @ is optional; it is pinned to
   * the commit at create), bedrock:// fireworks:// together:// and the rest
   * for a model that already lives on that platform, s3:// or gs:// for
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
  /**
   * The catalog card this endpoint will fill once it is ready. Checked
   * against the organization at create: a card id that is a typo, or
   * belongs to somebody else, is refused rather than saved onto a
   * deployment that then reaches ready and lights nothing up.
   */
  modelId?: string | null;
  /**
   * Name of the card made for this deployment when `modelId` is not
   * given. Defaults to the repository or artifact name; a taken default
   * gets a numeric suffix, a taken explicit name is refused (MODEL_EXISTS).
   */
  name?: string | null;
  /**
   * The model id sent on the wire to the served endpoint, for that card.
   * Defaults to `org/repo` for hf:// (what vLLM and TGI serve under), the
   * platform's model reference for a provider reference, and the last path
   * segment for s3://, gs:// and file://.
   */
  vendorModelId?: string | null;
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
    // Last and optional only so the positional constructions in the specs
    // keep working; the module always provides it (Model is in forFeature)
    // and a guard test asserts that, so the card check below is never a
    // silent no-op in a running server.
    @Optional() @InjectRepository(Model) private readonly models?: Repository<Model>,
    // Same shape as `models` above, and last for the same reason: optional
    // only so the positional constructions in the specs keep working. The
    // module provides it and a guard test asserts the wiring, so the
    // budget check above is never a silent no-op in a running server.
    @Optional() @InjectRepository(SpendBudget) private readonly budgets?: Repository<SpendBudget>,
    // Last and optional for the same reason again. The module provides it
    // (ModelRegistryModule exports it) and a guard test asserts the wiring;
    // without it an unpinned hf:// reference is refused by the parser, as
    // it was before pinning was automatic.
    @Optional() private readonly hubRevisions?: HfRevisionResolver,
  ) {}

  async list(organizationId: string): Promise<ModelDeployment[]> {
    return this.deployments.find({ where: { organizationId }, order: { createdAt: 'DESC' } });
  }

  async get(organizationId: string, id: string): Promise<ModelDeployment> {
    const d = await this.deployments.findOne({ where: { id, organizationId } });
    if (!d) throw new NotFoundException('Hosted model not found');
    return d;
  }

  /** Validate against the adapter's capabilities and schema, persist desired state, enqueue a reconcile. */
  async create(organizationId: string, userId: string | null, dto: CreateDeploymentDto): Promise<ModelDeployment> {
    const adapter = this.adapters.get(dto.providerType);
    if (!adapter) throw new BadRequestException({ code: 'ADAPTER_UNKNOWN', message: `Unknown hosting provider: ${dto.providerType}` });
    // A registered version is optional. Naming the model is configuration.
    const version = dto.modelVersionId
      ? await this.versions.findOne({ where: { id: dto.modelVersionId, organizationId } })
      : null;
    if (dto.modelVersionId && !version) throw new NotFoundException('Model version not found');
    // Same rule for the catalog card the endpoint will fill: it has to be
    // this organization's. Unchecked, a typo saved quietly and the
    // deployment reached ready with nothing to light up, and a card id
    // belonging to another organization was written onto the row.
    if (dto.modelId && this.models) {
      const card = await this.models.findOne({ where: { id: dto.modelId, organizationId } });
      if (!card) throw new NotFoundException('Model card not found');
    }
    // And for the spend budget that caps this deployment. An id that is a
    // typo, or belongs to another organization, satisfied the foreign key
    // and saved quietly; the reconcile loop then looked it up scoped to
    // the deployment's own organization, found nothing, and returned. The
    // deployment ran with no cap at all, and nothing anywhere said so.
    if (dto.budgetId && this.budgets) {
      const budget = await this.budgets.findOne({ where: { id: dto.budgetId, organizationId } });
      if (!budget) throw new NotFoundException('Spend budget not found');
    }
    let reference = version?.registryUri ?? (dto.model?.trim() || undefined);
    if (!reference) {
      throw new BadRequestException({ code: 'MODEL_REQUIRED', message: 'Name the model to run with `model`, or point at a registered version with `modelVersionId`' });
    }
    // A Hugging Face model is named the way the Hub shows it, `org/repo`,
    // perhaps with a branch or tag. It is pinned here to the commit that
    // name points at now, so the deployment runs bytes that cannot move
    // under it. A registered version already carries its own pin.
    if (!version && this.hubRevisions && hfPinRequest(reference)) {
      const token = await this.hubTokenFor(organizationId, userId, adapter.key, dto);
      try {
        reference = await this.hubRevisions.pin(reference, token);
      } catch (err: any) {
        if (err instanceof ModelSourceUnresolvedError) throw new BadRequestException({ code: err.code, message: err.message });
        throw err;
      }
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

    // The card this endpoint fills. A deployment made from the UI names no
    // card, and the reconcile loop fills only the card on `modelId`, so
    // without one the endpoint reached ready and nothing could ever call
    // it. The card is made here, in the same request, and the two are
    // linked both ways before either is visible: the deployment id is
    // chosen up front so the card can carry it, and the card goes again if
    // the deployment does not save.
    const deploymentId = !dto.modelId && this.models ? randomUUID() : undefined;
    const card = deploymentId
      ? await this.createCardFor(organizationId, userId, deploymentId, adapter.key, {
          name: dto.name,
          vendorModelId: dto.vendorModelId,
          typed: dto.model?.trim() || null,
          reference: source.raw,
          source,
          version,
          base,
          desired,
        })
      : null;

    const deployment = this.deployments.create({
      ...(deploymentId ? { id: deploymentId } : {}),
      organizationId,
      modelVersionId: version?.id ?? null,
      modelRef: version ? null : source.raw,
      modelBase: version ? null : base,
      modelId: card?.id ?? dto.modelId ?? null,
      providerType: adapter.key,
      desired: { replicas: 1, minScale: caps.scaleToZero ? 0 : 1, maxScale: 1, ...desired },
      providerConfig: { ...(dto.providerConfig ?? {}), ...(dto.credentialId ? { credentialId: dto.credentialId } : {}) },
      externalRef: null,
      actual: null,
      state: 'pending',
      budgetId: dto.budgetId ?? null,
      createdBy: userId,
    });
    let saved: ModelDeployment;
    try {
      await deployment.encryptSensitiveDataForOrg(this.envelopeCrypto);
      saved = await this.deployments.save(deployment);
    } catch (err) {
      // No card may outlive the deployment it was made for: nothing else
      // would ever fill it, and it would sit in the catalog as "deploying".
      if (card && this.models) await this.models.delete({ id: card.id, organizationId }).catch(() => undefined);
      throw err;
    }
    this.audit(saved, AuditAction.MODEL_DEPLOYMENT_TRANSITION, userId, { from: null, to: 'pending', ...(card ? { modelId: card.id } : {}) });
    await this.enqueue(saved.id);
    return saved;
  }

  /**
   * The catalog card for a deployment that was given none.
   *
   * It starts `deploying` and unvalidated, which is never selectable: the
   * router passes over it until the reconcile loop has filled it (status
   * `active`, the endpoint URL, the provider row) and a validation run has
   * passed. No provider row yet (`providerId` null) and no `providerType`
   * either, because the price feed keys on that and a model on the
   * organization's own hardware has no public price; the adapter's own
   * per-token price, when it reports one, arrives through the budget tick.
   */
  private async createCardFor(
    organizationId: string,
    userId: string | null,
    deploymentId: string,
    adapterKey: string,
    input: {
      name?: string | null;
      vendorModelId?: string | null;
      typed: string | null;
      reference: string;
      source: ModelSource;
      version: ModelVersion | null;
      base: string | null;
      desired: ModelDeploymentDesired;
    },
  ): Promise<Model> {
    const models = this.models as Repository<Model>;
    const explicitName = input.name?.trim() || null;
    const name = explicitName ?? (await this.freeCardName(organizationId, input.version?.name?.trim() || defaultCardName(input.source)));
    if (explicitName) {
      const taken = await models.findOne({ where: { organizationId, name: explicitName } });
      if (taken) {
        throw new BadRequestException({ code: 'MODEL_EXISTS', message: `A model named "${explicitName}" already exists; choose another name` });
      }
    }
    const metadata: Record<string, any> = {
      // What the person asked for, and what almyty pinned it to. The UI
      // shows the first and says which revision the second is.
      source: input.typed ?? input.reference,
      modelRef: input.reference,
    };
    if (input.source.parsed.scheme === 'hf' && input.source.parsed.pin) metadata.revision = input.source.parsed.pin;

    const row = models.create({
      organizationId,
      name,
      vendorModelId: (input.vendorModelId?.trim() || defaultVendorModelId(input.source)).slice(0, 255),
      providerId: null,
      providerType: null,
      endpointRef: { deploymentId, providerType: adapterKey },
      modelVersionId: input.version?.id ?? null,
      base: input.base,
      capabilities: {},
      contextLength: null,
      privacyTier: input.desired.privacyTier ?? 'private_cloud',
      region: input.desired.region ?? null,
      pricingOverride: null,
      pricingSource: 'unpriced',
      status: 'deploying',
      validationStatus: 'never',
      metadata,
    });
    let saved: Model;
    try {
      saved = await models.save(row);
    } catch (err: any) {
      // Two deploys of the same model at once both found the name free.
      if (!isUniqueViolation(err)) throw err;
      if (explicitName) {
        throw new BadRequestException({ code: 'MODEL_EXISTS', message: `A model named "${explicitName}" already exists; choose another name` });
      }
      row.name = `${name.slice(0, 248)}-${randomUUID().slice(0, 6)}`;
      saved = await models.save(row);
    }
    void this.auditLog
      ?.log({
        organizationId,
        userId: userId ?? undefined,
        action: AuditAction.MODEL_REGISTERED,
        resourceType: AuditResource.MODEL,
        resourceId: saved.id,
        resourceName: saved.name,
        details: { deploymentId, providerType: adapterKey, source: metadata.source, modelRef: metadata.modelRef },
      })
      .catch(() => undefined);
    return saved;
  }

  /** `name`, else `name-2`, `name-3`, ...: a default name never fails a deploy for being taken. */
  private async freeCardName(organizationId: string, wanted: string): Promise<string> {
    const models = this.models as Repository<Model>;
    const base = (wanted || 'model').slice(0, 240);
    for (let n = 1; n <= 20; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!(await models.findOne({ where: { organizationId, name: candidate } }))) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  /**
   * A Hugging Face token for reading the Hub, when one is at hand.
   *
   * In order: a `hubToken` on the deployment's connection or config (the
   * field the Hugging Face adapter documents for exactly this), then the
   * connection's own token when that connection is a Hugging Face account,
   * then the server's HF_TOKEN. A token for another provider (a Modal or
   * RunPod key) is never sent to the Hub.
   */
  private async hubTokenFor(organizationId: string, userId: string | null, adapterKey: string, dto: CreateDeploymentDto): Promise<string | undefined> {
    const inline = dto.providerConfig ?? {};
    let stored: Record<string, any> = {};
    let connectorKey: string | null = null;
    if (dto.credentialId) {
      try {
        if (this.credentialRefs) {
          const resolved = await this.credentialRefs.resolve(organizationId, dto.credentialId, {
            principal: userId ? { id: userId } : undefined,
            context: { purpose: 'deploy', resourceType: 'model_deployment' },
          });
          stored = resolved.config ?? {};
          connectorKey = resolved.credential?.connectorKey ?? null;
        } else {
          await this.envelopeCrypto.warmOrg(organizationId);
          const credential = await this.credentials.findOne({ where: { id: dto.credentialId, organizationId } });
          if (credential) {
            stored = credential.getDecryptedConfig() as Record<string, any>;
            connectorKey = credential.connectorKey ?? null;
          }
        }
      } catch {
        // A connection that cannot be used is refused by the reconcile
        // loop with its own reason; a public repository still resolves.
      }
    }
    const hfAccount = adapterKey === 'huggingface-endpoints' || /hugging\s*face|huggingface/i.test(connectorKey ?? '');
    const candidates = [
      stored.hubToken,
      inline.hubToken,
      hfAccount ? stored.token : undefined,
      hfAccount ? inline.token : undefined,
      hfAccount ? stored.apiKey : undefined,
      process.env.HF_TOKEN,
    ];
    return candidates.find((v): v is string => typeof v === 'string' && v.length > 0);
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
      // The reference is the version's when there is one and the
      // deployment's own when the model was named inline. Keying this on
      // modelVersionId alone left an s3:// deployment with no registry
      // keys, which is exactly the Bedrock and SageMaker case.
      const version = deployment.modelVersionId ? await this.versions.findOne({ where: { id: deployment.modelVersionId } }) : null;
      const reference = version?.registryUri ?? deployment.modelRef ?? '';
      if (reference.startsWith('s3://')) {
        creds = { ...creds, ...(await this.registry.adapterCredentialsFor(deployment.organizationId)) };
      }
    }
    return creds;
  }

  async enqueue(deploymentId: string): Promise<void> {
    try {
      await this.queue.add(MODEL_RECONCILE_JOB, { deploymentId }, { // Deterministic, so a retry or a double-click collapses into one job
      // rather than racing the sweep to deploy the same model twice.
      jobId: `reconcile-${deploymentId}`, removeOnComplete: true, removeOnFail: 50 });
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
        resourceName: `${d.providerType}:${d.modelVersionId ?? d.modelRef ?? "?"}`,
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
