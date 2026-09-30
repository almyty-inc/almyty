import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { Agent } from '../../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Tool } from '../../../entities/tool.entity';
import { fakeManager, fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';

/**
 * The Capabilities section's limits on the two built-ins an agent grows
 * its reach with, enforced where the model's call lands:
 *
 *  - create_agent: at most `maxTemporaryAgents` in one run, and at most
 *    `maxTemporaryAgentsAlive` of its temporary agents existing at once
 *    across all its runs.
 *  - invoke_agent: only the agents it was given (`callableAgentIds`).
 */
describe('temporary agent limits and the agents it may call', () => {
  const ORG = 'org-1';
  const run: any = { id: 'run-1', organizationId: ORG, userId: 'user-1' };
  let agents: FakeRepository<Agent>;
  let runtime: { startRun: jest.Mock; waitForRun: jest.Mock; executionAccess: any };
  let helper: AgentBuiltInToolsHelper;

  const parent = (agentConfig: Record<string, any>) =>
    ({ id: 'parent', name: 'Parent', organizationId: ORG, toolIds: [], visibility: 'org', createdBy: 'user-1', agentConfig }) as unknown as Agent;
  const create = (agentConfig: Record<string, any>) =>
    helper.executeBuiltInTool('create_agent', { name: 'Helper', instructions: 'help' }, run, parent(agentConfig));
  const temporaryOf = (runId: string) => agents.rows().filter((a) => a.isTemporary && a.parentRunId === runId);

  beforeEach(() => {
    agents = fakeRepository<Agent>({
      idPrefix: 'agent',
      seed: [
        { id: 'parent', organizationId: ORG, status: 'active', isTemporary: false, visibility: 'org', createdBy: 'user-1' } as any,
        { id: 'billing', organizationId: ORG, status: 'active', isTemporary: false, visibility: 'org', createdBy: 'user-2' } as any,
        { id: 'returns', organizationId: ORG, status: 'active', isTemporary: false, visibility: 'org', createdBy: 'user-2' } as any,
        // A temporary agent another run of this agent still has.
        { id: 'temp-of-run-2', organizationId: ORG, status: 'active', isTemporary: true, parentRunId: 'run-2' } as any,
        // One of another agent's runs: not counted against this one.
        { id: 'temp-of-other', organizationId: ORG, status: 'active', isTemporary: true, parentRunId: 'run-x' } as any,
      ],
    });
    const runs = fakeRepository<AgentRun>({
      seed: [
        { id: 'run-1', agentId: 'parent', organizationId: ORG } as any,
        { id: 'run-2', agentId: 'parent', organizationId: ORG } as any,
        { id: 'run-x', agentId: 'someone-else', organizationId: ORG } as any,
      ],
    });
    fakeManager([[Agent, agents], [Tool, fakeRepository<Tool>({ seed: [] })], [AgentRun, runs]]);
    const m = membershipFixture();
    m.member(ORG, 'user-1');
    runtime = {
      startRun: jest.fn(async (agentId: string) => ({ id: `child-of-${agentId}` })),
      waitForRun: jest.fn(async () => ({ status: AgentRunStatus.COMPLETED, output: 'done' })),
      executionAccess: m.executionAccess,
    };
    helper = new AgentBuiltInToolsHelper(agents as any, {} as any, runtime as any, {} as any);
  });

  it('creates up to the per-run limit, and refuses the next one', async () => {
    const cfg = { canCreateAgents: true, maxTemporaryAgents: 2 };
    expect((await create(cfg))?.result?.status).toBe('created');
    expect((await create(cfg))?.result?.status).toBe('created');
    const third = await create(cfg);
    expect(third?.error).toBe('This agent may create at most 2 temporary agents per run');
    expect(temporaryOf('run-1')).toHaveLength(2);
  });

  it('counts its temporary agents alive across its runs, not other agents\'', async () => {
    // run-2's temporary agent is alive; another agent's is not counted.
    const cfg = { canCreateAgents: true, maxTemporaryAgents: 5, maxTemporaryAgentsAlive: 2 };
    expect((await create(cfg))?.result?.status).toBe('created');
    const next = await create(cfg);
    expect(next?.error).toBe('This agent may have at most 2 temporary agents at once');
    expect(temporaryOf('run-1')).toHaveLength(1);
  });

  it('refuses every create when it may not create agents', async () => {
    expect((await create({ canCreateAgents: false, maxTemporaryAgents: 3 }))?.error).toMatch(/not allowed/);
    expect(temporaryOf('run-1')).toHaveLength(0);
  });

  it('invokes an agent it was given, and refuses one it was not', async () => {
    const cfg = { canCreateAgents: true, canCallAgents: true, callableAgentIds: ['billing'] };
    const invoke = (agentId: string) => helper.executeBuiltInTool('invoke_agent', { agentId, input: 'hi' }, run, parent(cfg));
    expect((await invoke('returns'))?.error).toBe('Agent not found or not callable from this agent');
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect((await invoke('billing'))?.result).toEqual({ status: 'completed', output: 'done' });
    expect(runtime.startRun).toHaveBeenCalledWith('billing', ORG, 'user-1', 'hi', expect.anything());
  });
});
