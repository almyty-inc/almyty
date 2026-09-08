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
import { AdapterRegistry } from './adapters/adapter.registry';
import { ActualState, EndpointRef, ModelProviderAdapter } from './adapters/adapter.interface';
import { MODEL_RECONCILE_JOB, MODEL_RECONCILE_QUEUE, ModelDeploymentsService } from './model-deployments.service';

const REPEAT_JOB_ID = 'model-reconcile-sweep';
const SWEEP_JOB = 'sweep';
const DEFAULT_CRON = '*/2 * * * *';
/** A deployment the provider no longer knows, past this age, is torn down as an orphan. */
const ORPHAN_GRACE_MS = 30 * 60 * 1000;

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
    const cron = this.cron() as string;
    try {
      for (const repeatable of await this.queue.getRepeatableJobs()) {
        if (repeatable.id === REPEAT_JOB_ID && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }
      await this.queue.add(SWEEP_JOB, {}, { jobId: REPEAT_JOB_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      this.logger.log(`Model reconcile sweep registered: "${cron}"`);
    } catch (error: any) {
      this.logger.error(`Failed to schedule model reconcile sweep: ${error.message}`);
    }
  }

  @Process(SWEEP_JOB)
  async handleSweep(): Promise<{ reconciled: number }> {
    const active = await this.deployments.find({
      where: { state: In(['pending', 'deploying', 'ready', 'degraded', 'scaling', 'tearing_down'] as ModelDeploymentState[]) },
      order: { lastReconcileAt: 'ASC' },
      take: 200,
    });
    let reconciled = 0;
    for (const d of active) {
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
    const adapter = this.adapters.get(d.providerType);
    if (!adapter) return this.fail(d, `unknown adapter ${d.providerType}`);

    try {
      const creds = await this.service.credentialsFor(d);

      if (d.state === 'tearing_down') {
        if (d.externalRef) await adapter.teardown(d.externalRef, creds);
        d.externalRef = null;
        d.actual = { ...(d.actual ?? {}), state: 'stopped', message: 'endpoint removed' };
        return this.transition(d, 'tearing_down', 'torn_down');
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
      d.actual = sanitizeActual(actual);
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

      if (next === 'ready') await this.fillCard(d, actual);
      await this.chargeBudget(d, adapter, creds);
      return d;
    } catch (error: any) {
      return this.fail(d, error?.message ?? String(error));
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
    return saved;
  }

  /** The provider forgot it. Past the grace period the row is orphaned and anything left is torn down. Weights stay. */
  private async markOrphan(d: ModelDeployment): Promise<ModelDeployment> {
    const age = Date.now() - new Date(d.updatedAt ?? d.createdAt).getTime();
    if (d.state === 'deploying' && age < ORPHAN_GRACE_MS) {
      await this.deployments.save(d);
      return d;
    }
    const from = d.state;
    d.state = 'orphaned';
    d.lastError = 'endpoint no longer exists at the provider';
    const saved = await this.deployments.save(d);
    this.service.audit(saved, AuditAction.MODEL_DEPLOYMENT_ORPHAN_TEARDOWN, null, { from, to: 'orphaned' });
    return saved;
  }

  /** A ready deployment fills its catalog card so the router can see it. */
  private async fillCard(d: ModelDeployment, actual: ActualState): Promise<void> {
    if (!d.modelId) return;
    const card = await this.models.findOne({ where: { id: d.modelId, organizationId: d.organizationId } });
    if (!card) return;
    card.endpointRef = { url: actual.url ?? d.externalRef?.url, deploymentId: d.id, providerType: d.providerType };
    card.status = 'active';
    card.region = actual.region ?? d.desired.region ?? card.region;
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
