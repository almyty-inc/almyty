/**
 * Real-Postgres and real-Redis integration spec for a visitor resuming a
 * reply (hosted chat), and for the widget picking up its replies where it
 * left off.
 *
 *  - A visitor who drops mid-answer and reconnects, several times, while
 *    the run keeps writing tokens, ends up with exactly the reply: nothing
 *    missing, nothing twice. The unit spec (hosted-chat-resume.spec.ts)
 *    drives the same controller over an in-memory stream; here the stream
 *    is Redis, with its own ids and a real blocking XREAD.
 *  - Who may resume is decided by the real HostedChatService against real
 *    rows: the cookie's visitor, the run's conversation theirs. A request
 *    without a visitor writes no visitor row.
 *  - Opening streams too often is refused by the real limiter on Redis,
 *    for that visitor only.
 *  - A conversation names the reply still being written, so a reopened
 *    page can follow it; the widget streams a run only to its own thread.
 *  - The widget's poll cursor against a real `timestamptz`, which keeps
 *    microseconds that a JSON timestamp loses.
 *
 * Gated behind `RUN_DB_INTEGRATION=1`, like the other DB specs. Redis is
 * REDIS_HOST / REDIS_PORT.
 */
import { NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentMode, AgentRunStatus } from '../../entities/agent-run.entity';
import { ChannelEvent } from '../../entities/channel-event.entity';
import { Conversation } from '../../entities/conversation.entity';
import { EndUser } from '../../entities/end-user.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { Message } from '../../entities/message.entity';
import { Organization } from '../../entities/organization.entity';
import { AgentRuntimeEventsHelper } from '../../modules/agents/agent-runtime-events.helper';
import { ChannelGatewayService } from '../../modules/gateways/channels/channel-gateway.service';
import { HostedChatController } from '../../modules/gateways/channels/hosted-chat.controller';
import { HostedChatService } from '../../modules/gateways/channels/hosted-chat.service';
import { GatewayRateLimitService, STREAM_OPENS_PER_VISITOR } from '../../modules/gateways/gateway-rate-limit.service';
import { visitorPosPastEvent } from '../../modules/agents/run-stream-position';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'visitor_resume_test';

jest.setTimeout(90_000);

describeIfDb('visitor resume (real Postgres and Redis)', () => {
  let ds: DataSource;
  let redis: Redis;
  let runs: Repository<AgentRun>;
  let helper: AgentRuntimeEventsHelper;
  let controller: HostedChatController;
  let limited: HostedChatController;
  let orgId: string;
  let agentId: string;
  let gateway: Gateway;
  const slug = `resume-${Date.now()}`;

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
      extra: { options: `-c search_path=${SCHEMA},public`, max: 10 },
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

    const org = await ds.getRepository(Organization).save({ name: 'resume', slug: `resume-org-${Date.now()}`, plan: 'free', isActive: true } as any);
    orgId = org.id;
    const agent = await ds.getRepository(Agent).save({ name: 'resume-agent', organizationId: orgId, status: AgentStatus.ACTIVE, mode: 'autonomous', pipeline: { nodes: [], edges: [] } } as any);
    agentId = agent.id;
    gateway = await ds.getRepository(Gateway).save({
      name: 'Acme chat',
      type: GatewayType.HOSTED_CHAT,
      status: GatewayStatus.ACTIVE,
      organizationId: orgId,
      agentId,
      endpoint: `/chat/${slug}`,
      configuration: { hostedChat: { slug } },
    } as any);

    helper = new AgentRuntimeEventsHelper(runs, redis);
    const hostedChat = new HostedChatService(
      ds.getRepository(Gateway),
      ds.getRepository(EndUser),
      ds.getRepository(Conversation),
      ds.getRepository(Message),
      runs,
    );
    // The runtime's two calls the stream makes, over the same rows and stream.
    const runtime = {
      getRun: async (runId: string, organizationId: string, agent: string) => {
        const run = await runs.findOne({ where: { id: runId, organizationId, agentId: agent }, relations: { agent: true } });
        if (!run) throw new NotFoundException('Run not found');
        return run;
      },
      subscribeRunEvents: (runId: string, handler: any, signal?: AbortSignal) => helper.subscribeRunEvents(runId, handler, signal, 30_000),
    };
    // The stream limiter, out of the way here: the real one has its own test below.
    controller = new HostedChatController(hostedChat, { checkVisitorStream: async () => ({ limited: false }) } as any, runtime as any);
    limited = new HostedChatController(hostedChat, new GatewayRateLimitService(redis as any), runtime as any);
  });

  afterAll(async () => {
    const keys = [...((await redis?.keys('run:*:events')) ?? []), ...((await redis?.keys(`gw_rate:${gateway?.id}:*`)) ?? [])];
    if (keys.length) await redis.del(...keys);
    await redis?.quit();
    if (ds?.isInitialized) await ds.destroy();
  });

  /** A visitor with a cookie, and a running reply in one of their conversations. */
  const visitorWithRun = async () => {
    const sessionKey = HostedChatService.newSessionKey();
    const endUser = await ds.getRepository(EndUser).save({ organizationId: orgId, gatewayId: gateway.id, sessionKey } as any);
    const conversation = await ds.getRepository(Conversation).save({ organizationId: orgId, agentId, gatewayId: gateway.id, endUserId: endUser.id, title: 'Where is my order?' } as any);
    const run = await runs.save(
      runs.create({
        agentId,
        organizationId: orgId,
        conversationId: conversation.id,
        endUserId: endUser.id,
        mode: AgentMode.AUTONOMOUS,
        status: AgentRunStatus.RUNNING,
        input: { text: 'Where is my order?' },
        steps: [],
        currentStep: 0,
        workingMemory: {},
        metadata: { composeFinalAnswer: true },
      } as Partial<AgentRun>),
    );
    return { sessionKey, endUser, run };
  };

  const connect = (runId: string, sessionKey: string | null, lastEventId?: string) => {
    const chunks: string[] = [];
    let onClose: (() => void) | undefined;
    const res: any = {
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk: string) => chunks.push(chunk),
      end: () => undefined,
    };
    const req: any = {
      headers: lastEventId ? { 'last-event-id': lastEventId } : {},
      cookies: sessionKey ? { [HostedChatService.SESSION_COOKIE]: sessionKey } : {},
      ip: '203.0.113.9',
      socket: { remoteAddress: '203.0.113.9' },
      on: (event: string, fn: () => void) => {
        if (event === 'close') onClose = fn;
      },
    };
    const ended = controller.stream(slug, runId, req, res);
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
      chunks,
      raw: () => chunks.join(''),
      tokens: () => frames().filter((f) => f.event === 'token').map((f) => f.data.content as string),
      lastId: () => frames().filter((f) => f.id).pop()?.id,
      done: () => frames().find((f) => f.event === 'done')?.data?.reason,
      drop: () => onClose?.(),
    };
  };

  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 2_000; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it('dropping and reconnecting mid-answer while the run writes: the reply arrives whole, nothing twice', async () => {
    const { sessionKey, run } = await visitorWithRun();
    const words = Array.from({ length: 240 }, (_, i) => `w${i} `);
    const answer = words.join('');
    helper.emitEvent(run.id, 'llm.started', { step: 0, answer: true });

    // The run writes its tokens on its own clock, racing every handover.
    let written = 0;
    const writer = (async () => {
      for (const word of words) {
        helper.emitEvent(run.id, 'llm.chunk', { step: 0, content: word });
        written++;
        if (written % 7 === 0) await new Promise((r) => setTimeout(r, 2));
      }
      helper.emitEvent(run.id, 'llm.response', { step: 0, content: answer });
      helper.emitEvent(run.id, 'run.completed', { output: answer });
    })();

    const connections: Array<ReturnType<typeof connect>> = [];
    let current = connect(run.id, sessionKey);
    connections.push(current);
    for (let drop = 0; drop < 4; drop++) {
      const have = current.tokens().length;
      await until(() => current.tokens().length >= have + 15 || !!current.done(), 'more of the reply');
      if (current.done()) break;
      current.drop();
      await current.ended;
      current = connect(run.id, sessionKey, current.lastId() ?? connections.map((c) => c.lastId()).filter(Boolean).pop());
      connections.push(current);
    }
    await writer;
    await current.ended;

    const seen = connections.flatMap((c) => c.tokens());
    expect(seen.join('')).toBe(answer);
    expect(seen).toEqual(words);
    expect(connections.length).toBeGreaterThan(1);
    expect(current.done()).toBe('run.completed');
  });

  it('another visitor, or one with no cookie, cannot resume the run: 404, and nothing is written', async () => {
    const { sessionKey, run } = await visitorWithRun();
    const other = await visitorWithRun();
    helper.emitEvent(run.id, 'llm.started', { step: 0, answer: true });
    helper.emitEvent(run.id, 'llm.chunk', { step: 0, content: 'Your order ships Monday.' });
    const mine = connect(run.id, sessionKey);
    await until(() => mine.tokens().length === 1, 'the reply');
    const lastId = mine.lastId();
    mine.drop();
    await mine.ended;

    const theirs = connect(run.id, other.sessionKey, lastId);
    await expect(theirs.ended).rejects.toMatchObject({ status: 404 });
    expect(theirs.chunks).toEqual([]);
    const anonymous = connect(run.id, null, lastId);
    await expect(anonymous.ended).rejects.toMatchObject({ status: 404 });
    expect(anonymous.chunks).toEqual([]);

    helper.emitEvent(run.id, 'run.completed', { output: 'Your order ships Monday.' });
  });

  it('never a byte of the working, from the start or on a resume', async () => {
    const { sessionKey, run } = await visitorWithRun();
    const secrets = ['acct-4411', 'jane@corp.test', 'crm_lookup', 'tier=gold', 'internal-note-77'];
    helper.emitEvent(run.id, 'llm.started', { step: 0, answer: false });
    helper.emitEvent(run.id, 'llm.chunk', { step: 0, content: 'Looking up acct-4411 for jane@corp.test' });
    helper.emitEvent(run.id, 'llm.response', { step: 0, content: 'Looking up acct-4411', toolCalls: [{ id: 't1', name: 'crm_lookup' }] });
    helper.emitEvent(run.id, 'tool.started', { step: 0, toolCallId: 't1', tool: 'crm_lookup', input: { email: 'jane@corp.test' } });
    helper.emitEvent(run.id, 'tool.result', { step: 0, toolCallId: 't1', tool: 'crm_lookup', output: { tier: 'tier=gold' } });
    helper.emitEvent(run.id, 'memory.updated', { value: 'internal-note-77' });
    helper.emitEvent(run.id, 'llm.started', { step: 1, answer: true });
    helper.emitEvent(run.id, 'llm.chunk', { step: 1, content: 'Your order ' });
    const first = connect(run.id, sessionKey);
    await until(() => first.tokens().length === 1, 'the first answer token');
    first.drop();
    await first.ended;
    helper.emitEvent(run.id, 'tool.started', { step: 2, toolCallId: 't2', tool: 'crm_lookup', input: { note: 'internal-note-77' } });
    helper.emitEvent(run.id, 'llm.chunk', { step: 1, content: 'ships Monday.' });
    helper.emitEvent(run.id, 'run.completed', { output: 'Your order ships Monday.' });
    const second = connect(run.id, sessionKey, first.lastId());
    await second.ended;
    const fresh = connect(run.id, sessionKey);
    await fresh.ended;

    for (const raw of [first.raw(), second.raw(), fresh.raw()]) {
      for (const secret of secrets) expect(raw).not.toContain(secret);
      expect(raw).not.toMatch(/event: (tool|llm|memory|step)\./);
    }
    expect([...first.tokens(), ...second.tokens()].join('')).toBe('Your order ships Monday.');
    expect(fresh.tokens().join('')).toBe('Your order ships Monday.');
  });

  it('a request with no cookie, or one nobody holds, writes no visitor row and gets what a stranger gets', async () => {
    const { run } = await visitorWithRun();
    const visitors = ds.getRepository(EndUser);
    const before = await visitors.count({ where: { gatewayId: gateway.id } });

    for (const session of [null, 'not-a-session-anyone-holds', null, HostedChatService.newSessionKey()]) {
      const c = connect(run.id, session);
      await expect(c.ended).rejects.toMatchObject({ status: 404 });
      expect(c.chunks).toEqual([]);
    }
    expect(await visitors.count({ where: { gatewayId: gateway.id } })).toBe(before);
  });

  it('reconnecting too often: the real limiter on real Redis answers 429 for that visitor only', async () => {
    const mine = await visitorWithRun();
    const theirs = await visitorWithRun();
    // Finished: each open answers `done` at once, so the loop is quick.
    await runs.update({ id: mine.run.id }, { status: AgentRunStatus.COMPLETED });
    await runs.update({ id: theirs.run.id }, { status: AgentRunStatus.COMPLETED });

    // The limiter counts in fixed clock windows (per minute, per hour). Pin the
    // clock just after a window starts so the whole burst lands in one window;
    // a burst that straddled a minute boundary split its count and never tripped.
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1, 12, 0, 1));

    // A fresh address per visitor, so only the visitor bucket is in play.
    const open = async (runId: string, sessionKey: string, ip: string) => {
      const res: any = { setHeader: jest.fn(), flushHeaders: () => undefined, write: () => undefined, end: () => undefined };
      const req: any = {
        headers: {},
        cookies: { [HostedChatService.SESSION_COOKIE]: sessionKey },
        ip,
        socket: { remoteAddress: ip },
        on: () => undefined,
      };
      try {
        await limited.stream(slug, runId, req, res);
        return { status: 200, res };
      } catch (err: any) {
        return { status: err.status as number, res };
      }
    };

    const ipA = `198.51.100.${(Date.now() % 200) + 1}`;
    for (let i = 0; i < STREAM_OPENS_PER_VISITOR[0].limit; i++) {
      expect((await open(mine.run.id, mine.sessionKey, ipA)).status).toBe(200);
    }
    const over = await open(mine.run.id, mine.sessionKey, ipA);
    expect(over.status).toBe(429);
    expect(over.res.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));

    // Somebody else on the same chat is not held up.
    expect((await open(theirs.run.id, theirs.sessionKey, '192.0.2.77')).status).toBe(200);
    now.mockRestore();
  });

  it('a conversation names the reply still being written, and none once it is finished', async () => {
    const { run } = await visitorWithRun();
    const service = new HostedChatService(
      ds.getRepository(Gateway),
      ds.getRepository(EndUser),
      ds.getRepository(Conversation),
      ds.getRepository(Message),
      runs,
    );
    const conversation = (await ds.getRepository(Conversation).findOneByOrFail({ id: run.conversationId })) as Conversation;
    expect(await service.openRunOf(conversation)).toBe(run.id);

    await runs.update({ id: run.id }, { status: AgentRunStatus.COMPLETED });
    expect(await service.openRunOf(conversation)).toBeNull();

    // A newer reply in the same conversation, still being written.
    const next = await runs.save(
      runs.create({
        agentId,
        organizationId: orgId,
        conversationId: conversation.id,
        endUserId: run.endUserId,
        mode: AgentMode.AUTONOMOUS,
        status: AgentRunStatus.PENDING,
        input: { text: 'And the invoice?' },
        steps: [],
        currentStep: 0,
        workingMemory: {},
      } as Partial<AgentRun>),
    );
    expect(await service.openRunOf(conversation)).toBe(next.id);
  });

  it('a run carried on after waiting for input: from where its stream ended, only the new reply', async () => {
    const { sessionKey, run } = await visitorWithRun();
    helper.emitEvent(run.id, 'llm.started', { step: 0, answer: true });
    helper.emitEvent(run.id, 'llm.chunk', { step: 0, content: 'Which colour would you like?' });
    helper.emitEvent(run.id, 'llm.response', { step: 0, content: 'Which colour would you like?' });
    // The writes above are not awaited by the runtime; wait until Redis has them.
    for (let i = 0; i < 200 && (await redis.xlen(`run:${run.id}:events`)) < 3; i++) await new Promise((r) => setTimeout(r, 5));
    const end = await helper.lastRunEventPos(run.id);
    expect(end).toMatch(/^\d+-\d+$/);
    helper.emitEvent(run.id, 'llm.started', { step: 1, answer: true });
    helper.emitEvent(run.id, 'llm.chunk', { step: 1, content: 'Blue it is.' });
    helper.emitEvent(run.id, 'run.completed', { output: 'Blue it is.' });

    const c = connect(run.id, sessionKey, visitorPosPastEvent(end!));
    await c.ended;
    expect(c.tokens()).toEqual(['Blue it is.']);
    expect(c.raw()).not.toContain('Which colour');
    expect(await helper.lastRunEventPos('no-such-run')).toBeNull();
  });

  it('the widget streams a run only to the thread, widget and agent it was started under', async () => {
    const widgetGateway = await ds.getRepository(Gateway).save({
      name: 'Acme widget',
      type: GatewayType.CHAT_WIDGET,
      status: GatewayStatus.ACTIVE,
      organizationId: orgId,
      agentId,
      endpoint: `/widget/${Date.now()}`,
      configuration: {},
    } as any);
    const thread = `w-${Date.now()}`;
    const widgetRun = (metadata: Record<string, unknown>) =>
      runs.save(
        runs.create({
          agentId,
          organizationId: orgId,
          mode: AgentMode.AUTONOMOUS,
          status: AgentRunStatus.RUNNING,
          input: { text: 'Hi' },
          steps: [],
          currentStep: 0,
          workingMemory: {},
          metadata,
        } as Partial<AgentRun>),
      );
    const mine = await widgetRun({ gatewayId: widgetGateway.id, threadId: thread, source: 'chat_widget' });
    const otherThread = await widgetRun({ gatewayId: widgetGateway.id, threadId: `${thread}-other`, source: 'chat_widget' });
    const otherSurface = await widgetRun({ gatewayId: gateway.id, threadId: thread });
    const service = Object.assign(Object.create(ChannelGatewayService.prototype), { runRepository: runs }) as ChannelGatewayService;

    const found = await service.widgetRunOnThread(widgetGateway, thread, mine.id);
    expect(found?.id).toBe(mine.id);
    // The agent comes with it: the stream needs to know whether it withholds candidates.
    expect(found?.agent?.id).toBe(agentId);
    expect(await service.widgetRunOnThread(widgetGateway, thread, otherThread.id)).toBeNull();
    expect(await service.widgetRunOnThread(widgetGateway, thread, otherSurface.id)).toBeNull();
    expect(await service.widgetRunOnThread({ ...widgetGateway, agentId: '00000000-0000-4000-8000-000000000000' } as Gateway, thread, mine.id)).toBeNull();
  });

  it('the widget: each reply once, though the column keeps microseconds a JSON time loses', async () => {
    const events = ds.getRepository(ChannelEvent);
    const service = Object.assign(Object.create(ChannelGatewayService.prototype), { eventRepository: events }) as ChannelGatewayService;
    const thread = `w-${Date.now()}`;
    const reply = (message: string) =>
      events.save(
        events.create({
          organizationId: orgId,
          gatewayId: gateway.id,
          channelType: GatewayType.CHAT_WIDGET,
          direction: 'outbound',
          status: 'processed',
          payload: { kind: 'widget_message', threadId: thread, message, attachments: null },
        } as any),
      );
    await reply('Your order ships Monday.');
    // A stored time with a part below the millisecond, as now() gives most of the time.
    await ds.query(`UPDATE channel_events SET "createdAt" = date_trunc('milliseconds', "createdAt") + interval '456 microseconds' WHERE payload->>'threadId' = $1`, [thread]);

    const first = await service.listWidgetMessages(gateway.id, thread);
    expect(first.map((r) => r.message)).toEqual(['Your order ships Monday.']);
    // What the widget held: the reply's id, and its time as JSON rounds it.
    const lastAt = new Date(JSON.parse(JSON.stringify(first[0].createdAt)));

    expect(await service.listWidgetMessages(gateway.id, thread, undefined, first[0].id)).toEqual([]);
    // An older widget, polling by time: the same reply is not handed back.
    expect(await service.listWidgetMessages(gateway.id, thread, lastAt)).toEqual([]);

    await reply('Anything else?');
    const next = await service.listWidgetMessages(gateway.id, thread, undefined, first[0].id);
    expect(next.map((r) => r.message)).toEqual(['Anything else?']);
    expect((await service.listWidgetMessages(gateway.id, thread, undefined, next[0].id)).length).toBe(0);
  });
});
