import { readFileSync } from 'fs';
import { join } from 'path';

import { isEffectiveMembership } from '../membership';

const SRC = join(__dirname, '..', '..', '..');

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Whether somebody is a member of an organization is one question.
 *
 * `user_organizations` holds rows that are not memberships: a pending
 * invite (`inviteAccepted: false`, token set) and a revoked one
 * (`isActive: false`, kept rather than deleted). Both stay in
 * `user.organizationMemberships`, because the relation load has no filter.
 *
 * `AccessPolicyService.getOrgRole` and `ApiKeyStrategy` read `isActive`.
 * `JwtStrategy` and `RolesGuard` did not — they matched on
 * `organizationId` alone — so an org could invite somebody, revoke the
 * invite, and that person could still send `X-Organization-Id: <that org>`
 * on their own session and be handed the role written on the revoked row.
 *
 * This is a SOURCE-READING guard rather than only a behavioural one,
 * because the defect was a predicate that existed in one layer and was
 * simply not applied in another: a behavioural test of the fixed code
 * passes, and says nothing about the next `.find(m => m.organizationId
 * === x)` somebody writes.
 */
describe('membership is resolved through one predicate', () => {
  /**
   * The files that turn a membership row into access. Each is listed with
   * what it decides, so a future reader can tell whether a new entry
   * belongs here.
   */
  const AUTHORIZATION_SITES = [
    ['modules/auth/strategies/jwt.strategy.ts', 'which org a session may act as'],
    ['modules/auth/strategies/api-key.strategy.ts', 'which org an API key may act as'],
    ['modules/auth/guards/roles.guard.ts', 'the role a route requires'],
    ['entities/user.entity.ts', 'hasPermissionInOrganization'],
    ['modules/connections/connections.permissions.ts', 'the connections RBAC vocabulary'],
    ['modules/gateways/gateway-auth-validators.helper.ts', 'gateway basic/jwt auth'],
  ] as const;

  it.each(AUTHORIZATION_SITES)(
    '%s (%s) resolves membership through common/authorization/membership',
    (file) => {
      const source = stripComments(readFileSync(join(SRC, file), 'utf8'));
      expect(source).toMatch(/authorization\/membership'/);
    },
  );

  it.each(AUTHORIZATION_SITES)(
    '%s (%s) never matches organizationMemberships on the org id alone',
    (file) => {
      const source = stripComments(readFileSync(join(SRC, file), 'utf8'));
      // `.find(...)` / `.some(...)` / `.filter(...)` directly on the
      // memberships array is the shape that skipped the predicate.
      const raw = source.match(
        /organizationMemberships\s*\??\.\s*(find|some|filter)\s*\(/g,
      );
      expect(raw ?? []).toEqual([]);
    },
  );

  it('lists sites that exist, so this guard cannot pass by reading nothing', () => {
    for (const [file] of AUTHORIZATION_SITES) {
      expect(readFileSync(join(SRC, file), 'utf8').length).toBeGreaterThan(0);
    }
    expect(AUTHORIZATION_SITES.length).toBeGreaterThanOrEqual(6);
  });
});

describe('isEffectiveMembership', () => {
  it('accepts an accepted, active membership', () => {
    expect(
      isEffectiveMembership({ organizationId: 'org-1', isActive: true, inviteAccepted: true }),
    ).toBe(true);
  });

  it('accepts a row created directly, with no invite fields', () => {
    // Org creation, registration and SCIM/SSO provisioning write rows with
    // no token; `isActive` defaults to true in the column.
    expect(isEffectiveMembership({ organizationId: 'org-1' })).toBe(true);
  });

  it('refuses a revoked invite — the row survives revocation', () => {
    expect(
      isEffectiveMembership({
        organizationId: 'org-1',
        isActive: false,
        inviteAccepted: false,
        inviteToken: null,
      }),
    ).toBe(false);
  });

  it('refuses a pending invite until it is accepted', () => {
    expect(
      isEffectiveMembership({
        organizationId: 'org-1',
        isActive: true,
        inviteAccepted: false,
        inviteToken: 'tok',
      }),
    ).toBe(false);
  });

  it('refuses a deactivated membership even when the invite was accepted', () => {
    expect(
      isEffectiveMembership({ organizationId: 'org-1', isActive: false, inviteAccepted: true }),
    ).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(isEffectiveMembership(null)).toBe(false);
    expect(isEffectiveMembership(undefined)).toBe(false);
  });
});
