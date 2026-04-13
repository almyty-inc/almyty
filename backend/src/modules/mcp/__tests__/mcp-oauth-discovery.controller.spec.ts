import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { McpOAuthDiscoveryController } from '../controllers/mcp-oauth-discovery.controller';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';

describe('McpOAuthDiscoveryController', () => {
  let controller: McpOAuthDiscoveryController;
  let gatewayRepo: any;
  let orgRepo: any;

  const mockOrg = { id: 'org-1', slug: 'acme', name: 'Acme' };
  const mockGateway = {
    id: 'gw-1',
    name: 'my-gateway',
    endpoint: '/my-gateway',
    organizationId: 'org-1',
    status: GatewayStatus.ACTIVE,
  };

  beforeEach(async () => {
    gatewayRepo = {
      findOne: jest.fn().mockResolvedValue(mockGateway),
    };
    orgRepo = {
      findOne: jest.fn().mockResolvedValue(mockOrg),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpOAuthDiscoveryController],
      providers: [
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepo },
        { provide: getRepositoryToken(Organization), useValue: orgRepo },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'BASE_URL') return 'https://api.example.com';
              if (key === 'NODE_ENV') return 'test';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get(McpOAuthDiscoveryController);
  });

  describe('GET /.well-known/oauth-authorization-server/mcp/:org/:gw', () => {
    it('returns RFC 8414 metadata with correct endpoints', async () => {
      const result = await controller.authServerMetadata('acme', 'my-gateway');

      expect(result.issuer).toBe('https://api.example.com/mcp/acme/my-gateway');
      expect(result.authorization_endpoint).toBe('https://api.example.com/mcp/acme/my-gateway/authorize');
      expect(result.token_endpoint).toBe('https://api.example.com/mcp/acme/my-gateway/token');
      expect(result.registration_endpoint).toBe('https://api.example.com/mcp/acme/my-gateway/register');
      expect(result.revocation_endpoint).toBe('https://api.example.com/mcp/acme/my-gateway/revoke');
      expect(result.response_types_supported).toEqual(['code']);
      expect(result.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('returns 404 for non-existent org', async () => {
      orgRepo.findOne.mockResolvedValue(null);

      await expect(controller.authServerMetadata('bad-org', 'my-gateway'))
        .rejects.toThrow(HttpException);
    });

    it('returns 404 for non-existent gateway', async () => {
      gatewayRepo.findOne.mockResolvedValue(null);

      await expect(controller.authServerMetadata('acme', 'bad-gw'))
        .rejects.toThrow(HttpException);
    });
  });

  describe('GET /.well-known/oauth-protected-resource/mcp/:org/:gw', () => {
    it('returns RFC 9728 resource metadata', async () => {
      const result = await controller.protectedResourceMetadata('acme', 'my-gateway');

      expect(result.resource).toBe('https://api.example.com/mcp/acme/my-gateway');
      expect(result.authorization_servers).toEqual(['https://api.example.com/mcp/acme/my-gateway']);
      expect(result.bearer_methods_supported).toEqual(['header']);
      expect(result.resource_name).toBe('my-gateway');
    });

    it('returns 404 for non-existent org', async () => {
      orgRepo.findOne.mockResolvedValue(null);

      await expect(controller.protectedResourceMetadata('bad-org', 'my-gateway'))
        .rejects.toThrow(HttpException);
    });
  });
});
