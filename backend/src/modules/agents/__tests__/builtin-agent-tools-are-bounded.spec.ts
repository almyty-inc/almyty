import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { Agent } from '../../../entities/agent.entity';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { fakeManager, fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { Tool } from '../../../entities/tool.entity';
import { membershipFixture } from '../../../test/execution-access.fixture';

/**
 * `create_agent` and `invoke_agent` are the two built-ins an autonomous
 * agent uses to grow its own reach, and neither was bounded by the parent.
 *
 *  - create_agent took `toolIds` from the model's arguments verbatim, so a
 *    parent limited to one tool could mint a child holding any tool in the
 *    organization.
 *  - invoke_agent passed `agentId` straight to startRun, so a run could
 *    start any agent its user could see, whatever the parent's call list
 *    (the call_agent_* set) said.
 *  - Both ran whether or not the agent had canCreateAgents: the flag only
 *    decided whether the tools were offered, and a tool call is whatever
 *    name the model emits.
 */
describe('built-in create_agent / invoke_agent stay inside the parent', () => {
  const ORG = 'org-1';
  const run: any = { id: 'run-1', organizationId: ORG, userId: 'user-1' };

  let agents: FakeRepository<Agent>;
  let runtime: { startRun: jest.Mock; waitForRun: jest.Mock; executionAccess: any };
  let helper: AgentBuiltInToolsHelper;

  const parent = (agentConfig: Record<string, any>, over: Partial<Agent> = {}) =>
    ({
      id: 'parent',
      name: 'Parent',
      organizationId: ORG,
      toolIds: ['tool-a'],
      visibility: 'org',
      createdBy: 'user-1',
      agentConfig,
      ...over,
    }) as unknown as Agent;

  beforeEach(() => {
    agents = fakeRepository<Agent>({
      idPrefix: 'agent',
      seed: [
        { id: 'parent', organizationId: ORG, status: 'active', isTemporary: false, visibility: 'org', createdBy: 'user-1' } as any,
        { id: 'listed', organizationId: ORG, status: 'active', isTemporary: false, visibility: 'org', createdBy: 'user-2' } as any,
        { id: 'others-private', organizationId: ORG, status: 'active', isTemporary: false, visibility: 'private', createdBy: 'user-1' } as any,
        { id: 'other-runs-temp', organizationId: ORG, status: 'active', isTemporary: true, parentRunId: 'run-9' } as any,
        { id: 'own-temp', organizationId: ORG, status: 'active', isTemporary: true, parentRunId: 'run-1' } as any,
        { id: 'foreign', organizationId: 'org-2', status: 'active', isTemporary: false, visibility: 'org' } as any,
      ],
    });
    // The tools a child may be given are also checked against the run's
    // scope; here every tool is org-wide and user-1 is a member.
    const tools = fakeRepository<Tool>({
      seed: [
        { id: 'tool-a', organizationId: ORG, visibility: 'org', teamId: null, createdBy: 'user-1' } as any,
        { id: 'tool-admin', organizationId: ORG, visibility: 'org', teamId: null, createdBy: 'user-1' } as any,
      ],
    });
    fakeManager([[Agent, agents], [Tool, tools]]);
    const m = membershipFixture();
    m.member(ORG, 'user-1');
    runtime = {
      startRun: jest.fn(async (agentId: string) => ({ id: `child-of-${agentId}` })),
      waitForRun: jest.fn(async () => ({ status: AgentRunStatus.COMPLETED, output: 'done' })),
      executionAccess: m.executionAccess,
    };
    helper = new AgentBuiltInToolsHelper(agents as any, {} as any, {} as any, runtime as any, {} as any);
  });

  describe('create_agent', () => {
    it('refuses without canCreateAgents, even when the model calls it anyway', async () => {
      const out = await helper.executeBuiltInTool('create_agent', { name: 'x', instructions: 'y' }, run, parent({}));
      expect(out?.error).toMatch(/not allowed/);
      expect(agents.rows().filter((a) => a.parentRunId === 'run-1' && a.id !== 'own-temp')).toHaveLength(0);
    });

    it('refuses tools the parent does not have', async () => {
      const out = await helper.executeBuiltInTool(
        'create_agent',
        { name: 'x', instructions: 'y', toolIds: ['tool-a', 'tool-admin'] },
        run,
        parent({ canCreateAgents: true }),
      );
      expect(out?.error).toMatch(/tool-admin/);
      expect(agents.rows().some((a) => (a.toolIds ?? []).includes('tool-admin'))).toBe(false);
    });

    it('creates a child with a subset of the parent tools', async () => {
      const out = await helper.executeBuiltInTool(
        'create_agent',
        { name: 'x', instructions: 'y', toolIds: ['tool-a'] },
        run,
        parent({ canCreateAgents: true }),
      );
      const child = agents.row(out!.result.agentId)!;
      expect(child.toolIds).toEqual(['tool-a']);
      expect(child.parentRunId).toBe('run-1');
    });
  });

  describe('invoke_agent', () => {
    const invoke = (agentId: string, agentConfig: Record<string, any>, over: Partial<Agent> = {}) =>
      helper.executeBuiltInTool('invoke_agent', { agentId, input: 'hi' }, run, parent(agentConfig, over));

    it('refuses without canCreateAgents', async () => {
      expect((await invoke('own-temp', {}))?.error).toBeDefined();
      expect(runtime.startRun).not.toHaveBeenCalled();
    });

    it.each([
      ['a listed agent when the parent may not call agents', 'listed', { canCreateAgents: true }],
      ['another run\'s temporary agent', 'other-runs-temp', { canCreateAgents: true, canCallAgents: true }],
      ['a private agent from a non-private parent', 'others-private', { canCreateAgents: true, canCallAgents: true }],
      ['an agent in another organization', 'foreign', { canCreateAgents: true, canCallAgents: true }],
      ['itself', 'parent', { canCreateAgents: true, canCallAgents: true }],
      ['an id that does not exist', 'nope', { canCreateAgents: true, canCallAgents: true }],
    ])('refuses %s', async (_label, agentId, cfg) => {
      const out = await invoke(agentId, cfg);
      expect(out?.error).toMatch(/not callable|not found/);
      expect(runtime.startRun).not.toHaveBeenCalled();
    });

    it('starts a temporary agent this run created', async () => {
      const out = await invoke('own-temp', { canCreateAgents: true });
      expect(out?.result).toEqual({ status: 'completed', output: 'done' });
      expect(runtime.startRun).toHaveBeenCalledWith('own-temp', ORG, 'user-1', 'hi', expect.objectContaining({ parentRunId: 'run-1' }));
    });

    it('starts an agent on the call list when the parent may call agents', async () => {
      await invoke('listed', { canCreateAgents: true, canCallAgents: true });
      expect(runtime.startRun).toHaveBeenCalledWith('listed', ORG, 'user-1', 'hi', expect.anything());
    });

    it('passes no made-up user for a run that has none', async () => {
      await helper.executeBuiltInTool('invoke_agent', { agentId: 'own-temp', input: 'hi' }, { ...run, userId: null }, parent({ canCreateAgents: true }));
      expect(runtime.startRun.mock.calls[0][2]).toBeNull();
    });
  });
});
