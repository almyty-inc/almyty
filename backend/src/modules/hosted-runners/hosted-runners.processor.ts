import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bull';
import { In, Not, Repository } from 'typeorm';

import { Environment } from '../../entities/environment.entity';
import { HostedRunner, HostedRunnerState } from '../../entities/hosted-runner.entity';
import { Runner, RunnerState } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { AuditAction } from '../../entities/audit-log.entity';
import { canAcceptWork } from '../runner/runner-state';
import { HostedAdapterRegistry } from './adapters/adapter.registry';
import { HostedActual, HostedAdapterCredentials, HostedProvisionRequest, HostedRef, HostedRunnerAdapter } from './adapters/hosted-runner-adapter.interface';
import { EnrollmentService, HOSTED_RENEW_PATH, HOSTED_STREAM_PATH } from './enrollment.service';
import { HostedRunnerSettingsService } from './hosted-runner-settings';
import { HostedUsageService } from './hosted-usage.service';
import { HOSTED_RECONCILE_JOB, HOSTED_RECONCILE_QUEUE, HostedRunnersService, TERMINAL_HOSTED_STATES } from './hosted-runners.service';
import { HostedModelTokenService } from './hosted-model-token.service';

const SWEEP_JOB = 'sweep';
const REPEAT_JOB_ID = 'hosted-runner-reconcile-sweep';

/** Errors that say the configuration is wrong, not that the cluster blinked. */
const TERMINAL_ERROR_CODES = ['CREDENTIAL_NOT_FOUND', 'CREDENTIAL_INACTIVE', 'CREDENTIAL_EXPIRED', 'CREDENTIAL_INVALID', 'CONNECTION_NOT_GRANTED', 'VENDOR_KEY_NOT_ALLOWED'];

/** What the reconcile loop is allowed to write, by column. */
type ObservedColumns = Partial<Pick<HostedRunner, 'state' | 'actual' | 'externalRef' | 'lastError' | 'lastReconcileAt' | 'environmentVersion' | 'desired'>>;

/**
 * The only thing that talks to hosted runner adapters.
 *
 * Every tick reads what the cluster has, diffs it against `desired`,
 * acts (provision, wake with a fresh enrollment token, scale to zero,
 * tear down), writes what it saw, opens or closes the usage interval,
 * moves the workspace between active and suspended, and audits every
 * transition. Services write `desired` and enqueue; the sweep also runs
 * the idle and retention checks. Mirrors model-deployments.processor.ts:
 * a provisioning claim is a lease, three failed reads in a row mark the
 * row failed, and a row the cluster lost is orphaned after a grace.
 */
@Injectable()
@Processor(HOSTED_RECONCILE_QUEUE)
export class HostedRunnersProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(HostedRunnersProcessor.name);

  constructor(
    @InjectQueue(HOSTED_RECONCILE_QUEUE) private readonly queue: Queue,
    @InjectRepository(HostedRunner) private readonly hostedRunners: Repository<HostedRunner>,
    @InjectRepository(Environment) private readonly environments: Repository<Environment>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Runner) private readonly runners: Repository<Runner>,
    private readonly adapters: HostedAdapterRegistry,
    private readonly service: HostedRunnersService,
    private readonly enrollment: EnrollmentService,
    private readonly usage: HostedUsageService,
    private readonly settings: HostedRunnerSettingsService,
    // Optional only for the positional harnesses; Nest always injects it.
    @Optional() private readonly modelTokens?: HostedModelTokenService,
  ) {}

  cron(): string | undefined {
    const raw = this.settings.current.reconcile.sweepCron?.trim();
    if (!raw || raw.toLowerCase() === 'off') return undefined;
    return raw;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || !this.settings.enabled() || !this.cron()) {
      this.logger.log('Hosted runner reconcile sweep disabled');
      return;
    }
    try {
      const cron = this.cron() as string;
      for (const r of await this.queue.getRepeatableJobs()) {
        if (r.id === REPEAT_JOB_ID && r.cron !== cron) await this.queue.removeRepeatableByKey(r.key);
      }
      await this.queue.add(SWEEP_JOB, {}, { jobId: REPEAT_JOB_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      this.logger.log(`Hosted runner reconcile sweep registered: "${cron}"`);
    } catch (error: any) {
      this.logger.error(`Failed to schedule the hosted runner sweep: ${error?.message ?? error}`);
    }
  }

  @Process(SWEEP_JOB)
  async handleSweep(): Promise<{ reconciled: number }> {
    if (!this.settings.enabled()) return { reconciled: 0 };
    const now = new Date();
    try {
      await this.service.suspendIdle(now);
      await this.service.sweepSuspended(now);
    } catch (err: any) {
      this.logger.warn(`hosted runner idle/retention sweep failed: ${err?.message ?? err}`);
    }
    const rows = await this.hostedRunners.find({
      where: { state: Not(In(TERMINAL_HOSTED_STATES)) },
      order: { lastReconcileAt: 'ASC' },
      take: this.settings.current.reconcile.batchSize,
    });
    for (const hr of rows) await this.reconcile(hr.id, now);
    return { reconciled: rows.length };
  }

  @Process(HOSTED_RECONCILE_JOB)
  async handleOne(job: Job<{ hostedRunnerId: string }>): Promise<void> {
    await this.reconcile(job.data.hostedRunnerId);
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Hosted runner reconcile job ${job.id} failed: ${error.message}`);
  }

  /** The reconcile loop writes only the columns it owns. */
  private async writeObserved(hr: HostedRunner, fields: ObservedColumns): Promise<void> {
    Object.assign(hr, fields);
    await this.hostedRunners.update({ id: hr.id }, fields);
  }

  private async transition(hr: HostedRunner, to: HostedRunnerState, fields: ObservedColumns = {}, details: Record<string, any> = {}): Promise<HostedRunner> {
    const from = hr.state;
    await this.writeObserved(hr, { ...fields, state: to, lastReconcileAt: new Date() });
    if (from !== to) this.service.audit(hr, AuditAction.HOSTED_RUNNER_TRANSITION, null, { from, to, ...details });
    return hr;
  }

  /** One hosted runner, one tick. Never throws: the row records what went wrong. */
  async reconcile(hostedRunnerId: string, now = new Date()): Promise<HostedRunner | null> {
    const hr = await this.hostedRunners.findOne({ where: { id: hostedRunnerId } });
    if (!hr) return null;
    if (TERMINAL_HOSTED_STATES.includes(hr.state)) return hr;
    const adapter = this.adapters.get(hr.providerType);
    if (!adapter) return this.fail(hr, `unknown hosted runner adapter ${hr.providerType}`);
    try {
      const creds = await this.service.clusterCredentialsFor(hr);
      const workspace = await this.workspaces.findOne({ where: { id: hr.workspaceId } });
      const env = await this.environments.findOne({ where: { id: hr.environmentId }, withDeleted: true });

      // Gone, or asked to go: tear down. A workspace or environment that
      // no longer exists takes its machine with it.
      const terminalWorkspace = !workspace || [WorkspaceStatus.RELEASED, WorkspaceStatus.EXPIRED, WorkspaceStatus.STRANDED].includes(workspace.status);
      if (hr.desired.teardownRequested || hr.state === 'tearing_down' || terminalWorkspace || !env || env.deletedAt) {
        return this.teardown(hr, adapter, creds, now, hr.desired.keepVolume ?? false);
      }

      if (!hr.externalRef) {
        if (!(await this.claim(hr))) return hr;
        const ref = await adapter.provision(await this.provisionRequest(hr, env), creds);
        await this.writeObserved(hr, { externalRef: ref, environmentVersion: env.version, lastError: null });
        await this.workspaces.update({ id: workspace!.id }, { volumeRef: { name: String(ref.volume ?? ''), sizeGi: this.sizeOf(hr).volumeGi, provider: adapter.key } });
        this.service.audit(hr, AuditAction.HOSTED_RUNNER_TRANSITION, null, { provisioned: true });
      }

      const ref = hr.externalRef as HostedRef;
      const actual = await adapter.read(ref, creds);
      if (!actual.exists) return this.markMissing(hr, workspace!, now);
      const observed = { ...sanitize(actual), consecutiveErrors: 0, observedAt: now.toISOString() };

      if (hr.desired.replicas === 1) return this.wake(hr, adapter, creds, env, workspace!, actual, observed, now);
      return this.suspend(hr, adapter, creds, workspace!, actual, observed, now);
    } catch (error: any) {
      return this.recordError(hr, error);
    }
  }

  /**
   * desired replicas 1. A pod that is not up (or not enrolled within the
   * enrollment wait) gets a fresh token in its Secret and is scaled up; a
   * ready pod whose runner is online makes the row ready, opens the usage
   * interval and resumes the workspace.
   */
  private async wake(
    hr: HostedRunner,
    adapter: HostedRunnerAdapter,
    creds: HostedAdapterCredentials,
    env: Environment,
    workspace: Workspace,
    actual: HostedActual,
    observed: Record<string, any>,
    now: Date,
  ): Promise<HostedRunner> {
    const ref = hr.externalRef as HostedRef;
    const runner = hr.runnerId ? await this.runners.findOne({ where: { id: hr.runnerId } }) : null;
    if (actual.pod === 'failed') {
      await this.writeObserved(hr, { actual: { ...(hr.actual ?? {}), ...observed } });
      return this.fail(hr, actual.message ?? 'the pod failed to start');
    }
    const online = !!runner && canAcceptWork(runner.state) && runner.lastHeartbeatAt !== null;
    if (actual.readyReplicas > 0 && online) {
      await this.usage.open(hr, now, workspace.agentId);
      if (workspace.status === WorkspaceStatus.SUSPENDED) {
        const resumed = await this.workspaces.update({ id: workspace.id, status: WorkspaceStatus.SUSPENDED }, { status: WorkspaceStatus.ACTIVE, lastActiveAt: now });
        if (resumed.affected) this.service.audit(hr, AuditAction.WORKSPACE_RESUMED, null, { workspaceId: workspace.id });
      }
      return this.transition(hr, 'ready', { actual: { ...observed, readyAt: hr.actual?.readyAt ?? now.toISOString() }, lastError: null }, { workspaceId: workspace.id });
    }

    if (actual.replicas === 0) {
      // A newer environment version is applied while there is no pod yet.
      if (hr.environmentVersion !== env.version) {
        await adapter.provision(await this.provisionRequest(hr, env), creds);
        await this.writeObserved(hr, { environmentVersion: env.version });
      }
      // A fresh single-use token and freshly resolved variables every
      // start, so a secret rotated in the store reaches this wake. The
      // pod-scoped model token is minted here too (the previous one of this
      // machine stops) and, like every secret, reaches the pod only through
      // its Secret; a vendor key the environment binds itself wins.
      const token = await this.enrollment.mint(hr, now);
      const bound = await this.service.resolveSecretEnv(env, workspace);
      const modelToken = this.modelTokens ? await this.modelTokens.mint(hr, workspace.ownerUserId, now) : null;
      const secretEnv = { ...modelTokenEnv(modelToken), ...bound, ALMYTY_ENROLLMENT_TOKEN: token };
      await adapter.rotateEnrollment(ref, secretEnv, creds);
      await adapter.scale(ref, 1, creds);
      return this.transition(hr, 'provisioning', { actual: { ...observed, enrollIssuedAt: now.toISOString(), readyAt: null } }, { reason: 'wake' });
    }
    // A pod that has not enrolled within the wait is restarted: scaled to
    // zero here, started with a new token on the next tick (its token may
    // have expired, and a pod reads its Secret only when it starts).
    const issuedAt = hr.actual?.enrollIssuedAt ? new Date(hr.actual.enrollIssuedAt).getTime() : 0;
    const waitMs = this.settings.minutes(this.settings.current.reconcile.enrollWaitMinutes);
    if (now.getTime() - issuedAt > waitMs) {
      await adapter.scale(ref, 0, creds);
      return this.transition(hr, 'provisioning', { actual: { ...observed, enrollIssuedAt: null } }, { reason: 'enrollment timed out; restarting' });
    }
    return this.transition(hr, 'provisioning', { actual: { ...(hr.actual ?? {}), ...observed } });
  }

  /**
   * desired replicas 0. A running pod is scaled to zero; once it is gone
   * the Secret is dropped, the usage interval closed, the workspace
   * suspended and the runner marked offline (it will not heartbeat again).
   */
  private async suspend(
    hr: HostedRunner,
    adapter: HostedRunnerAdapter,
    creds: HostedAdapterCredentials,
    workspace: Workspace,
    actual: HostedActual,
    observed: Record<string, any>,
    now: Date,
  ): Promise<HostedRunner> {
    const ref = hr.externalRef as HostedRef;
    // The pod is going: its model token stops now, not when it is gone.
    await this.modelTokens?.revoke(hr.id, 'pod_stopped', now);
    if (actual.replicas > 0) {
      await adapter.scale(ref, 0, creds);
      return this.transition(hr, 'suspending', { actual: observed });
    }
    if (actual.readyReplicas > 0 || actual.pod === 'running' || actual.pod === 'starting') {
      return this.transition(hr, 'suspending', { actual: observed });
    }
    await adapter.clearSecrets(ref, creds);
    await this.usage.close(hr.id, now);
    if (workspace.status === WorkspaceStatus.ACTIVE) {
      const parked = await this.workspaces.update({ id: workspace.id, status: WorkspaceStatus.ACTIVE }, { status: WorkspaceStatus.SUSPENDED });
      if (parked.affected) this.service.audit(hr, AuditAction.WORKSPACE_SUSPENDED, null, { workspaceId: workspace.id });
    }
    if (hr.runnerId) await this.runners.update({ id: hr.runnerId, state: Not(RunnerState.OFFLINE) }, { state: RunnerState.OFFLINE });
    return this.transition(hr, 'suspended', { actual: { ...observed, enrollIssuedAt: null, readyAt: null } });
  }

  private async teardown(hr: HostedRunner, adapter: HostedRunnerAdapter, creds: HostedAdapterCredentials, now: Date, keepVolume: boolean): Promise<HostedRunner> {
    if (hr.state !== 'tearing_down') await this.transition(hr, 'tearing_down');
    await this.modelTokens?.revoke(hr.id, 'torn_down', now);
    if (hr.externalRef) await adapter.teardown(hr.externalRef as HostedRef, { keepVolume }, creds);
    await this.usage.close(hr.id, now);
    if (hr.runnerId) await this.runners.update({ id: hr.runnerId }, { state: RunnerState.OFFLINE });
    // The flag is the one desired-state change this loop owns; merge it
    // into the row as it stands now.
    const fresh = await this.hostedRunners.findOne({ where: { id: hr.id } });
    const desired = { ...(fresh?.desired ?? hr.desired), replicas: 0 as const, teardownRequested: false };
    return this.transition(hr, 'torn_down', { externalRef: null, desired }, { keepVolume });
  }

  /**
   * The provisioning claim: a lease, so two API pods never provision one
   * row and a pod that died mid-provision does not leave it stuck.
   */
  private async claim(hr: HostedRunner): Promise<boolean> {
    const lease = this.settings.minutes(this.settings.current.reconcile.claimLeaseMinutes);
    const result = await this.hostedRunners
      .createQueryBuilder()
      .update()
      .set({ state: 'provisioning', lastReconcileAt: new Date() })
      .where('id = :id', { id: hr.id })
      .andWhere('"externalRef" IS NULL')
      .andWhere('(state <> :provisioning OR "lastReconcileAt" IS NULL OR "lastReconcileAt" < :stale)', {
        provisioning: 'provisioning',
        stale: new Date(Date.now() - lease),
      })
      .execute();
    if (!result.affected) return false;
    const from = hr.state;
    hr.state = 'provisioning';
    if (from !== 'provisioning') this.service.audit(hr, AuditAction.HOSTED_RUNNER_TRANSITION, null, { from, to: 'provisioning' });
    return true;
  }

  /** The cluster lost the objects. Past the grace the row is orphaned and its workspace released with the reason. */
  private async markMissing(hr: HostedRunner, workspace: Workspace, now: Date): Promise<HostedRunner> {
    const first = (hr.actual?.missingSince as string | undefined) ?? now.toISOString();
    const grace = this.settings.minutes(this.settings.current.reconcile.orphanGraceMinutes);
    if (now.getTime() - new Date(first).getTime() < grace) {
      await this.writeObserved(hr, { actual: { ...(hr.actual ?? {}), missingSince: first }, lastReconcileAt: now });
      return hr;
    }
    await this.usage.close(hr.id, now);
    await this.modelTokens?.revoke(hr.id, 'torn_down', now);
    await this.workspaces.update(
      { id: workspace.id, status: In([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]) },
      { status: WorkspaceStatus.RELEASED, closedAt: now, closeReason: { kind: 'released', detail: 'its volume no longer exists in the cluster' } },
    );
    if (hr.runnerId) await this.runners.update({ id: hr.runnerId }, { state: RunnerState.OFFLINE });
    return this.transition(hr, 'orphaned', { lastError: 'the cluster no longer has this machine', actual: { ...(hr.actual ?? {}), missingSince: first } }, { missingSince: first });
  }

  private async fail(hr: HostedRunner, message: string): Promise<HostedRunner> {
    await this.modelTokens?.revoke(hr.id, 'failed');
    return this.transition(hr, 'failed', { lastError: message.slice(0, 2000) }, { error: message.slice(0, 500) });
  }

  /**
   * A failed call is not a failed machine: it becomes one after
   * maxReadFailures in a row, or at once when the configuration itself is
   * wrong (a missing or unusable cluster connection).
   */
  private async recordError(hr: HostedRunner, error: any): Promise<HostedRunner> {
    const message = String(error?.message ?? error);
    const code = error?.response?.code ?? error?.code;
    const consecutive = ((hr.actual?.consecutiveErrors as number | undefined) ?? 0) + 1;
    if (TERMINAL_ERROR_CODES.includes(code) || consecutive >= this.settings.current.reconcile.maxReadFailures) {
      await this.writeObserved(hr, { actual: { ...(hr.actual ?? {}), consecutiveErrors: consecutive } });
      return this.fail(hr, message);
    }
    this.logger.warn(`Hosted runner ${hr.id} reconcile failed (${consecutive}/${this.settings.current.reconcile.maxReadFailures}): ${message}`);
    await this.writeObserved(hr, {
      actual: { ...(hr.actual ?? {}), consecutiveErrors: consecutive, lastErrorAt: new Date().toISOString() },
      lastError: message.slice(0, 2000),
      lastReconcileAt: new Date(),
    });
    return hr;
  }

  private sizeOf(hr: HostedRunner) {
    const size = this.settings.resourceClass(hr.desired.resourceClass) ?? this.settings.resourceClass(this.settings.current.defaultResourceClass)!;
    return size;
  }

  /** Everything the adapter needs; plain settings only, secrets go through rotateEnrollment. */
  async provisionRequest(hr: HostedRunner, env: Environment): Promise<HostedProvisionRequest> {
    const s = this.settings.current;
    const capacity = await this.service.capacityFor(hr.organizationId);
    const size = this.sizeOf(hr);
    const allowed = capacity.resourceClasses ?? Object.keys(s.resourceClasses);
    const biggestName = allowed
      .filter((n) => s.resourceClasses[n])
      .sort((a, b) => s.resourceClasses[b].volumeGi - s.resourceClasses[a].volumeGi)[0] ?? hr.desired.resourceClass;
    const biggest = s.resourceClasses[biggestName] ?? size;
    const api = this.settings.apiOrigin();
    if (!api) throw Object.assign(new Error('PUBLIC_API_URL (or the settings apiUrl) is not set, so a pod cannot reach almyty'), { code: 'CREDENTIAL_INVALID' });
    const repoHost = env.repo?.url ? safeHost(env.repo.url) : null;
    const egressHosts = [...new Set([...(env.egress?.allowHosts ?? []), api.host, ...(repoHost ? [repoHost] : [])])];
    return {
      hostedRunnerId: hr.id,
      organizationId: hr.organizationId,
      environmentId: env.id,
      environmentVersion: env.version,
      workspaceId: hr.workspaceId,
      runnerId: hr.runnerId as string,
      image: env.image.ref,
      resources: { name: hr.desired.resourceClass, ...size },
      egressHosts,
      env: {
        ALMYTY_API_URL: api.url,
        ALMYTY_ENROLL_PATH: '/runners/enroll',
        ALMYTY_STREAM_PATH: HOSTED_STREAM_PATH,
        ALMYTY_RENEW_PATH: HOSTED_RENEW_PATH,
        ALMYTY_RUNNER_ID: hr.runnerId as string,
        ALMYTY_HOSTED_RUNNER_ID: hr.id,
        ALMYTY_ENVIRONMENT_ID: env.id,
        ALMYTY_ENVIRONMENT_VERSION: String(env.version),
        ALMYTY_WORKSPACE_ID: hr.workspaceId,
        ...(env.repo?.url ? { ALMYTY_REPO_URL: env.repo.url } : {}),
        ...(env.repo?.ref ? { ALMYTY_REPO_REF: env.repo.ref } : {}),
        ...(env.setupScript ? { ALMYTY_SETUP_SCRIPT: env.setupScript } : {}),
        ALMYTY_CACHE_PATHS: JSON.stringify(env.cache?.paths ?? []),
        ...(env.egress?.allowBinaries?.length ? { ALMYTY_ALLOW_BINARIES: JSON.stringify(env.egress.allowBinaries) } : {}),
        // Coding CLIs reach models through almyty with the pod-scoped token
        // (Decision 6). A vendor key the environment binds itself (only
        // with allowVendorKeys) replaces the token for that vendor, and then
        // that vendor's CLI is not pointed at almyty either.
        ...modelBaseUrls(api.url, env),
      },
      secretEnv: {},
      quota: { maxConcurrentRunners: capacity.maxConcurrentRunners, maxWorkspaces: capacity.maxWorkspaces, podResources: { name: biggestName, ...biggest } },
      providerConfig: hr.providerConfig ?? {},
    };
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The variable names a vendor's CLI reads its key from. The pod-scoped
 * token goes into each (through the Secret), unless the environment binds
 * its own value there.
 */
export const MODEL_KEY_VARS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;

/** The pod-scoped model token, as the Secret carries it. */
export function modelTokenEnv(token: string | null): Record<string, string> {
  if (!token) return {};
  return { ALMYTY_MODEL_TOKEN: token, [MODEL_KEY_VARS.anthropic]: token, [MODEL_KEY_VARS.openai]: token };
}

/**
 * The plain variables that point coding CLIs at almyty's Anthropic- and
 * OpenAI-compatible endpoints. Not set for a vendor whose key variable
 * the environment binds itself: that CLI talks to its vendor directly.
 */
export function modelBaseUrls(apiUrl: string, env: Pick<Environment, 'envBindings'>): Record<string, string> {
  const bound = new Set((env.envBindings ?? []).map((b) => b.envVar));
  return {
    ...(bound.has(MODEL_KEY_VARS.anthropic) ? {} : { ANTHROPIC_BASE_URL: apiUrl }),
    ...(bound.has(MODEL_KEY_VARS.openai) ? {} : { OPENAI_BASE_URL: `${apiUrl}/v1` }),
  };
}

/** What the adapter saw, minus anything that is not a plain observation. */
function sanitize(actual: HostedActual): Record<string, any> {
  const { details, ...rest } = actual;
  const safe: Record<string, any> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (!/(token|secret|password|credential|key)/i.test(k)) safe[k] = v;
  }
  return { ...rest, ...(Object.keys(safe).length ? { details: safe } : {}) };
}
