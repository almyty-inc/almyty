import { AgentSchedulerService } from '../agent-scheduler.service';
import { AgentStatus } from '../../../entities/agent.entity';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A scheduled run is the agent owner's as the agent stands now.
 *
 * The repeatable job snapshots `userId: agent.createdBy || 'system'` when
 * the schedule is enqueued, and the processor ran with that snapshot on
 * every tick for as long as the job lived. When a member leaves, their
 * private agents are handed to another member (resource-handover), but
 * the schedule kept running as the departed member -- whose runs the
 * private-visibility checks then refuse, so the handed-over schedule
 * failed on every tick -- and an agent with no owner ran as the string
 * 'system', which is not a users row.
 */
const OLD_OWNER = '11111111-1111-4111-8111-111111111111';
const NEW_OWNER = '22222222-2222-4222-8222-222222222222';

function build(agent: Record<string, any>) {
  const execute = jest.fn(async () => ({ nodeResults: [] }));
  const agents = fakeRepository<any>([agent]);
  // The owner a tick runs as has to be a current member (see the owner
  // membership checks in agent-scheduler.service.spec.ts).
  const users = fakeRepository<any>([
    { id: NEW_OWNER, isActive: true, organizationMemberships: [{ organizationId: 'org-1', role: 'member', isActive: true }] },
  ]);
  const scheduler = new AgentSchedulerService({} as any, { execute } as any, agents as any, {} as any, users as any);
  return { scheduler, execute };
}

const base = {
  id: 'a-1',
  organizationId: 'org-1',
  status: AgentStatus.ACTIVE,
  settings: { schedule: { enabled: true, intervalMinutes: 60 } },
};

describe('scheduled runs use the agent\'s current owner', () => {
  it('runs as whoever owns the agent now, not whoever did when the job was queued', async () => {
    const { scheduler, execute } = build({ ...base, visibility: 'private', createdBy: NEW_OWNER });
    await scheduler.handleScheduledExecution({
      data: { agentId: 'a-1', organizationId: 'org-1', userId: OLD_OWNER, input: {} },
    } as any);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0] as any[])[2]).toBe(NEW_OWNER);
  });

  it('runs as nobody, not as \'system\', when the agent records no owner', async () => {
    const { scheduler, execute } = build({ ...base, createdBy: null });
    await scheduler.handleScheduledExecution({
      data: { agentId: 'a-1', organizationId: 'org-1', userId: 'system', input: {} },
    } as any);
    expect((execute.mock.calls[0] as any[])[2]).toBeNull();
  });
});
