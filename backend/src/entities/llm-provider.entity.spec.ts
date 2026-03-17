import {
  LlmProvider,
  LlmProviderType,
  LlmProviderStatus,
  LlmProviderConfig,
} from './llm-provider.entity';

describe('LlmProvider Entity', () => {
  let provider: LlmProvider;

  beforeEach(() => {
    provider = new LlmProvider();
    provider.id = 'prov-1';
    provider.name = 'Test Provider';
    provider.type = LlmProviderType.OPENAI;
    provider.status = LlmProviderStatus.ACTIVE;
    provider.organizationId = 'org-1';
    provider.configuration = {
      apiKey: 'sk-test-key',
      model: 'gpt-4',
      maxTokens: 4096,
      temperature: 0.7,
    };
    provider.capabilities = {
      supportedModels: ['gpt-4', 'gpt-3.5-turbo'],
      maxTokens: 8192,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      supportsBatching: false,
      supportsVision: true,
      supportsAudio: false,
      supportsToolUse: true,
      supportedToolFormats: ['openai'],
    };
    provider.totalRequests = 0;
    provider.successfulRequests = 0;
    provider.totalTokensUsed = 0;
    provider.totalCost = 0;
    provider.isHealthy = true;
  });

  describe('isActive', () => {
    it('should return true when status is ACTIVE', () => {
      expect(provider.isActive()).toBe(true);
    });

    it('should return false when status is INACTIVE', () => {
      provider.status = LlmProviderStatus.INACTIVE;

      expect(provider.isActive()).toBe(false);
    });

    it('should return false when status is ERROR', () => {
      provider.status = LlmProviderStatus.ERROR;

      expect(provider.isActive()).toBe(false);
    });

    it('should return false when status is MAINTENANCE', () => {
      provider.status = LlmProviderStatus.MAINTENANCE;

      expect(provider.isActive()).toBe(false);
    });
  });

  describe('checkHealth', () => {
    it('should return true when healthy and active', () => {
      expect(provider.checkHealth()).toBe(true);
    });

    it('should return false when not healthy', () => {
      provider.isHealthy = false;

      expect(provider.checkHealth()).toBe(false);
    });

    it('should return false when not active', () => {
      provider.status = LlmProviderStatus.INACTIVE;

      expect(provider.checkHealth()).toBe(false);
    });

    it('should return false when neither healthy nor active', () => {
      provider.isHealthy = false;
      provider.status = LlmProviderStatus.ERROR;

      expect(provider.checkHealth()).toBe(false);
    });
  });

  describe('getSuccessRate', () => {
    it('should return 0 when no requests', () => {
      expect(provider.getSuccessRate()).toBe(0);
    });

    it('should calculate success rate correctly', () => {
      provider.totalRequests = 100;
      provider.successfulRequests = 95;

      expect(provider.getSuccessRate()).toBe(95);
    });

    it('should return 100 when all requests successful', () => {
      provider.totalRequests = 50;
      provider.successfulRequests = 50;

      expect(provider.getSuccessRate()).toBe(100);
    });

    it('should return 0 when all requests failed', () => {
      provider.totalRequests = 20;
      provider.successfulRequests = 0;

      expect(provider.getSuccessRate()).toBe(0);
    });
  });

  describe('getAverageCostPerRequest', () => {
    it('should return 0 when no requests', () => {
      expect(provider.getAverageCostPerRequest()).toBe(0);
    });

    it('should calculate average cost correctly', () => {
      provider.totalRequests = 10;
      provider.totalCost = 100;

      expect(provider.getAverageCostPerRequest()).toBe(10);
    });

    it('should handle fractional costs', () => {
      provider.totalRequests = 3;
      provider.totalCost = 10;

      expect(provider.getAverageCostPerRequest()).toBeCloseTo(3.33, 2);
    });
  });

  describe('getAverageTokensPerRequest', () => {
    it('should return 0 when no requests', () => {
      expect(provider.getAverageTokensPerRequest()).toBe(0);
    });

    it('should calculate average tokens correctly', () => {
      provider.totalRequests = 5;
      provider.totalTokensUsed = 1000;

      expect(provider.getAverageTokensPerRequest()).toBe(200);
    });
  });

  describe('incrementUsage', () => {
    it('should increment counters on successful request', () => {
      provider.incrementUsage(100, 5, true);

      expect(provider.totalRequests).toBe(1);
      expect(provider.successfulRequests).toBe(1);
      expect(provider.totalTokensUsed).toBe(100);
      expect(provider.totalCost).toBe(5);
      expect(provider.lastRequestAt).toBeDefined();
    });

    it('should not increment successful counter on failed request', () => {
      provider.incrementUsage(50, 2, false);

      expect(provider.totalRequests).toBe(1);
      expect(provider.successfulRequests).toBe(0);
      expect(provider.totalTokensUsed).toBe(50);
      expect(provider.totalCost).toBe(2);
    });

    it('should accumulate over multiple calls', () => {
      provider.incrementUsage(100, 5, true);
      provider.incrementUsage(200, 10, true);
      provider.incrementUsage(50, 3, false);

      expect(provider.totalRequests).toBe(3);
      expect(provider.successfulRequests).toBe(2);
      expect(provider.totalTokensUsed).toBe(350);
      expect(provider.totalCost).toBe(18);
    });
  });

  describe('updateHealthStatus', () => {
    it('should update health status to unhealthy', () => {
      provider.updateHealthStatus(false, 'API timeout');

      expect(provider.isHealthy).toBe(false);
      expect(provider.status).toBe(LlmProviderStatus.ERROR);
      expect(provider.lastError).toBe('API timeout');
      expect(provider.lastHealthCheckAt).toBeDefined();
    });

    it('should update health status to healthy and clear error', () => {
      provider.status = LlmProviderStatus.ERROR;
      provider.lastError = 'Previous error';

      provider.updateHealthStatus(true);

      expect(provider.isHealthy).toBe(true);
      expect(provider.status).toBe(LlmProviderStatus.ACTIVE);
      expect(provider.lastError).toBeNull();
    });

    it('should not change status from INACTIVE to ACTIVE on health recovery', () => {
      provider.status = LlmProviderStatus.INACTIVE;

      provider.updateHealthStatus(true);

      expect(provider.status).toBe(LlmProviderStatus.INACTIVE);
    });

    it('should not change status from MAINTENANCE', () => {
      provider.status = LlmProviderStatus.MAINTENANCE;

      provider.updateHealthStatus(false, 'Error');

      expect(provider.status).toBe(LlmProviderStatus.MAINTENANCE);
    });
  });

  describe('Capability Checks', () => {
    describe('supportsToolUse', () => {
      it('should return true when capabilities indicate support', () => {
        expect(provider.supportsToolUse()).toBe(true);
      });

      it('should return false when capabilities indicate no support', () => {
        provider.capabilities.supportsToolUse = false;

        expect(provider.supportsToolUse()).toBe(false);
      });

      it('should return false when capabilities is undefined', () => {
        provider.capabilities = undefined;

        expect(provider.supportsToolUse()).toBe(false);
      });
    });

    describe('supportsFunctionCalling', () => {
      it('should return true when supported', () => {
        expect(provider.supportsFunctionCalling()).toBe(true);
      });

      it('should return false when not supported', () => {
        provider.capabilities.supportsFunctionCalling = false;

        expect(provider.supportsFunctionCalling()).toBe(false);
      });
    });

    describe('supportsStreaming', () => {
      it('should return true when supported', () => {
        expect(provider.supportsStreaming()).toBe(true);
      });

      it('should return false when not supported', () => {
        provider.capabilities.supportsStreaming = false;

        expect(provider.supportsStreaming()).toBe(false);
      });
    });
  });

  describe('getMaxTokens', () => {
    it('should return capability maxTokens when available', () => {
      expect(provider.getMaxTokens()).toBe(8192);
    });

    it('should return configuration maxTokens when no capabilities', () => {
      provider.capabilities = undefined;

      expect(provider.getMaxTokens()).toBe(4096);
    });

    it('should return default 4096 when neither available', () => {
      provider.capabilities = undefined;
      provider.configuration.maxTokens = undefined;

      expect(provider.getMaxTokens()).toBe(4096);
    });
  });

  describe('getSupportedModels', () => {
    it('should return models from capabilities', () => {
      expect(provider.getSupportedModels()).toEqual(['gpt-4', 'gpt-3.5-turbo']);
    });

    it('should return configuration model when no capabilities', () => {
      provider.capabilities = undefined;

      expect(provider.getSupportedModels()).toEqual(['gpt-4']);
    });

    it('should return default when neither available', () => {
      provider.capabilities = undefined;
      provider.configuration.model = undefined;

      expect(provider.getSupportedModels()).toEqual(['default']);
    });
  });

  describe('getApiUrl', () => {
    it('should return OpenAI URL', () => {
      provider.type = LlmProviderType.OPENAI;

      expect(provider.getApiUrl()).toBe('https://api.openai.com/v1');
    });

    it('should return custom OpenAI URL', () => {
      provider.type = LlmProviderType.OPENAI;
      provider.configuration.apiUrl = 'https://custom.openai.com';

      expect(provider.getApiUrl()).toBe('https://custom.openai.com');
    });

    it('should return Anthropic URL', () => {
      provider.type = LlmProviderType.ANTHROPIC;

      expect(provider.getApiUrl()).toBe('https://api.anthropic.com/v1');
    });

    it('should return Google URL', () => {
      provider.type = LlmProviderType.GOOGLE;

      expect(provider.getApiUrl()).toBe('https://generativelanguage.googleapis.com/v1');
    });

    it('should return Cohere URL', () => {
      provider.type = LlmProviderType.COHERE;

      expect(provider.getApiUrl()).toBe('https://api.cohere.ai/v2');
    });

    it('should return Azure OpenAI URL', () => {
      provider.type = LlmProviderType.AZURE_OPENAI;
      provider.configuration.azure = {
        resourceName: 'myresource',
        deploymentName: 'gpt-4',
        apiVersion: '2024-02-01',
      };

      expect(provider.getApiUrl()).toBe(
        'https://myresource.openai.azure.com/openai/deployments/gpt-4?api-version=2024-02-01'
      );
    });

    it('should return AWS Bedrock URL', () => {
      provider.type = LlmProviderType.AWS_BEDROCK;
      provider.configuration.bedrock = { region: 'us-west-2' };

      expect(provider.getApiUrl()).toBe('https://bedrock-runtime.us-west-2.amazonaws.com');
    });

    it('should return Huggingface URL', () => {
      provider.type = LlmProviderType.HUGGINGFACE;
      provider.configuration.huggingface = { endpoint: 'https://api.hf.co' };

      expect(provider.getApiUrl()).toBe('https://api.hf.co');
    });

    it('should return custom URL', () => {
      provider.type = LlmProviderType.CUSTOM;
      provider.configuration.apiUrl = 'https://custom-llm.com/api';

      expect(provider.getApiUrl()).toBe('https://custom-llm.com/api');
    });
  });

  describe('getAuthHeaders', () => {
    it('should return OpenAI auth headers', () => {
      provider.type = LlmProviderType.OPENAI;

      const headers = provider.getAuthHeaders();

      expect(headers.Authorization).toBe('Bearer sk-test-key');
      expect(headers['User-Agent']).toBe('apifai/1.0');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should return Anthropic auth headers', () => {
      provider.type = LlmProviderType.ANTHROPIC;
      provider.configuration.apiVersion = '2024-01-01';

      const headers = provider.getAuthHeaders();

      expect(headers['x-api-key']).toBe('sk-test-key');
      expect(headers['anthropic-version']).toBe('2024-01-01');
    });

    it('should return Cohere auth headers', () => {
      provider.type = LlmProviderType.COHERE;

      const headers = provider.getAuthHeaders();

      expect(headers.Authorization).toBe('Bearer sk-test-key');
    });

    it('should return custom bearer auth headers', () => {
      provider.type = LlmProviderType.CUSTOM;
      provider.configuration.custom = {
        authMethod: 'bearer',
        headers: { 'X-Custom-Header': 'value' },
      };

      const headers = provider.getAuthHeaders();

      expect(headers.Authorization).toBe('Bearer sk-test-key');
      expect(headers['X-Custom-Header']).toBe('value');
    });

    it('should return custom API key headers', () => {
      provider.type = LlmProviderType.CUSTOM;
      provider.configuration.custom = { authMethod: 'api_key' };

      const headers = provider.getAuthHeaders();

      expect(headers['X-API-Key']).toBe('sk-test-key');
    });
  });

  describe('maskSensitiveData', () => {
    it('should mask API key', () => {
      const masked = provider.maskSensitiveData();

      expect(masked.configuration.apiKey).toBe('***masked***');
      expect(masked.configuration.model).toBe('gpt-4');
    });

    it('should mask Bedrock credentials', () => {
      provider.configuration.bedrock = {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: 'token123',
      };

      const masked = provider.maskSensitiveData();

      expect(masked.configuration.bedrock.accessKeyId).toBe('***masked***');
      expect(masked.configuration.bedrock.secretAccessKey).toBe('***masked***');
      expect(masked.configuration.bedrock.sessionToken).toBe('***masked***');
    });
  });

  describe('calculateEstimatedCost', () => {
    it('should calculate cost based on token usage', () => {
      provider.metadata = {
        modelInfo: {
          inputTokenCost: 0.03,
          outputTokenCost: 0.06,
        },
      };

      const cost = provider.calculateEstimatedCost(1000, 500);

      expect(cost).toBeCloseTo(0.06, 2); // (1000/1000)*0.03 + (500/1000)*0.06
    });

    it('should return 0 when no pricing info', () => {
      provider.metadata = undefined;

      expect(provider.calculateEstimatedCost(1000, 500)).toBe(0);
    });

    it('should return 0 when incomplete pricing info', () => {
      provider.metadata = {
        modelInfo: {
          inputTokenCost: 0.03,
        },
      };

      expect(provider.calculateEstimatedCost(1000, 500)).toBe(0);
    });
  });

  describe('toPublicView', () => {
    it('should return public data without sensitive info', () => {
      const publicView = provider.toPublicView();

      expect(publicView.configuration.apiKey).toBeUndefined();
      expect(publicView.configuration.model).toBe('gpt-4');
      expect(publicView.configuration.maxTokens).toBe(4096);
      expect(publicView.configuration.temperature).toBe(0.7);
      expect(publicView.id).toBe('prov-1');
      expect(publicView.name).toBe('Test Provider');
    });
  });
});
