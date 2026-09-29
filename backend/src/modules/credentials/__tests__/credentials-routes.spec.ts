import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { CredentialsController } from '../credentials.controller';
import { ConnectionsService } from '../../connections/connections.service';
import { GrantsController } from '../../connections/grants/grants.controller';
import { ConnectionsGovernanceController } from '../../../../ee/modules/connections-governance/connections-governance.controller';

/**
 * Credentials is the one name: every key, token and account is added,
 * listed, checked, replaced and deleted under /credentials, and the
 * older /connections, /connectors and /ee/connections routes keep
 * answering as aliases.
 */
describe('/credentials routes', () => {
  const ORG = 'org-1';
  const member = { id: 'u1', currentOrganizationId: ORG, organizationMemberships: [{ organizationId: ORG, role: 'member', isActive: true, status: 'active' }] };
  const admin = { ...member, organizationMemberships: [{ organizationId: ORG, role: 'admin', isActive: true, status: 'active' }] };

  function build() {
    const credentialsService = {
      findAll: jest.fn().mockResolvedValue([
        { id: 'c1', name: 'GitHub', type: 'api_key', connectorKey: 'github' },
        { id: 'c2', name: 'Petstore key', type: 'api_key', connectorKey: null },
      ]),
      findById: jest.fn(async (id: string) => ({ id, name: id, type: 'api_key', connectorKey: id === 'c1' ? 'github' : null })),
      delete: jest.fn(),
    };
    const connections = {
      list: jest.fn().mockResolvedValue([{ id: 'c1', name: 'GitHub', connectorKey: 'github', health: { status: 'valid' }, owner: 'org' }]),
      get: jest.fn().mockResolvedValue({ id: 'c1', connectorKey: 'github', health: { status: 'valid' }, owner: 'org' }),
      disconnect: jest.fn().mockResolvedValue({ revoked: true }),
      describeConnectors: jest.fn().mockResolvedValue([{ key: 'github' }]),
    };
    const moduleRef = { get: jest.fn((token: unknown) => (token === ConnectionsService ? connections : undefined)) };
    const controller = new CredentialsController(credentialsService as any, moduleRef as any);
    return { controller, credentialsService, connections };
  }

  it('lists every credential, with what its service says added to the ones made through a service', async () => {
    const { controller } = build();
    const res = await controller.findAll({ user: member });
    expect(res.data).toEqual([
      { id: 'c1', name: 'GitHub', type: 'api_key', connectorKey: 'github', health: { status: 'valid' }, owner: 'org' },
      { id: 'c2', name: 'Petstore key', type: 'api_key', connectorKey: null },
    ]);
  });

  it('gets one credential the same way', async () => {
    const { controller } = build();
    expect((await controller.findById('c1', { user: member })).data).toMatchObject({ id: 'c1', type: 'api_key', health: { status: 'valid' } });
    expect((await controller.findById('c2', { user: member })).data).not.toHaveProperty('health');
  });

  it('deletes a credential made through a service by disconnecting it, as whoever may manage it', async () => {
    const { controller, connections, credentialsService } = build();
    await controller.delete('c1', { user: member });
    expect(connections.disconnect).toHaveBeenCalledWith(member, ORG, 'c1');
    expect(credentialsService.delete).not.toHaveBeenCalled();
  });

  it('deletes a key an API keeps only for an admin', async () => {
    const { controller, credentialsService } = build();
    await expect(controller.delete('c2', { user: member })).rejects.toBeInstanceOf(ForbiddenException);
    await controller.delete('c2', { user: admin });
    expect(credentialsService.delete).toHaveBeenCalledWith('c2', ORG, 'u1');
  });

  it('lists the services a credential can be added for', async () => {
    const { controller } = build();
    expect((await controller.listServices({ user: member }, {} as any)).data).toEqual([{ key: 'github' }]);
  });

  it('keeps the older paths as aliases of grants and governance', () => {
    expect(Reflect.getMetadata(PATH_METADATA, GrantsController)).toEqual(['credentials/:id/grants', 'connections/:id/grants']);
    expect(Reflect.getMetadata(PATH_METADATA, ConnectionsGovernanceController)).toEqual(['ee/credentials', 'ee/connections']);
  });

  it('declares the fixed routes before the :id ones', () => {
    const order = Object.getOwnPropertyNames(CredentialsController.prototype);
    expect(order.indexOf('listServices')).toBeLessThan(order.indexOf('findById'));
  });
});
