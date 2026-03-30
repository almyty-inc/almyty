import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CredentialsService } from './credentials.service';
import { Credential } from '../../entities/credential.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Api } from '../../entities/api.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

describe('CredentialsService', () => {
  let service: CredentialsService;
  let credentialRepository: any;
  let apiKeyRepository: any;
  let llmProviderRepository: any;
  let apiRepository: any;
  let gatewayRepository: any;
  let agentRepository: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialsService,
        {
          provide: getRepositoryToken(Credential),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(LlmProvider),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Api),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Agent),
          useValue: {
            findOne: jest.fn(),
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
      ],
    }).compile();

    service = module.get<CredentialsService>(CredentialsService);
    credentialRepository = module.get(getRepositoryToken(Credential));
    apiKeyRepository = module.get(getRepositoryToken(ApiKey));
    llmProviderRepository = module.get(getRepositoryToken(LlmProvider));
    apiRepository = module.get(getRepositoryToken(Api));
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    agentRepository = module.get(getRepositoryToken(Agent));
  });

  describe('findAll', () => {
    it('should return all credentials for org with masked sensitive data', async () => {
      const mockCredentials = [
        {
          id: 'cred-1',
          name: 'My API Key',
          organizationId: 'org-1',
          config: { apiKey: 'sk-1234567890abcdef', baseUrl: 'https://api.example.com' },
        },
        {
          id: 'cred-2',
          name: 'OAuth Token',
          organizationId: 'org-1',
          config: { token: 'short', baseUrl: 'https://api.example.com' },
        },
      ];

      credentialRepository.find.mockResolvedValue(mockCredentials);
      llmProviderRepository.find.mockResolvedValue([]);

      const result = await service.findAll('org-1');

      expect(result).toHaveLength(2);
      // Long key should be partially masked
      expect(result[0].config.apiKey).toBe('sk-1****cdef');
      // Non-sensitive field should be untouched
      expect(result[0].config.baseUrl).toBe('https://api.example.com');
      // Short token should be fully masked
      expect(result[1].config.token).toBe('********');
      expect(credentialRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('findById', () => {
    it('should return a single credential with masked data', async () => {
      const mockCredential = {
        id: 'cred-1',
        name: 'My Key',
        organizationId: 'org-1',
        config: { apiKey: 'sk-abcdefghijklmnop' },
      };

      credentialRepository.findOne.mockResolvedValue(mockCredential);

      const result = await service.findById('cred-1', 'org-1');

      expect(result.id).toBe('cred-1');
      expect(result.config.apiKey).toBe('sk-a****mnop');
      expect(credentialRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'cred-1', organizationId: 'org-1' },
      });
    });

    it('should throw NotFoundException when credential not found', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(service.findById('cred-999', 'org-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('should create credential with encrypted config and return masked', async () => {
      const createData = {
        name: 'New Credential',
        type: 'api_key',
        config: { apiKey: 'sk-realkey1234567890' },
        keyName: 'X-API-Key',
        keyLocation: 'header',
      };

      const mockCreated = {
        id: 'cred-new',
        ...createData,
        organizationId: 'org-1',
        encryptSensitiveData: jest.fn(),
      };

      credentialRepository.create.mockReturnValue(mockCreated);
      credentialRepository.save.mockResolvedValue(mockCreated);

      const result = await service.create(createData, 'org-1');

      expect(credentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Credential',
          type: 'api_key',
          organizationId: 'org-1',
          keyName: 'X-API-Key',
          keyLocation: 'header',
        }),
      );
      expect(mockCreated.encryptSensitiveData).toHaveBeenCalled();
      expect(credentialRepository.save).toHaveBeenCalledWith(mockCreated);
      // Returned value should have masked config
      expect(result.config.apiKey).toBe('sk-r****7890');
    });
  });

  describe('update', () => {
    it('should update credential and re-encrypt if config changed', async () => {
      const existing = {
        id: 'cred-1',
        name: 'Old Name',
        organizationId: 'org-1',
        config: { apiKey: 'encrypted:abc:def' },
        encryptSensitiveData: jest.fn(),
      };

      credentialRepository.findOne.mockResolvedValue(existing);
      credentialRepository.save.mockResolvedValue(existing);

      const result = await service.update(
        'cred-1',
        { name: 'Updated Name', config: { apiKey: 'new-key-value-here' } },
        'org-1',
      );

      expect(existing.name).toBe('Updated Name');
      expect(existing.encryptSensitiveData).toHaveBeenCalled();
      expect(credentialRepository.save).toHaveBeenCalledWith(existing);
    });

    it('should throw NotFoundException when credential not found', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(service.update('cred-999', { name: 'Nope' }, 'org-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete credential successfully', async () => {
      const mockCredential = { id: 'cred-1', name: 'To Delete', organizationId: 'org-1' };

      credentialRepository.findOne.mockResolvedValue(mockCredential);
      credentialRepository.remove.mockResolvedValue(mockCredential);

      await service.delete('cred-1', 'org-1');

      expect(credentialRepository.remove).toHaveBeenCalledWith(mockCredential);
    });

    it('should throw NotFoundException when credential not found', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(service.delete('cred-999', 'org-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('getUsage', () => {
    it('should return LLM providers and APIs using the credential', async () => {
      const mockCredential = { id: 'cred-1', organizationId: 'org-1' };
      const mockLlmProviders = [
        { id: 'llm-1', name: 'OpenAI', type: 'openai', status: 'active' },
      ];
      const mockApis = [
        {
          id: 'api-1',
          name: 'Weather API',
          type: 'rest',
          credentials: [{ id: 'cred-1' }],
        },
        {
          id: 'api-2',
          name: 'Other API',
          type: 'rest',
          credentials: [{ id: 'cred-other' }],
        },
      ];

      credentialRepository.findOne.mockResolvedValue(mockCredential);
      llmProviderRepository.find.mockResolvedValue(mockLlmProviders);
      apiRepository.find.mockResolvedValue(mockApis);

      const result = await service.getUsage('cred-1', 'org-1');

      expect(result.llmProviders).toHaveLength(1);
      expect(result.llmProviders[0].name).toBe('OpenAI');
      expect(result.apis).toHaveLength(1);
      expect(result.apis[0].name).toBe('Weather API');
      expect(llmProviderRepository.find).toHaveBeenCalledWith({
        where: { credentialId: 'cred-1', organizationId: 'org-1' },
        select: ['id', 'name', 'type', 'status'],
      });
    });

    it('should throw NotFoundException when credential not found', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(service.getUsage('cred-999', 'org-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('findAllAccessKeys', () => {
    it('should return enriched access keys with gateway and agent info', async () => {
      const mockKeys = [
        {
          id: 'key-1',
          name: 'Production Key',
          keyPrefix: 'almyty_sk_abcd',
          isActive: true,
          scopes: ['read'],
          expiresAt: null,
          lastUsedAt: null,
          rateLimits: null,
          createdAt: new Date(),
          agentId: 'agent-1',
          gateway: { id: 'gw-1', name: 'Main Gateway' },
        },
        {
          id: 'key-2',
          name: 'Test Key',
          keyPrefix: 'almyty_sk_efgh',
          isActive: false,
          scopes: [],
          expiresAt: null,
          lastUsedAt: null,
          rateLimits: null,
          createdAt: new Date(),
          agentId: null,
          gateway: null,
        },
      ];

      apiKeyRepository.find.mockResolvedValue(mockKeys);
      agentRepository.findOne.mockResolvedValue({ id: 'agent-1', name: 'My Agent' });

      const result = await service.findAllAccessKeys('org-1');

      expect(result).toHaveLength(2);
      expect(result[0].gateway).toEqual({ id: 'gw-1', name: 'Main Gateway' });
      expect(result[0].agent).toEqual({ id: 'agent-1', name: 'My Agent' });
      expect(result[1].gateway).toBeNull();
      expect(result[1].agent).toBeNull();
      expect(apiKeyRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        relations: ['gateway'],
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('createAccessKey', () => {
    it('should generate key with hash and return plain text key once', async () => {
      const createData = {
        name: 'New Access Key',
        scopes: ['read', 'write'],
        gatewayId: 'gw-1',
      };

      const mockSaved = {
        id: 'key-new',
        name: 'New Access Key',
        keyHash: 'somehash',
        keyPrefix: 'almyty_sk_abcde',
        isActive: true,
      };

      apiKeyRepository.create.mockReturnValue(mockSaved);
      apiKeyRepository.save.mockResolvedValue(mockSaved);

      const result = await service.createAccessKey(createData, 'org-1', 'user-1');

      expect(result.key).toBe(mockSaved);
      expect(result.plainTextKey).toMatch(/^almyty_sk_[0-9a-f]{64}$/);
      expect(apiKeyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Access Key',
          userId: 'user-1',
          organizationId: 'org-1',
          gatewayId: 'gw-1',
          scopes: ['read', 'write'],
          isActive: true,
        }),
      );
    });

    it('should throw BadRequestException when name is missing', async () => {
      await expect(
        service.createAccessKey({ name: '' }, 'org-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('revokeAccessKey', () => {
    it('should set isActive to false', async () => {
      const mockKey = {
        id: 'key-1',
        name: 'Revoke Me',
        isActive: true,
        organizationId: 'org-1',
      };

      apiKeyRepository.findOne.mockResolvedValue(mockKey);
      apiKeyRepository.save.mockResolvedValue({ ...mockKey, isActive: false });

      await service.revokeAccessKey('key-1', 'org-1');

      expect(mockKey.isActive).toBe(false);
      expect(apiKeyRepository.save).toHaveBeenCalledWith(mockKey);
    });

    it('should throw NotFoundException when key not found', async () => {
      apiKeyRepository.findOne.mockResolvedValue(null);

      await expect(service.revokeAccessKey('key-999', 'org-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });
});
