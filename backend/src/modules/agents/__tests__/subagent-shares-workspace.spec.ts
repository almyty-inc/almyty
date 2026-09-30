import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';

/**
 * One job, one folder: a workflow's sub_agent node runs its child with the
 * top-level run's id as workspaceRunId, so the child's runner tool calls
 * work in the parent's workspace (RunWorkspaceService) instead of getting
 * a folder of their own.
 */
describe('a workflow sub-agent shares its parent run\'s workspace', () => {
  it('hands the parent\'s workspaceRunId to the child run', async () => {
    const executors = Object.create(AgentSubAgentExecutors.prototype) as AgentSubAgentExecutors;
    const internal: any[] = [];
    (executors as any).templateResolver = { resolve: (t: string) => t };
    (executors as any).agentRepository = { findOne: async () => ({ id: 'child', name: 'child' }) };
    (executors as any).executionEngine = {
      execute: async (_a: any, _o: string, _u: string, _opts: any, _onEvent: any, internalOptions: any) => {
        internal.push(internalOptions);
        return { status: 'completed', output: 'ok', totalCost: 0, totalTokens: 0 };
      },
    };

    await executors.executeSubAgentNode(
      { id: 'sub_1', type: 'sub_agent', data: { agentId: 'child' } } as any,
      { input: {}, nodes: {} } as any,
      { organizationId: 'org-1', userId: 'user-1', workspaceRunId: 'exec-root', nestingDepth: 0 } as any,
    );

    expect(internal[0]).toMatchObject({ workspaceRunId: 'exec-root', nestingDepth: 1 });
  });
});
