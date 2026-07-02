import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { GatewaysService } from '../gateways.service';
import { GatewaysStatsHelper } from '../gateways-stats.helper';
import { GatewayInitHelper } from '../gateway-init.helper';
import { Gateway, GatewayKind, GatewayType } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { GatewayAuth } from '../../../entities/gateway-auth.entity';
import { User } from '../../../entities/user.entity';
import { Organization } from '../../../entities/organization.entity';
import { UsageMetric } from '../../../entities/usage-metric.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';

/**
 * n:m deployment regression lock.
 *
 * Agents and channel deployments are many-to-many: one agent can be
 * deployed to any number of channels (including several channels of
 * the SAME type — e.g. two Slack apps for two audiences), and one
 * channel type can back any number of agents. The only uniqueness
 * constraint is the (organizationId, endpoint) pair.
 *
 * This spec exists to fail loudly if anyone "helpfully" adds a
 * cardinality restriction (one-channel-per-type-per-agent or similar)
 * to GatewaysService.createGateway.
 */
describe('n:m deployment invariant (GatewaysService.createGateway)', () => {
  let service: GatewaysService;
  let gatewayRepository: any;
  let organizationRepository: any;
  let userRepository: any;

  let savedGateways: Gateway[];

  beforeEach(async () => {
    savedGateways = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewaysStatsHelper,
        GatewayInitHelper,
        GatewaysService,
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            // Endpoint-uniqueness lookup: emulate the real DB by
            // matching against everything "saved" so far.
            findOne: jest.fn(async ({ where }: any) =>
              savedGateways.find(
                (g) => g.endpoint === where.endpoint && g.organizationId === where.organizationId,
              ) || null,
            ),
            find: jest.fn(),
            create: jest.fn((data: any) => Object.assign(new Gateway(), data)),
            save: jest.fn(async (g: Gateway) => {
              g.id = g.id || `gw-${savedGateways.length + 1}`;
              savedGateways.push(g);
              return g;
            }),
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
          useValue: { find: jest.fn(), create: jest.fn((d: any) => d), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(async () => ({
              id: 'user-1',
              hasPermissionInOrganization: jest.fn().mockReturnValue(true),
            })),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(async () => ({
              id: 'org-1',
              name: 'Test Org',
              canAddMoreGateways: jest.fn().mockReturnValue(true),
            })),
          },
        },
        {
          provide: getRepositoryToken(UsageMetric),
          useValue: { find: jest.fn(), create: jest.fn(), save: jest.fn() },
        },
        {
          provide: AuditLogService,
          useValue: {
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
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

    service = module.get<GatewaysService>(GatewaysService);
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    organizationRepository = module.get(getRepositoryToken(Organization));
    userRepository = module.get(getRepositoryToken(User));
  });

  const channelDto = (over: Partial<Record<string, any>> = {}) => ({
    name: 'Slack channel',
    type: GatewayType.SLACK,
    agentId: 'agent-1',
    endpoint: '/slack-1',
    configuration: { bot_token: 'xoxb-1' },
    ...over,
  });

  it('allows the SAME agent on two channels of the SAME type (different endpoints)', async () => {
    const first = await service.createGateway(
      channelDto({ name: 'Slack internal', endpoint: '/slack-internal' }) as any,
      'org-1',
      'user-1',
    );
    const second = await service.createGateway(
      channelDto({ name: 'Slack customers', endpoint: '/slack-customers' }) as any,
      'org-1',
      'user-1',
    );

    expect(first.id).toBeDefined();
    expect(second.id).toBeDefined();
    expect(first.id).not.toBe(second.id);
    expect(savedGateways.filter((g) => g.type === GatewayType.SLACK && g.agentId === 'agent-1')).toHaveLength(2);
  });

  it('allows the SAME agent on mixed channel types', async () => {
    const slack = await service.createGateway(
      channelDto({ endpoint: '/mix-slack' }) as any,
      'org-1',
      'user-1',
    );
    const telegram = await service.createGateway(
      channelDto({
        name: 'Telegram channel',
        type: GatewayType.TELEGRAM,
        endpoint: '/mix-telegram',
        configuration: { bot_token: '123:abc' },
      }) as any,
      'org-1',
      'user-1',
    );
    const widget = await service.createGateway(
      channelDto({
        name: 'Widget',
        type: GatewayType.CHAT_WIDGET,
        endpoint: '/mix-widget',
        configuration: {},
      }) as any,
      'org-1',
      'user-1',
    );

    expect([slack, telegram, widget].every((g) => g.agentId === 'agent-1')).toBe(true);
    expect(savedGateways).toHaveLength(3);
  });

  it('allows TWO different agents each on a channel of the same type', async () => {
    const a = await service.createGateway(
      channelDto({ agentId: 'agent-a', endpoint: '/agent-a-slack' }) as any,
      'org-1',
      'user-1',
    );
    const b = await service.createGateway(
      channelDto({ agentId: 'agent-b', endpoint: '/agent-b-slack' }) as any,
      'org-1',
      'user-1',
    );

    expect(a.agentId).toBe('agent-a');
    expect(b.agentId).toBe('agent-b');
    expect(a.type).toBe(GatewayType.SLACK);
    expect(b.type).toBe(GatewayType.SLACK);
  });

  it('still enforces the ONLY real uniqueness rule: (organizationId, endpoint)', async () => {
    await service.createGateway(channelDto({ endpoint: '/dupe' }) as any, 'org-1', 'user-1');
    await expect(
      service.createGateway(
        channelDto({ agentId: 'agent-other', endpoint: '/dupe' }) as any,
        'org-1',
        'user-1',
      ),
    ).rejects.toThrow(/Endpoint already exists/);
  });

  it('marks channel deployments agent-kind (regression: kind inference)', async () => {
    const gw = await service.createGateway(
      channelDto({ endpoint: '/kind-check' }) as any,
      'org-1',
      'user-1',
    );
    expect(gw.kind).toBe(GatewayKind.AGENT);
    expect(organizationRepository.findOne).toHaveBeenCalled();
    expect(userRepository.findOne).toHaveBeenCalled();
    expect(gatewayRepository.save).toHaveBeenCalled();
  });
});
