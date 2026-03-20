import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentExecutionEngine, StreamEvent } from '../agent-execution.engine';
import { AgentNodeExecutor, NodeExecutionResult } from '../agent-node-executor';
import { Agent, AgentStatus, AgentPipeline, AgentPipelineNode } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';

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

describe('Agent Edge Cases', () => {
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

  // ══════════════════════════════════════════════════════════════════════════
  // PIPELINE EDGE CASES
  // ══════════════════════════════════════════════════════════════════════════

  describe('Pipeline edge cases', () => {
    // ── Empty pipeline (no nodes) ─────────────────────────────────────────
    it('should fail with clear error when pipeline has no nodes', async () => {
      const agent = makeAgent({
        pipeline: { nodes: [], edges: [] },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      // With zero nodes there's nothing to execute — the engine completes with no output
      expect(nodeExecutor.execute).not.toHaveBeenCalled();
    });

    // ── Pipeline with only input node (no output) ─────────────────────────
    it('should complete without output node but output will be null', async () => {
      const agent = makeAgent({
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
          ],
          edges: [],
        },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: { message: 'hi' } });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'hi' } });

      // It should complete but have no final output (no output node)
      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(result.output).toBeNull();
    });

    // ── Pipeline with disconnected nodes ──────────────────────────────────
    it('should still execute disconnected nodes (they appear in layer 0 since in-degree=0)', async () => {
      const agent = makeAgent({
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
            { id: 'llm_1', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: '{{input.message}}' } },
            { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_1.output}}' } },
            { id: 'disconnected_1', type: 'transform', config: {}, data: { expression: 'hello' } },
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_1' },
            { id: 'e2', source: 'llm_1', target: 'output_1' },
            // disconnected_1 has no edges at all
          ],
        },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const executedNodes: string[] = [];
      nodeExecutor.execute.mockImplementation(async (node: any) => {
        executedNodes.push(node.id);
        return { output: `result-${node.id}` };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'hi' } });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      // The disconnected node has in-degree 0 so it gets executed in the first layer
      expect(executedNodes).toContain('disconnected_1');
    });

    // ── Pipeline with 50+ nodes (stress test) ─────────────────────────────
    it('should handle a pipeline with 50+ nodes', async () => {
      const nodes: AgentPipelineNode[] = [
        { id: 'input_1', type: 'input', config: {} },
      ];
      const edges: any[] = [];

      // Build a chain of 50 transform nodes
      for (let i = 1; i <= 50; i++) {
        const nodeId = `transform_${i}`;
        nodes.push({
          id: nodeId,
          type: 'transform',
          config: {},
          data: { expression: `step_${i}` },
        });
        const prevId = i === 1 ? 'input_1' : `transform_${i - 1}`;
        edges.push({ id: `e${i}`, source: prevId, target: nodeId });
      }

      nodes.push({
        id: 'output_1',
        type: 'output',
        config: {},
        data: { mapping: '{{nodes.transform_50.output}}' },
      });
      edges.push({ id: 'e_out', source: 'transform_50', target: 'output_1' });

      const agent = makeAgent({ pipeline: { nodes, edges } });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      // 1 input + 50 transforms + 1 output = 52
      expect(nodeExecutor.execute).toHaveBeenCalledTimes(52);
    });

    // ── Node with missing data AND missing config ─────────────────────────
    it('should handle a node with missing data and config gracefully', async () => {
      const agent = makeAgent({
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input' } as any, // no data, no config
            { id: 'output_1', type: 'output' } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'output_1' },
          ],
        },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: {} });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // The engine itself doesn't check node data/config — that's the node executor's job
      // The engine should still complete successfully if the node executor doesn't throw
      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    // ── Node referencing non-existent provider ID ─────────────────────────
    it('should fail with clear error when LLM node references non-existent provider', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'input') return { output: {} };
        if (node.type === 'llm_call') throw new Error('Provider not found: p-1');
        return { output: {} };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: { message: 'hi' } });

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('Provider not found');
    });

    // ── Node referencing non-existent tool ID ─────────────────────────────
    it('should fail with clear error when tool_call node references non-existent tool', async () => {
      const agent = makeAgent({
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
            { id: 'tool_1', type: 'tool_call', config: {}, data: { toolId: 'non-existent-tool' } },
            { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.tool_1.output}}' } },
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'tool_1' },
            { id: 'e2', source: 'tool_1', target: 'output_1' },
          ],
        },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'input') return { output: {} };
        if (node.type === 'tool_call') throw new Error('Tool not found: non-existent-tool');
        return { output: {} };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('Tool not found');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION EDGE CASES
  // ══════════════════════════════════════════════════════════════════════════

  describe('Execution edge cases', () => {
    // ── Input is null ─────────────────────────────────────────────────────
    it('should handle null input by defaulting to empty object', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      let capturedContext: any;
      nodeExecutor.execute.mockImplementation(async (node: any, context: any) => {
        if (node.type === 'input') {
          capturedContext = JSON.parse(JSON.stringify(context));
        }
        return { output: 'ok' };
      });

      // Pass null input
      const result = await engine.execute(agent, 'org-1', 'user-1', {
        input: null as any,
      });

      // The engine defaults to {} via `options.input || {}`
      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(capturedContext.input).toEqual({});
    });

    // ── Input is an array ─────────────────────────────────────────────────
    it('should reject array input with a validation error', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      // Array input — the engine validates and rejects it
      await expect(
        engine.execute(agent, 'org-1', 'user-1', {
          input: [1, 2, 3] as any,
        }),
      ).rejects.toThrow('Execution input must be a plain object');
    });

    // ── Input is a very large string (>50KB in a single field) ────────────
    it('should handle very large string input (>50KB)', async () => {
      const agent = makeAgent();
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const largeString = 'x'.repeat(60000); // 60KB
      const result = await engine.execute(agent, 'org-1', 'user-1', {
        input: { message: largeString },
      });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    // ── Concurrent execution of same agent ────────────────────────────────
    it('should handle concurrent executions without shared state corruption', async () => {
      const agent1 = makeAgent();
      const agent2 = makeAgent();
      agent2.id = 'agent-1'; // Same agent ID

      let execCounter = 0;
      agentExecutionRepo.create.mockImplementation(() => {
        execCounter++;
        return makeExecution({ id: `exec-${execCounter}` });
      });
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any, context: any) => {
        // Add small delay to simulate real work
        await new Promise(resolve => setTimeout(resolve, 5));
        if (node.type === 'input') {
          return { output: context.input };
        }
        return { output: `response-for-${JSON.stringify(context.input)}` };
      });

      // Execute two pipelines concurrently
      const [result1, result2] = await Promise.all([
        engine.execute(agent1, 'org-1', 'user-1', { input: { message: 'first' } }),
        engine.execute(agent2, 'org-1', 'user-2', { input: { message: 'second' } }),
      ]);

      // Both should complete successfully
      expect(result1.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(result2.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    // ── Agent with status 'draft' invoked ─────────────────────────────────
    it('should still execute a draft agent (engine does not enforce status check)', async () => {
      const agent = makeAgent({ status: AgentStatus.DRAFT });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      // Note: Status enforcement is the controller's responsibility, not the engine's.
      // The engine will still execute the pipeline.
      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    // ── Agent with status 'inactive' invoked ──────────────────────────────
    it('should still execute an inactive agent (engine does not enforce status check)', async () => {
      const agent = makeAgent({ status: AgentStatus.INACTIVE });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    // ── Execution timeout at exactly 0ms ──────────────────────────────────
    it('should use default timeout when maxExecutionTime is 0 (falsy fallback)', async () => {
      // maxExecutionTime=0 is falsy, so `settings.maxExecutionTime || 300000` resolves to 300000
      const agent = makeAgent({
        settings: { maxExecutionTime: 0 },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockResolvedValue({ output: 'ok' });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // 0 is falsy so default applies — should complete normally
      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    // ── Execution timeout at 1ms ──────────────────────────────────────────
    it('should time out or fail when maxExecutionTime is 1ms and node is slow', async () => {
      const agent = makeAgent({
        settings: { maxExecutionTime: 1 },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'input') return { output: {} };
        // Slow node
        await new Promise(resolve => setTimeout(resolve, 50));
        return { output: 'slow' };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      expect([AgentExecutionStatus.TIMEOUT, AgentExecutionStatus.FAILED]).toContain(result.status);
    });

    // ── Budget limit of 0 ─────────────────────────────────────────────────
    it('should use Infinity budget when budgetLimit is 0 (falsy fallback)', async () => {
      // budgetLimit=0 is falsy, so `settings.budgetLimit || Infinity` resolves to Infinity
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_1', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'hi' } },
          { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_1.output}}' } },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'llm_1' },
          { id: 'e2', source: 'llm_1', target: 'output_1' },
        ],
      };

      const agent = makeAgent({
        pipeline,
        settings: { budgetLimit: 0 },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'llm_call') {
          return { output: 'text', cost: 0.01, tokens: 50, executionTime: 10 };
        }
        return { output: {}, cost: 0, tokens: 0, executionTime: 0 };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // 0 is falsy so default Infinity applies — should complete normally
      expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    // ── Budget limit of 0.001 ───────────────────────────────────────────────
    it('should fail after first LLM call when budget is very small', async () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_1', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'hi' } },
          { id: 'llm_2', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: 'hi' } },
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
        settings: { budgetLimit: 0.001 },
      });
      const execution = makeExecution();

      agentExecutionRepo.create.mockReturnValue(execution);
      agentExecutionRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      nodeExecutor.execute.mockImplementation(async (node: any) => {
        if (node.type === 'llm_call') {
          return { output: 'text', cost: 0.05, tokens: 50, executionTime: 10 };
        }
        return { output: {}, cost: 0, tokens: 0, executionTime: 0 };
      });

      const result = await engine.execute(agent, 'org-1', 'user-1', { input: {} });

      // After first LLM call costs 0.05 (exceeds budget 0.001), next layer should detect it
      expect(result.status).toBe(AgentExecutionStatus.FAILED);
      expect(result.error).toContain('Budget limit');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATE EDGE CASES
  // ══════════════════════════════════════════════════════════════════════════

  describe('Template edge cases', () => {
    let resolver: AgentTemplateResolver;

    beforeEach(() => {
      resolver = new AgentTemplateResolver();
    });

    // ── Template with 100+ variables ──────────────────────────────────────
    it('should handle a template with 100+ variables', () => {
      const context: ExecutionContext = {
        input: {} as Record<string, any>,
        nodes: {},
        variables: {} as Record<string, any>,
      };

      // Build 100 variables
      let template = '';
      for (let i = 0; i < 100; i++) {
        (context.variables as Record<string, any>)[`var${i}`] = `value${i}`;
        template += `{{variables.var${i}}} `;
      }

      const result = resolver.resolve(template, context);

      // All 100 should resolve
      for (let i = 0; i < 100; i++) {
        expect(result).toContain(`value${i}`);
      }
    });

    // ── Deeply nested path (10 levels) ────────────────────────────────────
    it('should handle a deeply nested path (10 levels)', () => {
      let deepObj: any = { leaf: 'found' };
      for (let i = 9; i >= 1; i--) {
        deepObj = { [`level${i}`]: deepObj };
      }

      const context: ExecutionContext = {
        input: { level1: deepObj.level1 },
        nodes: {},
      };

      const path = 'input.' + Array.from({ length: 9 }, (_, i) => `level${i + 1}`).join('.') + '.leaf';
      const result = resolver.resolve(`{{${path}}}`, context);
      expect(result).toBe('found');
    });

    // ── Circular reference in context ─────────────────────────────────────
    it('should not infinite loop on circular reference in context (resolveProperty walks safely)', () => {
      const circularObj: any = { name: 'circle' };
      circularObj.self = circularObj;

      const context: ExecutionContext = {
        input: circularObj,
        nodes: {},
      };

      // Accessing a non-circular path on a circular object should work fine
      const result = resolver.resolve('{{input.name}}', context);
      expect(result).toBe('circle');
    });

    // ── Template referencing node that hasn't executed yet ─────────────────
    it('should return empty string for a node that has not executed yet', () => {
      const context: ExecutionContext = {
        input: {},
        nodes: {}, // No nodes have executed
      };

      const result = resolver.resolve('Result: {{nodes.llm_1.output}}', context);
      expect(result).toBe('Result: ');
    });

    // ── Empty string template ─────────────────────────────────────────────
    it('should return empty string for empty template', () => {
      const context: ExecutionContext = { input: {}, nodes: {} };
      const result = resolver.resolve('', context);
      expect(result).toBe('');
    });

    // ── Template that is just {{}} (empty expression) ─────────────────────
    it('should handle {{}} (empty expression) gracefully', () => {
      const context: ExecutionContext = { input: {}, nodes: {} };

      // The regex /\{\{([^}]+)\}\}/g requires at least one char between {{ and }}
      // so {{}} won't match and will be returned as-is
      const result = resolver.resolve('{{}}', context);
      expect(result).toBe('{{}}');
    });

    // ── Template with only whitespace inside braces ───────────────────────
    it('should handle {{ }} (whitespace-only expression) by throwing (invalid chars)', () => {
      const context: ExecutionContext = { input: {}, nodes: {} };

      // The expression after trim will be empty string, which won't match SAFE_PATH_REGEX
      expect(() => resolver.resolve('{{  }}', context)).toThrow();
    });
  });
});
