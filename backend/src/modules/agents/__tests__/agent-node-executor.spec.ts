import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { Agent, AgentPipelineNode, AgentPipelineEdge } from '../../../entities/agent.entity';
import { A2AClientService } from '../../a2a/a2a-client.service';
import { ExternalAgentsService } from '../../a2a/external-agents.service';

/**
 * Unit tests for AgentNodeExecutor — every node type × multiple input shapes,
 * including the regression cases for bugs that were fixed in recent commits:
 *
 *   - "Fix condition node: actually evaluate comparisons (==, !=, >, <, >=, <=)"
 *   - "Fix workflow tool_call parameter mapping (array vs object format)"
 *   - "Fix LLM Call node crash"
 *
 * The node executor is the core of the agent execution path; it had no
 * dedicated spec file before this one.
 */
describe('AgentNodeExecutor', () => {
  let executor: AgentNodeExecutor;
  let llmProvidersService: jest.Mocked<LlmProvidersService>;
  let toolExecutorService: jest.Mocked<ToolExecutorService>;
  let agentRepo: { findOne: jest.Mock };
  let executionEngine: jest.Mocked<AgentExecutionEngine>;
  let templateResolver: AgentTemplateResolver;
  let a2aClientService: jest.Mocked<A2AClientService>;
  let externalAgentsService: jest.Mocked<ExternalAgentsService>;

  const buildContext = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
    input: { name: 'world' },
    nodes: {},
    variables: {},
    ...over,
  });

  const node = (type: string, data: any = {}, id = 'n1'): AgentPipelineNode =>
    ({ id, type, data } as AgentPipelineNode);

  beforeEach(async () => {
    llmProvidersService = {
      chat: jest.fn(),
    } as any;
    toolExecutorService = {
      executeTool: jest.fn(),
    } as any;
    agentRepo = {
      findOne: jest.fn(),
    };
    executionEngine = {
      execute: jest.fn(),
    } as any;
    a2aClientService = {
      sendMessage: jest.fn(),
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      buildHeaders: jest.fn(),
    } as any;
    externalAgentsService = {
      findById: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      refreshCard: jest.fn(),
      importFromUrl: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentNodeExecutor,
        AgentTemplateResolver,
        { provide: LlmProvidersService, useValue: llmProvidersService },
        { provide: ToolExecutorService, useValue: toolExecutorService },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: AgentExecutionEngine, useValue: executionEngine },
        { provide: A2AClientService, useValue: a2aClientService },
        { provide: ExternalAgentsService, useValue: externalAgentsService },
        AgentSubAgentExecutors,
      ],
    }).compile();

    executor = module.get<AgentNodeExecutor>(AgentNodeExecutor);
    templateResolver = module.get<AgentTemplateResolver>(AgentTemplateResolver);
  });

  // ==========================================================================
  // Dispatch
  // ==========================================================================

  describe('execute (dispatch)', () => {
    it('throws on unknown node type', async () => {
      await expect(
        executor.execute(node('not_a_real_type'), buildContext(), 'org-1'),
      ).rejects.toThrow(/Unsupported node type/);
    });
  });

  // ==========================================================================
  // input
  // ==========================================================================

  describe('input node', () => {
    it('returns the execution context input verbatim', async () => {
      const ctx = buildContext({ input: { foo: 'bar' } });
      const result = await executor.execute(node('input'), ctx, 'org-1');
      expect(result.output).toEqual({ foo: 'bar' });
    });
  });

  // ==========================================================================
  // output
  // ==========================================================================

  describe('output node', () => {
    it('resolves a string mapping template', async () => {
      const ctx = buildContext({ input: { name: 'Ada' } });
      const result = await executor.execute(
        node('output', { mapping: 'hello {{input.name}}' }),
        ctx,
        'org-1',
      );
      expect(result.output).toBe('hello Ada');
    });

    it('resolves an object mapping with mixed string/non-string values', async () => {
      const ctx = buildContext({ input: { name: 'Ada' } });
      const result = await executor.execute(
        node('output', {
          mapping: {
            greeting: 'hi {{input.name}}',
            year: 2026,
            ok: true,
          },
        }),
        ctx,
        'org-1',
      );
      expect(result.output).toEqual({ greeting: 'hi Ada', year: 2026, ok: true });
    });

    it('returns all node outputs when no mapping or source is configured', async () => {
      const ctx = buildContext({
        nodes: {
          a: { output: 'A' },
          b: { output: 'B' },
        },
      });
      const result = await executor.execute(node('output'), ctx, 'org-1');
      expect(result.output).toEqual({ a: 'A', b: 'B' });
    });
  });

  // ==========================================================================
  // llm_call (regression: "Fix LLM Call node crash")
  // ==========================================================================

  describe('llm_call node', () => {
    it('throws clearly when providerId is missing', async () => {
      await expect(
        executor.execute(
          node('llm_call', { userPromptTemplate: 'hi' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/missing 'providerId'/);
    });

    it('throws clearly when no user prompt is provided', async () => {
      await expect(
        executor.execute(
          node('llm_call', { providerId: 'p1' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/missing user prompt/);
    });

    it('builds messages with system + user prompts and resolves templates', async () => {
      llmProvidersService.chat.mockResolvedValue({
        message: { role: 'assistant', content: 'hi Ada' } as any,
        usage: { totalTokens: 42 } as any,
        cost: 0.001,
      } as any);

      const result = await executor.execute(
        node('llm_call', {
          providerId: 'p1',
          model: 'gpt-x',
          systemPrompt: 'be helpful',
          userPromptTemplate: 'hello {{input.name}}',
          temperature: 0.2,
          maxTokens: 100,
        }),
        buildContext({ input: { name: 'Ada' } }),
        'org-1',
        'user-9',
      );

      expect(llmProvidersService.chat).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          model: 'gpt-x',
          temperature: 0.2,
          maxTokens: 100,
          messages: [
            expect.objectContaining({ content: 'be helpful' }),
            expect.objectContaining({ content: 'hello Ada' }),
          ],
        }),
        'org-1',
        'user-9',
      );
      expect(result.output).toBe('hi Ada');
      expect(result.cost).toBe(0.001);
      expect(result.tokens).toBe(42);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('falls back to userPrompt when userPromptTemplate is absent', async () => {
      llmProvidersService.chat.mockResolvedValue({
        message: { content: 'ok' },
        usage: { totalTokens: 0 },
      } as any);

      await executor.execute(
        node('llm_call', { providerId: 'p1', userPrompt: 'plain' }),
        buildContext(),
        'org-1',
      );

      const callArgs = llmProvidersService.chat.mock.calls[0][1];
      expect(callArgs.messages[0].content).toBe('plain');
    });

    it('wraps provider errors with detail when present', async () => {
      const err: any = new Error('outer');
      err.response = { data: { error: { message: 'rate limited' } } };
      llmProvidersService.chat.mockRejectedValue(err);

      await expect(
        executor.execute(
          node('llm_call', { providerId: 'p1', userPrompt: 'x' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/rate limited/);
    });

    it('does not crash on missing usage/cost in response', async () => {
      // Regression: LLM Call node previously crashed reading these fields.
      llmProvidersService.chat.mockResolvedValue({
        message: { content: 'ok' },
      } as any);

      const result = await executor.execute(
        node('llm_call', { providerId: 'p1', userPrompt: 'x' }),
        buildContext(),
        'org-1',
      );

      expect(result.cost).toBe(0);
      expect(result.tokens).toBe(0);
    });
  });

  // ==========================================================================
  // tool_call (regression: parameter mapping array vs object)
  // ==========================================================================

  describe('tool_call node', () => {
    beforeEach(() => {
      toolExecutorService.executeTool.mockResolvedValue({
        success: true,
        data: { ok: 1 },
      } as any);
    });

    it('throws when toolId is missing', async () => {
      await expect(
        executor.execute(node('tool_call', {}), buildContext(), 'org-1'),
      ).rejects.toThrow(/missing 'toolId'/);
    });

    it('resolves parameterMapping in OBJECT format', async () => {
      await executor.execute(
        node('tool_call', {
          toolId: 't1',
          parameterMapping: { name: '{{input.name}}', count: 3 },
        }),
        buildContext({ input: { name: 'Ada' } }),
        'org-1',
        'user-1',
      );

      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        't1',
        { name: 'Ada', count: 3 },
        { organizationId: 'org-1', userId: 'user-1' },
      );
    });

    it('resolves parameterMapping in ARRAY format ([{key, value}])', async () => {
      // Regression: workflow builder emits the array shape; this used to break.
      await executor.execute(
        node('tool_call', {
          toolId: 't1',
          parameterMapping: [
            { key: 'name', value: '{{input.name}}' },
            { key: 'count', value: 7 },
          ],
        }),
        buildContext({ input: { name: 'Ada' } }),
        'org-1',
      );

      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        't1',
        { name: 'Ada', count: 7 },
        expect.any(Object),
      );
    });

    it('passes empty params object when no parameterMapping', async () => {
      await executor.execute(
        node('tool_call', { toolId: 't1' }),
        buildContext(),
        'org-1',
      );
      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        't1',
        {},
        expect.any(Object),
      );
    });

    it('throws when tool execution returns success=false', async () => {
      toolExecutorService.executeTool.mockResolvedValue({
        success: false,
        error: 'http 500',
      } as any);

      await expect(
        executor.execute(
          node('tool_call', { toolId: 't1' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/http 500/);
    });
  });

  // ==========================================================================
  // condition (regression: "actually evaluate comparisons")
  // ==========================================================================

  describe('condition node', () => {
    it('throws when expression is missing', async () => {
      await expect(
        executor.execute(node('condition', {}), buildContext(), 'org-1'),
      ).rejects.toThrow(/missing 'expression'/);
    });

    it.each([
      ['5 > 3', true],
      ['3 > 5', false],
      ['5 < 10', true],
      ['10 < 5', false],
      ['7 >= 7', true],
      ['7 >= 8', false],
      ['7 <= 7', true],
      ['8 <= 7', false],
      ['5 == 5', true],
      ['5 == 6', false],
      ['5 === 5', true],
      ['5 !== 6', true],
      ['5 != 5', false],
      ['29.4 > 25', true], // from the actual bug report
    ])('numeric comparison: %s -> %s', async (expr, expected) => {
      const result = await executor.execute(
        node('condition', { expression: expr }),
        buildContext(),
        'org-1',
      );
      expect(result.output).toEqual({ __condition: true, result: expected });
    });

    it.each([
      ['overweight == overweight', true],
      ['foo == bar', false],
      ['foo != bar', true],
    ])('string comparison: %s -> %s', async (expr, expected) => {
      const result = await executor.execute(
        node('condition', { expression: expr }),
        buildContext(),
        'org-1',
      );
      expect((result.output as any).result).toBe(expected);
    });

    it('returns true for non-empty/truthy strings without operators', async () => {
      const result = await executor.execute(
        node('condition', { expression: 'yes' }),
        buildContext(),
        'org-1',
      );
      expect((result.output as any).result).toBe(true);
    });

    it.each(['false', '0', 'null', 'undefined'])(
      'returns false for falsy literal %s',
      async (literal) => {
        const result = await executor.execute(
          node('condition', { expression: literal }),
          buildContext(),
          'org-1',
        );
        expect((result.output as any).result).toBe(false);
      },
    );

    it('treats empty string expression as missing and throws', async () => {
      // Empty string is falsy, so the missing-expression guard fires before
      // any evaluation. Documenting current behavior.
      await expect(
        executor.execute(
          node('condition', { expression: '' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/missing 'expression'/);
    });

    it('resolves templated expressions before evaluating', async () => {
      const result = await executor.execute(
        node('condition', { expression: '{{input.bmi}} > 25' }),
        buildContext({ input: { bmi: '29.4' } }),
        'org-1',
      );
      expect((result.output as any).result).toBe(true);
    });
  });

  // ==========================================================================
  // transform
  // ==========================================================================

  describe('transform node', () => {
    it('throws when expression is missing', async () => {
      await expect(
        executor.execute(node('transform', {}), buildContext(), 'org-1'),
      ).rejects.toThrow(/missing 'expression'/);
    });

    it('resolves a templated expression', async () => {
      const result = await executor.execute(
        node('transform', { expression: 'hello {{input.name}}' }),
        buildContext({ input: { name: 'Ada' } }),
        'org-1',
      );
      expect(result.output).toBe('hello Ada');
    });
  });

  // ==========================================================================
  // loop
  // ==========================================================================

  describe('loop node', () => {
    it('throws when iterableExpression is missing', async () => {
      await expect(
        executor.execute(node('loop', {}), buildContext(), 'org-1'),
      ).rejects.toThrow(/missing 'iterableExpression'/);
    });

    it('iterates a single-{{path}} array reference and returns the raw items', async () => {
      const result = await executor.execute(
        node('loop', { iterableExpression: '{{input.items}}' }),
        buildContext({ input: { items: ['a', 'b', 'c'] } }),
        'org-1',
      );
      expect(result.output).toEqual(['a', 'b', 'c']);
    });

    it('iterates an array reached via dot-path through a previous node output', async () => {
      const result = await executor.execute(
        node('loop', { iterableExpression: '{{nodes.upstream.output}}' }),
        buildContext({ nodes: { upstream: { output: [10, 20, 30] } } }),
        'org-1',
      );
      expect(result.output).toEqual([10, 20, 30]);
    });

    it('caps iteration at maxIterations', async () => {
      const big = Array.from({ length: 50 }, (_, i) => i);
      const result = await executor.execute(
        node('loop', { iterableExpression: '{{input.items}}', maxIterations: 5 }),
        buildContext({ input: { items: big } }),
        'org-1',
      );
      expect(result.output).toHaveLength(5);
      expect(result.output).toEqual([0, 1, 2, 3, 4]);
    });

    it('treats a non-templated literal as a single-item collection', async () => {
      const result = await executor.execute(
        node('loop', { iterableExpression: 'just-a-literal' }),
        buildContext(),
        'org-1',
      );
      expect(result.output).toEqual(['just-a-literal']);
    });

    it('cleans up loop context after iteration', async () => {
      const ctx = buildContext({ input: { items: [1, 2] } });
      await executor.execute(
        node('loop', { iterableExpression: '{{input.items}}' }),
        ctx,
        'org-1',
      );
      expect((ctx as any).loop).toBeUndefined();
    });
  });

  // ==========================================================================
  // parallel
  // ==========================================================================

  describe('parallel node', () => {
    it('passes through the context input when no upstream node has run', async () => {
      const result = await executor.execute(
        node('parallel'),
        buildContext({ input: { x: 1 } }),
        'org-1',
      );
      expect(result.output).toEqual({ x: 1 });
    });

    it('returns the first available upstream node output', async () => {
      const result = await executor.execute(
        node('parallel'),
        buildContext({
          input: { fallback: true },
          nodes: { upstream: { output: 'real' } },
        }),
        'org-1',
      );
      expect(result.output).toBe('real');
    });

    it('selects the input from its incoming edge, not insertion order', async () => {
      // Two upstreams present; only `b` feeds this parallel node. The old
      // heuristic returned whichever appeared first in context.nodes (here
      // `a`); the edge-aware version must return `b` deterministically.
      const edges: AgentPipelineEdge[] = [
        { id: 'b-p', source: 'b', target: 'p' } as AgentPipelineEdge,
      ];
      const result = await executor.execute(
        node('parallel', {}, 'p'),
        buildContext({
          input: { fallback: true },
          nodes: { a: { output: 'A' }, b: { output: 'B' } },
        }),
        'org-1',
        undefined,
        { organizationId: 'org-1', edges },
      );
      expect(result.output).toBe('B');
    });
  });

  // ==========================================================================
  // merge
  // ==========================================================================

  describe('merge node', () => {
    const buildEdges = (sources: string[], target: string): AgentPipelineEdge[] =>
      sources.map((s) => ({ id: `${s}-${target}`, source: s, target }) as AgentPipelineEdge);

    it('first_response returns the first incoming output', async () => {
      const ctx = buildContext({
        nodes: { a: { output: 'A' }, b: { output: 'B' } },
      });
      const result = await executor.execute(
        node('merge', { strategy: 'first_response' }, 'm'),
        ctx,
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: buildEdges(['a', 'b'], 'm') },
      );
      expect(result.output).toBe('A');
    });

    it('concatenate returns all incoming outputs as an array', async () => {
      const ctx = buildContext({
        nodes: { a: { output: 'A' }, b: { output: 'B' } },
      });
      const result = await executor.execute(
        node('merge', { strategy: 'concatenate' }, 'm'),
        ctx,
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: buildEdges(['a', 'b'], 'm') },
      );
      expect(result.output).toEqual(['A', 'B']);
    });

    it('best_of_n requires judgeConfig.providerId', async () => {
      await expect(
        executor.execute(
          node('merge', { strategy: 'best_of_n' }, 'm'),
          buildContext({ nodes: { a: { output: 'A' } } }),
          'org-1',
          undefined,
          { organizationId: 'org-1', edges: buildEdges(['a'], 'm') },
        ),
      ).rejects.toThrow(/judgeConfig.providerId/);
    });

    it('best_of_n picks the option the judge returns', async () => {
      llmProvidersService.chat.mockResolvedValue({
        message: { content: '2' },
        usage: { totalTokens: 5 },
        cost: 0.0001,
      } as any);

      const result = await executor.execute(
        node(
          'merge',
          { strategy: 'best_of_n', judgeConfig: { providerId: 'p1' } },
          'm',
        ),
        buildContext({ nodes: { a: { output: 'A' }, b: { output: 'B' } } }),
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: buildEdges(['a', 'b'], 'm') },
      );
      expect(result.output).toBe('B');
      expect(result.cost).toBe(0.0001);
    });

    it('best_of_n clamps out-of-range judge picks', async () => {
      llmProvidersService.chat.mockResolvedValue({
        message: { content: '99' },
      } as any);

      const result = await executor.execute(
        node(
          'merge',
          { strategy: 'best_of_n', judgeConfig: { providerId: 'p1' } },
          'm',
        ),
        buildContext({ nodes: { a: { output: 'A' }, b: { output: 'B' } } }),
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: buildEdges(['a', 'b'], 'm') },
      );
      // 99 -> index 98 -> clamped to 1 (last index)
      expect(result.output).toBe('B');
    });

    it('consensus calls judge and returns its content', async () => {
      llmProvidersService.chat.mockResolvedValue({
        message: { content: 'merged answer' },
      } as any);

      const result = await executor.execute(
        node(
          'merge',
          { strategy: 'consensus', judgeConfig: { providerId: 'p1' } },
          'm',
        ),
        buildContext({ nodes: { a: { output: 'A' }, b: { output: 'B' } } }),
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: buildEdges(['a', 'b'], 'm') },
      );
      expect(result.output).toBe('merged answer');
    });

    it('default strategy returns the first incoming output', async () => {
      const result = await executor.execute(
        node('merge', { strategy: 'unknown_strategy' }, 'm'),
        buildContext({ nodes: { a: { output: 'A' }, b: { output: 'B' } } }),
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: buildEdges(['a', 'b'], 'm') },
      );
      expect(result.output).toBe('A');
    });

    it('falls back to all node outputs when no edges are provided', async () => {
      const result = await executor.execute(
        node('merge', { strategy: 'concatenate' }, 'm'),
        buildContext({ nodes: { a: { output: 'A' }, b: { output: 'B' } } }),
        'org-1',
      );
      expect(result.output).toEqual(['A', 'B']);
    });
  });

  // ==========================================================================
  // sub_agent
  // ==========================================================================

  describe('sub_agent node', () => {
    it('throws when agentId is missing', async () => {
      await expect(
        executor.execute(node('sub_agent', {}), buildContext(), 'org-1'),
      ).rejects.toThrow(/missing 'target' or 'agentId'/);
    });

    it('throws when nesting depth has been exceeded', async () => {
      await expect(
        executor.execute(
          node('sub_agent', { agentId: 'a-2' }),
          buildContext(),
          'org-1',
          undefined,
          { organizationId: 'org-1', nestingDepth: 5, maxNestingDepth: 5 },
        ),
      ).rejects.toThrow(/Max nesting depth/);
    });

    it('throws when sub-agent is not found', async () => {
      agentRepo.findOne.mockResolvedValue(null);
      await expect(
        executor.execute(
          node('sub_agent', { agentId: 'missing' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/Sub-agent 'missing' not found/);
    });

    it('runs the sub-agent with mapped inputs and increments nesting depth', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'a-2' } as Agent);
      executionEngine.execute.mockResolvedValue({
        status: 'completed',
        output: 'sub result',
        totalCost: 0.5,
        totalTokens: 100,
      } as any);

      const result = await executor.execute(
        node('sub_agent', {
          agentId: 'a-2',
          inputMapping: { name: '{{input.name}}', static: 42 },
        }),
        buildContext({ input: { name: 'Ada' } }),
        'org-1',
        'user-1',
      );

      expect(executionEngine.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a-2' }),
        'org-1',
        'user-1',
        expect.objectContaining({
          input: { name: 'Ada', static: 42 },
          metadata: expect.objectContaining({ nestingDepth: 1 }),
        }),
        undefined,
        expect.objectContaining({ nestingDepth: 1 }),
      );
      expect(result.output).toBe('sub result');
      expect(result.cost).toBe(0.5);
      expect(result.tokens).toBe(100);
    });

    it('passes context.input directly when no inputMapping is configured', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'a-2' } as Agent);
      executionEngine.execute.mockResolvedValue({
        status: 'completed',
        output: 'r',
      } as any);

      await executor.execute(
        node('sub_agent', { agentId: 'a-2' }),
        buildContext({ input: { x: 1, y: 2 } }),
        'org-1',
      );

      expect(executionEngine.execute.mock.calls[0][3]).toMatchObject({
        input: { x: 1, y: 2 },
      });
    });

    it('throws when sub-agent execution fails', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'a-2' } as Agent);
      executionEngine.execute.mockResolvedValue({
        status: 'failed',
        error: 'sub crashed',
      } as any);

      await expect(
        executor.execute(
          node('sub_agent', { agentId: 'a-2' }),
          buildContext(),
          'org-1',
        ),
      ).rejects.toThrow(/sub crashed/);
    });

    // Regression: the sub-agent lookup used to be
    // `findOne({ where: { id: agentId } })` with no org filter, which
    // let a user in org A reference any agentId in the system and have
    // the engine load + run the referenced pipeline under their own
    // credentials. We now scope the lookup to { id, organizationId } —
    // a sub_agent node referencing a foreign agent has to look exactly
    // like "agent not found".
    describe('cross-org sub-agent lookup (regression)', () => {
      it('scopes the findOne by both id AND organizationId', async () => {
        agentRepo.findOne.mockResolvedValue({ id: 'a-2' } as Agent);
        executionEngine.execute.mockResolvedValue({
          status: 'completed',
          output: 'ok',
        } as any);

        await executor.execute(
          node('sub_agent', { agentId: 'a-2' }),
          buildContext(),
          'org-1',
          'user-1',
          { organizationId: 'org-1' },
        );

        expect(agentRepo.findOne).toHaveBeenCalledWith({
          where: { id: 'a-2', organizationId: 'org-1' },
        });
      });

      it('surfaces a cross-org reference as "sub-agent not found"', async () => {
        // Simulates the DB response when the requested agentId exists
        // in another org: the scoped where clause finds nothing.
        agentRepo.findOne.mockResolvedValue(null);

        await expect(
          executor.execute(
            node('sub_agent', { agentId: 'foreign-agent-id' }),
            buildContext(),
            'org-1',
            'user-1',
            { organizationId: 'org-1' },
          ),
        ).rejects.toThrow(/Sub-agent 'foreign-agent-id' not found/);

        // The engine must NEVER be invoked for a cross-org reference.
        expect(executionEngine.execute).not.toHaveBeenCalled();
      });
    });
  });
});
