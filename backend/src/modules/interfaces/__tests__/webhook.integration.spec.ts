/**
 * Integration tests for webhook/widget controller flow.
 * Uses REAL adapter instances — mocks only the DB repos and AgentRuntimeService.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { InterfacesController } from '../interfaces.controller';
import { InterfacesService } from '../interfaces.service';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { ChatWidgetAdapter } from '../adapters/chat-widget.adapter';
import { SlackAdapter } from '../adapters/slack.adapter';
import { DiscordAdapter } from '../adapters/discord.adapter';
import { TelegramAdapter } from '../adapters/telegram.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { WebhookAdapter } from '../adapters/webhook.adapter';
import { GoogleChatAdapter } from '../adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../adapters/microsoft-teams.adapter';
import { SignalAdapter } from '../adapters/signal.adapter';
import { MatrixAdapter } from '../adapters/matrix.adapter';
import { IrcAdapter } from '../adapters/irc.adapter';
import { AgentInterface, InterfaceType, InterfaceStatus } from '../../../entities/interface.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInterface(overrides: Partial<AgentInterface> = {}): AgentInterface {
  const iface = new AgentInterface();
  iface.id = 'iface-uuid-1';
  iface.agentId = 'agent-uuid-1';
  iface.organizationId = 'org-uuid-1';
  iface.type = InterfaceType.WEBHOOK;
  iface.name = 'Test Interface';
  iface.status = InterfaceStatus.ACTIVE;
  iface.configuration = {};
  iface.metadata = null;
  iface.totalMessages = 0;
  iface.lastMessageAt = null;
  iface.createdAt = new Date();
  iface.updatedAt = new Date();
  Object.assign(iface, overrides);
  return iface;
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const run = new AgentRun();
  run.id = 'run-uuid-1';
  run.agentId = 'agent-uuid-1';
  run.organizationId = 'org-uuid-1';
  run.status = AgentRunStatus.RUNNING;
  run.steps = [];
  run.currentStep = 0;
  run.maxSteps = 25;
  run.totalCost = 0;
  run.totalTokens = 0;
  run.executionTime = 0;
  run.metadata = {};
  run.createdAt = new Date();
  run.updatedAt = new Date();
  Object.assign(run, overrides);
  return run;
}

// Chainable mock query builder
function mockQueryBuilder(getResult: any = undefined) {
  const qb: any = {};
  const chainMethods = ['select', 'addSelect', 'where', 'andWhere', 'orWhere', 'orderBy', 'groupBy', 'addGroupBy', 'skip', 'take', 'limit', 'leftJoinAndSelect', 'innerJoinAndSelect', 'update', 'set'];
  for (const m of chainMethods) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(Array.isArray(getResult) ? getResult : []);
  qb.getOne = jest.fn().mockResolvedValue(getResult ?? null);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue(null);
  qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return qb;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Webhook & Widget Integration Tests', () => {
  let controller: InterfacesController;
  let service: InterfacesService;
  let interfaceRepo: any;
  let runRepo: any;
  let agentRuntime: any;
  let auditLogService: any;

  beforeEach(async () => {
    interfaceRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(entity => Promise.resolve(entity)),
      remove: jest.fn(),
      create: jest.fn(data => ({ ...data })),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => mockQueryBuilder()),
    };

    runRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(entity => Promise.resolve(entity)),
      create: jest.fn(data => ({ ...data })),
      createQueryBuilder: jest.fn(() => mockQueryBuilder()),
    };

    auditLogService = {
      log: jest.fn(),
      logDelete: jest.fn(),
    };

    agentRuntime = {
      startRun: jest.fn().mockResolvedValue(makeRun()),
      getRunEmitter: jest.fn().mockReturnValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InterfacesController],
      providers: [
        InterfacesService,
        { provide: getRepositoryToken(AgentInterface), useValue: interfaceRepo },
        { provide: getRepositoryToken(AgentRun), useValue: runRepo },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: AgentRuntimeService, useValue: agentRuntime },
        ChatWidgetAdapter,
        SlackAdapter,
        DiscordAdapter,
        TelegramAdapter,
        WhatsAppAdapter,
        EmailAdapter,
        WebhookAdapter,
        GoogleChatAdapter,
        MicrosoftTeamsAdapter,
        SignalAdapter,
        MatrixAdapter,
        IrcAdapter,
      ],
    }).compile();

    controller = module.get<InterfacesController>(InterfacesController);
    service = module.get<InterfacesService>(InterfacesService);
  });

  // =========================================================================
  // Slack URL verification
  // =========================================================================

  describe('Slack URL verification', () => {
    it('should return the challenge directly without processing', async () => {
      const result = await controller.handleWebhook('11111111-1111-1111-1111-111111111111', {
        type: 'url_verification',
        challenge: 'test-challenge-abc123',
      }, {});

      expect(result).toEqual({ challenge: 'test-challenge-abc123' });
      // Should NOT call handleInboundMessage
      expect(interfaceRepo.findOne).not.toHaveBeenCalled();
    });

    it('should handle numeric challenge values', async () => {
      const result = await controller.handleWebhook('11111111-1111-1111-1111-111111111111', {
        type: 'url_verification',
        challenge: 12345,
      }, {});

      expect(result).toEqual({ challenge: 12345 });
    });
  });

  // =========================================================================
  // Slack message handling
  // =========================================================================

  describe('Slack message handling', () => {
    it('should return { ok: true } immediately and fire async processing', async () => {
      const slackIface = makeInterface({
        type: InterfaceType.SLACK,
        configuration: {},
      });
      interfaceRepo.findOne.mockResolvedValue(slackIface);
      // Mock the query builder for thread lookup to return no existing runs
      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));

      const payload = {
        event: {
          type: 'message',
          text: 'hello agent',
          user: 'U12345',
          channel: 'C67890',
          ts: '1234567890.123456',
        },
      };

      const result = await controller.handleWebhook(slackIface.id, payload, {});

      // Controller returns immediately
      expect(result).toEqual({ ok: true });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify the interface was looked up
      expect(interfaceRepo.findOne).toHaveBeenCalledWith({ where: { id: slackIface.id } });
    });

    it('should start a new run via agentRuntimeService for a new Slack message', async () => {
      const slackIface = makeInterface({ type: InterfaceType.SLACK });
      interfaceRepo.findOne.mockResolvedValue(slackIface);
      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));
      const newRun = makeRun({ metadata: {} });
      agentRuntime.startRun.mockResolvedValue(newRun);

      await controller.handleWebhook(slackIface.id, {
        event: { text: 'start new run', user: 'U999', channel: 'C111', ts: '1111.2222' },
      }, {});

      // Wait for async
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(agentRuntime.startRun).toHaveBeenCalledWith(
        slackIface.agentId,
        slackIface.organizationId,
        'U999',
        'start new run',
        { maxSteps: 25 },
      );
    });
  });

  // =========================================================================
  // Webhook signature verification
  // =========================================================================

  describe('Webhook signature verification', () => {
    it('should accept a valid HMAC signature on a webhook interface', async () => {
      const secret = 'webhook-test-secret';
      const payload = { text: 'signed payload', userId: 'u1' };
      const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

      const iface = makeInterface({
        type: InterfaceType.WEBHOOK,
        configuration: { secret },
      });
      interfaceRepo.findOne.mockResolvedValue(iface);
      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));
      agentRuntime.startRun.mockResolvedValue(makeRun({ metadata: {} }));

      await controller.handleWebhook(iface.id, payload, { 'x-webhook-signature': sig });
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should proceed to start a run
      expect(agentRuntime.startRun).toHaveBeenCalled();
    });

    it('should silently reject when HMAC signature is invalid (no run started)', async () => {
      const iface = makeInterface({
        type: InterfaceType.WEBHOOK,
        configuration: { secret: 'real-secret' },
      });
      interfaceRepo.findOne.mockResolvedValue(iface);

      await controller.handleWebhook(iface.id,
        { text: 'tampered' },
        { 'x-webhook-signature': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      );
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should NOT start a run
      expect(agentRuntime.startRun).not.toHaveBeenCalled();
    });

    it('should silently reject when signature header is missing on protected webhook', async () => {
      const iface = makeInterface({
        type: InterfaceType.WEBHOOK,
        configuration: { secret: 'protect-me' },
      });
      interfaceRepo.findOne.mockResolvedValue(iface);

      await controller.handleWebhook(iface.id, { text: 'no sig' }, {});
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(agentRuntime.startRun).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Inactive interface rejection
  // =========================================================================

  describe('Inactive interface rejection', () => {
    it('should not start a run for an inactive interface (webhook is fire-and-forget)', async () => {
      const iface = makeInterface({ status: InterfaceStatus.INACTIVE });
      interfaceRepo.findOne.mockResolvedValue(iface);

      const result = await controller.handleWebhook(iface.id, { text: 'hi' }, {});
      await new Promise(resolve => setTimeout(resolve, 50));

      // Controller returns ok immediately (fire-and-forget)
      expect(result).toEqual({ ok: true });
      expect(agentRuntime.startRun).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Widget message endpoint
  // =========================================================================

  describe('Widget message endpoint', () => {
    it('should create a new run and return runId and threadId', async () => {
      const iface = makeInterface({ type: InterfaceType.CHAT_WIDGET });
      interfaceRepo.findOne.mockResolvedValue(iface);
      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));

      const newRun = makeRun({ id: 'new-run-id', metadata: {} });
      agentRuntime.startRun.mockResolvedValue(newRun);

      const result = await controller.widgetMessage(iface.id, {
        message: 'Hello widget!',
        sessionId: 'session-abc',
      });

      expect(result.success).toBe(true);
      expect(result.data.runId).toBe('new-run-id');
      expect(result.data.threadId).toBeDefined();
      expect(agentRuntime.startRun).toHaveBeenCalledWith(
        iface.agentId,
        iface.organizationId,
        'session-abc',
        'Hello widget!',
        { maxSteps: 25 },
      );
    });

    it('should throw NotFoundException for non-existent interface', async () => {
      interfaceRepo.findOne.mockResolvedValue(null);

      await expect(
        controller.widgetMessage('22222222-2222-2222-2222-222222222222', { message: 'hi' }),
      ).rejects.toThrow(HttpException);
    });

    it('should throw BadRequestException for inactive widget interface', async () => {
      const iface = makeInterface({
        type: InterfaceType.CHAT_WIDGET,
        status: InterfaceStatus.INACTIVE,
      });
      interfaceRepo.findOne.mockResolvedValue(iface);

      await expect(
        controller.widgetMessage(iface.id, { message: 'hi' }),
      ).rejects.toThrow(HttpException);
    });

    it('should continue an existing run when threadId matches', async () => {
      const iface = makeInterface({ type: InterfaceType.CHAT_WIDGET });
      interfaceRepo.findOne.mockResolvedValue(iface);

      const existingRun = makeRun({
        id: 'existing-run-id',
        status: AgentRunStatus.WAITING_INPUT,
        metadata: { threadId: 'thread-existing' },
      });

      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([existingRun]));

      const result = await controller.widgetMessage(iface.id, {
        message: 'follow up',
        threadId: 'thread-existing',
      });

      expect(result.success).toBe(true);
      // Should NOT call startRun since we continue existing
      expect(agentRuntime.startRun).not.toHaveBeenCalled();
      // Should call sendInput to resume the run
      expect(agentRuntime.sendInput).toHaveBeenCalledWith(
        'existing-run-id',
        iface.organizationId,
        'follow up',
      );
    });
  });

  // =========================================================================
  // Missing interface on webhook
  // =========================================================================

  describe('Missing interface on webhook', () => {
    it('should silently handle unknown interface ID (fire-and-forget, no crash)', async () => {
      interfaceRepo.findOne.mockResolvedValue(null);

      const result = await controller.handleWebhook(
        '33333333-3333-3333-3333-333333333333',
        { text: 'hello' },
        {},
      );

      expect(result).toEqual({ ok: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(agentRuntime.startRun).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Rate limiting / multiple rapid requests (no crash)
  // =========================================================================

  describe('Rate limiting — multiple rapid requests', () => {
    it('should handle 20 rapid requests without crashing', async () => {
      const iface = makeInterface({ type: InterfaceType.WEBHOOK });
      interfaceRepo.findOne.mockResolvedValue(iface);
      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));
      agentRuntime.startRun.mockResolvedValue(makeRun({ metadata: {} }));

      const promises = Array.from({ length: 20 }, (_, i) =>
        controller.handleWebhook(iface.id, { text: `msg-${i}` }, {}),
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(20);
      results.forEach(r => expect(r).toEqual({ ok: true }));
    });
  });

  // =========================================================================
  // Adapter normalization flows through the service correctly
  // =========================================================================

  describe('Adapter normalization through service', () => {
    it('should normalize a Discord payload via the correct adapter when processing inbound', async () => {
      const iface = makeInterface({ type: InterfaceType.DISCORD });
      interfaceRepo.findOne.mockResolvedValue(iface);
      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));
      const newRun = makeRun({ metadata: {} });
      agentRuntime.startRun.mockResolvedValue(newRun);

      const discordPayload = {
        content: 'Discord content',
        author: { id: 'discord-user-1' },
        channel_id: 'chan-abc',
        guild_id: 'guild-xyz',
      };

      await service.handleInboundMessage(iface.id, discordPayload, {});

      expect(agentRuntime.startRun).toHaveBeenCalledWith(
        iface.agentId,
        iface.organizationId,
        'discord-user-1',
        'Discord content',
        { maxSteps: 25 },
      );
    });

    it('should increment message count after processing', async () => {
      const iface = makeInterface({ type: InterfaceType.TELEGRAM });
      interfaceRepo.findOne.mockResolvedValue(iface);
      runRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));
      agentRuntime.startRun.mockResolvedValue(makeRun({ metadata: {} }));
      const incrementQb = mockQueryBuilder();
      // Second call to createQueryBuilder is for incrementMessages
      interfaceRepo.createQueryBuilder.mockReturnValue(incrementQb);

      await service.handleInboundMessage(iface.id, {
        message: { text: 'tg msg', from: { id: 100 }, chat: { id: 200 }, message_id: 1 },
      }, {});

      expect(interfaceRepo.createQueryBuilder).toHaveBeenCalled();
      expect(incrementQb.execute).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getAdapter returns correct adapter type
  // =========================================================================

  describe('getAdapter', () => {
    it('should return the correct adapter for each interface type', () => {
      const types = [
        InterfaceType.CHAT_WIDGET,
        InterfaceType.SLACK,
        InterfaceType.DISCORD,
        InterfaceType.TELEGRAM,
        InterfaceType.WHATSAPP,
        InterfaceType.EMAIL,
        InterfaceType.WEBHOOK,
      ];

      for (const type of types) {
        const adapter = service.getAdapter(type);
        expect(adapter).toBeDefined();
        expect(adapter.type).toBe(type);
      }
    });

    it('should throw BadRequestException for unknown type', () => {
      expect(() => service.getAdapter('carrier_pigeon')).toThrow('No adapter found for interface type: carrier_pigeon');
    });
  });
});
