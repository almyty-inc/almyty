import { HttpException } from '@nestjs/common';
import { DataSource, DeepPartial, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Organization } from '../../entities/organization.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentApp, AppAuthMode } from '../../entities/agent-app.entity';
import { AppDistribution, DistributionStatus, DistributionTarget } from '../../entities/agent-app-distribution.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { ChannelEvent } from '../../entities/channel-event.entity';
import { EndUser } from '../../entities/end-user.entity';
import { defaultLimitsFor } from '../../modules/agent-apps/agent-app.rules';
import { rateLimitFor } from '../../modules/agent-apps/distribution-publish';
import { GatewayRateLimitService } from '../../modules/gateways/gateway-rate-limit.service';
import { GatewayAppLinkService } from '../../modules/gateways/gateway-app-link.service';
import { AppPlacePolicyService } from '../../modules/gateways/app-place-policy.service';
import { HostedChatService } from '../../modules/gateways/channels/hosted-chat.service';
import { HostedChatController } from '../../modules/gateways/channels/hosted-chat.controller';
import { ChannelGatewayService } from '../../modules/gateways/channels/channel-gateway.service';
import { ChannelWidgetController } from '../../modules/gateways/channels/channel-widget.controller';
import { ChatWidgetAdapter } from '../../modules/gateways/channels/adapters/chat-widget.adapter';
import { UnifiedGatewayDelegation } from '../../modules/gateways/unified-gateway-delegation.helper';
import { A2AServerService } from '../../modules/a2a/a2a-server.service';
import { runMayWriteSharedMemory } from '../../modules/agents/memory-autosave.policy';
import { FakeRedisWithWindows } from '../fake-redis-windows';
import { ensureSchema } from './isolated-schema.helper';

/**
 * Every place an app answers on, against a real Postgres: the web chat,
 * the website widget, a messaging channel and A2A. Each must apply the
 * app's per-visitor limits, its per-run cost cap, its spend cap across
 * all places and visitors, and its visitor-memory rule; the widget must
 * honour the visitor rights the app grants.
 *
 * The runtime is the one double: it records the options each place
 * starts a run with and writes the rows startRun would, so the spend
 * cap reads real agent_runs rows and erasure deletes real ones.
 */
const run = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'app_place_limits_test';

run('app place limits and visitor rights (real Postgres)', () => {
  jest.setTimeout(60_000);

  let ds: DataSource;
  let orgs: Repository<Organization>;
  let agents: Repository<Agent>;
  let apps: Repository<AgentApp>;
  let distributions: Repository<AppDistribution>;
  let gateways: Repository<Gateway>;
  let runs: Repository<AgentRun>;
  let conversations: Repository<Conversation>;
  let messages: Repository<Message>;
  let events: Repository<ChannelEvent>;

  let redis: FakeRedisWithWindows;
  let rateLimit: GatewayRateLimitService;
  let places: AppPlacePolicyService;
  let notifications: { emit: jest.Mock };
  let runtime: { startRun: jest.Mock; sendInput: jest.Mock; getRunEmitter: jest.Mock; getRun: jest.Mock };
  let hostedChat: HostedChatController;
  let channels: ChannelGatewayService;
  let widget: ChannelWidgetController;
  let delegation: UnifiedGatewayDelegation;
  let telegram: any;

  let org: Organization;
  let agent: Agent;

  const res = () => {
    const out: any = { headers: {} as Record<string, string>, statusCode: 200, body: undefined };
    out.setHeader = (k: string, v: string) => (out.headers[k] = v);
    out.cookie = (_name: string, value: string) => ((out.cookieValue = value), out);
    out.clearCookie = () => out;
    out.status = (code: number) => ((out.statusCode = code), out);
    out.json = (body: unknown) => ((out.body = body), out);
    out.send = (body: unknown) => ((out.body = body), out);
    return out;
  };
  const req = (ip: string, extra: Record<string, any> = {}) =>
    ({ headers: {}, ip, socket: { remoteAddress: ip }, cookies: {}, ...extra }) as any;

  async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() };
      throw err;
    }
    throw new Error('expected a refusal');
  }

  /** An app with one place of `target`, published: app, gateway and distribution rows. */
  async function place(
    target: DistributionTarget,
    type: GatewayType,
    overrides: { limits?: AgentApp['limits']; privacy?: AgentApp['privacy']; gatewayRateLimit?: any } = {},
  ): Promise<{ app: AgentApp; gateway: Gateway }> {
    const slug = `app-${randomUUID().slice(0, 8)}`;
    const app = await apps.save(
      apps.create({
        organizationId: org.id,
        name: `App ${slug}`,
        slug,
        agentIds: [agent.id],
        authMode: AppAuthMode.PUBLIC_LINK,
        branding: {},
        capabilities: {},
        limits: overrides.limits ?? { ...defaultLimitsFor(AppAuthMode.PUBLIC_LINK), perUserRateLimit: 3, perIpRateLimit: 100 },
        privacy: overrides.privacy ?? null,
      }),
    );
    const gateway = await gateways.save(
      gateways.create({
        organizationId: org.id,
        name: `${app.name} (${target})`,
        description: '',
        type,
        agentId: agent.id,
        status: GatewayStatus.ACTIVE,
        endpoint: `/apps/${slug}/${target}`,
        visibility: 'org',
        configuration: {
          appId: app.id,
          authMode: 'public_link',
          ...(target === DistributionTarget.WEB ? { hostedChat: { slug } } : {}),
        },
        rateLimitConfig: overrides.gatewayRateLimit ?? rateLimitFor(app, target),
      } as DeepPartial<Gateway>),
    );
    await distributions.save(
      distributions.create({
        organizationId: org.id,
        appId: app.id,
        target,
        status: DistributionStatus.LIVE,
        gatewayId: gateway.id,
        configuration: {},
      } as DeepPartial<AppDistribution>),
    );
    return { app, gateway };
  }

  /** Spend `dollars` against an app today, as a finished run would have. */
  async function spend(app: AgentApp, dollars: number): Promise<void> {
    await runs.save(
      runs.create({
        agentId: agent.id,
        organizationId: org.id,
        appId: app.id,
        mode: AgentMode.AUTONOMOUS,
        status: AgentRunStatus.COMPLETED,
        input: 'earlier',
        steps: [],
        totalCost: dollars,
      } as any),
    );
  }

  beforeAll(async () => {
    await ensureSchema(SCHEMA);
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();

    orgs = ds.getRepository(Organization);
    agents = ds.getRepository(Agent);
    apps = ds.getRepository(AgentApp);
    distributions = ds.getRepository(AppDistribution);
    gateways = ds.getRepository(Gateway);
    runs = ds.getRepository(AgentRun);
    conversations = ds.getRepository(Conversation);
    messages = ds.getRepository(Message);
    events = ds.getRepository(ChannelEvent);

    org = await orgs.save(orgs.create({ name: `Places ${randomUUID()}`, slug: `places-${randomUUID().slice(0, 8)}` }));
    agent = await agents.save(
      agents.create({
        name: 'Front desk',
        organizationId: org.id,
        status: AgentStatus.ACTIVE,
        mode: 'autonomous',
        visibility: 'org',
        pipeline: { nodes: [], edges: [] },
        instructions: 'Help.',
      } as DeepPartial<Agent>),
    );
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(() => {
    redis = new FakeRedisWithWindows();
    rateLimit = new GatewayRateLimitService(redis as any);
    const appLink = new GatewayAppLinkService(distributions);
    notifications = { emit: jest.fn(async () => undefined) };
    places = new AppPlacePolicyService(appLink, runs, notifications as any, redis as any);

    // What startRun writes, and nothing it decides: a conversation (filed
    // under options.gatewayId when new), the visitor's message, and the
    // run with the app stamp, the per-run cap and the metadata.
    runtime = {
      startRun: jest.fn(async (agentId: string, organizationId: string, _userId: null, input: string, options: any = {}) => {
        const conversation = options.conversationId
          ? await conversations.findOneByOrFail({ id: options.conversationId })
          : await conversations.save(
              Conversation.createConversation({
                agentId,
                organizationId,
                endUserId: options.endUserId ?? null,
                ...(options.gatewayId ? { gatewayId: options.gatewayId } : {}),
              }),
            );
        await messages.save(Message.createUserMessage(conversation.id, input));
        return runs.save(
          runs.create({
            agentId,
            organizationId,
            endUserId: options.endUserId ?? null,
            appId: options.appId ?? null,
            conversationId: conversation.id,
            mode: AgentMode.AUTONOMOUS,
            status: AgentRunStatus.RUNNING,
            input,
            steps: [],
            limits: { maxCostCents: options.maxCostCents || 100 },
            metadata: options.metadata ?? null,
          } as any),
        );
      }),
      sendInput: jest.fn(async (runId: string) => runs.findOneByOrFail({ id: runId })),
      getRunEmitter: jest.fn(() => null),
      getRun: jest.fn(),
    };

    const hosted = new HostedChatService(
      gateways,
      ds.getRepository(EndUser),
      conversations,
      messages,
      runs,
      undefined,
      undefined,
      appLink,
    );
    hostedChat = new HostedChatController(hosted, rateLimit, runtime as any, places);

    telegram = {
      type: 'telegram',
      extractTenantId: () => null,
      verifyWebhook: async () => true,
      deliveryId: (body: any) => String(body.update_id),
      normalizeInbound: (body: any) => ({
        text: body.text,
        userId: body.from,
        threadId: body.chat,
        metadata: { chatId: body.chat },
      }),
      formatOutbound: ({ text }: { text: string }) => ({ text }),
      sendResponse: jest.fn(async () => undefined),
    };
    const stub = { verifyWebhook: async () => false } as any;
    channels = new ChannelGatewayService(
      gateways,
      runs,
      events,
      runtime as any,
      new ChatWidgetAdapter(events),
      stub, stub, telegram, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub,
      undefined,
      undefined,
      rateLimit,
      undefined,
      undefined,
      places,
    );
    widget = new ChannelWidgetController(channels, rateLimit, appLink, places);

    const a2a = new A2AServerService(runtime as any, { buildAgentCard: () => ({}) } as any, runs, conversations, messages);
    const unused = {} as any;
    delegation = new UnifiedGatewayDelegation(
      agents,
      gateways,
      unused,
      unused,
      unused,
      unused,
      // The caller's credential, as the gateway auth layer resolves it.
      { resolveAndAuthenticate: async (_o: string, _e: string, r: any) => ({ auth: r.__auth }) } as any,
      a2a,
      unused,
      unused,
      unused,
      { get: () => 'https://api.example.test' } as any,
      rateLimit,
      channels,
      undefined,
      undefined,
      undefined,
      undefined,
      places,
    );
  });

  describe('web chat', () => {
    const post = (slug: string, ip = '198.51.100.1', cookie?: string) => {
      const r = res();
      const request = req(ip, cookie ? { cookies: { [HostedChatService.SESSION_COOKIE]: cookie } } : {});
      return hostedChat.postMessage(slug, { message: 'hello' }, request, r).then((out) => ({ out, r }));
    };

    it('starts every run with the app cost cap, its app stamp and the visitor memory rule', async () => {
      const { app } = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      await post(app.slug);

      const options = runtime.startRun.mock.calls[0][4];
      expect(options).toMatchObject({
        maxCostCents: 50,
        appId: app.id,
        metadata: expect.objectContaining({ appVisitor: true, visitorMemory: false }),
      });
      const [saved] = await runs.find({ where: { appId: app.id } });
      expect(saved.limits?.maxCostCents).toBe(50);
    });

    it('gives each visitor their own share', async () => {
      const { app } = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      const first = await post(app.slug);
      const session = first.r.cookieValue as string;
      expect(session).toBeTruthy();
      await post(app.slug, '198.51.100.1', session);
      await post(app.slug, '198.51.100.1', session);
      const refused = await refusal(post(app.slug, '198.51.100.1', session));
      expect(refused).toMatchObject({ status: 429, body: { code: 'VISITOR_RATE_LIMITED' } });
      // A second visitor, even at the same address, has a share of their own.
      await post(app.slug, '198.51.100.1');
      expect(runtime.startRun).toHaveBeenCalledTimes(4);
    });

    it('refuses every visitor once the app has spent its day, and tells the owner once', async () => {
      const { app } = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      await spend(app, 5);

      const first = await refusal(post(app.slug));
      expect(first.status).toBe(429);
      expect(first.body).toMatchObject({
        code: 'APP_SPEND_CAP_REACHED',
        message: 'This app has reached its limit for today.',
        period: 'day',
      });
      await refusal(post(app.slug, '198.51.100.9'));
      expect(runtime.startRun).not.toHaveBeenCalled();

      // Fire-and-forget: let the notification settle.
      await new Promise((resolve) => setImmediate(resolve));
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      expect(notifications.emit.mock.calls[0][0]).toMatchObject({
        type: 'budget.alert',
        organizationId: org.id,
        link: `/apps/${app.slug}`,
      });
    });

    it('says "this month" when the monthly cap is the one reached', async () => {
      const { app } = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT, {
        limits: { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120, dailySpendCapCents: null, monthlySpendCapCents: 100 },
      });
      await spend(app, 1.5);
      const refused = await refusal(post(app.slug));
      expect(refused.body).toMatchObject({ code: 'APP_SPEND_CAP_REACHED', message: 'This app has reached its limit for this month.' });
    });

    it('does not count another app, or spend with no app, against this one', async () => {
      const { app } = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      const other = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      await spend(other.app, 50);
      await post(app.slug);
      expect(runtime.startRun).toHaveBeenCalledTimes(1);
    });

    it('has no cap once the owner clears both spend caps', async () => {
      const { app } = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT, {
        limits: { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120, dailySpendCapCents: null, monthlySpendCapCents: null },
      });
      await spend(app, 500);
      await post(app.slug);
      expect(runtime.startRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('website widget', () => {
    const post = (gatewayId: string, threadId?: string, ip = '203.0.113.1') =>
      widget.postMessage(gatewayId, { message: 'hi', threadId }, req(ip), res());

    it('starts runs with the cost cap, the app stamp, the visitor mark, and files the conversation under the widget', async () => {
      const { app, gateway } = await place(DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET);
      const out = await post(gateway.id);

      const options = runtime.startRun.mock.calls[0][4];
      expect(options).toMatchObject({
        maxCostCents: 50,
        appId: app.id,
        gatewayId: gateway.id,
        metadata: expect.objectContaining({ appVisitor: true, visitorMemory: false, gatewayId: gateway.id }),
      });
      const saved = await runs.findOneByOrFail({ id: out.data.runId });
      const conversation = await conversations.findOneByOrFail({ id: saved.conversationId });
      // What per-app retention finds a conversation by.
      expect(conversation.gatewayId).toBe(gateway.id);
      // A widget visitor has no end-user row; the mark keeps them out of
      // shared memory unless the app opted its visitors in.
      expect(runMayWriteSharedMemory(saved)).toBe(false);
    });

    it('limits each thread to its own share', async () => {
      const { gateway } = await place(DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET);
      for (let i = 0; i < 3; i++) await post(gateway.id, 'thread-a');
      const refused = await refusal(post(gateway.id, 'thread-a'));
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ code: 'VISITOR_RATE_LIMITED' });
      // Another browser is unaffected.
      await post(gateway.id, 'thread-b');
    });

    it('refuses with the plain sentence once the app has spent its day', async () => {
      const { app, gateway } = await place(DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET);
      await spend(app, 6);
      const refused = await refusal(post(gateway.id));
      expect(refused.body).toMatchObject({ code: 'APP_SPEND_CAP_REACHED', message: 'This app has reached its limit for today.' });
      expect(runtime.startRun).not.toHaveBeenCalled();
    });

    it('tells the widget which visitor rights the app grants', async () => {
      const allowed = await place(DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET);
      const denied = await place(DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET, {
        privacy: { visitorCanDelete: false, visitorCanExport: false },
      });
      const on = await widget.widgetConfig(allowed.gateway.id, res());
      const off = await widget.widgetConfig(denied.gateway.id, res());
      expect(on.data).toMatchObject({ visitorCanDelete: true, visitorCanExport: true });
      expect(off.data).toMatchObject({ visitorCanDelete: false, visitorCanExport: false });
    });

    it('lets a visitor download and then delete their own thread, and nobody else', async () => {
      const { gateway } = await place(DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET);
      const mine = await post(gateway.id, 'thread-mine');
      const theirs = await post(gateway.id, 'thread-theirs');
      await events.save(
        events.create({
          organizationId: org.id,
          gatewayId: gateway.id,
          channelType: GatewayType.CHAT_WIDGET,
          direction: 'outbound',
          status: 'processed',
          payload: { kind: 'widget_message', threadId: 'thread-mine', message: 'Hello from the agent' },
        } as any),
      );

      const exported: any = await widget.exportThread(gateway.id, 'thread-mine', req('203.0.113.4'), res());
      expect(exported.threadId).toBe('thread-mine');
      expect(exported.messages.map((m: any) => m.content)).toEqual(['hi']);

      await widget.deleteThread(gateway.id, 'thread-mine');

      expect(await runs.findOneBy({ id: mine.data.runId })).toBeNull();
      const mineRun = runtime.startRun.mock.results[0];
      expect(mineRun).toBeDefined();
      expect(await widget.listMessages(gateway.id, 'thread-mine')).toEqual({ success: true, data: [] });
      // The other browser's thread is untouched.
      expect(await runs.findOneBy({ id: theirs.data.runId })).not.toBeNull();
      const kept = await runs.findOneByOrFail({ id: theirs.data.runId });
      expect(await messages.countBy({ conversationId: kept.conversationId })).toBe(1);
    });

    it('refuses download and delete when the app turned them off', async () => {
      const { gateway } = await place(DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET, {
        privacy: { visitorCanDelete: false, visitorCanExport: false },
      });
      await post(gateway.id, 'thread-x');
      const noExport = await refusal(widget.exportThread(gateway.id, 'thread-x', req('203.0.113.5'), res()));
      const noDelete = await refusal(widget.deleteThread(gateway.id, 'thread-x'));
      expect(noExport).toMatchObject({ status: 403, body: { code: 'VISITOR_RIGHT_DISABLED' } });
      expect(noDelete).toMatchObject({ status: 403, body: { code: 'VISITOR_RIGHT_DISABLED' } });
    });
  });

  describe('messaging channel', () => {
    let update = 1;
    const deliver = (gateway: Gateway, from: string, chat = `chat-${from}`) =>
      channels.handleInboundMessage(gateway, { update_id: update++, text: 'hello', from, chat }, {});

    it('starts runs with the cost cap, app stamp and visitor mark', async () => {
      const { app, gateway } = await place(DistributionTarget.TELEGRAM, GatewayType.TELEGRAM);
      await deliver(gateway, 'alice');
      const options = runtime.startRun.mock.calls[0][4];
      expect(options).toMatchObject({
        maxCostCents: 50,
        appId: app.id,
        gatewayId: gateway.id,
        metadata: expect.objectContaining({ appVisitor: true, visitorMemory: false, channelUserId: 'alice' }),
      });
    });

    it('limits each sender to their own share', async () => {
      const { gateway } = await place(DistributionTarget.TELEGRAM, GatewayType.TELEGRAM, {
        gatewayRateLimit: { enabled: false, perVisitorPerHour: 3 },
      });
      for (let i = 0; i < 4; i++) await deliver(gateway, 'bob', `chat-bob-${i}`);
      expect(runtime.startRun).toHaveBeenCalledTimes(3);
      await deliver(gateway, 'carol');
      expect(runtime.startRun).toHaveBeenCalledTimes(4);
    });

    it('answers with the plain sentence and starts no run once the app has spent its day', async () => {
      const { app, gateway } = await place(DistributionTarget.TELEGRAM, GatewayType.TELEGRAM);
      await spend(app, 5);
      await deliver(gateway, 'dave');
      expect(runtime.startRun).not.toHaveBeenCalled();
      expect(telegram.sendResponse).toHaveBeenCalledWith(
        expect.anything(),
        { text: 'This app has reached its limit for today.' },
        expect.objectContaining({ threadId: 'chat-dave', userId: 'dave' }),
      );
    });

    it('counts spend from any of the app places against the same cap', async () => {
      const web = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      // A second place on the same app: a Telegram channel.
      const gateway = await gateways.save(
        gateways.create({
          organizationId: org.id,
          name: 'tg',
          description: '',
          type: GatewayType.TELEGRAM,
          agentId: agent.id,
          status: GatewayStatus.ACTIVE,
          endpoint: `/apps/${web.app.slug}/telegram`,
          visibility: 'org',
          configuration: { appId: web.app.id },
          rateLimitConfig: { enabled: false },
        } as DeepPartial<Gateway>),
      );
      await distributions.save(
        distributions.create({ organizationId: org.id, appId: web.app.id, target: DistributionTarget.TELEGRAM, status: DistributionStatus.LIVE, gatewayId: gateway.id, configuration: {} } as DeepPartial<AppDistribution>),
      );
      await spend(web.app, 5);
      await deliver(gateway, 'erin');
      expect(runtime.startRun).not.toHaveBeenCalled();
    });
  });

  describe('A2A', () => {
    const call = (gateway: Gateway, keyId: string, ip = '192.0.2.1') => {
      const request = req(ip, { method: 'POST', path: `/${org.slug}/a2a-x`, __auth: { isValid: true, metadata: { keyId } } });
      const r = res();
      const body = {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'ping' }] }, configuration: { returnImmediately: true } },
      };
      return delegation.handleGatewayRequest(org, gateway, org.slug, 'a2a-x', request, r, body).then(() => r);
    };

    it('starts each task with the cost cap, the app stamp and the visitor mark', async () => {
      const { app, gateway } = await place(DistributionTarget.A2A, GatewayType.A2A, {
        gatewayRateLimit: { enabled: false, perVisitorPerHour: 3, perIpPerHour: 100 },
      });
      const r = await call(gateway, 'key-1');
      expect(r.body?.error).toBeUndefined();
      expect(runtime.startRun.mock.calls[0][4]).toMatchObject({
        maxCostCents: 50,
        appId: app.id,
        gatewayId: gateway.id,
        metadata: expect.objectContaining({ appVisitor: true, visitorMemory: false }),
      });
    });

    it('gives each caller key its own share', async () => {
      const { gateway } = await place(DistributionTarget.A2A, GatewayType.A2A, {
        gatewayRateLimit: { enabled: false, perVisitorPerHour: 3, perIpPerHour: 100 },
      });
      for (let i = 0; i < 3; i++) await call(gateway, 'key-a');
      const refused = await refusal(call(gateway, 'key-a'));
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ code: 'VISITOR_RATE_LIMITED', bucket: { scope: 'user' } });
      await call(gateway, 'key-b');
      expect(runtime.startRun).toHaveBeenCalledTimes(4);
    });

    it('refuses a new task once the app has spent its day', async () => {
      const { app, gateway } = await place(DistributionTarget.A2A, GatewayType.A2A, {
        gatewayRateLimit: { enabled: false, perVisitorPerHour: 30, perIpPerHour: 100 },
      });
      await spend(app, 5);
      const refused = await refusal(call(gateway, 'key-c'));
      expect(refused).toMatchObject({ status: 429, body: { code: 'APP_SPEND_CAP_REACHED', message: 'This app has reached its limit for today.' } });
      expect(runtime.startRun).not.toHaveBeenCalled();
    });
  });

  describe('the owner', () => {
    it('sees what the app spent today and this month against its caps', async () => {
      const { app } = await place(DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      await spend(app, 1.25);
      const status = await places.spendStatus(app);
      expect(status).toMatchObject({
        caps: { dailyCents: 500, monthlyCents: 5000 },
        todayCents: 125,
        monthCents: 125,
        reached: null,
      });
      await spend(app, 4);
      expect((await places.spendStatus(app)).reached).toBe('day');
    });
  });
});
