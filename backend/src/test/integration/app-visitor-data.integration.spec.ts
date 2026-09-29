import { ExecutionContext, HttpException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, DeepPartial, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Organization } from '../../entities/organization.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentApp, AppAuthMode } from '../../entities/agent-app.entity';
import { AppDistribution, DistributionStatus, DistributionTarget } from '../../entities/agent-app-distribution.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { ChannelEvent } from '../../entities/channel-event.entity';
import { EndUser } from '../../entities/end-user.entity';
import { AgentFile } from '../../entities/file.entity';
import { AuditAction, AuditLog, AuditResource } from '../../entities/audit-log.entity';
import { User } from '../../entities/user.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { defaultLimitsFor } from '../../modules/agent-apps/agent-app.rules';
import { rateLimitFor } from '../../modules/agent-apps/distribution-publish';
import { AgentAppsService } from '../../modules/agent-apps/agent-apps.service';
import { AgentAppsController } from '../../modules/agent-apps/agent-apps.controller';
import { AppBuildsService } from '../../modules/agent-apps/app-builds.service';
import { AppVisitorRequestsService, DataRequestCaller, subjectRef } from '../../modules/agent-apps/app-visitor-requests.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { GatewayRateLimitService } from '../../modules/gateways/gateway-rate-limit.service';
import { GatewayAppLinkService } from '../../modules/gateways/gateway-app-link.service';
import { AppPlacePolicyService } from '../../modules/gateways/app-place-policy.service';
import { AppVisitorDataService } from '../../modules/gateways/app-visitor-data.service';
import { HostedChatService } from '../../modules/gateways/channels/hosted-chat.service';
import { HostedChatController } from '../../modules/gateways/channels/hosted-chat.controller';
import { ChannelGatewayService } from '../../modules/gateways/channels/channel-gateway.service';
import { ChannelWidgetController } from '../../modules/gateways/channels/channel-widget.controller';
import { ChatWidgetAdapter } from '../../modules/gateways/channels/adapters/chat-widget.adapter';
import { UnifiedGatewayDelegation } from '../../modules/gateways/unified-gateway-delegation.helper';
import { A2AServerService } from '../../modules/a2a/a2a-server.service';
import { FakeRedisWithWindows } from '../fake-redis-windows';
import { listenOnLoopback } from '../http';
import { ensureSchema } from './isolated-schema.helper';

/**
 * An owner answering one person's data request, against a real Postgres.
 *
 * People reach an app on the web chat, the website widget, a messaging
 * channel or A2A. Each place is driven through its real entry point, so
 * the identity an owner later looks the person up by (a visitor email, a
 * widget thread, a channel sender id, an A2A key) is the one the place
 * really stamped. Each person also gets a memory their run wrote and a
 * file it produced. Then: lookup by each identity kind, export contents,
 * erasure of exactly that person in exactly that app (another person,
 * another app and another organization untouched), 404 for a member and
 * for another organization, and the audit rows.
 *
 * The runtime is the one double, as in app-place-limits: it writes the
 * rows startRun would.
 */
const run = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'app_visitor_data_test';

run('answering a data request for one person (real Postgres)', () => {
  jest.setTimeout(90_000);

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
  let endUsers: Repository<EndUser>;
  let files: Repository<AgentFile>;
  let audits: Repository<AuditLog>;

  let storage: { delete: jest.Mock };
  let visitorData: AppVisitorDataService;
  let hosted: HostedChatService;
  let hostedChat: HostedChatController;
  let channels: ChannelGatewayService;
  let widget: ChannelWidgetController;
  let delegation: UnifiedGatewayDelegation;
  let requests: AppVisitorRequestsService;
  let appsService: AgentAppsService;
  let runtime: { startRun: jest.Mock; sendInput: jest.Mock; getRunEmitter: jest.Mock; getRun: jest.Mock };

  let orgA: Organization;
  let orgB: Organization;
  let agentA: Agent;
  let agentB: Agent;

  const OWNER_ID = randomUUID();
  const owner = (organizationId: string): DataRequestCaller => ({ userId: OWNER_ID, organizationId, role: OrganizationRole.OWNER });

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

  async function newApp(org: Organization): Promise<AgentApp> {
    const slug = `app-${randomUUID().slice(0, 8)}`;
    return apps.save(
      apps.create({
        organizationId: org.id,
        name: `App ${slug}`,
        slug,
        agentIds: [org.id === orgA.id ? agentA.id : agentB.id],
        authMode: AppAuthMode.PUBLIC_LINK,
        branding: {},
        capabilities: {},
        limits: { ...defaultLimitsFor(AppAuthMode.PUBLIC_LINK), perUserRateLimit: 100, perIpRateLimit: 1000 },
        privacy: null,
      }),
    );
  }

  /** A published place of `app`: its gateway and distribution rows. */
  async function addPlace(app: AgentApp, target: DistributionTarget, type: GatewayType): Promise<Gateway> {
    const agentId = app.agentIds[0];
    const gateway = await gateways.save(
      gateways.create({
        organizationId: app.organizationId,
        name: `${app.name} (${target})`,
        description: '',
        type,
        agentId,
        status: GatewayStatus.ACTIVE,
        endpoint: `/apps/${app.slug}/${target}`,
        visibility: 'org',
        configuration: {
          appId: app.id,
          authMode: 'public_link',
          ...(target === DistributionTarget.WEB ? { hostedChat: { slug: app.slug } } : {}),
        },
        rateLimitConfig: { ...rateLimitFor(app, target), enabled: false },
      } as DeepPartial<Gateway>),
    );
    await distributions.save(
      distributions.create({
        organizationId: app.organizationId,
        appId: app.id,
        target,
        status: DistributionStatus.LIVE,
        gatewayId: gateway.id,
        configuration: {},
      } as DeepPartial<AppDistribution>),
    );
    return gateway;
  }

  /** A memory the run wrote and a file it produced, as the runtime would leave them. */
  async function enrich(runRow: AgentRun, label: string): Promise<void> {
    await ds.query(
      `INSERT INTO memories (id, mode, scope_type, scope_id, content, content_bytes, tier, valid_from, provenance)
       VALUES ($1, 'memory', 'workspace', $2, $3, $4, 'project', now(), $5)`,
      [
        randomUUID(),
        runRow.organizationId,
        `Remembered for ${label}`,
        Buffer.byteLength(`Remembered for ${label}`),
        JSON.stringify({ agent_id: runRow.agentId, session_id: runRow.id, collab_id: null, model: null, provider: null, tool_chain: ['store_memory'], created_by: 'agent', source_backend: 'almyty-native' }),
      ],
    );
    await files.save(
      files.create({
        organizationId: runRow.organizationId,
        agentId: runRow.agentId,
        runId: runRow.id,
        name: `${label}.txt`,
        mimeType: 'text/plain',
        size: 12,
        storageKey: `files/${label}-${runRow.id}`,
      }),
    );
  }

  const memoriesOf = async (runId: string): Promise<number> =>
    Number((await ds.query(`SELECT COUNT(*)::int AS n FROM memories WHERE provenance->>'session_id' = $1`, [runId]))[0].n);

  /** Everything a run left, counted. */
  async function footprintOf(runId: string) {
    const row = await runs.findOneBy({ id: runId });
    return {
      run: row ? 1 : 0,
      messages: row?.conversationId ? await messages.countBy({ conversationId: row.conversationId }) : 0,
      memories: await memoriesOf(runId),
      files: await files.countBy({ runId }),
      events: await events.countBy({ runId }),
    };
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
    endUsers = ds.getRepository(EndUser);
    files = ds.getRepository(AgentFile);
    audits = ds.getRepository(AuditLog);

    const agentFor = (org: Organization) =>
      agents.save(
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
    orgA = await orgs.save(orgs.create({ name: `Data A ${randomUUID()}`, slug: `data-a-${randomUUID().slice(0, 8)}` }));
    orgB = await orgs.save(orgs.create({ name: `Data B ${randomUUID()}`, slug: `data-b-${randomUUID().slice(0, 8)}` }));
    agentA = await agentFor(orgA);
    agentB = await agentFor(orgB);
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(() => {
    const redis = new FakeRedisWithWindows();
    const rateLimit = new GatewayRateLimitService(redis as any);
    const appLink = new GatewayAppLinkService(distributions);
    const places = new AppPlacePolicyService(appLink, runs, { emit: jest.fn(async () => undefined) } as any, redis as any);
    storage = { delete: jest.fn(async () => undefined) };
    visitorData = new AppVisitorDataService(runs, storage as any);

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

    hosted = new HostedChatService(gateways, endUsers, conversations, messages, runs, undefined, undefined, appLink, visitorData);
    hostedChat = new HostedChatController(hosted, rateLimit, runtime as any, places);

    // One platform double for every messaging channel: the sender is
    // `from`, the thread `chat`, as the real adapters normalise them.
    const platform = {
      type: 'platform',
      extractTenantId: () => null,
      verifyWebhook: async () => true,
      deliveryId: (body: any) => String(body.update_id),
      normalizeInbound: (body: any) => ({ text: body.text, userId: body.from, threadId: body.chat, metadata: {} }),
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
      // slack, discord, telegram, whatsapp, whatsapp cloud, sms, email
      stub, stub, platform as any, stub, stub, platform as any, platform as any,
      // webhook, google chat, teams, signal, matrix, irc
      stub, stub, stub, stub, stub, stub,
      undefined,
      undefined,
      rateLimit,
      undefined,
      undefined,
      places,
      visitorData,
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

    appsService = new AgentAppsService(apps, distributions, agents, ds.getRepository(AgentExecution), runs, {} as any);
    requests = new AppVisitorRequestsService(appsService, visitorData, new AuditLogService(audits, ds.getRepository(User)));
  });

  // -- The places, driven through their real entry points ------------------

  let update = 1;
  /** A web-chat visitor with an email address, who says hello. */
  async function webVisitor(app: AgentApp, gateway: Gateway, email: string): Promise<{ endUser: EndUser; runId: string }> {
    const { endUser, issuedSessionKey } = await hosted.resolveEndUser(gateway, undefined, '198.51.100.7');
    await endUsers.update({ id: endUser.id }, { email, authProvider: 'email_otp', externalId: email });
    const out = await hostedChat.postMessage(
      app.slug,
      { message: 'hello' },
      req('198.51.100.7', { cookies: { [HostedChatService.SESSION_COOKIE]: issuedSessionKey } }),
      res(),
    );
    return { endUser, runId: (out as any).data?.runId ?? (out as any).runId };
  }

  async function widgetVisitor(gateway: Gateway, threadId: string): Promise<string> {
    const out = await widget.postMessage(gateway.id, { message: 'hello', threadId }, req('203.0.113.9'), res());
    await events.save(
      events.create({
        organizationId: gateway.organizationId,
        gatewayId: gateway.id,
        channelType: GatewayType.CHAT_WIDGET,
        direction: 'outbound',
        status: 'processed',
        runId: out.data.runId,
        payload: { kind: 'widget_message', threadId, message: 'Hello from the agent' },
      } as any),
    );
    return out.data.runId;
  }

  async function channelSender(gateway: Gateway, from: string): Promise<string> {
    await channels.handleInboundMessage(gateway, { update_id: update++, text: 'hello', from, chat: `chat-${from}` }, {});
    const row = await runs
      .createQueryBuilder('run')
      .where("run.metadata->>'gatewayId' = :g", { g: gateway.id })
      .andWhere("run.metadata->>'channelUserId' = :f", { f: from })
      .orderBy('run.createdAt', 'DESC')
      .getOneOrFail();
    return row.id;
  }

  async function a2aCaller(gateway: Gateway, keyId: string): Promise<string> {
    const org = gateway.organizationId === orgA.id ? orgA : orgB;
    const r = res();
    const before = runtime.startRun.mock.results.length;
    await delegation.handleGatewayRequest(
      org,
      gateway,
      org.slug,
      'a2a-x',
      req('192.0.2.1', { method: 'POST', path: `/${org.slug}/a2a-x`, __auth: { isValid: true, metadata: { keyId } } }),
      r,
      {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hello' }] }, configuration: { returnImmediately: true } },
      },
    );
    expect(r.body?.error).toBeUndefined();
    const started: AgentRun = await runtime.startRun.mock.results[before].value;
    return started.id;
  }

  /** Every run left by `person` in `app`, and the neighbours that must survive. */
  interface Scene {
    app: AgentApp;
    web: Gateway;
    widget: Gateway;
    telegram: Gateway;
    sms: Gateway;
    email: Gateway;
    a2a: Gateway;
  }

  async function scene(): Promise<Scene> {
    const app = await newApp(orgA);
    return {
      app,
      web: await addPlace(app, DistributionTarget.WEB, GatewayType.HOSTED_CHAT),
      widget: await addPlace(app, DistributionTarget.WIDGET, GatewayType.CHAT_WIDGET),
      telegram: await addPlace(app, DistributionTarget.TELEGRAM, GatewayType.TELEGRAM),
      sms: await addPlace(app, DistributionTarget.SMS, GatewayType.SMS),
      email: await addPlace(app, DistributionTarget.EMAIL, GatewayType.EMAIL),
      a2a: await addPlace(app, DistributionTarget.A2A, GatewayType.A2A),
    };
  }

  // -- Lookup ----------------------------------------------------------------

  describe('lookup', () => {
    it('finds a person by what identifies them on each kind of place', async () => {
      const s = await scene();
      const web = await webVisitor(s.app, s.web, 'wendy@example.com');
      const widgetRun = await widgetVisitor(s.widget, 'thread-wanda');
      const tgRun = await channelSender(s.telegram, 'tg-1001');
      const smsRun = await channelSender(s.sms, 'whatsapp:+14155550100');
      const emailRun = await channelSender(s.email, 'Ann Example <ann@example.com>');
      const a2aRun = await a2aCaller(s.a2a, 'key-alpha');
      for (const [id, label] of [[web.runId, 'web'], [widgetRun, 'widget'], [tgRun, 'tg'], [smsRun, 'sms'], [emailRun, 'email'], [a2aRun, 'a2a']]) {
        await enrich(await runs.findOneByOrFail({ id }), label);
      }

      // [place, what the owner knows, the run it must find]
      const cases: Array<[DistributionTarget, string, string]> = [
        [DistributionTarget.WEB, 'WENDY@example.com', web.runId],
        [DistributionTarget.WEB, web.endUser.id, web.runId],
        [DistributionTarget.WIDGET, 'thread-wanda', widgetRun],
        [DistributionTarget.TELEGRAM, 'tg-1001', tgRun],
        // A phone number however the person writes it, country code included.
        [DistributionTarget.SMS, '+1 (415) 555-0100', smsRun],
        // The address inside a "Name <address>" sender, any case.
        [DistributionTarget.EMAIL, 'ANN@example.com', emailRun],
        // The key id bare, or as the place stamped it.
        [DistributionTarget.A2A, 'key-alpha', a2aRun],
        [DistributionTarget.A2A, 'key:key-alpha', a2aRun],
      ];
      for (const [place, id, runId] of cases) {
        const summary = await requests.lookup(owner(orgA.id), s.app.slug, { place, id });
        // Stored widget replies and channel deliveries: whatever the place
        // recorded against the run.
        const storedReplies = await events.countBy({ runId });
        expect({ place, id, summary }).toMatchObject({
          summary: { found: true, conversations: 1, messages: 1, memories: 1, files: 1, runs: 1, storedReplies },
        });
        if (place !== DistributionTarget.WEB && place !== DistributionTarget.A2A) expect(storedReplies).toBeGreaterThan(0);
        expect(summary.firstAt).toEqual(expect.any(String));
        expect(summary.recent).toHaveLength(1);
      }
    });

    it('finds nothing for someone who never used the place, or who used another one', async () => {
      const s = await scene();
      await channelSender(s.telegram, 'tg-5005');
      for (const [place, id] of [
        [DistributionTarget.TELEGRAM, 'tg-9999'],
        // The same id on a different place of the same app is someone else.
        [DistributionTarget.SMS, 'tg-5005'],
        [DistributionTarget.WEB, 'nobody@example.com'],
        [DistributionTarget.WIDGET, 'thread-nobody'],
        [DistributionTarget.A2A, 'key-nobody'],
      ] as const) {
        expect(await requests.lookup(owner(orgA.id), s.app.slug, { place, id })).toMatchObject({ found: false, runs: 0, conversations: 0 });
      }
    });

    it('stamps each A2A run with the caller credential it came in with', async () => {
      const s = await scene();
      const runId = await a2aCaller(s.a2a, 'key-stamp');
      const row = await runs.findOneByOrFail({ id: runId });
      expect(row.metadata).toMatchObject({ a2aCaller: 'key:key-stamp', gatewayId: s.a2a.id });
    });
  });

  // -- Export ----------------------------------------------------------------

  describe('export', () => {
    it('hands over the transcript, memories, files, stored replies and runs, and no raw platform payload', async () => {
      const s = await scene();
      const runId = await channelSender(s.telegram, 'tg-2002');
      await enrich(await runs.findOneByOrFail({ id: runId }), 'export');

      const data: any = await requests.export(owner(orgA.id), s.app.slug, { place: DistributionTarget.TELEGRAM, id: 'tg-2002' });

      expect(data.app).toBe(s.app.name);
      expect(data.place).toBe('telegram');
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].messages).toEqual([expect.objectContaining({ role: 'user', content: 'hello' })]);
      expect(data.memories).toEqual([expect.objectContaining({ content: 'Remembered for export' })]);
      expect(data.files).toEqual([expect.objectContaining({ name: 'export.txt', mimeType: 'text/plain' })]);
      expect(data.runs).toEqual([expect.objectContaining({ id: runId })]);
      // Deliveries are listed by date; an inbound one's raw body (the
      // operator's bot and workspace ids) is not reproduced.
      expect(data.storedReplies).toHaveLength(await events.countBy({ runId }));
      expect(data.storedReplies).toContainEqual({ createdAt: expect.any(Date), direction: 'inbound' });
      expect(JSON.stringify(data)).not.toContain('update_id');
    });

    it('writes an audit row with who, whom (hashed), what and the counts, and no personal data', async () => {
      const s = await scene();
      const runId = await channelSender(s.telegram, 'tg-3003');
      await requests.export(owner(orgA.id), s.app.slug, { place: DistributionTarget.TELEGRAM, id: 'tg-3003' });

      const rows = await audits.findBy({ organizationId: orgA.id, resourceId: s.app.id, action: AuditAction.VISITOR_DATA_EXPORT });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: OWNER_ID,
        resourceType: AuditResource.APP,
        resourceName: s.app.name,
        details: {
          request: 'export',
          place: 'telegram',
          kind: 'channel',
          subject: subjectRef(orgA.id, 'telegram', 'tg-3003'),
          counts: { conversations: 1, messages: 1, runs: 1, memories: 0, files: 0, storedReplies: await events.countBy({ runId }) },
        },
      });
      expect(JSON.stringify(rows[0].details)).not.toContain('tg-3003');
    });
  });

  // -- Erasure ---------------------------------------------------------------

  describe('erase', () => {
    it('removes everything tied to the person in this app and nothing else', async () => {
      const s = await scene();
      const target = await channelSender(s.telegram, 'tg-1001');
      const neighbour = await channelSender(s.telegram, 'tg-4004');
      // The same sender id on another app of the organization, and on an
      // app of another organization.
      const otherApp = await newApp(orgA);
      const otherAppRun = await channelSender(await addPlace(otherApp, DistributionTarget.TELEGRAM, GatewayType.TELEGRAM), 'tg-1001');
      const otherOrgApp = await newApp(orgB);
      const otherOrgRun = await channelSender(await addPlace(otherOrgApp, DistributionTarget.TELEGRAM, GatewayType.TELEGRAM), 'tg-1001');
      for (const id of [target, neighbour, otherAppRun, otherOrgRun]) await enrich(await runs.findOneByOrFail({ id }), id);
      const conversationId = (await runs.findOneByOrFail({ id: target })).conversationId;
      // A child run the person's run started.
      const child = await runs.save(
        runs.create({
          agentId: agentA.id,
          organizationId: orgA.id,
          parentRunId: target,
          mode: AgentMode.AUTONOMOUS,
          status: AgentRunStatus.COMPLETED,
          input: { text: 'sub-task' },
          steps: [],
        } as DeepPartial<AgentRun>),
      );
      await enrich(child, 'child');
      const neighbours = [neighbour, otherAppRun, otherOrgRun];
      const kept = await Promise.all(neighbours.map((id) => footprintOf(id)));
      const targetEvents = await events.countBy({ runId: target });
      expect(targetEvents).toBeGreaterThan(0);

      const removed = await requests.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.TELEGRAM, id: 'tg-1001' });

      expect(removed).toMatchObject({ runs: 2, conversations: 1, messages: 1, memories: 2, files: 2, storedReplies: targetEvents });
      expect(await footprintOf(target)).toEqual({ run: 0, messages: 0, memories: 0, files: 0, events: 0 });
      expect(await footprintOf(child.id)).toEqual({ run: 0, messages: 0, memories: 0, files: 0, events: 0 });
      expect(await conversations.findOneBy({ id: conversationId })).toBeNull();
      expect(storage.delete).toHaveBeenCalledWith(`files/${target}-${target}`);
      expect(storage.delete).toHaveBeenCalledTimes(2);
      // Another person, another app, another organization: untouched.
      expect(kept.every((k) => k.run === 1 && k.messages === 1 && k.memories === 1 && k.files === 1 && k.events > 0)).toBe(true);
      expect(await Promise.all(neighbours.map((id) => footprintOf(id)))).toEqual(kept);
      expect(await requests.lookup(owner(orgA.id), s.app.slug, { place: DistributionTarget.TELEGRAM, id: 'tg-1001' })).toMatchObject({
        found: false,
      });
    });

    it('erases a person on each other kind of place, and their neighbours stay', async () => {
      const s = await scene();
      const web = await webVisitor(s.app, s.web, 'wendy@example.com');
      const webOther = await webVisitor(s.app, s.web, 'walt@example.com');
      const widgetRun = await widgetVisitor(s.widget, 'thread-wanda');
      const widgetOther = await widgetVisitor(s.widget, 'thread-other');
      const smsRun = await channelSender(s.sms, '+14155550100');
      const smsOther = await channelSender(s.sms, '+14155550199');
      const emailRun = await channelSender(s.email, 'Ann <ann@example.com>');
      const emailOther = await channelSender(s.email, 'bob@example.com');
      const a2aRun = await a2aCaller(s.a2a, 'key-alpha');
      const a2aOther = await a2aCaller(s.a2a, 'key-beta');
      const all = [web.runId, webOther.runId, widgetRun, widgetOther, smsRun, smsOther, emailRun, emailOther, a2aRun, a2aOther];
      for (const id of all) await enrich(await runs.findOneByOrFail({ id }), id);

      await requests.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.WEB, id: 'wendy@example.com' });
      await requests.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.WIDGET, id: 'thread-wanda' });
      await requests.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.SMS, id: '+1 415-555-0100' });
      await requests.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.EMAIL, id: 'ann@example.com' });
      await requests.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.A2A, id: 'key-alpha' });

      const erased = { web: web.runId, widget: widgetRun, sms: smsRun, email: emailRun, a2a: a2aRun };
      for (const [place, id] of Object.entries(erased)) {
        expect({ place, left: await footprintOf(id) }).toEqual({ place, left: { run: 0, messages: 0, memories: 0, files: 0, events: 0 } });
      }
      expect(await endUsers.findOneBy({ id: web.endUser.id })).toBeNull();
      // What the widget still holds is the other thread's, all of it.
      const otherThreadEvents = await events.countBy({ runId: widgetOther });
      expect(otherThreadEvents).toBeGreaterThan(0);
      expect(await events.countBy({ gatewayId: s.widget.id })).toBe(otherThreadEvents);
      for (const id of [webOther.runId, widgetOther, smsOther, emailOther, a2aOther]) {
        expect(await footprintOf(id)).toMatchObject({ run: 1, messages: 1, memories: 1, files: 1 });
      }
      expect(await endUsers.findOneBy({ id: webOther.endUser.id })).not.toBeNull();
    });

    it('writes one audit row per erasure, in the erasure transaction, with the counts', async () => {
      const s = await scene();
      await channelSender(s.telegram, 'tg-6006');
      const removed = await requests.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.TELEGRAM, id: 'tg-6006' });
      const rows = await audits.findBy({ organizationId: orgA.id, resourceId: s.app.id, action: AuditAction.VISITOR_DATA_ERASE });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: OWNER_ID,
        resourceType: AuditResource.APP,
        details: { request: 'erase', place: 'telegram', kind: 'channel', subject: subjectRef(orgA.id, 'telegram', 'tg-6006'), counts: removed },
      });
      expect(JSON.stringify(rows[0].details)).not.toContain('tg-6006');
    });

    it('rolls the erasure back when its audit row cannot be written', async () => {
      const s = await scene();
      const runId = await channelSender(s.telegram, 'tg-7007');
      const before = await footprintOf(runId);
      const failing = new AppVisitorRequestsService(appsService, visitorData, {
        logInTransaction: async () => {
          throw new Error('audit store down');
        },
        publishCommitted: () => undefined,
      } as any);
      await expect(failing.erase(owner(orgA.id), s.app.slug, { place: DistributionTarget.TELEGRAM, id: 'tg-7007' })).rejects.toThrow(
        'audit store down',
      );
      expect(await footprintOf(runId)).toEqual(before);
    });

    it('the web chat own "delete my data" erases the same scope: memories and files too', async () => {
      const s = await scene();
      const mine = await webVisitor(s.app, s.web, 'self@example.com');
      await enrich(await runs.findOneByOrFail({ id: mine.runId }), 'self');
      const endUser = await endUsers.findOneByOrFail({ id: mine.endUser.id });

      await hosted.deleteVisitor(s.web, endUser);

      expect(await footprintOf(mine.runId)).toMatchObject({ run: 0, memories: 0, files: 0 });
      expect(await endUsers.findOneBy({ id: endUser.id })).toBeNull();
    });

    it('the widget own delete erases the same scope: memories and files too', async () => {
      const s = await scene();
      const runId = await widgetVisitor(s.widget, 'thread-self');
      await enrich(await runs.findOneByOrFail({ id: runId }), 'widget-self');

      await widget.deleteThread(s.widget.id, 'thread-self');

      expect(await footprintOf(runId)).toMatchObject({ run: 0, messages: 0, memories: 0, files: 0, events: 0 });
    });
  });

  // -- Who may ---------------------------------------------------------------

  describe('who may answer', () => {
    it('refuses a member, a viewer and another organization with the same 404, and changes nothing', async () => {
      const s = await scene();
      const runId = await channelSender(s.telegram, 'tg-8008');
      const subject = { place: DistributionTarget.TELEGRAM, id: 'tg-8008' };
      const callers: DataRequestCaller[] = [
        { userId: randomUUID(), organizationId: orgA.id, role: OrganizationRole.MEMBER },
        { userId: randomUUID(), organizationId: orgA.id, role: OrganizationRole.VIEWER },
        { userId: randomUUID(), organizationId: orgB.id, role: OrganizationRole.OWNER },
      ];
      for (const caller of callers) {
        for (const call of [requests.lookup, requests.export, requests.erase]) {
          expect(await refusal(call.call(requests, caller, s.app.slug, subject))).toMatchObject({ status: 404 });
        }
      }
      expect(await footprintOf(runId)).toMatchObject({ run: 1, messages: 1 });
      expect(await audits.countBy({ resourceId: s.app.id })).toBe(0);
    });

    it('404s a place the app is not on, and 400s a place nobody talks to', async () => {
      const app = await newApp(orgA);
      await addPlace(app, DistributionTarget.WEB, GatewayType.HOSTED_CHAT);
      expect(await refusal(requests.lookup(owner(orgA.id), app.slug, { place: DistributionTarget.SLACK, id: 'U1' }))).toMatchObject({
        status: 404,
      });
      expect(await refusal(requests.lookup(owner(orgA.id), app.slug, { place: DistributionTarget.DESKTOP, id: 'x' }))).toMatchObject({
        status: 400,
      });
    });

    describe('over HTTP, through the real role guard', () => {
      let http: INestApplication;
      let caller: any;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [AgentAppsController],
          providers: [
            { provide: AgentAppsService, useValue: appsService },
            { provide: AppBuildsService, useValue: {} },
            { provide: AppVisitorRequestsService, useValue: requests },
          ],
        })
          .overrideGuard(JwtAuthGuard)
          .useValue({
            canActivate: (ctx: ExecutionContext) => {
              ctx.switchToHttp().getRequest().user = caller;
              return true;
            },
          })
          .compile();
        http = moduleRef.createNestApplication();
        http.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
        await listenOnLoopback(http);
      });

      afterEach(async () => {
        await http?.close();
      });

      const as = (organizationId: string, role: OrganizationRole) => ({
        id: randomUUID(),
        currentOrganizationId: organizationId,
        organizationMemberships: [{ organizationId, role, isActive: true, inviteAccepted: true }],
      });

      it('answers an owner, and gives a member and another organization the 404 an unknown app gets', async () => {
        const s = await scene();
        await channelSender(s.telegram, 'tg-9009');
        const body = { place: 'telegram', id: 'tg-9009' };

        caller = as(orgA.id, OrganizationRole.ADMIN);
        const found = await request(http.getHttpServer()).post(`/apps/${s.app.slug}/visitor-data/lookup`).send(body);
        expect(found.status).toBe(200);
        expect(found.body.data).toMatchObject({ found: true, runs: 1 });

        const exported = await request(http.getHttpServer()).post(`/apps/${s.app.slug}/visitor-data/export`).send(body);
        expect(exported.status).toBe(200);
        expect(exported.headers['content-disposition']).toContain('attachment');

        caller = as(orgA.id, OrganizationRole.MEMBER);
        for (const path of ['lookup', 'export', 'erase']) {
          const refused = await request(http.getHttpServer()).post(`/apps/${s.app.slug}/visitor-data/${path}`).send(body);
          expect({ path, status: refused.status }).toEqual({ path, status: 404 });
        }
        caller = as(orgB.id, OrganizationRole.OWNER);
        for (const path of ['lookup', 'export', 'erase']) {
          const refused = await request(http.getHttpServer()).post(`/apps/${s.app.slug}/visitor-data/${path}`).send(body);
          expect({ path, status: refused.status }).toEqual({ path, status: 404 });
        }

        caller = as(orgA.id, OrganizationRole.OWNER);
        const erased = await request(http.getHttpServer()).post(`/apps/${s.app.slug}/visitor-data/erase`).send(body);
        expect(erased.status).toBe(200);
        expect(erased.body.data).toMatchObject({ runs: 1, conversations: 1 });
      });

      it('refuses an unknown place and extra fields at the door', async () => {
        const s = await scene();
        caller = as(orgA.id, OrganizationRole.OWNER);
        const bad = await request(http.getHttpServer()).post(`/apps/${s.app.slug}/visitor-data/lookup`).send({ place: 'fax', id: 'x' });
        expect(bad.status).toBe(400);
        const extra = await request(http.getHttpServer())
          .post(`/apps/${s.app.slug}/visitor-data/lookup`)
          .send({ place: 'telegram', id: 'x', organizationId: orgB.id });
        expect(extra.status).toBe(400);
      });
    });
  });
});
