import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentTemplateResolver, ExecutionContext } from '../agent-template-resolver';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { AgentWebhookService } from '../agent-webhook.service';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { A2AClientService } from '../../a2a/a2a-client.service';
import { ExternalAgentsService } from '../../a2a/external-agents.service';
import {
  Agent,
  AgentStatus,
  AgentPipeline,
  AgentPipelineNode,
} from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * A merge whose upstreams all failed used to answer with an unrelated node's
 * output and the run was saved COMPLETED.
 *
 * `getIncomingOutputs` fell back, when no incoming edge had produced a defined
 * output, to gathering every other node's output from the context in insertion
 * order. A failed node was recorded as `{ output: undefined }`, indistinguishable
 * from a node that legitimately produced nothing, and `markBranchAsSkipped`
 * refuses to skip a node with more than one incoming edge whose sources are not
 * themselves skipped -- a failed node never is. So the merge ran, found nothing,
 * and returned the first thing in the context: the input node's output, i.e. the
 * run's own invocation payload. The output node captured it, which kept the
 * `hasNodeFailures && !outputCaptured` guard from ever firing.
 *
 * The user got their own question back, presented as the agent's answer, with a
 * green COMPLETED next to it.
 */
describe('a merge with nothing real to merge fails the run', () => {
  const INPUT_PAYLOAD = { question: 'what is the capital of France?' };

  /** input -> two llm branches -> merge -> output. */
  const fanOutPipeline = (): AgentPipeline => ({
    nodes: [
      { id: 'input', type: 'input', config: {} },
      {
        id: 'branch_a',
        type: 'llm_call',
        config: {},
        data: { providerId: 'p-1', model: 'm', userPromptTemplate: '{{input.question}}' },
      },
      {
        id: 'branch_b',
        type: 'llm_call',
        config: {},
        data: { providerId: 'p-1', model: 'm', userPromptTemplate: '{{input.question}}' },
      },
      { id: 'merge', type: 'merge', config: {}, data: { strategy: 'first_response' } },
      { id: 'output', type: 'output', config: {} },
    ] as AgentPipelineNode[],
    edges: [
      { id: 'e1', source: 'input', target: 'branch_a' },
      { id: 'e2', source: 'input', target: 'branch_b' },
      { id: 'e3', source: 'branch_a', target: 'merge' },
      { id: 'e4', source: 'branch_b', target: 'merge' },
      { id: 'e5', source: 'merge', target: 'output' },
    ],
  });

  const makeAgent = (): Agent => {
    const agent = new Agent();
    agent.id = 'agent-1';
    agent.name = 'Fan out';
    agent.organizationId = 'org-1';
    agent.status = AgentStatus.ACTIVE;
    agent.pipeline = fanOutPipeline();
    agent.variables = {};
    agent.settings = {};
    agent.metadata = {};
    agent.totalExecutions = 0;
    agent.successfulExecutions = 0;
    agent.totalCost = 0;
    agent.averageExecutionTime = 0;
    agent.incrementExecution = jest.fn() as any;
    return agent;
  };

  let engine: AgentExecutionEngine;
  let executor: AgentNodeExecutor;
  let chat: jest.Mock;

  beforeEach(async () => {
    chat = jest.fn().mockRejectedValue(new Error('provider is down'));

    const execution = new AgentExecution();
    Object.assign(execution, {
      id: 'exec-1',
      agentId: 'agent-1',
      organizationId: 'org-1',
      status: AgentExecutionStatus.RUNNING,
      input: {},
      nodeResults: {},
      metadata: {},
    });

    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutionEngine,
        AgentExecutionStateHelper,
        AgentNodeExecutor,
        AgentTemplateResolver,
        AgentSubAgentExecutors,
        AgentVerifierHelper,
        { provide: LlmProvidersService, useValue: { chat } },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        { provide: A2AClientService, useValue: {} },
        { provide: ExternalAgentsService, useValue: {} },
        { provide: AgentWebhookService, useValue: { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: getRepositoryToken(Agent),
          useValue: { save: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue(qb) },
        },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn().mockResolvedValue(null) } },
        {
          provide: getRepositoryToken(AgentExecution),
          useValue: {
            create: jest.fn().mockReturnValue(execution),
            save: jest.fn().mockImplementation((e: any) => Promise.resolve(e)),
          },
        },
      ],
    }).compile();

    engine = module.get(AgentExecutionEngine);
    executor = module.get(AgentNodeExecutor);
  });

  it('does not report the run COMPLETED, and never echoes the input back as the answer', async () => {
    const result = await engine.execute(makeAgent(), 'org-1', 'user-1', { input: INPUT_PAYLOAD });

    expect(chat).toHaveBeenCalled();
    expect(result.status).toBe(AgentExecutionStatus.FAILED);
    // The specific harm: the run's own invocation payload served back as the
    // agent's answer.
    expect(result.output).not.toEqual(INPUT_PAYLOAD);
    expect(JSON.stringify(result.output ?? null)).not.toContain('capital of France');
    expect(result.error).toBeTruthy();
  });

  it('records the merge as failed rather than as an answer', async () => {
    const result = await engine.execute(makeAgent(), 'org-1', 'user-1', { input: INPUT_PAYLOAD });

    const merge = (result.nodeResults as any)?.merge;
    expect(merge?.output).toBeUndefined();
    expect(merge?.error ?? merge?.skipped).toBeTruthy();
  });

  // The unit-level statement of the same rule, so the refusal is pinned to
  // the node executor and not only to this particular graph shape.
  describe('getIncomingOutputs', () => {
    const edges = fanOutPipeline().edges;
    const mergeNode = fanOutPipeline().nodes.find((n) => n.id === 'merge')!;

    const contextWith = (nodes: ExecutionContext['nodes']): ExecutionContext => ({
      input: INPUT_PAYLOAD,
      nodes,
      variables: {},
    });

    it('refuses when every declared upstream failed', async () => {
      await expect(
        executor.execute(mergeNode, contextWith({
          input: { output: INPUT_PAYLOAD },
          branch_a: { output: undefined, status: 'failed' },
          branch_b: { output: undefined, status: 'failed' },
        }), 'org-1', 'user-1', { edges, organizationId: 'org-1' }),
      ).rejects.toThrow(/no upstream output/);
    });

    it('refuses when every declared upstream was skipped', async () => {
      await expect(
        executor.execute(mergeNode, contextWith({
          input: { output: INPUT_PAYLOAD },
          branch_a: { output: undefined, status: 'skipped' },
          branch_b: { output: undefined, status: 'skipped' },
        }), 'org-1', 'user-1', { edges, organizationId: 'org-1' }),
      ).rejects.toThrow(/no upstream output/);
    });

    it('names the upstreams and their state so the run record says what went wrong', async () => {
      await expect(
        executor.execute(mergeNode, contextWith({
          input: { output: INPUT_PAYLOAD },
          branch_a: { output: undefined, status: 'failed' },
          branch_b: { output: undefined, status: 'skipped' },
        }), 'org-1', 'user-1', { edges, organizationId: 'org-1' }),
      ).rejects.toThrow(/branch_a \(failed\).*branch_b \(skipped\)/);
    });

    it('still merges the branches that did produce something', async () => {
      const result = await executor.execute(
        mergeNode,
        contextWith({
          input: { output: INPUT_PAYLOAD },
          branch_a: { output: undefined, status: 'failed' },
          branch_b: { output: 'the real answer' },
        }),
        'org-1',
        'user-1',
        { edges, organizationId: 'org-1' },
      );

      expect(result.output).toBe('the real answer');
    });
  });
});
