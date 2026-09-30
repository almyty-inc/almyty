import { In, Repository } from 'typeorm';

import type { AgentRun } from '../../entities/agent-run.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';

/**
 * Run states after which a run is over: an autonomous run's (agent_runs) and
 * a workflow execution's (agent_executions) terminal states, which share
 * these four names. Anything else -- pending, running, sleeping, waiting for
 * input or for an approval -- is a run that may still need its folder.
 */
export const ENDED_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'] as const;

const ENDED = new Set<string>(ENDED_RUN_STATUSES);

/** How far up, and how many generations down, a job is followed. */
const MAX_JOB_DEPTH = 32;

type RunRow = Pick<AgentRun, 'id' | 'parentRunId' | 'status' | 'organizationId'>;

/**
 * The top-level run of the job `runId` belongs to: up the parentRunId
 * chain, inside one organization, cycle-safe. The same walk as
 * RunWorkspaceService.jobOf, so the workspace a job was given is the one
 * found here. A run that is not an autonomous run (a workflow execution)
 * is its own job.
 */
export async function jobRootOf(runs: Repository<AgentRun>, runId: string): Promise<string> {
  const seen = new Set<string>();
  let run = await findRun(runs, runId);
  let root = runId;
  while (run) {
    root = run.id;
    seen.add(run.id);
    if (!run.parentRunId || seen.has(run.parentRunId) || seen.size >= MAX_JOB_DEPTH) break;
    const parent = await findRun(runs, run.parentRunId);
    if (!parent || parent.organizationId !== run.organizationId) break;
    run = parent;
  }
  return root;
}

/**
 * Whether any run of the job rooted at `rootId` is still going: the root
 * itself or any descendant (helpers, collaboration members, spawned agents
 * and theirs) in a state other than ended.
 */
export async function jobHasLiveRun(runs: Repository<AgentRun>, rootId: string): Promise<boolean> {
  const root = await findRun(runs, rootId);
  if (root && !ENDED.has(root.status)) return true;
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_JOB_DEPTH && frontier.length > 0; depth++) {
    const children = (await runs.find({
      where: { parentRunId: In(frontier) },
      select: { id: true, status: true, parentRunId: true, organizationId: true },
    })) as RunRow[];
    const next: string[] = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      if (root && child.organizationId !== root.organizationId) continue;
      if (!ENDED.has(child.status)) return true;
      seen.add(child.id);
      next.push(child.id);
    }
    frontier = next;
  }
  return false;
}

function findRun(runs: Repository<AgentRun>, id: string): Promise<RunRow | null> {
  return runs.findOne({
    where: { id },
    select: { id: true, parentRunId: true, status: true, organizationId: true },
  }) as Promise<RunRow | null>;
}

/**
 * Called when a run ends (completed, failed, cancelled, timed out): release
 * the active workspaces of the job it belongs to, once nothing in that job
 * is still going.
 *
 * A job is a top-level run and every run it started, down the parentRunId
 * chain; its workspaces are keyed by the top-level run (RunWorkspaceService),
 * so a child run owns none of its own. The job's workspaces stay active
 * while the top-level run or any descendant is still running, queued or
 * waiting (for input or an approval): a parent that finishes before its
 * helpers leaves them their folder, and the last run of the job to end is
 * the one whose end releases it. With `runs` unknown (a workflow execution,
 * whose sub-agents run inside its own execute and end before it does) the
 * run is its own job and is released as it ends.
 *
 * Only the database row changes: the runner's next heartbeat stops the
 * workspace's processes, and the folder and its files stay on the machine.
 * Conditional on the row still being ACTIVE, like every other transition
 * out of it. Never throws: a run's end must not fail because a workspace
 * could not be released; the workspace tick applies the same rule to what
 * this misses.
 */
export async function releaseRunWorkspaces(
  repo: Repository<Workspace> | undefined | null,
  runId: string | null | undefined,
  runs?: Repository<AgentRun> | null,
  now = new Date(),
): Promise<number> {
  if (!repo || !runId) return 0;
  try {
    let job = runId;
    if (runs) {
      job = await jobRootOf(runs, runId);
      if (await jobHasLiveRun(runs, job)) return 0;
    }
    const result = await repo.update(
      { runId: job, status: WorkspaceStatus.ACTIVE },
      {
        status: WorkspaceStatus.RELEASED,
        closedAt: now,
        closeReason: { kind: 'released', detail: `run ${job} ended` },
      },
    );
    return result.affected ?? 0;
  } catch {
    return 0;
  }
}