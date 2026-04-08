import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';

import { InterfacesService } from '../interfaces.service';
import { AgentInterface, InterfaceStatus, InterfaceType } from '../../../entities/interface.entity';
import { AgentRun } from '../../../entities/agent-run.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
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

/**
 * Regression spec for the widget SSE stream cross-run leak. Previously
 * the widgetStream handler verified that the interfaceId resolved AND
 * that the runId had an emitter — but NOT that the two were related.
 * Any caller with a public interface id and a leaked / guessed runId
 * from a different interface (possibly a different org) could stream
 * that foreign run's events.
 */
describe('InterfacesService.assertRunBelongsToInterface (regression)', () => {
  let service: InterfacesService;
  let interfaceRepo: jest.Mocked<any>;
  let runRepo: jest.Mocked<any>;

  const makeIface = (overrides: Partial<AgentInterface> = {}): AgentInterface =>
    ({
      id: 'iface-1',
      organizationId: 'org-1',
      agentId: 'agent-1',
      type: InterfaceType.CHAT_WIDGET,
      status: InterfaceStatus.ACTIVE,
      name: 'Widget',
      configuration: {},
      isActive: () => (overrides.status ?? InterfaceStatus.ACTIVE) === InterfaceStatus.ACTIVE,
      ...overrides,
    }) as any;

  beforeEach(async () => {
    interfaceRepo = { findOne: jest.fn() };
    runRepo = { findOne: jest.fn() };

    const nullAdapter = {} as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterfacesService,
        { provide: getRepositoryToken(AgentInterface), useValue: interfaceRepo },
        { provide: getRepositoryToken(AgentRun), useValue: runRepo },
        { provide: AuditLogService, useValue: { log: jest.fn(), logDelete: jest.fn() } },
        { provide: AgentRuntimeService, useValue: { startRun: jest.fn(), getRunEmitter: jest.fn() } },
        { provide: ChatWidgetAdapter, useValue: nullAdapter },
        { provide: SlackAdapter, useValue: nullAdapter },
        { provide: DiscordAdapter, useValue: nullAdapter },
        { provide: TelegramAdapter, useValue: nullAdapter },
        { provide: WhatsAppAdapter, useValue: nullAdapter },
        { provide: EmailAdapter, useValue: nullAdapter },
        { provide: WebhookAdapter, useValue: nullAdapter },
        { provide: GoogleChatAdapter, useValue: nullAdapter },
        { provide: MicrosoftTeamsAdapter, useValue: nullAdapter },
        { provide: SignalAdapter, useValue: nullAdapter },
        { provide: MatrixAdapter, useValue: nullAdapter },
        { provide: IrcAdapter, useValue: nullAdapter },
      ],
    }).compile();

    service = module.get<InterfacesService>(InterfacesService);
  });

  it('resolves when interface + run + metadata all match', async () => {
    interfaceRepo.findOne.mockResolvedValue(makeIface());
    runRepo.findOne.mockResolvedValue({
      id: 'run-1',
      agentId: 'agent-1',
      organizationId: 'org-1',
      metadata: { interfaceId: 'iface-1' },
    });

    await expect(service.assertRunBelongsToInterface('iface-1', 'run-1')).resolves.toBeUndefined();
  });

  it('rejects when the interface is inactive', async () => {
    interfaceRepo.findOne.mockResolvedValue(makeIface({ status: InterfaceStatus.INACTIVE }));

    await expect(service.assertRunBelongsToInterface('iface-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects when the run belongs to a different agent on the same interface', async () => {
    interfaceRepo.findOne.mockResolvedValue(makeIface());
    runRepo.findOne.mockResolvedValue({
      id: 'run-1',
      agentId: 'different-agent', // <- mismatched
      organizationId: 'org-1',
      metadata: { interfaceId: 'iface-1' },
    });

    await expect(service.assertRunBelongsToInterface('iface-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects when the run belongs to a different organization', async () => {
    interfaceRepo.findOne.mockResolvedValue(makeIface());
    runRepo.findOne.mockResolvedValue({
      id: 'run-1',
      agentId: 'agent-1',
      organizationId: 'different-org', // <- cross-org
      metadata: { interfaceId: 'iface-1' },
    });

    await expect(service.assertRunBelongsToInterface('iface-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects when the run metadata does not tag the same interface', async () => {
    interfaceRepo.findOne.mockResolvedValue(makeIface());
    runRepo.findOne.mockResolvedValue({
      id: 'run-1',
      agentId: 'agent-1',
      organizationId: 'org-1',
      metadata: { interfaceId: 'a-different-interface-on-the-same-agent' },
    });

    await expect(service.assertRunBelongsToInterface('iface-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects when the run metadata has no interface id at all', async () => {
    // Runs started outside the interfaces flow (e.g. direct API)
    // shouldn't be streamable via the widget endpoint — the
    // interfaceId tag in metadata is the proof of origin.
    interfaceRepo.findOne.mockResolvedValue(makeIface());
    runRepo.findOne.mockResolvedValue({
      id: 'run-1',
      agentId: 'agent-1',
      organizationId: 'org-1',
      metadata: {},
    });

    await expect(service.assertRunBelongsToInterface('iface-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects when the run does not exist', async () => {
    interfaceRepo.findOne.mockResolvedValue(makeIface());
    runRepo.findOne.mockResolvedValue(null);

    await expect(service.assertRunBelongsToInterface('iface-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
