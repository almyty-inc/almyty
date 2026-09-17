import { stripMemberSecrets, USER_SECRET_FIELDS } from '../../../organizations/organizations.service';
import { stripUserSecrets } from '../../../users/users.service';
import { maskAuthSecrets } from '../../../gateways/gateway-auth.service';

/**
 * Secrets that must never leave the server, and tenants that must never
 * see each other.
 *
 * Every one of these was a live hole found by auditing rather than by a
 * test, and each is the same root cause: an entity handed to a client as
 * stored. @Exclude() on the entity does nothing here, because this
 * application registers no ClassSerializerInterceptor — so the decorator
 * has never masked a single field, and relying on it is how these got
 * written in the first place.
 */
describe('credentials do not leave the server', () => {
  it('strips every member credential from an organization payload', () => {
    const org: any = {
      id: 'org-1',
      members: [
        {
          inviteToken: 'invite-secret',
          user: {
            id: 'u1',
            email: 'owner@example.com',
            passwordHash: '$2b$10$REAL-BCRYPT',
            resetPasswordToken: 'reset-me',
            resetPasswordExpires: new Date(),
            verificationToken: 'verify-me',
          },
        },
      ],
      settings: { pendingInvites: [{ email: 'x@example.com', inviteToken: 'pending-secret' }] },
    };

    const safe: any = stripMemberSecrets(org);
    const wire = JSON.stringify(safe);

    // A live reset token is an account takeover of whoever it belongs to,
    // and this route is open to any member of the organization.
    expect(wire).not.toContain('$2b$10$REAL-BCRYPT');
    expect(wire).not.toContain('reset-me');
    expect(wire).not.toContain('verify-me');
    expect(wire).not.toContain('invite-secret');
    expect(wire).not.toContain('pending-secret');
    // What the page actually needs is still there.
    expect(safe.members[0].user.email).toBe('owner@example.com');
  });

  it('names every field it strips, so a new secret column is a deliberate decision', () => {
    expect(USER_SECRET_FIELDS).toEqual(
      expect.arrayContaining(['passwordHash', 'resetPasswordToken', 'verificationToken']),
    );
  });

  it('strips the same fields from a user list row, including membership invite tokens', () => {
    const row: any = {
      id: 'u1',
      email: 'a@example.com',
      passwordHash: 'hash',
      resetPasswordToken: 'reset',
      organizationMemberships: [{ organizationId: 'other-org', inviteToken: 'invite' }],
    };

    const wire = JSON.stringify(stripUserSecrets(row));
    expect(wire).not.toContain('hash');
    expect(wire).not.toContain('reset');
    expect(wire).not.toContain('invite');
  });

  it('masks a gateway JWT signing secret, which mints tokens for anyone holding it', () => {
    const masked = maskAuthSecrets({ secret: 'hmac-signing-key', issuer: 'almyty', audience: 'x' });

    expect(masked.secret).not.toBe('hmac-signing-key');
    // The non-secret configuration is untouched, or the screen loses its meaning.
    expect(masked.issuer).toBe('almyty');
    expect(masked.audience).toBe('x');
  });

  it('leaves a config with no secret alone rather than inventing dots', () => {
    expect(maskAuthSecrets({ issuer: 'almyty' })).toEqual({ issuer: 'almyty' });
    expect(maskAuthSecrets(null)).toBeNull();
  });
});
