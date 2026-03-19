import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentExecutionEngine, StreamEvent } from '../agent-execution.engine';
import { AgentNodeExecutor, NodeExecutionResult } from '../agent-node-executor';
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
    agentRepo = {
      save: jest.fn(),
      findOne: jest.fn(),
    };

    agentExecutionRepo = {
      create: jest.fn(),
      save: jest.fn(),
    };

    const mockNodeExecutor = {
      execute: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutionEngine,
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(AgentExecution), useValue: agentExecutionRepo },
        { provide: AgentNodeExecutor, useValue: mockNodeExecutor },
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
    it('should call incrementExecution with success=true on successful execution', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok', cost: 0.01, tokens: 50 });

      await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'hi' } });

      expect(agent.incrementExecution).toHaveBeenCalledWith(
        true,
        expect.any(Number),
        expect.any(Number),
      );
      expect(agentRepo.save).toHaveBeenCalledWith(agent);
    });

    it('should call incrementExecution with success=false on failed execution', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockRejectedValue(new Error('LLM call failed'));

      const result = await engine.execute(agent, 'org-1', 'user-1');

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(agent.incrementExecution).toHaveBeenCalledWith(
        false,
        expect.any(Number),
        0,
      );
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
});
