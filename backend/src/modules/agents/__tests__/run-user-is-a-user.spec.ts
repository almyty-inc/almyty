import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { AGENT, ORG, OWNER, alwaysOnAgent, world } from '../always-on/__tests__/always-on.harness';

/**
 * A run's user is a users row or nobody.
 *
 * startRun writes the user onto the run's conversation, and
 * `conversations."userId"` is a uuid with a foreign key to `users`.
 * A heartbeat (now an always-on wake) started every run as the string 'system', and
 * invoke_agent did the same for a child of any visitor run (whose user
 * is null): Postgres refuses 'system' in a uuid column ("invalid input
 * syntax for type uuid"), so every heartbeat tick and every agent a
 * visitor-driven run invoked failed before the run existed.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The always-on harness's owner (a user id) and agent.

const isUserOrNobody = (userId: unknown) => userId === null || (typeof userId === 'string' && UUID_RE.test(userId));

describe('always-on runs', () => {
  async function wakeAndRun(createdBy: string | null) {
    const w = world({ agent: alwaysOnAgent({ createdBy }) });
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'the timer', dedupeKey: 't1' });
    await w.service.process(AGENT, ORG);
    return w.startRun;
  }

  it('run as the agent\'s owner', async () => {
    const startRun = await wakeAndRun(OWNER);
    expect(startRun).toHaveBeenCalledTimes(1);
    const userId = (startRun.mock.calls[0] as any[])[2];
    expect(isUserOrNobody(userId)).toBe(true);
    expect(userId).toBe(OWNER);
  });

  it('run as nobody when the agent records no owner', async () => {
    const startRun = await wakeAndRun(null);
    expect((startRun.mock.calls[0] as any[])[2]).toBeNull();
  });

  it('run as nobody when the recorded owner is not a user id (a temporary agent)', async () => {
    const startRun = await wakeAndRun('system');
    expect((startRun.mock.calls[0] as any[])[2]).toBeNull();
  });
});

describe('invoke_agent from a visitor run', () => {
  // invoke_agent needs a parent allowed to create agents and a target it
  // may start: here, the temporary agent the run itself created.
  const parent: any = { id: 'parent', agentConfig: { canCreateAgents: true } };
  const childOf = (runId: string) =>
    fakeRepository<any>([{ id: 'child-agent', organizationId: 'org-1', isTemporary: true, parentRunId: runId, status: 'active' }]);

  it('starts the child as nobody, not as the string "system"', async () => {
    const startRun = jest.fn(async () => ({ id: 'child-1' }));
    const waitForRun = jest.fn(async () => ({ status: AgentRunStatus.COMPLETED, output: 'ok' }));
    const helper = new AgentBuiltInToolsHelper(
      childOf('run-v') as any,
      {} as any,
      { startRun, waitForRun } as any,
      {} as any,
    );
    const visitorRun: any = { id: 'run-v', organizationId: 'org-1', userId: null, endUserId: 'visitor-7' };

    await helper.executeBuiltInTool('invoke_agent', { agentId: 'child-agent', input: 'hi' }, visitorRun, parent);

    expect(startRun).toHaveBeenCalledTimes(1);
    const [, , userId, , options] = startRun.mock.calls[0] as any[];
    expect(isUserOrNobody(userId)).toBe(true);
    // The visitor is still who the child works for.
    expect(options).toMatchObject({ parentRunId: 'run-v', endUserId: 'visitor-7' });
  });

  it('keeps a member run\'s user', async () => {
    const startRun = jest.fn(async () => ({ id: 'child-2' }));
    const waitForRun = jest.fn(async () => ({ status: AgentRunStatus.COMPLETED, output: 'ok' }));
    const helper = new AgentBuiltInToolsHelper(childOf('run-m') as any, {} as any, { startRun, waitForRun } as any, {} as any);
    const memberRun: any = { id: 'run-m', organizationId: 'org-1', userId: OWNER, endUserId: null };

    await helper.executeBuiltInTool('invoke_agent', { agentId: 'child-agent', input: 'hi' }, memberRun, parent);

    expect((startRun.mock.calls[0] as any[])[2]).toBe(OWNER);
  });
});