/**
 * What counts as a membership when an authorization decision is made.
 *
 * `user_organizations` holds more than current members. A row is created
 * when somebody is INVITED (`inviteAccepted: false`, `inviteToken` set),
 * and revoking that invite marks the row `isActive: false` rather than
 * deleting it (`organizations-invites.helper.ts`). Both kinds of row stay
 * in `user.organizationMemberships`, because the relation load has no
 * filter.
 *
 * The data layer already knows this: `AccessPolicyService.getOrgRole`,
 * every listing in `OrganizationsService`, and `ApiKeyStrategy` all read
 * `isActive`, and `NotificationsService` additionally treats an unaccepted
 * invite as a non-member. `JwtStrategy` and `RolesGuard` did not — they
 * matched on `organizationId` alone. So an org could invite somebody,
 * revoke the invite, and that person could still send
 * `X-Organization-Id: <that org>` on their own session: JwtStrategy
 * accepted the header (a row existed), RolesGuard granted the role named
 * on the revoked row, and every route that trusts
 * `currentOrganizationId` — the audit log among them — answered for a
 * tenant they had no access to. An un-accepted invite worked the same way,
 * which made the accept step and its seven-day expiry decorative.
 *
 * One predicate, used everywhere a membership is turned into access, so
 * the two layers cannot drift apart again.
 *
 * Absent fields mean "not an invite": a row created directly (org
 * creation, registration, SCIM/SSO provisioning) carries no token, and
 * `isActive` defaults to true in the column, so `undefined` is treated as
 * active rather than as a denial.
 */
export interface MembershipRecord {
  organizationId?: string | null;
  organization?: { id?: string | null } | null;
  isActive?: boolean | null;
  inviteAccepted?: boolean | null;
  inviteToken?: string | null;
}

/** The organization a membership row points at, whichever field carries it. */
export function membershipOrgId(membership: MembershipRecord): string | undefined {
  return (membership?.organizationId ?? membership?.organization?.id) ?? undefined;
}

/**
 * Does this row grant access right now?
 *
 * Deactivated (a revoked invite) never does. An invite still holding its
 * token does not either, until it is accepted — acceptance is what the
 * `POST /invites/:token/accept` route exists to record.
 */
export function isEffectiveMembership(membership: MembershipRecord | null | undefined): boolean {
  if (!membership) return false;
  if (membership.isActive === false) return false;
  if (membership.inviteAccepted === true) return true;
  return !membership.inviteToken;
}

/** The rows that grant access, in order. */
export function effectiveMemberships<T extends MembershipRecord>(
  memberships: T[] | null | undefined,
): T[] {
  return (memberships ?? []).filter(isEffectiveMembership);
}

/** The row granting access to one organization, or undefined. */
export function findEffectiveMembership<T extends MembershipRecord>(
  memberships: T[] | null | undefined,
  organizationId: string | null | undefined,
): T | undefined {
  if (!organizationId) return undefined;
  return (memberships ?? []).find(
    (membership) =>
      membershipOrgId(membership) === organizationId && isEffectiveMembership(membership),
  );
}

/** Is the caller a member of this organization right now? */
export function hasEffectiveMembership(
  memberships: MembershipRecord[] | null | undefined,
  organizationId: string | null | undefined,
): boolean {
  return findEffectiveMembership(memberships, organizationId) !== undefined;
}
