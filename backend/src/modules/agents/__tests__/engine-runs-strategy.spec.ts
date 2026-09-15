import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';

/**
 * The engine runs the strategy the agent chose.
 *
 * Everything else in L5 was green while this was false: the shape could
 * be described, listed, picked and saved, and `execute()` still built its
 * graph from `agent.pipeline`. A test on the resolver alone would not
 * have caught it either — the resolver was correct and unreached. This
 * drives the engine.
 */
describe('AgentExecutionEngine and a chosen strategy', () => {
  const compiledPipeline = {
    nodes: [
      { id: 'compiled-start', type: 'input', label: 'Input', position: { x: 0, y: 0 } },
      { id: 'answer', type: 'llm_call', label: 'call', position: { x: 1, y: 0 }, data: { roleKey: 'principal' } },
      { id: 'output', type: 'output', label: 'Output', position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'compiled-start', target: 'answer' },
      { id: 'e2', source: 'answer', target: 'output' },
    ],
  };

  const drawnPipeline = {
    nodes: [
      { id: 'drawn-start', type: 'input', label: 'Input', position: { x: 0, y: 0 } },
      { id: 'drawn', type: 'llm_call', label: 'drawn', position: { x: 1, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'drawn-start', target: 'drawn' },
      { id: 'e2', source: 'drawn', target: 'output' },
    ],
  };

  function makeEngine(resolver?: any) {
    const executionRepo = {
      create: jest.fn((data: any) => ({ id: 'exec-1', ...data })),
      save: jest.fn(async (e: any) => e),
    };
    const nodeExecutor = {
      execute: jest.fn(async (node: any) => ({ nodeId: node.id, output: {}, success: true, status: 'completed' })),
    };
    const engine = new AgentExecutionEngine(
      { findOne: jest.fn(), save: jest.fn() } as any,
      executionRepo as any,
      nodeExecutor as any,
      { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } as any,
      {
        emitEvent: jest.fn(),
        bumpAgentStats: jest.fn().mockResolvedValue(undefined),
        // Without this the engine's layer wrapper throws, the catch marks
        // the run TIMEOUT, and the nodes still execute — so assertions on
        // which nodes ran pass while the run's status is a lie.
        withTimeout: (promise: Promise<unknown>) => promise,
      } as any,
      undefined,
      resolver,
    );
    return { engine, nodeExecutor, executionRepo };
  }

  const agent = { id: 'a1', name: 'Agent', organizationId: 'org-1', pipeline: drawnPipeline } as any;

  it('runs the compiled shape instead of the drawn graph', async () => {
    const resolver = { pipelineFor: jest.fn().mockResolvedValue({ pipeline: compiledPipeline, strategyKey: 'single' }) };
    const { engine, nodeExecutor } = makeEngine(resolver);

    await engine.execute(agent, 'org-1', 'user-1', { input: {} });

    // The entry node identifies the graph the engine built from, without
    // depending on how far a mocked run gets down it.
    const ran = nodeExecutor.execute.mock.calls.map((c: any[]) => c[0].id);
    expect(ran).toContain('compiled-start');
    expect(ran).not.toContain('drawn-start');
  });

  it('records which strategy the run used, so the run view can say', async () => {
    const resolver = { pipelineFor: jest.fn().mockResolvedValue({ pipeline: compiledPipeline, strategyKey: 'cascade' }) };
    const { engine, executionRepo } = makeEngine(resolver);

    const execution = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

    expect(execution.metadata.strategyKey).toBe('cascade');
    expect(executionRepo.save).toHaveBeenCalled();
  });

  it('runs the drawn graph when the agent has chosen no strategy', async () => {
    const resolver = { pipelineFor: jest.fn().mockResolvedValue(null) };
    const { engine, nodeExecutor } = makeEngine(resolver);

    await engine.execute(agent, 'org-1', 'user-1', { input: {} });

    expect(nodeExecutor.execute.mock.calls.map((c: any[]) => c[0].id)).toContain('drawn-start');
  });

  it('runs the drawn graph when nothing provides the resolver at all', async () => {
    // Harnesses that construct the engine without L5 must keep working.
    const { engine, nodeExecutor } = makeEngine(undefined);

    await engine.execute(agent, 'org-1', 'user-1', { input: {} });

    expect(nodeExecutor.execute.mock.calls.map((c: any[]) => c[0].id)).toContain('drawn-start');
  });

  it('fails the run with the compiler\'s reason rather than falling back silently', async () => {
    const resolver = {
      pipelineFor: jest.fn().mockRejectedValue(new Error('Strategy "cascade" needs role slots that are not bound: drafter')),
    };
    const { engine, nodeExecutor } = makeEngine(resolver);

    const execution = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(String(execution.error)).toContain('drafter');
    expect(nodeExecutor.execute).not.toHaveBeenCalled();
  });

  it('stops on the budget policy as DONE, not as a failure', async () => {
    // "Stop when good enough" and "ran out of money" are different
    // outcomes and a run that conflates them teaches the wrong lesson to
    // whoever reads it afterwards.
    const { engine, executionRepo, nodeExecutor } = makeEngine(undefined);
    // Costed nodes, so the ceiling is genuinely crossed rather than the
    // rule firing on a zero that proves nothing.
    nodeExecutor.execute.mockImplementation(async (node: any) => ({
      nodeId: node.id,
      output: {},
      success: true,
      cost: 0.05,
      status: 'completed',
    }));
    const budgeted = {
      ...agent,
      settings: { budget: { ceilingPerRun: 1, stopWhen: {} } },
    } as any;

    const execution = await engine.execute(budgeted, 'org-1', 'user-1', { input: {} });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.metadata.budgetStop.reason).toContain('ceiling');
    expect(executionRepo.save).toHaveBeenCalled();
  });

  it('leaves an agent with no budget policy exactly as it was', async () => {
    const { engine } = makeEngine(undefined);
    const execution = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

    expect(execution.metadata?.budgetStop).toBeUndefined();
  });
});
