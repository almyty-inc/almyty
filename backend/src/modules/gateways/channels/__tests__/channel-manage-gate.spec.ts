import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { ChannelEventsController } from '../channel-events.controller';
import { ChannelInstallationsController } from '../channel-installations.controller';

/**
 * Probing a channel gateway's stored credentials (test-connection) and
 * revoking one of its workspace installations change or spend the gateway,
 * so both take the per-gateway manage gate (GatewaysService.findManageable,
 * the read-before-manage rule): 404 when the caller cannot read the
 * gateway, 403 when they can read it but not manage it. They used to load
 * the gateway with the read check only, so any caller who could read it
 * got through; the org-role decorator was the only other gate.
 */
describe('channel test-connection and installation revoke take the manage gate', () => {
  const ORG = 'org-1';
  const gateway = { id: 'gw-1', organizationId: ORG, visibility: 'team', teamId: 'team-1' };
  const req = { user: { id: 'user-1', currentOrganizationId: ORG } };

  const harness = (refusal: Error | null) => {
    const gatewaysService = {
      // The caller can read the gateway...
      getGateway: jest.fn().mockResolvedValue(gateway),
      // ...and the manage gate decides.
      findManageable: jest.fn(async () => {
        if (refusal) throw refusal;
        return gateway;
      }),
    };
    const channels = { testConnection: jest.fn().mockResolvedValue({ ok: true }) };
    const installations = { revoke: jest.fn().mockResolvedValue({ id: 'inst-1', status: 'revoked' }) };
    return {
      gatewaysService,
      channels,
      installations,
      events: new ChannelEventsController(gatewaysService as any, channels as any),
      installs: new ChannelInstallationsController(gatewaysService as any, installations as any),
    };
  };

  it.each([
    ['cannot manage it (403)', new ForbiddenException('manage requires team lead')],
    ['cannot read it (404)', new NotFoundException('Gateway not found')],
  ])('a caller who %s is refused and nothing is probed or revoked', async (_label, refusal) => {
    const h = harness(refusal);
    await expect(h.events.testConnection(req, gateway.id)).rejects.toBe(refusal);
    await expect(h.installs.revokeInstallation(req, gateway.id, 'inst-1')).rejects.toBe(refusal);
    expect(h.gatewaysService.findManageable).toHaveBeenCalledWith(gateway.id, ORG, 'user-1');
    expect(h.channels.testConnection).not.toHaveBeenCalled();
    expect(h.installations.revoke).not.toHaveBeenCalled();
  });

  it('a caller who may manage the gateway probes and revokes', async () => {
    const h = harness(null);
    await expect(h.events.testConnection(req, gateway.id)).resolves.toEqual({ success: true, data: { ok: true } });
    await expect(h.installs.revokeInstallation(req, gateway.id, 'inst-1')).resolves.toMatchObject({ success: true });
    expect(h.channels.testConnection).toHaveBeenCalledWith(gateway);
    expect(h.installations.revoke).toHaveBeenCalledWith(gateway.id, 'inst-1');
  });
});
