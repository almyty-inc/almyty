import { unlimitedQuotaManager } from '../../../test/tool-quota.fake';
import { ConflictException } from '@nestjs/common';

import { GatewaysService, HOSTED_CHAT_SLUG_INDEX } from '../gateways.service';
import { HostedChatService } from '../channels/hosted-chat.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { ClauseModel, ExecutedQuery, RecordingQueryBuilder, matchingRows } from './recording-query-builder';

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

    /**
     * The pre-check's claim query, evaluated against a gateways table
     * holding no real claim on 'acme' -- only a hosted chat on another
     * slug and a non-hosted-chat gateway whose configuration carries the
     * same block. The pre-check has to pass, so the conflict these tests
     * see comes from the index. The canned `[]` that stood here passed
     * with the type or slug predicate deleted, and since the pre-check's
     * conflict reads the same, the tests could not tell which one fired.
     */
    const CLAIM_CLAUSES: ClauseModel = {
      'gateway.type = :type': (row, p) => row.type === p.type,
      "gateway.configuration -> 'hostedChat' ->> 'slug' = :slug": (row, p) =>
        row.configuration?.hostedChat?.slug === p.slug,
    };
    const GATEWAYS = [
      { id: 'gw-globex', type: GatewayType.HOSTED_CHAT, configuration: { hostedChat: { slug: 'globex' } } },
      { id: 'gw-mcp', type: GatewayType.MCP, configuration: { hostedChat: { slug: 'acme' } } },
    ];
    let claimQuery: RecordingQueryBuilder | undefined;

    beforeEach(() => {
      claimQuery = undefined;
      gatewayRepository = {
        get manager() { return unlimitedQuotaManager(this); },
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((row: any) => row),
        save: jest.fn(async (row: any) => row),
        createQueryBuilder: jest.fn(
          (alias: string) =>
            (claimQuery = new RecordingQueryBuilder(alias, {
              getMany: (query: ExecutedQuery) => matchingRows(query, GATEWAYS, CLAIM_CLAUSES),
            })),
        ),
      };
      service = makeService();
    });

    it('turns the slug index violation on create into a conflict, not a 500', async () => {
      gatewayRepository.save.mockRejectedValue(uniqueViolation(HOSTED_CHAT_SLUG_INDEX));

      const attempt = service.createGateway(createDto as any, 'org-1', 'user-1');

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow("The web address 'acme' is already in use");
      // The pre-check ran and passed; the index decided.
      expect(claimQuery?.executed).toHaveLength(1);
      expect(gatewayRepository.save).toHaveBeenCalled();
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
      expect(claimQuery?.executed).toHaveLength(1);
      expect(gatewayRepository.save).toHaveBeenCalled();
    });

    it('leaves every other unique violation alone', async () => {
      // Misreporting an endpoint clash as a slug clash would send the
      // caller to rename the wrong thing.
      gatewayRepository.save.mockRejectedValue(uniqueViolation('UQ_gateways_org_endpoint'));

      await expect(
        service.createGateway(createDto as any, 'org-1', 'user-1'),
      ).rejects.not.toBeInstanceOf(ConflictException);
    });

    // findByCustomDomain serves only `status: 'active'`, on the promise
    // that a domain gets there by passing the TXT check. But the block
    // lives in the same configuration json the tenant writes, so a PATCH
    // could simply say it was active: any hostname, no DNS record, and
    // /public/chat/by-host would serve that tenant for it -- including a
    // hostname another tenant had verified, which the fail-closed
    // ambiguity rule then takes offline for its real owner.
    describe('custom domain is server-owned', () => {
      const forged = { hostname: 'chat.victim.com', status: 'active', verificationToken: 'x', verifiedAt: null, lastCheckedAt: null, lastError: null };

      it('drops a custom domain supplied on create', async () => {
        await service.createGateway(
          { ...createDto, configuration: { ...hostedChatConfig, customDomain: forged } } as any,
          'org-1',
          'user-1',
        );

        const saved = gatewayRepository.save.mock.calls[0][0];
        expect(saved.configuration.customDomain).toBeUndefined();
      });

      it('drops a custom domain supplied on update', async () => {
        gatewayRepository.findOne.mockResolvedValue({
          id: 'gw-1',
          organizationId: 'org-1',
          type: GatewayType.HOSTED_CHAT,
          configuration: { hostedChat: { slug: 'acme', appName: 'Acme' } },
        });

        await service.updateGateway(
          'gw-1',
          { configuration: { ...hostedChatConfig, customDomain: forged } } as any,
          'org-1',
          'user-1',
        );

        const saved = gatewayRepository.save.mock.calls[0][0];
        expect(saved.configuration.customDomain).toBeUndefined();
      });

      it('keeps the stored domain, whatever the body says about it', async () => {
        const stored = { ...forged, hostname: 'chat.acme.com', status: 'pending_verification' };
        gatewayRepository.findOne.mockResolvedValue({
          id: 'gw-1',
          organizationId: 'org-1',
          type: GatewayType.HOSTED_CHAT,
          configuration: { hostedChat: { slug: 'acme', appName: 'Acme' }, customDomain: stored },
        });

        await service.updateGateway(
          'gw-1',
          { configuration: { ...hostedChatConfig, customDomain: { ...stored, status: 'active' } } } as any,
          'org-1',
          'user-1',
        );

        const saved = gatewayRepository.save.mock.calls[0][0];
        expect(saved.configuration.customDomain).toEqual(stored);
      });

      it('keeps the stored domain when an edit round-trips the config without it', async () => {
        const stored = { ...forged, hostname: 'chat.acme.com' };
        gatewayRepository.findOne.mockResolvedValue({
          id: 'gw-1',
          organizationId: 'org-1',
          type: GatewayType.HOSTED_CHAT,
          configuration: { hostedChat: { slug: 'acme', appName: 'Acme' }, customDomain: stored },
        });

        await service.updateGateway('gw-1', { configuration: hostedChatConfig } as any, 'org-1', 'user-1');

        const saved = gatewayRepository.save.mock.calls[0][0];
        expect(saved.configuration.customDomain).toEqual(stored);
      });
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

    /**
     * A query builder that applies the clauses it is given to `rows`.
     *
     * The canned version returned `rows` whatever was asked, so the
     * hostname was never compared and the `status = 'active'` clause -- the
     * one that keeps an unverified claim off a live domain -- could be
     * deleted with every test green. A clause not modelled here throws.
     */
    const CLAUSES: Record<string, (row: any, params: any) => boolean> = {
      'gateway.type = :type': (row, p) => row.type === p.type,
      "gateway.configuration -> 'customDomain' ->> 'hostname' = :hostname": (row, p) =>
        row.configuration?.customDomain?.hostname === p.hostname,
      "gateway.configuration -> 'customDomain' ->> 'status' = :status": (row, p) =>
        row.configuration?.customDomain?.status === p.status,
    };

    const serviceFor = (rows: Gateway[]) => {
      const gatewayRepository: any = {
        createQueryBuilder: jest.fn(() => {
          const filters: Array<(row: any) => boolean> = [];
          const add = (clause: string, params: any) => {
            const test = CLAUSES[clause];
            if (!test) throw new Error(`unmodelled clause in findByCustomDomain: ${clause}`);
            filters.push((row) => test(row, params));
            return qb;
          };
          const qb: any = {
            where: add,
            andWhere: add,
            getMany: async () => rows.filter((row) => filters.every((f) => f(row))),
          };
          return qb;
        }),
      };
      return new HostedChatService(
        gatewayRepository,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    };

    it('resolves the single live claimant, matching the hostname case-insensitively', async () => {
      await expect(serviceFor([gateway()]).findByCustomDomain('Chat.Acme.com ')).resolves.toMatchObject(
        { id: 'gw-1' },
      );
    });

    // Serving a claim still `pending` would let anyone point a hostname at
    // the platform and take delivery before proving they own it.
    it('does not serve a claim that has not finished verification', async () => {
      const pending = gateway({
        configuration: { customDomain: { hostname: 'chat.acme.com', status: 'pending' } },
      } as any);

      await expect(serviceFor([pending]).findByCustomDomain('chat.acme.com')).resolves.toBeNull();
    });

    it('does not answer with a gateway that claims a different hostname', async () => {
      await expect(serviceFor([gateway()]).findByCustomDomain('chat.other.com')).resolves.toBeNull();
    });

    it('does not answer with a gateway of another type holding the same claim', async () => {
      const widget = gateway({ type: GatewayType.CHAT_WIDGET } as any);

      await expect(serviceFor([widget]).findByCustomDomain('chat.acme.com')).resolves.toBeNull();
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
