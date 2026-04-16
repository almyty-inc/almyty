import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpException, HttpStatus } from '@nestjs/common';

import { GatewayResolverService } from '../services/gateway-resolver.service';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { Organization } from '../../../entities/organization.entity';
import { GatewayAuthService } from '../../gateways/gateway-auth.service';

describe('GatewayResolverService', () => {
  let service: GatewayResolverService;
  let gatewayRepository: Repository<Gateway>;
  let organizationRepository: Repository<Organization>;
  let gatewayAuthService: GatewayAuthService;

  const mockOrganization: Partial<Organization> = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Test Org',
    slug: 'test-org',
    isActive: true,
  };

  const mockGateway: Partial<Gateway> = {
    id: 'gw-1',
    name: 'My Gateway',
    endpoint: '/my-gateway',
    organizationId: '550e8400-e29b-41d4-a716-446655440000',
    status: GatewayStatus.ACTIVE,
    authConfigs: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewayResolverService,
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: GatewayAuthService,
          useValue: {
            authenticateRequest: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GatewayResolverService>(GatewayResolverService);
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    organizationRepository = module.get(getRepositoryToken(Organization));
    gatewayAuthService = module.get<GatewayAuthService>(GatewayAuthService);
  });

  describe('resolveOrganization', () => {
    it('should find org by UUID', async () => {
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);

      const result = await service.resolveOrganization('550e8400-e29b-41d4-a716-446655440000');

      expect(result).toEqual(mockOrganization);
      expect(organizationRepository.findOne).toHaveBeenCalledWith({
        where: { id: '550e8400-e29b-41d4-a716-446655440000' },
      });
    });

    it('should find org by slug', async () => {
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);

      const result = await service.resolveOrganization('test-org');

      expect(result).toEqual(mockOrganization);
      expect(organizationRepository.findOne).toHaveBeenCalledWith({
        where: { slug: 'test-org' },
      });
    });

    it('should find org by name-based slug fallback', async () => {
      // First findOne (by slug) returns null
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(null);
      // Fallback: JSONB query via createQueryBuilder (previously
      // this path loaded every org into memory via `.find()` — now
      // it's a single targeted SQL query). Monkey-patch the
      // createQueryBuilder property onto the mocked repo since
      // mockRepository() doesn't provide it.
      const orgWithName = { ...mockOrganization, name: 'My Cool Org', slug: 'something-else' };
      const qbStub: any = {
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(orgWithName),
      };
      (organizationRepository as any).createQueryBuilder = jest.fn().mockReturnValue(qbStub);

      const result = await service.resolveOrganization('my-cool-org');

      expect(result).toEqual(orgWithName);
      expect(qbStub.where).toHaveBeenCalled();
      expect(qbStub.getOne).toHaveBeenCalled();
    });

    it('should throw 404 for non-existent org', async () => {
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(null);
      const qbStub: any = {
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      (organizationRepository as any).createQueryBuilder = jest.fn().mockReturnValue(qbStub);

      await expect(service.resolveOrganization('does-not-exist')).rejects.toThrow(HttpException);
      await expect(service.resolveOrganization('does-not-exist')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('resolveGateway', () => {
    it('should find active gateway by endpoint', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as Gateway);

      const result = await service.resolveGateway(mockOrganization.id, '/my-gateway');

      expect(result).toEqual(mockGateway);
      expect(gatewayRepository.findOne).toHaveBeenCalledWith({
        where: {
          endpoint: '/my-gateway',
          organizationId: mockOrganization.id,
          status: GatewayStatus.ACTIVE,
        },
        relations: ['organization', 'authConfigs'],
      });
    });

    it('should normalize endpoint by adding leading /', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as Gateway);

      await service.resolveGateway(mockOrganization.id, 'my-gateway');

      expect(gatewayRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            endpoint: '/my-gateway',
          }),
        }),
      );
    });

    it('should throw 404 for non-existent gateway', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.resolveGateway(mockOrganization.id, '/nonexistent'),
      ).rejects.toThrow(HttpException);

      await expect(
        service.resolveGateway(mockOrganization.id, '/nonexistent'),
      ).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('parsePathSegments', () => {
    it('should extract gateway endpoint and action from URL', () => {
      const req = { path: '/mcp/test-org/my-gateway/messages' };

      const result = service.parsePathSegments(req, 'test-org', 'mcp');

      expect(result).toEqual({
        gatewayEndpoint: '/my-gateway',
        action: 'messages',
      });
    });

    it('should throw 400 for path with less than 2 segments', () => {
      const req = { path: '/mcp/test-org/only-one' };

      expect(() => service.parsePathSegments(req, 'test-org', 'mcp')).toThrow(HttpException);

      try {
        service.parsePathSegments(req, 'test-org', 'mcp');
      } catch (e) {
        expect(e.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });
  });

  describe('resolveAndAuthenticate', () => {
    const mockReq = {
      headers: { authorization: 'Bearer valid-token' },
      query: {},
      body: {},
      ip: '127.0.0.1',
    };

    it('should return org + gateway + auth for valid request', async () => {
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as Gateway);
      jest.spyOn(gatewayAuthService, 'authenticateRequest').mockResolvedValue({
        isValid: true,
        userId: 'user-1',
        scopes: ['read'],
      });

      const result = await service.resolveAndAuthenticate('test-org', '/my-gateway', mockReq);

      expect(result.organization).toEqual(mockOrganization);
      expect(result.gateway).toEqual(mockGateway);
      expect(result.auth.isValid).toBe(true);
      expect(result.auth.userId).toBe('user-1');
    });

    it('should throw 401 with WWW-Authenticate for missing auth', async () => {
      const gatewayWithOAuth = {
        ...mockGateway,
        authConfigs: [{ type: GatewayAuthType.OAUTH2 }],
      };
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gatewayWithOAuth as Gateway);
      jest.spyOn(gatewayAuthService, 'authenticateRequest').mockResolvedValue({
        isValid: false,
        error: 'Authentication required',
        errorCode: 'AUTH_MISSING',
      });

      try {
        await service.resolveAndAuthenticate('test-org', '/my-gateway', mockReq);
        fail('Expected HttpException');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(e.wwwAuthenticate).toBeDefined();
        expect(e.wwwAuthenticate).toContain('Bearer resource_metadata=');
      }
    });

    it('should throw 403 for invalid auth', async () => {
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as Gateway);
      jest.spyOn(gatewayAuthService, 'authenticateRequest').mockResolvedValue({
        isValid: false,
        error: 'Invalid API key',
        errorCode: 'API_KEY_INVALID',
      });

      try {
        await service.resolveAndAuthenticate('test-org', '/my-gateway', mockReq);
        fail('Expected HttpException');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
      }
    });
  });

  describe('buildWwwAuthenticateHeader', () => {
    // buildWwwAuthenticateHeader is private, so we test it through resolveAndAuthenticate
    const mockReq = {
      headers: {},
      query: {},
      body: {},
      ip: '127.0.0.1',
    };

    it('should return Bearer resource_metadata for OAuth2 auth', async () => {
      const gatewayWithOAuth = {
        ...mockGateway,
        endpoint: '/my-gateway',
        authConfigs: [{ type: GatewayAuthType.OAUTH2 }],
      };
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gatewayWithOAuth as Gateway);
      jest.spyOn(gatewayAuthService, 'authenticateRequest').mockResolvedValue({
        isValid: false,
        error: 'Token missing',
        errorCode: 'AUTH_MISSING',
      });

      try {
        await service.resolveAndAuthenticate('test-org', '/my-gateway', mockReq);
        fail('Expected HttpException');
      } catch (e) {
        expect(e.wwwAuthenticate).toMatch(
          /^Bearer resource_metadata=".*\/test-org\/my-gateway\/\.well-known\/oauth-protected-resource"$/,
        );
      }
    });

    it('should return ApiKey header for API_KEY auth', async () => {
      const gatewayWithApiKey = {
        ...mockGateway,
        name: 'My Gateway',
        authConfigs: [{ type: GatewayAuthType.API_KEY }],
      };
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gatewayWithApiKey as Gateway);
      jest.spyOn(gatewayAuthService, 'authenticateRequest').mockResolvedValue({
        isValid: false,
        error: 'API key missing',
        errorCode: 'API_KEY_MISSING',
      });

      try {
        await service.resolveAndAuthenticate('test-org', '/my-gateway', mockReq);
        fail('Expected HttpException');
      } catch (e) {
        expect(e.wwwAuthenticate).toBe('ApiKey realm="My Gateway", header="x-api-key"');
      }
    });

    it('should return generic Bearer for no specific auth', async () => {
      const gatewayWithBearer = {
        ...mockGateway,
        name: 'My Gateway',
        authConfigs: [{ type: GatewayAuthType.BEARER_TOKEN }],
      };
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization as Organization);
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gatewayWithBearer as Gateway);
      jest.spyOn(gatewayAuthService, 'authenticateRequest').mockResolvedValue({
        isValid: false,
        error: 'Token missing',
        errorCode: 'BEARER_TOKEN_MISSING',
      });

      try {
        await service.resolveAndAuthenticate('test-org', '/my-gateway', mockReq);
        fail('Expected HttpException');
      } catch (e) {
        expect(e.wwwAuthenticate).toBe('Bearer realm="My Gateway"');
      }
    });
  });
});
