import { ForbiddenException } from '@nestjs/common';

/**
 * A session minted from an organization's SSO assertion.
 *
 * Each organization configures its own IdP, so its owner can sign an
 * assertion for any of its members. That makes the IdP an authority on
 * the person's access to THAT organization and nothing else: the same
 * person may belong to other organizations, and their account's login
 * address is theirs. So an SSO session carries the asserting organization
 * in its token (`sso`), JwtStrategy narrows the person's memberships to
 * it, and the routes that change the login address refuse it -- that
 * change plus a password reset at the new mailbox is the whole account.
 */

/** The organization an SSO session is confined to, if this is one. */
export function ssoSessionOrganization(user: unknown): string | undefined {
  const value = (user as { ssoOrganizationId?: unknown } | null | undefined)?.ssoOrganizationId;
  return typeof value === 'string' && value ? value : undefined;
}

/** Refuse a login-address change on an SSO session. */
export function assertMayChangeLoginEmail(
  user: { email?: string | null } | null | undefined,
  newEmail: string | null | undefined,
): void {
  if (!newEmail || newEmail === user?.email) return;
  if (ssoSessionOrganization(user)) {
    throw new ForbiddenException({
      code: 'SSO_SESSION_CANNOT_CHANGE_EMAIL',
      message: 'Sign in with your password to change your email address.',
    });
  }
}
