import { membershipFixture } from '../../../test/execution-access.fixture';
import { AgentRuntimeProcessor } from '../agent-runtime.processor';
import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A run's user is a users row or nobody.
 *
 * startRun writes the user onto the run's conversation, and
 * `conversations."userId"` is a uuid with a foreign key to `users`.
 * The heartbeat started every run as the string 'system', and
 * invoke_agent did the same for a child of any visitor run (whose user
 * is null): Postgres refuses 'system' in a uuid column ("invalid input
 * syntax for type uuid"), so every heartbeat tick and every agent a
 * visitor-driven run invoked failed before the run existed.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

const isUserOrNobody = (userId: unknown) => userId === null || (typeof userId === 'string' && UUID_RE.test(userId));

describe('heartbeat runs', () => {
  function build(agent: Record<string, any>) {
    const startRun = jest.fn(async () => ({ id: 'run-1' }));
    const agents = fakeRepository<any>([agent]);
    // The real execution gate, with the owner a member of the agent's org.
    const m = membershipFixture();
    m.member('org-1', OWNER);
    const runtime = { startRun, executionAccess: m.executionAccess, disableHeartbeat: jest.fn() };
    const processor = new AgentRuntimeProcessor(runtime as any, {} as any, agents as any, fakeRepository() as any);
    const job: any = { data: { agentId: agent.id, organizationId: 'org-1' } };
    return { processor, startRun, job };
  }

  const heartbeat = { enabled: true, prompt: 'check in' };

  it('run as the agent\'s owner', async () => {
    const { processor, startRun, job } = build({ id: 'a-1', organizationId: 'org-1', createdBy: OWNER, heartbeat });
    await processor.handleHeartbeat(job);
    expect(startRun).toHaveBeenCalledTimes(1);
    const userId = (startRun.mock.calls[0] as any[])[2];
    expect(isUserOrNobody(userId)).toBe(true);
    expect(userId).toBe(OWNER);
  });

  it('run as nobody when the agent records no owner', async () => {
    const { processor, startRun, job } = build({ id: 'a-2', organizationId: 'org-1', createdBy: null, heartbeat });
    await processor.handleHeartbeat(job);
    expect((startRun.mock.calls[0] as any[])[2]).toBeNull();
  });

  it('run as nobody when the recorded owner is not a user id (a temporary agent)', async () => {
    const { processor, startRun, job } = build({ id: 'a-3', organizationId: 'org-1', createdBy: 'system', heartbeat });
    await processor.handleHeartbeat(job);
    expect((startRun.mock.calls[0] as any[])[2]).toBeNull();
  });
});

describe('invoke_agent from a visitor run', () => {
  it('starts the child as nobody, not as the string "system"', async () => {
    const startRun = jest.fn(async () => ({ id: 'child-1' }));
    const waitForRun = jest.fn(async () => ({ status: AgentRunStatus.COMPLETED, output: 'ok' }));
    const helper = new AgentBuiltInToolsHelper(
      fakeRepository() as any,
      {} as any,
      {} as any,
      { startRun, waitForRun } as any,
      {} as any,
    );
    const visitorRun: any = { id: 'run-v', organizationId: 'org-1', userId: null, endUserId: 'visitor-7' };

    await helper.executeBuiltInTool('invoke_agent', { agentId: 'child-agent', input: 'hi' }, visitorRun, {} as any);

    expect(startRun).toHaveBeenCalledTimes(1);
    const [, , userId, , options] = startRun.mock.calls[0] as any[];
    expect(isUserOrNobody(userId)).toBe(true);
    // The visitor is still who the child works for.
    expect(options).toMatchObject({ parentRunId: 'run-v', endUserId: 'visitor-7' });
  });

  it('keeps a member run\'s user', async () => {
    const startRun = jest.fn(async () => ({ id: 'child-2' }));
    const waitForRun = jest.fn(async () => ({ status: AgentRunStatus.COMPLETED, output: 'ok' }));
    const helper = new AgentBuiltInToolsHelper(fakeRepository() as any, {} as any, {} as any, { startRun, waitForRun } as any, {} as any);
    const memberRun: any = { id: 'run-m', organizationId: 'org-1', userId: OWNER, endUserId: null };

    await helper.executeBuiltInTool('invoke_agent', { agentId: 'child-agent', input: 'hi' }, memberRun, {} as any);

    expect((startRun.mock.calls[0] as any[])[2]).toBe(OWNER);
  });
});
