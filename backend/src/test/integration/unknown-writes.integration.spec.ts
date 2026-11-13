/**
 * Real-Postgres and real-Redis integration spec for a write whose outcome a
 * cut-off attempt lost (durable runs step 4, unknown-writes.ts,
 * docs/design/durable-runs.md "Unknown outcomes"). The step processor runs
 * over the migrated schema; the model, the tool executor and the approvals
 * service are doubled (resume-harness.ts), the decision goes through the
 * runtime's own handler, and personal data is hidden by the product's own
 * PII filter (pii-filter-on.ts).
 *
 * A worker dies inside a call to a tool that writes and takes no
 * idempotency key. The worker that takes the run over tries the call again
 * with backoff, tells the model an earlier attempt may already have
 * happened, and pauses the run for a person. Approved, the run carries on;
 * rejected, the model is told to carry on without the action. A viewer
 * streaming the run's log never sees the email address in the call's
 * arguments, while every attempt still sends the real one.
 *
 * Gated behind `RUN_DB_INTEGRATION=1`, like the other DB specs. Redis is
 * REDIS_HOST / REDIS_PORT.
 */
import Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Organization } from '../../entities/organization.entity';
import { AgentRuntimeEventsHelper } from '../../modules/agents/agent-runtime-events.helper';
import { projectRunEvents, storedRunState } from '../../modules/agents/run-events';
import { runLogView } from '../../modules/agents/run-log-privacy';
import { writeRunStream } from '../../modules/agents/run-stream-writer';
import { piiFilterOn } from '../../modules/agents/__tests__/pii-filter-on';
import { TOOL_NOTIFY, answers, callsTools, never, resumeAgent, resumeRun, resumeWorkers } from '../../modules/agents/__tests__/resume-harness';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'unknown_writes_test';
const EMAIL = 'ana.lopez@example.com';

jest.setTimeout(90_000);

describeIfDb('durable runs step 4: a keyless write whose outcome was lost (real Postgres and Redis)', () => {
  let ds: DataSource;
  let runs: Repository<AgentRun>;
  let events: Repository<AgentRunEvent>;
  let redis: Redis;
  let orgId: string;
  let agentId: string;
  const savedBackoff = process.env.RUN_UNKNOWN_WRITE_BACKOFF_MS;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    // Real waits, kept short: 5 ms, then 10, then 20.
    process.env.RUN_UNKNOWN_WRITE_BACKOFF_MS = '5';
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
      migrationsTransactionMode: 'each',
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
    runs = ds.getRepository(AgentRun);
    events = ds.getRepository(AgentRunEvent);
    redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), maxRetriesPerRequest: 1 });
    await redis.ping();

    const org = await ds.getRepository(Organization).save({ name: 'unknown-writes', slug: `unknown-writes-${Date.now()}`, plan: 'free', isActive: true } as any);
    orgId = org.id;
    const { pipeline, ...agent } = resumeAgent(orgId);
    agentId = (await ds.getRepository(Agent).save({ ...agent, pipeline } as any)).id;
  });

  afterAll(async () => {
    if (savedBackoff === undefined) delete process.env.RUN_UNKNOWN_WRITE_BACKOFF_MS;
    else process.env.RUN_UNKNOWN_WRITE_BACKOFF_MS = savedBackoff;
    const keys = await redis?.keys('run:*:log');
    if (keys?.length) await redis.del(...keys);
    await redis?.quit();
    if (ds?.isInitialized) await ds.destroy();
  });

  const hide = piiFilterOn();
  const notify = { id: 'tc-n', name: 'notify_customer', parameters: { to: EMAIL, text: 'Your refund is on its way' } };
  const ok = (data: any) => ({ success: true, data, executionTime: 3, cached: false, rateLimited: false, retryCount: 0 });
  const unavailable = { success: false, data: null, error: 'Service Unavailable', executionTime: 3, cached: false, rateLimited: false, retryCount: 0, metadata: { httpStatus: 503 } };

  /** A run whose first worker dies inside its call to the keyless write; `after` is what each later call returns. */
  const start = async (replies: any[], after: any[]) => {
    // A run's conversation, as startRun opens one: the model reads the calls' results there.
    const conversation = await ds.getRepository(Conversation).save(Conversation.createConversation({ agentId, organizationId: orgId }));
    const run = await runs.save(runs.create({ ...resumeRun(orgId, agentId), conversationId: conversation.id } as any) as unknown as AgentRun);
    let dead = false;
    const w = await resumeWorkers({
      runs,
      runId: run.id,
      organizationId: orgId,
      agentId,
      replies,
      hidePersonalData: hide,
      executeTool: async () => {
        if (!dead) {
          dead = true;
          return never();
        }
        return after.shift() ?? ok({ done: true });
      },
    });
    const owner = await w.claimDead();
    void (w.worker() as any).processLeasedStep(run.id, owner);
    await until(() => w.toolCalls.length > 0);
    return { runId: run.id, w };
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
  const ofType = (log: AgentRunEvent[], type: string) => log.filter((e) => e.type === type);
  const toolResult = (w: any, id: string) => w.messages.rows().find((m: any) => m.toolCallId === id && m.type === 'tool_result');

  it('killed mid-call on a keyless write: the resume tries it again with backoff, tells the model, and pauses for a person', async () => {
    const { runId, w } = await start([callsTools([notify]), answers('Told her.')], [unavailable, ok({ messageId: 'm-1' })]);
    expect(await drive(w.worker(), runId)).toBe('waiting');

    expect(w.toolCalls.map((c) => c.toolId)).toEqual([TOOL_NOTIFY, TOOL_NOTIFY, TOOL_NOTIFY]);
    expect(w.modelCalls).toHaveLength(1);
    const { log, row } = await expectSound(runId);
    expect(row.status).toBe(AgentRunStatus.WAITING_APPROVAL);
    expect(row.workingMemory.unknownOutcomeCalls).toEqual([
      expect.objectContaining({ toolCallId: 'tc-n', toolId: TOOL_NOTIFY, approvalId: w.approvals.rows[0].id, attempts: [{ attempt: 1, outcome: 'unknown', httpStatus: 503 }, { attempt: 2, outcome: 'succeeded' }] }),
    ]);
    expect(ofType(log, 'tool_attempted').filter((e) => e.payload.phase === 'finished').map((e) => [e.payload.attempt, e.payload.outcome])).toEqual([
      [1, 'unknown'],
      [2, 'succeeded'],
    ]);
    expect(ofType(log, 'approval_requested').some((e) => e.payload.kind === 'unknown_outcome')).toBe(true);
    // The approval shows the call with its personal data hidden, and the attempts.
    const [approval] = w.approvals.rows;
    expect(approval.payload).toMatchObject({ kind: 'unknown_outcome', tool: 'Send the customer a message', parameters: { text: 'Your refund is on its way' } });
    expect(JSON.stringify(approval.payload)).not.toContain(EMAIL);
    expect(approval.payload.attempts.map((a: any) => a.outcome)).toEqual(['unknown', 'succeeded']);
    // The model is told.
    expect(toolResult(w, 'tc-n').content).toContain('may already have gone through');
    expect(toolResult(w, 'tc-n').content).toContain('It was tried again 2 times');
  });

  it('approved: the run carries on to the end, and the call is not made again', async () => {
    const { runId, w } = await start([callsTools([notify]), answers('Told her.')], [ok({ messageId: 'm-1' })]);
    expect(await drive(w.worker(), runId)).toBe('waiting');

    await w.decide(w.approvals.rows[0].id, 'approved');
    expect((await rowOf(runId)).status).toBe(AgentRunStatus.RUNNING);
    expect(await drive(w.worker(), runId)).toBe('done');

    const { log, row } = await expectSound(runId);
    expect(row).toMatchObject({ status: AgentRunStatus.COMPLETED, output: 'Told her.' });
    expect(row.workingMemory.unknownOutcomeCalls).toBeUndefined();
    expect(w.toolCalls).toHaveLength(2);
    expect(w.modelCalls).toHaveLength(2);
    expect(w.modelCalls[1].messages.find((m: any) => m.toolCallId === 'tc-n').content).toContain('A person checked this and approved carrying on.');
    expect(ofType(log, 'approval_decided').map((e) => [e.payload.kind, e.payload.status])).toEqual([['unknown_outcome', 'approved']]);
  });

  it('rejected: the run is not cancelled, and the model is told to carry on without the action', async () => {
    const { runId, w } = await start([callsTools([notify]), answers('I did not message her.')], [unavailable, unavailable, unavailable]);
    expect(await drive(w.worker(), runId)).toBe('waiting');
    expect(w.toolCalls).toHaveLength(4);

    await w.decide(w.approvals.rows[0].id, 'rejected', 'She was already told by phone');
    expect(await drive(w.worker(), runId)).toBe('done');

    const { row } = await expectSound(runId);
    expect(row.status).toBe(AgentRunStatus.COMPLETED);
    expect(w.toolCalls).toHaveLength(4);
    const seen = w.modelCalls[1].messages.find((m: any) => m.toolCallId === 'tc-n').content;
    expect(seen).toContain('rejected it. Treat this action as not done, do not make this call again, and carry on without it.');
    expect(seen).toContain('She was already told by phone');
  });

  it('a streamed run log hides the email address in the arguments, while the resume still sends the real one', async () => {
    const helper = new AgentRuntimeEventsHelper(runs, redis);
    helper.onModuleInit();
    // The view the runtime service sets: the run's organization, the PII filter.
    helper.setRunLogView(
      runLogView(
        (id) => runs.findOne({ where: { id }, select: { id: true, organizationId: true, userId: true } }),
        (data, options) => hide(data, options),
      ),
    );
    try {
      const { runId, w } = await start([callsTools([notify]), answers('Told her.')], [ok({ messageId: 'm-1' })]);
      // A viewer on the run's SSE stream from its first event, as /agents/:id/runs/:runId/stream writes it.
      const chunks: string[] = [];
      const abort = new AbortController();
      const viewing = writeRunStream(helper, runId, { write: (c: string) => chunks.push(c) }, abort.signal, 0);

      expect(await drive(w.worker(), runId)).toBe('waiting');
      await w.decide(w.approvals.rows[0].id, 'approved');
      expect(await drive(w.worker(), runId)).toBe('done');
      await viewing;

      // Every attempt was sent the real address.
      expect(w.toolCalls.map((c) => c.parameters.to)).toEqual([EMAIL, EMAIL]);
      const { log } = await expectSound(runId);
      // The log keeps it where the resume reads it.
      expect(ofType(log, 'model_answered')[0].payload.response.message.toolCalls[0].parameters.to).toBe(EMAIL);
      expect(ofType(log, 'tool_started').map((e) => e.payload.parameters.to)).toEqual([EMAIL, EMAIL]);

      // The viewer saw the whole log, in order, with the address hidden.
      const frames = chunks.filter((c) => c.startsWith('id: '));
      const seen = frames.map((c) => JSON.parse(c.split('data: ')[1]));
      expect(seen.map((e) => e.seq)).toEqual(log.map((e) => e.seq));
      expect(chunks.join('')).not.toContain(EMAIL);
      const started = seen.filter((e) => e.type === 'tool_started');
      expect(started).toHaveLength(2);
      for (const e of started) expect(e.payload).toMatchObject({ tool: 'notify_customer', parameters: { text: 'Your refund is on its way' } });
      expect(started[0].payload.parameters.to).toMatch(/\*+\.com$/);
      const answered = seen.find((e) => e.type === 'model_answered');
      expect(answered.payload.response.message.toolCalls[0]).toMatchObject({ id: 'tc-n', name: 'notify_customer' });
    } finally {
      helper.onModuleDestroy();
    }
  });
});
