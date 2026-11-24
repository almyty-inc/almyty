import { Provider } from '@nestjs/common';
import { AgentSchedulerService } from './agent-scheduler.service';
import { AGENT_SCHEDULE_SYNC, AgentScheduleSync } from './agent-schedule-sync';

/**
 * AGENT_SCHEDULE_SYNC as a plain object over the scheduler, not
 * `useExisting: AgentSchedulerService`: the scheduler is a Bull
 * @Processor, and an alias of it is explored as a second processor
 * ("Cannot define the same handler twice execute-agent" at boot).
 */
export const agentScheduleSyncProvider: Provider = {
  provide: AGENT_SCHEDULE_SYNC,
  inject: [AgentSchedulerService],
  useFactory: (scheduler: AgentSchedulerService): AgentScheduleSync => ({
    syncSchedule: (agent) => scheduler.syncSchedule(agent),
    removeSchedule: (agentId) => scheduler.removeSchedule(agentId),
  }),
};
