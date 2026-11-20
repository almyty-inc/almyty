import { EntityManager, In } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { CodeExecution } from '../../entities/code-execution.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';

/**
 * A run in one of these has finished and may be deleted. PENDING, RUNNING,
 * WAITING_INPUT, SLEEPING and WAITING_APPROVAL are still live workflow
 * state, whatever their age.
 */
export const FINISHED_RUN_STATUSES: readonly AgentRunStatus[] = [
  AgentRunStatus.COMPLETED,
  AgentRunStatus.FAILED,
  AgentRunStatus.CANCELLED,
  AgentRunStatus.TIMEOUT,
];

export function isFinishedRunStatus(status: AgentRunStatus | string | null | undefined): boolean {
  return FINISHED_RUN_STATUSES.includes(status as AgentRunStatus);
}

/**
 * Delete runs, the tool calls they made and the run_code scripts they ran,
 * inside the caller's transaction. The one way a run is removed on request:
 * a visitor's erasure (VisitorDataService.erase) and "Delete run" both go
 * through it.
 *
 * What goes with the run row itself is the schema's: its event log
 * (agent_run_events) and approval requests by ON DELETE CASCADE; a skill
 * or constraint promoted from it keeps existing with sourceRunId set to
 * null. tool_executions and code_executions have no foreign key to the
 * run, so their rows are deleted here, scoped to the organization like the
 * runs. Tool calls go first: their codeExecutionId points at the script.
 */
export async function removeRuns(
  tx: EntityManager,
  organizationId: string,
  runIds: string[],
): Promise<{ runs: number; toolCalls: number; scripts: number }> {
  if (runIds.length === 0) return { runs: 0, toolCalls: 0, scripts: 0 };
  const calls = await tx.getRepository(ToolExecution).delete({ runId: In(runIds), organizationId });
  const scripts = await tx.getRepository(CodeExecution).delete({ runId: In(runIds), organizationId });
  const removed = await tx.getRepository(AgentRun).delete({ id: In(runIds), organizationId });
  return { runs: removed.affected ?? runIds.length, toolCalls: calls.affected ?? 0, scripts: scripts.affected ?? 0 };
}