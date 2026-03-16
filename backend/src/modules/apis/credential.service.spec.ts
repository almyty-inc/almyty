import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { CredentialService, CreateCredentialDto, UpdateCredentialDto } from './credential.service';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { Api } from '../../entities/api.entity';

// Mock axios for testCredential and refreshOAuthToken
jest.mock('axios', () => {
  const mockAxios: any = jest.fn();
  mockAxios.post = jest.fn();
  mockAxios.isAxiosError = jest.fn();
  return { __esModule: true, default: mockAxios };
});
import axios from 'axios';
const mockedAxios = axios as unknown as jest.MockedFunction<any>;

describe('CredentialService', () => {
  let service: CredentialService;
  let credentialRepository: any;
  let apiRepository: any;

  const mockApi: Partial<Api> = {
    id: 'api-1',
    organizationId: 'org-1',
    name: 'Test API',
    baseUrl: 'https://api.example.com',
  };

  const mockCredential = (): Partial<Credential> => ({
    id: 'cred-1',
    name: 'Test Credential',
    description: 'Test description',
    type: CredentialType.API_KEY,
    config: { apiKey: 'sk-test-12345678' },
    keyName: 'X-API-Key',
    keyLocation: 'header',
    apiId: 'api-1',
    organizationId: 'org-1',
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    scopes: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    encryptSensitiveData: jest.fn(),
    getDecryptedConfig: jest.fn().mockReturnValue({ apiKey: 'sk-test-12345678' }),
    getAuthHeaders: jest.fn().mockReturnValue({ 'X-API-Key': 'sk-test-12345678' }),
    getQueryParams: jest.fn().mockReturnValue({}),
    isValid: jest.fn().mockReturnValue(true),
    isExpired: jest.fn().mockReturnValue(false),
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialService,
        {
          provide: getRepositoryToken(Credential),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
            remove: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Api),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CredentialService>(CredentialService);
    credentialRepository = module.get(getRepositoryToken(Credential));
    apiRepository = module.get(getRepositoryToken(Api));
  });

  describe('createCredential', () => {
    const dto: CreateCredentialDto = {
      name: 'My API Key',
      description: 'Production key',
      type: CredentialType.API_KEY,
      config: { apiKey: 'sk-live-12345678' },
      keyName: 'X-API-Key',
      keyLocation: 'header',
    };

    it('should create a credential and encrypt sensitive data', async () => {
      const cred = mockCredential();
      apiRepository.findOne.mockResolvedValue(mockApi);
      credentialRepository.create.mockReturnValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      const result = await service.createCredential('api-1', 'org-1', dto);

      expect(apiRepository.findOne).toHaveBeenCalledWith({ where: { id: 'api-1' } });
      expect(credentialRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'My API Key',
        type: CredentialType.API_KEY,
        apiId: 'api-1',
        organizationId: 'org-1',
      }));
      expect(cred.encryptSensitiveData).toHaveBeenCalled();
      expect(credentialRepository.save).toHaveBeenCalledWith(cred);
      expect(result).toBeDefined();
    });

    it('should throw NotFoundException when API not found', async () => {
      apiRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createCredential('nonexistent', 'org-1', dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when org mismatch', async () => {
      apiRepository.findOne.mockResolvedValue({ ...mockApi, organizationId: 'other-org' });

      await expect(
        service.createCredential('api-1', 'org-1', dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should mask sensitive fields in returned credential', async () => {
      const cred = mockCredential();
      // Simulate encrypted config (after encryptSensitiveData)
      cred.config = { apiKey: 'encrypted:abc123:deadbeef' };
      apiRepository.findOne.mockResolvedValue(mockApi);
      credentialRepository.create.mockReturnValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      const result = await service.createCredential('api-1', 'org-1', dto);

      // The apiKey should be masked since it starts with 'encrypted:'
      expect(result.config.apiKey).toBe('••••••••');
    });

    it('should handle expiresAt date string', async () => {
      const cred = mockCredential();
      apiRepository.findOne.mockResolvedValue(mockApi);
      credentialRepository.create.mockReturnValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      const dtoWithExpiry = { ...dto, expiresAt: '2026-12-31T23:59:59Z' };
      await service.createCredential('api-1', 'org-1', dtoWithExpiry);

      expect(credentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: new Date('2026-12-31T23:59:59Z'),
        }),
      );
    });
  });

  describe('getCredentials', () => {
    it('should return masked credentials for an API', async () => {
      const cred1 = mockCredential();
      cred1.config = { apiKey: 'encrypted:iv1:data1' };
      const cred2 = mockCredential();
      cred2.id = 'cred-2';
      cred2.config = { token: 'encrypted:iv2:data2' };
      cred2.type = CredentialType.BEARER_TOKEN;

      credentialRepository.find.mockResolvedValue([cred1, cred2]);

      const result = await service.getCredentials('api-1', 'org-1');

      expect(credentialRepository.find).toHaveBeenCalledWith({
        where: { apiId: 'api-1', organizationId: 'org-1' },
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(2);
      expect(result[0].config.apiKey).toBe('••••••••');
      expect(result[1].config.token).toBe('••••••••');
    });

    it('should return empty array when no credentials exist', async () => {
      credentialRepository.find.mockResolvedValue([]);

      const result = await service.getCredentials('api-1', 'org-1');

      expect(result).toEqual([]);
    });

    it('should scope query by both apiId and organizationId', async () => {
      credentialRepository.find.mockResolvedValue([]);

      await service.getCredentials('api-1', 'org-1');

      expect(credentialRepository.find).toHaveBeenCalledWith({
        where: { apiId: 'api-1', organizationId: 'org-1' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('getCredentialForExecution', () => {
    it('should return the most recent active credential', async () => {
      const cred = mockCredential();
      credentialRepository.findOne.mockResolvedValue(cred);

      const result = await service.getCredentialForExecution('api-1', 'org-1');

      expect(credentialRepository.findOne).toHaveBeenCalledWith({
        where: { apiId: 'api-1', organizationId: 'org-1', isActive: true },
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual(cred);
    });

    it('should return null when no active credential exists', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      const result = await service.getCredentialForExecution('api-1', 'org-1');

      expect(result).toBeNull();
    });
  });

  describe('updateCredential', () => {
    it('should update credential fields', async () => {
      const cred = mockCredential();
      credentialRepository.findOne.mockResolvedValue(cred);
      credentialRepository.save.mockResolvedValue({ ...cred, name: 'Updated Name' });

      const dto: UpdateCredentialDto = { name: 'Updated Name' };
      const result = await service.updateCredential('cred-1', 'org-1', dto);

      expect(credentialRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'cred-1', organizationId: 'org-1' },
      });
      expect(cred.name).toBe('Updated Name');
      expect(credentialRepository.save).toHaveBeenCalledWith(cred);
    });

    it('should re-encrypt when config is updated', async () => {
      const cred = mockCredential();
      credentialRepository.findOne.mockResolvedValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      const dto: UpdateCredentialDto = { config: { apiKey: 'new-key-value' } };
      await service.updateCredential('cred-1', 'org-1', dto);

      // encryptSensitiveData should have been called (config was changed)
      expect(cred.encryptSensitiveData).toHaveBeenCalled();
      // save should have been called with the credential
      expect(credentialRepository.save).toHaveBeenCalledWith(cred);
    });

    it('should NOT re-encrypt when config is not updated', async () => {
      const cred = mockCredential();
      credentialRepository.findOne.mockResolvedValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      const dto: UpdateCredentialDto = { name: 'New Name' };
      await service.updateCredential('cred-1', 'org-1', dto);

      expect(cred.encryptSensitiveData).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when credential not found', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateCredential('nonexistent', 'org-1', { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should enforce org isolation (wrong org cannot update)', async () => {
      // findOne with wrong org returns null because of where clause
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateCredential('cred-1', 'wrong-org', { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update isActive flag', async () => {
      const cred = mockCredential();
      credentialRepository.findOne.mockResolvedValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      await service.updateCredential('cred-1', 'org-1', { isActive: false });

      expect(cred.isActive).toBe(false);
    });

    it('should update multiple fields at once', async () => {
      const cred = mockCredential();
      credentialRepository.findOne.mockResolvedValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      await service.updateCredential('cred-1', 'org-1', {
        name: 'New Name',
        description: 'New Desc',
        keyName: 'Authorization',
        keyLocation: 'header',
        scopes: ['read', 'write'],
        isActive: false,
      });

      expect(cred.name).toBe('New Name');
      expect(cred.description).toBe('New Desc');
      expect(cred.keyName).toBe('Authorization');
      expect(cred.keyLocation).toBe('header');
      expect(cred.scopes).toEqual(['read', 'write']);
      expect(cred.isActive).toBe(false);
    });
  });

  describe('deleteCredential', () => {
    it('should delete credential', async () => {
      const cred = mockCredential();
      credentialRepository.findOne.mockResolvedValue(cred);
      credentialRepository.remove.mockResolvedValue(cred);

      await service.deleteCredential('cred-1', 'org-1');

      expect(credentialRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'cred-1', organizationId: 'org-1' },
      });
      expect(credentialRepository.remove).toHaveBeenCalledWith(cred);
    });

    it('should throw NotFoundException when credential not found', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteCredential('nonexistent', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should enforce org isolation on delete', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteCredential('cred-1', 'wrong-org'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('testCredential', () => {
    it('should return success when API responds with 2xx', async () => {
      const cred = mockCredential();
      cred.api = mockApi as Api;
      credentialRepository.findOne.mockResolvedValue(cred);
      mockedAxios.mockResolvedValue({ status: 200 });

      const result = await service.testCredential('cred-1', 'org-1');

      expect(result.success).toBe(true);
      expect(result.message).toContain('200');
    });

    it('should return failure when API responds with 401', async () => {
      const cred = mockCredential();
      cred.api = mockApi as Api;
      credentialRepository.findOne.mockResolvedValue(cred);
      mockedAxios.mockResolvedValue({ status: 401 });

      const result = await service.testCredential('cred-1', 'org-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('should return failure when API responds with 403', async () => {
      const cred = mockCredential();
      cred.api = mockApi as Api;
      credentialRepository.findOne.mockResolvedValue(cred);
      mockedAxios.mockResolvedValue({ status: 403 });

      const result = await service.testCredential('cred-1', 'org-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('403');
    });

    it('should return failure when credential is inactive or expired', async () => {
      const cred = mockCredential();
      cred.api = mockApi as Api;
      (cred.isValid as jest.Mock).mockReturnValue(false);
      credentialRepository.findOne.mockResolvedValue(cred);

      const result = await service.testCredential('cred-1', 'org-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('inactive or expired');
    });

    it('should return failure on connection error', async () => {
      const cred = mockCredential();
      cred.api = mockApi as Api;
      credentialRepository.findOne.mockResolvedValue(cred);
      mockedAxios.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.testCredential('cred-1', 'org-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
    });

    it('should throw NotFoundException when credential not found', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await expect(
        service.testCredential('nonexistent', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should pass auth headers and query params from credential', async () => {
      const cred = mockCredential();
      cred.api = mockApi as Api;
      (cred.getAuthHeaders as jest.Mock).mockReturnValue({ 'X-API-Key': 'test' });
      (cred.getQueryParams as jest.Mock).mockReturnValue({ api_key: 'test' });
      credentialRepository.findOne.mockResolvedValue(cred);
      mockedAxios.mockResolvedValue({ status: 200 });

      await service.testCredential('cred-1', 'org-1');

      expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'test' }),
        params: { api_key: 'test' },
      }));
    });
  });

  describe('refreshOAuthToken', () => {
    it('should refresh OAuth2 token successfully', async () => {
      const cred = mockCredential();
      cred.type = CredentialType.OAUTH2;
      (cred.getDecryptedConfig as jest.Mock).mockReturnValue({
        refreshToken: 'old-refresh-token',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        accessToken: 'old-access-token',
      });
      credentialRepository.save.mockResolvedValue(cred);

      (axios.post as jest.Mock).mockResolvedValue({
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        },
      });

      const result = await service.refreshOAuthToken(cred as unknown as Credential);

      expect(axios.post).toHaveBeenCalledWith(
        'https://auth.example.com/token',
        expect.any(String),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      expect(cred.config).toEqual(expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }));
      expect(cred.encryptSensitiveData).toHaveBeenCalled();
      expect(credentialRepository.save).toHaveBeenCalled();
    });

    it('should keep old refresh token when new one not returned', async () => {
      const cred = mockCredential();
      cred.type = CredentialType.OAUTH2;
      (cred.getDecryptedConfig as jest.Mock).mockReturnValue({
        refreshToken: 'old-refresh-token',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'c',
        clientSecret: 's',
      });
      credentialRepository.save.mockResolvedValue(cred);

      (axios.post as jest.Mock).mockResolvedValue({
        data: {
          access_token: 'new-access',
          // no refresh_token in response
        },
      });

      await service.refreshOAuthToken(cred as unknown as Credential);

      expect(cred.config.refreshToken).toBe('old-refresh-token');
    });

    it('should set expiresAt when expires_in returned', async () => {
      const cred = mockCredential();
      cred.type = CredentialType.OAUTH2;
      (cred.getDecryptedConfig as jest.Mock).mockReturnValue({
        refreshToken: 'rt',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'c',
        clientSecret: 's',
      });
      credentialRepository.save.mockResolvedValue(cred);

      const now = Date.now();
      (axios.post as jest.Mock).mockResolvedValue({
        data: { access_token: 'at', expires_in: 3600 },
      });

      await service.refreshOAuthToken(cred as unknown as Credential);

      expect(cred.expiresAt).toBeDefined();
      expect(cred.expiresAt.getTime()).toBeGreaterThanOrEqual(now + 3500 * 1000);
    });

    it('should throw BadRequestException for non-OAuth2 credentials', async () => {
      const cred = mockCredential();
      cred.type = CredentialType.API_KEY;

      await expect(
        service.refreshOAuthToken(cred as unknown as Credential),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when refreshToken or tokenEndpoint missing', async () => {
      const cred = mockCredential();
      cred.type = CredentialType.OAUTH2;
      (cred.getDecryptedConfig as jest.Mock).mockReturnValue({});

      await expect(
        service.refreshOAuthToken(cred as unknown as Credential),
      ).rejects.toThrow(BadRequestException);
    });

    it('should deactivate credential and throw on refresh failure', async () => {
      const cred = mockCredential();
      cred.type = CredentialType.OAUTH2;
      (cred.getDecryptedConfig as jest.Mock).mockReturnValue({
        refreshToken: 'rt',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'c',
        clientSecret: 's',
      });
      credentialRepository.save.mockResolvedValue(cred);

      (axios.post as jest.Mock).mockRejectedValue(new Error('invalid_grant'));

      await expect(
        service.refreshOAuthToken(cred as unknown as Credential),
      ).rejects.toThrow(BadRequestException);

      expect(cred.isActive).toBe(false);
      expect(credentialRepository.save).toHaveBeenCalled();
    });
  });

  describe('markUsed', () => {
    it('should update lastUsedAt timestamp', async () => {
      credentialRepository.update.mockResolvedValue({ affected: 1 });

      await service.markUsed('cred-1');

      expect(credentialRepository.update).toHaveBeenCalledWith(
        'cred-1',
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
    });
  });

  describe('maskCredential (private, tested via public methods)', () => {
    it('should mask encrypted values with bullets', async () => {
      const cred = mockCredential();
      cred.config = {
        apiKey: 'encrypted:abc:def',
        baseUrl: 'https://api.example.com', // non-sensitive, should not be masked
      };
      credentialRepository.find.mockResolvedValue([cred]);

      const result = await service.getCredentials('api-1', 'org-1');

      expect(result[0].config.apiKey).toBe('••••••••');
      expect(result[0].config.baseUrl).toBe('https://api.example.com');
    });

    it('should partially mask long non-encrypted sensitive values', async () => {
      const cred = mockCredential();
      cred.config = {
        token: 'sk-long-plaintext-token-value',
      };
      credentialRepository.find.mockResolvedValue([cred]);

      const result = await service.getCredentials('api-1', 'org-1');

      expect(result[0].config.token).toBe('sk-l••••••••');
    });

    it('should fully mask short sensitive values', async () => {
      const cred = mockCredential();
      cred.config = {
        password: 'short',
      };
      credentialRepository.find.mockResolvedValue([cred]);

      const result = await service.getCredentials('api-1', 'org-1');

      expect(result[0].config.password).toBe('••••••••');
    });

    it('should not mask non-sensitive fields', async () => {
      const cred = mockCredential();
      cred.config = {
        username: 'admin',
        baseUrl: 'https://api.example.com',
        timeout: 5000,
      };
      credentialRepository.find.mockResolvedValue([cred]);

      const result = await service.getCredentials('api-1', 'org-1');

      expect(result[0].config.username).toBe('admin');
      expect(result[0].config.baseUrl).toBe('https://api.example.com');
      expect(result[0].config.timeout).toBe(5000);
    });

    it('should handle null config gracefully', async () => {
      const cred = mockCredential();
      cred.config = null;
      credentialRepository.find.mockResolvedValue([cred]);

      const result = await service.getCredentials('api-1', 'org-1');

      expect(result[0].config).toBeNull();
    });
  });

  describe('org isolation', () => {
    it('should only query credentials scoped to the given organization', async () => {
      credentialRepository.find.mockResolvedValue([]);

      await service.getCredentials('api-1', 'org-1');

      const callArgs = credentialRepository.find.mock.calls[0][0];
      expect(callArgs.where.organizationId).toBe('org-1');
    });

    it('should only find credentials for execution scoped to org', async () => {
      credentialRepository.findOne.mockResolvedValue(null);

      await service.getCredentialForExecution('api-1', 'org-1');

      const callArgs = credentialRepository.findOne.mock.calls[0][0];
      expect(callArgs.where.organizationId).toBe('org-1');
      expect(callArgs.where.isActive).toBe(true);
    });

    it('should scope create to the correct org', async () => {
      const cred = mockCredential();
      apiRepository.findOne.mockResolvedValue(mockApi);
      credentialRepository.create.mockReturnValue(cred);
      credentialRepository.save.mockResolvedValue(cred);

      await service.createCredential('api-1', 'org-1', {
        name: 'Key',
        type: CredentialType.API_KEY,
        config: { apiKey: 'test' },
      });

      expect(credentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1' }),
      );
    });
  });
});
