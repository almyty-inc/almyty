import { randomUUID } from 'crypto';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { DataSource, In, IsNull, LessThan, Not, Repository } from 'typeorm';

import { Environment } from '../../entities/environment.entity';
import { HostedRunner, HostedRunnerDesired, HostedRunnerState } from '../../entities/hosted-runner.entity';
import { Runner, RunnerIsolationTier, RunnerState } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { Agent } from '../../entities/agent.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import {
  ExecutionAccessService,
  type ExecutionPrincipal,
} from '../../common/authorization/execution-access.service';
import { isUniqueViolation } from '../../common/utils/unique-violation';
import { canAcceptWork } from '../runner/runner-state';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';
import { HostedRunnerSettingsService } from './hosted-runner-settings';
import { WorkspaceLeaseService } from './workspace-lease.service';
import {
  CapacityExhaustedError,
  HOSTED_CAPACITY_PROVIDER,
  HostedCapacity,
  HostedCapacityProvider,
  SettingsCapacityProvider,
} from './hosted-capacity.provider';

export const HOSTED_RECONCILE_QUEUE = 'hosted-runner-reconcile';
export const HOSTED_RECONCILE_JOB = 'reconcile';

/** States after which a hosted runner is finished. */
export const TERMINAL_HOSTED_STATES: HostedRunnerState[] = ['torn_down', 'orphaned'];

/** The persistent-workspace key for runs with no agent of their own. */
const NO_AGENT = null;

/** Who a hosted dispatch is for: the run's principal, or a user id. */
export interface HostedCaller {
  organizationId: string;
  principal?: ExecutionPrincipal;
  callerUserId?: string | null;
  agentId?: string | null;
  /** The run the call belongs to; its job holds the workspace while it works there. */
  runId?: string | null;
  /** Stops a call that is waiting for the workspace. */
  signal?: AbortSignal;
}

/**
 * Where a call to an environment goes now. Ready carries the workspace
 * lease the call holds (give it back after the call when
 * `releaseAfterCall`); busy means another job is working in the workspace.
 */
export type HostedTarget =
  | { kind: 'ready'; runnerId: string; workspaceId: string; hostedRunnerId: string; lease?: { holder: string; releaseAfterCall: boolean } }
  | { kind: 'waking'; workspaceId: string; hostedRunnerId: string; retryAfterMs: number; message: string }
  | { kind: 'busy'; workspaceId: string; hostedRunnerId: string; retryAfterMs: number; message: string };

/** A call to an environment that cannot be served: say why, with the runner-call error code. */
export class HostedDispatchError extends Error {
  constructor(readonly code: 'workspace_unavailable' | 'workspace_required' | 'runner_not_found' | 'capacity_exhausted', message: string) {
    super(message);
    this.name = 'HostedDispatchError';
  }
}

/**
 * Desired state for hosted runners, and the persistent workspaces they
 * serve. Services write `desired` and enqueue; the reconcile processor is
 * the only thing that talks to a cluster (hosted-runners.processor.ts).
 *
 * A persistent workspace is one per (environment, owner, agent): runs of
 * a person share theirs; an agent acting as itself gets its own. It is
 * created suspended (nothing running), woken by the first call that needs
 * it, parked again after its idle timeout, and kept while suspended for
 * the retention window (settings: `suspendedRetention`), with a notice
 * before it goes.
 */
@Injectable()
export class HostedRunnersService {
  private readonly logger = new Logger(HostedRunnersService.name);
  private readonly capacity: HostedCapacityProvider;

  constructor(
    @InjectRepository(HostedRunner) private readonly hostedRunners: Repository<HostedRunner>,
    @InjectRepository(Environment) private readonly environments: Repository<Environment>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Runner) private readonly runners: Repository<Runner>,
    @InjectQueue(HOSTED_RECONCILE_QUEUE) private readonly queue: Queue,
    private readonly dataSource: DataSource,
    private readonly settings: HostedRunnerSettingsService,
    private readonly accessPolicy: AccessPolicyService,
    @Optional() @Inject(HOSTED_CAPACITY_PROVIDER) capacity?: HostedCapacityProvider,
    @Optional() private readonly executionAccess?: ExecutionAccessService,
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly leases?: WorkspaceLeaseService,
  ) {
    this.capacity = capacity ?? new SettingsCapacityProvider(settings);
  }

  enabled(): boolean {
    return this.settings.enabled();
  }

  capacityFor(organizationId: string): Promise<HostedCapacity> {
    return this.capacity.capacityFor(organizationId);
  }

  /** The adapter new hosted runners use: HOSTED_RUNNERS_PROVIDER, `kubernetes` unless set. */
  providerType(): string {
    return (process.env.HOSTED_RUNNERS_PROVIDER ?? '').trim() || 'kubernetes';
  }

  // ── dispatch ──────────────────────────────────────────────────────

  /**
   * Where a call to `environmentId` goes for this caller: the caller's
   * persistent workspace there (made on first use), woken if parked.
   * Ready means its runner is online and the call can be dispatched now;
   * waking means try again in `retryAfterMs`. A wake that has not come up
   * within the wake budget fails `workspace_unavailable`.
   */
  async resolveTarget(environmentId: string, caller: HostedCaller, now = new Date()): Promise<HostedTarget> {
    if (!this.enabled()) throw new HostedDispatchError('runner_not_found', 'Hosted environments are not enabled on this install');
    const { workspace, hostedRunner } = await this.workspaceFor(environmentId, caller);
    await this.touch(hostedRunner.id, workspace.id, now);
    const runner = hostedRunner.runnerId ? await this.runners.findOne({ where: { id: hostedRunner.runnerId } }) : null;
    if (
      workspace.status === WorkspaceStatus.ACTIVE &&
      hostedRunner.state === 'ready' &&
      hostedRunner.desired.replicas === 1 &&
      runner &&
      canAcceptWork(runner.state)
    ) {
      // One folder, one job at a time: the call waits (within the queue's
      // wait) for another job of the same person to finish with it.
      if (!this.leases) return { kind: 'ready', runnerId: runner.id, workspaceId: workspace.id, hostedRunnerId: hostedRunner.id };
      const holder = await this.leases.holderFor(caller.runId ?? null);
      if (!(await this.leases.acquire(workspace.id, holder, caller.signal))) {
        return {
          kind: 'busy',
          workspaceId: workspace.id,
          hostedRunnerId: hostedRunner.id,
          retryAfterMs: this.settings.current.workspaceQueue.retryAfterSeconds * 1000,
          message: 'Another job is working in this workspace; this one runs after it. Try the call again shortly.',
        };
      }
      return {
        kind: 'ready',
        runnerId: runner.id,
        workspaceId: workspace.id,
        hostedRunnerId: hostedRunner.id,
        lease: { holder: holder.holder, releaseAfterCall: !holder.job },
      };
    }
    if (hostedRunner.state === 'failed') {
      throw new HostedDispatchError('workspace_unavailable', `The machine for this environment failed to start: ${hostedRunner.lastError ?? 'see the environment page'}`);
    }
    const woken = await this.ensureAwake(hostedRunner, now);
    const since = woken.desired.wakeRequestedAt ? new Date(woken.desired.wakeRequestedAt).getTime() : now.getTime();
    const budgetMs = this.settings.current.wake.budgetSeconds * 1000;
    if (now.getTime() - since > budgetMs) {
      throw new HostedDispatchError('workspace_unavailable', `The machine for this environment did not start within ${this.settings.current.wake.budgetSeconds} seconds`);
    }
    return {
      kind: 'waking',
      workspaceId: workspace.id,
      hostedRunnerId: hostedRunner.id,
      retryAfterMs: this.settings.current.wake.retryAfterSeconds * 1000,
      message: 'The machine for this environment is starting; try the call again shortly.',
    };
  }

  /** Whose workspace a call works in, and which agent key it is filed under. */
  ownerOf(caller: HostedCaller): { ownerUserId: string; agentId: string | null } {
    const p = caller.principal;
    if (p?.kind === 'user' && p.userId) return { ownerUserId: p.userId, agentId: NO_AGENT };
    if (p?.kind === 'agent') {
      if (p.ownerUserId) return { ownerUserId: p.ownerUserId, agentId: p.agentId };
      throw new HostedDispatchError('workspace_required', 'This agent acts as itself and has no recorded owner to hold its workspace');
    }
    if (p?.kind === 'gateway') {
      if (p.visibility !== 'org' && p.ownerUserId) return { ownerUserId: p.ownerUserId, agentId: NO_AGENT };
      throw new HostedDispatchError('workspace_required', 'This run came through an org-wide gateway; a hosted workspace belongs to one person');
    }
    if (!p && caller.callerUserId) return { ownerUserId: caller.callerUserId, agentId: NO_AGENT };
    throw new HostedDispatchError('workspace_required', 'A run with no user cannot be given a hosted workspace');
  }

  /** May this caller use the environment? Same rules as a runner: the access policy, or the run's scope. */
  private async mayUse(env: Environment, caller: HostedCaller): Promise<boolean> {
    const p = caller.principal;
    if (p && p.kind !== 'user') {
      const decision = this.executionAccess ? await this.executionAccess.canExecute(p, env) : null;
      return decision?.allowed ?? false;
    }
    const userId = p?.kind === 'user' ? p.userId : caller.callerUserId;
    if (!userId) return false;
    return (await this.accessPolicy.canAccess({ id: userId }, env, 'use')).allowed;
  }

  /** The caller's live persistent workspace on an environment, made (suspended) if there is none. */
  async workspaceFor(environmentId: string, caller: HostedCaller): Promise<{ workspace: Workspace; hostedRunner: HostedRunner; environment: Environment }> {
    const env = await this.environments.findOne({ where: { id: environmentId, organizationId: caller.organizationId } });
    if (!env || !(await this.mayUse(env, caller))) throw new HostedDispatchError('runner_not_found', 'environment not found');
    const owner = this.ownerOf(caller);
    const existing = await this.liveWorkspace(env.id, owner.ownerUserId, owner.agentId);
    if (existing) {
      const hr = await this.hostedRunners.findOne({ where: { workspaceId: existing.id, state: Not(In(TERMINAL_HOSTED_STATES)) } });
      if (hr) return { workspace: existing, hostedRunner: hr, environment: env };
    }
    const capacity = await this.capacity.capacityFor(env.organizationId);
    const live = await this.workspaces.count({
      where: { organizationId: env.organizationId, kind: 'persistent', status: In([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]) },
    });
    if (live >= capacity.maxWorkspaces) {
      throw new HostedDispatchError('capacity_exhausted', `This organization already keeps ${live} hosted workspaces, its limit; release one first`);
    }
    try {
      return { ...(await this.createPersistent(env, owner.ownerUserId, owner.agentId)), environment: env };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another call made it first.
      const winner = await this.liveWorkspace(env.id, owner.ownerUserId, owner.agentId);
      const hr = winner ? await this.hostedRunners.findOne({ where: { workspaceId: winner.id, state: Not(In(TERMINAL_HOSTED_STATES)) } }) : null;
      if (winner && hr) return { workspace: winner, hostedRunner: hr, environment: env };
      throw err;
    }
  }

  private liveWorkspace(environmentId: string, ownerUserId: string, agentId: string | null): Promise<Workspace | null> {
    return this.workspaces.findOne({
      where: {
        environmentId,
        ownerUserId,
        agentId: agentId ?? IsNull(),
        kind: 'persistent',
        status: In([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]),
      },
    });
  }

  /** Runner, workspace and hosted runner rows, together. Nothing starts until something wakes it. */
  private async createPersistent(env: Environment, ownerUserId: string, agentId: string | null): Promise<{ workspace: Workspace; hostedRunner: HostedRunner }> {
    const hostedRunnerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date();
    return this.dataSource.transaction(async (manager) => {
      await manager.getRepository(Runner).insert({
        id: runnerId,
        name: hostedRunnerName(env.name, workspaceId),
        ownerUserId,
        organizationId: env.organizationId,
        visibility: 'private',
        teamId: null,
        kind: 'hosted',
        hostedRunnerId,
        state: RunnerState.REGISTERED,
        labels: {},
        runtimeInfo: null,
        config: null,
        lastHeartbeatAt: null,
      });
      await manager.getRepository(Workspace).insert({
        id: workspaceId,
        runnerId,
        ownerUserId,
        organizationId: env.organizationId,
        cwd: this.settings.current.cluster.workspaceMountPath,
        isolation: RunnerIsolationTier.HOST,
        ttlAt: null,
        status: WorkspaceStatus.SUSPENDED,
        closeReason: null,
        closedAt: null,
        name: null,
        agentId,
        runId: null,
        kind: 'persistent',
        environmentId: env.id,
        volumeRef: null,
        lastActiveAt: now,
        expiryNoticeAt: null,
      });
      await manager.getRepository(HostedRunner).insert({
        id: hostedRunnerId,
        organizationId: env.organizationId,
        environmentId: env.id,
        environmentVersion: env.version,
        workspaceId,
        runnerId,
        providerType: this.providerType(),
        desired: { replicas: 0, resourceClass: env.resourceClass },
        providerConfig: {},
        externalRef: null,
        actual: null,
        state: 'pending',
        lastActiveAt: now,
        lastReconcileAt: null,
        lastError: null,
        createdBy: ownerUserId,
      });
      const workspace = await manager.getRepository(Workspace).findOneOrFail({ where: { id: workspaceId } });
      const hostedRunner = await manager.getRepository(HostedRunner).findOneOrFail({ where: { id: hostedRunnerId } });
      return { workspace, hostedRunner };
    }).then((made) => {
      this.audit(made.hostedRunner, AuditAction.HOSTED_RUNNER_TRANSITION, ownerUserId, { from: null, to: 'pending', workspaceId });
      void this.enqueue(made.hostedRunner.id);
      return made;
    });
  }

  /**
   * Ask for the pod. Refused when the organization already runs as many
   * hosted runners as its capacity allows.
   */
  async ensureAwake(hr: HostedRunner, now = new Date()): Promise<HostedRunner> {
    if (hr.desired.replicas === 1) {
      await this.enqueue(hr.id);
      return hr;
    }
    const capacity = await this.capacity.capacityFor(hr.organizationId);
    const running = await this.hostedRunners
      .createQueryBuilder('h')
      .where('h."organizationId" = :org', { org: hr.organizationId })
      .andWhere('h.id <> :id', { id: hr.id })
      .andWhere(`(h.desired->>'replicas')::int = 1`)
      .andWhere('h.state NOT IN (:...terminal)', { terminal: TERMINAL_HOSTED_STATES })
      .getCount();
    if (running >= capacity.maxConcurrentRunners) {
      throw new CapacityExhaustedError(`This organization already runs ${running} hosted machines at once, its limit`);
    }
    const desired: HostedRunnerDesired = { ...hr.desired, replicas: 1, wakeRequestedAt: now.toISOString() };
    await this.writeDesired(hr.id, desired, { lastActiveAt: now });
    hr.desired = desired;
    this.audit(hr, AuditAction.HOSTED_RUNNER_TRANSITION, null, { desiredReplicas: 1, reason: 'wake' });
    await this.enqueue(hr.id);
    return hr;
  }

  /** A dispatch, a coding session or a viewer used the workspace: the idle clock restarts. */
  async touch(hostedRunnerId: string, workspaceId: string | null, now = new Date()): Promise<void> {
    await this.hostedRunners.update({ id: hostedRunnerId }, { lastActiveAt: now });
    if (workspaceId) await this.workspaces.update({ id: workspaceId }, { lastActiveAt: now });
  }

  /** Touch by runner id, for callers that only know the runner (a dispatch). */
  async touchRunner(runnerId: string, now = new Date()): Promise<void> {
    const hr = await this.hostedRunners.findOne({ where: { runnerId, state: Not(In(TERMINAL_HOSTED_STATES)) }, select: { id: true, workspaceId: true } });
    if (hr) await this.touch(hr.id, hr.workspaceId, now);
  }

  /** A lone call returned: the workspace is free for the next job. */
  async releaseLease(workspaceId: string, holder: string): Promise<void> {
    await this.leases?.release(workspaceId, holder);
  }

  // ── sweeps (called from the reconcile processor's sweep) ─────────

  /**
   * Running hosted runners idle past their environment's timeout are
   * asked to scale to zero. The idle clock is `lastActiveAt`, moved by
   * every dispatch.
   */
  async suspendIdle(now = new Date()): Promise<string[]> {
    const awake = await this.hostedRunners
      .createQueryBuilder('h')
      .innerJoin(Environment, 'e', 'e.id = h."environmentId"')
      .where(`(h.desired->>'replicas')::int = 1`)
      .andWhere('h.state NOT IN (:...terminal)', { terminal: TERMINAL_HOSTED_STATES })
      .andWhere(`h."lastActiveAt" < :now::timestamptz - make_interval(mins => e."idleTimeoutMinutes")`, { now })
      .getMany();
    const suspended: string[] = [];
    for (const hr of awake) {
      const desired: HostedRunnerDesired = { ...hr.desired, replicas: 0, wakeRequestedAt: null };
      await this.writeDesired(hr.id, desired);
      this.audit(hr, AuditAction.HOSTED_RUNNER_TRANSITION, null, { desiredReplicas: 0, reason: 'idle' });
      await this.enqueue(hr.id);
      suspended.push(hr.id);
    }
    return suspended;
  }

  /**
   * Suspended workspaces nobody touched: a notice on the notice day, then
   * expired and their volume deleted on the last day. An always-on agent's
   * home (a persistent workspace of an agent that is on) is kept while the
   * agent is on.
   */
  async sweepSuspended(now = new Date()): Promise<{ noticed: number; expired: number }> {
    const { keepDays, noticeDay } = this.settings.current.suspendedRetention;
    const day = this.settings.minutes(24 * 60);
    const noticeBefore = new Date(now.getTime() - noticeDay * day);
    const expireBefore = new Date(now.getTime() - keepDays * day);
    const stale = await this.workspaces.find({
      where: { kind: 'persistent', status: WorkspaceStatus.SUSPENDED, lastActiveAt: LessThan(noticeBefore) },
    });
    let noticed = 0;
    let expired = 0;
    for (const ws of stale) {
      if (await this.isAlwaysOnHome(ws)) continue;
      if (ws.lastActiveAt && ws.lastActiveAt < expireBefore) {
        if (await this.expireWorkspace(ws, now)) expired++;
        continue;
      }
      if (!ws.expiryNoticeAt) {
        const claimed = await this.workspaces.update({ id: ws.id, expiryNoticeAt: IsNull() }, { expiryNoticeAt: now });
        if (!claimed.affected) continue;
        noticed++;
        const goneOn = new Date((ws.lastActiveAt ?? now).getTime() + keepDays * day);
        void this.notifications
          ?.emit({
            type: 'environments.workspace_expiring',
            organizationId: ws.organizationId,
            userIds: [ws.ownerUserId],
            title: 'A hosted workspace will be deleted soon',
            body: `A hosted workspace nobody has used for ${noticeDay} days will be deleted on ${goneOn.toISOString().slice(0, 10)}. Use it before then to keep it.`,
            link: '/runners',
            email: { template: 'environments.workspace_expiring', params: { days: noticeDay, goneOn: goneOn.toISOString().slice(0, 10) } },
          } as any)
          .catch(() => undefined);
      }
    }
    return { noticed, expired };
  }

  private async isAlwaysOnHome(ws: Workspace): Promise<boolean> {
    if (!ws.agentId) return false;
    const agent = await this.workspaces.manager.getRepository(Agent).findOne({ where: { id: ws.agentId }, select: { id: true, alwaysOn: true } as any });
    return (agent as any)?.alwaysOn?.enabled === true;
  }

  /** Suspended -> expired, and its hosted runner torn down with the volume. Conditional, like every workspace transition. */
  private async expireWorkspace(ws: Workspace, now: Date): Promise<boolean> {
    const result = await this.workspaces.update(
      { id: ws.id, status: WorkspaceStatus.SUSPENDED },
      { status: WorkspaceStatus.EXPIRED, closedAt: now, closeReason: { kind: 'expired', detail: `suspended since ${ws.lastActiveAt?.toISOString() ?? ''}` } },
    );
    if (!result.affected) return false;
    await this.requestTeardownForWorkspace(ws.id, false);
    return true;
  }

  // ── owner actions ─────────────────────────────────────────────────

  /** A persistent workspace its owner may act on (or an org admin, through the environment). */
  async ownWorkspace(workspaceId: string, userId: string, organizationId: string): Promise<Workspace> {
    const ws = await this.workspaces.findOne({ where: { id: workspaceId, organizationId, kind: 'persistent' } });
    if (!ws) throw new NotFoundException('workspace not found');
    if (ws.ownerUserId === userId) return ws;
    const role = await this.accessPolicy.getOrgRole(userId, organizationId);
    if (role === 'owner' || role === 'admin') return ws;
    throw new NotFoundException('workspace not found');
  }

  /** Park it now: scale to zero, keep the volume. */
  async suspend(workspaceId: string, userId: string, organizationId: string): Promise<HostedRunner> {
    const ws = await this.ownWorkspace(workspaceId, userId, organizationId);
    const hr = await this.hostedRunners.findOne({ where: { workspaceId: ws.id, state: Not(In(TERMINAL_HOSTED_STATES)) } });
    if (!hr) throw new NotFoundException('workspace has no machine');
    if (hr.desired.replicas !== 0) {
      await this.writeDesired(hr.id, { ...hr.desired, replicas: 0, wakeRequestedAt: null });
      this.audit(hr, AuditAction.HOSTED_RUNNER_TRANSITION, userId, { desiredReplicas: 0, reason: 'owner' });
    }
    await this.enqueue(hr.id);
    return (await this.hostedRunners.findOne({ where: { id: hr.id } })) as HostedRunner;
  }

  /** Let it go: the workspace is released and its volume deleted. */
  async release(workspaceId: string, userId: string, organizationId: string): Promise<Workspace> {
    const ws = await this.ownWorkspace(workspaceId, userId, organizationId);
    const now = new Date();
    await this.workspaces.update(
      { id: ws.id, status: In([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]) },
      { status: WorkspaceStatus.RELEASED, closedAt: now, closeReason: { kind: 'released', detail: userId } },
    );
    await this.requestTeardownForWorkspace(ws.id, false, userId);
    return (await this.workspaces.findOne({ where: { id: ws.id } })) as Workspace;
  }

  /** Every machine of an environment goes, volumes included (the environment was deleted). */
  async teardownEnvironment(environmentId: string, userId: string | null): Promise<number> {
    const now = new Date();
    const live = await this.workspaces.find({
      where: { environmentId, kind: 'persistent', status: In([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]) },
    });
    for (const ws of live) {
      await this.workspaces.update(
        { id: ws.id, status: In([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]) },
        { status: WorkspaceStatus.RELEASED, closedAt: now, closeReason: { kind: 'released', detail: 'environment deleted' } },
      );
    }
    const runners = await this.hostedRunners.find({ where: { environmentId, state: Not(In(TERMINAL_HOSTED_STATES)) } });
    for (const hr of runners) await this.requestTeardown(hr, false, userId);
    return runners.length;
  }

  private async requestTeardownForWorkspace(workspaceId: string, keepVolume: boolean, userId: string | null = null): Promise<void> {
    const hr = await this.hostedRunners.findOne({ where: { workspaceId, state: Not(In(TERMINAL_HOSTED_STATES)) } });
    if (hr) await this.requestTeardown(hr, keepVolume, userId);
  }

  async requestTeardown(hr: HostedRunner, keepVolume: boolean, userId: string | null = null): Promise<void> {
    await this.writeDesired(hr.id, { ...hr.desired, replicas: 0, teardownRequested: true, keepVolume, wakeRequestedAt: null });
    this.audit(hr, AuditAction.HOSTED_RUNNER_TRANSITION, userId, { teardownRequested: true, keepVolume });
    await this.enqueue(hr.id);
  }

  // ── for the processor ─────────────────────────────────────────────

  /**
   * The cluster connection a hosted runner's adapter uses. The platform
   * pool's is HOSTED_RUNNERS_CLUSTER_CONNECTION (`<organizationId>/<connectionId>`,
   * a `kubernetes` connection in that organization's credential store);
   * an environment on the organization's own cluster (phase 4) is refused
   * at save. The stub adapter needs none.
   */
  async clusterCredentialsFor(hr: HostedRunner): Promise<Record<string, string | undefined>> {
    if (hr.providerType === 'stub') return {};
    const raw = (process.env.HOSTED_RUNNERS_CLUSTER_CONNECTION ?? '').trim();
    const [organizationId, connectionId] = raw.split('/');
    if (!organizationId || !connectionId) {
      throw Object.assign(new Error('HOSTED_RUNNERS_CLUSTER_CONNECTION is not set to <organizationId>/<connectionId>'), { code: 'CREDENTIAL_NOT_FOUND' });
    }
    if (!this.credentialRefs) throw Object.assign(new Error('the credential store is not available'), { code: 'CREDENTIAL_NOT_FOUND' });
    const resolved = await this.credentialRefs.resolve(organizationId, connectionId, {
      principal: null,
      context: { purpose: 'hosted_runner_provision', resourceType: 'hosted_runner', resourceId: hr.id },
    });
    if (resolved.credential.connectorKey && resolved.credential.connectorKey !== 'kubernetes') {
      throw Object.assign(new Error('HOSTED_RUNNERS_CLUSTER_CONNECTION does not name a kubernetes connection'), { code: 'CREDENTIAL_INVALID' });
    }
    return resolved.config as Record<string, string | undefined>;
  }

  /**
   * The environment's connection-backed variables, resolved for the pod's
   * Secret as the workspace's owner (whose connections they must be able
   * to use). Every resolve is audited by the credential store. A repo
   * connection becomes ALMYTY_GIT_TOKEN.
   */
  async resolveSecretEnv(env: Environment, ws: Workspace): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (!this.credentialRefs) return out;
    // Checked again at every start: the setting may have been turned off
    // since the binding was saved.
    await this.assertNoVendorKeys(env);
    // As the workspace's owner, whose connections these must be.
    const owner = { id: ws.ownerUserId };
    const context = { purpose: 'hosted_runner_env', resourceType: 'environment', resourceId: env.id };
    for (const binding of env.envBindings ?? []) {
      const resolved = await this.credentialRefs.resolve(env.organizationId, binding.connectionId, { principal: owner, context });
      const value = resolved.config?.[binding.field];
      if (typeof value !== 'string' || value.length === 0) {
        throw Object.assign(new Error(`connection ${binding.connectionId} has no field ${binding.field}`), { code: 'CREDENTIAL_INVALID' });
      }
      out[binding.envVar] = value;
    }
    if (env.repo?.connectionId) {
      const resolved = await this.credentialRefs.resolve(env.organizationId, env.repo.connectionId, { principal: owner, context });
      const s = resolved.secrets ?? {};
      const token = s.token ?? s.apiKey ?? s.accessToken ?? s.password ?? s.bearerToken;
      if (token) out.ALMYTY_GIT_TOKEN = token;
    }
    return out;
  }

  /**
   * Which of these connections hold a model provider's own key: one a
   * model provider of the organization uses (its inference or usage key),
   * or one made from a model vendor's connector. Binding such a key into a
   * pod is the vendor-key path of Decision 6, only for an environment that
   * allows it.
   */
  async vendorKeyConnections(organizationId: string, connectionIds: string[]): Promise<string[]> {
    const ids = [...new Set(connectionIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT c.id FROM credentials c
        WHERE c."organizationId" = $1 AND c.id = ANY($2::uuid[])
          AND (c."connectorKey" = ANY($3::text[])
               OR EXISTS (SELECT 1 FROM llm_providers p
                           WHERE p."organizationId" = $1 AND (p."credentialId" = c.id OR p."usageCredentialId" = c.id)))`,
      [organizationId, ids, Object.values(LlmProviderType)],
    );
    return rows.map((r) => r.id);
  }

  /** Refuse a model provider's key bound into an environment that does not allow vendor keys. */
  async assertNoVendorKeys(env: Pick<Environment, 'organizationId' | 'allowVendorKeys' | 'envBindings'>): Promise<void> {
    if (env.allowVendorKeys) return;
    const vendor = await this.vendorKeyConnections(env.organizationId, (env.envBindings ?? []).map((b) => b.connectionId));
    if (vendor.length) {
      throw Object.assign(
        new Error(
          `These connections hold a model provider's key, which this environment does not put into its pods: ${vendor.join(', ')}. ` +
            'Coding CLIs reach models through almyty with the pod token; turn on "allow vendor keys" only for a CLI that cannot change its base URL.',
        ),
        { code: 'VENDOR_KEY_NOT_ALLOWED', connectionIds: vendor },
      );
    }
  }

  /** Services own `desired`; this is their one write of it. */
  private async writeDesired(id: string, desired: HostedRunnerDesired, extra: Partial<Pick<HostedRunner, 'lastActiveAt'>> = {}): Promise<void> {
    await this.hostedRunners.update({ id }, { desired, ...extra });
  }

  async enqueue(hostedRunnerId: string): Promise<void> {
    try {
      await this.queue.add(HOSTED_RECONCILE_JOB, { hostedRunnerId }, { jobId: `hr-reconcile-${hostedRunnerId}-${Date.now()}`, removeOnComplete: true, removeOnFail: true });
    } catch (err: any) {
      // The sweep picks it up; a queue hiccup must not fail the call.
      this.logger.warn(`Could not enqueue hosted runner reconcile for ${hostedRunnerId}: ${err?.message ?? err}`);
    }
  }

  audit(hr: Pick<HostedRunner, 'id' | 'organizationId' | 'environmentId' | 'state'>, action: AuditAction, userId: string | null | undefined, details: Record<string, any>): void {
    void this.auditLog
      ?.log({
        organizationId: hr.organizationId,
        userId: userId ?? undefined,
        action,
        resourceType: AuditResource.HOSTED_RUNNER,
        resourceId: hr.id,
        details: { state: hr.state, environmentId: hr.environmentId, ...details },
      })
      .catch(() => undefined);
  }

  /** Who may see an environment's hosted runners: anyone who may read the environment. */
  async assertReadableEnvironment(environmentId: string, userId: string, organizationId: string): Promise<Environment> {
    const env = await this.environments.findOne({ where: { id: environmentId, organizationId } });
    if (!env || !(await this.accessPolicy.canAccess({ id: userId }, env, 'read')).allowed) throw new NotFoundException('environment not found');
    return env;
  }

  /** The persistent workspaces of an environment the caller may see: their own; all of them for an org admin. */
  async listWorkspaces(environmentId: string, userId: string, organizationId: string): Promise<Array<Workspace & { machine: Pick<HostedRunner, 'id' | 'state' | 'lastActiveAt' | 'lastError'> | null }>> {
    await this.assertReadableEnvironment(environmentId, userId, organizationId);
    const role = await this.accessPolicy.getOrgRole(userId, organizationId);
    const admin = role === 'owner' || role === 'admin';
    const rows = await this.workspaces.find({
      where: { environmentId, organizationId, kind: 'persistent', ...(admin ? {} : { ownerUserId: userId }) },
      order: { createdAt: 'DESC' },
    });
    const machines = rows.length
      ? await this.hostedRunners.find({ where: { workspaceId: In(rows.map((w) => w.id)) }, order: { createdAt: 'DESC' } })
      : [];
    return rows.map((w) => {
      const m = machines.find((h) => h.workspaceId === w.id);
      return Object.assign(w, { machine: m ? { id: m.id, state: m.state, lastActiveAt: m.lastActiveAt, lastError: m.lastError } : null });
    });
  }

  refuseWhenDisabled(): void {
    if (!this.enabled()) throw new ForbiddenException({ code: 'HOSTED_RUNNERS_DISABLED', message: 'Hosted environments are not enabled on this install' });
  }
}

/** `env-<environment>-<first 8 of the workspace id>`, unique in the organization and never renamed. */
export function hostedRunnerName(environmentName: string, workspaceId: string): string {
  const env = environmentName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const suffix = workspaceId.replace(/-/g, '').slice(0, 8);
  const room = 64 - 'env--'.length - suffix.length;
  return `env-${env.slice(0, room)}-${suffix}`;
}
