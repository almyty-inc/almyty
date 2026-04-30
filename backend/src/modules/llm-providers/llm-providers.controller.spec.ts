import { Test, TestingModule } from '@nestjs/testing';
import { LlmSessionsController } from './llm-sessions.controller';
import { LlmModelsHelper } from './llm-models.helper';
import { LlmProvidersController } from './llm-providers.controller';
import { LlmProvidersService } from './llm-providers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

describe('LlmProvidersController', () => {
  let controller: LlmProvidersController;
  let sessionsController: LlmSessionsController;
  let llmProvidersService: jest.Mocked<LlmProvidersService>;
  let modelsHelper: jest.Mocked<LlmModelsHelper>;

  beforeEach(async () => {
    const mockLlmProvidersService = {
      createProvider: jest.fn(),
      getProviders: jest.fn(),
      getProvider: jest.fn(),
      updateProvider: jest.fn(),
      deleteProvider: jest.fn(),
      chat: jest.fn(),
      performHealthCheck: jest.fn(),
      fetchModelsFromProvider: jest.fn(),
      fetchModelsByType: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LlmProvidersController, LlmSessionsController],
      providers: [
        {
          provide: LlmProvidersService,
          useValue: mockLlmProvidersService,
        },
        {
          provide: LlmModelsHelper,
          useValue: { fetchModelsFromProvider: jest.fn(), fetchModelsByType: jest.fn() },
        },
      ],
    })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<LlmProvidersController>(LlmProvidersController);
    sessionsController = module.get<LlmSessionsController>(LlmSessionsController);
    llmProvidersService = module.get(LlmProvidersService);
    modelsHelper = module.get(LlmModelsHelper);
  });

  describe('createProvider', () => {
    it('should create provider successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const createDto = {
        name: 'OpenAI GPT-4',
        type: 'openai' as any,
        configuration: { apiKey: 'sk-test', model: 'gpt-4' },
      };

      const mockProvider = {
        id: 'provider-1',
        ...createDto,
        organizationId: 'org-1',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        toPublicView: jest.fn().mockReturnValue({ id: 'provider-1', name: 'OpenAI GPT-4' }),
      } as any;

      llmProvidersService.createProvider.mockResolvedValue(mockProvider);

      const result = await controller.createProvider(createDto, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.any(Object));
    });
  });

  describe('getProviders', () => {
    it('should return paginated providers', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const mockResult = {
        providers: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };

      llmProvidersService.getProviders.mockResolvedValue(mockResult);

      const result = await controller.getProviders({ page: 1, limit: 10 }, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
    });
  });

  describe('getProvider', () => {
    it('should return provider by id', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const mockProvider = {
        id: 'provider-1',
        name: 'OpenAI GPT-4',
        type: 'openai',
        organizationId: 'org-1',
        isActive: true,
        toPublicView: jest.fn().mockReturnValue({ id: 'provider-1', name: 'OpenAI GPT-4' }),
      } as any;

      llmProvidersService.getProvider.mockResolvedValue(mockProvider);

      const result = await controller.getProvider('provider-1', 'user-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.any(Object));
    });
  });

  describe('updateProvider', () => {
    it('should update provider successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const updateDto = { name: 'Updated Provider' };
      const mockProvider = {
        id: 'provider-1',
        name: 'Updated Provider',
        type: 'openai',
        organizationId: 'org-1',
        toPublicView: jest.fn().mockReturnValue({ id: 'provider-1', name: 'Updated Provider' }),
      } as any;

      llmProvidersService.updateProvider.mockResolvedValue(mockProvider);

      const result = await controller.updateProvider('provider-1', updateDto, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.any(Object));
    });
  });

  describe('deleteProvider', () => {
    it('should delete provider successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };

      llmProvidersService.deleteProvider.mockResolvedValue();

      const result = await controller.deleteProvider('provider-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.message).toBe('LLM provider deleted successfully');
    });
  });

  describe('chat', () => {
    it('should handle chat request successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const chatDto = {
        messages: [{ role: 'user' as any, content: 'Hello' }],
        model: 'gpt-4',
      };
      const mockResponse = {
        message: { role: 'assistant' as any, content: 'Hello! How can I help you?' },
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        cost: 0.001,
        model: 'gpt-4',
        conversationId: 'conversation-1',
        messageId: 'msg-1',
        responseTime: 150,
      };

      llmProvidersService.chat.mockResolvedValue(mockResponse);

      const result = await controller.chat('provider-1', chatDto, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResponse);
    });
  });

  describe('performHealthCheck', () => {
    it('should perform health check successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const mockResult = {
        isHealthy: true,
        responseTime: 150,
      };

      llmProvidersService.performHealthCheck.mockResolvedValue(mockResult);

      const result = await controller.performHealthCheck('provider-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
    });
  });

  describe('getProviderTypes', () => {
    it('should return available provider types', async () => {
      const result = await controller.getProviderTypes();

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.any(Array));
    });
  });

  describe('getProvider - with secrets', () => {
    it('should return provider with secrets for admin', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }], roles: ['admin'] } };
      const mockProvider = {
        id: 'provider-1',
        name: 'OpenAI GPT-4',
        configuration: { apiKey: 'sk-test' },
        toPublicView: jest.fn().mockReturnValue({ id: 'provider-1', name: 'OpenAI GPT-4' }),
      } as any;

      llmProvidersService.getProvider.mockResolvedValue(mockProvider);

      const result = await controller.getProvider('provider-1', 'true', mockRequest);

      expect(result.success).toBe(true);
      expect(llmProvidersService.getProvider).toHaveBeenCalledWith('provider-1', 'org-1', true);
    });

    it('should return provider without secrets for member', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }], roles: ['member'] } };
      const mockProvider = {
        id: 'provider-1',
        name: 'OpenAI GPT-4',
        toPublicView: jest.fn().mockReturnValue({ id: 'provider-1', name: 'OpenAI GPT-4' }),
      } as any;

      llmProvidersService.getProvider.mockResolvedValue(mockProvider);

      const result = await controller.getProvider('provider-1', 'true', mockRequest);

      expect(result.success).toBe(true);
      expect(llmProvidersService.getProvider).toHaveBeenCalledWith('provider-1', 'org-1', false);
    });
  });

  describe('createSession', () => {
    it('should create session successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const createDto = { type: 'chat' as any, title: 'Test Session' };
      const mockSession = { id: 'session-1', ...createDto };

      (llmProvidersService as any).createSession = jest.fn().mockResolvedValue(mockSession);

      const result = await sessionsController.createSession('provider-1', createDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockSession);
    });
  });

  describe('getSessions', () => {
    it('should return provider sessions', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const mockResult = { sessions: [], total: 0, page: 1, limit: 20 };

      (llmProvidersService as any).getSessions = jest.fn().mockResolvedValue(mockResult);

      const result = await sessionsController.getSessions('provider-1', undefined, undefined, 1, 20, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
    });

    it('should limit results to 100', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const mockResult = { sessions: [], total: 0, page: 1, limit: 100 };

      (llmProvidersService as any).getSessions = jest.fn().mockResolvedValue(mockResult);

      await sessionsController.getSessions('provider-1', undefined, undefined, 1, 200, mockRequest);

      expect((llmProvidersService as any).getSessions).toHaveBeenCalledWith('org-1', 'provider-1', undefined, undefined, 1, 100);
    });
  });

  describe('getSession', () => {
    it('should return session by id', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const mockSession = { id: 'session-1', title: 'Test Session' };

      (llmProvidersService as any).getSession = jest.fn().mockResolvedValue(mockSession);

      const result = await sessionsController.getSession('session-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockSession);
    });
  });

  describe('updateSession', () => {
    it('should update session successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const updateDto = { title: 'Updated Session' };
      const mockSession = { id: 'session-1', title: 'Updated Session' };

      (llmProvidersService as any).updateSession = jest.fn().mockResolvedValue(mockSession);

      const result = await sessionsController.updateSession('session-1', updateDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockSession);
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };

      (llmProvidersService as any).deleteSession = jest.fn().mockResolvedValue(undefined);

      const result = await sessionsController.deleteSession('session-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Session deleted successfully');
    });
  });

  describe('getProviderModels', () => {
    it('should return available models for provider (fetched dynamically)', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const mockProvider = { id: 'provider-1', type: 'openai' } as any;
      const mockModels = [
        { id: 'gpt-4', name: 'gpt-4' },
        { id: 'gpt-3.5-turbo', name: 'gpt-3.5-turbo' },
      ];

      llmProvidersService.getProvider.mockResolvedValue(mockProvider);
      modelsHelper.fetchModelsFromProvider.mockResolvedValue(mockModels);

      const result = await controller.getProviderModels('provider-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('gpt-4');
    });
  });

  // Error handling tests for all branches
  describe('createProvider - error handling', () => {
    it('should handle creation error', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const createDto = { name: 'Provider', type: 'openai' as any, configuration: {} };

      llmProvidersService.createProvider.mockRejectedValue(new Error('Creation failed'));

      await expect(controller.createProvider(createDto, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getProviders - error handling', () => {
    it('should handle retrieval error', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      llmProvidersService.getProviders.mockRejectedValue(new Error('Retrieval failed'));

      await expect(controller.getProviders({} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getProvider - error handling', () => {
    it('should handle not found error', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      llmProvidersService.getProvider.mockRejectedValue(new Error('Not found'));

      await expect(controller.getProvider('provider-1', 'false', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('updateProvider - error handling', () => {
    it('should handle update error', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      llmProvidersService.updateProvider.mockRejectedValue(new Error('Update failed'));

      await expect(controller.updateProvider('provider-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('deleteProvider - error handling', () => {
    it('should handle deletion error', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      llmProvidersService.deleteProvider.mockRejectedValue(new Error('Deletion failed'));

      await expect(controller.deleteProvider('provider-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('chat - error handling', () => {
    it('should handle chat error', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      const chatDto = { messages: [{ role: 'user' as any, content: 'Hello' }] };

      llmProvidersService.chat.mockRejectedValue(new Error('Chat failed'));

      await expect(controller.chat('provider-1', chatDto as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('performHealthCheck - error handling', () => {
    it('should handle health check error', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      llmProvidersService.performHealthCheck.mockRejectedValue(new Error('Health check failed'));

      await expect(controller.performHealthCheck('provider-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('createSession - error handling', () => {
    it('should handle session creation error', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      (llmProvidersService as any).createSession = jest.fn().mockRejectedValue(new Error('Session creation failed'));

      await expect(sessionsController.createSession('provider-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getSessions - error handling', () => {
    it('should handle sessions retrieval error', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      (llmProvidersService as any).getSessions = jest.fn().mockRejectedValue(new Error('Sessions failed'));

      await expect(sessionsController.getSessions('provider-1', undefined, undefined, 1, 20, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getSession - error handling', () => {
    it('should handle session not found error', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      (llmProvidersService as any).getSession = jest.fn().mockRejectedValue(new Error('Session not found'));

      await expect(sessionsController.getSession('session-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('updateSession - error handling', () => {
    it('should handle session update error', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      (llmProvidersService as any).updateSession = jest.fn().mockRejectedValue(new Error('Update failed'));

      await expect(sessionsController.updateSession('session-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('deleteSession - error handling', () => {
    it('should handle session deletion error', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1', organizations: [{ id: 'org-1' }] } };
      (llmProvidersService as any).deleteSession = jest.fn().mockRejectedValue(new Error('Deletion failed'));

      await expect(sessionsController.deleteSession('session-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getProviderModels - error handling', () => {
    it('should handle models retrieval error', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      llmProvidersService.getProvider.mockRejectedValue(new Error('Provider not found'));

      await expect(controller.getProviderModels('provider-1', mockRequest))
        .rejects.toThrow();
    });
  });
});
