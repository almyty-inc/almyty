import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CredentialsService } from './credentials.service';
import { Credential } from '../../entities/credential.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { makeEnvelopeCryptoMock } from '../../test/envelope-crypto.mock';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Api } from '../../entities/api.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

describe('CredentialsService', () => {
  let service: CredentialsService;
  let credentialRepository: any;
  let apiKeyRepository: any;
  let llmProviderRepository: any;
  let apiRepository: any;
  let gatewayRepository: any;
  let agentRepository: any;
  let accessPolicy: any;
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialsService,
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        {
          provide: getRepositoryToken(Credential),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
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
            createQueryBuilder: jest.fn(),
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
        {
          provide: AccessPolicyService,
          useValue: {
            canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
            applyListFilter: jest.fn().mockResolvedValue({ bypass: true, teamIds: [] }),
            assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
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
    accessPolicy = module.get(AccessPolicyService);
  });

  describe('findAll', () => {
    it('returns all credentials for the caller, applies the team-scope filter, masks sensitive fields', async () => {
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

      const credQb: any = {
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockCredentials),
      };
      const providerQb: any = { getMany: jest.fn().mockResolvedValue([]) };
      credentialRepository.createQueryBuilder.mockReturnValue(credQb);
      llmProviderRepository.createQueryBuilder.mockReturnValue(providerQb);

      const result = await service.findAll({ id: 'user-1' }, 'org-1');

      expect(result).toHaveLength(2);
      expect(result[0].config.apiKey).toBe('sk-1****cdef');
      expect(result[0].config.baseUrl).toBe('https://api.example.com');
      expect(result[1].config.token).toBe('********');

      // Regression for the security audit: the team-scope filter
      // MUST be applied to both credentials and the LLM-provider
      // fallback rows. Without this assertion a future refactor that
      // drops the call goes undetected and a team_member can see
      // every credential in the org.
      expect(accessPolicy.applyListFilter).toHaveBeenCalledTimes(2);
      expect(accessPolicy.applyListFilter).toHaveBeenCalledWith(credQb, { id: 'user-1' }, 'org-1', 'c');
      expect(accessPolicy.applyListFilter).toHaveBeenCalledWith(providerQb, { id: 'user-1' }, 'org-1', 'p');
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
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
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
      expect(mockCreated.encryptSensitiveDataForOrg).toHaveBeenCalled();
      expect(credentialRepository.save).toHaveBeenCalledWith(mockCreated);
      // Returned value should have masked config
      expect(result.config.apiKey).toBe('sk-r****7890');
    });

    it('persists visibility="team" + teamId from the dashboard VisibilityField payload', async () => {
      const createData = {
        name: 'Team Credential',
        type: 'api_key',
        config: { apiKey: 'sk-team-key-1234567890' },
        visibility: 'team' as const,
        teamId: 'team-uuid-1',
      };
      const mockCreated = {
        id: 'cred-team',
        ...createData,
        organizationId: 'org-1',
        encryptSensitiveData: jest.fn(),
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };
      credentialRepository.create.mockReturnValue(mockCreated);
      credentialRepository.save.mockResolvedValue(mockCreated);

      await service.create(createData, 'org-1');

      expect(credentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: 'team',
          teamId: 'team-uuid-1',
        }),
      );
    });

    it('defaults visibility to "org" and clears teamId when visibility is omitted', async () => {
      const createData = {
        name: 'Default Visibility',
        type: 'api_key',
        config: { apiKey: 'sk-org-key-1234567890' },
      };
      const mockCreated = {
        id: 'cred-org',
        ...createData,
        organizationId: 'org-1',
        encryptSensitiveData: jest.fn(),
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };
      credentialRepository.create.mockReturnValue(mockCreated);
      credentialRepository.save.mockResolvedValue(mockCreated);

      await service.create(createData, 'org-1');

      expect(credentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: 'org',
          teamId: null,
        }),
      );
    });

    it('drops a stray teamId when visibility="org"', async () => {
      const createData = {
        name: 'Org Visibility With Stray TeamId',
        type: 'api_key',
        config: { apiKey: 'sk-org-key-1234567890' },
        visibility: 'org' as const,
        teamId: 'team-uuid-should-be-dropped',
      };
      const mockCreated = {
        id: 'cred-org-stray',
        ...createData,
        organizationId: 'org-1',
        encryptSensitiveData: jest.fn(),
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };
      credentialRepository.create.mockReturnValue(mockCreated);
      credentialRepository.save.mockResolvedValue(mockCreated);

      await service.create(createData, 'org-1');

      expect(credentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: 'org',
          teamId: null,
        }),
      );
    });

    it('rejects when assertCanScopeToTeam throws on create (regression bait: if the assertCanScopeToTeam call is removed, this fails)', async () => {
      const createData = {
        name: 'Hostile',
        type: 'api_key',
        config: { apiKey: 'sk-xxx' },
        visibility: 'team' as const,
        teamId: 'someone-elses-team',
      };
      accessPolicy.assertCanScopeToTeam.mockRejectedValueOnce(new Error('Team not found'));

      await expect(service.create(createData, 'org-1', 'user-1')).rejects.toThrow();
      expect(credentialRepository.save).not.toHaveBeenCalled();
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
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };

      credentialRepository.findOne.mockResolvedValue(existing);
      credentialRepository.save.mockResolvedValue(existing);

      const result = await service.update(
        'cred-1',
        { name: 'Updated Name', config: { apiKey: 'new-key-value-here' } },
        'org-1',
      );

      expect(existing.name).toBe('Updated Name');
      expect(existing.encryptSensitiveDataForOrg).toHaveBeenCalled();
      expect(credentialRepository.save).toHaveBeenCalledWith(existing);
    });

    it('flips visibility to "team" and stores teamId', async () => {
      const existing: any = {
        id: 'cred-1',
        organizationId: 'org-1',
        visibility: 'org',
        teamId: null,
        config: {},
        encryptSensitiveData: jest.fn(),
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };
      credentialRepository.findOne.mockResolvedValue(existing);
      credentialRepository.save.mockResolvedValue(existing);

      await service.update(
        'cred-1',
        { visibility: 'team', teamId: 'team-uuid-1' },
        'org-1',
      );

      expect(existing.visibility).toBe('team');
      expect(existing.teamId).toBe('team-uuid-1');
    });

    it('flips visibility back to "org" and clears the dangling teamId', async () => {
      const existing: any = {
        id: 'cred-1',
        organizationId: 'org-1',
        visibility: 'team',
        teamId: 'team-uuid-old',
        config: {},
        encryptSensitiveData: jest.fn(),
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };
      credentialRepository.findOne.mockResolvedValue(existing);
      credentialRepository.save.mockResolvedValue(existing);

      await service.update('cred-1', { visibility: 'org' }, 'org-1');

      expect(existing.visibility).toBe('org');
      expect(existing.teamId).toBeNull()
    });

    it('rejects when AccessPolicy.canAccess returns allowed=false (regression bait: if the canAccess call is removed, this fails)', async () => {
      const existing: any = {
        id: 'cred-1',
        organizationId: 'org-1',
        visibility: 'team',
        teamId: 'team-1',
        config: {},
        encryptSensitiveData: jest.fn(),
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };
      credentialRepository.findOne.mockResolvedValue(existing);
      accessPolicy.canAccess.mockResolvedValueOnce({ allowed: false, reason: 'forbidden' });

      await expect(
        service.update('cred-1', { name: 'attempt' }, 'org-1', 'user-1'),
      ).rejects.toThrow();
      expect(credentialRepository.save).not.toHaveBeenCalled();
    });

    it('rejects when assertCanScopeToTeam throws (regression bait: if the assertCanScopeToTeam call is removed, this fails)', async () => {
      const existing: any = {
        id: 'cred-1',
        organizationId: 'org-1',
        visibility: 'org',
        teamId: null,
        config: {},
        encryptSensitiveData: jest.fn(),
        encryptSensitiveDataForOrg: jest.fn().mockResolvedValue(undefined),
      };
      credentialRepository.findOne.mockResolvedValue(existing);
      accessPolicy.canAccess.mockResolvedValueOnce({ allowed: true, reason: 'ok' });
      accessPolicy.assertCanScopeToTeam.mockRejectedValueOnce(new Error('Team not found'));

      await expect(
        service.update('cred-1', { visibility: 'team', teamId: 'someone-elses-team' }, 'org-1', 'user-1'),
      ).rejects.toThrow();
      expect(credentialRepository.save).not.toHaveBeenCalled();
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
