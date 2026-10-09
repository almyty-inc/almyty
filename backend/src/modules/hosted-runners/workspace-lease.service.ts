import { randomUUID } from 'crypto';
import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentExecution } from '../../entities/agent-execution.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Workspace } from '../../entities/workspace.entity';
import { ENDED_RUN_STATUSES, jobHasLiveRun, jobRootOf } from '../workspace/run-end-release';
import { HostedRunnerSettingsService } from './hosted-runner-settings';

/** Who holds a workspace for a call: its job (the top-level run), or the call alone. */
export interface WorkspaceLeaseHolder {
  holder: string;
  /** A job keeps the workspace across its calls; a lone call gives it back when it returns. */
  job: boolean;
}

const ENDED = new Set<string>(ENDED_RUN_STATUSES);

/**
 * One folder per person per environment, one job at a time
 * (docs/hosted-runners.md, "One folder, one job at a time").
 *
 * A person's hosted workspace on an environment is a single folder, the
 * volume mounted at the settings' `cluster.workspaceMountPath`, shared by
 * every job of theirs there. So that two jobs never write it at once, a
 * job takes the workspace with its first call and keeps it while any run
 * of the job is going and it has used the workspace within
 * `workspaceQueue.leaseMinutes`; a call of another job waits for it, up to
 * `workspaceQueue.waitSeconds`, and is then told to try again (an agent
 * run sleeps and does). Calls that belong to no run (a person calling a
 * tool by hand) hold it for the call only.
 *
 * The lease is three columns on the workspace row, taken and handed on by
 * conditional UPDATEs, so it holds across API replicas. A job that ended
 * is noticed by the next job that wants the workspace; no run-end hook is
 * needed, and a crashed holder's lease runs out on its own.
 */
@Injectable()
export class WorkspaceLeaseService {
  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    private readonly settings: HostedRunnerSettingsService,
    @Optional() @InjectRepository(AgentRun) private readonly runs?: Repository<AgentRun>,
    @Optional() @InjectRepository(AgentExecution) private readonly executions?: Repository<AgentExecution>,
  ) {}

  /** The holder a call takes the workspace as: its job's top-level run, or itself. */
  async holderFor(runId: string | null | undefined): Promise<WorkspaceLeaseHolder> {
    if (!runId) return { holder: randomUUID(), job: false };
    const root = this.runs ? await jobRootOf(this.runs, runId) : runId;
    return { holder: root, job: true };
  }

  /**
   * Take the workspace for `h`, waiting for another job to finish with it
   * for at most `workspaceQueue.waitSeconds`. False when it is still held.
   */
  async acquire(workspaceId: string, h: WorkspaceLeaseHolder, signal?: AbortSignal): Promise<boolean> {
    const q = this.settings.current.workspaceQueue;
    const deadline = Date.now() + q.waitSeconds * 1000;
    const poll = q.pollSeconds * 1000;
    for (;;) {
      if (await this.tryAcquire(workspaceId, h)) return true;
      if (signal?.aborted || Date.now() + poll > deadline) return false;
      await pause(poll, signal);
    }
  }

  /** One attempt: free, already ours, run out, or held by a job that has ended. */
  async tryAcquire(workspaceId: string, h: WorkspaceLeaseHolder, now = new Date()): Promise<boolean> {
    const until = new Date(now.getTime() + this.settings.minutes(this.settings.current.workspaceQueue.leaseMinutes));
    const taken = await this.workspaces
      .createQueryBuilder()
      .update(Workspace)
      .set({ leaseHolder: h.holder, leaseJob: h.job, leaseUntil: until })
      .where('id = :id', { id: workspaceId })
      .andWhere('("leaseHolder" IS NULL OR "leaseHolder" = :holder OR "leaseUntil" IS NULL OR "leaseUntil" < :now)', { holder: h.holder, now })
      .execute();
    if (taken.affected) return true;

    const current = await this.workspaces.findOne({ where: { id: workspaceId }, select: { id: true, leaseHolder: true, leaseJob: true } });
    if (!current?.leaseHolder || !current.leaseJob || (await this.jobIsLive(current.leaseHolder))) return false;
    // The job that held it has ended: hand it on, unless someone else already did.
    const handedOn = await this.workspaces
      .createQueryBuilder()
      .update(Workspace)
      .set({ leaseHolder: h.holder, leaseJob: h.job, leaseUntil: until })
      .where('id = :id', { id: workspaceId })
      .andWhere('"leaseHolder" = :previous', { previous: current.leaseHolder })
      .execute();
    return !!handedOn.affected;
  }

  /** Give the workspace back (a lone call that returned). Only the holder can. */
  async release(workspaceId: string, holder: string): Promise<void> {
    await this.workspaces
      .createQueryBuilder()
      .update(Workspace)
      .set({ leaseHolder: null, leaseJob: false, leaseUntil: null })
      .where('id = :id', { id: workspaceId })
      .andWhere('"leaseHolder" = :holder', { holder })
      .execute();
  }

  /** Whether any run of the job is still going: an autonomous run's tree, or a workflow execution. */
  private async jobIsLive(holder: string): Promise<boolean> {
    if (this.runs && (await this.runs.findOne({ where: { id: holder }, select: { id: true } }))) return jobHasLiveRun(this.runs, holder);
    const execution = this.executions ? await this.executions.findOne({ where: { id: holder }, select: { id: true, status: true } }) : null;
    return !!execution && !ENDED.has(String(execution.status));
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
