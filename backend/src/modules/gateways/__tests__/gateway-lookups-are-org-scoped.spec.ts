import { NotFoundException } from '@nestjs/common';

import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { GatewaysService } from '../gateways.service';

/**
 * `getGateway` and `updateGateway` load the gateway by (id, organizationId).
 *
 * gateways.service.spec answers `findOne` with a canned gateway whatever
 * the `where`, so the organizationId in both lookups could be deleted with
 * every gateway suite green -- and getGateway is what activate, deactivate,
 * delete, stats and health checks all load through. Here the table
 * evaluates the `where` and holds another organization's gateway.
 */
describe('GatewaysService gateway lookups are org-scoped', () => {
  const ORG = 'org-mine';
  let gateways: FakeRepository<any>;
  let service: GatewaysService;
  let accessPolicy: { canAccess: jest.Mock; assertCanScopeToTeam: jest.Mock };

  beforeEach(() => {
    gateways = fakeRepository<any>([
      { id: 'gw-mine', organizationId: ORG, name: 'Mine', visibility: 'org' },
      { id: 'gw-foreign', organizationId: 'org-other', name: 'Theirs', visibility: 'org' },
    ]);
    accessPolicy = {
      canAccess: jest.fn(async () => ({ allowed: true, reason: 'ok' })),
      assertCanScopeToTeam: jest.fn(async () => undefined),
    };
    service = Object.create(GatewaysService.prototype) as GatewaysService;
    Object.assign(service as any, {
      gatewayRepository: gateways,
      accessPolicy,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
  });

  it('loads a gateway of the caller organization', async () => {
    await expect(service.getGateway('gw-mine', ORG, false)).resolves.toMatchObject({ id: 'gw-mine' });
  });

  it('reports another organization gateway as not found', async () => {
    await expect(service.getGateway('gw-foreign', ORG, false)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('will not update another organization gateway', async () => {
    await expect(
      service.updateGateway('gw-foreign', { name: 'pwned' } as any, ORG, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gateways.row('gw-foreign')!.name).toBe('Theirs');
    expect(accessPolicy.canAccess).not.toHaveBeenCalled();
  });
});
