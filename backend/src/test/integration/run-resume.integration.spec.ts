/**
 * Real-Postgres and real-Redis integration spec for durable runs step 4:
 * resume and idempotency keys (docs/design/durable-runs.md, run-resume.ts).
 * The step processor runs over the migrated schema, with the row lock, the
 * lease predicates and the log as Postgres keeps them; the model and the
 * tool executor are doubled (resume-harness.ts), and an external service
 * behind the tool counts what really happened.
 *
 * The worker-kill test of the design: a worker dies after its tool call
 * and before its commit (it stops and never writes again; its lease is not
 * renewed), the lease lapses, another worker takes the run over and
 * finishes it. The side effect happens once, the model is asked no more
 * times than without the kill, the cost is counted once, and a viewer
 * connected throughout sees every event of the log once and in order.
 *
 * Gated behind `RUN_DB_INTEGRATION=1`, like the other DB specs. Redis is
 * REDIS_HOST / REDIS_PORT.
 */
import Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { Organization } from '../../entities/organization.entity';
import { AgentRuntimeEventsHelper } from '../../modules/agents/agent-runtime-events.helper';
import { projectRunEvents, storedRunState } from '../../modules/agents/run-events';
import { claimRun } from '../../modules/agents/run-lease';
import { TOOL_CHARGE, TOOL_EMAIL, answers, callsTools, externalService, never, resumeAgent, resumeRun, resumeWorkers } from '../../modules/agents/__tests__/resume-harness';
import { watchRunProjection } from '../fake-run-events';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'run_resume_test';

jest.setTimeout(60_000);

describeIfDb('durable runs step 4: resume and idempotency keys (real Postgres and Redis)', () => {
  let ds: DataSource;
  let runs: Repository<AgentRun>;
  let events: Repository<AgentRunEvent>;
  let redis: Redis;
  let orgId: string;
  let agentId: string;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public`, max: 20 },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
    runs = ds.getRepository(AgentRun);
    events = ds.getRepository(AgentRunEvent);
    redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), maxRetriesPerRequest: 1 });
    await redis.ping();

    const org = await ds.getRepository(Organization).save({ name: 'run-resume', slug: `run-resume-${Date.now()}`, plan: 'free', isActive: true } as any);
    orgId = org.id;
    const { pipeline, ...agent } = resumeAgent(orgId);
    const saved = await ds.getRepository(Agent).save({ ...agent, pipeline } as any);
    agentId = saved.id;
  });

  afterAll(async () => {
    const keys = await redis?.keys('run:*:log');
    if (keys?.length) await redis.del(...keys);
    await redis?.quit();
    if (ds?.isInitialized) await ds.destroy();
  });

  /** A run before its first step, with the doubles around it. */
  const start = async (replies: any[], dying?: (toolId: string, parameters: any, options: any) => Promise<any> | null) => {
    const run = await runs.save(runs.create({ ...resumeRun(orgId, agentId), conversationId: null } as any) as unknown as AgentRun);
    const service = externalService();
    let dead = false;
    const w = await resumeWorkers({
      runs,
      runId: run.id,
      organizationId: orgId,
      agentId,
      replies,
      executeTool: async (toolId, parameters, options) => {
        const death = !dead && dying ? dying(toolId, parameters, options) : null;
        if (death) {
          dead = true;
          return death;
        }
        return { success: true, data: service.call({ toolId, ...parameters }, options.idempotencyKey), executionTime: 3 };
      },
    });
    return { runId: run.id, service, w };
  };

  const logOf = (runId: string) => events.find({ where: { runId }, order: { seq: 'ASC' } });
  const rowOf = async (runId: string) => (await runs.findOne({ where: { id: runId } }))!;
  const expectSound = async (runId: string) => {
    const log = await logOf(runId);
    const row = await rowOf(runId);
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(row.headSeq).toBe(log.length);
    const { headSeq, ...state } = projectRunEvents(log);
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
    return { log, row };
  };
  const until = async (reached: () => boolean) => {
    for (let i = 0; i < 400 && !reached(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!reached()) throw new Error('the worker never got there');
  };
  const drive = async (worker: { processStep(id: string): Promise<string> }, runId: string) => {
    let out: string;
    do {
      out = await worker.processStep(runId);
    } while (out === 'continue');
    return out;
  };
  const ofType = (log: AgentRunEvent[], type: string) => log.filter((e) => e.type === type);

  const charge = { id: 'tc-1', name: 'charge_card', parameters: { amount: 40 } };
  const receipt = { id: 'tc-2', name: 'send_receipt', parameters: { to: 'ana@example.com' } };

  it('the worker-kill test: killed after its call and before its commit, the run finishes on another worker with the call made once', async () => {
    const watch = watchRunProjection();
    const helper = new AgentRuntimeEventsHelper(runs, redis);
    helper.onModuleInit();
    try {
      // The same run without the kill, for comparison.
      const clean = await start([callsTools([charge]), answers('Charged 40 EUR.')]);
      expect(await drive(clean.w.worker(), clean.runId)).toBe('done');
      const uninterrupted = await rowOf(clean.runId);

      const { runId, service, w } = await start([callsTools([charge]), answers('Charged 40 EUR.')]);
      // A viewer connected from the start to the end.
      const seen: number[] = [];
      const viewer = helper.subscribeRunLog(runId, 0, (e) => seen.push(e.seq), () => undefined, undefined, 30_000);

      const owner = await w.claimDead();
      const a = w.worker();
      const commit = jest.spyOn(a as any, 'commitStep').mockImplementation(never);
      void (a as any).processLeasedStep(runId, owner);
      await until(() => commit.mock.calls.length > 0);
      expect(service.effects).toHaveLength(1);

      // Workers racing to pick the run up: one takes it over and resumes.
      const b = w.worker();
      // Each is the nudge for step 0: one that comes after its commit finds the run moved on.
      const raced = await Promise.all([b, w.worker(), w.worker()].map((worker) => worker.processStep(runId, { step: 0 })));
      expect(raced.filter((o) => o === 'continue')).toHaveLength(1);
      expect(raced.filter((o) => o === 'held')).toHaveLength(2);
      expect(await drive(b, runId)).toBe('done');
      await viewer;

      const { log, row } = await expectSound(runId);
      expect(row.status).toBe(AgentRunStatus.COMPLETED);
      expect(service.effects).toHaveLength(1);
      expect(w.toolCalls).toHaveLength(1);
      expect(w.modelCalls).toHaveLength(2);
      expect(row.totalCost).toBeCloseTo(uninterrupted.totalCost, 10);
      expect(row.totalTokens).toBe(uninterrupted.totalTokens);
      expect(row.toolCallCount).toBe(uninterrupted.toolCallCount);
      expect(row.steps.map((s: any) => s.type)).toEqual(uninterrupted.steps.map((s: any) => s.type));
      expect(row).toMatchObject({ attempt: 1, takeovers: 0, leaseOwner: null });
      expect(ofType(log, 'lease_taken_over')).toHaveLength(1);
      expect(ofType(log, 'model_answered').map((e) => e.step)).toEqual([0, 1]);
      expect(ofType(log, 'tool_finished').map((e) => e.payload.key)).toEqual([`${runId}:0:0`]);
      // The viewer saw the whole log, each event once, in order.
      expect(seen).toEqual(log.map((e) => e.seq));
      expect(watch.mismatches).toEqual([]);
    } finally {
      helper.onModuleDestroy();
      watch.stop();
    }
  });

  it('killed in the call: the call goes out again with its first key, and the service makes it once', async () => {
    const { runId, service, w } = await start([callsTools([charge, receipt]), answers('Done.')], (toolId, parameters, options) => {
      if (toolId !== TOOL_EMAIL) return null;
      service.call({ toolId, ...parameters }, options.idempotencyKey);
      return never();
    });
    const owner = await w.claimDead();
    void (w.worker() as any).processLeasedStep(runId, owner);
    await until(() => w.toolCalls.length > 1);

    expect(await drive(w.worker(), runId)).toBe('done');

    expect(w.toolCalls.map((c) => [c.toolId, c.options.idempotencyKey])).toEqual([
      [TOOL_CHARGE, `${runId}:0:0`],
      [TOOL_EMAIL, `${runId}:0:1`],
      [TOOL_EMAIL, `${runId}:0:1`],
    ]);
    expect(service.effects.map((e) => e.parameters.toolId)).toEqual([TOOL_CHARGE, TOOL_EMAIL]);
    expect(w.modelCalls).toHaveLength(2);
    const { log } = await expectSound(runId);
    expect(ofType(log, 'tool_started').map((e) => e.payload.callIndex)).toEqual([0, 1, 1]);
    expect(ofType(log, 'tool_finished').map((e) => e.payload.callIndex)).toEqual([0, 1]);
  });

  it('takeover and resume against the cap: the step that keeps dying ends the run at the third takeover, its finished call made once', async () => {
    const { runId, service, w } = await start([callsTools([charge, receipt])]);
    let deaths = 0;
    const s: any = (w.worker() as any).s;
    s.toolExecutorService.executeTool.mockImplementation(async (toolId: string, parameters: any, options: any) => {
      w.toolCalls.push({ toolId, parameters, options });
      if (toolId === TOOL_EMAIL) {
        deaths++;
        return never();
      }
      return { success: true, data: service.call({ toolId, ...parameters }, options.idempotencyKey), executionTime: 3 };
    });
    const T = Date.now();
    for (let i = 0; i < 3; i++) {
      const claim = await claimRun(runs, runId, { leaseMs: 1, now: new Date(T - 100_000 + i * 10_000), maxTakeovers: 3 });
      expect(claim).toMatchObject({ claimed: true, takenOver: i > 0 });
      void (w.worker() as any).processLeasedStep(runId, (claim as any).owner);
      await until(() => deaths === i + 1);
    }
    expect((await rowOf(runId)).takeovers).toBe(2);

    const saved = process.env.RUN_MAX_TAKEOVERS;
    process.env.RUN_MAX_TAKEOVERS = '3';
    try {
      expect(await w.worker().processStep(runId)).toBe('done');
    } finally {
      if (saved === undefined) delete process.env.RUN_MAX_TAKEOVERS;
      else process.env.RUN_MAX_TAKEOVERS = saved;
    }

    const { log, row } = await expectSound(runId);
    expect(row).toMatchObject({ status: AgentRunStatus.FAILED, takeovers: 3, attempt: 3, leaseOwner: null });
    expect(row.error).toBe('This step stopped its worker 3 times in a row, so the run was stopped.');
    expect(w.toolCalls.filter((c) => c.toolId === TOOL_CHARGE)).toHaveLength(1);
    expect(w.toolCalls.filter((c) => c.toolId === TOOL_EMAIL).map((c) => c.options.idempotencyKey)).toEqual(Array(3).fill(`${runId}:0:1`));
    expect(service.effects.map((e) => e.parameters.toolId)).toEqual([TOOL_CHARGE]);
    expect(w.modelCalls).toHaveLength(1);
    expect(ofType(log, 'lease_taken_over')).toHaveLength(3);
    expect(ofType(log, 'run_failed')).toHaveLength(1);
  });

  it('a resumed step that commits counts the takeovers of the next step from 0', async () => {
    const { runId, w } = await start([callsTools([charge]), callsTools([receipt]), answers('Done.')]);
    for (let step = 0; step < 2; step++) {
      const owner = await w.claimDead();
      const dying = w.worker();
      const commit = jest.spyOn(dying as any, 'commitStep').mockImplementation(never);
      void (dying as any).processLeasedStep(runId, owner);
      await until(() => commit.mock.calls.length > 0);
      expect(await w.worker().processStep(runId)).toBe('continue');
      expect(await rowOf(runId)).toMatchObject({ currentStep: step + 1, takeovers: 0, attempt: step + 1 });
    }
    expect(await drive(w.worker(), runId)).toBe('done');
    expect(w.toolCalls.map((c) => c.toolId)).toEqual([TOOL_CHARGE, TOOL_EMAIL]);
    expect(w.modelCalls).toHaveLength(3);
    await expectSound(runId);
  });
});
