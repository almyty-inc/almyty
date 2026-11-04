/**
 * Real-Postgres integration spec for run leases (durable runs, step 3):
 * claims, takeover of a lapsed lease and fencing, against the migrated
 * schema with the row lock and the SQL TypeORM generates for the lease
 * predicates (Or(IsNull(), LessThan(...))). The unit specs drive the same
 * code over fake repositories, which have no lock; this is where workers
 * really race.
 *
 * Gated behind `RUN_DB_INTEGRATION=1`, like the other DB specs.
 */
import { DataSource, In, Not, Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentMode, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { Organization } from '../../entities/organization.entity';
import { writeRun } from '../../modules/agents/run-event-writer';
import { projectRunEvents, storedRunState } from '../../modules/agents/run-events';
import { claimRun, heldBy, releaseRunLease, renewRunLease } from '../../modules/agents/run-lease';
import { RunWakeSweepService } from '../../modules/agents/run-wake-sweep.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'run_leases_test';

jest.setTimeout(60_000);

describeIfDb('run leases (real Postgres)', () => {
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

    const org = await ds.getRepository(Organization).save({ name: 'run-leases', slug: `run-leases-${Date.now()}`, plan: 'free', isActive: true } as any);
    orgId = org.id;
    const agent = await ds.getRepository(Agent).save({
      name: 'run-leases-agent',
      organizationId: orgId,
      status: AgentStatus.ACTIVE,
      pipeline: { nodes: [], edges: [] },
    } as any);
    agentId = agent.id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const newRun = async (over: Partial<AgentRun> = {}): Promise<AgentRun> =>
    runs.save(
      runs.create({
        agentId,
        organizationId: orgId,
        mode: AgentMode.AUTONOMOUS,
        status: AgentRunStatus.RUNNING,
        input: 'hello',
        steps: [],
        currentStep: 0,
        workingMemory: {},
        metadata: {},
        // Due since a while: claims made with a `now` in the past still find it due.
        nextWakeAt: new Date(Date.now() - 300_000),
        ...over,
      } as Partial<AgentRun>),
    );

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

  it('the migration adds the lease columns and the wake index', async () => {
    const cols = await ds.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'agent_runs' AND column_name IN ('nextWakeAt','leaseOwner','leaseExpiresAt','attempt') ORDER BY column_name`,
      [SCHEMA],
    );
    expect(cols.map((c: any) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['attempt', 'integer', 'NO'],
      ['leaseExpiresAt', 'timestamp with time zone', 'YES'],
      ['leaseOwner', 'character varying', 'YES'],
      ['nextWakeAt', 'timestamp with time zone', 'YES'],
    ]);
    const [index] = await ds.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'IDX_agent_runs_nextWakeAt'`, [SCHEMA]);
    expect(index.indexdef).toContain('WHERE ("nextWakeAt" IS NOT NULL)');
  });

  it('workers racing to claim one run: exactly one holds it, and nothing goes on the log or in updatedAt', async () => {
    const run = await newRun();
    const updatedAt = (await rowOf(run.id)).updatedAt;
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimRun(runs, run.id, { leaseMs: 60_000 })));

    const won = claims.filter((c) => c.claimed);
    expect(won).toHaveLength(1);
    expect(claims.filter((c) => !c.claimed).map((c: any) => c.reason)).toEqual(Array(11).fill('held'));
    const row = await rowOf(run.id);
    expect(row.leaseOwner).toBe((won[0] as any).owner);
    expect(row.headSeq).toBe(0);
    expect(await logOf(run.id)).toEqual([]);
    expect(row.updatedAt.getTime()).toBe(updatedAt.getTime());
  });

  it('a lapsed lease is taken over once, however many workers race for it, and the takeover is on the log', async () => {
    const run = await newRun();
    const dead = await claimRun(runs, run.id, { leaseMs: 60_000, now: new Date(Date.now() - 120_000) });
    expect(dead.claimed).toBe(true);

    const claims = await Promise.all(Array.from({ length: 8 }, () => claimRun(runs, run.id, { leaseMs: 60_000 })));

    const won = claims.filter((c) => c.claimed);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ attempt: 1, takenOver: true });
    const { log, row } = await expectSound(run.id);
    expect(row.attempt).toBe(1);
    expect(row.leaseOwner).toBe((won[0] as any).owner);
    expect(log.filter((e) => e.type === 'lease_taken_over')).toHaveLength(1);
  });

  it('fencing: the worker that lost its lease cannot commit, the one that took it over can', async () => {
    const run = await newRun({ currentStep: 4 });
    const a = await claimRun(runs, run.id, { leaseMs: 60_000, now: new Date(Date.now() - 120_000) });
    const b = await claimRun(runs, run.id, { leaseMs: 60_000 });
    expect(b).toMatchObject({ claimed: true, takenOver: true });

    const guard = (owner: string) => ({
      id: run.id,
      currentStep: 4,
      status: Not(In([AgentRunStatus.COMPLETED, AgentRunStatus.FAILED, AgentRunStatus.CANCELLED, AgentRunStatus.TIMEOUT])),
      ...heldBy({ leaseOwner: owner }),
    });
    const commit = (owner: string, output: string) =>
      writeRun(runs, guard(owner), (row) => ({ currentStep: 5, output, totalCost: (row.totalCost ?? 0) + 1, steps: [...row.steps, { type: 'llm_call', output }] as any }));

    // Both commit at once: the stale one is refused whatever the order.
    const [stale, live] = await Promise.all([commit((a as any).owner, 'from a'), commit((b as any).owner, 'from b')]);
    expect(stale).toBeNull();
    expect(live).not.toBeNull();

    const { log, row } = await expectSound(run.id);
    expect(row.output).toBe('from b');
    expect(row.totalCost).toBe(1);
    expect(JSON.stringify(log)).not.toContain('from a');
    // The renewal of the lost lease fails too, and changes nothing.
    expect(await renewRunLease(runs, run.id, (a as any).owner, 60_000)).toBe(false);
    expect(await releaseRunLease(runs, run.id, (a as any).owner)).toBe(false);
    expect((await rowOf(run.id)).leaseOwner).toBe((b as any).owner);
  });

  it('renewal keeps the lease past its first expiry; release lets the next claim in', async () => {
    const run = await newRun();
    const t0 = new Date(Date.now() - 50_000);
    const a = await claimRun(runs, run.id, { leaseMs: 60_000, now: t0 });
    expect(await renewRunLease(runs, run.id, (a as any).owner, 60_000)).toBe(true);
    // Past the first expiry (t0 + 60s) but within the renewed one.
    expect(await claimRun(runs, run.id, { leaseMs: 60_000, now: new Date(Date.now() + 30_000) })).toEqual({ claimed: false, reason: 'held' });
    expect(await releaseRunLease(runs, run.id, (a as any).owner)).toBe(true);
    expect(await claimRun(runs, run.id, { leaseMs: 60_000 })).toMatchObject({ claimed: true, takenOver: false });
  });

  it('a sleeping run is claimed only at its wake time; a nudge for an old step claims nothing', async () => {
    const run = await newRun({ status: AgentRunStatus.SLEEPING, nextWakeAt: new Date(Date.now() + 60_000), currentStep: 2 });
    expect(await claimRun(runs, run.id, { leaseMs: 60_000 })).toEqual({ claimed: false, reason: 'not_due' });
    expect(await claimRun(runs, run.id, { leaseMs: 60_000, now: new Date(Date.now() + 61_000), step: 1 })).toEqual({ claimed: false, reason: 'moved_on' });
    expect(await claimRun(runs, run.id, { leaseMs: 60_000, now: new Date(Date.now() + 61_000), step: 2 })).toMatchObject({ claimed: true });
  });

  it('a status write sets when the run next needs a worker', async () => {
    const run = await newRun({ nextWakeAt: null });
    await writeRun(runs, { id: run.id }, { status: AgentRunStatus.WAITING_INPUT });
    expect((await rowOf(run.id)).nextWakeAt).toBeNull();
    const before = Date.now();
    await writeRun(runs, { id: run.id, status: AgentRunStatus.WAITING_INPUT }, { status: AgentRunStatus.RUNNING });
    expect((await rowOf(run.id)).nextWakeAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    await writeRun(runs, { id: run.id }, { status: AgentRunStatus.COMPLETED });
    expect((await rowOf(run.id)).nextWakeAt).toBeNull();
    await expectSound(run.id);
  });

  it('the wake sweep finds what is due and nobody holds, in SQL', async () => {
    const queue = { add: jest.fn(async () => ({})) };
    const sweep = new RunWakeSweepService(runs, queue as any);
    const long = new Date(Date.now() - 10 * 60_000);
    const lost = await newRun({ nextWakeAt: long, currentStep: 3 });
    const dead = await newRun({ nextWakeAt: long, leaseOwner: 'gone:1', leaseExpiresAt: new Date(Date.now() - 1000) });
    const held = await newRun({ nextWakeAt: long, leaseOwner: 'live:1', leaseExpiresAt: new Date(Date.now() + 60_000) });
    const fresh = await newRun({ nextWakeAt: new Date() });
    const asking = await newRun({ status: AgentRunStatus.WAITING_INPUT, nextWakeAt: null });
    const done = await newRun({ status: AgentRunStatus.COMPLETED, nextWakeAt: long });

    await sweep.sweep();

    const nudged = (queue.add as jest.Mock).mock.calls.map(([, data]) => data.runId);
    expect(nudged).toEqual(expect.arrayContaining([lost.id, dead.id]));
    for (const id of [held.id, fresh.id, asking.id, done.id]) expect(nudged).not.toContain(id);
    const lostCall = (queue.add as jest.Mock).mock.calls.find(([, data]) => data.runId === lost.id)!;
    expect(lostCall[1].step).toBe(3);
  });

  it('the takeover cap: the third takeover of one step fails the run, once, on the log; a commit resets the count', async () => {
    const [col] = await ds.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'agent_runs' AND column_name = 'takeovers'`,
      [SCHEMA],
    );
    expect([col.data_type, col.is_nullable, col.column_default]).toEqual(['integer', 'NO', '0']);

    const base = Date.now() - 600_000;
    const run = await newRun({ currentStep: 1, nextWakeAt: new Date(base - 1000) });
    const at = (i: number) => new Date(base + i * 61_000);
    const claim = (i: number) => claimRun(runs, run.id, { leaseMs: 60_000, now: at(i), maxTakeovers: 3 });

    // Taken over twice: the step starts over each time.
    await claim(0);
    expect(await claim(1)).toMatchObject({ claimed: true, takenOver: true, attempt: 1 });
    const second = await claim(2);
    expect(second).toMatchObject({ claimed: true, takenOver: true, attempt: 2 });
    expect((await rowOf(run.id)).takeovers).toBe(2);

    // The worker holding it commits the step and lets the lease go: the count starts again.
    const committed = await writeRun(
      runs,
      { id: run.id, currentStep: 1, ...heldBy({ leaseOwner: (second as any).owner }) },
      { currentStep: 2, output: 'step 1', takeovers: 0 },
    );
    expect(committed).not.toBeNull();
    expect(await releaseRunLease(runs, run.id, (second as any).owner)).toBe(true);
    expect((await rowOf(run.id)).takeovers).toBe(0);

    // Step 2: claimed free, then taken over twice and started over each time.
    expect(await claim(3)).toMatchObject({ claimed: true, takenOver: false });
    expect(await claim(4)).toMatchObject({ claimed: true, takenOver: true, attempt: 3 });
    expect(await claim(5)).toMatchObject({ claimed: true, takenOver: true, attempt: 4 });

    // The third takeover of step 2, with workers racing for it: one write fails the run, the rest find it done.
    const raced = await Promise.all(Array.from({ length: 6 }, () => claim(6)));
    const error = 'This step stopped its worker 3 times in a row, so the run was stopped.';
    expect(raced.filter((c: any) => c.reason === 'stopped')).toEqual([{ claimed: false, reason: 'stopped', error, attempt: 5 }]);
    expect(raced.filter((c) => c.claimed)).toEqual([]);
    expect(raced.filter((c: any) => c.reason !== 'stopped').map((c: any) => c.reason)).toEqual(Array(5).fill('done'));

    const { log, row } = await expectSound(run.id);
    expect(row).toMatchObject({ status: AgentRunStatus.FAILED, error, leaseOwner: null, leaseExpiresAt: null, nextWakeAt: null, attempt: 5, takeovers: 3 });
    expect(log.filter((e) => e.type === 'lease_taken_over').map((e) => e.payload.attempt)).toEqual([1, 2, 3, 4, 5]);
    const failed = log.filter((e) => e.type === 'run_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toEqual({ error });
    expect(await claimRun(runs, run.id, { leaseMs: 60_000 })).toEqual({ claimed: false, reason: 'done' });
  });
});
