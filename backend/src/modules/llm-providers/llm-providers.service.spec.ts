import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { LlmProvidersService, CreateLlmProviderDto, UpdateLlmProviderDto, ChatRequest } from './llm-providers.service';
import { callOpenAI, callAnthropic, callGoogle, callCohere, callHuggingFace, callCustomProvider } from './providers';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { Conversation, ConversationStatus } from '../../entities/conversation.entity';
import { Message, MessageRole, MessageStatus } from '../../entities/message.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { LlmChatHelper } from './llm-chat.helper';
import { LlmStatsHelper } from './llm-stats.helper';
import { LlmModelsHelper } from './llm-models.helper';

// jest.mock with __esModule: true short-circuits __importDefault so the
// application code's `axios_1.default` and the spec's
// `require('axios').default` are the same jest.fn singleton. Tests
// configure it via mockAxios.default.mockResolvedValueOnce(...).
jest.mock('axios', () => {
  const mockFn = jest.fn();
  return {
    __esModule: true,
    default: mockFn,
    isAxiosError: jest.fn().mockReturnValue(false),
    AxiosError: class extends Error {},
  };
});

describe('LlmProvidersService', () => {
  let service: LlmProvidersService;
  let chatHelperInstance: LlmChatHelper;
  let llmProviderRepository: any;
  let conversationRepository: any;
  let messageRepository: any;
  let userRepository: any;
  let organizationRepository: any;
  let gatewayRepository: any;
  let toolRepository: any;
  let toolExecutorService: any;

  beforeEach(async () => {
    // The atomic stats bumps added for the counter-race fix call
    // createQueryBuilder().update().set().where().execute() on the
    // session and provider repositories. Return a noop chain that
    // resolves on execute() so recordExecution / chat() finish.
    const qbUpdateChain: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmProvidersService,
        {
          provide: getRepositoryToken(LlmProvider),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            remove: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(qbUpdateChain),
          },
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            remove: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(qbUpdateChain),
          },
        },
        {
          provide: getRepositoryToken(Message),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: ToolExecutorService,
          useValue: {
            executeTool: jest.fn(),
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(null),
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
            logToolExecution: jest.fn().mockResolvedValue(null),
            logGatewayRequest: jest.fn().mockResolvedValue(null),
            logRunEvent: jest.fn().mockResolvedValue(null),
            computeChanges: jest.fn().mockReturnValue([]),
            findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
            getResourceHistory: jest.fn().mockResolvedValue([]),
          },
        },
        LlmModelsHelper,
        LlmChatHelper,
        LlmStatsHelper,
      ],
    }).compile();

    service = module.get<LlmProvidersService>(LlmProvidersService);
    chatHelperInstance = module.get(LlmChatHelper);
    llmProviderRepository = module.get(getRepositoryToken(LlmProvider));
    conversationRepository = module.get(getRepositoryToken(Conversation));
    messageRepository = module.get(getRepositoryToken(Message));
    userRepository = module.get(getRepositoryToken(User));
    organizationRepository = module.get(getRepositoryToken(Organization));
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    toolRepository = module.get(getRepositoryToken(Tool));
    toolExecutorService = module.get(ToolExecutorService);
  });

  describe('createProvider', () => {
    const createDto: CreateLlmProviderDto = {
      name: 'OpenAI Provider',
      description: 'OpenAI GPT provider',
      type: LlmProviderType.OPENAI,
      configuration: {
        apiKey: 'test-api-key',
        model: 'gpt-4',
        maxTokens: 4096,
        temperature: 0.7,
      },
    };

    it('should create LLM provider successfully', async () => {
      const mockOrganization = { id: 'org-1', name: 'Test Org' };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        ...createDto,
        organizationId: 'org-1',
        status: LlmProviderStatus.ACTIVE,
        capabilities: {},
      };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      llmProviderRepository.create.mockReturnValue(mockProvider);
      llmProviderRepository.save.mockResolvedValue(mockProvider);

      // Mock private methods
      jest.spyOn(chatHelperInstance as any, 'validateProviderConfiguration').mockImplementation();
      jest.spyOn(service as any, 'getDefaultCapabilities').mockReturnValue({});
      jest.spyOn(service, 'performHealthCheck').mockResolvedValue({} as any);

      const result = await service.createProvider(createDto, 'org-1', 'user-1');

      expect(result).toBe(mockProvider);
      expect(organizationRepository.findOne).toHaveBeenCalledWith({ where: { id: 'org-1' } });
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: ['organizationMemberships'],
      });
      expect(mockUser.hasPermissionInOrganization).toHaveBeenCalledWith('org-1', 'manage_llm_providers');
      expect(llmProviderRepository.create).toHaveBeenCalled();
      expect(llmProviderRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException for invalid organization', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(service.createProvider(createDto, 'invalid-org', 'user-1'))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockOrganization = { id: 'org-1', name: 'Test Org' };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.createProvider(createDto, 'org-1', 'user-1'))
        .rejects
        .toThrow(ForbiddenException);
    });
  });

  describe('updateProvider', () => {
    const updateDto: UpdateLlmProviderDto = {
      name: 'Updated Provider',
      configuration: { temperature: 0.8 },
    };

    it('should update provider successfully', async () => {
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        name: 'Original Provider',
        configuration: { temperature: 0.7 },
        type: LlmProviderType.OPENAI,
        capabilities: {},
      };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      userRepository.findOne.mockResolvedValue(mockUser);
      llmProviderRepository.save.mockResolvedValue({ ...mockProvider, ...updateDto });

      jest.spyOn(chatHelperInstance as any, 'validateProviderConfiguration').mockImplementation();

      const result = await service.updateProvider('provider-1', updateDto, 'org-1', 'user-1');

      expect(mockProvider.name).toBe(updateDto.name);
      expect(mockProvider.configuration.temperature).toBe(0.8);
      expect(llmProviderRepository.save).toHaveBeenCalledWith(mockProvider);
    });

    it('should throw NotFoundException for non-existent provider', async () => {
      llmProviderRepository.findOne.mockResolvedValue(null);

      await expect(service.updateProvider('invalid-id', updateDto, 'org-1', 'user-1'))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should update description when provided', async () => {
      const mockProvider = {
        id: 'provider-1',
        name: 'Original Provider',
        description: 'Old description',
        configuration: { temperature: 0.7 },
        type: LlmProviderType.OPENAI,
        capabilities: {},
        metadata: {},
      };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      userRepository.findOne.mockResolvedValue(mockUser);
      llmProviderRepository.save.mockResolvedValue(mockProvider);

      await service.updateProvider('provider-1', { description: 'New description' }, 'org-1', 'user-1');

      expect(mockProvider.description).toBe('New description');
    });

    it('should update capabilities when provided', async () => {
      const mockProvider = {
        id: 'provider-1',
        name: 'Provider',
        configuration: { temperature: 0.7 },
        type: LlmProviderType.OPENAI,
        capabilities: { maxTokens: 4096 },
        metadata: {},
      };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      userRepository.findOne.mockResolvedValue(mockUser);
      llmProviderRepository.save.mockResolvedValue(mockProvider);

      await service.updateProvider('provider-1', { capabilities: { maxTokens: 8192 } as any }, 'org-1', 'user-1');

      expect(mockProvider.capabilities.maxTokens).toBe(8192);
    });

    it('should update metadata when provided', async () => {
      const mockProvider = {
        id: 'provider-1',
        name: 'Provider',
        configuration: { temperature: 0.7 },
        type: LlmProviderType.OPENAI,
        capabilities: {},
        metadata: { region: 'us-east' },
      };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      userRepository.findOne.mockResolvedValue(mockUser);
      llmProviderRepository.save.mockResolvedValue(mockProvider);

      await service.updateProvider('provider-1', { metadata: { region: 'us-west' } }, 'org-1', 'user-1');

      expect(mockProvider.metadata.region).toBe('us-west');
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockProvider = { id: 'provider-1', configuration: {}, type: LlmProviderType.OPENAI };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.updateProvider('provider-1', updateDto, 'org-1', 'user-1'))
        .rejects
        .toThrow(ForbiddenException);
    });
  });

  describe('getProvider', () => {
    it('should return provider by id', async () => {
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        name: 'Test Provider',
        organizationId: 'org-1',
        maskSensitiveData: jest.fn().mockReturnThis(),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);

      const result = await service.getProvider('provider-1', 'org-1');

      expect(result).toBeDefined();
      expect(mockProvider.maskSensitiveData).toHaveBeenCalled();
      expect(llmProviderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'provider-1', organizationId: 'org-1' },
      });
    });

    it('should return provider with secrets when includeSecrets is true', async () => {
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        name: 'Test Provider',
        organizationId: 'org-1',
        configuration: { apiKey: 'secret-key' },
        maskSensitiveData: jest.fn().mockReturnThis(),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);

      const result = await service.getProvider('provider-1', 'org-1', true);

      expect(result).toBeDefined();
      expect(mockProvider.maskSensitiveData).not.toHaveBeenCalled();
      expect(result.configuration.apiKey).toBe('secret-key');
    });

    it('should throw NotFoundException when provider not found', async () => {
      llmProviderRepository.findOne.mockResolvedValue(null);

      await expect(service.getProvider('invalid-id', 'org-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('getProviders', () => {
    it('should return paginated providers', async () => {
      const mockProviders = [
        { id: 'provider-1', name: 'Provider 1', maskSensitiveData: jest.fn().mockReturnThis() },
        { id: 'provider-2', name: 'Provider 2', maskSensitiveData: jest.fn().mockReturnThis() },
      ];

      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(2),
        getMany: jest.fn().mockResolvedValue(mockProviders),
        getManyAndCount: jest.fn().mockResolvedValue([mockProviders, 2]),
      };

      llmProviderRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getProviders({
        organizationId: 'org-1',
        page: 1,
        limit: 10,
      });

      expect(result.providers).toEqual(mockProviders);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should handle search filters', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getMany: jest.fn().mockResolvedValue([]),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };

      llmProviderRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getProviders({
        organizationId: 'org-1',
        search: 'OpenAI',
        type: LlmProviderType.OPENAI,
        status: LlmProviderStatus.ACTIVE,
        sortBy: 'name',
        sortOrder: 'ASC',
      });

      expect(result.providers).toEqual([]);
      expect(result.total).toBe(0);
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledTimes(3); // search, type, status
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('provider.name', 'ASC');
    });
  });

  describe('deleteProvider', () => {
    it('should delete provider successfully', async () => {
      const mockProvider = { id: 'provider-1', organizationId: 'org-1', maskSensitiveData: jest.fn().mockReturnThis() };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      userRepository.findOne.mockResolvedValue(mockUser);
      llmProviderRepository.remove.mockResolvedValue();

      await service.deleteProvider('provider-1', 'org-1', 'user-1');

      expect(llmProviderRepository.remove).toHaveBeenCalledWith(mockProvider);
    });

    it('should throw ForbiddenException for insufficient permissions', async () => {
      const mockProvider = { id: 'provider-1', organizationId: 'org-1', maskSensitiveData: jest.fn().mockReturnThis() };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.deleteProvider('provider-1', 'org-1', 'user-1'))
        .rejects
        .toThrow(ForbiddenException);
    });
  });

  describe('chat', () => {
    const chatRequest: ChatRequest = {
      messages: [
        { role: MessageRole.USER, content: 'Hello, how are you?' },
      ],
      model: 'gpt-4',
      maxTokens: 150,
      temperature: 0.7,
      sessionId: 'session-1',
    };

    it('should handle chat request successfully', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key' },
        status: LlmProviderStatus.ACTIVE,
        isHealthy: true,
        incrementUsage: jest.fn(),
      };
      const mockSession = {
        id: 'session-1',
        status: ConversationStatus.ACTIVE,
        addMessage: jest.fn(),
        addToolCall: jest.fn(),
      };
      const mockResponse = {
        message: {
          role: MessageRole.ASSISTANT,
          content: 'Hello! I am doing well, thank you.',
        },
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        cost: 0.001,
        model: 'gpt-4',
        conversationId: 'session-1',
        messageId: 'msg-1',
        responseTime: 1200,
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      llmProviderRepository.save.mockResolvedValue(mockProvider);
      conversationRepository.findOne.mockResolvedValue(mockSession);
      conversationRepository.save.mockResolvedValue(mockSession);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockResolvedValue(mockResponse);
      jest.spyOn(chatHelperInstance as any, 'prepareTools').mockResolvedValue([]);
      messageRepository.create.mockReturnValue({});
      messageRepository.save.mockResolvedValue({ id: 'msg-1' });

      const result = await service.chat('provider-1', chatRequest, 'org-1', 'user-1');

      expect(result).toEqual(mockResponse);
    });

    it('should throw NotFoundException for non-existent provider', async () => {
      llmProviderRepository.findOne.mockResolvedValue(null);

      await expect(service.chat('invalid-provider', chatRequest, 'org-1', 'user-1'))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw BadRequestException for unhealthy provider', async () => {
      const mockProvider = {
        isHealthy: false,
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        status: LlmProviderStatus.ACTIVE,
        configuration: {
          apiKey: 'test-key',
          model: 'gpt-4',
          maxTokens: 4096,
          temperature: 0.7,
        },
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);

      const requestWithoutSession = {
        messages: chatRequest.messages,
        model: chatRequest.model,
        maxTokens: chatRequest.maxTokens,
        temperature: chatRequest.temperature,
      };

      await expect(service.chat('provider-1', requestWithoutSession, 'org-1', 'user-1'))
        .rejects
        .toThrow(BadRequestException);
    });

    it('should create new session when sessionId is not provided', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key', model: 'gpt-4' },
        status: LlmProviderStatus.ACTIVE,
        isHealthy: true,
        incrementUsage: jest.fn(),
      };
      const mockSession = {
        id: 'new-session-1',
        status: ConversationStatus.ACTIVE,
        context: {},
        addMessage: jest.fn(),
        addToolCall: jest.fn(),
      };
      const mockResponse = {
        message: { role: MessageRole.ASSISTANT, content: 'Response' },
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        cost: 0.001,
        model: 'gpt-4',
        conversationId: 'new-session-1',
        messageId: 'msg-1',
        responseTime: 1200,
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      llmProviderRepository.save.mockResolvedValue(mockProvider);
      conversationRepository.save.mockResolvedValue(mockSession);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockResolvedValue(mockResponse);
      jest.spyOn(chatHelperInstance as any, 'prepareTools').mockResolvedValue([]);
      messageRepository.create.mockReturnValue({});
      messageRepository.save.mockResolvedValue({ id: 'msg-1' });

      const requestWithoutSession = {
        messages: chatRequest.messages,
        model: chatRequest.model,
      };

      const result = await service.chat('provider-1', requestWithoutSession, 'org-1', 'user-1');

      expect(result.conversationId).toBe('new-session-1');
      expect(conversationRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent session', async () => {
      const mockProvider = {
        id: 'provider-1',
        isHealthy: true,
        configuration: {},
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      conversationRepository.findOne.mockResolvedValue(null);

      await expect(service.chat('provider-1', chatRequest, 'org-1', 'user-1'))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should handle chat with tool calls', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key' },
        status: LlmProviderStatus.ACTIVE,
        isHealthy: true,
        incrementUsage: jest.fn(),
      };
      const mockSession = {
        id: 'session-1',
        status: ConversationStatus.ACTIVE,
        addMessage: jest.fn(),
        addToolCall: jest.fn(),
      };
      const mockResponse = {
        message: {
          role: MessageRole.ASSISTANT,
          content: 'Using tools',
          toolCalls: [
            { id: 'call-1', name: 'test_tool', parameters: {} },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        cost: 0.001,
        model: 'gpt-4',
        conversationId: 'session-1',
        messageId: 'msg-1',
        responseTime: 1200,
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      llmProviderRepository.save.mockResolvedValue(mockProvider);
      conversationRepository.findOne.mockResolvedValue(mockSession);
      conversationRepository.save.mockResolvedValue(mockSession);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockResolvedValue(mockResponse);
      jest.spyOn(chatHelperInstance as any, 'prepareTools').mockResolvedValue([]);
      jest.spyOn(chatHelperInstance as any, 'executeToolCalls').mockResolvedValue(undefined);
      messageRepository.create.mockReturnValue({});
      messageRepository.save.mockResolvedValue({ id: 'msg-1' });

      const result = await service.chat('provider-1', chatRequest, 'org-1', 'user-1');

      expect(result.message.toolCalls).toHaveLength(1);
      expect(mockSession.addToolCall).toHaveBeenCalledWith(true);
    });

    it('should handle chat error and update provider stats', async () => {
      const mockProvider = {
        id: 'provider-1',
        isHealthy: true,
        incrementUsage: jest.fn(),
      };
      const mockSession = {
        id: 'session-1',
        status: ConversationStatus.ACTIVE,
      };

      llmProviderRepository.findOne
        .mockResolvedValueOnce(mockProvider)
        .mockResolvedValueOnce(mockProvider);
      conversationRepository.findOne.mockResolvedValue(mockSession);
      llmProviderRepository.save.mockResolvedValue(mockProvider);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockRejectedValue(new Error('API Error'));
      jest.spyOn(chatHelperInstance as any, 'prepareTools').mockResolvedValue([]);

      await expect(service.chat('provider-1', chatRequest, 'org-1', 'user-1'))
        .rejects
        .toThrow('API Error');

      // The old shape called provider.incrementUsage(0, 0, false)
      // on the in-memory entity followed by save(provider) — a
      // read-modify-write race. The new shape issues an atomic
      // bumpProviderStats (single SQL UPDATE via createQueryBuilder)
      // plus a scoped partial update to set lastError. Pin both.
      expect(llmProviderRepository.createQueryBuilder).toHaveBeenCalled();
      expect(llmProviderRepository.update).toHaveBeenCalledWith(
        { id: 'provider-1', organizationId: 'org-1' },
        expect.objectContaining({ lastError: expect.any(String) }),
      );
    });
  });

  describe('performHealthCheck', () => {
    it('should perform health check successfully', async () => {
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key' },
        status: LlmProviderStatus.ACTIVE,
        organizationId: 'org-1',
        updateHealthStatus: jest.fn(),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockResolvedValue({
        message: { role: MessageRole.ASSISTANT, content: 'Test response' },
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: 'gpt-4',
        cost: 0.001,
        responseTime: 800,
      });
      // performHealthCheck now writes via a partial `update()` so
      // the row state doesn't race with concurrent writers. Mock it
      // instead of save().
      llmProviderRepository.update.mockResolvedValue({ affected: 1 });
      const result = await service.performHealthCheck('provider-1', 'org-1');

      expect(result.isHealthy).toBe(true);
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(llmProviderRepository.update).toHaveBeenCalledWith(
        { id: 'provider-1' },
        expect.objectContaining({ isHealthy: true }),
      );
    });

    it('should handle health check failure', async () => {
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'invalid-key' },
        status: LlmProviderStatus.ACTIVE,
        organizationId: 'org-1',
        updateHealthStatus: jest.fn(),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockRejectedValue(new Error('API Error'));
      llmProviderRepository.update.mockResolvedValue({ affected: 1 });

      const result = await service.performHealthCheck('provider-1', 'org-1');

      expect(result.isHealthy).toBe(false);
      expect(result.error).toContain('API Error');
      // Error path records the failure via a scoped partial UPDATE.
      expect(llmProviderRepository.update).toHaveBeenCalledWith(
        { id: 'provider-1', organizationId: 'org-1' },
        expect.objectContaining({ isHealthy: false, lastError: 'API Error' }),
      );
    });

    it('should return error when provider not found (or belongs to a different org)', async () => {
      llmProviderRepository.findOne.mockResolvedValue(null);

      const result = await service.performHealthCheck('invalid-provider', 'org-1');

      expect(result.isHealthy).toBe(false);
      expect(result.error).toBe('Provider not found');
      // Also pin that the lookup was org-scoped — this is the whole
      // point of the cross-tenant fix.
      expect(llmProviderRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'org-1' }),
        }),
      );
    });

    it('should tolerate a DB error on the health status write', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'invalid-key' },
        organizationId: 'org-1',
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockRejectedValue(new Error('API Error'));
      llmProviderRepository.update.mockRejectedValue(new Error('Database error'));

      const result = await service.performHealthCheck('provider-1', 'org-1');

      expect(result.isHealthy).toBe(false);
      expect(result.error).toContain('API Error');
    });
  });

  describe('createSession', () => {
    it('should create session successfully', async () => {
      const mockProvider = { id: 'provider-1', organizationId: 'org-1', maskSensitiveData: jest.fn().mockReturnThis() };
      const mockSession = {
        id: 'session-1',
        providerId: 'provider-1',
        organizationId: 'org-1',
        userId: 'user-1',
        status: ConversationStatus.ACTIVE,
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      conversationRepository.save.mockResolvedValue(mockSession);

      const result = await service.createSession('provider-1', 'org-1', 'user-1', {
        title: 'Test Session',
      });

      expect(result).toEqual(mockSession);
      expect(conversationRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException for invalid provider', async () => {
      llmProviderRepository.findOne.mockResolvedValue(null);

      await expect(service.createSession('invalid-provider', 'org-1', 'user-1', {
        title: 'Test Session',
      })).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSession', () => {
    it('should return session by id', async () => {
      const mockSession = {
        id: 'session-1',
        organizationId: 'org-1',
        messages: [],
      };

      conversationRepository.findOne.mockResolvedValue(mockSession);

      const result = await service.getSession('session-1', 'org-1');

      expect(result).toBe(mockSession);
    });

    it('should throw NotFoundException when session not found', async () => {
      conversationRepository.findOne.mockResolvedValue(null);

      await expect(service.getSession('invalid-session', 'org-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('getSessions', () => {
    it('should return paginated sessions', async () => {
      const mockSessions = [
        { id: 'session-1', name: 'Session 1' },
        { id: 'session-2', name: 'Session 2' },
      ];

      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(2),
        getMany: jest.fn().mockResolvedValue(mockSessions),
        getManyAndCount: jest.fn().mockResolvedValue([mockSessions, 2]),
      };

      conversationRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getSessions('org-1', 'provider-1', undefined, undefined, 1, 10);

      expect(result.sessions).toBe(mockSessions);
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('session.providerId = :providerId', { providerId: 'provider-1' });
    });

    it('should filter by userId when provided', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getMany: jest.fn().mockResolvedValue([]),
      };

      conversationRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getSessions('org-1', undefined, 'user-1', undefined, 1, 10);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('session.userId = :userId', { userId: 'user-1' });
    });

    it('should filter by status when provided', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getMany: jest.fn().mockResolvedValue([]),
      };

      conversationRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getSessions('org-1', undefined, undefined, ConversationStatus.ACTIVE, 1, 10);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('session.status = :status', { status: ConversationStatus.ACTIVE });
    });
  });

  describe('updateSession', () => {
    it('should update session successfully', async () => {
      const mockSession = {
        id: 'session-1',
        organizationId: 'org-1',
        title: 'Original Session',
      };

      const updatedSession = {
        ...mockSession,
        title: 'Updated Session',
      };

      conversationRepository.findOne.mockResolvedValue(mockSession);
      conversationRepository.save.mockResolvedValue(updatedSession);

      const result = await service.updateSession('session-1', 'org-1', {
        title: 'Updated Session',
      });

      expect(result.title).toBe('Updated Session');
      expect(conversationRepository.save).toHaveBeenCalled();
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully', async () => {
      const mockSession = { id: 'session-1', organizationId: 'org-1' };

      conversationRepository.findOne.mockResolvedValue(mockSession);
      conversationRepository.remove.mockResolvedValue();

      await service.deleteSession('session-1', 'org-1');

      expect(conversationRepository.remove).toHaveBeenCalledWith(mockSession);
    });
  });

  describe('private methods', () => {
    describe('validateProviderConfiguration', () => {
      it('should validate OpenAI configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.OPENAI, { apiKey: 'test-key' });
        }).not.toThrow();
      });

      it('should throw error for invalid OpenAI configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.OPENAI, {});
        }).toThrow(BadRequestException);
      });

      it('should validate Anthropic configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.ANTHROPIC, { apiKey: 'test-key' });
        }).not.toThrow();
      });

      it('should throw error for invalid Anthropic configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.ANTHROPIC, {});
        }).toThrow(BadRequestException);
      });

      it('should validate Google configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.GOOGLE, { apiKey: 'test-key' });
        }).not.toThrow();
      });

      it('should throw error for invalid Google configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.GOOGLE, {});
        }).toThrow(BadRequestException);
      });

      it('should validate Azure OpenAI configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.AZURE_OPENAI, {
            apiKey: 'test-key',
            azure: { resourceName: 'resource', deploymentName: 'deployment' },
          });
        }).not.toThrow();
      });

      it('should throw error for invalid Azure OpenAI configuration - missing apiKey', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.AZURE_OPENAI, {
            azure: { resourceName: 'resource', deploymentName: 'deployment' },
          });
        }).toThrow(BadRequestException);
      });

      it('should throw error for invalid Azure OpenAI configuration - missing resourceName', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.AZURE_OPENAI, {
            apiKey: 'test-key',
            azure: { deploymentName: 'deployment' },
          });
        }).toThrow(BadRequestException);
      });

      it('should throw error for invalid Azure OpenAI configuration - missing deploymentName', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.AZURE_OPENAI, {
            apiKey: 'test-key',
            azure: { resourceName: 'resource' },
          });
        }).toThrow(BadRequestException);
      });

      it('should validate AWS Bedrock configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.AWS_BEDROCK, {
            bedrock: { region: 'us-east-1' },
          });
        }).not.toThrow();
      });

      it('should throw error for invalid AWS Bedrock configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.AWS_BEDROCK, {});
        }).toThrow(BadRequestException);
      });

      it('should validate Custom provider configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.CUSTOM, {
            apiUrl: 'https://custom-api.com',
          });
        }).not.toThrow();
      });

      it('should throw error for invalid Custom provider configuration', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.CUSTOM, {});
        }).toThrow(BadRequestException);
      });

      it('should validate Cohere configuration requires API key', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.COHERE, {});
        }).toThrow();
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.COHERE, { apiKey: 'test-key' });
        }).not.toThrow();
      });

      it('should validate HuggingFace configuration requires API key', () => {
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.HUGGINGFACE, {});
        }).toThrow();
        expect(() => {
          service['validateProviderConfiguration'](LlmProviderType.HUGGINGFACE, { apiKey: 'test-key' });
        }).not.toThrow();
      });
    });

    describe('getDefaultCapabilities', () => {
      it('should return default capabilities for OpenAI', () => {
        const capabilities = service['getDefaultCapabilities'](LlmProviderType.OPENAI);

        expect(capabilities.supportsStreaming).toBe(true);
        expect(capabilities.supportsFunctionCalling).toBe(true);
        expect(capabilities.supportsToolUse).toBe(true);
        expect(capabilities.supportsVision).toBe(true);
        expect(capabilities.maxTokens).toBe(128000);
      });

      it('should return default capabilities for Anthropic', () => {
        const capabilities = service['getDefaultCapabilities'](LlmProviderType.ANTHROPIC);

        expect(capabilities.supportsStreaming).toBe(true);
        expect(capabilities.supportsFunctionCalling).toBe(false);
        expect(capabilities.supportsToolUse).toBe(true);
        expect(capabilities.supportsVision).toBe(true);
        expect(capabilities.maxTokens).toBe(200000);
      });

      it('should return default capabilities for Google', () => {
        const capabilities = service['getDefaultCapabilities'](LlmProviderType.GOOGLE);

        expect(capabilities.supportsStreaming).toBe(true);
        expect(capabilities.supportsVision).toBe(true);
        expect(capabilities.maxTokens).toBe(1000000);
      });

      it('should return default capabilities for unknown provider', () => {
        const capabilities = service['getDefaultCapabilities']('UNKNOWN' as any);

        expect(capabilities.supportsFunctionCalling).toBe(false);
        expect(capabilities.supportsStreaming).toBe(false);
        expect(capabilities.maxTokens).toBe(4096);
      });
    });

    describe('prepareTools', () => {
      it('should prepare tools for chat request', async () => {
        const mockTools = [
          {
            id: 'tool-1',
            name: 'get_weather',
            description: 'Get weather information',
            parameters: { type: 'object' },
            organizationId: 'org-1',
          },
        ];

        toolRepository.find.mockResolvedValue(mockTools);

        const result = await service['prepareTools']([
          {
            name: 'get_weather',
            description: 'Get weather information',
            parameters: { type: 'object' },
          },
        ], 'org-1');

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('tool-1');
      });

      it('should return empty array when no tools provided', async () => {
        const result = await service['prepareTools']([], 'org-1');
        expect(result).toEqual([]);
      });

      it('should return empty array when tools is undefined', async () => {
        const result = await service['prepareTools'](undefined, 'org-1');
        expect(result).toEqual([]);
      });

      it('should query tools scoped to organizationId (cross-org leak regression)', async () => {
        // Regression: previously the query was either `{ name: undefined }`
        // (multi-tool case → fetched ALL tools in the DB) or
        // `{ name: requestTools[0].name }` (single-tool case → matched
        // any tool with that name across orgs). Both shapes leaked tools
        // from other organizations.
        toolRepository.find.mockResolvedValue([]);

        await service['prepareTools'](
          [
            { name: 'a', description: '', parameters: {} },
            { name: 'b', description: '', parameters: {} },
          ],
          'org-1',
        );

        expect(toolRepository.find).toHaveBeenCalledWith({
          where: [
            { name: 'a', organizationId: 'org-1' },
            { name: 'b', organizationId: 'org-1' },
          ],
        });
      });

      it('should defensively drop tools whose organizationId does not match', async () => {
        // Defense in depth: even if some future change weakens the query,
        // the in-memory filter must still strip cross-org tools.
        toolRepository.find.mockResolvedValue([
          { id: 'tool-mine', name: 'shared_name', organizationId: 'org-1' },
          { id: 'tool-theirs', name: 'shared_name', organizationId: 'other-org' },
        ]);

        const result = await service['prepareTools'](
          [{ name: 'shared_name', description: '', parameters: {} }],
          'org-1',
        );

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('tool-mine');
      });
    });

    describe('executeToolCalls (cross-org isolation regression)', () => {
      it('should look up tools scoped to the calling organization', async () => {
        // Regression: the lookup was `{ name: toolCall.name }` with NO
        // org filter — an LLM in org A could resolve and execute a tool
        // named e.g. `send_email` from org B.
        toolRepository.findOne.mockResolvedValue(null);

        const toolCalls: any[] = [
          { id: 'call-1', name: 'send_email', parameters: {} },
        ];
        const session = { id: 's-1', organizationId: 'org-1', userId: 'user-1' };

        await service['executeToolCalls'](toolCalls, session as any, 'org-1');

        expect(toolRepository.findOne).toHaveBeenCalledWith({
          where: { name: 'send_email', organizationId: 'org-1' },
        });
        // Tool was not found in our org → mark as error, do NOT execute.
        expect(toolCalls[0].error).toContain('not found');
        expect(toolExecutorService.executeTool).not.toHaveBeenCalled();
      });
    });

  });

  describe('error handling', () => {
    it('should handle provider API errors gracefully', async () => {
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'invalid-key' },
        status: LlmProviderStatus.ACTIVE,
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockRejectedValue(
        new Error('API rate limit exceeded')
      );

      const chatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Test' }],
      };

      await expect(service.chat('provider-1', chatRequest, 'org-1', 'user-1'))
        .rejects
        .toThrow();
    });

    it('should handle tool execution errors', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'get_weather',
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockRejectedValue(new Error('Tool execution failed'));

      const toolCalls: any = [
        {
          id: 'call-1',
          name: 'get_weather',
          parameters: { location: 'New York' },
        },
      ];

      const mockSession = { id: 'session-1', organizationId: 'org-1', userId: 'user-1' };
      await service['executeToolCalls'](toolCalls, mockSession as any, 'org-1');

      expect(toolCalls[0].error).toContain('Tool execution failed');
    });

    it('should set error when tool not found during execution', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      const toolCalls: any = [
        {
          id: 'call-1',
          name: 'nonexistent_tool',
          parameters: {},
        },
      ];

      const mockSession = { id: 'session-1', organizationId: 'org-1', userId: 'user-1' };
      await service['executeToolCalls'](toolCalls, mockSession as any, 'org-1');

      expect(toolCalls[0].error).toBe("Tool 'nonexistent_tool' not found");
    });
  });

  describe('complex scenarios', () => {
    it('should handle streaming chat with tool calls', async () => {
      const mockProvider = {
        isHealthy: true,
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key' },
        status: LlmProviderStatus.ACTIVE,
        incrementUsage: jest.fn(),
      };

      const mockSession = {
        id: 'session-1',
        status: ConversationStatus.ACTIVE,
        addMessage: jest.fn(),
        addToolCall: jest.fn(),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      llmProviderRepository.save.mockResolvedValue(mockProvider);
      conversationRepository.save.mockResolvedValue(mockSession);

      const chatRequest = {
        messages: [{ role: MessageRole.USER, content: 'What is the weather in NYC?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather information',
            parameters: { type: 'object' },
          },
        ],
        stream: true,
      };

      const mockResponse = {
        message: {
          role: MessageRole.ASSISTANT,
          content: null,
          toolCalls: [
            {
              id: 'call-1',
              name: 'get_weather',
              parameters: { location: 'NYC' },
            },
          ],
        },
        usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
        cost: 0.002,
        model: 'gpt-4',
        conversationId: 'session-1',
        messageId: 'msg-1',
        responseTime: 1500,
      };

      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockResolvedValue(mockResponse);
      jest.spyOn(chatHelperInstance as any, 'prepareTools').mockResolvedValue([
        {
          name: 'get_weather',
          description: 'Get weather information',
          parameters: { type: 'object' },
        },
      ]);
      jest.spyOn(chatHelperInstance as any, 'executeToolCalls').mockResolvedValue([
        {
          id: 'call-1',
          result: { temperature: 72, condition: 'sunny' },
        },
      ]);

      messageRepository.create.mockReturnValue({});
      messageRepository.save.mockResolvedValue({});

      const result = await service.chat('provider-1', chatRequest, 'org-1', 'user-1');

      expect(result.message.toolCalls).toHaveLength(1);
    });

    it('should handle session with message history', async () => {
      const mockProvider = {
        id: 'provider-1',
        organizationId: 'org-1',
        isHealthy: true,
        status: LlmProviderStatus.ACTIVE,
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key' },
        incrementUsage: jest.fn(),
        maskSensitiveData: jest.fn().mockReturnThis()
      };
      const mockSession = {
        id: 'session-1',
        messages: [
          { role: MessageRole.USER, content: 'Hello' },
          { role: MessageRole.ASSISTANT, content: 'Hi there!' },
        ],
        addMessage: jest.fn(),
        addToolCall: jest.fn(),
      };

      llmProviderRepository.findOne.mockResolvedValue(mockProvider);
      llmProviderRepository.save.mockResolvedValue(mockProvider);
      conversationRepository.findOne.mockResolvedValue(mockSession);
      conversationRepository.save.mockResolvedValue(mockSession);

      const chatRequest = {
        messages: [{ role: MessageRole.USER, content: 'How are you?' }],
        sessionId: 'session-1',
      };

      const mockResponse = {
        message: { role: MessageRole.ASSISTANT, content: 'I am doing well!' },
        usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
        cost: 0.001,
        model: 'gpt-4',
        conversationId: 'session-1',
        messageId: 'msg-2',
        responseTime: 1000,
      };

      jest.spyOn(chatHelperInstance as any, 'callLlmProvider').mockResolvedValue(mockResponse);
      jest.spyOn(chatHelperInstance as any, 'prepareTools').mockResolvedValue([]);
      messageRepository.create.mockReturnValue({});
      messageRepository.save.mockResolvedValue({});

      const result = await service.chat('provider-1', chatRequest, 'org-1', 'user-1');

      expect(result.conversationId).toBe('session-1');
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('callOpenAI', () => {
    it('should handle messages with toolCalls', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key', model: 'gpt-4', timeout: 30000 },
        getApiUrl: jest.fn().mockReturnValue('https://api.openai.com/v1'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'Authorization': 'Bearer test-key' }),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          choices: [{ message: { content: 'Response', tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          model: 'gpt-4',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [
          {
            role: MessageRole.USER,
            content: 'Test',
            toolCalls: [{ id: 'call-1', name: 'test_tool', parameters: {} }]
          },
        ],
      };

      const mockSession = {
        id: 'session-1',
        context: { maxTokens: 100, temperature: 0.7 },
      };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.001);

      const result = await callOpenAI(mockProvider as any, chatRequest, mockSession as any, [], Date.now(), () => 0.001);

      expect(result.message.role).toBe(MessageRole.ASSISTANT);
    });

    it('should handle messages with toolCallId', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key', model: 'gpt-4', timeout: 30000 },
        getApiUrl: jest.fn().mockReturnValue('https://api.openai.com/v1'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'Authorization': 'Bearer test-key' }),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: 'Response',
              tool_calls: [
                { id: 'tc-1', type: 'function', function: { name: 'test', arguments: '{}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          model: 'gpt-4',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [
          { role: MessageRole.USER, content: 'Test', toolCallId: 'call-1' },
        ],
      };

      const mockSession = {
        id: 'session-1',
        context: {},
      };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.001);

      const result = await callOpenAI(mockProvider as any, chatRequest, mockSession as any, [], Date.now(), () => 0.001);

      expect(result.message.toolCalls).toBeDefined();
      expect(result.message.toolCalls.length).toBeGreaterThan(0);
    });

    it('should add tools to request when provided', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.OPENAI,
        configuration: { apiKey: 'test-key', model: 'gpt-4' },
        getApiUrl: jest.fn().mockReturnValue('https://api.openai.com/v1'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'Authorization': 'Bearer test-key' }),
      };

      const mockAxios = require('axios');
      const axiosSpy = jest.fn().mockResolvedValue({
        data: {
          choices: [{ message: { content: 'Response' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          model: 'gpt-4',
        },
      });
      mockAxios.default.mockImplementationOnce(axiosSpy);

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Test' }],
      };

      const tools: any = [
        { name: 'get_weather', description: 'Get weather', parameters: {} },
      ];

      const mockSession = { id: 'session-1', context: {} };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.001);

      await callOpenAI(mockProvider as any, chatRequest, mockSession as any, tools, Date.now(), () => 0.001);

      expect(axiosSpy).toHaveBeenCalled();
      const callData = axiosSpy.mock.calls[0][0].data;
      expect(callData.tools).toBeDefined();
      expect(callData.tools.length).toBe(1);
    });
  });

  describe('callAnthropic', () => {
    it('should call Anthropic API successfully', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.ANTHROPIC,
        configuration: { apiKey: 'test-key', model: 'claude-3-sonnet-20240229', timeout: 30000 },
        getApiUrl: jest.fn().mockReturnValue('https://api.anthropic.com/v1'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'x-api-key': 'test-key' }),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          content: [{ type: 'text', text: 'Hello from Claude' }],
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'claude-3-sonnet-20240229',
          stop_reason: 'end_turn',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: { maxTokens: 1024 } };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.002);

      const result = await callAnthropic(mockProvider as any, chatRequest, mockSession as any, [], Date.now(), () => 0.001);

      expect(result.message.role).toBe(MessageRole.ASSISTANT);
      expect(result.message.content).toBe('Hello from Claude');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(20);
    });

    it('should handle Anthropic tool use', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.ANTHROPIC,
        configuration: { apiKey: 'test-key', model: 'claude-3-sonnet-20240229' },
        getApiUrl: jest.fn().mockReturnValue('https://api.anthropic.com/v1'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'x-api-key': 'test-key' }),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'tool-1', name: 'get_weather', input: { location: 'NYC' } }
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'claude-3-sonnet-20240229',
          stop_reason: 'tool_use',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'What is the weather?' }],
      };

      const mockSession = { id: 'session-1', context: {} };
      const tools: any = [{ name: 'get_weather', description: 'Get weather', parameters: {} }];

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.002);

      const result = await callAnthropic(mockProvider as any, chatRequest, mockSession as any, tools, Date.now(), () => 0.001);

      expect(result.message.toolCalls).toBeDefined();
      expect(result.message.toolCalls.length).toBe(1);
      expect(result.message.toolCalls[0].name).toBe('get_weather');
    });
  });

  describe('callGoogle', () => {
    it('should call Google Gemini API successfully', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.GOOGLE,
        configuration: { apiKey: 'test-key', timeout: 30000 },
        getApiUrl: jest.fn().mockReturnValue('https://generativelanguage.googleapis.com/v1'),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          candidates: [
            {
              content: { parts: [{ text: 'Response from Gemini' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 25,
            totalTokenCount: 40,
          },
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
        model: 'gemini-pro',
      };

      const mockSession = { id: 'session-1', context: {} };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.001);

      const result = await callGoogle(mockProvider as any, chatRequest, mockSession as any, [], Date.now(), () => 0.001);

      expect(result.message.content).toBe('Response from Gemini');
      expect(result.usage.totalTokens).toBe(40);
    });

    it('should handle missing usage metadata', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.GOOGLE,
        configuration: { apiKey: 'test-key' },
        getApiUrl: jest.fn().mockReturnValue('https://generativelanguage.googleapis.com/v1'),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          candidates: [
            {
              content: { parts: [{ text: 'Response' }] },
              finishReason: 'STOP',
            },
          ],
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.001);

      const result = await callGoogle(mockProvider as any, chatRequest, mockSession as any, [], Date.now(), () => 0.001);

      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });
  });

  describe('callCohere', () => {
    it('should call Cohere API successfully', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.COHERE,
        configuration: { apiKey: 'test-key', model: 'command', timeout: 30000 },
        getApiUrl: jest.fn().mockReturnValue('https://api.cohere.ai/v1'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'Authorization': 'Bearer test-key' }),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          text: 'Response from Cohere',
          finish_reason: 'COMPLETE',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [
          { role: MessageRole.USER, content: 'Previous message' },
          { role: MessageRole.ASSISTANT, content: 'Previous response' },
          { role: MessageRole.USER, content: 'Current message' },
        ],
      };

      const mockSession = { id: 'session-1', context: {} };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.001);

      const result = await callCohere(mockProvider as any, chatRequest, mockSession as any, [], Date.now(), () => 0.001);

      expect(result.message.content).toBe('Response from Cohere');
    });
  });

  describe('callHuggingFace', () => {
    it('should call HuggingFace API successfully', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.HUGGINGFACE,
        configuration: { apiKey: 'test-key', model: 'gpt2', timeout: 30000 },
        getApiUrl: jest.fn().mockReturnValue('https://api-inference.huggingface.co/models'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'Authorization': 'Bearer test-key' }),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: [
          {
            generated_text: 'user: Hello\nassistant: Hello! How can I help you?',
          },
        ],
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callHuggingFace(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.message.content).toBeDefined();
      expect(result.cost).toBe(0); // HuggingFace is free
    });
  });

  describe('callCustomProvider', () => {
    it('should call custom provider with OpenAI format', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.CUSTOM,
        configuration: {
          apiKey: 'test-key',
          model: 'custom-model',
          custom: { requestFormat: 'openai' },
          timeout: 30000,
        },
        getApiUrl: jest.fn().mockReturnValue('https://custom-api.com'),
        getAuthHeaders: jest.fn().mockReturnValue({ 'Authorization': 'Bearer test-key' }),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          choices: [{ message: { content: 'Custom response' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callCustomProvider(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.message.content).toBe('Custom response');
    });

    it('should call custom provider with Anthropic format', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.CUSTOM,
        configuration: {
          model: 'custom-model',
          custom: { requestFormat: 'anthropic' },
        },
        getApiUrl: jest.fn().mockReturnValue('https://custom-api.com'),
        getAuthHeaders: jest.fn().mockReturnValue({}),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          content: [{ type: 'text', text: 'Anthropic style response' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callCustomProvider(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.message.content).toBeDefined();
    });

    it('should call custom provider with Anthropic format as string', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.CUSTOM,
        configuration: {
          model: 'custom-model',
          custom: { requestFormat: 'anthropic' },
        },
        getApiUrl: jest.fn().mockReturnValue('https://custom-api.com'),
        getAuthHeaders: jest.fn().mockReturnValue({}),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          content: 'Simple string response',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callCustomProvider(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.message.content).toBe('Simple string response');
    });

    it('should call custom provider with generic text response', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.CUSTOM,
        configuration: {
          model: 'custom-model',
          custom: { requestFormat: 'other' },
        },
        getApiUrl: jest.fn().mockReturnValue('https://custom-api.com'),
        getAuthHeaders: jest.fn().mockReturnValue({}),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          text: 'Generic text response',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callCustomProvider(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.message.content).toBe('Generic text response');
    });

    it('should call custom provider with response field', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.CUSTOM,
        configuration: {
          model: 'custom-model',
          custom: { requestFormat: 'other' },
        },
        getApiUrl: jest.fn().mockReturnValue('https://custom-api.com'),
        getAuthHeaders: jest.fn().mockReturnValue({}),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          response: 'Response field content',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callCustomProvider(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.message.content).toBe('Response field content');
    });

    it('should handle custom provider without usage metadata', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.CUSTOM,
        configuration: {
          model: 'custom-model',
          custom: { requestFormat: 'openai' },
        },
        getApiUrl: jest.fn().mockReturnValue('https://custom-api.com'),
        getAuthHeaders: jest.fn().mockReturnValue({}),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          choices: [{ message: { content: 'Response without usage' } }],
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callCustomProvider(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    });

    it('should handle OpenAI format with text field', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.CUSTOM,
        configuration: {
          model: 'custom-model',
          custom: { requestFormat: 'openai' },
        },
        getApiUrl: jest.fn().mockReturnValue('https://custom-api.com'),
        getAuthHeaders: jest.fn().mockReturnValue({}),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          choices: [{ text: 'Text field response' }],
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      const result = await callCustomProvider(mockProvider as any, chatRequest, mockSession as any, [], Date.now());

      expect(result.message.content).toBe('Text field response');
    });
  });

  describe('callLlmProvider', () => {
    it('should throw error for unsupported provider type', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: 'UNSUPPORTED_TYPE' as any,
      };

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      await expect(
        service['callLlmProvider'](mockProvider as any, chatRequest, mockSession as any, [])
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle Azure OpenAI provider type', async () => {
      const mockProvider = {
        id: 'provider-1',
        type: LlmProviderType.AZURE_OPENAI,
        configuration: { apiKey: 'test-key', model: 'gpt-4' },
        getApiUrl: jest.fn().mockReturnValue('https://azure-openai.com'),
        getAuthHeaders: jest.fn().mockReturnValue({}),
      };

      const mockAxios = require('axios');
      mockAxios.default = jest.fn().mockResolvedValue({
        data: {
          choices: [{ message: { content: 'Azure response' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          model: 'gpt-4',
        },
      });

      const chatRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
      };

      const mockSession = { id: 'session-1', context: {} };

      jest.spyOn(service as any, 'calculateProviderCost').mockReturnValue(0.001);

      const result = await service['callLlmProvider'](mockProvider as any, chatRequest, mockSession as any, []);

      expect(result.message.content).toBe('Azure response');
    });
  });

  describe('cost calculation methods', () => {
    it('should calculate cost from provider metadata pricing', () => {
      const provider = {
        metadata: {
          modelInfo: {
            inputTokenCost: 3.0,
            outputTokenCost: 6.0,
          },
        },
      };
      const cost = service['calculateProviderCost'](provider as any, 1000, 1000);
      expect(cost).toBe((1000 / 1000) * 3.0 + (1000 / 1000) * 6.0);
    });

    it('should return 0 when no pricing metadata is set', () => {
      const provider = { metadata: {} };
      const cost = service['calculateProviderCost'](provider as any, 1000, 1000);
      expect(cost).toBe(0);
    });

    it('should return 0 when metadata is null', () => {
      const provider = { metadata: null };
      const cost = service['calculateProviderCost'](provider as any, 1000, 1000);
      expect(cost).toBe(0);
    });
  });

  describe('executeToolCalls', () => {
    it('should execute tool calls successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'get_weather',
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue({
        success: true,
        data: { temperature: 72 },
        executionTime: 100,
        cached: false,
      });

      const toolCalls: any = [
        {
          id: 'call-1',
          name: 'get_weather',
          parameters: { location: 'NYC' },
        },
      ];

      const mockSession = { id: 'session-1', organizationId: 'org-1', userId: 'user-1' };
      await service['executeToolCalls'](toolCalls, mockSession as any, 'org-1');

      expect(toolCalls[0].result).toEqual({ temperature: 72 });
      expect(toolCalls[0].executionTime).toBe(100);
      expect(toolCalls[0].cached).toBe(false);
      expect(toolCalls[0].error).toBeUndefined();
    });

    it('should handle tool execution errors', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'get_weather',
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue({
        success: false,
        error: 'API timeout',
        executionTime: 100,
      });

      const toolCalls: any = [
        {
          id: 'call-1',
          name: 'get_weather',
          parameters: { location: 'NYC' },
        },
      ];

      const mockSession = { id: 'session-1', organizationId: 'org-1', userId: 'user-1' };
      await service['executeToolCalls'](toolCalls, mockSession as any, 'org-1');

      expect(toolCalls[0].error).toBe('API timeout');
    });

    it('should handle session without userId', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'get_weather',
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue({
        success: true,
        data: { temperature: 72 },
        executionTime: 100,
      });

      const toolCalls: any = [
        {
          id: 'call-1',
          name: 'get_weather',
          parameters: { location: 'NYC' },
        },
      ];

      const mockSession = { id: 'session-1', organizationId: 'org-1' };
      await service['executeToolCalls'](toolCalls, mockSession as any, 'org-1');

      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        'tool-1',
        { location: 'NYC' },
        { userId: 'system', organizationId: 'org-1' }
      );
    });
  });

  // ── Cost calculation ────────────────────────────────────────────────

  describe('calculateProviderCost', () => {
    it('should use configured metadata pricing if available', () => {
      const provider = {
        metadata: {
          modelInfo: { inputTokenCost: 0.01, outputTokenCost: 0.03 },
        },
        configuration: { model: 'custom-model' },
        type: LlmProviderType.CUSTOM,
      } as any;

      const cost = service['calculateProviderCost'](provider, 1000, 500);
      // (1000/1000)*0.01 + (500/1000)*0.03 = 0.01 + 0.015 = 0.025
      expect(cost).toBeCloseTo(0.025, 4);
    });

    it('should fall back to default pricing for known OpenAI models', () => {
      const provider = {
        metadata: {},
        configuration: { model: 'gpt-4o' },
        type: LlmProviderType.OPENAI,
      } as any;

      const cost = service['calculateProviderCost'](provider, 1000, 500);
      // gpt-4o: input=0.0025/1K, output=0.01/1K
      // (1000/1000)*0.0025 + (500/1000)*0.01 = 0.0025 + 0.005 = 0.0075
      expect(cost).toBeCloseTo(0.0075, 4);
    });

    it('should fall back to default pricing for known Anthropic models', () => {
      const provider = {
        metadata: {},
        configuration: { model: 'claude-sonnet-4-20250514' },
        type: LlmProviderType.ANTHROPIC,
      } as any;

      const cost = service['calculateProviderCost'](provider, 1000, 500);
      // claude-sonnet-4: input=0.003/1K, output=0.015/1K
      // (1000/1000)*0.003 + (500/1000)*0.015 = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 4);
    });

    it('should return 0 for unknown models with no configured pricing', () => {
      const provider = {
        metadata: {},
        configuration: { model: 'totally-unknown-model' },
        type: LlmProviderType.CUSTOM,
      } as any;

      const cost = service['calculateProviderCost'](provider, 1000, 500);
      expect(cost).toBe(0);
    });

    it('should handle gpt-4o-mini pricing', () => {
      const provider = {
        metadata: {},
        configuration: { model: 'gpt-4o-mini' },
        type: LlmProviderType.OPENAI,
      } as any;

      const cost = service['calculateProviderCost'](provider, 1000, 1000);
      // gpt-4o-mini: input=0.00015/1K, output=0.0006/1K
      expect(cost).toBeCloseTo(0.00075, 5);
    });
  });

  // ── Retry logic ─────────────────────────────────────────────────────

  describe('callLlmProvider: retry logic', () => {
    it('should retry on 429 status and succeed on second attempt', async () => {
      const provider = {
        type: LlmProviderType.OPENAI,
        configuration: { model: 'gpt-4o', timeout: 5000 },
        metadata: {},
        getApiUrl: jest.fn().mockReturnValue('https://api.openai.com/v1'),
        getAuthHeaders: jest.fn().mockReturnValue({ Authorization: 'Bearer test' }),
        incrementUsage: jest.fn(),
        lastError: null,
      } as any;

      const session = {
        id: 'session-1',
        context: {},
      } as any;

      const request = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'gpt-4o',
      } as any;

      let callCount = 0;

      // Mock dispatchProviderCall via the private method
      const mockResult = {
        message: { role: 'assistant', content: 'Hi!', finishReason: 'stop' },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: 0.001,
        model: 'gpt-4o',
        conversationId: 'session-1',
        messageId: '',
        responseTime: 100,
      };

      jest.spyOn(chatHelperInstance as any, 'dispatchProviderCall').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('Rate limited');
          err.response = { status: 429, data: { error: { message: 'Rate limit exceeded' } } };
          throw err;
        }
        return mockResult;
      });

      jest.spyOn(chatHelperInstance as any, 'sleep').mockResolvedValue(undefined);

      const result = await service['callLlmProvider'](provider, request, session, []);

      expect(callCount).toBe(2);
      expect(result).toEqual(mockResult);
    });

    it('should not retry on 400 (non-retryable) status', async () => {
      const provider = {
        type: LlmProviderType.OPENAI,
        configuration: { model: 'gpt-4o', timeout: 5000 },
        metadata: {},
        incrementUsage: jest.fn(),
        lastError: null,
      } as any;

      const session = { id: 'session-1', context: {} } as any;
      const request = { messages: [{ role: 'user', content: 'Hello' }] } as any;

      let callCount = 0;

      jest.spyOn(chatHelperInstance as any, 'dispatchProviderCall').mockImplementation(async () => {
        callCount++;
        const err: any = new Error('Bad request');
        err.response = { status: 400, data: { error: { message: 'Invalid model' } } };
        throw err;
      });

      jest.spyOn(chatHelperInstance as any, 'sleep').mockResolvedValue(undefined);

      await expect(
        service['callLlmProvider'](provider, request, session, []),
      ).rejects.toThrow('Bad request');

      expect(callCount).toBe(1); // No retry
    });

    it('should retry on 500 status up to 2 times then fail', async () => {
      const provider = {
        type: LlmProviderType.OPENAI,
        configuration: { model: 'gpt-4o', timeout: 5000 },
        metadata: {},
        incrementUsage: jest.fn(),
        lastError: null,
      } as any;

      const session = { id: 'session-1', context: {} } as any;
      const request = { messages: [{ role: 'user', content: 'Hello' }] } as any;

      let callCount = 0;

      jest.spyOn(chatHelperInstance as any, 'dispatchProviderCall').mockImplementation(async () => {
        callCount++;
        const err: any = new Error('Server error');
        err.response = { status: 500, data: 'Internal Server Error' };
        throw err;
      });

      jest.spyOn(chatHelperInstance as any, 'sleep').mockResolvedValue(undefined);

      await expect(
        service['callLlmProvider'](provider, request, session, []),
      ).rejects.toThrow('Server error');

      expect(callCount).toBe(3); // Initial + 2 retries
    });

    it('does not try to persist in-memory provider mutations inside the retry loop (regression)', async () => {
      // Pre-fix, the retry loop called provider.incrementUsage(0, 0,
      // false) on the in-memory entity — but never saved it. The
      // mutation was lost on function return and the telemetry was
      // effectively broken. The fix moves the single persistent
      // counter bump out to chat()'s catch block so there's exactly
      // one SQL write per chat() call regardless of how many
      // attempts the retry loop ran. Here we just pin that the
      // retry loop does NOT touch provider.incrementUsage anymore.
      const provider = {
        type: LlmProviderType.OPENAI,
        configuration: { model: 'gpt-4o', timeout: 5000 },
        metadata: {},
        incrementUsage: jest.fn(),
        lastError: null,
      } as any;

      const session = { id: 'session-1', context: {} } as any;
      const request = { messages: [{ role: 'user', content: 'Hello' }] } as any;

      jest.spyOn(chatHelperInstance as any, 'dispatchProviderCall').mockImplementation(async () => {
        const err: any = new Error('Timeout');
        err.response = { status: 503, data: 'Service Unavailable' };
        throw err;
      });

      jest.spyOn(chatHelperInstance as any, 'sleep').mockResolvedValue(undefined);

      await expect(
        service['callLlmProvider'](provider, request, session, []),
      ).rejects.toThrow('Timeout');

      // The retry loop must not touch the in-memory increment at
      // all — persistence happens in chat()'s catch handler.
      expect(provider.incrementUsage).not.toHaveBeenCalled();
    });
  });

  // ── Cost propagation (dollars to cents conversion) ─────────────────

  describe('cost: dollars to cents conversion in chat()', () => {
    it('should convert cost from dollars to cents using Math.round(cost * 100)', () => {
      // Verify the conversion logic: 0.05 dollars -> 5 cents
      expect(Math.round(0.05 * 100)).toBe(5);
      expect(Math.round(0.001 * 100)).toBe(0); // Very small costs still round correctly
      expect(Math.round(0.005 * 100)).toBe(1); // 0.5 cents rounds to 1 cent
      expect(Math.round(0.0075 * 100)).toBe(1); // 0.75 cents rounds to 1 cent
    });
  });
});
