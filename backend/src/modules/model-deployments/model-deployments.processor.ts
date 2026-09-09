import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bull';
import { In, Repository } from 'typeorm';

import { ModelDeployment, ModelDeploymentState } from '../../entities/model-deployment.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { Model } from '../../entities/model.entity';
import { SpendBudget } from '../../entities/spend-budget.entity';
import { AuditAction } from '../../entities/audit-log.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { EndpointProviderHelper } from '../llm-providers/endpoint-provider.helper';
import { AdapterRegistry } from './adapters/adapter.registry';
import { ActualState, EndpointRef, ModelProviderAdapter } from './adapters/adapter.interface';
import { MODEL_RECONCILE_JOB, MODEL_RECONCILE_QUEUE, ModelDeploymentsService } from './model-deployments.service';

const REPEAT_JOB_ID = 'model-reconcile-sweep';
const SWEEP_JOB = 'sweep';
const DEFAULT_CRON = '*/2 * * * *';
const REGISTER_INTERVAL_MS = 10 * 60 * 1000;
/** A deployment the provider no longer knows, past this age, is torn down as an orphan. */
const ORPHAN_GRACE_MS = 30 * 60 * 1000;
/** Nothing to reconcile: the row is finished, whatever a stale job thinks. */
const TERMINAL_STATES: ModelDeploymentState[] = ['torn_down', 'orphaned'];
/** Consecutive read failures before a still-existing endpoint is called failed. */
const MAX_TRANSIENT_ERRORS = 3;
/** Errors that say the deployment itself is wrong, not the connection to the provider. */
const TERMINAL_ERROR_CODES = ['ADAPTER_UNSUPPORTED_ARCHITECTURE', 'ADAPTER_UNSUPPORTED_SOURCE', 'ADAPTER_UNSUPPORTED_OPERATION', 'CREDENTIAL_NOT_FOUND', 'CREDENTIAL_INACTIVE', 'CREDENTIAL_EXPIRED', 'CONNECTION_NOT_GRANTED'];

/**
 * The only thing that talks to adapters.
 *
 * Every tick reads the endpoint, diffs it against desired state, acts
 * (deploy, scale, teardown) or marks the row degraded or orphaned, writes
 * what it saw, charges the cost snapshot against the deployment budget,
 * and audits every transition. Controllers never call an adapter; they
 * write desired state and enqueue.
 */
@Injectable()
@Processor(MODEL_RECONCILE_QUEUE)
export class ModelDeploymentsProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModelDeploymentsProcessor.name);

  constructor(
    @InjectQueue(MODEL_RECONCILE_QUEUE) private readonly queue: Queue,
    @InjectRepository(ModelDeployment) private readonly deployments: Repository<ModelDeployment>,
    @InjectRepository(ModelVersion) private readonly versions: Repository<ModelVersion>,
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @InjectRepository(SpendBudget) private readonly budgets: Repository<SpendBudget>,
    private readonly adapters: AdapterRegistry,
    private readonly service: ModelDeploymentsService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly endpointProviders?: EndpointProviderHelper,
  ) {}

  cron(): string | undefined {
    const raw = process.env.MODEL_RECONCILE_CRON?.trim();
    if (raw && raw.toLowerCase() === 'off') return undefined;
    return raw && raw.length > 0 ? raw : DEFAULT_CRON;
  }

  isEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && this.cron() !== undefined;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('Model reconcile sweep disabled');
      return;
    }
    await this.registerSweep(true);
    // Bull keeps the repeatable job in Redis only. A flushed or replaced
    // Redis would otherwise leave every deployment in 'scaling' until the
    // next restart, so the registration is re-asserted periodically.
    const timer = setInterval(() => void this.registerSweep(false), REGISTER_INTERVAL_MS);
    timer.unref?.();
  }

  /** Idempotent: re-adding the same jobId + cron is a no-op for Bull; a changed cron evicts the old entry. */
  async registerSweep(verbose: boolean): Promise<void> {
    const cron = this.cron() as string;
    try {
      const repeatables = await this.queue.getRepeatableJobs();
      for (const repeatable of repeatables) {
        if (repeatable.id === REPEAT_JOB_ID && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }
      const present = repeatables.some((r) => r.id === REPEAT_JOB_ID && r.cron === cron);
      await this.queue.add(SWEEP_JOB, {}, { jobId: REPEAT_JOB_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      if (verbose) this.logger.log(`Model reconcile sweep registered: "${cron}"`);
      else if (!present) this.logger.warn(`Model reconcile sweep was missing from Redis and has been re-registered ("${cron}")`);
    } catch (error: any) {
      this.logger.error(`Failed to schedule model reconcile sweep: ${error.message}`);
    }
  }

  /**
   * A read that failed is not the same as an endpoint that failed. A
   * timeout or a 503 keeps the row observable (degraded, still swept) and
   * only becomes terminal after MAX_TRANSIENT_ERRORS in a row, so one
   * blip never stops the budget cap of a running paid endpoint.
   */
  private async recordError(d: ModelDeployment, error: any): Promise<ModelDeployment> {
    const message = error?.message ?? String(error);
    // A teardown that failed keeps its state, so the next tick tries the
    // delete again instead of reading the endpoint back to life.
    if (d.state === 'tearing_down' || (d.desired as Record<string, any>).teardownRequested) {
      d.lastError = message.slice(0, 2000);
      d.lastReconcileAt = new Date();
      d.actual = { ...(d.actual ?? {}), consecutiveErrors: ((d.actual?.consecutiveErrors as number | undefined) ?? 0) + 1, lastErrorAt: new Date().toISOString() };
      this.logger.warn(`Teardown of ${d.id} failed, will retry: ${message}`);
      return this.deployments.save(d);
    }
    const terminal = TERMINAL_ERROR_CODES.includes(error?.code);
    const consecutive = ((d.actual?.consecutiveErrors as number | undefined) ?? 0) + 1;
    if (terminal || consecutive >= MAX_TRANSIENT_ERRORS || !d.externalRef) {
      return this.fail(d, message);
    }
    const from = d.state;
    d.state = 'degraded';
    d.lastError = message.slice(0, 2000);
    d.lastReconcileAt = new Date();
    d.actual = { ...(d.actual ?? {}), consecutiveErrors: consecutive, lastErrorAt: new Date().toISOString() };
    const saved = await this.deployments.save(d);
    this.logger.warn(`Reconcile of ${d.id} failed (${consecutive}/${MAX_TRANSIENT_ERRORS}): ${message}`);
    if (from !== 'degraded') this.service.audit(saved, AuditAction.MODEL_DEPLOYMENT_TRANSITION, null, { from, to: 'degraded', error: d.lastError, consecutiveErrors: consecutive });
    await this.clearCard(saved, 'deployment is degraded');
    return saved;
  }

  @Process(SWEEP_JOB)
  async handleSweep(): Promise<{ reconciled: number }> {
    const active = await this.deployments.find({
      where: { state: In(['pending', 'deploying', 'ready', 'degraded', 'scaling', 'tearing_down'] as ModelDeploymentState[]) },
      order: { lastReconcileAt: 'ASC' },
      take: 200,
    });
    // A failed row whose endpoint still exists is still costing money: keep
    // reading it so the budget cap and the orphan check keep working. A
    // failed row with nothing at the provider is left alone.
    const failedWithEndpoint = (await this.deployments.find({
      where: { state: 'failed' as ModelDeploymentState },
      order: { lastReconcileAt: 'ASC' },
      take: 100,
    })).filter((d) => Boolean(d.externalRef));
    let reconciled = 0;
    for (const d of [...active, ...failedWithEndpoint]) {
      await this.reconcile(d.id);
      reconciled++;
    }
    return { reconciled };
  }

  @Process(MODEL_RECONCILE_JOB)
  async handleOne(job: Job<{ deploymentId: string }>): Promise<void> {
    await this.reconcile(job.data.deploymentId);
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Reconcile job ${job.id} failed: ${error.message}`);
  }

  /** One deployment, one tick. Never throws: the row records what went wrong. */
  async reconcile(deploymentId: string): Promise<ModelDeployment | null> {
    const d = await this.deployments.findOne({ where: { id: deploymentId } });
    if (!d) return null;
    // Terminal states are done. A job left in the queue from before a
    // teardown would otherwise see no externalRef and deploy the thing
    // again, at the customer's expense.
    if (TERMINAL_STATES.includes(d.state)) return d;
    const adapter = this.adapters.get(d.providerType);
    if (!adapter) return this.fail(d, `unknown adapter ${d.providerType}`);
    try {
      const creds = await this.service.credentialsFor(d);

      if (d.state === 'tearing_down' || (d.desired as Record<string, any>).teardownRequested) {
        // Asked to go away: it stops being routable now, not when the
        // provider finally confirms the delete.
        await this.clearCard(d, 'deployment is being torn down');
        if (d.externalRef) await adapter.teardown(d.externalRef, creds);
        d.externalRef = null;
        d.actual = { ...(d.actual ?? {}), state: 'stopped', message: 'endpoint removed' };
        await this.clearCard(d, 'deployment torn down', true);
        d.desired = { ...d.desired, teardownRequested: false } as ModelDeployment['desired'];
        return this.transition(d, d.state, 'torn_down');
      }

      if (!d.externalRef) {
        // Nothing exists yet: deploy.
        const version = await this.versions.findOne({ where: { id: d.modelVersionId } });
        if (!version) return this.fail(d, 'model version missing');
        await this.transition(d, d.state, 'deploying');
        const ref = await adapter.deploy(
          {
            deploymentId: d.id,
            organizationId: d.organizationId,
            version: { id: version.id, name: version.name, registryUri: version.registryUri, base: version.base, quantizations: version.quantizations, manifestSha: version.manifestSha },
            desired: d.desired,
            providerConfig: stripSecrets(d.getDecryptedProviderConfig()),
          },
          creds,
        );
        d.externalRef = ref;
        d.lastError = null;
        await this.deployments.save(d);
      }

      const actual = await adapter.readEndpoint(d.externalRef as EndpointRef, creds);
      // missingSince outlives the actual it was recorded in: the orphan
      // grace is measured from the first missing read, not from this one.
      const missingSince = d.actual?.missingSince as string | undefined;
      d.actual = { ...sanitizeActual(actual), consecutiveErrors: 0, ...(missingSince ? { missingSince } : {}) };
      d.lastReconcileAt = new Date();

      if (actual.state === 'missing') return this.markOrphan(d);
      if (actual.state === 'failed') return this.fail(d, actual.message ?? 'provider reports failed');

      // Diff desired replicas against what is running.
      const wantReplicas = d.desired.replicas ?? 1;
      if (actual.replicas !== undefined && actual.replicas !== wantReplicas && actual.state !== 'scaling') {
        await adapter.scale(d.externalRef as EndpointRef, wantReplicas, creds);
        await this.transition(d, d.state, 'scaling', undefined);
        return d;
      }

      const next: ModelDeploymentState =
        actual.state === 'ready' ? 'ready' : actual.state === 'stopped' ? (wantReplicas === 0 ? 'ready' : 'degraded') : actual.state === 'degraded' ? 'degraded' : 'deploying';
      await this.transition(d, d.state, next, undefined);

      if (next === 'ready' && actual.state === 'ready') await this.fillCard(d, actual);
      // Stopped (scaled to zero, paused, budget cap) is not servable.
      else if (actual.state === 'stopped' || next === 'degraded') await this.clearCard(d, `endpoint is ${actual.state}`);
      await this.chargeBudget(d, adapter, creds);
      return d;
    } catch (error: any) {
      return this.recordError(d, error);
    }
  }

  private async transition(d: ModelDeployment, from: ModelDeploymentState, to: ModelDeploymentState, details?: Record<string, any>): Promise<ModelDeployment> {
    d.state = to;
    d.lastReconcileAt = new Date();
    if (details) d.actual = { ...(d.actual ?? {}), ...details };
    const saved = await this.deployments.save(d);
    if (from !== to) this.service.audit(saved, AuditAction.MODEL_DEPLOYMENT_TRANSITION, null, { from, to, ...(details ?? {}) });
    return saved;
  }

  private async fail(d: ModelDeployment, message: string): Promise<ModelDeployment> {
    const from = d.state;
    d.state = 'failed';
    d.lastError = message.slice(0, 2000);
    d.lastReconcileAt = new Date();
    const saved = await this.deployments.save(d);
    this.service.audit(saved, AuditAction.MODEL_DEPLOYMENT_TRANSITION, null, { from, to: 'failed', error: d.lastError });
    await this.clearCard(saved, 'deployment failed');
    return saved;
  }

  /** The provider forgot it. Past the grace period the row is orphaned and anything left is torn down. Weights stay. */
  private async markOrphan(d: ModelDeployment): Promise<ModelDeployment> {
    // The grace runs from the first missing read, not from updatedAt: every
    // tick saves the row, so an updatedAt window would never close.
    const firstMissing = (d.actual?.missingSince as string | undefined) ?? new Date().toISOString();
    const age = Date.now() - new Date(firstMissing).getTime();
    if (d.state === 'deploying' && age < ORPHAN_GRACE_MS) {
      d.actual = { ...(d.actual ?? {}), missingSince: firstMissing };
      await this.deployments.save(d);
      return d;
    }
    const from = d.state;
    d.state = 'orphaned';
    d.lastError = 'endpoint no longer exists at the provider';
    d.actual = { ...(d.actual ?? {}), missingSince: firstMissing };
    const saved = await this.deployments.save(d);
    this.service.audit(saved, AuditAction.MODEL_DEPLOYMENT_ORPHAN_TEARDOWN, null, { from, to: 'orphaned', missingSince: firstMissing });
    await this.clearCard(saved, 'endpoint no longer exists at the provider', true);
    return saved;
  }

  /**
   * The endpoint is no longer serving, so the card must stop being
   * routable. A card whose endpoint was torn down or orphaned loses the
   * URL as well; one that is merely stopped or degraded keeps it so a
   * later ready tick can light it up again without re-registering.
   */
  private async clearCard(d: ModelDeployment, reason: string, forget = false): Promise<void> {
    if (!d.modelId) return;
    const card = await this.models.findOne({ where: { id: d.modelId, organizationId: d.organizationId } });
    if (!card) return;
    if (card.endpointRef?.deploymentId && card.endpointRef.deploymentId !== d.id) return;
    // The provider row answers for this endpoint, so it stops too.
    await this.endpointProviders?.deactivate(d.organizationId, card.providerId, d.id).catch(() => undefined);
    if (card.status === 'inactive' && (!forget || !card.endpointRef)) return;
    card.status = 'inactive';
    if (forget) card.endpointRef = null;
    card.metadata = { ...(card.metadata ?? {}), unroutableSince: new Date().toISOString(), unroutableReason: reason };
    await this.models.save(card);
  }

  /** A ready deployment fills its catalog card so the router can see it. */
  private async fillCard(d: ModelDeployment, actual: ActualState): Promise<void> {
    if (!d.modelId) return;
    const card = await this.models.findOne({ where: { id: d.modelId, organizationId: d.organizationId } });
    if (!card) return;
    const url = actual.url ?? (d.externalRef?.url as string | undefined);
    card.endpointRef = { url, deploymentId: d.id, providerType: d.providerType };
    card.status = 'active';
    if (card.metadata?.unroutableSince) {
      const { unroutableSince, unroutableReason, ...rest } = card.metadata as Record<string, any>;
      card.metadata = rest;
    }
    card.region = actual.region ?? d.desired.region ?? card.region;

    // A card is called through a real provider row: conversations carry a
    // provider foreign key and stats are written per provider id, so a
    // transient object would break the first chat that used it.
    if (url && this.endpointProviders) {
      try {
        const config = d.getDecryptedProviderConfig();
        const provider = await this.endpointProviders.upsert({
          organizationId: d.organizationId,
          providerId: card.providerId,
          name: card.name || `${d.providerType} endpoint`,
          apiUrl: EndpointProviderHelper.baseFor(url, actual.openAiBase),
          model: card.vendorModelId,
          credentialId: (config.credentialId as string | undefined) ?? undefined,
          managedById: d.id,
          region: card.region,
        });
        card.providerId = provider.id;
        card.providerType = provider.type;
      } catch (error: any) {
        this.logger.warn(`could not write the endpoint provider for card ${card.id}: ${error?.message ?? error}`);
      }
    }
    await this.models.save(card);
  }

  /** Charge the snapshot against the deployment's budget; over the line, scale to zero and say so. */
  private async chargeBudget(d: ModelDeployment, adapter: ModelProviderAdapter, creds: Record<string, string | undefined>): Promise<void> {
    if (!d.externalRef) return;
    const snapshot = await adapter.costSnapshot(d.externalRef, creds);
    d.actual = { ...(d.actual ?? {}), spentCents: snapshot.spentCents, ratePerHourCents: snapshot.ratePerHourCents, costObservedAt: snapshot.observedAt };
    if (snapshot.perToken && d.modelId) {
      const card = await this.models.findOne({ where: { id: d.modelId } });
      if (card && !card.pricingOverride) {
        card.pricing = { inPerMTok: snapshot.perToken.inPerMTok, outPerMTok: snapshot.perToken.outPerMTok, currency: snapshot.perToken.currency };
        card.pricingSource = 'adapter';
        card.pricingFetchedAt = new Date();
        await this.models.save(card);
      }
    }
    await this.deployments.save(d);
    if (!d.budgetId) return;
    const budget = await this.budgets.findOne({ where: { id: d.budgetId, organizationId: d.organizationId } });
    if (!budget || !budget.active) return;
    if (snapshot.spentCents >= budget.limitCents && (d.desired.replicas ?? 1) > 0) {
      d.desired = { ...d.desired, replicas: 0 };
      await adapter.scale(d.externalRef, 0, creds);
      await this.deployments.save(d);
      this.service.audit(d, AuditAction.MODEL_DEPLOYMENT_BUDGET_STOP, null, { spentCents: snapshot.spentCents, limitCents: budget.limitCents, budgetId: budget.id });
      void this.notifications
        ?.emit({
          type: 'model.deployment.budget_stop',
          organizationId: d.organizationId,
          userIds: d.createdBy ? [d.createdBy] : [],
          title: 'Deployment scaled to zero: budget reached',
          body: `${d.providerType} deployment spent ${(snapshot.spentCents / 100).toFixed(2)} of its ${(budget.limitCents / 100).toFixed(2)} budget.`,
        } as any)
        .catch(() => undefined);
    }
  }
}

function sanitizeActual(actual: ActualState): Record<string, any> {
  const { details, ...rest } = actual;
  const safeDetails: Record<string, any> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (!ModelDeployment.isSecretKey(k)) safeDetails[k] = v;
  }
  return { ...rest, ...(Object.keys(safeDetails).length ? { details: safeDetails } : {}) };
}

function stripSecrets(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) if (!ModelDeployment.isSecretKey(k) && k !== 'credentialId') out[k] = v;
  return out;
}
