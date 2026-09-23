import { readFileSync } from 'fs';
import { join } from 'path';

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentExecutionCancellationService } from '../agent-execution-cancellation.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentWebhookService } from '../agent-webhook.service';
import { Agent, AgentPipeline } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { fakeExecutionRepo, makeAgent, makeExecutionRow } from './agent-execution.fixtures';

/**
 * A cancelled run was recorded as FAILED, with "Pipeline failed: ..." as its
 * reason.
 *
 * The engine had a guard for a cancel that lands on the LAST layer -- there
 * is no next layer for the between-layer check to catch -- but it sat AFTER
 * the `hasNodeFailures && !outputCaptured` branch. Cancelling is precisely
 * what makes the last layer's nodes come back as errors (the abort signal
 * surfaces as a node error) and precisely what stops the `output` node
 * capturing, so the failure branch always fired first and returned before
 * the cancel guard was reached.
 *
 * The existing cancellation spec missed it because its final-layer case has
 * the node RESOLVE after the cancel, which is the one shape that skips the
 * failure branch.
 */
// makeExecutionRow / fakeExecutionRepo / makeAgent are shared, in
// ./agent-execution.fixtures — a third private copy of the fake
// repository would drift from the guarded-write semantics the engine
// now relies on.

describe('a cancelled run is recorded as cancelled, not as a pipeline failure', () => {
  let engine: AgentExecutionEngine;
  let cancellations: AgentExecutionCancellationService;
  let executionRow: AgentExecution;
  let nodeExecutor: { execute: jest.Mock };
  let repo: ReturnType<typeof fakeExecutionRepo>;

  beforeEach(async () => {
    executionRow = makeExecutionRow();
    repo = fakeExecutionRepo([executionRow]);
    repo.create = jest.fn(() => executionRow) as any;

    const qbUpdateChain = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutionEngine,
        AgentExecutionCancellationService,
        AgentExecutionStateHelper,
        {
          provide: getRepositoryToken(Agent),
          useValue: { save: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn(() => qbUpdateChain) },
        },
        { provide: getRepositoryToken(AgentExecution), useValue: repo },
        { provide: AgentNodeExecutor, useValue: { execute: jest.fn() } },
        { provide: AgentWebhookService, useValue: { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    engine = module.get(AgentExecutionEngine);
    cancellations = module.get(AgentExecutionCancellationService);
    nodeExecutor = module.get(AgentNodeExecutor);
  });

  it('a cancel that aborts the final layer reads as CANCELLED', async () => {
    const pipeline: AgentPipeline = {
      nodes: [{ id: 'only', type: 'output', config: {} }],
      edges: [],
    } as AgentPipeline;

    // The realistic shape: the cancel aborts the node, so it rejects rather
    // than returning, and no output node ever captures.
    nodeExecutor.execute.mockImplementation(async () => {
      await cancellations.cancel(executionRow.id, 'org-1');
      throw new Error('The operation was aborted');
    });

    const result = await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} });

    expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(result.error).toBe('Execution cancelled');
    expect(result.error).not.toMatch(/Pipeline failed/);
    expect(repo.saved[repo.saved.length - 1].status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('an ordinary node failure with no cancel still reads as FAILED', async () => {
    const pipeline: AgentPipeline = {
      nodes: [{ id: 'only', type: 'output', config: {} }],
      edges: [],
    } as AgentPipeline;

    nodeExecutor.execute.mockRejectedValue(new Error('upstream exploded'));

    const result = await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} });

    expect(result.status).toBe(AgentExecutionStatus.FAILED);
    expect(result.error).toMatch(/Pipeline failed/);
  });
});

describe('the cancel guard sits before the failure branch', () => {
  const engine = readFileSync(join(__dirname, '..', 'agent-execution.engine.ts'), 'utf8');

  it('isCancelled is consulted before hasNodeFailures is computed', () => {
    const cancelAt = engine.indexOf('this.cancellations?.isCancelled(execution.id)');
    const failAt = engine.indexOf('const hasNodeFailures =');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(failAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(failAt);
  });
});
