import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ChannelWidgetController } from '../channel-widget.controller';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { AgentRuntimeEventsHelper } from '../../../agents/agent-runtime-events.helper';
import { fakeRedisStreams } from '../../../../test/fake-redis-streams';
import { publicSurfaceFor } from '../surface-cors';

/**
 * The widget's reply stream: the hosted chat's resumable stream, behind the
 * widget's own visitor checks. The visitor is the thread (the widget has no
 * session of ours), so a run is streamed only to the thread it was started
 * under, on this widget. Only the answer goes out, never the working, and a
 * dropped connection picks up from the last frame. The browser side is
 * widget-script-stream.spec.ts; the real-Postgres check of which runs a
 * thread may stream is visitor-resume.integration.spec.ts.
 */
describe('widget: a reply streams as it is written', () => {
  const GW = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
  const RUN = '7a7a7a7a-0000-4000-8000-000000000001';
  const THREAD = 'w-11111111-2222-4333-8444-555555555555';
  let redis: ReturnType<typeof fakeRedisStreams>;
  let helper: AgentRuntimeEventsHelper;
  let widget: { findWidgetGateway: jest.Mock; widgetRunOnThread: jest.Mock };
  let limits: { checkVisitorStream: jest.Mock };
  let runStatus: string;
  let controller: ChannelWidgetController;

  const gateway = () =>
    Object.assign(new Gateway(), {
      id: GW,
      type: GatewayType.CHAT_WIDGET,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      agentId: 'agent-1',
      configuration: {},
    });

  beforeEach(() => {
    redis = fakeRedisStreams();
    helper = new AgentRuntimeEventsHelper({} as any, redis);
    runStatus = 'running';
    widget = {
      findWidgetGateway: jest.fn(async () => gateway()),
      // The thread's own run only.
      widgetRunOnThread: jest.fn(async (_gw: Gateway, threadId: string, runId: string) =>
        threadId === THREAD && runId === RUN ? { id: RUN, status: runStatus, agent: { agentConfig: {} } } : null,
      ),
    };
    limits = { checkVisitorStream: jest.fn(async () => ({ limited: false })) };
    const runtime = {
      subscribeRunEvents: (runId: string, handler: any, signal?: AbortSignal) => helper.subscribeRunEvents(runId, handler, signal, 3_000),
    };
    controller = new ChannelWidgetController(widget as any, limits as any, undefined, undefined, undefined, undefined, runtime as any);
  });

  const emit = (type: string, data: any) => helper.emitEvent(RUN, type, data);

  const connect = (opts: { threadId?: string; runId?: string; after?: string } = {}) => {
    const chunks: string[] = [];
    let onClose: (() => void) | undefined;
    const res: any = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => chunks.push(chunk)),
      end: jest.fn(),
    };
    const req: any = {
      headers: {},
      ip: '203.0.113.9',
      socket: { remoteAddress: '203.0.113.9' },
      on: (event: string, fn: () => void) => {
        if (event === 'close') onClose = fn;
      },
    };
    const ended = controller.streamReply(GW, opts.threadId ?? THREAD, opts.runId ?? RUN, req, res, opts.after);
    const frames = () =>
      chunks
        .join('')
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const f: { id?: string; event?: string; data?: any } = {};
          for (const line of block.split('\n')) {
            const at = line.indexOf(': ');
            if (at < 0) continue;
            const [k, v] = [line.slice(0, at), line.slice(at + 2)];
            if (k === 'id') f.id = v;
            if (k === 'event') f.event = v;
            if (k === 'data') f.data = JSON.parse(v);
          }
          return f;
        });
    return {
      ended,
      res,
      chunks,
      raw: () => chunks.join(''),
      tokens: () => frames().filter((f) => f.event === 'token').map((f) => f.data.content as string),
      lastId: () => frames().filter((f) => f.id).pop()?.id,
      done: () => frames().find((f) => f.event === 'done')?.data?.reason,
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

  it('streams the answer word by word, and none of the working', async () => {
    emit('llm.started', { step: 0, answer: false });
    emit('llm.chunk', { step: 0, content: 'Looking up acct-4411' });
    emit('llm.response', { step: 0, content: 'Looking up acct-4411', toolCalls: [{ id: 't1', name: 'crm_lookup' }] });
    emit('tool.started', { step: 0, toolCallId: 't1', tool: 'crm_lookup', input: { email: 'jane@corp.test' } });
    emit('memory.updated', { value: 'internal-note-77' });
    emit('llm.started', { step: 1, answer: true });
    emit('llm.chunk', { step: 1, content: 'Your order' });
    emit('llm.chunk', { step: 1, content: ' ships Monday.' });
    emit('run.completed', { output: 'Your order ships Monday.' });
    const c = connect();
    await c.ended;

    expect(c.tokens()).toEqual(['Your order', ' ships Monday.']);
    expect(c.done()).toBe('run.completed');
    for (const secret of ['acct-4411', 'jane@corp.test', 'crm_lookup', 'internal-note-77']) expect(c.raw()).not.toContain(secret);
    expect(c.res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
  });

  it('a dropped connection resumes from the last frame: the rest, nothing twice', async () => {
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'Your order' });
    const first = connect();
    await until(() => first.tokens().length === 1, 'the first token');
    first.drop();
    await first.ended;
    emit('llm.chunk', { step: 0, content: ' ships Monday.' });
    emit('run.completed', { output: 'Your order ships Monday.' });
    const second = connect({ after: first.lastId() });
    await second.ended;
    expect([...first.tokens(), ...second.tokens()]).toEqual(['Your order', ' ships Monday.']);
  });

  it('another thread, or a made-up run, gets 404 and nothing is streamed', async () => {
    emit('llm.started', { step: 0, answer: true });
    emit('llm.chunk', { step: 0, content: 'Your order ships Monday.' });
    const other = connect({ threadId: 'w-someone-else' });
    await expect(other.ended).rejects.toThrow(NotFoundException);
    expect(other.chunks).toEqual([]);
    const guessed = connect({ runId: '7a7a7a7a-0000-4000-8000-000000000999' });
    await expect(guessed.ended).rejects.toThrow(NotFoundException);
    expect(widget.widgetRunOnThread).toHaveBeenCalledWith(expect.objectContaining({ id: GW }), 'w-someone-else', RUN);
  });

  it('needs a thread and a run id, and refuses an `after` it did not send', async () => {
    await expect(connect({ threadId: '' }).ended).rejects.toThrow(BadRequestException);
    await expect(connect({ runId: 'not-a-uuid' }).ended).rejects.toThrow(BadRequestException);
    await expect(connect({ after: 'garbage' }).ended).rejects.toThrow(BadRequestException);
  });

  it('counts each open against the thread and the address; over the limit is 429 with Retry-After', async () => {
    limits.checkVisitorStream.mockResolvedValueOnce({ limited: true, code: 'VISITOR_RATE_LIMITED', message: 'slow down', retryAfterSeconds: 9 });
    const c = connect();
    await expect(c.ended).rejects.toMatchObject({ status: 429, response: { code: 'VISITOR_RATE_LIMITED' } });
    expect(c.res.setHeader).toHaveBeenCalledWith('Retry-After', '9');
    expect(c.chunks).toEqual([]);
    expect(limits.checkVisitorStream).toHaveBeenCalledWith(expect.objectContaining({ id: GW }), {
      endUserId: THREAD,
      clientHash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(widget.widgetRunOnThread).not.toHaveBeenCalled();
  });

  it('a finished reply is `done` at once: the widget reads the stored copy', async () => {
    runStatus = 'completed';
    const c = connect();
    await c.ended;
    expect(c.tokens()).toEqual([]);
    expect(c.done()).toBe('run.completed');
  });

  it('is a public widget path, so the embedding site gets its CORS answer', () => {
    expect(publicSurfaceFor(`/gateways/${GW}/widget/stream`)).toEqual({ kind: 'chat_widget', gatewayId: GW });
    expect(publicSurfaceFor(`/api/gateways/${GW}/widget/stream?threadId=x&runId=y`)).toEqual({ kind: 'chat_widget', gatewayId: GW });
  });
});
