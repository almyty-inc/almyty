import { canManage, canUse, ConnectionLike, GrantLike, GrantPrincipal } from '../grant-check';

/**
 * A private ("just me") connection is its owner's alone. A grant is a
 * share, and connections:manage is the admin's reach into org-scoped
 * secrets; neither opens a connection its owner marked private.
 */
const privateConnection: ConnectionLike = {
  id: 'c-private', organizationId: 'org-1', ownerUserId: 'u-owner', visibility: 'private', teamId: null,
};
const who = (overrides: Partial<GrantPrincipal> = {}): GrantPrincipal =>
  ({ userId: 'u-member', roles: ['member'], teamIds: [], ...overrides });
const grantTo = (principalId: string, permission: GrantLike['permission'] = 'use'): GrantLike =>
  ({ id: `g-${principalId}`, principalType: 'user', principalId, permission, expiresAt: null });

describe('grant-check: private connections', () => {
  it('the owner uses and manages it', () => {
    expect(canUse(privateConnection, who({ userId: 'u-owner' }), [])).toMatchObject({ allowed: true, via: 'owner' });
    expect(canManage(privateConnection, who({ userId: 'u-owner' }), [])).toMatchObject({ allowed: true, via: 'owner' });
  });

  it('another member cannot, even holding a use or manage grant', () => {
    const grants = [grantTo('u-member', 'use'), grantTo('u-member', 'manage')];
    expect(canUse(privateConnection, who(), grants)).toMatchObject({ allowed: false });
    expect(canManage(privateConnection, who(), grants)).toMatchObject({ allowed: false });
  });

  it('an org admin or owner cannot, connections:manage notwithstanding', () => {
    for (const role of ['admin', 'owner']) {
      expect(canUse(privateConnection, who({ userId: `org-${role}`, roles: [role] }), [])).toMatchObject({ allowed: false });
      expect(canManage(privateConnection, who({ userId: `org-${role}`, roles: [role] }), [])).toMatchObject({ allowed: false });
    }
  });
});
