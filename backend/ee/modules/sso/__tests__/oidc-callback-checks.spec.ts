import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';

import { SsoService } from '../sso.service';
import { SamlReplayCache } from '../saml-replay-cache';
import { FakeRedis } from '../../../../src/test/fake-redis';

/**
 * The checks the OIDC callback owes before it believes an identity.
 *
 *  - `state`: the login route sets it in a cookie and the callback must
 *    see the same value come back. With no cookie the service passed no
 *    expectation at all, and openid-client then accepts a response that
 *    simply carries no `state` -- so an attacker's own authorization code,
 *    planted in a victim's browser without a state parameter, signed the
 *    victim in as the attacker (login CSRF).
 *  - PKCE (S256): the code is redeemable only with the verifier this
 *    server generated for that sign-in and kept, so a code intercepted on
 *    its way back is worthless on its own.
 *  - `nonce`: the ID token must echo the one this sign-in sent, so an ID
 *    token minted for another sign-in cannot be replayed into this one.
 *    The verifier and nonce live server-side under the state, one use.
 *  - `email_verified`: members are matched by email. An IdP that lets
 *    users set an address they have not proven (self-service sign-up,
 *    editable profile email) says so with `email_verified: false`, and
 *    believing the address anyway lets a user of that IdP sign in as
 *    whichever member owns it.
 *
 * The IdP double below behaves like one: it remembers the challenge and
 * nonce of each authorization request and, at the token step, refuses a
 * verifier that does not hash to the challenge and stamps the ID token
 * with that request's nonce.
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

  function makeService(claims: Record<string, unknown>, opts: { nonce?: (sent: string) => unknown } = {}) {
    const authorizations = new Map<string, Record<string, string>>();
    const callback = jest.fn(async (_redirect: string, params: Record<string, any>, checks: any) => {
      const auth = authorizations.get(params.state);
      if (!auth) throw new Error('invalid_grant: unknown code');
      const challenge = createHash('sha256').update(checks.codeVerifier).digest('base64url');
      if (challenge !== auth.code_challenge) throw new Error('invalid_grant: PKCE verification failed');
      const nonce = opts.nonce ? opts.nonce(auth.nonce) : auth.nonce;
      return { claims: () => ({ ...claims, ...(nonce === undefined ? {} : { nonce }) }) };
    });
    const client = {
      authorizationUrl: jest.fn((params: Record<string, string>) => {
        authorizations.set(params.state, params);
        return `https://idp.test/authorize?state=${params.state}`;
      }),
      callback,
    };
    const service = new SsoService(
      {} as any,
      {} as any,
      { getDecrypted: jest.fn(async () => config) } as any,
      new SamlReplayCache(new FakeRedis()),
    );
    jest.spyOn(service, 'buildOidcClient').mockResolvedValue(client as any);
    return { service, callback, client, authorizations };
  }

  const verified = { sub: 'x', email: 'a@b.test', email_verified: true };

  it('refuses a callback when there is no state to compare against', async () => {
    const { service, callback } = makeService(verified);
    await expect(service.resolveOidcClaims(ORG, { code: 'attacker-code' }, undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('sends an S256 PKCE challenge and a nonce with every authorization request', async () => {
    const { service, authorizations } = makeService(verified);
    const { state } = await service.getOidcLoginUrl(ORG);
    const sent = authorizations.get(state)!;
    expect(sent.code_challenge_method).toBe('S256');
    expect(sent.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent.nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const other = authorizations.get((await service.getOidcLoginUrl(ORG)).state)!;
    expect(other.code_challenge).not.toBe(sent.code_challenge);
    expect(other.nonce).not.toBe(sent.nonce);
  });

  it('redeems the code with the verifier and nonce kept for that state', async () => {
    const { service, callback, authorizations } = makeService(verified);
    const { state } = await service.getOidcLoginUrl(ORG);

    await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).resolves.toMatchObject({
      email: 'a@b.test',
    });
    const checks = callback.mock.calls[0][2];
    expect(checks.state).toBe(state);
    expect(checks.nonce).toBe(authorizations.get(state)!.nonce);
    // The verifier is what the challenge was computed from.
    expect(createHash('sha256').update(checks.codeVerifier).digest('base64url')).toBe(
      authorizations.get(state)!.code_challenge,
    );
  });

  it('refuses a state this server never issued', async () => {
    const { service, callback } = makeService(verified);
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state: 'forged' }, 'forged')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('takes a state once: a replayed callback is refused', async () => {
    const { service, callback } = makeService(verified);
    const { state } = await service.getOidcLoginUrl(ORG);
    await service.resolveOidcClaims(ORG, { code: 'c', state }, state);

    await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('refuses a state issued for another organization', async () => {
    const { service, callback } = makeService(verified);
    const { state } = await service.getOidcLoginUrl('org-2');
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('refuses a state issued for another redirect', async () => {
    const { service, callback } = makeService(verified);
    const { state } = await service.getOidcLoginUrl(ORG, { redirectUri: 'https://a.chat.test/cb' });
    await expect(
      service.resolveOidcClaims(ORG, { code: 'c', state }, state, 'https://b.chat.test/cb'),
    ).rejects.toThrow(UnauthorizedException);
    expect(callback).not.toHaveBeenCalled();
  });

  it('refuses an ID token whose nonce is not the one this sign-in sent', async () => {
    const { service } = makeService(verified, { nonce: () => 'someone-elses-nonce' });
    const { state } = await service.getOidcLoginUrl(ORG);
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an ID token that carries no nonce', async () => {
    const { service } = makeService(verified, { nonce: () => undefined });
    const { state } = await service.getOidcLoginUrl(ORG);
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an email the IdP says is unverified', async () => {
    const { service } = makeService({ sub: 'x', email: 'ceo@corp.test', email_verified: false });
    const { state } = await service.getOidcLoginUrl(ORG);
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('also refuses the string form some IdPs send', async () => {
    const { service } = makeService({ sub: 'x', email: 'ceo@corp.test', email_verified: 'false' });
    const { state } = await service.getOidcLoginUrl(ORG);
    await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a verified email, and one from an IdP that does not send the claim', async () => {
    for (const claims of [verified, { sub: 'x', email: 'a@b.test' }]) {
      const { service } = makeService(claims);
      const { state } = await service.getOidcLoginUrl(ORG);
      await expect(service.resolveOidcClaims(ORG, { code: 'c', state }, state)).resolves.toMatchObject({
        email: 'a@b.test',
      });
    }
  });
});
