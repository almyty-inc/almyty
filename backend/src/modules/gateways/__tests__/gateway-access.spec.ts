import { normalizeGatewayAccess, endpointVisibility, endpointTeamId } from '../gateway-access';
describe('gateway endpoint access separate from management', () => {
 it('requires a team for team access', () => { expect(() => normalizeGatewayAccess('team', null)).toThrow(); });
 it('clears team for external scope', () => { expect(normalizeGatewayAccess('external_protected', 'team')).toEqual({ accessScope: 'external_protected', accessTeamId: null }); });
 it('does not publish private resources from private management scope', () => { expect(endpointVisibility({ visibility: 'private', accessScope: 'external_open' })).toBe('org'); });
 it('maps endpoint team independently', () => { const row = { visibility: 'org', teamId: 'management-team', accessScope: 'team', accessTeamId: 'endpoint-team' } as const; expect(endpointVisibility(row)).toBe('team'); expect(endpointTeamId(row)).toBe('endpoint-team'); });
 it('keeps messaging channel scope independent', () => { const row = { type: 'slack', visibility: 'team', teamId: 'channel-team', accessScope: 'org' } as const; expect(endpointVisibility(row)).toBe('team'); expect(endpointTeamId(row)).toBe('channel-team'); });
});
