import type { Agent } from '../../entities/agent.entity';
import type { AgentRun } from '../../entities/agent-run.entity';

/**
 * Whether a finished run may be summarised into the agent's memory.
 *
 * Auto-saved memory lives at workspace scope and is read back into later
 * runs for everyone. A run started by a member of the public (a hosted
 * chat or widget visitor, identified by `endUserId`) must therefore not
 * feed it: one visitor's question would otherwise surface in another
 * visitor's answer, and the tenant would be storing personal data it
 * never asked for. Operators' own runs keep the existing opt-in.
 */
export function shouldAutoSaveMemory(
  agent: Pick<Agent, 'memoryConfig'>,
  run: Pick<AgentRun, 'endUserId'> & { metadata?: Record<string, any> | null },
): boolean {
  if (!agent.memoryConfig?.autoSave) return false;
  // A product may opt its visitors in (app privacy setting, carried on the
  // run when the surface starts it). The default stays out.
  if (run.endUserId) return run.metadata?.visitorMemory === true;
  return true;
}

