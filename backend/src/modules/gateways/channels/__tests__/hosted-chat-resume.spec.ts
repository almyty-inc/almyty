import { BadRequestException } from '@nestjs/common';

import { HostedChatController } from '../hosted-chat.controller';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { AgentRuntimeEventsHelper } from '../../../agents/agent-runtime-events.helper';
import { fakeRedisStreams } from '../../../../test/fake-redis-streams';

/**
 * A visitor who loses the connection mid-answer and reconnects gets the
 * reply text they missed and then the live stream: nothing left out,
 * nothing twice, and never anything of the agent's working.
 *
 * The run's events go through the real Redis-stream reader
 * (AgentRuntimeEventsHelper) over an in-memory stream, so the positions
 * the frames carry are the ones a real stream hands out. The real-Redis
 * and real-Postgres version is visitor-resume.integration.spec.ts.
 */
describe('hosted chat: a visitor resumes a reply', () => {
  const RUN = 'run-1';
  let redis: ReturnType<typeof fakeRedisStreams>;
  let helper: AgentRuntimeEventsHelper;
  let runStatus: string;
  let owner: string;
  let beforeSubscribe: (() => Promise<void>) | null;
  let controller: HostedChatController;

  const gateway = () =>
    Object.assign(new Gateway(), {
      id: 'gw-1',
      type: GatewayType.HOSTED_CHAT,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      agentId: 'agent-1',
      configuration: { hostedChat: { slug: 'acme' } },
    });

  beforeEach(() => {
    redis = fakeRedisStreams();
    helper = new AgentRuntimeEventsHelper({} as any, redis);
    runStatus = 'running';
    owner = 'eu-1';
    beforeSubscribe = null;
    const hostedChat = {
      findBySlug: jest.fn(async () => gateway()),
      // The cookie is the visitor: `sid-<id>` stands for theirs.
      findEndUser: jest.fn(async (_gw: Gateway, session?: string) => (session ? { id: session.replace('sid-', '') } : null)),
      requiresAuth: () => false,
      runBelongsToEndUser: jest.fn(async (_runId: string, endUser: { id: string }) => endUser.id === owner),
    };
    const runtime = {
      getRun: jest.fn(async (runId: string) => ({ id: runId, status: runStatus, agent: { agentConfig: {} } })),
      subscribeRunEvents: jest.fn(async (runId: string, handler: any, signal?: AbortSignal) => {
        if (beforeSubscribe) await beforeSubscribe();
        return helper.subscribeRunEvents(runId, handler, signal, 3_000);
      }),
    };
    const limits = { checkVisitorStream: jest.fn(async () => ({ limited: false })) };
    controller = new HostedChatController(hostedChat as any, limits as any, runtime as any);
  });

  const emit = (type: string, data: any) => helper.emitEvent(RUN, type, data);

  /** One connection of the visitor's browser. */
  const connect = (opts: { lastEventId?: string; after?: string; visitor?: string } = {}) => {
    const chunks: string[] = [];
    let onClose: (() => void) | undefined;
    const res: any = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => chunks.push(chunk)),
      end: jest.fn(),
    };
    const req: any = {
      headers: opts.lastEventId ? { 'last-event-id': opts.lastEventId } : {},
      cookies: { almyty_chat_session: `sid-${opts.visitor ?? 'eu-1'}` },
      ip: '203.0.113.9',
      on: (event: string, fn: () => void) => {
        if (event === 'close') onClose = fn;
      },
    };
    const ended = controller.stream('acme', RUN, req, res, opts.after);
    const frames = () =>
      chunks
        .join('')
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const f: { id?: string; event?: string; data?: any } = {};
          for (const line of block.split('\n')) {
            const at = line.indexOf(': ');
            const [k, v] = [line.slice(0, at), line.slice(at + 2)];
            if (k === 'id') f.id = v;
            if (k === 'event') f.event = v;
            if (k === 'data') f.data = JSON.parse(v);
          }
          return f;
        });
    const text = () =>
      frames().reduce((acc, f) => (f.event === 'reset' ? '' : f.event === 'token' ? acc + f.data.content : acc), '');
    return {
      ended,
      chunks,
      frames,
      text,
      raw: () => chunks.join(''),
      lastId: () => frames().filter((f) => f.id).pop()?.id,
      /** The browser lost the connection. */
      drop: () => onClose?.(),
    };
  };

  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 300; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** The visitor's screen across connections: each reset clears the reply, each token adds to it. */
  const screen = (...connections: Array<ReturnType<typeof connect>>) =>
    connections
      .flatMap((c) => c.frames())
      .reduce((acc, f) => (f.event === 'reset' ? '' : f.event === 'token' ? acc + f.data.content : acc), '');

  it('every reply frame carries an id: where its event is on the run stream, and which of its frames', async () => {
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'Hello' });
    emit('run.completed', { output: 'Hello' });
    const first = connect();
    await first.ended;
    const token = first.frames().find((f) => f.event === 'token')!;
    expect(token.id).toMatch(/^\d+-\d+\.0$/);
    expect(first.frames().pop()).toMatchObject({ event: 'done', data: { reason: 'run.completed' } });
  });

  it('reconnecting mid-answer: exactly the text missed, then live, with a write racing the reconnect', async () => {
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'Your ' });
    emit('llm.chunk', { step: 0, content: 'order ' });
    const first = connect();
    await until(() => first.text() === 'Your order ', 'the first two tokens');
    first.drop();
    await first.ended.catch(() => undefined);

    // Written while the visitor was away.
    emit('llm.chunk', { step: 0, content: 'ships ' });
    // Written while the reconnect is being admitted, before its read starts.
    beforeSubscribe = async () => {
      emit('llm.chunk', { step: 0, content: 'Mon' });
    };
    const second = connect({ lastEventId: first.lastId() });
    await until(() => second.text().endsWith('Mon'), 'the racing write');
    emit('llm.chunk', { step: 0, content: 'day.' });
    emit('llm.response', { step: 0, content: 'Your order ships Monday.' });
    emit('run.completed', { output: 'Your order ships Monday.' });
    await second.ended;

    expect(second.text()).toBe('ships Monday.');
    expect(first.text() + second.text()).toBe('Your order ships Monday.');
    expect(second.frames().pop()).toMatchObject({ event: 'done', data: { reason: 'run.completed' } });
  });

  it('?after= resumes the same way, and a position between two frames of one event sends the second', async () => {
    // Held until the provider says the step is text, then let out as
    // three frames from that one event.
    emit('llm.chunk', { step: 0, content: 'Your ' });
    emit('llm.chunk', { step: 0, content: 'order ' });
    emit('llm.chunk', { step: 0, content: 'ships ' });
    emit('llm.step_kind', { step: 0, kind: 'text' });
    emit('llm.chunk', { step: 0, content: 'Monday.' });
    emit('run.completed', { output: 'Your order ships Monday.' });
    const whole = connect();
    await whole.ended;
    const ids = whole.frames().filter((f) => f.event === 'token').map((f) => f.id!);
    expect(ids.slice(0, 3).map((id) => id.split('.')[1])).toEqual(['0', '1', '2']);

    const resumed = connect({ after: ids[0] });
    await resumed.ended;
    expect(resumed.text()).toBe('order ships Monday.');
    const atTheEnd = connect({ after: ids[3] });
    await atTheEnd.ended;
    expect(atTheEnd.frames().map((f) => f.event)).toEqual(['done']);
  });

  it('a reset after the position goes out, so the screen ends on the answer', async () => {
    emit('llm.chunk', { step: 0, content: 'Let me check ' });
    emit('llm.step_kind', { step: 0, kind: 'text' });
    const first = connect();
    await until(() => first.text() === 'Let me check ', 'the narration');
    first.drop();
    await first.ended.catch(() => undefined);
    // It turned out to be a tool step: taken back, then the answer.
    emit('llm.response', { step: 0, content: 'Let me check ', toolCalls: [{ id: 't1', name: 'crm_lookup' }] });
    emit('llm.started', { step: 1, answer: true });
    emit('llm.chunk', { step: 1, content: 'It ships Monday.' });
    emit('run.completed', { output: 'It ships Monday.' });
    const second = connect({ lastEventId: first.lastId() });
    await second.ended;
    expect(second.frames().map((f) => f.event)).toEqual(['reset', 'token', 'done']);
    expect(screen(first, second)).toBe('It ships Monday.');
  });

  it('never sends the working, from the start or on a resume: asserted on the bytes', async () => {
    const secrets = ['acct-4411', 'jane@corp.test', 'crm_lookup', 'tier=gold', 'margin 41%', 'internal-note-77'];
    emit('llm.started', { step: 0, answer: false });
    emit('llm.chunk', { step: 0, content: 'Looking up acct-4411 for jane@corp.test' });
    emit('llm.response', { step: 0, content: 'Looking up acct-4411', toolCalls: [{ id: 't1', name: 'crm_lookup', arguments: { account: 'acct-4411' } }] });
    emit('tool.started', { step: 0, toolCallId: 't1', tool: 'crm_lookup', input: { email: 'jane@corp.test' } });
    emit('tool.result', { step: 0, toolCallId: 't1', tool: 'crm_lookup', output: { tier: 'tier=gold', margin: 'margin 41%' } });
    emit('memory.updated', { key: 'note', value: 'internal-note-77' });
    emit('step.completed', { step: 0, toolCalls: [{ name: 'crm_lookup' }] });
    emit('llm.started', { step: 1, answer: true });
    emit('llm.chunk', { step: 1, content: 'Your order ' });
    const first = connect();
    await until(() => first.text() === 'Your order ', 'the first answer token');
    first.drop();
    await first.ended.catch(() => undefined);
    emit('llm.chunk', { step: 1, content: 'ships Monday.' });
    emit('tool.started', { step: 2, toolCallId: 't2', tool: 'crm_lookup', input: { note: 'internal-note-77' } });
    emit('run.completed', { output: 'Your order ships Monday.' });

    const second = connect({ lastEventId: first.lastId() });
    await second.ended;
    // From the very start, too.
    const fresh = connect();
    await fresh.ended;

    for (const raw of [first.raw(), second.raw(), fresh.raw()]) {
      for (const secret of secrets) expect(raw).not.toContain(secret);
      expect(raw).not.toMatch(/event: (tool|llm|memory|step)\./);
    }
    expect(first.text() + second.text()).toBe('Your order ships Monday.');
    expect(fresh.text()).toBe('Your order ships Monday.');
  });

  it('another visitor cannot resume this run: 404, and nothing is written', async () => {
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'private reply' });
    const first = connect();
    await until(() => first.text() === 'private reply', 'the token');
    const lastId = first.lastId();
    first.drop();
    await first.ended.catch(() => undefined);

    const other = connect({ lastEventId: lastId, visitor: 'eu-2' });
    await expect(other.ended).rejects.toMatchObject({ status: 404 });
    expect(other.chunks).toEqual([]);
    const noCookie = connect({ after: '0-0.0', visitor: 'nobody' });
    await expect(noCookie.ended).rejects.toMatchObject({ status: 404 });
    expect(noCookie.chunks).toEqual([]);
  });

  it('refuses a malformed ?after before looking anything up', async () => {
    const bad = connect({ after: '../../etc' });
    await expect(bad.ended).rejects.toThrow(BadRequestException);
    expect(bad.chunks).toEqual([]);
  });

  it('ignores a malformed Last-Event-ID (one left over from another stream) and sends the reply whole', async () => {
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'Hello there.' });
    emit('run.completed', { output: 'Hello there.' });
    const c = connect({ lastEventId: '42' });
    await c.ended;
    expect(c.text()).toBe('Hello there.');
  });

  it('a finished run is not replayed: done at once, and the page reads the transcript', async () => {
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'Hello' });
    emit('run.completed', { output: 'Hello' });
    runStatus = 'completed';
    const c = connect({ lastEventId: '1-0.0' });
    await c.ended;
    expect(c.frames()).toEqual([{ event: 'done', data: { reason: 'run.completed' } }]);
    runStatus = 'timeout';
    const t = connect();
    await t.ended;
    expect(t.frames()).toEqual([{ event: 'done', data: { reason: 'run.failed' } }]);
  });

  it('at its time limit the stream ends without done, so the page reconnects from its last frame', async () => {
    (controller as any).agentRuntimeService.subscribeRunEvents.mockImplementationOnce(
      async (runId: string, handler: any, signal?: AbortSignal) => helper.subscribeRunEvents(runId, handler, signal, 50),
    );
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'Still ' });
    const c = connect();
    await c.ended;
    expect(c.text()).toBe('Still ');
    expect(c.frames().some((f) => f.event === 'done')).toBe(false);
  });
});
