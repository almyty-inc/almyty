import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual } from 'typeorm';

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
   * already-terminal workspace is a no-op (returns the existing row).
   * The actual kill of workspace-scoped processes on the runner is
   * the caller's job; this service only updates the DB record.
   */
  async release(
    id: string,
    ownerUserId: string,
    organizationId: string,
  ): Promise<Workspace> {
    const ws = await this.getOne(id, ownerUserId, organizationId);
    if (ws.status !== WorkspaceStatus.ACTIVE) return ws;
    ws.status = WorkspaceStatus.RELEASED;
    ws.closedAt = new Date();
    ws.closeReason = { kind: 'released', detail: ownerUserId };
    return this.workspaces.save(ws);
  }

  /** List active workspaces for a runner. Used by the heartbeat path. */
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
   * periodically; runner-side cleanup of any processes the workspace
   * owned is the caller's responsibility (the routing layer hooks the
   * release envelope dispatch in).
   */
  async sweepExpired(now = new Date()): Promise<Workspace[]> {
    const expired = await this.workspaces.find({
      where: {
        status: WorkspaceStatus.ACTIVE,
        ttlAt: LessThanOrEqual(now),
      },
    });
    for (const ws of expired) {
      ws.status = WorkspaceStatus.EXPIRED;
      ws.closedAt = now;
      ws.closeReason = { kind: 'expired', detail: ws.ttlAt?.toISOString() ?? '' };
      await this.workspaces.save(ws);
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
   */
  async markStrandedForRunners(runnerIds: string[]): Promise<number> {
    if (runnerIds.length === 0) return 0;
    const active = await this.workspaces.find({
      where: { runnerId: In(runnerIds), status: WorkspaceStatus.ACTIVE },
    });
    const now = new Date();
    for (const ws of active) {
      ws.status = WorkspaceStatus.STRANDED;
      ws.closedAt = now;
      ws.closeReason = { kind: 'stranded', detail: ws.runnerId };
      await this.workspaces.save(ws);
    }
    if (active.length > 0) {
      this.logger.warn(`stranded ${active.length} workspace(s) across ${runnerIds.length} runner(s)`);
    }
    return active.length;
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
