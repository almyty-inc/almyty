import { AgentApiAccessService } from '../../agents/agent-api-access.service';
import { compatPrincipal } from '../../agents/compat-auth.helper';
const id = '11111111-1111-4111-8111-111111111111';
describe('agent API target authentication', () => {
 it('routes configured model UUIDs through their own target and uses publication scope', async () => {
  const agent = { id, organizationId: 'org', apiGatewayId: 'target', visibility: 'org' };
  const target = { id: 'target', organizationId: 'org', agentId: id, accessScope: 'external_open', visibility: 'private', type: 'a2a', metadata: { agentApiTarget: true }, authConfigs: [] };
  const authenticate = jest.fn(async () => ({ isValid: true }));
  const service = new AgentApiAccessService({ findOne: async () => agent } as any, { findOne: async () => target } as any, {} as any, { authenticateRequest: authenticate } as any);
  const key = await service.authenticateTarget('agent:' + id, { headers: {} });
  expect(key.agentId).toBe(id);
  expect(compatPrincipal(key)).toMatchObject({ kind: 'gateway', gatewayId: 'target', visibility: 'org' });
  expect(authenticate).toHaveBeenCalledWith('target', {}, {}, undefined, undefined, [], expect.anything());
 });
 it('does not fall back to legacy keys when target refuses credentials', async () => {
  const service = new AgentApiAccessService({ findOne: async () => ({ id, organizationId: 'org', apiGatewayId: 'target' }) } as any, { findOne: async () => ({ id: 'target', authConfigs: [] }) } as any, {} as any, { authenticateRequest: async () => ({ isValid: false }) } as any);
  await expect(service.authenticateTarget(id, { headers: { authorization: 'Bearer old-key' } })).rejects.toThrow('Authentication required');
 });
 it('leaves unconfigured legacy agents on the existing path', async () => {
  const service = new AgentApiAccessService({ findOne: async () => ({ id, apiGatewayId: null }) } as any, {} as any, {} as any, {} as any);
  expect(await service.authenticateTarget(id, {})).toBeNull();
 });
});
