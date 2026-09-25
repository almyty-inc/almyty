import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, EntityManager } from 'typeorm';

import { Runner, RunnerState, RunnerRuntimeInfo, RunnerConfig } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { canAcceptWork, nextState, RunnerSnapshot } from './runner-state';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';
import {
  AccessPolicyService,
  ResourceVisibility,
  normaliseVisibility,
} from '../../common/authorization/access-policy.service';
import { nameTaken } from '../../common/authorization/private-visibility';
import { assertManageable } from '../../common/authorization/read-rule';

/**
 * Runner ids are uuids. Checked before an id that arrived over the wire
 * reaches a query, because Postgres raises on a malformed uuid rather
 * than returning no rows, and a membership question should answer "no"
 * instead of throwing.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Input shape for POST /runners/register. The runner CLI sends this
 * once at daemon startup. Detected fields (runtimeInfo) come from the
 * runner's own probing; user fields (name, labels, config) come from
 * the runner's resolved config layering (defaults < global < project
 * < env < flags).
 *
 * Backend overrides happen at registration time and on subsequent
 * heartbeats: the response includes the effective config (which may
 * be more restrictive than what the runner sent), and the runner is
 * expected to honor the constraint. Backend never escalates.
 */
export interface RegisterRunnerInput {
  name: string;
  labels?: Record<string, string>;
  runtimeInfo: RunnerRuntimeInfo;
  config: RunnerConfig;
  // Visibility is normally chosen in the web UI when the runner record
  // is created (POST /runners) and left alone by the daemon, which does
  // not send it. When a caller does send it, it is honoured. The old
  // behaviour -- `visibility ?? 'org'` on every register -- silently
  // widened a runner back to org-wide each time its daemon restarted.
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

/**
 * Input shape for POST /runners: the record the web setup page creates
 * before the daemon has ever connected ("pending"). Holds everything
 * the user chose -- name, labels, visibility -- so the start command
 * only needs the name, and so an abandoned setup is a row the user can
 * see and delete rather than nothing at all.
 */
export interface CreateRunnerInput {
  name: string;
  labels?: Record<string, string>;
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

/** Input shape for PATCH /runners/:id. */
export interface UpdateRunnerInput {
  name?: string;
  labels?: Record<string, string>;
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

export interface RegisterRunnerResult {
  runner: Runner;
  /**
   * Effective config the runner must honor. Equals the requested config
   * for v1.0 (no backend overrides yet wired); the field exists so the
   * shape is forward-compatible with policy work.
   */
  effectiveConfig: RunnerConfig;
}

/**
 * A runner executes commands as its owner on its owner's machine, so a
 * runner nobody chose a visibility for is private.
 */
export const DEFAULT_RUNNER_VISIBILITY: ResourceVisibility = 'private';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** A runner that has never registered from a daemon: created by the setup page only. */
export function isPendingRunner(runner: Pick<Runner, 'runtimeInfo' | 'lastHeartbeatAt'>): boolean {
  return runner.runtimeInfo == null && runner.lastHeartbeatAt == null;
}

@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);

  constructor(
    @InjectRepository(Runner)
    private readonly runners: Repository<Runner>,
    @InjectRepository(RunnerSession)
    private readonly sessions: Repository<RunnerSession>,
    @InjectRepository(Workspace)
    private readonly workspaces: Repository<Workspace>,
    private readonly capabilities: RunnerCapabilityPublisher,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  /**
   * Create the runner record from the web setup page, before any daemon
   * has connected. Idempotent for the caller's own runner of the same
   * name (re-running setup updates labels/visibility in place).
   *
   * Refused with 409 when the caller already has a runner under another
   * name (the v1.0 single-runner cap, see register) or when another
   * member of the organization already uses the name.
   */
  async create(input: CreateRunnerInput, ownerUserId: string, organizationId: string): Promise<Runner> {
    this.assertName(input.name);
    const existing = await this.runners.findOne({ where: { ownerUserId, organizationId } });
    if (existing && existing.name !== input.name) {
      throw new ConflictException(
        `single runner per account in v1.0; delete your existing runner '${existing.name}' first`,
      );
    }
    await this.assertNameFreeInOrganization(input.name, ownerUserId, organizationId);

    const scope = normaliseVisibility(input.visibility ?? DEFAULT_RUNNER_VISIBILITY, input.teamId);
    await this.accessPolicy.assertCanScopeToTeam(ownerUserId, organizationId, scope.visibility, scope.teamId);

    const target: Runner = existing ?? this.runners.create({
      name: input.name,
      ownerUserId,
      organizationId,
      state: RunnerState.REGISTERED,
      runtimeInfo: null,
      config: null,
      lastHeartbeatAt: null,
    });
    target.labels = input.labels ?? existing?.labels ?? {};
    target.visibility = scope.visibility;
    target.teamId = scope.teamId;
    const saved = await this.runners.save(target);

    // A connected runner already has published tools; they carry its
    // visibility, so republish when it changes. A pending one has none
    // until its daemon registers.
    if (!isPendingRunner(saved)) await this.capabilities.publish(saved);
    return saved;
  }

  /**
   * Register or re-register a runner. Called by the daemon at startup
   * with the caller's own credential; the owner and organization come
   * from that credential (never from the body), so a daemon can only
   * ever claim a runner of the user it is logged in as, in an
   * organization that user belongs to.
   *
   * v1.0 enforces single-runner-per-(user, organization). A second
   * runner registration for the same (user, org) under another name
   * returns 409 Conflict; the user must release the existing one first.
   * The name is a label unique within the organization: a name already
   * used by another member is refused with 409 rather than shared,
   * because published tool names (`runner.<name>.<method>`) are unique
   * per organization and publishing deletes by name.
   *
   * Re-registration with the same `name` (e.g. the runner restarted
   * after a crash, or the pending record the setup page created) updates
   * the existing row in place and resets runtimeInfo. Workspaces pinned
   * to the prior incarnation are not recovered: the spec says
   * stranded = stranded.
   */
  async register(
    input: RegisterRunnerInput,
    ownerUserId: string,
    organizationId: string,
  ): Promise<RegisterRunnerResult> {
    this.assertName(input.name);

    const existing = await this.runners.findOne({
      where: { ownerUserId, organizationId },
    });

    if (existing && existing.name !== input.name) {
      // v1.0 single-runner cap. The data model could hold multiple but
      // the scheduler isn't there yet, and silently accepting a second
      // runner would force routing to make a choice it isn't allowed
      // to make.
      throw new ConflictException(
        `single runner per account in v1.0; release existing runner '${existing.name}' first`,
      );
    }
    await this.assertNameFreeInOrganization(input.name, ownerUserId, organizationId);

    const requested = input.visibility !== undefined
      ? normaliseVisibility(input.visibility, input.teamId)
      : null;
    if (requested) {
      await this.accessPolicy.assertCanScopeToTeam(
        ownerUserId,
        organizationId,
        requested.visibility,
        requested.teamId,
      );
    }

    const target: Runner = existing ?? this.runners.create({
      name: input.name,
      ownerUserId,
      organizationId,
    });

    target.name = input.name;
    // Labels set on the web record survive a daemon that starts without
    // --label; labels passed on the command line replace them.
    if (input.labels && Object.keys(input.labels).length > 0) {
      target.labels = input.labels;
    } else {
      target.labels = existing?.labels ?? {};
    }
    target.runtimeInfo = input.runtimeInfo;
    target.config = input.config;
    const scope = requested
      ?? (existing
        ? { visibility: existing.visibility, teamId: existing.teamId }
        : { visibility: DEFAULT_RUNNER_VISIBILITY, teamId: null });
    target.visibility = scope.visibility;
    target.teamId = scope.teamId;
    target.state = RunnerState.REGISTERED;
    target.lastHeartbeatAt = null;
    const saved = await this.runners.save(target);

    // Publish capability tools after the runner row is durable. The
    // publisher is idempotent (delete+insert keyed on runnerId), so
    // re-registration after a restart correctly upserts the surface.
    await this.capabilities.publish(saved);

    this.logger.log(
      `runner ${existing ? 're-registered' : 'registered'}: ` +
        `name=${input.name} owner=${ownerUserId} org=${organizationId} visibility=${saved.visibility}`,
    );

    return { runner: saved, effectiveConfig: input.config };
  }

  /**
   * Change a runner's name (only while it has never connected -- the
   * daemon starts with `--name`, so renaming a live runner would orphan
   * it), labels or visibility. Owner, or whoever the access policy lets
   * manage it; another user's private runner answers 404.
   */
  async update(
    runnerId: string,
    userId: string,
    organizationId: string,
    patch: UpdateRunnerInput,
  ): Promise<Runner> {
    const runner = await this.loadManageable(runnerId, userId, organizationId);

    if (patch.name !== undefined && patch.name !== runner.name) {
      this.assertName(patch.name);
      if (!isPendingRunner(runner)) {
        throw new ConflictException(
          'a runner that has connected keeps its name; delete it and start the daemon under the new name',
        );
      }
      await this.assertNameFreeInOrganization(patch.name, runner.ownerUserId, organizationId);
      runner.name = patch.name;
    }
    if (patch.labels !== undefined) runner.labels = patch.labels;
    if (patch.visibility !== undefined) {
      const scope = normaliseVisibility(patch.visibility, patch.teamId);
      await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, scope.visibility, scope.teamId);
      runner.visibility = scope.visibility;
      runner.teamId = scope.teamId;
    }
    const saved = await this.runners.save(runner);
    if (!isPendingRunner(saved)) await this.capabilities.publish(saved);
    return saved;
  }

  /**
   * Mark the runner connected on a Streamable HTTP session. Idempotent
   * by (runnerId, streamableSessionId): repeated calls update the
   * existing row's connectedAt rather than inserting duplicates.
   */
  async onSessionConnect(runnerId: string, streamableSessionId: string, remoteAddress?: string): Promise<RunnerSession> {
    const existing = await this.sessions.findOne({
      where: { runnerId, streamableSessionId },
    });
    if (existing) {
      existing.disconnectedAt = null;
      existing.connectedAt = new Date();
      return this.sessions.save(existing);
    }
    const row = this.sessions.create({
      runnerId,
      streamableSessionId,
      remoteAddress: remoteAddress ?? null,
    });
    return this.sessions.save(row);
  }

  /**
   * Mark a session disconnected. The runner row's state isn't changed
   * here; that's the heartbeat tick's responsibility (the session may
   * reconnect within the stale window without losing online status).
   */
  async onSessionDisconnect(streamableSessionId: string): Promise<void> {
    await this.sessions.update(
      { streamableSessionId, disconnectedAt: IsNull() },
      { disconnectedAt: new Date() },
    );
  }

  /**
   * Apply a heartbeat. Updates lastHeartbeatAt and recomputes state via
   * the FSM. Workspace count is sourced from the live count of ACTIVE
   * workspaces against the runner so it can't drift away from reality
   * over reconnects.
   *
   * The state write is conditional on the runner still being in the
   * state the FSM was asked about. A heartbeat already in flight when a
   * graceful shutdown lands used to save its loaded ONLINE straight
   * back over the DRAINING the drain had committed, and
   * resolveForDispatch then kept handing work to a runner whose process
   * had exited. The FSM already refuses to revive a DRAINING or OFFLINE
   * runner — it just never saw the drain, because it was scoring a
   * snapshot taken before it.
   */
  async heartbeat(runnerId: string): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId } });
    if (!runner) throw new NotFoundException('runner not found');

    const workspaceCount = await this.workspaces.count({
      where: { runnerId, status: WorkspaceStatus.ACTIVE },
    });

    const now = new Date();
    const transitioned = nextState(this.snapshot(runner), {
      kind: 'heartbeat',
      at: now,
      workspaceCount,
    });

    // lastHeartbeatAt is a fact about the wire and is safe to write
    // unconditionally; the state is not.
    await this.runners.update({ id: runner.id }, { lastHeartbeatAt: now });
    runner.lastHeartbeatAt = now;

    if (transitioned !== null) {
      const moved = await this.transitionState(runner.id, runner.state, transitioned);
      if (!moved) {
        // Someone moved the runner while we were scoring. Their write
        // wins; report the row as it now stands.
        const fresh = await this.runners.findOne({ where: { id: runner.id } });
        return fresh ?? runner;
      }
      runner.state = transitioned;
    }
    return runner;
  }

  /**
   * Sweep all runners for stale/offline transitions. Called from the
   * BullMQ tick job (configured in the runner module). Cheap query,
   * cheap loop; we run it at heartbeat interval cadence.
   *
   * OFFLINE runners are selected too when they still have ACTIVE
   * workspaces. Flipping a runner offline and stranding its workspaces
   * are two writes, and a pod that died between them (OOM, eviction,
   * rolling deploy) left the runner OFFLINE with its workspaces ACTIVE
   * — and the old WHERE clause only looked at ONLINE/BUSY/STALE/
   * DRAINING, so that runner was never examined again. The workspaces
   * stayed active forever, the heartbeat's workspace count stayed
   * wrong, the user was never told their work was lost, and nothing
   * short of manual SQL could fix it. Now the next tick picks the
   * runner back up and finishes the job.
   */
  async tick(
    now = new Date(),
    manager?: EntityManager,
  ): Promise<{ checked: number; transitioned: number; markStrandedFor: string[] }> {
    const runners = manager ? manager.getRepository(Runner) : this.runners;
    const candidates = await runners.find({
      where: [
        { state: RunnerState.ONLINE },
        { state: RunnerState.BUSY },
        { state: RunnerState.STALE },
        { state: RunnerState.DRAINING },
      ],
    });
    const markStrandedFor: string[] = [];
    let transitioned = 0;
    for (const runner of candidates) {
      const next = nextState(this.snapshot(runner), { kind: 'tick', at: now });
      if (next === null) continue;
      // Guarded, so a heartbeat or a drain that landed since the SELECT
      // is not overwritten by this sweep's older view.
      const moved = await this.transitionState(runner.id, runner.state, next, manager);
      if (!moved) continue;
      transitioned++;
      if (next === RunnerState.OFFLINE) markStrandedFor.push(runner.id);
    }

    // Self-heal the leftovers: a runner that is OFFLINE, or that has
    // re-registered after a crash, but still has ACTIVE workspaces
    // pinned to it gets its fan-out retried. Stranding is idempotent
    // (it only touches ACTIVE rows), so re-listing a runner costs
    // nothing when there is nothing left to strand.
    const unfinished = await this.runnersWithStrandedWork(manager);
    for (const runnerId of unfinished) {
      if (!markStrandedFor.includes(runnerId)) markStrandedFor.push(runnerId);
    }

    return { checked: candidates.length, transitioned, markStrandedFor };
  }

  /**
   * Clean shutdown signal. Caller is the runner CLI sending a final
   * envelope on the way down. The runner enters DRAINING; the next
   * tick after the grace window will move it to OFFLINE.
   */
  async drain(runnerId: string): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const next = nextState(this.snapshot(runner), { kind: 'shutdown', at: new Date() });
    if (next !== null) {
      const moved = await this.transitionState(runner.id, runner.state, next);
      if (!moved) {
        const fresh = await this.runners.findOne({ where: { id: runner.id } });
        return fresh ?? runner;
      }
      runner.state = next;
    }
    return runner;
  }

  /**
   * Look up the runner that should receive a dispatch, on behalf of
   * `callerUserId`. Returns the runner if the caller may use it and it
   * can accept work, or throws a structured error the caller can convert
   * to a HTTP/RPC response.
   *
   * Visibility is enforced here, at the one place every dispatch passes
   * through, not only at the endpoints in front of it:
   *   - private: only its owner. A dispatch with no known caller (a
   *     gateway call on an API key, a system job) is refused.
   *   - team: a caller the access policy lets use it; no caller, refused.
   *   - org: any member of the organization; a dispatch with no known
   *     caller is allowed, as it was before visibility existed.
   * A caller who may not use the runner gets the same 404 as a runner
   * that does not exist, so its existence does not leak.
   */
  async resolveForDispatch(runnerId: string, callerUserId?: string | null): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const visibility = runner.visibility ?? 'org';
    if (callerUserId) {
      const decision = await this.accessPolicy.canAccess({ id: callerUserId }, runner, 'use');
      if (!decision.allowed) throw new NotFoundException('runner not found');
    } else if (visibility !== 'org') {
      throw new NotFoundException('runner not found');
    }
    // A runner is its registering member's machine acting in this org.
    // While that membership is not in effect (deactivated in the org, SCIM
    // active:false, never accepted) the runner takes work from nobody --
    // not the member's teammates, not an admin, not a system job -- and
    // reactivating the membership brings it back. Same 404 as above.
    if (!runner.ownerUserId || !(await this.accessPolicy.getOrgRole(runner.ownerUserId, runner.organizationId))) {
      throw new NotFoundException('runner not found');
    }
    if (!canAcceptWork(runner.state)) {
      throw new BadRequestException(`runner ${runner.name} is ${runner.state}; cannot accept dispatch`);
    }
    return runner;
  }

  /**
   * Is `runnerId` a runner owned by `userId` inside `organizationId`?
   *
   * For the envelope handlers, and deliberately non-throwing: the id
   * they pass is whatever the daemon wrote into its `runner.hello`
   * payload, not something read back from a row we wrote, so a
   * malformed or unknown id is an answer ("no") rather than an error.
   * The organization and user are the ones the session's bearer token
   * proved.
   *
   * Owner, not merely organization: checking the organization alone let
   * any other member of the same org send a hello naming someone else's
   * runner id. getActiveSession takes the newest connected session, so
   * that claim became the route every dispatch for the victim's runner
   * took -- shell commands, coding sessions, agent spawns, all delivered
   * to the claimant's machine, with the claimant's heartbeats keeping
   * the victim's runner "online".
   */
  async isOwnedBy(runnerId: string, organizationId: string, userId: string | null | undefined): Promise<boolean> {
    if (!organizationId || !userId || !UUID_RE.test(runnerId ?? '')) return false;
    const count = await this.runners.count({ where: { id: runnerId, organizationId, ownerUserId: userId } });
    return count > 0;
  }

  /** The active Streamable HTTP session for a runner, or null. */
  async getActiveSession(runnerId: string): Promise<RunnerSession | null> {
    const row = await this.sessions.findOne({
      where: { runnerId, disconnectedAt: IsNull() },
      order: { connectedAt: 'DESC' },
    });
    return row ?? null;
  }

  /**
   * Resolve the runner that owns a Streamable HTTP session. Used by the
   * envelope handler to route a heartbeat (which is keyed only by session)
   * back to its runner row. Reads from the shared RunnerSession table so it
   * works regardless of which backend replica linked the session.
   */
  async runnerIdForSession(streamableSessionId: string): Promise<string | null> {
    const row = await this.sessions.findOne({
      where: { streamableSessionId },
      order: { connectedAt: 'DESC' },
    });
    return row?.runnerId ?? null;
  }

  /** The caller's own runners. */
  async listForOwner(ownerUserId: string, organizationId: string): Promise<Runner[]> {
    return this.runners.find({ where: { ownerUserId, organizationId } });
  }

  /**
   * Every runner the caller may see: their own (private included),
   * org-wide ones, and team ones for their teams. Other members'
   * private runners are never returned, to org admins either.
   */
  async listVisible(userId: string, organizationId: string): Promise<Runner[]> {
    const qb = this.runners.createQueryBuilder('r');
    await this.accessPolicy.applyListFilter(qb, { id: userId }, organizationId, 'r', {
      ownerColumn: 'ownerUserId',
    });
    return qb.orderBy('r."registeredAt"', 'DESC').getMany();
  }

  /**
   * One runner the caller may see (see listVisible). A runner they may
   * not see answers 404, the same as one that does not exist.
   */
  async getOne(runnerId: string, userId: string, organizationId: string): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId, organizationId } });
    if (!runner) throw new NotFoundException('runner not found');
    const decision = await this.accessPolicy.canAccess({ id: userId }, runner, 'read');
    if (!decision.allowed) throw new NotFoundException('runner not found');
    return runner;
  }

  /** One of the caller's own runners (agent.* orchestration is owner-only). */
  async getOwned(runnerId: string, ownerUserId: string, organizationId: string): Promise<Runner> {
    const runner = await this.runners.findOne({
      where: { id: runnerId, ownerUserId, organizationId },
    });
    if (!runner) throw new NotFoundException('runner not found');
    return runner;
  }

  /**
   * Lookup for the coding bridge: a member of the runner's organization
   * whom the access policy lets USE the runner may drive coding sessions
   * on it (the chat REPL dispatches on behalf of the user, not just the
   * runner's owner). 404 when the runner doesn't exist, belongs to another
   * organization, or the caller may not use it (a private runner of
   * someone else, a team runner of a team they're not on) -- one answer
   * for all of them, so the response never says which runner ids exist.
   */
  async getUsable(runnerId: string, userId: string, organizationId: string): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId, organizationId } });
    if (!runner) throw new NotFoundException('runner not found');
    const decision = await this.accessPolicy.canAccess({ id: userId }, runner, 'use');
    if (!decision.allowed) throw new NotFoundException('runner not found');
    return runner;
  }

  async unregister(runnerId: string, userId: string, organizationId: string): Promise<void> {
    const runner = await this.loadManageable(runnerId, userId, organizationId);
    await this.deleteRunner(runner);
  }

  /**
   * Delete a runner whose owner is leaving the organization, inside the
   * membership removal's transaction. No access check: the caller has
   * already authorised the removal, and a private runner is a binding to
   * the departed person's own machine that nobody else may take over.
   */
  async deleteForDepartedOwner(runner: Runner, manager: EntityManager): Promise<void> {
    await this.deleteRunner(runner, manager);
  }

  /** The one delete path: the runner's published tools go with it. */
  private async deleteRunner(runner: Runner, manager?: EntityManager): Promise<void> {
    // Drop published capabilities first so a concurrent dispatch can't
    // race against deletion and find a tool whose runner is gone.
    await this.capabilities.unpublish(runner.id, manager);
    if (manager) {
      await manager.getRepository(Runner).remove(runner);
    } else {
      await this.runners.remove(runner);
    }
  }

  // ── internals ───────────────────────────────────────────────────────

  /**
   * A runner the caller may change or delete. The owner always may.
   * Otherwise the org owner/admin or (for team-scoped runners) a team
   * lead may manage it via the access policy -- except a private runner,
   * which is its owner's alone. A runner the caller cannot even see
   * answers 404; one they can see but not manage answers 403.
   */
  private async loadManageable(runnerId: string, userId: string, organizationId: string): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId, organizationId } });
    return assertManageable(this.accessPolicy, userId, runner, 'runner', { ownerManages: true });
  }

  private assertName(name: string | undefined): void {
    if (!name || !NAME_RE.test(name)) {
      throw new BadRequestException('runner name must match [a-zA-Z0-9_-]{1,64}');
    }
  }

  /**
   * Runner names are unique within an organization. The name becomes
   * part of the runner's published tool names (`runner.<name>.<method>`,
   * unique per organization), and publishing replaces rows by name -- so
   * a second member registering a name already in use used to delete
   * the first member's tools and republish them pointing at their own
   * machine: an agent calling `runner.<name>.shell.exec` then ran on the
   * wrong person's computer. Refuse instead. The message does not say
   * whose runner it is.
   */
  private async assertNameFreeInOrganization(name: string, ownerUserId: string, organizationId: string): Promise<void> {
    const clash = await this.runners.findOne({ where: { organizationId, name } });
    if (clash && clash.ownerUserId !== ownerUserId) {
      throw nameTaken('runner', name);
    }
  }

  // ── internals ───────────────────────────────────────────────────────

  private snapshot(runner: Runner): RunnerSnapshot {
    return { state: runner.state, lastHeartbeatAt: runner.lastHeartbeatAt };
  }

  /**
   * Move a runner from one state to another, but only if it is still in
   * `from`. Returns false when it is not — some other writer moved it
   * since we read it, and their write is the newer truth.
   *
   * Every FSM write goes through this. `nextState` scores a snapshot,
   * and between the snapshot and the write a heartbeat, a drain and the
   * tick sweep can all be in flight against the same row; an
   * unconditional save() let the last one to finish win regardless of
   * what it knew.
   */
  private async transitionState(
    runnerId: string,
    from: RunnerState,
    to: RunnerState,
    manager?: EntityManager,
  ): Promise<boolean> {
    const runners = manager ? manager.getRepository(Runner) : this.runners;
    const result = await runners.update({ id: runnerId, state: from }, { state: to });
    return (result.affected ?? 0) > 0;
  }

  /**
   * Runners that still have ACTIVE workspaces but can no longer be
   * running them. Returned so the next tick strands the leftovers.
   *
   * Two ways to get here, and both used to end in workspaces that
   * stayed ACTIVE for ever:
   *
   *   OFFLINE     the residue of a pod that died between flipping the
   *               runner and stranding its work.
   *   REGISTERED  a runner that crashed and re-registered. register()
   *               resets the row to REGISTERED with no heartbeat, and
   *               the tick's candidate list only looks at ONLINE,
   *               BUSY, STALE and DRAINING -- so the previous
   *               incarnation's workspaces were never examined again,
   *               even though the machine they were pinned to is gone.
   *               The header on register() says the spec is
   *               "stranded = stranded"; nothing was doing the
   *               stranding.
   *
   * An ACTIVE workspace against a REGISTERED runner is always residue:
   * WorkspaceService.create refuses any runner that is not ONLINE or
   * BUSY, so one cannot legitimately be created in this state.
   */
  private async runnersWithStrandedWork(manager?: EntityManager): Promise<string[]> {
    const workspaces = manager ? manager.getRepository(Workspace) : this.workspaces;
    const rows = await workspaces
      .createQueryBuilder('ws')
      .select('DISTINCT ws."runnerId"', 'runnerId')
      .innerJoin(Runner, 'r', 'r.id = ws."runnerId"')
      .where('ws.status = :active', { active: WorkspaceStatus.ACTIVE })
      .andWhere('r.state IN (:...gone)', {
        gone: [RunnerState.OFFLINE, RunnerState.REGISTERED],
      })
      .getRawMany();
    return rows.map((row) => row.runnerId);
  }
}
