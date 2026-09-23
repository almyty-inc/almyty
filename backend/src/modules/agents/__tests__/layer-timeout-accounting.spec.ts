import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentWebhookService } from '../agent-webhook.service';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';

/**
 * A layer timeout used to lose both the work and its cost.
 *
 * `withTimeout` is a Promise.race, which stops waiting but does not
 * stop running: the layer's node promises carried on against the
 * provider and could still write side effects after the execution row
 * said TIMEOUT. And the handler persisted `totalCost` — the total as of
 * the *previous* layer — because the layer's running total only reaches
 * `totalCost` when the layer's results are processed, which on this
 * path never happens. Every layer timeout therefore undercounted spend,
 * and `bumpAgentStats` carried the undercount into the agent's lifetime
 * cost, which is what budget enforcement reads.
 */
describe('AgentExecutionEngine - a layer that times out', () => {
  let engine: AgentExecutionEngine;
  let agentRepo: any;
  let agentExecutionRepo: any;
  let nodeExecutor: any;
  /** The signal each node was handed, so the test can see it abort. */
  let signals: Record<string, AbortSignal>;

  const fanOutAgent = (): Agent => {
    const agent = new Agent();
    agent.id = 'agent-1';
    agent.name = 'Fan out';
    agent.organizationId = 'org-1';
    agent.status = AgentStatus.ACTIVE;
    agent.version = '1.0.0';
    // Two nodes in one layer: one returns with a cost before the
    // deadline, one is still in flight when it passes.
    agent.pipeline = {
      nodes: [
        { id: 'input_1', type: 'input', config: {} },
        { id: 'llm_fast', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'x' } },
        { id: 'llm_slow', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'y' } },
        { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_fast.output}}' } },
      ],
      edges: [
        { id: 'e1', source: 'input_1', target: 'llm_fast' },
        { id: 'e2', source: 'input_1', target: 'llm_slow' },
        { id: 'e3', source: 'llm_fast', target: 'output_1' },
        { id: 'e4', source: 'llm_slow', target: 'output_1' },
      ],
    } as any;
    agent.variables = {};
    agent.settings = { maxExecutionTime: 120 } as any;
    agent.metadata = {};
    agent.totalExecutions = 0;
    agent.successfulExecutions = 0;
    agent.totalCost = 0;
    agent.averageExecutionTime = 0;
    agent.createdBy = 'user-1';
    return agent;
  };

  beforeEach(async () => {
    signals = {};
    const updateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const qbUpdateChain = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: updateExecute,
    };
    agentRepo = {
      save: jest.fn(async (a: any) => a),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(qbUpdateChain),
      __qbUpdateChain: qbUpdateChain,
    };

    const execution = new AgentExecution();
    execution.id = 'exec-1';
    execution.agentId = 'agent-1';
    execution.organizationId = 'org-1';
    execution.status = AgentExecutionStatus.RUNNING;
    execution.nodeResults = {};
    execution.totalCost = 0;
    execution.totalTokens = 0;
    agentExecutionRepo = {
      create: jest.fn().mockReturnValue(execution),
      save: jest.fn(async (e: any) => e),
      // Terminal writes are a guarded UPDATE now (see commitTerminal);
      // apply the partial so assertions on the persisted cost still see
      // what the engine wrote.
      update: jest.fn(async (_criteria: any, partial: any) => {
        Object.assign(execution, partial);
        return { affected: 1 };
      }),
    };

    nodeExecutor = {
      execute: jest.fn(async (node: any, _ctx: any, _org: any, _user: any, opts: any) => {
        signals[node.id] = opts?.signal;
        if (node.type === 'input') return { output: { message: 'hi' } };
        if (node.id === 'llm_fast') {
          await new Promise((r) => setTimeout(r, 10));
          return { output: 'fast', cost: 0.07, tokens: 100, executionTime: 10 };
        }
        // Runs until it is cancelled, which is the point: nothing else
        // would ever stop it.
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (opts?.signal?.aborted) return onAbort();
          opts?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutionEngine,
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(AgentExecution), useValue: agentExecutionRepo },
        { provide: AgentNodeExecutor, useValue: nodeExecutor },
        { provide: AgentWebhookService, useValue: { sendExecutionWebhook: jest.fn() } },
        AgentExecutionStateHelper,
      ],
    }).compile();

    engine = module.get(AgentExecutionEngine);
  });

  const run = () =>
    engine.execute(fanOutAgent(), 'org-1', 'user-1', { input: { message: 'hi' } });

  it('aborts the layer, so the abandoned node actually stops', async () => {
    const result = await run();

    expect(result.status).toBe(AgentExecutionStatus.TIMEOUT);
    expect(signals['llm_slow']?.aborted).toBe(true);
  });

  it('keeps the cost of the work that completed before the deadline', async () => {
    const result = await run();

    expect(result.totalCost).toBeCloseTo(0.07, 6);
  });

  it('carries that cost into the agent lifetime total, which budgets read', async () => {
    await run();

    const set = agentRepo.__qbUpdateChain.set.mock.calls.at(-1)[0];
    expect(String(set.totalCost())).toContain('0.07');
  });

  it('says which node cost could not be determined instead of recording zero', async () => {
    const result = await run();

    expect(result.error).toContain('llm_slow');
    expect(result.error).toMatch(/could not be determined/);
    expect(result.nodeResults!['llm_slow']).toMatchObject({ costAccounted: false });
  });
});
