import { unlimitedQuotaManager } from '../../../test/tool-quota.fake';
import { ConflictException } from '@nestjs/common';

import { GatewaysService, HOSTED_CHAT_SLUG_INDEX } from '../gateways.service';
import { HostedChatService } from '../channels/hosted-chat.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';

/**
 * A hosted chat's slug and custom domain are global public addresses,
 * and neither the writer nor the reader used to treat them that way.
 *
 * The writer reserved a slug with a SELECT followed by an INSERT, so two
 * organizations publishing the same app name at the same moment both
 * landed. The reader fails closed on an ambiguous slug, so the result
 * was the public page going dark for both tenants until somebody deleted
 * a row by hand. The partial unique index decides the race now; these
 * tests cover the service half: the losing writer has to come back as a
 * conflict, and an ambiguous custom domain has to fail closed the way an
 * ambiguous slug already does.
 */
const uniqueViolation = (constraint: string) =>
  Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });

describe('hosted-chat address claims', () => {
  describe('GatewaysService — slug index violations', () => {
    let gatewayRepository: any;
    let service: GatewaysService;

    const hostedChatConfig = {
      hostedChat: {
        slug: 'acme',
        appName: 'Acme',
        aiDisclosure: 'You are chatting with an AI assistant.',
        whiteLabel: false,
        authMode: 'public_link',
      },
    };

    const createDto = {
      name: 'Acme chat',
      type: GatewayType.HOSTED_CHAT,
      agentId: 'agent-1',
      endpoint: '/acme-chat',
      configuration: hostedChatConfig,
    };

    const makeService = () =>
      new GatewaysService(
        gatewayRepository,
        {} as any, // gatewayTool repo
        {} as any, // gatewayAuth repo
        {
          findOne: jest.fn().mockResolvedValue({
            hasPermissionInOrganization: () => true,
          }),
        } as any, // user repo
        {
          findOne: jest.fn().mockResolvedValue({ canAddMoreGateways: () => true }),
        } as any, // organization repo
        {} as any, // usageMetric repo
        {
          logCreate: jest.fn(),
          logUpdate: jest.fn(),
          computeChanges: jest.fn().mockReturnValue({}),
        } as any,
        {} as any, // stats helper
        {
          validateGatewayConfiguration: jest.fn(),
          createDefaultAuth: jest.fn().mockResolvedValue(undefined),
        } as any,
        {
          canAccess: jest.fn().mockResolvedValue({ allowed: true }),
          assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
        } as any,
      );

    beforeEach(() => {
      gatewayRepository = {
        get manager() { return unlimitedQuotaManager(this); },
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((row: any) => row),
        save: jest.fn(async (row: any) => row),
        createQueryBuilder: jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        })),
      };
      service = makeService();
    });

    it('turns the slug index violation on create into a conflict, not a 500', async () => {
      gatewayRepository.save.mockRejectedValue(uniqueViolation(HOSTED_CHAT_SLUG_INDEX));

      const attempt = service.createGateway(createDto as any, 'org-1', 'user-1');

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow("The web address 'acme' is already in use");
    });

    it('turns the slug index violation on update into the same conflict', async () => {
      gatewayRepository.findOne.mockResolvedValue({
        id: 'gw-1',
        organizationId: 'org-1',
        type: GatewayType.HOSTED_CHAT,
        configuration: { hostedChat: { slug: 'old', appName: 'Old' } },
      });
      gatewayRepository.save.mockRejectedValue(uniqueViolation(HOSTED_CHAT_SLUG_INDEX));

      const attempt = service.updateGateway(
        'gw-1',
        { configuration: hostedChatConfig } as any,
        'org-1',
        'user-1',
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow("The web address 'acme' is already in use");
    });

    it('leaves every other unique violation alone', async () => {
      // Misreporting an endpoint clash as a slug clash would send the
      // caller to rename the wrong thing.
      gatewayRepository.save.mockRejectedValue(uniqueViolation('UQ_gateways_org_endpoint'));

      await expect(
        service.createGateway(createDto as any, 'org-1', 'user-1'),
      ).rejects.not.toBeInstanceOf(ConflictException);
    });
  });

  describe('HostedChatService.findByCustomDomain', () => {
    const gateway = (over: Partial<Gateway> = {}): Gateway =>
      ({
        id: 'gw-1',
        type: GatewayType.HOSTED_CHAT,
        status: GatewayStatus.ACTIVE,
        configuration: { customDomain: { hostname: 'chat.acme.com', status: 'active' } },
        isActive: () => true,
        ...over,
      } as unknown as Gateway);

    const serviceFor = (rows: Gateway[]) => {
      const gatewayRepository: any = {
        createQueryBuilder: jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(rows),
        })),
      };
      return new HostedChatService(
        gatewayRepository,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    };

    it('resolves the single live claimant', async () => {
      await expect(serviceFor([gateway()]).findByCustomDomain('Chat.Acme.com ')).resolves.toMatchObject(
        { id: 'gw-1' },
      );
    });

    it('refuses to serve a hostname two live gateways claim', async () => {
      const service = serviceFor([gateway(), gateway({ id: 'gw-2' } as any)]);

      await expect(service.findByCustomDomain('chat.acme.com')).resolves.toBeNull();
    });

    it('ignores an inactive claimant rather than serving it', async () => {
      const service = serviceFor([
        gateway({ id: 'gw-2', isActive: () => false } as any),
        gateway(),
      ]);

      await expect(service.findByCustomDomain('chat.acme.com')).resolves.toMatchObject({
        id: 'gw-1',
      });
    });

    it('returns null for an unknown hostname', async () => {
      await expect(serviceFor([]).findByCustomDomain('nope.example.com')).resolves.toBeNull();
    });
  });
});
