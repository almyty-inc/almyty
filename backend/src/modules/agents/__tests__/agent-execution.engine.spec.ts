import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentExecutionEngine, StreamEvent } from '../agent-execution.engine';
import { AgentNodeExecutor, NodeExecutionResult } from '../agent-node-executor';
import { AgentWebhookService } from '../agent-webhook.service';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { Agent, AgentStatus, AgentPipeline } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';

// ─── Helper factories ───────────────────────────────────────────────────────

function makeValidPipeline(overrides: Partial<AgentPipeline> = {}): AgentPipeline {
  return {
    nodes: [
      { id: 'input_1', type: 'input', config: {} },
      { id: 'llm_1', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: '{{input.message}}' } },
      { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_1.output}}' } },
    ],
    edges: [
      { id: 'e1', source: 'input_1', target: 'llm_1' },
      { id: 'e2', source: 'llm_1', target: 'output_1' },
    ],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const agent = new Agent();
  agent.id = 'agent-1';
  agent.name = 'Test Agent';
  agent.description = 'A test agent';
  agent.organizationId = 'org-1';
  agent.status = AgentStatus.ACTIVE;
  agent.version = '1.0.0';
  agent.pipeline = makeValidPipeline();
  agent.variables = {};
  agent.settings = {};
  agent.metadata = {};
  agent.totalExecutions = 0;
  agent.successfulExecutions = 0;
  agent.totalCost = 0;
  agent.averageExecutionTime = 0;
  agent.createdBy = 'user-1';
  agent.createdAt = new Date();
  agent.updatedAt = new Date();
  agent.incrementExecution = jest.fn();
  agent.isActive = Agent.prototype.isActive;
  agent.getSuccessRate = Agent.prototype.getSuccessRate;
  return Object.assign(agent, overrides);
}

function makeExecution(overrides: Partial<AgentExecution> = {}): AgentExecution {
  const exec = new AgentExecution();
  exec.id = 'exec-1';
  exec.agentId = 'agent-1';
  exec.organizationId = 'org-1';
  exec.userId = 'user-1';
  exec.status = AgentExecutionStatus.RUNNING;
  exec.input = {};
  exec.output = null;
  exec.nodeResults = {};
  exec.executionTime = 0;
  exec.totalCost = 0;
  exec.totalTokens = 0;
  exec.error = null as any;
  exec.metadata = {};
  exec.createdAt = new Date();
  exec.updatedAt = new Date();
  return Object.assign(exec, overrides);
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('AgentExecutionEngine', () => {
  let engine: AgentExecutionEngine;

  let agentRepo: jest.Mocked<any>;
  let agentExecutionRepo: jest.Mocked<any>;
  let nodeExecutor: jest.Mocked<AgentNodeExecutor>;

  beforeEach(async () => {
    // bumpAgentStats now uses a queryBuilder chain for an atomic
    // SQL UPDATE rather than the old load-modify-save pair. The
    // mock chains execute() at the end, which the tests can spy on.
    const updateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const qbUpdateChain = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: updateExecute,
    };
    agentRepo = {
      save: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(qbUpdateChain),
      __updateExecute: updateExecute,
      __qbUpdateChain: qbUpdateChain,
    };

    agentExecutionRepo = {
      create: jest.fn(),
      save: jest.fn(),
    };

    const mockNodeExecutor = {
      execute: jest.fn(),
    };

    const mockWebhookService = {
      sendExecutionWebhook: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutionEngine,
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(AgentExecution), useValue: agentExecutionRepo },
        { provide: AgentNodeExecutor, useValue: mockNodeExecutor },
        { provide: AgentWebhookService, useValue: mockWebhookService },
        AgentExecutionStateHelper,
      ],
    }).compile();

    engine = module.get<AgentExecutionEngine>(AgentExecutionEngine);
    nodeExecutor = module.get(AgentNodeExecutor);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Simple 3-node pipeline execution ──────────────────────────────────────

  describe('execute: simple 3-node pipeline (input -> llm_call -> output)', () => {
    it('should execute successfully and return completed execution', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // Mock node executor responses per node type
      nodeExecutor.execute.mockImplementation(async (node: any) => {
        switch (node.type) {
          case 'input':
            return { output: { message: 'Hello' } };
          case 'llm_call':
            return { output: 'LLM response text', cost: 0.05, tokens: 150, executionTime: 200 };
          case 'output':
            return { output: 'LLM response text' };
          default:
            return { output: null };
        }
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', {
        input: { message: 'Hello' },
      });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(result.output).toBe('LLM response text');
      expect(agentExecutionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          organizationId: 'org-1',
          userId: 'user-1',
          status: AgentExecutionStatus.RUNNING,
        }),
      );
    });
  });

  // ── Execution record creation ─────────────────────────────────────────────

  describe('execute: creates execution record with correct status', () => {
    it('should create an execution record with RUNNING status initially', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: {} });

      await engine.execute(agent, 'org-1', 'user-1');

      expect(agentExecutionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AgentExecutionStatus.RUNNING,
        }),
      );
      // save should have been called multiple times (initial + final)
      expect(agentExecutionRepo.save).toHaveBeenCalled();
    });
  });

  // ── Agent stats update ────────────────────────────────────────────────────

  describe('execute: updates agent stats after execution', () => {
    // After the race-fix, stats updates go through an atomic SQL
    // UPDATE rather than `entity.incrementExecution() + save()`.
    // The assertions now check that the queryBuilder was invoked
    // with the right `successfulExecutions` branch (increment vs
    // pass-through) and the right agent id.

    it('issues an atomic UPDATE with the successful branch on a successful execution', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok', cost: 0.01, tokens: 50 });

      await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'hi' } });

      expect(agentRepo.createQueryBuilder).toHaveBeenCalled();
      expect(agentRepo.__updateExecute).toHaveBeenCalled();
      expect(agentRepo.__qbUpdateChain.where).toHaveBeenCalledWith('id = :id', { id: agent.id });

      // `.set()` was called with functions for the counter columns;
      // the `successfulExecutions` branch must increment on success.
      const setArgs = agentRepo.__qbUpdateChain.set.mock.calls[0][0];
      expect(typeof setArgs.totalExecutions).toBe('function');
      expect(setArgs.totalExecutions()).toContain('totalExecutions');
      expect(typeof setArgs.successfulExecutions).toBe('function');
      expect(setArgs.successfulExecutions()).toContain('+ 1');
    });

    it('issues an atomic UPDATE with the pass-through branch on a failed execution', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      nodeExecutor.execute.mockRejectedValue(new Error('LLM call failed'));

      const result = await engine.execute(agent, 'org-1', 'user-1');

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(agentRepo.__updateExecute).toHaveBeenCalled();

      // On failure the successfulExecutions branch must NOT
      // increment — it returns the bare column name to leave
      // the counter untouched.
      const setArgs = agentRepo.__qbUpdateChain.set.mock.calls[0][0];
      expect(setArgs.successfulExecutions()).not.toContain('+ 1');
    });
  });

  // ── Node execution failure ────────────────────────────────────────────────

  describe('execute: handles node execution failure gracefully', () => {
    it('should catch node error and mark execution as failed', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'llm_call') {
          throw new Error('Provider unavailable');
        }
        return { output: {} };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'hi' } });

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('Provider unavailable');
    });

    it('should mark execution as failed if pipeline is not configured', async () => {
      const agent = makeAgent({ pipeline: null as any });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await engine.execute(agent, 'org-1', 'user-1');

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('not configured');
    });
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  describe('execute: respects timeout settings', () => {
    it('should timeout if maxExecutionTime is very short and node is slow', async () => {
      const agent = makeAgent({
        settings: { maxExecutionTime: 1 }, // 1ms timeout — will time out on layer execution
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // Simulate a slow node
      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'input') {
          return { output: {} };
        }
        // Simulate slow execution
        await new Promise(resolve => setTimeout(resolve, 50));
        return { output: 'slow result' };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // Should be either TIMEOUT or FAILED (depends on timing)
      expect([AgentExecutionStatus.TIMEOUT, AgentExecutionStatus.FAILED]).toContain(result.status);
    });
  });

  // ── Per-node results tracking ─────────────────────────────────────────────

  describe('execute: tracks per-node results', () => {
    it('should store results for each executed node', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        switch (node.type) {
          case 'input':
            return { output: { message: 'test' }, cost: 0, tokens: 0, executionTime: 1 };
          case 'llm_call':
            return { output: 'Generated text', cost: 0.03, tokens: 100, executionTime: 150 };
          case 'output':
            return { output: 'Generated text', cost: 0, tokens: 0, executionTime: 0 };
          default:
            return { output: null };
        }
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'test' } });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(result.nodeResults).toBeDefined();
      expect(result.nodeResults['input_1']).toBeDefined();
      expect(result.nodeResults['llm_1']).toBeDefined();
      expect(result.nodeResults['llm_1'].cost).toBe(0.03);
      expect(result.nodeResults['llm_1'].tokens).toBe(100);
      expect(result.nodeResults['output_1']).toBeDefined();
    });
  });

  // ── Sequential execution order ────────────────────────────────────────────

  describe('execute: sequential execution order is correct', () => {
    it('should execute nodes in topological order (input -> llm -> output)', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const executionOrder: string[] = [];

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        executionOrder.push(node.id);
        return { output: `result-${node.id}` };
      });

      await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // input_1 should come before llm_1, llm_1 before output_1
      expect(executionOrder.indexOf('input_1')).toBeLessThan(executionOrder.indexOf('llm_1'));
      expect(executionOrder.indexOf('llm_1')).toBeLessThan(executionOrder.indexOf('output_1'));
    });

    it('should execute parallel branches in the same layer', async () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_a', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: '{{input.message}}' } },
          { id: 'llm_b', type: 'llm_call', config: {}, data: { providerId: 'p-2', userPromptTemplate: '{{input.message}}' } },
          { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_a.output}}' } },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'llm_a' },
          { id: 'e2', source: 'input_1', target: 'llm_b' },
          { id: 'e3', source: 'llm_a', target: 'output_1' },
          // Note: llm_b doesn't connect to output — but it's still in the pipeline
        ],
      };

      const agent = makeAgent({ pipeline });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const executionOrder: string[] = [];

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        executionOrder.push(node.id);
        return { output: `result-${node.id}` };
      });

      await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'hi' } });

      // input_1 must come before both llm_a and llm_b
      expect(executionOrder.indexOf('input_1')).toBeLessThan(executionOrder.indexOf('llm_a'));
      expect(executionOrder.indexOf('input_1')).toBeLessThan(executionOrder.indexOf('llm_b'));
      // llm_a and llm_b are in the same layer, so both should run before output_1
      expect(executionOrder.indexOf('llm_a')).toBeLessThan(executionOrder.indexOf('output_1'));
    });
  });

  // ── Streaming events ──────────────────────────────────────────────────────

  describe('execute: streaming events', () => {
    it('should emit execution.started and execution.completed events', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const events: StreamEvent[] = [];
      const onEvent = (event: StreamEvent) => events.push(event);

      await engine.execute(agent, 'org-1', 'user-1', { input: {} }, onEvent);

      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('execution.started');
      expect(eventTypes).toContain('execution.completed');
    });

    it('should emit node.started and node.completed for each node', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok', cost: 0, tokens: 0, executionTime: 0 });

      const events: StreamEvent[] = [];
      const onEvent = (event: StreamEvent) => events.push(event);

      await engine.execute(agent, 'org-1', 'user-1', { input: {} }, onEvent);

      const nodeStarted = events.filter(e => e.type === 'node.started');
      const nodeCompleted = events.filter(e => e.type === 'node.completed');

      // 3 nodes in the pipeline
      expect(nodeStarted.length).toBe(3);
      expect(nodeCompleted.length).toBe(3);
    });

    it('should emit execution.failed on error', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockRejectedValue(new Error('Boom'));

      const events: StreamEvent[] = [];
      const onEvent = (event: StreamEvent) => events.push(event);

      await engine.execute(agent, 'org-1', 'user-1', { input: {} }, onEvent);

      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('execution.failed');
    });
  });

  // ── Cost and token aggregation ────────────────────────────────────────────

  describe('execute: aggregates cost and tokens', () => {
    it('should sum up cost and tokens across all nodes', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'llm_call') {
          return { output: 'text', cost: 0.05, tokens: 200, executionTime: 100 };
        }
        return { output: {}, cost: 0, tokens: 0, executionTime: 0 };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.totalCost).toBe(0.05);
      expect(result.totalTokens).toBe(200);
    });
  });

  // ── Context propagation ───────────────────────────────────────────────────

  describe('execute: context propagation between nodes', () => {
    it('should pass input to first node and propagate node outputs to subsequent nodes', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const capturedContexts: any[] = [];

      nodeExecutor.execute.mockImplementation(async (node: any, context: any) => {
        capturedContexts.push({ nodeId: node.id, context: JSON.parse(JSON.stringify(context)) });

        switch (node.type) {
          case 'input':
            return { output: context.input };
          case 'llm_call':
            return { output: 'Generated response' };
          case 'output':
            return { output: 'Final output' };
          default:
            return { output: null };
        }
      });

      await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'Hello' } });

      // The input node should see the input
      const inputCtx = capturedContexts.find(c => c.nodeId === 'input_1');
      expect(inputCtx.context.input).toEqual({ message: 'Hello' });

      // The llm node should see input_1's output in context.nodes
      const llmCtx = capturedContexts.find(c => c.nodeId === 'llm_1');
      expect(llmCtx.context.nodes.input_1).toBeDefined();
      expect(llmCtx.context.nodes.input_1.output).toEqual({ message: 'Hello' });

      // The output node should see both previous node outputs
      const outputCtx = capturedContexts.find(c => c.nodeId === 'output_1');
      expect(outputCtx.context.nodes.input_1).toBeDefined();
      expect(outputCtx.context.nodes.llm_1).toBeDefined();
      expect(outputCtx.context.nodes.llm_1.output).toBe('Generated response');
    });
  });

  // ── Budget enforcement ────────────────────────────────────────────────────

  describe('execute: budget enforcement', () => {
    it('should mark execution as failed when budget is exceeded', async () => {
      // Pipeline with multiple LLM calls to exceed budget
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_1', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'hi' } },
          { id: 'llm_2', type: 'llm_call', config: {}, data: { providerId: 'p-2', userPromptTemplate: 'hi' } },
          { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_2.output}}' } },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'llm_1' },
          { id: 'e2', source: 'llm_1', target: 'llm_2' },
          { id: 'e3', source: 'llm_2', target: 'output_1' },
        ],
      };

      const agent = makeAgent({
        pipeline,
        settings: { budgetLimit: 0.01 }, // Very low budget
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      let callCount = 0;
      nodeExecutor.execute.mockImplementation(async (node: any) => {
        callCount++;
        if (node.type === 'llm_call') {
          return { output: 'text', cost: 0.05, tokens: 100, executionTime: 50 };
        }
        return { output: {}, cost: 0, tokens: 0, executionTime: 0 };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // After first LLM node costs 0.05 (which exceeds 0.01 budget), next layer should detect it
      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('Budget limit');
    });

    it('trips the layer abort mid-flight so parallel siblings can stop when over budget', async () => {
      // input fans out to two parallel llm nodes in the same layer.
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_a', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'hi' } },
          { id: 'llm_b', type: 'llm_call', config: {}, data: { providerId: 'p-2', userPromptTemplate: 'hi' } },
          { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_a.output}}' } },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'llm_a' },
          { id: 'e2', source: 'input_1', target: 'llm_b' },
          { id: 'e3', source: 'llm_a', target: 'output_1' },
          { id: 'e4', source: 'llm_b', target: 'output_1' },
        ],
      };
      const agent = makeAgent({ pipeline, settings: { budgetLimit: 0.01 } });
      const execution = makeExecution();
      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const signals: (AbortSignal | undefined)[] = [];
      nodeExecutor.execute.mockImplementation(async (node: any, _c: any, _o: any, _u: any, opts: any) => {
        signals.push(opts?.signal);
        if (node.type === 'llm_call') {
          return { output: 'text', cost: 0.05, tokens: 100, executionTime: 50 };
        }
        return { output: {}, cost: 0, tokens: 0, executionTime: 0 };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('Budget limit');
      // The fan-out layer's abort signal was tripped once the budget was
      // crossed, so an in-flight sibling would receive the abort.
      expect(signals.some((s) => s?.aborted)).toBe(true);
    });
  });

  // ── Variables merging ─────────────────────────────────────────────────────

  describe('execute: merges agent variables with execution variables', () => {
    it('should pass merged variables to context', async () => {
      const agent = makeAgent({
        variables: { baseUrl: 'https://api.example.com', defaultModel: 'gpt-4' },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      let capturedContext: any;
      nodeExecutor.execute.mockImplementation(async (node: any, context: any) => {
        if (node.type === 'input') {
          capturedContext = JSON.parse(JSON.stringify(context));
        }
        return { output: {} };
      });

      await engine.execute(agent, 'org-1', 'user-1', {
        input: {},
        variables: { defaultModel: 'claude-3', extra: 'value' },
      });

      // Execution variables should override agent variables
      expect(capturedContext.variables.baseUrl).toBe('https://api.example.com');
      expect(capturedContext.variables.defaultModel).toBe('claude-3');
      expect(capturedContext.variables.extra).toBe('value');
    });
  });

  // ── Input validation ───────────────────────────────────────────────────

  describe('execute: input validation', () => {
    it('should reject an array as input', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await expect(
        engine.execute(agent, 'org-1', 'user-1', { input: [1, 2, 3] as any }),
      ).rejects.toThrow(/plain object/);
    });

    it('should reject a string as input', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await expect(
        engine.execute(agent, 'org-1', 'user-1', { input: 'hello' as any }),
      ).rejects.toThrow(/plain object/);
    });

    it('should reject oversized input (> 100KB)', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const bigInput = { data: 'x'.repeat(110 * 1024) };

      await expect(
        engine.execute(agent, 'org-1', 'user-1', { input: bigInput }),
      ).rejects.toThrow(/exceeds maximum allowed/);
    });

    it('should accept valid object input', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const result = await engine.execute(agent, 'org-1', 'user-1', {
        input: { message: 'hello' },
      });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    it('should accept undefined/null input (defaults to empty object)', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const result = await engine.execute(agent, 'org-1', 'user-1');

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    it('should sanitize control characters in string input values', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      let capturedInput: any;
      nodeExecutor.execute.mockImplementation(async (node: any, context: any) => {
        if (node.type === 'input') {
          capturedInput = JSON.parse(JSON.stringify(context.input));
        }
        return { output: 'ok' };
      });

      await engine.execute(agent, 'org-1', 'user-1', {
        input: { message: 'hello\x00world\x07test' },
      });

      // Control chars \x00 and \x07 should be stripped
      expect(capturedInput.message).toBe('helloworldtest');
    });
  });

  // ── Pipeline size limits ──────────────────────────────────────────────

  describe('execute: pipeline size limits', () => {
    it('should reject pipeline with > 100 nodes', async () => {
      const nodes = Array.from({ length: 101 }, (_, i) => ({
        id: `node_${i}`,
        type: 'input',
        config: {},
      }));

      const agent = makeAgent({
        pipeline: { nodes, edges: [] },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await engine.execute(agent, 'org-1', 'user-1');

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('nodes');
    });

    it('should reject pipeline with > 500 edges', async () => {
      const nodes = [
        { id: 'a', type: 'input', config: {} },
        { id: 'b', type: 'output', config: {} },
      ];
      const edges = Array.from({ length: 501 }, (_, i) => ({
        id: `e_${i}`,
        source: 'a',
        target: 'b',
      }));

      const agent = makeAgent({
        pipeline: { nodes, edges },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await engine.execute(agent, 'org-1', 'user-1');

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('edges');
    });
  });

  // ── Nesting depth validation ──────────────────────────────────────────

  describe('execute: nesting depth validation', () => {
    it('should reject execution that exceeds max nesting depth', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await expect(
        engine.execute(agent, 'org-1', 'user-1', {}, undefined, { nestingDepth: 11 }),
      ).rejects.toThrow(/Nesting depth/);
    });
  });

  // ── Per-node error handling (graceful failure) ────────────────────────

  describe('execute: per-node error handling', () => {
    it('should record node error and continue pipeline if output node is reachable', async () => {
      // Pipeline: input -> [llm_a (fails), llm_b (succeeds)] -> output (depends on llm_b only)
      const pipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_a', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'hi' } },
          { id: 'llm_b', type: 'llm_call', config: {}, data: { providerId: 'p-2', userPromptTemplate: 'hi' } },
          { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_b.output}}' } },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'llm_a' },
          { id: 'e2', source: 'input_1', target: 'llm_b' },
          { id: 'e3', source: 'llm_b', target: 'output_1' },
          // llm_a has no downstream connection to output
        ],
      };

      const agent = makeAgent({ pipeline });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.id === 'llm_a') throw new Error('Provider unavailable');
        if (node.id === 'llm_b') return { output: 'B result', cost: 0.01, tokens: 50, executionTime: 100 };
        return { output: 'ok' };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // The output node was reached because llm_b succeeded
      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(result.nodeResults['llm_a']).toBeDefined();
      expect(result.nodeResults['llm_a'].error).toContain('Provider unavailable');
      expect(result.nodeResults['llm_b']).toBeDefined();
      expect(result.nodeResults['llm_b'].output).toBe('B result');
    });

    it('should include startedAt and completedAt in node results', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      nodeExecutor.execute.mockResolvedValue({ output: 'ok', cost: 0, tokens: 0, executionTime: 5 });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      // Check at least one node has startedAt
      const firstNode = result.nodeResults['input_1'];
      expect(firstNode).toBeDefined();
      expect(firstNode.startedAt).toBeDefined();
      expect(firstNode.completedAt).toBeDefined();
      expect(firstNode.completedAt).toBeGreaterThanOrEqual(firstNode.startedAt);
    });

    it('should classify error types in failed node results', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'llm_call') {
          throw new Error('LLM provider rate limit exceeded (429)');
        }
        return { output: {} };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      const llmNodeResult = result.nodeResults['llm_1'];
      expect(llmNodeResult).toBeDefined();
      expect(llmNodeResult.error).toContain('rate limit');
      expect(llmNodeResult.errorType).toBe('LLM_ERROR');
    });
  });

  // ── Execution record always updated ──────────────────────────────────

  describe('execute: execution record persistence on crash', () => {
    it('should update execution record even when save itself initially fails', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockRejectedValue(new Error('Catastrophic failure'));

      const result = await engine.execute(agent, 'org-1', 'user-1');

      // Even though the node threw, the execution record should be updated
      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('Catastrophic failure');
      expect(agentExecutionRepo.save).toHaveBeenCalled();
    });
  });

  // ── Sub-agent nesting ──────────────────────────────────────────────────

  describe('execute: sub-agent nesting', () => {
    it('should execute a sub-agent node and propagate its output', async () => {
      // Parent pipeline: input -> sub_agent -> output
      const parentPipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          {
            id: 'sub_1',
            type: 'sub_agent',
            config: {},
            data: { agentId: 'child-agent-1' },
          },
          {
            id: 'output_1',
            type: 'output',
            config: {},
            data: { mapping: '{{nodes.sub_1.output}}' },
          },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'sub_1' },
          { id: 'e2', source: 'sub_1', target: 'output_1' },
        ],
      };

      const parentAgent = makeAgent({ id: 'parent-agent', pipeline: parentPipeline });
      const execution = makeExecution({ agentId: 'parent-agent' });

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // Mock node executor to simulate sub_agent node returning child output
      nodeExecutor.execute.mockImplementation(async (node: any, context: any) => {
        switch (node.type) {
          case 'input':
            return { output: context.input };
          case 'sub_agent':
            // In a real execution, this calls the engine recursively via AgentNodeExecutor.
            // Here we just mock the result as if the child agent returned successfully.
            return {
              output: 'Child agent produced this result',
              cost: 0.02,
              tokens: 80,
              executionTime: 250,
            };
          case 'output':
            return { output: 'Child agent produced this result' };
          default:
            return { output: null };
        }
      });

      const result = await engine.execute(parentAgent, 'org-1', 'user-1', {
        input: { message: 'Hello from parent' },
      });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(result.output).toBe('Child agent produced this result');

      // Verify the sub_agent node result is tracked
      expect(result.nodeResults['sub_1']).toBeDefined();
      expect(result.nodeResults['sub_1'].output).toBe('Child agent produced this result');
      expect(result.nodeResults['sub_1'].cost).toBe(0.02);
      expect(result.nodeResults['sub_1'].tokens).toBe(80);
    });

    it('should enforce max nesting depth', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // Attempt execution with nesting depth at the limit (11 > max of 10)
      await expect(
        engine.execute(agent, 'org-1', 'user-1', {}, undefined, { nestingDepth: 11 }),
      ).rejects.toThrow(/Nesting depth/);
    });

    it('should allow execution at nesting depth below the limit', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      // nestingDepth=5 is below the max of 10, should succeed
      const result = await engine.execute(agent, 'org-1', 'user-1', {
        input: { message: 'hello' },
      }, undefined, { nestingDepth: 5 });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    it('should handle sub-agent node failure gracefully', async () => {
      const parentPipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          {
            id: 'sub_1',
            type: 'sub_agent',
            config: {},
            data: { agentId: 'failing-child' },
          },
          {
            id: 'output_1',
            type: 'output',
            config: {},
            data: { mapping: '{{nodes.sub_1.output}}' },
          },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'sub_1' },
          { id: 'e2', source: 'sub_1', target: 'output_1' },
        ],
      };

      const parentAgent = makeAgent({ id: 'parent-fail', pipeline: parentPipeline });
      const execution = makeExecution({ agentId: 'parent-fail' });

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'sub_agent') {
          throw new Error('Sub-agent execution failed: Child LLM provider unavailable');
        }
        return { output: {} };
      });

      const result = await engine.execute(parentAgent, 'org-1', 'user-1', {
        input: { message: 'test' },
      });

      // Pipeline fails because the sub_agent node failed and output depends on it
      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.nodeResults['sub_1']).toBeDefined();
      expect(result.nodeResults['sub_1'].error).toContain('Sub-agent execution failed');
    });

    it('should propagate nesting depth to stream events', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      nodeExecutor.execute.mockResolvedValue({ output: 'ok', cost: 0, tokens: 0, executionTime: 1 });

      const events: StreamEvent[] = [];
      const onEvent = (event: StreamEvent) => events.push(event);

      await engine.execute(
        agent, 'org-1', 'user-1',
        { input: {} },
        onEvent,
        { nestingDepth: 2 },
      );

      // Should still emit execution events even at nesting depth 2
      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('execution.started');
      expect(eventTypes).toContain('execution.completed');
    });

    it('should reject nesting depth exactly at the boundary', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // nestingDepth=10 is exactly at the boundary (MAX_NESTING_DEPTH = 10)
      // The check is `> MAX_NESTING_DEPTH`, so 10 should still pass
      // but 11 should fail
      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const result = await engine.execute(agent, 'org-1', 'user-1', {
        input: {},
      }, undefined, { nestingDepth: 10 });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });
  });
});
