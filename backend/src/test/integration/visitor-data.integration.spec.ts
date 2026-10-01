import { ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, DeepPartial, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Organization } from '../../entities/organization.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import {
  AgentChannel,
  ChannelStatus,
  ChannelType,
  VisitorAuthMode,
} from '../../entities/agent-channel.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { ChannelEvent } from '../../entities/channel-event.entity';
import { EndUser } from '../../entities/end-user.entity';
import { AgentFile } from '../../entities/file.entity';
import { AuditAction, AuditLog } from '../../entities/audit-log.entity';
import { Tool, ToolType } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { MemoryExpiry } from '../../modules/memory/canonical/memory-expiry.entity';
import { MemoryAccountsService } from '../../modules/memory/canonical/memory-accounts.service';
import { visitorScopeId } from '../../modules/memory/canonical/canonical-memory.helpers';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { defaultLimitsFor } from '../../modules/agent-channels/channel-rules';
import { rateLimitFor } from '../../modules/agent-channels/channel-publish';
import { AgentChannelsService } from '../../modules/agent-channels/agent-channels.service';
import { VisitorDataRequestsService } from '../../modules/agent-channels/visitor-data-requests.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { FilesService } from '../../modules/files/files.service';
import { GatewayRateLimitService } from '../../modules/gateways/gateway-rate-limit.service';
import { ChannelLinkService } from '../../modules/gateways/channel-link.service';
import { ChannelPolicyService } from '../../modules/gateways/channel-policy.service';
import { VisitorDataService } from '../../modules/gateways/visitor-data.service';
import { subjectRef } from '../../modules/gateways/visitor-data-audit';
import { HostedChatService } from '../../modules/gateways/channels/hosted-chat.service';
import { HostedChatController } from '../../modules/gateways/channels/hosted-chat.controller';
import { ChannelGatewayService } from '../../modules/gateways/channels/channel-gateway.service';
import { ChannelWidgetController } from '../../modules/gateways/channels/channel-widget.controller';
import { ChatWidgetAdapter } from '../../modules/gateways/channels/adapters/chat-widget.adapter';
import { UnifiedGatewayDelegation } from '../../modules/gateways/unified-gateway-delegation.helper';
import { A2AServerService } from '../../modules/a2a/a2a-server.service';
import { FakeRedisWithWindows } from '../fake-redis-windows';
import { ensureSchema } from './isolated-schema.helper';

/**
 * A person's data on an agent's channels, against a real Postgres: what the
 * visitor can see, download and erase themselves, and what the agent's owner
 * can look up, export and erase when the person asks them.
 *
 * Every person reaches the agent through the channel's real entry point
 * (the web chat, the website widget, Telegram, SMS, A2A), so the identity
 * the owner later looks them up by is the one the channel really stamped.
 * Each of their runs then leaves what a real run leaves: a memory in the
 * visitor's own memory or written by the run elsewhere, a memory kept in an
 * outside memory service, a file sent in the conversation, a file the run
 * produced, an upload not sent yet, a tool call, a child run.
 *
 * Alongside each person there is another person on the same channel, the
 * same identifier on another agent of the same organization, and the same
 * identifier in another organization. None of them may be touched.
 *
 * The runtime is the one double, as in channel-limits: it writes the rows
 * startRun would.
 */
const run = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'visitor_data_test';

run('visitor data: self-service and owner data requests (real Postgres)', () => {
  jest.setTimeout(120_000);

  let ds: DataSource;
  let orgs: Repository<Organization>;
  let agents: Repository<Agent>;
  let channelRows: Repository<AgentChannel>;
  let gateways: Repository<Gateway>;
  let runs: Repository<AgentRun>;
  let conversations: Repository<Conversation>;
  let messages: Repository<Message>;
  let events: Repository<ChannelEvent>;
  let endUsers: Repository<EndUser>;
  let files: Repository<AgentFile>;
  let audits: Repository<AuditLog>;
  let expiries: Repository<MemoryExpiry>;

  let storage: { delete: jest.Mock; upload: jest.Mock };
  let outside: { deleteOn: jest.Mock; getOn: jest.Mock };
  let visitorData: VisitorDataService;
  let hosted: HostedChatService;
  let hostedChat: HostedChatController;
  let channels: ChannelGatewayService;
  let widget: ChannelWidgetController;
  let delegation: UnifiedGatewayDelegation;
  let requests: VisitorDataRequestsService;
  let auditLog: AuditLogService;
  let runtime: { startRun: jest.Mock; sendInput: jest.Mock; getRunEmitter: jest.Mock; getRun: jest.Mock };

  let orgA: Organization;
  let orgB: Organization;
  const user: Record<'adminA' | 'memberA' | 'adminB', string> = {} as any;
  let toolA: string;
  let toolB: string;

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

  async function refusal(promise: Promise<unknown>): Promise<HttpException> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof HttpException) return err;
      throw err;
    }
    throw new Error('expected a refusal');
  }

  // -- An agent and its channels -------------------------------------------

  interface Placed {
    agent: Agent;
    channels: Record<string, { channel: AgentChannel; gateway: Gateway }>;
  }

  const GATEWAY_TYPE: Record<string, GatewayType> = {
    [ChannelType.WEB]: GatewayType.HOSTED_CHAT,
    [ChannelType.WIDGET]: GatewayType.CHAT_WIDGET,
    [ChannelType.TELEGRAM]: GatewayType.TELEGRAM,
    [ChannelType.SMS]: GatewayType.SMS,
    [ChannelType.A2A]: GatewayType.A2A,
  };

  async function newAgent(org: Organization, types: ChannelType[], createdBy?: string): Promise<Placed> {
    const agent = await agents.save(
      agents.create({
        name: `Front desk ${randomUUID().slice(0, 6)}`,
        organizationId: org.id,
        status: AgentStatus.ACTIVE,
        mode: 'autonomous',
        visibility: 'org',
        createdBy: createdBy ?? (org.id === orgA.id ? user.adminA : user.adminB),
        pipeline: { nodes: [], edges: [] },
        instructions: 'Help.',
        visitorRules: {
          authMode: VisitorAuthMode.PUBLIC_LINK,
          limits: { ...defaultLimitsFor(VisitorAuthMode.PUBLIC_LINK), perUserRateLimit: 1000, perIpRateLimit: 1000 },
          privacy: null,
        },
      } as DeepPartial<Agent>),
    );
    const placed: Placed = { agent, channels: {} };
    for (const type of types) {
      const slug = `chat-${randomUUID().slice(0, 8)}`;
      const channel = await channelRows.save(
        channelRows.create({
          organizationId: org.id,
          agentId: agent.id,
          type,
          name: String(type),
          status: ChannelStatus.LIVE,
          slug: type === ChannelType.WEB ? slug : null,
          configuration: {},
        }),
      );
      const limits = { ...defaultLimitsFor(VisitorAuthMode.PUBLIC_LINK), perUserRateLimit: 1000, perIpRateLimit: 1000 };
      const gateway = await gateways.save(
        gateways.create({
          organizationId: org.id,
          name: `${agent.name} (${type})`,
          description: '',
          type: GATEWAY_TYPE[type],
          agentId: agent.id,
          status: GatewayStatus.ACTIVE,
          endpoint: `/channels/${channel.id}`,
          visibility: 'org',
          configuration: { channelId: channel.id, authMode: 'public_link', ...(type === ChannelType.WEB ? { hostedChat: { slug } } : {}) },
          rateLimitConfig: { ...rateLimitFor(limits, type), enabled: false },
        } as DeepPartial<Gateway>),
      );
      channel.gatewayId = gateway.id;
      await channelRows.save(channel);
      placed.channels[type] = { channel, gateway };
    }
    return placed;
  }

  // -- Reaching the agent through each channel's entry point ---------------

  /** A web chat visitor's first message; returns their cookie and run. */
  async function webVisit(placed: Placed, email: string, text = 'hello'): Promise<{ cookie: string; run: AgentRun; endUser: EndUser }> {
    const slug = placed.channels[ChannelType.WEB].channel.slug!;
    const r = res();
    const out: any = await hostedChat.postMessage(slug, { message: text }, req('198.51.100.1'), r);
    const cookie = r.cookieValue as string;
    const runRow = await runs.findOneByOrFail({ id: out.data?.runId ?? out.runId });
    const endUser = await endUsers.findOneByOrFail({ id: runRow.endUserId! });
    await endUsers.update({ id: endUser.id }, { email });
    return { cookie, run: runRow, endUser };
  }

  async function widgetVisit(placed: Placed, threadId: string, text = 'hi'): Promise<AgentRun> {
    const out: any = await widget.postMessage(placed.channels[ChannelType.WIDGET].gateway.id, { message: text, threadId }, req('203.0.113.1'), res());
    return runs.findOneByOrFail({ id: out.data.runId });
  }

  let update = 1;
  async function messagingVisit(placed: Placed, type: ChannelType, from: string): Promise<AgentRun> {
    const { gateway } = placed.channels[type];
    const before = runtime.startRun.mock.calls.length;
    await channels.handleInboundMessage(gateway, { update_id: update++, text: 'hello there', from, chat: `chat-${from}` }, {});
    expect(runtime.startRun.mock.calls.length).toBe(before + 1);
    const [saved] = await runs.find({ where: { organizationId: gateway.organizationId }, order: { createdAt: 'DESC' }, take: 1 });
    return saved;
  }
  /**
   * A message the channel took in that never became a run (the run was
   * refused), as the delivery row the channel keeps; returns its id.
   */
  async function unansweredVisit(placed: Placed, type: ChannelType, from: string): Promise<string> {
    const { gateway } = placed.channels[type];
    runtime.startRun.mockRejectedValueOnce(new NotFoundException('not in scope'));
    await channels.handleInboundMessage(gateway, { update_id: update++, text: 'is anyone there?', from, chat: `chat-${from}` }, {});
    const [event] = await events.find({
      where: { gatewayId: gateway.id, direction: 'inbound' as any, senderId: from },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    expect(event?.runId ?? null).toBeNull();
    return event.id;
  }

  async function a2aVisit(placed: Placed, org: Organization, keyId: string): Promise<AgentRun> {
    const { gateway } = placed.channels[ChannelType.A2A];
    const request = req('192.0.2.1', { method: 'POST', path: `/${org.slug}/a2a-x`, __auth: { isValid: true, metadata: { keyId } } });
    const body = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'ping' }] }, configuration: { returnImmediately: true } },
    };
    const before = runtime.startRun.mock.calls.length;
    const r = res();
    await delegation.handleGatewayRequest(org, gateway, org.slug, 'a2a-x', request, r, body);
    expect(r.body?.error).toBeUndefined();
    expect(runtime.startRun.mock.calls.length).toBe(before + 1);
    const [saved] = await runs.find({ where: { organizationId: org.id }, order: { createdAt: 'DESC' }, take: 1 });
    return saved;
  }

  // -- What a real run leaves behind ---------------------------------------

  /** Everything one run left, by id, so a test can ask whether each is still there. */
  interface Left {
    runId: string;
    childRunId: string;
    conversationId: string;
    memories: string[];
    outsideMemory: string;
    files: string[];
    storageKeys: string[];
    toolCall: string;
    storedReply: string;
  }

  async function leaveTraces(runRow: AgentRun, label: string, unsent?: { gatewayId: string; endUserId?: string; threadId?: string }): Promise<Left> {
    const organizationId = runRow.organizationId;
    const child = await runs.save(
      runs.create({
        agentId: runRow.agentId,
        organizationId,
        parentRunId: runRow.id,
        mode: AgentMode.AUTONOMOUS,
        status: AgentRunStatus.COMPLETED,
        input: { text: `sub-task for ${label}` },
        steps: [],
      } as DeepPartial<AgentRun>),
    );
    const memory = async (scopeType: string, scopeId: string, sessionId: string, content: string) => {
      const id = randomUUID();
      await ds.query(
        `INSERT INTO memories (id, mode, scope_type, scope_id, content, content_bytes, tier, valid_from, provenance)
         VALUES ($1, 'memory', $2, $3, $4, $5, 'project', now(), $6)`,
        [
          id,
          scopeType,
          scopeId,
          content,
          Buffer.byteLength(content),
          JSON.stringify({ agent_id: runRow.agentId, session_id: sessionId, collab_id: null, model: null, provider: null, tool_chain: ['memory'], created_by: 'agent', source_backend: 'almyty-native' }),
        ],
      );
      return id;
    };
    const memories = [
      // Written by the run into the organization's shared memory.
      await memory('workspace', organizationId, runRow.id, `${label} asked about order 4411`),
      // Written by the child run the visitor's run started.
      await memory('workspace', organizationId, child.id, `${label} prefers email`),
    ];
    if (runRow.endUserId) {
      // The visitor's own memory ("per person").
      memories.push(await memory('user', visitorScopeId(organizationId, runRow.endUserId), runRow.id, `${label} lives in Lisbon`));
    }
    const expiry = await expiries.save(
      expiries.create({
        organizationId,
        agentId: runRow.agentId,
        backendId: 'mem0',
        scopeType: 'workspace',
        scopeId: organizationId,
        nativeId: `mem0-${label}-${randomUUID().slice(0, 4)}`,
        memoryId: randomUUID(),
        runId: runRow.id,
        expiresAt: null,
      } as DeepPartial<MemoryExpiry>),
    );
    const file = (data: Partial<AgentFile>) =>
      files.save(
        files.create({
          organizationId,
          agentId: runRow.agentId,
          name: `${label}.txt`,
          mimeType: 'text/plain',
          size: 12,
          storageKey: `${organizationId}/${label}/${randomUUID()}`,
          ...data,
        } as DeepPartial<AgentFile>),
      );
    const fileRows = [
      await file({ conversationId: runRow.conversationId, metadata: { source: 'channel_attachment' } }),
      await file({ runId: child.id }),
      ...(unsent ? [await file({ metadata: { source: 'web_chat_upload', ...unsent } })] : []),
    ];
    const toolCall = await ds.getRepository(ToolExecution).save(
      ds.getRepository(ToolExecution).create({
        toolId: organizationId === orgA.id ? toolA : toolB,
        organizationId,
        runId: runRow.id,
        parameters: { order: '4411', who: label },
        success: true,
        executionTime: 3,
      }),
    );
    const reply = await events.save(
      events.create({
        organizationId,
        gatewayId: (runRow.metadata as any)?.gatewayId ?? (await conversations.findOneByOrFail({ id: runRow.conversationId! })).gatewayId,
        channelType: 'widget',
        direction: 'outbound',
        status: 'processed',
        runId: runRow.id,
        payload: { kind: 'widget_message', message: `Hello ${label}` },
      } as DeepPartial<ChannelEvent>),
    );
    return {
      runId: runRow.id,
      childRunId: child.id,
      conversationId: runRow.conversationId!,
      memories,
      outsideMemory: expiry.id,
      files: fileRows.map((f) => f.id),
      storageKeys: fileRows.map((f) => f.storageKey),
      toolCall: toolCall.id,
      storedReply: reply.id,
    };
  }

  /** How much of what a run left is still there, per kind. */
  async function remaining(left: Left) {
    const [memoryRows] = await Promise.all([
      ds.query(`SELECT COUNT(*)::int AS n FROM memories WHERE id = ANY($1::uuid[])`, [left.memories]),
    ]);
    return {
      runs: await runs.countBy({ id: In([left.runId, left.childRunId]) }),
      conversation: await conversations.countBy({ id: left.conversationId }),
      messages: await messages.countBy({ conversationId: left.conversationId }),
      memories: memoryRows[0].n as number,
      outsideMemory: await expiries.countBy({ id: left.outsideMemory }),
      files: await files.countBy({ id: In(left.files) }),
      toolCalls: await ds.getRepository(ToolExecution).countBy({ id: left.toolCall }),
      storedReplies: await events.countBy({ id: left.storedReply }),
    };
  }

  const nothingLeft = { runs: 0, conversation: 0, messages: 0, memories: 0, outsideMemory: 0, files: 0, toolCalls: 0, storedReplies: 0 };
  const allThere = (left: Left) => ({
    runs: 2,
    conversation: 1,
    messages: expect.any(Number),
    memories: left.memories.length,
    outsideMemory: 1,
    files: left.files.length,
    toolCalls: 1,
    storedReplies: 1,
  });

  // -- Wiring ----------------------------------------------------------------

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
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}', MemoryExpiry],
      logging: false,
    });
    await ds.initialize();

    orgs = ds.getRepository(Organization);
    agents = ds.getRepository(Agent);
    channelRows = ds.getRepository(AgentChannel);
    gateways = ds.getRepository(Gateway);
    runs = ds.getRepository(AgentRun);
    conversations = ds.getRepository(Conversation);
    messages = ds.getRepository(Message);
    events = ds.getRepository(ChannelEvent);
    endUsers = ds.getRepository(EndUser);
    files = ds.getRepository(AgentFile);
    audits = ds.getRepository(AuditLog);
    expiries = ds.getRepository(MemoryExpiry);

    orgA = await orgs.save(orgs.create({ name: `Visitors A ${randomUUID()}`, slug: `visitors-a-${randomUUID().slice(0, 8)}` }));
    orgB = await orgs.save(orgs.create({ name: `Visitors B ${randomUUID()}`, slug: `visitors-b-${randomUUID().slice(0, 8)}` }));
    const people: Array<[keyof typeof user, Organization, OrganizationRole]> = [
      ['adminA', orgA, OrganizationRole.ADMIN],
      ['memberA', orgA, OrganizationRole.MEMBER],
      ['adminB', orgB, OrganizationRole.ADMIN],
    ];
    for (const [name, org, role] of people) {
      const row = await ds.getRepository(User).save(
        ds.getRepository(User).create({ email: `${name}-${randomUUID().slice(0, 6)}@visitors.test`, passwordHash: 'x', firstName: name, lastName: 'T' } as any),
      );
      user[name] = (row as any).id;
      await ds.getRepository(UserOrganization).save(
        ds.getRepository(UserOrganization).create({ userId: user[name], organizationId: org.id, role, isActive: true, inviteAccepted: true } as any),
      );
    }
    const tool = (org: Organization) =>
      ds.getRepository(Tool).save(
        ds.getRepository(Tool).create({ name: `lookup_${randomUUID().slice(0, 6)}`, type: ToolType.FUNCTION, parameters: {}, organizationId: org.id, visibility: 'org' } as any),
      );
    toolA = ((await tool(orgA)) as any).id;
    toolB = ((await tool(orgB)) as any).id;
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(() => {
    const redis = new FakeRedisWithWindows();
    const rateLimit = new GatewayRateLimitService(redis as any);
    const appLink = new ChannelLinkService(channelRows);
    const places = new ChannelPolicyService(appLink, runs, channelRows, { emit: jest.fn(async () => undefined) } as any, redis as any);

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
        await messages.save(Message.createAssistantMessage(conversation.id, `Answer to: ${input}`));
        return runs.save(
          runs.create({
            agentId,
            organizationId,
            endUserId: options.endUserId ?? null,
            channelId: options.channelId ?? null,
            conversationId: conversation.id,
            mode: AgentMode.AUTONOMOUS,
            status: AgentRunStatus.RUNNING,
            input,
            steps: [],
            metadata: options.metadata ?? null,
          } as any),
        );
      }),
      sendInput: jest.fn(async (runId: string) => runs.findOneByOrFail({ id: runId })),
      getRunEmitter: jest.fn(() => null),
      getRun: jest.fn(),
    };

    storage = { delete: jest.fn(async () => undefined), upload: jest.fn() };
    outside = {
      deleteOn: jest.fn(async () => true),
      // What the outside memory service holds, read by the id it knows a memory by.
      getOn: jest.fn(async (_backend: string, nativeId: string) => ({ content: `What Mem0 holds for ${nativeId}` })),
    };
    const filesService = new FilesService(files, storage as any, undefined as any, undefined as any);
    const memoryAccounts = new MemoryAccountsService(undefined as any, outside as any, undefined as any, expiries, undefined as any);
    visitorData = new VisitorDataService(runs, filesService, { get: () => memoryAccounts } as any);
    auditLog = new AuditLogService(audits, ds.getRepository(User));

    hosted = new HostedChatService(gateways, endUsers, conversations, messages, runs, auditLog, undefined, appLink, filesService, visitorData);
    hostedChat = new HostedChatController(hosted, rateLimit, runtime as any, places);

    const chatter = (type: string) => ({
      type,
      extractTenantId: () => null,
      verifyWebhook: async () => true,
      carriesMessage: () => true,
      deliveryId: (body: any) => String(body.update_id),
      normalizeInbound: (body: any) => ({ text: body.text, userId: body.from, threadId: body.chat, metadata: { chatId: body.chat } }),
      formatOutbound: ({ text }: { text: string }) => ({ text }),
      sendResponse: jest.fn(async () => undefined),
    });
    const stub = { verifyWebhook: async () => false } as any;
    channels = new ChannelGatewayService(
      gateways,
      runs,
      events,
      runtime as any,
      new ChatWidgetAdapter(events),
      // slack, discord, telegram, whatsapp, whatsapp cloud, sms, then the rest.
      stub, stub, chatter('telegram') as any, stub, stub, chatter('sms') as any, stub, stub, stub, stub, stub, stub, stub, stub, stub,
      undefined,
      undefined,
      rateLimit,
      undefined,
      undefined,
      places,
      undefined,
      visitorData,
      auditLog,
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
      { get: () => 'https://api.example.test' } as any,
      rateLimit,
      channels,
      undefined,
      undefined,
      undefined,
      places,
    );

    const policy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    const agentChannels = new AgentChannelsService(channelRows, agents, gateways, undefined as any, policy);
    requests = new VisitorDataRequestsService(channelRows, agentChannels, visitorData, auditLog);
  });

  // -- The owner answering a data request ----------------------------------

  describe('an owner answering a data request', () => {
    let a: Placed;
    let sibling: Placed;
    let b: Placed;
    const owner = () => ({ id: user.adminA });

    beforeAll(async () => {
      a = await newAgent(orgA, [ChannelType.WEB, ChannelType.WIDGET, ChannelType.TELEGRAM, ChannelType.SMS, ChannelType.A2A]);
      sibling = await newAgent(orgA, [ChannelType.TELEGRAM]);
      b = await newAgent(orgB, [ChannelType.TELEGRAM]);
    });

    it('finds a Telegram sender on that channel, and nobody else', async () => {
      const alice = await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-alice'), 'alice');
      await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-bob'), 'bob');
      await leaveTraces(await messagingVisit(sibling, ChannelType.TELEGRAM, 'tg-alice'), 'alice-elsewhere');

      const found = await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'tg-alice' });
      expect(found).toMatchObject({
        found: true,
        conversations: 1,
        messages: 2,
        // The run's, the child run's (no own memory: Telegram has no visitor row) and the outside one.
        memories: 3,
        files: 2,
        runs: 2,
        channels: [{ id: a.channels[ChannelType.TELEGRAM].channel.id, type: 'telegram' }],
      });
      expect(found.recent.map((c) => c.id)).toEqual([alice.conversationId]);
    });

    it('matches a phone number the way people write it', async () => {
      const left = await leaveTraces(await messagingVisit(a, ChannelType.SMS, '+14155550100'), 'phone');
      const found = await requests.lookup(orgA.id, a.agent.id, owner(), {
        channelId: a.channels[ChannelType.SMS].channel.id,
        id: '+1 (415) 555-0100',
      });
      expect(found.found).toBe(true);
      expect(found.recent.map((c) => c.id)).toEqual([left.conversationId]);
    });

    it('finds a web chat visitor by the email they signed in with, any case', async () => {
      const visit = await webVisit(a, 'Dana@Example.com');
      await leaveTraces(visit.run, 'dana', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: visit.endUser.id });
      const found = await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'dana@example.COM' });
      // Her own memory too, this time: a web visitor has a row, and a scope.
      expect(found).toMatchObject({ found: true, conversations: 1, memories: 4, files: 3 });
      expect(found.channels.map((c) => c.type)).toEqual(['web']);
    });

    it('finds a widget visitor by their conversation id, and an A2A caller by their key', async () => {
      await leaveTraces(await widgetVisit(a, 'thread-erin'), 'erin', { gatewayId: a.channels[ChannelType.WIDGET].gateway.id, threadId: 'thread-erin' });
      await leaveTraces(await a2aVisit(a, orgA, 'key-frank'), 'frank');

      const erin = await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'thread-erin' });
      expect(erin).toMatchObject({ found: true, files: 3, channels: [{ type: 'widget' }] });
      // The bare key id, or the stamped form.
      const frank = await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'key-frank' });
      expect(frank).toMatchObject({ found: true, channels: [{ type: 'a2a' }] });
      expect((await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'key:key-frank' })).found).toBe(true);
      expect((await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'key-somebody' })).found).toBe(false);
    });

    it('says when nothing is held', async () => {
      const found = await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'nobody@example.com' });
      expect(found).toMatchObject({ found: false, conversations: 0, memories: 0, files: 0, channels: [] });
    });

    it('exports their transcript, memories and files, and records it without the identifier', async () => {
      await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-gina'), 'gina');
      const data = await requests.export(orgA.id, a.agent.id, owner(), { id: 'tg-gina' });

      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].messages.map((m) => m.content)).toEqual(['hello there', 'Answer to: hello there']);
      // The memories their runs wrote, and the one kept in Mem0, read back from it.
      expect(data.memories.map((m) => m.content).filter(Boolean).sort()).toEqual([
        expect.stringMatching(/^What Mem0 holds for mem0-gina/),
        'gina asked about order 4411',
        'gina prefers email',
      ]);
      expect(data.memories.filter((m) => m.keptIn === 'Mem0')).toHaveLength(1);
      expect(data.files.map((f) => f.name)).toEqual(['gina.txt', 'gina.txt']);
      expect(data.storedReplies.map((r) => r.message)).toContain('Hello gina');
      expect(JSON.stringify(data)).not.toContain('bob');

      const [entry] = await audits.find({ where: { organizationId: orgA.id, action: AuditAction.VISITOR_DATA_EXPORT }, order: { createdAt: 'DESC' }, take: 1 });
      expect(entry).toMatchObject({ userId: user.adminA, resourceType: 'agent', resourceId: a.agent.id });
      expect(entry.details).toMatchObject({ request: 'export', by: 'owner', channel: 'all', subject: subjectRef(orgA.id, 'tg-gina') });
      expect(entry.details.counts).toMatchObject({ conversations: 1, messages: 2, memories: 3, files: 2 });
      expect(JSON.stringify(entry)).not.toContain('tg-gina');
      expect(JSON.stringify(entry)).not.toContain('order 4411');
    });

    it('erases everything of theirs on the agent, and nothing of anyone else', async () => {
      const hank = await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-hank'), 'hank');
      const ivy = await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-ivy'), 'ivy');
      const hankOnSibling = await leaveTraces(await messagingVisit(sibling, ChannelType.TELEGRAM, 'tg-hank'), 'hank-sibling');
      const hankInOrgB = await leaveTraces(await messagingVisit(b, ChannelType.TELEGRAM, 'tg-hank'), 'hank-b');
      const outsideNative = (await expiries.findOneByOrFail({ id: hank.outsideMemory })).nativeId;

      const removed = await requests.erase(orgA.id, a.agent.id, owner(), { id: 'tg-hank' });

      expect(removed).toMatchObject({ conversations: 1, messages: 2, runs: 2, toolCalls: 1, memories: 3, files: 2, memoriesPending: 0 });
      // The reply stored for them, and the deliveries that brought their message in.
      expect(removed.storedReplies).toBeGreaterThanOrEqual(2);
      expect(await remaining(hank)).toEqual(nothingLeft);
      // The stored objects behind the files, and the memory in the outside service.
      for (const key of hank.storageKeys) expect(storage.delete).toHaveBeenCalledWith(key);
      expect(outside.deleteOn).toHaveBeenCalledWith('mem0', outsideNative, expect.anything(), undefined);

      // Another person on the same channel, the same id on another agent, the same id in another organization.
      for (const kept of [ivy, hankOnSibling, hankInOrgB]) expect(await remaining(kept)).toEqual(allThere(kept));
      for (const key of [...ivy.storageKeys, ...hankOnSibling.storageKeys, ...hankInOrgB.storageKeys]) {
        expect(storage.delete).not.toHaveBeenCalledWith(key);
      }

      // Recorded with the erasure: counts and a hash, nothing erased.
      const [entry] = await audits.find({ where: { organizationId: orgA.id, action: AuditAction.VISITOR_DATA_ERASE }, order: { createdAt: 'DESC' }, take: 1 });
      expect(entry.details).toMatchObject({ request: 'erase', by: 'owner', subject: subjectRef(orgA.id, 'tg-hank'), counts: expect.objectContaining({ messages: 2, files: 2 }) });
      expect(JSON.stringify(entry)).not.toMatch(/tg-hank|hank asked|hank prefers/);
    });

    it('erases a web visitor entirely: the visitor row, their own memory, their unsent upload', async () => {
      const visit = await webVisit(a, 'jo@example.com');
      const jo = await leaveTraces(visit.run, 'jo', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: visit.endUser.id });
      const other = await webVisit(a, 'kim@example.com');
      const kim = await leaveTraces(other.run, 'kim', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: other.endUser.id });

      await requests.erase(orgA.id, a.agent.id, owner(), { channelId: a.channels[ChannelType.WEB].channel.id, id: 'jo@example.com' });

      expect(await remaining(jo)).toEqual(nothingLeft);
      expect(await endUsers.countBy({ id: visit.endUser.id })).toBe(0);
      expect(await remaining(kim)).toEqual(allThere(kim));
      expect(await endUsers.countBy({ id: other.endUser.id })).toBe(1);
    });

    it('hands an outside memory the service would not delete to the sweep, and says so', async () => {
      const left = await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-lou'), 'lou');
      outside.deleteOn.mockRejectedValueOnce(new Error('mem0 is down'));
      const removed = await requests.erase(orgA.id, a.agent.id, owner(), { id: 'tg-lou' });
      expect(removed.memoriesPending).toBe(1);
      const kept = await expiries.findOneByOrFail({ id: left.outsideMemory });
      expect(kept.expiresAt).not.toBeNull();
      expect(kept.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('is open only to someone who may manage the agent, and only for its own channels', async () => {
      await messagingVisit(a, ChannelType.TELEGRAM, 'tg-mo');
      // Another organization's admin: the agent does not exist for them.
      expect(await refusal(requests.lookup(orgB.id, a.agent.id, { id: user.adminB }, { id: 'tg-mo' }))).toBeInstanceOf(NotFoundException);
      // A member of the organization who may not manage the agent.
      const member = await refusal(requests.erase(orgA.id, a.agent.id, { id: user.memberA }, { id: 'tg-mo' }));
      expect(member instanceof ForbiddenException || member instanceof NotFoundException).toBe(true);
      // Another agent's channel, named on this agent.
      expect(
        await refusal(requests.erase(orgA.id, a.agent.id, owner(), { channelId: sibling.channels[ChannelType.TELEGRAM].channel.id, id: 'tg-mo' })),
      ).toBeInstanceOf(NotFoundException);
      expect((await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'tg-mo' })).found).toBe(true);
    });

    it('exports nothing when the export cannot be recorded', async () => {
      await messagingVisit(a, ChannelType.TELEGRAM, 'tg-ned');
      jest.spyOn(auditLog, 'log').mockResolvedValueOnce(null);
      expect(await refusal(requests.export(orgA.id, a.agent.id, owner(), { id: 'tg-ned' }))).toBeInstanceOf(ServiceUnavailableException);
    });

    it('erases nothing when the erasure cannot be recorded', async () => {
      const left = await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-oli'), 'oli');
      jest.spyOn(auditLog, 'logInTransaction').mockRejectedValueOnce(new Error('audit_logs is gone'));
      await expect(requests.erase(orgA.id, a.agent.id, owner(), { id: 'tg-oli' })).rejects.toThrow('audit_logs is gone');
      // Every row is still there: the erasure and its record commit together.
      const still = await remaining(left);
      expect({ ...still, files: undefined, outsideMemory: undefined }).toEqual({ ...allThere(left), files: undefined, outsideMemory: undefined });
    });

    it("lets the member who owns an agent answer for it, and not for anyone else's", async () => {
      const own = await newAgent(orgA, [ChannelType.TELEGRAM], user.memberA);
      const mine = await leaveTraces(await messagingVisit(own, ChannelType.TELEGRAM, 'tg-pia'), 'pia');
      await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-pia'), 'pia-on-a');
      const member = { id: user.memberA };

      expect((await requests.lookup(orgA.id, own.agent.id, member, { id: 'tg-pia' })).found).toBe(true);
      await requests.erase(orgA.id, own.agent.id, member, { id: 'tg-pia' });
      expect(await remaining(mine)).toEqual(nothingLeft);

      // An agent of the organization the member does not own.
      const refused = await refusal(requests.lookup(orgA.id, a.agent.id, member, { id: 'tg-pia' }));
      expect(refused instanceof ForbiddenException || refused instanceof NotFoundException).toBe(true);
      expect((await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'tg-pia' })).found).toBe(true);
    });

    it("reads outside memories back from their service for the download, and says so when it cannot", async () => {
      const first = await messagingVisit(a, ChannelType.TELEGRAM, 'tg-quin');
      await leaveTraces(first, 'quin');
      // Finished, so their next message starts a run of its own.
      await runs.update({ id: first.id }, { status: AgentRunStatus.COMPLETED });
      await leaveTraces(await messagingVisit(a, ChannelType.TELEGRAM, 'tg-quin'), 'quin-again');

      const data = await requests.export(orgA.id, a.agent.id, owner(), { id: 'tg-quin' });
      const outsideMemories = data.memories.filter((m) => m.keptIn === 'Mem0');
      expect(outsideMemories).toHaveLength(2);
      for (const m of outsideMemories) {
        expect(m.content).toMatch(/^What Mem0 holds for mem0-quin/);
        expect(m.note).toBeUndefined();
      }
      // Read through the service by the id it knows each memory by.
      expect(outside.getOn).toHaveBeenCalledWith('mem0', expect.stringMatching(/^mem0-quin/), expect.anything(), undefined);

      // The service is down for one of them: that one is listed by id and service, with a note.
      outside.getOn.mockRejectedValueOnce(new Error('mem0 is down'));
      const again = await requests.export(orgA.id, a.agent.id, owner(), { id: 'tg-quin' });
      const [missing] = again.memories.filter((m) => m.keptIn === 'Mem0' && m.content === undefined);
      expect(missing).toMatchObject({ keptIn: 'Mem0' });
      expect(missing.note).toMatch(/could not give its text back/);
      expect(again.memories.filter((m) => m.keptIn === 'Mem0' && m.content)).toHaveLength(1);
      // The lookup counts memories without asking the service.
      outside.getOn.mockClear();
      expect((await requests.lookup(orgA.id, a.agent.id, owner(), { id: 'tg-quin' })).memories).toBe(6);
      expect(outside.getOn).not.toHaveBeenCalled();
    });

    it('finds and erases the messages of a sender that never became a run, and nobody else\'s', async () => {
      const rays = [await unansweredVisit(a, ChannelType.SMS, '+14155550199'), await unansweredVisit(a, ChannelType.SMS, '+14155550199')];
      const sams = await unansweredVisit(a, ChannelType.SMS, '+14155550188');
      // The same number on another agent's channel.
      const raysElsewhere = await unansweredVisit(sibling, ChannelType.TELEGRAM, '+14155550199');

      const found = await requests.lookup(orgA.id, a.agent.id, owner(), { id: '+1 (415) 555-0199' });
      expect(found).toMatchObject({ found: true, unanswered: 2, conversations: 0, runs: 0 });
      expect(found.channels.map((c) => c.type)).toEqual(['sms']);

      const data = await requests.export(orgA.id, a.agent.id, owner(), { id: '+1 (415) 555-0199' });
      expect(data.unanswered).toHaveLength(2);
      expect(data.unanswered[0].reason).toMatch(/run refused/);
      expect(JSON.stringify(data)).not.toContain('0188');

      const removed = await requests.erase(orgA.id, a.agent.id, owner(), { id: '+1 (415) 555-0199' });
      expect(removed.unanswered).toBe(2);
      expect(await events.countBy({ id: In(rays) })).toBe(0);
      expect(await events.countBy({ id: sams })).toBe(1);
      expect(await events.countBy({ id: raysElsewhere })).toBe(1);
      expect((await requests.lookup(orgA.id, a.agent.id, owner(), { id: '+14155550199' })).found).toBe(false);
    });
  });

  // -- A visitor's own data --------------------------------------------------

  describe('a visitor helping themselves', () => {
    let a: Placed;

    beforeAll(async () => {
      a = await newAgent(orgA, [ChannelType.WEB, ChannelType.WIDGET]);
    });

    const slug = () => a.channels[ChannelType.WEB].channel.slug!;
    const asVisitor = (cookie: string) => req('198.51.100.7', { cookies: { [HostedChatService.SESSION_COOKIE]: cookie } });

    it('downloads their own conversations, memories and files, and nobody else\'s', async () => {
      const pat = await webVisit(a, 'pat@example.com');
      await leaveTraces(pat.run, 'pat', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: pat.endUser.id });
      const quinn = await webVisit(a, 'quinn@example.com');
      await leaveTraces(quinn.run, 'quinn', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: quinn.endUser.id });

      const mine: any = await hostedChat.exportMe(slug(), asVisitor(pat.cookie), res());
      expect(mine.visitor.id).toBe(pat.endUser.id);
      expect(mine.conversations).toHaveLength(1);
      expect(mine.memories.map((m: any) => m.content).filter(Boolean).sort()).toEqual([
        expect.stringMatching(/^What Mem0 holds for mem0-pat/),
        'pat asked about order 4411',
        'pat lives in Lisbon',
        'pat prefers email',
      ]);
      expect(mine.files).toHaveLength(3);
      expect(JSON.stringify(mine)).not.toContain('quinn');
    });

    it('cannot delete another visitor\'s conversation, and deleting their own takes what came of it', async () => {
      const rae = await webVisit(a, 'rae@example.com');
      const raeLeft = await leaveTraces(rae.run, 'rae', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: rae.endUser.id });
      const sam = await webVisit(a, 'sam@example.com');
      const samLeft = await leaveTraces(sam.run, 'sam', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: sam.endUser.id });

      // Sam names Rae's conversation: not found, nothing touched.
      expect(await refusal(hostedChat.deleteConversation(slug(), raeLeft.conversationId, asVisitor(sam.cookie), res()))).toBeInstanceOf(NotFoundException);
      expect(await remaining(raeLeft)).toEqual(allThere(raeLeft));

      await hostedChat.deleteConversation(slug(), samLeft.conversationId, asVisitor(sam.cookie), res());
      const after = await remaining(samLeft);
      // The conversation and everything that came of it, the memories its
      // runs wrote included; the upload she has not sent yet, and the
      // visitor herself, stay.
      expect(after).toMatchObject({ runs: 0, conversation: 0, messages: 0, memories: 0, outsideMemory: 0, toolCalls: 0, storedReplies: 0 });
      expect(after.files).toBe(1);
      expect(await endUsers.countBy({ id: sam.endUser.id })).toBe(1);
    });

    it('"Delete everything about me" erases all of it, records it, and leaves the other visitor alone', async () => {
      const tess = await webVisit(a, 'tess@example.com');
      const tessLeft = await leaveTraces(tess.run, 'tess', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: tess.endUser.id });
      const uma = await webVisit(a, 'uma@example.com');
      const umaLeft = await leaveTraces(uma.run, 'uma', { gatewayId: a.channels[ChannelType.WEB].gateway.id, endUserId: uma.endUser.id });

      await hostedChat.deleteMe(slug(), asVisitor(tess.cookie), res());

      expect(await remaining(tessLeft)).toEqual(nothingLeft);
      expect(await endUsers.countBy({ id: tess.endUser.id })).toBe(0);
      expect(await remaining(umaLeft)).toEqual(allThere(umaLeft));

      const [entry] = await audits.find({ where: { organizationId: orgA.id, action: AuditAction.VISITOR_DATA_ERASE }, order: { createdAt: 'DESC' }, take: 1 });
      expect(entry).toMatchObject({ resourceType: 'agent', resourceId: a.agent.id, userId: null });
      expect(entry.details).toMatchObject({ by: 'visitor', channel: a.channels[ChannelType.WEB].gateway.id, counts: expect.objectContaining({ visitors: 1 }) });
      expect(JSON.stringify(entry)).not.toMatch(/tess|Lisbon/);
    });

    it('the widget erases only its own thread, with the files and memories that came of it', async () => {
      const gw = a.channels[ChannelType.WIDGET].gateway.id;
      const vic = await leaveTraces(await widgetVisit(a, 'thread-vic'), 'vic', { gatewayId: gw, threadId: 'thread-vic' });
      const wren = await leaveTraces(await widgetVisit(a, 'thread-wren'), 'wren', { gatewayId: gw, threadId: 'thread-wren' });

      const download: any = await widget.exportThread(gw, 'thread-vic', req('203.0.113.9'), res());
      expect(download.messages.map((m: any) => m.content)).toEqual(['hi', 'Answer to: hi']);
      expect(download.memories).toHaveLength(3);
      expect(download.files).toHaveLength(3);
      expect(JSON.stringify(download)).not.toContain('wren');

      await widget.deleteThread(gw, 'thread-vic');

      expect(await remaining(vic)).toEqual(nothingLeft);
      expect(await remaining(wren)).toEqual(allThere(wren));
      const [entry] = await audits.find({ where: { organizationId: orgA.id, action: AuditAction.VISITOR_DATA_ERASE }, order: { createdAt: 'DESC' }, take: 1 });
      expect(entry.details).toMatchObject({ by: 'visitor', subject: subjectRef(orgA.id, 'thread-vic') });
    });

    it('a visitor id from another chat reaches nothing on this one', async () => {
      const other = await newAgent(orgA, [ChannelType.WEB]);
      const xan = await webVisit(other, 'xan@example.com');
      const left = await leaveTraces(xan.run, 'xan', { gatewayId: other.channels[ChannelType.WEB].gateway.id, endUserId: xan.endUser.id });
      const footprint = await visitorData.forWebVisitors(a.channels[ChannelType.WEB].gateway, [xan.endUser.id]);
      expect(footprint).toMatchObject({ endUserIds: [], runIds: [], conversationIds: [] });
      await visitorData.erase(footprint);
      expect(await remaining(left)).toEqual(allThere(left));
    });
  });
});
