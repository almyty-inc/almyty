/**
 * Real-Postgres integration spec for the run event log (durable runs,
 * step 1): `writeRun` against the migrated schema, with the row lock,
 * the (runId, seq) primary key and the json columns as Postgres keeps
 * them. The unit specs drive the same code over fake repositories, which
 * have no lock and no concurrency; this is where writers really race.
 *
 * Gated behind `RUN_DB_INTEGRATION=1`, like the other DB specs.
 */
import { DataSource, In, Not, Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentMode, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { Organization } from '../../entities/organization.entity';
import { mergeMetadata, writeRun } from '../../modules/agents/run-event-writer';
import { projectRunEvents, storedRunState } from '../../modules/agents/run-events';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'run_events_test';

jest.setTimeout(60_000);

describeIfDb('run event log (real Postgres)', () => {
  let ds: DataSource;
  let runs: Repository<AgentRun>;
  let events: Repository<AgentRunEvent>;
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

    const org = await ds.getRepository(Organization).save({ name: 'run-events', slug: `run-events-${Date.now()}`, plan: 'free', isActive: true } as any);
    orgId = org.id;
    const agent = await ds.getRepository(Agent).save({
      name: 'run-events-agent',
      organizationId: orgId,
      status: AgentStatus.ACTIVE,
      pipeline: { nodes: [], edges: [] },
    } as any);
    agentId = agent.id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const newRun = async (over: Partial<AgentRun> = {}): Promise<AgentRun> => {
    const run = runs.create({
      agentId,
      organizationId: orgId,
      mode: AgentMode.AUTONOMOUS,
      status: AgentRunStatus.RUNNING,
      input: 'hello',
      steps: [],
      currentStep: 0,
      workingMemory: {},
      metadata: {},
      ...over,
    } as Partial<AgentRun>);
    return runs.save(run);
  };

  const logOf = (runId: string) => events.find({ where: { runId }, order: { seq: 'ASC' } });

  /** Contiguous from 1, headSeq is the last seq, and the log folds into the row as stored. */
  const expectSound = async (runId: string) => {
    const log = await logOf(runId);
    const row = (await runs.findOne({ where: { id: runId } }))!;
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(row.headSeq).toBe(log.length);
    const { headSeq, ...state } = projectRunEvents(log);
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
    return { log, row };
  };

  it('a new run has headSeq 0 and no events', async () => {
    const run = await newRun();
    expect(run.headSeq).toBe(0);
    expect(await logOf(run.id)).toEqual([]);
  });

  it('writers racing on one run: every write lands, seq has no gap or repeat, and the log folds into the row', async () => {
    const run = await newRun();
    const writers = 24;
    await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        i % 3 === 0
          ? writeRun(runs, { id: run.id }, (row) => ({
              steps: [...(row.steps ?? []), { type: 'llm_call', output: `step ${i}`, timestamp: `t${i}` }],
              totalCost: (row.totalCost ?? 0) + 1,
            }))
          : writeRun(runs, { id: run.id }, mergeMetadata({ [`k${i}`]: i })),
      ),
    );

    const { log, row } = await expectSound(run.id);
    // No lost update: every merge and every appended step is in the row.
    expect(Object.keys(row.metadata).sort()).toEqual(
      Array.from({ length: writers }, (_, i) => i).filter((i) => i % 3 !== 0).map((i) => `k${i}`).sort(),
    );
    expect(row.steps).toHaveLength(writers / 3);
    expect(row.totalCost).toBe(writers / 3);
    expect(log.filter((e) => e.type === 'step_committed')).toHaveLength(writers);
    expect(log.filter((e) => e.type === 'run_started')).toHaveLength(1);
  });

  it('two commits of the same step: exactly one lands, and the loser appends nothing', async () => {
    const run = await newRun({ currentStep: 3 });
    const guard = { id: run.id, currentStep: 3, status: Not(In([AgentRunStatus.COMPLETED, AgentRunStatus.FAILED, AgentRunStatus.CANCELLED, AgentRunStatus.TIMEOUT])) };
    const results = await Promise.all([
      writeRun(runs, guard, { currentStep: 4, steps: [{ type: 'llm_call', output: 'a', timestamp: 'ta' }] as any }),
      writeRun(runs, guard, { currentStep: 4, steps: [{ type: 'llm_call', output: 'b', timestamp: 'tb' }] as any }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const { log } = await expectSound(run.id);
    expect(log.filter((e) => e.type === 'step_committed')).toHaveLength(1);
  });

  it('a compaction is written by the commit of its step, before that step_committed', async () => {
    const run = await newRun();
    await writeRun(
      runs,
      { id: run.id },
      { currentStep: 1, workingMemory: { contextSummary: { text: 's', coveredCount: 2, foldedTotal: 2 } } },
      [{ type: 'compaction', step: null, payload: { folded: 2, foldedTotal: 2, cost: 0, tokens: 0 } }],
    );
    const { log } = await expectSound(run.id);
    const compaction = log.find((e) => e.type === 'compaction')!;
    const committed = log.find((e) => e.type === 'step_committed')!;
    expect(compaction.payload).toMatchObject({ folded: 2, foldedTotal: 2 });
    expect(compaction.seq).toBeLessThan(committed.seq);
    expect(compaction.step).toBe(committed.step);
  });

  it('a seq already taken is refused by the primary key and the write rolls back whole', async () => {
    const run = await newRun();
    // Written around the writer: an event at seq 1 with the head left at 0.
    await events.insert({ runId: run.id, seq: 1, type: 'run_started', step: 0, payload: {} });
    await expect(writeRun(runs, { id: run.id }, { status: AgentRunStatus.CANCELLED })).rejects.toThrow();
    const row = (await runs.findOne({ where: { id: run.id } }))!;
    expect(row.status).toBe(AgentRunStatus.RUNNING);
    expect(row.headSeq).toBe(0);
    expect(await logOf(run.id)).toHaveLength(1);
  });

  it('deleting a run deletes its events', async () => {
    const run = await newRun();
    await writeRun(runs, { id: run.id }, { status: AgentRunStatus.CANCELLED });
    expect((await logOf(run.id)).length).toBeGreaterThan(0);
    await runs.delete({ id: run.id });
    expect(await logOf(run.id)).toEqual([]);
  });
});
