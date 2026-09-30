import { Repository } from 'typeorm';

import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';

/**
 * Run states after which a run's workspaces are released: an autonomous
 * run's (agent_runs) and a workflow execution's (agent_executions) terminal
 * states, which share these four names.
 */
export const ENDED_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'] as const;

/**
 * Release the active workspaces a run was given (RunWorkspaceService keys
 * them by the run that started the job, so a sub-agent's run owns none and
 * this is a no-op for it). Called the moment a run ends -- completed,
 * failed, cancelled or timed out -- so the runner's slot is free at once.
 * Only the database row changes: the runner's next heartbeat stops the
 * workspace's processes, and the folder and its files stay on the machine.
 *
 * Conditional on the row still being ACTIVE, like every other transition
 * out of it, so a release, expiry or stranding that got there first stands.
 * Never throws: a run's end must not fail because a workspace could not be
 * released; the workspace tick sweeps what this misses.
 */
export async function releaseRunWorkspaces(
  repo: Repository<Workspace> | undefined | null,
  runId: string | null | undefined,
  now = new Date(),
): Promise<number> {
  if (!repo || !runId) return 0;
  try {
    const result = await repo.update(
      { runId, status: WorkspaceStatus.ACTIVE },
      {
        status: WorkspaceStatus.RELEASED,
        closedAt: now,
        closeReason: { kind: 'released', detail: `run ${runId} ended` },
      },
    );
    return result.affected ?? 0;
  } catch {
    return 0;
  }
}
