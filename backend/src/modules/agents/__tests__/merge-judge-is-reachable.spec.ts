import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { ModelRouterService } from '../../model-catalog/routing/model-router.service';
import { A2AClientService } from '../../a2a/a2a-client.service';
import { ExternalAgentsService } from '../../a2a/external-agents.service';
import { Agent, AgentPipelineNode } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * A merge node's judge has to be reachable from a compiled strategy.
 *
 * Both judged merge strategies insisted on `judgeConfig.providerId` and
 * accepted nothing else. The compiler names a ROLE and never a provider —
 * that is the design — so `best_of_n` and `panel` threw
 * "requires judgeConfig.providerId" the instant a run reached the merge.
 * Two of the five built-in strategies could not complete, and no test
 * noticed because the compiler specs stop at the graph and the executor
 * specs only ever fed the merge a pinned provider.
 *
 * `consensusThreshold` is the other half: a slider in the builder, saved
 * on the node, read by nothing. The consensus merge asked a model to
 * blend the answers and never measured whether they agreed, so a shape
 * whose stated point is "disagreement is the signal" emitted no signal.
 */
describe('a merge node can judge with a role, and consensus measures agreement', () => {
  let executor: AgentNodeExecutor;
  let llm: { chat: jest.Mock };

  const buildContext = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
    input: {},
    nodes: {},
    variables: {},
    ...over,
  });

  const node = (data: any, id = 'judge'): AgentPipelineNode =>
    ({ id, type: 'merge', data } as AgentPipelineNode);

  /** Three candidate answers reaching the merge over three edges. */
  const threeCandidates = {
    context: buildContext({
      nodes: {
        'candidate#1': { output: 'the first answer' },
        'candidate#2': { output: 'the second answer' },
        'candidate#3': { output: 'the third answer' },
      },
    }),
    edges: [
      { id: 'e1', source: 'candidate#1', target: 'judge' },
      { id: 'e2', source: 'candidate#2', target: 'judge' },
      { id: 'e3', source: 'candidate#3', target: 'judge' },
    ],
  };

  const answers = (content: string) => {
    llm.chat.mockResolvedValue({
      message: { role: 'assistant', content },
      cost: 0.002,
      usage: { totalTokens: 90 },
    } as any);
  };

  beforeEach(async () => {
    llm = { chat: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentNodeExecutor,
        AgentTemplateResolver,
        AgentSubAgentExecutors,
        AgentVerifierHelper,
        { provide: LlmProvidersService, useValue: llm },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        { provide: AgentExecutionEngine, useValue: { execute: jest.fn() } },
        {
          provide: ModelRouterService,
          useValue: {
            providerForModelId: jest.fn().mockResolvedValue({
              card: { vendorModelId: 'vendor-model' },
              provider: { id: 'provider-from-role' },
            }),
          },
        },
        { provide: A2AClientService, useValue: {} },
        { provide: ExternalAgentsService, useValue: {} },
        { provide: getRepositoryToken(Agent), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    executor = module.get(AgentNodeExecutor);
  });

  const withRole = {
    organizationId: 'org-1',
    resolvedRoles: [{ key: 'role-verifier', modelId: 'm1', via: 'resolved' as const }],
  };

  describe('best_of_n', () => {
    it('judges with the role the compiler bound, not a pinned provider', async () => {
      answers('2');
      const result = await executor.execute(
        node({ strategy: 'best_of_n', roleKey: 'role-verifier' }),
        threeCandidates.context,
        'org-1',
        undefined,
        { ...withRole, edges: threeCandidates.edges },
      );

      expect(result.output).toBe('the second answer');
      // The role decided the provider, which is what makes a compiled
      // strategy portable across vendors.
      expect(llm.chat).toHaveBeenCalledWith('provider-from-role', expect.anything(), 'org-1', undefined);
      expect(result.cost).toBe(0.002);
    });

    it('still honours a pinned provider on a hand-drawn graph', async () => {
      answers('1');
      await executor.execute(
        node({ strategy: 'best_of_n', judgeConfig: { providerId: 'pinned-p' } }),
        threeCandidates.context,
        'org-1',
        undefined,
        { organizationId: 'org-1', edges: threeCandidates.edges },
      );
      expect(llm.chat).toHaveBeenCalledWith('pinned-p', expect.anything(), 'org-1', undefined);
    });

    it('does not spend a call to choose between one answer and nothing', async () => {
      const ctx = buildContext({ nodes: { only: { output: 'the only answer' } } });
      const result = await executor.execute(
        node({ strategy: 'best_of_n', roleKey: 'role-verifier' }),
        ctx,
        'org-1',
        undefined,
        { ...withRole, edges: [{ id: 'e', source: 'only', target: 'judge' }] },
      );
      expect(result.output).toBe('the only answer');
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('falls back to the first candidate when the judge does not answer with a number', async () => {
      answers('I like the third one best');
      const result = await executor.execute(
        node({ strategy: 'best_of_n', roleKey: 'role-verifier' }),
        threeCandidates.context,
        'org-1',
        undefined,
        { ...withRole, edges: threeCandidates.edges },
      );
      expect(result.output).toBe('the first answer');
    });

    it('clamps a pick outside the range rather than returning undefined', async () => {
      answers('7');
      const result = await executor.execute(
        node({ strategy: 'best_of_n', roleKey: 'role-verifier' }),
        threeCandidates.context,
        'org-1',
        undefined,
        { ...withRole, edges: threeCandidates.edges },
      );
      expect(result.output).toBe('the third answer');
    });
  });

  describe('consensus', () => {
    const consensusNode = (over: any = {}) =>
      node({ strategy: 'consensus', roleKey: 'role-verifier', ...over }, 'consensus');

    const run = (nodeData: any = {}) =>
      executor.execute(consensusNode(nodeData), threeCandidates.context, 'org-1', undefined, {
        ...withRole,
        edges: threeCandidates.edges.map((e) => ({ ...e, target: 'consensus' })),
      });

    it('reports the agreement it measured and whether it cleared the threshold', async () => {
      answers(JSON.stringify({ agreeing: 3, answer: 'they all said this' }));
      const result = await run({ consensusThreshold: 0.6 });
      expect(result.output).toMatchObject({
        answer: 'they all said this',
        agreement: 1,
        consensusReached: true,
        threshold: 0.6,
        responses: 3,
      });
    });

    it('reads consensusThreshold, so the builder control means something', async () => {
      answers(JSON.stringify({ agreeing: 2, answer: 'two of three' }));

      const lenient = await run({ consensusThreshold: 0.5 });
      expect(lenient.output).toMatchObject({ agreement: 2 / 3, consensusReached: true });

      const strict = await run({ consensusThreshold: 0.9 });
      expect(strict.output).toMatchObject({ agreement: 2 / 3, consensusReached: false });
    });

    it('defaults the threshold to a simple majority', async () => {
      answers(JSON.stringify({ agreeing: 2, answer: 'two of three' }));
      const result = await run();
      expect(result.output).toMatchObject({ threshold: 0.5, consensusReached: true });
    });

    it('does not read "we could not tell" as agreement', async () => {
      // A judge that ignored the JSON ask still said something useful, so
      // the answer survives — but nothing downstream may treat an
      // unmeasured agreement as consensus.
      answers('They broadly agree, I would say.');
      const result = await run({ consensusThreshold: 0.5 });
      expect(result.output).toMatchObject({
        answer: 'They broadly agree, I would say.',
        agreement: undefined,
        consensusReached: false,
      });
    });

    it('clamps an agreeing count the judge over-reported', async () => {
      answers(JSON.stringify({ agreeing: 9, answer: 'a' }));
      const result = await run();
      expect((result.output as any).agreement).toBe(1);
    });
  });
});
