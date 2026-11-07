import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { MessageType } from '../../../entities/message.entity';
import { expectRunProjectionsHold, runsWithEvents } from '../../../test/fake-run-events';
import { projectRunEvents, storedRunState } from '../run-events';
import {
  attemptOutcomeOf,
  backoffBefore,
  decisionForModel,
  needsCareOnResume,
  reattempt,
  tellModel,
  unknownWriteSettings,
} from '../unknown-writes';
import { piiFilterOn } from './pii-filter-on';
import { TOOL_CHARGE, TOOL_LOOKUP, TOOL_NOTIFY, answers, callsTools, never, resumeAgent, resumeRun, resumeWorkers } from './resume-harness';

/**
 * A write whose outcome a cut-off attempt lost, on a tool that takes no
 * idempotency key (unknown-writes.ts, docs/design/durable-runs.md "Unknown
 * outcomes"): it is tried again with backoff until an attempt has a
 * definite outcome, each attempt on the log; the model is told plainly that
 * an earlier attempt may already have happened, and what each attempt came
 * to; and the run waits for a person. Approved, it carries on; rejected, the
 * model is told to carry on without the action.
 */
const RUN = 'run-1';
const ORG = 'org-1';
const AGENT = 'agent-1';
const EMAIL = 'ana.lopez@example.com';

const ok = (data: any) => ({ success: true, data, executionTime: 3, cached: false, rateLimited: false, retryCount: 0 });
const http = (status: number, error = `HTTP ${status}`) => ({
  success: false,
  data: null,
  error,
  executionTime: 3,
  cached: false,
  rateLimited: false,
  retryCount: 0,
  metadata: { httpStatus: status },
});

describe('unknown-writes: settings, outcomes and the retry loop', () => {
  it('reads RUN_UNKNOWN_WRITE_RETRIES (3) and RUN_UNKNOWN_WRITE_BACKOFF_MS (1000), doubling', () => {
    expect(unknownWriteSettings({})).toEqual({ retries: 3, backoffMs: 1000 });
    expect(unknownWriteSettings({ RUN_UNKNOWN_WRITE_RETRIES: '5', RUN_UNKNOWN_WRITE_BACKOFF_MS: '250' })).toEqual({ retries: 5, backoffMs: 250 });
    // 0 tries nothing again (the person still decides); nonsense keeps the default.
    expect(unknownWriteSettings({ RUN_UNKNOWN_WRITE_RETRIES: '0' }).retries).toBe(0);
    expect(unknownWriteSettings({ RUN_UNKNOWN_WRITE_RETRIES: '-1', RUN_UNKNOWN_WRITE_BACKOFF_MS: 'soon' })).toEqual({ retries: 3, backoffMs: 1000 });
    expect([1, 2, 3].map((n) => backoffBefore(n, { retries: 3, backoffMs: 1000 }))).toEqual([1000, 2000, 4000]);
  });

  it('tells a definite outcome from none', () => {
    expect(attemptOutcomeOf(ok({ id: 1 }) as any)).toBe('succeeded');
    expect(attemptOutcomeOf(http(409) as any)).toBe('failed');
    expect(attemptOutcomeOf(http(422) as any)).toBe('failed');
    for (const status of [500, 503, 408, 429]) expect(attemptOutcomeOf(http(status) as any)).toBe('unknown');
    expect(attemptOutcomeOf({ success: false, error: 'socket hang up' } as any)).toBe('unknown');
    expect(attemptOutcomeOf({ success: false, notFound: true } as any)).toBe('not_run');
    expect(attemptOutcomeOf(null)).toBe('unknown');
  });

  it('a write or delete with no key needs care; a read, or a tool that takes a key, does not', () => {
    expect(needsCareOnResume({ httpConfig: { method: 'POST', headers: {} } })).toBe(true);
    expect(needsCareOnResume({ httpConfig: { method: 'DELETE' } })).toBe(true);
    expect(needsCareOnResume({ httpConfig: { method: 'GET' } })).toBe(false);
    expect(needsCareOnResume({ httpConfig: { method: 'POST', headers: { 'Idempotency-Key': '' } } })).toBe(false);
    expect(needsCareOnResume({ operation: { method: 'POST', parameters: { header: { 'x-idempotency-key': {} } } } } as any)).toBe(false);
    // The class stored on the tool wins over its method.
    expect(needsCareOnResume({ sideEffect: 'read', httpConfig: { method: 'POST' } })).toBe(false);
  });

  it('stops at the first attempt with a definite outcome, waiting twice as long before each, recording each', async () => {
    const results = [http(503), { success: false, error: 'timeout' }, ok({ sent: true })];
    const pauses: number[] = [];
    const recorded: any[] = [];
    const begun: number[] = [];
    const out = await reattempt({
      settings: { retries: 3, backoffMs: 1000 },
      before: [],
      call: async () => results.shift() as any,
      begin: async (n) => (begun.push(n), true),
      record: async (a) => (recorded.push({ ...a }), true),
      pause: async (ms) => void pauses.push(ms),
    });
    expect(pauses).toEqual([1000, 2000, 4000]);
    expect(out.attempts.map((a) => [a.attempt, a.outcome])).toEqual([
      [1, 'unknown'],
      [2, 'unknown'],
      [3, 'succeeded'],
    ]);
    expect(begun).toEqual([1, 2, 3]);
    expect(recorded.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(out.last?.data).toEqual({ sent: true });

    const once = await reattempt({ settings: { retries: 3, backoffMs: 10 }, before: [], call: async () => http(409) as any, begin: async () => true, record: async () => true, pause: async () => undefined });
    expect(once.attempts.map((a) => a.outcome)).toEqual(['failed']);
  });

  it('carries on from attempts an earlier round recorded, and makes none after a definite one', async () => {
    const calls: number[] = [];
    const pauses: number[] = [];
    const out = await reattempt({
      settings: { retries: 3, backoffMs: 1000 },
      before: [{ attempt: 1, outcome: 'unknown' }],
      call: async () => (calls.push(1), http(500) as any),
      begin: async () => true,
      record: async () => true,
      pause: async (ms) => void pauses.push(ms),
    });
    expect(out.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(pauses).toEqual([2000, 4000]);

    const none = await reattempt({
      settings: { retries: 3, backoffMs: 1 },
      before: [{ attempt: 1, outcome: 'succeeded' }],
      call: async () => (calls.push(2), ok(1) as any),
      begin: async () => true,
      record: async () => true,
      pause: async () => undefined,
    });
    expect(none.attempts).toHaveLength(1);
    expect(calls).not.toContain(2);
  });

  it('a refused log write stops the round', async () => {
    let made = 0;
    const out = await reattempt({ settings: { retries: 3, backoffMs: 0 }, before: [], call: async () => (made++, http(503) as any), begin: async () => true, record: async () => false, pause: async () => undefined });
    expect(out.refused).toBe(true);
    expect(made).toBe(1);
  });

  it('tells the model plainly, with every attempt and its result', () => {
    const told = tellModel('notify_customer', [{ attempt: 1, outcome: 'unknown', httpStatus: 503, error: 'HTTP 503' }, { attempt: 2, outcome: 'succeeded' }], ok({ messageId: 'm-9' }) as any);
    expect(told).toContain('an earlier attempt at this notify_customer call may already have gone through');
    expect(told).toContain('It was tried again 2 times: attempt 1 got no clear answer (HTTP 503: HTTP 503); attempt 2 succeeded.');
    expect(told).toContain('{"messageId":"m-9"}');
    expect(tellModel('x', [], null)).toContain('It was not tried again.');
    expect(decisionForModel('rejected', null, 'already sent')).toBe(
      'A person checked this and rejected it. Treat this action as not done, do not make this call again, and carry on without it. Their note: already sent',
    );
  });
});

describe('unknown-writes: a keyless write cut off mid-call, resumed', () => {
  expectRunProjectionsHold();

  const notify = { id: 'tc-n', name: 'notify_customer', parameters: { to: EMAIL, text: 'Your refund is on its way' } };
  const lookup = { id: 'tc-l', name: 'look_up_order', parameters: { email: EMAIL } };
  const charge = { id: 'tc-c', name: 'charge_card', parameters: { amount: 40 } };

  const seeded = () => runsWithEvents([{ id: RUN, ...resumeRun(ORG, AGENT), agent: { id: AGENT, ...resumeAgent(ORG) } } as any]);

  /** A run whose first worker dies inside its first call; `after` is what each later call returns. */
  const setup = async (replies: any[], after: any[]) => {
    const runs = seeded();
    let dead = false;
    const w = await resumeWorkers({
      runs: runs as any,
      runId: RUN,
      organizationId: ORG,
      agentId: AGENT,
      replies,
      hidePersonalData: piiFilterOn(),
      executeTool: async () => {
        if (!dead) {
          dead = true;
          return never();
        }
        return after.length ? after.shift() : ok({ done: true });
      },
    });
    const owner = await w.claimDead();
    void (w.worker() as any).processLeasedStep(RUN, owner);
    await until(() => w.toolCalls.length > 0);
    return { runs, w };
  };

  const until = async (reached: () => boolean) => {
    for (let i = 0; i < 2000 && !reached(); i++) await new Promise((r) => setImmediate(r));
    if (!reached()) throw new Error('the worker never got there');
  };
  const drive = async (worker: { processStep(id: string): Promise<string> }) => {
    let out: string;
    do {
      out = await worker.processStep(RUN);
    } while (out === 'continue');
    return out;
  };
  const resumeWith = (w: Awaited<ReturnType<typeof setup>>['w']) => {
    const worker = w.worker();
    const pause = jest.spyOn(worker as any, 'pause').mockResolvedValue(undefined);
    return { worker, pause };
  };
  const ofType = (log: any[], type: string) => log.filter((e) => e.type === type);
  const expectSound = (runs: ReturnType<typeof seeded>) => {
    const log = runs.events.rows(RUN);
    const { headSeq, ...state } = projectRunEvents(log);
    expect(headSeq).toBe(runs.row(RUN)!.headSeq);
    expect(state).toEqual(storedRunState(runs.row(RUN)!));
    return log;
  };
  const toolResultOf = (w: any, toolCallId: string) => w.messages.rows().find((m: any) => m.type === MessageType.TOOL_RESULT && m.toolCallId === toolCallId);

  it('is tried again with backoff until an attempt is definite, the model is told, and the run waits for a person', async () => {
    const { runs, w } = await setup([callsTools([notify]), answers('Told her.')], [http(503, 'Service Unavailable'), ok({ messageId: 'm-1' })]);
    const { worker, pause } = resumeWith(w);
    expect(await drive(worker)).toBe('waiting');

    // The cut-off call, then two more: the first got no clear answer, the second succeeded.
    expect(w.toolCalls.map((c) => c.toolId)).toEqual([TOOL_NOTIFY, TOOL_NOTIFY, TOOL_NOTIFY]);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    expect(w.modelCalls).toHaveLength(1);

    const row = runs.row(RUN)! as AgentRun;
    expect(row.status).toBe(AgentRunStatus.WAITING_APPROVAL);
    const waiting = row.workingMemory.unknownOutcomeCalls;
    expect(waiting).toEqual([
      {
        toolCallId: 'tc-n',
        toolId: TOOL_NOTIFY,
        toolName: 'notify_customer',
        approvalId: w.approvals.rows[0].id,
        attempts: [
          { attempt: 1, outcome: 'unknown', httpStatus: 503 },
          { attempt: 2, outcome: 'succeeded' },
        ],
      },
    ]);
    // Working memory carries no arguments.
    expect(JSON.stringify(row.workingMemory)).not.toContain(EMAIL);

    // The approval: the call, its arguments with personal data hidden, the attempts.
    const [approval] = w.approvals.rows;
    expect(approval).toMatchObject({ runId: RUN, toolCallId: 'tc-n', toolId: TOOL_NOTIFY, payload: { kind: 'unknown_outcome' } });
    expect(approval.payload.parameters.text).toBe('Your refund is on its way');
    expect(approval.payload.parameters.to).not.toContain('ana.lopez');
    expect(approval.payload.attempts.map((a: any) => a.outcome)).toEqual(['unknown', 'succeeded']);
    expect(approval.reason).toContain('It was tried again 2 times');

    // The model is told, in the call's result.
    const told = toolResultOf(w, 'tc-n');
    expect(told.content).toContain('may already have gone through');
    expect(told.content).toContain('attempt 1 got no clear answer (HTTP 503: Service Unavailable); attempt 2 succeeded');

    // Each attempt is on the log; the call as started keeps its real arguments.
    const log = expectSound(runs);
    expect(ofType(log, 'tool_attempted').map((e) => [e.payload.phase, e.payload.attempt, e.payload.outcome ?? null, e.payload.key])).toEqual([
      ['started', 1, null, `${RUN}:0:0`],
      ['finished', 1, 'unknown', `${RUN}:0:0`],
      ['started', 2, null, `${RUN}:0:0`],
      ['finished', 2, 'succeeded', `${RUN}:0:0`],
    ]);
    expect(ofType(log, 'tool_started').map((e) => e.payload.parameters.to)).toEqual([EMAIL, EMAIL]);
    expect(ofType(log, 'approval_requested').filter((e) => e.payload.kind === 'unknown_outcome').map((e) => e.payload)).toEqual([
      { approvalId: approval.id, kind: 'unknown_outcome', tool: 'notify_customer', toolCallId: 'tc-n' },
    ]);
    // No live runtime event carries the arguments.
    expect(JSON.stringify(w.events)).not.toContain(EMAIL);
  });

  it('approved: the run carries on, the model reads the decision, and the call is not made again', async () => {
    const { runs, w } = await setup([callsTools([notify]), answers('Told her.')], [ok({ messageId: 'm-1' })]);
    expect(await drive(resumeWith(w).worker)).toBe('waiting');
    expect(w.toolCalls).toHaveLength(2);

    await w.decide(w.approvals.rows[0].id, 'approved');
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.RUNNING);
    expect(await drive(w.worker())).toBe('done');

    const row = runs.row(RUN)!;
    expect(row.status).toBe(AgentRunStatus.COMPLETED);
    expect(row.output).toBe('Told her.');
    expect(row.workingMemory.unknownOutcomeCalls).toBeUndefined();
    expect(w.toolCalls).toHaveLength(2);
    expect(w.modelCalls).toHaveLength(2);
    const seen = w.modelCalls[1].messages.find((m: any) => m.toolCallId === 'tc-n');
    expect(seen.content).toContain('may already have gone through');
    expect(seen.content).toContain('A person checked this and approved carrying on.');
    const log = expectSound(runs);
    expect(ofType(log, 'approval_decided').map((e) => [e.payload.kind, e.payload.status])).toEqual([['unknown_outcome', 'approved']]);
    expect(ofType(log, 'approval_resolved')).toHaveLength(1);
  });

  it('rejected: the run is not cancelled; the model is told to carry on without the action', async () => {
    const { runs, w } = await setup([callsTools([notify]), answers('I did not message her.')], [http(500), http(500), http(500)]);
    const { worker, pause } = resumeWith(w);
    expect(await drive(worker)).toBe('waiting');
    // Never a definite answer: every retry spent.
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
    expect(w.approvals.rows[0].payload.attempts.map((a: any) => a.outcome)).toEqual(['unknown', 'unknown', 'unknown']);

    await w.decide(w.approvals.rows[0].id, 'rejected', 'She was already told by phone');
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.RUNNING);
    expect(await drive(w.worker())).toBe('done');

    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.COMPLETED);
    expect(w.toolCalls).toHaveLength(4);
    const seen = w.modelCalls[1].messages.find((m: any) => m.toolCallId === 'tc-n');
    expect(seen.content).toContain('rejected it. Treat this action as not done, do not make this call again, and carry on without it.');
    expect(seen.content).toContain('She was already told by phone');
    expectSound(runs);
  });

  it('RUN_UNKNOWN_WRITE_RETRIES sets how many times it is tried again', async () => {
    const saved = process.env.RUN_UNKNOWN_WRITE_RETRIES;
    process.env.RUN_UNKNOWN_WRITE_RETRIES = '1';
    try {
      const { w } = await setup([callsTools([notify])], [http(502), http(502)]);
      expect(await drive(resumeWith(w).worker)).toBe('waiting');
      expect(w.toolCalls).toHaveLength(2);
      expect(w.approvals.rows[0].payload.attempts).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.RUN_UNKNOWN_WRITE_RETRIES;
      else process.env.RUN_UNKNOWN_WRITE_RETRIES = saved;
    }
  });

  it('a worker that dies again during the retries: the next carries on from the attempts on the log', async () => {
    const runs = seeded();
    const script: Array<'die' | any> = ['die', http(503), 'die', ok({ messageId: 'm-2' })];
    const w = await resumeWorkers({
      runs: runs as any,
      runId: RUN,
      organizationId: ORG,
      agentId: AGENT,
      replies: [callsTools([notify])],
      executeTool: async () => {
        const next = script.shift();
        return next === 'die' ? never() : next;
      },
    });
    const first = await w.claimDead();
    void (w.worker() as any).processLeasedStep(RUN, first);
    await until(() => w.toolCalls.length === 1);
    // The second worker tries once (no clear answer), then dies in its second try.
    const second = await w.claimDead();
    const b = w.worker();
    jest.spyOn(b as any, 'pause').mockResolvedValue(undefined);
    void (b as any).processLeasedStep(RUN, second);
    await until(() => w.toolCalls.length === 3);

    const { worker, pause } = resumeWith(w);
    expect(await drive(worker)).toBe('waiting');
    // Attempt 2 was cut off too: counted, and the next one is attempt 3.
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([4000]);
    expect(w.approvals.rows[0].payload.attempts.map((a: any) => [a.attempt, a.outcome, !!a.cutOff])).toEqual([
      [1, 'unknown', false],
      [2, 'unknown', true],
      [3, 'succeeded', false],
    ]);
    expect(w.approvals.rows[0].reason).toContain('attempt 2 was cut off too, with no answer');
  });

  it('a read cut off mid-call is made again, as before: no retries, no person', async () => {
    const { runs, w } = await setup([callsTools([lookup]), answers('Found it.')], [ok({ order: 7 })]);
    const { worker, pause } = resumeWith(w);
    expect(await drive(worker)).toBe('done');
    expect(w.toolCalls.map((c) => c.toolId)).toEqual([TOOL_LOOKUP, TOOL_LOOKUP]);
    expect(pause).not.toHaveBeenCalled();
    expect(w.approvals.rows).toEqual([]);
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.COMPLETED);
  });

  it('a write that takes a key, cut off mid-call, goes out again with its key, as before', async () => {
    const { runs, w } = await setup([callsTools([charge]), answers('Charged.')], [ok({ charged: 40 })]);
    expect(await drive(resumeWith(w).worker)).toBe('done');
    expect(w.toolCalls.map((c) => [c.toolId, c.options.idempotencyKey])).toEqual([
      [TOOL_CHARGE, `${RUN}:0:0`],
      [TOOL_CHARGE, `${RUN}:0:0`],
    ]);
    expect(w.approvals.rows).toEqual([]);
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.COMPLETED);
  });
});
