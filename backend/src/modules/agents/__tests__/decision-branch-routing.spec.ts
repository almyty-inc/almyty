import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { AgentWebhookService } from '../agent-webhook.service';
import { Agent, AgentPipeline, AgentPipelineNode, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { fakeExecutionRepo } from './agent-execution.fixtures';

/**
 * That a decision node actually routes.
 *
 * The node computes a distribution, applies the threshold and names the
 * option it chose. None of that is routing. The engine decides which
 * downstream nodes run, and until it knows what `__decision` means it runs
 * every option branch regardless of which one was picked.
 *
 * That failure does not look like a failure, which is why it gets its own
 * file. Each branch produces a plausible result, nothing throws, and a
 * merge downstream reports success. The threshold is the worst-affected
 * part: routing a low-confidence answer to abstain is only worth doing
 * because the confident branches do NOT run, so a decision node whose
 * untaken branches still execute has spent the money it exists to save
 * and taken the action it exists to withhold.
 *
 * The engine's `condition` handling is the pattern being mirrored; this is
 * the same guarantee for a node with more than two edges.
 */
describe('a decision node runs only the branch it chose', () => {
  let engine: AgentExecutionEngine;
  let nodeExecutor: { execute: jest.Mock };

  /**
   * A refund-triage graph: three option branches plus the mandatory
   * abstain, each leading to a different action.
   */
  const pipeline = (): AgentPipeline => ({
    nodes: [
      { id: 'input', type: 'input', data: {} },
      {
        id: 'triage',
        type: 'decision',
        data: {
          question: {
            id: 'intent',
            type: 'choice',
            prompt: 'What does this ticket want?',
            options: [
              { id: 'refund', description: 'Wants money back' },
              { id: 'technical', description: 'Something is broken' },
              { id: 'unknown', description: 'Not enough information', abstain: true },
            ],
          },
          thresholds: { refund: 0.8 },
        },
      },
      { id: 'issue_refund', type: 'llm_call', data: {} },
      { id: 'open_ticket', type: 'llm_call', data: {} },
      { id: 'ask_human', type: 'llm_call', data: {} },
      { id: 'output', type: 'output', data: {} },
    ] as AgentPipelineNode[],
    edges: [
      { id: 'e0', source: 'input', target: 'triage' },
      { id: 'e_refund', source: 'triage', target: 'issue_refund', sourceHandle: 'refund' },
      { id: 'e_technical', source: 'triage', target: 'open_ticket', sourceHandle: 'technical' },
      { id: 'e_unknown', source: 'triage', target: 'ask_human', sourceHandle: 'unknown' },
      { id: 'e1', source: 'issue_refund', target: 'output' },
      { id: 'e2', source: 'open_ticket', target: 'output' },
      { id: 'e3', source: 'ask_human', target: 'output' },
    ],
  }) as AgentPipeline;

  const makeAgent = (): Agent => {
    const agent = new Agent();
    Object.assign(agent, {
      id: 'agent-1',
      organizationId: 'org-1',
      name: 'triage',
      status: AgentStatus.ACTIVE,
      pipeline: pipeline(),
      settings: {},
    });
    return agent;
  };

  const wire = (selectedOption: string, abstained: boolean) => {
    nodeExecutor.execute.mockImplementation(async (node: AgentPipelineNode) => {
      switch (node.type) {
        case 'input':
          return { output: { ticket: 'where is my money' } };
        case 'decision':
          return {
            output: {
              __decision: true,
              selectedOption,
              selectedEdgeId: `e_${selectedOption}`,
              argmax: 'refund',
              abstained,
              probability: abstained ? 0.6 : 0.93,
            },
          };
        default:
          return { output: `${node.id} ran` };
      }
    });
  };

  const ran = (): string[] =>
    nodeExecutor.execute.mock.calls.map(([node]: [AgentPipelineNode]) => node.id);

  beforeEach(async () => {
    nodeExecutor = { execute: jest.fn() };
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutionEngine,
        AgentExecutionStateHelper,
        {
          provide: getRepositoryToken(Agent),
          useValue: { save: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue(qb) },
        },
        {
          // The shared table-backed fake, not a hand-rolled create/save pair.
          // The engine's terminal writes are a compare-and-set update(); a
          // double without update() sent every run down the crash path, and
          // one whose save() hands back the caller's own object cannot show
          // a guarded write working at all.
          provide: getRepositoryToken(AgentExecution),
          useValue: fakeExecutionRepo([execution]),
        },
        { provide: AgentNodeExecutor, useValue: nodeExecutor },
        { provide: AgentWebhookService, useValue: { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    engine = module.get(AgentExecutionEngine);
  });

  it('runs the chosen option branch and no other', async () => {
    wire('refund', false);

    const result = await engine.execute(makeAgent(), 'org-1', 'user-1', {
      input: { ticket: 'where is my money' },
    });

    expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(ran()).toContain('issue_refund');
    expect(ran()).not.toContain('open_ticket');
    expect(ran()).not.toContain('ask_human');
  });

  it('runs the abstain branch and withholds the confident ones when the threshold is missed', async () => {
    // The case the threshold exists for. The argmax is still `refund`, so a
    // graph that routed on argmax would issue the refund; routing on the
    // post-threshold selection asks a human instead.
    wire('unknown', true);

    await engine.execute(makeAgent(), 'org-1', 'user-1', { input: { ticket: 'hmm' } });

    expect(ran()).toContain('ask_human');
    expect(ran()).not.toContain('issue_refund');
    expect(ran()).not.toContain('open_ticket');
  });

  it('leaves a branch whose edge names no option alone', async () => {
    // An unlabelled edge is not an option branch: logging, metrics or a
    // fan-out that should happen whatever was decided. Skipping it would
    // make the node's arity depend on how the graph was drawn.
    wire('refund', false);
    const agent = makeAgent();
    agent.pipeline.edges.push({ id: 'e_log', source: 'triage', target: 'open_ticket' } as any);

    await engine.execute(agent, 'org-1', 'user-1', { input: { ticket: 'x' } });

    expect(ran()).toContain('open_ticket');
  });

  it('still reaches the output node through the branch it took', async () => {
    wire('technical', false);

    await engine.execute(makeAgent(), 'org-1', 'user-1', { input: { ticket: 'it is broken' } });

    expect(ran()).toContain('open_ticket');
    expect(ran()).toContain('output');
    expect(ran()).not.toContain('issue_refund');
  });
});
