import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { Runner, RunnerIsolationTier } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import { DEFAULT_TTL_MS } from '../workspace/workspace.service';
import { RunnerService } from './runner.service';
import { RunnerCallService, RunnerCallError, RUNNER_CALL_ERRORS, type RunnerResponsePayload } from './runner-call.service';
import { canAcceptWork } from './runner-state';
import { type LabelRequirements, hasLabelRequirements } from './runner-labels';

export interface AcquireRunWorkspaceInput {
  /** The runner the tool was published for (preferred when labels route). */
  runnerId: string;
  organizationId: string;
  /** The agent run (autonomous run or workflow execution) that needs a folder. */
  runId: string;
  agentId?: string | null;
  callerUserId?: string | null;
  principal?: ExecutionPrincipal;
  /** The agent's machine requirements; the workspace goes where the work would. */
  labels?: LabelRequirements;
  signal?: AbortSignal;
}

/** How long the runner gets to make the folder. */
const PREPARE_TIMEOUT_MS = 15_000;

const UNIQUE_VIOLATION = '23505';

/** A POSIX or Windows absolute path, as the runner answers from realpath. */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Workspaces agents get without asking.
 *
 * When a run calls a runner-backed tool that works inside a workspace
 * (`requiresWorkspace`) and names none, the run gets one on the runner the
 * call is going to: the runner makes a folder (`workspace.prepare`, named
 * `<agent>-<run>`), the workspace is recorded for the run's user and
 * attributed to the agent and run, and every later call of the same run on
 * that runner reuses it. It is an ordinary workspace from then on: the
 * default time limit, released from the runner's Workspaces tab, expired by
 * the TTL sweep, stranded when the runner goes offline. A run whose
 * workspace ended gets a new one in the same folder on its next call.
 *
 * Capacity: a runner holds at most `config.maxConcurrent` active
 * workspaces through this path; past that the call fails and says so.
 */
@Injectable()
export class RunWorkspaceService {
  private readonly logger = new Logger(RunWorkspaceService.name);
  /** Concurrent calls of one run on one runner wait for the same workspace. */
  private readonly inFlight = new Map<string, Promise<Workspace>>();

  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    private readonly runners: RunnerService,
    private readonly calls: RunnerCallService,
  ) {}

  async acquire(input: AcquireRunWorkspaceInput): Promise<Workspace> {
    const owner = ownerOf(input);
    const runner = await this.resolveRunner(input);
    const key = `${input.runId}:${runner.id}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const attempt = this.acquireOn(runner, owner, input).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async acquireOn(runner: Runner, ownerUserId: string, input: AcquireRunWorkspaceInput): Promise<Workspace> {
    const now = new Date();
    const existing = await this.activeFor(input.runId, runner.id);
    if (existing) {
      if (!existing.ttlAt || existing.ttlAt.getTime() > now.getTime()) return existing;
      // Past its time limit but not swept yet. Expire it the way the sweep
      // would (conditionally, so a release that got there first stands);
      // the run gets a fresh workspace in the same folder below.
      await this.workspaces.update(
        { id: existing.id, status: WorkspaceStatus.ACTIVE },
        { status: WorkspaceStatus.EXPIRED, closedAt: now, closeReason: { kind: 'expired', detail: existing.ttlAt.toISOString() } },
      );
    }

    if (!canAcceptWork(runner.state)) {
      throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_OFFLINE, `runner ${runner.name} is ${runner.state}; it cannot take a new workspace`);
    }
    const cap = runner.config?.maxConcurrent;
    if (typeof cap === 'number' && cap > 0) {
      const active = await this.workspaces.count({ where: { runnerId: runner.id, status: WorkspaceStatus.ACTIVE } });
      if (active >= cap) {
        throw new RunnerCallError(
          RUNNER_CALL_ERRORS.RUNNER_AT_CAPACITY,
          `runner ${runner.name} already has ${active} active workspace(s), its limit (maxConcurrent ${cap}); release one on the runner's Workspaces tab`,
        );
      }
    }

    const name = await this.folderName(input);
    const cwd = await this.prepareFolder(runner, name, input);
    const row = this.workspaces.create({
      runnerId: runner.id,
      ownerUserId,
      organizationId: input.organizationId,
      cwd,
      isolation: runner.config?.defaultIsolation ?? RunnerIsolationTier.CONTAINER,
      ttlAt: new Date(Date.now() + DEFAULT_TTL_MS),
      status: WorkspaceStatus.ACTIVE,
      name,
      agentId: input.agentId ?? null,
      runId: input.runId,
    });
    try {
      const saved = await this.workspaces.save(row);
      this.logger.log(`workspace ${saved.id} (${name}) created on runner ${runner.name} for run ${input.runId}`);
      return saved;
    } catch (err: any) {
      // Another pod made this run's workspace on this runner first
      // (UQ_workspaces_active_run_runner): use that one.
      if (err?.code === UNIQUE_VIOLATION || err?.driverError?.code === UNIQUE_VIOLATION) {
        const winner = await this.activeFor(input.runId, runner.id);
        if (winner) return winner;
      }
      throw err;
    }
  }

  private activeFor(runId: string, runnerId: string): Promise<Workspace | null> {
    return this.workspaces.findOne({ where: { runId, runnerId, status: WorkspaceStatus.ACTIVE } });
  }

  /** The runner the call is going to, by the same rules as RunnerCallService.dispatch. */
  private async resolveRunner(input: AcquireRunWorkspaceInput): Promise<Runner> {
    const caller = input.principal ?? input.callerUserId;
    const resolved = hasLabelRequirements(input.labels)
      ? this.runners.resolveByLabels(input.labels, caller, input.organizationId, { preferRunnerId: input.runnerId })
      : this.runners.resolveForDispatch(input.runnerId, caller);
    return resolved.catch((err) => {
      if (err?.status === 404) throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_NOT_FOUND, err.message);
      throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_UNAVAILABLE, err?.message ?? String(err));
    });
  }

  /** `<agent-name>-<first 8 of the run id>`, the folder's name on the runner. */
  private async folderName(input: AcquireRunWorkspaceInput): Promise<string> {
    let agentName = '';
    if (input.agentId) {
      const agent = await this.agents.findOne({
        where: { id: input.agentId, organizationId: input.organizationId },
        select: { id: true, name: true },
      });
      agentName = agent?.name ?? '';
    }
    return workspaceFolderName(agentName, input.runId);
  }

  private async prepareFolder(runner: Runner, name: string, input: AcquireRunWorkspaceInput): Promise<string> {
    let response: RunnerResponsePayload;
    try {
      response = await this.calls.dispatch(runner.id, 'workspace.prepare', { name }, undefined, {
        callerUserId: input.callerUserId ?? null,
        principal: input.principal,
        signal: input.signal,
        timeoutMs: PREPARE_TIMEOUT_MS,
      });
    } catch (err: any) {
      if (err instanceof RunnerCallError && err.code !== RUNNER_CALL_ERRORS.RUNNER_ERROR) throw err;
      response = { ok: false, error: err.cause ?? { code: 0, message: err?.message ?? String(err) } };
    }
    const cwd = (response.result as { cwd?: unknown } | undefined)?.cwd;
    if (response.ok && typeof cwd === 'string' && ABSOLUTE_PATH.test(cwd)) return cwd;
    const reason = response.error?.message ?? 'it answered without a folder';
    const tooOld = /unknown method/i.test(reason);
    throw new RunnerCallError(
      RUNNER_CALL_ERRORS.WORKSPACE_UNAVAILABLE,
      tooOld
        ? `runner ${runner.name} cannot make workspaces automatically; update @almyty/runner on that machine`
        : `runner ${runner.name} could not make a workspace folder: ${reason}`,
    );
  }
}

/**
 * Whose workspace this is. A workspace is always one person's
 * (WorkspaceService.findForDispatch): the run's user, or the owner of the
 * private or team gateway the run came through. An org-wide gateway's run
 * has no one to hold it.
 */
function ownerOf(input: AcquireRunWorkspaceInput): string {
  const p = input.principal;
  if (p?.kind === 'user' && p.userId) return p.userId;
  if (p?.kind === 'gateway') {
    if (p.visibility !== 'org' && p.ownerUserId) return p.ownerUserId;
    throw new RunnerCallError(
      RUNNER_CALL_ERRORS.WORKSPACE_REQUIRED,
      'this run came through an org-wide gateway, and a workspace belongs to one person; call the tool with a workspaceId or run the agent as a user',
    );
  }
  if (!p && input.callerUserId) return input.callerUserId;
  throw new RunnerCallError(
    RUNNER_CALL_ERRORS.WORKSPACE_REQUIRED,
    'a run with no user cannot be given a workspace; call the tool with a workspaceId',
  );
}

/** Lowercase letters, digits and dashes, as the runner accepts (`workspace.prepare`). */
export function workspaceFolderName(agentName: string, runId: string): string {
  // Words of letters and digits joined by one dash: no leading, trailing or
  // doubled dashes, and no backtracking regex to get there.
  const words = agentName.toLowerCase().split(/[^a-z0-9]/).filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 60) {
      if (!slug) slug = word.slice(0, 60);
      break;
    }
    slug = next;
  }
  const run = runId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || 'run';
  return slug ? `${slug}-${run}` : `run-${run}`;
}
