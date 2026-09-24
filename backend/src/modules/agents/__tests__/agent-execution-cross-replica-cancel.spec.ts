import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
/**
 * Cancelling a workflow run across replicas.
 *
 * The API runs `replicas: 2` with no separate worker, and the cancellation
 * registry is a per-process `Map`. So roughly half of all cancels landed on
 * the replica that was NOT running the execution:
 *
 *   - the cancel hits replica B, which writes CANCELLED and answers 200
 *   - replica A never hears, keeps spending, finishes, and writes COMPLETED
 *     straight over the cancelled row
 *
 * The user was told it stopped; it did not, and the record then claimed it
 * had completed normally.
 *
 * Two halves, tested separately because they hold separately:
 *
 *   1. terminal writes are guarded on the row not already being terminal,
 *      so a late replica can no longer overwrite CANCELLED — this holds on
 *      its own, with no Redis and no signal
 *   2. a cancel is published on Redis pub/sub and every replica subscribes,
 *      so the replica actually holding the run aborts it and stops spending
 *
 * The second half is tested with two real service instances over one fake
 * bus, not with a mocked-away bus: a test that stubs the fan-out proves
 * only that a method was called.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  AgentExecutionCancellationService,
  EXECUTION_CANCEL_CHANNEL,
} from '../agent-execution-cancellation.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentWebhookService } from '../agent-webhook.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { Agent, AgentPipeline } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { fakeExecutionRepo, makeAgent, makeExecutionRow } from './agent-execution.fixtures';

// ── A Redis that is really only a pub/sub bus ────────────────────────────

/**
 * One process-wide bus with as many clients on it as the test wants. Each
 * client behaves like the bits of ioredis this service touches: `publish`,
 * `duplicate`, `subscribe`, `on('message')`.
 *
 * Delivery is synchronous, which a real Redis is not; the service's
 * handler is synchronous too, so nothing about the ordering under test
 * depends on the difference.
 */
class FakeRedisBus {
  private readonly subscribers: Array<{ channels: Set<string>; handler?: (ch: string, msg: string) => void }> = [];
  readonly published: Array<{ channel: string; message: string }> = [];

  client(): any {
    const bus = this;
    const makeClient = (): any => ({
      publish: async (channel: string, message: string) => {
        bus.published.push({ channel, message });
        // A snapshot, so a handler that subscribes during delivery does
        // not receive the message it is reacting to.
        for (const sub of [...bus.subscribers]) {
          if (sub.channels.has(channel)) sub.handler?.(channel, message);
        }
        return 1;
      },
      duplicate: () => {
        const entry: { channels: Set<string>; handler?: (ch: string, msg: string) => void } = {
          channels: new Set(),
        };
        bus.subscribers.push(entry);
        const sub = makeClient();
        sub.subscribe = async (channel: string) => {
          entry.channels.add(channel);
          return 1;
        };
        sub.unsubscribe = async (channel: string) => {
          entry.channels.delete(channel);
          return 1;
        };
        sub.on = (event: string, handler: any) => {
          if (event === 'message') entry.handler = handler;
          return sub;
        };
        sub.quit = async () => 'OK';
        return sub;
      },
      on: () => undefined,
      subscribe: async () => 1,
      quit: async () => 'OK',
    });
    return makeClient();
  }
}

// ── Half 1: a late COMPLETED cannot overwrite CANCELLED ──────────────────

describe('a terminal write cannot overwrite a terminal status already recorded', () => {
  let engine: AgentExecutionEngine;
  /** The registry belonging to the replica that is running the pipeline. */
  let replicaA: AgentExecutionCancellationService;
  /** A second process with its own registry: the one the cancel lands on. */
  let replicaB: AgentExecutionCancellationService;
  let executionRow: AgentExecution;
  let repo: ReturnType<typeof fakeExecutionRepo>;
  let nodeExecutor: { execute: jest.Mock };

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
        { provide: ExecutionAccessService, useValue: membershipFixture().executionAccess },
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
    replicaA = module.get(AgentExecutionCancellationService);
    nodeExecutor = module.get(AgentNodeExecutor);

    // A separate process: same table, its own empty registry, and no bus
    // between them. This is the state the fix has to survive whether or
    // not the signal gets through.
    replicaB = new AgentExecutionCancellationService(repo as any);
  });

  it('a replica that finishes after another cancelled the run does not write COMPLETED over it', async () => {
    const pipeline: AgentPipeline = {
      nodes: [{ id: 'only', type: 'output', config: {} }],
      edges: [],
    } as AgentPipeline;

    nodeExecutor.execute.mockImplementation(async () => {
      // The cancel lands on the OTHER replica. Nothing in this process is
      // told: replicaA's registry entry is untouched, so the engine has no
      // idea and runs to completion.
      await replicaB.cancel(executionRow.id, 'org-1');
      expect(replicaA.isCancelled(executionRow.id)).toBe(false);
      return { output: 'an answer nobody asked for any more' };
    });

    const result = await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} });

    // The row keeps the cancel, and the engine reports the outcome that
    // actually stands rather than the one it wanted to write.
    expect(repo.current(executionRow.id)!.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(repo.current(executionRow.id)!.error).toBe('Execution cancelled');
    expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
    // Nothing anywhere in the history of this row says completed.
    expect(repo.saved.map((s) => s.status)).not.toContain(AgentExecutionStatus.COMPLETED);
  });

  it('an ordinary run still records COMPLETED', async () => {
    const pipeline: AgentPipeline = {
      nodes: [{ id: 'only', type: 'output', config: {} }],
      edges: [],
    } as AgentPipeline;

    nodeExecutor.execute.mockResolvedValue({ output: 'the answer' });

    const result = await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} });

    expect(result.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(repo.current(executionRow.id)!.status).toBe(AgentExecutionStatus.COMPLETED);
  });

  it('a crash on a cancelled run does not rewrite it as FAILED either', async () => {
    const pipeline: AgentPipeline = {
      nodes: [{ id: 'only', type: 'output', config: {} }],
      edges: [],
    } as AgentPipeline;

    nodeExecutor.execute.mockImplementation(async () => {
      await replicaB.cancel(executionRow.id, 'org-1');
      throw new Error('and then the node blew up');
    });

    const result = await engine.execute(makeAgent(pipeline), 'org-1', 'user-1', { input: {} });

    expect(repo.current(executionRow.id)!.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
  });
});

// ── Half 2: the cancel reaches the replica holding the run ───────────────

describe('a cancel published by one replica aborts the run held by another', () => {
  let bus: FakeRedisBus;
  let replicaA: AgentExecutionCancellationService;
  let replicaB: AgentExecutionCancellationService;
  let repo: ReturnType<typeof fakeExecutionRepo>;
  let executionRow: AgentExecution;

  beforeEach(async () => {
    executionRow = makeExecutionRow();
    repo = fakeExecutionRepo([executionRow]);
    bus = new FakeRedisBus();

    // Two service instances, each with its own client on the same bus —
    // as close to two pods as a unit test gets.
    replicaA = new AgentExecutionCancellationService(repo as any, bus.client());
    replicaB = new AgentExecutionCancellationService(repo as any, bus.client());
    await replicaA.onModuleInit();
    await replicaB.onModuleInit();
  });

  afterEach(async () => {
    await replicaA.onModuleDestroy();
    await replicaB.onModuleDestroy();
  });

  it('aborts the signal on the replica that is running it', async () => {
    // A is running the execution.
    const controller = replicaA.register(executionRow.id, 'org-1');
    expect(controller.signal.aborted).toBe(false);
    // B has never heard of it.
    expect(replicaB.isTracked(executionRow.id)).toBe(false);

    await replicaB.cancel(executionRow.id, 'org-1');

    expect(controller.signal.aborted).toBe(true);
    // And A knows it was an explicit cancel, not a client disconnect, so
    // the engine's own last-layer guard fires too.
    expect(replicaA.isCancelled(executionRow.id)).toBe(true);
    expect(repo.current(executionRow.id)!.status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('puts the cancel on the agreed channel', async () => {
    replicaA.register(executionRow.id, 'org-1');
    await replicaB.cancel(executionRow.id, 'org-1');

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].channel).toBe(EXECUTION_CANCEL_CHANNEL);
    expect(JSON.parse(bus.published[0].message)).toEqual({
      executionId: executionRow.id,
      organizationId: 'org-1',
    });
  });

  it('is idempotent under duplicate delivery', async () => {
    const controller = replicaA.register(executionRow.id, 'org-1');
    const message = JSON.stringify({ executionId: executionRow.id, organizationId: 'org-1' });

    replicaA.applyRemoteCancel(message);
    replicaA.applyRemoteCancel(message);
    replicaA.applyRemoteCancel(message);

    expect(controller.signal.aborted).toBe(true);
    expect(replicaA.isCancelled(executionRow.id)).toBe(true);
  });

  it('ignores a cancel for a run this replica does not hold', () => {
    expect(() =>
      replicaA.applyRemoteCancel(JSON.stringify({ executionId: 'someone-elses', organizationId: 'org-1' })),
    ).not.toThrow();
    expect(replicaA.isTracked('someone-elses')).toBe(false);
  });

  it('ignores a cancel carrying another organization', () => {
    const controller = replicaA.register(executionRow.id, 'org-1');
    replicaA.applyRemoteCancel(JSON.stringify({ executionId: executionRow.id, organizationId: 'attacker-org' }));
    expect(controller.signal.aborted).toBe(false);
  });

  it('ignores an unparseable or incomplete message rather than crashing the listener', () => {
    expect(() => replicaA.applyRemoteCancel('{not json')).not.toThrow();
    expect(() => replicaA.applyRemoteCancel(JSON.stringify({ executionId: 'x' }))).not.toThrow();
  });

  it('the publishing replica still aborts a run it holds itself', async () => {
    const controller = replicaB.register(executionRow.id, 'org-1');
    await replicaB.cancel(executionRow.id, 'org-1');
    expect(controller.signal.aborted).toBe(true);
  });
});

// ── Redis unavailable degrades to yesterday's behaviour ──────────────────

describe('with no usable Redis', () => {
  it('starts, cancels and persists CANCELLED with no Redis at all', async () => {
    const row = makeExecutionRow();
    const repo = fakeExecutionRepo([row]);
    const service = new AgentExecutionCancellationService(repo as any);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    const controller = service.register(row.id, 'org-1');
    const result = await service.cancel(row.id, 'org-1');

    expect(controller.signal.aborted).toBe(true);
    expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('starts anyway when subscribing throws', async () => {
    const row = makeExecutionRow();
    const repo = fakeExecutionRepo([row]);
    const broken = {
      duplicate: () => ({
        on: () => undefined,
        subscribe: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
      publish: async () => 1,
    };
    const service = new AgentExecutionCancellationService(repo as any, broken as any);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    const controller = service.register(row.id, 'org-1');
    expect((await service.cancel(row.id, 'org-1')).status).toBe(AgentExecutionStatus.CANCELLED);
    expect(controller.signal.aborted).toBe(true);
  });

  it('a publish that rejects does not fail the cancel', async () => {
    const row = makeExecutionRow();
    const repo = fakeExecutionRepo([row]);
    const flaky = {
      duplicate: () => ({ on: () => undefined, subscribe: async () => 1, quit: async () => 'OK', unsubscribe: async () => 1 }),
      publish: async () => {
        throw new Error('connection lost mid-publish');
      },
    };
    const service = new AgentExecutionCancellationService(repo as any, flaky as any);
    await service.onModuleInit();

    const result = await service.cancel(row.id, 'org-1');

    expect(result.status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('boots even when subscribe never resolves, and cancels work meanwhile', async () => {
    // ioredis queues commands while it is offline and retries for ever,
    // so a `subscribe` against a Redis that is down simply never settles.
    // An unbounded await here would mean the process never finishes
    // booting — a cancel channel taking the API down with it.
    process.env.EXECUTION_CANCEL_SUBSCRIBE_MS = '50';
    try {
      const row = makeExecutionRow();
      const repo = fakeExecutionRepo([row]);
      const neverConnects = {
        duplicate: () => ({
          on: () => undefined,
          subscribe: () => new Promise(() => {}),
          unsubscribe: async () => 1,
          quit: async () => 'OK',
        }),
        publish: async () => 1,
      };
      const service = new AgentExecutionCancellationService(repo as any, neverConnects as any);

      const started = Date.now();
      await service.onModuleInit();
      expect(Date.now() - started).toBeLessThan(2_000);

      const controller = service.register(row.id, 'org-1');
      expect((await service.cancel(row.id, 'org-1')).status).toBe(AgentExecutionStatus.CANCELLED);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      delete process.env.EXECUTION_CANCEL_SUBSCRIBE_MS;
    }
  });
});

// ── Cancelling leaves an audit row ───────────────────────────────────────

describe('cancelling a workflow execution is audited', () => {
  it('writes a run_cancel row naming who did it', async () => {
    const row = makeExecutionRow({ totalCost: 0.42, totalTokens: 1234 });
    const repo = fakeExecutionRepo([row]);
    const auditLog = { log: jest.fn().mockResolvedValue(null) };
    const service = new AgentExecutionCancellationService(repo as any, undefined, auditLog as any);

    await service.cancel(row.id, 'org-1', 'agent-1', 'user-7');

    expect(auditLog.log).toHaveBeenCalledTimes(1);
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-7',
        action: AuditAction.RUN_CANCEL,
        resourceType: AuditResource.AGENT_RUN,
        resourceId: row.id,
        details: expect.objectContaining({ kind: 'workflow_execution', agentId: 'agent-1', totalCost: 0.42 }),
      }),
    );
  });

  it('an audit write that rejects does not fail the cancel', async () => {
    const row = makeExecutionRow();
    const repo = fakeExecutionRepo([row]);
    const auditLog = { log: jest.fn().mockRejectedValue(new Error('audit table gone')) };
    const service = new AgentExecutionCancellationService(repo as any, undefined, auditLog as any);

    await expect(service.cancel(row.id, 'org-1')).resolves.toMatchObject({
      status: AgentExecutionStatus.CANCELLED,
    });
  });

  it('a refused cancel writes no audit row', async () => {
    const row = makeExecutionRow({ status: AgentExecutionStatus.COMPLETED });
    const repo = fakeExecutionRepo([row]);
    const auditLog = { log: jest.fn().mockResolvedValue(null) };
    const service = new AgentExecutionCancellationService(repo as any, undefined, auditLog as any);

    await expect(service.cancel(row.id, 'org-1')).rejects.toThrow();
    expect(auditLog.log).not.toHaveBeenCalled();
  });
});
