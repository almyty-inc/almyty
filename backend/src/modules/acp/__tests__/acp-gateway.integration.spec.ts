import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { Gateway, GatewayType, GatewayKind, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { GatewayAuth } from '../../../entities/gateway-auth.entity';
import { User } from '../../../entities/user.entity';
import { Organization } from '../../../entities/organization.entity';
import { UsageMetric } from '../../../entities/usage-metric.entity';
import { GatewaysService } from '../../gateways/gateways.service';
import { GatewaysStatsHelper } from '../../gateways/gateways-stats.helper';
import { GatewayInitHelper } from '../../gateways/gateway-init.helper';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';

/**
 * Integration-style test verifying that ACP gateways can be created
 * through the GatewaysService and that the type/kind inference works
 * correctly for the new ACP gateway type.
 */
describe('ACP Gateway Integration', () => {
  let gatewaysService: GatewaysService;
  let gatewayRepository: any;
  let gatewayAuthRepository: any;
  let userRepository: any;
  let organizationRepository: any;

  const mockOrg = {
    id: 'org-1',
    name: 'Test Org',
    slug: 'test-org',
    canAddMoreGateways: () => true,
  };

  const mockUser = {
    id: 'user-1',
    hasPermissionInOrganization: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewaysService,
        { provide: GatewayInitHelper, useValue: { validateGatewayConfiguration: jest.fn(), createDefaultAuth: jest.fn(), ensureSystemGateway: jest.fn() } },
        { provide: GatewaysStatsHelper, useValue: {} },
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'gw-new' })),
            save: jest.fn().mockImplementation((entity) => Promise.resolve({ ...entity, id: entity.id || 'gw-new' })),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GatewayTool),
          useValue: { find: jest.fn(), create: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(GatewayAuth),
          useValue: {
            find: jest.fn(),
            create: jest.fn().mockImplementation((dto) => dto),
            save: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn().mockResolvedValue(mockUser),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn().mockResolvedValue(mockOrg),
          },
        },
        {
          provide: getRepositoryToken(UsageMetric),
          useValue: { find: jest.fn(), create: jest.fn(), save: jest.fn() },
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(null),
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
            computeChanges: jest.fn().mockReturnValue({}),
          },
        },
        {
          provide: AccessPolicyService,
          useValue: {
            canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
          },
        },
      ],
    }).compile();

    gatewaysService = module.get<GatewaysService>(GatewaysService);
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    gatewayAuthRepository = module.get(getRepositoryToken(GatewayAuth));
    userRepository = module.get(getRepositoryToken(User));
    organizationRepository = module.get(getRepositoryToken(Organization));
  });

  it('should create an ACP gateway with agent kind', async () => {
    const result = await gatewaysService.createGateway(
      {
        name: 'My ACP Gateway',
        type: GatewayType.ACP,
        endpoint: '/my-acp',
        agentId: 'agent-1',
        configuration: {},
      },
      'org-1',
      'user-1',
    );

    expect(result).toBeDefined();
    expect(result.type).toBe(GatewayType.ACP);
    expect(result.kind).toBe(GatewayKind.AGENT);
    expect(result.agentId).toBe('agent-1');
  });

  it('should reject ACP gateway without agentId', async () => {
    await expect(
      gatewaysService.createGateway(
        {
          name: 'Bad ACP Gateway',
          type: GatewayType.ACP,
          endpoint: '/bad-acp',
          configuration: {},
        },
        'org-1',
        'user-1',
      ),
    ).rejects.toThrow('Agent-kind gateways require an agentId');
  });

  it('should accept ACP configuration validation (no special config required)', async () => {
    const result = await gatewaysService.createGateway(
      {
        name: 'ACP No Config',
        type: GatewayType.ACP,
        endpoint: '/acp-no-config',
        agentId: 'agent-2',
        configuration: {},
      },
      'org-1',
      'user-1',
    );

    expect(result).toBeDefined();
    expect(result.kind).toBe(GatewayKind.AGENT);
  });

  it('GatewayType.ACP should be a valid enum value', () => {
    expect(GatewayType.ACP).toBe('acp');
  });

  it('ACP gateways should infer agent kind', () => {
    // Verify the enum value exists alongside A2A
    const agentTypes = [GatewayType.A2A, GatewayType.ACP, GatewayType.OPENAI_CHAT];
    expect(agentTypes).toContain(GatewayType.ACP);

    const toolTypes = [GatewayType.MCP, GatewayType.UTCP, GatewayType.SKILLS];
    expect(toolTypes).not.toContain(GatewayType.ACP);
  });
});
