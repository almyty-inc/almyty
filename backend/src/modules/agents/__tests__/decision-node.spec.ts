import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { AgentValidationHelper } from '../agent-validation.helper';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { A2AClientService } from '../../a2a/a2a-client.service';
import { ExternalAgentsService } from '../../a2a/external-agents.service';
import { Agent, AgentPipeline, AgentPipelineNode } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';
import { DecideQuestion } from '../../model-catalog/decide/decide-contract';

/**
 * The `decision` node: one typed question over a declared option set, a
 * distribution instead of prose, and a threshold that can send a
 * low-confidence answer down the abstain edge rather than the argmax one.
 *
 * The threshold is the reason the node exists. A node that always takes
 * the argmax is an `llm_call` with extra JSON, so the below-threshold case
 * is pinned here as hard as the above-threshold one.
 */
describe('decision node', () => {
  let executor: AgentNodeExecutor;
  let validator: AgentValidationHelper;
  let llm: { chat: jest.Mock };

  /** Three options, one of them the mandatory abstain. */
  const question: DecideQuestion = {
    id: 'q_intent',
    type: 'choice',
    prompt: 'What does the customer want?',
    options: [
      { id: 'refund', description: 'money back' },
      { id: 'exchange', description: 'a different item' },
      { id: 'unknown', description: 'the message does not say', abstain: true },
    ],
  };

  const edges = [
    { id: 'e_refund', source: 'd1', target: 'n_refund', sourceHandle: 'refund' },
    { id: 'e_exchange', source: 'd1', target: 'n_exchange', sourceHandle: 'exchange' },
    { id: 'e_unknown', source: 'd1', target: 'n_human', sourceHandle: 'unknown' },
  ];

  const buildContext = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
    input: { message: 'I want my money back' },
    nodes: {},
    variables: {},
    ...over,
  });

  const node = (data: any = {}, id = 'd1'): AgentPipelineNode =>
    ({ id, type: 'decision', data } as AgentPipelineNode);

  /** The model answers with a weight per option; the node normalises them. */
  const answersWeights = (scores: Record<string, number>, extra: Record<string, any> = {}) => {
    llm.chat.mockResolvedValue({
      message: { role: 'assistant', content: JSON.stringify({ scores }) },
      cost: 0.002,
      model: 'gpt-4o-mini',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      ...extra,
    } as any);
  };

  const run = (data: any = {}, ctx = buildContext()) =>
    executor.execute(node({ providerId: 'p1', question, ...data }), ctx, 'org-1', undefined, {
      organizationId: 'org-1',
      edges: edges as any,
    });

  beforeEach(async () => {
    llm = { chat: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentNodeExecutor,
        AgentValidationHelper,
        AgentTemplateResolver,
        AgentSubAgentExecutors,
        AgentVerifierHelper,
        { provide: LlmProvidersService, useValue: llm },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        { provide: AgentExecutionEngine, useValue: { execute: jest.fn() } },
        { provide: A2AClientService, useValue: {} },
        { provide: ExternalAgentsService, useValue: {} },
        { provide: getRepositoryToken(Agent), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    executor = module.get(AgentNodeExecutor);
    validator = module.get(AgentValidationHelper);
  });

  it('reaches a real handler rather than the default "unsupported node type" throw', async () => {
    // The wiring guard. A node type the switch has no case for fails with
    // "Unsupported node type", which is indistinguishable in a run record
    // from a feature that was never built — which is exactly what happened
    // to extract_context.
    const err = await executor
      .execute(node({}), buildContext(), 'org-1')
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/Unsupported node type/);
    expect((err as Error).message).toMatch(/missing 'question'/);
  });

  it('takes the argmax option edge when the winning probability clears its threshold', async () => {
    answersWeights({ refund: 6, exchange: 3, unknown: 1 });

    const result = await run({ thresholds: { refund: 0.5 } });

    // 6 / (6 + 3 + 1) = 0.6, which clears 0.5.
    expect(result.output.probability).toBeCloseTo(0.6, 6);
    expect(result.output.argmax).toBe('refund');
    expect(result.output.selectedOption).toBe('refund');
    expect(result.output.selectedEdgeId).toBe('e_refund');
    expect(result.output.abstained).toBe(false);
  });

  it('routes to the abstain option when the winning probability is below its threshold', async () => {
    answersWeights({ refund: 6, exchange: 3, unknown: 1 });

    const result = await run({ thresholds: { refund: 0.9 } });

    // Same distribution, same argmax — and a different edge, because 0.6
    // does not clear 0.9. This is the whole point of the threshold.
    expect(result.output.argmax).toBe('refund');
    expect(result.output.probability).toBeCloseTo(0.6, 6);
    expect(result.output.selectedOption).toBe('unknown');
    expect(result.output.selectedEdgeId).toBe('e_unknown');
    expect(result.output.abstained).toBe(true);
    expect(result.output.threshold).toBe(0.9);
  });

  it('takes the argmax when no threshold is set for the winning option', async () => {
    answersWeights({ refund: 6, exchange: 3, unknown: 1 });

    const result = await run({ thresholds: { exchange: 0.99 } });

    expect(result.output.selectedOption).toBe('refund');
    expect(result.output.threshold).toBeNull();
  });

  it('carries the full distribution and the decide audit block on the node result', async () => {
    answersWeights({ refund: 6, exchange: 3, unknown: 1 });

    const result = await run({ thresholds: { refund: 0.5 }, temperature: 0 });

    expect(Object.keys(result.output.distribution).sort()).toEqual([
      'exchange',
      'refund',
      'unknown',
    ]);
    const total = Object.values(result.output.distribution as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBeCloseTo(1, 10);

    // Scores that order the options are not probabilities that mean
    // anything on their own, and the contract makes that a typed claim.
    expect(result.output.answer.calibrated).toBe(false);
    expect(result.output.answer.conditionalScores).toBe(true);
    expect(result.output.answer.agreement).toBeNull();
    expect(result.output.answer.entropy).toBeGreaterThan(0);

    expect(result.output.audit.optionOrder).toEqual(['refund', 'exchange', 'unknown']);
    expect(result.output.audit.provider).toBe('p1');
    expect(result.output.audit.modelRevision).toBe('gpt-4o-mini');
    expect(result.output.audit.tokens).toEqual({ input: 120, output: 30 });
    // No scoring mode, because none ran. This path verbalises a weight
    // per option and reads no token logprobs, so naming a mode here would
    // assert a measurement that never happened.
    expect(result.output.audit.servingConfig.scoring).toBeUndefined();
    expect(result.output.audit.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stamps routing attribution on the node result, exactly as a routed llm_call does', async () => {
    const routing = {
      modelId: 'card-1',
      modelVersionId: null,
      vendorModelId: 'claude-sonnet-4',
      providerId: 'prov-anthropic',
      rationale: 'cheapest passing card',
      attempt: 1,
      tried: [],
      rejected: [],
    };
    answersWeights({ refund: 6, exchange: 3, unknown: 1 }, { routing });

    const result = await executor.execute(
      node({ question, routing: { objective: 'cheapest' } }),
      buildContext(),
      'org-1',
      undefined,
      { organizationId: 'org-1', edges: edges as any },
    );

    expect(result.routing).toEqual(routing);
    expect(result.providerId).toBe('prov-anthropic');
    // The audit block names the same call the attribution does.
    expect(result.output.audit.provider).toBe('prov-anthropic');
  });

  it('refuses an answer that leaves an option unscored rather than reading it as zero', async () => {
    answersWeights({ refund: 6, exchange: 3 });

    await expect(run({})).rejects.toMatchObject({ code: 'DECIDE_ANSWER_INVALID' });
  });

  it('refuses a boolean question, which has no abstain edge for the threshold to use', async () => {
    await expect(
      run({ question: { id: 'q', type: 'boolean', prompt: 'is it urgent?' } }),
    ).rejects.toThrow(/boolean question/);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('refuses a question with no abstain option before any model is called', async () => {
    await expect(
      run({
        question: {
          ...question,
          options: [{ id: 'refund' }, { id: 'exchange' }],
        },
      }),
    ).rejects.toThrow(/has no abstain option/);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  describe('pipeline validation', () => {
    const pipeline = (decisionData: any): AgentPipeline => ({
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'd1', type: 'decision', data: decisionData },
        { id: 'out', type: 'output' },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'd1' },
        { id: 'e2', source: 'd1', target: 'out' },
      ],
    });

    it('rejects a choice question with no abstain option', () => {
      // A forced choice over options that do not contain the truth is not
      // an answer, it is the highest-scoring wrong option. The rule lives
      // in the decide contract and validation reuses it rather than
      // restating it, so the two cannot drift.
      expect(() =>
        validator.validatePipeline(
          pipeline({
            question: {
              id: 'q',
              type: 'choice',
              prompt: 'what?',
              options: [{ id: 'a' }, { id: 'b' }],
            },
          }),
        ),
      ).toThrow(BadRequestException);

      expect(() =>
        validator.validatePipeline(
          pipeline({
            question: {
              id: 'q',
              type: 'choice',
              prompt: 'what?',
              options: [{ id: 'a' }, { id: 'b' }],
            },
          }),
        ),
      ).toThrow(/ABSTAIN_MISSING/);
    });

    it('accepts a choice question that declares exactly one abstain option', () => {
      expect(() =>
        validator.validatePipeline(pipeline({ question, thresholds: { refund: 0.8 } })),
      ).not.toThrow();
    });

    it('rejects two abstain options, which make the escape hatch ambiguous', () => {
      expect(() =>
        validator.validatePipeline(
          pipeline({
            question: {
              id: 'q',
              type: 'choice',
              prompt: 'what?',
              options: [{ id: 'a' }, { id: 'b', abstain: true }, { id: 'c', abstain: true }],
            },
          }),
        ),
      ).toThrow(/ABSTAIN_AMBIGUOUS/);
    });

    it('rejects a node with no question at all', () => {
      expect(() => validator.validatePipeline(pipeline({}))).toThrow(/must have a 'question'/);
    });

    it('rejects a threshold on an option the question does not declare', () => {
      expect(() =>
        validator.validatePipeline(pipeline({ question, thresholds: { nope: 0.5 } })),
      ).toThrow(/does not declare as an option/);
    });

    it('rejects a threshold that is not a probability', () => {
      expect(() =>
        validator.validatePipeline(pipeline({ question, thresholds: { refund: 7 } })),
      ).toThrow(/between 0 and 1/);
    });
  });
});
