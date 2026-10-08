import { GatewayAuthManagementGuard } from '../gateway-auth-management.guard';
describe('agent API authentication management', () => {
 const context = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', params: { gatewayId: 'target' }, user }) }) }) as any;
 const user = { id: 'owner', currentOrganizationId: 'org', organizationMemberships: [{ organizationId: 'org', role: 'member', isActive: true }] };
 function guard(target = true, agent: any = { createdBy: 'owner', visibility: 'private' }) {
  return new GatewayAuthManagementGuard({ findOne: async () => ({ id: 'target', agentId: 'agent', metadata: { agentApiTarget: target } }), manager: { getRepository: () => ({ findOne: async () => agent }) } } as any, { canAccess: async (caller: any, row: any) => ({ allowed: row.createdBy === caller.id }) } as any);
 }
 it('allows a member to manage their private agent target', async () => { expect(await guard().canActivate(context(user))).toBe(true); });
 it('refuses another member even if the target metadata is present', async () => { await expect(guard().canActivate(context({ ...user, id: 'other' }))).rejects.toThrow('not found'); });
 it('refuses forged target metadata without the bound agent', async () => { await expect(guard(true, null).canActivate(context(user))).rejects.toThrow('not found'); });
 it('keeps ordinary gateway mutation restricted to administrators', async () => { await expect(guard(false).canActivate(context(user))).rejects.toThrow('admins'); });
});
