import type { Agent } from '../../entities/agent.entity';

/**
 * How AgentsService keeps an agent's live scheduled job in step with what
 * it saves. AgentSchedulerService provides it (agents.module.ts); a token
 * rather than the class because the scheduler injects AgentsService, and
 * importing it back here would make the two files a load-order cycle.
 */
export const AGENT_SCHEDULE_SYNC = 'AGENT_SCHEDULE_SYNC';

export interface AgentScheduleSync {
  /** One job on the stored timing when the agent is active and its schedule on, none otherwise. */
  syncSchedule(agent: Agent): Promise<void>;
  /** Drop the agent's job, for an agent being deleted. */
  removeSchedule(agentId: string): Promise<void>;
}
