import { NotFoundException } from '@nestjs/common';

import { GatewaysService } from '../gateways.service';

/**
 * `GET /gateways/resolve/:orgSlug/:gatewaySlug` acted on the slug in the
 * path while `RolesGuard` checked the role against the caller's OWN org.
 *
 * `extractOrganizationId` only recognises a param literally named
 * `organizationId`, so it fell back to `currentOrganizationId` — the role
 * check passed on the attacker's org and the handler answered for the
 * victim's. Org slugs are public (they are in every unified-endpoint URL),
 * so `GET /gateways/resolve/victim-corp/prod-gateway` from a member of any
 * unrelated org returned the victim gateway's UUID, name, type and
 * endpoint. That UUID is the identifier the MCP, widget and install
 * surfaces address, which is the useful half.
 *
 * The refusal is 404 rather than 403, so the route says nothing about
 * whether the slug exists either.
 */
describe('resolveGateway is scoped to the caller\'s organization', () => {
  const VICTIM_ORG_ID = 'org-victim';
  const CALLER_ORG_ID = 'org-caller';

  function makeService(overrides: { org?: any; gateway?: any } = {}) {
    const organizationRepository = { findOne: jest.fn(async () => overrides.org ?? null) };
    const gatewayRepository = {
      findOne: jest.fn(async () => overrides.gateway ?? null),
      find: jest.fn(async () => (overrides.gateway ? [overrides.gateway] : [])),
    };
    const service = Object.create(GatewaysService.prototype) as GatewaysService;
    (service as any).organizationRepository = organizationRepository;
    (service as any).gatewayRepository = gatewayRepository;
    return { service, organizationRepository, gatewayRepository };
  }

  const VICTIM_ORG = { id: VICTIM_ORG_ID, slug: 'victim-corp' };
  const VICTIM_GATEWAY = {
    id: 'gw-secret',
    name: 'Prod Gateway',
    organizationId: VICTIM_ORG_ID,
    endpoint: '/prod-gateway',
  };

  it('refuses a slug belonging to another organization', async () => {
    const { service, gatewayRepository } = makeService({
      org: VICTIM_ORG,
      gateway: VICTIM_GATEWAY,
    });

    await expect(
      service.resolveGateway('victim-corp', 'prod-gateway', CALLER_ORG_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Not merely filtered afterwards: the gateway is never loaded.
    expect(gatewayRepository.findOne).not.toHaveBeenCalled();
    expect(gatewayRepository.find).not.toHaveBeenCalled();
  });

  it('says the same thing for a slug that does not exist', async () => {
    const { service } = makeService({ org: null });
    await expect(
      service.resolveGateway('no-such-org', 'prod-gateway', CALLER_ORG_ID),
    ).rejects.toThrow(/Gateway not found/);
  });

  it('resolves a gateway in the caller\'s own organization', async () => {
    const { service } = makeService({
      org: { id: CALLER_ORG_ID, slug: 'caller-corp' },
      gateway: { ...VICTIM_GATEWAY, organizationId: CALLER_ORG_ID },
    });

    const gateway = await service.resolveGateway('caller-corp', 'prod-gateway', CALLER_ORG_ID);
    expect(gateway.id).toBe('gw-secret');
  });
});
