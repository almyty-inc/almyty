import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, EntityManager, In } from 'typeorm';

import { Runner, RunnerIsolationTier } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { Agent } from '../../entities/agent.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { ENDED_RUN_STATUSES, releaseRunWorkspaces } from './run-end-release';
import { canAcceptWork } from '../runner/runner-state';
import { RunnerService } from '../runner/runner.service';
import {
  type LabelRequirements,
  describeLabelRequirements,
  hasLabelRequirements,
  labelsMatch,
  parseLabelRequirements,
} from '../runner/runner-labels';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import type { ExecutionPrincipal, GatewayPrincipal } from '../../common/authorization/execution-access.service';

export const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Workspace ids are uuids; anything else is answered "no" before it reaches Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateWorkspaceInput {
  cwd: string;
  isolation?: RunnerIsolationTier;
  /** Time-to-live in milliseconds. Default 1 hour, max 24 hours. */
  ttlMs?: number;
  /**
   * Optional explicit runner id: one of the caller's own runners.
   */
  runnerId?: string;
  /**
   * Label requirements for the machine (`gpu=yes, os=mac` or an object).
   * Without a runnerId the workspace goes on an online runner the caller
   * may use whose labels include all of them.
   */
  labels?: Record<string, string> | string;
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    @InjectRepository(Workspace)
    private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Runner)
    private readonly runners: Repository<Runner>,
    // Team membership for a team gateway's dispatch (findForDispatch).
    // Optional only for hand-built specs; without it a team gateway is
    // covered by no workspace (fail closed).
    @Optional() private readonly accessPolicy?: AccessPolicyService,
    // Label routing for a workspace created with label requirements.
    // forwardRef: RunnerModule and WorkspaceModule import each other.
    // Optional only for hand-built specs; without it such a create is refused.
    @Optional() @Inject(forwardRef(() => RunnerService)) private readonly runnerService?: RunnerService,
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
    const runner = await this.pickRunner(ownerUserId, organizationId, input.runnerId, parseLabelRequirements(input.labels));
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
   * Look up a workspace the caller may see: their own, or one on a runner
   * they oversee (listForOwner). The workspace routes' lookup, for reading
   * and for release; anything else is "not found", so the answer does not
   * say whose workspaces exist. Dispatch asks findForDispatch, which only
   * ever covers the caller's own.
   */
  async getOne(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<Workspace> {
    const ws = await this.workspaces.findOne({ where: { id, organizationId } });
    if (!ws) throw new NotFoundException('workspace not found');
    if (ws.ownerUserId === userId) return ws;
    const overseen = await this.overseenRunnerIds(userId, organizationId);
    if (!overseen.includes(ws.runnerId)) throw new NotFoundException('workspace not found');
    return ws;
  }

  /**
   * The workspace a dispatch names, if the caller may send work into it:
   * ACTIVE, pinned to the runner the work is going to, not past its TTL
   * (the sweep runs on a timer, so an expired row can still read ACTIVE for
   * a while), and one the caller's principal covers. Null otherwise --
   * including for a dispatch with no identified caller, since a workspace
   * is always somebody's.
   *
   * Who is covered, judged by the run's principal (a user id is a user):
   * - a user: their own workspaces, nobody else's.
   * - a gateway private to its owner: that owner's.
   * - a gateway scoped to a team: those of the team's current members --
   *   the team published the gateway, and its members' workspaces are what
   *   it may work in. Membership proper: an org admin who is not on the
   *   team is not covered, as the admin's own machine is not the team's.
   * - an org-wide gateway: none. It answers the whole organization (or
   *   whoever its auth admits), and a workspace is one person's.
   * - an agent acting as itself: only the workspaces made for that agent.
   *
   * RunnerCallService.dispatch asks this before any envelope leaves.
   */
  async findForDispatch(
    id: string,
    runnerId: string,
    caller: string | ExecutionPrincipal | null | undefined,
    now = new Date(),
  ): Promise<Workspace | null> {
    if (!caller || !UUID_RE.test(id ?? '')) return null;
    const principal: ExecutionPrincipal = typeof caller === 'string' ? { kind: 'user', userId: caller, source: 'session' } : caller;
    if (principal.kind === 'user') {
      if (!principal.userId) return null;
      return this.liveWorkspace({ id, runnerId, ownerUserId: principal.userId }, now);
    }
    const ws = await this.liveWorkspace({ id, runnerId, organizationId: principal.organizationId }, now);
    if (!ws) return null;
    // An agent acting as itself works only in the workspaces made for it.
    if (principal.kind === 'agent') return ws.agentId === principal.agentId ? ws : null;
    return (await this.gatewayCovers(principal, ws)) ? ws : null;
  }

  private async liveWorkspace(where: Partial<Pick<Workspace, 'id' | 'runnerId' | 'ownerUserId' | 'organizationId'>>, now: Date): Promise<Workspace | null> {
    const ws = await this.workspaces.findOne({ where: { ...where, status: WorkspaceStatus.ACTIVE } });
    if (!ws) return null;
    if (ws.ttlAt && ws.ttlAt.getTime() <= now.getTime()) return null;
    return ws;
  }

  /** Does a gateway's scope cover the owner of `ws`? See findForDispatch. */
  private async gatewayCovers(gateway: GatewayPrincipal, ws: Workspace): Promise<boolean> {
    if (ws.organizationId !== gateway.organizationId) return false;
    if (gateway.visibility === 'private') return !!gateway.ownerUserId && gateway.ownerUserId === ws.ownerUserId;
    if (gateway.visibility !== 'team' || !gateway.teamId || !this.accessPolicy) return false;
    if (!(await this.accessPolicy.getOrgRole(ws.ownerUserId, ws.organizationId))) return false;
    const teams = await this.accessPolicy.getTeamMemberships(ws.ownerUserId, ws.organizationId);
    return teams.has(gateway.teamId);
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

  /**
   * The workspaces the caller may see, newest first: their own, every one
   * on a runner they own (another member's agent run working on their
   * machine), and -- for an org owner or admin -- every one on the
   * organization's team and org-wide runners. A private runner's
   * workspaces stay its owner's, as the runner itself does. One an agent
   * run was given carries `agent: { id, name }` (name only, never the
   * agent's config) so the Workspaces tab can say which agent and run it
   * is for.
   */
  async listForOwner(userId: string, organizationId: string): Promise<Workspace[]> {
    const overseen = await this.overseenRunnerIds(userId, organizationId);
    const own = await this.workspaces.find({ where: { ownerUserId: userId, organizationId }, order: { createdAt: 'DESC' } });
    const onOverseen = overseen.length > 0
      ? await this.workspaces.find({ where: { organizationId, runnerId: In(overseen) }, order: { createdAt: 'DESC' } })
      : [];
    const byId = new Map<string, Workspace>();
    for (const w of [...own, ...onOverseen]) byId.set(w.id, w);
    const rows = [...byId.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return this.attachAgentNames(rows, organizationId);
  }

  /**
   * Runners whose every workspace this user may see and release: the ones
   * they own, and for an org owner or admin the organization's team and
   * org-wide runners (a private runner is its owner's alone, admins
   * included, as everywhere else).
   */
  private async overseenRunnerIds(userId: string, organizationId: string): Promise<string[]> {
    if (!userId) return [];
    const owned = await this.runners.find({ where: { ownerUserId: userId, organizationId }, select: { id: true } });
    const ids = new Set(owned.map((r) => r.id));
    const role = this.accessPolicy ? await this.accessPolicy.getOrgRole(userId, organizationId) : null;
    if (role === OrganizationRole.OWNER || role === OrganizationRole.ADMIN) {
      const shared = await this.runners.find({
        where: { organizationId, visibility: In(['team', 'org']) },
        select: { id: true },
      });
      for (const r of shared) ids.add(r.id);
    }
    return [...ids];
  }

  async attachAgentNames(rows: Workspace[], organizationId: string): Promise<Workspace[]> {
    const ids = [...new Set(rows.map((w) => w.agentId).filter((id): id is string => !!id))];
    if (ids.length === 0) return rows;
    const agents = await this.workspaces.manager.getRepository(Agent).find({
      where: { id: In(ids), organizationId },
      select: { id: true, name: true },
    });
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const w of rows) {
      const agent = w.agentId ? byId.get(w.agentId) : undefined;
      if (agent) w.agent = { id: agent.id, name: agent.name } as Agent;
    }
    return rows;
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
   * The safety net for releasing a finished job's workspaces. A run's end
   * releases them directly (releaseRunWorkspaces), but a run can also end
   * where nothing calls that: the run reaper, a collaboration step, a
   * queue failure written by another path. The workspace tick asks this
   * every beat, with the same rule: a workspace is released once the run
   * it was given to has ended and -- for an autonomous run -- no run of its
   * job (any descendant down the parentRunId chain) is still going.
   */
  async releaseForEndedRuns(now = new Date()): Promise<number> {
    const active = (await this.workspaces.find({ where: { status: WorkspaceStatus.ACTIVE } })).filter((w) => !!w.runId);
    if (active.length === 0) return 0;
    const runIds = [...new Set(active.map((w) => w.runId as string))];
    const manager = this.workspaces.manager;
    const runs = manager.getRepository(AgentRun);
    let released = 0;

    const endedRuns = await runs.find({
      where: { id: In(runIds), status: In([...ENDED_RUN_STATUSES]) } as any,
      select: { id: true } as any,
    });
    // releaseRunWorkspaces checks the rest of the job before releasing.
    for (const r of endedRuns) released += await releaseRunWorkspaces(this.workspaces, r.id, runs, now);

    const endedExecutions = await manager.getRepository(AgentExecution).find({
      where: { id: In(runIds), status: In([...ENDED_RUN_STATUSES]) } as any,
      select: { id: true } as any,
    });
    for (const e of endedExecutions) released += await releaseRunWorkspaces(this.workspaces, e.id, null, now);

    if (released > 0) this.logger.log(`released ${released} workspace(s) of ended runs`);
    return released;
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

  /**
   * Which runner a new workspace goes on.
   *
   * - With label requirements and no runnerId: an online runner the
   *   caller may use whose labels include every one, which can be another
   *   member's org or team runner (RunnerService.resolveByLabels, the same
   *   rules as dispatch). None: "No machine with gpu=yes is online".
   * - With a runnerId: that runner of the caller's; with requirements too,
   *   it must carry them.
   * - Otherwise the caller's single runner.
   */
  private async pickRunner(
    ownerUserId: string,
    organizationId: string,
    requestedId?: string,
    required: LabelRequirements = {},
  ): Promise<Runner> {
    if (requestedId) {
      const runner = await this.runners.findOne({
        where: { id: requestedId, ownerUserId, organizationId },
      });
      if (!runner) throw new NotFoundException('runner not found');
      if (!labelsMatch(runner.labels, required)) {
        throw new BadRequestException(`${runner.name} does not have ${describeLabelRequirements(required)}`);
      }
      return runner;
    }
    if (hasLabelRequirements(required)) {
      if (!this.runnerService) throw new ConflictException('label routing is not available here');
      return this.runnerService.resolveByLabels(required, ownerUserId, organizationId);
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
