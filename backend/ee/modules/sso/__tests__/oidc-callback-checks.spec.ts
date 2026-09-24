import { UnauthorizedException } from '@nestjs/common';

import { SsoService } from '../sso.service';
import { SamlReplayCache } from '../saml-replay-cache';
import { FakeRedis } from '../../../../src/test/fake-redis';

/**
 * Two checks the OIDC callback owes before it believes an identity.
 *
 *  - `state`: the login route sets it in a cookie and the callback must
 *    see the same value come back. With no cookie the service passed no
 *    expectation at all, and openid-client then accepts a response that
 *    simply carries no `state` -- so an attacker's own authorization code,
 *    planted in a victim's browser without a state parameter, signed the
 *    victim in as the attacker (login CSRF).
 *  - `email_verified`: members are matched by email. An IdP that lets
 *    users set an address they have not proven (self-service sign-up,
 *    editable profile email) says so with `email_verified: false`, and
 *    believing the address anyway lets a user of that IdP sign in as
 *    whichever member owns it.
 */
describe('OIDC callback checks', () => {
  const ORG = 'org-1';
  const config = {
    enabled: true,
    protocol: 'oidc',
    oidcIssuerUrl: 'https://idp.test',
    oidcClientId: 'c',
    oidcClientSecretPlain: 's',
    oidcRedirectUri: 'https://api.test/sso/org-1/oidc/callback',
  };

  function makeService(claims: Record<string, unknown>) {
    const callback = jest.fn(async () => ({ claims: () => claims }));
    const service = new SsoService(
      {} as any,
      {} as any,
      { getDecrypted: jest.fn(async () => config) } as any,
      new SamlReplayCache(new FakeRedis()),
    );
    jest.spyOn(service, 'buildOidcClient').mockResolvedValue({ callback } as any);
    return { service, callback };
  }

  it('refuses a callback when there is no state to compare against', async () => {
    const { service, callback } = makeService({ sub: 'x', email: 'a@b.test', email_verified: true });
    await expect(service.resolveOidcClaims(ORG, { code: 'attacker-code' }, undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('passes the expected state through when there is one', async () => {
    const { service, callback } = makeService({ sub: 'x', email: 'a@b.test', email_verified: true });
    await service.resolveOidcClaims(ORG, { code: 'c', state: 's1' }, 's1');
    expect(callback).toHaveBeenCalledWith(expect.anything(), expect.anything(), { state: 's1' });
  });

  it('refuses an email the IdP says is unverified', async () => {
    const { service } = makeService({ sub: 'x', email: 'ceo@corp.test', email_verified: false });
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state: 's' }, 's')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('also refuses the string form some IdPs send', async () => {
    const { service } = makeService({ sub: 'x', email: 'ceo@corp.test', email_verified: 'false' });
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state: 's' }, 's')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a verified email, and one from an IdP that does not send the claim', async () => {
    for (const claims of [
      { sub: 'x', email: 'a@b.test', email_verified: true },
      { sub: 'x', email: 'a@b.test' },
    ]) {
      const { service } = makeService(claims);
      await expect(service.resolveOidcClaims(ORG, { code: 'c', state: 's' }, 's')).resolves.toMatchObject({
        email: 'a@b.test',
      });
    }
  });
});
