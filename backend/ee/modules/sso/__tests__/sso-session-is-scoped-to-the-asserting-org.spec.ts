import { ForbiddenException } from '@nestjs/common';

import { SsoController } from '../sso.controller';
import { AuthService } from '../../../../src/modules/auth/auth.service';
import { AuthController } from '../../../../src/modules/auth/auth.controller';
import { UsersController } from '../../../../src/modules/users/users.controller';
import { JwtStrategy } from '../../../../src/modules/auth/strategies/jwt.strategy';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';

/**
 * An organization's IdP vouches for people in that organization, and for
 * nothing else.
 *
 * Each org configures its own SAML certificate / OIDC client, so the org's
 * owner can sign any assertion they like for any of the org's members.
 * `resolveUser` already refuses identities that are not members. But a
 * member of org A may also belong to org B, and the session SSO issued was
 * the ordinary one: every organization the person belongs to, and a
 * profile route that repoints the login email with no password asked. So
 * the owner of A could sign an assertion for a member, open org B as
 * them, or move their email to a mailbox the owner reads and reset the
 * password: a takeover of the whole account.
 *
 * An SSO-issued session therefore names the organization that asserted it
 * and reaches only that organization, and cannot change the account's
 * login address.
 */
describe('an SSO session is scoped to the organization whose IdP asserted it', () => {
  const ORG_A = 'org-a';
  const ORG_B = 'org-b';
  const member = (organizationId: string) => ({
    organizationId,
    role: OrganizationRole.OWNER,
    isActive: true,
    inviteAccepted: true,
    inviteToken: null,
    organization: { id: organizationId, name: organizationId },
  });
  const user = {
    id: 'u-1',
    email: 'person@b.test',
    firstName: 'P',
    lastName: 'Q',
    isActive: true,
    tokenVersion: 0,
    organizationMemberships: [member(ORG_A), member(ORG_B)],
  };

  it('the SSO callback mints a session naming the asserting organization', async () => {
    const auth = { generateTokens: jest.fn(async () => ({ accessToken: 't' })) };
    const sso = { handleSamlCallback: jest.fn(async () => user) };
    const controller = new SsoController(sso as any, auth as any, {} as any);
    const res: any = { cookie: jest.fn(), redirect: jest.fn() };
    const req: any = { headers: {}, get: () => 'api.test', protocol: 'https' };

    await controller.samlCallback(ORG_A, 'resp', req, res);

    expect(auth.generateTokens).toHaveBeenCalledWith(user, { ssoOrganizationId: ORG_A });
  });

  it('the OIDC callback does the same', async () => {
    const auth = { generateTokens: jest.fn(async () => ({ accessToken: 't' })) };
    const sso = { handleOidcCallback: jest.fn(async () => user) };
    const controller = new SsoController(sso as any, auth as any, {} as any);
    const res: any = { cookie: jest.fn(), redirect: jest.fn(), clearCookie: jest.fn() };
    const req: any = { cookies: { sso_oidc_state: 's' } };

    await controller.oidcCallback(ORG_A, { code: 'c', state: 's' }, req, res);

    expect(auth.generateTokens).toHaveBeenCalledWith(user, { ssoOrganizationId: ORG_A });
  });

  it('the token carries only that organization and the claim that scopes it', async () => {
    const sign = jest.fn(() => 'tok');
    const self = {
      userRepository: { findOne: jest.fn(async () => user) },
      jwtService: { sign },
    };
    await (AuthService.prototype.generateTokens as any).call(self, user, { ssoOrganizationId: ORG_A });

    const payload: any = (sign.mock.calls[0] as any[])[0];
    expect(payload.sso).toBe(ORG_A);
    expect(payload.organizations.map((o: any) => o.id)).toEqual([ORG_A]);
  });

  function strategy() {
    const repo = { findOne: jest.fn(async () => ({ ...user, organizationMemberships: [member(ORG_A), member(ORG_B)] })) };
    return new JwtStrategy({ get: () => 'secret' } as any, repo as any);
  }

  it('refuses to open another organization on an SSO session', async () => {
    const req: any = { headers: { 'x-organization-id': ORG_B } };
    await expect(
      strategy().validate(req, { sub: user.id, sso: ORG_A, tv: 0 } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('resolves the asserting organization without a header, and lists only it', async () => {
    const validated: any = await strategy().validate({ headers: {} } as any, { sub: user.id, sso: ORG_A, tv: 0 } as any);
    expect(validated.currentOrganizationId).toBe(ORG_A);
    expect(validated.organizations.map((o: any) => o.id)).toEqual([ORG_A]);
    expect(validated.organizationMemberships.map((m: any) => m.organizationId)).toEqual([ORG_A]);
  });

  it('a password session is unchanged', async () => {
    const req: any = { headers: { 'x-organization-id': ORG_B } };
    const validated: any = await strategy().validate(req, { sub: user.id, tv: 0 } as any);
    expect(validated.currentOrganizationId).toBe(ORG_B);
  });

  it('an SSO session cannot change the login email through /auth/profile', async () => {
    const authService = { updateProfile: jest.fn(async () => user) };
    const controller = new AuthController(authService as any);
    await expect(
      controller.updateProfile({ ...user, ssoOrganizationId: ORG_A } as any, { email: 'attacker@evil.test' } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(authService.updateProfile).not.toHaveBeenCalled();
  });

  it('an SSO session cannot change the login email through /users/me', async () => {
    const usersService = { update: jest.fn(async () => user) };
    const authService = { changeEmail: jest.fn(async () => user) };
    const controller = new UsersController(usersService as any, authService as any);
    await expect(
      controller.updateCurrentUser({ ...user, ssoOrganizationId: ORG_A } as any, { email: 'attacker@evil.test' } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(usersService.update).not.toHaveBeenCalled();
    expect(authService.changeEmail).not.toHaveBeenCalled();
  });

  it('an SSO session cannot change the login email through /users/:id on itself', async () => {
    const usersService = { updateInOrg: jest.fn(async () => user) };
    const authService = { changeEmail: jest.fn(async () => user) };
    const controller = new UsersController(usersService as any, authService as any);
    const req: any = { user: { ...user, ssoOrganizationId: ORG_A, currentOrganizationId: ORG_A } };
    await expect(
      controller.update(user.id, { email: 'attacker@evil.test' } as any, req),
    ).rejects.toThrow(ForbiddenException);
    expect(usersService.updateInOrg).not.toHaveBeenCalled();
    expect(authService.changeEmail).not.toHaveBeenCalled();
  });

  it('an SSO session can still edit its name', async () => {
    const authService = { updateProfile: jest.fn(async () => user) };
    const controller = new AuthController(authService as any);
    await controller.updateProfile({ ...user, ssoOrganizationId: ORG_A } as any, { name: 'New Name' } as any);
    expect(authService.updateProfile).toHaveBeenCalled();
  });
});
