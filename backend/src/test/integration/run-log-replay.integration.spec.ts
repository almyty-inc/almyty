/**
 * Real-Postgres and real-Redis integration spec for durable runs step 2:
 * the projection check on every committed write, and a live run view
 * resuming from the event log while writers race it. The unit specs
 * (run-projection-check.spec.ts, run-log-replay.spec.ts) drive the same
 * code over fakes, which have no row lock, no real transaction and no
 * real blocking XREAD; this is where they are real.
 *
 * Gated behind `RUN_DB_INTEGRATION=1`, like the other DB specs. Redis is
 * REDIS_HOST / REDIS_PORT.
 */
import Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentMode, AgentRunStatus } from '../../entities/agent-run.entity';
import { Organization } from '../../entities/organization.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { MetricsRecorderService } from '../../common/metrics/metrics-recorder.service';
import { AgentRuntimeEventsHelper } from '../../modules/agents/agent-runtime-events.helper';
import { mergeMetadata, writeRun } from '../../modules/agents/run-event-writer';
import { RunProjectionCheckService } from '../../modules/agents/run-projection-check';
import { watchRunProjection } from '../fake-run-events';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'run_log_replay_test';

jest.setTimeout(60_000);

describeIfDb('durable runs step 2 (real Postgres and Redis)', () => {
  let ds: DataSource;
  let runs: Repository<AgentRun>;
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
    redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), maxRetriesPerRequest: 1 });
    await redis.ping();

    const org = await ds.getRepository(Organization).save({ name: 'run-log', slug: `run-log-${Date.now()}`, plan: 'free', isActive: true } as any);
    orgId = org.id;
    const agent = await ds.getRepository(Agent).save({ name: 'run-log-agent', organizationId: orgId, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] } } as any);
    agentId = agent.id;
  });

  afterAll(async () => {
    const keys = await redis?.keys('run:*:log');
    if (keys?.length) await redis.del(...keys);
    await redis?.quit();
    if (ds?.isInitialized) await ds.destroy();
  });

  const newRun = async (): Promise<AgentRun> =>
    runs.save(
      runs.create({
        agentId,
        organizationId: orgId,
        mode: AgentMode.AUTONOMOUS,
        status: AgentRunStatus.RUNNING,
        input: { text: 'hello' },
        steps: [],
        currentStep: 0,
        workingMemory: {},
        metadata: {},
      } as Partial<AgentRun>),
    );

  const step = (id: string, i: number) =>
    i % 3 === 0
      ? writeRun(runs, { id }, (row) => ({
          currentStep: row.currentStep + 1,
          steps: [...(row.steps ?? []), { type: 'tool_call', input: { tool: 'crm', i }, output: { ok: i }, duration: 3, timestamp: `t${i}` }] as any,
          workingMemory: { ...(row.workingMemory ?? {}), [`m${i}`]: i },
          totalCost: (row.totalCost ?? 0) + 0.01,
          toolCallCount: (row.toolCallCount ?? 0) + 1,
        }))
      : writeRun(runs, { id }, mergeMetadata({ [`k${i}`]: i }));

  it('the projection check: racing writers, every write checked against the row as Postgres keeps it, no difference', async () => {
    const watch = watchRunProjection();
    try {
      const run = await newRun();
      await Promise.all(Array.from({ length: 30 }, (_, i) => step(run.id, i)));
      await writeRun(runs, { id: run.id }, { status: AgentRunStatus.COMPLETED, output: { answer: 'done' } });
      expect(watch.checker.stats.checks).toBe(31);
      expect(watch.mismatches).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('a write around writeRun: logged and counted in usage_metrics, the write itself committed', async () => {
    const previous = process.env.RUN_PROJECTION_CHECK;
    process.env.RUN_PROJECTION_CHECK = 'true';
    const service = new RunProjectionCheckService(new MetricsRecorderService(ds.getRepository(UsageMetric)));
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    service.onModuleInit();
    try {
      const run = await newRun();
      await writeRun(runs, { id: run.id }, { currentStep: 1 });
      await runs.update({ id: run.id }, { workingMemory: { injected: 'outside the log' } } as any);
      const written = await writeRun(runs, { id: run.id }, { currentStep: 2 });
      expect(written).toBeTruthy();
      expect((await runs.findOneByOrFail({ id: run.id })).currentStep).toBe(2);

      let rows: UsageMetric[] = [];
      for (let i = 0; i < 50 && !rows.length; i++) {
        rows = await ds.getRepository(UsageMetric).find({ where: { type: 'run_projection_mismatch' as any, organizationId: orgId } });
        if (!rows.length) await new Promise((r) => setTimeout(r, 20));
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].dimensions).toEqual({ runId: run.id, seq: written!.headSeq, fields: ['workingMemory'] });
      expect(JSON.stringify(rows[0])).not.toContain('outside the log');
    } finally {
      service.onModuleDestroy();
      if (previous === undefined) delete process.env.RUN_PROJECTION_CHECK;
      else process.env.RUN_PROJECTION_CHECK = previous;
    }
  });

  it('a view resuming from seq N while writers race it: N+1..head in order, each once, then the live writes', async () => {
    const helper = new AgentRuntimeEventsHelper(runs, redis);
    helper.onModuleInit();
    try {
      const run = await newRun();
      for (let i = 0; i < 6; i++) await step(run.id, i);
      const n = 5;

      const seqs: number[] = [];
      const done = helper.subscribeRunLog(run.id, n, (e) => seqs.push(e.seq), () => undefined, undefined, 30_000);
      // Writers race the replay and the handover to the live stream.
      await Promise.all(Array.from({ length: 20 }, (_, i) => step(run.id, i + 6)));
      await writeRun(runs, { id: run.id }, { status: AgentRunStatus.COMPLETED, output: 'done' });
      await done;

      const head = (await runs.findOneByOrFail({ id: run.id })).headSeq;
      expect(seqs).toEqual(Array.from({ length: head - n }, (_, i) => n + 1 + i));
    } finally {
      helper.onModuleDestroy();
    }
  });

  it('a long log is read a page at a time and still arrives whole', async () => {
    const helper = new AgentRuntimeEventsHelper(runs, redis);
    helper.onModuleInit();
    try {
      const run = await newRun();
      for (let i = 0; i < 300; i++) await writeRun(runs, { id: run.id }, mergeMetadata({ tick: i }));
      await writeRun(runs, { id: run.id }, { status: AgentRunStatus.COMPLETED });
      const head = (await runs.findOneByOrFail({ id: run.id })).headSeq;
      expect(head).toBeGreaterThan(500);
      const seqs: number[] = [];
      await helper.subscribeRunLog(run.id, 0, (e) => seqs.push(e.seq), () => undefined, undefined, 30_000);
      expect(seqs).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    } finally {
      helper.onModuleDestroy();
    }
  });
});
