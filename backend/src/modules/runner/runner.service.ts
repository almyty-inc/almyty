import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';

import { Runner, RunnerState, RunnerRuntimeInfo, RunnerConfig } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { canAcceptWork, nextState, RunnerSnapshot } from './runner-state';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

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
  labels: Record<string, string>;
  runtimeInfo: RunnerRuntimeInfo;
  config: RunnerConfig;
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
   * Register or re-register a runner. v1.0 enforces single-runner-per-
   * (user, organization). A second runner registration for the same
   * (user, org) returns 409 Conflict; the user must release the
   * existing one first. The data model carries no such restriction;
   * the limit is here in policy and disappears when scheduler logic
   * lands in v1.x.
   *
   * Re-registration with the same `name` (e.g. the runner restarted
   * after a crash) updates the existing row in place and resets
   * runtimeInfo. Workspaces pinned to the prior incarnation are not
   * recovered: the spec says stranded = stranded.
   */
  async register(
    input: RegisterRunnerInput,
    ownerUserId: string,
    organizationId: string,
  ): Promise<RegisterRunnerResult> {
    if (!input.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.name)) {
      throw new BadRequestException('runner name must match [a-zA-Z0-9_-]{1,64}');
    }

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

    const target: Runner = existing ?? this.runners.create({
      name: input.name,
      ownerUserId,
      organizationId,
    });

    target.name = input.name;
    target.labels = input.labels ?? {};
    target.runtimeInfo = input.runtimeInfo;
    target.config = input.config;
    target.state = RunnerState.REGISTERED;
    target.lastHeartbeatAt = null;
    const saved = await this.runners.save(target);

    // Publish capability tools after the runner row is durable. The
    // publisher is idempotent (delete+insert keyed on runnerId), so
    // re-registration after a restart correctly upserts the surface.
    await this.capabilities.publish(saved);

    this.logger.log(
      `runner ${existing ? 're-registered' : 'registered'}: ` +
        `name=${input.name} owner=${ownerUserId} org=${organizationId}`,
    );

    return { runner: saved, effectiveConfig: input.config };
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
   */
  async heartbeat(runnerId: string): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId } });
    if (!runner) throw new NotFoundException('runner not found');

    const workspaceCount = await this.workspaces.count({
      where: { runnerId, status: WorkspaceStatus.ACTIVE },
    });

    const now = new Date();
    runner.lastHeartbeatAt = now;
    const transitioned = nextState(this.snapshot(runner), {
      kind: 'heartbeat',
      at: now,
      workspaceCount,
    });
    if (transitioned !== null) runner.state = transitioned;
    return this.runners.save(runner);
  }

  /**
   * Sweep all runners for stale/offline transitions. Called from the
   * BullMQ tick job (configured in the runner module). Cheap query,
   * cheap loop; we run it at heartbeat interval cadence.
   */
  async tick(now = new Date()): Promise<{ checked: number; transitioned: number; markStrandedFor: string[] }> {
    const candidates = await this.runners.find({
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
      runner.state = next;
      await this.runners.save(runner);
      transitioned++;
      if (next === RunnerState.OFFLINE) markStrandedFor.push(runner.id);
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
      runner.state = next;
      await this.runners.save(runner);
    }
    return runner;
  }

  /**
   * Look up the runner that should receive a workspace's traffic.
   * Returns the runner if it can accept work, or throws a structured
   * error the caller can convert to a HTTP/RPC response.
   */
  async resolveForDispatch(runnerId: string): Promise<Runner> {
    const runner = await this.runners.findOne({ where: { id: runnerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (!canAcceptWork(runner.state)) {
      throw new BadRequestException(`runner ${runner.name} is ${runner.state}; cannot accept dispatch`);
    }
    return runner;
  }

  /** The active Streamable HTTP session for a runner, or null. */
  async getActiveSession(runnerId: string): Promise<RunnerSession | null> {
    const row = await this.sessions.findOne({
      where: { runnerId, disconnectedAt: IsNull() },
      order: { connectedAt: 'DESC' },
    });
    return row ?? null;
  }

  async listForOwner(ownerUserId: string, organizationId: string): Promise<Runner[]> {
    return this.runners.find({ where: { ownerUserId, organizationId } });
  }

  async getOne(runnerId: string, ownerUserId: string, organizationId: string): Promise<Runner> {
    const runner = await this.runners.findOne({
      where: { id: runnerId, ownerUserId, organizationId },
    });
    if (!runner) throw new NotFoundException('runner not found');
    return runner;
  }

  async unregister(runnerId: string, userId: string, organizationId: string): Promise<void> {
    const runner = await this.runners.findOne({
      where: { id: runnerId, organizationId },
    });
    if (!runner) throw new NotFoundException('runner not found');

    // Authorization: the runner owner can always unregister their own
    // runner. Otherwise the org owner/admin or (for team-scoped runners)
    // a team lead may manage it via the access policy.
    if (runner.ownerUserId !== userId) {
      const decision = await this.accessPolicy.canAccess({ id: userId }, runner, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }
    }

    // Drop published capabilities first so a concurrent dispatch can't
    // race against deletion and find a tool whose runner is gone.
    await this.capabilities.unpublish(runner.id);
    await this.runners.remove(runner);
  }

  // ── internals ───────────────────────────────────────────────────────

  private snapshot(runner: Runner): RunnerSnapshot {
    return { state: runner.state, lastHeartbeatAt: runner.lastHeartbeatAt };
  }
}
