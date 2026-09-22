/**
 * A cancelled workflow run kept spending (issue #653).
 *
 * `POST /runs/:id/cancel` stops an AgentRun. A workflow run is not a run --
 * it is an AgentExecution -- so a client that cancelled without dropping
 * its SSE connection, or any caller wanting to stop an execution it started
 * elsewhere, had nothing to call. The engine had always cancelled
 * cooperatively on `options.signal`, but nothing held the controller behind
 * that signal, so the signal was unreachable by id.
 *
 * These tests cover the registry and the cancel semantics; the engine test
 * at the bottom is the one that proves the signal actually stops a run.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentExecutionCancellationService } from '../agent-execution-cancellation.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentWebhookService } from '../agent-webhook.service';
import { Agent, AgentStatus, AgentPipeline } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';

function makeExecutionRow(overrides: Partial<AgentExecution> = {}): AgentExecution {
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
  return Object.assign(exec, overrides);
}

/** A repository that only hands back rows matching the whole `where`. */
function fakeExecutionRepo(rows: AgentExecution[]) {
  const saved: AgentExecution[] = [];
  return {
    saved,
    create: jest.fn((v: any) => Object.assign(makeExecutionRow(), v)),
    save: jest.fn(async (e: AgentExecution) => {
      saved.push(Object.assign(new AgentExecution(), e));
      return e;
    }),
    findOne: jest.fn(async ({ where }: any) => {
      return (
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => (r as any)[k] === v),
        ) ?? null
      );
    }),
  };
}

describe('AgentExecutionCancellationService', () => {
  describe('cancel', () => {
    it('aborts the registered signal and persists CANCELLED', async () => {
      const row = makeExecutionRow();
      const repo = fakeExecutionRepo([row]);
      const service = new AgentExecutionCancellationService(repo as any);

      const controller = service.register('exec-1', 'org-1');
      expect(controller.signal.aborted).toBe(false);

      const result = await service.cancel('exec-1', 'org-1');

      expect(controller.signal.aborted).toBe(true);
      expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(repo.saved[0].status).toBe(AgentExecutionStatus.CANCELLED);
      expect(repo.saved[0].error).toBe('Execution cancelled');
    });

    it('reports an explicit cancel so the engine does not overwrite it with COMPLETED', async () => {
      const repo = fakeExecutionRepo([makeExecutionRow()]);
      const service = new AgentExecutionCancellationService(repo as any);
      service.register('exec-1', 'org-1');

      expect(service.isCancelled('exec-1')).toBe(false);
      await service.cancel('exec-1', 'org-1');
      expect(service.isCancelled('exec-1')).toBe(true);
    });

    it('a client disconnect is not an explicit cancel', async () => {
      const repo = fakeExecutionRepo([makeExecutionRow()]);
      const service = new AgentExecutionCancellationService(repo as any);
      const upstream = new AbortController();
      const controller = service.register('exec-1', 'org-1', upstream.signal);

      upstream.abort();

      expect(controller.signal.aborted).toBe(true);
      expect(service.isCancelled('exec-1')).toBe(false);
    });

    it('mirrors an upstream signal that had already aborted before registration', () => {
      const repo = fakeExecutionRepo([]);
      const service = new AgentExecutionCancellationService(repo as any);
      const upstream = new AbortController();
      upstream.abort();

      expect(service.register('exec-1', 'org-1', upstream.signal).signal.aborted).toBe(true);
    });

    it('still records CANCELLED for an execution running on another replica', async () => {
      const repo = fakeExecutionRepo([makeExecutionRow()]);
      const service = new AgentExecutionCancellationService(repo as any);
      // Nothing registered: this process is not the one running it.

      const result = await service.cancel('exec-1', 'org-1');

      expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
      expect(repo.saved[0].status).toBe(AgentExecutionStatus.CANCELLED);
    });

    it('stops tracking a finished execution', async () => {
      const repo = fakeExecutionRepo([makeExecutionRow()]);
      const service = new AgentExecutionCancellationService(repo as any);
      service.register('exec-1', 'org-1');
      expect(service.isTracked('exec-1')).toBe(true);
      service.release('exec-1');
      expect(service.isTracked('exec-1')).toBe(false);
    });
  });

  describe('another organization cannot cancel my execution', () => {
    it('refuses with not-found and leaves the run untouched', async () => {
      const row = makeExecutionRow({ organizationId: 'victim-org' });
      const repo = fakeExecutionRepo([row]);
      const service = new AgentExecutionCancellationService(repo as any);
      const controller = service.register('exec-1', 'victim-org');

      await expect(service.cancel('exec-1', 'attacker-org')).rejects.toBeInstanceOf(NotFoundException);

      // Not aborted, not saved, and not even told the id exists.
      expect(controller.signal.aborted).toBe(false);
      expect(repo.save).not.toHaveBeenCalled();
      expect(row.status).toBe(AgentExecutionStatus.RUNNING);
    });

    it('refuses when the execution belongs to a different agent in my own org', async () => {
      const row = makeExecutionRow({ agentId: 'agent-1' });
      const repo = fakeExecutionRepo([row]);
      const service = new AgentExecutionCancellationService(repo as any);
      const controller = service.register('exec-1', 'org-1');

      await expect(service.cancel('exec-1', 'org-1', 'agent-2')).rejects.toBeInstanceOf(NotFoundException);
      expect(controller.signal.aborted).toBe(false);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('refuses when no organization is in scope at all', async () => {
      const repo = fakeExecutionRepo([makeExecutionRow()]);
      const service = new AgentExecutionCancellationService(repo as any);

      await expect(service.cancel('exec-1', '')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('cancelling a finished execution', () => {
    for (const status of [
      AgentExecutionStatus.COMPLETED,
      AgentExecutionStatus.FAILED,
      AgentExecutionStatus.CANCELLED,
      AgentExecutionStatus.TIMEOUT,
    ]) {
      it(`is a 409, not a crash and not a silent success, for ${status}`, async () => {
        const row = makeExecutionRow({ status });
        const repo = fakeExecutionRepo([row]);
        const service = new AgentExecutionCancellationService(repo as any);

        await expect(service.cancel('exec-1', 'org-1')).rejects.toBeInstanceOf(ConflictException);
        expect(repo.save).not.toHaveBeenCalled();
        expect(row.status).toBe(status);
      });
    }
  });
});

// ── The engine actually stops ────────────────────────────────────────────

function makeAgent(pipeline: AgentPipeline): Agent {
  const agent = new Agent();
  agent.id = 'agent-1';
  agent.name = 'Cancellable';
  agent.organizationId = 'org-1';
  agent.status = AgentStatus.ACTIVE;
  agent.pipeline = pipeline;
  agent.variables = {};
  agent.settings = {};
  agent.metadata = {};
  agent.totalExecutions = 0;
  agent.successfulExecutions = 0;
  agent.totalCost = 0;
  agent.averageExecutionTime = 0;
  agent.createdBy = 'user-1';
  return agent;
}

describe('cancelling reaches the running engine', () => {
  let engine: AgentExecutionEngine;
  let cancellations: AgentExecutionCancellationService;
  let executionRow: AgentExecution;
  let nodeExecutor: { execute: jest.Mock };
  let repo: ReturnType<typeof fakeExecutionRepo>;

  beforeEach(async () => {
    executionRow = makeExecutionRow();
    repo = fakeExecutionRepo([executionRow]);
    // The engine creates the row; hand it the same object the service reads.
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

  it('marks the run CANCELLED and dispatches no further layer', async () => {
    const pipeline: AgentPipeline = {
      nodes: [
        { id: 'a', type: 'input', config: {} },
        { id: 'b', type: 'transform', config: {} },
        { id: 'c', type: 'output', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    } as AgentPipeline;

    const ran: string[] = [];
    let cancelError: unknown;
    nodeExecutor.execute.mockImplementation(async (node: any) => {
      ran.push(node.id);
      if (node.id === 'a') {
        // Cancel by id while the first layer is still in flight — exactly
        // what the HTTP endpoint does, with no reference to the engine.
        await cancellations.cancel(executionRow.id, 'org-1').catch((e) => { cancelError = e; });
      }
      return { output: node.id };
    });

    const result = await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} });

    expect(cancelError).toBeUndefined();
    expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(result.error).toBe('Execution cancelled');
    // Layer 1 ran; the layers after the cancel never got dispatched.
    expect(ran).toEqual(['a']);
    // And the registry does not leak the finished execution.
    expect(cancellations.isTracked(executionRow.id)).toBe(false);
  });

  it('a cancel during the final layer is not overwritten by COMPLETED', async () => {
    const pipeline: AgentPipeline = {
      nodes: [{ id: 'only', type: 'output', config: {} }],
      edges: [],
    } as AgentPipeline;

    nodeExecutor.execute.mockImplementation(async () => {
      await cancellations.cancel(executionRow.id, 'org-1');
      return { output: 'an answer nobody asked for any more' };
    });

    const result = await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} });

    expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(repo.saved[repo.saved.length - 1].status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('releases the execution even when the run crashes', async () => {
    const pipeline: AgentPipeline = {
      nodes: [{ id: 'only', type: 'output', config: {} }],
      edges: [],
    } as AgentPipeline;

    repo.save = jest.fn(async () => { throw new Error('db gone'); }) as any;
    nodeExecutor.execute.mockResolvedValue({ output: 'x' });

    await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} }).catch(() => {});

    expect(cancellations.isTracked(executionRow.id)).toBe(false);
  });
});
