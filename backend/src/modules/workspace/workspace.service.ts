import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, EntityManager } from 'typeorm';

import { Runner, RunnerIsolationTier, RunnerState } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { canAcceptWork } from '../runner/runner-state';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateWorkspaceInput {
  cwd: string;
  isolation?: RunnerIsolationTier;
  /** Time-to-live in milliseconds. Default 1 hour, max 24 hours. */
  ttlMs?: number;
  /**
   * Optional explicit runner id. v1.0 ignores this beyond verifying
   * ownership; the user's single registered runner is always picked.
   * The field exists so call sites can pass it forward when v1.x
   * scheduler logic ships.
   */
  runnerId?: string;
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    @InjectRepository(Workspace)
    private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Runner)
    private readonly runners: Repository<Runner>,
  ) {}

  /**
   * Create a workspace pinned to a runner. The runner must be in a
   * dispatch-accepting state (online or busy); REGISTERED, STALE,
   * DRAINING, OFFLINE all refuse.
   *
   * Validation against the runner's config (allowedCwdRoots, deny
   * patterns, isolation availability) lives on the runner: the
   * backend stores the cwd verbatim and the runner enforces on
   * receipt. Putting the policy on the runner means a single runner
   * config edit retroactively applies; doing it here would make the
   * rule live in two places and drift.
   */
  async create(
    input: CreateWorkspaceInput,
    ownerUserId: string,
    organizationId: string,
  ): Promise<Workspace> {
    if (!input.cwd || typeof input.cwd !== 'string') {
      throw new BadRequestException('cwd is required');
    }
    const runner = await this.pickRunner(ownerUserId, organizationId, input.runnerId);
    if (!canAcceptWork(runner.state)) {
      throw new ConflictException(`runner ${runner.name} is ${runner.state}; cannot create workspace`);
    }

    const isolation = input.isolation
      ?? runner.config?.defaultIsolation
      ?? RunnerIsolationTier.CONTAINER;
    const ttlMs = clampTtl(input.ttlMs);
    const ttlAt = ttlMs > 0 ? new Date(Date.now() + ttlMs) : null;

    const ws = this.workspaces.create({
      runnerId: runner.id,
      ownerUserId,
      organizationId,
      cwd: input.cwd,
      isolation,
      ttlAt,
      status: WorkspaceStatus.ACTIVE,
    });
    return this.workspaces.save(ws);
  }

  /**
   * Look up a workspace, verifying it belongs to the caller's
   * (user, org). Used by every dispatch path before routing.
   */
  async getOne(
    id: string,
    ownerUserId: string,
    organizationId: string,
  ): Promise<Workspace> {
    const ws = await this.workspaces.findOne({
      where: { id, ownerUserId, organizationId },
    });
    if (!ws) throw new NotFoundException('workspace not found');
    return ws;
  }

  /**
   * Mark a workspace released. Idempotent: calling release on an
   * already-terminal workspace is a no-op and returns the existing row.
   * This only updates the DB record; the workspace's processes on the
   * runner are killed by the next heartbeat, which is answered with
   * `listActiveForRunner` and no longer contains this workspace. There
   * is no release message to the runner on purpose — see
   * `RunnerCallService.ackHeartbeat`.
   *
   * The transition is conditional on the row still being ACTIVE, so a
   * release that races the TTL sweep or the stranding fan-out loses
   * cleanly instead of overwriting the terminal state and `closeReason`
   * the other one committed. A plain save() of the loaded row wrote its
   * own view of every column back, so whichever of the three finished
   * last decided what the record said had happened — and a lost
   * `stranded` is the one that matters, because that state exists to
   * tell the user their work was on a machine that went away.
   */
  async release(
    id: string,
    ownerUserId: string,
    organizationId: string,
  ): Promise<Workspace> {
    const ws = await this.getOne(id, ownerUserId, organizationId);
    if (ws.status !== WorkspaceStatus.ACTIVE) return ws;

    const claimed = await this.transitionFromActive(ws.id, WorkspaceStatus.RELEASED, {
      closedAt: new Date(),
      closeReason: { kind: 'released', detail: ownerUserId },
    });
    if (!claimed) {
      // Something else reached a terminal state first; report what the
      // row actually says rather than what this call intended.
      return this.getOne(id, ownerUserId, organizationId);
    }
    return this.getOne(id, ownerUserId, organizationId);
  }

  /**
   * The workspaces a runner is still allowed to be running processes
   * for. `RunnerCallService.ackHeartbeat` answers every heartbeat with
   * this set and the runner kills everything outside it, so membership
   * here is a kill decision on someone's own machine.
   *
   * ACTIVE only. `released`, `expired` and `stranded` are the three
   * terminal states and all three mean "nothing should still be running
   * for this workspace" — a terminal row that leaked into this list
   * would keep its processes alive indefinitely.
   */
  async listActiveForRunner(runnerId: string): Promise<Workspace[]> {
    return this.workspaces.find({
      where: { runnerId, status: WorkspaceStatus.ACTIVE },
    });
  }

  async listForOwner(ownerUserId: string, organizationId: string): Promise<Workspace[]> {
    return this.workspaces.find({
      where: { ownerUserId, organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Sweep TTL-expired active workspaces. The expiry job calls this
   * periodically. Nothing is dispatched to the runner here: an expired
   * workspace simply stops appearing in `listActiveForRunner`, and the
   * runner's next heartbeat ack reclaims its processes.
   *
   * Each flip is conditional on the row still being ACTIVE, and only
   * the rows this sweep actually claimed come back — a workspace the
   * owner released, or the stranding fan-out took, in the window
   * between the SELECT and the write stays theirs, and the caller is
   * not told this sweep expired something it did not.
   */
  async sweepExpired(now = new Date()): Promise<Workspace[]> {
    const candidates = await this.workspaces.find({
      where: {
        status: WorkspaceStatus.ACTIVE,
        ttlAt: LessThanOrEqual(now),
      },
    });
    const expired: Workspace[] = [];
    for (const ws of candidates) {
      const claimed = await this.transitionFromActive(ws.id, WorkspaceStatus.EXPIRED, {
        closedAt: now,
        closeReason: { kind: 'expired', detail: ws.ttlAt?.toISOString() ?? '' },
      });
      if (!claimed) continue;
      ws.status = WorkspaceStatus.EXPIRED;
      ws.closedAt = now;
      ws.closeReason = { kind: 'expired', detail: ws.ttlAt?.toISOString() ?? '' };
      expired.push(ws);
    }
    if (expired.length > 0) {
      this.logger.log(`expired ${expired.length} workspace(s)`);
    }
    return expired;
  }

  /**
   * Strand all active workspaces pinned to a runner. Called when the
   * runner transitions to OFFLINE. The data model deliberately makes
   * stranded a one-way state: there is no migration to a different
   * runner in v1.0, and even when the runner comes back, the original
   * workspaces stay stranded so the user can audit what was lost.
   *
   * One conditional UPDATE, so the count returned is the number of
   * workspaces this call actually stranded. `manager` lets the caller
   * run the fan-out inside the same transaction as the runner's flip to
   * OFFLINE: without that, a pod dying between the two writes left the
   * runner offline and its workspaces ACTIVE forever.
   */
  async markStrandedForRunners(runnerIds: string[], manager?: EntityManager): Promise<number> {
    if (runnerIds.length === 0) return 0;
    const repo = manager ? manager.getRepository(Workspace) : this.workspaces;
    const now = new Date();
    const result = await repo
      .createQueryBuilder()
      .update(Workspace)
      .set({
        status: WorkspaceStatus.STRANDED,
        closedAt: now,
        closeReason: () => `json_build_object('kind', 'stranded', 'detail', "runnerId")`,
      })
      .where('"runnerId" IN (:...runnerIds)', { runnerIds })
      .andWhere('status = :active', { active: WorkspaceStatus.ACTIVE })
      .execute();
    const stranded = result.affected ?? 0;
    if (stranded > 0) {
      this.logger.warn(`stranded ${stranded} workspace(s) across ${runnerIds.length} runner(s)`);
    }
    return stranded;
  }

  /**
   * Move one workspace out of ACTIVE into a terminal state, but only if
   * it is still ACTIVE. Returns false when someone else got there
   * first, which is the whole point: terminal states are one-way, and
   * whichever transition committed first is the true story of what
   * happened to that workspace.
   */
  private async transitionFromActive(
    id: string,
    to: WorkspaceStatus,
    fields: { closedAt: Date; closeReason: Workspace['closeReason'] },
  ): Promise<boolean> {
    const result = await this.workspaces.update(
      { id, status: WorkspaceStatus.ACTIVE },
      { status: to, closedAt: fields.closedAt, closeReason: fields.closeReason },
    );
    return (result.affected ?? 0) > 0;
  }

  // ── internals ───────────────────────────────────────────────────────

  private async pickRunner(
    ownerUserId: string,
    organizationId: string,
    requestedId?: string,
  ): Promise<Runner> {
    if (requestedId) {
      const runner = await this.runners.findOne({
        where: { id: requestedId, ownerUserId, organizationId },
      });
      if (!runner) throw new NotFoundException('runner not found');
      return runner;
    }
    const owned = await this.runners.find({ where: { ownerUserId, organizationId } });
    if (owned.length === 0) {
      throw new NotFoundException(
        'no runner registered; run `almyty runner start` on the target machine first',
      );
    }
    if (owned.length > 1) {
      // Defensive: the registration path enforces single-runner-per-
      // account, but if a future migration relaxes that without
      // updating this picker, fail loudly rather than picking one.
      throw new ConflictException(
        'multiple runners present but no scheduler in v1.0; supply runnerId',
      );
    }
    return owned[0];
  }
}

function clampTtl(ttlMs?: number): number {
  if (ttlMs === undefined || ttlMs === null) return DEFAULT_TTL_MS;
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new BadRequestException('ttlMs must be a non-negative number');
  }
  return Math.min(ttlMs, MAX_TTL_MS);
}
